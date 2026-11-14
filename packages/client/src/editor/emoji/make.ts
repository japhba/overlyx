/**
 * Make an emoji… (the emoji keyboard's foot): the person describes the emoji and picks a font whose
 * style to follow; a few of that font's emoji are drawn as pictures (a canvas, 160 px) and sent with
 * the description to the image model (POST /api/ai/emoji, server emojimake.ts, the account's own
 * OpenAI key). The picture it sends back (transparent PNG) is saved into the project's figures/ and
 * inserted at text size (EmojiTarget.insertPicture).
 */
import { EMOJI_FONTS, emojiRanges, type EmojiFont } from '@overlyx/core';
import { api } from '../../api';
import { emojiSample } from './emojimenu';
import type { EmojiTarget } from './picker';

/** the open fonts one can follow (not the device's: its emoji may be under a proprietary licence) */
const STYLE_FONTS = EMOJI_FONTS.filter(f => f.family);
const DEFAULT_EXAMPLES = '😀 🐱 🌵 🚀 ☕';

/** an emoji drawn in `f` as a PNG data URL (transparent around it) */
export async function emojiPng(emoji: string, f: EmojiFont, size = 160): Promise<string> {
  const css = `${f.weight ?? 400} ${Math.round(size * 0.78)}px '${f.family}'`;
  try { await document.fonts.load(css, emoji); } catch { /* drawn in what there is */ }
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.font = css;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#000';
  g.fillText(emoji, size / 2, size / 2 + size * 0.04);
  return c.toDataURL('image/png');
}

/** a file name from the description: "a cat with a hat" → emoji-cat-with-hat */
export function emojiFileName(description: string): string {
  const words = description.toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w && !['a', 'an', 'the', 'of'].includes(w));
  return ('emoji-' + words.slice(0, 5).join('-')).replace(/-+$/, '').slice(0, 60) || 'emoji';
}

export function showMakeEmoji(box: HTMLElement, list: HTMLElement, foot: HTMLElement, font: EmojiFont, target: EmojiTarget, close: () => void): void {
  const cats = box.querySelector<HTMLElement>('.emoji-kbd-cats');
  const panel = document.createElement('div');
  panel.className = 'emoji-make';
  const back = () => { panel.remove(); list.hidden = false; foot.hidden = false; if (cats) cats.hidden = false; };
  list.hidden = true; foot.hidden = true; if (cats) cats.hidden = true;

  const what = document.createElement('label');
  what.append('What should it show?');
  const desc = document.createElement('textarea');
  desc.placeholder = 'e.g. a cat reading a book';
  what.appendChild(desc);

  const styleL = document.createElement('label');
  styleL.append('In the style of');
  const sel = document.createElement('select');
  let style = STYLE_FONTS.find(f => f.face === font.face) ?? STYLE_FONTS[0];
  for (const f of STYLE_FONTS) { const o = document.createElement('option'); o.value = f.face!; o.textContent = f.label; sel.appendChild(o); }
  sel.value = style.face!;
  styleL.appendChild(sel);

  const exL = document.createElement('label');
  exL.append('Examples from that font (the model copies their style)');
  const exIn = document.createElement('input');
  exIn.type = 'text'; exIn.value = DEFAULT_EXAMPLES;
  const exRow = document.createElement('div'); exRow.className = 'examples';
  exL.append(exIn, exRow);
  const examples = () => emojiRanges(exIn.value).map(([a, b]) => exIn.value.slice(a, b)).slice(0, 8);
  const drawExamples = () => { exRow.replaceChildren(...examples().map(e => emojiSample(e, style))); };

  const msg = document.createElement('div'); msg.className = 'msg';
  msg.textContent = 'Uses your own OpenAI API key (Settings ▸ AI). The picture is saved in the project’s figures folder.';
  const result = document.createElement('div'); result.className = 'result';
  const actions = document.createElement('div'); actions.className = 'actions';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Back';
  const go = document.createElement('button'); go.type = 'button'; go.className = 'primary'; go.textContent = 'Make';
  const insert = document.createElement('button'); insert.type = 'button'; insert.className = 'primary'; insert.textContent = 'Insert'; insert.hidden = true;
  actions.append(cancel, go, insert);
  panel.append(what, styleL, exL, msg, result, actions);
  box.insertBefore(panel, foot);
  drawExamples();
  desc.focus();

  let made: Blob | null = null;
  let ac: AbortController | null = null;
  sel.addEventListener('change', () => { style = STYLE_FONTS.find(f => f.face === sel.value) ?? STYLE_FONTS[0]; drawExamples(); });
  exIn.addEventListener('input', drawExamples);
  cancel.addEventListener('click', () => { ac?.abort(); back(); });
  go.addEventListener('click', () => {
    void (async () => {
      const d = desc.value.trim();
      if (!d) { desc.focus(); return; }
      const ex = examples();
      if (!ex.length) { msg.className = 'msg err'; msg.textContent = 'Give at least one example emoji.'; return; }
      go.disabled = true; insert.hidden = true; result.replaceChildren(); made = null;
      msg.className = 'msg'; msg.textContent = 'Drawing… (this takes up to a minute)';
      ac = new AbortController();
      try {
        const pngs = await Promise.all(ex.map(e => emojiPng(e, style)));
        const { image, model } = await api.aiEmoji({ description: d, font: style.label, examples: pngs }, ac.signal);
        const bytes = Uint8Array.from(atob(image), ch => ch.charCodeAt(0));
        made = new Blob([bytes], { type: 'image/png' });
        const img = document.createElement('img');
        img.src = URL.createObjectURL(made); img.alt = d;
        result.replaceChildren(img);
        msg.textContent = `Drawn by ${model}. Insert it, or change the description and make another.`;
        insert.hidden = false; go.textContent = 'Make another';
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
        msg.className = 'msg err'; msg.textContent = (e as Error).message || 'The emoji could not be made.';
      } finally { go.disabled = false; ac = null; }
    })();
  });
  insert.addEventListener('click', () => {
    if (!made || !target.insertPicture) return;
    insert.disabled = true;
    void target.insertPicture(made, emojiFileName(desc.value)).then(() => close(), e => {
      msg.className = 'msg err'; msg.textContent = `Could not save the picture: ${(e as Error).message}`;
      insert.disabled = false;
    });
  });
}
