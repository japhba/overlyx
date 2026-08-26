/**
 * Preamble generation, mirroring BufferParams::writeLaTeX and
 * LaTeXFeatures::getPackages/getMacros/getColorOptions.
 */
import type { ExportContext } from './context.ts';
import { latexLength } from './lengths.ts';
import { colorToRgb } from './params.ts';
import { fontLatexCode, fontUsedPackage } from './latexfonts.ts';
import { ENCODING_LATEX_NAMES } from './languages.ts';
import { babelName } from './text.ts';

const SIMPLE_FEATURES = [
  'array', 'verbatim', 'cprotect', 'longtable', 'latexsym', 'pifont', 'varioref', 'prettyref', 'refstyle', 'float', 'wrapfig',
  'booktabs', 'fancybox', 'calc', 'units', 'framed', 'soul', 'dingbat', 'bbding', 'ifsym', 'txfonts', 'pxfonts', 'mathdesign',
  'mathrsfs', 'mathabx', 'mathtools', 'ascii', 'url', 'csquotes', 'enumitem', 'endnotes', 'enotez', 'hhline', 'ifthen', 'bm',
  'pdfpages', 'amscd', 'slashed', 'multicol', 'multirow', 'tfrupee', 'shapepar', 'rsphrase', 'hpstatement', 'algorithm2e',
  'sectionbox', 'tcolorbox', 'pdfcomment', 'fixme', 'todonotes', 'forest', 'varwidth', 'afterpage', 'tabularx', 'tikz',
  'xltabular', 'chessboard', 'xskak', 'pict2e', 'drs', 'environ', 'dsfont', 'hepparticles', 'hepnames',
];

const BIBLIO_FEATURES = ['achicago', 'apacite', 'apalike', 'astron', 'authordate1-4', 'babelbib', 'bibgerm', 'chapterbib', 'chicago', 'chscite', 'harvard', 'mslapa', 'named'];

const PAPER_SIZES: Record<string, string> = {
  letter: 'letterpaper', legal: 'legalpaper', executive: 'executivepaper',
  a0: 'a0paper', a1: 'a1paper', a2: 'a2paper', a3: 'a3paper', a4: 'a4paper', a5: 'a5paper', a6: 'a6paper',
  b0: 'b0paper', b1: 'b1paper', b2: 'b2paper', b3: 'b3paper', b4: 'b4paper', b5: 'b5paper', b6: 'b6paper',
  c0: 'c0paper', c1: 'c1paper', c2: 'c2paper', c3: 'c3paper', c4: 'c4paper', c5: 'c5paper', c6: 'c6paper',
  jisb0: 'b0j', jisb1: 'b1j', jisb2: 'b2j', jisb3: 'b3j', jisb4: 'b4j', jisb5: 'b5j', jisb6: 'b6j',
};

const LYX_DEF = '{%\n  L\\kern-.1667em\\lower.25em\\hbox{Y}\\kern-.125emX\\@}';
const NOUN_DEF = '\\newcommand{\\noun}[1]{\\textsc{#1}}';
const LYXARROW_DEF = '\\DeclareRobustCommand*{\\lyxarrow}{%\n\\@ifstar\n{\\leavevmode\\,$\\triangleleft$\\,\\allowbreak}\n{\\leavevmode\\,$\\triangleright$\\,\\allowbreak}}';
const LYXZWSP_DEF = '\\newcommand*\\LyXZeroWidthSpace{\\hspace{0pt}}';
const PARAGRAPHLEFTINDENT_DEF = '\\newenvironment{LyXParagraphLeftIndent}[1]%\n{\n  \\begin{list}{}{%\n    \\setlength{\\topsep}{0pt}%\n    \\addtolength{\\leftmargin}{#1}\n    \\setlength{\\parsep}{0pt plus 1pt}%\n  }\n  \\item[]\n}\n{\\end{list}}\n';
const BINOM_DEF = '%% Binom macro for standard LaTeX users\n\\newcommand{\\binom}[2]{{#1 \\choose #2}}\n';
const MATHCIRCUMFLEX_DEF = '%% For printing a cirumflex inside a formula\n\\newcommand{\\mathcircumflex}[0]{\\mbox{\\^{}}}\n';
const CELLVARWIDTH_DEF = '%% Variable width box for table cells\n\\newenvironment{cellvarwidth}[1][t]\n    {\\begin{varwidth}[#1]{\\linewidth}}\n    {\\@finalstrut\\@arstrutbox\\end{varwidth}}\n';
const PAPERSIZEPDF_DEF = '\\pdfpageheight\\paperheight\n\\pdfpagewidth\\paperwidth\n';
const TABULARNEWLINE_DEF = '%% Because html converters don\'t know tabularnewline\n\\providecommand{\\tabularnewline}{\\\\}\n';
const LYXDOT_DEF = '%% A simple dot to overcome graphicx limitations\n\\newcommand{\\lyxdot}{.}\n';
const LYXREF_DEF = '\\RS@ifundefined{subsecref}\n  {\\newref{subsec}{name = \\RSsectxt}}\n  {}\n\\RS@ifundefined{thmref}\n  {\\def\\RSthmtxt{theorem~}\\newref{thm}{name = \\RSthmtxt}}\n  {}\n\\RS@ifundefined{lemref}\n  {\\def\\RSlemtxt{lemma~}\\newref{lem}{name = \\RSlemtxt}}\n  {}\n';
const LYXMATHSYM_DEF = '\\newcommand{\\lyxmathsym}[1]{\\ifmmode\\begingroup\\def\\b@ld{bold}\n  \\text{\\ifx\\math@version\\b@ld\\bfseries\\fi#1}\\endgroup\\else#1\\fi}\n';
const TEXTGREEK_LGR_DEF = '\\DeclareFontEncoding{LGR}{}{}\n';
const TEXTGREEK_DEF = '\\DeclareRobustCommand{\\greektext}{%\n  \\fontencoding{LGR}\\selectfont\\def\\encodingdefault{LGR}}\n\\DeclareRobustCommand{\\textgreek}[1]{\\leavevmode{\\greektext #1}}\n';
const TEXTCYR_T2A_DEF = '\\InputIfFileExists{t2aenc.def}{}{%\n  \\errmessage{File `t2aenc.def\' not found: Cyrillic script not supported}}\n';
const TEXTCYR_DEF = '\\DeclareRobustCommand{\\cyrtext}{%\n  \\fontencoding{T2A}\\selectfont\\def\\encodingdefault{T2A}}\n\\DeclareRobustCommand{\\textcyrillic}[1]{\\leavevmode{\\cyrtext #1}}\n';
const QUOTE_DEFS: Record<string, string> = {
  quotesinglbase: '\\ProvideTextCommandDefault{\\quotesinglbase}{%\n  \\raisebox{-1.6ex}[0ex][0ex]{\\textquoteleft}}\n',
  quotedblbase: '\\ProvideTextCommandDefault{\\quotedblbase}{%\n  \\raisebox{-1.6ex}[0ex][0ex]{\\textquotedblleft}}\n',
  guilsinglleft: '\\ProvideTextCommandDefault{\\guilsinglleft}{%\n  {\\usefont{OT1}{cmr}{m}{n}\\char"0E}}\n',
  guilsinglright: '\\ProvideTextCommandDefault{\\guilsinglright}{%\n  {\\usefont{OT1}{cmr}{m}{n}\\char"0F}}\n',
  guillemotleft: '\\ProvideTextCommandDefault{\\guillemotleft}{%\n  {\\usefont{OT1}{cmr}{m}{n}\\char"0E\\char"0E}}\n',
  guillemotright: '\\ProvideTextCommandDefault{\\guillemotright}{%\n  {\\usefont{OT1}{cmr}{m}{n}\\char"0F\\char"0F}}\n',
  textquotedbl: '\\DeclareTextSymbolDefault{\\textquotedbl}{T1}\n',
};
const CT_BASE_DEF = '%% Change tracking with ulem and xcolor: base macros\n\\DeclareRobustCommand{\\mklyxadded}[1]{\\bgroup\\color{lyxadded}{}#1\\egroup}\n\\DeclareRobustCommand{\\mklyxdeleted}[1]{\\bgroup\\color{lyxdeleted}\\mklyxsout{#1}\\egroup}\n\\DeclareRobustCommand{\\mklyxsout}[1]{\\ifx\\\\#1\\else\\sout{#1}\\fi}\n';
const CT_DEF = '%% Change tracking with ulem and xcolor: ct markup\n\\DeclareRobustCommand{\\lyxadded}[4][]{\\mklyxadded{#4}}\n\\DeclareRobustCommand{\\lyxdeleted}[4][]{\\mklyxdeleted{#4}}\n';
const CT_HYPERREF_DEF = '%% Change tracking with ulem, xcolor, and hyperref: ct markup\n\\DeclareRobustCommand{\\lyxadded}[4][]{\\texorpdfstring{\\mklyxadded{#4}}{#4}}\n\\DeclareRobustCommand{\\lyxdeleted}[4][]{\\texorpdfstring{\\mklyxdeleted{#4}}{}}\n';
const CT_CB_DEF = '%% Change tracking with ulem, xcolor and changebars: ct markup\n\\DeclareRobustCommand{\\lyxadded}[4][]{%\n    \\protect\\cbstart\\mklyxadded{#4}%\n    \\protect\\cbend%\n}\n\\DeclareRobustCommand{\\lyxdeleted}[4][]{%\n    \\protect\\cbstart\\mklyxdeleted{#4}%\n    \\protect\\cbend%\n}\n';
const CT_NONE_DEF = '%% Change tracking: Disable markup in output\n\\newcommand{\\lyxadded}[3]{#3}\n\\newcommand{\\lyxdeleted}[3]{}\n\\newcommand{\\lyxobjdeleted}[3]{}\n\\newcommand{\\lyxdisplayobjdeleted}[3]{}\n\\newcommand{\\lyxudisplayobjdeleted}[3]{}\n';

function lyxgreyedoutDef(ct: boolean): string {
  let s = '%% The greyedout annotation environment\n\\newenvironment{lyxgreyedout}\n{';
  if (ct) s += '\\colorlet{lyxadded}{lyxadded!30}\\colorlet{lyxdeleted}{lyxdeleted!30}%\n ';
  s += '\\normalfont\\normalsize\\textcolor{note_fontcolor}\\bgroup\\ignorespaces}\n{\\ignorespacesafterend\\egroup}\n';
  return s;
}

/** \use_package values: 0 = off, 1 = auto, 2 = on (BufferParams::packagetranslator). */
function usePackageAllowed(ctx: ExportContext, name: string): boolean {
  return (ctx.bp.usePackage.get(name) ?? 1) !== 0;
}

/** Sorted babel names of the languages used besides the document language. */
function babelLanguages(ctx: ExportContext): string[] {
  const docBabel = babelName(ctx, ctx.bp.language);
  const set = new Set<string>();
  for (const [, l] of ctx.features.usedLanguages) if (l.babel && l.babel !== docBabel) set.add(l.babel);
  return [...set].sort();
}

function classOptions(ctx: ExportContext): string {
  const { bp, dc } = ctx;
  const opts: string[] = [];
  if (dc.fontSizes.includes(bp.paperFontSize)) opts.push(dc.fontSizeFormat.replace('$$s', bp.paperFontSize));
  const classSupported = bp.paperSize === 'default' || dc.pageSizes.includes(bp.paperSize);
  if ((!bp.useGeometry || ctx.features.isProvided('geometry-light')) && classSupported && bp.paperSize !== 'default') {
    opts.push(dc.pageSizeFormat.replace('$$s', bp.paperSize));
  }
  if (bp.sides !== dc.sides) opts.push(bp.sides === 2 ? 'twoside' : 'oneside');
  if (bp.columns !== dc.columns) opts.push(bp.columns === 2 ? 'twocolumn' : 'onecolumn');
  if (!bp.useGeometry && bp.orientation === 'landscape') opts.push('landscape');
  if (bp.isMathIndent) opts.push('fleqn');
  if (bp.mathNumberingSide === 'left') opts.push('leqno');
  else if (bp.mathNumberingSide === 'right') { opts.push('reqno'); ctx.features.require('amsmath'); }
  if (ctx.useBabel || ctx.usePolyglossia) {
    const langs = ctx.useBabel ? babelLanguages(ctx) : [];
    const docBabel = babelName(ctx, bp.language);
    if (ctx.useBabel) { if (docBabel) langs.push(docBabel); if (langs.length) opts.push(langs.join(',')); }
  }
  if (bp.useDefaultOptions && dc.options) opts.push(dc.options);
  if (bp.options) opts.push(bp.options);
  return opts.filter(Boolean).join(',');
}

function geometry(ctx: ExportContext): string {
  const { bp, dc } = ctx;
  const classSupported = bp.paperSize === 'default' || dc.pageSizes.includes(bp.paperSize);
  if (ctx.features.isProvided('geometry') || !(bp.useGeometry || !classSupported)) {
    if (bp.orientation === 'landscape' || bp.paperSize !== 'default') ctx.features.require('papersize');
    return '';
  }
  const gopts: string[] = [];
  if (bp.orientation === 'landscape') gopts.push('landscape');
  if (bp.paperSize === 'custom') {
    if (bp.paperWidth) gopts.push(`paperwidth=${bp.paperWidth}`);
    if (bp.paperHeight) gopts.push(`paperheight=${bp.paperHeight}`);
  } else if (bp.paperSize !== 'default' && PAPER_SIZES[bp.paperSize]) gopts.push(PAPER_SIZES[bp.paperSize]);
  let out = '\\usepackage';
  let gstr = gopts.join(',');
  if (gstr && !ctx.features.isProvided('geometry-light')) { out += `[${gstr}]`; gstr = ''; }
  out += '{geometry}\n';
  if (bp.useGeometry || ctx.features.isProvided('geometry-light')) {
    out += '\\geometry{verbose';
    if (gstr) out += ',' + gstr;
    if (bp.useGeometry) {
      const m = (k: string, v: string) => (v ? `,${k}=${latexLength(v)}` : '');
      out += m('tmargin', bp.topMargin) + m('bmargin', bp.bottomMargin) + m('lmargin', bp.leftMargin) + m('rmargin', bp.rightMargin)
        + m('headheight', bp.headHeight) + m('headsep', bp.headSep) + m('footskip', bp.footSkip) + m('columnsep', bp.columnSep);
    }
    out += '}\n';
  }
  return out;
}

function fontsCode(ctx: ExportContext): string {
  const { bp } = ctx;
  if (bp.fontRoman === 'default' && bp.fontSans === 'default' && bp.fontTypewriter === 'default' && (bp.fontMath === 'default' || bp.fontMath === 'auto')) return '';
  if (bp.useNonTexFonts) {
    let out = '';
    const map = 'Ligatures=TeX';
    if (bp.fontRoman !== 'default') out += `\\setmainfont[${bp.fontRomanOpts ? bp.fontRomanOpts + ',' : ''}${map}${bp.fontRomanOsf ? ',Numbers=OldStyle' : ''}]{${bp.fontRoman}}\n`;
    if (bp.fontSans !== 'default') {
      const o: string[] = [];
      if (bp.fontSfScale !== 100) o.push(`Scale=${bp.fontSfScale / 100}`);
      if (bp.fontSansOsf) o.push('Numbers=OldStyle');
      if (bp.fontSansOpts) o.push(bp.fontSansOpts);
      o.push(map);
      out += `\\setsansfont[${o.join(',')}]{${bp.fontSans}}\n`;
    }
    if (bp.fontTypewriter !== 'default') {
      const o: string[] = [];
      if (bp.fontTtScale !== 100) o.push(`Scale=${bp.fontTtScale / 100}`);
      if (bp.fontTypewriterOsf) o.push('Numbers=OldStyle');
      if (bp.fontTypewriterOpts) o.push(bp.fontTypewriterOpts);
      out += `\\setmonofont${o.length ? `[${o.join(',')}]` : ''}{${bp.fontTypewriter}}\n`;
    }
    return out;
  }
  const ot1 = ctx.mainFontenc === 'default' || ctx.mainFontenc === 'OT1';
  const complete = bp.fontSans === 'default' && bp.fontTypewriter === 'default';
  const nomath = bp.fontMath !== 'auto';
  let out = '';
  out += fontLatexCode(ctx.fonts, bp.fontRoman, { ot1, complete, sc: bp.fontSc, osf: bp.fontRomanOsf, nomath, extraOpts: bp.fontRomanOpts, scale: 100 });
  out += fontLatexCode(ctx.fonts, bp.fontSans, { ot1, complete, sc: bp.fontSc, osf: bp.fontSansOsf, nomath, extraOpts: bp.fontSansOpts, scale: bp.fontSfScale });
  out += fontLatexCode(ctx.fonts, bp.fontTypewriter, { ot1, complete, sc: bp.fontSc, osf: bp.fontTypewriterOsf, nomath, extraOpts: bp.fontTypewriterOpts, scale: bp.fontTtScale });
  out += fontLatexCode(ctx.fonts, bp.fontMath, { ot1, complete, sc: bp.fontSc, osf: bp.fontRomanOsf, nomath, extraOpts: '', scale: 100 });
  return out;
}

function encodingPreamble(ctx: ExportContext): string {
  const { bp } = ctx;
  if (bp.useNonTexFonts) return '';
  if (bp.inputenc === 'auto-legacy') {
    // Our output is ASCII with LaTeX macros for non-ASCII characters; load inputenc with the language encoding as LyX does.
    return `\\usepackage[${ctx.encodingName}]{inputenc}\n`;
  }
  if (bp.inputenc === 'auto-legacy-plain') return '\\UseRawInputEncoding\n';
  const latexName = ENCODING_LATEX_NAMES[bp.inputenc] ?? bp.inputenc;
  if (bp.inputenc === 'utf8-plain' || bp.inputenc === 'ascii') return ctx.encodingMode === 'plain' ? '' : '\\UseRawInputEncoding\n';
  if (bp.inputenc === 'utf8x') return '\\usepackage{ucs}\n\\usepackage[utf8x]{inputenc}\n';
  return `\\usepackage[${latexName}]{inputenc}\n`;
}

function amsPackages(ctx: ExportContext): string {
  const f = ctx.features;
  let s = '';
  if (f.mustProvide('amsmath') && usePackageAllowed(ctx, 'amsmath')) s += '\\usepackage{amsmath}\n';
  else {
    if (f.mustProvide('amsbsy')) s += '\\usepackage{amsbsy}\n';
    if (f.mustProvide('amstext')) s += '\\usepackage{amstext}\n';
  }
  if (f.mustProvide('amsthm')) s += '\\usepackage{amsthm}\n';
  if (f.mustProvide('amssymb') && usePackageAllowed(ctx, 'amssymb')) s += '\\usepackage{amssymb}\n';
  return s;
}

function colorOptions(ctx: ExportContext): string {
  const f = ctx.features;
  const { bp } = ctx;
  let s = '';
  if (f.mustProvide('color') || f.mustProvide('xcolor')) {
    const pkg = f.mustProvide('xcolor') ? 'xcolor' : 'color';
    s += bp.graphicsDriver === 'default' || bp.graphicsDriver === 'none' ? `\\usepackage{${pkg}}\n` : `\\usepackage[${bp.graphicsDriver}]{${pkg}}\n`;
  }
  if (f.mustProvide('pdfcolmk')) s += '\\usepackage{pdfcolmk}\n';
  if (f.mustProvide('pagecolor')) {
    s += `\\definecolor{page_backgroundcolor}{rgb}{${colorToRgb(bp.backgroundColor)}}\n\\pagecolor{page_backgroundcolor}\n`;
  }
  if (f.mustProvide('fontcolor')) {
    s += `\\definecolor{document_fontcolor}{rgb}{${colorToRgb(bp.fontColor)}}\n\\color{document_fontcolor}\n`;
  }
  if (f.mustProvide('lyxgreyedout')) {
    s += `\\definecolor{note_fontcolor}{rgb}{${colorToRgb(bp.noteFontColor) ?? '0.8, 0.8, 0.8'}}\n`;
  }
  if (f.isRequired('framed') && f.mustProvide('color')) {
    s += `\\definecolor{shadecolor}{rgb}{${colorToRgb(bp.boxBgColor) ?? '1, 0, 0'}}\n`;
  }
  return s;
}

function packages(ctx: ExportContext): string {
  const f = ctx.features;
  const { bp } = ctx;
  let s = '';
  for (const name of SIMPLE_FEATURES) if (f.mustProvide(name)) s += `\\usepackage{${name}}\n`;
  if (f.mustProvide('changebar')) s += '\\usepackage{changebar}\n';
  if (f.mustProvide('footnote')) s += f.isRequired('hyperref') ? '\\usepackage{footnotehyper}\n' : '\\usepackage{footnote}\n';
  if (f.mustProvide('lscape')) s += '\\usepackage{pdflscape}\n';
  if (f.mustProvide('tipa') && !bp.useNonTexFonts) s += '\\usepackage{tipa}\n';
  if (f.mustProvide('tipx') && !bp.useNonTexFonts) s += '\\usepackage{tipx}\n';
  const ot1 = ctx.mainFontenc === 'default' || ctx.mainFontenc === 'OT1';
  const useNewtxmath = fontUsedPackage(ctx.fonts, bp.fontMath, { ot1, complete: false, sc: false, osf: false, nomath: false, extraOpts: '', scale: 100 }) === 'newtxmath';
  if (!bp.useNonTexFonts && !useNewtxmath) s += amsPackages(ctx);
  if (f.mustProvide('cancel') && usePackageAllowed(ctx, 'cancel')) s += '\\usepackage{cancel}\n';
  if (f.mustProvide('marvosym')) { if (f.mustProvide('bbding')) s += '\\let\\Cross\\relax\n'; s += '\\usepackage{marvosym}\n'; }
  if (f.mustProvide('accents') && usePackageAllowed(ctx, 'accents')) s += '\\usepackage{accents}\n';
  if (f.mustProvide('mathdots') && usePackageAllowed(ctx, 'mathdots')) s += '\\usepackage{mathdots}\n';
  if (f.mustProvide('yhmath') && usePackageAllowed(ctx, 'yhmath')) s += '\\usepackage{yhmath}\n';
  if (f.mustProvide('stmaryrd') && usePackageAllowed(ctx, 'stmaryrd')) s += '\\usepackage{stmaryrd}\n';
  if (f.mustProvide('stackrel') && usePackageAllowed(ctx, 'stackrel')) s += '\\usepackage{stackrel}\n';
  if (f.mustProvide('undertilde') && usePackageAllowed(ctx, 'undertilde')) s += '\\usepackage{undertilde}\n';
  if (f.isRequired('makeidx') || f.isRequired('splitidx')) {
    if (!f.isProvided('makeidx') && !f.isRequired('splitidx')) s += '\\usepackage{makeidx}\n';
    if (f.mustProvide('splitidx')) s += '\\usepackage{splitidx}\n';
    s += '\\makeindex\n';
  }
  if (f.mustProvide('graphicx') && bp.graphicsDriver !== 'none') {
    s += bp.graphicsDriver === 'default' ? '\\usepackage{graphicx}\n' : `\\usepackage[${bp.graphicsDriver}]{graphicx}\n`;
  }
  if (f.mustProvide('rotating')) s += '\\usepackage{rotating}\n';
  if (f.mustProvide('rotfloat')) s += '\\usepackage{rotfloat}\n';
  if (f.mustProvide('tablefootnote')) s += '\\usepackage{tablefootnote}\n';
  if (f.mustProvide('setspace') && !f.isProvided('SetSpace')) s += '\\usepackage{setspace}\n';
  if (f.mustProvide('mhchem') && usePackageAllowed(ctx, 'mhchem')) s += '\\PassOptionsToPackage{version=3}{mhchem}\n\\usepackage{mhchem}\n';
  if (f.mustProvide('wasysym') && usePackageAllowed(ctx, 'wasysym') && (usePackageAllowed(ctx, 'esint') || !f.isRequired('esint'))) s += '\\usepackage{wasysym}\n';
  if (f.mustProvide('esint') && usePackageAllowed(ctx, 'esint')) s += '\\usepackage{esint}\n';
  for (const name of BIBLIO_FEATURES) if (f.mustProvide(name)) s += `\\usepackage{${name}}\n`;
  if (f.mustProvide('natbib') && !f.isProvided('natbib-internal') && !f.isProvided('biblatex') && !f.isProvided('biblatex-natbib') && !f.isProvided('jurabib')) {
    s += `\\usepackage[${bp.citeEngineType === 'numerical' ? 'numbers' : 'authoryear'}${bp.biblioOptions ? ',' + bp.biblioOptions : ''}]{natbib}\n`;
  }
  if (f.mustProvide('jurabib') && !f.isProvided('natbib-internal') && !f.isProvided('natbib') && !f.isProvided('biblatex')) {
    s += `\\usepackage${bp.biblioOptions ? `[${bp.biblioOptions}]` : ''}{jurabib}[2004/01/25]\n`;
  }
  if (f.mustProvide('xargs')) s += '\\usepackage{xargs}[2008/03/08]\n';
  if (f.mustProvide('xy')) s += '\\usepackage[all]{xy}\n';
  if (f.mustProvide('feyn')) s += '\\usepackage{feyn}\n';
  if (f.mustProvide('ulem')) s += '\\PassOptionsToPackage{normalem}{ulem}\n\\usepackage{ulem}\n';
  if (f.mustProvide('nomencl')) {
    s += '\\usepackage{nomencl}\n% the following is useful when we have the old nomencl.sty package\n\\providecommand{\\printnomenclature}{\\printglossary}\n\\providecommand{\\makenomenclature}{\\makeglossary}\n\\makenomenclature\n';
  }
  if (f.mustProvide('footmisc')) s += '\\PassOptionsToPackage{stable}{footmisc}\n';
  if (f.mustProvide('microtype')) s += '\\usepackage{microtype}\n';
  return s;
}

function hyperrefPreamble(ctx: ExportContext): string {
  const { pdf } = ctx.bp;
  const f = ctx.features;
  let opt = '';
  let hyperset = '';
  const b = (v: boolean) => (v ? 'true' : 'false');
  if (pdf.useHyperref) {
    if (pdf.pdfusetitle && !pdf.title && !pdf.author) opt += 'pdfusetitle,';
    if (opt) opt += '\n ';
    opt += `bookmarks=${b(pdf.bookmarks)},`;
    if (pdf.bookmarks) {
      opt += `bookmarksnumbered=${b(pdf.bookmarksnumbered)},bookmarksopen=${b(pdf.bookmarksopen)},`;
      if (pdf.bookmarksopen) opt += `bookmarksopenlevel=${pdf.bookmarksopenlevel},`;
    }
    if (opt) opt += '\n ';
    opt += `breaklinks=${b(pdf.breaklinks)},pdfborder={0 0 ${pdf.pdfborder ? '0' : '1'}},`;
    if (pdf.pdfborder) opt += 'pdfborderstyle={},';
    opt += `backref=${pdf.backref},colorlinks=${b(pdf.colorlinks)},`;
    if (pdf.pagemode) opt += `pdfpagemode=${pdf.pagemode},`;
    if (pdf.title) hyperset += `pdftitle={${pdf.title}},`;
    if (pdf.author) hyperset += `\n pdfauthor={${pdf.author}},`;
    if (pdf.subject) hyperset += `\n pdfsubject={${pdf.subject}},`;
    if (pdf.keywords) hyperset += `\n pdfkeywords={${pdf.keywords}},`;
    if (pdf.quotedOptions) hyperset += '\n ' + pdf.quotedOptions;
    hyperset = hyperset.replace(/,+$/, '');
  }
  if (!f.isProvided('hyperref')) {
    opt = opt.replace(/,+$/, '');
    let out = `\\usepackage[${opt}]\n {hyperref}\n`;
    if (hyperset) out += `\\hypersetup{${hyperset}}\n`;
    return out;
  }
  const all = (opt + hyperset).replace(/,+$/, '');
  if (!all) return '';
  const cmd = `\\hypersetup{${all}}\n`;
  return `\\ifx\\hypersetup\\undefined\n  \\AtBeginDocument{%\n    ${cmd}  }\n\\else\n  ${cmd}\\fi\n`;
}

function floatDefinitions(ctx: ExportContext): string {
  let s = '';
  for (const [type, subfloat] of ctx.features.usedFloats) {
    const fl = ctx.dc.floats.get(type);
    if (!fl || fl.isPredefined) continue;
    if (type === 'tabular' || type === 'figure') {
      if (fl.style) s += `\\floatstyle{${fl.style}}\n\\restylefloat{${type}}\n`;
      if (fl.placement) s += `\\floatplacement{${type}}{${fl.placement}}\n`;
    } else {
      s += `\\floatstyle{${fl.style}}\n\\newfloat{${type}}{${fl.placement}}{${fl.extension}}`;
      if (fl.numberWithin) s += `[${fl.numberWithin}]`;
      s += `\n\\providecommand{\\${type}name}{${fl.guiName || type}}\n\\floatname{${type}}{\\protect\\${type}name}\n`;
    }
    if (subfloat) s += `\n\\AtBeginDocument{\\newsubfloat{${type}}}\n`;
  }
  return s;
}

/** LaTeXFeatures::getMacros */
function lyxMacros(ctx: ExportContext): string {
  const f = ctx.features;
  let m = '';
  const snippets = f.preambleSnippets.filter(s => !s.startsWith('\\addbibresource'));
  if (snippets.length) m += '\n' + snippets.join('\n') + '\n';
  if (f.mustProvide('papersize')) m += PAPERSIZEPDF_DEF;
  if (f.mustProvide('LyX')) {
    m += '\\providecommand{\\LyX}';
    if (f.isRequired('hyperref')) m += '{\\texorpdfstring';
    if (ctx.useBabel) m += '{\\ensureascii';
    m += LYX_DEF;
    if (ctx.useBabel) m += '}';
    if (f.isRequired('hyperref')) m += '{LyX}}';
    m += '\n';
  }
  if (f.mustProvide('noun')) m += NOUN_DEF + '\n';
  if (f.mustProvide('lyxarrow')) m += LYXARROW_DEF + '\n';
  if (f.mustProvide('lyxzerowidthspace')) m += LYXZWSP_DEF + '\n';
  if (!ctx.usePolyglossia && f.mustProvide('textgreek')) { if (ctx.mainFontenc === 'default') m += TEXTGREEK_LGR_DEF; m += TEXTGREEK_DEF + '\n'; }
  if (!ctx.usePolyglossia && f.mustProvide('textcyrillic')) { if (ctx.mainFontenc === 'default') m += TEXTCYR_T2A_DEF; m += TEXTCYR_DEF + '\n'; }
  if (f.mustProvide('lyxmathsym')) m += LYXMATHSYM_DEF + '\n';
  for (const q of ['quotesinglbase', 'quotedblbase', 'guilsinglleft', 'guilsinglright', 'guillemotleft', 'guillemotright', 'textquotedbl']) {
    if (f.mustProvide(q)) m += QUOTE_DEFS[q] + '\n';
  }
  if (f.mustProvide('binom') && !f.isRequired('amsmath')) m += BINOM_DEF + '\n';
  if (f.mustProvide('mathcircumflex')) m += MATHCIRCUMFLEX_DEF + '\n';
  if (f.mustProvide('ParagraphLeftIndent')) m += PARAGRAPHLEFTINDENT_DEF;
  if (f.mustProvide('NeedTabularnewline')) m += TABULARNEWLINE_DEF;
  if (f.mustProvide('cellvarwidth')) m += CELLVARWIDTH_DEF;
  if (f.mustProvide('lyxgreyedout')) m += lyxgreyedoutDef(f.mustProvide('ct-xcolor-ulem'));
  if (f.mustProvide('lyxdot')) m += LYXDOT_DEF + '\n';
  m += floatDefinitions(ctx);
  if (f.mustProvide('refstyle')) m += LYXREF_DEF + '\n';
  if (f.mustProvide('ct-xcolor-ulem')) {
    m += '\\providecolor{lyxadded}{rgb}{0,0,1}\n\\providecolor{lyxdeleted}{rgb}{1,0,0}\n';
    m += CT_BASE_DEF;
    if (f.isRequired('changebar')) m += CT_CB_DEF;
    else if (f.isRequired('hyperref')) m += CT_HYPERREF_DEF;
    else m += CT_DEF;
  }
  if (f.mustProvide('ct-none')) m += CT_NONE_DEF;
  return m;
}

/** Textclass preamble: class preamble + preambles of used layouts / inset layouts. */
function tclassPreamble(ctx: ExportContext): string {
  const { dc, features } = ctx;
  let s = dc.preamble;
  for (const name of features.usedLayouts) {
    const st = dc.styles.get(name);
    if (st && !st.inPreamble && st.preamble) s += st.preamble;
  }
  for (const name of features.usedInsetLayouts) {
    const il = dc.insetLayouts.get(name);
    if (il?.preamble) s += il.preamble;
  }
  return s;
}

/** Translate LyX's _(text) / _(text[[context]]) markers to plain English. */
function i18n(s: string, lang: string): string {
  return s.replace(/\$\$lang/g, lang).replace(/_\(([^)]*)\)/g, (_, t: string) => t.replace(/\[\[.*?\]\]/g, ''));
}

function tclassI18nPreamble(ctx: ExportContext): string {
  const { dc, features } = ctx;
  const snippets = new Set<string>();
  const others = [...features.usedLanguages.values()].map(l => l.babel).filter(Boolean);
  const docBabel = babelName(ctx, ctx.bp.language);
  const multi = (ctx.useBabel || ctx.usePolyglossia) && others.length > 0;
  const add = (lang: string, babel: string) => {
    if (lang) snippets.add(i18n(lang, docBabel));
    if (multi && babel) {
      snippets.add(i18n(babel, docBabel));
      for (const b of others) if (b !== docBabel) snippets.add(i18n(babel, b));
    }
  };
  for (const name of features.usedLayouts) { const st = dc.styles.get(name); if (st) add(st.langPreamble, st.babelPreamble); }
  for (const name of features.usedInsetLayouts) { const il = dc.insetLayouts.get(name); if (il) add(il.langPreamble, il.babelPreamble); }
  return [...snippets].filter(s => s.trim()).join('');
}

function babelCall(ctx: ExportContext): string {
  const langs = babelLanguages(ctx);
  const docBabel = babelName(ctx, ctx.bp.language);
  if (docBabel) langs.push(docBabel);
  if (!langs.length) return '';
  return '\\usepackage{babel}\n';
}

function spacingPreamble(ctx: ExportContext): string {
  const setSpace = ctx.features.isProvided('SetSpace');
  switch (ctx.bp.spacing) {
    case 'onehalf': return setSpace ? '\\OnehalfSpacing\n' : '\\onehalfspacing\n';
    case 'double': return setSpace ? '\\DoubleSpacing\n' : '\\doublespacing\n';
    case 'other': return (setSpace ? '\\setSpacing{' : '\\setstretch{') + ctx.bp.spacingValue + '}\n';
    default: return '';
  }
}

/** Full preamble (everything before \begin{document}). */
export function writePreamble(ctx: ExportContext): string {
  const { bp, dc, features: f } = ctx;
  let os = '';
  os += '%% LyX-compatible LaTeX export generated by OverLyX.\n';
  os += '%% Do not edit unless you really know what you are doing.\n';
  if (f.mustProvide('fix-cm')) os += '\\RequirePackage{fix-cm}\n';
  if (f.mustProvide('fixltx2e')) os += '\\RequirePackage{fixltx2e}\n';
  const opts = classOptions(ctx);
  os += '\\documentclass' + (opts ? `[${opts}]` : '') + `{${dc.latexName}}\n`;
  for (const [pkg, po] of dc.packageOptions) if (f.mustProvide(pkg)) os += `\\PassOptionsToPackage{${po}}{${pkg}}\n`;
  const ot1 = ctx.mainFontenc === 'default' || ctx.mainFontenc === 'OT1';
  const useNewtxmath = fontUsedPackage(ctx.fonts, bp.fontMath, { ot1, complete: false, sc: false, osf: false, nomath: false, extraOpts: '', scale: 100 }) === 'newtxmath';
  const ams = amsPackages(ctx);
  if ((bp.useNonTexFonts || useNewtxmath) && ams) os += ams;
  if (bp.useNonTexFonts) {
    if (!f.isProvided('fontspec')) os += '\\usepackage{fontspec}\n';
    if (f.mustProvide('unicode-math')) os += '\\usepackage{unicode-math}\n';
  }
  const fonts = fontsCode(ctx);
  if (fonts && (!ctx.useBabel || !bp.useNonTexFonts)) os += fonts;
  if (bp.fontDefaultFamily !== 'default') os += `\\renewcommand{\\familydefault}{\\${bp.fontDefaultFamily}}\n`;
  if (!bp.useNonTexFonts && !f.isProvided('fontenc') && ctx.mainFontenc !== 'default' && ctx.mainFontenc !== 'none') {
    const encs = [...f.fontEncodings.filter(e => e !== ctx.mainFontenc), ctx.mainFontenc];
    os += `\\usepackage[${encs.join(',')}]{fontenc}\n`;
  }
  if (f.mustProvide('textcomp')) os += '\\usepackage{textcomp}\n';
  if (f.mustProvide('pmboxdraw')) os += '\\usepackage{pmboxdraw}\n';
  os += encodingPreamble(ctx);
  os += geometry(ctx);
  if (dc.pageStyles.includes(bp.pageStyle)) {
    if (bp.pageStyle === 'fancy') os += '\\usepackage{fancyhdr}\n';
    os += `\\pagestyle{${bp.pageStyle}}\n`;
  }
  const hasTocLevels = [...dc.styles.values()].some(s => s.tocLevel !== -1000);
  if (hasTocLevels) {
    if (bp.secNumDepth !== dc.secNumDepth) os += `\\setcounter{secnumdepth}{${bp.secNumDepth}}\n`;
    if (bp.tocDepth !== dc.tocDepth) os += `\\setcounter{tocdepth}{${bp.tocDepth}}\n`;
  }
  if (bp.paragraphSeparation === 'skip') {
    let psopt = '';
    switch (bp.defSkip) {
      case 'smallskip': psopt = '\\smallskipamount'; break;
      case 'medskip': psopt = '\\medskipamount'; break;
      case 'bigskip': psopt = '\\bigskipamount'; break;
      case 'halfline': break;
      case 'fullline': psopt = '\\baselineskip'; break;
      default: psopt = latexLength(bp.defSkip); break;
    }
    if (!f.isProvided('parskip')) os += `\\usepackage${psopt ? `[skip=${psopt}]` : ''}{parskip}\n`;
    else os += `\\setlength{\\parskip}{${psopt}}\n`;
  } else if (bp.paragraphIndentation && bp.paragraphIndentation !== 'default') {
    os += `\\setlength{\\parindent}{${latexLength(bp.paragraphIndentation)}}\n`;
  }
  if (bp.isMathIndent && bp.mathIndentation && bp.mathIndentation !== 'default') os += `\\setlength{\\mathindent}{${bp.mathIndentation}}\n`;
  if (bp.outputSync) os += (bp.outputSyncMacro ? bp.outputSyncMacro : '\\synctex=-1') + '\n';
  os += colorOptions(ctx);
  const babelEarly = ctx.useBabel && (f.isRequired('jurabib') || f.isRequired('hyperref') || f.isRequired('varioref') || f.isRequired('japanese'));
  if (babelEarly) os += babelCall(ctx);
  os += packages(ctx);
  os += spacingPreamble(ctx);
  if (f.isRequired('hyperref')) os += hyperrefPreamble(ctx);
  else if (f.isRequired('nameref')) os += '\\usepackage{nameref}\n';
  if (bp.useLineno) os += `\\usepackage${bp.linenoOptions ? `[${bp.linenoOptions}]` : ''}{lineno}\n\\linenumbers\n`;
  if (f.mustProvide('bibtopic')) os += '\\usepackage[dot]{bibtopic}\n';
  if (f.mustProvide('cleveref') && !/\\usepackage(\[[^\]]*\])?\{cleveref\}/.test(bp.preamble)) os += '\\usepackage{cleveref}\n';

  // \makeatletter block
  let at = '';
  const macros = lyxMacros(ctx);
  if (macros.trim()) at += '\n%%%%%%%%%%%%%%%%%%%%%%%%%%%%%% LyX specific LaTeX commands.\n' + macros + '\n';
  const tc = tclassPreamble(ctx);
  if (tc.trim()) at += '%%%%%%%%%%%%%%%%%%%%%%%%%%%%%% Textclass specific LaTeX commands.\n' + tc + '\n';
  if (bp.suppressDate) at += '\\@ifundefined{date}{}{\\date{}}\n';
  if (bp.preamble.trim()) at += '%%%%%%%%%%%%%%%%%%%%%%%%%%%%%% User specified LaTeX commands.\n' + bp.preamble.replace(/\n+$/, '') + '\n\n';
  if (f.mustProvide('footmisc')) at += '\\usepackage{footmisc}\n';
  if (f.mustProvide('subfig')) at += '\\ifdefined\\showcaptionsetup\n % Caption package is used. Advise subfig not to load it again.\n \\PassOptionsToPackage{caption=false}{subfig}\n\\fi\n\\usepackage{subfig}\n';
  if (at) os += '\n\\makeatletter\n' + at + '\\makeatother\n\n';

  if (ctx.useBabel && !babelEarly) os += babelCall(ctx);
  if (fonts && ctx.useBabel && bp.useNonTexFonts) os += fonts;
  if (f.isRequired('bicaption')) os += '\\usepackage{bicaption}\n';
  if (bp.listingsParams || f.mustProvide('listings') || f.mustProvide('minted')) {
    os += bp.useMinted ? '\\usepackage{minted}\n' : '\\usepackage{listings}\n';
  }
  if (bp.listingsParams) os += (bp.useMinted ? '\\setminted{' : '\\lstset{') + bp.listingsParams + '}\n';
  if (f.isRequired('covington')) os += '\\usepackage{covington}\n';
  if (ctx.usePolyglossia) {
    os += '\\usepackage{polyglossia}\n';
    const doc = ctx.langs.get(bp.language);
    os += `\\setdefaultlanguage${doc?.polyglossiaOpts ? `[${doc.polyglossiaOpts}]` : ''}{${doc?.polyglossia || 'english'}}\n`;
    const seen = new Set<string>();
    for (const [, l] of f.usedLanguages) {
      if (!l.polyglossia || l.polyglossia === doc?.polyglossia || seen.has(l.polyglossia)) continue;
      seen.add(l.polyglossia);
      os += `\\setotherlanguage{${l.polyglossia}}\n`;
    }
  }
  if ((f.mustProvide('biblatex') || f.isRequired('biblatex-chicago')) && !f.isProvided('biblatex-natbib') && !f.isProvided('natbib-internal') && !f.isProvided('natbib') && !f.isProvided('jurabib')) {
    const o: string[] = [];
    if (bp.biblatexBibstyle && bp.biblatexBibstyle === bp.biblatexCitestyle) o.push(`style=${bp.biblatexBibstyle}`);
    else {
      if (bp.biblatexBibstyle) o.push(`bibstyle=${bp.biblatexBibstyle}`);
      if (bp.biblatexCitestyle) o.push(`citestyle=${bp.biblatexCitestyle}`);
    }
    if (bp.citeEngine === 'biblatex-natbib') o.push('natbib=true');
    if (bp.bibtexCommand === 'bibtex8' || bp.bibtexCommand.startsWith('bibtex8 ')) o.push('backend=bibtex8');
    else if (bp.bibtexCommand === 'bibtex' || bp.bibtexCommand.startsWith('bibtex ')) o.push('backend=bibtex');
    if (bp.biblioOptions) o.push(bp.biblioOptions);
    os += `\\usepackage${o.length ? `[${o.join(',')}]` : ''}{biblatex}\n`;
    for (const s of f.preambleSnippets) if (s.startsWith('\\addbibresource')) os += s + '\n';
  }
  if (bp.languagePackage !== 'auto' && bp.languagePackage !== 'babel' && bp.languagePackage !== 'default' && bp.languagePackage !== 'none') {
    os += bp.languagePackage + '\n';
  }
  if (f.isRequired('menukeys')) os += '\\usepackage{menukeys}\n';
  const i18np = tclassI18nPreamble(ctx);
  if (i18np) os += i18np + '\n';
  return os;
}
