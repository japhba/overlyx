/**
 * Comments and tracked changes along the scroll bar (VS Code's overview ruler): a strip over the
 * document pane's vertical scroll bar — along the pane's right edge where scroll bars only show
 * while scrolling (macOS, iPad) — with a mark at each one's height in the whole document: tracked
 * changes in their author's colour on the left half, open comment threads in the comments' amber
 * on the right. A click on a mark goes there (the caret to the start of the change, whose ✓ / ✗ bar
 * comes up; the thread's card opens), and Back returns. The editors of one pane (a master and its
 * child documents in the combined view) share its strip. Resolved threads are left out; what a
 * closed inset holds is marked at the inset, what a folded section hides not at all.
 */
import { Plugin, TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { parseHeader } from '@overlyx/core';
import { changeOf, changeAuthorName } from './changes';
import { isResolvedThread } from './commentui';
import { shortChangeDate } from './changeactions';
import { isCommentNode, gotoComment } from '../commentops';
import { navHistory } from '../../app/navhistory';
import './scrollmarks.css';

interface Item { view: EditorView; kind: 'comment' | 'inserted' | 'deleted'; from: number; to: number; author: number | string; time: number }
interface Mark { lane: 'change' | 'comment'; top: number; bottom: number; color: string; items: Item[] }

/** the strip's width where the scroll bar takes no room of its own (it shows over the text while scrolling) */
const OVERLAY_WIDTH = 10;
/** the shortest mark (px): a one-word change in a long document is still a line one can point at */
const MIN_MARK = 3;

const views = new Set<EditorView>();
const strips = new Map<HTMLElement, HTMLElement>();
const itemsOfMark = new WeakMap<HTMLElement, Item[]>();
let timer: ReturnType<typeof setTimeout> | undefined;
let observer: ResizeObserver | null = null;

/** Again soon (at most every quarter second while typing, resizing, loading images). */
function schedule(): void {
  if (timer === undefined) timer = setTimeout(refresh, 250);
}

/** The comment threads and change runs of a document, in document order (runs side by side by one author merged). */
function itemsOf(view: EditorView): Item[] {
  const out: Item[] = [];
  const add = (it: Item) => {
    const last = out[out.length - 1];
    if (last && last.kind !== 'comment' && it.kind !== 'comment' && last.to === it.from && last.author === it.author) last.to = it.to;
    else out.push(it);
  };
  view.state.doc.descendants((node, pos) => {
    if (isCommentNode(node)) {
      if (!isResolvedThread(node)) out.push({ view, kind: 'comment', from: pos, to: pos, author: parseHeader((node.firstChild?.textContent ?? '').trim())?.author ?? '', time: 0 });
      return false;
    }
    if (node.type.name === 'paragraph' && node.attrs.endChange) {
      try {
        const c = JSON.parse(node.attrs.endChange);
        add({ view, kind: c.type, from: pos + node.nodeSize - 1, to: pos + node.nodeSize, author: Number(c.author), time: Number(c.time) });
      } catch { /* not a change */ }
    }
    if (!node.isInline) return true;
    const c = changeOf(node);
    if (!c) return true;
    add({ view, kind: c.type, from: pos, to: pos + node.nodeSize, author: c.author, time: c.time });
    return false;
  });
  return out;
}

/** Where `pos` is drawn — inside a closed inset, where the inset is; null when nothing shows it (a folded section). */
function rectAt(view: EditorView, pos: number, side: -1 | 1): { top: number; bottom: number } | null {
  const doc = view.state.doc;
  for (let p = Math.min(pos, doc.content.size); ;) {
    let r: { top: number; bottom: number; left: number; right: number } | null = null;
    try { r = view.coordsAtPos(p, side); } catch { /* not drawn */ }
    if (r && (r.top || r.bottom || r.left || r.right)) return r;
    const $p = doc.resolve(p);
    if (!$p.depth) return null;
    p = $p.before();
  }
}

function makeStrip(): HTMLElement {
  const strip = document.createElement('div');
  strip.className = 'ol-scrollmarks';
  strip.setAttribute('aria-hidden', 'true');
  // the editor keeps the focus: the change's ✓ / ✗ bar comes up only in a focused editor
  strip.addEventListener('mousedown', ev => ev.preventDefault());
  strip.addEventListener('pointerover', ev => {
    const el = (ev.target as HTMLElement).closest<HTMLElement>('.ol-scrollmark');
    const items = el && itemsOfMark.get(el);
    if (el && items) el.title = describe(items);
  });
  strip.addEventListener('click', ev => {
    const el = (ev.target as HTMLElement).closest<HTMLElement>('.ol-scrollmark');
    const it = el && itemsOfMark.get(el)?.[0];
    if (it) go(it);
  });
  document.body.appendChild(strip);
  return strip;
}

function describe(items: Item[]): string {
  if (items.length === 1) {
    const it = items[0];
    if (it.kind === 'comment') return `Comment${it.author ? ` by ${it.author}` : ''}`;
    const date = shortChangeDate(it.time);
    return `${it.kind === 'deleted' ? 'Deletion' : 'Insertion'} by ${changeAuthorName(Number(it.author))}${date ? `, ${date}` : ''}`;
  }
  const comments = items.filter(i => i.kind === 'comment').length, changes = items.length - comments;
  const n = (k: number, what: string) => k ? `${k} ${what}${k > 1 ? 's' : ''}` : '';
  return `${[n(changes, 'change'), n(comments, 'comment')].filter(Boolean).join(' and ')} here — click for the first`;
}

/** To the change (the caret at its start) or the thread (its card opens), in the middle of the pane. */
function go(it: Item): void {
  const view = it.view;
  if (!view.dom.isConnected) return;
  navHistory.jump(() => {
    if (it.kind === 'comment') { gotoComment(view, it.from); return; }
    view.focus();
    const doc = view.state.doc;
    view.dispatch(view.state.tr.setSelection(TextSelection.near(doc.resolve(Math.min(it.from, doc.content.size)), 1)));
    const pane = view.dom.closest<HTMLElement>('.editor-scroll'), r = rectAt(view, view.state.selection.from, 1);
    if (!pane || !r) return;
    const box = pane.getBoundingClientRect();
    pane.scrollTop += (r.top + r.bottom) / 2 - (box.top + pane.clientTop + pane.clientHeight / 2);
  });
}

function refresh(): void {
  timer = undefined;
  const byPane = new Map<HTMLElement, EditorView[]>();
  for (const v of views) {
    const pane = v.dom.closest<HTMLElement>('.editor-scroll');
    if (pane) byPane.set(pane, [...(byPane.get(pane) ?? []), v]);
  }
  for (const [pane, strip] of strips) {
    if (byPane.has(pane)) continue;
    strip.remove();
    strips.delete(pane);
    observer?.unobserve(pane);
  }
  for (const [pane, vs] of byPane) {
    let strip = strips.get(pane);
    if (!strip) { strips.set(pane, strip = makeStrip()); observer?.observe(pane); }
    draw(strip, pane, vs);
  }
}

function draw(strip: HTMLElement, pane: HTMLElement, vs: EditorView[]): void {
  const box = pane.getBoundingClientRect();
  const total = pane.scrollHeight;
  // (a pane in another tab, or one the document fits in: no scroll bar to mark)
  const items = pane.isConnected && box.width && total > pane.clientHeight + 1 ? vs.flatMap(itemsOf) : [];
  strip.hidden = !items.length;
  if (!items.length) return;
  const cs = getComputedStyle(pane);
  const borderRight = parseFloat(cs.borderRightWidth) || 0;
  const bar = pane.offsetWidth - pane.clientWidth - (parseFloat(cs.borderLeftWidth) || 0) - borderRight;
  const width = bar > 0 ? bar : OVERLAY_WIDTH;
  // over the text, the strip starts below the ruler (which stays at the top of the pane); a scroll bar runs beside it
  const ruler = bar > 0 ? null : pane.querySelector<HTMLElement>(':scope > .ruler');
  const inset = ruler?.offsetHeight ?? 0;
  const top = box.top + pane.clientTop + inset, track = pane.clientHeight - inset;
  strip.classList.toggle('overlay', bar <= 0);
  Object.assign(strip.style, { left: `${box.right - borderRight - width}px`, top: `${top}px`, width: `${width}px`, height: `${track}px` });

  // a document's y (from the top of what scrolls) times this is the strip's
  const scale = track / total, origin = box.top + pane.clientTop - pane.scrollTop;
  const marks: Mark[] = [];
  const last: Partial<Record<Mark['lane'], Mark>> = {};
  for (const it of items) {
    const a = rectAt(it.view, it.from, 1);
    if (!a) continue;
    const b = it.to > it.from ? rectAt(it.view, it.to, -1) : null;
    const y0 = Math.max(0, (a.top - origin) * scale);
    const y1 = Math.min(track, Math.max(y0 + MIN_MARK, ((b && b.bottom > a.bottom ? b.bottom : a.bottom) - origin) * scale));
    const lane = it.kind === 'comment' ? 'comment' : 'change';
    const color = it.kind === 'comment' ? 'comment' : `${it.kind}:${it.author}`;
    const prev = last[lane];
    if (prev && prev.color.split(':')[1] === color.split(':')[1] && y0 <= prev.bottom + 1) {
      prev.bottom = Math.max(prev.bottom, y1);
      prev.items.push(it);
      continue;
    }
    marks.push(last[lane] = { lane, top: Math.max(0, Math.min(y0, track - MIN_MARK)), bottom: y1, color, items: [it] });
  }
  // the same marks as before only moved (the text still settling: formulas, images, fonts) — moved
  // in place, so that the one under the pointer stays there
  const colors = marks.map(m => m.color).join(' ');
  if (strip.dataset.colors !== colors) {
    strip.dataset.colors = colors;
    strip.replaceChildren(...marks.map(m => {
      const el = document.createElement('div');
      const [kind, author] = m.color.split(':');
      el.className = `ol-scrollmark ${m.lane} ${kind}`;
      if (m.lane === 'change') el.dataset.author = author;   // its author's colour (app/shellutil.tsx applyAuthorColors)
      return el;
    }));
  }
  marks.forEach((m, i) => {
    const el = strip.children[i] as HTMLElement;
    el.style.top = `${m.top}px`;
    el.style.height = `${m.bottom - m.top}px`;
    itemsOfMark.set(el, m.items);
  });
}

export function scrollMarksPlugin(): Plugin {
  if (!observer && typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(schedule);
    window.addEventListener('resize', schedule);
  }
  return new Plugin({
    view(view) {
      views.add(view);
      observer?.observe(view.dom);   // its height changes: images, fonts, folds, the window's width
      schedule();
      return {
        update(v, prev) { if (v.state.doc !== prev.doc) schedule(); },
        destroy() { views.delete(view); observer?.unobserve(view.dom); schedule(); },
      };
    },
  });
}
