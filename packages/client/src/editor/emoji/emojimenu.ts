/**
 * Right-click on an emoji (documents, markdown): the same emoji in each emoji font without licence
 * trouble side by side (core emojifonts.ts); a click sets it in that font — the emoji under the
 * pointer, or every emoji of the selection when the pointer is in one — and two submenus do the same
 * for every emoji in the selection / in the document. The font is the `face` mark (core fontface.ts),
 * so it is \olfont{…}{…} in .tex and a <span style="font-family…"> in markdown, and it survives save,
 * PDF (LuaLaTeX; Noto Color Emoji through HarfBuzz) and export.
 */
import type { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { EMOJI_FONTS, emojiRanges, emojiAt, emojiFontOf, type EmojiFont } from '@overlyx/core';
import { setValueMarkIn } from '../fontsize';
import { loadGoogleFont } from '../../fonts/googlefont';
import { closeContextMenu, type MenuItem } from '../contextmenu';
import './emoji.css';

/** the emoji of the document between `from` and `to`: [from, to) positions */
export function emojiRangesIn(doc: PMNode, from = 0, to = doc.content.size): [number, number][] {
  const out: [number, number][] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return true;
    for (const [a, b] of emojiRanges(node.text!)) {
      const s = pos + a, e = pos + b;
      if (s >= from && e <= to) out.push([s, e]);
    }
    return false;
  });
  return out;
}

/** the emoji at document position `pos` (the pointer before it or inside it), or null */
export function emojiAtPos(doc: PMNode, pos: number): [number, number] | null {
  const $p = doc.resolve(pos);
  if (!$p.parent.inlineContent) return null;
  const start = $p.start();
  // (one character per inline node: offsets in this text are positions in the paragraph)
  const text = $p.parent.textBetween(0, $p.parent.content.size, undefined, '￼');
  const off = pos - start;
  const hit = emojiAt(text, off) ?? (off > 0 ? emojiAt(text, off - 1) : null);
  return hit ? [start + hit[0], start + hit[1]] : null;
}

/** set the emoji in these ranges in `face` (null: the device's own emoji) — one step for undo */
export function setEmojiFont(view: EditorView, ranges: [number, number][], face: string | null): void {
  if (!ranges.length) return;
  let tr = view.state.tr;
  for (const [a, b] of ranges) {
    if (face) tr = setValueMarkIn(tr, a, b, 'family', null);
    tr = setValueMarkIn(tr, a, b, 'face', face);
  }
  view.dispatch(tr.scrollIntoView());
  const f = emojiFontOf(face);
  if (f?.family) loadGoogleFont(f.family);
  view.focus();
}

/** load the emoji fonts (their parts by Unicode range: only what is drawn is fetched) */
export function loadEmojiFonts(): void {
  for (const f of EMOJI_FONTS) if (f.family) loadGoogleFont(f.family);
}

/** the emoji drawn in font `f` (a sample: a menu, the emoji keyboard) */
export function emojiSample(emoji: string, f: EmojiFont, tag: 'span' | 'button' = 'span'): HTMLElement {
  const el = document.createElement(tag);
  el.className = 'emoji-sample';
  el.textContent = emoji;
  if (f.family) el.style.fontFamily = `'${f.family}'`;
  if (f.weight) el.style.fontWeight = String(f.weight);
  return el;
}

/** the face value on the text at `pos` (null: none) */
function faceAt(doc: PMNode, pos: number): string | null {
  const m = doc.resolve(pos + 1).marks().find(x => x.type.name === 'face');
  return m ? String(m.attrs.value) : null;
}

/** the right-click menu's emoji entries for the pointer at `pos`, or none (no emoji there or selected) */
export function emojiMenuItems(view: EditorView, pos: number | null): MenuItem[] {
  if (!view.editable) return [];
  const { doc, selection } = view.state;
  const here = pos === null ? null : emojiAtPos(doc, pos);
  const inSel = selection.empty ? [] : emojiRangesIn(doc, selection.from, selection.to);
  if (!here && !inSel.length) return [];
  loadEmojiFonts();
  // the pointer in the selection: its emoji; else the one under the pointer
  const target = inSel.length && (!here || (here[0] >= selection.from && here[1] <= selection.to)) ? inSel : here ? [here] : inSel;
  const emoji = doc.textBetween(target[0][0], target[0][1]);
  const current = faceAt(doc, target[0][0]);
  const row = (): HTMLElement => {
    const box = document.createElement('div');
    box.className = 'emoji-fonts-row';
    const title = document.createElement('div');
    title.className = 'emoji-fonts-title';
    title.textContent = target.length > 1 ? `Emoji font — ${target.length} emoji` : 'Emoji font';
    box.appendChild(title);
    const line = document.createElement('div');
    line.className = 'emoji-fonts-line';
    for (const f of EMOJI_FONTS) {
      const b = emojiSample(emoji, f, 'button');
      b.title = f.label + (f.licence ? ` (${f.licence})` : '');
      b.setAttribute('aria-label', f.label);
      if ((f.face ?? null) === current) b.classList.add('current');
      b.addEventListener('click', ev => { ev.preventDefault(); closeContextMenu(); setEmojiFont(view, target, f.face); });
      line.appendChild(b);
    }
    box.appendChild(line);
    return box;
  };
  const all = (ranges: () => [number, number][]) => EMOJI_FONTS.map(f => ({ label: f.label, action: () => setEmojiFont(view, ranges(), f.face) }));
  return [
    { custom: row },
    ...(inSel.length > 1 ? [{ label: 'Every emoji in the selection in', icon: 'format' as const, sub: all(() => emojiRangesIn(view.state.doc, view.state.selection.from, view.state.selection.to)) }] : []),
    { label: 'Every emoji in the document in', icon: 'format', sub: all(() => emojiRangesIn(view.state.doc)) },
    { sep: true },
  ];
}
