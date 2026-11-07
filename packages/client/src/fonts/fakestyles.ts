/**
 * Styles a font by name does not have, so they are faked: the browser thickens, slants or shrinks
 * the letters itself (CSS font synthesis), and the PDF finds no such face either (core fontface.ts
 * OLFONT_DEF, fontspec) — it prints the text regular, upright, in lower case. The font button shows
 * "!" when the text at the cursor or in the selection asks for one (app/FontPicker.tsx).
 */
import { parseFace } from '@overlyx/core';

export type FakeStyle = 'bold' | 'italic' | 'smallcaps';
/** what a family has: the server's font description (/api/fonts/info, FontPicker's FontInfo) */
export interface FaceOffer { axes: { tag: string; min: number; max: number }[]; weights: number[]; italic: boolean; features: string[] }
export interface WantedStyles { bold: boolean; italic: boolean; smallcaps: boolean }
type MarkLike = { type: { name: string }; attrs: Record<string, unknown> };

/** the heaviest weight the family draws: a variable font's weight axis' end, a static family's heaviest face (400: none known) */
const heaviest = (f: FaceOffer) => f.axes.find(a => a.tag === 'wght')?.max ?? Math.max(400, ...f.weights);

/**
 * What of `wanted` the family fakes. Bold: no face of 600 or more (browsers fake bold below that).
 * Italic: no italic files — a slant or italic axis does not count, the stylesheet declares the files
 * upright (server googlefonts.ts) and fontspec does not set it either. Small capitals: no `smcp`.
 */
export function fakedStyles(offer: FaceOffer, wanted: WantedStyles): FakeStyle[] {
  const out: FakeStyle[] = [];
  if (wanted.bold && heaviest(offer) < 600) out.push('bold');
  if (wanted.italic && !offer.italic) out.push('italic');
  if (wanted.smallcaps && !offer.features.includes('smcp')) out.push('smallcaps');
  return out;
}

/** what the text in the face `family` asks for, among the mark sets given (the cursor's, the selected texts') */
export function wantedStyles(markSets: Iterable<readonly MarkLike[]>, family: string): WantedStyles {
  const w: WantedStyles = { bold: false, italic: false, smallcaps: false };
  for (const marks of markSets) {
    const face = marks.find(m => m.type.name === 'face');
    if (!face || parseFace(face.attrs.value as string)?.family !== family) continue;
    for (const m of marks) {
      const name = m.type.name, v = m.attrs.value;
      if (name === 'series' && v === 'bold') w.bold = true;
      if ((name === 'shape' && (v === 'italic' || v === 'slanted')) || (name === 'emph' && v === 'on')) w.italic = true;
      if ((name === 'shape' && v === 'smallcaps') || (name === 'noun' && v === 'on')) w.smallcaps = true;
    }
  }
  return w;
}

const SAY: Record<FakeStyle, string> = {
  bold: 'no bold: the editor thickens the letters to fake it, and the PDF prints them regular',
  italic: 'no italic: the editor slants the letters to fake it, and the PDF prints them upright',
  smallcaps: 'no small capitals: the editor shrinks capitals to fake them, and the PDF prints the letters in lower case',
};

/** the "!"'s tooltip */
export function fakeWarning(family: string, faked: FakeStyle[]): string {
  return faked.map(f => `${family} has ${SAY[f]}.`).join(' ') +
    ' Pick a font that has ' + (faked.length > 1 ? 'them' : 'it') + ' — the font list shows each font’s weights (◐: any weight), and the panel below it its OpenType features.';
}
