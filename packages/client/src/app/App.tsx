import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'preact/hooks';
import type { EditorView } from 'prosemirror-view';
import { nodeText } from '../editor/cliptext';
import { NodeSelection, TextSelection } from 'prosemirror-state';
import { undo, redo } from 'y-prosemirror';
import { addColumnAfter, addColumnBefore, addRowAfter, addRowBefore, deleteColumn, deleteRow, deleteTable, mergeCells, splitCell } from 'prosemirror-tables';
import { api, type AiStatus, type BibAddResult, type DocMeta, type User, fileUrl } from '../api';
import { getPrefs, setPref, subscribePrefs, type Prefs } from '../prefs';
import { openRewrite, REWRITE_KEY } from '../editor/ai/rewrite';
import { Login } from './Login';
import { FileBrowser } from './FileBrowser';
import { Home, projectDocs } from './Home';
import { TextEditor } from './TextEditor';
import { ShareDialog } from './Share';
import { GitDialog } from './Git';
import type { Mark } from 'prosemirror-model';
import { MenuBar, openPalette, PALETTE_LABEL, PALETTE_DEFAULT, type MenuDef } from './MenuBar';
import { setThemePref, useTheme } from './theme';
import { Toolbar, ColorPalette, colorIcon, NAMED_COLORS, DelimPalette, TableSizePicker, delimLatex, mathPanelPalettes, mathPreview, type ToolButton, type DelimChoice } from './Toolbar';
import { Outline, buildOutline, type OutlineItem } from './Outline';
import { Comments } from './Comments';
import { Versions } from './Versions';
import { PdfPanel, stateFromBuild, jobActive, type PdfState } from './PdfPanel';
import { Ruler, NOTE_SCALE_DEFAULT, NOTE_SCALE_MIN, NOTE_SCALE_MAX } from './Ruler';
import { StatusBar, type Status } from './StatusBar';
import { SourcePane, type SourceTarget, cursorLine } from './SourcePane';
import { activeMathField, mathFocusListeners, mathCursorListeners, type LyxMathField } from '../editor/lyxmath/field';
import { Tour, tourWanted, rememberTour, type TourEnd } from './Tour';
import { FeedbackDialog } from './Feedback';
import { Dialog, GraphicsDialog, TableDialog, LabelDialog, RefDialog, CiteDialog, HrefDialog, SettingsDialog, InsetDialog, HelpDialog, TexDialog, MacrosDialog, ParagraphDialog, TableSettingsDialog, DelimiterDialog, MatrixDialog, commandParams, HELP_ROWS, AiRepairDialog, PreferencesDialog } from './Dialogs';
import { createEditor, refreshMacros, describeChange, type EditorHandle, type SaveState } from '../editor/editor';
import { newerVersionAvailable } from './update';
import { generateLyx } from './SourcePane';
import { editorContext, viewDocId } from '../editor/context';
import { navHistory, type NavLocation } from './navhistory';
import { restoredCursorPos } from '../editor/cursormemory';
import { PdfViewer, type PdfTarget } from './PdfViewer';
import { locateSourceLine, type LocateBlock } from './sourcelocate';
import { canonical, effectiveShortcut, keyFromEvent } from './keybindings';
import { STANDARD_LAYOUTS } from '../editor/layouts';
import { chordKey } from '../editor/keymap';
import { moveSection, shiftSection } from '../editor/outline';
import * as C from '../editor/commands';
import { setMarginMode } from '../editor/plugins/margin';
import { acceptAllChanges, rejectAllChanges, changeAt, resolveChange, gotoChange, resolveSelectionChanges, hasChanges, changesFilterKey, setChangesFilter } from '../editor/plugins/changes';
import * as T from '../editor/tablecommands';
import type { PresenceUser } from '../editor/editor';
import { setQuery, findNext, replaceCurrent, replaceAll, findKey } from '../editor/plugins/find';
import { schema, unquote, llanglePreamble, hasLlangleSnippet, definesLlangle } from '@overlyx/core';

type Dialog = { name: string; arg?: unknown } | null;

/** Document ▸ Statistics: words and characters of the selection or the whole document (notes and comments excluded, like LyX's default). */
function StatsDialog({ view, onClose }: { view: EditorView; onClose: () => void }) {
  const stats = useMemo(() => {
    const sel = view.state.selection;
    const count = (text: string) => ({ words: (text.match(/[\p{L}\p{N}]+(?:[’'\-][\p{L}\p{N}]+)*/gu) ?? []).length, chars: text.replace(/\s/g, '').length, charsSpaces: text.length });
    const textOf = (from: number, to: number) => {
      let out = '';
      view.state.doc.nodesBetween(from, to, (node, pos) => {
        if (node.type.name === 'inset' && /^Note$/.test(node.attrs.name)) return false;   // LyX notes / comments are not counted
        if (node.isText) out += node.text!.slice(Math.max(0, from - pos), Math.max(0, to - pos));
        else if (node.isAtom && node.isInline) out += nodeText(node);
        else if (node.isTextblock) out += '\n';
        return true;
      });
      return out;
    };
    return { selection: sel.empty ? null : count(textOf(sel.from, sel.to)), document: count(textOf(0, view.state.doc.content.size)) };
  }, [view, view.state.doc, view.state.selection]);
  const row = (label: string, c: { words: number; chars: number; charsSpaces: number }) => <tr><td>{label}</td><td>{c.words.toLocaleString()}</td><td>{c.chars.toLocaleString()}</td><td>{c.charsSpaces.toLocaleString()}</td></tr>;
  return <Dialog title="Statistics" onClose={onClose} buttons={<button onClick={onClose}>Close</button>}>
    <table class="stats"><thead><tr><th></th><th>Words</th><th>Characters</th><th>Characters (with spaces)</th></tr></thead>
      <tbody>{stats.selection && row('Selection', stats.selection)}{row('Document', stats.document)}</tbody></table>
    <p class="hint">Formulas count as one word each; LyX notes and comments are not counted.</p>
  </Dialog>;
}

/** LyX language name → BCP 47 tag (for the browser's spell checker). */
function bcp47(lyxLang: string): string {
  const t: Record<string, string> = {
    english: 'en', american: 'en-US', british: 'en-GB', canadian: 'en-CA', australian: 'en-AU', newzealand: 'en-NZ',
    german: 'de', ngerman: 'de', 'german-ch': 'de-CH', 'ngerman-ch': 'de-CH', austrian: 'de-AT', naustrian: 'de-AT',
    french: 'fr', spanish: 'es', 'spanish-mexico': 'es-MX', italian: 'it', dutch: 'nl', portuguese: 'pt', brazilian: 'pt-BR',
    russian: 'ru', ukrainian: 'uk', polish: 'pl', czech: 'cs', slovak: 'sk', slovene: 'sl', croatian: 'hr', serbian: 'sr',
    swedish: 'sv', danish: 'da', norsk: 'nb', nynorsk: 'nn', finnish: 'fi', icelandic: 'is', estonian: 'et', latvian: 'lv', lithuanian: 'lt',
    greek: 'el', turkish: 'tr', hungarian: 'hu', romanian: 'ro', bulgarian: 'bg', hebrew: 'he', arabic_arabi: 'ar', arabic_arabtex: 'ar',
    japanese: 'ja', 'japanese-cjk': 'ja', 'chinese-simplified': 'zh-Hans', 'chinese-traditional': 'zh-Hant', korean: 'ko',
    catalan: 'ca', basque: 'eu', galician: 'gl', irish: 'ga', welsh: 'cy', latin: 'la', esperanto: 'eo', afrikaans: 'af', indonesian: 'id', malay: 'ms', thai: 'th', vietnamese: 'vi', hindi: 'hi', farsi: 'fa',
  };
  return t[lyxLang] ?? lyxLang.slice(0, 2);
}

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [google, setGoogle] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    api.me().then(r => {
      setUser(r.user); setGoogle(r.google);
      // remembered for offline starts (the session cookie itself is still valid then)
      try { if (r.user) localStorage.setItem('ol.user', JSON.stringify(r.user)); else localStorage.removeItem('ol.user'); } catch { /* ignore */ }
    }).catch(() => {
      // no server (offline): continue with the last known user; documents come from the local copies
      try { const u = localStorage.getItem('ol.user'); if (u) setUser(JSON.parse(u)); } catch { /* ignore */ }
    }).finally(() => setReady(true));
  }, []);
  if (!ready) return <div style="padding:40px;color:#666">Loading…</div>;
  if (!user) return <Login google={google} onLogin={setUser} />;
  return <Workspace user={user} onLogout={() => api.logout().then(clearLocalData).then(() => { try { localStorage.removeItem('ol.user'); } catch { /* ignore */ } setUser(null); })} />;
}

/** Forget everything cached in this browser (API responses cached by the service worker, local document copies). */
async function clearLocalData(): Promise<void> {
  try { if ('caches' in window) for (const k of await caches.keys()) if (k.startsWith('overlyx-api')) await caches.delete(k); } catch { /* ignore */ }
  try {
    const dbs = await (indexedDB as any).databases?.() as { name?: string }[] | undefined;
    for (const d of dbs ?? []) if (d.name?.startsWith('overlyx:')) indexedDB.deleteDatabase(d.name);
  } catch { /* ignore */ }
}

type RightTab = 'outline' | 'comments' | 'pdf' | 'versions';
const RIGHT_TABS = ['outline', 'comments', 'pdf', 'versions'] as const;
const RIGHT_TAB_LABELS: Record<RightTab, string> = { outline: 'Outline', comments: 'Comments', pdf: 'PDF', versions: 'Versions' };
const RIGHT_TAB_TITLES: Record<RightTab, string> = { outline: 'Outline (Ctrl+Alt+O)', comments: 'Comment threads: open ones and the resolved archive', pdf: 'PDF preview', versions: 'Versions of this document' };
const SOURCE_TITLE = 'LaTeX source below the text (Ctrl+Alt+S)';
const stored = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };

/** `#/project/path.lyx?goto=label`, or a share link `#/share/<token>` */
function parseHash(): { id: string | null; goto: string | null; share: string | null } {
  const raw = location.hash.replace(/^#\/?/, '');
  const q = raw.indexOf('?');
  const idPart = decodeURIComponent(q >= 0 ? raw.slice(0, q) : raw);
  if (idPart.startsWith('share/')) return { id: null, goto: null, share: idPart.slice('share/'.length) };
  const goto = q >= 0 ? new URLSearchParams(raw.slice(q + 1)).get('goto') : null;
  return { id: idPart || null, goto, share: null };
}

type ToolbarId = 'standard' | 'extra' | 'math' | 'mathpanels' | 'table' | 'review';
type ToolbarMode = 'on' | 'off' | 'auto';
type ToolbarPrefs = Partial<Record<ToolbarId, ToolbarMode>>;
const DEFAULT_TOOLBARS: ToolbarPrefs = { standard: 'on', extra: 'on', math: 'auto', mathpanels: 'on', table: 'auto', review: 'auto' };
function loadToolbarPrefs(): ToolbarPrefs { try { return { ...DEFAULT_TOOLBARS, ...JSON.parse(localStorage.getItem('ol.toolbars') || '{}') }; } catch { return { ...DEFAULT_TOOLBARS }; } }
/** Button faces of the math panels (LyX shows a representative symbol) */
const MATH_PANEL_PREVIEW: Record<string, string> = {
  functions: '\\sin', space: '\\square\\,\\square', 'sqrt-square': '\\sqrt{x}', style: '\\displaystyle\\textstyle', 'frac-square': '\\frac{a}{b}', font: '\\mathbb{R}', latex_dots: '\\cdots', latex_deco: '\\hat{a}',
  latex_arrow: '\\rightarrow', latex_bop: '\\otimes', latex_brel: '\\leq', latex_greek: '\\alpha', latex_misc: '\\infty', latex_varsz: '\\sum', latex_ams_misc: '\\square', latex_ams_arrows: '\\rightrightarrows',
  latex_ams_rel: '\\leqslant', latex_ams_nrel: '\\nleq', latex_ams_ops: '\\boxtimes', latex_delim: '\\lfloor\\rfloor',
};
const MATH_PANEL_ICONS: Record<string, string> = { style: 'Style' };

/** Navigate ▸ Back / Forward (navhistory.ts); the ids are the menu paths, so the palette can rebind them */
const NAV_BACK_ID = 'Navigate ▸ Back', NAV_FORWARD_ID = 'Navigate ▸ Forward';
const NAV_BACK_KEY = 'Ctrl+Alt+←', NAV_FORWARD_KEY = 'Ctrl+Alt+→';

function loadTabs(): string[] { try { const t = JSON.parse(localStorage.getItem('ol.tabs') || '[]'); return Array.isArray(t) ? t.filter(x => typeof x === 'string') : []; } catch { return []; } }

function Workspace({ user, onLogout }: { user: User; onLogout: () => void }) {
  // the tab in the hash: a document, "text:"/"pdf:" files, or "raw:<document>" — the document beside its LaTeX source
  const [hashId, setHashId] = useState<string | null>(parseHash().id);
  const docId = hashId ? hashId.replace(/^raw:/, '') : null;
  const rawSplit = !!hashId && hashId.startsWith('raw:');
  // tabs hold .tex documents (the collaborative editor) and other text files (a plain text editor,
  // ids prefixed with "text:")
  const isTextTab = !!docId && docId.startsWith('text:');
  // PDF files of a project open in the PDF viewer (ids prefixed with "pdf:")
  const isPdfTab = !!docId && docId.startsWith('pdf:');
  const textId = docId ? docId.replace(/^(text|pdf):/, '') : null;
  const isLyxDoc = !!docId && !isTextTab && docId.endsWith('.tex');
  const [tabs, setTabs] = useState<string[]>(loadTabs);
  const [tabMenu, setTabMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [meta, setMeta] = useState<DocMeta | null>(null);
  const [headerLines, setHeaderLines] = useState<string[]>([]);
  const [status, setStatus] = useState<Status>({ connected: false, synced: false, users: [] });
  const [layout, setLayout] = useState('Standard');
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [activePos, setActivePos] = useState(0);
  // sidebars: shown / hidden state is kept per browser (a hidden sidebar leaves a rail to bring it back)
  const [showFiles, setShowFiles] = useState(() => stored('ol.files') !== '0');
  const [rightTab, setRightTab] = useState<RightTab | null>(() => { const v = stored('ol.right'); return v === null ? 'outline' : (RIGHT_TABS as readonly string[]).includes(v) ? v as RightTab : null; });
  // the LaTeX source is a panel below the writing area with its own switch
  const [showSource, setShowSource] = useState(() => stored('ol.source') === '1');
  useEffect(() => { try { localStorage.setItem('ol.files', showFiles ? '1' : '0'); localStorage.setItem('ol.right', rightTab ?? ''); localStorage.setItem('ol.source', showSource ? '1' : '0'); } catch { /* ignore */ } }, [showFiles, rightTab, showSource]);
  const [pdf, setPdf] = useState<PdfState>({ url: null, log: '', busy: false, ok: null, warnings: [] });
  const [dialog, setDialog] = useState<Dialog>(null);
  const [message, setMessage] = useState<{ text: string; kind: 'info' | 'error' } | null>(null);
  const [marginMode, setMarginModeState] = useState(localStorage.getItem('ol.margin') === '1');
  const [combined, setCombined] = useState(localStorage.getItem('ol.combined') === '1');
  const [childIds, setChildIds] = useState<string[]>([]);
  const [tracking, setTracking] = useState(false);
  const [chord, setChord] = useState<string | null>(null);
  const [changeInfo, setChangeInfo] = useState<string | null>(null);
  const [save, setSave] = useState<SaveState>({ state: 'connecting', pending: false, savedAt: 0, unavailable: false });
  const [reloadKey, setReloadKey] = useState(0);
  // A newer client build is deployed (checked after every (re)connect, when the tab comes back to
  // the foreground and every 15 minutes): offer a reload; do it unasked only while the tab is hidden
  // and nothing is half-done (all edits confirmed by the server, no dialog open).
  const [updateReady, setUpdateReady] = useState(false);
  useEffect(() => {
    if (!status.connected || updateReady) return;
    let alive = true;
    const check = () => { void newerVersionAvailable().then(v => { if (alive && v) setUpdateReady(true); }); };
    const t = setTimeout(check, 3000);
    const iv = setInterval(check, 15 * 60000);
    const onVisible = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { alive = false; clearTimeout(t); clearInterval(iv); document.removeEventListener('visibilitychange', onVisible); };
  }, [status.connected, updateReady]);
  useEffect(() => {
    if (!updateReady) return;
    const quietReload = () => {
      if (document.visibilityState !== 'hidden' || save.pending || save.state !== 'saved' || document.querySelector('.dialog-backdrop')) return;
      location.reload();
    };
    quietReload();
    document.addEventListener('visibilitychange', quietReload);
    return () => document.removeEventListener('visibilitychange', quietReload);
  }, [updateReady, save.pending, save.state]);
  const [zoom, setZoom] = useState(Number(localStorage.getItem('ol.zoom') || 1));
  // width of the text column in px (0 = full width), see View ▸ Text width
  const [textWidth, setTextWidth] = useState<number>(() => { const v = Number(localStorage.getItem('ol.textWidth')); return Number.isFinite(v) && localStorage.getItem('ol.textWidth') !== null ? v : 720; });
  const stepTextWidth = (d: number) => setTextWidth(w => (d === 0 ? 720 : Math.min(1600, Math.max(400, (w || 1200) + d * 60))));
  // text size of notes and comments, in % of the document text (the ruler's − / + buttons in margin mode)
  const [noteScale, setNoteScale] = useState<number>(() => { const v = Number(localStorage.getItem('ol.noteScale')); return v >= NOTE_SCALE_MIN && v <= NOTE_SCALE_MAX ? v : NOTE_SCALE_DEFAULT; });
  useEffect(() => {
    document.documentElement.style.setProperty('--note-size', noteScale / 100 + 'em');
    localStorage.setItem('ol.noteScale', String(noteScale));
  }, [noteScale]);
  // Toolbars that come and go with the cursor (the math rows appear when a formula is entered)
  // move the page below them: keep what is on screen where it is by scrolling the same amount.
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollTop = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) { scrollTop.current = null; return; }
    const top = el.getBoundingClientRect().top;
    if (scrollTop.current !== null && top !== scrollTop.current) el.scrollTop += top - scrollTop.current;
    scrollTop.current = top;
  });
  const [showRuler, setShowRuler] = useState(localStorage.getItem('ol.ruler') !== '0');
  useEffect(() => { localStorage.setItem('ol.ruler', showRuler ? '1' : '0'); }, [showRuler]);
  const [findOpen, setFindOpen] = useState(false);
  // sharing: the project whose share dialog is open; view-only when the current project was shared for viewing
  const [shareFor, setShareFor] = useState<string | null>(null);
  // the project whose git dialog (clone URL, tokens, history) is open
  const [gitFor, setGitFor] = useState<string | null>(null);
  /** the interactive walkthrough: offered once per browser, restartable from Help */
  const [tour, setTour] = useState<'intro' | 'steps' | null>(() => (tourWanted() ? 'intro' : null));
  const [viewOnly, setViewOnly] = useState(false);
  // LyX toolbars: standard / extra always (unless hidden), math / table / review on, off or automatic (LyX's "auto")
  const { pref: themePref } = useTheme();
  // per-browser preferences (spell checking, AI assistance) and whether the server can answer AI requests
  const [prefs, setPrefsState] = useState<Prefs>(getPrefs);
  useEffect(() => subscribePrefs(setPrefsState), []);
  const [ai, setAi] = useState<AiStatus | null>(null);
  // completions in flight (a small indicator in the status bar; several may overlap briefly)
  const [aiBusy, setAiBusy] = useState(0);
  useEffect(() => { editorContext.aiBusy = (on) => setAiBusy(n => Math.max(0, n + (on ? 1 : -1))); return () => { editorContext.aiBusy = undefined; }; }, []);
  useEffect(() => { api.aiStatus().then(s => { editorContext.ai = s; setAi(s); }).catch(() => { const s = { available: false, model: '', completionModel: '', models: [] }; editorContext.ai = s; setAi(s); }); }, []);
  const [toolbars, setToolbars] = useState<ToolbarPrefs>(loadToolbarPrefs);
  useEffect(() => { localStorage.setItem('ol.toolbars', JSON.stringify(toolbars)); }, [toolbars]);
  const setToolbar = (id: ToolbarId, mode: ToolbarMode) => setToolbars(t => ({ ...t, [id]: mode }));
  const tbMode = (id: ToolbarId): ToolbarMode => toolbars[id] ?? 'auto';
  // the formula being edited (LyX shows the math toolbar while the cursor is in math)
  const [mathField, setMathField] = useState<LyxMathField | null>(null);
  useEffect(() => { const l = (f: LyxMathField | null) => setMathField(f); mathFocusListeners.add(l); return () => { mathFocusListeners.delete(l); }; }, []);
  // cursor moves inside a formula count as selection changes (source pane, status bar)
  useEffect(() => { const l = () => setSelTick(t => t + 1); mathCursorListeners.add(l); return () => { mathCursorListeners.delete(l); }; }, []);
  const [findQ, setFindQ] = useState(''), [replQ, setReplQ] = useState('');
  const [findCase, setFindCase] = useState(false), [findWord, setFindWord] = useState(false);
  const [findRegex, setFindRegex] = useState(false), [findMath, setFindMath] = useState(false), [findSel, setFindSel] = useState(false);
  const [findAdv, setFindAdv] = useState(false);
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
    const onHash = () => {
      const h = parseHash(); pendingGoto.current = h.goto; setHashId(h.id);
      if (h.id?.startsWith('text:')) navHistory.visit(h.id, null);
      if (h.goto && h.id === editorContext.docId) runGoto();
    };
    navHistory.load();
    const h0 = parseHash().id;
    if (h0?.startsWith('text:')) navHistory.visit(h0, null);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => navHistory.subscribe(rerender), []);
  // a share link (#/share/<token>): join the project, then open its main document
  useEffect(() => {
    const check = () => {
      const token = parseHash().share;
      if (!token) return;
      api.acceptShare(token).then(r => {
        notify(`You can now ${r.role === 'view' ? 'view' : 'edit'} “${r.title ?? r.project}”`);
        setRefreshKey(k => k + 1);
        location.hash = r.doc ? '#/' + r.doc : '';
      }).catch(e => { notify((e as Error).message, 'error'); location.hash = ''; });
    };
    check();
    window.addEventListener('hashchange', check);
    return () => window.removeEventListener('hashchange', check);
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
  // A new text width reflows the whole document: keep the cursor where it is on screen (the ruler
  // is dragged with the eyes on the text) by scrolling by the amount the cursor moved.
  useEffect(() => {
    const v = activeViewRef.current;
    const scroller = scrollRef.current;
    const cursorTop = () => { try { return v && v.dom.isConnected ? v.coordsAtPos(v.state.selection.from).top : null; } catch { return null; } };
    const before = cursorTop();
    document.documentElement.style.setProperty('--text-width', textWidth > 0 ? textWidth + 'px' : '100%');
    localStorage.setItem('ol.textWidth', String(textWidth));
    const after = cursorTop();
    if (scroller && before !== null && after !== null && after !== before) scroller.scrollTop += after - before;
  }, [textWidth]);
  useEffect(() => { localStorage.setItem('ol.tabs', JSON.stringify(tabs)); }, [tabs]);
  useEffect(() => { editorContext.combined = combined; localStorage.setItem('ol.combined', combined ? '1' : '0'); }, [combined]);

  // every opened document gets a tab, inserted right of the tab it was opened from
  const lastDoc = useRef<string | null>(null);
  const addTab = (t: string[], id: string, after: string | null): string[] => {
    if (t.includes(id)) return t;
    const i = after ? t.indexOf(after) : -1;
    return i < 0 ? [...t, id] : [...t.slice(0, i + 1), id, ...t.slice(i + 1)];
  };
  useEffect(() => { if (hashId) { setTabs(t => addTab(t, hashId, lastDoc.current)); lastDoc.current = hashId; } }, [hashId]);

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
    if (navHistory.jump(() => views.some(v => gotoLabelIn(v, name)))) return;
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

  const onSelection = (view: EditorView, info?: { docChanged: boolean }) => {
    activeViewRef.current = view; editorContext.activeView = view;
    navHistory.visitState(viewDocId(view), view.state, { docChanged: !!info?.docChanged });
    const p = C.currentParagraph(view.state);
    setLayout(p ? p.node.attrs.layout : '');
    if (view === editorRef.current?.view) setActivePos(view.state.selection.from);
    setChord(chordKey.getState(view.state) ?? null);
    const ch = changeAt(view.state, view.state.selection.from);
    setChangeInfo(ch ? describeChange(ch.type, ch.author, ch.time) : null);
    setSelTick(t => t + 1);
    rerender();
  };

  /** Presence avatar clicked: jump to where that user is editing (in the master or a child editor). */
  const jumpToUser = (u: PresenceUser) => {
    if (u.self) { const v = editorRef.current?.view; if (v) { v.focus(); v.dispatch(v.state.tr.scrollIntoView()); } return; }
    const handles = [editorRef.current, ...childRefs.current.values()].filter((h): h is EditorHandle => !!h);
    const hit = navHistory.jump(() => handles.find(h => h.gotoUser(u.clientId)));
    if (hit) notify(`Jumped to ${u.name}'s cursor`);
    else notify(`${u.name} has no cursor in this document (yet)`, 'error');
  };

  /**
   * Navigation history (navhistory.ts): Back / Forward show an earlier place — in an open editor
   * (the master or a child of the combined view) right away, else by switching to that document's
   * tab, where the editor puts the cursor there once the document is loaded (`initialCursor`).
   */
  const pendingNav = useRef<NavLocation | null>(null);
  const showLocation = (loc: NavLocation) => {
    if (loc.docId.startsWith('text:')) { navHistory.restored(); if (parseHash().id !== loc.docId) location.hash = '#/' + loc.docId; return; }
    const handles = [editorRef.current, ...childRefs.current.values()].filter((h): h is EditorHandle => !!h);
    const h = handles.find(x => viewDocId(x.view) === loc.docId);
    if (h) {
      const v = h.view;
      const doc = v.state.doc;
      const pos = loc.cursor ? restoredCursorPos(doc, loc.cursor) : 0;
      try { v.dispatch(v.state.tr.setSelection(TextSelection.near(doc.resolve(Math.min(pos, doc.content.size)))).scrollIntoView().setMeta('addToHistory', false)); } catch { /* not a valid place any more */ }
      navHistory.restored();
      v.focus();
      return;
    }
    pendingNav.current = loc;
    if (parseHash().id !== loc.docId) location.hash = '#/' + loc.docId;
  };
  const navBack = useCallback(() => { const loc = navHistory.back(); if (loc) showLocation(loc); else notify('Nothing to go back to'); }, []);
  const navForward = useCallback(() => { const loc = navHistory.forward(); if (loc) showLocation(loc); else notify('Nothing to go forward to'); }, []);
  // Ctrl+Alt+← / Ctrl+Alt+→ (⌥⌘← / ⌥⌘→) wherever the focus is (formula fields, panels, text-file tabs);
  // a rebound command is run by the palette's listener, which marks the event handled (defaultPrevented)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const k = keyFromEvent(e);
      if (!k) return;
      const action = k === canonical(effectiveShortcut(NAV_BACK_ID, NAV_BACK_KEY)) ? navBack : k === canonical(effectiveShortcut(NAV_FORWARD_ID, NAV_FORWARD_KEY)) ? navForward : null;
      if (!action) return;
      e.preventDefault(); e.stopImmediatePropagation();
      action();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // create / destroy the editor when the document changes (metadata first, so formulas render once with the right macros)
  useEffect(() => {
    editorRef.current?.destroy();
    editorRef.current = null; activeViewRef.current = null;
    setMeta(null); setOutline([]); setChildIds([]); setPdf({ url: null, log: '', busy: false, ok: null, warnings: [] });
    setDialog(null);   // a dialog belongs to the document it was opened in
    if (!docId || !containerRef.current) return;
    containerRef.current.innerHTML = '';
    editorContext.user = user; editorContext.docId = docId; editorContext.project = docId.split('/')[0]; editorContext.meta = null;
    editorContext.docDir = docId.split('/').slice(1, -1).join('/');
    // never carry the previous document's author id / tracking state over (changes would be mis-attributed)
    editorContext.changeAuthorId = undefined; editorContext.trackChanges = false;
    let cancelled = false;
    let loadMeta: () => void = () => {};
    const scheduleOutline = debounce((view: EditorView) => { setOutline(buildOutline(view.state.doc, true, editorContext.meta?.secnumdepth ?? 3)); setChildIds(collectChildren(view)); }, 300);
    setSave({ state: 'connecting', pending: false, savedAt: 0, unavailable: false });
    // The editor loads its local copy and connects right away; the metadata request runs in
    // parallel. Until it has arrived the editor is read-only and formulas only show their source
    // (their macros are not known yet), so nothing is rendered twice.
    const handle: EditorHandle = createEditor({
      docId, user, container: containerRef.current, marginMode, readOnly: true,
      onStatus: setStatus,
      onSaveState: (st) => { if (!cancelled) setSave(st); },
      onSelectionChange: onSelection,
      initialCursor: () => { const p = pendingNav.current; if (p && p.docId === docId) { pendingNav.current = null; return p.cursor; } return null; },
      onDocChange: (view) => { setDocTick(t => t + 1); scheduleOutline(view); },
      onStale: (info) => { void resolveStale(handle, docId, info.pendingLocal); },
      // access revoked or role changed: the metadata tells the new role (or 403 → the tab closes)
      onAccessChanged: () => loadMeta(),
      onGone: (reason) => {
        if (cancelled) return;
        if (/reset/.test(reason)) return;   // handled by the epoch / stale-history flow
        notify(`${docId}: ${reason} — the tab was closed (a copy is in the project's versions)`, 'error');
        closeTab(hashId!);
      },
    });
    editorRef.current = handle; activeViewRef.current = handle.view; editorContext.activeView = handle.view;
    // header lines live in the Y meta map
    const metaMap = handle.ydoc.getMap<string>('meta');
    const readHeader = () => { try { setHeaderLines(JSON.parse(metaMap.get('header') ?? '[]')); } catch { /* ignore */ } };
    readHeader(); metaMap.observe(readHeader);
    const h = handle;
    let firstSync = true;
    h.provider.on('sync', () => {
      if (firstSync) { firstSync = false; navHistory.visitState(docId, h.view.state); }
      setOutline(buildOutline(h.view.state.doc, true, editorContext.meta?.secnumdepth ?? 3));
      setChildIds(collectChildren(h.view));
      setDocTick(x => x + 1);
      setTimeout(runGoto, 50);
    });
    const withMeta = (m: DocMeta | null) => {
      if (cancelled) return;
      if (m) {
        setMeta(m); editorContext.meta = m;
        // the browser's spell checker picks its dictionary from the lang attribute
        h.view.dom.lang = bcp47(m.language);
        applyAuthorColors(m.authors);
        setTracking(m.trackingChanges);
        editorContext.trackChanges = m.trackingChanges;
        editorContext.changeAuthorId = m.authors.find(x => x.name === user.name)?.id;
      }
      refreshMacros(h.view, m?.macros ?? {});
      const ro = m?.role === 'view';
      setViewOnly(ro);
      h.setViewOnly(ro);
      h.setEditable(!ro);
      setOutline(buildOutline(h.view.state.doc, true, m?.secnumdepth ?? 3));
      rerender();
    };
    let metaRetry: ReturnType<typeof setTimeout> | undefined;
    let metaAttempt = 0;
    loadMeta = () => {
      clearTimeout(metaRetry);
      api.meta(docId).then(m => {
        metaAttempt = 0;
        // a .tex file that is not a document (a preamble / macro file opened by URL) belongs to the text editor
        const rel = docId.slice(docId.indexOf('/') + 1);
        const entry = m.files?.find(f => f.path === rel);
        if (entry && entry.kind === 'tex') { location.hash = '#/text:' + docId; return; }
        withMeta(m);
      }).catch((e: Error & { status?: number }) => {
        if (cancelled) return;
        if (e.status === 403) { notify(e.message || 'You no longer have access to this project', 'error'); closeTab(hashId!); return; }
        if (!navigator.onLine) { notify('Offline: document metadata (macros, bibliography) not available', 'error'); withMeta(null); return; }
        // online, but the server could not deliver the metadata: without it tracked changes could not be
        // attributed and macros would not render — keep the document read-only and retry
        metaAttempt++;
        const delay = Math.min(30000, 2000 * 2 ** Math.min(metaAttempt - 1, 4));
        notify(`Could not load document metadata: ${e.message}${metaAttempt <= 8 ? ' — read-only until it loads, retrying…' : ' — read-only; reload the page to try again'}`, 'error');
        h.setEditable(false);
        if (metaAttempt <= 8) metaRetry = setTimeout(loadMeta, delay);
      });
    };
    loadMeta();
    rerender();
    return () => { cancelled = true; clearTimeout(metaRetry); handle.destroy(); editorRef.current = null; };
  }, [docId, reloadKey]);

  /**
   * The server's copy of the document has a different history than our local copy (the server
   * re-created the document, e.g. after its database was reset). Yjs cannot merge unrelated
   * histories, so: keep any unsynced local edits as a version on the server (they can be compared
   * and restored from the Versions panel), drop the local copy and load the server's document.
   */
  const resolveStale = async (h: EditorHandle, id: string, pendingLocal: boolean) => {
    let kept = '';
    if (pendingLocal) {
      const name = `offline changes by ${user.name} (not merged)`;
      try {
        const lyx = generateLyx({ view: h.view, ydoc: h.ydoc, docId: id });
        await api.createVersion(id, name, lyx);
        kept = `Your unsynced edits were kept as the version “${name}” — open Versions to compare or restore them.`;
      } catch {
        try {
          const lyx = generateLyx({ view: h.view, ydoc: h.ydoc, docId: id });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(new Blob([lyx], { type: 'application/x-lyx' }));
          a.download = (id.split('/').pop() ?? 'document.tex').replace(/\.tex$/, '') + '-offline-changes.lyx';
          a.click();
          kept = 'Your unsynced edits could not be stored on the server; they were downloaded as a .lyx file instead (import it into the project to recover them).';
        } catch { kept = 'Your unsynced edits could not be kept.'; }
      }
    }
    await h.discardLocal();
    alert(`The document on the server was re-created while this copy was open, so the local copy cannot be merged and will be reloaded.${kept ? '\n\n' + kept : ''}`);
    setReloadKey(k => k + 1);
  };

  // UI hooks for keymap / node views
  useEffect(() => {
    editorContext.notify = notify;
    editorContext.openDialog = (name, arg) => setDialog({ name, arg });
    editorContext.openInsetDialog = (_view, pos) => { if (pos !== undefined) setDialog({ name: 'inset', arg: pos }); };
    editorContext.openInTab = openInTab;
    editorContext.gotoLabel = gotoLabel;
    (window as any).overlyx = editorContext;   // handy for tests / debugging
    editorContext.ui = {
      save: () => {
        if (!docId) return;
        const st = editorRef.current?.saveState();
        if (st?.state === 'offline') { notify('You are offline — your changes are kept on this device and will be saved automatically when the connection is back'); return; }
        api.save(docId).then(() => notify('All changes are saved automatically — written to ' + docId.split('/').pop())).catch(e => notify(String(e.message), 'error'));
      },
      viewPdf: () => build(),
      syncToPdf: () => { void syncToPdf(); },
      updatePdf: () => build(),
      find: () => setFindOpen(true),
      openDialog: (name, arg) => setDialog({ name, arg }),
      toggleTrackChanges: () => toggleTracking(),
      toggleOutline: () => setRightTab(t => (t === 'outline' ? null : 'outline')),
      toggleSource: () => setShowSource(s => !s),
      toggleCombined: () => setCombined(c => !c),
      acceptAll: () => run(acceptAllChanges()),
      rejectAll: () => run(rejectAllChanges()),
      closeTab: () => { if (hashId) closeTab(hashId); },
      zoom: (d) => setZoom(z => (d === 0 ? 1 : Math.min(2.5, Math.max(0.5, +(z + d * 0.1).toFixed(2))))),
      textWidth: stepTextWidth,
      openFile: () => setShowFiles(true),
      newFile: () => { const p = textId?.split('/')[0]; if (p) { const name = prompt('New document name:', 'untitled.tex'); if (name) api.newDoc(p, name, { title: name.replace(/\.(tex|lyx)$/, '') }).then(r => { location.hash = '#/' + r.id; setRefreshKey(k => k + 1); }); } },
    };
  });

  const view = activeViewRef.current ?? editorRef.current?.view ?? null;
  const masterView = editorRef.current?.view ?? null;
  const run = (cmd: (state: any, dispatch: any, view?: any) => boolean) => { const v = activeViewRef.current ?? editorRef.current?.view; if (!v) return; cmd(v.state, v.dispatch, v); v.focus(); };
  const runView = (fn: (v: EditorView) => boolean) => { const v = activeViewRef.current ?? editorRef.current?.view; if (!v) return; fn(v); };

  // PDF builds are background jobs on the server: start one, then poll its status (also picks up
  // a build that is already running for this document, e.g. started from another tab)
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollBuild = useCallback((id: string, announce: boolean) => {
    if (pollRef.current) clearTimeout(pollRef.current);
    const step = async () => {
      if (editorContext.docId !== id) return;
      let r: Awaited<ReturnType<typeof api.build>>;
      try { r = await api.build(id); } catch { pollRef.current = setTimeout(step, 3000); return; }
      if (editorContext.docId !== id) return;
      setPdf(p => stateFromBuild(p, r));
      if (jobActive(r.job)) { pollRef.current = setTimeout(step, 1000); return; }
      if (announce && r.job) notify(r.job.status === 'ok' ? 'PDF built' : r.job.status === 'cancelled' ? 'PDF build cancelled' : 'PDF build failed — see log', r.job.status === 'ok' ? 'info' : 'error');
    };
    void step();
  }, []);
  useEffect(() => () => { if (pollRef.current) clearTimeout(pollRef.current); }, []);
  // when a document opens: show its last PDF, and resume polling if a build is running
  useEffect(() => { if (docId) pollBuild(docId, false); }, [docId]);

  const build = async () => {
    if (!docId) return;
    setRightTab('pdf');
    setPdf(p => ({ ...p, busy: true }));
    try {
      const r = await api.export(docId, 'pdf');
      setPdf(p => ({ ...p, busy: true, job: r.job ?? p.job }));
      pollBuild(docId, true);
    } catch (e) {
      setPdf(p => ({ ...p, busy: false, ok: false, log: String((e as Error).message) }));
      notify('Could not start the PDF build: ' + String((e as Error).message), 'error');
    }
  };
  const cancelBuild = async () => {
    if (!docId) return;
    await api.cancelBuild(docId).catch(() => {});
    pollBuild(docId, true);
  };
  /** SyncTeX: the place in the PDF to show (forward search) */
  const [syncTarget, setSyncTarget] = useState<PdfTarget | null>(null);
  /** the LaTeX the last build compiled (fetched once, kept with the build state) */
  const builtTex = async (): Promise<string | null> => {
    if (!docId) return null;
    if (pdf.tex) return pdf.tex;
    try { const r = await api.build(docId, true); const t = r.build?.tex ?? null; if (t) setPdf(p => ({ ...p, tex: t })); return t; } catch { return null; }
  };
  /** Forward search: the cursor's line in the built LaTeX (sourcelocate) → its box in the PDF (synctex view) → scroll + flash there. */
  const syncToPdf = async () => {
    if (!docId || !view || !isLyxDoc) return;
    const tex = await builtTex();
    if (!tex) { notify('SyncTeX needs a built PDF — build it first (Ctrl+R)', 'error'); return; }
    const where = cursorLine(view, tex, mathField, null);
    if (!where) { notify('Could not find the cursor\'s place in the LaTeX source', 'error'); return; }
    try {
      const { boxes } = await api.synctexView(docId, where.line + 1);
      if (!boxes.length) { notify(`SyncTeX has no position for line ${where.line + 1} of the built LaTeX`, 'error'); return; }
      const b = boxes[0];
      setRightTab('pdf');
      setSyncTarget({ page: b.page, x: b.h, y: b.v - b.H, w: b.W, h: b.H, seq: Date.now() });
    } catch (e) { notify('SyncTeX: ' + (e as Error).message, 'error'); }
  };
  /** Inverse search (a double-click in the PDF): synctex edit → the source line → the paragraph / formula with those words, cursor there. */
  const syncFromPdf = async (page: number, x: number, y: number) => {
    if (!docId || !view) return;
    try {
      const r = await api.synctexEdit(docId, page, x, y);
      if (!r.line) { notify('SyncTeX: nothing is known about this place in the PDF', 'error'); return; }
      const tex = await builtTex();
      if (!tex) return;
      const blocks: (LocateBlock & { pos: number })[] = [];
      view.state.doc.descendants((node, pos) => {
        if (node.type.name === 'math_display') { blocks.push({ kind: 'math', text: String(node.attrs.latex ?? ''), pos }); return false; }
        if (node.isTextblock) blocks.push({ kind: 'text', text: node.textBetween(0, node.content.size, undefined, '\u0000'), pos: pos + 1 });
        return true;
      });
      const hit = locateSourceLine(tex, r.line - 1, blocks);
      if (!hit) { notify(`SyncTeX: line ${r.line} of the LaTeX source was not found in the document`, 'error'); return; }
      const b = blocks[hit.index];
      const pos = Math.min(b.kind === 'math' ? b.pos : b.pos + hit.offset, view.state.doc.content.size);
      view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos))).scrollIntoView());
      view.focus();
    } catch (e) { notify('SyncTeX: ' + (e as Error).message, 'error'); }
  };
  const showTex = async () => {
    if (!docId) return;
    if (pdf.tex) { setDialog({ name: 'tex', arg: pdf.tex }); return; }
    try { const r = await api.build(docId, true); if (r.build?.tex) { setPdf(p => ({ ...p, tex: r.build!.tex })); setDialog({ name: 'tex', arg: r.build.tex }); return; } } catch { /* fall through */ }
    const r = await api.export(docId, 'tex');
    setDialog({ name: 'tex', arg: r.tex ?? '' });
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

  const [repairing, setRepairing] = useState(false);
  const runRepair = async () => {
    if (!docId) return;
    setRepairing(true);
    try {
      const r = await api.repair(docId);
      const m = await api.meta(docId);
      setMeta(m); editorContext.meta = m;
      if (r.fixed.length) notify(`Repaired: ${r.fixed.join(', ')}${r.remaining.length ? ` — ${r.remaining.length} issue(s) still need attention` : ''}`);
      else notify(r.remaining.length ? 'Nothing here can be fixed automatically — try Escalate to AI' : 'No issues found');
    } catch (e) { notify(String(e), 'error'); }
    finally { setRepairing(false); }
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

  const labelNames = () => labels.map(l => l.name);
  const refCountOf = (nm: string): number => {
    if (!view || !nm) return 0;
    let n = 0;
    view.state.doc.descendants(node => {
      if (node.type.name === 'command' && node.attrs.cmd === 'ref') {
        const target = unquote(commandParams(node).get('reference'));
        if (target.split(',').map(t => t.trim()).includes(nm)) n++;
      }
      return true;
    });
    return n;
  };

  const layouts = meta?.layouts?.length ? meta.layouts : STANDARD_LAYOUTS;
  const base = (id: string) => id.split('/').pop() ?? id;
  // the project's name: the tab already names the file (a combined master shows the children it includes)
  const docLabel = docId ? (combined && childIds.length ? [docId, ...childIds].map(base).join(' + ') : docId.replace(/^(text|pdf):/, '').split('/')[0]) : '';

  // Help is available everywhere (the start screen has no other menus; feedback must be reachable there)
  const helpMenu: MenuDef = { title: 'Help', search: true, items: [
    { label: PALETTE_LABEL, shortcut: PALETTE_DEFAULT, action: openPalette },
    { label: 'Take the tour', action: () => setTour('intro') },
    { label: 'Keyboard shortcuts', action: () => setDialog({ name: 'help' }) },
    { sep: true },
    { label: 'Report a problem / send feedback…', action: () => setDialog({ name: 'feedback' }) },
    { label: 'About OverLyX', action: () => alert('OverLyX — a LyX-like collaborative WYSIWYG editor for LaTeX documents.\nDocuments are ordinary .tex files (change tracking and comments live in the file as macros and comment blocks); formulas are edited with a port of LyX\'s math editor; collaboration via Yjs CRDTs.') },
  ] };
  const textFileMenus: MenuDef[] = docId ? [
    { title: 'File', items: [
      { label: 'Open (file browser)', shortcut: 'Ctrl+O', action: () => setShowFiles(true) },
      ...(isPdfTab ? [] : [{ label: 'Saved automatically (Ctrl+S saves now)', disabled: true, action: () => {} }]),
      { sep: true },
      { label: 'Download', action: () => window.open(`/api/projects/${encodeURIComponent(textId!.split('/')[0])}/file/${textId!.split('/').slice(1).map(encodeURIComponent).join('/')}`) },
      { label: 'Share project…', action: () => setShareFor(textId!.split('/')[0]) },
      { label: 'Git repository…', action: () => setGitFor(textId!.split('/')[0]) },
      { sep: true },
      { label: 'Close tab', action: () => closeTab(hashId!) },
      { label: 'Close other tabs', action: () => setTabs([docId]) },
    ] },
  ] : [];
  /** the font marks the toolbar reports: stored marks / marks at the caret, or the marks of the first selected text */
  const marksAtCursor = (): readonly Mark[] => {
    if (!view) return [];
    const { $from, empty } = view.state.selection;
    if (empty) return view.state.storedMarks ?? $from.marks();
    return $from.nodeAfter?.marks ?? $from.marks();
  };
  /** the value of a font mark at the cursor (null when unset) */
  const markValue = (name: string): string | null => (marksAtCursor().find(m => m.type.name === name)?.attrs.value as string | undefined) ?? null;
  const textColor = markValue('color');
  // the shortcut table is searchable too (a match opens the table)
  const helpSearchEntries = useMemo(() => HELP_ROWS.map(([k, v]) => ({ id: 'Keyboard shortcuts ▸ ' + v, label: v, path: ['Keyboard shortcuts'], shortcut: k, fixed: true, action: () => setDialog({ name: 'help' }) })), []);
  const menus: MenuDef[] = [...(docId && !isLyxDoc ? textFileMenus : docId ? [
    { title: 'File', items: [
      { label: 'New…', shortcut: 'Ctrl+N', action: () => editorContext.ui?.newFile() },
      { label: 'Open (file browser)', shortcut: 'Ctrl+O', action: () => setShowFiles(true) },
      { label: save.state === 'offline' ? 'Offline — changes are saved on this device' : save.state === 'saving' ? 'Saving…' : 'All changes saved automatically', disabled: true, action: () => {} },
      { sep: true },
      { label: 'Export ▸', sub: [
        { label: 'PDF (latexmk)', shortcut: 'Ctrl+R', action: () => build() },
        { label: 'LaTeX source (as built)…', action: async () => { const r = await api.export(docId, 'tex'); setDialog({ name: 'tex', arg: r.tex ?? '' }); } },
        { label: 'Download .tex', action: () => window.open(`/api/docs/${encodeURIComponent(docId)}/tex?download=1`) },
        { label: 'Download PDF', action: () => window.open(`/api/docs/${encodeURIComponent(docId)}/pdf?download=1`) },
      ] },
      { label: 'Versions…', action: () => setRightTab('versions') },
      { label: 'Share project…', action: () => setShareFor(docId.split('/')[0]) },
      { label: 'Git repository…', action: () => setGitFor(docId.split('/')[0]) },
      { sep: true },
      { label: 'Close tab', action: () => closeTab(hashId!) },
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
        { label: 'Italic', shortcut: 'Ctrl+I', action: () => run(C.fontCommands.italic) },
        { label: 'Bold', shortcut: 'Ctrl+B', action: () => run(C.fontCommands.bold) },
        { label: 'Noun (small caps)', shortcut: 'Ctrl+Shift+N', action: () => run(C.fontCommands.noun) },
        { label: 'Underline', shortcut: 'Ctrl+U', action: () => run(C.fontCommands.underline) },
        { label: 'Strikeout', shortcut: 'Ctrl+Shift+O', action: () => run(C.fontCommands.strikeout) },
        { label: 'Typewriter', action: () => run(C.fontCommands.typewriter) },   // Ctrl+Shift+P is the command palette
        { label: 'Sans serif', action: () => run(C.fontCommands.sans) },
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
      { label: 'Text colour ▸', sub: [
        { label: 'Default (no colour)', checked: !textColor, action: () => run(C.setValueMark('color', null)) },
        { sep: true },
        ...NAMED_COLORS.map(([name]) => ({ label: name[0].toUpperCase() + name.slice(1), checked: textColor === name, action: () => run(C.setValueMark('color', name)) })),
        { sep: true },
        { label: 'Custom colour… (palette on the toolbar)', checked: !!textColor && textColor.startsWith('#'), action: () => (document.querySelector('[data-tb="textcolor"]') as HTMLButtonElement | null)?.click() },
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
        { sep: true },
        { label: 'Move section up', action: () => run(moveSection(-1)) },
        { label: 'Move section down', action: () => run(moveSection(1)) },
        { label: 'Promote section (heading level up)', action: () => run(shiftSection(-1, undefined, meta?.layouts)) },
        { label: 'Demote section (heading level down)', action: () => run(shiftSection(1, undefined, meta?.layouts)) },
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
      { label: 'Document health ▸', sub: [
        { label: meta?.health.length ? `${meta.health.length} issue(s) found` : 'No issues found', disabled: true },
        { label: 'Repair', disabled: !meta?.health.some(h => h.fixable), action: runRepair },
        { label: 'Escalate to AI…', disabled: !meta?.health.length, action: () => setDialog({ name: 'airepair' }) },
      ] },
      { sep: true },
      { label: 'Inset settings…', shortcut: 'Ctrl+Alt+Shift+I', action: () => setDialog({ name: 'inset' }) },
      { label: 'Open/close inset', shortcut: 'Ctrl+Alt+I', action: () => run(C.toggleInset) },
      { label: 'Math: toggle inline/display', action: () => run(C.toggleMathDisplay) },
    ] },
    { title: 'View', items: [
      { label: 'LaTeX source beside the document (… [raw] tab)', checked: rawSplit, action: () => { if (docId) location.hash = '#/' + (rawSplit ? docId : 'raw:' + docId); } },
      { label: 'File browser', checked: showFiles, action: () => setShowFiles(!showFiles) },
      { label: 'Outline', shortcut: 'Ctrl+Alt+O', checked: rightTab === 'outline', action: () => setRightTab(rightTab === 'outline' ? null : 'outline') },
      { label: 'Source pane (LaTeX, below the text)', shortcut: 'Ctrl+Alt+S', checked: showSource, action: () => setShowSource(!showSource) },
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
      { label: 'Ruler', checked: showRuler, action: () => setShowRuler(r => !r) },
      { label: 'Theme ▸', sub: [
        { label: 'Follow the system', checked: themePref === 'system', action: () => setThemePref('system') },
        { label: 'Light', checked: themePref === 'light', action: () => setThemePref('light') },
        { label: 'Dark', checked: themePref === 'dark', action: () => setThemePref('dark') },
      ] },
      { label: 'Toolbars ▸', sub: [
        { label: 'Standard', checked: tbMode('standard') !== 'off', action: () => setToolbar('standard', tbMode('standard') === 'off' ? 'on' : 'off') },
        { label: 'Extra', checked: tbMode('extra') !== 'off', action: () => setToolbar('extra', tbMode('extra') === 'off' ? 'on' : 'off') },
        { sep: true },
        ...(['math', 'table', 'review'] as ToolbarId[]).flatMap(id => [
          { label: `${id[0].toUpperCase()}${id.slice(1)}: automatic (when the cursor is in ${id === 'math' ? 'a formula' : id === 'table' ? 'a table' : 'a document with tracked changes'})`, checked: tbMode(id) === 'auto', action: () => setToolbar(id, 'auto') },
          { label: `${id[0].toUpperCase()}${id.slice(1)}: always shown`, checked: tbMode(id) === 'on', action: () => setToolbar(id, 'on') },
          { label: `${id[0].toUpperCase()}${id.slice(1)}: hidden`, checked: tbMode(id) === 'off', action: () => setToolbar(id, 'off') },
        ]),
        { sep: true },
        { label: 'Math panels (with the math toolbar)', checked: tbMode('mathpanels') !== 'off', action: () => setToolbar('mathpanels', tbMode('mathpanels') === 'off' ? 'on' : 'off') },
      ] },
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
        { label: 'LyX note (not printed)', shortcut: 'Ctrl+Alt+Shift+N', action: () => run(C.insertNote('Note')) },
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
      { label: 'Child document…', action: () => { const fn = prompt('Child document file name (relative):', 'chapter1.tex'); if (fn) run(C.insertInclude(fn, 'include')); } },
      { label: 'Table of contents', action: () => run(C.insertToc()) },
      { label: 'List of figures', action: () => run(C.insertToc('listoffigures')) },
      { label: 'BibTeX bibliography…', action: () => { const f = prompt('BibTeX file(s), comma separated (without .bib):', (meta?.files.filter(x => x.kind === 'bib').map(x => x.path.replace(/\.bib$/, '')).join(',') || 'references')); if (f) run(C.insertBibtex(f, prompt('Style:', 'plain') || 'plain')); } },
      { label: 'Index (print)', action: () => run(C.insertIndexPrint) },
    ] },
    { title: 'Navigate', items: [
      { label: 'Outline pane', shortcut: 'Ctrl+Alt+O', action: () => setRightTab('outline') },
      { label: 'Go to label…', action: () => { const n = prompt('Label:'); if (n) gotoLabel(n, view ?? undefined); } },
      { label: 'Sync to PDF (forward search)', shortcut: 'Ctrl+Alt+J', action: () => { void syncToPdf(); } },
      { sep: true },
      { label: 'Back', shortcut: NAV_BACK_KEY, disabled: !navHistory.canBack(), action: navBack },
      { label: 'Forward', shortcut: NAV_FORWARD_KEY, disabled: !navHistory.canForward(), action: navForward },
      { label: 'Next tab', action: () => { const i = tabs.indexOf(hashId!); const n = tabs[(i + 1) % tabs.length]; if (n) location.hash = '#/' + n; } },
      { label: 'Beginning of document', shortcut: 'Ctrl+Home', action: () => { if (view) { view.dispatch(view.state.tr.setSelection(TextSelection.atStart(view.state.doc)).scrollIntoView()); view.focus(); } } },
      { label: 'End of document', shortcut: 'Ctrl+End', action: () => { if (view) { view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)).scrollIntoView()); view.focus(); } } },
    ] },
    { title: 'Document', items: [
      { label: 'Settings…', action: () => setDialog({ name: 'settings' }) },
      { label: 'Start Appendix Here', checked: !!(view && C.currentParagraph(view.state)?.node.attrs.appendix), action: () => run(C.toggleAppendix) },
      { label: 'Math macros…', action: () => setDialog({ name: 'macros' }) },
      { label: 'Statistics (word count)…', action: () => setDialog({ name: 'stats' }) },
      { label: 'Change tracking', shortcut: 'Ctrl+Shift+E', checked: tracking, action: toggleTracking },
      { sep: true },
      { label: 'Reload metadata (macros, bibliography)', action: () => { if (docId) api.meta(docId).then(m => { setMeta(m); editorContext.meta = m; if (masterView) refreshMacros(masterView, m.macros); notify('Metadata reloaded'); }); } },
    ] },
    { title: 'Tools', items: [
      { label: 'Spell checking', checked: prefs.spellcheck, action: () => setPref('spellcheck', !prefs.spellcheck) },
      { sep: true },
      { label: 'AI assistance ▸', sub: [
        { label: ai === null ? 'Checking the server…' : ai.available ? `Models: ${prefs.aiModel || ai.model} (⌘K) · ${prefs.aiCompletionModel || ai.completionModel} (autocomplete)` : 'Not configured on this server (OPENROUTER_API_KEY)', disabled: true },
        { label: 'Choose the models… (Preferences)', action: () => setDialog({ name: 'preferences' }) },
        { sep: true },
        { label: `Rewrite with AI (${REWRITE_KEY})`, checked: prefs.aiRewrite, action: () => setPref('aiRewrite', !prefs.aiRewrite) },
        { label: 'Autocomplete text (ghost text, Tab inserts)', checked: prefs.aiCompleteText, action: () => setPref('aiCompleteText', !prefs.aiCompleteText) },
        { label: 'Autocomplete formulas', checked: prefs.aiCompleteMath, action: () => setPref('aiCompleteMath', !prefs.aiCompleteMath) },
        { sep: true },
        { label: 'Rewrite selection with AI…', shortcut: 'Ctrl+K', disabled: !prefs.aiRewrite, action: () => runView(v => openRewrite(v)) },
      ] },
      { sep: true },
      { label: 'Preferences…', action: () => setDialog({ name: 'preferences' }) },
    ] },
  ] : []), helpMenu];

  /** A paper was added to cited.bib: make the entry known, list cited.bib in the BibTeX inset, refresh the metadata. */
  const onBibAdded = (r: BibAddResult) => {
    rememberBib([r.entry]);
    if (r.existed) return;
    const where = masterView ?? view;
    const st = where ? C.ensureBibFile(where, r.file) : 'none';
    if (st === 'added') notify(`Added ${r.file} to the document's bibliography`);
    else if (st === 'none') notify(`${r.file} has the entry — add a BibTeX bibliography with "${r.file.replace(/\.bib$/, '')}" (Insert ▸ BibTeX bibliography…) so that it is printed`, 'error');
    if (docId) api.meta(docId).then(m => { setMeta(m); editorContext.meta = m; }).catch(() => {});
  };
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

  const markActive = (name: string, value: string) => marksAtCursor().some(m => m.type.name === name && m.attrs.value === value);

  /* ------------------------------------------------------------------ toolbars (LyX stdtoolbars.inc) */
  const mathExec = (cmd: string, ...args: unknown[]) => {
    const f = activeMathField();
    if (f) { f.execute(cmd, ...args); f.focus(); return; }
    if (view) { C.insertMath(false)(view); setTimeout(() => activeMathField()?.execute(cmd, ...args), 60); }
  };
  /** ⟪ ⟫ are no LaTeX / LyX delimiters: add the macro (once) to the preamble of the document (or its master). */
  const ensureLlangle = async () => {
    if (!docId) return;
    try {
      const target = meta?.master ?? docId;
      let lines = headerLines;
      if (target !== docId) lines = (await api.header(target)).headerLines;
      const a = lines.indexOf('\\begin_preamble'), b = lines.indexOf('\\end_preamble');
      const preamble = a >= 0 && b > a ? lines.slice(a + 1, b).join('\n') : '';
      if (hasLlangleSnippet(preamble)) return;
      const defined = definesLlangle(preamble, Object.keys(meta?.macros ?? {}));
      await api.setHeader(target, { preamble: (preamble ? preamble.replace(/\s+$/, '') + '\n' : '') + llanglePreamble(defined) });
      notify(`Added the \\llangle / \\rrangle macro to the preamble of ${target.split('/').pop()}`);
    } catch (e) { notify('Could not add the \\llangle macro to the preamble: ' + (e as Error).message, 'error'); }
  };
  const insertDelim = (c: DelimChoice) => {
    if (c.pair.left === '\\llangle') void ensureLlangle();
    if (c.size === '') mathExec('delim', c.pair.left, c.pair.right);
    else if (c.size === 'none') mathExec('pair', c.pair.left, c.pair.right);
    else mathExec('bigdelim', `${c.size}l`, c.pair.left, `${c.size}r`, c.pair.right);
  };
  const mathPanels = useMemo(() => mathPanelPalettes(it => { if (it.kind === 'size') mathExec('style', it.latex); else mathExec('insert', it.latex); }), []);
  const clipboard = (op: 'cut' | 'copy' | 'paste') => {
    const v = activeViewRef.current ?? editorRef.current?.view;
    if (!v) return;
    const f = activeMathField();
    if (op === 'paste') {
      const fallback = () => notify('Paste with Ctrl+V (the browser does not allow the toolbar to read the clipboard)', 'error');
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
  const toggleTb = (id: ToolbarId, visible: boolean) => setToolbar(id, visible ? 'off' : 'on');
  const outputChanges = headerLines.some(l => l === '\\output_changes true');

  const standardGroups: ToolButton[][] = [
    [
      { id: 'new', title: 'New document (Ctrl+N)', icon: 'new', action: () => editorContext.ui?.newFile() },
      { id: 'open', title: 'Open (Ctrl+O)', icon: 'open', action: () => setShowFiles(true) },
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
      { id: 'italic', title: 'Italic (Ctrl+I)', icon: 'italic', action: () => run(C.fontCommands.italic), active: markActive('shape', 'italic') },
      { id: 'noun', title: 'Noun / small caps (Ctrl+Shift+N)', icon: 'noun', action: () => run(C.fontCommands.noun), active: markActive('noun', 'on') },
      { id: 'bold', title: 'Bold (Ctrl+B)', icon: 'bold', action: () => run(C.fontCommands.bold), active: markActive('series', 'bold') },
      { id: 'underline', title: 'Underline (Ctrl+U)', icon: 'underline', action: () => run(C.fontCommands.underline), active: markActive('bar', 'under') },
      { id: 'strike', title: 'Strikeout (Ctrl+Shift+O)', icon: 'strike', action: () => run(C.fontCommands.strikeout), active: markActive('strikeout', 'on') },
      { id: 'tt', title: 'Typewriter', icon: 'tt', action: () => run(C.fontCommands.typewriter), active: markActive('family', 'typewriter') },
      { id: 'textcolor', title: textColor ? `Text colour: ${textColor}` : 'Text colour', icon: 'textcolor', html: colorIcon(textColor), active: !!textColor,
        palette: { title: 'Text colour', render: close => <ColorPalette current={textColor} close={close} onPick={c => run(C.setValueMark('color', c))} /> } },
    ],
    [
      { id: 'math', title: 'Inline formula (Ctrl+M)', icon: 'math', action: () => runView(C.insertMath(false)) },
      { id: 'dmath', title: 'Display formula (Ctrl+Shift+M)', icon: 'dmath', action: () => runView(C.insertMath(true)) },
      { id: 'graphics', title: 'Insert graphics (Ctrl+Shift+G)', icon: 'graphics', action: () => setDialog({ name: 'graphics' }) },
      { id: 'table', title: 'Insert table (Ctrl+Alt+T)', icon: 'table', palette: { title: 'Insert table', render: close => <TableSizePicker close={close} onPick={(r, c) => run(C.insertTable(r, c))} /> } },
      { id: 'flex', title: 'Custom insets (Flex)', icon: 'box', palette: { title: 'Custom insets of this document class', list: true, cols: 1, items: (meta?.flexInsets ?? []).map(n => ({ label: n, action: () => run(C.insertFlex(n)) })).concat([{ label: 'Other…', action: () => { const n = prompt('Flex inset name:', meta?.flexInsets?.[0] ?? 'Code'); if (n) run(C.insertFlex(n)); } }]) } },
    ],
    [
      { id: 'outline', title: 'Outline (Ctrl+Alt+O)', icon: 'outline', action: () => setRightTab(rightTab === 'outline' ? null : 'outline'), active: rightTab === 'outline' },
      { id: 'margin', title: 'Show notes & comments in the margin', icon: 'margin', action: toggleMargin, active: marginMode },
      { id: 'spellcheck', title: prefs.spellcheck ? 'Spell checking is on — click to switch it off' : 'Spell checking is off — click to switch it on', icon: 'spellcheck', action: () => setPref('spellcheck', !prefs.spellcheck), active: prefs.spellcheck },
      { id: 'ai', title: prefs.aiRewrite ? `Rewrite with AI (${REWRITE_KEY})` : 'AI assistance is off — click to open the preferences', icon: 'ai', action: () => { if (prefs.aiRewrite) runView(v => openRewrite(v)); else setDialog({ name: 'preferences' }); }, active: prefs.aiRewrite },
      { id: 'toggleinset', title: 'Open/close inset (Ctrl+Alt+I)', icon: 'toggleinset', action: () => run(C.toggleInset) },
      { id: 'tb-math', title: 'Show math toolbar', icon: 'mathtb', action: () => toggleTb('math', showMath), active: showMath },
      { id: 'tb-table', title: 'Show table toolbar', icon: 'tabletb', action: () => toggleTb('table', showTable), active: showTable },
      { id: 'tb-review', title: 'Show review toolbar', icon: 'reviewtb', action: () => toggleTb('review', showReview), active: showReview },
    ],
    [
      { id: 'pdf', title: 'View PDF (Ctrl+R)', icon: 'pdf', action: () => build() },
      ...(meta?.master ? [{ id: 'pdfmaster', title: `View master document (${meta.master.split('/').pop()})`, icon: 'pdfmaster', action: () => openInTab(meta.master!) } as ToolButton] : []),
    ],
  ];
  const extraGroups: ToolButton[][] = [
    [
      layoutBtn('l-standard', 'Standard', 'Default paragraph (Standard)', 'standard'),
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
      { id: 'nomencl', title: 'Nomenclature entry', icon: 'nomencl', action: () => { const sym = prompt('Nomenclature symbol:'); if (!sym) return; const desc = prompt('Description:', '') ?? ''; run(C.insertCommand('nomenclature', ['LatexCommand nomenclature', 'prefix ""', `symbol "${sym.replace(/"/g, '\\"')}"`, `description "${desc.replace(/"/g, '\\"')}"`, 'literal "false"'])); } },
    ],
    [
      { id: 'footnote', title: 'Footnote (Ctrl+Alt+F)', icon: 'footnote', action: () => run(C.insertFootnote) },
      { id: 'marginal', title: 'Margin note (Ctrl+Alt+M)', icon: 'marginal', action: () => run(C.insertMarginal) },
      { id: 'note', title: 'LyX note (Ctrl+Alt+Shift+N)', icon: 'note', action: () => run(C.insertNote('Note')) },
      { id: 'comment', title: 'Comment thread (Ctrl+Alt+C)', icon: 'comment', action: () => run(C.insertComment) },
      { id: 'boxinset', title: 'Insert box', icon: 'box', action: () => run(C.insertBox) },
      { id: 'href', title: 'Hyperlink (Ctrl+Alt+K)', icon: 'href', action: () => setDialog({ name: 'href' }) },
      { id: 'ert', title: 'TeX code (Ctrl+L)', icon: 'ert', action: () => run(C.insertERT) },
      { id: 'macro', title: 'Math macro definition', icon: 'macro', action: () => { const n = prompt('Macro name (without backslash):'); if (n) run(C.insertMacroDef(n, Number(prompt('Number of arguments:', '0') || 0), '')); } },
      { id: 'include', title: 'Include file (child document)', icon: 'include', action: () => { const fn = prompt('Child document file name (relative):', 'chapter1.tex'); if (fn) run(C.insertInclude(fn, 'include')); } },
    ],
    [
      { id: 'textstyle', title: 'Text properties', icon: 'textstyle', palette: { title: 'Text properties', list: true, cols: 2, items: [
        ['Emphasis', 'emph'], ['Bold', 'bold'], ['Noun (small caps)', 'noun'], ['Underline', 'underline'], ['Strikeout', 'strikeout'], ['Typewriter', 'typewriter'], ['Sans serif', 'sans'], ['Italic', 'italic'], ['Slanted', 'slanted'], ['Small caps', 'smallcaps'], ['Double underline', 'uuline'], ['Wavy underline', 'uwave'], ['Crossed out', 'xout'],
      ].map(([l, k]) => ({ label: l, action: () => run((C.fontCommands as Record<string, any>)[k]) })).concat(
        [['Tiny', 'tiny'], ['Small', 'small'], ['Normal size', 'normal'], ['Large', 'large'], ['Huge', 'huge']].map(([l, v]) => ({ label: `Size: ${l}`, action: () => run(C.setValueMark('size', v === 'normal' ? null : v)) })),
        [{ label: 'Reset to default (Alt+C Space)', action: () => run(C.fontDefault) }]) } },
      { id: 'paragraph', title: 'Paragraph settings (Ctrl+Alt+P)', icon: 'paragraph', action: () => setDialog({ name: 'paragraph' }) },
      { id: 'track', title: 'Track changes (Ctrl+Shift+E)', icon: 'track', action: toggleTracking, active: tracking },
    ],
  ];
  const mf = () => activeMathField();
  const mathGroups: ToolButton[][] = [
    [{ id: 'm-display', title: 'Toggle display / inline formula (Ctrl+Shift+M)', icon: 'display', active: !!mathField?.display, action: () => { const f = mf() as any; if (f?._toggleDisplay) f._toggleDisplay(); else run(C.toggleMathDisplay); } }],
    [
      { id: 'm-sub', title: 'Subscript (Alt+M X, _)', icon: 'sub', action: () => mathExec('moveToSubscript') },
      { id: 'm-sup', title: 'Superscript (Alt+M E, ^)', icon: 'sup', action: () => mathExec('moveToSuperscript') },
      { id: 'm-sqrt', title: 'Square root (Alt+M S)', icon: '√', html: mathPreview('\\sqrt') ?? undefined, action: () => mathExec('insert', '\\sqrt{#0}') },
      { id: 'm-root', title: 'Root (Alt+M R)', icon: 'ⁿ√', html: mathPreview('\\root') ?? undefined, action: () => mathExec('insert', '\\sqrt[]{#0}') },
      { id: 'm-frac', title: 'Fraction (Alt+M F)', icon: 'a/b', html: mathPreview('\\frac') ?? undefined, action: () => mathExec('insert', '\\frac{#0}{}') },
      { id: 'm-sum', title: 'Sum (Alt+M U)', icon: '∑', html: mathPreview('\\sum') ?? undefined, action: () => mathExec('insert', '\\sum') },
      { id: 'm-int', title: 'Integral (Alt+M I)', icon: '∫', html: mathPreview('\\int') ?? undefined, action: () => mathExec('insert', '\\int') },
      { id: 'm-prod', title: 'Product', icon: '∏', html: mathPreview('\\prod') ?? undefined, action: () => mathExec('insert', '\\prod') },
    ],
    [
      { id: 'm-paren', title: 'Insert ( ) (Alt+M ()', icon: '( )', html: mathPreview('\\left(\\square\\right)') ?? undefined, action: () => mathExec('delim', '(', ')') },
      { id: 'm-bracket', title: 'Insert [ ] (Alt+M [)', icon: '[ ]', html: mathPreview('\\left[\\square\\right]') ?? undefined, action: () => mathExec('delim', '[', ']') },
      { id: 'm-brace', title: 'Insert { } (Alt+M {)', icon: '{ }', html: mathPreview('\\left\\{\\square\\right\\}') ?? undefined, action: () => mathExec('delim', '\\{', '\\}') },
      { id: 'm-abs', title: 'Insert | | (Alt+M |)', icon: '| |', html: mathPreview('\\left|\\square\\right|') ?? undefined, action: () => mathExec('delim', '|', '|') },
      { id: 'm-angle', title: 'Insert ⟨ ⟩ (Alt+M <)', icon: '⟨ ⟩', html: mathPreview('\\left\\langle\\square\\right\\rangle') ?? undefined, action: () => mathExec('delim', '\\langle', '\\rangle') },
      { id: 'm-dangle', title: 'Insert ⟪ ⟫ (adds the \\llangle macro to the preamble)', icon: '⟪ ⟫', html: mathPreview('\\left\\langle\\mkern-4.5mu\\left\\langle\\square\\right\\rangle\\mkern-4.5mu\\right\\rangle') ?? undefined, action: () => insertDelim({ pair: { label: '⟪ ⟫', left: '\\llangle', right: '\\rrangle', title: '' }, size: '' }) },
      { id: 'm-delims', title: 'Delimiters of all sizes (\\left…\\right, \\big … \\Bigg)', icon: 'delimsize', palette: { title: 'Delimiters — rows: pair, columns: size', render: close => <DelimPalette close={close} onPick={insertDelim} onDialog={() => setDialog({ name: 'delimiters' })} /> } },
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
      { id: 'tb-mathpanels', title: 'Show math panels', icon: 'Ω', action: () => toggleTb('mathpanels', tbMode('mathpanels') !== 'off'), active: tbMode('mathpanels') !== 'off' },
    ],
  ];
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
      { id: 'r-track', title: 'Track changes (Ctrl+Shift+E)', icon: 'track', action: toggleTracking, active: tracking },
      { id: 'r-output', title: 'Show changes in output (\\output_changes)', icon: 'changesoutput', active: outputChanges, action: () => { if (docId) api.setHeader(docId, { set: { output_changes: outputChanges ? 'false' : 'true' } }).then(() => notify(outputChanges ? 'Changes are no longer shown in the output' : 'Changes are shown in the output (needs the ulem/xcolor packages)')).catch(e => notify(String(e), 'error')); } },
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
    [
      { id: 'r-note', title: 'Insert note (Ctrl+Alt+Shift+N)', icon: 'note', action: () => run(C.insertNote('Note')) },
      { id: 'r-comment', title: 'Comment thread (Ctrl+Alt+C)', icon: 'comment', action: () => run(C.insertComment) },
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
    const active = activeMathField();
    if (active) { active.execute('insert', latex); return; }
    if (view) { C.insertMath(false)(view); setTimeout(() => activeMathField()?.execute('insert', latex), 60); }
  };
  const renderDialog = () => {
    if (!dialog) return null;
    // dialogs that do not need an editor (start screen, text files)
    if (dialog.name === 'feedback') return <FeedbackDialog docId={docId} onClose={() => { setDialog(null); view?.focus(); }} />;
    if (dialog.name === 'help') return <HelpDialog onClose={() => { setDialog(null); view?.focus(); }} />;
    if (dialog.name === 'preferences') return <PreferencesDialog ai={ai} onClose={() => { setDialog(null); view?.focus(); }} />;
    if (!view || !docId) return null;
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
      case 'label': {
        const arg = dialog.arg as { pos?: number; equation?: boolean; initial?: string; hasLabel?: boolean; refCount?: number; onApply?: (n: string) => void; onRemove?: () => void } | undefined;
        if (arg?.equation && arg.onApply) {
          return <LabelDialog initial={arg.initial ?? 'eq:'} editing refCount={arg.refCount ?? 0} existing={labelNames()} onClose={close}
            onInsert={n => arg.onApply!(n)} onRemove={arg.hasLabel ? () => arg.onRemove?.() : undefined} />;
        }
        if (arg?.pos !== undefined) {
          const node = view.state.doc.nodeAt(arg.pos);
          if (node && node.type.name === 'command' && node.attrs.cmd === 'label') {
            const cur = unquote(commandParams(node).get('name'));
            const lpos = arg.pos;
            return <LabelDialog initial={cur} editing refCount={refCountOf(cur)} existing={labelNames()} onClose={close}
              onInsert={n => { if (n !== cur) { C.setLabelName(view, lpos, n); C.renameLabelRefs(view, cur, n); } }}
              onRemove={() => C.deleteLabelAt(view, lpos)} />;
          }
        }
        return <LabelDialog initial={suggestLabel(view)} existing={labelNames()} onClose={close} onInsert={n => run(C.insertLabel(n))} />;
      }
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
          return <CiteDialog meta={meta} docId={docId} project={viewOnly ? undefined : project} onAdded={onBibAdded} initial={{ keys: unquote(p.get('key')).split(',').map(k => k.trim()).filter(Boolean), cmd: p.get('LatexCommand') ?? 'cite', before: unquote(p.get('before')), after: unquote(p.get('after')) }} onClose={close}
            onInsert={(keys, cmd, b, a, entries) => { rememberBib(entries); const params = [`LatexCommand ${cmd}`]; if (a) params.push(`after "${a}"`); if (b) params.push(`before "${b}"`); params.push(`key "${keys.join(',')}"`, 'literal "false"', ''); view.dispatch(view.state.tr.setNodeMarkup(target.pos, undefined, { ...target.node.attrs, params: JSON.stringify(params) })); }} />;
        }
        return <CiteDialog meta={meta} docId={docId} project={viewOnly ? undefined : project} onClose={close} onAdded={onBibAdded} onInsert={(keys, cmd, b, a, entries) => { rememberBib(entries); run(C.insertCite(keys, cmd, b, a)); }} />;
      }
      case 'href': return <HrefDialog onClose={close} onInsert={(t, n) => run(C.insertHref(t, n))} />;
      case 'settings': return <SettingsDialog docId={docId} meta={meta} headerLines={headerLines} onClose={close} onSaved={() => api.meta(docId).then(m => { setMeta(m); editorContext.meta = m; if (masterView) refreshMacros(masterView, m.macros); })} />;
      case 'macros': return <MacrosDialog meta={meta} onClose={close} />;
      case 'airepair': return docId ? <AiRepairDialog docId={docId} onClose={close} onApplied={() => api.meta(docId).then(m => { setMeta(m); editorContext.meta = m; })} /> : null;
      case 'stats': return view ? <StatsDialog view={view} onClose={close} /> : null;
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
        if (target.node.type.name === 'command' && target.node.attrs.cmd === 'label') { setDialog({ name: 'label', arg: { pos: target.pos } }); return null; }
        if (target.node.type.name === 'table') { setDialog({ name: 'tablesettings' }); return null; }
        return <InsetDialog node={target.node} onClose={close} onApply={attrs => view.dispatch(view.state.tr.setNodeMarkup(target.pos, undefined, { ...target.node.attrs, ...attrs }))} />;
      }
    }
    return null;
  };

  /** The tour practises on the user's example project (a document of their own); failing that, on the open document. */
  const openExample = useCallback(async (): Promise<boolean> => {
    try {
      const { projects } = await api.projects();
      const ex = projects.find(p => p.kind === 'example' && p.via === 'owner');
      const doc = ex && projectDocs(ex)[0];
      if (ex && doc) { openInTab(`${ex.name}/${doc}`); return true; }
    } catch { /* offline: fall through */ }
    return isLyxDoc;
  }, [openInTab, isLyxDoc]);
  const endTour = useCallback((how: TourEnd) => { rememberTour(how); setTour(null); }, []);

  const sourceTarget: SourceTarget | null = (() => {
    if (!view) return null;
    if (masterView && view === masterView && editorRef.current) return { view, ydoc: editorRef.current.ydoc, docId: docId! };
    for (const [id, h] of childRefs.current) if (h.view === view) return { view, ydoc: h.ydoc, docId: id };
    return editorRef.current ? { view: editorRef.current.view, ydoc: editorRef.current.ydoc, docId: docId! } : null;
  })();

  return (
    <div class="app">
      <MenuBar menus={menus} user={user} onLogout={onLogout} onHome={() => { location.hash = '#/'; }} searchEntries={helpSearchEntries} right={docId ? <span class="doc-title" title={docId}>{docLabel}{meta?.master && !combined && <> · child of <a href={'#/' + meta.master} onClick={e => { e.preventDefault(); openInTab(meta.master!); }}>{meta.master.split('/').pop()}</a></>}</span> : null} />
      {isLyxDoc && tbMode('standard') !== 'off' && <Toolbar id="standard" layouts={layouts} layout={layout} onLayout={n => run(C.setLayout(n))} groups={standardGroups} />}
      {isLyxDoc && tbMode('extra') !== 'off' && <Toolbar id="extra" groups={extraGroups} />}
      {isLyxDoc && showMath && <Toolbar id="math" label="Math" groups={mathGroups} />}
      {isLyxDoc && showMath && tbMode('mathpanels') !== 'off' && <Toolbar id="mathpanels" label="Panels" groups={mathPanelGroups} />}
      {isLyxDoc && showTable && <Toolbar id="table" label="Table" groups={tableGroups} />}
      {isLyxDoc && showReview && <Toolbar id="review" label="Review" groups={reviewGroups} />}
      {tabs.length > 0 && <TabBar tabs={tabs} current={hashId} onSelect={id => { location.hash = '#/' + id; }} onClose={closeTab} onReorder={setTabs} onContext={(id, x, y) => setTabMenu({ id, x, y })} />}
      {tabMenu && (
        <div class="tab-menu-backdrop" onMouseDown={() => setTabMenu(null)} onContextMenu={e => { e.preventDefault(); setTabMenu(null); }}>
          <div class="menu-list tab-menu" style={`position:fixed;top:${tabMenu.y}px;left:${tabMenu.x}px`} onMouseDown={e => e.stopPropagation()}>
            {/^[^:]+\.tex$/.test(tabMenu.id) && <div class="menu-item" onClick={() => { const id = tabMenu.id; setTabMenu(null); openInTab('raw:' + id); }}><span>Open LaTeX source beside — {tabMenu.id.split('/').pop()} [raw]</span></div>}
            {tabMenu.id.startsWith('raw:') && <div class="menu-item" onClick={() => { const id = tabMenu.id; setTabMenu(null); location.hash = '#/' + id.slice(4); }}><span>Show the document only</span></div>}
            <div class="menu-item" onClick={() => { const id = tabMenu.id; setTabMenu(null); closeTab(id); }}><span>Close tab</span></div>
            <div class="menu-item" onClick={() => { const id = tabMenu.id; setTabMenu(null); for (const t of tabs) if (t !== id) closeTab(t); }}><span>Close other tabs</span></div>
          </div>
        </div>
      )}
      {docId && meta && meta.health.length > 0 && (
        <div class="health-bar">
          <span class="health-icon">⚠</span>
          <span>{meta.health.length === 1 ? '1 structural issue' : `${meta.health.length} structural issues`} found in this file (probably from an external edit): {meta.health.map(h => h.message).join(' ')}</span>
          <span style="flex:1" />
          {meta.health.some(h => h.fixable) && <button class="small-btn" disabled={repairing} onClick={runRepair}>{repairing ? 'Repairing…' : 'Repair'}</button>}
          <button class="small-btn" onClick={() => setDialog({ name: 'airepair' })}>Escalate to AI…</button>
        </div>
      )}
      {docId && findOpen && (() => {
        const st = view ? findKey.getState(view.state) : undefined;
        const requery = (patch: Partial<{ query: string; caseSensitive: boolean; wholeWord: boolean; regex: boolean; searchMath: boolean; selectionOnly: boolean }>, useSelection?: boolean) => {
          if (!view) return;
          setQuery(view, { query: findQ, caseSensitive: findCase, wholeWord: findWord, regex: findRegex, searchMath: findMath, selectionOnly: findSel, ...patch, ...(useSelection !== undefined ? { useSelection } : {}) });
        };
        return (
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
          <span style="color:#666">{st ? (st.error ? `regex error` : `${st.matches.length} matches`) : ''}</span>
          <button class={'small-btn' + (findAdv ? ' active' : '')} title="Advanced options" onClick={() => setFindAdv(a => !a)}>Advanced ▾</button>
          <span style="flex:1" /><button class="small-btn" onClick={() => { setFindOpen(false); if (view) { setQuery(view, { query: '' }); view.focus(); } }}>✕</button>
        </div>
        {findAdv && (
          <div class="find-bar find-bar-adv">
            <label title="Treat the search text as a regular expression ($1… back-references work in Replace)"><input type="checkbox" checked={findRegex} onChange={e => { const v = (e.target as HTMLInputElement).checked; setFindRegex(v); requery({ regex: v }); }} /> Regular expression</label>
            <label title="Also search inside math formulas"><input type="checkbox" checked={findMath} onChange={e => { const v = (e.target as HTMLInputElement).checked; setFindMath(v); requery({ searchMath: v }); }} /> Search math</label>
            <label title="Only search the current selection"><input type="checkbox" checked={findSel} onChange={e => { const v = (e.target as HTMLInputElement).checked; setFindSel(v); requery({ selectionOnly: v }, v); }} /> In selection</label>
            {st?.error && <span class="find-error">{st.error}</span>}
          </div>
        )}
        </div>
        );
      })()}
      <div class="main">
        {showFiles ? (
          <div class="sidebar">
            <div class="panel-tabs"><button class="active">Files</button><button class="hide" title="Hide the file browser" onClick={() => setShowFiles(false)}>«</button></div>
            <div class="panel-body"><FileBrowser current={textId} refreshKey={refreshKey} onOpen={id => openInTab(id)} onShare={p => setShareFor(p)} onGit={p => setGitFor(p)} /></div>
          </div>
        ) : (
          <div class="rail left"><button data-rail="files" title="Show the file browser" onClick={() => setShowFiles(true)}>Files</button></div>
        )}
        <div class={'editor-column' + (rawSplit && isLyxDoc ? ' split' : '')}>
        <div class={'editor-scroll' + (marginMode ? ' margin-mode' : '')} ref={scrollRef} onClick={e => { if (e.target === e.currentTarget && view) view.focus(); }}>
          {(isLyxDoc || isTextTab) && showRuler && <Ruler width={textWidth} onChange={setTextWidth} marginMode={isLyxDoc && marginMode} noteScale={noteScale} onNoteScale={setNoteScale} />}
          {docId ? (isPdfTab ? <div class="pdf-tab"><PdfViewer key={docId} url={fileUrl(textId!.split('/')[0], textId!.split('/').slice(1).join('/'))} toolbar={<a class="small-btn" href={fileUrl(textId!.split('/')[0], textId!.split('/').slice(1).join('/')) + '?download=1'}>Download</a>} /></div> : !isLyxDoc ? <TextEditor key={docId} id={textId!} notify={notify} /> :
            <div class="editor-page">
              <div class="editor-host" ref={containerRef} />
              {combined && childIds.map(id => (
                <ChildEditor key={id} id={id} user={user} marginMode={marginMode} readOnly={viewOnly} onSelection={onSelection} onDocChange={() => { setDocTick(t => t + 1); }}
                  register={(cid, h) => { if (h) childRefs.current.set(cid, h); else childRefs.current.delete(cid); rerender(); }} />
              ))}
            </div>
          ) : <Home user={user} refreshKey={refreshKey} onOpen={id => openInTab(id)} onStartTour={id => { openInTab(id); setTour('steps'); }} onShare={p => setShareFor(p)} onGit={p => setGitFor(p)} onChanged={() => setRefreshKey(k => k + 1)} onBrowse={() => setShowFiles(true)} notify={notify} />}
        </div>
        {isLyxDoc && rawSplit && <SourcePane layout="right" target={sourceTarget} tick={docTick} selTick={selTick} mathField={mathField} onNotify={notify} onClose={() => { location.hash = '#/' + docId; }} />}
        {isLyxDoc && showSource && !rawSplit && <SourcePane target={sourceTarget} tick={docTick} selTick={selTick} mathField={mathField} onNotify={notify} onClose={() => setShowSource(false)} />}
        </div>
        {isLyxDoc && !rightTab && (
          <div class="rail right">
            {RIGHT_TABS.map(t => <button key={t} data-rail={t} title={RIGHT_TAB_TITLES[t]} onClick={() => { setRightTab(t); if (t === 'versions') setSelVersion(v => v + 1); }}>{RIGHT_TAB_LABELS[t]}</button>)}
            <button data-rail="source" class={showSource ? 'active' : ''} title={SOURCE_TITLE} onClick={() => setShowSource(s => !s)}>Source</button>
          </div>
        )}
        {isLyxDoc && rightTab && (
          <div class={'sidebar right' + (rightTab === 'pdf' ? ' wide' : '')}>
            <div class="panel-tabs">
              <button class={rightTab === 'outline' ? 'active' : ''} data-tab="outline" onClick={() => setRightTab('outline')} title={RIGHT_TAB_TITLES.outline}>Outline</button>
              <button class={rightTab === 'comments' ? 'active' : ''} data-tab="comments" onClick={() => setRightTab('comments')} title={RIGHT_TAB_TITLES.comments}>Comments</button>
              <button class={rightTab === 'pdf' ? 'active' : ''} data-tab="pdf" onClick={() => setRightTab('pdf')} title={RIGHT_TAB_TITLES.pdf}>PDF</button>
              <button class={rightTab === 'versions' ? 'active' : ''} data-tab="versions" onClick={() => { setRightTab('versions'); setSelVersion(v => v + 1); }} title={RIGHT_TAB_TITLES.versions}>Versions</button>
              <button class={'toggle' + (showSource ? ' on' : '')} data-tab="source" onClick={() => setShowSource(s => !s)} title={SOURCE_TITLE}>Source</button>
              <button class="hide" title="Hide the sidebar" onClick={() => setRightTab(null)}>»</button>
            </div>
            {rightTab === 'outline' && <div class="panel-body"><Outline view={masterView} items={outline} activePos={activePos} /></div>}
            {rightTab === 'comments' && <div class="panel-body"><Comments views={[masterView, ...[...childRefs.current.values()].map(h => h.view)].filter((v): v is EditorView => !!v)} tick={docTick} /></div>}
            {rightTab === 'pdf' && <PdfPanel docId={docId} state={pdf} onBuild={build} onCancel={cancelBuild} onShowTex={showTex} syncTarget={syncTarget} onForward={() => { void syncToPdf(); }} onInverse={(pg, x, y) => { void syncFromPdf(pg, x, y); }} />}
            {rightTab === 'versions' && <div class="panel-body"><Versions docId={docId} refreshKey={selVersion} /></div>}
          </div>
        )}
      </div>
      <StatusBar layout={layout} status={status} chord={chord} message={message} save={save} tracking={tracking} trackingAs={user.name} change={changeInfo}
        docLabel={view && masterView && view !== masterView ? viewDocId(view).split('/').pop() ?? null : null}
        readOnly={!!docId && viewOnly} updateReady={updateReady} aiBusy={aiBusy > 0}
        quiet={!!docId && !isLyxDoc}
        onJumpToUser={jumpToUser} />
      {renderDialog()}
      {shareFor && <ShareDialog project={shareFor} user={user} onClose={() => setShareFor(null)} onChanged={() => setRefreshKey(k => k + 1)} />}
      {gitFor && <GitDialog project={gitFor} user={user} onClose={() => setGitFor(null)} />}
      {tour && <Tour intro={tour === 'intro'} onEnd={endTour}
        ctx={{ docId, ready: isLyxDoc && status.synced && !!view, docTick, layout, inMath: !!mathField, saveState: save.state, rightTab, pdfBusy: pdf.busy, pdfBuiltAt: pdf.builtAt ?? 0, shareOpen: !!shareFor, gitOpen: !!gitFor, marginMode }}
        actions={{ openExample, showRight: () => { if (!rightTab) setRightTab('outline'); }, showFiles: () => setShowFiles(true) }} />}
    </div>
  );
}

/** Child documents (\include / \input of .tex files) of a master, in document order. */
function collectChildren(view: EditorView): string[] {
  const out: string[] = [];
  const project = view.dom.dataset.project ?? '', docDir = view.dom.dataset.docDir ?? '';
  view.state.doc.descendants((node) => {
    let id = C.includeTarget(node, project, docDir);
    if (id && !/\.[A-Za-z0-9]+$/.test(id)) id += '.tex';
    if (id && id.endsWith('.tex') && !out.includes(id)) out.push(id);
    return true;
  });
  return out;
}

function ChildEditor({ id, user, marginMode, readOnly, onSelection, onDocChange, register }: { id: string; user: User; marginMode: boolean; readOnly?: boolean; onSelection: (v: EditorView) => void; onDocChange: () => void; register: (id: string, h: EditorHandle | null) => void }) {
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
      handle = createEditor({ docId: id, user, container: ref.current, marginMode, child: true, onStatus: setStatus, onSelectionChange: onSelection, onDocChange,
        onStale: () => { void handle?.discardLocal().then(() => setTimeout(() => location.reload(), 800)); } });
      register(id, handle);
      if (readOnly || m.role === 'view') { handle.setViewOnly(true); handle.setEditable(false); }
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

function TabBar({ tabs, current, onSelect, onClose, onReorder, onContext }: { onContext?: (id: string, x: number, y: number) => void; tabs: string[]; current: string | null; onSelect: (id: string) => void; onClose: (id: string) => void; onReorder: (t: string[]) => void }) {
  const drag = useRef<string | null>(null);
  const base = (id: string) => (id.split('/').pop() ?? id) + (id.startsWith('raw:') ? ' [raw]' : '');
  // disambiguate tabs with the same file name by prefixing the project
  const counts = new Map<string, number>();
  for (const t of tabs) counts.set(base(t), (counts.get(base(t)) ?? 0) + 1);
  return (
    <div class="tabbar" role="tablist">
      {tabs.map(id => (
        <a key={id} href={'#/' + id} role="tab" class={'tab' + (id === current ? ' active' : '')} title={id} draggable
          onClick={e => { if (!e.ctrlKey && !e.metaKey && !e.shiftKey && e.button === 0) { e.preventDefault(); onSelect(id); } }}
          onContextMenu={e => { if (onContext) { e.preventDefault(); onContext(id, e.clientX, e.clientY); } }}
          onAuxClick={e => { if (e.button === 1) { e.preventDefault(); onClose(id); } }}
          onDragStart={() => { drag.current = id; }}
          onDragOver={e => e.preventDefault()}
          onDrop={e => { e.preventDefault(); const from = drag.current; if (!from || from === id) return; const t = tabs.filter(x => x !== from); t.splice(t.indexOf(id), 0, from); onReorder(t); }}>
          <span class="tab-name">{(counts.get(base(id)) ?? 0) > 1 ? id.replace(/^(raw|text|pdf):/, '').split('/')[0] + '/' : ''}{base(id)}</span>
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
  // the same hues, lifted so that they read on the dark page (app/theme.ts)
  const dark = ['#7bd88f', '#ff8a80', '#82b1ff', '#d6a2ff', '#ffb74d', '#4dd0e1', '#f48fb1', '#d7ccc8', '#c5e1a5', '#9fa8da'];
  let el = document.getElementById('ol-author-colors') as HTMLStyleElement | null;
  if (!el) { el = document.createElement('style'); el.id = 'ol-author-colors'; document.head.appendChild(el); }
  el.textContent = authors.map((a, i) => `.lyx-change[data-author="${a.id}"], .lyx-inset[data-author="${a.id}"] { --change-color: ${palette[i % palette.length]}; }\n`
    + `html[data-theme="dark"] .lyx-change[data-author="${a.id}"], html[data-theme="dark"] .lyx-inset[data-author="${a.id}"] { --change-color: ${dark[i % dark.length]}; }`).join('\n');
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
