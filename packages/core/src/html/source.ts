/**
 * HTML deliverables (slide decks, posters, web pages — a folder with an index.html that agents and
 * people write freely): the editor never models the page itself. The file's text is the document;
 * the canvas shows it rendered and turns what people do there (move, resize, retype, delete, insert,
 * reorder) into small edits of that text, here. Elements are addressed by their *path* — indices
 * among element children from <html> — which the editor's frame computes on its own parse of the
 * same text (the browser's parser and parse5 build the same tree), so no marker is ever written into
 * the file. Every edit is a list of splices in the coordinates of the text it was made on; text
 * outside them stays byte for byte.
 */
import { parse, type DefaultTreeAdapterMap } from 'parse5';

export type HNode = DefaultTreeAdapterMap['node'];
export type HElement = DefaultTreeAdapterMap['element'];
export type HDocument = DefaultTreeAdapterMap['document'];
type Location = NonNullable<HElement['sourceCodeLocation']>;

/** Replace text[from, to) by `insert` (offsets in the text the edit was made for). */
export interface Splice { from: number; to: number; insert: string }

export interface SourceDoc { text: string; doc: HDocument }

/** The text parsed with source locations — as a browser's DOMParser would (scripting off: <noscript> parses as markup). */
export function parseSource(text: string): SourceDoc {
  return { text, doc: parse(text, { sourceCodeLocationInfo: true, scriptingEnabled: false }) };
}

export const isElement = (n: HNode): n is HElement => 'tagName' in n;

/** element children only (a <template>'s content is not among its children, as in the DOM) */
export function elementChildren(el: HElement | HDocument): HElement[] {
  return (el.childNodes as HNode[]).filter(isElement);
}

export function htmlElement(doc: HDocument): HElement | null {
  return elementChildren(doc).find(e => e.tagName === 'html') ?? null;
}

/** the element at `path` (indices among element children, from <html>), or null */
export function elementAt(doc: HDocument, path: readonly number[]): HElement | null {
  let el = htmlElement(doc);
  for (const i of path) {
    if (!el) return null;
    el = elementChildren(el)[i] ?? null;
  }
  return el;
}

/** the path of an element (see elementAt) */
export function pathOf(el: HElement): number[] {
  const out: number[] = [];
  let cur: HElement = el;
  while (cur.parentNode && isElement(cur.parentNode as HNode)) {
    const parent = cur.parentNode as HElement;
    out.unshift(elementChildren(parent).indexOf(cur));
    cur = parent;
  }
  return out;
}

export function attr(el: HElement, name: string): string | null {
  return el.attrs.find(a => a.name === name)?.value ?? null;
}

export function hasClass(el: HElement, cls: string): boolean {
  return (attr(el, 'class') ?? '').split(/\s+/).includes(cls);
}

/** every element in document order */
export function* walk(n: HElement | HDocument): Generator<HElement> {
  for (const c of elementChildren(n)) {
    yield c;
    yield* walk(c);
  }
}

/** The element whose start tag begins at `offset` (after an edit: the same element found again). */
export function elementStartingAt(doc: HDocument, offset: number): HElement | null {
  for (const el of walk(doc)) if (el.sourceCodeLocation?.startOffset === offset) return el;
  return null;
}

/* ------------------------------------------------------------------ inline styles */

/** `a: b; c: d` → declarations in order (a value keeps its own `!important`); parentheses and quotes respected */
export function parseStyle(s: string): { prop: string; value: string }[] {
  const out: { prop: string; value: string }[] = [];
  let depth = 0, quote = '', start = 0;
  const flush = (end: number) => {
    const d = s.slice(start, end);
    const c = d.indexOf(':');
    if (c > 0) {
      const prop = d.slice(0, c).trim();
      const value = d.slice(c + 1).trim();
      if (prop) out.push({ prop, value });
    }
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ';' && depth === 0) { flush(i); start = i + 1; }
  }
  flush(s.length);
  return out;
}

export function formatStyle(decls: { prop: string; value: string }[]): string {
  return decls.map(d => `${d.prop}: ${d.value}`).join('; ');
}

/** the element's inline style as a map (property names lower-cased) */
export function inlineStyle(el: HElement): Map<string, string> {
  return new Map(parseStyle(attr(el, 'style') ?? '').map(d => [d.prop.toLowerCase(), d.value]));
}

/** `set` applied to a style attribute's value: changed properties keep their place, new ones go last, null removes */
export function editStyle(style: string, set: Record<string, string | null>): string {
  const decls = parseStyle(style);
  const keys = new Map(Object.entries(set).map(([k, v]) => [k.toLowerCase(), v]));
  const out: { prop: string; value: string }[] = [];
  for (const d of decls) {
    const k = d.prop.toLowerCase();
    if (!keys.has(k)) { out.push(d); continue; }
    const v = keys.get(k);
    keys.delete(k);
    if (v === null || v === undefined || v === '') continue;
    out.push({ prop: d.prop, value: /!important\s*$/i.test(d.value) && !/!important/i.test(v) ? `${v} !important` : v });
  }
  for (const [k, v] of keys) if (v !== null && v !== undefined && v !== '') out.push({ prop: k, value: v });
  return formatStyle(out);
}

/* ------------------------------------------------------------------ attributes */

const escapeAttr = (v: string, q: string) => v.replace(/&/g, '&amp;').replace(q === '"' ? /"/g : /'/g, q === '"' ? '&quot;' : '&#39;');

interface TagLocation { startOffset: number; endOffset: number; attrs?: Record<string, { startOffset: number; endOffset: number }> }

function startTagLoc(el: HElement): TagLocation {
  const st = el.sourceCodeLocation?.startTag as TagLocation | undefined;
  if (!st) throw new Error(`<${el.tagName}> has no start tag in the source`);
  return { ...st, attrs: st.attrs ?? (el.sourceCodeLocation as TagLocation).attrs };
}

/** Set (or with null remove) an attribute in the element's start tag; null when nothing changes. */
export function attrSplice(text: string, el: HElement, name: string, value: string | null): Splice | null {
  const st = startTagLoc(el);
  // (the parser keys attribute locations by the name as lower case: an SVG's viewBox is "viewbox" there)
  const loc = st.attrs?.[name] ?? st.attrs?.[name.toLowerCase()];
  if (loc) {
    if (value === null) {
      // the attribute and the whitespace before it
      let from = loc.startOffset;
      while (from > st.startOffset && /\s/.test(text[from - 1])) from--;
      return { from, to: loc.endOffset, insert: '' };
    }
    const src = text.slice(loc.startOffset, loc.endOffset);
    const eq = src.indexOf('=');
    const rawVal = eq < 0 ? '' : src.slice(eq + 1).trim();
    const q = rawVal.startsWith("'") ? "'" : '"';
    if (attr(el, name) === value) return null;
    return { from: loc.startOffset, to: loc.endOffset, insert: `${src.slice(0, eq < 0 ? src.length : eq)}=${q}${escapeAttr(value, q)}${q}` };
  }
  if (value === null) return null;
  // before the start tag's ">" (or "/>")
  let at = st.endOffset - 1;
  if (text[at - 1] === '/') at--;
  while (at > st.startOffset && /\s/.test(text[at - 1])) at--;
  return { from: at, to: at, insert: ` ${name}="${escapeAttr(value, '"')}"` };
}

export function styleSplice(text: string, el: HElement, set: Record<string, string | null>): Splice | null {
  const next = editStyle(attr(el, 'style') ?? '', set);
  return attrSplice(text, el, 'style', next ? next : null);
}

/* ------------------------------------------------------------------ content */

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/** where the element's content lies in the text (null: a void element, or one the parser made up) */
export function innerRange(el: HElement): { from: number; to: number } | null {
  const loc = el.sourceCodeLocation;
  if (!loc?.startTag || VOID.has(el.tagName)) return null;
  const from = loc.startTag.endOffset;
  const to = loc.endTag ? loc.endTag.startOffset : loc.endOffset;
  return to >= from ? { from, to } : null;
}

export function innerSplice(el: HElement, html: string): Splice {
  const r = innerRange(el);
  if (!r) throw new Error(`<${el.tagName}> has no content to replace`);
  return { from: r.from, to: r.to, insert: html };
}

/** the element's whole source */
export function outerRange(el: HElement): { from: number; to: number } {
  const loc = el.sourceCodeLocation;
  if (!loc) throw new Error(`<${el.tagName}> is not in the source`);
  return { from: loc.startOffset, to: loc.endOffset };
}

function lineStart(text: string, at: number): number {
  const i = text.lastIndexOf('\n', at - 1);
  return i + 1;
}

/** the indentation of the line `at` is on, when only whitespace comes before it there (else null) */
function indentBefore(text: string, at: number): string | null {
  const ls = lineStart(text, at);
  const before = text.slice(ls, at);
  return /^[ \t]*$/.test(before) ? before : null;
}

/** Remove the element; a line it had to itself goes too. */
export function removeSplice(text: string, el: HElement): Splice {
  const { from, to } = outerRange(el);
  const indent = indentBefore(text, from);
  const nl = text.indexOf('\n', to);
  const after = text.slice(to, nl < 0 ? text.length : nl);
  if (indent !== null && /^[ \t]*$/.test(after)) {
    return { from: from - indent.length, to: nl < 0 ? text.length : nl + 1, insert: '' };
  }
  return { from, to, insert: '' };
}

/** the line breaks between an element and what comes before it: one, or a blank line (slides set apart) */
function gapBefore(text: string, at: number): string {
  let i = at;
  while (i > 0 && /[ \t]/.test(text[i - 1])) i--;
  let n = 0;
  while (i > 0 && /\s/.test(text[i - 1])) { if (text[i - 1] === '\n') n++; i--; }
  return n >= 2 ? '\n\n' : '\n';
}

const reindent = (html: string, indent: string) => html.split('\n').map((l, i) => (i && l ? indent + l : l)).join('\n');

/** Insert `html` as the `index`-th element child of `parent` (past the end: last), lined up with its siblings. */
export function insertSplice(text: string, parent: HElement, index: number, html: string): Splice {
  const kids = elementChildren(parent).filter(k => k.sourceCodeLocation);
  const before = kids[index];
  if (before) {
    const at = before.sourceCodeLocation!.startOffset;
    const indent = indentBefore(text, at);
    if (indent !== null) return { from: at, to: at, insert: reindent(html, indent) + gapBefore(text, at) + indent };
    return { from: at, to: at, insert: html };
  }
  const last = kids[kids.length - 1];
  if (last) {
    const at = last.sourceCodeLocation!.endOffset;
    const indent = indentBefore(text, last.sourceCodeLocation!.startOffset);
    if (indent !== null) return { from: at, to: at, insert: gapBefore(text, last.sourceCodeLocation!.startOffset) + indent + reindent(html, indent) };
    return { from: at, to: at, insert: html };
  }
  const r = innerRange(parent);
  if (!r) throw new Error(`<${parent.tagName}> cannot take content`);
  const inner = text.slice(r.from, r.to);
  const pIndent = indentBefore(text, parent.sourceCodeLocation!.startOffset) ?? '';
  if (/^\s*$/.test(inner)) {
    const ind = pIndent + '  ';
    return { from: r.from, to: r.to, insert: '\n' + ind + reindent(html, ind) + '\n' + pIndent };
  }
  return { from: r.to, to: r.to, insert: html };
}

/** The element's source again right after it (on a line of its own when it has one). */
export function duplicateSplice(text: string, el: HElement): Splice {
  const { from, to } = outerRange(el);
  const src = text.slice(from, to);
  const indent = indentBefore(text, from);
  return { from: to, to, insert: indent !== null ? '\n' + indent + src : src };
}

/* ------------------------------------------------------------------ edits */

export type Path = number[];
export type HtmlOp =
  | { t: 'style'; path: Path; set: Record<string, string | null> }
  | { t: 'attr'; path: Path; name: string; value: string | null }
  | { t: 'inner'; path: Path; html: string }
  | { t: 'outer'; path: Path; html: string }
  | { t: 'remove'; paths: Path[] }
  | { t: 'insert'; parent: Path; index: number; html: string }
  | { t: 'move'; path: Path; parent: Path; index: number }
  | { t: 'duplicate'; paths: Path[] }
  /** the element children of `parent` in a new order (`order[k]`: the index of the child that comes k-th); the text between them stays put */
  | { t: 'reorder'; parent: Path; order: number[] };

/** apply non-overlapping splices (in `text`'s coordinates) */
export function applySplices(text: string, splices: readonly Splice[]): string {
  const s = [...splices].sort((a, b) => b.from - a.from || b.to - a.to);
  let out = text;
  for (const x of s) out = out.slice(0, x.from) + x.insert + out.slice(x.to);
  return out;
}

const need = (doc: HDocument, path: Path, located = true): HElement => {
  const el = elementAt(doc, path);
  if (!el || (located && !el.sourceCodeLocation)) throw new Error('the element is no longer there');
  return el;
};

/** An editor operation as splices of `src.text`. */
export function opSplices(src: SourceDoc, op: HtmlOp): Splice[] {
  const { text, doc } = src;
  switch (op.t) {
    case 'style': { const s = styleSplice(text, need(doc, op.path), op.set); return s ? [s] : []; }
    case 'attr': { const s = attrSplice(text, need(doc, op.path), op.name, op.value); return s ? [s] : []; }
    case 'inner': return [innerSplice(need(doc, op.path), op.html)];
    case 'outer': { const r = outerRange(need(doc, op.path)); return [{ ...r, insert: op.html }]; }
    case 'remove': {
      // an element inside another one removed as well is gone with it
      const els = op.paths.map(p => need(doc, p));
      const kept = els.filter(e => !els.some(o => o !== e && contains(o, e)));
      return kept.map(e => removeSplice(text, e));
    }
    case 'insert': return [insertSplice(text, need(doc, op.parent, false), op.index, op.html)];
    case 'reorder': {
      const kids = elementChildren(need(doc, op.parent, false)).filter(k => k.sourceCodeLocation);
      if (op.order.length !== kids.length || new Set(op.order).size !== kids.length || op.order.some(i => !(i >= 0 && i < kids.length))) throw new Error('the children changed');
      if (op.order.every((i, k) => i === k)) return [];
      const from = kids[0].sourceCodeLocation!.startOffset, to = kids[kids.length - 1].sourceCodeLocation!.endOffset;
      const parts = kids.map(k => text.slice(k.sourceCodeLocation!.startOffset, k.sourceCodeLocation!.endOffset));
      const gaps = kids.slice(1).map((k, i) => text.slice(kids[i].sourceCodeLocation!.endOffset, k.sourceCodeLocation!.startOffset));
      return [{ from, to, insert: op.order.map((i, k) => (k ? gaps[k - 1] : '') + parts[i]).join('') }];
    }
    case 'duplicate': {
      const els = op.paths.map(p => need(doc, p));
      return els.filter(e => !els.some(o => o !== e && contains(o, e))).map(e => duplicateSplice(text, e));
    }
    case 'move': {
      const el = need(doc, op.path);
      const parent = need(doc, op.parent, false);
      if (el === parent || contains(el, parent)) throw new Error('cannot move an element into itself');
      const { from, to } = outerRange(el);
      const html = text.slice(from, to);
      // the index counts the siblings without the element itself
      const siblings = elementChildren(parent).filter(k => k !== el && k.sourceCodeLocation);
      const before = siblings[op.index];
      if (before === nextElementSibling(el) && parent === el.parentNode) return [];
      if (!before && parent === el.parentNode && siblings[siblings.length - 1] === previousElementSibling(el) && !nextElementSibling(el)) return [];
      const rm = removeSplice(text, el);
      // inserted where it would go if it were not there
      const ins = before ? insertBeforeSplice(text, before, html) : appendSplice(text, parent, siblings, html);
      return [rm, ins];
    }
  }
}

function insertBeforeSplice(text: string, before: HElement, html: string): Splice {
  const at = before.sourceCodeLocation!.startOffset;
  const indent = indentBefore(text, at);
  return indent !== null ? { from: at, to: at, insert: reindent(html, indent) + '\n' + indent } : { from: at, to: at, insert: html };
}

function appendSplice(text: string, parent: HElement, siblings: HElement[], html: string): Splice {
  const last = siblings[siblings.length - 1];
  if (last) {
    const at = last.sourceCodeLocation!.endOffset;
    const indent = indentBefore(text, last.sourceCodeLocation!.startOffset);
    return { from: at, to: at, insert: indent !== null ? '\n' + indent + reindent(html, indent) : html };
  }
  const r = innerRange(parent)!;
  return { from: r.to, to: r.to, insert: html };
}

function contains(outer: HElement, inner: HElement): boolean {
  for (let n = inner.parentNode as HNode | null; n; n = (n as HElement).parentNode as HNode | null) {
    if (n === outer) return true;
    if (!isElement(n)) break;
  }
  return false;
}

function nextElementSibling(el: HElement): HElement | null {
  const sib = elementChildren(el.parentNode as HElement);
  return sib[sib.indexOf(el) + 1] ?? null;
}
function previousElementSibling(el: HElement): HElement | null {
  const sib = elementChildren(el.parentNode as HElement);
  return sib[sib.indexOf(el) - 1] ?? null;
}

/** An operation applied: the new text (throws when its element is gone). */
export function applyOp(text: string, op: HtmlOp): string {
  return applySplices(text, opSplices(parseSource(text), op));
}

/* ------------------------------------------------------------------ versions */

/**
 * Where a position of `oldText` is in `newText` — through the one changed region between them
 * (common prefix and suffix); null inside it.
 */
export function mapOffset(oldText: string, newText: string, offset: number): number | null {
  let p = 0;
  const max = Math.min(oldText.length, newText.length);
  while (p < max && oldText.charCodeAt(p) === newText.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && oldText.charCodeAt(oldText.length - 1 - s) === newText.charCodeAt(newText.length - 1 - s)) s++;
  if (offset <= p) return offset;
  if (offset >= oldText.length - s) return offset + (newText.length - oldText.length);
  return null;
}

/** The path, in `newText`, of the element at `path` in `oldText` (null when that element changed or went). */
export function rebasePath(oldText: string, newText: string, path: Path): Path | null {
  if (oldText === newText) return path;
  const el = elementAt(parseSource(oldText).doc, path);
  const at = el?.sourceCodeLocation?.startOffset;
  if (at === undefined) return null;
  const to = mapOffset(oldText, newText, at);
  if (to === null) return null;
  const found = elementStartingAt(parseSource(newText).doc, to);
  return found && found.tagName === el!.tagName ? pathOf(found) : null;
}

/** the paths of an operation */
export function opPaths(op: HtmlOp): Path[] {
  switch (op.t) {
    case 'remove': case 'duplicate': return op.paths;
    case 'insert': case 'reorder': return [op.parent];
    case 'move': return [op.path, op.parent];
    default: return [op.path];
  }
}

/** The operation with its paths rebased from `oldText` to `newText` (null when one of its elements changed). */
export function rebaseOp(oldText: string, newText: string, op: HtmlOp): HtmlOp | null {
  if (oldText === newText) return op;
  const map = (p: Path) => rebasePath(oldText, newText, p);
  switch (op.t) {
    case 'remove': case 'duplicate': { const ps = op.paths.map(map); return ps.every(Boolean) ? { ...op, paths: ps as Path[] } : null; }
    case 'insert': case 'reorder': { const p = map(op.parent); return p ? { ...op, parent: p } : null; }
    case 'move': { const a = map(op.path), b = map(op.parent); return a && b ? { ...op, path: a, parent: b } : null; }
    default: { const p = map(op.path); return p ? { ...op, path: p } : null; }
  }
}
