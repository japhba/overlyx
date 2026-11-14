/**
 * The emoji keyboard on slides, posters and web pages (deliverable/DeliverableEditor.tsx: Insert ▸
 * Emoji… and Ctrl+; while typing in a text): the emoji goes in at the caret of the text being retyped
 * (the runtime's `exec`, as a link does); in an emoji font as a `<span style="font-family: …">` around
 * it, the font linked from Google Fonts in the page's head like the Text toolbar's fonts.
 */
import { emojiFontOf } from '@overlyx/core';

/** the css2 query of an emoji family (deckfonts.ts fontResource: its default asks for italics and bold, which they lack) */
const GOOGLE_SPEC: Record<string, string> = { 'Noto Color Emoji': 'Noto Color Emoji:wght@400', 'Noto Emoji': 'Noto Emoji:wght@300..700' };

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** the HTML put into a slide's text for `emoji` in `face` (null: the emoji as it is) */
export function deckEmojiHtml(emoji: string, face: string | null): string | null {
  const f = emojiFontOf(face);
  if (!f?.family) return null;
  return `<span style="font-family: '${f.family}'${f.weight ? `; font-weight: ${f.weight}` : ''}">${escapeHtml(emoji)}</span>`;
}

export function openDeckEmoji(deck: { exec(command: string, value?: string): void; ensureFont(css: string | null, google?: string): void; focus(): void }): void {
  void import('./picker').then(m => m.openEmojiPicker({
    insert: (emoji, face) => {
      const f = emojiFontOf(face);
      const html = deckEmojiHtml(emoji, face);
      if (f?.family) deck.ensureFont(`'${f.family}'`, GOOGLE_SPEC[f.family] ?? f.family);
      deck.focus();
      if (html) deck.exec('insertHTML', html); else deck.exec('insertText', emoji);
    },
    focus: () => deck.focus(),
  }));
}
