/**
 * The canvas in the editor's frame: selecting, moving, resizing, retyping and drawing objects of
 * the page, reported to the editor as operations on the text (core html/source.ts). What the
 * runtime draws (selection frames, handles, guides) lives in a shadow root on <html>, out of the
 * page's reach and out of its styles.
 *
 * A click selects an object: on a slide an element directly on it (a group's inside is reached by
 * double-clicking it, or with Alt), on a web page the innermost block. A double click on text
 * retypes it in place (contenteditable, with its TeX shown as written); Escape ends that, then
 * goes a level up. Dragging moves what is positioned (absolute, fixed, relative; on a slide also a
 * static element, which becomes relative), handles resize; positions are written in the units the
 * element had. Arrows nudge, Delete removes, ⌘D duplicates; ⌘Z and the rest go to the editor.
 */
import type { Path, SelItem, SelStyle, Tool, Rect, HtmlOp } from '../protocol';
import { MODE, post, state, srcOf, pathOf, liveAt, sourced, slides, slideOf, docRect, isForeign, sendLayout } from './env';
import { guard } from './reconcile';

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

const TEXT_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'sub', 'sup', 'small', 'mark', 'a', 'br', 'ul', 'ol', 'li', 'blockquote', 'code', 'q', 'cite', 'abbr', 'time', 'label', 'font', 'section', 'article', 'header', 'footer', 'figcaption', 'dt', 'dd', 'dl', 'td', 'th', 'caption', 'big', 'del', 'ins', 'kbd', 'var', 'samp']);
const REPLACED = new Set(['img', 'svg', 'video', 'canvas', 'iframe', 'object', 'embed', 'picture', 'audio']);

export function startEditing(): void {
  host = document.createElementNS(NS, 'ol-overlay') as HTMLElement;
  host.setAttribute('data-ol-runtime', '');
  host.style.cssText = 'all:initial;position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;display:block;';
  root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>
    :host { all: initial; }
    .layer { position: absolute; left: 0; top: 0; pointer-events: none; font: 12px system-ui, sans-serif; }
    .frame { position: absolute; border: 1.5px solid #2f6fde; box-sizing: border-box; pointer-events: none; }
    .frame.peer { border-style: dashed; }
    .frame.editing { border-color: #e8a33d; }
    .hover { position: absolute; outline: 1px solid rgba(47,111,222,.55); pointer-events: none; }
    .handle { position: absolute; width: var(--h); height: var(--h); margin: calc(var(--h) / -2) 0 0 calc(var(--h) / -2); background: #fff; border: 1.5px solid #2f6fde; box-sizing: border-box; border-radius: 2px; pointer-events: auto; }
    .guide { position: absolute; background: #e8467c; pointer-events: none; }
    .draw { position: absolute; border: 1.5px dashed #2f6fde; background: rgba(47,111,222,.08); pointer-events: none; }
    .tag { position: absolute; transform: translateY(-100%); background: #2f6fde; color: #fff; padding: 1px 5px; border-radius: 3px 3px 0 0; white-space: nowrap; pointer-events: none; font-size: calc(11px * var(--s)); }
    .peer-tag { position: absolute; transform: translateY(-100%); color: #fff; padding: 1px 5px; border-radius: 3px 3px 0 0; white-space: nowrap; pointer-events: none; font-size: calc(11px * var(--s)); }
  </style><div class="layer"></div>`;
  layer = root.querySelector('.layer') as HTMLElement;
  document.documentElement.appendChild(host);
  const css = document.createElement('style');
  css.setAttribute('data-ol-runtime', '');
  css.textContent = `[data-ol-editing] { outline: none !important; cursor: text !important; caret-color: auto; }
    html.ol-tool-draw, html.ol-tool-draw * { cursor: crosshair !important; }
    html.ol-dragging, html.ol-dragging * { cursor: grabbing !important; user-select: none !important; }
    html.ol-edit a { cursor: default; }`;
  document.head.appendChild(css);
  document.documentElement.classList.add('ol-edit');

  addEventListener('pointerdown', onPointerDown, true);
  addEventListener('pointermove', onHover, true);
  addEventListener('click', swallow, true);
  addEventListener('dblclick', onDblClick, true);
  addEventListener('contextmenu', onContextMenu, true);
  addEventListener('keydown', onKeyDown, true);
  addEventListener('copy', onCopy, true);
  addEventListener('cut', onCut, true);
  addEventListener('paste', onPaste, true);
  addEventListener('submit', e => e.preventDefault(), true);
  addEventListener('scroll', () => { draw(); post({ ol: 'scroll', y: scrollY }); visibleSlide(); }, { passive: true });
  addEventListener('resize', () => { draw(); sendLayout(); });
  new ResizeObserver(() => { draw(); }).observe(document.documentElement);
}

/* ------------------------------------------------------------------ messages from the editor */

export function setScale(s: number): void { scale = s > 0 ? s : 1; draw(); }
export function setTool(t: Tool): void {
  tool = t;
  document.documentElement.classList.toggle('ol-tool-draw', t !== 'select');
  if (t !== 'select') stopText();
}
export function setPeers(p: typeof peers): void { peers = p; draw(); }

export function selectPaths(paths: Path[]): void {
  selected = paths.map(liveAt).filter((e): e is Element => !!e);
  report();
  draw();
}

/** after a new version of the text: the selection found again, the frame redrawn */
export function afterSource(): void {
  selected = selected.map(e => (e.isConnected ? e : null)).filter((e): e is Element => !!e && !!pathOf(e));
  if (editing && !editing.isConnected) { editing = null; post({ ol: 'editing', path: null }); }
  report();
  draw();
}

export function editTextAt(path: Path, selectAll = false): void {
  const el = liveAt(path);
  if (!el) return;
  selected = [el];
  report();
  if (isTextual(el)) beginText(el as HTMLElement, null, selectAll);
  draw();
}

export function exec(command: string, value?: string): void {
  if (!editing) return;
  editing.focus();
  document.execCommand(command, false, value);
  scheduleCommit();
}

/* ------------------------------------------------------------------ what can be done with an element */

function cs(el: Element): CSSStyleDeclaration { return getComputedStyle(el); }

/** its text can be retyped in place: only text and simple text markup inside */
export function isTextual(el: Element): boolean {
  if (REPLACED.has(el.localName) || el.classList.contains('slide') || el === document.body) return false;
  const src = srcOf.get(el);
  if (!src) return false;
  if (!(src.textContent ?? '').trim()) return false;
  for (const d of Array.from(src.querySelectorAll('*'))) if (!TEXT_TAGS.has(d.localName)) return false;
  return TEXT_TAGS.has(src.localName);
}

function movable(el: Element): boolean {
  const p = cs(el).position;
  if (p === 'absolute' || p === 'fixed' || p === 'relative') return true;
  return state.kind !== 'page' && !!slideOf(el) && el !== slideOf(el);
}

function fixedHeight(el: Element): boolean {
  if (REPLACED.has(el.localName)) return true;
  const src = srcOf.get(el);
  if (src && /(^|;)\s*height\s*:/i.test(src.getAttribute('style') ?? '')) return true;
  return !(el.textContent ?? '').trim();
}

/** the object a pointer at `target` selects (see the header) */
function objectFor(target: Element, deep: boolean): Element | null {
  const el = sourced(target);
  if (!el || el === document.body || el === document.documentElement || el.localName === 'head') return null;
  if (deep) return el;
  // inside the selection's group: the child of that group
  const scope = selected.length === 1 ? selected[0].parentElement : null;
  if (scope && scope.contains(el) && !scope.classList.contains('slide') && scope !== document.body) {
    for (let e: Element | null = el; e; e = e.parentElement) if (e.parentElement === scope) return e;
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
  return el.localName === 'img' ? 'Picture' : el.localName === 'svg' ? 'Drawing' : 'Shape';
}

function styleOf(el: Element): SelStyle {
  const c = cs(el);
  return {
    fontSize: c.fontSize, fontFamily: c.fontFamily, fontWeight: c.fontWeight, fontStyle: c.fontStyle, textDecoration: c.textDecorationLine,
    color: c.color, background: c.backgroundColor, textAlign: c.textAlign, borderRadius: c.borderTopLeftRadius, opacity: c.opacity,
    border: `${c.borderTopWidth} ${c.borderTopStyle} ${c.borderTopColor}`,
  };
}

function item(el: Element): SelItem | null {
  const path = pathOf(el);
  if (!path) return null;
  const s = slideOf(el);
  return {
    path, tag: el.localName, label: label(el), rect: docRect(el), movable: movable(el), text: isTextual(el), fixedHeight: fixedHeight(el), style: styleOf(el),
    slide: s ? slides().indexOf(s) : -1,
  };
}

function report(): void {
  if (state.version === null) return;
  post({ ol: 'selection', version: state.version, items: selected.map(item).filter((x): x is SelItem => !!x) });
}

/* ------------------------------------------------------------------ drawing */

let hoverEl: Element | null = null;
let guides: { axis: 'x' | 'y'; at: number; from: number; to: number }[] = [];
let drawBox: Rect | null = null;

export function draw(): void {
  if (!layer) return;
  const h = 8 / scale;
  layer.style.setProperty('--h', `${h}px`);
  layer.style.setProperty('--s', String(1 / scale));
  const parts: string[] = [];
  const bw = 1.5 / scale;
  if (hoverEl && !selected.includes(hoverEl) && hoverEl.isConnected && !editing) {
    const r = docRect(hoverEl);
    parts.push(`<div class="hover" style="left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;outline-width:${1 / scale}px"></div>`);
  }
  for (const p of peers) for (const path of p.paths) {
    const el = liveAt(path);
    if (!el) continue;
    const r = docRect(el);
    parts.push(`<div class="frame peer" style="left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;border-color:${esc(p.color)};border-width:${bw}px"></div><div class="peer-tag" style="left:${r.x}px;top:${r.y}px;background:${esc(p.color)}">${esc(p.name)}</div>`);
  }
  for (const el of selected) {
    if (!el.isConnected) continue;
    const r = docRect(el);
    parts.push(`<div class="frame${el === editing ? ' editing' : ''}" style="left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;border-width:${bw}px"></div>`);
  }
  if (selected.length === 1 && !editing && selected[0].isConnected) {
    const el = selected[0];
    const r = docRect(el);
    const fixed = fixedHeight(el);
    const hs: [string, number, number][] = [['nw', 0, 0], ['ne', 1, 0], ['sw', 0, 1], ['se', 1, 1], ['w', 0, 0.5], ['e', 1, 0.5]];
    if (fixed) hs.push(['n', 0.5, 0], ['s', 0.5, 1]);
    for (const [k, fx, fy] of hs) parts.push(`<div class="handle" data-h="${k}" style="left:${r.x + r.w * fx}px;top:${r.y + r.h * fy}px;cursor:${k}-resize;border-width:${bw}px"></div>`);
  }
  for (const g of guides) {
    parts.push(g.axis === 'x'
      ? `<div class="guide" style="left:${g.at}px;top:${g.from}px;width:${1 / scale}px;height:${g.to - g.from}px"></div>`
      : `<div class="guide" style="left:${g.from}px;top:${g.at}px;width:${g.to - g.from}px;height:${1 / scale}px"></div>`);
  }
  if (drawBox) parts.push(`<div class="draw" style="left:${drawBox.x}px;top:${drawBox.y}px;width:${drawBox.w}px;height:${drawBox.h}px;border-width:${bw}px"></div>`);
  layer.innerHTML = parts.join('');
  for (const hd of Array.from(layer.querySelectorAll('.handle'))) hd.addEventListener('pointerdown', e => onHandleDown(e as PointerEvent, (hd as HTMLElement).dataset.h!), true);
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
  if (drag || editing) return;
  const t = e.target as Element;
  const el = tool === 'select' && t && !isForeign(t) ? objectFor(t, e.altKey) : null;
  if (el !== hoverEl) { hoverEl = el; draw(); }
}

interface Drag {
  kind: 'move' | 'resize' | 'draw' | 'marquee';
  x0: number; y0: number;
  els: { el: HTMLElement; r0: Rect; left0: number; top0: number; w0: number; h0: number; inline: Map<string, string> }[];
  handle?: string;
  slide?: HTMLElement | null;
  moved: boolean;
}
let drag: Drag | null = null;

function onPointerDown(e: PointerEvent): void {
  if (e.button !== 0) return;
  const t = e.target as Element;
  if (t === host) return;   // a handle (in the shadow root) handles itself
  if (editing) {
    if (editing.contains(t)) return;   // a click inside the text being retyped: the caret's
    stopText();
  }
  e.preventDefault();
  e.stopPropagation();
  const x = e.pageX, y = e.pageY;
  if (tool !== 'select') {
    const slide = slideOf(t);
    drag = { kind: 'draw', x0: x, y0: y, els: [], slide, moved: false };
    capture(e);
    return;
  }
  const el = objectFor(t, e.altKey || e.metaKey || e.ctrlKey);
  if (!el) {
    if (!e.shiftKey) { selected = []; report(); }
    drag = { kind: 'marquee', x0: x, y0: y, els: [], slide: slideOf(t), moved: false };
    draw();
    capture(e);
    return;
  }
  if (e.shiftKey) {
    selected = selected.includes(el) ? selected.filter(s => s !== el) : [...selected, el];
    report(); draw();
    return;
  }
  if (!selected.includes(el)) { selected = [el]; report(); }
  draw();
  const els = selected.filter(s => movable(s)).map(s => start(s as HTMLElement));
  drag = { kind: 'move', x0: x, y0: y, els, moved: false };
  capture(e);
}

function start(el: HTMLElement): Drag['els'][number] {
  const c = cs(el);
  const r0 = docRect(el);
  const inline = new Map<string, string>();
  for (const p of ['left', 'top', 'right', 'bottom', 'width', 'height', 'position']) inline.set(p, el.style.getPropertyValue(p));
  const left0 = parseFloat(c.left), top0 = parseFloat(c.top);
  return { el, r0, left0: Number.isFinite(left0) ? left0 : 0, top0: Number.isFinite(top0) ? top0 : 0, w0: parseFloat(c.width) || r0.w, h0: parseFloat(c.height) || r0.h, inline };
}

function onHandleDown(e: PointerEvent, handle: string): void {
  if (e.button !== 0 || selected.length !== 1) return;
  e.preventDefault();
  e.stopPropagation();
  drag = { kind: 'resize', x0: e.pageX, y0: e.pageY, els: [start(selected[0] as HTMLElement)], handle, moved: false };
  capture(e);
}

function capture(e: PointerEvent): void {
  addEventListener('pointermove', onDragMove, true);
  addEventListener('pointerup', onDragEnd, true);
  addEventListener('pointercancel', onDragEnd, true);
  void e;
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
  if (!drag) return;
  const dx = e.pageX - drag.x0, dy = e.pageY - drag.y0;
  if (!drag.moved && Math.hypot(dx, dy) * scale < 3) return;
  if (!drag.moved) { drag.moved = true; document.documentElement.classList.add('ol-dragging'); }
  if (drag.kind === 'draw' || drag.kind === 'marquee') {
    drawBox = { x: Math.min(drag.x0, e.pageX), y: Math.min(drag.y0, e.pageY), w: Math.abs(dx), h: Math.abs(dy) };
    if (drag.kind === 'draw' && e.shiftKey && (tool === 'rect' || tool === 'ellipse')) { const m = Math.max(drawBox.w, drawBox.h); drawBox = { x: drag.x0 + (dx < 0 ? -m : 0), y: drag.y0 + (dy < 0 ? -m : 0), w: m, h: m }; }
    draw();
    return;
  }
  if (drag.kind === 'move') {
    let ddx = dx, ddy = dy;
    if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) ddy = 0; else ddx = 0; }
    if (!e.altKey && drag.els.length) {
      const u = union(drag.els.map(d => d.r0));
      const s = snap({ ...u, x: u.x + ddx, y: u.y + ddy }, new Set(drag.els.map(d => d.el)), slideOf(drag.els[0].el), { x: true, y: true });
      ddx += s.dx; ddy += s.dy;
    } else guides = [];
    for (const d of drag.els) placeLive(d, ddx, ddy);
  } else if (drag.kind === 'resize') {
    const d = drag.els[0];
    resizeLive(d, drag.handle!, dx, dy, e.shiftKey || d.el.localName === 'img', e.altKey);
  }
  draw();
}

function union(rs: Rect[]): Rect {
  const x = Math.min(...rs.map(r => r.x)), y = Math.min(...rs.map(r => r.y));
  return { x, y, w: Math.max(...rs.map(r => r.x + r.w)) - x, h: Math.max(...rs.map(r => r.y + r.h)) - y };
}

function placeLive(d: Drag['els'][number], dx: number, dy: number): void {
  const st = d.el.style;
  if (cs(d.el).position === 'static' && !d.inline.get('position')) st.setProperty('position', 'relative');
  const relStatic = st.getPropertyValue('position') === 'relative' && !d.inline.get('position');
  const l0 = relStatic ? 0 : d.left0, t0 = relStatic ? 0 : d.top0;
  st.setProperty('left', `${l0 + dx}px`);
  st.setProperty('top', `${t0 + dy}px`);
}

function resizeLive(d: Drag['els'][number], h: string, dx: number, dy: number, keepRatio: boolean, noSnap: boolean): void {
  let w = d.w0, hh = d.h0, l = d.left0, t = d.top0;
  if (h.includes('e')) w = d.w0 + dx;
  if (h.includes('w')) { w = d.w0 - dx; l = d.left0 + dx; }
  if (h.includes('s')) hh = d.h0 + dy;
  if (h.includes('n')) { hh = d.h0 - dy; t = d.top0 + dy; }
  if (keepRatio && h.length === 2 && d.w0 > 0 && d.h0 > 0) {
    const r = d.h0 / d.w0;
    hh = w * r;
    if (h.includes('n')) t = d.top0 + (d.h0 - hh);
  }
  w = Math.max(4, w); hh = Math.max(4, hh);
  if (!noSnap) {
    const r = { x: d.r0.x + (l - d.left0), y: d.r0.y + (t - d.top0), w: w + (d.r0.w - d.w0), h: hh + (d.r0.h - d.h0) };
    const s = snap(r, new Set([d.el]), slideOf(d.el), { x: true, y: true });
    if (h.includes('e')) w += s.dx; else if (h.includes('w')) { w -= s.dx; l += s.dx; }
    if (h.includes('s')) hh += s.dy; else if (h.includes('n')) { hh -= s.dy; t += s.dy; }
  } else guides = [];
  const st = d.el.style;
  st.setProperty('width', `${w}px`);
  if (fixedHeight(d.el) || h === 'n' || h === 's') st.setProperty('height', `${hh}px`);
  const pos = cs(d.el).position;
  if (pos !== 'static' && (h.includes('w') || h.includes('n'))) { st.setProperty('left', `${l}px`); st.setProperty('top', `${t}px`); }
}

function onDragEnd(e: PointerEvent): void {
  removeEventListener('pointermove', onDragMove, true);
  removeEventListener('pointerup', onDragEnd, true);
  removeEventListener('pointercancel', onDragEnd, true);
  document.documentElement.classList.remove('ol-dragging');
  const d = drag;
  drag = null;
  guides = [];
  if (!d) return;
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
    if (box && d.moved && d.slide) {
      const inside = Array.from(d.slide.children).filter(c => srcOf.has(c) && !isForeign(c)).filter(c => { const r = docRect(c); return r.w && r.h && r.x < box.x + box.w && r.x + r.w > box.x && r.y < box.y + box.h && r.y + r.h > box.y; });
      selected = e.shiftKey ? [...new Set([...selected, ...inside])] : inside;
      report();
    }
    draw();
    return;
  }
  if (!d.moved) {
    draw();
    return;
  }
  const ops: HtmlOp[] = [];
  for (const x of d.els) {
    const op = styleOp(x);
    if (op) ops.push(op);
  }
  commit(ops);
  draw();
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

/** what a move or resize changed, as a style edit in the source's units */
function styleOp(d: Drag['els'][number]): HtmlOp | null {
  const path = pathOf(d.el);
  if (!path) return null;
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
function commit(ops: HtmlOp[], extra: { select?: 'inserted' | 'keep'; then?: 'editText' } = {}): void {
  if (!ops.length || state.version === null) return;
  post({ ol: 'ops', version: state.version, ops, ...extra });
}

/* ------------------------------------------------------------------ drawing new objects */

function finishDraw(d: Drag, box: Rect | null, e: PointerEvent): void {
  if (state.version === null) return;
  const slide = d.slide ?? (state.kind !== 'page' ? slideOf(document.elementFromPoint(e.clientX, e.clientY)) : null);
  let rect: Rect;
  if (slide) {
    const sr = docRect(slide);
    const sx = slide.offsetWidth ? sr.w / slide.offsetWidth : 1;
    const b = box && d.moved ? box : { x: d.x0, y: d.y0, w: 0, h: 0 };
    rect = { x: (b.x - sr.x - slide.clientLeft) / sx, y: (b.y - sr.y - slide.clientTop) / sx, w: b.w / sx, h: b.h / sx };
  } else rect = box && d.moved ? box : { x: d.x0, y: d.y0, w: 0, h: 0 };
  const slidePath = slide ? pathOf(slide) : null;
  const after = selected.length === 1 ? pathOf(selected[0]) : null;
  post({ ol: 'draw', version: state.version, tool, slide: slidePath, rect, after });
}

/* ------------------------------------------------------------------ text */

function onDblClick(e: MouseEvent): void {
  e.preventDefault();
  e.stopPropagation();
  if (tool !== 'select') return;
  const t = e.target as Element;
  if (editing && editing.contains(t)) return;
  const cur = selected.length === 1 ? selected[0] : null;
  // the selected object retyped, or its text-bearing part under the pointer
  let target: Element | null = null;
  if (cur && cur.contains(t)) {
    if (isTextual(cur)) target = cur;
    else {
      for (let x: Element | null = sourced(t); x && x !== cur; x = x.parentElement) if (isTextual(x)) target = x;
      if (!target) {
        // into the group: the child under the pointer
        for (let x: Element | null = sourced(t); x && x !== cur; x = x.parentElement) if (x.parentElement === cur) { selected = [x]; report(); draw(); return; }
      }
    }
  } else {
    const el = objectFor(t, false);
    if (el) { selected = [el]; target = isTextual(el) ? el : null; report(); }
  }
  if (target) { selected = [target]; report(); beginText(target as HTMLElement, { x: e.clientX, y: e.clientY }); }
  draw();
}

function beginText(el: HTMLElement, at: { x: number; y: number } | null, selectAll = false): void {
  const src = srcOf.get(el);
  if (!src) return;
  stopText();
  editing = el;
  guard.editing = el;
  // the text as written: TeX instead of typeset math
  el.innerHTML = src.innerHTML;
  el.classList.add('ol-notex');
  el.setAttribute('data-ol-editing', '');
  el.contentEditable = 'true';
  editStartHtml = el.innerHTML;
  try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch { /* old browsers */ }
  el.focus({ preventScroll: true });
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
  el.addEventListener('input', scheduleCommit);
  el.addEventListener('paste', pastePlain);
  post({ ol: 'editing', path: pathOf(el) });
  draw();
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
  // a trailing <br> a browser leaves in an emptied block
  let html = c.innerHTML.replace(/<br>(\s*)$/, '$1');
  if (/^\s*<br>\s*$/.test(html)) html = '';
  return html;
}

function commitText(): void {
  if (editTimer) { clearTimeout(editTimer); editTimer = null; }
  if (!editing) return;
  const path = pathOf(editing);
  const html = cleanHtml(editing);
  if (!path || html === editStartHtml) return;
  editStartHtml = html;
  commit([{ t: 'inner', path, html }]);
}

/** end retyping: what was typed sent, the element shown as the text has it (math typeset) */
export function stopText(): void {
  if (!editing) return;
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
    void import('./math').then(m => m.typeset([el]));
  }
  post({ ol: 'editing', path: null });
  draw();
}

/* ------------------------------------------------------------------ keys, clipboard, menu */

function onKeyDown(e: KeyboardEvent): void {
  const mod = e.ctrlKey || e.metaKey;
  if (editing) {
    if (e.key === 'Escape') { e.preventDefault(); stopText(); return; }
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
    const p = selected.length === 1 ? selected[0].parentElement : null;
    selected = p && srcOf.has(p) && !p.classList.contains('slide') && p !== document.body ? [p] : [];
    report(); draw();
    return;
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && selected.length) {
    e.preventDefault();
    const paths = selected.map(pathOf).filter((p): p is Path => !!p);
    selected = [];
    report();
    commit([{ t: 'remove', paths }]);
    return;
  }
  if (e.key === 'Enter' && selected.length === 1 && isTextual(selected[0])) { e.preventDefault(); beginText(selected[0] as HTMLElement, null, true); return; }
  if (e.key.startsWith('Arrow') && selected.length && !mod) {
    e.preventDefault();
    const step = (e.shiftKey ? 10 : 1);
    const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
    const els = selected.filter(movable).map(s => start(s as HTMLElement));
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
  // a letter on a selected text object starts retyping it
  if (e.key.length === 1 && !e.altKey && selected.length === 1 && isTextual(selected[0])) {
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
  if (editing || !selected.length || !e.clipboardData) return;
  e.preventDefault();
  const html = selected.map(s => srcOf.get(s)?.outerHTML ?? '').join('\n');
  e.clipboardData.setData('text/html', CLIP_MARK + html);
  e.clipboardData.setData('text/plain', html);
}

function onCut(e: ClipboardEvent): void {
  if (editing || !selected.length) return;
  onCopy(e);
  const paths = selected.map(pathOf).filter((p): p is Path => !!p);
  selected = [];
  report();
  commit([{ t: 'remove', paths }]);
}

function onPaste(e: ClipboardEvent): void {
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
  const text = e.clipboardData.getData('text/plain').trim();
  if (!text) return;
  post({ ol: 'draw', version: state.version!, tool: 'text', slide: target ? pathOf(target) : null, rect: { x: 80, y: 80, w: 600, h: 0 }, after: selected.length === 1 ? pathOf(selected[0]) : null });
  void text;
}

function onContextMenu(e: MouseEvent): void {
  e.preventDefault();
  e.stopPropagation();
  if (editing) return;
  const el = objectFor(e.target as Element, e.altKey);
  if (el && !selected.includes(el)) { selected = [el]; report(); draw(); }
  post({ ol: 'contextmenu', x: e.clientX, y: e.clientY });
}

/* ------------------------------------------------------------------ the slide in view */

let lastVisible = -1;
function visibleSlideEl(): HTMLElement | null {
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
