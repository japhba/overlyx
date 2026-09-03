/**
 * Margin ink: freehand pen/highlighter drawing in the space left and right of the text column,
 * Goodnotes-style. Strokes are anchored to the paragraph beside them through a `sketch` node
 * (an invisible `\olsketch{...}` command in the .tex) and stored as offsets from the column edge
 * and the paragraph's top — they move with the text through the CRDT, survive reflow, and are
 * saved as sidecar SVGs in figures/ by the server.
 *
 * Rendering: one canvas overlays the scroll viewport, clipped to the margins with a keyhole
 * clip-path (the text column is a hole — clicks there reach the text even in draw mode). The
 * canvas is translated on scroll and repainted from cached Path2D outlines (core/ink.ts — the
 * same geometry the saved SVG uses). In-progress strokes stream to other clients through the
 * Yjs awareness channel and are drawn live; the finished stroke is committed as a normal
 * ProseMirror transaction, so undo (Ctrl+Z) and collaboration come from the existing machinery.
 */
import { Plugin, PluginKey } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import type { Awareness } from 'y-protocols/awareness';
import { schema, strokePathD, type InkStroke } from '@overlyx/core';

export type InkTool = 'pen' | 'highlighter' | 'eraser';
export interface InkUiState { active: boolean; tool: InkTool; color: string; width: number }

const stored = <T,>(k: string, def: T): T => { try { const v = localStorage.getItem(k); return v === null ? def : JSON.parse(v) as T; } catch { return def; } };
let ui: InkUiState = {
  active: false,
  tool: stored('ol.inkTool', 'pen' as InkTool),
  color: stored('ol.inkColor', '#1a73e8'),
  width: stored('ol.inkWidth', 2.5),
};
const subs = new Set<() => void>();
export function getInk(): InkUiState { return ui; }
export function setInk(patch: Partial<InkUiState>): void {
  ui = { ...ui, ...patch };
  try {
    localStorage.setItem('ol.inkTool', JSON.stringify(ui.tool));
    localStorage.setItem('ol.inkColor', JSON.stringify(ui.color));
    localStorage.setItem('ol.inkWidth', JSON.stringify(ui.width));
  } catch { /* private mode */ }
  for (const s of subs) s();
}
export function subscribeInk(fn: () => void): () => void { subs.add(fn); return () => subs.delete(fn); }

/** Should the drawing toolbar switch itself on? Tablets: a coarse pointer with touch. */
export function isTabletClient(): boolean {
  try { return matchMedia('(any-pointer: coarse)').matches && navigator.maxTouchPoints > 0; } catch { return false; }
}

export const HIGHLIGHT_OPACITY = 0.35;

interface InkData { v: 1; strokes: InkStroke[] }
interface SketchEntry { pos: number; blockPos: number; src: string; data: InkData }
/** what streams over awareness while a stroke is drawn */
interface LiveInk { src: string; side: 'left' | 'right'; color: string; w: number; o?: number; pts: [number, number, number][] }

const parseCache = new Map<string, InkData>();
const pathCache = new WeakMap<InkStroke, Path2D>();
function parseData(json: string | null): InkData {
  if (!json) return { v: 1, strokes: [] };
  let d = parseCache.get(json);
  if (!d) {
    try { d = JSON.parse(json) as InkData; } catch { d = { v: 1, strokes: [] }; }
    if (!Array.isArray(d.strokes)) d.strokes = [];
    if (parseCache.size > 200) parseCache.clear();
    parseCache.set(json, d);
  }
  return d;
}
function pathFor(stroke: InkStroke): Path2D {
  let p = pathCache.get(stroke);
  if (!p) { p = new Path2D(strokePathD(stroke)); pathCache.set(stroke, p); }
  return p;
}

const zoom = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--editor-zoom')) || 1;
const round4 = (n: number) => Math.round(n * 4) / 4;

export const inkKey = new PluginKey('lyx-ink');

export function inkPlugin(awareness: Awareness): Plugin {
  return new Plugin({
    key: inkKey,
    view: (view) => new InkLayer(view, awareness),
  });
}

class InkLayer {
  private canvas = document.createElement('canvas');
  private scroller: HTMLElement | null;
  private entries: SketchEntry[] = [];
  private raf = 0;
  private ro: ResizeObserver | null = null;
  private unsub: (() => void)[] = [];
  /** the stroke being drawn here right now (content coordinates of the scroller) */
  private live: { src: string; side: 'left' | 'right'; edgeX: number; anchorTop: number; color: string; w: number; o?: number; pts: [number, number, number][] } | null = null;
  private pointerId: number | null = null;
  private lastAwarenessSend = 0;

  constructor(private view: EditorView, private awareness: Awareness) {
    this.scroller = view.dom.closest('.editor-scroll');
    if (!this.scroller) return;
    this.canvas.className = 'ink-canvas';
    this.scroller.appendChild(this.canvas);
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
    this.unsub.push(subscribeInk(() => { this.applyMode(); this.schedule(); }));

    this.canvas.addEventListener('pointerdown', this.onDown);
    this.canvas.addEventListener('pointermove', this.onMove);
    this.canvas.addEventListener('pointerup', this.onUp);
    this.canvas.addEventListener('pointercancel', this.onCancel);
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
    if (this.live) try { this.awareness.setLocalStateField('ink', null); } catch { /* closing */ }
  }

  private applyMode() {
    this.canvas.classList.toggle('draw', ui.active && this.editable());
  }

  private editable(): boolean {
    return this.view.editable && !this.view.dom.classList.contains('view-only');
  }

  /** All sketch nodes with their anchor block positions. */
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

  private blockTop(blockPos: number, g: ReturnType<InkLayer['geom']>): number | null {
    const dom = this.view.nodeDOM(blockPos) as HTMLElement | null;
    if (!dom || !dom.getBoundingClientRect) return null;
    return dom.getBoundingClientRect().top - g.sRect.top + g.scrollTop;
  }

  /* -------------------------------------------------------------- painting */

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

    const drawStroke = (stroke: InkStroke, edgeX: number, top: number) => {
      ctx.save();
      ctx.translate(edgeX - g.scrollLeft, top - g.scrollTop);
      ctx.scale(z, z);
      ctx.globalAlpha = stroke.o !== undefined ? stroke.o : 1;
      ctx.fillStyle = stroke.color;
      ctx.fill(pathFor(stroke));
      ctx.restore();
    };

    for (const e of this.entries) {
      if (!e.data.strokes.length) continue;
      const top = this.blockTop(e.blockPos, g);
      if (top === null || top > g.scrollTop + g.height + 1500 || top < g.scrollTop - 4000) continue;
      for (const s of e.data.strokes) drawStroke(s, s.side === 'right' ? g.edgeR : g.edgeL, top);
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
      drawStroke({ color: ink.color, w: ink.w, o: ink.o, pts: ink.pts }, ink.side === 'right' ? g.edgeR : g.edgeL, top);
    });
    // the local stroke being drawn (content coordinates, not yet relativised)
    if (this.live && this.live.pts.length) {
      const l = this.live;
      const rel: InkStroke = { color: l.color, w: l.w, o: l.o, pts: l.pts.map(([x, y, p]) => [(x - l.edgeX) / z, (y - l.anchorTop) / z, p] as [number, number, number]) };
      drawStroke(rel, l.edgeX, l.anchorTop);
    }
  }

  /* -------------------------------------------------------------- drawing */

  private toContent(e: PointerEvent, g: ReturnType<InkLayer['geom']>): [number, number] {
    return [e.clientX - g.sRect.left + g.scrollLeft, e.clientY - g.sRect.top + g.scrollTop];
  }

  /** The top-level block beside a viewport y, and the sketch node inside it (if any). */
  private anchorAt(clientY: number, g: ReturnType<InkLayer['geom']>): { blockPos: number; node: { pos: number; src: string; data: InkData } | null } | null {
    const doc = this.view.state.doc;
    const x = g.edgeL - g.scrollLeft + g.sRect.left + 8;
    let found: number | null = null;
    for (const dy of [0, -10, 10, -30, 30]) {
      const hit = this.view.posAtCoords({ left: x, top: clientY + dy });
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

  private onDown = (e: PointerEvent) => {
    if (!ui.active || !this.editable() || !this.scroller) return;
    if (e.pointerType === 'touch') return;   // fingers pan (touch-action), the pen and mouse draw
    if (e.button !== 0 && !(e.pointerType === 'pen' && e.buttons & 32)) return;
    const g = this.geom();
    const [cx] = this.toContent(e, g);
    const side: 'left' | 'right' = cx < (g.edgeL + g.edgeR) / 2 ? 'left' : 'right';
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
      src = `figures/ink-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.svg`;
      const node = schema.nodes.sketch.create({ src, data: JSON.stringify({ v: 1, strokes: [] }) });
      this.view.dispatch(this.view.state.tr.insert(anchor.blockPos + 1, node).setMeta('addToHistory', true));
      this.collect();
    }
    const hl = ui.tool === 'highlighter';
    this.live = {
      src, side,
      edgeX: side === 'right' ? g.edgeR : g.edgeL,
      anchorTop: top,
      color: ui.color,
      w: hl ? ui.width * 4 : ui.width,
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
    if (this.live) { this.addPoint(e, g); e.preventDefault(); return; }
    if (ui.tool === 'eraser') { this.eraseAt(e, g); e.preventDefault(); }
  };

  private onUp = (e: PointerEvent) => {
    if (this.pointerId !== e.pointerId) return;
    this.pointerId = null;
    try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* gone */ }
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
    const next: InkData = { v: 1, strokes: [...data.strokes, stroke].slice(-300) };
    this.view.dispatch(this.view.state.tr.setNodeMarkup(found.pos, undefined, { ...found.node.attrs, data: JSON.stringify(next) }));
    this.schedule();
  };

  private onCancel = (e: PointerEvent) => {
    if (this.pointerId !== e.pointerId) return;
    this.pointerId = null;
    this.live = null;
    try { this.awareness.setLocalStateField('ink', null); } catch { /* closing */ }
    this.schedule();
  };

  /** Remove strokes near the pointer; an emptied sketch loses its anchor node too. */
  private eraseAt(e: PointerEvent, g: ReturnType<InkLayer['geom']>) {
    const [cx, cy] = this.toContent(e, g);
    const z = zoom();
    let tr = this.view.state.tr;
    let changed = false;
    // walk from the current transaction state so several erased nodes map correctly
    for (const entry of [...this.entries]) {
      const top = this.blockTop(entry.blockPos, g);
      if (top === null || !entry.data.strokes.length) continue;
      const edge = (s: InkStroke) => (s.side === 'right' ? g.edgeR : g.edgeL);
      const keep = entry.data.strokes.filter(s => !strokeHit(s, (cx - edge(s)) / z, (cy - top) / z, Math.max(6, s.w)));
      if (keep.length === entry.data.strokes.length) continue;
      const mapped = tr.mapping.map(entry.pos);
      const node = tr.doc.nodeAt(mapped);
      if (!node || node.type.name !== 'sketch') continue;
      if (keep.length === 0) tr = tr.delete(mapped, mapped + 1);
      else tr = tr.setNodeMarkup(mapped, undefined, { ...node.attrs, data: JSON.stringify({ v: 1, strokes: keep }) });
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
