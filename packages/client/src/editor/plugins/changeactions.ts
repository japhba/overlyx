/**
 * Accept / reject in the text itself (Google Docs' suggestion card, made small): a bar with ✓ and ✗
 * first (right above where the change starts, a short way to click), then the author and the date,
 * over the tracked change under the pointer — or the one the caret is in,
 * once the caret got there by a click or a key (not while typing: every typed suggestion would
 * bring it up). One click settles the change and the runs touching it by the same author, so a
 * replacement (the deletion and its insertion) or a suggestion across paragraph breaks is one
 * decision (`changeGroupAt`); hovering ✓ or ✗ shades what it applies to. Not while the document is
 * read-only. The bar lives outside the editor's DOM, so it never shifts the text.
 */
import { Plugin, PluginKey, type EditorState } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { changeAt, changeGroupAt, changeAuthorName, resolveChanges, type ChangeRange } from './changes';
import { menuIcon } from '../menuicons';

/** whether the last document change was made here (typing, a paste…) rather than arriving from a collaborator */
const actionsKey = new PluginKey<boolean>('lyx-change-actions');

const CHANGE = '.lyx-change, .lyx-inset[data-change]';

type Rect = { left: number; right: number; top: number; bottom: number };

/** The change run an element of the editor shows: a ¶ marker, an inline node, or a span of the change mark. */
function runOfElement(view: EditorView, el: HTMLElement): { pos: number; boundary: boolean } | null {
  const desc = (el as unknown as { pmViewDesc?: { node?: unknown; posBefore: number } }).pmViewDesc;
  try {
    if (el.classList.contains('lyx-change-boundary')) return desc ? { pos: desc.posBefore, boundary: true } : null;
    if (desc?.node) return { pos: desc.posBefore, boundary: false };
    return { pos: view.posAtDOM(el, 0), boundary: false };
  } catch { return null; }
}

/** "14:05" today, "3 Oct, 14:05" this year, "3 Oct 2025" before */
export function shortChangeDate(time: number, now = new Date()): string {
  if (!time) return '';
  const d = new Date(time * 1000);
  const clock = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return clock;
  if (d.getFullYear() === now.getFullYear()) return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${clock}`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** The nearest scrolling ancestor's visible box (the window when there is none). */
function visibleBox(el: HTMLElement): Rect {
  for (let e = el.parentElement; e; e = e.parentElement) {
    const o = getComputedStyle(e).overflowY;
    if (o === 'auto' || o === 'scroll') return e.getBoundingClientRect();
  }
  return { left: 0, right: window.innerWidth, top: 0, bottom: window.innerHeight };
}

class ChangeActions {
  private bar: HTMLElement | null = null;
  private group: ChangeRange[] | null = null;
  private anchor: (() => Rect | null) | null = null;
  /** the change element under the pointer, which of its line boxes, and where the pointer entered it */
  private hover: { el: HTMLElement; line: number; x: number; y: number } | null = null;
  /** the caret may bring the bar up: it moved by a click or a key since the last edit made here */
  private caret = false;
  private overBar = false;
  private hideTimer: ReturnType<typeof setTimeout> | undefined;
  private shades: HTMLElement[] = [];

  constructor(private view: EditorView) {
    view.dom.addEventListener('mouseover', this.onOver);
    view.dom.addEventListener('mouseout', this.onOut);
    view.dom.addEventListener('blur', this.onBlur);
    view.dom.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('scroll', this.onScroll, true);
    window.addEventListener('resize', this.onScroll);
  }

  update(view: EditorView, prev: EditorState): void {
    const state = view.state;
    if (state.doc !== prev.doc) { if (actionsKey.getState(state)) this.caret = false; }
    else if (!state.selection.eq(prev.selection)) this.caret = true;
    this.render();
  }

  destroy(): void {
    const dom = this.view.dom;
    dom.removeEventListener('mouseover', this.onOver);
    dom.removeEventListener('mouseout', this.onOut);
    dom.removeEventListener('blur', this.onBlur);
    dom.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('scroll', this.onScroll, true);
    window.removeEventListener('resize', this.onScroll);
    clearTimeout(this.hideTimer);
    this.hide();
  }

  private ownChange(target: EventTarget | null): HTMLElement | null {
    const el = (target as HTMLElement | null)?.closest?.(CHANGE) as HTMLElement | null;
    return el && el.closest('.ProseMirror') === this.view.dom ? el : null;
  }

  private onOver = (ev: MouseEvent) => {
    if (ev.buttons) return;   // selecting with the mouse
    const el = this.ownChange(ev.target);
    if (!el) { if (this.hover) this.scheduleHide(); return; }
    clearTimeout(this.hideTimer);
    if (this.hover?.el === el) return;
    const rects = Array.from(el.getClientRects());
    const line = Math.max(0, rects.findIndex(r => ev.clientY >= r.top && ev.clientY <= r.bottom));
    this.hover = { el, line, x: ev.clientX, y: ev.clientY };
    this.render();
  };

  private onOut = (ev: MouseEvent) => {
    const to = ev.relatedTarget as Node | null;
    if (to && (this.bar?.contains(to) || this.ownChange(to))) return;
    if (this.hover && !(to && this.view.dom.contains(to))) this.scheduleHide();
  };

  private onBlur = () => { setTimeout(() => this.render(), 0); };
  private onContextMenu = () => { this.hover = null; this.caret = false; this.hide(); };
  private onScroll = () => { if (this.bar) this.place(); if (this.shades.length) this.shade(true); };

  private scheduleHide(): void {
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      if (this.overBar) return;
      this.hover = null;
      this.render();
    }, 300);
  }

  /** Show the bar for what is under the pointer, else for the caret's change, else nothing. */
  private render(): void {
    const view = this.view;
    if (!view.editable) { this.hover = null; this.hide(); return; }
    let group: ChangeRange[] | null = null, anchor: (() => Rect | null) | null = null;
    if (this.hover && !this.hover.el.isConnected) {
      // the paragraph was drawn again (an edit, a collaborator): the change still under the pointer
      const again = this.ownChange(document.elementFromPoint(this.hover.x, this.hover.y));
      this.hover = again ? { ...this.hover, el: again } : null;
    }
    if (this.hover) {
      const run = runOfElement(view, this.hover.el);
      group = run && changeGroupAt(view.state.doc, run.pos, run.boundary);
      const { el, line } = this.hover;
      anchor = () => { const r = el.getClientRects(); return r[Math.min(line, r.length - 1)] ?? null; };
    }
    if (!group && this.caret && view.hasFocus() && view.state.selection.empty) {
      const at = changeAt(view.state, view.state.selection.from);
      group = at && changeGroupAt(view.state.doc, at.from, !!at.boundary);
      const start = group?.[0];
      if (start) anchor = () => { try { return view.coordsAtPos(start.from, 1); } catch { return null; } };
    }
    if (!group || !anchor) { this.hide(); return; }
    this.show(group, anchor);
  }

  private show(group: ChangeRange[], anchor: () => Rect | null): void {
    this.group = group;
    this.anchor = anchor;
    const last = group.reduce((t, r) => Math.max(t, r.time || 0), 0);
    const author = group[0].author;
    const kinds = new Set(group.map(r => r.type));
    const kind = kinds.size > 1 ? 'change' : kinds.has('deleted') ? 'deletion' : 'insertion';
    const key = `${author}:${last}:${kind}`;
    if (!this.bar) this.bar = this.build();
    const bar = this.bar;
    if (bar.dataset.key !== key) {
      bar.dataset.key = key;
      const who = bar.querySelector('.change-actions-author') as HTMLElement;
      const dot = bar.querySelector('.change-actions-dot') as HTMLElement;
      const when = bar.querySelector('.change-actions-date') as HTMLElement;
      const name = changeAuthorName(author);
      who.textContent = name;
      dot.dataset.author = String(author);
      dot.dataset.kind = kind;
      when.textContent = shortChangeDate(last);
      const full = `${kind === 'deletion' ? 'Deleted' : kind === 'insertion' ? 'Inserted' : 'Changed'} by ${name}${last ? ' on ' + new Date(last * 1000).toLocaleString() : ''}`;
      (bar.querySelector('.change-actions-info') as HTMLElement).title = full;
      for (const [cls, verb] of [['accept', 'Accept'], ['reject', 'Reject']] as const) {
        const b = bar.querySelector('.change-action.' + cls) as HTMLElement;
        b.title = `${verb} this ${kind}`;
        b.setAttribute('aria-label', b.title);
      }
    }
    this.place();
    if (this.overBar) this.shade(true);
  }

  private build(): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'change-actions';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Tracked change');
    // the editor keeps the focus and the caret where they are
    bar.addEventListener('mousedown', ev => ev.preventDefault());
    bar.addEventListener('mouseenter', () => { this.overBar = true; clearTimeout(this.hideTimer); });
    bar.addEventListener('mouseleave', () => { this.overBar = false; this.shade(false); if (this.hover) this.scheduleHide(); });
    const info = document.createElement('span');
    info.className = 'change-actions-info';
    const dot = document.createElement('span');
    dot.className = 'change-actions-dot lyx-change';
    const who = document.createElement('span');
    who.className = 'change-actions-author';
    const when = document.createElement('span');
    when.className = 'change-actions-date';
    info.append(dot, who, when);
    for (const accept of [true, false]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'change-action ' + (accept ? 'accept' : 'reject');
      b.appendChild(menuIcon(accept ? 'accept' : 'reject', 'change-svg'));
      b.addEventListener('mouseenter', () => this.shade(true));
      b.addEventListener('mouseleave', () => this.shade(false));
      b.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); this.resolve(accept); });
      bar.appendChild(b);
    }
    bar.appendChild(info);
    document.body.appendChild(bar);
    return bar;
  }

  private resolve(accept: boolean): void {
    const group = this.group;
    this.hover = null;
    this.caret = false;
    this.overBar = false;
    this.hide();
    if (group) resolveChanges(group, accept)(this.view.state, this.view.dispatch);
  }

  /** Above the change's line (below it when that is out of the editor's view), starting where the change starts. */
  private place(): void {
    const bar = this.bar, a = this.anchor?.();
    if (!bar) return;
    const box = visibleBox(this.view.dom);
    if (!a || (a.right <= a.left && a.bottom <= a.top) || a.bottom < box.top || a.top > box.bottom) { bar.style.visibility = 'hidden'; return; }
    bar.style.visibility = '';
    const w = bar.offsetWidth, h = bar.offsetHeight;
    const x = Math.max(8, Math.min(a.left - 4, window.innerWidth - w - 8));
    let y = a.top - h - 3;
    if (y < box.top) y = a.bottom + 3;
    bar.style.left = x + 'px';
    bar.style.top = y + 'px';
  }

  /** Shade what ✓ / ✗ applies to (drawn over the page, not in the editor's DOM). */
  private shade(on: boolean): void {
    for (const s of this.shades) s.remove();
    this.shades = [];
    const group = this.group;
    if (!on || !group) return;
    let rects: DOMRect[] = [];
    try {
      const s = this.view.domAtPos(group[0].from), e = this.view.domAtPos(group[group.length - 1].to);
      const range = document.createRange();
      range.setStart(s.node, s.offset);
      range.setEnd(e.node, e.offset);
      rects = Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0);
    } catch { return; }
    // the boxes of elements inside the range repeat their text's boxes: keep the outermost
    rects.sort((p, q) => q.width * q.height - p.width * p.height);
    const kept: DOMRect[] = [];
    for (const r of rects) if (!kept.some(k => r.left >= k.left - 1 && r.right <= k.right + 1 && r.top >= k.top - 1 && r.bottom <= k.bottom + 1)) kept.push(r);
    for (const r of kept) {
      const d = document.createElement('div');
      d.className = 'change-actions-shade';
      Object.assign(d.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
      document.body.appendChild(d);
      this.shades.push(d);
    }
  }

  private hide(): void {
    this.shade(false);
    this.bar?.remove();
    this.bar = null;
    this.group = null;
    this.anchor = null;
    this.overBar = false;
  }
}

export function changeActionsPlugin(): Plugin<boolean> {
  return new Plugin<boolean>({
    key: actionsKey,
    state: {
      init: () => false,
      apply: (tr, prev) => tr.docChanged ? !tr.getMeta('y-sync$') : prev,
    },
    view: view => new ChangeActions(view),
  });
}
