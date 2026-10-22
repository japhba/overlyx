/**
 * Draw on slides, posters and web pages (the deck toolbar's Draw): a pen and a highlighter, each with
 * its own colour and width presets as in the documents' margin ink (inkToolbar.tsx, GoodNotes) — one
 * click picks a preset, a click on the picked one changes it. The same colours as the documents'
 * pens; widths are px of a 1280 px wide slide (the strokes are SVG paths in the page, sourceops.ts
 * objectHtml), shown in points like the other line weights (units.ts). Kept in this browser (`ol.deckInk`).
 */
import { INK_PALETTES, HIGHLIGHT_OPACITY } from '@overlyx/core/inkpresets.ts';
import type { InkStyle, Nib } from './protocol';

export type DeckPen = 'pen' | 'highlighter';
export interface DeckPenSet { color: string; width: number; colors: string[]; widths: number[] }
/**
 * The eraser's settings (GoodNotes'): whole strokes or only the part under it (precise), its size, the
 * highlighter's strokes alone (the writing under them kept), and back to the pen after each erasing
 */
export interface EraserSet { precise: boolean; size: 0 | 1 | 2; hlOnly: boolean; back: boolean }
/** what the lasso takes (GoodNotes' lasso settings): handwriting, shapes, pictures, text — or of these the ones listed */
export type LassoKind = 'ink' | 'shapes' | 'pictures' | 'text';
export const LASSO_KINDS: LassoKind[] = ['ink', 'shapes', 'pictures', 'text'];
/** the eraser's radius at each size (screen px) */
export const ERASER_PX = [5, 10, 20] as const;
export interface DeckInk {
  pen: DeckPen;
  pens: Record<DeckPen, DeckPenSet>;
  /** the pen's settings (GoodNotes'): ball or fountain, tip, pressure, stabilization, rounding, the usual pressure */
  nib: Nib;
  /** a Pencil has drawn in this browser: fingers move the slide (unless `fingersDraw`) */
  pencil: boolean;
  fingersDraw: boolean;
  /** scribbling over strokes erases them */
  scribble: boolean;
  /** a pen (the Pencil, a stylus) draws as soon as it touches the page or a document's margin, without Draw turned on (Apple's HIG) */
  penInks: boolean;
  /** a stroke drawn and held still at its end becomes the shape it was meant to be (core/shapesnap.ts) */
  snap: boolean;
  eraser: EraserSet;
  /** the kinds of thing the lasso takes */
  lasso: LassoKind[];
}

/** the width presets (px of a 1280 px slide: 1½, 3, 6 pt; the highlighter's 10½, 18, 30 pt) and what the width picker offers */
export const DECK_INK_WIDTHS: Record<DeckPen, number[]> = { pen: [2, 4, 8], highlighter: [14, 24, 40] };
export const DECK_INK_WIDTH_CHOICES: Record<DeckPen, number[]> = { pen: [1, 2, 3, 4, 6, 8, 12, 16, 24], highlighter: [8, 12, 16, 20, 24, 32, 40, 56, 72] };

const KEY = 'ol.deckInk';

/**
 * the pen as it comes: a fountain pen with round ends, a little pressure, a round tip, no smoothing,
 * a little rounding (whole-px steps mostly gone, corners within a fifth of a px), the Pencil's usual
 * pressure
 */
export const DEFAULT_NIB: Nib = { ball: false, sharpness: 0, sensitivity: 0.25, flatness: 0, stabilization: 0, rounding: 0.3, usual: 0.25 };
const NIB_LEVELS = ['sharpness', 'sensitivity', 'flatness', 'stabilization', 'rounding', 'usual'] as const;
const isLevel = (v: unknown): v is number => typeof v === 'number' && v >= 0 && v <= 1;

/** a pen's settings with `p` taken over (each level kept between 0 and 1) */
function nibWith(n: Nib, p: Partial<Nib> | undefined): Nib {
  const out = { ...n };
  if (!p) return out;
  if (typeof p.ball === 'boolean') out.ball = p.ball;
  for (const k of NIB_LEVELS) if (isLevel(p[k])) out[k] = Math.round(p[k]! * 100) / 100;
  out.usual = Math.max(0.05, Math.min(0.95, out.usual));
  return out;
}

export function defaultDeckInk(): DeckInk {
  return {
    pen: 'pen',
    nib: { ...DEFAULT_NIB },
    pencil: false,
    fingersDraw: false,
    scribble: true,
    penInks: true,
    snap: true,
    eraser: { precise: false, size: 1, hlOnly: false, back: false },
    lasso: [...LASSO_KINDS],
    pens: {
      pen: { color: INK_PALETTES.pen[0][0], width: DECK_INK_WIDTHS.pen[1], colors: INK_PALETTES.pen.map(c => c[0]), widths: [...DECK_INK_WIDTHS.pen] },
      highlighter: { color: INK_PALETTES.highlighter[0][0], width: DECK_INK_WIDTHS.highlighter[1], colors: INK_PALETTES.highlighter.map(c => c[0]), widths: [...DECK_INK_WIDTHS.highlighter] },
    },
  };
}

const isColor = (c: unknown): c is string => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c);
const isWidth = (w: unknown): w is number => typeof w === 'number' && w > 0 && w <= 200;

/** this browser's presets (the defaults for anything missing or broken) */
export function loadDeckInk(): DeckInk {
  const ink = defaultDeckInk();
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<DeckInk> | null;
    if (!s || typeof s !== 'object') return ink;
    if (s.pen === 'pen' || s.pen === 'highlighter') ink.pen = s.pen;
    if (s.nib && typeof s.nib === 'object') ink.nib = nibWith(ink.nib, s.nib);
    for (const k of ['pencil', 'fingersDraw', 'scribble', 'penInks', 'snap'] as const) if (typeof s[k] === 'boolean') ink[k] = s[k]!;
    if (s.eraser && typeof s.eraser === 'object') ink.eraser = eraserWith(ink.eraser, s.eraser);
    if (Array.isArray(s.lasso)) { const k = LASSO_KINDS.filter(x => s.lasso!.includes(x)); if (k.length) ink.lasso = k; }
    for (const p of ['pen', 'highlighter'] as DeckPen[]) {
      const v = s.pens?.[p];
      if (!v) continue;
      const def = ink.pens[p];
      const colors = Array.isArray(v.colors) && v.colors.length === def.colors.length && v.colors.every(isColor) ? v.colors : def.colors;
      const widths = Array.isArray(v.widths) && v.widths.length === def.widths.length && v.widths.every(isWidth) ? v.widths : def.widths;
      ink.pens[p] = { colors, widths, color: isColor(v.color) ? v.color : def.color, width: isWidth(v.width) ? v.width : def.width };
    }
  } catch { /* private window, or not ours */ }
  return ink;
}

function eraserWith(e: EraserSet, p: Partial<EraserSet>): EraserSet {
  const out = { ...e };
  for (const k of ['precise', 'hlOnly', 'back'] as const) if (typeof p[k] === 'boolean') out[k] = p[k]!;
  if (p.size === 0 || p.size === 1 || p.size === 2) out.size = p.size;
  return out;
}

const subscribers = new Set<(ink: DeckInk) => void>();
export function subscribeDeckInk(fn: (ink: DeckInk) => void): () => void { subscribers.add(fn); return () => subscribers.delete(fn); }

export function saveDeckInk(ink: DeckInk): void {
  try { localStorage.setItem(KEY, JSON.stringify(ink)); } catch { /* private window */ }
  for (const fn of subscribers) fn(ink);
}

export interface DeckInkPatch {
  pen?: DeckPen;
  color?: string;
  width?: number;
  /** a colour preset of the pen in hand replaced (and picked) */
  slotColor?: { idx: number; color: string };
  /** a width preset of the pen in hand replaced (and picked) */
  slotWidth?: { idx: number; width: number };
  /** the pen's settings changed */
  nib?: Partial<Nib>;
  pencil?: boolean;
  fingersDraw?: boolean;
  scribble?: boolean;
  penInks?: boolean;
  snap?: boolean;
  eraser?: Partial<EraserSet>;
  lasso?: LassoKind[];
}

/** the presets after a change (a new object: the old one is left as it was) */
export function patchDeckInk(ink: DeckInk, p: DeckInkPatch): DeckInk {
  const pen = p.pen ?? ink.pen;
  const cur = { ...ink.pens[pen], colors: [...ink.pens[pen].colors], widths: [...ink.pens[pen].widths] };
  if (p.color && isColor(p.color)) cur.color = p.color;
  if (p.width && isWidth(p.width)) cur.width = p.width;
  if (p.slotColor && isColor(p.slotColor.color) && cur.colors[p.slotColor.idx] !== undefined) {
    cur.colors[p.slotColor.idx] = p.slotColor.color;
    cur.color = p.slotColor.color;
  }
  if (p.slotWidth && isWidth(p.slotWidth.width) && cur.widths[p.slotWidth.idx] !== undefined) {
    cur.widths[p.slotWidth.idx] = p.slotWidth.width;
    cur.width = p.slotWidth.width;
  }
  const flag = (k: 'pencil' | 'fingersDraw' | 'scribble' | 'penInks' | 'snap') => (typeof p[k] === 'boolean' ? p[k]! : ink[k]);
  const lasso = p.lasso ? LASSO_KINDS.filter(k => p.lasso!.includes(k)) : ink.lasso;
  return {
    pen, pens: { ...ink.pens, [pen]: cur }, nib: nibWith(ink.nib, p.nib), pencil: flag('pencil'), fingersDraw: flag('fingersDraw'), scribble: flag('scribble'), penInks: flag('penInks'),
    snap: flag('snap'), eraser: p.eraser ? eraserWith(ink.eraser, p.eraser) : ink.eraser, lasso: lasso.length ? lasso : ink.lasso,
  };
}

/** the ink of the next stroke: the pen in hand, its width for a page `pageW` px wide (a poster's strokes as thick, seen whole, as a slide's) */
export function deckInkStyle(ink: DeckInk, pageW = 1280): InkStyle {
  const p = ink.pens[ink.pen];
  const hl = ink.pen === 'highlighter';
  const fingers = ink.fingersDraw ? 'draw' as const : ink.pencil ? 'pan' as const : undefined;
  return {
    color: p.color, width: Math.round(p.width * Math.max(0.25, pageW / 1280) * 10) / 10, opacity: hl ? HIGHLIGHT_OPACITY : 1,
    ...(hl ? {} : { nib: { ...ink.nib } }), ...(fingers ? { fingers } : {}), scribble: ink.scribble, penInks: ink.penInks,
    snap: ink.snap, eraser: { ...ink.eraser }, lasso: { kinds: [...ink.lasso], colors: [...lassoColors] },
  };
}

/**
 * The lasso's colour filter: only what has one of these colours (lower-case #rrggbb) is taken; none:
 * any colour. Picked from the colours used where the lasso is (a slide, a board, a margin) and kept
 * for this visit only — another slide has other colours.
 */
let lassoColors: string[] = [];
export function getLassoColors(): string[] { return lassoColors; }
/** (told as a change of the presets: what shows them and what draws with them follow) */
export function setLassoColors(colors: string[]): void {
  lassoColors = [...new Set(colors.map(c => c.toLowerCase()))];
  const ink = loadDeckInk();
  for (const fn of subscribers) fn(ink);
}

/** a CSS colour as lower-case #rrggbb (rgb() / rgba() / #rgb / #rrggbb), null for none, transparent or what can't be read */
export function hexColor(c: string | null | undefined): string | null {
  if (!c) return null;
  const t = c.trim().toLowerCase();
  let m = /^#([0-9a-f]{6})$/.exec(t);
  if (m) return '#' + m[1];
  m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(t);
  if (m) return '#' + m[1] + m[1] + m[2] + m[2] + m[3] + m[3];
  m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(t);
  if (m) {
    if (m[4] !== undefined && parseFloat(m[4]) === 0) return null;
    return '#' + [m[1], m[2], m[3]].map(v => Math.min(255, Number(v)).toString(16).padStart(2, '0')).join('');
  }
  return null;
}

/** whether something of these colours passes the lasso's colour filter */
export function colorsPass(filter: readonly string[], colors: readonly (string | null | undefined)[]): boolean {
  if (!filter.length) return true;
  return colors.some(c => { const h = hexColor(c); return !!h && filter.includes(h); });
}

/** the size of a width preset's dot in the toolbar (screen px) */
export function deckInkDot(pen: DeckPen, w: number): number {
  return Math.round(Math.max(3, Math.min(14, pen === 'pen' ? 2.5 + w * 0.8 : 4 + w / 5)));
}
