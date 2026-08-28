/**
 * LaTeX output of insets (notes, footnotes, floats, boxes, graphics,
 * command insets, spaces, quotes, math, ...). Mirrors the latex() methods of
 * src/insets/*.cpp.
 */
import type { FormulaInset, FormulaMacroInset, Inset, LeafInset, Paragraph, TextInset } from '../lyx/ast.ts';
import { paramMap, plainText, unquote } from '../lyx/ast.ts';
import type { ExportContext, RunParams } from './context.ts';
import type { InsetLayout, LayoutStyle } from './layouts.ts';
import { findInsetLayout } from './layouts.ts';
import { latexLength, isZeroLength, parseLength } from './lengths.ts';
import { TexStream } from './stream.ts';
import { mathRequirements } from './symbols.ts';
import { escapeText, latexQuotes, type EffectiveFont } from './text.ts';
import { latexParagraphs, latexArgInsets, type Unit } from './body.ts';
import { latexTabular } from './tabular.ts';
import { exportChild } from './export.ts';
import { normalizeMath } from './mathfix.ts';

export interface InsetPosition {
  par: Paragraph;
  index: number;
  units: Unit[];
  isLast: boolean;
  parLang: string;
  itemFont: EffectiveFont;
  style: LayoutStyle;
  /** set by the inset: a blank following it was written before it (tex mode notes) */
  skipNextSpace?: boolean;
}

const MULTIPAR_INSETS = new Set(['Note', 'Foot', 'Marginal', 'Float', 'Wrap', 'Box', 'Branch', 'listings', 'Caption', 'Listings']);

/** Insets around which font commands are closed/reopened (allowMultiPar, produces output). */
export function isFontSwitchInset(ctx: ExportContext, inset: Inset): boolean {
  if (inset.type === 'Tabular') return false;
  if (inset.type !== 'Text') return false;
  if (inset.name === 'ERT') return false;
  if (inset.name === 'Note') return inset.arg === 'Comment' || inset.arg === 'Greyedout';
  if (inset.name === 'Flex') {
    const il = findInsetLayout(ctx.dc, 'Flex:' + inset.arg);
    return !!il && il.multiPar;
  }
  if (inset.name === 'Branch') return branchSelected(ctx, inset);
  return MULTIPAR_INSETS.has(inset.name);
}

function branchSelected(ctx: ExportContext, inset: TextInset): boolean {
  const name = inset.arg;
  const b = ctx.bp.branches.find(x => x.name === name) ?? ctx.opts.masterParams?.branches.find(x => x.name === name);
  const inverted = paramMap(inset.params).get('inverted') === '1';
  const sel = b ? b.selected : false;
  return inverted ? !sel : sel;
}

/* --------------------------------------------------------------- InsetText */

/** InsetText::latex: content of a paragraph-containing inset with an optional InsetLayout. */
export function insetTextLatex(ctx: ExportContext, os: TexStream, rp: RunParams, pars: Paragraph[], il: InsetLayout | undefined, extra: Partial<RunParams> = {}): void {
  if (il) {
    ctx.features.useInsetLayout(il.name);
    for (const r of il.requires) ctx.features.require(r);
  }
  const args = il?.args ?? new Map();
  const found = new Map<string, TextInset>();
  if (args.size) {
    for (const p of pars) for (const it of p.items) if (it.kind === 'inset' && it.inset.type === 'Text' && it.inset.name === 'Argument') found.set(it.inset.arg, it.inset);
  }
  if (il?.forceOwnlines) os.breakln();
  if (il && il.latexName) {
    if (il.latexType === 'command') {
      if (rp.movingArg) os.write('\\protect');
      os.write('\\' + il.latexName);
      if (args.size) latexArgInsets(ctx, os, rp, args, found, '');
      if (il.latexParam) os.write(il.latexParam);
      os.write('{');
    } else if (il.latexType === 'environment') {
      if (il.display) os.breakln(); else os.safebreakln();
      os.write(`\\begin{${il.latexName}}`);
      if (args.size) latexArgInsets(ctx, os, rp, args, found, '');
      if (il.latexParam) os.write(il.latexParam);
      os.write('\n');
    }
  } else if (il) {
    if (args.size) latexArgInsets(ctx, os, rp, args, found, '');
    if (il.latexParam) os.write(il.latexParam);
  }
  if (il?.leftDelim) os.write(il.leftDelim);
  const rp2: RunParams = {
    ...rp, isMainText: false, owner: 'other',
    passThru: rp.passThru || !!il?.passThru,
    movingArg: rp.movingArg || !!il?.needProtect,
    inulemcmd: rp.inulemcmd + (il?.needMBoxProtect ? 1 : 0),
    passThruChars: rp.passThruChars + (il?.passThruChars ?? ''),
    newlineCmd: il?.newlineCmd || rp.newlineCmd,
    forcePlain: !!il?.forcePlain,
    customPars: il ? il.customPars : true,
    parbreakIsNewline: !!il?.parbreakIsNewline,
    parbreakIgnored: !!il?.parbreakIgnored,
    freeSpacing: rp.freeSpacing || !!il?.freeSpacing,
    localSwitch: !!il?.forceLocalFontSwitch || (ctx.usePolyglossia && !!il?.forcePlain),
    postMacro: '',
    ...extra,
  };
  latexParagraphs(ctx, { pars, il, isMainText: false }, os, rp2);
  rp.postMacro += rp2.postMacro;
  if (il?.rightDelim) os.write(il.rightDelim);
  if (il && il.latexName) {
    if (il.latexType === 'command') {
      os.write('}');
      if (args.size) latexArgInsets(ctx, os, rp, args, found, 'post:');
    } else if (il.latexType === 'environment') {
      if (il.display || rp2.inComment) os.breakln(); else os.safebreakln();
      os.write(`\\end{${il.latexName}}`);
      os.breakln();
      if (!il.display) os.protectSpace(true);
    }
  }
  if (il?.forceOwnlines) os.breakln();
}

/* ------------------------------------------------------------ dispatcher */

export function latexInset(ctx: ExportContext, os: TexStream, rp: RunParams, inset: Inset, pos: InsetPosition): void {
  switch (inset.type) {
    case 'Formula': latexFormula(ctx, os, rp, inset, pos); return;
    case 'FormulaMacro': latexMacro(ctx, os, inset); return;
    case 'Tabular': latexTabular(ctx, os, rp, inset); return;
    case 'Raw': ctx.warnings.push(`unknown inset '${inset.firstLine}' dropped`); return;
    case 'Leaf': latexLeaf(ctx, os, rp, inset, pos); return;
    case 'Text': latexTextInset(ctx, os, rp, inset, pos); return;
    default: return;
  }
}

/* ------------------------------------------------------------------- math */

/** Replace non-ASCII characters inside math by their unicodesymbols math commands (InsetMathChar / Encodings::latexMathChar). */
function mathUnicode(ctx: ExportContext, latex: string): string {
  let out = '';
  for (const ch of latex) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) { out += ch; continue; }
    const sym = ctx.unicode.get(cp);
    if (sym && sym.mathCommand) {
      if (sym.mathPreamble) ctx.features.require(sym.mathPreamble);
      out += sym.mathCommand;
    } else if (sym && sym.textCommand && !sym.mathalpha) {
      if (sym.textPreamble) ctx.features.require(sym.textPreamble);
      out += `\\text{${sym.textCommand}}`;
    } else out += ch;
  }
  return out;
}

function latexFormula(ctx: ExportContext, os: TexStream, rp: RunParams, f: FormulaInset, pos: InsetPosition): void {
  for (const r of mathRequirements(f.latex, ctx.symbols)) ctx.features.require(r);
  if (/\\(iint|iiint|iiiint|idotsint|oiint|oiiint|ointctrclockwise|ointclockwise|sqint|varointclockwise|varointctrclockwise|landupint|landdownint)\b/.test(f.latex)) ctx.features.require('esint|amsmath');
  if (f.inline) {
    let latex = mathUnicode(ctx, normalizeMath(f.latex.replace(/\n/g, ' '), ctx.symbols, ctx.macroNames));
    if (rp.movingArg && ctx.macroNames.size) {
      // user macros are fragile: LyX protects them in moving arguments
      latex = latex.replace(/(\\protect)?\\([A-Za-z]+)/g, (m0, prot: string | undefined, name: string) => (!prot && ctx.macroNames.has(name) ? '\\protect' + m0 : m0));
    }
    os.write(latex);
    return;
  }
  // display math: starts on its own line
  if (rp.inulemcmd) {
    if (os.afterParbreak) os.write('\\noindent');
    else os.write('\\\\\n');
  }
  os.breakln();
  os.write(mathUnicode(ctx, normalizeMath(f.latex.replace(/\n$/, ''), ctx.symbols, ctx.macroNames)));
  os.write('\n');
  void pos;
}

/** InsetMathMacroTemplate::write (LaTeX flavour). */
function latexMacro(ctx: ExportContext, os: TexStream, m: FormulaMacroInset): void {
  const def = m.lines[0] ?? '';
  const parsed = parseMacroDefinition(def);
  if (!parsed) { ctx.warnings.push(`could not parse macro definition '${def}'`); return; }
  for (const r of mathRequirements(parsed.body, ctx.symbols)) ctx.features.require(r);
  os.breakln();
  if (parsed.optionals.length) {
    ctx.features.require('xargs');
    os.write(parsed.redefinition ? '\\renewcommandx' : '\\newcommandx');
    os.write(`\\${parsed.name}[${parsed.nargs}][usedefault, addprefix=\\global`);
    parsed.optionals.forEach((o, i) => {
      os.write(`, ${i + 1}=` + (o.includes(']') || o.includes(',') ? `{${o}}` : o));
    });
    os.write(']');
  } else {
    os.write(`\\global\\long\\def\\${parsed.name}`);
    for (let i = 1; i <= parsed.nargs; i++) os.write('#' + i);
  }
  os.write(`{${mathUnicode(ctx, normalizeMath(parsed.body, ctx.symbols, ctx.macroNames))}}%`);
  // LyX's display form (what the editor shows instead of the expansion) rides along in the .tex
  // file as a comment on the definition line: "...}%% @display {(#1)^{-1}}"
  const display = ctx.texMode ? (m.lines[1] ?? '').trim() : '';
  if (display.startsWith('{') && !display.includes('\n')) os.write('% @display ' + display);
  os.write('\n');
}

export interface MacroDefinition { name: string; nargs: number; optionals: string[]; body: string; redefinition: boolean }

/** Parse \newcommand{\name}[n][opt]{body} / \renewcommand / \def\name#1{body}. */
export function parseMacroDefinition(def: string): MacroDefinition | undefined {
  let s = def.trim();
  let redefinition = false;
  let m = /^\\(re)?newcommand\*?\s*\{?\\([A-Za-z@]+)\}?/.exec(s);
  if (m) {
    redefinition = !!m[1];
    const name = m[2];
    s = s.slice(m[0].length);
    let nargs = 0;
    const optionals: string[] = [];
    const nm = /^\s*\[(\d+)\]/.exec(s);
    if (nm) { nargs = parseInt(nm[1], 10); s = s.slice(nm[0].length); }
    for (;;) {
      const t = s.trimStart();
      if (!t.startsWith('[')) { s = t; break; }
      const r = readBalanced(t, '[', ']');
      if (!r) return undefined;
      let val = r.inner;
      if (val.startsWith('{') && val.endsWith('}')) val = val.slice(1, -1);
      optionals.push(val);
      s = t.slice(r.length);
    }
    const b = readBalanced(s.trimStart(), '{', '}');
    if (!b) return undefined;
    return { name, nargs, optionals, body: b.inner, redefinition };
  }
  m = /^\\(?:global\\)?(?:long\\)?def\\([A-Za-z@]+)((?:#\d)*)/.exec(s);
  if (m) {
    const name = m[1];
    const nargs = (m[2].match(/#/g) ?? []).length;
    const b = readBalanced(s.slice(m[0].length).trimStart(), '{', '}');
    if (!b) return undefined;
    return { name, nargs, optionals: [], body: b.inner, redefinition: false };
  }
  return undefined;
}

function readBalanced(s: string, open: string, close: string): { inner: string; length: number } | undefined {
  if (!s.startsWith(open)) return undefined;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === open || (open === '[' && c === '{')) depth++;
    if (c === close || (close === ']' && c === '}')) depth--;
    if (depth === 0) return { inner: s.slice(1, i), length: i + 1 };
  }
  return undefined;
}

/* ------------------------------------------------------------- text insets */

function latexTextInset(ctx: ExportContext, os: TexStream, rp: RunParams, inset: TextInset, pos: InsetPosition): void {
  const pars = inset.paragraphs;
  switch (inset.name) {
    case 'Note': {
      if (ctx.texMode && (inset.arg === 'Note' || inset.arg === 'Comment')) { texNote(ctx, os, rp, inset, pos); return; }
      if (inset.arg === 'Note') return;
      const il = findInsetLayout(ctx.dc, 'Note:' + inset.arg);
      if (inset.arg === 'Greyedout') ctx.features.require('lyxgreyedout');
      const extra: Partial<RunParams> = inset.arg === 'Comment' ? { inComment: true } : {};
      if (inset.arg === 'Comment' && rp.inComment) { latexParagraphs(ctx, { pars, il, isMainText: false }, os, { ...rp, isMainText: false }); return; }
      insetTextLatex(ctx, os, rp, pars, il, extra);
      return;
    }
    case 'ERT': {
      const il = findInsetLayout(ctx.dc, 'ERT');
      insetTextLatex(ctx, os, rp, pars, il, { passThru: true, forcePlain: true, parbreakIsNewline: true, freeSpacing: true });
      // a comment at the end of the raw code must not swallow what follows
      if (ctx.texMode && pars.length && endsInComment(plainText([pars[pars.length - 1]]))) os.breakln();
      return;
    }
    case 'Foot': {
      let il = findInsetLayout(ctx.dc, 'Foot');
      if (rp.inTitle) il = findInsetLayout(ctx.dc, 'Foot:InTitle') ?? il;
      else if (rp.inFloat !== 'none' && rp.owner === 'cell') il = findInsetLayout(ctx.dc, 'Foot:InFloatTable') ?? il;
      if (!il) { os.write('\\footnote{'); insetTextLatex(ctx, os, rp, pars, undefined); os.write('}'); return; }
      insetTextLatex(ctx, os, rp, pars, il);
      return;
    }
    case 'Marginal': {
      const il = findInsetLayout(ctx.dc, 'Marginal');
      if (!il) { os.write('\\marginpar{'); insetTextLatex(ctx, os, rp, pars, undefined); os.write('}'); return; }
      insetTextLatex(ctx, os, rp, pars, il);
      return;
    }
    case 'Float': latexFloat(ctx, os, rp, inset); return;
    case 'Wrap': latexWrap(ctx, os, rp, inset); return;
    case 'Caption': {
      if (rp.inFloat === 'sub') return; // written as optional argument of \subfloat
      const il = findInsetLayout(ctx.dc, 'Caption:' + (inset.arg || 'Standard')) ?? findInsetLayout(ctx.dc, 'Caption:Standard');
      const extra: Partial<RunParams> = { movingArg: true, postponeFragile: ctx.bp.postponeFragileContent };
      const saved = rp.postMacro;
      rp.postMacro = '';
      if (il) insetTextLatex(ctx, os, rp, pars, il, extra);
      else { os.write('\\caption{'); insetTextLatex(ctx, os, rp, pars, undefined, extra); os.write('}'); }
      if (rp.postMacro) os.write(rp.postMacro);
      rp.postMacro = saved;
      os.breakln();
      return;
    }
    case 'Box': latexBox(ctx, os, rp, inset); return;
    case 'Branch': {
      if (!branchSelected(ctx, inset)) return;
      const il = findInsetLayout(ctx.dc, 'Branch:' + inset.arg) ?? findInsetLayout(ctx.dc, 'Branch');
      insetTextLatex(ctx, os, rp, pars, il);
      return;
    }
    case 'Flex': {
      const il = findInsetLayout(ctx.dc, 'Flex:' + inset.arg);
      if (!il) {
        ctx.warnings.push(`unknown Flex inset '${inset.arg}' (not defined by the document class/modules); content written plainly`);
        insetTextLatex(ctx, os, rp, pars, undefined);
        return;
      }
      insetTextLatex(ctx, os, rp, pars, il);
      return;
    }
    case 'Argument': return; // handled by the layout
    case 'Index': latexIndex(ctx, os, rp, inset); return;
    case 'IndexMacro': return; // handled by Index
    case 'listings': latexListings(ctx, os, rp, inset); return;
    case 'script': {
      const cmd = inset.arg === 'subscript' ? '\\textsubscript{' : '\\textsuperscript{';
      if (rp.movingArg) os.write('\\protect');
      os.write(cmd);
      insetTextLatex(ctx, os, rp, pars, findInsetLayout(ctx.dc, 'script'), { forcePlain: true });
      os.write('}');
      return;
    }
    case 'Phantom': {
      const cmd = inset.arg === 'HPhantom' ? '\\hphantom{' : inset.arg === 'VPhantom' ? '\\vphantom{' : '\\phantom{';
      if (rp.movingArg) os.write('\\protect');
      os.write(cmd);
      insetTextLatex(ctx, os, rp, pars, findInsetLayout(ctx.dc, 'Phantom'), { forcePlain: true });
      os.write('}');
      return;
    }
    case 'IPA': {
      ctx.features.require('tipa');
      const multipar = pars.length > 1;
      if (multipar && ctx.encodingMode !== 'plain') os.write('\\begin{IPA}\n'); else os.write('\\textipa{');
      insetTextLatex(ctx, os, rp, pars, findInsetLayout(ctx.dc, 'IPA'), { inIPA: true });
      if (multipar && ctx.encodingMode !== 'plain') os.write('\n\\end{IPA}'); else os.write('}');
      return;
    }
    case 'Preview':
    case 'Text':
      insetTextLatex(ctx, os, rp, pars, undefined);
      return;
    case 'Separator': return;
    default: {
      const il = findInsetLayout(ctx.dc, inset.name + (inset.arg ? ':' + inset.arg : '')) ?? findInsetLayout(ctx.dc, inset.name);
      if (il) { insetTextLatex(ctx, os, rp, pars, il); return; }
      ctx.warnings.push(`unsupported inset '${inset.name} ${inset.arg}'; content written plainly`);
      insetTextLatex(ctx, os, rp, pars, undefined);
    }
  }
  void pos;
}

/** tex mode: notes and comments are written as "%%" comment blocks (see tex/parse.ts). */
function texNote(ctx: ExportContext, os: TexStream, rp: RunParams, inset: TextInset, pos: InsetPosition): void {
  const inner = new TexStream();
  const rp2: RunParams = { ...rp, isMainText: false, owner: 'other', inComment: true, passThru: false, postMacro: '' };
  latexParagraphs(ctx, { pars: inset.paragraphs, isMainText: false }, inner, rp2);
  inner.flushTermination();
  const lines = inner.toString().replace(/\n+$/, '').split('\n');
  // a blank after the note is written before it: the comment eats the newline (and any indentation)
  const next = pos.units[pos.index + 1];
  if (next && next.kind === 'char' && next.ch === ' ') { if (os.column > 0 && os.last !== ' ') os.write(' '); pos.skipNextSpace = true; }
  os.safebreakln();
  // the fold state travels with the note (LyX's status line): open is the default
  os.write('%% @' + inset.arg.toLowerCase() + (inset.status === 'collapsed' ? ' collapsed' : '') + '\n');
  for (const l of lines) os.write('%%' + (l ? ' ' + l : '') + '\n');
}

function endsInComment(s: string): boolean {
  const line = s.slice(s.lastIndexOf('\n') + 1);
  for (let i = 0; i < line.length; i++) { if (line[i] === '\\') { i++; continue; } if (line[i] === '%') return true; }
  return false;
}

/* -------------------------------------------------------------------- Float */

function latexFloat(ctx: ExportContext, os: TexStream, rp: RunParams, inset: TextInset): void {
  const type = inset.arg;
  const p = paramMap(inset.params);
  const spec = ctx.dc.floats.get(type);
  if (!spec) ctx.warnings.push(`unknown float type '${type}'`);
  ctx.features.useFloat(type, false);
  if (spec) for (const r of spec.requires) ctx.features.require(r);
  if (spec && spec.usesFloatPkg) ctx.features.require('float');
  if (rp.inFloat !== 'none') {
    // subfloat
    ctx.features.require('subfig');
    ctx.features.useFloat(type, true);
    if (inset.paragraphs.length) os.safebreakln();
    if (rp.movingArg) os.write('\\protect');
    os.write('\\subfloat');
    const cap = findCaption(inset.paragraphs);
    if (cap) {
      os.write('[');
      insetTextLatex(ctx, os, { ...rp, inFloat: 'main' }, cap.paragraphs, undefined, { movingArg: true });
      os.write(']');
    }
    os.write('{');
    insetTextLatex(ctx, os, { ...rp, inFloat: 'sub', owner: 'float' }, inset.paragraphs, undefined);
    os.write('}');
    return;
  }
  const sideways = p.get('sideways') === 'true';
  const wide = p.get('wide') === 'true';
  let tmptype = type;
  if (sideways && (spec?.allowsSideways ?? true)) { tmptype = 'sideways' + type; ctx.features.require('rotfloat'); }
  if (wide && (spec?.allowsWide ?? true) && (!sideways || type === 'figure' || type === 'table')) tmptype += '*';
  const defPlacement = spec?.placement ?? '';
  const bufPlacement = ctx.bp.floatPlacement;
  const placementParam = p.get('placement') ?? 'document';
  let tmpplacement = '';
  if (placementParam === 'document' && bufPlacement && bufPlacement !== defPlacement) tmpplacement = bufPlacement;
  else if (placementParam && placementParam !== 'document' && placementParam !== 'class' && placementParam !== defPlacement) tmpplacement = placementParam;
  const allowed = spec?.allowedPlacement ?? '!htbpH';
  let placement = '';
  for (const c of tmpplacement) if (allowed.includes(c)) placement += c;
  if (placement.includes('H')) ctx.features.require('float');
  os.breakln();
  os.write(`\\begin{${tmptype}}`);
  if (placement && (!sideways || placement !== 'p')) os.write(`[${placement}]`);
  os.write('\n');
  let alignment = p.get('alignment') ?? 'document';
  if (alignment === 'document') alignment = ctx.bp.floatAlignment;
  if (alignment === 'left') { os.write('\\raggedright'); os.breakln(); }
  else if (alignment === 'center') { os.write('\\centering'); os.breakln(); }
  else if (alignment === 'right') { os.write('\\raggedleft'); os.breakln(); }
  insetTextLatex(ctx, os, { ...rp, inFloat: 'main', owner: 'float' }, inset.paragraphs, undefined, { owner: 'float', inFloat: 'main' });
  os.breakln();
  os.write(`\\end{${tmptype}}\n`);
}

function findCaption(pars: Paragraph[]): TextInset | undefined {
  for (const p of pars) for (const it of p.items) if (it.kind === 'inset' && it.inset.type === 'Text' && it.inset.name === 'Caption') return it.inset;
  return undefined;
}

/* --------------------------------------------------------------------- Wrap */

function latexWrap(ctx: ExportContext, os: TexStream, rp: RunParams, inset: TextInset): void {
  const p = paramMap(inset.params);
  const type = inset.arg || 'figure';
  ctx.features.require('wrapfig');
  ctx.features.useFloat(type, false);
  const lines = parseInt(p.get('lines') ?? '0', 10) || 0;
  os.write(`\\begin{wrap${type}}`);
  if (lines) os.write(`[${lines}]`);
  os.write(`{${p.get('placement') ?? 'o'}}`);
  const overhang = p.get('overhang') ?? '';
  if (!isZeroLength(overhang)) os.write(`[${latexLength(overhang)}]`);
  os.write(`{${latexLength(p.get('width') ?? '50col%')}}%\n`);
  insetTextLatex(ctx, os, { ...rp, inFloat: 'main', owner: 'wrap' }, inset.paragraphs, undefined, { owner: 'wrap', inFloat: 'main' });
  os.write(`\\end{wrap${type}}%\n`);
}

/* ---------------------------------------------------------------------- Box */

const DEFAULT_THICK = '0.4pt';
const DEFAULT_SEP = '3pt';
const DEFAULT_SHADOW = '4pt';

function latexBox(ctx: ExportContext, os: TexStream, rp: RunParams, inset: TextInset): void {
  const p = paramMap(inset.params);
  const g = (k: string, d = '') => unquote(p.get(k)) || d;
  const btype = inset.arg || 'Boxed';
  const innerBox = g('has_inner_box', '0') === '1';
  const useParbox = g('use_parbox', '0') === '1';
  const useMakebox = g('use_makebox', '0') === '1';
  const pos = g('position', 't');
  const horPos = g('hor_pos', 'c');
  const innerPos = g('inner_pos', 't');
  const widthRaw = g('width', '');
  const special = g('special', 'none');
  const heightRaw = g('height', '1in');
  const heightSpecial = g('height_special', 'totalheight');
  const thickness = latexLength(g('thickness', DEFAULT_THICK)) || DEFAULT_THICK;
  const separation = latexLength(g('separation', DEFAULT_SEP)) || DEFAULT_SEP;
  const shadowsize = latexLength(g('shadowsize', DEFAULT_SHADOW)) || DEFAULT_SHADOW;
  const framecolor = g('framecolor', 'black');
  const backgroundcolor = g('backgroundcolor', 'none');
  let width = latexLength(widthRaw);
  if (framecolor !== 'black' || backgroundcolor !== 'none') ctx.features.require('xcolor');
  if (btype === 'Shaded') { ctx.features.require('framed'); ctx.features.require('color'); }
  if (btype === 'Framed') ctx.features.require('framed');
  if (btype === 'Shadowbox' || btype === 'Doublebox' || btype === 'ovalbox' || btype === 'Ovalbox') ctx.features.require('fancybox');
  if (btype === 'Boxed' && !innerBox && width) ctx.features.require('calc');

  let stdwidth = false;
  if (innerBox && (width.includes('1\\columnwidth') || width.includes('1\\textwidth') || width.includes('1\\paperwidth') || width.includes('1\\linewidth'))) {
    stdwidth = true;
    switch (btype) {
      case 'Framed': width += ' - 2\\FrameSep - 2\\FrameRule'; break;
      case 'Boxed': width += ' - 2\\fboxsep - 2\\fboxrule'; break;
      case 'ovalbox': width += ' - 2\\fboxsep - 0.8pt'; break;
      case 'Ovalbox': width += ' - 2\\fboxsep - 1.6pt'; break;
      case 'Shadowbox': width += ' - 2\\fboxsep - 2\\fboxrule - \\shadowsize'; break;
      case 'Doublebox': width += ' - 2\\fboxsep - 7.5\\fboxrule - 1pt'; break;
      default: break;
    }
    if (btype !== 'Frameless' && btype !== 'Shaded') ctx.features.require('calc');
  }
  os.safebreakln();
  if (stdwidth && ctx.bp.paragraphSeparation === 'indent') os.write('\\noindent');
  const sizeArg = () => special !== 'none' ? `[${parseLength(widthRaw)?.value ?? ''}\\${special}]` : `[${width}]`;
  switch (btype) {
    case 'Frameless': break;
    case 'Framed':
      if (thickness !== DEFAULT_THICK) { os.write(`{\\FrameRule ${thickness}`); if (separation !== DEFAULT_SEP) os.write(`\\FrameSep ${separation}`); }
      if (separation !== DEFAULT_SEP && thickness === DEFAULT_THICK) os.write(`{\\FrameSep ${separation}`);
      os.write('\\begin{framed}%\n');
      break;
    case 'Boxed':
      if (thickness !== DEFAULT_THICK) { os.write(`{\\fboxrule ${thickness}`); if (separation !== DEFAULT_SEP) os.write(`\\fboxsep ${separation}`); }
      if (separation !== DEFAULT_SEP && thickness === DEFAULT_THICK) os.write(`{\\fboxsep ${separation}`);
      if (!innerBox && width) {
        if (framecolor !== 'black' || backgroundcolor !== 'none') os.write(`\\fcolorbox{${framecolor}}{${backgroundcolor}}{\\makebox`);
        else os.write('\\framebox');
        os.write(sizeArg());
        if (horPos !== 'c') os.write(`[${horPos}]`);
      } else if (framecolor !== 'black' || backgroundcolor !== 'none') {
        os.write(`\\fcolorbox{${framecolor}}{${backgroundcolor}}`);
      } else os.write('\\fbox');
      os.write('{');
      break;
    case 'ovalbox':
      if (separation && separation !== DEFAULT_SEP) os.write(`{\\fboxsep ${separation}`);
      os.write('\\ovalbox{');
      break;
    case 'Ovalbox':
      if (separation && separation !== DEFAULT_SEP) os.write(`{\\fboxsep ${separation}`);
      os.write('\\Ovalbox{');
      break;
    case 'Shadowbox':
      if (thickness !== DEFAULT_THICK) {
        os.write(`{\\fboxrule ${thickness}`);
        if (separation !== DEFAULT_SEP) { os.write(`\\fboxsep ${separation}`); if (shadowsize !== DEFAULT_SHADOW) os.write(`\\shadowsize ${shadowsize}`); }
        if (shadowsize !== DEFAULT_SHADOW && separation === DEFAULT_SEP) os.write(`\\shadowsize ${shadowsize}`);
      }
      if (separation !== DEFAULT_SEP && thickness === DEFAULT_THICK) { os.write(`{\\fboxsep ${separation}`); if (shadowsize !== DEFAULT_SHADOW) os.write(`\\shadowsize ${shadowsize}`); }
      if (shadowsize !== DEFAULT_SHADOW && separation === DEFAULT_SEP && thickness === DEFAULT_THICK) os.write(`{\\shadowsize ${shadowsize}`);
      os.write('\\shadowbox{');
      break;
    case 'Shaded': break;
    case 'Doublebox':
      if (thickness !== DEFAULT_THICK) { os.write(`{\\fboxrule ${thickness}`); if (separation !== DEFAULT_SEP) os.write(`\\fboxsep ${separation}`); }
      if (separation !== DEFAULT_SEP && thickness === DEFAULT_THICK) os.write(`{\\fboxsep ${separation}`);
      os.write('\\doublebox{');
      break;
    default:
      ctx.warnings.push(`unknown box type '${btype}'`);
  }
  if (innerBox) {
    if (useParbox) {
      if (backgroundcolor !== 'none' && btype === 'Frameless') os.write(`\\colorbox{${backgroundcolor}}{`);
      os.write('\\parbox');
    } else if (useMakebox) {
      if (width) {
        if (backgroundcolor !== 'none') os.write(`\\colorbox{${backgroundcolor}}{`);
        os.write('\\makebox');
        os.write(sizeArg());
        if (horPos !== 'c') os.write(`[${horPos}]`);
      } else {
        if (backgroundcolor !== 'none') os.write(`\\colorbox{${backgroundcolor}}`);
        else os.write('\\mbox');
      }
      os.write('{');
    } else {
      if (backgroundcolor !== 'none' && btype === 'Frameless') os.write(`\\colorbox{${backgroundcolor}}{`);
      os.write('\\begin{minipage}');
    }
    if (!useMakebox) {
      os.write(`[${pos}]`);
      if (heightSpecial === 'none') os.write(`[${latexLength(heightRaw)}]`);
      else if (heightRaw !== '1in' || heightSpecial !== 'totalheight' || innerPos !== pos) os.write(`[${parseLength(heightRaw)?.value ?? 1}\\${heightSpecial}]`);
      if (innerPos !== pos) os.write(`[${innerPos}]`);
      os.write(`{${width}}`);
      if (useParbox) os.write('{');
    }
    os.write('%\n');
  }
  if (btype === 'Shaded') os.write('\\begin{shaded}%\n');
  const il = findInsetLayout(ctx.dc, 'Box:' + btype) ?? findInsetLayout(ctx.dc, 'Box');
  insetTextLatex(ctx, os, rp, inset.paragraphs, il && !il.latexName ? il : undefined);
  if (btype === 'Shaded') os.write('\\end{shaded}');
  if (innerBox) {
    if (useParbox || useMakebox) os.write('%\n}');
    else os.write('%\n\\end{minipage}');
    if (backgroundcolor !== 'none' && btype === 'Frameless' && !(useMakebox && !width)) os.write('}');
  }
  switch (btype) {
    case 'Frameless': break;
    case 'Framed': os.write('\\end{framed}'); if (separation !== DEFAULT_SEP || thickness !== DEFAULT_THICK) os.write('}'); break;
    case 'Boxed':
      os.write('}');
      if (!innerBox && width && (framecolor !== 'black' || backgroundcolor !== 'none')) os.write('}');
      if (separation !== DEFAULT_SEP || thickness !== DEFAULT_THICK) os.write('}');
      break;
    case 'ovalbox': case 'Ovalbox': os.write('}'); if (separation !== DEFAULT_SEP) os.write('}'); break;
    case 'Doublebox': os.write('}'); if (separation !== DEFAULT_SEP || thickness !== DEFAULT_THICK) os.write('}'); break;
    case 'Shadowbox': os.write('}'); if (separation !== DEFAULT_SEP || thickness !== DEFAULT_THICK || shadowsize !== DEFAULT_SHADOW) os.write('}'); break;
    default: break;
  }
}

/* -------------------------------------------------------------------- Index */

function latexIndex(ctx: ExportContext, os: TexStream, rp: RunParams, inset: TextInset): void {
  ctx.features.require('makeidx');
  const p = paramMap(inset.params);
  const idx = inset.arg || 'idx';
  const rp2: RunParams = { ...rp, inIndexEntry: true, movingArg: rp.postponeFragile ? false : rp.movingArg };
  const out = new TexStream();
  if (ctx.bp.useIndices && idx !== 'idx') { ctx.features.require('splitidx'); out.write(`\\sindex[${idx}]{`); }
  else out.write('\\index{');
  // separate the entry text from IndexMacro insets
  const macros: { kind: string; pars: Paragraph[] }[] = [];
  const textPars: Paragraph[] = inset.paragraphs.map(par => ({
    ...par,
    items: par.items.filter(it => {
      if (it.kind === 'inset' && it.inset.type === 'Text' && it.inset.name === 'IndexMacro') { macros.push({ kind: it.inset.arg, pars: it.inset.paragraphs }); return false; }
      return true;
    }),
  }));
  const latexOf = (pars: Paragraph[]) => { const s = new TexStream(); insetTextLatex(ctx, s, rp2, pars, undefined, { forcePlain: true }); s.flushTermination(); return s.toString(); };
  const latexStr = latexOf(textPars);
  const plainStr = plainText(textPars);
  const sortkey = macros.find(m => m.kind === 'sortkey');
  const sub = macros.filter(m => m.kind === 'subentry');
  const see = macros.find(m => m.kind === 'see' || m.kind === 'seealso');
  const range = p.get('range') ?? 'none';
  const pagefmt = p.get('pageformat') ?? 'default';
  const rangeStr = range === 'start' ? '(' : range === 'end' ? ')' : '';
  if (sortkey) {
    out.write(latexOf(sortkey.pars) + '@' + latexStr);
    for (const s of sub) out.write('!' + latexOf(s.pars));
  } else {
    // split levels on "!" and add plain sort keys where the LaTeX differs
    const levels = latexStr.split('!');
    const plainLevels = plainStr.split('!');
    levels.forEach((lvl, i) => {
      if (i > 0) out.write('!');
      const pl = plainLevels[i] ?? lvl;
      if (lvl !== pl && !lvl.includes('@')) out.write(pl.trim() + '@' + lvl);
      else out.write(lvl);
    });
    for (const s of sub) out.write('!' + latexOf(s.pars));
  }
  if (see) out.write(`|${rangeStr}${see.kind}{${latexOf(see.pars)}}`);
  else if (pagefmt && pagefmt !== 'default') out.write(`|${rangeStr}${pagefmt}`);
  else if (rangeStr) out.write('|' + rangeStr);
  out.write('}');
  if (rp.postponeFragile) rp.postMacro += out.toString();
  else os.write(out.toString());
}

/* ----------------------------------------------------------------- listings */

function latexListings(ctx: ExportContext, os: TexStream, rp: RunParams, inset: TextInset): void {
  const p = paramMap(inset.params);
  const isInline = p.get('inline') === 'true';
  let params = unquote(p.get('lstparams'));
  ctx.features.require('listings');
  const useMinted = ctx.bp.useMinted;
  if (useMinted) ctx.features.require('minted');
  // fontfamily / fontsize (minted syntax) → basicstyle
  const m5 = /(.*)(fontfamily=)(tt|sf|rm)(.*)/.exec(params);
  let basicstyle = '';
  if (m5) { basicstyle = `\\${m5[3]}family`; params = m5[1] + m5[4]; }
  const m6 = /(.*)(fontsize=\{)(\\(tiny|scriptsize|footnotesize|small|normalsize|large|Large))(\})(.*)/.exec(params);
  if (m6) { basicstyle += m6[3]; params = m6[1] + m6[6]; }
  if (basicstyle && !useMinted) params = params.replace(/,$/, '') + (params ? ',' : '') + `basicstyle={${basicstyle}}`;
  params = params.replace(/^,|,$/g, '');
  const isFloat = /(^|,)float(=|,|$)/.test(params);
  let code = '';
  const captionPars: Paragraph[] = [];
  const pars = inset.paragraphs;
  pars.forEach((par, idx) => {
    let captionline = false;
    par.items.forEach((it, i) => {
      if (i === 0 && it.kind === 'inset' && par.items.length === 1) captionline = true;
      if (it.change?.type === 'deleted' && !ctx.outputChanges) return;
      if (it.kind === 'inset' && it.inset.type === 'Text' && it.inset.name === 'Caption') { captionPars.push(...it.inset.paragraphs); return; }
      if (it.kind === 'text') code += it.text;
      else if (it.kind === 'inset' && it.inset.type === 'Leaf' && it.inset.name === 'Quotes') code += it.inset.arg[2] === 'd' ? '"' : "'";
      else if (it.kind === 'inset' && it.inset.type === 'Leaf' && it.inset.name === 'space') code += ' ';
    });
    if (idx + 1 < pars.length && !isInline && !captionline && par.endChange?.type !== 'deleted') code += '\n';
  });
  if (isInline) {
    const delimiters = '!*()-=+|;:\'"`,<.>/?QWERTYUIOPASDFGHJKLZXCVBNMqwertyuiopasdfghjklzxcvbnm';
    let d = '';
    for (const c of delimiters) if (!code.includes(c)) { d = c; break; }
    if (!d) { d = '!'; code = code.replace(/!/g, '<LyX Warning: no more lstline delimiters available>'); }
    if (useMinted) {
      os.write('\\mintinline');
      if (params) os.write(`[${params}]`);
      os.write('{tex}');
    } else {
      os.write('\\lstinline');
      if (params) os.write(`[${params}]`);
      else if (/[A-Za-z]/.test(d)) os.write(' ');
    }
    os.write(d + code + d);
    return;
  }
  if (useMinted) {
    os.breakln();
    if (isFloat) os.write('\\begin{listing}\n');
    os.write('\\begin{minted}');
    if (params) os.write(`[${params}]`);
    os.write('{tex}\n' + code);
    os.breakln();
    os.write('\\end{minted}\n');
    if (isFloat) os.write('\\end{listing}\n');
    return;
  }
  // caption / label inside the inset go to the lstparams
  if (captionPars.length) {
    const s = new TexStream();
    let label = '';
    const cleaned = captionPars.map(par => ({ ...par, items: par.items.filter(it => {
      if (it.kind === 'inset' && it.inset.type === 'Leaf' && it.inset.name === 'CommandInset' && it.inset.arg === 'label') { label = unquote(paramMap(it.inset.params).get('name')); return false; }
      return true;
    }) }));
    insetTextLatex(ctx, s, { ...rp, movingArg: true }, cleaned, undefined, { forcePlain: true });
    s.flushTermination();
    const cap = s.toString().trim();
    const extra: string[] = [];
    if (cap) extra.push(`caption={${cap}}`);
    if (label) extra.push(`label={${label}}`);
    params = [params, ...extra].filter(Boolean).join(',');
  }
  os.breakln();
  os.write('\\begin{lstlisting}');
  if (params) os.write(`[${params}]`);
  os.write('\n' + code);
  os.breakln();
  os.write('\\end{lstlisting}\n');
}

/* ------------------------------------------------------------ leaf insets */

function latexLeaf(ctx: ExportContext, os: TexStream, rp: RunParams, inset: LeafInset, pos: InsetPosition): void {
  switch (inset.name) {
    case 'CommandInset': latexCommand(ctx, os, rp, inset, pos); return;
    case 'Graphics': latexGraphics(ctx, os, rp, inset); return;
    case 'Quotes': latexQuotes(ctx, os, rp, inset.arg); return;
    case 'space': latexSpace(ctx, os, rp, inset); return;
    case 'Newline':
      if (inset.arg === 'linebreak') { os.write('\\linebreak{}\n'); return; }
      if (rp.newlineCmd) os.write(`\\${rp.newlineCmd}\n`);
      else if (rp.inTableCell === 'plain') os.write('\\newline\n');
      else os.write('\\\\\n');
      return;
    case 'Newpage': {
      const kinds: Record<string, string> = { newpage: '\\newpage', pagebreak: '\\pagebreak', clearpage: '\\clearpage', cleardoublepage: '\\cleardoublepage', nopagebreak: '\\nopagebreak' };
      if (inset.arg === 'pagebreak' && rp.movingArg) os.write('\\protect');
      os.write(kinds[inset.arg] ?? '\\newpage');
      os.termcmd();
      return;
    }
    case 'VSpace': latexVSpace(ctx, os, rp, inset, pos); return;
    case 'Separator':
      if (!os.afterParbreak) {
        os.breakln();
        if (inset.arg === 'plain') os.write('%\n');
        else if (rp.inDeletedInset) os.write('}\n\n{');
        else os.write('\n');
      }
      return;
    case 'FloatList': {
      const spec = ctx.dc.floats.get(inset.arg);
      if (spec) {
        if (spec.usesFloatPkg) { ctx.features.require('float'); os.write(`\\listof{${inset.arg}}{${spec.listName}}\n`); }
        else if (spec.listCommand) os.write(`\\${spec.listCommand}\n`);
        else os.write(`%% LyX cannot generate a list of ${inset.arg}\n`);
      } else os.write(`%%\\listof{${inset.arg}}{List of ${inset.arg}}\n`);
      return;
    }
    case 'Info': {
      const p = paramMap(inset.params);
      const type = unquote(p.get('type')?.trim());
      const arg = unquote(p.get('arg')?.trim());
      if (type === 'menu' || type === 'shortcut' || type === 'shortcuts' || type === 'package' || type === 'textclass' || type === 'lyxinfo' || type === 'buffer' || type === 'date' || type === 'moddate' || type === 'fixdate' || type === 'time' || type === 'l7n' || type === 'unknown') {
        os.write(escapeText(ctx, arg));
      } else if (type === 'icon') {
        ctx.warnings.push(`Info inset of type 'icon' (${arg}) dropped`);
      } else os.write(escapeText(ctx, arg));
      return;
    }
    case 'External': latexExternal(ctx, os, rp, inset); return;
    default:
      ctx.warnings.push(`unsupported inset '${inset.name} ${inset.arg}' dropped`);
  }
}

function latexSpace(ctx: ExportContext, os: TexStream, rp: RunParams, inset: LeafInset): void {
  const arg = inset.arg;
  const free = rp.freeSpacing;
  const p = paramMap(inset.params);
  const len = latexLength(p.get('\\length'));
  const map: Record<string, string> = {
    '\\space{}': free ? ' ' : '\\ ', '~': free ? ' ' : '~', '\\nobreakspace{}': '\\nobreakspace{}', '\\textvisiblespace{}': free ? ' ' : '\\textvisiblespace{}',
    '\\thinspace{}': free ? ' ' : '\\,', '\\medspace{}': free ? ' ' : '\\medspace{}', '\\thickspace{}': free ? ' ' : '\\thickspace{}',
    '\\quad{}': free ? ' ' : '\\quad{}', '\\qquad{}': free ? ' ' : '\\qquad{}', '\\enspace{}': free ? ' ' : '\\enspace{}',
    '\\enskip{}': free ? ' ' : '\\enskip{}', '\\negthinspace{}': '\\negthinspace{}', '\\negmedspace{}': '\\negmedspace{}',
    '\\negthickspace{}': '\\negthickspace{}', '\\hfill{}': '\\hfill{}', '\\hspace*{\\fill}': '\\hspace*{\\fill}',
    '\\dotfill{}': '\\dotfill{}', '\\hrulefill{}': '\\hrulefill{}', '\\leftarrowfill{}': '\\leftarrowfill{}',
    '\\rightarrowfill{}': '\\rightarrowfill{}', '\\upbracefill{}': '\\upbracefill{}', '\\downbracefill{}': '\\downbracefill{}',
    '\\hspace{}': free ? ' ' : `\\hspace{${len}}`, '\\hspace*{}': free ? ' ' : `\\hspace*{${len}}`,
  };
  if (arg === '\\medspace{}' || arg === '\\thickspace{}' || arg === '\\negmedspace{}' || arg === '\\negthickspace{}') ctx.features.require('amsmath');
  const out = map[arg];
  if (out === undefined) { ctx.warnings.push(`unknown space inset '${arg}'`); os.write(' '); return; }
  os.write(out);
}

function latexVSpace(ctx: ExportContext, os: TexStream, rp: RunParams, inset: LeafInset, pos: InsetPosition): void {
  let arg = inset.arg.trim();
  const keep = arg.endsWith('*');
  if (keep) arg = arg.slice(0, -1);
  const cmd = vspaceCommand(ctx, arg, keep);
  os.write(cmd);
  os.breakln();
  // \noindent after a leading vspace
  if (pos.index === 0 && pos.par.params.noindent && pos.units.length > 1 && !rp.forcePlain) {
    const canIndent = ctx.bp.paragraphSeparation === 'indent' ? pos.style.toggleIndent !== 'never' : pos.style.toggleIndent === 'always';
    if (canIndent && (pos.par.params.align ?? pos.style.align) !== 'center') { os.write('\\noindent'); os.termcmd(); }
  }
}

export function vspaceCommand(ctx: ExportContext, kind: string, keep: boolean): string {
  switch (kind) {
    case 'defskip': return vspaceCommand(ctx, ctx.bp.defSkip === 'defskip' ? 'medskip' : ctx.bp.defSkip, keep);
    case 'smallskip': return keep ? '\\vspace*{\\smallskipamount}' : '\\smallskip{}';
    case 'medskip': return keep ? '\\vspace*{\\medskipamount}' : '\\medskip{}';
    case 'bigskip': return keep ? '\\vspace*{\\bigskipamount}' : '\\bigskip{}';
    case 'halfline': return keep ? '\\vspace*{.5\\baselineskip}' : '\\vspace{.5\\baselineskip}';
    case 'fullline': return keep ? '\\vspace*{\\baselineskip}' : '\\vspace{\\baselineskip}';
    case 'vfill': return keep ? '\\vspace*{\\fill}' : '\\vfill{}';
    default: {
      const l = latexLength(kind);
      return keep ? `\\vspace*{${l}}` : `\\vspace{${l}}`;
    }
  }
}

/* --------------------------------------------------------------- graphics */

const PDFLATEX_FORMATS = new Set(['pdf', 'png', 'jpg', 'jpeg', 'mps']);

function latexGraphics(ctx: ExportContext, os: TexStream, rp: RunParams, inset: LeafInset): void {
  const p = paramMap(inset.params);
  ctx.features.require('graphicx');
  const filename = p.get('filename') ?? '';
  const opts: string[] = [];
  const bb = p.get('BoundingBox');
  if (bb && bb.trim()) {
    const parts = bb.trim().split(/\s+/);
    if (parts.length === 4) opts.push(`viewport=${parts.map(x => latexLength(x)).join(' ')}`);
  }
  if (p.has('draft')) opts.push('draft');
  if (p.has('clip')) opts.push('clip');
  const size: string[] = [];
  const scale = parseFloat(p.get('scale') ?? '');
  if (p.has('scale') && !Number.isNaN(scale) && Math.abs(scale) > 0.05) {
    if (Math.abs(scale - 100) > 0.05) size.push(`scale=${String(Number((scale / 100).toFixed(4)))}`);
  } else {
    if (!isZeroLength(p.get('width'))) size.push(`width=${latexLength(p.get('width'))}`);
    if (!isZeroLength(p.get('height'))) size.push(`totalheight=${latexLength(p.get('height'))}`);
    if (p.has('keepAspectRatio')) size.push('keepaspectratio');
  }
  const scaleBeforeRotation = p.has('scaleBeforeRotation');
  if (scaleBeforeRotation) opts.push(...size);
  const angle = parseFloat(p.get('rotateAngle') ?? '');
  if (!Number.isNaN(angle) && Math.abs(angle) > 0.001) {
    opts.push(`angle=${p.get('rotateAngle')}`);
    const origin = p.get('rotateOrigin') ?? '';
    if (origin) {
      let o = 'origin=' + origin[0];
      if (origin.includes('Top')) o += 't'; else if (origin.includes('Bottom')) o += 'b'; else if (origin.includes('Baseline')) o += 'B';
      opts.push(o);
    }
  }
  if (!scaleBeforeRotation) opts.push(...size);
  if (p.get('special')) opts.push(p.get('special')!);
  if (rp.movingArg) os.write('\\protect');
  os.write('\\includegraphics');
  if (opts.length) os.write(`[${opts.join(',')}]`);
  os.write('{' + graphicsFileName(ctx, filename) + '}');
}

/** File name to reference from the .tex (registers conversions in ctx.graphics). */
function graphicsFileName(ctx: ExportContext, filename: string): string {
  if (!filename) return '';
  if (ctx.texMode) return filename.replace(/\\/g, '/');
  const norm = filename.replace(/\\/g, '/');
  const slash = norm.lastIndexOf('/');
  const dir = slash >= 0 ? norm.slice(0, slash + 1) : '';
  const base = slash >= 0 ? norm.slice(slash + 1) : norm;
  const dot = base.lastIndexOf('.');
  const ext = dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
  const stem = dot >= 0 ? base.slice(0, dot) : base;
  if (ext && !PDFLATEX_FORMATS.has(ext)) {
    // needs conversion (svg, eps, tif, ...) → <mangled>.pdf
    const mangled = norm.replace(/^\.\.?\//g, '').replace(/[^A-Za-z0-9_-]/g, '_') + '.pdf';
    if (!ctx.graphics.some(g => g.src === filename)) ctx.graphics.push({ src: filename, dest: mangled });
    return mangled.slice(0, -4);
  }
  if (norm.includes(' ')) return `\\string"${norm}\\string"`;
  // strip the extension when no other dots are in the file name
  if (!stem.includes('.')) return dir + stem;
  ctx.features.require('lyxdot');
  return dir + stem.replace(/\./g, '\\lyxdot ') + (ext ? '.' + ext : '');
}

function latexExternal(ctx: ExportContext, os: TexStream, rp: RunParams, inset: LeafInset): void {
  const p = paramMap(inset.params);
  const template = p.get('template') ?? '';
  const filename = p.get('filename') ?? '';
  if (template === 'RasterImage' || template === 'VectorGraphics' || template === 'PDFPages') {
    const opts: string[] = [];
    if (!isZeroLength(p.get('width'))) opts.push(`width=${latexLength(p.get('width'))}`);
    if (!isZeroLength(p.get('height'))) opts.push(`height=${latexLength(p.get('height'))}`);
    const scale = parseFloat(p.get('scale') ?? '');
    if (!Number.isNaN(scale) && Math.abs(scale - 100) > 0.05) opts.push(`scale=${String(Number((scale / 100).toFixed(4)))}`);
    if (p.has('keepAspectRatio')) opts.push('keepaspectratio');
    const angle = parseFloat(p.get('rotateAngle') ?? '');
    if (!Number.isNaN(angle) && Math.abs(angle) > 0.001) opts.push(`angle=${angle}`);
    const extra = /LaTeX "([^"]*)"/.exec(p.get('extra') ?? '');
    if (extra) opts.push(extra[1]);
    if (template === 'PDFPages') {
      ctx.features.require('pdfpages');
      os.write(`\\includepdf[${opts.filter(o => !o.startsWith('width') && !o.startsWith('height')).join(',') || 'pages=-'}]{${filename}}`);
      return;
    }
    ctx.features.require('graphicx');
    if (rp.movingArg) os.write('\\protect');
    os.write('\\includegraphics');
    if (opts.length) os.write(`[${opts.join(',')}]`);
    os.write('{' + graphicsFileName(ctx, filename) + '}');
    return;
  }
  ctx.warnings.push(`External inset with template '${template}' (${filename}) is not supported and was dropped`);
}

/* ---------------------------------------------------------- command insets */

const NATBIB_CMDS = new Set(['cite', 'citet', 'citep', 'citealt', 'citealp', 'citeauthor', 'citeyear', 'citeyearpar', 'nocite',
  'Citet', 'Citep', 'Citealt', 'Citealp', 'Citeauthor', 'citet*', 'citep*', 'citealt*', 'citealp*', 'citeauthor*', 'Citet*', 'Citep*', 'Citealt*', 'Citealp*', 'Citeauthor*']);
const BIBLATEX_CMDS = new Set(['cite', 'Cite', 'citet', 'citep', 'citeauthor', 'Citeauthor', 'citeyear', 'citetitle', 'fullcite',
  'footcite', 'footcitetext', 'autocite', 'Autocite', 'textcite', 'Textcite', 'parencite', 'Parencite', 'supercite', 'nocite',
  'citealt', 'citealp', 'Citet', 'Citep', 'citeyearpar', 'smartcite', 'Smartcite', 'citedate', 'citeurl', 'cite*', 'citeauthor*', 'Citeauthor*', 'citet*', 'citep*', 'citealt*', 'citealp*']);

function latexCommand(ctx: ExportContext, os: TexStream, rp: RunParams, inset: LeafInset, pos: InsetPosition): void {
  const p = paramMap(inset.params);
  const g = (k: string) => unquote(p.get(k));
  const cmd = p.get('LatexCommand') ?? inset.arg;
  const literal = g('literal') === 'true';
  const protect = rp.movingArg ? '\\protect' : '';
  switch (inset.arg) {
    case 'label': {
      const name = g('name');
      const s = `\\label{${escapeLabel(name)}}`;
      if (rp.postponeFragile) rp.postMacro += s;
      else os.write((rp.movingArg && rp.inFloat !== 'sub' ? '\\protect' : '') + s);
      return;
    }
    case 'ref': latexRef(ctx, os, rp, cmd, g); return;
    case 'citation': {
      const key = g('key').replace(/\s*,\s*/g, ',').trim();
      const before = literal ? g('before') : escapeText(ctx, g('before'));
      const after = literal ? g('after') : escapeText(ctx, g('after'));
      let c = cmd;
      const engine = ctx.bp.citeEngine;
      if (c === 'keyonly') { os.write(key); return; }
      if (engine === 'natbib' || engine === 'biblatex-natbib') { if (!NATBIB_CMDS.has(c) && !(engine === 'biblatex-natbib' && BIBLATEX_CMDS.has(c))) c = 'cite'; }
      else if (engine === 'biblatex') { if (!BIBLATEX_CMDS.has(c)) c = 'cite'; }
      else if (engine === 'jurabib') { if (!['cite', 'citet', 'citep', 'citealt', 'citealp', 'citeauthor', 'citeyear', 'citeyearpar', 'nocite', 'fullcite', 'footcite'].includes(c)) c = 'cite'; }
      else if (c !== 'nocite') c = 'cite';
      if (engine === 'natbib' || engine === 'biblatex-natbib') ctx.features.require('natbib');
      if (engine === 'biblatex' || engine === 'biblatex-natbib') ctx.features.require('biblatex');
      if (engine === 'jurabib') ctx.features.require('jurabib');
      const textBefore = c !== 'nocite';
      if (rp.inulemcmd > 0) os.write('\\mbox{');
      os.write('\\' + c);
      if (before && textBefore) os.write(`[${protectArg(before)}][${protectArg(after)}]`);
      else if (after && textBefore) os.write(`[${protectArg(after)}]`);
      os.write(`{${key}}`);
      if (rp.inulemcmd > 0) os.write('}');
      return;
    }
    case 'href': {
      let url = g('target');
      let name = g('name');
      const type = g('type');
      if (!name) name = url;
      if (url) {
        url = url.replace(/\\(?!\\)/g, '%5C').replace(/%/g, '\\%').replace(/#/g, '\\#');
        if (!url.includes('://') && !type) url = 'http://' + url;
      }
      if (name) {
        name = literal ? name : escapeText(ctx, name).replace(/\\textasciitilde\{\}/g, '$\\sim$');
      }
      const full = type === 'mailto:' || type === 'file:' ? (url.startsWith(type) ? url : type + url) : url;
      ctx.features.require('hyperref');
      if (rp.movingArg) os.write('\\protect');
      os.write(`\\href{${full}}{${name}}`);
      return;
    }
    case 'include': latexInclude(ctx, os, rp, cmd, g); return;
    case 'bibtex': latexBibtex(ctx, os, rp, g); return;
    case 'toc': {
      const type = cmd === 'lstlistoflistings' ? 'lstlistoflistings' : cmd || 'tableofcontents';
      if (type === 'lstlistoflistings') { ctx.features.require('listings'); os.write(ctx.bp.useMinted ? '\\listoflistings{}' : '\\lstlistoflistings{}'); }
      else os.write(`\\${type}{}`);
      return;
    }
    case 'index_print': {
      const type = g('type') || 'idx';
      ctx.features.require('makeidx');
      if (!ctx.bp.useIndices) { if (type === 'idx') { os.write('\\printindex'); os.termcmd(); } return; }
      ctx.features.require('splitidx');
      os.write(`\\printindex[${type}]{}`);
      return;
    }
    case 'nomenclature': {
      ctx.features.require('nomencl');
      const prefix = g('prefix');
      const symbol = literal ? g('symbol') : escapeText(ctx, g('symbol'));
      const desc = literal ? g('description') : escapeText(ctx, g('description'));
      os.write('\\nomenclature' + (prefix ? `[${prefix}]` : '') + `{${symbol}}{${desc}}`);
      return;
    }
    case 'nomencl_print': {
      ctx.features.require('nomencl');
      const setWidth = g('set_width');
      if (setWidth === 'custom') { os.write(`\\printnomenclature[${latexLength(g('width'))}]`); os.termcmd(); return; }
      os.write('\\printnomenclature{}');
      return;
    }
    case 'line': {
      const offset = g('offset');
      os.write('\\rule');
      if (!isZeroLength(offset)) os.write(`[${latexLength(offset)}]`);
      os.write(`{${latexLength(g('width') || '100col%')}}{${latexLength(g('height') || '1pt')}}`);
      return;
    }
    case 'bibitem': {
      const key = g('key');
      const label = g('label');
      const lbl = label ? (literal ? label : escapeText(ctx, label)) : '';
      os.write('\\bibitem' + (lbl ? `[${protectArg(lbl)}]` : '') + `{${escapeLabel(key)}}`);
      return;
    }
    default:
      ctx.warnings.push(`unsupported command inset '${inset.arg}' (${cmd}) dropped`);
  }
  void pos;
}

function protectArg(s: string): string {
  return s.includes(']') ? `{${s}}` : s;
}

function escapeLabel(s: string): string {
  // HANDLING_ESCAPE: characters that would break a label are escaped by LyX with \string... we keep them
  return s;
}

function latexRef(ctx: ExportContext, os: TexStream, rp: RunParams, cmd: string, g: (k: string) => string): void {
  const refs = g('reference').split(',').map(r => r.trim()).filter(Boolean);
  if (refs.length > 1) {
    const range = g('tuple') === 'range';
    refs.forEach((r, i) => {
      if (i > 0) os.write(range ? '--' : i === refs.length - 1 ? ' and ' : ', ');
      latexRefOne(ctx, os, rp, i === 0 ? cmd : (cmd === 'formatted' || cmd === 'labelonly' ? 'ref' : cmd), (k) => (k === 'reference' ? r : g(k)));
    });
    return;
  }
  latexRefOne(ctx, os, rp, cmd, g);
}

function latexRefOne(ctx: ExportContext, os: TexStream, rp: RunParams, cmd: string, g: (k: string) => string): void {
  const ref = g('reference');
  const hyper = ctx.bp.pdf.useHyperref;
  const nolink = hyper && g('nolink') === 'true';
  const star = nolink ? '*' : '';
  const useRefstyle = ctx.bp.crossrefPackage === 'refstyle';
  if (rp.inulemcmd > 0) os.write('\\mbox{');
  if (rp.movingArg) os.write('\\protect');
  if (cmd === 'eqref' && useRefstyle) {
    os.write(`(\\ref${star}{${ref}})`);
  } else if (cmd === 'formatted') {
    const caps = g('caps') === 'true';
    const plural = g('plural') === 'true';
    const colon = ref.indexOf(':');
    let prefix = colon > 0 ? ref.slice(0, colon) : '';
    const label = colon > 0 ? ref.slice(colon + 1) : ref;
    if (ctx.bp.crossrefPackage === 'cleveref') {
      ctx.features.require('cleveref');
      os.write(`${caps ? '\\Cref' : '\\cref'}{${ref}}`);
    } else if (!useRefstyle || !prefix || !label || !/^[A-Za-z]+$/.test(prefix)) {
      if (!useRefstyle && prefix && label) {
        ctx.features.require('prettyref');
        if (prefix === 'chap') ctx.features.addPreambleSnippet('\\let\\pr@chap=\\pr@cha');
        os.write(`\\prettyref{${ref}}`);
      } else {
        if (useRefstyle) ctx.features.require('refstyle');
        os.write(`\\ref{${ref}}`);
      }
    } else {
      ctx.features.require('refstyle');
      if (caps) prefix = prefix[0].toUpperCase() + prefix.slice(1);
      const fcmd = `\\${prefix}ref`;
      if (prefix.toLowerCase() === 'cha') ctx.features.addPreambleSnippet('\\let\\charef=\\chapref');
      else ctx.features.addPreambleSnippet(`\\AtBeginDocument{\\providecommand${fcmd}[1]{\\ref{${prefix}:#1}}}`);
      os.write(fcmd + (plural ? '[s]' : '') + `{${label}}`);
    }
  } else if (cmd === 'labelonly') {
    if (g('noprefix') !== 'true') os.write(ref);
    else os.write(ref.includes(':') ? ref.slice(ref.indexOf(':') + 1) : ref);
  } else {
    if (cmd === 'vref' || cmd === 'vpageref') ctx.features.require('varioref');
    if (cmd === 'nameref') ctx.features.require('nameref');
    if (cmd === 'eqref') ctx.features.require('amsmath');
    os.write(`\\${cmd}${star}{${ref}}`);
  }
  if (rp.inulemcmd > 0) os.write('}');
}

function latexInclude(ctx: ExportContext, os: TexStream, rp: RunParams, cmd: string, g: (k: string) => string): void {
  const filename = g('filename').trim();
  if (!filename) { ctx.warnings.push('include inset without file name ignored'); return; }
  const isLyx = filename.toLowerCase().endsWith('.lyx');
  const texName = isLyx ? filename.slice(0, -4) + '.tex' : filename;
  // tex mode: a .tex child is read for the packages / macros it needs (its text is its own file)
  const isTexChild = ctx.texMode && !isLyx && (cmd === 'input' || cmd === 'include');
  switch (cmd) {
    case 'verbatiminput':
    case 'verbatiminput*':
      ctx.features.require('verbatim');
      os.write(`\\${cmd}{${filename}}`);
      return;
    case 'lstinputlisting': {
      ctx.features.require('listings');
      const params = g('lstparams');
      os.write('\\lstinputlisting' + (params ? `[${params}]` : '') + `{${filename}}`);
      return;
    }
    case 'inputminted': {
      ctx.features.require('minted');
      os.write(`\\inputminted{tex}{${filename}}`);
      return;
    }
    case 'input':
    case 'include': {
      if (isTexChild) {
        if (ctx.includeDepth <= 10) {
          const child = ctx.opts.resolveInclude?.(filename);
          const key = 'child:' + texName.replace(/\\/g, '/');
          if (child && !(key in ctx.files)) { ctx.files[key] = ''; exportChild(ctx, child, filename); delete ctx.files[key]; }
        }
      } else if (isLyx) {
        if (ctx.includeDepth > 10) { ctx.warnings.push(`include recursion too deep at ${filename}`); return; }
        const child = ctx.opts.resolveInclude?.(filename);
        if (!child) ctx.warnings.push(`child document '${filename}' could not be resolved; \\${cmd}{${texName}} written anyway`);
        else {
          const key = texName.replace(/\\/g, '/');
          if (!(key in ctx.files)) {
            ctx.files[key] = '';
            ctx.files[key] = exportChild(ctx, child, filename);
          }
        }
      }
      if (cmd === 'include') os.write(`\\include{${texName.replace(/\.tex$/, '')}}`);
      else os.write(`\\input{${texName}}`);
      return;
    }
    default:
      ctx.warnings.push(`unsupported include command '${cmd}'`);
      os.write(`\\input{${texName}}`);
  }
  void rp;
}

function latexBibtex(ctx: ExportContext, os: TexStream, rp: RunParams, g: (k: string) => string): void {
  const engine = ctx.bp.citeEngine;
  const biblatex = engine === 'biblatex' || engine === 'biblatex-natbib';
  let style = g('options');
  let bibtotoc = '';
  if (style.startsWith('bibtotoc')) {
    bibtotoc = 'bibtotoc';
    style = style.includes(',') ? style.slice(style.indexOf(',') + 1) : '';
  }
  const bibfiles = g('bibfiles').split(',').map(s => s.trim()).filter(Boolean);
  if (biblatex) {
    ctx.features.require('biblatex');
    for (const f of bibfiles) ctx.features.addPreambleSnippet(`\\addbibresource{${f.endsWith('.bib') ? f : f + '.bib'}}`);
    let opts = g('biblatexopts');
    if (bibtotoc) opts = opts ? 'heading=bibintoc,' + opts : 'heading=bibintoc';
    if (g('btprint') === 'btPrintAll') os.write('\\nocite{*}\n');
    os.write('\\printbibliography');
    if (opts) os.write(`[${opts}]`);
    os.write('\n');
    return;
  }
  if (style === 'default') style = ctx.bp.biblioStyle;
  if (style && !ctx.bp.useBibtopic) os.write(`\\bibliographystyle{${style.replace(/\.bst$/, '')}}\n`);
  if (bibfiles.length && ctx.bp.useBibtopic) {
    ctx.features.require('bibtopic');
    os.write('\\begin{btSect}' + (style ? `[${style}]` : '') + `{${bibfiles.join(',')}}\n`);
    os.write(`\\${g('btprint') || 'btPrintCited'}\n\\end{btSect}\n`);
  }
  if (bibtotoc && !ctx.bp.useBibtopic && !ctx.dc.bibInToc) {
    if (ctx.bp.pdf.useHyperref) os.write('\\phantomsection');
    if (ctx.dc.styles.has('Chapter')) os.write('\\addcontentsline{toc}{chapter}{\\bibname}');
    else if (ctx.dc.styles.has('Section')) os.write('\\addcontentsline{toc}{section}{\\refname}');
  }
  if (bibfiles.length && !ctx.bp.useBibtopic) {
    if (g('btprint') === 'btPrintAll') os.write('\\nocite{*}\n');
    os.write(`\\bibliography{${bibfiles.join(',')}}\n`);
  }
  void rp;
}
