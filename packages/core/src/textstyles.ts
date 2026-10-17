/**
 * Text styles: how each kind of text looks — the title, the four heading levels, body text, quotes —
 * as Google Docs' and Word's styles do it: font (a family, or a font by name with its axes and
 * features: fontface.ts), size, weight, italics, small capitals / capitals, colour, alignment, a rule,
 * the space above and below, a heading that runs into its paragraph. One model for the editor (its
 * CSS: client editor/paragraphsep.ts) and the PDF (`stylesLatex`: titlesec, titling, etoolbox), for
 * markdown documents (front matter `headings:` and `styles:`, md/typesetting.ts) and .tex documents
 * (the settings line's `overlyx_styles`, written into the managed block) alike. The header line
 * `\overlyx_styles {json}` carries them to the editor.
 *
 * `stylesFromIncludes` reads the commonest LaTeX that sets the same things by hand (an agent's or a
 * person's `header-includes`: `\justifying`, titlesec's \titleformat / \titlespacing, a patched
 * \@maketitle), so the editor shows what that PDF will look like; editing such a style in the style
 * editor takes it over (`takeOverIncludes`).
 */
import { parseFace, validFontFamily } from './fontface.ts';

export const HEADING_LEVELS = ['section', 'subsection', 'subsubsection', 'paragraph'] as const;
export type HeadingLevel = typeof HEADING_LEVELS[number];
export const TEXT_TYPES = ['title', 'section', 'subsection', 'subsubsection', 'paragraph', 'body', 'quote'] as const;
export type TextType = typeof TEXT_TYPES[number];

/** the paragraph layouts (LyX's names) each type is */
export const TYPE_LAYOUTS: Record<TextType, string[]> = {
  title: ['Title'], section: ['Section', 'Section*'], subsection: ['Subsection', 'Subsection*'], subsubsection: ['Subsubsection', 'Subsubsection*'],
  paragraph: ['Paragraph', 'Paragraph*'], body: ['Standard'], quote: ['Quote', 'Quotation'],
};
export const typeOfLayout = (layout: string): TextType | null => TEXT_TYPES.find(t => TYPE_LAYOUTS[t].includes(layout)) ?? null;

/** how a kind of text is set (each key optional: the document's default) */
export interface TextStyle {
  /** headings: on a line of their own, or running into the paragraph after */
  display?: 'block' | 'run-in';
  /** a family name ("Fira Sans"), or a font by name with axes / features (fontface.ts: `Inter|300`) */
  font?: string;
  /** small | normal | large | larger | huge (LaTeX's \small … \LARGE), or points: `14pt` */
  size?: string;
  weight?: 'bold' | 'normal';
  shape?: 'upright' | 'italic';
  case?: 'normal' | 'smallcaps' | 'uppercase';
  /** #rrggbb */
  color?: string;
  align?: 'left' | 'center' | 'right' | 'justify';
  rule?: 'none' | 'below' | 'above';
  /** a length: ex em pt mm cm (a plain number: em) */
  spaceAbove?: string;
  spaceBelow?: string;
}
export type TextStyles = Partial<Record<TextType, TextStyle>>;

export const NAMED_SIZES = ['small', 'normal', 'large', 'larger', 'huge'] as const;
/** a named size against the text's (CSS em; LaTeX's at 10 pt: 9, 10, 12, 14.4, 17.28) */
export const SIZE_EM: Record<string, number> = { small: 0.9, normal: 1, large: 1.2, larger: 1.44, huge: 1.728 };
const SIZE_CMD: Record<string, string> = { small: '\\small', normal: '\\normalsize', large: '\\large', larger: '\\Large', huge: '\\LARGE' };

const CHOICES: Partial<Record<keyof TextStyle, readonly string[]>> = {
  display: ['block', 'run-in'], weight: ['bold', 'normal'], shape: ['upright', 'italic'], case: ['normal', 'smallcaps', 'uppercase'],
  align: ['left', 'center', 'right', 'justify'], rule: ['none', 'below', 'above'],
};

/** a font name as fontspec takes it, or a font by name (`Inter|300`) — '' when it is neither */
export function styleFont(v: string): string {
  const s = v.trim();
  if (/^[\p{L}\p{N} ._+-]{1,80}$/u.test(s)) return s;
  return s.includes('|') && parseFace(s) && validFontFamily(s.split('|')[0]) ? s : '';
}
/** a length LaTeX and CSS both take (a plain number: em) */
export function styleLength(v: string): string {
  const m = /^\s*(\d{1,2}(?:\.\d{1,3})?)\s*(ex|em|pt|mm|cm)?\s*$/.exec(v);
  return m ? m[1] + (m[2] ?? 'em') : '';
}
/** a size: a named one, or 4 … 96 points */
export function styleSize(v: string): string {
  const s = v.trim().toLowerCase();
  if ((NAMED_SIZES as readonly string[]).includes(s)) return s;
  const m = /^(\d{1,2}(?:\.\d{1,2})?)\s*pt$/.exec(s);
  return m && Number(m[1]) >= 4 && Number(m[1]) <= 96 ? `${Number(m[1])}pt` : '';
}

/** A style from keys as the front matter or a JSON object give them (`space-above` or `spaceAbove`); what is not valid is left out. */
export function textStyleOf(v: unknown): TextStyle {
  const out: TextStyle = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  const o = v as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : typeof o[k] === 'number' ? String(o[k]) : undefined);
  for (const [a, b, prop] of [['space-above', 'spaceAbove', 'spaceAbove'], ['space-below', 'spaceBelow', 'spaceBelow']] as const) {
    const raw = str(a) ?? str(b);
    const len = raw === undefined ? '' : styleLength(raw);
    if (len) out[prop] = len;
  }
  const font = str('font'), size = str('size'), color = str('color');
  if (font && styleFont(font)) out.font = styleFont(font);
  if (size && styleSize(size)) out.size = styleSize(size);
  if (color) { const c = /^#?([0-9a-fA-F]{6})$/.exec(color.trim()); if (c) out.color = '#' + c[1].toLowerCase(); }
  for (const [k, choices] of Object.entries(CHOICES) as [keyof TextStyle, readonly string[]][]) {
    const raw = str(k);
    if (raw !== undefined && choices.includes(raw.trim().toLowerCase())) (out as Record<string, string>)[k] = raw.trim().toLowerCase();
  }
  return out;
}

/** the styles of a header line's JSON (`\overlyx_styles {…}`), only what is valid */
export function parseStyles(json: string | null | undefined): TextStyles {
  const out: TextStyles = {};
  if (!json) return out;
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return out; }
  if (!raw || typeof raw !== 'object') return out;
  for (const t of TEXT_TYPES) {
    const st = textStyleOf((raw as Record<string, unknown>)[t]);
    if (Object.keys(st).length) out[t] = st;
  }
  return out;
}

/** the styles of a header (`\overlyx_styles`) */
export function stylesOfHeader(headerLines: readonly string[]): TextStyles {
  return parseStyles(headerLines.find(l => l.startsWith('\\overlyx_styles '))?.slice(16));
}

/** what a style sets beyond the document's default, compactly (empty styles dropped) */
export function stylesJson(styles: TextStyles): string {
  const out: Record<string, TextStyle> = {};
  for (const t of TEXT_TYPES) { const st = styles[t]; if (st && Object.keys(st).length) out[t] = st; }
  return JSON.stringify(out);
}

/** `b` over `a`, type by type and key by key */
export function mergeStyles(a: TextStyles, b: TextStyles): TextStyles {
  const out: TextStyles = {};
  for (const t of TEXT_TYPES) { const st = { ...(a[t] ?? {}), ...(b[t] ?? {}) }; if (Object.keys(st).length) out[t] = st; }
  return out;
}

/* ------------------------------------------------------------------ LaTeX */

/** LaTeX's own look of each heading level (article): its size, and whether it runs in */
const LEVEL_DEFAULTS: Record<HeadingLevel, { size: string; display: 'block' | 'run-in'; above: string; below: string }> = {
  section: { size: 'larger', display: 'block', above: '3.5ex plus 1ex minus .2ex', below: '2.3ex plus .2ex' },
  subsection: { size: 'large', display: 'block', above: '3.25ex plus 1ex minus .2ex', below: '1.5ex plus .2ex' },
  subsubsection: { size: 'normal', display: 'block', above: '3.25ex plus 1ex minus .2ex', below: '1.5ex plus .2ex' },
  paragraph: { size: 'normal', display: 'run-in', above: '3.25ex plus 1ex minus .2ex', below: '1em' },
};

export const headingDisplay = (level: HeadingLevel, st: TextStyle | undefined) => st?.display ?? LEVEL_DEFAULTS[level].display;

function sizeLatex(size: string): string {
  if (SIZE_CMD[size]) return SIZE_CMD[size];
  const pt = parseFloat(size);
  return `\\fontsize{${pt}}{${Math.round(pt * 12) / 10}}\\selectfont`;
}

/** the font switch: \olfontset[axes][features]{Family} (fontface.ts OLFONT_DEF) */
function fontLatex(font: string): string {
  if (!font.includes('|')) return `\\olfontset{${font}}`;
  const f = parseFace(font);
  if (!f) return '';
  const p = font.split('|');
  return `\\olfontset${p[1] || p[2] ? `[${p[1] ?? ''}]` : ''}${p[2] ? `[${p[2]}]` : ''}{${f.family}}`;
}

/** the declarations a style's font, size, weight, shape, case and colour amount to */
function formatLatex(st: TextStyle, size: string | undefined, weight: 'bold' | 'normal' | undefined): string {
  let f = '';
  if (st.font) f += fontLatex(st.font);
  if (size) f += sizeLatex(size);
  if (weight === 'bold') f += '\\bfseries';
  else if (weight === 'normal') f += '\\mdseries';
  if (st.shape === 'italic') f += '\\itshape';
  else if (st.shape === 'upright') f += '\\upshape';
  if (st.case === 'smallcaps') f += '\\scshape';
  if (st.color) f += `\\color[HTML]{${st.color.slice(1).toUpperCase()}}`;
  return f;
}

/** does any style name a font (the preamble then needs \olfontset: OLFONT_DEF) */
export const stylesUseFonts = (styles: TextStyles) => TEXT_TYPES.some(t => !!styles[t]?.font);

/**
 * The preamble LaTeX for the styles: titlesec for the headings, titling for the title, etoolbox for
 * quotes, the body's colour. Body font, size and alignment are the document's own settings
 * (markdown: mainfont / fontsize / justify; .tex: Document ▸ Settings) and not set here.
 * Fonts use \olfontset: the caller provides OLFONT_DEF.
 */
export function stylesLatex(styles: TextStyles): string[] {
  const out: string[] = [];
  const anyColor = TEXT_TYPES.some(t => styles[t]?.color);
  if (anyColor) out.push('\\usepackage{xcolor}');
  // headings
  if (HEADING_LEVELS.some(l => styles[l] && Object.keys(styles[l]!).length)) {
    out.push('\\usepackage{titlesec}');
    for (const level of HEADING_LEVELS) {
      const st = styles[level] ?? {}, def = LEVEL_DEFAULTS[level];
      if (!Object.keys(st).length) continue;
      const runIn = (st.display ?? def.display) === 'run-in';
      const size = st.size ?? (runIn ? 'normal' : def.size);
      let format = '\\normalfont' + formatLatex(st, size, st.weight ?? 'bold');
      const align = runIn ? 'left' : st.align ?? 'left';
      if (align === 'center') format += '\\filcenter';
      else if (align === 'right') format += '\\filleft';
      if (!runIn && st.rule === 'above') format = `\\titlerule\\vspace{.8ex}${format}`;
      const shape = runIn ? 'runin' : align !== 'left' || st.rule === 'above' ? 'block' : 'hang';
      // (the title is the argument of the last command of "before")
      const before = st.case === 'uppercase' ? '\\MakeUppercase' : '';
      const after = !runIn && st.rule === 'below' ? '[\\vspace{.4ex}\\titlerule]' : '';
      out.push(`\\titleformat{\\${level}}[${shape}]{${format}}{\\the${level}}{${runIn ? '0.6em' : '1em'}}{${before}}${after}`);
      // (a length given is kept to, with a little stretch above; run in, the space after is the gap before the text)
      const above = st.spaceAbove ? `${st.spaceAbove} plus .2ex` : runIn ? '1.6ex plus .3ex minus .2ex' : def.above;
      out.push(`\\titlespacing*{\\${level}}{0pt}{${above}}{${runIn ? '0.8em' : st.spaceBelow ?? def.below}}`);
    }
  }
  // the title (\maketitle): titling's hooks around it
  const ti = styles.title;
  if (ti && Object.keys(ti).length) {
    const env = ti.align === 'left' ? 'flushleft' : ti.align === 'right' ? 'flushright' : 'center';
    out.push('\\usepackage{titling}');
    // (\MakeUppercase last: the title follows it, as titling sets \@title right after \pretitle)
    out.push(`\\pretitle{${ti.spaceAbove ? `\\vspace*{${ti.spaceAbove}}` : ''}\\begin{${env}}${ti.rule === 'above' ? '\\hrule\\vspace{.6em}' : ''}${formatLatex(ti, ti.size ?? 'huge', ti.weight)}${ti.case === 'uppercase' ? '\\MakeUppercase' : ''}}`);
    out.push(`\\posttitle{\\par${ti.rule === 'below' ? '\\vspace{.4em}\\hrule' : ''}\\end{${env}}${ti.spaceBelow ? `\\vspace{${ti.spaceBelow}}` : '\\vskip 0.5em'}}`);
  }
  // quotes
  const q = styles.quote;
  if (q && Object.keys(q).length) {
    out.push('\\usepackage{etoolbox}');
    let f = formatLatex(q, q.size, q.weight);
    if (q.align === 'center') f += '\\centering';
    else if (q.align === 'right') f += '\\raggedleft';
    else if (q.align === 'left') f += '\\raggedright';
    for (const env of ['quote', 'quotation']) out.push(`\\AtBeginEnvironment{${env}}{${f}${q.spaceAbove ? `\\vspace{${q.spaceAbove}}` : ''}}`);
  }
  // the body's colour (headings, quotes and the title set their own above)
  const body = styles.body;
  if (body?.color) out.push(`\\AtBeginDocument{\\color[HTML]{${body.color.slice(1).toUpperCase()}}}`);
  return out;
}

/* ------------------------------------------------------------------ LaTeX written by hand */

const SIZE_OF_CMD: Record<string, string> = { '\\small': 'small', '\\footnotesize': 'small', '\\normalsize': 'normal', '\\large': 'large', '\\Large': 'larger', '\\LARGE': 'huge', '\\huge': '20.74pt', '\\Huge': '24.88pt' };

/** the groups `{…}` (and optional `[…]`) after `at`: [content, end] */
function args(s: string, at: number, count: number): { list: { opt: boolean; text: string }[]; end: number } {
  const list: { opt: boolean; text: string }[] = [];
  let i = at;
  while (list.filter(a => !a.opt).length < count && i < s.length) {
    while (s[i] === ' ' || s[i] === '*') i++;
    const open = s[i];
    if (open !== '{' && open !== '[') break;
    const close = open === '{' ? '}' : ']';
    let depth = 0, j = i;
    for (; j < s.length; j++) {
      if (s[j] === '\\') { j++; continue; }
      if (s[j] === open) depth++;
      else if (s[j] === close && --depth === 0) break;
    }
    list.push({ opt: open === '[', text: s.slice(i + 1, j) });
    i = j + 1;
  }
  // an optional argument right after (titlesec's [after])
  while (s[i] === ' ') i++;
  if (s[i] === '[') { const j = s.indexOf(']', i); if (j > 0) { list.push({ opt: true, text: s.slice(i + 1, j) }); i = j + 1; } }
  return { list, end: i };
}

function formatOf(tokens: string, st: TextStyle): void {
  for (const m of tokens.matchAll(/\\(small|footnotesize|normalsize|large|Large|LARGE|huge|Huge)\b/g)) st.size = SIZE_OF_CMD['\\' + m[1]];
  if (/\\bfseries\b|\\textbf\b/.test(tokens)) st.weight = 'bold';
  else if (/\\(mdseries|normalfont)\b/.test(tokens)) st.weight = 'normal';
  if (/\\itshape\b|\\slshape\b/.test(tokens)) st.shape = 'italic';
  if (/\\scshape\b/.test(tokens)) st.case = 'smallcaps';
  const c = /\\color(?:\[HTML\])?\{#?([0-9a-fA-F]{6})\}/.exec(tokens);
  if (c) st.color = '#' + c[1].toLowerCase();
  if (/\\(centering|filcenter)\b/.test(tokens)) st.align = 'center';
  else if (/\\(raggedleft|filleft)\b/.test(tokens)) st.align = 'right';
}

/**
 * What hand-written preamble LaTeX (`header-includes`) does to the looks the styles describe — for
 * the editor to show it (the PDF has the LaTeX itself): `\justifying` (ragged2e), titlesec's
 * \titleformat / \titlespacing for the four levels, and \@maketitle patched to another size.
 */
export function stylesFromIncludes(lines: readonly string[]): { styles: TextStyles; justify: boolean } {
  const styles: TextStyles = {};
  const text = lines.join('\n');
  const justify = /\\justifying\b/.test(text);
  for (const m of text.matchAll(/\\titleformat\*?\s*\{\\(section|subsection|subsubsection|paragraph)\}/g)) {
    const level = m[1] as HeadingLevel;
    const a = args(text, m.index! + m[0].length, 4);
    const st: TextStyle = { ...(styles[level] ?? {}) };
    const shape = a.list[0]?.opt ? a.list[0].text.trim() : '';
    const rest = a.list.filter((x, k) => !(k === 0 && x.opt));
    if (shape === 'runin') st.display = 'run-in';
    else if (shape) st.display = 'block';
    if (rest[0]) formatOf(rest[0].text, st);
    const after = rest.length > 4 ? rest[4] : null;
    if (after && /\\titlerule/.test(after.text)) st.rule = 'below';
    if (rest[3] && /\\MakeUppercase/.test(rest[3].text)) st.case = 'uppercase';
    styles[level] = st;
  }
  for (const m of text.matchAll(/\\titlespacing\*?\s*\{\\(section|subsection|subsubsection|paragraph)\}/g)) {
    const level = m[1] as HeadingLevel;
    const a = args(text, m.index! + m[0].length, 3).list.filter(x => !x.opt);
    const st: TextStyle = { ...(styles[level] ?? {}) };
    const first = (x?: { text: string }) => (x ? styleLength(x.text.trim().split(/\s+/)[0] ?? '') : '');
    if (first(a[1])) st.spaceAbove = first(a[1]);
    if (first(a[2])) st.spaceBelow = first(a[2]);
    styles[level] = st;
  }
  const mt = /\\patchcmd\s*\{\\@maketitle\}\s*\{\\LARGE\}\s*\{(\\[A-Za-z]+)\}/.exec(text);
  if (mt && SIZE_OF_CMD[mt[1]]) styles.title = { size: SIZE_OF_CMD[mt[1]] };
  return { styles, justify };
}

/**
 * The header-includes without the hand-written LaTeX that set what `types` now say (a style edited
 * in the style editor takes over from it): their \titleformat / \titlespacing lines, the title's
 * \@maketitle patch, and — for the body — `\justifying` (with the ragged2e it needed, when nothing
 * else uses it).
 */
export function takeOverIncludes(lines: readonly string[], types: readonly TextType[]): string[] {
  const levels = HEADING_LEVELS.filter(l => types.includes(l));
  return lines.filter(l => {
    for (const level of levels) if (new RegExp(`^\\s*\\\\title(format|spacing)\\*?\\s*\\{\\\\${level}\\}`).test(l)) return false;
    if (types.includes('title') && /\\patchcmd\s*\{\\@maketitle\}\s*\{\\LARGE\}/.test(l)) return false;
    if (types.includes('body') && /^\s*(\\AtBeginDocument\{\\justifying\}|\\justifying)\s*$/.test(l)) return false;
    return true;
  }).filter((l, _i, all) => !(types.includes('body') && /^\s*\\usepackage\{ragged2e\}\s*$/.test(l) && !all.some(x => /\\(justifying|RaggedRight|Centering|RaggedLeft|FlushLeft|FlushRight)\b/.test(x))));
}
