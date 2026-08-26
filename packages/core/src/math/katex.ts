/**
 * Math model → KaTeX LaTeX for rendering in the editor.
 *
 * Every cell is wrapped in `\htmlClass{lm-c<id>}{…}` so the view can find the box of each cell
 * (and of each atom inside it) in KaTeX's output; user macros with arguments are expanded from
 * their definitions with the argument cells wrapped too, so they stay editable in place.
 * Constructs KaTeX does not know are approximated (see `sanitizeForKatex`).
 */
import type { Atom, Cell, Grid, Hull, MacroTable } from './ast';
import { SYMBOLS } from './parse';
import { readGroup } from '../macros';
import katexMacrosTable from './katex-macros.json';

/** LyX predefined macros KaTeX lacks, as KaTeX `macros` entries */
const katexTable = katexMacrosTable as { macros: Record<string, string>; native: string[] };
export const KATEX_BASE_MACROS: Record<string, string> = Object.fromEntries(Object.entries(katexTable.macros).map(([k, v]) => ['\\' + k, v]));
/** command names KaTeX renders natively or via KATEX_BASE_MACROS */
const KATEX_KNOWN = new Set<string>([...katexTable.native, ...Object.keys(katexTable.macros)]);

export interface CellRef { id: number; owner: Atom | Hull; idx: number }

export interface KatexContext {
  macros: MacroTable;
  /** registry of rendered cells, index = cell id */
  cells: CellRef[];
  /** `true` while rendering a macro's expansion template (its cells are not editable) */
  inTemplate?: boolean;
}

const CELL_CLASS = 'lm-c';

function cellId(ctx: KatexContext, owner: Atom | Hull, idx: number): number {
  ctx.cells.push({ id: ctx.cells.length, owner, idx });
  return ctx.cells.length - 1;
}

/** wrap a cell's content: `\htmlClass{lm-c<id>}{…}`; empty cells get a visible box */
export function cellToKatex(cell: Cell, ctx: KatexContext, owner: Atom | Hull, idx: number, mode: 'math' | 'text' = 'math'): string {
  if (ctx.inTemplate) return atomsToKatex(cell, ctx, mode);
  const id = cellId(ctx, owner, idx);
  const body = atomsToKatex(cell, ctx, mode);
  return `\\htmlClass{${CELL_CLASS}${id}${cell.length ? '' : ' lm-empty'}}{${body}}`;
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

function charToKatex(c: string, mode: 'math' | 'text'): string {
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

const TEXT_OK = new Set<Atom['t']>(['char', 'space', 'kern', 'font', 'box', 'color', 'ref', 'hash', 'comment', 'raw', 'unknown', 'cmd', 'brace', 'oldfont', 'style']);

export function atomsToKatex(cell: Cell, ctx: KatexContext, mode: 'math' | 'text' = 'math'): string {
  let out = '';
  let prevCmd = false;   // a control word was emitted: separate from following letters
  for (const a of cell) {
    // inside \text{}: math constructs (scripts, symbols, \ensuremath …) are rendered as inline math
    const s = mode === 'text' && !TEXT_OK.has(a.t) ? '$' + atomToKatex(a, ctx, 'math') + '$' : atomToKatex(a, ctx, mode);
    if (prevCmd && /^[A-Za-z]/.test(s)) out += ' ';
    out += s;
    prevCmd = /\\[A-Za-z]+$/.test(s);
  }
  return out;
}

const braced = (c: Cell, ctx: KatexContext, owner: Atom, idx: number, mode: 'math' | 'text' = 'math') => '{' + cellToKatex(c, ctx, owner, idx, mode) + '}';

export function atomToKatex(a: Atom, ctx: KatexContext, mode: 'math' | 'text'): string {
  switch (a.t) {
    case 'char': return charToKatex(a.c, mode);
    case 'sym': {
      if (mode === 'text') { const e = SYMBOLS[a.n]; return e?.u ? escapeText(e.u) : `\\textbackslash ${a.n}`; }
      const lim = a.limits ? '\\' + a.limits : '';
      if (a.n === 'iddots' || a.n === 'adots') return '\\ddots';
      if (!KATEX_KNOWN.has(a.n) && /^[A-Za-z]+\*?$/.test(a.n)) { const e = SYMBOLS[a.n]; return e?.u ? `\\htmlClass{lm-unknown}{\\text{${escapeText(e.u)}}}` : `\\htmlClass{lm-unknown}{\\text{\\textbackslash ${escapeText(a.n)}}}`; }
      return '\\' + a.n + lim;
    }
    case 'space': {
      if (a.len !== undefined) return `\\htmlClass{lm-sp}{\\hspace{${a.len}}}`;
      return `\\htmlClass{lm-sp}{${SPACES[a.n] ?? '\\,'}}`;
    }
    case 'kern': return `\\htmlClass{lm-sp}{\\${a.n}${a.len}}`;
    case 'script': {
      const nuc = cellToKatex(a.nuc, ctx, a, 0);
      let s = a.nuc.length ? nuc : '{' + nuc + '}';
      if (a.limits) s += '\\' + a.limits;
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
        case 'nicefrac': return `{}^{${c0}}\\!/\\!{}_{${c1}}`;
        case 'unitfrac': return `{}^{${c0}}\\!/\\!{}_{${c1}}` + (a.c2 ? `\\,${braced(a.c2, ctx, a, 2, 'text')}` : '');
        case 'unit': return `${c0}\\,\\text{${cellToKatex(a.c1, ctx, a, 1, 'text')}}`;
        default: return `\\frac${c0}${c1}`;
      }
    }
    case 'sqrt': return a.index ? `\\sqrt[${cellToKatex(a.index, ctx, a, 1)}]${braced(a.body, ctx, a, 0)}` : `\\sqrt${braced(a.body, ctx, a, 0)}`;
    case 'delim': {
      const l = delimToKatex(a.l), r = delimToKatex(a.r);
      // doubled delimiters: \left takes the first glyph, the second one is content
      const lm = /^(\\langle|\[)(\\!.*)$/.exec(l), rm = /^(\\rangle|\])(\\!.*)$/.exec(r);
      return `\\left${lm ? lm[1] + lm[2] : l}${cellToKatex(a.body, ctx, a, 0)}${rm ? rm[2].replace(/^\\!/, '') + '\\!' : ''}\\right${rm ? rm[1] : r}`;
    }
    case 'big': { const n = a.n.replace(/^(big|Big|bigg|Bigg)gg?/, '$1'); return `\\${n}${a.d.startsWith('\\') ? a.d : a.d === '{' ? '\\{' : a.d === '}' ? '\\}' : a.d}`; }
    case 'brace': return `{${cellToKatex(a.body, ctx, a, 0, mode)}}`;
    case 'font': {
      const n = FONT_MAP[a.n] ?? a.n;
      const inner = cellToKatex(a.body, ctx, a, 0, a.mode);
      if (a.mode === 'text' && mode === 'text' && (n === 'text' || n === 'textnormal')) return `{${inner}}`;
      return `\\${n}{${inner}}`;
    }
    case 'oldfont': return `{\\${a.n} ${cellToKatex(a.body, ctx, a, 0, mode)}}`;
    case 'box': {
      const n = a.n === 'tag' || a.n === 'tag*' || a.n === 'intertext' ? 'text' : a.n;
      return `\\${n}{${cellToKatex(a.body, ctx, a, 0, a.n === 'boxed' ? 'math' : 'text')}}`;
    }
    case 'makebox': return `\\text{${cellToKatex(a.body, ctx, a, 2, 'text')}}`;
    case 'deco': {
      const n = DECO_MAP[a.n] ?? '\\' + a.n;
      return `${n}{${cellToKatex(a.body, ctx, a, 0)}}` + (a.limits ? '\\' + a.limits : '');
    }
    case 'style': return `{\\${a.n} ${cellToKatex(a.body, ctx, a, 0, mode)}}`;
    case 'class': {
      const n = a.n === 'bm' || a.n === 'heavysymbol' ? 'boldsymbol' : a.n === 'lefteqn' ? 'mathrlap' : a.n;
      return `\\${n}{${cellToKatex(a.body, ctx, a, 0)}}` + (a.limits ? '\\' + a.limits : '');
    }
    case 'color': return a.old ? `{\\color{${a.color === 'normalcolor' ? 'black' : a.color}}${cellToKatex(a.body, ctx, a, 0, mode)}}` : `\\textcolor{${a.color}}{${cellToKatex(a.body, ctx, a, 0, 'text')}}`;
    case 'phantom': { const n = a.n === 'smasht' ? 'smash[t]' : a.n === 'smashb' ? 'smash[b]' : a.n; return `\\${n}{${cellToKatex(a.body, ctx, a, 0)}}`; }
    case 'ensuremath': return `{${cellToKatex(a.body, ctx, a, 0, 'math')}}`;
    case 'overset': case 'underset': return `\\${a.t}{${cellToKatex(a.top, ctx, a, 1)}}{${cellToKatex(a.body, ctx, a, 0)}}`;
    case 'stackrel': return `\\stackrel{${cellToKatex(a.top, ctx, a, 1)}}{${cellToKatex(a.body, ctx, a, 0)}}`;
    case 'xarrow': return `\\${a.n}${a.opt ? `[${cellToKatex(a.opt, ctx, a, 1)}]` : ''}{${cellToKatex(a.body, ctx, a, 0)}}`;
    case 'ref': return `\\htmlClass{lm-ref}{\\text{${escapeText(a.label)}}}`;
    case 'grid': return gridToKatex(a, ctx, mode);
    case 'macro': return macroToKatex(a, ctx, mode);
    case 'cmd': {
      const n = CMD_MAP[a.n];
      if (n !== undefined) return n;
      if (a.n.length === 1 && !/[A-Za-z]/.test(a.n)) return '\\' + a.n;
      return `\\htmlClass{lm-unknown}{\\text{\\textbackslash ${escapeText(a.n)}}}` + (a.limits ? '' : '');
    }
    case 'hash': return `\\htmlClass{lm-arg}{\\text{${escapeText(a.n)}}}`;
    case 'comment': return `\\htmlClass{lm-comment}{\\text{\\%${escapeText(a.text)}}}`;
    case 'env': return `\\htmlClass{lm-unknown}{\\text{\\textbackslash begin\\{${escapeText(a.n)}\\}}}${cellToKatex(a.body, ctx, a, 0, mode)}\\htmlClass{lm-unknown}{\\text{\\textbackslash end\\{${escapeText(a.n)}\\}}}`;
    case 'raw': return a.latex;
    case 'unknown': return `\\htmlClass{lm-mm}{\\texttt{${escapeText(a.n)}}}`;
  }
}

const FONT_MAP: Record<string, string> = { frak: 'mathfrak', mathds: 'mathbb', textmd: 'text', textup: 'textup', noun: 'textsc', emph: 'textit', textipa: 'text', ce: 'text', cf: 'text' };
const CMD_MAP: Record<string, string> = { textbackslash: '\\textbackslash ', textasciicircum: '\\textasciicircum ', textasciitilde: '\\textasciitilde ', '{': '\\{', '}': '\\}', '_': '\\_', '&': '\\&', '#': '\\#', '$': '\\$', '%': '\\%', ' ': '\\ ', label: '', nonumber: '', notag: '', limits: '', nolimits: '' };

function delimToKatex(name: string): string {
  if (name === '.') return '.';
  if (name === 'llangle') return '\\langle\\!\\langle';
  if (name === 'rrangle') return '\\rangle\\!\\rangle';
  if (name === 'llbracket') return '[\\![';
  if (name === 'rrbracket') return ']\\!]';
  if (name.length === 1) return '<([)]/|>'.includes(name) ? name : name === '{' || name === '}' ? '\\' + name : name;
  return '\\' + name + ' ';
}

function gridToKatex(g: Grid & { t: 'grid' }, ctx: KatexContext, mode: 'math' | 'text'): string {
  const rows = g.rows.map((r, ri) => r.cells.map((c, ci) => cellToKatex(c, ctx, g, ri * g.ncols + ci, g.env === 'tabular' ? 'text' : mode)).join(' & ')).join(' \\\\ ');
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

/** Expand a user macro: the definition with `#k` replaced by the (editable) argument cells. */
function macroToKatex(a: Atom & { t: 'macro' }, ctx: KatexContext, mode: 'math' | 'text'): string {
  const info = ctx.macros[a.n];
  const args = a.args.map((c, i) => cellToKatex(c, ctx, a, i, mode));
  const id = ctx.cells.length;
  if (!info || !info.def) {
    // no definition: show the name with its arguments
    return `\\htmlClass{lm-macro}{\\htmlClass{lm-unknown}{\\text{\\textbackslash ${escapeText(a.n)}}}${args.map(s => `\\{${s}\\}`).join('')}}`;
  }
  const def = sanitizeForKatex(info.def, a.n, a.args.length);
  const nopt = info.nopt ?? 0;
  let body = def;
  // template: arguments are substituted as already-wrapped cells; the rest renders non-editable
  body = body.replace(/#(\d)/g, (_m, d) => { const k = Number(d) - 1; return k < args.length ? `{${args[k]}}` : ''; });
  void nopt; void id;
  return `\\htmlClass{lm-macro}{${body}}`;
}

/** Replace a command with a single braced argument (\cmd{X}, optionally with [..] options) using `fn(content)`. */
function replaceCommand(def: string, cmd: string, fn: (content: string, opts: string[]) => string, nGroups = 1): string {
  let out = def;
  for (let guard = 0; guard < 50; guard++) {
    const i = out.indexOf('\\' + cmd);
    if (i < 0) break;
    const after = out[i + cmd.length + 1];
    if (after && /[A-Za-z]/.test(after)) { const rest = replaceCommand(out.slice(i + 1), cmd, fn, nGroups); return out.slice(0, i + 1) + rest; }
    let j = i + cmd.length + 1;
    while (out[j] === ' ') j++;
    const opts: string[] = [];
    let groups: string[] = [];
    for (let g = 0; g < nGroups; g++) {
      for (;;) {
        while (out[j] === ' ') j++;
        if (out[j] === '[') { const e = out.indexOf(']', j); if (e < 0) break; opts.push(out.slice(j + 1, e)); j = e + 1; continue; }
        break;
      }
      const grp = readGroup(out, j);
      if (!grp) { groups = []; break; }
      groups.push(grp[0]); j = grp[1];
    }
    if (!groups.length) { out = out.slice(0, i) + '\\mathrm{' + cmd + '}' + out.slice(i + cmd.length + 1); continue; }
    out = out.slice(0, i) + fn(groups[groups.length - 1], [...opts, ...groups.slice(0, -1)]) + out.slice(j);
  }
  return out;
}

const unmath = (s: string) => { const t = s.trim(); const m = /^\$([\s\S]*)\$$/.exec(t); return m ? m[1] : t; };

/**
 * KaTeX cannot render some TeX internals / text-mode constructs used in macro definitions:
 * rewrite the common ones into a visual approximation, else show the macro name.
 */
export function sanitizeForKatex(def: string, name: string, args: number): string {
  let d = def;
  d = replaceCommand(d, 'scalebox', c => `{${unmath(c)}}`, 2);
  d = replaceCommand(d, 'resizebox', c => `{${unmath(c)}}`, 3);
  d = replaceCommand(d, 'rotatebox', c => `{${unmath(c)}}`, 2);
  d = replaceCommand(d, 'raisebox', c => `{${unmath(c)}}`, 2);
  d = replaceCommand(d, 'vcenter', c => `{${c}}`);
  d = replaceCommand(d, 'vbox', c => `{${c}}`);
  d = replaceCommand(d, 'hbox', c => `\\text{${c}}`);
  d = replaceCommand(d, 'mbox', c => `\\text{${c}}`);
  d = replaceCommand(d, 'ensuremath', c => `{${c}}`);
  d = replaceCommand(d, 'textnormal', c => `\\text{${c}}`);
  d = replaceCommand(d, 'accentset', (c, o) => `\\overset{${o[0] ?? ''}}{${c}}`, 2);
  d = replaceCommand(d, 'mathchoice', (c, o) => `{${o[0] ?? c}}`, 4);
  d = replaceCommand(d, 'bm', c => `\\boldsymbol{${c}}`);
  d = replaceCommand(d, 'mathds', c => `\\mathbb{${c}}`);
  d = replaceCommand(d, 'intertext', c => `\\text{${c}}`);
  d = replaceCommand(d, 'DeclareMathOperator', () => '', 2);
  // stmaryrd double delimiters are no KaTeX delimiters
  d = d.replace(/\\left\\llangle/g, '\\left\\langle\\!\\langle').replace(/\\right\\rrangle/g, '\\rangle\\!\\right\\rangle')
    .replace(/\\left\\llbracket/g, '\\left[\\![').replace(/\\right\\rrbracket/g, ']\\!\\right]')
    .replace(/\\llangle/g, '\\langle\\!\\langle').replace(/\\rrangle/g, '\\rangle\\!\\rangle').replace(/\\llbracket/g, '[\\![').replace(/\\rrbracket/g, ']\\!]');
  d = d.replace(/\\relax\b/g, '').replace(/\\(m|)ath?strut\b/g, '').replace(/\\displaylimits\b/g, '');
  if (/\\(includesvg|includegraphics|sbox|usebox|ooalign|mathpalette|fontcharht|fontdimen|csname|expandafter|noexpand|@|def\b|let\b|newcommand|renewcommand)/.test(d)) {
    let f = `\\mathrm{${name}}`;
    for (let k = 1; k <= args; k++) f += `\\{#${k}\\}`;
    return f;
  }
  return d;
}

/** KaTeX `macros` option: LyX's own symbol macros plus the document's argument-less macros. */
export function katexMacros(table: MacroTable): Record<string, string> {
  const out: Record<string, string> = { ...KATEX_BASE_MACROS };
  for (const [name, info] of Object.entries(table)) {
    if (!/^[A-Za-z]+$/.test(name)) continue;
    if (info.def === undefined) continue;
    if (info.nargs === 0) out['\\' + name] = sanitizeForKatex(info.def, name, 0);
  }
  return out;
}

/** The hull as KaTeX LaTeX (display environments become their inner AMS equivalents). */
export function hullToKatex(h: Hull, ctx: KatexContext): string {
  const cell = (ri: number, ci: number) => cellToKatex(h.rows[ri].cells[ci], ctx, h, ri * h.ncols + ci);
  switch (h.type) {
    case 'simple': case 'equation': case 'none': case 'unknown':
      return cell(0, 0);
    case 'eqnarray': {
      const rows = h.rows.map((r, ri) => r.cells.map((_c, ci) => '\\displaystyle ' + cell(ri, ci)).join(' & ')).join(' \\\\ ');
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

/** Render a whole hull: the KaTeX source and the cell registry. */
export function renderHullSource(h: Hull, macros: MacroTable): { latex: string; cells: CellRef[] } {
  const ctx: KatexContext = { macros, cells: [] };
  const latex = hullToKatex(h, ctx);
  return { latex, cells: ctx.cells };
}
