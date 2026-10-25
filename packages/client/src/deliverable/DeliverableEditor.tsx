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
import { editSvgFile } from '../editor/svgEditorEvents';
import { Toolbar, ICONS, type ToolButton } from '../app/Toolbar';
import { ColorGrid } from '../app/ColorGrid';
import type { DeliverableHost, Peer } from './host';
import { webHost } from './webHost';
import { createLinkOpener, type LinkState } from './link-opening';
import { capturePointerDrag } from './pointerdrag';
import type { FromRuntime, ToRuntime, SelItem, SlideBox, Tool, Path, HtmlOp, DeliverableKind, Rect, ArrangeHow, Paint, CanvasView, KeyPress, Solo, ObjNode, InkRunD, WordsStyle, TextLook } from './protocol';
import { SlideView, fitScale, viewLevels, viewDetents, levelAt, levelAnchor, VIEW_FIT_NAMES, type ViewFit, type ViewLevels } from './viewport';
import { pinchFactor, pinchLock, triGesture, type PinchLock } from './gestures';
import { DetentPinch, stepOnto, type Detent, type Shown } from '../app/zoomdetent';
import { holdReload } from '../app/update';
import { zoomPill } from '../app/zoomhud';
import { CornerButton } from '../app/CornerButton';
import { keepAwake } from '../app/wakelock';
import { presentFingersDraw, savePresentFingersDraw, presentLinked, savePresentLinked } from '../app/presentkit';
import { checkedPresent, type PresentState, type PresenterState } from '../app/presentshare';
import { createPortal } from 'preact/compat';
import { isFromRuntime, RAIL_NUM } from './protocol';
import { rebasedSplices, rebaseObjectPaths, objectHtml, imageHtml, insertPlace, newSlideHtml, nextPageHtml, slideDesigns, slidePaths, slideNotes, notesOp, sourceRange, inlineSvgHtml, guidesIn } from './sourceops';
import { GUIDES_ATTR, LAYOUT_MARGINS_ATTR, layoutMarginGuides, parseGuides, masterGuides, formatGuides, withGuide, type Guide } from './guides';
import { deckMargins, deckDesign, builtInLayouts, savedLayouts, layoutFromSlide, saveLayoutOp, applyLayoutOp, placeholderObject, layoutThumb, deckColors, PH_ATTR, PH_LABELS, PH_ROLES, type PhRole, type DesignLooks, type DeckDesign, type Layout } from './decklayouts';
import { LayoutPicker, type LayoutCard } from './LayoutPicker';
import { chooseDock, touchScreen, smallScreen, dockAsked, type DeckDock } from './deckdock';
import { sizePt, stepPt } from './units';
import { deckToolbar, quickGroups, SHAPES, LINES, type DeckTextActions } from './decktoolbar';
import { setEditorMenus } from '../app/editormenus';
import type { MenuDef } from '../app/MenuBar';
import { loadDeckInk, saveDeckInk, subscribeDeckInk, patchDeckInk, deckInkStyle, type DeckInk, type DeckInkPatch } from './deckink';
import { readHandwriting, chooseReading, readingError } from './lassobar';
import { QuickBar } from './QuickBar';
import { loadTextDrafts, saveTextDrafts, draftWords, pendingDraftKey, loadPendingTextDrafts, forgetPendingTextDraft, type TextDraft } from './recovery';
import { BgRemoveDialog } from './BgRemoveDialog';
import { MathOverlay, type MathEditState, type MathOps } from './MathOverlay';
import { AnimationPane, type Sequence } from './AnimationPane';
import { ObjectsPane } from './ObjectsPane';
import { CiteDialog, Dialog, uiPrompt, uiConfirm } from '../app/Dialogs';
import type { DocMeta } from '../api';
import { citedKeys, citeEntry, type CiteEntry } from '@overlyx/core/html/refs.ts';
import type { MathJaxMacro } from '@overlyx/core/html/deckextras.ts';
import type { MacroTable } from '@overlyx/core';
import { activeMathField } from '../editor/lyxmath/field';
import { mathReady } from '../editor/lyxmath/mathjax';
import { setLayoutMathFont } from '../fonts/editorfont';
import { useMathPanels } from '../app/toolbars';
import { parseSource, opSplices, elementAt, elementChildren, attr, parseStyle, sourcePatch, applySplices as applyTextSplices, type SourcePatch } from '@overlyx/core/html/source.ts';
import { followUps, composeSplices, twinsOf, putOnEverySlide, otherCopies, slideNumberOps, lookAlikeOps, similarTexts, MASTER_ATTR, SKIP_ATTR } from './deckmaster';
import { reviewOps, resolveOps, resolveAll, reviewOf, isSuggesting, suggestingOp, stampOf, threadsOp, parseThreads, newThreadId, describe as describeObject, COMMENTS, type ReviewChange, type ReviewThread, type Thread } from '@overlyx/core/html/review.ts';
import { deliverableInfo, slideElements, blankDeck, untouchedPageTitle } from '@overlyx/core/html/deliverable.ts';
import { usualDeckSize } from '../app/decksize';
import { formatTimestamp } from '@overlyx/core';
import { ReviewPane, type CommentDraft } from './ReviewPane';
import { EditModeSwitch, modeScope, setOwnSuggesting, suggestingFor, switchModeScope, type EditMode, type ModeScope } from '../app/EditModeSwitch';
import { useDarkPagesState, toggleDarkPages, invertedColor, deskBeside, DARK_DESK } from '../app/darkpages';
import { recordReliability, recordInteraction } from '../usage';
import { reportJump, reportPalm } from '../glitches';
import { DrawPalette } from './drawpalette';
import { notePenStroke } from '../app/promotion';
import { canvasInteraction, type InteractionOutcome } from '@overlyx/core/interactions.ts';
import { saveReliabilityEvent } from './reliability';
import { makeReliabilityDetail, type ReliabilityEvent } from '@overlyx/core/reliability.ts';

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
  const near = (r?: Rect, q?: Rect) => !r || !q ? r === q : Math.abs(r.x - q.x) < 1 && Math.abs(r.y - q.y) < 1 && Math.abs(r.w - q.w) < 1 && Math.abs(r.h - q.h) < 1;
  return a.slide === b.slide && Math.abs(a.height - b.height) < 2 && near(a.rect, b.rect) && near(a.content, b.content);
}

/** where the pen and Undo sit while drawing (CSS right / top on the canvas): inside the slide's top right corner, on the canvas when that is off it */
function focusSpot(p: { tx: number; ty: number; s: number }, r: Rect, box: { w: number; h: number }): { right: number; top: number } {
  const x = Math.min(box.w - 8, p.tx + (r.x + r.w) * p.s - 8), y = Math.max(8, p.ty + r.y * p.s + 8);
  return { right: Math.max(8, box.w - x), top: y };
}

/** the zoom menu's percentages (of the slide's own size) */
const DECK_ZOOMS = [50, 75, 100, 150, 200];

/** the room at each side of the canvas the slide is not fitted into (screen px) */
type Inset = { t: number; r: number; b: number; l: number };
const NO_INSET: Inset = { t: 0, r: 0, b: 0, l: 0 };
/** how long the bars take to slide away or back while drawing (ms; styles.css ol-bars-leaving / ol-bars-back) */
const BARS_MS = 180;

/** the natural size of a picture file (null when the browser cannot decode it) */
async function naturalSize(data: Blob): Promise<{ w: number; h: number } | null> {
  try { const b = await createImageBitmap(data); const r = { w: b.width, h: b.height }; b.close?.(); return r; } catch { return null; }
}

type Notify = (text: string, kind?: 'info' | 'error') => void;

/** the value once it has stayed for `ms` (the first at once) — and, while `busy` says so, not before that is over */
function useSettled<T>(v: T, ms: number, busy?: () => boolean): T {
  const [settled, setSettled] = useState(v);
  useEffect(() => {
    if (v === settled) return;
    let t: ReturnType<typeof setTimeout>;
    const done = () => { if (busy?.()) t = setTimeout(done, ms); else setSettled(v); };
    t = setTimeout(done, ms);
    return () => clearTimeout(t);
  }, [v]);
  return settled;
}

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
/** what a held stroke became, said for a moment (core/shapesnap.ts SnapKind) */
const SNAP_NAMES: Record<string, string> = { line: 'Line', arrow: 'Arrow', polyline: 'Lines', triangle: 'Triangle', rect: 'Rectangle', square: 'Square', quad: 'Four-sided shape', polygon: 'Polygon', ellipse: 'Ellipse', circle: 'Circle' };

export function DeliverableEditor({ id, user, notify }: { id: string; user: User; notify: Notify }) {
  const host = useMemo(() => webHost(id, user), [id]);
  useEffect(() => () => host.destroy(), [host]);
  return <DeliverableCanvas key={id} host={host} notify={notify} />;
}

/** The editor around the page, wherever it runs (`host`: the web app's, the VS Code extension's). */
export function DeliverableCanvas({ host, notify, chrome }: { host: DeliverableHost; notify: Notify; chrome?: ComponentChildren }) {
  const path = host.path;
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const [, bump] = useState(0);
  const rerender = () => bump(t => t + 1);
  const text = { toString: () => host.text() };

  const [synced, setSynced] = useState(host.ready());
  const [online, setOnline] = useState(true);
  const [saveState, setSaveState] = useState(() => host.saveState?.() ?? null);
  const unsentText = useRef(false);
  const lastTypedDraft = useRef<string | null>(null);
  const bufferStorageWarned = useRef(false);
  const bufferedDraft = useRef<{ id: string; pending: boolean } | null>(null);
  const clearDurableBuffer = () => {
    const state = host.saveState?.();
    const buffer = bufferedDraft.current;
    if (buffer && !buffer.pending && (!state?.pending || state.localPending === false && !state.localError)) {
      forgetPendingTextDraft(recoveryKey, buffer.id); bufferedDraft.current = null;
    }
  };
  useEffect(() => {
    const off = host.onSaveState?.(() => {
      const state = host.saveState?.(); setSaveState(state ?? null);
      if (state?.state === 'stale') {
        if (lastTypedDraft.current && unsentText.current) keepDraft(lastTypedDraft.current, 'This file was replaced before this text could be saved. The older local source is still available to download.', false);
        lastTypedDraft.current = null; toCanvas({ ol: 'stopText', save: false });
      } else if (host.readOnly() && lastTypedDraft.current && (unsentText.current || state?.pending)) {
        keepDraft(lastTypedDraft.current, 'Your editing permission changed before this text was saved. Copy the draft or ask the owner to restore editing access.');
        lastTypedDraft.current = null; toCanvas({ ol: 'stopText', save: false });
      } else if (!unsentText.current && !state?.pending) lastTypedDraft.current = null;
      clearDurableBuffer();
    });
    const protect = (event: BeforeUnloadEvent) => {
      const state = host.saveState?.();
      if (unsentText.current || state?.pending && (state.localPending !== false || !!state.localError)) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', protect);
    return () => { off?.(); window.removeEventListener('beforeunload', protect); };
  }, [host]);
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
  /** Suggesting: a setting of the page (its <meta>), for everyone editing it, as in documents … */
  const pageSuggesting = useMemo(() => isSuggesting(textNow), [textNow]);
  /** … unless this person chose for themselves (the mode switch's Applies to ▸ Only me) */
  const modeKey = host.docId ?? host.path;
  const [, setOwnTick] = useState(0);
  const suggesting = suggestingFor(modeKey, pageSuggesting);
  const review = useMemo(() => reviewOf(textNow), [textNow]);
  /** the text once it has stayed a second, and the pen a while: what can wait while it is being changed (the layout margins, from all of it) */
  const settledText = useSettled(textNow, 1000, () => performance.now() - lastInkAt.current < 2500);
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
  const recoveryKey = 'ol.textRecovery:' + (host.docId ?? host.path);
  const [recovered, setRecovered] = useState<TextDraft[]>(() => [...loadTextDrafts(recoveryKey), ...loadPendingTextDrafts(recoveryKey)]);
  const recoveredRef = useRef(recovered); recoveredRef.current = recovered;
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const keepDraft = (html: string, reason: string, open = true) => {
    const previous = recoveredRef.current;
    if (!previous.some(d => d.html === html)) {
      const next = [...previous, { id: Date.now().toString(36) + Math.random().toString(36).slice(2), html, reason }];
      recoveredRef.current = next; setRecovered(next);
      if (!saveTextDrafts(recoveryKey, next)) {
        recordReliability('save.storage-warning', { context: kindRef.current });
        notify('Your recovered text is available here, but browser storage is full. Copy it before closing this tab.', 'error');
      }
    }
    if (open) setRecoveryOpen(true);
  };

  /* ------------------------------------------------------------- the frames */

  const [link, setLink] = useState<Link | null>(null);
  const [frameLink, setFrameLink] = useState<Link | null>(null);
  const [offlineDocs, setOfflineDocs] = useState<Partial<Record<'edit' | 'thumb' | 'present', string>>>({});
  const [offlineRevisions, setOfflineRevisions] = useState({ edit: 0, thumb: 0, present: 0 });
  const offlineDocsRef = useRef(offlineDocs); offlineDocsRef.current = offlineDocs;
  const currentLink = useRef(link); currentLink.current = link;
  const [linkState, setLinkState] = useState<LinkState>('opening');
  const [canvasState, setCanvasState] = useState<'opening' | 'ready' | 'failed'>('opening');
  const canvasOpeningAt = useRef(Date.now());
  const canvasHadFailure = useRef(false);
  const lastSaveDiagnostic = useRef<ReturnType<typeof saveReliabilityEvent>>(null);
  const savePendingAt = useRef<number | null>(null);
  const restartOpening = useRef(false);
  const retryLink = useRef<() => void>(() => {});
  const canvasBox = useRef<HTMLDivElement>(null);
  const canvasFrame = useRef<HTMLIFrameElement>(null);
  const railBox = useRef<HTMLDivElement>(null);
  const railFrame = useRef<HTMLIFrameElement>(null);
  const presentFrame = useRef<HTMLIFrameElement>(null);
  const [kind, setKind] = useState<DeliverableKind>('deck');
  useEffect(() => {
    const event = saveReliabilityEvent(saveState);
    if (!event || event === lastSaveDiagnostic.current) return;
    lastSaveDiagnostic.current = event;
    if (event === 'save.pending' && savePendingAt.current === null) savePendingAt.current = Date.now();
    recordReliability(event, { context: kind, ...(event === 'save.saved' && savePendingAt.current !== null ? { durationMs: Date.now() - savePendingAt.current } : {}) });
    if (event === 'save.saved') savePendingAt.current = null;
  }, [host, saveState, kind]);
  const [slides, setSlides] = useState<SlideBox[]>([]);
  /** a deck's or poster's one slide on the canvas (runtime solo.ts): the frame is sized to it and panned here (viewport.ts) */
  const [solo, setSolo] = useState<Solo | null>(null);
  const [pageW, setPageW] = useState(1280);
  const pageWRef = useRef(pageW); pageWRef.current = pageW;
  const [pageH, setPageH] = useState(0);
  const [railW, setRailW] = useState(loadRailW);
  /** the canvas' size; `box`, the part of it the slide is fitted to (below) */
  const [canvasSize, setBox] = useState({ w: 800, h: 600 });
  /**
   * The room the bars left as drawing put them away (screen px at each side of the canvas): the slide
   * stays in the part it had, as big as it was, and the canvas grows round it (the user, 23 Oct 2026:
   * the slide zooming in as one began to draw was confusing). None once they are back.
   */
  const [inset, setInset] = useState(NO_INSET);
  const box = { w: Math.max(1, canvasSize.w - inset.l - inset.r), h: Math.max(1, canvasSize.h - inset.t - inset.b) };
  const [railH, setRailH] = useState(600);
  const [zoom, setZoom] = useState(1);
  /** the frame's left edge when it is wider than the canvas (zoomed in): panned sideways */
  const [panX, setPanX] = useState(0);
  const [scrollY, setScrollY] = useState(0);
  const scrollRef = useRef(0);
  const [view, setViewState] = useState<CanvasView>(() => loadView(host.path));
  // the dark theme: a dark grey canvas unless one was chosen; the slides light on dark with smart invert (app/darkpages.ts)
  const darkS = useDarkPagesState();
  const darkRef = useRef(darkS); darkRef.current = darkS;
  // (a web page has no canvas around it: the desk would be its own background — black words on dark grey; smart invert darkens it instead)
  /**
   * The canvas as shown, and as the frame paints round the slide: what was chosen; else, beside slides,
   * the dark theme's — or the page's own, a shade apart from the slides' when it is all but theirs (their
   * edges show: deskBeside).
   */
  const shownView = (v: CanvasView): CanvasView => {
    if (kindRef.current === 'page' || v.desk !== null || v.deskChecker) return v;
    if (darkRef.current.dark) return { ...v, desk: DARK_DESK };
    const c = colorsRef.current, apart = c ? deskBeside(c.desk, c.page) : null;
    return c && apart !== c.desk ? { ...v, desk: apart } : v;
  };
  const [colors, setColors] = useState<{ desk: string; page: string } | null>(null);
  const colorsRef = useRef(colors); colorsRef.current = colors;
  // (the page's colours known: the canvas a shade apart from the slides, if need be — the frame too)
  useEffect(() => { if (colors) toCanvas({ ol: 'view', view: shownView(viewRef.current) }); }, [colors?.desk, colors?.page]);
  const [floatPop, setFloatPop] = useState<{ x: number; y: number; title: string; render: (close: () => void) => ComponentChildren } | null>(null);
  const [cropping, setCropping] = useState<Path | null>(null);
  const [bgFor, setBgFor] = useState<{ url: string; name: string; imgPath: Path; src: string } | null>(null);
  /** where the next scale is anchored (a pinch: the point under the fingers stays put) */
  const anchorRef = useRef<{ docY: number; screenY: number } | null>(null);
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [current, setCurrent] = useState(0);
  const [sel, setSel] = useState<SelItem[]>([]);
  const canvasSelection = useRef<{ version: number; items: SelItem[] }>({ version: 0, items: [] });
  /** something selected is being dragged on the canvas (the quick menu steps aside) */
  const [dragging, setDragging] = useState(false);
  const [editingText, setEditingText] = useState<Path | null>(null);
  /** the words selected in the text being retyped (the quick menu sits over them), or being chosen with the pointer */
  const [words, setWords] = useState<{ rect: Rect | null; style?: WordsStyle; choosing?: boolean } | null>(null);
  const editingTextRef = useRef(false); editingTextRef.current = !!editingText;
  /** a formula of the text being retyped, open in LyX's formula editor (MathOverlay) */
  const [mathEdit, setMathEdit] = useState<MathEditState | null>(null);
  /** keys typed between placing a new formula and LyX's field opening on it (given to the field then) */
  const typeAhead = useRef<string[] | null>(null);
  /** a text box was just drawn and is not retyped yet: keys typed out here are passed to the frame, which types them into it (runtime drawAhead) */
  const textAhead = useRef<boolean>(false);
  const textAheadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** what Ctrl+C copies of the canvas's selection (the canvas keeps it ready: a copy is answered at once) */
  const clipRef = useRef<{ html: string; plain: string } | null>(null);
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
  const toolRef = useRef(tool); toolRef.current = tool;
  /**
   * Draw opened (its button, P, E, S): its row of pens, colours and widths shows. A Pencil that draws by
   * itself (InkStyle.penInks) does not open it: the row only comes when asked for, and folds when the
   * pen is put away (Done, Esc, V, another tool).
   */
  const [drawOpen, setDrawOpen] = useState(false);
  const drawOpenRef = useRef(drawOpen); drawOpenRef.current = drawOpen;
  /** the row folded away once something was picked in it, what was picked still in hand (Draw's button brings the row back) */
  const [drawHeld, setDrawHeld] = useState(false);
  useEffect(() => { if (tool !== 'pen' && tool !== 'eraser' && tool !== 'lasso') { setDrawOpen(false); setDrawHeld(false); } }, [tool]);
  // (the tool stays in hand, stroke after stroke, while the row is open or folded after a pick)
  const drawKept = drawOpen || drawHeld;
  const drawKeptRef = useRef(drawKept); drawKeptRef.current = drawKept;
  /** a touch screen or a phone-sized window: the toolbars go where they leave the slide biggest (deckdock.ts), and drawing hides what it does not need */
  const [touchUi, setTouchUi] = useState(() => touchScreen() || smallScreen());
  useEffect(() => { const on = () => setTouchUi(touchScreen() || smallScreen()); addEventListener('resize', on); return () => removeEventListener('resize', on); }, []);
  const touchRef = useRef(touchUi); touchRef.current = touchUi;
  /**
   * Drawing on a touch screen with everything it does not need out of the way (the user, 22 Oct 2026:
   * "when drawing, have everything unneeded disappear, similarly to Apple Notes, where we can re-expand
   * toolbars by tapping them … from the top right corner of the slides"): once a stroke is drawn, or
   * something is picked in the Draw row, the app's bars and the toolbars go (the panels opened — the
   * files, the slide rail, the notes, the panes — stay); the pen in hand waits at the slide's top right
   * corner, its tap brings the Draw row back over the canvas. Done, Esc or V puts the pen away, and all
   * of it comes back. The user, 23 Oct 2026: "it is a bit confusing how a more zoomed in view happens …
   * always make the slide snap to the boundary by default, then make the toolbars slide away and
   * reappear on tap": the slide is fitted edge to edge from the start and stays as it is while they
   * slide away (`inset`); a finger's tap while drawing brings them back, the next puts them away again
   * (Photos').
   */
  const [drawFocus, setDrawFocusState] = useState(false);
  /** drawing focus as last asked for (the state follows once the bars have slid away) */
  const focusAsked = useRef(false);
  /**
   * The slide on the whole screen, asked for by its button on a touch screen (the user, 25 Oct 2026:
   * "when on ipad, can we have a toggle that enters fullscreen mode in which the slide is edge to edge?
   * swipe to make a new slide should work as well"): the app's bars, the files, the slide rail, the
   * notes, the panes and the toolbars go; the slide is fitted edge to edge into the screen, and Undo,
   * the pens and the way back wait on its top right corner (the drawing focus' pill). Swipes turn the
   * page sideways and up and down; on past the last slide, they add one.
   */
  const [full, setFullState] = useState(false);
  /** the colours used on the slide shown (runtime notetools.ts), for the lasso's colour filter */
  const slideColors = useRef<string[]>([]);
  /** Draw: the pen's and the highlighter's presets, which of them is in hand (deckink.ts) */
  const [ink, setInkState] = useState<DeckInk>(loadDeckInk);
  const inkRef = useRef(ink); inkRef.current = ink;
  useEffect(() => subscribeDeckInk(next => { inkRef.current = next; setInkState(next); }), []);
  const setInk = (p: DeckInkPatch) => {
    const v = patchDeckInk(inkRef.current, p); inkRef.current = v; setInkState(v); saveDeckInk(v);
    // (locked open on a touch screen: the palette stays — where it goes is the user's)
    if (p.keepRow && touchRef.current) showHudRef.current('Drag the pens by their grip ⠿ to any edge of the screen', 3000);
  };
  /** the slide rail and the speaker notes, hidden or not (their « / ▾ buttons) */
  const [railShown, setRailShownState] = useState(() => loadShown('ol.deckSlides', true));
  const [notesShown, setNotesShownState] = useState(() => loadShown('ol.deckNotes', false));
  /** the guides on the slides (guides.ts): shown or not, this browser's — off at first, as PowerPoint's */
  const [guidesShown, setGuidesShown] = useState(() => { try { return localStorage.getItem('ol.deckGuides') === '1'; } catch { return false; } });
  const guidesRef = useRef(guidesShown); guidesRef.current = guidesShown;
  const showGuides = (on: boolean) => { guidesRef.current = on; setGuidesShown(on); saveShown('ol.deckGuides', on); toCanvas({ ol: 'guides', show: on }); };
  /** where the slide was last right-clicked (slide px): a guide added there */
  const menuPoint = useRef<{ x: number; y: number } | null>(null);
  /** the app's status bar: the buttons of the folded slides and notes go into its corner (none in VS Code) */
  const [cornerSlot, setCornerSlot] = useState<HTMLElement | null>(null);
  useEffect(() => { setCornerSlot(document.querySelector<HTMLElement>('[data-statusbar-slot]')); }, []);
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
  /** room past the slide's edges a slide zoomed in pans to (screen px) */
  const margin = box.w < 600 ? 12 : 32;
  /** drawing with everything else out of the way (drawFocus): on the one-slide canvas */
  const focusOn = drawFocus && soloOn && !presenting;
  /** the slide on the whole screen (`full`) */
  const fullOn = full && soloOn && !presenting;
  const fullRef = useRef(fullOn); fullRef.current = fullOn;
  /** the canvas round a fitted slide: none on a touch screen (edge to edge, as it stays while drawing), else viewport.ts fitGap */
  const gap = touchUi && soloOn ? 0 : undefined;
  const gapRef = useRef(gap); gapRef.current = gap;
  const focusRef = useRef(focusOn); focusRef.current = focusOn;
  const focusPillEl = useRef<HTMLDivElement>(null);
  // one slide: the whole of it fits (both ways), a strip of the canvas round it; a web page: its width
  const fit = soloOn
    ? fitScale(box, solo!.rect, gap)
    : Math.max(0.05, Math.min(kind === 'page' ? 1 : 2, (box.w - 24) / frameW));
  const scale = fit * zoom;
  const showRail = kind === 'deck';
  const railOpen = showRail && railShown;
  const railScale = Math.max(0.05, (railW - 20 - RAIL_NUM) / frameW);
  /**
   * The inside of the slide's layout margins (frame px; decklayouts.ts deckMargins — the template's,
   * else where the deck's objects sit): what Fit margins shows as big as the canvas takes it.
   */
  const marginBox = useMemo((): Rect | null => {
    if (!soloOn) return null;
    const r = solo!.rect;
    const m = deckMargins(settledText, { w: r.w, h: r.h }, current).sides;
    return { x: r.x + m.left, y: r.y + m.top, w: r.w - m.left - m.right, h: r.h - m.top - m.bottom };
  }, [settledText, current, soloOn, solo?.rect.x, solo?.rect.y, solo?.rect.w, solo?.rect.h]);
  const marginRef = useRef(marginBox); marginRef.current = marginBox;

  const toFrame = (f: HTMLIFrameElement | null, msg: ToRuntime) => { try { f?.contentWindow?.postMessage(msg, '*'); } catch { /* gone */ } };
  const toCanvas = (msg: ToRuntime) => toFrame(canvasFrame.current, msg);
  const toRail = (msg: ToRuntime) => toFrame(railFrame.current, msg);
  /** the rail's own colour: round the thumbnails in its frame (the dark theme's canvas while it is not laid out yet) */
  const railColor = () => { const c = railBox.current ? getComputedStyle(railBox.current).backgroundColor : ''; return c && !/^(transparent|rgba\(0, 0, 0, 0\))$/.test(c) ? c : darkRef.current.dark ? DARK_DESK : null; };
  const svgExport = useRef<{ id: number; resolve(svg: string): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> } | null>(null);
  const svgExportId = useRef(0);
  useEffect(() => {
    const off = host.bindSvgExporter?.((except?: string) => new Promise<string>((resolve, reject) => {
      if (!canvasReady.current) { reject(new Error('The drawing is still opening.')); return; }
      if (svgExport.current) { reject(new Error('The drawing is already being saved.')); return; }
      const id = ++svgExportId.current;
      const timer = setTimeout(() => { svgExport.current = null; reject(new Error('The drawing did not finish exporting. Please try again.')); }, 10000);
      svgExport.current = { id, resolve, reject, timer };
      toCanvas({ ol: 'exportSvg', id, except });
    }));
    return () => {
      off?.();
      if (svgExport.current) { clearTimeout(svgExport.current.timer); svgExport.current.reject(new Error('The drawing was closed.')); svgExport.current = null; }
    };
  }, [host]);

  // A valid link does not prove that its document and runtime actually started.
  // Watch each intentional opening; ordinary link renewal leaves drafts alone.
  useLayoutEffect(() => {
    if (!link || !synced) return;
    canvasReady.current = false;
    canvasOpeningAt.current = Date.now();
    setCanvasState('opening');
    const timer = setTimeout(() => {
      if (!canvasReady.current) {
        canvasHadFailure.current = true;
        recordReliability('canvas.timeout', { context: kindRef.current, durationMs: Date.now() - canvasOpeningAt.current });
        setCanvasState('failed');
      }
    }, 20_000);
    return () => clearTimeout(timer);
  }, [host, !!link, synced, frameLink?.base, offlineRevisions.edit]);
  const retryOpening = () => {
    recordReliability('canvas.retry', { context: kindRef.current });
    if (canvasState === 'failed') restartOpening.current = true;
    retryLink.current();
  };

  useEffect(() => host.onOfflineResources?.(urls => {
    for (const frame of [canvasFrame.current, railFrame.current, presentFrame.current]) toFrame(frame, { ol: 'assets', urls });
  }), [host]);

  /** the address of the folder; renewed before it expires */
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let offlineOpened = false, denied = false, recovering = false, opened = false;
    let waitingForSource: Promise<void> | undefined;
    let stopWaiting = () => {};
    const waitForSource = () => host.ready() ? Promise.resolve() : waitingForSource ??= new Promise<void>(resolve => {
      let off = () => {};
      const finish = () => { off(); resolve(); };
      off = host.onReady(() => { if (host.ready()) finish(); });
      stopWaiting = finish;
      if (host.ready()) finish();
    });
    const opener = createLinkOpener({
      host: { link: async () => {
        const l = await host.link();
        if (host.offlineFrame) { await waitForSource(); if (stopped) throw new Error('Opening was cancelled'); }
        const documentKind = host.ready() ? deliverableInfo(host.text()).kind : undefined;
        // A large picture appears both in the document and its asset map. Build
        // only frames that will open; unused poster/presentation snapshots can
        // otherwise retain hundreds of megabytes of encoded resources.
        const modes = documentKind === 'deck' || !documentKind ? ['edit', 'thumb'] as const : ['edit'] as const;
        const frames = await Promise.all(modes.map(mode => host.offlineFrame?.(mode, l)));
        const docs = Object.fromEntries(modes.flatMap((mode, i) => frames[i] ? [[mode, frames[i]]] : []));
        return { ...l, ...(Object.keys(docs).length ? { expires: 0 } : {}), docs, documentKind };
      } },
      onReady: l => {
        if (stopped) return;
        offlineOpened = Object.keys(l.docs).length > 0; recovering = false;
        const nextLink: Link = { base: l.base, entry: l.entry, expires: l.expires ?? 0 };
        setLink(nextLink);
        if (l.documentKind) setKind(l.documentKind);
        // Renew capability links without interrupting an active text draft.
        if (!opened || restartOpening.current) {
          if (l.docs.edit) { canvasFrame.current?.removeAttribute('sandbox'); railFrame.current?.removeAttribute('sandbox'); }
          setFrameLink(nextLink);
          setOfflineDocs(l.docs);
          setOfflineRevisions(prev => ({ edit: prev.edit + 1, thumb: prev.thumb + 1, present: prev.present + 1 }));
          restartOpening.current = false; opened = true;
        }
        const base = host.folderBase ?? new URL('.', new URL(l.entry.split('/').map(encodeURIComponent).join('/'), new URL(l.base, location.href))).href;
        for (const frame of [canvasFrame.current, railFrame.current, presentFrame.current]) toFrame(frame, { ol: 'folder', base });
        void host.offlineResources?.().then(urls => {
          if (stopped) return;
          for (const frame of [canvasFrame.current, railFrame.current, presentFrame.current]) toFrame(frame, { ol: 'assets', urls });
        }).catch(() => {});
        clearTimeout(timer);
        if (l.expires && l.expires > 0) timer = setTimeout(opener.retry, Math.max(60000, l.expires - Date.now() - 10 * 60000));
      },
      onState: state => {
        setLinkState(state);
        if (state === 'failed' || state === 'denied') canvasHadFailure.current = true;
        if (state === 'denied' && !denied) recordReliability('canvas.denied', { context: kindRef.current });
        denied = state === 'denied';
        if (state === 'failed' || denied) recovering = false;
        if (state === 'denied') clearTimeout(timer);
      },
    });
    retryLink.current = opener.retry;
    const recover = () => {
      if (offlineOpened && !denied) {
        if (!recovering) { recovering = true; opener.retry(); }
      } else opener.resume();
    };
    let wasOnline = host.online();
    const offStatus = host.onStatus(() => {
      const online = host.online();
      if (online && !wasOnline) recover();
      wasOnline = online;
    });
    window.addEventListener('online', recover);
    opener.start();
    return () => {
      stopped = true;
      stopWaiting();
      opener.stop(); clearTimeout(timer); offStatus();
      window.removeEventListener('online', recover);
      if (retryLink.current === opener.retry) retryLink.current = () => {};
    };
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
    let scanned = -1;
    const sync = () => {
      // (new citations only: versions whose patches put none in need no search of all of the text)
      const v = version.current;
      let none = scanned >= 0;
      for (let k = scanned + 1; none && k <= v; k++) { const p = patches.current.get(k); if (!p || /cite/i.test(p.html)) none = false; }
      scanned = v;
      if (none) return;
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
  /** when the last pen stroke came: while one follows another, the rail's thumbnail waits */
  const lastInkAt = useRef(-1e9);
  /**
   * each version as a patch of the one before (core sourcePatch; null: not one), while kept: a frame
   * shown a version a few before takes these instead of all of the text — a stroke added to a slide is
   * that slide's new element parsed in the frame, not the whole page (half a MB on a deck with much ink)
   */
  const patches = useRef(new Map<number, SourcePatch | null>());
  /** the version each frame was sent last */
  const sentTo = useRef({ canvas: -1, rail: -1 });
  /** the splices of the last edit made here and the text they were made on: its patch from them (else from the two texts) */
  const lastSplices = useRef<{ before: string; splices: { from: number; to: number; insert: string }[] } | null>(null);
  /** the text at the latest version for a frame: as patches of the one it was sent last, when they all are */
  const sourceMsg = (frame: 'canvas' | 'rail'): ToRuntime => {
    const v = version.current, base = sentTo.current[frame];
    sentTo.current[frame] = v;
    const list: SourcePatch[] = [];
    if (base >= 0 && base < v && v - base <= 40) for (let k = base + 1; k <= v; k++) { const p = patches.current.get(k); if (!p) { list.length = 0; break; } list.push(p); }
    return list.length ? { ol: 'source', version: v, patch: { base, list } } : { ol: 'source', version: v, html: versions.current.get(v) ?? text.toString() };
  };
  /** a render once the pen has rested a moment (strokes following one another) */
  const inkRender = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rerenderSoon = () => {
    if (inkRender.current) clearTimeout(inkRender.current);
    const wait = () => { inkRender.current = performance.now() - lastInkAt.current < 800 ? setTimeout(wait, 200) : null; if (!inkRender.current) rerender(); };
    inkRender.current = setTimeout(wait, 200);
  };
  useEffect(() => () => { if (inkRender.current) clearTimeout(inkRender.current); }, []);
  const sendSource = (now = false) => {
    const html = host.text();
    const before = versions.current.get(version.current);
    const v = ++version.current;
    versions.current.set(v, html);
    const made = lastSplices.current;
    lastSplices.current = null;
    let patch: SourcePatch | null = null;
    if (before !== undefined && before !== html) { try { patch = sourcePatch(before, html, made && made.before === before ? made.splices : undefined); } catch { patch = null; } }
    patches.current.set(v, patch);
    for (const k of versions.current.keys()) if (k < v - 40) { versions.current.delete(k); patches.current.delete(k); }
    const t = sendTimer.current;
    if (t.canvas) clearTimeout(t.canvas);
    const toC = () => { t.canvas = null; if (canvasReady.current) toCanvas(sourceMsg('canvas')); };
    if (now) toC(); else t.canvas = setTimeout(toC, 40);
    if (t.rail) clearTimeout(t.rail);
    t.rail = setTimeout(() => { t.rail = null; if (railReady.current) toRail(sourceMsg('rail')); }, performance.now() - lastInkAt.current < 1500 ? 1500 : 350);
  };

  useEffect(() => {
    const offs = [
      // (strokes following one another: the editor's own panels brought up to date once the pen rests — the frames have them at once)
      host.onChange(origin => { sendSource(origin === 'canvas'); codeSync(origin); if (origin === 'canvas' && performance.now() - lastInkAt.current < 800) rerenderSoon(); else rerender(); }),
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
  const applySplices = (splices: { from: number; to: number; insert: string }[], origin: 'canvas' | 'code' = 'canvas', separateUndo = origin === 'canvas', follow = true) => {
    if (readOnlyRef.current || !splices.length) return;
    const before = host.text();
    let all = splices;
    // what the deck's master asks for besides (deckmaster.ts): the other copies of an object on every
    // slide, the slide numbers — one undo step with the edit (not while suggesting: a suggestion is one object's)
    if (follow && origin === 'canvas' && kindRef.current !== 'page' && !isSuggesting(before)) {
      try {
        const f = followUps(before, applyTextSplices(before, splices), splices);
        if (f.splices.length) all = composeSplices(before, splices, f.splices);
        if (f.copies && !masterTold.current) { masterTold.current = true; notify('Changed on every slide that has it — it is on every slide. To change it on this slide alone, right-click it ▸ Unlink from the other slides.'); }
        // (the same bar or logo on other slides, not linked: how to change them all, once)
        else if (!f.copies && !masterTold.current && !twinsTold.current) {
          const n = twinsOf(before, splices);
          if (n) { twinsTold.current = true; notify(`The same object is on ${n} other slide${n === 1 ? '' : 's'}. To make ${n === 1 ? 'that one' : 'them'} like this one and change them all at once from now on: right-click it ▸ Put on every slide.`); }
        }
      } catch (e) { console.warn('deck master', e); }
    }
    lastSplices.current = { before, splices: all };
    host.apply(all, origin, separateUndo);
    lastSplices.current = null;
  };
  /** the first change that reached the other slides: said once */
  const masterTold = useRef(false);
  const twinsTold = useRef(false);
  const similarCache = useRef<{ t: string; p: string; n: number } | null>(null);

  /** who and when, while suggesting (null: edits are direct) */
  const suggestStamp = () => (suggestingFor(modeKey, isSuggesting(text.toString())) ? stampOf(me) : null);

  /**
   * operations on the current text (from this side: the toolbar, the rail's menu) — while suggesting
   * made suggestions (core reviewOps); `raw`: as they are (comments, accepting / rejecting, notes)
   */
  const recordOps = (ops: HtmlOp[], outcome: InteractionOutcome) => {
    // A sandboxed canvas cannot bubble UI events to the shell. Only operation kinds cross into
    // diagnostics here: never HTML, element paths, style values, text, coordinates or IDs.
    for (const action of new Set(ops.map(op => canvasInteraction(op.t)))) if (action) recordInteraction(action, outcome, { target: 'canvas', access: outcome === 'denied' ? 'view' : 'edit' });
  };
  const applyOps = (ops: HtmlOp[], raw = false): boolean => {
    if (readOnlyRef.current || host.readOnly()) { recordOps(ops, 'denied'); notify('You can only view this page.', 'error'); return false; }
    const cur = text.toString();
    const src = parseSource(cur);
    try {
      const sp = (raw ? ops : reviewOps(src, ops, suggestStamp())).flatMap(op => opSplices(src, op));
      applySplices(sp);
      recordOps(ops, text.toString() === cur ? 'unchanged' : 'changed');
      return true;
    } catch (e) { recordOps(ops, 'failed'); notify(String((e as Error).message ?? e), 'error'); return false; }
  };

  /** operations the canvas made on version `v` */
  const applyRuntimeOps = (v: number, ops: HtmlOp[]): boolean => {
    if (readOnlyRef.current || host.readOnly()) {
      recordOps(ops, 'denied');
      const typing = ops.filter((op): op is Extract<HtmlOp, { t: 'inner' }> => op.t === 'inner' && op.before !== undefined);
      const stale = host.saveState?.()?.state === 'stale';
      for (const op of typing) keepDraft(op.html, stale ? 'This file was replaced before this text could be saved. The older local source is still available to download.' : 'Your editing permission changed before this text was saved.', !stale);
      if (typing.length) toCanvas({ ol: 'stopText', save: false });
      notify('You can only view this page.', 'error'); sendSource(true); return false;
    }
    const base = versions.current.get(v);
    const cur = text.toString();
    if (base === undefined) {
      recordOps(ops, 'conflict');
      for (const op of ops) if (op.t === 'inner' && op.before !== undefined) keepDraft(op.html, 'The page changed before this edit could be applied.');
      toCanvas({ ol: 'stopText', save: false });
      sendSource(true);
      notify('The page changed meanwhile. Your text is available in Recover text.', 'error'); return false;
    }
    let reviewed: HtmlOp[];
    // (a guide moved is no suggestion: guides are the editor's, not the slides')
    if (ops.every(o => o.t === 'attr' && o.name === GUIDES_ATTR)) reviewed = ops;
    else try { reviewed = reviewOps(parseSource(base), ops, suggestStamp()); } catch { reviewed = ops; }
    const sp = rebasedSplices(base, cur, reviewed);
    if (!sp) {
      recordOps(ops, 'conflict');
      const typing = ops.filter((op): op is Extract<HtmlOp, { t: 'inner' }> => op.t === 'inner' && op.before !== undefined);
      for (const op of typing) keepDraft(op.html, 'Your changes overlap with another edit, or the original box was removed. The latest saved version was kept.');
      if (typing.length) toCanvas({ ol: 'stopText', save: false });
      notify(typing.length ? 'The latest version was kept. Your draft is available in Recover text.' : 'Somebody changed that object meanwhile — try again.', 'error');
      sendSource(true); return false;
    }
    // Text input can share its recent typing group. A paste, transform, group or
    // other discrete gesture must not consume its neighbour when undone.
    applySplices(sp, 'canvas', !ops.every(op => op.t === 'inner' && op.before !== undefined));
    recordOps(ops, text.toString() === cur ? 'unchanged' : 'changed');
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
  /** the mode switch: Viewing is this editor's; Editing / Suggesting the page's setting, or this person's own (Only me) */
  const setMode = (m: EditMode) => {
    setViewing(m === 'viewing');
    if (m === 'viewing' || hostReadOnly.current) return;
    if (modeScope() === 'me') { setOwnSuggesting(modeKey, m === 'suggesting'); setOwnTick(t => t + 1); return; }
    setOwnSuggesting(modeKey, null);
    const op = suggestingOp(text.toString(), m === 'suggesting');
    if (op) applyOps([op], true);
  };
  /** Applies to: to Everyone, this person's own mode becomes the page's */
  const setModeScopeTo = (to: ModeScope) => {
    const push = switchModeScope(modeKey, to, isSuggesting(text.toString()));
    setOwnTick(t => t + 1);
    const op = push !== null && !hostReadOnly.current ? suggestingOp(text.toString(), push) : null;
    if (op) applyOps([op], true);
    notify(to === 'me' ? 'Editing or suggesting now applies to you alone' : 'Editing or suggesting now applies to everyone editing the page');
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
  /**
   * A deck reopens on the slide this person looked at last (host.lastSlide): 'asking' until the host
   * answers, then that slide until the slides are known, then 'done' — at once when they went to
   * another slide meanwhile (theirs stands). From then on the slide looked at is noted.
   */
  const backTo = useRef<'asking' | number | 'done'>(host.lastSlide ? 'asking' : 'done');
  useEffect(() => {
    let live = true;
    host.lastSlide?.().then(s => { if (live && backTo.current === 'asking') { backTo.current = s ?? 'done'; goBack(); } }, () => { if (backTo.current === 'asking') backTo.current = 'done'; });
    return () => { live = false; };
  }, [host]);
  const goBack = () => {
    const k = backTo.current;
    if (typeof k !== 'number' || !slidesRef.current.length) return;
    backTo.current = 'done';
    if (kindRef.current === 'deck' && k !== currentRef.current) gotoSlideRef.current(k);
  };
  useEffect(goBack, [slides, kind]);
  useEffect(() => {
    if (kind !== 'deck') return;
    if (backTo.current !== 'done') { if (current === 0) return; backTo.current = 'done'; }
    host.noteSlide?.(current);
  }, [current, kind, host]);
  /** when a frame last asked for a menu (the slide rail's tap or hold, a right-click on the canvas) */
  const frameMenuAt = useRef(0);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const fromCanvas = e.source === canvasFrame.current?.contentWindow;
      const fromRail = e.source === railFrame.current?.contentWindow;
      const fromPresent = e.source === presentFrame.current?.contentWindow;
      if (!fromCanvas && !fromRail && !fromPresent) return;
      if (!isFromRuntime(e.data)) return;
      const m = e.data as FromRuntime;
      if (m.ol === 'offlineBoot') {
        const mode = fromCanvas ? 'edit' : fromRail ? 'thumb' : 'present';
        const frame = fromCanvas ? canvasFrame.current : fromRail ? railFrame.current : presentFrame.current;
        const html = offlineDocsRef.current[mode];
        if (m.opaque === true && frame && html) {
          frame.setAttribute('sandbox', mode === 'edit' ? 'allow-scripts allow-modals allow-popups allow-forms' : mode === 'present' ? 'allow-scripts allow-popups' : 'allow-scripts');
          frame.contentWindow?.postMessage({ ol: 'offlineDocument', html }, '*');
        }
        return;
      }
      if (m.ol === 'ready' && host.offlineResources) {
        const frame = fromCanvas ? canvasFrame.current : fromRail ? railFrame.current : presentFrame.current;
        const source = e.source;
        void host.offlineResources().then(urls => {
          if (frame?.contentWindow === source && frame.isConnected) toFrame(frame, { ol: 'assets', urls });
        }).catch(() => {});
      }
      if (fromPresent) {
        if (m.ol === 'presentZoom') presentZoomed.current = m.zoomed;
        if (m.ol === 'exit') stopPresenting();
        if (m.ol === 'presentFingers') savePresentFingersDraw(m.on);
        if (m.ol === 'presentLinked') savePresentLinked(m.on);
        // its state for the other screens presenting the page: checked (the page's own scripts run in that frame too), then shared
        if (m.ol === 'presentShare') {
          const st = m.state === null ? null : checkedPresent(m.state, presentOut.current);
          if (st || m.state === null) { presentOut.current = st; host.setPresent?.(st); }
        }
        if (m.ol === 'visible') {
          // (its first slide shown: the frame has no storage, so the bar's "Fingers draw" and "Linked" come from here — and the other presenters as they are)
          if (!presentPrefsSent.current) {
            presentPrefsSent.current = true;
            toFrame(presentFrame.current, { ol: 'presentFingers', on: presentFingersDraw() });
            toFrame(presentFrame.current, { ol: 'presentLinked', on: presentLinked() });
            toFrame(presentFrame.current, { ol: 'presentPeers', peers: presentPeers.current });
          }
          setCurrent(canvasIndexOf(m.slide));
        }
        return;
      }
      switch (m.ol) {
        case 'exportedSvg': {
          const request = svgExport.current;
          if (fromCanvas && request?.id === m.id) {
            clearTimeout(request.timer); svgExport.current = null;
            if (m.error || !m.svg) request.reject(new Error(m.error || 'The drawing could not be exported.'));
            else request.resolve(m.svg);
          }
          break;
        }
        case 'ready':
          if (fromCanvas) {
            if (!canvasReady.current) {
              recordReliability(canvasHadFailure.current ? 'canvas.recovered' : 'canvas.ready', { context: m.kind, durationMs: Date.now() - canvasOpeningAt.current });
              canvasHadFailure.current = false;
            }
            canvasReady.current = true;
            setCanvasState('ready');
            setKind(m.kind);
            kindRef.current = m.kind;
            if (m.width) setPageW(m.width);
            if (m.height) setPageH(m.height);
            setSolo(m.solo ?? null);
            toCanvas({ ol: 'scale', scale });
            toCanvas({ ol: 'tool', tool, ink: { ...deckInkStyle(inkRef.current, pageWRef.current), penInks: inkRef.current.penInks && !readOnlyRef.current }, held: drawKeptRef.current });
            toCanvas({ ol: 'guides', show: guidesRef.current });
            toCanvas({ ol: 'view', view: shownView(viewRef.current) });
            toCanvas({ ol: 'dark', invert: darkRef.current.invert, figures: darkRef.current.figures, desk: null });
            toCanvas(reviewMsgRef.current());
            if (objOpenRef.current) toCanvas({ ol: 'objects', on: true });
            if (host.ready()) { sentTo.current.canvas = -1; toCanvas(sourceMsg('canvas')); }
            setDeckMacros(macroTableOf(m.macros ?? {}));
            if (bibKnown.current.size) toCanvas({ ol: 'bib', entries: [...bibKnown.current.values()] });
            if (peersRef.current.length) toCanvas({ ol: 'peers', peers: peersRef.current });
          } else {
            railReady.current = true;
            if (bibKnown.current.size) toRail({ ol: 'bib', entries: [...bibKnown.current.values()] });
            toRail({ ol: 'scale', scale: railScale });
            if (host.ready()) { sentTo.current.rail = -1; toRail(sourceMsg('rail')); }
            toRail({ ol: 'current', slide: currentRef.current });
            toRail({ ol: 'dark', invert: darkRef.current.invert, figures: darkRef.current.figures, desk: railColor() });
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
            // An older layout cannot acknowledge an insertion the canvas has not applied yet.
            if (p && m.version === version.current) {
              pending.current = null;
              if (p.select) toCanvas({ ol: 'select', paths: p.select });
              if (p.editText) toCanvas({ ol: 'editText', path: p.editText, selectAll: true, math: p.math });
            }
          }
          break;
        case 'selection': if (fromCanvas) {
          canvasSelection.current = { version: m.version, items: m.items };
          setSel(m.items); host.setSelection(m.items.map(i => i.path));
        } break;
        case 'caret': if (fromCanvas) host.setCaret?.(m.caret); break;
        case 'clip': if (fromCanvas) clipRef.current = m.html ? { html: m.html, plain: m.plain ?? '' } : null; break;
        case 'pasteText': if (fromCanvas) pasteText(m.version, m.slide, m.after, m.text); break;
        case 'dragging': if (fromCanvas) setDragging(m.on); break;
        case 'reliability':
          if (fromCanvas && makeReliabilityDetail(m.event, m.pointer)
            && ['gesture.cancelled', 'gesture.capture-lost', 'gesture.interrupted', 'gesture.palm-ignored'].includes(m.event)) {
            recordReliability(m.event, { pointer: m.pointer, context: kindRef.current });
          }
          break;
        case 'glitch': if (fromCanvas && m.fields?.engine === 'deck') reportJump(m.fields); break;
        case 'palm': if (fromCanvas && Number.isFinite(m.contact)) reportPalm({ engine: 'deck', contact: m.contact, contactH: m.contactH, frameScale: m.scale }); break;
        case 'penRate': if (fromCanvas && Number.isFinite(m.moves) && Number.isFinite(m.frames)) notePenStroke({ moves: m.moves, frames: m.frames }); break;
        case 'words': if (fromCanvas) setWords(m.rect || m.choosing ? { rect: m.rect, style: m.style, choosing: m.choosing } : null); break;
        case 'editing':
          if (!fromCanvas) break;
          setEditingText(m.path);
          editingTextRef.current = !!m.path;
          if (!m.path) { setMathEdit(null); setWords(null); }
          // the new text box is being retyped: what was typed meanwhile goes into it
          if (m.path) textAhead.current = false;
          break;
        case 'recoveredText': if (fromCanvas) keepDraft(m.html, m.reason); break;
        case 'textPending':
          if (!fromCanvas) break;
          unsentText.current = m.on === true;
          if (m.on && typeof m.html === 'string') {
            lastTypedDraft.current = m.html;
            const buffer = bufferedDraft.current ?? { id: crypto.randomUUID(), pending: true };
            buffer.pending = true; bufferedDraft.current = buffer;
            if (!saveTextDrafts(pendingDraftKey(recoveryKey, buffer.id), [{ id: buffer.id, html: m.html, reason: 'This text edit was interrupted before it finished saving.' }])) {
              if (!bufferStorageWarned.current) {
                recordReliability('save.storage-warning', { context: kindRef.current });
                notify('Browser storage is full. Keep this tab open until Saved appears.', 'error');
              }
              bufferStorageWarned.current = true;
            } else bufferStorageWarned.current = false;
          } else if (bufferedDraft.current) {
            bufferedDraft.current.pending = false; clearDurableBuffer();
          }
          break;
        case 'mathEdit': if (fromCanvas) setMathEdit({ id: m.id, tex: m.tex, display: m.display, box: m.box, color: m.color, at: m.at, where: m.where, dollar: m.dollar }); break;
        case 'mathKeys': if (fromCanvas) mathKeysIn.current?.(m.id, m.keys); break;
        case 'mathRect': if (fromCanvas) setMathEdit(st => st && st.id === m.id ? { ...st, box: m.box } : st); break;
        case 'mathClose': if (fromCanvas) setMathEdit(st => m.id === undefined || st?.id === m.id ? null : st); break;
        case 'visible': if (fromCanvas && m.slide >= 0) { setCurrent(m.slide); toRail({ ol: 'current', slide: m.slide }); } break;
        case 'goto': setCurrent(m.slide); toCanvas({ ol: 'scrollTo', slide: m.slide, smooth: false }); toRail({ ol: 'current', slide: m.slide }); break;
        case 'ops': {
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
        case 'draw': onDraw(m.version, m.tool, m.slide, m.rect, m.after ?? null, m.pts, m.runs ? { d: '', closed: false, runs: m.runs } : m.d !== undefined ? { d: m.d, closed: !!m.closed } : undefined, m.scratch, m.snap); break;
        // the Pencil drew with Select in hand: the pen for its stroke, then Select again — the Draw row stays as it was
        case 'penInks': if (fromCanvas && !drawKeptRef.current) setToolState(m.done ? 'select' : 'pen'); break;
        case 'toolBack': if (fromCanvas) setToolState(m.tool); break;
        case 'slideColors': if (fromCanvas) { slideColors.current = m.colors; rerender(); } break;
        case 'inkRead': if (fromCanvas) void readInk(m.as, m.lines, m.rect); break;
        case 'inkConverted': if (fromCanvas) showHud(m.count ? `${m.count === m.of ? '' : `${m.count} of ${m.of} strokes `}straightened · Undo brings ${m.count > 1 ? 'them' : 'it'} back` : 'No shape in these strokes', 1800); break;
        case 'sequence': if (fromCanvas) setSeq({ slide: m.slide, rows: m.rows, steps: m.steps, ordering: m.ordering }); break;
        case 'objects': if (fromCanvas) setObjects({ slide: m.slide, items: m.items }); break;
        case 'looks': if (fromCanvas) looksReq.current.get(m.id)?.(m.looks); break;
        // an empty picture placeholder tapped: a picture for it (fillPicture)
        case 'placeholderPicture': if (fromCanvas && !readOnlyRef.current) { phPicture.current = m.path; fileInput.current?.click(); } break;
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
          frameMenuAt.current = performance.now();
          const r = f.getBoundingClientRect();
          const s = fromRail ? railScale : scale;
          const x = r.left + m.x * s, y = r.top + m.y * s;
          menuPoint.current = fromRail ? null : m.at ?? null;
          if (fromRail) slideMenu(x, y, m.slide ?? currentRef.current);
          else if (m.on === 'canvas') canvasMenu(x, y);
          else if (m.on === 'slide' && !selRef.current.length) emptySlideMenu(x, y, m.slide ?? currentRef.current);
          // (after the selection the right-click made has come in: the menu is that object's)
          else setMenuAt({ x, y, weave: m.weave });
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
        case 'pencil': if (fromCanvas && !inkRef.current.pencil) setInk({ pencil: true }); break;
        case 'penDown': if (fromCanvas) penOnCanvas(m.down); break;
        case 'history': if (fromCanvas) historyGesture(m.redo); break;
        case 'panEnd': if (fromCanvas) slideView.release(!!m.cancel); break;
        case 'fingerTap': if (fromCanvas) fingerTap(); break;
        case 'colors': if (fromCanvas) setColors({ desk: m.desk, page: m.page }); break;
        case 'cropping': if (fromCanvas) setCropping(m.path); break;
        case 'editSvg': if (fromCanvas) { const rel = svgOf(m.src); if (rel) editSvgPicture(rel); } break;
        case 'scroll': if (fromCanvas) { scrollRef.current = m.y; setScrollY(m.y); } break;
        case 'needSource':
          if (fromCanvas && canvasReady.current) { sentTo.current.canvas = -1; toCanvas(sourceMsg('canvas')); }
          else if (fromRail && railReady.current) { sentTo.current.rail = -1; toRail(sourceMsg('rail')); }
          break;
        case 'reload': {
          canvasReady.current = canvasReady.current && !fromCanvas; if (fromRail) railReady.current = false;
          if (fromCanvas) setCanvasState('opening');
          const mode = fromCanvas ? 'edit' : 'thumb';
          if (host.offlineFrame) {
            void host.offlineFrame?.(mode, currentLink.current ?? undefined).then(doc => {
              if (doc) {
                const frame = mode === 'edit' ? canvasFrame.current : railFrame.current;
                frame?.removeAttribute('sandbox');
                setOfflineDocs(prev => ({ ...prev, [mode]: doc }));
                setOfflineRevisions(prev => ({ ...prev, [mode]: prev[mode] + 1 }));
              }
              else if (currentLink.current) setFrameLink(currentLink.current);
            }).catch(() => notify('The page could not reopen. Your source is still available in Code.', 'error'));
          } else if (currentLink.current) setFrameLink(currentLink.current);
          break;
        }
      }
    };
    addEventListener('message', onMessage);
    // (a click into a frame closes the menu — but not the tap that opened it: iPad Safari focuses the frame as the finger lifts)
    const onBlur = () => setTimeout(() => { if (document.activeElement?.tagName === 'IFRAME' && performance.now() - frameMenuAt.current > 500) closeContextMenu(); }, 0);
    addEventListener('blur', onBlur);
    return () => { removeEventListener('message', onMessage); removeEventListener('blur', onBlur); };
  });

  /* ------------------------------------------------------------- sizes, zoom and panning */

  useEffect(() => {
    let frame: number | null = null;
    let active = true;
    const measure = () => {
      frame = null;
      if (!active) return;
      const b = canvasBox.current;
      if (b) {
        const w = b.clientWidth, h = b.clientHeight;
        setBox(prev => prev.w === w && prev.h === h ? prev : { w, h });
      }
      const rb = railBox.current;
      if (rb) setRailH(Math.max(0, rb.clientHeight - RAIL_HEAD));
    };
    // A state update can mount the rail and reobserve it during this delivery.
    // Measure once in the next frame, outside ResizeObserver's delivery loop.
    const ro = new ResizeObserver(() => {
      if (active && frame === null) frame = requestAnimationFrame(measure);
    });
    if (canvasBox.current) ro.observe(canvasBox.current);
    if (railBox.current) ro.observe(railBox.current);
    return () => {
      active = false;
      ro.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  // Refs are assigned after render; depending on ref.current recreates the observer
  // during its initial size notification. Only the conditional rail mounting changes
  // the observed nodes. Keep one observer while those nodes remain mounted.
  }, [showRail, railShown]);
  const scaleRef = useRef(scale); scaleRef.current = scale;
  useEffect(() => { const anchor = anchorRef.current ?? undefined; anchorRef.current = null; toCanvas({ ol: 'scale', scale, anchor }); }, [scale]);
  // one slide on the canvas: the frame's place (viewport.ts), set outside renders
  const soloRef = useRef(soloOn); soloRef.current = soloOn;
  const viewInput = useRef<{ box: { w: number; h: number }; rect: Rect; scale: number; margin: number } | null>(null);
  viewInput.current = soloOn ? { box, rect: solo!.rect, scale, margin } : null;
  /** the ring behind a slide pulled past an edge (drawn by the view); pulled loose, Centre slide shows */
  const pullRing = useRef<HTMLDivElement>(null);
  const [slideFree, setSlideFree] = useState(false);
  /** a swipe turned the page: the next slide comes in from that side */
  const pageDir = useRef<0 | 1 | -1>(0);
  const gotoSlideRef = useRef<(i: number) => void>(() => {});
  /** a swipe on past the last slide adds one (viewport.ts addsPage): on a touch screen, in a deck that can be changed */
  const addsPage = () => touchRef.current && kindRef.current === 'deck' && !readOnlyRef.current && currentRef.current === slidesRef.current.length - 1;
  const addPageRef = useRef<() => void>(() => {});
  const showHudRef = useRef<(text: string, ms?: number) => void>(() => {});
  /** the "+" a swipe on past the last slide fills as it goes (slideView `adding`) */
  const addBadge = useRef<HTMLDivElement>(null);
  const slideView = useMemo(() => new SlideView(() => canvasFrame.current, () => viewInput.current, {
    // (a pinch's scale reaches the page as it goes: the handles keep their size on the screen)
    pull: () => pullRing.current, onFree: setSlideFree, onLive: s => { toCanvas({ ol: 'scale', scale: s }); showZoom(s); },
    // a swipe sideways: the next slide, or the one before (viewport.ts steer) — on past the last, a new one
    pages: () => kindRef.current === 'deck' && (slidesRef.current.length > 1 || addsPage()),
    addsPage: () => addsPage(),
    // (the new slide shows in the room the pull opens beyond the last one, filling in as far as it has come)
    adding: k => {
      const el = addBadge.current, f = canvasFrame.current, so = soloState.current, view = viewEl.current;
      if (!el) return;
      if (k === null || !f || !so || !view) { el.style.opacity = '0'; el.classList.remove('ready'); return; }
      const r = f.getBoundingClientRect(), vb = view.getBoundingClientRect();
      // (the frame as shown, stretched by the pull: its px on the screen)
      const sx = r.width / Math.max(1, f.offsetWidth), sy = r.height / Math.max(1, f.offsetHeight);
      const l = r.left - vb.left + so.rect.x * sx, t = r.top - vb.top + so.rect.y * sy, w = so.rect.w * sx, h = so.rect.h * sy;
      const G = 8;
      const room = { l: l + w + G, t: Math.max(G, t), w: Math.max(0, vb.width - l - w - 2 * G), h: Math.min(vb.height - G, t + h) - Math.max(G, t) };
      Object.assign(el.style, { left: `${room.l}px`, top: `${room.t}px`, width: `${room.w}px`, height: `${room.h}px`, opacity: Math.min(1, k * 5).toFixed(3) });
      // (the ring and its words in the middle of that room, never off the screen while the room is still narrow)
      const mx = Math.min(vb.width - 76, Math.max(76, room.l + room.w / 2)) - room.l, my = Math.min(vb.height - 48, Math.max(48, room.t + room.h / 2)) - room.t;
      el.style.setProperty('--mx', `${mx}px`); el.style.setProperty('--my', `${my}px`);
      el.style.setProperty('--k', Math.min(1, k).toFixed(3));
      const ready = k >= 1;
      if (ready !== el.classList.contains('ready')) {
        el.classList.toggle('ready', ready);
        const label = el.querySelector('.dl-addpage-label');
        if (label) label.textContent = ready ? 'Let go: new slide' : 'Pull for a new slide';
      }
    },
    // (the pen and Undo on the slide's corner go with it as it moves — a page turned, a pull — not only as the editor draws)
    placed: p => {
      const el = focusPillEl.current, so = soloState.current;
      if (!el || !so) return;
      const at = focusSpot(p, so.rect, boxRef.current);
      el.style.right = `${at.right}px`; el.style.top = `${at.top}px`;
    },
    onPage: dir => {
      const k = currentRef.current + dir, n = slidesRef.current.length;
      if (dir === 1 && k === n && addsPage()) { pageDir.current = 1; addPageRef.current(); return; }
      if (k < 0 || k >= n) return;
      pageDir.current = dir;
      gotoSlideRef.current(k);
      if (fullRef.current) showHudRef.current(`${k + 1} / ${n}`);
    },
  }), []);
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
      const r = (viewEl.current ?? el).getBoundingClientRect(), sc = e.scale ?? 1;
      zoomSolo(sc / last, (e.clientX ?? r.left + r.width / 2) - r.left, (e.clientY ?? r.top + r.height / 2) - r.top);
      last = sc;
    };
    const opts = { passive: false } as AddEventListenerOptions;
    for (const t of ['gesturestart', 'gesturechange']) el.addEventListener(t, on as EventListener, opts);
    return () => { for (const t of ['gesturestart', 'gesturechange']) el.removeEventListener(t, on as EventListener, opts); };
  }, [canvasBox.current]);
  useLayoutEffect(() => { if (soloOn) slideView.render(); });
  // another slide: in the middle again (the zoom stays, as in PowerPoint)
  useLayoutEffect(() => {
    if (!soloOn) return;
    const d = pageDir.current;
    pageDir.current = 0;
    if (d) slideView.enter(d); else slideView.recentre(false);
  }, [solo?.slide, soloOn]);
  /** the slide's part of the canvas (`inset`), where the frame and what goes with the slide sit */
  const viewEl = useRef<HTMLDivElement>(null);
  /** that part on the screen as the bars went away or came back: the slide stays there */
  const viewWas = useRef<DOMRect | null>(null);
  const barsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reducedMotion = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
  /**
   * Drawing focus on or off. The bars slide away first (they keep their room meanwhile), then leave it
   * to the canvas; coming back, they take it again and slide in. Either way the slide stays put.
   */
  const setDrawFocus = (on: boolean) => {
    // (the slide on the whole screen: nothing more to put away)
    if (on && fullRef.current) return;
    if (on === focusAsked.current) return;
    focusAsked.current = on;
    const html = document.documentElement;
    if (barsTimer.current) { clearTimeout(barsTimer.current); barsTimer.current = null; }
    html.classList.remove('ol-bars-back');
    const go = () => {
      barsTimer.current = null;
      viewWas.current = viewEl.current?.getBoundingClientRect() ?? null;
      setDrawFocusState(on);
    };
    if (on && !reducedMotion()) { html.classList.add('ol-bars-leaving'); barsTimer.current = setTimeout(go, BARS_MS); return; }
    html.classList.remove('ol-bars-leaving');
    go();
  };
  useEffect(() => () => { if (barsTimer.current) clearTimeout(barsTimer.current); }, []);
  /**
   * The bars gone (or back), the canvas is another size: the slide keeps the part of it it had — where
   * it was on the screen — till they come back. Set before the screen is drawn again: no jump.
   * (the app's bars go with the editor's own in one layout: one change of the canvas)
   */
  useLayoutEffect(() => {
    const html = document.documentElement;
    const back = !drawFocus && html.classList.contains('ol-draw-focus');
    html.classList.toggle('ol-draw-focus', drawFocus);
    html.classList.remove('ol-bars-leaving');
    if (back && !reducedMotion()) {
      html.classList.add('ol-bars-back');
      barsTimer.current = setTimeout(() => { barsTimer.current = null; html.classList.remove('ol-bars-back'); }, BARS_MS + 40);
    }
    const was = viewWas.current, c = canvasBox.current, v = viewEl.current;
    viewWas.current = null;
    if (!c) return;
    const r = c.getBoundingClientRect();
    const next = drawFocus && was && soloRef.current
      ? { t: Math.max(0, was.top - r.top), r: Math.max(0, r.right - was.right), b: Math.max(0, r.bottom - was.bottom), l: Math.max(0, was.left - r.left) }
      : NO_INSET;
    if (v) Object.assign(v.style, { top: `${next.t}px`, right: `${next.r}px`, bottom: `${next.b}px`, left: `${next.l}px` });
    setInset(next);
    setBox(prev => prev.w === c.clientWidth && prev.h === c.clientHeight ? prev : { w: c.clientWidth, h: c.clientHeight });
  }, [drawFocus]);
  useLayoutEffect(() => { if (soloOn) slideView.refit(); }, [box.w, box.h, solo?.rect.w, solo?.rect.h]);
  // the pen put away (another tool, Esc, V), presenting, only viewing: everything back
  useEffect(() => { if ((drawFocus || focusAsked.current) && (!(tool === 'pen' || tool === 'eraser' || tool === 'lasso') || presenting || locked || !touchUi)) setDrawFocus(false); }, [tool, presenting, locked, drawFocus, touchUi]);
  useEffect(() => () => document.documentElement.classList.remove('ol-draw-focus', 'ol-bars-leaving', 'ol-bars-back'), []);
  /**
   * A finger's tap on the slide or beside it while drawing on a touch screen (it neither draws nor
   * moves anything): the bars come back, with the Draw row open — or, back already, go away again.
   */
  const fingerTap = () => {
    if (!touchRef.current || !soloRef.current || readOnlyRef.current) return;
    const t = toolRef.current;
    if (t !== 'pen' && t !== 'eraser' && t !== 'lasso') return;
    // (locked open, the Draw row stays — and so do the bars)
    const keep = inkRef.current.keepRow;
    // (the slide on the whole screen: the Draw row on its corner, unfolded or folded)
    if (fullRef.current) { if (!keep) { const open = !drawOpenRef.current; setDrawOpen(open); setDrawHeld(!open); } return; }
    if (focusAsked.current) { setDrawOpen(true); setDrawHeld(false); setDrawFocus(false); }
    else if (!keep) { setDrawOpen(false); setDrawHeld(true); setDrawFocus(true); }
  };
  /**
   * The slide on the whole screen, or back (`full`): the browser's own full screen too where it has
   * one to ask for (Safari; a web app opened from the home screen has no bars of its own), given up
   * with it — the editor's stays when the browser leaves its own (a text typed in, a swipe from the top).
   */
  const setFull = (on: boolean) => {
    if (on) setDrawFocus(false);
    setFullState(on);
    const html = document.documentElement;
    try {
      const standalone = (navigator as { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone)').matches;
      if (on && !standalone && !document.fullscreenElement && document.fullscreenEnabled) void html.requestFullscreen?.()?.catch(() => undefined);
      else if (!on && document.fullscreenElement === html) void document.exitFullscreen().catch(() => undefined);
    } catch { /* no full screen here */ }
    // (the whole slide, edge to edge, into the room it gets)
    if (Math.abs(zoomRef.current - 1) > 0.01 || slideView.isFree()) fitSlide();
  };
  useLayoutEffect(() => { document.documentElement.classList.toggle('ol-deck-full', fullOn); }, [fullOn]);
  useEffect(() => () => {
    document.documentElement.classList.remove('ol-deck-full');
    if (document.fullscreenElement === document.documentElement) void document.exitFullscreen().catch(() => undefined);
  }, []);
  useEffect(() => { toRail({ ol: 'scale', scale: railScale }); }, [railScale]);
  // (the Bézier pen takes Enter / Esc / Backspace: the keyboard goes to the canvas)
  // (the pen draws right away only where the page can be changed)
  const inkStyle = { ...deckInkStyle(ink, pageW), penInks: ink.penInks && !locked };
  useEffect(() => { toCanvas({ ol: 'tool', tool, ink: inkStyle, held: drawKept }); if (tool === 'bezier') canvasFrame.current?.focus(); }, [tool, drawKept, inkStyle.color, inkStyle.width, inkStyle.opacity, JSON.stringify(inkStyle.nib ?? null), inkStyle.fingers, inkStyle.scribble, inkStyle.penInks, inkStyle.snap, JSON.stringify(inkStyle.eraser ?? null), JSON.stringify(inkStyle.lasso ?? null)]);
  // the rail folded away: its frame goes, and says it is ready again when it comes back
  useEffect(() => { if (!railOpen) railReady.current = false; }, [railOpen]);

  const MAX_ZOOM = 8;
  const zoomRef = useRef(zoom); zoomRef.current = zoom;
  const fitRef = useRef(fit); fitRef.current = fit;
  /**
   * The zoom while it changes (a pinch, Ctrl + wheel, − / +, Fit): said over the canvas (app/zoomhud.ts),
   * as the toolbar's figure catches up only once a pinch rests. Written straight into the element, once
   * a frame at most (the view's live scale), not a render per finger move. Held at Fit, it says Fit.
   */
  const zoomHud = useRef<HTMLDivElement>(null);
  const pill = useMemo(() => zoomPill(() => zoomHud.current), []);
  /** the level a pinch holds the slide at (said as that level, whatever the give shows) */
  const heldAt = useRef<ViewFit | null>(null);
  /** the level the view rests at: it stays that level as the canvas changes size and on another slide */
  const levelRef = useRef<ViewFit | null>('fit');
  const soloState = useRef(solo); soloState.current = solo;
  const boxRef = useRef(box); boxRef.current = box;
  /** the zoom levels of the slide shown (viewport.ts): Fit, Fit width, Fit content */
  const levelsNow = (): ViewLevels => {
    const so = soloState.current;
    return so && soloRef.current ? viewLevels(boxRef.current, so.rect, so.content ?? null, MAX_ZOOM, marginRef.current, gapRef.current) : { fit: fitRef.current };
  };
  /** a level as the zoom menu names it */
  const levelName = (k: ViewFit) => k !== 'fit' ? VIEW_FIT_NAMES[k] : host.bindSvgExporter ? 'Fit drawing' : kindRef.current === 'poster' ? 'Fit poster' : kindRef.current === 'page' ? 'Fit width' : 'Fit slide';
  const showZoom = (s: number) => {
    const l = levelsNow(), k = heldAt.current ?? levelAt(l, s);
    pill.show(k ? l[k] ?? s : s, k ? VIEW_FIT_NAMES[k] : null);
  };
  useEffect(() => () => pill.dispose(), []);
  /**
   * The levels are where a pinch stops (app/zoomdetent.ts, as the PDF viewer's fits): near one the
   * slide snaps onto it and stays there till pinched well past it, giving a little meanwhile and
   * springing back once let go; let go near one, it settles on it. A step (− / +, a mouse wheel's
   * notch) stops at them on its way.
   */
  const detents = (): Detent<ViewFit>[] => viewDetents(levelsNow());
  const newPinch = (s0: number) => new DetentPinch<ViewFit>(levelAt(levelsNow(), s0) ?? s0, s0, [0.5 * fitRef.current, MAX_ZOOM]);
  /** the scale a pinch shows: held at a level, its scale stretched by the give */
  const shownScale = (sh: Shown<ViewFit>): number => {
    if (typeof sh.zoom !== 'string') { heldAt.current = null; return sh.zoom; }
    heldAt.current = sh.zoom;
    return (levelsNow()[sh.zoom] ?? fitRef.current) * sh.stretch;
  };
  const settleRaf = useRef(0);
  useEffect(() => () => cancelAnimationFrame(settleRaf.current), []);
  /**
   * Onto level `k`: its scale, and the slide where the level shows it (viewport.ts levelAnchor: Fit
   * content puts what is on the slide in the middle) — on a short spring from where it is (`animate`),
   * else at once. The view rests at that level after.
   */
  const goToLevel = (k: ViewFit, animate: boolean) => {
    const so = soloState.current, b = boxRef.current;
    if (!so || !soloRef.current) return;
    cancelAnimationFrame(settleRaf.current);
    settleRaf.current = 0;
    if (zoomCommit.current) { clearTimeout(zoomCommit.current); zoomCommit.current = null; }
    const s1 = levelsNow()[k] ?? fitRef.current, s0 = slideView.scaleNow() ?? s1;
    const a0 = slideView.toFrame(b.w / 2, b.h / 2);
    if (!a0) return;
    const want = levelAnchor(k, so.rect, so.content ?? null, marginRef.current), a1 = { x: want.x, y: want.y ?? a0.y };
    levelRef.current = k;
    heldAt.current = k;
    const done = () => {
      settleRaf.current = 0;
      heldAt.current = null;
      commitLiveZoom(0);
      slideView.release();
    };
    const t0 = performance.now();
    const frame = () => {
      const t = animate ? Math.min(1, (performance.now() - t0) / 260) : 1, e = 1 - (1 - t) ** 3;
      slideView.placeAt(s0 * Math.pow(s1 / s0, e), a0.x + (a1.x - a0.x) * e, a0.y + (a1.y - a0.y) * e, b.w / 2, b.h / 2);
      if (t < 1) { settleRaf.current = requestAnimationFrame(frame); return; }
      done();
    };
    frame();
  };
  // the canvas or the slide changes size, another slide: a view resting at a level stays at it (this slide's, at this size)
  useLayoutEffect(() => {
    const k = levelRef.current;
    if (!soloOn || !k || k === 'fit' || heldAt.current || pinchRef.current || wheelPinch.current) return;
    goToLevel(k, false);
  }, [box.w, box.h, solo?.rect.w, solo?.rect.h, solo?.slide, soloOn]);
  /** a pinch let go: held at a level or near one, onto it on a short spring; false: it stays as it is */
  const settle = (p: DetentPinch<ViewFit>): boolean => {
    const end = p.end(detents());
    cancelAnimationFrame(settleRaf.current);
    if (!end) { heldAt.current = null; levelRef.current = null; return false; }
    goToLevel(end.zoom, true);
    return true;
  };
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
    showZoom(s1);
  };
  /** one slide on the canvas: zoom by `factor` about a canvas point (no smaller than half the fit) */
  /** a zoom the view shows (zoomTo, placeAt) becomes the editor's once it rests: not a render per wheel step or finger move */
  const zoomCommit = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commitLiveZoom = (delay: number) => {
    if (zoomCommit.current) clearTimeout(zoomCommit.current);
    zoomCommit.current = setTimeout(() => { zoomCommit.current = null; const s = slideView.scaleNow(); if (s) setZoom(s / fitRef.current); }, delay);
  };
  /** a trackpad's pinch (Ctrl + wheel, Safari's gesture) under way: its course through the zoom, where it is, the timer that ends it (no event says it ended) */
  const wheelPinch = useRef<{ p: DetentPinch<ViewFit>; x: number; y: number; timer: ReturnType<typeof setTimeout> | null } | null>(null);
  const zoomSolo = (factor: number, px: number, py: number) => {
    cancelAnimationFrame(settleRaf.current);
    // a mouse wheel's notch (a hundred px or so at once): a step, as − / +
    if (Math.abs(Math.log(factor)) >= 0.5 && !wheelPinch.current) { stepSolo(factor > 1 ? 1.25 : 1 / 1.25, px, py); return; }
    const f = fitRef.current, s0 = slideView.scaleNow() ?? f * zoomRef.current;
    let w = wheelPinch.current;
    if (!w) w = wheelPinch.current = { p: newPinch(s0), x: px, y: py, timer: null };
    w.x = px; w.y = py;
    if (w.timer) clearTimeout(w.timer);
    w.timer = setTimeout(endWheelPinch, 220);
    if (zoomCommit.current) { clearTimeout(zoomCommit.current); zoomCommit.current = null; }
    const s1 = shownScale(w.p.by(Math.log(factor), detents()));
    if (Math.abs(s1 - s0) < 1e-4 * s0) return;
    slideView.zoomTo(s1, px, py);
  };
  const endWheelPinch = () => {
    const w = wheelPinch.current;
    wheelPinch.current = null;
    if (!w) return;
    if (w.timer) clearTimeout(w.timer);
    if (!settle(w.p)) commitLiveZoom(0);
  };
  /** a step in or out about a canvas point (− / +, a mouse wheel's notch): it stops at a level on its way (and shows it as the level does) */
  const stepSolo = (factor: number, px: number, py: number) => {
    cancelAnimationFrame(settleRaf.current);
    settleRaf.current = 0;
    const f = fitRef.current, s0 = slideView.scaleNow() ?? f * zoomRef.current;
    const to = stepOnto(s0, factor, detents());
    if (typeof to.zoom === 'string') { goToLevel(to.zoom, true); return; }
    levelRef.current = null;
    const s1 = Math.max(0.5 * f, Math.min(MAX_ZOOM, to.z));
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
  const pinchRef = useRef<{ c: { x: number; y: number }[]; r: { x: number; y: number }[]; a: { x: number; y: number }; k: number; s0: number; d0: number; lock: PinchLock; p: DetentPinch<ViewFit>; raw: number; mid: { x: number; y: number } } | null>(null);
  /** two fingers down: each one's canvas point and screen point */
  const pinchStart = (c: { x: number; y: number }[], r: { x: number; y: number }[]) => {
    if (zoomCommit.current) { clearTimeout(zoomCommit.current); zoomCommit.current = null; }
    cancelAnimationFrame(settleRaf.current);
    const s0 = slideView.scaleNow() ?? scaleRef.current;
    const a = slideView.toFrame((c[0].x + c[1].x) / 2, (c[0].y + c[1].y) / 2);
    if (!a) return;
    const dc = Math.hypot(c[0].x - c[1].x, c[0].y - c[1].y), dr = Math.hypot(r[0].x - r[1].x, r[0].y - r[1].y);
    const k = dr > 8 ? Math.max(0.25, Math.min(4, dc / dr)) : 1;
    screenK.current = Math.abs(k - 1) < 0.03 ? 1 : k;
    const mid = { x: (c[0].x + c[1].x) / 2, y: (c[0].y + c[1].y) / 2 };
    pinchRef.current = { c, r, a, k, s0, d0: Math.max(1, dc), lock: pinchLock(), p: newPinch(s0), raw: s0, mid };
  };
  /** they moved: their screen points now */
  const pinchMove = (r: { x: number; y: number }[]) => {
    const g = pinchRef.current;
    if (!g || r.length < 2) return;
    const f = fitRef.current;
    const now = r.slice(0, 2).map((p, i) => ({ x: g.c[i].x + g.k * (p.x - g.r[i].x), y: g.c[i].y + g.k * (p.y - g.r[i].y) }));
    const travel = Math.hypot((r[0].x + r[1].x - g.r[0].x - g.r[1].x) / 2, (r[0].y + r[1].y - g.r[0].y - g.r[1].y) / 2);
    const z = pinchFactor(g.lock, g.d0, Math.hypot(now[0].x - now[1].x, now[0].y - now[1].y), travel);
    const raw = Math.max(0.5 * f, Math.min(MAX_ZOOM, g.s0 * z));
    // (through the levels: it stops at them)
    const s = shownScale(g.p.by(Math.log(raw / g.raw), detents()));
    g.raw = raw;
    g.mid = { x: (now[0].x + now[1].x) / 2, y: (now[0].y + now[1].y) / 2 };
    slideView.placeAt(s, g.a.x, g.a.y, g.mid.x, g.mid.y);
  };
  /** one lifted (`cancel`: a third came — undo, redo: back to where the slide was) */
  const pinchEnd = (cancel: boolean) => {
    const g = pinchRef.current;
    if (!g) return;
    pinchRef.current = null;
    if (cancel) { heldAt.current = null; slideView.placeAt(g.s0, g.a.x, g.a.y, (g.c[0].x + g.c[1].x) / 2, (g.c[0].y + g.c[1].y) / 2); }
    // held at a level, or let go near one: onto it
    else if (settle(g.p)) return;
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
  const canvasIgnoredPalms = useRef(new Set<number>());
  /** (`noTap`: a second finger came, or the pen — lifted, it is no tap) */
  const canvasGesture = useRef<{ kind: 'pan' | 'pinch' | 'tri' | 'done'; x: number; y: number; x0: number; y0: number; t0: number; moving?: boolean; noTap?: boolean } | null>(null);
  const cancelCanvasTouch = (event: Extract<ReliabilityEvent, 'gesture.cancelled' | 'gesture.capture-lost' | 'gesture.interrupted'> = 'gesture.interrupted') => {
    const ids = [...canvasFingers.current.keys()], g = canvasGesture.current;
    if (ids.length) recordReliability(event, { pointer: 'touch', context: kindRef.current });
    canvasIgnoredPalms.current.clear();
    // Clear ownership first: releasePointerCapture may synchronously report capture loss.
    canvasFingers.current.clear();
    canvasGesture.current = null;
    if (g?.kind === 'pinch') pinchEnd(true);
    else if (g?.kind === 'pan' && g.moving) slideView.release(true);
    // A canceled three-finger gesture must not become Undo/Redo when the final contact goes.
    const canvas = canvasBox.current;
    for (const id of ids) {
      try { if (canvas?.hasPointerCapture(id)) canvas.releasePointerCapture(id); } catch { /* gone */ }
    }
  };
  const cancelCanvasRef = useRef(cancelCanvasTouch); cancelCanvasRef.current = cancelCanvasTouch;
  useEffect(() => {
    const cancel = () => cancelCanvasRef.current();
    const hidden = () => { if (document.hidden) cancel(); };
    window.addEventListener('blur', cancel);
    window.addEventListener('resize', cancel);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('blur', cancel);
      window.removeEventListener('resize', cancel);
      document.removeEventListener('visibilitychange', hidden);
      cancel();
    };
  }, [tool]);
  const fingerMid = () => {
    const ps = [...canvasFingers.current.values()];
    return { x: ps.reduce((a, p) => a + p.x, 0) / ps.length, y: ps.reduce((a, p) => a + p.y, 0) / ps.length };
  };
  /** the Pencil on the slide (runtime): the hand resting beside it is the palm — what it began here is undone, and it moves nothing till the pen has lifted */
  const penState = useRef({ down: false, off: -1e9 });
  const penOnCanvas = (down: boolean) => {
    penState.current = { down, off: down ? penState.current.off : performance.now() };
    const g = canvasGesture.current;
    if (!down || !g) return;
    if (g.kind !== 'done') recordReliability('gesture.interrupted', { pointer: 'touch', context: kindRef.current });
    if (g.kind === 'pan') slideView.release(true);
    else if (g.kind === 'pinch') pinchEnd(true);
    g.kind = 'done';
    g.noTap = true;
  };
  const canvasTouch = (e: PointerEvent) => {
    if (e.pointerType !== 'touch' || !soloRef.current) return;
    // (in the slide's part of the canvas, as the view places it)
    const fingers = canvasFingers.current, box = (viewEl.current ?? canvasBox.current)?.getBoundingClientRect();
    if (!box) return;
    const at = { x: e.clientX - box.left, y: e.clientY - box.top };
    if (e.type === 'pointerdown') {
      if (e.target !== e.currentTarget && !fingers.size) return;
      e.preventDefault();
      if (penState.current.down || performance.now() - penState.current.off < 400) {
        if (!canvasIgnoredPalms.current.has(e.pointerId)) {
          canvasIgnoredPalms.current.add(e.pointerId);
          recordReliability('gesture.palm-ignored', { pointer: 'touch', context: kindRef.current });
        }
        return;
      }
      fingers.set(e.pointerId, at);
      try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* synthetic or unavailable */ }
      const g = canvasGesture.current, m = fingerMid();
      if (fingers.size === 1) canvasGesture.current = { kind: 'pan', x: at.x, y: at.y, x0: at.x, y0: at.y, t0: performance.now() };
      else if (fingers.size === 2 && g?.kind === 'pan') {
        const ps = [...fingers.values()];
        canvasGesture.current = { ...g, kind: 'pinch', noTap: true };
        pinchStart(ps, ps);
      } else if (fingers.size >= 3 && g?.kind !== 'tri' && g?.kind !== 'done') {
        if (g?.kind === 'pinch') pinchEnd(true);
        canvasGesture.current = { kind: 'tri', x: m.x, y: m.y, x0: m.x, y0: m.y, t0: performance.now() };
      }
      return;
    }
    if (e.type === 'pointerup' || e.type === 'pointercancel' || e.type === 'lostpointercapture') canvasIgnoredPalms.current.delete(e.pointerId);
    if (!fingers.has(e.pointerId)) return;
    if (e.type === 'pointercancel' || e.type === 'lostpointercapture') {
      cancelCanvasTouch(e.type === 'lostpointercapture' ? 'gesture.capture-lost' : 'gesture.cancelled'); return;
    }
    const g = canvasGesture.current;
    if (e.type === 'pointermove') {
      fingers.set(e.pointerId, at);
      if (g?.kind === 'pan') {
        // (a hand coming to rest beside the slide shifts a little: it moves nothing till it has gone 10 px)
        if (!g.moving && Math.hypot(at.x - g.x0, at.y - g.y0) < 10) return;
        if (!g.moving) { g.moving = true; g.x = at.x; g.y = at.y; return; }
        slideView.panBy(at.x - g.x, at.y - g.y); g.x = at.x; g.y = at.y;
      }
      else if (g?.kind === 'pinch') pinchMove([...fingers.values()]);
      else if (g?.kind === 'tri' && fingers.size >= 3) { const m = fingerMid(); g.x = m.x; g.y = m.y; }
      return;
    }
    // A normal lift commits; interruption above rolls back and discards every contact.
    fingers.delete(e.pointerId);
    if (g?.kind === 'pan') { if (g.moving) slideView.release(); }
    else if (g?.kind === 'pinch') pinchEnd(false);
    if (g && g.kind !== 'tri') g.kind = 'done';
    if (fingers.size) return;
    if (g?.kind === 'tri') { const h = triGesture(g.x - g.x0, g.y - g.y0, performance.now() - g.t0); if (h) historyGesture(h === 'redo'); }
    // (one finger down and up again, not moved: a tap)
    else if (g && !g.moving && !g.noTap && performance.now() - g.t0 < 400) fingerTap();
    canvasGesture.current = null;
  };
  /** three fingers (runtime): undo, redo — said for a moment on the canvas, as the gesture shows nothing itself */
  const [hud, setHud] = useState<{ text: string; n: number; ms: number } | null>(null);
  const hudTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showHud = (text: string, ms = 900) => {
    setHud(h => ({ text, n: (h?.n ?? 0) + 1, ms }));
    if (hudTimer.current) clearTimeout(hudTimer.current);
    hudTimer.current = setTimeout(() => setHud(null), ms);
  };
  showHudRef.current = (text, ms) => showHud(text, ms);
  /** the lasso's Convert to text / formula: the handwriting read by the server (its readings offered beside it when unsure), then typed in its place */
  const readInk = async (as: 'notes' | 'formula', lines: [number, number][][], rect: Rect) => {
    showHud('Reading the handwriting…', 8000);
    try {
      const readings = await readHandwriting(lines, as);
      setHud(null);
      if (!readings.length) { notify('Nothing legible in the handwriting'); return; }
      const f = canvasFrame.current, r = f?.getBoundingClientRect(), k = f && r && f.offsetWidth ? r.width / f.offsetWidth : 1;
      const text = await chooseReading(readings, (r?.left ?? 0) + rect.x * k, (r?.top ?? 0) + (rect.y + rect.h) * k + 8, as === 'formula' ? 'As a formula' : 'Typed as');
      if (text) toCanvas({ ol: 'inkTyped', text, as });
    } catch (e) { setHud(null); notify(readingError(e), 'error'); }
  };
  const historyGesture = (redo: boolean) => {
    if (readOnlyRef.current) return;
    toCanvas({ ol: 'stopText' });
    setTimeout(() => (redo ? host.redo() : host.undo()), 30);
    showHud(redo ? '↷ Redo' : '↶ Undo');
  };
  const zoomStep = (factor: number) => {
    if (soloRef.current) { const b = boxRef.current; stepSolo(factor, b.w / 2, b.h / 2); return; }
    const sc = scaleRef.current, b = boxRef.current;
    const left = leftFor(sc, panRef.current);
    const cx = (b.w / 2 - left) / sc, cy = b.h / 2 / sc;
    zoomAbout(factor, cx, cy, scrollRef.current + cy);
  };
  /** the zoom menu: a level, or a percentage of the slide's own size (about the canvas' middle) */
  const chooseZoom = (v: string) => {
    if (v === 'fit') { fitSlide(); return; }
    if (v in VIEW_FIT_NAMES) { goToLevel(v as ViewFit, true); return; }
    const s1 = Number(v) / 100;
    if (!(s1 > 0)) return;
    const s0 = slideView.scaleNow() ?? scaleRef.current, b = boxRef.current;
    if (!soloRef.current) { zoomStep(s1 / s0); return; }
    cancelAnimationFrame(settleRaf.current);
    levelRef.current = null;
    heldAt.current = null;
    slideView.zoomTo(s1, b.w / 2, b.h / 2);
    commitLiveZoom(120);
  };
  const fitSlide = () => {
    if (zoomCommit.current) { clearTimeout(zoomCommit.current); zoomCommit.current = null; }
    cancelAnimationFrame(settleRaf.current);
    heldAt.current = null;
    levelRef.current = 'fit';
    setZoom(1);
    setPanX(0);
    showZoom(fitRef.current);
    if (soloRef.current) { slideView.recentre(true); return; }
    setTimeout(() => toCanvas({ ol: 'scrollTo', slide: currentRef.current, smooth: true }), 30);
  };

  /* ------------------------------------------------------------- the rail's width (its right edge dragged) */

  const setRail = (w: number) => {
    const v = Math.round(Math.max(RAIL_MIN, Math.min(RAIL_MAX, w)));
    setRailW(v);
    try { if (v === RAIL_W) localStorage.removeItem('ol.deckRail'); else localStorage.setItem('ol.deckRail', String(v)); } catch { /* private window */ }
  };
  const railDrag = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!railOpen) railDrag.current?.();
    return () => { railDrag.current?.(); };
  }, [railOpen]);
  const onRailGrip = (e: PointerEvent) => {
    if (e.button !== 0 || railDrag.current) return;
    e.preventDefault();
    const g = e.currentTarget as HTMLElement;
    const x0 = e.clientX, w0 = railW;
    g.classList.add('on');
    railDrag.current = capturePointerDrag(g, e,
      ev => setRailW(Math.round(Math.max(RAIL_MIN, Math.min(RAIL_MAX, w0 + ev.clientX - x0)))),
      (cancelled, ev) => {
        railDrag.current = null;
        g.classList.remove('on');
        if (cancelled || !ev) setRailW(w0);
        else setRail(w0 + ev.clientX - x0);
      });
  };

  /* ------------------------------------------------------------- the canvas around the pages */

  const viewRef = useRef(view); viewRef.current = view;
  const setView = (patch: Partial<CanvasView>) => {
    const v = { ...viewRef.current, ...patch };
    setViewState(v);
    saveView(host.path, v);
    toCanvas({ ol: 'view', view: shownView(v) });
  };
  // (beside a web page, its own colour — as it is shown: inverted with it)
  const deskCss = view.deskChecker ? CHECKER : (shownView(view).desk ?? (colors?.desk && darkS.invert && kind === 'page' ? invertedColor(colors.desk) : colors?.desk) ?? undefined);
  useEffect(() => {
    toCanvas({ ol: 'view', view: shownView(viewRef.current) });
    toCanvas({ ol: 'dark', invert: darkS.invert, figures: darkS.figures, desk: null });
    toRail({ ol: 'dark', invert: darkS.invert, figures: darkS.figures, desk: railColor() });
  }, [darkS.dark, darkS.invert, darkS.figures, kind]);

  /* ------------------------------------------------------------- tools and objects */

  const setTool = (t: Tool) => { setToolState(t); };

  const onDraw = (v: number, t: Tool, slide: Path | null, rect: Rect, after: Path | null, pts?: [number, number][], bez?: { d: string; closed: boolean; runs?: InkRunD[] }, scratch?: Path[], snap?: { kind: string; rect: Rect; runs: InkRunD[] }) => {
    // Draw: the pen stays in hand and the stroke is not selected — the next one follows (GoodNotes)
    const drawing = t === 'pen';
    if (!drawing) setToolState('select');
    if (readOnlyRef.current) return;
    // drawing on a touch screen: the Draw row folds into the pen at the corner, the rest goes too (Apple Notes')
    // — unless the row is locked open (then all of it stays)
    if (drawing && touchRef.current && drawKeptRef.current && soloRef.current && !inkRef.current.keepRow) {
      if (drawOpen) { setDrawOpen(false); setDrawHeld(true); }
      setDrawFocus(true);
    }
    if (versions.current.get(v) === undefined) return;
    if (drawing) lastInkAt.current = performance.now();
    const cur = text.toString();
    const k = kindRef.current;
    const place = insertPlace(cur, slide, after, k);
    if (!place) return;
    const html = objectHtml(t, rect, k, pageW / 1280, pts, bez, drawing ? deckInkStyle(inkRef.current, pageWRef.current) : undefined);
    if (!html) return;
    if (!applyOps([{ t: 'insert', parent: place.parent, index: place.index, html }])) return;
    if (scratch?.length) {
      // a scribble over strokes (core/scratchout.ts): they and it go, a step after it came — so the first
      // undo brings them back with the scribble as ink, in case it was drawing (OneNote)
      const moved = scratch.map(p => shiftedBy(p, place.parent, place.index));
      if (applyOps([{ t: 'remove', paths: [...moved, place.path] }])) showHud(`Scribbled out ${scratch.length} stroke${scratch.length > 1 ? 's' : ''} · Undo brings ${scratch.length > 1 ? 'them' : 'it'} back`, 2200);
      return;
    }
    if (snap && /^[a-z]+$/.test(snap.kind)) {
      // draw and hold (core/shapesnap.ts): the stroke becomes its shape a step after it came — Undo brings the stroke back as drawn
      const shaped = objectHtml('pen', snap.rect, k, pageW / 1280, undefined, { d: '', closed: false, runs: snap.runs }, deckInkStyle(inkRef.current, pageWRef.current));
      if (shaped && applyOps([{ t: 'outer', path: place.path, html: shaped.replace('<svg class="ol-ink"', `<svg class="ol-ink" data-ol-shape="${snap.kind}"`) }])) showHud(`${SNAP_NAMES[snap.kind] ?? 'Shape'} · Undo brings the stroke back`, 1400);
      return;
    }
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

  /** words pasted on the canvas: a text box with them, selected */
  const pasteText = (v: number, slide: Path | null, after: Path | null, words: string) => {
    if (readOnlyRef.current || versions.current.get(v) === undefined) return;
    const k = kindRef.current;
    const place = insertPlace(text.toString(), slide, after, k);
    if (!place) return;
    const esc = words.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, '<br>');
    const html = objectHtml('text', { x: 80, y: 80, w: 600, h: 0 }, k, pageW / 1280).replace(/>Text<\/p>$/, `>${esc}</p>`);
    if (applyOps([{ t: 'insert', parent: place.parent, index: place.index, html }])) pending.current = { select: [place.path] };
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

  const sourceSelection = (): SelItem[] => {
    const snapshot = canvasSelection.current;
    if (!snapshot.items.length) return [];
    const base = versions.current.get(snapshot.version);
    const paths = base === undefined ? null : rebaseObjectPaths(base, text.toString(), snapshot.items.map(item => item.path));
    if (!paths) {
      notify('The selected objects changed meanwhile — select them again.', 'error');
      sendSource(true); return [];
    }
    return snapshot.items.map((item, i) => ({ ...item, path: paths[i] }));
  };
  const styleSel = (set: Record<string, string | null>) => {
    const selected = sourceSelection();
    if (selected.length) applyOps(selected.map(s => ({ t: 'style', path: s.path, set })));
  };
  // (in points, as the size box shows them)
  const fontSize = (delta: number) => {
    const selected = sourceSelection();
    if (selected.length) applyOps(selected.map(s => ({ t: 'style', path: s.path, set: { 'font-size': `${stepPt(sizePt(parseFloat(s.style.fontSize) || 16), delta > 0 ? 1 : -1)}pt` } })));
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

  const removeSel = () => { const free = sourceSelection().filter(s => !s.locked); if (free.length) applyOps([{ t: 'remove', paths: free.map(s => s.path) }]); };
  const duplicateSel = () => { const selected = sourceSelection(); if (selected.length) applyOps([{ t: 'duplicate', paths: selected.map(s => s.path) }]); };

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
  /** a project path of a src written relative to the page's folder (./ and ../ resolved), null when it leaves the project */
  const resolveRel = (src: string): string | null => {
    const parts = (dir ? dir.split('/') : []);
    for (const seg of src.split('?')[0].split('#')[0].split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(decodeURIComponent(seg));
    }
    return parts.join('/');
  };
  /** a picture's src when it is an SVG drawing in the project: its project path (to edit it in the drawing editor), else null */
  const svgOf = (src: string | undefined): string | null =>
    src && host.docId && /\.svg([?#]|$)/i.test(src) && !/^([a-z]+:|\/)/i.test(src) ? resolveRel(src) : null;
  /** the documents' drawing editor (app/SvgEditor.tsx) over the deck; the picture reloads when it is saved (the project's graphics event) */
  const editSvgPicture = (rel: string) => editSvgFile(host.docId!.split('/').slice(0, 2).join('/'), rel, readOnlyRef.current);
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
    editSvg: (() => { const rel = svgOf(imagePath()?.src); return rel ? () => editSvgPicture(rel) : null; })(),
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

  // an object right-clicked: its menu once the selection it made is in (the canvas sends both at once)
  const [menuAt, setMenuAt] = useState<{ x: number; y: number; weave?: { label: string; undo: boolean } } | null>(null);
  useEffect(() => { if (menuAt) { setMenuAt(null); objectMenu(menuAt.x, menuAt.y, menuAt.weave); } }, [menuAt]);

  const objectMenu = (x: number, y: number, weave?: { label: string; undo: boolean }) => {
    if (!sel.length) { emptySlideMenu(x, y, currentRef.current); return; }
    const one = sel.length === 1 ? sel[0] : null;
    const master = kind === 'deck' && one && one.slide >= 0 && !readOnlyRef.current ? masterOps(one) : null;
    const items: MenuItem[] = [
      ...clipboardItems(),
      { sep: true },
      ...(one && one.canText ? [{ label: 'Edit text', shortcut: 'Enter', action: () => toCanvas({ ol: 'editText', path: one.path }) }] : []),
      // two shapes cross where it was right-clicked: the lower one over the upper one there, as if woven (runtime/weave.ts)
      ...(weave ? [{ label: weave.label, disabled: readOnlyRef.current, action: () => toCanvas({ ol: 'weave' }) }] : []),
      // a drawing: its points, Inkscape's node editor (the shape right-clicked, when the drawing has several)
      ...(one && (one.kind === 'svg' || one.kind === 'svgpart' || one.kind === 'line') && !one.locked ? [{ label: 'Edit points', shortcut: 'N', action: () => arrangeSel('edit-nodes') }] : []),
      ...(one && one.kind === 'image' ? [
        ...(imageTools.editSvg ? [{ label: 'Edit drawing (SVG)…', shortcut: 'double-click', action: imageTools.editSvg }] : []),
        { label: 'Crop', action: imageTools.crop },
        { label: 'Remove background', action: imageTools.removeBackground },
        { label: 'Replace picture…', action: imageTools.replace },
      ] : []),
      { label: 'Edit code', action: () => showCode() },
      // a layout's placeholder (decklayouts.ts): what goes in it, said while it is empty — or an ordinary object again
      ...(one && kind === 'deck' && one.kind !== 'ink' && one.slide >= 0 ? [{ label: 'Placeholder', sub: [
        ...PH_ROLES.map(r => ({ label: PH_LABELS[r], checked: one.ph?.role === r, disabled: readOnlyRef.current, action: () => applyOps([{ t: 'attr', path: one.path, name: PH_ATTR, value: r }]) })),
        { sep: true },
        { label: 'Not a placeholder', checked: !one.ph, disabled: readOnlyRef.current || !one.ph, action: () => applyOps([{ t: 'attr', path: one.path, name: PH_ATTR, value: null }]) },
      ] }] : []),
      { label: 'Comment', shortcut: 'Ctrl+Alt+M', disabled: readOnlyRef.current, action: () => toCanvas({ ol: 'newComment' }) },
      ...(selChange && !readOnlyRef.current ? [
        { label: `Accept suggestion (${selChange.by})`, action: () => resolveChange(selChange, true) },
        { label: 'Reject suggestion', action: () => resolveChange(selChange, false) },
      ] : []),
      { sep: true },
      { label: 'Duplicate', shortcut: 'Ctrl+D', action: duplicateSel },
      { label: 'Delete', shortcut: 'Del', disabled: sel.every(s => s.locked), action: removeSel },
      ...(master ? [{ sep: true }, ...masterItems(one!, master)] : []),
      { sep: true },
      ...arrangeItems(),
    ];
    showContextMenu(x, y, items);
  };
  /** the master's entries for an object (deckmaster.ts): on every slide, or what can be done with one that is; texts made alike */
  const masterItems = (one: SelItem, m: ReturnType<typeof masterOps>): MenuItem[] => [
    ...(one.master ? [
      { label: 'On every slide', info: true },
      { label: 'Unlink from the other slides (change it here alone)', action: m.unlink },
      { label: 'Remove from the other slides', action: m.removeOthers },
      { label: 'Delete from every slide', action: m.deleteAll },
    ] : [{ label: 'Put on every slide', action: m.on }]),
    ...(m.similar ? [{ label: `Make ${m.similar} similar text${m.similar === 1 ? '' : 's'} on other slides look like this`, action: m.lookAlike }] : []),
  ];
  /** Cut, Copy, Paste from a menu (the keys come through the clipboard events: the handlers below) */
  const clipboardCmd = (how: 'cut' | 'copy' | 'paste') => {
    if (how !== 'paste') {
      const c = clipRef.current;
      if (!c || !selRef.current.length) return;
      // (a menu's click is a gesture the browser lets copy: the copy handler below fills the clipboard)
      let done = false;
      try { done = document.execCommand('copy'); } catch { done = false; }
      if (!done) void navigator.clipboard?.write?.([new ClipboardItem({ 'text/html': new Blob([c.html], { type: 'text/html' }), 'text/plain': new Blob([c.plain], { type: 'text/plain' }) })]).catch(() => notify('The browser did not let the page copy: press Ctrl+C.'));
      if (how === 'cut') removeSel();
      return;
    }
    if (readOnlyRef.current) return;
    const keys = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘V' : 'Ctrl+V';
    const read = navigator.clipboard?.read;
    if (!read) { notify(`Press ${keys} to paste here.`); return; }
    void navigator.clipboard.read().then(async items => {
      let html = '', plain = '';
      const files: { name: string; type: string; data: ArrayBuffer }[] = [];
      for (const it of items) for (const type of it.types) {
        const b = await it.getType(type);
        if (type === 'text/html') html = await b.text();
        else if (type === 'text/plain') plain = await b.text();
        else if (type.startsWith('image/')) files.push({ name: 'pasted.' + type.split('/')[1].replace('svg+xml', 'svg'), type, data: await b.arrayBuffer() });
      }
      toCanvas({ ol: 'paste', html, plain, files });
    }).catch(() => notify(`The browser did not let the page read the clipboard: press ${keys} to paste.`));
  };
  const clipboardItems = (): MenuItem[] => [
    { label: 'Cut', shortcut: 'Ctrl+X', disabled: !sel.length || readOnlyRef.current || sel.every(s => s.locked), action: () => clipboardCmd('cut') },
    { label: 'Copy', shortcut: 'Ctrl+C', disabled: !sel.length, action: () => clipboardCmd('copy') },
    { label: 'Paste', shortcut: 'Ctrl+V', disabled: readOnlyRef.current, action: () => clipboardCmd('paste') },
  ];

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
      ...(darkRef.current.dark ? [{ label: 'Smart invert pages (dark theme)', checked: darkRef.current.invert, action: toggleDarkPages }] : []),
      { sep: true },
      { label: zoomRef.current > 1.01 ? 'Fit the slide' : 'Back to the slide', action: fitSlide },
    ];
  };
  /**
   * Guides (guides.ts): shown or not (this browser's); added where the slide was right-clicked — the
   * master's (every slide) or this slide's own —; a slide's own reset to the master's, the master's
   * made of a slide's, all reset to the slide's middle lines, or none. One undo each; never a suggestion.
   */
  const guideItems = (i: number, here: { x: number; y: number } | null): MenuItem[] => {
    const g = guidesIn(text.toString());
    const sp = g.slides[i] ?? null;
    const box = slidesRef.current[i]?.rect, w = box?.w || pageWRef.current || 1280, h = box?.h || 720;
    const master = masterGuides(g.master, w, h), own = parseGuides(sp?.own);
    // (from the toolbar: through the slide's middle)
    const at = here ?? { x: w / 2, y: h / 2 }, where = here ? ' here' : '';
    const ro = readOnlyRef.current || !g.body;
    const write = (ops: HtmlOp[]) => { if (ops.length && applyOps(ops, true)) showGuides(true); };
    const masterOp = (gs: Guide[]): HtmlOp => ({ t: 'attr', path: g.body!, name: GUIDES_ATTR, value: formatGuides(gs) });
    const ownOp = (path: Path, gs: Guide[]): HtmlOp => ({ t: 'attr', path, name: GUIDES_ATTR, value: gs.length ? formatGuides(gs) : null });
    const owned = g.slides.filter(x => x.own !== null);
    const clearOwn = owned.map(x => ownOp(x.path, []));
    const source = parseSource(text.toString());
    const templateMargins = g.body ? attr(elementAt(source.doc, g.body)!, LAYOUT_MARGINS_ATTR) : null;
    const slideMargins = sp ? attr(elementAt(source.doc, sp.path)!, LAYOUT_MARGINS_ATTR) : null;
    const editMargins = async (thisSlide: boolean) => {
      const path = thisSlide ? sp?.path : g.body;
      if (!path) return;
      const value = await uiPrompt('Layout margins', 'Fixed, non-draggable safe-area guides. Enter top/right/bottom/left (or 1–3 shorthand values), e.g. 72px 96px or 40mm. Blank disables these margins.',
        (thisSlide ? slideMargins ?? templateMargins : templateMargins) ?? '72px 96px', {
          okLabel: 'Set margins',
          validate: value => !value.trim() || layoutMarginGuides(value, w, h).length ? null : 'Enter 1–4 non-negative lengths (px, pt, mm, cm, in or %) that leave space inside the slide.',
        });
      if (value !== null) write([{ t: 'attr', path, name: LAYOUT_MARGINS_ATTR, value }]);
    };
    return [
      { label: 'Show guides', checked: guidesRef.current, action: () => showGuides(!guidesRef.current) },
      { sep: true },
      { label: 'Layout margins (every slide)…', disabled: ro, action: () => { void editMargins(false); } },
      { label: 'Layout margins (this slide)…', disabled: ro || !sp, action: () => { void editMargins(true); } },
      { label: 'Use master margins on this slide', disabled: ro || !sp || slideMargins === null, action: () => write([{ t: 'attr', path: sp!.path, name: LAYOUT_MARGINS_ATTR, value: null }]) },
      { sep: true },
      { label: `Add a vertical guide${where} (every slide)`, disabled: ro, action: () => write([masterOp(withGuide(master, { axis: 'x', at: at.x }))]) },
      { label: `Add a horizontal guide${where} (every slide)`, disabled: ro, action: () => write([masterOp(withGuide(master, { axis: 'y', at: at.y }))]) },
      { label: `Add a vertical guide${where}, this slide only`, disabled: ro || !sp, action: () => write([ownOp(sp!.path, withGuide(own, { axis: 'x', at: at.x }))]) },
      { label: `Add a horizontal guide${where}, this slide only`, disabled: ro || !sp, action: () => write([ownOp(sp!.path, withGuide(own, { axis: 'y', at: at.y }))]) },
      { sep: true },
      { label: 'Reset this slide’s guides to every slide’s', disabled: ro || !own.length, action: () => write([ownOp(sp!.path, [])]) },
      { label: 'Make this slide’s guides every slide’s', disabled: ro || !own.length, action: () => write([masterOp([...master, ...own]), ownOp(sp!.path, [])]) },
      { label: 'Reset custom guides (the slide’s middle lines)', disabled: ro || (g.master === null && !owned.length), action: () => write([{ t: 'attr', path: g.body!, name: GUIDES_ATTR, value: null }, ...clearOwn]) },
      { label: 'Remove custom guides', disabled: ro || (!master.length && !owned.length), action: () => write([masterOp([]), ...clearOwn]) },
    ];
  };
  const canvasMenu = (x: number, y: number) => showContextMenu(x, y, [
    ...canvasItems(x, y),
    ...(kind !== 'page' ? [{ sep: true }, { label: 'Guides', sub: guideItems(currentRef.current, menuPoint.current) }] : []),
  ]);
  const emptySlideMenu = (x: number, y: number, i: number) => {
    const ps = slidePaths(text.toString());
    const sp = ps[i];
    const deck = kind === 'deck', ro = readOnlyRef.current;
    showContextMenu(x, y, [
      { label: 'Paste', shortcut: 'Ctrl+V', disabled: ro, action: () => clipboardCmd('paste') },
      { sep: true },
      { label: 'Text box', action: () => insertObject('text') },
      { label: 'Picture…', action: () => { phPicture.current = null; fileInput.current?.click(); } },
      { label: kind === 'page' ? 'Comment on the page' : 'Comment on the slide', disabled: ro, action: () => startDraft(sp ?? null, i) },
      ...(kind !== 'page' ? [
        { sep: true },
        { label: deck ? 'Background colour of this slide…' : 'Background colour…', disabled: !sp || ro, action: () => pickAt(x, y, 'Slide background', close => <ColorGrid current={null} close={close} none="As the design has it" onPick={c => { if (sp) applyOps([{ t: 'style', path: sp, set: { background: c } }]); }} />) },
        ...(deck ? [
          { label: 'Background colour of every slide…', disabled: ro, action: () => pickAt(x, y, 'Background of every slide', close => <ColorGrid current={null} close={close} none="As the design has it" onPick={c => slideBackground(c, true)} />) },
          { label: 'Layout of this slide…', disabled: ro, action: () => pickAt(x, y, 'Layout of this slide', close => layoutPicker(i, close, true)) },
          { sep: true },
          { label: 'New slide', shortcut: 'Ctrl+M', action: () => newSlide(i) },
          { label: 'New slide in a layout…', action: () => pickAt(x, y, 'New slide', close => layoutPicker(i, close)) },
          { label: 'Duplicate slide', action: () => duplicateSlide(i) },
          { label: 'Skip slide (not presented)', checked: !!slidesRef.current[i]?.skipped, disabled: ro, action: () => toggleSkip(i) },
          { sep: true },
          { label: 'Slide numbers', disabled: ro, action: insertSlideNumbers },
          { label: 'Placeholder', sub: PH_ROLES.map(r => ({ label: PH_LABELS[r], disabled: ro, action: () => { void insertPlaceholder(r); } })) },
        ] : []),
        { label: 'Guides', sub: guideItems(i, menuPoint.current) },
      ] : []),
      { sep: true },
      { label: 'Canvas', sub: canvasItems(x, y) },
    ]);
  };

  /* ------------------------------------------------------------- slides */

  /** the slide `html` after slide `after`, shown */
  const insertSlide = (after: number, html: string): boolean => {
    const ps = slidePaths(text.toString());
    if (!ps.length) return false;
    const p = ps[Math.min(after, ps.length - 1)];
    const parent = p.slice(0, -1);
    if (!applyOps([{ t: 'insert', parent, index: p[p.length - 1] + 1, html }])) return false;
    const next = after + 1;
    setTimeout(() => { setCurrent(next); toCanvas({ ol: 'scrollTo', slide: next }); toRail({ ol: 'current', slide: next }); }, 150);
    return true;
  };
  /** a slide after slide `after`, in slide `like`'s design (newSlideHtml) */
  const newSlide = (after: number, blank = false, like = after) => {
    const html = newSlideHtml(text.toString(), like, blank);
    if (html) insertSlide(after, html);
  };
  /** a swipe on past the last slide: one after it, in its design (sourceops nextPageHtml), coming in from that side */
  const addPage = () => {
    const i = slidesRef.current.length - 1;
    const html = nextPageHtml(text.toString(), i);
    if (html && insertSlide(i, html)) showHud(`New slide · ${i + 2}`);
    else pageDir.current = 0;
  };
  addPageRef.current = addPage;

  /* ------------------------------------------------------------- layouts and placeholders (decklayouts.ts) */

  /** the slide's own size (px): the layouts are drawn and placed in it */
  const slideSizeNow = () => { const r = soloState.current?.rect; return r && r.w > 0 ? { w: r.w, h: r.h } : { w: pageWRef.current || 1280, h: pageH || (pageWRef.current || 1280) * 9 / 16 }; };
  const designNow = () => deckDesign(text.toString(), slideSizeNow(), currentRef.current);
  /** the answers of the canvas to `looks` (how the deck's texts look, measured there) */
  const looksReq = useRef(new Map<number, (looks: (TextLook | null)[]) => void>());
  const looksId = useRef(0);
  /** the looks of the design's texts (runtime placeholders.ts looksOf); none when the canvas does not answer soon */
  const askLooks = (d: DeckDesign): Promise<DesignLooks> => {
    const keys = ['title', 'body', 'coverTitle', 'coverSub'] as const;
    const refs = keys.map(k => d[k]);
    return new Promise(resolve => {
      if (!canvasReady.current) { resolve({}); return; }
      const id = ++looksId.current;
      const timer = setTimeout(() => { looksReq.current.delete(id); resolve({}); }, 400);
      looksReq.current.set(id, ls => {
        clearTimeout(timer);
        looksReq.current.delete(id);
        const out: DesignLooks = {};
        keys.forEach((k, i) => { if (refs[i]) out[k] = ls[i] ?? null; });
        resolve(out);
      });
      toCanvas({ ol: 'looks', id, paths: refs.map(r => r?.path ?? [-1]) });
    });
  };
  const layoutsNow = (d = designNow(), looks: DesignLooks = {}): Layout[] => [...savedLayouts(text.toString()), ...builtInLayouts(d, looks)];
  /** a layout's slide, its placeholders looking as the deck's texts do */
  const layoutHtml = async (id: string): Promise<string | null> => {
    const d = designNow();
    return layoutsNow(d, await askLooks(d)).find(l => l.id === id)?.html ?? null;
  };
  /** the layouts drawn small (LayoutPicker) */
  const layoutCards = (): LayoutCard[] => {
    const size = slideSizeNow(), look = deckColors(text.toString()), paper = colorsRef.current?.page ?? '#fff';
    return layoutsNow().map(l => ({ id: l.id, name: l.name, thumb: layoutThumb(l.html, size, look, paper), saved: !!l.saved }));
  };
  /** Apply layout: the slide made of the layout, what it had put in its placeholders (decklayouts applyLayoutOp) */
  const applyLayout = async (i: number, id: string) => {
    const html = await layoutHtml(id);
    const op = html ? applyLayoutOp(text.toString(), i, html) : null;
    if (op) applyOps([op]);
  };
  /** Save as layout: the slide kept in a <template> of the deck, new slides can take it */
  const saveAsLayout = async (i: number) => {
    const html = layoutFromSlide(text.toString(), i);
    if (!html) return;
    const n = savedLayouts(text.toString()).length;
    const name = await uiPrompt('Save as layout', 'New slides can take this slide’s layout: everything on it as it is, its placeholders empty. (A text box becomes a placeholder from its right-click menu; Placeholder in the Slide tools adds one.)', `Layout ${n + 1}`, { okLabel: 'Save layout' });
    if (!name?.trim()) return;
    const op = saveLayoutOp(text.toString(), html, name.trim());
    if (op && applyOps([op], true)) notify(`Saved the layout “${name.trim()}” — New slide ▾ offers it.`);
  };
  /** what a new slide (or, `apply`, slide `at`) can be: the layouts, like one of the deck's slides */
  const layoutPicker = (at: number, close: () => void, apply = false) => {
    const titled = (i: number) => { const t = slidesRef.current[i]?.title.trim() ?? ''; return t ? ` · ${t.length > 32 ? t.slice(0, 31) + '…' : t}` : ''; };
    const size = slideSizeNow();
    return (
      <LayoutPicker cards={layoutCards()} aspect={size.w / size.h} close={close}
        pick={id => { if (apply) void applyLayout(at, id); else void layoutHtml(id).then(html => { if (html) insertSlide(at, html); }); }}
        remove={id => { const l = savedLayouts(text.toString()).find(x => x.id === id); if (l?.saved) applyOps([{ t: 'remove', paths: [l.saved] }], true); }}
        extras={apply ? [{ label: 'Save this slide as a layout…', action: () => { void saveAsLayout(at); } }] : [
          ...slideDesigns(text.toString(), at).map(i => i === at
            ? { label: `Like this slide${titled(i)}`, shortcut: 'Ctrl+M', action: () => newSlide(at) }
            : { label: `Like slide ${i + 1}${titled(i)}`, action: () => newSlide(at, false, i) }),
          { label: 'Duplicate this slide', action: () => duplicateSlide(at) },
        ]} />
    );
  };
  /** a placeholder of `role` put on the slide shown, where the deck's layouts have one (decklayouts placeholderObject) */
  const insertPlaceholder = async (role: PhRole) => {
    if (readOnlyRef.current) return;
    const d = designNow(), looks = await askLooks(d);
    const cur = text.toString();
    const place = insertPlace(cur, slidePaths(cur)[currentRef.current] ?? null, null, kindRef.current);
    if (place && applyOps([{ t: 'insert', parent: place.parent, index: place.index, html: placeholderObject(role, d, looks) }])) pending.current = { select: [place.path] };
  };
  /** the picture placeholder a picture is being chosen for (the file input's) */
  const phPicture = useRef<Path | null>(null);
  /** a picture in a picture placeholder's place and size, filling it (PowerPoint's) */
  const fillPicture = async (path: Path, f: File) => {
    const rel = await uploadFile({ name: f.name, type: f.type, data: f });
    if (!rel) { notify(`Could not upload ${f.name}.`, 'error'); return; }
    const el = elementAt(parseSource(text.toString()).doc, path);
    if (!el || attr(el, PH_ATTR) !== 'picture') { notify('The placeholder is no longer there.', 'error'); return; }
    const st = new Map(parseStyle(attr(el, 'style') ?? '').map(d => [d.prop.toLowerCase(), d.value]));
    const geo = ['position', 'left', 'top', 'right', 'bottom', 'width', 'height', 'rotate', 'z-index'].filter(k => st.get(k)).map(k => `${k}: ${st.get(k)}`).join('; ');
    const q = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    if (applyOps([{ t: 'outer', path, html: `<img ${PH_ATTR}="picture" src="${q(rel)}" alt="" style="${q(geo + '; object-fit: cover')}">` }])) pending.current = { select: [path] };
  };
  /* ------------------------------------------------------------- the master (deckmaster.ts): on every slide, slide numbers, skipped slides */

  const masterOps = (it: SelItem | null) => ({
    on: () => {
      if (!it) return;
      const r = putOnEverySlide(text.toString(), it.path);
      if (!r || !applyOps(r.ops)) return;
      pending.current = { select: [it.path] };
      masterTold.current = true;
      notify(r.linked
        ? `Linked with the same object on ${r.linked} other slide${r.linked === 1 ? '' : 's'}: changed on one, changed on all.`
        : `On every slide now — changed on one slide, changed on all (${r.added + 1} slides).`);
    },
    unlink: () => { if (it && applyOps([{ t: 'attr', path: it.path, name: MASTER_ATTR, value: null }])) notify('This one is the slide’s own now: the other slides keep theirs.'); },
    removeOthers: () => {
      if (!it) return;
      const others = otherCopies(text.toString(), it.path);
      applyOps([{ t: 'attr', path: it.path, name: MASTER_ATTR, value: null }, ...(others.length ? [{ t: 'remove' as const, paths: others }] : [])]);
    },
    deleteAll: () => { if (it) applyOps([{ t: 'remove', paths: [it.path, ...otherCopies(text.toString(), it.path)] }]); },
    similar: it ? similarCount : 0,
    lookAlike: () => {
      if (!it) return;
      const ops = lookAlikeOps(text.toString(), it.path);
      if (!ops.length) { notify('No text like this one on the other slides.'); return; }
      if (applyOps(ops)) notify(`${ops.length} text${ops.length === 1 ? '' : 's'} on the other slides look like this one now.`);
    },
  });
  /** Insert ▸ Slide numbers: on every slide, kept right (deckmaster slideNumberOps) */
  const insertSlideNumbers = () => {
    if (readOnlyRef.current) return;
    const r = slideNumberOps(text.toString(), slideSizeNow());
    if (r.already) { notify('The slides are numbered already: their numbers follow as slides are added, moved or removed.'); return; }
    if (applyOps(r.ops)) { masterTold.current = true; notify('Slide numbers on every slide, bottom right — they follow as slides are added, moved or removed. Move or restyle one: all of them follow.'); }
  };
  /** Skip slide: not presented, not printed (PowerPoint's Hide slide, Google's Skip slide) */
  const toggleSkip = (i: number) => {
    const p = slidePaths(text.toString())[i];
    if (!p) return;
    const on = !slidesRef.current[i]?.skipped;
    if (applyOps([{ t: 'attr', path: p, name: SKIP_ATTR, value: on ? '' : null }]) && on) notify(`Slide ${i + 1} is skipped: it is not presented or printed. Skip slide again brings it back.`);
  };
  /** the background colour of the slide shown, or of every slide */
  const slideBackground = (c: string | null, every = false) => {
    const ps = slidePaths(text.toString());
    const paths = every ? ps : ps[currentRef.current] ? [ps[currentRef.current]] : [];
    if (paths.length) applyOps(paths.map(p => ({ t: 'style' as const, path: p, set: { background: c } })));
  };

  const gotoSlide = (i: number) => {
    const n = slidesRef.current.length;
    if (!n) return;
    const k = Math.max(0, Math.min(n - 1, i));
    setCurrent(k); toCanvas({ ol: 'scrollTo', slide: k }); toRail({ ol: 'current', slide: k });
  };
  gotoSlideRef.current = gotoSlide;
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
      { label: 'New slide', shortcut: 'Ctrl+M', action: () => newSlide(i) },
      // (pickers of their own, not submenus: a submenu opens on hover, which a finger does not do)
      { label: 'New slide in a layout…', action: () => pickAt(x, y, 'New slide', close => layoutPicker(i, close)) },
      { label: 'Duplicate slide', action: () => duplicateSlide(i) },
      { label: 'Skip slide (not presented)', checked: !!slides[i]?.skipped, disabled: readOnlyRef.current, action: () => toggleSkip(i) },
      { sep: true },
      { label: 'Layout of this slide…', disabled: readOnlyRef.current, action: () => pickAt(x, y, 'Layout of this slide', close => layoutPicker(i, close, true)) },
      { label: 'Save as layout…', disabled: readOnlyRef.current, action: () => { void saveAsLayout(i); } },
      { sep: true },
      { label: 'Move up', disabled: i <= 0, action: () => moveSlide(i, -1) },
      { label: 'Move down', disabled: i >= n - 1, action: () => moveSlide(i, 1) },
      { sep: true },
      { label: 'Edit code', action: () => { const p = slidePaths(text.toString())[i]; if (p) showCode(p); } },
      { label: 'Comment on the slide', disabled: readOnlyRef.current, action: () => startDraft(slidePaths(text.toString())[i] ?? null, i) },
      { label: 'Delete slide', disabled: n <= 1, action: () => deleteSlide(i) },
    ]);
  };

  /* ------------------------------------------------------------- the menu bar's menus (app/editormenus.ts) */

  /**
   * Edit, View, Insert, Slide, Format, Arrange — as PowerPoint's, Keynote's and Google Slides' menus:
   * everything the toolbars, the right-click menus and the keys do, found by its name, its key beside it
   * (the menu bar's search finds them too). Pickers open at the canvas's top left.
   */
  const deckMenus = (): MenuDef[] => {
    const ro = readOnlyRef.current || locked, deck = kind === 'deck', i = currentRef.current;
    const one = sel.length === 1 ? sel[0] : null;
    const at = () => { const r = canvasBox.current?.getBoundingClientRect(); return { x: (r?.left ?? 200) + 24, y: (r?.top ?? 120) + 12 }; };
    const pick = (title: string, render: (close: () => void) => ComponentChildren) => { const p = at(); pickAt(p.x, p.y, title, render); };
    const textOn = editingText !== null || sel.some(s => s.canText || s.text);
    const master = deck && one && one.slide >= 0 && !ro ? masterOps(one) : null;
    const menus: MenuDef[] = [
      { title: 'Edit', items: [
        { label: 'Undo', shortcut: 'Ctrl+Z', disabled: ro, action: () => { toCanvas({ ol: 'stopText' }); setTimeout(() => host.undo(), 30); } },
        { label: 'Redo', shortcut: 'Ctrl+Y', disabled: ro, action: () => { toCanvas({ ol: 'stopText' }); setTimeout(() => host.redo(), 30); } },
        { sep: true },
        ...clipboardItems(),
        { label: 'Duplicate', shortcut: 'Ctrl+D', disabled: ro || !sel.length, action: duplicateSel },
        { label: 'Delete', shortcut: 'Del', disabled: ro || !sel.length || sel.every(s => s.locked), action: removeSel },
        { label: kind === 'page' ? 'Select all' : 'Select all on the slide', shortcut: 'Ctrl+A', action: () => toCanvas({ ol: 'selectAll' }) },
        { sep: true },
        { label: 'Comment', shortcut: 'Ctrl+Alt+M', disabled: readOnlyRef.current, action: () => toCanvas({ ol: 'newComment' }) },
        { label: 'Editing', checked: !viewing && !suggesting, disabled: readOnly, action: () => setMode('editing') },
        { label: 'Suggesting', checked: !viewing && suggesting, disabled: readOnly, action: () => setMode('suggesting') },
        { label: 'Viewing', checked: viewing, action: () => setMode('viewing') },
        { sep: true },
        { label: 'Edit code', action: () => showCode() },
      ] },
      { title: 'View', items: [
        { label: deck ? 'Fit the slide' : 'Fit the page', shortcut: 'Ctrl+0', action: fitSlide },
        { label: 'Zoom in', shortcut: 'Ctrl+=', action: () => zoomStep(1.25) },
        { label: 'Zoom out', shortcut: 'Ctrl+-', action: () => zoomStep(1 / 1.25) },
        { sep: true },
        ...(deck ? [
          { label: 'Slides', checked: railShown, action: () => setRailShown(!railShown) },
          { label: 'Speaker notes', checked: notesShown, action: () => setNotesShown(!notesShown) },
          { label: 'Animation', checked: animOpen, action: () => toggleAnim() },
        ] : []),
        { label: 'Objects', checked: objOpen, action: () => toggleObjects() },
        { label: 'Comments and suggestions', checked: reviewOpen, action: () => { setReviewOpen(!reviewOpen); if (reviewOpen) { setDraft(null); setFocus(null); } } },
        { label: 'Code', checked: codeOpen, action: () => setCodeOpen(o => !o) },
        ...(kind !== 'page' ? [{ sep: true }, { label: 'Guides', sub: guideItems(i, null) }] : []),
        { label: 'Canvas', sub: canvasItems(at().x, at().y) },
      ] },
      { title: 'Insert', items: [
        { label: 'Text box', shortcut: 'T', disabled: ro, action: () => insertObject('text') },
        { label: 'Picture…', disabled: ro, action: () => { phPicture.current = null; fileInput.current?.click(); } },
        { label: 'Shape', disabled: ro, sub: SHAPES.map(s => ({ label: s.label, action: () => setTool(s.tool) })) },
        { label: 'Line', disabled: ro, sub: LINES.map(s => ({ label: s.label.replace(/:.*/, ''), action: () => setTool(s.tool) })) },
        { label: 'Drawing (pen)', shortcut: 'P', disabled: ro, action: () => { setDrawOpen(true); setDrawHeld(false); setToolState('pen'); } },
        { label: editingText ? 'Formula' : 'Formula — click on the slide', shortcut: editingText ? 'Ctrl+M' : undefined, disabled: ro, action: () => { if (editingText) toCanvas({ ol: 'insertMath', display: false }); else setTool('formula'); } },
        ...(editingText ? [
          { label: 'Link…', shortcut: 'Ctrl+K', action: insertLink },
          ...(host.docId ? [{ label: 'Citation…', shortcut: 'Ctrl+Shift+C', action: () => setCiteOpen(true) }] : []),
          { label: 'Cross-reference…', shortcut: 'Ctrl+Shift+I', action: pickReference },
        ] : []),
        { label: 'List of references — click on the slide', disabled: ro, action: () => setTool('references') },
        { label: 'Comment', shortcut: 'Ctrl+Alt+M', disabled: readOnlyRef.current, action: () => toCanvas({ ol: 'newComment' }) },
        ...(deck ? [
          { sep: true },
          { label: 'Slide numbers', disabled: ro, action: insertSlideNumbers },
          { label: 'Placeholder', disabled: ro, sub: PH_ROLES.map(r => ({ label: PH_LABELS[r], action: () => { void insertPlaceholder(r); } })) },
          { sep: true },
          { label: 'New slide', shortcut: 'Ctrl+M', disabled: ro, action: () => newSlide(i) },
          { label: 'New slide in a layout…', disabled: ro, action: () => pick('New slide', close => layoutPicker(i, close)) },
        ] : []),
      ] },
      ...(deck ? [{ title: 'Slide', items: [
        { label: 'New slide', shortcut: 'Ctrl+M', disabled: ro, action: () => newSlide(i) },
        { label: 'New slide in a layout…', disabled: ro, action: () => pick('New slide', close => layoutPicker(i, close)) },
        { label: 'Duplicate slide', disabled: ro, action: () => duplicateSlide(i) },
        { label: 'Delete slide', disabled: ro || slides.length <= 1, action: () => deleteSlide(i) },
        { label: 'Skip slide (not presented)', checked: !!slides[i]?.skipped, disabled: ro, action: () => toggleSkip(i) },
        { sep: true },
        { label: 'Layout of this slide…', disabled: ro, action: () => pick('Layout of this slide', close => layoutPicker(i, close, true)) },
        { label: 'Save as layout…', disabled: ro, action: () => { void saveAsLayout(i); } },
        { label: 'Background colour…', disabled: ro, action: () => pick('Slide background', close => <ColorGrid current={null} close={close} none="As the design has it" onPick={c => slideBackground(c)} />) },
        { label: 'Background colour of every slide…', disabled: ro, action: () => pick('Background of every slide', close => <ColorGrid current={null} close={close} none="As the design has it" onPick={c => slideBackground(c, true)} />) },
        { label: 'Slide numbers', disabled: ro, action: insertSlideNumbers },
        { sep: true },
        { label: 'Move slide up', disabled: ro || i <= 0, action: () => moveSlide(i, -1) },
        { label: 'Move slide down', disabled: ro || i >= slides.length - 1, action: () => moveSlide(i, 1) },
        { label: 'Previous slide', shortcut: 'PageUp', disabled: i <= 0, action: () => gotoSlide(i - 1) },
        { label: 'Next slide', shortcut: 'PageDown', disabled: i >= slides.length - 1, action: () => gotoSlide(i + 1) },
        { sep: true },
        { label: 'Present from this slide', shortcut: 'Shift+F5', action: () => { void startPresenting(false); } },
        { label: 'Present from the start', shortcut: 'F5', action: () => { void startPresenting(true); } },
      ] }] : []),
      ...(textOn && !ro ? [{ title: 'Format', items: [
        { label: 'Bold', shortcut: 'Ctrl+B', action: textActions.bold },
        { label: 'Italic', shortcut: 'Ctrl+I', action: textActions.italic },
        { label: 'Underline', shortcut: 'Ctrl+U', action: textActions.underline },
        { label: 'Strikethrough', action: textActions.strike },
        { label: 'Larger', shortcut: 'Ctrl+Shift+.', action: () => fontSize(1) },
        { label: 'Smaller', shortcut: 'Ctrl+Shift+,', action: () => fontSize(-1) },
        { sep: true },
        { label: 'Align left', shortcut: 'Ctrl+Shift+L', action: () => textActions.align('left') },
        { label: 'Centre', shortcut: 'Ctrl+Shift+E', action: () => textActions.align('center') },
        { label: 'Align right', shortcut: 'Ctrl+Shift+R', action: () => textActions.align('right') },
        { label: 'Justify', shortcut: 'Ctrl+Shift+J', action: () => textActions.align('justify') },
        { sep: true },
        { label: 'Bulleted list', shortcut: 'Ctrl+Shift+8', action: () => textActions.list('ul') },
        { label: 'Numbered list', shortcut: 'Ctrl+Shift+7', action: () => textActions.list('ol') },
        { sep: true },
        { label: 'Clear formatting', shortcut: 'Ctrl+\\', action: textActions.clear },
        ...(master?.similar ? [{ label: `Make ${master.similar} similar text${master.similar === 1 ? '' : 's'} on other slides look like this`, action: master.lookAlike }] : []),
      ] }] : []),
      ...(sel.length && !ro ? [{ title: 'Arrange', items: [
        ...arrangeItems(),
        ...(master ? [{ sep: true }, ...masterItems(one!, master).filter(m => !(m as MenuItem).info)] : []),
      ] }] : []),
    ];
    return menus;
  };
  // (after a burst of renders — a drag, a stroke —: the guides' entries read the deck's text)
  const menusLatest = useRef(deckMenus);
  menusLatest.current = deckMenus;
  useEffect(() => { const id = setTimeout(() => setEditorMenus(menusLatest.current()), 120); return () => clearTimeout(id); });
  useEffect(() => () => setEditorMenus([]), []);

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
    const map: Record<string, Tool> = { t: 'text', r: 'rect', o: 'ellipse', l: 'line', a: 'arrow', p: 'pen', e: 'eraser', s: 'lasso', b: 'bezier', v: 'select' };
    // (P, E and S open Draw: its row shows)
    if (map[k]) { setToolState(map[k]); setDrawOpen(k === 'p' || k === 'e' || k === 's'); setDrawHeld(false); return true; }
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
      else if ((e.key === 'Delete' || e.key === 'Backspace') && !readOnlyRef.current && !presenting) {
        // Ctrl+A's selection reply is asynchronous. Send both shortcuts to the
        // canvas in order rather than dropping Delete against an old host selection.
        e.preventDefault(); toCanvas({ ol: 'canvasKey', key: e.key, shift: e.shiftKey });
      }
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
      else if (e.key === 'Escape') {
        if (e.defaultPrevented) return;
        if (tool !== 'select') setToolState('select');
        else if (!presenting) {
          // A queued object selection must not overtake Escape. Deferred text
          // and formula editing retain their own keyboard context.
          if (pending.current?.select && !pending.current.editText) pending.current = null;
          // The canvas owns its selection; its reply may not have rendered here.
          e.preventDefault();
          toCanvas({ ol: 'canvasKey', key: 'Escape', shift: false });
        }
      }
      else if (!mod && !e.altKey && e.key.startsWith('Arrow') && selRef.current.length && !readOnlyRef.current && !presenting) { e.preventDefault(); toCanvas({ ol: 'canvasKey', key: e.key as 'ArrowLeft', shift: e.shiftKey }); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  // the clipboard: a click on the canvas leaves the keyboard here, so Ctrl+C / X / V come here, not to the
  // canvas — the selection's copy is the one the canvas keeps ready, a paste is passed on (runtime/clip.ts)
  useEffect(() => {
    const ours = (e: ClipboardEvent) => {
      if (presenting || !canvasBox.current?.getClientRects().length) return false;
      if (!canvasBox.current.closest('.dl-editor')?.contains(document.activeElement) && document.activeElement !== document.body) return false;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('textarea, input') || t?.isContentEditable || editingTextRef.current) return false;
      // words selected out here (a dialog, the notes): theirs
      const s = getSelection();
      return !s || s.isCollapsed;
    };
    const onCopy = (e: ClipboardEvent) => {
      const c = clipRef.current;
      if (!ours(e) || !c || !selRef.current.length || !e.clipboardData) return;
      e.preventDefault();
      e.clipboardData.setData('text/html', c.html);
      e.clipboardData.setData('text/plain', c.plain);
    };
    const onCut = (e: ClipboardEvent) => {
      if (!ours(e) || !clipRef.current || !selRef.current.length || readOnlyRef.current) return;
      onCopy(e);
      removeSel();
    };
    const onPaste = (e: ClipboardEvent) => {
      if (!ours(e) || readOnlyRef.current || !e.clipboardData) return;
      e.preventDefault();
      const cd = e.clipboardData;
      const html = cd.getData('text/html'), plain = cd.getData('text/plain');
      void Promise.all(Array.from(cd.files ?? []).map(async f => ({ name: f.name, type: f.type, data: await f.arrayBuffer() })))
        .then(files => toCanvas({ ol: 'paste', html, plain, files }));
    };
    addEventListener('copy', onCopy);
    addEventListener('cut', onCut);
    addEventListener('paste', onPaste);
    return () => { removeEventListener('copy', onCopy); removeEventListener('cut', onCut); removeEventListener('paste', onPaste); };
  });

  /* ------------------------------------------------------------- presenting */

  // slides deleted as suggestions are not presented: the presentation numbers the others
  // (the presented slides: not those deleted as suggestions, nor skipped ones)
  const presentIndexOf = (i: number) => slidesRef.current.slice(0, i).filter(s => !s.deleted && !s.skipped).length;
  const canvasIndexOf = (k: number) => {
    let n = -1;
    const ss = slidesRef.current;
    for (let i = 0; i < ss.length; i++) if (!ss[i].deleted && !ss[i].skipped && ++n === k) return i;
    return k;
  };

  const presentBox = useRef<HTMLDivElement>(null);
  /** the presented slide is zoomed in: Escape (which leaves full screen first) only zooms out */
  const presentZoomed = useRef(false);
  /** the slide the presentation starts on: F5 the first (PowerPoint), Shift+F5 and the button the one shown */
  const presentFrom = useRef(0);
  /** the presenting frame was told this browser's presenting settings */
  const presentPrefsSent = useRef(false);
  /** the other screens presenting the page (their awareness states), and this one's state as last shared (app/presentshare.ts) */
  const presentPeers = useRef<PresenterState[]>([]);
  const presentOut = useRef<PresentState | null>(null);
  const startPresenting = async (fromStart = false) => {
    presentZoomed.current = false;
    presentPrefsSent.current = false;
    presentFrom.current = fromStart ? 0 : presentIndexOf(currentRef.current);
    if (offlineDocsRef.current.edit) {
      const doc = await host.offlineFrame?.('present', currentLink.current ?? undefined);
      setOfflineDocs(prev => ({ ...prev, present: doc ?? undefined }));
    }
    if (link && host.present?.(src('present') + `#${presentFrom.current + 1}`)) return;
    setPresenting(true);
    setTimeout(() => {
      void presentBox.current?.requestFullscreen?.().catch(() => undefined);
      presentFrame.current?.focus();
    }, 30);
  };
  const stopPresenting = () => {
    setPresenting(false);
    setOfflineDocs(({ present: _present, ...active }) => active);
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
  // the screen kept on while presenting (an iPad locks mid-talk): asked for here, as the sandboxed frame may not
  useEffect(() => (presenting ? keepAwake() : undefined), [presenting]);
  // no reload for a newer build (app/update.ts) mid-talk, nor with edits not yet confirmed
  const presentingNow = useRef(presenting); presentingNow.current = presenting;
  useEffect(() => holdReload(() => { const s = host.saveState?.(); return presentingNow.current || (!!s && (s.pending || !!s.localPending || s.state !== 'saved')); }), [host]);
  // presented on other screens too (an iPad and a Mac): their states into the frame as they change; this one's withdrawn as it ends
  useEffect(() => {
    if (!presenting || !host.onPresent) return;
    const off = host.onPresent(peers => { presentPeers.current = peers; toFrame(presentFrame.current, { ol: 'presentPeers', peers }); });
    return () => { off(); presentPeers.current = []; presentOut.current = null; host.setPresent?.(null); };
  }, [presenting, host]);

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
  const notes = useMemo(() => curSlidePath && kind === 'deck' ? slideNotes(textNow, curSlidePath).text : '', [textNow, curSlidePath?.join(), kind]);
  // the zoom menu: the levels (one slide: Fit, Fit width, Fit content — those apart), what the zoom is at
  const shownLevels: ViewLevels = soloOn ? viewLevels(box, solo!.rect, solo!.content ?? null, MAX_ZOOM, marginBox, gap) : { fit };
  const zoomLevels = soloOn ? viewDetents(shownLevels).map(d => d.key) : ['fit' as const];
  const pct = Math.round(scale * 100);
  const atLevel = soloOn ? levelAt(shownLevels, scale) : Math.abs(zoom - 1) < 0.005 ? 'fit' : null;
  const zoomPick = atLevel ?? (DECK_ZOOMS.includes(pct) ? String(pct) : 'custom');
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

  const src = (mode: string) => {
    const target = mode === 'present' ? link : frameLink;
    return target ? `${target.base}${target.entry.split('/').map(encodeURIComponent).join('/')}?ol=${mode}` : 'about:blank';
  };
  const offlineSrc = (mode: 'edit' | 'thumb' | 'present') => `/_ol/offline-frame.html?ol=${mode}&revision=${offlineRevisions[mode]}`;
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
        {/* The runtime focuses as it inserts: early iframe focus lets Escape overtake this message. */}
        {labels.map(l => <button type="button" class="dk-ref-item" key={l} onClick={() => { close(); toCanvas({ ol: 'insertRef', src: `\\eqref{${l}}` }); }}>{l}</button>)}
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
  // the texts like the one selected on the other slides (deckmaster similarTexts: Make … look like this), worked out once a text
  const one1 = sel.length === 1 ? sel[0] : null;
  let similarCount = 0;
  if (one1 && kind === 'deck' && one1.kind === 'text' && !one1.master && one1.slide >= 0) {
    const t0 = host.text(), k = one1.path.join(), c = similarCache.current;
    if (c && c.p === k && c.t === t0) similarCount = c.n;
    else { try { similarCount = similarTexts(t0, one1.path).length; } catch { similarCount = 0; } similarCache.current = { t: t0, p: k, n: similarCount }; }
  }
  const bars = deckToolbar({
    pageLabel: host.bindSvgExporter ? 'SVG' : undefined,
    guides: { shown: guidesShown, items: () => guideItems(currentRef.current, null).filter(m => !m.sep && !m.disabled && m.action).map(m => ({ label: m.label!, action: m.action!, active: m.checked })) },
    // (over selected words, the text tools show how the words look: their size, bold …, not the box's)
    kind, tool, setTool, readOnly: locked, sel: editingText && words?.style && sel.length === 1 ? [{ ...sel[0], style: { ...sel[0].style, ...words.style } }] : sel, editingText: !!editingText,
    math: { editing: !!mathEdit && !mathEdit.closing, insert: display => toCanvas({ ol: 'insertMath', display }), exec: mathExec, panels: mathPanels,
      display: !!mathEdit?.display, number: () => mathOps.current?.number(), label: labelFormula },
    latex: { link: insertLink, cite: host.docId ? () => setCiteOpen(true) : undefined, reference: pickReference },
    animate: { open: animOpen && kind === 'deck', toggle: () => toggleAnim() },
    nodes: { editing: !!nodeEd, selected: nodeEd?.selected ?? 0, total: nodeEd?.total ?? 0, cmd: cmd => toCanvas({ ol: 'nodes', cmd }) },
    // (the text being retyped ends first: its box does not take the undone version while it is retyped)
    undo: () => { toCanvas({ ol: 'stopText' }); setTimeout(() => host.undo(), 30); }, redo: () => { toCanvas({ ol: 'stopText' }); setTimeout(() => host.redo(), 30); },
    insertImage: () => { phPicture.current = null; fileInput.current?.click(); },
    text: textActions, paint, arrange: arrangeSel, image: imageTools, remove: removeSel,
    slideBackground,
    newSlide: () => newSlide(currentRef.current),
    layoutPicker: (close, apply) => layoutPicker(currentRef.current, close, apply),
    master: kind === 'deck' ? masterOps(sel.length === 1 ? sel[0] : null) : undefined,
    placeholders: kind === 'deck' ? {
      insert: r => { void insertPlaceholder(r); },
      picture: () => { const one = selRef.current.length === 1 ? selRef.current[0] : null; if (one?.ph?.role === 'picture') { phPicture.current = one.path; fileInput.current?.click(); } },
    } : undefined,
    ink: {
      presets: ink, set: setInk, draw: on => { setDrawOpen(on); setDrawHeld(false); setToolState(on ? 'pen' : 'select'); }, open: drawOpen, held: drawHeld,
      fold: folded => { setDrawOpen(!folded); setDrawHeld(folded); if (folded && touchRef.current && soloRef.current) setDrawFocus(true); },
      lassoColors: () => slideColors.current,
      thicken: k => paint({ inkScale: k }),
      convert: as => toCanvas({ ol: 'inkConvert', as }),
    },
    review: {
      comment: () => toCanvas({ ol: 'newComment' }),
      suggestion: selChange ? { by: selChange.by, summary: selChange.summary, accept: () => resolveChange(selChange, true), reject: () => resolveChange(selChange, false) } : null,
    },
  });
  const openComments = review.threads.filter(t => !t.thread.done).length;
  // the quick menu beside the selection (QuickBar.tsx): the toolbar's most used buttons, duplicate, comment —
  // over the words selected in the text being retyped (wherever that text sits: in a group, a table, a page's section) the word tools
  const onWords = !!editingText && !!words?.rect;
  const comment: ToolButton = { id: 'dk-comment', title: 'Comment (Ctrl+Alt+M)', icon: 'dk-comment', action: () => toCanvas({ ol: 'newComment' }) };
  const quick = !locked && !dragging && !presenting && (tool === 'select' || tool === 'lasso') && sel.length && !nodeEd && !mathEdit && !cropping && !words?.choosing
    ? onWords ? quickGroups(bars.sections, [comment], true)
    : quickGroups(bars.sections, [{ id: 'dk-dup', title: 'Duplicate (Ctrl+D)', icon: 'dk-duplicate', action: duplicateSel }, comment]) : [];
  const quickRect = onWords ? words!.rect : sel.length ? sel.map(s => s.rect).reduce((a, r) => {
    const x = Math.min(a.x, r.x), y = Math.min(a.y, r.y);
    return { x, y, w: Math.max(a.x + a.w, r.x + r.w) - x, h: Math.max(a.y + a.h, r.y + r.h) - y };
  }) : null;

  /* ------------------------------------------------------------- where the toolbars are (deckdock.ts) */

  // the editor's room: the toolbars and the canvas share it, wherever the toolbars go
  const editorRef = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setArea(a => a.w === el.clientWidth && a.h === el.clientHeight ? a : { w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const dockWas = useRef<DeckDock>('top');
  const dockAsk = dockAsked();
  const slideShape = solo && solo.rect.w > 0 ? solo.rect : { w: pageW || 1280, h: pageH || (pageW || 1280) * 9 / 16 };
  // (the rail beside the canvas takes its width — on a narrow screen it is a drawer over it —, the notes their height)
  const dockArea = { w: area.w - (railOpen && typeof innerWidth === 'number' && innerWidth > 900 ? railW : 0), h: area.h - (kind === 'deck' && notesShown ? 74 : 0) };
  const placed = kind === 'page' || presenting || !(touchUi || dockAsk) ? { dock: 'top' as DeckDock, col: 0 }
    : chooseDock({ area: dockArea, slide: slideShape, tools: bars.tools.reduce((n, g) => n + g.length * 34 + 9, 24), rest: 560, current: dockWas.current, gap: touchUi ? 0 : undefined });
  // (kept while drawing has the bars away: they come back where they were, into the room the slide left them)
  const dock: DeckDock = kind === 'page' || presenting ? 'top' : dockAsk ?? (focusOn || fullOn ? dockWas.current : placed.dock);
  dockWas.current = dock;
  /** the toolbars away: drawing focus, the slide on the whole screen */
  const barsAway = focusOn || fullOn;
  const sides = dock === 'sides' && !barsAway;
  const topBar = !sides && !barsAway;

  // the contextual tools on a row of their own when they do not fit beside the others (nothing hidden)
  const barRef = useRef<HTMLDivElement>(null);
  const [ctxRow, setCtxRow] = useState(false);
  const checkContextRow = () => {
    const bar = barRef.current;
    if (!bar) return;
    const ctx = bar.querySelector<HTMLElement>(':scope > .dl-ctx');
    // (the sections side by side, however they wrap in the row of their own: else the row would decide it fits and flip back)
    const secs = Array.from(ctx?.firstElementChild?.children ?? []) as HTMLElement[];
    const need = secs.reduce((n, k, i) => n + k.offsetWidth + (i ? 13 : 0), 0);
    let others = 0;
    for (const k of Array.from(bar.children) as HTMLElement[]) if (k !== ctx && k.offsetParent !== null) others += k.offsetWidth + 4;
    const cs = getComputedStyle(bar);
    const room = bar.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0) - others - 16;
    setCtxRow(need > room);
  };
  // Remeasure changing tools before paint, without disconnecting/re-observing the
  // same toolbar after every render (which creates fresh initial notifications).
  useLayoutEffect(checkContextRow);
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const ro = new ResizeObserver(checkContextRow);
    ro.observe(bar);
    return () => ro.disconnect();
  }, [topBar]);

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
  /**
   * The slides and the notes folded away: their buttons in the screen's bottom-left corner — the app's
   * status bar (its slot, after the files' button), or in VS Code a strip of their own under the
   * editor — never over the slide.
   */
  const notesFirst = notes.trim().split('\n')[0];
  const corner = (showRail && !railShown) || (kind === 'deck' && !notesShown) ? <>
    {showRail && !railShown && (
      <CornerButton icon="slides" title="Show the slides" data-dl-rail-show onClick={() => setRailShown(true)}>
        Slides{slides.length ? ` · ${current + 1} of ${slides.length}` : ''}
      </CornerButton>
    )}
    {kind === 'deck' && !notesShown && (
      <CornerButton icon="notes" title={notesFirst ? `Show the speaker notes — ${notesFirst}` : 'Show the speaker notes'} data-dl-notes-show onClick={() => setNotesShown(true)}>
        Notes{notesFirst && <span class="dl-notes-dot" aria-label=" (this slide has notes)"> •</span>}
      </CornerButton>
    )}
  </> : null;

  /* ------------------------------------------------------------- the toolbar's parts: a row along the top, or a column at each side */

  /** the Draw row on a touch screen: a palette of its own on the canvas, put where the user likes it (drawpalette.tsx) — not in the toolbar, its side column or under the pen on the slide's corner */
  const drawPalette = touchUi && !!bars.draw && !presenting;
  const ctxSections = drawPalette ? [] : bars.sections;
  const ctxEl = (
    <div class="dl-ctx">{ctxSections.length > 0 && (
      <div class="dl-ctx-secs">{ctxSections.map((sec, i) => <Toolbar key={`${i}:${sec.label}`} id="deck-context" label={sec.label} groups={sec.groups} />)}</div>
    )}</div>
  );
  // a web page nothing has been written on yet (made by a name that said "page" when slides were meant): slides instead, in one click
  const blankPage = kind === 'page' && !locked && host.ready() ? untouchedPageTitle(host.text()) : null;
  const pageEls = kind === 'page' && <>
    {blankPage !== null && <button class="dl-btn" data-dl-as-deck title="Make it a slide deck instead — blank pages, at the size of new decks (this screen’s, or the one chosen last); nothing has been written on this page yet (Undo makes it a web page again)" onClick={() => {
      const parts = host.path.split('/');
      // (a folder's index.html is titled by its folder: SAB/index.html, “SAB”)
      const title = blankPage === 'Index' && parts.length > 1 ? parts[parts.length - 2] : blankPage;
      applySplices([{ from: 0, to: host.text().length, insert: blankDeck(title, usualDeckSize()) }], 'canvas', true, false);
    }}>▭ Slides</button>}
    {host.makeArticle && !readOnly && <button class="dl-btn" data-dl-article title="Write this page as an article: its prose in the document editor (comments, suggestions, formulas), everything else kept as it is and shown running" onClick={() => {
      void uiConfirm('Write as an article', 'The page becomes a document: its text is written in the document editor — with comments, suggestions, formulas and citations — and what is not text (navigation, scripts, interactive figures) stays as it is, shown running. The page as it is now is kept as a version.', { okLabel: 'Write as article' })
        .then(ok => { if (ok) return host.makeArticle!(); })
        .catch(e => notify('Could not make it an article: ' + (e as Error).message, 'error'));
    }}>✎ Article</button>}
    <button class={'dl-btn' + (device === 'desktop' ? ' on' : '')} title="Desktop width" onClick={() => setDevice('desktop')}>🖥</button>
    <button class={'dl-btn' + (device === 'mobile' ? ' on' : '')} title="Phone width" onClick={() => setDevice('mobile')}>📱</button>
  </>;
  const zoomSelect = (
    <select class="dl-btn dl-zoom" data-dl-zoom value={zoomPick} onChange={e => { const el = e.currentTarget as HTMLSelectElement; chooseZoom(el.value); el.blur(); }}
      title={`Zoom (${pct} %). ${zoomLevels.map(levelName).join(', ')}: a pinch stops at ${zoomLevels.length > 1 ? 'them' : 'it'}${zoomLevels.includes('margins') ? '; Fit margins shows the inside of the layout’s margins' : ''}${solo?.content ? '; Fit content what is on the slide' : ''}. Ctrl+0: ${levelName('fit')}`}>
      {zoomLevels.map(k => <option key={k} value={k}>{levelName(k)}</option>)}
      {zoomPick === 'custom' && <option value="custom">{pct}%</option>}
      {DECK_ZOOMS.map(z => <option key={z} value={String(z)}>{z}%</option>)}
    </select>
  );
  /** the slide on the whole screen (`full`): on a touch screen */
  const fullBtn = touchUi && soloOn && (
    <button class="dl-btn dl-full-btn" data-dl-full aria-label="Full screen" onClick={() => setFull(true)}
      title="Full screen: the slide edge to edge, everything else away — swipe to the next slide, on past the last for a new one"
      dangerouslySetInnerHTML={{ __html: ICONS['dk-fullscreen'] ?? '⛶' }} />
  );
  const invertBtn = darkS.dark && (
    <button class={'dl-btn dl-invert' + (darkS.invert ? ' on' : '')} data-dl-invert aria-pressed={darkS.invert} onClick={toggleDarkPages}
      title={darkS.invert ? 'Smart invert: the slides light on dark, photographs in their colours — documents, PDFs and slides alike. Click for their own colours' : 'The slides’ own colours — click to smart-invert the pages (documents, PDFs and slides alike)'}>◐</button>
  );
  const objectsBtn = (
    <button class={'dl-btn dl-objects-btn' + (objOpen ? ' on' : '')} data-tb="dk-objects" onClick={() => toggleObjects()}
      title="Objects: what is on the slide as a tree — open groups and drawings, select a letter of a logo, rename, lock, restack (Inkscape's Objects, PowerPoint's Selection Pane)"
      dangerouslySetInnerHTML={{ __html: ICONS['dk-objects'] ?? '' }} />
  );
  const codeBtn = !host.bindSvgExporter && <button class={'dl-btn' + (codeOpen ? ' on' : '')} title="The page's code" data-dl-code onClick={() => setCodeOpen(o => !o)}>&lt;/&gt;</button>;
  const toggleReview = () => { setReviewOpen(!reviewOpen); if (reviewOpen) { setDraft(null); setFocus(null); } };
  const reviewCount = openComments + review.changes.length;
  const reviewBtn = (
    <button class={'dl-btn dl-review-btn' + (reviewOpen ? ' on' : '')} data-dl-review-toggle onClick={toggleReview}
      title={`Comments and suggestions${openComments || review.changes.length ? ` — ${openComments} open comment${openComments === 1 ? '' : 's'}, ${review.changes.length} suggestion${review.changes.length === 1 ? '' : 's'}` : ''}`}>
      <svg class="dl-rv-icon-svg" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 2.5h12v8.5H6.5L2 14z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" /></svg>
      {reviewCount > 0 && <span class="dl-rv-count" data-dl-review-count>{reviewCount}</span>}
    </button>
  );
  const modeSwitch = (
    <EditModeSwitch mode={viewing ? 'viewing' : suggesting ? 'suggesting' : 'editing'} canEdit={!readOnly} view={null} views={() => []} onMode={setMode}
      changes={{ ins: showIns, del: showDel, set: setChanges }} shortcuts={false} scope={{ doc: pageSuggesting, set: setModeScopeTo }} />
  );
  const downloads = (x: number, y: number) => showContextMenu(x, y, host.downloads(m => src(m === 'view' && kind === 'deck' ? 'present' : m)));
  const downloadBtn = !host.bindSvgExporter && (
    <button class="dl-btn" title="Download" data-dl-download onClick={e => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); downloads(r.left, r.bottom + 4); }}>⤓</button>
  );
  const statusEl = (
    <span role="status" aria-live="polite" class={'dl-status' + (online ? '' : ' off')} title={saveState?.localError ? 'Browser storage failed: ' + saveState.localError : saveState?.pending ? saveState.localPending === false ? 'Changes are kept in this browser and will sync when connected.' : 'Changes are still being written. Keep this tab open until Saved appears.' : undefined}>
      {saveState?.state === 'stale' ? 'Older local copy' : !synced ? 'Loading…' : readOnly ? 'View only' : saveState?.state === 'offline' || !online ? (saveState?.pending ? saveState.localPending === false && !saveState.localError ? 'Offline — saved in this browser' : 'Offline — keep this tab open' : 'Offline') : saveState?.state === 'saving' ? 'Saving…' : saveState?.state === 'saved' ? 'Saved' : ''}
    </span>
  );
  /** the side columns' ⋯: what the top row has besides the zoom and Present (a column has no room for all of it) */
  const moreMenu = (x: number, y: number) => showContextMenu(x, y, [
    { label: 'Objects', checked: objOpen, action: () => toggleObjects() },
    { label: `Comments and suggestions${reviewCount ? ` (${reviewCount})` : ''}`, checked: reviewOpen, action: toggleReview },
    ...(!host.bindSvgExporter ? [{ label: 'Code', checked: codeOpen, action: () => setCodeOpen(o => !o) }] : []),
    { sep: true },
    { label: 'Editing', checked: !viewing && !suggesting, disabled: readOnly, action: () => setMode('editing') },
    { label: 'Suggesting', checked: !viewing && suggesting, disabled: readOnly, action: () => setMode('suggesting') },
    { label: 'Viewing', checked: viewing, action: () => setMode('viewing') },
    ...(darkS.dark ? [{ sep: true }, { label: 'Smart invert pages', checked: darkS.invert, action: toggleDarkPages }] : []),
    // (a menu of its own, not a submenu: a submenu opens on hover, which a finger does not do)
    ...(!host.bindSvgExporter ? [{ sep: true }, { label: 'Download…', action: () => downloads(x, y) }] : []),
  ]);
  /** a column at each side (deckdock.ts): the tools at the left; what fits the selection, the zoom, Present and the rest at the right */
  const leftCol = sides && (
    <div class="dl-side left tb-side" data-tb-side="left" data-dl-side="left" role="toolbar" aria-label="Tools">
      <Toolbar id="deck-tools" groups={bars.tools} />
    </div>
  );
  const rightCol = sides && (
    <div class="dl-side right tb-side" data-tb-side="right" data-dl-side="right" role="toolbar" aria-label="Format and view">
      {chrome}
      {ctxEl}
      <div class="dl-side-end">
        {zoomSelect}
        {fullBtn}
        {kind !== 'page' && !host.bindSvgExporter && <button class="dl-btn dl-present" title="Present from this slide (Shift+F5) — F5 from the first" aria-label="Present" data-dl-present onClick={() => startPresenting(false)}>▶</button>}
        <button class="dl-btn dl-more" title="More: objects, comments, code, editing or suggesting, download" aria-label="More" data-dl-more
          onClick={e => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); moreMenu(r.left, r.top); }}>
          ⋯{reviewCount > 0 && <span class="dl-rv-count">{reviewCount}</span>}
        </button>
        {statusEl}
      </div>
    </div>
  );
  /**
   * Drawing (drawFocus), the slide on the whole screen (full): the pen in hand at the slide's top right
   * corner — its tap the Draw row over the canvas —, Undo beside it, and the way out of the full screen
   */
  const drawTool = tool === 'pen' || tool === 'eraser' || tool === 'lasso';
  const focusPill = (focusOn || fullOn) && (() => {
    const p = slideView.place(), at = p ? focusSpot(p, solo!.rect, box) : { right: 8, top: 8 };
    const icon = tool === 'eraser' ? 'inkeraser' : tool === 'lasso' ? 'inklasso' : ink.pen === 'highlighter' ? 'inkhl' : ink.nib.ball ? 'inkball' : 'inkpen';
    const rowOpen = drawTool && drawOpen;
    return (
      <div ref={focusPillEl} class="dl-focus" data-dl-focus style={{ right: `${at.right}px`, top: `${at.top}px` }}>
        <div class="dl-focus-row">
        {!locked && <button type="button" class="dl-focus-btn" title="Undo (or tap with two fingers)" aria-label="Undo" data-dl-focus-undo
          onClick={() => { toCanvas({ ol: 'stopText' }); setTimeout(() => host.undo(), 30); }} dangerouslySetInnerHTML={{ __html: ICONS['undo'] ?? '↶' }} />}
        {!locked && <button type="button" class={'dl-focus-btn dl-focus-pen' + (rowOpen ? ' on' : '')} data-dl-focus-pen aria-expanded={rowOpen}
          title={!drawTool ? 'Draw — the pens, colours and widths' : drawOpen ? 'Fold the pens away' : fullOn ? 'The pens, colours and widths' : 'The pens, colours and widths — Done in them brings the toolbars back'} aria-label="Drawing tools"
          onClick={() => {
            if (!drawTool) { setToolState('pen'); setDrawOpen(true); setDrawHeld(false); }
            else if (drawOpen) { setDrawOpen(false); setDrawHeld(true); }
            else { setDrawOpen(true); setDrawHeld(false); }
          }}>
          <span class="dl-focus-ico" dangerouslySetInnerHTML={{ __html: ICONS[icon] ?? ICONS['dk-draw'] ?? '' }} />
          {tool === 'pen' && <span class="dl-focus-dot" style={{ background: inkStyle.color }} />}
        </button>}
        {fullOn && <button type="button" class="dl-focus-btn" title="Leave the full screen: the toolbars, the slides and the rest back" aria-label="Leave full screen" data-dl-full-exit
          onClick={() => setFull(false)} dangerouslySetInnerHTML={{ __html: ICONS['dk-fullscreen-exit'] ?? '×' }} />}
        </div>
        {/* (the Draw row — or the lasso's tools — under it when asked for) */}
        {drawTool && ctxSections.length > 0 && (
          <div class="dl-focus-bar" data-dl-focus-bar>{ctxSections.map((sec, i) => <Toolbar key={`${i}:${sec.label}`} id="deck-context" label={sec.label} groups={sec.groups} />)}</div>
        )}
      </div>
    );
  })();

  const insertRecoveredCopy = () => {
    const draft = recoveredRef.current[0];
    if (!draft || locked) return;
    const place = insertPlace(text.toString(), curSlidePath, null, kind);
    if (!place) { notify('Choose a slide to insert the recovered copy.', 'error'); return; }
    const html = `<div style="position: absolute; left: 80px; top: 120px; width: ${Math.min(1000, Math.max(240, pageW - 160))}px; font-size: 28px; color: #1d2433; background: #fff">${draft.html}</div>`;
    if (!applyOps([{ t: 'insert', parent: place.parent, index: place.index, html }])) return;
    const next = recoveredRef.current.filter(d => d.id !== draft.id);
    recoveredRef.current = next; setRecovered(next); saveTextDrafts(recoveryKey, next);
    forgetPendingTextDraft(recoveryKey, draft.id);
    setRecoveryOpen(false);
    notify('Recovered text inserted as a separate box. The existing box was not overwritten.');
  };

  return (
    <div ref={editorRef} class={'dl-editor' + (presenting ? ' presenting' : '') + (focusOn ? ' dl-drawfocus' : '') + (fullOn ? ' dl-full' : '')} data-kind={kind} data-dock={dock}>
      {saveState?.state === 'stale' && <div role="alert" data-dl-stale-notice style="padding:8px 12px;background:#fff5d8;color:#342700">
        This file was replaced while this browser had an older copy. Download the local source before reopening the latest file.
        <button class="btn" onClick={() => {
          const url = URL.createObjectURL(new Blob([host.text()], { type: 'text/html' }));
          const a = document.createElement('a'); a.href = url; a.download = path.split('/').pop() ?? 'recovered.html'; a.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }}>Download local source</button>
        <button class="btn" onClick={() => { void host.discardLocal?.().then(() => location.reload()).catch(error => notify(String(error), 'error')); }}>Reopen latest file</button>
      </div>}
      {!!recovered.length && !presenting && <div role="status" data-dl-recovery-notice style="padding:6px 10px;background:#fff5d8;color:#342700;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <span>{recovered.length} recovered text draft{recovered.length === 1 ? '' : 's'} — the saved document was kept.</span>
        <button class="btn" onClick={() => setRecoveryOpen(true)}>Recover text</button>
      </div>}
      {(tool === 'select' || tool === 'lasso') && quick.length > 0 && quickRect && <QuickBar groups={quick} rect={quickRect} box={onWords ? sel[0]?.rect : undefined} frame={() => canvasFrame.current} scrollY={() => (soloOn ? 0 : scrollRef.current)} />}
      {/* (the context tools, when they float below the bar, start right of the slide rail: its header stays clear) */}
      {topBar && <div ref={barRef} class={'dl-toolbar' + (ctxRow ? ' dl-ctx-row' : '')} role="toolbar" style={`--ctx-left: ${railOpen ? railW + 8 : 8}px`}>
        <span class="dl-title" title={path}>{title}</span>
        {chrome}
        <Toolbar id="deck-tools" groups={bars.tools} />
        {ctxEl}
        {pageEls}
        <span class="dl-zoomgroup">
          <button class="dl-btn" title="Zoom out (Ctrl+−)" onClick={() => zoomStep(1 / 1.25)}>−</button>
          {zoomSelect}
          <button class="dl-btn" title="Zoom in (Ctrl+=)" onClick={() => zoomStep(1.25)}>+</button>
        </span>
        {fullBtn}
        {invertBtn}
        {objectsBtn}
        {codeBtn}
        {reviewBtn}
        {modeSwitch}
        {kind !== 'page' && !host.bindSvgExporter && <button class="dl-btn dl-present" title="Present from this slide (Shift+F5) — F5 from the first" data-dl-present onClick={() => startPresenting(false)}>▶ Present</button>}
        {downloadBtn}
        {statusEl}
      </div>}
        <input ref={fileInput} type="file" accept="image/*,.svg" multiple hidden onChange={e => {
          const fs = Array.from((e.target as HTMLInputElement).files ?? []); (e.target as HTMLInputElement).value = '';
          const ph = phPicture.current; phPicture.current = null;
          if (ph && fs[0]) { void fillPicture(ph, fs[0]); return; }
          void uploadImages(fs.map(f => ({ name: f.name, type: f.type, data: f })), null);
        }} />
        <input ref={replaceInput} type="file" accept="image/*,.svg" hidden onChange={e => { const fs = Array.from((e.target as HTMLInputElement).files ?? []); (e.target as HTMLInputElement).value = ''; void replacePicture(fs); }} />
      <div class="dl-body" data-sides={sides ? '' : undefined} style={sides ? `--dl-col: ${placed.col}px` : undefined}>
        {leftCol}
        {showRail && railShown && (
          <div class="dl-rail" ref={railBox} style={{ width: `${railW}px` }}>
              <div class="dl-rail-head">
                <span class="dl-rail-count" title="The slide shown, of all slides">{slides.length ? `Slide ${current + 1} of ${slides.length}` : 'Slides'}</span>
                <button class="dl-btn dl-rail-hide" title="Hide the slides (more room for the slide)" aria-label="Hide the slides" data-dl-rail-hide onClick={() => setRailShown(false)}>«</button>
              </div>
              {link && synced && <iframe ref={railFrame} class="dl-railframe" title="Slides" sandbox={offlineDocs.thumb ? undefined : 'allow-scripts'} src={offlineDocs.thumb ? offlineSrc('thumb') : src('thumb')}
                style={{ top: `${RAIL_HEAD}px`, width: `${frameW + RAIL_NUM / railScale}px`, height: `${railH / railScale}px`, transform: `scale(${railScale})` }} />}
              <div class="dl-rail-grip" role="separator" aria-orientation="vertical" aria-label="Slide rail width" title="Drag to make the slides wider or narrower (double-click: back to the usual width)"
                data-dl-railgrip onPointerDown={onRailGrip} onDblClick={() => setRail(RAIL_W)} />
              <div class="dl-rail-actions">
                <button class="dl-btn" title="New slide after this one (Ctrl+M)" data-dl-newslide disabled={locked} onClick={() => newSlide(current)}>+ Slide</button>
                <button class="dl-btn" title="New slide in a layout — title slide, title and body, two columns … made of this deck’s design, or one of its own" aria-label="New slide in a layout" data-dl-newslide-layouts disabled={locked}
                  onClick={e => { const r = e.currentTarget.getBoundingClientRect(); pickAt(r.left, r.top, 'New slide', close => layoutPicker(current, close)); }}>▾</button>
              </div>
          </div>
        )}
        <div class="dl-main">
          <div class="dl-canvas" ref={canvasBox} style={deskCss ? { background: deskCss } : undefined} data-desk={view.deskChecker ? 'checker' : view.desk ? 'custom' : 'page'}
            onContextMenu={e => { if (e.target === e.currentTarget) { e.preventDefault(); canvasMenu(e.clientX, e.clientY); } }}
            onPointerDown={canvasTouch} onPointerMove={canvasTouch} onPointerUp={canvasTouch} onPointerCancel={canvasTouch} onLostPointerCapture={canvasTouch}
            onWheel={e => {
              if (e.target !== e.currentTarget) return;
              const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
              if (soloOn) {
                // beside the slide: as on it — a pinch zooms about the pointer, a scroll pulls the slide (it springs back, or pulled far enough, comes loose)
                e.preventDefault();
                const r = (viewEl.current ?? e.currentTarget).getBoundingClientRect();
                if (e.ctrlKey || e.metaKey) zoomSolo(Math.exp(-e.deltaY * k * 0.01), e.clientX - r.left, e.clientY - r.top);
                else if (e.shiftKey && !e.deltaX) slideView.scroll(-e.deltaY * k, 0);
                else slideView.scroll(-e.deltaX * k, -e.deltaY * k);
                return;
              }
              if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomStep(Math.exp(-e.deltaY * 0.01)); } else if (e.deltaX || e.shiftKey) setPanX(p => p - (e.deltaX || e.deltaY));
            }}
            onDragOver={e => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }}
            onDrop={e => { if (!e.dataTransfer?.files.length) return; e.preventDefault(); const fs = Array.from(e.dataTransfer.files); void placeFiles(fs.map(f => ({ name: f.name, type: f.type, data: f })), null, null); }}>
            {/* (the slide's part of the canvas: all of it, but while drawing holds the slide where the bars left it) */}
            <div ref={viewEl} class="dl-view" style={{ top: `${inset.t}px`, right: `${inset.r}px`, bottom: `${inset.b}px`, left: `${inset.l}px` }}>
              {link && synced && <iframe ref={canvasFrame} class={'dl-frame' + (soloOn ? ' solo' : '')} title="Page" sandbox={offlineDocs.edit ? undefined : 'allow-scripts allow-modals allow-popups allow-forms'} src={offlineDocs.edit ? offlineSrc('edit') : src('edit')}
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
              {focusPill}
              {/* (a swipe on past the last slide: the new one it adds, filling as it goes) */}
              {soloOn && kind === 'deck' && (
                <div ref={addBadge} class="dl-addpage" data-dl-addpage aria-hidden="true">
                  <div class="dl-addpage-ghost" />
                  <div class="dl-addpage-mark">
                    <svg viewBox="0 0 32 32">
                      <circle class="dl-pull-disc" cx="16" cy="16" r="15" />
                      <circle class="dl-pull-arc" cx="16" cy="16" r="12.5" pathLength="1" transform="rotate(-90 16 16)" />
                      <path class="dl-addpage-plus" d="M16 10v12M10 16h12" />
                    </svg>
                    <span class="dl-addpage-label">Pull for a new slide</span>
                  </div>
                </div>
              )}
            </div>
            {(!link || !synced || canvasState !== 'ready') && <div class="dl-opening" data-dl-opening={canvasState === 'failed' ? 'failed' : linkState}
              role={canvasState === 'failed' || linkState === 'failed' || linkState === 'denied' ? 'alert' : 'status'}>
              <p>{linkState === 'denied'
                ? 'This page is unavailable or your access has changed. Check your account or ask the owner, then try again.'
                : canvasState === 'failed' ? 'The canvas could not start. Retry opening, or open Code to recover its source.'
                : linkState === 'failed'
                  ? 'Could not open the canvas. Reconnect to the network or try again.'
                  : !synced ? 'Loading the document…' : 'Opening the canvas…'}</p>
              {(canvasState === 'failed' || linkState === 'failed' || linkState === 'denied') && <button type="button" class="dl-btn" data-dl-retry-open
                onClick={retryOpening}>Retry opening</button>}
              {canvasState === 'failed' && <button type="button" class="dl-btn" onClick={() => setCodeOpen(true)}>Open Code</button>}
            </div>}
            {drawPalette && <DrawPalette sections={bars.sections} />}
            {hud && <div key={hud.n} class="dl-hud" role="status" data-dl-hud style={hud.ms > 900 ? { animationDuration: `${hud.ms}ms` } : undefined}>{hud.text}</div>}
            <div ref={zoomHud} class="zoom-hud" aria-hidden="true" data-dl-zoomhud />
            {(lost || zoomed || (soloOn && slideFree)) && kind !== 'page' && (
              <button type="button" class={'dl-refocus' + (lost ? ' lost' : '')} data-dl-refocus onClick={fitSlide}
                title={zoomed ? `Show the whole ${kind === 'poster' ? 'poster' : 'slide'} again (Ctrl+0)` : 'Back into the middle (Ctrl+0)'}>
                {lost ? (kind === 'poster' ? '⤢ Back to the poster' : `⤢ Back to slide ${current + 1}`) : `⤢ ${zoomed ? 'Fit' : 'Centre'} ${kind === 'poster' ? 'poster' : 'slide'}`}
              </button>
            )}
          </div>
          {/* (folded away, nothing of them is left here: their button is in the corner) */}
          {kind === 'deck' && notesShown && !fullOn && (
            <div class="dl-notes">
              <textarea placeholder="Speaker notes" value={notesDraft && curSlidePath && notesDraft.path.join() === curSlidePath.join() ? notesDraft.text : notes} disabled={locked || !curSlidePath} data-dl-notes
                onInput={e => setNotesDraft((e.target as HTMLTextAreaElement).value)}
                onBlur={e => { const d = draftRef.current; saveNotes((e.target as HTMLTextAreaElement).value, d?.path ?? curSlidePath); setNotesDraftState(null); }} />
              <button type="button" class="dl-btn dl-notes-hide" title="Hide the speaker notes" aria-label="Hide the speaker notes" data-dl-notes-hide onMouseDown={e => e.preventDefault()} onClick={hideNotes}>▾</button>
            </div>
          )}
        </div>
        {objOpen && !fullOn && (
          <ObjectsPane slide={objects.slide} items={objects.items} sel={sel} readOnly={locked} close={() => toggleObjects(false)}
            select={paths => toCanvas({ ol: 'select', paths })} hover={p => toCanvas({ ol: 'hover', path: p })}
            rename={(p, name) => applyOps([{ t: 'attr', path: p, name: 'data-ol-name', value: name }])}
            lock={(p, on) => applyOps([{ t: 'attr', path: p, name: 'data-ol-locked', value: on ? '' : null }])}
            restack={(p, ref, front) => toCanvas({ ol: 'restack', path: p, ref, front })} />
        )}
        {animOpen && kind === 'deck' && !fullOn && (
          <AnimationPane seq={seq} sel={sel} readOnly={locked} close={() => toggleAnim(false)}
            send={cmd => toCanvas({ ol: 'steps', cmd })} select={p => toCanvas({ ol: 'select', paths: [p] })} />
        )}
        {reviewOpen && !fullOn && (
          <ReviewPane review={review} slideTitles={slides.map(s => s.title)} current={current} kind={kind} me={me} canEdit={!locked}
            focus={focus} draft={draft} submitDraft={submitDraft} cancelDraft={() => setDraft(null)} select={showOnCanvas}
            reply={replyTo} resolve={resolveThread} remove={removeThread}
            accept={c => resolveChange(c, true)} reject={c => resolveChange(c, false)}
            acceptAll={() => resolveEverything(true)} rejectAll={() => resolveEverything(false)}
            close={() => { setReviewOpen(false); setDraft(null); setFocus(null); }} />
        )}
        {codeOpen && !fullOn && (
          <div class="dl-code">
            <div class="dl-code-head"><span>{path.split('/').pop()}</span><button class="dl-btn" onClick={() => setCodeOpen(false)} title="Close">×</button></div>
            <textarea ref={codeRef} spellcheck={false} readOnly={locked} onInput={onCodeInput} data-dl-codearea
              onKeyDown={e => { if (e.key === 'Tab') { e.preventDefault(); document.execCommand('insertText', false, '  '); } }} />
          </div>
        )}
        {rightCol}
      </div>
      {corner && !barsAway && (cornerSlot ? createPortal(corner, cornerSlot) : <div class="dl-foot">{corner}</div>)}
      {floatPop && <FloatPopover {...floatPop} onClose={() => setFloatPop(null)} />}
      {citeOpen && host.docId && <CiteDialog meta={CITE_META} search docId={host.docId} project={host.docId.split('/').slice(0, 2).join('/')} restoreFocusOnInsert={false}
        onInsert={(keys, cmd, before, after) => {
          if (!keys.length) return;
          const opt = before || after ? `[${before}][${after}]` : '';
          // Keep keys in the host until the runtime focuses and inserts in one turn.
          toCanvas({ ol: 'insertRef', src: `\\${cmd}${opt}{${keys.join(',')}}` });
        }}
        onAdded={r => { bibAsked.current.delete(r.key); setTimeout(() => syncBibRef.current?.(), 500); }}
        onClose={() => setCiteOpen(false)} />}
      {mathEdit && !presenting && <MathOverlay st={mathEdit} frame={canvasFrame.current} scale={scale} typeAhead={typeAhead} invert={darkS.invert}
        onSet={tex => toCanvas({ ol: 'mathSet', id: mathEdit.id, tex })}
        onShown={() => toCanvas({ ol: 'mathShown', id: mathEdit.id })}
        onDisplay={() => toCanvas({ ol: 'mathDisplay', id: mathEdit.id })}
        onRest={keys => toCanvas({ ol: 'typeKeys', keys })} keysIn={mathKeysIn} ops={mathOps} macros={deckMacros}
        onDone={(tex, dir, putBack, keys) => {
          const id = mathEdit.id;
          // the field stays (still) until the formula is shown again under it (the runtime's mathClose)
          setMathEdit(st => st && st.id === id ? { ...st, closing: true } : st);
          setTimeout(() => setMathEdit(st => st && st.id === id && st.closing ? null : st), 800);
          if (dir) canvasFrame.current?.focus();
          toCanvas({ ol: 'mathDone', id, tex, dir, putBack, keys });
        }} />}
      {recoveryOpen && recovered[0] && <Dialog title="Recover text" onClose={() => setRecoveryOpen(false)} buttons={<>
        <button class="btn" onClick={() => setRecoveryOpen(false)}>Keep for later</button>
        <button class="btn primary" disabled={locked || !curSlidePath} onClick={insertRecoveredCopy}>Insert recovered copy</button>
      </>}>
        <p>{recovered[0].reason}</p>
        <p>Copy this draft or insert it as a separate text box. Neither action overwrites the latest saved text.</p>
        <label>Recovered draft<textarea readOnly value={draftWords(recovered[0].html)} style="width:100%;min-height:160px" /></label>
      </Dialog>}
      {bgFor && <BgRemoveDialog src={bgFor.url} name={bgFor.name} onDone={b => { void saveNoBg(b); }} onClose={() => setBgFor(null)} />}
      {presenting && link && (
        <div class="dl-presenting" ref={presentBox}>
          <iframe ref={presentFrame} title="Presentation" sandbox={offlineDocs.present ? undefined : 'allow-scripts allow-popups'} src={offlineDocs.present ? offlineSrc('present') : src('present') + `#${presentFrom.current + 1}`}
            onLoad={() => { if (offlineDocsRef.current.present) presentFrame.current?.contentWindow?.postMessage({ ol: 'go', slide: presentFrom.current }, '*'); }} />
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

/** `p` once an element is inserted at `index` of `parent` (a later sibling of it, or inside one, moves along by one) */
function shiftedBy(p: Path, parent: Path, index: number): Path {
  if (p.length <= parent.length || parent.some((v, i) => p[i] !== v) || p[parent.length] < index) return p;
  const out = [...p];
  out[parent.length]++;
  return out;
}

/** the citation dialog's view of a deck: the project's bibliography searched on the server, natbib's commands */
const CITE_META = { bib: [], citeEngine: 'natbib' } as unknown as DocMeta;

/** the page's macros (MathJax's form) as LyX's formula editor takes them */
function macroTableOf(m: Record<string, MathJaxMacro>): MacroTable {
  const out: MacroTable = {};
  for (const [name, v] of Object.entries(m)) out[name] = typeof v === 'string' ? { nargs: 0, def: v } : { nargs: v[1], def: v[0], ...(v.length > 2 ? { nopt: 1 } : {}) };
  return out;
}
