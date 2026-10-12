/**
 * Guides on a deck's slides (the user, 12 Oct 2026: "guidelines + an option to reset them, possibly
 * tied to a slide master"), as PowerPoint's: lines across the slide that objects snap to as they are
 * moved or resized, drawn on the canvas only (runtime/guides.ts) — never in a slide, a presentation or
 * an export. Shown or not is this browser's (`ol.deckGuides`, off at first, as PowerPoint's View ▸
 * Guides).
 *
 * In the HTML as `data-ol-guides` — "x640 y360": slide px from the slide's left / top edge —:
 * - on <body>, the master's: every slide's. With no attribute the master's are the slide's middle
 *   lines (PowerPoint's guides when first shown); an empty one: none.
 * - on a slide's <section>, that slide's own, besides the master's.
 * Reset: a slide's own go (the master's stay); all reset, the master's are the middle lines again.
 */

export type Axis = 'x' | 'y';
export interface Guide { axis: Axis; at: number }

export const GUIDES_ATTR = 'data-ol-guides';

/** two guides this near (slide px) are one */
const SAME = 0.5;

export function parseGuides(v: string | null | undefined): Guide[] {
  const out: Guide[] = [];
  for (const m of (v ?? '').matchAll(/([xy])\s*(-?\d+(?:\.\d+)?)/g)) out.push({ axis: m[1] as Axis, at: Number(m[2]) });
  return out;
}

/** the attribute's value: vertical guides (x) first, each axis in order, on half px */
export function formatGuides(gs: readonly Guide[]): string {
  const r = (n: number) => Math.round(n * 2) / 2;
  const uniq = dedupe(dedupe(gs).map(g => ({ axis: g.axis, at: r(g.at) })));
  return uniq.sort((a, b) => (a.axis === b.axis ? a.at - b.at : a.axis === 'x' ? -1 : 1)).map(g => `${g.axis}${g.at}`).join(' ');
}

const same = (a: Guide, b: Guide) => a.axis === b.axis && Math.abs(a.at - b.at) < SAME;

export function dedupe(gs: readonly Guide[]): Guide[] {
  const out: Guide[] = [];
  for (const g of gs) if (!out.some(o => same(o, g))) out.push(g);
  return out;
}

/** the master's guides on a slide `w` × `h` px: the attribute's, or (none written) the slide's middle lines */
export function masterGuides(attr: string | null | undefined, w: number, h: number): Guide[] {
  return attr === null || attr === undefined ? [{ axis: 'x', at: w / 2 }, { axis: 'y', at: h / 2 }] : parseGuides(attr);
}

export const withGuide = (gs: readonly Guide[], g: Guide): Guide[] => dedupe([...gs, g]);
export const withoutGuide = (gs: readonly Guide[], g: Guide): Guide[] => gs.filter(o => !same(o, g));
/** `from` moved to `to` (`copy`: it stays, a new one at `to`) */
export const movedGuide = (gs: readonly Guide[], from: Guide, to: number, copy = false): Guide[] =>
  withGuide(copy ? gs : withoutGuide(gs, from), { axis: from.axis, at: to });

/** a guide's place in words: from the slide's left or top edge, in points (a 1280 px slide is 960 pt, PowerPoint's 13.33 in) */
export const guideLabel = (g: Guide): string => `${Math.round(g.at * 0.75)} pt`;
