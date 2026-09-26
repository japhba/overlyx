/**
 * Math model → the LaTeX MathJax renders in the editor (client: editor/lyxmath/mathjax.ts).
 *
 * Every cell is wrapped in `\htmlClass{lm-c<id>}{…}` so the view can find the box of each cell in
 * MathJax's output, and (for the editor, `atoms: true`) every atom of a cell in `\htmlClass{lm-a}{…}`,
 * so that each atom has a box of its own — the cell wrapper's children, in order, are its atoms,
 * just like the MathRow LyX lays out from a MathData. `\htmlClass` is OverLyX's command: an mrow
 * with the class, which MathJax treats as transparent for the inter-atom spacing and bin
 * cancellation, so the rendering is unchanged; the glue between two atoms is a margin before the
 * second one. User macros with arguments are expanded from their definitions with the argument
 * cells wrapped too, so they stay editable in place. Constructs MathJax does not know are
 * approximated (see `sanitizeForMathjax`).
 */
import type { Atom, Cell, Grid, Hull, MacroTable } from './ast';
import { SYMBOLS } from './parse';
import { approximateImageSymbols, approximateOverlapSymbols, approximateRaisebox, replaceCommand } from '../macros';
import mathjaxMacrosTable from './mathjax-macros.json';

/** LyX predefined macros MathJax lacks, as macro definitions (scripts/gen-mathjax-macros.ts) */
const mathjaxTable = mathjaxMacrosTable as { macros: Record<string, string>; native: string[] };
export const MATHJAX_BASE_MACROS: Record<string, string> = Object.fromEntries(Object.entries(mathjaxTable.macros).map(([k, v]) => ['\\' + k, v]));
/** command names MathJax renders natively or via MATHJAX_BASE_MACROS */
const MATHJAX_KNOWN = new Set<string>([...mathjaxTable.native, ...Object.keys(mathjaxTable.macros)]);

export interface CellRef { id: number; owner: Atom | Hull; idx: number }

export interface TexContext {
  macros: MacroTable;
  /** registry of rendered cells, index = cell id */
  cells: CellRef[];
  /** `true` while rendering a macro's expansion template (its cells are not editable) */
  inTemplate?: boolean;
  /** `true` in a display hull: big operators carry their scripts above/below by default */
  display?: boolean;
  /** wrap every atom of an editable cell in `\htmlClass{lm-a}{…}` (the editor measures them) */
  atoms?: boolean;
}

/** Operators whose scripts sit above/below in display style (LaTeX \displaylimits default). */
const LIMIT_OPS = new Set(['sum', 'prod', 'coprod', 'bigcap', 'bigcup', 'bigodot', 'bigoplus', 'bigotimes', 'bigsqcup', 'biguplus', 'bigvee', 'bigwedge', 'lim', 'liminf', 'limsup', 'max', 'min', 'sup', 'inf', 'det', 'gcd', 'Pr', 'injlim', 'projlim', 'varinjlim', 'varprojlim', 'varliminf', 'varlimsup'])

const CELL_CLASS = 'lm-c';
/** class of the wrapper around every atom of an editable cell (see `TexContext.atoms`) */
export const ATOM_CLASS = 'lm-a';

function cellId(ctx: TexContext, owner: Atom | Hull, idx: number): number {
  ctx.cells.push({ id: ctx.cells.length, owner, idx });
  return ctx.cells.length - 1;
}

/** the box of an empty cell (LyX draws one): a blank of the size of a lower-case letter, drawn by the CSS of `lm-empty` */
export const EMPTY_CELL = '\\Space{0.5em}{0.65em}{0.1em}';

/** wrap a cell's content: `\htmlClass{lm-c<id>}{…}`; empty cells get a visible box */
export function cellToTex(cell: Cell, ctx: TexContext, owner: Atom | Hull, idx: number, mode: 'math' | 'text' = 'math'): string {
  if (ctx.inTemplate) return atomsToTex(cell, ctx, mode);
  const id = cellId(ctx, owner, idx);
  const body = atomsToTex(cell, ctx, mode);
  return cell.length ? `\\htmlClass{${CELL_CLASS}${id}}{${body}}` : `\\htmlClass{${CELL_CLASS}${id} lm-empty}{${EMPTY_CELL}}`;
}

const SPACES: Record<string, string> = {
  ',': '\\,', ':': '\\:', ';': '\\;', '!': '\\!', quad: '\\quad', qquad: '\\qquad', thinspace: '\\,', medspace: '\\:', thickspace: '\\;',
  negthinspace: '\\!', negmedspace: '\\negmedspace', negthickspace: '\\negthickspace', enskip: '\\enspace', enspace: '\\enspace', hfill: '\\quad',
  lyxposspace: '\\,', lyxnegspace: '\\!', '~': '\\ ', ' ': '\\ ', 'hspace*{\\fill}': '\\quad',
};

const DECO_MAP: Record<string, string> = { underbar: '\\underline', undertilde: '\\underset{\\sim}', utilde: '\\underset{\\sim}' };

function escapeText(s: string): string {
  return s.replace(/[\\{}$&#%_^~]/g, c => (c === '\\' ? '\\textbackslash ' : c === '~' ? '\\textasciitilde ' : c === '^' ? '\\textasciicircum ' : '\\' + c));
}

function charToTex(c: string, mode: 'math' | 'text'): string {
  if (mode === 'text') return escapeText(c);
  switch (c) {
    case '{': case '}': case '$': case '&': case '#': case '%': case '_': return '\\' + c;
    case '\\': return '\\backslash ';
    case '^': return '\\hat{}';
    case '~': return '\\sim ';
    case ' ': return '\\ ';
    default: return c;
  }
}

const TEXT_OK = new Set<Atom['t']>(['char', 'space', 'kern', 'font', 'box', 'color', 'ref', 'hash', 'comment', 'raw', 'unknown', 'cmd', 'brace', 'oldfont', 'style', 'href']);

export function atomsToTex(cell: Cell, ctx: TexContext, mode: 'math' | 'text' = 'math'): string {
  let out = '';
  let prevCmd = false;   // a control word was emitted: separate from following letters
  const wrap = !!ctx.atoms && !ctx.inTemplate;
  for (const a of cell) {
    // inside \text{}: math constructs (scripts, symbols, \ensuremath …) are rendered as inline math
    let s = mode === 'text' && !TEXT_OK.has(a.t) ? '$' + atomToTex(a, ctx, 'math') + '$' : atomToTex(a, ctx, mode);
    if (wrap) s = `\\htmlClass{${ATOM_CLASS}}{${s}}`;
    else if (prevCmd && /^[A-Za-z]/.test(s)) out += ' ';
    out += s;
    prevCmd = /\\[A-Za-z]+$/.test(s);
  }
  return out;
}

const braced = (c: Cell, ctx: TexContext, owner: Atom, idx: number, mode: 'math' | 'text' = 'math') => '{' + cellToTex(c, ctx, owner, idx, mode) + '}';

export function atomToTex(a: Atom, ctx: TexContext, mode: 'math' | 'text'): string {
  switch (a.t) {
    case 'char': return charToTex(a.c, mode);
    case 'sym': {
      if (mode === 'text') { const e = SYMBOLS[a.n]; return e?.u ? escapeText(e.u) : `\\textbackslash ${a.n}`; }
      const lim = a.limits ? '\\' + a.limits : '';
      if (a.n === 'adots') return '\\iddots';
      if (!MATHJAX_KNOWN.has(a.n) && /^[A-Za-z]+\*?$/.test(a.n)) { const e = SYMBOLS[a.n]; return e?.u ? `\\htmlClass{lm-unknown}{\\text{${escapeText(e.u)}}}` : `\\htmlClass{lm-unknown}{\\text{\\textbackslash ${escapeText(a.n)}}}`; }
      return '\\' + a.n + lim;
    }
    case 'space': {
      if (a.len !== undefined) return `\\htmlClass{lm-sp}{\\hspace{${a.len}}}`;
      return `\\htmlClass{lm-sp}{${SPACES[a.n] ?? '\\,'}}`;
    }
    case 'kern': return `\\htmlClass{lm-sp}{\\${a.n}${a.len}}`;
    case 'script': {
      const nuc = cellToTex(a.nuc, ctx, a, 0);
      // The cell markup (\htmlClass{lm-cN}{…}) hides the operator inside the nucleus from TeX's
      // limits rule, and MathJax then hangs the scripts to the right — even for \underbrace or a
      // display \sum. \mathop{…}\limits restores the above/below placement wherever LaTeX would use it.
      const one = a.nuc.length === 1 ? a.nuc[0] : null;
      const wantLimits = a.limits !== 'nolimits' && (a.limits === 'limits' || (one && (
        (one.t === 'deco' && (one.n === 'underbrace' || one.n === 'overbrace'))
        || (one.t === 'sym' && one.limits !== 'nolimits' && (one.limits === 'limits' || (!!ctx.display && LIMIT_OPS.has(one.n)))))));
      // Scripts on a macro whose expansion ends in scripts of its own (\q := q_{a}, typed \q^x_y):
      // TeX — and the PDF — hang the new x and y to the right of the whole q_a. On screen the new
      // scripts join the macro's: x above q, y appended to a, so nothing dangles off to the side.
      if (one && one.t === 'macro' && (a.up || a.down) && !wantLimits && !a.limits) {
        const merged = mergeScriptsIntoMacro(nuc, a, ctx);
        if (merged !== null) return merged;
      }
      let s = a.nuc.length ? nuc : '{' + nuc + '}';
      if (wantLimits) s = `\\mathop{${s}}\\limits`;
      else if (a.limits) s += '\\' + a.limits;
      if (a.up) s += '^' + braced(a.up, ctx, a, a.up && a.down ? 1 : 1);
      if (a.down) s += '_' + braced(a.down, ctx, a, a.up ? 2 : 1);
      return s;
    }
    case 'frac': {
      const c0 = braced(a.c0, ctx, a, 0), c1 = braced(a.c1, ctx, a, 1);
      switch (a.kind) {
        case 'frac': case 'dfrac': case 'tfrac': case 'cfrac': case 'binom': case 'dbinom': case 'tbinom': return `\\${a.kind}${c0}${c1}`;
        case 'cfracleft': return `\\cfrac[l]${c0}${c1}`;
        case 'cfracright': return `\\cfrac[r]${c0}${c1}`;
        case 'over': return `\\frac${c0}${c1}`;
        case 'atop': return `{${c0}\\atop ${c1}}`;
        case 'choose': return `\\binom${c0}${c1}`;
        case 'brace': return `{${c0}\\brace ${c1}}`;
        case 'brack': return `{${c0}\\brack ${c1}}`;
        case 'nicefrac': return `\\nicefrac${c0}${c1}`;
        case 'unitfrac': return `\\nicefrac[\\mathrm]${c0}${c1}` + (a.c2 ? `\\,${braced(a.c2, ctx, a, 2, 'text')}` : '');
        case 'unit': return `${c0}\\,\\text{${cellToTex(a.c1, ctx, a, 1, 'text')}}`;
        default: return `\\frac${c0}${c1}`;
      }
    }
    case 'sqrt': return a.index ? `\\sqrt[${cellToTex(a.index, ctx, a, 1)}]${braced(a.body, ctx, a, 0)}` : `\\sqrt${braced(a.body, ctx, a, 0)}`;
    case 'delim': return `\\left${delimToTex(a.l)}${cellToTex(a.body, ctx, a, 0)}\\right${delimToTex(a.r)}`;
    case 'big': {
      const n = a.n.replace(/^(big|Big|bigg|Bigg)gg?/, '$1');
      return `\\${n}${a.d.startsWith('\\') ? a.d + ' ' : a.d === '{' ? '\\{' : a.d === '}' ? '\\}' : a.d}`;
    }
    case 'brace': return `{${cellToTex(a.body, ctx, a, 0, mode)}}`;
    case 'font': {
      const n = FONT_MAP[a.n] ?? a.n;
      const inner = cellToTex(a.body, ctx, a, 0, a.mode);
      if (a.mode === 'text' && mode === 'text' && (n === 'text' || n === 'textnormal')) return `{${inner}}`;
      return `\\${n}{${inner}}`;
    }
    case 'oldfont': return `{\\${a.n} ${cellToTex(a.body, ctx, a, 0, mode)}}`;
    case 'box': {
      const n = a.n === 'tag' || a.n === 'tag*' || a.n === 'intertext' ? 'text' : a.n;
      return `\\${n}{${cellToTex(a.body, ctx, a, 0, a.n === 'boxed' ? 'math' : 'text')}}`;
    }
    case 'makebox': return `\\text{${cellToTex(a.body, ctx, a, 2, 'text')}}`;
    case 'deco': {
      const n = DECO_MAP[a.n] ?? '\\' + a.n;
      return `${n}{${cellToTex(a.body, ctx, a, 0)}}` + (a.limits ? '\\' + a.limits : '');
    }
    case 'style': return `{\\${a.n} ${cellToTex(a.body, ctx, a, 0, mode)}}`;
    case 'class': {
      const n = a.n === 'bm' || a.n === 'heavysymbol' ? 'boldsymbol' : a.n === 'lefteqn' ? 'mathrlap' : a.n;
      return `\\${n}{${cellToTex(a.body, ctx, a, 0)}}` + (a.limits ? '\\' + a.limits : '');
    }
    case 'color': return a.old ? (a.color === 'normalcolor' ? `{\\htmlClass{lm-normalcolor}{${cellToTex(a.body, ctx, a, 0, mode)}}}` : `{\\color{${a.color}}${cellToTex(a.body, ctx, a, 0, mode)}}`) : `\\textcolor{${a.color}}{${cellToTex(a.body, ctx, a, 0, 'text')}}`;
    case 'phantom': { const n = a.n === 'smasht' ? 'smash[t]' : a.n === 'smashb' ? 'smash[b]' : a.n; return `\\${n}{${cellToTex(a.body, ctx, a, 0)}}`; }
    case 'ensuremath': return `{${cellToTex(a.body, ctx, a, 0, 'math')}}`;
    case 'overset': case 'underset': return `\\${a.t}{${cellToTex(a.top, ctx, a, 1)}}{${cellToTex(a.body, ctx, a, 0)}}`;
    case 'stackrel': return `\\stackrel{${cellToTex(a.top, ctx, a, 1)}}{${cellToTex(a.body, ctx, a, 0)}}`;
    case 'xarrow': return `\\${a.n}${a.opt ? `[${cellToTex(a.opt, ctx, a, 1)}]` : ''}{${cellToTex(a.body, ctx, a, 0)}}`;
    case 'ref': return `\\htmlClass{lm-ref}{\\text{${escapeText(a.label)}}}`;
    // drawn as a link (styles.css .lm-href), not MathJax's \href: a click in the editor edits, ⌘/Ctrl+click follows it
    case 'href': return `\\htmlClass{lm-href}{${cellToTex(a.body, ctx, a, 0, mode)}}`;
    case 'grid': return gridToTex(a, ctx, mode);
    case 'macro': return macroToTex(a, ctx, mode);
    case 'cmd': {
      const n = CMD_MAP[a.n];
      if (n !== undefined) return n;
      if (a.n.length === 1 && !/[A-Za-z]/.test(a.n)) return '\\' + a.n;
      return `\\htmlClass{lm-unknown}{\\text{\\textbackslash ${escapeText(a.n)}}}` + (a.limits ? '' : '');
    }
    case 'hash': return `\\htmlClass{lm-arg}{\\text{${escapeText(a.n)}}}`;
    case 'comment': return `\\htmlClass{lm-comment}{\\text{\\%${escapeText(a.text)}}}`;
    case 'env': return `\\htmlClass{lm-unknown}{\\text{\\textbackslash begin\\{${escapeText(a.n)}\\}}}${cellToTex(a.body, ctx, a, 0, mode)}\\htmlClass{lm-unknown}{\\text{\\textbackslash end\\{${escapeText(a.n)}\\}}}`;
    case 'raw': return a.latex;
    case 'unknown': {
      // a command name being typed: green once it is a valid command, with the completion LyX would offer in grey
      const cls = 'lm-mm' + (a.final ? '' : a.valid ? ' lm-mm-ok' : ' lm-mm-typing');
      return `\\htmlClass{${cls}}{\\texttt{${escapeText(a.n)}}}` + (!a.final && a.hint ? `\\htmlClass{lm-mm-hint}{\\texttt{${escapeText(a.hint)}}}` : '');
    }
  }
}

const FONT_MAP: Record<string, string> = { frak: 'mathfrak', mathds: 'mathbb', textmd: 'text', textup: 'textup', noun: 'textsc', emph: 'textit', textipa: 'text', ce: 'text', cf: 'text' };
const CMD_MAP: Record<string, string> = { textbackslash: '\\textbackslash ', textasciicircum: '\\textasciicircum ', textasciitilde: '\\textasciitilde ', '{': '\\{', '}': '\\}', '_': '\\_', '&': '\\&', '#': '\\#', '$': '\\$', '%': '\\%', ' ': '\\ ', label: '', nonumber: '', notag: '', limits: '', nolimits: '' };

/** a delimiter of \left / \right (stmaryrd's \llangle, \llbracket … are MathJax delimiters too: mathjax-tex.ts) */
function delimToTex(name: string): string {
  if (name === '.') return '.';
  if (name.length === 1) return '<([)]/|>'.includes(name) ? name : name === '{' || name === '}' ? '\\' + name : name;
  return '\\' + name + ' ';
}

function gridToTex(g: Grid & { t: 'grid' }, ctx: TexContext, mode: 'math' | 'text'): string {
  const rows = g.rows.map((r, ri) => r.cells.map((c, ci) => cellToTex(c, ctx, g, ri * g.ncols + ci, g.env === 'tabular' ? 'text' : mode)).join(' & ')).join(' \\\\ ');
  switch (g.env) {
    case 'cases': return `\\begin{cases}${rows}\\end{cases}`;
    case 'substack': return `\\substack{${rows}}`;
    case 'array': case 'subarray': case 'tabular': return `\\begin{array}{${g.halign ?? 'c'.repeat(g.ncols)}}${rows}\\end{array}`;
    case 'align': return `\\begin{aligned}${rows}\\end{aligned}`;
    case 'lgathered': case 'rgathered': return `\\begin{gathered}${rows}\\end{gathered}`;
    case 'alignedat': return `\\begin{alignedat}{${Math.floor((g.ncols + 1) / 2)}}${rows}\\end{alignedat}`;
    case 'smallmatrix': case 'psmatrix': return `\\begin{smallmatrix}${rows}\\end{smallmatrix}`;
    case 'CD': return `\\begin{CD}${rows}\\end{CD}`;
    default: return `\\begin{${g.env}}${rows}\\end{${g.env}}`;
  }
}

/**
 * The trailing `^{…}` / `_{…}` (or `^x`, `_\alpha`) of a TeX string, split off: `q_{a}` →
 * { base: 'q', down: 'a' }. Null when the string does not end in a script. Braces escaped with a
 * backslash are literal.
 */
export function splitTrailingScripts(s: string): { base: string; up?: string; down?: string } | null {
  let rest = s.trimEnd();
  let up: string | undefined, down: string | undefined;
  const escaped = (i: number) => { let n = 0; for (let j = i - 1; j >= 0 && rest[j] === '\\'; j--) n++; return n % 2 === 1; };
  for (let round = 0; round < 2; round++) {
    let arg: string, cut: number;
    if (rest.endsWith('}') && !escaped(rest.length - 1)) {
      let depth = 0, i = rest.length - 1;
      for (; i >= 0; i--) {
        const c = rest[i];
        if (c === '}' && !escaped(i)) depth++;
        else if (c === '{' && !escaped(i)) { depth--; if (depth === 0) break; }
      }
      if (i <= 0) break;
      arg = rest.slice(i + 1, -1); cut = i;
    } else {
      const m = /(\\[A-Za-z]+|[^\\{}^_\s])\s*$/.exec(rest);
      if (!m || m.index === 0) break;
      arg = m[1]; cut = m.index;
    }
    const before = rest.slice(0, cut).trimEnd();
    const op = before[before.length - 1];
    if ((op !== '^' && op !== '_') || escaped(before.length - 1)) break;
    if (op === '^') { if (up !== undefined) break; up = arg; } else { if (down !== undefined) break; down = arg; }
    rest = before.slice(0, -1).trimEnd();
    if (!rest) return null;
  }
  if (up === undefined && down === undefined) return null;
  return { base: rest, up, down };
}

/** The nucleus markup of a script atom around a macro, with the macro's own trailing scripts merged with the atom's (see the 'script' case). */
function mergeScriptsIntoMacro(nuc: string, a: Atom & { t: 'script' }, ctx: TexContext): string | null {
  // the nucleus cell holds the macro alone — in the editable field (ctx.atoms) inside its atom marker
  const plain = /^(\\htmlClass\{lm-c\d+\}\{\\htmlClass\{lm-macro\}\{)([\s\S]*)\}\}$/.exec(nuc);
  const marked = plain ? null : /^(\\htmlClass\{lm-c\d+\}\{\\htmlClass\{lm-a\}\{\\htmlClass\{lm-macro\}\{)([\s\S]*)\}\}\}$/.exec(nuc);
  const m = plain ?? marked;
  if (!m) return null;
  const split = splitTrailingScripts(m[2]);
  if (!split || !split.base) return null;
  const own = (s: string | undefined) => (s === undefined ? '' : `\\htmlClass{lm-macro}{${s}}`);
  const up = own(split.up) + (a.up ? cellToTex(a.up, ctx, a, 1) : '');
  const down = own(split.down) + (a.down ? cellToTex(a.down, ctx, a, a.up ? 2 : 1) : '');
  let s = `${m[1]}${split.base}}}${marked ? '}' : ''}`;
  if (up) s += `^{${up}}`;
  if (down) s += `_{${down}}`;
  return s;
}

/** Expand a user macro: the definition with `#k` replaced by the (editable) argument cells. */
function macroToTex(a: Atom & { t: 'macro' }, ctx: TexContext, mode: 'math' | 'text'): string {
  const info = ctx.macros[a.n];
  const args = a.args.map((c, i) => cellToTex(c, ctx, a, i, mode));
  const id = ctx.cells.length;
  if (!info || !info.def) {
    // no definition: show the name with its arguments
    return `\\htmlClass{lm-macro}{\\htmlClass{lm-unknown}{\\text{\\textbackslash ${escapeText(a.n)}}}${args.map(s => `\\{${s}\\}`).join('')}}`;
  }
  const def = sanitizeForMathjax(info.def, a.n, a.args.length);
  const nopt = info.nopt ?? 0;
  let body = def;
  // template: arguments are substituted as already-wrapped cells; the rest renders non-editable
  body = body.replace(/#(\d)/g, (_m, d) => { const k = Number(d) - 1; return k < args.length ? `{${args[k]}}` : ''; });
  void nopt; void id;
  return `\\htmlClass{lm-macro}{${body}}`;
}

const unmath = (s: string) => { const t = s.trim(); const m = /^\$([\s\S]*)\$$/.exec(t); return m ? m[1] : t; };

/**
 * MathJax cannot render some TeX internals / text-mode constructs used in macro definitions:
 * rewrite the common ones into a visual approximation, else show the macro name.
 */
export function sanitizeForMathjax(def: string, name: string, args: number): string {
  let d = def.replace(/\r?\n\s*/g, ' ');
  d = replaceCommand(d, 'scalebox', c => `{${unmath(c)}}`, 2);
  d = replaceCommand(d, 'resizebox', c => `{${unmath(c)}}`, 3);
  d = replaceCommand(d, 'rotatebox', c => `{${unmath(c)}}`, 2);
  d = replaceCommand(d, 'raisebox', approximateRaisebox, 2);
  d = replaceCommand(d, 'vbox', c => `{${c}}`);
  d = replaceCommand(d, 'ensuremath', c => `{${c}}`);
  d = replaceCommand(d, 'accentset', (c, o) => `\\overset{${o[0] ?? ''}}{${c}}`, 2);
  d = replaceCommand(d, 'bm', c => `\\boldsymbol{${c}}`);
  d = replaceCommand(d, 'mathds', c => `\\mathbb{${c}}`);
  d = replaceCommand(d, 'intertext', c => `\\text{${c}}`);
  d = replaceCommand(d, 'DeclareMathOperator', () => '', 2);
  // The paper's double-glyph helper overlays two symbols with TeX boxes. Reproduce its
  // fractional horizontal shift with a calibrated negative kern.
  d = replaceCommand(d, 'OverlapSymbols', approximateOverlapSymbols, 3);
  // \includegraphics is OverLyX's MathJax command (an image glyph); the client resolves the file
  // name to the authenticated project graphics endpoint, which also converts PDF/SVG for the browser.
  d = approximateImageSymbols(d);
  // \mathchoice with its four arguments as adjacent groups
  d = replaceCommand(d, 'mathchoice', (last, args) => '\\mathchoice' + [...args, last].map(value => `{${value}}`).join(''), 4);
  if (/\\includegraphics\b/.test(d)) {
    d = d.replace(/\\normalfont\b/g, '');
    d = replaceCommand(d, 'text', c => /\\includegraphics\b/.test(c) ? `{${c}}` : `\\text{${c}}`);
  }
  d = d.replace(/\\relax\b/g, '');
  if (/\\(includesvg|sbox|usebox|ooalign|mathpalette|fontcharht|fontdimen|csname|expandafter|noexpand|@|def\b|let\b|newcommand|renewcommand)/.test(d)) {
    let f = `\\mathrm{${name}}`;
    for (let k = 1; k <= args; k++) f += `\\{#${k}\\}`;
    return f;
  }
  return d;
}

/**
 * The macros of a document's formulas for the renderer: the document's argument-less macros.
 * Macro tables are shared by all formulas of a document (see the client's macrotable.ts), so the
 * converted table is cached per table object — building it is far more expensive than rendering
 * a typical inline formula.
 */
const mathjaxMacroCache = new WeakMap<MacroTable, Record<string, string>>();
const sanitizedCache = new Map<string, string>();
export function mathjaxMacros(table: MacroTable): Record<string, string> {
  const hit = mathjaxMacroCache.get(table);
  if (hit) return hit;
  // (LyX's own, MATHJAX_BASE_MACROS, are the input jax's)
  const out: Record<string, string> = {};
  for (const [name, info] of Object.entries(table)) {
    if (!/^[A-Za-z]+$/.test(name)) continue;
    if (info.def === undefined) continue;
    if (info.nargs === 0) {
      const k = name + '\0' + info.def;
      let s = sanitizedCache.get(k);
      if (s === undefined) { s = sanitizeForMathjax(info.def, name, 0); if (sanitizedCache.size > 5000) sanitizedCache.clear(); sanitizedCache.set(k, s); }
      out['\\' + name] = s;
    }
  }
  mathjaxMacroCache.set(table, out);
  return out;
}

/** The hull as TeX for MathJax (display environments become their inner AMS equivalents). */
export function hullToTex(h: Hull, ctx: TexContext): string {
  ctx.display = !(h.type === 'simple' || h.type === 'none' || h.type === 'unknown');
  const cell = (ri: number, ci: number) => cellToTex(h.rows[ri].cells[ci], ctx, h, ri * h.ncols + ci);
  switch (h.type) {
    case 'simple': case 'equation': case 'none': case 'unknown':
      return cell(0, 0);
    case 'eqnarray': {
      // as LaTeX's eqnarray: the middle column is {}…{}, so a relation there is spaced on both sides
      const rows = h.rows.map((r, ri) => r.cells.map((_c, ci) => (ci === 1 ? '\\displaystyle{}' + cell(ri, ci) + '{}' : '\\displaystyle ' + cell(ri, ci))).join(' & ')).join(' \\\\ ');
      return `\\begin{array}{rcl}${rows}\\end{array}`;
    }
    case 'align': case 'flalign': {
      const rows = h.rows.map((r, ri) => r.cells.map((_c, ci) => cell(ri, ci)).join(' & ')).join(' \\\\ ');
      return `\\begin{aligned}${rows}\\end{aligned}`;
    }
    case 'alignat': case 'xalignat': case 'xxalignat': {
      const rows = h.rows.map((r, ri) => r.cells.map((_c, ci) => cell(ri, ci)).join(' & ')).join(' \\\\ ');
      return `\\begin{alignedat}{${Math.floor((h.ncols + 1) / 2)}}${rows}\\end{alignedat}`;
    }
    case 'gather': case 'multline': {
      const rows = h.rows.map((_r, ri) => cell(ri, 0)).join(' \\\\ ');
      return `\\begin{gathered}${rows}\\end{gathered}`;
    }
  }
}

/** Render a whole hull: the TeX source and the cell registry (`atoms`: wrap every atom, for the editor). */
export function renderHullSource(h: Hull, macros: MacroTable, opts: { atoms?: boolean } = {}): { latex: string; cells: CellRef[] } {
  const ctx: TexContext = { macros, cells: [], atoms: !!opts.atoms };
  const latex = hullToTex(h, ctx);
  return { latex, cells: ctx.cells };
}
