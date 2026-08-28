/**
 * LaTeX → math model, a port of LyX's MathParser.cpp (Parser::tokenize / parse1).
 *
 * The semantics are LyX's, not TeX's: scripts attach to the previous atom, `{…}` becomes a brace
 * inset unless it is an argument, commands take as many arguments as their LyX inset has cells,
 * user macros take the number of arguments of their definition, unknown commands take none.
 */
import type { Atom, Cell, Grid, GridRow, Hull, HullType, MacroTable, Mode, FracKind, Limits } from './ast';
import symbolTable from './symbols.json';

export interface SymbolEntry { i: string; c?: string; u?: string; x?: string; d?: string }
export const SYMBOLS: Record<string, SymbolEntry> = symbolTable as Record<string, SymbolEntry>;

/* ------------------------------------------------------------------ tokens */

const enum Cat { Escape, Begin, End, Math, Align, Newline, Parameter, Super, Sub, Ignore, Space, Letter, Other, Active, Comment, Invalid }

function catcode(c: string): Cat {
  switch (c) {
    case '\\': return Cat.Escape;
    case '{': return Cat.Begin;
    case '}': return Cat.End;
    case '$': return Cat.Math;
    case '&': return Cat.Align;
    case '\n': case '\r': return Cat.Newline;
    case '#': return Cat.Parameter;
    case '^': return Cat.Super;
    case '_': return Cat.Sub;
    case '\x7f': return Cat.Ignore;
    case ' ': case '\t': return Cat.Space;
    case '~': return Cat.Active;
    case '%': return Cat.Comment;
    default: return /[A-Za-z]/.test(c) ? Cat.Letter : Cat.Other;
  }
}

interface Token { cat: Cat; ch: string; cs: string }
const tok = (ch: string, cat: Cat): Token => ({ cat, ch, cs: '' });
const csTok = (cs: string): Token => ({ cat: Cat.Invalid, ch: '', cs });
const NONE: Token = { cat: Cat.Invalid, ch: '', cs: '' };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  const chars = Array.from(src);
  let i = 0;
  const skipSpaceTokens = () => { while (i < chars.length && (catcode(chars[i]) === Cat.Space || catcode(chars[i]) === Cat.Newline)) i++; };
  while (i < chars.length) {
    const c = chars[i++];
    switch (catcode(c)) {
      case Cat.Newline: {
        // a double newline is dropped ("par"), a single one is a newline token
        if (i < chars.length && catcode(chars[i]) === Cat.Newline) i++;
        else out.push(tok('\n', Cat.Newline));
        break;
      }
      case Cat.Escape: {
        if (i >= chars.length) break;
        let n = chars[i++];
        if (n === '\n') n = ' ';
        let s = n;
        if (catcode(n) === Cat.Letter) {
          while (i < chars.length && catcode(chars[i]) === Cat.Letter) s += chars[i++];
          skipSpaceTokens();
        }
        out.push(csTok(s));
        break;
      }
      case Cat.Super: case Cat.Sub:
        out.push(tok(c, catcode(c)));
        skipSpaceTokens();
        break;
      case Cat.Ignore: break;
      default: out.push(tok(c, catcode(c)));
    }
  }
  return out;
}

/* ------------------------------------------------------------------ parser */

const FLAG_BRACE_LAST = 1 << 0;
const FLAG_RIGHT = 1 << 1;
const FLAG_END = 1 << 2;
const FLAG_BRACK_LAST = 1 << 3;
const FLAG_ITEM = 1 << 4;
const FLAG_LEAVE = 1 << 5;
const FLAG_SIMPLE = 1 << 6;
const FLAG_EQUATION = 1 << 7;
const FLAG_SIMPLE2 = 1 << 8;
const FLAG_OPTION = 1 << 9;
const FLAG_BRACED = 1 << 10;
const FLAG_ALIGN = 1 << 11;

type PMode = Mode | 'undecided';

const asMode = (mode: PMode, extra: string | undefined): PMode =>
  extra === 'mathmode' ? 'math' : extra === 'textmode' || extra === 'forcetext' ? 'text' : mode;

const FRAC_NAMES: Record<string, FracKind> = { frac: 'frac', dfrac: 'dfrac', tfrac: 'tfrac', nicefrac: 'nicefrac', binom: 'binom', dbinom: 'dbinom', tbinom: 'tbinom' };
const PHANTOMS = new Set(['phantom', 'vphantom', 'hphantom', 'mathclap', 'mathllap', 'mathrlap']);
const ONE_CELL_CMDS = new Set(['boldsymbol', 'bm', 'heavysymbol', 'lefteqn', 'cancel', 'bcancel', 'xcancel', 'boxed', 'fbox']);
const XARROWS = new Set(['xrightarrow', 'xleftarrow', 'xhookrightarrow', 'xhookleftarrow', 'xRightarrow', 'xLeftarrow', 'xleftrightarrow', 'xLeftrightarrow', 'xrightharpoondown', 'xrightharpoonup', 'xleftharpoondown', 'xleftharpoonup', 'xleftrightharpoons', 'xrightleftharpoons', 'xmapsto']);
const REFS = new Set(['ref', 'eqref', 'prettyref', 'nameref', 'pageref', 'vpageref', 'vref', 'formatted', 'labelonly']);
const MULTIROW_HULLS = new Set<HullType>(['eqnarray', 'align', 'flalign', 'alignat', 'xalignat', 'xxalignat', 'multline', 'gather']);
const MULTICOL_HULLS = new Set<HullType>(['align', 'flalign', 'alignat', 'xalignat', 'xxalignat', 'eqnarray']);

/** A grid being filled by the parser (LyX passes the InsetMathGrid itself). */
interface PGrid extends Grid { hull?: Hull }

function newGrid(env: string, ncols = 1): PGrid {
  return { env, ncols, rows: [{ cells: Array.from({ length: ncols }, () => [] as Cell) }] };
}

class Parser {
  private toks: Token[];
  private pos = 0;
  private environments: string[] = [];
  private positions: number[] = [];
  success = true;

  constructor(src: string, private macros: MacroTable) { this.toks = tokenize(src); }

  private good() { return this.pos < this.toks.length; }
  private getToken(): Token { return this.pos < this.toks.length ? this.toks[this.pos++] : NONE; }
  private nextToken(): Token { return this.pos < this.toks.length ? this.toks[this.pos] : NONE; }
  private prevToken(): Token { return this.pos > 0 ? this.toks[this.pos - 1] : NONE; }
  private putback() { this.pos--; }
  private skipSpaces() { while (this.good() && (this.nextToken().cat === Cat.Space || this.nextToken().cat === Cat.Newline)) this.pos++; }
  private pushPosition() { this.positions.push(this.pos); }
  private popPosition() { this.pos = this.positions.pop() ?? this.pos; }
  private dropPosition() { this.positions.pop(); }

  private getArg(left: string, right: string): string {
    this.skipSpaces();
    let result = '';
    const t = this.getToken();
    if (t.ch !== left) { this.putback(); return ''; }
    for (;;) {
      const u = this.getToken();
      if (!this.good() && u === NONE) break;
      if (u.ch === right) break;
      result += u.cs ? '\\' + u.cs : u.ch;
    }
    return result;
  }

  /** verbatim item: {…} with nesting, or a single token */
  private parseVerbatimItem(): string {
    this.skipSpaces();
    const t = this.getToken();
    if (t.cat !== Cat.Begin) return t.cs ? '\\' + t.cs : t.ch;
    let depth = 1, s = '';
    while (this.good()) {
      const u = this.getToken();
      if (u.cat === Cat.Begin) depth++;
      else if (u.cat === Cat.End) { if (--depth === 0) break; }
      s += u.cs ? '\\' + u.cs + (/^[A-Za-z]+$/.test(u.cs) && this.nextToken().cat === Cat.Letter ? ' ' : '') : u.ch;
    }
    return s;
  }
  private parseVerbatimOption(): string {
    this.skipSpaces();
    if (this.nextToken().ch !== '[') return '';
    this.getToken();
    let depth = 0, s = '';
    while (this.good()) {
      const u = this.getToken();
      if (u.ch === '[') depth++;
      else if (u.ch === ']') { if (depth-- === 0) break; }
      s += u.cs ? '\\' + u.cs : u.ch;
    }
    return s;
  }

  /** parse(MathData &, flags, mode): a cell */
  parseCell(flags: number, mode: PMode): Cell {
    const g = newGrid('');
    this.parse1(g, flags, mode, false);
    return g.rows[0].cells[0];
  }

  /** parse2(MathAtom, flags, mode, numbered): fill an existing grid atom */
  parseGrid(g: PGrid, flags: number, mode: PMode, numbered: boolean) {
    this.parse1(g, flags, mode, numbered);
  }

  private parse1(grid: PGrid, flags: number, mode: PMode, numbered: boolean): boolean {
    let cellrow = 0, cellcol = 0;
    let cell = grid.rows[0].cells[0];
    const hull = grid.hull;
    if (hull) hull.numberedRows[0] = numbered;
    const macros = this.macros;

    const addRow = (crskip: string, allowNewpage: boolean): boolean => {
      if (hull && !MULTIROW_HULLS.has(hull.type)) return false;
      const prev = grid.rows[cellrow];
      if (crskip) prev.crskip = crskip;
      if (!allowNewpage) prev.nonewpage = true;
      cellrow++;
      if (cellrow === grid.rows.length) {
        grid.rows.push({ cells: Array.from({ length: grid.ncols }, () => [] as Cell) });
        if (hull) { hull.numberedRows.push(numbered); hull.labels.push(undefined); }
      }
      return true;
    };
    const addCol = (): boolean => {
      if (hull && !MULTICOL_HULLS.has(hull.type)) return false;
      cellcol++;
      if (cellcol === grid.ncols) {
        grid.ncols++;
        for (const r of grid.rows) while (r.cells.length < grid.ncols) r.cells.push([]);
      }
      return true;
    };
    const push = (a: Atom) => cell.push(a);
    const sym = (name: string): Atom => ({ t: 'sym', n: name });

    while (this.good()) {
      let t = this.getToken();

      if (flags & FLAG_ITEM) {
        if (t.cat === Cat.Begin) {
          // skip the brace and collect everything to the next matching closing brace
          this.parse1(grid, FLAG_BRACE_LAST, mode, numbered);
          return this.success;
        }
        // handle only this single token, leave the loop if done
        flags = FLAG_LEAVE;
      }

      if (flags & FLAG_BRACED) {
        if (t.cat === Cat.Space) continue;
        if (t.cat !== Cat.Begin) { this.success = false; return false; }
        flags = FLAG_BRACE_LAST;
      }

      if (flags & FLAG_OPTION) {
        if (t.cat === Cat.Other && t.ch === '[') {
          const ar = this.parseCell(FLAG_BRACK_LAST, mode);
          cell.push(...ar);
        } else this.putback();
        return this.success;
      }

      // ---- cat codes
      if (t.cat === Cat.Math) {
        if (mode !== 'math') {
          const n = this.getToken();
          if (n.cat === Cat.Math) {
            // display math inside text: $$ … $$ — keep as an equation hull? LyX makes hullEquation; we keep raw
            const body = this.collectUntil(u => u.cat === Cat.Math && this.nextToken().cat === Cat.Math);
            this.getToken();
            push({ t: 'raw', latex: '$$' + body + '$$' });
          } else {
            this.putback();
            const g = newGrid('');
            const h: Hull = { ...g, type: 'simple', numberedRows: [false], labels: [undefined] };
            const pg: PGrid = { ...h, hull: h }; pg.rows = h.rows;
            this.parse1(pg, FLAG_SIMPLE, 'math', false);
            push({ t: 'ensuremath', body: h.rows[0].cells[0] });   // inline math inside text mode
          }
        } else {
          // we are inside math mode: `$` ends a simple hull or is an error
          if (flags & FLAG_SIMPLE) return this.success;
          this.success = false;
        }
      }

      else if (t.cat === Cat.Letter) push({ t: 'char', c: t.ch });

      else if (t.cat === Cat.Space && mode !== 'math') {
        if (!cell.length || cell[cell.length - 1].t !== 'char' || (cell[cell.length - 1] as { c: string }).c !== ' ') push({ t: 'char', c: ' ' });
      }

      else if (t.cat === Cat.Newline && mode !== 'math') {
        if (!cell.length || cell[cell.length - 1].t !== 'char' || (cell[cell.length - 1] as { c: string }).c !== ' ') push({ t: 'char', c: ' ' });
      }

      else if (t.cat === Cat.Parameter) {
        const n = this.nextToken();
        if (n.ch && n.ch > '0' && n.ch <= '9') { push({ t: 'hash', n: '#' + n.ch }); this.getToken(); }
        else push({ t: 'hash', n: '#' });
      }

      else if (t.cat === Cat.Active) push({ t: 'space', n: '~' });

      else if (t.cat === Cat.Begin) {
        const ar = this.parseCell(FLAG_BRACE_LAST, mode);
        // do not create a BraceInset if they were written by LyX (extraBraces: color, oldfont, size, frac atop, macros w/ optionals)
        if (ar.length === 1 && extraBraces(ar[0])) cell.push(...ar);
        else push({ t: 'brace', body: ar });
      }

      else if (t.cat === Cat.End) {
        if (flags & FLAG_BRACE_LAST) return this.success;
        this.success = false;   // found '}' unexpectedly
      }

      else if (t.cat === Cat.Align) {
        if (flags & FLAG_ALIGN) return this.success;
        if (addCol()) cell = grid.rows[cellrow].cells[cellcol];
      }

      else if (t.cat === Cat.Super || t.cat === Cat.Sub) {
        const up = t.cat === Cat.Super;
        let p: Extract<Atom, { t: 'script' }>;
        const last = cell[cell.length - 1];
        if (!cell.length) { p = { t: 'script', nuc: [] }; push(p); }
        else if (last.t === 'script' && !(up ? last.up : last.down)) p = last;
        else if (last.t === 'script') { p = { t: 'script', nuc: [] }; push(p); }
        else { p = { t: 'script', nuc: [last] }; cell[cell.length - 1] = p; }
        // remove empty braces in the nucleus (added by write() for empty nuclei)
        if (p.nuc.length === 1 && p.nuc[0].t === 'brace' && !p.nuc[0].body.length) p.nuc = [];
        const c = this.parseCell(FLAG_ITEM, mode);
        if (up) p.up = c; else p.down = c;
      }

      else if (t.ch === ']' && (flags & FLAG_BRACK_LAST)) return this.success;

      else if (t.cat === Cat.Other) push({ t: 'char', c: t.ch });

      else if (t.cat === Cat.Comment) {
        let s = '';
        while (this.good()) { const tt = this.getToken(); if (tt.cat === Cat.Newline) break; s += tt.cs ? '\\' + tt.cs : tt.ch; }
        push({ t: 'comment', text: s });
        this.skipSpaces();
      }

      // ---- control sequences
      else if (t.cs === 'lyxlock') { /* ignored */ }

      else if (t.cs === '(') {
        if (mode === 'undecided') {
          const h = this.newHull('simple');
          this.parse1(h, FLAG_SIMPLE2, 'math', false);
          push({ t: 'raw', latex: '\\(' + '' + '\\)' });   // not expected inside formulas
        } else {
          const body = this.parseCell(FLAG_SIMPLE2, 'math');
          push({ t: 'ensuremath', body });
        }
      }

      else if (t.cs === 'protect') { /* nothing */ }

      else if (t.cs === 'end') {
        if (flags & FLAG_END) {
          const name = this.getArg('{', '}');
          if (!this.environments.length || name !== this.environments[this.environments.length - 1]) this.success = false;
          else {
            this.environments.pop();
            if (grid.rows.length > 1 && innerHull(name)) delEmptyLastRow(grid);
            return this.success;
          }
        } else this.success = false;
      }

      else if (t.cs === ')') { if (flags & FLAG_SIMPLE2) return this.success; this.success = false; }
      else if (t.cs === ']') { if (flags & FLAG_EQUATION) return this.success; this.success = false; }

      else if (t.cs === '\\') {
        if (flags & FLAG_ALIGN) return this.success;
        let starred = false, arg = '';
        if (this.nextToken().ch === '*') { this.getToken(); starred = true; }
        else if (this.nextToken().ch === '[') arg = this.getArg('[', ']');
        // `\\{}[…]`: braces protecting a following '[' — skip them
        let skipBraces = false;
        this.pushPosition();
        if (this.nextToken().cat === Cat.Begin) {
          this.getToken();
          if (this.nextToken().cat === Cat.End) {
            this.getToken();
            this.pushPosition(); this.skipSpaces();
            if (this.nextToken().ch === '[') skipBraces = true;
            this.popPosition();
          }
        }
        if (skipBraces) this.dropPosition(); else this.popPosition();
        if (addRow(arg, !starred)) { cellcol = 0; cell = grid.rows[cellrow].cells[0]; }
      }

      else if (t.cs === 'multicolumn' && grid.env !== '' && !hull) {
        const count = this.parseCell(FLAG_ITEM, mode);
        const cols = Number(count.map(a => charOfAtom(a)).join(''));
        if (cols > 0 && cols < 100) {
          const first = cellcol;
          for (let i = 1; i < cols; i++) addCol();
          cell = grid.rows[cellrow].cells[first];
          const align = this.parseCell(FLAG_ITEM, mode).map(a => charOfAtom(a)).join('');
          (grid.rows[cellrow].multi ??= []).push({ col: first, ncols: cols, align });
          cell.push(...this.parseCell(FLAG_ITEM, mode));
        } else { push({ t: 'cmd', n: 'multicolumn' }); push({ t: 'brace', body: count }); }
      }

      else if (t.cs === 'limits' || t.cs === 'nolimits') {
        const last = cell[cell.length - 1] as { limits?: Limits } | undefined;
        if (last) last.limits = t.cs as Limits; else push({ t: 'cmd', n: t.cs });
      }

      else if ((t.cs === 'nonumber' || t.cs === 'notag') && hull) hull.numberedRows[cellrow] = t.cs === 'notag' ? 'notag' : false;
      else if (t.cs === 'number' && hull) hull.numberedRows[cellrow] = true;

      else if (t.cs === 'hline') { const r = grid.rows[cellrow]; r.hlines = (r.hlines ?? 0) + 1; }

      else if (t.cs === 'sqrt') {
        const ar = this.parseCell(FLAG_OPTION, mode);
        const a: Atom = ar.length ? { t: 'sqrt', body: [], index: ar } : { t: 'sqrt', body: [] };
        push(a);
        a.body = this.parseCell(FLAG_ITEM, mode);
      }

      else if (t.cs === 'cancelto') {
        const ar = this.parseCell(FLAG_ITEM, mode);
        const body = this.parseCell(FLAG_ITEM, mode);
        push({ t: 'overset', top: ar, body });   // approximation: \cancelto{a}{b}
        push({ t: 'raw', latex: '' });
        cell.pop();
        cell[cell.length - 1] = { t: 'macro', n: 'cancelto', args: [ar, body], nopt: 0 };
      }

      else if (t.cs === 'unit') {
        const ar = this.parseCell(FLAG_OPTION, mode);
        if (ar.length) { const c1 = this.parseCell(FLAG_ITEM, mode); push({ t: 'frac', kind: 'unit', c0: ar, c1 }); }
        else { const c0 = this.parseCell(FLAG_ITEM, mode); push({ t: 'frac', kind: 'unit', c0, c1: [], c2: undefined }); (cell[cell.length - 1] as { c2?: Cell }).c2 = undefined; }
      }

      else if (t.cs === 'unitfrac') {
        const ar = this.parseCell(FLAG_OPTION, mode);
        const c0 = this.parseCell(FLAG_ITEM, mode);
        const c1 = this.parseCell(FLAG_ITEM, mode);
        push(ar.length ? { t: 'frac', kind: 'unitfrac', c0, c1, c2: ar } : { t: 'frac', kind: 'unitfrac', c0, c1 });
      }

      else if (t.cs === 'cfrac') {
        const arg = this.getArg('[', ']');
        const kind: FracKind = arg === 'l' ? 'cfracleft' : arg === 'r' ? 'cfracright' : 'cfrac';
        const c0 = this.parseCell(FLAG_ITEM, mode);
        const c1 = this.parseCell(FLAG_ITEM, mode);
        push({ t: 'frac', kind, c0, c1 });
      }

      else if (t.cs === 'stackrel') {
        const ar = this.parseCell(FLAG_OPTION, mode);
        const top = this.parseCell(FLAG_ITEM, mode);
        const body = this.parseCell(FLAG_ITEM, mode);
        push(ar.length ? { t: 'stackrel', top, body, bottom: ar } : { t: 'stackrel', top, body });
      }

      else if (XARROWS.has(t.cs)) {
        const opt = this.parseCell(FLAG_OPTION, mode);
        const body = this.parseCell(FLAG_ITEM, mode);
        push(opt.length ? { t: 'xarrow', n: t.cs, body, opt } : { t: 'xarrow', n: t.cs, body });
      }

      else if (REFS.has(t.cs)) {
        const opt = this.parseVerbatimOption();
        const ref = this.parseVerbatimItem();
        push(opt ? { t: 'ref', n: t.cs, label: ref, opt } : { t: 'ref', n: t.cs, label: ref });
      }

      else if (t.cs === 'left') {
        this.skipSpaces();
        const tl = this.getToken();
        const l = tl.cs === '|' ? 'Vert' : tl.cs || tl.ch;
        const body = this.parseCell(FLAG_RIGHT, mode);
        if (!this.good() && this.prevToken().cs !== 'right') { push({ t: 'delim', l, r: '.', body }); break; }
        this.skipSpaces();
        const tr = this.getToken();
        const r = tr.cs === '|' ? 'Vert' : tr.cs || tr.ch;
        push({ t: 'delim', l, r, body });
      }

      else if (t.cs === 'right') { return this.success; }   // FLAG_RIGHT or stray

      else if (t.cs === 'begin') {
        const name = this.getArg('{', '}');
        if (!name) { this.success = false; return false; }
        this.environments.push(name);
        const entry = SYMBOLS[name];
        if (name === 'array' || name === 'subarray' || name === 'tabular') {
          const valign = this.parseVerbatimOption() + 'c';
          const halign = this.parseVerbatimItem();
          const g = newGrid(name, guessColumns(halign));
          g.halign = halign; g.valign = valign[0];
          this.parse1(g, FLAG_END, name === 'tabular' ? 'text' : 'math', false);
          push({ t: 'grid', ...stripP(g) });
        } else if (name === 'split' || name === 'cases') {
          const g = newGrid(name, name === 'cases' ? 2 : 2);
          this.parse1(g, FLAG_END, mode, false);
          push({ t: 'grid', ...stripP(g) });
        } else if (name === 'alignedat') {
          const valign = this.parseVerbatimOption() + 'c';
          this.getArg('{', '}');
          const g = newGrid(name, 2); g.valign = valign[0];
          this.parse1(g, FLAG_END, mode, false);
          push({ t: 'grid', ...stripP(g) });
        } else if (name === 'math') {
          const body = this.parseCell(FLAG_END, 'math');
          push({ t: 'ensuremath', body });
        } else if (name === 'align' || name === 'align*') {
          // inside a formula: an aligned-like split (LyX: InsetMathSplit "align")
          const g = newGrid(name.replace('*', ''), 2); g.numbered = !name.endsWith('*');
          this.parse1(g, FLAG_END, mode, !name.endsWith('*'));
          push({ t: 'grid', ...stripP(g) });
        } else if (entry && entry.i === 'matrix') {
          const g = newGrid(name, 1);
          this.parse1(g, FLAG_END, mode, false);
          push({ t: 'grid', ...stripP(g) });
        } else if (entry && entry.i === 'split') {
          const valign = this.parseVerbatimOption() + 'c';
          const g = newGrid(name, name === 'gathered' || name === 'lgathered' || name === 'rgathered' ? 1 : 2); g.valign = valign[0];
          this.parse1(g, FLAG_END, mode, false);
          push({ t: 'grid', ...stripP(g) });
        } else {
          // unknown environment: keep name and body
          this.success = false;
          const body = this.parseCell(FLAG_END, mode);
          push({ t: 'env', n: name, body });
        }
      }

      else if (t.cs === 'kern' || t.cs === 'mkern') {
        let s = '', n = 0;
        const start = this.pos;
        for (;;) {
          const tt = this.getToken();
          n++;
          if (!this.good() && tt === NONE) { s = ''; this.pos = start; break; }
          s += tt.cs ? '\\' + tt.cs : tt.ch;
          if (isValidLength(s)) break;
          if (n > 12) { s = ''; this.pos = start; break; }
        }
        if (!s) push({ t: 'cmd', n: t.cs }); else push({ t: 'kern', n: t.cs as 'kern' | 'mkern', len: s });
      }

      else if (t.cs === 'label') {
        const label = this.parseVerbatimItem();
        if (hull) hull.labels[cellrow] = label;
        else { push({ t: 'cmd', n: 'label' }); push({ t: 'brace', body: Array.from(label).map(c => ({ t: 'char', c } as Atom)) }); }
      }

      else if (t.cs === 'choose' || t.cs === 'over' || t.cs === 'atop' || t.cs === 'brace' || t.cs === 'brack') {
        const c0 = cell.splice(0, cell.length);
        const c1 = this.parseCell(flags, mode);
        push({ t: 'frac', kind: t.cs as FracKind, c0, c1 });
        return this.success;
      }

      else if (t.cs === 'color') {
        const color = this.parseVerbatimItem();
        const body = this.parseCell(flags, mode);
        push({ t: 'color', color, body, old: true });
        return this.success;
      }
      else if (t.cs === 'textcolor') {
        const color = this.parseVerbatimItem();
        const body = this.parseCell(FLAG_ITEM, 'text');
        push({ t: 'color', color, body, old: false });
      }
      else if (t.cs === 'normalcolor') {
        const body = this.parseCell(flags, mode);
        push({ t: 'color', color: 'normalcolor', body, old: true });
        return this.success;
      }

      else if (t.cs === 'substack') {
        const g = newGrid('substack', 1);
        this.parse1(g, FLAG_ITEM, mode, false);
        if (g.rows.length > 1) delEmptyLastRow(g);
        push({ t: 'grid', ...stripP(g) });
      }

      else if (t.cs === 'framebox' || t.cs === 'makebox') {
        const width = this.parseCell(FLAG_OPTION, 'text');
        const align = this.parseCell(FLAG_OPTION, 'text');
        const body = this.parseCell(FLAG_ITEM, 'text');
        push({ t: 'makebox', n: t.cs, width, align, body });
      }

      else if (t.cs === 'tag') {
        let n = 'tag';
        if (this.nextToken().ch === '*') { this.getToken(); n = 'tag*'; }
        const body = this.parseCell(FLAG_ITEM, 'text');
        push({ t: 'box', n, body });
      }

      else if (t.cs === 'hspace') {
        const prot = this.nextToken().ch === '*';
        if (prot) this.getToken();
        const arg = this.parseVerbatimItem();
        if (prot && arg === '\\fill') push({ t: 'space', n: 'hspace*{\\fill}' });
        else if (isValidLength(arg)) push({ t: 'space', n: prot ? 'hspace*' : 'hspace', len: arg });
        else { push({ t: 'cmd', n: 'hspace' }); push({ t: 'brace', body: this.parseSub('{' + arg + '}', mode) }); }
      }

      else if (t.cs === 'smash') {
        this.skipSpaces();
        if (this.nextToken().ch === '[') {
          const opt = this.parseVerbatimOption();
          if (opt === 't' || opt === 'b') { const body = this.parseCell(FLAG_ITEM, mode); push({ t: 'phantom', n: 'smash' + opt, body }); }
          else { const arg = this.parseVerbatimItem(); push({ t: 'cmd', n: 'smash' }); cell.push(...this.parseSub('[' + opt + ']', mode)); cell.push(...this.parseSub('{' + arg + '}', mode)); }
        } else { const body = this.parseCell(FLAG_ITEM, mode); push({ t: 'phantom', n: 'smash', body }); }
      }

      else if (t.cs === 'lyxmathsym') {
        const s = this.parseVerbatimItem();
        push({ t: 'raw', latex: '\\lyxmathsym{' + s + '}' });
      }

      else if (t.cs === ' ') push({ t: 'space', n: ' ' });

      else if (t.cs) {
        const name = t.cs;
        const isUserMacro = !!macros[name];
        const l = isUserMacro ? undefined : SYMBOLS[name];
        if (l && l.i !== 'macro') {
          if (l.i === 'big') {
            this.skipSpaces();
            const dt = this.getToken();
            const delim = dt.cs ? '\\' + dt.cs : dt.ch;
            if (isBigInsetDelim(delim)) push({ t: 'big', n: name, d: delim });
            else { push({ t: 'cmd', n: name }); if (delim) this.putback(); }
          }
          else if (l.i === 'font') {
            const m = asMode(mode, l.x);
            const body = this.parseCell(FLAG_ITEM, m);
            push({ t: 'font', n: name, body, mode: m === 'text' ? 'text' : 'math' });
          }
          else if (l.i === 'oldfont') {
            const body = this.parseCell(flags | FLAG_ALIGN, asMode(mode, l.x));
            push({ t: 'oldfont', n: name, body });
            if (this.prevToken().cat !== Cat.Align && this.prevToken().cs !== '\\') return this.success;
            this.putback();
          }
          else if (l.i === 'style' || l.i === 'textsize') {
            const body = this.parseCell(flags | FLAG_ALIGN, mode);
            push({ t: 'style', n: name, body });
            if (this.prevToken().cat !== Cat.Align && this.prevToken().cs !== '\\') return this.success;
            this.putback();
          }
          else if (l.i === 'underset' || l.i === 'overset') {
            const top = this.parseCell(FLAG_ITEM, mode);
            const body = this.parseCell(FLAG_ITEM, mode);
            push({ t: l.i, top, body });
          }
          else if (l.i === 'decoration') { const body = this.parseCell(FLAG_ITEM, mode); push({ t: 'deco', n: name, body }); }
          else if (l.i === 'class') { const body = this.parseCell(FLAG_ITEM, mode); push({ t: 'class', n: name, body }); }
          else if (l.i === 'mbox' || l.i === 'intertext') { const body = this.parseCell(FLAG_ITEM, 'text'); push({ t: 'box', n: name, body }); }
          else if (l.i === 'space') push({ t: 'space', n: name });
          else if (l.i === 'ref') { const opt = this.parseVerbatimOption(); const ref = this.parseVerbatimItem(); push(opt ? { t: 'ref', n: name, label: ref, opt } : { t: 'ref', n: name, label: ref }); }
          else if (l.i === 'matrix' || l.i === 'split') push({ t: 'cmd', n: name });   // only valid via \begin
          else push(sym(name));   // symbols, dots
        }
        else if (isUserMacro) {
          const info = macros[name];
          const nopt = info.nopt ?? 0;
          const args: Cell[] = [];
          for (let i = 0; i < nopt; i++) args.push(this.parseCell(FLAG_OPTION, mode));
          for (let i = 0; i < info.nargs - nopt; i++) { args.push(this.parseCell(FLAG_ITEM, mode)); if (mode === 'math') this.skipSpaces(); }
          push({ t: 'macro', n: name, args, nopt });
        }
        else if (FRAC_NAMES[name]) {
          const c0 = this.parseCell(FLAG_ITEM, mode); if (mode === 'math') this.skipSpaces();
          const c1 = this.parseCell(FLAG_ITEM, mode); if (mode === 'math') this.skipSpaces();
          push({ t: 'frac', kind: FRAC_NAMES[name], c0, c1 });
        }
        else if (PHANTOMS.has(name)) { const body = this.parseCell(FLAG_ITEM, mode); push({ t: 'phantom', n: name, body }); }
        else if (name === 'ensuremath') { const body = this.parseCell(FLAG_ITEM, 'math'); push({ t: 'ensuremath', body }); }
        else if (name === 'boxed' || name === 'fbox') { const body = this.parseCell(FLAG_ITEM, name === 'fbox' ? 'text' : 'math'); push({ t: 'box', n: name, body }); }
        else if (ONE_CELL_CMDS.has(name)) { const body = this.parseCell(FLAG_ITEM, mode); push({ t: 'class', n: name, body }); }   // InsetMathBoldSymbol / Lefteqn / Cancel: one cell, always braced
        else if (name === 'sideset') { const a = this.parseCell(FLAG_ITEM, mode); const b = this.parseCell(FLAG_ITEM, mode); const c = this.parseCell(FLAG_ITEM, mode); push({ t: 'macro', n: 'sideset', args: [a, b, c], nopt: 0 }); }
        else if (l && l.i === 'macro') push(sym(name));   // predefined LyX macro without arguments
        else if (mode === 'text' && !isUserMacro && SYMBOLS[name] === undefined && /^[^A-Za-z]$/.test(name) === false && name.length > 1) {
          // unknown text-mode command: keep it (LyX would try Encodings::fromLaTeXCommand)
          push({ t: 'cmd', n: name });
        }
        else push({ t: 'cmd', n: name });   // unknown command: a macro without definition (0 cells)
      }

      if (flags & FLAG_LEAVE) break;
    }
    return this.success;
  }

  private parseSub(src: string, mode: PMode): Cell {
    const p = new Parser(src, this.macros);
    return p.parseCell(0, mode);
  }

  private collectUntil(stop: (t: Token) => boolean): string {
    let s = '';
    while (this.good()) { const t = this.getToken(); if (stop(t)) { this.putback(); break; } s += t.cs ? '\\' + t.cs : t.ch; }
    return s;
  }

  newHull(type: HullType, ncols = 1): PGrid & { hull: Hull } {
    const g = newGrid('', ncols);
    const h: Hull = { env: '', ncols, rows: g.rows, type, numberedRows: [false], labels: [undefined] };
    return { ...g, rows: g.rows, hull: h };
  }
}

function stripP(g: PGrid): Grid {
  const { hull: _h, ...rest } = g;
  return rest;
}

function charOfAtom(a: Atom): string { return a.t === 'char' ? a.c : ''; }

function extraBraces(a: Atom): boolean {
  return a.t === 'color' || a.t === 'oldfont' || a.t === 'style' || (a.t === 'frac' && (a.kind === 'atop' || a.kind === 'choose' || a.kind === 'brace' || a.kind === 'brack'));
}

// LyX's InsetMathBig::isBigInsetDelim list plus \llangle/\rrangle (OverLyX's double angle brackets, see core/math/llangle.ts)
const BIG_DELIMS = new Set(['(', ')', '\\{', '\\}', '\\lbrace', '\\rbrace', '[', ']', '|', '/', '\\slash', '\\|', '\\vert', '\\Vert', "'", '<', '>', '\\\\', '\\backslash', '\\langle', '\\lceil', '\\lfloor', '\\rangle', '\\rceil', '\\rfloor', '\\llbracket', '\\rrbracket', '\\llangle', '\\rrangle', '\\downarrow', '\\Downarrow', '\\uparrow', '\\Uparrow', '\\updownarrow', '\\Updownarrow']);
export const isBigInsetDelim = (d: string) => BIG_DELIMS.has(d);

const innerHull = (name: string) => ['aligned', 'gathered', 'split', 'alignedat', 'lgathered', 'rgathered'].includes(name);

function delEmptyLastRow(g: Grid) {
  const last = g.rows[g.rows.length - 1];
  if (g.rows.length > 1 && last.cells.every(c => !c.length) && !last.hlines) g.rows.pop();
}

/** InsetMathGrid::guessColumns: number of columns of an array alignment string */
export function guessColumns(halign: string): number {
  let col = 0;
  for (const c of halign) if (c === 'c' || c === 'l' || c === 'r' || c === 'p' || c === 'm' || c === 'b') col++;
  return Math.max(col, 1);
}

const LENGTH_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)\s*(pt|mm|cm|in|ex|em|mu|sp|bp|dd|pc|cc|px|text%|col%|page%|line%|theight%|pheight%|baselineskip%)\s*$|^[+-]?(\d+(\.\d*)?|\.\d+)\\(width|height|depth|totalheight|textwidth|columnwidth|paperwidth|linewidth|textheight|paperheight|baselineskip)$/;
export function isValidLength(s: string): boolean { return LENGTH_RE.test(s.trim()); }

/* ------------------------------------------------------------------ command names */

/** Commands the parser handles itself (not in the symbol table). */
export const PARSER_COMMANDS: string[] = ['frac', 'dfrac', 'tfrac', 'cfrac', 'nicefrac', 'binom', 'dbinom', 'tbinom', 'sqrt', 'left', 'right', 'begin', 'end', 'text', 'label', 'nonumber', 'notag',
  'limits', 'nolimits', 'hline', 'cancelto', 'unit', 'unitfrac', 'stackrel', 'kern', 'mkern', 'choose', 'over', 'atop', 'brace', 'brack', 'color', 'textcolor', 'normalcolor', 'substack', 'framebox', 'makebox',
  'tag', 'hspace', 'smash', 'lyxmathsym', 'ensuremath', 'boxed', 'fbox', 'multicolumn', ...PHANTOMS, ...ONE_CELL_CMDS, ...XARROWS, ...REFS, 'sideset'];

/** Is `\name` a command LyX would understand here (symbol table, parser or a document macro)? */
export function isKnownCommand(name: string, macros: MacroTable): boolean {
  return !!macros[name] || !!SYMBOLS[name] || PARSER_COMMANDS.includes(name);
}

let allNames: string[] | null = null;
/** Completion candidates for a typed prefix: document macros first, then LyX's symbols and commands, shortest first. */
export function completeCommand(prefix: string, macros: MacroTable, limit = 12): string[] {
  if (!prefix) return [];
  if (!allNames) allNames = [...new Set([...Object.keys(SYMBOLS).filter(n => /^[A-Za-z]+\*?$/.test(n)), ...PARSER_COMMANDS])];
  const rank = (n: string) => (macros[n] ? 0 : 1);
  const own = Object.keys(macros).filter(n => n.startsWith(prefix) && n !== prefix);
  const rest = allNames.filter(n => n.startsWith(prefix) && n !== prefix && !macros[n]);
  return [...own, ...rest].sort((a, b) => rank(a) - rank(b) || a.length - b.length || a.localeCompare(b)).slice(0, limit);
}

/* ------------------------------------------------------------------ API */

/** Parse the content of a cell (no `$` / environment around it). */
export function parseCell(latex: string, macros: MacroTable = {}, mode: Mode = 'math'): Cell {
  return new Parser(latex, macros).parseCell(0, mode);
}

const HULL_ENVS: Record<string, HullType> = { equation: 'equation', eqnarray: 'eqnarray', align: 'align', alignat: 'alignat', xalignat: 'xalignat', xxalignat: 'xxalignat', flalign: 'flalign', multline: 'multline', gather: 'gather' };

const hullCols = (type: HullType): number => (type === 'eqnarray' ? 3 : type === 'align' || type === 'flalign' || type === 'alignat' || type === 'xalignat' || type === 'xxalignat' ? 2 : 1);

/** Parse a whole formula as stored in a LyX Formula inset: `$…$`, `\[…\]`, `\begin{align}…\end{align}` … */
export function parseFormula(latex: string, macros: MacroTable = {}): Hull {
  const s = latex.replace(/^\s+/, '');
  const p = new Parser(s, macros);
  const mk = (type: HullType, ncols: number): Hull => ({ env: '', ncols, rows: [{ cells: Array.from({ length: ncols }, () => [] as Cell) }], type, numberedRows: [false], labels: [undefined] });
  let h: Hull;
  const run = (hull: Hull, flags: number, numbered: boolean, opening: string) => {
    const pg: PGrid = { ...hull, hull };
    pg.rows = hull.rows;
    // skip the opening token(s)
    const inner = new Parser(s.slice(opening.length), macros);
    inner.parseGrid(pg, flags, 'math', numbered);
    hull.ncols = pg.ncols;
    return inner;
  };
  void p;
  if (s.startsWith('$')) { h = mk('simple', 1); run(h, FLAG_SIMPLE, false, '$'); h.numberedRows = [false]; return h; }
  if (s.startsWith('\\(')) { h = mk('simple', 1); run(h, FLAG_SIMPLE2, false, '\\('); return h; }
  if (s.startsWith('\\[')) { h = mk('equation', 1); run(h, FLAG_EQUATION, false, '\\['); h.numberedRows = [false]; return h; }
  const m = /^\\begin\{([a-z]+)(\*?)\}/.exec(s);
  if (m && HULL_ENVS[m[1]]) {
    const type = HULL_ENVS[m[1]];
    const numbered = !m[2];
    h = mk(type, hullCols(type));
    let opening = m[0];
    if (type === 'alignat' || type === 'xalignat' || type === 'xxalignat') { const a = /^\{\d+\}/.exec(s.slice(opening.length)); if (a) opening += a[0]; }
    const pg: PGrid = { ...h, hull: h }; pg.rows = h.rows;
    const inner = new Parser(s.slice(opening.length), macros);
    (inner as unknown as { environments: string[] }).environments.push(m[1] + m[2]);
    inner.parseGrid(pg, FLAG_END, 'math', numbered);
    h.ncols = pg.ncols;
    if (type === 'equation' && !numbered) h.numberedRows = h.numberedRows.map(() => false);
    return h;
  }
  // unknown: keep everything in one cell
  h = mk('none', 1);
  h.rows[0].cells[0] = parseCell(s, macros);
  return h;
}

/** Row and column layout helpers for the editor */
export function hullRowCount(h: Hull): number { return h.rows.length; }
export function gridCell(g: Grid, row: number, col: number): Cell { return g.rows[row].cells[col]; }
