/**
 * LyxMathField — the editable formula widget: the LyX math model rendered with MathJax
 * (mathjax.ts), a LyX cursor (core/math/cursor.ts) drawn as an overlay, LyX's keyboard and mouse
 * behaviour, undo.
 *
 * DOM: <span class="lm-field"><span class="lm-content">MathJax</span><span class="lm-overlay">caret,
 * selection, corner markers</span><textarea class="lm-input"></textarea></span>
 * Every cell of the model is wrapped in `\htmlClass{lm-c<id>}{…}` and every atom in
 * `\htmlClass{lm-a}{…}` by the renderer (core/math/mathjax.ts), each a box of MathJax's layout,
 * so the caret, the selection, the corner markers and the mouse work on LyX's coordinate model
 * (geometry.ts): every atom has a box, every cell a baseline and a content-tight box. The mouse
 * follows InsetMathNest::editXY / lfunMousePress / lfunMouseMotion exactly.
 */
import {
  parseFormula, writeFormula, writeCellLatex, parseCell, renderHullSource, mathjaxMacros, MathCursor, atomCells, nargs, numberedType, isKnownCommand, completeCommand,
  type Hull, type HullType, type MacroTable, type Slice, type Atom, type Cell, type CellRef, type Owner,
} from '@overlyx/core';
import { MathGeometry, editXY, moveToClosestEdge, partOfAnchor, insetAt, boundaryX, x2pos, type AtomGeom } from './geometry';
import { graphicsUrl } from '../../api';
import { editorContext, resolveDocPath } from '../context';
import { getPrefs } from '../../prefs';
import { renderMath, onMathRendererChange } from './mathjax';

export type MoveOutDirection = 'backward' | 'forward' | 'upward' | 'downward';

export interface FieldOptions {
  latex: string;
  display: boolean;
  macros: MacroTable;
  /** Project location used to resolve image-based math macros. */
  imageContext?: MathImageContext;
  readOnly?: boolean;
  onChange?: (latex: string) => void;
  /**
   * The cursor left the formula. `dissolve`: the formula is empty and was left with a horizontal
   * move (arrow / Backspace / Delete) — the owner may remove it (an empty formula left behind
   * by Ctrl+M, then a cursor key, is never wanted).
   */
  onMoveOut?: (dir: MoveOutDirection, opts: { insertSpace?: boolean; dissolve?: boolean; putBack?: string }) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  /** Alt+M n/d/t: numbering / environment commands handled by the node view; '$$' = a second $ typed into an empty inline formula opened with $ (make it a display formula) */
  onCommand?: (key: string) => void;
  /**
   * A drag left the formula (LyX: the motion bubbles to the surrounding text, formula taken whole).
   * `reenter(ev)` hands the drag back when the pointer returns into the formula (returns false when
   * the pointer is not over it): the selection shrinks back into the formula, as in LyX.
   */
  onDragOut?: (ev: MouseEvent, reenter: (ev: MouseEvent) => boolean) => void;
  /** Shift+click on a formula that has no cursor of its own to extend from: the document selects, the formula taken whole */
  onShiftClick?: (ev: MouseEvent) => void;
  /** a Shift+arrow hit the formula's edge: the selection continues outside, formula taken whole */
  onSelectOut?: (dir: MoveOutDirection) => void;
}

export interface MathImageContext { project?: string | null; docDir?: string }

/** how a formula's \includegraphics files are found: the project's graphics endpoint (PDF and SVG converted for the browser) */
export function mathImageResolver(context?: MathImageContext): (src: string) => string {
  return (src: string) => {
    const project = context?.project ?? editorContext.project;
    const docDir = context?.docDir ?? editorContext.docDir;
    // explicit web/data URLs are already usable; TeX project file names are relative paths
    if (!project || !src || /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(src)) return src;
    return graphicsUrl(project, resolveDocPath(src, docDir), 400);
  };
}

/** Image glyphs (`lm-image-glyph`, core/macros.ts) are drawn as alpha masks, so their ink follows the text colour. */
export function maskImageGlyphs(root: ParentNode): void {
  for (const glyph of Array.from(root.querySelectorAll<HTMLElement>('.lm-image-glyph mjx-mglyph'))) {
    const img = glyph.querySelector('img');
    if (!img) continue;
    const url = img.getAttribute('src')!.replace(/["\\\n\r\f]/g, c => '\\' + c.charCodeAt(0).toString(16) + ' ');
    glyph.setAttribute('style', `${glyph.getAttribute('style') ?? ''}mask-image:url("${url}");`);
  }
}

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
/** A formula pasted into a field may carry its delimiters ($…$, $$…$$, \[…\], \(…\)) — only the content belongs inside. */
export function stripMathDelims(s: string): string {
  const t = s.trim();
  const m = /^(\$\$|\$|\\\[|\\\()([\s\S]*?)(\$\$|\$|\\\]|\\\))$/.exec(t);
  if (!m) return t;
  const close: Record<string, string> = { '$$': '$$', $: '$', '\\[': '\\]', '\\(': '\\)' };
  return close[m[1]] === m[3] ? m[2].trim() : t;
}

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
  /**
   * Set when the formula was opened by typing `$` (or `$$`) in the text: `$` then closes it again
   * (the cursor leaves forwards, as after the closing dollar of `$x$`), a second `$` in the still
   * empty inline formula makes it a display formula, and Backspace in the empty formula puts the
   * typed marker back as text (the convention of the `- ` / `# ` triggers: Backspace undoes them).
   */
  dollar: '' | '$' | '$$' = '';
  private dragging = false;
  private deadHat = false;
  private lastLatex: string;
  private _macroKey = '';
  private hoverAtom: Atom | null = null;
  /** measured boxes of the current rendering (rebuilt when the content is re-rendered or moved) */
  private geom: MathGeometry | null = null;
  private geomStamp = '';
  /** the anchor of the mouse drag in progress (LyX's real anchor: the markers follow it while selecting) */
  private dragAnchor: Slice[] | null = null;
  private windowListeners: [string, (ev: MouseEvent) => void][] = [];
  /** an autocomplete suggestion shown faintly after the caret (ai/mathassist.ts); Tab inserts it */
  private ghost: string | null = null;
  /** counts renderings (a retry renders again only if nothing else did meanwhile) */
  private renderStamp = 0;
  private offRenderer: () => void;
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
    // another math font: drawn again
    this.offRenderer = onMathRendererChange(() => this.render());
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
    // a macro's arity changes how the source parses (\bh with an unknown arity became a bare
    // command atom rendered as "unknown" — a field created before the document's macros arrived
    // stayed broken): re-parse the current content with the new table, keeping the cursor
    const latex = writeFormula(this.hull);
    const path = this.pathOf(this.cursor.slices);
    this.hull = parseFormula(latex, this.macros);
    this.lastLatex = latex;
    this.cursor = new MathCursor(this.hull, this.macros, { xToPos: (cell, x) => this.xToPos(cell, x) });
    if (!this.restorePath(path)) { this.cursor.idx = this.cursor.lastidx; this.cursor.pos = this.cursor.lastpos; }
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
  destroy(): void { cancelAnimationFrame(this.raf); this.offRenderer(); this.renderStamp++; for (const [t, l] of this.windowListeners) window.removeEventListener(t, l as EventListener); this.windowListeners = []; this.dom.remove(); }

  /** Commands for menus, toolbars and shortcuts. */
  execute(cmd: string, ...args: unknown[]): boolean {
    if (this.readOnly) return false;
    const c = this.cursor;
    const change = (kind: string, f: () => void) => { this.snapshot(kind); f(); this.commit(); return true; };
    switch (cmd) {
      case 'insert': return change('insert', () => this.insertLatex(String(args[0] ?? '')));
      // clipboard text: rows / cells copied from a grid go in cell by cell (MathCursor.paste)
      case 'paste': { const t = stripMathDelims(String(args[0] ?? '')); return t ? change('paste', () => c.paste(t)) : false; }
      case 'moveToMathfieldStart': this.focus('start'); return true;
      case 'moveToMathfieldEnd': this.focus('end'); return true;
      case 'moveToSuperscript': return change('script', () => c.script(true));
      case 'moveToSubscript': return change('script', () => c.script(false));
      case 'delim': return change('delim', () => { const l = String(args[0] ?? '('), r = String(args[1] ?? ')'); c.handleNest({ t: 'delim', l: l.replace(/^\\/, ''), r: r.replace(/^\\/, ''), body: [] }); });
      case 'bigdelim': return change('bigdelim', () => { const [ln, ld, rn, rd] = args as string[]; const sel = c.grabAndEraseSelection(); c.insertAtom({ t: 'big', n: ln, d: ld }); if (rn) { c.insertAtom({ t: 'big', n: rn, d: rd }); c.posBackward(); } if (sel) c.niceInsert(sel, false); });
      case 'matrix': return change('matrix', () => { const rows = Number(args[0] ?? 2), cols = Number(args[1] ?? 2), env = String(args[2] ?? 'matrix'); const halign = String(args[3] ?? ''); c.niceInsertAtom({ t: 'grid', env, ncols: cols, rows: Array.from({ length: rows }, () => ({ cells: Array.from({ length: cols }, () => [] as Cell) })), halign: env === 'array' ? (halign || 'c'.repeat(cols)) : undefined }); });
      case 'font': return change('font', () => c.handleFont(String(args[0] ?? 'mathrm')));
      case 'delimSize': { this.snapshot('delim'); const ok = c.delimResize(Number(args[0]) < 0 ? -1 : 1); if (ok) this.commit(); else this.undoStack.pop(); return ok; }
      case 'limits': return change('limits', () => c.toggleLimits());
      case 'numberToggle': return change('number', () => c.numberToggle());
      case 'numberLineToggle': return change('number', () => c.numberLineToggle());
      case 'label': return change('label', () => c.setLabel(String(args[0] ?? ''), typeof args[1] === 'number' ? args[1] : undefined));
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
      case 'text': return change('text', () => c.mathMode());
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
    const rendered = renderHullSource(this.hull, this.macros, { atoms: true });
    let latex = rendered.latex;
    const cells = rendered.cells;
    this.cells = cells;
    this.rebuildParents();
    if (this.ghost && this.focused && !this.cursor.selection && !this.cursor.inMacroMode() && this.atCellEnd()) {
      const ref = cells.find(c => c.owner === this.cursor.owner && c.idx === this.cursor.idx);
      if (ref) latex = injectGhost(latex, ref.id, this.ghost, this.cursor.mode === 'text');
    }
    const r = renderMath(latex, { display: this.display, macros: mathjaxMacros(this.macros), image: mathImageResolver(this.opts.imageContext) });
    if (r.node) { this.content.replaceChildren(r.node); maskImageGlyphs(this.content); }
    else if (r.error || !this.content.firstChild) this.content.innerHTML = `<span class="${r.error ? 'lm-error' : 'lm-error lm-pending'}">${escapeHtml(this.lastLatex)}</span>`;
    // font data (or an image's shape) still on its way: rendered again once it is here
    if (r.retry) { const stamp = ++this.renderStamp; void r.retry.then(() => { if (stamp === this.renderStamp && this.dom.isConnected) this.render(); }); }
    this.geom = null;
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

  /** the boxes of the current rendering, re-measured when the content was re-rendered or has moved (scrolling, reflow) */
  private geometry(): MathGeometry {
    const r = this.content.getBoundingClientRect();
    const stamp = `${r.left},${r.top},${r.width},${r.height}`;
    if (!this.geom || stamp !== this.geomStamp) { this.geom = new MathGeometry(this.content, this.cells, this.parents); this.geomStamp = stamp; }
    return this.geom;
  }

  /** the caret before position `pos` of a cell: x of the boundary (MathData::pos2x), the cell's font line box (client coordinates) */
  private caretRect(owner: Owner, idx: number, pos: number): { x: number; top: number; bottom: number } | null {
    const cg = this.geometry().cell(owner, idx);
    if (!cg) return null;
    return { x: boundaryX(cg, pos), top: cg.lineTop, bottom: cg.lineBottom };
  }

  /** MathCursor host: the position in a cell closest to a client x (the x target of up/down moves) */
  private xToPos(cell: Cell, x: number | null): number {
    if (x === null) return 0;
    const ref = this.cells.find(c => (atomCells(c.owner)[c.idx] ?? null) === cell);
    const cg = ref ? this.geometry().cell(ref.owner, ref.idx) : null;
    return cg ? x2pos(cg, x) : 0;
  }

  layout(): void {
    const ov = this.overlay;
    ov.replaceChildren();
    const base = this.dom.getBoundingClientRect();
    const c = this.cursor;
    const g = this.geometry();
    // the inset under the mouse pointer is marked (Color_mathframe), also when not editing
    const hover = this.hoverAtom;
    if (hover && !(this.focused && c.slices.some(s => s.owner === hover))) { const r = g.atom(hover); if (r) this.corners(ov, base, r, markerKind(hover)); }
    if (!this.focused) return;
    // selection (MathData::drawSelection): inside one cell from boundary to boundary over the
    // cell's height; whole cells when it spans cells
    const sel = c.selRange();
    if (sel) {
      const paint = (x1: number, x2: number, top: number, bottom: number) => {
        const d = document.createElement('span');
        d.className = 'lm-sel';
        d.style.cssText = `left:${x1 - base.left}px;top:${top - base.top}px;width:${Math.max(2, x2 - x1)}px;height:${bottom - top}px`;
        ov.appendChild(d);
      };
      if (sel.idx1 === sel.idx2) {
        const cg = g.cell(sel.owner, sel.idx1);
        if (cg) paint(boundaryX(cg, sel.from), boundaryX(cg, sel.to), cg.top, cg.bottom);
      } else {
        for (const row of c.selCells(sel)) for (const idx of row) { const cg = g.cell(sel.owner, idx); if (cg) paint(cg.left, cg.right, cg.top, cg.bottom); }
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
    // LyX corner markers around every inset on the cursor's path — the anchor's path while the
    // mouse selects (Inset::editing: no flicker from the moving cursor)
    const path = this.dragging && this.dragAnchor ? this.dragAnchor : c.slices;
    for (let d = 1; d < path.length; d++) {
      const inset = path[d].owner as Atom;
      const r = g.atom(inset);
      if (!r) continue;
      this.corners(ov, base, r, markerKind(inset), inset.t === 'macro' ? '\\' + inset.n : undefined);
    }
  }

  /**
   * MathRow drawMarkers: 3px hooks in the corners of the inset's box — one pixel left of its
   * content, at its right edge, one pixel above and below (LyX reserves that margin around marked
   * insets); the lower pair always, the upper pair for MARKER2 insets.
   */
  private corners(ov: HTMLElement, base: DOMRect, r: AtomGeom, kind: 'lower' | 'both', label?: string): void {
    const l = r.glyphLeft - base.left - 1, rt = r.glyphRight - base.left;
    const t = r.top - base.top - 1, b = r.bottom - base.top + 1;
    const corner = (x: number, y: number, h: 'left' | 'right', v: 'top' | 'bottom') => {
      const d = document.createElement('span');
      d.className = 'lm-corner';
      d.style.cssText = `left:${x}px;top:${y}px;border-${h}:1px solid ${MARKER_COLOR};border-${v}:1px solid ${MARKER_COLOR}`;
      ov.appendChild(d);
    };
    corner(l, b - 3, 'left', 'bottom'); corner(rt - 3, b - 3, 'right', 'bottom');
    if (kind === 'both') { corner(l, t, 'left', 'top'); corner(rt - 3, t, 'right', 'top'); }
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
    input.addEventListener('paste', ev => { ev.preventDefault(); if (this.readOnly) return; const t = ev.clipboardData?.getData('text/plain') ?? ''; if (!t) return; this.snapshot('paste'); this.cursor.paste(stripMathDelims(t)); this.commit(); });
    // mouse (InsetMathNest::lfunMousePress / Motion / Release)
    this.dom.addEventListener('mousedown', ev => this.press(ev));
    const move = (ev: MouseEvent) => this.motion(ev);
    const up = () => this.release();
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    this.windowListeners.push(['mousemove', move], ['mouseup', up]);
    this.content.addEventListener('pointermove', ev => { const a = insetAt(this.geometry(), this.hull, ev.clientX, ev.clientY); if (a !== this.hoverAtom) { this.hoverAtom = a; this.scheduleLayout(); } });
    this.content.addEventListener('pointerleave', () => { if (this.hoverAtom) { this.hoverAtom = null; this.scheduleLayout(); } });
    // the field re-lays out when its box moves
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => { this.geom = null; this.scheduleLayout(); }).observe(this.dom);
  }

  /**
   * lfunMousePress: the cursor goes to the point (editXY: the nearest cell, the closest position,
   * down into the inset under the pointer), then behind the next inset when the pointer is nearer
   * to its right edge (moveToClosestEdge); Shift extends the selection from the anchor with the
   * clicked inset taken whole (setCursorSelectionTo); a double click selects the cell, a triple
   * click all cells of the inset (LFUN_MOUSE_DOUBLE / TRIPLE). No drag-and-drop of a selection: a
   * press always places the cursor, a drag always selects.
   */
  private press(ev: MouseEvent): void {
    // a right (or middle) button: nothing of the browser's own — no caret moved into the formula's DOM, no
    // focus change — so the document's selection (a selected equation, say) is still there for the menu
    if (ev.button !== 0) { ev.preventDefault(); return; }
    if (ev.shiftKey && !this.focused && this.opts.onShiftClick) { ev.preventDefault(); this.opts.onShiftClick(ev); return; }
    ev.preventDefault();
    const old = this.cursor.clone();
    // mouseSetCursor closes an unfinished \command at the old cursor before it moves; the boxes
    // are measured on what is rendered, so re-render when that changed the formula
    const before = this.latex;
    this.cursor.macroModeClose();
    if (this.latex !== before) this.render();
    const g = this.geometry();
    const s = editXY(g, this.hull, ev.clientX, ev.clientY);
    moveToClosestEdge(g, s, ev.clientX);
    const c = this.cursor;
    c.xTarget = null;
    if (ev.shiftKey) { if (!c.anchor) c.resetAnchor(); c.setCursorSelectionTo(s); }
    else {
      c.slices = s; c.clearSelection(); c.resetAnchor();
      if (ev.detail === 2) { c.pos = 0; c.resetAnchor(); c.pos = c.lastpos; c.setSelection(); }
      else if (ev.detail === 3) { c.idx = 0; c.pos = 0; c.resetAnchor(); c.idx = c.lastidx; c.pos = c.lastpos; c.setSelection(); }
    }
    this.dragAnchor = c.anchor ? c.anchor.map(x => ({ ...x })) : c.clone();
    this.dragging = true;
    this.input.focus({ preventScroll: true });
    this.moved(old);
  }

  /** the pointer is outside the formula's box (with a little slack: LyX's hull margins) */
  private outside(ev: MouseEvent): boolean {
    const r = this.dom.getBoundingClientRect();
    return ev.clientX < r.left - 4 || ev.clientX > r.right + 4 || ev.clientY < r.top - 6 || ev.clientY > r.bottom + 6;
  }

  /**
   * lfunMouseMotion: the cursor of the point, popped out of any inset that is not on the anchor's
   * chain (or deeper than the anchor) — that inset is taken whole at its closest edge — and the
   * selection between the anchor and it. Outside the formula the surrounding text carries on with
   * the formula taken whole (the motion is undispatched here in LyX), until the pointer returns.
   */
  private motion(ev: MouseEvent): void {
    if (!this.dragging) return;
    const anchor = this.dragAnchor;
    if (!anchor) return;
    if (this.opts.onDragOut && this.outside(ev)) {
      this.dragging = false;
      this.cursor.clearSelection();
      this.scheduleLayout();
      this.opts.onDragOut(ev, mv => this.reenter(mv));
      return;
    }
    const g = this.geometry();
    const s = partOfAnchor(anchor, editXY(g, this.hull, ev.clientX, ev.clientY));
    moveToClosestEdge(g, s, ev.clientX);
    if (this.pathOf(s).join() === this.pathOf(this.cursor.slices).join()) return;   // no move: no update
    this.cursor.slices = s;
    this.cursor.anchor = anchor.map(x => ({ ...x }));
    this.cursor.setSelection();
    this.scheduleLayout();
    if (this.focused) notifyCursor(this);
  }

  /** the drag that left the formula came back: it goes on inside, from the same anchor */
  private reenter(ev: MouseEvent): boolean {
    if (!this.dragAnchor || this.outside(ev)) return false;
    this.cursor.slices = this.dragAnchor.map(x => ({ ...x }));
    this.cursor.anchor = this.dragAnchor.map(x => ({ ...x }));
    this.dragging = true;
    this.input.focus({ preventScroll: true });
    this.motion(ev);
    this.scheduleLayout();
    return true;
  }

  /** lfunMouseRelease: a drag that did not move leaves no selection */
  private release(): void {
    if (!this.dragging) return;
    this.dragging = false;
    if (this.cursor.selection && this.cursor.anchor && this.pathOf(this.cursor.anchor).join() === this.pathOf(this.cursor.slices).join()) this.cursor.clearSelection();
    this.scheduleLayout();
  }

  private typed(text: string): void {
    if (this.readOnly || !text) return;
    let keep = false;
    for (const ch of text) {
      if (this.altM) { this.altM = false; if (this.altMKey(ch)) continue; }
      if (ch === '$' && this.dollarKey()) return;
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

  /** `$` typed into a formula that was opened with `$`: close it, or (still empty, inline) make it a display formula. */
  private dollarKey(): boolean {
    if (!this.dollar) return false;
    if (this.isEmpty()) {
      if (!this.display && this.dollar === '$') { this.dollar = '$$'; this.opts.onCommand?.('$$'); return true; }
      return true;   // a third $ in an empty display formula: nothing to do
    }
    this.commit();
    this.opts.onMoveOut?.('forward', {});
    return true;
  }

  private altMKey(k: string): boolean {
    const c = this.cursor;
    const ins = MATH_ALT_M[k];
    if (ins) { this.snapshot('altm'); this.insertLatex(ins); this.commit(); return true; }
    if (k === 'x') { this.snapshot('script'); c.script(false); this.commit(); return true; }
    if (k === 'e') { this.snapshot('script'); c.script(true); this.commit(); return true; }
    if (k === 'm') { this.execute('text'); return true; }
    if (k === 'N') { this.execute('numberLineToggle'); return true; }   // LyX M-m N: math-number-line-toggle
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
      if (!c.macroModeClose() && !f()) {
        if (!ev.shiftKey) { const dissolve = dissolveEmpty && this.isEmpty(); this.commit(); this.opts.onMoveOut?.(dir, { dissolve }); }
        // LyX: selecting past the edge pops the cursor out — the selection continues in the
        // document with the formula taken whole (selBegin/selEnd normalize to the inset)
        else if (this.opts.onSelectOut) { c.clearSelection(); this.commit(); this.opts.onSelectOut(dir); }
      }
      else this.moved(old);
      handled();
    };
    if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown' && !ev.key.startsWith('Shift') && !ev.key.startsWith('Control') && !ev.key.startsWith('Meta') && !ev.key.startsWith('Alt')) c.xTarget = null;
    if (ev.altKey && !mod && ev.key.toLowerCase() === 'm') { this.altM = true; handled(); return; }
    if (this.altM && !ev.ctrlKey && !ev.metaKey && ev.key.length === 1) { this.altM = false; if (this.altMKey(ev.key)) { handled(); return; } }
    switch (ev.key) {
      case 'ArrowRight': move(() => c.mathForward(mod), 'forward', true); return;
      case 'ArrowLeft': move(() => c.mathBackward(mod), 'backward', true); return;
      case 'ArrowUp': case 'ArrowDown': {
        // Cursor::upDownInMath keeps an x target across vertical moves, so the cursor stays in its column
        if (c.xTarget === null) c.xTarget = this.caretRect(c.owner, c.idx, c.pos)?.x ?? null;
        const x = c.xTarget;
        move(() => c.upDown(ev.key === 'ArrowUp'), ev.key === 'ArrowUp' ? 'upward' : 'downward');
        c.xTarget = x;
        return;
      }
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
      case 'Backspace': if (this.readOnly) return; handled(); this.snapshot('delete'); if (!c.backspace()) { const dissolve = this.isEmpty(); this.commit(); this.opts.onMoveOut?.('backward', { dissolve, putBack: dissolve && this.dollar ? this.dollar : undefined }); return; } this.commit(); return;
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

/** InsetMath::marker: fractions, grids and macros are marked in all four corners (MARKER2), other insets below */
function markerKind(a: Atom): 'lower' | 'both' { return a.t === 'frac' || a.t === 'grid' || a.t === 'macro' ? 'both' : 'lower'; }

/**
 * Puts the ghost text into the TeX source at the end of the cell `lm-c<id>` (as
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

/**
 * Static rendering of a formula (no editing) into `el` — the same source as the field, so it looks
 * identical. `onRetry`: called when it should be rendered again (font data or an image's shape
 * arrived after this rendering had to do without).
 */
export function renderStaticInto(el: HTMLElement, latex: string, display: boolean, macros: MacroTable, imageContext?: MathImageContext, onRetry?: () => void): void {
  let r: ReturnType<typeof renderMath> | null = null;
  try {
    const hull = parseFormula(latex, macros);
    const { latex: src } = renderHullSource(hull, macros);
    r = renderMath(src, { display, macros: mathjaxMacros(macros), image: mathImageResolver(imageContext) });
  } catch { /* shown as an error */ }
  if (r?.node) { el.replaceChildren(r.node); maskImageGlyphs(el); }
  else el.innerHTML = `<span class="${r && !r.error ? 'lm-error lm-pending' : 'lm-error'}">${escapeHtml(latex)}</span>`;
  if (r?.retry && onRetry) void r.retry.then(onRetry);
}

/** Static rendering of a formula as markup (see renderStaticInto). */
export function renderStaticHtml(latex: string, display: boolean, macros: MacroTable, imageContext?: MathImageContext, onRetry?: () => void): string {
  const el = document.createElement('span');
  renderStaticInto(el, latex, display, macros, imageContext, onRetry);
  return el.innerHTML;
}

export { writeCellLatex, numberedType };
