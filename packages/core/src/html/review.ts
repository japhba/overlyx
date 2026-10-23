/**
 * Review of HTML deliverables (decks, posters, web pages): comment threads and suggested changes
 * (Suggesting — change tracking), kept in the page's own text as LyX keeps comments and tracked
 * changes in the document, so the canvas, the code view and agents all see the same:
 *
 *   data-ol-comments='[{"id":"c1","by":"Jan Bauer","at":"2026-10-11 14:03","text":"Shorter?","re":[{"by":"Kim","at":"…","text":"Done"}]}]'
 *       comment threads on an object (or a slide): "done": true when resolved, "quote": the words commented on
 *   data-ol-ins="Jan Bauer|2026-10-11 14:03"   an object (or a list item) added as a suggestion
 *   data-ol-del="…"                            one deleted as a suggestion: kept, hidden outside the editor
 *   data-ol-chg="…" data-ol-was='{"style":"left: 40px; top: 80px"}'
 *       an object changed: its attributes as they were (null: it had none); "@outer": the whole element as it
 *       was (a picture cropped, a path's points moved), "@i": its place among its siblings (sent to the back)
 *   <ins data-ol-by="…">words</ins>  <del data-ol-by="…">words</del>   words typed and deleted in a text
 *
 * Outside the editor the page shows with the suggestions accepted (the runtime hides what is deleted),
 * as LyX prints a document with its changes. The canvas's operations (source.ts HtmlOp) made while
 * suggesting become these marks here (reviewOps); accepting or rejecting rewrites the marked source
 * (resolveOps). Pure string work on the source, tested without a browser.
 */
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';
import { parseSource, elementAt, elementChildren, attr, hasClass, innerRange, outerRange, editStyle, parseStyle, pathOf, walk, isElement, opSplices, applySplices, type HElement, type HNode, type HDocument, type HtmlOp, type Path, type SourceDoc } from './source.ts';
import { slideElements } from './deliverable.ts';
import { formatTimestamp } from '../comments.ts';
import { diffTokens } from '../lyx/tokendiff.ts';

type HFragment = DefaultTreeAdapterMap['documentFragment'];

export const COMMENTS = 'data-ol-comments';
export const INS = 'data-ol-ins';
export const DEL = 'data-ol-del';
export const CHG = 'data-ol-chg';
export const WAS = 'data-ol-was';
/** the author of an <ins> / <del> in a text */
export const BY = 'data-ol-by';
/** the attributes of review: never changes themselves (written as they are, also while suggesting) */
export const REVIEW_ATTRS = [COMMENTS, INS, DEL, CHG, WAS];

/* ------------------------------------------------------------------ who and when */

export interface Stamp { by: string; at: string }

/** "Jan Bauer|2026-10-11 14:03": who made a suggestion, when (as comment headers have it) */
export function stampOf(by: string, d: Date = new Date()): string {
  return `${by.replace(/\|/g, '/').trim() || 'Someone'}|${formatTimestamp(d)}`;
}

export function parseStamp(v: string | null | undefined): Stamp | null {
  if (v === null || v === undefined) return null;
  const i = v.lastIndexOf('|');
  return i < 0 ? { by: v.trim(), at: '' } : { by: v.slice(0, i).trim(), at: v.slice(i + 1).trim() };
}

/** the later of two stamps' times ("YYYY-MM-DD HH:MM" sorts as text) */
const later = (a: string, b: string) => (a >= b ? a : b);

/* ------------------------------------------------------------------ comment threads */

export interface Reply { by: string; at: string; text: string }
export interface Thread {
  id: string; by: string; at: string; text: string;
  /** the words of the text it was made on (selected while typing) */
  quote?: string;
  done?: boolean;
  re?: Reply[];
}

const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

/** the threads of a data-ol-comments value (plain text an agent wrote is one thread) */
export function parseThreads(v: string | null | undefined): Thread[] {
  if (!v || !v.trim()) return [];
  let a: unknown;
  try { a = JSON.parse(v); } catch { return [{ id: 'c0', by: '', at: '', text: v.trim() }]; }
  if (!Array.isArray(a)) a = [a];
  return (a as unknown[]).filter(t => t && typeof t === 'object').map((t, i) => {
    const o = t as Record<string, unknown>;
    const re = Array.isArray(o.re) ? (o.re as unknown[]).filter(r => r && typeof r === 'object').map(r => { const x = r as Record<string, unknown>; return { by: str(x.by), at: str(x.at), text: str(x.text) }; }) : [];
    const th: Thread = { id: str(o.id) || `c${i}`, by: str(o.by), at: str(o.at), text: str(o.text) };
    if (o.quote) th.quote = str(o.quote);
    if (o.done) th.done = true;
    if (re.length) th.re = re;
    return th;
  });
}

/** apostrophes as JSON escapes: the value goes between single quotes, readable */
const APOS = '\\' + 'u0027';
function json(v: unknown): string { return JSON.stringify(v).replace(/'/g, APOS); }

/** a data-ol-comments value (null: no threads left, the attribute goes) */
export function threadsValue(ts: Thread[]): string | null {
  return ts.length ? json(ts) : null;
}

export function threadsOp(path: Path, threads: Thread[]): HtmlOp {
  return { t: 'attr', path, name: COMMENTS, value: threadsValue(threads), q: "'" };
}

export function newThreadId(): string {
  return 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
}

/* ------------------------------------------------------------------ what an object was */

export type Was = Record<string, string | number | null>;

export function parseWas(v: string | null | undefined): Was {
  if (!v) return {};
  try { const o = JSON.parse(v); return o && typeof o === 'object' && !Array.isArray(o) ? o as Was : {}; } catch { return {}; }
}

const wasValue = (w: Was): string => json(w);

/* ------------------------------------------------------------------ the tree */

const parentEl = (el: HElement): HElement | null => {
  const p = el.parentNode as HNode | null;
  return p && isElement(p) ? p : null;
};
function* upFrom(el: HElement): Generator<HElement> { for (let e: HElement | null = el; e; e = parentEl(e)) yield e; }

/** in the page's body (what is seen): changes to <head> are not suggestions */
export function inBody(el: HElement): boolean { for (const e of upFrom(el)) if (e.tagName === 'body') return true; return false; }
const pendingIns = (el: HElement) => { for (const e of upFrom(el)) if (attr(e, INS) !== null) return true; return false; };
const pendingDel = (el: HElement) => { for (const e of upFrom(el)) if (attr(e, DEL) !== null) return true; return false; };
const inNotes = (el: HElement) => { for (const e of upFrom(el)) if (e.tagName === 'aside' && hasClass(e, 'notes')) return true; return false; };
/** changed directly even while suggesting: the head, speaker notes, what is itself a suggested addition */
const untracked = (el: HElement) => !inBody(el) || inNotes(el) || pendingIns(el);

/** element children that are in the source (those the parser made up stand for their own children) */
function located(n: HElement | HFragment | HDocument): HElement[] {
  const out: HElement[] = [];
  for (const c of elementChildren(n as HElement)) {
    if (c.sourceCodeLocation) out.push(c);
    else out.push(...located(c));
  }
  return out;
}

/* ------------------------------------------------------------------ start tags */

interface AttrLoc { name: string; from: number; to: number }

/** the attributes of a start tag's source, where each one is */
function tagAttrs(tag: string): AttrLoc[] {
  const out: AttrLoc[] = [];
  const m = /^<[^\s/>]+/.exec(tag);
  let i = m ? m[0].length : 1;
  while (i < tag.length) {
    while (i < tag.length && /\s/.test(tag[i])) i++;
    if (i >= tag.length || tag[i] === '>' || (tag[i] === '/' && tag[i + 1] === '>')) break;
    if (tag[i] === '/') { i++; continue; }
    const from = i;
    while (i < tag.length && !/[\s=>]/.test(tag[i]) && !(tag[i] === '/' && tag[i + 1] === '>')) i++;
    const name = tag.slice(from, i).toLowerCase();
    let j = i;
    while (j < tag.length && /\s/.test(tag[j])) j++;
    if (tag[j] === '=') {
      j++;
      while (j < tag.length && /\s/.test(tag[j])) j++;
      if (tag[j] === '"' || tag[j] === "'") { const q = tag[j]; const e = tag.indexOf(q, j + 1); j = e < 0 ? tag.length : e + 1; }
      else while (j < tag.length && !/[\s>]/.test(tag[j])) j++;
      i = j;
    }
    out.push({ name, from, to: i });
  }
  return out;
}

const escAttr = (v: string) => v.replace(/&/g, '&amp;');
/** an attribute as written: single quotes around a value with double quotes in it (JSON) */
function attrText(name: string, value: string): string {
  return value.includes('"') && !value.includes("'") ? ` ${name}='${escAttr(value)}'` : ` ${name}="${escAttr(value).replace(/"/g, '&quot;')}"`;
}

/** a start tag with attributes set (null: removed) */
export function setTagAttrs(tag: string, set: Record<string, string | null>): string {
  let out = tag;
  for (const [name, value] of Object.entries(set)) {
    const at = tagAttrs(out).find(a => a.name === name.toLowerCase());
    if (at) {
      let from = at.from;
      while (from > 0 && /\s/.test(out[from - 1])) from--;
      out = out.slice(0, from) + (value === null ? '' : attrText(name, value)) + out.slice(at.to);
    } else if (value !== null) {
      let end = out.endsWith('/>') ? out.length - 2 : out.length - 1;
      while (end > 0 && /\s/.test(out[end - 1])) end--;
      out = out.slice(0, end) + attrText(name, value) + out.slice(end);
    }
  }
  return out;
}

/** the value of an attribute in a start tag's source */
function tagAttr(tag: string, name: string): string | null {
  const at = tagAttrs(tag).find(a => a.name === name);
  if (!at) return null;
  const src = tag.slice(at.from, at.to);
  const eq = src.indexOf('=');
  if (eq < 0) return '';
  let v = src.slice(eq + 1).trim();
  if (v[0] === '"' || v[0] === "'") v = v.slice(1, -1);
  return unescape(v);
}

function unescape(s: string): string {
  return s.replace(/&(amp|quot|#39|apos|lt|gt|#(\d+)|#x([\da-f]+));/gi, (m, n: string, d?: string, h?: string) =>
    d ? String.fromCodePoint(Number(d)) : h ? String.fromCodePoint(parseInt(h, 16)) : ({ amp: '&', quot: '"', '#39': "'", apos: "'", lt: '<', gt: '>' } as Record<string, string>)[n.toLowerCase()] ?? m);
}

/** the top-level elements of a fragment with attributes set on each */
export function setTopAttrs(html: string, set: Record<string, string | null>, only?: (tag: string) => boolean): string {
  const frag = parseFragment(html, { sourceCodeLocationInfo: true });
  const tops = located(frag).reverse();
  let out = html;
  for (const el of tops) {
    const st = el.sourceCodeLocation!.startTag;
    if (!st) continue;
    const tag = out.slice(st.startOffset, st.endOffset);
    if (only && !only(tag)) continue;
    out = out.slice(0, st.startOffset) + setTagAttrs(tag, set) + out.slice(st.endOffset);
  }
  return out;
}

/** the start tag of a fragment's first element */
function firstStartTag(html: string): string | null {
  const st = located(parseFragment(html, { sourceCodeLocationInfo: true }))[0]?.sourceCodeLocation?.startTag;
  return st ? html.slice(st.startOffset, st.endOffset) : null;
}

/** the elements at the top of a fragment, and whether it has text of its own besides */
function topsOf(html: string): { n: number; text: boolean } {
  const frag = parseFragment(html, { sourceCodeLocationInfo: true });
  let text = false;
  for (const c of frag.childNodes as HNode[]) if ('value' in c && c.nodeName === '#text' && /\S/.test((c as { value: string }).value)) text = true;
  return { n: located(frag).length, text };
}

/* ------------------------------------------------------------------ rewriting the source */

/** what becomes of an element: gone, its content only, attributes set, replaced, put at another place among its siblings */
interface Decision { drop?: boolean; unwrap?: boolean; attrs?: Record<string, string | null>; replace?: string; at?: number }
type Decide = (el: HElement) => Decision | null;

function cached(f: Decide): Decide {
  const m = new Map<HElement, Decision | null>();
  return el => { if (!m.has(el)) m.set(el, f(el)); return m.get(el)!; };
}

function rewriteEl(text: string, el: HElement, decide: Decide): string {
  const loc = el.sourceCodeLocation!;
  const d = decide(el);
  if (d?.drop) return '';
  if (d?.replace !== undefined) return d.replace;
  const st = loc.startTag;
  if (!st) return text.slice(loc.startOffset, loc.endOffset);
  let start = text.slice(st.startOffset, st.endOffset);
  if (d?.attrs) start = setTagAttrs(start, d.attrs);
  const r = innerRange(el);
  const inner = r ? rewriteRange(text, r.from, r.to, located(el), decide) : '';
  const end = r ? text.slice(r.to, loc.endOffset) : '';
  return d?.unwrap ? inner : start + inner + end;
}

/** text[from, to) with the elements in it (`kids`, located, in order) rewritten; the text between them stays */
function rewriteRange(text: string, from: number, to: number, kids: HElement[], decide: Decide): string {
  if (!kids.length) return text.slice(from, to);
  const gaps: string[] = [];
  let pos = from;
  for (const k of kids) { gaps.push(text.slice(pos, k.sourceCodeLocation!.startOffset)); pos = k.sourceCodeLocation!.endOffset; }
  gaps.push(text.slice(pos, to));
  let parts = kids.map((k, i) => ({ i, s: rewriteEl(text, k, decide), at: decide(k)?.at, drop: !!decide(k)?.drop }));
  // a dropped element that had a line of its own takes the line with it
  for (let k = parts.length - 1; k >= 0; k--) {
    if (!parts[k].drop) continue;
    const before = gaps[k], after = gaps[k + 1];
    if (/^\s*$/.test(before) && before.includes('\n') && /^[ \t]*(\n|$)/.test(after)) gaps[k] = '';
    // the gaps either side become one
    gaps.splice(k, 2, gaps[k] + after);
    parts.splice(k, 1);
  }
  // elements put back at their old place among their siblings (gaps stay where they are, as in a reorder)
  const moved = parts.filter(p => p.at !== undefined).sort((a, b) => a.at! - b.at!);
  if (moved.length) {
    parts = parts.filter(p => p.at === undefined);
    for (const p of moved) parts.splice(Math.max(0, Math.min(p.at!, parts.length)), 0, p);
  }
  let out = gaps[0];
  parts.forEach((p, k) => { out += p.s + gaps[k + 1]; });
  return out;
}

/** a fragment rewritten (its top-level elements and everything inside) */
function rewriteFragment(html: string, decide: Decide): string {
  const frag = parseFragment(html, { sourceCodeLocationInfo: true });
  return rewriteRange(html, 0, html.length, located(frag), cached(decide));
}

/* ------------------------------------------------------------------ accepting and rejecting */

export interface ResolveOptions {
  /** only the suggestions of this person */
  by?: string;
  /** comment threads removed as well (the page as published) */
  stripComments?: boolean;
}

function decider(accept: boolean, opts: ResolveOptions): Decide {
  const mine = (v: string | null) => v !== null && (!opts.by || parseStamp(v)?.by === opts.by);
  return el => {
    const tag = el.tagName;
    if ((tag === 'ins' || tag === 'del') && mine(attr(el, BY))) return (tag === 'ins') === accept ? { unwrap: true } : { drop: true };
    const attrs: Record<string, string | null> = {};
    const d: Decision = {};
    if (mine(attr(el, INS))) { if (!accept) return { drop: true }; attrs[INS] = null; }
    if (mine(attr(el, DEL))) { if (accept) return { drop: true }; attrs[DEL] = null; }
    if (mine(attr(el, CHG))) {
      attrs[CHG] = null;
      attrs[WAS] = null;
      if (!accept) {
        const was = parseWas(attr(el, WAS));
        for (const [k, v] of Object.entries(was)) if (!k.startsWith('@')) attrs[k] = v === null ? null : String(v);
        if (typeof was['@outer'] === 'string') {
          // the element as it was — with the comments made on it since
          const c = attr(el, COMMENTS);
          d.replace = c ? setTopAttrs(was['@outer'], { [COMMENTS]: c }) : was['@outer'];
        }
        if (typeof was['@i'] === 'number') d.at = was['@i'];
      }
    }
    if (opts.stripComments && attr(el, COMMENTS) !== null) attrs[COMMENTS] = null;
    if (Object.keys(attrs).length) d.attrs = attrs;
    return d.attrs || d.replace !== undefined || d.at !== undefined ? d : null;
  };
}

/**
 * The suggestions on and in the element at `path` accepted or rejected (`by`: only that person's):
 * one operation on the current text — none when there is nothing to do.
 */
export function resolveOps(text: string, path: Path, accept: boolean, opts: ResolveOptions = {}): HtmlOp[] {
  const { doc } = parseSource(text);
  const el = elementAt(doc, path);
  if (!el?.sourceCodeLocation) return [];
  const decide = cached(decider(accept, opts));
  const d = decide(el);
  if (d?.drop) return [{ t: 'remove', paths: [path] }];
  const { from, to } = outerRange(el);
  const html = rewriteEl(text, el, decide);
  const parent = parentEl(el);
  if (d?.at !== undefined && parent) {
    const n = located(parent).length;
    return [{ t: 'move', path, parent: pathOf(parent), index: Math.max(0, Math.min(d.at, n - 1)), html }];
  }
  return html === text.slice(from, to) ? [] : [{ t: 'outer', path, html }];
}

/** every suggestion of the page (in its body) accepted or rejected: the new text */
export function resolveAll(text: string, accept: boolean, opts: ResolveOptions = {}): string {
  const { doc } = parseSource(text);
  const body = [...walk(doc)].find(e => e.tagName === 'body' && e.sourceCodeLocation);
  if (!body) return text;
  const r = innerRange(body);
  if (!r) return text;
  const inner = rewriteRange(text, r.from, r.to, located(body), cached(decider(accept, opts)));
  return text.slice(0, r.from) + inner + text.slice(r.to);
}

/** the page as it is published (downloaded as a web page): suggestions accepted, comments gone */
export function publishedText(text: string): string {
  if (!/data-ol-(comments|ins|del|chg|by)\b/.test(text)) return text;
  return resolveAll(text, true, { stripComments: true });
}

/** a fragment copied (duplicated, pasted): as it reads with its suggestions accepted, without the comments */
export function cleanFragment(html: string): string {
  if (!/data-ol-(comments|ins|del|chg|was|by)\b/.test(html)) return html;
  return rewriteFragment(html, decider(true, { stripComments: true }));
}

/* ------------------------------------------------------------------ words typed and deleted */

type Tok =
  | { k: 'tag'; s: string }
  /** a word, a space, a formula, a picture… `ins`: the stamp of the suggestion that typed it */
  | { k: 'text'; s: string; ins?: string }
  /** a deletion already there (its source as it is) */
  | { k: 'del'; s: string; by: string };

/** formulas, environments and commands (\cite{…}) are one token: marks never go inside them */
const ATOM = /\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|\$\$[\s\S]*?\$\$|\\begin\{([A-Za-z]+\*?)\}[\s\S]*?\\end\{\1\}|\\[A-Za-z]+\*?(?:\[[^\]]*\])*(?:\{[^{}]*\})*|[^\s\\$]+|\s+|[\\$]/g;
/** elements that are one token, their inside never split (a picture, a drawing) */
const OPAQUE = new Set(['svg', 'math', 'video', 'audio', 'canvas', 'iframe', 'object', 'picture', 'select', 'button', 'textarea', 'script', 'style', 'template']);

/** where a tag starting at `at` ends (after its ">"), -1 when the "<" is text */
function tagEnd(s: string, at: number): number {
  if (s.startsWith('<!--', at)) { const e = s.indexOf('-->', at + 4); return e < 0 ? -1 : e + 3; }
  if (!/[A-Za-z/!?]/.test(s[at + 1] ?? '')) return -1;
  let q = '';
  for (let j = at + 1; j < s.length; j++) {
    const c = s[j];
    if (q) { if (c === q) q = ''; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === '>') return j + 1;
  }
  return -1;
}

/** where the element opened by the tag ending at `from` closes: [start of its end tag, end of it] */
function closeOf(s: string, from: number, name: string): [number, number] {
  let depth = 1;
  const re = new RegExp(`<(/?)${name}(?=[\\s/>])`, 'gi');
  re.lastIndex = from;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const e = tagEnd(s, m.index);
    if (e < 0) continue;
    if (m[1]) { if (--depth === 0) return [m.index, e]; }
    else if (!s.slice(m.index, e).endsWith('/>')) depth++;
    re.lastIndex = e;
  }
  return [s.length, s.length];
}

function tokens(html: string): Tok[] {
  const out: Tok[] = [];
  /** the <ins> elements open around: tracked ones carry their stamp */
  const insStack: (string | null)[] = [];
  const cur = () => { for (let k = insStack.length - 1; k >= 0; k--) if (insStack[k] !== null) return insStack[k]!; return undefined; };
  const text = (s: string) => { for (const m of s.matchAll(ATOM)) out.push({ k: 'text', s: m[0], ins: cur() }); };
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { text(html.slice(i)); break; }
    if (lt > i) text(html.slice(i, lt));
    const end = tagEnd(html, lt);
    if (end < 0) { out.push({ k: 'text', s: '<', ins: cur() }); i = lt + 1; continue; }
    const tag = html.slice(lt, end);
    const m = /^<(\/?)([A-Za-z][\w:-]*)/.exec(tag);
    const name = m?.[2].toLowerCase() ?? '';
    const closing = !!m?.[1];
    if (name === 'del' && !closing && tagAttr(tag, BY) !== null) {
      const [cs, ce] = closeOf(html, end, 'del');
      out.push({ k: 'del', s: html.slice(end, cs), by: tagAttr(tag, BY)! });
      i = ce;
      continue;
    }
    if (name === 'ins' && !closing) { insStack.push(tagAttr(tag, BY)); if (insStack[insStack.length - 1] !== null) { i = end; continue; } }
    if (name === 'ins' && closing && insStack.length) { if (insStack.pop() !== null) { i = end; continue; } }
    if (m && !closing && OPAQUE.has(name) && !tag.endsWith('/>')) {
      const [, ce] = closeOf(html, end, name);
      out.push({ k: 'text', s: html.slice(lt, ce), ins: cur() });
      i = ce;
      continue;
    }
    if (m && !closing && name === 'img') { out.push({ k: 'text', s: tag, ins: cur() }); i = end; continue; }
    out.push({ k: 'tag', s: tag });
    i = end;
  }
  return out;
}

/** the steps of a diff of two token lists (common ends trimmed; a huge middle replaced whole) */
function diffSteps(a: string[], b: string[]): ('same' | 'del' | 'add')[] {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const am = a.slice(p, a.length - s), bm = b.slice(p, b.length - s);
  let mid: ('same' | 'del' | 'add')[];
  if (am.length * bm.length > 4_000_000) mid = [...am.map(() => 'del' as const), ...bm.map(() => 'add' as const)];
  else mid = diffTokens(am, bm).map(d => d.type === 'same' ? 'same' : d.type === 'del' ? 'del' : 'add');
  return [...Array(p).fill('same'), ...mid, ...Array(s).fill('same')];
}

type Out = { k: 'tag'; s: string } | { k: 'text'; s: string; mark: 'ins' | 'del' | null; by?: string } | { k: 'old'; s: string; by: string };

/** a run of inline content (text and inline elements) retyped: what was typed and deleted marked */
function trackInline(oldHtml: string, newHtml: string, st: string): string {
  const old = tokens(oldHtml);
  const neu = tokens(newHtml).filter(t => t.k !== 'del');
  const vis: Exclude<Tok, { k: 'del' }>[] = [];
  const dels = new Map<number, Extract<Tok, { k: 'del' }>[]>();
  for (const t of old) {
    if (t.k === 'del') { const a = vis.length - 1; dels.set(a, [...(dels.get(a) ?? []), t]); }
    else vis.push(t);
  }
  // (white space is white space: how much of it the browser left is no change)
  const key = (t: Tok) => (t.k === 'text' && !/\S/.test(t.s) ? 'text: ' : t.k + ':' + t.s);
  const steps = diffSteps(vis.map(key), neu.map(key));
  if (steps.every(x => x === 'same')) return oldHtml;
  const out: Out[] = [];
  const oldDels = (anchor: number) => { for (const d of dels.get(anchor) ?? []) out.push({ k: 'old', s: d.s, by: d.by }); };
  oldDels(-1);
  let i = 0, j = 0;
  for (const step of steps) {
    if (step === 'same') {
      const t = vis[i];
      out.push(t.k === 'tag' ? t : { k: 'text', s: t.s, mark: t.ins ? 'ins' : null, by: t.ins });
      oldDels(i); i++; j++;
    } else if (step === 'del') {
      const t = vis[i];
      // (words someone suggested adding go again; tags removed go — the new text has its own)
      if (t.k === 'text' && !t.ins) out.push({ k: 'text', s: t.s, mark: 'del', by: st });
      oldDels(i); i++;
    } else {
      const t = neu[j];
      out.push(t.k === 'tag' ? t : { k: 'text', s: t.s, mark: 'ins', by: st });
      j++;
    }
  }
  // a space between two deletions of one person goes with them ("an old phrase" deleted reads as one)
  const delBy = (x: Out | undefined) => (x?.k === 'old' ? x.by : x?.k === 'text' && x.mark === 'del' ? x.by! : null);
  for (let k = 1; k < out.length - 1; k++) {
    const o = out[k];
    if (o.k !== 'text' || o.mark !== null || /\S/.test(o.s)) continue;
    const a = delBy(out[k - 1]), b = delBy(out[k + 1]);
    if (a && b && parseStamp(a)!.by === parseStamp(b)!.by) out[k] = { k: 'text', s: o.s, mark: 'del', by: b };
  }
  return serialize(out);
}

function serialize(out: Out[]): string {
  let html = '';
  let k = 0;
  const kindOf = (o: Out) => (o.k === 'tag' ? 'tag' : o.k === 'old' ? 'del' : o.mark ?? 'plain');
  while (k < out.length) {
    const o = out[k];
    const kind = kindOf(o);
    if (kind === 'tag' || kind === 'plain') { html += o.s; k++; continue; }
    // a run of one kind by one person (the latest time of it)
    const by = parseStamp((o as { by: string }).by)!.by;
    let at = parseStamp((o as { by: string }).by)!.at;
    let s = '';
    let e = k;
    while (e < out.length && kindOf(out[e]) === kind && parseStamp((out[e] as { by: string }).by)!.by === by) {
      at = later(at, parseStamp((out[e] as { by: string }).by)!.at);
      s += out[e].s;
      e++;
    }
    const prev = out[k - 1], next = out[e];
    if (!/\S/.test(s) && kind === 'ins') html += s;
    // spaces deleted at a tag (the layout of the source) are not worth a mark
    else if (!/\S/.test(s) && kind === 'del' && !(prev && prev.k !== 'tag' && next && next.k !== 'tag')) { /* dropped */ }
    else html += `<${kind}${attrText(BY, `${by}|${at}`)}>${s}</${kind}>`;
    k = e;
  }
  return html;
}

/** block elements: a list item or a paragraph added or deleted is marked as a whole */
const BLOCKS = new Set(['address', 'article', 'aside', 'blockquote', 'dd', 'details', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'summary', 'ul']);

interface Item { block: boolean; raw: string; tag?: string; start?: string; inner?: string; end?: string; ins?: boolean; del?: boolean }

/** a fragment's top level: runs of inline content and block elements */
function items(html: string): Item[] {
  const frag = parseFragment(html, { sourceCodeLocationInfo: true });
  const out: Item[] = [];
  let from = -1, to = -1;
  const flush = () => { if (from >= 0) out.push({ block: false, raw: html.slice(from, to) }); from = -1; };
  for (const n of frag.childNodes as HNode[]) {
    const loc = (n as HElement).sourceCodeLocation;
    if (!loc) continue;
    if (isElement(n) && BLOCKS.has(n.tagName) && loc.startTag) {
      flush();
      const st = loc.startTag, et = loc.endTag;
      const start = html.slice(st.startOffset, st.endOffset);
      out.push({
        block: true, raw: html.slice(loc.startOffset, loc.endOffset), tag: n.tagName, start,
        inner: html.slice(st.endOffset, et ? et.startOffset : loc.endOffset), end: et ? html.slice(et.startOffset, et.endOffset) : '',
        ins: attr(n, INS) !== null, del: attr(n, DEL) !== null,
      });
    } else {
      if (from < 0) from = loc.startOffset;
      to = loc.endOffset;
    }
  }
  flush();
  return out;
}

/**
 * A text retyped while suggesting: its old source (with the suggestions already in it) and the new
 * one as typed → the new source with what was typed in <ins>, what was deleted in <del> (words), and
 * paragraphs and list items added or deleted marked as a whole. Earlier suggestions keep their
 * author; deleting words someone suggested adding takes them out; deletions stay.
 */
export function trackInner(oldHtml: string, newHtml: string, st: string): string {
  if (oldHtml === newHtml) return oldHtml;
  const A = items(oldHtml);
  const B = items(newHtml).filter(it => !(it.block && it.del));
  const vis: Item[] = [];
  const dels = new Map<number, string[]>();
  for (const it of A) {
    if (it.block && it.del) { const a = vis.length - 1; dels.set(a, [...(dels.get(a) ?? []), it.raw]); }
    else vis.push(it);
  }
  if (!vis.some(it => it.block) && !B.some(it => it.block) && !dels.size) return trackInline(oldHtml, newHtml, st);
  // the same blocks (and runs) by a longest common subsequence; between them, pairs of one kind in order
  const steps = diffSteps(vis.map(it => (it.block ? 'b:' : 'i:') + it.raw), B.map(it => (it.block ? 'b:' : 'i:') + it.raw));
  let out = '';
  const oldDels = (anchor: number) => { for (const d of dels.get(anchor) ?? []) out += d; };
  oldDels(-1);
  let i = 0, j = 0, k = 0;
  while (k < steps.length) {
    if (steps[k] === 'same') { out += vis[i].raw; oldDels(i); i++; j++; k++; continue; }
    // a changed stretch: its old and new items
    const olds: number[] = [], news: number[] = [];
    while (k < steps.length && steps[k] !== 'same') { if (steps[k] === 'del') olds.push(i++); else news.push(j++); k++; }
    let o = 0;
    for (const n of news) {
      const b = B[n];
      // the old ones before a partner of the new one's kind: deleted
      let p = o;
      while (p < olds.length && !samekind(vis[olds[p]], b)) p++;
      if (p < olds.length) {
        for (; o < p; o++) { out += deleted(vis[olds[o]], st); oldDels(olds[o]); }
        out += changed(vis[olds[o]], b, st);
        oldDels(olds[o]);
        o++;
      } else out += added(b, st);
    }
    for (; o < olds.length; o++) { out += deleted(vis[olds[o]], st); oldDels(olds[o]); }
  }
  return out;
}

const samekind = (a: Item, b: Item) => a.block === b.block && a.tag === b.tag;

function changed(a: Item, b: Item, st: string): string {
  if (!a.block) return trackInline(a.raw, b.raw, st);
  // added as a suggestion: what is in it is the suggestion's (no marks inside)
  if (a.ins) return b.raw;
  return b.start! + trackInner(a.inner!, b.inner!, st) + b.end!;
}

function deleted(a: Item, st: string): string {
  if (!a.block) return trackInline(a.raw, '', st);
  if (a.ins) return '';
  return setTagAttrs(a.start!, { [DEL]: st }) + a.inner! + a.end!;
}

function added(b: Item, st: string): string {
  if (!b.block) return /\S/.test(b.raw) ? trackInline('', b.raw, st) : b.raw;
  // (a list item split from one added as a suggestion has its marks: the new one is this suggestion's)
  return setTagAttrs(b.start!, { [INS]: st, [DEL]: null, [CHG]: null, [WAS]: null }) + cleanFragment(b.inner!) + b.end!;
}

/* ------------------------------------------------------------------ the canvas's operations while suggesting */

/** a value of an attribute an object had before this change (null: it had none) */
interface Changed { el: HElement; was: Was; now: Record<string, string | null> }

/**
 * The canvas's operations (on `src`) as the review needs them. Always: what is copied (duplicated,
 * pasted, drawn) carries no comments or marks, and an element replaced (cropped, its points edited)
 * keeps its comments and marks. While suggesting (`st`: who and when): an addition is marked, a
 * deletion marks instead of removing, a change records what the object was (data-ol-was), retyped
 * text gets <ins>/<del> — except in the head, in speaker notes and in what is itself a suggested
 * addition, which change directly.
 */
export function reviewOps(src: SourceDoc, ops: HtmlOp[], st: string | null): HtmlOp[] {
  const { text, doc } = src;
  const at = (p: Path) => elementAt(doc, p);
  const out: HtmlOp[] = [];
  const changes = new Map<HElement, Changed>();
  const note = (el: HElement, name: string, before: string | null, after: string | null) => {
    let c = changes.get(el);
    if (!c) { c = { el, was: {}, now: {} }; changes.set(el, c); }
    if (!(name in c.was)) c.was[name] = before;
    c.now[name] = after;
  };
  const outerSrc = (el: HElement) => { const r = outerRange(el); return text.slice(r.from, r.to); };
  /** the element as it was before any suggestion changed it */
  const original = (el: HElement): string => {
    const was = parseWas(attr(el, WAS));
    if (typeof was['@outer'] === 'string') return was['@outer'];
    const restore: Record<string, string | null> = { [CHG]: null, [WAS]: null, [COMMENTS]: null, [INS]: null, [DEL]: null };
    for (const [k, v] of Object.entries(was)) if (!k.startsWith('@')) restore[k] = v === null ? null : String(v);
    const s = outerSrc(el);
    const stEnd = el.sourceCodeLocation!.startTag!.endOffset - el.sourceCodeLocation!.startOffset;
    return setTagAttrs(s.slice(0, stEnd), restore) + s.slice(stEnd);
  };
  const delOp = (p: Path): HtmlOp => ({ t: 'attr', path: p, name: DEL, value: st });

  for (const op of ops) {
    switch (op.t) {
      case 'style': case 'attr': {
        const el = at(op.path);
        if (!st || !el || untracked(el) || (op.t === 'attr' && REVIEW_ATTRS.includes(op.name.toLowerCase()))) { out.push(op); break; }
        if (pendingDel(el)) break;
        out.push(op);
        if (op.t === 'style') { const before = attr(el, 'style'); note(el, 'style', before, editStyle(before ?? '', op.set) || null); }
        else note(el, op.name.toLowerCase(), attr(el, op.name), op.value);
        break;
      }
      case 'inner': {
        const el = at(op.path);
        if (!st || !el || untracked(el)) { out.push(op); break; }
        if (pendingDel(el)) break;
        const r = innerRange(el);
        if (!r) { out.push(op); break; }
        const current = text.slice(r.from, r.to);
        // Merge a local typing delta before tracking it: remote words aren't this author's deletions.
        const target = op.before === undefined ? op.html : (() => {
          const edited = applySplices(text, opSplices(src, op));
          const next = elementAt(parseSource(edited).doc, op.path);
          const range = next && innerRange(next);
          if (!range) throw new Error('The edited text is no longer there');
          return edited.slice(range.from, range.to);
        })();
        out.push({ ...op, html: trackInner(current, target, st), ...(op.before === undefined ? {} : { before: current }) });
        break;
      }
      case 'outer': {
        const el = at(op.path);
        if (!el?.sourceCodeLocation) { out.push(op); break; }
        const tops = topsOf(op.html);
        // (what the new element does not say itself)
        const top = firstStartTag(op.html);
        const keep: Record<string, string | null> = {};
        for (const a of REVIEW_ATTRS) { const v = attr(el, a); if (v !== null && top !== null && tagAttr(top, a) === null) keep[a] = v; }
        if (!st || untracked(el)) {
          // one element for one (a crop, a path edited): its comments and marks stay on it
          out.push(tops.n === 1 && !tops.text && Object.keys(keep).length ? { ...op, html: setTopAttrs(op.html, keep) } : op);
          break;
        }
        if (pendingDel(el)) break;
        const parent = parentEl(el);
        if (tops.n === 1 && !tops.text) {
          const was: Was = { '@outer': original(el) };
          const old = parseWas(attr(el, WAS));
          if (typeof old['@i'] === 'number') was['@i'] = old['@i'];
          out.push({ ...op, html: setTopAttrs(op.html, { ...keep, [CHG]: st, [WAS]: wasValue(was), [INS]: null, [DEL]: null }) });
        } else {
          // several for one (ungrouped, broken apart) or none: the old one deleted, the new ones added after it
          out.push(delOp(op.path));
          if (tops.n && parent) {
            const idx = located(parent).indexOf(el);
            out.push({ t: 'insert', parent: pathOf(parent), index: idx + 1, html: setTopAttrs(cleanFragment(op.html), { [INS]: st }) });
          }
        }
        break;
      }
      case 'remove': {
        if (!st) { out.push(op); break; }
        const els = op.paths.map(at);
        const real: Path[] = [];
        op.paths.forEach((p, k) => {
          const el = els[k];
          if (!el) { real.push(p); return; }
          // inside another one removed here: goes with it
          if (els.some(o => o && o !== el && [...upFrom(el)].includes(o))) { if (untracked(el)) real.push(p); return; }
          if (untracked(el)) real.push(p);
          else if (!pendingDel(el)) out.push(delOp(p));
        });
        if (real.length) out.push({ t: 'remove', paths: real });
        break;
      }
      case 'insert': {
        const parent = at(op.parent);
        const html = cleanFragment(op.html);
        if (!st || !parent || untracked(parent)) { out.push(html === op.html ? op : { ...op, html }); break; }
        if (pendingDel(parent)) break;
        out.push({ ...op, html: setTopAttrs(html, { [INS]: st }) });
        break;
      }
      case 'duplicate': {
        const els = op.paths.map(at);
        const marked = els.some(el => el?.sourceCodeLocation && /data-ol-(comments|ins|del|chg|was|by)\b/.test(outerSrc(el)));
        if (!st && !marked) { out.push(op); break; }
        for (const el of els) {
          if (!el?.sourceCodeLocation || els.some(o => o && o !== el && [...upFrom(el)].includes(o))) continue;
          const parent = parentEl(el);
          if (!parent) continue;
          let html = cleanFragment(outerSrc(el));
          if (st && !untracked(parent)) html = setTopAttrs(html, { [INS]: st });
          out.push({ t: 'insert', parent: pathOf(parent), index: located(parent).indexOf(el) + 1, html });
        }
        break;
      }
      case 'move': {
        const el = at(op.path);
        if (!st || !el?.sourceCodeLocation || untracked(el) || parentEl(el) !== at(op.parent)) { out.push(op); break; }
        if (pendingDel(el)) break;
        const was = parseWas(attr(el, WAS));
        if (typeof was['@i'] !== 'number') was['@i'] = located(parentEl(el)!).indexOf(el);
        // back where it was: nothing to suggest any more
        const s = outerSrc(el);
        const stEnd = el.sourceCodeLocation.startTag!.endOffset - el.sourceCodeLocation.startOffset;
        const set = was['@i'] === op.index && Object.keys(was).length === 1 ? { [CHG]: null, [WAS]: null }
          : was['@i'] === op.index ? (() => { delete was['@i']; return { [WAS]: wasValue(was) }; })()
          : { [CHG]: st, [WAS]: wasValue(was) };
        out.push({ ...op, html: setTagAttrs(s.slice(0, stEnd), set) + s.slice(stEnd) });
        break;
      }
      case 'reorder': {
        const parent = at(op.parent);
        if (!st || !parent || untracked(parent)) { out.push(op); break; }
        const kids = located(parent);
        // the children that moved: those outside the longest run kept in order
        const keep = longestIncreasing(op.order);
        const parts: Record<number, string> = {};
        op.order.forEach((oldIdx, k) => {
          const el = kids[oldIdx];
          if (!el || keep.has(k) || attr(el, INS) !== null) return;
          const was = parseWas(attr(el, WAS));
          if (typeof was['@i'] !== 'number') was['@i'] = oldIdx;
          const s = outerSrc(el);
          const stEnd = el.sourceCodeLocation!.startTag!.endOffset - el.sourceCodeLocation!.startOffset;
          parts[oldIdx] = setTagAttrs(s.slice(0, stEnd), { [CHG]: st, [WAS]: wasValue(was) }) + s.slice(stEnd);
        });
        out.push(Object.keys(parts).length ? { ...op, parts } : op);
        break;
      }
    }
  }
  // what each changed object was: its old values kept (the first change's), those back as they were dropped
  for (const c of changes.values()) {
    const old = parseWas(attr(c.el, WAS));
    const was: Was = { ...c.was, ...old };
    for (const k of Object.keys(was)) {
      if (k.startsWith('@')) continue;
      const now = k in c.now ? c.now[k] : attr(c.el, k);
      if (sameValue(k, was[k] === null ? null : String(was[k]), now)) delete was[k];
    }
    const p = pathOf(c.el);
    if (!Object.keys(was).length) {
      if (attr(c.el, CHG) !== null) out.push({ t: 'attr', path: p, name: CHG, value: null });
      if (attr(c.el, WAS) !== null) out.push({ t: 'attr', path: p, name: WAS, value: null });
      continue;
    }
    out.push({ t: 'attr', path: p, name: WAS, value: wasValue(was), q: "'" });
    out.push({ t: 'attr', path: p, name: CHG, value: st });
  }
  return out;
}

/** the same value of an attribute (styles compared by their declarations) */
function sameValue(name: string, a: string | null, b: string | null): boolean {
  if (name !== 'style') return (a ?? null) === (b ?? null);
  const norm = (s: string | null) => parseStyle(s ?? '').map(d => `${d.prop.toLowerCase()}:${d.value.replace(/\s+/g, ' ')}`).sort().join(';');
  return norm(a) === norm(b);
}

/** the positions (in `order`) of a longest increasing run of it */
function longestIncreasing(order: number[]): Set<number> {
  const n = order.length;
  const len = new Array(n).fill(1), prev = new Array(n).fill(-1);
  for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) if (order[j] < order[i] && len[j] + 1 > len[i]) { len[i] = len[j] + 1; prev[i] = j; }
  let best = 0;
  for (let i = 1; i < n; i++) if (len[i] > len[best]) best = i;
  const out = new Set<number>();
  for (let i = n ? best : -1; i >= 0; i = prev[i]) out.add(i);
  return out;
}

/* ------------------------------------------------------------------ Suggesting, a setting of the page */

const SUGGEST_RE = /<meta\s[^>]*name\s*=\s*["']?overlyx-suggesting["']?[^>]*>/i;

/** Suggesting is on for this page: <meta name="overlyx-suggesting" content="on"> (for everyone editing it, as in documents) */
export function isSuggesting(text: string): boolean {
  // (asked of the same text a few times an edit: the whole of it searched once)
  if (suggestingOf?.text === text) return suggestingOf.on;
  // (in the head: what comes after it not searched — half a MB on a deck with much ink)
  const body = text.search(/<body[\s>]/i);
  const m = SUGGEST_RE.exec(body > 0 ? text.slice(0, body) : text);
  const on = !!m && !/content\s*=\s*["']?(off|false|no)\b/i.test(m[0]);
  suggestingOf = { text, on };
  return on;
}
let suggestingOf: { text: string; on: boolean } | null = null;

/** the operation that turns Suggesting on or off (null: it already is) */
export function suggestingOp(text: string, on: boolean): HtmlOp | null {
  if (isSuggesting(text) === on) return null;
  const { doc } = parseSource(text);
  const meta = [...walk(doc)].find(e => e.tagName === 'meta' && (attr(e, 'name') ?? '').toLowerCase() === 'overlyx-suggesting');
  if (meta) return on ? { t: 'attr', path: pathOf(meta), name: 'content', value: 'on' } : { t: 'remove', paths: [pathOf(meta)] };
  if (!on) return null;
  const head = [...walk(doc)].find(e => e.tagName === 'head');
  if (!head) return null;
  return { t: 'insert', parent: pathOf(head), index: elementChildren(head).length, html: '<meta name="overlyx-suggesting" content="on">' };
}

/* ------------------------------------------------------------------ what there is to review */

export type ChangeKind = 'added' | 'deleted' | 'changed' | 'text';

export interface ReviewChange {
  /** the object (a child of its slide; on a web page the block): where accepting and rejecting apply */
  path: Path;
  /** its slide (-1: a web page) */
  slide: number;
  by: string;
  at: string;
  kinds: ChangeKind[];
  /** the object in a few words */
  what: string;
  /** what was done, in a few words ("Moved, resized", "Typed “…” · Deleted “…”") */
  summary: string;
}

export interface ReviewThread { path: Path; slide: number; what: string; thread: Thread }

export interface Review { changes: ReviewChange[]; threads: ReviewThread[] }

const words = (s: string, n = 48) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

function plainText(el: HElement): string {
  let s = '';
  for (const n of el.childNodes as HNode[]) {
    if ('value' in n && n.nodeName === '#text') s += (n as { value: string }).value;
    else if (isElement(n) && !(n.tagName === 'del' && attr(n, BY) !== null) && n.tagName !== 'script' && n.tagName !== 'style' && !(n.tagName === 'aside' && hasClass(n, 'notes'))) s += plainText(n);
  }
  return s;
}

/** an object in a few words: "Slide 3", "Picture", "Drawing", "“The results”" */
export function describe(el: HElement, slides: HElement[]): string {
  const si = slides.indexOf(el);
  if (si >= 0) return `Slide ${si + 1}`;
  if (el.tagName === 'img' || hasClass(el, 'ol-crop')) return 'Picture';
  const t = words(plainText(el), 40);
  if (t) return `“${t}”`;
  if (el.tagName === 'svg') return 'Drawing';
  if (el.tagName === 'video') return 'Video';
  return 'Shape';
}

/** what a change of attributes did, in words */
function changeWords(el: HElement, was: Was): string[] {
  const out: string[] = [];
  const add = (w: string) => { if (!out.includes(w)) out.push(w); };
  for (const k of Object.keys(was)) {
    if (k === '@outer') add(el.tagName === 'img' || hasClass(el, 'ol-crop') ? 'cropped' : 'edited');
    else if (k === '@i') add(hasClass(el, 'slide') ? 'moved to another place' : 'brought forward or sent back');
    else if (k === 'style') {
      const a = new Map(parseStyle(String(was[k] ?? '')).map(d => [d.prop.toLowerCase(), d.value]));
      const b = new Map(parseStyle(attr(el, 'style') ?? '').map(d => [d.prop.toLowerCase(), d.value]));
      for (const p of new Set([...a.keys(), ...b.keys()])) {
        if (a.get(p) === b.get(p)) continue;
        if (['left', 'top', 'right', 'bottom', 'translate', 'inset', 'margin-left', 'margin-top'].includes(p)) add('moved');
        else if (['width', 'height', 'min-height', 'max-width'].includes(p)) add('resized');
        else if (p === 'rotate' || p === 'transform') add('rotated');
        else if (p === 'scale') add('flipped');
        else add('formatted');
      }
    }
    else if (k === 'src') add('picture replaced');
    else if (['d', 'points', 'x1', 'y1', 'x2', 'y2', 'viewbox', 'transform', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height', 'x', 'y'].includes(k)) add('reshaped');
    else if (k === 'data-step' || k === 'data-steps') add('animation changed');
    else if (k === 'data-ol-locked') add(was[k] === null ? 'locked' : 'unlocked');
    else if (k === 'fill' || k === 'stroke' || k === 'stroke-width' || k === 'class') add('formatted');
    else add('changed');
  }
  return out;
}

/** every comment thread and suggestion of the page, in document order (suggestions one per object and person) */
/** a review attribute anywhere in the text (attribute names: any case) */
const REVIEW_ATTR = /data-ol-(comments|by|ins|del|chg)\b/i;

export function reviewOf(text: string): Review {
  // (nothing to review: no parse — the page parsed again after every pen stroke, on a deck with much ink)
  if (!REVIEW_ATTR.test(text)) return { changes: [], threads: [] };
  const { doc } = parseSource(text);
  const slides = slideElements(doc);
  const slideOf = (el: HElement) => { for (const e of upFrom(el)) { const i = slides.indexOf(e); if (i >= 0) return i; } return -1; };
  /** the object a mark belongs to: the child of its slide (or the slide); on a web page the nearest block */
  const objectOf = (el: HElement): HElement => {
    for (const e of upFrom(el)) {
      if (slides.includes(e)) return e;
      const p = parentEl(e);
      if (p && slides.includes(p)) return e;
    }
    for (const e of upFrom(el)) if (BLOCKS.has(e.tagName) && e.tagName !== 'li' && e.tagName !== 'td' && e.tagName !== 'tr') return e;
    return el;
  };
  const changes: ReviewChange[] = [];
  const byKey = new Map<string, ReviewChange & { typed: string; deleted: string; did: string[] }>();
  const threads: ReviewThread[] = [];
  const body = [...walk(doc)].find(e => e.tagName === 'body');
  if (!body) return { changes, threads };
  for (const el of walk(body)) {
    const c = attr(el, COMMENTS);
    if (c !== null) for (const th of parseThreads(c)) threads.push({ path: pathOf(el), slide: slideOf(el), what: describe(el, slides), thread: th });
    const marks: { kind: ChangeKind; v: string }[] = [];
    const isText = (el.tagName === 'ins' || el.tagName === 'del') && attr(el, BY) !== null;
    if (isText) marks.push({ kind: 'text', v: attr(el, BY)! });
    for (const [a, kind] of [[INS, 'added'], [DEL, 'deleted'], [CHG, 'changed']] as const) { const v = attr(el, a); if (v !== null) marks.push({ kind, v }); }
    if (!marks.length) continue;
    const obj = objectOf(el);
    for (const m of marks) {
      const s = parseStamp(m.v)!;
      const key = pathOf(obj).join('.') + '|' + s.by;
      let ch = byKey.get(key);
      if (!ch) {
        ch = { path: pathOf(obj), slide: slideOf(obj), by: s.by, at: s.at, kinds: [], what: describe(obj, slides), summary: '', typed: '', deleted: '', did: [] };
        byKey.set(key, ch);
        changes.push(ch);
      }
      ch.at = later(ch.at, s.at);
      if (!ch.kinds.includes(m.kind)) ch.kinds.push(m.kind);
      const part = el === obj ? '' : ' ' + (el.tagName === 'li' ? 'an item' : el.tagName === 'p' ? 'a paragraph' : 'a part');
      if (m.kind === 'text') { if (el.tagName === 'ins') ch.typed += ' ' + plainText(el); else ch.deleted += ' ' + plainText(el); }
      else if (m.kind === 'added') ch.did.push(`Added${part}`);
      else if (m.kind === 'deleted') ch.did.push(`Deleted${part}`);
      else for (const w of changeWords(el, parseWas(attr(el, WAS)))) ch.did.push(w[0].toUpperCase() + w.slice(1) + (part ? ` (${part.trim()})` : ''));
    }
  }
  for (const ch of byKey.values()) {
    const parts = [...new Set(ch.did)];
    if (ch.typed.trim()) parts.push(`Typed “${words(ch.typed)}”`);
    if (ch.deleted.trim()) parts.push(`Deleted “${words(ch.deleted)}”`);
    ch.summary = parts.join(' · ') || 'Changed';
  }
  return { changes: changes.map(({ path, slide, by, at, kinds, what, summary }) => ({ path, slide, by, at, kinds, what, summary })), threads };
}

/** the open comment threads and pending suggestions, counted (the toolbar's badge) */
export function reviewCounts(text: string): { comments: number; changes: number } {
  if (!/data-ol-(comments|ins|del|chg|by)\b/.test(text)) return { comments: 0, changes: 0 };
  const r = reviewOf(text);
  return { comments: r.threads.filter(t => !t.thread.done).length, changes: r.changes.length };
}


/** a stable hue (0–359) for a person's suggestions and comments, the same everywhere (as comment avatars have it) */
export function reviewHue(name: string): number {
  let h = 0;
  for (const ch of name.trim().toLowerCase()) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return h % 360;
}
