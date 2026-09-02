/**
 * OverLyX for VS Code: the OverLyX WYSIWYG editor as a custom editor for .tex files, a Structure
 * tree in the sidebar, and a PDF panel with SyncTeX. The extension host plays the OverLyX
 * server's role in-process (@overlyx/core parses and writes the files); a local HTTP bridge
 * serves the API subset the editor UI calls.
 */
import * as vscode from 'vscode';
import fs from 'node:fs';
import path from 'node:path';
import { texHeadings, lyxToPm } from '@overlyx/core';
import { Bridge, type BridgeDelegate } from './host/bridge.ts';
import { Registry, type OpenEditor } from './host/registry.ts';
import { OverlyxEditorProvider } from './host/editorProvider.ts';
import { OutlineTree } from './host/outlineTree.ts';
import { PdfPanels } from './host/pdfPanel.ts';
import { resolveLayoutDir } from './host/lyxlib.ts';
import { Updater, type CheckResult } from './host/updater.ts';
import { registerTexSymbols } from './host/symbols.ts';
import { collectFiles, readTextFile } from './host/project.ts';
import { cachedParseFile, parseFragmentText, masterHeaderFor, type TexContext } from './host/texdoc.ts';
import { buildMeta, bibEntriesFor } from './host/meta.ts';
import * as build from './host/build.ts';
import type { HostToEditor } from './shared/protocol.ts';

/** What activate() returns — consumed by the integration test (test/suite/index.cjs). */
export interface OverlyxTestApi { registry: Registry; bridgeBase(): string; checkForUpdates(opts?: { interactive: boolean; apiOverride?: string; dryRun?: boolean }): Promise<CheckResult> }

export function activate(context: vscode.ExtensionContext): OverlyxTestApi {
  const registry = new Registry();
  /** project name → root directory (each open file's own directory — projectDirFor —, plus the workspace folders) */
  const projectRoots = new Map<string, string>();
  const registerRoot = (root: string): string => {
    for (const [name, r] of projectRoots) if (r === root) return name;
    let name = path.basename(root) || 'project';
    let i = 2;
    while (projectRoots.has(name)) name = `${path.basename(root)}-${i++}`;
    projectRoots.set(name, root);
    return name;
  };
  for (const f of vscode.workspace.workspaceFolders ?? []) registerRoot(f.uri.fsPath);

  let layoutDirCache: string | null = null;
  const layoutDir = (): string => {
    if (!layoutDirCache) {
      layoutDirCache = resolveLayoutDir(vscode.workspace.getConfiguration('overlyx').get<string>('layoutDir'), context.extensionPath);
    }
    return layoutDirCache;
  };

  const locate = (docId: string): { ctx: TexContext; root: string; relPath: string; session?: import('./host/session.ts').DocSession } => {
    const open = registry.byDocId(docId);
    if (open) return { ctx: open.session.ctx, root: open.session.ctx.root, relPath: open.session.relPath, session: open.session };
    const slash = docId.indexOf('/');
    const project = docId.slice(0, slash), relPath = docId.slice(slash + 1);
    const root = projectRoots.get(project);
    if (!root) throw new Error(`unknown project ${project}`);
    return { ctx: { root, layoutDir: layoutDir() }, root, relPath };
  };

  const startBuild = (e: OpenEditor): void => {
    const { session } = e;
    const target = session.buildTarget();
    const latexmk = vscode.workspace.getConfiguration('overlyx').get<string>('latexmk') || 'latexmk';
    build.requestBuild({
      docId: session.docId, absPath: target.absPath, header: target.header, latexmk,
      prepare: async () => {
        // the .tex file on disk is what latexmk compiles: write the editor's state first
        if (session.document.isDirty) await session.document.save();
        await vscode.workspace.saveAll(false);
      },
    });
    pdfPanels.show(session.docId);
  };

  const onInverse = (docId: string, page: number, x: number, y: number): void => {
    void build.synctexEdit(docId, page, x, y).then(r => {
      const e = registry.byDocId(docId);
      if (!e) return;
      if (!r?.line) { vscode.window.setStatusBarMessage('SyncTeX: nothing is known about this place in the PDF', 5000); return; }
      void e.panel.webview.postMessage({ type: 'inverseSync', line: r.line } satisfies HostToEditor);
      e.panel.reveal(undefined, false);
    });
  };

  const bridge = new Bridge(makeDelegate());
  const pdfPanels = new PdfPanels(context.extensionUri, () => bridge.base, onInverse);

  function makeDelegate(): BridgeDelegate {
    const DICT_PKG: Record<string, string> = { en: 'dictionary-en', 'en-gb': 'dictionary-en-gb', de: 'dictionary-de', fr: 'dictionary-fr' };
    return {
      projectRoot: (project) => projectRoots.get(project),
      projects: () => [...projectRoots.entries()].map(([name, root]) => ({ name, files: collectFiles(root) })),
      meta: async (docId) => {
        const l = locate(docId);
        if (l.session) return l.session.meta();
        const r = cachedParseFile(l.ctx, l.relPath);
        return buildMeta({ ctx: l.ctx, project: docId.slice(0, docId.indexOf('/')), relPath: l.relPath, lyx: r.doc, isChild: r.fragment, fileText: readTextFile(path.join(l.root, l.relPath)) });
      },
      texText: async (docId) => {
        const l = locate(docId);
        return l.session ? l.session.toText() : readTextFile(path.join(l.root, l.relPath));
      },
      clip: async (docId, latex) => {
        const l = locate(docId);
        const header = l.session ? l.session.getHeaderLines() : cachedParseFile(l.ctx, l.relPath).doc.header.lines;
        const masterHeader = header.length ? header : masterHeaderFor(l.ctx, l.relPath) ?? [];
        const r = parseFragmentText(latex, l.ctx, l.relPath, masterHeader);
        return { blocks: (lyxToPm(r.doc) as { content?: unknown[] }).content ?? [], warnings: r.warnings };
      },
      headerGet: async (docId) => {
        const l = locate(docId);
        return { headerLines: l.session ? l.session.getHeaderLines() : cachedParseFile(l.ctx, l.relPath).doc.header.lines };
      },
      headerSet: async (docId, body) => {
        const l = locate(docId);
        if (!l.session) throw new Error('document is not open in an OverLyX editor');
        return { ok: true, headerLines: await l.session.setHeader(body) };
      },
      outline: (docId) => {
        const l = locate(docId);
        const abs = path.join(l.root, l.relPath);
        const text = l.session ? l.session.document.getText() : readTextFile(abs);
        const depth = /\\setcounter\{secnumdepth\}\{(-?\d+)\}/.exec(text);
        return { headings: texHeadings(text, depth ? Number(depth[1]) : 3) as unknown[], mtime: fs.existsSync(abs) ? fs.statSync(abs).mtimeMs : 0 };
      },
      bibSearch: async (docId, q, keys, limit) => {
        const l = locate(docId);
        const lyx = l.session ? l.session.toLyxDocument() : cachedParseFile(l.ctx, l.relPath).doc;
        const entries = bibEntriesFor({ ctx: l.ctx, relPath: l.relPath, lyx });
        if (keys.length) return { entries: entries.filter(e => keys.includes(e.key)), total: entries.length };
        const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
        const hits = terms.length
          ? entries.filter(e => terms.every(t => e.key.toLowerCase().includes(t) || (e.fields?.author ?? '').toLowerCase().includes(t) || e.authorShort.toLowerCase().includes(t) || e.year.includes(t) || e.title.toLowerCase().includes(t)))
          : entries;
        return { entries: hits.slice(0, limit), total: entries.length, matches: hits.length };
      },
      exportDoc: async (docId, format) => {
        const l = locate(docId);
        if (format === 'tex') return { ok: true, tex: l.session ? l.session.toText() : readTextFile(path.join(l.root, l.relPath)), warnings: [] };
        const e = registry.byDocId(docId);
        if (e) { startBuild(e); return { ok: true, job: build.publicJob(build.currentJob(docId)!) }; }
        const latexmk = vscode.workspace.getConfiguration('overlyx').get<string>('latexmk') || 'latexmk';
        const job = build.requestBuild({ docId, absPath: path.join(l.root, l.relPath), header: cachedParseFile(l.ctx, l.relPath).doc.header, latexmk });
        return { ok: true, job: build.publicJob(job) };
      },
      buildStatus: (docId, withTex) => {
        const b = build.lastBuild(docId);
        const job = build.currentJob(docId);
        const tex = withTex && b?.tex_path && fs.existsSync(b.tex_path) ? fs.readFileSync(b.tex_path, 'utf8') : undefined;
        return {
          build: b ? { ...b, pdf: b.pdf_path && fs.existsSync(b.pdf_path) ? `${bridge.base}/api/docs/${encodeURIComponent(docId)}/pdf?t=${b.updated_at}` : null, tex } : null,
          job: job ? build.publicJob(job) : null,
        };
      },
      cancelBuild: (docId) => build.cancelBuild(docId),
      pdfPath: (docId) => build.lastBuild(docId)?.pdf_path ?? null,
      synctexView: (docId, line, column) => build.synctexView(docId, line, column),
      synctexEdit: (docId, page, x, y) => build.synctexEdit(docId, page, x, y),
      cacheDir: () => path.join(context.globalStorageUri.fsPath, 'graphics'),
      dictionary: (lang, ext) => {
        const bundled = path.join(context.extensionPath, 'dist/dict', `${lang}.${ext}`);
        if (fs.existsSync(bundled)) return bundled;
        const pkg = DICT_PKG[lang];
        if (!pkg) return null;
        const dev = path.join(context.extensionPath, '../../node_modules', pkg, 'index.' + ext);
        return fs.existsSync(dev) ? dev : null;
      },
    };
  }

  const openDoc = (root: string, rel: string, _opts?: { goto?: string; heading?: number }): void => {
    const abs = path.resolve(root, rel);
    if (!fs.existsSync(abs)) { void vscode.window.showErrorMessage(`OverLyX: ${rel} does not exist`); return; }
    void vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(abs), abs.endsWith('.tex') ? 'overlyx.texEditor' : 'default');
  };

  const provider = new OverlyxEditorProvider(context, registry, {
    bridgeBase: () => bridge.base,
    layoutDir,
    registerRoot,
    startBuild,
    cancelBuild: (docId) => build.cancelBuild(docId),
    openPdfPanel: (docId) => void pdfPanels.show(docId),
    postToPdf: (docId, msg) => pdfPanels.post(docId, msg as never),
    openDoc,
  });

  const outlineTree = new OutlineTree(registry);
  const updater = new Updater(context);
  // the built-in Outline pane cannot show a webview editor's outline: surface the Structure view
  // in the Explorer whenever an OverLyX editor is open (the context key drives its "when")
  registry.onDidChange(() => void vscode.commands.executeCommand('setContext', 'overlyx.active', registry.all().length > 0));
  void vscode.commands.executeCommand('setContext', 'overlyx.active', false);

  context.subscriptions.push(
    { dispose: () => bridge.dispose() },
    vscode.window.registerCustomEditorProvider('overlyx.texEditor', provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
    vscode.window.createTreeView('overlyx.structure', { treeDataProvider: outlineTree, showCollapseAll: true }),
    vscode.window.createTreeView('overlyx.structureExplorer', { treeDataProvider: outlineTree, showCollapseAll: true }),
    registerTexSymbols(),
    vscode.window.onDidChangeActiveColorTheme(t => pdfPanels.postTheme([vscode.ColorThemeKind.Dark, vscode.ColorThemeKind.HighContrast].includes(t.kind))),
    vscode.commands.registerCommand('overlyx.openInOverlyx', (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (target) void vscode.commands.executeCommand('vscode.openWith', target, 'overlyx.texEditor');
    }),
    vscode.commands.registerCommand('overlyx.openAsText', () => {
      const doc = registry.active?.session.document;
      if (doc) void vscode.commands.executeCommand('vscode.openWith', doc.uri, 'default');
    }),
    vscode.commands.registerCommand('overlyx.buildPdf', () => {
      const e = registry.active;
      if (e) startBuild(e);
      else void vscode.window.showInformationMessage('OverLyX: open a .tex document in the OverLyX editor first');
    }),
    vscode.commands.registerCommand('overlyx.syncToPdf', () => {
      const e = registry.active;
      if (e) void e.panel.webview.postMessage({ type: 'command', name: 'syncToPdf' } satisfies HostToEditor);
    }),
    vscode.commands.registerCommand('overlyx.toggleMargin', () => {
      const e = registry.active;
      if (e) void e.panel.webview.postMessage({ type: 'command', name: 'toggleMargin' } satisfies HostToEditor);
    }),
    vscode.commands.registerCommand('overlyx.refreshOutline', () => outlineTree.refresh()),
    vscode.commands.registerCommand('overlyx.checkForUpdates', () => void updater.check({ interactive: true }).catch(e => vscode.window.showErrorMessage('OverLyX update check failed: ' + String(e)))),
    vscode.commands.registerCommand('overlyx.gotoOutline', (pos: number) => {
      const e = registry.active;
      if (e) void e.panel.webview.postMessage({ type: 'goto', pos } satisfies HostToEditor);
    }),
  );

  void bridge.start().catch(e => vscode.window.showErrorMessage('OverLyX: local bridge failed to start: ' + String(e)));

  updater.schedule();

  return { registry, bridgeBase: () => bridge.base, checkForUpdates: (opts) => updater.check(opts ?? { interactive: true }) };
}

export function deactivate(): void { /* subscriptions dispose everything */ }
