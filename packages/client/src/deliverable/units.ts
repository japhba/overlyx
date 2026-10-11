/**
 * Lengths as the interface shows them: physical units, never CSS px. A CSS px is 1/96 in, so a
 * 1280 × 720 slide is 13.33 × 7.5 in (PowerPoint's widescreen size): type, lines and corners in
 * points (1 px = ¾ pt), sizes in millimetres — inches where the browser's language is US English.
 * The page's source keeps whatever units it was written in; these are for labels and fields.
 */

export const PT_PER_PX = 0.75;
export const pxToPt = (px: number): number => px * PT_PER_PX;
export const ptToPx = (pt: number): number => pt / PT_PER_PX;

const FRACTIONS: Record<number, string> = { 0.25: '¼', 0.5: '½', 0.75: '¾' };

/** points for a label, in quarter points written as PowerPoint does ("¾", "2¼"), else to one decimal */
export function fmtPt(pt: number): string {
  const q = Math.round(pt * 4) / 4;
  if (Math.abs(q - pt) < 0.02 && q < 20) {
    const whole = Math.floor(q), frac = FRACTIONS[q - whole];
    if (frac) return whole ? `${whole}${frac}` : frac;
    return String(whole);
  }
  return String(Math.round(pt * 10) / 10);
}

/** a font size in points for a field: to half a point */
export const sizePt = (px: number): number => Math.round(pxToPt(px) * 2) / 2;

/** the font sizes − / + and Ctrl+Shift+, / . step through (Word's and Google's ladder, carried on) */
const LADDER = [6, 7, 8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 48, 54, 60, 66, 72, 80, 88, 96, 108, 120, 144, 168, 192, 240, 288];

/** the next size up (dir 1) or down (-1) from `pt` */
export function stepPt(pt: number, dir: 1 | -1): number {
  if (dir > 0) return LADDER.find(v => v > pt + 0.01) ?? Math.round(pt * 1.15);
  for (let i = LADDER.length - 1; i >= 0; i--) if (LADDER[i] < pt - 0.01) return LADDER[i];
  return Math.max(1, Math.round(pt / 1.15 * 2) / 2);
}

/** millimetres, or inches in the US */
export function lengthUnit(): 'mm' | 'in' {
  const lang = typeof navigator !== 'undefined' ? navigator.language : '';
  return /^en-US$/i.test(lang) ? 'in' : 'mm';
}

const lengthNumber = (px: number, unit: 'mm' | 'in'): string => {
  if (unit === 'in') return String(Math.round(px / 96 * 100) / 100);
  const mm = px * 25.4 / 96;
  return String(mm < 100 ? Math.round(mm * 10) / 10 : Math.round(mm));
};

/** a length: "84.7 mm", "3.33 in" */
export function fmtLength(px: number, unit = lengthUnit()): string {
  return `${lengthNumber(px, unit)} ${unit}`;
}

/** a width and a height: "84.7 × 52.9 mm" */
export function fmtSize(w: number, h: number, unit = lengthUnit()): string {
  return `${lengthNumber(w, unit)} × ${lengthNumber(h, unit)} ${unit}`;
}
