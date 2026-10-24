/**
 * Reactions to comment messages: emoji (👍 ❤️ 🎉 …) and the words Yes / No, or any short word, in
 * the message's header (core comments.ts: "Bob (2026-10-10 12:00) (👍: Ada, Kirsten; Yes: Ada):"),
 * so they travel with the file like the rest of the thread. Under each message its reactions show
 * as chips (a click adds or takes back one's own); the ☺ beside the message's time opens the picker.
 * Reacting changes the header of someone else's message, which plugins/commentguard.ts lets through.
 */
import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { parseHeader, commentHeader, type Reaction } from '@overlyx/core';
import { isCommentNode } from '../commentops';
import { editorContext } from '../context';
import { allowCommentEdit, isMe } from './commentguard';

export const reactionsKey = new PluginKey<DecorationSet>('ol-reactions');

export const REACTION_EMOJI = ['👍', '👎', '❤️', '😂', '🎉', '👀', '🙏', '🤔'];
/** the word reactions: a vote on a question in the comment */
export const REACTION_WORDS = ['Yes', 'No'];

/** the reactions after `who` took back theirs or added `key` (a toggle) */
export function toggled(reactions: Reaction[], key: string, who: string, mine: (name: string) => boolean): Reaction[] {
  const had = reactions.some(r => r.key === key && r.who.some(mine));
  const out = reactions.map(r => (r.key === key ? { key, who: r.who.filter(w => !mine(w)) } : r)).filter(r => r.who.length);
  if (had) return out;
  const i = out.findIndex(r => r.key === key);
  if (i >= 0) out[i] = { key, who: [...out[i].who, who] };
  else out.push({ key, who: [who] });
  return out;
}

/** add or take back this person's reaction `key` on the message whose header paragraph starts at `at` */
export function toggleReaction(view: EditorView, at: number, key: string): void {
  const me = editorContext.user?.name;
  const para = view.state.doc.nodeAt(at);
  if (!me || !para || para.type.name !== 'paragraph') return;
  const text = para.textContent;
  const h = parseHeader(text.trim());
  if (!h) return;
  const lead = text.length - text.trimStart().length;
  const next = text.slice(0, lead) + commentHeader(h.author, h.time, h.resolved, toggled(h.reactions, key, me, isMe)) + text.slice(lead + text.trim().length);
  // only what differs is replaced: two people reacting at once both keep theirs (Yjs merges the inserts)
  let pre = 0;
  while (pre < text.length && pre < next.length && text[pre] === next[pre]) pre++;
  let suf = 0;
  while (suf < text.length - pre && suf < next.length - pre && text[text.length - 1 - suf] === next[next.length - 1 - suf]) suf++;
  const from = at + 1 + pre, to = at + 1 + text.length - suf, mid = next.slice(pre, next.length - suf);
  const tr = view.state.tr;
  if (mid) tr.replaceWith(from, to, view.state.schema.text(mid)); else tr.delete(from, to);
  view.dispatch(allowCommentEdit(tr));
}

const label = (key: string) => (key === 'Yes' ? '✓ Yes' : key === 'No' ? '✗ No' : key);

/* ------------------------------------------------------------------ the picker */

let picker: HTMLElement | null = null;
function closePicker(): void { picker?.remove(); picker = null; }

function openPicker(view: EditorView, button: HTMLElement, at: () => number | null): void {
  closePicker();
  const box = document.createElement('div');
  box.className = 'cm-react-picker';
  box.setAttribute('role', 'menu');
  const pick = (key: string) => { const p = at(); closePicker(); if (p !== null) toggleReaction(view, p, key); };
  for (const key of [...REACTION_EMOJI, ...REACTION_WORDS]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cm-react-pick' + (REACTION_WORDS.includes(key) ? ' word ' + key.toLowerCase() : '');
    b.dataset.react = key;
    b.textContent = label(key);
    b.title = REACTION_WORDS.includes(key) ? `Answer ${key}` : `React with ${key}`;
    b.onclick = () => pick(key);
    box.append(b);
  }
  // any short word or emoji of one's own
  const own = document.createElement('input');
  own.className = 'cm-react-own';
  own.placeholder = 'Other…';
  own.maxLength = 24;
  own.title = 'A word or emoji of your own — Enter adds it';
  own.onkeydown = e => {
    e.stopPropagation();
    if (e.key === 'Escape') { closePicker(); view.focus(); }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const key = own.value.replace(/[()[\]{};:,\\\n]/g, ' ').replace(/\s+/g, ' ').trim();
    if (key) pick(key);
  };
  box.append(own);
  document.body.append(box);
  const r = button.getBoundingClientRect();
  const w = box.offsetWidth;
  box.style.left = `${Math.max(8, Math.min(r.left - 8, window.innerWidth - w - 8))}px`;
  box.style.top = `${r.bottom + 4 + box.offsetHeight > window.innerHeight ? r.top - 4 - box.offsetHeight : r.bottom + 4}px`;
  picker = box;
  const away = (e: Event) => {
    if (picker !== box) { cleanup(); return; }
    if (e.type === 'keydown' && (e as KeyboardEvent).key !== 'Escape') return;
    if (e.type === 'mousedown' && box.contains(e.target as Node)) return;
    closePicker(); cleanup();
  };
  const cleanup = () => { window.removeEventListener('mousedown', away, true); window.removeEventListener('keydown', away, true); };
  window.addEventListener('mousedown', away, true);
  window.addEventListener('keydown', away, true);
}

/* ------------------------------------------------------------------ the decorations */

/** the header paragraph's position for a widget at `pos` inside a thread: the last header before it */
function headerBefore(view: EditorView, pos: number): number | null {
  const $p = view.state.doc.resolve(pos);
  for (let d = $p.depth; d > 0; d--) {
    const n = $p.node(d);
    if (!isCommentNode(n)) continue;
    const start = $p.before(d);
    let found: number | null = null;
    n.forEach((para, off) => { const p = start + 1 + off; if (p < pos && parseHeader(para.textContent.trim())) found = p; });
    return found;
  }
  return null;
}

const keep = (e: Event) => e.preventDefault();   // the editor keeps its focus and selection

function addButton(view: EditorView, getPos: () => number | undefined): HTMLElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'cm-react-add';
  b.title = 'React — an emoji, Yes or No';
  b.setAttribute('aria-label', 'Add a reaction');
  b.contentEditable = 'false';
  b.onmousedown = keep;
  b.onclick = e => { e.stopPropagation(); if (!view.editable) return; openPicker(view, b, () => { const p = getPos(); return p === undefined ? null : headerBefore(view, p); }); };
  return b;
}

function chips(view: EditorView, getPos: () => number | undefined, reactions: Reaction[]): HTMLElement {
  const row = document.createElement('span');
  row.className = 'cm-reactions';
  row.contentEditable = 'false';
  for (const r of reactions) {
    const mine = r.who.some(isMe);
    const c = document.createElement('button');
    c.type = 'button';
    c.className = 'cm-react' + (mine ? ' mine' : '') + (REACTION_WORDS.includes(r.key) ? ' word ' + r.key.toLowerCase() : '');
    c.dataset.react = r.key;
    const k = document.createElement('span'); k.textContent = label(r.key);
    const n = document.createElement('b'); n.textContent = String(r.who.length);
    c.append(k, n);
    c.title = `${r.who.join(', ')}${mine ? ' — click to take yours back' : ' — click to add yours'}`;
    c.onmousedown = keep;
    c.onclick = e => { e.stopPropagation(); if (!view.editable) return; const p = getPos(); const at = p === undefined ? null : headerBefore(view, p); if (at !== null) toggleReaction(view, at, r.key); };
    row.append(c);
  }
  return row;
}

function decorate(doc: PMNode): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((n, pos) => {
    if (!isCommentNode(n)) return true;
    // per message: the ☺ after the header's time, the chips at the end of its last paragraph
    let last: { end: number; reactions: Reaction[]; key: string } | null = null;
    const flush = () => {
      if (last?.reactions.length) {
        const r = last.reactions;
        decos.push(Decoration.widget(last.end, (view, getPos) => chips(view, getPos, r), { side: 1, key: 'cm-r:' + last.key, ignoreSelection: true, stopEvent: () => true }));
      }
    };
    n.forEach((para, off) => {
      const p = pos + 1 + off;
      const h = parseHeader(para.textContent.trim());
      if (h) {
        flush();
        decos.push(Decoration.widget(p + para.nodeSize - 1, (view, getPos) => addButton(view, getPos), { side: 1, key: 'cm-add', ignoreSelection: true, stopEvent: () => true }));
        last = { end: p + para.nodeSize - 1, reactions: h.reactions, key: h.reactions.map(r => r.key + '=' + r.who.join(',')).join('|') };
      } else if (last) last.end = p + para.nodeSize - 1;
    });
    flush();
    return false;
  });
  return DecorationSet.create(doc, decos);
}

export function reactionsPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: reactionsKey,
    state: {
      init: (_, state) => decorate(state.doc),
      apply: (tr, prev) => (tr.docChanged ? decorate(tr.doc) : prev),
    },
    props: { decorations: state => reactionsKey.getState(state) },
    view: () => ({ destroy: closePicker }),
  });
}
