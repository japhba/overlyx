/**
 * A markdown document's typesetting, set in its YAML front matter: pandoc's variables where pandoc
 * has one, so the file comes out alike with `pandoc --pdf-engine=lualatex`, and `headings`, OverLyX's:
 *
 *   mainfont, sansfont, monofont, mathfont   OpenType fonts by name (fontspec, unicode-math); the
 *                                            settings dialog offers MD_FONTS, each with its math font
 *   fontsize: 11pt         papersize: a4        geometry: margin=2cm (or a list of geometry's options)
 *   linestretch: 1.25      numbersections: true      justify: true (OverLyX's; ragged right without)
 *   headings               how headings are set (titlesec; the editor draws them alike): `run-in`, or
 *                          keys for every level — display (block | run-in), font (a name, or a font
 *                          by name with axes: `Inter|300`), size (small | normal | large | larger |
 *                          huge, or 14pt), weight (bold | normal), shape (upright | italic), case
 *                          (normal | smallcaps | uppercase), color (#rrggbb), align (left | center |
 *                          right), rule (none | below | above), space-above / space-below (a length:
 *                          0.5ex, 4pt, 1em) — and under section: … paragraph: a level's own
 *                          (`section: { size: larger, rule: below }`)
 *   styles                 the same keys for `title` (titling), `body` (its colour; its font, size and
 *                          alignment are mainfont / fontsize / justify) and `quote` (core textstyles.ts)
 *   header-includes        LaTeX for the preamble, after all of the above — for what no key says: the
 *                          editor cannot draw it (it reads \justifying, \titleformat, \titlespacing and a
 *                          patched \@maketitle: textstyles.ts stylesFromIncludes)
 *
 * Parsing a markdown document turns these into its settings (header lines: the editor shows the
 * fonts, the numbering and the run-in headings; `applyTypesetting`), and its PDF's preamble gets the
 * rest (`typesettingPreamble`, md/latex.ts). Document ▸ Settings writes them (`setFrontMatter`),
 * leaving the rest of the front matter — keys of other tools, comments — as it was. They are plain
 * keys, safe to edit by hand: nothing in the file is generated.
 */
import type { Header } from '../lyx/ast.ts';
import { markdownHeader } from './common.ts';
import { HEADING_LEVELS, textStyleOf, stylesFromIncludes, stylesLatex, stylesUseFonts, stylesJson, mergeStyles, type HeadingLevel, type TextStyle, type TextStyles } from '../textstyles.ts';
import { OLFONT_DEF } from '../fontface.ts';

export { HEADING_LEVELS, type HeadingLevel } from '../textstyles.ts';

/** a text face with the math font drawn for it — the ones TeX Live's LuaLaTeX finds by these names */
export interface MdFont { label: string; main: string; math: string; hint: string }
export const MD_FONTS: MdFont[] = [
  { label: 'Latin Modern', main: 'Latin Modern Roman', math: 'Latin Modern Math', hint: 'LaTeX’s Computer Modern' },
  { label: 'New Computer Modern', main: 'New Computer Modern 10', math: 'New Computer Modern Math', hint: 'Computer Modern, complete' },
  { label: 'Libertinus', main: 'Libertinus Serif', math: 'Libertinus Math', hint: 'Linux Libertine’s successor' },
  { label: 'STIX Two', main: 'STIX Two Text', math: 'STIX Two Math', hint: 'a Times for science' },
  { label: 'XITS', main: 'XITS', math: 'XITS Math', hint: 'a Times' },
  { label: 'XCharter', main: 'XCharter', math: 'XCharter Math', hint: 'Charter' },
  { label: 'Erewhon', main: 'Erewhon', math: 'Erewhon Math', hint: 'Utopia' },
  { label: 'EB Garamond', main: 'EB Garamond', math: 'Garamond-Math', hint: 'Garamond' },
  { label: 'Fira', main: 'Fira Sans', math: 'Fira Math', hint: 'sans-serif' },
];

/** a front matter value: text, a list, or keys of their own (`headings:` and its levels) */
export type FMValue = string | string[] | { [key: string]: FMValue };

/** the font names TeX Live's LuaLaTeX finds itself (MD_FONTS); any other is fetched from Google Fonts by the server */
export const TEXLIVE_FONTS = new Set(MD_FONTS.flatMap(f => [f.main, f.math]));

/**
 * a font the build has as files (a Google font, fetched by the server): its folder in the build
 * directory and each face's file — `variable`: the files are variable fonts, a face is a weight of them
 */
export interface LocalFont { path: string; regular: string; bold?: string; italic?: string; boldItalic?: string; variable?: boolean }

/** fontspec's options loading a LocalFont by file (a face it lacks: drawn from the others, bolder or slanted) */
export function fontspecFiles(f: LocalFont): string {
  if (f.variable) {
    // one file per style, each face its weight (a setting for the whole font would hold for bold too)
    const axis = (w: number) => `RawFeature={axis={wght=${w}}}`;
    const it = f.italic ?? f.regular, fake = f.italic ? '' : ', FakeSlant=0.2';
    return [`Path=${f.path}`, `UprightFont=${f.regular}`, `UprightFeatures={${axis(400)}}`, `BoldFont=${f.bold ?? f.regular}`, `BoldFeatures={${axis(700)}}`,
      `ItalicFont=${it}`, `ItalicFeatures={${axis(400)}${fake}}`, `BoldItalicFont=${f.boldItalic ?? it}`, `BoldItalicFeatures={${axis(700)}${fake}}`].join(', ');
  }
  const o = [`Path=${f.path}`, `UprightFont=${f.regular}`];
  o.push(f.bold ? `BoldFont=${f.bold}` : `BoldFont=${f.regular}, BoldFeatures={FakeBold=2}`);
  o.push(f.italic ? `ItalicFont=${f.italic}` : `ItalicFont=${f.regular}, ItalicFeatures={FakeSlant=0.2}`);
  o.push(f.boldItalic ? `BoldItalicFont=${f.boldItalic}` : f.bold ? `BoldItalicFont=${f.bold}, BoldItalicFeatures={FakeSlant=0.2}` : `BoldItalicFont=${f.regular}, BoldItalicFeatures={FakeBold=2, FakeSlant=0.2}`);
  return o.join(', ');
}

/** the text fonts a document's typesetting names (body, sans, mono, headings) — the ones the server may fetch */
export function textFontsOf(t: MdTypesetting): string[] {
  return [...new Set([t.mainfont, t.sansfont, t.monofont, ...(t.headings ? HEADING_LEVELS.map(l => t.headings![l].font ?? '') : [])].filter(Boolean))];
}

/**
 * The front matter's keys (`---` … `---` / `...`): a value, a list (`[a, b]` or `- a` lines), a
 * block (`|` / `>` and indented lines, and pandoc's `- |` items), or keys of their own (indented
 * `key: value` lines, or `{ a: b, c: d }`). Enough YAML for pandoc's variables and `headings`;
 * quotes are taken off, comments left out.
 */
export function frontMatterVars(lines: string[]): Record<string, FMValue> {
  if (!/^---\s*$/.test(lines[0] ?? '')) return {};
  const end = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l));
  const body = lines.slice(1, end > 0 ? end : lines.length);
  return parseMap(body, 0, 0).map;
}

/**
 * a scalar without its quotes: YAML's escapes undone — `\\` and `\"` in double quotes (what yamlScalar
 * writes), `''` in single ones; any other backslash stays (`"\usepackage{…}"`, as people write
 * header-includes, is not YAML but means the backslash)
 */
const unquote = (v: string) => {
  const t = v.trim();
  const d = /^"(.*)"$/.exec(t);
  if (d) return d[1].replace(/\\(["\\])/g, '$1');
  const q = /^'(.*)'$/.exec(t);
  return q ? q[1].replace(/''/g, "'") : t;
};
const indentOf = (l: string) => l.length - l.trimStart().length;
const blank = (l: string) => !l.trim() || /^\s*#/.test(l);

/** `{ a: b, c: d }` (one level, no nesting inside) */
function flowMap(v: string): Record<string, FMValue> {
  const out: Record<string, FMValue> = {};
  for (const part of v.slice(1, -1).split(',')) {
    const m = /^\s*([A-Za-z][\w-]*)\s*:\s*(.*?)\s*$/.exec(part);
    if (m) out[m[1]] = /^\[.*\]$/.test(m[2]) ? m[2].slice(1, -1).split(';').map(unquote).filter(Boolean) : unquote(m[2]);
  }
  return out;
}

function parseMap(lines: string[], i: number, indent: number): { map: Record<string, FMValue>; i: number } {
  const map: Record<string, FMValue> = {};
  while (i < lines.length) {
    if (blank(lines[i])) { i++; continue; }
    const ind = indentOf(lines[i]);
    if (ind < indent) break;
    const m = /^\s*([A-Za-z][\w-]*):(?:\s+(.*?))?\s*$/.exec(lines[i]);
    i++;
    if (ind > indent || !m) continue;
    const key = m[1], v = (m[2] ?? '').replace(/\s+#.*$/, '');
    if (/^[|>]-?$/.test(v)) {
      // a block: its indented lines as they are
      const text: string[] = [];
      while (i < lines.length && (blank(lines[i]) || indentOf(lines[i]) > indent)) { if (lines[i].trim()) text.push(lines[i].trim()); i++; }
      map[key] = text.filter(t => !/^```/.test(t));
    } else if (/^\[.*\]$/.test(v)) map[key] = v.slice(1, -1).split(',').map(unquote).filter(Boolean);
    else if (/^\{.*\}$/.test(v)) map[key] = flowMap(v);
    else if (v) map[key] = unquote(v);
    else {
      // what follows, further in: a list, or keys of their own
      let j = i; while (j < lines.length && blank(lines[j])) j++;
      if (j >= lines.length || indentOf(lines[j]) <= indent) { map[key] = []; continue; }
      if (/^\s*-(\s|$)/.test(lines[j])) {
        const items: string[] = [];
        const at = indentOf(lines[j]);
        while (i < lines.length && (blank(lines[i]) || indentOf(lines[i]) >= at)) {
          const item = /^\s*-\s*(.*)$/.exec(lines[i]);
          if (item && indentOf(lines[i]) === at) {
            i++;
            // `- |`: a block of lines as the item (pandoc's header-includes)
            if (/^[|>]-?$/.test(item[1].trim())) {
              while (i < lines.length && (blank(lines[i]) || indentOf(lines[i]) > at)) { const t = lines[i].trim(); if (t && !/^```/.test(t)) items.push(t); i++; }
            } else if (item[1].trim()) items.push(unquote(item[1]));
          } else i++;
        }
        map[key] = items;
      } else {
        const sub = parseMap(lines, j, indentOf(lines[j]));
        map[key] = sub.map; i = sub.i;
      }
    }
  }
  return { map, i };
}

/* --------------------------------------------------------------- headings */

/** how a heading is set (each key optional: the level's default) — a text style (core textstyles.ts) */
export type HeadingStyle = TextStyle;
/** each level's style: `headings`' own keys for all levels, then the level's */
export type HeadingStyles = Record<HeadingLevel, HeadingStyle>;

/** the front matter's keys of a style (`space-above` …) as a text style */
function headingStyleOf(v: FMValue | undefined): HeadingStyle {
  return !v || typeof v === 'string' || Array.isArray(v) ? {} : textStyleOf(v);
}

/**
 * The heading styles the front matter's `headings` asks for, or null (LaTeX's own): `run-in` / `block`
 * for every level, or keys (HeadingStyle) for all levels and, under `section:` … `paragraph:`, a level's.
 */
export function headingStyles(v: FMValue | undefined): HeadingStyles | null {
  if (v === undefined || Array.isArray(v)) return null;
  const all: HeadingStyle = typeof v === 'string' ? (/^run-in$/i.test(v.trim()) ? { display: 'run-in' } : {}) : headingStyleOf(v);
  const out = {} as HeadingStyles;
  for (const level of HEADING_LEVELS) out[level] = { ...all, ...(typeof v === 'object' ? headingStyleOf(v[level]) : {}) };
  return HEADING_LEVELS.some(l => Object.keys(out[l]).length) ? out : null;
}

/** the front matter's `styles`: the title's, the body's and quotes' */
function otherStyles(v: FMValue | undefined): TextStyles {
  const out: TextStyles = {};
  if (!v || typeof v === 'string' || Array.isArray(v)) return out;
  for (const t of ['title', 'body', 'quote'] as const) { const st = headingStyleOf(v[t]); if (Object.keys(st).length) out[t] = st; }
  return out;
}

/** all styles the front matter sets (headings and `styles`) */
export function mdStyles(t: MdTypesetting): TextStyles {
  return mergeStyles(t.headings ?? {}, t.styles);
}

export interface MdTypesetting {
  mainfont: string; sansfont: string; monofont: string; mathfont: string;
  /** pt, or 0: the class's */
  fontsize: number;
  papersize: string;
  geometry: string[];
  /** 0: single */
  linestretch: number;
  numbersections: boolean;
  /** justified text (hyphenated) — a markdown document is set ragged right otherwise */
  justify: boolean;
  /** null: LaTeX's own */
  headings: HeadingStyles | null;
  /** `styles`: the title, the body, quotes */
  styles: TextStyles;
  headerIncludes: string[];
}

const one = (v: FMValue | undefined) => (typeof v === 'string' ? v : Array.isArray(v) ? v[0] ?? '' : '').trim();
const list = (v: FMValue | undefined) => (Array.isArray(v) ? v : typeof v === 'string' && v ? v.split(/,\s*/) : []).map(x => x.trim()).filter(Boolean);
/** a font name as fontspec takes it (no braces, backslashes or the like) */
function fontName(v: FMValue | undefined): string { const s = one(v); return /^[\p{L}\p{N} ._+-]{1,80}$/u.test(s) ? s : ''; }

/** the document's typesetting as its front matter (`lines`: the document's preamble — the front matter as written) says */
export function mdTypesetting(lines: string[]): MdTypesetting {
  const v = frontMatterVars(lines);
  const paper = one(v.papersize).toLowerCase().replace(/^us-?/, '').replace(/paper$/, '');
  const size = /^(\d+)\s*pt$/.exec(one(v.fontsize));
  const stretch = Number(one(v.linestretch));
  return {
    mainfont: fontName(v.mainfont), sansfont: fontName(v.sansfont), monofont: fontName(v.monofont), mathfont: fontName(v.mathfont),
    fontsize: size ? Number(size[1]) : 0,
    papersize: /^([abc]\d|letter|legal|executive)$/.test(paper) ? paper : '',
    // only what LaTeX's own key=value syntax allows (no braces or backslashes: those belong in header-includes)
    geometry: list(v.geometry).filter(o => /^[\w.-]+(=[\w.\s-]+)?$/.test(o)),
    linestretch: stretch > 0 && stretch < 5 ? stretch : 0,
    numbersections: one(v.numbersections) === 'true',
    justify: one(v.justify) === 'true',
    headings: headingStyles(v.headings),
    styles: otherStyles(v.styles),
    headerIncludes: list(v['header-includes']).filter(l => !/^\s*\\documentclass/.test(l)),
  };
}

/** The settings the typesetting amounts to, in the document's header (what the editor and the LaTeX writer read). */
export function applyTypesetting(h: Header, t: MdTypesetting): void {
  const set = (key: string, value: string) => {
    const i = h.lines.findIndex(l => l === '\\' + key || l.startsWith('\\' + key + ' '));
    if (i >= 0) h.lines[i] = `\\${key} ${value}`; else h.lines.push(`\\${key} ${value}`);
  };
  if (t.papersize) set('papersize', t.papersize);
  if (t.fontsize) set('paperfontsize', String(t.fontsize));
  if (t.linestretch) set('spacing', `other ${t.linestretch}`);
  if (t.numbersections) set('secnumdepth', '3');
  // what hand-written LaTeX in header-includes does, under what the keys say: the editor shows it too
  const hand = stylesFromIncludes(t.headerIncludes);
  // (the editor justifies on \overlyx_justify: a .tex document's \justification true is LaTeX's default, not a choice)
  // (always said: a markdown document is ragged right unless it says otherwise — the editor tells it from a .tex document so)
  const justify = t.justify || hand.justify || t.styles.body?.align === 'justify';
  if (justify) set('justification', 'true');
  set('overlyx_justify', String(justify));
  if (t.mainfont || t.sansfont || t.monofont) {
    set('use_non_tex_fonts', 'true');
    if (t.mainfont) set('font_roman', `"default" "${t.mainfont}"`);
    if (t.sansfont) set('font_sans', `"default" "${t.sansfont}"`);
    if (t.monofont) set('font_typewriter', `"default" "${t.monofont}"`);
  }
  // (OverLyX's own: the LyX export leaves \overlyx_ lines out; the editor draws its text styles so)
  const styles = mergeStyles(hand.styles, mdStyles(t));
  if (Object.keys(styles).length) set('overlyx_styles', stylesJson(styles));
}

/** the header keys the typesetting decides */
const TYPESET_KEYS = ['papersize', 'paperfontsize', 'spacing', 'secnumdepth', 'use_non_tex_fonts', 'font_roman', 'font_sans', 'font_typewriter', 'overlyx_headings', 'overlyx_styles', 'justification', 'overlyx_justify'];

/** A markdown document's header after its front matter changed: those keys as a markdown document has them, then as the front matter says. */
export function withTypesetting(headerLines: string[], preamble: string[]): string[] {
  const defaults = markdownHeader().lines;
  const keyOf = (l: string) => /^\\(\w+)/.exec(l)?.[1] ?? '';
  const lines = headerLines.filter(l => !TYPESET_KEYS.includes(keyOf(l)) || defaults.some(d => keyOf(d) === keyOf(l)))
    .map(l => (TYPESET_KEYS.includes(keyOf(l)) ? defaults.find(d => keyOf(d) === keyOf(l))! : l));
  const h: Header = { lines };
  applyTypesetting(h, mdTypesetting(preamble));
  return h.lines;
}

/**
 * the PDF's preamble for what the header does not say: margins, the math font, heading styles,
 * header-includes — and the fonts the build has as files (`files`, by name: Google fonts), loaded by
 * file (the header then names none of them: md/latex.ts)
 */
export function typesettingPreamble(t: MdTypesetting, files: Record<string, LocalFont> = {}): string[] {
  const out: string[] = [];
  const local = ([['setmainfont', t.mainfont], ['setsansfont', t.sansfont], ['setmonofont', t.monofont]] as const).filter(([, name]) => name && files[name]);
  if (local.length) out.push('\\usepackage{fontspec}', ...local.map(([cmd, name]) => `\\${cmd}{${name}}[${fontspecFiles(files[name])}${cmd === 'setmainfont' ? ', Ligatures=TeX' : ''}]`));
  if (t.geometry.length) out.push(`\\usepackage[${t.geometry.join(',')}]{geometry}`);
  // (unicode-math after amsmath, which the generated block would load after this)
  if (t.mathfont) out.push('\\usepackage{amsmath}', '\\usepackage{unicode-math}', `\\setmathfont{${t.mathfont}}`);
  // the text styles (fonts by name: \olfontset, defined here — the managed block may define it again: a no-op)
  const styles = mdStyles(t);
  if (stylesUseFonts(styles)) out.push('\\makeatletter', OLFONT_DEF, '\\makeatother');
  out.push(...stylesLatex(styles));
  out.push(...t.headerIncludes);
  return out;
}

/** a value as a front matter line's (quoted when YAML would read it otherwise) */
function yamlScalar(v: string): string {
  return /^[\p{L}\p{N}][\p{L}\p{N} ._+=-]*$/u.test(v) && !/\s$/.test(v) && !/^(true|false|null|yes|no|on|off|~)$/i.test(v) ? v : JSON.stringify(v);
}

/**
 * The front matter with `values` set: a key that is there is replaced where it stands (with its list or
 * block lines), a new one goes at the end, null takes one out; everything else stays as written. No
 * front matter: one is made; nothing left in it: it goes.
 */
export type FMSet = string | string[] | boolean | number | null | { [key: string]: string | string[] | boolean | number | { [key: string]: string } };
export function setFrontMatter(lines: string[], values: Record<string, FMSet>): string[] {
  const has = /^---\s*$/.test(lines[0] ?? '');
  let end = has ? lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l)) : -1;
  const body = has && end > 0 ? lines.slice(1, end) : [];
  const closing = has && end > 0 ? lines[end] : '---';
  const render = (key: string, v: Exclude<FMSet, null>, pad = ''): string[] =>
    Array.isArray(v) ? [`${pad}${key}:`, ...v.map(x => `${pad}  - ${yamlScalar(x)}`)]
      : typeof v === 'object' ? [`${pad}${key}:`, ...Object.entries(v).filter(([, x]) => x !== null && x !== '').flatMap(([k, x]) => render(k, x as Exclude<FMSet, null>, pad + '  '))]
      : [`${pad}${key}: ${typeof v === 'string' ? yamlScalar(v) : String(v)}`];
  for (const [key, v] of Object.entries(values)) {
    const at = body.findIndex(l => l.startsWith(key + ':') && /^\s*$|^\s/.test(l.slice(key.length + 1)));
    let to = at;
    if (at >= 0) while (to + 1 < body.length && (/^\s/.test(body[to + 1]) || body[to + 1] === '')) to++;
    const repl = v === null || v === '' || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length) ? [] : render(key, v);
    if (at >= 0) body.splice(at, to - at + 1, ...repl);
    else body.push(...repl);
  }
  while (body.length && body[body.length - 1] === '') body.pop();
  if (!body.some(l => l.trim())) return [];
  return ['---', ...body, closing];
}
