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
import { parse, parseFragment, serialize, type DefaultTreeAdapterMap } from 'parse5';
import { mergedTextSplices, textChanges, spliceText, balancedInlineHtml } from './textedit.ts';

export type HNode = DefaultTreeAdapterMap['node'];
export type HElement = DefaultTreeAdapterMap['element'];
export type HDocument = DefaultTreeAdapterMap['document'];
type Location = NonNullable<HElement['sourceCodeLocation']>;

/** Replace text[from, to) by `insert` (offsets in the text the edit was made for). */
export interface Splice { from: number; to: number; insert: string }

export interface SourceDoc { text: string; doc: HDocument }

/**
 * The last texts parsed: an edit asks for the same text's tree several times (the speaker notes, the
 * review, the margins, the edit itself) — a deck with much ink is half a MB, ~50 ms a parse, and each
 * pen stroke parsed it ten times. Trees are only read, never changed. Let go of after a while (a big
 * page's tree is many MB), the last one later: the next edit's tree is made from it (sourcePatch).
 */
const parsed: SourceDoc[] = [];
/** texts known to follow from a parsed one by a patch (sourcePatch): their trees made from that one's */
const derivable: { prev: SourceDoc; patch: SourcePatch; next: string }[] = [];
let forgetParsed: ReturnType<typeof setTimeout> | null = null;
const PARSE_OPTS = { sourceCodeLocationInfo: true, scriptingEnabled: false } as const;

function remember(src: SourceDoc): void {
  parsed.unshift(src);
  if (parsed.length > 3) parsed.length = 3;
  if (forgetParsed) clearTimeout(forgetParsed);
  forgetParsed = setTimeout(() => {
    parsed.length = Math.min(parsed.length, 1); derivable.length = 0;
    forgetParsed = setTimeout(() => { parsed.length = 0; forgetParsed = null; }, 300000);
    (forgetParsed as { unref?: () => void }).unref?.();
  }, 10000);
  (forgetParsed as { unref?: () => void }).unref?.();
}

/** The text parsed with source locations — as a browser's DOMParser would (scripting off: <noscript> parses as markup). */
export function parseSource(text: string): SourceDoc {
  const known = parsed.find(p => p.text === text);
  if (known) return known;
  const d = derivable.find(x => x.next === text);
  let doc: HDocument | null = null;
  // (the patch's own text where it says: else parsed after all)
  if (d && text.startsWith(d.patch.html, d.patch.from)) { try { doc = derivedDoc(d.prev, d.patch, text.length - d.prev.text.length); } catch { doc = null; } }
  const src = { text, doc: doc ?? parse(text, PARSE_OPTS) };
  remember(src);
  return src;
}

/* ------------------------------------------------------------------ patches */

/**
 * An edit of the text inside one element (a stroke added to a slide, an object moved on it): that
 * element's `path`, the stretch of the old text replaced (`from`–`to`) and what came instead (`html`)
 * — the element's whole content, or (`at`) `count` of its child nodes from the `at`-th on (none: new
 * ones put in before that one). The frames bring their page up to date with it instead of parsing all
 * of the new text, and parseSource makes the new text's tree from the old one's (what came in parsed
 * in the element's place, the rest kept): a pen stroke on a deck with much ink parsed half a MB twice.
 */
export interface SourcePatch { path: Path; from: number; to: number; html: string; at?: number; count?: number }

/**
 * Elements whose content parses the same on its own (in their place) as within the page: the parser
 * ends them only at their end tag, whatever comes inside — not a <p> (a <div> in it ends it), a
 * table's parts, a list item, an inline element. HTML ones only.
 */
const CONTAINERS = new Set(['section', 'div', 'main', 'article', 'aside', 'header', 'footer', 'nav', 'figure']);
const HTML_NS = 'http://www.w3.org/1999/xhtml';
const SCRIPT = /<\/?script\b/i;
export const patchContainer = (tagName: string, namespaceURI: string): boolean => namespaceURI === HTML_NS && CONTAINERS.has(tagName);

/**
 * How `next` follows from `prev` as a SourcePatch — from the splices that made it, else from the one
 * stretch where they differ — or null: prev's tree not at hand (nothing is parsed here), or the change
 * not within one container's content (a <script> in or out: the frames load the page again). Kept, so
 * that parseSource(next) makes its tree from prev's.
 */
export function sourcePatch(prev: string, next: string, splices?: readonly Splice[]): SourcePatch | null {
  if (prev === next) return null;
  const src = parsed.find(p => p.text === prev) ?? (derivable.some(x => x.next === prev) ? parseSource(prev) : null);
  if (!src) return null;
  const delta = next.length - prev.length;
  let change: Splice;
  if (splices?.length) {
    const s = [...splices].sort((a, b) => a.from - b.from);
    if (s.reduce((n, x) => n + x.insert.length - (x.to - x.from), 0) !== delta) return null;
    const from = s[0].from, to = Math.max(...s.map(x => x.to));
    change = s.length === 1 ? s[0] : { from, to, insert: next.slice(from, to + delta) };
  } else change = changedStretch(prev, next);
  // (a script in or out: the frames load the page again)
  if (SCRIPT.test(change.insert) || SCRIPT.test(prev.slice(change.from, change.to))) return null;
  // (new nodes among a container's children where the change can be put so; else that container's content)
  let best: SourcePatch | null = null;
  for (const c of splices?.length ? [change] : alignments(prev, change)) { best = patchAt(src, c, false); if (best) break; }
  best ??= patchAt(src, change, true);
  if (best) { derivable.unshift({ prev: src, patch: best, next }); if (derivable.length > 3) derivable.length = 3; }
  return best;
}

/** the one stretch where two texts differ (their common start and end compared a KB at a time first) */
function changedStretch(a: string, b: string): Splice {
  const m = Math.min(a.length, b.length);
  let p = 0;
  while (p + 1024 <= m && a.slice(p, p + 1024) === b.slice(p, p + 1024)) p += 1024;
  while (p < m && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  let s = 0;
  while (s + 1024 <= m - p && a.slice(a.length - s - 1024, a.length - s) === b.slice(b.length - s - 1024, b.length - s)) s += 1024;
  while (s < m - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
  return { from: p, to: a.length - s, insert: b.slice(p, b.length - s) };
}

/**
 * The same change put elsewhere: text put in (or taken out) where the same characters come before or
 * after it could as well have gone a few places on — `</svg>\n  <svg …></svg>\n  ` added after a stroke
 * is also `<svg …></svg>\n  </svg>\n  ` added inside it. A place between two elements is looked for.
 */
function alignments(text: string, c: Splice): Splice[] {
  const out = [c];
  const ins = c.from === c.to, del = !c.insert;
  if (ins === del) return out;
  const MAX = 96;
  if (ins) {
    let x = c.insert, f = c.from;
    for (let k = 0; k < MAX && f > 0 && text[f - 1] === x[x.length - 1]; k++) { x = text[f - 1] + x.slice(0, -1); f--; out.push({ from: f, to: f, insert: x }); }
    x = c.insert; f = c.from;
    for (let k = 0; k < MAX && f < text.length && text[f] === x[0]; k++) { x = x.slice(1) + text[f]; f++; out.push({ from: f, to: f, insert: x }); }
  } else {
    const n = c.to - c.from;
    for (let f = c.from, k = 0; k < MAX && f > 0 && text[f - 1] === text[f - 1 + n]; k++) { f--; out.push({ from: f, to: f + n, insert: '' }); }
    for (let f = c.from, k = 0; k < MAX && f + n < text.length && text[f] === text[f + n]; k++) { f++; out.push({ from: f, to: f + n, insert: '' }); }
  }
  return out;
}

/** the patch of the change `c` of src's text: the deepest container holding it, new nodes among its children where they can be (else, `whole`, its content) */
function patchAt(src: SourceDoc, c: Splice, whole: boolean): SourcePatch | null {
  let el = htmlElement(src.doc);
  if (!el) return null;
  let box: HElement | null = null, boxPath: Path = [];
  const path: Path = [];
  for (;;) {
    const kids = elementChildren(el);
    let found = -1;
    for (let i = 0; i < kids.length; i++) {
      const loc = kids[i].sourceCodeLocation;
      if (!loc?.startTag || !loc.endTag) continue;
      if (loc.startOffset > c.from) break;
      if (loc.startTag.endOffset <= c.from && c.to <= loc.endTag.startOffset) { found = i; break; }
    }
    if (found < 0) break;
    el = kids[found];
    path.push(found);
    if (patchContainer(el.tagName, el.namespaceURI)) { box = el; boxPath = [...path]; }
  }
  if (!box) return null;
  const loc = box.sourceCodeLocation!, from = loc.startTag!.endOffset, to = loc.endTag!.startOffset;
  if (SCRIPT.test(c.insert)) return null;
  // the container's child nodes the change touches (none: it goes in between two), widened over the text
  // beside them — what comes in is then joined with nothing beside it —, each ended where it ends
  const kids = box.childNodes as HNode[];
  if (kids.every(k => k.sourceCodeLocation)) {
    const start = (k: HNode) => k.sourceCodeLocation!.startOffset, end = (k: HNode) => k.sourceCodeLocation!.endOffset;
    let a = 0;
    while (a < kids.length && end(kids[a]) <= c.from && !(c.from === c.to && end(kids[a]) === c.from && start(kids[a]) === c.from)) a++;
    let b = a;
    while (b < kids.length && (start(kids[b]) < c.to || (b === a && start(kids[b]) < c.from))) b++;
    if (a > 0 && kids[a - 1].nodeName === '#text') a--;
    if (b < kids.length && kids[b].nodeName === '#text') b++;
    const sFrom = a < b ? start(kids[a]) : c.from, sTo = a < b ? end(kids[b - 1]) : c.from;
    // (one left open before the stretch, or at its end: what follows would go into it)
    const open = (k: HNode | undefined) => !!k && isElement(k) && !k.sourceCodeLocation?.endTag && !VOID.has(k.tagName);
    if (sFrom <= c.from && c.to <= sTo && !open(kids[a - 1]) && !open(kids[b - 1])) {
      const old = src.text.slice(sFrom, sTo);
      const html = old.slice(0, c.from - sFrom) + c.insert + old.slice(c.to - sFrom);
      const fr = parseFragment(box, html, PARSE_OPTS) as unknown as { childNodes: HNode[] };
      if (!SCRIPT.test(old) && !open(fr.childNodes[fr.childNodes.length - 1])) return { path: boxPath, from: sFrom, to: sTo, html, at: a, count: b - a };
    }
  }
  if (!whole) return null;
  const old = src.text.slice(from, to);
  if (SCRIPT.test(old)) return null;
  return { path: boxPath, from, to, html: old.slice(0, c.from - from) + c.insert + old.slice(c.to - from) };
}

/**
 * The tree of the text after the patch, made from the tree before: the container's content (or the
 * nodes put among it) parsed in its place, every other node the same with its place in the text moved
 * on past the change. (Built anew — the old tree stays as it was: it may still be in use.)
 */
function derivedDoc(prev: SourceDoc, p: SourcePatch, delta: number): HDocument {
  const box = elementAt(prev.doc, p.path);
  if (!box || !patchContainer(box.tagName, box.namespaceURI)) throw new Error('no such container');
  const frag = parseFragment(box, p.html, PARSE_OPTS) as unknown as { childNodes: HNode[] };
  const { from, to } = p;
  const copy = (x: HNode, parent: unknown): HNode => {
    const y = { ...x, parentNode: parent } as HNode & { childNodes?: HNode[]; content?: HNode };
    const l = x.sourceCodeLocation;
    if (l) (y as { sourceCodeLocation?: unknown }).sourceCodeLocation = movedLoc(l as Loc, from, to, delta);
    if (x === box) {
      const added = frag.childNodes.map(n => fresh(n, y, from));
      const old = box.childNodes as HNode[], n = p.count ?? 0;
      y.childNodes = p.at === undefined ? added : [...old.slice(0, p.at).map(k => copy(k, y)), ...added, ...old.slice(p.at + n).map(k => copy(k, y))];
    } else if ('childNodes' in x) y.childNodes = (x.childNodes as HNode[]).map(k => copy(k, y));
    if ('content' in x && x.content) y.content = copy(x.content as unknown as HNode, null);
    return y;
  };
  // (the new nodes: their places in the parsed content moved to where it is)
  const fresh = (x: HNode, parent: unknown, by: number): HNode => {
    const y = x as HNode & { parentNode: unknown; childNodes?: HNode[]; content?: HNode };
    y.parentNode = parent;
    if (x.sourceCodeLocation) (y as { sourceCodeLocation?: unknown }).sourceCodeLocation = movedLoc(x.sourceCodeLocation as Loc, -1, -1, by);
    if (y.childNodes) for (const k of y.childNodes) fresh(k, y, by);
    if (y.content) fresh(y.content, null, by);
    return y;
  };
  const doc = { ...prev.doc } as HDocument;
  doc.childNodes = (prev.doc.childNodes as HNode[]).map(k => copy(k, doc)) as HDocument['childNodes'];
  return doc;
}

interface Loc { startOffset: number; endOffset: number; startLine: number; startCol: number; endLine: number; endCol: number; startTag?: Loc; endTag?: Loc; attrs?: Record<string, Loc> }

/**
 * A place in the text after a change of [from, to) by `d` characters: where it starts moves when it
 * starts at or after the change's end, where it ends when it ends after the change's start (lines and
 * columns are not kept up: nothing reads them). Wholly after the change: an attribute's place is
 * worked out once asked for (MovedLoc).
 */
function movedLoc(l: Loc, from: number, to: number, d: number): Loc {
  if (l.endOffset <= from) return l;
  if (l.startOffset >= to) return new MovedLoc(l, d);
  const out: Loc = { ...l, startOffset: l.startOffset >= to ? l.startOffset + d : l.startOffset, endOffset: l.endOffset > from ? l.endOffset + d : l.endOffset };
  if (l.startTag) out.startTag = movedLoc(l.startTag, from, to, d);
  if (l.endTag) out.endTag = movedLoc(l.endTag, from, to, d);
  if (l.attrs) out.attrs = Object.fromEntries(Object.entries(l.attrs).map(([k, a]) => [k, movedLoc(a, from, to, d)]));
  return out;
}

class MovedLoc implements Loc {
  startOffset: number; endOffset: number; startLine: number; startCol: number; endLine: number; endCol: number;
  startTag?: Loc; endTag?: Loc;
  /** the attributes' places before any move, and by how much they all moved since */
  #attrs: Record<string, Loc> | undefined; #by: number; #moved: Record<string, Loc> | undefined;
  constructor(l: Loc, d: number) {
    this.startOffset = l.startOffset + d; this.endOffset = l.endOffset + d;
    this.startLine = l.startLine; this.startCol = l.startCol; this.endLine = l.endLine; this.endCol = l.endCol;
    if (l.startTag) this.startTag = new MovedLoc(l.startTag, d);
    if (l.endTag) this.endTag = new MovedLoc(l.endTag, d);
    if (l instanceof MovedLoc) { this.#attrs = l.#attrs; this.#by = l.#by + d; }
    else { this.#attrs = l.attrs; this.#by = d; }
  }
  get attrs(): Record<string, Loc> | undefined {
    if (!this.#attrs) return undefined;
    if (!this.#moved) { const by = this.#by; this.#moved = Object.fromEntries(Object.entries(this.#attrs).map(([k, a]) => [k, { ...a, startOffset: a.startOffset + by, endOffset: a.endOffset + by }])); }
    return this.#moved;
  }
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

/** Set (or with null remove) an attribute in the element's start tag; null when nothing changes. A new attribute is quoted with `quote` (an existing one keeps its quotes). */
export function attrSplice(text: string, el: HElement, name: string, value: string | null, quote: '"' | "'" = '"'): Splice | null {
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
  return { from: at, to: at, insert: ` ${name}=${quote}${escapeAttr(value, quote)}${quote}` };
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
  /** (`q`: the quotes of a new attribute — single ones for a JSON value) */
  | { t: 'attr'; path: Path; name: string; value: string | null; q?: "'" }
  /** before: the last local editing snapshot; concurrent additions must not become deletions. */
  | { t: 'inner'; path: Path; html: string; before?: string; as?: 'div' }
  | { t: 'outer'; path: Path; html: string }
  | { t: 'remove'; paths: Path[] }
  | { t: 'insert'; parent: Path; index: number; html: string }
  /** (`html`: what goes there instead of the element's own source — it moved and changed at once) */
  | { t: 'move'; path: Path; parent: Path; index: number; html?: string }
  | { t: 'duplicate'; paths: Path[] }
  /** the element children of `parent` in a new order (`order[k]`: the index of the child that comes k-th); the text between them stays put */
  | { t: 'reorder'; parent: Path; order: number[]; parts?: Record<number, string> };

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
    case 'attr': { const s = attrSplice(text, need(doc, op.path), op.name, op.value, op.q); return s ? [s] : []; }
    case 'inner': {
      const el = need(doc, op.path), range = innerRange(el);
      if (!range) throw new Error(`<${el.tagName}> has no content to replace`);
      const raw = text.slice(range.from, range.to);
      let splices: Splice[];
      if (op.before === undefined) splices = [innerSplice(el, op.html)];
      else {
        const current = serialize(parseFragment(raw));
        const before = serialize(parseFragment(op.before)), after = serialize(parseFragment(op.html));
        const edits = mergedTextSplices(before, after, current);
        if (!edits) throw new Error('Concurrent text edits overlap');
        const merged = spliceText(current, edits);
        if (!balancedInlineHtml(merged)) throw new Error('Concurrent formatting edits overlap');
        splices = textChanges(raw, merged).map(s => ({ from: range.from + s.from, to: range.from + s.to, insert: s.insert }));
      }
      if (op.as && el.tagName !== op.as) {
        const loc = el.sourceCodeLocation!;
        const start = loc.startTag!;
        // Change only the tag names, so a line-height/style edit in this same
        // commit can coexist instead of overlapping a replacement opening tag.
        splices.push({ from: start.startOffset + 1, to: start.startOffset + 1 + el.tagName.length, insert: op.as });
        if (loc.endTag) splices.push({ from: loc.endTag.startOffset + 2, to: loc.endTag.startOffset + 2 + el.tagName.length, insert: op.as });
        else splices.push({ from: range.to, to: range.to, insert: `</${op.as}>` });
      }
      return splices;
    }
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
      if (op.order.every((i, k) => i === k) && !op.parts) return [];
      const from = kids[0].sourceCodeLocation!.startOffset, to = kids[kids.length - 1].sourceCodeLocation!.endOffset;
      // (`parts`: children that changed as well — their new source)
      const parts = kids.map((k, i) => op.parts?.[i] ?? text.slice(k.sourceCodeLocation!.startOffset, k.sourceCodeLocation!.endOffset));
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
      const html = op.html ?? text.slice(from, to);
      // the index counts the siblings without the element itself
      const siblings = elementChildren(parent).filter(k => k !== el && k.sourceCodeLocation);
      const before = siblings[op.index];
      const stays = (before === nextElementSibling(el) && parent === el.parentNode) || (!before && parent === el.parentNode && siblings[siblings.length - 1] === previousElementSibling(el) && !nextElementSibling(el));
      if (stays) return op.html === undefined ? [] : [{ from, to, insert: op.html }];
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
