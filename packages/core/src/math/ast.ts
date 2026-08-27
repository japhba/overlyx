/**
 * OverLyX math model — a port of LyX's mathed data structures (MathData / InsetMath*).
 *
 * A formula is a tree of *cells* (LyX `MathData`: an array of atoms) and *atoms* (LyX `InsetMath`
 * subclasses). Every atom that contains cells is an inset with a fixed number of cells; the cursor
 * lives in cells only. The set of atom kinds mirrors the LyX classes that matter for editing and
 * for a byte-exact round trip of the LaTeX LyX writes (see write.ts).
 */

export type Cell = Atom[];

export type Limits = 'limits' | 'nolimits' | undefined;

export type Atom =
  /** InsetMathChar: one character (letters, digits, operators, punctuation; spaces only in text mode) */
  | { t: 'char'; c: string }
  /** InsetMathSymbol / InsetMathDots / predefined macros without arguments: `\alpha`, `\sum`, `\ldots` */
  | { t: 'sym'; n: string; limits?: Limits }
  /** InsetMathSpace: `\,` `\;` `\!` `\quad` `~` `\hspace{len}` … (`n` is the LaTeX name without backslash) */
  | { t: 'space'; n: string; len?: string }
  /** InsetMathKern: `\kern1em` / `\mkern-3mu` */
  | { t: 'kern'; n: 'kern' | 'mkern'; len: string }
  /** InsetMathScript: nucleus with sub/superscript cells (cells exist only when present) */
  | { t: 'script'; nuc: Cell; up?: Cell; down?: Cell; limits?: Limits }
  /** InsetMathFrac / InsetMathBinom: `\frac{a}{b}` and friends; `atop`/`over` compatibility forms */
  | { t: 'frac'; kind: FracKind; c0: Cell; c1: Cell; c2?: Cell }
  /** InsetMathSqrt / InsetMathRoot */
  | { t: 'sqrt'; body: Cell; index?: Cell }
  /** InsetMathDelim: `\left l body \right r` (delimiter names as LyX stores them: `(`, `\{`→`{`, `langle`, `.`) */
  | { t: 'delim'; l: string; r: string; body: Cell }
  /** InsetMathBig: `\bigl(` — a sized delimiter without a matching inset */
  | { t: 'big'; n: string; d: string }
  /** InsetMathBrace: `{...}` written by the user (not braces around arguments) */
  | { t: 'brace'; body: Cell }
  /** InsetMathFont: `\mathrm{…}`, `\text{…}`, `\textbf{…}` … (`mode` = mode of the body) */
  | { t: 'font'; n: string; body: Cell; mode: Mode }
  /** InsetMathFontOld: `{\bf …}` (old-style font switch, body = rest of the cell) */
  | { t: 'oldfont'; n: string; body: Cell }
  /** InsetMathBox / Boxed / FBox: `\mbox{…}` `\tag{…}` `\boxed{…}` `\fbox{…}` (body in text mode except boxed) */
  | { t: 'box'; n: string; body: Cell }
  /** InsetMathMakebox: `\framebox[w][a]{…}` / `\makebox` */
  | { t: 'makebox'; n: string; width: Cell; align: Cell; body: Cell }
  /** InsetMathDecoration: `\hat{…}` `\overline{…}` `\underbrace{…}` … */
  | { t: 'deco'; n: string; body: Cell; limits?: Limits }
  /** InsetMathSize / InsetMathTextsize: `{\displaystyle …}` `{\small …}` (body = rest of the cell) */
  | { t: 'style'; n: string; body: Cell }
  /** InsetMathClass: `\mathop{…}` `\mathrel{…}` … */
  | { t: 'class'; n: string; body: Cell; limits?: Limits }
  /** InsetMathColor: `\textcolor{c}{…}` (old=false) or `{\color{c} …}` / `{\normalcolor …}` (old=true) */
  | { t: 'color'; color: string; body: Cell; old: boolean }
  /** InsetMathPhantom: `\phantom{…}` `\vphantom` `\hphantom` `\smash` `\smash[t]` `\mathclap` … */
  | { t: 'phantom'; n: string; body: Cell }
  /** InsetMathEnsureMath */
  | { t: 'ensuremath'; body: Cell }
  /** InsetMathOverset / Underset / Stackrel: `\overset{top}{body}`; stackrel may carry a `[bottom]` option */
  | { t: 'overset' | 'underset' | 'stackrel'; top: Cell; body: Cell; bottom?: Cell }
  /** InsetMathXArrow: `\xrightarrow[opt]{body}` */
  | { t: 'xarrow'; n: string; body: Cell; opt?: Cell }
  /** InsetMathRef: `\ref{label}` `\eqref{…}` … stored verbatim */
  | { t: 'ref'; n: string; label: string; opt?: string }
  /** InsetMathGrid family: matrices, cases, array, aligned/split/gathered, substack (see Grid) */
  | ({ t: 'grid' } & Grid)
  /** InsetMathMacro with a known definition and arguments (cells: optionals first, then mandatory) */
  | { t: 'macro'; n: string; args: Cell[]; nopt: number; limits?: Limits }
  /** InsetMathMacro without definition / unknown command: `\bm`, `\{`, `\_` … (no cells) */
  | { t: 'cmd'; n: string; limits?: Limits }
  /** InsetMathMacroArgument / InsetMathHash: `#1` inside a macro template, or a bare `#` */
  | { t: 'hash'; n: string }
  /** InsetMathComment: `% text` up to the end of the line */
  | { t: 'comment'; text: string }
  /** InsetMathEnv: an unknown `\begin{name} … \end{name}` kept with its body */
  | { t: 'env'; n: string; body: Cell }
  /** InsetMathString / anything LyX would keep verbatim (e.g. `\lyxmathsym`); written as is */
  | { t: 'raw'; latex: string }
  /** InsetMathUnknown: a command name being typed (macro mode, `final` false) or an unresolved one */
  | { t: 'unknown'; n: string; final: boolean; sel?: string; /** editor-only: completion suggestion and validity of the typed name */ hint?: string; valid?: boolean };

export type FracKind = 'frac' | 'dfrac' | 'tfrac' | 'cfrac' | 'cfracleft' | 'cfracright' | 'nicefrac' | 'unitfrac' | 'unit'
  | 'binom' | 'dbinom' | 'tbinom' | 'choose' | 'brace' | 'brack' | 'atop' | 'over';

export type Mode = 'math' | 'text';

/** InsetMathGrid: a rectangular block of cells with per-row/column information. */
export interface Grid {
  /** environment name: `matrix`, `pmatrix`, `cases`, `array`, `aligned`, `split`, `gathered`, `alignedat`, `substack`, `smallmatrix`, `tabular` … */
  env: string;
  rows: GridRow[];
  ncols: number;
  /** array/tabular: horizontal alignment string (`lcr`), vertical alignment (`t`/`b`/`c`) */
  halign?: string;
  valign?: string;
  /** aligned/gathered/… with a `numbered`-like flag (inner `align` used as split) */
  numbered?: boolean;
}

export interface GridRow {
  cells: Cell[];
  /** `\\[skip]` value or `*` for a `\\*` line break, as LyX's crskip/allow_newpage */
  crskip?: string;
  nonewpage?: boolean;
  /** number of `\hline` before this row */
  hlines?: number;
  /** multicolumn info for cells: [colIndex, ncols, align] */
  multi?: { col: number; ncols: number; align: string }[];
}

/** The top-level formula (InsetMathHull): the environment and rows with numbering and labels. */
export interface Hull extends Grid {
  type: HullType;
  /** one entry per row: whether the row is numbered (`\nonumber` clears it) */
  numberedRows: (boolean | 'notag')[];
  labels: (string | undefined)[];
  /** trailing `\hline`s after the last row (grids only) */
  hlinesEnd?: number;
}

export type HullType = 'simple' | 'equation' | 'eqnarray' | 'align' | 'alignat' | 'xalignat' | 'xxalignat' | 'flalign' | 'multline' | 'gather' | 'none' | 'unknown';

/** Macro definitions the parser needs: number of mandatory + optional arguments. */
export interface MacroInfo { nargs: number; nopt?: number; def?: string }
export type MacroTable = Record<string, MacroInfo>;

export const emptyCell = (): Cell => [];

/** Deep copy of a cell (atoms are plain objects). */
export function cloneCell(c: Cell): Cell {
  return c.map(cloneAtom);
}
export function cloneAtom(a: Atom): Atom {
  return JSON.parse(JSON.stringify(a)) as Atom;
}

/** All cells directly contained in an atom, in LyX's cell index order. */
export function cellsOf(a: Atom): Cell[] {
  switch (a.t) {
    case 'script': return [a.nuc, ...(a.down ? [a.down] : []), ...(a.up ? [a.up] : [])];
    case 'frac': return a.c2 ? [a.c0, a.c1, a.c2] : [a.c0, a.c1];
    case 'sqrt': return a.index ? [a.body, a.index] : [a.body];
    case 'delim': case 'brace': case 'font': case 'oldfont': case 'box': case 'deco': case 'style': case 'class': case 'color': case 'phantom': case 'ensuremath': case 'env':
      return [a.body];
    case 'makebox': return [a.width, a.align, a.body];
    case 'overset': case 'underset': case 'stackrel': return a.bottom ? [a.body, a.top, a.bottom] : [a.body, a.top];
    case 'xarrow': return a.opt ? [a.body, a.opt] : [a.body];
    case 'grid': return a.rows.flatMap(r => r.cells);
    case 'macro': return a.args;
    default: return [];
  }
}

/** The character of a one-character atom (LyX InsetMath::getChar), or '' */
export function charOf(a: Atom | undefined): string {
  return a && a.t === 'char' ? a.c : '';
}

export function isScript(a: Atom | undefined): a is Extract<Atom, { t: 'script' }> {
  return !!a && a.t === 'script';
}
