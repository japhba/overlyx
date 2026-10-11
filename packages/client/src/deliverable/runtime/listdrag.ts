/**
 * A slide's list items move by drag and drop, as a document's do (editor/plugins/listdrag.ts): with
 * the list's text box selected or being retyped, a grip shows left of the item under the pointer
 * (left of every item for a finger or a pen, which do not hover). Dragged up or down it carries the
 * item with what is nested in it; a line shows where it lands — between the items of any list of
 * that box, a nested one included; where two places meet (the end of a nested list and the next item
 * of the outer one) how far right the pointer is picks the list. Esc cancels. The text being retyped
 * changes in place (sent as the retyping is); otherwise the move is one operation on the source —
 * one undo step. Alt+↑ / Alt+↓ move the item the caret is in while retyping.
 */
import type { HtmlOp, Path } from '../protocol';
import { pathOf, docRect, srcOf } from './env';

export interface ListDragContext {
  /** frame px → screen px */
  scale(): number;
  /** the box whose lists have grips: the text being retyped, else the one object selected */
  box(): HTMLElement | null;
  editing(): HTMLElement | null;
  draw(): void;
  /** the text being retyped changed (in place): it is sent as typing is */
  edited(): void;
  commit(ops: HtmlOp[]): void;
}

let ctx: ListDragContext | null = null;
export function initListDrag(c: ListDragContext): void { ctx = c; }

const GRIP_BG = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 16"><g fill="#5f6b7e"><circle cx="3" cy="3" r="1.4"/><circle cx="7" cy="3" r="1.4"/><circle cx="3" cy="8" r="1.4"/><circle cx="7" cy="8" r="1.4"/><circle cx="3" cy="13" r="1.4"/><circle cx="7" cy="13" r="1.4"/></g></svg>')}")`;
export const LIST_DRAG_CSS = `
    .ligrip { position: absolute; pointer-events: auto; touch-action: none; cursor: grab; border-radius: calc(3px * var(--s)); background: ${GRIP_BG} center / 62% no-repeat; }
    .ligrip:hover, .ligrip.on { background-color: rgba(47,111,222,.14); }
    .lidrop { position: absolute; background: #2f6fde; pointer-events: none; border-radius: 1px; }
    .lidrop::before { content: ''; position: absolute; left: calc(-7px * var(--s)); top: calc(-3px * var(--s)); width: calc(8px * var(--s)); height: calc(8px * var(--s)); border-radius: 50%; border: calc(2px * var(--s)) solid #2f6fde; background: #fff; box-sizing: border-box; }
    .lisrc { position: absolute; pointer-events: none; border-radius: calc(3px * var(--s)); background: rgba(47,111,222,.08); outline: calc(1px * var(--s)) dashed rgba(47,111,222,.6); }`;

let hoverLi: HTMLLIElement | null = null;
/** the last pointer was a finger or a pen: every item of the box has its grip */
let touchy = false;

/** a place for the dragged item: before `before` in `list` (null: at its end) */
export interface Target { list: HTMLElement; before: Element | null; y: number; x: number; right: number }
interface LiDrag { li: HTMLLIElement; pointerId: number; x0: number; y0: number; started: boolean; targets: Target[]; target: Target | null; last: { x: number; y: number } }
let ld: LiDrag | null = null;

export const listDragging = (): boolean => !!ld;

const isList = (el: Element | null): el is HTMLElement => !!el && (el.localName === 'ul' || el.localName === 'ol');
const itemsOf = (box: Element): HTMLLIElement[] => Array.from(box.querySelectorAll('li')).filter(li => isList(li.parentElement)) as HTMLLIElement[];
const listsOf = (box: Element): HTMLElement[] => [...(isList(box) ? [box] : []), ...(Array.from(box.querySelectorAll('ul, ol')) as HTMLElement[])];
const kidsOf = (list: Element, but?: Element): HTMLLIElement[] => Array.from(list.children).filter(c => c.localName === 'li' && c !== but) as HTMLLIElement[];

/** a press on the page: a finger or a pen shows every item's grip (they do not hover) */
export function notePointer(e: PointerEvent): void { touchy = e.pointerType === 'touch' || e.pointerType === 'pen'; }

/** the pointer moved over the page: the item under it (its grip); true when the grips changed */
export function hoverList(e: PointerEvent, overlayHost: Element): boolean {
  if (ld || !ctx) return false;
  const was = touchy;
  notePointer(e);
  if (e.target === overlayHost) return was !== touchy;   // over a grip: it stays
  const box = ctx.box();
  let li: HTMLLIElement | null = null;
  if (box) {
    const t = e.target as Element | null;
    const hit = t?.closest?.('li') as HTMLLIElement | null;
    if (hit && box.contains(hit) && isList(hit.parentElement)) li = hit;
    // left of the items, where the bullets and the grips are
    else if (box.contains(t) || t === box) li = itemsOf(box).reverse().find(l => { const r = l.getBoundingClientRect(); return e.clientY >= r.top && e.clientY <= r.bottom && e.clientX < r.left; }) ?? null;
  }
  if (li === hoverLi && was === touchy) return false;
  hoverLi = li;
  return true;
}

/** the grip of one item (frame px): left of its marker, at the middle of its first line */
function gripBox(li: HTMLLIElement, s: number): { x: number; y: number; w: number; h: number } {
  const r = docRect(li);
  const cs = getComputedStyle(li);
  const k = li.offsetWidth ? r.w / li.offsetWidth : 1;
  const fs = parseFloat(cs.fontSize) * k;
  const lh = (cs.lineHeight === 'normal' ? 1.2 * parseFloat(cs.fontSize) : parseFloat(cs.lineHeight)) * k;
  const w = (touchy ? 22 : 14) / s, h = (touchy ? 30 : 20) / s;
  const marker = cs.listStylePosition === 'inside' ? 0 : 1.3 * fs;
  return { x: r.x - marker - w, y: r.y + Math.min(lh, r.h) / 2 - h / 2, w, h };
}

/** what draw() adds to the overlay: the grips, or while dragging the item's place and where it would go */
export function listParts(): string {
  if (!ctx) return '';
  const s = ctx.scale();
  if (ld?.started) {
    const parts: string[] = [];
    if (ld.li.isConnected) { const r = docRect(ld.li); parts.push(`<div class="lisrc" style="left:${r.x - 3 / s}px;top:${r.y}px;width:${r.w + 6 / s}px;height:${r.h}px"></div>`); }
    const t = ld.target;
    if (t) parts.push(`<div class="lidrop" style="left:${t.x}px;top:${t.y - 1 / s}px;width:${Math.max(20 / s, t.right - t.x)}px;height:${2 / s}px"></div>`);
    return parts.join('');
  }
  const box = ctx.box();
  if (!box || !box.isConnected) return '';
  const items = itemsOf(box);
  if (!items.length) return '';
  const shown = touchy ? items : hoverLi && items.includes(hoverLi) ? [hoverLi] : [];
  return shown.map(li => {
    const g = gripBox(li, s);
    return `<div class="ligrip" data-li="${items.indexOf(li)}" title="Drag to move the item" style="left:${g.x}px;top:${g.y}px;width:${g.w}px;height:${g.h}px"></div>`;
  }).join('');
}

/** the grips drawn: pressed, they start a drag */
export function bindListGrips(layer: HTMLElement): void {
  const box = ctx?.box();
  if (!box) return;
  const items = itemsOf(box);
  for (const g of Array.from(layer.querySelectorAll('.ligrip'))) {
    g.addEventListener('pointerdown', e => { const li = items[Number((g as HTMLElement).dataset.li)]; if (li) gripDown(e as PointerEvent, li); }, true);
  }
}

function gripDown(e: PointerEvent, li: HTMLLIElement): void {
  if (!ctx || (e.pointerType === 'mouse' && e.button !== 0)) return;
  e.preventDefault();
  e.stopPropagation();
  ld = { li, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, started: false, targets: [], target: null, last: { x: e.clientX, y: e.clientY } };
  addEventListener('pointermove', onMove, true);
  addEventListener('pointerup', onUp, true);
  addEventListener('pointercancel', onCancel, true);
  addEventListener('keydown', onKey, true);
}

/** the places the item can go: before each item of every list of its box (not its own nested lists), and at each list's end */
function targetsFor(li: HTMLLIElement, box: HTMLElement): Target[] {
  const out: Target[] = [];
  for (const list of listsOf(box)) {
    if (li.contains(list)) continue;
    const kids = kidsOf(list, li);
    const lr = docRect(list);
    const cs = getComputedStyle(list);
    const k = list.offsetWidth ? lr.w / list.offsetWidth : 1;
    const left = kids.length ? docRect(kids[0]).x : lr.x + parseFloat(cs.paddingLeft) * k;
    const fs = parseFloat(cs.fontSize) * k;
    let prevBottom: number | null = null;
    for (const kid of kids) {
      const r = docRect(kid);
      out.push({ list, before: kid, y: prevBottom === null ? r.y : (prevBottom + r.y) / 2, x: left - 1.3 * fs, right: lr.x + lr.w });
      prevBottom = r.y + r.h;
    }
    out.push({ list, before: null, y: prevBottom ?? lr.y + lr.h / 2, x: left - 1.3 * fs, right: lr.x + lr.w });
  }
  return out;
}

/** the place under the pointer (frame px): the nearest line; of places at about that height, the innermost list the pointer is right of */
export function pick(targets: Target[], x: number, y: number, s: number): Target | null {
  if (!targets.length) return null;
  const best = Math.min(...targets.map(t => Math.abs(t.y - y)));
  const near = targets.filter(t => Math.abs(t.y - y) <= best + 8 / s);
  const right = near.filter(t => t.x <= x + 12 / s);
  if (right.length) return right.reduce((a, b) => (b.x > a.x ? b : a));
  return near.reduce((a, b) => (b.x < a.x ? b : a));
}

function onMove(e: PointerEvent): void {
  if (!ld || !ctx || e.pointerId !== ld.pointerId) return;
  e.preventDefault();
  e.stopPropagation();
  ld.last = { x: e.clientX, y: e.clientY };
  if (!ld.started) {
    if (Math.hypot(e.clientX - ld.x0, e.clientY - ld.y0) < 4) return;
    const box = ctx.box();
    if (!box) { end(false); return; }
    ld.started = true;
    ld.targets = targetsFor(ld.li, box);
    document.documentElement.classList.add('ol-dragging');
  }
  const p = { x: e.pageX, y: e.pageY };
  ld.target = pick(ld.targets, p.x, p.y, ctx.scale());
  ctx.draw();
}

function onUp(e: PointerEvent): void {
  if (!ld || e.pointerId !== ld.pointerId) return;
  e.preventDefault();
  e.stopPropagation();
  end(ld.started);
}
function onCancel(e: PointerEvent): void { if (ld && e.pointerId === ld.pointerId) end(false); }
function onKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || !ld) return;
  e.preventDefault();
  e.stopPropagation();
  end(false);
}

function end(drop: boolean): void {
  const d = ld;
  ld = null;
  removeEventListener('pointermove', onMove, true);
  removeEventListener('pointerup', onUp, true);
  removeEventListener('pointercancel', onCancel, true);
  removeEventListener('keydown', onKey, true);
  document.documentElement.classList.remove('ol-dragging');
  if (d && drop && d.target) moveItem(d.li, d.target.list, d.target.before);
  ctx?.draw();
}

/** a list left empty by its last item going: it goes too (a nested list inside an item) */
const emptied = (list: Element, li: Element): boolean => kidsOf(list, li).length === 0 && Array.from(list.children).every(c => c === li);

/** the item moved before `before` in `list` (null: to its end) — in place while retyping, else as an operation */
export function moveItem(li: HTMLLIElement, list: HTMLElement, before: Element | null): void {
  if (!ctx) return;
  const from = li.parentElement;
  if (!from || (from === list && (before === li || before === li.nextElementSibling))) return;
  const editing = ctx.editing();
  if (editing && editing.contains(li)) {
    // the caret is kept where it was in the item (moving an element out and back in drops the selection)
    const sel = getSelection();
    const keep = sel && sel.rangeCount && li.contains(sel.anchorNode) ? { n: sel.anchorNode!, o: sel.anchorOffset, fn: sel.focusNode!, fo: sel.focusOffset } : null;
    const drop = emptied(from, li) && from !== editing && from.parentElement?.localName === 'li' ? from : null;
    list.insertBefore(li, before);
    drop?.remove();
    if (keep) try { sel!.setBaseAndExtent(keep.n, keep.o, keep.fn, keep.fo); } catch { /* gone */ }
    ctx.edited();
    return;
  }
  const path = pathOf(li), parent = pathOf(list);
  if (!path || !parent) return;
  // the index among the list's element children without the item itself (core html/source.ts `move`)
  const sibs = Array.from(list.children).filter(c => c !== li);
  const index = before ? sibs.indexOf(before) : sibs.length;
  if (index < 0) return;
  const fromPath = pathOf(from);
  if (emptied(from, li) && from.parentElement?.localName === 'li' && fromPath) {
    // its list would be left empty: the list goes, the item is written again where it goes
    const src = srcOf.get(li);
    if (!src) return;
    ctx.commit([{ t: 'remove', paths: [fromPath] }, { t: 'insert', parent, index: before ? Array.from(list.children).indexOf(before) : list.children.length, html: src.outerHTML }]);
    return;
  }
  ctx.commit([{ t: 'move', path: path as Path, parent: parent as Path, index }]);
}

/** Alt+↑ / Alt+↓ while retyping: the item the caret is in swaps with the one before / after it */
export function stepItem(dir: -1 | 1): boolean {
  const editing = ctx?.editing();
  const at = getSelection()?.anchorNode;
  const li = (at instanceof Element ? at : at?.parentElement)?.closest('li') as HTMLLIElement | null;
  if (!editing || !li || !editing.contains(li) || !isList(li.parentElement)) return false;
  const list = li.parentElement;
  if (dir < 0) {
    const prev = li.previousElementSibling;
    if (prev) moveItem(li, list, prev);
  } else {
    const next = li.nextElementSibling;
    if (next) moveItem(li, list, next.nextElementSibling);
  }
  return true;
}
