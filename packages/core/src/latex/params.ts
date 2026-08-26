/**
 * Typed view of the LyX document header (BufferParams), read from the verbatim
 * header lines kept in the AST.
 */
import type { Header, LyxDocument } from '../lyx/ast.ts';
import { getAuthors, headerBlock, headerValue } from '../lyx/ast.ts';

export interface BranchInfo { name: string; selected: boolean; }

export interface PdfOptions {
  useHyperref: boolean;
  title: string; author: string; subject: string; keywords: string;
  bookmarks: boolean; bookmarksnumbered: boolean; bookmarksopen: boolean; bookmarksopenlevel: number;
  breaklinks: boolean; pdfborder: boolean; colorlinks: boolean; backref: string; pdfusetitle: boolean;
  pagemode: string; quotedOptions: string;
}

export interface BufferParams {
  textclass: string;
  modules: string[];
  options: string;
  useDefaultOptions: boolean;
  preamble: string;
  language: string;
  languagePackage: string;
  inputenc: string;
  fontenc: string;
  fontRoman: string; fontSans: string; fontTypewriter: string; fontMath: string;
  fontRomanOpts: string; fontSansOpts: string; fontTypewriterOpts: string;
  fontDefaultFamily: string;
  useNonTexFonts: boolean;
  fontSc: boolean; fontRomanOsf: boolean; fontSansOsf: boolean; fontTypewriterOsf: boolean;
  fontSfScale: number; fontTtScale: number;
  useMicrotype: boolean;
  useDashLigatures: boolean;
  graphicsDriver: string;
  floatPlacement: string;
  floatAlignment: string;
  paperFontSize: string;
  spacing: string;          // single | onehalf | double | other
  spacingValue: string;
  pdf: PdfOptions;
  paperSize: string;
  paperWidth: string; paperHeight: string;
  useGeometry: boolean;
  leftMargin: string; topMargin: string; rightMargin: string; bottomMargin: string;
  headHeight: string; headSep: string; footSkip: string; columnSep: string;
  usePackage: Map<string, number>;
  citeEngine: string;
  citeEngineType: string;
  biblioStyle: string;
  biblioOptions: string;
  biblatexBibstyle: string;
  biblatexCitestyle: string;
  useBibtopic: boolean;
  useIndices: boolean;
  orientation: string;
  suppressDate: boolean;
  justification: boolean;
  /** refstyle | prettyref | cleveref */
  crossrefPackage: string;
  useMinted: boolean;
  useLineno: boolean;
  linenoOptions: string;
  backgroundColor: string;
  fontColor: string;
  noteFontColor: string;
  boxBgColor: string;
  secNumDepth: number;
  tocDepth: number;
  paragraphSeparation: string;  // indent | skip
  paragraphIndentation: string;
  defSkip: string;
  isMathIndent: boolean;
  mathIndentation: string;
  mathNumberingSide: string;
  quotesStyle: string;
  dynamicQuotes: boolean;
  columns: number;
  sides: number;
  pageStyle: string;
  listingsParams: string;
  trackingChanges: boolean;
  outputChanges: boolean;
  changeBars: boolean;
  outputSync: boolean;
  outputSyncMacro: string;
  branches: BranchInfo[];
  authors: Map<number, { name: string; email: string }>;
  bibEncoding: string;
  bibtexCommand: string;
  master: string;
  /** Output fragile commands (labels, index entries) after moving-argument commands */
  postponeFragileContent: boolean;
}

function bool(v: string | undefined, def = false): boolean {
  if (v === undefined) return def;
  const l = v.trim().toLowerCase();
  if (l === 'true' || l === '1' || l === 'yes') return true;
  if (l === 'false' || l === '0' || l === 'no') return false;
  return def;
}

function int(v: string | undefined, def: number): number {
  if (v === undefined) return def;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? def : n;
}

function firstQuoted(v: string | undefined, def = 'default'): string {
  if (v === undefined) return def;
  const m = /^"([^"]*)"/.exec(v.trim());
  if (m) return m[1];
  return v.trim().split(/\s+/)[0] || def;
}

function quotedList(v: string | undefined): string[] {
  if (!v) return [];
  const out: string[] = [];
  const re = /"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(v))) out.push(m[1]);
  return out;
}

function readBranches(h: Header): BranchInfo[] {
  const out: BranchInfo[] = [];
  for (let i = 0; i < h.lines.length; i++) {
    const l = h.lines[i];
    if (!l.startsWith('\\branch ')) continue;
    const name = l.slice(8);
    let selected = false;
    for (let j = i + 1; j < h.lines.length && h.lines[j] !== '\\end_branch'; j++) {
      if (h.lines[j].startsWith('\\selected ')) selected = h.lines[j].slice(10).trim() === '1';
    }
    out.push({ name, selected });
  }
  return out;
}

function readUsePackages(h: Header): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of h.lines) {
    if (!l.startsWith('\\use_package ')) continue;
    const [name, val] = l.slice(13).trim().split(/\s+/);
    m.set(name, int(val, 1));
  }
  // legacy tokens
  const amsmath = headerValue(h, 'use_amsmath');
  if (amsmath !== undefined && !m.has('amsmath')) m.set('amsmath', int(amsmath, 1));
  const esint = headerValue(h, 'use_esint');
  if (esint !== undefined && !m.has('esint')) m.set('esint', int(esint, 1));
  return m;
}

export function readBufferParams(doc: LyxDocument): BufferParams {
  const h = doc.header;
  const v = (k: string) => headerValue(h, k);
  const spacingRaw = (v('spacing') ?? 'single').trim();
  const spacingParts = spacingRaw.split(/\s+/);
  let inputenc = v('inputencoding') ?? 'utf8';
  if (inputenc === 'auto') inputenc = 'auto-legacy';
  if (inputenc === 'default') inputenc = 'auto-legacy-plain';
  let crossref = v('crossref_package');
  if (!crossref) crossref = bool(v('use_refstyle'), true) ? 'refstyle' : 'prettyref';
  const fontSf = (v('font_sf_scale') ?? '100').split(/\s+/);
  const fontTt = (v('font_tt_scale') ?? '100').split(/\s+/);
  const authors = new Map<number, { name: string; email: string }>();
  for (const a of getAuthors(h)) authors.set(a.id, { name: a.name, email: a.email ?? '' });
  const useNonTexFonts = bool(v('use_non_tex_fonts'));
  const fontPick = (key: string) => {
    const vals = quotedList(v(key));
    if (vals.length >= 2) return useNonTexFonts ? vals[1] : vals[0];
    return firstQuoted(v(key));
  };
  const osfLegacy = bool(v('font_osf'));
  const justification = v('justification');
  return {
    textclass: v('textclass') ?? 'article',
    modules: headerBlock(h, 'modules') ?? [],
    options: v('options') ?? '',
    useDefaultOptions: bool(v('use_default_options')),
    preamble: (headerBlock(h, 'preamble') ?? []).join('\n'),
    language: v('language') ?? 'english',
    languagePackage: v('language_package') ?? 'default',
    inputenc,
    fontenc: v('fontencoding') ?? 'auto',
    fontRoman: fontPick('font_roman'),
    fontSans: fontPick('font_sans'),
    fontTypewriter: fontPick('font_typewriter'),
    fontMath: fontPick('font_math') || 'auto',
    fontRomanOpts: firstQuoted(v('font_roman_opts'), ''),
    fontSansOpts: firstQuoted(v('font_sans_opts'), ''),
    fontTypewriterOpts: firstQuoted(v('font_typewriter_opts'), ''),
    fontDefaultFamily: v('font_default_family') ?? 'default',
    useNonTexFonts,
    fontSc: bool(v('font_sc')),
    fontRomanOsf: bool(v('font_roman_osf'), osfLegacy),
    fontSansOsf: bool(v('font_sans_osf'), osfLegacy),
    fontTypewriterOsf: bool(v('font_typewriter_osf'), osfLegacy),
    fontSfScale: int(useNonTexFonts ? fontSf[1] ?? fontSf[0] : fontSf[0], 100),
    fontTtScale: int(useNonTexFonts ? fontTt[1] ?? fontTt[0] : fontTt[0], 100),
    useMicrotype: bool(v('use_microtype')),
    useDashLigatures: bool(v('use_dash_ligatures'), true),
    graphicsDriver: v('graphics') ?? 'default',
    floatPlacement: v('float_placement') ?? '',
    floatAlignment: v('float_alignment') ?? 'class',
    paperFontSize: v('paperfontsize') ?? 'default',
    spacing: spacingParts[0] || 'single',
    spacingValue: spacingParts[1] ?? '',
    pdf: {
      useHyperref: bool(v('use_hyperref')),
      title: firstQuoted(v('pdf_title'), ''), author: firstQuoted(v('pdf_author'), ''), subject: firstQuoted(v('pdf_subject'), ''), keywords: firstQuoted(v('pdf_keywords'), ''),
      bookmarks: bool(v('pdf_bookmarks'), true), bookmarksnumbered: bool(v('pdf_bookmarksnumbered')),
      bookmarksopen: bool(v('pdf_bookmarksopen')), bookmarksopenlevel: int(v('pdf_bookmarksopenlevel'), 1),
      breaklinks: bool(v('pdf_breaklinks')), pdfborder: bool(v('pdf_pdfborder')), colorlinks: bool(v('pdf_colorlinks')),
      backref: v('pdf_backref') ?? 'false', pdfusetitle: bool(v('pdf_pdfusetitle')), pagemode: v('pdf_pagemode') ?? '',
      quotedOptions: firstQuoted(v('pdf_quoted_options'), ''),
    },
    paperSize: v('papersize') ?? 'default',
    paperWidth: v('paperwidth') ?? '', paperHeight: v('paperheight') ?? '',
    useGeometry: bool(v('use_geometry')),
    leftMargin: v('leftmargin') ?? '', topMargin: v('topmargin') ?? '', rightMargin: v('rightmargin') ?? '',
    bottomMargin: v('bottommargin') ?? '', headHeight: v('headheight') ?? '', headSep: v('headsep') ?? '',
    footSkip: v('footskip') ?? '', columnSep: v('columnsep') ?? '',
    usePackage: readUsePackages(h),
    citeEngine: v('cite_engine') ?? 'basic',
    citeEngineType: v('cite_engine_type') ?? 'default',
    biblioStyle: v('biblio_style') ?? 'plain',
    biblioOptions: v('biblio_options') ?? '',
    biblatexBibstyle: v('biblatex_bibstyle') ?? '',
    biblatexCitestyle: v('biblatex_citestyle') ?? '',
    useBibtopic: bool(v('use_bibtopic')),
    useIndices: bool(v('use_indices')),
    orientation: v('paperorientation') ?? 'portrait',
    suppressDate: bool(v('suppress_date')),
    justification: justification === undefined || justification === 'default' ? true : bool(justification, true),
    crossrefPackage: crossref,
    useMinted: bool(v('use_minted')),
    useLineno: bool(v('use_lineno')),
    linenoOptions: v('lineno_options') ?? '',
    backgroundColor: v('backgroundcolor') ?? 'none',
    fontColor: v('fontcolor') ?? 'none',
    noteFontColor: v('notefontcolor') ?? 'lightgray',
    boxBgColor: v('boxbgcolor') ?? 'red',
    secNumDepth: int(v('secnumdepth'), 3),
    tocDepth: int(v('tocdepth'), 3),
    paragraphSeparation: v('paragraph_separation') ?? 'indent',
    paragraphIndentation: v('paragraph_indentation') ?? 'default',
    defSkip: v('defskip') ?? 'medskip',
    isMathIndent: bool(v('is_math_indent')),
    mathIndentation: v('math_indentation') ?? 'default',
    mathNumberingSide: v('math_numbering_side') ?? 'default',
    quotesStyle: v('quotes_style') ?? 'english',
    dynamicQuotes: bool(v('dynamic_quotes')),
    columns: int(v('papercolumns'), 1),
    sides: int(v('papersides'), 1),
    pageStyle: v('paperpagestyle') ?? 'default',
    listingsParams: firstQuoted(v('listings_params'), ''),
    trackingChanges: bool(v('tracking_changes')),
    outputChanges: bool(v('output_changes')),
    changeBars: bool(v('change_bars')),
    outputSync: bool(v('output_sync')),
    outputSyncMacro: firstQuoted(v('output_sync_macro'), ''),
    branches: readBranches(h),
    authors,
    bibEncoding: v('bib_encoding') ?? '',
    bibtexCommand: v('bibtex_command') ?? 'default',
    master: v('master') ?? '',
    postponeFragileContent: bool(v('postpone_fragile_content'), true),
  };
}

/** LyX color name / hex → "r, g, b" for \definecolor{}{rgb}{}. Returns undefined for none. */
export function colorToRgb(c: string): string | undefined {
  const named: Record<string, string> = {
    black: '#000000', white: '#ffffff', red: '#ff0000', green: '#00ff00', blue: '#0000ff', cyan: '#00ffff',
    magenta: '#ff00ff', yellow: '#ffff00', lightgray: '#cccccc', gray: '#808080', darkgray: '#404040',
    brown: '#a52a2a', lime: '#bfff00', olive: '#808000', orange: '#ffa500', pink: '#ffc0cb', purple: '#800080',
    teal: '#008080', violet: '#800080',
  };
  let hex = c.trim().toLowerCase();
  if (hex === 'none' || hex === '' || hex === 'default') return undefined;
  if (!hex.startsWith('#')) hex = named[hex] ?? '';
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(hex);
  if (!m) return undefined;
  const f = (x: string) => {
    const n = parseInt(x, 16) / 255;
    return String(Number(n.toFixed(2)));
  };
  return `${f(m[1])}, ${f(m[2])}, ${f(m[3])}`;
}
