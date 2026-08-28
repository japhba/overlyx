/**
 * Document model → .tex file. The body is written by the LyX-faithful exporter (latex/) in its
 * round-trip mode; the preamble is the user's own (kept verbatim in the document settings) plus a
 * managed block with the packages and macros the content needs and a settings line for what
 * LaTeX cannot express. `parseTex(writeTex(doc))` reproduces the document, and writing a parsed
 * file again reproduces the file.
 */
import type { LyxDocument } from '../lyx/ast.ts';
import { readBufferParams } from '../latex/params.ts';
import { makeContext, collectBibLabels, validateParams, writeBody, finishExport } from '../latex/export.ts';
import { colorOptions, packages, lyxMacros, tclassPreamble, tclassI18nPreamble, writePreamble } from '../latex/preamble.ts';
import { babelName } from '../latex/text.ts';
import type { ExportContext, ExportOptions } from '../latex/context.ts';
import { MANAGED_BEGIN, MANAGED_END, preambleFacts, providedFeatures, settingsFromHeader, settingsLine } from './preamble.ts';

export interface WriteTexOptions {
  layoutDir?: string;
  localDirs?: string[];
  /** child documents (\input / \include) — read for the packages and macros they need */
  resolveInclude?: (filename: string) => LyxDocument | undefined;
  /** read a file relative to the document (\input'ed preamble files: what they load counts as provided) */
  readFile?: (name: string) => string | undefined;
  /** write the body only, with a settings line (a child document / fragment) */
  fragment?: boolean;
  basename?: string;
  /**
   * The document comes from a .lyx file: the whole preamble (class options, fonts, geometry,
   * packages, ...) is generated from the LyX settings, as LyX's own export would.
   */
  fromLyx?: boolean;
  /** comment lines to put at the top of the file (import note) */
  head?: string[];
}

export interface WriteTexResult {
  text: string;
  warnings: string[];
  /** LaTeX packages the document uses */
  requires: Set<string>;
  /** graphics that need conversion for pdflatex (svg, eps, ...): `src` as referenced in the file */
  graphics: { src: string; dest: string }[];
}

/** The managed block: packages / macros for the features the body uses that the preamble lacks. */
function managedBlock(ctx: ExportContext, provided: Set<string>, settings: Record<string, unknown>): string {
  const f = ctx.features.withProvides(provided);
  const c: ExportContext = { ...ctx, features: f, dc: f.dc };
  const { bp, dc } = c;
  let s = '';
  for (const [pkg, po] of dc.packageOptions) if (f.mustProvide(pkg)) s += `\\PassOptionsToPackage{${po}}{${pkg}}\n`;
  if (f.mustProvide('fix-cm')) s += '\\RequirePackage{fix-cm}\n';
  if (f.mustProvide('textcomp')) s += '\\usepackage{textcomp}\n';
  if (f.mustProvide('pmboxdraw')) s += '\\usepackage{pmboxdraw}\n';
  if (f.mustProvide('unicode-math') && bp.useNonTexFonts) s += '\\usepackage{unicode-math}\n';
  s += colorOptions(c);
  s += packages(c);
  // hyperref is configured by the user's preamble; only load it when links need it
  if (f.isRequired('hyperref') && !f.isProvided('hyperref')) s += '\\usepackage{hyperref}\n';
  else if (f.isRequired('nameref') && !f.isProvided('nameref') && !f.isProvided('hyperref')) s += '\\usepackage{nameref}\n';
  if (f.mustProvide('cleveref')) s += '\\usepackage{cleveref}\n';
  if (f.mustProvide('bibtopic')) s += '\\usepackage[dot]{bibtopic}\n';
  let at = '';
  const macros = lyxMacros(c);
  if (macros.trim()) at += macros.replace(/^\n+/, '') + (macros.endsWith('\n') ? '' : '\n');
  const tc = tclassPreamble(c);
  if (tc.trim()) at += tc + (tc.endsWith('\n') ? '' : '\n');
  if (f.mustProvide('footmisc')) at += '\\usepackage{footmisc}\n';
  if (f.mustProvide('subfig')) at += '\\ifdefined\\showcaptionsetup\n % Caption package is used. Advise subfig not to load it again.\n \\PassOptionsToPackage{caption=false}{subfig}\n\\fi\n\\usepackage{subfig}\n';
  if (at) s += '\\makeatletter\n' + at + '\\makeatother\n';
  // other languages used in the text
  if (c.useBabel && !f.isProvided('babel')) {
    const docBabel = babelName(c, bp.language);
    const langs = new Set<string>();
    for (const [, l] of f.usedLanguages) if (l.babel && l.babel !== docBabel) langs.add(l.babel);
    if (langs.size) s += `\\usepackage[${[...langs].sort().join(',')}${docBabel ? ',' + docBabel : ''}]{babel}\n`;
  }
  if (f.isRequired('bicaption') && !f.isProvided('bicaption')) s += '\\usepackage{bicaption}\n';
  if (f.mustProvide('listings') || f.mustProvide('minted')) {
    s += bp.useMinted ? '\\usepackage{minted}\n' : '\\usepackage{listings}\n';
    if (bp.listingsParams) s += (bp.useMinted ? '\\setminted{' : '\\lstset{') + bp.listingsParams + '}\n';
  }
  if (f.isRequired('covington') && !f.isProvided('covington')) s += '\\usepackage{covington}\n';
  if ((f.mustProvide('biblatex') || f.isRequired('biblatex-chicago')) && !f.isProvided('biblatex-natbib') && !f.isProvided('natbib-internal') && !f.isProvided('natbib') && !f.isProvided('jurabib')) {
    const o: string[] = [];
    if (bp.biblatexBibstyle && bp.biblatexBibstyle === bp.biblatexCitestyle) o.push(`style=${bp.biblatexBibstyle}`);
    else {
      if (bp.biblatexBibstyle) o.push(`bibstyle=${bp.biblatexBibstyle}`);
      if (bp.biblatexCitestyle) o.push(`citestyle=${bp.biblatexCitestyle}`);
    }
    if (bp.citeEngine === 'biblatex-natbib') o.push('natbib=true');
    if (bp.biblioOptions) o.push(bp.biblioOptions);
    s += `\\usepackage${o.length ? `[${o.join(',')}]` : ''}{biblatex}\n`;
  }
  if (f.isRequired('biblatex') || f.isProvided('biblatex')) {
    const have = preambleFacts(bp.preamble).addbibresources.map(x => x.replace(/\.bib$/, ''));
    for (const snip of f.preambleSnippets) {
      const m = /^\\addbibresource\{([^}]*)\}$/.exec(snip);
      if (m && !have.includes(m[1].replace(/\.bib$/, ''))) s += snip + '\n';
    }
  }
  if (f.isRequired('menukeys') && !f.isProvided('menukeys')) s += '\\usepackage{menukeys}\n';
  const i18np = tclassI18nPreamble(c);
  if (i18np) s += i18np + (i18np.endsWith('\n') ? '' : '\n');
  return MANAGED_BEGIN + '\n' + settingsLine(settings) + '\n'
    + '%% Packages and macros needed by the content (generated on every save; put your own preamble above this block).\n'
    + s + MANAGED_END + '\n';
}

export function writeTex(doc: LyxDocument, opts: WriteTexOptions = {}): WriteTexResult {
  const bp = readBufferParams(doc);
  const facts = preambleFacts(bp.preamble, opts.readFile);
  let provided = providedFeatures(facts);
  const eopts: ExportOptions = {
    layoutDir: opts.layoutDir, localDirs: opts.localDirs, resolveInclude: opts.resolveInclude, basename: opts.basename,
    // an imported LyX document gets the packages LyX would load itself, whatever the user's
    // preamble files load: the user's \input{macros} may need them before \input{preamble}
    texMode: true, provided: opts.fromLyx ? undefined : provided, isChild: opts.fragment,
  };
  const ctx = makeContext(doc, eopts);
  ctx.warnings.push(...ctx.dc.warnings);
  collectBibLabels(ctx);
  validateParams(ctx);
  const body = writeBody(ctx);
  ctx.features.resolveAlternatives(name => (ctx.bp.usePackage.get(name) ?? 1) !== 0);
  const f = ctx.features;
  if (f.isRequired('textgreek')) f.addFontEncoding('LGR');
  if (f.isRequired('textcyrillic')) f.addFontEncoding('T2A');
  const settings = settingsFromHeader(doc.header.lines);
  let text: string;
  const bodyText = body.replace(/\n+$/, '') + '\n';
  if (opts.fragment) {
    text = settingsLine(settings) + '\n' + bodyText;
  } else {
    let preamble: string;
    if (opts.fromLyx) {
      // the LyX settings become a real preamble (as LyX's export writes it), without the
      // feature macros — those go to the managed block
      preamble = writePreamble(ctx, { noMacros: true }).split('\n').filter(l => !l.startsWith('%% LyX-compatible') && !l.startsWith('%% Do not edit')).join('\n').replace(/\n+$/, '') + '\n';
      provided = providedFeatures(preambleFacts(preamble, opts.readFile));
    } else {
      preamble = `\\documentclass${bp.options ? `[${bp.options}]` : ''}{${ctx.dc.latexName}}\n`;
      if (bp.preamble.trim()) preamble += bp.preamble.replace(/\s+$/, '') + '\n';
    }
    const head = [...(opts.head ?? []), ...doc.preamble.filter(l => l.startsWith('%'))];
    text = (head.length ? head.join('\n') + '\n' : '') + preamble + '\n' + managedBlock(ctx, provided, settings) + '\n\\begin{document}\n' + bodyText + '\n\\end{document}\n';
    if (doc.trailer.length) text += doc.trailer.join('\n') + '\n';
  }
  const res = finishExport(ctx, text);
  return { text: res.tex, warnings: res.warnings, requires: res.requires, graphics: res.graphics };
}
