/**
 * The layout plugin: OverLyX's canvas for layout documents (pages of positioned objects).
 *
 * Interaction is Keynote / PowerPoint's with Inkscape's drawing tools:
 * - a click selects an object (Shift adds), a drag moves it (Ctrl/⌘-drag copies it, Shift keeps
 *   the axis, Alt switches snapping off); the handles resize (Shift keeps the proportions, images'
 *   corners keep them by default, Alt resizes about the centre) and rotate (Shift: 15° steps);
 *   a drag on the empty page selects with a rubber band;
 * - a second click on a selected text box, a double click or typing edits its text — ordinary
 *   ProseMirror editing with every OverLyX feature (formulas, lists, colours…); Esc goes back to
 *   the box;
 * - tools: text box (T), shapes (R rectangle, E ellipse, and the shape palette), line (L), arrow
 *   (A), Bézier pen (B: click = corner, drag = smooth node, click the first node or double-click /
 *   Enter to finish), pencil (P), node editor (N or a double click on a shape: drag nodes and
 *   handles, double-click a segment to add a node, Delete removes one, C toggles smooth / corner)
 *   and crop (C or a double click on an image: the frame's handles crop, dragging inside pans the
 *   picture);
 * - moving and resizing snap to the page's edges and centre and to the other objects' edges and
 *   centres (guides are drawn);
 * - arrow keys nudge by 1 mm (Shift 10 mm, Alt 0.1 mm); Delete, Ctrl+D (duplicate), Ctrl+G / Ctrl+Shift+G
 *   (group / ungroup), Ctrl+] / Ctrl+[ (forward / backward, with Shift: to the front / back).
 *
 * Moves and resizes are shown live — to collaborators too — as transactions that bypass the undo
 * history; at the end the original state is restored and the result applied in one undoable step.
 * The page size, base font and colours come from the document header (the Y meta map).
 */
import { Plugin, PluginKey, NodeSelection, TextSelection, type EditorState, type Transaction } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { DOMSerializer, Fragment, Slice, type Node as PMNode } from 'prosemirror-model';
import { ySyncPluginKey } from 'y-prosemirror';
import { schema, normalizePath, pathToString, preambleColors, pageSizeOf, rgbToHex, SHAPE_PRESETS, type PathSeg } from '@overlyx/core';
import { boxOf, objectBounds, unionBounds, isLayoutObject, pageObjects, rotatePoint, MM, docColors, boundsOf, type Box } from './geom';
import * as L from './commands';
import type { PageView } from './nodeviews';
import { startPresentation } from './present';
import { openRawEditor } from './rawedit';

export type Tool = 'select' | 'text' | 'shape' | 'line' | 'arrow' | 'pen' | 'pencil' | 'nodes' | 'crop';

export interface LayoutPluginState {
  /** selected top-level objects (document positions; one page) */
  sel: number[];
  tool: Tool;
  /** the shape the shape tool draws (SHAPE_PRESETS) */
  shape: string;
  /** the object being node-edited / cropped */
  target: number | null;
}

export const layoutKey = new PluginKey<LayoutPluginState>('layout');

type Meta = Partial<LayoutPluginState>;

/** default styles of new objects (xcolor expressions, as written into the file) */
export const NEW_STYLE = {
  shape: { fill: '[HTML]DCE9F7', stroke: '[HTML]2F5597', lw: 0.8 },
  line: { stroke: 'black', lw: 1 },
  pen: { stroke: 'black', lw: 1 },
};

/* ------------------------------------------------------------------ state helpers */

export function layoutState(state: EditorState): LayoutPluginState | undefined { return layoutKey.getState(state); }

export function selectedObjects(state: EditorState): { node: PMNode; pos: number }[] {
  const st = layoutKey.getState(state);
  if (!st) return [];
  const out: { node: PMNode; pos: number }[] = [];
  for (const pos of st.sel) { const n = state.doc.nodeAt(pos); if (n && isLayoutObject(n)) out.push({ node: n, pos }); }
  return out;
}

/** Select objects (object mode: the ProseMirror selection is a node selection of the first). */
export function selectObjects(tr: Transaction, positions: number[]): Transaction {
  const valid = positions.filter(p => isLayoutObject(tr.doc.nodeAt(p)));
  tr.setMeta(layoutKey, { sel: valid, target: null } as Meta);
  if (valid.length) {
    try { tr.setSelection(NodeSelection.create(tr.doc, valid[0])); } catch { /* not selectable */ }
  }
  return tr;
}

export function setTool(view: EditorView, tool: Tool, shape?: string): void {
  const meta: Meta = { tool };
  if (shape) meta.shape = shape;
  if (tool !== 'nodes' && tool !== 'crop') meta.target = null;
  if (tool === 'nodes' || tool === 'crop') {
    const sel = selectedObjects(view.state);
    const want = tool === 'nodes' ? 'ol_shape' : 'ol_image';
    const t = sel.find(o => o.node.type.name === want);
    meta.target = t ? t.pos : null;
  }
  view.dispatch(view.state.tr.setMeta(layoutKey, meta));
  view.focus();
}

/* ------------------------------------------------------------------ the plugin */

export function layoutPlugin(): Plugin<LayoutPluginState> {
  let controller: LayoutController | null = null;
  return new Plugin<LayoutPluginState>({
    key: layoutKey,
    state: {
      init: () => ({ sel: [], tool: 'select', shape: 'rect', target: null }),
      apply(tr, prev, _old, newState): LayoutPluginState {
        const meta = tr.getMeta(layoutKey) as Meta | undefined;
        let sel = prev.sel, target = prev.target;
        if (tr.docChanged) {
          // mapped from the left: a shape or image whose attributes change is replaced by a new node
          // at the same place (a leaf's setNodeMarkup), which a mapping from the right calls deleted
          sel = sel.map(p => tr.mapping.map(p, -1)).filter(p => isLayoutObject(newState.doc.nodeAt(p)));
          if (target !== null) target = tr.mapping.map(target, -1);
        }
        const next: LayoutPluginState = { ...prev, sel, target, ...(meta ?? {}) };
        // a text selection (typing in a box) leaves object mode; a node selection of an object is one
        // (a node selection ProseMirror makes by itself — the document's start, a restored cursor — selects nothing)
        if (!meta?.sel && tr.selectionSet) {
          const s = newState.selection;
          if (s instanceof NodeSelection && isLayoutObject(s.node) && tr.getMeta('pointer')) { if (!next.sel.includes(s.from)) next.sel = [s.from]; }
          else if (!(s instanceof NodeSelection && next.sel.includes(s.from))) next.sel = [];
        }
        if (next.target !== null && !isLayoutObject(newState.doc.nodeAt(next.target))) next.target = null;
        // unchanged: the same object (the toolbars re-render when it changes)
        if (next.tool === prev.tool && next.shape === prev.shape && next.target === prev.target && next.sel.length === prev.sel.length && next.sel.every((p, i) => p === prev.sel[i])) return prev;
        return next;
      },
    },
    view: (view) => { controller = new LayoutController(view); return controller; },
    // a text selection never spans two text boxes: its head is kept in the anchor's box
    appendTransaction: (trs, _old, state) => {
      if (!trs.some(t => t.selectionSet) || !L.isLayoutDoc(state.doc)) return null;
      const s = state.selection;
      if (!(s instanceof TextSelection) || s.empty) return null;
      const boxOf = (p: number) => { const $p = state.doc.resolve(p); for (let d = $p.depth; d > 0; d--) if ($p.node(d).type.name === 'ol_box' || $p.node(d).type.name === 'ol_notes') return $p.before(d); return -1; };
      const a = boxOf(s.anchor), h = boxOf(s.head);
      if (a === h || a < 0) return null;
      const box = state.doc.nodeAt(a)!;
      const head = s.head > s.anchor ? a + box.nodeSize - 1 : a + 1;
      return state.tr.setSelection(TextSelection.between(state.doc.resolve(s.anchor), state.doc.resolve(head)));
    },
    props: {
      handleDOMEvents: {
        pointerdown: (view, ev) => controller?.pointerDown(ev as PointerEvent) ?? false,
        dblclick: (view, ev) => controller?.doubleClick(ev as MouseEvent) ?? false,
        copy: (view, ev) => controller?.clipboard(ev as ClipboardEvent, false) ?? false,
        cut: (view, ev) => controller?.clipboard(ev as ClipboardEvent, true) ?? false,
        wheel: (view, ev) => controller?.wheel(ev as WheelEvent) ?? false,
      },
      handleKeyDown: (view, ev) => controller?.keyDown(ev) ?? false,
      handlePaste: (view, ev, slice) => controller?.paste(slice) ?? false,
      handleTextInput: (view) => {
        // typing while objects are selected: never replace an object by text
        const s = view.state.selection;
        return s instanceof NodeSelection && isLayoutObject(s.node);
      },
    },
  });
}

/* ------------------------------------------------------------------ geometry of the view */

interface PageCtx {
  pv: PageView;
  pos: number;
  node: PMNode;
  rect: DOMRect;
  /** client coordinates → page millimetres */
  mm(ev: { clientX: number; clientY: number }): [number, number];
  /** millimetres per screen pixel */
  mmPerPx: number;
}

type Gesture = { move(ev: PointerEvent): void; up(ev: PointerEvent): void; cancel(): void };

const HANDLE_DIRS: Record<string, [number, number]> = { nw: [-1, -1], n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0] };

const controllers = new WeakMap<EditorView, LayoutController>();

/**
 * The document header as the shell holds it: the web client's is in the Y meta map, the VS Code
 * webview's is not (both shells call setLayoutHeader with it, next to setDocumentFonts).
 */
let shellHeader: string[] | null = null;
const shellHeaderListeners = new Set<() => void>();
export function setLayoutHeader(lines: string[]): void {
  shellHeader = lines;
  for (const f of shellHeaderListeners) f();
}

/** a stable number per page node (the overlays of unchanged pages are not drawn again) */
const nodeIds = new WeakMap<PMNode, number>();
let nodeSeq = 0;
const nodeId = (n: PMNode) => { let v = nodeIds.get(n); if (v === undefined) { v = ++nodeSeq; nodeIds.set(n, v); } return v; };

class LayoutController {
  private active = false;
  page = { w: 160, h: 90 };
  private basePt = 11;
  private headerJson = '';
  private metaUnobserve: (() => void) | null = null;
  private resize: ResizeObserver | null = null;
  private gesture: Gesture | null = null;
  /** guide lines of the current drag (page mm) */
  private guides: { x?: number; y?: number; page: number }[] = [];
  private marquee: { page: number; x: number; y: number; w: number; h: number } | null = null;
  /** the pen tool's path under construction (page mm) */
  private pen: { page: number; nodes: { x: number; y: number; cin?: [number, number]; cout?: [number, number] }[]; hover?: [number, number] } | null = null;
  /** a node or handle being edited: index into the shape's segments */
  private nodeSel: { seg: number; pt: number } | null = null;
  private lastLocalBox: number | null = null;
  private growQueued = false;

  constructor(private view: EditorView) {
    controllers.set(view, this);
    this.update(view, null);
  }

  /* ---------------------------------------------------------------- lifecycle */

  update(view: EditorView, prev: EditorState | null): void {
    this.view = view;
    const layout = L.isLayoutDoc(view.state.doc);
    if (layout !== this.active) {
      this.active = layout;
      view.dom.classList.toggle('ol-layout', layout);
      if (layout) this.attach(); else this.detach();
    }
    // every document: its base font size (point sizes, the size box) and its own colours
    this.readHeader();
    if (!layout) return;
    const st = layoutKey.getState(view.state)!;
    view.dom.dataset.olTool = st.tool;
    if (prev && prev.doc !== view.state.doc) {
      // a local edit inside a growing text box: its height follows the text
      const eb = L.editedBox(view.state);
      if (eb && eb.node.attrs.grow) this.lastLocalBox = eb.pos;
      this.queueGrow();
    }
    this.renderOverlays();
  }

  destroy(): void { this.detach(); this.metaUnobserve?.(); this.metaUnobserve = null; this.colorStyle?.remove(); this.gesture?.cancel(); }
  private colorStyle: HTMLStyleElement | null = null;

  private attach(): void {
    const scroller = this.view.dom.closest('.editor-scroll') ?? this.view.dom.parentElement;
    if (scroller && typeof ResizeObserver !== 'undefined') {
      this.resize = new ResizeObserver(() => this.fit());
      this.resize.observe(scroller);
    }
    this.readHeader(true);
  }

  private detach(): void {
    this.resize?.disconnect(); this.resize = null;
    for (const p of ['--ol-page-w', '--ol-page-h', '--ol-fit-pt']) this.view.dom.style.removeProperty(p);
  }

  /** the header lives in the Y meta map: follow its changes (document settings, the page size) */
  private watchMeta(): void {
    if (this.metaUnobserve) return;
    const sync = ySyncPluginKey.getState(this.view.state) as { doc?: import('yjs').Doc } | undefined;
    const meta = sync?.doc?.getMap<string>('meta');
    const f = () => { if (this.view.isDestroyed) return; this.readHeader(); this.renderOverlays(true); };
    meta?.observe(f);
    shellHeaderListeners.add(f);
    this.metaUnobserve = () => { meta?.unobserve(f); shellHeaderListeners.delete(f); };
  }

  private headerLines(): string[] {
    const sync = ySyncPluginKey.getState(this.view.state) as { doc?: import('yjs').Doc } | undefined;
    const raw = sync?.doc?.getMap<string>('meta').get('header');
    if (raw) { try { return JSON.parse(raw); } catch { /* damaged */ } }
    return shellHeader ?? [];
  }

  /** page size, base font size and colours from the document header */
  private readHeader(force = false): void {
    this.watchMeta();
    const lines = this.headerLines();
    const json = JSON.stringify(lines);
    if (json === this.headerJson && !force) return;
    this.headerJson = json;
    this.page = pageSizeOf(lines);
    const opt = lines.find(l => l.startsWith('\\options '))?.slice(9) ?? '';
    const fs = /(?:^|,)\s*(\d+(?:\.\d+)?)pt\s*(?:,|$)/.exec(opt)?.[1] ?? lines.find(l => l.startsWith('\\paperfontsize '))?.slice(15);
    const cls = lines.find(l => l.startsWith('\\textclass '))?.slice(11) ?? '';
    this.basePt = fs && fs !== 'default' && Number(fs) ? Number(fs) : cls.startsWith('beamer') ? 11 : 10;
    const a = lines.indexOf('\\begin_preamble'), b = lines.indexOf('\\end_preamble');
    const preamble = a >= 0 && b > a ? lines.slice(a + 1, b).join('\n') : '';
    const colors = preambleColors(preamble);
    const changed = JSON.stringify(colors) !== JSON.stringify(docColors.map);
    docColors.map = colors;
    const s = this.view.dom.style;
    s.setProperty('--ol-basept', String(this.basePt));
    // text in the document's own colours (\definecolor{jblue}…): \textcolor{jblue} draws in it
    const rules = Object.entries(colors).map(([name, rgb]) => `.lyx-editor .lyx-color-${CSS.escape(name)}{color:${rgbToHex(rgb)}}`).join('\n');
    if (rules || this.colorStyle) {
      if (!this.colorStyle) { this.colorStyle = document.createElement('style'); this.colorStyle.dataset.olColors = ''; document.head.append(this.colorStyle); }
      this.colorStyle.textContent = rules;
    }
    for (const [name, rgb] of Object.entries(colors)) s.setProperty(`--lyx-color-${name}`, rgbToHex(rgb));
    if (!this.active) return;
    s.setProperty('--ol-page-w', String(this.page.w));
    s.setProperty('--ol-page-h', String(this.page.h));
    this.view.dom.dataset.olFont = /\\usefonttheme\s*\{\s*serif\s*\}/.test(preamble) ? 'serif' : /noto/i.test(preamble) ? 'noto' : 'sans';
    this.fit();
    if (changed) this.rerenderViews();
  }

  /** the zoom that fits the page's width into the window (× the editor zoom, see styles.css) */
  private fit(): void {
    const scroller = (this.view.dom.closest('.editor-scroll') ?? this.view.dom.parentElement) as HTMLElement | null;
    const width = Math.max(200, (scroller?.clientWidth ?? 1000) - 72);
    const pxPerMm = width / this.page.w;
    const fitPt = Math.min(pxPerMm / 2.845276, 4);
    this.view.dom.style.setProperty('--ol-fit-pt', `${fitPt.toFixed(4)}px`);
  }

  private rerenderViews(): void {
    this.view.state.doc.descendants((n, pos) => {
      if (!isLayoutObject(n) && n.type.name !== 'ol_page') return true;
      const v = (this.view.nodeDOM(pos) as (HTMLElement & { pmViewDesc?: { spec?: { render?: () => void } } }) | null)?.pmViewDesc?.spec;
      v?.render?.();
      return true;
    });
  }

  /* ---------------------------------------------------------------- pages */

  private pageViews(): PageView[] {
    return [...this.view.dom.querySelectorAll<HTMLElement & { olPage?: PageView }>('.ol-page-wrap')].map(e => e.olPage!).filter(Boolean);
  }

  private pageCtxFromEl(el: Element | null): PageCtx | null {
    const wrap = el?.closest?.('.ol-page-wrap') as (HTMLElement & { olPage?: PageView }) | null;
    const pv = wrap?.olPage;
    if (!pv) return null;
    const pos = pv.pos();
    if (pos === undefined) return null;
    const node = this.view.state.doc.nodeAt(pos);
    if (!node || node.type.name !== 'ol_page') return null;
    const rect = pv.contentDOM.getBoundingClientRect();
    const w = this.page.w, h = this.page.h;
    return {
      pv, pos, node, rect,
      mm: ev => [(ev.clientX - rect.left) * w / rect.width, (ev.clientY - rect.top) * h / rect.height],
      mmPerPx: w / Math.max(1, rect.width),
    };
  }

  private pageCtxAt(pos: number): PageCtx | null {
    const page = L.pageAt(this.view.state.doc, pos);
    if (!page) return null;
    const dom = this.view.nodeDOM(page.pos) as HTMLElement | null;
    return this.pageCtxFromEl(dom);
  }

  /** the page under the pointer (between pages: the nearest one) */
  private pageCtxAtPoint(x: number, y: number): PageCtx | null {
    const el = document.elementFromPoint(x, y);
    const direct = this.pageCtxFromEl(el);
    if (direct) return direct;
    let best: PageCtx | null = null, dist = Infinity;
    for (const pv of this.pageViews()) {
      const ctx = this.pageCtxFromEl(pv.dom);
      if (!ctx) continue;
      const r = ctx.rect;
      const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
      if (d < dist) { dist = d; best = ctx; }
    }
    return best;
  }

  /** the page the user is working on: the selection's, else the one most in view */
  currentPage(): PageCtx | null {
    const st = layoutKey.getState(this.view.state)!;
    if (st.sel.length) { const c = this.pageCtxAt(st.sel[0]); if (c) return c; }
    const eb = L.editedBox(this.view.state);
    if (eb) { const c = this.pageCtxAt(eb.pos); if (c) return c; }
    const scroller = (this.view.dom.closest('.editor-scroll') ?? document.documentElement) as HTMLElement;
    const sr = scroller.getBoundingClientRect();
    let best: PageCtx | null = null, bestVis = -1;
    for (const pv of this.pageViews()) {
      const r = pv.contentDOM.getBoundingClientRect();
      const vis = Math.min(r.bottom, sr.bottom) - Math.max(r.top, sr.top);
      if (vis > bestVis) { bestVis = vis; best = this.pageCtxFromEl(pv.dom); }
    }
    return best;
  }

  /* ---------------------------------------------------------------- overlays */

  private renderOverlays(force = false): void {
    if (!this.active) return;
    const state = this.view.state;
    const st = layoutKey.getState(state)!;
    const sel = selectedObjects(state);
    const edited = L.editedBox(state);
    for (const pv of this.pageViews()) {
      const pagePos = pv.pos();
      if (pagePos === undefined) continue;
      const page = state.doc.nodeAt(pagePos);
      if (!page) continue;
      const end = pagePos + page.nodeSize;
      const mine = sel.filter(o => o.pos > pagePos && o.pos < end);
      const editedHere = edited && edited.pos > pagePos && edited.pos < end ? edited.pos : -1;
      const key = [nodeId(page), pagePos, mine.map(o => o.pos).join(','), editedHere, editedHere >= 0 ? nodeId(edited!.node) : 0, st.tool, st.target ?? '',
        this.nodeSel ? `${this.nodeSel.seg}:${this.nodeSel.pt}` : '', JSON.stringify(this.guides.filter(g => g.page === pagePos)),
        this.marquee?.page === pagePos ? JSON.stringify(this.marquee) : '', this.pen?.page === pagePos ? JSON.stringify(this.pen.nodes) : '', this.page.w, this.page.h].join('|');
      const pvk = pv as PageView & { olOverlayKey?: string };
      if (!force && pvk.olOverlayKey === key) continue;
      pvk.olOverlayKey = key;
      const out: HTMLElement[] = [];
      // animation badges: the step an object appears on
      pageObjects(page, pagePos).forEach(o => {
        if (!o.node.attrs.step) return;
        const b = objectBounds(o.node);
        const badge = div('ol-badge', { left: MM(b.x), top: MM(b.y) });
        badge.textContent = String(o.node.attrs.step);
        badge.title = `Appears on step ${o.node.attrs.step}${o.node.attrs.effect ? ` (${o.node.attrs.effect})` : ''}`;
        out.push(badge);
      });
      if (edited && edited.pos > pagePos && edited.pos < end) out.push(this.frameEl(boxOf(edited.node), 'ol-editing', true, edited.pos));
      if (mine.length === 1) {
        const o = mine[0];
        if (o.node.type.name === 'ol_group') {
          const b = objectBounds(o.node);
          out.push(this.frameEl({ ...b, rot: 0 }, 'ol-selframe ol-groupframe', true, o.pos));
        } else out.push(this.frameEl(boxOf(o.node), 'ol-selframe' + (o.node.attrs.lock ? ' ol-lockedframe' : ''), !o.node.attrs.lock, o.pos));
      } else if (mine.length > 1) {
        for (const o of mine) out.push(this.frameEl(o.node.type.name === 'ol_group' ? { ...objectBounds(o.node), rot: 0 } : boxOf(o.node), 'ol-selframe ol-thin', false, o.pos));
        const u = unionBounds(mine.map(o => objectBounds(o.node)))!;
        out.push(this.frameEl({ ...u, rot: 0 }, 'ol-selframe ol-union', true, null));
      }
      // node editing / cropping
      if (st.target !== null && st.target > pagePos && st.target < end) {
        const t = state.doc.nodeAt(st.target)!;
        if (st.tool === 'nodes' && t.type.name === 'ol_shape') out.push(this.nodesEl(t, st.target));
        if (st.tool === 'crop' && t.type.name === 'ol_image') out.push(this.cropEl(t, st.target));
      }
      for (const g of this.guides) {
        if (g.page !== pagePos) continue;
        if (g.x !== undefined) out.push(div('ol-guide ol-guide-v', { left: MM(g.x) }));
        if (g.y !== undefined) out.push(div('ol-guide ol-guide-h', { top: MM(g.y) }));
      }
      if (this.marquee && this.marquee.page === pagePos) {
        const m = this.marquee;
        out.push(div('ol-marquee', { left: MM(m.x), top: MM(m.y), width: MM(m.w), height: MM(m.h) }));
      }
      if (this.pen && this.pen.page === pagePos) out.push(this.penEl());
      pv.overlay.replaceChildren(...out);
    }
  }

  /** a selection frame with its handles (page mm, rotated like the object) */
  private frameEl(b: Box, cls: string, handles: boolean, pos: number | null): HTMLElement {
    const f = div(cls, { left: MM(b.x), top: MM(b.y), width: MM(b.w), height: MM(b.h), transform: b.rot ? `rotate(${-b.rot}deg)` : '' });
    if (!handles) return f;
    for (const h of Object.keys(HANDLE_DIRS)) {
      const el = div('ol-h ol-h-' + h);
      el.dataset.h = h;
      el.addEventListener('pointerdown', ev => this.startResize(ev, h, pos));
      f.append(el);
    }
    const rot = div('ol-h ol-h-rot');
    rot.title = 'Rotate (Shift: 15° steps)';
    rot.addEventListener('pointerdown', ev => this.startRotate(ev, pos));
    f.append(div('ol-h-rotline'), rot);
    return f;
  }

  /* ---------------------------------------------------------------- pointer */

  pointerDown(ev: PointerEvent): boolean {
    if (!this.active || ev.button !== 0 || !this.view.editable) return false;
    const target = ev.target as HTMLElement;
    if (target.closest('.ol-overlay') || target.closest('.ol-page-label')) return false;   // handles have their own listeners
    const ctx = this.pageCtxFromEl(target);
    const st = layoutKey.getState(this.view.state)!;
    if (!ctx) {
      // beside the pages: nothing to select there
      if (target.closest('.ol-notes')) return false;
      if (st.sel.length) this.view.dispatch(selectObjects(this.view.state.tr, []));
      return false;
    }
    if (target.closest('.ol-notes')) return false;
    // tools that draw
    if (st.tool === 'text' || st.tool === 'shape' || st.tool === 'line' || st.tool === 'arrow') { this.startCreate(ev, ctx, st.tool); return this.take(ev); }
    if (st.tool === 'pen') { this.penDown(ev, ctx); return this.take(ev); }
    if (st.tool === 'pencil') { this.startPencil(ev, ctx); return this.take(ev); }
    const hit = this.hitObject(ev, ctx);
    // editing text: presses inside the box being edited are the text's
    const edited = L.editedBox(this.view.state);
    if (edited && hit && hit.pos === edited.pos && target.closest('.ol-box-content')) return false;
    if (!hit) {
      if (st.tool === 'nodes' || st.tool === 'crop') { this.finishTargetTool(); }
      this.startMarquee(ev, ctx);
      return this.take(ev);
    }
    const wasSelected = st.sel.includes(hit.pos);
    if (ev.shiftKey) {
      const next = wasSelected ? st.sel.filter(p => p !== hit.pos) : [...st.sel.filter(p => this.samePage(p, hit.pos)), hit.pos];
      this.view.dispatch(selectObjects(this.view.state.tr, next));
      this.view.focus();
      return this.take(ev);
    }
    if (!wasSelected) this.view.dispatch(selectObjects(this.view.state.tr, [hit.pos]));
    this.view.focus();
    const positions = wasSelected ? layoutKey.getState(this.view.state)!.sel : [hit.pos];
    this.startMove(ev, ctx, positions, wasSelected && positions.length === 1 && hit.node.type.name === 'ol_box' ? hit.pos : null);
    return this.take(ev);
  }

  /** the gesture is ours: no native selection, but the keyboard goes to the editor (Delete, arrows, F5) */
  private take(ev: Event): boolean { ev.preventDefault(); if (!this.view.hasFocus()) this.view.focus(); return true; }

  private samePage(a: number, b: number): boolean {
    const doc = this.view.state.doc;
    return L.pageAt(doc, a)?.pos === L.pageAt(doc, b)?.pos;
  }

  /** the top-level object under the pointer (locked objects are skipped; a group member selects the group) */
  private hitObject(ev: { clientX: number; clientY: number }, ctx: PageCtx): { node: PMNode; pos: number } | null {
    const els = document.elementsFromPoint(ev.clientX, ev.clientY);
    for (const el of els) {
      if (!ctx.pv.contentDOM.contains(el)) continue;
      const obj = (el as HTMLElement).closest?.('.ol-obj') as HTMLElement | null;
      if (!obj || obj.classList.contains('ol-locked')) continue;
      // shapes answer only on their painted parts (SVG hit testing), not their whole box
      if (obj.classList.contains('ol-shape') && !(el instanceof SVGElement)) continue;
      const own = this.objectOfDom(obj);
      if (!own) continue;
      const top = L.objectAt(this.view.state.doc, own.inner);
      if (top) {
        if (top.node.attrs.lock || own.node.attrs.lock) continue;
        return top;
      }
    }
    return null;
  }

  /** the object an `.ol-obj` element shows: its node, position, and a position inside it */
  private objectOfDom(el: HTMLElement): { node: PMNode; pos: number; inner: number } | null {
    let p: number;
    try { p = this.view.posAtDOM(el, 0); } catch { return null; }
    const $p = this.view.state.doc.resolve(p);
    if (isLayoutObject($p.parent)) return { node: $p.parent, pos: $p.before(), inner: p };
    const after = $p.nodeAfter;
    if (after && isLayoutObject(after)) return { node: after, pos: p, inner: p };
    return null;
  }

  doubleClick(ev: MouseEvent): boolean {
    if (!this.active) return false;
    const target = ev.target as HTMLElement;
    const ctx = this.pageCtxFromEl(target);
    if (!ctx) return false;
    const st = layoutKey.getState(this.view.state)!;
    if (st.tool === 'pen' && this.pen) { this.finishPen(false); return true; }
    const hit = this.hitObject(ev, ctx);
    if (!hit) return false;
    // a group: its member under the pointer
    let obj = hit;
    if (hit.node.type.name === 'ol_group') {
      const el = (target.closest('.ol-obj') as HTMLElement | null);
      const own = el ? this.objectOfDom(el) : null;
      if (own) obj = { node: own.node, pos: own.pos };
    }
    if (obj.node.type.name === 'ol_shape') { this.view.dispatch(selectObjects(this.view.state.tr, [hit.pos]).setMeta(layoutKey, { sel: [hit.pos], tool: 'nodes', target: obj.pos } as Meta)); return true; }
    if (obj.node.type.name === 'ol_image') { this.view.dispatch(selectObjects(this.view.state.tr, [hit.pos]).setMeta(layoutKey, { sel: [hit.pos], tool: 'crop', target: obj.pos } as Meta)); return true; }
    if (obj.node.type.name === 'ol_raw') { editRawLatex(this.view, obj.pos); return true; }
    if (obj.node.type.name === 'ol_box') {
      // the word under the pointer (ProseMirror's own double click did not see the press)
      const at = this.view.posAtCoords({ left: ev.clientX, top: ev.clientY });
      if (at && at.pos > obj.pos && at.pos < obj.pos + obj.node.nodeSize) {
        const $p = this.view.state.doc.resolve(at.pos);
        const text = $p.parent.textContent;
        let a = $p.parentOffset, b = $p.parentOffset;
        while (a > 0 && /\w/.test(text[a - 1])) a--;
        while (b < text.length && /\w/.test(text[b])) b++;
        const start = $p.start();
        try { this.view.dispatch(this.view.state.tr.setSelection(TextSelection.create(this.view.state.doc, start + a, start + b))); } catch { /* not plain text */ }
      } else this.view.dispatch(L.caretInto(this.view.state.tr, obj.pos));
      this.view.focus();
      return true;
    }
    return false;
  }

  wheel(_ev: WheelEvent): boolean { return false; }

  /* ---------------------------------------------------------------- gestures */

  private runGesture(ev: PointerEvent, g: Gesture): void {
    this.gesture?.cancel();
    this.gesture = g;
    const id = ev.pointerId;
    const move = (e: PointerEvent) => { if (e.pointerId === id) g.move(e); };
    const up = (e: PointerEvent) => { if (e.pointerId !== id) return; stop(); g.up(e); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); stop(); g.cancel(); } };
    const stop = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      window.removeEventListener('keydown', key, true);
      if (this.gesture === g) this.gesture = null;
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    window.addEventListener('keydown', key, true);
  }

  /*
   * Live previews: a gesture changes only the attributes of the objects it touches (and a new
   * object may be inserted while it is drawn). Each step reverts the previous one and applies the
   * new state without history; the commit reverts and applies the result as one undoable step.
   */
  private liveOrig: PMNode | null = null;
  private liveTouched: number[] = [];
  private liveInserted: { pos: number; size: number } | null = null;

  private beginLive(positions: number[]): void {
    const doc = this.view.state.doc;
    this.liveOrig = doc;
    const all: number[] = [];
    const add = (pos: number) => { const n = doc.nodeAt(pos); if (!n) return; all.push(pos); if (n.type.name === 'ol_group') n.forEach((_c, off) => add(pos + 1 + off)); };
    for (const p of positions) add(p);
    this.liveTouched = all;
    this.liveInserted = null;
  }

  private revertInto(tr: Transaction): void {
    if (this.liveInserted) { tr.delete(this.liveInserted.pos, this.liveInserted.pos + this.liveInserted.size); this.liveInserted = null; }
    const orig = this.liveOrig;
    if (!orig) return;
    for (const pos of this.liveTouched) {
      const o = orig.nodeAt(pos), c = tr.doc.nodeAt(pos);
      if (o && c && c.type === o.type && c.attrs !== o.attrs) tr.setNodeMarkup(pos, undefined, o.attrs);
    }
  }

  private liveApply(fn: (tr: Transaction) => void): void {
    const tr = this.view.state.tr;
    const was = this.view.state.selection;
    try { this.revertInto(tr); fn(tr); } catch (e) { console.warn('layout: preview failed', e); return; }
    if (!tr.docChanged) return;
    this.keepNodeSelection(tr, was);
    this.view.dispatch(tr.setMeta('addToHistory', false));
  }

  /** attribute changes re-create leaf objects: a node selection of one is put back where it was */
  private keepNodeSelection(tr: Transaction, was: EditorState['selection']): void {
    if (!(was instanceof NodeSelection)) return;
    try { if (isLayoutObject(tr.doc.nodeAt(was.from))) tr.setSelection(NodeSelection.create(tr.doc, was.from)); } catch { /* gone */ }
  }

  /** end a gesture: back to where it started (no history), then `fn` as one undoable step */
  private commit(fn: (tr: Transaction) => void, select?: (tr: Transaction) => number[] | null): void {
    const back = this.view.state.tr;
    const was = this.view.state.selection;
    this.revertInto(back);
    this.keepNodeSelection(back, was);
    if (back.docChanged) this.view.dispatch(back.setMeta('addToHistory', false));
    this.liveOrig = null;
    const tr = this.view.state.tr;
    fn(tr);
    const sel = select?.(tr);
    if (sel) selectObjects(tr, sel);
    if (tr.docChanged || sel) this.view.dispatch(tr);
  }

  /** commit what the preview shows: the touched objects' final attributes */
  private commitTouched(meta?: Meta): void {
    const cur = this.view.state.doc;
    const finals = this.liveTouched.map(pos => ({ pos, attrs: cur.nodeAt(pos)?.attrs }));
    const sel = layoutKey.getState(this.view.state)!.sel;
    this.commit(tr => { for (const f of finals) if (f.attrs && tr.doc.nodeAt(f.pos)) tr.setNodeMarkup(f.pos, undefined, f.attrs); }, () => sel);
    if (meta) this.view.dispatch(this.view.state.tr.setMeta(layoutKey, meta));
  }

  private cancelLive(): void {
    const tr = this.view.state.tr;
    this.revertInto(tr);
    this.liveOrig = null;
    if (tr.docChanged) this.view.dispatch(tr.setMeta('addToHistory', false));
    else this.renderOverlays();
  }

  /** snapping candidates of a page: its edges and centre, the other objects' edges and centres */
  private snapLines(ctx: PageCtx, exclude: Set<number>): { xs: number[]; ys: number[] } {
    const xs = [0, this.page.w / 2, this.page.w], ys = [0, this.page.h / 2, this.page.h];
    for (const o of pageObjects(ctx.node, ctx.pos)) {
      if (exclude.has(o.pos)) continue;
      const b = objectBounds(o.node);
      xs.push(b.x, b.x + b.w / 2, b.x + b.w);
      ys.push(b.y, b.y + b.h / 2, b.y + b.h);
    }
    return { xs, ys };
  }

  private snap(values: number[], lines: number[], tol: number): { d: number; at?: number } {
    let best: { d: number; at?: number } = { d: 0 }, bestAbs = tol;
    for (const v of values) for (const l of lines) { const d = l - v; if (Math.abs(d) < bestAbs) { bestAbs = Math.abs(d); best = { d, at: l }; } }
    return best;
  }

  private startMove(ev: PointerEvent, ctx: PageCtx, positions: number[], clickToEdit: number | null): void {
    const original = this.view.state.doc;
    const start = ctx.mm(ev);
    const objs = positions.map(pos => ({ pos, node: original.nodeAt(pos)! })).filter(o => o.node && !o.node.attrs.lock);
    const bounds = unionBounds(objs.map(o => objectBounds(o.node)));
    if (!bounds) return;
    const lines = this.snapLines(ctx, new Set(positions));
    let moved = false, dx = 0, dy = 0, copied = false;
    const x0 = ev.clientX, y0 = ev.clientY;
    this.beginLive(objs.map(o => o.pos));
    this.runGesture(ev, {
      move: (e) => {
        if (!moved && Math.hypot(e.clientX - x0, e.clientY - y0) < 3) return;
        moved = true;
        const [mx, my] = ctx.mm(e);
        dx = mx - start[0]; dy = my - start[1];
        if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
        this.guides = [];
        if (!e.altKey) {
          const tol = 6 * ctx.mmPerPx;
          const sx = this.snap([bounds.x + dx, bounds.x + bounds.w / 2 + dx, bounds.x + bounds.w + dx], lines.xs, tol);
          const sy = this.snap([bounds.y + dy, bounds.y + bounds.h / 2 + dy, bounds.y + bounds.h + dy], lines.ys, tol);
          if (!(e.shiftKey && dx === 0)) { dx += sx.d; if (sx.at !== undefined) this.guides.push({ x: sx.at, page: ctx.pos }); }
          if (!(e.shiftKey && dy === 0)) { dy += sy.d; if (sy.at !== undefined) this.guides.push({ y: sy.at, page: ctx.pos }); }
        }
        copied = e.ctrlKey || e.metaKey;
        const ddx = dx, ddy = dy;
        this.liveApply(tr => { for (const o of objs) L.translate(tr, o.pos, ddx, ddy); });
      },
      up: (e) => {
        this.guides = [];
        if (!moved) {
          this.liveOrig = null;
          this.renderOverlays();
          if (clickToEdit !== null) {
            // a click on a selected text box: the caret goes where it was clicked
            const at = this.view.posAtCoords({ left: e.clientX, top: e.clientY });
            const box = this.view.state.doc.nodeAt(clickToEdit);
            let done = false;
            if (box && at && at.pos > clickToEdit && at.pos < clickToEdit + box.nodeSize) {
              try { this.view.dispatch(this.view.state.tr.setSelection(TextSelection.near(this.view.state.doc.resolve(at.pos)))); done = true; } catch { /* fall back */ }
            }
            if (!done) this.view.dispatch(L.caretInto(this.view.state.tr, clickToEdit));
            this.view.focus();
          }
          return;
        }
        const ddx = dx, ddy = dy;
        // dropped on another page: the objects move there
        const target = this.pageCtxAtPoint(e.clientX, e.clientY);
        if (target && target.pos !== ctx.pos && !copied) {
          const [mx, my] = target.mm(e);
          const [sx, sy] = start;
          let made: number[] = [];
          this.commit(tr => {
            for (const o of [...objs].sort((a, b) => b.pos - a.pos)) tr.delete(o.pos, o.pos + o.node.nodeSize);
            const tpos = tr.mapping.map(target.pos);
            const tpage = tr.doc.nodeAt(tpos)!;
            let at = tpos + tpage.nodeSize - 1;
            if (tpage.lastChild?.type.name === 'ol_notes') at -= tpage.lastChild.nodeSize;
            let p = at;
            for (const o of objs) { tr.insert(p, o.node); L.translate(tr, p, mx - sx, my - sy); made.push(p); p += o.node.nodeSize; }
          }, () => made);
          return;
        }
        if (copied) {
          let made: number[] = [];
          this.commit(tr => {
            const steps: { pos: number; step: number }[] = [];
            for (const o of objs) {
              const page = L.pageAt(tr.doc, tr.mapping.map(o.pos))!;
              let at = page.pos + page.node.nodeSize - 1;
              if (page.node.lastChild?.type.name === 'ol_notes') at -= page.node.lastChild.nodeSize;
              tr.insert(at, o.node);
              L.translate(tr, at, ddx, ddy);
              steps.push({ pos: at, step: tr.steps.length });
            }
            made = steps.map(m => tr.mapping.slice(m.step).map(m.pos));
          }, () => made);
          return;
        }
        this.commitTouched();
      },
      cancel: () => { this.guides = []; this.cancelLive(); },
    });
  }

  private startResize(ev: PointerEvent, h: string, pos: number | null): void {
    if (ev.button !== 0) return;
    ev.preventDefault(); ev.stopPropagation();
    const st = layoutKey.getState(this.view.state)!;
    const positions = pos !== null ? [pos] : st.sel;
    const ctx = this.pageCtxAt(positions[0] ?? -1);
    if (!ctx) return;
    const original = this.view.state.doc;
    const objs = positions.map(p => ({ pos: p, node: original.nodeAt(p)! })).filter(o => o.node);
    if (!objs.length) return;
    const [dxh, dyh] = HANDLE_DIRS[h];
    const single = objs.length === 1 && objs[0].node.type.name !== 'ol_group';
    const b0: Box = single ? boxOf(objs[0].node) : { ...unionBounds(objs.map(o => objectBounds(o.node)))!, rot: 0 };
    const keepAspectDefault = !single || objs[0].node.type.name === 'ol_image';
    const lines = this.snapLines(ctx, new Set(positions));
    const cx0 = b0.x + b0.w / 2, cy0 = b0.y + b0.h / 2;
    // the fixed point: the opposite handle
    const anchorPage = rotatePoint(cx0 - dxh * b0.w / 2, cy0 - dyh * b0.h / 2, cx0, cy0, b0.rot);
    const start = ctx.mm(ev);
    const editing = L.editedBox(this.view.state);
    const selBefore = this.view.state.selection;
    this.beginLive(objs.map(o => o.pos));
    this.runGesture(ev, {
      move: (e) => {
        const [mx, my] = ctx.mm(e);
        // pointer delta in the box's frame
        const [lx, ly] = rotatePoint(mx - start[0], my - start[1], 0, 0, -b0.rot);
        let w = dxh ? b0.w + dxh * lx * (e.altKey ? 2 : 1) : b0.w;
        let hh = dyh ? b0.h + dyh * ly * (e.altKey ? 2 : 1) : b0.h;
        const keep = dxh !== 0 && dyh !== 0 && keepAspectDefault !== e.shiftKey;
        if (keep) { const sc = Math.max(w / b0.w, hh / b0.h); w = b0.w * sc; hh = b0.h * sc; }
        w = Math.max(1, w); hh = Math.max(1, hh);
        let nb: Box;
        if (e.altKey) nb = { x: cx0 - w / 2, y: cy0 - hh / 2, w, h: hh, rot: b0.rot };
        else {
          const [rx, ry] = rotatePoint(-dxh * w / 2, -dyh * hh / 2, 0, 0, b0.rot);
          const ncx = anchorPage[0] - rx, ncy = anchorPage[1] - ry;
          nb = { x: ncx - w / 2, y: ncy - hh / 2, w, h: hh, rot: b0.rot };
        }
        // the moving edges of an unrotated box snap
        this.guides = [];
        if (!b0.rot && !e.altKey && !keep) {
          const tol = 6 * ctx.mmPerPx;
          if (dxh) { const edge = dxh > 0 ? nb.x + nb.w : nb.x; const sn = this.snap([edge], lines.xs, tol); if (sn.at !== undefined) { if (dxh > 0) nb.w += sn.d; else { nb.x += sn.d; nb.w -= sn.d; } this.guides.push({ x: sn.at, page: ctx.pos }); } }
          if (dyh) { const edge = dyh > 0 ? nb.y + nb.h : nb.y; const sn = this.snap([edge], lines.ys, tol); if (sn.at !== undefined) { if (dyh > 0) nb.h += sn.d; else { nb.y += sn.d; nb.h -= sn.d; } this.guides.push({ y: sn.at, page: ctx.pos }); } }
        }
        this.liveApply(tr => this.applyResize(tr, objs, single, b0, nb, dyh !== 0));
      },
      up: () => {
        this.guides = [];
        this.commitTouched();
        if (editing) {
          // keep editing where the caret was
          try { this.view.dispatch(this.view.state.tr.setSelection(TextSelection.create(this.view.state.doc, selBefore.anchor, selBefore.head))); } catch { /* ignore */ }
        }
      },
      cancel: () => { this.guides = []; this.cancelLive(); },
    });
  }

  private applyResize(tr: Transaction, objs: { pos: number; node: PMNode }[], single: boolean, b0: Box, nb: Box, heightChanged: boolean): void {
    if (single) {
      const o = objs[0];
      const patch: Record<string, unknown> = { x: L.r3(nb.x), y: L.r3(nb.y), w: L.r3(nb.w), h: L.r3(nb.h) };
      if (o.node.type.name === 'ol_box' && heightChanged) patch.grow = false;
      L.setAttrs(tr, o.pos, patch);
      return;
    }
    for (const o of objs) L.scaleInto(tr, o.pos, b0, nb);
  }

  private startRotate(ev: PointerEvent, pos: number | null): void {
    if (ev.button !== 0) return;
    ev.preventDefault(); ev.stopPropagation();
    const st = layoutKey.getState(this.view.state)!;
    const positions = pos !== null ? [pos] : st.sel;
    const ctx = this.pageCtxAt(positions[0] ?? -1);
    if (!ctx) return;
    const original = this.view.state.doc;
    const objs = positions.map(p => ({ pos: p, node: original.nodeAt(p)! })).filter(o => o.node);
    if (!objs.length) return;
    const u = unionBounds(objs.map(o => objectBounds(o.node)))!;
    const single = objs.length === 1 && objs[0].node.type.name !== 'ol_group';
    const b = single ? boxOf(objs[0].node) : { ...u, rot: 0 };
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const [sx, sy] = ctx.mm(ev);
    const a0 = Math.atan2(sy - cy, sx - cx);
    this.beginLive(objs.map(o => o.pos));
    this.runGesture(ev, {
      move: (e) => {
        const [mx, my] = ctx.mm(e);
        let d = -(Math.atan2(my - cy, mx - cx) - a0) * 180 / Math.PI;   // TikZ: counter-clockwise
        if (e.shiftKey) d = Math.round((b.rot + d) / 15) * 15 - b.rot;
        const dd = d;
        this.liveApply(tr => {
          if (single) { L.setAttrs(tr, objs[0].pos, { rot: L.normDeg(b.rot + dd) }); return; }
          const turn = (p: number, node: PMNode) => {
            if (node.type.name === 'ol_group') { node.forEach((c, off) => turn(p + 1 + off, c)); return; }
            const ob = boxOf(node);
            const [nx, ny] = rotatePoint(ob.x + ob.w / 2, ob.y + ob.h / 2, cx, cy, dd);
            L.setAttrs(tr, p, { x: L.r3(nx - ob.w / 2), y: L.r3(ny - ob.h / 2), rot: L.normDeg(ob.rot + dd) });
          };
          for (const o of objs) turn(o.pos, original.nodeAt(o.pos)!);
        });
      },
      up: () => this.commitTouched(),
      cancel: () => this.cancelLive(),
    });
  }

  private startMarquee(ev: PointerEvent, ctx: PageCtx): void {
    const [x0, y0] = ctx.mm(ev);
    const additive = ev.shiftKey;
    const before = layoutKey.getState(this.view.state)!.sel;
    if (!additive) this.view.dispatch(selectObjects(this.view.state.tr, []));
    // leave text editing (the caret would stay in a box otherwise)
    this.runGesture(ev, {
      move: (e) => {
        const [x, y] = ctx.mm(e);
        this.marquee = { page: ctx.pos, x: Math.min(x0, x), y: Math.min(y0, y), w: Math.abs(x - x0), h: Math.abs(y - y0) };
        this.renderOverlays();
      },
      up: () => {
        const m = this.marquee;
        this.marquee = null;
        if (!m || m.w < 0.5 && m.h < 0.5) {
          // a plain click on the page: leave text editing
          const s = this.view.state.selection;
          if (!(s instanceof NodeSelection) && L.editedBox(this.view.state)) this.view.dispatch(selectObjects(this.view.state.tr, []));
          this.renderOverlays();
          return;
        }
        const inside = pageObjects(ctx.node, ctx.pos).filter(o => {
          if (o.node.attrs.lock) return false;
          const b = objectBounds(o.node);
          return b.x >= m.x && b.y >= m.y && b.x + b.w <= m.x + m.w && b.y + b.h <= m.y + m.h;
        }).map(o => o.pos);
        this.view.dispatch(selectObjects(this.view.state.tr, additive ? [...new Set([...before, ...inside])] : inside));
      },
      cancel: () => { this.marquee = null; this.renderOverlays(); },
    });
  }

  /* ---------------------------------------------------------------- creating objects */

  private startCreate(ev: PointerEvent, ctx: PageCtx, tool: Tool): void {
    const [x0, y0] = ctx.mm(ev);
    const st = layoutKey.getState(this.view.state)!;
    const lines = this.snapLines(ctx, new Set());
    const tol = 6 * ctx.mmPerPx;
    const snapPt = (x: number, y: number, e: PointerEvent): [number, number] => {
      if (e.altKey) return [x, y];
      const sx = this.snap([x], lines.xs, tol), sy = this.snap([y], lines.ys, tol);
      return [x + sx.d, y + sy.d];
    };
    const [ax, ay] = snapPt(x0, y0, ev);
    let cur: [number, number] = [ax, ay];
    let dragged = false;
    const isLine = tool === 'line' || tool === 'arrow';
    const nodeFor = (x1: number, y1: number, e: PointerEvent | null): PMNode => {
      let bx = x1, by = y1;
      if (e?.shiftKey) {
        if (isLine) { const ang = Math.round(Math.atan2(by - ay, bx - ax) / (Math.PI / 4)) * (Math.PI / 4); const len = Math.hypot(bx - ax, by - ay); bx = ax + len * Math.cos(ang); by = ay + len * Math.sin(ang); }
        else { const sq = Math.max(Math.abs(bx - ax), Math.abs(by - ay)); bx = ax + Math.sign(bx - ax || 1) * sq; by = ay + Math.sign(by - ay || 1) * sq; }
      }
      if (isLine) return L.shapeFromPath([{ c: 'M', p: [ax, ay] }, { c: 'L', p: [bx, by] }], { ...NEW_STYLE.line, arrows: tool === 'arrow' ? '-Stealth' : null });
      const x = Math.min(ax, bx), y = Math.min(ay, by), w = Math.max(1, Math.abs(bx - ax)), h = Math.max(1, Math.abs(by - ay));
      if (tool === 'text') return L.makeBox({ x, y, w, h, grow: false });
      return L.makeShape(st.shape, { ...NEW_STYLE.shape, x, y, w, h });
    };
    const endOfPage = (tr: Transaction) => {
      const page = tr.doc.nodeAt(ctx.pos)!;
      let at = ctx.pos + page.nodeSize - 1;
      if (page.lastChild?.type.name === 'ol_notes') at -= page.lastChild.nodeSize;
      return at;
    };
    this.beginLive([]);
    this.runGesture(ev, {
      move: (e) => {
        const [x, y] = ctx.mm(e);
        cur = snapPt(x, y, e);
        if (!dragged && Math.hypot(cur[0] - ax, cur[1] - ay) < 1) return;
        dragged = true;
        this.liveApply(tr => {
          const at = endOfPage(tr);
          const n = nodeFor(cur[0], cur[1], e);
          tr.insert(at, n);
          this.liveInserted = { pos: at, size: n.nodeSize };
        });
      },
      up: (e) => {
        let node: PMNode;
        if (dragged) node = nodeFor(cur[0], cur[1], e);
        else if (tool === 'text') node = L.makeBox({ x: ax, y: ay, w: Math.max(20, Math.min(this.page.w * 0.4, this.page.w - ax)), h: 10, grow: true });
        else if (isLine) node = nodeFor(ax + this.page.w * 0.15, ay, null);
        else { const sz = Math.min(this.page.w, this.page.h) * 0.2; node = L.makeShape(st.shape, { ...NEW_STYLE.shape, x: ax, y: ay, w: sz, h: sz }); }
        if (dragged && tool === 'text') node = node.type.create({ ...node.attrs, grow: true }, node.content);
        let created = -1;
        this.commit(tr => {
          const at = endOfPage(tr);
          tr.insert(at, node);
          created = at;
          tr.setMeta(layoutKey, { tool: 'select' } as Meta);
        }, () => (tool === 'text' ? null : [created]));
        if (tool === 'text' && created >= 0) {
          this.view.dispatch(L.caretInto(this.view.state.tr, created).setMeta(layoutKey, { sel: [], tool: 'select' } as Meta));
          this.lastLocalBox = created;
          this.queueGrow();
        }
        this.view.focus();
      },
      cancel: () => this.cancelLive(),
    });
  }

  /* ---------------------------------------------------------------- pencil */

  private startPencil(ev: PointerEvent, ctx: PageCtx): void {
    const pts: [number, number][] = [ctx.mm(ev)];
    const svg = svgEl('svg', { class: 'ol-draft', viewBox: `0 0 ${this.page.w} ${this.page.h}`, preserveAspectRatio: 'none' });
    const path = svgEl('path', { fill: 'none', stroke: '#1a73e8', 'stroke-width': String(0.35), 'vector-effect': 'non-scaling-stroke' });
    svg.append(path);
    ctx.pv.overlay.append(svg);
    this.runGesture(ev, {
      move: (e) => {
        const p = ctx.mm(e);
        const last = pts[pts.length - 1];
        if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 0.3 * ctx.mmPerPx * 3) return;
        pts.push(p);
        path.setAttribute('d', 'M ' + pts.map(q => q.map(v => v.toFixed(2)).join(' ')).join(' L '));
      },
      up: () => {
        svg.remove();
        if (pts.length < 2) return;
        const segs = smoothPath(simplify(pts, Math.max(0.25, 1.2 * ctx.mmPerPx)));
        const closed = Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 3 * ctx.mmPerPx * 3 && pts.length > 8;
        if (closed) segs.push({ c: 'Z' });
        const node = L.shapeFromPath(segs, { ...NEW_STYLE.pen });
        const r = L.insertObject(this.view.state, ctx.pos, node);
        this.view.dispatch(selectObjects(r.tr, [r.pos]));
      },
      cancel: () => svg.remove(),
    });
  }

  /* ---------------------------------------------------------------- Bézier pen */

  private penDown(ev: PointerEvent, ctx: PageCtx): void {
    const [x, y] = ctx.mm(ev);
    if (!this.pen || this.pen.page !== ctx.pos) this.pen = { page: ctx.pos, nodes: [] };
    const pen = this.pen;
    const first = pen.nodes[0];
    if (first && pen.nodes.length > 2 && Math.hypot(first.x - x, first.y - y) < 8 * ctx.mmPerPx) { this.finishPen(true); return; }
    const node: { x: number; y: number; cin?: [number, number]; cout?: [number, number] } = { x, y };
    pen.nodes.push(node);
    this.renderOverlays();
    this.runGesture(ev, {
      move: (e) => {
        const [mx, my] = ctx.mm(e);
        if (Math.hypot(mx - x, my - y) < 2 * ctx.mmPerPx) return;
        node.cout = [mx, my];
        node.cin = [2 * x - mx, 2 * y - my];
        this.renderOverlays();
      },
      up: () => this.renderOverlays(),
      cancel: () => { pen.nodes.pop(); this.renderOverlays(); },
    });
  }

  private penSegs(closed: boolean): PathSeg[] {
    const n = this.pen!.nodes;
    const segs: PathSeg[] = [{ c: 'M', p: [n[0].x, n[0].y] }];
    const seg = (a: typeof n[0], b: typeof n[0]) => {
      if (!a.cout && !b.cin) segs.push({ c: 'L', p: [b.x, b.y] });
      else { const c1 = a.cout ?? [a.x, a.y], c2 = b.cin ?? [b.x, b.y]; segs.push({ c: 'C', p: [c1[0], c1[1], c2[0], c2[1], b.x, b.y] }); }
    };
    for (let i = 1; i < n.length; i++) seg(n[i - 1], n[i]);
    if (closed) { seg(n[n.length - 1], n[0]); segs.push({ c: 'Z' }); }
    return segs;
  }

  finishPen(closed: boolean): void {
    const pen = this.pen;
    this.pen = null;
    if (!pen || pen.nodes.length < 2) { this.renderOverlays(); return; }
    this.pen = pen;
    const segs = this.penSegs(closed);
    this.pen = null;
    const node = L.shapeFromPath(segs, closed ? { ...NEW_STYLE.shape } : { ...NEW_STYLE.pen });
    const r = L.insertObject(this.view.state, pen.page, node);
    this.view.dispatch(selectObjects(r.tr, [r.pos]).setMeta(layoutKey, { sel: [r.pos], tool: 'select' } as Meta));
  }

  private penEl(): HTMLElement {
    const wrap = div('ol-draft-wrap');
    const svg = svgEl('svg', { class: 'ol-draft', viewBox: `0 0 ${this.page.w} ${this.page.h}`, preserveAspectRatio: 'none' });
    const pen = this.pen!;
    if (pen.nodes.length > 1) svg.append(svgEl('path', { d: pathToString(this.penSegs(false), 3), fill: 'none', stroke: '#1a73e8', 'stroke-width': '1.5', 'vector-effect': 'non-scaling-stroke' }));
    for (const n of pen.nodes) {
      if (n.cout) svg.append(svgEl('line', { x1: String(n.cin![0]), y1: String(n.cin![1]), x2: String(n.cout[0]), y2: String(n.cout[1]), stroke: '#1a73e8', 'stroke-width': '1', 'vector-effect': 'non-scaling-stroke' }));
    }
    wrap.append(svg);
    for (const [i, n] of pen.nodes.entries()) {
      const d = div('ol-node' + (i === 0 ? ' ol-node-first' : ''), { left: MM(n.x), top: MM(n.y) });
      wrap.append(d);
    }
    return wrap;
  }

  /* ---------------------------------------------------------------- node editing */

  private nodesEl(shape: PMNode, pos: number): HTMLElement {
    const b = boxOf(shape);
    const v = String(shape.attrs.vb).split(/\s+/).map(Number);
    const [vx, vy, vw, vh] = v.length === 4 && v.every(Number.isFinite) ? v : [0, 0, 100, 100];
    const toPage = (px: number, py: number): [number, number] => rotatePoint(b.x + (px - vx) * b.w / vw, b.y + (py - vy) * b.h / vh, b.x + b.w / 2, b.y + b.h / 2, b.rot);
    const segs = normalizePath(String(shape.attrs.d));
    const wrap = div('ol-nodes');
    const svg = svgEl('svg', { class: 'ol-draft', viewBox: `0 0 ${this.page.w} ${this.page.h}`, preserveAspectRatio: 'none' });
    wrap.append(svg);
    let prev: [number, number] | null = null;
    segs.forEach((s, si) => {
      if (s.c === 'Z') return;
      const n = s.p.length / 2;
      const end = toPage(s.p[2 * n - 2], s.p[2 * n - 1]);
      if (s.c === 'C') {
        const c1 = toPage(s.p[0], s.p[1]), c2 = toPage(s.p[2], s.p[3]);
        if (prev) svg.append(svgEl('line', { x1: String(prev[0]), y1: String(prev[1]), x2: String(c1[0]), y2: String(c1[1]), class: 'ol-ctlline' }));
        svg.append(svgEl('line', { x1: String(end[0]), y1: String(end[1]), x2: String(c2[0]), y2: String(c2[1]), class: 'ol-ctlline' }));
        for (const [pt, c] of [[0, c1], [1, c2]] as [number, [number, number]][]) {
          const h = div('ol-ctl', { left: MM(c[0]), top: MM(c[1]) });
          h.addEventListener('pointerdown', e => this.startNodeDrag(e, pos, si, pt));
          wrap.append(h);
        }
      }
      const nd = div('ol-node' + (this.nodeSel && this.nodeSel.seg === si ? ' ol-node-sel' : ''), { left: MM(end[0]), top: MM(end[1]) });
      nd.addEventListener('pointerdown', e => this.startNodeDrag(e, pos, si, n - 1));
      wrap.append(nd);
      prev = end;
    });
    // double click on the outline: a new node there
    const hitPath = svgEl('path', { d: pathToString(segs.map(s => (s.c === 'Z' ? s : { c: s.c, p: s.p.map((val, i) => (i % 2 === 0 ? toPage(val, s.p[i + 1])[0] : toPage(s.p[i - 1], val)[1])) }) as PathSeg), 3), class: 'ol-nodepath' });
    hitPath.addEventListener('dblclick', e => { e.preventDefault(); e.stopPropagation(); this.insertNodeAt(e, pos); });
    svg.append(hitPath);
    return wrap;
  }

  private startNodeDrag(ev: PointerEvent, pos: number, seg: number, pt: number): void {
    if (ev.button !== 0) return;
    ev.preventDefault(); ev.stopPropagation();
    this.nodeSel = { seg, pt };
    const ctx = this.pageCtxAt(pos);
    if (!ctx) return;
    const original = this.view.state.doc;
    const shape = original.nodeAt(pos)!;
    const b = boxOf(shape);
    const v = String(shape.attrs.vb).split(/\s+/).map(Number);
    const [vx, vy, vw, vh] = v.length === 4 && v.every(Number.isFinite) ? v : [0, 0, 100, 100];
    const toVb = (mx: number, my: number): [number, number] => {
      const [ux, uy] = rotatePoint(mx, my, b.x + b.w / 2, b.y + b.h / 2, -b.rot);
      return [vx + (ux - b.x) * vw / b.w, vy + (uy - b.y) * vh / b.h];
    };
    const segs0 = normalizePath(String(shape.attrs.d));
    const s0 = segs0[seg] as { c: string; p: number[] };
    const isEnd = pt === s0.p.length / 2 - 1;
    const [ox, oy] = [s0.p[2 * pt], s0.p[2 * pt + 1]];
    const [sx, sy] = toVb(...ctx.mm(ev));
    this.renderOverlays();
    this.beginLive([pos]);
    this.runGesture(ev, {
      move: (e) => {
        const [mx, my] = toVb(...ctx.mm(e));
        const dx = mx - sx, dy = my - sy;
        const segs = segs0.map(s => (s.c === 'Z' ? s : { c: s.c, p: [...s.p] }) as PathSeg);
        const s = segs[seg] as { c: string; p: number[] };
        s.p[2 * pt] = ox + dx; s.p[2 * pt + 1] = oy + dy;
        if (isEnd) {
          // a node carries its handles along: the incoming one (this segment's c2) and the outgoing one (the next's c1)
          if (s.c === 'C') { s.p[2] += dx; s.p[3] += dy; }
          const next = segs[seg + 1] as { c: string; p: number[] } | undefined;
          if (next && next.c === 'C') { next.p[0] += dx; next.p[1] += dy; }
          // a closed path's start node moves with its end
          const first = segs[0] as { c: string; p: number[] };
          if (segs[seg + 1]?.c === 'Z' && first.c === 'M' && Math.abs(first.p[0] - ox) < 1e-6 && Math.abs(first.p[1] - oy) < 1e-6) { first.p[0] += dx; first.p[1] += dy; }
        } else if (e.altKey === false) {
          // a smooth node: the opposite handle turns with this one
          const other = pt === 0 ? { seg: seg - 1, pt: 1 } : { seg: seg + 1, pt: 0 };
          const os = segs[other.seg] as { c: string; p: number[] } | undefined;
          const nodeSeg = pt === 0 ? segs[seg - 1] as { c: string; p: number[] } : s;
          if (os && os.c === 'C' && nodeSeg && nodeSeg.c !== 'Z') {
            const k = nodeSeg.p.length;
            const [nx, ny] = [nodeSeg.p[k - 2], nodeSeg.p[k - 1]];
            const s0p = (segs0[other.seg] as { p: number[] }).p;
            const [hx0, hy0] = [s0p[2 * other.pt], s0p[2 * other.pt + 1]];
            const [ax0, ay0] = [(segs0[seg] as { p: number[] }).p[2 * pt] - nx, (segs0[seg] as { p: number[] }).p[2 * pt + 1] - ny];
            const [bx0, by0] = [hx0 - nx, hy0 - ny];
            const colinear = Math.abs(ax0 * by0 - ay0 * bx0) < 1e-3 * Math.hypot(ax0, ay0) * Math.hypot(bx0, by0) + 1e-9 && ax0 * bx0 + ay0 * by0 < 0;
            if (colinear) {
              const len = Math.hypot(bx0, by0);
              const [ax, ay] = [s.p[2 * pt] - nx, s.p[2 * pt + 1] - ny];
              const al = Math.hypot(ax, ay) || 1;
              os.p[2 * other.pt] = nx - ax / al * len; os.p[2 * other.pt + 1] = ny - ay / al * len;
            }
          }
        }
        const d = pathToString(segs, 3);
        this.liveApply(tr => L.setAttrs(tr, pos, { d }));
      },
      up: () => {
        const cur = this.view.state.doc.nodeAt(pos);
        if (!cur || cur.attrs.d === shape.attrs.d) { this.liveOrig = null; this.renderOverlays(); return; }
        const d = String(cur.attrs.d);
        this.commit(tr => { refitShape(tr, pos, d); }, () => [pos]);
        this.view.dispatch(this.view.state.tr.setMeta(layoutKey, { tool: 'nodes', target: pos } as Meta));
      },
      cancel: () => this.cancelLive(),
    });
  }

  private insertNodeAt(ev: MouseEvent, pos: number): void {
    const ctx = this.pageCtxAt(pos);
    const shape = this.view.state.doc.nodeAt(pos);
    if (!ctx || !shape) return;
    const b = boxOf(shape);
    const v = String(shape.attrs.vb).split(/\s+/).map(Number);
    const [vx, vy, vw, vh] = v.length === 4 && v.every(Number.isFinite) ? v : [0, 0, 100, 100];
    const [mx, my] = ctx.mm(ev);
    const [ux, uy] = rotatePoint(mx, my, b.x + b.w / 2, b.y + b.h / 2, -b.rot);
    const p: [number, number] = [vx + (ux - b.x) * vw / b.w, vy + (uy - b.y) * vh / b.h];
    const segs = normalizePath(String(shape.attrs.d));
    // the segment nearest to the point, split there (de Casteljau)
    let best = { i: -1, t: 0, d: Infinity };
    let cur: [number, number] = [0, 0], start: [number, number] = [0, 0];
    segs.forEach((s, i) => {
      if (s.c === 'M') { cur = [s.p[0], s.p[1]]; start = cur; return; }
      const from = cur;
      const to: [number, number] = s.c === 'Z' ? start : [s.p[s.p.length - 2], s.p[s.p.length - 1]];
      for (let k = 0; k <= 40; k++) {
        const t = k / 40;
        const q = s.c === 'C' ? bez(from, [s.p[0], s.p[1]], [s.p[2], s.p[3]], to, t) : [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
        const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (d < best.d) best = { i, t, d };
      }
      cur = to;
    });
    if (best.i < 1) return;
    const out: PathSeg[] = [];
    cur = [0, 0]; start = [0, 0];
    segs.forEach((s, i) => {
      const from = cur;
      if (s.c === 'M') { cur = [s.p[0], s.p[1]]; start = cur; out.push(s); return; }
      const to: [number, number] = s.c === 'Z' ? start : [s.p[s.p.length - 2], s.p[s.p.length - 1]];
      if (i === best.i) {
        const t = best.t;
        if (s.c === 'C') {
          const [a, b1, c, d] = [from, [s.p[0], s.p[1]] as [number, number], [s.p[2], s.p[3]] as [number, number], to];
          const ab = lerp(a, b1, t), bc = lerp(b1, c, t), cd = lerp(c, d, t), abc = lerp(ab, bc, t), bcd = lerp(bc, cd, t), m = lerp(abc, bcd, t);
          out.push({ c: 'C', p: [ab[0], ab[1], abc[0], abc[1], m[0], m[1]] }, { c: 'C', p: [bcd[0], bcd[1], cd[0], cd[1], d[0], d[1]] });
        } else {
          const m = lerp(from, to, t);
          out.push({ c: 'L', p: [m[0], m[1]] });
          if (s.c === 'Z') out.push({ c: 'L', p: [to[0], to[1]] }, { c: 'Z' }); else out.push(s);
        }
      } else out.push(s);
      cur = to;
    });
    const tr = this.view.state.tr;
    L.setAttrs(tr, pos, { d: pathToString(out, 3) });
    this.view.dispatch(tr);
  }

  private deleteSelectedNode(pos: number): boolean {
    const shape = this.view.state.doc.nodeAt(pos);
    const ns = this.nodeSel;
    if (!shape || !ns) return false;
    const segs = normalizePath(String(shape.attrs.d));
    const s = segs[ns.seg];
    if (!s || s.c === 'Z' || ns.pt !== s.p.length / 2 - 1) return false;
    if (segs.filter(x => x.c !== 'Z').length <= 2) return false;
    const out = segs.slice();
    if (s.c === 'M') {
      const next = out[ns.seg + 1];
      if (!next || next.c === 'Z') return false;
      out.splice(ns.seg, 2, { c: 'M', p: [next.p[next.p.length - 2], next.p[next.p.length - 1]] });
    } else {
      const next = out[ns.seg + 1];
      if (next && next.c === 'C' && s.c === 'C') out.splice(ns.seg, 2, { c: 'C', p: [s.p[0], s.p[1], next.p[2], next.p[3], next.p[4], next.p[5]] });
      else out.splice(ns.seg, 1);
    }
    this.nodeSel = null;
    const tr = this.view.state.tr;
    refitShape(tr, pos, pathToString(out, 3));
    this.view.dispatch(tr);
    return true;
  }

  /** C in the node editor: the selected node becomes smooth (handles in line) or a corner (no handles) */
  private toggleNodeSmooth(pos: number): boolean {
    const shape = this.view.state.doc.nodeAt(pos);
    const ns = this.nodeSel;
    if (!shape || !ns) return false;
    const segs = normalizePath(String(shape.attrs.d)).map(s => (s.c === 'Z' ? s : { c: s.c, p: [...s.p] }) as PathSeg);
    const s = segs[ns.seg] as { c: string; p: number[] };
    if (!s || s.c === 'Z') return false;
    const k = s.p.length;
    const node: [number, number] = [s.p[k - 2], s.p[k - 1]];
    const prevNode = (i: number): [number, number] => { for (let j = i - 1; j >= 0; j--) { const q = segs[j] as { c: string; p: number[] }; if (q.c !== 'Z') return [q.p[q.p.length - 2], q.p[q.p.length - 1]]; } return node; };
    const next = segs[ns.seg + 1] as { c: string; p: number[] } | undefined;
    const hasHandles = s.c === 'C' && (Math.hypot(s.p[2] - node[0], s.p[3] - node[1]) > 1e-3) || (next?.c === 'C' && Math.hypot(next.p[0] - node[0], next.p[1] - node[1]) > 1e-3);
    if (hasHandles) {
      if (s.c === 'C') { s.p[2] = node[0]; s.p[3] = node[1]; }
      if (next?.c === 'C') { next.p[0] = node[0]; next.p[1] = node[1]; }
    } else {
      const a = prevNode(ns.seg);
      const b: [number, number] = next && next.c !== 'Z' ? [next.p[next.p.length - 2], next.p[next.p.length - 1]] : node;
      const dir = [b[0] - a[0], b[1] - a[1]];
      const len = Math.hypot(dir[0], dir[1]) || 1;
      const la = Math.hypot(node[0] - a[0], node[1] - a[1]) / 3, lb = Math.hypot(b[0] - node[0], b[1] - node[1]) / 3;
      const u = [dir[0] / len, dir[1] / len];
      const segIndex = ns.seg;
      if (s.c !== 'M') segs[segIndex] = { c: 'C', p: [s.c === 'C' ? s.p[0] : a[0] + (node[0] - a[0]) / 3, s.c === 'C' ? s.p[1] : a[1] + (node[1] - a[1]) / 3, node[0] - u[0] * la, node[1] - u[1] * la, node[0], node[1]] };
      if (next && next.c !== 'Z') {
        const nk = next.p.length;
        segs[segIndex + 1] = { c: 'C', p: [node[0] + u[0] * lb, node[1] + u[1] * lb, next.c === 'C' ? next.p[2] : next.p[nk - 2] - (next.p[nk - 2] - node[0]) / 3, next.c === 'C' ? next.p[3] : next.p[nk - 1] - (next.p[nk - 1] - node[1]) / 3, next.p[nk - 2], next.p[nk - 1]] };
      }
    }
    const tr = this.view.state.tr;
    L.setAttrs(tr, pos, { d: pathToString(segs, 3) });
    this.view.dispatch(tr);
    return true;
  }

  /* ---------------------------------------------------------------- cropping */

  private cropEl(img: PMNode, pos: number): HTMLElement {
    const b = boxOf(img);
    const a = img.attrs;
    const cl = Number(a.cl) || 0, ct = Number(a.ct) || 0, cr = Number(a.cr) || 0, cb = Number(a.cb) || 0;
    const fw = b.w / Math.max(0.01, 1 - cl - cr), fh = b.h / Math.max(0.01, 1 - ct - cb);
    // the whole picture, dimmed, around the frame (in the frame's rotated coordinates)
    const frame = div('ol-cropframe', { left: MM(b.x), top: MM(b.y), width: MM(b.w), height: MM(b.h), transform: b.rot ? `rotate(${-b.rot}deg)` : '' });
    const ghost = div('ol-cropghost', { left: MM(-cl * fw), top: MM(-ct * fh), width: MM(fw), height: MM(fh) });
    const src = (this.view.nodeDOM(pos) as HTMLElement | null)?.querySelector('img')?.src;
    if (src) { const im = document.createElement('img'); im.src = src; im.draggable = false; ghost.append(im); }
    ghost.addEventListener('pointerdown', e => this.startCropPan(e, pos));
    frame.append(ghost, div('ol-cropwindow'));
    for (const h of Object.keys(HANDLE_DIRS)) {
      const el = div('ol-h ol-crop-h ol-h-' + h);
      el.addEventListener('pointerdown', e => this.startCropEdge(e, pos, h));
      frame.append(el);
    }
    return frame;
  }

  private startCropEdge(ev: PointerEvent, pos: number, h: string): void {
    if (ev.button !== 0) return;
    ev.preventDefault(); ev.stopPropagation();
    const ctx = this.pageCtxAt(pos);
    if (!ctx) return;
    const original = this.view.state.doc;
    const img = original.nodeAt(pos)!;
    const b = boxOf(img);
    const a = img.attrs;
    const c0 = { l: Number(a.cl) || 0, t: Number(a.ct) || 0, r: Number(a.cr) || 0, b: Number(a.cb) || 0 };
    const fw = b.w / Math.max(0.01, 1 - c0.l - c0.r), fh = b.h / Math.max(0.01, 1 - c0.t - c0.b);
    const [dxh, dyh] = HANDLE_DIRS[h];
    const start = ctx.mm(ev);
    this.beginLive([pos]);
    this.runGesture(ev, {
      move: (e) => {
        const [mx, my] = ctx.mm(e);
        const [lx, ly] = rotatePoint(mx - start[0], my - start[1], 0, 0, -b.rot);
        const c = { ...c0 };
        if (dxh < 0) c.l = clamp(c0.l + lx / fw, 0, 1 - c0.r - 0.02);
        if (dxh > 0) c.r = clamp(c0.r - lx / fw, 0, 1 - c0.l - 0.02);
        if (dyh < 0) c.t = clamp(c0.t + ly / fh, 0, 1 - c0.b - 0.02);
        if (dyh > 0) c.b = clamp(c0.b - ly / fh, 0, 1 - c0.t - 0.02);
        // the picture stays put: the frame is the part left visible
        const nw = fw * (1 - c.l - c.r), nh = fh * (1 - c.t - c.b);
        const lx0 = (c.l - c0.l) * fw, ty0 = (c.t - c0.t) * fh;
        const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
        const ncxL = -b.w / 2 + lx0 + nw / 2, ncyL = -b.h / 2 + ty0 + nh / 2;
        const [ox, oy] = rotatePoint(ncxL, ncyL, 0, 0, b.rot);
        const x = cx + ox - nw / 2, y = cy + oy - nh / 2;
        this.liveApply(tr => L.setAttrs(tr, pos, { cl: r4(c.l), ct: r4(c.t), cr: r4(c.r), cb: r4(c.b), x: L.r3(x), y: L.r3(y), w: L.r3(nw), h: L.r3(nh) }));
      },
      up: () => this.commitTouched({ tool: 'crop', target: pos }),
      cancel: () => this.cancelLive(),
    });
  }

  private startCropPan(ev: PointerEvent, pos: number): void {
    if (ev.button !== 0) return;
    ev.preventDefault(); ev.stopPropagation();
    const ctx = this.pageCtxAt(pos);
    if (!ctx) return;
    const original = this.view.state.doc;
    const img = original.nodeAt(pos)!;
    const b = boxOf(img);
    const a = img.attrs;
    const c0 = { l: Number(a.cl) || 0, t: Number(a.ct) || 0, r: Number(a.cr) || 0, b: Number(a.cb) || 0 };
    const fw = b.w / Math.max(0.01, 1 - c0.l - c0.r), fh = b.h / Math.max(0.01, 1 - c0.t - c0.b);
    const start = ctx.mm(ev);
    this.beginLive([pos]);
    this.runGesture(ev, {
      move: (e) => {
        const [mx, my] = ctx.mm(e);
        const [lx, ly] = rotatePoint(mx - start[0], my - start[1], 0, 0, -b.rot);
        // moving the picture right shows more of its left: the crop shifts the other way
        const dl = clamp(-lx / fw, -c0.l, c0.r), dt = clamp(-ly / fh, -c0.t, c0.b);
        this.liveApply(tr => L.setAttrs(tr, pos, { cl: r4(c0.l + dl), cr: r4(c0.r - dl), ct: r4(c0.t + dt), cb: r4(c0.b - dt) }));
      },
      up: () => this.commitTouched({ tool: 'crop', target: pos }),
      cancel: () => this.cancelLive(),
    });
  }

  private finishTargetTool(): void {
    this.nodeSel = null;
    this.view.dispatch(this.view.state.tr.setMeta(layoutKey, { tool: 'select', target: null } as Meta));
  }

  /* ---------------------------------------------------------------- keyboard */

  keyDown(ev: KeyboardEvent): boolean {
    if (!this.active || this.gesture) return false;
    const view = this.view;
    const st = layoutKey.getState(view.state)!;
    const mod = ev.ctrlKey || ev.metaKey;
    const sel = selectedObjects(view.state);
    const edited = L.editedBox(view.state);
    // present: F5 from the first page, Shift+F5 / Ctrl+Enter from this one (PowerPoint, Google Slides)
    if ((ev.key === 'F5' && !mod) || (mod && ev.key === 'Enter' && !ev.shiftKey && !ev.altKey)) {
      ev.preventDefault();
      startPresentation(view, { fromCurrent: ev.key !== 'F5' || ev.shiftKey });
      return true;
    }
    // the pen: Enter finishes, Esc finishes (or drops a single node)
    if (st.tool === 'pen' && this.pen) {
      if (ev.key === 'Enter') { this.finishPen(false); return true; }
      if (ev.key === 'Escape') { this.finishPen(false); return true; }
      if (ev.key === 'Backspace') { this.pen.nodes.pop(); if (!this.pen.nodes.length) this.pen = null; this.renderOverlays(); return true; }
    }
    if (st.tool === 'nodes' && st.target !== null) {
      if (ev.key === 'Delete' || ev.key === 'Backspace') { this.deleteSelectedNode(st.target); return true; }
      if (ev.key.toLowerCase() === 'c' && !mod) { this.toggleNodeSmooth(st.target); return true; }
      if (ev.key === 'Escape' || ev.key === 'Enter') { this.finishTargetTool(); return true; }
    }
    if (st.tool === 'crop' && (ev.key === 'Escape' || ev.key === 'Enter')) { this.finishTargetTool(); return true; }
    if (edited) {
      // Esc leaves the text for the box
      if (ev.key === 'Escape') { view.dispatch(selectObjects(view.state.tr, [edited.pos])); return true; }
      // Ctrl+A: the box's text (the whole document would be every page)
      if (mod && !ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === 'a') {
        view.dispatch(view.state.tr.setSelection(TextSelection.between(view.state.doc.resolve(edited.pos + 1), view.state.doc.resolve(edited.pos + edited.node.nodeSize - 1))));
        return true;
      }
      // the arrows stop at the box's edges
      if (!mod && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown' || ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) {
        const back = ev.key === 'ArrowUp' || ev.key === 'ArrowLeft';
        const $h = view.state.selection.$head;
        const first = edited.node.firstChild, last = edited.node.lastChild;
        const atStart = $h.parent === first && (ev.key === 'ArrowLeft' ? $h.parentOffset === 0 : view.endOfTextblock('up'));
        const atEnd = $h.parent === last && (ev.key === 'ArrowRight' ? $h.parentOffset === $h.parent.content.size : view.endOfTextblock('down'));
        if (back ? atStart : atEnd) return true;
      }
      return false;
    }
    if (ev.key === 'Escape') {
      if (st.tool !== 'select') { setTool(view, 'select'); return true; }
      if (sel.length) { view.dispatch(selectObjects(view.state.tr, [])); return true; }
      return false;
    }
    // tool shortcuts (Inkscape's letters) when no text is being edited
    if (!mod && !ev.altKey && ev.key.length === 1 && !sel.some(o => o.node.type.name === 'ol_box')) {
      const k = ev.key.toLowerCase();
      const tools: Record<string, [Tool, string?]> = { v: ['select'], s: ['select'], t: ['text'], r: ['shape', 'rect'], e: ['shape', 'ellipse'], l: ['line'], a: ['arrow'], b: ['pen'], p: ['pencil'], n: ['nodes'], c: ['crop'] };
      if (tools[k] && !ev.shiftKey) { setTool(view, tools[k][0], tools[k][1]); return true; }
    }
    if (!sel.length) {
      if (mod && ev.key.toLowerCase() === 'a' && !ev.shiftKey) {
        const ctx = this.currentPage();
        if (ctx) { view.dispatch(selectObjects(view.state.tr, pageObjects(ctx.node, ctx.pos).filter(o => !o.node.attrs.lock).map(o => o.pos))); return true; }
      }
      return false;
    }
    const positions = sel.map(o => o.pos);
    const k = ev.key;
    if (k === 'Delete' || k === 'Backspace') { view.dispatch(L.deleteObjects(view.state, positions).setMeta(layoutKey, { sel: [] } as Meta)); return true; }
    if (k.startsWith('Arrow')) {
      const step = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1;
      const dx = k === 'ArrowLeft' ? -step : k === 'ArrowRight' ? step : 0, dy = k === 'ArrowUp' ? -step : k === 'ArrowDown' ? step : 0;
      const tr = view.state.tr;
      for (const p of positions) L.translate(tr, p, dx, dy);
      view.dispatch(selectObjects(tr, positions));
      return true;
    }
    if (k === 'Tab') {
      const ctx = this.pageCtxAt(positions[0]);
      if (!ctx) return false;
      const list = pageObjects(ctx.node, ctx.pos);
      const i = list.findIndex(o => o.pos === positions[0]);
      const next = list[(i + (ev.shiftKey ? -1 : 1) + list.length) % list.length];
      view.dispatch(selectObjects(view.state.tr, [next.pos]));
      return true;
    }
    if (k === 'Enter' || k === 'F2') {
      const box = sel.find(o => o.node.type.name === 'ol_box');
      if (box) { view.dispatch(L.caretInto(view.state.tr, box.pos)); return true; }
      const shape = sel.find(o => o.node.type.name === 'ol_shape');
      if (shape) { view.dispatch(view.state.tr.setMeta(layoutKey, { tool: 'nodes', target: shape.pos } as Meta)); return true; }
      const raw = sel.find(o => o.node.type.name === 'ol_raw');
      if (raw) { editRawLatex(view, raw.pos); return true; }
      return true;
    }
    if (mod) {
      const key = k.toLowerCase();
      if (key === 'd') { const r = L.duplicateObjects(view.state, positions); view.dispatch(selectObjects(r.tr, r.positions)); return true; }
      if (key === 'g' && !ev.shiftKey) { const r = L.group(view.state, positions); if (r) view.dispatch(selectObjects(r.tr, [r.pos])); return true; }
      if (key === 'g' && ev.shiftKey) { const r = L.ungroup(view.state, positions); if (r) view.dispatch(selectObjects(r.tr, r.positions)); return true; }
      if (k === ']' || k === '}' || k === '[' || k === '{') {
        const up = k === ']' || k === '}';
        const r = L.reorder(view.state, positions, ev.shiftKey ? (up ? 'front' : 'back') : (up ? 'forward' : 'backward'));
        if (r) view.dispatch(selectObjects(r.tr, r.positions));
        return true;
      }
      if (key === 'a' && !ev.shiftKey) {
        const ctx = this.pageCtxAt(positions[0]);
        if (ctx) view.dispatch(selectObjects(view.state.tr, pageObjects(ctx.node, ctx.pos).filter(o => !o.node.attrs.lock).map(o => o.pos)));
        return true;
      }
      return false;
    }
    // typing into a selected text box edits it (at its end)
    if (k.length === 1 && !ev.altKey) {
      const box = sel.find(o => o.node.type.name === 'ol_box');
      if (box) { view.dispatch(L.caretInto(view.state.tr, box.pos)); return false; }
      return true;
    }
    return false;
  }

  /* ---------------------------------------------------------------- clipboard */

  clipboard(ev: ClipboardEvent, cut: boolean): boolean {
    if (!this.active) return false;
    const sel = selectedObjects(this.view.state);
    if (!sel.length || !ev.clipboardData) return false;
    const ser = DOMSerializer.fromSchema(schema);
    const wrap = document.createElement('div');
    for (const o of sel) wrap.append(ser.serializeNode(o.node));
    const slice = new Slice(Fragment.from(sel.map(o => o.node)), 0, 0);
    ev.clipboardData.setData('text/html', `<div data-pm-slice="0 0 []">${wrap.innerHTML}</div>`);
    ev.clipboardData.setData('text/plain', sel.map(o => o.node.textContent).filter(Boolean).join('\n\n') || ' ');
    void slice;
    ev.preventDefault();
    if (cut) this.view.dispatch(L.deleteObjects(this.view.state, sel.map(o => o.pos)).setMeta(layoutKey, { sel: [] } as Meta));
    return true;
  }

  /** objects pasted onto the current page (shifted when copies of them are already there) */
  paste(slice: Slice): boolean {
    if (!this.active) return false;
    const nodes: PMNode[] = [];
    slice.content.forEach(n => { if (isLayoutObject(n)) nodes.push(n); else if (n.type.name === 'ol_page') n.forEach(c => { if (isLayoutObject(c)) nodes.push(c); }); });
    if (!nodes.length) {
      // text pasted while objects are selected (not editing): a new text box with it
      const st = this.view.state.selection;
      if (st instanceof NodeSelection && isLayoutObject(st.node)) {
        const ctx = this.currentPage();
        if (!ctx) return true;
        const blocks: PMNode[] = [];
        slice.content.forEach(n => { if (n.type.name === 'paragraph') blocks.push(n); });
        if (!blocks.length && slice.content.size) blocks.push(schema.nodes.paragraph.create({ layout: 'Plain Layout' }, schema.text(slice.content.textBetween(0, slice.content.size, '\n') || ' ')));
        const box = L.makeBox({ x: this.page.w * 0.1, y: this.page.h * 0.1, w: this.page.w * 0.5, h: 10 }, blocks);
        const r = L.insertObject(this.view.state, ctx.pos, box);
        this.view.dispatch(selectObjects(r.tr, [r.pos]));
        this.lastLocalBox = r.pos; this.queueGrow();
        return true;
      }
      return false;
    }
    if (L.editedBox(this.view.state)) {
      // inside a text box, objects cannot go: paste them onto the page instead
    }
    const ctx = this.currentPage();
    if (!ctx) return true;
    const existing = new Set(pageObjects(ctx.node, ctx.pos).map(o => `${o.node.attrs.x}:${o.node.attrs.y}`));
    const shift = nodes.some(n => existing.has(`${n.attrs.x}:${n.attrs.y}`)) ? 5 : 0;
    const page = this.view.state.doc.nodeAt(ctx.pos)!;
    let at = ctx.pos + page.nodeSize - 1;
    if (page.lastChild?.type.name === 'ol_notes') at -= page.lastChild.nodeSize;
    const tr = this.view.state.tr;
    const made: number[] = [];
    let p = at;
    for (const n of nodes) { tr.insert(p, n); if (shift) L.translate(tr, p, shift, shift); made.push(p); p += n.nodeSize; }
    this.view.dispatch(selectObjects(tr, made));
    return true;
  }

  /* ---------------------------------------------------------------- growing text boxes */

  private queueGrow(): void {
    if (this.growQueued) return;
    this.growQueued = true;
    requestAnimationFrame(() => { this.growQueued = false; this.grow(); });
  }

  /** a text box with `grow` takes the height of its text (only the one edited here: collaborators measure their own) */
  private grow(): void {
    const pos = this.lastLocalBox;
    this.lastLocalBox = null;
    if (pos === null || this.gesture) return;
    const node = this.view.state.doc.nodeAt(pos);
    if (!node || node.type.name !== 'ol_box' || !node.attrs.grow) return;
    const dom = this.view.nodeDOM(pos) as HTMLElement | null;
    const content = dom?.querySelector('.ol-box-content') as HTMLElement | null;
    const pageEl = dom?.closest('.ol-page') as HTMLElement | null;
    if (!content || !pageEl) return;
    const pxPerMm = pageEl.getBoundingClientRect().width / this.page.w;
    if (!pxPerMm) return;
    // natural height of the text: measure without the box's fixed height
    const prev = dom!.style.height;
    dom!.style.height = 'auto';
    const h = content.scrollHeight / pxPerMm;
    dom!.style.height = prev;
    if (Math.abs(h - Number(node.attrs.h)) < 0.3) return;
    const tr = this.view.state.tr;
    L.setAttrs(tr, pos, { h: L.r3(Math.max(2, h)) });
    this.view.dispatch(tr.setMeta('addToHistory', false));
  }
}

/* ------------------------------------------------------------------ raw LaTeX editing */

/** Edit the source of a raw LaTeX object (rawedit.ts; the object re-renders). */
export function editRawLatex(view: EditorView, pos: number): void { openRawEditor(view, pos); }

/** After editing a path: its box becomes the path's bounds again (in the box's own frame). */
function refitShape(tr: Transaction, pos: number, d: string): void {
  const n = tr.doc.nodeAt(pos);
  if (!n) return;
  const b = boxOf(n);
  const v = String(n.attrs.vb).split(/\s+/).map(Number);
  const [vx, vy, vw, vh] = v.length === 4 && v.every(Number.isFinite) ? v : [0, 0, 100, 100];
  const segs = normalizePath(d);
  // path → the box's local millimetres
  const local = segs.map(s => (s.c === 'Z' ? s : { c: s.c, p: s.p.map((val, i) => (i % 2 === 0 ? (val - vx) * b.w / vw : (val - vy) * b.h / vh)) }) as PathSeg);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of local) if (s.c !== 'Z') for (let i = 0; i < s.p.length; i += 2) { x0 = Math.min(x0, s.p[i]); x1 = Math.max(x1, s.p[i]); y0 = Math.min(y0, s.p[i + 1]); y1 = Math.max(y1, s.p[i + 1]); }
  if (!Number.isFinite(x0)) return;
  const w = Math.max(0.5, x1 - x0), h = Math.max(0.5, y1 - y0);
  const rel = local.map(s => (s.c === 'Z' ? s : { c: s.c, p: s.p.map((val, i) => (i % 2 === 0 ? val - x0 : val - y0)) }) as PathSeg);
  // the new box's centre, in page coordinates (the old frame turned about the old centre)
  const [ncx, ncy] = rotatePoint(b.x + x0 + w / 2, b.y + y0 + h / 2, b.x + b.w / 2, b.y + b.h / 2, b.rot);
  L.setAttrs(tr, pos, { d: pathToString(rel, 3), vb: `0 0 ${L.r3(w)} ${L.r3(h)}`, x: L.r3(ncx - w / 2), y: L.r3(ncy - h / 2), w: L.r3(w), h: L.r3(h) });
}

/* ------------------------------------------------------------------ small helpers */

function div(cls: string, style: Record<string, string> = {}): HTMLElement {
  const d = document.createElement('div');
  d.className = cls;
  for (const [k, v] of Object.entries(style)) if (v) (d.style as unknown as Record<string, string>)[k] = v;
  return d;
}

function svgEl(tag: string, attrs: Record<string, string>): SVGElement {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const lerp = (a: [number, number], b: [number, number], t: number): [number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
function bez(a: [number, number], b: [number, number], c: [number, number], d: [number, number], t: number): [number, number] {
  const u = 1 - t;
  return [u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t * t * t * d[0], u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t * t * t * d[1]];
}

/** Ramer–Douglas–Peucker */
function simplify(pts: [number, number][], eps: number): [number, number][] {
  if (pts.length < 3) return pts;
  const [a, b] = [pts[0], pts[pts.length - 1]];
  let idx = -1, dmax = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const num = Math.abs((b[1] - a[1]) * p[0] - (b[0] - a[0]) * p[1] + b[0] * a[1] - b[1] * a[0]);
    const den = Math.hypot(b[1] - a[1], b[0] - a[0]) || 1;
    const d = num / den;
    if (d > dmax) { dmax = d; idx = i; }
  }
  if (dmax <= eps) return [a, b];
  return [...simplify(pts.slice(0, idx + 1), eps).slice(0, -1), ...simplify(pts.slice(idx), eps)];
}

/** Catmull–Rom through the points, as cubic Béziers */
function smoothPath(pts: [number, number][]): PathSeg[] {
  const segs: PathSeg[] = [{ c: 'M', p: [pts[0][0], pts[0][1]] }];
  if (pts.length === 2) { segs.push({ c: 'L', p: [pts[1][0], pts[1][1]] }); return segs; }
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1: [number, number] = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: [number, number] = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    segs.push({ c: 'C', p: [c1[0], c1[1], c2[0], c2[1], p2[0], p2[1]] });
  }
  return segs;
}

/** Shapes offered by the shape tool (the toolbar palette). */
export const SHAPE_TOOLS = Object.entries(SHAPE_PRESETS).filter(([k]) => k !== 'line').map(([id, p]) => ({ id, label: p.label, d: p.d }));

/** The controller of a view (the toolbars and menus act through it). */
export function layoutControllerOf(view: EditorView): { currentPage(): { pos: number; node: PMNode } | null; finishPen(closed: boolean): void; page: { w: number; h: number } } | null {
  return controllers.get(view) ?? null;
}

export { boundsOf };
