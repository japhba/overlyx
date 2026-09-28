/**
 * Node views of layout documents (see @overlyx/core layout/model.ts): a page is a fixed-size
 * sheet whose objects are absolutely positioned inside it — text boxes (their paragraphs are
 * ordinary editable ProseMirror content), vector shapes (SVG), cropped images, groups and raw
 * LaTeX (its compiled image). Sizes are CSS calc()s of `--ol-mm` / `--ol-pt` (geom.ts), so a zoom
 * is one custom property. Selection handles, guides and tools are drawn by the layout plugin in
 * each page's overlay layer (controller.ts), outside ProseMirror's content.
 */
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorView, NodeView } from 'prosemirror-view';
import { graphicsUrl } from '../../api';
import { resolveDocPath, viewDocDir, viewProject } from '../context';
import { subscribeProjectEvents } from '../../projectevents';
import { boxOf, placeElement, MM, PT, color, shapePathInBox, DASHES, ptToMm } from './geom';
import { rawPreview } from './rawpreview';

const SVGNS = 'http://www.w3.org/2000/svg';

/** Mutations of the node view's own element (drag previews change its style) are not content changes. */
function ownStyle(dom: HTMLElement, m: MutationRecord | { type: 'selection'; target: Node }): boolean {
  return m.type === 'attributes' && (m.target === dom || !(m.target as HTMLElement).closest?.('.ol-box-content'));
}

/* ------------------------------------------------------------------ page */

export class PageView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  overlay: HTMLElement;
  label: HTMLElement;

  constructor(public node: PMNode, private view: EditorView, private getPos: () => number | undefined) {
    this.dom = document.createElement('div');
    this.dom.className = 'ol-page-wrap';
    this.label = document.createElement('div');
    this.label.className = 'ol-page-label';
    this.label.contentEditable = 'false';
    this.contentDOM = document.createElement('section');
    this.contentDOM.className = 'ol-page';
    this.overlay = document.createElement('div');
    this.overlay.className = 'ol-overlay';
    this.overlay.contentEditable = 'false';
    this.dom.append(this.label, this.contentDOM, this.overlay);
    (this.dom as HTMLElement & { olPage?: PageView }).olPage = this;
    this.render();
  }

  pos(): number | undefined { return this.getPos(); }

  render(): void {
    const a = this.node.attrs;
    this.contentDOM.style.background = color(a.fill) ?? '';
    this.dom.dataset.transition = a.transition ?? '';
    const pos = this.getPos();
    let index = 0;
    if (pos !== undefined) this.view.state.doc.forEach((c, off) => { if (off < pos && c.type.name === 'ol_page') index++; });
    const name = a.name ? ` — ${a.name}` : '';
    this.label.textContent = `${index + 1}${name}`;
    this.label.title = `Page ${index + 1}${name}${a.transition ? ` · transition: ${a.transition}` : ''}`;
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }

  ignoreMutation(m: MutationRecord | { type: 'selection'; target: Node }): boolean {
    if (m.type === 'selection') return false;
    // the overlay and the label are ours; style changes of the sheet too
    const t = m.target as HTMLElement;
    return this.overlay.contains(t) || this.label.contains(t) || (m.type === 'attributes' && t === this.contentDOM);
  }

  stopEvent(e: Event): boolean { return this.overlay.contains(e.target as Node) || this.label.contains(e.target as Node); }
}

/* ------------------------------------------------------------------ text box */

export class BoxView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  frame: HTMLElement;

  constructor(public node: PMNode, private view: EditorView, private getPos: () => number | undefined) {
    this.dom = document.createElement('div');
    this.dom.className = 'ol-obj ol-box';
    this.frame = document.createElement('div');
    this.frame.className = 'ol-box-frame';
    this.frame.contentEditable = 'false';
    this.contentDOM = document.createElement('div');
    this.contentDOM.className = 'ol-box-content';
    this.dom.append(this.frame, this.contentDOM);
    this.render();
  }

  render(): void {
    const a = this.node.attrs;
    placeElement(this.dom, boxOf(this.node));
    const fill = color(a.fill), stroke = color(a.stroke);
    const lw = a.stroke ? ptToMm(a.lw ?? 0.4) : 0;
    const f = this.frame.style;
    f.background = fill ?? '';
    f.border = stroke ? `${MM(lw)} solid ${stroke}` : '';
    f.inset = stroke ? `calc(var(--ol-mm) * ${-lw / 2})` : '0';
    f.borderRadius = a.shape === 'ellipse' ? '50%' : a.radius ? `calc(var(--ol-mm) * ${a.radius + lw / 2})` : '';
    this.dom.classList.toggle('ol-empty-frame', !fill && !stroke);
    const c = this.contentDOM.style;
    c.padding = a.pad ? MM(a.pad) : '0';
    c.justifyContent = a.valign === 'c' ? 'center' : a.valign === 'b' ? 'flex-end' : 'flex-start';
    // the nominal size (\fontsize{25}{33.5}): the font package may load the face smaller (notomath:
    // 0.9), the baselines stay the nominal size's — a unitless line height relative to the scaled face
    c.fontSize = a.font ? `calc(var(--ol-pt) * ${a.font} * var(--ol-text-scale, 1))` : '';
    c.lineHeight = a.leading ? `calc(${a.leading} / var(--ol-text-scale, 1))` : '';
    c.color = color(a.color) ?? '';
    c.textAlign = a.align === 'justify' ? 'justify' : a.align === 'center' ? 'center' : a.align === 'right' ? 'right' : 'left';
    this.contentDOM.dataset.align = a.align ?? 'left';
    this.dom.style.opacity = a.opacity !== null && a.opacity !== undefined ? String(a.opacity) : '';
    this.dom.dataset.step = a.step ?? '';
    this.dom.classList.toggle('ol-grow', !!a.grow);
    this.dom.classList.toggle('ol-locked', !!a.lock);
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    const attrsChanged = node.attrs !== this.node.attrs;
    this.node = node;
    if (attrsChanged) this.render();
    return true;
  }

  ignoreMutation(m: MutationRecord | { type: 'selection'; target: Node }): boolean {
    if (m.type === 'selection') return false;
    return this.frame.contains(m.target) || ownStyle(this.dom, m);
  }
}

/* ------------------------------------------------------------------ shape */

let markerSeq = 0;

export class ShapeView implements NodeView {
  dom: HTMLElement;
  svg: SVGSVGElement;
  path: SVGPathElement;
  hit: SVGPathElement;

  constructor(public node: PMNode, private view: EditorView, private getPos: () => number | undefined) {
    this.dom = document.createElement('div');
    this.dom.className = 'ol-obj ol-shape';
    this.dom.contentEditable = 'false';
    this.svg = document.createElementNS(SVGNS, 'svg');
    this.svg.setAttribute('preserveAspectRatio', 'none');
    this.svg.style.overflow = 'visible';
    this.path = document.createElementNS(SVGNS, 'path');
    this.hit = document.createElementNS(SVGNS, 'path');
    this.hit.setAttribute('class', 'ol-hit');
    this.svg.append(this.path, this.hit);
    this.dom.append(this.svg);
    this.render();
  }

  render(): void {
    const a = this.node.attrs;
    const b = boxOf(this.node);
    placeElement(this.dom, b);
    this.svg.setAttribute('viewBox', `0 0 ${b.w} ${b.h}`);
    this.svg.setAttribute('width', '100%');
    this.svg.setAttribute('height', '100%');
    const d = shapePathInBox(String(a.d ?? ''), String(a.vb ?? '0 0 100 100'), b.w, b.h);
    const fill = color(a.fill), stroke = color(a.stroke);
    const lw = ptToMm(a.lw ?? 0.4);
    this.path.setAttribute('d', d);
    this.path.setAttribute('fill', fill ?? 'none');
    this.path.setAttribute('stroke', stroke ?? 'none');
    this.path.setAttribute('stroke-width', String(lw));
    this.path.setAttribute('stroke-linejoin', 'miter');
    const dash = a.dash ? DASHES[a.dash] : null;
    if (dash) this.path.setAttribute('stroke-dasharray', dash.map(v => (v === 0.4 ? lw : ptToMm(v))).join(' '));
    else this.path.removeAttribute('stroke-dasharray');
    this.arrows(a.arrows, stroke ?? '#000', lw);
    this.hit.setAttribute('d', d);
    this.hit.setAttribute('fill', fill ? 'transparent' : 'none');
    this.hit.setAttribute('stroke', 'transparent');
    this.hit.setAttribute('stroke-width', String(Math.max(lw, 2)));
    this.dom.classList.toggle('ol-invisible', !fill && !stroke);
    this.dom.style.opacity = a.opacity !== null && a.opacity !== undefined ? String(a.opacity) : '';
    this.dom.dataset.step = a.step ?? '';
  }

  /** TikZ arrow tips (->, <-, <->, -Stealth, -Latex, …) as SVG markers */
  private arrows(spec: string | null, stroke: string, lw: number): void {
    this.svg.querySelector('defs')?.remove();
    this.path.removeAttribute('marker-start');
    this.path.removeAttribute('marker-end');
    if (!spec) return;
    const m = /^(.*?)-(.*)$/.exec(spec.replace(/[{}]/g, ''));
    if (!m) return;
    const defs = document.createElementNS(SVGNS, 'defs');
    // TikZ's tips are sized from the line width: about 3pt + 4.5 × the width long, 3/4 of that wide
    const len = ptToMm(3 + 4.5 * (lw * 2.845276));
    const mk = (tip: string, start: boolean) => {
      if (!tip) return null;
      const id = `olm${++markerSeq}`;
      const marker = document.createElementNS(SVGNS, 'marker');
      marker.setAttribute('id', id);
      marker.setAttribute('viewBox', '0 0 10 7.5');
      marker.setAttribute('refX', '9.5'); marker.setAttribute('refY', '3.75');
      marker.setAttribute('markerUnits', 'userSpaceOnUse');
      marker.setAttribute('markerWidth', String(len)); marker.setAttribute('markerHeight', String(len * 0.75));
      marker.setAttribute('orient', start ? 'auto-start-reverse' : 'auto');
      const p = document.createElementNS(SVGNS, 'path');
      const open = tip === '>' || tip === '<' || /^to$/i.test(tip);
      const latex = /latex/i.test(tip);
      p.setAttribute('d', open ? 'M 1 0.6 Q 5 2.6 9.5 3.75 Q 5 4.9 1 6.9' : latex ? 'M 0 0 L 10 3.75 L 0 7.5 Z' : 'M 0 0 L 10 3.75 L 0 7.5 L 2.6 3.75 Z');
      p.setAttribute('fill', open ? 'none' : stroke);
      p.setAttribute('stroke', open ? stroke : 'none');
      p.setAttribute('stroke-width', '1');
      p.setAttribute('stroke-linecap', 'round');
      marker.append(p);
      defs.append(marker);
      return id;
    };
    const s = mk(m[1], true), e = mk(m[2], false);
    this.svg.prepend(defs);
    if (s) this.path.setAttribute('marker-start', `url(#${s})`);
    if (e) this.path.setAttribute('marker-end', `url(#${e})`);
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    if (node.attrs !== this.node.attrs) { this.node = node; this.render(); }
    this.node = node;
    return true;
  }

  ignoreMutation(): boolean { return true; }
  stopEvent(): boolean { return false; }
}

/* ------------------------------------------------------------------ image */

export class ImageView implements NodeView {
  dom: HTMLElement;
  img: HTMLImageElement;
  private version = 0;
  private unsubscribe: (() => void) | null = null;

  constructor(public node: PMNode, private view: EditorView, private getPos: () => number | undefined) {
    this.dom = document.createElement('div');
    this.dom.className = 'ol-obj ol-image';
    this.dom.contentEditable = 'false';
    this.img = document.createElement('img');
    this.img.draggable = false;
    this.img.alt = '';
    this.img.addEventListener('error', () => this.dom.classList.add('ol-missing'));
    this.img.addEventListener('load', () => this.dom.classList.remove('ol-missing'));
    this.dom.append(this.img);
    this.render();
    const project = viewProject(view);
    if (project) this.unsubscribe = subscribeProjectEvents(project, ev => {
      if (ev.kind !== 'graphics') return;
      const file = resolveDocPath(String(this.node.attrs.src ?? ''), viewDocDir(this.view));
      if (!ev.path || !file || !(ev.path === file || ev.path.startsWith(file + '.'))) return;
      this.version = ev.v ?? Date.now();
      this.render();
    });
  }

  render(): void {
    const a = this.node.attrs;
    placeElement(this.dom, boxOf(this.node));
    const cl = Number(a.cl) || 0, ct = Number(a.ct) || 0, cr = Number(a.cr) || 0, cb = Number(a.cb) || 0;
    const fw = 1 / Math.max(0.01, 1 - cl - cr), fh = 1 / Math.max(0.01, 1 - ct - cb);
    const s = this.img.style;
    s.width = `${fw * 100}%`; s.height = `${fh * 100}%`;
    s.left = `${-cl * fw * 100}%`; s.top = `${-ct * fh * 100}%`;
    const project = viewProject(this.view);
    const file = String(a.src ?? '');
    this.dom.title = file;
    this.dom.dataset.file = file;
    if (project && file) {
      const url = graphicsUrl(project, resolveDocPath(file, viewDocDir(this.view)), 2000) + (this.version ? `&v=${this.version}` : '');
      if (this.img.dataset.src !== url) { this.img.dataset.src = url; this.img.src = url; }
    }
    this.dom.style.opacity = a.opacity !== null && a.opacity !== undefined ? String(a.opacity) : '';
    this.dom.dataset.step = a.step ?? '';
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    if (node.attrs !== this.node.attrs) { this.node = node; this.render(); }
    this.node = node;
    return true;
  }

  ignoreMutation(): boolean { return true; }
  destroy(): void { this.unsubscribe?.(); }
}

/* ------------------------------------------------------------------ group */

export class GroupView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  constructor(public node: PMNode) {
    this.dom = document.createElement('div');
    this.dom.className = 'ol-group';
    this.contentDOM = this.dom;
    this.dom.dataset.step = node.attrs.step ?? '';
  }
  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.dom.dataset.step = node.attrs.step ?? '';
    return true;
  }
  ignoreMutation(m: MutationRecord | { type: 'selection'; target: Node }): boolean {
    return m.type === 'attributes' && m.target === this.dom;
  }
}

/* ------------------------------------------------------------------ raw LaTeX */

export class RawView implements NodeView {
  dom: HTMLElement;
  private img: HTMLImageElement;
  private code: HTMLElement;
  private seq = 0;

  constructor(public node: PMNode, private view: EditorView, private getPos: () => number | undefined) {
    this.dom = document.createElement('div');
    this.dom.contentEditable = 'false';
    this.img = document.createElement('img');
    this.img.draggable = false;
    this.img.alt = '';
    this.code = document.createElement('pre');
    this.code.className = 'ol-raw-code';
    this.dom.append(this.img, this.code);
    this.render();
  }

  render(): void {
    const a = this.node.attrs;
    const placed = a.placed !== false;
    this.dom.className = placed ? 'ol-obj ol-raw' : 'ol-raw-unplaced';
    this.code.textContent = String(a.latex ?? '');
    this.dom.title = placed ? 'Raw LaTeX — double-click to edit' : 'LaTeX on this page that is no object:\n' + String(a.latex ?? '');
    if (!placed) return;
    placeElement(this.dom, boxOf(this.node));
    this.dom.dataset.step = a.step ?? '';
    const seq = ++this.seq;
    const b = boxOf(this.node);
    this.dom.classList.add('ol-pending');
    void rawPreview(this.view, String(a.latex ?? ''), b.w, b.h).then(url => {
      if (seq !== this.seq) return;
      this.dom.classList.remove('ol-pending');
      if (url) { this.img.src = url; this.dom.classList.add('ol-rendered'); }
      else this.dom.classList.remove('ol-rendered');
    });
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    const old = this.node.attrs;
    this.node = node;
    if (old.latex !== node.attrs.latex || old.w !== node.attrs.w || old.h !== node.attrs.h || old.placed !== node.attrs.placed) this.render();
    else if (old !== node.attrs) { placeElement(this.dom, boxOf(node)); this.dom.dataset.step = node.attrs.step ?? ''; }
    return true;
  }

  ignoreMutation(): boolean { return true; }
}

export const LAYOUT_NODE_VIEWS = {
  ol_page: (node: PMNode, view: EditorView, getPos: () => number | undefined) => new PageView(node, view, getPos),
  ol_box: (node: PMNode, view: EditorView, getPos: () => number | undefined) => new BoxView(node, view, getPos),
  ol_shape: (node: PMNode, view: EditorView, getPos: () => number | undefined) => new ShapeView(node, view, getPos),
  ol_image: (node: PMNode, view: EditorView, getPos: () => number | undefined) => new ImageView(node, view, getPos),
  ol_group: (node: PMNode) => new GroupView(node),
  ol_raw: (node: PMNode, view: EditorView, getPos: () => number | undefined) => new RawView(node, view, getPos),
};
