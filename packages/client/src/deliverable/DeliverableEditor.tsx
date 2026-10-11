/**
 * The editor of HTML deliverables — slide decks, posters, web pages (core html/): the page itself,
 * rendered in a sandboxed frame by the runtime (runtime/), is the canvas; this component owns the
 * text, through its host (host.ts — in the web app a Y.Text synced like any document, server docs.ts
 * HtmlDoc; in VS Code the file's TextDocument), so people, agents (the file tools) and the code view
 * all edit the same characters live. What people do on the canvas arrives as operations on the
 * version the frame showed, is rebased onto the text as it is now (sourceops.ts) and applied as
 * splices — nothing else of the file changes.
 *
 * Around the canvas: the slide rail (a second frame, small), the toolbar (insert objects, format the
 * selection, arrange), speaker notes, the code (a textarea on the same text), presenting (a third
 * frame, full screen), and the host's downloads.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { type User } from '../api';
import { showContextMenu, closeContextMenu, type MenuItem } from '../editor/contextmenu';
import { Toolbar, ICONS } from '../app/Toolbar';
import { ColorGrid } from '../app/ColorGrid';
import type { DeliverableHost, Peer } from './host';
import { webHost } from './webHost';
import type { FromRuntime, ToRuntime, SelItem, SlideBox, Tool, Path, HtmlOp, DeliverableKind, Rect, ArrangeHow, Paint, CanvasView, KeyPress, Solo, ObjNode } from './protocol';
import { SlideView } from './viewport';
import { pinchFactor, pinchLock, triGesture, type PinchLock } from './gestures';
import { isFromRuntime } from './protocol';
import { rebasedSplices, objectHtml, imageHtml, insertPlace, newSlideHtml, slidePaths, slideNotes, notesOp, sourceRange, inlineSvgHtml } from './sourceops';
import { sizePt, stepPt } from './units';
import { deckToolbar, quickGroups, type DeckTextActions } from './decktoolbar';
import { loadDeckInk, saveDeckInk, patchDeckInk, deckInkStyle, type DeckInk, type DeckInkPatch } from './deckink';
import { QuickBar } from './QuickBar';
import { BgRemoveDialog } from './BgRemoveDialog';
import { MathOverlay, type MathEditState, type MathOps } from './MathOverlay';
import { AnimationPane, type Sequence } from './AnimationPane';
import { ObjectsPane } from './ObjectsPane';
import { CiteDialog, uiPrompt } from '../app/Dialogs';
import type { DocMeta } from '../api';
import { citedKeys, citeEntry, type CiteEntry } from '@overlyx/core/html/refs.ts';
import type { MathJaxMacro } from '@overlyx/core/html/deckextras.ts';
import type { MacroTable } from '@overlyx/core';
import { activeMathField } from '../editor/lyxmath/field';
import { mathReady } from '../editor/lyxmath/mathjax';
import { setLayoutMathFont } from '../fonts/editorfont';
import { useMathPanels } from '../app/toolbars';
import { parseSource, opSplices, elementAt, elementChildren, attr } from '@overlyx/core/html/source.ts';
import { reviewOps, resolveOps, resolveAll, reviewOf, isSuggesting, suggestingOp, stampOf, threadsOp, parseThreads, newThreadId, describe as describeObject, COMMENTS, type ReviewChange, type ReviewThread, type Thread } from '@overlyx/core/html/review.ts';
import { slideElements } from '@overlyx/core/html/deliverable.ts';
import { formatTimestamp } from '@overlyx/core';
import { ReviewPane, type CommentDraft } from './ReviewPane';
import { EditModeSwitch, type EditMode } from '../app/EditModeSwitch';
import { useDarkSlides, DARK_DESK } from '../app/darkslides';
import { setPref } from '../prefs';

const PAD = 48;
/** the slide rail's width: by default, and as far as its edge can be dragged */
const RAIL_W = 170, RAIL_MIN = 110, RAIL_MAX = 480;
/** the rail's header (which slide of how many, «): the thumbnails' frame starts under it */
const RAIL_HEAD = 28;
/** the slide rail and the speaker notes, shown or hidden (this browser's; a narrow screen starts without the rail) */
function loadShown(key: string, narrowHides: boolean): boolean {
  try { const v = localStorage.getItem(key); if (v !== null) return v === '1'; } catch { /* private window */ }
  return !(narrowHides && typeof innerWidth === 'number' && innerWidth < 700);
}
function saveShown(key: string, on: boolean): void {
  try { localStorage.setItem(key, on ? '1' : '0'); } catch { /* private window */ }
}
function loadRailW(): number {
  try { const v = Number(localStorage.getItem('ol.deckRail')); return v >= RAIL_MIN && v <= RAIL_MAX ? v : RAIL_W; } catch { return RAIL_W; }
}
const CHECKER = 'repeating-conic-gradient(#e3e5e8 0 25%, #ffffff 0 50%) 0 0 / 16px 16px';
const NO_VIEW: CanvasView = { desk: null, deskChecker: false, pageChecker: false };

/** how this browser shows what is around a document's pages (view only, never in the file) */
function loadView(path: string): CanvasView {
  try { const v = JSON.parse(localStorage.getItem('ol.canvas:' + path) ?? 'null'); return v && typeof v === 'object' ? { ...NO_VIEW, ...v } : NO_VIEW; } catch { return NO_VIEW; }
}
function saveView(path: string, v: CanvasView): void {
  try { if (v.desk === null && !v.deskChecker && !v.pageChecker) localStorage.removeItem('ol.canvas:' + path); else localStorage.setItem('ol.canvas:' + path, JSON.stringify(v)); } catch { /* private window */ }
}

/** the same slide shown in the same place (a layout that changes nothing does not render the editor) */
function sameSolo(a: Solo | null, b: Solo | null): boolean {
  if (!a || !b) return a === b;
  const r = a.rect, q = b.rect;
  return a.slide === b.slide && Math.abs(a.height - b.height) < 2 && Math.abs(r.x - q.x) < 1 && Math.abs(r.y - q.y) < 1 && Math.abs(r.w - q.w) < 1 && Math.abs(r.h - q.h) < 1;
}

/** the natural size of a picture file (null when the browser cannot decode it) */
async function naturalSize(data: Blob): Promise<{ w: number; h: number } | null> {
  try { const b = await createImageBitmap(data); const r = { w: b.width, h: b.height }; b.close?.(); return r; } catch { return null; }
}

type Notify = (text: string, kind?: 'info' | 'error') => void;

const samePath = (a: Path | null | undefined, b: Path | null | undefined) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);
/** `inner` is `outer` or inside it */
const within = (outer: Path, inner: Path) => outer.length <= inner.length && outer.every((x, i) => x === inner[i]);

function loadFlag(key: string, dflt: boolean): boolean {
  try { const v = localStorage.getItem(key); return v === null ? dflt : v === '1'; } catch { return dflt; }
}
function saveFlag(key: string, on: boolean): void {
  try { localStorage.setItem(key, on ? '1' : '0'); } catch { /* private window */ }
}

interface Link { base: string; entry: string; expires: number }

/** The deliverable editor of the web app: its host keeps the text in a Y.Text synced with the server (webHost.ts). */
export function DeliverableEditor({ id, user, notify }: { id: string; user: User; notify: Notify }) {
  const host = useMemo(() => webHost(id, user), [id]);
  useEffect(() => () => host.destroy(), [host]);
  return <DeliverableCanvas key={id} host={host} notify={notify} />;
}

/** The editor around the page, wherever it runs (`host`: the web app's, the VS Code extension's). */
export function DeliverableCanvas({ host, notify }: { host: DeliverableHost; notify: Notify }) {
  const path = host.path;
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const [, bump] = useState(0);
  const rerender = () => bump(t => t + 1);
  const text = { toString: () => host.text() };

  const [synced, setSynced] = useState(host.ready());
  const [online, setOnline] = useState(true);
  const [readOnly, setReadOnly] = useState(false);
  /** the mode switch's Viewing: this editor only reads (the page may still be editable) */
  const [viewing, setViewing] = useState(false);
  /** nothing is changed from here: shared for viewing, or Viewing chosen */
  const locked = readOnly || viewing;
  const readOnlyRef = useRef(false); readOnlyRef.current = locked;
  const hostReadOnly = useRef(false); hostReadOnly.current = readOnly;
  /** the others on the page (sent again to a frame that (re)loads) */
  const peersRef = useRef<Peer[]>([]);

  /* ------------------------------------------------------------- review: comments and suggestions (core html/review.ts) */

  /** who comments and suggests here */
  const me = host.author?.() || 'You';
  const textNow = host.text();
  /** Suggesting: a setting of the page (its <meta>), for everyone editing it, as in documents */
  const suggesting = isSuggesting(textNow);
  const review = useMemo(() => reviewOf(textNow), [textNow]);
  const [showIns, setShowIns] = useState(() => loadFlag('ol.deckShowIns', true));
  const [showDel, setShowDel] = useState(() => loadFlag('ol.deckShowDel', true));
  const [reviewOpen, setReviewOpenState] = useState(() => loadFlag('ol.reviewPane', false));
  const setReviewOpen = (on: boolean) => { setReviewOpenState(on); saveFlag('ol.reviewPane', on); };
  /** the thread looked at (its pin highlighted, its words too) */
  const [focus, setFocus] = useState<{ path: Path; id: string; quote?: string } | null>(null);
  /** a new comment being written */
  const [draft, setDraft] = useState<CommentDraft | null>(null);

  /** every version of the text sent to the frames, kept a little while for rebasing their operations */
  const versions = useRef(new Map<number, string>());
  const version = useRef(0);

  /* ------------------------------------------------------------- the frames */

  const [link, setLink] = useState<Link | null>(null);
  const canvasBox = useRef<HTMLDivElement>(null);
  const canvasFrame = useRef<HTMLIFrameElement>(null);
  const railBox = useRef<HTMLDivElement>(null);
  const railFrame = useRef<HTMLIFrameElement>(null);
  const presentFrame = useRef<HTMLIFrameElement>(null);
  const [kind, setKind] = useState<DeliverableKind>('deck');
  const [slides, setSlides] = useState<SlideBox[]>([]);
  /** a deck's or poster's one slide on the canvas (runtime solo.ts): the frame is sized to it and panned here (viewport.ts) */
  const [solo, setSolo] = useState<Solo | null>(null);
  const [pageW, setPageW] = useState(1280);
  const pageWRef = useRef(pageW); pageWRef.current = pageW;
  const [pageH, setPageH] = useState(0);
  const [railW, setRailW] = useState(loadRailW);
  const [box, setBox] = useState({ w: 800, h: 600 });
  const [railH, setRailH] = useState(600);
  const [zoom, setZoom] = useState(1);
  /** the frame's left edge when it is wider than the canvas (zoomed in): panned sideways */
  const [panX, setPanX] = useState(0);
  const [scrollY, setScrollY] = useState(0);
  const scrollRef = useRef(0);
  const [view, setViewState] = useState<CanvasView>(() => loadView(host.path));
  // the dark theme: a dark grey canvas unless one was chosen; the slides light on dark if asked for (app/darkslides.ts)
  const darkS = useDarkSlides();
  const darkRef = useRef(darkS); darkRef.current = darkS;
  const shownView = (v: CanvasView): CanvasView => (darkRef.current.dark && v.desk === null && !v.deskChecker ? { ...v, desk: DARK_DESK } : v);
  const [colors, setColors] = useState<{ desk: string; page: string } | null>(null);
  const [floatPop, setFloatPop] = useState<{ x: number; y: number; title: string; render: (close: () => void) => ComponentChildren } | null>(null);
  const [cropping, setCropping] = useState<Path | null>(null);
  const [bgFor, setBgFor] = useState<{ url: string; name: string; imgPath: Path; src: string } | null>(null);
  /** where the next scale is anchored (a pinch: the point under the fingers stays put) */
  const anchorRef = useRef<{ docY: number; screenY: number } | null>(null);
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [current, setCurrent] = useState(0);
  const [sel, setSel] = useState<SelItem[]>([]);
  /** something selected is being dragged on the canvas (the quick menu steps aside) */
  const [dragging, setDragging] = useState(false);
  const [editingText, setEditingText] = useState<Path | null>(null);
  const editingTextRef = useRef(false); editingTextRef.current = !!editingText;
  /** a formula of the text being retyped, open in LyX's formula editor (MathOverlay) */
  const [mathEdit, setMathEdit] = useState<MathEditState | null>(null);
  /** keys typed between placing a new formula and LyX's field opening on it (given to the field then) */
  const typeAhead = useRef<string[] | null>(null);
  /** a text box was just drawn and is not retyped yet: keys typed out here are passed to the frame, which types them into it (runtime drawAhead) */
  const textAhead = useRef<boolean>(false);
  const textAheadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** a key for a text box being made: passed on (true), or not one of those keys */
  const holdForText = (k: KeyPress): boolean => {
    if (!textAhead.current || k.ctrl || k.meta || k.alt) return false;
    if (k.key.length !== 1 && k.key !== 'Backspace' && k.key !== 'Enter') return false;
    toCanvas({ ol: 'typeKeys', keys: [k] });
    return true;
  };
  const typeAheadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** where the keys typed in the canvas while a formula opened go (MathOverlay) */
  const mathKeysIn = useRef<((id: number, keys: KeyPress[]) => void) | null>(null);
  /** the open formula's numbering and label (the math row's Number and Label) */
  const mathOps = useRef<MathOps | null>(null);
  /** the macros of the .tex files the page links (runtime's ready), for LyX's formula editor */
  const [deckMacros, setDeckMacros] = useState<MacroTable>({});
  /** the citation dialog (Cite while typing a text) */
  const [citeOpen, setCiteOpen] = useState(false);
  /** bibliography entries fetched for keys the page cites (sent to the frames) and the keys asked for */
  const bibKnown = useRef(new Map<string, CiteEntry>());
  const bibAsked = useRef(new Set<string>());
  /** the node editor on a path (runtime/pathedit.ts): how many of its nodes are selected */
  const [nodeEd, setNodeEd] = useState<{ selected: number; total: number } | null>(null);
  const nodeEdRef = useRef(false); nodeEdRef.current = !!nodeEd;
  const [tool, setToolState] = useState<Tool>('select');
  /** Draw: the pen's and the highlighter's presets, which of them is in hand (deckink.ts) */
  const [ink, setInkState] = useState<DeckInk>(loadDeckInk);
  const inkRef = useRef(ink); inkRef.current = ink;
  const setInk = (p: DeckInkPatch) => { const v = patchDeckInk(inkRef.current, p); inkRef.current = v; setInkState(v); saveDeckInk(v); };
  /** the slide rail and the speaker notes, hidden or not (their « / ▾ buttons) */
  const [railShown, setRailShownState] = useState(() => loadShown('ol.deckSlides', true));
  const [notesShown, setNotesShownState] = useState(() => loadShown('ol.deckNotes', false));
  const setRailShown = (on: boolean) => { setRailShownState(on); saveShown('ol.deckSlides', on); };
  const setNotesShown = (on: boolean) => { setNotesShownState(on); saveShown('ol.deckNotes', on); };
  const [codeOpen, setCodeOpen] = useState(false);
  // the Animation pane (open or not: this browser's) and the sequence of the slide it shows (runtime/animate.ts)
  const [animOpen, setAnimOpen] = useState(() => { try { return localStorage.getItem('ol.animPane') === '1'; } catch { return false; } });
  const [seq, setSeq] = useState<Sequence>({ slide: -1, rows: [], steps: 1, ordering: null });
  const [objOpen, setObjOpen] = useState(() => { try { return localStorage.getItem('ol.objPane') === '1'; } catch { return false; } });
  const objOpenRef = useRef(objOpen); objOpenRef.current = objOpen;
  const [objects, setObjects] = useState<{ slide: number; items: ObjNode[] }>({ slide: -1, items: [] });
  const [presenting, setPresenting] = useState(false);
  const canvasReady = useRef(false);
  const railReady = useRef(false);
  const pending = useRef<{ select?: Path[]; editText?: Path; math?: boolean } | null>(null);

  const frameW = kind === 'page' ? (device === 'mobile' ? 390 : 1280) : pageW + PAD * 2;
  const soloOn = !!solo && kind !== 'page' && solo.rect.w > 0 && solo.rect.h > 0;
  /** room kept around the slide on the canvas (screen px) */
  const margin = box.w < 600 ? 12 : 32;
  // one slide: the whole of it fits (both ways); a web page: its width
  const fit = soloOn
    ? Math.max(0.05, Math.min(2, (box.w - 2 * margin) / solo!.rect.w, (box.h - 2 * margin) / solo!.rect.h))
    : Math.max(0.05, Math.min(kind === 'page' ? 1 : 2, (box.w - 24) / frameW));
  const scale = fit * zoom;
  const showRail = kind === 'deck';
  const railOpen = showRail && railShown;
  const railScale = Math.max(0.05, (railW - 20) / frameW);

  const toFrame = (f: HTMLIFrameElement | null, msg: ToRuntime) => { try { f?.contentWindow?.postMessage(msg, '*'); } catch { /* gone */ } };
  const toCanvas = (msg: ToRuntime) => toFrame(canvasFrame.current, msg);
  const toRail = (msg: ToRuntime) => toFrame(railFrame.current, msg);

  /** the address of the folder; renewed before it expires */
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const get = () => host.link().then(l => {
      if (cancelled) return;
      setLink(prev => prev ?? { expires: 0, ...l });
      if (l.expires) timer = setTimeout(get, Math.max(60000, l.expires - Date.now() - 10 * 60000));
    }).catch(e => { if (!cancelled) notify('Could not open the page: ' + (e as Error).message, 'error'); });
    void get();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [host]);

  // LyX's formula editor draws in the slides' math font (the runtime's MathJax: New Computer
  // Modern, whatever font the editor uses for documents), its data fetched before a formula opens
  useEffect(() => {
    setLayoutMathFont('newcm');
    if (/\\\(|\\\[|\$\$/.test(text.toString())) void mathReady();
    return () => setLayoutMathFont(null);
  }, [host]);

  // citations typed or pasted since the frames were served: their entries fetched and sent (runtime/cite.ts)
  useEffect(() => {
    if (!host.bibliography) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const sync = () => {
      const keys = citedKeys(text.toString()).filter(k => !bibAsked.current.has(k));
      if (!keys.length) return;
      for (const k of keys) bibAsked.current.add(k);
      host.bibliography!(keys).then(list => {
        const entries = list.map(e => citeEntry(e));
        for (const e of entries) bibKnown.current.set(e.key, e);
        if (!entries.length) return;
        toCanvas({ ol: 'bib', entries }); toRail({ ol: 'bib', entries }); toFrame(presentFrame.current, { ol: 'bib', entries });
      }).catch(() => { for (const k of keys) bibAsked.current.delete(k); });
    };
    syncBibRef.current = sync;
    const off = host.onChange(() => { if (t) clearTimeout(t); t = setTimeout(sync, 400); });
    const offReady = host.onReady(sync);
    if (host.ready()) sync();
    return () => { off(); offReady(); if (t) clearTimeout(t); syncBibRef.current = null; };
  }, [host]);
  const syncBibRef = useRef<(() => void) | null>(null);

  /* ------------------------------------------------------------- versions to the frames */

  const sendTimer = useRef<{ canvas: ReturnType<typeof setTimeout> | null; rail: ReturnType<typeof setTimeout> | null }>({ canvas: null, rail: null });
  const sendSource = (now = false) => {
    const html = text.toString();
    const v = ++version.current;
    versions.current.set(v, html);
    for (const k of versions.current.keys()) if (k < v - 40) versions.current.delete(k);
    const t = sendTimer.current;
    if (t.canvas) clearTimeout(t.canvas);
    const toC = () => { t.canvas = null; if (canvasReady.current) toCanvas({ ol: 'source', version: v, html }); };
    if (now) toC(); else t.canvas = setTimeout(toC, 40);
    if (t.rail) clearTimeout(t.rail);
    t.rail = setTimeout(() => { t.rail = null; if (railReady.current) toRail({ ol: 'source', version: v, html: text.toString() }); }, 350);
  };

  useEffect(() => {
    const offs = [
      host.onChange(origin => { sendSource(origin === 'canvas'); codeSync(origin); rerender(); }),
      host.onStatus(() => setOnline(host.online())),
      host.onReady(() => { setSynced(true); sendSource(true); }),
      host.onPeers(peers => { peersRef.current = peers; toCanvas({ ol: 'peers', peers }); toRail({ ol: 'peers', peers }); }),
      host.onAsset((p, v) => { toCanvas({ ol: 'asset', path: p, v }); toRail({ ol: 'asset', path: p, v }); }),
    ];
    if (host.ready()) { setSynced(true); sendSource(true); }
    const ro = setInterval(() => { if (host.readOnly() !== hostReadOnly.current) setReadOnly(host.readOnly()); }, 1000);
    setReadOnly(host.readOnly());
    return () => { for (const off of offs) off(); clearInterval(ro); };
  }, [host]);

  /* ------------------------------------------------------------- changes of the text */

  /** splices of the text, as one undo step */
  const applySplices = (splices: { from: number; to: number; insert: string }[], origin: 'canvas' | 'code' = 'canvas') => {
    if (readOnlyRef.current || !splices.length) return;
    host.apply(splices, origin);
  };

  /** who and when, while suggesting (null: edits are direct) */
  const suggestStamp = () => (isSuggesting(text.toString()) ? stampOf(me) : null);

  /**
   * operations on the current text (from this side: the toolbar, the rail's menu) — while suggesting
   * made suggestions (core reviewOps); `raw`: as they are (comments, accepting / rejecting, notes)
   */
  const applyOps = (ops: HtmlOp[], raw = false): boolean => {
    const cur = text.toString();
    const src = parseSource(cur);
    try {
      const sp = (raw ? ops : reviewOps(src, ops, suggestStamp())).flatMap(op => opSplices(src, op));
      applySplices(sp);
      return true;
    } catch (e) { notify(String((e as Error).message ?? e), 'error'); return false; }
  };

  /** operations the canvas made on version `v` */
  const applyRuntimeOps = (v: number, ops: HtmlOp[]): boolean => {
    const base = versions.current.get(v);
    const cur = text.toString();
    if (base === undefined) { notify('The page changed meanwhile — try again.', 'error'); return false; }
    let reviewed: HtmlOp[];
    try { reviewed = reviewOps(parseSource(base), ops, suggestStamp()); } catch { reviewed = ops; }
    const sp = rebasedSplices(base, cur, reviewed);
    if (!sp) { notify('Somebody changed that object meanwhile — try again.', 'error'); sendSource(true); return false; }
    applySplices(sp);
    return true;
  };

  /* ------------------------------------------------------------- review: comments and suggestions */

  /** the whole text replaced by `next`, as the one stretch that changed (one undo step) */
  const replaceText = (next: string): boolean => {
    const old = text.toString();
    if (old === next) return false;
    let p = 0;
    const max = Math.min(old.length, next.length);
    while (p < max && old[p] === next[p]) p++;
    let s = 0;
    while (s < max - p && old[old.length - 1 - s] === next[next.length - 1 - s]) s++;
    applySplices([{ from: p, to: old.length - s, insert: next.slice(p, next.length - s) }]);
    return true;
  };
  /** a person's suggestions on an object accepted or rejected */
  const resolveChange = (c: ReviewChange, accept: boolean) => {
    if (readOnlyRef.current) return;
    applyOps(resolveOps(text.toString(), c.path, accept, { by: c.by }), true);
  };
  const resolveEverything = (accept: boolean) => {
    if (readOnlyRef.current) return;
    const n = reviewOf(text.toString()).changes.length;
    if (replaceText(resolveAll(text.toString(), accept))) notify(`${accept ? 'Accepted' : 'Rejected'} ${n} suggestion${n === 1 ? '' : 's'} — Ctrl+Z undoes it.`);
  };
  /** the mode switch: Viewing is this editor's; Editing / Suggesting the page's setting */
  const setMode = (m: EditMode) => {
    setViewing(m === 'viewing');
    if (m === 'viewing' || hostReadOnly.current) return;
    const op = suggestingOp(text.toString(), m === 'suggesting');
    if (op) applyOps([op], true);
  };
  const setChanges = (ins: boolean, del: boolean) => { setShowIns(ins); setShowDel(del); saveFlag('ol.deckShowIns', ins); saveFlag('ol.deckShowDel', del); };

  /** the comment threads on an element, changed (written as they are, also while suggesting) */
  const editThreads = (path: Path, f: (ts: Thread[]) => Thread[]) => {
    if (readOnlyRef.current) return;
    const el = elementAt(parseSource(text.toString()).doc, path);
    if (!el) { notify('That object is no longer there.', 'error'); return; }
    applyOps([threadsOp(path, f(parseThreads(attr(el, COMMENTS))))], true);
  };
  /** a new comment on what the canvas said it is on (the selection, the text retyped and its words, the slide; the page) */
  const startDraft = (path: Path | null, slide: number, quote?: string) => {
    if (readOnlyRef.current) { notify(hostReadOnly.current ? 'You can only view this page.' : 'Switch from Viewing to Editing or Suggesting to comment.', 'error'); return; }
    const { doc } = parseSource(text.toString());
    let p = path ?? (slide >= 0 ? slidesRef.current[slide]?.path ?? null : null);
    if (!p) { const root = elementAt(doc, []); const b = root ? elementChildren(root).findIndex(k => k.tagName === 'body') : -1; p = b >= 0 ? [b] : null; }
    const el = p ? elementAt(doc, p) : null;
    if (!p || !el) return;
    setReviewOpen(true);
    setFocus(null);
    setDraft({ path: p, slide, quote, what: el.tagName === 'body' ? 'the page' : describeObject(el, slideElements(doc)) });
  };
  const submitDraft = (v: string) => {
    const d = draft;
    if (!d?.path) return;
    const th: Thread = { id: newThreadId(), by: me, at: formatTimestamp(), text: v, ...(d.quote ? { quote: d.quote } : {}) };
    editThreads(d.path, ts => [...ts, th]);
    setDraft(null);
    setFocus({ path: d.path, id: th.id, quote: d.quote });
  };
  const replyTo = (t: ReviewThread, v: string) =>
    editThreads(t.path, ts => ts.map(x => (x.id === t.thread.id ? { ...x, re: [...(x.re ?? []), { by: me, at: formatTimestamp(), text: v }] } : x)));
  const resolveThread = (t: ReviewThread, done: boolean) =>
    editThreads(t.path, ts => ts.map(x => { if (x.id !== t.thread.id) return x; const { done: _was, ...rest } = x; void _was; return done ? { ...rest, done: true } : rest; }));
  const removeThread = (t: ReviewThread) => {
    editThreads(t.path, ts => ts.filter(x => x.id !== t.thread.id));
    if (focus?.id === t.thread.id) setFocus(null);
  };
  /** a card of the Review pane clicked: its slide shown, its object selected, its thread looked at */
  const showOnCanvas = (path: Path, slide: number, threadId?: string) => {
    const other = slide >= 0 && slide !== currentRef.current;
    if (other) gotoSlide(slide);
    if (!slidesRef.current.some(s => samePath(s.path, path))) setTimeout(() => toCanvas({ ol: 'select', paths: [path] }), other ? 80 : 0);
    if (threadId) { const t = review.threads.find(x => x.thread.id === threadId && samePath(x.path, path)); setFocus({ path, id: threadId, quote: t?.thread.quote }); }
    else setFocus(null);
  };
  const reviewMsg = (): ToRuntime => ({ ol: 'review', view: {
    ins: showIns, del: showDel, suggesting: suggesting && !locked, me,
    focus: focus ? { path: focus.path, quote: focus.quote } : draft?.path ? { path: draft.path, quote: draft.quote } : null,
  } });
  const reviewMsgRef = useRef(reviewMsg); reviewMsgRef.current = reviewMsg;
  useEffect(() => { toCanvas(reviewMsg()); }, [showIns, showDel, suggesting, locked, me, JSON.stringify(focus), JSON.stringify(draft?.path ?? null), draft?.quote]);

  /* ------------------------------------------------------------- the runtime's messages */

  const selRef = useRef(sel); selRef.current = sel;
  const kindRef = useRef(kind); kindRef.current = kind;
  const currentRef = useRef(current); currentRef.current = current;
  // the slide looked at, for the others (their rails show who is where)
  useEffect(() => { if (kind !== 'page') host.setSlide?.(current); }, [current, kind, host]);
  const slidesRef = useRef(slides); slidesRef.current = slides;

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const fromCanvas = e.source === canvasFrame.current?.contentWindow;
      const fromRail = e.source === railFrame.current?.contentWindow;
      const fromPresent = e.source === presentFrame.current?.contentWindow;
      if (!fromCanvas && !fromRail && !fromPresent) return;
      if (!isFromRuntime(e.data)) return;
      const m = e.data as FromRuntime;
      if (fromPresent) {
        if (m.ol === 'presentZoom') presentZoomed.current = m.zoomed;
        if (m.ol === 'exit') stopPresenting();
        if (m.ol === 'visible') setCurrent(canvasIndexOf(m.slide));
        return;
      }
      switch (m.ol) {
        case 'ready':
          if (fromCanvas) {
            canvasReady.current = true;
            setKind(m.kind);
            if (m.width) setPageW(m.width);
            if (m.height) setPageH(m.height);
            setSolo(m.solo ?? null);
            toCanvas({ ol: 'scale', scale });
            toCanvas({ ol: 'tool', tool, ink: deckInkStyle(inkRef.current, pageWRef.current) });
            toCanvas({ ol: 'view', view: shownView(viewRef.current) });
            toCanvas({ ol: 'dark', invert: darkRef.current.invert, desk: null });
            toCanvas(reviewMsgRef.current());
            if (objOpenRef.current) toCanvas({ ol: 'objects', on: true });
            if (host.ready()) toCanvas({ ol: 'source', version: version.current, html: versions.current.get(version.current) ?? text.toString() });
            setDeckMacros(macroTableOf(m.macros ?? {}));
            if (bibKnown.current.size) toCanvas({ ol: 'bib', entries: [...bibKnown.current.values()] });
            if (peersRef.current.length) toCanvas({ ol: 'peers', peers: peersRef.current });
          } else {
            railReady.current = true;
            if (bibKnown.current.size) toRail({ ol: 'bib', entries: [...bibKnown.current.values()] });
            toRail({ ol: 'scale', scale: railScale });
            if (host.ready()) toRail({ ol: 'source', version: version.current, html: text.toString() });
            toRail({ ol: 'current', slide: currentRef.current });
            toRail({ ol: 'dark', invert: darkRef.current.invert, desk: darkRef.current.dark ? DARK_DESK : null });
            if (peersRef.current.length) toRail({ ol: 'peers', peers: peersRef.current });
          }
          break;
        case 'layout':
          if (fromCanvas) {
            setKind(m.kind);
            setSlides(m.slides);
            if (m.width) setPageW(m.width);
            if (m.height) setPageH(m.height);
            setSolo(prev => sameSolo(prev, m.solo ?? null) ? prev : m.solo ?? null);
            const p = pending.current;
            if (p) {
              pending.current = null;
              if (p.select) toCanvas({ ol: 'select', paths: p.select });
              if (p.editText) toCanvas({ ol: 'editText', path: p.editText, selectAll: true, math: p.math });
            }
          }
          break;
        case 'selection': if (fromCanvas) { setSel(m.items); host.setSelection(m.items.map(i => i.path)); } break;
        case 'caret': if (fromCanvas) host.setCaret?.(m.caret); break;
        case 'dragging': if (fromCanvas) setDragging(m.on); break;
        case 'editing':
          if (!fromCanvas) break;
          setEditingText(m.path);
          editingTextRef.current = !!m.path;
          if (!m.path) setMathEdit(null);
          // the new text box is being retyped: what was typed meanwhile goes into it
          if (m.path) textAhead.current = false;
          break;
        case 'mathEdit': if (fromCanvas) setMathEdit({ id: m.id, tex: m.tex, display: m.display, box: m.box, color: m.color, at: m.at, where: m.where, dollar: m.dollar }); break;
        case 'mathKeys': if (fromCanvas) mathKeysIn.current?.(m.id, m.keys); break;
        case 'mathRect': if (fromCanvas) setMathEdit(st => st && st.id === m.id ? { ...st, box: m.box } : st); break;
        case 'mathClose': if (fromCanvas) setMathEdit(st => m.id === undefined || st?.id === m.id ? null : st); break;
        case 'visible': if (fromCanvas && m.slide >= 0) { setCurrent(m.slide); toRail({ ol: 'current', slide: m.slide }); } break;
        case 'goto': setCurrent(m.slide); toCanvas({ ol: 'scrollTo', slide: m.slide, smooth: false }); toRail({ ol: 'current', slide: m.slide }); break;
        case 'ops': {
          if (readOnlyRef.current) { notify('You can only view this page.', 'error'); sendSource(true); break; }
          const before = text.toString();
          const ok = applyRuntimeOps(m.version, m.ops);
          if (ok && Array.isArray(m.select)) pending.current = { select: m.select };
          else if (ok && m.select === 'inserted') {
            // the inserted elements: after the last element child of their parent
            const ins = m.ops.filter((o): o is Extract<HtmlOp, { t: 'insert' }> => o.t === 'insert');
            if (ins.length) {
              const { doc } = parseSource(before);
              const parent = elementAt(doc, ins[0].parent);
              const n = parent ? elementChildren(parent).length : 0;
              pending.current = { select: ins.map((o, k) => [...o.parent, Math.min(o.index, n) + k]) };
            }
          }
          break;
        }
        case 'draw': onDraw(m.version, m.tool, m.slide, m.rect, m.after ?? null, m.pts, m.d !== undefined ? { d: m.d, closed: !!m.closed } : undefined); break;
        case 'sequence': if (fromCanvas) setSeq({ slide: m.slide, rows: m.rows, steps: m.steps, ordering: m.ordering }); break;
        case 'objects': if (fromCanvas) setObjects({ slide: m.slide, items: m.items }); break;
        case 'comment': {
          if (!fromCanvas) break;
          if (!m.open) { startDraft(m.path, m.slide, m.quote); break; }
          // a pin: its threads in the pane
          const ts = review.threads.filter(t => samePath(t.path, m.path) && !t.thread.done);
          setReviewOpen(true);
          setDraft(null);
          if (ts[0]) setFocus({ path: ts[0].path, id: ts[0].thread.id, quote: ts[0].thread.quote });
          break;
        }
        case 'nodeEditing': if (fromCanvas) { setNodeEd(m.path ? { selected: m.selected, total: m.total } : null); if (m.path && document.activeElement !== canvasFrame.current) canvasFrame.current?.focus(); } break;
        case 'key': onRuntimeKey(m); break;
        case 'contextmenu': {
          const f = (fromRail ? railFrame : canvasFrame).current;
          if (!f) break;
          const r = f.getBoundingClientRect();
          const s = fromRail ? railScale : scale;
          const x = r.left + m.x * s, y = r.top + m.y * s;
          if (fromRail) slideMenu(x, y, m.slide ?? currentRef.current);
          else if (m.on === 'canvas') canvasMenu(x, y);
          else if (m.on === 'slide' && !selRef.current.length) emptySlideMenu(x, y, m.slide ?? currentRef.current);
          else objectMenu(x, y);
          break;
        }
        case 'pasteFiles': void placeFiles(m.files, m.slide, m.at); break;
        case 'zoom':
          if (!fromCanvas) break;
          if (soloRef.current) { const q = slideView.toCanvas(m.clientX, m.clientY); if (q) zoomSolo(m.factor, q.x, q.y); }
          else zoomAbout(m.factor, m.clientX, m.clientY, m.pageY);
          break;
        case 'pan':
          if (!fromCanvas) break;
          if (soloRef.current) {
            // (a finger moves on the screen — or, from an older runtime, in the frame's px; a wheel's deltas are the device's, whatever the frame's scale)
            const s = slideView.scaleNow() ?? scaleRef.current, k = m.screen ? screenK.current : s;
            if (m.finger) slideView.panBy(m.dx * k, (m.dy ?? 0) * k); else slideView.scroll(m.dx, m.dy ?? 0);
          } else setPanX(p => p + m.dx * (m.screen ? screenK.current : scaleRef.current));
          break;
        case 'pinch': if (fromCanvas) onPinch(m); break;
        case 'history': if (fromCanvas) historyGesture(m.redo); break;
        case 'panEnd': if (fromCanvas) slideView.release(); break;
        case 'colors': if (fromCanvas) setColors({ desk: m.desk, page: m.page }); break;
        case 'cropping': if (fromCanvas) setCropping(m.path); break;
        case 'scroll': if (fromCanvas) { scrollRef.current = m.y; setScrollY(m.y); } break;
        case 'reload': canvasReady.current = canvasReady.current && !fromCanvas; if (fromRail) railReady.current = false; break;
      }
    };
    addEventListener('message', onMessage);
    const onBlur = () => setTimeout(() => { if (document.activeElement?.tagName === 'IFRAME') closeContextMenu(); }, 0);
    addEventListener('blur', onBlur);
    return () => { removeEventListener('message', onMessage); removeEventListener('blur', onBlur); };
  });

  /* ------------------------------------------------------------- sizes, zoom and panning */

  useEffect(() => {
    const ro = new ResizeObserver(() => {
      const b = canvasBox.current;
      if (b) setBox({ w: b.clientWidth, h: b.clientHeight });
      const rb = railBox.current;
      if (rb) setRailH(Math.max(0, rb.clientHeight - RAIL_HEAD));
    });
    if (canvasBox.current) ro.observe(canvasBox.current);
    if (railBox.current) ro.observe(railBox.current);
    return () => ro.disconnect();
  }, [canvasBox.current, railBox.current]);
  const scaleRef = useRef(scale); scaleRef.current = scale;
  useEffect(() => { const anchor = anchorRef.current ?? undefined; anchorRef.current = null; toCanvas({ ol: 'scale', scale, anchor }); }, [scale]);
  // one slide on the canvas: the frame's place (viewport.ts), set outside renders
  const soloRef = useRef(soloOn); soloRef.current = soloOn;
  const viewInput = useRef<{ box: { w: number; h: number }; rect: Rect; scale: number; margin: number } | null>(null);
  viewInput.current = soloOn ? { box, rect: solo!.rect, scale, margin } : null;
  /** the ring behind a slide pulled past an edge (drawn by the view); pulled loose, Centre slide shows */
  const pullRing = useRef<HTMLDivElement>(null);
  const [slideFree, setSlideFree] = useState(false);
  const slideView = useMemo(() => new SlideView(() => canvasFrame.current, () => viewInput.current,
    { pull: () => pullRing.current, onFree: setSlideFree }), []);
  useEffect(() => () => slideView.destroy(), [slideView]);
  // Safari's pinches beside the slide (a Mac's trackpad; the iPad's fingers, which canvasTouch takes): the slide's zoom, never the page's
  useEffect(() => {
    const el = canvasBox.current;
    if (!el) return;
    let last = 1;
    const on = (e: Event & { scale?: number; clientX?: number; clientY?: number }) => {
      e.preventDefault();
      if (canvasFingers.current.size || !soloRef.current) return;
      if (e.type === 'gesturestart') { last = 1; return; }
      const r = el.getBoundingClientRect(), sc = e.scale ?? 1;
      zoomSolo(sc / last, (e.clientX ?? r.left + r.width / 2) - r.left, (e.clientY ?? r.top + r.height / 2) - r.top);
      last = sc;
    };
    const opts = { passive: false } as AddEventListenerOptions;
    for (const t of ['gesturestart', 'gesturechange']) el.addEventListener(t, on as EventListener, opts);
    return () => { for (const t of ['gesturestart', 'gesturechange']) el.removeEventListener(t, on as EventListener, opts); };
  }, [canvasBox.current]);
  useLayoutEffect(() => { if (soloOn) slideView.render(); });
  // another slide: in the middle again (the zoom stays, as in PowerPoint)
  useLayoutEffect(() => { if (soloOn) slideView.recentre(false); }, [solo?.slide, soloOn]);
  useLayoutEffect(() => { if (soloOn) slideView.refit(); }, [box.w, box.h, solo?.rect.w, solo?.rect.h]);
  useEffect(() => { toRail({ ol: 'scale', scale: railScale }); }, [railScale]);
  // (the Bézier pen takes Enter / Esc / Backspace: the keyboard goes to the canvas)
  const inkStyle = deckInkStyle(ink, pageW);
  useEffect(() => { toCanvas({ ol: 'tool', tool, ink: inkStyle }); if (tool === 'bezier') canvasFrame.current?.focus(); }, [tool, inkStyle.color, inkStyle.width, inkStyle.opacity]);
  // the rail folded away: its frame goes, and says it is ready again when it comes back
  useEffect(() => { if (!railOpen) railReady.current = false; }, [railOpen]);

  const MAX_ZOOM = 8;
  const zoomRef = useRef(zoom); zoomRef.current = zoom;
  const fitRef = useRef(fit); fitRef.current = fit;
  const boxRef = useRef(box); boxRef.current = box;
  const frameWRef = useRef(frameW); frameWRef.current = frameW;
  const panRef = useRef(panX); panRef.current = panX;
  /** the frame's left edge in the canvas: centred when it fits, else where it was panned to (clamped) */
  const leftFor = (sc: number, pan: number) => {
    const w = frameWRef.current * sc, bw = boxRef.current.w;
    return w <= bw ? (bw - w) / 2 : Math.min(0, Math.max(bw - w, pan));
  };
  /** zoom by `factor` about a point of the frame (its client px; its document y) — a pinch, Ctrl+wheel, the buttons */
  const zoomAbout = (factor: number, clientX: number, clientY: number, pageY: number) => {
    const z0 = zoomRef.current, f = fitRef.current;
    const z1 = Math.max(0.1 / f, Math.min(MAX_ZOOM / f, z0 * factor));
    if (Math.abs(z1 - z0) < 1e-4) return;
    const s0 = f * z0, s1 = f * z1;
    const left0 = leftFor(s0, panRef.current);
    const screenX = left0 + clientX * s0;
    setPanX(screenX - clientX * s1);
    anchorRef.current = { docY: pageY, screenY: clientY * s0 };
    setZoom(z1);
  };
  /** one slide on the canvas: zoom by `factor` about a canvas point (no smaller than half the fit) */
  /** a zoom the view shows (zoomTo, placeAt) becomes the editor's once it rests: not a render per wheel step or finger move */
  const zoomCommit = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commitLiveZoom = (delay: number) => {
    if (zoomCommit.current) clearTimeout(zoomCommit.current);
    zoomCommit.current = setTimeout(() => { zoomCommit.current = null; const s = slideView.scaleNow(); if (s) setZoom(s / fitRef.current); }, delay);
  };
  const zoomSolo = (factor: number, px: number, py: number) => {
    const f = fitRef.current, s0 = slideView.scaleNow() ?? f * zoomRef.current;
    const s1 = Math.max(0.5 * f, Math.min(MAX_ZOOM, s0 * factor));
    if (Math.abs(s1 - s0) < 1e-4 * s0) return;
    slideView.zoomTo(s1, px, py);
    commitLiveZoom(120);
  };
  /** canvas px per screen px (the browser's zoom): measured by each pinch, for a finger's pan */
  const screenK = useRef(1);
  /**
   * Two fingers on the slide (runtime pinch) or beside it (canvasTouch): what was under each stays
   * under it — the slide's scale from their distance, its place from their middle, all from where they
   * came down. Their screen positions are the measure (the frame's own px change with every step),
   * mapped onto the canvas by where they were then. Fingers that move together pan and do not zoom
   * until they have clearly come closer or gone further apart (gestures.ts).
   */
  const pinchRef = useRef<{ c: { x: number; y: number }[]; r: { x: number; y: number }[]; a: { x: number; y: number }; k: number; s0: number; d0: number; lock: PinchLock } | null>(null);
  /** two fingers down: each one's canvas point and screen point */
  const pinchStart = (c: { x: number; y: number }[], r: { x: number; y: number }[]) => {
    if (zoomCommit.current) { clearTimeout(zoomCommit.current); zoomCommit.current = null; }
    const s0 = slideView.scaleNow() ?? scaleRef.current;
    const a = slideView.toFrame((c[0].x + c[1].x) / 2, (c[0].y + c[1].y) / 2);
    if (!a) return;
    const dc = Math.hypot(c[0].x - c[1].x, c[0].y - c[1].y), dr = Math.hypot(r[0].x - r[1].x, r[0].y - r[1].y);
    const k = dr > 8 ? Math.max(0.25, Math.min(4, dc / dr)) : 1;
    screenK.current = Math.abs(k - 1) < 0.03 ? 1 : k;
    pinchRef.current = { c, r, a, k, s0, d0: Math.max(1, dc), lock: pinchLock() };
  };
  /** they moved: their screen points now */
  const pinchMove = (r: { x: number; y: number }[]) => {
    const g = pinchRef.current;
    if (!g || r.length < 2) return;
    const f = fitRef.current;
    const now = r.slice(0, 2).map((p, i) => ({ x: g.c[i].x + g.k * (p.x - g.r[i].x), y: g.c[i].y + g.k * (p.y - g.r[i].y) }));
    const travel = Math.hypot((r[0].x + r[1].x - g.r[0].x - g.r[1].x) / 2, (r[0].y + r[1].y - g.r[0].y - g.r[1].y) / 2);
    const z = pinchFactor(g.lock, g.d0, Math.hypot(now[0].x - now[1].x, now[0].y - now[1].y), travel);
    const s = Math.max(0.5 * f, Math.min(MAX_ZOOM, g.s0 * z));
    slideView.placeAt(s, g.a.x, g.a.y, (now[0].x + now[1].x) / 2, (now[0].y + now[1].y) / 2);
  };
  /** one lifted (`cancel`: a third came — undo, redo: back to where the slide was) */
  const pinchEnd = (cancel: boolean) => {
    const g = pinchRef.current;
    if (!g) return;
    pinchRef.current = null;
    if (cancel) slideView.placeAt(g.s0, g.a.x, g.a.y, (g.c[0].x + g.c[1].x) / 2, (g.c[0].y + g.c[1].y) / 2);
    commitLiveZoom(0);
    slideView.release();
  };
  const onPinch = (m: Extract<FromRuntime, { ol: 'pinch' }>) => {
    if (!soloRef.current) return;
    if (m.phase === 'start') {
      if (m.pts.length < 2) return;
      const c = m.pts.slice(0, 2).map(p => slideView.toCanvas(p.x, p.y));
      if (c[0] && c[1]) pinchStart(c as { x: number; y: number }[], m.pts.slice(0, 2).map(p => ({ x: p.sx, y: p.sy })));
    } else if (m.phase === 'move') pinchMove(m.pts.map(p => ({ x: p.sx, y: p.sy })));
    else pinchEnd(m.phase === 'cancel');
  };
  /**
   * Fingers on the canvas beside the slide, as on it (runtime/edit.ts): one pulls the slide, two pan
   * and pinch, three undo or redo. Not the browser's: the iPad's Safari zoomed the whole page.
   */
  const canvasFingers = useRef(new Map<number, { x: number; y: number }>());
  const canvasGesture = useRef<{ kind: 'pan' | 'pinch' | 'tri' | 'done'; x: number; y: number; x0: number; y0: number; t0: number } | null>(null);
  const fingerMid = () => {
    const ps = [...canvasFingers.current.values()];
    return { x: ps.reduce((a, p) => a + p.x, 0) / ps.length, y: ps.reduce((a, p) => a + p.y, 0) / ps.length };
  };
  const canvasTouch = (e: PointerEvent) => {
    if (e.pointerType !== 'touch' || !soloRef.current) return;
    const fingers = canvasFingers.current, box = canvasBox.current?.getBoundingClientRect();
    if (!box) return;
    const at = { x: e.clientX - box.left, y: e.clientY - box.top };
    if (e.type === 'pointerdown') {
      if (e.target !== e.currentTarget && !fingers.size) return;
      e.preventDefault();
      fingers.set(e.pointerId, at);
      const g = canvasGesture.current, m = fingerMid();
      if (fingers.size === 1) canvasGesture.current = { kind: 'pan', x: at.x, y: at.y, x0: at.x, y0: at.y, t0: performance.now() };
      else if (fingers.size === 2 && g?.kind === 'pan') {
        const ps = [...fingers.values()];
        canvasGesture.current = { ...g, kind: 'pinch' };
        pinchStart(ps, ps);
      } else if (fingers.size >= 3 && g?.kind !== 'tri' && g?.kind !== 'done') {
        if (g?.kind === 'pinch') pinchEnd(true);
        canvasGesture.current = { kind: 'tri', x: m.x, y: m.y, x0: m.x, y0: m.y, t0: performance.now() };
      }
      return;
    }
    if (!fingers.has(e.pointerId)) return;
    const g = canvasGesture.current;
    if (e.type === 'pointermove') {
      fingers.set(e.pointerId, at);
      if (g?.kind === 'pan') { slideView.panBy(at.x - g.x, at.y - g.y); g.x = at.x; g.y = at.y; }
      else if (g?.kind === 'pinch') pinchMove([...fingers.values()]);
      else if (g?.kind === 'tri' && fingers.size >= 3) { const m = fingerMid(); g.x = m.x; g.y = m.y; }
      return;
    }
    // up or cancelled: the gesture ends with the first finger to lift (the others do nothing till they lift too)
    fingers.delete(e.pointerId);
    if (g?.kind === 'pan') slideView.release();
    else if (g?.kind === 'pinch') pinchEnd(false);
    if (g && g.kind !== 'tri') g.kind = 'done';
    if (fingers.size) return;
    if (g?.kind === 'tri') { const h = triGesture(g.x - g.x0, g.y - g.y0, performance.now() - g.t0); if (h) historyGesture(h === 'redo'); }
    canvasGesture.current = null;
  };
  /** three fingers (runtime): undo, redo — said for a moment on the canvas, as the gesture shows nothing itself */
  const [hud, setHud] = useState<{ text: string; n: number } | null>(null);
  const hudTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const historyGesture = (redo: boolean) => {
    if (readOnlyRef.current) return;
    toCanvas({ ol: 'stopText' });
    setTimeout(() => (redo ? host.redo() : host.undo()), 30);
    setHud(h => ({ text: redo ? '↷ Redo' : '↶ Undo', n: (h?.n ?? 0) + 1 }));
    if (hudTimer.current) clearTimeout(hudTimer.current);
    hudTimer.current = setTimeout(() => setHud(null), 900);
  };
  const zoomStep = (factor: number) => {
    if (soloRef.current) { const b = boxRef.current; zoomSolo(factor, b.w / 2, b.h / 2); return; }
    const sc = scaleRef.current, b = boxRef.current;
    const left = leftFor(sc, panRef.current);
    const cx = (b.w / 2 - left) / sc, cy = b.h / 2 / sc;
    zoomAbout(factor, cx, cy, scrollRef.current + cy);
  };
  const fitSlide = () => {
    if (zoomCommit.current) { clearTimeout(zoomCommit.current); zoomCommit.current = null; }
    setZoom(1);
    setPanX(0);
    if (soloRef.current) { slideView.recentre(true); return; }
    setTimeout(() => toCanvas({ ol: 'scrollTo', slide: currentRef.current, smooth: true }), 30);
  };

  /* ------------------------------------------------------------- the rail's width (its right edge dragged) */

  const setRail = (w: number) => {
    const v = Math.round(Math.max(RAIL_MIN, Math.min(RAIL_MAX, w)));
    setRailW(v);
    try { if (v === RAIL_W) localStorage.removeItem('ol.deckRail'); else localStorage.setItem('ol.deckRail', String(v)); } catch { /* private window */ }
  };
  const onRailGrip = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const g = e.currentTarget as HTMLElement;
    try { g.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    const x0 = e.clientX, w0 = railW;
    g.classList.add('on');
    const move = (ev: PointerEvent) => setRailW(Math.round(Math.max(RAIL_MIN, Math.min(RAIL_MAX, w0 + ev.clientX - x0))));
    const up = (ev: PointerEvent) => {
      g.removeEventListener('pointermove', move); g.removeEventListener('pointerup', up); g.removeEventListener('pointercancel', up);
      g.classList.remove('on');
      setRail(w0 + ev.clientX - x0);
    };
    g.addEventListener('pointermove', move); g.addEventListener('pointerup', up); g.addEventListener('pointercancel', up);
  };

  /* ------------------------------------------------------------- the canvas around the pages */

  const viewRef = useRef(view); viewRef.current = view;
  const setView = (patch: Partial<CanvasView>) => {
    const v = { ...viewRef.current, ...patch };
    setViewState(v);
    saveView(host.path, v);
    toCanvas({ ol: 'view', view: shownView(v) });
  };
  const deskCss = view.deskChecker ? CHECKER : (shownView(view).desk ?? colors?.desk ?? undefined);
  useEffect(() => {
    toCanvas({ ol: 'view', view: shownView(viewRef.current) });
    toCanvas({ ol: 'dark', invert: darkS.invert, desk: null });
    toRail({ ol: 'dark', invert: darkS.invert, desk: darkS.dark ? DARK_DESK : null });
  }, [darkS.dark, darkS.invert]);

  /* ------------------------------------------------------------- tools and objects */

  const setTool = (t: Tool) => { setToolState(t); };

  const onDraw = (v: number, t: Tool, slide: Path | null, rect: Rect, after: Path | null, pts?: [number, number][], bez?: { d: string; closed: boolean }) => {
    // Draw: the pen stays in hand and the stroke is not selected — the next one follows (GoodNotes)
    const drawing = t === 'pen';
    if (!drawing) setToolState('select');
    if (readOnlyRef.current) return;
    if (versions.current.get(v) === undefined) return;
    const cur = text.toString();
    const k = kindRef.current;
    const place = insertPlace(cur, slide, after, k);
    if (!place) return;
    const html = objectHtml(t, rect, k, pageW / 1280, pts, bez, drawing ? deckInkStyle(inkRef.current, pageWRef.current) : undefined);
    if (!html) return;
    if (!applyOps([{ t: 'insert', parent: place.parent, index: place.index, html }])) return;
    pending.current = drawing ? null : t === 'formula' ? { editText: place.path, math: true } : t === 'text' ? { editText: place.path } : { select: [place.path] };
    if (t === 'text') {
      textAhead.current = true;
      if (textAheadTimer.current) clearTimeout(textAheadTimer.current);
      textAheadTimer.current = setTimeout(() => { textAhead.current = false; }, 4000);
    }
    if (t === 'formula') {
      typeAhead.current = [];
      if (typeAheadTimer.current) clearTimeout(typeAheadTimer.current);
      typeAheadTimer.current = setTimeout(() => { typeAhead.current = null; }, 3000);
    }
  };

  const insertObject = (t: Tool) => {
    if (t === 'select') return;
    // a click on the canvas places it; the button alone puts it in the middle of the slide in view
    setTool(t);
  };

  const fileInput = useRef<HTMLInputElement>(null);
  /** where a file goes: an upload into the folder's images/, a free name */
  const uploadFile = async (f: { name: string; type: string; data: Blob | ArrayBuffer }, sub = 'images'): Promise<string | null> => {
    const ext = (f.name.split('.').pop() || f.type.split('/')[1] || 'png').toLowerCase().replace('jpeg', 'jpg').replace('svg+xml', 'svg');
    const base = (f.name.replace(/\.[^.]+$/, '') || 'image').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'image';
    let name = `${base}.${ext}`;
    for (let i = 1; i < 50; i++) {
      const rel = (dir ? dir + '/' : '') + sub + '/' + name;
      try { await host.upload(rel, f.data instanceof Blob ? f.data : new Blob([f.data], { type: f.type })); return sub + '/' + name; }
      catch { name = `${base}-${i}.${ext}`; }
    }
    return null;
  };
  /**
   * Files put on the page (the picture button, a paste, a drop — `at`: the drop point, slide px): a
   * picture is uploaded and placed (centred on the drop point, at most 60 % of the slide wide), an SVG
   * becomes a drawing whose shapes can be edited (inlineSvgHtml) — a big one goes in as a picture.
   */
  const placeFiles = async (files: { name: string; type: string; data: Blob | ArrayBuffer }[], slide: Path | null, at: { x: number; y: number } | null) => {
    if (readOnlyRef.current) { notify('You can only view this page.', 'error'); return; }
    const k = kindRef.current;
    const pictures = files.filter(f => /^image\//.test(f.type) || /\.(svg|png|jpe?g|gif|webp|avif)$/i.test(f.name));
    if (!pictures.length) { if (files.length) notify('Only pictures and SVG drawings can be placed on the page.', 'error'); return; }
    const inserted: Path[] = [];
    let n = 0;
    for (const f of pictures) {
      const blob = f.data instanceof Blob ? f.data : new Blob([f.data], { type: f.type });
      const slidePath = slide ?? (k !== 'page' ? slides[currentRef.current]?.path ?? null : null);
      const cur = text.toString();
      const place = insertPlace(cur, slidePath, selRef.current[0]?.path ?? null, k);
      if (!place) continue;
      const w = pageW, h = pageH || pageW * 9 / 16;
      const cx = (at?.x ?? w / 2) + n * 24, cy = (at?.y ?? h / 2) + n * 24;
      let html: string | null = null;
      if (/svg/i.test(f.type) || /\.svg$/i.test(f.name)) {
        const svgText = await blob.text();
        html = inlineSvgHtml(svgText, k === 'page' ? null : { x: cx, y: cy, maxW: w * 0.6 }, `s${Date.now().toString(36)}${n}`);
        if (html === null && !/<svg[\s>]/i.test(svgText)) { notify(`${f.name} is not an SVG drawing.`, 'error'); continue; }
      }
      if (html === null) {
        const rel = await uploadFile({ name: f.name, type: f.type || 'image/svg+xml', data: blob });
        if (!rel) { notify(`Could not upload ${f.name}.`, 'error'); continue; }
        const nat = await naturalSize(blob);
        const iw = Math.min(nat?.w ?? 480, w * 0.6), ih = nat ? iw * nat.h / nat.w : iw * 0.75;
        html = imageHtml(rel, k === 'page' ? null : { x: cx - iw / 2, y: cy - ih / 2, w: iw, h: 0 }, k, nat ?? undefined);
      }
      if (!applyOps([{ t: 'insert', parent: place.parent, index: place.index, html }])) continue;
      inserted.push(place.path);
      n++;
    }
    if (inserted.length) pending.current = { select: [inserted[inserted.length - 1]] };
  };
  const uploadImages = (files: { name: string; type: string; data: Blob | ArrayBuffer }[], slide: Path | null) => placeFiles(files, slide, null);

  /* ------------------------------------------------------------- the selection's formatting */

  /** the suggestion on the one object selected (or on what it is in) */
  const selChange = sel.length === 1 ? review.changes.find(c => samePath(c.path, sel[0].path)) ?? review.changes.find(c => within(c.path, sel[0].path)) ?? null : null;

  const styleSel = (set: Record<string, string | null>) => {
    if (!sel.length) return;
    applyOps(sel.map(s => ({ t: 'style', path: s.path, set })));
  };
  // (in points, as the size box shows them)
  const fontSize = (delta: number) => {
    if (!sel.length) return;
    applyOps(sel.map(s => ({ t: 'style', path: s.path, set: { 'font-size': `${stepPt(sizePt(parseFloat(s.style.fontSize) || 16), delta > 0 ? 1 : -1)}pt` } })));
  };
  const exec = (command: string, value?: string) => toCanvas({ ol: 'exec', command, value });
  /** a web font used for the first time: its stylesheet linked in the page's head */
  const ensureFont = (google?: string) => {
    if (!google) return;
    const cur = text.toString();
    const fam = google.replace(/ /g, '+');
    if (cur.includes(`family=${fam}`)) return;
    const head = elementAt(parseSource(cur).doc, [0]);
    if (!head || head.tagName !== 'head') return;
    applyOps([{ t: 'insert', parent: [0], index: 1e6, html: `<link href="https://fonts.googleapis.com/css2?family=${fam}:ital,wght@0,400;0,700;1,400;1,700&display=swap" rel="stylesheet">` }]);
  };
  const toggle = (prop: string, on: string, off: string, test: (s: SelItem) => boolean) => {
    const all = sel.every(test);
    styleSel({ [prop]: all ? off : on });
  };
  const textActions: DeckTextActions = {
    family: (css, google) => { ensureFont(google); if (editingText) exec('fontName', css ?? 'inherit'); else styleSel({ 'font-family': css }); },
    size: pt => { if (editingText) exec('fontSize', `${pt}pt`); else styleSel({ 'font-size': `${pt}pt` }); },
    bold: () => { if (editingText) exec('bold'); else toggle('font-weight', '700', '400', s => Number(s.style.fontWeight) >= 600); },
    italic: () => { if (editingText) exec('italic'); else toggle('font-style', 'italic', 'normal', s => s.style.fontStyle === 'italic'); },
    underline: () => { if (editingText) exec('underline'); else toggle('text-decoration', 'underline', 'none', s => s.style.textDecoration.includes('underline')); },
    strike: () => { if (editingText) exec('strikeThrough'); else toggle('text-decoration', 'line-through', 'none', s => s.style.textDecoration.includes('line-through')); },
    color: c => { if (editingText) exec('foreColor', c ?? 'inherit'); else styleSel({ color: c }); },
    highlight: c => exec('hiliteColor', c ?? 'transparent'),
    align: a => { if (editingText) exec(a === 'left' ? 'justifyLeft' : a === 'center' ? 'justifyCenter' : a === 'right' ? 'justifyRight' : 'justifyFull'); else styleSel({ 'text-align': a }); },
    valign: v => toCanvas({ ol: 'valign', v }),
    list: kind => {
      const cmd = kind === 'ul' ? 'insertUnorderedList' : 'insertOrderedList';
      if (editingText) { exec(cmd); return; }
      const one = sel.length === 1 ? sel[0] : null;
      if (!one || !one.canText) return;
      toCanvas({ ol: 'editText', path: one.path, selectAll: true });
      setTimeout(() => exec(cmd), 60);
    },
    lineHeight: v => { if (editingText) exec('lineHeight', v); else styleSel({ 'line-height': v }); },
    clear: () => { if (editingText) exec('removeFormat'); else styleSel({ 'font-weight': null, 'font-style': null, 'text-decoration': null, color: null, 'font-family': null }); },
  };
  const paint = (p: Paint) => toCanvas({ ol: 'paint', paint: p });
  const arrangeSel = (how: ArrangeHow) => toCanvas({ ol: 'arrange', how });

  const removeSel = () => { const free = sel.filter(s => !s.locked); if (free.length) applyOps([{ t: 'remove', paths: free.map(s => s.path) }]); };
  const duplicateSel = () => { if (sel.length) applyOps([{ t: 'duplicate', paths: sel.map(s => s.path) }]); };

  /* ------------------------------------------------------------- pictures */

  const replaceInput = useRef<HTMLInputElement>(null);
  const imagePath = () => { const one = sel.length === 1 && sel[0].kind === 'image' ? sel[0] : null; return one; };
  const replacePicture = async (files: File[]) => {
    const one = imagePath();
    const f = files[0];
    if (!one || !f) return;
    const rel = await uploadFile({ name: f.name, type: f.type, data: f });
    if (!rel) { notify('Could not upload the picture.', 'error'); return; }
    // the <img> itself, or the one inside a crop frame
    const p = one.cropped ? [...one.path, 0] : one.path;
    applyOps([{ t: 'attr', path: p, name: 'src', value: rel }]);
  };
  const imageTools = {
    cropping: !!cropping,
    crop: () => { const one = imagePath(); if (one) toCanvas({ ol: 'crop', path: one.path }); },
    shape: (aspect: number | null, shape?: 'rect' | 'circle') => {
      if (cropping) { toCanvas({ ol: 'cropAspect', aspect, shape }); return; }
      const one = imagePath(); if (one) toCanvas({ ol: 'cropPreset', path: one.path, aspect, shape });
    },
    resetCrop: () => { const one = imagePath(); if (one) toCanvas({ ol: 'cropPreset', path: one.path, aspect: null, reset: true }); },
    done: (commit: boolean) => toCanvas({ ol: 'endCrop', commit }),
    removeBackground: () => { const one = imagePath(); if (one) removeBackground(one); },
    replace: () => replaceInput.current?.click(),
  };
  /** a project path of a src written relative to the page's folder (./ and ../ resolved), null when it leaves the project */
  const resolveRel = (src: string): string | null => {
    const parts = (dir ? dir.split('/') : []);
    for (const seg of src.split('?')[0].split('#')[0].split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(decodeURIComponent(seg));
    }
    return parts.join('/');
  };
  /** Remove background (BgRemoveDialog): the picture fetched where the frames get it (CORS *), the result saved next to it */
  const removeBackground = (it: SelItem) => {
    const { doc } = parseSource(text.toString());
    let el = elementAt(doc, it.path);
    let imgPath = it.path;
    if (el && el.tagName !== 'img') {
      const kids = elementChildren(el);
      const i = kids.findIndex(k => k.tagName === 'img');
      if (i < 0) return;
      el = kids[i];
      imgPath = [...it.path, i];
    }
    const s = el ? attr(el, 'src') : null;
    if (!s || !link) return;
    if (/^(https?:)?\/\//i.test(s) || s.startsWith('/')) { notify('Only pictures in the project can be changed — upload this one first.', 'error'); return; }
    let url = s;
    if (!s.startsWith('data:')) {
      const rel = resolveRel(s);
      if (rel === null) { notify('This picture is outside the project.', 'error'); return; }
      url = link.base + rel.split('/').map(encodeURIComponent).join('/');
    }
    setBgFor({ url, name: s.startsWith('data:') ? 'picture' : s.split('/').pop() || 'picture', imgPath, src: s });
  };
  const saveNoBg = async (blob: Blob) => {
    const b = bgFor;
    setBgFor(null);
    if (!b) return;
    const rel = b.src.startsWith('data:') ? (dir ? dir + '/' : '') + 'images/picture.png' : resolveRel(b.src);
    if (!rel) return;
    const folder = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : '';
    const base = rel.slice(folder.length).replace(/\.[^.]+$/, '').replace(/-nobg(-\d+)?$/, '');
    for (let i = 0; i < 50; i++) {
      const name = `${base}-nobg${i ? '-' + (i + 1) : ''}.png`;
      try { await host.upload(folder + name, blob); } catch { continue; }
      const newSrc = b.src.startsWith('data:') ? 'images/' + name : b.src.replace(/[^/]*$/, name);
      applyOps([{ t: 'attr', path: b.imgPath, name: 'src', value: newSrc }]);
      return;
    }
    notify('Could not save the picture.', 'error');
  };

  /* ------------------------------------------------------------- menus */

  const showCode = (p?: Path) => {
    setCodeOpen(true);
    const target = p ?? sel[0]?.path;
    if (!target) return;
    setTimeout(() => {
      const ta = codeRef.current;
      const r = sourceRange(text.toString(), target);
      if (!ta || !r) return;
      ta.focus();
      ta.setSelectionRange(r.from, r.to);
      const before = ta.value.slice(0, r.from).split('\n').length;
      ta.scrollTop = Math.max(0, (before - 3) * 18);
    }, 50);
  };

  const arrangeItems = (): MenuItem[] => [
    { label: 'Order', sub: [
      { label: 'Bring to front', shortcut: 'Ctrl+Shift+↑', action: () => arrangeSel('front') },
      { label: 'Bring forward', shortcut: 'Ctrl+↑', action: () => arrangeSel('forward') },
      { label: 'Send backward', shortcut: 'Ctrl+↓', action: () => arrangeSel('backward') },
      { label: 'Send to back', shortcut: 'Ctrl+Shift+↓', action: () => arrangeSel('back') },
    ] },
    { label: 'Align', sub: [
      { label: 'Left', action: () => arrangeSel('align-left') }, { label: 'Centre', action: () => arrangeSel('align-center') }, { label: 'Right', action: () => arrangeSel('align-right') },
      { sep: true },
      { label: 'Top', action: () => arrangeSel('align-top') }, { label: 'Middle', action: () => arrangeSel('align-middle') }, { label: 'Bottom', action: () => arrangeSel('align-bottom') },
      { sep: true },
      { label: 'Centre on the slide horizontally', action: () => arrangeSel('center-h') },
      { label: 'Centre on the slide vertically', action: () => arrangeSel('center-v') },
      { sep: true },
      { label: 'Distribute horizontally', disabled: sel.length < 3, action: () => arrangeSel('distribute-h') },
      { label: 'Distribute vertically', disabled: sel.length < 3, action: () => arrangeSel('distribute-v') },
    ] },
    { label: 'Rotate and flip', sub: [
      { label: 'Rotate 90° clockwise', action: () => arrangeSel('rotate-cw') },
      { label: 'Rotate 90° counter-clockwise', action: () => arrangeSel('rotate-ccw') },
      { label: 'Reset rotation', disabled: !sel.some(s => s.style.rotate), action: () => arrangeSel('rotate-reset') },
      { sep: true },
      { label: 'Flip horizontally', action: () => arrangeSel('flip-h') },
      { label: 'Flip vertically', action: () => arrangeSel('flip-v') },
    ] },
    ...(sel.length > 1 ? [{ label: 'Group', shortcut: 'Ctrl+G', action: () => arrangeSel('group') }] : []),
    ...(sel.some(s => s.kind === 'group' || (s.kind === 'svgpart' && s.tag === 'g')) ? [{ label: 'Ungroup', shortcut: 'Ctrl+Shift+G', action: () => arrangeSel('ungroup') }] : []),
    sel.every(s => s.locked) ? { label: 'Unlock', action: () => arrangeSel('unlock') } : { label: 'Lock', action: () => arrangeSel('lock') },
  ];

  const objectMenu = (x: number, y: number) => {
    if (!sel.length) { emptySlideMenu(x, y, currentRef.current); return; }
    const one = sel.length === 1 ? sel[0] : null;
    const items: MenuItem[] = [
      ...(one && one.canText ? [{ label: 'Edit text', shortcut: 'Enter', action: () => toCanvas({ ol: 'editText', path: one.path }) }] : []),
      // a drawing: its points, Inkscape's node editor (the shape right-clicked, when the drawing has several)
      ...(one && (one.kind === 'svg' || one.kind === 'svgpart' || one.kind === 'line') && !one.locked ? [{ label: 'Edit points', shortcut: 'N', action: () => arrangeSel('edit-nodes') }] : []),
      ...(one && one.kind === 'image' ? [
        { label: 'Crop', action: imageTools.crop },
        { label: 'Remove background', action: imageTools.removeBackground },
        { label: 'Replace picture…', action: imageTools.replace },
      ] : []),
      { label: 'Edit code', action: () => showCode() },
      { label: 'Comment', shortcut: 'Ctrl+Alt+M', disabled: readOnlyRef.current, action: () => toCanvas({ ol: 'newComment' }) },
      ...(selChange && !readOnlyRef.current ? [
        { label: `Accept suggestion (${selChange.by})`, action: () => resolveChange(selChange, true) },
        { label: 'Reject suggestion', action: () => resolveChange(selChange, false) },
      ] : []),
      { sep: true },
      { label: 'Duplicate', shortcut: 'Ctrl+D', action: duplicateSel },
      { label: 'Delete', shortcut: 'Del', disabled: sel.every(s => s.locked), action: removeSel },
      { sep: true },
      ...arrangeItems(),
    ];
    showContextMenu(x, y, items);
  };

  const pickAt = (x: number, y: number, title: string, render: (close: () => void) => ComponentChildren) => { closeContextMenu(); setFloatPop({ x, y, title, render }); };
  const canvasItems = (x: number, y: number): MenuItem[] => {
    const v = viewRef.current;
    return [
      { label: 'Canvas colour', sub: [
        { label: darkRef.current.dark ? 'Automatic (dark grey in the dark theme)' : 'Same as the page', checked: v.desk === null && !v.deskChecker, action: () => setView({ desk: null, deskChecker: false }) },
        ...(colors?.page ? [{ label: 'The slides’ colour', action: () => setView({ desk: colors.page, deskChecker: false }) }] : []),
        { label: 'White', checked: v.desk === '#ffffff', action: () => setView({ desk: '#ffffff', deskChecker: false }) },
        { label: 'Light grey', checked: v.desk === '#e8eaed', action: () => setView({ desk: '#e8eaed', deskChecker: false }) },
        { label: 'Dark grey', checked: v.desk === '#3c4043', action: () => setView({ desk: '#3c4043', deskChecker: false }) },
        { label: 'Black', checked: v.desk === '#000000', action: () => setView({ desk: '#000000', deskChecker: false }) },
        { label: 'Other colour…', action: () => pickAt(x, y, 'Canvas colour', close => <ColorGrid current={v.desk} close={close} none="Same as the page" onPick={c => setView({ desk: c, deskChecker: false })} />) },
      ] },
      { label: 'Checkerboard canvas', checked: v.deskChecker, action: () => setView({ deskChecker: !v.deskChecker }) },
      { label: 'Checkerboard under the slides (shows transparency)', checked: v.pageChecker, action: () => setView({ pageChecker: !v.pageChecker }) },
      ...(darkRef.current.dark ? [{ label: 'Invert slides in the dark theme', checked: darkRef.current.invert, action: () => setPref('invertSlides', !darkRef.current.invert) }] : []),
      { sep: true },
      { label: zoomRef.current > 1.01 ? 'Fit the slide' : 'Back to the slide', action: fitSlide },
    ];
  };
  const canvasMenu = (x: number, y: number) => showContextMenu(x, y, canvasItems(x, y));
  const emptySlideMenu = (x: number, y: number, i: number) => {
    const ps = slidePaths(text.toString());
    const sp = ps[i];
    showContextMenu(x, y, [
      { label: 'Text box', action: () => insertObject('text') },
      { label: 'Picture…', action: () => fileInput.current?.click() },
      { label: kind === 'page' ? 'Comment on the page' : 'Comment on the slide', disabled: readOnlyRef.current, action: () => startDraft(sp ?? null, i) },
      ...(kind !== 'page' ? [
        { sep: true },
        { label: 'Slide background colour…', disabled: !sp || readOnlyRef.current, action: () => pickAt(x, y, 'Slide background', close => <ColorGrid current={null} close={close} none="As the design has it" onPick={c => { if (sp) applyOps([{ t: 'style', path: sp, set: { background: c } }]); }} />) },
        { label: 'New slide', shortcut: 'Ctrl+M', action: () => newSlide(i) },
        { label: 'Duplicate slide', action: () => duplicateSlide(i) },
      ] : []),
      { sep: true },
      { label: 'Canvas', sub: canvasItems(x, y) },
    ]);
  };

  /* ------------------------------------------------------------- slides */

  const newSlide = (after: number, blank = false) => {
    const cur = text.toString();
    const ps = slidePaths(cur);
    const html = newSlideHtml(cur, after, blank);
    if (!html || !ps.length) return;
    const p = ps[Math.min(after, ps.length - 1)];
    const parent = p.slice(0, -1);
    if (!applyOps([{ t: 'insert', parent, index: p[p.length - 1] + 1, html }])) return;
    const next = after + 1;
    setTimeout(() => { setCurrent(next); toCanvas({ ol: 'scrollTo', slide: next }); toRail({ ol: 'current', slide: next }); }, 150);
  };
  const gotoSlide = (i: number) => {
    const n = slidesRef.current.length;
    if (!n) return;
    const k = Math.max(0, Math.min(n - 1, i));
    setCurrent(k); toCanvas({ ol: 'scrollTo', slide: k }); toRail({ ol: 'current', slide: k });
  };
  const duplicateSlide = (i: number) => { const p = slidePaths(text.toString())[i]; if (p) applyOps([{ t: 'duplicate', paths: [p] }]); };
  const deleteSlide = (i: number) => { const ps = slidePaths(text.toString()); if (ps.length > 1 && ps[i]) applyOps([{ t: 'remove', paths: [ps[i]] }]); };
  const moveSlide = (i: number, d: -1 | 1) => {
    const ps = slidePaths(text.toString());
    const p = ps[i], q = ps[i + d];
    if (!p || !q) return;
    const parent = p.slice(0, -1);
    // the index among the siblings without the slide itself
    const qi = q[q.length - 1] - (q[q.length - 1] > p[p.length - 1] ? 1 : 0);
    applyOps([{ t: 'move', path: p, parent, index: d > 0 ? qi + 1 : qi }]);
    setCurrent(i + d);
  };
  const slideMenu = (x: number, y: number, i: number) => {
    const n = slides.length;
    showContextMenu(x, y, [
      { label: 'New slide', action: () => newSlide(i) },
      { label: 'Blank slide', action: () => newSlide(i, true) },
      { label: 'Duplicate slide', action: () => duplicateSlide(i) },
      { sep: true },
      { label: 'Move up', disabled: i <= 0, action: () => moveSlide(i, -1) },
      { label: 'Move down', disabled: i >= n - 1, action: () => moveSlide(i, 1) },
      { sep: true },
      { label: 'Edit code', action: () => { const p = slidePaths(text.toString())[i]; if (p) showCode(p); } },
      { label: 'Comment on the slide', disabled: readOnlyRef.current, action: () => startDraft(slidePaths(text.toString())[i] ?? null, i) },
      { label: 'Delete slide', disabled: n <= 1, action: () => deleteSlide(i) },
    ]);
  };

  /* ------------------------------------------------------------- keys */

  // the tools' letters (T text, R rectangle, O ellipse, L line, A arrow, P pen, E eraser, B curve, V pointer,
  // N the points of the selection) — but a run of letters is somebody typing, as they would in
  // PowerPoint, where letters are no tools: back to the pointer, and say once how to type on the
  // slide (typing at a selected group switched tools, drew stray lines and opened point editing).
  // N waits a moment for that reason: point editing would swallow the rest of the word.
  const lastLetter = useRef(0);
  const typingHinted = useRef(false);
  const nodesTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const letterKey = (key: string): boolean => {
    const now = performance.now(), typing = now - lastLetter.current < 600;
    lastLetter.current = now;
    if (nodesTimer.current) { clearTimeout(nodesTimer.current); nodesTimer.current = null; }
    if (typing) {
      setToolState('select');
      if (!typingHinted.current) { typingHinted.current = true; notify('To type on the slide, double-click a text box — or press T and click where the text goes.'); }
      return true;
    }
    const k = key.toLowerCase();
    const map: Record<string, Tool> = { t: 'text', r: 'rect', o: 'ellipse', l: 'line', a: 'arrow', p: 'pen', e: 'eraser', b: 'bezier', v: 'select' };
    if (map[k]) { setToolState(map[k]); return true; }
    if (k === 'n' && selRef.current.length) { nodesTimer.current = setTimeout(() => { nodesTimer.current = null; arrangeSel('edit-nodes'); }, 600); return true; }
    return false;
  };
  const onRuntimeKey = (m: Extract<FromRuntime, { ol: 'key' }>) => {
    const mod = m.ctrl || m.meta;
    if (typeAhead.current && !mod && m.key.length === 1) { typeAhead.current.push(m.key); return; }
    if (holdForText({ key: m.key, shift: m.shift, alt: m.alt, ctrl: m.ctrl, meta: m.meta })) return;
    const k = m.key.toLowerCase();
    if (mod && k === 'z') { if (m.shift) host.redo(); else host.undo(); return; }
    if (mod && k === 'y') { host.redo(); return; }
    if (mod && k === 's') { if (host.save) host.save(); else notify('Saved automatically.'); return; }
    if (m.key === 'F5' || (mod && m.key === 'Enter')) { startPresenting(m.key === 'F5' && !m.shift); return; }
    if (mod && k === 'g') { arrangeSel(m.shift ? 'ungroup' : 'group'); return; }
    // Inkscape's Path ▸ Combine / Break apart / Simplify
    // in a text being retyped: what goes into it, as in documents (link, citation, cross-reference)
    if (editingTextRef.current && mod && !m.shift && k === 'k') { insertLink(); return; }
    if (editingTextRef.current && mod && m.shift && k === 'c') { if (host.docId) setCiteOpen(true); return; }
    if (editingTextRef.current && mod && m.shift && k === 'i') { pickReference(); return; }
    if (mod && k === 'k') { arrangeSel(m.shift ? 'break-apart' : 'combine'); return; }
    if (mod && k === 'l' && !m.shift) { arrangeSel('simplify'); return; }
    if (mod && m.key === 'ArrowUp') { arrangeSel(m.shift ? 'front' : 'forward'); return; }
    if (mod && m.key === 'ArrowDown') { arrangeSel(m.shift ? 'back' : 'backward'); return; }
    if (mod && k === 'm' && kindRef.current === 'deck') { newSlide(currentRef.current); return; }
    if (mod && m.shift && (m.key === '>' || m.key === '.')) { fontSize(1); return; }
    if (mod && m.shift && (m.key === '<' || m.key === ',')) { fontSize(-1); return; }
    if (mod && m.shift && k === 'l') { textActions.align('left'); return; }
    if (mod && m.shift && k === 'e') { textActions.align('center'); return; }
    if (mod && m.shift && k === 'r') { textActions.align('right'); return; }
    if (mod && m.shift && k === 'j') { textActions.align('justify'); return; }
    if (mod && m.key === '\\') { textActions.clear(); return; }
    if (mod && k === '0') { fitSlide(); return; }
    if (mod && (m.key === '=' || m.key === '+')) { zoomStep(1.25); return; }
    if (mod && m.key === '-') { zoomStep(1 / 1.25); return; }
    if (m.key === 'Escape') { setToolState('select'); return; }
    // the slide before / after (the canvas shows one; the rail moves between them)
    if (!mod && !m.alt && (m.key === 'PageDown' || m.key === 'PageUp') && kindRef.current === 'deck') { gotoSlide(currentRef.current + (m.key === 'PageDown' ? 1 : -1)); return; }
    if (!mod && !m.alt && m.key.length === 1 && letterKey(m.key)) return;
    host.key?.(m);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!canvasBox.current?.closest('.dl-editor')?.contains(document.activeElement) && document.activeElement !== document.body) return;
      if ((e.target as HTMLElement)?.closest?.('textarea, input')) return;
      if ((e.target as HTMLElement)?.isContentEditable) return;
      const mod = e.ctrlKey || e.metaKey;
      // a new formula is opening: what is typed goes into it
      if (typeAhead.current && !mod && !e.altKey && e.key.length === 1 && !document.querySelector('[data-dl-mathedit]')) { e.preventDefault(); typeAhead.current.push(e.key); return; }
      // a text box was just drawn: what is typed goes into it once it is ready
      if (holdForText({ key: e.key, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey })) { e.preventDefault(); return; }
      // a text is being retyped but the keyboard is still out here (the canvas has not got it yet): the key is the text's
      if (editingTextRef.current && !mod && !e.altKey && (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Enter') && !document.querySelector('[data-dl-mathedit]')) {
        e.preventDefault();
        toCanvas({ ol: 'typeKeys', keys: [{ key: e.key, shift: e.shiftKey }] });
        return;
      }
      // the node editor's keys when the focus is not in the canvas
      if (nodeEdRef.current && (e.key === 'Escape' || e.key === 'Enter' || e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); toCanvas({ ol: 'nodes', cmd: e.key === 'Delete' || e.key === 'Backspace' ? 'delete' : 'done' }); return; }
      // a comment on the selection (or the slide), as in documents
      if (mod && e.altKey && e.code === 'KeyM') { e.preventDefault(); toCanvas({ ol: 'newComment' }); }
      else if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) host.redo(); else host.undo(); }
      else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); host.redo(); }
      else if (e.key === 'F5') { e.preventDefault(); startPresenting(!e.shiftKey); }
      // the focus left the canvas (a toolbar button, a palette): its shortcuts still work on the selection
      else if (mod && (['g', 'm', '0', '=', '+', '-', '\\'].includes(e.key.toLowerCase()) || (['k', 'l'].includes(e.key.toLowerCase()) && selRef.current.length)) || (mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown'))) { e.preventDefault(); onRuntimeKey({ ol: 'key', key: e.key, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey }); }
      else if (!mod && !e.altKey && (e.key === 'PageDown' || e.key === 'PageUp') && kindRef.current === 'deck' && soloRef.current) { e.preventDefault(); gotoSlide(currentRef.current + (e.key === 'PageDown' ? 1 : -1)); }
      else if (mod && e.key.toLowerCase() === 'd' && selRef.current.length) { e.preventDefault(); duplicateSel(); }
      // the keyboard is in the editor, not the canvas (a click on the canvas leaves it here): Ctrl+A selects the slide's objects, not the page's text
      else if (mod && !e.altKey && e.key.toLowerCase() === 'a' && kindRef.current !== 'page') { e.preventDefault(); toCanvas({ ol: 'selectAll' }); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && selRef.current.length) { e.preventDefault(); removeSel(); }
      else if (!mod && !e.altKey && e.key.length === 1 && !readOnlyRef.current) {
        // a text box selected: typing retypes it (as in the canvas) — the letters are not the tools' then
        // (a co-author typing over a selected title drew a line with L)
        const one = selRef.current.length === 1 ? selRef.current[0] : null;
        if (one && one.canText && !one.locked && e.key !== ' ') {
          e.preventDefault();
          toCanvas({ ol: 'editText', path: one.path, selectAll: true });
          toCanvas({ ol: 'typeKeys', keys: [{ key: e.key, shift: e.shiftKey }] });
          // the next keys follow it in order (not each one starting the retyping again) until the canvas says it is retyping
          textAhead.current = true;
          if (textAheadTimer.current) clearTimeout(textAheadTimer.current);
          textAheadTimer.current = setTimeout(() => { textAhead.current = false; }, 2000);
          return;
        }
        // the tools' letters also before the canvas has the focus
        if (letterKey(e.key)) e.preventDefault();
      }
      // Escape: the tool back to Select, then a level up (out of a group); arrows nudge — the canvas's keys
      else if (e.key === 'Escape') { if (tool !== 'select') setToolState('select'); else if (selRef.current.length && !presenting) toCanvas({ ol: 'canvasKey', key: 'Escape', shift: false }); }
      else if (!mod && !e.altKey && e.key.startsWith('Arrow') && selRef.current.length && !readOnlyRef.current && !presenting) { e.preventDefault(); toCanvas({ ol: 'canvasKey', key: e.key as 'ArrowLeft', shift: e.shiftKey }); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  /* ------------------------------------------------------------- presenting */

  // slides deleted as suggestions are not presented: the presentation numbers the others
  const presentIndexOf = (i: number) => slidesRef.current.slice(0, i).filter(s => !s.deleted).length;
  const canvasIndexOf = (k: number) => {
    let n = -1;
    const ss = slidesRef.current;
    for (let i = 0; i < ss.length; i++) if (!ss[i].deleted && ++n === k) return i;
    return k;
  };

  const presentBox = useRef<HTMLDivElement>(null);
  /** the presented slide is zoomed in: Escape (which leaves full screen first) only zooms out */
  const presentZoomed = useRef(false);
  /** the slide the presentation starts on: F5 the first (PowerPoint), Shift+F5 and the button the one shown */
  const presentFrom = useRef(0);
  const startPresenting = (fromStart = false) => {
    presentZoomed.current = false;
    presentFrom.current = fromStart ? 0 : presentIndexOf(currentRef.current);
    if (link && host.present?.(src('present') + `#${presentFrom.current + 1}`)) return;
    setPresenting(true);
    setTimeout(() => {
      void presentBox.current?.requestFullscreen?.().catch(() => undefined);
      presentFrame.current?.focus();
    }, 30);
  };
  const stopPresenting = () => {
    setPresenting(false);
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  };
  useEffect(() => {
    const onFs = () => {
      if (document.fullscreenElement || !presenting) return;
      if (presentZoomed.current) { presentZoomed.current = false; toFrame(presentFrame.current, { ol: 'unzoom' }); return; }
      setPresenting(false);
    };
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, [presenting]);
  useEffect(() => { if (!presenting && slides[current]) { toCanvas({ ol: 'scrollTo', slide: current }); toRail({ ol: 'current', slide: current }); } }, [presenting]);

  /* ------------------------------------------------------------- code view */

  const codeRef = useRef<HTMLTextAreaElement>(null);
  const codeSync = (origin: unknown) => {
    const ta = codeRef.current;
    if (!ta || origin === 'code') return;
    const v = text.toString();
    if (ta.value === v) return;
    const s = ta.selectionStart, e = ta.selectionEnd;
    const old = ta.value;
    ta.value = v;
    // the caret kept where it was relative to the text around it
    let p = 0;
    while (p < old.length && p < v.length && old[p] === v[p]) p++;
    const shift = v.length - old.length;
    ta.setSelectionRange(s > p ? s + shift : s, e > p ? e + shift : e);
  };
  const onCodeInput = () => {
    const ta = codeRef.current;
    if (!ta || readOnlyRef.current) return;
    const old = text.toString(), v = ta.value;
    let p = 0;
    const max = Math.min(old.length, v.length);
    while (p < max && old[p] === v[p]) p++;
    let s = 0;
    while (s < max - p && old[old.length - 1 - s] === v[v.length - 1 - s]) s++;
    applySplices([{ from: p, to: old.length - s, insert: v.slice(p, v.length - s) }], 'code');
    sendSource();
  };
  useEffect(() => { if (codeOpen && codeRef.current) codeRef.current.value = text.toString(); }, [codeOpen]);

  /* ------------------------------------------------------------- notes */

  const curSlidePath = slides[current]?.path ?? null;
  const notes = curSlidePath && kind === 'deck' ? slideNotes(text.toString(), curSlidePath).text : '';
  /** notes being typed, with the slide they are typed for (a click in the rail changes the slide without a blur) */
  const [notesDraft, setNotesDraftState] = useState<{ path: Path; text: string } | null>(null);
  const draftRef = useRef(notesDraft); draftRef.current = notesDraft;
  const setNotesDraft = (v: string | null) => setNotesDraftState(v === null ? null : curSlidePath ? { path: curSlidePath, text: v } : null);
  const saveNotes = (v: string, path = curSlidePath) => {
    if (!path || readOnlyRef.current) return;
    const op = notesOp(text.toString(), path, v);
    // (speaker notes are the presenter's: never a suggestion)
    if (op) applyOps([op], true);
  };  /** the notes folded away: what was being typed is kept first (a removed textarea is not blurred) */
  const hideNotes = () => {
    const d = draftRef.current;
    if (d) { saveNotes(d.text, d.path); setNotesDraftState(null); }
    setNotesShown(false);
  };

  // another slide: what was typed goes to the slide it was typed for
  useEffect(() => {
    const d = draftRef.current;
    if (d && (!curSlidePath || d.path.join() !== curSlidePath.join())) { saveNotes(d.text, d.path); setNotesDraftState(null); }
  }, [curSlidePath?.join()]);

  /* ------------------------------------------------------------- render */

  const src = (mode: string) => (link ? `${link.base}${link.entry.split('/').map(encodeURIComponent).join('/')}?ol=${mode}` : 'about:blank');
  const frameH = Math.max(100, box.h / scale);
  const left = leftFor(scale, panX);
  const title = path.split('/').slice(-2).join('/');
  const mathExec = (cmd: string, ...args: unknown[]) => { const f = activeMathField(); if (f) { f.execute(cmd, ...args); f.focus(); } };
  const mathPanels = useMathPanels(mathExec);
  const labelFormula = () => {
    const ops = mathOps.current;
    if (!ops) return;
    void uiPrompt('Label', 'The name \\eqref{…} refers to this equation by (it is numbered).', ops.labelNow() || 'eq:', { okLabel: 'Label' }).then(name => { if (name !== null) mathOps.current?.label(name); });
  };
  /** a reference to a labelled equation: the labels of the page, picked under the button */
  const pickReference = () => {
    const labels = [...new Set([...text.toString().matchAll(/\\label\{([^}]+)\}/g)].map(m => m[1].trim()))];
    const b = document.querySelector('[data-tb="dk-ref"]')?.getBoundingClientRect();
    if (!labels.length) { notify('No equation has a label yet: open a displayed formula and give it one (Label in its toolbar).', 'info'); return; }
    pickAt(b ? b.left : 200, b ? b.bottom + 4 : 120, 'Reference to', close => (
      <div class="dk-refs">
        {labels.map(l => <button type="button" class="dk-ref-item" key={l} onClick={() => { close(); canvasFrame.current?.focus(); toCanvas({ ol: 'insertRef', src: `\\eqref{${l}}` }); }}>{l}</button>)}
      </div>
    ));
  };
  /** a link on the words selected in the text being retyped (the address itself when none are) */
  const insertLink = () => {
    void uiPrompt('Link', 'The address the words link to', 'https://', { okLabel: 'Link' }).then(url => {
      if (!url || !url.trim() || url.trim() === 'https://') return;
      canvasFrame.current?.focus();
      toCanvas({ ol: 'exec', command: 'createLink', value: url.trim() });
    });
  };
  const toggleObjects = (open = !objOpen) => {
    setObjOpen(open);
    try { localStorage.setItem('ol.objPane', open ? '1' : '0'); } catch { /* private window */ }
    toCanvas({ ol: 'objects', on: open });
    if (!open) toCanvas({ ol: 'hover', path: null });
  };
  const toggleAnim = (open = !animOpen) => {
    setAnimOpen(open);
    try { localStorage.setItem('ol.animPane', open ? '1' : '0'); } catch { /* private window */ }
    if (!open && seq.ordering) toCanvas({ ol: 'steps', cmd: { how: 'order', kind: null } });
  };
  const bars = deckToolbar({
    kind, tool, setTool, readOnly: locked, sel, editingText: !!editingText,
    math: { editing: !!mathEdit && !mathEdit.closing, insert: display => toCanvas({ ol: 'insertMath', display }), exec: mathExec, panels: mathPanels,
      display: !!mathEdit?.display, number: () => mathOps.current?.number(), label: labelFormula },
    latex: { link: insertLink, cite: host.docId ? () => setCiteOpen(true) : undefined, reference: pickReference },
    animate: { open: animOpen && kind === 'deck', toggle: () => toggleAnim() },
    nodes: { editing: !!nodeEd, selected: nodeEd?.selected ?? 0, total: nodeEd?.total ?? 0, cmd: cmd => toCanvas({ ol: 'nodes', cmd }) },
    // (the text being retyped ends first: its box does not take the undone version while it is retyped)
    undo: () => { toCanvas({ ol: 'stopText' }); setTimeout(() => host.undo(), 30); }, redo: () => { toCanvas({ ol: 'stopText' }); setTimeout(() => host.redo(), 30); },
    insertImage: () => fileInput.current?.click(),
    text: textActions, paint, arrange: arrangeSel, image: imageTools, remove: removeSel,
    slideBackground: c => { const sp = slidePaths(text.toString())[currentRef.current]; if (sp) applyOps([{ t: 'style', path: sp, set: { background: c } }]); },
    canvas: { view, set: setView },
    newSlide: () => newSlide(currentRef.current),
    ink: { presets: ink, set: setInk, draw: on => setToolState(on ? 'pen' : 'select') },
    review: {
      comment: () => toCanvas({ ol: 'newComment' }),
      suggestion: selChange ? { by: selChange.by, summary: selChange.summary, accept: () => resolveChange(selChange, true), reject: () => resolveChange(selChange, false) } : null,
    },
  });
  const openComments = review.threads.filter(t => !t.thread.done).length;
  // the quick menu beside the selection (QuickBar.tsx): the toolbar's most used buttons, duplicate, comment
  const quick = !locked && !dragging && !presenting && tool === 'select' && sel.length && !nodeEd && !mathEdit && !cropping
    ? quickGroups(bars.sections, [
      { id: 'dk-dup', title: 'Duplicate (Ctrl+D)', icon: 'dk-duplicate', action: duplicateSel },
      { id: 'dk-comment', title: 'Comment (Ctrl+Alt+M)', icon: 'dk-comment', action: () => toCanvas({ ol: 'newComment' }) },
    ]) : [];
  const quickRect = sel.length ? sel.map(s => s.rect).reduce((a, r) => {
    const x = Math.min(a.x, r.x), y = Math.min(a.y, r.y);
    return { x, y, w: Math.max(a.x + a.w, r.x + r.w) - x, h: Math.max(a.y + a.h, r.y + r.h) - y };
  }) : null;

  // the contextual tools on a row of their own when they do not fit beside the others (nothing hidden)
  const barRef = useRef<HTMLDivElement>(null);
  const [ctxRow, setCtxRow] = useState(false);
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const check = () => {
      const ctx = bar.querySelector<HTMLElement>(':scope > .dl-ctx');
      const need = (ctx?.firstElementChild as HTMLElement | null)?.scrollWidth ?? 0;
      let others = 0;
      for (const k of Array.from(bar.children) as HTMLElement[]) if (k !== ctx && k.offsetParent !== null) others += k.offsetWidth + 4;
      const cs = getComputedStyle(bar);
      const room = bar.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0) - others - 16;
      setCtxRow(need > room);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(bar);
    return () => ro.disconnect();
  });

  // the slide in view: is enough of it on the screen? (zoomed into a corner, or scrolled away from it)
  const curBox = slides[current]?.rect;
  let lost = false;
  if (curBox && kind !== 'page' && !soloOn && box.w > 0) {
    const vx0 = -left / scale, vx1 = (box.w - left) / scale, vy0 = scrollY, vy1 = scrollY + box.h / scale;
    const ix = Math.max(0, Math.min(vx1, curBox.x + curBox.w) - Math.max(vx0, curBox.x));
    const iy = Math.max(0, Math.min(vy1, curBox.y + curBox.h) - Math.max(vy0, curBox.y));
    const seen = (ix * iy) / Math.max(1, curBox.w * curBox.h);
    const fills = (ix * iy) / Math.max(1, (vx1 - vx0) * (vy1 - vy0));
    lost = seen < 0.35 && fills < 0.6;
  }
  const zoomed = soloOn ? Math.abs(zoom - 1) > 0.01 : zoom > 1.01;

  return (
    <div class={'dl-editor' + (presenting ? ' presenting' : '')} data-kind={kind}>
      {quick.length > 0 && quickRect && <QuickBar groups={quick} rect={quickRect} frame={() => canvasFrame.current} scrollY={() => (soloOn ? 0 : scrollRef.current)} />}
      {/* (the context tools, when they float below the bar, start right of the slide rail: its header stays clear) */}
      <div ref={barRef} class={'dl-toolbar' + (ctxRow ? ' dl-ctx-row' : '')} role="toolbar" style={`--ctx-left: ${showRail ? (railShown ? railW : 28) + 8 : 8}px`}>
        <span class="dl-title" title={path}>{title}</span>
        <Toolbar id="deck-tools" groups={bars.tools} />
        <input ref={fileInput} type="file" accept="image/*,.svg" multiple hidden onChange={e => { const fs = Array.from((e.target as HTMLInputElement).files ?? []); (e.target as HTMLInputElement).value = ''; void uploadImages(fs.map(f => ({ name: f.name, type: f.type, data: f })), null); }} />
        <input ref={replaceInput} type="file" accept="image/*,.svg" hidden onChange={e => { const fs = Array.from((e.target as HTMLInputElement).files ?? []); (e.target as HTMLInputElement).value = ''; void replacePicture(fs); }} />
        <div class="dl-ctx">{bars.sections.length > 0 && (
          <div class="dl-ctx-secs">{bars.sections.map((sec, i) => <Toolbar key={`${i}:${sec.label}`} id="deck-context" label={sec.label} groups={sec.groups} />)}</div>
        )}</div>
        {kind === 'page' && <>
          <button class={'dl-btn' + (device === 'desktop' ? ' on' : '')} title="Desktop width" onClick={() => setDevice('desktop')}>🖥</button>
          <button class={'dl-btn' + (device === 'mobile' ? ' on' : '')} title="Phone width" onClick={() => setDevice('mobile')}>📱</button>
        </>}
        <span class="dl-zoomgroup">
          <button class="dl-btn" title="Zoom out (Ctrl+−)" onClick={() => zoomStep(1 / 1.25)}>−</button>
          <button class="dl-btn dl-zoom" title="Fit (Ctrl+0)" onClick={fitSlide}>{Math.round(scale * 100)}%</button>
          <button class="dl-btn" title="Zoom in (Ctrl+=)" onClick={() => zoomStep(1.25)}>+</button>
        </span>
        {darkS.dark && <button class={'dl-btn dl-invert' + (darkS.invert ? ' on' : '')} data-dl-invert aria-pressed={darkS.invert} onClick={() => setPref('invertSlides', !darkS.invert)}
          title={darkS.invert ? 'Slides light on dark (pictures in their colours) — click for their own colours' : 'The slides’ own colours — click to show them light on dark'}>◐</button>}
        <button class={'dl-btn dl-objects-btn' + (objOpen ? ' on' : '')} data-tb="dk-objects" onClick={() => toggleObjects()}
          title="Objects: what is on the slide as a tree — open groups and drawings, select a letter of a logo, rename, lock, restack (Inkscape's Objects, PowerPoint's Selection Pane)"
          dangerouslySetInnerHTML={{ __html: ICONS['dk-objects'] ?? '' }} />
        <button class={'dl-btn' + (codeOpen ? ' on' : '')} title="The page's code" data-dl-code onClick={() => setCodeOpen(o => !o)}>&lt;/&gt;</button>
        <button class={'dl-btn dl-review-btn' + (reviewOpen ? ' on' : '')} data-dl-review-toggle onClick={() => { setReviewOpen(!reviewOpen); if (reviewOpen) { setDraft(null); setFocus(null); } }}
          title={`Comments and suggestions${openComments || review.changes.length ? ` — ${openComments} open comment${openComments === 1 ? '' : 's'}, ${review.changes.length} suggestion${review.changes.length === 1 ? '' : 's'}` : ''}`}>
          <svg class="dl-rv-icon-svg" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 2.5h12v8.5H6.5L2 14z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" /></svg>
          {openComments + review.changes.length > 0 && <span class="dl-rv-count" data-dl-review-count>{openComments + review.changes.length}</span>}
        </button>
        <EditModeSwitch mode={viewing ? 'viewing' : suggesting ? 'suggesting' : 'editing'} canEdit={!readOnly} view={null} views={() => []} onMode={setMode}
          changes={{ ins: showIns, del: showDel, set: setChanges }} shortcuts={false} />
        {kind !== 'page' && <button class="dl-btn dl-present" title="Present from this slide (Shift+F5) — F5 from the first" data-dl-present onClick={() => startPresenting(false)}>▶ Present</button>}
        <button class="dl-btn" title="Download" data-dl-download onClick={e => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          showContextMenu(r.left, r.bottom + 4, host.downloads(m => src(m === 'view' && kind === 'deck' ? 'present' : m)));
        }}>⤓</button>
        <span class={'dl-status' + (online ? '' : ' off')}>{!synced ? 'Loading…' : !online ? 'Offline' : readOnly ? 'View only' : ''}</span>
      </div>
      <div class="dl-body">
        {showRail && (
          <div class={'dl-rail' + (railShown ? '' : ' folded')} ref={railBox} style={railShown ? { width: `${railW}px` } : undefined}>
            {railShown ? <>
              <div class="dl-rail-head">
                <span class="dl-rail-count" title="The slide shown, of all slides">{slides.length ? `Slide ${current + 1} of ${slides.length}` : 'Slides'}</span>
                <button class="dl-btn dl-rail-hide" title="Hide the slides (more room for the slide)" aria-label="Hide the slides" data-dl-rail-hide onClick={() => setRailShown(false)}>«</button>
              </div>
              {link && synced && <iframe ref={railFrame} class="dl-railframe" title="Slides" sandbox="allow-scripts" src={src('thumb')}
                style={{ top: `${RAIL_HEAD}px`, width: `${frameW}px`, height: `${railH / railScale}px`, transform: `scale(${railScale})` }} />}
              <div class="dl-rail-grip" role="separator" aria-orientation="vertical" aria-label="Slide rail width" title="Drag to make the slides wider or narrower (double-click: back to the usual width)"
                data-dl-railgrip onPointerDown={onRailGrip} onDblClick={() => setRail(RAIL_W)} />
              <div class="dl-rail-actions">
                <button class="dl-btn" title="New slide after this one (Ctrl+M)" data-dl-newslide disabled={locked} onClick={() => newSlide(current)}>+ Slide</button>
              </div>
            </> : (
              <button type="button" class="dl-rail-show" title="Show the slides" data-dl-rail-show onClick={() => setRailShown(true)}>
                <span aria-hidden="true">»</span>
                <span class="dl-rail-show-label">Slides{slides.length ? ` · ${current + 1} of ${slides.length}` : ''}</span>
              </button>
            )}
          </div>
        )}
        <div class="dl-main">
          <div class="dl-canvas" ref={canvasBox} style={deskCss ? { background: deskCss } : undefined} data-desk={view.deskChecker ? 'checker' : view.desk ? 'custom' : 'page'}
            onContextMenu={e => { if (e.target === e.currentTarget) { e.preventDefault(); canvasMenu(e.clientX, e.clientY); } }}
            onPointerDown={canvasTouch} onPointerMove={canvasTouch} onPointerUp={canvasTouch} onPointerCancel={canvasTouch}
            onWheel={e => {
              if (e.target !== e.currentTarget) return;
              const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
              if (soloOn) {
                // beside the slide: as on it — a pinch zooms about the pointer, a scroll pulls the slide (it springs back, or pulled far enough, comes loose)
                e.preventDefault();
                const r = e.currentTarget.getBoundingClientRect();
                if (e.ctrlKey || e.metaKey) zoomSolo(Math.exp(-e.deltaY * k * 0.01), e.clientX - r.left, e.clientY - r.top);
                else if (e.shiftKey && !e.deltaX) slideView.scroll(-e.deltaY * k, 0);
                else slideView.scroll(-e.deltaX * k, -e.deltaY * k);
                return;
              }
              if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomStep(Math.exp(-e.deltaY * 0.01)); } else if (e.deltaX || e.shiftKey) setPanX(p => p - (e.deltaX || e.deltaY));
            }}
            onDragOver={e => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }}
            onDrop={e => { if (!e.dataTransfer?.files.length) return; e.preventDefault(); const fs = Array.from(e.dataTransfer.files); void placeFiles(fs.map(f => ({ name: f.name, type: f.type, data: f })), null, null); }}>
            {link && synced && <iframe ref={canvasFrame} class={'dl-frame' + (soloOn ? ' solo' : '')} title="Page" sandbox="allow-scripts allow-modals allow-popups allow-forms" src={src('edit')}
              style={soloOn ? { width: `${frameW}px`, height: `${solo!.height}px`, left: '0px' } : { width: `${frameW}px`, height: `${frameH}px`, transform: `scale(${scale})`, left: `${left}px` }} />}
            {soloOn && (
              <div ref={pullRing} class="dl-pull" data-dl-pull aria-hidden="true">
                <svg viewBox="0 0 32 32">
                  <circle class="dl-pull-disc" cx="16" cy="16" r="15" />
                  <circle class="dl-pull-arc" cx="16" cy="16" r="12.5" pathLength="1" transform="rotate(-90 16 16)" />
                  <path class="dl-pull-arrows" d="M16 9v14M9 16h14M13.5 11.5 16 9l2.5 2.5M13.5 20.5 16 23l2.5-2.5M11.5 13.5 9 16l2.5 2.5M20.5 13.5 23 16l-2.5 2.5" />
                </svg>
              </div>
            )}
            {hud && <div key={hud.n} class="dl-hud" role="status" data-dl-hud>{hud.text}</div>}
            {(lost || zoomed || (soloOn && slideFree)) && kind !== 'page' && (
              <button type="button" class={'dl-refocus' + (lost ? ' lost' : '')} data-dl-refocus onClick={fitSlide}
                title={zoomed ? 'Show the whole slide again (Ctrl+0)' : 'Back into the middle (Ctrl+0)'}>
                {lost ? `⤢ Back to slide ${current + 1}` : zoomed ? '⤢ Fit slide' : '⤢ Centre slide'}
              </button>
            )}
          </div>
          {kind === 'deck' && (notesShown ? (
            <div class="dl-notes">
              <textarea placeholder="Speaker notes" value={notesDraft && curSlidePath && notesDraft.path.join() === curSlidePath.join() ? notesDraft.text : notes} disabled={locked || !curSlidePath} data-dl-notes
                onInput={e => setNotesDraft((e.target as HTMLTextAreaElement).value)}
                onBlur={e => { const d = draftRef.current; saveNotes((e.target as HTMLTextAreaElement).value, d?.path ?? curSlidePath); setNotesDraftState(null); }} />
              <button type="button" class="dl-btn dl-notes-hide" title="Hide the speaker notes" aria-label="Hide the speaker notes" data-dl-notes-hide onMouseDown={e => e.preventDefault()} onClick={hideNotes}>▾</button>
            </div>
          ) : (
            <button type="button" class="dl-notes-show" title="Show the speaker notes" data-dl-notes-show onClick={() => setNotesShown(true)}>
              <span aria-hidden="true">▴</span> Speaker notes{notes.trim() ? <span class="dl-notes-peek"> — {notes.trim().split('\n')[0]}</span> : ''}
            </button>
          ))}
        </div>
        {objOpen && (
          <ObjectsPane slide={objects.slide} items={objects.items} sel={sel} readOnly={locked} close={() => toggleObjects(false)}
            select={paths => toCanvas({ ol: 'select', paths })} hover={p => toCanvas({ ol: 'hover', path: p })}
            rename={(p, name) => applyOps([{ t: 'attr', path: p, name: 'data-ol-name', value: name }])}
            lock={(p, on) => applyOps([{ t: 'attr', path: p, name: 'data-ol-locked', value: on ? '' : null }])}
            restack={(p, ref, front) => toCanvas({ ol: 'restack', path: p, ref, front })} />
        )}
        {animOpen && kind === 'deck' && (
          <AnimationPane seq={seq} sel={sel} readOnly={locked} close={() => toggleAnim(false)}
            send={cmd => toCanvas({ ol: 'steps', cmd })} select={p => toCanvas({ ol: 'select', paths: [p] })} />
        )}
        {reviewOpen && (
          <ReviewPane review={review} slideTitles={slides.map(s => s.title)} current={current} kind={kind} me={me} canEdit={!locked}
            focus={focus} draft={draft} submitDraft={submitDraft} cancelDraft={() => setDraft(null)} select={showOnCanvas}
            reply={replyTo} resolve={resolveThread} remove={removeThread}
            accept={c => resolveChange(c, true)} reject={c => resolveChange(c, false)}
            acceptAll={() => resolveEverything(true)} rejectAll={() => resolveEverything(false)}
            close={() => { setReviewOpen(false); setDraft(null); setFocus(null); }} />
        )}
        {codeOpen && (
          <div class="dl-code">
            <div class="dl-code-head"><span>{path.split('/').pop()}</span><button class="dl-btn" onClick={() => setCodeOpen(false)} title="Close">×</button></div>
            <textarea ref={codeRef} spellcheck={false} readOnly={locked} onInput={onCodeInput} data-dl-codearea
              onKeyDown={e => { if (e.key === 'Tab') { e.preventDefault(); document.execCommand('insertText', false, '  '); } }} />
          </div>
        )}
      </div>
      {floatPop && <FloatPopover {...floatPop} onClose={() => setFloatPop(null)} />}
      {citeOpen && host.docId && <CiteDialog meta={CITE_META} search docId={host.docId} project={host.docId.split('/').slice(0, 2).join('/')}
        onInsert={(keys, cmd, before, after) => {
          if (!keys.length) return;
          const opt = before || after ? `[${before}][${after}]` : '';
          canvasFrame.current?.focus();
          toCanvas({ ol: 'insertRef', src: `\\${cmd}${opt}{${keys.join(',')}}` });
        }}
        onAdded={r => { bibAsked.current.delete(r.key); setTimeout(() => syncBibRef.current?.(), 500); }}
        onClose={() => setCiteOpen(false)} />}
      {mathEdit && !presenting && <MathOverlay st={mathEdit} frame={canvasFrame.current} scale={scale} typeAhead={typeAhead} invert={darkS.invert}
        onSet={tex => toCanvas({ ol: 'mathSet', id: mathEdit.id, tex })}
        onShown={() => toCanvas({ ol: 'mathShown', id: mathEdit.id })}
        onDisplay={() => toCanvas({ ol: 'mathDisplay', id: mathEdit.id })}
        onRest={keys => toCanvas({ ol: 'typeKeys', keys })} keysIn={mathKeysIn} ops={mathOps} macros={deckMacros}
        onDone={(tex, dir, putBack) => {
          const id = mathEdit.id;
          // the field stays (still) until the formula is shown again under it (the runtime's mathClose)
          setMathEdit(st => st && st.id === id ? { ...st, closing: true } : st);
          setTimeout(() => setMathEdit(st => st && st.id === id && st.closing ? null : st), 800);
          if (dir) canvasFrame.current?.focus();
          toCanvas({ ol: 'mathDone', id, tex, dir, putBack });
        }} />}
      {bgFor && <BgRemoveDialog src={bgFor.url} name={bgFor.name} onDone={b => { void saveNoBg(b); }} onClose={() => setBgFor(null)} />}
      {presenting && link && (
        <div class="dl-presenting" ref={presentBox}>
          <iframe ref={presentFrame} title="Presentation" sandbox="allow-scripts allow-popups" src={src('present') + `#${presentFrom.current + 1}`} />
        </div>
      )}
    </div>
  );
}

/** a picker opened from a context menu, where the menu was */
function FloatPopover({ x, y, title, render, onClose }: { x: number; y: number; title: string; render: (close: () => void) => ComponentChildren; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const t = setTimeout(() => { document.addEventListener('mousedown', down); }, 0);
    document.addEventListener('keydown', key);
    return () => { clearTimeout(t); document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.right > innerWidth - 8) el.style.left = `${Math.max(8, innerWidth - 8 - r.width)}px`;
    if (r.bottom > innerHeight - 8) el.style.top = `${Math.max(8, innerHeight - 8 - r.height)}px`;
  }, []);
  return (
    <div ref={ref} class="tb-popup dl-floatpop" style={{ left: `${x}px`, top: `${y}px` }} role="dialog" aria-label={title}>
      <div class="tb-popup-title">{title}</div>
      {render(onClose)}
    </div>
  );
}

export default DeliverableEditor;

/** the citation dialog's view of a deck: the project's bibliography searched on the server, natbib's commands */
const CITE_META = { bib: [], citeEngine: 'natbib' } as unknown as DocMeta;

/** the page's macros (MathJax's form) as LyX's formula editor takes them */
function macroTableOf(m: Record<string, MathJaxMacro>): MacroTable {
  const out: MacroTable = {};
  for (const [name, v] of Object.entries(m)) out[name] = typeof v === 'string' ? { nargs: 0, def: v } : { nargs: v[1], def: v[0], ...(v.length > 2 ? { nopt: 1 } : {}) };
  return out;
}
