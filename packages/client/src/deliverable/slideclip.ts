/**
 * Slides on the clipboard: copied in the slide list of one deck, pasted in the same deck or in
 * another one (another tab, another project). The system clipboard carries them — in the copy's
 * text/html, a comment `<!--overlyx-slides <base64 JSON>-->` (SlidesClip) before the slides' words.
 *
 * Pasted into another deck, the slides take that deck's look and keep what was their own (as
 * PowerPoint's "Use destination theme"): their markup arrives as it is — classes the receiving
 * deck's stylesheet knows are styled by it, inline styles stay —; rules of the old deck's
 * stylesheet for classes the receiving deck does not know come along in a
 * `<style data-ol-pasted>` in its head, with the custom properties those and the slides use; what
 * was on every slide of the old deck (`data-ol-master` objects) is replaced by what is on every
 * slide of the receiving one (or stays, unlinked, when that deck has nothing on every slide); and
 * the pictures the slides show (relative addresses) are copied into the receiving deck's folder.
 * Pure string work (tests/slideclip.test.ts); the editor's part: slideselection.ts.
 */
import { parseSource, elementChildren, walk, attr, removeSplice, applySplices, pathOf, type HtmlOp, type HElement } from '@overlyx/core/html/source.ts';
import { slideElements } from '@overlyx/core/html/deliverable.ts';
import { MASTER_ATTR } from './deckmaster';
import { dedented, slideGap, insertSlidesOp } from './slideops';

export interface SlidesClip {
  v: 1;
  /** the deck the slides were copied in (its document id; a host without ids: its path) and its folder (project-relative) */
  deck: string;
  dir: string;
  /** the slides' source, each as written (without its line's indentation) */
  slides: string[];
  /** the rules of that deck's stylesheet that name a class the slides use; the custom properties the slides and those rules use */
  rules: string[];
  vars: Record<string, string>;
}

const MARK = /<!--overlyx-slides ([A-Za-z0-9+/=]+)-->/;
/** the attribute of the <style> that holds what pasted slides brought along */
export const PASTED_ATTR = 'data-ol-pasted';

function b64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}
function unb64(s: string): string {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/* ------------------------------------------------------------------ stylesheets, read just enough */

interface CssRule { prelude: string; inner: string; text: string }
/** the rules at the top of a stylesheet (comments and strings skipped; statements without a block left out) */
export function cssRules(css: string): CssRule[] {
  const out: CssRule[] = [];
  let start = 0, depth = 0, open = -1;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === '/' && css[i + 1] === '*') { const e = css.indexOf('*/', i + 2); i = e < 0 ? css.length : e + 1; if (depth === 0 && !css.slice(start, i + 1).replace(/\/\*[\s\S]*?\*\//g, '').trim()) start = i + 1; continue; }
    if (c === '"' || c === "'") { for (i++; i < css.length && css[i] !== c; i++) if (css[i] === '\\') i++; continue; }
    if (c === '{') { if (depth === 0) open = i; depth++; continue; }
    if (c === '}') {
      if (depth > 0) depth--;
      if (depth === 0 && open >= 0) { out.push({ prelude: css.slice(start, open).trim(), inner: css.slice(open + 1, i), text: css.slice(start, i + 1).trim() }); start = i + 1; open = -1; }
      continue;
    }
    if (c === ';' && depth === 0) start = i + 1;
  }
  return out;
}
const GROUPS = /^@(media|supports|container|layer)\b/i;
const classesIn = (selector: string): string[] => [...selector.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)].map(m => m[1]);
/** the classes a rule is written for (a @media's: its rules') */
function ruleClasses(r: CssRule): string[] {
  if (r.prelude.startsWith('@')) return GROUPS.test(r.prelude) ? cssRules(r.inner).flatMap(ruleClasses) : [];
  return classesIn(r.prelude);
}
/** the rules of `css` that name one of `classes` (of a @media and its like: those of its rules) */
function rulesFor(css: string, classes: Set<string>): string[] {
  const out: string[] = [];
  for (const r of cssRules(css)) {
    if (!r.prelude.startsWith('@')) { if (classesIn(r.prelude).some(c => classes.has(c))) out.push(r.text); continue; }
    if (!GROUPS.test(r.prelude)) continue;
    const inner = rulesFor(r.inner, classes);
    if (inner.length) out.push(`${r.prelude} {\n  ${inner.join('\n  ')}\n}`);
  }
  return out;
}

/** a deck's own stylesheet: its <style> elements outside the slides */
export function deckCss(text: string): string {
  const { doc } = parseSource(text);
  const out: string[] = [];
  for (const el of walk(doc)) {
    const loc = el.sourceCodeLocation;
    if (el.tagName !== 'style' || !loc?.startTag || !loc.endTag) continue;
    out.push(text.slice(loc.startTag.endOffset, loc.endTag.startOffset));
  }
  return out.join('\n');
}
const usedClasses = (html: string): Set<string> => {
  const out = new Set<string>();
  for (const m of html.matchAll(/\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) for (const c of (m[1] ?? m[2] ?? '').split(/\s+/)) if (c && c !== 'slide') out.add(c);
  return out;
};
const usedVars = (s: string): string[] => [...new Set([...s.matchAll(/var\(\s*(--[\w-]+)/g)].map(m => m[1]))];
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ------------------------------------------------------------------ copy */

const wordsOf = (html: string): string => html.replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** What copying the slides `sel` puts on the clipboard (null: none of them is there). */
export function slidesClip(text: string, sel: readonly number[], from: { deck: string; dir: string }): { html: string; plain: string; clip: SlidesClip } | null {
  const src = parseSource(text);
  const els = slideElements(src.doc);
  const picked = [...new Set(sel)].sort((a, b) => a - b).filter(i => els[i]);
  if (!picked.length) return null;
  const slides = picked.map(i => dedented(src.text, els[i]));
  const all = slides.join('\n');
  const css = deckCss(text);
  const rules = rulesFor(css, usedClasses(all));
  const vars: Record<string, string> = {};
  // (a property's value may use another: followed a few levels)
  let names = usedVars(all + '\n' + rules.join('\n'));
  for (let level = 0; level < 4 && names.length; level++) {
    const next: string[] = [];
    for (const n of names) {
      if (n in vars) continue;
      const m = new RegExp(`(?:^|[;{\\s])${esc(n)}\\s*:\\s*([^;}]+)`).exec(css);
      if (m) { vars[n] = m[1].trim(); next.push(...usedVars(m[1])); }
    }
    names = next;
  }
  const clip: SlidesClip = { v: 1, deck: from.deck, dir: from.dir, slides, rules, vars };
  const words = slides.map(wordsOf);
  return { html: `<!--overlyx-slides ${b64(JSON.stringify(clip))}-->${words.map(w => `<p>${escHtml(w)}</p>`).join('')}`, plain: words.join('\n\n'), clip };
}

/** The slides a clipboard's text/html carries (null: none). */
export function readSlidesClip(html: string): SlidesClip | null {
  const m = MARK.exec(html);
  if (!m) return null;
  try {
    const c = JSON.parse(unb64(m[1])) as SlidesClip;
    if (c?.v !== 1 || !Array.isArray(c.slides) || !c.slides.length || !c.slides.every(s => typeof s === 'string')) return null;
    return { v: 1, deck: String(c.deck ?? ''), dir: String(c.dir ?? ''), slides: c.slides, rules: Array.isArray(c.rules) ? c.rules.filter(r => typeof r === 'string') : [], vars: c.vars && typeof c.vars === 'object' ? c.vars : {} };
  } catch { return null; }
}
export const hasSlidesClip = (html: string): boolean => MARK.test(html);

/* ------------------------------------------------------------------ paste */

const RELATIVE = (u: string) => !!u && !/^([a-z][a-z0-9+.-]*:|\/|#|\?)/i.test(u.trim());
/** the files a piece of HTML shows by a relative address: pictures, videos, backgrounds */
export function relativeAssets(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/\s(?:src|poster)\s*=\s*(?:"([^"]+)"|'([^']+)')/gi)) out.add(m[1] ?? m[2]);
  for (const m of html.matchAll(/<image\b[^>]*?\s(?:xlink:)?href\s*=\s*(?:"([^"]+)"|'([^']+)')/gi)) out.add(m[1] ?? m[2]);
  for (const m of html.matchAll(/url\(\s*(?:&quot;|["'])?([^"')&]+)(?:&quot;|["'])?\s*\)/gi)) out.add(m[1]);
  return [...out].filter(RELATIVE);
}
/** `html` with the addresses of `map` replaced (old → new) */
export function withAssets(html: string, map: Record<string, string>): string {
  let out = html;
  for (const [a, b] of Object.entries(map)) {
    if (a === b) continue;
    out = out.replace(new RegExp(`(=\\s*["'])${esc(a)}(["'])`, 'g'), (_m, p: string, q: string) => p + b + q)
      .replace(new RegExp(`(url\\(\\s*(?:&quot;|["'])?)${esc(a)}((?:&quot;|["'])?\\s*\\))`, 'g'), (_m, p: string, q: string) => p + b + q);
  }
  return out;
}

/** a slide's source with its objects of every slide (`data-ol-master`) taken out and `masters` put in their stead, first */
function withMasters(slide: string, masters: string[]): string {
  const src = parseSource(slide);
  const el = slideElements(src.doc)[0];
  const st = el?.sourceCodeLocation?.startTag;
  if (!el || !st) return slide;
  const own = elementChildren(el).filter(k => k.sourceCodeLocation && attr(k, MASTER_ATTR) !== null);
  const splices = own.map(k => removeSplice(slide, k));
  if (masters.length) splices.push({ from: st.endOffset, to: st.endOffset, insert: '\n  ' + masters.map(m => m.split('\n').join('\n  ')).join('\n  ') });
  return applySplices(slide, splices);
}
const unlinked = (slide: string): string => slide.replace(/(<[a-zA-Z][^<>]*?)\sdata-ol-master\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/g, '$1');

export interface PastePlan {
  /** the slides as they go in (before their pictures' addresses are set: withAssets) */
  slides: string[];
  /** from another deck: what came along (styles: an operation on the receiving deck's head; pictures to copy, as the slides name them) */
  foreign: boolean;
  style: string | null;
  assets: string[];
}

/** How the clipboard's slides go into the deck `text` (its id `deck`), after slide `after`. */
export function pastePlan(text: string, clip: SlidesClip, deck: string, after: number): PastePlan {
  if (clip.deck === deck) return { slides: clip.slides, foreign: false, style: null, assets: [] };
  const src = parseSource(text);
  const els = slideElements(src.doc);
  // what is on every slide here: the pasted slides get it, in place of their old deck's
  const here = els[Math.max(0, Math.min(els.length - 1, after))];
  const masters = here ? elementChildren(here).filter(k => k.sourceCodeLocation && attr(k, MASTER_ATTR) !== null).map(k => dedented(src.text, k)) : [];
  const anyMaster = els.some(s => elementChildren(s).some(k => attr(k, MASTER_ATTR) !== null));
  const slides = clip.slides.map(s => (anyMaster ? withMasters(s, masters) : unlinked(s)));
  const all = slides.join('\n');
  // the old deck's rules for classes this deck's stylesheet does not know, the custom properties it does not set
  const css = deckCss(text);
  const known = new Set(cssRules(css).flatMap(ruleClasses));
  const used = usedClasses(all);
  const rules = clip.rules.filter(r => !text.includes(r) && cssRules(r).flatMap(ruleClasses).some(c => used.has(c) && !known.has(c)));
  const need = new Set(usedVars(all + '\n' + rules.join('\n')));
  for (let level = 0; level < 4; level++) for (const n of [...need]) for (const v of usedVars(clip.vars[n] ?? '')) need.add(v);
  const vars = [...need].filter(n => clip.vars[n] !== undefined && !new RegExp(`(?:^|[;{\\s"'])${esc(n)}\\s*:`).test(text));
  const parts = [...(vars.length ? [`:root { ${vars.map(n => `${n}: ${clip.vars[n]};`).join(' ')} }`] : []), ...rules];
  const style = parts.length ? `<style ${PASTED_ATTR}>\n/* styles that slides pasted from another deck brought along */\n${parts.join('\n')}\n</style>` : null;
  return { slides, foreign: true, style, assets: relativeAssets(all) };
}

/** The operations of a paste: the slides after slide `after`, the styles they brought into the head. */
export function pasteOps(text: string, after: number, slides: string[], style: string | null): { ops: HtmlOp[]; sel: number[] } | null {
  const src = parseSource(text);
  const els = slideElements(src.doc);
  const at = Math.max(0, Math.min(els.length - 1, after));
  const op = insertSlidesOp(text, at, slides.join(slideGap(src.text, els)));
  if (!op) return null;
  const ops: HtmlOp[] = [op];
  if (style) {
    let head: HElement | null = null;
    for (const el of walk(src.doc)) if (el.tagName === 'head' && el.sourceCodeLocation) { head = el; break; }
    if (head) ops.push({ t: 'insert', parent: pathOf(head), index: 1e6, html: style });
  }
  return { ops, sel: slides.map((_, k) => at + 1 + k) };
}

/** a project-relative path made of a folder and a relative address (null: it leaves the project) */
export function joinPath(dir: string, rel: string): string | null {
  const out: string[] = [];
  for (const seg of [...dir.split('/'), ...decodeURI(rel.split(/[?#]/)[0]).split('/')]) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (!out.length) return null; out.pop(); continue; }
    out.push(seg);
  }
  return out.join('/');
}
