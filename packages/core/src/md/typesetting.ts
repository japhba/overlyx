/**
 * A markdown document's typesetting, set in its YAML front matter: pandoc's variables where pandoc
 * has one, so the file comes out alike with `pandoc --pdf-engine=lualatex`, and `headings`, OverLyX's:
 *
 *   mainfont, sansfont, monofont, mathfont   OpenType fonts by name (fontspec, unicode-math); the
 *                                            settings dialog offers MD_FONTS, each with its math font
 *   fontsize: 11pt         papersize: a4        geometry: margin=2cm (or a list of geometry's options)
 *   linestretch: 1.25      numbersections: true      justify: true (OverLyX's; ragged right without)
 *   headings               how headings are set (titlesec; the editor draws them alike): `run-in`, or
 *                          keys for every level — display (block | run-in), font, size (small | normal
 *                          | large | larger | huge), weight (bold | normal), shape (upright | italic),
 *                          case (normal | smallcaps | uppercase), color (#rrggbb), align (left |
 *                          center), rule (none | below | above), space-above / space-below (a
 *                          length: 0.5ex, 4pt, 1em) — and under section: … paragraph: a
 *                          level's own (`section: { size: larger, rule: below }`)
 *   header-includes        LaTeX for the preamble, after all of the above
 *
 * Parsing a markdown document turns these into its settings (header lines: the editor shows the
 * fonts, the numbering and the run-in headings; `applyTypesetting`), and its PDF's preamble gets the
 * rest (`typesettingPreamble`, md/latex.ts). Document ▸ Settings writes them (`setFrontMatter`),
 * leaving the rest of the front matter — keys of other tools, comments — as it was. They are plain
 * keys, safe to edit by hand: nothing in the file is generated.
 */
import type { Header } from '../lyx/ast.ts';
import { markdownHeader } from './common.ts';

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

const unquote = (v: string) => v.trim().replace(/^(['"])(.*)\1$/, '$2');
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

/** the heading levels a markdown document has (# … ####), as their LaTeX commands */
export const HEADING_LEVELS = ['section', 'subsection', 'subsubsection', 'paragraph'] as const;
export type HeadingLevel = typeof HEADING_LEVELS[number];
/** how a heading is set (each key optional: the level's default) */
export interface HeadingStyle {
  display?: 'block' | 'run-in';
  font?: string;
  size?: 'small' | 'normal' | 'large' | 'larger' | 'huge';
  weight?: 'bold' | 'normal';
  shape?: 'upright' | 'italic';
  case?: 'normal' | 'smallcaps' | 'uppercase';
  color?: string;
  align?: 'left' | 'center';
  rule?: 'none' | 'below' | 'above';
  /** the space above / below the heading (front matter `space-above` / `space-below`): a length, ex em pt mm cm (a plain number: em) */
  spaceAbove?: string;
  spaceBelow?: string;
}
/** each level's style: `headings`' own keys for all levels, then the level's */
export type HeadingStyles = Record<HeadingLevel, HeadingStyle>;

const HEADING_CHOICES: { [K in Exclude<keyof HeadingStyle, 'spaceAbove' | 'spaceBelow'>]-?: readonly string[] | null } = {
  display: ['block', 'run-in'], font: null, size: ['small', 'normal', 'large', 'larger', 'huge'], weight: ['bold', 'normal'],
  shape: ['upright', 'italic'], case: ['normal', 'smallcaps', 'uppercase'], color: null, align: ['left', 'center'], rule: ['none', 'below', 'above'],
};
function headingStyleOf(v: FMValue | undefined): HeadingStyle {
  const out: HeadingStyle = {};
  if (!v || typeof v === 'string' || Array.isArray(v)) return out;
  // a length LaTeX and CSS both take
  for (const [key, prop] of [['space-above', 'spaceAbove'], ['space-below', 'spaceBelow']] as const) {
    const m = typeof v[key] === 'string' ? /^\s*(\d{1,2}(?:\.\d{1,3})?)\s*(ex|em|pt|mm|cm)?\s*$/.exec(v[key] as string) : null;
    if (m) out[prop] = m[1] + (m[2] ?? 'em');
  }
  for (const k of Object.keys(HEADING_CHOICES) as (keyof typeof HEADING_CHOICES)[]) {
    const raw = v[k];
    if (typeof raw !== 'string') continue;
    const val = raw.trim(), choices = HEADING_CHOICES[k];
    if (k === 'font') { if (fontName(val)) out.font = fontName(val); continue; }
    if (k === 'color') { const c = /^#?([0-9a-fA-F]{6})$/.exec(val); if (c) out.color = '#' + c[1].toLowerCase(); continue; }
    if (choices!.includes(val.toLowerCase())) (out as Record<string, string>)[k] = val.toLowerCase();
  }
  return out;
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
  // (the editor justifies on \overlyx_justify: a .tex document's \justification true is LaTeX's default, not a choice)
  if (t.justify) { set('justification', 'true'); set('overlyx_justify', 'true'); }
  if (t.mainfont || t.sansfont || t.monofont) {
    set('use_non_tex_fonts', 'true');
    if (t.mainfont) set('font_roman', `"default" "${t.mainfont}"`);
    if (t.sansfont) set('font_sans', `"default" "${t.sansfont}"`);
    if (t.monofont) set('font_typewriter', `"default" "${t.monofont}"`);
  }
  // (OverLyX's own: the LyX export leaves \overlyx_ lines out; the editor draws its headings so)
  if (t.headings) set('overlyx_headings', JSON.stringify(t.headings));
}

/** the header keys the typesetting decides */
const TYPESET_KEYS = ['papersize', 'paperfontsize', 'spacing', 'secnumdepth', 'use_non_tex_fonts', 'font_roman', 'font_sans', 'font_typewriter', 'overlyx_headings', 'justification', 'overlyx_justify'];

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

/** the PDF's preamble for what the header does not say: margins, the math font, run-in headings, header-includes */
export function typesettingPreamble(t: MdTypesetting): string[] {
  const out: string[] = [];
  if (t.geometry.length) out.push(`\\usepackage[${t.geometry.join(',')}]{geometry}`);
  // (unicode-math after amsmath, which the generated block would load after this)
  if (t.mathfont) out.push('\\usepackage{amsmath}', '\\usepackage{unicode-math}', `\\setmathfont{${t.mathfont}}`);
  if (t.headings) out.push(...headingsLatex(t.headings));
  out.push(...t.headerIncludes);
  return out;
}

/** LaTeX's own look of each level (article): its size, and whether it runs in */
const LEVEL_DEFAULTS: Record<HeadingLevel, { size: NonNullable<HeadingStyle['size']>; display: 'block' | 'run-in'; above: string; below: string }> = {
  section: { size: 'larger', display: 'block', above: '3.5ex plus 1ex minus .2ex', below: '2.3ex plus .2ex' },
  subsection: { size: 'large', display: 'block', above: '3.25ex plus 1ex minus .2ex', below: '1.5ex plus .2ex' },
  subsubsection: { size: 'normal', display: 'block', above: '3.25ex plus 1ex minus .2ex', below: '1.5ex plus .2ex' },
  paragraph: { size: 'normal', display: 'run-in', above: '3.25ex plus 1ex minus .2ex', below: '1em' },
};
const SIZE_CMD = { small: '\\small', normal: '\\normalsize', large: '\\large', larger: '\\Large', huge: '\\LARGE' } as const;

/** titlesec for the heading styles (a run-in heading at the text's size unless it says otherwise) */
function headingsLatex(styles: HeadingStyles): string[] {
  const out = ['\\usepackage{titlesec}'];
  if (HEADING_LEVELS.some(l => styles[l].color)) out.push('\\usepackage{xcolor}');
  const fonts = [...new Set(HEADING_LEVELS.map(l => styles[l].font).filter((f): f is string => !!f))];
  fonts.forEach((f, k) => out.push(`\\newfontfamily\\olheadingfont${'abcdefgh'[k]}{${f}}`));
  for (const level of HEADING_LEVELS) {
    const st = styles[level], def = LEVEL_DEFAULTS[level];
    const runIn = (st.display ?? def.display) === 'run-in';
    const size = st.size ?? (runIn ? 'normal' : def.size);
    let format = '\\normalfont';
    if (st.font) format += `\\olheadingfont${'abcdefgh'[fonts.indexOf(st.font)]}`;
    format += SIZE_CMD[size];
    if ((st.weight ?? 'bold') === 'bold') format += '\\bfseries';
    if (st.shape === 'italic') format += '\\itshape';
    if (st.case === 'smallcaps') format += '\\scshape';
    if (st.color) format += `\\color[HTML]{${st.color.slice(1).toUpperCase()}}`;
    const center = !runIn && st.align === 'center';
    if (center) format += '\\filcenter';
    if (!runIn && st.rule === 'above') format = `\\titlerule\\vspace{.8ex}${format}`;
    const shape = runIn ? 'runin' : center || st.rule === 'above' ? 'block' : 'hang';
    // (the title is the argument of the last command of "before")
    const before = st.case === 'uppercase' ? '\\MakeUppercase' : '';
    const after = !runIn && st.rule === 'below' ? '[\\vspace{.4ex}\\titlerule]' : '';
    out.push(`\\titleformat{\\${level}}[${shape}]{${format}}{\\the${level}}{${runIn ? '0.6em' : '1em'}}{${before}}${after}`);
    // (a length given is kept to, with a little stretch above; run in, the space after is the gap before the text)
    const above = st.spaceAbove ? `${st.spaceAbove} plus .2ex` : runIn ? '1.6ex plus .3ex minus .2ex' : def.above;
    out.push(`\\titlespacing*{\\${level}}{0pt}{${above}}{${runIn ? '0.8em' : st.spaceBelow ?? def.below}}`);
  }
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
