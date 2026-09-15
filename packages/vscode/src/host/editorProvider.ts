/**
 * The OverLyX custom editor for .tex files: a webview running the OverLyX editor, backed by the
 * ordinary TextDocument (VS Code owns file, dirty state, save and git; the webview owns the
 * WYSIWYG view and in-editor undo).
 */
import * as vscode from 'vscode';
import path from 'node:path';
import { DocSession } from './session.ts';
import { Registry, type OpenEditor } from './registry.ts';
import { webviewHtml } from './webviewHtml.ts';
import type { EditorToHost, HostToEditor } from '../shared/protocol.ts';
import type { TexContext } from './texdoc.ts';
import { childDocuments, projectDirFor } from './project.ts';

export interface ProviderDeps {
  bridgeBase(): Promise<string>;
  layoutDir(): string;
  /** register a project root; returns its project name */
  registerRoot(root: string): string;
  startBuild(e: OpenEditor): void;
  cancelBuild(docId: string): void;
  openPdfPanel(docId: string): void;
  postToPdf(docId: string, msg: unknown): void;
  openDoc(root: string, rel: string, opts?: { goto?: string; heading?: number }): void;
  reportError(error: unknown, area: string): void;
}

const isDark = () => [vscode.ColorThemeKind.Dark, vscode.ColorThemeKind.HighContrast].includes(vscode.window.activeColorTheme.kind);

export class OverlyxEditorProvider implements vscode.CustomTextEditorProvider {
  constructor(private context: vscode.ExtensionContext, private registry: Registry, private deps: ProviderDeps) {}

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel, token: vscode.CancellationToken): Promise<void> {
    let base: string;
    try { base = await this.deps.bridgeBase(); }
    catch (e) { this.deps.reportError(e, 'editor.bridge'); throw e; }
    if (token.isCancellationRequested) return;
    // the project is the directory that holds the file, not the whole workspace (a child
    // document adopts its master's directory so it keeps the master's class and preamble)
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    const root = projectDirFor(document.uri.fsPath, folder?.uri.fsPath);
    const project = this.deps.registerRoot(root);
    const relPath = path.relative(root, document.uri.fsPath);
    let ctx: TexContext;
    try {
      ctx = { root, layoutDir: this.deps.layoutDir(), readText: abs => vscode.workspace.textDocuments.find(d => d.uri.fsPath === abs)?.getText() };
    } catch (e) {
      this.deps.reportError(e, 'editor.layout');
      panel.webview.html = `<!doctype html><body style="font-family:sans-serif;padding:2em">${String(e)}</body>`;
      return;
    }
    const session = new DocSession(document, ctx, project, relPath);
    const entry: OpenEditor = { session, panel, outline: [], selectionPos: 0 };
    this.registry.add(entry);

    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')] };
    panel.webview.html = webviewHtml(panel.webview, this.context.extensionUri, 'editor', {
      page: 'editor', docId: session.docId, base, dark: isDark(),
    });

    const post = (msg: HostToEditor) => void panel.webview.postMessage(msg);
    const reportWriteError = (error: unknown) => {
      this.deps.reportError(error, 'editor.write');
      void vscode.window.showErrorMessage(`OverLyX: ${String(error)}`);
    };

    // The combined view ("master and child documents in one view"): one session per child
    // document, each backed by its own TextDocument like the master, so VS Code keeps owning the
    // files, dirty state, save and undo. The webview gets a child's content once, when its session
    // opens; its edits come back as childUpdate, changes from elsewhere go out as childExternalUpdate.
    const children = new Map<string, { session: DocSession; externalTimer?: NodeJS.Timeout }>();
    let combined = false;
    let childrenTimer: NodeJS.Timeout | undefined;
    const childId = (rel: string) => `${project}/${rel}`;
    const closeChildren = () => {
      for (const c of children.values()) { clearTimeout(c.externalTimer); c.session.dispose(); }
      children.clear();
    };
    const syncChildren = async () => {
      if (!combined) return;
      const rels = childDocuments(root, relPath);
      const ids = new Set(rels.map(childId));
      for (const [id, c] of children) if (!ids.has(id)) { clearTimeout(c.externalTimer); c.session.dispose(); children.delete(id); }
      const items: Extract<HostToEditor, { type: 'children' }>['items'] = [];
      for (const rel of rels) {
        const id = childId(rel);
        if (children.has(id)) { items.push({ id }); continue; }
        try {
          const childDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, rel)));
          const s = new DocSession(childDoc, ctx, project, rel);
          const r = s.parseCurrent();
          children.set(id, { session: s });
          items.push({ id, pmDoc: r.pmDoc as never, headerLines: r.headerLines });
        } catch (e) {
          this.deps.reportError(e, 'editor.child-open');
          void vscode.window.showErrorMessage(`OverLyX could not open the child document ${rel}: ${String(e)}`);
        }
      }
      if (!combined) return;   // switched off meanwhile
      post({ type: 'children', items });
    };
    const scheduleChildrenSync = () => { clearTimeout(childrenTimer); childrenTimer = setTimeout(() => void syncChildren(), 500); };

    const subs: vscode.Disposable[] = [];
    subs.push(panel.webview.onDidReceiveMessage((msg: EditorToHost) => {
      switch (msg.type) {
        case 'ready': {
          try {
            const r = session.parseCurrent();
            post({ type: 'init', docId: session.docId, base, pmDoc: r.pmDoc as never, headerLines: r.headerLines, fragment: r.fragment, dark: isDark() });
            if (r.warnings.length) vscode.window.setStatusBarMessage(`OverLyX: ${r.warnings.length} parse warning(s) — details in the raw file`, 8000);
          } catch (e) {
            this.deps.reportError(e, 'editor.open');
            void vscode.window.showErrorMessage(`OverLyX could not open ${relPath}: ${String(e)}`);
          }
          break;
        }
        case 'update':
          void session.applyPmUpdate(msg.pmDoc as never, msg.headerLines).catch(reportWriteError);
          break;
        case 'outline':
          entry.outline = msg.items;
          this.registry.touch();
          break;
        case 'selection':
          entry.selectionPos = msg.pos;
          break;
        case 'notify':
          if (msg.kind === 'error') {
            const error = new Error(msg.text);
            if (msg.stack) error.stack = msg.stack;
            this.deps.reportError(error, 'editor.webview');
            void vscode.window.showErrorMessage('OverLyX: ' + msg.text);
          }
          else vscode.window.setStatusBarMessage('OverLyX: ' + msg.text, 5000);
          break;
        case 'save':
          void session.save().catch(reportWriteError);
          for (const c of children.values()) void c.session.save().catch(reportWriteError);
          break;
        case 'combined':
          combined = msg.on;
          if (msg.on) void syncChildren(); else closeChildren();
          break;
        case 'childUpdate': {
          const c = children.get(msg.id);
          if (c) void c.session.applyPmUpdate(msg.pmDoc as never, msg.headerLines).catch(reportWriteError);
          break;
        }
        case 'build': this.deps.startBuild(entry); break;
        case 'cancelBuild': this.deps.cancelBuild(session.docId); break;
        case 'openPdfPanel': this.deps.openPdfPanel(session.docId); break;
        case 'syncTarget': this.deps.postToPdf(session.docId, { type: 'syncTarget', target: msg.target }); break;
        case 'openDoc': {
          const rel = msg.id.startsWith(project + '/') ? msg.id.slice(project.length + 1) : msg.id;
          this.deps.openDoc(root, rel, { goto: msg.goto, heading: msg.heading });
          break;
        }
      }
    }));

    // external changes of the TextDocument (git checkout, another editor, VS Code-level undo):
    // re-parse and push as a diff; debounced — typing in a split source view fires per keystroke
    let externalTimer: NodeJS.Timeout | undefined;
    let metadataTimer: NodeJS.Timeout | undefined;
    const refreshMetadata = () => {
      clearTimeout(metadataTimer);
      metadataTimer = setTimeout(() => post({ type: 'metadataChanged' }), 250);
    };
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/*.{tex,sty,cls,bib,lyx}'));
    subs.push(watcher, watcher.onDidChange(refreshMetadata), watcher.onDidCreate(refreshMetadata), watcher.onDidDelete(refreshMetadata));
    subs.push(vscode.workspace.onDidChangeTextDocument(ev => {
      if (ev.contentChanges.length && ev.document.uri.fsPath.startsWith(root + path.sep)) refreshMetadata();
      if (ev.contentChanges.length === 0) return;
      // a child of the combined view (its own editor, git, the master's source pane …)
      for (const [id, c] of children) {
        if (ev.document !== c.session.document) continue;
        clearTimeout(c.externalTimer);
        c.externalTimer = setTimeout(() => {
          try {
            const ext = c.session.externalChange();
            if (ext) post({ type: 'childExternalUpdate', id, pmDoc: ext.pmDoc as never, headerLines: ext.headerLines });
          } catch (e) { this.deps.reportError(e, 'editor.child-external-change'); }
        }, 400);
        return;
      }
      if (ev.document !== document) return;
      // the master's own text changed (our write or an external one): the include list may differ
      if (combined) scheduleChildrenSync();
      clearTimeout(externalTimer);
      externalTimer = setTimeout(() => {
        try {
          const ext = session.externalChange();
          if (ext) post({ type: 'externalUpdate', pmDoc: ext.pmDoc as never, headerLines: ext.headerLines });
          this.registry.touch();
        } catch (e) {
          this.deps.reportError(e, 'editor.external-change');
          console.error('overlyx external change failed', e);
        }
      }, 400);
    }));

    subs.push(panel.onDidChangeViewState(() => { if (panel.active) this.registry.setActive(entry); }));
    subs.push(vscode.window.onDidChangeActiveColorTheme(() => post({ type: 'theme', dark: isDark() })));

    panel.onDidDispose(() => {
      clearTimeout(externalTimer);
      clearTimeout(metadataTimer);
      clearTimeout(childrenTimer);
      closeChildren();
      for (const s of subs) s.dispose();
      session.dispose();
      this.registry.remove(entry);
    });
  }
}
