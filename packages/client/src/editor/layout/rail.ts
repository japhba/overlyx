/**
 * The slide rail of layout decks — PowerPoint's thumbnail pane: a live miniature of every page left
 * of the canvas, numbered, the current page marked as the canvas scrolls or an object is picked.
 * A click goes to a page, dragging reorders, right-click or ⋯ has the page commands, and the keyboard
 * works as in PowerPoint (↑ ↓ Home End to move, Enter a new slide, Ctrl+D duplicate, Delete,
 * Ctrl+↑ / ↓ to reorder, Ctrl+C / X / V for whole slides, F5, Esc back to the canvas). "New slide"
 * offers layouts styled like the deck (slidelayouts.ts).
 *
 * A thumbnail is a copy of the editor's own page DOM, drawn at 320 px and scaled down (as the
 * presenter view draws its pages, present.ts), refreshed when that page's DOM changes. The rail
 * lies over the left edge of the scroller, inside the editor column (both shells' markup stays as
 * it is); the canvas makes room with `--ol-rail-w` (styles.css `.ol-has-rail`).
 */
import type { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { undo, redo, yUndoPluginKey } from 'y-prosemirror';
import { PAGE_TRANSITIONS } from '@overlyx/core';
import * as L from './commands';
import { clean } from './beamerslides';
import { showContextMenu, closeContextMenu, type MenuItem } from '../contextmenu';
import { MOD } from '../clipmenu';
import { startPresentation } from './present';
import { SLIDE_LAYOUTS, insertSlide, type SlideLayout } from './slidelayouts';

export interface RailHost {
  page(): { w: number; h: number };
  basePt(): number;
  /** the page the canvas shows (the selection's, else the most visible one) */
  currentPage(): number | null;
  /** nothing selected, the caret parked at that page (layout controller's deselectAll) */
  park(pagePos: number): void;
  /** the room for the canvas changed */
  refit(): void;
}

const RAIL_W = 196, RAIL_COLLAPSED_W = 26;
/** the width a page is drawn at before it is scaled into its thumbnail */
const DRAW_W = 320;
const STORE = 'ol.slides';
/** selection and editing marks of objects: not a change of the page's look */
const UI_CLASSES = new Set(['ol-sel', 'ol-edited', 'ol-selatom', 'ProseMirror-selectednode', 'focused', 'ol-hover']);

/** whole pages copied with Ctrl+C in a rail (any document of this tab) */
let slideClipboard: PMNode[] = [];

interface Item { el: HTMLElement; num: HTMLElement; clip: HTMLElement; wrap: HTMLElement | null; pos: number; node: PMNode }

const div = (cls: string) => { const d = document.createElement('div'); d.className = cls; return d; };
function button(cls: string, text: string, title: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button'; b.className = cls; b.textContent = text; b.title = title;
  return b;
}

export class SlideRail {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private count: HTMLElement;
  private drop: HTMLElement;
  private items: Item[] = [];
  private current = -1;
  private collapsed: boolean;
  private dirty = new Set<HTMLElement>();
  private timer = 0;
  private scrollRaf = 0;
  /** a page the rail went to: it stays current while the canvas scrolls there */
  private forced: { index: number; until: number } | null = null;
  private mo: MutationObserver;
  private ro: ResizeObserver | null = null;
  private drag: { index: number; y: number; id: number; moved: boolean; gap: number } | null = null;
  private popup: HTMLElement | null = null;

  constructor(private view: EditorView, private scroller: HTMLElement, private host: RailHost) {
    let stored: string | null = null;
    try { stored = localStorage.getItem(STORE); } catch { /* not remembered */ }
    // a phone keeps the screen for the slide, unless the rail was opened there before
    this.collapsed = stored === '0' || (stored === null && scroller.clientWidth < 560);
    this.el = div('ol-slide-rail');
    this.el.dataset.olRail = '';
    const head = div('ol-rail-head');
    const title = document.createElement('span');
    title.className = 'ol-rail-title'; title.textContent = 'Slides';
    this.count = document.createElement('span');
    this.count.className = 'ol-rail-count';
    const hide = button('ol-rail-hide', '«', 'Hide the slides');
    hide.addEventListener('click', () => this.setCollapsed(true));
    head.append(title, this.count, hide);
    this.list = div('ol-rail-list');
    this.list.tabIndex = 0;
    this.list.setAttribute('role', 'listbox');
    this.list.setAttribute('aria-label', 'Slides');
    this.drop = div('ol-rail-drop');
    this.list.append(this.drop);
    const foot = div('ol-rail-foot');
    const add = button('ol-rail-new', '+ New slide', 'A new slide after this one (title and content)');
    add.dataset.railNew = '';
    add.addEventListener('click', () => this.newSlide('content', true));
    const more = button('ol-rail-layouts', '▾', 'A new slide with a layout');
    more.dataset.railLayouts = '';
    more.addEventListener('click', e => { e.stopPropagation(); this.toggleLayouts(more); });
    foot.append(add, more);
    const show = button('ol-rail-show', 'Slides', 'Show the slides');
    show.addEventListener('click', () => this.setCollapsed(false));
    this.el.append(head, this.list, foot, show);

    this.list.addEventListener('keydown', this.onKey);
    this.list.addEventListener('pointerdown', this.onPointerDown);
    this.list.addEventListener('contextmenu', this.onContextMenu);
    this.list.addEventListener('scroll', () => this.positionDrop());
    scroller.addEventListener('scroll', this.onScroll, { passive: true });

    const column = scroller.parentElement!;
    if (getComputedStyle(column).position === 'static') column.style.position = 'relative';
    column.append(this.el);
    if (typeof ResizeObserver !== 'undefined') { this.ro = new ResizeObserver(() => this.place()); this.ro.observe(scroller); }
    this.mo = new MutationObserver(recs => this.onMutations(recs));
    this.mo.observe(view.dom, { subtree: true, childList: true, characterData: true, attributes: true, attributeOldValue: true });
    this.applyCollapsed();
    this.place();
    this.refresh();
  }

  destroy(): void {
    this.mo.disconnect();
    this.ro?.disconnect();
    clearTimeout(this.timer);
    cancelAnimationFrame(this.scrollRaf);
    this.scroller.removeEventListener('scroll', this.onScroll);
    this.closeLayouts();
    this.el.remove();
    this.view.dom.classList.remove('ol-has-rail');
    this.view.dom.style.removeProperty('--ol-rail-w');
  }

  /** the editor state changed: pages may have come or gone, the selection moved */
  update(docChanged: boolean): void {
    if (docChanged) this.schedule();
    this.syncCurrent();
  }

  width(): number { return this.collapsed ? RAIL_COLLAPSED_W : RAIL_W; }

  /* ---------------------------------------------------------------- layout */

  private place(): void {
    const s = this.scroller;
    this.el.style.left = `${s.offsetLeft}px`;
    this.el.style.top = `${s.offsetTop}px`;
    this.el.style.height = `${s.clientHeight}px`;
  }

  private setCollapsed(on: boolean): void {
    this.collapsed = on;
    try { localStorage.setItem(STORE, on ? '0' : '1'); } catch { /* not remembered */ }
    this.applyCollapsed();
    this.host.refit();
    if (!on) { this.refresh(); this.list.focus(); }
  }

  private applyCollapsed(): void {
    this.el.classList.toggle('collapsed', this.collapsed);
    this.view.dom.classList.add('ol-has-rail');
    this.view.dom.style.setProperty('--ol-rail-w', `${this.width()}px`);
  }

  /* ---------------------------------------------------------------- thumbnails */

  private onMutations(recs: MutationRecord[]): void {
    let any = false;
    for (const r of recs) {
      const t = (r.target.nodeType === 1 ? r.target : r.target.parentElement) as HTMLElement | null;
      if (!t || t.closest('.ol-overlay, .ol-page-label')) continue;
      if (r.type === 'attributes' && r.attributeName === 'class') {
        const before = new Set((r.oldValue ?? '').split(/\s+/).filter(Boolean)), after = new Set(t.classList);
        const changed = [...before, ...after].filter(c => before.has(c) !== after.has(c) && !UI_CLASSES.has(c));
        if (!changed.length) continue;
      }
      const wrap = t.closest('.ol-page-wrap') as HTMLElement | null;
      // the wrapper's own attributes (its transition) do not show on the page
      if (wrap && !(r.type === 'attributes' && t === wrap)) { this.dirty.add(wrap); any = true; }
    }
    if (any) this.schedule();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.refresh(), 250);
  }

  /** the items in page order, each with a fresh copy where its page is new or changed */
  private refresh(): void {
    if (this.view.isDestroyed) return;
    const list = L.pages(this.view.state.doc);
    const byWrap = new Map(this.items.filter(i => i.wrap).map(i => [i.wrap!, i]));
    const next: Item[] = [];
    for (const p of list) {
      const wrap = this.view.nodeDOM(p.pos) as HTMLElement | null;
      let it = wrap ? byWrap.get(wrap) : undefined;
      if (it) byWrap.delete(wrap!);
      else it = this.makeItem();
      const fresh = it.wrap !== wrap || (wrap && this.dirty.has(wrap));
      it.wrap = wrap; it.pos = p.pos; it.node = p.node;
      if (fresh && wrap && !this.collapsed) this.draw(it, wrap);
      next.push(it);
    }
    for (const it of this.items) if (!next.includes(it)) it.el.remove();
    next.forEach((it, i) => {
      if (this.list.children[i] !== it.el) this.list.insertBefore(it.el, this.list.children[i] ?? this.drop);
      it.num.textContent = String(i + 1);
      it.el.dataset.index = String(i);
      const name = it.node.attrs.name as string | null;
      it.el.title = `Slide ${i + 1}${name ? ` — ${name}` : ''}${it.node.attrs.transition ? ` · ${it.node.attrs.transition}` : ''}`;
      it.el.classList.toggle('has-transition', !!it.node.attrs.transition);
    });
    this.items = next;
    this.dirty.clear();
    this.syncCurrent(true);
  }

  private makeItem(): Item {
    const el = div('ol-rail-item');
    el.setAttribute('role', 'option');
    const num = div('ol-rail-num');
    const thumb = div('ol-rail-thumb');
    const clip = div('ol-rail-clip');
    thumb.append(clip);
    const more = button('ol-rail-more', '⋯', 'Slide menu');
    more.tabIndex = -1;
    el.append(num, thumb, more);
    return { el, num, clip, wrap: null, pos: 0, node: null as unknown as PMNode };
  }

  private draw(it: Item, wrap: HTMLElement): void {
    const section = wrap.querySelector(':scope > .ol-page') as HTMLElement | null;
    if (!section) return;
    const pg = this.host.page();
    // like the presentation's stage, not an editor (.lyx-editor): the page's own rules, its own scale
    const holder = div('ol-layout ol-rail-holder');
    // the editor's page variables (fonts, TeX spacing, list metrics), at the drawing scale
    const src = this.view.dom.style;
    for (let i = 0; i < src.length; i++) {
      const name = src[i];
      if (name.startsWith('--ol-') && !['--ol-fit-pt', '--ol-pt', '--ol-mm', '--ol-rail-w'].includes(name)) holder.style.setProperty(name, src.getPropertyValue(name));
    }
    const basept = getComputedStyle(this.view.dom).getPropertyValue('--ol-basept');
    if (basept) holder.style.setProperty('--ol-basept', basept);
    holder.style.setProperty('--ol-mm', `${DRAW_W / pg.w}px`);
    holder.style.setProperty('--ol-pt', `${DRAW_W / pg.w / 2.845276}px`);
    holder.style.setProperty('--ol-page-w', String(pg.w));
    holder.style.setProperty('--ol-page-h', String(pg.h));
    holder.style.transform = `scale(${this.thumbWidth() / DRAW_W})`;
    if (this.view.dom.dataset.olFont) holder.dataset.olFont = this.view.dom.dataset.olFont;
    const copy = section.cloneNode(true) as HTMLElement;
    copy.className = 'ol-page ol-rail-page';
    clean(copy);
    copy.querySelectorAll('.ol-notes, .ol-raw-unplaced, .ol-box-prompt').forEach(n => n.remove());
    copy.querySelectorAll('.ol-sel, .ol-edited, .ol-selatom').forEach(n => n.classList.remove('ol-sel', 'ol-edited', 'ol-selatom'));
    copy.querySelectorAll('[id]').forEach(n => n.removeAttribute('id'));
    holder.append(copy);
    holder.inert = true;
    it.clip.style.height = `${this.thumbWidth() * pg.h / pg.w}px`;
    it.clip.replaceChildren(holder);
  }

  private thumbWidth(): number { return RAIL_W - 58; }

  /* ---------------------------------------------------------------- the current page */

  private onScroll = (): void => {
    if (this.scrollRaf) return;
    this.scrollRaf = requestAnimationFrame(() => {
      this.scrollRaf = 0;
      if (this.forced && performance.now() > this.forced.until) this.forced = null;
      this.syncCurrent();
    });
  };

  private syncCurrent(force = false): void {
    let index: number;
    if (this.forced) index = this.forced.index;
    else {
      const pos = this.host.currentPage();
      index = pos === null ? -1 : this.items.findIndex(i => i.pos === pos);
    }
    if (index >= this.items.length) index = this.items.length - 1;
    this.count.textContent = this.items.length ? `${index + 1} / ${this.items.length}` : '';
    if (index === this.current && !force) return;
    this.items.forEach((it, i) => { it.el.classList.toggle('current', i === index); it.el.setAttribute('aria-selected', String(i === index)); });
    const changed = index !== this.current;
    this.current = index;
    if (changed && index >= 0 && !this.drag) this.items[index].el.scrollIntoView({ block: 'nearest' });
  }

  /** show page `index` in the canvas and make it the rail's current one */
  private goTo(index: number): void {
    const it = this.items[Math.max(0, Math.min(this.items.length - 1, index))];
    if (!it) return;
    index = this.items.indexOf(it);
    this.forced = { index, until: performance.now() + 600 };
    if (it.wrap) {
      const r = it.wrap.getBoundingClientRect(), s = this.scroller.getBoundingClientRect();
      this.scroller.scrollTop += r.top - s.top - 16;
    }
    this.host.park(it.pos);
    this.syncCurrent(true);
  }

  /* ---------------------------------------------------------------- page commands */

  /** each slide command is a step of its own for Ctrl+Z (the undo manager joins changes less than 0.5 s apart) */
  private step(): void {
    try { (yUndoPluginKey.getState(this.view.state) as { undoManager?: { stopCapturing(): void } } | undefined)?.undoManager?.stopCapturing(); } catch { /* no undo manager */ }
  }

  private run(f: () => number | null): void {
    const to = f();
    // the new page's DOM exists once the transaction is applied: refresh, then go there
    this.refresh();
    if (to !== null) this.goTo(to);
  }

  newSlide(layout: SlideLayout, intoTitle = false, after = this.current): void {
    const at = this.items[after]?.pos ?? null;
    const { tr, pos } = insertSlide(this.view.state, at, layout, this.host.page(), this.host.basePt());
    this.step();
    this.view.dispatch(tr.scrollIntoView());
    this.run(() => (at === null ? this.items.length : after + 1));
    if (intoTitle) {
      // the caret into the new slide's first empty named box: type the title right away
      const page = this.view.state.doc.nodeAt(pos);
      let box = -1;
      page?.forEach((c, off) => { if (box < 0 && c.type.name === 'ol_box' && c.attrs.name) box = pos + 1 + off; });
      if (box >= 0) { this.view.dispatch(L.caretInto(this.view.state.tr, box, false)); this.view.focus(); }
    }
  }

  private duplicate(index: number): void {
    const it = this.items[index];
    if (!it) return;
    this.step();
    this.view.dispatch(L.insertPage(this.view.state, it.pos + it.node.nodeSize, it.node));
    this.run(() => index + 1);
  }

  private remove(index: number): void {
    const it = this.items[index];
    if (!it) return;
    const tr = L.deletePage(this.view.state, it.pos);
    if (!tr) return;
    this.step();
    this.view.dispatch(tr);
    this.run(() => Math.min(index, this.items.length - 2));
  }

  private move(index: number, to: number): void {
    const it = this.items[index];
    if (!it) return;
    const tr = L.movePageTo(this.view.state, it.pos, to);
    if (!tr) return;
    this.step();
    this.view.dispatch(tr);
    this.run(() => (to > index ? to - 1 : to));
  }

  private copy(index: number, cut: boolean): void {
    const it = this.items[index];
    if (!it) return;
    slideClipboard = [it.node];
    if (cut) this.remove(index);
  }

  private paste(index: number): void {
    if (!slideClipboard.length) return;
    const it = this.items[index];
    let at = it ? it.pos + it.node.nodeSize : this.view.state.doc.content.size;
    const tr = this.view.state.tr;
    for (const n of slideClipboard) { tr.insert(at, n); at += n.nodeSize; }
    this.step();
    this.view.dispatch(tr);
    this.run(() => index + slideClipboard.length);
  }

  private setTransition(index: number, t: string): void {
    const it = this.items[index];
    if (!it) return;
    this.step();
    this.view.dispatch(L.setAttrs(this.view.state.tr, it.pos, { transition: t || null }));
  }

  private menu(index: number): MenuItem[] {
    const n = this.items.length, node = this.items[index]?.node;
    return [
      { label: 'New slide', sub: SLIDE_LAYOUTS.map(l => ({ label: l.label, action: () => this.newSlide(l.id, false, index) })) },
      { label: 'Duplicate slide', shortcut: `${MOD}+D`, action: () => this.duplicate(index) },
      { label: 'Delete slide', shortcut: 'Del', icon: 'delete', disabled: n <= 1, action: () => this.remove(index) },
      { sep: true },
      { label: 'Cut', shortcut: `${MOD}+X`, icon: 'cut', disabled: n <= 1, action: () => this.copy(index, true) },
      { label: 'Copy', shortcut: `${MOD}+C`, icon: 'copy', action: () => this.copy(index, false) },
      { label: 'Paste after this slide', shortcut: `${MOD}+V`, icon: 'paste', disabled: !slideClipboard.length, action: () => this.paste(index) },
      { sep: true },
      { label: 'Move up', shortcut: `${MOD}+↑`, disabled: index <= 0, action: () => this.move(index, index - 1) },
      { label: 'Move down', shortcut: `${MOD}+↓`, disabled: index >= n - 1, action: () => this.move(index, index + 2) },
      { label: 'Transition', sub: ['', ...PAGE_TRANSITIONS].map(t => ({ label: t || 'None', checked: (node?.attrs.transition ?? '') === t, action: () => this.setTransition(index, t) })) },
      { sep: true },
      { label: 'Present from this slide', shortcut: 'Shift+F5', action: () => { this.goTo(index); startPresentation(this.view, { fromCurrent: true }); } },
    ];
  }

  /* ---------------------------------------------------------------- the layouts popup */

  private toggleLayouts(anchor: HTMLElement): void {
    if (this.popup) { this.closeLayouts(); return; }
    const pop = div('ol-rail-pop');
    pop.dataset.railLayoutPicker = '';
    const heading = div('ol-rail-pop-title');
    heading.textContent = 'New slide';
    pop.append(heading);
    const grid = div('ol-rail-pop-grid');
    for (const l of SLIDE_LAYOUTS) {
      const b = button('ol-rail-layout', '', l.label);
      b.dataset.layout = l.id;
      b.innerHTML = layoutIcon(l.id);
      const cap = document.createElement('span');
      cap.textContent = l.label;
      b.append(cap);
      b.addEventListener('click', () => { this.closeLayouts(); this.newSlide(l.id, true); });
      grid.append(b);
    }
    pop.append(grid);
    this.el.append(pop);
    const r = anchor.getBoundingClientRect(), base = this.el.getBoundingClientRect();
    pop.style.bottom = `${base.bottom - r.top + 6}px`;
    this.popup = pop;
    const away = (e: Event) => { if (!pop.contains(e.target as Node) && e.target !== anchor) this.closeLayouts(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); this.closeLayouts(); this.list.focus(); } };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', esc, true);
    (pop as HTMLElement & { _off?: () => void })._off = () => { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', esc, true); };
    (grid.querySelector('button[data-layout="content"]') as HTMLElement | null)?.focus();
  }

  private closeLayouts(): void {
    const p = this.popup as (HTMLElement & { _off?: () => void }) | null;
    if (!p) return;
    p._off?.();
    p.remove();
    this.popup = null;
  }

  /* ---------------------------------------------------------------- pointer and keys */

  private itemAt(target: EventTarget | null): number {
    const el = (target as HTMLElement | null)?.closest?.('.ol-rail-item') as HTMLElement | null;
    return el ? this.items.findIndex(i => i.el === el) : -1;
  }

  private onContextMenu = (e: MouseEvent): void => {
    const index = this.itemAt(e.target);
    if (index < 0) return;
    e.preventDefault();
    this.goTo(index);
    showContextMenu(e.clientX, e.clientY, this.menu(index));
  };

  private onPointerDown = (e: PointerEvent): void => {
    const index = this.itemAt(e.target);
    if (index < 0 || e.button !== 0) return;
    if ((e.target as HTMLElement).closest('.ol-rail-more')) {
      e.preventDefault();
      const r = (e.target as HTMLElement).getBoundingClientRect();
      this.goTo(index);
      showContextMenu(r.left, r.bottom, this.menu(index));
      return;
    }
    e.preventDefault();
    this.list.focus({ preventScroll: true });
    this.drag = { index, y: e.clientY, id: e.pointerId, moved: false, gap: index };
    this.list.setPointerCapture(e.pointerId);
    this.list.addEventListener('pointermove', this.onPointerMove);
    this.list.addEventListener('pointerup', this.onPointerUp);
    this.list.addEventListener('pointercancel', this.onPointerUp);
  };

  private onPointerMove = (e: PointerEvent): void => {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    if (!d.moved && Math.abs(e.clientY - d.y) < 5) return;
    if (!d.moved) { d.moved = true; this.items[d.index].el.classList.add('dragging'); this.el.classList.add('dragging'); }
    // the gap the page would go into: before the first item whose middle is below the pointer
    let gap = this.items.length;
    for (let i = 0; i < this.items.length; i++) {
      const r = this.items[i].el.getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) { gap = i; break; }
    }
    d.gap = gap;
    const lr = this.list.getBoundingClientRect();
    if (e.clientY < lr.top + 28) this.list.scrollTop -= 12;
    else if (e.clientY > lr.bottom - 28) this.list.scrollTop += 12;
    this.positionDrop();
  };

  private positionDrop(): void {
    const d = this.drag;
    const show = !!d?.moved && d.gap !== d.index && d.gap !== d.index + 1;
    this.drop.style.display = show ? 'block' : 'none';
    if (!show || !d) return;
    const ref = this.items[d.gap]?.el, last = this.items[this.items.length - 1]?.el;
    const top = ref ? ref.offsetTop - 3 : last ? last.offsetTop + last.offsetHeight + 1 : 0;
    this.drop.style.top = `${top}px`;
  }

  private onPointerUp = (e: PointerEvent): void => {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    this.drag = null;
    this.list.removeEventListener('pointermove', this.onPointerMove);
    this.list.removeEventListener('pointerup', this.onPointerUp);
    this.list.removeEventListener('pointercancel', this.onPointerUp);
    this.items[d.index]?.el.classList.remove('dragging');
    this.el.classList.remove('dragging');
    this.drop.style.display = 'none';
    if (e.type === 'pointercancel') return;
    if (d.moved) { if (d.gap !== d.index && d.gap !== d.index + 1) this.move(d.index, d.gap); }
    else this.goTo(d.index);
  };

  private onKey = (e: KeyboardEvent): void => {
    const mod = e.ctrlKey || e.metaKey, i = this.current < 0 ? 0 : this.current, n = this.items.length;
    const k = e.key;
    let done = true;
    if (mod && (k === 'ArrowUp' || k === 'ArrowDown')) { if (k === 'ArrowUp' && i > 0) this.move(i, i - 1); else if (k === 'ArrowDown' && i < n - 1) this.move(i, i + 2); }
    else if (k === 'ArrowDown' || k === 'ArrowRight') this.goTo(i + 1);
    else if (k === 'ArrowUp' || k === 'ArrowLeft') this.goTo(i - 1);
    else if (k === 'PageDown') this.goTo(i + 4);
    else if (k === 'PageUp') this.goTo(i - 4);
    else if (k === 'Home') this.goTo(0);
    else if (k === 'End') this.goTo(n - 1);
    else if (k === 'Enter' && !mod) this.newSlide('content');
    else if (k === 'Delete' || k === 'Backspace') this.remove(i);
    else if (mod && k.toLowerCase() === 'd') this.duplicate(i);
    else if (mod && k.toLowerCase() === 'c') this.copy(i, false);
    else if (mod && k.toLowerCase() === 'x') this.copy(i, true);
    else if (mod && k.toLowerCase() === 'v') this.paste(i);
    else if (mod && k.toLowerCase() === 'z' && !e.shiftKey) { this.step(); undo(this.view.state); this.schedule(); }
    else if (mod && (k.toLowerCase() === 'y' || (k.toLowerCase() === 'z' && e.shiftKey))) { redo(this.view.state); this.schedule(); }
    else if (k === 'F5') startPresentation(this.view, { fromCurrent: e.shiftKey });
    else if (k === 'Escape') { closeContextMenu(); this.view.focus(); }
    else if (k === 'ContextMenu' || (k === 'F10' && e.shiftKey)) { const r = this.items[i]?.el.getBoundingClientRect(); if (r) showContextMenu(r.left + 20, r.top + 20, this.menu(i)); }
    else done = false;
    if (done) { e.preventDefault(); e.stopPropagation(); }
  };
}

/** a layout's sketch for the picker: title bars, text lines, columns */
function layoutIcon(id: SlideLayout): string {
  const bar = (x: number, y: number, w: number, h = 3) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="1" class="t"/>`;
  const lines = (x: number, y: number, w: number, k: number) => Array.from({ length: k }, (_, i) => `<rect x="${x}" y="${y + i * 4}" width="${i === k - 1 ? w * 0.6 : w}" height="1.6" rx="0.8" class="l"/>`).join('');
  const body: Record<SlideLayout, string> = {
    title: bar(12, 13, 40, 5) + lines(18, 22, 28, 1),
    content: bar(6, 5, 34) + lines(6, 13, 52, 4),
    section: bar(6, 17, 36, 5) + `<rect x="6" y="24.5" width="10" height="1" class="t"/>` + lines(6, 28, 26, 1),
    two: bar(6, 5, 34) + lines(6, 13, 24, 4) + lines(34, 13, 24, 4),
    comparison: bar(6, 5, 34) + bar(6, 12, 16, 2) + bar(34, 12, 16, 2) + lines(6, 17, 24, 3) + lines(34, 17, 24, 3),
    titleonly: bar(6, 5, 34),
    statement: bar(10, 14, 44, 4) + bar(18, 20, 28, 4),
    blank: '',
  };
  return `<svg viewBox="0 0 64 36" aria-hidden="true"><rect x="0.5" y="0.5" width="63" height="35" rx="2" class="p"/>${body[id]}</svg>`;
}
