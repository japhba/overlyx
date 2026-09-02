/**
 * OverLyX LaTeX exporter — entry point.
 *
 * `exportLatex(doc, opts)` renders a LyX document AST to a LaTeX file the way
 * LyX itself does (preamble from the document settings + used features, body
 * from the paragraphs), including child documents and graphics conversions.
 */
import { join } from 'node:path';
import type { LyxDocument } from '../lyx/ast.ts';
import { applyDocumentTheorems, DEFAULT_LAYOUT_DIR, loadDocumentClass } from './layouts.ts';
import { readBufferParams, type BufferParams } from './params.ts';
import { Features } from './features.ts';
import { loadLanguages, ENCODING_LATEX_NAMES } from './languages.ts';
import { loadUnicodeSymbols } from './unicode.ts';
import { loadMathSymbols } from './symbols.ts';
import { loadLatexFonts, fontEncodings } from './latexfonts.ts';
import { TexStream } from './stream.ts';
import { latexParagraphs } from './body.ts';
import { writePreamble } from './preamble.ts';
import { newRunParams, type ExportContext, type ExportOptions, type ExportResult } from './context.ts';
import { paramMap, unquote, walkInsets } from '../lyx/ast.ts';

export type { ExportOptions, ExportResult } from './context.ts';

/** The LyX "lib" directory, derived from the layout directory. */
function libDir(layoutDir: string): string {
  return join(layoutDir, '..');
}

export function makeContext(doc: LyxDocument, opts: ExportOptions, parent?: ExportContext): ExportContext {
  const layoutDir = opts.layoutDir ?? parent?.opts.layoutDir ?? DEFAULT_LAYOUT_DIR;
  const lib = libDir(layoutDir);
  const bp = readBufferParams(doc);
  // children use the master's parameters for everything that affects the preamble
  const effective: BufferParams = parent ? { ...parent.bp, branches: [...parent.bp.branches, ...bp.branches] } : bp;
  const localDirs = opts.localDirs ?? parent?.opts.localDirs ?? [];
  const dc0 = parent ? parent.dc : loadDocumentClass(effective.textclass, effective.modules, layoutDir, localDirs);
  // tex mode: what the user's preamble loads counts as provided by the class
  const dcProvided = parent || !opts.provided?.size ? dc0 : { ...dc0, provides: new Set([...dc0.provides, ...opts.provided]) };
  // the document's own \newtheorem environments (kept in the user preamble) as layouts
  const dc = parent ? dcProvided : applyDocumentTheorems(dcProvided, effective.preamble, layoutDir, localDirs);
  const langs = parent?.langs ?? loadLanguages(join(lib, 'languages'));
  const docLanguage = langs.get(effective.language) ?? langs.get('english') ?? {
    name: effective.language, guiName: '', babel: '', polyglossia: '', polyglossiaOpts: '', encoding: 'iso8859-1', fontEncoding: ['ASCII'],
    quoteStyle: 'english', rtl: false, internalEncoding: false, requires: '', langCode: '',
  };
  const fonts = parent?.fonts ?? loadLatexFonts(join(lib, 'latexfonts'));
  // font encoding (Language::fontenc + BufferParams::main_font_encoding)
  let mainFontenc: string;
  if (effective.useNonTexFonts) mainFontenc = 'TU';
  else if (effective.fontenc === 'default') mainFontenc = 'default';
  else if (effective.fontenc !== 'auto' && effective.fontenc) mainFontenc = effective.fontenc.split(',').pop()!.trim();
  else {
    const romanEncs = fontEncodings(fonts, effective.fontRoman);
    let enc = '';
    for (const fe of docLanguage.fontEncoding) {
      if (fe === 'ASCII') { enc = romanEncs.find(e => e === 'OT1' || e.startsWith('T')) ?? 'T1'; break; }
      if (romanEncs.includes(fe)) { enc = fe; break; }
    }
    if (!enc) enc = docLanguage.fontEncoding[0] === 'ASCII' ? 'T1' : docLanguage.fontEncoding[0];
    mainFontenc = enc.toLowerCase() === 'none' ? 'none' : enc;
  }
  // encoding
  let encodingMode: ExportContext['encodingMode'];
  let encodingName: string;
  if (effective.useNonTexFonts) { encodingMode = 'plain'; encodingName = 'utf8'; }
  else if (effective.inputenc === 'auto-legacy' || effective.inputenc === 'auto-legacy-plain') {
    encodingName = ENCODING_LATEX_NAMES[docLanguage.encoding] ?? docLanguage.encoding;
    encodingMode = encodingName === 'utf8' ? 'utf8' : 'legacy';
  } else if (effective.inputenc === 'utf8' || effective.inputenc === 'utf8x' || effective.inputenc === 'utf8-plain') {
    encodingMode = effective.inputenc === 'utf8-plain' ? 'plain' : 'utf8';
    encodingName = effective.inputenc === 'utf8x' ? 'utf8x' : 'utf8';
  } else {
    encodingMode = 'legacy';
    encodingName = ENCODING_LATEX_NAMES[effective.inputenc] ?? effective.inputenc;
  }
  const features = parent?.features ?? new Features(dc);
  const lp = effective.languagePackage;
  const babelRequired = !!docLanguage.babel;
  let useBabel = false;
  let usePolyglossia = false;
  if (lp === 'none') { /* nothing */ }
  else if (lp === 'auto' || lp === 'default') {
    if (effective.useNonTexFonts && docLanguage.polyglossia) usePolyglossia = true;
    else if (babelRequired) useBabel = true;
  } else if (lp === 'babel') { if (babelRequired) useBabel = true; }
  else { /* custom package string */ }
  const texMode = parent ? parent.texMode : !!opts.texMode;
  // tex mode: change tracking is always written (it is the only place the changes live)
  const outputChanges = texMode ? true : opts.outputChanges ?? (parent ? parent.outputChanges : bp.outputChanges);
  return {
    doc, bp: effective, dc, features, opts: parent ? { ...opts, layoutDir } : opts,
    warnings: parent?.warnings ?? [], files: parent?.files ?? {}, graphics: parent?.graphics ?? [],
    langs, unicode: parent?.unicode ?? loadUnicodeSymbols(join(lib, 'unicodesymbols')),
    symbols: parent?.symbols ?? loadMathSymbols(join(lib, 'symbols')), fonts,
    docLanguage, useBabel, usePolyglossia, mainFontenc, encodingMode, encodingName, outputChanges,
    isChild: !!parent || !!opts.isChild, needMaketitle: parent?.needMaketitle ?? false, haveMaketitle: parent?.haveMaketitle ?? false,
    bibLabels: [], openLanguage: effective.language, includeDepth: (parent?.includeDepth ?? -1) + 1, bodyPars: doc.body,
    macroNames: parent?.macroNames ?? new Set<string>(),
    texMode, usedChanges: false,
  };
}

/** Collect bibliography labels (for the widest label) and math macro names. */
export function collectBibLabels(ctx: ExportContext): void {
  for (const { inset } of walkInsets(ctx.doc.body)) {
    if (inset.type === 'FormulaMacro') {
      const m = /^\\(?:re)?newcommand\*?\s*\{?\\([A-Za-z@]+)|^\\(?:global\\)?(?:long\\)?def\\([A-Za-z@]+)/.exec(inset.lines[0] ?? '');
      if (m) ctx.macroNames.add(m[1] ?? m[2]);
    }
    if (inset.type === 'Leaf' && inset.name === 'CommandInset' && inset.arg === 'bibitem') {
      const label = unquote(paramMap(inset.params).get('label'));
      if (label) ctx.bibLabels.push(label);
    }
  }
}

/** Requirements that depend only on the document settings (BufferParams::validate). */
export function validateParams(ctx: ExportContext): void {
  const { bp, features: f, dc } = ctx;
  f.require(dc.requires);
  if (ctx.outputChanges && !ctx.texMode) {
    f.require('ct-xcolor-ulem'); f.require('ulem'); f.require('xcolor'); f.require('pdfcolmk');
    if (bp.changeBars) f.require('changebar');
  }
  if (bp.floatPlacement.includes('H')) f.require('float');
  // \use_package values: 0 = off, 1 = auto, 2 = on
  for (const [name, val] of bp.usePackage) {
    if (name === 'amsmath') { if (val === 2 || f.isProvided('amsmath')) f.require('amsmath'); }
    else if (val === 2) f.require(name);
  }
  if (bp.spacing !== 'single' && bp.spacing !== 'default') f.require('setspace');
  if (bp.pdf.useHyperref) { f.require('hyperref'); if (bp.pdf.colorlinks) f.require('color'); }
  if (bp.listingsParams.includes('\\color')) f.require('color');
  if (bp.useNonTexFonts && bp.fontMath !== 'auto' && bp.fontMath !== 'default') f.require('unicode-math');
  if (bp.useMicrotype) f.require('microtype');
  if (ctx.docLanguage.requires) f.require(ctx.docLanguage.requires);
  if (bp.backgroundColor !== 'none' && bp.backgroundColor !== '') { f.require('color'); f.require('pagecolor'); }
  if (bp.fontColor !== 'none' && bp.fontColor !== '') { f.require('color'); f.require('fontcolor'); }
  if (bp.useIndices) f.require('splitidx');
  if (bp.useBibtopic) f.require('bibtopic');
}

/** Body of the document (paragraphs between \begin{document} and \end{document}). */
export function writeBody(ctx: ExportContext): string {
  const os = new TexStream();
  const rp = newRunParams(ctx.bp.language, true);
  rp.owner = 'main';
  latexParagraphs(ctx, { pars: ctx.doc.body, isMainText: true }, os, rp);
  os.flushTermination();
  return os.toString();
}

/** Export a child document (body only) sharing the master's context. */
export function exportChild(parent: ExportContext, child: LyxDocument, filename: string): string {
  const ctx = makeContext(child, { ...parent.opts, isChild: true, basename: filename.replace(/\.(lyx|tex)$/, '') }, parent);
  if (ctx.dc.name !== readBufferParams(child).textclass) {
    parent.warnings.push(`child '${filename}' uses textclass '${readBufferParams(child).textclass}' while the master uses '${ctx.dc.name}'`);
  }
  collectBibLabels(ctx);
  const body = writeBody(ctx);
  parent.needMaketitle = ctx.needMaketitle;
  parent.haveMaketitle = ctx.haveMaketitle;
  return body;
}

/**
 * Export a LyX document to LaTeX.
 */
export function exportLatex(doc: LyxDocument, opts: ExportOptions = {}): ExportResult {
  const ctx = makeContext(doc, opts);
  ctx.warnings.push(...ctx.dc.warnings);
  collectBibLabels(ctx);
  validateParams(ctx);
  const body = writeBody(ctx);
  ctx.features.resolveAlternatives(name => (ctx.bp.usePackage.get(name) ?? 1) !== 0);
  // features implied by other features
  const f = ctx.features;
  if (f.isRequired('textgreek')) f.addFontEncoding('LGR');
  if (f.isRequired('textcyrillic')) f.addFontEncoding('T2A');
  let tex: string;
  if (ctx.isChild) {
    tex = body.endsWith('\n') ? body : body + '\n';
  } else {
    const preamble = writePreamble(ctx);
    tex = preamble + '\\begin{document}\n' + body + (body.endsWith('\n') ? '' : '\n') + '\n\\end{document}\n';
  }
  return finishExport(ctx, tex);
}

/** Feature bookkeeping shared by the LyX export and the .tex writer. */
export function finishExport(ctx: ExportContext, tex: string): ExportResult {
  const f = ctx.features;
  const requires = new Set<string>();
  const re = /\\usepackage(?:\[[^\]]*\])?\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tex))) for (const p of m[1].split(',')) requires.add(p.trim());
  for (const name of f.all) requires.add(name);
  return { tex, files: ctx.files, graphics: ctx.graphics, warnings: [...new Set(ctx.warnings)], requires };
}
