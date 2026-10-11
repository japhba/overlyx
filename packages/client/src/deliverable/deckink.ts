/**
 * Draw on slides, posters and web pages (the deck toolbar's Draw): a pen and a highlighter, each with
 * its own colour and width presets as in the documents' margin ink (inkToolbar.tsx, GoodNotes) — one
 * click picks a preset, a click on the picked one changes it. The same colours as the documents'
 * pens; widths are px of a 1280 px wide slide (the strokes are SVG paths in the page, sourceops.ts
 * objectHtml), shown in points like the other line weights (units.ts). Kept in this browser (`ol.deckInk`).
 */
import { INK_PALETTES, HIGHLIGHT_OPACITY } from '../editor/plugins/ink';
import type { InkStyle, Nib } from './protocol';

export type DeckPen = 'pen' | 'highlighter';
export interface DeckPenSet { color: string; width: number; colors: string[]; widths: number[] }
export interface DeckInk {
  pen: DeckPen;
  pens: Record<DeckPen, DeckPenSet>;
  /** the pen's settings (GoodNotes'): ball or fountain, tip, pressure, stabilization */
  nib: Nib;
  /** a Pencil has drawn in this browser: fingers move the slide (unless `fingersDraw`) */
  pencil: boolean;
  fingersDraw: boolean;
  /** scribbling over strokes erases them */
  scribble: boolean;
}

/** the width presets (px of a 1280 px slide: 1½, 3, 6 pt; the highlighter's 10½, 18, 30 pt) and what the width picker offers */
export const DECK_INK_WIDTHS: Record<DeckPen, number[]> = { pen: [2, 4, 8], highlighter: [14, 24, 40] };
export const DECK_INK_WIDTH_CHOICES: Record<DeckPen, number[]> = { pen: [1, 2, 3, 4, 6, 8, 12, 16, 24], highlighter: [8, 12, 16, 20, 24, 32, 40, 56, 72] };

const KEY = 'ol.deckInk';

/** the pen as it comes: a fountain pen with round ends, a little pressure, a round tip, no smoothing */
export const DEFAULT_NIB: Nib = { ball: false, sharpness: 0, sensitivity: 0.25, flatness: 0, stabilization: 0 };
const NIB_LEVELS = ['sharpness', 'sensitivity', 'flatness', 'stabilization'] as const;
const isLevel = (v: unknown): v is number => typeof v === 'number' && v >= 0 && v <= 1;

/** a pen's settings with `p` taken over (each level kept between 0 and 1) */
function nibWith(n: Nib, p: Partial<Nib> | undefined): Nib {
  const out = { ...n };
  if (!p) return out;
  if (typeof p.ball === 'boolean') out.ball = p.ball;
  for (const k of NIB_LEVELS) if (isLevel(p[k])) out[k] = Math.round(p[k]! * 100) / 100;
  return out;
}

export function defaultDeckInk(): DeckInk {
  return {
    pen: 'pen',
    nib: { ...DEFAULT_NIB },
    pencil: false,
    fingersDraw: false,
    scribble: true,
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
    for (const k of ['pencil', 'fingersDraw', 'scribble'] as const) if (typeof s[k] === 'boolean') ink[k] = s[k]!;
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

export function saveDeckInk(ink: DeckInk): void {
  try { localStorage.setItem(KEY, JSON.stringify(ink)); } catch { /* private window */ }
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
  const flag = (k: 'pencil' | 'fingersDraw' | 'scribble') => (typeof p[k] === 'boolean' ? p[k]! : ink[k]);
  return { pen, pens: { ...ink.pens, [pen]: cur }, nib: nibWith(ink.nib, p.nib), pencil: flag('pencil'), fingersDraw: flag('fingersDraw'), scribble: flag('scribble') };
}

/** the ink of the next stroke: the pen in hand, its width for a page `pageW` px wide (a poster's strokes as thick, seen whole, as a slide's) */
export function deckInkStyle(ink: DeckInk, pageW = 1280): InkStyle {
  const p = ink.pens[ink.pen];
  const hl = ink.pen === 'highlighter';
  const fingers = ink.fingersDraw ? 'draw' as const : ink.pencil ? 'pan' as const : undefined;
  return {
    color: p.color, width: Math.round(p.width * Math.max(0.25, pageW / 1280) * 10) / 10, opacity: hl ? HIGHLIGHT_OPACITY : 1,
    ...(hl ? {} : { nib: { ...ink.nib } }), ...(fingers ? { fingers } : {}), scribble: ink.scribble,
  };
}

/** the size of a width preset's dot in the toolbar (screen px) */
export function deckInkDot(pen: DeckPen, w: number): number {
  return Math.round(Math.max(3, Math.min(14, pen === 'pen' ? 2.5 + w * 0.8 : 4 + w / 5)));
}
