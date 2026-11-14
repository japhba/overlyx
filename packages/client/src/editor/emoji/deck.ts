/**
 * The emoji keyboard on slides, posters and web pages (deliverable/DeliverableEditor.tsx: Insert ▸
 * Emoji… and Ctrl+; while typing in a text): the emoji goes in at the caret of the text being retyped
 * (the runtime's `exec`, as a link does); in an emoji font as a `<span style="font-family: …">` around
 * it, the font linked from Google Fonts in the page's head like the Text toolbar's fonts. A right-click
 * on an emoji while typing shows it in each emoji font (deckEmojiMenu); a click sets that one.
 */
import { EMOJI_FONTS, emojiFontOf } from '@overlyx/core';
import { closeContextMenu, type MenuItem } from '../contextmenu';
import { emojiSample, loadEmojiFonts } from './emojimenu';

/** the css2 query of an emoji family (deckfonts.ts fontResource: its default asks for italics and bold, which they lack) */
const GOOGLE_SPEC: Record<string, string> = { 'Noto Color Emoji': 'Noto Color Emoji:wght@400', 'Noto Emoji': 'Noto Emoji:wght@300..700' };

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** the HTML put into a slide's text for `emoji` in `face` (null: the emoji as it is) */
export function deckEmojiHtml(emoji: string, face: string | null): string | null {
  const f = emojiFontOf(face);
  if (!f?.family) return null;
  return `<span style="font-family: '${f.family}'${f.weight ? `; font-weight: ${f.weight}` : ''}">${escapeHtml(emoji)}</span>`;
}

export interface DeckText { exec(command: string, value?: string): void; ensureFont(css: string | null, google?: string): void; focus(): void }

/** put `emoji` in `face` at the caret of the text being retyped, in place of what is selected there */
function putEmoji(deck: DeckText, emoji: string, face: string | null, replacing = false): void {
  const f = emojiFontOf(face);
  const html = deckEmojiHtml(emoji, face);
  if (f?.family) deck.ensureFont(`'${f.family}'`, GOOGLE_SPEC[f.family] ?? f.family);
  deck.focus();
  if (html) deck.exec('insertHTML', html);
  // (the device's own over an emoji in a font: the font taken off, as the Text toolbar's Default does)
  else if (replacing) deck.exec('fontName', 'inherit');
  else deck.exec('insertText', emoji);
}

export function openDeckEmoji(deck: DeckText): void {
  void import('./picker').then(m => m.openEmojiPicker({
    insert: (emoji, face) => putEmoji(deck, emoji, face),
    focus: () => deck.focus(),
  }));
}

/** the menu of an emoji right-clicked in a slide's text (the runtime selected it: runtime/emojipick.ts) — it in each emoji font */
export function deckEmojiMenu(emoji: string, deck: DeckText): MenuItem[] {
  loadEmojiFonts();
  const row = (): HTMLElement => {
    const box = document.createElement('div');
    box.className = 'emoji-fonts-row';
    const title = document.createElement('div');
    title.className = 'emoji-fonts-title';
    title.textContent = 'Emoji font';
    const line = document.createElement('div');
    line.className = 'emoji-fonts-line';
    for (const f of EMOJI_FONTS) {
      const b = emojiSample(emoji, f, 'button');
      b.title = f.label + (f.licence ? ` (${f.licence})` : '');
      b.setAttribute('aria-label', f.label);
      b.addEventListener('click', ev => { ev.preventDefault(); closeContextMenu(); putEmoji(deck, emoji, f.face, true); });
      line.appendChild(b);
    }
    box.append(title, line);
    return box;
  };
  return [{ custom: row }, { label: 'Emoji keyboard…', shortcut: 'Ctrl+;', action: () => openDeckEmoji(deck) }];
}
