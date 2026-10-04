/**
 * The slide sorter of decks — PowerPoint's View ▸ Slide Sorter: every slide as a card in a grid over the
 * canvas, opened from the slide rail (the grid button in its header, its menu). A click selects (Shift:
 * a range, Ctrl/⌘: one more or one less), dragging moves the selected slides, the keyboard works as in
 * PowerPoint (arrows and Shift+arrows, Ctrl+A, Delete, Ctrl+D, Ctrl+C / X / V, Ctrl+Z, Home / End, F5),
 * Enter or a double click opens a slide in the canvas, Esc or Done goes back to it. The slider sizes the
 * cards (remembered, `ol.sorter`). A card shows the slide's number and name, its transition, how many
 * clicks its animations take and whether it has speaker notes.
 *
 * The cards' thumbnails are drawn like the rail's (rail.ts drawPage) and redrawn when their page's DOM
 * changes; the canvas behind follows the focused card, so leaving the sorter (or Shift+F5) is there.
 */
import type { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { undo, redo } from 'y-prosemirror';
import { PAGE_TRANSITIONS } from '@overlyx/core';
import * as L from './commands';
import { showContextMenu, closeContextMenu, type MenuItem } from '../contextmenu';
import { MOD } from '../clipmenu';
import { startPresentation, stepCount } from './present';
import { SLIDE_LAYOUTS, insertSlide, type SlideLayout } from './slidelayouts';
import { div, button, drawPage, scaleThumb, layoutPicker, undoStep, getSlideClipboard, setSlideClipboard, pageOfMutation } from './slidekit';

export interface SorterHost {
  page(): { w: number; h: number };
  basePt(): number;
  /** show the page in the canvas behind (the rail's current slide follows) */
  show(pos: number): void;
  /** the sorter closed itself (Esc, Done, a slide opened); `pos`: the slide to show */
  closed(pos: number | null): void;
}

interface Card { el: HTMLElement; clip: HTMLElement; holder: HTMLElement | null; num: HTMLElement; name: HTMLElement; badges: HTMLElement; wrap: HTMLElement | null; pos: number; node: PMNode }

const STORE = 'ol.sorter';
const SIZES = { min: 120, max: 420, def: 216 };


/** what a slide is called on its card: its name, else the first words on it */
function slideName(node: PMNode): string {
  if (node.attrs.name) return node.attrs.name as string;
  let text = '';
  node.forEach(c => { if (!text && c.type.name === 'ol_box') text = c.textContent.trim(); });
  return text.length > 48 ? text.slice(0, 46) + '…' : text;
}

export class SlideSorter {
  readonly el: HTMLElement;
  private grid: HTMLElement;
  private info: HTMLElement;
  private drop: HTMLElement;
  private add: HTMLButtonElement;
  private slider: HTMLInputElement;
  private cards: Card[] = [];
  /** the selected slides, by their page's DOM (it stays while the page is edited) */
  private sel = new Set<HTMLElement>();
  private focusWrap: HTMLElement | null = null;
  private anchor = 0;
  private size: number;
  private dirty = new Set<HTMLElement>();
  private timer = 0;
  private mo: MutationObserver;
  private ro: ResizeObserver | null = null;
  private drag: { id: number; x: number; y: number; moved: boolean; gap: number; single: number | null; ghost: HTMLElement | null } | null = null;
  private picker: (() => void) | null = null;

  constructor(private view: EditorView, private scroller: HTMLElement, private host: SorterHost, start: number) {
    let stored = NaN;
    try { stored = Number(localStorage.getItem(STORE)); } catch { /* not remembered */ }
    this.size = stored >= SIZES.min && stored <= SIZES.max ? stored : SIZES.def;
    this.el = div('ol-sorter');
    this.el.dataset.olSorter = '';
    const head = div('ol-sorter-head');
    const title = document.createElement('span');
    title.className = 'ol-sorter-title'; title.textContent = 'Slide sorter';
    this.info = document.createElement('span');
    this.info.className = 'ol-sorter-info';
    const sizeBox = document.createElement('label');
    sizeBox.className = 'ol-sorter-size';
    sizeBox.title = 'Size of the slides';
    this.slider = document.createElement('input');
    this.slider.type = 'range';
    this.slider.min = String(SIZES.min); this.slider.max = String(SIZES.max); this.slider.step = '4';
    this.slider.value = String(this.size);
    this.slider.addEventListener('input', () => this.setSize(Number(this.slider.value)));
    sizeBox.append(this.icon('small'), this.slider, this.icon('large'));
    const present = button('ol-sorter-present', '▶ Present', 'Present from the selected slide (Shift+F5; F5 from the first)');
    present.addEventListener('click', () => this.present(true));
    const done = button('ol-sorter-done', 'Done', 'Back to the slide (Esc)');
    done.dataset.sorterDone = '';
    done.addEventListener('click', () => this.close(this.focusIndex()));
    head.append(title, this.info, sizeBox, present, done);
    this.grid = div('ol-sorter-grid');
    this.grid.tabIndex = 0;
    this.grid.setAttribute('role', 'listbox');
    this.grid.setAttribute('aria-multiselectable', 'true');
    this.grid.setAttribute('aria-label', 'Slides');
    this.drop = div('ol-sorter-drop');
    this.add = button('ol-sorter-add', '+ New slide', 'A new slide after the selected ones — choose its layout');
    this.add.dataset.sorterNew = '';
    this.add.addEventListener('click', e => { e.stopPropagation(); this.toggleLayouts(); });
    this.grid.append(this.add, this.drop);
    this.el.append(head, this.grid);
    this.setSize(this.size);

    this.grid.addEventListener('keydown', this.onKey);
    this.grid.addEventListener('pointerdown', this.onPointerDown);
    this.grid.addEventListener('dblclick', this.onDblClick);
    this.grid.addEventListener('contextmenu', this.onContextMenu);
    scroller.parentElement!.append(this.el);
    if (typeof ResizeObserver !== 'undefined') { this.ro = new ResizeObserver(() => this.place()); this.ro.observe(scroller); }
    this.mo = new MutationObserver(recs => { let any = false; for (const r of recs) { const w = pageOfMutation(r); if (w) { this.dirty.add(w); any = true; } } if (any) this.schedule(); });
    this.mo.observe(view.dom, { subtree: true, childList: true, characterData: true, attributes: true, attributeOldValue: true });
    this.place();
    this.refresh();
    this.select([start], start);
    this.grid.focus({ preventScroll: true });
    this.cards[start]?.el.scrollIntoView({ block: 'center' });
  }

  destroy(): void {
    this.mo.disconnect();
    this.ro?.disconnect();
    clearTimeout(this.timer);
    this.picker?.();
    this.endDrag();
    this.el.remove();
  }

  /** the editor's state changed (the rail passes it on): pages may have come, gone or changed */
  update(docChanged: boolean): void { if (docChanged) this.schedule(); }

  private place(): void {
    const s = this.scroller;
    Object.assign(this.el.style, { left: `${s.offsetLeft}px`, top: `${s.offsetTop}px`, width: `${s.offsetWidth}px`, height: `${s.clientHeight}px` });
  }

  private icon(kind: 'small' | 'large'): HTMLElement {
    const i = document.createElement('span');
    i.className = 'ol-sorter-size-icon ' + kind;
    i.setAttribute('aria-hidden', 'true');
    return i;
  }

  private setSize(px: number): void {
    this.size = px;
    const pg = this.host.page();
    this.el.style.setProperty('--card-w', `${px}px`);
    this.el.style.setProperty('--card-h', `${px * pg.h / pg.w}px`);
    for (const c of this.cards) scaleThumb(c.clip, c.holder, px, this.host.page());
    try { localStorage.setItem(STORE, String(px)); } catch { /* not remembered */ }
  }

  /* ---------------------------------------------------------------- cards */

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.refresh(), 250);
  }

  /** the cards in page order, each with a fresh copy where its page is new or changed */
  private refresh(): void {
    if (this.view.isDestroyed) return;
    clearTimeout(this.timer);
    const list = L.pages(this.view.state.doc);
    const byWrap = new Map(this.cards.filter(c => c.wrap).map(c => [c.wrap!, c]));
    const next: Card[] = [];
    for (const p of list) {
      const wrap = this.view.nodeDOM(p.pos) as HTMLElement | null;
      let c = wrap ? byWrap.get(wrap) : undefined;
      if (c) byWrap.delete(wrap!);
      else c = this.makeCard();
      const fresh = c.wrap !== wrap || (wrap && this.dirty.has(wrap));
      c.wrap = wrap; c.pos = p.pos; c.node = p.node;
      if (fresh && wrap) {
        c.holder = drawPage(this.view, wrap, this.host.page());
        scaleThumb(c.clip, c.holder, this.size, this.host.page());
        c.clip.replaceChildren(...(c.holder ? [c.holder] : []));
      }
      next.push(c);
    }
    for (const c of this.cards) if (!next.includes(c)) c.el.remove();
    next.forEach((c, i) => {
      if (this.grid.children[i] !== c.el) this.grid.insertBefore(c.el, this.grid.children[i] ?? this.add);
      c.el.dataset.index = String(i);
      c.num.textContent = String(i + 1);
      c.name.textContent = slideName(c.node);
      const t = c.node.attrs.transition as string | null, steps = stepCount(c.node), notes = c.node.lastChild?.type.name === 'ol_notes';
      const badges: string[] = [];
      if (t) badges.push(`<span class="b" title="Transition: ${t}">✦ ${t}</span>`);
      if (steps > 1) badges.push(`<span class="b" title="Its objects appear over ${steps} clicks">${steps} clicks</span>`);
      if (notes) badges.push('<span class="b" title="Has speaker notes">notes</span>');
      c.badges.innerHTML = badges.join('');
    });
    this.cards = next;
    this.dirty.clear();
    // a selected or focused slide that is gone (deleted, or replaced by a collaborator's move) drops out
    for (const w of [...this.sel]) if (!next.some(c => c.wrap === w)) this.sel.delete(w);
    if (this.focusWrap && !next.some(c => c.wrap === this.focusWrap)) this.focusWrap = null;
    this.paint();
  }

  private makeCard(): Card {
    const el = div('ol-sorter-card');
    el.setAttribute('role', 'option');
    const thumb = div('ol-sorter-thumb');
    const clip = div('ol-sorter-clip');
    thumb.append(clip);
    const meta = div('ol-sorter-meta');
    const num = document.createElement('span'); num.className = 'ol-sorter-num';
    const name = document.createElement('span'); name.className = 'ol-sorter-name';
    const badges = document.createElement('span'); badges.className = 'ol-sorter-badges';
    meta.append(num, name, badges);
    el.append(thumb, meta);
    return { el, clip, holder: null, num, name, badges, wrap: null, pos: 0, node: null as unknown as PMNode };
  }

  /* ---------------------------------------------------------------- selection */

  private indices(): number[] { return this.cards.map((c, i) => (c.wrap && this.sel.has(c.wrap) ? i : -1)).filter(i => i >= 0); }
  private focusIndex(): number { const i = this.cards.findIndex(c => c.wrap === this.focusWrap); return i >= 0 ? i : (this.indices()[0] ?? 0); }

  /** select these slides; `focus` gets the keyboard focus (and the canvas behind shows it) */
  private select(indices: number[], focus: number): void {
    this.sel = new Set(indices.map(i => this.cards[i]?.wrap).filter((w): w is HTMLElement => !!w));
    const f = this.cards[Math.max(0, Math.min(this.cards.length - 1, focus))];
    this.focusWrap = f?.wrap ?? null;
    this.paint();
    if (f) { f.el.scrollIntoView({ block: 'nearest' }); this.host.show(f.pos); }
  }

  private paint(): void {
    this.cards.forEach(c => {
      const on = !!c.wrap && this.sel.has(c.wrap);
      c.el.classList.toggle('selected', on);
      c.el.classList.toggle('focused', !!c.wrap && c.wrap === this.focusWrap);
      c.el.setAttribute('aria-selected', String(on));
    });
    const n = this.sel.size;
    this.info.textContent = `${this.cards.length} slide${this.cards.length === 1 ? '' : 's'}${n > 1 ? ` · ${n} selected` : ''}`;
  }

  /** the number of cards in a row of the grid */
  private columns(): number {
    const top = this.cards[0]?.el.offsetTop;
    let n = 0;
    for (const c of this.cards) { if (c.el.offsetTop !== top) break; n++; }
    return Math.max(1, n);
  }

  /* ---------------------------------------------------------------- commands */

  private apply(f: () => { first: number; count: number } | null): void {
    const r = f();
    this.refresh();
    if (r) this.select(Array.from({ length: r.count }, (_, k) => r.first + k), r.first + r.count - 1);
  }

  private positions(): number[] { return this.indices().map(i => this.cards[i].pos); }
  private nodes(): PMNode[] { return this.indices().map(i => this.cards[i].node); }

  private remove(): void {
    const at = this.indices()[0] ?? 0;
    const tr = L.deletePages(this.view.state, this.positions());
    if (!tr) return;
    undoStep(this.view);
    this.view.dispatch(tr);
    this.refresh();
    const i = Math.min(at, this.cards.length - 1);
    this.select([i], i);
  }

  private duplicate(): void {
    const idx = this.indices();
    if (!idx.length) return;
    this.apply(() => {
      const { tr, first } = L.insertPagesAfter(this.view.state, this.cards[idx[idx.length - 1]].pos, this.nodes());
      undoStep(this.view);
      this.view.dispatch(tr);
      return { first, count: idx.length };
    });
  }

  private copy(cut: boolean): void {
    if (!this.sel.size) return;
    setSlideClipboard(this.nodes());
    if (cut) this.remove();
  }

  private paste(): void {
    const nodes = getSlideClipboard();
    if (!nodes.length) return;
    const idx = this.indices();
    const after = idx.length ? this.cards[idx[idx.length - 1]].pos : null;
    this.apply(() => {
      const { tr, first } = L.insertPagesAfter(this.view.state, after, nodes);
      undoStep(this.view);
      this.view.dispatch(tr);
      return { first, count: nodes.length };
    });
  }

  private move(gap: number): void {
    const count = this.sel.size;
    const r = L.movePagesTo(this.view.state, this.positions(), gap);
    if (!r) return;
    this.apply(() => { undoStep(this.view); this.view.dispatch(r.tr); return { first: r.first, count }; });
  }

  newSlide(layout: SlideLayout): void {
    const idx = this.indices();
    const after = idx.length ? this.cards[idx[idx.length - 1]].pos : null;
    const { tr } = insertSlide(this.view.state, after, layout, this.host.page(), this.host.basePt());
    const first = idx.length ? idx[idx.length - 1] + 1 : this.cards.length;
    this.apply(() => { undoStep(this.view); this.view.dispatch(tr); return { first, count: 1 }; });
  }

  private setTransition(t: string): void {
    const tr = this.view.state.tr;
    for (const pos of this.positions()) L.setAttrs(tr, pos, { transition: t || null });
    undoStep(this.view);
    this.view.dispatch(tr);
    this.refresh();
  }

  private present(fromSelected: boolean): void {
    const f = this.cards[this.focusIndex()];
    this.close(fromSelected && f ? this.focusIndex() : null);
    startPresentation(this.view, { fromCurrent: fromSelected });
  }

  /** leave the sorter: the canvas shows slide `index` */
  private close(index: number | null): void {
    closeContextMenu();
    this.host.closed(index === null ? null : this.cards[index]?.pos ?? null);
  }

  private toggleLayouts(): void {
    if (this.picker) { this.picker(); return; }
    this.picker = layoutPicker(this.el, this.add, l => this.newSlide(l), () => { this.picker = null; this.grid.focus({ preventScroll: true }); });
  }

  private menu(): MenuItem[] {
    const n = this.sel.size, total = this.cards.length, what = n > 1 ? `${n} slides` : 'slide';
    const ts = new Set(this.indices().map(i => (this.cards[i].node.attrs.transition as string | null) ?? ''));
    return [
      { label: 'Open in the canvas', shortcut: 'Enter', action: () => this.close(this.focusIndex()) },
      { label: 'New slide', sub: SLIDE_LAYOUTS.map(l => ({ label: l.label, action: () => this.newSlide(l.id) })) },
      { label: `Duplicate ${what}`, shortcut: `${MOD}+D`, action: () => this.duplicate() },
      { label: `Delete ${what}`, shortcut: 'Del', icon: 'delete', disabled: n >= total, action: () => this.remove() },
      { sep: true },
      { label: 'Cut', shortcut: `${MOD}+X`, icon: 'cut', disabled: n >= total, action: () => this.copy(true) },
      { label: 'Copy', shortcut: `${MOD}+C`, icon: 'copy', action: () => this.copy(false) },
      { label: 'Paste after', shortcut: `${MOD}+V`, icon: 'paste', disabled: !getSlideClipboard().length, action: () => this.paste() },
      { sep: true },
      { label: 'Transition', sub: ['', ...PAGE_TRANSITIONS].map(t => ({ label: t || 'None', checked: ts.size === 1 && ts.has(t), action: () => this.setTransition(t) })) },
      { sep: true },
      { label: 'Present from this slide', shortcut: 'Shift+F5', action: () => this.present(true) },
    ];
  }

  /* ---------------------------------------------------------------- pointer */

  private cardAt(target: EventTarget | null): number {
    const el = (target as HTMLElement | null)?.closest?.('.ol-sorter-card') as HTMLElement | null;
    return el ? this.cards.findIndex(c => c.el === el) : -1;
  }

  private onPointerDown = (e: PointerEvent): void => {
    const i = this.cardAt(e.target);
    if (e.button !== 0) return;
    if (i < 0) {
      // a click on the grid around the cards: nothing selected
      if (e.target === this.grid) this.select([], this.focusIndex());
      return;
    }
    e.preventDefault();
    this.grid.focus({ preventScroll: true });
    const wrap = this.cards[i].wrap;
    let single: number | null = null;
    if (e.ctrlKey || e.metaKey) {
      const idx = new Set(this.indices());
      if (wrap && this.sel.has(wrap)) idx.delete(i); else idx.add(i);
      this.anchor = i;
      this.select([...idx], i);
    } else if (e.shiftKey) {
      const [a, b] = this.anchor < i ? [this.anchor, i] : [i, this.anchor];
      this.select(Array.from({ length: b - a + 1 }, (_, k) => a + k), i);
    } else if (!wrap || !this.sel.has(wrap)) {
      this.anchor = i;
      this.select([i], i);
    } else single = i;   // a press on a selected slide: dragging moves them all, a click keeps only it
    if (!wrap || !this.sel.has(wrap)) return;
    this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, gap: -1, single, ghost: null };
    this.grid.setPointerCapture(e.pointerId);
    this.grid.addEventListener('pointermove', this.onPointerMove);
    this.grid.addEventListener('pointerup', this.onPointerUp);
    this.grid.addEventListener('pointercancel', this.onPointerUp);
  };

  private onPointerMove = (e: PointerEvent): void => {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) return;
    if (!d.moved) {
      d.moved = true;
      this.el.classList.add('dragging');
      for (const i of this.indices()) this.cards[i].el.classList.add('dragging');
      d.ghost = div('ol-sorter-ghost');
      d.ghost.textContent = this.sel.size > 1 ? `${this.sel.size} slides` : `Slide ${this.focusIndex() + 1}`;
      this.el.append(d.ghost);
    }
    const base = this.el.getBoundingClientRect();
    d.ghost!.style.left = `${e.clientX - base.left + 14}px`;
    d.ghost!.style.top = `${e.clientY - base.top + 10}px`;
    const g = this.gapAt(e.clientX, e.clientY);
    d.gap = g.gap;
    this.showDrop(g);
    const gr = this.grid.getBoundingClientRect();
    if (e.clientY < gr.top + 40) this.grid.scrollTop -= 14;
    else if (e.clientY > gr.bottom - 40) this.grid.scrollTop += 14;
  };

  private onPointerUp = (e: PointerEvent): void => {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    this.endDrag();
    if (e.type === 'pointercancel') return;
    if (d.moved) { if (d.gap >= 0) this.move(d.gap); }
    else if (d.single !== null) { this.anchor = d.single; this.select([d.single], d.single); }
  };

  private endDrag(): void {
    if (!this.drag) return;
    this.drag.ghost?.remove();
    this.drag = null;
    this.grid.removeEventListener('pointermove', this.onPointerMove);
    this.grid.removeEventListener('pointerup', this.onPointerUp);
    this.grid.removeEventListener('pointercancel', this.onPointerUp);
    this.el.classList.remove('dragging');
    for (const c of this.cards) c.el.classList.remove('dragging');
    this.drop.style.display = 'none';
  }

  /** the gap before card `gap` the pointer is at: in its row, before the first card whose middle is right of it */
  private gapAt(x: number, y: number): { gap: number; after: boolean } {
    const rects = this.cards.map(c => c.el.getBoundingClientRect());
    if (!rects.length) return { gap: 0, after: false };
    const rows: [number, number][] = [];
    let start = 0;
    for (let i = 1; i <= rects.length; i++) if (i === rects.length || Math.abs(rects[i].top - rects[start].top) > 2) { rows.push([start, i]); start = i; }
    const row = rows.find(([, end]) => y < rects[end - 1].bottom + 14) ?? rows[rows.length - 1];
    for (let i = row[0]; i < row[1]; i++) if (x < rects[i].left + rects[i].width / 2) return { gap: i, after: false };
    return { gap: row[1], after: true };
  }

  private showDrop(g: { gap: number; after: boolean }): void {
    const idx = this.indices();
    // dropping the selection where it already is moves nothing
    const noop = idx.length > 0 && idx.every((v, k) => v === idx[0] + k) && g.gap >= idx[0] && g.gap <= idx[idx.length - 1] + 1;
    const ref = g.after ? this.cards[g.gap - 1]?.el : this.cards[g.gap]?.el;
    if (noop || !ref) { this.drop.style.display = 'none'; return; }
    const gapPx = parseFloat(getComputedStyle(this.grid).columnGap) || 24;
    const x = g.after ? ref.offsetLeft + ref.offsetWidth + gapPx / 2 : ref.offsetLeft - gapPx / 2;
    Object.assign(this.drop.style, { display: 'block', left: `${x - 2}px`, top: `${ref.offsetTop}px`, height: `${ref.offsetHeight}px` });
  }

  private onDblClick = (e: MouseEvent): void => {
    const i = this.cardAt(e.target);
    if (i >= 0) this.close(i);
  };

  private onContextMenu = (e: MouseEvent): void => {
    const i = this.cardAt(e.target);
    if (i < 0) return;
    e.preventDefault();
    const w = this.cards[i].wrap;
    if (!w || !this.sel.has(w)) { this.anchor = i; this.select([i], i); }
    showContextMenu(e.clientX, e.clientY, this.menu());
  };

  /* ---------------------------------------------------------------- keys */

  private onKey = (e: KeyboardEvent): void => {
    const mod = e.ctrlKey || e.metaKey, k = e.key, n = this.cards.length;
    const f = this.focusIndex(), cols = this.columns();
    const to = (i: number) => {
      i = Math.max(0, Math.min(n - 1, i));
      if (e.shiftKey) { const [a, b] = this.anchor < i ? [this.anchor, i] : [i, this.anchor]; this.select(Array.from({ length: b - a + 1 }, (_, j) => a + j), i); }
      else { this.anchor = i; this.select([i], i); }
    };
    let done = true;
    if (k === 'ArrowRight') to(f + 1);
    else if (k === 'ArrowLeft') to(f - 1);
    else if (k === 'ArrowDown') to(f + cols);
    else if (k === 'ArrowUp') to(f - cols);
    else if (k === 'Home') to(0);
    else if (k === 'End') to(n - 1);
    else if (mod && k.toLowerCase() === 'a') this.select(this.cards.map((_, i) => i), f);
    else if (k === 'Enter' && !mod) this.close(f);
    else if (k === 'Escape') this.close(f);
    else if (k === 'Delete' || k === 'Backspace') this.remove();
    else if (mod && k.toLowerCase() === 'd') this.duplicate();
    else if (mod && k.toLowerCase() === 'c') this.copy(false);
    else if (mod && k.toLowerCase() === 'x') this.copy(true);
    else if (mod && k.toLowerCase() === 'v') this.paste();
    else if (mod && k.toLowerCase() === 'z' && !e.shiftKey) { undoStep(this.view); undo(this.view.state); this.schedule(); }
    else if (mod && (k.toLowerCase() === 'y' || (k.toLowerCase() === 'z' && e.shiftKey))) { redo(this.view.state); this.schedule(); }
    else if (k === 'F5') this.present(e.shiftKey);
    else if (k === 'ContextMenu' || (k === 'F10' && e.shiftKey)) { const r = this.cards[f]?.el.getBoundingClientRect(); if (r) showContextMenu(r.left + 24, r.top + 24, this.menu()); }
    else done = false;
    if (done) { e.preventDefault(); e.stopPropagation(); }
  };
}
