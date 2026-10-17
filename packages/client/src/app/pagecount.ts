/**
 * How many pages a document (or a selection) takes at 11pt, for the status bar's word count: LaTeX's
 * article class at 11pt on A4 — a 360 pt column of 43 lines (13.6 pt apart) holding about 70
 * characters each (measured on a built paper in Latin Modern) — whatever the document's own class and size. Text counts by the lines it fills;
 * headings, the title, display formulas, figures, tables, theorems and the bibliography by the room
 * LaTeX gives them. An estimate: the PDF decides.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { paramMap } from '@overlyx/core';

export const PAGE_LINES = 43;
export const LINE_CHARS = 70;
const LINE_PT = 13.6, TEXT_PT = 360, BREAK_SLACK = 1.06;

/** lines a heading / title paragraph takes besides its text: LaTeX's space above and below */
const LAYOUT_EXTRA: Record<string, number> = {
  // \maketitle: the title in \LARGE, the date (today's when none is given) and their skips
  Title: 5.5, Author: 1.5, Date: 0, Abstract: 2.5, Part: 6, Chapter: 7, 'Chapter*': 7,
  Section: 2.4, 'Section*': 2.4, Subsection: 1.9, 'Subsection*': 1.9, Subsubsection: 1.5, 'Subsubsection*': 1.5,
  Paragraph: 0.4, 'Paragraph*': 0.4, Subparagraph: 0.3,
  Theorem: 0.8, Lemma: 0.8, Corollary: 0.8, Proposition: 0.8, Definition: 0.8, Conjecture: 0.8, Remark: 0.6, Example: 0.6, Proof: 0.5,
  Quote: 0.8, Quotation: 0.8, Verse: 0.8,
};
/** characters per line of a layout set narrower than the text (lists indent 2.5 em a level) */
const narrower = (layout: string, depth: number): number => {
  if (/^(Itemize|Enumerate|Description|Labeling)$/.test(layout)) return LINE_CHARS - 5 * (depth + 1);
  if (/^(Quote|Quotation|Verse|Abstract)$/.test(layout)) return LINE_CHARS - 8;
  return LINE_CHARS;
};

/** the width a formula's TeX takes in characters of text (commands draw as about one glyph) */
function mathChars(latex: string): number {
  return latex.replace(/\\(?:left|right|big|Big|bigg|Bigg)\b/g, '').replace(/\\[a-zA-Z]+/g, 'x').replace(/[{}^_\s$]|\\[,;:!]/g, '').length;
}

/** a display formula: its rows, taller with fractions, sums and integrals, and the space around it */
function displayLines(latex: string): number {
  const body = latex.replace(/\\begin\{(?:p|b|v|V|B)?matrix\}[\s\S]*?\\end\{(?:p|b|v|V|B)?matrix\}/g, 'M').replace(/\\begin\{cases\}[\s\S]*?\\end\{cases\}/g, 'C');
  const rows = (body.match(/\\\\/g) ?? []).length + 1;
  const tall = /\\(?:frac|dfrac|sum|int|prod|oint|bigcup|bigcap)|M|C/.test(body) ? 0.8 : 0;
  return 1.3 + rows * (1.1 + tall);
}

/** a length in a graphics width as a fraction of the text width (0.6 when none is given) */
function widthFraction(w: string | undefined): number {
  if (!w) return 0.6;
  const m = /^\s*([\d.]*)\s*\\(?:textwidth|linewidth|columnwidth|hsize)/.exec(w);
  if (m) return Math.min(1, Number(m[1] || 1));
  const u = /^\s*([\d.]+)\s*(pt|bp|mm|cm|in|em)\s*$/.exec(w);
  if (!u) return 0.6;
  const pt = Number(u[1]) * ({ pt: 1, bp: 1.004, mm: 2.845, cm: 28.45, in: 72.27, em: 11 } as Record<string, number>)[u[2]];
  return Math.min(1, pt / TEXT_PT);
}

/** the lines of a float: its pictures (in rows of what fits side by side, 5:8 high), tables, caption, the space around it */
function floatLines(float: PMNode): number {
  let lines = 1.6, row = 0, rowH = 0, caption = 0;
  float.descendants(n => {
    if (n.type.name === 'graphics') {
      let p: Map<string, string>;
      try { p = paramMap(JSON.parse(n.attrs.params || '[]')); } catch { p = new Map(); }
      const scale = Number(p.get('scale') ?? 0);
      const f = scale ? Math.min(1, scale / 100 * 0.5) : widthFraction(p.get('width'));
      const h = (p.get('height') ? widthFraction(p.get('height')) * TEXT_PT : f * TEXT_PT * 0.62) / LINE_PT;
      if (row + f > 1.02) { lines += rowH; row = 0; rowH = 0; }
      row += f; rowH = Math.max(rowH, h);
      return false;
    }
    if (n.type.name === 'table') { lines += tableLines(n); return false; }
    if (n.type.name === 'inset' && n.attrs.name === 'Caption') { caption += Math.ceil(textChars(n) / LINE_CHARS) + 0.4; return false; }
    if (n.type.name === 'math_display') { lines += displayLines(n.attrs.latex ?? ''); return false; }
    return true;
  });
  return lines + rowH + caption;
}

const tableLines = (table: PMNode): number => 1 + table.childCount * 1.15;

/** the characters a run of inline content sets as text (formulas by their width; notes, floats and footnotes left out) */
function textChars(node: PMNode): number {
  let n = 0;
  node.descendants(c => {
    if (c.isText) { n += c.text!.length; return false; }
    if (c.type.name === 'math_inline') { n += mathChars(c.attrs.latex ?? ''); return false; }
    if (c.type.name === 'inset') return c.attrs.name === 'Flex' || c.attrs.name === 'Branch' || c.attrs.name === 'Box';
    if (c.type.name === 'command' || c.type.name === 'quotes' || c.type.name === 'special' || c.type.name === 'space') { n += c.type.name === 'command' ? 6 : 1; return false; }
    return c.type.name === 'paragraph';
  });
  return n;
}

/** the lines one top-level paragraph fills: its text, then what it holds that LaTeX sets apart */
function paragraphLines(par: PMNode): number {
  const layout = String(par.attrs.layout ?? 'Standard');
  const chars = textChars(par);
  let lines = chars ? Math.ceil(chars / narrower(layout, Number(par.attrs.depth) || 0)) : 0;
  // \itemsep + \parsep between the items (4.5 pt + 4.5 pt at 11pt)
  if (/^(Itemize|Enumerate|Description|Labeling)$/.test(layout)) lines += 0.65;
  if (chars || layout !== 'Standard') lines += LAYOUT_EXTRA[layout] ?? 0;
  par.descendants(c => {
    if (c.type.name === 'math_display') { lines += displayLines(c.attrs.latex ?? ''); return false; }
    if (c.type.name === 'table') { lines += tableLines(c); return false; }
    if (c.type.name === 'inset') {
      if (c.attrs.name === 'Float' || c.attrs.name === 'Wrap') lines += floatLines(c);
      // footnotes in the smaller footnote size at the page's foot
      else if (c.attrs.name === 'Foot') lines += 0.3 + Math.ceil(textChars(c) / (LINE_CHARS * 1.12)) * 0.85;
      return false;
    }
    return true;
  });
  return lines;
}

/**
 * The estimated pages of `doc` at 11pt (fractional). `wholeDoc`: the bibliography of the works it
 * cites is added (a selection's part of it is not counted).
 */
export function estimatePages(doc: PMNode, wholeDoc = true): number {
  let lines = 0;
  const keys = new Set<string>();
  let bibliography = false;
  doc.forEach(par => {
    if (par.type.name !== 'paragraph') return;
    lines += paragraphLines(par);
    par.descendants(c => {
      if (c.type.name !== 'command') return true;
      const cmd = String(c.attrs.cmd);
      if (cmd === 'bibtex') bibliography = true;
      if (cmd === 'citation') {
        let p: Map<string, string>;
        try { p = paramMap(JSON.parse(c.attrs.params || '[]')); } catch { p = new Map(); }
        for (const k of (p.get('key') ?? '').replace(/^"|"$/g, '').split(',')) if (k.trim()) keys.add(k.trim());
      }
      return false;
    });
  });
  if (wholeDoc && bibliography && keys.size) lines += 3 + keys.size * 2.6;
  // what page breaking wastes: headings kept with their text, widows and clubs, floats waiting for room
  return lines * BREAK_SLACK / PAGE_LINES;
}

/** "≈ 1.4 pages" / "≈ 12 pages" — a tenth of a page under ten pages, whole pages from there */
export function formatPages(pages: number): string {
  if (pages < 0.05) return '0 pages';
  const n = pages < 10 ? Math.round(pages * 10) / 10 : Math.round(pages);
  return `≈ ${n.toLocaleString('en-US')} ${n === 1 ? 'page' : 'pages'}`;
}
