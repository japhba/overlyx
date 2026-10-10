/**
 * Cropping a picture on the canvas, PowerPoint's way: the whole picture shown faintly, the crop
 * frame over it with black corner and edge crop handles; dragging inside the frame moves the
 * picture under it (the frame stays where it is), the faint picture's round corner handles scale
 * it about the opposite corner, the crop handles move the frame's sides (Shift keeps its shape).
 * Enter, or a click beside it, keeps the crop; Escape leaves the picture as it was.
 *
 * The markup: a cropped picture is a frame `<div class="ol-crop">` (where the picture was, its size,
 * `overflow: hidden`, and the picture's placement — transform, opacity, border radius, shadow — and
 * its id and classes) around the picture, placed absolutely inside it. Cropping a picture the first
 * time wraps it (an `outer` operation); cropping it again changes the two styles; Reset crop puts
 * the whole picture back as a plain `<img>` at the frame's top-left, at its current scale.
 *
 * The geometry (Box) is in the object's own CSS px, in its parent's coordinates (CSS left / top);
 * the frame is F, the whole picture P. The pure functions are tested (tests/crop.test.ts); the
 * interactive part draws into a layer of its own in the runtime's shadow root (edit.ts's layer is
 * redrawn wholesale) and talks to edit.ts through a CropContext.
 */
import type { HtmlOp, Path } from '../protocol';

export interface Box { x: number; y: number; w: number; h: number }
export type FrameHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export type Corner = 'nw' | 'ne' | 'se' | 'sw';
export type CropShape = 'rect' | 'circle';

/** the smallest frame (px) */
export const MIN_FRAME = 8;

/* ------------------------------------------------------------------ geometry */

/** the picture moved by (dx, dy), kept covering the frame */
export function panPicture(F: Box, P: Box, dx: number, dy: number): Box {
  const x = Math.min(F.x, Math.max(F.x + F.w - P.w, P.x + dx));
  const y = Math.min(F.y, Math.max(F.y + F.h - P.h, P.y + dy));
  return { ...P, x, y };
}

/** the picture scaled about the corner opposite `corner` by dragging that corner (dx, dy); keeps its aspect and still covers the frame */
export function scalePicture(F: Box, P: Box, corner: Corner, dx: number, dy: number): Box {
  const sx = corner.includes('e') ? 1 : -1, sy = corner.includes('s') ? 1 : -1;
  // the corner's movement along the picture's diagonal
  const d = (sx * dx * P.w + sy * dy * P.h) / (P.w * P.w + P.h * P.h);
  let s = 1 + d;
  // anchored at the opposite corner, the picture must still reach over the frame's far sides
  const ax = sx > 0 ? P.x : P.x + P.w, ay = sy > 0 ? P.y : P.y + P.h;
  const needW = sx > 0 ? F.x + F.w - ax : ax - F.x;
  const needH = sy > 0 ? F.y + F.h - ay : ay - F.y;
  const minS = Math.max(needW / P.w, needH / P.h, MIN_FRAME / Math.min(P.w, P.h));
  s = Math.max(minS, Math.min(50, s));
  const w = P.w * s, h = P.h * s;
  return { x: sx > 0 ? ax : ax - w, y: sy > 0 ? ay : ay - h, w, h };
}

/** the frame with the side(s) of `handle` moved, kept on the picture and at least MIN_FRAME; Shift (keepAspect) keeps its proportions */
export function resizeFrame(F: Box, P: Box, handle: FrameHandle, dx: number, dy: number, keepAspect = false): Box {
  let x0 = F.x, y0 = F.y, x1 = F.x + F.w, y1 = F.y + F.h;
  const W = handle.includes('w'), E = handle.includes('e'), N = handle.includes('n'), S = handle.includes('s');
  if (W) x0 += dx; if (E) x1 += dx; if (N) y0 += dy; if (S) y1 += dy;
  const px0 = P.x, py0 = P.y, px1 = P.x + P.w, py1 = P.y + P.h;
  const clamp = () => {
    if (W) x0 = Math.max(px0, Math.min(x1 - MIN_FRAME, x0));
    if (E) x1 = Math.min(px1, Math.max(x0 + MIN_FRAME, x1));
    if (N) y0 = Math.max(py0, Math.min(y1 - MIN_FRAME, y0));
    if (S) y1 = Math.min(py1, Math.max(y0 + MIN_FRAME, y1));
  };
  clamp();
  if (keepAspect && F.w > 0 && F.h > 0) {
    const r = F.w / F.h;
    const cx = F.x + F.w / 2, cy = F.y + F.h / 2;
    if ((W || E) && (N || S)) {
      // a corner: the side that moved more leads
      let w = x1 - x0, h = y1 - y0;
      if (Math.abs(w / F.w - 1) >= Math.abs(h / F.h - 1)) h = w / r; else w = h * r;
      // the room on the picture beyond the fixed corner
      const maxW = W ? x1 - px0 : px1 - x0, maxH = N ? y1 - py0 : py1 - y0;
      const k = Math.min(1, maxW / w, maxH / h);
      w *= k; h *= k;
      if (W) x0 = x1 - w; else x1 = x0 + w;
      if (N) y0 = y1 - h; else y1 = y0 + h;
    } else if (W || E) {
      // an edge: the other dimension follows, about the middle
      let h = (x1 - x0) / r;
      h = Math.min(h, 2 * (cy - py0), 2 * (py1 - cy));
      const w = h * r;
      if (W) x0 = x1 - w; else x1 = x0 + w;
      y0 = cy - h / 2; y1 = cy + h / 2;
    } else {
      let w = (y1 - y0) * r;
      w = Math.min(w, 2 * (cx - px0), 2 * (px1 - cx));
      const h = w / r;
      if (N) y0 = y1 - h; else y1 = y0 + h;
      x0 = cx - w / 2; x1 = cx + w / 2;
    }
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** the largest frame of `ratio` (width / height) on the picture, centred where the frame is; null: the frame as it is */
export function presetFrame(F: Box, P: Box, ratio: number | null): Box {
  if (!ratio || !(ratio > 0)) return F;
  let w = Math.min(P.w, P.h * ratio), h = w / ratio;
  w = Math.max(MIN_FRAME, w); h = Math.max(MIN_FRAME, h);
  const cx = F.x + F.w / 2, cy = F.y + F.h / 2;
  const x = Math.max(P.x, Math.min(P.x + P.w - w, cx - w / 2));
  const y = Math.max(P.y, Math.min(P.y + P.h - h, cy - h / 2));
  return { x, y, w, h };
}

/** the named aspect presets of the toolbar (width / height; null = free) */
export const ASPECTS: { id: string; label: string; ratio: number | null; shape?: CropShape }[] = [
  { id: 'free', label: 'Free', ratio: null },
  { id: '1:1', label: 'Square 1:1', ratio: 1 },
  { id: '4:3', label: '4:3', ratio: 4 / 3 },
  { id: '3:4', label: '3:4', ratio: 3 / 4 },
  { id: '16:9', label: '16:9', ratio: 16 / 9 },
  { id: '9:16', label: '9:16', ratio: 9 / 16 },
  { id: 'circle', label: 'Circle', ratio: 1, shape: 'circle' },
  { id: 'oval', label: 'Oval (keep the frame)', ratio: null, shape: 'circle' },
];

/* ------------------------------------------------------------------ markup */

/** what the operations need of the source */
export interface CropSource {
  /** the object: the bare <img>, or the .ol-crop frame around it */
  path: Path;
  wrapped: boolean;
  /** the object's source attributes (style included), in order */
  attrs: [string, string][];
  /** wrapped: the picture inside the frame */
  imgPath?: Path;
  imgAttrs?: [string, string][];
  /** the object's computed position: absolute / fixed / relative are placed by left and top, static flows */
  position: string;
  /** the picture's natural height / width (to leave its height auto) */
  ratio?: number;
}

type Decl = [string, string];

export function parseStyle(style: string | null | undefined): Decl[] {
  const out: Decl[] = [];
  for (const d of (style ?? '').split(';')) {
    const i = d.indexOf(':');
    if (i > 0) { const k = d.slice(0, i).trim().toLowerCase(); const v = d.slice(i + 1).trim(); if (k && v) out.push([k, v]); }
  }
  return out;
}
export const styleText = (ds: Decl[]) => ds.map(([k, v]) => `${k}: ${v}`).join('; ');
const px = (n: number) => `${Math.round(n * 100) / 100}px`;
const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const attrText = (as: [string, string][]) => as.map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${escAttr(v)}"`)).join('');
const get = (as: [string, string][] | undefined, k: string) => as?.find(a => a[0].toLowerCase() === k)?.[1] ?? null;

/** the picture's own look: stays on the <img> */
const IMG_ONLY = new Set(['object-fit', 'object-position', 'image-rendering', 'image-orientation', 'filter', 'mix-blend-mode']);
/** the box's size and place: set by the crop */
const GEOMETRY = new Set(['position', 'left', 'top', 'right', 'bottom', 'inset', 'width', 'height', 'max-width', 'max-height', 'min-width', 'min-height', 'aspect-ratio', 'overflow', 'overflow-x', 'overflow-y']);
/** what makes the frame a circle */
const CIRCLE = '50%';

const placed = (pos: string) => pos === 'absolute' || pos === 'fixed' || pos === 'relative';
const naturalHeight = (P: Box, ratio?: number) => !ratio || Math.abs(P.h - P.w * ratio) <= Math.max(1, P.h * 0.01);

function imgStyle(F: Box, P: Box, ratio: number | undefined, keep: Decl[]): string {
  return styleText([
    ['position', 'absolute'], ['left', px(P.x - F.x)], ['top', px(P.y - F.y)], ['width', px(P.w)],
    ['height', naturalHeight(P, ratio) ? 'auto' : px(P.h)], ['max-width', 'none'], ['max-height', 'none'],
    ...keep.filter(([k]) => IMG_ONLY.has(k)),
  ]);
}

/**
 * The operations that give the picture the frame F with the whole picture at P: the first time a
 * wrap (outer), after that a style change of the frame and of the picture. `shape`: 'circle' makes
 * the frame round, 'rect' takes a round frame back; undefined leaves it.
 */
export function cropOps(o: CropSource, F: Box, P: Box, shape?: CropShape): HtmlOp[] {
  const radius = shape === 'circle' ? CIRCLE : undefined;
  if (!o.wrapped) {
    const decls = parseStyle(get(o.attrs, 'style'));
    const pos = o.position === 'static' ? 'relative' : o.position;
    const frame: Decl[] = [['position', pos]];
    if (placed(o.position)) frame.push(['left', px(F.x)], ['top', px(F.y)]);
    frame.push(['width', px(F.w)], ['height', px(F.h)], ['overflow', 'hidden']);
    if (o.position === 'static' || o.position === 'relative') { const disp = decls.find(d => d[0] === 'display'); if (!disp) frame.push(['display', 'inline-block']); }
    for (const d of decls) if (!GEOMETRY.has(d[0]) && !IMG_ONLY.has(d[0]) && !(radius && d[0] === 'border-radius')) frame.push(d);
    if (radius) frame.push(['border-radius', radius]);
    const id = get(o.attrs, 'id'), cls = get(o.attrs, 'class');
    const frameAttrs: [string, string][] = [];
    if (id !== null) frameAttrs.push(['id', id]);
    frameAttrs.push(['class', ['ol-crop', ...(cls ?? '').split(/\s+/).filter(c => c && c !== 'ol-crop')].join(' ')]);
    frameAttrs.push(['style', styleText(frame)]);
    const imgAttrs = o.attrs.filter(([k]) => !['style', 'id', 'class'].includes(k.toLowerCase()));
    imgAttrs.push(['style', imgStyle(F, P, o.ratio, decls)]);
    return [{ t: 'outer', path: o.path, html: `<div${attrText(frameAttrs)}><img${attrText(imgAttrs)}></div>` }];
  }
  if (!o.imgPath) return [];
  const set: Record<string, string | null> = { width: px(F.w), height: px(F.h) };
  if (placed(o.position)) { set.left = px(F.x); set.top = px(F.y); set.right = null; set.bottom = null; }
  if (radius) set['border-radius'] = radius;
  else if (shape === 'rect' && parseStyle(get(o.attrs, 'style')).some(([k, v]) => k === 'border-radius' && v === CIRCLE)) set['border-radius'] = null;
  const imgSet: Record<string, string | null> = { position: 'absolute', left: px(P.x - F.x), top: px(P.y - F.y), width: px(P.w), height: naturalHeight(P, o.ratio) ? 'auto' : px(P.h), 'max-width': 'none' };
  return [{ t: 'style', path: o.path, set }, { t: 'style', path: o.imgPath, set: imgSet }];
}

/**
 * Reset crop: the frame replaced by the whole picture as a plain <img>, at the frame's top-left,
 * at the picture's current width, its height following (PowerPoint's Reset). Nothing for a picture
 * that is not cropped.
 */
export function uncropOps(o: CropSource, F: Box, P: Box): HtmlOp[] {
  if (!o.wrapped) return [];
  const frame = parseStyle(get(o.attrs, 'style'));
  const inner = parseStyle(get(o.imgAttrs, 'style'));
  const decls: Decl[] = [];
  const wasStatic = o.position === 'relative' && !frame.some(([k]) => k === 'left' || k === 'top');
  if (!wasStatic) decls.push(['position', o.position]);
  if (placed(o.position) && !wasStatic) decls.push(['left', px(F.x)], ['top', px(F.y)]);
  decls.push(['width', px(P.w)]);
  if (!naturalHeight(P, o.ratio)) decls.push(['height', px(P.h)]);
  for (const d of frame) {
    if (GEOMETRY.has(d[0]) || (d[0] === 'border-radius' && d[1] === CIRCLE)) continue;
    if (d[0] === 'display' && d[1] === 'inline-block' && (o.position === 'relative' || o.position === 'static')) continue;
    decls.push(d);
  }
  for (const d of inner) if (IMG_ONLY.has(d[0])) decls.push(d);
  const id = get(o.attrs, 'id');
  const classes = (get(o.attrs, 'class') ?? '').split(/\s+/).filter(c => c && c !== 'ol-crop');
  const attrs: [string, string][] = (o.imgAttrs ?? []).filter(([k]) => !['style', 'id', 'class'].includes(k.toLowerCase()));
  if (id !== null) attrs.unshift(['id', id]);
  if (classes.length) attrs.push(['class', classes.join(' ')]);
  attrs.push(['style', styleText(decls)]);
  return [{ t: 'outer', path: o.path, html: `<img${attrText(attrs)}>` }];
}

/* ------------------------------------------------------------------ the live page */

/** what edit.ts gives the crop */
export interface CropContext {
  /** where the crop may put a layer of its own (the runtime's shadow root) */
  root: ShadowRoot | HTMLElement;
  /** the editor's zoom of the frame: handles keep their size on screen */
  scale(): number;
  /** the source element a live one was made from */
  srcOf(el: Element): Element | undefined;
  pathOf(el: Element): Path | null;
  commit(ops: HtmlOp[]): void;
  /** the crop ended (redraw the selection) */
  onEnd?(committed: boolean): void;
}

export interface CropTarget { obj: HTMLElement; img: HTMLImageElement; wrapped: boolean }

/** what a click on `el` crops: a picture, or the crop frame of one (or the picture in it) */
export function cropTarget(el: Element | null): CropTarget | null {
  if (!el) return null;
  if (el.localName === 'img') {
    const p = el.parentElement;
    if (p && p.classList.contains('ol-crop') && p.querySelector(':scope > img') === el) return { obj: p, img: el as HTMLImageElement, wrapped: true };
    return { obj: el as HTMLElement, img: el as HTMLImageElement, wrapped: false };
  }
  if (el.classList.contains('ol-crop')) {
    const img = el.querySelector(':scope > img') as HTMLImageElement | null;
    if (img) return { obj: el as HTMLElement, img, wrapped: true };
  }
  return null;
}

const num = (v: string, d = 0) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };

/** the frame and the picture of a target, in its parent's CSS px */
export function measure(t: CropTarget): { F: Box; P: Box; position: string; ratio: number } {
  const cs = getComputedStyle(t.obj);
  const position = cs.position;
  const x = placed(position) ? num(cs.left, position === 'relative' ? 0 : t.obj.offsetLeft) : 0;
  const y = placed(position) ? num(cs.top, position === 'relative' ? 0 : t.obj.offsetTop) : 0;
  const F = { x, y, w: num(cs.width, t.obj.offsetWidth), h: num(cs.height, t.obj.offsetHeight) };
  let P: Box = { ...F };
  if (t.wrapped) {
    const ic = getComputedStyle(t.img);
    P = { x: x + num(ic.left, t.img.offsetLeft), y: y + num(ic.top, t.img.offsetTop), w: num(ic.width, t.img.offsetWidth), h: num(ic.height, t.img.offsetHeight) };
  }
  const ratio = t.img.naturalWidth && t.img.naturalHeight ? t.img.naturalHeight / t.img.naturalWidth : P.h / Math.max(1, P.w);
  return { F, P, position, ratio };
}

/** the source a target's operations need */
export function sourceOf(t: CropTarget, ctx: Pick<CropContext, 'srcOf' | 'pathOf'>, position: string, ratio: number): CropSource | null {
  const path = ctx.pathOf(t.obj);
  const src = ctx.srcOf(t.obj);
  if (!path || !src) return null;
  const attrsOf = (e: Element) => Array.from(e.attributes).map(a => [a.name, a.value] as [string, string]);
  const o: CropSource = { path, wrapped: t.wrapped, attrs: attrsOf(src), position, ratio };
  if (t.wrapped) {
    const ip = ctx.pathOf(t.img), is = ctx.srcOf(t.img);
    if (!ip || !is) return null;
    o.imgPath = ip; o.imgAttrs = attrsOf(is);
  }
  return o;
}

/** a crop without the interactive part (the toolbar's aspect presets, Reset crop) */
export function cropNow(el: Element, ctx: Pick<CropContext, 'srcOf' | 'pathOf' | 'commit'>, how: { aspect?: number | null; shape?: CropShape; reset?: boolean }): boolean {
  const t = cropTarget(el);
  if (!t) return false;
  const { F, P, position, ratio } = measure(t);
  const o = sourceOf(t, ctx, position, ratio);
  if (!o) return false;
  const ops = how.reset ? uncropOps(o, F, P) : cropOps(o, presetFrame(F, P, how.aspect ?? null), P, how.shape);
  if (!ops.length) return false;
  ctx.commit(ops);
  return true;
}

/* ------------------------------------------------------------------ the crop mode */

interface Active {
  t: CropTarget;
  ctx: CropContext;
  src: CropSource;
  F0: Box; F: Box; P0: Box; P: Box;
  shape?: CropShape;
  /** local px → page px, and the object's transform (2×2) with its inverse */
  k: number; m: [number, number, number, number]; inv: [number, number, number, number];
  /** the container's page position (the frame's untransformed top-left at the start) */
  origin: { x: number; y: number }; to: { x: number; y: number };
  layer: HTMLElement;
  visibility: string;
  off: () => void;
}

let active: Active | null = null;

export function isCropping(): boolean { return !!active; }

const CSS = `
  .crop { position: absolute; left: 0; top: 0; pointer-events: none; font: 12px system-ui, sans-serif; }
  .crop * { box-sizing: border-box; }
  .ghost { position: absolute; opacity: .35; pointer-events: none; user-select: none; max-width: none; }
  .clip { position: absolute; overflow: hidden; pointer-events: auto; cursor: move; touch-action: none; }
  .clip img { position: absolute; max-width: none; pointer-events: none; user-select: none; }
  .outline { position: absolute; pointer-events: none; outline: calc(1px * var(--u)) solid rgba(0,0,0,.65); box-shadow: 0 0 0 calc(2px * var(--u)) rgba(255,255,255,.7); }
  .pic { position: absolute; pointer-events: none; outline: calc(1px * var(--u)) dashed rgba(0,0,0,.45); }
  .ch { position: absolute; pointer-events: auto; touch-action: none; }
  .ch::before, .ch::after { content: ''; position: absolute; background: #111; box-shadow: 0 0 0 calc(1px * var(--u)) #fff; }
  .ch.nw, .ch.ne, .ch.se, .ch.sw { width: calc(16px * var(--u)); height: calc(16px * var(--u)); }
  .ch.nw { margin: calc(-3px * var(--u)) 0 0 calc(-3px * var(--u)); cursor: nwse-resize; }
  .ch.se { margin: calc(-13px * var(--u)) 0 0 calc(-13px * var(--u)); cursor: nwse-resize; }
  .ch.ne { margin: calc(-3px * var(--u)) 0 0 calc(-13px * var(--u)); cursor: nesw-resize; }
  .ch.sw { margin: calc(-13px * var(--u)) 0 0 calc(-3px * var(--u)); cursor: nesw-resize; }
  .ch.nw::before, .ch.sw::before { left: 0; top: 0; width: calc(4px * var(--u)); height: 100%; }
  .ch.ne::before, .ch.se::before { right: 0; top: 0; width: calc(4px * var(--u)); height: 100%; }
  .ch.nw::after, .ch.ne::after { left: 0; top: 0; width: 100%; height: calc(4px * var(--u)); }
  .ch.sw::after, .ch.se::after { left: 0; bottom: 0; width: 100%; height: calc(4px * var(--u)); }
  .ch.n, .ch.s { width: calc(18px * var(--u)); height: calc(10px * var(--u)); margin-left: calc(-9px * var(--u)); cursor: ns-resize; }
  .ch.n { margin-top: calc(-3px * var(--u)); } .ch.s { margin-top: calc(-7px * var(--u)); }
  .ch.e, .ch.w { width: calc(10px * var(--u)); height: calc(18px * var(--u)); margin-top: calc(-9px * var(--u)); cursor: ew-resize; }
  .ch.w { margin-left: calc(-3px * var(--u)); } .ch.e { margin-left: calc(-7px * var(--u)); }
  .ch.n::before, .ch.s::before { left: 0; width: 100%; height: calc(4px * var(--u)); }
  .ch.n::before { top: 0; } .ch.s::before { bottom: 0; }
  .ch.e::before, .ch.w::before { top: 0; height: 100%; width: calc(4px * var(--u)); }
  .ch.w::before { left: 0; } .ch.e::before { right: 0; }
  .ch::after { display: none; } .ch.nw::after, .ch.ne::after, .ch.se::after, .ch.sw::after { display: block; }
  .ph { position: absolute; width: calc(11px * var(--u)); height: calc(11px * var(--u)); margin: calc(-5.5px * var(--u)) 0 0 calc(-5.5px * var(--u)); border-radius: 50%; background: #fff; border: calc(1.5px * var(--u)) solid #6b6b6b; pointer-events: auto; touch-action: none; }
  .ph.nw, .ph.se { cursor: nwse-resize; } .ph.ne, .ph.sw { cursor: nesw-resize; }
  .tip { position: absolute; transform: translate(-50%, calc(-100% - 8px * var(--u))); background: rgba(30,30,30,.85); color: #fff; padding: calc(2px * var(--u)) calc(7px * var(--u)); border-radius: calc(4px * var(--u)); font-size: calc(11px * var(--u)); white-space: nowrap; pointer-events: none; }
`;

function matrixOf(el: Element): { m: [number, number, number, number]; origin: [number, number] } {
  const cs = getComputedStyle(el);
  const t = cs.transform;
  let m: [number, number, number, number] = [1, 0, 0, 1];
  const mm = /^matrix\(([^)]+)\)$/.exec(t);
  if (mm) { const v = mm[1].split(',').map(Number); if (v.length === 6 && v.every(Number.isFinite)) m = [v[0], v[1], v[2], v[3]]; }
  const o = cs.transformOrigin.split(' ').map(s => parseFloat(s));
  return { m, origin: [Number.isFinite(o[0]) ? o[0] : 0, Number.isFinite(o[1]) ? o[1] : 0] };
}

/** start cropping `el` (a picture or a crop frame); false when it is not one */
export function startCrop(el: Element, ctx: CropContext, how: { aspect?: number | null; shape?: CropShape } = {}): boolean {
  if (active) endCrop(true);
  const t = cropTarget(el);
  if (!t) return false;
  const { F, P, position, ratio } = measure(t);
  const src = sourceOf(t, ctx, position, ratio);
  if (!src || F.w <= 0 || F.h <= 0) return false;

  // where the object's untransformed box is on the page
  const op = t.obj.offsetParent as HTMLElement | null;
  const opr = op?.getBoundingClientRect();
  const k = op && op.offsetWidth && opr ? opr.width / op.offsetWidth || 1 : 1;
  const { m, origin } = matrixOf(t.obj);
  const det = m[0] * m[3] - m[1] * m[2] || 1;
  const inv: [number, number, number, number] = [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det];
  const r = t.obj.getBoundingClientRect();
  const ow = t.obj.offsetWidth * k, oh = t.obj.offsetHeight * k;
  const o = [origin[0] * k, origin[1] * k];
  // centre of the transformed box = the origin point + M·(centre − origin)
  const cx = ow / 2 - o[0], cy = oh / 2 - o[1];
  const Ox = r.left + scrollX + r.width / 2 - (m[0] * cx + m[2] * cy);
  const Oy = r.top + scrollY + r.height / 2 - (m[1] * cx + m[3] * cy);
  // the border box vs the content box measured: the frame's content starts at its border
  const bl = num(getComputedStyle(t.obj).borderLeftWidth) * k, bt = num(getComputedStyle(t.obj).borderTopWidth) * k;

  const host = document.createElement('div');
  host.className = 'crop';
  host.setAttribute('data-ol-crop', '');
  const style = document.createElement('style');
  style.textContent = CSS;
  const wrap = document.createElement('div');
  wrap.append(style, host);
  ctx.root.appendChild(wrap);

  const a: Active = {
    t, ctx, src, F0: F, F, P0: P, P, shape: how.shape, k, m, inv,
    origin: { x: Ox - o[0] + bl, y: Oy - o[1] + bt }, to: { x: o[0] - bl, y: o[1] - bt },
    layer: wrap, visibility: t.obj.style.getPropertyValue('visibility'), off: () => undefined,
  };
  active = a;
  if (how.aspect !== undefined && how.aspect !== null) a.F = presetFrame(a.F, a.P, how.aspect);
  t.obj.style.setProperty('visibility', 'hidden');

  // the crop's own parts are in a (closed) shadow root: their events reach the window from its host
  const shadowHost: Node = typeof ShadowRoot !== 'undefined' && ctx.root instanceof ShadowRoot ? ctx.root.host : ctx.root;
  const down = (e: PointerEvent) => {
    if (!active) return;
    const t = e.target as Node | null;
    if (t && (t === shadowHost || shadowHost.contains(t))) return;   // handled by the crop's own parts
    endCrop(true);
  };
  const key = (e: KeyboardEvent) => {
    if (!active) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endCrop(false); }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); endCrop(true); }
    else if (e.key.startsWith('Arrow')) {
      e.preventDefault(); e.stopPropagation();
      const s = e.shiftKey ? 10 : 1;
      active.P = panPicture(active.F, active.P, e.key === 'ArrowLeft' ? -s : e.key === 'ArrowRight' ? s : 0, e.key === 'ArrowUp' ? -s : e.key === 'ArrowDown' ? s : 0);
      render();
    } else if (!(e.ctrlKey || e.metaKey)) { e.stopPropagation(); }
  };
  addEventListener('pointerdown', down, true);
  addEventListener('keydown', key, true);
  a.off = () => { removeEventListener('pointerdown', down, true); removeEventListener('keydown', key, true); };
  render();
  return true;
}

/** draw the crop again (the editor's zoom changed) */
export function redrawCrop(): void { render(); }

/** while cropping: the frame to an aspect preset (and shape) */
export function setCropAspect(ratio: number | null, shape?: CropShape): void {
  if (!active) return;
  active.F = presetFrame(active.F, active.P, ratio);
  if (shape) active.shape = shape;
  render();
}

/** end the crop: kept (the operations sent) or not */
export function endCrop(commit: boolean): void {
  const a = active;
  if (!a) return;
  active = null;
  a.off();
  const changed = commit && (a.F.x !== a.F0.x || a.F.y !== a.F0.y || a.F.w !== a.F0.w || a.F.h !== a.F0.h || a.P.x !== a.P0.x || a.P.y !== a.P0.y || a.P.w !== a.P0.w || a.P.h !== a.P0.h || !!a.shape);
  const restore = () => {
    if (a.visibility) a.t.obj.style.setProperty('visibility', a.visibility); else a.t.obj.style.removeProperty('visibility');
    if (!a.t.obj.getAttribute('style')) a.t.obj.removeAttribute('style');
    a.layer.remove();
  };
  if (!changed) { restore(); a.ctx.onEnd?.(false); return; }
  // a transformed (rotated) frame turns about its own middle: placed so that it stays where it was shown
  let { F, P } = a;
  if (placed(a.src.position) && (a.m[0] !== 1 || a.m[1] !== 0 || a.m[2] !== 0 || a.m[3] !== 1)) {
    const c0x = a.F0.x + a.F0.w / 2, c0y = a.F0.y + a.F0.h / 2;
    const vx = F.x + F.w / 2 - c0x, vy = F.y + F.h / 2 - c0y;
    const sx = a.m[0] * vx + a.m[2] * vy - vx, sy = a.m[1] * vx + a.m[3] * vy - vy;
    F = { ...F, x: F.x + sx, y: F.y + sy };
    P = { ...P, x: P.x + sx, y: P.y + sy };
  }
  // the preview stays until the page shows the new text (the object changes or is replaced), at most 2.5 s
  for (const el of Array.from(a.layer.querySelectorAll('.ch, .ph, .clip'))) (el as HTMLElement).style.pointerEvents = 'none';
  for (const el of Array.from(a.layer.querySelectorAll('.ghost, .ch, .ph, .outline, .pic, .tip'))) el.remove();
  let done = false;
  const finish = () => { if (done) return; done = true; mo.disconnect(); clearTimeout(timer); clearInterval(poll); restore(); };
  // (an ancestor replaced as a whole is no mutation of the object or its parent)
  const poll = setInterval(() => { if (!a.t.obj.isConnected) finish(); }, 100);
  const mo = new MutationObserver(() => { if (!a.t.obj.isConnected || a.t.obj.style.getPropertyValue('visibility') !== 'hidden') finish(); });
  mo.observe(a.t.obj, { attributes: true });
  if (a.t.obj.parentNode) mo.observe(a.t.obj.parentNode, { childList: true });
  const timer = setTimeout(finish, 2500);
  a.ctx.commit(cropOps(a.src, F, P, a.shape));
  a.ctx.onEnd?.(true);
}

/* ------------------------------------------------------------------ drawing and dragging */

function render(): void {
  const a = active;
  if (!a) return;
  const host = a.layer.querySelector('.crop') as HTMLElement;
  const u = 1 / Math.max(0.05, a.ctx.scale());
  const k = a.k;
  const L = (b: Box) => ({ x: (b.x - a.F0.x) * k, y: (b.y - a.F0.y) * k, w: b.w * k, h: b.h * k });
  const F = L(a.F), P = L(a.P);
  const src = a.t.img.currentSrc || a.t.img.src;
  const radius = a.shape === 'circle' ? '50%' : getComputedStyle(a.t.obj).borderRadius;
  host.style.cssText = `left:${a.origin.x}px;top:${a.origin.y}px;width:0;height:0;--u:${u};transform:matrix(${a.m.join(',')},0,0);transform-origin:${a.to.x}px ${a.to.y}px;`;
  if (!host.firstChild) {
    host.innerHTML = `<img class="ghost" alt="" draggable="false"><div class="pic"></div><div class="clip"><img alt="" draggable="false"></div><div class="outline"></div>`
      + (['nw', 'ne', 'se', 'sw'] as Corner[]).map(c => `<div class="ph ${c}" data-p="${c}"></div>`).join('')
      + (['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as FrameHandle[]).map(h => `<div class="ch ${h}" data-c="${h}"></div>`).join('');
    (host.querySelector('.ghost') as HTMLImageElement).src = src;
    (host.querySelector('.clip img') as HTMLImageElement).src = src;
    host.querySelector('.clip')!.addEventListener('pointerdown', e => dragStart(e as PointerEvent, 'pan'));
    for (const h of Array.from(host.querySelectorAll('.ph'))) h.addEventListener('pointerdown', e => dragStart(e as PointerEvent, 'pic:' + (h as HTMLElement).dataset.p));
    for (const h of Array.from(host.querySelectorAll('.ch'))) h.addEventListener('pointerdown', e => dragStart(e as PointerEvent, 'frame:' + (h as HTMLElement).dataset.c));
  }
  const box = (el: Element | null, b: { x: number; y: number; w: number; h: number }) => { if (el) (el as HTMLElement).style.cssText += `;left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px`; };
  box(host.querySelector('.ghost'), P);
  box(host.querySelector('.pic'), P);
  const clip = host.querySelector('.clip') as HTMLElement;
  box(clip, F);
  clip.style.borderRadius = radius;
  box(host.querySelector('.clip img'), { x: P.x - F.x, y: P.y - F.y, w: P.w, h: P.h });
  const outline = host.querySelector('.outline') as HTMLElement;
  box(outline, F);
  outline.style.borderRadius = radius;
  const at = (el: Element, x: number, y: number) => { (el as HTMLElement).style.left = `${x}px`; (el as HTMLElement).style.top = `${y}px`; };
  for (const h of Array.from(host.querySelectorAll('.ph'))) {
    const c = (h as HTMLElement).dataset.p!;
    at(h, P.x + (c.includes('e') ? P.w : 0), P.y + (c.includes('s') ? P.h : 0));
  }
  for (const h of Array.from(host.querySelectorAll('.ch'))) {
    const c = (h as HTMLElement).dataset.c!;
    at(h, F.x + (c.includes('e') ? F.w : c.includes('w') ? 0 : F.w / 2), F.y + (c.includes('s') ? F.h : c.includes('n') ? 0 : F.h / 2));
  }
}

function dragStart(e: PointerEvent, what: string): void {
  const a = active;
  if (!a || e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const el = e.currentTarget as HTMLElement;
  try { el.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
  const x0 = e.pageX, y0 = e.pageY, F0 = a.F, P0 = a.P;
  const host = a.layer.querySelector('.crop') as HTMLElement;
  let tip: HTMLElement | null = null;
  const move = (ev: PointerEvent) => {
    if (!active) return;
    // the pointer's movement in the object's own px (through the inverse of its transform)
    const dx = ev.pageX - x0, dy = ev.pageY - y0;
    const lx = (a.inv[0] * dx + a.inv[2] * dy) / a.k, ly = (a.inv[1] * dx + a.inv[3] * dy) / a.k;
    if (what === 'pan') {
      let mx = lx, my = ly;
      if (ev.shiftKey) { if (Math.abs(lx) > Math.abs(ly)) my = 0; else mx = 0; }
      a.P = panPicture(F0, P0, mx, my);
    } else if (what.startsWith('pic:')) a.P = scalePicture(F0, P0, what.slice(4) as Corner, lx, ly);
    else if (what.startsWith('frame:')) a.F = resizeFrame(F0, P0, what.slice(6) as FrameHandle, lx, ly, ev.shiftKey);
    render();
    if (!tip) { tip = document.createElement('div'); tip.className = 'tip'; host.appendChild(tip); }
    const F = a.F;
    tip.textContent = what.startsWith('pic:') ? `${Math.round(a.P.w / (a.t.img.naturalWidth || a.P.w) * 100)} %` : `${Math.round(F.w)} × ${Math.round(F.h)}`;
    tip.style.left = `${(F.x - a.F0.x + F.w / 2) * a.k}px`;
    tip.style.top = `${(F.y - a.F0.y) * a.k}px`;
  };
  const up = () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
    tip?.remove();
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}
