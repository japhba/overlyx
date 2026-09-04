/**
 * Margin ink: freehand pen/highlighter drawing in the space left and right of the text column,
 * Goodnotes-style. Strokes and pasted images are anchored to the paragraph beside them through a
 * `sketch` node (an invisible `\olsketch{...}` command in the .tex) and stored as offsets from
 * the column edge and the paragraph's top — they move with the text through the CRDT, survive
 * reflow, and are saved as sidecar SVGs in figures/ by the server.
 *
 * Rendering: one canvas overlays the scroll viewport, clipped to the margins with a keyhole
 * clip-path (the text column is a hole — clicks there reach the text even in draw mode). The
 * canvas is translated on scroll and repainted from cached Path2D outlines (core/ink.ts — the
 * same geometry the saved SVG uses). In-progress strokes stream to other clients through the
 * Yjs awareness channel and are drawn live; every finished change is a normal ProseMirror
 * transaction, so undo (Ctrl+Z) and collaboration come from the existing machinery.
 *
 * Tools: pen and highlighter (each with its own colour and width, like Goodnotes' pens), eraser
 * (whole strokes), and a lasso — it closes itself and selects every stroke/image it touches, not
 * only what it encircles completely — giving a selection box with corner handles (drag inside to
 * move, handles to resize, Delete removes; moved items re-anchor to the paragraph they end up
 * beside). Clicking the canvas takes the
 * caret out of the text ("the canvas is focused"): a pasted image then lands on the margin
 * canvas instead of becoming a LaTeX figure in the document.
 */
import { Plugin, PluginKey } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import type { Awareness } from 'y-protocols/awareness';
import { schema, strokePathD, polylineHitsPolygon, rectHitsPolygon, type InkStroke, type InkImage } from '@overlyx/core';
import { graphicsUrl } from '../../api';
import { viewProject, viewDocDir, resolveDocPath } from '../context';
import { imageFiles, imageExt, uploadBaseName, uploadUnique, isSvgMarkup, svgFile } from '../imagepaste';

export type InkTool = 'pen' | 'highlighter' | 'eraser' | 'lasso';
/** the tools that draw — each remembers its own colour and width (Goodnotes: switching pens switches both) */
export type InkPen = 'pen' | 'highlighter';
export interface PenSettings { color: string; width: number }
export interface InkUiState {
  active: boolean;
  tool: InkTool;
  /** the pen the colour / width buttons belong to: the drawing tool in use, or the last one used */
  pen: InkPen;
  pens: Record<InkPen, PenSettings>;
}

/** Colour presets per pen (the highlighter's are drawn at HIGHLIGHT_OPACITY). */
export const INK_PALETTES: Record<InkPen, [string, string][]> = {
  pen: [['#202124', 'Black'], ['#1a73e8', 'Blue'], ['#d93025', 'Red'], ['#188038', 'Green'], ['#f29900', 'Orange'], ['#a142f4', 'Purple']],
  highlighter: [['#fbbc04', 'Yellow'], ['#f29900', 'Orange'], ['#e8467c', 'Pink'], ['#34a853', 'Green'], ['#4285f4', 'Blue'], ['#a142f4', 'Purple']],
};
/** Nominal widths (the highlighter draws HIGHLIGHT_WIDTH_FACTOR× wider). */
export const INK_WIDTHS = [1.5, 2.5, 4];
export const HIGHLIGHT_WIDTH_FACTOR = 4;

const stored = <T,>(k: string, def: T): T => { try { const v = localStorage.getItem(k); return v === null ? def : JSON.parse(v) as T; } catch { return def; } };
const DEFAULT_PENS: Record<InkPen, PenSettings> = { pen: { color: '#1a73e8', width: 2.5 }, highlighter: { color: '#fbbc04', width: 2.5 } };
function loadPens(): Record<InkPen, PenSettings> {
  const saved = stored<Partial<Record<InkPen, Partial<PenSettings>>>>('ol.inkPens', {});
  // before pens had their own settings there was one shared colour / width: it becomes the pen's
  const legacy: Partial<PenSettings> = { color: stored<string | undefined>('ol.inkColor', undefined), width: stored<number | undefined>('ol.inkWidth', undefined) };
  const pick = (p: InkPen): PenSettings => ({
    color: saved[p]?.color ?? (p === 'pen' ? legacy.color : undefined) ?? DEFAULT_PENS[p].color,
    width: saved[p]?.width ?? (p === 'pen' ? legacy.width : undefined) ?? DEFAULT_PENS[p].width,
  });
  return { pen: pick('pen'), highlighter: pick('highlighter') };
}
const storedTool = stored('ol.inkTool', 'pen' as InkTool);
let ui: InkUiState = {
  active: false,
  tool: storedTool,
  pen: storedTool === 'highlighter' ? 'highlighter' : 'pen',
  pens: loadPens(),
};
const subs = new Set<() => void>();
export function getInk(): InkUiState { return ui; }
/** The settings of the pen the toolbar shows (see InkUiState.pen). */
export function currentPen(state: InkUiState = ui): PenSettings { return state.pens[state.pen]; }
/**
 * Change the tool, or the current pen's colour / width. Colour and width always go to the pen in
 * use (or the last one used when the eraser / lasso is active) — picking a colour while erasing
 * or lassoing takes that pen up again, as a Goodnotes user expects.
 */
export function setInk(patch: { active?: boolean; tool?: InkTool; color?: string; width?: number }): void {
  const next = { ...ui, pens: { ...ui.pens } };
  if (patch.active !== undefined) next.active = patch.active;
  if (patch.tool !== undefined) { next.tool = patch.tool; if (patch.tool === 'pen' || patch.tool === 'highlighter') next.pen = patch.tool; }
  if (patch.color !== undefined || patch.width !== undefined) {
    if (patch.tool === undefined && (next.tool === 'eraser' || next.tool === 'lasso')) next.tool = next.pen;
    next.pens[next.pen] = { ...next.pens[next.pen], ...(patch.color !== undefined ? { color: patch.color } : {}), ...(patch.width !== undefined ? { width: patch.width } : {}) };
  }
  ui = next;
  try {
    localStorage.setItem('ol.inkTool', JSON.stringify(ui.tool));
    localStorage.setItem('ol.inkPens', JSON.stringify(ui.pens));
  } catch { /* private mode */ }
  for (const s of subs) s();
}
export function subscribeInk(fn: () => void): () => void { subs.add(fn); return () => subs.delete(fn); }

/** Should the drawing toolbar switch itself on? Tablets: a coarse pointer with touch. */
export function isTabletClient(): boolean {
  try { return matchMedia('(any-pointer: coarse)').matches && navigator.maxTouchPoints > 0; } catch { return false; }
}

export const HIGHLIGHT_OPACITY = 0.35;

interface InkData { v: 1; strokes: InkStroke[]; imgs: InkImage[] }
interface SketchEntry { pos: number; blockPos: number; src: string; data: InkData }
/** what streams over awareness while a stroke is drawn */
interface LiveInk { src: string; side: 'left' | 'right'; color: string; w: number; o?: number; pts: [number, number, number][] }
/** one selected thing, addressed inside its sketch node */
interface SelItem { src: string; kind: 'stroke' | 'img'; idx: number }
/** live transform while the selection is dragged: scale about (ox, oy), then translate */
interface Xform { dx: number; dy: number; sx: number; sy: number; ox: number; oy: number }
interface Rect { x: number; y: number; w: number; h: number }

const parseCache = new Map<string, InkData>();
const pathCache = new WeakMap<InkStroke, Path2D>();
function parseData(json: string | null): InkData {
  if (!json) return { v: 1, strokes: [], imgs: [] };
  let d = parseCache.get(json);
  if (!d) {
    let raw: { strokes?: InkStroke[]; imgs?: InkImage[] };
    try { raw = JSON.parse(json) as never; } catch { raw = {}; }
    d = { v: 1, strokes: Array.isArray(raw.strokes) ? raw.strokes : [], imgs: Array.isArray(raw.imgs) ? raw.imgs : [] };
    if (parseCache.size > 200) parseCache.clear();
    parseCache.set(json, d);
  }
  return d;
}
function serializeData(d: InkData): string {
  return JSON.stringify({ v: 1, strokes: d.strokes, ...(d.imgs.length ? { imgs: d.imgs } : {}) });
}
function pathFor(stroke: InkStroke): Path2D {
  let p = pathCache.get(stroke);
  if (!p) { p = new Path2D(strokePathD(stroke)); pathCache.set(stroke, p); }
  return p;
}

const zoom = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--editor-zoom')) || 1;
const round4 = (n: number) => Math.round(n * 4) / 4;
const newSrc = () => `figures/ink-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.svg`;

export const inkKey = new PluginKey('lyx-ink');

export function inkPlugin(awareness: Awareness): Plugin {
  return new Plugin({
    key: inkKey,
    view: (view) => new InkLayer(view, awareness),
  });
}

class InkLayer {
  private canvas = document.createElement('canvas');
  private selBox = document.createElement('div');
  private scroller: HTMLElement | null;
  private entries: SketchEntry[] = [];
  private raf = 0;
  private ro: ResizeObserver | null = null;
  private unsub: (() => void)[] = [];
  /** the stroke being drawn here right now (content coordinates of the scroller) */
  private live: { src: string; side: 'left' | 'right'; edgeX: number; anchorTop: number; color: string; w: number; o?: number; pts: [number, number, number][] } | null = null;
  private lasso: [number, number][] | null = null;
  private selection: SelItem[] | null = null;
  private xform: Xform | null = null;
  private dragSel: { mode: 'move' | 'resize'; corner: string; startX: number; startY: number; base: Rect; pointerId: number } | null = null;
  private pointerId: number | null = null;
  private lastAwarenessSend = 0;
  /** the canvas was clicked (the text caret is deactivated): pasted images go to the margins */
  private canvasFocused = false;
  private lastPoint: { x: number; y: number } | null = null;
  private imgCache = new Map<string, HTMLImageElement>();

  constructor(private view: EditorView, private awareness: Awareness) {
    this.scroller = view.dom.closest('.editor-scroll');
    if (!this.scroller) return;
    this.canvas.className = 'ink-canvas';
    this.scroller.appendChild(this.canvas);
    this.selBox.className = 'ink-sel';
    this.selBox.hidden = true;
    for (const c of ['nw', 'ne', 'sw', 'se']) {
      const h = document.createElement('span');
      h.className = 'ink-handle ' + c;
      h.dataset.corner = c;
      this.selBox.appendChild(h);
    }
    this.scroller.appendChild(this.selBox);
    this.collect();

    const onScroll = () => this.schedule();
    const onResize = () => this.schedule();
    this.scroller.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);
    this.unsub.push(() => this.scroller?.removeEventListener('scroll', onScroll), () => window.removeEventListener('resize', onResize));
    this.ro = new ResizeObserver(() => this.schedule());
    this.ro.observe(view.dom);
    const onAwareness = () => this.schedule();
    awareness.on('change', onAwareness);
    this.unsub.push(() => awareness.off('change', onAwareness));
    this.unsub.push(subscribeInk(() => {
      if (!ui.active) { this.selection = null; this.canvasFocused = false; }
      this.applyMode();
      this.schedule();
    }));

    this.canvas.addEventListener('pointerdown', this.onDown);
    this.canvas.addEventListener('pointermove', this.onMove);
    this.canvas.addEventListener('pointerup', this.onUp);
    this.canvas.addEventListener('pointercancel', this.onCancel);
    this.selBox.addEventListener('pointerdown', this.onSelDown);
    this.selBox.addEventListener('pointermove', this.onSelMove);
    this.selBox.addEventListener('pointerup', this.onSelUp);
    this.selBox.addEventListener('pointercancel', this.onSelUp);
    // typing again re-activates the text: the canvas loses its focus and its selection
    const onEditorFocus = () => { if (this.canvasFocused || this.selection) { this.canvasFocused = false; this.selection = null; this.schedule(); } };
    view.dom.addEventListener('focusin', onEditorFocus);
    this.unsub.push(() => view.dom.removeEventListener('focusin', onEditorFocus));
    document.addEventListener('keydown', this.onKeyDown, true);
    document.addEventListener('paste', this.onPaste, true);
    this.unsub.push(() => document.removeEventListener('keydown', this.onKeyDown, true), () => document.removeEventListener('paste', this.onPaste, true));
    this.applyMode();
    this.schedule();
  }

  update(view: EditorView, prevState: import('prosemirror-state').EditorState) {
    this.view = view;
    if (view.state.doc !== prevState.doc) this.collect();
    this.applyMode();   // editability arrives after the metadata loads — keep the draw state in step
    this.schedule();
  }

  destroy() {
    for (const u of this.unsub) u();
    this.ro?.disconnect();
    cancelAnimationFrame(this.raf);
    this.canvas.remove();
    this.selBox.remove();
    if (this.live) try { this.awareness.setLocalStateField('ink', null); } catch { /* closing */ }
  }

  private applyMode() {
    const on = ui.active && this.editable();
    this.canvas.classList.toggle('draw', on);
    this.canvas.dataset.tool = ui.tool;
  }

  private editable(): boolean {
    return this.view.editable && !this.view.dom.classList.contains('view-only');
  }

  /** All sketch nodes with their anchor block positions; drops selection items that vanished. */
  private collect() {
    const entries: SketchEntry[] = [];
    const doc = this.view.state.doc;
    doc.descendants((node, pos) => {
      if (node.type.name !== 'sketch') return true;
      const $p = doc.resolve(pos);
      const blockPos = $p.depth >= 1 ? $p.before(1) : doc.childAfter(pos).offset;
      entries.push({ pos, blockPos, src: node.attrs.src, data: parseData(node.attrs.data) });
      return false;
    });
    this.entries = entries;
    if (this.selection) {
      this.selection = this.selection.filter(it => {
        const e = entries.find(x => x.src === it.src);
        return e && it.idx < (it.kind === 'stroke' ? e.data.strokes.length : e.data.imgs.length);
      });
      if (!this.selection.length) this.selection = null;
    }
  }

  private schedule() {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.paint());
  }

  /* ------------------------------------------------------------- geometry */

  /** Column edges and scroll offsets, all in the scroller's content coordinate space. */
  private geom() {
    const sc = this.scroller!;
    const sRect = sc.getBoundingClientRect();
    const cRect = this.view.dom.getBoundingClientRect();
    return {
      sRect,
      scrollLeft: sc.scrollLeft, scrollTop: sc.scrollTop,
      width: sc.clientWidth, height: sc.clientHeight,
      edgeL: cRect.left - sRect.left + sc.scrollLeft,
      edgeR: cRect.right - sRect.left + sc.scrollLeft,
    };
  }
  private g(): ReturnType<InkLayer['geom']> { return this.geom(); }

  private blockTop(blockPos: number, g: ReturnType<InkLayer['geom']>): number | null {
    const dom = this.view.nodeDOM(blockPos) as HTMLElement | null;
    if (!dom || !dom.getBoundingClientRect) return null;
    return dom.getBoundingClientRect().top - g.sRect.top + g.scrollTop;
  }

  private edgeX(side: 'left' | 'right' | undefined, g: ReturnType<InkLayer['geom']>): number {
    return side === 'right' ? g.edgeR : g.edgeL;
  }

  /** Content-space bounding box of one stroke or image, without any live transform. */
  private itemRect(it: SelItem, g: ReturnType<InkLayer['geom']>): Rect | null {
    const e = this.entries.find(x => x.src === it.src);
    if (!e) return null;
    const top = this.blockTop(e.blockPos, g);
    if (top === null) return null;
    const z = zoom();
    if (it.kind === 'img') {
      const im = e.data.imgs[it.idx];
      if (!im) return null;
      return { x: this.edgeX(im.side, g) + im.dx * z, y: top + im.dy * z, w: im.w * z, h: im.h * z };
    }
    const s = e.data.strokes[it.idx];
    if (!s || !s.pts.length) return null;
    const edge = this.edgeX(s.side, g);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [px, py] of s.pts) {
      minX = Math.min(minX, px); minY = Math.min(minY, py);
      maxX = Math.max(maxX, px); maxY = Math.max(maxY, py);
    }
    const pad = s.w / 2;
    return { x: edge + (minX - pad) * z, y: top + (minY - pad) * z, w: (maxX - minX + s.w) * z, h: (maxY - minY + s.w) * z };
  }

  private selRect(g: ReturnType<InkLayer['geom']>): Rect | null {
    if (!this.selection?.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const it of this.selection) {
      const r = this.itemRect(it, g);
      if (!r) continue;
      minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
      maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h);
    }
    if (minX > maxX) return null;
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  private applyXform(x: number, y: number): [number, number] {
    const f = this.xform;
    if (!f) return [x, y];
    return [(x - f.ox) * f.sx + f.ox + f.dx, (y - f.oy) * f.sy + f.oy + f.dy];
  }

  private isSelected(src: string, kind: 'stroke' | 'img', idx: number): boolean {
    return !!this.selection?.some(it => it.src === src && it.kind === kind && it.idx === idx);
  }

  /* -------------------------------------------------------------- painting */

  private image(src: string): HTMLImageElement {
    let img = this.imgCache.get(src);
    if (!img) {
      img = new Image();
      img.onload = () => this.schedule();
      const project = viewProject(this.view);
      img.src = graphicsUrl(project, resolveDocPath(src, viewDocDir(this.view)), 1600);
      this.imgCache.set(src, img);
    }
    return img;
  }

  private paint() {
    if (!this.scroller || !this.canvas.isConnected) return;
    const g = this.geom();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = Math.max(1, Math.round(g.width * dpr)), H = Math.max(1, Math.round(g.height * dpr));
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; this.canvas.style.width = g.width + 'px'; this.canvas.style.height = g.height + 'px'; }
    this.canvas.style.transform = `translate(${g.scrollLeft}px, ${g.scrollTop}px)`;
    // keyhole clip: the whole viewport minus the text column, so column clicks reach the text
    const L = Math.max(0, g.edgeL - g.scrollLeft - 2), R = Math.min(g.width, g.edgeR - g.scrollLeft + 2);
    this.canvas.style.clipPath = R > L
      ? `polygon(0 0, ${g.width}px 0, ${g.width}px ${g.height}px, 0 ${g.height}px, 0 0, ${L}px 0, ${L}px ${g.height}px, ${R}px ${g.height}px, ${R}px 0, ${L}px 0, 0 0)`
      : 'none';
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, g.width, g.height);
    const z = zoom();

    const visible = (top: number) => top !== null && top < g.scrollTop + g.height + 1500 && top > g.scrollTop - 4000;

    /** set the canvas transform for an anchored item; `sel` applies the live drag transform */
    const enter = (edgeX: number, top: number, sel: boolean) => {
      ctx.save();
      ctx.translate(-g.scrollLeft, -g.scrollTop);
      if (sel && this.xform) {
        const f = this.xform;
        ctx.translate(f.dx + f.ox, f.dy + f.oy);
        ctx.scale(f.sx, f.sy);
        ctx.translate(-f.ox, -f.oy);
      }
      ctx.translate(edgeX, top);
      ctx.scale(z, z);
    };
    const drawStroke = (stroke: InkStroke, edgeX: number, top: number, sel = false) => {
      enter(edgeX, top, sel);
      ctx.globalAlpha = stroke.o !== undefined ? stroke.o : 1;
      ctx.fillStyle = stroke.color;
      ctx.fill(pathFor(stroke));
      ctx.restore();
    };

    for (const e of this.entries) {
      const top = this.blockTop(e.blockPos, g);
      if (top === null || !visible(top)) continue;
      // images first (the ink draws over them, like pen on paper)
      e.data.imgs.forEach((im, i) => {
        const el = this.image(im.src);
        if (!el.complete || !el.naturalWidth) return;
        enter(this.edgeX(im.side, g), top, this.isSelected(e.src, 'img', i));
        ctx.globalAlpha = 1;
        try { ctx.drawImage(el, im.dx, im.dy, im.w, im.h); } catch { /* decoding */ }
        ctx.restore();
      });
      e.data.strokes.forEach((s, i) => drawStroke(s, this.edgeX(s.side, g), top, this.isSelected(e.src, 'stroke', i)));
    }
    // other clients' in-progress strokes (awareness), drawn against the same anchors
    this.awareness.getStates().forEach((state, clientId) => {
      if (clientId === this.awareness.clientID) return;
      const ink = (state as { ink?: LiveInk }).ink;
      if (!ink || !ink.pts?.length) return;
      const entry = this.entries.find(x => x.src === ink.src);
      if (!entry) return;
      const top = this.blockTop(entry.blockPos, g);
      if (top === null) return;
      drawStroke({ color: ink.color, w: ink.w, o: ink.o, pts: ink.pts }, this.edgeX(ink.side, g), top);
    });
    // the local stroke being drawn (content coordinates, not yet relativised)
    if (this.live && this.live.pts.length) {
      const l = this.live;
      const rel: InkStroke = { color: l.color, w: l.w, o: l.o, pts: l.pts.map(([x, y, p]) => [(x - l.edgeX) / z, (y - l.anchorTop) / z, p] as [number, number, number]) };
      drawStroke(rel, l.edgeX, l.anchorTop);
    }
    // the lasso being drawn: always shown closed (a segment back to the start), lightly filled —
    // the selection is what the closed shape touches
    if (this.lasso && this.lasso.length > 1) {
      ctx.save();
      ctx.translate(-g.scrollLeft, -g.scrollTop);
      ctx.beginPath();
      ctx.moveTo(this.lasso[0][0], this.lasso[0][1]);
      for (const [x, y] of this.lasso) ctx.lineTo(x, y);
      ctx.closePath();
      ctx.fillStyle = 'rgba(59,110,165,0.08)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(59,110,165,0.9)';
      ctx.lineWidth = 1.25;
      ctx.setLineDash([5, 4]);
      ctx.stroke();
      ctx.restore();
    }
    // the selection box (a DOM overlay: it carries the handles and the move cursor)
    const r = this.selRect(g);
    if (r) {
      const [x1, y1] = this.applyXform(r.x, r.y);
      const [x2, y2] = this.applyXform(r.x + r.w, r.y + r.h);
      this.selBox.hidden = false;
      this.selBox.style.left = Math.min(x1, x2) + 'px';
      this.selBox.style.top = Math.min(y1, y2) + 'px';
      this.selBox.style.width = Math.abs(x2 - x1) + 'px';
      this.selBox.style.height = Math.abs(y2 - y1) + 'px';
    } else this.selBox.hidden = true;
  }

  /* -------------------------------------------------------------- drawing */

  private toContent(e: { clientX: number; clientY: number }, g: ReturnType<InkLayer['geom']>): [number, number] {
    return [e.clientX - g.sRect.left + g.scrollLeft, e.clientY - g.sRect.top + g.scrollTop];
  }

  /** The top-level block beside a viewport y, and the sketch node inside it (if any). */
  private anchorAt(clientY: number, g: ReturnType<InkLayer['geom']>): { blockPos: number; node: { pos: number; src: string; data: InkData } | null } | null {
    const doc = this.view.state.doc;
    const x = g.edgeL - g.scrollLeft + g.sRect.left + 8;
    const yMin = g.sRect.top + 4, yMax = g.sRect.bottom - 4;
    const cy = Math.max(yMin, Math.min(yMax, clientY));
    let found: number | null = null;
    for (const dy of [0, -10, 10, -30, 30, -80, 80]) {
      const hit = this.view.posAtCoords({ left: x, top: cy + dy });
      if (hit) { found = hit.pos; break; }
    }
    if (found === null) return null;
    const $p = doc.resolve(found);
    const blockPos = $p.depth >= 1 ? $p.before(1) : doc.childAfter(Math.min(found, doc.content.size - 1)).offset;
    const block = doc.nodeAt(blockPos);
    if (!block) return null;
    let node: { pos: number; src: string; data: InkData } | null = null;
    block.descendants((n, rel) => {
      if (node || n.type.name !== 'sketch') return !node;
      node = { pos: blockPos + 1 + rel, src: n.attrs.src, data: parseData(n.attrs.data) };
      return false;
    });
    return { blockPos, node };
  }

  private findBySrc(src: string): { pos: number; node: PMNode } | null {
    let out: { pos: number; node: PMNode } | null = null;
    this.view.state.doc.descendants((n, pos) => {
      if (out) return false;
      if (n.type.name === 'sketch' && n.attrs.src === src) { out = { pos, node: n }; return false; }
      return true;
    });
    return out;
  }

  /** Clicking the canvas deactivates the text caret: pasted images now belong to the margins. */
  private focusCanvas(cx: number, cy: number) {
    this.canvasFocused = true;
    this.lastPoint = { x: cx, y: cy };
    const a = document.activeElement as HTMLElement | null;
    if (a && a !== document.body) a.blur();
  }

  private onDown = (e: PointerEvent) => {
    if (!ui.active || !this.editable() || !this.scroller) return;
    if (e.pointerType === 'touch') return;   // fingers pan (touch-action), the pen and mouse draw
    if (e.button !== 0 && !(e.pointerType === 'pen' && e.buttons & 32)) return;
    const g = this.geom();
    const [cx, cy] = this.toContent(e, g);
    this.focusCanvas(cx, cy);
    const side: 'left' | 'right' = cx < (g.edgeL + g.edgeR) / 2 ? 'left' : 'right';
    if (ui.tool === 'lasso') {
      this.lasso = [[cx, cy]];
      this.pointerId = e.pointerId;
      this.canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    if (ui.tool === 'eraser' || (e.pointerType === 'pen' && e.buttons & 32)) {
      this.pointerId = e.pointerId;
      this.canvas.setPointerCapture(e.pointerId);
      this.eraseAt(e, g);
      e.preventDefault();
      return;
    }
    const anchor = this.anchorAt(e.clientY, g);
    if (!anchor) return;
    const top = this.blockTop(anchor.blockPos, g);
    if (top === null) return;
    let src = anchor.node?.src;
    if (!src) {
      // first stroke beside this paragraph: create its anchor node (an invisible marker at the start)
      src = newSrc();
      const node = schema.nodes.sketch.create({ src, data: serializeData({ v: 1, strokes: [], imgs: [] }) });
      this.view.dispatch(this.view.state.tr.insert(anchor.blockPos + 1, node).setMeta('addToHistory', true));
      this.collect();
    }
    const hl = ui.tool === 'highlighter';
    const pen = ui.pens[hl ? 'highlighter' : 'pen'];
    this.live = {
      src, side,
      edgeX: this.edgeX(side, g),
      anchorTop: top,
      color: pen.color,
      w: hl ? pen.width * HIGHLIGHT_WIDTH_FACTOR : pen.width,
      o: hl ? HIGHLIGHT_OPACITY : undefined,
      pts: [],
    };
    this.pointerId = e.pointerId;
    this.canvas.setPointerCapture(e.pointerId);
    this.addPoint(e, g);
    e.preventDefault();
  };

  private addPoint(e: PointerEvent, g: ReturnType<InkLayer['geom']>) {
    if (!this.live) return;
    const events = e.getCoalescedEvents?.() ?? [e];
    for (const ev of events) {
      const [x, y] = this.toContent(ev, g);
      const p = ev.pointerType === 'pen' ? ev.pressure : 0;
      if (this.live.pts.length < 4000) this.live.pts.push([x, y, p]);
    }
    this.schedule();
    const now = performance.now();
    if (now - this.lastAwarenessSend > 40) {
      this.lastAwarenessSend = now;
      const l = this.live;
      const z = zoom();
      const liveMsg: LiveInk = { src: l.src, side: l.side, color: l.color, w: l.w, o: l.o, pts: l.pts.map(([x, y, p]) => [round4((x - l.edgeX) / z), round4((y - l.anchorTop) / z), Math.round(p * 100) / 100] as [number, number, number]) };
      try { this.awareness.setLocalStateField('ink', liveMsg); } catch { /* not connected */ }
    }
  }

  private onMove = (e: PointerEvent) => {
    if (this.pointerId !== e.pointerId) return;
    const g = this.geom();
    if (this.lasso) {
      const [cx, cy] = this.toContent(e, g);
      const last = this.lasso[this.lasso.length - 1];
      if ((last[0] - cx) ** 2 + (last[1] - cy) ** 2 > 4) this.lasso.push([cx, cy]);
      this.schedule();
      e.preventDefault();
      return;
    }
    if (this.live) { this.addPoint(e, g); e.preventDefault(); return; }
    if (ui.tool === 'eraser') { this.eraseAt(e, g); e.preventDefault(); }
  };

  private onUp = (e: PointerEvent) => {
    if (this.pointerId !== e.pointerId) return;
    this.pointerId = null;
    try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* gone */ }
    if (this.lasso) {
      const poly = this.lasso;
      this.lasso = null;
      this.selection = poly.length > 4 ? this.lassoSelect(poly) : null;
      this.schedule();
      return;
    }
    const l = this.live;
    this.live = null;
    try { this.awareness.setLocalStateField('ink', null); } catch { /* closing */ }
    if (!l || !l.pts.length) { this.schedule(); return; }
    const z = zoom();
    const stroke: InkStroke = {
      side: l.side, color: l.color, w: l.w,
      ...(l.o !== undefined ? { o: l.o } : {}),
      pts: l.pts.map(([x, y, p]) => [round4((x - l.edgeX) / z), round4((y - l.anchorTop) / z), Math.round(p * 100) / 100] as [number, number, number]),
    };
    const found = this.findBySrc(l.src);
    if (!found) { this.schedule(); return; }   // the anchor vanished mid-stroke (remote delete)
    const data = parseData(found.node.attrs.data);
    const next: InkData = { v: 1, strokes: [...data.strokes, stroke].slice(-300), imgs: data.imgs };
    this.view.dispatch(this.view.state.tr.setNodeMarkup(found.pos, undefined, { ...found.node.attrs, data: serializeData(next) }));
    this.schedule();
  };

  private onCancel = (e: PointerEvent) => {
    if (this.pointerId !== e.pointerId) return;
    this.pointerId = null;
    this.live = null;
    this.lasso = null;
    try { this.awareness.setLocalStateField('ink', null); } catch { /* closing */ }
    this.schedule();
  };

  /**
   * Everything the (auto-closed) lasso touches — Goodnotes semantics: a stroke is selected when
   * any part of it lies inside the lasso or crosses its line, an image when the lasso overlaps it;
   * nothing has to be encircled completely.
   */
  private lassoSelect(poly: [number, number][]): SelItem[] | null {
    const g = this.geom();
    const z = zoom();
    const out: SelItem[] = [];
    for (const e of this.entries) {
      const top = this.blockTop(e.blockPos, g);
      if (top === null) continue;
      e.data.strokes.forEach((s, i) => {
        const edge = this.edgeX(s.side, g);
        const abs = s.pts.map(([px, py]) => [edge + px * z, top + py * z] as [number, number]);
        if (polylineHitsPolygon(abs, poly)) out.push({ src: e.src, kind: 'stroke', idx: i });
      });
      e.data.imgs.forEach((im, i) => {
        const edge = this.edgeX(im.side, g);
        if (rectHitsPolygon(edge + im.dx * z, top + im.dy * z, im.w * z, im.h * z, poly)) out.push({ src: e.src, kind: 'img', idx: i });
      });
    }
    return out.length ? out : null;
  }

  /* ------------------------------------------- selection: move / resize / delete */

  private onSelDown = (e: PointerEvent) => {
    if (!this.selection || !this.editable()) return;
    const g = this.geom();
    const base = this.selRect(g);
    if (!base) return;
    const [cx, cy] = this.toContent(e, g);
    this.focusCanvas(cx, cy);
    const corner = (e.target as HTMLElement).dataset?.corner ?? '';
    this.dragSel = { mode: corner ? 'resize' : 'move', corner, startX: cx, startY: cy, base, pointerId: e.pointerId };
    this.xform = { dx: 0, dy: 0, sx: 1, sy: 1, ox: base.x, oy: base.y };
    this.selBox.setPointerCapture(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  };

  private onSelMove = (e: PointerEvent) => {
    const d = this.dragSel;
    if (!d || d.pointerId !== e.pointerId) return;
    const g = this.geom();
    const [cx, cy] = this.toContent(e, g);
    if (d.mode === 'move') {
      this.xform = { dx: cx - d.startX, dy: cy - d.startY, sx: 1, sy: 1, ox: d.base.x, oy: d.base.y };
    } else {
      // the corner opposite the dragged one stays put
      const ox = d.corner.includes('w') ? d.base.x + d.base.w : d.base.x;
      const oy = d.corner.includes('n') ? d.base.y + d.base.h : d.base.y;
      const clamp = (v: number) => Math.max(0.05, Math.min(20, v));
      let sx = clamp((cx - ox) / ((d.startX - ox) || 1));
      let sy = clamp((cy - oy) / ((d.startY - oy) || 1));
      if (e.shiftKey) sx = sy = Math.max(sx, sy);
      this.xform = { dx: 0, dy: 0, sx, sy, ox, oy };
    }
    this.schedule();
    e.preventDefault();
  };

  private onSelUp = (e: PointerEvent) => {
    const d = this.dragSel;
    if (!d || d.pointerId !== e.pointerId) return;
    this.dragSel = null;
    try { this.selBox.releasePointerCapture(e.pointerId); } catch { /* gone */ }
    const f = this.xform;
    this.xform = null;
    if (f && (Math.abs(f.dx) > 0.5 || Math.abs(f.dy) > 0.5 || Math.abs(f.sx - 1) > 0.005 || Math.abs(f.sy - 1) > 0.005)) this.commitXform(f);
    else this.schedule();
  };

  /**
   * Apply a finished drag to the document: every selected stroke/image is transformed in content
   * space and re-anchored to the paragraph its top now sits beside (a move to another paragraph
   * migrates it into that paragraph's sketch node, creating one when needed) — all in one
   * transaction, so Ctrl+Z undoes the whole gesture.
   */
  private commitXform(f: Xform) {
    this.xform = f;   // applyXform reads it; cleared again below
    try { this.commitXformInner(f); } finally { this.xform = null; }
  }

  private commitXformInner(f: Xform) {
    const g = this.geom();
    const z = zoom();
    const scaleW = Math.sqrt(Math.abs(f.sx * f.sy));
    interface Placed { blockPos: number; side: 'left' | 'right'; stroke?: InkStroke; img?: InkImage }
    const placed: Placed[] = [];
    const removeBySrc = new Map<string, { strokes: Set<number>; imgs: Set<number> }>();
    const mark = (src: string) => {
      let m = removeBySrc.get(src);
      if (!m) { m = { strokes: new Set(), imgs: new Set() }; removeBySrc.set(src, m); }
      return m;
    };
    for (const it of this.selection ?? []) {
      const e = this.entries.find(x => x.src === it.src);
      if (!e) continue;
      const top = this.blockTop(e.blockPos, g);
      if (top === null) continue;
      if (it.kind === 'stroke') {
        const s = e.data.strokes[it.idx];
        if (!s) continue;
        const edge = this.edgeX(s.side, g);
        const abs = s.pts.map(([px, py, p]) => { const [x, y] = this.applyXform(edge + px * z, top + py * z); return [x, y, p] as [number, number, number]; });
        const minY = Math.min(...abs.map(a => a[1]));
        const midX = abs.reduce((sum, a) => sum + a[0], 0) / abs.length;
        const target = this.targetFor(minY, midX, g);
        if (!target) continue;
        mark(it.src).strokes.add(it.idx);
        placed.push({
          blockPos: target.blockPos, side: target.side,
          stroke: {
            side: target.side, color: s.color, w: round4(Math.max(0.5, s.w * scaleW)), ...(s.o !== undefined ? { o: s.o } : {}),
            pts: abs.map(([x, y, p]) => [round4((x - target.edge) / z), round4((y - target.top) / z), p] as [number, number, number]),
          },
        });
      } else {
        const im = e.data.imgs[it.idx];
        if (!im) continue;
        const edge = this.edgeX(im.side, g);
        const [x1, y1] = this.applyXform(edge + im.dx * z, top + im.dy * z);
        const [x2, y2] = this.applyXform(edge + (im.dx + im.w) * z, top + (im.dy + im.h) * z);
        const target = this.targetFor(Math.min(y1, y2), (x1 + x2) / 2, g);
        if (!target) continue;
        mark(it.src).imgs.add(it.idx);
        placed.push({
          blockPos: target.blockPos, side: target.side,
          img: {
            side: target.side, src: im.src,
            dx: round4((Math.min(x1, x2) - target.edge) / z), dy: round4((Math.min(y1, y2) - target.top) / z),
            w: round4(Math.abs(x2 - x1) / z), h: round4(Math.abs(y2 - y1) / z),
          },
        });
      }
    }
    if (!placed.length) { this.schedule(); return; }
    this.rewrite(removeBySrc, placed);
  }

  /** The paragraph (and column side) an item lands beside after a drag/paste. */
  private targetFor(contentY: number, contentX: number, g: ReturnType<InkLayer['geom']>): { blockPos: number; top: number; edge: number; side: 'left' | 'right'; node: { pos: number; src: string; data: InkData } | null } | null {
    const clientY = contentY - g.scrollTop + g.sRect.top;
    const anchor = this.anchorAt(clientY, g);
    if (!anchor) return null;
    const top = this.blockTop(anchor.blockPos, g);
    if (top === null) return null;
    const side: 'left' | 'right' = contentX < (g.edgeL + g.edgeR) / 2 ? 'left' : 'right';
    return { blockPos: anchor.blockPos, top, edge: this.edgeX(side, g), side, node: anchor.node };
  }

  /**
   * One transaction that removes items from their nodes and adds the placed ones to their target
   * paragraphs' nodes (created when missing; emptied nodes are deleted). Re-selects the results.
   */
  private rewrite(removeBySrc: Map<string, { strokes: Set<number>; imgs: Set<number> }>, placed: { blockPos: number; stroke?: InkStroke; img?: InkImage }[]) {
    const doc = this.view.state.doc;
    // final data per node: start from the current content minus the removed items
    const bySrc = new Map<string, { pos: number | null; blockPos: number; data: InkData }>();
    for (const e of this.entries) {
      const rm = removeBySrc.get(e.src);
      const data: InkData = rm
        ? { v: 1, strokes: e.data.strokes.filter((_, i) => !rm.strokes.has(i)), imgs: e.data.imgs.filter((_, i) => !rm.imgs.has(i)) }
        : e.data;
      if (rm) bySrc.set(e.src, { pos: e.pos, blockPos: e.blockPos, data });
    }
    const bump = (src: string, pos: number | null, blockPos: number): { data: InkData } => {
      let entry = bySrc.get(src);
      if (!entry) {
        const existing = this.entries.find(x => x.src === src);
        entry = { pos, blockPos, data: existing ? { v: 1, strokes: [...existing.data.strokes], imgs: [...existing.data.imgs] } : { v: 1, strokes: [], imgs: [] } };
        bySrc.set(src, entry);
      }
      return entry;
    };
    const newSelection: SelItem[] = [];
    for (const p of placed) {
      // the target block's node: an existing one (possibly among the touched), else a fresh one per block
      const block = doc.nodeAt(p.blockPos);
      let src: string | null = null, nodePos: number | null = null;
      if (block) block.descendants((n, rel) => { if (src || n.type.name !== 'sketch') return !src; src = n.attrs.src; nodePos = p.blockPos + 1 + rel; return false; });
      if (!src) {
        const created = [...bySrc.entries()].find(([, v]) => v.pos === null && v.blockPos === p.blockPos);
        if (created) src = created[0];
      }
      if (!src) { src = newSrc(); }
      const entry = bump(src, nodePos, p.blockPos);
      const data = { ...entry.data, strokes: [...entry.data.strokes], imgs: [...entry.data.imgs] };
      if (p.stroke) { data.strokes.push(p.stroke); newSelection.push({ src, kind: 'stroke', idx: data.strokes.length - 1 }); }
      if (p.img) { data.imgs.push(p.img); newSelection.push({ src, kind: 'img', idx: data.imgs.length - 1 }); }
      bySrc.get(src)!.data = data;
    }
    let tr = this.view.state.tr;
    // existing nodes first (mapped through the accumulating transaction), then the new ones
    for (const [src, v] of bySrc) {
      if (v.pos === null) continue;
      const mapped = tr.mapping.map(v.pos);
      const node = tr.doc.nodeAt(mapped);
      if (!node || node.type.name !== 'sketch') continue;
      if (!v.data.strokes.length && !v.data.imgs.length) tr = tr.delete(mapped, mapped + 1);
      else tr = tr.setNodeMarkup(mapped, undefined, { ...node.attrs, src, data: serializeData(v.data) });
    }
    for (const [src, v] of bySrc) {
      if (v.pos !== null) continue;
      if (!v.data.strokes.length && !v.data.imgs.length) continue;
      const at = tr.mapping.map(v.blockPos) + 1;
      tr = tr.insert(at, schema.nodes.sketch.create({ src, data: serializeData(v.data) }));
    }
    this.view.dispatch(tr);
    this.collect();
    this.selection = newSelection.length ? newSelection : null;
    this.schedule();
  }

  /* ------------------------------------------------- keyboard, paste, eraser */

  private onKeyDown = (e: KeyboardEvent) => {
    if (!ui.active) return;
    const a = document.activeElement as HTMLElement | null;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable || this.view.dom.contains(a))) return;
    if (e.key === 'Escape' && (this.selection || this.canvasFocused)) {
      this.selection = null;
      this.canvasFocused = false;
      this.schedule();
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selection && this.editable()) {
      const removeBySrc = new Map<string, { strokes: Set<number>; imgs: Set<number> }>();
      for (const it of this.selection) {
        let m = removeBySrc.get(it.src);
        if (!m) { m = { strokes: new Set(), imgs: new Set() }; removeBySrc.set(it.src, m); }
        (it.kind === 'stroke' ? m.strokes : m.imgs).add(it.idx);
      }
      this.selection = null;
      this.rewrite(removeBySrc, []);
      e.preventDefault();
    }
  };

  /**
   * Paste onto the canvas: only when the canvas was clicked (the text caret is deactivated) —
   * with the caret in the text, the editor's own handler makes a LaTeX figure instead.
   */
  private onPaste = (e: ClipboardEvent) => {
    if (!ui.active || !this.canvasFocused || !this.editable()) return;
    const a = document.activeElement as HTMLElement | null;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable || this.view.dom.contains(a))) return;
    const files = imageFiles(e.clipboardData);
    const text = e.clipboardData?.getData('text/plain');
    if (!files.length && text && isSvgMarkup(text)) files.push(svgFile(text));
    if (!files.length) return;
    e.preventDefault();
    e.stopPropagation();
    void this.pasteImages(files);
  };

  private async pasteImages(files: File[]) {
    const project = viewProject(this.view);
    if (!project) return;
    const g = this.geom();
    const z = zoom();
    const at = this.lastPoint ?? { x: g.edgeR + 24, y: g.scrollTop + 80 };
    let offset = 0;
    const newSel: SelItem[] = [];
    for (const file of files) {
      const ext = imageExt(file);
      if (!ext) continue;
      try {
        const rel = await uploadUnique(project, uploadBaseName(file), ext, file);
        const dims = await new Promise<[number, number]>((resolve) => {
          const img = new Image();
          img.onload = () => resolve([img.naturalWidth || 240, img.naturalHeight || 160]);
          img.onerror = () => resolve([240, 160]);
          img.src = graphicsUrl(project, resolveDocPath(rel, viewDocDir(this.view)), 1600);
        });
        const gNow = this.geom();
        const target = this.targetFor(at.y + offset, at.x, gNow);
        if (!target) continue;
        const scale = Math.min(1, 240 / dims[0]);
        const img: InkImage = {
          side: target.side, src: rel,
          dx: round4((at.x + offset - target.edge) / z), dy: round4((at.y + offset - target.top) / z),
          w: round4(dims[0] * scale), h: round4(dims[1] * scale),
        };
        // keep the image inside its margin: pull it back towards the edge if it would overlap the text
        if (target.side === 'right' && img.dx < 8) img.dx = 8;
        if (target.side === 'left' && img.dx + img.w > -8) img.dx = -8 - img.w;
        let src = target.node?.src ?? null;
        let tr = this.view.state.tr;
        if (src) {
          const found = this.findBySrc(src);
          if (found) {
            const data = parseData(found.node.attrs.data);
            tr = tr.setNodeMarkup(found.pos, undefined, { ...found.node.attrs, data: serializeData({ v: 1, strokes: data.strokes, imgs: [...data.imgs, img] }) });
            newSel.push({ src, kind: 'img', idx: data.imgs.length });
          }
        } else {
          src = newSrc();
          tr = tr.insert(target.blockPos + 1, schema.nodes.sketch.create({ src, data: serializeData({ v: 1, strokes: [], imgs: [img] }) }));
          newSel.push({ src, kind: 'img', idx: 0 });
        }
        this.view.dispatch(tr);
        this.collect();
        offset += 20;
      } catch (err) { console.warn('margin image paste failed', err); }
    }
    if (newSel.length) { this.selection = newSel; setInk({ tool: 'lasso' }); }
    this.schedule();
  }

  /** Remove strokes near the pointer; an emptied sketch (no strokes, no images) loses its anchor node too. */
  private eraseAt(e: PointerEvent, g: ReturnType<InkLayer['geom']>) {
    const [cx, cy] = this.toContent(e, g);
    const z = zoom();
    let tr = this.view.state.tr;
    let changed = false;
    for (const entry of [...this.entries]) {
      const top = this.blockTop(entry.blockPos, g);
      if (top === null || !entry.data.strokes.length) continue;
      const keep = entry.data.strokes.filter(s => !strokeHit(s, (cx - this.edgeX(s.side, g)) / z, (cy - top) / z, Math.max(6, s.w)));
      if (keep.length === entry.data.strokes.length) continue;
      const mapped = tr.mapping.map(entry.pos);
      const node = tr.doc.nodeAt(mapped);
      if (!node || node.type.name !== 'sketch') continue;
      if (keep.length === 0 && !entry.data.imgs.length) tr = tr.delete(mapped, mapped + 1);
      else tr = tr.setNodeMarkup(mapped, undefined, { ...node.attrs, data: serializeData({ v: 1, strokes: keep, imgs: entry.data.imgs }) });
      changed = true;
    }
    if (changed) this.view.dispatch(tr);
  }
}

/** Is (x, y) — in stroke coordinates — within `r` of the stroke's polyline? */
function strokeHit(s: InkStroke, x: number, y: number, r: number): boolean {
  const pts = s.pts;
  const rr = (r + s.w / 2) ** 2;
  if (pts.length === 1) { const [px, py] = pts[0]; return (px - x) ** 2 + (py - y) ** 2 <= rr; }
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i - 1], [x2, y2] = pts[i];
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len2)) : 0;
    const px = x1 + t * dx, py = y1 + t * dy;
    if ((px - x) ** 2 + (py - y) ** 2 <= rr) return true;
  }
  return false;
}
