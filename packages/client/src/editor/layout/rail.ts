/**
 * The slide rail of layout decks — PowerPoint's thumbnail pane: a live miniature of every page left
 * of the canvas, numbered, the current page marked as the canvas scrolls or an object is picked.
 * A click goes to a page, dragging reorders, right-click or ⋯ has the page commands, and the keyboard
 * works as in PowerPoint (↑ ↓ Home End to move, Enter a new slide, Ctrl+D duplicate, Delete,
 * Ctrl+↑ / ↓ to reorder, Ctrl+C / X / V for whole slides, F5, Esc back to the canvas). "New slide"
 * offers layouts styled like the deck (slidelayouts.ts), or the deck's masters when it has some.
 * "Masters" switches the rail and the canvas to the master pages (masters.ts) — PowerPoint's slide
 * master view: the same thumbnails and commands, for the masters.
 *
 * A thumbnail is a copy of the editor's own page DOM, drawn at 320 px and scaled down (as the
 * presenter view draws its pages, present.ts), refreshed when that page's DOM changes. The rail
 * lies over the left edge of the scroller, inside the editor column (both shells' markup stays as
 * it is); the canvas makes room with `--ol-rail-w` (styles.css `.ol-has-rail`).
 */
import type { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { undo, redo } from 'y-prosemirror';
import { PAGE_TRANSITIONS } from '@overlyx/core';
import * as L from './commands';
import { showContextMenu, closeContextMenu, type MenuItem } from '../contextmenu';
import { MOD } from '../clipmenu';
import { editorContext } from '../context';
import { startPresentation } from './present';
import { SLIDE_LAYOUTS, insertSlide, type SlideLayout } from './slidelayouts';
import { masterPages, slideFromMaster, newMaster, duplicateMaster, deleteMaster, renameMaster, applyMaster, masterFromSlide, asKind, possibleBases } from './masters';
import { SlideSorter } from './sorter';
import { div, button, drawPage, scaleThumb, layoutPicker, undoStep, getSlideClipboard, setSlideClipboard, pageOfMutation, livePos } from './slidekit';

export interface RailHost {
  /** the slides, or the master pages (the master view) */
  kind(): L.PageKind;
  setMasterView(on: boolean): void;
  page(): { w: number; h: number };
  basePt(): number;
  /** the page the canvas shows (the selection's, else the most visible one) */
  currentPage(): number | null;
  /** nothing selected, the caret parked at that page (layout controller's deselectAll) */
  park(pagePos: number): void;
  /** the room for the canvas changed */
  refit(): void;
  /** the speaker notes under the pages: shown? (with an argument: show or hide them) */
  notes(on?: boolean): boolean;
}

const RAIL_W = 196, RAIL_COLLAPSED_W = 26;
const GRID_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="1.5" y="2" width="5.5" height="4" rx="0.8"/><rect x="9" y="2" width="5.5" height="4" rx="0.8"/><rect x="1.5" y="9.5" width="5.5" height="4" rx="0.8"/><rect x="9" y="9.5" width="5.5" height="4" rx="0.8"/></svg>';
const STORE = 'ol.slides';

interface Item { el: HTMLElement; num: HTMLElement; clip: HTMLElement; wrap: HTMLElement | null; pos: number; node: PMNode }

export class SlideRail {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private count: HTMLElement;
  private notesBtn: HTMLButtonElement;
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
  /** closes the open layout picker */
  private popup: (() => void) | null = null;
  private sorter: SlideSorter | null = null;
  private mastersBtn: HTMLButtonElement;
  private sorterBtn: HTMLButtonElement;
  private addBtn: HTMLButtonElement;
  private moreBtn: HTMLButtonElement;
  /** the kind of pages the items are */
  private shownKind: L.PageKind = 'slides';

  constructor(private view: EditorView, private scroller: HTMLElement, private host: RailHost) {
    let stored: string | null = null;
    try { stored = localStorage.getItem(STORE); } catch { /* not remembered */ }
    // a phone keeps the screen for the slide, unless the rail was opened there before
    this.collapsed = stored === '0' || (stored === null && scroller.clientWidth < 560);
    this.el = div('ol-slide-rail');
    this.el.dataset.olRail = '';
    const head = div('ol-rail-head');
    // the header: which slide of how many, the notes switch, the sorter, folding
    this.count = document.createElement('span');
    this.count.className = 'ol-rail-count';
    this.count.title = 'The slide shown, of all slides';
    this.notesBtn = button('ol-rail-notes', 'Notes', 'Speaker notes under the slides');
    this.notesBtn.dataset.railNotes = '';
    this.notesBtn.addEventListener('click', () => { this.host.notes(!this.host.notes()); this.syncNotes(); });
    const sorterBtn = button('ol-rail-sorter', '', 'Slide sorter: all slides in a grid');
    sorterBtn.dataset.railSorter = '';
    sorterBtn.innerHTML = GRID_ICON;
    sorterBtn.addEventListener('click', () => this.openSorter());
    this.sorterBtn = sorterBtn;
    // the master view: the masters in the rail and on the canvas (PowerPoint's View ▸ Slide Master)
    this.mastersBtn = button('ol-rail-masters-btn', 'Masters', 'Edit the master pages: what every slide using one shows behind its own objects, and where its title and text go');
    this.mastersBtn.dataset.railMasters = '';
    this.mastersBtn.addEventListener('click', () => this.host.setMasterView(this.host.kind() !== 'masters'));
    const hide = button('ol-rail-hide', '«', 'Hide the slides');
    hide.addEventListener('click', () => this.setCollapsed(true));
    head.append(this.count, this.mastersBtn, this.notesBtn, sorterBtn, hide);
    this.list = div('ol-rail-list');
    this.list.tabIndex = 0;
    this.list.setAttribute('role', 'listbox');
    this.list.setAttribute('aria-label', 'Slides');
    this.drop = div('ol-rail-drop');
    this.list.append(this.drop);
    const foot = div('ol-rail-foot');
    const add = button('ol-rail-new', '+ New slide', 'A new slide after this one (title and content)');
    add.dataset.railNew = '';
    add.addEventListener('click', () => (this.host.kind() === 'masters' ? this.newMasterPage() : this.newSlide('content', true)));
    const more = button('ol-rail-layouts', '▾', 'A new slide with a layout');
    more.dataset.railLayouts = '';
    more.addEventListener('click', e => { e.stopPropagation(); this.toggleLayouts(more); });
    this.addBtn = add; this.moreBtn = more;
    foot.append(add, more);
    const show = button('ol-rail-show', 'Slides', 'Show the slides');
    show.addEventListener('click', () => this.setCollapsed(false));
    // the folded rail (a phone's) still opens the sorter
    const mini = button('ol-rail-mini', '', 'Slide sorter: all slides in a grid');
    mini.dataset.railSorterMini = '';
    mini.innerHTML = GRID_ICON;
    mini.addEventListener('click', () => this.openSorter());
    this.el.append(head, this.list, foot, mini, show);

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
    this.sorter?.destroy();
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
    this.sorter?.update(docChanged);
    if (this.host.kind() !== this.shownKind) { this.syncKind(); this.refresh(); }
    else if (docChanged) this.schedule();
    this.syncCurrent();
    this.syncNotes();
  }

  /** the rail's labels for the slides or the masters */
  private syncKind(): void {
    const m = this.host.kind() === 'masters';
    this.shownKind = this.host.kind();
    this.el.classList.toggle('ol-rail-masters', m);
    this.mastersBtn.classList.toggle('active', m);
    this.mastersBtn.setAttribute('aria-pressed', String(m));
    this.mastersBtn.textContent = m ? 'Close' : 'Masters';
    this.mastersBtn.title = m ? 'Close the masters: back to the slides' : 'Edit the master pages: what every slide using one shows behind its own objects, and where its title and text go';
    this.sorterBtn.hidden = m;
    this.addBtn.textContent = m ? '+ New master' : '+ New slide';
    this.addBtn.title = m ? 'A new master page with a title and a text placeholder' : 'A new slide after this one';
    this.moreBtn.hidden = m;
    this.list.setAttribute('aria-label', m ? 'Masters' : 'Slides');
    // the items were the other kind's
    for (const it of this.items) it.el.remove();
    this.items = [];
    this.current = -1;
  }

  private syncNotes(): void {
    const on = this.host.notes();
    this.notesBtn.classList.toggle('active', on);
    this.notesBtn.setAttribute('aria-pressed', String(on));
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
    for (const r of recs) { const wrap = pageOfMutation(r); if (wrap) { this.dirty.add(wrap); any = true; } }
    if (any) this.schedule();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.refresh(), 250);
  }

  /** the items in page order, each with a fresh copy where its page is new or changed */
  private refresh(): void {
    if (this.view.isDestroyed) return;
    const masters = this.host.kind() === 'masters';
    const list = L.pages(this.view.state.doc, this.host.kind());
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
      it.el.title = masters ? `Master ${name ?? i + 1}${it.node.attrs.master ? ` (builds on ${it.node.attrs.master})` : ''}`
        : `Slide ${i + 1}${name ? ` — ${name}` : ''}${it.node.attrs.master ? ` · master: ${it.node.attrs.master}` : ''}${it.node.attrs.transition ? ` · ${it.node.attrs.transition}` : ''}`;
      it.el.classList.toggle('has-transition', !masters && !!it.node.attrs.transition);
      it.el.classList.toggle('is-master', masters);
      const thumb = it.clip.parentElement as HTMLElement;
      if (masters) thumb.dataset.name = name ?? ''; else delete thumb.dataset.name;
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
    const holder = drawPage(this.view, wrap, this.host.page());
    if (!holder) return;
    scaleThumb(it.clip, holder, this.thumbWidth(), this.host.page());
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
    if (this.forced && performance.now() > this.forced.until) this.forced = null;
    let index: number;
    if (this.forced) index = this.forced.index;
    else {
      const pos = this.host.currentPage();
      index = pos === null ? -1 : this.items.findIndex(i => livePos(i.wrap, i.pos) === pos);
    }
    if (index >= this.items.length) index = this.items.length - 1;
    const what = this.shownKind === 'masters' ? 'Master' : 'Slide';
    this.count.textContent = this.items.length ? `${what} ${index + 1} / ${this.items.length}` : `${what}s`;
    this.count.title = this.count.textContent;
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
    // (one slide at a time the canvas shows exactly that page: nothing to hold on to while it scrolls there)
    this.forced = this.view.dom.classList.contains('ol-single') ? null : { index, until: performance.now() + 600 };
    // (a deck shows one slide at a time: the page is hidden until the caret is parked on it, and then shown at the top)
    if (it.wrap?.offsetParent && !this.view.dom.classList.contains('ol-single')) {
      const r = it.wrap.getBoundingClientRect(), s = this.scroller.getBoundingClientRect();
      this.scroller.scrollTop += r.top - s.top - 16;
    }
    this.host.park(livePos(it.wrap, it.pos));
    this.syncCurrent(true);
  }

  /** the slide sorter over the canvas, the current slide selected */
  openSorter(): void {
    if (this.sorter) return;
    closeContextMenu();
    this.sorter = new SlideSorter(this.view, this.scroller, {
      page: () => this.host.page(),
      basePt: () => this.host.basePt(),
      show: pos => { this.refresh(); const i = this.items.findIndex(it => livePos(it.wrap, it.pos) === pos); if (i >= 0) this.goTo(i); },
      closed: pos => {
        this.sorter?.destroy();
        this.sorter = null;
        this.refresh();
        const i = pos === null ? -1 : this.items.findIndex(it => livePos(it.wrap, it.pos) === pos);
        if (i >= 0) this.goTo(i);
        this.list.focus({ preventScroll: true });
      },
    }, Math.max(0, this.current));
  }

  /* ---------------------------------------------------------------- page commands */

  private step(): void { undoStep(this.view); }

  private run(f: () => number | null): void {
    const to = f();
    // the new page's DOM exists once the transaction is applied: refresh, then go there
    this.refresh();
    if (to !== null) this.goTo(to);
  }

  newSlide(layout: SlideLayout | { master: string }, intoTitle = false, after = this.current): void {
    if (this.host.kind() === 'masters') { this.newMasterPage(); return; }
    const it = this.items[after];
    const at = it ? livePos(it.wrap, it.pos) : null;
    // a deck with masters: a slide of the chosen one — "New slide" itself takes the current slide's master (else the first)
    let master = typeof layout === 'object' ? layout.master : null;
    if (!master && layout === 'content') {
      const ms = masterPages(this.view.state.doc);
      if (ms.length) master = (it?.node.attrs.master && ms.some(m => m.node.attrs.name === it.node.attrs.master) ? it.node.attrs.master : ms[0].node.attrs.name) as string;
    }
    const made = master ? slideFromMaster(this.view.state, at, master) : null;
    const { tr, pos } = made ?? insertSlide(this.view.state, at, typeof layout === 'object' ? 'content' : layout, this.host.page(), this.host.basePt());
    this.step();
    this.view.dispatch(tr.scrollIntoView());
    this.run(() => (at === null ? this.items.length : after + 1));
    if (intoTitle) {
      // the caret into the new slide's first empty named box: type the title right away
      const page = this.view.state.doc.nodeAt(pos);
      let box = -1;
      page?.forEach((c, off) => { if (box < 0 && c.type.name === 'ol_box' && (c.attrs.name || c.attrs.ph)) box = pos + 1 + off; });
      if (box >= 0) { this.view.dispatch(L.caretInto(this.view.state.tr, box, false)); this.view.focus(); }
    }
  }

  /** a new master page (the master view's "New"): the deck's title and text placeholders */
  private newMasterPage(): void {
    const r = newMaster(this.view.state, this.host.page(), this.host.basePt());
    this.step();
    this.view.dispatch(r.tr);
    this.run(() => this.items.length);
  }

  private duplicate(index: number): void {
    const it = this.items[index];
    if (!it) return;
    this.step();
    if (this.host.kind() === 'masters') {
      const r = duplicateMaster(this.view.state, livePos(it.wrap, it.pos));
      if (r) { this.view.dispatch(r.tr); this.run(() => this.items.length); }
      return;
    }
    const pos = livePos(it.wrap, it.pos), node = this.view.state.doc.nodeAt(pos) ?? it.node;
    this.view.dispatch(L.insertPage(this.view.state, pos + node.nodeSize, node));
    this.run(() => index + 1);
  }

  private remove(index: number): void {
    const it = this.items[index];
    if (!it) return;
    const pos = livePos(it.wrap, it.pos);
    const tr = this.host.kind() === 'masters' ? deleteMaster(this.view.state, pos) : L.deletePage(this.view.state, pos);
    if (!tr) return;
    this.step();
    this.view.dispatch(tr);
    this.run(() => Math.min(index, this.items.length - 2));
  }

  private move(index: number, to: number): void {
    const it = this.items[index];
    if (!it) return;
    const tr = L.movePageTo(this.view.state, livePos(it.wrap, it.pos), to);
    if (!tr) return;
    this.step();
    this.view.dispatch(tr);
    this.run(() => (to > index ? to - 1 : to));
  }

  private copy(index: number, cut: boolean): void {
    const it = this.items[index];
    if (!it) return;
    setSlideClipboard([this.view.state.doc.nodeAt(livePos(it.wrap, it.pos)) ?? it.node]);
    if (cut) this.remove(index);
  }

  private paste(index: number): void {
    const slideClipboard = getSlideClipboard();
    if (!slideClipboard.length) return;
    const it = this.items[index];
    const ipos = it ? livePos(it.wrap, it.pos) : -1;
    const masters = this.host.kind() === 'masters';
    let at = it ? ipos + (this.view.state.doc.nodeAt(ipos) ?? it.node).nodeSize : masters ? 0 : this.view.state.doc.content.size;
    const tr = this.view.state.tr;
    // slides pasted among the masters become masters (named), masters among the slides slides
    for (const n of asKind(slideClipboard, masters, this.view.state.doc)) { tr.insert(at, n); at += n.nodeSize; }
    this.step();
    this.view.dispatch(tr);
    this.run(() => index + slideClipboard.length);
  }

  private setTransition(index: number, t: string): void {
    const it = this.items[index];
    if (!it) return;
    this.step();
    this.view.dispatch(L.setAttrs(this.view.state.tr, livePos(it.wrap, it.pos), { transition: t || null }));
  }

  /** the slide at `index` uses master `name` (null: none) */
  private setMaster(index: number, name: string | null): void {
    const it = this.items[index];
    if (!it) return;
    const tr = this.view.state.tr;
    applyMaster(tr, livePos(it.wrap, it.pos), name);
    this.step();
    this.view.dispatch(tr);
    this.schedule();
  }

  /** the slide at `index` back to its master's placeholders (frames and styles) */
  private resetSlide(index: number): void {
    const it = this.items[index];
    if (!it?.node.attrs.master) return;
    const tr = this.view.state.tr;
    applyMaster(tr, livePos(it.wrap, it.pos), it.node.attrs.master, true);
    this.step();
    this.view.dispatch(tr);
  }

  /** a master made of the slide at `index` (masters.ts masterFromSlide); the slide uses it */
  private masterFromSlide(index: number): void {
    const it = this.items[index];
    if (!it) return;
    const r = masterFromSlide(this.view.state, livePos(it.wrap, it.pos), this.host.page());
    if (!r) return;
    this.step();
    this.view.dispatch(r.tr);
    editorContextNotify(`Master “${r.name}” made of this slide: other slides use it from their menu (Master ▸ ${r.name}); “Masters” edits it`);
  }

  /** every slide uses master `name` (objects the slides have that the master draws are taken off them) */
  private useForAll(name: string): void {
    const tr = this.view.state.tr;
    for (const p of L.pages(this.view.state.doc)) applyMaster(tr, tr.mapping.map(p.pos), name);
    this.step();
    this.view.dispatch(tr);
  }

  private renameMaster(index: number): void {
    const it = this.items[index];
    if (!it) return;
    const name = window.prompt('Name of the master', it.node.attrs.name ?? '');
    if (!name?.trim()) return;
    const tr = renameMaster(this.view.state, livePos(it.wrap, it.pos), name.trim());
    if (tr) { this.step(); this.view.dispatch(tr); this.schedule(); }
  }

  private setBase(index: number, base: string | null): void {
    const it = this.items[index];
    if (!it) return;
    this.step();
    this.view.dispatch(L.setAttrs(this.view.state.tr, livePos(it.wrap, it.pos), { master: base }));
  }

  private masterMenu(index: number): MenuItem[] {
    const it = this.items[index], node = it?.node;
    const name = (node?.attrs.name ?? '') as string;
    const bases = possibleBases(this.view.state.doc, name);
    return [
      { label: 'New master', action: () => this.newMasterPage() },
      { label: 'Duplicate master', shortcut: `${MOD}+D`, action: () => this.duplicate(index) },
      { label: 'Rename master…', action: () => this.renameMaster(index) },
      { label: 'Delete master', shortcut: 'Del', icon: 'delete', action: () => this.remove(index) },
      { sep: true },
      { label: 'Builds on', disabled: !bases.length, sub: [null, ...bases].map(b => ({ label: b ?? 'Nothing', checked: (node?.attrs.master ?? null) === b, action: () => this.setBase(index, b) })) },
      { label: 'Use for every slide', action: () => this.useForAll(name) },
      { sep: true },
      { label: 'Close masters', action: () => this.host.setMasterView(false) },
    ];
  }

  private menu(index: number): MenuItem[] {
    if (this.host.kind() === 'masters') return this.masterMenu(index);
    const n = this.items.length, node = this.items[index]?.node;
    const masters = masterPages(this.view.state.doc).map(m => m.node.attrs.name as string);
    return [
      { label: 'New slide', sub: [...masters.map(m => ({ label: m, action: () => this.newSlide({ master: m }, false, index) })), ...(masters.length ? [{ sep: true } as MenuItem] : []), ...SLIDE_LAYOUTS.map(l => ({ label: l.label, action: () => this.newSlide(l.id, false, index) }))] },
      { label: 'Master', sub: [
        ...[null, ...masters].map(m => ({ label: m ?? 'None', checked: (node?.attrs.master ?? null) === m, action: () => this.setMaster(index, m) })),
        { sep: true } as MenuItem,
        { label: 'Reset slide to its master', disabled: !node?.attrs.master, action: () => this.resetSlide(index) },
        { label: 'Make a master of this slide', action: () => this.masterFromSlide(index) },
        { label: 'Edit masters', action: () => this.host.setMasterView(true) },
      ] },
      { label: 'Duplicate slide', shortcut: `${MOD}+D`, action: () => this.duplicate(index) },
      { label: 'Delete slide', shortcut: 'Del', icon: 'delete', disabled: n <= 1, action: () => this.remove(index) },
      { sep: true },
      { label: 'Cut', shortcut: `${MOD}+X`, icon: 'cut', disabled: n <= 1, action: () => this.copy(index, true) },
      { label: 'Copy', shortcut: `${MOD}+C`, icon: 'copy', action: () => this.copy(index, false) },
      { label: 'Paste after this slide', shortcut: `${MOD}+V`, icon: 'paste', disabled: !getSlideClipboard().length, action: () => this.paste(index) },
      { sep: true },
      { label: 'Move up', shortcut: `${MOD}+↑`, disabled: index <= 0, action: () => this.move(index, index - 1) },
      { label: 'Move down', shortcut: `${MOD}+↓`, disabled: index >= n - 1, action: () => this.move(index, index + 2) },
      { label: 'Transition', sub: ['', ...PAGE_TRANSITIONS].map(t => ({ label: t || 'None', checked: (node?.attrs.transition ?? '') === t, action: () => this.setTransition(index, t) })) },
      { sep: true },
      { label: 'Slide sorter', action: () => this.openSorter() },
      { label: 'Present from this slide', shortcut: 'Shift+F5', action: () => { this.goTo(index); startPresentation(this.view, { fromCurrent: true }); } },
    ];
  }

  /* ---------------------------------------------------------------- the layouts popup */

  private toggleLayouts(anchor: HTMLElement): void {
    if (this.popup) { this.closeLayouts(); return; }
    // the deck's masters first (their thumbnails), then the generated layouts
    const masters = masterPages(this.view.state.doc).map(m => ({ name: m.node.attrs.name as string, wrap: this.view.nodeDOM(m.pos) as HTMLElement | null }));
    this.popup = layoutPicker(this.el, anchor, l => this.newSlide(l, true), () => { this.popup = null; },
      { view: this.view, page: this.host.page(), masters, pickMaster: m => this.newSlide({ master: m }, true) });
  }

  private closeLayouts(): void { this.popup?.(); }

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
    else if (k === 'Enter' && !mod) { if (this.host.kind() === 'masters') this.newMasterPage(); else this.newSlide('content'); }
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

function editorContextNotify(text: string): void { editorContext.notify?.(text, 'info'); }
