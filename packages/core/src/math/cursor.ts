/**
 * The math cursor and editing operations — a port of LyX's Cursor.cpp (math parts),
 * DocIterator, InsetMathNest::interpretChar / doDispatch and the idx* cell navigation of
 * the individual insets (LyX 2.5).
 *
 * A cursor is a stack of slices; each slice names a cell of an inset (`owner`, `idx`) and a
 * position inside it. The first slice is always a cell of the formula's hull. Cells are looked
 * up on demand (`cellAt`), exactly like LyX's CursorSlice::cell(), so edits that replace atoms
 * never invalidate the cursor.
 */
import type { Atom, Cell, Grid, Hull, HullType, MacroTable, Limits } from './ast';
import { cloneCell } from './ast';
import { parseCell, SYMBOLS } from './parse';
import { writeCellLatex } from './write';

export type Owner = Atom | Hull;
export interface Slice { owner: Owner; idx: number; pos: number }

export const isHull = (o: Owner): o is Hull => 'numberedRows' in o;

/* ------------------------------------------------------------------ cells of an inset */

/** Cells of an inset in LyX's idx order (InsetMathScript: nuc, then up/down as in LyX). */
export function atomCells(o: Owner): Cell[] {
  if (isHull(o)) return o.rows.flatMap(r => r.cells);
  const a = o;
  switch (a.t) {
    case 'script': return a.up && a.down ? [a.nuc, a.up, a.down] : a.up ? [a.nuc, a.up] : a.down ? [a.nuc, a.down] : [a.nuc];
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
export const nargs = (o: Owner) => atomCells(o).length;
/** InsetMathNest::isActive: the cursor can enter it */
export const isActive = (a: Atom) => a.t !== 'ref' && nargs(a) > 0;
/** InsetMathNest::confirmDeletion: big insets are selected before they are deleted */
export const confirmDeletion = (a: Atom) => nargs(a) > 0;

const gridOf = (o: Owner): Grid | undefined => (isHull(o) ? o : o.t === 'grid' ? o : undefined);
const ncolsOf = (o: Owner) => gridOf(o)?.ncols ?? 1;

/** Script inset helpers (InsetMathScript::idxOfScript etc.) */
const scriptIdx = (s: Extract<Atom, { t: 'script' }>, up: boolean): number => {
  if (s.up && s.down) return up ? 1 : 2;
  if (up ? s.up : s.down) return 1;
  return 0;
};

/* ------------------------------------------------------------------ the cursor */

export interface MathCursorHost {
  /** LyX x-target: the position in a cell closest to a screen x (used for up/down); default 0 */
  xToPos?: (cell: Cell, xTarget: number | null) => number;
  /** the formula was left forwards (true) or backwards (false) */
  leave?: (forward: boolean) => void;
  /** the formula should be "unlocked" from the macro table (name → nargs) */
}

export class MathCursor {
  slices: Slice[];
  anchor: Slice[] | null = null;
  private selecting = false;
  xTarget: number | null = null;

  constructor(public hull: Hull, public macros: MacroTable = {}, public host: MathCursorHost = {}) {
    this.slices = [{ owner: hull, idx: 0, pos: 0 }];
  }

  /* ---- slice accessors */
  get depth() { return this.slices.length; }
  get top(): Slice { return this.slices[this.slices.length - 1]; }
  get owner(): Owner { return this.top.owner; }
  /** the inset atom the cursor is in (undefined at hull level) */
  get inset(): Atom | undefined { return isHull(this.top.owner) ? undefined : this.top.owner; }
  cellAt(s: Slice): Cell { return atomCells(s.owner)[s.idx] ?? []; }
  get cell(): Cell { return this.cellAt(this.top); }
  get pos() { return this.top.pos; }
  set pos(p: number) { this.top.pos = p; }
  get idx() { return this.top.idx; }
  set idx(i: number) { this.top.idx = i; }
  get lastpos() { return this.cell.length; }
  get lastidx() { return nargs(this.owner) - 1; }
  get row() { return Math.floor(this.idx / ncolsOf(this.owner)); }
  get col() { return this.idx % ncolsOf(this.owner); }
  get nrows() { return gridOf(this.owner)?.rows.length ?? 1; }
  get ncols() { return ncolsOf(this.owner); }
  nextAtom(): Atom | undefined { return this.cell[this.pos]; }
  prevAtom(): Atom | undefined { return this.cell[this.pos - 1]; }
  get selection() { return this.selecting && this.anchor !== null; }

  clone(): Slice[] { return this.slices.map(s => ({ ...s })); }
  setSlices(s: Slice[]) { this.slices = s.map(x => ({ ...x })); }
  /** same cell: same owner and idx */
  static sameCell(a: Slice, b: Slice) { return a.owner === b.owner && a.idx === b.idx; }

  /* ---- selection (Cursor::selHandle, resetAnchor, selBegin/selEnd) */
  resetAnchor() { this.anchor = this.clone(); }
  clearSelection() { this.selecting = false; this.anchor = null; }
  selHandle(selecting: boolean): boolean {
    if (selecting === this.selecting) return false;
    if (selecting) this.resetAnchor();
    else this.anchor = null;
    this.selecting = selecting;
    return true;
  }
  /** the selection's common cell and its range [from, to) with idx range for grids (LyX selBegin/selEnd) */
  selRange(): { owner: Owner; idx1: number; idx2: number; from: number; to: number; depth: number } | null {
    if (!this.selection || !this.anchor) return null;
    const a = this.anchor, c = this.slices;
    let d = 0;
    while (d < a.length && d < c.length && a[d].owner === c[d].owner && (a[d].idx === c[d].idx || gridOf(a[d].owner))) d++;
    if (d === 0) return null;
    const i = d - 1;
    const sa = a[i], sc = c[i];
    if (sa.idx !== sc.idx) return { owner: sa.owner, idx1: Math.min(sa.idx, sc.idx), idx2: Math.max(sa.idx, sc.idx), from: 0, to: 0, depth: i };
    // positions: if one side is deeper, its position in this cell is the index of the inset it descends into (+1 for the end)
    const pa = a.length > d ? a[d].pos + 0 : sa.pos;
    const pc = c.length > d ? c[d].pos + 0 : sc.pos;
    let from = Math.min(pa, pc), to = Math.max(pa, pc);
    if (a.length > d || c.length > d) { const deeperPos = (a.length > d ? a[i + 1] : c[i + 1]); void deeperPos; }
    // LyX: selBegin/selEnd are the slices at the common depth; a deeper side contributes the position of its inset
    const posAt = (s: Slice[]) => (s.length > d ? s[d].pos : s[i].pos);
    // when one side is inside an inset at position p of this cell, the range must include that inset
    const endAt = (s: Slice[]) => (s.length > d ? s[d].pos + 1 : s[i].pos);
    const aIsBegin = posAt(a) < posAt(c) || (posAt(a) === posAt(c) && a.length <= c.length);
    from = aIsBegin ? posAt(a) : posAt(c);
    to = aIsBegin ? endAt(c) : endAt(a);
    return { owner: sa.owner, idx1: sa.idx, idx2: sa.idx, from, to, depth: i };
  }
  /** cap::grabSelection: LaTeX of the selection */
  grabSelection(): string {
    const r = this.selRange();
    if (!r) return '';
    if (r.idx1 === r.idx2) return writeCellLatex(this.cellAt({ owner: r.owner, idx: r.idx1, pos: 0 }).slice(r.from, r.to));
    const g = gridOf(r.owner)!;
    const nc = g.ncols;
    const r1 = Math.floor(r.idx1 / nc), r2 = Math.floor(r.idx2 / nc), c1 = Math.min(r.idx1 % nc, r.idx2 % nc), c2 = Math.max(r.idx1 % nc, r.idx2 % nc);
    const parts: string[] = [];
    for (let row = r1; row <= r2; row++) { const cells: string[] = []; for (let col = c1; col <= c2; col++) cells.push(writeCellLatex(g.rows[row].cells[col])); parts.push(cells.join('&')); }
    return parts.join('\\\\');
  }
  /** cap::eraseSelection */
  eraseSelection(): boolean {
    const r = this.selRange();
    if (!r) return false;
    this.slices = this.slices.slice(0, r.depth + 1);
    this.top.idx = r.idx1;
    if (r.idx1 === r.idx2) {
      this.cell.splice(r.from, r.to - r.from);
      this.top.pos = r.from;
    } else {
      const g = gridOf(r.owner)!;
      const nc = g.ncols;
      const r1 = Math.floor(r.idx1 / nc), r2 = Math.floor(r.idx2 / nc), c1 = Math.min(r.idx1 % nc, r.idx2 % nc), c2 = Math.max(r.idx1 % nc, r.idx2 % nc);
      for (let row = r1; row <= r2; row++) for (let col = c1; col <= c2; col++) g.rows[row].cells[col].splice(0);
      this.top.pos = 0;
    }
    this.clearSelection();
    return true;
  }
  grabAndEraseSelection(): string { const s = this.grabSelection(); this.eraseSelection(); return s; }
  /** cap::selClearOrDel with auto_region_delete */
  selClearOrDel() { if (this.selection) this.eraseSelection(); else this.clearSelection(); }
  selectAll() { this.slices = this.slices.slice(0, 1); this.top.idx = 0; this.top.pos = 0; this.resetAnchor(); this.selecting = true; this.top.idx = this.lastidx; this.top.pos = this.lastpos; }

  /* ---- basic movement (DocIterator) */
  posForward(): boolean { if (this.pos === this.lastpos) return false; this.top.pos++; return true; }
  posBackward(): boolean { if (this.pos === 0) return false; this.top.pos--; return true; }
  push(a: Atom, idx = 0, pos = 0) { this.slices.push({ owner: a, idx, pos }); }
  pop(): boolean { if (this.depth === 1) return false; this.slices.pop(); return true; }
  popBackward(): boolean { return this.pop(); }
  popForward(): boolean { if (this.depth === 1) return false; this.slices.pop(); this.top.pos++; return true; }
  /** Cursor::pushBackward: enter an inset at its first cell */
  pushBackward(a: Atom) { this.push(a); this.idxFirst(); }

  /** InsetMathNest::idxFirst / idxLast (with the per-inset overrides) */
  idxFirst(): boolean {
    const o = this.owner;
    if (isHull(o)) { this.idx = 0; this.pos = 0; return true; }
    if (!isActive(o)) return false;
    this.idx = o.t === 'sqrt' && o.index ? 1 : o.t === 'macro' ? o.nopt : 0;   // root: index first; macros: first mandatory arg
    this.pos = 0;
    return true;
  }
  idxLast(): boolean {
    const o = this.owner;
    if (isHull(o)) { this.idx = this.lastidx; this.pos = this.lastpos; return true; }
    if (!isActive(o)) return false;
    this.idx = o.t === 'sqrt' && o.index ? 0 : this.lastidx;
    this.pos = this.lastpos;
    return true;
  }
  /** InsetMathNest::idxNext / idxPrev */
  idxNext(): boolean { if (this.idx === this.lastidx) return false; this.idx++; this.pos = 0; return true; }
  idxPrev(): boolean { if (this.idx === 0) return false; this.idx--; this.pos = this.lastpos; return true; }
  /** idxForward / idxBackward: moving on to the next cell of the same inset (scripts: never) */
  idxForward(): boolean {
    const o = this.owner;
    if (isHull(o) || o.t === 'grid') { if (this.col + 1 === this.ncols) return false; this.idx++; this.pos = 0; return true; }
    if (o.t === 'script') return false;
    if (o.t === 'sqrt') { if (this.idx === 0) return false; this.idx = 0; this.pos = 0; return true; }
    if (o.t === 'frac') return false;
    return this.idxNext();
  }
  idxBackward(): boolean {
    const o = this.owner;
    if (isHull(o) || o.t === 'grid') { if (this.col === 0) return false; this.idx--; this.pos = this.lastpos; return true; }
    if (o.t === 'script') return false;
    if (o.t === 'sqrt') { if (!o.index || this.idx === 1) return false; this.idx = 1; this.pos = this.lastpos; return true; }
    if (o.t === 'frac') return false;
    return this.idxPrev();
  }
  /** idxUpDown of the owner inset */
  idxUpDown(up: boolean): boolean {
    const o = this.owner;
    if (isHull(o) || o.t === 'grid') {
      const g = o as Grid;
      if (up) { if (this.row === 0) return false; this.idx -= g.ncols; } else { if (this.row + 1 >= g.rows.length) return false; this.idx += g.ncols; }
      this.pos = this.host.xToPos ? this.host.xToPos(this.cell, this.xTarget) : 0;
      return true;
    }
    switch (o.t) {
      case 'script': {
        if (this.idx === 0) {
          const has = up ? o.up : o.down;
          if (!has) return false;
          if (this.pos === this.lastpos || this.pos === 0) { this.idx = scriptIdx(o, up); this.pos = 0; return true; }
          return false;
        }
        if (this.idx === scriptIdx(o, true)) { if (up) return false; this.idx = 0; this.pos = this.lastpos; return true; }
        if (this.idx === scriptIdx(o, false)) { if (!up) return false; this.idx = 0; this.pos = this.lastpos; return true; }
        return false;
      }
      case 'frac': {
        // InsetMathFrac::idxUpDown: numerator <-> denominator
        if (o.kind === 'unit' || (o.kind === 'unitfrac' && o.c2)) return false;
        const target = up ? 0 : 1;
        if (this.idx === target) return false;
        this.idx = target;
        this.pos = this.host.xToPos ? this.host.xToPos(this.cell, this.xTarget) : 0;
        return true;
      }
      case 'sqrt': {
        if (!o.index) return false;
        const target = up ? 1 : 0;
        if (this.idx === target) return false;
        this.idx = target; this.pos = up ? this.lastpos : 0;
        return true;
      }
      case 'overset': case 'underset': case 'stackrel': {
        // cell 0 = body, cell 1 = top (overset) / bottom (underset)
        const topIsUp = o.t !== 'underset';
        const target = (up === topIsUp) ? 1 : 0;
        if (this.idx === target) return false;
        this.idx = target; this.pos = this.host.xToPos ? this.host.xToPos(this.cell, this.xTarget) : 0;
        return true;
      }
      case 'xarrow': {
        if (!o.opt) return false;
        const target = up ? 0 : 1;
        if (this.idx === target) return false;
        this.idx = target; this.pos = 0;
        return true;
      }
      default: return false;
    }
  }

  /** Cursor::openable: can the cursor move into this atom? */
  openable(a: Atom | undefined): boolean {
    if (!a || !isActive(a)) return false;
    if (!this.selection || !this.anchor) return true;
    // we can't move into anything new during selection
    if (this.depth >= this.anchor.length) return false;
    return this.anchor[this.depth].owner === a;
  }

  /** Cursor::mathForward */
  mathForward(word = false): boolean {
    if (this.pos < this.lastpos) {
      if (word) {
        const mc = mathClass(this.nextAtom()!);
        do this.posForward(); while (this.pos < this.lastpos && mc === mathClass(this.nextAtom()!));
        if (this.pos < this.lastpos) { const m2 = mathClass(this.nextAtom()!); if (m2 === 'bin' || m2 === 'rel' || m2 === 'punct') do this.posForward(); while (this.pos < this.lastpos && m2 === mathClass(this.nextAtom()!)); }
      } else if (this.openable(this.nextAtom())) {
        this.pushBackward(this.nextAtom()!);
      } else this.posForward();
      return true;
    }
    if (this.idxForward()) return true;
    if (this.depth >= 2 && this.popForward()) return true;
    return false;
  }
  /** Cursor::mathBackward */
  mathBackward(word = false): boolean {
    if (this.pos > 0) {
      if (word) {
        const mc = mathClass(this.prevAtom()!);
        do this.posBackward(); while (this.pos > 0 && mc === mathClass(this.prevAtom()!));
        if (this.pos > 0 && (mc === 'bin' || mc === 'rel' || mc === 'punct')) { const m2 = mathClass(this.prevAtom()!); do this.posBackward(); while (this.pos > 0 && m2 === mathClass(this.prevAtom()!)); }
      } else if (this.openable(this.prevAtom())) {
        this.posBackward();
        this.push(this.nextAtom()!);
        this.idxLast();
      } else this.posBackward();
      return true;
    }
    if (this.idxBackward()) return true;
    if (this.depth >= 2 && this.popBackward()) return true;
    return false;
  }

  /** Cursor::upDownInMath (without the screen-y checks; the view supplies xToPos) */
  upDown(up: boolean): boolean {
    const old = this.clone();
    if (!this.selection) {
      if (this.pos !== 0) {
        const p = this.prevAtom();
        if (p && p.t === 'script' && (up ? p.up : p.down)) { this.top.pos--; this.push(p, scriptIdx(p, up)); this.pos = this.lastpos; return true; }
      }
      if (this.pos !== this.lastpos) {
        const n = this.nextAtom();
        if (n && n.t === 'script' && (up ? n.up : n.down)) { this.push(n, scriptIdx(n, up)); this.pos = 0; return true; }
      }
    }
    if (this.idxUpDown(up)) return true;
    if (this.depth >= 2) {
      // leave the inset upwards/downwards: try the parent's cells
      this.popBackward();
      if (this.idxUpDown(up)) return true;
      // no vertical neighbour: stay where we came from
      this.setSlices(old);
      // LyX moves the cursor out of the inset when there is nothing above/below; we do the same
      this.popBackward();
      return true;
    }
    this.setSlices(old);
    return false;
  }

  /** LFUN_LINE_BEGIN / LFUN_LINE_END */
  lineBegin(): boolean {
    this.macroModeClose();
    if (this.pos !== 0) this.pos = 0;
    else if (this.col !== 0) { this.idx -= this.col; this.pos = 0; }
    else if (this.idx !== 0) { this.idx = 0; this.pos = 0; }
    else return false;
    return true;
  }
  lineEnd(): boolean {
    this.macroModeClose();
    if (this.pos !== this.lastpos) this.pos = this.lastpos;
    else if (this.ncols > 1 && this.col !== this.ncols - 1) { this.idx = this.idx - this.col + this.ncols - 1; this.pos = this.lastpos; }
    else if (this.idx !== this.lastidx) { this.idx = this.lastidx; this.pos = this.lastpos; }
    else return false;
    return true;
  }
  /** LFUN_CELL_FORWARD / BACKWARD (Tab): next cell of the inset, or out */
  cellForward() {
    this.selHandle(false); this.macroModeClose();
    if (!this.idxNext()) { if (this.lastidx === 0) this.popForward(); else { this.idx = 0; this.pos = 0; } }
  }
  cellBackward() {
    this.selHandle(false); this.macroModeClose();
    if (!this.idxPrev()) { if (this.lastidx === 0) this.popBackward(); else { this.idx = this.lastidx; this.pos = 0; } }
  }

  /* ---- insertion */
  plainInsert(a: Atom) { this.cell.splice(this.pos, 0, a); this.top.pos++; }
  plainErase() { this.cell.splice(this.pos, 1); }
  /** Cursor::insert(MathAtom) */
  insertAtom(a: Atom) { this.macroModeClose(); this.selClearOrDel(); this.plainInsert(a); }
  /** Cursor::insert(MathData) */
  insertCell(md: Cell) { this.macroModeClose(); if (this.selection) this.eraseSelection(); this.cell.splice(this.pos, 0, ...md); this.top.pos += md.length; }
  insertChar(c: string) { this.selClearOrDel(); this.insertAtom({ t: 'char', c }); }
  /** Cursor::niceInsert(MathAtom): insert an inset, move the selection into its first cell and the cursor into it */
  niceInsertAtom(a: Atom) {
    this.macroModeClose();
    const safe = this.grabAndEraseSelection();
    this.plainInsert(a);
    if (isActive(a)) {
      const first = a.t === 'sqrt' && a.index ? 1 : a.t === 'macro' ? a.nopt : 0;
      const cells = atomCells(a);
      if (safe) cells[first].splice(0, 0, ...parseCell(safe, this.macros, this.mode === 'text' ? 'text' : 'math'));
      this.editInsertedInset();
    }
  }
  /** Cursor::niceInsert(docstring): parse and insert; a single inset is entered */
  niceInsert(latex: string, enter = true): number {
    if (!latex) return 0;
    const md = parseCell(latex, this.macros, this.mode === 'text' ? 'text' : 'math');
    if (md.length === 1 && (enter || this.selection)) this.niceInsertAtom(md[0]);
    else this.insertCell(md);
    return md.length;
  }
  /** Cursor::editInsertedInset: enter the inset just inserted (first empty cell) */
  editInsertedInset() {
    if (this.pos === 0) return;
    const p = this.prevAtom()!;
    if (!isActive(p)) return;
    this.posBackward();
    this.push(p);
    this.idxFirst();
    if (this.cell.length) { if (!this.idxNext()) this.popForward(); }
  }
  /** Cursor::handleNest: wrap the selection into a nest inset (e.g. \left..\right, fonts) */
  handleNest(a: Atom) {
    const safe = this.grabAndEraseSelection();
    const cells = atomCells(a);
    if (cells.length) cells[a.t === 'macro' ? a.nopt : 0].push(...parseCell(safe, this.macros, this.mode === 'text' ? 'text' : 'math'));
    this.insertAtom(a);
    this.editInsertedInset();
  }

  /** the mode of the cell the cursor is in (text inside \text{}, \mbox{} …) */
  get mode(): 'math' | 'text' {
    for (let i = this.slices.length - 1; i >= 1; i--) {
      const o = this.slices[i].owner as Atom;
      if (o.t === 'font') return o.mode;
      if (o.t === 'box') return o.n === 'boxed' ? 'math' : 'text';
      if (o.t === 'color' && !o.old) return 'text';
      if (o.t === 'ensuremath' || o.t === 'macro') return 'math';
      if (o.t === 'makebox') return 'text';
      if (o.t === 'grid' && o.env === 'tabular') return 'text';
    }
    return 'math';
  }

  /* ---- macro mode (typing a command name after a backslash) */
  inMacroMode(): boolean { const p = this.prevAtom(); return !!p && p.t === 'unknown' && !p.final; }
  activeMacro(): Extract<Atom, { t: 'unknown' }> | null { const p = this.prevAtom(); return p && p.t === 'unknown' && !p.final ? p : null; }
  macroName(): string { return this.activeMacro()?.n ?? ''; }
  /** Cursor::macroModeClose: turn the typed name into the real inset */
  macroModeClose(cancel = false): boolean {
    const p = this.activeMacro();
    if (!p) return false;
    p.final = true;
    const sel = p.sel ?? '';
    const s = p.n;
    this.top.pos--;
    this.plainErase();
    if (s === '\\' || cancel) return false;
    const name = s.slice(1);
    // \limits / \nolimits apply to the previous atom
    if (name === 'limits' || name === 'nolimits') {
      const prev = this.prevAtom() as { limits?: Limits } | undefined;
      if (prev && allowsLimitsChange(prev as Atom)) { prev.limits = name; return true; }
      return false;
    }
    // \bigl( etc.: a size modifier followed by a delimiter
    const big = /^(big|Big|bigg|Bigg|biggg|Biggg)[lmr]?$/.test(name) ? name : null;
    const userMacro = this.macros[name];
    let atom: Atom;
    if (userMacro) atom = { t: 'macro', n: name, args: Array.from({ length: userMacro.nargs }, () => [] as Cell), nopt: userMacro.nopt ?? 0 };
    else if (big) atom = { t: 'unknown', n: '\\' + name, final: true };
    else if (name === 'left' || name === 'right') atom = { t: 'unknown', n: '\\' + name, final: true };
    else atom = createInsetMath(name, this.macros);
    // selection as the first argument
    const cells = atomCells(atom);
    if (cells.length && sel) cells[atom.t === 'macro' ? atom.nopt : atom.t === 'sqrt' && atom.index ? 1 : 0].push(...parseCell(sel, this.macros));
    // mode changes: a text command inside math is wrapped … we keep it simple and insert directly
    this.plainInsert(atom);
    return true;
  }

  /* ---- InsetMathNest::interpretChar */
  interpretChar(c: string): boolean {
    let saveSelection = '';
    if (c === '^' || c === '_') saveSelection = this.grabAndEraseSelection();
    this.xTarget = null;
    if (this.inMacroMode()) {
      const p = this.activeMacro()!;
      const name = p.n;
      if (name === '\\#') { this.backspace(); const n = Number(c); if (n >= 1 && n <= 9) this.insertAtom({ t: 'hash', n: '#' + n }); return true; }
      const starMacro = c === '*' && (SYMBOLS[name.slice(1) + '*'] || this.macros[name.slice(1) + '*']);
      if (/^[A-Za-z]$/.test(c) || starMacro) { p.n = name + c; return true; }
      if (name === '\\') {
        if (c === '\\') { this.backspace(); this.niceInsertAtom(this.mode === 'text' ? { t: 'cmd', n: 'textbackslash' } : { t: 'sym', n: 'backslash' }); }
        else if (c === '^' && this.mode === 'math') { this.backspace(); this.niceInsertAtom({ t: 'sym', n: 'mathcircumflex' }); }
        else if (c === '{' || c === '%') {
          const sel = p.sel ?? '';
          this.backspace();
          if (c === '{') this.niceInsertAtom({ t: 'brace', body: parseCell(sel, this.macros) });
          else this.niceInsertAtom({ t: 'comment', text: sel });
        } else if (c === '#') p.n = name + c;
        else { this.backspace(); this.niceInsertAtom(createInsetMath(c, this.macros)); }
        return true;
      }
      const bigName = name.slice(1);
      if (/^(big|Big|bigg|Bigg|biggg|Biggg)[lmr]?$/.test(bigName)) {
        const delim = c === '{' ? '\\{' : c === '}' ? '\\}' : c;
        if (isBigDelim(delim)) { p.final = true; this.top.pos--; this.plainErase(); this.plainInsert({ t: 'big', n: bigName, d: delim }); return true; }
      }
      if ((bigName === 'left' || bigName === 'right') && (isBigDelim(c) || c === '.')) {
        // LyX has no special case; we insert the delimiter pair as the math-delim command does
        p.final = true; this.top.pos--; this.plainErase();
        if (bigName === 'left') { const pair = matchingDelim(c); this.handleNest({ t: 'delim', l: delimName(c), r: delimName(pair), body: [] }); }
        else this.popForwardIfIn('delim');
        return true;
      }
      if (this.macroModeClose()) {
        const atom = this.prevAtom();
        if (atom && isActive(atom)) { this.posBackward(); this.push(atom); this.idxFirst(); if (this.cell.length && !this.idxNext()) this.popForward(); }
      }
      if (c === '{') this.niceInsertAtom({ t: 'brace', body: [] });
      else if (c !== ' ') this.interpretChar(c);
      return true;
    }
    if (this.selection && c === ' ') { this.clearSelection(); return true; }
    if (c === '\\') {
      const safe = this.grabAndEraseSelection();
      this.insertAtom({ t: 'unknown', n: '\\', final: false, sel: safe });
      return true;
    }
    this.selClearOrDel();
    const mode = this.mode;
    if (c === '\n') { if (mode !== 'math') this.insertChar(c); return true; }
    if (c === ' ') {
      if (mode !== 'math') {
        const pos = this.pos, last = this.lastpos;
        const prev = this.prevAtom(), next = this.nextAtom();
        const isSp = (a: Atom | undefined) => !!a && a.t === 'char' && a.c === ' ';
        if ((pos === 0 && last === 0) || (pos === 0 && !isSp(next)) || (pos === last && !isSp(prev)) || (pos > 0 && !isSp(prev) && !isSp(next))) this.insertChar(c);
        return true;
      }
      const prev = this.prevAtom();
      if (this.pos !== 0 && prev && prev.t === 'space' && prev.len === undefined) { prev.n = nextSpace(prev.n); return true; }
      if (this.popForward()) return true;
      return this.pos !== this.lastpos;   // at the very end: leave the formula (caller handles false)
    }
    if (mode !== 'text') {
      if (c === '_') { this.script(false, saveSelection); return true; }
      if (c === '^') { this.script(true, saveSelection); return true; }
      if (c === '~') { this.niceInsertAtom({ t: 'sym', n: 'sim' }); return true; }
    } else {
      if (c === '^') { this.niceInsertAtom({ t: 'cmd', n: 'textasciicircum' }); return true; }
      if (c === '~') { this.niceInsertAtom({ t: 'cmd', n: 'textasciitilde' }); return true; }
    }
    if (c === '{' || c === '}' || c === '&' || c === '$' || c === '#' || c === '%' || c === '_') { this.niceInsertAtom(createInsetMath(c, this.macros)); return true; }
    this.insertChar(c);
    return true;
  }

  private popForwardIfIn(t: Atom['t']) { if (this.depth >= 2 && (this.owner as Atom).t === t) this.popForward(); }

  /** InsetMathNest::script: ^ and _ */
  script(up: boolean, saveSelection = ''): boolean {
    if (this.inMacroMode() && this.macroName() === '\\') {
      if (up) this.niceInsertAtom({ t: 'sym', n: 'mathcircumflex' }); else this.interpretChar('_');
      return true;
    }
    this.macroModeClose();
    const o = this.owner;
    if (!isHull(o) && o.t === 'script' && this.idx === 0) {
      ensureScript(o, up);
      this.idx = scriptIdx(o, up); this.pos = 0;
    } else if (this.pos !== 0 && this.prevAtom()!.t === 'script') {
      this.top.pos--;
      const s = this.nextAtom() as Extract<Atom, { t: 'script' }>;
      this.push(s);
      ensureScript(s, up);
      this.idx = scriptIdx(s, up); this.pos = this.lastpos;
    } else {
      let s: Extract<Atom, { t: 'script' }>;
      if (this.pos === 0) { s = { t: 'script', nuc: [] }; this.insertAtom(s); }
      else { s = { t: 'script', nuc: [this.prevAtom()!] }; this.cell[this.pos - 1] = s; }
      ensureScript(s, up);
      this.top.pos--;
      this.push(s, 1, 0);
    }
    this.niceInsert(saveSelection, false);
    this.resetAnchor(); this.clearSelection();
    return true;
  }

  /* ---- deletion (Cursor::backspace / erase / pullArg) */
  backspace(force = false): boolean {
    if (this.selection) { this.eraseSelection(); return true; }
    if (this.pos === 0) {
      const o = this.owner;
      if (this.lastpos === 0 && nargs(o) === 1 && !isHull(o)) {
        // empty one-cell inset: delete it
        this.popBackward(); this.plainErase(); this.clearSelection(); return true;
      }
      if (isHull(o)) return false;   // at the very start of the formula: leave
      if (o.t === 'grid' || isHull(o)) { return this.mathBackward(); }
      this.pullArg();
      return true;
    }
    if (this.inMacroMode()) { const p = this.activeMacro()!; if (p.n.length > 1) { p.n = p.n.slice(0, -1); return true; } }
    const prev = this.prevAtom()!;
    if (!force && confirmDeletion(prev)) { this.resetAnchor(); this.selecting = true; this.top.pos--; return true; }
    this.top.pos--; this.plainErase();
    return true;
  }
  erase(force = false): boolean {
    if (this.inMacroMode()) return true;
    if (this.selection) { this.eraseSelection(); return true; }
    const o = this.owner;
    if (this.pos === this.lastpos && this.idxDelete()) return true;
    if (this.pos === this.lastpos) {
      if (isHull(o)) return false;
      const oneCell = nargs(o) === 1;
      if (oneCell && this.lastpos === 0) { this.popBackward(); this.plainErase(); this.clearSelection(); return true; }
      if (!oneCell) this.idxGlue(); else this.pullArg();   // LyX ≥ 2.4 leaves one-cell insets alone; users expect the dissolve
      return true;
    }
    const next = this.nextAtom()!;
    if (!force && confirmDeletion(next)) { this.resetAnchor(); this.selecting = true; this.top.pos++; return true; }
    this.plainErase();
    return true;
  }
  /** Cursor::pullArg: replace the inset by the content of the current cell */
  pullArg(): boolean {
    const md = this.cell.slice();
    if (!this.popBackward()) return false;
    this.plainErase();
    this.cell.splice(this.pos, 0, ...md);
    this.clearSelection();
    return true;
  }
  /** InsetMathGrid::idxDelete: delete an empty row when Delete is pressed at its end */
  private idxDelete(): boolean {
    const g = gridOf(this.owner);
    if (!g || g.rows.length === 1) return false;
    if (isHull(this.owner) && !ROW_HULLS.has(this.owner.type)) return false;
    const row = this.row;
    if (!g.rows[row].cells.every(c => !c.length)) return false;
    this.delRow(row);
    if (this.idx >= g.rows.length * g.ncols) this.idx = g.rows.length * g.ncols - 1;
    this.pos = this.lastpos;
    return true;
  }
  /** InsetMathGrid::idxGlue: join with the next cell / row */
  private idxGlue() {
    const g = gridOf(this.owner);
    if (!g) return;
    const c = this.col, r = this.row;
    if (c + 1 === g.ncols) {
      if (r + 1 !== g.rows.length) { for (let cc = 0; cc < g.ncols; cc++) g.rows[r].cells[c].push(...g.rows[r + 1].cells[cc]); this.delRow(r + 1); }
    } else {
      g.rows[r].cells[c].push(...g.rows[r].cells[c + 1]);
      for (let cc = c + 2; cc < g.ncols; cc++) g.rows[r].cells[cc - 1] = g.rows[r].cells[cc];
      g.rows[r].cells[g.ncols - 1] = [];
    }
  }

  /* ---- rows of grids and hulls */
  addRow(row: number) {
    const g = gridOf(this.owner);
    if (!g) return;
    if (isHull(this.owner) && !ROW_HULLS.has(this.owner.type)) return;
    g.rows.splice(row + 1, 0, { cells: Array.from({ length: g.ncols }, () => [] as Cell) });
    if (isHull(this.owner)) {
      const h = this.owner;
      let numbered = numberedType(h);
      let label: string | undefined;
      if (h.type === 'multline') { if (row + 1 === g.rows.length - 1) { h.numberedRows[row] = false; label = h.labels[row]; h.labels[row] = undefined; } else numbered = false; }
      h.numberedRows.splice(row + 1, 0, numbered);
      h.labels.splice(row + 1, 0, label);
    }
  }
  delRow(row: number) {
    const g = gridOf(this.owner);
    if (!g || g.rows.length <= 1) return;
    if (isHull(this.owner) && !ROW_HULLS.has(this.owner.type)) return;
    g.rows.splice(row, 1);
    if (isHull(this.owner)) { this.owner.numberedRows.splice(row, 1); this.owner.labels.splice(row, 1); }
  }

  /* ---- LyX tabular-feature append-row / delete-row / append-column / delete-column in grids
     (matrices, cases, arrays) and multi-row hulls (InsetMathGrid::doDispatch; InsetMathHull
     restricts rows to rowChangeOK() and columns to colChangeOK() types) */
  /** Can rows be added / removed at the cursor (LyX InsetMathHull::rowChangeOK for hulls)? */
  gridRowsOK(): boolean {
    const g = gridOf(this.owner);
    return !!g && (!isHull(this.owner) || ROW_HULLS.has(this.owner.type));
  }
  /** Can columns be added / removed at the cursor (InsetMathHull::colChangeOK)? */
  gridColsOK(): boolean {
    const g = gridOf(this.owner);
    return !!g && (!isHull(this.owner) || COL_HULLS.has(this.owner.type));
  }
  /** append-row: a new row below the current one; the cursor moves into it */
  gridAppendRow(): boolean {
    if (!this.gridRowsOK()) return false;
    const g = gridOf(this.owner)!;
    const r = this.row, c = this.col;
    this.addRow(r);
    this.idx = (r + 1) * g.ncols + c;
    this.pos = 0;
    return true;
  }
  /** delete-row: remove the current row (the last row of a grid stays) */
  gridDeleteRow(): boolean {
    if (!this.gridRowsOK()) return false;
    const g = gridOf(this.owner)!;
    if (g.rows.length <= 1) return false;
    const r = this.row, c = this.col;
    this.delRow(r);
    this.idx = Math.min(r, g.rows.length - 1) * g.ncols + c;
    this.pos = 0;
    return true;
  }
  /** append-column: a new column right of the current one; the cursor moves into it */
  gridAppendColumn(): boolean {
    if (!this.gridColsOK()) return false;
    const g = gridOf(this.owner)!;
    const r = this.row, c = this.col;
    addCol(g, c + 1);
    if (!isHull(this.owner) && g.halign !== undefined) g.halign = g.halign.slice(0, c + 1) + 'c' + g.halign.slice(c + 1);
    this.idx = r * g.ncols + c + 1;
    this.pos = 0;
    return true;
  }
  /** delete-column: remove the current column (the last column stays) */
  gridDeleteColumn(): boolean {
    if (!this.gridColsOK()) return false;
    const g = gridOf(this.owner)!;
    if (g.ncols <= 1) return false;
    const r = this.row, c = this.col;
    delCol(g, c);
    if (!isHull(this.owner) && g.halign !== undefined) g.halign = g.halign.slice(0, c) + g.halign.slice(c + 1);
    this.idx = r * g.ncols + Math.min(c, g.ncols - 1);
    this.pos = 0;
    return true;
  }
  /** LFUN_NEWLINE_INSERT: split the current row at the cursor (hulls mutate simple/equation into align first) */
  newline() {
    const o = this.owner;
    if (isHull(o) && (o.type === 'simple' || o.type === 'equation')) {
      const p = this.pos;
      mutateHull(o, 'align');
      let pos = p;
      for (let idx = 0; idx < nargs(o); idx++) { const c = atomCells(o)[idx]; if (c.length < pos) pos -= c.length; else { this.idx = idx; this.pos = pos; break; } }
    }
    const g = gridOf(this.owner);
    if (!g) { this.insertAtom({ t: 'cmd', n: '\\' }); return; }
    if (isHull(this.owner) && !ROW_HULLS.has(this.owner.type)) return;
    const oldr = this.row, oldc = this.col;
    this.addRow(oldr);
    const rows = g.rows;
    for (let c = oldc + 1; c < g.ncols; c++) { const t = rows[oldr].cells[c]; rows[oldr].cells[c] = rows[oldr + 1].cells[c]; rows[oldr + 1].cells[c] = t; }
    // split the current cell at the cursor: the tail goes to the new row's cell in the same column
    const tail = this.cell.splice(this.pos);
    rows[oldr + 1].cells[oldc].splice(0, 0, ...tail);
    this.idx = (oldr + 1) * g.ncols + oldc;
    this.pos = 0;
  }

  /* ---- fonts (InsetMathNest::handleFont) */
  handleFont(font: string) {
    const o = this.owner;
    if (!isHull(o) && (o.t === 'font' || o.t === 'class') && o.n === font) {
      // toggle off: split the font inset around the cursor / selection
      const safe = this.selection ? this.grabAndEraseSelection() : '';
      if (this.lastpos !== 0) {
        if (this.pos === 0) this.popBackward();
        else if (this.pos === this.lastpos) this.popForward();
        else {
          const head = this.cell.splice(0, this.pos);
          const at: Atom = { ...(o as Extract<Atom, { t: 'font' }>), body: head };
          this.popBackward(); this.plainInsert(at);
        }
      } else { this.popBackward(); this.plainErase(); }
      if (safe) this.insertCell(parseCell(safe, this.macros));
      return;
    }
    this.handleNest(createInsetMath(font, this.macros));
  }

  /* ---- hull-level commands */
  numberToggle() {
    const h = this.hull;
    const old = numberedType(h);
    if (h.type === 'multline') { const row = h.rows.length - 1; h.numberedRows[row] = !old; if (old) h.labels[row] = undefined; }
    else for (let row = 0; row < h.rows.length; row++) { h.numberedRows[row] = !old; if (old) h.labels[row] = undefined; }
  }
  numberLineToggle() {
    const h = this.hull;
    const r = h.type === 'multline' ? h.rows.length - 1 : this.slices[0].idx / h.ncols | 0;
    const old = h.numberedRows[r] === true;
    h.numberedRows[r] = !old;
    if (old) h.labels[r] = undefined;
  }
  setLabel(label: string) {
    const h = this.hull;
    const r = h.type === 'multline' ? h.rows.length - 1 : this.slices[0].idx / h.ncols | 0;
    if (label.trim()) h.numberedRows[r] = true;
    h.labels[r] = label.trim() || undefined;
  }
  mutate(type: HullType) {
    const row = this.slices[0].idx / this.hull.ncols | 0, col = this.slices[0].idx % this.hull.ncols;
    mutateHull(this.hull, type);
    this.slices = this.slices.slice(0, 1);
    this.idx = Math.min(row * this.hull.ncols + col, this.lastidx);
    if (this.pos > this.lastpos) this.pos = this.lastpos;
    this.clearSelection();
  }
  /** LFUN_MATH_LIMITS: toggle limits of the operator before/after the cursor */
  toggleLimits() {
    const cand = [this.nextAtom(), this.prevAtom(), this.cell[this.cell.length - 1]].find(a => a && allowsLimitsChange(a)) as (Atom & { limits?: Limits }) | undefined;
    if (!cand) return;
    cand.limits = cand.limits === 'limits' ? 'nolimits' : cand.limits === 'nolimits' ? undefined : 'limits';
  }

  /** InsetMathScript::notifyCursorLeaves: empty scripts vanish when the cursor leaves them. Call with the previous slices. */
  notifyLeave(old: Slice[]) {
    for (let d = old.length - 1; d >= 1; d--) {
      const o = old[d].owner as Atom;
      if (this.slices.some(s => s.owner === o)) continue;   // still inside
      if (o.t !== 'script') continue;
      if (o.up && o.down) {
        if (!o.down.length) delete o.down; else if (!o.up.length) delete o.up;
      }
      if ((o.up && !o.up.length && !o.down) || (o.down && !o.down.length && !o.up) || (!o.up && !o.down)) {
        // dissolve the script inset: replace it by its nucleus in the parent cell
        const parent = old[d - 1];
        const cell = atomCells(parent.owner)[parent.idx];
        const i = cell.indexOf(o);
        if (i >= 0) {
          cell.splice(i, 1, ...o.nuc);
          // fix positions of slices pointing into the parent cell
          for (const s of this.slices) if (s.owner === parent.owner && s.idx === parent.idx && s.pos > i) s.pos += o.nuc.length - 1;
        }
      }
    }
  }
}

/* ------------------------------------------------------------------ helpers */

const ROW_HULLS = new Set<HullType>(['eqnarray', 'align', 'flalign', 'alignat', 'xalignat', 'xxalignat', 'gather', 'multline']);
const COL_HULLS = new Set<HullType>(['align', 'flalign', 'alignat', 'xalignat', 'xxalignat']);

export function numberedType(h: Hull): boolean {
  if (h.type === 'simple' || h.type === 'none' || h.type === 'unknown') return false;
  return h.numberedRows.some(n => n === true);
}

function ensureScript(s: Extract<Atom, { t: 'script' }>, up: boolean) {
  if (up && !s.up) s.up = [];
  if (!up && !s.down) s.down = [];
}

const SPACE_CYCLE = [',', ':', ';', 'quad', 'qquad', '!'];
const nextSpace = (n: string) => SPACE_CYCLE[(SPACE_CYCLE.indexOf(n) + 1) % SPACE_CYCLE.length];

// LyX's InsetMathBig::isBigInsetDelim list plus \llangle/\rrangle (OverLyX's double angle brackets, see core/math/llangle.ts)
const BIG_DELIMS = new Set(['(', ')', '\\{', '\\}', '\\lbrace', '\\rbrace', '[', ']', '|', '/', '\\slash', '\\|', '\\vert', '\\Vert', "'", '<', '>', '\\\\', '\\backslash', '\\langle', '\\lceil', '\\lfloor', '\\rangle', '\\rceil', '\\rfloor', '\\llbracket', '\\rrbracket', '\\llangle', '\\rrangle', '\\downarrow', '\\Downarrow', '\\uparrow', '\\Uparrow', '\\updownarrow', '\\Updownarrow']);
const isBigDelim = (d: string) => BIG_DELIMS.has(d);
const matchingDelim = (c: string): string => ({ '(': ')', '[': ']', '{': '}', '<': '>', '|': '|', '.': '.', '\\{': '\\}', '\\langle': '\\rangle', '\\llangle': '\\rrangle', '\\lfloor': '\\rfloor', '\\lceil': '\\rceil', '\\llbracket': '\\rrbracket', '\\|': '\\|', '\\Vert': '\\Vert', '\\lVert': '\\rVert', '\\lvert': '\\rvert' } as Record<string, string>)[c] ?? '.';
/** delimiter names as InsetMathDelim stores them (`\{` → `{`, `\langle` → `langle`) */
export const delimName = (d: string) => (d.startsWith('\\') ? d.slice(1) : d);

export function allowsLimitsChange(a: Atom): boolean {
  if (a.t === 'sym') { const e = SYMBOLS[a.n]; return !!e && (e.c === 'mathop' || e.c === 'func' || e.c === 'funclim'); }
  return a.t === 'class' && a.n === 'mathop' || a.t === 'macro' || a.t === 'cmd';
}

export type MathClass = 'ord' | 'op' | 'bin' | 'rel' | 'open' | 'close' | 'punct' | 'inner';
/** InsetMath::mathClass for word movement and intelligent splitting */
export function mathClass(a: Atom): MathClass {
  switch (a.t) {
    case 'char': {
      // InsetMathChar::makeSubstitute: some ASCII characters are drawn/classified via symbols
      const subst = ({ '-': 'lyxminus', ':': 'ordinarycolon', '+': 'lyxplus', '>': 'lyxgt', '<': 'lyxlt', '=': 'lyxeqrel' } as Record<string, string>)[a.c];
      const e = subst ? SYMBOLS[subst] : undefined;
      if (e && e.c) return classOf(e.c);
      if (a.c === ',' || a.c === ';') return 'punct';
      if (a.c === '(' || a.c === '[') return 'open';
      if (a.c === ')' || a.c === ']' || a.c === '!' || a.c === '?') return 'close';
      return 'ord';
    }
    case 'sym': { const e = SYMBOLS[a.n]; if (!e) return 'ord'; if (e.c === 'func' || e.c === 'funclim') return 'op'; return classOf(e.c ?? ''); }
    case 'class': return classOf(a.n);
    case 'delim': return 'inner';
    case 'big': return a.n.endsWith('l') ? 'open' : a.n.endsWith('r') ? 'close' : 'rel';
    case 'script': return a.nuc.length ? mathClass(a.nuc[0]) : 'ord';
    case 'frac': return 'inner';
    case 'space': return 'ord';
    default: return 'ord';
  }
}
const classOf = (s: string): MathClass => {
  switch (s) { case 'mathop': return 'op'; case 'mathbin': return 'bin'; case 'mathrel': return 'rel'; case 'mathopen': return 'open'; case 'mathclose': return 'close'; case 'mathpunct': return 'punct'; case 'mathinner': return 'inner'; default: return 'ord'; }
};

/** MathFactory::createInsetMath for a typed command name: an inset with empty cells, a symbol, or an unknown command */
export function createInsetMath(name: string, macros: MacroTable): Atom {
  if (name.length === 1 && '{}&$#%_'.includes(name)) return { t: 'cmd', n: name };
  const md = parseCell('\\' + name, macros);
  if (md.length === 1) return md[0];
  return { t: 'cmd', n: name };
}

/* ---- InsetMathHull::mutate and helpers */

function firstRelOp(md: Cell): number {
  for (let i = 0; i < md.length; i++) if (mathClass(md[i]) === 'rel') return i;
  return md.length;
}
function addCol(g: Grid, col: number) { g.ncols++; for (const r of g.rows) r.cells.splice(col, 0, []); }
function delCol(g: Grid, col: number) { if (g.ncols === 1) return; g.ncols--; for (const r of g.rows) r.cells.splice(col, 1); }
function splitTo2Cols(h: Hull) {
  addCol(h, 1);
  for (const r of h.rows) { const pos = firstRelOp(r.cells[0]); r.cells[1] = r.cells[0].splice(pos); }
}
function splitTo3Cols(h: Hull) {
  if (h.ncols < 2) splitTo2Cols(h);
  addCol(h, 2);
  for (const r of h.rows) { if (r.cells[1].length) r.cells[2] = r.cells[1].splice(1); }
}
function changeCols(h: Hull, cols: number) {
  if (h.ncols === cols) return;
  if (h.ncols < cols) { if (cols < 3) splitTo2Cols(h); else { splitTo3Cols(h); while (h.ncols < cols) addCol(h, h.ncols); } return; }
  for (const r of h.rows) for (let col = cols; col < h.ncols; col++) r.cells[cols - 1].push(...r.cells[col]);
  while (h.ncols > cols) delCol(h, h.ncols - 1);
}
function glueall(h: Hull, type: HullType) {
  const md: Cell = h.rows.flatMap(r => r.cells.flat());
  let label: string | undefined;
  if (type === 'equation') label = h.labels.find(l => l);
  h.rows = [{ cells: [md] }]; h.ncols = 1; h.type = 'simple'; h.numberedRows = [false]; h.labels = [label];
}
const setType = (h: Hull, t: HullType) => { h.type = t; };

export function mutateHull(h: Hull, newtype: HullType): void {
  if (newtype === h.type) return;
  const setNumbered = (v: boolean) => { for (let i = 0; i < h.numberedRows.length; i++) h.numberedRows[i] = v; };
  switch (h.type) {
    case 'none': setType(h, 'simple'); h.numberedRows[0] = false; mutateHull(h, newtype); break;
    case 'simple':
      if (newtype === 'none') { setType(h, 'none'); h.numberedRows[0] = false; }
      else { setType(h, 'equation'); h.numberedRows[0] = !!h.labels[0]; mutateHull(h, newtype); }
      break;
    case 'equation':
      switch (newtype) {
        case 'none': case 'simple': setType(h, 'simple'); h.numberedRows[0] = false; mutateHull(h, newtype); break;
        case 'eqnarray': splitTo3Cols(h); setType(h, 'eqnarray'); break;
        case 'multline': case 'gather': setType(h, newtype); break;
        default: splitTo2Cols(h); setType(h, 'align'); mutateHull(h, newtype); break;
      }
      break;
    case 'eqnarray':
      switch (newtype) {
        case 'none': case 'simple': case 'equation': glueall(h, newtype); mutateHull(h, newtype); break;
        default: changeCols(h, 2); setType(h, 'align'); mutateHull(h, newtype); break;
      }
      break;
    case 'align': case 'alignat': case 'xalignat': case 'flalign':
      switch (newtype) {
        case 'none': case 'simple': case 'equation': case 'eqnarray': changeCols(h, 3); setType(h, 'eqnarray'); mutateHull(h, newtype); break;
        case 'gather': case 'multline': changeCols(h, 1); setType(h, newtype); break;
        case 'xxalignat': setNumbered(false); setType(h, newtype); break;
        default: setType(h, newtype); break;
      }
      break;
    case 'xxalignat':
      setNumbered(false);
      switch (newtype) {
        case 'none': case 'simple': case 'equation': case 'eqnarray': changeCols(h, 3); setType(h, 'eqnarray'); mutateHull(h, newtype); break;
        case 'gather': case 'multline': changeCols(h, 1); setType(h, newtype); break;
        default: setType(h, newtype); break;
      }
      break;
    case 'multline': case 'gather':
      switch (newtype) {
        case 'gather': case 'multline': setType(h, newtype); break;
        case 'align': case 'flalign': case 'alignat': case 'xalignat': splitTo2Cols(h); setType(h, newtype); break;
        case 'xxalignat': splitTo2Cols(h); setNumbered(false); setType(h, newtype); break;
        default: splitTo3Cols(h); setType(h, 'eqnarray'); mutateHull(h, newtype); break;
      }
      break;
    default: break;
  }
}

export { ROW_HULLS, COL_HULLS };
export const cloneHull = (h: Hull): Hull => JSON.parse(JSON.stringify(h));
export { cloneCell };
