/**
 * A deck's theme as its stylesheet keeps it (the theme view's pane — DeliverableEditor's Edit theme,
 * Google Slides' theme builder): the colours its design names as custom properties at `:root`
 * (`--accent: #2f6fde`, `--paper`, `--ink` — the starters' and most agents' decks), the font of its
 * text (`body` / `.slide`) and of its headings (`h1, h2 { … }`). Read and written in place, in the
 * page's own `<style>`: a value replaced where it is written, a declaration added to the rule that
 * has none, a rule added at the end of the last stylesheet when there is no such rule — nothing else
 * of the file changes, and a change is one list of splices (one undo step). Pure string work, as
 * deckmaster.ts; the objects on every slide are deckmaster's linked copies.
 */
import { parseSource, walk, innerRange, insertSplice, elementChildren, htmlElement, type Splice } from '@overlyx/core/html/source.ts';

/** a colour the deck names (`--accent`), as its last declaration at :root has it; `hex` for the colour picker */
export interface ThemeColor { name: string; value: string; hex: string | null }
/** a font of the theme: the CSS font-family list (null: none set), its first family, unquoted */
export interface ThemeFont { value: string | null; family: string | null }
export interface DeckTheme {
  colors: ThemeColor[];
  /** the slides' text (`.slide`, `body`, `html` or `:root`, the first of them that sets one) */
  text: ThemeFont;
  /** the headings (a rule of headings alone); `inherit` (or none set): the text's */
  headings: ThemeFont;
}

/** a top-level rule of a stylesheet: its selector, and where its `{` and `}` are in the page's text */
interface Rule { sel: string[]; open: number; close: number }
/** a declaration of a rule: where its value is (trimmed) and where it ends (after its `;`, if any) */
interface Decl { prop: string; value: string; from: number; to: number }

/** the contents of the page's <style> elements (offsets in the text), in document order */
function sheets(text: string): { from: number; to: number }[] {
  const { doc } = parseSource(text);
  const out: { from: number; to: number }[] = [];
  for (const el of walk(doc)) if (el.tagName === 'style') { const r = innerRange(el); if (r) out.push(r); }
  return out;
}

/** comments blanked out, the same length (what is inside a string stays) */
const blank = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, m => ' '.repeat(m.length));

/** the rules at the top level of a stylesheet (not inside @media, not at-rules) */
function rulesIn(text: string, from: number, to: number): Rule[] {
  const css = blank(text.slice(from, to));
  const out: Rule[] = [];
  let depth = 0, start = 0, open = -1;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === '"' || c === "'") { const j = css.indexOf(c, i + 1); i = j < 0 ? css.length : j; continue; }
    if (c === '{') { if (depth === 0) open = i; depth++; }
    else if (c === '}') {
      if (depth === 1) {
        const sel = css.slice(start, open).trim();
        if (!sel.startsWith('@')) out.push({ sel: sel.split(',').map(s => s.trim().replace(/\s+/g, ' ')), open: from + open, close: from + i });
        start = i + 1;
      }
      depth = Math.max(0, depth - 1);
    } else if (c === ';' && depth === 0) start = i + 1;
  }
  return out;
}

/** a rule's declarations */
function declsOf(text: string, r: Rule): Decl[] {
  const body = blank(text.slice(r.open + 1, r.close));
  const out: Decl[] = [];
  let depth = 0, start = 0;
  const end = (i: number) => {
    const part = body.slice(start, i), colon = part.indexOf(':');
    if (colon > 0) {
      const prop = part.slice(0, colon).trim().toLowerCase();
      const raw = part.slice(colon + 1), lead = raw.length - raw.trimStart().length;
      const value = raw.trim();
      const from = r.open + 1 + start + colon + 1 + lead;
      if (prop && value) out.push({ prop, value, from, to: from + value.length });
    }
    start = i + 1;
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"' || c === "'") { const j = body.indexOf(c, i + 1); i = j < 0 ? body.length : j; continue; }
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === ';' && depth === 0) end(i);
  }
  end(body.length);
  return out;
}

const COLOR = /^(#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*\)|black|white|gr[ae]y|silver|red|maroon|orange|yellow|olive|lime|green|teal|aqua|cyan|blue|navy|purple|fuchsia|magenta|pink|brown|gold|indigo|violet|crimson|coral|salmon|tomato|beige|ivory|khaki|lavender|tan|turquoise)$/i;

/** #rrggbb of a colour the picker can show (#rgb, #rrggbb, rgb()), else null */
export function hexOf(v: string): string | null {
  const s = v.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) return '#' + [...s.slice(1)].map(c => c + c).join('');
  const m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/.exec(s);
  return m ? '#' + [m[1], m[2], m[3]].map(n => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('') : null;
}

/** the first family of a font-family list, unquoted */
export function firstFamily(list: string | null): string | null {
  if (!list) return null;
  const f = list.split(',')[0].trim().replace(/^["']|["']$/g, '');
  return f || null;
}

const TEXT_SEL = ['.slide', 'section.slide', 'body', 'html', ':root'];
const HEADING = /^(?:(?:section)?\.slide )?h[1-6]$/;
const isHeadings = (r: Rule) => r.sel.length > 0 && r.sel.every(s => HEADING.test(s));
/** the family of a `font` shorthand (after its size and line height) */
const shorthandFamily = (v: string) => /(?:^|\s)[\d.]+(?:px|pt|pc|em|rem|ex|ch|%|vw|vh|vmin|vmax|mm|cm|in|q)?(?:\s*\/\s*\S+)?\s+(.+)$/i.exec(v)?.[1]?.trim() ?? null;

/** the top-level rules of all the page's stylesheets, in order */
const rulesOf = (text: string): Rule[] => sheets(text).flatMap(s => rulesIn(text, s.from, s.to));

/** the rules setting the text's font, the strongest first (`.slide` over `body` over `html`) */
function textRules(text: string, all: Rule[]): { rule: Rule; rank: number; decl: Decl | null; short: Decl | null }[] {
  const out: { rule: Rule; rank: number; decl: Decl | null; short: Decl | null }[] = [];
  for (const r of all) {
    const rank = Math.min(...r.sel.map(s => { const k = TEXT_SEL.indexOf(s); return k < 0 ? 99 : k; }));
    if (rank === 99) continue;
    const ds = declsOf(text, r);
    out.push({ rule: r, rank, decl: [...ds].reverse().find(d => d.prop === 'font-family') ?? null, short: [...ds].reverse().find(d => d.prop === 'font') ?? null });
  }
  // (of one rank, the later rule wins)
  return out.map((x, i) => ({ x, i })).sort((a, b) => a.x.rank - b.x.rank || b.i - a.i).map(({ x }) => x);
}

/** The deck's theme: its colours and fonts as its stylesheet has them. */
export function deckTheme(text: string): DeckTheme {
  const all = rulesOf(text);
  const colors = new Map<string, ThemeColor>();
  for (const r of all) {
    if (!r.sel.some(s => s === ':root' || s === 'html')) continue;
    for (const d of declsOf(text, r)) {
      if (!d.prop.startsWith('--') || !COLOR.test(d.value)) continue;
      const name = d.prop;
      // (declared again later: that one counts, where the first was)
      colors.set(name, { name, value: d.value, hex: hexOf(d.value) });
    }
  }
  let body: string | null = null;
  for (const t of textRules(text, all)) {
    const v = t.decl?.value ?? (t.short ? shorthandFamily(t.short.value) : null);
    if (v && !/^(inherit|initial|unset|revert)$/i.test(v)) { body = v; break; }
  }
  let head: string | null = null;
  for (const r of all) if (isHeadings(r)) { const d = [...declsOf(text, r)].reverse().find(x => x.prop === 'font-family'); if (d) head = d.value; }
  if (head && /^(inherit|initial|unset|revert)$/i.test(head)) head = null;
  return { colors: [...colors.values()], text: { value: body, family: firstFamily(body) }, headings: { value: head, family: firstFamily(head) } };
}

/** what the theme pane changes: a colour's value, or a font (null for the headings: as the text) */
export type ThemeChange = { color: string; value: string } | { font: 'text' | 'headings'; value: string | null; google?: string };

/** a declaration put at the end of a rule */
function appendDecl(text: string, r: Rule, decl: string): Splice {
  const body = text.slice(r.open + 1, r.close);
  const trimmed = body.replace(/\s+$/, '');
  const at = r.open + 1 + trimmed.length;
  const sep = !trimmed.trim() ? ' ' : trimmed.endsWith(';') ? ' ' : '; ';
  return { from: at, to: at, insert: `${sep}${decl};${trimmed.trim() ? '' : ' '}` };
}

/** the page's <head>, when it is written in the text */
function headOf(text: string) {
  const { doc } = parseSource(text);
  const root = htmlElement(doc);
  const head = root ? elementChildren(root).find(e => e.tagName === 'head') : undefined;
  return head?.sourceCodeLocation ? head : null;
}

/** a rule put at the end of a stylesheet, on a line of its own, indented as the rules before it */
function ruleAtEnd(text: string, sheet: { from: number; to: number }, rule: string): Splice {
  const css = text.slice(sheet.from, sheet.to);
  const trimmed = css.replace(/\s+$/, '');
  const indent = /(?:^|\n)([ \t]*)\S[^\n]*$/.exec(trimmed)?.[1] ?? '  ';
  const at = sheet.from + trimmed.length;
  return { from: at, to: at, insert: `\n${indent}${rule}` };
}

/** the <link> of a Google font, when the page does not link it yet (as the deck toolbar's font list adds it) */
function fontLink(text: string, google: string | undefined): string {
  if (!google) return '';
  const fam = google.replace(/ /g, '+');
  if (text.includes(`family=${fam}`)) return '';
  return `<link href="https://fonts.googleapis.com/css2?family=${fam}:ital,wght@0,400;0,700;1,400;1,700&display=swap" rel="stylesheet">`;
}

/**
 * A change of the theme as splices of `text` (one undo step): a colour's value where its last :root
 * declaration is; a font in every rule that sets it (else added to the text's rule — `body`'s — or the
 * headings' rule, else a rule of its own at the end of the last stylesheet, or in a <style> of its own
 * when the page has none), the Google font's stylesheet linked in the <head>. Empty: nothing to change.
 */
export function themeSplices(text: string, ch: ThemeChange): Splice[] {
  const all = rulesOf(text);
  const out: Splice[] = [];
  /** a rule of its own, when no rule takes the declaration */
  let rule: string | null = null;
  if ('color' in ch) {
    let at: Decl | null = null;
    for (const r of all) if (r.sel.some(s => s === ':root' || s === 'html')) for (const d of declsOf(text, r)) if (d.prop === ch.color) at = d;
    const root = all.filter(r => r.sel.includes(':root')).pop();
    if (at) { if (at.value !== ch.value) out.push({ from: at.from, to: at.to, insert: ch.value }); }
    else if (root) out.push(appendDecl(text, root, `${ch.color}: ${ch.value}`));
    else rule = `:root { ${ch.color}: ${ch.value}; }`;
  } else {
    const value = ch.value ?? 'inherit';
    const set = (d: Decl) => { if (d.value !== value) out.push({ from: d.from, to: d.to, insert: value }); };
    if (ch.font === 'text') {
      const rs = textRules(text, all);
      // (a rule with the `font` shorthand alone: the family after it)
      for (const x of rs) if (x.decl) set(x.decl); else if (x.short) out.push(appendDecl(text, x.rule, `font-family: ${value}`));
      if (!rs.some(x => x.decl || x.short)) {
        const r = rs.find(x => x.rule.sel.includes('body'))?.rule ?? rs[0]?.rule;
        if (r) out.push(appendDecl(text, r, `font-family: ${value}`));
        else rule = `body { font-family: ${value}; }`;
      }
    } else {
      const hs = all.filter(isHeadings);
      const decls = hs.map(r => [...declsOf(text, r)].reverse().find(x => x.prop === 'font-family')).filter((d): d is Decl => !!d);
      if (decls.length) for (const d of decls) set(d);
      else if (ch.value !== null) {
        if (hs.length) out.push(appendDecl(text, hs[hs.length - 1], `font-family: ${value}`));
        else rule = `h1, h2, h3, h4, h5, h6 { font-family: ${value}; }`;
      }
    }
  }
  const ss = sheets(text);
  if (rule && ss.length) out.push(ruleAtEnd(text, ss[ss.length - 1], rule));
  // in the <head>, after what is there: the font's stylesheet, then (the page had none) a stylesheet with the rule
  const link = out.length || rule ? fontLink(text, 'font' in ch && ch.value !== null ? ch.google : undefined) : '';
  const tail = [link, rule && !ss.length ? `<style>\n  ${rule}\n</style>` : ''].filter(Boolean).join('\n');
  const head = tail ? headOf(text) : null;
  if (tail && head) out.push(insertSplice(text, head, 1e6, tail));
  return out;
}
