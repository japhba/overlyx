/**
 * Emoji in fonts without licence trouble (DOCS.md "Emoji"). An emoji set in one of them is a font by
 * name on that text (fontface.ts: the `face` mark, `\olfont{Noto Color Emoji}{…}` in .tex, a
 * `<span style="font-family…">` in markdown), so it shows in the editor and goes into the file.
 *
 * Which fonts, checked against their sources (14 Nov 2026):
 *   Noto Color Emoji  OFL 1.1 (github.com/googlefonts/noto-emoji, google/fonts ofl/notocoloremoji) — on Google Fonts
 *   Noto Emoji        OFL 1.1 (the same repository, ofl/notoemoji): one colour, a weight axis 300–700 — on Google Fonts
 * Not offered: Twemoji (graphics CC BY 4.0 — every document that shows them must credit them),
 * OpenMoji (CC BY-SA 4.0 — credit and share-alike on the emoji), Fluent Emoji (MIT, but Microsoft
 * publishes pictures, no font), Blobmoji (OFL / Apache-2.0, but only as a bitmap font of 10+ MB that
 * Firefox and Safari do not draw), Apple Color Emoji and Segoe UI Emoji (proprietary).
 */

export interface EmojiFont {
  /** what the menus call it */
  label: string;
  /** the face value (fontface.ts), null: the device's own emoji */
  face: string | null;
  /** the family to load and to draw the samples in */
  family: string | null;
  /** the CSS of a sample in it (the weight of Noto Emoji's styles) */
  weight?: number;
  licence: string;
}

export const EMOJI_FONTS: EmojiFont[] = [
  { label: 'Your device’s', face: null, family: null, licence: '' },
  { label: 'Noto Color Emoji', face: 'Noto Color Emoji', family: 'Noto Color Emoji', licence: 'SIL Open Font License 1.1' },
  { label: 'Noto Emoji', face: 'Noto Emoji', family: 'Noto Emoji', licence: 'SIL Open Font License 1.1' },
  { label: 'Noto Emoji Light', face: 'Noto Emoji|300', family: 'Noto Emoji', weight: 300, licence: 'SIL Open Font License 1.1' },
  { label: 'Noto Emoji Bold', face: 'Noto Emoji|700', family: 'Noto Emoji', weight: 700, licence: 'SIL Open Font License 1.1' },
];

/** the emoji families (to tell an emoji font from a text font: an emoji font on text that is no emoji) */
export const EMOJI_FAMILIES = new Set(EMOJI_FONTS.map(f => f.family).filter((f): f is string => !!f));

/** the font list's entry of a face value (null: none of them) */
export const emojiFontOf = (face: string | null | undefined): EmojiFont | null => EMOJI_FONTS.find(f => (f.face ?? null) === (face ?? null)) ?? null;

/**
 * One emoji: a pictograph (with its presentation selector, a skin tone, a keycap, joined to others
 * by zero-width joiners), a flag (two regional indicators) or a subdivision flag (tag characters).
 */
const PIC = '(?:\\p{Extended_Pictographic}|[#*0-9]\\uFE0F?\\u20E3)(?:\\uFE0F|\\p{Emoji_Modifier})?(?:\\u200D(?:\\p{Extended_Pictographic})(?:\\uFE0F|\\p{Emoji_Modifier})?)*[\\u{E0020}-\\u{E007F}]*';
const FLAG = '\\p{Regional_Indicator}{2}';
export const EMOJI_RE = new RegExp(`(?:${FLAG}|${PIC})`, 'gu');

/** the emoji in a text: [start, end) in UTF-16 units — text-presentation characters (©, ™, ↔) without U+FE0F are no emoji here */
export function emojiRanges(text: string): [number, number][] {
  const out: [number, number][] = [];
  for (const m of text.matchAll(EMOJI_RE)) {
    const s = m[0];
    if (!isEmoji(s)) continue;
    out.push([m.index!, m.index! + s.length]);
  }
  return out;
}

/** is this whole string one emoji (not a plain symbol such as © or ↔ that only an added U+FE0F makes one) */
export function isEmoji(s: string): boolean {
  if (!s) return false;
  const one = new RegExp(`^(?:${FLAG}|${PIC})$`, 'u');
  if (!one.test(s)) return false;
  if (s.length > 1 && /[️‍⃣]|\p{Emoji_Modifier}|\p{Regional_Indicator}/u.test(s)) return true;
  return /\p{Emoji_Presentation}/u.test(s);
}

/** the emoji at `offset` in a text (an offset inside it or just before it), or null */
export function emojiAt(text: string, offset: number): [number, number] | null {
  for (const [a, b] of emojiRanges(text)) if (offset >= a && offset < b) return [a, b];
  return null;
}
