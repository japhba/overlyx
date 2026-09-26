import { MenuBar, openPalette, PALETTE_LABEL, type MenuDef, ThemeToggle } from '@client/app/MenuBar';
import { documentMenus } from '@client/app/documentMenus';
import { editorViewMenu } from '@client/app/editorViewMenu';
import { buildToolbars, loadToolbarPrefs, mathExecutor, useMathPanels, toolbarClipboard, markValue, type ToolbarId, type ToolbarMode, type ToolbarPrefs } from '@client/app/toolbars';
import { debounce, hashAuthor, applyAuthorColors, bcp47, suggestLabel, LayoutPicker, documentStats, applyEditorZoom, SidebarGrip, restoreSidebarWidths } from '@client/app/shellutil';
import { setDocumentFonts } from '@client/fonts/editorfont';
import { usePresentation } from '@client/app/presentation';
import { referenceTransaction } from '@client/editor/references';
import { inkToolbar } from '@client/app/inkToolbar';
import { StatsDialog } from '@client/app/StatsDialog';
import { SettingsPanel } from '@client/app/Settings';
import { HelpDialog, HELP_ROWS } from '@client/app/Dialogs';
import { Ruler, DEFAULT_WIDTH, MIN_WIDTH, MAX_WIDTH, NOTE_SCALE_DEFAULT } from '@client/app/Ruler';
import { setInk, subscribeInk } from '@client/editor/plugins/ink';
/**
 * The OverLyX editor inside VS Code: the web client's Workspace (App.tsx) trimmed to the editor
 * itself — LyX toolbars, find & replace, contextual math/table/review rows, comments margin and
 * panel, dialogs, status bar. File browsing, git, versions and agents stay on the VS Code side;
 * the PDF lives in its own panel (pdfMain.tsx). Document sync with the extension host runs over
 * postMessage (full ProseMirror doc, debounced), everything else over the local HTTP bridge.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'preact/hooks';
import type { EditorView } from 'prosemirror-view';
import { TextSelection } from 'prosemirror-state';
import { vscode, applyTheme } from './globals';
import type { HostToEditor, OutlineEntry } from '../shared/protocol';
import { api, type DocMeta } from '@client/api';
import { getPrefs, setPref, subscribePrefs, type Prefs } from '@client/prefs';
import { Toolbar } from '@client/app/Toolbar';
import { buildOutline, Outline, type OutlineItem } from '@client/app/Outline';
import { Comments } from '@client/app/Comments';
import { StatusBar, type Status } from '@client/app/StatusBar';
import { SourcePane, cursorLine, docBlocks, blockPos } from '@client/app/SourcePane';
import { ViewModeSwitch, type ViewMode } from '@client/app/ViewModeSwitch';
import { locateSourceLine } from '@client/app/sourcelocate';
import { activeMathField, mathFocusListeners, mathCursorListeners, type LyxMathField } from '@client/editor/lyxmath/field';
import {
GraphicsDialog,TableDialog,LabelDialog,RefDialog,CiteDialog,HrefDialog,SettingsDialog,InsetDialog,
TexDialog,MacrosDialog,ParagraphDialog,TableSettingsDialog,DelimiterDialog,MatrixDialog,commandParams
} from '@client/app/Dialogs';
import { createLocalEditor, type LocalEditorHandle } from './localEditor';
import { editorSessions } from './editorSession';
import { RelatedEditor, type RelatedHandle } from './RelatedEditor';
import { documentOrder } from './documentOrder';
import { refreshMacros } from '@client/editor/macrodefs';
import { editorContext, viewDocId } from '@client/editor/context';
import { STANDARD_LAYOUTS, sectionLevel } from '@client/editor/layouts';
import { chordKey } from '@client/editor/keymap';
import * as C from '@client/editor/commands';
import { setMarginMode } from '@client/editor/plugins/margin';
import { acceptAllChanges, rejectAllChanges, changeAt } from '@client/editor/plugins/changes';
import { setQuery, findNext, replaceCurrent, replaceAll, findKey } from '@client/editor/plugins/find';
import { unquote, projectOfDoc, docDirOf } from '@overlyx/core';
import { describeChange } from '@client/editor/assembly';

type DialogState = { name: string; arg?: unknown } | null;

const stored = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };

export function EditorShell({ init }: { init: Extract<HostToEditor, { type: 'init' }> }) {
  const docId = init.docId;
  const [meta, setMeta] = useState<DocMeta | null>(null);
  const metaRef = useRef(meta);
  metaRef.current = meta;
  const [headerLines, setHeaderLines] = useState<string[]>(editorSessions.get(docId)?.headerLines ?? init.headerLines);
  const headerRef = useRef(headerLines);
  const setHeader = (lines: string[]) => { headerRef.current = lines; setHeaderLines(lines); };
  const [layout, setLayout] = useState('Standard');
  const [dialog, setDialog] = useState<DialogState>(null);
  const [message, setMessage] = useState<{ text: string; kind: 'info' | 'error' } | null>(null);
  const [marginMode, setMarginModeState] = useState(stored('ol.margin') === '1');
  const [showComments, setShowComments] = useState(stored('ol.vscode.comments') === '1');
  // the outline as a panel inside the editor (the web client's Outline: click to jump, ▲▼ to move a section, ◀▶ to promote / demote) — shown unless hidden
  const [showOutline, setShowOutline] = useState(stored('ol.vscode.outline') !== '0');
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [activePos, setActivePos] = useState(0);
  const [tracking, setTracking] = useState(false);
  const [chord, setChord] = useState<string | null>(null);
  const [changeInfo, setChangeInfo] = useState<string | null>(null);
  const [zoom, setZoom] = useState(Number(stored('ol.zoom') || 1) || 1);
  const [viewMode, setViewMode] = useState<ViewMode>('wysiwyg');
  // light / dark: VS Code's theme unless the user picked one here (the sun / moon button; stored like the web client's ol.theme)
  const [themePref, setThemePref] = useState<'system' | 'light' | 'dark'>(() => { const v = stored('ol.theme'); return v === 'light' || v === 'dark' ? v : 'system'; });
  const hostDark = useRef(init.dark);
  const shownDark = themePref === 'system' ? hostDark.current : themePref === 'dark';
  useEffect(() => { applyTheme(shownDark); }, [shownDark]);
  const cycleTheme = () => {
    const next = themePref === 'system' ? (hostDark.current ? 'light' : 'dark') : themePref === 'light' ? 'dark' : 'system';
    setThemePref(next);
    try { if (next === 'system') localStorage.removeItem('ol.theme'); else localStorage.setItem('ol.theme', next); } catch { /* ignore */ }
  };
  const [textWidth, setTextWidth] = useState(Number(stored('ol.textWidth') ?? DEFAULT_WIDTH));
  const [noteScale, setNoteScale] = useState(Number(stored('ol.noteScale') ?? NOTE_SCALE_DEFAULT));
  const [showRuler, setShowRuler] = useState(stored('ol.ruler') !== '0');
  const [inkMode, setInkMode] = useState(stored('ol.ink') === '1');
  useEffect(() => { document.documentElement.style.setProperty('--text-width', textWidth > 0 ? textWidth + 'px' : '100%'); localStorage.setItem('ol.textWidth', String(textWidth)); }, [textWidth]);
  useEffect(() => { document.documentElement.style.setProperty('--note-size', noteScale / 100 + 'em'); localStorage.setItem('ol.noteScale', String(noteScale)); }, [noteScale]);
  useEffect(() => { localStorage.setItem('ol.ruler', showRuler ? '1' : '0'); }, [showRuler]);
  useEffect(() => { setInk({ active: inkMode }); localStorage.setItem('ol.ink', inkMode ? '1' : '0'); }, [inkMode]);
  useEffect(() => subscribeInk(() => force(t => t + 1)), []);
  const stepTextWidth = (direction: number) => setTextWidth(w => direction === 0 ? DEFAULT_WIDTH : Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, (w || DEFAULT_WIDTH) + direction * 80)));
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && inkMode) el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
  }, [inkMode, docId]);
  const [findOpen, setFindOpen] = useState(false);
  const [findQ, setFindQ] = useState(''), [replQ, setReplQ] = useState('');
  const [findCase, setFindCase] = useState(false), [findWord, setFindWord] = useState(false);
  const [findRegex, setFindRegex] = useState(false), [findMath, setFindMath] = useState(false), [findSel, setFindSel] = useState(false);
  const [findAdv, setFindAdv] = useState(false);
  const [toolbars, setToolbars] = useState<ToolbarPrefs>(loadToolbarPrefs);
  const [mathField, setMathField] = useState<LyxMathField | null>(null);
  const [prefs, setPrefsState] = useState<Prefs>(getPrefs);
  const [docTick, setDocTick] = useState(0);
  const [combined, setCombined] = useState(stored('ol.vscode.combined') === '1');
  const [selTick, setSelTick] = useState(0);
  const [, force] = useState(0);
  const rerender = () => force(x => x + 1);

  const handleRef = useRef<LocalEditorHandle | null>(null);
  const relatedRefs = useRef(new Map<string, RelatedHandle>());
  const activeViewRef = useRef<EditorView | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const currentView = () => activeViewRef.current ?? handleRef.current?.view ?? null;
  const view = currentView();
  const allViews = () => [handleRef.current?.view, ...[...relatedRefs.current.values()].map(h => h.view)].filter((v): v is EditorView => !!v);
  const docHeaders = (id: string) => id === docId ? headerRef.current : editorSessions.get(id)!.headerLines!;
  const updateHeader = (id: string, lines: string[]) => { if (id === docId) setHeader(lines); else editorSessions.get(id)!.headerLines = lines; };
  const updateMeta = (id: string, value: DocMeta) => {
    if (id === docId) setMeta(value); else relatedRefs.current.get(id)!.meta = value;
    if (currentView() && viewDocId(currentView()!) === id) editorContext.meta = value;
    setDocTick(t => t + 1);
  };
  const documents = new Map(allViews().map(v => [viewDocId(v), v.state.doc]));
  const visibleIds = combined ? documentOrder(meta?.master ?? docId, documents) : [docId];
  if (!visibleIds.includes(docId)) visibleIds.push(docId);
  const registerRelated = useCallback((id: string, handle: RelatedHandle | null) => {
    if (handle) relatedRefs.current.set(id, handle);
    else {
      if (activeViewRef.current === relatedRefs.current.get(id)?.view) {
        activeViewRef.current = handleRef.current?.view ?? null;
        editorContext.activeView = activeViewRef.current;
      }
      relatedRefs.current.delete(id);
    }
    setDocTick(t => t + 1);
  }, []);

  const notify = useCallback((text: string, kind: 'info' | 'error' = 'info') => {
    setMessage({ text, kind });
    setTimeout(() => setMessage(m => (m?.text === text ? null : m)), 4000);
    if (kind === 'error') vscode.postMessage({ type: 'notify', text, kind });
  }, []);

  useEffect(() => { localStorage.setItem('ol.toolbars', JSON.stringify(toolbars)); }, [toolbars]);
  useEffect(() => subscribePrefs(setPrefsState), []);
  useEffect(() => applyEditorZoom(zoom), [zoom]);
  // Settings ▸ Editor ▸ Font ▸ "As in the document" follows the document's roman font
  useEffect(() => setDocumentFonts(headerLines), [headerLines]);
  usePresentation();   // View ▸ Presentation mode: Shift+F11 toggles, Esc leaves
  useEffect(() => { editorContext.combined = combined; localStorage.setItem('ol.vscode.combined', combined ? '1' : '0'); }, [combined]);
  useEffect(() => { try { localStorage.setItem('ol.vscode.comments', showComments ? '1' : '0'); } catch { /* ignore */ } }, [showComments]);
  useEffect(() => { try { localStorage.setItem('ol.vscode.outline', showOutline ? '1' : '0'); } catch { /* ignore */ } }, [showOutline]);
  useEffect(() => { restoreSidebarWidths(); }, []);
  useEffect(() => { const l = (f: LyxMathField | null) => { setMathField(f); editorContext.mathField = f; }; mathFocusListeners.add(l); return () => { mathFocusListeners.delete(l); }; }, []);
  useEffect(() => { const l = () => setSelTick(t => t + 1); mathCursorListeners.add(l); return () => { mathCursorListeners.delete(l); }; }, []);

  const setToolbar = (id: ToolbarId, mode: ToolbarMode) => setToolbars(t => ({ ...t, [id]: mode }));
  const tbMode = (id: ToolbarId): ToolbarMode => toolbars[id] ?? 'auto';

  /* ---------------------------------------------------------------- editor lifecycle */
  const postUpdate = useMemo(() => debounce((v: EditorView) => {
    const update = handleRef.current!.takeUpdate(headerRef.current);
    if (update) vscode.postMessage({ type: 'update', ...update });
  }, 300), []);
  const postOutline = useMemo(() => debounce((v: EditorView) => {
    const items: OutlineEntry[] = buildOutline(v.state.doc, true, editorContext.meta?.secnumdepth ?? 3);
    setOutline(items);
    vscode.postMessage({ type: 'outline', items });
  }, 300), []);
  const postSelection = useMemo(() => debounce((v: EditorView) => {
    vscode.postMessage({ type: 'selection', pos: v.state.selection.from });
  }, 250), []);

  const onSelection = (v: EditorView) => {
    if (!v.hasFocus() && currentView() && currentView() !== v) return;
    activeViewRef.current = v;
    editorContext.activeView = v;
    const id = viewDocId(v);
    editorContext.docId = id;
    editorContext.project = projectOfDoc(id);
    editorContext.docDir = docDirOf(id);
    const activeMeta = id === docId ? metaRef.current : relatedRefs.current.get(id)?.meta;
    if (activeMeta) {
      editorContext.meta = activeMeta;
      editorContext.trackChanges = activeMeta.trackingChanges;
      editorContext.changeAuthorId = activeMeta.authors.find(a => a.name === 'You')?.id;
      setTracking(activeMeta.trackingChanges);
    }
    const p = C.currentParagraph(v.state);
    setLayout(p ? p.node.attrs.layout : '');
    setChord(chordKey.getState(v.state) ?? null);
    const ch = changeAt(v.state, v.state.selection.from);
    setChangeInfo(ch ? describeChange(ch.type, ch.author, ch.time) : null);
    setSelTick(t => t + 1);
    if (viewDocId(v) === docId) { postSelection(v); setActivePos(v.state.selection.from); }
    rerender();
  };

  useEffect(() => {
    let cancelled = false;
    let handle: LocalEditorHandle | null = null;
    void (async () => {
      editorContext.user = { id: 1, username: 'you', name: 'You', color: '#3b6ea5', isAdmin: false };
      editorContext.docId = docId;
      editorContext.project = projectOfDoc(docId);
      editorContext.docDir = docDirOf(docId);
      editorContext.trackChanges = false;
      editorContext.combined = combined;
      // metadata FIRST (macros, authors, layouts): formulas must render once, with the macros —
      // a \RR rendered before its definition arrives would stay raw (the web app defers the same way)
      let m: DocMeta | null = null;
      try { m = await api.meta(docId); } catch (e) { notify('Could not load document metadata: ' + (e as Error).message, 'error'); }
      if (cancelled || !containerRef.current) return;
      if (m) { setMeta(m); editorContext.meta = m; }
      const cached = editorSessions.has(docId);
      handle = createLocalEditor({
        docId, container: containerRef.current, pmDoc: init.pmDoc, headerLines: headerRef.current, marginMode,
        onSelectionChange: onSelection,
        onDocChange: v => { setDocTick(t => t + 1); postUpdate(v); postOutline(v); },
      });
      handleRef.current = handle;
      // HMR keeps the local document/undo manager, but init belongs to the old mount.
      // Request a fresh host snapshot rather than writing the cached model back on refresh.
      if (cached) vscode.postMessage({ type: 'ready' });
      editorContext.activeView = handle.view;
      (window as any).overlyx = editorContext;
      if (m) {
        handle.view.dom.lang = bcp47(m.language);
        applyAuthorColors(m.authors);
        setTracking(m.trackingChanges);
        editorContext.trackChanges = m.trackingChanges;
        editorContext.changeAuthorId = m.authors.find(x => x.name === 'You')?.id;
      }
      refreshMacros(handle.view, m?.macros ?? {});
      postOutline(handle.view);
      rerender();
      api.aiStatus().then(s => { editorContext.ai = s; }).catch(() => { editorContext.ai = { available: false, model: '', completionModel: '', models: [] }; });
      handle.view.focus();
      if (scrollRef.current) scrollRef.current.scrollTop = editorSessions.get(docId)!.scrollTop;
    })();
    return () => {
      cancelled = true;
      postUpdate.cancel();
      postOutline.cancel();
      postSelection.cancel();
      if (handle) {
        const update = handle.takeUpdate(headerRef.current);
        if (update) vscode.postMessage({ type: 'update', ...update });
        editorSessions.get(docId)!.scrollTop = scrollRef.current?.scrollTop ?? 0;
        editorSessions.get(docId)!.headerLines = headerRef.current;
        handle.destroy(!!import.meta.hot);
      }
      handleRef.current = null;
      activeViewRef.current = null;
    };
  }, []);

  /* ---------------------------------------------------------------- host messages */
  const metaReload = useMemo(() => debounce(() => {
    api.meta(docId).then(m => {
      setMeta(m); editorContext.meta = m;
      const v = handleRef.current?.view;
      if (v) refreshMacros(v, m.macros ?? {});
    }).catch(() => {});
  }, 1500), []);

  useEffect(() => {
    const onMsg = (ev: MessageEvent<HostToEditor>) => {
      const m = ev.data;
      if (!m) return;
      const v = handleRef.current?.view;
      if (!v) return;
      switch (m.type) {
        case 'init':
        case 'externalUpdate':
          postUpdate.cancel();
          setHeader(handleRef.current!.applyExternal(m.pmDoc, m.headerLines, m.ack));
          postUpdate(v);
          postOutline(v);
          metaReload();
          break;
        case 'metadataChanged': metaReload(); break;
        case 'navigate': {
          if (m.label !== undefined) gotoLabelIn(v, m.label);
          else if (m.heading !== undefined) {
            const heading = buildOutline(v.state.doc, false).filter(item => sectionLevel(item.layout) !== null)[m.heading];
            if (heading) { v.dispatch(v.state.tr.setSelection(TextSelection.near(v.state.doc.resolve(heading.pos))).scrollIntoView()); v.focus(); }
          }
          break;
        }
        case 'goto': {
          try {
            const pos = Math.max(0, Math.min(m.pos, v.state.doc.content.size));
            v.dispatch(v.state.tr.setSelection(TextSelection.near(v.state.doc.resolve(pos))).scrollIntoView());
            v.focus();
          } catch { /* stale position */ }
          break;
        }
        case 'command':
          if (m.name === 'toggleMargin') toggleMargin();
          else if (m.name === 'find') setFindOpen(true);
          else if (m.name === 'syncToPdf') void syncToPdf();
          else if (m.name === 'buildPdf') build();
          else if (m.name === 'toggleTracking') void toggleTracking();
          else if (m.name === 'toggleCombined') setCombined(c => !c);
          break;
        case 'inverseSync': void gotoTexLine(m.line); break;
        case 'theme': hostDark.current = m.dark; rerender(); break;
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  });

  /* ---------------------------------------------------------------- commands and helpers */
  const run = (cmd: (state: any, dispatch: any, view?: any) => boolean) => { const v = currentView(); if (!v) return; cmd(v.state, v.dispatch, v); v.focus(); };
  const runView = (fn: (v: EditorView) => boolean) => { const v = currentView(); if (!v) return; fn(v); };

  const build = (opts?: { open?: boolean }) => { editorContext.ui?.save(); vscode.postMessage({ type: 'build', open: opts?.open ?? true }); notify('Building the PDF…'); };
  const hostCommand = (name: Extract<import('../shared/protocol').EditorToHost, { type: 'hostCommand' }>['name']) => vscode.postMessage({ type: 'hostCommand', name, id: view ? viewDocId(view) : docId });

  const builtTex = async (): Promise<string | null> => {
    try { const r = await api.build(docId, true); return r.build?.tex ?? null; } catch { return null; }
  };
  const syncToPdf = async () => {
    const v = currentView();
    if (!v) return;
    const tex = await builtTex();
    if (!tex) { notify('SyncTeX needs a built PDF — build it first (Ctrl+R)', 'error'); return; }
    const where = cursorLine(v, tex, mathField, null);
    if (!where) { notify("Could not find the cursor's place in the LaTeX source", 'error'); return; }
    try {
      const { boxes } = await api.synctexView(docId, where.line + 1);
      if (!boxes.length) { notify(`SyncTeX has no position for line ${where.line + 1} of the built LaTeX`, 'error'); return; }
      const b = boxes[0];
      vscode.postMessage({ type: 'openPdfPanel' });
      vscode.postMessage({ type: 'syncTarget', target: { page: b.page, x: b.h, y: b.v - b.H, w: b.W, h: b.H, seq: Date.now() } });
    } catch (e) { notify('SyncTeX: ' + (e as Error).message, 'error'); }
  };
  const gotoTexLine = async (line: number) => {
    const v = currentView();
    if (!v || !line) return;
    const tex = await builtTex();
    if (!tex) return;
    const blocks = docBlocks(v);
    const hit = locateSourceLine(tex, line - 1, blocks);
    if (!hit) { notify(`SyncTeX: line ${line} of the LaTeX source was not found in the document`, 'error'); return; }
    const b = blocks[hit.index];
    const pos = Math.min(b.kind === 'math' ? b.pos : blockPos(b, hit.offset), v.state.doc.content.size);
    v.dispatch(v.state.tr.setSelection(TextSelection.near(v.state.doc.resolve(pos))).scrollIntoView());
    v.focus();
  };

  const toggleMargin = () => {
    setMarginModeState(on => {
      const next = !on;
      localStorage.setItem('ol.margin', next ? '1' : '0');
      for (const v of allViews()) setMarginMode(v, next);
      return next;
    });
  };

  const toggleTracking = async () => {
    const target = viewDocId(currentView()!);
    const next = !editorContext.trackChanges;
    try {
      if (next && editorContext.changeAuthorId === undefined) {
        const id = hashAuthor('You');
        const lines = [...docHeaders(target)];
        const idx = lines.findIndex(l => l.startsWith('\\author '));
        const line = `\\author ${id} "You" ""`;
        if (idx >= 0) lines.splice(idx, 0, line); else lines.push(line);
        const r = await api.setHeader(target, { headerLines: lines, set: { tracking_changes: 'true' } });
        updateHeader(target, r.headerLines);
        editorContext.changeAuthorId = id;
        updateMeta(target, { ...editorContext.meta!, trackingChanges: next, authors: [...editorContext.meta!.authors, { id, name: 'You' }] });
      } else {
        const r = await api.setHeader(target, { set: { tracking_changes: String(next) } });
        updateHeader(target, r.headerLines);
        updateMeta(target, { ...editorContext.meta!, trackingChanges: next });
      }
      editorContext.trackChanges = next;
      setTracking(next);
      notify(next ? 'Change tracking ON' : 'Change tracking OFF');
    } catch (e) { notify('Could not switch change tracking: ' + (e as Error).message, 'error'); }
  };

  const gotoLabelIn = (v: EditorView, name: string): boolean => {
    let found = -1;
    v.state.doc.descendants((node, pos) => {
      if (found >= 0) return false;
      if (node.type.name === 'command' && node.attrs.cmd === 'label' && unquote(commandParams(node).get('name')) === name) found = pos;
      if (node.type.name === 'math_display' && String(node.attrs.latex).includes(`\\label{${name}}`)) found = pos;
      return true;
    });
    if (found < 0) return false;
    try {
      v.dispatch(v.state.tr.setSelection(TextSelection.near(v.state.doc.resolve(found))).scrollIntoView());
      v.focus();
      (v.nodeDOM(found) as HTMLElement | null)?.scrollIntoView?.({ block: 'center' });
    } catch { return false; }
    return true;
  };

  // UI hooks for the keymap and node views
  useEffect(() => {
    editorContext.notify = notify;
    editorContext.openDialog = (name, arg) => setDialog({ name, arg });
    editorContext.openInsetDialog = (v, pos) => { v.focus(); onSelection(v); if (pos !== undefined) setDialog({ name: 'inset', arg: pos }); };
    editorContext.openInTab = (id, opts) => vscode.postMessage({ type: 'openDoc', id, goto: opts?.goto, heading: opts?.heading });
    editorContext.separateDocument = { label: 'Open in new editor tab', open: id => vscode.postMessage({ type: 'openDoc', id, beside: true }) };
    editorContext.gotoLabel = (name, from) => {
      const v = from ?? handleRef.current?.view;
      if (v && gotoLabelIn(v, name)) return;
      for (const candidate of allViews()) if (candidate !== v && gotoLabelIn(candidate, name)) return;
      const l = editorContext.meta?.labels.find(x => x.name === name);
      if (l?.file && editorContext.project) { vscode.postMessage({ type: 'openDoc', id: `${editorContext.project}/${l.file}`, goto: name }); return; }
      notify(`Label “${name}” not found`, 'error');
    };
    editorContext.ui = {
      save: () => {
        // flush the debounced update first, then let VS Code write the file (ordered messages)
        postUpdate.cancel();
        const update = handleRef.current?.takeUpdate(headerRef.current);
        if (update) vscode.postMessage({ type: 'update', ...update });
        for (const handle of relatedRefs.current.values()) handle.flush();
        vscode.postMessage({ type: 'save' });
      },
      viewPdf: () => build(),
      updatePdf: () => build({ open: false }),
      syncToPdf: () => { void syncToPdf(); },
      find: () => setFindOpen(true),
      openDialog: (name, arg) => setDialog({ name, arg }),
      toggleTrackChanges: () => { void toggleTracking(); },
      toggleOutline: () => setShowOutline(s => !s),
      toggleSource: () => setViewMode(mode => mode === 'wysiwyg' ? 'split' : 'wysiwyg'),
      toggleCombined: () => setCombined(value => !value),
      acceptAll: () => run(acceptAllChanges()),
      rejectAll: () => run(rejectAllChanges()),
      closeTab: () => hostCommand('closeTab'),
      zoom: (d) => setZoom(z => (d === 0 ? 1 : Math.min(2.5, Math.max(0.5, +(z + d * 0.1).toFixed(2))))),
      textWidth: stepTextWidth,
      openFile: () => hostCommand('openFile'),
      newFile: () => hostCommand('newFile'),
    };
  });

  const activeId = view ? viewDocId(view) : docId;
  const activeMeta = activeId === docId ? meta : relatedRefs.current.get(activeId)!.meta;
  const sourceTarget = view && handleRef.current ? { view, ydoc: activeId === docId ? handleRef.current.ydoc : editorSessions.get(activeId)!.ydoc, docId: activeId } : null;

  /* ---------------------------------------------------------------- labels, marks, table state */
  const labels = useMemo(() => {
    const v = currentView();
    const out: { name: string; context: string; file?: string }[] = [];
    if (v) {
      v.state.doc.descendants((node, pos) => {
        if (node.type.name === 'command' && node.attrs.cmd === 'label') {
          const $p = v.state.doc.resolve(pos);
          out.push({ name: unquote(commandParams(node).get('name')), context: $p.parent.textContent.slice(0, 60) });
        } else if (node.type.name === 'math_display') {
          for (const m of String(node.attrs.latex).matchAll(/\\label\{([^}]*)\}/g)) out.push({ name: m[1], context: '(equation)' });
        }
        return true;
      });
    }
    for (const l of meta?.labels ?? []) if (!out.some(x => x.name === l.name)) out.push(l);
    return out;
  }, [docTick, meta]);
  const labelNames = () => labels.map(l => l.name);
  const refCountOf = (nm: string): number => {
    const v = currentView();
    if (!v || !nm) return 0;
    let n = 0;
    v.state.doc.descendants(node => {
      if (node.type.name === 'command' && node.attrs.cmd === 'ref') {
        const target = unquote(commandParams(node).get('reference'));
        if (target.split(',').map(t => t.trim()).includes(nm)) n++;
      }
      return true;
    });
    return n;
  };

  const textColor = markValue(view, 'color');
  const mathExec = mathExecutor(currentView);
  const mathPanels = useMathPanels(mathExec);
  const clipboard = toolbarClipboard(currentView, notify);
  const insertInMath = (latex: string) => { const field = activeMathField(); if (field) { field.execute('insert', latex); field.focus(); } else mathExec('insert', latex); };
  const docStats = useMemo(() => view ? documentStats(view) : null, [view, docTick, selTick]);
  const tb = buildToolbars({
    view, docId: activeId, meta: activeMeta, headerLines: docHeaders(activeId), prefs: { ...prefs, aiButton: false }, layout, mathField, tracking, marginMode,
    tbMode, setToolbar, run, runView, mathExec, mathPanels, clipboard, setDialog, openFind: () => setFindOpen(true), notify,
    toggleTracking: () => { void toggleTracking(); }, toggleMargin, build: () => build(), updatePdf: () => build({ open: false }), syncToPdf: () => { void syncToPdf(); },
    onHeaderLines: lines => { updateHeader(activeId, lines); setDocTick(t => t + 1); },
    slots: {
      leading: [{ id: 'new', title: 'New document', icon: 'new', action: () => hostCommand('newFile') }, { id: 'open', title: 'Open', icon: 'open', action: () => hostCommand('openFile') }],
      navigation: [{ id: 'navback', title: 'Navigate back', icon: 'navback', action: () => hostCommand('back') }],
      sidebars: [{ id: 'outline', title: 'Outline (sections: click to jump, move and promote / demote them)', icon: 'outline', action: () => setShowOutline(s => !s), active: showOutline }],
      tools: [{ id: 'ink', title: 'Draw in the margins', icon: 'ink', action: () => setInkMode(m => !m), active: inkMode }, { id: 'comments-panel', title: 'Comments', icon: 'notes', action: () => setShowComments(s => !s), active: showComments }],
      pdf: activeMeta?.master ? [{ id: 'pdfmaster', title: 'View master document', icon: 'viewmaster', action: () => vscode.postMessage({ type: 'openDoc', id: activeMeta.master! }) }] : [],
    },
  });
  const inkGroups = inkToolbar();
  const toggleCellLine = (key: string) => {
    const cell = view && C.tableContext(view.state)?.cell;
    const attrs = new Map<string, string>(JSON.parse(cell?.attrs.attrs || '[]'));
    run(C.setCellAttr(key, attrs.get(key) === 'true' ? null : 'true'));
  };
  const editingMenus = documentMenus({ view, meta: activeMeta, run, runView, setDialog, textColor, tracking, changeInfo, toggleTracking, toggleCellLine, setFindOpen,
    healthItems: [], reloadMetadata: () => { void api.meta(activeId).then(m => { updateMeta(activeId, m); if (view) refreshMacros(view, m.macros, true); notify('Metadata reloaded'); }); },
  });
  const menus: MenuDef[] = [
    { title: 'File', items: [
      { label: 'New…', action: () => hostCommand('newFile') },
      { label: 'Open…', action: () => hostCommand('openFile') },
      { label: 'Save', shortcut: 'Ctrl+S', action: () => editorContext.ui!.save() },
      { sep: true },
      { label: 'Build & View PDF', shortcut: 'Ctrl+R', action: () => build() },
      { label: 'LaTeX source…', action: () => hostCommand('openSource') },
      { label: 'Source control', action: () => hostCommand('scm') },
      { label: 'File history (Timeline)', action: () => hostCommand('timeline') },
      { label: 'Close', action: () => hostCommand('closeTab') },
    ] },
    editingMenus.edit,
    editorViewMenu({ combined, setCombined, marginMode, toggleMargin, run, showRuler, setShowRuler, tbMode, setToolbar, textWidth, setTextWidth, stepTextWidth,
      hostItems: [
        { label: 'LaTeX source beside the document (raw view)', shortcut: 'Ctrl+Alt+S', action: () => setViewMode(mode => mode === 'wysiwyg' ? 'split' : 'wysiwyg') },
        { label: 'Outline', shortcut: 'Ctrl+Alt+O', action: () => setShowOutline(s => !s) },
        { label: 'PDF preview', action: () => vscode.postMessage({ type: 'openPdfPanel' }) },
        { label: 'Comments', checked: showComments, action: () => setShowComments(v => !v) },
        { label: 'Draw in the margins', checked: inkMode, action: () => setInkMode(v => !v) },
        { sep: true },
      ],
      themeItems: [{ label: 'Color theme…', action: () => hostCommand('theme') }], hostToolbars: [],
    }),
    editingMenus.insert,
    { title: 'Navigate', items: [
      { label: 'Back', action: () => hostCommand('back') }, { label: 'Forward', action: () => hostCommand('forward') },
      { label: 'Go to label…', action: () => { const name = prompt('Label:'); if (name) editorContext.gotoLabel!(name, view!); } },
      { label: 'Sync to PDF (forward search)', shortcut: 'Ctrl+Alt+J', action: () => { void syncToPdf(); } },
      { label: 'Beginning of document', action: () => { if (view) { view.dispatch(view.state.tr.setSelection(TextSelection.atStart(view.state.doc)).scrollIntoView()); view.focus(); } } },
      { label: 'End of document', action: () => { if (view) { view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)).scrollIntoView()); view.focus(); } } },
      { sep: true },
      ...allViews().flatMap(v => buildOutline(v.state.doc, true, activeMeta?.secnumdepth ?? 3).map(item => ({ label: `${viewDocId(v).split('/').pop()}: ${item.num ?? ''} ${item.text}`, action: () => { v.dispatch(v.state.tr.setSelection(TextSelection.near(v.state.doc.resolve(item.pos))).scrollIntoView()); v.focus(); } }))),
    ] },
    editingMenus.document,
    { title: 'Tools', items: [
      { label: 'Spell checking', checked: prefs.spellcheck, action: () => setPref('spellcheck', !prefs.spellcheck) },
      { label: 'Autocorrect typos', checked: prefs.autoCorrect, action: () => setPref('autoCorrect', !prefs.autoCorrect) },
      { label: 'Settings…', action: () => setDialog({ name: 'preferences' }) },
    ] },
    { title: 'Help', search: true, items: [
      { label: PALETTE_LABEL, shortcut: 'Ctrl+Alt+Shift+P', action: openPalette },
      { label: 'Keyboard shortcuts', action: () => setDialog({ name: 'help' }) },
    ] },
  ];
  const helpSearchEntries = HELP_ROWS.map(([shortcut, label]) => ({ id: 'Keyboard shortcuts ▸ ' + label, label, path: ['Keyboard shortcuts'], shortcut, fixed: true, action: () => setDialog({ name: 'help' }) }));

  /* ---------------------------------------------------------------- dialogs */
  const insetDialogNode = () => {
    if (!view) return null;
    const pos = typeof dialog?.arg === 'number' ? dialog.arg : undefined;
    if (pos !== undefined) { const n = view.state.doc.nodeAt(pos); return n ? { node: n, pos } : null; }
    return C.nearestNode(view.state, ['inset', 'command', 'graphics', 'leaf', 'table']);
  };
  const layouts = meta?.layouts ?? STANDARD_LAYOUTS;

  const renderDialog = () => {
    if (!dialog || !view) return null;
    const close = () => { setDialog(null); view.focus(); };
    const targetId = viewDocId(view);
    const targetMeta = targetId === docId ? meta : relatedRefs.current.get(targetId)!.meta;
    const project = projectOfDoc(targetId);
    const docDir = view.dom.dataset.docDir ?? editorContext.docDir;
    switch (dialog.name) {
      case 'preferences': return <SettingsPanel ai={null} user={editorContext.user!} sections={['editor']} onClose={close} />;
      case 'help': return <HelpDialog onClose={close} />;
      case 'stats': return <StatsDialog view={view} onClose={close} />;
      case 'graphics': return <GraphicsDialog meta={targetMeta} project={project} docDir={docDir} onClose={close} onInsert={(f: string, o: any) => run(C.insertGraphics(f, o))} />;
      case 'paragraph': {
        const cur = C.currentParagraph(view.state);
        if (!cur) { setDialog(null); return null; }
        const a = cur.node.attrs;
        return <ParagraphDialog initial={{ align: a.align ?? null, spacing: a.spacing ?? null, noindent: !!a.noindent, labelwidthstring: a.labelwidthstring ?? null }} indentSeparation={!headerLines.some(l => l === '\\paragraph_separation skip')} onClose={close} onApply={(p: any) => run(C.setParagraphAttrs({ ...p }))} />;
      }
      case 'tablesettings': {
        const ctx = C.tableContext(view.state);
        if (!ctx) { setDialog(null); notify('The cursor is not in a table'); return null; }
        const m = (json: string) => new Map<string, string>((() => { try { return JSON.parse(json || '[]'); } catch { return []; } })());
        const columns: [string, string][][] = (() => { try { return JSON.parse(ctx.table.attrs.columns || '[]'); } catch { return []; } })();
        const rowAttrs = m(ctx.row.attrs.attrs);
        for (const k of ['topline', 'bottomline']) { let all = true; ctx.row.forEach((c: any) => { if (m(c.attrs.attrs).get(k) !== 'true') all = false; }); rowAttrs.set(k, all ? 'true' : ''); }
        return <TableSettingsDialog initial={{ cell: m(ctx.cell.attrs.attrs), column: new Map(columns[ctx.colIndex] ?? []), row: rowAttrs, table: m(ctx.table.attrs.features), rowIndex: ctx.rowIndex, colIndex: ctx.colIndex, nrows: ctx.nrows, ncols: ctx.ncols }} onClose={close} onApply={(ch: any) => run(C.setTableAttrs(ch))} />;
      }
      case 'delimiters': return <DelimiterDialog onClose={close} onInsert={(latex: string) => insertInMath(latex)} />;
      case 'matrix': return <MatrixDialog onClose={close} onInsert={(latex: string) => insertInMath(latex)} />;
      case 'table': return <TableDialog onClose={close} onInsert={(r: number, c: number) => run(C.insertTable(r, c))} />;
      case 'label': {
        const arg = dialog.arg as { pos?: number; equation?: boolean; initial?: string; hasLabel?: boolean; refCount?: number; onApply?: (n: string) => void; onRemove?: () => void } | undefined;
        if (arg?.equation && arg.onApply) {
          return <LabelDialog initial={arg.initial ?? 'eq:'} editing refCount={arg.refCount ?? 0} existing={labelNames()} onClose={close}
            onInsert={(n: string) => arg.onApply!(n)} onRemove={arg.hasLabel ? () => arg.onRemove?.() : undefined} />;
        }
        if (arg?.pos !== undefined) {
          const node = view.state.doc.nodeAt(arg.pos);
          if (node && node.type.name === 'command' && node.attrs.cmd === 'label') {
            const cur = unquote(commandParams(node).get('name'));
            const lpos = arg.pos;
            return <LabelDialog initial={cur} editing refCount={refCountOf(cur)} existing={labelNames()} onClose={close}
              onInsert={(n: string) => { if (n !== cur) { C.setLabelName(view, lpos, n); C.renameLabelRefs(view, cur, n); } }}
              onRemove={() => C.deleteLabelAt(view, lpos)} />;
          }
        }
        return <LabelDialog initial={suggestLabel(view)} existing={labelNames()} onClose={close} onInsert={(n: string) => run(C.insertLabel(n))} />;
      }
      case 'ref': {
        const target = dialog.arg as { pos?: number; node?: any; prefill?: string } | undefined;
        if (target?.node && target.pos !== undefined) {
          const p = commandParams(target.node);
          const tpos = target.pos, tnode = target.node;
          return <RefDialog view={view} labels={labels} useRefstyle={!!meta?.useRefstyle} initial={{ name: unquote(p.get('reference')), kind: unquote(p.get('package')) === 'cleveref' ? 'cref' : p.get('LatexCommand') ?? 'ref', tuple: unquote(p.get('tuple')) === 'range' ? 'range' : 'list', caps: unquote(p.get('caps')) === 'true' }} onClose={close}
            onInsert={(n, k, o) => view.dispatch(referenceTransaction(view.state, n, k, o, tpos))} />;
        }
        return <RefDialog view={view} labels={labels} useRefstyle={!!meta?.useRefstyle} initial={target?.prefill ? { name: target.prefill, kind: 'ref' } : undefined} onClose={close} onInsert={(n, k, o) => view.dispatch(referenceTransaction(view.state, n, k, o))} />;
      }
      case 'cite': {
        const target = dialog.arg as { pos: number; node: any } | undefined;
        if (target?.node) {
          const p = commandParams(target.node);
          return <CiteDialog meta={targetMeta} docId={targetId} project={undefined} onAdded={() => {}} initial={{ keys: unquote(p.get('key')).split(',').map(k => k.trim()).filter(Boolean), cmd: p.get('LatexCommand') ?? 'cite', before: unquote(p.get('before')), after: unquote(p.get('after')) }} onClose={close}
            onInsert={(keys: string[], cmd: string, b: string, a: string) => { const params = [`LatexCommand ${cmd}`]; if (a) params.push(`after "${a}"`); if (b) params.push(`before "${b}"`); params.push(`key "${keys.join(',')}"`, 'literal "false"', ''); view.dispatch(view.state.tr.setNodeMarkup(target.pos, undefined, { ...target.node.attrs, params: JSON.stringify(params) })); }} />;
        }
        return <CiteDialog meta={targetMeta} docId={targetId} project={undefined} onClose={close} onAdded={() => {}} onInsert={(keys: string[], cmd: string, b: string, a: string) => { run(C.insertCite(keys, cmd, b, a)); }} />;
      }
      case 'href': return <HrefDialog onClose={close} onInsert={(t: string, n: string) => run(C.insertHref(t, n))} />;
      case 'settings': return <SettingsDialog docId={targetId} meta={targetMeta} headerLines={docHeaders(targetId)} onClose={close} onSaved={() => api.meta(targetId).then(m => { updateMeta(targetId, m); refreshMacros(view, m.macros); void api.header(targetId).then(h => updateHeader(targetId, h.headerLines)); })} />;
      case 'macros': return <MacrosDialog meta={targetMeta} onClose={close} />;
      case 'tex': return <TexDialog tex={String(dialog.arg ?? '')} onClose={close} />;
      case 'layout': return <LayoutPicker layouts={layouts} onClose={close} onPick={(n: string) => run(C.setLayout(n))} />;
      case 'argument': { run(C.insertArgument(String(dialog.arg ?? '1'))); setDialog(null); return null; }
      case 'inset': {
        const target = insetDialogNode();
        if (!target) { setDialog(null); notify('No inset at the cursor'); return null; }
        if (target.node.type.name === 'graphics') {
          const params: string[] = (() => { try { return JSON.parse(target.node.attrs.params || '[]'); } catch { return []; } })();
          return <GraphicsDialog meta={targetMeta} project={project} docDir={docDir} initial={C.graphicsOpts(params)} onClose={close}
            onInsert={(f: string, o: any) => view.dispatch(view.state.tr.setNodeMarkup(target.pos, undefined, { ...target.node.attrs, params: JSON.stringify(C.graphicsParams(f, o)) }))} />;
        }
        if (target.node.type.name === 'command' && target.node.attrs.cmd === 'href') {
          const p = commandParams(target.node);
          return <HrefDialog initial={{ target: unquote(p.get('target')), name: unquote(p.get('name')) }} onClose={close} onInsert={(t: string, n: string) => view.dispatch(view.state.tr.setNodeMarkup(target.pos, undefined, { ...target.node.attrs, params: JSON.stringify(['LatexCommand href', `name "${n}"`, `target "${t}"`, 'literal "false"', '']) }))} />;
        }
        if (target.node.type.name === 'command' && target.node.attrs.cmd === 'label') { setDialog({ name: 'label', arg: { pos: target.pos } }); return null; }
        if (target.node.type.name === 'table') { setDialog({ name: 'tablesettings' }); return null; }
        return <InsetDialog node={target.node} onClose={close} onApply={(attrs: any) => view.dispatch(view.state.tr.setNodeMarkup(target.pos, undefined, { ...target.node.attrs, ...attrs }))} />;
      }
      default: return null;
    }
  };

  /* ---------------------------------------------------------------- render */
  const status: Status = { connected: true, synced: true, users: [] };
  const st = view && findOpen ? findKey.getState(view.state) : undefined;
  const requery = (patch: Record<string, unknown>, useSelection?: boolean) => {
    if (!view) return;
    setQuery(view, { query: findQ, caseSensitive: findCase, wholeWord: findWord, regex: findRegex, searchMath: findMath, selectionOnly: findSel, ...patch, ...(useSelection !== undefined ? { useSelection } : {}) } as any);
  };

  return (
    <div class="app" data-vscode="1">
      <MenuBar menus={menus} showThemeToggle={false} paletteShortcut="Ctrl+Alt+Shift+P" captureF1={false} searchEntries={helpSearchEntries} />
      <div class="editor-topbar"><strong title={docId}>{docId.split('/').pop()}</strong>
        <span class="topbar-right">
          <ThemeToggle dark={shownDark} onClick={cycleTheme} title={`${shownDark ? 'Dark' : 'Light'} theme${themePref === 'system' ? " (following VS Code's)" : ''} — click for ${themePref === 'system' ? (shownDark ? 'light' : 'dark') : themePref === 'light' ? 'dark' : "VS Code's theme"}`} />
          <ViewModeSwitch mode={viewMode} onChange={setViewMode} />
        </span>
      </div>
      {tbMode('standard') !== 'off' && <Toolbar id="standard" layouts={layouts} layout={layout} onLayout={(n: string) => run(C.setLayout(n))} groups={tb.standard} />}
      {(tbMode('viewupdate') !== 'off' || tbMode('extra') !== 'off') && (
        <div class="tb-samerow">
          {tbMode('viewupdate') !== 'off' && <Toolbar id="viewupdate" groups={tb.viewUpdate} />}
          {tbMode('extra') !== 'off' && <Toolbar id="extra" groups={tb.extra} />}
        </div>
      )}
      {meta && meta.health.length > 0 && (
        <div class="health-bar">
          <span class="health-icon">⚠</span>
          <span>{meta.health.length === 1 ? '1 structural issue' : `${meta.health.length} structural issues`} found in this file: {meta.health.map(h => h.message).join(' ')}</span>
        </div>
      )}
      {findOpen && (
        <div class="find-bar-wrap">
          <div class="find-bar">
            <span>Find:</span><input autofocus value={findQ} onInput={e => { const v = (e.target as HTMLInputElement).value; setFindQ(v); requery({ query: v }); }} onKeyDown={e => { if (e.key === 'Enter' && view) findNext(view, e.shiftKey ? -1 : 1); if (e.key === 'Escape') { setFindOpen(false); if (view) { setQuery(view, { query: '' }); view.focus(); } } }} />
            <label title="Case sensitive"><input type="checkbox" checked={findCase} onChange={e => { const v = (e.target as HTMLInputElement).checked; setFindCase(v); requery({ caseSensitive: v }); }} /> Aa</label>
            <label title="Whole words only"><input type="checkbox" checked={findWord} onChange={e => { const v = (e.target as HTMLInputElement).checked; setFindWord(v); requery({ wholeWord: v }); }} /> Word</label>
            <button class="small-btn" onClick={() => view && findNext(view, 1)}>Next</button>
            <button class="small-btn" onClick={() => view && findNext(view, -1)}>Prev</button>
            <span>Replace:</span><input value={replQ} onInput={e => setReplQ((e.target as HTMLInputElement).value)} />
            <button class="small-btn" onClick={() => view && replaceCurrent(view, replQ)}>Replace</button>
            <button class="small-btn" onClick={() => { if (view) notify(`Replaced ${replaceAll(view, replQ)} occurrence(s)`); }}>Replace all</button>
            <span style="color:#666">{st ? (st.error ? 'regex error' : `${st.matches.length} matches`) : ''}</span>
            <button class={'small-btn' + (findAdv ? ' active' : '')} title="Advanced options" onClick={() => setFindAdv(a => !a)}>Advanced ▾</button>
            <span style="flex:1" /><button class="small-btn" onClick={() => { setFindOpen(false); if (view) { setQuery(view, { query: '' }); view.focus(); } }}>✕</button>
          </div>
          {findAdv && (
            <div class="find-bar find-bar-adv">
              <label title="Treat the search text as a regular expression"><input type="checkbox" checked={findRegex} onChange={e => { const v = (e.target as HTMLInputElement).checked; setFindRegex(v); requery({ regex: v }); }} /> Regular expression</label>
              <label title="Also search inside math formulas"><input type="checkbox" checked={findMath} onChange={e => { const v = (e.target as HTMLInputElement).checked; setFindMath(v); requery({ searchMath: v }); }} /> Search math</label>
              <label title="Only search the current selection"><input type="checkbox" checked={findSel} onChange={e => { const v = (e.target as HTMLInputElement).checked; setFindSel(v); requery({ selectionOnly: v }, v); }} /> In selection</label>
              {st?.error && <span class="find-error">{st.error}</span>}
            </div>
          )}
        </div>
      )}
      <div class="main">
        {showOutline && (
          <div class="sidebar left outline-panel">
            <div class="panel-tabs">
              <button class="active" data-tab="outline">Outline</button>
              <button class="hide" title="Hide the outline" onClick={() => setShowOutline(false)}>«</button>
            </div>
            <div class="panel-body"><Outline view={view} items={outline} activePos={activePos} /></div>
          </div>
        )}
        {showOutline && <SidebarGrip side="left" />}
        <div class={'editor-column view-' + viewMode + (viewMode === 'wysiwyg' ? '' : ' split')}>
          {showRuler && <Ruler width={textWidth} onChange={setTextWidth} marginMode={marginMode} noteScale={noteScale} onNoteScale={setNoteScale} />}
          <div class={'editor-scroll' + (marginMode ? ' margin-mode' : '') + (inkMode ? ' ink-mode' : '')} ref={scrollRef} onClick={e => { if (e.target === e.currentTarget && view) view.focus(); }}>
            <div class="editor-page">
              {visibleIds.map(id => id === docId ? <div key={id}>
                {combined && <div class="child-doc-header"><span class="name">{id.split('/').pop()}</span><button class="small-btn" onClick={() => setCombined(false)}>Show this document only</button></div>}
                <div class="editor-host" ref={containerRef} />
              </div> : <RelatedEditor key={id} id={id} marginMode={marginMode} register={registerRelated}
                onSelection={onSelection} onDocChange={() => setDocTick(t => t + 1)} />)}
            </div>
          </div>
          {viewMode !== 'wysiwyg' && <SourcePane target={sourceTarget} tick={docTick} selTick={selTick} mathField={mathField} onNotify={notify} onClose={() => setViewMode('wysiwyg')} onSave={() => vscode.postMessage({ type: 'save' })} />}
        </div>
        {showComments && (
          <div class="sidebar right">
            <div class="panel-tabs">
              <button class="active" data-tab="comments">Comments</button>
              <button class="hide" title="Hide the sidebar" onClick={() => setShowComments(false)}>»</button>
            </div>
            <div class="panel-body"><Comments views={allViews()} tick={docTick} /></div>
          </div>
        )}
      </div>
      {(tb.showMath || tb.showTable || tb.showReview || inkMode) && (
        <div class="bottom-toolbars" style={{ left: showOutline ? 'var(--left-width, 220px)' : '24px', right: showComments ? 'var(--right-width, 360px)' : '24px' }}>
          {tb.showMath && <Toolbar id="math" label="Math" groups={tb.math} />}
          {tb.showMath && tbMode('mathpanels') !== 'off' && <Toolbar id="mathpanels" label="Panels" groups={tb.mathPanels} />}
          {tb.showTable && <Toolbar id="table" label="Table" groups={tb.table} />}
          {tb.showReview && <Toolbar id="review" label="Review" groups={tb.review} />}
          {inkMode && <Toolbar id="ink" label="Draw" groups={inkGroups} />}
        </div>
      )}
      <StatusBar layout={layout} status={status} chord={chord} message={message} save={{ state: 'saved', pending: false, savedAt: 0, unavailable: false }}
        tracking={tracking} trackingAs="You" change={changeInfo} stats={docStats} zoom={zoom} onZoom={setZoom} />
      {renderDialog()}
    </div>
  );
}
