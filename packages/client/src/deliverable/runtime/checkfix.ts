/**
 * The Check pane's one-click fixes (ChecksPane.tsx), done in the frame people edit in because they
 * measure what they change: *Shrink text to fit* — the object's type made smaller until its text fits
 * its box; *Move onto the slide* — the object moved the least that brings it (and its text) back
 * inside the slide. Each is one style edit of the object, through the edits every other change takes
 * (`commit`), so it is one undo step and reaches the others like any move.
 */
import type { HtmlOp, Path } from '../protocol';
import { liveAt, slideOf, docRect } from './env';
import { commit, isLocked } from './edit';
import { ontoMoves, shiftLength } from '../checks';

/** text in `el` (or in a box inside it) that needs more room than its box gives */
function overflows(el: HTMLElement): boolean {
  for (const e of [el, ...Array.from(el.querySelectorAll<HTMLElement>('*'))]) {
    if (!(e.clientHeight > 0) || !(e.textContent ?? '').trim()) continue;
    const c = getComputedStyle(e);
    if (/(auto|scroll)/.test(c.overflowY + c.overflowX)) continue;
    if (e.scrollHeight > e.clientHeight + 3 || e.scrollWidth > e.clientWidth + 3) return true;
  }
  return false;
}

/** the largest type (CSS px, half steps) at which the object's text fits its box; null: none from a third of it up */
export function fittingSize(el: HTMLElement): number | null {
  const st = el.style, was = [st.getPropertyValue('font-size'), st.getPropertyPriority('font-size')] as const;
  const at = (v: number): boolean => { st.setProperty('font-size', `${v}px`, 'important'); return !overflows(el); };
  const fs0 = parseFloat(getComputedStyle(el).fontSize);
  let best: number | null = null;
  try {
    if (!(fs0 > 0)) return null;
    let lo = Math.max(6, fs0 / 3), hi = fs0;
    if (!at(lo)) return null;
    best = lo;
    for (let k = 0; k < 9 && hi - lo > 0.5; k++) {
      const mid = (lo + hi) / 2;
      if (at(mid)) { best = mid; lo = mid; } else hi = mid;
    }
    return Math.floor(best * 2) / 2;
  } finally {
    st.setProperty('font-size', was[0], was[1]);
    if (!was[0]) st.removeProperty('font-size');
  }
}

export function checkFix(path: Path, fix: 'fit' | 'onto'): void {
  const el = liveAt(path);
  // (on a slide not shown it measures nothing: the editor shows the slide first)
  if (!(el instanceof HTMLElement) || isLocked(el) || !el.getClientRects().length) return;
  const ops: HtmlOp[] = [];
  if (fix === 'fit') {
    const v = fittingSize(el), fs0 = parseFloat(getComputedStyle(el).fontSize);
    if (v === null || v >= fs0 - 0.01) return;
    const size = shiftLength(el.style.getPropertyValue('font-size'), fs0, v - fs0);
    el.style.setProperty('font-size', size);
    ops.push({ t: 'style', path, set: { 'font-size': size } });
  } else {
    const s = slideOf(el);
    if (!s || !s.offsetWidth) return;
    const c = getComputedStyle(el);
    if (c.position !== 'absolute' && c.position !== 'fixed') return;
    // the box and its text (text wider than its box runs past it)
    const box = el.getBoundingClientRect();
    let { left, top, right, bottom } = box;
    const range = document.createRange(); range.selectNodeContents(el);
    const t = range.getBoundingClientRect();
    if (t.width > 0 && t.height > 0) { left = Math.min(left, t.left); top = Math.min(top, t.top); right = Math.max(right, t.right); bottom = Math.max(bottom, t.bottom); }
    const f = s.getBoundingClientRect(), k = docRect(s).w / s.offsetWidth || 1;
    const { dx, dy } = ontoMoves({ left, top, right, bottom }, f);
    const set: Record<string, string> = {};
    const l = parseFloat(c.left), tp = parseFloat(c.top);
    if (Math.abs(dx) > 0.5 && Number.isFinite(l)) set.left = shiftLength(el.style.left, l, dx / k);
    if (Math.abs(dy) > 0.5 && Number.isFinite(tp)) set.top = shiftLength(el.style.top, tp, dy / k);
    if (!Object.keys(set).length) return;
    for (const [p, v] of Object.entries(set)) el.style.setProperty(p, v);
    ops.push({ t: 'style', path, set });
  }
  commit(ops);
}
