/**
 * The OverLyX editor inside VS Code: the web client's Workspace (App.tsx) trimmed to the editor
 * itself — LyX toolbars, find & replace, contextual math/table/review rows, comments margin and
 * panel, dialogs, status bar. File browsing, git, versions and agents stay on the VS Code side;
 * the PDF lives in its own panel (pdfMain.tsx). Document sync with the extension host runs over
 * postMessage (full ProseMirror doc, debounced), everything else over the local HTTP bridge.
 */
import { referenceTransaction } from '@client/editor/references';
import { useEffect, useMemo, useRef, useState, useCallback } from 'preact/hooks';
import type { EditorView } from 'prosemirror-view';
import { TextSelection } from 'prosemirror-state';
import { G, vscode, applyTheme } from './globals';
import type { HostToEditor, OutlineEntry } from '../shared/protocol';
import { api, type AiStatus, type DocMeta } from '@client/api';
import { getPrefs, subscribePrefs, type Prefs } from '@client/prefs';
import { Toolbar } from '@client/app/Toolbar';
import { buildToolbars, loadToolbarPrefs, mathExecutor, useMathPanels, toolbarClipboard, type ToolbarId, type ToolbarMode, type ToolbarPrefs } from '@client/app/toolbars';
import { debounce, hashAuthor, applyAuthorColors, bcp47, suggestLabel, LayoutPicker, documentStats } from '@client/app/shellutil';
import { buildOutline } from '@client/app/Outline';
import { Comments } from '@client/app/Comments';
import { StatusBar, type Status } from '@client/app/StatusBar';
import { SourcePane, cursorLine, docBlocks, blockPos } from '@client/app/SourcePane';
import { Ruler, DEFAULT_WIDTH, MIN_WIDTH, MAX_WIDTH } from '@client/app/Ruler';
import { ViewModeSwitch, type ViewMode } from '@client/app/ViewModeSwitch';
import { locateSourceLine } from '@client/app/sourcelocate';
import { activeMathField, mathFocusListeners, mathCursorListeners, type LyxMathField } from '@client/editor/lyxmath/field';
import {
  Dialog as OlDialog, GraphicsDialog, TableDialog, LabelDialog, RefDialog, CiteDialog, HrefDialog, SettingsDialog, InsetDialog,
  TexDialog, MacrosDialog, ParagraphDialog, TableSettingsDialog, DelimiterDialog, MatrixDialog, commandParams,
} from '@client/app/Dialogs';
import { createLocalEditor, type LocalEditorHandle } from './localEditor';
import { refreshMacros } from '@client/editor/macrodefs';
import { editorContext, viewDocId } from '@client/editor/context';
import { STANDARD_LAYOUTS } from '@client/editor/layouts';
import { chordKey } from '@client/editor/keymap';
import * as C from '@client/editor/commands';
import { setMarginMode } from '@client/editor/plugins/margin';
import { acceptAllChanges, rejectAllChanges, changeAt } from '@client/editor/plugins/changes';
import { setQuery, findNext, replaceCurrent, replaceAll, findKey } from '@client/editor/plugins/find';
import { unquote } from '@overlyx/core';
import { describeChange } from '@client/editor/assembly';

type DialogState = { name: string; arg?: unknown } | null;

const stored = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };

type ChildItem = { id: string; pmDoc?: unknown; headerLines?: string[] };

/**
 * A child document of the combined view: its own local editor below the master, its edits written
 * into its own TextDocument by the host (childUpdate), changes from elsewhere applied as a diff.
 */
function ChildDoc({ item, marginMode, onSelection, register }: { item: ChildItem; marginMode: boolean; onSelection: (v: EditorView) => void; register: (id: string, h: LocalEditorHandle | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const headerRef = useRef<string[]>(item.headerLines ?? []);
  if (item.headerLines) headerRef.current = item.headerLines;
  useEffect(() => {
    const el = ref.current;
    if (!el || !item.pmDoc) return;
    el.innerHTML = '';
    const post = debounce((v: EditorView) => { if (!v.isDestroyed) vscode.postMessage({ type: 'childUpdate', id: item.id, pmDoc: v.state.doc.toJSON(), headerLines: headerRef.current }); }, 300);
    const handle = createLocalEditor({ docId: item.id, container: el, pmDoc: item.pmDoc, marginMode, onSelectionChange: onSelection, onDocChange: (v, info) => { if (!info.external) post(v); } });
    refreshMacros(handle.view, editorContext.meta?.macros ?? {}, true);
    register(item.id, handle);
    return () => { register(item.id, null); handle.destroy(); };
  }, [item.id, !!item.pmDoc]);
  return (
    <div class="child-doc">
      <div class="child-doc-header">
        <span class="name">📄 {item.id.split('/').pop()}</span>
        <span class="path">{item.id}</span>
        <span style="flex:1" />
        <span class="sync">{item.pmDoc ? 'in this view' : 'loading…'}</span>
        <button class="small-btn" title="Open this child document in its own editor tab" onClick={() => vscode.postMessage({ type: 'openDoc', id: item.id })}>Open in tab</button>
      </div>
      <div class="editor-host child" ref={ref} />
    </div>
  );
}

export function EditorShell({ init }: { init: Extract<HostToEditor, { type: 'init' }> }) {
  const docId = init.docId;
  const [meta, setMeta] = useState<DocMeta | null>(null);
  const [headerLines, setHeaderLines] = useState<string[]>(init.headerLines);
  const headerRef = useRef(init.headerLines);
  const setHeader = (lines: string[]) => { headerRef.current = lines; setHeaderLines(lines); };
  const [layout, setLayout] = useState('Standard');
  const [dialog, setDialog] = useState<DialogState>(null);
  const [message, setMessage] = useState<{ text: string; kind: 'info' | 'error' } | null>(null);
  const [marginMode, setMarginModeState] = useState(stored('ol.margin') === '1');
  const [showComments, setShowComments] = useState(stored('ol.vscode.comments') === '1');
  const [tracking, setTracking] = useState(false);
  const [chord, setChord] = useState<string | null>(null);
  const [changeInfo, setChangeInfo] = useState<string | null>(null);
  const [zoom, setZoom] = useState(Number(stored('ol.zoom') || 1) || 1);
  const [viewMode, setViewMode] = useState<ViewMode>('wysiwyg');
  // light / dark: VS Code's theme unless the user picked one here (the sun / moon button; stored like the web client's ol.theme)
  const [themePref, setThemePref] = useState<'system' | 'light' | 'dark'>(() => { const v = stored('ol.theme'); return v === 'light' || v === 'dark' ? v : 'system'; });
  const hostDark = useRef(G.dark);
  const shownDark = themePref === 'system' ? hostDark.current : themePref === 'dark';
  useEffect(() => { applyTheme(shownDark); }, [shownDark]);
  const cycleTheme = () => {
    const next = themePref === 'system' ? (hostDark.current ? 'light' : 'dark') : themePref === 'light' ? 'dark' : 'system';
    setThemePref(next);
    try { if (next === 'system') localStorage.removeItem('ol.theme'); else localStorage.setItem('ol.theme', next); } catch { /* ignore */ }
  };
  /** the document as last sent to the host (or received from it): an external update equal to it is a stale echo and must not undo edits typed since */
  const lastSyncedDoc = useRef<string>(JSON.stringify(init.pmDoc));
  /** the combined view: the master's child documents editable below it (View ▸ / the include's context menu) */
  const [combined, setCombined] = useState(stored('ol.combined') === '1');
  const [children, setChildren] = useState<ChildItem[]>([]);
  const childHandles = useRef(new Map<string, LocalEditorHandle>());
  const [textWidth, setTextWidth] = useState(() => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Number(stored('ol.textWidth')) || DEFAULT_WIDTH)));
  const [findOpen, setFindOpen] = useState(false);
  const [findQ, setFindQ] = useState(''), [replQ, setReplQ] = useState('');
  const [findCase, setFindCase] = useState(false), [findWord, setFindWord] = useState(false);
  const [findRegex, setFindRegex] = useState(false), [findMath, setFindMath] = useState(false), [findSel, setFindSel] = useState(false);
  const [findAdv, setFindAdv] = useState(false);
  const [toolbars, setToolbars] = useState<ToolbarPrefs>(loadToolbarPrefs);
  const [mathField, setMathField] = useState<LyxMathField | null>(null);
  const [prefs, setPrefsState] = useState<Prefs>(getPrefs);
  const [docTick, setDocTick] = useState(0);
  const [selTick, setSelTick] = useState(0);
  const [, force] = useState(0);
  const rerender = () => force(x => x + 1);

  const handleRef = useRef<LocalEditorHandle | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** the editor the cursor is in — the master, or a child of the combined view: toolbars, menus and dialogs act on it */
  const activeView = (): EditorView | null => {
    const a = editorContext.activeView;
    if (a && !a.isDestroyed && (a === handleRef.current?.view || [...childHandles.current.values()].some(h => h.view === a))) return a;
    return handleRef.current?.view ?? null;
  };
  const view = activeView();

  const notify = useCallback((text: string, kind: 'info' | 'error' = 'info') => {
    setMessage({ text, kind });
    setTimeout(() => setMessage(m => (m?.text === text ? null : m)), 4000);
    if (kind === 'error') vscode.postMessage({ type: 'notify', text, kind });
  }, []);

  useEffect(() => { localStorage.setItem('ol.toolbars', JSON.stringify(toolbars)); }, [toolbars]);
  useEffect(() => subscribePrefs(setPrefsState), []);
  useEffect(() => { localStorage.setItem('ol.zoom', String(zoom)); }, [zoom]);
  useEffect(() => {
    document.documentElement.style.setProperty('--text-width', textWidth + 'px');
    localStorage.setItem('ol.textWidth', String(textWidth));
  }, [textWidth]);
  useEffect(() => { try { localStorage.setItem('ol.vscode.comments', showComments ? '1' : '0'); } catch { /* ignore */ } }, [showComments]);
  useEffect(() => {
    editorContext.combined = combined;
    try { localStorage.setItem('ol.combined', combined ? '1' : '0'); } catch { /* ignore */ }
    // before the master exists the init effect asks for the children itself
    if (handleRef.current) vscode.postMessage({ type: 'combined', on: combined });
    if (!combined) setChildren([]);
  }, [combined]);
  useEffect(() => { const l = (f: LyxMathField | null) => { setMathField(f); editorContext.mathField = f; }; mathFocusListeners.add(l); return () => { mathFocusListeners.delete(l); }; }, []);
  useEffect(() => { const l = () => setSelTick(t => t + 1); mathCursorListeners.add(l); return () => { mathCursorListeners.delete(l); }; }, []);

  const setToolbar = (id: ToolbarId, mode: ToolbarMode) => setToolbars(t => ({ ...t, [id]: mode }));
  const tbMode = (id: ToolbarId): ToolbarMode => toolbars[id] ?? 'auto';

  /* ---------------------------------------------------------------- editor lifecycle */
  const postUpdate = useMemo(() => debounce((v: EditorView, doc: EditorView['state']['doc']) => {
    if (v.isDestroyed || v.state.doc !== doc) return;
    const pmDoc = v.state.doc.toJSON();
    lastSyncedDoc.current = JSON.stringify(pmDoc);
    vscode.postMessage({ type: 'update', pmDoc, headerLines: headerRef.current });
  }, 300), []);
  const postOutline = useMemo(() => debounce((v: EditorView) => {
    const items: OutlineEntry[] = buildOutline(v.state.doc, true, editorContext.meta?.secnumdepth ?? 3);
    vscode.postMessage({ type: 'outline', items });
  }, 300), []);
  const postSelection = useMemo(() => debounce((v: EditorView) => {
    vscode.postMessage({ type: 'selection', pos: v.state.selection.from });
  }, 250), []);

  const onSelection = (v: EditorView) => {
    editorContext.activeView = v;
    const p = C.currentParagraph(v.state);
    setLayout(p ? p.node.attrs.layout : '');
    setChord(chordKey.getState(v.state) ?? null);
    const ch = changeAt(v.state, v.state.selection.from);
    setChangeInfo(ch ? describeChange(ch.type, ch.author, ch.time) : null);
    setSelTick(t => t + 1);
    if (v === handleRef.current?.view) postSelection(v);   // the host's outline follows the master's cursor
    rerender();
  };

  useEffect(() => {
    let cancelled = false;
    let handle: LocalEditorHandle | null = null;
    void (async () => {
      editorContext.user = { id: 1, username: 'you', name: 'You', color: '#3b6ea5', isAdmin: false };
      editorContext.docId = docId;
      editorContext.project = docId.split('/')[0];
      editorContext.docDir = docId.split('/').slice(1, -1).join('/');
      editorContext.trackChanges = false;
      editorContext.combined = combined;
      // metadata FIRST (macros, authors, layouts): formulas must render once, with the macros —
      // a \RR rendered before its definition arrives would stay raw (the web app defers the same way)
      let m: DocMeta | null = null;
      try { m = await api.meta(docId); } catch (e) { notify('Could not load document metadata: ' + (e as Error).message, 'error'); }
      if (cancelled || !containerRef.current) return;
      if (m) { setMeta(m); editorContext.meta = m; }
      handle = createLocalEditor({
        docId, container: containerRef.current, pmDoc: init.pmDoc, marginMode,
        onSelectionChange: onSelection,
        onDocChange: (v, info) => { setDocTick(t => t + 1); if (!info.external) postUpdate(v, v.state.doc); postOutline(v); },
      });
      handleRef.current = handle;
      editorContext.activeView = handle.view;
      (window as any).overlyx = editorContext;
      if (combined) vscode.postMessage({ type: 'combined', on: true });
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
    })();
    return () => { cancelled = true; handle?.destroy(); handleRef.current = null; };
  }, []);

  /* ---------------------------------------------------------------- host messages */
  const metaReload = useMemo(() => debounce(() => {
    api.meta(docId).then(m => {
      setMeta(m); editorContext.meta = m;
      const v = handleRef.current?.view;
      if (v) refreshMacros(v, m.macros ?? {});
      for (const h of childHandles.current.values()) refreshMacros(h.view, m.macros ?? {}, true);   // children inherit the master's macros
    }).catch(() => {});
  }, 1500), []);

  useEffect(() => {
    const onMsg = (ev: MessageEvent<HostToEditor>) => {
      const m = ev.data;
      if (!m) return;
      // the combined view's children do not depend on the master's editor
      if (m.type === 'children') { setChildren(prev => m.items.map(it => (it.pmDoc ? it : prev.find(p => p.id === it.id) ?? it))); return; }
      if (m.type === 'childExternalUpdate') {
        childHandles.current.get(m.id)?.applyExternal(m.pmDoc);
        setChildren(prev => prev.map(c => (c.id === m.id ? { ...c, headerLines: m.headerLines } : c)));
        metaReload();
        return;
      }
      const v = handleRef.current?.view;
      if (!v) return;
      switch (m.type) {
        case 'metadataChanged': metaReload(); break;
        case 'externalUpdate': {
          // the host re-parsed the file: skip when it merely echoes what this editor already has
          // (VS Code touched our own write on save, or the parse arrived while newer edits were still
          // debounced here) — applying it would make deleted text pop back
          const incoming = JSON.stringify(m.pmDoc);
          if (incoming === lastSyncedDoc.current) break;
          lastSyncedDoc.current = incoming;
          handleRef.current!.applyExternal(m.pmDoc);
          setHeader(m.headerLines);
          metaReload();
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
        case 'theme': hostDark.current = m.dark; if (themePref === 'system') applyTheme(m.dark); break;
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  });

  /* ---------------------------------------------------------------- commands and helpers */
  const run = (cmd: (state: any, dispatch: any, view?: any) => boolean) => { const v = activeView(); if (!v) return; cmd(v.state, v.dispatch, v); v.focus(); };
  const runView = (fn: (v: EditorView) => boolean) => { const v = activeView(); if (!v) return; fn(v); };

  const build = () => { vscode.postMessage({ type: 'build' }); notify('Building the PDF…'); };

  const builtTex = async (): Promise<string | null> => {
    try { const r = await api.build(docId, true); return r.build?.tex ?? null; } catch { return null; }
  };
  const syncToPdf = async () => {
    const v = handleRef.current?.view;
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
    const v = handleRef.current?.view;
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
    const v = handleRef.current?.view;
    setMarginModeState(on => {
      const next = !on;
      localStorage.setItem('ol.margin', next ? '1' : '0');
      if (v) setMarginMode(v, next);
      for (const h of childHandles.current.values()) setMarginMode(h.view, next);
      return next;
    });
  };

  const toggleTracking = async () => {
    const next = !editorContext.trackChanges;
    try {
      if (next && editorContext.changeAuthorId === undefined) {
        const id = hashAuthor('You');
        const lines = [...headerRef.current];
        const idx = lines.findIndex(l => l.startsWith('\\author '));
        const line = `\\author ${id} "You" ""`;
        if (idx >= 0) lines.splice(idx, 0, line); else lines.push(line);
        const r = await api.setHeader(docId, { headerLines: lines, set: { tracking_changes: 'true' } });
        setHeader(r.headerLines);
        editorContext.changeAuthorId = id;
        setMeta(m => (m ? { ...m, authors: [...m.authors, { id, name: 'You' }] } : m));
      } else {
        const r = await api.setHeader(docId, { set: { tracking_changes: String(next) } });
        setHeader(r.headerLines);
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
    editorContext.openInsetDialog = (_v, pos) => { if (pos !== undefined) setDialog({ name: 'inset', arg: pos }); };
    editorContext.openInTab = (id, opts) => vscode.postMessage({ type: 'openDoc', id, goto: opts?.goto, heading: opts?.heading });
    editorContext.gotoLabel = (name, from) => {
      const v = from ?? handleRef.current?.view;
      for (const cv of [v, ...[...childHandles.current.values()].map(h => h.view)]) if (cv && gotoLabelIn(cv, name)) return;
      const l = editorContext.meta?.labels.find(x => x.name === name);
      if (l?.file && editorContext.project) { vscode.postMessage({ type: 'openDoc', id: `${editorContext.project}/${l.file}`, goto: name }); return; }
      notify(`Label “${name}” not found`, 'error');
    };
    editorContext.ui = {
      save: () => {
        // flush the debounced update first, then let VS Code write the file (ordered messages)
        const v = handleRef.current?.view;
        if (v) { const pmDoc = v.state.doc.toJSON(); lastSyncedDoc.current = JSON.stringify(pmDoc); vscode.postMessage({ type: 'update', pmDoc, headerLines: headerRef.current }); }
        for (const c of children) { const h = childHandles.current.get(c.id); if (h) vscode.postMessage({ type: 'childUpdate', id: c.id, pmDoc: h.view.state.doc.toJSON(), headerLines: c.headerLines ?? [] }); }
        vscode.postMessage({ type: 'save' });
      },
      viewPdf: () => build(),
      updatePdf: () => build(),
      syncToPdf: () => { void syncToPdf(); },
      find: () => setFindOpen(true),
      openDialog: (name, arg) => setDialog({ name, arg }),
      toggleTrackChanges: () => { void toggleTracking(); },
      toggleOutline: () => notify('The outline is in the OverLyX sidebar (activity bar)'),
      toggleSource: () => setViewMode(mode => mode === 'wysiwyg' ? 'split' : 'wysiwyg'),
      toggleCombined: () => setCombined(c => !c),
      acceptAll: () => run(acceptAllChanges()),
      rejectAll: () => run(rejectAllChanges()),
      closeTab: () => { /* VS Code closes tabs */ },
      zoom: (d) => setZoom(z => (d === 0 ? 1 : Math.min(2.5, Math.max(0.5, +(z + d * 0.1).toFixed(2))))),
      textWidth: (width) => setTextWidth(width > 0 ? width : DEFAULT_WIDTH),
      openFile: () => notify('Use the VS Code explorer to open files'),
      newFile: () => notify('Create .tex files in the VS Code explorer'),
    };
  });

  /** what the source pane shows: the child the cursor is in, else the master */
  const sourceTarget = (() => {
    if (!view || !handleRef.current) return null;
    for (const [id, h] of childHandles.current) if (h.view === view) return { view, ydoc: h.ydoc, docId: id };
    return { view: handleRef.current.view, ydoc: handleRef.current.ydoc, docId };
  })();

  /* ---------------------------------------------------------------- labels, marks, table state */
  const labels = useMemo(() => {
    const v = handleRef.current?.view;
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
    const v = handleRef.current?.view;
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

  const mathExec = mathExecutor(() => handleRef.current?.view);
  const insertInMath = (latex: string) => {
    const active = activeMathField();
    if (active) { active.execute('insert', latex); return; }
    const v = handleRef.current?.view;
    if (v) { C.insertMath(false)(v); setTimeout(() => activeMathField()?.execute('insert', latex), 60); }
  };
  const mathPanels = useMathPanels(mathExec);
  const clipboard = toolbarClipboard(() => handleRef.current?.view, notify);
  const docStats = useMemo(() => (view ? documentStats(view) : null), [view, docTick, selTick]);
  // The LyX toolbars (@client/app/toolbars — one definition with the web client); only the comments
  // panel button is this shell's own (files, outline and git are VS Code's).
  const tb = buildToolbars({
    view, docId, meta, headerLines, prefs, layout, mathField, tracking, marginMode, tbMode, setToolbar,
    run, runView, mathExec, mathPanels, clipboard, setDialog, openFind: () => setFindOpen(true), notify,
    toggleTracking: () => { void toggleTracking(); }, toggleMargin,
    build, syncToPdf: () => { void syncToPdf(); }, onHeaderLines: setHeader,
    slots: {
      tools: [{ id: 'comments-panel', title: 'Comments panel', icon: 'comment', action: () => setShowComments(s => !s), active: showComments }],
    },
  });

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
    const project = docId.split('/')[0];
    const docDir = view.dom.dataset.docDir ?? editorContext.docDir;
    switch (dialog.name) {
      case 'graphics': return <GraphicsDialog meta={meta} project={project} docDir={docDir} onClose={close} onInsert={(f: string, o: any) => run(C.insertGraphics(f, o))} />;
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
          return <CiteDialog meta={meta} docId={docId} project={undefined} onAdded={() => {}} initial={{ keys: unquote(p.get('key')).split(',').map(k => k.trim()).filter(Boolean), cmd: p.get('LatexCommand') ?? 'cite', before: unquote(p.get('before')), after: unquote(p.get('after')) }} onClose={close}
            onInsert={(keys: string[], cmd: string, b: string, a: string) => { const params = [`LatexCommand ${cmd}`]; if (a) params.push(`after "${a}"`); if (b) params.push(`before "${b}"`); params.push(`key "${keys.join(',')}"`, 'literal "false"', ''); view.dispatch(view.state.tr.setNodeMarkup(target.pos, undefined, { ...target.node.attrs, params: JSON.stringify(params) })); }} />;
        }
        return <CiteDialog meta={meta} docId={docId} project={undefined} onClose={close} onAdded={() => {}} onInsert={(keys: string[], cmd: string, b: string, a: string) => { run(C.insertCite(keys, cmd, b, a)); }} />;
      }
      case 'href': return <HrefDialog onClose={close} onInsert={(t: string, n: string) => run(C.insertHref(t, n))} />;
      case 'settings': return <SettingsDialog docId={docId} meta={meta} headerLines={headerLines} onClose={close} onSaved={() => api.meta(docId).then(m => { setMeta(m); editorContext.meta = m; const v = handleRef.current?.view; if (v) refreshMacros(v, m.macros); void api.header(docId).then(h => setHeader(h.headerLines)); })} />;
      case 'macros': return <MacrosDialog meta={meta} onClose={close} />;
      case 'tex': return <TexDialog tex={String(dialog.arg ?? '')} onClose={close} />;
      case 'layout': return <LayoutPicker layouts={layouts} onClose={close} onPick={(n: string) => run(C.setLayout(n))} />;
      case 'argument': { run(C.insertArgument(String(dialog.arg ?? '1'))); setDialog(null); return null; }
      case 'inset': {
        const target = insetDialogNode();
        if (!target) { setDialog(null); notify('No inset at the cursor'); return null; }
        if (target.node.type.name === 'graphics') {
          const params: string[] = (() => { try { return JSON.parse(target.node.attrs.params || '[]'); } catch { return []; } })();
          return <GraphicsDialog meta={meta} project={project} docDir={docDir} initial={C.graphicsOpts(params)} onClose={close}
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
      <div class="editor-topbar"><strong title={docId}>{docId.split('/').pop()}</strong>
        <span class="topbar-right">
          <button type="button" class="theme-toggle" data-theme-toggle data-current={shownDark ? 'dark' : 'light'} onClick={cycleTheme}
            title={`${shownDark ? 'Dark' : 'Light'} theme${themePref === 'system' ? " (following VS Code's)" : ''} — click for ${themePref === 'system' ? (shownDark ? 'light' : 'dark') : themePref === 'light' ? 'dark' : "VS Code's theme"}`}>
            {shownDark
              ? <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2" /><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8" /></svg>
              : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z" /></svg>}
          </button>
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
        <div class={'editor-column view-' + viewMode + (viewMode === 'wysiwyg' ? '' : ' split')}>
          <div class={'editor-scroll' + (marginMode ? ' margin-mode' : '')} ref={scrollRef} style={{ zoom }} onClick={e => { if (e.target === e.currentTarget && view) view.focus(); }}>
            <Ruler width={textWidth} onChange={setTextWidth} marginMode={marginMode} />
            <div class="editor-page">
              <div class="editor-host" ref={containerRef} />
              {combined && children.map(c => (
                <ChildDoc key={c.id} item={c} marginMode={marginMode} onSelection={onSelection}
                  register={(id, h) => { if (h) childHandles.current.set(id, h); else childHandles.current.delete(id); rerender(); }} />
              ))}
            </div>
          </div>
          <SourcePane target={sourceTarget} tick={docTick} selTick={selTick} mathField={mathField} onNotify={notify} onClose={() => setViewMode('wysiwyg')} onSave={() => vscode.postMessage({ type: 'save' })} />
        </div>
        {showComments && (
          <div class="sidebar right">
            <div class="panel-tabs">
              <button class="active" data-tab="comments">Comments</button>
              <button class="hide" title="Hide the sidebar" onClick={() => setShowComments(false)}>»</button>
            </div>
            <div class="panel-body"><Comments views={[handleRef.current?.view, ...[...childHandles.current.values()].map(h => h.view)].filter((x): x is EditorView => !!x)} tick={docTick} /></div>
          </div>
        )}
      </div>
      {(tb.showMath || tb.showTable || tb.showReview) && (
        <div class="bottom-toolbars" style={{ left: '24px', right: showComments ? 'var(--right-width, 360px)' : '24px' }}>
          {tb.showMath && <Toolbar id="math" label="Math" groups={tb.math} />}
          {tb.showMath && tbMode('mathpanels') !== 'off' && <Toolbar id="mathpanels" label="Panels" groups={tb.mathPanels} />}
          {tb.showTable && <Toolbar id="table" label="Table" groups={tb.table} />}
          {tb.showReview && <Toolbar id="review" label="Review" groups={tb.review} />}
        </div>
      )}
      <StatusBar layout={layout} status={status} chord={chord} message={message} save={{ state: 'saved', pending: false, savedAt: 0, unavailable: false }}
        tracking={tracking} trackingAs="You" change={changeInfo} stats={docStats} zoom={zoom} onZoom={setZoom} />
      {renderDialog()}
    </div>
  );
}
