/**
 * Cursors and selections in a document's CRDT, in the terms the MCP tools use. A collaborator's
 * awareness `cursor` is two Yjs relative positions (y-prosemirror's cursor plugin: anchor and head
 * inside the `prosemirror` XmlFragment); an agent addresses a document by paragraph — the index in
 * read_document's `paragraphs`, which are the fragment's top-level blocks — and by plain text.
 *
 * describeCursor() resolves a cursor to the paragraph, the character offset into that paragraph's
 * text as read_document lists it, an excerpt with a caret, and the selected text verbatim. The text
 * is produced by the same conversion read_document uses (editor nodes → document model → itemText):
 * the paragraph is serialized with private-use marker characters at the cursor's places, and where
 * the markers come out of the conversion is the answer — formulas, footnotes, quotes and special
 * characters count exactly as they do in read_document. Inside a table (whose cells read_document's
 * paragraph text leaves out) the excerpt comes from a deeper rendering with the cells, and the
 * offset is null.
 *
 * findQuote() goes the other way (the MCP `highlight` tool: an agent points at a passage it quotes),
 * and changedRange() turns the CRDT events of an agent's edit into the range it changed — where the
 * agent's own cursor is shown to the people in the document.
 */
import * as Y from 'yjs';
import { pmBlocksToParagraphs, itemText, type Item, type PMJSON } from '@overlyx/core';

export type RelJSON = Record<string, unknown>;
export interface Cursor { anchor: RelJSON; head: RelJSON }

/** A resolved position: the Yjs type and index, and its path of child indices from the fragment (document order). */
interface YPos { type: Y.AbstractType<any>; index: number; key: number[] }

const CARET = '', FROM = '', TO = '';
const MARKERS = /[-]/g;
/** characters of excerpt on either side of the caret */
const EXCERPT_SIDE = 70;
/** the longest selected text handed out (head and tail kept beyond that) */
const SELECTION_MAX = 6000;

const fragmentOf = (ydoc: Y.Doc): Y.XmlFragment => ydoc.getXmlFragment('prosemirror');

/** Path of child indices from the fragment down to `type` (null: not inside it, or deleted). */
function pathOf(fragment: Y.XmlFragment, type: Y.AbstractType<any>): number[] | null {
  const path: number[] = [];
  let t = type;
  while (t !== fragment) {
    const item = t._item;
    if (!item || item.deleted) return null;
    const parent = item.parent;
    if (!(parent instanceof Y.XmlElement || parent instanceof Y.XmlFragment)) return null;
    const i = parent.toArray().indexOf(t as Y.XmlElement);
    if (i < 0) return null;
    path.unshift(i);
    t = parent;
  }
  return path;
}

function resolve(ydoc: Y.Doc, json: unknown): YPos | null {
  let abs: Y.AbsolutePosition | null;
  try { abs = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(json), ydoc); } catch { return null; }
  if (!abs) return null;
  const fragment = fragmentOf(ydoc);
  const path = pathOf(fragment, abs.type);
  if (!path) return null;
  // between top-level blocks (a gap cursor, a whole-paragraph node selection): the start of the next
  // paragraph, or the end of the last one
  if (!path.length) {
    const n = fragment.length;
    if (!n) return null;
    const k = Math.min(abs.index, n - 1);
    const el = fragment.get(k) as Y.XmlElement;
    const index = abs.index >= n ? el.length : 0;
    return { type: el, index, key: [k, index] };
  }
  return { type: abs.type, index: abs.index, key: [...path, abs.index] };
}

/** Document order of two positions (a position before a child sorts before positions inside it). */
function compare(a: YPos, b: YPos): number {
  for (let i = 0; i < Math.min(a.key.length, b.key.length); i++) if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i];
  return a.key.length - b.key.length;
}

/** y-prosemirror's names for overlapping marks carry a hash suffix (sync-plugin.js yattr2markname). */
const markName = (attr: string) => /(.*)(--[a-zA-Z0-9+/=]{8})$/.exec(attr)?.[1] ?? attr;

interface Marker { type: Y.AbstractType<any>; index: number; ch: string }

/** One Yjs node as editor JSON, as y-prosemirror's yXmlFragmentToProsemirrorJSON does, with marker characters inserted. */
function serialize(t: Y.XmlElement | Y.XmlText, markers: Marker[]): PMJSON[] {
  const mine = markers.filter(m => m.type === t).sort((a, b) => a.index - b.index);
  if (t instanceof Y.XmlText) {
    const out: PMJSON[] = [];
    const push = (text: string, attrs?: Record<string, unknown>) => {
      if (!text) return;
      const node: PMJSON = { type: 'text', text };
      if (attrs) node.marks = Object.keys(attrs).map(k => ({ type: markName(k), attrs: attrs[k] as Record<string, unknown> }));
      out.push(node);
    };
    let mi = 0;
    let pos = 0;
    for (const d of t.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[]) {
      if (typeof d.insert !== 'string') continue;
      let s = d.insert;
      let start = pos;
      while (mi < mine.length && mine[mi].index <= start + s.length) {
        const cut = Math.max(0, mine[mi].index - start);
        push(s.slice(0, cut), d.attributes);
        push(mine[mi].ch, d.attributes);
        s = s.slice(cut); start += cut; mi++;
      }
      push(s, d.attributes);
      pos = start + s.length;
    }
    for (; mi < mine.length; mi++) push(mine[mi].ch);
    return out;
  }
  const node: PMJSON = { type: t.nodeName };
  const attrs = t.getAttributes();
  if (Object.keys(attrs).length) node.attrs = attrs;
  const content: PMJSON[] = [];
  let mi = 0;
  (t.toArray() as (Y.XmlElement | Y.XmlText)[]).forEach((child, i) => {
    for (; mi < mine.length && mine[mi].index <= i; mi++) content.push({ type: 'text', text: mine[mi].ch });
    content.push(...serialize(child, markers));
  });
  for (; mi < mine.length; mi++) content.push({ type: 'text', text: mine[mi].ch });
  if (content.length) node.content = content;
  return [node];
}

/** Like itemText, but tables give their cells (read_document's paragraph text leaves them out). */
function deepText(items: Item[]): string {
  return items.map(it => {
    if (it.kind !== 'inset') return itemText(it);
    const ins = it.inset;
    if (ins.type === 'Tabular') return ins.rows.map(r => r.cells.map(c => c.paragraphs.map(p => deepText(p.items)).join(' ')).join(' & ')).join(' \\\\ ');
    if (ins.type === 'Text') return ins.paragraphs.map(p => deepText(p.items)).join('\n');
    return itemText(it);
  }).join('');
}

interface Rendered { text: string; deep: string; layout: string }

/** Top-level paragraph `k` as read_document's text (`text`) and with table cells (`deep`), markers included. */
function renderParagraph(fragment: Y.XmlFragment, k: number, markers: Marker[]): Rendered {
  const el = fragment.get(k) as Y.XmlElement | undefined;
  if (!(el instanceof Y.XmlElement)) return { text: '', deep: '', layout: '' };
  const par = pmBlocksToParagraphs(serialize(el, markers))[0];
  if (!par) return { text: '', deep: '', layout: '' };
  return { text: par.items.map(itemText).join(''), deep: deepText(par.items), layout: par.layout };
}

const squash = (s: string) => s.replace(/\s+/g, ' ');

/** `s` around the marker `ch` (removed), with ‸ in its place; null if the marker is not in `s`. */
function excerptAt(s: string, ch: string): string | null {
  const i = s.indexOf(ch);
  if (i < 0) return null;
  const before = s.slice(Math.max(0, i - EXCERPT_SIDE), i).replace(MARKERS, '');
  const after = s.slice(i + 1, i + 1 + EXCERPT_SIDE).replace(MARKERS, '');
  return squash(`${i > EXCERPT_SIDE ? '…' : ''}${before}‸${after}${i + 1 + EXCERPT_SIDE < s.length ? '…' : ''}`);
}

/** Offset of marker `ch` in `s` with the other markers taken out (null: not there). */
function offsetOf(s: string, ch: string): number | null {
  const i = s.indexOf(ch);
  return i < 0 ? null : s.slice(0, i).replace(MARKERS, '').length;
}

export interface Place {
  /** index of the top-level paragraph (read_document's `paragraphs`) */
  paragraph: number;
  /** characters into that paragraph's text as read_document lists it; null inside a table */
  offset: number | null;
}
export interface CursorInfo extends Place {
  /** the paragraph's text around the cursor, ‸ at the cursor */
  excerpt: string;
  /** the paragraph's layout (Standard, Section, Itemize, …) */
  layout: string;
  /** set when the cursor sits somewhere read_document's paragraph text leaves out */
  inside?: string;
}
export interface SelectionInfo { from: Place; to: Place; text: string; chars: number; truncated?: true }

/**
 * Where a cursor (`{ anchor, head }`, y-prosemirror's awareness field) is: the head as a place with
 * an excerpt, and the selection between anchor and head (null when it is collapsed). Null when the
 * cursor does not resolve in this document (an old state, a deleted paragraph).
 */
export function describeCursor(ydoc: Y.Doc, cursor: { anchor?: unknown; head?: unknown } | null | undefined): { cursor: CursorInfo; selection: SelectionInfo | null } | null {
  if (!cursor) return null;
  const head = resolve(ydoc, cursor.head);
  if (!head) return null;
  const anchor = resolve(ydoc, cursor.anchor) ?? head;
  const fragment = fragmentOf(ydoc);
  try {
    const r = renderParagraph(fragment, head.key[0], [{ type: head.type, index: head.index, ch: CARET }]);
    const offset = offsetOf(r.text, CARET);
    const excerpt = excerptAt(r.deep, CARET) ?? squash(r.deep.replace(MARKERS, '').slice(0, 2 * EXCERPT_SIDE));
    const info: CursorInfo = { paragraph: head.key[0], offset, excerpt, layout: r.layout };
    if (offset === null) info.inside = r.deep.includes(CARET) ? 'a table' : 'an object without text (graphics, a formula, a page element)';
    const order = compare(anchor, head);
    if (order === 0) return { cursor: info, selection: null };
    const [from, to] = order < 0 ? [anchor, head] : [head, anchor];
    return { cursor: info, selection: selectionBetween(fragment, from, to) };
  } catch {
    return null;
  }
}

function selectionBetween(fragment: Y.XmlFragment, from: YPos, to: YPos): SelectionInfo {
  const fk = from.key[0], tk = to.key[0];
  let text: string;
  let fromOff: number | null, toOff: number | null;
  let truncated = false;
  if (fk === tk) {
    const r = renderParagraph(fragment, fk, [{ type: from.type, index: from.index, ch: FROM }, { type: to.type, index: to.index, ch: TO }]);
    const a = r.deep.indexOf(FROM), b = r.deep.indexOf(TO);
    text = a >= 0 && b > a ? r.deep.slice(a + 1, b) : '';
    fromOff = offsetOf(r.text, FROM); toOff = offsetOf(r.text, TO);
  } else {
    const rf = renderParagraph(fragment, fk, [{ type: from.type, index: from.index, ch: FROM }]);
    const rt = renderParagraph(fragment, tk, [{ type: to.type, index: to.index, ch: TO }]);
    const first = rf.deep.includes(FROM) ? rf.deep.slice(rf.deep.indexOf(FROM) + 1) : rf.deep;
    const last = rt.deep.includes(TO) ? rt.deep.slice(0, rt.deep.indexOf(TO)) : rt.deep;
    // the paragraphs in between: from the front until there is plenty, and from the back for the tail
    const head: string[] = [first];
    let headLen = first.length;
    let k = fk + 1;
    for (; k < tk && headLen < SELECTION_MAX; k++) { const t = renderParagraph(fragment, k, []).deep; head.push(t); headLen += t.length + 2; }
    const tail: string[] = [last];
    let tailLen = last.length;
    let j = tk - 1;
    for (; j >= k && tailLen < SELECTION_MAX / 4; j--) { const t = renderParagraph(fragment, j, []).deep; tail.unshift(t); tailLen += t.length + 2; }
    if (j >= k) { truncated = true; head.push(`[… ${j - k + 1} more paragraph(s) …]`); }
    text = [...head, ...tail].join('\n\n');
    fromOff = offsetOf(rf.text, FROM); toOff = offsetOf(rt.text, TO);
  }
  text = text.replace(MARKERS, '');
  const chars = text.length;
  if (text.length > SELECTION_MAX) { truncated = true; text = text.slice(0, SELECTION_MAX - 1500) + '\n[…]\n' + text.slice(-1400); }
  return { from: { paragraph: fk, offset: fromOff }, to: { paragraph: tk, offset: toOff }, text, chars, ...(truncated ? { truncated: true as const } : {}) };
}

/* ------------------------------------------------------------------ pointing at a passage */

interface CharRef { type: Y.AbstractType<any>; index: number }
/** A paragraph's searchable text: every character with the Yjs position before and after it. */
interface CharMap { text: string; start: CharRef[]; end: CharRef[] }

function charMap(el: Y.XmlElement): CharMap {
  const m: CharMap = { text: '', start: [], end: [] };
  const add = (s: string, start: CharRef, end: CharRef) => { m.text += s; for (let i = 0; i < s.length; i++) { m.start.push(start); m.end.push(end); } };
  const walk = (parent: Y.XmlElement) => {
    (parent.toArray() as (Y.XmlElement | Y.XmlText)[]).forEach((child, i) => {
      if (child instanceof Y.XmlText) {
        let off = 0;
        for (const d of child.toDelta() as { insert: unknown }[]) {
          if (typeof d.insert !== 'string') continue;
          for (let j = 0; j < d.insert.length; j++) { m.text += d.insert[j]; m.start.push({ type: child, index: off + j }); m.end.push({ type: child, index: off + j + 1 }); }
          off += d.insert.length;
        }
        return;
      }
      const latex = child.getAttribute('latex');
      if (/^math_/.test(child.nodeName) && typeof latex === 'string') {
        add(latex.replace(/^\$|\$$/g, ''), { type: parent, index: i }, { type: parent, index: i + 1 });
        return;
      }
      if (child.nodeName === 'space') { add(' ', { type: parent, index: i }, { type: parent, index: i + 1 }); return; }
      if (child.length) {
        add(' ', { type: parent, index: i }, { type: parent, index: i });
        walk(child);
        add(' ', { type: parent, index: i + 1 }, { type: parent, index: i + 1 });
      }
    });
  };
  walk(el);
  return m;
}

/** Whitespace collapsed, typographic quotes and dashes folded; with each character's index in the original. */
function normalize(s: string): { text: string; at: number[] } {
  let text = '';
  const at: number[] = [];
  let space = false;
  for (let i = 0; i < s.length; i++) {
    let c = s[i];
    if (/\s/.test(c)) { if (!space && text) { text += ' '; at.push(i); } space = true; continue; }
    space = false;
    if ('“”„«»"'.includes(c)) c = '"';
    else if ('‘’‚\''.includes(c)) c = "'";
    else if ('–—'.includes(c)) c = '-';
    text += c.toLowerCase();
    at.push(i);
  }
  return { text, at };
}

/**
 * The passage `quote` (plain text as read_document's paragraphs show it; whitespace, quotes and case
 * are matched loosely; a long quote may differ in its middle — only its first and last words must
 * match) in paragraph `paragraph`, or the first paragraph that has it. Without a quote, the whole
 * paragraph. Null when not found.
 */
export function findPassage(ydoc: Y.Doc, opts: { quote?: string; paragraph?: number }): (Cursor & { paragraph: number }) | null {
  const fragment = fragmentOf(ydoc);
  const n = fragment.length;
  const rel = (r: CharRef, assoc = 0) => Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(r.type, r.index, assoc)) as RelJSON;
  const range = (k: number, a: CharRef, b: CharRef) => ({ anchor: rel(a), head: rel(b, -1), paragraph: k });
  const quote = normalize(opts.quote ?? '').text.trim();
  const candidates = opts.paragraph !== undefined ? [opts.paragraph] : Array.from({ length: n }, (_, i) => i);
  for (const k of candidates) {
    const el = fragment.get(k);
    if (!(el instanceof Y.XmlElement)) continue;
    const m = charMap(el);
    if (!quote) {
      if (!m.text.length) return range(k, { type: fragment, index: k }, { type: fragment, index: k + 1 });
      return range(k, m.start[0], m.end[m.end.length - 1]);
    }
    const norm = normalize(m.text);
    let s = norm.text.indexOf(quote);
    let e = s >= 0 ? s + quote.length : -1;
    if (s < 0 && quote.length > 40) {
      const pre = quote.slice(0, 20), post = quote.slice(-20);
      s = norm.text.indexOf(pre);
      const p = s >= 0 ? norm.text.indexOf(post, s + pre.length) : -1;
      e = p >= 0 ? p + post.length : -1;
      if (e < 0) s = -1;
    }
    if (s < 0) continue;
    return range(k, m.start[norm.at[s]], m.end[norm.at[e - 1]]);
  }
  return null;
}

/* ------------------------------------------------------------------ what an edit changed */

/**
 * The range a set of CRDT events changed, as a cursor (anchor at its start, head at its end) —
 * computed inside the observer callback, while the events can still be read. Null for no change.
 */
export function changedRange(fragment: Y.XmlFragment, events: Y.YEvent<any>[]): Cursor | null {
  let lo: YPos | null = null, hi: YPos | null = null;
  for (const e of events) {
    const t = e.target as Y.AbstractType<any>;
    const path = pathOf(fragment, t);
    if (!path) continue;
    let i = 0, a = Infinity, b = -Infinity;
    const delta = (t instanceof Y.XmlText ? (e as Y.YTextEvent).delta : e.changes.delta) as { insert?: unknown; retain?: number; delete?: number; attributes?: unknown }[];
    for (const op of delta) {
      if (op.retain !== undefined) { if (op.attributes) { a = Math.min(a, i); b = Math.max(b, i + op.retain); } i += op.retain; }
      else if (op.insert !== undefined) { const len = typeof op.insert === 'string' || Array.isArray(op.insert) ? op.insert.length : 1; a = Math.min(a, i); b = Math.max(b, i + len); i += len; }
      else if (op.delete !== undefined) { a = Math.min(a, i); b = Math.max(b, i); }
    }
    // a changed attribute (a paragraph's layout): the whole node
    if (a > b && (e as Y.YXmlEvent).attributesChanged?.size && t instanceof Y.XmlElement) { a = 0; b = t.length; }
    if (a > b) continue;
    const s: YPos = { type: t, index: a, key: [...path, a] };
    const f: YPos = { type: t, index: b, key: [...path, b] };
    if (!lo || compare(s, lo) < 0) lo = s;
    if (!hi || compare(f, hi) > 0) hi = f;
  }
  if (!lo || !hi) return null;
  const rel = (p: YPos, assoc = 0) => Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(p.type, p.index, assoc)) as RelJSON;
  return { anchor: rel(lo), head: rel(hi, -1) };
}
