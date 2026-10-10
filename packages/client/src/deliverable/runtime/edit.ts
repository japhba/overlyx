/**
 * The canvas in the editor's frame: selecting, moving, resizing, rotating, retyping and drawing
 * objects of the page, reported to the editor as operations on the text (core html/source.ts).
 * What the runtime draws (selection frames, handles, guides) lives in a shadow root on <html>, out
 * of the page's reach and out of its styles.
 *
 * A click selects an object: on a slide an element directly on it (a group's inside is reached by
 * double-clicking it, or with Ctrl / ⌘), on a web page the innermost block. A double click on text
 * — or on a shape: shapes take text like Google Slides' — retypes it in place (contenteditable,
 * with its TeX shown as written); Escape ends that, then goes a level up. Dragging moves what is
 * positioned (absolute, fixed, relative; on a slide also a static element, which becomes relative;
 * inside an SVG a shape gets a translate), Alt+drag moves a copy, handles resize (in the object's
 * own axes when it is rotated), the round handle above rotates (Shift: 15° steps), a line's ends are
 * dragged by themselves. Positions are written in the units the element had. Arrows nudge, Delete
 * removes, ⌘D duplicates; ⌘Z, ⌘G and the rest go to the editor, which sends arrangement commands
 * back (arrange.ts).
 *
 * Touch and pen: the canvas takes every gesture itself (touch-action: none) — a finger on an
 * object moves it, on nothing pans, held still first draws a selection box, two fingers pinch-zoom
 * and pan (the editor scales the frame); a pen works like the mouse. The pointer is captured, so a
 * drag that leaves the frame keeps going.
 */
import type { Path, SelItem, SelStyle, Tool, Rect, HtmlOp, ObjKind, KeyPress } from '../protocol';
import { MODE, post, state, srcOf, pathOf, liveAt, sourced, slides, slideOf, docRect, isForeign, sendLayout } from './env';
import { guard } from './reconcile';
import { typeset } from './math';
import { refreshView } from './view';
import { startCrop, isCropping, endCrop, cropNow, cropTarget, setCropAspect, redrawCrop, type CropContext } from './crop';
import { chipify, unchip, openChip, openChipEl, chipOpening, holdKey, holdAfter, keyPress, isModifierKey, typeKeysHere, chipHooks, flushAfter, shownChip, setChip, doneChip, displayChip, closeChip, trackChip, insertChip, chipBeside, CHIP_CSS } from './mathedit';
import { initPaths, isNodeEditing, nodesAfterSource, nodesTargetOf, startNodesOrConvert, endNodes, redrawNodes, penDown, penMove, penUp, penKey, penDouble, penCancel, isPenDrawing } from './pathedit';

const NS = 'http://www.w3.org/1999/xhtml';
let host: HTMLElement;
let root: ShadowRoot;
let layer: HTMLElement;
let scale = 1;
let tool: Tool = 'select';
let selected: Element[] = [];
let peers: { paths: Path[]; color: string; name: string }[] = [];
let editing: HTMLElement | null = null;
let editTimer: ReturnType<typeof setTimeout> | null = null;
let editStartHtml = '';

const TEXT_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'sub', 'sup', 'small', 'mark', 'a', 'br', 'ul', 'ol', 'li', 'blockquote', 'code', 'q', 'cite', 'abbr', 'time', 'label', 'font', 'section', 'article', 'header', 'footer', 'figcaption', 'dt', 'dd', 'dl', 'td', 'th', 'caption', 'big', 'del', 'ins', 'kbd', 'var', 'samp', 'strike']);
const REPLACED = new Set(['img', 'svg', 'video', 'canvas', 'iframe', 'object', 'embed', 'picture', 'audio']);
const SVG_SHAPES = new Set(['rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path', 'text', 'tspan', 'g', 'use', 'image']);
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
    .hover { position: absolute; outline: 1px solid rgba(47,111,222,.55); pointer-events: none; transform-origin: 50% 50%; }
    .handle { position: absolute; width: var(--h); height: var(--h); margin: calc(var(--h) / -2) 0 0 calc(var(--h) / -2); background: #fff; border: 1.5px solid #2f6fde; box-sizing: border-box; border-radius: 2px; pointer-events: auto; touch-action: none; }
    .handle.rot { border-radius: 50%; background: #2f6fde; border-color: #fff; cursor: ${ROT_CURSOR}; }
    .handle.end { border-radius: 50%; width: calc(var(--h) * 1.25); height: calc(var(--h) * 1.25); margin: calc(var(--h) * -0.625) 0 0 calc(var(--h) * -0.625); cursor: move; }
    .stem { position: absolute; background: #2f6fde; pointer-events: none; transform-origin: 50% 100%; }
    .lock { position: absolute; transform: translate(-100%, -100%); font-size: calc(12px * var(--s)); line-height: 1; pointer-events: none; }
    .guide { position: absolute; background: #e8467c; pointer-events: none; }
    .draw { position: absolute; border: 1.5px dashed #2f6fde; background: rgba(47,111,222,.08); pointer-events: none; }
    .drop { position: absolute; border: 3px dashed #2f6fde; background: rgba(47,111,222,.10); pointer-events: none; box-sizing: border-box; }
    .tag { position: absolute; transform: translateY(-100%); background: #2f6fde; color: #fff; padding: 1px 5px; border-radius: 3px 3px 0 0; white-space: nowrap; pointer-events: none; font-size: calc(11px * var(--s)); }
    .peer-tag { position: absolute; transform: translateY(-100%); color: #fff; padding: 1px 5px; border-radius: 3px 3px 0 0; white-space: nowrap; pointer-events: none; font-size: calc(11px * var(--s)); }
    svg.ink { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
  </style><div class="layer"></div>`;
  layer = root.querySelector('.layer') as HTMLElement;
  document.documentElement.appendChild(host);
  initPaths({ root, scale: () => scale });
  const css = document.createElement('style');
  css.setAttribute('data-ol-runtime', '');
  css.textContent = `[data-ol-editing] { outline: none !important; cursor: text !important; caret-color: auto; }
    html.ol-edit, html.ol-edit body { touch-action: none; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
    html.ol-edit [data-ol-editing], html.ol-edit [data-ol-editing] * { -webkit-user-select: text; user-select: text; }
    html.ol-tool-draw, html.ol-tool-draw * { cursor: crosshair !important; }
    html.ol-dragging, html.ol-dragging * { cursor: grabbing !important; user-select: none !important; }
    html.ol-edit a { cursor: default; }
    ${CHIP_CSS}`;
  document.head.appendChild(css);
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
  addEventListener('scroll', () => { draw(); post({ ol: 'scroll', y: scrollY }); visibleSlide(); trackChip(); }, { passive: true });
  addEventListener('resize', () => { draw(); sendLayout(); refreshView(); trackChip(); });
  new ResizeObserver(() => { draw(); refreshView(); trackChip(); }).observe(document.documentElement);
}

/* ------------------------------------------------------------------ messages from the editor */

export function setScale(s: number, anchor?: { docY: number; screenY: number }): void {
  scale = s > 0 ? s : 1;
  // zoomed about a point: that point of the page stays where it is on the screen
  if (anchor) scrollTo({ top: Math.max(0, anchor.docY - anchor.screenY / scale) });
  draw();
  redrawCrop();
  redrawNodes();
}
export function setTool(t: Tool): void {
  tool = t;
  document.documentElement.classList.toggle('ol-tool-draw', t !== 'select');
  if (t !== 'bezier') penCancel();
  if (t !== 'select') { stopText(); if (isCropping()) endCrop(true); endNodes(); }
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
export function setPeers(p: typeof peers): void { peers = p; draw(); }

export function selectPaths(paths: Path[]): void {
  selected = paths.map(liveAt).filter((e): e is Element => !!e);
  report();
  draw();
}

/** the selection, for the arrangement commands (arrange.ts) */
export function selection(): Element[] { return selected.filter(e => e.isConnected); }
export function setSelection(els: Element[]): void { selected = els; report(); draw(); }

/** after a new version of the text: the selection found again, the frame redrawn */
export function afterSource(): void {
  selected = selected.map(e => (e.isConnected ? e : null)).filter((e): e is Element => !!e && !!pathOf(e));
  if (editing && !editing.isConnected) { editing = null; post({ ol: 'editing', path: null }); }
  report();
  draw();
  nodesAfterSource();
}

export function editTextAt(path: Path, selectAll = false, math = false): void {
  const el = liveAt(path);
  if (!el) return;
  selected = [el];
  report();
  if (canType(el)) beginText(el as HTMLElement, null, selectAll && !math, math);
  draw();
}

/* ------------------------------------------------------------------ formulas (runtime/mathedit.ts) */

export function mathShown(id: number): void { shownChip(id); }
export function mathSet(id: number, tex: string): void { void setChip(id, tex).then(() => { if (editing) scheduleCommit(); }); }
export function mathDisplay(id: number): void { displayChip(id); }
/** the formula left last: text typed after it waits for the caret to be beside it */
let leaving: Promise<unknown> = Promise.resolve();
chipHooks.stop = () => stopText();
export function typeKeys(keys: KeyPress[]): void {
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

/** a formatting command on the text being retyped (bold, foreColor, fontName …; fontSizePx: a span with that size) */
export function exec(command: string, value?: string): void {
  if (!editing) return;
  editing.focus();
  if (command === 'fontSizePx' && value) styleRun('font-size', value);
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
  if (!src) return false;
  if (!(src.textContent ?? '').trim()) return false;
  for (const d of Array.from(src.querySelectorAll('*'))) if (!TEXT_TAGS.has(d.localName)) return false;
  return TEXT_TAGS.has(src.localName);
}

/** text can be typed into it: a text box, or a shape with nothing but text in it (an empty one too) */
export function canType(el: Element): boolean {
  if (isTextual(el)) return true;
  if (!(el instanceof HTMLElement) || REPLACED.has(el.localName) || el.classList.contains('slide') || el === document.body || el.classList.contains('ol-crop')) return false;
  const src = srcOf.get(el);
  if (!src || src.children.length || !TEXT_TAGS.has(src.localName)) return false;
  return !!slideOf(el) || el.offsetHeight > 0;
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

/** an SVG drawn with the pen: open paths only, no fill */
function isStrokeArt(el: Element): boolean {
  if (el.localName !== 'svg') return false;
  const shapes = Array.from(el.querySelectorAll('path, polyline')).filter(s => !s.closest('defs, marker, symbol'));
  return shapes.length > 0 && shapes.length === el.querySelectorAll('path, polyline, polygon, rect, circle, ellipse, line, text').length && shapes.every(s => (s.getAttribute('fill') ?? cs(s).fill) === 'none');
}

export function kindOf(el: Element): ObjKind {
  if (el.localName === 'img' || (el.classList.contains('ol-crop') && el.querySelector('img'))) return 'image';
  if (isSvgPart(el)) return 'svgpart';
  if (el.localName === 'svg') return lineOf(el) || isStrokeArt(el) ? 'line' : 'svg';
  if (REPLACED.has(el.localName)) return 'other';
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
  const r = docRect(el);
  const a = el instanceof HTMLElement || el.localName === 'svg' ? angleOf(el) : 0;
  if (!a) return { cx: r.x + r.w / 2, cy: r.y + r.h / 2, w: r.w, h: r.h, a: 0 };
  const he = el as HTMLElement;
  const w = he.offsetWidth ?? el.clientWidth, h = he.offsetHeight ?? el.clientHeight;
  return { cx: r.x + r.w / 2, cy: r.y + r.h / 2, w: w || r.w, h: h || r.h, a };
}

const rot = (x: number, y: number, deg: number): [number, number] => {
  const t = deg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
  return [x * c - y * s, x * s + y * c];
};

/** the object a pointer at `target` selects (see the header) */
function objectFor(target: Element, deep: boolean): Element | null {
  const el = sourced(target);
  if (!el || el === document.body || el === document.documentElement || el.localName === 'head') return null;
  if (deep) return el;
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
    strokeWidth = stroke ? parseFloat(tc.strokeWidth) || 1 : 0;
    dash = stroke ? dashOf('solid', tc.strokeDasharray) : 'none';
    arrowStart = !!t.getAttribute('marker-start');
    arrowEnd = !!t.getAttribute('marker-end');
  } else {
    fill = c.backgroundColor !== 'rgba(0, 0, 0, 0)' ? c.backgroundColor : null;
    const bw = parseFloat(c.borderTopWidth) || 0;
    stroke = c.borderTopStyle !== 'none' && bw > 0 ? c.borderTopColor : null;
    strokeWidth = stroke ? bw : 0;
    dash = stroke ? dashOf(c.borderTopStyle, '') : 'none';
  }
  return {
    fontSize: c.fontSize, fontFamily: c.fontFamily, fontWeight: c.fontWeight, fontStyle: c.fontStyle, textDecoration: c.textDecorationLine,
    color: c.color, background: c.backgroundColor, textAlign: c.textAlign, borderRadius: c.borderTopLeftRadius, opacity: c.opacity,
    border: `${c.borderTopWidth} ${c.borderTopStyle} ${c.borderTopColor}`,
    fill, stroke, strokeWidth, dash, rotate: angleOf(el), flipX: fl.x, flipY: fl.y,
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
  };
}

export function report(): void {
  if (state.version === null) return;
  post({ ol: 'selection', version: state.version, items: selected.map(item).filter((x): x is SelItem => !!x) });
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
  if (isCropping() || isNodeEditing()) { layer.innerHTML = ''; return; }
  const h = 8 / scale;
  layer.style.setProperty('--h', `${h}px`);
  layer.style.setProperty('--s', String(1 / scale));
  const parts: string[] = [];
  const bw = 1.5 / scale;
  if (hoverEl && !selected.includes(hoverEl) && hoverEl.isConnected && !editing) parts.push(frameAt('hover', boxOf(hoverEl), `outline-width:${1 / scale}px`));
  for (const p of peers) for (const path of p.paths) {
    const el = liveAt(path);
    if (!el) continue;
    const r = docRect(el);
    parts.push(`<div class="frame peer" style="left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;border-color:${esc(p.color)};border-width:${bw}px"></div><div class="peer-tag" style="left:${r.x}px;top:${r.y}px;background:${esc(p.color)}">${esc(p.name)}</div>`);
  }
  for (const el of selected) {
    if (!el.isConnected) continue;
    const b = boxOf(el);
    const locked = isLocked(el);
    parts.push(frameAt(`frame${el === editing ? ' editing' : ''}${locked ? ' locked' : ''}`, b, `border-width:${bw}px`));
    if (locked) { const [x, y] = handleAt(b, 1, 0); parts.push(`<div class="lock" style="left:${x}px;top:${y}px">🔒</div>`); }
  }
  if (selected.length === 1 && !editing && selected[0].isConnected && !isLocked(selected[0]) && !drag?.moved) {
    const el = selected[0];
    const line = lineOf(el);
    const ends = line ? lineEnds(line) : null;
    if (ends) {
      ends.forEach(([x, y], i) => parts.push(`<div class="handle end" data-h="p${i}" style="left:${x}px;top:${y}px;border-width:${bw}px"></div>`));
    } else {
      const b = boxOf(el);
      const fixed = fixedHeight(el);
      const hs: [string, number, number][] = [['nw', 0, 0], ['ne', 1, 0], ['sw', 0, 1], ['se', 1, 1], ['w', 0, 0.5], ['e', 1, 0.5]];
      if (fixed) hs.push(['n', 0.5, 0], ['s', 0.5, 1]);
      if (!isSvgPart(el)) for (const [k, fx, fy] of hs) { const [x, y] = handleAt(b, fx, fy); parts.push(`<div class="handle" data-h="${k}" style="left:${x}px;top:${y}px;cursor:${cursorFor(k, b.a)};border-width:${bw}px"></div>`); }
      if (rotatable(el)) {
        const stem = 18 / scale;
        const [tx, ty] = handleAt(b, 0.5, 0);
        const [rx, ry] = rot(0, -stem, b.a);
        parts.push(`<div class="stem" style="left:${tx - bw / 2}px;top:${ty - stem}px;width:${bw}px;height:${stem}px;transform:rotate(${b.a}deg)"></div>`);
        parts.push(`<div class="handle rot" data-h="rot" style="left:${tx + rx}px;top:${ty + ry}px;border-width:${bw}px"></div>`);
      }
    }
  }
  for (const g of guides) {
    parts.push(g.axis === 'x'
      ? `<div class="guide" style="left:${g.at}px;top:${g.from}px;width:${1 / scale}px;height:${g.to - g.from}px"></div>`
      : `<div class="guide" style="left:${g.from}px;top:${g.at}px;width:${g.to - g.from}px;height:${1 / scale}px"></div>`);
  }
  if (drawBox) parts.push(`<div class="draw" style="left:${drawBox.x}px;top:${drawBox.y}px;width:${drawBox.w}px;height:${drawBox.h}px;border-width:${bw}px"></div>`);
  if (dropBox) parts.push(`<div class="drop" style="left:${dropBox.x}px;top:${dropBox.y}px;width:${dropBox.w}px;height:${dropBox.h}px;border-width:${3 / scale}px"></div>`);
  if (drag && (drag.kind === 'pen' || ((drag.kind === 'draw') && (tool === 'line' || tool === 'arrow'))) && drag.pts && drag.moved) {
    const d = drag.kind === 'pen' ? smoothPath(drag.pts) : `M${drag.pts[0][0]} ${drag.pts[0][1]}L${drag.pts[drag.pts.length - 1][0]} ${drag.pts[drag.pts.length - 1][1]}`;
    parts.push(`<svg class="ink" width="1" height="1"><path d="${d}" fill="none" stroke="#2f6fde" stroke-width="${3 / scale}" stroke-linecap="round" stroke-linejoin="round"/></svg>`);
  }
  layer.innerHTML = parts.join('');
  for (const hd of Array.from(layer.querySelectorAll('.handle'))) hd.addEventListener('pointerdown', e => onHandleDown(e as PointerEvent, (hd as HTMLElement).dataset.h!), true);
}

/** rotated by its round handle: a box on a slide, a picture, a drawing (not the flow of a web page) */
function rotatable(el: Element): boolean {
  if (isSvgPart(el) || !movable(el)) return false;
  return el instanceof HTMLElement || el.localName === 'svg';
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

/** a smooth path through the points (the pen's preview and its result) */
export function smoothPath(pts: [number, number][]): string {
  const r = (n: number) => Math.round(n * 10) / 10;
  if (!pts.length) return '';
  let d = `M${r(pts[0][0])} ${r(pts[0][1])}`;
  if (pts.length === 1) return d + `L${r(pts[0][0] + 0.1)} ${r(pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
    d += `Q${r(pts[i][0])} ${r(pts[i][1])} ${r(mx)} ${r(my)}`;
  }
  const last = pts[pts.length - 1];
  return d + `L${r(last[0])} ${r(last[1])}`;
}

/** Ramer–Douglas–Peucker: the points a hand-drawn line needs */
function simplify(pts: [number, number][], eps: number): [number, number][] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    let best = -1, bd = 0;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / len;
      if (d > bd) { bd = d; best = i; }
    }
    if (best > 0 && bd > eps) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/* ------------------------------------------------------------------ pointer */

function swallow(e: MouseEvent): void {
  if (editing && editing.contains(e.target as Node)) return;
  // links and buttons of the page do nothing while editing it
  e.preventDefault();
  e.stopPropagation();
}

function onHover(e: PointerEvent): void {
  if (isCropping() || isNodeEditing()) return;
  if (isPenDrawing() && e.pointerType !== 'touch') { penMove(e); return; }
  if (e.pointerType === 'touch') { onTouchMove(e); return; }
  if (drag || editing) return;
  const t = e.target as Element;
  const el = tool === 'select' && t && !isForeign(t) ? objectFor(t, e.ctrlKey || e.metaKey) : null;
  if (el !== hoverEl) { hoverEl = el; draw(); }
}

interface DragEl {
  el: HTMLElement; r0: Rect; left0: number; top0: number; w0: number; h0: number; inline: Map<string, string>; transform0: string | null; angle: number;
  /** a cropped picture's own picture (resized with its frame) */
  inner?: { img: HTMLElement; l: number; t: number; w: number };
}
interface Drag {
  kind: 'move' | 'resize' | 'rotate' | 'end' | 'draw' | 'pen' | 'marquee' | 'pan';
  x0: number; y0: number;
  els: DragEl[];
  handle?: string;
  slide?: HTMLElement | null;
  moved: boolean;
  /** Alt+drag: a copy is moved, the original stays */
  copy?: boolean;
  /** the object pressed on (a click without a drag on one of several selected selects it alone) */
  clicked?: Element;
  pts?: [number, number][];
  /** the rotation drag's centre and starting angles */
  rot?: { cx: number; cy: number; a0: number; p0: number };
  last?: { x: number; y: number };
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
  if (isCropping() || isNodeEditing()) return;
  // keys typed after leaving a formula, before this press: theirs first
  flushAfter();
  if (e.pointerType === 'touch') {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
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
  // the Bézier pen: a node per press (pathedit.ts)
  if (tool === 'bezier') { penDown(e, el => slideOf(el)); addEventListener('pointerup', penUpOnce, true); return; }
  grab(e);
  const x = e.pageX, y = e.pageY;
  const base = { x0: x, y0: y, els: [], moved: false, pointerId: e.pointerId, pointerType: e.pointerType, last: { x: e.clientX, y: e.clientY } };
  if (tool !== 'select') {
    const slide = slideOf(t);
    drag = { ...base, kind: tool === 'pen' ? 'pen' : 'draw', slide, pts: [[x, y]] };
    capture();
    return;
  }
  const el = objectFor(t, e.ctrlKey || e.metaKey);
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
  if (!selected.includes(el)) { selected = [el]; report(); }
  draw();
  const els = selected.filter(s => movable(s) && !isLocked(s)).map(s => start(s as HTMLElement));
  drag = { ...base, kind: 'move', els, copy: e.altKey, clicked: el };
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
    inner: innerPicture(el),
  };
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
  } else drag = { ...base, kind: 'resize' };
  capture();
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
  const dx = e.pageX - drag.x0, dy = e.pageY - drag.y0;
  if (!drag.moved && Math.hypot(dx, dy) * scale < (drag.pointerType === 'touch' ? 6 : 3)) return;
  if (!drag.moved) {
    drag.moved = true;
    if (drag.hold) clearTimeout(drag.hold);
    if (drag.kind !== 'pan') document.documentElement.classList.add('ol-dragging');
  }
  if (drag.kind === 'pan') {
    const last = drag.last ?? { x: e.clientX, y: e.clientY };
    scrollBy(0, last.y - e.clientY);
    if (last.x !== e.clientX) post({ ol: 'pan', dx: e.clientX - last.x });
    drag.last = { x: e.clientX, y: e.clientY };
    return;
  }
  if (drag.kind === 'pen') {
    const last = drag.pts![drag.pts!.length - 1];
    if (Math.hypot(e.pageX - last[0], e.pageY - last[1]) * scale >= 1.5) drag.pts!.push([e.pageX, e.pageY]);
    draw();
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
    resizeLive(d, drag.handle!, dx, dy, e.shiftKey || d.el.localName === 'img' || d.el.classList.contains('ol-crop'), e.ctrlKey || e.metaKey);
  } else if (drag.kind === 'rotate') {
    const r = drag.rot!;
    let a = r.a0 + Math.atan2(e.pageY - r.cy, e.pageX - r.cx) * 180 / Math.PI - r.p0;
    a = ((a % 360) + 540) % 360 - 180;
    if (e.shiftKey) a = Math.round(a / 15) * 15;
    else for (const k of [-180, -90, 0, 90, 180]) if (Math.abs(a - k) < 3) a = k;
    if (Math.abs(a) === 180) a = 180;
    drag.els[0].el.style.setProperty('rotate', a ? `${Math.round(a * 10) / 10}deg` : '0deg');
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

function resizeLive(d: DragEl, h: string, dx: number, dy: number, keepRatio: boolean, noSnap: boolean): void {
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
  if (d.kind === 'pan') {
    // a tap on nothing: the selection goes
    if (!d.moved && !e.shiftKey) { selected = []; report(); }
    draw();
    return;
  }
  if (e.type === 'pointercancel') { for (const x of d.els) revertLive(x); drawBox = null; draw(); return; }
  if (d.kind === 'draw' || d.kind === 'pen') {
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
    draw();
    return;
  }
  if (d.kind === 'rotate') {
    const x = d.els[0];
    const v = x.el.style.getPropertyValue('rotate');
    const a = parseFloat(v) || 0;
    const path = pathOf(x.el);
    if (path) commit([{ t: 'style', path, set: { rotate: a ? `${Math.round(a * 10) / 10}deg` : null } }]);
    draw();
    return;
  }
  if (d.kind === 'end') {
    const op = lineOp(d.els[0].el);
    if (op) commit([op]);
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
  }
  commit(ops);
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

const touches = new Map<number, { x: number; y: number }>();
let pinch: { d: number; mx: number; my: number } | null = null;

function touchGeom(): { d: number; mx: number; my: number } | null {
  const ps = [...touches.values()];
  if (ps.length < 2) return null;
  const [a, b] = ps;
  return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
}

function startPinch(): void {
  // a drag the first finger began is given up
  if (drag) { for (const x of drag.els) revertLive(x); if (drag.hold) clearTimeout(drag.hold); release(); drag = null; drawBox = null; guides = []; draw(); }
  pinch = touchGeom();
}

function onTouchMove(e: PointerEvent): void {
  if (!touches.has(e.pointerId)) return;
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!pinch) return;
  const g = touchGeom();
  if (!g) return;
  const f = g.d / pinch.d;
  if (Math.abs(f - 1) > 0.002) post({ ol: 'zoom', factor: f, clientX: g.mx, clientY: g.my, pageY: g.my + scrollY });
  scrollBy(0, pinch.my - g.my);
  if (g.mx !== pinch.mx) post({ ol: 'pan', dx: g.mx - pinch.mx });
  pinch = g;
}

function onTouchUp(e: PointerEvent): void {
  if (e.pointerType !== 'touch') return;
  touches.delete(e.pointerId);
  if (touches.size < 2) pinch = null;
}

/** Ctrl / ⌘ + wheel (a trackpad pinch, as Chromium and Firefox report it) zooms; sideways scrolling pans */
function onWheel(e: WheelEvent): void {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    post({ ol: 'zoom', factor: Math.exp(-e.deltaY * k * 0.01), clientX: e.clientX, clientY: e.clientY, pageY: e.pageY });
    return;
  }
  const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
  if (dx && Math.abs(dx) > Math.abs(e.shiftKey ? 0 : e.deltaY)) { e.preventDefault(); post({ ol: 'pan', dx: -dx }); }
}

let gestureScale = 1;
function onGesture(e: Event & { scale?: number; clientX?: number; clientY?: number; pageY?: number }): void {
  e.preventDefault();
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
  post({ ol: 'ops', version: state.version, ops, ...extra });
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

function finishDraw(d: Drag, box: Rect | null, e: PointerEvent): void {
  if (state.version === null) return;
  const slide = d.slide ?? (state.kind !== 'page' ? slideOf(document.elementFromPoint(e.clientX, e.clientY)) : null);
  if (d.kind === 'pen' && (!d.moved || (d.pts?.length ?? 0) < 2)) return;
  const toLocal = (x: number, y: number): [number, number] => (slide ? slidePoint(slide, x, y) : [x, y]);
  let rect: Rect;
  let pts: [number, number][] | undefined;
  if (d.kind === 'pen') {
    const loc = d.pts!.map(([x, y]) => toLocal(x, y));
    pts = simplify(loc, 0.9);
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const x = Math.min(...xs), y = Math.min(...ys);
    rect = { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  } else if ((tool === 'line' || tool === 'arrow') && d.pts && d.pts.length === 2 && d.moved) {
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
  e.preventDefault();
  e.stopPropagation();
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
  el.addEventListener('paste', pastePlain);
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

function scheduleCommit(): void {
  if (editTimer) clearTimeout(editTimer);
  editTimer = setTimeout(commitText, 350);
}

/** the retyped text's markup, cleaned of what contenteditable adds */
function cleanHtml(el: HTMLElement): string {
  const c = el.cloneNode(true) as HTMLElement;
  for (const x of Array.from(c.querySelectorAll('[data-ol-runtime]'))) x.remove();
  for (const x of Array.from(c.querySelectorAll('[data-ol-texwait]'))) x.removeAttribute('data-ol-texwait');
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

function commitText(): void {
  if (editTimer) { clearTimeout(editTimer); editTimer = null; }
  if (!editing) return;
  const path = pathOf(editing);
  const html = cleanHtml(editing);
  if (!path || html === editStartHtml) return;
  editStartHtml = html;
  const ops: HtmlOp[] = [{ t: 'inner', path, html }];
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
  commitText();
  const el = editing;
  editing = null;
  guard.editing = null;
  el.removeEventListener('input', scheduleCommit);
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
    void typeset([el]).then(draw);
  }
  post({ ol: 'editing', path: null });
  draw();
}

export function isEditingText(): boolean { return !!editing; }

/** the caret is in code (a $ there is a dollar) */
function inCode(): boolean {
  const n = getSelection()?.anchorNode;
  const el = n ? (n.nodeType === Node.ELEMENT_NODE ? n as Element : n.parentElement) : null;
  return !!el?.closest('code, pre, kbd, samp');
}

/* ------------------------------------------------------------------ keys, clipboard, menu */

function onKeyDown(e: KeyboardEvent): void {
  if (isCropping() || isNodeEditing()) return;
  if (isPenDrawing() && penKey(e)) { e.preventDefault(); e.stopPropagation(); return; }
  const mod = e.ctrlKey || e.metaKey;
  if (editing) {
    // a formula was just opened here and LyX's formula editor has not the keyboard yet: the keys are the formula's
    if (chipOpening() && !isModifierKey(e)) { e.preventDefault(); holdKey(keyPress(e)); return; }
    // the formula editor gave the keyboard back (it left the formula): typed once the caret is beside the formula
    if (openChipEl() && !isModifierKey(e)) { e.preventDefault(); holdAfter(keyPress(e)); return; }
    if (e.key === 'Escape') { e.preventDefault(); stopText(); return; }
    // LyX: Ctrl+M a formula (Ctrl+Shift+M displayed), an arrow key into a formula goes into it
    if (mod && !e.altKey && e.key.toLowerCase() === 'm') { e.preventDefault(); e.stopPropagation(); insertChip(editing, e.shiftKey); return; }
    // $ typed opens a formula, as in documents ($$ a displayed one, Backspace gives the $ back)
    if (e.key === '$' && !mod && !e.altKey && !inCode()) { e.preventDefault(); insertChip(editing, false, '$'); return; }
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !mod && !e.shiftKey && !e.altKey) {
      const c = chipBeside(e.key === 'ArrowLeft' ? 'before' : 'after');
      if (c) { e.preventDefault(); openChip(c, null, e.key === 'ArrowLeft' ? 'end' : 'start'); return; }
    }
    if (mod && /^[zy]$/i.test(e.key)) { e.preventDefault(); commitText(); fwd(e); return; }
    if (mod && /^[bi]$/i.test(e.key)) { e.preventDefault(); exec(e.key.toLowerCase() === 'b' ? 'bold' : 'italic'); return; }
    if (mod && e.key.toLowerCase() === 'u') { e.preventDefault(); exec('underline'); return; }
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); commitText(); fwd(e); return; }
    return;
  }
  const tag = (e.target as Element | null)?.localName;
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  if (e.key === 'Escape') {
    e.preventDefault();
    if (tool !== 'select') { fwd(e); return; }
    const p = selected.length === 1 ? selected[0].parentElement ?? (selected[0].parentNode as Element | null) : null;
    selected = p && srcOf.has(p) && !p.classList.contains('slide') && p !== document.body ? [p] : [];
    report(); draw();
    return;
  }
  const free = selected.filter(s => !isLocked(s));
  if ((e.key === 'Delete' || e.key === 'Backspace') && selected.length) {
    e.preventDefault();
    const paths = free.map(pathOf).filter((p): p is Path => !!p);
    if (!paths.length) return;
    selected = selected.filter(isLocked);
    report();
    commit([{ t: 'remove', paths }]);
    return;
  }
  if (e.key === 'Enter' && selected.length === 1 && canType(selected[0])) { e.preventDefault(); beginText(selected[0] as HTMLElement, null, true); return; }
  if (e.key.startsWith('Arrow') && selected.length && !mod && !e.altKey) {
    e.preventDefault();
    const step = (e.shiftKey ? 10 : 1);
    const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
    const els = free.filter(movable).map(s => start(s as HTMLElement));
    for (const d of els) placeLive(d, dx, dy);
    commit(els.map(styleOp).filter((x): x is HtmlOp => !!x));
    draw();
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
    const s = selected[0] ? slideOf(selected[0]) : visibleSlideEl();
    if (s) { selected = Array.from(s.children).filter(c => srcOf.has(c) && !isForeign(c) && !c.classList.contains('notes')); report(); draw(); }
    return;
  }
  if (mod || e.key === 'F5' || e.key === 'Delete') { if (!['c', 'x', 'v'].includes(e.key.toLowerCase())) { e.preventDefault(); fwd(e); } return; }
  // a letter on a selected text object (or shape) starts retyping it
  if (e.key.length === 1 && !e.altKey && selected.length === 1 && canType(selected[0]) && !isLocked(selected[0])) {
    beginText(selected[0] as HTMLElement, null, true);
    return;
  }
  if (e.key.length === 1 || e.key === 'F2') fwd(e);
}

function fwd(e: KeyboardEvent): void {
  post({ ol: 'key', key: e.key, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey });
}

const CLIP_MARK = '<!--overlyx-objects-->';

function onCopy(e: ClipboardEvent): void {
  if (isCropping()) return;
  if (editing || !selected.length || !e.clipboardData) return;
  e.preventDefault();
  const html = selected.map(s => srcOf.get(s)?.outerHTML ?? '').join('\n');
  e.clipboardData.setData('text/html', CLIP_MARK + html);
  e.clipboardData.setData('text/plain', html);
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
  const target = selected[0] ? slideOf(selected[0]) : visibleSlideEl();
  const files = Array.from(e.clipboardData.files ?? []);
  if (files.length) {
    void Promise.all(files.map(async f => ({ name: f.name, type: f.type, data: await f.arrayBuffer() }))).then(fs2 => {
      post({ ol: 'pasteFiles', files: fs2, slide: target ? pathOf(target) : null, at: null });
    });
    return;
  }
  const html = e.clipboardData.getData('text/html');
  const parent = target ?? (selected[0]?.parentElement ?? document.body);
  const parentPath = parent ? pathOf(parent) : null;
  if (!parentPath) return;
  if (html.includes(CLIP_MARK)) {
    const body = html.slice(html.indexOf(CLIP_MARK) + CLIP_MARK.length).replace(/<!--EndFragment-->[\s\S]*$/, '');
    const tmp = document.createElement('template');
    tmp.innerHTML = body;
    const items = Array.from(tmp.content.children).map(c => {
      // pasted beside the original, not on it
      const el = c as HTMLElement;
      if (target) for (const p of ['left', 'top']) { const v = el.style.getPropertyValue(p); const m = /^(-?[\d.]+)px$/.exec(v); if (m) el.style.setProperty(p, `${Number(m[1]) + 24}px`); }
      return el.outerHTML;
    });
    if (items.length) commit(items.map(h => ({ t: 'insert', parent: parentPath, index: 1e6, html: h })), { select: 'inserted' });
    return;
  }
  // an SVG copied as text (from Inkscape, a code editor): a drawing
  const plain = e.clipboardData.getData('text/plain').trim();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(plain)) {
    post({ ol: 'pasteFiles', files: [{ name: 'pasted.svg', type: 'image/svg+xml', data: new TextEncoder().encode(plain).buffer as ArrayBuffer }], slide: target ? pathOf(target) : null, at: null });
    return;
  }
  if (!plain) return;
  post({ ol: 'draw', version: state.version!, tool: 'text', slide: target ? pathOf(target) : null, rect: { x: 80, y: 80, w: 600, h: 0 }, after: selected.length === 1 ? pathOf(selected[0]) : null });
}

function onContextMenu(e: MouseEvent): void {
  if (isCropping()) return;
  e.preventDefault();
  e.stopPropagation();
  if (editing) return;
  const el = objectFor(e.target as Element, e.ctrlKey || e.metaKey);
  if (el && !selected.includes(el)) { selected = [el]; report(); draw(); }
  const on = el ? 'object' : slideOf(e.target as Element) ? 'slide' : 'canvas';
  const s = slideOf(e.target as Element);
  post({ ol: 'contextmenu', x: e.clientX, y: e.clientY, on, slide: s ? slides().indexOf(s) : undefined });
}

/* ------------------------------------------------------------------ the slide in view */

let lastVisible = -1;
export function visibleSlideEl(): HTMLElement | null {
  const ss = slides();
  const mid = scrollY + innerHeight / 2;
  let best: HTMLElement | null = null, bd = Infinity;
  for (const s of ss) { const r = docRect(s); const d = mid < r.y ? r.y - mid : mid > r.y + r.h ? mid - r.y - r.h : 0; if (d < bd) { bd = d; best = s; } }
  return best;
}
export function visibleSlide(): void {
  const s = visibleSlideEl();
  const i = s ? slides().indexOf(s) : -1;
  if (i !== lastVisible) { lastVisible = i; post({ ol: 'visible', slide: i }); }
}

export function scrollToSlide(i: number, smooth = false): void {
  const s = slides()[i];
  if (!s) return;
  const r = docRect(s);
  scrollTo({ top: Math.max(0, r.y - Math.max(16, (innerHeight - r.h) / 2)), behavior: smooth ? 'smooth' : 'auto' });
}

void MODE;
