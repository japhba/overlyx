import { useEffect, useMemo, useRef, useState, useCallback } from 'preact/hooks';
import type { EditorView } from 'prosemirror-view';
import { NodeSelection, TextSelection } from 'prosemirror-state';
import { undo, redo } from 'y-prosemirror';
import { addColumnAfter, addColumnBefore, addRowAfter, addRowBefore, deleteColumn, deleteRow, deleteTable, mergeCells, splitCell } from 'prosemirror-tables';
import { api, type DocMeta, type User } from '../api';
import { Login } from './Login';
import { FileBrowser } from './FileBrowser';
import { MenuBar, type MenuDef } from './MenuBar';
import { Toolbar, type ToolButton } from './Toolbar';
import { Outline, buildOutline, type OutlineItem } from './Outline';
import { Versions } from './Versions';
import { PdfPanel, buildPdf, type PdfState } from './PdfPanel';
import { StatusBar, type Status } from './StatusBar';
import { SourcePane, type SourceTarget } from './SourcePane';
import { GraphicsDialog, TableDialog, LabelDialog, RefDialog, CiteDialog, HrefDialog, SettingsDialog, InsetDialog, HelpDialog, TexDialog, MacrosDialog, ParagraphDialog, TableSettingsDialog, DelimiterDialog, MatrixDialog, commandParams } from './Dialogs';
import { createEditor, refreshMacros, describeChange, type EditorHandle } from '../editor/editor';
import { editorContext, viewDocId } from '../editor/context';
import { STANDARD_LAYOUTS } from '../editor/layouts';
import { chordKey } from '../editor/keymap';
import * as C from '../editor/commands';
import { setMarginMode } from '../editor/plugins/margin';
import { acceptAllChanges, rejectAllChanges, changeAt, resolveChange } from '../editor/plugins/changes';
import { setQuery, findNext, replaceCurrent, replaceAll, findKey } from '../editor/plugins/find';
import { schema, unquote } from '@overlyx/core';

type Dialog = { name: string; arg?: unknown } | null;

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [google, setGoogle] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => { api.me().then(r => { setUser(r.user); setGoogle(r.google); }).finally(() => setReady(true)); }, []);
  if (!ready) return <div style="padding:40px;color:#666">Loading…</div>;
  if (!user) return <Login google={google} onLogin={setUser} />;
  return <Workspace user={user} onLogout={() => api.logout().then(() => setUser(null))} />;
}

/** `#/project/path.lyx?goto=label` */
function parseHash(): { id: string | null; goto: string | null } {
  const raw = location.hash.replace(/^#\/?/, '');
  const q = raw.indexOf('?');
  const idPart = decodeURIComponent(q >= 0 ? raw.slice(0, q) : raw);
  const goto = q >= 0 ? new URLSearchParams(raw.slice(q + 1)).get('goto') : null;
  return { id: idPart || null, goto };
}

function loadTabs(): string[] { try { const t = JSON.parse(localStorage.getItem('ol.tabs') || '[]'); return Array.isArray(t) ? t.filter(x => typeof x === 'string') : []; } catch { return []; } }

function Workspace({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [docId, setDocId] = useState<string | null>(parseHash().id);
  const [tabs, setTabs] = useState<string[]>(loadTabs);
  const [meta, setMeta] = useState<DocMeta | null>(null);
  const [headerLines, setHeaderLines] = useState<string[]>([]);
  const [status, setStatus] = useState<Status>({ connected: false, synced: false, users: [] });
  const [layout, setLayout] = useState('Standard');
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [activePos, setActivePos] = useState(0);
  const [showFiles, setShowFiles] = useState(true);
  const [rightTab, setRightTab] = useState<'outline' | 'pdf' | 'versions' | 'source' | null>('outline');
  const [pdf, setPdf] = useState<PdfState>({ url: null, log: '', busy: false, ok: null, warnings: [] });
  const [dialog, setDialog] = useState<Dialog>(null);
  const [message, setMessage] = useState<{ text: string; kind: 'info' | 'error' } | null>(null);
  const [marginMode, setMarginModeState] = useState(localStorage.getItem('ol.margin') === '1');
  const [combined, setCombined] = useState(localStorage.getItem('ol.combined') === '1');
  const [childIds, setChildIds] = useState<string[]>([]);
  const [tracking, setTracking] = useState(false);
  const [chord, setChord] = useState<string | null>(null);
  const [changeInfo, setChangeInfo] = useState<string | null>(null);
  const [saved, setSaved] = useState(true);
  const [zoom, setZoom] = useState(Number(localStorage.getItem('ol.zoom') || 1));
  // width of the text column in px (0 = full width), see View ▸ Text width
  const [textWidth, setTextWidth] = useState<number>(() => { const v = Number(localStorage.getItem('ol.textWidth')); return Number.isFinite(v) && localStorage.getItem('ol.textWidth') !== null ? v : 720; });
  const stepTextWidth = (d: number) => setTextWidth(w => (d === 0 ? 720 : Math.min(1600, Math.max(400, (w || 1200) + d * 60))));
  const [findOpen, setFindOpen] = useState(false);
  const [findQ, setFindQ] = useState(''), [replQ, setReplQ] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [selVersion, setSelVersion] = useState(0);
  const [docTick, setDocTick] = useState(0);
  const [selTick, setSelTick] = useState(0);
  const editorRef = useRef<EditorHandle | null>(null);
  const childRefs = useRef(new Map<string, EditorHandle>());
  const activeViewRef = useRef<EditorView | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pendingGoto = useRef<string | null>(parseHash().goto);
  const [, force] = useState(0);
  const rerender = () => force(x => x + 1);

  const notify = useCallback((text: string, kind: 'info' | 'error' = 'info') => { setMessage({ text, kind }); setTimeout(() => setMessage(m => (m?.text === text ? null : m)), 4000); }, []);

  useEffect(() => {
    const onHash = () => { const h = parseHash(); pendingGoto.current = h.goto; setDocId(h.id); if (h.goto && h.id === editorContext.docId) runGoto(); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => { document.documentElement.style.setProperty('--editor-zoom', String(zoom)); localStorage.setItem('ol.zoom', String(zoom)); }, [zoom]);
  // Ctrl/Cmd +/-/0 zoom the document text, never the browser chrome — wherever the focus is (formula fields, panels)
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const mod = navigator.platform.includes('Mac') ? ev.metaKey : ev.ctrlKey;
      if (!mod || ev.altKey || ev.shiftKey && ev.key !== '+') return;
      const k = ev.key === '+' || ev.code === 'Equal' || ev.code === 'NumpadAdd' ? 1 : ev.key === '-' || ev.code === 'Minus' || ev.code === 'NumpadSubtract' ? -1 : ev.key === '0' || ev.code === 'Digit0' || ev.code === 'Numpad0' ? 0 : null;
      if (k === null) return;
      ev.preventDefault(); ev.stopPropagation();
      editorContext.ui?.zoom(k);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  useEffect(() => { document.documentElement.style.setProperty('--text-width', textWidth > 0 ? textWidth + 'px' : '100%'); localStorage.setItem('ol.textWidth', String(textWidth)); }, [textWidth]);
  useEffect(() => { localStorage.setItem('ol.tabs', JSON.stringify(tabs)); }, [tabs]);
  useEffect(() => { editorContext.combined = combined; localStorage.setItem('ol.combined', combined ? '1' : '0'); }, [combined]);

  // every opened document gets a tab, inserted right of the tab it was opened from
  const lastDoc = useRef<string | null>(null);
  const addTab = (t: string[], id: string, after: string | null): string[] => {
    if (t.includes(id)) return t;
    const i = after ? t.indexOf(after) : -1;
    return i < 0 ? [...t, id] : [...t.slice(0, i + 1), id, ...t.slice(i + 1)];
  };
  useEffect(() => { if (docId) { setTabs(t => addTab(t, docId, lastDoc.current)); lastDoc.current = docId; } }, [docId]);

  const openInTab = useCallback((id: string, opts: { background?: boolean; goto?: string } = {}) => {
    setTabs(t => addTab(t, id, parseHash().id));
    if (opts.background) { notify(`Opened ${id.split('/').pop()} in a new tab`); return; }
    const target = '#/' + id + (opts.goto ? '?goto=' + encodeURIComponent(opts.goto) : '');
    if (location.hash === target) { pendingGoto.current = opts.goto ?? null; runGoto(); } else location.hash = target;
  }, []);
  const closeTab = useCallback((id: string) => {
    setTabs(t => {
      const idx = t.indexOf(id);
      const next = t.filter(x => x !== id);
      if (id === parseHash().id) { const nb = next[Math.min(idx, next.length - 1)]; location.hash = nb ? '#/' + nb : ''; }
      return next;
    });
  }, []);

  /** Find a label in a view and select it. */
  const gotoLabelIn = (view: EditorView, name: string): boolean => {
    let found = -1;
    view.state.doc.descendants((node, pos) => {
      if (found >= 0) return false;
      if (node.type.name === 'command' && node.attrs.cmd === 'label' && unquote(commandParams(node).get('name')) === name) found = pos;
      if (node.type.name === 'math_display' && String(node.attrs.latex).includes(`\\label{${name}}`)) found = pos;
      return true;
    });
    if (found < 0) return false;
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, found)).scrollIntoView());
    view.focus();
    const dom = view.nodeDOM(found) as HTMLElement | null;
    dom?.scrollIntoView?.({ block: 'center' });
    return true;
  };
  const gotoLabel = useCallback((name: string, from?: EditorView) => {
    const views = [from, editorRef.current?.view, ...[...childRefs.current.values()].map(h => h.view)].filter((v): v is EditorView => !!v);
    for (const v of views) if (gotoLabelIn(v, name)) return;
    const l = editorContext.meta?.labels.find(x => x.name === name);
    if (l?.file && editorContext.project) { openInTab(`${editorContext.project}/${l.file}`, { goto: name }); return; }
    notify(`Label “${name}” not found`, 'error');
  }, []);
  const runGoto = () => {
    const name = pendingGoto.current;
    if (!name) return;
    const v = editorRef.current?.view;
    if (v && gotoLabelIn(v, name)) { pendingGoto.current = null; }
  };

  const onSelection = (view: EditorView) => {
    activeViewRef.current = view; editorContext.activeView = view;
    const p = C.currentParagraph(view.state);
    setLayout(p ? p.node.attrs.layout : '');
    if (view === editorRef.current?.view) setActivePos(view.state.selection.from);
    setChord(chordKey.getState(view.state) ?? null);
    const ch = changeAt(view.state, view.state.selection.from);
    setChangeInfo(ch ? describeChange(ch.type, ch.author, ch.time) : null);
    setSelTick(t => t + 1);
    rerender();
  };

  // create / destroy the editor when the document changes (metadata first, so formulas render once with the right macros)
  useEffect(() => {
    editorRef.current?.destroy();
    editorRef.current = null; activeViewRef.current = null;
    setMeta(null); setOutline([]); setChildIds([]); setPdf({ url: null, log: '', busy: false, ok: null, warnings: [] });
    if (!docId || !containerRef.current) return;
    containerRef.current.innerHTML = '<div class="editor-loading">Loading document…</div>';
    editorContext.user = user; editorContext.docId = docId; editorContext.project = docId.split('/')[0]; editorContext.meta = null;
    editorContext.docDir = docId.split('/').slice(1, -1).join('/');
    let handle: EditorHandle | null = null;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = (m: DocMeta | null) => {
      if (cancelled || !containerRef.current) return;
      containerRef.current.innerHTML = '';
      if (m) {
        setMeta(m); editorContext.meta = m;
        applyAuthorColors(m.authors);
        setTracking(m.trackingChanges);
        editorContext.trackChanges = m.trackingChanges;
        editorContext.changeAuthorId = m.authors.find(x => x.name === user.name)?.id;
      }
      handle = createEditor({
        docId, user, container: containerRef.current, marginMode,
        onStatus: setStatus,
        onSelectionChange: onSelection,
        onDocChange: (view) => { setSaved(false); setDocTick(t => t + 1); scheduleOutline(view); scheduleMacros(view); },
      });
      editorRef.current = handle; activeViewRef.current = handle.view; editorContext.activeView = handle.view;
      refreshMacros(handle.view, m?.macros ?? {});
      // header lines live in the Y meta map
      const metaMap = handle.ydoc.getMap<string>('meta');
      const readHeader = () => { try { setHeaderLines(JSON.parse(metaMap.get('header') ?? '[]')); } catch { /* ignore */ } };
      readHeader(); metaMap.observe(readHeader);
      // saved-state polling: the server writes 1.5s after the last change
      timer = setInterval(() => setSaved(true), 4000);
      const h = handle;
      h.provider.on('sync', () => {
        setOutline(buildOutline(h.view.state.doc, true, editorContext.meta?.secnumdepth ?? 3));
        setChildIds(collectChildren(h.view));
        refreshMacros(h.view, editorContext.meta?.macros ?? {});
        setDocTick(x => x + 1);
        setTimeout(runGoto, 50);
      });
      rerender();
    };
    const scheduleOutline = debounce((view: EditorView) => { setOutline(buildOutline(view.state.doc, true, editorContext.meta?.secnumdepth ?? 3)); setChildIds(collectChildren(view)); }, 300);
    let macroSig = '';
    const scheduleMacros = debounce((view: EditorView) => {
      // only re-apply when a FormulaMacro inset changed (cheap signature)
      let sig = '';
      view.state.doc.descendants((n, pos) => { if (n.type.name === 'macro') sig += pos + n.attrs.lines + ';'; return true; });
      if (sig !== macroSig) { macroSig = sig; refreshMacros(view, editorContext.meta?.macros ?? {}); }
    }, 600);
    api.meta(docId).then(start).catch(e => { notify('Could not load document metadata: ' + e.message, 'error'); start(null); });
    return () => { cancelled = true; if (timer) clearInterval(timer); handle?.destroy(); editorRef.current = null; };
  }, [docId]);

  // UI hooks for keymap / node views
  useEffect(() => {
    editorContext.notify = notify;
    editorContext.openDialog = (name, arg) => setDialog({ name, arg });
    editorContext.openInsetDialog = (_view, pos) => { if (pos !== undefined) setDialog({ name: 'inset', arg: pos }); };
    editorContext.openInTab = openInTab;
    editorContext.gotoLabel = gotoLabel;
    (window as any).overlyx = editorContext;   // handy for tests / debugging
    editorContext.ui = {
      save: () => { if (docId) api.save(docId).then(() => { setSaved(true); notify('Saved to ' + docId); }).catch(e => notify(String(e.message), 'error')); },
      viewPdf: () => build('overlyx'),
      updatePdf: () => build('overlyx'),
      find: () => setFindOpen(true),
      openDialog: (name, arg) => setDialog({ name, arg }),
      toggleTrackChanges: () => toggleTracking(),
      toggleOutline: () => setRightTab(t => (t === 'outline' ? null : 'outline')),
      toggleSource: () => setRightTab(t => (t === 'source' ? null : 'source')),
      toggleCombined: () => setCombined(c => !c),
      acceptAll: () => run(acceptAllChanges()),
      rejectAll: () => run(rejectAllChanges()),
      closeTab: () => { if (docId) closeTab(docId); },
      zoom: (d) => setZoom(z => (d === 0 ? 1 : Math.min(2.5, Math.max(0.5, +(z + d * 0.1).toFixed(2))))),
      textWidth: stepTextWidth,
      openFile: () => setShowFiles(true),
      newFile: () => { const p = docId?.split('/')[0]; if (p) { const name = prompt('New document name:', 'untitled.lyx'); if (name) api.newDoc(p, name, { title: name.replace(/\.lyx$/, '') }).then(r => { location.hash = '#/' + r.id; setRefreshKey(k => k + 1); }); } },
    };
  });

  const view = activeViewRef.current ?? editorRef.current?.view ?? null;
  const masterView = editorRef.current?.view ?? null;
  const run = (cmd: (state: any, dispatch: any, view?: any) => boolean) => { const v = activeViewRef.current ?? editorRef.current?.view; if (!v) return; cmd(v.state, v.dispatch, v); v.focus(); };
  const runView = (fn: (v: EditorView) => boolean) => { const v = activeViewRef.current ?? editorRef.current?.view; if (!v) return; fn(v); };

  const build = async (engine: 'overlyx' | 'lyx') => {
    if (!docId) return;
    setRightTab('pdf');
    setPdf(p => ({ ...p, busy: true }));
    await api.save(docId).catch(() => {});
    const r = await buildPdf(docId, engine);
    setPdf(r);
    notify(r.ok ? 'PDF built' : 'PDF build failed — see log', r.ok ? 'info' : 'error');
  };

  const toggleTracking = async () => {
    if (!docId) return;
    const next = !editorContext.trackChanges;
    if (next && editorContext.changeAuthorId === undefined) {
      // register this user as an author in the document header
      const id = hashAuthor(user.name);
      const lines = [...headerLines];
      const idx = lines.findIndex(l => l.startsWith('\\author '));
      const line = `\\author ${id} "${user.name}" ""`;
      if (idx >= 0) lines.splice(idx, 0, line); else lines.push(line);
      await api.setHeader(docId, { headerLines: lines, set: { tracking_changes: 'true' } });
      editorContext.changeAuthorId = id;
      setMeta(m => (m ? { ...m, authors: [...m.authors, { id, name: user.name }] } : m));
    } else {
      await api.setHeader(docId, { set: { tracking_changes: String(next) } });
    }
    editorContext.trackChanges = next;
    setTracking(next);
    notify(next ? `Change tracking ON (as ${user.name})` : 'Change tracking OFF');
  };

  const toggleMargin = () => {
    const next = !marginMode;
    setMarginModeState(next);
    localStorage.setItem('ol.margin', next ? '1' : '0');
    if (masterView) setMarginMode(masterView, next);
    for (const h of childRefs.current.values()) setMarginMode(h.view, next);
  };

  const labels = useMemo(() => {
    if (!view) return [] as { name: string; context: string; file?: string }[];
    const out: { name: string; context: string; file?: string }[] = [];
    const scan = (v: EditorView, file?: string) => v.state.doc.descendants((node, pos) => {
      if (node.type.name === 'command' && node.attrs.cmd === 'label') {
        const $p = v.state.doc.resolve(pos);
        out.push({ name: unquote(commandParams(node).get('name')), context: $p.parent.textContent.slice(0, 60), file });
      } else if (node.type.name === 'math_display') {
        for (const m of String(node.attrs.latex).matchAll(/\\label\{([^}]*)\}/g)) out.push({ name: m[1], context: '(equation)', file });
      }
      return true;
    });
    scan(view);
    if (masterView && masterView !== view) scan(masterView, viewDocId(masterView).split('/').slice(1).join('/'));
    for (const h of childRefs.current.values()) if (h.view !== view) scan(h.view, viewDocId(h.view).split('/').slice(1).join('/'));
    // labels from the master document and its other children (server-side scan)
    const own = new Set(out.map(l => l.name));
    for (const l of meta?.labels ?? []) if (!own.has(l.name) && l.file !== meta?.path) out.push({ name: l.name, context: l.context, file: l.file });
    return out;
  }, [dialog, view, meta]);

  const layouts = meta?.layouts?.length ? meta.layouts : STANDARD_LAYOUTS;
  const base = (id: string) => id.split('/').pop() ?? id;
  const docLabel = docId ? (combined && childIds.length ? [docId, ...childIds].map(base).join(' + ') : docId) : '';

  const menus: MenuDef[] = docId ? [
    { title: 'File', items: [
      { label: 'New…', shortcut: 'Ctrl+N', action: () => editorContext.ui?.newFile() },
      { label: 'Open (file browser)', shortcut: 'Ctrl+O', action: () => setShowFiles(true) },
      { label: 'Save now', shortcut: 'Ctrl+S', action: () => editorContext.ui?.save() },
      { sep: true },
      { label: 'Export ▸', sub: [
        { label: 'PDF (pdflatex via latexmk)', shortcut: 'Ctrl+R', action: () => build('overlyx') },
        { label: 'PDF via native LyX', action: () => build('lyx') },
        { label: 'LaTeX source…', action: async () => { const r = await api.export(docId, 'tex'); setDialog({ name: 'tex', arg: r.tex ?? '' }); } },
        { label: 'Download .lyx', action: () => window.open(`/api/docs/${encodeURIComponent(docId)}/lyx?download=1`) },
        { label: 'Download PDF', action: () => window.open(`/api/docs/${encodeURIComponent(docId)}/pdf?download=1`) },
      ] },
      { label: 'Versions…', action: () => setRightTab('versions') },
      { sep: true },
      { label: 'Close tab', shortcut: 'Ctrl+W', action: () => closeTab(docId) },
      { label: 'Close other tabs', action: () => setTabs([docId]) },
    ] },
    { title: 'Edit', items: [
      { label: 'Undo', shortcut: 'Ctrl+Z', action: () => run(undo) },
      { label: 'Redo', shortcut: 'Ctrl+Y', action: () => run(redo) },
      { sep: true },
      { label: 'Find & Replace…', shortcut: 'Ctrl+F', action: () => setFindOpen(true) },
      { label: 'Select inset / all', shortcut: 'Ctrl+A', action: () => run(C.selectInset) },
      { sep: true },
      { label: 'Text Style ▸', sub: [
        { label: 'Emphasized', shortcut: 'Ctrl+E', action: () => run(C.fontCommands.emph) },
        { label: 'Bold', shortcut: 'Ctrl+B', action: () => run(C.fontCommands.bold) },
        { label: 'Noun (small caps)', shortcut: 'Ctrl+Shift+N', action: () => run(C.fontCommands.noun) },
        { label: 'Underline', shortcut: 'Ctrl+U', action: () => run(C.fontCommands.underline) },
        { label: 'Strikeout', shortcut: 'Ctrl+Shift+O', action: () => run(C.fontCommands.strikeout) },
        { label: 'Typewriter', shortcut: 'Ctrl+Shift+P', action: () => run(C.fontCommands.typewriter) },
        { label: 'Sans serif', action: () => run(C.fontCommands.sans) },
        { label: 'Italic shape', action: () => run(C.fontCommands.italic) },
        { label: 'Small caps shape', action: () => run(C.fontCommands.smallcaps) },
        { label: 'Double underline', action: () => run(C.fontCommands.uuline) },
        { label: 'Wavy underline', action: () => run(C.fontCommands.uwave) },
        { sep: true },
        ...['tiny', 'scriptsize', 'footnotesize', 'small', 'normal', 'large', 'larger', 'largest', 'huge', 'giant'].map(s => ({ label: 'Size: ' + s, action: () => run(C.setValueMark('size', s === 'normal' ? null : s)) })),
        { sep: true },
        ...['red', 'blue', 'green', 'magenta', 'cyan', 'orange', 'purple', 'gray', 'none'].map(c => ({ label: 'Color: ' + c, action: () => run(C.setValueMark('color', c === 'none' ? null : c)) })),
        { sep: true },
        { label: 'Reset font', shortcut: 'Ctrl+Alt+D', action: () => run(C.fontDefault) },
      ] },
      { label: 'Paragraph ▸', sub: [
        { label: 'Paragraph settings…', shortcut: 'Ctrl+Alt+P', action: () => setDialog({ name: 'paragraph' }) },
        { sep: true },
        { label: 'Align left', shortcut: 'Alt+A L', action: () => run(C.setParagraphAttrs({ align: 'left' })) },
        { label: 'Align center', shortcut: 'Alt+A C', action: () => run(C.setParagraphAttrs({ align: 'center' })) },
        { label: 'Align right', shortcut: 'Alt+A R', action: () => run(C.setParagraphAttrs({ align: 'right' })) },
        { label: 'Justified', shortcut: 'Alt+A J', action: () => run(C.setParagraphAttrs({ align: 'block' })) },
        { label: 'Default alignment', shortcut: 'Alt+A E', action: () => run(C.setParagraphAttrs({ align: null })) },
        { label: 'Toggle indentation', shortcut: 'Alt+A I', action: () => { const p = view && C.currentParagraph(view.state); if (p) run(C.setParagraphAttrs({ noindent: !p.node.attrs.noindent })); } },
        { sep: true },
        { label: 'Increase depth', shortcut: 'Alt+Shift+→', action: () => run(C.changeDepth(1)) },
        { label: 'Decrease depth', shortcut: 'Alt+Shift+←', action: () => run(C.changeDepth(-1)) },
        { label: 'Move paragraph up', shortcut: 'Alt+↑', action: () => run(C.moveParagraph(-1)) },
        { label: 'Move paragraph down', shortcut: 'Alt+↓', action: () => run(C.moveParagraph(1)) },
      ] },
      { label: 'Table ▸', sub: [
        { label: 'Add row above', action: () => run(addRowBefore) }, { label: 'Add row below', action: () => run(addRowAfter) },
        { label: 'Add column before', action: () => run(addColumnBefore) }, { label: 'Add column after', action: () => run(addColumnAfter) },
        { label: 'Delete row', action: () => run(deleteRow) }, { label: 'Delete column', action: () => run(deleteColumn) },
        { label: 'Merge cells (multicolumn)', action: () => run(mergeCells) }, { label: 'Split cell', action: () => run(splitCell) },
        { sep: true },
        { label: 'Top line on/off', action: () => toggleCellLine('topline') }, { label: 'Bottom line on/off', action: () => toggleCellLine('bottomline') },
        { label: 'Left line on/off', action: () => toggleCellLine('leftline') }, { label: 'Right line on/off', action: () => toggleCellLine('rightline') },
        { label: 'Align cell left', action: () => run(C.setCellAttr('alignment', 'left')) }, { label: 'Align cell center', action: () => run(C.setCellAttr('alignment', 'center')) }, { label: 'Align cell right', action: () => run(C.setCellAttr('alignment', 'right')) },
        { sep: true },
        { label: 'Delete table', action: () => run(deleteTable) },
        { sep: true },
        { label: 'Table settings…', action: () => setDialog({ name: 'tablesettings' }) },
      ] },
      { label: 'Track Changes ▸', sub: [
        { label: 'Track changes', shortcut: 'Ctrl+Shift+E', checked: tracking, action: toggleTracking },
        { label: 'Accept change at cursor', disabled: !changeInfo, action: () => { const v = view; if (!v) return; const ch = changeAt(v.state, v.state.selection.from); if (ch) run(resolveChange(ch, true)); } },
        { label: 'Reject change at cursor', disabled: !changeInfo, action: () => { const v = view; if (!v) return; const ch = changeAt(v.state, v.state.selection.from); if (ch) run(resolveChange(ch, false)); } },
        { sep: true },
        { label: 'Accept all changes', action: () => run(acceptAllChanges()) },
        { label: 'Reject all changes', action: () => run(rejectAllChanges()) },
      ] },
      { sep: true },
      { label: 'Inset settings…', shortcut: 'Ctrl+Alt+I', action: () => setDialog({ name: 'inset' }) },
      { label: 'Open/close inset', shortcut: 'Ctrl+I', action: () => run(C.toggleInset) },
      { label: 'Math: toggle inline/display', action: () => run(C.toggleMathDisplay) },
    ] },
    { title: 'View', items: [
      { label: 'File browser', checked: showFiles, action: () => setShowFiles(!showFiles) },
      { label: 'Outline', shortcut: 'Ctrl+Alt+O', checked: rightTab === 'outline', action: () => setRightTab(rightTab === 'outline' ? null : 'outline') },
      { label: 'Source pane (LyX / LaTeX)', shortcut: 'Ctrl+Alt+S', checked: rightTab === 'source', action: () => setRightTab(rightTab === 'source' ? null : 'source') },
      { label: 'PDF preview', checked: rightTab === 'pdf', action: () => setRightTab(rightTab === 'pdf' ? null : 'pdf') },
      { label: 'Versions', checked: rightTab === 'versions', action: () => setRightTab(rightTab === 'versions' ? null : 'versions') },
      { sep: true },
      { label: 'Master + child documents in one view', checked: combined, action: () => setCombined(!combined) },
      { label: 'Notes & comments in the margin', checked: marginMode, action: toggleMargin },
      { label: 'Open all insets', action: () => run(C.setAllInsets('open')) },
      { label: 'Close all insets', action: () => run(C.setAllInsets('collapsed')) },
      { sep: true },
      { label: 'Zoom in', shortcut: 'Ctrl++', action: () => editorContext.ui?.zoom(1) },
      { label: 'Zoom out', shortcut: 'Ctrl+-', action: () => editorContext.ui?.zoom(-1) },
      { label: 'Reset zoom', shortcut: 'Ctrl+0', action: () => editorContext.ui?.zoom(0) },
      { label: 'Text width ▸', sub: [
        ...[['Narrow', 560], ['Normal', 720], ['Wide', 880], ['Extra wide', 1080], ['Full width', 0]].map(([l, w]) => ({ label: String(l), checked: textWidth === w, action: () => setTextWidth(w as number) })),
        { sep: true },
        { label: 'Wider', shortcut: 'Ctrl+Alt++', action: () => stepTextWidth(1) },
        { label: 'Narrower', shortcut: 'Ctrl+Alt+-', action: () => stepTextWidth(-1) },
      ] },
    ] },
    { title: 'Insert', items: [
      { label: 'Math ▸', sub: [
        { label: 'Inline formula', shortcut: 'Ctrl+M', action: () => runView(C.insertMath(false)) },
        { label: 'Display formula', shortcut: 'Ctrl+Shift+M', action: () => runView(C.insertMath(true)) },
        { label: 'Numbered equation', shortcut: 'Ctrl+Alt+N', action: () => runView(C.insertMath(true, 'equation')) },
        { label: 'AMS align environment', shortcut: 'Alt+M T A', action: () => runView(C.insertMath(true, 'align')) },
        { label: 'AMS align* (unnumbered)', action: () => runView(C.insertMath(true, 'align*')) },
        { label: 'AMS gather', action: () => runView(C.insertMath(true, 'gather')) },
        { label: 'AMS multline', action: () => runView(C.insertMath(true, 'multline')) },
        { label: 'eqnarray', action: () => runView(C.insertMath(true, 'eqnarray')) },
        { sep: true },
        { label: 'Delimiters…', action: () => setDialog({ name: 'delimiters' }) },
        { label: 'Matrix…', action: () => setDialog({ name: 'matrix' }) },
        { sep: true },
        { label: 'Math macro definition', action: () => { const n = prompt('Macro name (without backslash):'); if (n) run(C.insertMacroDef(n, Number(prompt('Number of arguments:', '0') || 0), '')); } },
      ] },
      { label: 'Special Character ▸', sub: [
        { label: 'Ellipsis …', shortcut: 'Alt+.', action: () => run(C.insertSpecial('ldots')) },
        { label: 'End of sentence', shortcut: 'Ctrl+.', action: () => run(C.insertSpecial('endofsentence')) },
        { label: 'Non-breaking dash', shortcut: 'Ctrl+Alt+-', action: () => run(C.insertSpecial('nobreakdash')) },
        { label: 'Hyphenation point', shortcut: 'Alt+-', action: () => run(C.insertSpecial('softhyphen')) },
        { label: 'Ligature break', shortcut: 'Ctrl+Shift+L', action: () => run(C.insertSpecial('ligaturebreak')) },
        { label: 'Breakable slash', shortcut: 'Ctrl+/', action: () => run(C.insertSpecial('breakableslash')) },
        { label: 'Menu separator', action: () => run(C.insertSpecial('menuseparator')) },
        { label: 'En dash –', action: () => run(C.insertHyphens('\\twohyphens')) },
        { label: 'Em dash —', action: () => run(C.insertHyphens('\\threehyphens')) },
        { label: 'LyX / TeX / LaTeX logos', action: () => run(C.insertSpecial('LaTeX')) },
        { label: 'Opening quote', action: () => run(C.insertQuote('l')) }, { label: 'Closing quote', action: () => run(C.insertQuote('r')) },
        { label: 'Single quotes ‘ ’', action: () => run(C.insertQuote('l', 'e', 's')) },
      ] },
      { label: 'Formatting ▸', sub: [
        { label: 'Line break', shortcut: 'Ctrl+Enter', action: () => run(C.insertNewline('newline')) },
        { label: 'Justified line break', shortcut: 'Ctrl+Shift+Enter', action: () => run(C.insertNewline('linebreak')) },
        { label: 'New page', action: () => run(C.insertNewpage('newpage')) },
        { label: 'Page break', action: () => run(C.insertNewpage('pagebreak')) },
        { label: 'Clear page', action: () => run(C.insertNewpage('clearpage')) },
        { sep: true },
        { label: 'Protected space', shortcut: 'Ctrl+Space', action: () => run(C.insertSpace('~')) },
        { label: 'Thin space', shortcut: 'Ctrl+Shift+Space', action: () => run(C.insertSpace('\\thinspace{}')) },
        { label: 'Interword space', action: () => run(C.insertSpace('\\space{}')) },
        { label: 'Quad space', action: () => run(C.insertSpace('\\quad{}')) },
        { label: 'Horizontal fill', action: () => run(C.insertSpace('\\hfill{}')) },
        { sep: true },
        { label: 'Vertical space (defskip)', action: () => run(C.insertVSpace('defskip')) },
        { label: 'Vertical space (bigskip)', action: () => run(C.insertVSpace('bigskip')) },
      ] },
      { label: 'Float ▸', sub: [
        { label: 'Figure', action: () => run(C.insertFloat('figure')) },
        { label: 'Table', action: () => run(C.insertFloat('table')) },
        { label: 'Algorithm', action: () => run(C.insertFloat('algorithm')) },
      ] },
      { label: 'Note ▸', sub: [
        { label: 'LyX note (not printed)', shortcut: 'Ctrl+Alt+N', action: () => run(C.insertNote('Note')) },
        { label: 'Comment (LaTeX comment)', action: () => run(C.insertNote('Comment')) },
        { label: 'Greyed out', action: () => run(C.insertNote('Greyedout')) },
      ] },
      { label: 'Comment thread', shortcut: 'Ctrl+Alt+C', action: () => run(C.insertComment) },
      { sep: true },
      { label: 'Graphics…', shortcut: 'Ctrl+Shift+G', action: () => setDialog({ name: 'graphics' }) },
      { label: 'Table…', shortcut: 'Ctrl+Alt+T', action: () => setDialog({ name: 'table' }) },
      { label: 'Caption', action: () => run(C.insertCaption) },
      { sep: true },
      { label: 'Label…', shortcut: 'Ctrl+Alt+L', action: () => setDialog({ name: 'label' }) },
      { label: 'Cross-reference…', shortcut: 'Ctrl+Shift+I', action: () => setDialog({ name: 'ref' }) },
      { label: 'Citation…', shortcut: 'Ctrl+Shift+C', action: () => setDialog({ name: 'cite' }) },
      { label: 'Hyperlink…', shortcut: 'Ctrl+Alt+K', action: () => setDialog({ name: 'href' }) },
      { label: 'Footnote', shortcut: 'Ctrl+Alt+F', action: () => run(C.insertFootnote) },
      { label: 'Marginal note', shortcut: 'Ctrl+Alt+M', action: () => run(C.insertMarginal) },
      { label: 'Index entry', action: () => run(C.insertIndex) },
      { label: 'Short title (argument)', shortcut: 'Alt+A 1', action: () => run(C.insertArgument('1')) },
      { sep: true },
      { label: 'TeX code (ERT)', shortcut: 'Ctrl+L', action: () => run(C.insertERT) },
      { label: 'Program listing', action: () => run(C.insertListing) },
      { label: 'Box', action: () => run(C.insertBox) },
      { label: 'Branch…', action: () => { const n = prompt('Branch name:'); if (n) run(C.insertBranch(n)); } },
      { label: 'Custom inset (Flex)…', action: () => { const n = prompt('Flex inset name:', meta?.flexInsets?.[0] ?? 'Code'); if (n) run(C.insertFlex(n)); } },
      { sep: true },
      { label: 'Child document…', action: () => { const fn = prompt('Child document file name (relative):', 'chapter1.lyx'); if (fn) run(C.insertInclude(fn, 'include')); } },
      { label: 'Table of contents', action: () => run(C.insertToc()) },
      { label: 'List of figures', action: () => run(C.insertToc('listoffigures')) },
      { label: 'BibTeX bibliography…', action: () => { const f = prompt('BibTeX file(s), comma separated (without .bib):', (meta?.files.filter(x => x.kind === 'bib').map(x => x.path.replace(/\.bib$/, '')).join(',') || 'references')); if (f) run(C.insertBibtex(f, prompt('Style:', 'plain') || 'plain')); } },
      { label: 'Index (print)', action: () => run(C.insertIndexPrint) },
    ] },
    { title: 'Navigate', items: [
      { label: 'Outline pane', shortcut: 'Ctrl+Alt+O', action: () => setRightTab('outline') },
      { label: 'Go to label…', action: () => { const n = prompt('Label:'); if (n) gotoLabel(n, view ?? undefined); } },
      { label: 'Next tab', shortcut: 'Ctrl+Tab', action: () => { const i = tabs.indexOf(docId); const n = tabs[(i + 1) % tabs.length]; if (n) location.hash = '#/' + n; } },
      { label: 'Beginning of document', shortcut: 'Ctrl+Home', action: () => { if (view) { view.dispatch(view.state.tr.setSelection(TextSelection.atStart(view.state.doc)).scrollIntoView()); view.focus(); } } },
      { label: 'End of document', shortcut: 'Ctrl+End', action: () => { if (view) { view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)).scrollIntoView()); view.focus(); } } },
    ] },
    { title: 'Document', items: [
      { label: 'Settings…', action: () => setDialog({ name: 'settings' }) },
      { label: 'Math macros…', action: () => setDialog({ name: 'macros' }) },
      { label: 'Change tracking', shortcut: 'Ctrl+Shift+E', checked: tracking, action: toggleTracking },
      { sep: true },
      { label: 'Reload metadata (macros, bibliography)', action: () => { if (docId) api.meta(docId).then(m => { setMeta(m); editorContext.meta = m; if (masterView) refreshMacros(masterView, m.macros); notify('Metadata reloaded'); }); } },
    ] },
    { title: 'Help', items: [
      { label: 'Keyboard shortcuts', action: () => setDialog({ name: 'help' }) },
      { label: 'About OverLyX', action: () => alert('OverLyX — a LyX-compatible collaborative WYSIWYG editor for LaTeX documents.\nDocuments are stored as native .lyx files; math is edited live with MathLive; collaboration via Yjs CRDTs.') },
    ] },
  ] : [];

  /** Entries picked in the citation dialog become known to the editor (for rendering author/year) even if they were not cited before. */
  const rememberBib = (entries: { key: string; author: string; year: string; title: string }[]) => {
    const m = editorContext.meta;
    if (!m || !entries.length) return;
    for (const e of entries) if (!m.bib.some(b => b.key === e.key)) m.bib.push(e);
    setMeta({ ...m });
  };

  const toggleCellLine = (key: string) => {
    if (!view) return;
    const $from = view.state.selection.$from;
    let cur: any = null;
    for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === 'table_cell') { cur = $from.node(d); break; }
    const attrs: [string, string][] = cur ? JSON.parse(cur.attrs.attrs || '[]') : [];
    const on = attrs.find(a => a[0] === key)?.[1] === 'true';
    run(C.setCellAttr(key, on ? null : 'true'));
  };

  const markActive = (name: string, value: string) => {
    if (!view) return false;
    const { $from, empty } = view.state.selection;
    const marks = empty ? (view.state.storedMarks ?? $from.marks()) : $from.marks();
    return marks.some(m => m.type.name === name && m.attrs.value === value);
  };

  const toolbarGroups: ToolButton[][] = [
    [
      { id: 'new', title: 'New document (Ctrl+N)', icon: 'new', action: () => editorContext.ui?.newFile() },
      { id: 'open', title: 'Open (Ctrl+O)', icon: 'open', action: () => setShowFiles(true) },
      { id: 'save', title: 'Save now (Ctrl+S)', icon: 'save', action: () => editorContext.ui?.save() },
    ],
    [
      { id: 'undo', title: 'Undo (Ctrl+Z)', icon: 'undo', action: () => run(undo) },
      { id: 'redo', title: 'Redo (Ctrl+Y)', icon: 'redo', action: () => run(redo) },
      { id: 'find', title: 'Find & replace (Ctrl+F)', icon: 'find', action: () => setFindOpen(true) },
    ],
    [
      { id: 'emph', title: 'Emphasis (Ctrl+E)', icon: 'emph', action: () => run(C.fontCommands.emph), active: markActive('emph', 'on') },
      { id: 'noun', title: 'Noun / small caps (Ctrl+Shift+N)', icon: 'noun', action: () => run(C.fontCommands.noun), active: markActive('noun', 'on') },
      { id: 'bold', title: 'Bold (Ctrl+B)', icon: 'bold', action: () => run(C.fontCommands.bold), active: markActive('series', 'bold') },
      { id: 'underline', title: 'Underline (Ctrl+U)', icon: 'underline', action: () => run(C.fontCommands.underline), active: markActive('bar', 'under') },
      { id: 'strike', title: 'Strikeout (Ctrl+Shift+O)', icon: 'strike', action: () => run(C.fontCommands.strikeout), active: markActive('strikeout', 'on') },
      { id: 'tt', title: 'Typewriter (Ctrl+Shift+P)', icon: 'tt', action: () => run(C.fontCommands.typewriter), active: markActive('family', 'typewriter') },
    ],
    [
      { id: 'depthout', title: 'Decrease depth (Alt+Shift+←)', icon: 'depthout', action: () => run(C.changeDepth(-1)) },
      { id: 'depthin', title: 'Increase depth (Alt+Shift+→)', icon: 'depthin', action: () => run(C.changeDepth(1)) },
    ],
    [
      { id: 'math', title: 'Inline formula (Ctrl+M)', icon: 'math', action: () => runView(C.insertMath(false)) },
      { id: 'dmath', title: 'Display formula (Ctrl+Shift+M)', icon: 'dmath', action: () => runView(C.insertMath(true)) },
      { id: 'graphics', title: 'Insert graphics (Ctrl+Shift+G)', icon: 'graphics', action: () => setDialog({ name: 'graphics' }) },
      { id: 'table', title: 'Insert table (Ctrl+Alt+T)', icon: 'table', action: () => setDialog({ name: 'table' }) },
      { id: 'float', title: 'Insert figure float', icon: 'float', action: () => run(C.insertFloat('figure')) },
    ],
    [
      { id: 'footnote', title: 'Footnote (Ctrl+Alt+F)', icon: 'footnote', action: () => run(C.insertFootnote) },
      { id: 'note', title: 'LyX note (Ctrl+Alt+N)', icon: 'note', action: () => run(C.insertNote('Note')) },
      { id: 'comment', title: 'Comment thread (Ctrl+Alt+C)', icon: 'comment', action: () => run(C.insertComment) },
      { id: 'label', title: 'Label (Ctrl+Alt+L)', icon: 'label', action: () => setDialog({ name: 'label' }) },
      { id: 'ref', title: 'Cross-reference (Ctrl+Shift+I)', icon: 'ref', action: () => setDialog({ name: 'ref' }) },
      { id: 'cite', title: 'Citation (Ctrl+Shift+C)', icon: 'cite', action: () => setDialog({ name: 'cite' }) },
      { id: 'href', title: 'Hyperlink (Ctrl+Alt+K)', icon: 'href', action: () => setDialog({ name: 'href' }) },
      { id: 'ert', title: 'TeX code (Ctrl+L)', icon: 'ert', action: () => run(C.insertERT) },
      { id: 'toggleinset', title: 'Open/close inset (Ctrl+I)', icon: 'toggleinset', action: () => run(C.toggleInset) },
    ],
    [
      { id: 'track', title: 'Track changes (Ctrl+Shift+E)', icon: 'track', action: toggleTracking, active: tracking },
      { id: 'margin', title: 'Show notes & comments in the margin', icon: 'margin', action: toggleMargin, active: marginMode },
      { id: 'outline', title: 'Outline (Ctrl+Alt+O)', icon: 'outline', action: () => setRightTab(rightTab === 'outline' ? null : 'outline'), active: rightTab === 'outline' },
      { id: 'pdf', title: 'View PDF (Ctrl+R)', icon: 'pdf', action: () => build('overlyx') },
    ],
  ];

  const insetDialogNode = () => {
    if (!view) return null;
    const pos = typeof dialog?.arg === 'number' ? dialog.arg : undefined;
    if (pos !== undefined) { const n = view.state.doc.nodeAt(pos); return n ? { node: n, pos } : null; }
    return C.nearestNode(view.state, ['inset', 'command', 'graphics', 'leaf', 'table']);
  };

  /** Insert LaTeX into the focused formula, or into a new inline formula at the cursor. */
  const insertInMath = (latex: string) => {
    const active = document.activeElement as any;
    if (active?.tagName === 'MATH-FIELD') { active.executeCommand(['insert', latex]); return; }
    if (view) { C.insertMath(false)(view); setTimeout(() => (document.activeElement as any)?.executeCommand?.(['insert', latex]), 60); }
  };
  const renderDialog = () => {
    if (!dialog || !view || !docId) return null;
    const close = () => { setDialog(null); view.focus(); };
    const project = viewDocId(view).split('/')[0] || docId.split('/')[0];
    const docDir = view.dom.dataset.docDir ?? editorContext.docDir;
    switch (dialog.name) {
      case 'graphics': return <GraphicsDialog meta={meta} project={project} docDir={docDir} onClose={close} onInsert={(f, o) => run(C.insertGraphics(f, o))} />;
      case 'paragraph': {
        const cur = C.currentParagraph(view.state);
        if (!cur) { setDialog(null); return null; }
        const a = cur.node.attrs;
        return <ParagraphDialog initial={{ align: a.align ?? null, spacing: a.spacing ?? null, noindent: !!a.noindent, labelwidthstring: a.labelwidthstring ?? null }} indentSeparation={!headerLines.some(l => l === '\\paragraph_separation skip')} onClose={close} onApply={p => run(C.setParagraphAttrs({ ...p }))} />;
      }
      case 'tablesettings': {
        const ctx = C.tableContext(view.state);
        if (!ctx) { setDialog(null); notify('The cursor is not in a table'); return null; }
        const m = (json: string) => new Map<string, string>((() => { try { return JSON.parse(json || '[]'); } catch { return []; } })());
        const columns: [string, string][][] = (() => { try { return JSON.parse(ctx.table.attrs.columns || '[]'); } catch { return []; } })();
        // LyX keeps lines on cells: the row tab shows a line as set when every cell of the row has it
        const rowAttrs = m(ctx.row.attrs.attrs);
        for (const k of ['topline', 'bottomline']) { let all = true; ctx.row.forEach(c => { if (m(c.attrs.attrs).get(k) !== 'true') all = false; }); rowAttrs.set(k, all ? 'true' : ''); }
        return <TableSettingsDialog initial={{ cell: m(ctx.cell.attrs.attrs), column: new Map(columns[ctx.colIndex] ?? []), row: rowAttrs, table: m(ctx.table.attrs.features), rowIndex: ctx.rowIndex, colIndex: ctx.colIndex, nrows: ctx.nrows, ncols: ctx.ncols }} onClose={close} onApply={ch => run(C.setTableAttrs(ch))} />;
      }
      case 'delimiters': return <DelimiterDialog onClose={close} onInsert={latex => insertInMath(latex)} />;
      case 'matrix': return <MatrixDialog onClose={close} onInsert={latex => insertInMath(latex)} />;
      case 'table': return <TableDialog onClose={close} onInsert={(r, c) => run(C.insertTable(r, c))} />;
      case 'label': return <LabelDialog initial={suggestLabel(view)} onClose={close} onInsert={n => run(C.insertLabel(n))} />;
      case 'ref': {
        const target = dialog.arg as { pos?: number; node?: any; prefill?: string } | undefined;
        if (target?.node && target.pos !== undefined) {
          const p = commandParams(target.node);
          const tpos = target.pos, tnode = target.node;
          return <RefDialog labels={labels} useRefstyle={!!meta?.useRefstyle} initial={{ name: unquote(p.get('reference')), kind: p.get('LatexCommand') ?? 'ref' }} onClose={close}
            onInsert={(n, k) => { const params = [`LatexCommand ${k}`, `reference "${n}"`, 'plural "false"', 'caps "false"', 'noprefix "false"', 'nolink "false"', '']; view.dispatch(view.state.tr.setNodeMarkup(tpos, undefined, { ...tnode.attrs, params: JSON.stringify(params) })); }} />;
        }
        return <RefDialog labels={labels} useRefstyle={!!meta?.useRefstyle} initial={target?.prefill ? { name: target.prefill, kind: 'ref' } : undefined} onClose={close} onInsert={(n, k) => run(C.insertRef(n, k))} />;
      }
      case 'cite': {
        const target = dialog.arg as { pos: number; node: any } | undefined;
        if (target?.node) {
          const p = commandParams(target.node);
          return <CiteDialog meta={meta} docId={docId} initial={{ keys: unquote(p.get('key')).split(',').map(k => k.trim()).filter(Boolean), cmd: p.get('LatexCommand') ?? 'cite', before: unquote(p.get('before')), after: unquote(p.get('after')) }} onClose={close}
            onInsert={(keys, cmd, b, a, entries) => { rememberBib(entries); const params = [`LatexCommand ${cmd}`]; if (a) params.push(`after "${a}"`); if (b) params.push(`before "${b}"`); params.push(`key "${keys.join(',')}"`, 'literal "false"', ''); view.dispatch(view.state.tr.setNodeMarkup(target.pos, undefined, { ...target.node.attrs, params: JSON.stringify(params) })); }} />;
        }
        return <CiteDialog meta={meta} docId={docId} onClose={close} onInsert={(keys, cmd, b, a, entries) => { rememberBib(entries); run(C.insertCite(keys, cmd, b, a)); }} />;
      }
      case 'href': return <HrefDialog onClose={close} onInsert={(t, n) => run(C.insertHref(t, n))} />;
      case 'settings': return <SettingsDialog docId={docId} meta={meta} headerLines={headerLines} onClose={close} onSaved={() => api.meta(docId).then(m => { setMeta(m); editorContext.meta = m; if (masterView) refreshMacros(masterView, m.macros); })} />;
      case 'help': return <HelpDialog onClose={close} />;
      case 'macros': return <MacrosDialog meta={meta} onClose={close} />;
      case 'tex': return <TexDialog tex={String(dialog.arg ?? '')} onClose={close} />;
      case 'layout': return <LayoutPicker layouts={layouts} onClose={close} onPick={n => run(C.setLayout(n))} />;
      case 'argument': { run(C.insertArgument(String(dialog.arg ?? '1'))); setDialog(null); return null; }
      case 'inset': {
        const target = insetDialogNode();
        if (!target) { setDialog(null); notify('No inset at the cursor'); return null; }
        if (target.node.type.name === 'graphics') {
          const params: string[] = (() => { try { return JSON.parse(target.node.attrs.params || '[]'); } catch { return []; } })();
          return <GraphicsDialog meta={meta} project={project} docDir={docDir} initial={C.graphicsOpts(params)} onClose={close}
            onInsert={(f, o) => view.dispatch(view.state.tr.setNodeMarkup(target.pos, undefined, { ...target.node.attrs, params: JSON.stringify(C.graphicsParams(f, o)) }))} />;
        }
        if (target.node.type.name === 'command' && target.node.attrs.cmd === 'href') {
          const p = commandParams(target.node);
          return <HrefDialog initial={{ target: unquote(p.get('target')), name: unquote(p.get('name')) }} onClose={close} onInsert={(t, n) => view.dispatch(view.state.tr.setNodeMarkup(target.pos, undefined, { ...target.node.attrs, params: JSON.stringify(['LatexCommand href', `name "${n}"`, `target "${t}"`, 'literal "false"', '']) }))} />;
        }
        if (target.node.type.name === 'table') { setDialog({ name: 'tablesettings' }); return null; }
        return <InsetDialog node={target.node} onClose={close} onApply={attrs => view.dispatch(view.state.tr.setNodeMarkup(target.pos, undefined, { ...target.node.attrs, ...attrs }))} />;
      }
    }
    return null;
  };

  const sourceTarget: SourceTarget | null = (() => {
    if (!view) return null;
    if (masterView && view === masterView && editorRef.current) return { view, ydoc: editorRef.current.ydoc, docId: docId! };
    for (const [id, h] of childRefs.current) if (h.view === view) return { view, ydoc: h.ydoc, docId: id };
    return editorRef.current ? { view: editorRef.current.view, ydoc: editorRef.current.ydoc, docId: docId! } : null;
  })();

  return (
    <div class="app">
      <MenuBar menus={menus} user={user} onLogout={onLogout} right={docId ? <span class="doc-title" title={docId}>{docLabel}{meta?.master && !combined && <> · child of <a href={'#/' + meta.master} onClick={e => { e.preventDefault(); openInTab(meta.master!); }}>{meta.master.split('/').pop()}</a></>}</span> : null} />
      {docId && <Toolbar layouts={layouts} layout={layout} onLayout={n => run(C.setLayout(n))} groups={toolbarGroups} />}
      {tabs.length > 0 && <TabBar tabs={tabs} current={docId} onSelect={id => { location.hash = '#/' + id; }} onClose={closeTab} onReorder={setTabs} />}
      {docId && findOpen && (
        <div class="find-bar">
          <span>Find:</span><input autofocus value={findQ} onInput={e => { setFindQ((e.target as HTMLInputElement).value); if (view) setQuery(view, (e.target as HTMLInputElement).value, false); }} onKeyDown={e => { if (e.key === 'Enter' && view) findNext(view, e.shiftKey ? -1 : 1); if (e.key === 'Escape') { setFindOpen(false); if (view) { setQuery(view, '', false); view.focus(); } } }} />
          <button class="small-btn" onClick={() => view && findNext(view, 1)}>Next</button>
          <button class="small-btn" onClick={() => view && findNext(view, -1)}>Prev</button>
          <span>Replace:</span><input value={replQ} onInput={e => setReplQ((e.target as HTMLInputElement).value)} />
          <button class="small-btn" onClick={() => view && replaceCurrent(view, replQ)}>Replace</button>
          <button class="small-btn" onClick={() => { if (view) notify(`Replaced ${replaceAll(view, replQ)} occurrence(s)`); }}>Replace all</button>
          <span style="color:#666">{view ? `${findKey.getState(view.state)?.matches.length ?? 0} matches` : ''}</span>
          <span style="flex:1" /><button class="small-btn" onClick={() => { setFindOpen(false); if (view) { setQuery(view, '', false); view.focus(); } }}>✕</button>
        </div>
      )}
      <div class="main">
        {showFiles && <div class="sidebar"><div class="panel-tabs"><button class="active">Files</button><button onClick={() => setShowFiles(false)}>✕</button></div><div class="panel-body"><FileBrowser current={docId} refreshKey={refreshKey} onOpen={id => openInTab(id)} /></div></div>}
        <div class={'editor-scroll' + (marginMode ? ' margin-mode' : '')} onClick={e => { if (e.target === e.currentTarget && view) view.focus(); }}>
          {docId ? (
            <div class="editor-page">
              <div class="editor-host" ref={containerRef} />
              {combined && childIds.map(id => (
                <ChildEditor key={id} id={id} user={user} marginMode={marginMode} onSelection={onSelection} onDocChange={() => { setSaved(false); setDocTick(t => t + 1); }}
                  register={(cid, h) => { if (h) childRefs.current.set(cid, h); else childRefs.current.delete(cid); rerender(); }} />
              ))}
            </div>
          ) : <Welcome onOpen={() => setShowFiles(true)} />}
        </div>
        {docId && rightTab && (
          <div class={'sidebar right' + (rightTab === 'pdf' ? ' wide' : rightTab === 'source' ? ' source' : '')}>
            <div class="panel-tabs">
              <button class={rightTab === 'outline' ? 'active' : ''} onClick={() => setRightTab('outline')}>Outline</button>
              <button class={rightTab === 'source' ? 'active' : ''} onClick={() => setRightTab('source')} title="LyX / LaTeX source (Ctrl+Alt+S)">Source</button>
              <button class={rightTab === 'pdf' ? 'active' : ''} onClick={() => setRightTab('pdf')}>PDF</button>
              <button class={rightTab === 'versions' ? 'active' : ''} onClick={() => { setRightTab('versions'); setSelVersion(v => v + 1); }}>Versions</button>
              <button onClick={() => setRightTab(null)}>✕</button>
            </div>
            {rightTab === 'outline' && <div class="panel-body"><Outline view={masterView} items={outline} activePos={activePos} /></div>}
            {rightTab === 'source' && <SourcePane target={sourceTarget} tick={docTick} selTick={selTick} onNotify={notify} />}
            {rightTab === 'pdf' && <PdfPanel docId={docId} state={pdf} onBuild={build} onShowTex={() => setDialog({ name: 'tex', arg: pdf.tex ?? '' })} />}
            {rightTab === 'versions' && <div class="panel-body"><Versions docId={docId} refreshKey={selVersion} /></div>}
          </div>
        )}
      </div>
      <StatusBar layout={layout} status={status} chord={chord} message={message} saved={saved} tracking={tracking} trackingAs={user.name} change={changeInfo}
        docLabel={view && masterView && view !== masterView ? viewDocId(view).split('/').pop() ?? null : null} />
      {renderDialog()}
    </div>
  );
}

/** Child documents (\include / \input of .lyx files) of a master, in document order. */
function collectChildren(view: EditorView): string[] {
  const out: string[] = [];
  const project = view.dom.dataset.project ?? '', docDir = view.dom.dataset.docDir ?? '';
  view.state.doc.descendants((node) => {
    const id = C.includeTarget(node, project, docDir);
    if (id && id.endsWith('.lyx') && !out.includes(id)) out.push(id);
    return true;
  });
  return out;
}

function ChildEditor({ id, user, marginMode, onSelection, onDocChange, register }: { id: string; user: User; marginMode: boolean; onSelection: (v: EditorView) => void; onDocChange: () => void; register: (id: string, h: EditorHandle | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>({ connected: false, synced: false, users: [] });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let handle: EditorHandle | null = null;
    let cancelled = false;
    // the child's metadata (macros inherited from the master) must exist before we connect
    api.meta(id).then(m => {
      if (cancelled || !ref.current) return;
      ref.current.innerHTML = '';
      handle = createEditor({ docId: id, user, container: ref.current, marginMode, child: true, onStatus: setStatus, onSelectionChange: onSelection, onDocChange, onStale: () => setTimeout(() => location.reload(), 800) });
      register(id, handle);
      refreshMacros(handle.view, m.macros, true);
      handle.provider.on('sync', () => { if (handle) refreshMacros(handle.view, m.macros, true); });
    }).catch(e => { if (!cancelled) setError(String((e as Error).message)); });
    return () => { cancelled = true; if (handle) { register(id, null); handle.destroy(); } };
  }, [id]);
  return (
    <div class="child-doc">
      <div class="child-doc-header">
        <span class="name">📄 {id.split('/').pop()}</span>
        <span class="path">{id}</span>
        <span style="flex:1" />
        <span class="sync">{error ? 'not available' : status.connected ? (status.synced ? 'connected' : 'syncing…') : 'connecting…'}</span>
        {!error && <a href={'#/' + id} class="small-btn" title="Open this child document in its own tab">Open in tab</a>}
      </div>
      {error ? <div class="child-doc-error">Child document cannot be opened: {error}</div> : <div class="editor-host child" ref={ref} />}
    </div>
  );
}

function TabBar({ tabs, current, onSelect, onClose, onReorder }: { tabs: string[]; current: string | null; onSelect: (id: string) => void; onClose: (id: string) => void; onReorder: (t: string[]) => void }) {
  const drag = useRef<string | null>(null);
  const base = (id: string) => id.split('/').pop() ?? id;
  // disambiguate tabs with the same file name by prefixing the project
  const counts = new Map<string, number>();
  for (const t of tabs) counts.set(base(t), (counts.get(base(t)) ?? 0) + 1);
  return (
    <div class="tabbar" role="tablist">
      {tabs.map(id => (
        <a key={id} href={'#/' + id} role="tab" class={'tab' + (id === current ? ' active' : '')} title={id} draggable
          onClick={e => { if (!e.ctrlKey && !e.metaKey && !e.shiftKey && e.button === 0) { e.preventDefault(); onSelect(id); } }}
          onAuxClick={e => { if (e.button === 1) { e.preventDefault(); onClose(id); } }}
          onDragStart={() => { drag.current = id; }}
          onDragOver={e => e.preventDefault()}
          onDrop={e => { e.preventDefault(); const from = drag.current; if (!from || from === id) return; const t = tabs.filter(x => x !== from); t.splice(t.indexOf(id), 0, from); onReorder(t); }}>
          <span class="tab-name">{(counts.get(base(id)) ?? 0) > 1 ? id.split('/')[0] + '/' : ''}{base(id)}</span>
          <button class="tab-close" title="Close tab (middle-click)" onClick={e => { e.preventDefault(); e.stopPropagation(); onClose(id); }}>×</button>
        </a>
      ))}
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

function Welcome({ onOpen }: { onOpen: () => void }) {
  return (
    <div style="max-width:640px;margin:60px auto;background:#fff;padding:30px 40px;border-radius:8px;box-shadow:0 1px 6px rgba(0,0,0,0.2)">
      <h2 style="margin-top:0;color:#3b6ea5">Welcome to OverLyX</h2>
      <p>Open a <b>.lyx</b> document from the file browser on the left, or create a new one inside a project. Everything you edit is saved as a native LyX file — you can keep using LyX on the same files.</p>
      <ul>
        <li>Formulas are edited in place (Ctrl+M / Ctrl+Shift+M) and rendered while you type; document macros are honoured.</li>
        <li>Several people can edit the same document simultaneously; changes merge automatically.</li>
        <li>Use <b>View ▸ Notes &amp; comments in the margin</b> to show LyX notes and comment threads next to the text.</li>
        <li>Press <b>Ctrl+R</b> to compile the PDF with LaTeX.</li>
      </ul>
      <button class="btn primary" onClick={onOpen}>Open the file browser</button>
    </div>
  );
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

/** One colour per LyX author for change tracking (stable across sessions: by author id order). */
function applyAuthorColors(authors: { id: number; name: string }[]): void {
  const palette = ['#2e7d32', '#c62828', '#1565c0', '#6a1b9a', '#ef6c00', '#00838f', '#ad1457', '#4e342e', '#558b2f', '#283593'];
  let el = document.getElementById('ol-author-colors') as HTMLStyleElement | null;
  if (!el) { el = document.createElement('style'); el.id = 'ol-author-colors'; document.head.appendChild(el); }
  el.textContent = authors.map((a, i) => `.lyx-change[data-author="${a.id}"], .lyx-inset[data-author="${a.id}"] { --change-color: ${palette[i % palette.length]}; }`).join('\n');
}

function hashAuthor(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h | 0;
}

function debounce<T extends (...a: any[]) => void>(fn: T, ms: number): T {
  let t: ReturnType<typeof setTimeout> | null = null;
  return ((...a: any[]) => { if (t) clearTimeout(t); t = setTimeout(() => fn(...a), ms); }) as T;
}

export { schema };
