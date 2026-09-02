/**
 * The OverLyX editor inside VS Code: the web client's Workspace (App.tsx) trimmed to the editor
 * itself — LyX toolbars, find & replace, contextual math/table/review rows, comments margin and
 * panel, dialogs, status bar. File browsing, git, versions and agents stay on the VS Code side;
 * the PDF lives in its own panel (pdfMain.tsx). Document sync with the extension host runs over
 * postMessage (full ProseMirror doc, debounced), everything else over the local HTTP bridge.
 */
import { useEffect, useMemo, useRef, useState, useCallback } from 'preact/hooks';
import type { EditorView } from 'prosemirror-view';
import { TextSelection } from 'prosemirror-state';
import { undo, redo } from 'y-prosemirror';
import { G, vscode, applyTheme } from './globals';
import type { HostToEditor, OutlineEntry } from '../shared/protocol';
import { api, type AiStatus, type DocMeta } from '@client/api';
import { getPrefs, setPref, subscribePrefs, type Prefs } from '@client/prefs';
import { Toolbar, ColorPalette, colorIcon, DelimPalette, TableSizePicker, mathPanelPalettes, mathPreview, type ToolButton, type DelimChoice } from '@client/app/Toolbar';
import { buildOutline } from '@client/app/Outline';
import { Comments } from '@client/app/Comments';
import { StatusBar, type Status } from '@client/app/StatusBar';
import { cursorLine, docBlocks, blockPos } from '@client/app/SourcePane';
import { locateSourceLine } from '@client/app/sourcelocate';
import { activeMathField, mathFocusListeners, mathCursorListeners, type LyxMathField } from '@client/editor/lyxmath/field';
import {
  Dialog as OlDialog, GraphicsDialog, TableDialog, LabelDialog, RefDialog, CiteDialog, HrefDialog, SettingsDialog, InsetDialog,
  TexDialog, MacrosDialog, ParagraphDialog, TableSettingsDialog, DelimiterDialog, MatrixDialog, commandParams,
} from '@client/app/Dialogs';
import { createLocalEditor, type LocalEditorHandle } from './localEditor';
import { refreshMacros } from '@client/editor/editor';
import { editorContext, viewDocId } from '@client/editor/context';
import { STANDARD_LAYOUTS, sectionLevel } from '@client/editor/layouts';
import { chordKey } from '@client/editor/keymap';
import { moveSection, shiftSection } from '@client/editor/outline';
import * as C from '@client/editor/commands';
import { setMarginMode } from '@client/editor/plugins/margin';
import { acceptAllChanges, rejectAllChanges, changeAt, gotoChange, resolveSelectionChanges, hasChanges, changesFilterKey, setChangesFilter } from '@client/editor/plugins/changes';
import * as T from '@client/editor/tablecommands';
import { setQuery, findNext, replaceCurrent, replaceAll, findKey } from '@client/editor/plugins/find';
import { schema, unquote } from '@overlyx/core';
import { describeChange } from '@client/editor/editor';

type DialogState = { name: string; arg?: unknown } | null;
type ToolbarId = 'standard' | 'viewupdate' | 'extra' | 'math' | 'mathpanels' | 'table' | 'review';
type ToolbarMode = 'on' | 'off' | 'auto';
type ToolbarPrefs = Partial<Record<ToolbarId, ToolbarMode>>;

const stored = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const loadToolbarPrefs = (): ToolbarPrefs => { try { return JSON.parse(stored('ol.toolbars') ?? '{}'); } catch { return {}; } };

function debounce<T extends (...a: any[]) => void>(fn: T, ms: number): T {
  let t: ReturnType<typeof setTimeout> | null = null;
  return ((...a: any[]) => { if (t) clearTimeout(t); t = setTimeout(() => fn(...a), ms); }) as T;
}

function hashAuthor(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h | 0;
}

function applyAuthorColors(authors: { id: number; name: string }[]): void {
  const palette = ['#2e7d32', '#c62828', '#1565c0', '#6a1b9a', '#ef6c00', '#00838f', '#ad1457', '#4e342e', '#558b2f', '#283593'];
  const dark = ['#7bd88f', '#ff8a80', '#82b1ff', '#d6a2ff', '#ffb74d', '#4dd0e1', '#f48fb1', '#d7ccc8', '#c5e1a5', '#9fa8da'];
  let el = document.getElementById('ol-author-colors') as HTMLStyleElement | null;
  if (!el) { el = document.createElement('style'); el.id = 'ol-author-colors'; document.head.appendChild(el); }
  el.textContent = authors.map((a, i) => `.lyx-change[data-author="${a.id}"], .lyx-inset[data-author="${a.id}"] { --change-color: ${palette[i % palette.length]}; }\n`
    + `html[data-theme="dark"] .lyx-change[data-author="${a.id}"], html[data-theme="dark"] .lyx-inset[data-author="${a.id}"] { --change-color: ${dark[i % dark.length]}; }`).join('\n');
}

function bcp47(lyxLang: string): string {
  const t: Record<string, string> = {
    english: 'en', american: 'en-US', british: 'en-GB', german: 'de', ngerman: 'de', french: 'fr', spanish: 'es', italian: 'it',
    dutch: 'nl', portuguese: 'pt', brazilian: 'pt-BR', russian: 'ru', polish: 'pl', czech: 'cs', swedish: 'sv', danish: 'da',
    norsk: 'nb', finnish: 'fi', greek: 'el', turkish: 'tr', hungarian: 'hu', romanian: 'ro', japanese: 'ja', korean: 'ko',
    'chinese-simplified': 'zh-Hans', 'chinese-traditional': 'zh-Hant',
  };
  return t[lyxLang] ?? lyxLang.slice(0, 2);
}

function suggestLabel(view: EditorView): string {
  const p = C.currentParagraph(view.state);
  if (!p) return '';
  const layout = p.node.attrs.layout as string;
  const text = p.node.textContent.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
  const prefix = /^Section/.test(layout) ? 'sec:' : /^Subsection/.test(layout) ? 'subsec:' : /^Chapter/.test(layout) ? 'chap:' : 'sec:';
  const $from = view.state.selection.$from;
  for (let d = $from.depth; d > 0; d--) {
    const n = $from.node(d);
    if (n.type.name === 'inset' && n.attrs.name === 'Caption') {
      let ft = 'fig';
      for (let dd = d - 1; dd > 0; dd--) { const f = $from.node(dd); if (f.type.name === 'inset' && f.attrs.name === 'Float') { ft = f.attrs.arg === 'table' ? 'tab' : f.attrs.arg === 'algorithm' ? 'alg' : 'fig'; break; } }
      return `${ft}:${text || 'label'}`;
    }
  }
  return prefix + (text || 'label');
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
  const view = handleRef.current?.view ?? null;

  const notify = useCallback((text: string, kind: 'info' | 'error' = 'info') => {
    setMessage({ text, kind });
    setTimeout(() => setMessage(m => (m?.text === text ? null : m)), 4000);
    if (kind === 'error') vscode.postMessage({ type: 'notify', text, kind });
  }, []);

  useEffect(() => { localStorage.setItem('ol.toolbars', JSON.stringify(toolbars)); }, [toolbars]);
  useEffect(() => subscribePrefs(setPrefsState), []);
  useEffect(() => { localStorage.setItem('ol.zoom', String(zoom)); }, [zoom]);
  useEffect(() => { try { localStorage.setItem('ol.vscode.comments', showComments ? '1' : '0'); } catch { /* ignore */ } }, [showComments]);
  useEffect(() => { const l = (f: LyxMathField | null) => { setMathField(f); editorContext.mathField = f; }; mathFocusListeners.add(l); return () => { mathFocusListeners.delete(l); }; }, []);
  useEffect(() => { const l = () => setSelTick(t => t + 1); mathCursorListeners.add(l); return () => { mathCursorListeners.delete(l); }; }, []);

  const setToolbar = (id: ToolbarId, mode: ToolbarMode) => setToolbars(t => ({ ...t, [id]: mode }));
  const tbMode = (id: ToolbarId): ToolbarMode => toolbars[id] ?? 'auto';

  /* ---------------------------------------------------------------- editor lifecycle */
  const postUpdate = useMemo(() => debounce((v: EditorView) => {
    vscode.postMessage({ type: 'update', pmDoc: v.state.doc.toJSON(), headerLines: headerRef.current });
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
    postSelection(v);
    rerender();
  };

  useEffect(() => {
    if (!containerRef.current) return;
    editorContext.user = { id: 1, username: 'you', name: 'You', color: '#3b6ea5', isAdmin: false };
    editorContext.docId = docId;
    editorContext.project = docId.split('/')[0];
    editorContext.docDir = docId.split('/').slice(1, -1).join('/');
    editorContext.trackChanges = false;
    editorContext.combined = false;
    const handle = createLocalEditor({
      docId, container: containerRef.current, pmDoc: init.pmDoc, marginMode,
      onSelectionChange: onSelection,
      onDocChange: (v) => { setDocTick(t => t + 1); postUpdate(v); postOutline(v); },
    });
    handleRef.current = handle;
    editorContext.activeView = handle.view;
    (window as any).overlyx = editorContext;
    postOutline(handle.view);
    // metadata: macros, bibliography, labels, layouts — the editor is usable before it arrives
    const loadMeta = () => api.meta(docId).then(m => {
      setMeta(m); editorContext.meta = m;
      handle.view.dom.lang = bcp47(m.language);
      applyAuthorColors(m.authors);
      setTracking(m.trackingChanges);
      editorContext.trackChanges = m.trackingChanges;
      editorContext.changeAuthorId = m.authors.find(x => x.name === 'You')?.id;
      refreshMacros(handle.view, m.macros ?? {});
      postOutline(handle.view);
      rerender();
    }).catch(e => notify('Could not load document metadata: ' + (e as Error).message, 'error'));
    void loadMeta();
    api.aiStatus().then(s => { editorContext.ai = s; }).catch(() => { editorContext.ai = { available: false, model: '', completionModel: '' }; });
    handle.view.focus();
    return () => { handle.destroy(); handleRef.current = null; };
  }, []);

  /* ---------------------------------------------------------------- host messages */
  const metaReload = useMemo(() => debounce(() => {
    api.meta(docId).then(m => { setMeta(m); editorContext.meta = m; const v = handleRef.current?.view; if (v) refreshMacros(v, m.macros ?? {}); }).catch(() => {});
  }, 1500), []);

  useEffect(() => {
    const onMsg = (ev: MessageEvent<HostToEditor>) => {
      const m = ev.data;
      const v = handleRef.current?.view;
      if (!m || !v) return;
      switch (m.type) {
        case 'externalUpdate':
          handleRef.current!.applyExternal(m.pmDoc);
          setHeader(m.headerLines);
          metaReload();
          break;
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
          break;
        case 'inverseSync': void gotoTexLine(m.line); break;
        case 'theme': applyTheme(m.dark); break;
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  });

  /* ---------------------------------------------------------------- commands and helpers */
  const run = (cmd: (state: any, dispatch: any, view?: any) => boolean) => { const v = handleRef.current?.view; if (!v) return; cmd(v.state, v.dispatch, v); v.focus(); };
  const runView = (fn: (v: EditorView) => boolean) => { const v = handleRef.current?.view; if (!v) return; fn(v); };

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
      if (v && gotoLabelIn(v, name)) return;
      const l = editorContext.meta?.labels.find(x => x.name === name);
      if (l?.file && editorContext.project) { vscode.postMessage({ type: 'openDoc', id: `${editorContext.project}/${l.file}`, goto: name }); return; }
      notify(`Label “${name}” not found`, 'error');
    };
    editorContext.ui = {
      save: () => notify('Saved through VS Code (Ctrl+S saves the .tex file)'),
      viewPdf: () => build(),
      updatePdf: () => build(),
      syncToPdf: () => { void syncToPdf(); },
      find: () => setFindOpen(true),
      openDialog: (name, arg) => setDialog({ name, arg }),
      toggleTrackChanges: () => { void toggleTracking(); },
      toggleOutline: () => notify('The outline is in the OverLyX sidebar (activity bar)'),
      toggleSource: () => notify('Use “Open as LaTeX Source” in the editor title bar'),
      acceptAll: () => run(acceptAllChanges()),
      rejectAll: () => run(rejectAllChanges()),
      closeTab: () => { /* VS Code closes tabs */ },
      zoom: (d) => setZoom(z => (d === 0 ? 1 : Math.min(2.5, Math.max(0.5, +(z + d * 0.1).toFixed(2))))),
      textWidth: () => { /* fixed in VS Code */ },
      openFile: () => notify('Use the VS Code explorer to open files'),
      newFile: () => notify('Create .tex files in the VS Code explorer'),
    };
  });

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

  const marksAtCursor = () => {
    const v = handleRef.current?.view;
    if (!v) return [] as any[];
    const { $from, empty } = v.state.selection;
    return (empty ? v.state.storedMarks ?? $from.marks() : $from.marks()) as any[];
  };
  const markActive = (name: string, value: string) => marksAtCursor().some(m => m.type.name === name && m.attrs.value === value);
  const textColor = marksAtCursor().find(m => m.type.name === 'color')?.attrs.value as string | undefined;

  const mathExec = (cmd: string, ...args: unknown[]) => {
    const f = activeMathField();
    if (f) { f.execute(cmd, ...args); f.focus(); return; }
    const v = handleRef.current?.view;
    if (v) { C.insertMath(false)(v); setTimeout(() => activeMathField()?.execute(cmd, ...args), 60); }
  };
  const insertDelim = (c: DelimChoice) => {
    if (c.size === '') mathExec('delim', c.pair.left, c.pair.right);
    else if (c.size === 'none') mathExec('pair', c.pair.left, c.pair.right);
    else mathExec('bigdelim', `${c.size}l`, c.pair.left, `${c.size}r`, c.pair.right);
  };
  const insertInMath = (latex: string) => {
    const active = activeMathField();
    if (active) { active.execute('insert', latex); return; }
    const v = handleRef.current?.view;
    if (v) { C.insertMath(false)(v); setTimeout(() => activeMathField()?.execute('insert', latex), 60); }
  };
  const mathPanels = useMemo(() => mathPanelPalettes(it => { if (it.kind === 'size') mathExec('style', it.latex); else mathExec('insert', it.latex); }), []);
  const clipboard = (op: 'cut' | 'copy' | 'paste') => {
    const v = handleRef.current?.view;
    if (!v) return;
    const f = activeMathField();
    if (op === 'paste') {
      const fallback = () => notify('Paste with Ctrl+V (the toolbar cannot read the clipboard here)', 'error');
      const nav = navigator.clipboard;
      if (!nav?.readText) { fallback(); return; }
      nav.readText().then(t => { if (!t) return; if (f) f.execute('insert', t); else { v.focus(); v.pasteText(t); } }).catch(fallback);
      return;
    }
    if (f) { const c = f.cursor; const sel = c.selection ? c.grabSelection() : f.latex; void navigator.clipboard?.writeText(sel); if (op === 'cut' && c.selection) f.execute('insert', ''); return; }
    v.focus();
    document.execCommand(op);
  };
  const layoutBtn = (id: string, name: string, title: string, icon: string): ToolButton => ({ id, title, icon, action: () => run(C.setLayout(layout === name && name !== 'Standard' ? 'Standard' : name)), active: layout === name });

  const inTable = !!view && !!C.tableContext(view.state);
  const tableSt = view ? T.tableToolbarState(view.state) : null;
  const changesFilterSt = view ? changesFilterKey.getState(view.state) : null;
  const docHasChanges = useMemo(() => !!view && hasChanges(view.state.doc), [docTick, view]);
  const showMath = tbMode('math') === 'on' || (tbMode('math') === 'auto' && !!mathField);
  const showTable = tbMode('table') === 'on' || (tbMode('table') === 'auto' && inTable);
  const showReview = tbMode('review') === 'on' || (tbMode('review') === 'auto' && (tracking || docHasChanges));
  const outputChanges = headerLines.some(l => l === '\\output_changes true');
  const docStats = useMemo(() => {
    if (!view) return null;
    const { from, to, empty } = view.state.selection;
    const doc = view.state.doc;
    const text = doc.textBetween(empty ? 0 : from, empty ? doc.content.size : to, '\n', ' ');
    const words = (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
    return { words, chars: text.replace(/\s+/g, '').length, sel: !empty };
  }, [view, docTick, selTick]);

  const tbTogglePalette = (id: ToolbarId, title: string) => ({
    title, list: true, cols: 1, items: [
      { label: 'On', action: () => setToolbar(id, 'on'), active: tbMode(id) === 'on' },
      { label: 'Off', action: () => setToolbar(id, 'off'), active: tbMode(id) === 'off' },
      { label: 'Automatic', action: () => setToolbar(id, 'auto'), active: tbMode(id) === 'auto' },
    ],
  });
  const textStylesPalette = { title: 'Text properties', list: true, cols: 2, items: [
    ['Emphasis', 'emph'], ['Bold', 'bold'], ['Noun (small caps)', 'noun'], ['Underline', 'underline'], ['Strikeout', 'strikeout'], ['Typewriter', 'typewriter'], ['Sans serif', 'sans'], ['Italic', 'italic'], ['Slanted', 'slanted'], ['Small caps', 'smallcaps'], ['Double underline', 'uuline'], ['Wavy underline', 'uwave'], ['Crossed out', 'xout'],
  ].map(([l, k]) => ({ label: l, action: () => run((C.fontCommands as Record<string, any>)[k]) })).concat(
    [['Tiny', 'tiny'], ['Small', 'small'], ['Normal size', 'normal'], ['Large', 'large'], ['Huge', 'huge']].map(([l, v]) => ({ label: `Size: ${l}`, action: () => run(C.setValueMark('size', v === 'normal' ? null : v)) })),
    [{ label: 'Reset to default (Alt+C Space)', action: () => run(C.fontDefault) }]) };

  /* ---------------------------------------------------------------- toolbar groups (LyX stdtoolbars.inc) */
  const standardGroups: ToolButton[][] = [
    [
      { id: 'spellcheck', title: prefs.spellcheck ? 'Spell checking is on — click to switch it off' : 'Spell checking is off — click to switch it on', icon: 'spellcheck', action: () => setPref('spellcheck', !prefs.spellcheck), active: prefs.spellcheck },
    ],
    [
      { id: 'undo', title: 'Undo (Ctrl+Z)', icon: 'undo', action: () => run(undo) },
      { id: 'redo', title: 'Redo (Ctrl+Y)', icon: 'redo', action: () => run(redo) },
      { id: 'cut', title: 'Cut (Ctrl+X)', icon: 'cut', action: () => clipboard('cut') },
      { id: 'copy', title: 'Copy (Ctrl+C)', icon: 'copy', action: () => clipboard('copy') },
      { id: 'paste', title: 'Paste (Ctrl+V)', icon: 'paste', action: () => clipboard('paste') },
      { id: 'find', title: 'Find & replace (Ctrl+F)', icon: 'find', action: () => setFindOpen(true) },
    ],
    [
      { id: 'emph', title: 'Emphasis (Ctrl+E)', icon: 'emph', action: () => run(C.fontCommands.emph), active: markActive('emph', 'on') },
      { id: 'noun', title: 'Noun / small caps (Ctrl+Shift+N)', icon: 'noun', action: () => run(C.fontCommands.noun), active: markActive('noun', 'on') },
      { id: 'charstyles', title: 'Custom text styles', icon: 'charstyles', palette: textStylesPalette },
      { id: 'italic', title: 'Italic (Ctrl+I)', icon: 'italic', action: () => run(C.fontCommands.italic), active: markActive('shape', 'italic') },
      { id: 'textcolor', title: textColor ? `Text colour: ${textColor}` : 'Text colour', icon: 'textcolor', html: colorIcon(textColor ?? null), active: !!textColor,
        palette: { title: 'Text colour', render: (close: () => void) => <ColorPalette current={textColor ?? null} close={close} onPick={(c: string | null) => run(C.setValueMark('color', c))} /> } },
    ],
    [
      { id: 'math', title: 'Inline formula (Ctrl+M)', icon: 'math', action: () => runView(C.insertMath(false)) },
      { id: 'dmath', title: 'Display formula (Ctrl+Shift+M)', icon: 'dmath', action: () => runView(C.insertMath(true)) },
      { id: 'graphics', title: 'Insert graphics (Ctrl+Shift+G)', icon: 'graphics', action: () => setDialog({ name: 'graphics' }) },
      { id: 'table', title: 'Insert table (Ctrl+Alt+T)', icon: 'table', palette: { title: 'Insert table', render: (close: () => void) => <TableSizePicker close={close} onPick={(r: number, c: number) => run(C.insertTable(r, c))} /> } },
      { id: 'flex', title: 'Custom insets (Flex)', icon: 'box', palette: { title: 'Custom insets of this document class', list: true, cols: 1, items: (meta?.flexInsets ?? []).map(n => ({ label: n, action: () => run(C.insertFlex(n)) })).concat([{ label: 'Other…', action: () => { const n = prompt('Flex inset name:', meta?.flexInsets?.[0] ?? 'Code'); if (n) run(C.insertFlex(n)); } }]) } },
    ],
    [
      { id: 'margin', title: 'Show notes & comments in the margin', icon: 'margin', action: toggleMargin, active: marginMode },
      { id: 'comments-panel', title: 'Comments panel', icon: 'comment', action: () => setShowComments(s => !s), active: showComments },
      { id: 'tb-math', title: 'Show math toolbar', icon: 'mathtb', active: showMath, palette: tbTogglePalette('math', 'Show math toolbar') },
      { id: 'tb-table', title: 'Show table toolbar', icon: 'tabletb', active: showTable, palette: tbTogglePalette('table', 'Show table toolbar') },
      { id: 'tb-review', title: 'Show review toolbar', icon: 'reviewtb', active: showReview, palette: tbTogglePalette('review', 'Show review toolbar') },
    ],
  ];
  const viewUpdateGroups: ToolButton[][] = [
    [
      { id: 'pdf', title: 'Build & view PDF (Ctrl+R)', icon: 'view', action: () => build() },
    ],
    [
      { id: 'outputsync', title: "Sync to PDF — show the cursor's place in the built PDF (Ctrl+Alt+J)", icon: 'outputsync', action: () => { void syncToPdf(); } },
    ],
  ];
  const extraGroups: ToolButton[][] = [
    [
      layoutBtn('l-standard', 'Standard', 'Default paragraph (Standard)', 'layout'),
      layoutBtn('l-enumerate', 'Enumerate', 'Numbered list (Alt+P E)', 'enumerate'),
      layoutBtn('l-itemize', 'Itemize', 'Itemized list (Alt+P I)', 'itemize'),
      layoutBtn('l-labeling', 'Labeling', 'Labeled list (Alt+P L)', 'labeling'),
      layoutBtn('l-description', 'Description', 'Description (Alt+P D)', 'description'),
      layoutBtn('l-section', 'Section', 'Section (Alt+P 2)', 'section'),
      { id: 'depthin', title: 'Increase depth (Alt+Shift+→)', icon: 'depthin', action: () => run(C.changeDepth(1)) },
      { id: 'depthout', title: 'Decrease depth (Alt+Shift+←)', icon: 'depthout', action: () => run(C.changeDepth(-1)) },
    ],
    [
      { id: 'float', title: 'Insert figure float', icon: 'float', action: () => run(C.insertFloat('figure')) },
      { id: 'tablefloat', title: 'Insert table float', icon: 'tablefloat', action: () => run(C.insertFloat('table')) },
      { id: 'label', title: 'Label (Ctrl+Alt+L)', icon: 'label', action: () => setDialog({ name: 'label' }) },
      { id: 'ref', title: 'Cross-reference (Ctrl+Shift+I)', icon: 'ref', action: () => setDialog({ name: 'ref' }) },
      { id: 'cite', title: 'Citation (Ctrl+Shift+C)', icon: 'cite', action: () => setDialog({ name: 'cite' }) },
      { id: 'index', title: 'Index entry', icon: 'index', action: () => run(C.insertIndex) },
    ],
    [
      { id: 'footnote', title: 'Footnote (Ctrl+Alt+F)', icon: 'footnote', action: () => run(C.insertFootnote) },
      { id: 'marginal', title: 'Margin note (Ctrl+Alt+M)', icon: 'marginal', action: () => run(C.insertMarginal) },
      { id: 'note', title: 'LyX note (Ctrl+Alt+Shift+N)', icon: 'note', action: () => run(C.insertNote('Note')) },
      { id: 'comment', title: 'Comment thread (Ctrl+Alt+C)', icon: 'comment', action: () => run(C.insertComment) },
      { id: 'boxinset', title: 'Insert box', icon: 'boxinset', action: () => run(C.insertBox) },
      { id: 'href', title: 'Hyperlink (Ctrl+Alt+K)', icon: 'href', action: () => setDialog({ name: 'href' }) },
      { id: 'ert', title: 'TeX code (Ctrl+L)', icon: 'ert', action: () => run(C.insertERT) },
      { id: 'macro', title: 'Math macro definition', icon: 'macro', action: () => { const n = prompt('Macro name (without backslash):'); if (n) run(C.insertMacroDef(n, Number(prompt('Number of arguments:', '0') || 0), '')); } },
      { id: 'include', title: 'Include file (child document)', icon: 'include', action: () => { const fn = prompt('Child document file name (relative):', 'chapter1.tex'); if (fn) run(C.insertInclude(fn, 'include')); } },
    ],
    [
      { id: 'textstyle', title: 'Text properties', icon: 'textstyle', palette: textStylesPalette },
      { id: 'paragraph', title: 'Paragraph settings (Ctrl+Alt+P)', icon: 'paragraph', action: () => setDialog({ name: 'paragraph' }) },
    ],
  ];
  const mf = () => activeMathField();
  const mathGroups: ToolButton[][] = [
    [{ id: 'm-display', title: 'Toggle display / inline formula (Ctrl+Shift+M)', icon: 'display', active: !!mathField?.display, action: () => { const f = mf() as any; if (f?._toggleDisplay) f._toggleDisplay(); else run(C.toggleMathDisplay); } }],
    [
      { id: 'm-sub', title: 'Subscript (Alt+M X, _)', icon: 'sub', action: () => mathExec('moveToSubscript') },
      { id: 'm-sup', title: 'Superscript (Alt+M E, ^)', icon: 'sup', action: () => mathExec('moveToSuperscript') },
      { id: 'm-sqrt', title: 'Square root (Alt+M S)', icon: 'msqrt', action: () => mathExec('insert', '\\sqrt{#0}') },
      { id: 'm-root', title: 'Root (Alt+M R)', icon: 'mroot', action: () => mathExec('insert', '\\sqrt[]{#0}') },
      { id: 'm-frac', title: 'Fraction (Alt+M F)', icon: 'mfrac', action: () => mathExec('insert', '\\frac{#0}{}') },
      { id: 'm-sum', title: 'Sum (Alt+M U)', icon: 'msum', action: () => mathExec('insert', '\\sum') },
      { id: 'm-int', title: 'Integral (Alt+M I)', icon: 'mint', action: () => mathExec('insert', '\\int') },
      { id: 'm-prod', title: 'Product', icon: 'mprod', action: () => mathExec('insert', '\\prod') },
    ],
    [
      { id: 'm-paren', title: 'Insert ( ) (Alt+M ()', icon: '( )', html: mathPreview('\\left(\\square\\right)') ?? undefined, action: () => mathExec('delim', '(', ')') },
      { id: 'm-bracket', title: 'Insert [ ] (Alt+M [)', icon: '[ ]', html: mathPreview('\\left[\\square\\right]') ?? undefined, action: () => mathExec('delim', '[', ']') },
      { id: 'm-brace', title: 'Insert { } (Alt+M {)', icon: '{ }', html: mathPreview('\\left\\{\\square\\right\\}') ?? undefined, action: () => mathExec('delim', '\\{', '\\}') },
      { id: 'm-abs', title: 'Insert | | (Alt+M |)', icon: '| |', html: mathPreview('\\left|\\square\\right|') ?? undefined, action: () => mathExec('delim', '|', '|') },
      { id: 'm-angle', title: 'Insert ⟨ ⟩ (Alt+M <)', icon: '⟨ ⟩', html: mathPreview('\\left\\langle\\square\\right\\rangle') ?? undefined, action: () => mathExec('delim', '\\langle', '\\rangle') },
      { id: 'm-delims', title: 'Delimiters of all sizes (\\left…\\right, \\big … \\Bigg)', icon: 'delimsize', palette: { title: 'Delimiters — rows: pair, columns: size', render: (close: () => void) => <DelimPalette close={close} onPick={insertDelim} onDialog={() => setDialog({ name: 'delimiters' })} /> } },
    ],
    [
      { id: 'm-matrix', title: 'Insert matrix…', icon: 'matrix', html: mathPreview('\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}') ?? undefined, action: () => setDialog({ name: 'matrix' }) },
      { id: 'm-cases', title: 'Insert cases environment (Alt+M C)', icon: 'cases', html: mathPreview('\\cases') ?? undefined, action: () => mathExec('insert', '\\cases') },
      { id: 'm-addrow', title: 'Add row (matrix / align)', icon: 'addrow', disabled: !!mathField && !mathField.cursor.gridRowsOK(), action: () => mathExec('appendRow') },
      { id: 'm-addcol', title: 'Add column (matrix / align)', icon: 'addcol', disabled: !!mathField && !mathField.cursor.gridColsOK(), action: () => mathExec('appendColumn') },
      { id: 'm-delrow', title: 'Delete row', icon: 'delrow', disabled: !!mathField && !mathField.cursor.gridRowsOK(), action: () => mathExec('deleteRow') },
      { id: 'm-delcol', title: 'Delete column', icon: 'delcol', disabled: !!mathField && !mathField.cursor.gridColsOK(), action: () => mathExec('deleteColumn') },
    ],
    [
      { id: 'm-limits', title: 'Toggle limits placement (\\limits)', icon: 'lim', html: mathPreview('\\sum\\limits_{i}') ?? undefined, action: () => mathExec('limits') },
      { id: 'm-text', title: 'Text in formula (Ctrl+M)', icon: 'Tx', action: () => mathExec('text') },
      { id: 'tb-mathpanels', title: 'Show math panels', icon: 'mathpanelstb', active: tbMode('mathpanels') !== 'off', palette: tbTogglePalette('mathpanels', 'Show math panels') },
    ],
  ];
  const MATH_PANEL_PREVIEW: Record<string, string> = {
    functions: '\\sin', space: '\\square\\,\\square', 'sqrt-square': '\\sqrt{x}', style: '\\displaystyle\\textstyle', 'frac-square': '\\frac{a}{b}', font: '\\mathbb{R}', latex_dots: '\\cdots', latex_deco: '\\hat{a}',
    latex_arrow: '\\rightarrow', latex_bop: '\\otimes', latex_brel: '\\leq', latex_greek: '\\alpha', latex_misc: '\\infty', latex_varsz: '\\sum', latex_ams_misc: '\\square', latex_ams_arrows: '\\rightrightarrows',
    latex_ams_rel: '\\leqslant', latex_ams_nrel: '\\nleq', latex_ams_ops: '\\boxtimes', latex_delim: '\\lfloor\\rfloor',
  };
  const MATH_PANEL_ICONS: Record<string, string> = { style: 'Style' };
  const mathPanelGroups: ToolButton[][] = [mathPanels.map(p => ({ id: 'mp-' + p.id, title: p.title, icon: MATH_PANEL_ICONS[p.id] ?? p.title, html: MATH_PANEL_PREVIEW[p.id] ? mathPreview(MATH_PANEL_PREVIEW[p.id]) ?? undefined : undefined, palette: p.palette }))];
  const tableGroups: ToolButton[][] = [
    [
      { id: 't-addrow', title: 'Add row', icon: 'addrow', action: () => run(T.appendRow) },
      { id: 't-addcol', title: 'Add column', icon: 'addcol', action: () => run(T.appendColumn) },
      { id: 't-delrow', title: 'Delete row', icon: 'delrow', action: () => run(T.deleteRow) },
      { id: 't-delcol', title: 'Delete column', icon: 'delcol', action: () => run(T.deleteColumn) },
      { id: 't-rowup', title: 'Move row up', icon: 'rowup', action: () => run(T.moveRowUp) },
      { id: 't-colleft', title: 'Move column left', icon: 'colleft', action: () => run(T.moveColumnLeft) },
      { id: 't-rowdown', title: 'Move row down', icon: 'rowdown', action: () => run(T.moveRowDown) },
      { id: 't-colright', title: 'Move column right', icon: 'colright', action: () => run(T.moveColumnRight) },
    ],
    [
      { id: 't-top', title: 'Toggle top line', icon: 'linetop', active: !!tableSt?.lines.top, action: () => run(T.toggleLine('top')) },
      { id: 't-bottom', title: 'Toggle bottom line', icon: 'linebottom', active: !!tableSt?.lines.bottom, action: () => run(T.toggleLine('bottom')) },
      { id: 't-left', title: 'Toggle left line', icon: 'lineleft', active: !!tableSt?.lines.left, action: () => run(T.toggleLine('left')) },
      { id: 't-right', title: 'Toggle right line', icon: 'lineright', active: !!tableSt?.lines.right, action: () => run(T.toggleLine('right')) },
      { id: 't-border', title: 'Toggle border lines', icon: 'lineborder', action: () => run(T.toggleBorderLines) },
      { id: 't-inner', title: 'Toggle inner lines', icon: 'lineinner', action: () => run(T.toggleInnerLines) },
      { id: 't-all', title: 'Toggle all lines', icon: 'lineall', action: () => run(T.toggleAllLines) },
      { id: 't-none', title: 'Unset all lines', icon: 'linenone', action: () => run(T.unsetAllLines) },
      { id: 't-formal', title: 'Reset formal default lines (booktabs style)', icon: 'lineformal', action: () => run(T.resetFormalDefault) },
    ],
    [
      { id: 't-al', title: 'Align left', icon: 'alignleft', active: tableSt?.align === 'left', action: () => run(T.setAlignment('left')) },
      { id: 't-ac', title: 'Align center', icon: 'aligncenter', active: tableSt?.align === 'center', action: () => run(T.setAlignment('center')) },
      { id: 't-ar', title: 'Align right', icon: 'alignright', active: tableSt?.align === 'right', action: () => run(T.setAlignment('right')) },
      { id: 't-ad', title: 'Align on decimal', icon: 'aligndecimal', active: tableSt?.align === 'decimal', action: () => run(T.setAlignment('decimal')) },
    ],
    [
      { id: 't-vt', title: 'Align top', icon: 'valigntop', active: tableSt?.valign === 'top', action: () => run(T.setVAlignment('top')) },
      { id: 't-vm', title: 'Align middle', icon: 'valignmiddle', active: tableSt?.valign === 'middle', action: () => run(T.setVAlignment('middle')) },
      { id: 't-vb', title: 'Align bottom', icon: 'valignbottom', active: tableSt?.valign === 'bottom', action: () => run(T.setVAlignment('bottom')) },
    ],
    [
      { id: 't-rotcell', title: 'Rotate cell by 90° or unset rotation', icon: 'rotatecell', active: !!tableSt?.rotateCell, action: () => run(T.toggleRotateCell) },
      { id: 't-rottable', title: 'Rotate table by 90° or unset rotation', icon: 'rotatetable', active: !!tableSt?.rotateTable, action: () => run(T.toggleRotateTable) },
      { id: 't-mc', title: 'Set multi-column', icon: 'multicolumn', active: !!tableSt?.multicolumn, action: () => run(T.toggleMultiColumn) },
      { id: 't-mr', title: 'Set multi-row', icon: 'multirow', active: !!tableSt?.multirow, action: () => run(T.toggleMultiRow) },
      { id: 't-settings', title: 'Table settings…', icon: 'tablesettings', action: () => setDialog({ name: 'tablesettings' }) },
    ],
  ];
  const reviewGroups: ToolButton[][] = [
    [
      { id: 'r-track', title: 'Track changes (Ctrl+Shift+E)', icon: 'track', action: () => { void toggleTracking(); }, active: tracking },
      { id: 'r-output', title: 'Show changes in output (\\output_changes)', icon: 'changesoutput', active: outputChanges, action: () => { api.setHeader(docId, { set: { output_changes: outputChanges ? 'false' : 'true' } }).then(r => { setHeader(r.headerLines); notify(outputChanges ? 'Changes are no longer shown in the output' : 'Changes are shown in the output'); }).catch(e => notify(String(e), 'error')); } },
    ],
    [
      { id: 'r-show-ins', title: 'Show insertions', icon: 'showinsertions', active: changesFilterSt?.showInsertions ?? true, action: () => view && setChangesFilter(view, { showInsertions: !(changesFilterSt?.showInsertions ?? true) }) },
      { id: 'r-show-del', title: 'Show deletions', icon: 'showdeletions', active: changesFilterSt?.showDeletions ?? true, action: () => view && setChangesFilter(view, { showDeletions: !(changesFilterSt?.showDeletions ?? true) }) },
    ],
    [
      { id: 'r-prev', title: 'Previous change', icon: 'changeprev', action: () => run(gotoChange(-1)) },
      { id: 'r-next', title: 'Next change', icon: 'changenext', action: () => run(gotoChange(1)) },
      { id: 'r-accept', title: 'Accept change inside selection / at cursor', icon: 'accept', action: () => run(resolveSelectionChanges(true)) },
      { id: 'r-reject', title: 'Reject change inside selection / at cursor', icon: 'reject', action: () => run(resolveSelectionChanges(false)) },
    ],
    [
      { id: 'r-acceptall', title: 'Accept all changes', icon: 'acceptall', action: () => { if (confirm('Accept all tracked changes?')) run(acceptAllChanges()); } },
      { id: 'r-rejectall', title: 'Reject all changes', icon: 'rejectall', action: () => { if (confirm('Reject all tracked changes?')) run(rejectAllChanges()); } },
    ],
  ];

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
          return <RefDialog labels={labels} useRefstyle={!!meta?.useRefstyle} initial={{ name: unquote(p.get('reference')), kind: p.get('LatexCommand') ?? 'ref' }} onClose={close}
            onInsert={(n: string, k: string) => { const params = [`LatexCommand ${k}`, `reference "${n}"`, 'plural "false"', 'caps "false"', 'noprefix "false"', 'nolink "false"', '']; view.dispatch(view.state.tr.setNodeMarkup(tpos, undefined, { ...tnode.attrs, params: JSON.stringify(params) })); }} />;
        }
        return <RefDialog labels={labels} useRefstyle={!!meta?.useRefstyle} initial={target?.prefill ? { name: target.prefill, kind: 'ref' } : undefined} onClose={close} onInsert={(n: string, k: string) => run(C.insertRef(n, k))} />;
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
      {tbMode('standard') !== 'off' && <Toolbar id="standard" layouts={layouts} layout={layout} onLayout={(n: string) => run(C.setLayout(n))} groups={standardGroups} />}
      {(tbMode('viewupdate') !== 'off' || tbMode('extra') !== 'off') && (
        <div class="tb-samerow">
          {tbMode('viewupdate') !== 'off' && <Toolbar id="viewupdate" groups={viewUpdateGroups} />}
          {tbMode('extra') !== 'off' && <Toolbar id="extra" groups={extraGroups} />}
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
        <div class="editor-column">
          <div class={'editor-scroll' + (marginMode ? ' margin-mode' : '')} ref={scrollRef} style={{ zoom }} onClick={e => { if (e.target === e.currentTarget && view) view.focus(); }}>
            <div class="editor-page">
              <div class="editor-host" ref={containerRef} />
            </div>
          </div>
        </div>
        {showComments && (
          <div class="sidebar right">
            <div class="panel-tabs">
              <button class="active" data-tab="comments">Comments</button>
              <button class="hide" title="Hide the sidebar" onClick={() => setShowComments(false)}>»</button>
            </div>
            <div class="panel-body"><Comments views={view ? [view] : []} tick={docTick} /></div>
          </div>
        )}
      </div>
      {(showMath || showTable || showReview) && (
        <div class="bottom-toolbars" style={{ left: '24px', right: showComments ? 'var(--right-width, 360px)' : '24px' }}>
          {showMath && <Toolbar id="math" label="Math" groups={mathGroups} />}
          {showMath && tbMode('mathpanels') !== 'off' && <Toolbar id="mathpanels" label="Panels" groups={mathPanelGroups} />}
          {showTable && <Toolbar id="table" label="Table" groups={tableGroups} />}
          {showReview && <Toolbar id="review" label="Review" groups={reviewGroups} />}
        </div>
      )}
      <StatusBar layout={layout} status={status} chord={chord} message={message} save={{ state: 'saved', pending: false, savedAt: 0, unavailable: false }}
        tracking={tracking} trackingAs="You" change={changeInfo} stats={docStats} zoom={zoom} onZoom={setZoom} />
      {renderDialog()}
    </div>
  );
}

function LayoutPicker({ layouts, onPick, onClose }: { layouts: { name: string; category?: string }[]; onPick: (n: string) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const list = layouts.filter(l => l.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div class="dialog-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="dialog"><h2>Paragraph layout</h2><div class="body">
        <input type="text" autofocus value={q} onInput={e => setQ((e.target as HTMLInputElement).value)} onKeyDown={e => { if (e.key === 'Enter' && list[0]) { onPick(list[0].name); onClose(); } if (e.key === 'Escape') onClose(); }} placeholder="type to filter…" />
        <div class="list">{list.map(l => <div key={l.name} onClick={() => { onPick(l.name); onClose(); }}>{l.name} <span class="sub">{l.category}</span></div>)}</div>
      </div></div>
    </div>
  );
}
