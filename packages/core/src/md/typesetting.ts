/**
 * A markdown document's typesetting, set in its YAML front matter: pandoc's variables where pandoc
 * has one, so the file comes out alike with `pandoc --pdf-engine=lualatex`, and `headings`, OverLyX's:
 *
 *   mainfont, sansfont, monofont, mathfont   OpenType fonts by name (fontspec, unicode-math); the
 *                                            settings dialog offers MD_FONTS, each with its math font
 *   fontsize: 11pt         papersize: a4        geometry: margin=2cm (or a list of geometry's options)
 *   linestretch: 1.25      numbersections: true
 *   headings: run-in       section headings run into their paragraph (titlesec)
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

/**
 * The front matter's top-level keys (`---` … `---` / `...`): a value, a list (`[a, b]` or `- a` lines)
 * or a block (`|` / `>` and indented lines). Enough YAML for pandoc's variables; quotes are taken off.
 */
export function frontMatterVars(lines: string[]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  if (!/^---\s*$/.test(lines[0] ?? '')) return out;
  const unquote = (v: string) => v.trim().replace(/^(['"])(.*)\1$/, '$2');
  let key: string | null = null, block = false;
  for (const line of lines.slice(1)) {
    if (/^(---|\.\.\.)\s*$/.test(line)) break;
    const top = /^([A-Za-z][\w-]*):\s*(.*?)\s*$/.exec(line);
    if (top) {
      key = top[1]; block = false;
      const v = top[2].replace(/\s+#.*$/, '');
      if (v === '|' || v === '>' || v === '|-' || v === '>-') { out[key] = []; block = true; }
      else if (/^\[.*\]$/.test(v)) out[key] = v.slice(1, -1).split(',').map(unquote).filter(Boolean);
      else out[key] = v ? unquote(v) : [];
      continue;
    }
    if (!key || !Array.isArray(out[key])) continue;
    const arr = out[key] as string[];
    const item = block ? null : /^\s+-\s+(.*)$/.exec(line);
    // `- |`: a block of lines as the item (pandoc's header-includes)
    if (item && /^[|>]-?$/.test(item[1].trim())) { block = true; continue; }
    if (item) { arr.push(unquote(item[1])); continue; }
    const text = /^\s+(.*)$/.exec(line);
    // (a raw-LaTeX fence round them, as pandoc's examples write it, is not LaTeX)
    if (text && block && !/^```/.test(text[1])) arr.push(text[1]);
  }
  return out;
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
  headings: 'block' | 'run-in';
  headerIncludes: string[];
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() ?? '';
const list = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? v.split(/,\s*/) : []).map(x => x.trim()).filter(Boolean);
/** a font name as fontspec takes it (no braces, backslashes or the like) */
const fontName = (v: string | string[] | undefined) => { const s = one(v); return /^[\p{L}\p{N} ._+-]{1,80}$/u.test(s) ? s : ''; };

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
    headings: one(v.headings).toLowerCase() === 'run-in' ? 'run-in' : 'block',
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
  if (t.mainfont || t.sansfont || t.monofont) {
    set('use_non_tex_fonts', 'true');
    if (t.mainfont) set('font_roman', `"default" "${t.mainfont}"`);
    if (t.sansfont) set('font_sans', `"default" "${t.sansfont}"`);
    if (t.monofont) set('font_typewriter', `"default" "${t.monofont}"`);
  }
  // (OverLyX's own: the LyX export leaves \overlyx_ lines out)
  if (t.headings === 'run-in') set('overlyx_headings', 'run-in');
}

/** the header keys the typesetting decides */
const TYPESET_KEYS = ['papersize', 'paperfontsize', 'spacing', 'secnumdepth', 'use_non_tex_fonts', 'font_roman', 'font_sans', 'font_typewriter', 'overlyx_headings'];

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
  if (t.headings === 'run-in') {
    out.push('\\usepackage{titlesec}');
    for (const [cmd, shape, above, after] of [['section', '\\bfseries', '1.6ex', '0.8em'], ['subsection', '\\bfseries', '1.3ex', '0.7em'], ['subsubsection', '\\bfseries\\itshape', '1.1ex', '0.6em'], ['paragraph', '\\itshape', '0.9ex', '0.6em']]) {
      out.push(`\\titleformat{\\${cmd}}[runin]{\\normalfont${shape}}{\\the${cmd}}{0.6em}{}`, `\\titlespacing*{\\${cmd}}{0pt}{${above} plus .3ex minus .2ex}{${after}}`);
    }
  }
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
export function setFrontMatter(lines: string[], values: Record<string, string | string[] | boolean | number | null>): string[] {
  const has = /^---\s*$/.test(lines[0] ?? '');
  let end = has ? lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l)) : -1;
  const body = has && end > 0 ? lines.slice(1, end) : [];
  const closing = has && end > 0 ? lines[end] : '---';
  const render = (key: string, v: string | string[] | boolean | number): string[] =>
    Array.isArray(v) ? [`${key}:`, ...v.map(x => `  - ${yamlScalar(x)}`)] : [`${key}: ${typeof v === 'string' ? yamlScalar(v) : String(v)}`];
  for (const [key, v] of Object.entries(values)) {
    const at = body.findIndex(l => l.startsWith(key + ':') && /^\s*$|^\s/.test(l.slice(key.length + 1)));
    let to = at;
    if (at >= 0) while (to + 1 < body.length && (/^\s/.test(body[to + 1]) || body[to + 1] === '')) to++;
    const repl = v === null || v === '' || (Array.isArray(v) && !v.length) ? [] : render(key, v);
    if (at >= 0) body.splice(at, to - at + 1, ...repl);
    else body.push(...repl);
  }
  while (body.length && body[body.length - 1] === '') body.pop();
  if (!body.some(l => l.trim())) return [];
  return ['---', ...body, closing];
}
