/**
 * Character-level LaTeX output: escaping of special characters, Unicode
 * symbols (lib/unicodesymbols), font change commands and quotes.
 * Mirrors Paragraph::Private::latexSpecialChar, Font::latexWriteStartChanges
 * and InsetQuotes::latex.
 */
import type { FontState } from '../lyx/ast.ts';
import type { ExportContext, RunParams } from './context.ts';
import type { TexStream } from './stream.ts';
import { isForced } from './unicode.ts';

/* ------------------------------------------------------------ characters */

const EXTENDED_COLORS = new Set(['brown', 'darkgray', 'lightgray', 'lime', 'olive', 'orange', 'pink', 'purple', 'teal', 'violet', 'gray']);

/** Convert a non-ASCII character via lib/unicodesymbols. Returns undefined when it may pass through. */
export function unicodeCommand(ctx: ExportContext, code: number, inMath = false): { cmd: string; terminate: boolean; preamble: string } | undefined {
  const sym = ctx.unicode.get(code);
  if (ctx.encodingMode === 'plain') return undefined;
  let convert: boolean;
  if (ctx.encodingMode === 'utf8') {
    if (!sym) return undefined;
    // LyX only replaces forced symbols with utf8; we additionally convert
    // symbol blocks that inputenc's utf8 support does not cover.
    convert = isForced(sym, ctx.encodingName) || code >= 0x2100 || (code >= 0x2000 && code < 0x2010) || (code >= 0x2028 && code < 0x2100 && !(code >= 0x2030 && code <= 0x203a));
  } else {
    // legacy 8-bit encodings: our output is ASCII-only (LyX would write the
    // file in the legacy encoding), so convert whatever we can.
    if (!sym) return undefined;
    convert = true;
  }
  if (!convert) return undefined;
  if (inMath || !sym.textCommand) {
    if (sym.mathCommand) return { cmd: inMath ? sym.mathCommand : `\\ensuremath{${sym.mathCommand}}`, terminate: false, preamble: sym.mathPreamble };
    return undefined;
  }
  return { cmd: sym.textCommand, terminate: !sym.textNoTermination, preamble: sym.textPreamble };
}

function requirePreamble(ctx: ExportContext, preamble: string): void {
  if (!preamble) return;
  for (const alt of preamble.split('|')) {
    const p = alt.trim();
    if (!p) continue;
    if (p.startsWith('\\')) { ctx.features.addPreambleSnippet(p); return; }
    // "feature=enc1;enc2" → only for those encodings; we require unconditionally for the listed
    // encodings when ours is among them, otherwise skip.
    const eq = p.indexOf('=');
    if (eq > 0) {
      const name = p.slice(0, eq).replace(/!$/, '');
      const encs = p.slice(eq + 1).split(';');
      const neg = p[eq - 1] === '!';
      const hit = encs.includes(ctx.encodingName) || encs.includes(ctx.mainFontenc);
      if (neg ? !hit : hit) ctx.features.require(name);
      continue;
    }
    ctx.features.require(p);
    return;
  }
}

export interface CharContext {
  passThru: boolean;
  passThruChars: string;
  typewriter: boolean;
  next: string;   // next character ('' at end)
}

/** Write one text character with LaTeX escaping. */
export function latexChar(ctx: ExportContext, os: TexStream, rp: RunParams, c: string, cc: CharContext): void {
  if (cc.passThru || cc.passThruChars.includes(c) || rp.passThruChars.includes(c)) {
    if (c !== '\0') os.write(c);
    return;
  }
  const t1 = (ctx.mainFontenc === 'T1' || ctx.encodingMode === 'plain') && !rp.inIPA;
  if (t1) {
    switch (c) {
      case '<': case '>':
        os.write(c);
        if (cc.next === c) { os.write('\\textcompwordmark'); os.termcmd(); }
        return;
      case '|': os.write(c); return;
      case '"': os.write('\\textquotedbl'); os.termcmd(); return;
      default: break;
    }
  }
  if (rp.inIPA) {
    switch (c) {
      case '*': case '[': case ']': case '"': os.write(c); return;
      case '|': os.write('\\textvertline'); os.termcmd(); return;
      default: break;
    }
  }
  switch (c) {
    case '\\': os.write('\\textbackslash'); os.termcmd(); return;
    case '<': os.write('\\textless'); os.termcmd(); return;
    case '>': os.write('\\textgreater'); os.termcmd(); return;
    case '|': os.write('\\textbar'); os.termcmd(); return;
    case '-':
      os.write('-');
      if (cc.next === '-') os.write('{}');
      return;
    case '"': os.write('\\textquotedbl'); os.termcmd(); return;
    case '$': case '&': case '%': case '#': case '{': case '}': case '_':
      os.write('\\' + c); return;
    case '~': os.write('\\textasciitilde'); os.termcmd(); return;
    case '^': os.write('\\textasciicircum'); os.termcmd(); return;
    case '*': case '[': case ']': os.write('{' + c + '}'); return;
    case ' ': os.write(' '); return;
    default: break;
  }
  const code = c.codePointAt(0) ?? 0;
  if (code < 0x80) { os.write(c); return; }
  if ((code === 0x2013 || code === 0x2014) && ctx.bp.useDashLigatures && !cc.typewriter && !rp.inIPA && ctx.encodingMode !== 'plain') {
    os.write(code === 0x2013 ? '--' : '---');
    return;
  }
  const uc = unicodeCommand(ctx, code);
  if (!uc) {
    if (ctx.encodingMode === 'legacy' && !ctx.unicode.has(code)) ctx.warnings.push(`character U+${code.toString(16)} '${c}' not representable in encoding ${ctx.encodingName}; passed through`);
    os.write(c);
    return;
  }
  requirePreamble(ctx, uc.preamble);
  os.write(uc.cmd);
  if (uc.terminate) os.termcmd();
}

/** Escape a plain string for use in LaTeX text (labels, options, ...). */
export function escapeText(ctx: ExportContext, s: string): string {
  let out = '';
  for (const ch of s) {
    switch (ch) {
      case '\\': out += '\\textbackslash{}'; break;
      case '&': case '_': case '$': case '%': case '#': case '{': case '}': out += '\\' + ch; break;
      case '^': out += '\\^{}'; break;
      case '~': out += '\\textasciitilde{}'; break;
      default: {
        const code = ch.codePointAt(0) ?? 0;
        if (code >= 0x80) {
          const uc = unicodeCommand(ctx, code);
          if (uc) { requirePreamble(ctx, uc.preamble); out += uc.cmd + (uc.terminate ? '{}' : ''); break; }
        }
        out += ch;
      }
    }
  }
  return out;
}

/* ----------------------------------------------------------------- fonts */

const SIZE_CMDS: Record<string, string> = {
  tiny: 'tiny', scriptsize: 'scriptsize', footnotesize: 'footnotesize', small: 'small', normal: 'normalsize',
  large: 'large', larger: 'Large', largest: 'LARGE', huge: 'huge', giant: 'Huge',
};
const FAMILY_CMDS: Record<string, string> = { roman: 'textrm', sans: 'textsf', typewriter: 'texttt' };
const SERIES_CMDS: Record<string, string> = { medium: 'textmd', bold: 'textbf' };
const SHAPE_CMDS: Record<string, string> = { up: 'textup', italic: 'textit', slanted: 'textsl', smallcaps: 'textsc' };

export interface EffectiveFont {
  family?: string; series?: string; shape?: string; size?: string; color?: string;
  emph: boolean; noun: boolean; underbar: boolean; uuline: boolean; strikeout: boolean; xout: boolean; uwave: boolean;
  lang: string;
}

/** Reduce an item font against the layout base font; language defaults to `parLang`. */
export function effectiveFont(f: FontState, base: RunParams['baseFont'], parLang: string): EffectiveFont {
  const norm = (v: string | undefined, def: string) => (v === undefined || v === 'default' ? undefined : v === def ? undefined : v);
  const baseFamily = base.family ?? 'roman';
  const baseSeries = base.series ?? 'medium';
  const baseShape = base.shape ?? 'up';
  const baseSize = base.size ?? 'normal';
  return {
    family: norm(f.family, baseFamily), series: norm(f.series, baseSeries), shape: norm(f.shape, baseShape),
    size: norm(f.size, baseSize),
    color: f.color === undefined || f.color === 'none' || f.color === 'inherit' || f.color === 'default' ? undefined : f.color,
    emph: f.emph === 'on' || f.emph === 'toggle', noun: f.noun === 'on', underbar: f.bar === 'under',
    uuline: f.uuline === 'on', strikeout: f.strikeout === 'on', xout: f.xout === 'on', uwave: f.uwave === 'on',
    lang: f.lang ?? parLang,
  };
}

export function fontsEqualEff(a: EffectiveFont, b: EffectiveFont): boolean {
  return a.family === b.family && a.series === b.series && a.shape === b.shape && a.size === b.size && a.color === b.color
    && a.emph === b.emph && a.noun === b.noun && a.underbar === b.underbar && a.uuline === b.uuline && a.strikeout === b.strikeout
    && a.xout === b.xout && a.uwave === b.uwave && a.lang === b.lang;
}

export function isPlainFont(f: EffectiveFont, parLang: string): boolean {
  return !f.family && !f.series && !f.shape && !f.size && !f.color && !f.emph && !f.noun && !f.underbar && !f.uuline
    && !f.strikeout && !f.xout && !f.uwave && f.lang === parLang;
}

/** Babel name of a LyX language ('' if none). */
export function babelName(ctx: ExportContext, lang: string): string {
  if (!lang || lang === 'latex' || lang === 'ignore') return '';
  return ctx.langs.get(lang)?.babel ?? '';
}

export function polyglossiaName(ctx: ExportContext, lang: string): { name: string; opts: string } {
  const li = ctx.langs.get(lang);
  return { name: li?.polyglossia ?? '', opts: li?.polyglossiaOpts ?? '' };
}

/** Write the opening commands of a font change; returns the number of groups opened. */
export function openFont(ctx: ExportContext, os: TexStream, rp: RunParams, f: EffectiveFont, parLang: string): number {
  let count = 0;
  const w = (s: string) => { os.write(s); count++; };
  if (f.lang !== parLang) {
    const langInfo = ctx.langs.get(f.lang);
    if (ctx.usePolyglossia && langInfo?.polyglossia) {
      ctx.features.usedLanguages.set(f.lang, { babel: langInfo.babel, polyglossia: langInfo.polyglossia, polyglossiaOpts: langInfo.polyglossiaOpts });
      const opts = langInfo.polyglossiaOpts ? `[${langInfo.polyglossiaOpts}]` : '';
      w(`\\text${langInfo.polyglossia}${opts}{`);
    } else {
      const b = babelName(ctx, f.lang);
      if (b && b !== babelName(ctx, parLang)) {
        ctx.features.usedLanguages.set(f.lang, { babel: b, polyglossia: langInfo?.polyglossia ?? '', polyglossiaOpts: langInfo?.polyglossiaOpts ?? '' });
        w(`\\foreignlanguage{${b}}{`);
      }
      // "latex" language (pass-through text) needs no switch
    }
  }
  if (f.size) {
    const cmd = SIZE_CMDS[f.size];
    if (cmd) { os.write('{\\' + cmd); os.termcmd(); count++; }
  }
  if (f.family) { const cmd = FAMILY_CMDS[f.family]; if (cmd) w('\\' + cmd + '{'); }
  if (f.series) { const cmd = SERIES_CMDS[f.series]; if (cmd) w('\\' + cmd + '{'); }
  if (f.shape) { const cmd = SHAPE_CMDS[f.shape]; if (cmd) w('\\' + cmd + '{'); }
  if (f.color) {
    if (f.color.startsWith('#')) { ctx.features.require('xcolor'); w(`\\textcolor[HTML]{${f.color.slice(1).toUpperCase()}}{`); }   // custom colour (colour picker)
    else { ctx.features.require(EXTENDED_COLORS.has(f.color) ? 'xcolor' : 'color'); w(`\\textcolor{${f.color}}{`); }
  }
  if (f.emph) w('\\emph{');
  if (f.noun) { ctx.features.require('noun'); w('\\noun{'); }
  if (f.underbar) { ctx.features.require('ulem'); w('\\uline{'); rp.inulemcmd++; }
  if (f.uuline) { ctx.features.require('ulem'); w('\\uuline{'); rp.inulemcmd++; }
  if (f.strikeout) { ctx.features.require('ulem'); w('\\sout{'); rp.inulemcmd++; }
  if (f.xout) { ctx.features.require('ulem'); w('\\xout{'); rp.inulemcmd++; }
  if (f.uwave) { ctx.features.require('ulem'); if (rp.inulemcmd) os.write('\\ULdepth=1000pt'); w('\\uwave{'); rp.inulemcmd++; }
  return count;
}

export function closeFont(os: TexStream, rp: RunParams, f: EffectiveFont, count: number): void {
  for (let i = 0; i < count; i++) os.write('}');
  let ulem = 0;
  if (f.underbar) ulem++;
  if (f.uuline) ulem++;
  if (f.strikeout) ulem++;
  if (f.xout) ulem++;
  if (f.uwave) ulem++;
  rp.inulemcmd = Math.max(0, rp.inulemcmd - ulem);
}

/* ---------------------------------------------------------------- quotes */

type QuoteChars = [number, number, number, number]; // left primary, right primary, left secondary, right secondary

const QUOTE_STYLES: Record<string, QuoteChars> = {
  e: [0x201c, 0x201d, 0x2018, 0x2019], // english
  s: [0x201d, 0x201d, 0x2019, 0x2019], // swedish
  g: [0x201e, 0x201c, 0x201a, 0x2018], // german
  p: [0x201e, 0x201d, 0x201a, 0x2019], // polish
  c: [0x00ab, 0x00bb, 0x2039, 0x203a], // swiss
  a: [0x00bb, 0x00ab, 0x203a, 0x2039], // danish
  q: [0x0022, 0x0022, 0x0027, 0x0027], // plain
  b: [0x2018, 0x2019, 0x201c, 0x201d], // british
  w: [0x00bb, 0x00bb, 0x2019, 0x2019], // swedishg
  f: [0x00ab, 0x00bb, 0x201c, 0x201d], // french
  i: [0x00ab, 0x00bb, 0x00ab, 0x00bb], // frenchin
  r: [0x00ab, 0x00bb, 0x201e, 0x201c], // russian
  k: [0x300c, 0x300d, 0x300e, 0x300f], // cjk
  j: [0x300a, 0x300b, 0x3008, 0x3009], // cjkangle
  h: [0x201e, 0x201d, 0x00bb, 0x00ab], // hungarian
};

const STYLE_NAME_TO_CHAR: Record<string, string> = {
  english: 'e', swedish: 's', german: 'g', polish: 'p', swiss: 'c', danish: 'a', plain: 'q', british: 'b',
  swedishg: 'w', french: 'f', frenchin: 'i', russian: 'r', cjk: 'k', cjkangle: 'j', hungarian: 'h',
};

function latexQuote(c: number, op: 'babel' | 't1' | 'ot1' | 'int'): string {
  switch (c) {
    case 0x201a: return op === 'babel' ? '\\glq' : '\\quotesinglbase';
    case 0x2019: return op === 'int' ? '\\textquoteright' : "'";
    case 0x2018: return op === 'int' ? '\\textquoteleft' : '`';
    case 0x2039: return op === 'babel' ? '\\flq' : '\\guilsinglleft';
    case 0x203a: return op === 'babel' ? '\\frq' : '\\guilsinglright';
    case 0x0027: return '\\textquotesingle';
    case 0x201e: return op === 't1' ? ',,' : op === 'babel' ? '\\glqq' : '\\quotedblbase';
    case 0x201d: return op === 'int' ? '\\textquotedblright' : "''";
    case 0x201c: return op === 'int' ? '\\textquotedblleft' : '``';
    case 0x00ab: return op === 't1' ? '<<' : op === 'babel' ? '\\flqq' : '\\guillemotleft';
    case 0x00bb: return op === 't1' ? '>>' : op === 'babel' ? '\\frqq' : '\\guillemotright';
    case 0x0022: return '\\textquotedbl';
    case 0x300c: return '\\ensuremath{\\lceil}';
    case 0x300d: return '\\ensuremath{\\rfloor}';
    case 0x300e: return '\\ensuremath{\\llceil}';
    case 0x300f: return '\\ensuremath{\\rrfloor}';
    case 0x300a: return '\\ensuremath{\\langle\\kern-2.5pt\\langle}';
    case 0x300b: return '\\ensuremath{\\rangle\\kern-2.5pt\\rangle}';
    case 0x3008: return '\\ensuremath{\\langle}';
    case 0x3009: return '\\ensuremath{\\rangle}';
    default: return String.fromCodePoint(c);
  }
}

/** Write a Quotes inset (`arg` like "eld": style, side, level). */
export function latexQuotes(ctx: ExportContext, os: TexStream, rp: RunParams, arg: string): void {
  let style = arg[0] ?? 'e';
  const side = arg[1] ?? 'l';
  const level = arg[2] ?? 'd';
  if (style === 'x') style = STYLE_NAME_TO_CHAR[ctx.bp.quotesStyle] ?? 'e'; // dynamic
  const chars = QUOTE_STYLES[style] ?? QUOTE_STYLES.e;
  const primary = level === 'd';
  const c = primary ? (side === 'l' ? chars[0] : chars[1]) : (side === 'l' ? chars[2] : chars[3]);
  let qstr: string;
  if (rp.passThru) {
    qstr = primary ? '"' : "'";
  } else if (style === 'q' && ctx.encodingMode === 'plain') {
    qstr = primary ? '\\textquotedblplain' : '\\textquotesingleplain';
    ctx.features.require(primary ? 'textquotedblp' : 'textquotesinglep');
  } else if (ctx.usePolyglossia) {
    qstr = String.fromCodePoint(c);
  } else if (ctx.bp.pdf.useHyperref && rp.movingArg) {
    qstr = latexQuote(c, 'int');
  } else if (ctx.mainFontenc === 'T1') {
    qstr = latexQuote(c, 't1');
  } else if (!ctx.useBabel || (ctx.mainFontenc !== 'T1' && ctx.mainFontenc !== 'OT1') || ctx.encodingMode === 'plain') {
    qstr = latexQuote(c, 'ot1');
  } else {
    qstr = latexQuote(c, 'babel');
  }
  if (qstr.startsWith('\\')) {
    const name = qstr.slice(1);
    if (['quotesinglbase', 'quotedblbase', 'guilsinglleft', 'guilsinglright', 'guillemotleft', 'guillemotright', 'textquotedbl'].includes(name)) ctx.features.require(name);
  }
  if (!rp.passThru) {
    const last = os.last;
    if (qstr.startsWith('`') && (last === '!' || last === '?')) os.write('{}');
    if (",'`<>".includes(last) && last !== '' && qstr.startsWith(last)) os.write('{}');
  }
  os.write(qstr);
  if (qstr.startsWith('\\') && !qstr.endsWith('}')) os.termcmd();
}

/* --------------------------------------------------------- special chars */

/** \SpecialChar / \twohyphens / \threehyphens items. */
export function latexSpecialItem(ctx: ExportContext, os: TexStream, rp: RunParams, token: string, arg: string): void {
  if (token === '\\twohyphens') { os.write('--'); return; }
  if (token === '\\threehyphens') { os.write('---'); return; }
  if (token === '\\IPAChar') { os.write(arg); if (arg.startsWith('\\') && !arg.endsWith('}')) os.termcmd(); return; }
  const protect = rp.movingArg ? '\\protect' : '';
  switch (arg) {
    case 'softhyphen': case '\\-': os.write('\\-'); return;
    case 'allowbreak': ctx.features.require('lyxzerowidthspace'); os.write('\\LyXZeroWidthSpace'); os.termcmd(); return;
    case 'ligaturebreak': case '\\textcompwordmark{}':
      if (ctx.encodingMode === 'utf8' || ctx.encodingMode === 'plain') os.write('‌');
      else { os.write('\\textcompwordmark'); os.termcmd(); }
      return;
    case 'endofsentence': case '\\@.': os.write('\\@.'); return;
    case 'ldots': case '\\ldots{}': os.write('\\ldots'); os.termcmd(); return;
    case 'menuseparator': case '\\menuseparator': ctx.features.require('lyxarrow'); os.write('\\lyxarrow'); os.termcmd(); return;
    case 'breakableslash': case '\\slash{}': os.write('\\slash'); os.termcmd(); return;
    case 'nobreakdash': case '\\nobreakdash-': ctx.features.require('amsmath'); os.write(protect + '\\nobreakdash-'); return;
    case 'LyX': case '\\LyX{}': ctx.features.require('LyX'); os.write(protect + '\\LyX'); os.termcmd(); return;
    case 'TeX': case '\\TeX{}': os.write(protect + '\\TeX'); os.termcmd(); return;
    case 'LaTeX2e': case '\\LaTeXe{}': os.write(protect + '\\LaTeXe'); os.termcmd(); return;
    case 'LaTeX': case '\\LaTeX{}': os.write(protect + '\\LaTeX'); os.termcmd(); return;
    default:
      ctx.warnings.push(`unknown special char '${arg}'`);
      os.write(arg);
  }
}

/** asctime(gmtime(t)) formatting for change tracking. */
export function asctime(t: number): string {
  const d = new Date(t * 1000);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p2 = (n: number) => String(n).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, ' ');
  return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${day} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
}
