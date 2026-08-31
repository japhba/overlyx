/**
 * LyxMathField — the editable formula widget: the LyX math model rendered with KaTeX, a LyX
 * cursor (core/math/cursor.ts) drawn as an overlay, LyX's keyboard and mouse behaviour, undo.
 *
 * DOM: <span class="lm-field"><span class="lm-content">KaTeX</span><span class="lm-overlay">caret,
 * selection, corner markers</span><textarea class="lm-input"></textarea></span>
 * Every cell of the model is wrapped in `\htmlClass{lm-c<id>}{…}` by the renderer, so caret and
 * selection positions are measured from the boxes KaTeX produced (per character for text runs).
 */
import katex from 'katex';
import {
  parseFormula, writeFormula, writeCellLatex, parseCell, renderHullSource, katexMacros, MathCursor, atomCells, isHull, nargs, numberedType, isKnownCommand, completeCommand,
  type Hull, type HullType, type MacroTable, type Slice, type Atom, type Cell, type CellRef, type Owner,
} from '@overlyx/core';
import { editorContext } from '../context';
import { getPrefs } from '../../prefs';

export type MoveOutDirection = 'backward' | 'forward' | 'upward' | 'downward';

export interface FieldOptions {
  latex: string;
  display: boolean;
  macros: MacroTable;
  readOnly?: boolean;
  onChange?: (latex: string) => void;
  /**
   * The cursor left the formula. `dissolve`: the formula is empty and was left with a horizontal
   * move (arrow / Backspace / Delete) — the owner may remove it (an empty formula left behind
   * by Ctrl+M, then a cursor key, is never wanted).
   */
  onMoveOut?: (dir: MoveOutDirection, opts: { insertSpace?: boolean; dissolve?: boolean }) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  /** Alt+M n/d/t: numbering / environment commands handled by the node view */
  onCommand?: (key: string) => void;
  /** a drag left the formula (LyX: the motion bubbles to the surrounding text, formula taken whole) */
  onDragOut?: (ev: MouseEvent) => void;
}

interface AtomBox { el: Element; from: number; to: number; text: boolean }
interface Parent { owner: Owner; idx: number; pos: number }

const MARKER_COLOR = '#c000c0';   // LyX Color_mathframe

/** LyX math.bind Alt+M bindings: key → LaTeX to insert (`#0` marks the cursor cell) */
export const MATH_ALT_M: Record<string, string> = {
  f: '\\frac{#0}{}', s: '\\sqrt{#0}', r: '\\sqrt[]{#0}', u: '\\sum', i: '\\int', l: '\\lim', c: '\\cases', o: '\\oint', p: '\\partial', b: '\\bar{#0}', h: '\\hat{#0}', v: '\\vec{#0}', w: '\\text{#0}', '~': '\\tilde{#0}', '^': '\\hat{#0}', '_': '\\underline{#0}', ',': '\\,', ':': '\\:', ';': '\\;', '!': '\\!',
  '(': '\\left(#0\\right)', '[': '\\left[#0\\right]', '{': '\\left\\{#0\\right\\}', '|': '\\left|#0\\right|', '<': '\\left\\langle #0\\right\\rangle',
};

let seq = 0;
let active: LyxMathField | null = null;
/** the field that currently has the keyboard focus */
export function activeMathField(): LyxMathField | null { return active; }
/** called whenever a math field gains or loses the focus (the toolbar switches to LyX's math toolbar) */
export const mathFocusListeners = new Set<(field: LyxMathField | null) => void>();
/** called after every cursor move or edit inside a field (the source pane follows the cursor) */
export const mathCursorListeners = new Set<(field: LyxMathField) => void>();
function notifyCursor(f: LyxMathField): void { for (const l of mathCursorListeners) { try { l(f); } catch { /* ignore */ } } }
function notifyFocus(): void { for (const l of mathFocusListeners) { try { l(active); } catch { /* ignore */ } } }

export class LyxMathField {
  dom: HTMLSpanElement;
  private content: HTMLSpanElement;
  private overlay: HTMLSpanElement;
  private input: HTMLTextAreaElement;
  hull: Hull;
  cursor: MathCursor;
  macros: MacroTable;
  display: boolean;
  readOnly: boolean;
  private cells: CellRef[] = [];
  private parents = new Map<Owner, Parent>();
  private undoStack: { hull: string; path: number[][] }[] = [];
  private redoStack: { hull: string; path: number[][] }[] = [];
  private lastEdit = { kind: '', time: 0 };
  private focused = false;
  private raf = 0;
  private opts: FieldOptions;
  private altM = false;
  private dragging = false;
  private deadHat = false;
  private lastLatex: string;
  private _macroKey = '';
  private hoverAtom: Atom | null = null;
  /** an autocomplete suggestion shown faintly after the caret (ai/mathassist.ts); Tab inserts it */
  private ghost: string | null = null;
  readonly id = ++seq;

  constructor(opts: FieldOptions) {
    this.opts = opts;
    this.macros = opts.macros;
    this.display = opts.display;
    this.readOnly = !!opts.readOnly;
    this.hull = parseFormula(opts.latex, this.macros);
    this.lastLatex = opts.latex;
    this.cursor = new MathCursor(this.hull, this.macros, { xToPos: (cell, x) => this.xToPos(cell, x) });
    this.cursor.idx = this.cursor.lastidx; this.cursor.pos = this.cursor.lastpos;
    this.dom = document.createElement('span');
    this.dom.className = 'lm-field' + (opts.display ? ' display' : '');
    this.content = document.createElement('span');
    this.content.className = 'lm-content';
    this.overlay = document.createElement('span');
    this.overlay.className = 'lm-overlay';
    this.input = document.createElement('textarea');
    this.input.className = 'lm-input';
    this.input.setAttribute('aria-label', 'formula');
    this.input.autocomplete = 'off'; this.input.spellcheck = false; this.input.tabIndex = -1;
    this.dom.append(this.content, this.overlay, this.input);
    this.wire();
    this.render();
  }

  /* ------------------------------------------------------------ public API */
  get latex(): string { return writeFormula(this.hull); }
  /** replace the content (external change); the cursor stays where possible */
  setLatex(latex: string): void {
    if (latex === this.lastLatex) return;
    const path = this.pathOf(this.cursor.slices);
    this.hull = parseFormula(latex, this.macros);
    this.lastLatex = latex;
    this.cursor = new MathCursor(this.hull, this.macros, { xToPos: (cell, x) => this.xToPos(cell, x) });
    if (!this.restorePath(path)) { this.cursor.idx = this.cursor.lastidx; this.cursor.pos = this.cursor.lastpos; }
    this.render();
  }
  setMacros(macros: MacroTable, key: string): void {
    if (key === this._macroKey) return;
    this._macroKey = key;
    this.macros = macros;
    this.cursor.macros = macros;
    this.render();
  }
  hasFocus(): boolean { return this.focused; }
  /** the row of the top-level cell the cursor is in (0 for inline / single-row formulas) */
  topRow(): number { return Math.floor(this.cursor.slices[0].idx / Math.max(1, this.hull.ncols)); }
  /** no content in any cell */
  isEmpty(): boolean { return !this.hull.rows.some(r => r.cells.some(c => c.length)); }
  /** the rendered cells (ids match the `lm-c<id>` classes in the DOM) */
  cellRefs(): CellRef[] { return this.cells; }
  /** bounding boxes of the hull's rows (client coordinates) */
  rowRects(): DOMRect[] { return rowRectsOf(this.hull, this.cells, this.content); }
  /** the cursor sits at the end of its cell (where a continuation can be suggested) */
  atCellEnd(): boolean { const c = this.cursor; return c.pos === (atomCells(c.owner)[c.idx] ?? []).length; }
  /** LaTeX of the current cell before / after the cursor */
  cellLatexAround(): { before: string; after: string } { const c = this.cursor; const cell = atomCells(c.owner)[c.idx] ?? []; return { before: writeCellLatex(cell.slice(0, c.pos)), after: writeCellLatex(cell.slice(c.pos)) }; }
  /** a string identifying the cursor position (to check that nothing moved while a request was in flight) */
  cursorPath(): string { return this.pathOf(this.cursor.slices).join(';'); }
  /** show (or clear) an autocomplete suggestion after the caret; it is rendered like the formula, in the ghost colour */
  setGhost(latex: string | null): void { const g = latex && latex.trim() ? latex.trim() : null; if (g === this.ghost) return; this.ghost = g; this.render(); }
  get ghostText(): string | null { return this.ghost; }
  private clearGhost(): boolean { if (!this.ghost) return false; this.ghost = null; return true; }
  focus(where?: 'start' | 'end'): void {
    if (where === 'start') { this.cursor.slices = this.cursor.slices.slice(0, 1); this.cursor.idx = 0; this.cursor.pos = 0; }
    if (where === 'end') { this.cursor.slices = this.cursor.slices.slice(0, 1); this.cursor.idx = this.cursor.lastidx; this.cursor.pos = this.cursor.lastpos; }
    this.cursor.clearSelection();
    this.input.focus({ preventScroll: true });
    this.scheduleLayout();
  }
  blur(): void { this.input.blur(); }
  destroy(): void { cancelAnimationFrame(this.raf); this.dom.remove(); }

  /** Commands for menus, toolbars and shortcuts. */
  execute(cmd: string, ...args: unknown[]): boolean {
    if (this.readOnly) return false;
    const c = this.cursor;
    const change = (kind: string, f: () => void) => { this.snapshot(kind); f(); this.commit(); return true; };
    switch (cmd) {
      case 'insert': return change('insert', () => this.insertLatex(String(args[0] ?? '')));
      case 'moveToMathfieldStart': this.focus('start'); return true;
      case 'moveToMathfieldEnd': this.focus('end'); return true;
      case 'moveToSuperscript': return change('script', () => c.script(true));
      case 'moveToSubscript': return change('script', () => c.script(false));
      case 'delim': return change('delim', () => { const l = String(args[0] ?? '('), r = String(args[1] ?? ')'); c.handleNest({ t: 'delim', l: l.replace(/^\\/, ''), r: r.replace(/^\\/, ''), body: [] }); });
      case 'bigdelim': return change('bigdelim', () => { const [ln, ld, rn, rd] = args as string[]; const sel = c.grabAndEraseSelection(); c.insertAtom({ t: 'big', n: ln, d: ld }); if (rn) { c.insertAtom({ t: 'big', n: rn, d: rd }); c.posBackward(); } if (sel) c.niceInsert(sel, false); });
      case 'matrix': return change('matrix', () => { const rows = Number(args[0] ?? 2), cols = Number(args[1] ?? 2), env = String(args[2] ?? 'matrix'); const halign = String(args[3] ?? ''); c.niceInsertAtom({ t: 'grid', env, ncols: cols, rows: Array.from({ length: rows }, () => ({ cells: Array.from({ length: cols }, () => [] as Cell) })), halign: env === 'array' ? (halign || 'c'.repeat(cols)) : undefined }); });
      case 'font': return change('font', () => c.handleFont(String(args[0] ?? 'mathrm')));
      case 'limits': return change('limits', () => c.toggleLimits());
      case 'numberToggle': return change('number', () => c.numberToggle());
      case 'numberLineToggle': return change('number', () => c.numberLineToggle());
      case 'label': return change('label', () => c.setLabel(String(args[0] ?? '')));
      case 'mutate': return change('mutate', () => c.mutate(args[0] as HullType));
      case 'newline': return change('newline', () => c.newline());
      case 'selectAll': c.selectAll(); this.scheduleLayout(); return true;
      case 'undo': return this.undo();
      case 'redo': return this.redo();
      // replace the selection (or insert at the cursor) with LaTeX as it is, no "enter the first cell" magic (AI rewrite)
      case 'replace': return change('replace', () => { c.grabAndEraseSelection(); c.insertCell(parseCell(String(args[0] ?? ''), this.macros, c.mode)); });
      // replace the whole formula (its full source, delimiters / environment included); the cursor goes to the end
      case 'replaceFormula': {
        this.snapshot('replace');
        this.hull = parseFormula(String(args[0] ?? ''), this.macros);
        this.cursor = new MathCursor(this.hull, this.macros, { xToPos: (cell, x) => this.xToPos(cell, x) });
        this.cursor.idx = this.cursor.lastidx; this.cursor.pos = this.cursor.lastpos;
        this.commit();
        return true;
      }
      case 'text': return change('text', () => { const sel = c.grabAndEraseSelection(); c.niceInsertAtom({ t: 'font', n: 'text', body: parseCell(sel, this.macros, 'text'), mode: 'text' }); });
      // plain delimiter pair around the selection (no \left / \bigl): `\llangle x \rrangle`
      case 'pair': return change('pair', () => { const [l, r] = args as string[]; const sel = c.grabAndEraseSelection(); c.niceInsert(l, false); c.niceInsert(r, false); c.posBackward(); if (sel) c.niceInsert(sel, false); });
      // LyX math-size: \displaystyle etc. wrap the selection (or start an inset at the cursor)
      case 'style': return change('style', () => c.handleNest({ t: 'style', n: String(args[0] ?? 'displaystyle').replace(/^\\/, ''), body: [] }));
      // LyX tabular-feature append-row / delete-row / append-column / delete-column
      case 'appendRow': return c.gridRowsOK() ? change('grid', () => c.gridAppendRow()) : false;
      case 'deleteRow': return c.gridRowsOK() ? change('grid', () => c.gridDeleteRow()) : false;
      case 'appendColumn': return c.gridColsOK() ? change('grid', () => c.gridAppendColumn()) : false;
      case 'deleteColumn': return c.gridColsOK() ? change('grid', () => c.gridDeleteColumn()) : false;
      default: return false;
    }
  }

  /** insert LaTeX at the cursor; `#0` marks where the cursor should end up, `#?` empty cells */
  private insertLatex(latex: string): void {
    const c = this.cursor;
    const src = latex.replace(/#\?/g, '');
    const hasMark = src.includes('#0');
    const cell = parseCell(src.replace(/#0/g, ''), this.macros, c.mode);
    if (cell.length === 1 && hasMark) { c.niceInsertAtom(cell[0]); return; }
    if (cell.length === 1 && nargs(cell[0]) > 0) { c.niceInsertAtom(cell[0]); return; }
    c.insertCell(cell);
  }

  /* ------------------------------------------------------------ rendering */
  /** the command name being typed, annotated with validity and LyX's completion */
  private updateMacroModeHint(): void {
    const p = this.cursor.activeMacro();
    if (!p) return;
    const name = p.n.slice(1);
    p.valid = name.length > 0 && isKnownCommand(name, this.macros);
    const cand = completeCommand(name, this.macros, 1)[0];
    p.hint = cand ? cand.slice(name.length) : undefined;
  }

  render(): void {
    this.updateMacroModeHint();
    const rendered = renderHullSource(this.hull, this.macros);
    let latex = rendered.latex;
    const cells = rendered.cells;
    this.cells = cells;
    this.rebuildParents();
    if (this.ghost && this.focused && !this.cursor.selection && !this.cursor.inMacroMode() && this.atCellEnd()) {
      const ref = cells.find(c => c.owner === this.cursor.owner && c.idx === this.cursor.idx);
      if (ref) latex = injectGhost(latex, ref.id, this.ghost, this.cursor.mode === 'text');
    }
    let html: string;
    try {
      html = katex.renderToString((this.display ? '\\displaystyle ' : '') + latex, { throwOnError: false, strict: false, trust: true, displayMode: false, output: 'html', macros: katexMacros(this.macros) });
    } catch (e) {
      html = `<span class="lm-error">${escapeHtml(this.lastLatex)}</span>`;
    }
    this.content.innerHTML = html;
    this.dom.classList.toggle('empty', this.isEmpty());
    this.scheduleLayout();
  }

  /** parent links for every cell owner (for cursor paths from clicks) */
  private rebuildParents(): void {
    this.parents.clear();
    const walk = (owner: Owner) => {
      const cells = atomCells(owner);
      cells.forEach((cell, idx) => cell.forEach((atom, pos) => { if (nargs(atom) > 0) { this.parents.set(atom, { owner, idx, pos }); walk(atom); } }));
    };
    walk(this.hull);
  }

  private scheduleLayout(): void { if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.layout(); }); }

  private cellEl(owner: Owner, idx: number): HTMLElement | null {
    const ref = this.cells.find(c => c.owner === owner && c.idx === idx);
    return ref ? this.content.querySelector(`.lm-c${ref.id}`) as HTMLElement | null : null;
  }

  /** KaTeX boxes of a cell's atoms, in order (glue spans skipped, merged text runs measured per character) */
  private atomBoxes(cell: Cell, el: HTMLElement): AtomBox[] {
    const kids = Array.from(el.children).filter(k => !(k.classList.contains('mspace') && !k.classList.contains('enclosing')) && !k.classList.contains('katex-strut') && !k.classList.contains('vlist-s') && !k.classList.contains('lm-ghost'));
    const boxes: AtomBox[] = [];
    let i = 0;
    for (const k of kids) {
      if (i >= cell.length) break;
      const textLen = k.childNodes.length === 1 && k.firstChild?.nodeType === Node.TEXT_NODE ? (k.textContent ?? '').length : 0;
      if (textLen > 1) {
        let n = 0;
        while (n < textLen && i + n < cell.length && cell[i + n].t === 'char') n++;
        if (n === 0) n = 1;
        boxes.push({ el: k, from: i, to: i + n, text: n > 1 });
        i += n;
      } else { boxes.push({ el: k, from: i, to: i + 1, text: false }); i++; }
    }
    // atoms without a box (should not happen): attach them to the last box
    if (boxes.length && i < cell.length) boxes[boxes.length - 1].to = cell.length;
    return boxes;
  }

  private charRect(box: AtomBox, atomIndex: number): DOMRect {
    const node = box.el.firstChild as Text;
    const k = atomIndex - box.from;
    try { const r = document.createRange(); r.setStart(node, k); r.setEnd(node, k + 1); return r.getBoundingClientRect(); } catch { return box.el.getBoundingClientRect(); }
  }

  /** x of the caret before position `pos` in a cell (client coordinates) plus the cell's vertical extent */
  private caretRect(owner: Owner, idx: number, pos: number): { x: number; top: number; bottom: number } | null {
    const el = this.cellEl(owner, idx);
    if (!el) return null;
    const cell = atomCells(owner)[idx] ?? [];
    const cr = el.getBoundingClientRect();
    if (!cell.length) return { x: cr.left + 1, top: cr.top, bottom: cr.bottom };
    const boxes = this.atomBoxes(cell, el);
    const rectOfAtom = (i: number) => { const b = boxes.find(x => i >= x.from && i < x.to) ?? boxes[boxes.length - 1]; return b.text ? this.charRect(b, i) : b.el.getBoundingClientRect(); };
    let x: number;
    if (pos <= 0) x = rectOfAtom(0).left; else x = rectOfAtom(Math.min(pos, cell.length) - 1).right;
    return { x, top: cr.top, bottom: cr.bottom };
  }

  private xToPos(cell: Cell, x: number | null): number {
    if (x === null) return 0;
    const ref = this.cells.find(c => (atomCells(c.owner)[c.idx] ?? null) === cell);
    if (!ref) return 0;
    const el = this.content.querySelector(`.lm-c${ref.id}`) as HTMLElement | null;
    if (!el || !cell.length) return 0;
    return this.posFromX(cell, el, x);
  }
  private posFromX(cell: Cell, el: HTMLElement, x: number): number {
    const boxes = this.atomBoxes(cell, el);
    let best = 0, bestD = Infinity;
    const consider = (pos: number, px: number) => { const d = Math.abs(px - x); if (d < bestD) { bestD = d; best = pos; } };
    if (!boxes.length) return 0;
    consider(0, (boxes[0].text ? this.charRect(boxes[0], 0) : boxes[0].el.getBoundingClientRect()).left);
    for (const b of boxes) for (let i = b.from; i < b.to; i++) { const r = b.text ? this.charRect(b, i) : b.el.getBoundingClientRect(); consider(i + 1, r.right); }
    return best;
  }

  layout(): void {
    const ov = this.overlay;
    ov.replaceChildren();
    const base = this.dom.getBoundingClientRect();
    const c = this.cursor;
    // LyX highlights the inset under the mouse pointer (Color_mathframe) even when not editing
    const hover = this.hoverAtom;
    if (hover && !(this.focused && c.slices.some(s => s.owner === hover))) { const r = this.atomRect(hover); if (r) this.corners(ov, base, r, hover.t === 'frac' || hover.t === 'grid' || hover.t === 'macro' ? 'both' : 'lower'); }
    if (!this.focused) return;
    // selection
    const sel = c.selRange();
    if (sel) {
      const cellsToMark: { owner: Owner; idx: number; from: number; to: number }[] = [];
      if (sel.idx1 === sel.idx2) cellsToMark.push({ owner: sel.owner, idx: sel.idx1, from: sel.from, to: sel.to });
      else { const nc = 'ncols' in sel.owner ? (sel.owner as { ncols: number }).ncols : 1; const r1 = Math.floor(sel.idx1 / nc), r2 = Math.floor(sel.idx2 / nc), c1 = Math.min(sel.idx1 % nc, sel.idx2 % nc), c2 = Math.max(sel.idx1 % nc, sel.idx2 % nc); for (let r = r1; r <= r2; r++) for (let col = c1; col <= c2; col++) cellsToMark.push({ owner: sel.owner, idx: r * nc + col, from: 0, to: atomCells(sel.owner)[r * nc + col]?.length ?? 0 }); }
      for (const m of cellsToMark) {
        const el = this.cellEl(m.owner, m.idx);
        if (!el) continue;
        const cell = atomCells(m.owner)[m.idx] ?? [];
        const cr = el.getBoundingClientRect();
        let x1 = cr.left, x2 = cr.right;
        if (cell.length) { const a = this.caretRect(m.owner, m.idx, m.from), b = this.caretRect(m.owner, m.idx, m.to); if (a && b) { x1 = a.x; x2 = b.x; } }
        const d = document.createElement('span');
        d.className = 'lm-sel';
        d.style.cssText = `left:${x1 - base.left}px;top:${cr.top - base.top}px;width:${Math.max(2, x2 - x1)}px;height:${cr.height}px`;
        ov.appendChild(d);
      }
    }
    // caret
    const cr = this.caretRect(c.owner, c.idx, c.pos);
    if (cr) {
      const d = document.createElement('span');
      d.className = 'lm-caret';
      d.style.cssText = `left:${cr.x - base.left - 0.5}px;top:${cr.top - base.top}px;height:${cr.bottom - cr.top}px`;
      ov.appendChild(d);
      // keep the hidden input near the caret so IME popups appear in place
      this.input.style.left = `${cr.x - base.left}px`; this.input.style.top = `${cr.top - base.top}px`;
    }
    // LyX corner markers around every inset on the cursor's path
    for (let d = 1; d < c.slices.length; d++) {
      const inset = c.slices[d].owner as Atom;
      const p = c.slices[d - 1];
      const el = this.cellEl(p.owner, p.idx);
      if (!el) continue;
      const cell = atomCells(p.owner)[p.idx] ?? [];
      const boxes = this.atomBoxes(cell, el);
      const box = boxes.find(b => p.pos >= b.from && p.pos < b.to);
      if (!box) continue;
      const r = box.el.getBoundingClientRect();
      const kind = inset.t === 'frac' || inset.t === 'grid' || inset.t === 'macro' ? 'both' : 'lower';
      this.corners(ov, base, r, kind, inset.t === 'macro' ? '\\' + inset.n : undefined);
    }
  }

  /** the KaTeX box of an inset atom (found through its parent cell) */
  private atomRect(atom: Atom): DOMRect | null {
    const p = this.parents.get(atom);
    if (!p) return null;
    const el = this.cellEl(p.owner, p.idx);
    if (!el) return null;
    const cell = atomCells(p.owner)[p.idx] ?? [];
    const box = this.atomBoxes(cell, el).find(b => p.pos >= b.from && p.pos < b.to);
    return box ? box.el.getBoundingClientRect() : null;
  }

  /** the innermost inset whose box contains the point (LyX: the hovered inset) */
  private insetFromPoint(x: number, y: number): Atom | null {
    let el = document.elementFromPoint(x, y) as Element | null;
    if (!el || !this.content.contains(el)) return null;
    // the nearest cell around the element, and the atom box of that cell containing it
    for (let e: Element | null = el; e && e !== this.content; e = e.parentElement) {
      const m = /(?:^|\s)lm-c(\d+)(?:\s|$)/.exec(e.className ?? '');
      if (!m) continue;
      const ref = this.cells[Number(m[1])];
      if (!ref) return null;
      const cell = atomCells(ref.owner)[ref.idx] ?? [];
      const box = this.atomBoxes(cell, e as HTMLElement).find(b => b.el === el || b.el.contains(el!));
      if (box && !box.text) { const a = cell[box.from]; if (a && nargs(a) > 0) return a; }
      return isHull(ref.owner) ? null : ref.owner;
    }
    return null;
  }

  private corners(ov: HTMLElement, base: DOMRect, r: DOMRect, kind: 'lower' | 'both', label?: string): void {
    // LyX reserves a small margin around marked insets; the hooks sit symmetrically 2px outside the box
    const l = r.left - base.left - 2, rt = r.right - base.left - 2, t = r.top - base.top - 2, b = r.bottom - base.top - 2;
    const corner = (x: number, y: number, h: 'left' | 'right', v: 'top' | 'bottom') => {
      const d = document.createElement('span');
      d.className = 'lm-corner';
      d.style.cssText = `left:${x}px;top:${y}px;border-${h}:1px solid ${MARKER_COLOR};border-${v}:1px solid ${MARKER_COLOR}`;
      ov.appendChild(d);
    };
    corner(l, b, 'left', 'bottom'); corner(rt, b, 'right', 'bottom');
    if (kind === 'both') { corner(l, t, 'left', 'top'); corner(rt, t, 'right', 'top'); }
    if (label) { const d = document.createElement('span'); d.className = 'lm-macro-name'; d.textContent = label; d.style.cssText = `left:${l}px;top:${t - 10}px`; ov.appendChild(d); }
  }

  /* ------------------------------------------------------------ cursor paths (for undo and clicks) */
  private pathOf(slices: Slice[]): number[][] { return slices.map(s => [s.idx, s.pos]); }
  private restorePath(path: number[][]): boolean {
    const slices: Slice[] = [{ owner: this.hull, idx: 0, pos: 0 }];
    for (let i = 0; i < path.length; i++) {
      const [idx, pos] = path[i];
      const owner = slices[i].owner;
      const cells = atomCells(owner);
      if (idx >= cells.length) return false;
      slices[i].idx = idx; slices[i].pos = Math.min(pos, cells[idx].length);
      if (i + 1 < path.length) { const atom = cells[idx][pos]; if (!atom || nargs(atom) === 0) { this.cursor.slices = slices; return true; } slices.push({ owner: atom, idx: 0, pos: 0 }); }
    }
    this.cursor.slices = slices;
    return true;
  }
  /** slices for a cell reached from a click, with the given position */
  private slicesFor(ref: CellRef, pos: number): Slice[] {
    const chain: Slice[] = [{ owner: ref.owner, idx: ref.idx, pos }];
    let o = ref.owner;
    while (!isHull(o)) { const p = this.parents.get(o); if (!p) break; chain.unshift({ owner: p.owner, idx: p.idx, pos: p.pos }); o = p.owner; }
    return chain;
  }

  /* ------------------------------------------------------------ editing plumbing */
  private snapshot(kind: string): void {
    const now = Date.now();
    if (kind === 'type' && this.lastEdit.kind === 'type' && now - this.lastEdit.time < 800) { this.lastEdit.time = now; return; }
    this.undoStack.push({ hull: JSON.stringify(this.hull), path: this.pathOf(this.cursor.slices) });
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.lastEdit = { kind, time: now };
  }
  private restore(s: { hull: string; path: number[][] }): void {
    this.hull = JSON.parse(s.hull);
    this.cursor = new MathCursor(this.hull, this.macros, { xToPos: (cell, x) => this.xToPos(cell, x) });
    if (!this.restorePath(s.path)) { this.cursor.idx = this.cursor.lastidx; this.cursor.pos = this.cursor.lastpos; }
  }
  undo(): boolean {
    const s = this.undoStack.pop();
    if (!s) return false;
    this.redoStack.push({ hull: JSON.stringify(this.hull), path: this.pathOf(this.cursor.slices) });
    this.restore(s); this.lastEdit = { kind: '', time: 0 }; this.commit();
    return true;
  }
  redo(): boolean {
    const s = this.redoStack.pop();
    if (!s) return false;
    this.undoStack.push({ hull: JSON.stringify(this.hull), path: this.pathOf(this.cursor.slices) });
    this.restore(s); this.commit();
    return true;
  }
  /** after a model change: re-render and notify (`keepGhost`: the change was typing the suggestion's beginning) */
  private commit(keepGhost = false): void {
    if (!keepGhost) this.ghost = null;
    this.render();
    const latex = this.latex;
    if (latex !== this.lastLatex) { this.lastLatex = latex; this.opts.onChange?.(latex); }
    if (this.focused) notifyCursor(this);
  }
  /** cursor moved without a model change (may still remove empty scripts) */
  private moved(old: Slice[]): void {
    const before = this.latex;
    this.cursor.notifyLeave(old);
    if (this.latex !== before) { this.commit(); return; }
    if (this.clearGhost()) this.render(); else this.scheduleLayout();
    if (this.focused) notifyCursor(this);
  }

  /* ------------------------------------------------------------ events */
  private wire(): void {
    const input = this.input;
    input.addEventListener('focus', () => { this.focused = true; active = this; this.dom.classList.add('focused'); this.opts.onFocus?.(); this.scheduleLayout(); notifyFocus(); });
    input.addEventListener('blur', () => { this.focused = false; if (active === this) active = null; this.altM = false; this.deadHat = false; this.dom.classList.remove('focused'); this.cursor.macroModeClose(); this.overlay.replaceChildren(); if (this.clearGhost()) this.render(); this.opts.onBlur?.(); notifyFocus(); });
    input.addEventListener('keydown', ev => this.keydown(ev));
    input.addEventListener('beforeinput', ev => {
      if (ev.inputType === 'insertText' || ev.inputType === 'insertCompositionText') { if (ev.inputType === 'insertText') { ev.preventDefault(); this.typed(ev.data ?? ''); } return; }
      if (ev.inputType.startsWith('delete') || ev.inputType.startsWith('insert')) ev.preventDefault();
    });
    // Dead keys (^ ` ´ ~ on German/French/… layouts) arrive as a composition: the text is taken once,
    // at compositionend; `input` events fired while composing must be ignored (the flag is on the
    // event — checking it on the element used to insert ^ twice: x^2 became a double superscript).
    // A dead ^ in math means superscript, as in LyX — and immediately, at the keypress itself: the
    // composition the browser opens for it is taken over at compositionupdate (waiting for
    // compositionend used to show nothing until the next key was typed). compositionend then types
    // only what was composed onto the ^ (â → a, into the superscript); other accents are kept
    // whole (é stays é), as is everything in text mode.
    input.addEventListener('compositionupdate', ev => {
      if (this.deadHat || ev.data !== '^' || this.cursor.mode !== 'math' || this.readOnly) return;
      this.deadHat = true;
      this.typed('^');
    });
    input.addEventListener('compositionend', ev => {
      input.value = '';
      const data = ev.data ?? '';
      if (this.deadHat) {
        this.deadHat = false;
        const rest = data.normalize('NFD').replace(/\u0302/g, '').replace(/^\^/, '').normalize('NFC');
        if (rest) this.typed(rest);
        return;
      }
      this.typed(this.cursor.mode === 'math' ? data.normalize('NFD').replace(/(.)\u0302/g, '^$1').normalize('NFC') : data);
    });
    // macOS Chrome fires the composition's final input event with isComposing already false
    // (inputType insertCompositionText) before compositionend — it must not be typed a second time.
    input.addEventListener('input', ev => { const ie = ev as InputEvent; if (ie.isComposing || ie.inputType === 'insertCompositionText') return; if (input.value) { const v = input.value; input.value = ''; this.typed(v); } });
    input.addEventListener('copy', ev => { ev.preventDefault(); ev.clipboardData?.setData('text/plain', this.cursor.selection ? this.cursor.grabSelection() : ''); });
    input.addEventListener('cut', ev => { ev.preventDefault(); if (!this.cursor.selection || this.readOnly) return; ev.clipboardData?.setData('text/plain', this.cursor.grabSelection()); this.snapshot('cut'); this.cursor.eraseSelection(); this.commit(); });
    input.addEventListener('paste', ev => { ev.preventDefault(); if (this.readOnly) return; const t = ev.clipboardData?.getData('text/plain') ?? ''; if (!t) return; this.snapshot('paste'); this.cursor.niceInsert(t.replace(/^\$|\$$/g, ''), false); this.commit(); });
    // mouse: place the cursor / drag a selection
    this.content.addEventListener('mousedown', ev => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      const s = this.slicesFromPoint(ev.clientX, ev.clientY);
      if (ev.shiftKey) { if (!this.cursor.selection) this.cursor.selHandle(true); }
      else this.cursor.clearSelection();
      const old = this.cursor.clone();
      if (s) this.cursor.slices = s;
      this.cursor.macroModeClose();
      this.dragging = true;
      this.input.focus({ preventScroll: true });
      this.moved(old);
      if (ev.detail === 2) { this.cursor.selHandle(true); this.cursor.resetAnchor(); const o = this.cursor.clone(); this.cursor.mathBackward(true); this.cursor.anchor = this.cursor.clone(); this.cursor.setSlices(o); this.cursor.mathForward(true); this.scheduleLayout(); }
      if (ev.detail === 3) { this.cursor.selectAll(); this.scheduleLayout(); }
    });
    window.addEventListener('mousemove', ev => {
      if (!this.dragging) return;
      // out of the formula: the drag continues in the surrounding text with the formula taken
      // whole (LyX lfunMouseMotion leaves motions outside the inset to the outer text)
      if (this.opts.onDragOut) {
        const r = this.dom.getBoundingClientRect();
        if (ev.clientX < r.left - 4 || ev.clientX > r.right + 4 || ev.clientY < r.top - 6 || ev.clientY > r.bottom + 6) {
          this.dragging = false;
          this.cursor.clearSelection();
          this.scheduleLayout();
          this.opts.onDragOut(ev);
          return;
        }
      }
      const s = this.slicesForDrag(ev.clientX, ev.clientY);
      if (!s) return;
      if (!this.cursor.selection) this.cursor.selHandle(true);
      if (this.pathOf(s).join() === this.pathOf(this.cursor.slices).join()) return;   // no move: no relayout
      this.cursor.slices = s;
      this.scheduleLayout();
    });
    window.addEventListener('mouseup', () => { if (this.dragging) { this.dragging = false; if (this.cursor.selection && this.cursor.anchor && this.pathOf(this.cursor.anchor).join() === this.pathOf(this.cursor.slices).join()) this.cursor.clearSelection(); this.scheduleLayout(); } });
    this.content.addEventListener('pointermove', ev => { const a = this.insetFromPoint(ev.clientX, ev.clientY); if (a !== this.hoverAtom) { this.hoverAtom = a; this.scheduleLayout(); } });
    this.content.addEventListener('pointerleave', () => { if (this.hoverAtom) { this.hoverAtom = null; this.scheduleLayout(); } });
    // the field re-lays out when its box moves
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => this.scheduleLayout()).observe(this.dom);
  }

  private slicesFromPoint(x: number, y: number): Slice[] | null {
    let el = document.elementFromPoint(x, y) as Element | null;
    let ref: CellRef | undefined;
    for (; el && el !== this.content; el = el.parentElement) {
      const m = /(?:^|\s)lm-c(\d+)(?:\s|$)/.exec(el.className ?? '');
      if (m) { ref = this.cells[Number(m[1])]; break; }
    }
    let cellEl = ref ? el as HTMLElement : null;
    if (!ref || !cellEl) {
      // the point hit no cell box (between rows, above / below the glyphs, over another element):
      // the nearest cell wins, as in LyX (InsetMathNest::editXY takes the cell with the smallest
      // distance) — snapping to the start / end of the whole formula made dragging jumpy
      const near = this.nearestCell(x, y);
      if (!near) return null;
      ref = near.ref; cellEl = near.el;
    }
    const cell = atomCells(ref.owner)[ref.idx] ?? [];
    return this.slicesFor(ref, cell.length ? this.posFromX(cell, cellEl, x) : 0);
  }

  /** the cell whose box is closest to the point (LyX InsetMathNest::editXY; ties go to the innermost box) */
  private nearestCell(x: number, y: number): { ref: CellRef; el: HTMLElement } | null {
    let best: { ref: CellRef; el: HTMLElement } | null = null;
    let bestD = Infinity, bestA = Infinity;
    for (const ref of this.cells) {
      const el = this.content.querySelector(`.lm-c${ref.id}`) as HTMLElement | null;
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
      const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
      const d = dx + dy, a = r.width * r.height;
      if (d < bestD - 0.5 || (d < bestD + 0.5 && a < bestA)) { best = { ref, el }; bestD = d; bestA = a; }
    }
    return best;
  }

  /**
   * Cursor position for a drag: never deeper than the anchor's own nest chain (LyX
   * lfunMouseMotion ignores motions nested deeper than the anchor — they bubble to the common
   * parent). An inset off that chain is taken whole, the cursor lands on its closest edge
   * (Cursor::moveToClosestEdge).
   */
  private slicesForDrag(x: number, y: number): Slice[] | null {
    const s = this.slicesFromPoint(x, y);
    const a = this.cursor.anchor;
    if (!s || !a) return s;
    let d = 0;
    while (d < s.length && d < a.length && s[d].owner === a[d].owner) d++;
    if (d >= s.length) return s;                    // on (or above) the anchor's chain
    const t = s.slice(0, Math.max(1, d));
    const last = t[t.length - 1];
    const inset = s[t.length].owner as Atom;        // the off-chain inset the point dived into
    const r = this.atomRect(inset);
    if (r && x > (r.left + r.right) / 2) last.pos = Math.min(last.pos + 1, atomCells(last.owner)[last.idx]?.length ?? last.pos + 1);
    return t;
  }

  private typed(text: string): void {
    if (this.readOnly || !text) return;
    let keep = false;
    for (const ch of text) {
      if (this.altM) { this.altM = false; if (this.altMKey(ch)) continue; }
      // typing what the suggestion starts with keeps the rest of it on show
      const g = this.ghost;
      keep = !!g && ch !== '\\' && ch !== ' ' && g.startsWith(ch) && g.length > 1;
      this.snapshot('type');
      const ok = this.cursor.interpretChar(ch);
      if (keep) this.ghost = g!.slice(1).replace(/^\s+/, '');
      if (!ok) { this.commit(); this.opts.onMoveOut?.('forward', { insertSpace: ch === ' ' }); return; }
    }
    this.commit(keep);
  }

  private altMKey(k: string): boolean {
    const c = this.cursor;
    const ins = MATH_ALT_M[k];
    if (ins) { this.snapshot('altm'); this.insertLatex(ins); this.commit(); return true; }
    if (k === 'x') { this.snapshot('script'); c.script(false); this.commit(); return true; }
    if (k === 'e') { this.snapshot('script'); c.script(true); this.commit(); return true; }
    if (k === 'm') { this.execute('text'); return true; }
    if (k === 'n' || k === 'd' || k === 't') { this.opts.onCommand?.(k); return true; }
    return false;
  }

  private keydown(ev: KeyboardEvent): void {
    // Keys pressed while a dead-key / IME composition is open (keyCode 229) belong to the
    // composition: acting on Enter / Escape / the arrows here used to move the caret out of the
    // formula before the composition committed — the ^ then landed in the surrounding text.
    if (ev.isComposing || ev.keyCode === 229) { ev.stopPropagation(); return; }
    const mod = /Mac/.test(navigator.platform) ? ev.metaKey : ev.ctrlKey;
    const c = this.cursor;
    const old = c.clone();
    const handled = () => { ev.preventDefault(); ev.stopPropagation(); };
    const move = (f: () => boolean, dir: MoveOutDirection, dissolveEmpty = false) => {
      c.selHandle(ev.shiftKey);
      if (!c.macroModeClose() && !f()) { if (!ev.shiftKey) { const dissolve = dissolveEmpty && this.isEmpty(); this.commit(); this.opts.onMoveOut?.(dir, { dissolve }); } }
      else this.moved(old);
      handled();
    };
    if (ev.altKey && !mod && ev.key.toLowerCase() === 'm') { this.altM = true; handled(); return; }
    if (this.altM && !ev.ctrlKey && !ev.metaKey && ev.key.length === 1) { this.altM = false; if (this.altMKey(ev.key)) { handled(); return; } }
    switch (ev.key) {
      case 'ArrowRight': move(() => c.mathForward(mod), 'forward', true); return;
      case 'ArrowLeft': move(() => c.mathBackward(mod), 'backward', true); return;
      case 'ArrowUp': move(() => c.upDown(true), 'upward'); return;
      case 'ArrowDown': move(() => c.upDown(false), 'downward'); return;
      case 'Home': move(() => c.lineBegin(), 'backward'); return;
      case 'End': move(() => c.lineEnd(), 'forward'); return;
      case 'Tab': {
        handled();
        if (this.ghost && !c.inMacroMode() && !this.readOnly) {
          // accept the autocomplete suggestion as it stands
          const g = this.ghost; this.ghost = null;
          this.snapshot('complete');
          c.insertCell(parseCell(g, this.macros, c.mode));
          this.commit();
          return;
        }
        if (c.inMacroMode() && !this.readOnly) {
          // LyX: Tab completes the command name being typed; a complete name is inserted. A name that is
          // already a valid command sorts first among its own completions in LyX, so Tab finalizes it as
          // typed (\bar, not \baro; \leq, not \leqq) — only an incomplete name takes the suggestion.
          const p = c.activeMacro()!;
          this.snapshot('complete');
          if (p.hint && !isKnownCommand(p.n.slice(1), this.macros)) { p.n += p.hint; this.commit(); return; }
          c.macroModeClose(); c.editInsertedInset(); this.commit(); return;
        }
        if (ev.shiftKey) c.cellBackward(); else c.cellForward(); this.moved(old); return;
      }
      case 'Escape': if (this.ghost) { this.clearGhost(); this.render(); handled(); return; } if (c.selection) { c.clearSelection(); this.scheduleLayout(); } else if (c.inMacroMode()) { c.macroModeClose(true); this.commit(); } else { this.commit(); this.opts.onMoveOut?.('forward', {}); } handled(); return;
      case 'Enter': if (this.readOnly) return; handled(); if (c.inMacroMode()) { this.snapshot('macro'); c.macroModeClose(); c.editInsertedInset(); this.commit(); return; } if (mod || ev.shiftKey || this.display) { this.snapshot('newline'); c.newline(); this.commit(); } else { this.commit(); this.opts.onMoveOut?.('forward', {}); } return;
      case 'Backspace': if (this.readOnly) return; handled(); this.snapshot('delete'); if (!c.backspace()) { const dissolve = this.isEmpty(); this.commit(); this.opts.onMoveOut?.('backward', { dissolve }); return; } this.commit(); return;
      case 'Delete': if (this.readOnly) return; handled(); this.snapshot('delete'); if (!c.erase()) { const dissolve = this.isEmpty(); this.commit(); this.opts.onMoveOut?.('forward', { dissolve }); return; } this.commit(); return;
      default: break;
    }
    if (mod && !ev.altKey) {
      switch (ev.key.toLowerCase()) {
        case 'a': c.selectAll(); this.scheduleLayout(); handled(); return;
        case 'z': if (ev.shiftKey) this.redo(); else this.undo(); handled(); return;
        case 'y': this.redo(); handled(); return;
        case 'l': if (!this.readOnly) { this.snapshot('type'); c.interpretChar('\\'); this.commit(); } handled(); return;
        case 'm': if (!this.readOnly) this.execute(ev.shiftKey ? 'newline' : 'text'); handled(); return;
        case ' ': if (!this.readOnly) { this.snapshot('type'); c.insertAtom({ t: 'space', n: ',' }); this.commit(); } handled(); return;
        case 'b': if (!this.readOnly) this.execute('font', c.mode === 'text' ? 'textbf' : 'mathbf'); handled(); return;
        case 'e': if (!this.readOnly) this.execute('font', c.mode === 'text' ? 'emph' : 'mathcal'); handled(); return;
        case 'k': if (!this.readOnly && getPrefs().aiRewrite && editorContext.aiRewriteMath) { handled(); editorContext.aiRewriteMath(this); } return;
        default: return;   // Ctrl+S etc. bubble to the editor
      }
    }
    // printable characters arrive through beforeinput; stop other keys from reaching ProseMirror
    if (ev.key.length === 1) ev.stopPropagation();
  }
}

function escapeHtml(s: string): string { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

/**
 * Puts the ghost text into the KaTeX source at the end of the cell `lm-c<id>` (as
 * `\htmlClass{lm-ghost}{…}`, which the caret measurement skips): the suggestion is rendered
 * with the formula's own metrics and macros, exactly as it will look once inserted.
 */
export function injectGhost(latex: string, cellId: number, ghost: string, textMode: boolean): string {
  const open = `\\htmlClass{lm-c${cellId}}{`;
  const i = latex.indexOf(open);
  if (i < 0) return latex;
  let depth = 1, j = i + open.length;
  for (; j < latex.length && depth > 0; j++) {
    const ch = latex[j];
    if (ch === '\\') { j++; continue; }
    if (ch === '{') depth++; else if (ch === '}') depth--;
  }
  if (depth !== 0) return latex;
  const close = j - 1;
  const body = textMode ? ghost.replace(/[{}\\]/g, '') : ghost;
  return latex.slice(0, close) + `\\htmlClass{lm-ghost}{${body}}` + latex.slice(close);
}

/** Bounding boxes of the rows of a hull in a rendered container (union of each row's cell boxes). */
export function rowRectsOf(hull: Hull, cells: CellRef[], container: HTMLElement): DOMRect[] {
  const out: DOMRect[] = [];
  for (let r = 0; r < hull.rows.length; r++) {
    let box: DOMRect | null = null;
    for (let c = 0; c < hull.ncols; c++) {
      const ref = cells.find(x => x.owner === hull && x.idx === r * hull.ncols + c);
      const el = ref ? container.querySelector(`.lm-c${ref.id}`) : null;
      if (!el) continue;
      const rr = el.getBoundingClientRect();
      if (!rr.height) continue;
      box = box ? new DOMRect(Math.min(box.left, rr.left), Math.min(box.top, rr.top), Math.max(box.right, rr.right) - Math.min(box.left, rr.left), Math.max(box.bottom, rr.bottom) - Math.min(box.top, rr.top)) : rr;
    }
    out.push(box ?? new DOMRect(0, 0, 0, 0));
  }
  return out;
}

/** Static rendering of a formula (no editing) — the same source as the field, so it looks identical. */
export function renderStaticHtml(latex: string, display: boolean, macros: MacroTable): string {
  try {
    const hull = parseFormula(latex, macros);
    const { latex: src } = renderHullSource(hull, macros);
    return katex.renderToString((display ? '\\displaystyle ' : '') + src, { throwOnError: false, strict: false, trust: true, displayMode: false, output: 'html', macros: katexMacros(macros) });
  } catch {
    return `<span class="lm-error">${escapeHtml(latex)}</span>`;
  }
}

export { writeCellLatex, numberedType };
