/**
 * LaTeX → document model (the LyX-shaped AST of lyx/ast.ts), driven by the document class:
 * commands and environments declared by the class's layout files (sections, lists, theorems,
 * footnotes, captions, character styles, ...) become paragraphs with layouts and insets, the
 * common LaTeX vocabulary (fonts, math, references, citations, graphics, floats, tables, spaces,
 * change tracking, notes) is mapped to LyX's insets, and everything the model has no place for is
 * kept verbatim in ERT insets — so any file parses, nothing is dropped, and the writer (tex/write.ts)
 * reproduces the LaTeX the parser understood.
 */
import { join } from 'node:path';
import type {
  Change, FontState, Inset, Item, LeafInset, LyxDocument, Paragraph, ParagraphParams, TextInset,
} from '../lyx/ast.ts';
import { lyxAuthorId, quote } from '../lyx/ast.ts';
import { DEFAULT_LAYOUT_DIR, loadDocumentClass, textclassForLatexClass, type DocumentClass, type InsetLayout, type LayoutStyle } from '../latex/layouts.ts';
import { loadUnicodeSymbols, type UnicodeDB } from '../latex/unicode.ts';
import { loadLanguages, type LanguageDB } from '../latex/languages.ts';
import { Scanner, groupEnd, type Tok } from './scanner.ts';
import { makeHeaderLines, preambleFacts, splitDocument, type PreambleFacts } from './preamble.ts';
import { parseTabular } from './table.ts';

export interface ParseTexOptions {
  layoutDir?: string;
  /** directories searched first for layout files (the project directory) */
  localDirs?: string[];
  /** header lines of the master document (for a child document / fragment) */
  masterHeader?: string[];
  /** read a file relative to the document (\input'ed preamble files: package detection) */
  readFile?: (name: string) => string | undefined;
}

export interface ParseTexResult {
  doc: LyxDocument;
  warnings: string[];
  /** true when the file has no \begin{document} (a child document / fragment) */
  fragment: boolean;
}

/* ------------------------------------------------------------ tables */

const MATH_ENVS = new Set([
  'equation', 'equation*', 'align', 'align*', 'alignat', 'alignat*', 'flalign', 'flalign*', 'gather', 'gather*', 'multline', 'multline*',
  'eqnarray', 'eqnarray*', 'xalignat', 'xalignat*', 'xxalignat', 'displaymath', 'math',
]);
/** environments whose content is not LaTeX text: kept verbatim */
const RAW_ENVS = new Set([
  'verbatim', 'verbatim*', 'lstlisting', 'minted', 'Verbatim', 'BVerbatim', 'LVerbatim', 'alltt', 'filecontents', 'filecontents*',
  'tikzpicture', 'tikzcd', 'pgfpicture', 'algorithmic', 'algorithmic*', 'lstlisting*', 'comment*', 'asy', 'luacode', 'luacode*', 'pycode', 'sagesilent',
]);
const TABULAR_ENVS = new Set(['tabular', 'tabular*', 'tabularx', 'longtable', 'xltabular']);
const ALIGN_ENVS: Record<string, string> = { center: 'center', flushleft: 'left', flushright: 'right', centering: 'center', raggedright: 'left', raggedleft: 'right' };
/** commands whose arguments are LaTeX code, not text: taken verbatim into one ERT */
const RAW_ARG_CMDS = new Set([
  'setlength', 'addtolength', 'setcounter', 'addtocounter', 'newcounter', 'stepcounter', 'refstepcounter', 'definecolor', 'colorlet', 'pgfplotsset',
  'tikzset', 'lstset', 'hypersetup', 'newtheorem', 'newtheorem*', 'theoremstyle', 'usepackage', 'RequirePackage', 'setstretch', 'linespread',
  'geometry', 'captionsetup', 'floatname', 'numberwithin', 'pagestyle', 'thispagestyle', 'graphicspath', 'DeclareGraphicsExtensions', 'let',
  'newlength', 'setboolean', 'newboolean', 'newif', 'usetikzlibrary', 'DeclareMathOperator', 'DeclareMathOperator*', 'DeclarePairedDelimiter',
  'newenvironment', 'renewenvironment', 'newfloat', 'floatstyle', 'restylefloat', 'floatplacement', 'sisetup', 'DeclareSIUnit', 'bibliographystyle*',
  'setmainfont', 'setsansfont', 'setmonofont', 'fontsize', 'newsavebox', 'sbox', 'savebox', 'label*', 'clearpage*', 'vspace**', 'renewcommand*',
  'providecommand*', 'newcommand*', 'input*', 'xdef', 'edef', 'gdef', 'expandafter', 'csname', 'makeatletter', 'makeatother', 'AtBeginDocument',
  'AtEndDocument', 'addcontentsline', 'markboth', 'markright', 'lhead', 'rhead', 'chead', 'lfoot', 'rfoot', 'cfoot', 'fancyhead', 'fancyfoot',
  'DeclareRobustCommand', 'DeclareTextCommand', 'newrefformat', 'crefname', 'Crefname', 'creflabelformat', 'labelformat',
]);
const FONT_CMDS: Record<string, Partial<FontState>> = {
  textbf: { series: 'bold' }, textmd: { series: 'medium' }, emph: { emph: 'on' }, textit: { shape: 'italic' }, textsl: { shape: 'slanted' },
  textsc: { shape: 'smallcaps' }, textup: { shape: 'up' }, texttt: { family: 'typewriter' }, textsf: { family: 'sans' }, textrm: { family: 'roman' },
  textnormal: { family: 'default', series: 'default', shape: 'default' },
  underline: { bar: 'under' }, uline: { bar: 'under' }, uuline: { uuline: 'on' }, uwave: { uwave: 'on' }, sout: { strikeout: 'on' }, xout: { xout: 'on' },
  noun: { noun: 'on' },
};
const FONT_DECLS: Record<string, Partial<FontState>> = {
  bfseries: { series: 'bold' }, mdseries: { series: 'medium' }, itshape: { shape: 'italic' }, slshape: { shape: 'slanted' }, scshape: { shape: 'smallcaps' },
  upshape: { shape: 'up' }, ttfamily: { family: 'typewriter' }, sffamily: { family: 'sans' }, rmfamily: { family: 'roman' }, em: { emph: 'toggle' },
  normalfont: { family: 'default', series: 'default', shape: 'default' }, bf: { series: 'bold' }, it: { shape: 'italic' }, tt: { family: 'typewriter' },
  sc: { shape: 'smallcaps' }, sl: { shape: 'slanted' }, rm: { family: 'roman' }, sf: { family: 'sans' },
};
const SIZE_DECLS: Record<string, string> = {
  tiny: 'tiny', scriptsize: 'scriptsize', footnotesize: 'footnotesize', small: 'small', normalsize: 'normal', large: 'large', Large: 'larger',
  LARGE: 'largest', huge: 'huge', Huge: 'giant',
};
const SPACE_CMDS: Record<string, string> = {
  ',': '\\thinspace{}', ';': '\\thickspace{}', ':': '\\medspace{}', '!': '\\negthinspace{}', ' ': '\\space{}',
  thinspace: '\\thinspace{}', medspace: '\\medspace{}', thickspace: '\\thickspace{}', negthinspace: '\\negthinspace{}', negmedspace: '\\negmedspace{}',
  negthickspace: '\\negthickspace{}', quad: '\\quad{}', qquad: '\\qquad{}', enspace: '\\enspace{}', enskip: '\\enskip{}', hfill: '\\hfill{}',
  dotfill: '\\dotfill{}', hrulefill: '\\hrulefill{}', leftarrowfill: '\\leftarrowfill{}', rightarrowfill: '\\rightarrowfill{}',
  upbracefill: '\\upbracefill{}', downbracefill: '\\downbracefill{}', nobreakspace: '\\nobreakspace{}', textvisiblespace: '\\textvisiblespace{}',
};
const SPECIAL_CMDS: Record<string, string> = {
  ldots: 'ldots', dots: 'ldots', LyX: 'LyX', TeX: 'TeX', LaTeX: 'LaTeX', LaTeXe: 'LaTeX2e', slash: 'breakableslash',
  LyXZeroWidthSpace: 'allowbreak', lyxarrow: 'menuseparator', '-': 'softhyphen',
};
const CITE_CMDS = new Set([
  'cite', 'citet', 'citep', 'citealt', 'citealp', 'citeauthor', 'citeyear', 'citeyearpar', 'nocite', 'Citet', 'Citep', 'Citealt', 'Citealp', 'Citeauthor',
  'Cite', 'citetitle', 'fullcite', 'footcite', 'footcitetext', 'autocite', 'Autocite', 'textcite', 'Textcite', 'parencite', 'Parencite', 'supercite',
  'smartcite', 'Smartcite', 'citedate', 'citeurl', 'citenum',
]);
const REF_CMDS = new Set(['ref', 'eqref', 'pageref', 'vref', 'vpageref', 'nameref', 'cref', 'Cref', 'labelcref', 'autoref', 'prettyref', 'cpageref', 'Cpageref']);
/** refstyle-like \Xref commands (X = label prefix) */
const REFSTYLE_PREFIXES = new Set(['sec', 'subsec', 'fig', 'tab', 'eq', 'thm', 'lem', 'cor', 'prop', 'def', 'alg', 'chap', 'app', 'enu', 'fn', 'lst', 'par']);
const ACCENTS = new Set(['"', "'", '`', '^', '~', '=', '.', 'u', 'v', 'H', 't', 'c', 'd', 'b', 'k', 'r']);
const NEWPAGE_CMDS: Record<string, string> = { newpage: 'newpage', pagebreak: 'pagebreak', clearpage: 'clearpage', cleardoublepage: 'cleardoublepage', nopagebreak: 'nopagebreak' };
const VSPACE_CMDS: Record<string, string> = { smallskip: 'smallskip', medskip: 'medskip', bigskip: 'bigskip', vfill: 'vfill' };
const CHAR_CMDS: Record<string, string> = {
  '{': '{', '}': '}', '$': '$', '&': '&', '%': '%', '#': '#', '_': '_', textbackslash: '\\', textasciitilde: '~', textasciicircum: '^',
  textquotedbl: '"', textless: '<', textgreater: '>', textbar: '|', textunderscore: '_', textbraceleft: '{', textbraceright: '}', textdollar: '$',
  textcompwordmark: '\u200c',
};
/** quote commands → the character they print; the inset (style/side/level) follows the document's quote style */
const QUOTE_CMDS: Record<string, number> = {
  textquotedblleft: 0x201c, textquotedblright: 0x201d, textquoteleft: 0x2018, textquoteright: 0x2019, glqq: 0x201e, grqq: 0x201c, glq: 0x201a, grq: 0x2018,
  flqq: 0x00ab, frqq: 0x00bb, flq: 0x2039, frq: 0x203a, quotedblbase: 0x201e, quotesinglbase: 0x201a, guillemotleft: 0x00ab, guillemotright: 0x00bb,
  guilsinglleft: 0x2039, guilsinglright: 0x203a,
};
/** [left double, right double, left single, right single] per LyX quote style (InsetQuotes) */
const QUOTE_STYLES: Record<string, [number, number, number, number]> = {
  e: [0x201c, 0x201d, 0x2018, 0x2019], s: [0x201d, 0x201d, 0x2019, 0x2019], g: [0x201e, 0x201c, 0x201a, 0x2018], p: [0x201e, 0x201d, 0x201a, 0x2019],
  c: [0x00ab, 0x00bb, 0x2039, 0x203a], a: [0x00bb, 0x00ab, 0x203a, 0x2039], q: [0x0022, 0x0022, 0x0027, 0x0027], b: [0x2018, 0x2019, 0x201c, 0x201d],
  w: [0x00bb, 0x00bb, 0x2019, 0x2019], f: [0x00ab, 0x00bb, 0x201c, 0x201d], i: [0x00ab, 0x00bb, 0x00ab, 0x00bb], r: [0x00ab, 0x00bb, 0x201e, 0x201c],
  k: [0x300c, 0x300d, 0x300e, 0x300f], j: [0x300a, 0x300b, 0x3008, 0x3009], h: [0x201e, 0x201d, 0x00bb, 0x00ab],
};

/* ------------------------------------------------------------ state */

interface State { font: FontState; change?: Change }

interface TextCtx {
  pars: Paragraph[];
  /** layout and depth of the next paragraph */
  layout: string;
  depth: number;
  /** depth of an environment started here */
  nestDepth: number;
  /** layout of the enclosing environment, null outside environments */
  envLayout: string | null;
  /** the enclosing item environment (\item starts a new paragraph) */
  itemStyle: LayoutStyle | null;
  cur: Paragraph | null;
  align: string | null;
  noindent: boolean;
  appendix: boolean;
  owner: 'main' | 'float' | 'inset' | 'cell';
  float?: TextInset;
  /** the default layout of this text ('Standard' or 'Plain Layout') */
  base: string;
  /** "[" written as raw LaTeX after an unknown command, not closed yet */
  openBrackets: number;
  /** the next blank is dropped (after an inset the writer puts on its own line) */
  skipSpace: boolean;
}

interface Stop { close?: boolean; env?: string; item?: boolean; cell?: boolean }
type StopReason = 'eof' | 'close' | 'end' | 'item' | 'amp' | 'newrow';

const cloneState = (st: State): State => ({ font: { ...st.font }, change: st.change ? { ...st.change } : undefined });

function newCtx(base: string, owner: TextCtx['owner'] = 'inset'): TextCtx {
  return { pars: [], layout: base, depth: 0, nestDepth: 0, envLayout: null, itemStyle: null, cur: null, align: null, noindent: false, appendix: false, owner, base, openBrackets: 0, skipSpace: false };
}

/** asctime(gmtime(t)) → unix seconds ("Tue Aug 26 14:03:00 2026"). */
export function parseAsctime(s: string): number {
  const m = /^\s*(?:\w{3})\s+(\w{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})\s*$/.exec(s);
  if (!m) { const n = Number(s); if (Number.isFinite(n)) return n; const d = Date.parse(s); return Number.isNaN(d) ? 0 : Math.floor(d / 1000); }
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const mon = months.indexOf(m[1]);
  return Math.floor(Date.UTC(Number(m[6]), mon < 0 ? 0 : mon, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])) / 1000);
}

/** "0.9\columnwidth" → "90col%", "3cm" → "3cm" (Length::asLatexString inverted). */
export function lyxLength(s: string): string {
  const t = s.trim();
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+))\s*\\(textwidth|columnwidth|paperwidth|linewidth|textheight|paperheight|baselineskip)$/.exec(t);
  if (m) {
    const units: Record<string, string> = { textwidth: 'text%', columnwidth: 'col%', paperwidth: 'page%', linewidth: 'line%', textheight: 'theight%', paperheight: 'pheight%', baselineskip: 'baselineskip%' };
    const v = parseFloat(m[1]) * 100;
    return `${Number(v.toFixed(4))}${units[m[2]]}`;
  }
  const m2 = /^\\(textwidth|columnwidth|paperwidth|linewidth|textheight|paperheight)$/.exec(t);
  if (m2) return '100' + { textwidth: 'text%', columnwidth: 'col%', paperwidth: 'page%', linewidth: 'line%', textheight: 'theight%', paperheight: 'pheight%' }[m2[1]];
  return t;
}

/* ------------------------------------------------------------ parser */

/** The header line of a note block (`%% @note`, `%% @comment collapsed`, …) as the scanner sees it (first `%` removed). */
const NOTE_HEADER = /^% @(note|comment|greyedout)(?:\s+(open|collapsed))?\s*$/;
/** the closer of a note block (`%% @end`); older files have none — a note then ends at the first line that is not `%% …` */
const NOTE_END = /^% @end\s*$/;

class BodyParser {
  warnings: string[] = [];
  authors = new Map<number, { name: string; email: string }>();
  private cmdStyles = new Map<string, LayoutStyle[]>();
  private envStyles = new Map<string, LayoutStyle>();
  private cmdInsets = new Map<string, InsetLayout>();
  private envInsets = new Map<string, InsetLayout>();
  private unicodeRev = new Map<string, string>();
  private babelToLang = new Map<string, string>();
  private pendingBibStyle = '';
  private pendingNociteAll = false;
  private envStack: string[] = [];
  private quoteStyle: string;

  constructor(readonly dc: DocumentClass, unicode: UnicodeDB, langs: LanguageDB, readonly facts: PreambleFacts, private readonly settings: { language: string; quotes: string }) {
    for (const [, s] of dc.styles) {
      if (s.obsoletedBy || !s.latexName || s.latexName === 'dummy') continue;
      if (s.latexType === 'Command') { const list = this.cmdStyles.get(s.latexName) ?? []; list.push(s); this.cmdStyles.set(s.latexName, list); }
      else if (s.latexType !== 'Paragraph') { if (!this.envStyles.has(s.latexName)) this.envStyles.set(s.latexName, s); }
    }
    for (const [, il] of dc.insetLayouts) {
      if (il.obsoletedBy || !il.latexName) continue;
      const map = il.latexType === 'command' ? this.cmdInsets : il.latexType === 'environment' ? this.envInsets : null;
      if (map && !map.has(il.latexName)) map.set(il.latexName, il);
    }
    for (const [code, sym] of unicode) {
      if (!sym.textCommand || sym.combining) continue;
      const key = sym.textCommand.replace(/\{\}$/, '');
      if (!this.unicodeRev.has(key)) this.unicodeRev.set(key, String.fromCodePoint(code));
    }
    for (const [name, l] of langs) if (l.babel && !this.babelToLang.has(l.babel)) this.babelToLang.set(l.babel, name);
    const styleChar: Record<string, string> = { english: 'e', swedish: 's', german: 'g', polish: 'p', swiss: 'c', danish: 'a', plain: 'q', british: 'b', swedishg: 'w', french: 'f', frenchin: 'i', russian: 'r', cjk: 'k', cjkangle: 'j', hungarian: 'h' };
    this.quoteStyle = styleChar[settings.quotes] ?? 'e';
  }

  /** The Quotes inset for a quotation mark character in the document's quote style. */
  private quoteInset(code: number): Inset {
    const table = QUOTE_STYLES[this.quoteStyle] ?? QUOTE_STYLES.e;
    let idx = table.indexOf(code);
    let style = this.quoteStyle;
    if (idx < 0) {
      // not a quote of this style: the first style that has it
      for (const [st, t] of Object.entries(QUOTE_STYLES)) { const i = t.indexOf(code); if (i >= 0) { idx = i; style = st; break; } }
    }
    if (idx < 0) { idx = 0; style = 'e'; }
    return { type: 'Leaf', name: 'Quotes', arg: style + (idx % 2 === 0 ? 'l' : 'r') + (idx < 2 ? 'd' : 's'), params: [] };
  }

  /** A title-block paragraph (Title, Author, Date, ...) parsed so far — what \maketitle is regenerated from. */
  private hasTitlePar(ctx: TextCtx): boolean {
    return ctx.pars.some(p => this.dc.styles.get(p.layout)?.inTitle === true);
  }

  authorId(name: string): number {
    const id = lyxAuthorId(name, '');
    if (!this.authors.has(id)) this.authors.set(id, { name, email: '' });
    return id;
  }

  /* ---------------------------------------------------------- paragraphs */

  private ensurePar(ctx: TextCtx): Paragraph {
    if (ctx.cur) return ctx.cur;
    const p: Paragraph = { layout: ctx.layout, depth: ctx.depth, params: {}, items: [] };
    if (ctx.align) p.params.align = ctx.align;
    if (ctx.noindent) { p.params.noindent = true; ctx.noindent = false; }
    if (ctx.appendix) { p.params.start_of_appendix = true; ctx.appendix = false; }
    ctx.pars.push(p);
    ctx.cur = p;
    return p;
  }

  private newPar(ctx: TextCtx, layout: string, depth: number, params: ParagraphParams = {}): Paragraph {
    this.endPar(ctx);
    const p: Paragraph = { layout, depth, params: { ...params }, items: [] };
    if (ctx.align && !p.params.align) p.params.align = ctx.align;
    if (ctx.noindent) { p.params.noindent = true; ctx.noindent = false; }
    if (ctx.appendix) { p.params.start_of_appendix = true; ctx.appendix = false; }
    ctx.pars.push(p);
    ctx.cur = p;
    return p;
  }

  private endPar(ctx: TextCtx): void {
    const p = ctx.cur;
    ctx.skipSpace = false;
    if (!p) return;
    // TeX ignores blanks at the end of a paragraph (a tracked change is kept)
    while (p.items.length) {
      const last = p.items[p.items.length - 1];
      if (last.kind !== 'text' || last.change) break;
      last.text = last.text.replace(/ +$/, '');
      if (last.text) break;
      p.items.pop();
    }
    ctx.cur = null;
  }

  private freeSpacing(ctx: TextCtx): boolean {
    const st = this.dc.styles.get(ctx.cur?.layout ?? ctx.layout);
    return !!st && st.freeSpacing && !st.passThru;
  }

  private pushText(ctx: TextCtx, st: State, text: string, keepBlank = false): void {
    if (!text) return;
    if (text === ' ' && !keepBlank) {
      // no blanks at the start of a paragraph, no double blanks (and no paragraph made of blanks),
      // none right after an inset the writer puts on a line of its own
      if (!ctx.cur) return;
      if (ctx.skipSpace) return;
      const last = ctx.cur.items[ctx.cur.items.length - 1];
      if (!last) return;
      if (last.kind === 'text' && last.text.endsWith(' ') && sameFont(last.font, st.font) && sameChange(last.change, st.change)) return;
    }
    ctx.skipSpace = false;
    const p = this.ensurePar(ctx);
    const last = p.items[p.items.length - 1];
    if (last && last.kind === 'text' && sameFont(last.font, st.font) && sameChange(last.change, st.change)) { last.text += text; return; }
    const it: Item = { kind: 'text', text, font: { ...st.font } };
    if (st.change) it.change = { ...st.change };
    p.items.push(it);
  }

  private pushInset(ctx: TextCtx, st: State, inset: Inset): void {
    const it: Item = { kind: 'inset', inset, font: { ...st.font } };
    if (st.change) it.change = { ...st.change };
    const p = this.ensurePar(ctx);
    if (ownLineBefore(inset)) {
      let last = p.items[p.items.length - 1];
      if (last && last.kind === 'text' && !last.change) { last.text = last.text.replace(/ +$/, ''); if (!last.text) p.items.pop(); }
      // a line break right before display math does nothing in LaTeX; the writer adds one itself
      // inside struck-out text
      last = p.items[p.items.length - 1];
      if (inset.type === 'Formula' && last && last.kind === 'inset' && last.inset.type === 'Leaf' && last.inset.name === 'Newline' && last.inset.arg === 'newline') p.items.pop();
    }
    p.items.push(it);
    ctx.skipSpace = ownLineAfter(inset);
  }

  private pushSpecial(ctx: TextCtx, st: State, arg: string): void {
    const it: Item = { kind: 'special', token: '\\SpecialChar', arg, font: { ...st.font } };
    if (st.change) it.change = { ...st.change };
    this.ensurePar(ctx).items.push(it);
    ctx.skipSpace = false;
  }

  /** Raw LaTeX: appended to a directly preceding ERT inset when possible. */
  private pushERT(ctx: TextCtx, st: State, text: string): void {
    if (!text) return;
    const p = this.ensurePar(ctx);
    ctx.skipSpace = false;
    const last = p.items[p.items.length - 1];
    if (last && last.kind === 'inset' && last.inset.type === 'Text' && last.inset.name === 'ERT' && sameFont(last.font, st.font) && sameChange(last.change, st.change)) {
      const pars = last.inset.paragraphs;
      const lp = pars[pars.length - 1];
      const lastText = lp.items.length ? (lp.items[lp.items.length - 1] as { text?: string }).text ?? '' : '';
      if (hasComment(lastText)) { appendErtLines(pars, text); return; }
      appendErtText(lp, text);
      if (text.includes('\n')) { const merged = ertText(pars); pars.splice(0, pars.length, ...ertParagraphs(merged)); }
      return;
    }
    this.pushInset(ctx, st, { type: 'Text', name: 'ERT', arg: '', params: [], status: 'collapsed', paragraphs: ertParagraphs(text) });
  }

  /* ---------------------------------------------------------- main loop */

  parseBody(text: string): Paragraph[] {
    const s = new Scanner(text);
    const ctx = newCtx('Standard', 'main');
    this.parseText(s, ctx, { font: {} }, {});
    this.endPar(ctx);
    return ctx.pars;
  }

  private parseText(s: Scanner, ctx: TextCtx, st: State, stop: Stop): StopReason {
    for (;;) {
      const t = s.next();
      switch (t.kind) {
        case 'eof': return 'eof';
        case 'par': this.endPar(ctx); continue;
        case 'space': this.pushText(ctx, st, ' '); continue;
        case 'text': this.handleText(ctx, st, t.value); continue;
        case 'open': {
          // a group right after raw LaTeX ending in ^ or _ is the script's argument: keep the
          // braces raw too, or "x_{J}^{r1}" comes back as the wrong "x_J^r1"
          const script = lastERTEndsWithScript(ctx);
          if (script) this.pushERT(ctx, st, '{');
          const r = this.parseText(s, ctx, cloneState(st), { ...stop, close: true, item: false });
          if (script) this.pushERT(ctx, st, '}');
          if (r === 'close' || r === 'eof') continue;
          return r;   // \end / \item / cell separator inside a group: propagate
        }
        case 'close':
          if (stop.close) return 'close';
          continue;   // a stray brace
        case 'math': this.handleMath(s, ctx, st); continue;
        case 'amp':
          if (stop.cell) return 'amp';
          this.pushERT(ctx, st, '&');
          continue;
        case 'tilde':
          // in a free-spacing layout (LyX-Code) the writer puts ~ for every blank: read it back as one
          if (this.freeSpacing(ctx)) { this.pushText(ctx, st, ' ', true); continue; }
          this.pushInset(ctx, st, { type: 'Leaf', name: 'space', arg: '~', params: [] });
          continue;
        case 'sup': case 'sub': case 'hash': this.pushERT(ctx, st, t.value); continue;
        case 'comment': this.handleComment(s, ctx, st, t); continue;
        case 'cs': {
          const r = this.handleCommand(s, ctx, st, t, stop);
          if (r) return r;
          continue;
        }
      }
    }
  }

  private handleText(ctx: TextCtx, st: State, v: string): void {
    let buf = '';
    const flush = () => { if (buf) { this.pushText(ctx, st, buf); buf = ''; } };
    for (let i = 0; i < v.length; i++) {
      const c = v[i];
      // a bracket right after raw LaTeX is probably an optional argument of it: keep it raw,
      // together with the bracket closing it (LyX would write a literal "{[}")
      if (c === '[' && !buf && lastIsERT(ctx)) { this.pushERT(ctx, st, '['); ctx.openBrackets++; continue; }
      if (c === ']' && ctx.openBrackets > 0) { flush(); this.pushERT(ctx, st, ']'); ctx.openBrackets--; continue; }
      if (c === '-' && v[i + 1] === '-') {
        if (v[i + 2] === '-') { buf += '\u2014'; i += 2; } else { buf += '\u2013'; i += 1; }
        continue;
      }
      if (c === '`') {
        flush();
        if (v[i + 1] === '`') { this.pushInset(ctx, st, this.quoteInset(0x201c)); i++; }
        else this.pushInset(ctx, st, this.quoteInset(0x2018));
        continue;
      }
      if (c === "'" && v[i + 1] === "'") {
        flush();
        this.pushInset(ctx, st, this.quoteInset(0x201d));
        i++;
        continue;
      }
      buf += c;
    }
    flush();
  }

  private handleMath(s: Scanner, ctx: TextCtx, st: State): void {
    if (s.peekChar() === '$') {
      // $$ ... $$ display math
      s.pos++;
      const inner = s.readUntil('$$');
      if (inner === null) { this.pushERT(ctx, st, '$$'); return; }
      this.pushInset(ctx, st, { type: 'Formula', inline: false, latex: '\\[\n' + inner.trim() + '\n\\]' });
      return;
    }
    const save = s.pos;
    const inner = s.readDollarMath();
    if (inner === null) { s.pos = save; this.pushERT(ctx, st, '$'); return; }
    this.pushInset(ctx, st, { type: 'Formula', inline: true, latex: '$' + inner + '$' });
  }

  private handleComment(s: Scanner, ctx: TextCtx, st: State, t: Tok): void {
    const v = t.value;
    const m = NOTE_HEADER.exec(v);
    if (m) {
      // an OverLyX note block: the following "%% " lines are its LaTeX content
      const lines: string[] = [];
      for (;;) {
        const save = s.pos;
        const n = s.next();
        // "%% @end" closes the note; a "%% @note" line at this level starts the next note (nested ones carry another "%% ")
        if (n.kind === 'comment' && NOTE_END.test(n.value)) break;
        if (n.kind === 'comment' && n.value.startsWith('%') && !NOTE_HEADER.test(n.value)) { lines.push(n.value.slice(1).replace(/^ /, '')); continue; }
        s.pos = save;
        break;
      }
      const kind = m[1] === 'note' ? 'Note' : m[1] === 'comment' ? 'Comment' : 'Greyedout';
      const pars = this.parseInsetString(lines.join('\n'), 'Plain Layout');
      // "%% @note collapsed": the note is shown folded (LyX's "status collapsed"); open otherwise
      this.pushInset(ctx, st, { type: 'Text', name: 'Note', arg: kind, params: [], status: m[2] === 'collapsed' ? 'collapsed' : 'open', paragraphs: pars });
      return;
    }
    if (v.trim() === '') return;   // "%\n" = line continuation
    this.pushERT(ctx, st, '%' + v);
  }

  /** Parse a LaTeX string as the content of an inset (a fresh text context). */
  private parseInsetString(text: string, base: string, owner: TextCtx['owner'] = 'inset'): Paragraph[] {
    const s = new Scanner(text);
    const ctx = newCtx(base, owner);
    this.parseText(s, ctx, { font: {} }, {});
    this.endPar(ctx);
    if (!ctx.pars.length) ctx.pars.push({ layout: base, depth: 0, params: {}, items: [] });
    return ctx.pars;
  }

  /** Parse a `{...}` group (or the rest until `}` at the scanner position) as inset content. */
  private parseInsetGroup(s: Scanner, base: string, st?: State, owner: TextCtx['owner'] = 'inset', float?: TextInset): Paragraph[] {
    const ctx = newCtx(base, owner);
    ctx.float = float;
    const inner: State = { font: {}, change: st?.change ? { ...st.change } : undefined };
    if (s.peekChar() === '{' || (s.skipBlanks(), s.peekChar() === '{')) {
      s.pos++;
      this.parseText(s, ctx, inner, { close: true });
    }
    this.endPar(ctx);
    if (!ctx.pars.length) ctx.pars.push({ layout: base, depth: 0, params: {}, items: [] });
    return ctx.pars;
  }

  /** Parse environment content until \end{name} as inset content. */
  private parseInsetEnv(s: Scanner, name: string, base: string, st?: State, owner: TextCtx['owner'] = 'inset', float?: TextInset): Paragraph[] {
    const ctx = newCtx(base, owner);
    ctx.float = float;
    const inner: State = { font: {}, change: st?.change ? { ...st.change } : undefined };
    this.envStack.push(name);
    this.parseText(s, ctx, inner, { env: name });
    this.envStack.pop();
    this.endPar(ctx);
    if (!ctx.pars.length) ctx.pars.push({ layout: base, depth: 0, params: {}, items: [] });
    return ctx.pars;
  }

  /* ---------------------------------------------------------- commands */

  private handleCommand(s: Scanner, ctx: TextCtx, st: State, t: Tok, stop: Stop): StopReason | null {
    let name = t.value;
    // \begin / \end
    if (name === 'begin') {
      const env = s.readGroup();
      if (env === null) { this.pushERT(ctx, st, '\\begin'); return null; }
      this.handleEnvironment(s, ctx, st, env.trim());
      return null;
    }
    if (name === 'end') {
      const save = s.pos;
      const env = s.readGroup();
      if (env !== null && stop.env === env.trim()) return 'end';
      if (env !== null && this.envStack.includes(env.trim())) {
        // an \end for an outer environment: this level is done (unbalanced input)
        s.pos = save;
        return stop.env !== undefined ? 'end' : null;
      }
      this.pushERT(ctx, st, env === null ? '\\end' : `\\end{${env}}`);
      return null;
    }
    if (name === 'item') {
      if (stop.item) return 'item';
      const opt = s.readOptional();
      this.pushERT(ctx, st, '\\item' + (opt !== null ? `[${opt}]` : '') + (t.spaceAfter ? ' ' : ''));
      return null;
    }
    if (name === '\\') {
      if (stop.cell) { s.readOptional(); return 'newrow'; }
      const opt = s.readOptional();
      if (opt !== null) this.pushERT(ctx, st, `\\\\[${opt}]`);
      else { s.readStar(); this.pushInset(ctx, st, { type: 'Leaf', name: 'Newline', arg: 'newline', params: [] }); }
      return null;
    }
    if (name === 'par') { this.endPar(ctx); return null; }
    if (name === 'protect' || name === 'relax' || name === 'ignorespaces' || name === 'unskip' || name === 'leavevmode') return null;
    if (name === 'makeatletter') { s.atLetter = true; this.pushERT(ctx, st, '\\makeatletter' + (t.spaceAfter ? ' ' : '')); return null; }
    if (name === 'makeatother') { s.atLetter = false; this.pushERT(ctx, st, '\\makeatother' + (t.spaceAfter ? ' ' : '')); return null; }

    // starred variants of layout commands (\section*)
    const starred = s.peekChar() === '*';
    if (starred && (this.cmdStyles.has(name + '*') || this.cmdInsets.has(name + '*'))) { s.pos++; name += '*'; }

    // change tracking
    if (name === 'lyxadded' || name === 'lyxdeleted') {
      s.readOptional();
      const author = s.readGroup() ?? 'Unknown';
      const time = s.readGroup() ?? '0';
      const change: Change = { type: name === 'lyxadded' ? 'inserted' : 'deleted', author: this.authorId(author.trim()), time: parseAsctime(time) };
      s.skipBlanks();
      if (s.peekChar() === '{') {
        const end = groupEnd(s.s, s.pos);
        const inner = s.s.slice(s.pos + 1, end - 1);
        if (inner === '¶' || inner === '\\par') { s.pos = end; this.ensurePar(ctx).endChange = change; return null; }
        s.pos++;
        const r = this.parseText(s, ctx, { font: { ...st.font }, change }, { ...stop, close: true, item: false });
        if (r !== 'close' && r !== 'eof') return r;
      }
      return null;
    }
    if (name === 'lyxobjdeleted' || name === 'lyxdisplayobjdeleted' || name === 'lyxudisplayobjdeleted') {
      s.readGroup(); s.readGroup();
      const author = 'Unknown';
      const change: Change = { type: 'deleted', author: this.authorId(author), time: 0 };
      s.skipBlanks();
      if (s.peekChar() === '{') { s.pos++; this.parseText(s, ctx, { font: { ...st.font }, change }, { close: true }); }
      return null;
    }

    // the class's title command (\maketitle & co) is regenerated by the writer — but only from
    // title-block paragraphs; with the title in the user preamble there are none: keep it verbatim
    if (name === this.dc.titleLatexName && this.dc.titleLatexType === 'CommandAfter') {
      if (s.peekChar() === '{' && s.peekChar(1) === '}') s.pos += 2;
      if (!this.hasTitlePar(ctx)) this.pushERT(ctx, st, '\\' + name);
      this.endPar(ctx);
      return null;
    }

    // paragraph layouts (commands); several styles may share a LaTeX name and differ in a parameter
    // (KOMA's \setkomavar{fromname}{...}): the one whose parameter follows wins
    const styles = this.cmdStyles.get(name);
    if (styles) {
      let style = styles.find(x => !x.latexParam);
      for (const cand of styles) {
        if (!cand.latexParam) continue;
        const save = s.pos;
        s.skipBlanks();
        if (s.s.startsWith(cand.latexParam, s.pos)) { s.pos += cand.latexParam.length; style = cand; break; }
        s.pos = save;
      }
      if (style) { this.handleCommandLayout(s, ctx, st, style); return null; }
    }

    // insets defined by inset layouts (\footnote, \caption, \url, \code, ...)
    const il = this.cmdInsets.get(name);
    if (il) { this.handleInsetCommand(s, ctx, st, il); return null; }

    // fonts
    const fc = FONT_CMDS[name];
    if (fc) {
      const inner: State = { font: { ...st.font, ...fc }, change: st.change };
      if (name === 'emph' && st.font.emph === 'on') inner.font.emph = 'off';
      s.skipBlanks();
      if (s.peekChar() === '{') { s.pos++; const r = this.parseText(s, ctx, inner, { ...stop, close: true, item: false }); if (r !== 'close' && r !== 'eof') return r; }
      return null;
    }
    const decl = FONT_DECLS[name];
    if (decl) { Object.assign(st.font, decl); if (name === 'em') st.font.emph = st.font.emph === 'on' ? 'off' : 'on'; return null; }
    const size = SIZE_DECLS[name];
    if (size) { st.font.size = size; return null; }
    if (name === 'textcolor' || name === 'color') {
      // \textcolor{name} (LyX's named colours) or \textcolor[HTML|rgb|RGB|gray]{spec} (the colour
      // picker): custom colours are kept as '#rrggbb' in the font
      const model = s.readOptional();
      const c = s.readGroup();
      if (c === null) { this.pushERT(ctx, st, '\\' + name + (model !== null ? `[${model}]` : '')); return null; }
      const color = model === null ? c.trim() : colorFromModel(model.trim(), c.trim());
      if (color === null) { this.pushERT(ctx, st, `\\${name}[${model}]{${c}}`); return null; }
      if (name === 'color') { st.font.color = color; return null; }
      const inner: State = { font: { ...st.font, color }, change: st.change };
      s.skipBlanks();
      if (s.peekChar() === '{') { s.pos++; const r = this.parseText(s, ctx, inner, { ...stop, close: true, item: false }); if (r !== 'close' && r !== 'eof') return r; }
      return null;
    }
    if (name === 'foreignlanguage' || name === 'textlang') {
      const lang = s.readGroup();
      const lyxLang = lang === null ? undefined : this.babelToLang.get(lang.trim()) ?? lang.trim();
      const inner: State = { font: { ...st.font, lang: lyxLang }, change: st.change };
      s.skipBlanks();
      if (s.peekChar() === '{') { s.pos++; const r = this.parseText(s, ctx, inner, { ...stop, close: true, item: false }); if (r !== 'close' && r !== 'eof') return r; }
      return null;
    }
    if (name === 'selectlanguage') {
      const lang = s.readGroup();
      if (lang !== null) st.font.lang = this.babelToLang.get(lang.trim()) ?? lang.trim();
      return null;
    }

    // math
    if (name === '(') {
      const inner = s.readUntil('\\)');
      if (inner === null) { this.pushERT(ctx, st, '\\('); return null; }
      this.pushInset(ctx, st, { type: 'Formula', inline: true, latex: '\\(' + inner + '\\)' });
      return null;
    }
    if (name === '[') {
      const inner = s.readUntil('\\]');
      if (inner === null) { this.pushERT(ctx, st, '\\['); return null; }
      this.pushInset(ctx, st, { type: 'Formula', inline: false, latex: '\\[' + inner + '\\]' });
      return null;
    }
    if (name === 'ensuremath') {
      const g = s.readGroup();
      if (g !== null) this.pushInset(ctx, st, { type: 'Formula', inline: true, latex: '\\ensuremath{' + g + '}' });
      else this.pushERT(ctx, st, '\\ensuremath');
      return null;
    }

    // macro definitions in the body → FormulaMacro insets
    if (/^(?:newcommand|renewcommand|providecommand|newcommandx|renewcommandx|def|global|long|DeclareMathOperator)\*?$/.test(name)) {
      const start = t.start;
      const def = readMacroDefinition(s.s, start);
      if (def) {
        s.pos = def.end;
        const lines = [def.text];
        // "...}%% @display {…}": the display form of the macro (LyX's second line) — see latexMacro
        const eol = s.s.indexOf('\n', s.pos);
        const rest = s.s.slice(s.pos, eol < 0 ? s.s.length : eol);
        const dm = /^%% @display (\{.*\})\s*$/.exec(rest);
        if (dm) { lines.push(dm[1]); s.pos += rest.length; }
        // a trailing "%" (LyX writes "...}%\n") is part of the definition line
        else if (s.s[s.pos] === '%' && s.s[s.pos + 1] === '\n') s.pos += 1;   // the newline stays: a blank line after it is a paragraph break
        this.pushInset(ctx, st, { type: 'FormulaMacro', lines });
        return null;
      }
    }

    // spaces, breaks, pages
    const sp = SPACE_CMDS[name];
    if (sp !== undefined) {
      if (s.peekChar() === '{' && s.peekChar(1) === '}') s.pos += 2;
      this.pushInset(ctx, st, { type: 'Leaf', name: 'space', arg: sp, params: [] });
      return null;
    }
    if (name === 'hspace') {
      const star = s.readStar();
      const len = s.readGroup();
      if (len === null) { this.pushERT(ctx, st, '\\hspace' + (star ? '*' : '')); return null; }
      if (star && len.trim() === '\\fill') { this.pushInset(ctx, st, { type: 'Leaf', name: 'space', arg: '\\hspace*{\\fill}', params: [] }); return null; }
      this.pushInset(ctx, st, { type: 'Leaf', name: 'space', arg: star ? '\\hspace*{}' : '\\hspace{}', params: ['\\length ' + lyxLength(len)] });
      return null;
    }
    if (name === 'newline') { this.pushInset(ctx, st, { type: 'Leaf', name: 'Newline', arg: 'newline', params: [] }); return null; }
    if (name === 'linebreak') { s.readOptional(); if (s.peekChar() === '{' && s.peekChar(1) === '}') s.pos += 2; this.pushInset(ctx, st, { type: 'Leaf', name: 'Newline', arg: 'linebreak', params: [] }); return null; }
    const np = NEWPAGE_CMDS[name];
    if (np) { if (s.peekChar() === '{' && s.peekChar(1) === '}') s.pos += 2; this.pushInset(ctx, st, { type: 'Leaf', name: 'Newpage', arg: np, params: [] }); return null; }
    const vs = VSPACE_CMDS[name];
    if (vs) { if (s.peekChar() === '{' && s.peekChar(1) === '}') s.pos += 2; this.pushInset(ctx, st, { type: 'Leaf', name: 'VSpace', arg: vs, params: [] }); return null; }
    if (name === 'vspace') {
      const star = s.readStar();
      const len = s.readGroup();
      if (len === null) { this.pushERT(ctx, st, '\\vspace' + (star ? '*' : '')); return null; }
      const l = len.trim();
      const named: Record<string, string> = { '\\smallskipamount': 'smallskip', '\\medskipamount': 'medskip', '\\bigskipamount': 'bigskip', '\\fill': 'vfill', '.5\\baselineskip': 'halfline', '0.5\\baselineskip': 'halfline', '\\baselineskip': 'fullline' };
      this.pushInset(ctx, st, { type: 'Leaf', name: 'VSpace', arg: (named[l] ?? lyxLength(l)) + (star ? '*' : ''), params: [] });
      return null;
    }
    if (name === 'noindent') { if (ctx.cur && ctx.cur.items.length) this.pushERT(ctx, st, '\\noindent' + (t.spaceAfter ? ' ' : '')); else ctx.noindent = true; return null; }
    if (name === 'appendix') { this.endPar(ctx); ctx.appendix = true; return null; }
    if (name === 'centering' || name === 'raggedright' || name === 'raggedleft') {
      if (s.peekChar() === '{' && s.peekChar(1) === '}') s.pos += 2;
      const align = ALIGN_ENVS[name];
      if (ctx.float && !ctx.pars.length && !ctx.cur) { setParam(ctx.float.params, 'alignment', align); return null; }
      if (ctx.cur) ctx.cur.params.align = align;
      ctx.align = align;
      return null;
    }
    if (name === 'maketitle') {
      if (s.peekChar() === '{' && s.peekChar(1) === '}') s.pos += 2;
      if (!this.hasTitlePar(ctx)) this.pushERT(ctx, st, '\\maketitle');
      this.endPar(ctx);
      return null;
    }

    // special characters
    const ch = CHAR_CMDS[name];
    if (ch !== undefined) {
      if (name.length > 1 && s.peekChar() === '{' && s.peekChar(1) === '}') s.pos += 2;
      this.pushText(ctx, st, ch);
      return null;
    }
    const sc = SPECIAL_CMDS[name];
    if (sc) {
      if (s.peekChar() === '{' && s.peekChar(1) === '}') s.pos += 2;
      this.pushSpecial(ctx, st, sc);
      return null;
    }
    if (name === 'nobreakdash' && s.peekChar() === '-') { s.pos++; this.pushSpecial(ctx, st, 'nobreakdash'); return null; }
    if (name === '@' && s.peekChar() === '.') { s.pos++; this.pushSpecial(ctx, st, 'endofsentence'); return null; }
    const q = QUOTE_CMDS[name];
    if (q) { if (s.peekChar() === '{' && s.peekChar(1) === '}') s.pos += 2; this.pushInset(ctx, st, this.quoteInset(q)); return null; }
    if (ACCENTS.has(name)) {
      const r = this.readAccented(s, name);
      if (r !== null) { this.pushText(ctx, st, r); return null; }
    }
    // a command the user's preamble (re)defines is their macro, not the unicode symbol of that name
    const uni = this.facts.defined.has(name) ? undefined : this.unicodeRev.get('\\' + name);
    if (uni !== undefined && !(s.peekChar() === '{' && s.peekChar(1) !== '}')) {
      if (s.peekChar() === '{' && s.peekChar(1) === '}') s.pos += 2;
      this.pushText(ctx, st, uni);
      return null;
    }
    if (name === 'textquotedblplain') { this.pushText(ctx, st, '"'); return null; }

    // references, citations, labels, links
    if (name === 'label') {
      const g = s.readGroup();
      if (g === null) { this.pushERT(ctx, st, '\\label'); return null; }
      this.pushInset(ctx, st, { type: 'Leaf', name: 'CommandInset', arg: 'label', params: ['LatexCommand label', 'name ' + quote(g.trim())] });
      return null;
    }
    if (REF_CMDS.has(name) || (name.endsWith('ref') && REFSTYLE_PREFIXES.has(name.slice(0, -3)) && !this.facts.defined.has(name))) {
      const star = s.readStar();
      const opt = s.readOptional();
      const g = s.readGroup();
      if (g === null) { this.pushERT(ctx, st, '\\' + name + (star ? '*' : '') + (opt !== null ? `[${opt}]` : '')); return null; }
      const ref = g.trim();
      if (name === 'cref' || name === 'Cref' || name === 'prettyref' || name === 'autoref') {
        this.pushInset(ctx, st, refInset('formatted', ref, { caps: name === 'Cref', nolink: star }));
      } else if (!REF_CMDS.has(name)) {
        // \figref{x} (refstyle): formatted reference to "fig:x"
        const prefix = name.slice(0, -3);
        const plural = opt === 's';
        this.pushInset(ctx, st, refInset('formatted', ref.includes(':') ? ref : `${prefix.toLowerCase()}:${ref}`, { caps: prefix[0] === prefix[0].toUpperCase() && prefix[0] !== prefix[0].toLowerCase(), plural, nolink: star }));
      } else {
        const cmd = name === 'labelcref' ? 'formatted' : name === 'cpageref' || name === 'Cpageref' ? 'pageref' : name;
        this.pushInset(ctx, st, refInset(cmd, ref, { nolink: star }));
      }
      return null;
    }
    if (CITE_CMDS.has(name)) {
      const star = s.readStar();
      const opt1 = s.readOptional();
      const opt2 = opt1 !== null ? s.readOptional() : null;
      const g = s.readGroup();
      if (g === null) { this.pushERT(ctx, st, '\\' + name + (star ? '*' : '')); return null; }
      const key = g.replace(/\s+/g, '');
      if (name === 'nocite' && key === '*') { this.pendingNociteAll = true; return null; }
      const params = ['LatexCommand ' + name + (star ? '*' : '')];
      if (opt2 !== null) { params.push('after ' + quote(opt2), 'before ' + quote(opt1!)); }
      else if (opt1 !== null) params.push('after ' + quote(opt1));
      params.push('key ' + quote(key), 'literal "true"');
      this.pushInset(ctx, st, { type: 'Leaf', name: 'CommandInset', arg: 'citation', params });
      return null;
    }
    if (name === 'href') {
      const url = s.readGroup();
      const text = s.readGroup();
      if (url === null) { this.pushERT(ctx, st, '\\href'); return null; }
      let target = url.trim().replace(/\\%/g, '%').replace(/\\#/g, '#');
      const params = ['LatexCommand href'];
      const nameText = text === null ? '' : text.trim();
      if (nameText && nameText !== target) params.push('name ' + quote(nameText));
      let type = '';
      if (target.startsWith('mailto:')) { type = 'mailto:'; target = target.slice(7); }
      else if (target.startsWith('file:')) { type = 'file:'; target = target.slice(5); }
      params.push('target ' + quote(target));
      if (type) params.push('type ' + quote(type));
      params.push('literal "true"');
      this.pushInset(ctx, st, { type: 'Leaf', name: 'CommandInset', arg: 'href', params });
      return null;
    }
    if (name === 'input' || name === 'include' || name === 'verbatiminput' || name === 'lstinputlisting' || name === 'inputminted') {
      const star = s.readStar();
      const opt = name === 'lstinputlisting' ? s.readOptional() : null;
      if (name === 'inputminted') s.readGroup();
      const g = s.readGroup();
      if (g === null) { this.pushERT(ctx, st, '\\' + name + (star ? '*' : '')); return null; }
      const params = ['LatexCommand ' + name + (star ? '*' : ''), 'filename ' + quote(g.trim())];
      if (opt !== null) params.push('lstparams ' + quote(opt));
      params.push('literal "true"');
      this.pushInset(ctx, st, { type: 'Leaf', name: 'CommandInset', arg: 'include', params });
      return null;
    }
    if (name === 'bibliographystyle') { this.pendingBibStyle = (s.readGroup() ?? '').trim(); return null; }
    if (name === 'bibliography') {
      const g = s.readGroup() ?? '';
      const params = ['LatexCommand bibtex', `btprint "${this.pendingNociteAll ? 'btPrintAll' : 'btPrintCited'}"`, 'bibfiles ' + quote(g.replace(/\s+/g, '').replace(/\.bib(?=,|$)/g, ''))];
      const style = this.pendingBibStyle || this.facts.bibliographystyle;
      if (this.pendingBibStyle) params.push('options ' + quote(style));
      params.push('encoding "default"');
      this.pendingBibStyle = ''; this.pendingNociteAll = false;
      this.endPar(ctx);
      this.pushInset(ctx, st, { type: 'Leaf', name: 'CommandInset', arg: 'bibtex', params });
      this.endPar(ctx);
      return null;
    }
    if (name === 'printbibliography') {
      const opt = s.readOptional();
      const params = ['LatexCommand bibtex', `btprint "${this.pendingNociteAll ? 'btPrintAll' : 'btPrintCited'}"`, 'bibfiles ' + quote(this.facts.addbibresources.map(f => f.replace(/\.bib$/, '')).join(','))];
      if (opt) params.push('biblatexopts ' + quote(opt));
      params.push('encoding "default"');
      this.pendingNociteAll = false;
      this.endPar(ctx);
      this.pushInset(ctx, st, { type: 'Leaf', name: 'CommandInset', arg: 'bibtex', params });
      this.endPar(ctx);
      return null;
    }
    if (name === 'tableofcontents' || name === 'lstlistoflistings' || name === 'listoflistings') {
      if (s.peekChar() === '{' && s.peekChar(1) === '}') s.pos += 2;
      this.pushInset(ctx, st, { type: 'Leaf', name: 'CommandInset', arg: 'toc', params: ['LatexCommand ' + (name === 'listoflistings' ? 'lstlistoflistings' : name)] });
      return null;
    }
    if (name === 'listoffigures' || name === 'listoftables' || name === 'listofalgorithms') {
      if (s.peekChar() === '{' && s.peekChar(1) === '}') s.pos += 2;
      this.pushInset(ctx, st, { type: 'Leaf', name: 'FloatList', arg: name === 'listoffigures' ? 'figure' : name === 'listoftables' ? 'table' : 'algorithm', params: [] });
      return null;
    }
    if (name === 'printindex') {
      const opt = s.readOptional();
      if (s.peekChar() === '{' && s.peekChar(1) === '}') s.pos += 2;
      this.pushInset(ctx, st, { type: 'Leaf', name: 'CommandInset', arg: 'index_print', params: ['LatexCommand printindex', 'type ' + quote(opt ?? 'idx'), 'literal "true"'] });
      return null;
    }
    if (name === 'printnomenclature') {
      const opt = s.readOptional();
      if (s.peekChar() === '{' && s.peekChar(1) === '}') s.pos += 2;
      const params = ['LatexCommand printnomenclature', `set_width "${opt ? 'custom' : 'none'}"`];
      if (opt) params.push('width ' + quote(lyxLength(opt)));
      this.pushInset(ctx, st, { type: 'Leaf', name: 'CommandInset', arg: 'nomencl_print', params });
      return null;
    }
    if (name === 'nomenclature') {
      const prefix = s.readOptional();
      const sym = s.readGroup();
      const desc = s.readGroup();
      if (sym === null || desc === null) { this.pushERT(ctx, st, '\\nomenclature'); return null; }
      const params = ['LatexCommand nomenclature'];
      if (prefix) params.push('prefix ' + quote(prefix));
      params.push('symbol ' + quote(sym), 'description ' + quote(desc), 'literal "true"');
      this.pushInset(ctx, st, { type: 'Leaf', name: 'CommandInset', arg: 'nomenclature', params });
      return null;
    }
    if (name === 'index') {
      const opt = s.readOptional();
      const pars = this.parseInsetGroup(s, 'Plain Layout', st);
      this.pushInset(ctx, st, { type: 'Text', name: 'Index', arg: opt ?? 'idx', params: ['range none', 'pageformat default'], status: 'open', paragraphs: pars });
      return null;
    }
    if (name === 'includegraphics') {
      s.readStar();
      const opt = s.readOptional();
      const g = s.readGroup();
      if (g === null) { this.pushERT(ctx, st, '\\includegraphics'); return null; }
      this.pushInset(ctx, st, graphicsInset(g.trim(), opt ?? ''));
      return null;
    }
    if (name === 'mbox') {
      // \mbox{\ref{..}} is what the writer puts around references inside struck-out / tracked text:
      // the reference alone is the content
      const save = s.pos;
      const inner = this.parseInsetGroup(s, 'Plain Layout', st);
      if (inner.length === 1 && inner[0].items.length === 1 && inner[0].items[0].kind === 'inset' && inner[0].items[0].inset.type === 'Leaf' && inner[0].items[0].inset.name === 'CommandInset') {
        this.pushInset(ctx, st, inner[0].items[0].inset);
        return null;
      }
      s.pos = save;
    }
    if (name === 'fbox' || name === 'framebox') {
      // \fbox{\begin{minipage}...\end{minipage}}: LyX's boxed box
      const save = s.pos;
      s.skipBlanks();
      if (s.peekChar() === '{') {
        s.pos++;
        s.skipBlanks();
        if (/^\\begin\s*\{minipage\}/.test(s.s.slice(s.pos, s.pos + 20))) {
          s.pos += s.s.slice(s.pos).indexOf('{minipage}') + '{minipage}'.length;
          this.handleMinipage(s, ctx, st, 'Boxed');
          s.skipBlanks();
          if (s.peekChar() === '}') s.pos++;
          return null;
        }
      }
      s.pos = save;
    }
    if (name === 'phantom' || name === 'hphantom' || name === 'vphantom') {
      const pars = this.parseInsetGroup(s, 'Plain Layout', st);
      this.pushInset(ctx, st, { type: 'Text', name: 'Phantom', arg: name === 'hphantom' ? 'HPhantom' : name === 'vphantom' ? 'VPhantom' : 'Phantom', params: [], status: 'open', paragraphs: pars });
      return null;
    }
    if (name === 'verb') {
      const d = s.peekChar();
      if (d && d !== ' ') {
        const end = s.s.indexOf(d, s.pos + 1);
        if (end > 0) { this.pushERT(ctx, st, '\\verb' + s.s.slice(s.pos, end + 1)); s.pos = end + 1; return null; }
      }
    }
    if (name === 'rule') {
      const opt = s.readOptional();
      const w = s.readGroup();
      const h = s.readGroup();
      if (w !== null && h !== null) {
        const params = ['LatexCommand rule'];
        if (opt) params.push('offset ' + quote(lyxLength(opt)));
        params.push('width ' + quote(lyxLength(w)), 'height ' + quote(lyxLength(h)));
        this.pushInset(ctx, st, { type: 'Leaf', name: 'CommandInset', arg: 'line', params });
        return null;
      }
    }

    // verbatim arguments
    if (RAW_ARG_CMDS.has(name) || (name.endsWith('*') && RAW_ARG_CMDS.has(name.slice(0, -1)))) {
      let raw = '\\' + name + (s.readStar() ? '*' : '');
      for (;;) {
        const save = s.pos;
        s.skipBlanks();
        const c = s.peekChar();
        if (c === '{') { const e = groupEnd(s.s, s.pos); raw += s.s.slice(s.pos, e); s.pos = e; continue; }
        if (c === '[') { const o = s.readOptional(); if (o === null) { s.pos = save; break; } raw += `[${o}]`; continue; }
        if (c === '=' && name === 'let') { raw += '='; s.pos++; continue; }
        if (c === '\\' && (name === 'let' || name === 'newlength' || name === 'setlength' || name === 'addtolength')) {
          const m = /^\\([A-Za-z@]+|.)/.exec(s.s.slice(s.pos));
          if (m) { raw += m[0]; s.pos += m[0].length; continue; }
        }
        s.pos = save;
        break;
      }
      this.pushERT(ctx, st, raw + (s.s[s.pos - 1] !== '}' && s.s[s.pos - 1] !== ']' && t.spaceAfter ? ' ' : ''));
      return null;
    }

    // unknown command: ERT, its brace arguments parsed as text between ERT braces
    this.pushERT(ctx, st, '\\' + name + (s.readStar() ? '*' : ''));
    let first = true;
    for (;;) {
      const save = s.pos;
      s.skipBlanks();
      const c = s.peekChar();
      if (c === '[') { const o = s.readOptional(); if (o === null) { s.pos = save; break; } this.pushERT(ctx, st, `[${o}]`); first = false; continue; }
      if (c === '{') {
        s.pos++;
        this.pushERT(ctx, st, '{');
        const r = this.parseText(s, ctx, cloneState(st), { ...stop, close: true, item: false });
        this.pushERT(ctx, st, '}');
        first = false;
        if (r !== 'close' && r !== 'eof') return r;
        continue;
      }
      s.pos = save;
      break;
    }
    if (first && t.spaceAfter && /^[A-Za-z@]/.test(name) && !/^[{}[\s]/.test(s.peekChar() || ' ')) this.pushERT(ctx, st, ' ');
    return null;
  }

  private readAccented(s: Scanner, accent: string): string | null {
    const save = s.pos;
    let arg: string | null = null;
    if (s.peekChar() === '{') { const g = s.readGroup(); arg = g === null ? null : g; }
    else {
      const m = /^(\\[A-Za-z]+|\\.|[^\s\\{}])/.exec(s.s.slice(s.pos));
      if (m) { arg = m[1]; s.pos += m[1].length; }
    }
    if (arg === null || arg === '') { s.pos = save; return null; }
    const key = `\\${accent}{${arg}}`;
    const dotless = arg === 'i' ? '\\i' : arg === 'j' ? '\\j' : null;
    const hit = this.unicodeRev.get(key) ?? this.unicodeRev.get(`\\${accent}${arg}`) ?? (dotless ? this.unicodeRev.get(`\\${accent}{${dotless}}`) : undefined);
    if (hit !== undefined) return hit;
    s.pos = save;
    return null;
  }

  /** \section{...}-like commands: a paragraph of the style. */
  private handleCommandLayout(s: Scanner, ctx: TextCtx, st: State, style: LayoutStyle): void {
    const par = this.newPar(ctx, style.name, ctx.depth);
    const inner: State = { font: {}, change: st.change };
    for (const a of this.readArguments(s, style.args)) par.items.push({ kind: 'inset', font: {}, inset: a });
    s.skipBlanks();
    if (s.peekChar() === '{') {
      s.pos++;
      ctx.cur = par;
      this.parseText(s, ctx, inner, { close: true });
      ctx.cur = par;
    }
    this.absorbLabels(s, ctx, inner);
    this.endPar(ctx);
  }

  /**
   * The arguments declared by a layout ("1", "2", ... in order): mandatory ones as {...} (an empty
   * {} is a missing one), optional ones as [...]. Stops at the first argument that is not there.
   */
  private readArguments(s: Scanner, args: Map<string, import('../latex/layouts.ts').ArgumentSpec>, prefix = ''): TextInset[] {
    const out: TextInset[] = [];
    const ids = [...args.keys()].filter(id => (prefix ? id.startsWith(prefix) : !id.includes(':'))).map(id => parseInt(id.slice(prefix.length), 10)).filter(n => !Number.isNaN(n)).sort((a, b) => a - b);
    if (!ids.length) {
      // no declared arguments: keep [...] options anyway
      let n = 1;
      for (;;) { const o = s.readOptional(); if (o === null) break; out.push(argumentInset(String(n++), this.parseInsetString(o, 'Plain Layout'))); }
      return out;
    }
    const max = ids[ids.length - 1];
    for (let n = 1; n <= max; n++) {
      const spec = args.get(prefix + n);
      if (!spec) continue;
      if (spec.mandatory) {
        const save = s.pos;
        s.skipBlanks();
        // the last mandatory argument of a command layout is the paragraph itself
        if (s.peekChar() !== '{' || n === max && !prefix && this.lastMandatoryIsContent(args, max)) { s.pos = save; break; }
        const g = s.readGroup();
        if (g === null) { s.pos = save; break; }
        if (g.trim()) out.push(argumentInset(String(n), this.parseInsetString(g, 'Plain Layout')));
      } else {
        const o = s.readOptional();
        if (o === null) break;
        out.push(argumentInset(String(n), this.parseInsetString(o, 'Plain Layout')));
      }
    }
    return out;
  }

  /** LyX writes every declared argument before the paragraph's own braces: they are all arguments. */
  private lastMandatoryIsContent(_args: Map<string, unknown>, _max: number): boolean { return false; }

  /** \label{...} (and \index) directly after a heading or caption belongs to it. */
  private absorbLabels(s: Scanner, ctx: TextCtx, st: State): void {
    for (;;) {
      const save = s.pos;
      s.skipBlanks();
      const m = /^\\label\s*\{/.exec(s.s.slice(s.pos, s.pos + 12));
      if (!m) { s.pos = save; return; }
      s.pos += m[0].length - 1;
      const g = s.readGroup();
      if (g === null) { s.pos = save; return; }
      this.pushInset(ctx, st, { type: 'Leaf', name: 'CommandInset', arg: 'label', params: ['LatexCommand label', 'name ' + quote(g.trim())] });
    }
  }

  /** An inset defined by an inset layout with LatexType command. */
  private handleInsetCommand(s: Scanner, ctx: TextCtx, st: State, il: InsetLayout): void {
    const { name, arg } = insetNameOf(il);
    const args: TextInset[] = il.args.size ? this.readArguments(s, il.args) : (s.readOptional(), []);
    const base = name === 'Flex' && !il.forcePlain && il.multiPar ? 'Standard' : 'Plain Layout';
    const pars = this.parseInsetGroup(s, base, st);
    for (const a of args.reverse()) pars[0].items.unshift({ kind: 'inset', font: {}, inset: a });
    const inset: TextInset = { type: 'Text', name, arg, params: [], status: name === 'Foot' || name === 'Marginal' ? 'collapsed' : 'open', paragraphs: pars };
    if (name === 'Caption') inset.status = undefined;
    if (name === 'Index') inset.params = ['range none', 'pageformat default'];
    this.pushInset(ctx, st, inset);
    if (name === 'Caption') {
      // \caption{...}\label{...}: the label sits inside the caption in LyX
      const last = pars[pars.length - 1];
      const save = ctx.cur;
      const tmp: TextCtx = { ...newCtx('Plain Layout'), cur: last, pars };
      this.absorbLabels(s, tmp, { font: {} });
      ctx.cur = save;
    }
  }

  /* ---------------------------------------------------------- environments */

  private handleEnvironment(s: Scanner, ctx: TextCtx, st: State, env: string): void {
    if (MATH_ENVS.has(env)) {
      if (env === 'math') { const inner = s.readUntilEnd(env); this.pushInset(ctx, st, { type: 'Formula', inline: true, latex: '\\begin{math}' + inner + '\\end{math}' }); return; }
      const inner = s.readUntilEnd(env);
      this.pushInset(ctx, st, { type: 'Formula', inline: false, latex: `\\begin{${env}}${inner}\\end{${env}}` });
      return;
    }
    if (RAW_ENVS.has(env)) {
      const opt = env === 'lstlisting' || env === 'minted' || env === 'Verbatim' ? s.readOptional() : null;
      const lang = env === 'minted' ? s.readGroup() : null;
      const inner = s.readUntilEnd(env);
      this.endPar(ctx);
      this.pushERT(ctx, st, `\\begin{${env}}` + (opt !== null ? `[${opt}]` : '') + (lang !== null ? `{${lang}}` : '') + inner + `\\end{${env}}`);
      this.endPar(ctx);
      return;
    }
    if (TABULAR_ENVS.has(env)) {
      const start = s.pos;
      const tab = parseTabular(s, env, (text) => this.parseInsetString(text, 'Plain Layout', 'cell'));
      if (tab) { this.pushInset(ctx, st, tab); return; }
      s.pos = start;
      const inner = s.readUntilEnd(env);
      this.pushERT(ctx, st, `\\begin{${env}}${inner}\\end{${env}}`);
      return;
    }
    const align = ALIGN_ENVS[env];
    if (align) {
      this.endPar(ctx);
      const saved = ctx.align;
      ctx.align = align;
      this.envStack.push(env);
      this.parseText(s, ctx, cloneState(st), { env });
      this.envStack.pop();
      this.endPar(ctx);
      ctx.align = saved;
      return;
    }
    // floats: figure, table, figure*, sidewaysfigure, algorithm, ...
    const fl = this.floatOf(env);
    if (fl) {
      // a float is an inset inside the paragraph (LyX: the paragraph goes on after \end{figure})
      const placement = s.readOptional();
      const inset: TextInset = { type: 'Text', name: 'Float', arg: fl.type, params: [`placement ${placement !== null && placement.trim() ? placement.trim() : 'document'}`, 'alignment document', `wide ${fl.wide}`, `sideways ${fl.sideways}`], status: 'open', paragraphs: [] };
      inset.paragraphs = this.parseInsetEnv(s, env, 'Plain Layout', st, 'float', inset);
      this.pushInset(ctx, st, inset);
      return;
    }
    if (env === 'wrapfigure' || env === 'wraptable') {
      const lines = s.readOptional();
      const placement = s.readGroup() ?? 'o';
      const overhang = s.readOptional();
      const width = s.readGroup() ?? '0.5\\columnwidth';
      const inset: TextInset = { type: 'Text', name: 'Wrap', arg: env.slice(4), params: [`lines ${lines ?? 0}`, `placement ${placement.trim()}`, `overhang ${overhang ? lyxLength(overhang) : '0col%'}`, `width ${lyxLength(width)}`], status: 'open', paragraphs: [] };
      inset.paragraphs = this.parseInsetEnv(s, env, 'Plain Layout', st, 'float', inset);
      this.pushInset(ctx, st, inset);
      return;
    }
    if (env === 'minipage') { this.handleMinipage(s, ctx, st, 'Frameless'); return; }
    // environments from the layout files
    const style = this.envStyles.get(env);
    if (style) { this.handleEnvLayout(s, ctx, st, env, style); return; }
    const il = this.envInsets.get(env);
    if (il) {
      const { name, arg } = insetNameOf(il);
      if (il.args.size) s.readOptional();
      const base = name === 'Branch' || (name === 'Flex' && !il.forcePlain && il.multiPar) ? 'Standard' : 'Plain Layout';
      const pars = this.parseInsetEnv(s, env, base, st);
      this.pushInset(ctx, st, { type: 'Text', name, arg, params: [], status: 'open', paragraphs: pars });
      return;
    }
    // unknown environment: ERT around its content
    let raw = `\\begin{${env}}`;
    for (;;) {
      const c = s.peekChar();
      if (c === '[') { const o = s.readOptional(); if (o === null) break; raw += `[${o}]`; continue; }
      if (c === '{') { const e = groupEnd(s.s, s.pos); const g = s.s.slice(s.pos, e); if (g.length > 80 || g.includes('\n\n')) break; raw += g; s.pos = e; continue; }
      break;
    }
    this.pushERT(ctx, st, raw);
    this.envStack.push(env);
    const r = this.parseText(s, ctx, cloneState(st), { env });
    this.envStack.pop();
    if (r === 'end') this.pushERT(ctx, st, `\\end{${env}}`);
  }

  /** \begin{minipage}[pos][height][inner]{width} (the environment name has been read) → a Box inset. */
  private handleMinipage(s: Scanner, ctx: TextCtx, st: State, arg: 'Frameless' | 'Boxed'): void {
    const pos = s.readOptional();
    const height = s.readOptional();
    const innerPos = height !== null ? s.readOptional() : null;
    // the writer subtracts the frame from a full-width box: take that back
    const width = (s.readGroup() ?? '\\columnwidth').replace(/(\s*-\s*2\\fboxsep\s*-\s*2\\fboxrule)+\s*$/, '').replace(/(\s*-\s*2\\FrameSep\s*-\s*2\\FrameRule)+\s*$/, '');
    const p = (pos ?? 't').trim();
    const params = [`position "${p}"`, 'hor_pos "c"', 'has_inner_box 1', `inner_pos "${(innerPos ?? p).trim()}"`, 'use_parbox 0', 'use_makebox 0', `width "${lyxLength(width)}"`, 'special "none"', `height "${height ? lyxLength(height) : '1in'}"`, `height_special "${height ? 'none' : 'totalheight'}"`, 'thickness "0.4pt"', 'separation "3pt"', 'shadowsize "4pt"', 'framecolor "black"', 'backgroundcolor "none"'];
    const pars = this.parseInsetEnv(s, 'minipage', 'Plain Layout', st);
    // the writer adds \noindent in front of a full-width box itself
    const ert = lastErtParagraph(ctx);
    if (ert) {
      const t = ertText([ert]);
      if (/\\noindent\s*$/.test(t)) { setErtText(ert, t.replace(/\\noindent\s*$/, '')); if (!ertText([ert])) ctx.cur!.items.pop(); }
    } else if (ctx.cur && !ctx.cur.items.length && ctx.cur.params.noindent) delete ctx.cur.params.noindent;
    else if (!ctx.cur && ctx.noindent) ctx.noindent = false;
    this.pushInset(ctx, st, { type: 'Text', name: 'Box', arg, params, status: 'open', paragraphs: pars });
  }

  private floatOf(env: string): { type: string; wide: boolean; sideways: boolean } | null {
    let name = env;
    const wide = name.endsWith('*');
    if (wide) name = name.slice(0, -1);
    const sideways = name.startsWith('sideways');
    if (sideways) name = name.slice(8);
    if (!this.dc.floats.has(name)) return null;
    return { type: name, wide, sideways };
  }

  /** \begin{itemize} / \begin{quote} / \begin{theorem} ...: paragraphs of the style, nested by depth. */
  private handleEnvLayout(s: Scanner, ctx: TextCtx, st: State, env: string, style: LayoutStyle): void {
    this.endPar(ctx);
    const isItem = style.latexType === 'Item_Environment' || style.latexType === 'List_Environment' || style.latexType === 'Bib_Environment';
    const saved = { layout: ctx.layout, depth: ctx.depth, nestDepth: ctx.nestDepth, envLayout: ctx.envLayout, itemStyle: ctx.itemStyle };
    // a nested environment needs a paragraph of the enclosing one to hang from
    if (ctx.envLayout && !ctx.pars.some(p => p.layout === ctx.envLayout && p.depth === ctx.nestDepth - 1)) {
      ctx.pars.push({ layout: ctx.envLayout, depth: ctx.nestDepth - 1, params: {}, items: [] });
    }
    const depth = ctx.nestDepth;
    ctx.layout = style.name; ctx.depth = depth; ctx.nestDepth = depth + 1; ctx.envLayout = style.name; ctx.itemStyle = isItem ? style : null;
    // environment arguments → Argument insets of the first paragraph
    const args: TextInset[] = [];
    if (style.latexType === 'Bib_Environment' || style.labelType === 'Bibliography') s.readGroup();
    else if (style.latexType === 'List_Environment' && style.latexParam === '') { const g = s.readGroup(); if (g !== null && g.trim()) args.push(argumentInset('listpreamble:1', this.parseInsetString(g, 'Plain Layout'))); }
    if (style.args.size) {
      let n = 1;
      for (;;) {
        const o = s.readOptional();
        if (o === null) break;
        args.push(argumentInset(String(n++), this.parseInsetString(o, 'Plain Layout')));
      }
    }
    this.envStack.push(env);
    if (isItem) {
      // text before the first \item is unusual; it lands in a paragraph of the layout
      let r = this.parseText(s, ctx, cloneState(st), { env, item: true });
      let first = true;
      while (r === 'item') {
        const opt = s.readOptional();
        const par = this.newPar(ctx, style.name, depth);
        if (first) { for (const a of args) par.items.push({ kind: 'inset', font: {}, inset: a }); first = false; }
        if (opt !== null) {
          if (style.labelType === 'Manual') {
            // description-like: the label is the first word(s) of the paragraph, spaces protected
            this.pushLabelWords(ctx, cloneState(st), opt);
          } else if (style.latexType === 'Bib_Environment') {
            /* handled below */
          } else {
            par.items.push({ kind: 'inset', font: {}, inset: argumentInset('item:1', this.parseInsetString(opt, 'Plain Layout')) });
          }
        }
        if (style.latexType === 'Bib_Environment' || style.labelType === 'Bibliography') {
          // \bibitem[label]{key}
          const key = s.readGroup() ?? '';
          const params = ['LatexCommand bibitem'];
          if (opt !== null) params.push('label ' + quote(opt));
          params.push('key ' + quote(key.trim()), 'literal "true"');
          par.items.push({ kind: 'inset', font: {}, inset: { type: 'Leaf', name: 'CommandInset', arg: 'bibitem', params } });
        }
        s.skipBlanks();
        // paragraphs after a blank line inside the item continue at depth + 1
        ctx.layout = 'Standard'; ctx.depth = depth + 1;
        r = this.parseText(s, ctx, cloneState(st), { env, item: true });
        ctx.layout = style.name; ctx.depth = depth;
      }
    } else {
      const r0 = this.parseText(s, ctx, cloneState(st), { env });
      void r0;
      if (args.length) {
        const firstPar = ctx.pars.find(p => p.layout === style.name && p.depth === depth);
        if (firstPar) firstPar.items.unshift(...args.map(a => ({ kind: 'inset' as const, font: {}, inset: a })));
      }
    }
    this.envStack.pop();
    this.endPar(ctx);
    Object.assign(ctx, saved);
  }

  /** "\item[foo bar] text" in a description: "foo~bar text" (LyX's manual label). */
  private pushLabelWords(ctx: TextCtx, st: State, label: string): void {
    const pars = this.parseInsetString(label, 'Plain Layout');
    const par = this.ensurePar(ctx);
    for (const it of pars[0].items) {
      if (it.kind === 'text') {
        const words = it.text.split(' ');
        words.forEach((w, i) => {
          if (i > 0) par.items.push({ kind: 'inset', font: { ...it.font }, inset: { type: 'Leaf', name: 'space', arg: '~', params: [] } });
          if (w) par.items.push({ ...it, text: w });
        });
      } else par.items.push(it);
    }
    this.pushText(ctx, st, ' ');
  }
}

/* ------------------------------------------------------------ helpers */

function sameFont(a: FontState, b: FontState): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if ((a as Record<string, unknown>)[k] !== (b as Record<string, unknown>)[k]) return false;
  return true;
}
function sameChange(a?: Change, b?: Change): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.type === b.type && a.author === b.author && a.time === b.time;
}

/** Insets the writer starts on a line of their own (a blank before them is not written). */
function ownLineBefore(ins: Inset): boolean {
  if (ins.type === 'Formula') return !ins.inline;
  if (ins.type === 'FormulaMacro') return true;
  if (ins.type === 'Text') return ins.name === 'Float' || ins.name === 'Wrap';
  if (ins.type === 'Leaf') return ins.name === 'CommandInset' && (ins.arg === 'bibtex');
  return false;
}
/** Insets after which the writer breaks the line (a blank after them is not written). */
function ownLineAfter(ins: Inset): boolean {
  if (ownLineBefore(ins)) return true;
  if (ins.type === 'Leaf') return ins.name === 'Newline' || ins.name === 'VSpace' || ins.name === 'Separator' || ins.name === 'FloatList';
  return false;
}

/** The last paragraph of an ERT inset that ends the current paragraph (single-paragraph ERT only). */
function lastErtParagraph(ctx: TextCtx): Paragraph | null {
  const p = ctx.cur;
  if (!p || !p.items.length) return null;
  const last = p.items[p.items.length - 1];
  if (last.kind !== 'inset' || last.inset.type !== 'Text' || last.inset.name !== 'ERT' || last.inset.paragraphs.length !== 1) return null;
  return last.inset.paragraphs[0];
}
function setErtText(p: Paragraph, text: string): void {
  p.items = text ? [{ kind: 'text', text, font: {} }] : [];
}

function lastIsERT(ctx: TextCtx): boolean {
  const p = ctx.cur;
  if (!p || !p.items.length) return false;
  const last = p.items[p.items.length - 1];
  return last.kind === 'inset' && last.inset.type === 'Text' && last.inset.name === 'ERT';
}

/** The raw LaTeX directly before the cursor ends in a bare script character (^ or _). */
function lastERTEndsWithScript(ctx: TextCtx): boolean {
  const p = ctx.cur;
  if (!p || !p.items.length) return false;
  const last = p.items[p.items.length - 1];
  if (last.kind !== 'inset' || last.inset.type !== 'Text' || last.inset.name !== 'ERT') return false;
  return /[\^_]$/.test(ertText(last.inset.paragraphs));
}

function hasComment(s: string): boolean {
  for (let i = 0; i < s.length; i++) { if (s[i] === '\\') { i++; continue; } if (s[i] === '%') return true; }
  return false;
}

function ertParagraphs(text: string): Paragraph[] {
  return text.split('\n').map(line => ({ layout: 'Plain Layout', depth: 0, params: {}, items: line ? [{ kind: 'text', text: line, font: {} } as Item] : [] }));
}
function ertText(pars: Paragraph[]): string {
  return pars.map(p => p.items.map(it => (it.kind === 'text' ? it.text : '')).join('')).join('\n');
}
function appendErtText(p: Paragraph, text: string): void {
  const last = p.items[p.items.length - 1];
  if (last && last.kind === 'text') last.text += text;
  else p.items.push({ kind: 'text', text, font: {} });
}
function appendErtLines(pars: Paragraph[], text: string): void {
  pars.push(...ertParagraphs(text));
}

function setParam(params: string[], key: string, value: string): void {
  const i = params.findIndex(l => l === key || l.startsWith(key + ' '));
  if (i >= 0) params[i] = key + ' ' + value; else params.push(key + ' ' + value);
}

function argumentInset(id: string, pars: Paragraph[]): TextInset {
  return { type: 'Text', name: 'Argument', arg: id, params: [], status: 'open', paragraphs: pars };
}

function refInset(cmd: string, ref: string, o: { caps?: boolean; plural?: boolean; nolink?: boolean }): LeafInset {
  return { type: 'Leaf', name: 'CommandInset', arg: 'ref', params: ['LatexCommand ' + cmd, 'reference ' + quote(ref), `plural "${o.plural ? 'true' : 'false'}"`, `caps "${o.caps ? 'true' : 'false'}"`, 'noprefix "false"', `nolink "${o.nolink ? 'true' : 'false'}"`] };
}

/** InsetLayout name → LyX inset name / argument ("Note:Comment" → Note Comment, "Flex:URL" → Flex URL). */
function insetNameOf(il: InsetLayout): { name: string; arg: string } {
  const [head, ...rest] = il.name.split(':');
  const arg = rest.join(':');
  switch (head) {
    case 'Foot': return { name: 'Foot', arg: '' };
    case 'Script': return { name: 'script', arg };
    case 'Caption': return { name: 'Caption', arg: arg || 'Standard' };
    default: return { name: head, arg };
  }
}

function graphicsInset(filename: string, options: string): LeafInset {
  const params: string[] = ['\tfilename ' + filename];
  let width = '', height = '', scale = '', angle = '';
  let keep = false, clip = false, draft = false;
  const special: string[] = [];
  for (const o of splitOptions(options)) {
    const eq = o.indexOf('=');
    const k = (eq < 0 ? o : o.slice(0, eq)).trim();
    const v = eq < 0 ? '' : o.slice(eq + 1).trim();
    if (!k) continue;
    switch (k) {
      case 'width': width = lyxLength(v); break;
      case 'height': case 'totalheight': height = lyxLength(v); break;
      case 'scale': scale = String(Number((parseFloat(v) * 100).toFixed(2))); break;
      case 'keepaspectratio': keep = true; break;
      case 'angle': angle = v; break;
      case 'clip': clip = true; break;
      case 'draft': draft = true; break;
      default: special.push(o.trim());
    }
  }
  if (scale) params.push('\tscale ' + scale);
  if (width) params.push('\twidth ' + width);
  if (height) params.push('\theight ' + height);
  if (keep) params.push('\tkeepAspectRatio');
  if (angle) params.push('\trotateAngle ' + angle);
  if (draft) params.push('\tdraft');
  if (clip) params.push('\tclip');
  if (special.length) params.push('\tspecial ' + special.join(','));
  return { type: 'Leaf', name: 'Graphics', arg: '', params };
}

function splitOptions(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = '';
  for (const c of s) {
    if (c === '{') depth++;
    else if (c === '}') depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** A \newcommand / \def / \global\long\def definition starting at `start`; returns its text and end. */
export function readMacroDefinition(s: string, start: number): { text: string; end: number } | null {
  const head = /^(?:\\global\s*)?(?:\\long\s*)?(?:\\outer\s*)?(?:\\protected\s*)?\\(newcommand\*?|renewcommand\*?|providecommand\*?|newcommandx\*?|renewcommandx\*?|def|edef|gdef|DeclareMathOperator\*?)\s*/.exec(s.slice(start));
  if (!head) return null;
  let i = start + head[0].length;
  // name
  let m = /^(\{\s*\\[A-Za-z@]+\s*\}|\\[A-Za-z@]+|\\.)/.exec(s.slice(i));
  if (!m) return null;
  i += m[0].length;
  const kind = head[1];
  if (kind.startsWith('def') || kind === 'edef' || kind === 'gdef') {
    while (i < s.length && s[i] !== '{') { if (s[i] === '\n' && s[i + 1] === '\n') return null; i++; }
  } else {
    for (;;) {
      const o = /^\s*\[[^\]]*\]/.exec(s.slice(i));
      if (!o) break;
      i += o[0].length;
    }
    while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n')) i++;
    if (s[i] !== '{') {
      m = /^\\[A-Za-z@]+|^./.exec(s.slice(i));
      if (!m) return null;
      return { text: s.slice(start, i + m[0].length), end: i + m[0].length };
    }
  }
  if (s[i] !== '{') return null;
  const end = groupEnd(s, i);
  return { text: s.slice(start, end), end };
}

/* ------------------------------------------------------------ entry point */

const unicodeCache = new Map<string, UnicodeDB>();
const langCache = new Map<string, LanguageDB>();

function libDir(layoutDir: string): string { return join(layoutDir, '..'); }

export function parseTex(text: string, opts: ParseTexOptions = {}): ParseTexResult {
  if (text.startsWith('\ufeff')) text = text.slice(1);
  text = text.replace(/\r\n/g, '\n');
  const layoutDir = opts.layoutDir ?? DEFAULT_LAYOUT_DIR;
  const lib = libDir(layoutDir);
  let unicode = unicodeCache.get(lib);
  if (!unicode) { unicode = loadUnicodeSymbols(join(lib, 'unicodesymbols')); unicodeCache.set(lib, unicode); }
  let langs = langCache.get(lib);
  if (!langs) { langs = loadLanguages(join(lib, 'languages')); langCache.set(lib, langs); }

  const split = splitDocument(text);
  const warnings: string[] = [];
  const settings = split.settings;
  const facts = preambleFacts(split.userPreamble, opts.readFile);
  const setStr = (k: string): string | undefined => (typeof settings[k] === 'string' || typeof settings[k] === 'number' || typeof settings[k] === 'boolean' ? String(settings[k]) : undefined);

  // header
  let headerLines: string[];
  let textclass: string;
  let modules: string[] = Array.isArray(settings.modules) ? (settings.modules as unknown[]).map(String) : [];
  const masterValue = (k: string): string | undefined => {
    const l = opts.masterHeader?.find(x => x.startsWith('\\' + k + ' '));
    return l?.slice(k.length + 2);
  };
  if (!split.hasDocument && opts.masterHeader) {
    headerLines = opts.masterHeader.filter(l => !l.startsWith('\\author '));
    textclass = masterValue('textclass') ?? 'article';
    const ms = opts.masterHeader.indexOf('\\begin_modules'), me = opts.masterHeader.indexOf('\\end_modules');
    if (ms >= 0 && me > ms) modules = opts.masterHeader.slice(ms + 1, me);
  } else {
    textclass = setStr('textclass') ?? (split.className ? textclassForLatexClass(split.className, layoutDir, opts.localDirs) ?? split.className : 'article');
    headerLines = [];
  }
  const dc = loadDocumentClass(textclass, modules, layoutDir, opts.localDirs);
  if (dc.warnings.length) warnings.push(...dc.warnings);

  // derived settings (only used when the settings line does not say)
  const derived: Record<string, string> = {};
  const body = split.body;
  if (!setStr('cite_engine')) {
    if (facts.packages.has('biblatex')) { derived.cite_engine = 'biblatex'; derived.cite_engine_type = 'authoryear'; }
    else if (facts.packages.has('natbib') || dc.provides.has('natbib') || /\\cite[tp]\b/.test(body)) {
      derived.cite_engine = 'natbib';
      derived.cite_engine_type = /numbers/.test(facts.packageOptions.get('natbib') ?? '') ? 'numerical' : 'authoryear';
    }
  }
  if (!setStr('crossref_package') && facts.packages.has('cleveref')) derived.crossref_package = 'cleveref';
  if (!setStr('use_hyperref') && facts.packages.has('hyperref')) derived.use_hyperref = 'true';
  if (!setStr('use_non_tex_fonts') && facts.packages.has('fontspec')) { derived.use_non_tex_fonts = 'true'; derived.default_output_format = 'pdf4'; }
  if (!setStr('biblio_style') && facts.bibliographystyle) derived.biblio_style = facts.bibliographystyle;
  if (!setStr('use_minted') && facts.packages.has('minted')) derived.use_minted = '1';
  if (!setStr('language')) {
    const babel = /\\usepackage\[([^\]]*)\]\{babel\}/.exec(split.userPreamble);
    if (babel) { const last = babel[1].split(',').map(x => x.trim()).filter(Boolean).pop(); const l = last && [...langs.entries()].find(([, v]) => v.babel === last); if (l) derived.language = l[0]; }
  }

  const language = setStr('language') ?? derived.language ?? masterValue('language') ?? 'english';
  const quotes = setStr('quotes_style') ?? masterValue('quotes_style') ?? 'english';
  const parser = new BodyParser(dc, unicode, langs, facts, { language, quotes });
  const pars = parser.parseBody(body);
  warnings.push(...parser.warnings);

  const authors = [...parser.authors.entries()].map(([id, a]) => ({ id, name: a.name, email: a.email }));
  if (!split.hasDocument && opts.masterHeader) {
    for (const a of authors) headerLines.push(`\\author ${a.id} "${a.name}" ""`);
  } else {
    headerLines = makeHeaderLines({ textclass, options: split.classOptions, preamble: split.userPreamble, modules, settings, derived, authors });
  }
  const doc: LyxDocument = {
    preamble: split.head.replace(/\s+$/, '').split('\n').filter((l, i, a) => !(i === a.length - 1 && l === '')),
    format: 643,
    header: { lines: headerLines },
    body: pars.length ? pars : [{ layout: 'Standard', depth: 0, params: {}, items: [] }],
    trailer: split.trailer.replace(/^\n/, '').replace(/\s+$/, '') ? split.trailer.replace(/^\n/, '').replace(/\s+$/, '').split('\n') : [],
  };
  return { doc, warnings, fragment: !split.hasDocument };
}

/** A colour given with an xcolor model → '#rrggbb', or null when the model is not understood. */
export function colorFromModel(model: string, spec: string): string | null {
  const hex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  const nums = spec.split(',').map(x => Number(x.trim()));
  if (model === 'HTML') return /^[0-9a-fA-F]{6}$/.test(spec) ? '#' + spec.toLowerCase() : null;
  if (model === 'rgb' && nums.length === 3 && nums.every(Number.isFinite)) return '#' + nums.map(n => hex(n * 255)).join('');
  if (model === 'RGB' && nums.length === 3 && nums.every(Number.isFinite)) return '#' + nums.map(hex).join('');
  if (model === 'gray' && nums.length === 1 && Number.isFinite(nums[0])) return '#' + hex(nums[0] * 255).repeat(3);
  return null;
}
