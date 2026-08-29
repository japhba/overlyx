/**
 * Paragraph-level LaTeX output: environments, nesting by depth, \item,
 * command layouts, title handling, alignment and paragraph parameters.
 * Mirrors src/output_latex.cpp (latexParagraphs / TeXEnvironment / TeXOnePar)
 * and Paragraph::latex.
 */
import type { Change, Item, Paragraph, TextInset } from '../lyx/ast.ts';
import type { ExportContext, RunParams } from './context.ts';
import type { ArgumentSpec, InsetLayout, LayoutStyle } from './layouts.ts';
import { findStyle } from './layouts.ts';
import { latexLength, isZeroLength } from './lengths.ts';
import { TexStream } from './stream.ts';
import {
  asctime, babelName, closeFont, effectiveFont, fontsEqualEff, latexChar, latexSpecialItem, openFont, polyglossiaName,
  type EffectiveFont,
} from './text.ts';
import { latexInset, isFontSwitchInset, type InsetPosition } from './insets.ts';

/** A text (list of paragraphs) being written, with its owning inset's layout. */
export interface TextInfo {
  pars: Paragraph[];
  il?: InsetLayout;
  isMainText: boolean;
}

export function isEnvironment(s: LayoutStyle): boolean {
  return s.latexType === 'Environment' || s.latexType === 'Item_Environment' || s.latexType === 'List_Environment' || s.latexType === 'Bib_Environment';
}

export function isCommand(s: LayoutStyle): boolean { return s.latexType === 'Command'; }

/** Resolve a paragraph's style (following ObsoletedBy, plain layout forcing). */
export function styleOf(ctx: ExportContext, par: Paragraph, rp: RunParams): LayoutStyle {
  if (rp.forcePlain) return findStyle(ctx.dc, 'Plain Layout')!;
  const s = findStyle(ctx.dc, par.layout);
  if (s) return s;
  ctx.warnings.push(`unknown layout '${par.layout}', using Standard`);
  return findStyle(ctx.dc, ctx.dc.defaultStyle) ?? findStyle(ctx.dc, 'Standard')!;
}

/** Language (LyX name) of a paragraph: the first item's language or the document language. */
export function parLanguage(ctx: ExportContext, par: Paragraph): string {
  for (const it of par.items) {
    if (it.font.lang && it.font.lang !== 'latex') return it.font.lang;
    if (it.kind === 'text' && !it.font.lang) return ctx.bp.language;
    if (it.kind === 'inset' && !it.font.lang) return ctx.bp.language;
  }
  return ctx.bp.language;
}

/** Alignment of a paragraph: its own param or the layout's. */
function parAlign(par: Paragraph, style: LayoutStyle): string {
  const a = par.params.align;
  if (!a || a === 'default' || a === 'layout') return style.align;
  return a;
}

function isDeletedPar(par: Paragraph): boolean {
  return par.items.length > 0 && par.items.every(it => it.change?.type === 'deleted');
}

function hasArgsStyle(s: LayoutStyle): boolean { return s.args.size > 0; }

/** Paragraph::hasSameLayout: same layout and same paragraph parameters. */
function sameLayout(a: Paragraph, b: Paragraph): boolean {
  const pa = a.params, pb = b.params;
  return a.layout === b.layout && (pa.align ?? '') === (pb.align ?? '') && (pa.paragraph_spacing ?? '') === (pb.paragraph_spacing ?? '')
    && !!pa.noindent === !!pb.noindent && (pa.labelwidthstring ?? '') === (pb.labelwidthstring ?? '') && (pa.leftindent ?? '') === (pb.leftindent ?? '');
}

/* ----------------------------------------------------- language switches */

function langBegin(ctx: ExportContext, lang: string): string {
  if (ctx.usePolyglossia) {
    const p = polyglossiaName(ctx, lang);
    if (!p.name) return '';
    return `\\begin{${p.name}}${p.opts ? `[${p.opts}]` : ''}`;
  }
  const b = babelName(ctx, lang);
  return b ? `\\selectlanguage{${b}}` : '';
}

function langEnd(ctx: ExportContext, lang: string): string {
  if (ctx.usePolyglossia) {
    const p = polyglossiaName(ctx, lang);
    return p.name ? `\\end{${p.name}}` : '';
  }
  return '';
}

function sameLang(ctx: ExportContext, a: string, b: string): boolean {
  if (a === b) return true;
  if (ctx.usePolyglossia) return polyglossiaName(ctx, a).name === polyglossiaName(ctx, b).name;
  return babelName(ctx, a) === babelName(ctx, b);
}

function noteLanguage(ctx: ExportContext, lang: string): void {
  if (!lang || lang === ctx.bp.language) return;
  const li = ctx.langs.get(lang);
  if (!li) return;
  if (li.babel === babelName(ctx, ctx.bp.language) && !ctx.usePolyglossia) return;
  ctx.features.usedLanguages.set(lang, { babel: li.babel, polyglossia: li.polyglossia, polyglossiaOpts: li.polyglossiaOpts });
}

/* -------------------------------------------------------- argument insets */

function argInsetsOf(par: Paragraph, prefix: string): Map<string, TextInset> {
  const m = new Map<string, TextInset>();
  for (const it of par.items) {
    if (it.kind !== 'inset' || it.inset.type !== 'Text' || it.inset.name !== 'Argument') continue;
    const id = it.inset.arg;
    if (prefix ? id.startsWith(prefix) : !id.includes(':')) m.set(id, it.inset);
  }
  return m;
}

/** Output the LaTeX arguments (Argument insets) of a paragraph/inset, like getArgInsets(). */
export function latexArgInsets(ctx: ExportContext, os: TexStream, rp: RunParams, args: Map<string, ArgumentSpec>, found: Map<string, TextInset>, prefix: string): void {
  const relevant = [...args.entries()].filter(([id]) => (prefix ? id.startsWith(prefix) : !id.includes(':')));
  if (relevant.length === 0) return;
  const required = new Set<string>();
  for (const [, a] of relevant) if ((a.presetArg || a.defaultArg) && a.requires.length) for (const r of a.requires) required.add(r);
  for (const [id] of relevant) {
    const ins = found.get(id);
    if (ins) for (const r of args.get(id)?.requires ?? []) required.add(r);
  }
  const nums = relevant.map(([id]) => parseInt(id.slice(prefix.length), 10)).filter(n => !Number.isNaN(n));
  const argnr = nums.length ? Math.max(...nums) : 0;
  for (let i = 1; i <= argnr; i++) {
    const id = prefix + i;
    const spec = args.get(id);
    const ins = found.get(id);
    if (ins && spec) {
      let ldelim = spec.nodelims ? '' : spec.mandatory ? '{' : '[';
      let rdelim = spec.nodelims ? '' : spec.mandatory ? '}' : ']';
      if (spec.leftDelim) ldelim = spec.leftDelim;
      if (spec.rightDelim) rdelim = spec.rightDelim;
      latexArgument(ctx, os, rp, ins, spec, ldelim, rdelim);
      if (prefix === 'listpreamble:') os.breakln();
      continue;
    }
    if (!spec) continue;
    let preset = spec.presetArg;
    if (spec.defaultArg) preset = preset ? preset + ',' + spec.defaultArg : spec.defaultArg;
    if (spec.mandatory) os.write((spec.leftDelim || '{') + preset + (spec.rightDelim || '}'));
    else if (preset) os.write((spec.leftDelim || '[') + preset + (spec.rightDelim || ']'));
    else if (required.has(id)) os.write((spec.leftDelim || '[') + (spec.rightDelim || ']'));
    else break;
  }
}

/** InsetArgument::latexArgument */
function latexArgument(ctx: ExportContext, os: TexStream, rp: RunParams, ins: TextInset, spec: ArgumentSpec, ldelim: string, rdelim: string): void {
  const inner = new TexStream();
  const rp2: RunParams = { ...rp, passThru: spec.passThru, passThruChars: rp.passThruChars + spec.passThruChars, newlineCmd: spec.newlineCmd || rp.newlineCmd, forcePlain: true, isMainText: false, freeSpacing: spec.freeSpacing || rp.freeSpacing };
  for (const r of spec.requires) ctx.features.require(r);
  latexParagraphs(ctx, { pars: ins.paragraphs, isMainText: false }, inner, rp2);
  inner.flushTermination();
  const content = inner.toString();
  const addBraces = ldelim !== '' && ldelim !== '{' && content.includes(rdelim);
  os.write(ldelim);
  if (addBraces) os.write('{');
  os.write(spec.presetArg);
  if (spec.presetArg && content) os.write(', ');
  os.write(content);
  if (addBraces) os.write('}');
  os.write(rdelim);
}

/* ------------------------------------------------------------ environments */

interface EnvData {
  style: LayoutStyle;
  parLang: string;
  leftIndentOpen: boolean;
}

/** Widest bibliography label for \begin{thebibliography}{...}. */
function bibitemWidest(ctx: ExportContext): string {
  if (ctx.bp.citeEngineType === 'numerical') return '99';
  let widest = '';
  for (const l of ctx.bibLabels) if (l.length > widest.length) widest = l;
  return widest || '99';
}

function prepareEnvironment(ctx: ExportContext, text: TextInfo, pit: number, os: TexStream, rp: RunParams, prevLang: string): EnvData {
  const pars = text.pars;
  const par = pars[pit];
  const style = styleOf(ctx, par, rp);
  const lang = parLanguage(ctx, par);
  noteLanguage(ctx, lang);
  // language switch outside of the environment
  if (!sameLang(ctx, lang, prevLang) && !rp.localSwitch) {
    const end = langEnd(ctx, prevLang);
    if (end && ctx.usePolyglossia && !sameLang(ctx, prevLang, rp.outerLang)) { os.write(end); os.write('%\n'); }
    const bc = langBegin(ctx, lang);
    if (bc && (!ctx.usePolyglossia || !sameLang(ctx, lang, rp.outerLang))) { os.write(bc); os.write('%\n'); ctx.openLanguage = lang; }
  }
  let leftIndentOpen = false;
  if (par.params.leftindent && !isZeroLength(par.params.leftindent)) {
    ctx.features.require('ParagraphLeftIndent');
    os.write(`\\begin{LyXParagraphLeftIndent}{${latexLength(par.params.leftindent)}}\n`);
    leftIndentOpen = true;
  }
  if (isEnvironment(style) && style.latexName) {
    ctx.features.useLayout(style.name);
    for (const r of style.requires) ctx.features.require(r);
    os.write(`\\begin{${style.latexName}}`);
    if (hasArgsStyle(style)) {
      // arguments may sit in any paragraph of the environment (same layout & depth)
      const found = new Map<string, TextInset>();
      for (let i = pit; i < pars.length; i++) {
        const p = pars[i];
        if (p.layout !== par.layout || p.depth < par.depth) break;
        if (p.depth > par.depth) continue;
        for (const [k, v] of argInsetsOf(p, '')) if (!found.has(k)) found.set(k, v);
      }
      latexArgInsets(ctx, os, rp, style.args, found, '');
    }
    if (style.latexType === 'List_Environment') {
      os.write('{' + (par.params.labelwidthstring ?? '') + '}\n');
    } else if (style.labelType === 'Bibliography') {
      os.write('{' + (par.params.labelwidthstring || bibitemWidest(ctx)) + '}\n');
    } else {
      os.write(style.latexParam + '\n');
    }
    if (style.latexType === 'Bib_Environment' || style.latexType === 'Item_Environment' || style.latexType === 'List_Environment') {
      const found = new Map<string, TextInset>();
      for (let i = pit; i < pars.length; i++) {
        const p = pars[i];
        if (p.layout !== par.layout || p.depth < par.depth) break;
        if (p.depth > par.depth) continue;
        for (const [k, v] of argInsetsOf(p, 'listpreamble:')) if (!found.has(k)) found.set(k, v);
      }
      latexArgInsets(ctx, os, rp, style.args, found, 'listpreamble:');
    }
  }
  return { style, parLang: lang, leftIndentOpen };
}

function finishEnvironment(ctx: ExportContext, os: TexStream, rp: RunParams, data: EnvData, lastpar: boolean, text: TextInfo): void {
  if (isEnvironment(data.style)) {
    os.breakln();
    if (data.style.latexType === 'Bib_Environment') os.write('\n');
    if (data.style.latexName) os.write(`\\end{${data.style.latexName}}\n`);
    if (ctx.usePolyglossia && lastpar && !text.isMainText && !sameLang(ctx, data.parLang, rp.outerLang)) {
      const end = langEnd(ctx, data.parLang);
      if (end) { os.write(end); os.write('%\n'); }
    }
  }
  if (data.leftIndentOpen) { os.breakln(); os.write('\\end{LyXParagraphLeftIndent}\n'); }
  if (!data.style.nextNoIndent) os.write('\n');
}

/** TeXEnvironment: writes paragraphs from `pit` belonging to the current environment; returns the next index. */
function texEnvironment(ctx: ExportContext, text: TextInfo, pit: number, os: TexStream, rp: RunParams, state: { prevLang: string }): number {
  const pars = text.pars;
  const first = pars[pit];
  const currentLayout = first.layout;
  const currentDepth = first.depth;
  const currentIndent = first.params.leftindent ?? '';
  while (pit < pars.length) {
    const par = pars[pit];
    let goOut = par.depth < currentDepth;
    if (par.depth === currentDepth) {
      goOut ||= par.layout !== currentLayout;
      goOut ||= (par.params.leftindent ?? '') !== currentIndent;
    }
    if (goOut) return pit;
    if (par.layout === currentLayout && par.depth === currentDepth && (par.params.leftindent ?? '') === currentIndent) {
      texOnePar(ctx, text, pit, os, rp, state);
      pit++;
      continue;
    }
    // deeper environment or a standard paragraph at a deeper level
    const style = styleOf(ctx, par, rp);
    if (!isEnvironment(style)) {
      texOnePar(ctx, text, pit, os, rp, state);
      pit++;
      continue;
    }
    if (!ctx.outputChanges && isDeletedPar(par) && pit + 1 < pars.length) {
      const nextpar = pars[pit + 1];
      if (par.layout !== nextpar.layout || par.depth === nextpar.depth) {
        if (par.endChange?.type !== 'deleted') os.write('\n\n');
        pit++;
        continue;
      }
    }
    const data = prepareEnvironment(ctx, text, pit, os, rp, state.prevLang);
    state.prevLang = data.parLang;
    pit = texEnvironment(ctx, text, pit, os, rp, state);
    finishEnvironment(ctx, os, rp, data, pit >= pars.length, text);
  }
  return pit;
}

/* ------------------------------------------------------------- latexParagraphs */

/** Write all paragraphs of a text (main text or inset). */
export function latexParagraphs(ctx: ExportContext, text: TextInfo, os: TexStream, rp: RunParams): void {
  const pars = text.pars;
  const state = { prevLang: rp.outerLang };
  let pit = 0;
  while (pit < pars.length) {
    const par = pars[pit];
    const style = styleOf(ctx, par, rp);
    // title handling
    if (style.inTitle) {
      if (!ctx.haveMaketitle && !ctx.needMaketitle) {
        ctx.needMaketitle = true;
        if (ctx.dc.titleLatexType === 'Environment') os.write(`\\begin{${ctx.dc.titleLatexName}}\n`);
      }
    } else if (ctx.needMaketitle && !ctx.haveMaketitle && !style.inPreamble && !rp.inTitle) {
      if (ctx.dc.titleLatexType === 'Environment') os.write(`\\end{${ctx.dc.titleLatexName}}\n`);
      else os.write(`\\${ctx.dc.titleLatexName}\n`);
      ctx.haveMaketitle = true;
      ctx.needMaketitle = false;
    }
    if (!isEnvironment(style) && isZeroLength(par.params.leftindent)) {
      texOnePar(ctx, text, pit, os, rp, state);
      pit++;
      continue;
    }
    // deleted environments
    if (!ctx.outputChanges && isDeletedPar(par)) {
      const nextpar = pars[pit + 1];
      if (!nextpar || par.layout !== nextpar.layout || par.depth === nextpar.depth) {
        if (par.endChange?.type !== 'deleted') os.write('\n\n');
        pit++;
        continue;
      }
    }
    const data = prepareEnvironment(ctx, text, pit, os, rp, state.prevLang);
    state.prevLang = data.parLang;
    pit = texEnvironment(ctx, text, pit, os, rp, state);
    finishEnvironment(ctx, os, rp, data, pit >= pars.length, text);
  }
  if (ctx.needMaketitle && !ctx.haveMaketitle && text.isMainText) {
    if (ctx.dc.titleLatexType === 'Environment') os.write(`\\end{${ctx.dc.titleLatexName}}\n`);
    else os.write(`\\${ctx.dc.titleLatexName}\n`);
  }
  // close a polyglossia language environment left open at the end of the main text
  if (ctx.usePolyglossia && text.isMainText && !ctx.isChild && ctx.openLanguage && !sameLang(ctx, ctx.openLanguage, ctx.bp.language)) {
    const end = langEnd(ctx, ctx.openLanguage);
    if (end) { os.breakln(); os.write(end + '\n'); }
    ctx.openLanguage = ctx.bp.language;
  }
}

/* ------------------------------------------------------------------ TeXOnePar */

function parStartCommand(ctx: ExportContext, os: TexStream, rp: RunParams, par: Paragraph, style: LayoutStyle): void {
  switch (style.latexType) {
    case 'Command':
      os.write('\\' + style.latexName);
      if (hasArgsStyle(style)) latexArgInsets(ctx, os, rp, style.args, argInsetsOf(par, ''), '');
      os.write(style.latexParam);
      break;
    case 'Item_Environment':
    case 'List_Environment':
      os.write('\\' + style.itemCommand);
      if (hasArgsStyle(style)) latexArgInsets(ctx, os, rp, style.args, argInsetsOf(par, 'item:'), 'item:');
      os.write(' ');
      break;
    default:
      break;
  }
}

function spacingEnv(ctx: ExportContext, spacing: string | undefined): { begin: string; end: string; cmd: string } | undefined {
  if (!spacing || spacing === 'default') return undefined;
  const [kind, value] = spacing.split(/\s+/);
  const setSpace = ctx.features.isProvided('SetSpace');
  ctx.features.require('setspace');
  switch (kind) {
    case 'single': return setSpace ? { begin: '\\begin{SingleSpace}', end: '\\end{SingleSpace}', cmd: '\\SingleSpacing{}' } : { begin: '\\begin{singlespace}', end: '\\end{singlespace}', cmd: '\\singlespacing{}' };
    case 'onehalf': return setSpace ? { begin: '\\begin{OnehalfSpace}', end: '\\end{OnehalfSpace}', cmd: '\\OnehalfSpacing{}' } : { begin: '\\begin{onehalfspace}', end: '\\end{onehalfspace}', cmd: '\\onehalfspacing{}' };
    case 'double': return setSpace ? { begin: '\\begin{DoubleSpace}', end: '\\end{DoubleSpace}', cmd: '\\DoubleSpacing{}' } : { begin: '\\begin{doublespace}', end: '\\end{doublespace}', cmd: '\\doublespacing{}' };
    case 'other': return setSpace ? { begin: `\\begin{Spacing}{${value}}`, end: '\\end{Spacing}', cmd: `\\setSpacing{${value}}` } : { begin: `\\begin{spacing}{${value}}`, end: '\\end{spacing}', cmd: `\\setstretch{${value}}` };
    default: return undefined;
  }
}

function texOnePar(ctx: ExportContext, text: TextInfo, pit: number, os: TexStream, rp: RunParams, state: { prevLang: string }, force = false): void {
  const pars = text.pars;
  const par = pars[pit];
  const style = styleOf(ctx, par, rp);
  if (style.inPreamble && !force) {
    // InPreamble layouts are written to the preamble instead of the body
    const tmp = new TexStream();
    texOnePar(ctx, text, pit, tmp, rp, { prevLang: state.prevLang }, true);
    tmp.flushTermination();
    const snippet = tmp.toString().trim();
    if (snippet) ctx.features.addPreambleSnippet(snippet);
    return;
  }
  if (!ctx.outputChanges && style.latexType !== 'Environment' && isDeletedPar(par)) return;
  ctx.features.useLayout(style.name);
  for (const r of style.requires) ctx.features.require(r);

  const isLastPar = pit === pars.length - 1;
  const nextpar = isLastPar ? undefined : pars[pit + 1];
  const mergedPar = !ctx.outputChanges && par.endChange?.type === 'deleted';
  const parLang = parLanguage(ctx, par);
  noteLanguage(ctx, parLang);
  const baseFont = { family: style.font.family, series: style.font.series, shape: style.font.shape, size: style.font.size };

  // pass-through insets (ERT, listings): raw text
  if (rp.passThru) {
    if (pit > 0 && !rp.parbreakIgnored && !mergedPar) {
      os.write('\n');
      if (!rp.parbreakIsNewline) os.write('\n');
    }
    paragraphLatex(ctx, os, { ...rp, baseFont }, par, style, parLang, isLastPar, text);
    return;
  }

  const intitleCommand = style.inTitle && isCommand(style);
  const localRp: RunParams = {
    ...rp, baseFont, movingArg: rp.movingArg || style.needProtect, freeSpacing: style.freeSpacing || rp.freeSpacing,
    inTitle: rp.inTitle || style.inTitle,
    postponeFragile: rp.postponeFragile || (isCommand(style) && style.needProtect && ctx.bp.postponeFragileContent),
    postMacro: '',
  };

  if (style.passThru) {
    const prp = { ...localRp, passThru: true };
    parStartCommand(ctx, os, prp, par, style);
    if (intitleCommand) os.write('{');
    paragraphLatex(ctx, os, prp, par, style, parLang, isLastPar, text);
    if (isCommand(style)) {
      os.write('}');
      os.write(mergedPar ? '{}' : '\n');
    } else if (!mergedPar) os.write('\n');
    if (!style.parbreakIsNewline && !mergedPar) os.write('\n');
    else if (nextpar && !isEnvironment(style)) {
      const ns = styleOf(ctx, nextpar, rp);
      if (ns.name !== style.name && !mergedPar) os.write('\n');
    }
    return;
  }

  // language handling (babel: \selectlanguage at paragraph level, closed at the end of the text)
  const prevLang = state.prevLang;
  const outerLang = rp.outerLang;
  const localswitch = rp.localSwitch || rp.forcePlain && ctx.usePolyglossia;
  const priorpar = pit > 0 ? pars[pit - 1] : undefined;
  const envAlreadySwitched = isEnvironment(style) && (pit === 0 || (priorpar && (priorpar.layout !== par.layout && priorpar.depth <= par.depth)) || (priorpar && priorpar.depth < par.depth));
  let openedLocal = false;
  if (intitleCommand) {
    parStartCommand(ctx, os, localRp, par, style);
    os.write('{');
  }
  if (!sameLang(ctx, parLang, prevLang) && !envAlreadySwitched) {
    if (localswitch || intitleCommand) {
      if (!sameLang(ctx, parLang, outerLang)) {
        const b = babelName(ctx, parLang);
        if (ctx.usePolyglossia) {
          const p = polyglossiaName(ctx, parLang);
          if (p.name) { os.write(`\\text${p.name}${p.opts ? `[${p.opts}]` : ''}{`); openedLocal = true; }
        } else if (b) { os.write(`\\foreignlanguage{${b}}{`); openedLocal = true; }
      }
    } else {
      if (ctx.usePolyglossia && !sameLang(ctx, prevLang, outerLang) && !isEnvironment(style)) {
        const end = langEnd(ctx, prevLang);
        if (end) { os.write(end); os.write('%\n'); }
      }
      const bc = langBegin(ctx, parLang);
      if (bc && (!ctx.usePolyglossia || !sameLang(ctx, parLang, outerLang) || isEnvironment(style))) {
        os.write(bc);
        os.write('%\n');
        ctx.openLanguage = parLang;
      }
    }
  }
  state.prevLang = parLang;

  const allowCust = rp.customPars && !rp.forcePlain;
  const spacing = allowCust ? spacingEnv(ctx, par.params.paragraph_spacing) : undefined;
  if (allowCust) {
    if (par.params.start_of_appendix) os.write('\n\\appendix\n');
    if (style.inTitle) {
      if (spacing) { if (localRp.movingArg) os.write('\\protect'); os.write(spacing.cmd); }
    } else {
      if (spacing && (pit === 0 || !priorpar || !sameLayout(priorpar, par))) os.write(spacing.begin + '\n');
      if (isCommand(style)) os.write('\n');
    }
  }

  if (!intitleCommand) parStartCommand(ctx, os, localRp, par, style);

  paragraphLatex(ctx, os, localRp, par, style, parLang, isLastPar, text);

  if (!intitleCommand && isCommand(style)) {
    os.write('}');
    if (style.args.size) latexArgInsets(ctx, os, localRp, style.args, argInsetsOf(par, 'post:'), 'post:');
    if (localRp.postMacro) { os.write(localRp.postMacro); localRp.postMacro = ''; }
  } else if (!intitleCommand && localRp.postMacro) {
    // postponed fragile content of an enclosing moving argument
    rp.postMacro += localRp.postMacro;
    localRp.postMacro = '';
  }

  let pendingNewline = false;
  let closeLangSwitch = false;
  const nextLang = nextpar ? parLanguage(ctx, nextpar) : '';
  switch (style.latexType) {
    case 'Item_Environment':
    case 'List_Environment':
      if (nextpar && !sameLang(ctx, parLang, nextLang) && nextpar.depth === par.depth) closeLangSwitch = ctx.usePolyglossia;
      if (nextpar && par.depth < nextpar.depth) pendingNewline = !rp.parbreakIgnored && !mergedPar;
      break;
    case 'Environment':
      if (nextpar && ((styleOf(ctx, nextpar, rp) !== style || nextpar.depth !== par.depth) || (!ctx.usePolyglossia || !sameLang(ctx, parLang, nextLang)))) {
        closeLangSwitch = ctx.usePolyglossia;
        break;
      }
      // fall through
    default:
      if (nextpar && !intitleCommand) pendingNewline = !rp.parbreakIgnored && !mergedPar;
  }

  if (allowCust && !style.inTitle && spacing && (isLastPar || !nextpar || !sameLayout(nextpar, par))) {
    if (pendingNewline) os.write('\n');
    os.breakln();
    os.write(spacing.end);
    pendingNewline = true;
  }

  // close / restore the language
  let unskipNewline = false;
  if (openedLocal) {
    os.write('}');
  } else if (!localswitch && !intitleCommand && ((isLastPar && !rp.inDeletedInset) || closeLangSwitch || (nextpar && !sameLang(ctx, nextLang, parLang) && false))
      && !sameLang(ctx, parLang, outerLang)) {
    if (!ctx.usePolyglossia) {
      // babel: switch back to the outer language
      const bc = langBegin(ctx, outerLang);
      if (bc) {
        if (pendingNewline || closeLangSwitch) os.write('\n');
        os.write(bc);
        pendingNewline = !rp.parbreakIgnored;
        unskipNewline = true;
        ctx.openLanguage = outerLang;
      }
    } else if (!isEnvironment(style) || closeLangSwitch) {
      const end = langEnd(ctx, parLang);
      if (end) {
        if (pendingNewline || closeLangSwitch) os.write('\n');
        os.breakln();
        os.write(end);
        pendingNewline = !rp.parbreakIgnored;
        unskipNewline = true;
      }
    }
  }

  if (intitleCommand) {
    os.write('}');
    if (style.args.size) latexArgInsets(ctx, os, localRp, style.args, argInsetsOf(par, 'post:'), 'post:');
    if (localRp.postMacro) { os.write(localRp.postMacro); localRp.postMacro = ''; }
  }

  const lastWasSeparator = endsWithSeparator(par);

  if (nextpar && !os.afterParbreak && !lastWasSeparator && ctx.outputChanges && par.endChange) {
    markChange(ctx, os, localRp, undefined, par.endChange);
    os.write('¶}');
  }

  if (pendingNewline) {
    if (unskipNewline) os.write('%');
    if (!os.afterParbreak && !lastWasSeparator) os.write('\n');
  }

  // paragraph break
  if (nextpar && !os.afterParbreak && !lastWasSeparator) {
    if (!rp.parbreakIgnored && !mergedPar) os.breakln();
    const nextStyle = styleOf(ctx, nextpar, rp);
    if (!isCommand(nextStyle)) {
      const curAlign = parAlign(par, style);
      const nextAlign = parAlign(nextpar, nextStyle);
      const isDefaultLayout = nextStyle.name === ctx.dc.defaultStyle;
      if ((nextStyle === style && !style.parbreakIsNewline && !rp.parbreakIsNewline && !rp.parbreakIgnored
            && style.latexType !== 'Item_Environment' && style.latexType !== 'List_Environment'
            && style.align === curAlign && nextpar.depth === par.depth
            && (nextAlign === curAlign || (par.params.paragraph_spacing ?? 'default') !== (nextpar.params.paragraph_spacing ?? 'default')))
          || (!isEnvironment(nextStyle) && nextpar.depth > par.depth && nextAlign === nextStyle.align)
          || (!isEnvironment(style) && nextStyle.latexType === 'Environment' && nextpar.depth < par.depth)
          || (isCommand(style) && !isEnvironment(nextStyle) && style.align === curAlign && nextStyle.align === nextAlign)
          || (style.align !== curAlign && isDefaultLayout)) {
        if (!mergedPar) os.write(rp.isNonLong ? '\\endgraf\n' : '\n');
      }
    }
  }
}

function endsWithSeparator(par: Paragraph): boolean {
  const last = par.items[par.items.length - 1];
  return !!last && last.kind === 'inset' && last.inset.type === 'Leaf' && last.inset.name === 'Separator' && last.inset.arg !== 'plain';
}

/* -------------------------------------------------------- change tracking */

/** Changes::latexMarkChange */
export function markChange(ctx: ExportContext, os: TexStream, rp: RunParams, oldChange: Change | undefined, change: Change | undefined): void {
  if (!ctx.outputChanges) return;
  const same = (!oldChange && !change) || (oldChange && change && oldChange.type === change.type && oldChange.author === change.author && oldChange.time === change.time);
  if (same) return;
  if (oldChange) {
    os.write('}');
    if (oldChange.type === 'deleted') rp.inulemcmd = Math.max(0, rp.inulemcmd - 1);
  }
  if (!change) return;
  if (ctx.texMode && !ctx.usedChanges) {
    ctx.usedChanges = true;
    if (ctx.bp.outputChanges) { ctx.features.require('ct-xcolor-ulem'); ctx.features.require('ulem'); ctx.features.require('xcolor'); ctx.features.require('pdfcolmk'); }
    else ctx.features.require('ct-none');
  }
  const macro = change.type === 'deleted' ? '\\lyxdeleted' : '\\lyxadded';
  if (change.type === 'deleted') rp.inulemcmd++;
  const author = ctx.bp.authors.get(change.author);
  const name = author ? author.name : 'Unknown';
  os.write(`${macro}{${name}}{${asctime(change.time)}}{`);
}

/* ------------------------------------------------------- Paragraph::latex */

/** A flattened paragraph unit: character, special or inset. */
export type Unit =
  | { kind: 'char'; ch: string; font: Item['font']; change?: Change }
  | { kind: 'special'; token: string; arg: string; font: Item['font']; change?: Change }
  | { kind: 'inset'; inset: Extract<Item, { kind: 'inset' }>['inset']; font: Item['font']; change?: Change }
  | { kind: 'unknown'; line: string; font: Item['font']; change?: Change };

export function flatten(par: Paragraph): Unit[] {
  const out: Unit[] = [];
  for (const it of par.items) {
    switch (it.kind) {
      case 'text': for (const ch of it.text) out.push({ kind: 'char', ch, font: it.font, change: it.change }); break;
      case 'special': out.push({ kind: 'special', token: it.token, arg: it.arg, font: it.font, change: it.change }); break;
      case 'inset': out.push({ kind: 'inset', inset: it.inset, font: it.font, change: it.change }); break;
      case 'unknown': out.push({ kind: 'unknown', line: it.line, font: it.font, change: it.change }); break;
    }
  }
  return out;
}

/** Paragraph::beginOfBody for Manual labels: position after the first space. */
function beginOfBody(units: Unit[], style: LayoutStyle): number {
  if (style.labelType !== 'Manual') return 0;
  let i = 0;
  const end = units.length;
  const stop = (u: Unit) => u.kind === 'inset' && u.inset.type === 'Leaf' && (u.inset.name === 'Newline' || (u.inset.name === 'Separator' && u.inset.arg !== 'plain'));
  if (i < end && !stop(units[i])) {
    ++i;
    if (i < end && !stop(units[i])) {
      let prev = units[i - 1];
      ++i;
      while (i < end && !(prev.kind === 'char' && prev.ch === ' ') && !stop(units[i])) { prev = units[i]; ++i; }
      if (i < end && prev.kind === 'char' && prev.ch === ' ') { /* body starts here */ }
      else if (i === end && !(units[i - 1].kind === 'char' && (units[i - 1] as { ch: string }).ch === ' ')) return end;
    }
  }
  return i;
}

/** lyxrc.plaintext_linelen default */
const WRAP_COLUMN = 65;

/** Write the alignment / noindent parameters at the start of a paragraph (startTeXParParams). */
function startParParams(ctx: ExportContext, os: TexStream, rp: RunParams, par: Paragraph, style: LayoutStyle, isLastPar: boolean, units: Unit[]): void {
  if (rp.forcePlain || !rp.customPars) return;
  const canIndent = ctx.bp.paragraphSeparation === 'indent' ? style.toggleIndent !== 'never' : style.toggleIndent === 'always';
  const curAlign = parAlign(par, style);
  if (canIndent && par.params.noindent && !style.passThru && curAlign !== 'center') {
    const first = units[0];
    const startsWithVSpace = first && first.kind === 'inset' && first.inset.type === 'Leaf' && first.inset.name === 'VSpace';
    if (!startsWithVSpace) { os.write('\\noindent'); os.termcmd(); }
  }
  if (curAlign === style.align) return;
  if (curAlign !== 'left' && curAlign !== 'right' && curAlign !== 'center') return;
  if (rp.movingArg) os.write('\\protect');
  correctedEnv(os, '\\begin', curAlign === 'left' ? 'flushleft' : curAlign === 'right' ? 'flushright' : 'center', rp, isLastPar);
}

function endParParams(os: TexStream, rp: RunParams, par: Paragraph, style: LayoutStyle, isLastPar: boolean): void {
  if (rp.forcePlain || !rp.customPars) return;
  const curAlign = parAlign(par, style);
  if (curAlign === style.align) return;
  if (curAlign !== 'left' && curAlign !== 'right' && curAlign !== 'center') return;
  if (rp.movingArg) os.write('\\protect');
  correctedEnv(os, '\\par\\end', curAlign === 'left' ? 'flushleft' : curAlign === 'right' ? 'flushright' : 'center', rp, isLastPar);
}

function correctedEnv(os: TexStream, suffix: string, env: string, rp: RunParams, lastpar: boolean): void {
  const correction: Record<string, string> = { flushleft: 'raggedright', flushright: 'raggedleft', center: 'centering' };
  const noTrivlist = rp.owner === 'float' || rp.owner === 'wrap' || rp.owner === 'cell';
  let macro = suffix + '{';
  if (noTrivlist) {
    if (lastpar) {
      if (suffix === '\\begin') os.write('\\' + correction[env] + '{}');
      return;
    }
    macro += correction[env];
  } else macro += env;
  macro += '}';
  if (suffix === '\\par\\end') os.breakln();
  os.write(macro);
  if (suffix === '\\begin') os.breakln();
}

/** Paragraph::latex: write the content of one paragraph (fonts, characters, insets, change tracking). */
export function paragraphLatex(ctx: ExportContext, os: TexStream, rp: RunParams, par: Paragraph, style: LayoutStyle, parLang: string, isLastPar: boolean, text: TextInfo): void {
  const units = flatten(par);
  const bodyPos = beginOfBody(units, style);
  const labelBase = { family: style.labelFont.family ?? style.font.family, series: style.labelFont.series ?? style.font.series, shape: style.labelFont.shape ?? style.font.shape, size: style.labelFont.size ?? style.font.size };
  let base = bodyPos > 0 ? labelBase : rp.baseFont;
  const plain = (): EffectiveFont => effectiveFont({}, base, parLang);
  let running = plain();
  let openCount = 0;
  let openFontFlag = false;
  let runningChange: Change | undefined;
  const typewriter = style.font.family === 'typewriter';
  const passThru = style.passThru || rp.passThru;

  const openBody = () => {
    if (isCommand(style) && !style.inTitle) os.write('{');
    if (style.leftDelim) os.write(style.leftDelim);
    startParParams(ctx, os, rp, par, style, isLastPar, units);
  };

  if (bodyPos > 0) os.write('[{');
  if (units.length === 0) openBody();
  // LyX counts columns from the start of the paragraph content
  let startCol = os.column;
  const parColumn = () => (os.column >= startCol ? os.column - startCol : os.column);

  let skipSpace = false;
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (skipSpace) { skipSpace = false; if (u.kind === 'char' && u.ch === ' ') continue; }
    if (i === bodyPos) {
      if (bodyPos > 0) {
        if (openFontFlag) { closeFont(os, rp, running, openCount); openFontFlag = false; openCount = 0; }
        base = rp.baseFont;
        running = plain();
        markChange(ctx, os, rp, runningChange, undefined);
        runningChange = undefined;
        const sep = u.kind === 'inset' && u.inset.type === 'Leaf' && u.inset.name === 'Separator';
        os.write(sep ? '}]~' : '}] ');
      }
      openBody();
    }

    const change = rp.inDeletedInset ? undefined : u.change;
    if (ctx.outputChanges && !sameChange(runningChange, change)) {
      if (openFontFlag) { closeFont(os, rp, running, openCount); openFontFlag = false; openCount = 0; running = plain(); }
      markChange(ctx, os, rp, runningChange, change);
      runningChange = change;
    }
    if (!ctx.outputChanges && change?.type === 'deleted') continue;

    // skip layout argument insets (handled by the layout / parent inset)
    if (u.kind === 'inset' && u.inset.type === 'Text' && u.inset.name === 'Argument') continue;

    const current = effectiveFont(u.font, base, parLang);
    const fontSwitchInset = u.kind === 'inset' && isFontSwitchInset(ctx, u.inset);

    // close the running font if the font changes (or before a multi-par inset)
    if (openFontFlag && (!fontsEqualEff(current, running) || fontSwitchInset)) {
      closeFont(os, rp, running, openCount);
      openFontFlag = false; openCount = 0;
      running = plain();
    }
    // open the new font
    if (!fontsEqualEff(current, running) && !fontSwitchInset && i !== bodyPos - 1) {
      const isSpaceChar = u.kind === 'char' && u.ch === ' ';
      openCount = openFont(ctx, os, rp, current, parLang);
      if (openCount > 0 && current.color && isSpaceChar && !current.emph && !current.noun && !current.underbar && !current.strikeout) os.write('{}');
      running = current;
      openFontFlag = openCount > 0;
      if (openCount === 0) running = current; // language-only change to same babel name: nothing to open
    }

    const localRp: RunParams = rp;
    switch (u.kind) {
      case 'char': {
        if (u.ch === ' ' && i === bodyPos - 1 && !passThru) break; // label/body separator is not written
        if (u.ch === ' ' && !passThru) {
          // simpleTeXBlanks: wrap long lines at spaces
          const prev = i > 0 ? units[i - 1] : undefined;
          const prevCh = prev && prev.kind === 'char' ? prev.ch : '';
          // (.tex documents are not wrapped: one line per paragraph, the editors wrap to their width)
          if (!ctx.texMode && parColumn() > WRAP_COLUMN && i > 0 && prevCh !== ' ' && i + 1 < units.length && !rp.freeSpacing && !style.freeSpacing
              && !(typewriter && '.?:!'.includes(prevCh) && prevCh !== '')) {
            os.write('\n');
            startCol = 0;
          } else if (style.freeSpacing) {
            os.write('~');
          } else {
            os.write(' ');
          }
          break;
        }
        const nextU = units[i + 1];
        const next = nextU && nextU.kind === 'char' ? nextU.ch : '';
        latexChar(ctx, os, localRp, u.ch, { passThru, passThruChars: style.passThruChars, typewriter: typewriter || current.family === 'typewriter', next });
        break;
      }
      case 'special':
        latexSpecialItem(ctx, os, localRp, u.token, u.arg);
        break;
      case 'inset': {
        const innerRp: RunParams = { ...rp, outerLang: current.lang, passThru: passThru, freeSpacing: rp.freeSpacing || style.freeSpacing };
        const nlBefore = os.newlines;
        const ipos: InsetPosition = { par, index: i, units, isLast: i + 1 === units.length, parLang, itemFont: current, style };
        latexInset(ctx, os, innerRp, u.inset, ipos);
        if (ipos.skipNextSpace) skipSpace = true;
        // LyX restarts its column count after insets that produced line breaks
        if (os.newlines !== nlBefore) startCol = os.column;
        rp.postMacro = innerRp.postMacro;
        rp.inulemcmd = innerRp.inulemcmd;
        break;
      }
      case 'unknown':
        ctx.warnings.push(`unknown paragraph token '${u.line}' ignored`);
        break;
    }
  }

  if (openFontFlag) { closeFont(os, rp, running, openCount); openFontFlag = false; }
  if (!rp.inDeletedInset) markChange(ctx, os, rp, runningChange, undefined);
  if (bodyPos > 0 && bodyPos === units.length) os.write('}]~');
  if (style.rightDelim) os.write(style.rightDelim);
  endParParams(os, rp, par, style, isLastPar);
}

function sameChange(a?: Change, b?: Change): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.type === b.type && a.author === b.author && a.time === b.time;
}

