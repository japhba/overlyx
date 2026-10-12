/**
 * The canvas in the editor's frame: selecting, moving, resizing, rotating, retyping and drawing
 * objects of the page, reported to the editor as operations on the text (core html/source.ts).
 * What the runtime draws (selection frames, handles, guides) lives in a shadow root on <html>, out
 * of the page's reach and out of its styles.
 *
 * A click selects an object: on a slide an element directly on it (a group's inside is reached by
 * double-clicking it, or with Ctrl / ⌘ — that press drags the object within its group, which then
 * fits around it again), on a web page the innermost block. A double click on text
 * — or on a shape: shapes take text like Google Slides' — retypes it in place (contenteditable,
 * with its TeX shown as written); Escape ends that, then goes a level up. Dragging moves what is
 * positioned (absolute, fixed, relative; on a slide also a static element, which becomes relative;
 * inside an SVG a shape gets a translate), Alt+drag moves a copy, handles resize (in the object's
 * own axes when it is rotated); as in Inkscape a click on the selected object again turns its handles
 * into rotation arrows at the corners (Shift: 15° steps) and the next click back, a double click edits
 * its points (a shape) or its text; a line's ends are dragged by themselves. Positions are written in the units the element had. Arrows nudge, Delete
 * removes, ⌘D duplicates; ⌘Z, ⌘G and the rest go to the editor, which sends arrangement commands
 * back (arrange.ts).
 *
 * Touch and pen: the canvas takes every gesture itself (touch-action: none) — a finger on an
 * object moves it, on nothing pans, held still first draws a selection box, two fingers pan, and
 * pinch-zoom once they have clearly come closer or gone further apart (gestures.ts; the editor scales
 * the frame); a pen works like the mouse. The pointer is captured, so a
 * drag that leaves the frame keeps going.
 */
import type { Path, SelItem, SelStyle, Tool, Rect, HtmlOp, ObjKind, KeyPress, InkStyle, PeerInfo, TextCaret, WordsStyle } from '../protocol';
import { inkOn } from '../../app/contrast';
import { MODE, post, state, srcOf, pathOf, liveAt, sourced, slides, slideOf, docRect, isForeign, sendLayout } from './env';
import { guard, linkTree } from './reconcile';
import { typeset } from './math';
import { renderCites, refreshCites } from './cite';
import { stepOf } from '@overlyx/core/html/refs.ts';
import { refreshView } from './view';
import { badges, isOrdering, orderClick, stopOrdering, postSequence, stepsChanged, STEPS_CSS } from './animate';
import { startCrop, isCropping, endCrop, cropNow, cropTarget, setCropAspect, redrawCrop, type CropContext } from './crop';
import { chipify, unchip, openChip, openChipEl, chipOpening, holdKey, holdAfter, keyPress, isModifierKey, typeKeysHere, chipHooks, flushAfter, insertRefChip, shownChip, setChip, doneChip, displayChip, closeChip, trackChip, insertChip, chipBeside, CHIP_CSS } from './mathedit';
import { initPaths, isNodeEditing, nodesAfterSource, nodesTargetOf, startNodesOrConvert, endNodes, redrawNodes, penDown, penMove, penUp, penKey, penDouble, penCancel, isPenDrawing, setMenuShape } from './pathedit';
import { isSolo, showSlide, soloIndex, revealSlideOf } from './solo';
import { inkRuns, inkPaths, runsBox, freshPoint, isScribble, type FreePt, type InkRun } from './freehand';
import { pinchFactor, pinchLock, triGesture, type PinchLock } from '../gestures';
import { offsetOf, caretBox, selectionBoxes, safeColor } from './carets';
import { postObjects } from './objects';
import { reviewOverlay, bindPins, setReviewHover, showGhost, lockDeletions, trackInput, commentTarget, setLiveAt, styleAuthors, REVIEW_OVERLAY_CSS } from './review';
import { initListDrag, hoverList, notePointer, listParts, bindListGrips, listDragging, stepItem, LIST_DRAG_CSS } from './listdrag';
import { clipOf, postClip, paste } from './clip';
import { weaveMenu } from './weave';

const NS = 'http://www.w3.org/1999/xhtml';
let host: HTMLElement;
let root: ShadowRoot;
let layer: HTMLElement;
let scale = 1;
let tool: Tool = 'select';
/** Draw: the ink of the pen's strokes (the stroke drawn in the page while drawing; the editor writes it) */
let inkStyle: InkStyle = { color: '#1d2433', width: 4, opacity: 1 };
let selected: Element[] = [];
let peers: PeerInfo[] = [];
let editing: HTMLElement | null = null;
/** the selected object showing rotation arrows instead of resize handles (Inkscape: a click on the selected object switches them) */
let rotating: Element | null = null;
let editTimer: ReturnType<typeof setTimeout> | null = null;
let editStartHtml = '';
/** the cursor while dragging (the move arrows, a handle's resize arrows, rotation) */
let dragCss: HTMLStyleElement | null = null;

const TEXT_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'sub', 'sup', 'small', 'mark', 'a', 'br', 'ul', 'ol', 'li', 'blockquote', 'code', 'q', 'cite', 'abbr', 'time', 'label', 'font', 'section', 'article', 'header', 'footer', 'figcaption', 'dt', 'dd', 'dl', 'td', 'th', 'caption', 'big', 'del', 'ins', 'kbd', 'var', 'samp', 'strike']);
const REPLACED = new Set(['img', 'svg', 'video', 'canvas', 'iframe', 'object', 'embed', 'picture', 'audio']);
const SVG_SHAPES = new Set(['rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path', 'text', 'tspan', 'g', 'use', 'image']);
/**
 * The four-way arrows over an object a drag moves, and while it moves — drawn, not the system's `move`
 * cursor, which some browsers (Safari, Chrome on macOS) show as a hand or not at all.
 */
const MOVE_SVG = `<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'><path d='M12 1.5l3.6 4h-2.4v5.3h5.3V8.4l4 3.6-4 3.6v-2.4h-5.3v5.3h2.4l-3.6 4-3.6-4h2.4v-5.3H5.5v2.4L1.5 12l4-3.6v2.4h5.3V5.5H8.4z' fill='black' stroke='white' stroke-width='1.2' stroke-linejoin='round'/></svg>`;
export const MOVE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(MOVE_SVG).replace(/'/g, '%27')}") 12 12, move`;
/** the eraser's cursor: the circle it rubs out with */
const ERASER_CURSOR = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="7" fill="white" fill-opacity="0.6" stroke="black" stroke-width="1.2"/></svg>')}") 10 10, cell`;
const ROT_CURSOR = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Cpath d='M18 7a8 8 0 1 0 2 6' fill='none' stroke='white' stroke-width='4'/%3E%3Cpath d='M18 7a8 8 0 1 0 2 6' fill='none' stroke='black' stroke-width='1.6'/%3E%3Cpath d='M14 3l5 4-6 2z' fill='black' stroke='white' stroke-width='.8'/%3E%3C/svg%3E") 12 12, grab`;

export function startEditing(): void {
  host = document.createElementNS(NS, 'ol-overlay') as HTMLElement;
  host.setAttribute('data-ol-runtime', '');
  host.style.cssText = 'all:initial;position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;display:block;';
  root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>
    :host { all: initial; }
    .layer { position: absolute; left: 0; top: 0; pointer-events: none; font: 12px system-ui, sans-serif; }
    .frame { position: absolute; border: 1.5px solid #2f6fde; box-sizing: border-box; pointer-events: none; transform-origin: 50% 50%; }
    .frame.peer { border-style: dashed; }
    .frame.editing { border-color: #e8a33d; }
    .frame.locked { border-style: dotted; border-color: #8a93a6; }
    .frame.ctx { border-style: dashed; border-color: rgba(47,111,222,.6); }
    .hover { position: absolute; outline: 1px solid rgba(47,111,222,.55); pointer-events: none; transform-origin: 50% 50%; }
    .handle { position: absolute; width: var(--h); height: var(--h); margin: calc(var(--h) / -2) 0 0 calc(var(--h) / -2); background: #fff; border: 1.5px solid #2f6fde; box-sizing: border-box; border-radius: 2px; pointer-events: auto; touch-action: none; }
    .handle.end { border-radius: 50%; width: calc(var(--h) * 1.25); height: calc(var(--h) * 1.25); margin: calc(var(--h) * -0.625) 0 0 calc(var(--h) * -0.625); cursor: ${MOVE_CURSOR}; }
    .handle.rot4 { width: calc(var(--h) * 2); height: calc(var(--h) * 2); margin: calc(var(--h) * -1) 0 0 calc(var(--h) * -1); border: 0; border-radius: 0; background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cg fill='none' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M4.5 15A8.5 8.5 0 0 1 19.5 15M2 12.5l2.5 3 3-1.8M22 12.5l-2.5 3-3-1.8' stroke='white' stroke-width='5'/%3E%3Cpath d='M4.5 15A8.5 8.5 0 0 1 19.5 15M2 12.5l2.5 3 3-1.8M22 12.5l-2.5 3-3-1.8' stroke='%232f6fde' stroke-width='2'/%3E%3C/g%3E%3C/svg%3E") center / contain no-repeat; cursor: ${ROT_CURSOR}; }
    .rot-centre { position: absolute; width: calc(var(--h) * 1.4); height: calc(var(--h) * 1.4); margin: calc(var(--h) * -0.7) 0 0 calc(var(--h) * -0.7); pointer-events: none;
      background: linear-gradient(#2f6fde, #2f6fde) center / 1.5px 100% no-repeat, linear-gradient(#2f6fde, #2f6fde) center / 100% 1.5px no-repeat; opacity: .8; }
    .lock { position: absolute; transform: translate(-100%, -100%); font-size: calc(12px * var(--s)); line-height: 1; pointer-events: none; }
    .guide { position: absolute; background: #e8467c; pointer-events: none; }
    .draw { position: absolute; border: 1.5px dashed #2f6fde; background: rgba(47,111,222,.08); pointer-events: none; }
    .drop { position: absolute; border: 3px dashed #2f6fde; background: rgba(47,111,222,.10); pointer-events: none; box-sizing: border-box; }
    .tag { position: absolute; transform: translateY(calc(-100% - 3px * var(--s))); background: #2f6fde; color: #fff; padding: calc(1px * var(--s)) calc(6px * var(--s)); border-radius: calc(3px * var(--s)); white-space: nowrap; pointer-events: none; font: 600 calc(10.5px * var(--s)) / 1.35 system-ui, -apple-system, sans-serif; letter-spacing: .02em; }
    .tag.editing { background: #e8a33d; }
    .tag.locked { background: #8a93a6; }
    ${STEPS_CSS}
    ${REVIEW_OVERLAY_CSS}
    ${LIST_DRAG_CSS}
    .peer-tag { position: absolute; transform: translateY(-100%); color: #fff; padding: 1px 5px; border-radius: 3px 3px 0 0; white-space: nowrap; pointer-events: none; font-size: calc(11px * var(--s)); }
    .psel { position: absolute; opacity: .28; pointer-events: none; }
    .pcaret { position: absolute; width: calc(2px * var(--s)); margin-left: calc(-1px * var(--s)); pointer-events: none; }
    .pflag { position: absolute; left: calc(-1px * var(--s)); bottom: 100%; padding: 0 calc(4px * var(--s)); border-radius: calc(3px * var(--s)) calc(3px * var(--s)) calc(3px * var(--s)) 0; white-space: nowrap; pointer-events: none; font: 600 calc(10px * var(--s)) / 1.3 system-ui, -apple-system, sans-serif; }
    svg.ink { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
  </style><div class="layer"></div>`;
  layer = root.querySelector('.layer') as HTMLElement;
  document.documentElement.appendChild(host);
  initPaths({ root, scale: () => scale });
  // a list's items dragged into another order (listdrag.ts): the text being retyped, else the one box selected
  initListDrag({
    scale: () => scale,
    box: () => {
      const el = editing ?? (selected.length === 1 ? selected[0] : null);
      return el instanceof HTMLElement && el.isConnected && !isLocked(el) && (el.localName === 'ul' || el.localName === 'ol' || !!el.querySelector('li')) ? el : null;
    },
    editing: () => editing,
    draw,
    edited: scheduleCommit,
    commit: ops => commit(ops),
  });
  setLiveAt(liveAt);
  const css = document.createElement('style');
  css.setAttribute('data-ol-runtime', '');
  css.textContent = `[data-ol-editing] { outline: none !important; cursor: text !important; caret-color: auto; }
    html.ol-edit, html.ol-edit body { touch-action: none; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
    html.ol-edit [data-ol-editing], html.ol-edit [data-ol-editing] * { -webkit-user-select: text; user-select: text; }
    html.ol-tool-draw, html.ol-tool-draw * { cursor: crosshair !important; }
    html.ol-tool-erase, html.ol-tool-erase * { cursor: ${ERASER_CURSOR} !important; }
    html.ol-dragging, html.ol-dragging * { user-select: none !important; }
    html.ol-over-obj, html.ol-over-obj * { cursor: ${MOVE_CURSOR} !important; }
    html.ol-edit a { cursor: default; }
    ${CHIP_CSS}`;
  document.head.appendChild(css);
  dragCss = document.createElement('style');
  dragCss.setAttribute('data-ol-runtime', '');
  document.head.appendChild(dragCss);
  document.documentElement.classList.add('ol-edit');

  addEventListener('pointerdown', onPointerDown, true);
  addEventListener('pointermove', onHover, true);
  addEventListener('pointerup', onTouchUp, true);
  addEventListener('pointercancel', onTouchUp, true);
  addEventListener('click', swallow, true);
  addEventListener('dblclick', onDblClick, true);
  addEventListener('contextmenu', onContextMenu, true);
  addEventListener('keydown', onKeyDown, true);
  addEventListener('copy', onCopy, true);
  addEventListener('cut', onCut, true);
  addEventListener('paste', onPaste, true);
  addEventListener('dragover', onDragOver, true);
  addEventListener('dragleave', onDragLeave, true);
  addEventListener('drop', onDrop, true);
  addEventListener('wheel', onWheel, { capture: true, passive: false });
  // Safari's trackpad pinch
  addEventListener('gesturestart', onGesture as EventListener, { capture: true, passive: false } as AddEventListenerOptions);
  addEventListener('gesturechange', onGesture as EventListener, { capture: true, passive: false } as AddEventListenerOptions);
  addEventListener('submit', e => e.preventDefault(), true);
  // where the caret is in the text being retyped, for the others; the words selected, for the quick menu
  document.addEventListener('selectionchange', caretMoved);
  document.addEventListener('selectionchange', wordsMoved);
  addEventListener('pointerdown', chooseWords, true);
  addEventListener('scroll', () => {
    // one slide on the canvas: the editor pans the frame, the page never scrolls (a focus could scroll it)
    if (isSolo() && (scrollX || scrollY)) { scrollTo(0, 0); return; }
    draw(); post({ ol: 'scroll', y: scrollY }); visibleSlide(); trackChip();
  }, { passive: true });
  addEventListener('resize', () => { draw(); sendLayout(); refreshView(); trackChip(); });
  new ResizeObserver(() => { draw(); refreshView(); trackChip(); }).observe(document.documentElement);
}

/* ------------------------------------------------------------------ messages from the editor */

export function setScale(s: number, anchor?: { docY: number; screenY: number }): void {
  scale = s > 0 ? s : 1;
  // zoomed about a point: that point of the page stays where it is on the screen
  if (anchor && !isSolo()) scrollTo({ top: Math.max(0, anchor.docY - anchor.screenY / scale) });
  draw();
  redrawCrop();
  redrawNodes();
}
export function setTool(t: Tool, style?: InkStyle): void {
  tool = t;
  if (style) inkStyle = style;
  document.documentElement.classList.toggle('ol-tool-draw', t !== 'select' && t !== 'eraser');
  document.documentElement.classList.toggle('ol-tool-erase', t === 'eraser');
  if (t !== 'bezier') penCancel();
  if (t !== 'select') { stopText(); if (isCropping()) endCrop(true); endNodes(); }
  // drawing: stroke after stroke on top of the slide, nothing selected in between (GoodNotes)
  if ((t === 'pen' || t === 'eraser') && selected.length) { selected = []; report(); draw(); }
}

/* ------------------------------------------------------------------ crop (runtime/crop.ts: modal while it lasts) */

function cropCtx(): CropContext {
  return {
    root,
    scale: () => scale,
    srcOf: e => srcOf.get(e),
    pathOf,
    commit: ops => commit(ops),
    onEnd: () => { post({ ol: 'cropping', path: null }); draw(); },
  };
}
export function cropAt(path: Path, how: { aspect?: number | null; shape?: 'rect' | 'circle' } = {}): void {
  const el = liveAt(path);
  if (!el || !cropTarget(el)) return;
  stopText();
  selected = [el];
  report();
  if (startCrop(el, cropCtx(), how)) post({ ol: 'cropping', path });
  draw();
}
export function cropPreset(path: Path, how: { aspect: number | null; shape?: 'rect' | 'circle'; reset?: boolean }): void {
  const el = liveAt(path);
  if (el) cropNow(el, cropCtx(), how);
}
export { setCropAspect, endCrop };
export function setPeers(p: PeerInfo[]): void { peers = p; draw(); }

/* ------------------------------------------------------------------ the caret, for the others */

let caretTimer: ReturnType<typeof setTimeout> | null = null;
let caretSent = '';
let drawSoon = 0;

/** this person's caret (and selected words) in the text being retyped — or the formula open in it, taken whole */
function localCaret(): TextCaret | null {
  if (!editing) return null;
  const path = pathOf(editing);
  if (!path) return null;
  const open = editing.querySelector('.ol-mathchip[data-ol-mathediting]');
  if (open?.parentNode) {
    const at = offsetOf(editing, open.parentNode, Array.prototype.indexOf.call(open.parentNode.childNodes, open));
    return { path, anchor: at, head: at + 1 };
  }
  const sel = getSelection();
  if (!sel || !sel.rangeCount || !sel.anchorNode || !sel.focusNode || !editing.contains(sel.anchorNode) || !editing.contains(sel.focusNode)) return null;
  return { path, anchor: offsetOf(editing, sel.anchorNode, sel.anchorOffset), head: offsetOf(editing, sel.focusNode, sel.focusOffset) };
}

/** the caret to the editor (the others' awareness) now, unless it is where it was last sent */
function sendCaret(): void {
  if (caretTimer) { clearTimeout(caretTimer); caretTimer = null; }
  const c = localCaret();
  const k = c ? JSON.stringify(c) : '';
  if (k === caretSent) return;
  caretSent = k;
  post({ ol: 'caret', caret: c });
}

/**
 * The caret moved: sent at most every 80 ms — and while typed text waits to be committed, with that
 * commit (scheduleCommit), so that the others get the text before the caret placed in it.
 */
function caretMoved(): void {
  if (MODE !== 'edit' || !editing || caretTimer) return;
  caretTimer = setTimeout(() => { caretTimer = null; if (!editTimer) sendCaret(); }, 80);
}

/* ------------------------------------------------------------------ the selected words, for the quick menu */

let wordsFrame = 0;
let wordsSent = '';
/** the pointer is down in the text being retyped: words are being chosen */
let choosingWords = false;

/** the words selected changed (or moved: typed, restyled): told once a frame at most */
function wordsMoved(): void {
  if (MODE !== 'edit' || wordsFrame) return;
  wordsFrame = requestAnimationFrame(() => { wordsFrame = 0; sendWords(); });
}

/** the box of the words selected in the text being retyped (at whatever depth it sits) and how the first look */
function sendWords(): void {
  const sel = getSelection();
  const r = editing && !choosingWords && sel && sel.rangeCount && !sel.isCollapsed && sel.anchorNode && sel.focusNode && editing.contains(sel.anchorNode) && editing.contains(sel.focusNode) ? sel.getRangeAt(0) : null;
  const b = r?.getBoundingClientRect();
  const rect: Rect | null = b && (b.width || b.height) ? { x: Math.round(b.left + scrollX), y: Math.round(b.top + scrollY), w: Math.round(b.width), h: Math.round(b.height) } : null;
  const style = rect && r ? wordsStyle(r) : undefined;
  const k = JSON.stringify([rect, style, choosingWords]);
  if (k === wordsSent) return;
  wordsSent = k;
  post({ ol: 'words', rect, ...(style ? { style } : {}), ...(choosingWords ? { choosing: true } : {}) });
}

/** how the first selected letter looks (an underline is drawn by an element around it: not inherited) */
function wordsStyle(r: Range): WordsStyle | undefined {
  const w = document.createTreeWalker(r.commonAncestorContainer, NodeFilter.SHOW_TEXT);
  let t: Node | null = r.commonAncestorContainer.nodeType === 3 ? r.commonAncestorContainer : w.nextNode();
  for (; t; t = w.nextNode()) {
    if (!r.intersectsNode(t) || !(t as Text).data.trim()) continue;
    if (t === r.startContainer && r.startOffset >= (t as Text).length) continue;
    break;
  }
  const el = t?.parentElement;
  if (!el || !editing?.contains(el)) return undefined;
  const c = getComputedStyle(el);
  let deco = c.textDecorationLine;
  for (let x: Element | null = el; x && x !== editing.parentElement && deco === 'none'; x = x.parentElement) deco = getComputedStyle(x).textDecorationLine;
  return { fontSize: c.fontSize, fontFamily: c.fontFamily, fontWeight: c.fontWeight, fontStyle: c.fontStyle, textDecoration: deco, color: c.color };
}

/** words chosen with the pointer: the quick menu steps aside until it is lifted */
function chooseWords(e: PointerEvent): void {
  if (!editing || !editing.contains(e.target as Node)) return;
  choosingWords = true;
  sendWords();
  addEventListener('pointerup', chosenWords, true);
  addEventListener('pointercancel', chosenWords, true);
}
function chosenWords(): void {
  removeEventListener('pointerup', chosenWords, true);
  removeEventListener('pointercancel', chosenWords, true);
  choosingWords = false;
  wordsMoved();
}

/** others' carets in the text being retyped here follow what is typed */
function redrawSoon(): void {
  if (drawSoon || !peers.some(p => p.caret)) return;
  drawSoon = requestAnimationFrame(() => { drawSoon = 0; draw(); });
}

/** the others' carets as last drawn (page px; `window.__ol.peerCarets()`, for tests) */
let drawnCarets: { name: string; x: number; y: number; h: number; selected: number }[] = [];
export function peerCarets(): typeof drawnCarets { return drawnCarets; }

/** a caret of another person: the words they selected, the bar and their name over it (page px) */
function peerCaret(el: Element, p: PeerInfo): string {
  const c = p.caret!;
  const color = safeColor(p.color);
  const out: string[] = [];
  const sel = selectionBoxes(el, c.anchor, c.head);
  for (const b of sel) out.push(`<div class="psel" style="left:${b.x + scrollX}px;top:${b.y + scrollY}px;width:${b.w}px;height:${b.h}px;background:${color}"></div>`);
  const at = caretBox(el, c.head);
  if (at) drawnCarets.push({ name: p.name, x: at.x + scrollX, y: at.top + scrollY, h: at.h, selected: sel.length });
  if (at) out.push(`<div class="pcaret" data-ol-peer-caret style="left:${at.x + scrollX}px;top:${at.top + scrollY}px;height:${at.h}px;background:${color}"><div class="pflag" style="background:${color};color:${inkOn(color)}">${esc(p.name)}</div></div>`);
  return out.join('');
}

/** drawn: it takes room on the page (not on a slide hidden by the one-slide canvas) */
const shown = (el: Element): boolean => el.getClientRects().length > 0;

export function selectPaths(paths: Path[]): void {
  selected = paths.map(liveAt).filter((e): e is Element => !!e);
  if (revealSlideOf(selected[0] ?? null)) afterReveal();
  report();
  draw();
}

/** another slide is shown now: what belonged to the one before goes, the editor learns the new layout */
function afterReveal(): void {
  hoverEl = null;
  requestAnimationFrame(() => { sendLayout(); draw(); });
}

/** Ctrl+A: every object of the slide (of the selection's slide, else the one shown) */
export function selectAllOnSlide(): void {
  if (editing || state.kind === 'page') return;
  const s = selected[0]?.isConnected ? slideOf(selected[0]) : visibleSlideEl();
  if (s) { selected = Array.from(s.children).filter(c => srcOf.has(c) && !isForeign(c) && !c.classList.contains('notes')); report(); draw(); }
}

/** the selection, for the arrangement commands (arrange.ts) */
export function selection(): Element[] { return selected.filter(e => e.isConnected); }
export function setSelection(els: Element[]): void { selected = els; report(); draw(); }

/** after a new version of the text: the selection found again, the frame redrawn */
export function afterSource(): void {
  inkArrived();
  selected = selected.map(e => (e.isConnected ? e : null)).filter((e): e is Element => !!e && !!pathOf(e));
  if (editing && !editing.isConnected) { editing = null; post({ ol: 'editing', path: null }); }
  stepsChanged();
  styleAuthors();
  report();
  draw();
  nodesAfterSource();
}

/**
 * The keys typed between drawing a text box and its retyping starting — the box has to go through
 * the text and come back first —, typed into the frame or passed on by the editor (typeKeys): typed
 * into the new box once it is retyped, in the order they came.
 */
let drawAhead: KeyPress[] | null = null;
let drawAheadTimer: ReturnType<typeof setTimeout> | null = null;
function expectNewText(): void {
  drawAhead = [];
  if (drawAheadTimer) clearTimeout(drawAheadTimer);
  drawAheadTimer = setTimeout(() => { drawAhead = null; }, 4000);
}

export function editTextAt(path: Path, selectAll = false, math = false): void {
  const el = liveAt(path);
  if (!el) return;
  if (revealSlideOf(el)) afterReveal();
  selected = [el];
  report();
  if (canType(el)) beginText(el as HTMLElement, null, selectAll && !math, math);
  // keys typed while the new box was on its way (runtime drawAhead)
  if (drawAhead && editing === el) {
    const keys = drawAhead;
    drawAhead = null;
    if (drawAheadTimer) { clearTimeout(drawAheadTimer); drawAheadTimer = null; }
    if (keys.length) typeKeysHere(keys, stopText);
  }
  draw();
}

/* ------------------------------------------------------------------ formulas (runtime/mathedit.ts) */

export function mathShown(id: number): void { shownChip(id); sendCaret(); }
export function mathSet(id: number, tex: string): void { void setChip(id, tex).then(() => { if (editing) scheduleCommit(); }); }
export function mathDisplay(id: number): void { displayChip(id); }
/** the formula left last: text typed after it waits for the caret to be beside it */
let leaving: Promise<unknown> = Promise.resolve();
chipHooks.stop = () => stopText();
export function typeKeys(keys: KeyPress[]): void {
  // a text box is on its way: the keys wait for it
  if (drawAhead && !editing) { drawAhead.push(...keys); return; }
  void leaving.then(() => { if (editing && keys.length) { editing.focus({ preventScroll: true }); typeKeysHere(keys, stopText); } });
}
export function mathDone(id: number, tex: string, dir: 'forward' | 'backward' | null, putBack?: string): void {
  const el = editing;
  leaving = doneChip(id, tex, dir, el, putBack).then(kept => {
    if (!el || editing !== el) return;
    // the formula emptied and nothing else left in its box: the box goes too (as an empty formula in LyX)
    if (!kept && !cleanHtml(el).replace(/<[^>]*>|&nbsp;|\s/g, '')) {
      const path = pathOf(el);
      stopText();
      if (path) { selected = []; report(); commit([{ t: 'remove', paths: [path] }]); }
      return;
    }
    scheduleCommit();
    draw();
  });
}
export function insertMath(display: boolean): void { if (editing) insertChip(editing, display); }
/** a citation or reference at the caret of the text being retyped (the toolbar's pickers) */
export function insertRef(src: string): void { if (!editing) return; editing.focus({ preventScroll: true }); insertRefChip(editing, src); scheduleCommit(); }

/** a formatting command on the text being retyped (bold, foreColor, fontName …; fontSize: a span with that size, a CSS length) */
export function exec(command: string, value?: string): void {
  if (!editing) return;
  editing.focus();
  if (command === 'fontSize' && value) styleRun('font-size', value);
  else if (command === 'lineHeight' && value) { editing.style.setProperty('line-height', value); scheduleCommit(); return; }
  else document.execCommand(command, false, value);
  scheduleCommit();
}

/** the selected part of the text being retyped wrapped in a span with one style (inner ones of that style dropped) */
function styleRun(prop: string, value: string): void {
  const sel = getSelection();
  if (!editing || !sel || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  if (range.collapsed || !editing.contains(range.commonAncestorContainer)) { editing.style.setProperty(prop, value); return; }
  const span = document.createElement('span');
  span.style.setProperty(prop, value);
  span.appendChild(range.extractContents());
  for (const d of Array.from(span.querySelectorAll<HTMLElement>('[style]'))) {
    d.style.removeProperty(prop);
    if (!d.getAttribute('style')) d.removeAttribute('style');
    if (d.localName === 'span' && !d.attributes.length) d.replaceWith(...Array.from(d.childNodes));
  }
  range.insertNode(span);
  sel.removeAllRanges();
  const r = document.createRange();
  r.selectNodeContents(span);
  sel.addRange(r);
}

/* ------------------------------------------------------------------ what can be done with an element */

export function cs(el: Element): CSSStyleDeclaration { return getComputedStyle(el); }

/** its text can be retyped in place: only text and simple text markup inside */
export function isTextual(el: Element): boolean {
  if (REPLACED.has(el.localName) || el.classList.contains('slide') || el === document.body) return false;
  const src = srcOf.get(el);
  if (!src || isGroup(el)) return false;
  if (!(src.textContent ?? '').trim()) return false;
  for (const d of Array.from(src.querySelectorAll('*'))) if (!TEXT_TAGS.has(d.localName)) return false;
  return TEXT_TAGS.has(src.localName);
}

/** text can be typed into it: a text box, or a shape with nothing but text in it (an empty one too) */
export function canType(el: Element): boolean {
  // (a list of references is made by the runtime from the citations: cite.ts)
  if (el.classList.contains('ol-bibliography')) return false;
  if (isTextual(el)) return true;
  if (!(el instanceof HTMLElement) || REPLACED.has(el.localName) || el.classList.contains('slide') || el === document.body || el.classList.contains('ol-crop')) return false;
  const src = srcOf.get(el);
  if (!src || src.children.length || !TEXT_TAGS.has(src.localName)) return false;
  return !!slideOf(el) || el.offsetHeight > 0;
}

/**
 * A group: what Group makes (`.ol-group`), or any box holding nothing but positioned objects — it is
 * selected, moved and resized as one; Ctrl / ⌘ + click or a double click reaches its objects.
 */
export function isGroup(el: Element): boolean {
  if (!(el instanceof HTMLElement) || REPLACED.has(el.localName) || el.classList.contains('slide') || el === document.body || el.classList.contains('ol-crop')) return false;
  if (el.classList.contains('ol-group')) return true;
  const src = srcOf.get(el);
  if (!src || src.children.length < 2 || Array.from(src.childNodes).some(n => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim())) return false;
  const kids = Array.from(el.children).filter(k => srcOf.has(k));
  return kids.length > 1 && kids.every(k => { const p = cs(k).position; return p === 'absolute' || p === 'fixed'; });
}

/** a group's objects, positioned in it (those of the groups in it too, with `deep`) */
export function membersOf(g: Element, deep = false): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const k of Array.from(g.children)) {
    if (!srcOf.has(k) || isForeign(k)) continue;
    const p = cs(k).position;
    if (p !== 'absolute' && p !== 'fixed') continue;
    out.push(k as HTMLElement);
    if (deep && isGroup(k)) out.push(...membersOf(k, true));
  }
  return out;
}

/** the group an object is in (null: it is on the slide itself) */
export function groupOf(el: Element): HTMLElement | null {
  const p = el.parentElement;
  return p && isGroup(p) ? p : null;
}

/** an element inside an inline SVG (moved by a translate, painted by its attributes) */
export function isSvgPart(el: Element): el is SVGGraphicsElement {
  return el instanceof SVGElement && el.localName !== 'svg' && !!(el as SVGGraphicsElement).ownerSVGElement && srcOf.has(el);
}

export function isLocked(el: Element): boolean { return el.hasAttribute('data-ol-locked'); }

export function movable(el: Element): boolean {
  if (isSvgPart(el)) return SVG_SHAPES.has(el.localName);
  const p = cs(el).position;
  if (p === 'absolute' || p === 'fixed' || p === 'relative') return true;
  return state.kind !== 'page' && !!slideOf(el) && el !== slideOf(el);
}

function fixedHeight(el: Element): boolean {
  if (REPLACED.has(el.localName) || el.classList.contains('ol-crop')) return true;
  const src = srcOf.get(el);
  if (src && /(^|;)\s*height\s*:/i.test(src.getAttribute('style') ?? '')) return true;
  return !(el.textContent ?? '').trim();
}

/** the one straight line an SVG of ours is (two ends to drag) */
export function lineOf(el: Element): SVGLineElement | null {
  if (el.localName !== 'svg') return null;
  const shapes = Array.from(el.querySelectorAll('line, polyline, polygon, path, rect, circle, ellipse, text')).filter(s => !s.closest('defs, marker, symbol'));
  return shapes.length === 1 && shapes[0].localName === 'line' ? shapes[0] as SVGLineElement : null;
}

/** an SVG drawn with the pen: Draw's ink (an outline, filled), or open paths only, no fill */
function isStrokeArt(el: Element): boolean {
  if (el.localName !== 'svg') return false;
  if (el.classList.contains('ol-ink')) return true;
  const shapes = Array.from(el.querySelectorAll('path, polyline')).filter(s => !s.closest('defs, marker, symbol'));
  return shapes.length > 0 && shapes.length === el.querySelectorAll('path, polyline, polygon, rect, circle, ellipse, line, text').length && shapes.every(s => (s.getAttribute('fill') ?? cs(s).fill) === 'none');
}

export function kindOf(el: Element): ObjKind {
  if (el.localName === 'img' || (el.classList.contains('ol-crop') && el.querySelector('img'))) return 'image';
  if (isSvgPart(el)) return 'svgpart';
  if (el.localName === 'svg' && el.classList.contains('ol-ink')) return 'ink';
  if (el.localName === 'svg') return lineOf(el) || isStrokeArt(el) ? 'line' : 'svg';
  if (REPLACED.has(el.localName)) return 'other';
  if (isGroup(el)) return 'group';
  const c = cs(el);
  const painted = c.backgroundColor !== 'rgba(0, 0, 0, 0)' || c.backgroundImage !== 'none' || (c.borderTopStyle !== 'none' && parseFloat(c.borderTopWidth) > 0);
  const src = srcOf.get(el);
  if (src && /\\\[|\\\(|\$\$/.test(src.textContent ?? '') && !painted && isTextual(el)) return 'formula';
  if (isTextual(el)) return painted ? 'shape' : 'text';
  if (canType(el)) return 'shape';
  if (src && src.children.length) return 'group';
  return 'other';
}

/** degrees clockwise of the CSS `rotate` property */
export function angleOf(el: Element): number {
  const v = cs(el).rotate;
  if (!v || v === 'none') return 0;
  const m = /(-?[\d.]+)(deg|rad|turn|grad)?/.exec(v);
  if (!m) return 0;
  const n = Number(m[1]);
  return m[2] === 'rad' ? n * 180 / Math.PI : m[2] === 'turn' ? n * 360 : m[2] === 'grad' ? n * 0.9 : n;
}

function flipsOf(el: Element): { x: boolean; y: boolean } {
  const v = cs(el).scale;
  if (!v || v === 'none') return { x: false, y: false };
  const [a, b] = v.split(/\s+/).map(Number);
  return { x: a < 0, y: (b ?? a) < 0 };
}

/** an object's own box: its centre (document px), its size before rotation, its angle */
export interface Box { cx: number; cy: number; w: number; h: number; a: number }
export function boxOf(el: Element): Box {
  if (isSvgPart(el)) { const p = partBox(el); if (p) return p.box; }
  const r = docRect(el);
  const a = el instanceof HTMLElement || el.localName === 'svg' ? angleOf(el) : 0;
  if (!a) return { cx: r.x + r.w / 2, cy: r.y + r.h / 2, w: r.w, h: r.h, a: 0 };
  const he = el as HTMLElement;
  const w = he.offsetWidth ?? el.clientWidth, h = he.offsetHeight ?? el.clientHeight;
  return { cx: r.x + r.w / 2, cy: r.y + r.h / 2, w: w || r.w, h: h || r.h, a };
}

/* ------------------------------------------------------------------ a part of a drawing: its own transform */

/**
 * A part's transform as translate(p) rotate(a) scale(sx sy) translate(−c), as Inkscape and the
 * favicon's letters write it: c the centre of its own box (getBBox, before the transform), p where
 * that centre lands in its parent's units, a in radians. A transform with a skew has none.
 */
export interface PartForm { p: [number, number]; a: number; sx: number; sy: number; c: [number, number] }

/** a matrix as turn × scale (sy < 0: mirrored), or null when it skews */
function turnScale(m: { a: number; b: number; c: number; d: number }): { a: number; sx: number; sy: number } | null {
  const sx = Math.hypot(m.a, m.b);
  if (!sx) return null;
  const a = Math.atan2(m.b, m.a), sy = (m.a * m.d - m.b * m.c) / sx;
  if (!sy || Math.hypot(m.c + Math.sin(a) * sy, m.d - Math.cos(a) * sy) > 1e-3 * Math.abs(sy)) return null;
  return { a, sx, sy };
}

function partForm(el: SVGGraphicsElement): PartForm | null {
  let bb: DOMRect;
  try { bb = el.getBBox(); } catch { return null; }
  const t = el.transform?.baseVal.consolidate();
  const m = t ? t.matrix : new DOMMatrix();
  const ts = turnScale(m);
  if (!ts) return null;
  const c: [number, number] = [bb.x + bb.width / 2, bb.y + bb.height / 2];
  return { p: [m.a * c[0] + m.c * c[1] + m.e, m.b * c[0] + m.d * c[1] + m.f], c, ...ts };
}

/** the part's parent's units → document px */
function parentToDoc(el: Element): DOMMatrix | null {
  const m = (el.parentNode as SVGGraphicsElement | null)?.getScreenCTM?.();
  return m ? new DOMMatrix().translate(scrollX, scrollY).multiply(DOMMatrix.fromMatrix(m)) : null;
}

/** a part of a drawing as a box of its own on the page (turned with it), and what makes it: null when it cannot be resized and turned so */
export function partBox(el: Element): { box: Box; form: PartForm; P: DOMMatrix } | null {
  if (!isSvgPart(el) || !SVG_SHAPES.has(el.localName) || el.localName === 'tspan') return null;
  const form = partForm(el);
  const P = form && parentToDoc(el);
  if (!form || !P) return null;
  const T = new DOMMatrix([Math.cos(form.a) * form.sx, Math.sin(form.a) * form.sx, -Math.sin(form.a) * form.sy, Math.cos(form.a) * form.sy, 0, 0]);
  const L = turnScale(P.multiply(T));
  if (!L) return null;
  let bb: DOMRect;
  try { bb = el.getBBox(); } catch { return null; }
  // the box as it is seen: with half the outline outside the shape's geometry (Inkscape's visual box)
  const c = cs(el), sw = el.localName !== 'g' && c.stroke && c.stroke !== 'none' ? parseFloat(c.strokeWidth) || 0 : 0;
  const ctr = P.transformPoint(new DOMPoint(form.p[0], form.p[1]));
  return { box: { cx: ctr.x, cy: ctr.y, w: L.sx * (bb.width + sw), h: Math.abs(L.sy) * (bb.height + sw), a: L.a * 180 / Math.PI }, form, P };
}

const fix = (n: number, k: number) => String(Math.round(n * 10 ** k) / 10 ** k || 0);
const sig = (n: number) => String(Number(n.toPrecision(5)));

/** a part's form as its transform attribute (null: none needed) */
export function formText(f: PartForm): string | null {
  const turned = Math.abs(f.a) >= 1e-5, scaled = Math.abs(f.sx - 1) >= 1e-6 || Math.abs(f.sy - 1) >= 1e-6;
  if (!turned && !scaled) {
    const tx = f.p[0] - f.c[0], ty = f.p[1] - f.c[1];
    return Math.abs(tx) < 5e-4 && Math.abs(ty) < 5e-4 ? null : `translate(${fix(tx, 3)} ${fix(ty, 3)})`;
  }
  const out = [`translate(${fix(f.p[0], 3)} ${fix(f.p[1], 3)})`];
  if (turned) out.push(`rotate(${fix(f.a * 180 / Math.PI, 2)})`);
  if (scaled) out.push(Math.abs(f.sx - f.sy) < 1e-9 ? `scale(${sig(f.sx)})` : `scale(${sig(f.sx)} ${sig(f.sy)})`);
  if (Math.abs(f.c[0]) >= 5e-4 || Math.abs(f.c[1]) >= 5e-4) out.push(`translate(${fix(-f.c[0], 3)} ${fix(-f.c[1], 3)})`);
  return out.join(' ');
}

function setForm(el: Element, f: PartForm): void {
  const t = formText(f);
  if (t) el.setAttribute('transform', t); else el.removeAttribute('transform');
}

/** the edit turning a part of a drawing by `deg` (clockwise on the page) about its centre, or null */
export function turnPartOp(el: Element, deg: number | 'reset'): HtmlOp | null {
  const pb = partBox(el), path = pathOf(el);
  if (!pb || !path) return null;
  const flip = pb.P.a * pb.P.d - pb.P.b * pb.P.c < 0 ? -1 : 1;
  const f = { ...pb.form, a: deg === 'reset' ? 0 : pb.form.a + flip * deg * Math.PI / 180 };
  return { t: 'attr', path, name: 'transform', value: formText(f) };
}

const rot = (x: number, y: number, deg: number): [number, number] => {
  const t = deg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
  return [x * c - y * s, x * s + y * c];
};

/**
 * A drawing's empty area — its <svg> box where none of its shapes is painted, nor a few px around
 * (a thin line is still easy to take) — is nothing to a click: the selection goes, as beside the slide
 * (Inkscape's). A drawing with a background or a border of its own is its box. `x`, `y`: client px.
 */
function blankOfDrawing(t: Element, x: number, y: number): boolean {
  if (!(t instanceof SVGSVGElement) || !srcOf.has(t)) return false;
  const c = cs(t);
  if (c.backgroundColor !== 'rgba(0, 0, 0, 0)' || c.backgroundImage !== 'none' || parseFloat(c.borderTopWidth) > 0 || c.boxShadow !== 'none') return false;
  const r = 5 / scale, q = r * Math.SQRT1_2;
  for (const [dx, dy] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r], [q, q], [-q, q], [q, -q], [-q, -q]]) {
    // (what is painted inside it comes before it)
    for (const h of document.elementsFromPoint(x + dx, y + dy)) { if (h === t) break; if (t.contains(h)) return false; }
  }
  return true;
}

/** the object a pointer at `target` selects (see the header); `at`: where (client px) — a drawing's empty area is nothing there */
function objectFor(target: Element, deep: boolean, at?: { x: number; y: number }): Element | null {
  if (at && blankOfDrawing(target, at.x, at.y)) return null;
  const el = sourced(target);
  if (!el || el === document.body || el === document.documentElement || el.localName === 'head') return null;
  if (deep) return memberAt(el) ?? objectFor(target, false);
  // inside the selection's group: the child of that group
  const scope = selected.length === 1 ? selected[0].parentElement ?? (selected[0].parentNode as Element | null) : null;
  if (scope && scope.contains(el) && !scope.classList?.contains('slide') && scope !== document.body) {
    for (let e: Element | null = el; e; e = e.parentElement ?? (e.parentNode as Element | null)) if ((e.parentElement ?? e.parentNode) === scope) return e;
  }
  const slide = slideOf(el);
  if (slide) {
    if (el === slide) return null;
    for (let e: Element | null = el; e; e = e.parentElement) if (e.parentElement === slide) return sourced(e);
    return null;
  }
  // a web page: the innermost block (or picture)
  for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) {
    if (!srcOf.has(e)) continue;
    const d = cs(e).display;
    if (REPLACED.has(e.localName) || (d !== 'inline' && d !== 'contents')) return e;
  }
  return el;
}

/**
 * Ctrl / ⌘ + click: the object of a group under the pointer — the innermost group's, so it is moved
 * within its group straight away (Inkscape's Ctrl+click selects it, but a Ctrl+drag there only
 * moves along an axis) — or, outside groups, the part of a drawing. Ctrl+click on that object again:
 * the part of the drawing it is.
 */
function memberAt(el: Element): Element | null {
  let part: Element | null = null;
  for (let e: Element | null = el; e && e !== document.body && !e.classList?.contains('slide'); e = e.parentElement ?? (e.parentNode as Element | null)) {
    if (!srcOf.has(e)) continue;
    if (isSvgPart(e)) { part ??= e; continue; }
    if (groupOf(e)) return part && selected.length === 1 && selected[0] === e ? part : e;
  }
  return part;
}

/* ------------------------------------------------------------------ the selection as the editor sees it */

function label(el: Element): string {
  const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (t) return t.slice(0, 40);
  return el.localName === 'img' || el.classList.contains('ol-crop') ? 'Picture' : el.localName === 'svg' ? 'Drawing' : 'Shape';
}

/** the shape an SVG's paint is read from: the element itself, or the first shape in it */
function paintTarget(el: Element): Element {
  if (el.localName !== 'svg') return el;
  return Array.from(el.querySelectorAll('rect, circle, ellipse, polygon, path, polyline, line, text')).find(s => !s.closest('defs, marker, symbol, clipPath, mask')) ?? el;
}

const dashOf = (style: string, array: string): SelStyle['dash'] => {
  if (style === 'none') return 'none';
  if (style === 'dotted') return 'dotted';
  if (style === 'dashed') return 'dashed';
  if (array && array !== 'none') { const n = array.split(/[\s,]+/).map(parseFloat); return n[0] <= 2 ? 'dotted' : 'dashed'; }
  return 'solid';
};

/** CSS px of the slide per user unit of an SVG shape: its stroke widths are in user units, the toolbar's in points */
export function userScale(el: Element): number {
  // (the shapes the toolbar draws keep their outline's width however they are stretched: it is in CSS px)
  if ((el.getAttribute('vector-effect') ?? cs(el).getPropertyValue('vector-effect')) === 'non-scaling-stroke') return 1;
  const m = (el as SVGGraphicsElement).getScreenCTM?.();
  if (!m) return 1;
  const s = slideOf(el);
  const k = s && s.offsetWidth ? s.getBoundingClientRect().width / s.offsetWidth : 1;
  return Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) / k || 1;
}

const LENGTH_PX: Record<string, number> = { px: 1, pt: 4 / 3, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 };

/**
 * A length the element's own style attribute gives (the first of `props` it has), in CSS px — read
 * from the source because Chrome's computed border widths are snapped to device pixels (1 pt read
 * back as ¾ pt).
 */
export function declaredPx(el: Element, props: string[]): number | null {
  const style = srcOf.get(el)?.getAttribute('style') ?? '';
  for (const p of props) {
    const m = new RegExp(`(?:^|;)\\s*${p}\\s*:([^;]*)`, 'i').exec(style);
    const len = m && /(-?[\d.]+)(px|pt|pc|mm|cm|in)\b/i.exec(m[1]);
    if (len) return Number(len[1]) * LENGTH_PX[len[2].toLowerCase()];
  }
  return null;
}

function styleOf(el: Element): SelStyle {
  const c = cs(el);
  const fl = flipsOf(el);
  const svgish = el.localName === 'svg' || isSvgPart(el);
  let fill: string | null = null, stroke: string | null = null, strokeWidth = 0, dash: SelStyle['dash'] = 'none';
  let arrowStart = false, arrowEnd = false;
  if (svgish) {
    const t = paintTarget(el);
    const tc = cs(t);
    fill = tc.fill && tc.fill !== 'none' ? tc.fill : null;
    stroke = tc.stroke && tc.stroke !== 'none' ? tc.stroke : null;
    strokeWidth = stroke ? (parseFloat(tc.strokeWidth) || 1) * userScale(t) : 0;
    dash = stroke ? dashOf('solid', tc.strokeDasharray) : 'none';
    arrowStart = !!t.getAttribute('marker-start');
    arrowEnd = !!t.getAttribute('marker-end');
  } else {
    fill = c.backgroundColor !== 'rgba(0, 0, 0, 0)' ? c.backgroundColor : null;
    const bw = parseFloat(c.borderTopWidth) > 0 ? declaredPx(el, ['border-top-width', 'border-width', 'border-top', 'border']) ?? parseFloat(c.borderTopWidth) : 0;
    stroke = c.borderTopStyle !== 'none' && bw > 0 ? c.borderTopColor : null;
    strokeWidth = stroke ? bw : 0;
    dash = stroke ? dashOf(c.borderTopStyle, '') : 'none';
  }
  return {
    fontSize: c.fontSize, fontFamily: c.fontFamily, fontWeight: c.fontWeight, fontStyle: c.fontStyle, textDecoration: c.textDecorationLine,
    color: c.color, background: c.backgroundColor, textAlign: c.textAlign, borderRadius: c.borderTopLeftRadius, opacity: c.opacity,
    border: `${c.borderTopWidth} ${c.borderTopStyle} ${c.borderTopColor}`,
    fill, stroke, strokeWidth, dash, rotate: isSvgPart(el) ? Math.round((partBox(el)?.form.a ?? 0) * 1800 / Math.PI) / 10 : angleOf(el), flipX: fl.x, flipY: fl.y,
    shadow: c.boxShadow !== 'none' || (c.filter ?? '').includes('drop-shadow'), arrowStart, arrowEnd, lineHeight: c.lineHeight,
  };
}

function pictureSrc(el: Element): string | undefined {
  const img = el.localName === 'img' ? el : el.querySelector('img');
  const s = img ? srcOf.get(img) : null;
  return s?.getAttribute('src') ?? undefined;
}

function item(el: Element): SelItem | null {
  const path = pathOf(el);
  if (!path) return null;
  const s = slideOf(el);
  const kind = kindOf(el);
  return {
    path, tag: el.localName, label: label(el), rect: docRect(el), movable: movable(el), text: isTextual(el), fixedHeight: fixedHeight(el), style: styleOf(el),
    slide: s ? slides().indexOf(s) : -1,
    kind, locked: isLocked(el), cropped: el.classList.contains('ol-crop'), canText: canType(el),
    src: kind === 'image' ? pictureSrc(el) : undefined,
    list: listOf(el),
  };
}

/** the list an object is, or the one list it holds (its items can appear one by one) */
function listOf(el: Element): SelItem['list'] {
  const l = el.localName === 'ul' || el.localName === 'ol' ? el : el.querySelectorAll(':scope > ul, :scope > ol').length === 1 ? el.querySelector(':scope > ul, :scope > ol') : null;
  const p = l && pathOf(l);
  return p ? { path: p, steps: l!.hasAttribute('data-steps') ? stepOf(l!.getAttribute('data-steps')) : null } : undefined;
}

export function report(): void {
  if (state.version === null) return;
  // the original of a changed object, faintly where it was (review.ts)
  showGhost(selected.length === 1 && !editing ? selected[0] : null);
  post({ ol: 'selection', version: state.version, items: selected.map(item).filter((x): x is SelItem => !!x) });
  // what Ctrl+C copies, ready for the editor (the keyboard is mostly there)
  postClip(editing ? [] : selected);
  // (the Animation pane and the Objects pane follow the selection's slide)
  postSequence();
  postObjects();
}

/* ------------------------------------------------------------------ drawing */

let hoverEl: Element | null = null;
let guides: { axis: 'x' | 'y'; at: number; from: number; to: number }[] = [];
let drawBox: Rect | null = null;
let dropBox: Rect | null = null;

const frameAt = (cls: string, b: Box, extra = '') =>
  `<div class="${cls}" style="left:${b.cx - b.w / 2}px;top:${b.cy - b.h / 2}px;width:${b.w}px;height:${b.h}px;${b.a ? `transform:rotate(${b.a}deg);` : ''}${extra}"></div>`;

/** where a handle of a box is: (fx, fy) in 0…1 of its own axes */
const handleAt = (b: Box, fx: number, fy: number): [number, number] => {
  const [x, y] = rot((fx - 0.5) * b.w, (fy - 0.5) * b.h, b.a);
  return [b.cx + x, b.cy + y];
};

/** the four corners of a (rotated) box */
const cornersOf = (b: Box): [number, number][] => [handleAt(b, 0, 0), handleAt(b, 1, 0), handleAt(b, 0, 1), handleAt(b, 1, 1)];

const SVG_PART_NAMES: Record<string, string> = { path: 'path', rect: 'rectangle', circle: 'circle', ellipse: 'ellipse', line: 'line', polyline: 'polyline', polygon: 'polygon', text: 'text', tspan: 'text', g: 'group', use: 'symbol', image: 'picture' };
const KIND_NAMES: Record<ObjKind, [string, string]> = {
  text: ['Text', 'texts'], shape: ['Shape', 'shapes'], line: ['Line', 'lines'], image: ['Picture', 'pictures'], svg: ['SVG', 'SVGs'],
  svgpart: ['SVG part', 'SVG parts'], group: ['Group', 'groups'], formula: ['Formula', 'formulas'], ink: ['Ink', 'strokes'], other: ['Object', 'objects'],
};
const OTHER_NAMES: Record<string, string> = { video: 'Video', audio: 'Audio', canvas: 'Canvas', iframe: 'Embedded page', object: 'Embedded object', embed: 'Embedded object', table: 'Table' };

/** what is selected, in a word or two: "SVG", "SVG ▸ path", "Picture", "3 shapes", "2 objects" (the toolbar's sections are named the same) */
export function selectionLabel(els: Element[]): string {
  if (!els.length) return '';
  const kinds = els.map(kindOf);
  if (els.length > 1) {
    const k = kinds[0];
    return kinds.every(x => x === k) ? `${els.length} ${KIND_NAMES[k][1]}` : `${els.length} objects`;
  }
  const el = els[0], k = kinds[0];
  // (named objects by their names: data-ol-name, or a drawing's part by its id)
  const own = el.getAttribute('data-ol-name') ?? (k === 'svgpart' ? el.id : '');
  if (k === 'svgpart') return `SVG ▸ ${own || (SVG_PART_NAMES[el.localName] ?? el.localName)}`;
  const name = k === 'line' && el.localName === 'svg' && !lineOf(el) ? 'Drawing' : k === 'other' ? OTHER_NAMES[el.localName] ?? 'Object' : KIND_NAMES[k][0];
  const named = own ? `${name} · ${own}` : name;
  // an object of a group: where it is
  return groupOf(el) ? `Group ▸ ${named}` : named;
}

/** a word for what an element is (the Objects pane's), "Path", "Group", "Text" */
export function kindWord(el: Element): string {
  const k = kindOf(el);
  if (k === 'svgpart') { const n = SVG_PART_NAMES[el.localName] ?? el.localName; return n[0].toUpperCase() + n.slice(1); }
  if (k === 'line' && el.localName === 'svg' && !lineOf(el)) return 'Drawing';
  if (k === 'other') return OTHER_NAMES[el.localName] ?? 'Object';
  return KIND_NAMES[k][0];
}

const RESIZE_CURSORS = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'];
const HANDLE_ANGLE: Record<string, number> = { e: 0, se: 45, s: 90, sw: 135, w: 180, nw: 225, n: 270, ne: 315 };
const cursorFor = (h: string, a: number) => RESIZE_CURSORS[(((Math.round((HANDLE_ANGLE[h] + a) / 45) % 4) + 4) % 4)];

/** a line's two ends (document px) */
function lineEnds(line: SVGLineElement): [[number, number], [number, number]] | null {
  const m = line.getScreenCTM();
  if (!m) return null;
  const p = (x: number, y: number): [number, number] => [m.a * x + m.c * y + m.e + scrollX, m.b * x + m.d * y + m.f + scrollY];
  return [p(line.x1.baseVal.value, line.y1.baseVal.value), p(line.x2.baseVal.value, line.y2.baseVal.value)];
}

export function draw(): void {
  if (!layer) return;
  // the four-way arrows over an object a drag would move (not over the text being retyped)
  const over = !!hoverEl && hoverEl.isConnected && !editing && !drag && tool === 'select' && movable(hoverEl) && !isLocked(hoverEl) && !isCropping() && !isNodeEditing();
  document.documentElement.classList.toggle('ol-over-obj', over);
  if (isCropping() || isNodeEditing()) { layer.innerHTML = ''; return; }
  const h = 8 / scale;
  layer.style.setProperty('--h', `${h}px`);
  layer.style.setProperty('--s', String(1 / scale));
  const parts: string[] = [];
  const bw = 1.5 / scale;
  if (hoverEl && !selected.includes(hoverEl) && hoverEl.isConnected && !editing) parts.push(frameAt('hover', boxOf(hoverEl), `outline-width:${1 / scale}px`));
  drawnCarets = [];
  for (const p of peers) {
    const color = safeColor(p.color);
    // the text they retype: their caret carries the name
    const typing = p.caret ? liveAt(p.caret.path) : null;
    for (const path of p.paths) {
      const el = liveAt(path);
      if (!el || !shown(el)) continue;
      const r = docRect(el);
      parts.push(`<div class="frame peer" data-ol-peer="${esc(p.name)}" style="left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;border-color:${color};border-width:${bw}px"></div>`);
      if (el !== typing) parts.push(`<div class="peer-tag" style="left:${r.x}px;top:${r.y}px;background:${color};color:${inkOn(color)}">${esc(p.name)}</div>`);
    }
    if (typing && shown(typing)) parts.push(peerCaret(typing, p));
  }
  // suggestions and comment pins (review.ts): on the slide shown, on a web page all
  const rv = reviewOverlay(isSolo() ? slides()[soloIndex()] ?? null : null, boxOf, selected);
  parts.push(rv.under);
  // the steps objects appear and disappear at when presenting (beamer's overlays), as PowerPoint numbers its animations (animate.ts)
  if (!editing) parts.push(badges());
  // the objects of one group selected: the group's box, dashed (where a click on the others stays)
  const ctx = selected.length && !editing ? groupOf(selected[0]) : null;
  if (ctx && selected.every(el => groupOf(el) === ctx)) parts.push(frameAt('frame ctx', boxOf(ctx), `border-width:${bw}px`));
  for (const el of selected) {
    if (!el.isConnected) continue;
    const b = boxOf(el);
    const locked = isLocked(el);
    parts.push(frameAt(`frame${el === editing ? ' editing' : ''}${locked ? ' locked' : ''}`, b, `border-width:${bw}px`));
    if (locked) { const [x, y] = handleAt(b, 1, 0); parts.push(`<div class="lock" style="left:${x}px;top:${y}px">🔒</div>`); }
  }
  // what is selected, in a word, at its top left corner (the toolbar's section is named the same)
  const live = selected.filter(e => e.isConnected);
  if (live.length && !(drag?.moved && drag.kind !== 'marquee')) {
    let x = Infinity, y = Infinity;
    for (const el of live) { const c = cornersOf(boxOf(el)); for (const [cx, cy] of c) { x = Math.min(x, cx); y = Math.min(y, cy); } }
    const cls = live.some(e => e === editing) ? ' editing' : live.every(isLocked) ? ' locked' : '';
    parts.push(`<div class="tag${cls}" data-ol-kind style="left:${x}px;top:${y}px">${esc(selectionLabel(live))}</div>`);
  }
  if (rotating && !(selected.length === 1 && selected[0] === rotating && !editing)) rotating = null;
  if (selected.length === 1 && !editing && selected[0].isConnected && !isLocked(selected[0]) && !drag?.moved) {
    const el = selected[0];
    const line = lineOf(el);
    const ends = line ? lineEnds(line) : null;
    if (ends) {
      ends.forEach(([x, y], i) => parts.push(`<div class="handle end" data-h="p${i}" style="left:${x}px;top:${y}px;border-width:${bw}px"></div>`));
    } else {
      const b = boxOf(el);
      const fixed = fixedHeight(el) || isSvgPart(el);
      const hs: [string, number, number][] = [['nw', 0, 0], ['ne', 1, 0], ['sw', 0, 1], ['se', 1, 1], ['w', 0, 0.5], ['e', 1, 0.5]];
      if (fixed) hs.push(['n', 0.5, 0], ['s', 0.5, 1]);
      if (rotating === el && rotatable(el)) {
        // the second click: a rotation arrow off each corner (any of them turns it about its centre), the centre marked
        const off = 9 / scale;
        for (const [k, fx, fy, a] of [['nw', 0, 0, -45], ['ne', 1, 0, 45], ['se', 1, 1, 135], ['sw', 0, 1, -135]] as [string, number, number, number][]) {
          const [x, y] = handleAt(b, fx, fy);
          const [ox, oy] = rot((fx - 0.5) * 2 * off * Math.SQRT1_2, (fy - 0.5) * 2 * off * Math.SQRT1_2, b.a);
          parts.push(`<div class="handle rot4" data-h="rot" data-corner="${k}" style="left:${x + ox}px;top:${y + oy}px;transform:rotate(${a + b.a}deg)"></div>`);
        }
        parts.push(`<div class="rot-centre" style="left:${b.cx}px;top:${b.cy}px"></div>`);
      } else if (!isSvgPart(el) || partBox(el)) for (const [k, fx, fy] of hs) { const [x, y] = handleAt(b, fx, fy); parts.push(`<div class="handle" data-h="${k}" style="left:${x}px;top:${y}px;cursor:${cursorFor(k, b.a)};border-width:${bw}px"></div>`); }
    }
  }
  for (const g of guides) {
    parts.push(g.axis === 'x'
      ? `<div class="guide" style="left:${g.at}px;top:${g.from}px;width:${1 / scale}px;height:${g.to - g.from}px"></div>`
      : `<div class="guide" style="left:${g.from}px;top:${g.at}px;width:${g.to - g.from}px;height:${1 / scale}px"></div>`);
  }
  if (drawBox) parts.push(`<div class="draw" style="left:${drawBox.x}px;top:${drawBox.y}px;width:${drawBox.w}px;height:${drawBox.h}px;border-width:${bw}px"></div>`);
  if (dropBox) parts.push(`<div class="drop" style="left:${dropBox.x}px;top:${dropBox.y}px;width:${dropBox.w}px;height:${dropBox.h}px;border-width:${3 / scale}px"></div>`);
  // (Draw's strokes are drawn in the page itself, as they will stay: startInk)
  if (drag && drag.kind === 'draw' && (tool === 'line' || tool === 'arrow') && drag.pts && drag.moved) {
    const d = `M${drag.pts[0][0]} ${drag.pts[0][1]}L${drag.pts[drag.pts.length - 1][0]} ${drag.pts[drag.pts.length - 1][1]}`;
    parts.push(`<svg class="ink" width="1" height="1"><path d="${d}" fill="none" stroke="#2f6fde" stroke-width="${3 / scale}" stroke-linecap="round" stroke-linejoin="round"/></svg>`);
  }
  // a list's grips (listdrag.ts) — not while the box itself is dragged
  if (!drag || listDragging()) parts.push(listParts());
  // the comment pins over everything (they are pressed)
  parts.push(rv.pins);
  layer.innerHTML = parts.join('');
  bindListGrips(layer);
  for (const hd of Array.from(layer.querySelectorAll('.handle'))) hd.addEventListener('pointerdown', e => onHandleDown(e as PointerEvent, (hd as HTMLElement).dataset.h!), true);
  bindPins(layer, el => { if (editing) stopText(); selected = [el]; report(); draw(); });
}

/** rotated by its round handle: a box on a slide, a picture, a drawing (not the flow of a web page) */
function rotatable(el: Element): boolean {
  if (isSvgPart(el)) return !!partBox(el);
  if (!movable(el)) return false;
  return el instanceof HTMLElement || el.localName === 'svg';
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);



/* ------------------------------------------------------------------ pointer */

function swallow(e: MouseEvent): void {
  if (editing && editing.contains(e.target as Node)) return;
  // links and buttons of the page do nothing while editing it
  e.preventDefault();
  e.stopPropagation();
}

function onHover(e: PointerEvent): void {
  if (isCropping() || isNodeEditing() || listDragging()) return;
  if (hoverList(e, host)) draw();
  if (isPenDrawing() && e.pointerType !== 'touch') { penMove(e); return; }
  if (e.pointerType === 'touch') { onTouchMove(e); return; }
  if (drag || editing) return;
  const t = e.target as Element;
  const el = (tool === 'select' || isOrdering()) && t && !isForeign(t) ? objectFor(t, e.ctrlKey || e.metaKey, { x: e.clientX, y: e.clientY }) : null;
  if (el !== hoverEl) { hoverEl = el; setReviewHover(el); draw(); }
}

interface DragEl {
  el: HTMLElement; r0: Rect; left0: number; top0: number; w0: number; h0: number; inline: Map<string, string>; transform0: string | null; angle: number;
  /** a cropped picture's own picture (resized with its frame) */
  inner?: { img: HTMLElement; l: number; t: number; w: number };
  /** a group's objects (those of the groups in it too), scaled with it when it is resized */
  members?: DragEl[];
  /** a part of a drawing moved, resized and turned through its transform (partBox) */
  part?: { box: Box; form: PartForm; P: DOMMatrix; Pinv: DOMMatrix; flip: number };
}
interface Drag {
  kind: 'move' | 'resize' | 'rotate' | 'end' | 'draw' | 'pen' | 'erase' | 'marquee' | 'pan';
  /** the eraser's strokes so far (hidden until the release removes them) */
  erased?: Element[];
  x0: number; y0: number;
  els: DragEl[];
  handle?: string;
  slide?: HTMLElement | null;
  moved: boolean;
  /** Alt+drag: a copy is moved, the original stays */
  copy?: boolean;
  /** the object pressed on (a click without a drag on one of several selected selects it alone) */
  clicked?: Element;
  /** the press was on the object that was already the only one selected: a click switches its handles (Inkscape) */
  again?: boolean;
  /** a finger's pan begun on an object not selected: a tap selects it */
  tap?: Element;
  /** the editor was told that something is being dragged (its quick menu steps aside) */
  told?: boolean;
  pts?: [number, number][];
  /** the rotation drag's centre and starting angles */
  rot?: { cx: number; cy: number; a0: number; p0: number };
  last?: { x: number; y: number };
  /** the pointer's last place on the screen (a finger's pan: the frame's own px change as the slide moves) */
  ls?: { x: number; y: number };
  pointerId?: number;
  pointerType?: string;
  hold?: ReturnType<typeof setTimeout>;
}
let drag: Drag | null = null;

/**
 * The pointer kept by the page while it is held (a drag leaving the frame keeps going) — captured by
 * the element pressed, not by <html>: a capturing element becomes the target of the click and the
 * double click that follow, and those must still land on the object (double-click to retype it).
 */
function grab(e: PointerEvent): void {
  const t = e.composedPath()[0];
  const el = t instanceof Element ? t : document.documentElement;
  try { el.setPointerCapture(e.pointerId); } catch { /* not capturable (synthetic) */ }
}

function onPointerDown(e: PointerEvent): void {
  if (isCropping() || isNodeEditing() || listDragging()) return;
  notePointer(e);
  // keys typed after leaving a formula, before this press: theirs first
  flushAfter();
  if (e.pointerType === 'pen') penLands(e);
  if (e.pointerType === 'touch') {
    // the hand resting on the screen while the Pencil writes: not a finger (palm rejection)
    if (isPalm(e)) { palms.add(e.pointerId); e.preventDefault(); e.stopPropagation(); return; }
    const now = performance.now();
    // three fingers come down together; one coming down well after two others is the hand
    if (touches.size === 2 && !tri && fingersPan() && now - Math.min(...[...touches.values()].map(t => t.t0 ?? now)) > 250) { palms.add(e.pointerId); e.preventDefault(); e.stopPropagation(); return; }
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.screenX, sy: e.screenY, t0: now });
    if (touches.size >= 3 || tri) { e.preventDefault(); e.stopPropagation(); if (!tri) startTri(); return; }
    if (touches.size >= 2) { e.preventDefault(); e.stopPropagation(); startPinch(); return; }
  }
  if (e.button !== 0) return;
  const t = e.target as Element;
  if (t === host) return;   // a handle (in the shadow root) handles itself
  if (editing) {
    const chipEl = t.closest?.('.ol-mathchip') as HTMLElement | null;
    // a formula of the text: LyX's formula editor, the cursor where it was clicked
    if (chipEl && editing.contains(chipEl)) { e.preventDefault(); e.stopPropagation(); openChip(chipEl, { x: e.clientX, y: e.clientY }); return; }
    if (editing.contains(t)) return;   // a click inside the text being retyped: the caret's
    stopText();
  }
  e.preventDefault();
  e.stopPropagation();
  // the Animation pane's click-in-order mode: the object clicked comes on the next click (Shift: the
  // same click as the one before; Ctrl / ⌘: the part of a drawing under the pointer) — animate.ts
  if (isOrdering()) { const el = objectFor(t, e.ctrlKey || e.metaKey); if (el && slideOf(el)) orderClick(el, e.shiftKey); return; }
  // the Bézier pen: a node per press (pathedit.ts)
  if (tool === 'bezier') { penDown(e, el => slideOf(el)); addEventListener('pointerup', penUpOnce, true); return; }
  grab(e);
  const x = e.pageX, y = e.pageY;
  const base = { x0: x, y0: y, els: [], moved: false, pointerId: e.pointerId, pointerType: e.pointerType, last: { x: e.clientX, y: e.clientY }, ls: { x: e.screenX, y: e.screenY } };
  // drawing with a Pencil: fingers move the slide, they do not draw (GoodNotes)
  if ((tool === 'pen' || tool === 'eraser') && e.pointerType === 'touch' && fingersPan()) {
    drag = { ...base, kind: 'pan', slide: slideOf(t) };
    capture();
    return;
  }
  if (tool === 'pen') {
    const slide = slideOf(t);
    drag = { ...base, kind: 'pen', slide, pts: [[x, y]] };
    startInk(e, slide);
    capture();
    return;
  }
  if (tool === 'eraser') {
    drag = { ...base, kind: 'erase', slide: slideOf(t), erased: [] };
    eraseAt(e, drag);
    capture();
    return;
  }
  if (tool !== 'select') {
    const slide = slideOf(t);
    drag = { ...base, kind: 'draw', slide, pts: [[x, y]] };
    capture();
    return;
  }
  const el = objectFor(t, e.ctrlKey || e.metaKey, { x: e.clientX, y: e.clientY });
  if (!el) {
    if (e.pointerType === 'touch') {
      // a finger on nothing pans; held still for a moment it draws a selection box instead
      drag = { ...base, kind: 'pan', slide: slideOf(t) };
      drag.hold = setTimeout(() => { if (drag && drag.kind === 'pan' && !drag.moved) { drag.kind = 'marquee'; selected = []; report(); draw(); } }, 450);
      capture();
      return;
    }
    if (!e.shiftKey) { selected = []; report(); }
    drag = { ...base, kind: 'marquee', slide: slideOf(t) };
    draw();
    capture();
    return;
  }
  if (e.shiftKey) {
    selected = selected.includes(el) ? selected.filter(s => s !== el) : [...selected, el];
    report(); draw();
    return;
  }
  // a finger on an object that is not selected moves the slide — swiped sideways, to the next one — as
  // in Keynote on an iPad (slides are mostly covered by their objects): a tap selects the object, and
  // held still for a moment it is picked up and moves with the finger
  if (e.pointerType === 'touch' && !selected.includes(el)) {
    const d: Drag = { ...base, kind: 'pan', slide: slideOf(t), tap: el };
    d.hold = setTimeout(() => {
      if (drag !== d || d.moved) return;
      selected = [el]; report(); draw();
      drag = { ...base, kind: 'move', els: selected.filter(s => movable(s) && !isLocked(s)).map(s => start(s as HTMLElement)), clicked: el, again: false };
    }, 450);
    drag = d;
    capture();
    return;
  }
  const again = selected.length === 1 && selected[0] === el;
  if (!selected.includes(el)) { selected = [el]; report(); }
  draw();
  const els = selected.filter(s => movable(s) && !isLocked(s)).map(s => start(s as HTMLElement));
  drag = { ...base, kind: 'move', els, copy: e.altKey, clicked: el, again };
  capture();
}

export function start(el: HTMLElement): DragEl {
  const c = cs(el);
  const r0 = docRect(el);
  const inline = new Map<string, string>();
  for (const p of ['left', 'top', 'right', 'bottom', 'width', 'height', 'position', 'rotate']) inline.set(p, el.style?.getPropertyValue(p) ?? '');
  const left0 = parseFloat(c.left), top0 = parseFloat(c.top);
  const he = el as HTMLElement;
  return {
    el, r0, left0: Number.isFinite(left0) ? left0 : 0, top0: Number.isFinite(top0) ? top0 : 0,
    w0: angleOf(el) ? he.offsetWidth ?? r0.w : parseFloat(c.width) || r0.w, h0: angleOf(el) ? he.offsetHeight ?? r0.h : parseFloat(c.height) || r0.h,
    inline, transform0: isSvgPart(el) ? el.getAttribute('transform') : null, angle: angleOf(el),
    inner: innerPicture(el), part: partDrag(el),
  };
}

function partDrag(el: Element): DragEl['part'] {
  const pb = isSvgPart(el) ? partBox(el) : null;
  if (!pb) return undefined;
  return { ...pb, Pinv: pb.P.inverse(), flip: pb.P.a * pb.P.d - pb.P.b * pb.P.c < 0 ? -1 : 1 };
}

function innerPicture(el: Element): DragEl['inner'] {
  if (!el.classList.contains('ol-crop')) return undefined;
  const img = Array.from(el.children).find(k => k.localName === 'img') as HTMLElement | undefined;
  if (!img) return undefined;
  const c = cs(img);
  return { img, l: parseFloat(c.left) || 0, t: parseFloat(c.top) || 0, w: parseFloat(c.width) || img.offsetWidth };
}

/** a live change undone (a drag given up: a second finger came) */
export function revertLive(d: DragEl): void {
  for (const m of d.members ?? []) revertLive(m);
  if (isSvgPart(d.el)) { if (d.transform0 === null) d.el.removeAttribute('transform'); else d.el.setAttribute('transform', d.transform0); return; }
  for (const [p, v] of d.inline) { if (v) d.el.style.setProperty(p, v); else d.el.style.removeProperty(p); }
  if (!d.el.getAttribute('style')) d.el.removeAttribute('style');
}

function onHandleDown(e: PointerEvent, handle: string): void {
  if (e.button !== 0 || selected.length !== 1) return;
  e.preventDefault();
  e.stopPropagation();
  grab(e);
  const el = selected[0] as HTMLElement;
  const base = { x0: e.pageX, y0: e.pageY, els: [start(el)], handle, moved: false, pointerId: e.pointerId, pointerType: e.pointerType };
  if (handle === 'rot') {
    const b = boxOf(el);
    drag = { ...base, kind: 'rotate', rot: { cx: b.cx, cy: b.cy, a0: b.a, p0: Math.atan2(e.pageY - b.cy, e.pageX - b.cx) * 180 / Math.PI } };
  } else if (handle === 'p0' || handle === 'p1') {
    drag = { ...base, kind: 'end' };
  } else {
    // a group: its objects grow and shrink with it (PowerPoint's)
    if (isGroup(el)) base.els[0].members = membersOf(el, true).map(start);
    drag = { ...base, kind: 'resize' };
  }
  capture();
}

/**
 * The groups the objects `els` are in, fitted to their objects again after these moved, changed
 * size or are going (`gone`): the group's box around what is in it, its objects' positions in it
 * shifted to match — nothing moves on the slide. As edits to commit after the objects' own (live
 * too, so a group around the group fits next). A group turned or flipped keeps its box.
 */
export function refitGroups(els: Element[], gone: Set<Element> = new Set()): HtmlOp[] {
  const ops: HtmlOp[] = [];
  const todo = [...new Set(els.map(groupOf).filter((g): g is HTMLElement => !!g && !gone.has(g)))];
  const done = new Set<Element>();
  while (todo.length) {
    const g = todo.shift()!;
    if (done.has(g)) continue;
    done.add(g);
    const outer = groupOf(g);
    if (outer && !gone.has(outer)) todo.push(outer);
    const c = cs(g);
    if (angleOf(g) || (c.scale && c.scale !== 'none') || c.transform !== 'none') continue;
    const ms = membersOf(g).filter(m => !gone.has(m));
    if (!ms.length || ms.length !== Array.from(g.children).filter(k => srcOf.has(k) && !gone.has(k) && !isForeign(k)).length) continue;
    const rs = ms.map(m => { const r = docRect(m); const [x0, y0] = slidePoint(g, r.x, r.y), [x1, y1] = slidePoint(g, r.x + r.w, r.y + r.h); return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }; });
    const u = union(rs);
    if (Math.abs(u.x) < 0.5 && Math.abs(u.y) < 0.5 && Math.abs(u.w - g.offsetWidth) < 0.5 && Math.abs(u.h - g.offsetHeight) < 0.5) continue;
    for (const m of ms) {
      const d = start(m);
      if (Math.abs(u.x) >= 0.5) m.style.setProperty('left', `${d.left0 - u.x}px`);
      if (Math.abs(u.y) >= 0.5) m.style.setProperty('top', `${d.top0 - u.y}px`);
      const op = styleOp(d);
      if (op) ops.push(op);
    }
    const d = start(g);
    g.style.setProperty('left', `${d.left0 + u.x}px`);
    g.style.setProperty('top', `${d.top0 + u.y}px`);
    g.style.setProperty('width', `${u.w}px`);
    g.style.setProperty('height', `${u.h}px`);
    const op = styleOp(d);
    if (op) ops.push(op);
  }
  return ops;
}

function capture(): void {
  addEventListener('pointermove', onDragMove, true);
  addEventListener('pointerup', onDragEnd, true);
  addEventListener('pointercancel', onDragEnd, true);
}

function release(): void {
  removeEventListener('pointermove', onDragMove, true);
  removeEventListener('pointerup', onDragEnd, true);
  removeEventListener('pointercancel', onDragEnd, true);
  document.documentElement.classList.remove('ol-dragging');
  if (dragCss) dragCss.textContent = '';
}

const SNAP = 6;

/** where a moved box snaps: the slide's edges and middle, the other objects' edges and middles */
function snap(r: Rect, skip: Set<Element>, slide: HTMLElement | null, axisMoves: { x: boolean; y: boolean }): { dx: number; dy: number } {
  guides = [];
  if (!slide) return { dx: 0, dy: 0 };
  const t = SNAP / scale;
  const sr = docRect(slide);
  const xs: number[] = [sr.x, sr.x + sr.w / 2, sr.x + sr.w];
  const ys: number[] = [sr.y, sr.y + sr.h / 2, sr.y + sr.h];
  for (const c of Array.from(slide.children)) {
    if (skip.has(c) || isForeign(c) || !srcOf.has(c)) continue;
    const q = docRect(c);
    if (!q.w || !q.h) continue;
    xs.push(q.x, q.x + q.w / 2, q.x + q.w);
    ys.push(q.y, q.y + q.h / 2, q.y + q.h);
  }
  let dx = 0, dy = 0, bx = t + 1, by = t + 1, gx: number | null = null, gy: number | null = null;
  if (axisMoves.x) for (const v of [r.x, r.x + r.w / 2, r.x + r.w]) for (const s of xs) { const d = s - v; if (Math.abs(d) < bx) { bx = Math.abs(d); dx = d; gx = s; } }
  if (axisMoves.y) for (const v of [r.y, r.y + r.h / 2, r.y + r.h]) for (const s of ys) { const d = s - v; if (Math.abs(d) < by) { by = Math.abs(d); dy = d; gy = s; } }
  if (bx > t) { dx = 0; gx = null; }
  if (by > t) { dy = 0; gy = null; }
  if (gx !== null) guides.push({ axis: 'x', at: gx, from: sr.y, to: sr.y + sr.h });
  if (gy !== null) guides.push({ axis: 'y', at: gy, from: sr.x, to: sr.x + sr.w });
  return { dx, dy };
}

function onDragMove(e: PointerEvent): void {
  if (!drag || (drag.pointerId !== undefined && e.pointerId !== drag.pointerId)) return;
  if (pinch) return;
  if (drag.kind === 'erase') { eraseAt(e, drag); return; }
  if (drag.kind === 'pen') { if (Math.hypot(e.pageX - drag.x0, e.pageY - drag.y0) * scale >= 1) drag.moved = true; moveInk(e); return; }
  const dx = e.pageX - drag.x0, dy = e.pageY - drag.y0;
  if (!drag.moved && Math.hypot(dx, dy) * scale < (drag.pointerType === 'touch' ? 6 : 3)) return;
  if (!drag.moved) {
    drag.moved = true;
    if (drag.hold) clearTimeout(drag.hold);
    if (drag.kind === 'move' || drag.kind === 'resize' || drag.kind === 'rotate' || drag.kind === 'end') { drag.told = true; post({ ol: 'dragging', on: true }); }
    if (drag.kind !== 'pan') {
      document.documentElement.classList.add('ol-dragging');
      // the cursor of what is dragged stays on wherever the pointer goes (Safari keeps the cursor it had at the press)
      const b = drag.kind === 'resize' && drag.els[0] ? boxOf(drag.els[0].el) : null;
      const cur = drag.kind === 'move' || drag.kind === 'end' ? MOVE_CURSOR : drag.kind === 'rotate' ? ROT_CURSOR : b && drag.handle ? cursorFor(drag.handle, b.a) : drag.kind === 'draw' ? 'crosshair' : '';
      if (dragCss && cur) dragCss.textContent = `html.ol-dragging, html.ol-dragging * { cursor: ${cur} !important; }`;
    }
  }
  if (drag.kind === 'pan') {
    // in the screen's px: the frame moves under the finger, its own px would take back each step the step before made
    const last = drag.last ?? { x: e.clientX, y: e.clientY }, ls = drag.ls ?? { x: e.screenX, y: e.screenY };
    if (isSolo()) post({ ol: 'pan', dx: e.screenX - ls.x, dy: e.screenY - ls.y, finger: true, screen: true });
    else scrollBy(0, last.y - e.clientY);
    if (!isSolo() && ls.x !== e.screenX) post({ ol: 'pan', dx: e.screenX - ls.x, screen: true });
    drag.last = { x: e.clientX, y: e.clientY };
    drag.ls = { x: e.screenX, y: e.screenY };
    return;
  }
  if (drag.kind === 'draw' || drag.kind === 'marquee') {
    drawBox = { x: Math.min(drag.x0, e.pageX), y: Math.min(drag.y0, e.pageY), w: Math.abs(dx), h: Math.abs(dy) };
    if (drag.kind === 'draw' && (tool === 'line' || tool === 'arrow')) {
      let ex = e.pageX, ey = e.pageY;
      // Shift: horizontal, vertical or at 45°
      if (e.shiftKey) { const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), l = Math.hypot(dx, dy); ex = drag.x0 + Math.cos(a) * l; ey = drag.y0 + Math.sin(a) * l; }
      drag.pts = [[drag.x0, drag.y0], [ex, ey]];
      drawBox = null;
    } else if (drag.kind === 'draw' && e.shiftKey && tool !== 'text' && tool !== 'formula') { const m = Math.max(drawBox.w, drawBox.h); drawBox = { x: drag.x0 + (dx < 0 ? -m : 0), y: drag.y0 + (dy < 0 ? -m : 0), w: m, h: m }; }
    draw();
    return;
  }
  if (drag.kind === 'move') {
    let ddx = dx, ddy = dy;
    if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) ddy = 0; else ddx = 0; }
    if (!e.ctrlKey && !e.metaKey && drag.els.length) {
      const u = union(drag.els.map(d => d.r0));
      const s = snap({ ...u, x: u.x + ddx, y: u.y + ddy }, new Set(drag.els.map(d => d.el)), slideOf(drag.els[0].el), { x: true, y: true });
      ddx += s.dx; ddy += s.dy;
    } else guides = [];
    for (const d of drag.els) placeLive(d, ddx, ddy);
  } else if (drag.kind === 'resize') {
    const d = drag.els[0];
    resizeLive(d, drag.handle!, dx, dy, e.shiftKey || d.el.localName === 'img' || d.el.classList.contains('ol-crop') || !!d.members, e.ctrlKey || e.metaKey);
  } else if (drag.kind === 'rotate') {
    const r = drag.rot!;
    let a = r.a0 + Math.atan2(e.pageY - r.cy, e.pageX - r.cx) * 180 / Math.PI - r.p0;
    a = ((a % 360) + 540) % 360 - 180;
    if (e.shiftKey) a = Math.round(a / 15) * 15;
    else for (const k of [-180, -90, 0, 90, 180]) if (Math.abs(a - k) < 3) a = k;
    if (Math.abs(a) === 180) a = 180;
    const pd = drag.els[0].part;
    if (pd) setForm(drag.els[0].el, { ...pd.form, a: pd.form.a + pd.flip * (a - r.a0) * Math.PI / 180 });
    else drag.els[0].el.style.setProperty('rotate', a ? `${Math.round(a * 10) / 10}deg` : '0deg');
  } else if (drag.kind === 'end') {
    const line = lineOf(drag.els[0].el);
    if (line) {
      const m = line.getScreenCTM();
      if (m) {
        const inv = m.inverse();
        const cx = e.clientX, cy = e.clientY;
        const ux = inv.a * cx + inv.c * cy + inv.e, uy = inv.b * cx + inv.d * cy + inv.f;
        line.setAttribute(drag.handle === 'p0' ? 'x1' : 'x2', String(Math.round(ux * 10) / 10));
        line.setAttribute(drag.handle === 'p0' ? 'y1' : 'y2', String(Math.round(uy * 10) / 10));
      }
    }
  }
  draw();
}

export function union(rs: Rect[]): Rect {
  const x = Math.min(...rs.map(r => r.x)), y = Math.min(...rs.map(r => r.y));
  return { x, y, w: Math.max(...rs.map(r => r.x + r.w)) - x, h: Math.max(...rs.map(r => r.y + r.h)) - y };
}

/** moved by (dx, dy) document px, live */
export function placeLive(d: DragEl, dx: number, dy: number): void {
  if (d.part) {
    const m = d.part.Pinv, f = d.part.form;
    setForm(d.el, { ...f, p: [f.p[0] + m.a * dx + m.c * dy, f.p[1] + m.b * dx + m.d * dy] });
    return;
  }
  if (isSvgPart(d.el)) {
    // in the coordinates of the shape's parent: a translate before what it had
    const parent = d.el.parentNode as SVGGraphicsElement;
    const m = parent?.getScreenCTM?.();
    if (!m) return;
    const inv = m.inverse();
    const ux = inv.a * dx + inv.c * dy, uy = inv.b * dx + inv.d * dy;
    const t = `translate(${Math.round(ux * 100) / 100} ${Math.round(uy * 100) / 100})`;
    d.el.setAttribute('transform', d.transform0 ? `${t} ${d.transform0}` : t);
    return;
  }
  const st = d.el.style;
  if (cs(d.el).position === 'static' && !d.inline.get('position')) st.setProperty('position', 'relative');
  const relStatic = st.getPropertyValue('position') === 'relative' && !d.inline.get('position');
  const l0 = relStatic ? 0 : d.left0, t0 = relStatic ? 0 : d.top0;
  st.setProperty('left', `${l0 + dx}px`);
  st.setProperty('top', `${t0 + dy}px`);
}

/** a part of a drawing resized by a handle: scaled in its own axes, the opposite side where it was */
function resizePart(d: DragEl, h: string, dx: number, dy: number, keepRatio: boolean): void {
  const { box: b, form: f, Pinv } = d.part!;
  guides = [];
  const [ldx, ldy] = b.a ? rot(dx, dy, -b.a) : [dx, dy];
  let w = b.w, hh = b.h;
  if (h.includes('e')) w = b.w + ldx;
  if (h.includes('w')) w = b.w - ldx;
  if (h.includes('s')) hh = b.h + ldy;
  if (h.includes('n')) hh = b.h - ldy;
  if (keepRatio && h.length === 2 && b.w > 0 && b.h > 0) hh = w * (b.h / b.w);
  const min = 2 / scale;
  w = Math.max(min, w); hh = Math.max(min, hh);
  const kx = b.w > 0 ? w / b.w : 1, ky = b.h > 0 ? hh / b.h : 1;
  const sx = h.includes('e') ? 1 : h.includes('w') ? -1 : 0, sy = h.includes('s') ? 1 : h.includes('n') ? -1 : 0;
  const [ox, oy] = rot(sx * (w - b.w) / 2, sy * (hh - b.h) / 2, b.a);
  const c = Pinv.transformPoint(new DOMPoint(b.cx + ox, b.cy + oy));
  setForm(d.el, { ...f, sx: f.sx * kx, sy: f.sy * ky, p: [c.x, c.y] });
}

function resizeLive(d: DragEl, h: string, dx: number, dy: number, keepRatio: boolean, noSnap: boolean): void {
  if (d.part) { resizePart(d, h, dx, dy, keepRatio); return; }
  // a rotated box: the drag in its own axes; the opposite side stays where it is on the page
  const a = d.angle;
  const [ldx, ldy] = a ? rot(dx, dy, -a) : [dx, dy];
  let w = d.w0, hh = d.h0;
  if (h.includes('e')) w = d.w0 + ldx;
  if (h.includes('w')) w = d.w0 - ldx;
  if (h.includes('s')) hh = d.h0 + ldy;
  if (h.includes('n')) hh = d.h0 - ldy;
  if (keepRatio && h.length === 2 && d.w0 > 0 && d.h0 > 0) hh = w * (d.h0 / d.w0);
  w = Math.max(4, w); hh = Math.max(4, hh);
  let l: number, t: number;
  if (!a) {
    l = h.includes('w') ? d.left0 + (d.w0 - w) : d.left0;
    t = h.includes('n') ? d.top0 + (d.h0 - hh) : d.top0;
    if (!noSnap) {
      const r = { x: d.r0.x + (l - d.left0), y: d.r0.y + (t - d.top0), w: w + (d.r0.w - d.w0), h: hh + (d.r0.h - d.h0) };
      const s = snap(r, new Set([d.el]), slideOf(d.el), { x: true, y: true });
      if (h.includes('e')) w += s.dx; else if (h.includes('w')) { w -= s.dx; l += s.dx; }
      if (h.includes('s')) hh += s.dy; else if (h.includes('n')) { hh -= s.dy; t += s.dy; }
    } else guides = [];
  } else {
    guides = [];
    const sx = h.includes('e') ? 1 : h.includes('w') ? -1 : 0, sy = h.includes('s') ? 1 : h.includes('n') ? -1 : 0;
    const [cx, cy] = rot(sx * (w - d.w0) / 2, sy * (hh - d.h0) / 2, a);
    l = d.left0 + cx - (w - d.w0) / 2;
    t = d.top0 + cy - (hh - d.h0) / 2;
  }
  const st = d.el.style;
  st.setProperty('width', `${w}px`);
  if (fixedHeight(d.el) || h === 'n' || h === 's') st.setProperty('height', `${hh}px`);
  if (d.inner && d.w0 > 0) {
    // a cropped picture grows with its frame (what shows of it stays the same)
    const k = w / d.w0;
    d.inner.img.style.setProperty('left', `${d.inner.l * k}px`);
    d.inner.img.style.setProperty('top', `${d.inner.t * k}px`);
    d.inner.img.style.setProperty('width', `${d.inner.w * k}px`);
  }
  if (d.members && d.w0 > 0 && d.h0 > 0) {
    const kx = w / d.w0, ky = fixedHeight(d.el) || h === 'n' || h === 's' ? hh / d.h0 : 1;
    for (const m of d.members) {
      const ms = m.el.style;
      ms.setProperty('left', `${m.left0 * kx}px`);
      ms.setProperty('top', `${m.top0 * ky}px`);
      ms.setProperty('width', `${m.w0 * kx}px`);
      if (fixedHeight(m.el)) ms.setProperty('height', `${m.h0 * ky}px`);
    }
  }
  const pos = cs(d.el).position;
  if (pos !== 'static' && (h.includes('w') || h.includes('n') || a)) { st.setProperty('left', `${l}px`); st.setProperty('top', `${t}px`); }
}

function onDragEnd(e: PointerEvent): void {
  if (drag && drag.pointerId !== undefined && e.pointerId !== drag.pointerId) return;
  release();
  const d = drag;
  drag = null;
  guides = [];
  if (!d) return;
  if (d.hold) clearTimeout(d.hold);
  if (d.told) post({ ol: 'dragging', on: false });
  if (d.kind === 'pan') {
    if (d.moved && isSolo()) post({ ol: 'panEnd' });
    // a tap on nothing: the selection goes; on an object: that one is selected
    if (!d.moved && !e.shiftKey && e.type !== 'pointercancel') { selected = d.tap ? [d.tap] : []; report(); }
    draw();
    return;
  }
  if (d.kind === 'erase') {
    const gone = d.erased ?? [];
    if (e.type === 'pointercancel' || state.version === null) { for (const el of gone) (el as HTMLElement | SVGElement).style.visibility = ''; return; }
    // one change for the whole rub (one undo brings them all back)
    const paths = gone.map(pathOf).filter((p): p is Path => !!p);
    if (paths.length) commit([{ t: 'remove', paths }]);
    return;
  }
  if (d.kind === 'pen') { if (e.type === 'pointercancel') dropInk(); else endInk(e); return; }
  if (e.type === 'pointercancel') { for (const x of d.els) revertLive(x); drawBox = null; draw(); return; }
  if (d.kind === 'draw') {
    const box = drawBox;
    drawBox = null;
    draw();
    finishDraw(d, box, e);
    return;
  }
  if (d.kind === 'marquee') {
    const box = drawBox;
    drawBox = null;
    const scope = d.slide ?? (state.kind !== 'page' ? null : document.body);
    if (box && d.moved && scope) {
      const inside = Array.from(scope.children).filter(c => srcOf.has(c) && !isForeign(c) && !c.classList.contains('notes')).filter(c => { const r = docRect(c); return r.w && r.h && r.x < box.x + box.w && r.x + r.w > box.x && r.y < box.y + box.h && r.y + r.h > box.y; });
      selected = e.shiftKey ? [...new Set([...selected, ...inside])] : inside;
      report();
    }
    draw();
    return;
  }
  if (!d.moved) {
    // a click on one of several selected objects: that one alone (PowerPoint's); a drag would have moved them all
    if (d.kind === 'move' && d.clicked && selected.length > 1 && !e.shiftKey) { selected = [d.clicked]; report(); }
    // a click on the object already selected: resize handles ⇄ rotation arrows (Inkscape)
    else if (d.kind === 'move' && d.again && d.clicked && !e.shiftKey && rotatable(d.clicked) && !lineOf(d.clicked) && !isLocked(d.clicked)) rotating = rotating === d.clicked ? null : d.clicked;
    draw();
    return;
  }
  if (d.kind === 'rotate' && d.els[0]?.part) {
    const op = styleOp(d.els[0]);
    if (op) commit([op]);
    draw();
    return;
  }
  if (d.kind === 'rotate') {
    const x = d.els[0];
    const v = x.el.style.getPropertyValue('rotate');
    const a = parseFloat(v) || 0;
    const path = pathOf(x.el);
    if (path) commit([{ t: 'style', path, set: { rotate: a ? `${Math.round(a * 10) / 10}deg` : null } }, ...refitGroups([x.el])]);
    draw();
    return;
  }
  if (d.kind === 'end') {
    const op = lineOp(d.els[0].el);
    if (op) commit([op, ...refitGroups([d.els[0].el])]);
    draw();
    return;
  }
  if (d.copy && d.kind === 'move') { commitCopies(d.els); draw(); return; }
  const ops: HtmlOp[] = [];
  for (const x of d.els) {
    const op = styleOp(x);
    if (op) ops.push(op);
    if (d.kind === 'resize' && x.inner) {
      const ip = pathOf(x.inner.img);
      const ist = x.inner.img.style;
      if (ip) ops.push({ t: 'style', path: ip, set: { left: `${Math.round(parseFloat(ist.left))}px`, top: `${Math.round(parseFloat(ist.top))}px`, width: `${Math.round(parseFloat(ist.width))}px` } });
    }
    for (const m of x.members ?? []) { const op = styleOp(m); if (op) ops.push(op); }
  }
  // an object of a group moved or resized: the group fits around its objects again
  commit([...ops, ...refitGroups(d.els.map(x => x.el))]);
  draw();
}

/** Alt+drag: copies where the drag ended, the originals back where they were */
function commitCopies(els: DragEl[]): void {
  const byParent: { path: Path; html: string }[] = [];
  for (const x of els) {
    const op = styleOp(x);
    revertLive(x);
    const path = pathOf(x.el);
    const src = srcOf.get(x.el);
    if (!path || !src || !op || op.t !== 'style' && op.t !== 'attr') continue;
    const copy = src.cloneNode(true) as Element;
    copy.removeAttribute('id');
    if (op.t === 'style') for (const [k, v] of Object.entries(op.set)) { const st = (copy as HTMLElement).style; if (v === null) st.removeProperty(k); else st.setProperty(k, v); }
    else if (op.value === null) copy.removeAttribute(op.name); else copy.setAttribute(op.name, op.value);
    byParent.push({ path, html: copy.outerHTML });
  }
  if (!byParent.length) return;
  byParent.sort((a, b) => a.path[a.path.length - 1] - b.path[b.path.length - 1]);
  const ops: HtmlOp[] = byParent.map(c => ({ t: 'insert', parent: c.path.slice(0, -1), index: c.path[c.path.length - 1] + 1, html: c.html }));
  // where the copies end up: each after its original, the earlier copies shifting the later ones
  const sel: Path[] = byParent.map((c, k) => [...c.path.slice(0, -1), c.path[c.path.length - 1] + 1 + k]);
  commit(ops, { select: sel });
}

/** a line whose end was dragged, written anew: its box around both ends, the ends in it */
function lineOp(svg: HTMLElement): HtmlOp | null {
  const line = lineOf(svg);
  const path = pathOf(svg);
  const src = srcOf.get(svg);
  const ends = line && lineEnds(line);
  if (!line || !path || !src || !ends) return null;
  const parent = containerOf(svg);
  const loc = ends.map(([x, y]) => slidePoint(parent, x, y));
  const minX = Math.min(loc[0][0], loc[1][0]), minY = Math.min(loc[0][1], loc[1][1]);
  const W = Math.max(1, Math.round(Math.abs(loc[0][0] - loc[1][0]))), H = Math.max(1, Math.round(Math.abs(loc[0][1] - loc[1][1])));
  const copy = src.cloneNode(true) as Element;
  const st = (copy as unknown as HTMLElement).style;
  st.setProperty('left', `${Math.round(minX)}px`); st.setProperty('top', `${Math.round(minY)}px`);
  st.setProperty('width', `${W}px`); st.setProperty('height', `${H}px`);
  if (!st.getPropertyValue('overflow')) st.setProperty('overflow', 'visible');
  copy.setAttribute('viewBox', `0 0 ${W} ${H}`);
  copy.removeAttribute('width'); copy.removeAttribute('height');
  const sl = Array.from(copy.querySelectorAll('line')).find(l => !l.closest('defs, marker, symbol'));
  if (!sl) return null;
  const r1 = (n: number) => String(Math.round(n * 10) / 10);
  sl.setAttribute('x1', r1(loc[0][0] - minX)); sl.setAttribute('y1', r1(loc[0][1] - minY));
  sl.setAttribute('x2', r1(loc[1][0] - minX)); sl.setAttribute('y2', r1(loc[1][1] - minY));
  return { t: 'outer', path, html: copy.outerHTML };
}

/* ------------------------------------------------------------------ touch: panning and pinching */

const touches = new Map<number, { x: number; y: number; sx: number; sy: number; t0?: number }>();
let pinch: { d: number; mx: number; my: number; smx: number; smy: number } | null = null;
/** a web page's pinch: where it began, how far it has zoomed, pan or zoom (gestures.ts) */
let pinch0: { d: number; smx: number; smy: number; f: number; lock: PinchLock } | null = null;

/** the two fingers' distance (on the screen) and middle (in the frame and on the screen) */
function touchGeom(): { d: number; mx: number; my: number; smx: number; smy: number } | null {
  const ps = [...touches.values()];
  if (ps.length < 2) return null;
  const [a, b] = ps;
  return { d: Math.hypot(a.sx - b.sx, a.sy - b.sy) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, smx: (a.sx + b.sx) / 2, smy: (a.sy + b.sy) / 2 };
}

/** a drag the first finger began is given up (a second finger came) */
function dropDrag(): void {
  if (!drag) return;
  if (drag.kind === 'pen') dropInk();
  for (const x of drag.els) revertLive(x);
  if (drag.kind === 'erase') for (const el of drag.erased ?? []) (el as HTMLElement | SVGElement).style.visibility = '';
  if (drag.hold) clearTimeout(drag.hold);
  if (drag.kind === 'pan' && drag.moved) post({ ol: 'panEnd' });
  release(); drag = null; drawBox = null; guides = []; draw();
}

/** the two fingers of a pinch: in the frame's px and on the screen */
const pinchPts = () => [...touches.values()].slice(0, 2).map(p => ({ x: p.x, y: p.y, sx: p.sx, sy: p.sy }));

function startPinch(): void {
  dropDrag();
  pinch = touchGeom();
  pinch0 = pinch && { d: pinch.d, smx: pinch.smx, smy: pinch.smy, f: 1, lock: pinchLock() };
  // one slide: the editor zooms and moves it, from where the fingers were at the start (absolute — no step undoes the last)
  if (pinch && isSolo()) post({ ol: 'pinch', phase: 'start', pts: pinchPts() });
}

function onTouchMove(e: PointerEvent): void {
  if (!touches.has(e.pointerId)) return;
  touches.set(e.pointerId, { ...touches.get(e.pointerId)!, x: e.clientX, y: e.clientY, sx: e.screenX, sy: e.screenY });
  if (tri) { moveTri(); return; }
  if (!pinch) return;
  if (isSolo()) { post({ ol: 'pinch', phase: 'move', pts: pinchPts() }); return; }
  const g = touchGeom();
  if (!g) return;
  // a web page: step by step, measured on the screen (the frame's px change with each step); a pan zooms not at all
  const z = pinch0 ? pinchFactor(pinch0.lock, pinch0.d, g.d, Math.hypot(g.smx - pinch0.smx, g.smy - pinch0.smy)) : 1;
  const f = pinch0 ? z / pinch0.f : 1;
  if (Math.abs(f - 1) > 0.002) { post({ ol: 'zoom', factor: f, clientX: g.mx, clientY: g.my, pageY: g.my + scrollY }); if (pinch0) pinch0.f = z; }
  scrollBy(0, (pinch.smy - g.smy) / scale);
  if (g.smx !== pinch.smx) post({ ol: 'pan', dx: g.smx - pinch.smx, screen: true });
  pinch = g;
}

function onTouchUp(e: PointerEvent): void {
  if (e.pointerType === 'pen' && e.pointerId === penOn) { penOn = null; penOffAt = performance.now(); post({ ol: 'penDown', down: false }); }
  if (e.pointerType !== 'touch') return;
  palms.delete(e.pointerId);
  touches.delete(e.pointerId);
  if (tri) { if (!touches.size) endTri(); return; }
  if (touches.size < 2 && pinch) {
    if (isSolo()) post({ ol: 'pinch', phase: 'end', pts: [] });
    pinch = null; pinch0 = null;
  }
}

/* ------------------------------------------------------------------ three fingers: undo, redo */

/** three fingers down: where their middle was (screen px), when, how far it went */
let tri: { t0: number; x0: number; y0: number; x: number; y: number } | null = null;
const triMid = () => { const ps = [...touches.values()]; return { x: ps.reduce((a, p) => a + p.sx, 0) / ps.length, y: ps.reduce((a, p) => a + p.sy, 0) / ps.length }; };

function startTri(): void {
  dropDrag();
  if (pinch && isSolo()) post({ ol: 'pinch', phase: 'cancel', pts: [] });
  pinch = null; pinch0 = null;
  const m = triMid();
  tri = { t0: performance.now(), x0: m.x, y0: m.y, x: m.x, y: m.y };
}

function moveTri(): void {
  // (the middle of all three: when one lifts first, the others' middle is not where the hand went)
  if (!tri || touches.size < 3) return;
  const m = triMid();
  tri.x = m.x; tri.y = m.y;
}

/** all fingers up: undo or redo (gestures.ts triGesture) */
function endTri(): void {
  const g = tri;
  tri = null;
  if (!g) return;
  const h = triGesture(g.x - g.x0, g.y - g.y0, performance.now() - g.t0);
  if (h) post({ ol: 'history', redo: h === 'redo' });
}

/* ------------------------------------------------------------------ Draw: the stroke as it is drawn */

/** a Pencil drew here: fingers move the slide from now on, they do not draw */
let penSeen = false;
/** fingers move the slide, only the pen draws: as the editor says (a Pencil has drawn in this browser, `fingers` in the pen's settings), else once one has here */
const fingersPan = () => inkStyle.fingers === 'pan' || (inkStyle.fingers !== 'draw' && penSeen);

/**
 * Palm rejection (GoodNotes'): the hand resting on the screen while the Pencil writes makes touches
 * too — often two or three, which pinched (and dropped the stroke) or undid. A touch is the palm's
 * when it comes down while the pen is on the screen or just after it lifts, or is as broad as a palm;
 * those already down when the pen lands are taken for the palm then, and what they began is undone
 * (a pinch put back, a pull let go). The palm's touches count for nothing until they lift.
 */
let penOn: number | null = null, penOffAt = -1e9;
const palms = new Set<number>();
const PALM_AFTER = 400;

function isPalm(e: PointerEvent): boolean {
  if (penOn !== null || performance.now() - penOffAt < PALM_AFTER) return true;
  // (a contact as broad as a palm, where the browser says how broad: the iPad's)
  return fingersPan() && Math.max(e.width || 0, e.height || 0) * scale > 46;
}

function penLands(e: PointerEvent): void {
  if (!penSeen) { penSeen = true; post({ ol: 'pencil' }); }
  penOn = e.pointerId;
  post({ ol: 'penDown', down: true });
  if (!touches.size) return;
  for (const id of touches.keys()) palms.add(id);
  touches.clear();
  tri = null;
  if (pinch) { if (isSolo()) post({ ol: 'pinch', phase: 'cancel', pts: [] }); pinch = null; pinch0 = null; }
  if (drag && drag.pointerType === 'touch') dropDrag();
}

/**
 * The stroke being drawn: in the page itself, where it will stay and as it will look (freehand.ts) —
 * the pen's points (`t`: the time of the last) and whether they all came in whole px. (Not where the
 * browser expects the pen next: drawn ahead of the pen, the line drew back when it lifted.)
 */
let ink: { slide: HTMLElement | null; pts: FreePt[]; client: [number, number][]; pressure: boolean; svg: SVGSVGElement; g: SVGGElement; frame: number; t: number; whole: boolean } | null = null;
/** strokes drawn and sent to the editor, shown until the page has them (`count`: that many strokes the slide will have then) */
const sentInk: { svg: SVGSVGElement; slide: HTMLElement | null; count: number; timer: ReturnType<typeof setTimeout> }[] = [];
const SVG_NS = 'http://www.w3.org/2000/svg';
const inkCount = (slide: HTMLElement | null) => (slide ?? document.body).querySelectorAll(':scope > svg.ol-ink:not([data-ol-runtime])').length;

function inkPoint(e: PointerEvent, slide: HTMLElement | null): FreePt {
  const [x, y] = slide ? slidePoint(slide, e.pageX, e.pageY) : [e.pageX, e.pageY];
  // (a pen's 0: not known — its first and last events; freehand.ts takes the nearest known)
  return [x, y, e.pointerType === 'pen' ? Math.max(0, e.pressure) : 0.5];
}

const wholePx = (e: PointerEvent) => Number.isInteger(e.clientX) && Number.isInteger(e.clientY);

function startInk(e: PointerEvent, slide: HTMLElement | null): void {
  dropInk();
  const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
  svg.setAttribute('data-ol-runtime', '');
  svg.setAttribute('class', 'ol-ink');
  svg.setAttribute('aria-hidden', 'true');
  const hl = inkStyle.opacity < 1;
  svg.setAttribute('style', `position: absolute; left: 0; top: 0; width: 1px; height: 1px; overflow: visible; pointer-events: none${hl ? '; mix-blend-mode: multiply' : ''}`);
  const g = document.createElementNS(SVG_NS, 'g') as SVGGElement;
  for (const [k, v] of Object.entries(inkPaint())) g.setAttribute(k, v);
  svg.append(g);
  (slide ?? document.body).append(svg);
  ink = { slide, pts: [inkPoint(e, slide)], client: [[e.clientX, e.clientY]], pressure: e.pointerType === 'pen', svg, g, frame: 0, t: e.timeStamp, whole: wholePx(e) };
  paintInk(true);
}

/** the paint of the stroke's runs, as the page will have it (sourceops.ts objectHtml) */
function inkPaint(): Record<string, string> {
  const a: Record<string, string> = { fill: 'none', stroke: inkStyle.color, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  if (inkStyle.opacity < 1) a['stroke-opacity'] = String(Math.round(inkStyle.opacity * 100) / 100);
  return a;
}

/** the pen moved: every point it passed (the coalesced events), drawn at the next frame */
function moveInk(e: PointerEvent): void {
  if (!ink) return;
  const evs = e.getCoalescedEvents?.() ?? [];
  for (const ev of evs.length ? evs : [e]) takeInk(ev);
  if (!ink.frame) ink.frame = requestAnimationFrame(() => { if (ink) { ink.frame = 0; paintInk(false); } });
}

/** a point the pen passed — unless it gave it before (freehand.ts freshPoint: Safari's coalesced events) */
function takeInk(ev: PointerEvent): void {
  if (!ink) return;
  const p = inkPoint(ev, ink.slide);
  if (!freshPoint(ink.pts, ink.t, ev.timeStamp, p)) return;
  ink.t = ev.timeStamp;
  ink.whole &&= wholePx(ev);
  ink.pts.push(p);
  ink.client.push([ev.clientX, ev.clientY]);
}

/** the stroke as runs of one width (freehand.ts), a path for each width as the page will have it (those that did not change left alone) */
function paintInk(final: boolean): InkRun[] {
  if (!ink) return [];
  const runs = inkRuns(ink.pts, { width: inkStyle.width, highlighter: inkStyle.opacity < 1, pressure: ink.pressure, zoom: scale, coarse: ink.whole && ink.pts.length > 4, nib: inkStyle.nib, final });
  const paths = inkPaths(runs), kids = ink.g.children;
  paths.forEach((p, i) => {
    let el = kids[i];
    if (!el) { el = document.createElementNS(SVG_NS, 'path'); ink!.g.append(el); }
    const w = String(p.w);
    if (el.getAttribute('d') !== p.d) el.setAttribute('d', p.d);
    if (el.getAttribute('stroke-width') !== w) el.setAttribute('stroke-width', w);
  });
  while (kids.length > paths.length) kids[kids.length - 1].remove();
  return runs;
}

/** the pen lifted: the stroke drawn to its end, sent; it stays shown until the page has it */
function endInk(e: PointerEvent): void {
  if (!ink) return;
  if (ink.frame) cancelAnimationFrame(ink.frame);
  // where it lifted, if not where it last was — with the pressure it had (a Pencil lifting reports none)
  const up = inkPoint(e, ink.slide), last = ink.pts[ink.pts.length - 1];
  if (e.timeStamp >= ink.t && Math.hypot(up[0] - last[0], up[1] - last[1]) > 0.5) ink.pts.push([up[0], up[1], last[2]]);
  // a scribble over strokes erases them (GoodNotes): the scribble goes, and they do
  const gone = inkStyle.scribble !== false && inkStyle.opacity >= 1 && isScribble(ink.pts.map(p => [p[0], p[1]]), scale) ? scribbledOut(ink.client) : [];
  if (gone.length && state.version !== null) {
    if (ink.frame) cancelAnimationFrame(ink.frame);
    ink.svg.remove();
    ink = null;
    for (const el of gone) (el as HTMLElement | SVGElement).style.visibility = 'hidden';
    commit([{ t: 'remove', paths: gone.map(pathOf).filter((p): p is Path => !!p) }]);
    return;
  }
  const runs = paintInk(true);
  const b = runsBox(runs);
  const { slide, svg } = ink;
  ink = null;
  if (state.version === null || !runs.length) { svg.remove(); return; }
  // whole px for its place, the runs moved into its own box
  const x = Math.floor(b.x), y = Math.floor(b.y);
  const rect = { x, y, w: Math.max(1, Math.ceil(b.x + b.w) - x), h: Math.max(1, Math.ceil(b.y + b.h) - y) };
  const waiting = sentInk.filter(s => s.slide === slide).length;
  const entry = { svg, slide, count: inkCount(slide) + waiting + 1, timer: setTimeout(() => { svg.remove(); const i = sentInk.indexOf(entry); if (i >= 0) sentInk.splice(i, 1); }, 4000) };
  sentInk.push(entry);
  post({ ol: 'draw', version: state.version, tool: 'pen', slide: slide ? pathOf(slide) : null, rect, after: null, runs: inkPaths(runs, -x, -y) });
}

/**
 * The strokes a scribble went over (Draw's, and open unfilled paths, as the eraser takes) — if it was
 * over strokes for a fifth of its length or more, each point of it taken as a few screen px across
 * (thin strokes are hard to land on exactly): a zig-zag across one line crosses it at each leg, a
 * scribble over a word is over it all along; writing that only crosses a line (an m over an underline)
 * is not, and stays — as does a scribble over nothing.
 */
function scribbledOut(client: [number, number][]): Element[] {
  const found: Element[] = [];
  let samples = 0, hits = 0, carry = 0;
  const step = 3 / scale, r = 3 / scale;
  const probe = (x: number, y: number) => {
    let hit = false;
    for (const h of document.elementsFromPoint(x, y)) {
      if (!(h instanceof SVGGeometryElement) || h.localName === 'svg') continue;
      const obj = objectFor(h, false);
      if (!obj || isLocked(obj) || !isStrokeArt(obj)) continue;
      hit = true;
      if (!found.includes(obj)) found.push(obj);
    }
    return hit;
  };
  const at = (x: number, y: number) => {
    samples++;
    // (each probe, not only the first that hits: all the strokes under the scribble go)
    const hit = [probe(x, y), probe(x - r, y), probe(x + r, y), probe(x, y - r), probe(x, y + r)].some(Boolean);
    if (hit) hits++;
  };
  at(client[0][0], client[0][1]);
  for (let i = 1; i < client.length; i++) {
    const [ax, ay] = client[i - 1], [bx, by] = client[i], l = Math.hypot(bx - ax, by - ay);
    for (carry += l; carry >= step; carry -= step) { const f = 1 - (carry - step) / Math.max(l, 1e-6); at(ax + (bx - ax) * f, ay + (by - ay) * f); }
  }
  return hits >= Math.max(2, samples / 5) ? found : [];
}

/** the stroke being drawn given up (a second finger, a cancelled pointer) */
function dropInk(): void {
  if (!ink) return;
  if (ink.frame) cancelAnimationFrame(ink.frame);
  ink.svg.remove();
  ink = null;
}

/** a new version of the page: the strokes it has now are no longer shown twice */
function inkArrived(): void {
  for (const s of [...sentInk]) {
    if (s.svg.isConnected && inkCount(s.slide) < s.count) continue;
    clearTimeout(s.timer);
    s.svg.remove();
    sentInk.splice(sentInk.indexOf(s), 1);
  }
}

/** Ctrl / ⌘ + wheel (a trackpad pinch, as Chromium and Firefox report it) zooms; sideways scrolling pans */
function onWheel(e: WheelEvent): void {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    post({ ol: 'zoom', factor: Math.exp(-e.deltaY * k * 0.01), clientX: e.clientX, clientY: e.clientY, pageY: e.pageY });
    return;
  }
  // one slide on the canvas: a scroll pans it (the editor lets it spring back to the middle)
  if (isSolo()) {
    e.preventDefault();
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const sx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX, sy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
    post({ ol: 'pan', dx: -sx * k, dy: -sy * k });
    return;
  }
  const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
  if (dx && Math.abs(dx) > Math.abs(e.shiftKey ? 0 : e.deltaY)) { e.preventDefault(); post({ ol: 'pan', dx: -dx }); }
}

let gestureScale = 1;
function onGesture(e: Event & { scale?: number; clientX?: number; clientY?: number; pageY?: number }): void {
  e.preventDefault();
  // (the iPad's Safari sends these for fingers too: their pointers pinch already — two zooms at once, and one without a pan's lock)
  if (touches.size) return;
  if (e.type === 'gesturestart') { gestureScale = 1; return; }
  const s = e.scale ?? 1;
  post({ ol: 'zoom', factor: s / gestureScale, clientX: e.clientX ?? innerWidth / 2, clientY: e.clientY ?? innerHeight / 2, pageY: e.pageY ?? scrollY + innerHeight / 2 });
  gestureScale = s;
}

/* ------------------------------------------------------------------ units */

/** px of the element's coordinate space → the unit the source used for it */
function inUnit(px: number, unit: string, el: HTMLElement, axis: 'x' | 'y'): string {
  const r = (n: number) => String(Math.round(n * 100) / 100);
  if (unit === 'px' || !unit) return `${Math.round(px)}px`;
  switch (unit) {
    case 'mm': return r(px * 25.4 / 96) + 'mm';
    case 'cm': return r(px * 2.54 / 96) + 'cm';
    case 'in': return r(px / 96) + 'in';
    case 'pt': return r(px * 0.75) + 'pt';
    case '%': {
      const cb = (el.offsetParent as HTMLElement | null) ?? el.parentElement;
      const size = cb ? (axis === 'x' ? cb.clientWidth : cb.clientHeight) : 0;
      return size ? r(px / size * 100) + '%' : r(px) + 'px';
    }
    case 'em': { const f = parseFloat(cs(el).fontSize) || 16; return r(px / f) + 'em'; }
    case 'rem': { const f = parseFloat(cs(document.documentElement).fontSize) || 16; return r(px / f) + 'rem'; }
    case 'vw': return r(px / innerWidth * 100) + 'vw';
    case 'vh': return r(px / innerHeight * 100) + 'vh';
    default: return r(px) + 'px';
  }
}

const unitOf = (v: string | undefined | null, fallback: string) => (v ? (/^-?[\d.]+\s*([a-z%]+)\s*$/i.exec(v.trim())?.[1]?.toLowerCase() ?? fallback) : fallback);

/** what a move or resize changed, as a style edit in the source's units (a shape in an SVG: its transform) */
export function styleOp(d: DragEl): HtmlOp | null {
  const path = pathOf(d.el);
  if (!path) return null;
  if (isSvgPart(d.el)) {
    const t = d.el.getAttribute('transform');
    return t === d.transform0 ? null : { t: 'attr', path, name: 'transform', value: t };
  }
  const src = srcOf.get(d.el)!;
  const srcStyle = new Map<string, string>();
  for (const decl of (src.getAttribute('style') ?? '').split(';')) { const i = decl.indexOf(':'); if (i > 0) srcStyle.set(decl.slice(0, i).trim().toLowerCase(), decl.slice(i + 1).trim()); }
  const set: Record<string, string | null> = {};
  const st = d.el.style;
  const sizeUnit = unitOf(srcStyle.get('width') ?? srcStyle.get('left'), 'px');
  for (const p of ['left', 'top', 'width', 'height'] as const) {
    const now = st.getPropertyValue(p);
    if (!now || now === d.inline.get(p)) continue;
    const px = parseFloat(now);
    set[p] = inUnit(px, unitOf(srcStyle.get(p), sizeUnit), d.el, p === 'left' || p === 'width' ? 'x' : 'y');
  }
  const pos = st.getPropertyValue('position');
  if (pos && pos !== d.inline.get('position')) set.position = pos;
  // positioned from the right or bottom: those give way to left / top (a width of its own stays)
  if (set.left && srcStyle.has('right')) set.right = null;
  if (set.top && srcStyle.has('bottom')) set.bottom = null;
  if (set.left && !srcStyle.has('right') && cs(d.el).right !== 'auto' && parseFloat(cs(d.el).width) !== d.w0 && !set.width) set.right = 'auto';
  if (!Object.keys(set).length) return null;
  return { t: 'style', path, set };
}

/** operations made here, to the editor (the page keeps what it shows until the text comes back) */
export function commit(ops: HtmlOp[], extra: { select?: 'inserted' | 'keep' | Path[]; then?: 'editText' } = {}): void {
  if (!ops.length || state.version === null) return;
  post({ ol: 'ops', version: state.version, ops: mergeStyles(ops), ...extra });
}

/**
 * The style edits of one element made one, the later values winning: the editor applies all of a
 * commit's edits to the same text at once, and two of one style attribute would overlap (an object
 * of a group moved, then shifted as its group fits around it).
 */
function mergeStyles(ops: HtmlOp[]): HtmlOp[] {
  const out: HtmlOp[] = [];
  const at = new Map<string, Extract<HtmlOp, { t: 'style' }>>();
  for (const op of ops) {
    if (op.t !== 'style') { out.push(op); continue; }
    const key = op.path.join('/');
    const prev = at.get(key);
    if (prev) { Object.assign(prev.set, op.set); continue; }
    const own = { ...op, set: { ...op.set } };
    at.set(key, own);
    out.push(own);
  }
  return out;
}

/** what an element's left / top are measured from: its nearest positioned ancestor (a group, the slide) */
export function containerOf(el: Element): HTMLElement {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (p === document.body || p.classList.contains('slide') || cs(p).position !== 'static') return p as HTMLElement;
  }
  return document.body;
}

/** the slide-local point of a document point (CSS px of the slide) */
export function slidePoint(slide: HTMLElement, x: number, y: number): [number, number] {
  const sr = docRect(slide);
  const k = slide.offsetWidth ? sr.w / slide.offsetWidth : 1;
  return [(x - sr.x - slide.clientLeft) / k, (y - sr.y - slide.clientTop) / k];
}

/* ------------------------------------------------------------------ drawing new objects */

/**
 * The eraser (Draw): the hand-drawn strokes under the pointer, a few screen px around it, go —
 * hidden at once, removed on the release. Only strokes (open paths without a fill: the pen's, the
 * highlighter's, an open Bézier path), as GoodNotes' eraser takes whole strokes; their painted line is
 * what it must touch, not their box.
 */
function eraseAt(e: PointerEvent, d: Drag): void {
  const rad = 7 / scale;
  const pts: [number, number][] = [[0, 0]];
  for (let i = 0; i < 8; i++) pts.push([Math.cos(i * Math.PI / 4) * rad, Math.sin(i * Math.PI / 4) * rad]);
  for (const [dx, dy] of pts) {
    for (const hit of document.elementsFromPoint(e.clientX + dx, e.clientY + dy)) {
      if (!(hit instanceof SVGGeometryElement) || hit.localName === 'svg') continue;
      const obj = objectFor(hit, false);
      if (!obj || d.erased!.includes(obj) || isLocked(obj) || !isStrokeArt(obj)) continue;
      (obj as HTMLElement | SVGElement).style.visibility = 'hidden';
      d.erased!.push(obj);
    }
  }
}

function finishDraw(d: Drag, box: Rect | null, e: PointerEvent): void {
  if (state.version === null) return;
  const slide = d.slide ?? (state.kind !== 'page' ? slideOf(document.elementFromPoint(e.clientX, e.clientY)) : null);
  const toLocal = (x: number, y: number): [number, number] => (slide ? slidePoint(slide, x, y) : [x, y]);
  let rect: Rect;
  let pts: [number, number][] | undefined;
  if ((tool === 'line' || tool === 'arrow') && d.pts && d.pts.length === 2 && d.moved) {
    pts = d.pts.map(([x, y]) => toLocal(x, y));
    const x = Math.min(pts[0][0], pts[1][0]), y = Math.min(pts[0][1], pts[1][1]);
    rect = { x, y, w: Math.abs(pts[0][0] - pts[1][0]), h: Math.abs(pts[0][1] - pts[1][1]) };
  } else {
    const b = box && d.moved ? box : { x: d.x0, y: d.y0, w: 0, h: 0 };
    const [x, y] = toLocal(b.x, b.y);
    const k = slide && slide.offsetWidth ? docRect(slide).w / slide.offsetWidth : 1;
    rect = { x, y, w: b.w / k, h: b.h / k };
  }
  const slidePath = slide ? pathOf(slide) : null;
  const after = selected.length === 1 ? pathOf(selected[0]) : null;
  if (tool === 'text') expectNewText();
  post({ ol: 'draw', version: state.version, tool, slide: slidePath, rect, after, pts });
}

/* ------------------------------------------------------------------ files dropped on the page */

const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types ?? []).includes('Files');

function onDragOver(e: DragEvent): void {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  const t = document.elementFromPoint(e.clientX, e.clientY);
  const s = state.kind !== 'page' ? slideOf(t) ?? visibleSlideEl() : null;
  const r = s ? docRect(s) : null;
  const nb = r ?? { x: scrollX + 4, y: scrollY + 4, w: innerWidth - 8, h: innerHeight - 8 };
  if (!dropBox || dropBox.x !== nb.x || dropBox.y !== nb.y) { dropBox = nb; draw(); }
}

function onDragLeave(e: DragEvent): void {
  if (e.relatedTarget && document.documentElement.contains(e.relatedTarget as Node)) return;
  if (dropBox) { dropBox = null; draw(); }
}

function onDrop(e: DragEvent): void {
  dropBox = null;
  draw();
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.stopPropagation();
  const files = Array.from(e.dataTransfer?.files ?? []);
  if (!files.length) return;
  const t = document.elementFromPoint(e.clientX, e.clientY);
  const s = state.kind !== 'page' ? slideOf(t) ?? visibleSlideEl() : null;
  const at = s ? slidePoint(s, e.clientX + scrollX, e.clientY + scrollY) : null;
  void Promise.all(files.map(async f => ({ name: f.name, type: f.type || guessType(f.name), data: await f.arrayBuffer() }))).then(fs2 => {
    post({ ol: 'pasteFiles', files: fs2, slide: s ? pathOf(s) : null, at: at ? { x: at[0], y: at[1] } : null });
  });
}

function guessType(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return ({ svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif' } as Record<string, string>)[ext] ?? '';
}

/* ------------------------------------------------------------------ text */

function penUpOnce(): void { removeEventListener('pointerup', penUpOnce, true); penUp(); }

function onDblClick(e: MouseEvent): void {
  if (isCropping() || isNodeEditing()) return;
  rotating = null;   // (its two clicks switched the handles twice: a double click means points or text)
  e.preventDefault();
  e.stopPropagation();
  if (isOrdering()) return;
  if (tool === 'bezier') { penDouble(); return; }
  if (tool !== 'select') return;
  const t = e.target as Element;
  if (editing && editing.contains(t)) return;
  const cur = selected.length === 1 ? selected[0] : null;
  // a picture: PowerPoint's crop (drag the picture inside its frame)
  const pic = cur && cur.contains(t) ? cur : objectFor(t, false);
  if (pic && cropTarget(pic) && !isLocked(pic)) { selected = [pic]; report(); if (startCrop(pic, cropCtx())) post({ ol: 'cropping', path: pathOf(pic) }); draw(); return; }
  // a path (or a drawing that is one shape): Inkscape's node editor
  const shape = cur ? nodesTargetOf(t, cur) : null;
  if (shape && !isLocked(cur!)) { startNodesOrConvert(shape); return; }
  // the selected object retyped, or its text-bearing part under the pointer
  let target: Element | null = null;
  if (cur && cur.contains(t)) {
    if (canType(cur)) target = cur;
    else {
      for (let x: Element | null = sourced(t); x && x !== cur; x = x.parentElement ?? (x.parentNode as Element | null)) if (isTextual(x)) target = x;
      if (!target) {
        // into the group (or the drawing): the child under the pointer
        for (let x: Element | null = sourced(t); x && x !== cur; x = x.parentElement ?? (x.parentNode as Element | null)) if ((x.parentElement ?? x.parentNode) === cur) { selected = [x]; report(); draw(); return; }
      }
    }
  } else {
    const el = objectFor(t, false);
    if (el) { selected = [el]; target = canType(el) ? el : null; report(); }
  }
  if (target) { selected = [target]; report(); beginText(target as HTMLElement, { x: e.clientX, y: e.clientY }); }
  draw();
}

function beginText(el: HTMLElement, at: { x: number; y: number } | null, selectAll = false, openMath = false): void {
  const src = srcOf.get(el);
  if (!src) return;
  flushAfter();
  stopText();
  editing = el;
  guard.editing = el;
  // the text as written, its formulas chips (typeset, edited with LyX's formula editor: mathedit.ts)
  el.innerHTML = src.innerHTML;
  // (suggested deletions keep the caret out: what is typed never goes into them)
  lockDeletions(el);
  el.classList.add('ol-notex');
  const chipping = chipify(el);
  el.setAttribute('data-ol-editing', '');
  el.contentEditable = 'true';
  editStartHtml = cleanHtml(el);
  try { document.execCommand('defaultParagraphSeparator', false, 'p'); document.execCommand('styleWithCSS', false, 'true'); } catch { /* old browsers */ }
  el.focus({ preventScroll: true });
  if (chipping.chips.length) {
    // the caret once the formulas have their size; a click on a formula (or a new formula object) opens it
    placeCaret(el, null, selectAll);
    void chipping.ready.then(() => {
      if (editing !== el) return;
      const hit = at ? chipping.chips.find(c => { const r = c.getBoundingClientRect(); return at.x >= r.left && at.x <= r.right && at.y >= r.top && at.y <= r.bottom; }) : undefined;
      if (hit) openChip(hit, at);
      else if (openMath) openChip(chipping.chips[0], null);
      else placeCaret(el, at, selectAll);
    });
  } else placeCaret(el, at, selectAll);
  el.addEventListener('input', scheduleCommit);
  el.addEventListener('beforeinput', onBeforeInput);
  el.addEventListener('paste', pastePlain);
  showGhost(null);
  post({ ol: 'editing', path: pathOf(el) });
  draw();
}

function placeCaret(el: HTMLElement, at: { x: number; y: number } | null, selectAll: boolean): void {
  const sel = getSelection();
  if (sel) {
    let range: Range | null = null;
    if (at && !selectAll) {
      const d = document as Document & { caretRangeFromPoint?(x: number, y: number): Range | null; caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null };
      if (d.caretPositionFromPoint) { const p = d.caretPositionFromPoint(at.x, at.y); if (p && el.contains(p.offsetNode)) { range = document.createRange(); range.setStart(p.offsetNode, p.offset); } }
      else if (d.caretRangeFromPoint) { const r = d.caretRangeFromPoint(at.x, at.y); if (r && el.contains(r.startContainer)) range = r; }
    }
    if (!range) { range = document.createRange(); range.selectNodeContents(el); if (!selectAll) range.collapse(false); }
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

function pastePlain(e: ClipboardEvent): void {
  const text = e.clipboardData?.getData('text/plain');
  if (text === undefined) return;
  e.preventDefault();
  e.stopPropagation();
  document.execCommand('insertText', false, text);
}

/** while suggesting: deletions struck through and typing underlined as it happens (review.ts) */
function onBeforeInput(e: Event): void {
  if (editing && trackInput(e as InputEvent, editing)) scheduleCommit();
}

function scheduleCommit(): void {
  if (editTimer) clearTimeout(editTimer);
  editTimer = setTimeout(() => { commitText(); sendCaret(); }, 350);
  redrawSoon();
  wordsMoved();
}

/** the retyped text's markup, cleaned of what contenteditable adds */
function cleanHtml(el: HTMLElement): string {
  const c = el.cloneNode(true) as HTMLElement;
  for (const x of Array.from(c.querySelectorAll('[data-ol-runtime]'))) x.remove();
  for (const x of Array.from(c.querySelectorAll('[data-ol-texwait]'))) x.removeAttribute('data-ol-texwait');
  // (the suggested deletions locked while retyping)
  for (const x of Array.from(c.querySelectorAll('[contenteditable]'))) x.removeAttribute('contenteditable');
  unchip(c);
  // a trailing <br> a browser leaves in an emptied block
  let html = c.innerHTML.replace(/<br>(\s*)$/, '$1');
  if (/^\s*<br>\s*$/.test(html)) html = '';
  // the no-break spaces contenteditable puts beside typed spaces (so they would not collapse) are spaces
  html = html.replace(/&nbsp;(?= )|(?<= )&nbsp;/g, ' ').replace(/&nbsp;(?=<\/|$)/g, ' ');
  // and the ones beside a formula (typed next to its uneditable chip)
  html = html.replace(/(?<=\\\)|\\\]|\$\$)&nbsp;|&nbsp;(?=\\\(|\\\[|\$\$)/g, ' ');
  return html;
}

/** elements whose content is text only (no paragraphs or lists inside: the parser would push them out of the box) */
const PHRASING_BOXES = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const BLOCK_INSIDE = /<(p|div|ul|ol|li|h[1-6]|blockquote|table|pre|section|figure)[\s>]/i;

/** `final`: the retyping ends — a text box that got a list (or another block) inside becomes a div that can hold it */
function commitText(final = false): void {
  if (editTimer) { clearTimeout(editTimer); editTimer = null; }
  if (!editing) return;
  const path = pathOf(editing);
  const html = cleanHtml(editing);
  const src = srcOf.get(editing);
  // a list (or another block) in a paragraph or heading box: the box becomes a <div> with the first save
  // that has it — the parser pushes a <ul> out of a <p>, and a save before the retyping ended (a reload,
  // a closed tab) left the list at the slide's corner. The box being retyped stays as it is meanwhile
  // (reconcile's guard); its source is the <div> from then on.
  const toDiv = !!src && PHRASING_BOXES.has(src.localName) && BLOCK_INSIDE.test(html);
  if (!path || (html === editStartHtml && !toDiv)) return;
  editStartHtml = html;
  const attrs = toDiv ? Array.from(src!.attributes).map(a => ` ${a.name}="${a.value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`).join('') : '';
  const ops: HtmlOp[] = [toDiv ? { t: 'outer', path, html: `<div${attrs}>${html}</div>` } : { t: 'inner', path, html }];
  // a box-wide change made while typing (the line spacing)
  const lh = editing.style.getPropertyValue('line-height');
  const srcLh = (srcOf.get(editing) as HTMLElement | undefined)?.style?.getPropertyValue('line-height') ?? '';
  if (lh && lh !== srcLh) ops.push({ t: 'style', path, set: { 'line-height': lh } });
  commit(ops);
}

/** end retyping: what was typed sent, the element shown as the text has it (math typeset) */
export function stopText(): void {
  if (!editing) return;
  closeChip();
  commitText(true);
  const el = editing;
  editing = null;
  guard.editing = null;
  el.removeEventListener('input', scheduleCommit);
  el.removeEventListener('beforeinput', onBeforeInput);
  el.removeEventListener('paste', pastePlain);
  el.removeAttribute('contenteditable');
  el.removeAttribute('data-ol-editing');
  el.classList.remove('ol-notex');
  if (!el.getAttribute('class')) el.removeAttribute('class');
  getSelection()?.removeAllRanges();
  // shown again from the source (the next version replaces it when the text changed)
  const src = srcOf.get(el);
  if (src && el.isConnected) {
    el.innerHTML = src.innerHTML;
    // (its elements paired with the source's: else the next version would add them again beside these)
    linkTree(el, src);
    renderCites([el]);
    refreshCites();
    void typeset([el]).then(draw);
  }
  post({ ol: 'editing', path: null });
  sendCaret();
  // (a pointer lifted outside the frame: the next text's menu does not wait for it)
  chosenWords();
  draw();
}

export function isEditingText(): boolean { return !!editing; }

/** what a new comment is on, to the editor (the text being retyped and its selected words, the selection, the slide) */
export function newComment(): void {
  commentTarget(editing, selection(), visibleSlideEl());
}

/** the caret is in code (a $ there is a dollar) */
function inCode(): boolean {
  const n = getSelection()?.anchorNode;
  const el = n ? (n.nodeType === Node.ELEMENT_NODE ? n as Element : n.parentElement) : null;
  return !!el?.closest('code, pre, kbd, samp');
}

/* ------------------------------------------------------------------ keys, clipboard, menu */

function onKeyDown(e: KeyboardEvent): void {
  if (isCropping() || isNodeEditing()) return;
  if (drawAhead && !editing && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Enter')) { e.preventDefault(); drawAhead.push(keyPress(e)); return; }
  if (isPenDrawing() && penKey(e)) { e.preventDefault(); e.stopPropagation(); return; }
  if (isOrdering() && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); stopOrdering(); return; }
  const mod = e.ctrlKey || e.metaKey;
  if (editing) {
    // a formula was just opened here and LyX's formula editor has not the keyboard yet: the keys are the formula's
    if (chipOpening() && !isModifierKey(e)) { e.preventDefault(); holdKey(keyPress(e)); return; }
    // the formula editor gave the keyboard back (it left the formula): typed once the caret is beside the formula
    if (openChipEl() && !isModifierKey(e)) { e.preventDefault(); holdAfter(keyPress(e)); return; }
    if (e.key === 'Escape') { e.preventDefault(); stopText(); return; }
    // Alt+↑ / Alt+↓: the list item the caret is in moves up / down (as in documents)
    if (e.altKey && !mod && !e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && stepItem(e.key === 'ArrowUp' ? -1 : 1)) { e.preventDefault(); return; }
    // the frame has the keyboard but not the text being retyped (it was just made; a click left the focus
    // on the page): the key is the text's, not lost on the page
    if (!editing.contains(document.activeElement) && !mod && !e.altKey && (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Enter')) {
      e.preventDefault();
      editing.focus({ preventScroll: true });
      typeKeysHere([keyPress(e)], stopText);
      return;
    }
    // a comment on the text (the words selected), as in documents (Ctrl+Alt+M)
    if (mod && e.altKey && e.code === 'KeyM') { e.preventDefault(); e.stopPropagation(); newComment(); return; }
    // LyX: Ctrl+M a formula (Ctrl+Shift+M displayed), an arrow key into a formula goes into it
    if (mod && !e.altKey && e.key.toLowerCase() === 'm') { e.preventDefault(); e.stopPropagation(); insertChip(editing, e.shiftKey); return; }
    // $ typed opens a formula, as in documents ($$ a displayed one, Backspace gives the $ back)
    if (e.key === '$' && !mod && !e.altKey && !inCode()) { e.preventDefault(); insertChip(editing, false, '$'); return; }
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !mod && !e.shiftKey && !e.altKey) {
      const c = chipBeside(e.key === 'ArrowLeft' ? 'before' : 'after');
      if (c) { e.preventDefault(); openChip(c, null, e.key === 'ArrowLeft' ? 'end' : 'start'); return; }
    }
    // undo / redo: the retyping ends first — the box being retyped is kept as it is while new versions
    // come in (reconcile's guard), so the undone text never showed and ⌘Z seemed to do nothing
    if (mod && /^[zy]$/i.test(e.key)) { e.preventDefault(); stopText(); fwd(e); return; }
    // link, citation, cross-reference: the editor's dialogs (as in documents: Ctrl+K, Ctrl+Shift+C, Ctrl+Shift+I)
    if (mod && ((!e.shiftKey && e.key.toLowerCase() === 'k') || (e.shiftKey && /^[ci]$/i.test(e.key)))) { e.preventDefault(); commitText(); fwd(e); return; }
    if (mod && /^[bi]$/i.test(e.key)) { e.preventDefault(); exec(e.key.toLowerCase() === 'b' ? 'bold' : 'italic'); return; }
    if (mod && e.key.toLowerCase() === 'u') { e.preventDefault(); exec('underline'); return; }
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); commitText(); fwd(e); return; }
    // Tab in a list item nests it (Shift+Tab lifts it back), as in PowerPoint; elsewhere it stays in the
    // text — the browser moved the focus out of the frame, and the next words went into the speaker notes
    if (e.key === 'Tab' && !mod && !e.altKey) {
      e.preventDefault();
      if (getSelection()?.anchorNode?.parentElement?.closest('li')) exec(e.shiftKey ? 'outdent' : 'indent');
      return;
    }
    // Enter in a text box that is a paragraph or a heading: a line break — a paragraph inside it would be
    // pushed out of the box by the parser (a stray box at the slide's corner after a reload)
    if (e.key === 'Enter' && !mod && !e.altKey && PHRASING_BOXES.has(editing.localName) && !getSelection()?.anchorNode?.parentElement?.closest('li')) {
      e.preventDefault();
      document.execCommand('insertLineBreak');
      return;
    }
    return;
  }
  const tag = (e.target as Element | null)?.localName;
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  if (e.key === 'Escape') {
    e.preventDefault();
    if (tool !== 'select') { fwd(e); return; }
    selectParent();
    return;
  }
  const free = selected.filter(s => !isLocked(s));
  if ((e.key === 'Delete' || e.key === 'Backspace') && selected.length) {
    e.preventDefault();
    const paths = free.map(pathOf).filter((p): p is Path => !!p);
    if (!paths.length) return;
    // (the groups they were in fitted to what is left — before the removal, while the paths hold)
    const refit = refitGroups(free, new Set(free));
    selected = selected.filter(isLocked);
    report();
    commit([...refit, { t: 'remove', paths }]);
    return;
  }
  if (e.key === 'Enter' && selected.length === 1 && canType(selected[0])) { e.preventDefault(); beginText(selected[0] as HTMLElement, null, true); return; }
  if (e.key.startsWith('Arrow') && selected.length && !mod && !e.altKey) {
    e.preventDefault();
    nudge(e.key, e.shiftKey);
    return;
  }
  if (mod && e.key.toLowerCase() === 'd' && selected.length) {
    e.preventDefault();
    const paths = selected.map(pathOf).filter((p): p is Path => !!p);
    commit([{ t: 'duplicate', paths }]);
    return;
  }
  if (mod && e.key.toLowerCase() === 'a' && state.kind !== 'page') {
    e.preventDefault();
    selectAllOnSlide();
    return;
  }
  if (mod && e.altKey && e.code === 'KeyM') { e.preventDefault(); newComment(); return; }
  if (mod || e.key === 'F5' || e.key === 'Delete') { if (!['c', 'x', 'v'].includes(e.key.toLowerCase())) { e.preventDefault(); fwd(e); } return; }
  // a letter on a selected text object (or shape) starts retyping it
  if (e.key.length === 1 && !e.altKey && selected.length === 1 && canType(selected[0]) && !isLocked(selected[0])) {
    beginText(selected[0] as HTMLElement, null, true);
    return;
  }
  // one slide on the canvas: Page Down / Up go to the next / previous one (the editor's)
  if ((e.key === 'PageDown' || e.key === 'PageUp') && isSolo()) { e.preventDefault(); fwd(e); return; }
  if (e.key.length === 1 || e.key === 'F2') fwd(e);
}

/** the Objects pane's row under the pointer: its object outlined as under the pointer */
export function hoverPath(path: Path | null): void {
  const el = path ? liveAt(path) : null;
  if (el === hoverEl) return;
  hoverEl = el;
  draw();
}

/** Escape: a level up — from an object of a group (or a part of a drawing) to the group, else nothing selected */
export function selectParent(): void {
  if (editing) return;
  const p = selected.length === 1 ? selected[0].parentElement ?? (selected[0].parentNode as Element | null) : null;
  selected = p && srcOf.has(p) && !p.classList.contains('slide') && p !== document.body ? [p] : [];
  report(); draw();
}

/** an arrow key: the selection moved by 1 px (Shift: 10) */
export function nudge(key: string, shift: boolean): void {
  if (editing) return;
  const step = shift ? 10 : 1;
  const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0;
  const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
  const els = selected.filter(s => !isLocked(s) && movable(s)).map(s => start(s as HTMLElement));
  if (!els.length) return;
  for (const d of els) placeLive(d, dx, dy);
  commit([...els.map(styleOp).filter((x): x is HtmlOp => !!x), ...refitGroups(els.map(d => d.el))]);
  draw();
}

function fwd(e: KeyboardEvent): void {
  post({ ol: 'key', key: e.key, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey });
}

/* the clipboard (clip.ts): with the keyboard in the frame — mostly it is in the editor, which does the same */

function onCopy(e: ClipboardEvent): void {
  if (isCropping()) return;
  if (editing || !selected.length || !e.clipboardData) return;
  const c = clipOf(selected);
  if (!c) return;
  e.preventDefault();
  e.clipboardData.setData('text/html', c.html);
  e.clipboardData.setData('text/plain', c.plain);
}

function onCut(e: ClipboardEvent): void {
  if (isCropping()) return;
  if (editing || !selected.length) return;
  onCopy(e);
  const paths = selected.filter(s => !isLocked(s)).map(pathOf).filter((p): p is Path => !!p);
  selected = [];
  report();
  commit([{ t: 'remove', paths }]);
}

function onPaste(e: ClipboardEvent): void {
  if (isCropping()) return;
  if (editing || !e.clipboardData) return;
  e.preventDefault();
  const cd = e.clipboardData;
  const files = Array.from(cd.files ?? []);
  const html = cd.getData('text/html'), plain = cd.getData('text/plain');
  void Promise.all(files.map(async f => ({ name: f.name, type: f.type, data: await f.arrayBuffer() }))).then(fs2 => pasteHere({ html, plain, files: fs2 }));
}

/** a paste (into the frame, or passed on by the editor) */
export function pasteHere(d: Parameters<typeof paste>[0]): void {
  if (isCropping() || editing) return;
  paste(d);
}

function onContextMenu(e: MouseEvent): void {
  if (isCropping()) return;
  e.preventDefault();
  e.stopPropagation();
  if (editing) return;
  const el = objectFor(e.target as Element, e.ctrlKey || e.metaKey, { x: e.clientX, y: e.clientY });
  if (el && !selected.includes(el)) { selected = [el]; report(); draw(); }
  // the shape of a drawing under the pointer: the menu's "Edit points" edits that one
  setMenuShape(el && e.target instanceof SVGElement && el.contains(e.target) ? e.target : null);
  const on = el ? 'object' : slideOf(e.target as Element) ? 'slide' : 'canvas';
  const s = slideOf(e.target as Element);
  // two shapes crossing under the pointer: the lower one can be woven over the upper one there (weave.ts)
  const woven = el ? weaveMenu(e.clientX, e.clientY, e.target as Element) : null;
  post({ ol: 'contextmenu', x: e.clientX, y: e.clientY, on, slide: s ? slides().indexOf(s) : undefined, ...(woven ? { weave: woven } : {}) });
}

/* ------------------------------------------------------------------ the slide in view */

let lastVisible = -1;
export function visibleSlideEl(): HTMLElement | null {
  if (isSolo()) return slides()[soloIndex()] ?? null;
  const ss = slides();
  const mid = scrollY + innerHeight / 2;
  let best: HTMLElement | null = null, bd = Infinity;
  for (const s of ss) { const r = docRect(s); const d = mid < r.y ? r.y - mid : mid > r.y + r.h ? mid - r.y - r.h : 0; if (d < bd) { bd = d; best = s; } }
  return best;
}
export function visibleSlide(): void {
  if (isSolo()) { const k = soloIndex(); if (k !== lastVisible) { lastVisible = k; post({ ol: 'visible', slide: k }); postSequence(); postObjects(); } return; }
  const s = visibleSlideEl();
  const i = s ? slides().indexOf(s) : -1;
  if (i !== lastVisible) { lastVisible = i; post({ ol: 'visible', slide: i }); postSequence(); postObjects(); }
}

export function scrollToSlide(i: number, smooth = false): void {
  if (isSolo()) {
    if (!showSlide(i)) return;
    lastVisible = soloIndex();
    // what was going on on the slide before ends there
    stopText();
    if (isCropping()) endCrop(true);
    endNodes();
    hoverEl = null;
    const s = slides()[soloIndex()];
    const kept = selected.filter(el => s && s.contains(el));
    if (kept.length !== selected.length) { selected = kept; report(); }
    draw();
    sendLayout();
    postSequence();
    postObjects();
    return;
  }
  const s = slides()[i];
  if (!s) return;
  const r = docRect(s);
  scrollTo({ top: Math.max(0, r.y - Math.max(16, (innerHeight - r.h) / 2)), behavior: smooth ? 'smooth' : 'auto' });
}

void MODE;
