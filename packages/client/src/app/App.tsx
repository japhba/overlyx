import { recordUsage, noticeTemplate } from '../usage';
import { editorViewMenu } from './editorViewMenu';
import { inkToolbar } from './inkToolbar';
import { StatsDialog } from './StatsDialog';
import { documentMenus } from './documentMenus';
import { referenceTransaction } from '../editor/references';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'preact/hooks';
import type { EditorView } from 'prosemirror-view';
import { NodeSelection, TextSelection } from 'prosemirror-state';
import { api, googleSignInUrl, type AiStatus, type BibAddResult, type DocMeta, type Project, type User, fileUrl } from '../api';
import { getPrefs, setPref, subscribePrefs, type Prefs } from '../prefs';
import { openRewrite, REWRITE_KEY } from '../editor/ai/rewrite';
import { Login } from './Login';
import { DocPanel } from './DocPanel';
import { Home, projectDocs } from './Home';
import { TextEditor } from './TextEditor';
import { ViewModeSwitch, type ViewMode } from './ViewModeSwitch';
import { MarkdownEditor } from './MarkdownEditor';
import { ShareDialog } from './Share';
import { GuestCallout } from './Guest';
import { GitDialog } from './Git';
import { MenuBar, openPalette, PALETTE_LABEL, PALETTE_DEFAULT, type MenuDef } from './MenuBar';
import { setThemePref, useTheme } from './theme';
import { usePresentation } from './presentation';
import { Toolbar, NAMED_COLORS, type ToolButton } from './Toolbar';
import { buildToolbars, loadToolbarPrefs, mathExecutor, useMathPanels, toolbarClipboard, markValue, type ToolbarId, type ToolbarMode, type ToolbarPrefs } from './toolbars';
import { debounce, hashAuthor, applyAuthorColors, bcp47, suggestLabel, LayoutPicker, documentStats, applyEditorZoom } from './shellutil';
import { Outline, buildOutline, type OutlineItem } from './Outline';
import { Comments } from './Comments';
import { Versions } from './Versions';
import { AgentPanel } from './AgentPanel';
import { PdfPanel, stateFromBuild, jobActive, type PdfState } from './PdfPanel';
import { Ruler, NOTE_SCALE_DEFAULT, NOTE_SCALE_MIN, NOTE_SCALE_MAX } from './Ruler';
import { StatusBar, type Status } from './StatusBar';
import { SourcePane, type SourceTarget, cursorLine, docBlocks, blockPos } from './SourcePane';
import { activeMathField, mathFocusListeners, mathCursorListeners, type LyxMathField } from '../editor/lyxmath/field';
import { Tour, tourWanted, rememberTour, type TourEnd } from './Tour';
import { FeedbackDialog } from './Feedback';
import { Dialog, GraphicsDialog, TableDialog, LabelDialog, RefDialog, CiteDialog, HrefDialog, SettingsDialog, InsetDialog, HelpDialog, TexDialog, MacrosDialog, ParagraphDialog, TableSettingsDialog, DelimiterDialog, MatrixDialog, commandParams, HELP_ROWS, AiRepairDialog } from './Dialogs';
import { SettingsPanel } from './Settings';
import { createEditor, type EditorHandle, type SaveState } from '../editor/editor';
import { refreshMacros } from '../editor/macrodefs';
import { describeChange } from '../editor/assembly';
import { useProjectEvents } from './FileBrowser';
import { newerVersionAvailable } from './update';
import { generateLyx } from './SourcePane';
import { editorContext, viewDocId } from '../editor/context';
import { navHistory, type NavLocation } from './navhistory';
import { restoredCursorPos } from '../editor/cursormemory';
import { PdfViewer, type PdfTarget } from './PdfViewer';
import { locateSourceLine } from './sourcelocate';
import { canonical, effectiveShortcut, keyFromEvent, syncBindings } from './keybindings';
import { STANDARD_LAYOUTS, sectionLevel } from '../editor/layouts';
import { chordKey } from '../editor/keymap';
import * as C from '../editor/commands';
import { setMarginMode } from '../editor/plugins/margin';
import { setInk, subscribeInk, isTabletClient } from '../editor/plugins/ink';
import { BoardEditor } from './BoardEditor';
import { acceptAllChanges, rejectAllChanges, changeAt, hasChanges, changesFilterKey } from '../editor/plugins/changes';
import * as T from '../editor/tablecommands';
import type { PresenceUser } from '../editor/editor';
import { setQuery, findNext, replaceCurrent, replaceAll, findKey } from '../editor/plugins/find';
import { schema, unquote } from '@overlyx/core';

type Dialog = { name: string; arg?: unknown } | null;

/** LyX language name → BCP 47 tag (for the browser's spell checker). */
export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [google, setGoogle] = useState(false);
  const [ready, setReady] = useState(false);
  // why the share link in the URL did not open (shown on the sign-in page)
  const [linkNote, setLinkNote] = useState<string | null>(null);
  useEffect(() => {
    api.me().then(async r => {
      let u = r.user;
      // a share link opened without an account: the server lets the visitor in as a guest, straight
      // to the document — signing in later keeps the project (Workspace's guest callout)
      const token = u ? null : parseHash().share;
      if (token) {
        try { const a = await api.acceptShare(token); if (a.user) { u = a.user; location.hash = a.doc ? '#/' + a.doc : ''; } }
        catch (e) { setLinkNote((e as Error).message); }
      }
      setUser(u); setGoogle(r.google);
      if (u) void syncBindings();   // account shortcuts follow the user across browsers
      // remembered for offline starts (the session cookie itself is still valid then)
      try { if (u) localStorage.setItem('ol.user', JSON.stringify(u)); else localStorage.removeItem('ol.user'); } catch { /* ignore */ }
    }).catch(() => {
      // no server (offline): continue with the last known user; documents come from the local copies
      try { const u = localStorage.getItem('ol.user'); if (u) setUser(JSON.parse(u)); } catch { /* ignore */ }
    }).finally(() => setReady(true));
  }, []);
  // a guest asked to sign in (no Google here, or the callout's plain button): the sign-in page over
  // the workspace — the guest cookie stays, so the login moves the guest's projects to the account
  const [wantLogin, setWantLogin] = useState(false);
  if (!ready) return <div style="padding:40px;color:#666">Loading…</div>;
  if (!user) return <Login google={google} onLogin={setUser} note={linkNote} />;
  if (user.guest && wantLogin) return <Login google={google} onLogin={u => { setUser(u); setWantLogin(false); }} onBack={() => setWantLogin(false)} note="Sign in to keep the shared project in your account." />;
  return <Workspace user={user} google={google} onSignIn={() => setWantLogin(true)} onLogout={() => api.logout().then(clearLocalData).then(() => { try { localStorage.removeItem('ol.user'); } catch { /* ignore */ } setUser(null); })} />;
}

/** Forget everything cached in this browser (API responses cached by the service worker, local document copies). */
async function clearLocalData(): Promise<void> {
  try { if ('caches' in window) for (const k of await caches.keys()) if (k.startsWith('overlyx-api')) await caches.delete(k); } catch { /* ignore */ }
  try {
    const dbs = await (indexedDB as any).databases?.() as { name?: string }[] | undefined;
    for (const d of dbs ?? []) if (d.name?.startsWith('overlyx:')) indexedDB.deleteDatabase(d.name);
  } catch { /* ignore */ }
}

type RightTab = 'comments' | 'pdf' | 'versions' | 'agent';
const RIGHT_TABS = ['comments', 'pdf', 'versions', 'agent'] as const;
const RIGHT_TAB_LABELS: Record<RightTab, string> = { comments: 'Comments', pdf: 'PDF', versions: 'Versions', agent: 'Agent' };
const RIGHT_TAB_TITLES: Record<RightTab, string> = { comments: 'Comment threads: open ones and the resolved archive', pdf: 'PDF preview', versions: 'Versions of this document', agent: 'The coding agent (OpenAI Codex) working in this project' };
const LEFT_TITLE = 'Documents of the project and their outlines (Ctrl+Alt+O)';
const SOURCE_TITLE = 'LaTeX source beside the text (Ctrl+Alt+S)';
const stored = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };

/** `#/project/path.tex?goto=label` or `?heading=<n>` (the n-th heading), or a share link `#/share/<token>` */
function parseHash(): { id: string | null; goto: string | null; heading: number | null; share: string | null } {
  const raw = location.hash.replace(/^#\/?/, '');
  const q = raw.indexOf('?');
  const idPart = decodeURIComponent(q >= 0 ? raw.slice(0, q) : raw);
  if (idPart.startsWith('share/')) return { id: null, goto: null, heading: null, share: idPart.slice('share/'.length) };
  const params = q >= 0 ? new URLSearchParams(raw.slice(q + 1)) : null;
  const h = params?.get('heading');
  return { id: idPart || null, goto: params?.get('goto') ?? null, heading: h !== null && h !== undefined && /^\d+$/.test(h) ? Number(h) : null, share: null };
}

/** Navigate ▸ Back / Forward (navhistory.ts); the ids are the menu paths, so the palette can rebind them */
const NAV_BACK_ID = 'Navigate ▸ Back', NAV_FORWARD_ID = 'Navigate ▸ Forward';
const NAV_BACK_KEY = 'Ctrl+Alt+←', NAV_FORWARD_KEY = 'Ctrl+Alt+→';

/** Drag handle beside a sidebar: sets --left-width / --right-width on the root (kept per browser). */
function SidebarGrip({ side }: { side: 'left' | 'right' }) {
  return (
    <div class={'sidebar-grip ' + side} title="Drag to resize" onPointerDown={(e) => {
      e.preventDefault();
      const move = (ev: PointerEvent) => {
        const w = Math.round(Math.max(180, Math.min(window.innerWidth * 0.6, side === 'left' ? ev.clientX : window.innerWidth - ev.clientX)));
        document.documentElement.style.setProperty(`--${side}-width`, w + 'px');
      };
      const up = () => {
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
        try { localStorage.setItem('ol.' + side + 'w', document.documentElement.style.getPropertyValue(`--${side}-width`)); } catch { /* ignore */ }
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    }} />
  );
}

function Workspace({ user, google, onSignIn, onLogout }: { user: User; google: boolean; onSignIn: () => void; onLogout: () => void }) {
  // what the hash shows (one project, one file at a time): a document, "text:"/"pdf:" files, or
  // "raw:<document>" — the document beside its LaTeX source
  const [hashId, setHashId] = useState<string | null>(parseHash().id);
  const docId = hashId ? hashId.replace(/^raw:/, '') : null;
  const rawSplit = !!hashId && hashId.startsWith('raw:');
  const [sourceOnly, setSourceOnly] = useState(false);
  const viewMode = rawSplit ? (sourceOnly ? 'tex' : 'split') : 'wysiwyg';
  const changeViewMode = (mode: ViewMode) => { setSourceOnly(mode === 'tex'); if (docId) location.hash = '#/' + (mode === 'wysiwyg' ? '' : 'raw:') + docId; };
  /** The Source switches (Ctrl+Alt+S, the right rail, the panel tabs, the View menu): the LaTeX source beside the document. */
  const toggleRawSplit = () => { if (docId) location.hash = '#/' + (rawSplit ? docId : 'raw:' + docId); };
  // .tex documents open in the collaborative editor, other text files in a plain text editor (ids
  // prefixed with "text:"), a project's PDF files in the PDF viewer ("pdf:")
  const isTextTab = !!docId && docId.startsWith('text:');
  const isPdfTab = !!docId && docId.startsWith('pdf:');
  const textId = docId ? docId.replace(/^(text|pdf):/, '') : null;
  const isLyxDoc = !!docId && !isTextTab && docId.endsWith('.tex');
  const isBoardTab = !!docId && !isTextTab && !isPdfTab && docId.endsWith('.board');
  // the project shown in the documents panel (its owner gets the Share button)
  const [curProject, setCurProject] = useState<Project | null>(null);
  const [meta, setMeta] = useState<DocMeta | null>(null);
  const [headerLines, setHeaderLines] = useState<string[]>([]);
  const [status, setStatus] = useState<Status>({ connected: false, synced: false, users: [] });
  const [layout, setLayout] = useState('Standard');
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [activePos, setActivePos] = useState(0);
  // Metadata (macros, bibliography, labels) follows the project's file changes: when an agent, a
  // git push or a collaborator edits macros.tex / *.bib, open editors learn it without a manual
  // "Reload metadata" (throttled — the events also fire for this document's own saves).
  const metaTimer = useRef<number | undefined>(undefined);
  const metaAt = useRef(0);
  useProjectEvents(isLyxDoc ? docId!.split('/')[0] : null, () => {
    if (!docId) return;
    window.clearTimeout(metaTimer.current);
    metaTimer.current = window.setTimeout(() => {
      metaAt.current = Date.now();
      api.meta(docId).then(m => { setMeta(m); editorContext.meta = m; const v = editorRef.current?.view; if (v) refreshMacros(v, m.macros); }).catch(() => { /* transient */ });
    }, Math.max(2500, 20000 - (Date.now() - metaAt.current)));
  });
  // sidebars: the documents panel (left: project, document tabs, outlines, files) and the right
  // panels; shown / hidden state is kept per browser (a hidden sidebar leaves a rail to bring it back)
  const [showFiles, setShowFiles] = useState(() => stored('ol.files') !== '0');
  const [rightTab, setRightTab] = useState<RightTab | null>(() => { const v = stored('ol.right'); return v !== null && (RIGHT_TABS as readonly string[]).includes(v) ? v as RightTab : null; });
  // the LaTeX source is a panel below the writing area with its own switch
  useEffect(() => { try { localStorage.setItem('ol.files', showFiles ? '1' : '0'); localStorage.setItem('ol.right', rightTab ?? ''); } catch { /* ignore */ } }, [showFiles, rightTab]);
  // dragged sidebar widths from the last visit (SidebarGrip)
  useEffect(() => {
    for (const side of ['left', 'right'] as const) {
      const v = stored('ol.' + side + 'w');
      if (v) document.documentElement.style.setProperty(`--${side}-width`, v);
    }
  }, []);
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
  // Margin ink (drawing in the space beside the text): on tablets the toolbar activates itself.
  const [inkMode, setInkModeState] = useState(() => { const v = localStorage.getItem('ol.ink'); return v !== null ? v === '1' : isTabletClient(); });
  const setInkMode = (fn: (m: boolean) => boolean) => setInkModeState(m => { const next = fn(m); localStorage.setItem('ol.ink', next ? '1' : '0'); return next; });
  const [, inkTick] = useState(0);
  useEffect(() => subscribeInk(() => inkTick(t => t + 1)), []);
  useEffect(() => { setInk({ active: inkMode }); }, [inkMode]);
  // entering ink mode adds wide gutters: keep the column centred (the snap point)
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !inkMode) return;
    el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
  }, [inkMode, docId]);
  const [findOpen, setFindOpen] = useState(false);
  // sharing: the project whose share dialog is open; view-only when the current project was shared for viewing
  const [shareFor, setShareFor] = useState<string | null>(null);
  // the project whose git dialog (clone URL, tokens, history) is open
  const [gitFor, setGitFor] = useState<string | null>(null);
  /** the interactive walkthrough: offered once per browser, restartable from Help */
  // guests came for somebody's document, not for a tour (it is offered once they have an account)
  const [tour, setTour] = useState<'intro' | 'steps' | null>(() => (!user.guest && tourWanted() ? 'intro' : null));
  const [viewOnly, setViewOnly] = useState(false);
  // LyX toolbars: standard / extra always (unless hidden), math / table / review on, off or automatic (LyX's "auto")
  const { pref: themePref } = useTheme();
  usePresentation();   // View ▸ Presentation mode: Shift+F11 toggles, Esc leaves
  // per-browser preferences (spell checking, AI assistance) and whether the server can answer AI requests
  const [prefs, setPrefsState] = useState<Prefs>(getPrefs);
  useEffect(() => subscribePrefs(setPrefsState), []);
  /** The Agent panel appears once AI assistance is activated in the settings (any AI toggle, or the ✦ button). */
  const aiActivated = prefs.aiButton || prefs.aiRewrite || prefs.aiCompleteText || prefs.aiCompleteMath;
  useEffect(() => { if (!aiActivated && rightTab === 'agent') setRightTab(null); }, [aiActivated, rightTab]);
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
  useEffect(() => { const l = (f: LyxMathField | null) => { setMathField(f); editorContext.mathField = f; }; mathFocusListeners.add(l); return () => { mathFocusListeners.delete(l); }; }, []);
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
  const pendingHeading = useRef<number | null>(parseHash().heading);
  const [, force] = useState(0);
  const rerender = () => force(x => x + 1);

  const notify = useCallback((text: string, kind: 'info' | 'error' = 'info') => {
    setMessage({ text, kind });
    setTimeout(() => setMessage(m => (m?.text === text ? null : m)), 4000);
    if (kind === 'error') recordUsage('notice', noticeTemplate(text));   // what went wrong, as a template (usage.ts)
  }, []);

  useEffect(() => {
    const onHash = () => {
      const h = parseHash(); pendingGoto.current = h.goto; pendingHeading.current = h.heading; setHashId(h.id);
      if (h.id?.startsWith('text:')) navHistory.visit(h.id, null);
      if ((h.goto || h.heading !== null) && h.id === editorContext.docId) runGoto();
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

  useEffect(() => applyEditorZoom(zoom), [zoom]);
  // Ctrl/Cmd +/- zoom the document text, never the browser chrome — wherever the focus is (formula
  // fields, panels). Ctrl+0 is a paragraph style now (Part, like LyX's Alt+P 0); reset via the status bar.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const mod = navigator.platform.includes('Mac') ? ev.metaKey : ev.ctrlKey;
      if (!mod || ev.altKey || ev.shiftKey && ev.key !== '+') return;
      const k = ev.key === '+' || ev.code === 'Equal' || ev.code === 'NumpadAdd' ? 1 : ev.key === '-' || ev.code === 'Minus' || ev.code === 'NumpadSubtract' ? -1 : null;
      if (k === null) return;
      ev.preventDefault(); ev.stopPropagation();
      editorContext.ui?.zoom(k);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  // A file dropped outside a drop target (editor text, file browser) must not make the browser
  // navigate to it — that would throw the whole workspace away. Element handlers run first.
  useEffect(() => {
    const over = (ev: DragEvent) => { if (ev.dataTransfer?.types.includes('Files')) ev.preventDefault(); };
    const drop = (ev: DragEvent) => { if (ev.dataTransfer?.types.includes('Files')) ev.preventDefault(); };
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => { window.removeEventListener('dragover', over); window.removeEventListener('drop', drop); };
  }, []);
  // Ctrl/Cmd+R starts the PDF build wherever the focus is (a panel, a dialog, a comment box):
  // the editor's keymap only sees the key with the cursor in the text, and the browser's reload
  // silently threw away the tour and the interface state. Ctrl+Shift+R stays the browser's.
  useEffect(() => {
    if (!docId) return;
    const onKey = (ev: KeyboardEvent) => {
      if ((!ev.ctrlKey && !ev.metaKey) || ev.altKey || ev.shiftKey || (ev.key !== 'r' && ev.key !== 'R')) return;
      ev.preventDefault(); ev.stopPropagation();
      editorContext.ui?.viewPdf?.();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [docId]);
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
  useEffect(() => { editorContext.combined = combined; localStorage.setItem('ol.combined', combined ? '1' : '0'); }, [combined]);

  /** show a document or file (in place — one project, one file at a time), optionally at a label or the n-th heading */
  const openInTab = useCallback((id: string, opts: { goto?: string; heading?: number } = {}) => {
    const target = '#/' + id + (opts.goto ? '?goto=' + encodeURIComponent(opts.goto) : opts.heading !== undefined ? '?heading=' + opts.heading : '');
    if (location.hash === target || (location.hash === '#/' + id && !opts.goto && opts.heading === undefined)) { pendingGoto.current = opts.goto ?? null; pendingHeading.current = opts.heading ?? null; runGoto(); }
    else location.hash = target;
  }, []);
  /** leave the document: back to the start screen */
  const closeDoc = useCallback(() => { location.hash = '#/'; }, []);

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
    const v = editorRef.current?.view;
    const name = pendingGoto.current;
    if (name && v && gotoLabelIn(v, name)) pendingGoto.current = null;
    // ?heading=<n>: the n-th heading (the documents panel's static outline counts them the same way)
    const n = pendingHeading.current;
    if (n !== null && v) {
      const items = buildOutline(v.state.doc, false).filter(i => sectionLevel(i.layout) !== null);
      const it = items[n];
      if (it) { jumpToOutline(v, it); pendingHeading.current = null; }
    }
  };
  /** the cursor to a heading of the outline (the Navigate menu, the documents panel) */
  const jumpToOutline = (v: EditorView, it: OutlineItem) => {
    v.focus();   // before the dispatch: scrollIntoView follows the DOM selection, which must be in the editor
    const tr = v.state.tr.setSelection(TextSelection.near(v.state.doc.resolve(Math.min(it.pos + 1, v.state.doc.content.size)))).scrollIntoView();
    navHistory.jump(() => v.dispatch(tr));
    (v.nodeDOM(it.pos) as HTMLElement | null)?.scrollIntoView?.({ block: 'start' });
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
    else notify(`“${u.name}” has no cursor in this document (yet)`, 'error');
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
        notify(`${docId}: ${reason} — the document was closed (a copy is in the project's versions)`, 'error');
        closeDoc();
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
      refreshMacros(h.view, m?.macros ?? null);
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
        if (e.status === 403) { notify(e.message || 'You no longer have access to this project', 'error'); closeDoc(); return; }
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
    // an offline blip (laptop sleep) leaves the metadata unloaded: fetch it as soon as we are back
    window.addEventListener('online', loadMeta);
    rerender();
    return () => { cancelled = true; clearTimeout(metaRetry); window.removeEventListener('online', loadMeta); handle.destroy(); editorRef.current = null; };
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
        } catch { notify('Your unsynced edits could not be exported. This local copy has been kept; copy your edits before reloading.', 'error'); return; }
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
      toggleOutline: () => setShowFiles(s => !s),
      toggleSource: () => toggleRawSplit(),
      toggleCombined: () => setCombined(c => !c),
      acceptAll: () => run(acceptAllChanges()),
      rejectAll: () => run(rejectAllChanges()),
      closeTab: () => closeDoc(),
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

  const build = async (opts: { open?: boolean } = {}) => {
    if (!docId) return;
    if (opts.open !== false) setRightTab('pdf');   // LyX Update rebuilds without switching to the viewer
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
      const blocks = docBlocks(view);
      const hit = locateSourceLine(tex, r.line - 1, blocks);
      if (!hit) { notify(`SyncTeX: line ${r.line} of the LaTeX source was not found in the document`, 'error'); return; }
      const b = blocks[hit.index];
      const pos = Math.min(b.kind === 'math' ? b.pos : blockPos(b, hit.offset), view.state.doc.content.size);
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
  // the Share button (top right) belongs to the project's owner; the panel reports the project it shows
  const shareProject = curProject && curProject.role === 'owner' && curProject.via !== 'admin' && (!docId || docId.replace(/^(text|pdf):/, '').split('/')[0] === curProject.name) ? curProject.name : null;
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
    { label: 'OverLyX for VS Code (.vsix download)', action: () => { const a = document.createElement('a'); a.href = '/api/vscode-extension'; a.download = ''; document.body.appendChild(a); a.click(); a.remove(); notify('Downloading the extension — install it in VS Code with “Extensions: Install from VSIX…”'); } },
    { label: 'About OverLyX', action: () => alert('OverLyX — a LyX-like collaborative WYSIWYG editor for LaTeX documents.\nDocuments are ordinary .tex files (change tracking and comments live in the file as macros and comment blocks); formulas are edited with a port of LyX\'s math editor; collaboration via Yjs CRDTs.') },
  ] };
  const textFileMenus: MenuDef[] = docId ? [
    { title: 'File', items: [
      { label: 'Open… (documents panel)', shortcut: 'Ctrl+O', action: () => setShowFiles(true) },
      ...(isPdfTab ? [] : [{ label: 'Saved automatically (Ctrl+S saves now)', disabled: true, action: () => {} }]),
      { sep: true },
      { label: 'Download', action: () => window.open(`/api/projects/${encodeURIComponent(textId!.split('/')[0])}/file/${textId!.split('/').slice(1).map(encodeURIComponent).join('/')}`) },
      { label: 'Share project…', action: () => setShareFor(textId!.split('/')[0]) },
      { label: 'Git repository…', action: () => setGitFor(textId!.split('/')[0]) },
      { sep: true },
      { label: 'Close (back to the projects)', action: closeDoc },
    ] },
  ] : [];
  const textColor = markValue(view, 'color');
  // the shortcut table is searchable too (a match opens the table)
  const helpSearchEntries = useMemo(() => HELP_ROWS.map(([k, v]) => ({ id: 'Keyboard shortcuts ▸ ' + v, label: v, path: ['Keyboard shortcuts'], shortcut: k, fixed: true, action: () => setDialog({ name: 'help' }) })), []);
  const sectionItems = useMemo<MenuDef['items']>(() => {
    const v = masterView;
    if (!v) return [];
    return outline.filter(it => it.level < 99 && it.layout !== 'Title').slice(0, 120).map(it => ({
      label: `${'\u2003'.repeat(Math.max(0, it.level - 1))}${it.num ? it.num + '\u2002' : ''}${it.text}`,
      action: () => jumpToOutline(v, it),
      stat: '<heading>',   // the label is the heading's text: the usage statistics see only that a heading was chosen
    }));
  }, [outline, masterView]);
  const toggleCellLine = (key: string) => {
    if (!view) return;
    const $from = view.state.selection.$from;
    let cur: any = null;
    for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === 'table_cell') { cur = $from.node(d); break; }
    const attrs: [string, string][] = cur ? JSON.parse(cur.attrs.attrs || '[]') : [];
    const on = attrs.find(a => a[0] === key)?.[1] === 'true';
    run(C.setCellAttr(key, on ? null : 'true'));
  };

  const editingMenus = documentMenus({ view, meta, run, runView, setDialog, textColor, tracking, changeInfo, toggleTracking, toggleCellLine, setFindOpen,
    healthItems: [
      { label: 'Document health ▸', sub: [
        { label: meta?.health.length ? `${meta.health.length} issue(s) found` : 'No issues found', disabled: true },
        { label: 'Repair', disabled: !meta?.health.some(h => h.fixable), action: runRepair },
        { label: 'Escalate to AI…', disabled: !meta?.health.length, action: () => setDialog({ name: 'airepair' }) },
      ] },
      { sep: true },
    ],
    reloadMetadata: () => { if (docId) api.meta(docId).then(m => { setMeta(m); editorContext.meta = m; if (masterView) refreshMacros(masterView, m.macros); notify('Metadata reloaded'); }); },
  });
  const menus: MenuDef[] = [...(docId && !isLyxDoc ? textFileMenus : docId ? [
    { title: 'File', items: [
      { label: 'New…', shortcut: 'Ctrl+N', action: () => editorContext.ui?.newFile() },
      { label: 'New whiteboard…', action: () => {
        const p = textId?.split('/')[0];
        if (!p) return;
        let name = prompt('New whiteboard name:', 'whiteboard.board');
        if (!name) return;
        if (!name.endsWith('.board')) name += '.board';
        api.upload(p, name, new Blob(['{"overlyx":"board","v":1,"objects":{\n}}\n'], { type: 'application/octet-stream' }), { overwrite: false })
          .then(() => { location.hash = '#/' + p + '/' + name; setRefreshKey(k => k + 1); })
          .catch(e => notify('Could not create the whiteboard: ' + (e as Error).message, 'error'));
      } },
      { label: 'Open… (documents panel)', shortcut: 'Ctrl+O', action: () => setShowFiles(true) },
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
      { label: 'Close (back to the projects)', action: closeDoc },
    ] },
    editingMenus.edit,
    editorViewMenu({ combined, setCombined, marginMode, toggleMargin, run, showRuler, setShowRuler, tbMode, setToolbar, textWidth, setTextWidth, stepTextWidth,
      hostItems: [
      { label: 'LaTeX source beside the document (raw view)', shortcut: 'Ctrl+Alt+S', checked: rawSplit, action: toggleRawSplit },
      { label: 'Outline', shortcut: 'Ctrl+Alt+O', checked: showFiles, action: () => setShowFiles(!showFiles) },
      { label: 'PDF preview', checked: rightTab === 'pdf', action: () => setRightTab(rightTab === 'pdf' ? null : 'pdf') },
      { label: 'Versions', checked: rightTab === 'versions', action: () => setRightTab(rightTab === 'versions' ? null : 'versions') },
      { sep: true },
      ],
      themeItems: [
      { label: 'Theme ▸', sub: [
        { label: 'Follow the system', checked: themePref === 'system', action: () => setThemePref('system') },
        { label: 'Light', checked: themePref === 'light', action: () => setThemePref('light') },
        { label: 'Dark', checked: themePref === 'dark', action: () => setThemePref('dark') },
      ] },
      ],
      hostToolbars: [
        { label: 'Version Control', checked: tbMode('vcs') === 'on', action: () => setToolbar('vcs', tbMode('vcs') === 'on' ? 'off' : 'on') },
      ],
    }),
    editingMenus.insert,
    { title: 'Navigate', items: [
      { label: 'Outline pane (documents panel)', shortcut: 'Ctrl+Alt+O', action: () => setShowFiles(true) },
      { label: 'Go to label…', action: () => { const n = prompt('Label:'); if (n) gotoLabel(n, view ?? undefined); } },
      { label: 'Sync to PDF (forward search)', shortcut: 'Ctrl+Alt+J', action: () => { void syncToPdf(); } },
      { sep: true },
      { label: 'Back', shortcut: NAV_BACK_KEY, disabled: !navHistory.canBack(), action: navBack },
      { label: 'Forward', shortcut: NAV_FORWARD_KEY, disabled: !navHistory.canForward(), action: navForward },
      { label: 'Next document of the project', action: () => { const d = curProject ? projectDocs(curProject).map(x => `${curProject.name}/${x}`) : []; const i = d.indexOf(docId); const n = d[(i + 1) % d.length]; if (n && n !== docId) openInTab(n); } },
      { label: 'Beginning of document', shortcut: 'Ctrl+Home', action: () => { if (view) { view.dispatch(view.state.tr.setSelection(TextSelection.atStart(view.state.doc)).scrollIntoView()); view.focus(); } } },
      { label: 'End of document', shortcut: 'Ctrl+End', action: () => { if (view) { view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)).scrollIntoView()); view.focus(); } } },
      // the document's sections (LyX's Navigate menu lists them too): a click jumps, the palette finds them
      ...(sectionItems.length ? [{ sep: true } as const, ...sectionItems] : []),
    ] },
    editingMenus.document,
    { title: 'Tools', items: [
      { label: 'Spell checking', checked: prefs.spellcheck, action: () => setPref('spellcheck', !prefs.spellcheck) },
      { sep: true },
      { label: 'AI assistance ▸', sub: [
        { label: ai === null ? 'Checking the server…' : ai.available ? `Models: ${prefs.aiModel || ai.model} (⌘K) · ${prefs.aiCompletionModel || ai.completionModel} (autocomplete)` : 'Not configured on this server (OPENROUTER_API_KEY)', disabled: true },
        { label: 'Choose the models… (Settings)', action: () => setDialog({ name: 'preferences', arg: 'ai' }) },
        { label: 'Show the ✦ button on the toolbar (autocomplete on/off)', checked: prefs.aiButton, action: () => setPref('aiButton', !prefs.aiButton) },
        { sep: true },
        { label: `Rewrite with AI (${REWRITE_KEY})`, checked: prefs.aiRewrite, action: () => setPref('aiRewrite', !prefs.aiRewrite) },
        { label: 'Autocomplete text (ghost text, Tab inserts)', checked: prefs.aiCompleteText, action: () => setPref('aiCompleteText', !prefs.aiCompleteText) },
        { label: 'Autocomplete formulas', checked: prefs.aiCompleteMath, action: () => setPref('aiCompleteMath', !prefs.aiCompleteMath) },
        { sep: true },
        { label: 'Rewrite selection with AI…', shortcut: 'Ctrl+K', disabled: !prefs.aiRewrite, action: () => runView(v => openRewrite(v)) },
      ] },
      { sep: true },
      { label: 'Settings…', action: () => setDialog({ name: 'preferences' }) },
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


  /* ------------------------------------------------------------------ toolbars (LyX stdtoolbars.inc) */
  const mathExec = mathExecutor(() => activeViewRef.current ?? editorRef.current?.view);
  const mathPanels = useMathPanels(mathExec);
  const clipboard = toolbarClipboard(() => activeViewRef.current ?? editorRef.current?.view, notify);
  const aiComplete = prefs.aiCompleteText || prefs.aiCompleteMath;
  const docStats = useMemo(() => (view ? documentStats(view) : null), [view, docTick, selTick]);
  // The LyX toolbars (toolbars.tsx — one definition with the VS Code extension); what only the web
  // client has (files, navigation history, the outline sidebar, ink, AI, the master's PDF) goes into the slots.
  const tb = buildToolbars({
    view, docId, meta, headerLines, prefs, layout, mathField, tracking, marginMode, tbMode, setToolbar,
    run, runView, mathExec, mathPanels, clipboard, setDialog, openFind: () => setFindOpen(true), notify,
    toggleTracking: () => { void toggleTracking(); }, toggleMargin,
    build: () => { void build(); }, updatePdf: () => { void build({ open: false }); }, syncToPdf: () => { void syncToPdf(); },
    slots: {
      leading: [
        { id: 'new', title: 'New document (Ctrl+N)', icon: 'new', action: () => editorContext.ui?.newFile() },
        { id: 'open', title: 'Open (Ctrl+O)', icon: 'open', action: () => setShowFiles(true) },
      ],
      navigation: [{ id: 'navback', title: 'Navigate back (Ctrl+Alt+←)', icon: 'navback', action: navBack }],
      sidebars: [{ id: 'outline', title: LEFT_TITLE, icon: 'outline', action: () => setShowFiles(s => !s), active: showFiles }],
      tools: [
        { id: 'ink', title: inkMode ? 'Margin drawing is on — click to put the pen away' : 'Draw in the margins (pen, highlighter; pans sideways for more space)', icon: 'ink', action: () => setInkMode(m => !m), active: inkMode },
        // the ✦ button exists only once it is enabled in the preferences; it switches autocomplete (text + formulas) on and off
        ...(prefs.aiButton ? [{ id: 'ai', title: aiComplete ? 'AI autocomplete is on — click to switch it off' : 'AI autocomplete is off — click to switch it on (ghost text after a pause while typing; Tab inserts it)', icon: 'ai', action: () => { setPref('aiCompleteText', !aiComplete); setPref('aiCompleteMath', !aiComplete); notify(!aiComplete ? 'AI autocomplete on' : 'AI autocomplete off'); }, active: aiComplete } as ToolButton] : []),
      ],
      pdf: meta?.master ? [{ id: 'pdfmaster', title: `View master document (${meta.master.split('/').pop()})`, icon: 'viewmaster', action: () => openInTab(meta.master!) }] : [],
    },
  });
  // The margin-ink toolbar (bottom-docked while drawing is on): tool, then the colour and width
  // of the pen in use — pen and highlighter each keep their own (Goodnotes), so the swatches and
  // dots change with the tool; picking one while erasing or lassoing takes the pen up again.
  // The swatches and dots are presets: one click selects, a click on the selected one opens a
  // picker that replaces it (Goodnotes). The laser is the one tool that works over the text too.
  const inkGroups = inkToolbar();
  // The LyX Version Control toolbar, mapped onto the project's git repository (off by default, as in LyX).
  const vcsGroups: ToolButton[][] = [
    [
      { id: 'vc-git', title: 'Git repository — clone address, access tokens, mirror', icon: 'vcregister', action: () => { const p = (docId ?? '').split('/')[0]; if (p) setGitFor(p); } },
      { id: 'vc-log', title: 'Revision log (the Versions panel)', icon: 'vclog', action: () => { setRightTab('versions'); setSelVersion(v => v + 1); } },
      { id: 'vc-compare', title: 'Compare with an older revision (the Versions panel)', icon: 'vccompare', action: () => { setRightTab('versions'); setSelVersion(v => v + 1); } },
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
    if (dialog.name === 'preferences') return <SettingsPanel ai={ai} user={user!} initial={dialog.arg as 'ai' | undefined} onClose={() => { setDialog(null); view?.focus(); }} />;
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
          return <RefDialog view={view} labels={labels} useRefstyle={!!meta?.useRefstyle} initial={{ name: unquote(p.get('reference')), kind: unquote(p.get('package')) === 'cleveref' ? 'cref' : p.get('LatexCommand') ?? 'ref', tuple: unquote(p.get('tuple')) === 'range' ? 'range' : 'list', caps: unquote(p.get('caps')) === 'true' }} onClose={close}
            onInsert={(n, k, o) => view.dispatch(referenceTransaction(view.state, n, k, o, tpos))} />;
        }
        return <RefDialog view={view} labels={labels} useRefstyle={!!meta?.useRefstyle} initial={target?.prefill ? { name: target.prefill, kind: 'ref' } : undefined} onClose={close} onInsert={(n, k, o) => view.dispatch(referenceTransaction(view.state, n, k, o))} />;
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

  // a guest signs in: with Google directly (back to this document afterwards), else on the sign-in page
  const signIn = () => { if (google) location.assign(googleSignInUrl()); else onSignIn(); };

  return (
    <div class="app">
      <MenuBar menus={menus} user={user} onLogout={onLogout} onSettings={() => setDialog({ name: 'preferences' })} onHome={() => { location.hash = '#/'; }} searchEntries={helpSearchEntries}
        users={isLyxDoc ? status.users : undefined} onJumpToUser={jumpToUser}
        onShare={shareProject ? () => setShareFor(shareProject) : null} shareTitle={shareProject ? `Share “${curProject?.title ?? shareProject}”: invite people or turn on a link` : undefined}
        onSignIn={user.guest ? signIn : undefined}
        primary={isLyxDoc && <ViewModeSwitch mode={viewMode} onChange={changeViewMode} />}
        right={docId && <span class="doc-title" title={docId}>{docLabel}{meta?.master && !combined && <> · child of <a href={'#/' + meta.master} onClick={e => { e.preventDefault(); openInTab(meta.master!); }}>{meta.master.split('/').pop()}</a></>}</span>} />
      {user.guest && <GuestCallout user={user} project={curProject} google={google} onSignIn={signIn} />}
      {isLyxDoc && tbMode('standard') !== 'off' && <Toolbar id="standard" layouts={layouts} layout={layout} onLayout={n => run(C.setLayout(n))} groups={tb.standard} />}
      {/* LyX's default.ui puts View/Update and Extra on one row ("samerow") */}
      {isLyxDoc && (tbMode('viewupdate') !== 'off' || tbMode('extra') !== 'off') && (
        <div class="tb-samerow">
          {tbMode('viewupdate') !== 'off' && <Toolbar id="viewupdate" groups={tb.viewUpdate} />}
          {tbMode('extra') !== 'off' && <Toolbar id="extra" groups={tb.extra} />}
        </div>
      )}
      {isLyxDoc && tbMode('vcs') === 'on' && <Toolbar id="vcs" label="Version Control" groups={vcsGroups} />}
      {/* the contextual math / table / review rows are docked at the bottom (before the StatusBar below) */}
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
          <div class="sidebar left">
            <DocPanel current={textId} currentDoc={isLyxDoc ? docId : null} refreshKey={refreshKey} outline={outline} activePos={activePos} view={masterView}
              onOpen={(id, o) => openInTab(id, o)} onGit={p => setGitFor(p)} onHide={() => setShowFiles(false)} onProject={setCurProject} notify={notify} />
          </div>
        ) : (
          <div class="rail left"><button data-rail="outline" title={LEFT_TITLE} onClick={() => setShowFiles(true)}>Documents</button></div>
        )}
        {showFiles && <SidebarGrip side="left" />}
        <div class={'editor-column' + (isLyxDoc ? ' view-' + viewMode + (viewMode === 'wysiwyg' ? '' : ' split') : '')}>
        <div class={'editor-scroll' + (marginMode ? ' margin-mode' : '') + (inkMode && isLyxDoc ? ' ink-pan' : '')} ref={scrollRef} onClick={e => { if (e.target === e.currentTarget && view) view.focus(); }}>
          {(isLyxDoc || isTextTab) && showRuler && <Ruler width={textWidth} onChange={setTextWidth} marginMode={isLyxDoc && marginMode} noteScale={noteScale} onNoteScale={setNoteScale} />}
          {docId ? (isPdfTab ? <div class="pdf-tab"><PdfViewer key={docId} url={fileUrl(textId!.split('/')[0], textId!.split('/').slice(1).join('/'))} toolbar={<a class="small-btn" href={fileUrl(textId!.split('/')[0], textId!.split('/').slice(1).join('/')) + '?download=1'}>Download</a>} /></div> : isBoardTab ? <BoardEditor key={docId} id={docId} user={user} notify={notify} /> : !isLyxDoc ? (/\.(md|markdown)$/i.test(textId!) ? <MarkdownEditor key={docId} id={textId!} notify={notify} /> : <TextEditor key={docId} id={textId!} notify={notify} />) :
            <div class="editor-page">
              <div class="editor-host" ref={containerRef} />
              {combined && childIds.map(id => (
                <ChildEditor key={id + ':' + reloadKey} id={id} user={user} marginMode={marginMode} readOnly={viewOnly} onSelection={onSelection} onDocChange={() => { setDocTick(t => t + 1); }} onStale={resolveStale}
                  register={(cid, h) => { if (h) childRefs.current.set(cid, h); else childRefs.current.delete(cid); rerender(); }} />
              ))}
            </div>
          ) : <Home user={user} refreshKey={refreshKey} onOpen={id => openInTab(id)} onStartTour={id => { openInTab(id); setTour('steps'); }} onShare={p => setShareFor(p)} onGit={p => setGitFor(p)} onChanged={() => setRefreshKey(k => k + 1)} onBrowse={() => setShowFiles(true)} onSignIn={signIn} notify={notify} />}
        </div>
        {isLyxDoc && <SourcePane key={docId!} target={sourceTarget} tick={docTick} selTick={selTick} mathField={mathField} onNotify={notify} onClose={() => changeViewMode('wysiwyg')} />}
        </div>
        {isLyxDoc && !rightTab && (
          <div class="rail right">
            {RIGHT_TABS.filter(t => t !== 'agent' || aiActivated).map(t => <button key={t} data-rail={t} title={RIGHT_TAB_TITLES[t]} onClick={() => { setRightTab(t); if (t === 'versions') setSelVersion(v => v + 1); }}>{RIGHT_TAB_LABELS[t]}</button>)}
            <button data-rail="source" class={rawSplit ? 'active' : ''} title={SOURCE_TITLE} onClick={toggleRawSplit}>Source</button>
          </div>
        )}
        {isLyxDoc && rightTab && <SidebarGrip side="right" />}
        {isLyxDoc && rightTab && (
          <div class={'sidebar right' + (rightTab === 'pdf' ? ' wide' : '')}>
            <div class="panel-tabs">
              <button class={rightTab === 'comments' ? 'active' : ''} data-tab="comments" onClick={() => setRightTab('comments')} title={RIGHT_TAB_TITLES.comments}>Comments</button>
              <button class={rightTab === 'pdf' ? 'active' : ''} data-tab="pdf" onClick={() => setRightTab('pdf')} title={RIGHT_TAB_TITLES.pdf}>PDF</button>
              <button class={rightTab === 'versions' ? 'active' : ''} data-tab="versions" onClick={() => { setRightTab('versions'); setSelVersion(v => v + 1); }} title={RIGHT_TAB_TITLES.versions}>Versions</button>
              {aiActivated && <button class={rightTab === 'agent' ? 'active' : ''} data-tab="agent" onClick={() => setRightTab('agent')} title={RIGHT_TAB_TITLES.agent}>Agent</button>}
              <button class={'toggle' + (rawSplit ? ' on' : '')} data-tab="source" onClick={toggleRawSplit} title={SOURCE_TITLE}>Source</button>
              <button class="hide" title="Hide the sidebar" onClick={() => setRightTab(null)}>»</button>
            </div>
            {rightTab === 'comments' && <div class="panel-body"><Comments views={[masterView, ...[...childRefs.current.values()].map(h => h.view)].filter((v): v is EditorView => !!v)} tick={docTick} /></div>}
            {rightTab === 'pdf' && <PdfPanel docId={docId} state={pdf} onBuild={build} onCancel={cancelBuild} onShowTex={showTex} syncTarget={syncTarget} onForward={() => { void syncToPdf(); }} onInverse={(pg, x, y) => { void syncFromPdf(pg, x, y); }} />}
            {rightTab === 'versions' && <div class="panel-body"><Versions docId={docId} refreshKey={selVersion} /></div>}
            {rightTab === 'agent' && <AgentPanel project={docId.split('/')[0]} notify={notify} />}
          </div>
        )}
      </div>
      {/* Contextual toolbars, docked above the status bar like LyX. They are an overlay
          (.bottom-toolbars is absolutely positioned), so their coming and going with the cursor
          never shifts the document. */}
      {isLyxDoc && (tb.showMath || tb.showTable || tb.showReview || inkMode) && (
        <div class="bottom-toolbars" style={{ left: showFiles ? 'var(--left-width, 272px)' : '24px', right: rightTab ? (rightTab === 'pdf' ? 'var(--right-width, 46%)' : 'var(--right-width, 360px)') : '24px' }}>
          {tb.showMath && <Toolbar id="math" label="Math" groups={tb.math} />}
          {tb.showMath && tbMode('mathpanels') !== 'off' && <Toolbar id="mathpanels" label="Panels" groups={tb.mathPanels} />}
          {tb.showTable && <Toolbar id="table" label="Table" groups={tb.table} />}
          {tb.showReview && <Toolbar id="review" label="Review" groups={tb.review} />}
          {inkMode && <Toolbar id="ink" label="Draw" groups={inkGroups} />}
        </div>
      )}
      <StatusBar layout={layout} status={status} chord={chord} message={message} save={save} tracking={tracking} trackingAs={user.name} change={changeInfo}
        docLabel={view && masterView && view !== masterView ? viewDocId(view).split('/').pop() ?? null : null}
        readOnly={!!docId && viewOnly} updateReady={updateReady} aiBusy={aiBusy > 0}
        quiet={!!docId && !isLyxDoc} stats={docStats} zoom={zoom} onZoom={setZoom} />
      {renderDialog()}
      {shareFor && <ShareDialog project={shareFor} user={user} onClose={() => setShareFor(null)} onChanged={() => setRefreshKey(k => k + 1)} />}
      {gitFor && <GitDialog project={gitFor} user={user} onClose={() => setGitFor(null)} />}
      {tour && <Tour intro={tour === 'intro'} onEnd={endTour}
        ctx={{ docId, ready: isLyxDoc && status.synced && !!view, docTick, layout, inMath: !!mathField, saveState: save.state, rightTab, pdfBusy: pdf.busy, pdfBuiltAt: pdf.builtAt ?? 0, shareOpen: !!shareFor, gitOpen: !!gitFor, marginMode }}
        actions={{ openExample, showRight: () => { if (!rightTab) setRightTab('pdf'); }, showFiles: () => setShowFiles(true) }} />}
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

function ChildEditor({ id, user, marginMode, readOnly, onSelection, onDocChange, onStale, register }: { id: string; user: User; marginMode: boolean; readOnly?: boolean; onSelection: (v: EditorView) => void; onDocChange: () => void; onStale: (handle: EditorHandle, id: string, pending: boolean) => Promise<void>; register: (id: string, h: EditorHandle | null) => void }) {
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
        onStale: info => { if (handle) void onStale(handle, id, info.pendingLocal); } });
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

export { schema };
