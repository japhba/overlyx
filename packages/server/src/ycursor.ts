/**
 * Cursors and selections in a document's CRDT, in the terms the MCP tools use. A collaborator's
 * awareness `cursor` is two Yjs relative positions (client editor/collab.ts: anchor and head in the
 * CRDT's flows, core collab/positions.ts); an agent addresses a document by paragraph — the index in
 * read_document's `paragraphs`, which are the document's top-level paragraphs — and by plain text.
 *
 * describeCursor() resolves a cursor to the paragraph, the character offset into that paragraph's
 * text as read_document lists it, an excerpt with a caret, and the selected text verbatim. The text
 * is produced by the same conversion read_document uses (editor nodes → document model → itemText):
 * the paragraph is converted with private-use marker characters at the cursor's places, and where
 * the markers come out of the conversion is the answer — formulas, footnotes, quotes and special
 * characters count exactly as they do in read_document. Inside a table (whose cells read_document's
 * paragraph text leaves out) the excerpt comes from a deeper rendering with the cells, and the
 * offset is null.
 *
 * findPassage() goes the other way (the MCP `highlight` tool: an agent points at a passage it
 * quotes), and changedRange() turns the documents before and after an agent's edit into the range it
 * changed — where the agent's own cursor is shown to the people in the document.
 */
import * as Y from 'yjs';
import { Fragment, Slice, type Node as PMNode } from 'prosemirror-model';
import { pmBlocksToParagraphs, itemText, schema, type Item } from '@overlyx/core';
import { relativePosition, documentPosition } from '@overlyx/core/collab/index.ts';
import { readPm } from './collabdoc.ts';

export type RelJSON = Record<string, unknown>;
export interface Cursor { anchor: RelJSON; head: RelJSON }

const CARET = '', FROM = '', TO = '';
const MARKERS = /[-]/g;
/** characters of excerpt on either side of the caret */
const EXCERPT_SIDE = 70;
/** the longest selected text handed out (head and tail kept beyond that) */
const SELECTION_MAX = 6000;

/** a document position for a relative position (JSON), null when it does not resolve */
function resolve(ydoc: Y.Doc, doc: PMNode, json: unknown): number | null {
  try { return documentPosition(schema, ydoc, doc, Y.createRelativePositionFromJSON(json)); } catch { return null; }
}

/** the top-level paragraph a position is in (the next one when it is between two) */
function paragraphAt(doc: PMNode, pos: number): number {
  const $p = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  return Math.min($p.index(0), Math.max(0, doc.childCount - 1));
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

/**
 * Top-level paragraph `k` as read_document's text (`text`) and with table cells (`deep`), with the
 * marker characters inserted at the given document positions (each inside a text block, else at
 * the start of the paragraph).
 */
function renderParagraph(doc: PMNode, k: number, marks: { pos: number; ch: string }[]): Rendered {
  if (k < 0 || k >= doc.childCount) return { text: '', deep: '', layout: '' };
  let start = 0;
  for (let i = 0; i < k; i++) start += doc.child(i).nodeSize;
  let par = doc.child(k);
  // from the last place: the earlier positions stay valid
  for (const m of [...marks].sort((a, b) => b.pos - a.pos)) {
    // relative to the paragraph's content
    let rel = m.pos - start - 1;
    if (rel < 0 || rel > par.content.size) rel = 0;
    const mark = new Slice(Fragment.from(schema.text(m.ch)), 0, 0);
    try {
      if (!par.resolve(rel).parent.inlineContent) rel = 0;
      par = par.replace(rel, rel, mark);
    } catch {
      try { par = par.replace(0, 0, mark); } catch { /* no place for it */ }
    }
  }
  const p = pmBlocksToParagraphs([par.toJSON()])[0];
  if (!p) return { text: '', deep: '', layout: '' };
  return { text: p.items.map(itemText).join(''), deep: deepText(p.items), layout: p.layout };
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
 * Where a cursor (`{ anchor, head }`, the editors' awareness field) is: the head as a place with an
 * excerpt, and the selection between anchor and head (null when it is collapsed). Null when the
 * cursor does not resolve in this document (an old state, a deleted paragraph).
 */
export function describeCursor(ydoc: Y.Doc, cursor: { anchor?: unknown; head?: unknown } | null | undefined): { cursor: CursorInfo; selection: SelectionInfo | null } | null {
  if (!cursor) return null;
  try {
    const doc = readPm(ydoc);
    const head = resolve(ydoc, doc, cursor.head);
    if (head === null) return null;
    const anchor = resolve(ydoc, doc, cursor.anchor) ?? head;
    const k = paragraphAt(doc, head);
    const r = renderParagraph(doc, k, [{ pos: head, ch: CARET }]);
    const offset = offsetOf(r.text, CARET);
    const excerpt = excerptAt(r.deep, CARET) ?? squash(r.deep.replace(MARKERS, '').slice(0, 2 * EXCERPT_SIDE));
    const info: CursorInfo = { paragraph: k, offset, excerpt, layout: r.layout };
    if (offset === null) info.inside = r.deep.includes(CARET) ? 'a table' : 'an object without text (graphics, a formula, a page element)';
    if (anchor === head) return { cursor: info, selection: null };
    const [from, to] = anchor < head ? [anchor, head] : [head, anchor];
    return { cursor: info, selection: selectionBetween(doc, from, to) };
  } catch {
    return null;
  }
}

function selectionBetween(doc: PMNode, from: number, to: number): SelectionInfo {
  const fk = paragraphAt(doc, from), tk = paragraphAt(doc, to);
  let text: string;
  let fromOff: number | null, toOff: number | null;
  let truncated = false;
  if (fk === tk) {
    const r = renderParagraph(doc, fk, [{ pos: from, ch: FROM }, { pos: to, ch: TO }]);
    const a = r.deep.indexOf(FROM), b = r.deep.indexOf(TO);
    text = a >= 0 && b > a ? r.deep.slice(a + 1, b) : '';
    fromOff = offsetOf(r.text, FROM); toOff = offsetOf(r.text, TO);
  } else {
    const rf = renderParagraph(doc, fk, [{ pos: from, ch: FROM }]);
    const rt = renderParagraph(doc, tk, [{ pos: to, ch: TO }]);
    const first = rf.deep.includes(FROM) ? rf.deep.slice(rf.deep.indexOf(FROM) + 1) : rf.deep;
    const last = rt.deep.includes(TO) ? rt.deep.slice(0, rt.deep.indexOf(TO)) : rt.deep;
    // the paragraphs in between: from the front until there is plenty, and from the back for the tail
    const head: string[] = [first];
    let headLen = first.length;
    let k = fk + 1;
    for (; k < tk && headLen < SELECTION_MAX; k++) { const t = renderParagraph(doc, k, []).deep; head.push(t); headLen += t.length + 2; }
    const tail: string[] = [last];
    let tailLen = last.length;
    let j = tk - 1;
    for (; j >= k && tailLen < SELECTION_MAX / 4; j--) { const t = renderParagraph(doc, j, []).deep; tail.unshift(t); tailLen += t.length + 2; }
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

/** A paragraph's searchable text: every character with the document positions before and after it. */
interface CharMap { text: string; start: number[]; end: number[] }

function charMap(par: PMNode, at: number): CharMap {
  const m: CharMap = { text: '', start: [], end: [] };
  const add = (s: string, start: number, end: number) => { m.text += s; for (let i = 0; i < s.length; i++) { m.start.push(start); m.end.push(end); } };
  const walk = (node: PMNode, pos: number) => {
    node.forEach((child, off) => {
      const p = pos + off;
      if (child.isText) { for (let j = 0; j < child.text!.length; j++) add(child.text![j], p + j, p + j + 1); return; }
      const latex = child.attrs?.latex;
      if (/^math_/.test(child.type.name) && typeof latex === 'string') { add(latex.replace(/^\$|\$$/g, ''), p, p + child.nodeSize); return; }
      if (child.type.name === 'space') { add(' ', p, p + 1); return; }
      if (child.isTextblock) { walk(child, p + 1); add(' ', p + child.nodeSize - 1, p + child.nodeSize - 1); return; }
      if (child.content.size) { add(' ', p, p); walk(child, p + 1); add(' ', p + child.nodeSize, p + child.nodeSize); }
    });
  };
  walk(par, at + 1);
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
  const doc = readPm(ydoc);
  const rel = (pos: number, assoc = 0): RelJSON | null => { const r = relativePosition(schema, ydoc, doc, pos, assoc); return r ? Y.relativePositionToJSON(r) as RelJSON : null; };
  const range = (k: number, a: number, b: number) => { const anchor = rel(a), head = rel(b, -1); return anchor && head ? { anchor, head, paragraph: k } : null; };
  const quote = normalize(opts.quote ?? '').text.trim();
  const starts: number[] = [];
  { let p = 0; doc.forEach(c => { starts.push(p); p += c.nodeSize; }); }
  const candidates = opts.paragraph !== undefined ? [opts.paragraph] : starts.map((_s, i) => i);
  for (const k of candidates) {
    if (k < 0 || k >= doc.childCount) continue;
    const par = doc.child(k);
    const m = charMap(par, starts[k]);
    if (!quote) {
      if (!m.text.length) return range(k, starts[k] + 1, starts[k] + 1);
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

/** the number of top-level paragraphs (read_document's) */
export function paragraphCount(ydoc: Y.Doc): number { return readPm(ydoc).childCount; }

/* ------------------------------------------------------------------ what an edit changed */

/**
 * The range an edit changed (the document before it, and the CRDT after it), as a cursor (anchor at
 * its start, head at its end). Null for no change.
 */
export function changedRange(ydoc: Y.Doc, before: PMNode): Cursor | null {
  const after = readPm(ydoc);
  const start = before.content.findDiffStart(after.content);
  if (start == null) return null;
  const end = before.content.findDiffEnd(after.content);
  let to = end ? Math.max(end.b, start) : after.content.size;
  to = Math.min(to, after.content.size);
  const a = relativePosition(schema, ydoc, after, Math.min(start, after.content.size), 0);
  const h = relativePosition(schema, ydoc, after, to, -1);
  if (!a || !h) return null;
  return { anchor: Y.relativePositionToJSON(a) as RelJSON, head: Y.relativePositionToJSON(h) as RelJSON };
}
