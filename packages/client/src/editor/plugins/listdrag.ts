/**
 * List items move by drag and drop, with their sub-items (Notion / Google Docs / Workflowy): a grip
 * left of the bullet — shown while the pointer is over the item, and after a finger or a pen put the
 * caret into it (no hover there) — is pressed and dragged; a line shows where the item will land,
 * and how far right the pointer has gone sets how deep it nests (within what the place allows:
 * listmove.ts depthRange). Esc cancels, near the top or the bottom the view scrolls along, the
 * drop is one undo step (and, with change tracking on, a tracked deletion and insertion, as LyX
 * records a move). A click on the grip without a drag selects the item and its sub-items.
 *
 * Works wherever list paragraphs are — the document, insets (notes, footnotes, the margin), table
 * cells, layout boxes, markdown documents: an item moves among the paragraphs of its own container.
 * The grip, the line and the carried copy live outside the editor's DOM (position: fixed), so
 * ProseMirror never sees them.
 */
import { Plugin, PluginKey, TextSelection, type EditorState } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { listUnitAt, depthRange, clampDepth, moveUnit, layoutAt, childPos, canDropAt, type ListUnit, type ListPlace } from '../listmove';

export const listDragKey = new PluginKey('lyx-list-drag');

const LIST_CLASSES = ['lyx-layout-itemize', 'lyx-layout-enumerate', 'lyx-layout-description', 'lyx-layout-labeling', 'lyx-layout-list'];
const isListPar = (el: Element): boolean => el.classList.contains('lyx-par') && LIST_CLASSES.some(c => el.classList.contains(c));

const GRIP_SVG = '<svg viewBox="0 0 10 16" width="10" height="16" aria-hidden="true"><g fill="currentColor"><circle cx="3" cy="3" r="1.4"/><circle cx="7" cy="3" r="1.4"/><circle cx="3" cy="8" r="1.4"/><circle cx="7" cy="8" r="1.4"/><circle cx="3" cy="13" r="1.4"/><circle cx="7" cy="13" r="1.4"/></g></svg>';

type Rect = { left: number; right: number; top: number; bottom: number };

function scrollParent(el: HTMLElement): HTMLElement {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && p.scrollHeight > p.clientHeight) return p;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}
const boxOf = (sp: HTMLElement): Rect => (sp === document.scrollingElement || sp === document.documentElement
  ? { left: 0, right: window.innerWidth, top: 0, bottom: window.innerHeight }
  : sp.getBoundingClientRect());

/** CSS px of the element → screen px (a scaled layout page) */
const scaleOf = (el: HTMLElement, r: DOMRect): number => (el.offsetWidth ? r.width / el.offsetWidth : 1) || 1;

interface Gap { gap: number; y: number }

class Drag {
  started = false;
  place: ListPlace | null = null;
  gaps: Gap[] = [];
  /** the screen px one depth step indents, and where depth 0 starts (left) and the items end (right) */
  indent = 24; base = 0; right = 0;
  last: { x: number; y: number };
  line: HTMLElement | null = null;
  ghost: HTMLElement | null = null;
  veil: HTMLElement | null = null;
  scroller: HTMLElement;
  raf = 0;
  scrollTop = -1;
  constructor(public u: ListUnit, public item: PMNode, public pointerId: number, public x0: number, public y0: number, view: EditorView) {
    this.last = { x: x0, y: y0 };
    this.scroller = scrollParent(view.dom);
  }
}

class ListDragView {
  private grip: HTMLElement | null = null;
  /** the list paragraph the grip is shown for */
  private target: HTMLElement | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | undefined;
  /** the last press in the editor was a finger's or a pen's: the grip follows the caret */
  private touchy = false;
  private drag: Drag | null = null;
  /** a placement waiting for the next frame (a keystroke does not lay out the page twice) */
  private pending: 'caret' | 'place' | null = null;
  private frame = 0;

  constructor(private view: EditorView) {
    view.dom.addEventListener('mousemove', this.onMove);
    view.dom.addEventListener('mouseleave', this.onLeave);
    view.dom.addEventListener('pointerdown', this.onViewDown, true);
    view.dom.addEventListener('blur', this.onBlur);
    window.addEventListener('scroll', this.onScroll, true);
    window.addEventListener('resize', this.onScroll);
  }

  update(view: EditorView, prev: EditorState): void {
    if (this.drag) { if (view.state.doc !== prev.doc) this.refind(); return; }
    if (!view.editable) { this.hide(); return; }
    if (this.touchy) this.later('caret');
    else if (this.target) this.later('place');
  }

  private later(what: 'caret' | 'place'): void {
    if (this.pending !== 'caret') this.pending = what;
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const w = this.pending;
      this.pending = null;
      if (this.drag) return;
      if (w === 'caret') this.showForCaret();
      else if (this.target?.isConnected) this.placeGrip();
      else this.hide();
    });
  }

  destroy(): void {
    const dom = this.view.dom;
    dom.removeEventListener('mousemove', this.onMove);
    dom.removeEventListener('mouseleave', this.onLeave);
    dom.removeEventListener('pointerdown', this.onViewDown, true);
    dom.removeEventListener('blur', this.onBlur);
    window.removeEventListener('scroll', this.onScroll, true);
    window.removeEventListener('resize', this.onScroll);
    this.endDrag(false);
    clearTimeout(this.hideTimer);
    cancelAnimationFrame(this.frame);
    this.grip?.remove();
    this.grip = null;
  }

  /* ------------------------------------------------------------ the grip */

  /** the list item paragraph of this editor an element is in (the innermost one) */
  private listParOf(t: EventTarget | null): HTMLElement | null {
    let el = (t as Element | null)?.closest?.('.lyx-par') as HTMLElement | null;
    while (el && !isListPar(el)) el = el.parentElement?.closest('.lyx-par') as HTMLElement | null;
    return el && el.closest('.ProseMirror') === this.view.dom ? el : null;
  }

  private onMove = (ev: MouseEvent) => {
    if (this.drag || ev.buttons || !this.view.editable) return;
    this.touchy = false;
    const el = this.listParOf(ev.target);
    if (!el) { if (this.target) this.scheduleHide(); return; }
    clearTimeout(this.hideTimer);
    if (el !== this.target || this.grip?.style.display === 'none') this.show(el);
  };
  private onLeave = (ev: MouseEvent) => {
    if (this.drag || this.touchy) return;
    if (ev.relatedTarget && this.grip?.contains(ev.relatedTarget as Node)) return;
    this.scheduleHide();
  };
  private onViewDown = (ev: PointerEvent) => {
    this.touchy = ev.pointerType === 'touch' || ev.pointerType === 'pen';
    if (!this.touchy) return;
    // the caret lands after this press: the grip goes to its item then
    setTimeout(() => { if (this.touchy && !this.drag) this.showForCaret(); }, 0);
  };
  private onBlur = () => { if (this.touchy && !this.drag) setTimeout(() => { if (!this.view.hasFocus() && !this.drag) this.hide(); }, 0); };
  private onScroll = () => { if (!this.drag && this.target && this.grip?.style.display !== 'none') this.placeGrip(); };

  private scheduleHide(): void {
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => { if (!this.drag) this.hide(); }, 350);
  }

  private hide(): void {
    clearTimeout(this.hideTimer);
    this.target = null;
    if (this.grip) this.grip.style.display = 'none';
  }

  private showForCaret(): void {
    const view = this.view;
    if (!view.editable || !view.hasFocus()) { this.hide(); return; }
    const u = listUnitAt(view.state.doc, view.state.selection.from);
    const el = u ? view.nodeDOM(childPos(u, u.from)) : null;
    if (el instanceof HTMLElement && isListPar(el)) this.show(el); else this.hide();
  }

  private show(el: HTMLElement): void {
    this.target = el;
    if (!this.grip) this.grip = this.makeGrip();
    this.grip.style.display = '';
    this.placeGrip();
  }

  private makeGrip(): HTMLElement {
    const g = document.createElement('div');
    g.className = 'lyx-list-grip';
    g.setAttribute('role', 'button');
    g.setAttribute('aria-label', 'Move this list item');
    g.setAttribute('data-list-grip', '');
    g.title = 'Drag to move the item with its sub-items (right: nest it deeper) — Alt+↑ / Alt+↓ move it too';
    g.innerHTML = GRIP_SVG;
    g.addEventListener('pointerdown', this.onGripDown);
    g.addEventListener('pointermove', this.onDragMove);
    g.addEventListener('pointerup', this.onDragUp);
    g.addEventListener('pointercancel', this.onDragCancel);
    g.addEventListener('lostpointercapture', this.onDragCancel);
    // the editor keeps the focus (and a finger neither scrolls nor brings up the text callout)
    g.addEventListener('mousedown', e => e.preventDefault());
    g.addEventListener('touchstart', e => e.preventDefault(), { passive: false });
    g.addEventListener('mouseenter', () => clearTimeout(this.hideTimer));
    g.addEventListener('mouseleave', ev => { if (!this.drag && !this.touchy && !(ev.relatedTarget && this.view.dom.contains(ev.relatedTarget as Node))) this.scheduleHide(); });
    g.addEventListener('contextmenu', e => e.preventDefault());
    document.body.appendChild(g);
    return g;
  }

  /** the grip left of the bullet (left of the fold arrow, when the item has one), at the middle of the first line */
  private placeGrip(): void {
    const el = this.target, g = this.grip;
    if (!el || !g) return;
    const r = el.getBoundingClientRect();
    if (!r.height) { g.style.display = 'none'; return; }
    const cs = getComputedStyle(el);
    const k = scaleOf(el, r);
    const fs = parseFloat(cs.fontSize) * k;
    const toggle = el.querySelector(':scope > .lyx-fold-toggle') as HTMLElement | null;
    const tr = toggle?.getBoundingClientRect();
    const right = tr && tr.width ? tr.left - 1 : (el.classList.contains('lyx-layout-itemize') ? r.left + 1.2 * fs : r.left) - 2;
    const cy = r.top + parseFloat(cs.paddingTop) * k + 0.725 * fs;
    const box = boxOf(scrollParent(this.view.dom));
    const w = g.offsetWidth || 16, h = g.offsetHeight || 24;
    if (cy < box.top || cy > box.bottom) { g.style.visibility = 'hidden'; return; }
    g.style.visibility = '';
    g.style.left = `${Math.max(2, right - w)}px`;
    g.style.top = `${cy - h / 2}px`;
  }

  /* ------------------------------------------------------------ dragging */

  private onGripDown = (ev: PointerEvent) => {
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    const view = this.view, el = this.target;
    if (!el || !view.editable || this.drag) return;
    let pos: number;
    try { pos = view.posAtDOM(el, 0); } catch { return; }
    const u = listUnitAt(view.state.doc, pos);
    if (!u) return;
    this.drag = new Drag(u, u.parent.child(u.from), ev.pointerId, ev.clientX, ev.clientY, view);
    try { this.grip!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
  };

  private onDragMove = (ev: PointerEvent) => {
    const d = this.drag;
    if (!d || ev.pointerId !== d.pointerId) return;
    d.last = { x: ev.clientX, y: ev.clientY };
    if (!d.started) {
      if (Math.hypot(ev.clientX - d.x0, ev.clientY - d.y0) < 4) return;
      this.begin(d);
    }
    this.track(d);
  };

  private onDragUp = (ev: PointerEvent) => {
    const d = this.drag;
    if (!d || ev.pointerId !== d.pointerId) return;
    if (!d.started) {
      // a click: the item and its sub-items selected (for a finger, nothing: a selection would bring up the keyboard)
      this.endDrag(false);
      if (ev.pointerType === 'mouse') this.selectUnit(d.u);
      return;
    }
    d.last = { x: ev.clientX, y: ev.clientY };
    this.track(d);
    this.endDrag(true);
  };

  private onDragCancel = (ev: Event) => {
    const d = this.drag;
    if (!d || (ev as PointerEvent).pointerId !== d.pointerId) return;
    this.endDrag(false);
  };

  private onKey = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape' || !this.drag) return;
    ev.preventDefault();
    ev.stopPropagation();
    this.endDrag(false);
  };

  private selectUnit(u: ListUnit): void {
    const view = this.view;
    const from = childPos(u, u.from) + 1, to = childPos(u, u.to) - 1;
    try { view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to))); } catch { return; }
    view.focus();
  }

  private begin(d: Drag): void {
    d.started = true;
    this.grip?.classList.add('dragging');
    document.documentElement.classList.add('lyx-list-dragging');
    window.addEventListener('keydown', this.onKey, true);
    const itemEl = this.view.nodeDOM(childPos(d.u, d.u.from)) as HTMLElement | null;
    if (itemEl instanceof HTMLElement) {
      const r = itemEl.getBoundingClientRect();
      const k = scaleOf(itemEl, r);
      d.indent = this.indentOf(d.u, itemEl, k);
      d.base = r.left - d.u.depth * d.indent;
      d.right = r.right;
      d.ghost = this.makeGhost(d, itemEl, r);
    }
    d.line = document.createElement('div');
    d.line.className = 'lyx-list-drop';
    d.veil = document.createElement('div');
    d.veil.className = 'lyx-list-src';
    document.body.append(d.veil, d.line);
    this.measure(d);
    const loop = () => { if (this.drag !== d) return; this.autoscroll(d); d.raf = requestAnimationFrame(loop); };
    d.raf = requestAnimationFrame(loop);
  }

  /** screen px per depth step: the item's own indent, else another nested paragraph's, else 2em */
  private indentOf(u: ListUnit, itemEl: HTMLElement, k: number): number {
    const per = (el: HTMLElement, depth: number) => (depth > 0 ? parseFloat(getComputedStyle(el).marginLeft) / depth : 0);
    let px = per(itemEl, u.depth);
    if (!(px > 0)) {
      let p = u.start;
      for (let i = 0; i < u.parent.childCount && !(px > 0); i++) {
        const n = u.parent.child(i);
        const depth = Number(n.attrs.depth) || 0;
        if (depth > 0 && n.type.name === 'paragraph') {
          const el = this.view.nodeDOM(p);
          if (el instanceof HTMLElement && isListPar(el)) px = per(el, depth);
        }
        p += n.nodeSize;
      }
    }
    if (!(px > 0)) px = 2 * parseFloat(getComputedStyle(itemEl).fontSize);
    return px * k;
  }

  /** the item carried under the pointer: a copy of its paragraphs (the first few) */
  private makeGhost(d: Drag, itemEl: HTMLElement, r: DOMRect): HTMLElement {
    const g = document.createElement('div');
    g.className = 'lyx-list-ghost';
    g.setAttribute('aria-hidden', 'true');
    const cs = getComputedStyle(this.view.dom);
    g.style.fontFamily = cs.fontFamily;
    g.style.fontSize = getComputedStyle(itemEl).fontSize;
    g.style.color = cs.color;
    g.style.width = `${Math.max(120, d.right - d.base)}px`;
    let p = childPos(d.u, d.u.from);
    for (let i = d.u.from; i < d.u.to && i < d.u.from + 8; i++) {
      const el = this.view.nodeDOM(p);
      if (el instanceof HTMLElement) {
        const c = el.cloneNode(true) as HTMLElement;
        for (const x of Array.from(c.querySelectorAll('.lyx-fold-toggle, [contenteditable]'))) {
          if (x.classList.contains('lyx-fold-toggle')) x.remove(); else x.removeAttribute('contenteditable');
        }
        // nested deeper than the item by as many steps as in the list
        c.style.marginLeft = `${((Number(d.u.parent.child(i).attrs.depth) || 0) - d.u.depth) * d.indent}px`;
        g.appendChild(c);
      }
      p += d.u.parent.child(i).nodeSize;
    }
    g.dataset.dx = String(r.left - d.x0);
    document.body.appendChild(g);
    return g;
  }

  /** the gaps of the item's container a drop may go to, with their height on the screen */
  private measure(d: Drag): void {
    const { u } = d;
    const n = u.parent.childCount;
    const rects: (DOMRect | null)[] = [];
    let p = u.start;
    for (let i = 0; i < n; i++) {
      const el = this.view.nodeDOM(p);
      const r = el instanceof HTMLElement ? el.getBoundingClientRect() : null;
      rects.push(r && r.height > 0 ? r : null);
      p += u.parent.child(i).nodeSize;
    }
    const gaps: Gap[] = [];
    let prevBottom: number | null = null;
    for (let gap = 0; gap <= n; gap++) {
      const r = gap < n ? rects[gap] : null;
      if (gap < n && !r) continue;   // a folded-away paragraph follows: no place to see
      if (canDropAt(u, gap)) gaps.push({ gap, y: r ? (prevBottom !== null ? (prevBottom + r.top) / 2 : r.top - 2) : (prevBottom ?? 0) + 2 });
      if (r) prevBottom = r.bottom;
    }
    d.gaps = gaps;
    // the item and its sub-items, where they are
    const own = rects.slice(u.from, u.to).filter((r): r is DOMRect => !!r);
    if (d.veil && own.length) {
      const top = Math.min(...own.map(r => r.top)), bottom = Math.max(...own.map(r => r.bottom));
      const left = Math.min(...own.map(r => r.left)), right = Math.max(...own.map(r => r.right));
      Object.assign(d.veil.style, { left: `${left - 4}px`, top: `${top - 1}px`, width: `${right - left + 8}px`, height: `${bottom - top + 2}px` });
    }
    const itemEl = this.view.nodeDOM(childPos(u, u.from));
    if (itemEl instanceof HTMLElement) {
      const r = itemEl.getBoundingClientRect();
      if (r.width) { d.base = r.left - u.depth * d.indent; d.right = r.right; }
    }
    d.scrollTop = d.scroller.scrollTop;
  }

  /** the place under the pointer: the nearest gap; the depth from how far right of the press it is */
  private track(d: Drag): void {
    const { x, y } = d.last;
    let best: Gap | null = null;
    for (const g of d.gaps) if (!best || Math.abs(g.y - y) < Math.abs(best.y - y)) best = g;
    if (d.ghost) {
      // beside the pointer, below it: the line where it lands stays in sight
      d.ghost.style.left = `${x + Number(d.ghost.dataset.dx)}px`;
      d.ghost.style.top = `${y + 14}px`;
    }
    if (!best) { d.place = null; if (d.line) d.line.style.display = 'none'; return; }
    const want = d.u.depth + Math.round((x - d.x0) / d.indent);
    const depth = clampDepth(want, depthRange(d.u, best.gap));
    d.place = { gap: best.gap, depth };
    if (d.line) {
      const left = d.base + depth * d.indent;
      Object.assign(d.line.style, { display: '', left: `${left}px`, top: `${best.y - 1}px`, width: `${Math.max(24, d.right - left)}px` });
    }
  }

  /** near the top or the bottom of the view: it scrolls, faster the nearer */
  private autoscroll(d: Drag): void {
    const sp = d.scroller;
    const box = boxOf(sp);
    const edge = Math.min(56, (box.bottom - box.top) / 5);
    const y = d.last.y;
    let dy = 0;
    if (y < box.top + edge) dy = -Math.ceil(((box.top + edge - y) / edge) * 16);
    else if (y > box.bottom - edge) dy = Math.ceil(((y - (box.bottom - edge)) / edge) * 16);
    if (dy) sp.scrollTop += dy;
    if (sp.scrollTop !== d.scrollTop) { this.measure(d); this.track(d); }
  }

  /** a collaborator's change arrived while dragging: the item found again (the CRDT's reading keeps unchanged paragraphs' nodes), else the drag ends */
  private refind(): void {
    const d = this.drag!;
    let at = -1;
    this.view.state.doc.descendants((node, pos) => {
      if (at >= 0) return false;
      if (node === d.item) { at = pos; return false; }
      return node.type.name !== 'paragraph';
    });
    const u = at >= 0 ? listUnitAt(this.view.state.doc, at + 1) : null;
    if (!u) { this.endDrag(false); return; }
    d.u = u;
    if (d.started) { this.measure(d); this.track(d); }
  }

  private endDrag(drop: boolean): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    cancelAnimationFrame(d.raf);
    window.removeEventListener('keydown', this.onKey, true);
    document.documentElement.classList.remove('lyx-list-dragging');
    this.grip?.classList.remove('dragging');
    try { if (this.grip?.hasPointerCapture(d.pointerId)) this.grip.releasePointerCapture(d.pointerId); } catch { /* gone */ }
    d.line?.remove(); d.ghost?.remove(); d.veil?.remove();
    if (!drop || !d.started || !d.place) return;
    const view = this.view;
    const tr = moveUnit(view.state, d.u, d.place, layoutAt(d.u, d.place));
    if (tr) view.dispatch(tr);
    if (!this.touchy) this.hide();
    view.focus();
  }
}

export function listDragPlugin(): Plugin {
  return new Plugin({ key: listDragKey, view: view => new ListDragView(view) });
}
