/**
 * Text styles: how each kind of text looks — the title, the four heading levels, normal text,
 * quotes — as Google Docs' and Word's styles do it: font (a family, a font by name with its axes and
 * features: fontface.ts, or the document's serif / sans serif / monospace), weight (100–900), size,
 * italics, small capitals / capitals, colour, alignment, the body's line spacing, a rule, the space
 * above and below, a heading that runs into its paragraph.
 *
 * Three layers, the later winning:
 *
 *   document   the file's own settings — a markdown document's front matter (`headings:`, `styles:`,
 *              pandoc's mainfont / fontsize / linestretch / justify), a .tex document's settings line
 *              (`overlyx_styles`, written into the managed block as LaTeX, and Document ▸ Settings'
 *              paperfontsize / spacing / justification / fonts). The PDF and everyone's editor follow it.
 *   LaTeX      what the preamble's own LaTeX sets (a markdown document's header-includes, a .tex
 *              file's preamble — written by hand or by an agent): `readTexStyles`. LaTeX says more than
 *              these keys can, so in the PDF it has the last word — OverLyX leaves out its own LaTeX
 *              for what the preamble sets (`stylesLatex`'s `tex`) — and the editor shows what it can
 *              read of it. Setting the same thing in the style editor replaces that LaTeX: `takeOver`
 *              names the statements to remove and the values they set, which the document keeps.
 *   my editor  one person's own (the client's preferences): only their editor shows it, never the PDF.
 *
 *     PDF    = the class's look ⊕ document ⊕ LaTeX          (`pdfStyles`)
 *     editor = PDF ⊕ my editor                              (`mergeStyles`)
 *
 * The header line `\overlyx_styles {json}` carries the document layer's styles to the editor (a
 * markdown document's header also `\overlyx_includes`, its header-includes; a .tex document's
 * preamble is its header's \begin_preamble block): `styleLayers`.
 */
import { parseFace, faceValue, validFontFamily } from './fontface.ts';

export const HEADING_LEVELS = ['section', 'subsection', 'subsubsection', 'paragraph'] as const;
export type HeadingLevel = typeof HEADING_LEVELS[number];
export const TEXT_TYPES = ['title', 'section', 'subsection', 'subsubsection', 'paragraph', 'body', 'quote'] as const;
export type TextType = typeof TEXT_TYPES[number];
export const isHeading = (t: TextType): t is HeadingLevel => (HEADING_LEVELS as readonly string[]).includes(t);

/** the paragraph layouts (LyX's names) each type is */
export const TYPE_LAYOUTS: Record<TextType, string[]> = {
  title: ['Title'], section: ['Section', 'Section*'], subsection: ['Subsection', 'Subsection*'], subsubsection: ['Subsubsection', 'Subsubsection*'],
  paragraph: ['Paragraph', 'Paragraph*'], body: ['Standard'], quote: ['Quote', 'Quotation'],
};
export const typeOfLayout = (layout: string): TextType | null => TEXT_TYPES.find(t => TYPE_LAYOUTS[t].includes(layout)) ?? null;

/** how a kind of text is set (each key optional: the layer below decides) */
export interface TextStyle {
  /** headings: on a line of their own, or running into the paragraph after */
  display?: 'block' | 'run-in';
  /**
   * a family name ("Fira Sans"), a font by name with axes / features (fontface.ts: `Inter|wdth=90|+onum`;
   * its weight is `weight`), or the document's own families: `@serif`, `@sans`, `@mono`
   */
  font?: string;
  /** small | normal | large | larger | huge (LaTeX's \small … \LARGE), or points: `14pt` */
  size?: string;
  /** 100 (thin) … 400 (regular) … 700 (bold) … 900 (black); any value a variable font takes */
  weight?: number;
  shape?: 'upright' | 'italic';
  case?: 'normal' | 'smallcaps' | 'uppercase';
  /** #rrggbb */
  color?: string;
  align?: 'left' | 'center' | 'right' | 'justify';
  rule?: 'none' | 'below' | 'above';
  /** a length: ex em pt mm cm (a plain number: em) */
  spaceAbove?: string;
  spaceBelow?: string;
  /** normal text: the line spacing, a multiple of single spacing (setspace's \setstretch; LaTeX's one-and-a-half is 1.25, double 1.667) */
  lineSpacing?: number;
}
export type StyleKey = keyof TextStyle;
export type TextStyles = Partial<Record<TextType, TextStyle>>;
export const STYLE_KEYS: StyleKey[] = ['display', 'font', 'size', 'weight', 'shape', 'case', 'color', 'align', 'rule', 'spaceAbove', 'spaceBelow', 'lineSpacing'];

export const NAMED_SIZES = ['small', 'normal', 'large', 'larger', 'huge'] as const;
/** a named size against the text's (CSS em; LaTeX's at 10 pt: 9, 10, 12, 14.4, 17.28) */
export const SIZE_EM: Record<string, number> = { small: 0.9, normal: 1, large: 1.2, larger: 1.44, huge: 1.728 };
const SIZE_CMD: Record<string, string> = { small: '\\small', normal: '\\normalsize', large: '\\large', larger: '\\Large', huge: '\\LARGE' };
/** the document's own families as a style's font */
export const FAMILY_FONTS: Record<string, { latex: string; label: string }> = {
  '@serif': { latex: '\\rmfamily', label: 'Serif' }, '@sans': { latex: '\\sffamily', label: 'Sans serif' }, '@mono': { latex: '\\ttfamily', label: 'Monospace' },
};
/** setspace's stretches for its named spacings (10 pt) */
export const ONEHALF_STRETCH = 1.25, DOUBLE_STRETCH = 1.667;

/** what LaTeX's article class gives each kind when nothing is set (the style editor's starting points; spaces in pt) */
export const TYPE_DEFAULTS: Record<TextType, { size: string; weight: number; align: NonNullable<TextStyle['align']>; display: 'block' | 'run-in'; above: number; below: number }> = {
  title: { size: 'huge', weight: 400, align: 'center', display: 'block', above: 0, below: 12 },
  section: { size: 'larger', weight: 700, align: 'left', display: 'block', above: 15, below: 10 },
  subsection: { size: 'large', weight: 700, align: 'left', display: 'block', above: 14, below: 6 },
  subsubsection: { size: 'normal', weight: 700, align: 'left', display: 'block', above: 14, below: 6 },
  paragraph: { size: 'normal', weight: 700, align: 'left', display: 'run-in', above: 14, below: 0 },
  body: { size: 'normal', weight: 400, align: 'justify', display: 'block', above: 0, below: 0 },
  quote: { size: 'normal', weight: 400, align: 'justify', display: 'block', above: 6, below: 6 },
};

const CHOICES: Partial<Record<StyleKey, readonly string[]>> = {
  display: ['block', 'run-in'], shape: ['upright', 'italic'], case: ['normal', 'smallcaps', 'uppercase'],
  align: ['left', 'center', 'right', 'justify'], rule: ['none', 'below', 'above'],
};

/** a font as a style takes it: a family name, a font by name (`Inter|wdth=90`), `@sans` … — '' when it is none of them */
export function styleFont(v: string): string {
  const s = v.trim();
  if (FAMILY_FONTS[s]) return s;
  if (/^[\p{L}\p{N} ._+-]{1,80}$/u.test(s)) return s;
  return s.includes('|') && parseFace(s) && validFontFamily(s.split('|')[0]) ? s : '';
}
/** a weight: bold / normal, or 1 … 1000 */
export function styleWeight(v: unknown): number | undefined {
  if (v === 'bold') return 700;
  if (v === 'normal' || v === 'regular') return 400;
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 1 && n <= 1000 ? Math.round(n) : undefined;
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
  const font = str('font'), size = str('size'), color = str('color'), ls = str('line-spacing') ?? str('lineSpacing');
  if (font && styleFont(font)) out.font = styleFont(font);
  if (size && styleSize(size)) out.size = styleSize(size);
  const w = styleWeight(o.weight);
  if (w !== undefined) out.weight = w;
  if (color) { const c = /^#?([0-9a-fA-F]{6})$/.exec(color.trim()); if (c) out.color = '#' + c[1].toLowerCase(); }
  if (ls !== undefined && Number(ls) >= 0.5 && Number(ls) <= 4) out.lineSpacing = Math.round(Number(ls) * 1000) / 1000;
  for (const [k, choices] of Object.entries(CHOICES) as [StyleKey, readonly string[]][]) {
    const raw = str(k);
    if (raw !== undefined && choices.includes(raw.trim().toLowerCase())) (out as Record<string, string>)[k] = raw.trim().toLowerCase();
  }
  // a font by name's weight is the style's weight (`Inter|300`: weight 300)
  if (out.font?.includes('|')) {
    const f = parseFace(out.font);
    if (f && f.axes.wght !== undefined) {
      if (out.weight === undefined) out.weight = Math.round(f.axes.wght);
      delete f.axes.wght;
      out.font = faceValue(f);
    }
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

const headerValue = (lines: readonly string[], key: string) => {
  const l = lines.find(x => x === '\\' + key || x.startsWith('\\' + key + ' '));
  return l === undefined ? undefined : l.slice(key.length + 2).trim();
};

/** the styles of a header's `\overlyx_styles` line */
export function stylesOfHeader(headerLines: readonly string[]): TextStyles {
  return parseStyles(headerValue(headerLines, 'overlyx_styles'));
}

/** what a style sets, compactly (empty styles dropped) */
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

/** a stretch from a header's `\spacing` (single, onehalf, double, other 1.3) — 1: single */
export function spacingStretch(v: string | undefined): number {
  if (!v || v === 'single' || v === 'default') return 1;
  if (v === 'onehalf') return ONEHALF_STRETCH;
  if (v === 'double') return DOUBLE_STRETCH;
  const n = Number(v.replace(/^other\s+/, ''));
  return n > 0 && n < 5 ? n : 1;
}
/** the `\spacing` value of a stretch */
export function spacingValue(stretch: number): string {
  if (Math.abs(stretch - 1) < 0.005) return 'single';
  if (Math.abs(stretch - ONEHALF_STRETCH) < 0.005) return 'onehalf';
  if (Math.abs(stretch - DOUBLE_STRETCH) < 0.005) return 'double';
  return `other ${Math.round(stretch * 1000) / 1000}`;
}

/** a markdown document's header (it says `\overlyx_justify`; ragged right unless it says otherwise) */
export const isMarkdownHeader = (headerLines: readonly string[]) => headerValue(headerLines, 'overlyx_justify') !== undefined;

/** what the body is when nothing is set: a .tex document justified (LaTeX's), a markdown one ragged right */
export function bodyDefaults(markdown: boolean): { align: 'left' | 'justify'; lineSpacing: number } {
  return { align: markdown ? 'left' : 'justify', lineSpacing: 1 };
}

/**
 * The document layer as the header carries it: `\overlyx_styles`, and for normal text the
 * settings of its own — justification (a markdown document's `\overlyx_justify`), line spacing,
 * the font size, a font by name (non-TeX fonts' roman). Only what differs from bodyDefaults.
 */
export function documentStyles(headerLines: readonly string[]): TextStyles {
  const styles = stylesOfHeader(headerLines);
  const md = isMarkdownHeader(headerLines);
  const body: TextStyle = { ...(styles.body ?? {}) };
  delete body.align; delete body.lineSpacing; delete body.size;
  const justify = md ? headerValue(headerLines, 'overlyx_justify') === 'true' : headerValue(headerLines, 'justification') !== 'false';
  if (justify !== (bodyDefaults(md).align === 'justify')) body.align = justify ? 'justify' : 'left';
  const ls = spacingStretch(headerValue(headerLines, 'spacing'));
  if (ls !== 1) body.lineSpacing = ls;
  const pt = Number(headerValue(headerLines, 'paperfontsize'));
  if (pt > 0) body.size = `${pt}pt`;
  // the roman font by name (fontspec): the style's own font when it names the same family (its axes and features)
  if (headerValue(headerLines, 'use_non_tex_fonts') === 'true') {
    const name = /"[^"]*"\s+"([^"]*)"/.exec(headerValue(headerLines, 'font_roman') ?? '')?.[1];
    const own = body.font && !FAMILY_FONTS[body.font] ? body.font.split('|')[0] : '';
    if (name && name !== 'default' && own !== name) body.font = styleFont(name) || undefined;
    if (!body.font) delete body.font;
  } else if (body.font && !FAMILY_FONTS[body.font]) delete body.font;
  const out = { ...styles };
  if (Object.keys(body).length) out.body = body; else delete out.body;
  return out;
}

/* ------------------------------------------------------------------ LaTeX */

/** LaTeX's own spacing around each heading level (article) */
const LEVEL_SPACING: Record<HeadingLevel, { above: string; below: string }> = {
  section: { above: '3.5ex plus 1ex minus .2ex', below: '2.3ex plus .2ex' },
  subsection: { above: '3.25ex plus 1ex minus .2ex', below: '1.5ex plus .2ex' },
  subsubsection: { above: '3.25ex plus 1ex minus .2ex', below: '1.5ex plus .2ex' },
  paragraph: { above: '3.25ex plus 1ex minus .2ex', below: '1em' },
};

export const headingDisplay = (level: HeadingLevel, st: TextStyle | undefined) => st?.display ?? TYPE_DEFAULTS[level].display;

function sizeLatex(size: string): string {
  if (SIZE_CMD[size]) return SIZE_CMD[size];
  const pt = parseFloat(size);
  return `\\fontsize{${pt}}{${Math.round(pt * 12) / 10}}\\selectfont`;
}

/** \olfontset[axes][features]{Family} (fontface.ts OLFONT_DEF): the font by name, its upright at `weight` */
export function fontLatex(font: string, weight?: number, cmd = '\\olfontset'): string {
  const f = font.includes('|') ? parseFace(font) : null;
  const family = f ? f.family : font;
  const axes: Record<string, number> = { ...(f?.axes ?? {}) };
  if (weight !== undefined && weight !== 400) axes.wght = weight; else if (weight === 400) delete axes.wght;
  const keys = Object.keys(axes).sort();
  const axesOpt = keys.length === 1 && keys[0] === 'wght' ? String(axes.wght) : keys.map(k => `${k}=${Math.round(axes[k] * 100) / 100}`).join(',');
  const feats = (f?.features ?? []).join(';');
  return `${cmd}${axesOpt || feats ? `[${axesOpt}]` : ''}${feats ? `[${feats}]` : ''}{${family}}`;
}

/** a font by name (not one of the document's own families) */
const namedFont = (font: string | undefined): font is string => !!font && !FAMILY_FONTS[font];

export interface StylesLatexOptions {
  /** what the preamble's LaTeX sets: OverLyX's LaTeX for the same is left out (the preamble's wins) */
  tex?: TexLayer;
  /** the body's font by name (a heading of another weight and no font of its own takes it at that weight) */
  bodyFont?: string;
}

/** the declarations a style's font, size, weight, shape, case and colour amount to */
function formatLatex(st: TextStyle, size: string | undefined, weight: number | undefined, o: StylesLatexOptions): string {
  let f = '';
  // (regular and bold are the font's own series — \bfseries; another weight is the font's upright at it)
  const other = weight !== undefined && weight !== 400 && weight !== 700;
  let weighted = false;
  if (st.font && FAMILY_FONTS[st.font]) f += FAMILY_FONTS[st.font].latex;
  else if (namedFont(st.font)) { f += fontLatex(st.font, other ? weight : undefined); weighted = other; }
  else if (other && namedFont(o.bodyFont)) { f += fontLatex(o.bodyFont, weight); weighted = true; }
  if (size) f += sizeLatex(size);
  if (!weighted && weight !== undefined) f += weight >= 600 ? '\\bfseries' : '\\mdseries';
  if (st.shape === 'italic') f += '\\itshape';
  else if (st.shape === 'upright') f += '\\upshape';
  if (st.case === 'smallcaps') f += '\\scshape';
  if (st.color) f += `\\color[HTML]{${st.color.slice(1).toUpperCase()}}`;
  return f;
}

/** does any style name a font (the preamble then needs \olfontset / \olmainfont: OLFONT_DEF) */
export const stylesUseFonts = (styles: TextStyles) => TEXT_TYPES.some(t => namedFont(styles[t]?.font));

/**
 * The body's font by name as \olmainfont (fontface.ts) takes it — with its axes, features and
 * weight — or null when \setmainfont{family} says it all (a plain family at the regular weight) or
 * the document's fonts decide.
 */
export function bodyFace(body: TextStyle | undefined): string | null {
  if (!body || !namedFont(body.font)) return null;
  const f = body.font.includes('|') ? parseFace(body.font) : null;
  const plain = !f || (!Object.keys(f.axes).length && !f.features.length);
  if (plain && (body.weight === undefined || body.weight === 400)) return null;
  return fontLatex(body.font, body.weight, '\\olmainfont');
}

/**
 * A .tex document's body font as \olmainfont (null: \setmainfont{name} as ever): the roman font by
 * name (non-TeX fonts) with the body style's weight, and its axes and features when it names the same family.
 */
export function texMainFace(body: TextStyle | undefined, bp: { useNonTexFonts: boolean; fontRoman: string }): string | null {
  if (!bp.useNonTexFonts || !bp.fontRoman || bp.fontRoman === 'default') return null;
  const own = body?.font && body.font.split('|')[0] === bp.fontRoman ? body.font : bp.fontRoman;
  return bodyFace({ ...(body ?? {}), font: own });
}

const FORMAT_KEYS: StyleKey[] = ['display', 'font', 'size', 'weight', 'shape', 'case', 'color', 'align', 'rule'];
const SPACING_KEYS: StyleKey[] = ['spaceAbove', 'spaceBelow'];
const sets = (tex: TexStyle | undefined, keys: StyleKey[]) => !!tex && keys.some(k => tex.keys.includes(k));
/** headings set by LaTeX other than titlesec's (sectsty, a sectioning command of its own): titlesec would undo them */
const foreignHeadings = (tex: TexLayer) => HEADING_LEVELS.some(l => tex[l]?.statements.some(st => !/^\\title(format|spacing)/.test(st.text)));

/**
 * The preamble LaTeX for the styles: titlesec for the headings, titling for the title, etoolbox for
 * quotes, the body's colour. The body's font, size, spacing and alignment are the document's own
 * settings (markdown: mainfont / fontsize / linestretch / justify; .tex: Document ▸ Settings) and
 * not set here. What `tex` (the preamble's own LaTeX) sets is left out. Fonts use \olfontset: the
 * caller provides OLFONT_DEF.
 */
export function stylesLatex(styles: TextStyles, o: StylesLatexOptions = {}): string[] {
  const out: string[] = [];
  const tex = o.tex ?? {};
  const levels = foreignHeadings(tex) ? [] : HEADING_LEVELS.filter(l => styles[l] && Object.keys(styles[l]!).length && !(sets(tex[l], FORMAT_KEYS) && sets(tex[l], SPACING_KEYS)));
  const title = styles.title && Object.keys(styles.title).length && !tex.title ? styles.title : null;
  const quote = styles.quote && Object.keys(styles.quote).length && !tex.quote ? styles.quote : null;
  const bodyColor = styles.body?.color && !sets(tex.body, ['color']) ? styles.body.color : null;
  if ([...levels.map(l => styles[l]), title, quote].some(st => st?.color) || bodyColor) out.push('\\usepackage{xcolor}');
  // headings
  if (levels.length) {
    out.push('\\usepackage{titlesec}');
    for (const level of levels) {
      const st = styles[level] ?? {}, def = LEVEL_SPACING[level], t = tex[level];
      const runIn = (sets(t, ['display']) ? t!.set.display ?? TYPE_DEFAULTS[level].display : headingDisplay(level, st)) === 'run-in';
      if (!sets(t, FORMAT_KEYS)) {
        const size = st.size ?? (runIn ? 'normal' : TYPE_DEFAULTS[level].size);
        let format = '\\normalfont' + formatLatex(st, size, st.weight ?? TYPE_DEFAULTS[level].weight, o);
        const align = runIn ? 'left' : st.align ?? 'left';
        if (align === 'center') format += '\\filcenter';
        else if (align === 'right') format += '\\filleft';
        if (!runIn && st.rule === 'above') format = `\\titlerule\\vspace{.8ex}${format}`;
        const shape = runIn ? 'runin' : align !== 'left' || st.rule === 'above' ? 'block' : 'hang';
        // (the title is the argument of the last command of "before")
        const before = st.case === 'uppercase' ? '\\MakeUppercase' : '';
        const after = !runIn && st.rule === 'below' ? '[\\vspace{.4ex}\\titlerule]' : '';
        out.push(`\\titleformat{\\${level}}[${shape}]{${format}}{\\the${level}}{${runIn ? '0.6em' : '1em'}}{${before}}${after}`);
      }
      if (!sets(t, SPACING_KEYS)) {
        // (a length given is kept to, with a little stretch above; run in, the space after is the gap before the text)
        const above = st.spaceAbove ? `${st.spaceAbove} plus .2ex` : runIn ? '1.6ex plus .3ex minus .2ex' : def.above;
        out.push(`\\titlespacing*{\\${level}}{0pt}{${above}}{${runIn ? '0.8em' : st.spaceBelow ?? def.below}}`);
      }
    }
  }
  // the title (\maketitle): titling's hooks around it
  if (title) {
    const ti = title;
    const env = ti.align === 'left' ? 'flushleft' : ti.align === 'right' ? 'flushright' : 'center';
    out.push('\\usepackage{titling}');
    // (\MakeUppercase last: the title follows it, as titling sets \@title right after \pretitle)
    out.push(`\\pretitle{${ti.spaceAbove ? `\\vspace*{${ti.spaceAbove}}` : ''}\\begin{${env}}${ti.rule === 'above' ? '\\hrule\\vspace{.6em}' : ''}${formatLatex(ti, ti.size ?? 'huge', ti.weight, o)}${ti.case === 'uppercase' ? '\\MakeUppercase' : ''}}`);
    out.push(`\\posttitle{\\par${ti.rule === 'below' ? '\\vspace{.4em}\\hrule' : ''}\\end{${env}}${ti.spaceBelow ? `\\vspace{${ti.spaceBelow}}` : '\\vskip 0.5em'}}`);
  }
  // quotes
  if (quote) {
    const q = quote;
    out.push('\\usepackage{etoolbox}');
    let f = formatLatex(q, q.size, q.weight, o);
    if (q.align === 'center') f += '\\centering';
    else if (q.align === 'right') f += '\\raggedleft';
    else if (q.align === 'left') f += '\\raggedright';
    for (const env of ['quote', 'quotation']) out.push(`\\AtBeginEnvironment{${env}}{${f}${q.spaceAbove ? `\\vspace{${q.spaceAbove}}` : ''}}`);
  }
  // the body's colour (headings, quotes and the title set their own above)
  if (bodyColor) out.push(`\\AtBeginDocument{\\color[HTML]{${bodyColor.slice(1).toUpperCase()}}}`);
  return out;
}

/* ------------------------------------------------------------------ the preamble's own LaTeX */

/** a statement of the preamble that sets a style: where it is, what it sets (a removal may put `replace` there instead) */
export interface TexStatement {
  start: number;
  end: number;
  text: string;
  types: TextType[];
  keys: StyleKey[];
  /** what the statement sets, type by type, as far as it can be read */
  set: TextStyles;
  /** it sets more than can be read (a \renewcommand of its own) */
  custom?: boolean;
  /** removing it leaves this (`\usepackage[onehalfspacing]{setspace}` → `\usepackage{setspace}`) */
  replace?: string;
}
/**
 * What the preamble's LaTeX sets of a type: the keys (the PDF follows the LaTeX for them), their
 * values where readable (a key it sets without a value: the class's default), the keys it sets in a
 * way that cannot be read, and the statements.
 */
export interface TexStyle { keys: StyleKey[]; set: TextStyle; custom: StyleKey[]; statements: TexStatement[] }
export type TexLayer = Partial<Record<TextType, TexStyle>>;

const SIZE_OF_CMD: Record<string, string> = { '\\tiny': '6pt', '\\scriptsize': '7pt', '\\footnotesize': '8pt', '\\small': 'small', '\\normalsize': 'normal', '\\large': 'large', '\\Large': 'larger', '\\LARGE': 'huge', '\\huge': '20.74pt', '\\Huge': '24.88pt' };
const SERIES: Record<string, number> = { ul: 100, el: 200, l: 300, sl: 350, m: 400, mb: 500, sb: 600, b: 700, bx: 700, eb: 800, ub: 900 };
const XCOLORS: Record<string, string> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#00ff00', blue: '#0000ff', cyan: '#00ffff', magenta: '#ff00ff', yellow: '#ffff00',
  gray: '#808080', darkgray: '#404040', lightgray: '#bfbfbf', brown: '#bf8040', lime: '#bfff00', olive: '#808000', orange: '#ff8000',
  pink: '#ffbfbf', purple: '#bf0040', teal: '#008080', violet: '#800080',
};

/** `s` with every comment blanked (positions kept) */
function maskComments(s: string): string {
  let out = '';
  let from = 0;
  for (let i = s.indexOf('%'); i >= 0; i = s.indexOf('%', i + 1)) {
    let k = i, bs = 0;
    while (k > 0 && s[k - 1] === '\\') { bs++; k--; }
    if (bs % 2) continue;
    let j = s.indexOf('\n', i);
    if (j < 0) j = s.length;
    out += s.slice(from, i) + ' '.repeat(j - i);
    from = j;
    i = j - 1;
  }
  return out + s.slice(from);
}

/** the end (exclusive) of the group `{…}` / `[…]` opening at `i`, or -1 */
function groupEnd(s: string, i: number): number {
  const open = s[i], close = open === '{' ? '}' : ']';
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') { j++; continue; }
    if (open === '[' && c === '{') { const e = groupEnd(s, j); if (e < 0) return -1; j = e - 1; continue; }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return j + 1;
  }
  return -1;
}

interface Arg { opt: boolean; text: string }
/** the arguments from `at`: groups, optional ones, a bare token (`\renewcommand\section`) as a mandatory one; then one trailing optional one */
function readArgs(s: string, at: number, mandatory: number): { list: Arg[]; end: number } {
  const list: Arg[] = [];
  let i = at, got = 0;
  while (got < mandatory) {
    let j = i;
    while (j < s.length && /\s/.test(s[j])) j++;
    if (s[j] === '{' || s[j] === '[') {
      const e = groupEnd(s, j);
      if (e < 0) break;
      if (s[j] === '{') got++;
      list.push({ opt: s[j] === '[', text: s.slice(j + 1, e - 1) });
      i = e;
    } else if (s[j] === '\\') {
      const m = /^\\([A-Za-z@]+|.)/.exec(s.slice(j, j + 60));
      if (!m) break;
      list.push({ opt: false, text: m[0] }); got++;
      i = j + m[0].length;
    } else break;
  }
  // a trailing optional argument on the same line (titlesec's [after], fontspec's [options] after the name)
  let j = i;
  while (s[j] === ' ' || s[j] === '\t') j++;
  if (s[j] === '[') { const e = groupEnd(s, j); if (e > 0) { list.push({ opt: true, text: s.slice(j + 1, e - 1) }); i = e; } }
  return { list, end: i };
}

/** font, size, weight, shape, case, colour and alignment from formatting commands */
function formatOf(tokens: string, st: TextStyle): void {
  for (const m of tokens.matchAll(/\\(tiny|scriptsize|footnotesize|small|normalsize|large|Large|LARGE|huge|Huge)\b/g)) st.size = SIZE_OF_CMD['\\' + m[1]];
  const fs = /\\fontsize\{\s*([\d.]+)\s*(?:pt)?\s*\}/.exec(tokens);
  if (fs) st.size = styleSize(`${fs[1]}pt`) || st.size;
  if (/\\(bfseries|textbf)\b/.test(tokens)) st.weight = 700;
  else if (/\\mdseries\b/.test(tokens)) st.weight = 400;
  const series = /\\fontseries\{(\w+)\}/.exec(tokens);
  if (series && SERIES[series[1]] !== undefined) st.weight = SERIES[series[1]];
  if (/\\(itshape|slshape|textit)\b/.test(tokens)) st.shape = 'italic';
  if (/\\(scshape|textsc)\b/.test(tokens)) st.case = 'smallcaps';
  if (/\\MakeUppercase\b/.test(tokens)) st.case = 'uppercase';
  const hex = /\\color\[HTML\]\{#?([0-9a-fA-F]{6})\}/.exec(tokens);
  const named = /\\color\{([a-z]+)\}/.exec(tokens);
  if (hex) st.color = '#' + hex[1].toLowerCase();
  else if (named && XCOLORS[named[1]]) st.color = XCOLORS[named[1]];
  if (/\\(centering|filcenter)\b/.test(tokens) || /\\begin\{center\}/.test(tokens)) st.align = 'center';
  else if (/\\(raggedleft|filleft)\b/.test(tokens) || /\\begin\{flushright\}/.test(tokens)) st.align = 'right';
  else if (/\\begin\{flushleft\}/.test(tokens)) st.align = 'left';
  if (/\\sffamily\b/.test(tokens)) st.font = '@sans';
  else if (/\\ttfamily\b/.test(tokens)) st.font = '@mono';
  const byName = /\\(?:fontspec|olfontset)\s*(?:\[[^\]]*\])?\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/.exec(tokens);
  if (byName && styleFont(byName[1])) st.font = styleFont(byName[1]);
}

/** a format given whole (titlesec's, \@startsection's, titling's \pretitle): what it does not say is the plain text's */
function wholeFormat(st: TextStyle, display?: 'block' | 'run-in'): TextStyle {
  return { size: 'normal', weight: 400, align: 'left', ...(display ? { display } : {}), ...st };
}

const LEVEL_OF: Record<string, HeadingLevel> = { section: 'section', subsection: 'subsection', subsubsection: 'subsubsection', paragraph: 'paragraph' };
const SECTSTY: Record<string, HeadingLevel[]> = {
  allsectionsfont: [...HEADING_LEVELS], sectionfont: ['section'], subsectionfont: ['subsection'], subsubsectionfont: ['subsubsection'], paragraphfont: ['paragraph'],
};
/** a first length (`1.4ex plus .2ex` → 1.4ex; a negative one: its size) */
const firstLength = (s: string) => styleLength((s.trim().replace(/^-/, '').split(/\s|\\/)[0] ?? ''));
const levelArg = (a: Arg | undefined) => { const m = /^\s*\\(section|subsection|subsubsection|paragraph)\s*$/.exec(a?.text ?? ''); return m ? LEVEL_OF[m[1]] : null; };
const ALL_KEYS: StyleKey[] = [...FORMAT_KEYS, ...SPACING_KEYS];

/**
 * What the preamble's LaTeX sets of the text styles — its top-level statements and those in
 * \AtBeginDocument: titlesec (\titleformat, \titlespacing), sectsty (\sectionfont …), a sectioning
 * command or \@maketitle of its own, titling's \pretitle / \posttitle, a patched \@maketitle, quotes'
 * \AtBeginEnvironment, and for normal text \justifying / \RaggedRight, setspace (\setstretch,
 * \onehalfspacing, its package options), \linespread, \baselinestretch, \setmainfont, \color.
 */
export function readTexStyles(preamble: string): TexLayer {
  const statements: TexStatement[] = [];
  const s = maskComments(preamble);
  const add = (start: number, end: number, types: TextType[], keys: StyleKey[], set: TextStyles, extra: Partial<TexStatement> = {}) =>
    statements.push({ start, end, text: preamble.slice(start, end), types, keys, set, ...extra });
  const scan = (from: number, to: number, hook: boolean) => {
    let depth = 0;
    for (let i = from; i < to; i++) {
      const c = s[i];
      if (c === '{') { depth++; continue; }
      if (c === '}') { depth--; continue; }
      if (c !== '\\' || depth > 0) continue;
      const m = /^\\([A-Za-z@]+)(\*?)/.exec(s.slice(i, Math.min(to, i + 60)));
      if (!m) { i++; continue; }
      const cmd = m[1], at = i + m[0].length;
      const body: TextStyle = {};
      let end = at;
      if (cmd === 'justifying' || cmd === 'RaggedRight' || cmd === 'raggedright') {
        body.align = cmd === 'justifying' ? 'justify' : 'left';
        add(i, at, ['body'], ['align'], { body });
      } else if (cmd === 'setstretch' || cmd === 'linespread') {
        const a = readArgs(s, at, 1);
        const n = Number(a.list[0]?.text.trim());
        if (n > 0) body.lineSpacing = n;
        add(i, a.end, ['body'], ['lineSpacing'], { body }, n > 0 ? {} : { custom: true });
        end = a.end;
      } else if (cmd === 'onehalfspacing' || cmd === 'doublespacing' || cmd === 'singlespacing') {
        body.lineSpacing = cmd === 'onehalfspacing' ? ONEHALF_STRETCH : cmd === 'doublespacing' ? DOUBLE_STRETCH : 1;
        add(i, at, ['body'], ['lineSpacing'], { body });
      } else if (cmd === 'setmainfont') {
        const a = readArgs(s, at, 1);
        const name = a.list.find(x => !x.opt)?.text.trim() ?? '';
        if (styleFont(name)) body.font = styleFont(name);
        add(i, a.end, ['body'], ['font'], { body }, { custom: !body.font });
        end = a.end;
      } else if (cmd === 'color' && hook) {
        const a = readArgs(s, at, 1);
        const st: TextStyle = {};
        formatOf(s.slice(i, a.end), st);
        if (st.color) body.color = st.color;
        add(i, a.end, ['body'], ['color'], { body }, { custom: !body.color });
        end = a.end;
      } else if (cmd === 'usepackage') {
        const a = readArgs(s, at, 1);
        const pkg = a.list.find(x => !x.opt)?.text.trim();
        const opts = a.list[0]?.opt ? a.list[0].text.split(',').map(x => x.trim()) : [];
        const spacing = opts.find(x => /^(onehalfspacing|doublespacing|singlespacing)$/.test(x));
        if (pkg === 'setspace' && spacing) {
          body.lineSpacing = spacing === 'onehalfspacing' ? ONEHALF_STRETCH : spacing === 'doublespacing' ? DOUBLE_STRETCH : 1;
          const rest = opts.filter(x => x !== spacing);
          add(i, a.end, ['body'], ['lineSpacing'], { body }, { replace: `\\usepackage${rest.length ? `[${rest.join(',')}]` : ''}{setspace}` });
        }
        end = a.end;
      } else if (cmd === 'AtBeginDocument') {
        const a = readArgs(s, at, 1);
        const open = s.indexOf('{', at);
        if (open >= 0 && open < a.end) {
          const before = statements.length;
          scan(open + 1, a.end - 1, true);
          // a hook holding nothing but the one statement goes with it
          const inner = statements.slice(before);
          if (inner.length === 1) {
            const st = inner[0];
            const rest = s.slice(open + 1, st.start) + s.slice(st.end, a.end - 1);
            if (!rest.trim()) { st.start = i; st.end = a.end; st.text = preamble.slice(i, a.end); }
          }
        }
        end = a.end;
      } else if (cmd === 'titleformat') {
        const star = m[2] === '*';
        const a = readArgs(s, at, star ? 2 : 5);
        const level = levelArg(a.list[0]);
        if (level) {
          let st: TextStyle = {};
          const rest = a.list.slice(1);
          let k = 0;
          let display: 'block' | 'run-in' = TYPE_DEFAULTS[level].display;
          if (!star) {
            display = 'block';
            if (rest[0]?.opt) { display = /^(runin|wrap|leftmargin|rightmargin|drop|margin)$/.test(rest[0].text.trim()) ? 'run-in' : 'block'; k = 1; }
          }
          const format = rest[k]?.text ?? '';
          formatOf(format, st);
          if (!star) {
            const before = rest[k + 3]?.text ?? '', after = rest[k + 4]?.opt ? rest[k + 4].text : '';
            if (/\\MakeUppercase/.test(before)) st.case = 'uppercase';
            if (/\\titlerule/.test(after)) st.rule = 'below';
            else if (/\\titlerule/.test(format)) st.rule = 'above';
          }
          st = wholeFormat(st, display);
          add(i, a.end, [level], FORMAT_KEYS, { [level]: st });
        }
        end = a.end;
      } else if (cmd === 'titlespacing') {
        const a = readArgs(s, at, 4);
        const level = levelArg(a.list[0]);
        if (level) {
          const args = a.list.filter(x => !x.opt);
          const st: TextStyle = {};
          if (firstLength(args[2]?.text ?? '')) st.spaceAbove = firstLength(args[2].text);
          if (firstLength(args[3]?.text ?? '')) st.spaceBelow = firstLength(args[3].text);
          add(i, a.end, [level], SPACING_KEYS, { [level]: st });
        }
        end = a.end;
      } else if (SECTSTY[cmd]) {
        // (sectsty adds to the class's own format: what it does not say stays the class's)
        const a = readArgs(s, at, 1);
        const st: TextStyle = {};
        formatOf(a.list[0]?.text ?? '', st);
        const levels = SECTSTY[cmd];
        add(i, a.end, levels, ALL_KEYS, Object.fromEntries(levels.map(l => [l, st])));
        end = a.end;
      } else if (cmd === 'renewcommand' || cmd === 'def') {
        const a = readArgs(s, at, cmd === 'def' ? 1 : 2);
        const target = (a.list.find(x => !x.opt)?.text ?? '').trim();
        const name = /^\\([A-Za-z@]+)$/.exec(target)?.[1] ?? '';
        let defEnd = a.end;
        let def = a.list.filter(x => !x.opt)[1]?.text ?? '';
        if (cmd === 'def') { const open = s.indexOf('{', a.end); const e = open >= 0 ? groupEnd(s, open) : -1; if (e > 0 && !s.slice(a.end, open).trim().replace(/#\d/g, '')) { def = s.slice(open + 1, e - 1); defEnd = e; } }
        if (LEVEL_OF[name]) {
          // \@startsection{name}{level}{indent}{beforeskip}{afterskip}{style}
          const ss = /\\@startsection/.exec(def);
          let st: TextStyle = {};
          if (ss) {
            const p = readArgs(def, ss.index + ss[0].length, 6).list.filter(x => !x.opt);
            const afterSkip = (p[4]?.text ?? '').trim();
            formatOf(p[5]?.text ?? '', st);
            st = wholeFormat(st, afterSkip.startsWith('-') ? 'run-in' : 'block');
            if (firstLength(p[3]?.text ?? '')) st.spaceAbove = firstLength(p[3].text);
            if (st.display === 'block' && firstLength(afterSkip)) st.spaceBelow = firstLength(afterSkip);
          }
          add(i, defEnd, [LEVEL_OF[name]], ALL_KEYS, { [LEVEL_OF[name]]: st }, { custom: !ss });
        } else if (name === 'maketitle' || name === '@maketitle') {
          add(i, defEnd, ['title'], ALL_KEYS, { title: {} }, { custom: true });
        } else if (name === 'baselinestretch') {
          const n = Number(def.trim());
          if (n > 0) body.lineSpacing = n;
          add(i, defEnd, ['body'], ['lineSpacing'], { body }, { custom: !(n > 0) });
        }
        end = defEnd;
      } else if (cmd === 'pretitle' || cmd === 'posttitle') {
        const a = readArgs(s, at, 1);
        let st: TextStyle = {};
        if (cmd === 'pretitle') { formatOf(a.list[0]?.text ?? '', st); st = wholeFormat(st); }
        add(i, a.end, ['title'], ALL_KEYS, { title: st });
        end = a.end;
      } else if (cmd === 'patchcmd') {
        const a = readArgs(s, at, 5);
        const [target, from, into] = a.list.filter(x => !x.opt).map(x => x.text.trim());
        if (target === '\\@maketitle') {
          const st: TextStyle = {};
          if (from === '\\LARGE' && SIZE_OF_CMD[into]) st.size = SIZE_OF_CMD[into];
          add(i, a.end, ['title'], ALL_KEYS, { title: st }, { custom: !st.size });
        }
        end = a.end;
      } else if (cmd === 'AtBeginEnvironment' || cmd === 'renewenvironment') {
        const a = readArgs(s, at, cmd === 'renewenvironment' ? 3 : 2);
        const env = a.list[0]?.text.trim();
        if (env === 'quote' || env === 'quotation') {
          const st: TextStyle = {};
          if (cmd === 'AtBeginEnvironment') formatOf(a.list.filter(x => !x.opt)[1]?.text ?? '', st);
          add(i, a.end, ['quote'], [...FORMAT_KEYS, 'spaceAbove'], { quote: st }, { custom: cmd === 'renewenvironment' });
        }
        end = a.end;
      } else if (cmd === 'ExplSyntaxOn') {
        const e = s.indexOf('\\ExplSyntaxOff', at);
        end = e < 0 ? to : e + 14;
      }
      i = end - 1;
    }
  };
  scan(0, s.length, false);
  // sectsty or a sectioning command of its own: OverLyX's titlesec would undo it, so the LaTeX has all levels
  const foreign = statements.filter(st => st.types.some(isHeading) && !/^\\title(format|spacing)/.test(st.text));
  const out: TexLayer = {};
  for (const st of statements) {
    for (const t of st.types) {
      const e = (out[t] ??= { keys: [], set: {}, custom: [], statements: [] });
      e.statements.push(st);
      for (const k of st.keys) {
        if (!e.keys.includes(k)) e.keys.push(k);
        // the later statement wins (LaTeX's order); a key it sets without a value is the class's default
        const v = st.set[t]?.[k];
        if (v === undefined) delete e.set[k]; else (e.set as Record<string, unknown>)[k] = v;
        if (st.custom && v === undefined) { if (!e.custom.includes(k)) e.custom.push(k); }
        else e.custom = e.custom.filter(x => x !== k);
      }
    }
  }
  if (foreign.length) for (const l of HEADING_LEVELS) {
    const e = (out[l] ??= { keys: [], set: {}, custom: [], statements: [] });
    for (const k of ALL_KEYS) if (!e.keys.includes(k)) e.keys.push(k);
    for (const st of foreign) if (!e.statements.includes(st)) e.statements.push(st);
  }
  return out;
}

/** the preamble a header carries: a markdown document's header-includes (`\overlyx_includes`), a .tex document's \begin_preamble block */
export function headerPreamble(headerLines: readonly string[]): string {
  const inc = headerValue(headerLines, 'overlyx_includes');
  if (inc !== undefined) { try { const v = JSON.parse(inc); return Array.isArray(v) ? v.map(String).join('\n') : ''; } catch { return ''; } }
  const s = headerLines.indexOf('\\begin_preamble');
  if (s < 0) return '';
  const e = headerLines.indexOf('\\end_preamble', s);
  return headerLines.slice(s + 1, e < 0 ? undefined : e).join('\n');
}

/** the PDF's styles: the document's, and what the preamble's LaTeX sets over them (a key it sets unreadably: the class's default) */
export function pdfStyles(doc: TextStyles, tex: TexLayer): TextStyles {
  const out: TextStyles = {};
  for (const t of TEXT_TYPES) {
    const st: TextStyle = { ...(doc[t] ?? {}) };
    const x = tex[t];
    if (x) for (const k of x.keys) { const v = x.set[k]; if (v === undefined) delete st[k]; else (st as Record<string, unknown>)[k] = v; }
    if (Object.keys(st).length) out[t] = st;
  }
  return out;
}

/** the settings a .tex document's settings dialog set explicitly (`\overlyx_managed_settings`, tex/preamble.ts markEditedSettings) */
export function managedSettings(headerLines: readonly string[]): string[] {
  try { const v = JSON.parse(headerValue(headerLines, 'overlyx_managed_settings') ?? '[]'); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}

/** the body's keys an explicitly chosen setting says (the managed block's, after the preamble: tex/settings.ts nativeSettings) */
const SETTING_OF: Partial<Record<StyleKey, string[]>> = { lineSpacing: ['spacing'], align: ['justification'], font: ['font_roman', 'use_non_tex_fonts'] };

/**
 * The preamble's LaTeX but for the body's spacing, alignment and font when a setting was chosen for
 * them explicitly (Document ▸ Settings, the style editor): the PDF follows the choice there — it
 * is written after the preamble — and the LaTeX for it otherwise.
 */
export function settingsOverTex(tex: TexLayer, managed: readonly string[]): TexLayer {
  const body = tex.body;
  if (!body || !managed.length) return tex;
  const drop = (Object.keys(SETTING_OF) as StyleKey[]).filter(k => SETTING_OF[k]!.some(x => managed.includes(x)));
  if (!drop.some(k => body.keys.includes(k))) return tex;
  const set: TextStyle = { ...body.set };
  for (const k of drop) delete set[k];
  const keys = body.keys.filter(k => !drop.includes(k));
  const out: TexLayer = { ...tex };
  if (keys.length) out.body = { keys, set, custom: body.custom.filter(k => !drop.includes(k)), statements: body.statements.filter(st => st.keys.some(k => keys.includes(k)) || st.types.some(t => t !== 'body')) };
  else delete out.body;
  return out;
}

/** a header's layers: the document's styles, the preamble's LaTeX, and the PDF's (both) */
export function styleLayers(headerLines: readonly string[]): { document: TextStyles; tex: TexLayer; pdf: TextStyles; markdown: boolean } {
  const document = documentStyles(headerLines);
  const tex = settingsOverTex(readTexStyles(headerPreamble(headerLines)), managedSettings(headerLines));
  return { document, tex, pdf: pdfStyles(document, tex), markdown: isMarkdownHeader(headerLines) };
}

/**
 * Setting `key` of `type` (`key` omitted: the whole type) where the preamble's LaTeX sets it: the
 * statements to remove, and what they set — every type they touch — for the document to keep (the
 * look stays, but for what could not be read).
 */
export function takeOver(tex: TexLayer, type: TextType, key?: StyleKey): { statements: TexStatement[]; keep: TextStyles } {
  const statements = (tex[type]?.statements ?? []).filter(st => !key || st.keys.includes(key) || !st.types.includes(type));
  const keep: TextStyles = {};
  for (const st of statements) for (const t of st.types) {
    const v = st.set[t];
    if (v && Object.keys(v).length) keep[t] = { ...(keep[t] ?? {}), ...v };
  }
  return { statements, keep };
}

/**
 * The preamble without `statements` (each replaced by its `replace`, if any): a line left empty by
 * that goes, and so does a \makeatletter\makeatother left with nothing between.
 */
export function removeStatements(preamble: string, statements: readonly TexStatement[]): string {
  let text = preamble;
  const touched: number[] = [];
  for (const st of [...statements].sort((a, b) => b.start - a.start)) {
    if (text.slice(st.start, st.end) !== st.text) continue;
    const put = st.replace ?? '';
    text = text.slice(0, st.start) + put + text.slice(st.end);
    // (earlier positions stay; later ones moved by the difference)
    for (let k = 0; k < touched.length; k++) touched[k] += put.length - (st.end - st.start);
    touched.push(st.start);
  }
  if (!touched.length) return preamble;
  const lines: string[] = [];
  let at = 0;
  for (const line of text.split('\n')) {
    const from = at, to = at + line.length;
    at = to + 1;
    if (!touched.some(p => p >= from && p <= to)) { lines.push(line); continue; }
    const left = line.replace(/\\makeatletter\s*\\makeatother/g, '').replace(/\s+$/, '');
    if (left.trim()) lines.push(left);
  }
  return lines.join('\n');
}
