/**
 * Animations on the canvas: PowerPoint's animation pane over beamer's overlays (core html/steps.ts).
 * The editor's Animation pane (AnimationPane.tsx) lists the sequence of the slide being worked on
 * (`sequence` messages) and sends commands here (`steps`):
 *
 * - the selection made to appear or disappear on the next clicks, one click each in the order the
 *   objects were clicked (Shift+click adds to the selection in that order), or all on one click;
 * - click-in-order mode: each object clicked appears (or disappears) on the next click. Shift+click
 *   puts it on the same click as the one before. Ctrl / ⌘+click takes the part of a drawing under
 *   the pointer (an SVG's path or group), as selecting does. Escape ends the mode;
 * - an event moved a notch earlier or later, or removed; the selection shown throughout again;
 *   a list's items one by one.
 *
 * Attributes are set on the page at once, so quick clicks count from what was just added, and
 * sent to the editor as operations. The canvas marks every object with the steps it appears at
 * (blue) and disappears at (red): `badges`, drawn by edit.ts.
 */
import { parseSteps, formatSteps, sequence, appendSteps, moveStep, removeStep, clearSteps, lastStep, stepOf, type Interval, type StepEvent } from '@overlyx/core/html/steps.ts';
import type { HtmlOp, StepCmd, StepRow, StepKind } from '../protocol';
import { post, srcOf, pathOf, liveAt, slides, slideOf, docRect } from './env';
import { selection, commit, draw, visibleSlideEl } from './edit';

/** an object of a slide that takes part: its steps, and for an item of a list with data-steps, that list and its place in it */
interface Obj { el: Element; iv: Interval[]; list?: Element; n?: number }

let ordering: StepKind | null = null;
/** the slide clicked last in click-in-order mode (the pane follows it) */
let orderSlide: HTMLElement | null = null;

export const isOrdering = (): boolean => ordering !== null;

/** the objects of a slide that appear or disappear (and `extra` ones about to), in the page's order */
function objectsOf(slide: Element, extra: Element[] = []): Obj[] {
  const objs = new Map<Element, Obj>();
  for (const el of Array.from(slide.querySelectorAll('[data-step]'))) if (srcOf.has(el)) objs.set(el, { el, iv: parseSteps(el.getAttribute('data-step')) });
  for (const list of Array.from(slide.querySelectorAll(':is(ul, ol)[data-steps]'))) {
    if (!srcOf.has(list)) continue;
    const first = stepOf(list.getAttribute('data-steps'));
    Array.from(list.children).filter(c => c.localName === 'li').forEach((li, n) => {
      if (!objs.has(li) && srcOf.has(li)) objs.set(li, { el: li, iv: [[Math.max(1, first + n), null]], list, n });
    });
  }
  for (const el of extra) if (!objs.has(el)) objs.set(el, { el, iv: [[1, null]] });
  return [...objs.values()].sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
}

/** the slide the pane shows: the one clicked in order, the selection's, or the one in view */
function currentSlide(): HTMLElement | null {
  const s = selection()[0];
  return (ordering && orderSlide?.isConnected ? orderSlide : null) || (s && slideOf(s)) || visibleSlideEl();
}

/** the steps worked out written to the page and sent as operations */
function apply(objs: Obj[], next: Interval[][]): void {
  const ops: HtmlOp[] = [];
  const set = (el: Element, name: string, value: string | null) => {
    if (el.getAttribute(name) === value) return;
    const path = pathOf(el);
    if (!path) return;
    if (value === null) el.removeAttribute(name); else el.setAttribute(name, value);
    ops.push({ t: 'attr', path, name, value });
  };
  // a list's items still one step after another: its data-steps (from the step of its first item);
  // otherwise each item gets its own data-step
  const lists = new Map<Element, number[]>();
  objs.forEach((o, i) => { if (o.list) { const l = lists.get(o.list); if (l) l.push(i); else lists.set(o.list, [i]); } });
  for (const [list, idx] of lists) {
    const o0 = objs[idx[0]], iv0 = next[idx[0]];
    const first = iv0.length === 1 && iv0[0][1] === null ? iv0[0][0] - o0.n! : NaN;
    const inTurn = idx.every(i => formatSteps(next[i]) === formatSteps([[Math.max(1, first + objs[i].n!), null]]));
    if (inTurn && first >= 1) { set(list, 'data-steps', String(first)); for (const i of idx) set(objs[i].el, 'data-step', null); }
    else { set(list, 'data-steps', null); for (const i of idx) set(objs[i].el, 'data-step', formatSteps(next[i])); }
  }
  objs.forEach((o, i) => { if (!o.list) set(o.el, 'data-step', formatSteps(next[i])); });
  if (!ops.length) return;
  commit(ops, { select: 'keep' });
  dirty = true;
  draw();
  postSequence();
}

export function stepCommand(cmd: StepCmd): void {
  if (cmd.how === 'order') {
    orderSlide = cmd.kind ? currentSlide() : null;
    ordering = cmd.kind;
    draw();
    postSequence();
    return;
  }
  const slide = currentSlide();
  if (!slide) return;
  const sel = selection().filter(e => slideOf(e) === slide);
  if (cmd.how === 'add') {
    const objs = objectsOf(slide, sel);
    const picks = sel.map((e, i) => ({ obj: objs.findIndex(o => o.el === e), kind: cmd.kind, together: !!cmd.together && i > 0 }));
    apply(objs, appendSteps(objs.map(o => o.iv), picks));
  } else if (cmd.how === 'move' || cmd.how === 'remove') {
    const el = liveAt(cmd.path);
    const objs = objectsOf(slide);
    const i = objs.findIndex(o => o.el === el);
    if (i < 0) return;
    const ivs = objs.map(o => o.iv);
    const next = cmd.how === 'move' ? moveStep(ivs, { obj: i, step: cmd.step }, cmd.dir) : removeStep(ivs, { obj: i, step: cmd.step });
    if (next) apply(objs, next);
  } else if (cmd.how === 'clear') {
    const objs = objectsOf(slide);
    // (a selected list: its items too)
    const which = objs.map((o, i) => (sel.includes(o.el) || (o.list && sel.includes(o.list)) ? i : -1)).filter(i => i >= 0);
    apply(objs, clearSteps(objs.map(o => o.iv), which));
  } else if (cmd.how === 'list') {
    const list = liveAt(cmd.path);
    if (!list) return;
    if (cmd.on) {
      // its items one after the other on the clicks after the slide's last step — on a slide with
      // nothing else animated the first item with the slide (beamer's [<+->])
      const items = Array.from(list.children).filter(c => c.localName === 'li');
      const all = objectsOf(slide, items);
      for (const o of all) { const n = items.indexOf(o.el); if (n >= 0) { o.list = list; o.n = n; } }
      const others = all.filter(o => !items.includes(o.el));
      const later = lastStep(others.map(o => o.iv)) === 1 ? items.slice(1) : items;
      const ivs = all.map(o => (items.includes(o.el) ? [[1, null]] as Interval[] : o.iv));
      apply(all, appendSteps(ivs, later.map(li => ({ obj: all.findIndex(o => o.el === li), kind: 'appear' as const }))));
    } else {
      const objs = objectsOf(slide);
      apply(objs, clearSteps(objs.map(o => o.iv), objs.map((o, i) => (o.list === list ? i : -1)).filter(i => i >= 0)));
    }
  }
}

/** click-in-order mode: the object clicked appears (disappears) on the next click — `together`: on the click before's */
export function orderClick(el: Element, together: boolean): void {
  const slide = slideOf(el);
  if (!ordering || !slide) return;
  orderSlide = slide;
  const objs = objectsOf(slide, [el]);
  apply(objs, appendSteps(objs.map(o => o.iv), [{ obj: objs.findIndex(o => o.el === el), kind: ordering, together }]));
}

/** Escape in click-in-order mode */
export function stopOrdering(): void {
  if (!ordering) return;
  ordering = null;
  draw();
  postSequence();
}

/* ------------------------------------------------------------------ what the pane and the canvas show */

/** a short name for a row of the pane */
function rowLabel(el: Element): string {
  const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (el instanceof SVGElement && el.localName !== 'svg') {
    const same = el.parentElement ? Array.from(el.parentElement.children).filter(c => c.localName === el.localName) : [el];
    const name = `${el.localName === 'g' ? 'group' : el.localName} ${el.id ? `“${el.id}”` : same.indexOf(el) + 1}`;
    return `Drawing ▸ ${name}${t ? `: ${t.slice(0, 20)}` : ''}`;
  }
  if (t) return (el.localName === 'li' ? '• ' : '') + (t.length > 40 ? t.slice(0, 39) + '…' : t);
  const kind = el.querySelector('mjx-container') || el.localName === 'mjx-container' ? 'Formula'
    : el.localName === 'img' || el.querySelector(':scope > img') || el.classList.contains('ol-crop') ? 'Picture'
    : el.localName === 'svg' || el.querySelector(':scope > svg') ? 'Drawing' : 'Shape';
  return el.id ? `${kind} “${el.id}”` : kind;
}

let lastSent = '';

/** the pane's rows for the slide worked on (sent when they changed) */
export function postSequence(): void {
  const slide = currentSlide();
  const index = slide ? slides().indexOf(slide) : -1;
  const objs = slide ? objectsOf(slide) : [];
  const ivs = objs.map(o => o.iv);
  const sel = new Set(selection());
  const rows: StepRow[] = sequence(ivs).flatMap(e => {
    const o = objs[e.obj], path = pathOf(o.el);
    return path ? [{ path, label: rowLabel(o.el), kind: e.kind, step: e.step, up: !!moveStep(ivs, e, -1), down: !!moveStep(ivs, e, 1), selected: sel.has(o.el) || (!!o.list && sel.has(o.list)) }] : [];
  });
  const msg = { ol: 'sequence' as const, slide: index, rows, steps: lastStep(ivs), ordering };
  const key = JSON.stringify(msg);
  if (key === lastSent) return;
  lastSent = key;
  post(msg);
}

/** every slide's animated objects and their events (worked out again after the page changed) */
let cache: { el: Element; events: StepEvent[] }[] = [];
let dirty = true;
export function stepsChanged(): void { dirty = true; }

/** the canvas's marks: by each animated object's top-left corner, the steps it appears (blue) and disappears (red) at */
export function badges(): string {
  if (dirty) {
    cache = [];
    for (const slide of slides()) {
      const objs = objectsOf(slide);
      const ev = sequence(objs.map(o => o.iv));
      objs.forEach((o, i) => { const events = ev.filter(e => e.obj === i); if (events.length) cache.push({ el: o.el, events }); });
    }
    dirty = false;
  }
  let out = '';
  for (const { el, events } of cache) {
    if (!el.isConnected) continue;
    const r = docRect(el);
    if (!r.w && !r.h) continue;
    out += `<div class="steps${ordering ? ' ordering' : ''}" style="left:${r.x}px;top:${r.y}px">${events.map(e => `<span class="step ${e.kind}">${e.step}</span>`).join('')}</div>`;
  }
  return out;
}

export const STEPS_CSS = `.steps { position: absolute; display: flex; gap: calc(2px * var(--s)); transform: translate(calc(-100% - 5px * var(--s)), 0); pointer-events: none; }
    .step { min-width: calc(16px * var(--s)); height: calc(16px * var(--s)); line-height: calc(16px * var(--s)); padding: 0 calc(3px * var(--s)); box-sizing: border-box; border-radius: calc(8px * var(--s)); background: #2f6fde; color: #fff; text-align: center; font: 600 calc(10px * var(--s)) system-ui, sans-serif; box-shadow: 0 0 0 calc(1.5px * var(--s)) #fff; }
    .step.disappear { background: #d2453c; }
    .steps.ordering .step { min-width: calc(20px * var(--s)); height: calc(20px * var(--s)); line-height: calc(20px * var(--s)); border-radius: calc(10px * var(--s)); font-size: calc(12px * var(--s)); }`;
