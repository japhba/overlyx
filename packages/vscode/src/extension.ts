/**
 * OverLyX for VS Code: the OverLyX WYSIWYG editor as a custom editor for .tex files, a Structure
 * tree in the sidebar, and a PDF panel with SyncTeX. The extension host plays the OverLyX
 * server's role in-process (@overlyx/core parses and writes the files); a local HTTP bridge
 * serves the API subset the editor UI calls.
 */
import * as vscode from 'vscode';
import fs from 'node:fs';
import path from 'node:path';
import { texHeadings, lyxToPm, splitDocId, projectOfDoc, layoutCheck } from '@overlyx/core';
import { Bridge, type BridgeDelegate } from './host/bridge.ts';
import { connectWebviewBridge } from './host/webviewBridge.ts';
import { Registry, type OpenEditor } from './host/registry.ts';
import { DocSession } from './host/session.ts';
import { OverlyxEditorProvider } from './host/editorProvider.ts';
import { OutlineTree } from './host/outlineTree.ts';
import { PdfPanels } from './host/pdfPanel.ts';
import { PdfEditorProvider } from './host/pdfEditor.ts';
import { resolveLayoutDir } from './host/lyxlib.ts';
import { Updater, type CheckResult } from './host/updater.ts';
import { registerTexSymbols } from './host/symbols.ts';
import { collectFiles, readTextFile } from './host/project.ts';
import { cachedParseFile, parseFragmentText, masterHeaderFor, type TexContext } from './host/texdoc.ts';
import { frontMatterEnd, frontMatterVars, setFrontMatter, MD_FONTS, isMarkdownPath } from '@overlyx/core/md/index.ts';
import { withTypesetting, type FMSet } from '@overlyx/core/md/typesetting.ts';
/** the front matter's lines at the top of a markdown text (none: []) */
const frontMatterLines = (text: string) => { const end = frontMatterEnd(text); return end ? text.slice(0, end).replace(/\r?\n$/, '').split(/\r?\n/) : []; };
import { buildMeta, bibEntriesFor } from './host/meta.ts';
import { OverlyxTelemetry } from './host/telemetry.ts';
import { setupAgents } from './host/agents.ts';
import { setupSync } from './host/sync.ts';
import { registerNewDocumentCommands } from './host/newDocument.ts';
import { DeliverableServer, DeliverableEditorProvider, rootFor } from './host/deliverables.ts';
import { runTool, toolTarget, TOOL_NAMES, type ToolName, type TextStore } from './agents/localEdit.ts';
import { inEditor } from './agents/handover.ts';
import { placeSelection, SELECTION_MAX } from './shared/agentSelection.ts';
import * as build from './host/build.ts';
import { initAppearance } from './host/appearance.ts';
import type { InteractionAction } from '@overlyx/core/interactions.ts';
import type { HostToEditor } from './shared/protocol.ts';

/** What activate() returns — consumed by the integration test (test/suite/index.cjs). */
export interface OverlyxTestApi { registry: Registry; bridgeBase(): string; checkForUpdates(opts?: { interactive: boolean; apiOverride?: string; dryRun?: boolean }): Promise<CheckResult> }

export async function activate(context: vscode.ExtensionContext): Promise<OverlyxTestApi> {
  initAppearance(context);
  const telemetry = new OverlyxTelemetry(context);
  context.subscriptions.push(telemetry);
  telemetry.track('extension-activate', 'success');
  const registerCommand = (id: string, run: (...args: any[]) => unknown): vscode.Disposable => {
    const action: InteractionAction = /build/i.test(id) ? 'extension-build' : /open/i.test(id) ? 'extension-open' : /sync/i.test(id) ? 'extension-sync' : /update/i.test(id) ? 'extension-update' : 'extension-command';
    return vscode.commands.registerCommand(id, (...args: unknown[]) => {
      if (id === 'overlyx.editorKey') return run(...args);
      const started = performance.now();
      telemetry.track(action, 'attempt');
      try {
        const result = run(...args);
        if (result && typeof (result as PromiseLike<unknown>).then === 'function') return Promise.resolve(result).then(value => {
          telemetry.track(action, 'success', performance.now() - started); return value;
        }, error => { telemetry.track(action, 'failed', performance.now() - started); throw error; });
        telemetry.track(action, 'success', performance.now() - started); return result;
      } catch (error) { telemetry.track(action, 'failed', performance.now() - started); throw error; }
    });
  };
  const registry = new Registry();
  /**
   * project key → root directory (each open file's own directory — projectDirFor —, plus the
   * workspace folders). Keys have the server's `<owner>/<name>` form (core projectKey.ts), so the
   * shared editor code reads document ids the same way: `local/<folder name>`.
   */
  const projectRoots = new Map<string, string>();
  const registerRoot = (root: string): string => {
    for (const [name, r] of projectRoots) if (r === root) return name;
    const base = path.basename(root) || 'project';
    let name = `local/${base}`;
    let i = 2;
    while (projectRoots.has(name)) name = `local/${base}-${i++}`;
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
    const session = registry.sessionByDocId(docId);
    if (session) return { ctx: session.ctx, root: session.ctx.root, relPath: session.relPath, session };
    const { project, path: relPath } = splitDocId(docId);
    const root = projectRoots.get(project);
    if (!root) throw new Error(`unknown project ${project}`);
    return { ctx: { root, layoutDir: layoutDir() }, root, relPath };
  };

  /** files TeX may read besides the document: \input files, packages and classes, bibliographies, data and pictures as text */
  const TEX_INPUT = /\.(tex|ltx|sty|cls|clo|def|cfg|fd|bib|bst|bbx|cbx|lbx|dbx|tikz|pgf|lua|dat|csv|tsv|txt|svg|eps)$/i;
  /**
   * Before a build: the unsaved changes of what it reads — TeX inputs in the document's folder (the
   * workspace folder: `\input{../notation}`) — are saved. One VS Code will not save (its file changed
   * on disk meanwhile: an agent, the sync, git) no longer stops the build: latexmk reads the file on
   * disk and the build's warnings say so. Other documents are left alone. Every build used to save
   * the whole window and fail when any file could not be saved: one unrelated file in conflict (an
   * AGENTS.md an agent had rewritten) failed every PDF build until it was found.
   */
  const saveBuildInputs = async (e: OpenEditor): Promise<string[]> => {
    const scope = e.session.ctx.readRoot ?? e.session.ctx.root;
    const sessions = registry.all().flatMap(x => [x.session, ...registry.relatedSessions(x).values()]);
    const warnings: string[] = [];
    for (const doc of vscode.workspace.textDocuments) {
      const file = doc.uri.fsPath;
      if (!doc.isDirty || doc.isUntitled || doc.uri.scheme !== 'file' || doc === e.session.document || !TEX_INPUT.test(file) || !file.startsWith(scope + path.sep)) continue;
      // another OverLyX editor's document: its own save, which writes a change merged from disk itself
      const owner = sessions.find(s => s.document === doc);
      let saved: boolean;
      try { saved = owner ? (await owner.save(), true) : await doc.save(); } catch { saved = false; }
      if (!saved) warnings.push(`${path.relative(scope, file)}: its unsaved changes could not be saved (VS Code says why) — built from the file on disk`);
    }
    return warnings;
  };

  const startBuild = (e: OpenEditor, opts?: { open?: boolean }): void => {
    const { session } = e;
    const target = session.buildTarget();
    const latexmk = vscode.workspace.getConfiguration('overlyx').get<string>('latexmk') || 'latexmk';
    build.requestBuild({
      docId: session.docId, absPath: target.absPath, header: target.header, latexmk, texInputs: target.texInputs,
      prepare: async () => {
        // the .tex file on disk is what latexmk compiles: write the editor's state first
        await session.save(e.resync);
        return saveBuildInputs(e);
      },
    });
    telemetry.track('extension-build', 'attempt');
    if (opts?.open !== false) pdfPanels.show(session.docId);
  };

  const knownBuild = (docId: string) => {
    const known = build.lastBuild(docId);
    if (known) return known;
    const l = locate(docId);
    const texPath = /\.tex$/i.test(l.relPath) ? l.session?.buildTarget().absPath ?? path.join(l.root, l.relPath) : undefined;
    return build.lastBuild(docId, texPath);
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
  // a finished build: the document's editor fetches the check of its layout text boxes
  context.subscriptions.push({ dispose: build.onBuilt(docId => { telemetry.track('extension-build', build.lastBuild(docId)?.status === 'ok' ? 'success' : 'failed'); const e = registry.byDocId(docId); if (e) void e.panel.webview.postMessage({ type: 'built' } satisfies HostToEditor); }) });
  context.subscriptions.push({ dispose: () => bridge.dispose() });
  let webviewBase: string;
  // Resolve again when opening a webview, since the user can close a forwarding tunnel.
  const bridgeBase = async (): Promise<string> => webviewBase = await connectWebviewBridge(bridge.base);
  try {
    await bridge.start();
    await bridgeBase();
  } catch (e) {
    telemetry.report(e, 'activation.bridge');
    bridge.dispose();
    void vscode.window.showErrorMessage('OverLyX: could not connect to the preview server: ' + String(e));
    throw e;
  }
  const pdfPanels = new PdfPanels(context.extensionUri, bridgeBase, onInverse, (error, area) => telemetry.report(error, area), id => {
    const { project, path: rel } = splitDocId(id);
    const root = projectRoots.get(project);
    if (root) openDoc(root, rel);
  });

  function makeDelegate(): BridgeDelegate {
    const DICT_PKG: Record<string, string> = { en: 'dictionary-en', 'en-gb': 'dictionary-en-gb', de: 'dictionary-de', fr: 'dictionary-fr' };
    return {
      usageBatch: value => telemetry.usageBatch(value),
      typesetReport: value => telemetry.typeset(value),
      projectRoot: (project) => projectRoots.get(project),
      projects: () => [...projectRoots.entries()].map(([name, root]) => ({ name, files: collectFiles(root) })),
      meta: async (docId) => {
        const l = locate(docId);
        if (l.session) return l.session.meta();
        const r = cachedParseFile(l.ctx, l.relPath);
        return buildMeta({ ctx: l.ctx, project: projectOfDoc(docId), relPath: l.relPath, lyx: r.doc, isChild: r.fragment, fileText: readTextFile(path.join(l.root, l.relPath)) });
      },
      texText: async (docId) => {
        const l = locate(docId);
        return l.session ? l.session.toText() : readTextFile(path.join(l.root, l.relPath));
      },
      texMap: async (docId) => {
        const l = locate(docId);
        return l.session ? l.session.toTextMap() : { text: readTextFile(path.join(l.root, l.relPath)), spans: null };
      },
      applySource: async (docId, text) => {
        const session = registry.sessionByDocId(docId);
        if (!session) throw new Error('Open the document before editing its source');
        const parsed = await session.applySource(text);
        for (const entry of registry.all()) {
          if (entry.session.docId === docId) await entry.panel.webview.postMessage({ type: 'externalUpdate', pmDoc: parsed.pmDoc, headerLines: parsed.headerLines });
          else if (registry.relatedSessions(entry).has(docId)) await entry.panel.webview.postMessage({ type: 'relatedExternalUpdate', id: docId, pmDoc: parsed.pmDoc, headerLines: parsed.headerLines });
        }
        return { ok: true, warnings: parsed.warnings };
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
        let session = l.session;
        if (!session) {
          const project = registerRoot(l.root);
          const owner = registry.all().find(editor => editor.session.project === project);
          if (!owner) throw new Error('No open editor for this project');
          const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(l.root, l.relPath)));
          session = new DocSession(document, l.ctx, project, l.relPath, path.join(context.globalStorageUri.fsPath, 'recovery'));
          session.parseCurrent();
          registry.relatedSessions(owner).set(docId, session);
        }
        return { ok: true, headerLines: await session.setHeader(body) };
      },
      frontMatterGet: async (docId) => {
        const l = locate(docId);
        const text = l.session ? l.session.document.getText() : readTextFile(path.join(l.root, l.relPath));
        return { vars: frontMatterVars(frontMatterLines(text)), fonts: MD_FONTS };
      },
      // the front matter is the top of the file: rewritten there (only the keys set), and the session
      // takes the file's change up like any other (its settings follow: core md/typesetting.ts)
      frontMatterSet: async (docId, set) => {
        const l = locate(docId);
        if (!isMarkdownPath(l.relPath)) throw new Error('Only markdown documents keep their settings in front matter');
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(l.root, l.relPath)));
        const text = document.getText();
        const end = frontMatterEnd(text);
        const lines = setFrontMatter(frontMatterLines(text), set as Record<string, FMSet>);
        const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
        const head = lines.length ? lines.join(eol) + eol + (end ? '' : eol) : '';
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(end)), end && !lines.length ? '' : head);
        await vscode.workspace.applyEdit(edit);
        const headerLines = withTypesetting(l.session ? l.session.getHeaderLines() : cachedParseFile(l.ctx, l.relPath).doc.header.lines, lines);
        return { ok: true, vars: frontMatterVars(lines), headerLines };
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
        const b = knownBuild(docId);
        const job = build.currentJob(docId);
        const tex = withTex && b?.tex_path && fs.existsSync(b.tex_path) ? fs.readFileSync(b.tex_path, 'utf8') : undefined;
        let pdfAt: number | null = null;
        try { if (b?.pdf_path) pdfAt = Math.round(fs.statSync(b.pdf_path).mtimeMs); } catch { /* gone */ }
        return {
          build: b ? { ...b, pdf: pdfAt !== null ? `${webviewBase}/api/docs/${encodeURIComponent(docId)}/pdf?t=${pdfAt}` : null, pdf_at: pdfAt, tex } : null,
          job: job ? build.publicJob(job) : null,
          now: Date.now(),
        };
      },
      layoutCheck: (docId) => {
        const b = build.lastBuild(docId);
        const olx = b?.tex_path ? b.tex_path.replace(/\.tex$/, '.olx') : null;
        if (!b?.source || !olx || !fs.existsSync(olx)) return { params: null, boxes: [] };
        try {
          const l = locate(docId);
          return layoutCheck(fs.readFileSync(olx, 'utf8'), b.source, l.session ? l.session.toText() : readTextFile(path.join(l.root, l.relPath)));
        } catch { return { params: null, boxes: [] }; }
      },
      cancelBuild: (docId) => build.cancelBuild(docId),
      pdfPath: (docId) => knownBuild(docId)?.pdf_path ?? null,
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
      deliverableLink: async (project, relPath) => {
        const root = projectRoots.get(project);
        if (!root) throw new Error(`unknown project ${project}`);
        const abs = path.resolve(root, relPath);
        if (!abs.startsWith(root + path.sep)) throw new Error('path escapes project');
        await deliverableServer.start();
        // served from its workspace folder, as the slide editor serves pages (`../figures` reaches the project's figures)
        const served = rootFor(vscode.Uri.file(abs));
        const external = (await vscode.env.asExternalUri(vscode.Uri.parse(deliverableServer.origin))).toString().replace(/\/$/, '');
        return { base: external + deliverableServer.baseFor(served).slice(deliverableServer.origin.length), entry: path.relative(served, abs).split(path.sep).join('/'), expires: 0 };
      },
      agentTool: async (call) => {
        telemetry.track('extension-agent', 'attempt');
        if (!(TOOL_NAMES as readonly string[]).includes(call.tool)) return { error: `unknown tool ${call.tool}` };
        const target = toolTarget(call.args, call.cwd);
        const run = (store: TextStore) => runTool(call.tool as ToolName, call.args, {
          cwd: call.cwd, layoutDir: layoutDir(), author: call.author, store: abs => (abs === target ? store : undefined),
        });
        // only while this window answers (with Remote-SSH: while the user's computer is connected) and
        // begins the edit in time; else — or closed meanwhile — `gone`: the tool server edits the file (agents/handover.ts)
        const answer = await inEditor(() => vscode.commands.getCommands(true), h => {
          for (const e of registry.all()) { const job = e.agentEdit?.(target, run, h); if (job) return job; }
          return undefined;
        });
        telemetry.track('extension-agent', answer.gone ? 'offline' : answer.error ? 'failed' : 'success');
        return answer;
      },
      agentSelection: () => {
        // the latest selection among this window's editors, in its file's source as the editor holds it now
        const latest = registry.all().map(e => e.agentSelection).filter(s => !!s).sort((a, b) => b!.at - a!.at)[0];
        const session = latest && registry.sessionByDocId(latest.id);
        if (!latest || !session) return null;
        let placed: ReturnType<typeof placeSelection> | null = null;
        try { const map = session.toTextMap(); placed = placeSelection(map.text, map.spans, latest.sel); } catch { /* unparsable just now: the text alone */ }
        return {
          file: session.document.uri.fsPath, at: latest.at, focused: vscode.window.state.focused,
          unsaved: session.document.isDirty, text: latest.sel.text.slice(0, SELECTION_MAX), ...placed,
        };
      },
    };
  }

  const openDoc = (root: string, rel: string, opts?: { goto?: string; heading?: number; beside?: boolean }): void => {
    const resolved = path.resolve(root, rel);
    const abs = path.extname(resolved) ? resolved : resolved + '.tex';
    if (!fs.existsSync(abs)) { void vscode.window.showErrorMessage(`OverLyX: ${rel} does not exist`); return; }
    if (opts?.goto !== undefined || opts?.heading !== undefined) provider.navigateTo(`${registerRoot(root)}/${path.relative(root, abs)}`, { type: 'navigate', label: opts.goto, heading: opts.heading });
    const editor = /\.pdf$/i.test(abs) ? 'overlyx.pdfViewer' : /\.(tex|md|markdown)$/i.test(abs) ? 'overlyx.texEditor' : /\.html?$/i.test(abs) ? 'overlyx.htmlEditor' : 'default';
    void vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(abs), editor, { preview: false, viewColumn: opts?.beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active });
  };

  const provider = new OverlyxEditorProvider(context, registry, {
    bridgeBase,
    canvasBase: async () => {
      await deliverableServer.start();
      const origin = (await vscode.env.asExternalUri(vscode.Uri.parse(deliverableServer.origin))).toString().replace(/\/$/, '');
      return origin + '/_ol/';
    },
    layoutDir,
    registerRoot,
    startBuild,
    cancelBuild: (docId) => build.cancelBuild(docId),
    openPdfPanel: (docId) => void pdfPanels.show(docId),
    postToPdf: (docId, msg) => pdfPanels.post(docId, msg as never),
    openDoc,
    reportError: (error, area) => telemetry.report(error, area),
    track: (action, outcome, ms) => telemetry.track(action, outcome, ms),
  });

  const deliverableServer = new DeliverableServer(vscode.Uri.joinPath(context.extensionUri, 'dist/ol').fsPath, path.join(context.globalStorageUri.fsPath, 'cache'));
  const outlineTree = new OutlineTree(registry);
  const updater = new Updater(context);
  // the built-in Outline pane cannot show a webview editor's outline: surface the Structure view
  // in the Explorer whenever an OverLyX editor is open (the context key drives its "when")
  registry.onDidChange(() => void vscode.commands.executeCommand('setContext', 'overlyx.active', registry.all().length > 0));
  void vscode.commands.executeCommand('setContext', 'overlyx.active', false);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider('overlyx.pdfViewer', new PdfEditorProvider(context.extensionUri, bridgeBase, (error, area) => telemetry.report(error, area)), {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    }),
    vscode.window.registerCustomEditorProvider('overlyx.texEditor', provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
    vscode.window.createTreeView('overlyx.structure', { treeDataProvider: outlineTree, showCollapseAll: true }),
    vscode.window.createTreeView('overlyx.structureExplorer', { treeDataProvider: outlineTree, showCollapseAll: true }),
    registerTexSymbols(),
    vscode.window.onDidChangeActiveColorTheme(t => pdfPanels.postTheme([vscode.ColorThemeKind.Dark, vscode.ColorThemeKind.HighContrast].includes(t.kind))),
    // HTML deliverables: slide decks, posters, web pages (host/deliverables.ts)
    vscode.window.registerCustomEditorProvider('overlyx.htmlEditor', new DeliverableEditorProvider(context, deliverableServer, bridgeBase, provider), {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
    { dispose: () => deliverableServer.dispose() },
    registerCommand('overlyx.openDeliverable', (uri?: vscode.Uri) => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      const target = uri ?? (input instanceof vscode.TabInputText ? input.uri : undefined);
      if (target) void vscode.commands.executeCommand('vscode.openWith', target, 'overlyx.htmlEditor');
    }),
    registerCommand('overlyx.openInOverlyx', (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (target) void vscode.commands.executeCommand('vscode.openWith', target, 'overlyx.texEditor');
    }),
    registerCommand('overlyx.openPdf', (uri?: vscode.Uri) => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      const target = uri ?? (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom ? input.uri : undefined);
      if (target) void vscode.commands.executeCommand('vscode.openWith', target, 'overlyx.pdfViewer');
    }),
    // ⌘K (link), ⌘J (rewrite with AI), ⌘\ (clear formatting), ⌘B (bold), ⌘M / ⌘⇧M (formula), F5 (present slides) belong
    // to the editor in the webview, which handles them itself; bound here so that VS Code does not also start its ⌘K chord,
    // toggle the panel or the side bar, split, switch Tab to moving the focus or open the Problems panel
    registerCommand('overlyx.editorKey', () => undefined),
    registerCommand('overlyx.openAsText', () => {
      const doc = registry.active?.session.document;
      if (doc) void vscode.commands.executeCommand('vscode.openWith', doc.uri, 'default');
    }),
    registerCommand('overlyx.buildPdf', () => {
      const e = registry.active;
      if (e) void e.panel.webview.postMessage({ type: 'command', name: 'buildPdf' } satisfies HostToEditor);
      else void vscode.window.showInformationMessage('OverLyX: open a .tex document in the OverLyX editor first');
    }),
    registerCommand('overlyx.syncToPdf', () => {
      const e = registry.active;
      if (e) void e.panel.webview.postMessage({ type: 'command', name: 'syncToPdf' } satisfies HostToEditor);
    }),
    registerCommand('overlyx.toggleCombined', () => {
      const e = registry.active;
      if (e) void e.panel.webview.postMessage({ type: 'command', name: 'toggleCombined' } satisfies HostToEditor);
    }),
    registerCommand('overlyx.toggleMargin', () => {
      const e = registry.active;
      if (e) void e.panel.webview.postMessage({ type: 'command', name: 'toggleMargin' } satisfies HostToEditor);
    }),
    registerCommand('overlyx.refreshOutline', () => outlineTree.refresh()),
    registerCommand('overlyx.checkForUpdates', () => void updater.check({ interactive: true }).catch(e => {
      telemetry.report(e, 'update.manual');
      return vscode.window.showErrorMessage('OverLyX update check failed: ' + String(e));
    })),
    registerCommand('overlyx.gotoOutline', (pos: number) => {
      const e = registry.active;
      if (e) void e.panel.webview.postMessage({ type: 'goto', pos } satisfies HostToEditor);
    }),
    ...registerNewDocumentCommands(layoutDir, (e, area) => telemetry.report(e, area)),
  );

  // `overlyx.defaultEditor`: .tex files open in the OverLyX editor unless the user picks another.
  // The custom editor is registered with priority "option" (installing the extension must not take
  // .tex files away from anyone), so the setting is carried out through the user's own
  // `workbench.editorAssociations` — the entry VS Code consults for every open (explorer, Quick
  // Open, `code file.tex`). Switching the setting off removes only the entry it wrote.
  const applyDefaultEditor = async (switched: boolean): Promise<void> => {
    const want = vscode.workspace.getConfiguration('overlyx').get<boolean>('defaultEditor') ?? false;
    const workbench = vscode.workspace.getConfiguration('workbench');
    const associations = { ...(workbench.inspect<Record<string, string>>('editorAssociations')?.globalValue ?? {}) };
    if (want && associations['*.tex'] !== 'overlyx.texEditor') {
      associations['*.tex'] = 'overlyx.texEditor';
      await workbench.update('editorAssociations', associations, vscode.ConfigurationTarget.Global);
    } else if (!want && switched && associations['*.tex'] === 'overlyx.texEditor') {
      delete associations['*.tex'];
      await workbench.update('editorAssociations', Object.keys(associations).length ? associations : undefined, vscode.ConfigurationTarget.Global);
    }
  };
  const defaultEditorFailed = (e: unknown): void => {
    telemetry.report(e instanceof Error ? e : new Error(String(e)), 'settings.defaultEditor');
    void vscode.window.showErrorMessage(`OverLyX could not update workbench.editorAssociations: ${String(e)}`);
  };
  void applyDefaultEditor(false).catch(defaultEditorFailed);
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('overlyx.defaultEditor')) void applyDefaultEditor(true).catch(defaultEditorFailed); }));

  updater.schedule();
  // Claude Code / Codex on this computer: their edits of the documents as tracked changes (agents/server.ts)
  setupAgents(context, layoutDir, (e, area) => telemetry.report(e, area), {
    files: () => registry.all().flatMap(e => [e.session, ...registry.relatedSessions(e).values()].map(s => s.document.uri.fsPath)),
    onDidChange: registry.onDidChange,
    endpoint: () => bridge.base,
  });

  // a clone of an OverLyX project in the workspace: kept in step with the server (host/sync.ts)
  setupSync(context, (e, area) => telemetry.report(e, area), (outcome, ms) => telemetry.track('extension-sync', outcome, ms));

  return { registry, bridgeBase: () => bridge.base, checkForUpdates: (opts) => updater.check(opts ?? { interactive: true }) };
}

export function deactivate(): void { /* subscriptions dispose everything */ }
