/**
 * The OverLyX custom editor for .tex and markdown files and HTML articles: a webview running the
 * OverLyX editor, backed by the ordinary TextDocument (VS Code owns file, dirty state, save and git;
 * the webview owns the WYSIWYG view and in-editor undo).
 */
import * as vscode from 'vscode';
import { watchAppearance, sendAppearance, changeAppearance } from './appearance.ts';
import path from 'node:path';
import { DocSession } from './session.ts';
import { Registry, type OpenEditor } from './registry.ts';
import { webviewHtml } from './webviewHtml.ts';
import type { EditorToHost, HostToEditor } from '../shared/protocol.ts';
import type { TexContext } from './texdoc.ts';
import { projectDirFor } from './project.ts';
import type { TextStore } from '../agents/localEdit.ts';
import type { InteractionAction, InteractionOutcome } from '@overlyx/core/interactions.ts';
import { WindowUnreachable, type HandOver } from '../agents/handover.ts';
import { isHtmlPath } from '@overlyx/core/html/deliverable.ts';
import { authorName } from './newDocument.ts';
import { webPlaceOf, onWebPlaces } from './sync.ts';

export interface ProviderDeps {
  track?(action: InteractionAction, outcome: InteractionOutcome, durationMs?: number): void;
  bridgeBase(): Promise<string>;
  canvasBase?(): Promise<string>;
  layoutDir(): string;
  /** register a project root; returns its project name */
  registerRoot(root: string): string;
  startBuild(e: OpenEditor, opts?: { open?: boolean }): void;
  reportError(error: unknown, area: string): void;
  cancelBuild(docId: string): void;
  openPdfPanel(docId: string): void;
  postToPdf(docId: string, msg: unknown): void;
  openDoc(root: string, rel: string, opts?: { goto?: string; heading?: number; beside?: boolean }): void;
}

/**
 * The article's editor that is active, if one is: an article opens through overlyx.htmlEditor, and
 * the context key gives it the document editor's keys (package.json keybindings).
 */
let articlePanel: vscode.WebviewPanel | undefined;
function setArticlePanel(panel: vscode.WebviewPanel | undefined): void {
  if (panel === articlePanel) return;
  articlePanel = panel;
  void vscode.commands.executeCommand('setContext', 'overlyx.articleActive', !!panel);
}

const isDark = () => [vscode.ColorThemeKind.Dark, vscode.ColorThemeKind.HighContrast].includes(vscode.window.activeColorTheme.kind);

export class OverlyxEditorProvider implements vscode.CustomTextEditorProvider {
  private pendingNavigation = new Map<string, Extract<HostToEditor, { type: 'navigate' }>>();
  navigateTo(id: string, target: Extract<HostToEditor, { type: 'navigate' }>): void {
    const editor = this.registry.byDocId(id);
    if (editor) void editor.panel.webview.postMessage(target);
    else this.pendingNavigation.set(id, target);
  }
  private applyChain: Promise<void> = Promise.resolve();
  constructor(private context: vscode.ExtensionContext, private registry: Registry, private deps: ProviderDeps) {}

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel, token: vscode.CancellationToken): Promise<void> {
    const openedAt = performance.now();
    this.deps.track?.('extension-open', 'attempt');
    const base = await this.deps.bridgeBase();
    if (token.isCancellationRequested) return;
    // the project is the directory that holds the file, not the whole workspace (a child
    // document adopts its master's directory so it keeps the master's class and preamble)
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    const root = projectDirFor(document.uri.fsPath, folder?.uri.fsPath);
    const project = this.deps.registerRoot(root);
    const relPath = path.relative(root, document.uri.fsPath);
    // an HTML article (deliverables.ts hands those over): its output is its page, not a PDF
    const article = isHtmlPath(relPath);
    let ctx: TexContext;
    try {
      const readRoot = folder?.uri.scheme === 'file' && (root + path.sep).startsWith(folder.uri.fsPath + path.sep) ? folder.uri.fsPath : undefined;
      ctx = { root, layoutDir: this.deps.layoutDir(), readText: abs => vscode.workspace.textDocuments.find(d => !d.isClosed && d.uri.fsPath === abs)?.getText(), readRoot };
    } catch (e) {
      panel.webview.html = `<!doctype html><body style="font-family:sans-serif;padding:2em">${String(e)}</body>`;
      return;
    }
    const session = new DocSession(document, ctx, project, relPath, path.join(this.context.globalStorageUri.fsPath, 'recovery'));
    const entry: OpenEditor = { session, panel, outline: [], selectionPos: 0 };
    this.registry.add(entry);

    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')] };

    const post = (msg: HostToEditor) => void panel.webview.postMessage(msg);
    const subs: vscode.Disposable[] = [];
    // where the project's directory is on overlyx.app, when its folder is synced with a project there (sync.ts): links
    const sendWeb = () => {
      const w = webPlaceOf(document.uri.fsPath), rel = relPath.split(path.sep).join('/');
      post({ type: 'webLink', web: w && w.path.endsWith(rel) ? { origin: w.origin, project: w.project, dir: w.path.slice(0, w.path.length - rel.length).replace(/\/$/, ''), local: project } : null });
    };
    subs.push(onWebPlaces(sendWeb));
    const related = this.registry.relatedSessions(entry);
    const relatedTimers = new Map<string, NodeJS.Timeout>();
    const relatedPath = (id: string) => {
      if (!id.startsWith(project + '/')) throw new Error('Related document belongs to another project');
      const rel = id.slice(project.length + 1);
      const abs = path.resolve(root, rel);
      if (!abs.startsWith(root + path.sep) || !abs.endsWith('.tex')) throw new Error('Related document must be a .tex file inside this project');
      return { abs, rel };
    };
    const pushSnapshot = (target: DocSession) => {
      const parsed = target.parseCurrent();
      if (target === session) post({ type: 'externalUpdate', pmDoc: parsed.pmDoc as never, headerLines: parsed.headerLines, ack: target.applied });
      else post({ type: 'relatedExternalUpdate', id: target.docId, pmDoc: parsed.pmDoc as never, headerLines: parsed.headerLines, ack: target.applied });
      post({ type: 'metadataChanged' });
      this.registry.touch();
    };
    /**
     * VS Code reverts editors, not documents: make `target`'s editor the active one for a moment
     * (this panel, or a text editor for a document of the combined view) and revert it to the
     * file — only once it is verifiably the active one: a revert of another editor would discard
     * that editor's unsaved changes.
     */
    const resync = async (target: DocSession): Promise<boolean> => {
      const isActive = () => (target === session ? panel.active : vscode.window.activeTextEditor?.document === target.document);
      if (target === session) panel.reveal(panel.viewColumn, false);
      else await vscode.window.showTextDocument(target.document, { preview: true, preserveFocus: false });
      for (let i = 0; i < 20 && !isActive(); i++) await new Promise(r => setTimeout(r, 50));
      if (!isActive()) return false;
      await vscode.commands.executeCommand('workbench.action.files.revert');
      if (target !== session) { await vscode.commands.executeCommand('workbench.action.closeActiveEditor'); panel.reveal(panel.viewColumn, false); }
      return !target.document.isDirty;
    };
    entry.resync = resync;
    entry.agentEdit = <T>(absPath: string, run: (store: TextStore) => Promise<T>, handOver: HandOver): Promise<T> | undefined => {
      const target = [session, ...related.values()].find(s => s.document.uri.fsPath === absPath);
      if (!target) return undefined;
      const abandoned = () => { if (handOver.signal.aborted) throw new WindowUnreachable('abandoned'); };
      // in turn with the webview's updates: the edit applies to the text as the user has it, unsaved typing included
      const job = this.applyChain.then(async () => {
        abandoned();
        if (await target.syncFromDisk()) pushSnapshot(target);
        abandoned();
        const before = target.document.getText();
        const result = await run({ read: () => target.document.getText(), write: text => { handOver.begin(); return target.writeAgentText(text); } });
        if (target.document.getText() !== before) {
          pushSnapshot(target);
          // on disk at once: the agent reads, builds and edits on from the file
          await target.save(resync);
        }
        return result;
      });
      this.applyChain = job.then(() => undefined, () => undefined);
      return job;
    };
    let updateErrorShown = 0;
    /** The webview's Ctrl+S: every document of the view, merged with what changed on disk; failures are shown, with a retry. */
    const save = () => {
      const started = performance.now();
      this.deps.track?.('extension-save', 'attempt');
      this.applyChain = this.applyChain.then(async () => {
        for (const target of [session, ...related.values()]) {
          if (await target.syncFromDisk()) pushSnapshot(target);
          const how = await target.save(resync).catch((e: unknown) => { throw Object.assign(new Error(String((e as Error)?.message ?? e)), { target }); });
          const name = path.basename(target.relPath);
          if (how === 'merged') vscode.window.setStatusBarMessage(`OverLyX: saved ${name} — merged with the change made to the file outside VS Code`, 8000);
          else if (how === 'merged-dirty') void vscode.window.showWarningMessage(`OverLyX saved ${name} (merged with the change made to it outside VS Code), but VS Code still marks it as modified. If VS Code asks about a conflict when you save it again, choose Overwrite: the file already holds this text.`);
        }
        this.deps.track?.('extension-save', 'success', performance.now() - started);
      }).catch((e: Error & { target?: DocSession }) => {
        this.deps.track?.('extension-save', 'failed', performance.now() - started);
        console.error('overlyx save failed', e);
        const name = e.target ? path.basename(e.target.relPath) : relPath;
        void vscode.window.showErrorMessage(`OverLyX could not save ${name}: ${e.message}. Your changes are still in the editor.`, 'Retry', 'Open as Text').then(a => {
          if (a === 'Retry') save();
          else if (a === 'Open as Text') void vscode.commands.executeCommand('vscode.openWith', (e.target ?? session).document.uri, 'default');
        });
      });
    };
    let metadataTimer: NodeJS.Timeout | undefined;
    const metadataChanged = () => { clearTimeout(metadataTimer); metadataTimer = setTimeout(() => post({ type: 'metadataChanged' }), 300); };
    // (an article's stylesheets set its look in the editor: meta's article.vars)
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, article ? '**/*.{tex,bib,sty,cls,lyx,html,htm,css}' : '**/*.{tex,bib,sty,cls,lyx}'));
    const diskChanged = (uri: vscode.Uri) => {
      if (path.relative(root, uri.fsPath).split(path.sep).some(part => part === '_build' || part === '.git')) return;
      this.applyChain = this.applyChain.then(async () => {
        for (const target of [session, ...related.values()]) {
          if (target.document.uri.fsPath === uri.fsPath && await target.syncFromDisk()) pushSnapshot(target);
        }
        metadataChanged();
      }).catch(e => void vscode.window.showErrorMessage(`OverLyX could not refresh ${uri.fsPath}: ${String(e)}`));
    };
    subs.push(watcher, watcher.onDidChange(diskChanged), watcher.onDidCreate(diskChanged), watcher.onDidDelete(metadataChanged));
    subs.push(panel.webview.onDidReceiveMessage((msg: EditorToHost) => {
      switch (msg.type) {
        case 'hostCommand': {
          if (msg.name === 'openSource') {
            const abs = msg.id === session.docId ? document.uri.fsPath : relatedPath(msg.id).abs;
            this.applyChain = this.applyChain.then(async () => {
              const target = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
              await vscode.window.showTextDocument(target, { viewColumn: vscode.ViewColumn.Beside, preview: false });
            }).catch(e => void vscode.window.showErrorMessage(String(e)));
          } else {
            const commands = { openFile: 'workbench.action.files.openFile', newFile: 'workbench.action.files.newUntitledFile', closeTab: 'workbench.action.closeActiveEditor', outline: 'overlyx.structure.focus', back: 'workbench.action.navigateBack', forward: 'workbench.action.navigateForward', theme: 'workbench.action.selectTheme', timeline: 'timeline.focus', scm: 'workbench.view.scm' };
            void vscode.commands.executeCommand(commands[msg.name]);
          }
          break;
        }
        case 'appearance':
          changeAppearance(panel.webview, msg.appearance);
          break;
        case 'loadRelated':
          this.applyChain = this.applyChain.then(async () => {
            const { abs, rel } = relatedPath(msg.id);
            if (!related.has(msg.id)) related.set(msg.id, new DocSession(await vscode.workspace.openTextDocument(vscode.Uri.file(abs)), ctx, project, rel, path.join(this.context.globalStorageUri.fsPath, 'recovery')));
            const child = related.get(msg.id)!;
            await child.syncFromDisk();
            const parsed = child.parseCurrent();
            post({ type: 'relatedInit', id: msg.id, pmDoc: parsed.pmDoc as never, headerLines: parsed.headerLines, meta: child.meta() as never, ack: child.applied });
          }).catch(e => post({ type: 'relatedError', id: msg.id, error: String(e) }));
          break;
        case 'updateRelated':
          this.applyChain = this.applyChain.then(async () => {
            const child = related.get(msg.id)!;
            if (await child.applyPmUpdate(msg.pmDoc as never, msg.headerLines, msg.base, msg.sync)) pushSnapshot(child);
          }).catch(e => {
            post({ type: 'relatedError', id: msg.id, error: String(e) });
            void vscode.window.showErrorMessage(`OverLyX could not update ${msg.id}: ${String(e)}`);
          });
          break;
        case 'ready': {
          sendAppearance(panel.webview);   // before init: the shell starts with the theme switch's choices
          const named = authorName(path.dirname(document.uri.fsPath));
          this.applyChain = this.applyChain.then(async () => {
            const author = await named;
            await session.syncFromDisk();
            const r = session.parseCurrent();
            post({ type: 'init', docId: session.docId, base, pmDoc: r.pmDoc as never, headerLines: r.headerLines, fragment: r.fragment, dark: isDark(), ack: session.applied, author });
            sendWeb();
            if (r.warnings.length) vscode.window.setStatusBarMessage(`OverLyX: ${r.warnings.length} parse warning(s) — details in the raw file`, 8000);
          }).catch(e => {
            void vscode.window.showErrorMessage(`OverLyX could not open ${relPath}: ${String(e)}`);
          });
          break;
        }
        case 'update':
          this.applyChain = this.applyChain.then(async () => {
            if (await session.applyPmUpdate(msg.pmDoc as never, msg.headerLines, msg.base, msg.sync)) pushSnapshot(session);
            this.deps.track?.('extension-edit', 'success');
          }).catch(e => {
            this.deps.track?.('extension-edit', 'failed');
            console.error('overlyx apply failed', e);
            // the editor keeps the text and sends the whole document with the next change; say so once, not per keystroke
            if (Date.now() - updateErrorShown > 30000) { updateErrorShown = Date.now(); void vscode.window.showErrorMessage(`OverLyX could not write your last edit into ${relPath}: ${String(e)}. The editor keeps it — it is written with your next change or save.`, 'Save now').then(a => { if (a) save(); }); }
          });
          break;
        case 'outline':
          entry.outline = msg.items;
          if (this.pendingNavigation.has(session.docId)) {
            post(this.pendingNavigation.get(session.docId)!);
            this.pendingNavigation.delete(session.docId);
          }
          this.registry.touch();
          break;
        case 'selection':
          entry.selectionPos = msg.pos;
          break;
        case 'notify':
          if (msg.kind === 'error') this.deps.reportError(Object.assign(new Error(msg.text), msg.stack ? { stack: msg.stack } : {}), 'webview.editor');
          if (msg.kind === 'error') void vscode.window.showErrorMessage('OverLyX: ' + msg.text);
          else vscode.window.setStatusBarMessage('OverLyX: ' + msg.text, 5000);
          break;
        case 'save': save(); break;
        case 'build':
          if (article) break;   // (an article's output is its page: the Page pane)
          this.applyChain = this.applyChain.then(() => this.deps.startBuild(entry, { open: msg.open })).catch(e => console.error('overlyx build failed', e));
          break;
        case 'cancelBuild': this.deps.cancelBuild(session.docId); break;
        case 'openPdfPanel': this.deps.openPdfPanel(session.docId); break;
        case 'syncTarget': this.deps.postToPdf(session.docId, { type: 'syncTarget', target: msg.target }); break;
        case 'openDoc': {
          const rel = msg.id.startsWith(project + '/') ? msg.id.slice(project.length + 1) : msg.id;
          this.deps.openDoc(root, rel, { goto: msg.goto, heading: msg.heading, beside: msg.beside });
          break;
        }
      }
    }));


    // external changes of the TextDocument (git checkout, another editor, VS Code-level undo):
    // re-parse and push as a diff; debounced — typing in a split source view fires per keystroke
    let externalTimer: NodeJS.Timeout | undefined;
    subs.push(vscode.workspace.onDidChangeTextDocument(ev => {
      if (ev.document.uri.fsPath.startsWith(root + path.sep) && ev.contentChanges.length) metadataChanged();
      for (const [id, child] of related) {
        if (ev.document !== child.document || ev.contentChanges.length === 0) continue;
        clearTimeout(relatedTimers.get(id));
        relatedTimers.set(id, setTimeout(() => {
          this.applyChain = this.applyChain.then(() => {
            const ext = child.externalChange();
            if (ext) post({ type: 'relatedExternalUpdate', id, pmDoc: ext.pmDoc as never, headerLines: ext.headerLines, ack: child.applied });
          }).catch(e => console.error('overlyx child refresh failed', e));
        }, 400));
      }
      if (ev.document !== document || ev.contentChanges.length === 0) return;
      clearTimeout(externalTimer);
      externalTimer = setTimeout(() => {
        this.applyChain = this.applyChain.then(() => {
          const ext = session.externalChange();
          if (ext) post({ type: 'externalUpdate', pmDoc: ext.pmDoc as never, headerLines: ext.headerLines, ack: session.applied });
          this.registry.touch();
        }).catch(e => console.error('overlyx external change failed', e));
      }, 400);
    }));

    // Reconcile after returning to the editor even if a filesystem notification was missed
    // (for example, a file on NFS edited on another machine or while SSH was disconnected).
    // A snapshot only when the file did change: the editor takes each as a save (an article's
    // Page pane loads again, the metadata is fetched anew) — every focus of the window redrew it.
    const refreshDocuments = () => {
      this.applyChain = this.applyChain.then(async () => {
        for (const target of [session, ...related.values()]) {
          if (await target.syncFromDisk()) pushSnapshot(target);
        }
        metadataChanged();
      }).catch(e => void vscode.window.showErrorMessage(`OverLyX could not refresh open documents: ${String(e)}`));
    };
    subs.push(panel.onDidChangeViewState(() => {
      if (panel.active) { this.registry.setActive(entry); refreshDocuments(); }
      if (panel.active) setArticlePanel(article ? panel : undefined);
      else if (articlePanel === panel) setArticlePanel(undefined);
    }));
    if (panel.active) setArticlePanel(article ? panel : undefined);
    subs.push(vscode.window.onDidChangeWindowState(state => { if (state.focused && panel.visible) refreshDocuments(); }));
    subs.push(vscode.window.onDidChangeActiveColorTheme(() => post({ type: 'theme', dark: isDark() })), watchAppearance(panel.webview));

    panel.onDidDispose(() => {
      this.deps.track?.('extension-close', 'success');
      if (articlePanel === panel) setArticlePanel(undefined);
      for (const timer of relatedTimers.values()) clearTimeout(timer);
      clearTimeout(externalTimer);
      clearTimeout(metadataTimer);
      for (const s of subs) s.dispose();
      session.dispose();
      this.registry.remove(entry);
    });
    const canvasBase = await this.deps.canvasBase?.();
    panel.webview.html = await webviewHtml(panel.webview, this.context.extensionUri, 'editor', {
      page: 'editor', docId: session.docId, base, dark: isDark(), canvasBase,
      ...(canvasBase ? { frameOrigin: new URL(canvasBase).origin } : {}),
    });
    this.deps.track?.('extension-open', 'success', performance.now() - openedAt);
  }
}
