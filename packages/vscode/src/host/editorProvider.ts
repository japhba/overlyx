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
import { projectDirFor } from './project.ts';

export interface ProviderDeps {
  bridgeBase(): string;
  layoutDir(): string;
  /** register a project root; returns its project name */
  registerRoot(root: string): string;
  startBuild(e: OpenEditor): void;
  cancelBuild(docId: string): void;
  openPdfPanel(docId: string): void;
  postToPdf(docId: string, msg: unknown): void;
  openDoc(root: string, rel: string, opts?: { goto?: string; heading?: number }): void;
}

const isDark = () => [vscode.ColorThemeKind.Dark, vscode.ColorThemeKind.HighContrast].includes(vscode.window.activeColorTheme.kind);

export class OverlyxEditorProvider implements vscode.CustomTextEditorProvider {
  constructor(private context: vscode.ExtensionContext, private registry: Registry, private deps: ProviderDeps) {}

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    // the project is the directory that holds the file, not the whole workspace (a child
    // document adopts its master's directory so it keeps the master's class and preamble)
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    const root = projectDirFor(document.uri.fsPath, folder?.uri.fsPath);
    const project = this.deps.registerRoot(root);
    const relPath = path.relative(root, document.uri.fsPath);
    let ctx: TexContext;
    try {
      ctx = { root, layoutDir: this.deps.layoutDir() };
    } catch (e) {
      panel.webview.html = `<!doctype html><body style="font-family:sans-serif;padding:2em">${String(e)}</body>`;
      return;
    }
    const session = new DocSession(document, ctx, project, relPath);
    const entry: OpenEditor = { session, panel, outline: [], selectionPos: 0 };
    this.registry.add(entry);

    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')] };
    panel.webview.html = webviewHtml(panel.webview, this.context.extensionUri, 'editor', {
      page: 'editor', docId: session.docId, base: this.deps.bridgeBase(), dark: isDark(),
    });

    const post = (msg: HostToEditor) => void panel.webview.postMessage(msg);
    /** webview updates are applied one at a time (applyEdit is async) */
    let applyChain: Promise<void> = Promise.resolve();

    const subs: vscode.Disposable[] = [];
    subs.push(panel.webview.onDidReceiveMessage((msg: EditorToHost) => {
      switch (msg.type) {
        case 'ready': {
          try {
            const r = session.parseCurrent();
            post({ type: 'init', docId: session.docId, base: this.deps.bridgeBase(), pmDoc: r.pmDoc as never, headerLines: r.headerLines, fragment: r.fragment, dark: isDark() });
            if (r.warnings.length) vscode.window.setStatusBarMessage(`OverLyX: ${r.warnings.length} parse warning(s) — details in the raw file`, 8000);
          } catch (e) {
            void vscode.window.showErrorMessage(`OverLyX could not open ${relPath}: ${String(e)}`);
          }
          break;
        }
        case 'update':
          applyChain = applyChain.then(() => session.applyPmUpdate(msg.pmDoc as never, msg.headerLines)).catch(e => console.error('overlyx apply failed', e));
          break;
        case 'outline':
          entry.outline = msg.items;
          this.registry.touch();
          break;
        case 'selection':
          entry.selectionPos = msg.pos;
          break;
        case 'notify':
          if (msg.kind === 'error') void vscode.window.showErrorMessage('OverLyX: ' + msg.text);
          else vscode.window.setStatusBarMessage('OverLyX: ' + msg.text, 5000);
          break;
        case 'save':
          applyChain = applyChain.then(async () => { if (document.isDirty) await document.save(); }).catch(e => console.error('overlyx save failed', e));
          break;
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
    subs.push(vscode.workspace.onDidChangeTextDocument(ev => {
      if (ev.document !== document || ev.contentChanges.length === 0) return;
      clearTimeout(externalTimer);
      externalTimer = setTimeout(() => {
        try {
          const ext = session.externalChange();
          if (ext) post({ type: 'externalUpdate', pmDoc: ext.pmDoc as never, headerLines: ext.headerLines });
          this.registry.touch();
        } catch (e) { console.error('overlyx external change failed', e); }
      }, 400);
    }));

    subs.push(panel.onDidChangeViewState(() => { if (panel.active) this.registry.setActive(entry); }));
    subs.push(vscode.window.onDidChangeActiveColorTheme(() => post({ type: 'theme', dark: isDark() })));

    panel.onDidDispose(() => {
      clearTimeout(externalTimer);
      for (const s of subs) s.dispose();
      session.dispose();
      this.registry.remove(entry);
    });
  }
}
