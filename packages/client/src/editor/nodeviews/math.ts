/**
 * Node views for math: inline formulas, display formulas and macro definitions, edited in place
 * with the LyX-style math editor (editor/lyxmath). Formulas render statically first and become
 * editable fields when they come into view or are hovered/clicked.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { NodeSelection, TextSelection } from 'prosemirror-state';
import type { EditorView, NodeView } from 'prosemirror-view';
import { macroFromLyxLines, parseFormula, renderHullSource, numberedType, type HullType } from '@overlyx/core';
import { LyxMathField, renderStaticHtml, activeMathField, rowRectsOf } from '../lyxmath/field';
import { macroTableFor, mathViews, macroVersion, macrosReady } from '../lyxmath/macrotable';
import { showContextMenu, type MenuItem } from '../contextmenu';
import { toggleMathDisplay, countLabelRefs, renameLabelRefs } from '../commands';
import { editorContext } from '../context';
import { getPrefs } from '../../prefs';
import { openRewriteMath, REWRITE_KEY } from '../ai/rewrite';

/** Position of a formula that was just inserted by the user and should grab the keyboard once mounted. */
export const pendingFocus: { pos: number | null; keys: string[] } = { pos: null, keys: [] };

/* ------------------------------------------------ deferred static rendering */

interface Deferrable { dom: HTMLElement; view: EditorView; pending: boolean; renderPending(): void }
/** formulas showing their source instead of a rendering; rendered in idle time (document order) or when scrolled near */
const staticQueue = new Set<Deferrable>();
let staticPumpScheduled = false;
let batchStart = 0, lastBudgetCheck = 0;
/**
 * Synchronous rendering budget: one burst of node-view constructions (the initial render of a
 * document) may spend ~40 ms on KaTeX; the formulas after that only show their source and are
 * rendered in idle time. Keeps the first paint of a long paper fast without the formulas at the
 * top (where the cursor is) ever appearing unrendered.
 */
function canRenderNow(): boolean {
  const now = performance.now();
  if (now - lastBudgetCheck > 20) batchStart = now;
  lastBudgetCheck = now;
  return now - batchStart < 40;
}
const idle: (cb: (d: { timeRemaining(): number }) => void) => void =
  typeof (window as any).requestIdleCallback === 'function' ? (cb) => (window as any).requestIdleCallback(cb, { timeout: 500 }) : (cb) => setTimeout(() => cb({ timeRemaining: () => 8 }), 16);
function schedulePump(): void {
  if (staticPumpScheduled || !staticQueue.size) return;
  staticPumpScheduled = true;
  idle(pumpStatic);
}
function pumpStatic(deadline: { timeRemaining(): number }): void {
  staticPumpScheduled = false;
  let waiting = false;
  for (const v of staticQueue) {
    if (deadline.timeRemaining() < 3) { waiting = true; break; }
    if (!macrosReady(v.view)) continue;     // stays queued until its document's macros are known
    v.renderPending();
  }
  if (waiting) schedulePump();
}

/* ------------------------------------------------ lazy upgrade of static formulas */

interface Upgradable extends Deferrable { upgrade(): void }
const lazyQueue: Upgradable[] = [];
let pumping = false;
const io = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const v = (e.target as any).__lyxMathView as Upgradable | undefined;
    if (!v) continue;
    // near the viewport: render right away instead of waiting for idle time
    if (v.pending && macrosReady(v.view)) v.renderPending();
    if (!lazyQueue.includes(v)) lazyQueue.push(v);
  }
  pump();
}, { rootMargin: '900px 0px' }) : null;

function pump() {
  if (pumping) return;
  pumping = true;
  const step = () => {
    const batch = lazyQueue.splice(0, 8);
    for (const v of batch) v.upgrade();
    if (lazyQueue.length) requestAnimationFrame(step); else pumping = false;
  };
  requestAnimationFrame(step);
}
function watchLazy(v: Upgradable) { (v.dom as any).__lyxMathView = v; io?.observe(v.dom); }
function unwatchLazy(v: Upgradable) { io?.unobserve(v.dom); staticQueue.delete(v); const i = lazyQueue.indexOf(v); if (i >= 0) lazyQueue.splice(i, 1); }

/* ------------------------------------------------ shared */

const DELIMS: [string, string, string][] = [['( )', '(', ')'], ['[ ]', '[', ']'], ['{ }', '{', '}'], ['| |', '|', '|'], ['‖ ‖', 'Vert', 'Vert'], ['⟨ ⟩', 'langle', 'rangle'], ['⌊ ⌋', 'lfloor', 'rfloor'], ['⌈ ⌉', 'lceil', 'rceil']];

/** Menu entries shared by all formula kinds. */
function commonMathMenu(f: LyxMathField): MenuItem[] {
  const ins = (latex: string) => () => { f.focus(); f.execute('insert', latex); };
  const c = f.cursor;
  return [
    ...(getPrefs().aiRewrite ? [{ label: c.selection ? 'Rewrite selected part with AI…' : 'Rewrite formula with AI…', shortcut: REWRITE_KEY, action: () => openRewriteMath(f) } as MenuItem, { sep: true } as MenuItem] : []),
    { label: 'Insert', sub: [
      { label: 'Fraction', shortcut: 'Alt+M F', action: ins('\\frac{#0}{}') },
      { label: 'Square root', shortcut: 'Alt+M S', action: ins('\\sqrt{#0}') },
      { label: 'Root', shortcut: 'Alt+M R', action: ins('\\sqrt[]{#0}') },
      { label: 'Sum', shortcut: 'Alt+M U', action: ins('\\sum') },
      { label: 'Integral', shortcut: 'Alt+M I', action: ins('\\int') },
      { label: 'Limit', shortcut: 'Alt+M L', action: ins('\\lim') },
      { label: 'Text', shortcut: 'Ctrl+M', action: () => { f.focus(); f.execute('text'); } },
      { label: 'Superscript', shortcut: 'Alt+M E', action: () => { f.focus(); f.execute('moveToSuperscript'); } },
      { label: 'Subscript', shortcut: 'Alt+M X', action: () => { f.focus(); f.execute('moveToSubscript'); } },
      { label: 'Delimiters', sub: DELIMS.map(([l, a, b]) => ({ label: l, action: () => { f.focus(); f.execute('delim', a, b); } })) },
      { label: 'Matrix', sub: [['2×2', 2, 2, 'pmatrix'], ['3×3', 3, 3, 'pmatrix'], ['2×2 brackets', 2, 2, 'bmatrix'], ['cases', 2, 2, 'cases']].map(([l, r, cc, env]) => ({ label: String(l), action: () => { f.focus(); f.execute('matrix', r, cc, env); } })) },
      { label: 'Thin space', shortcut: 'Ctrl+Space', action: ins('\\,') },
    ] },
    { label: 'Font', sub: [['Roman', 'mathrm'], ['Bold', 'mathbf'], ['Bold symbol', 'boldsymbol'], ['Calligraphic', 'mathcal'], ['Blackboard', 'mathbb'], ['Fraktur', 'mathfrak'], ['Sans serif', 'mathsf'], ['Typewriter', 'mathtt'], ['Italic', 'mathit']].map(([l, n]) => ({ label: l, action: () => { f.focus(); f.execute('font', n); } })) },
    { label: 'Toggle limits (\\limits)', action: () => { f.focus(); f.execute('limits'); } },
    { label: c.selection ? 'Copy LaTeX of selection' : 'Copy LaTeX', action: () => { void navigator.clipboard?.writeText(c.selection ? c.grabSelection() : f.latex); } },
  ];
}

function deleteFormula(view: EditorView, getPos: () => number | undefined) {
  const pos = getPos();
  if (pos === undefined) return;
  const node = view.state.doc.nodeAt(pos);
  if (!node) return;
  view.dispatch(view.state.tr.delete(pos, pos + node.nodeSize));
  view.focus();
}

/**
 * Leave the field into the document: cursor before/after the formula node. `dissolve` (an empty
 * formula left with a horizontal cursor move, as LyX does): the formula is removed and the cursor
 * takes its place.
 */
function moveOut(view: EditorView, getPos: () => number | undefined, dir: string, insertSpace: boolean, dissolve = false) {
  const pos = getPos();
  if (pos === undefined) return;
  const node = view.state.doc.nodeAt(pos);
  const size = node ? node.nodeSize : 1;
  const back = dir === 'backward' || dir === 'upward';
  let tr = view.state.tr;
  if (dissolve && node) { tr = tr.delete(pos, pos + size); tr = tr.setSelection(TextSelection.near(tr.doc.resolve(pos), back ? -1 : 1)); }
  else tr = tr.setSelection(TextSelection.near(view.state.doc.resolve(back ? pos : pos + size), back ? -1 : 1));
  if (insertSpace) tr = tr.insertText(' ');
  view.dispatch(tr);
  view.focus();
}

/** Common field wiring: context menu, mouse isolation from ProseMirror, keyboard passthrough. */
function wire(f: LyxMathField, menu: () => MenuItem[]) {
  f.dom.addEventListener('contextmenu', (ev: MouseEvent) => {
    ev.preventDefault(); ev.stopPropagation();
    showContextMenu(ev.clientX, ev.clientY, [...menu(), { sep: true }, ...commonMathMenu(f)]);
  });
  f.dom.addEventListener('mousedown', ev => { ev.stopPropagation(); });
  f.dom.addEventListener('keydown', (ev: KeyboardEvent) => {
    // global shortcuts (save, find, …) may bubble to the editor; everything else stays in the field
    const mod = /Mac/.test(navigator.platform) ? ev.metaKey : ev.ctrlKey;
    const passthrough = mod && ['s', 'r', 'f', 'o', 'p', 'w'].includes(ev.key.toLowerCase()) && !ev.altKey;
    if (!passthrough) ev.stopPropagation();
  });
}

function focusIfPending(f: LyxMathField, getPos: () => number | undefined) {
  const pos = getPos();
  if (pos === undefined || pendingFocus.pos !== pos) return;
  pendingFocus.pos = null;
  requestAnimationFrame(() => { f.focus('end'); for (const k of pendingFocus.keys.splice(0)) f.execute('insert', k); });
}

/* ------------------------------------------------ inline formulas */

export class MathInlineView implements NodeView {
  dom: HTMLElement;
  field: LyxMathField | null = null;
  private staticEl: HTMLElement | null = null;
  private staticKey = '';
  private updating = false;
  private lastLatex: string;
  /** shows its source; rendered later (idle time / scrolled near / macros known) */
  pending = false;

  constructor(private node: PMNode, public view: EditorView, private getPos: () => number | undefined) {
    this.dom = document.createElement('span');
    this.dom.className = 'lyx-math-inline';
    this.lastLatex = String(node.attrs.latex);
    this.dom.classList.toggle('empty', !this.lastLatex.trim());
    mathViews.add(this);
    if (pendingFocus.pos !== null && pendingFocus.pos === getPos()) this.upgrade();
    else { this.renderStaticOrDefer(); watchLazy(this); }
    this.dom.addEventListener('pointerenter', () => this.upgrade());
  }

  private ensureStaticEl(): HTMLElement {
    if (!this.staticEl) { this.staticEl = document.createElement('span'); this.staticEl.className = 'lyx-math-static'; this.dom.replaceChildren(this.staticEl); }
    return this.staticEl;
  }
  private renderStaticOrDefer() {
    if (macrosReady(this.view) && canRenderNow()) this.renderStatic();
    else this.showPlaceholder();
  }
  private showPlaceholder() {
    const el = this.ensureStaticEl();
    el.classList.add('pending');
    el.textContent = this.lastLatex;
    this.pending = true;
    staticQueue.add(this);
    schedulePump();
  }
  renderPending() {
    if (!this.pending) return;
    this.renderStatic();
  }
  private renderStatic() {
    const el = this.ensureStaticEl();
    this.pending = false; staticQueue.delete(this); el.classList.remove('pending');
    const { key, table } = macroTableFor(this.view, this.getPos());
    el.innerHTML = renderStaticHtml('$' + this.lastLatex + '$', false, table);
    this.staticKey = key;
  }

  upgrade() {
    if (this.field) return;
    unwatchLazy(this);
    this.pending = false;
    const { key, table } = macroTableFor(this.view, this.getPos());
    const f = new LyxMathField({
      latex: '$' + this.lastLatex + '$', display: false, macros: table,
      onChange: latex => this.commit(latex),
      onMoveOut: (dir, o) => moveOut(this.view, this.getPos, dir, !!o.insertSpace, !!o.dissolve),
    });
    (f as any)._macroKey = key;
    (f as any)._toggleDisplay = () => { this.selectSelf(); toggleMathDisplay(this.view.state, this.view.dispatch); };
    this.field = f;
    this.dom.replaceChildren(f.dom);
    this.staticEl = null;
    wire(f, () => [
      { label: 'Inline formula', info: true },
      { label: 'Convert to display formula', action: () => { this.selectSelf(); toggleMathDisplay(this.view.state, this.view.dispatch); } },
      { label: 'Delete formula', action: () => deleteFormula(this.view, this.getPos) },
    ]);
    focusIfPending(f, this.getPos);
  }
  ensureField(): LyxMathField { this.upgrade(); return this.field!; }

  private commit(latex: string) {
    if (this.updating) return;
    const body = latex.replace(/^\$|\$$/g, '').replace(/^ $/, '');
    if (body === this.lastLatex) return;
    const pos = this.getPos();
    if (pos === undefined) return;
    const cur = this.view.state.doc.nodeAt(pos);
    if (!cur || cur.attrs.latex === body) return;
    this.lastLatex = body;
    this.dom.classList.toggle('empty', !body.trim());
    this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...cur.attrs, latex: body }).setMeta('addToHistory', true));
  }
  refreshMacros() {
    if (this.pending) { if (macrosReady(this.view)) schedulePump(); return; }
    const { key, table } = macroTableFor(this.view, this.getPos());
    if (this.field) this.field.setMacros(table, key);
    else if (this.staticKey !== key) this.renderStatic();
  }
  private selectSelf() { const pos = this.getPos(); if (pos !== undefined) this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, pos))); }
  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    const latex = String(node.attrs.latex);
    if (this.field) {
      this.refreshMacros();
      if (latex !== this.lastLatex && !this.field.hasFocus()) {
        this.updating = true;
        this.lastLatex = latex;
        this.field.setLatex('$' + latex + '$');
        this.dom.classList.toggle('empty', !latex.trim());
        this.updating = false;
      }
    } else if (latex !== this.lastLatex) {
      this.lastLatex = latex;
      this.dom.classList.toggle('empty', !latex.trim());
      if (this.pending) this.showPlaceholder(); else this.renderStatic();
    }
    return true;
  }
  selectNode() { this.dom.classList.add('ProseMirror-selectednode'); }
  deselectNode() { this.dom.classList.remove('ProseMirror-selectednode'); }
  stopEvent(ev: Event) { return !!this.field && this.field.dom.contains(ev.target as Node); }
  ignoreMutation() { return true; }
  focus(where: 'start' | 'end' = 'end') { this.ensureField().focus(where); }
  destroy() { mathViews.delete(this); unwatchLazy(this); this.field?.destroy(); }
}

/* ------------------------------------------------ display formulas */

const ENV_MENU: { env: HullType; label: string }[] = [
  { env: 'equation', label: 'equation' },
  { env: 'align', label: 'align' },
  { env: 'gather', label: 'gather' },
  { env: 'multline', label: 'multline' },
  { env: 'eqnarray', label: 'eqnarray' },
  { env: 'flalign', label: 'flalign' },
  { env: 'alignat', label: 'alignat' },
];

export class MathDisplayView implements NodeView {
  dom: HTMLElement;
  field: LyxMathField | null = null;
  private staticEl: HTMLElement | null = null;
  private staticKey = '';
  numberEl: HTMLElement;
  labelEl: HTMLElement;
  metaEl: HTMLElement;
  private updating = false;
  private lastLatex: string;
  private ro: ResizeObserver | null = null;
  private mo: MutationObserver | null = null;
  /** shows its source; rendered later (idle time / scrolled near / macros known) */
  pending = false;

  constructor(private node: PMNode, public view: EditorView, private getPos: () => number | undefined) {
    this.lastLatex = String(node.attrs.latex);
    this.dom = document.createElement('span');
    this.dom.className = 'lyx-math-display';
    const left = document.createElement('span');
    left.className = 'eq-left';
    left.contentEditable = 'false';
    this.metaEl = document.createElement('span');
    this.metaEl.className = 'eq-meta';
    this.metaEl.contentEditable = 'false';
    this.numberEl = document.createElement('span');
    this.numberEl.className = 'eq-number';
    this.labelEl = document.createElement('span');
    this.labelEl.className = 'eq-labels';
    this.metaEl.append(this.numberEl, this.labelEl);
    this.staticEl = document.createElement('span');
    this.staticEl.className = 'lyx-math-static display';
    this.dom.append(left, this.staticEl, this.metaEl);
    this.renderMeta();
    this.labelEl.addEventListener('mousedown', (ev) => { ev.preventDefault(); this.editLabel(); });
    // equation numbers come from the numbering plugin as a data-eqnum node decoration
    this.mo = new MutationObserver(() => this.syncNumber());
    this.mo.observe(this.dom, { attributes: true, attributeFilter: ['data-eqnum'] });
    this.syncNumber();
    // wide formulas: centre on the text column and let them overflow into the margins symmetrically
    this.ro = new ResizeObserver(() => this.scheduleRelayout());
    this.ro.observe(this.dom);
    mathViews.add(this);
    if (pendingFocus.pos !== null && pendingFocus.pos === getPos()) this.upgrade();
    else { this.renderStaticOrDefer(); watchLazy(this); }
    this.dom.addEventListener('pointerenter', () => this.upgrade());
  }

  private contentEl(): HTMLElement { return this.field?.dom ?? this.staticEl!; }

  private renderStaticOrDefer() {
    if (macrosReady(this.view) && canRenderNow()) this.renderStatic();
    else this.showPlaceholder();
  }
  private showPlaceholder() {
    if (!this.staticEl) return;
    this.staticEl.classList.add('pending');
    this.staticEl.textContent = this.lastLatex;
    this.pending = true;
    staticQueue.add(this);
    schedulePump();
  }
  renderPending() {
    if (!this.pending) return;
    this.renderStatic();
  }
  private renderStatic() {
    if (!this.staticEl) return;
    this.pending = false; staticQueue.delete(this); this.staticEl.classList.remove('pending');
    const { key, table } = macroTableFor(this.view, this.getPos());
    this.staticEl.innerHTML = renderStaticHtml(this.lastLatex, true, table);
    this.staticKey = key;
    this.scheduleRelayout();
  }

  upgrade() {
    if (this.field) return;
    unwatchLazy(this);
    this.pending = false;
    const { key, table } = macroTableFor(this.view, this.getPos());
    const f = new LyxMathField({
      latex: this.lastLatex, display: true, macros: table,
      onChange: latex => this.commit(latex),
      onMoveOut: (dir, o) => moveOut(this.view, this.getPos, dir, !!o.insertSpace, !!o.dissolve),
      onCommand: key => { if (key === 'n') this.toggleNumbering(); },
    });
    (f as any)._macroKey = key;
    (f as any)._toggleDisplay = () => { this.selectSelf(); toggleMathDisplay(this.view.state, this.view.dispatch); };
    this.field = f;
    if (this.staticEl) { this.staticEl.replaceWith(f.dom); this.staticEl = null; } else this.dom.insertBefore(f.dom, this.metaEl);
    this.ro?.observe(f.dom);
    wire(f, () => this.menu());
    focusIfPending(f, this.getPos);
  }
  ensureField(): LyxMathField { this.upgrade(); return this.field!; }

  refreshMacros() {
    if (this.pending) { if (macrosReady(this.view)) schedulePump(); return; }
    const { key, table } = macroTableFor(this.view, this.getPos());
    if (this.field) this.field.setMacros(table, key);
    else if (this.staticKey !== key) this.renderStatic();
  }

  private syncNumber() {
    const n = this.dom.getAttribute('data-eqnum') ?? '';
    if (this.numberEl.dataset.nums !== n) { this.numberEl.dataset.nums = n; this.numberEl.textContent = n; }
    this.numberEl.style.display = n ? '' : 'none';
    this.scheduleRelayout();
  }

  /** put each equation number at the vertical centre of its row (LyX draws them per row) */
  private layoutNumbers() {
    const nums = (this.numberEl.dataset.nums ?? '').split('\n').filter(Boolean);
    const h = this.hull();
    const numberedRowsIdx = h.type === 'multline' ? [h.rows.length - 1] : h.numberedRows.map((v, i) => (v === true ? i : -1)).filter(i => i >= 0);
    if (nums.length < 2 || numberedRowsIdx.length !== nums.length) { this.numberEl.classList.remove('per-row'); if (this.numberEl.textContent !== nums.join('\n')) this.numberEl.textContent = nums.join('\n'); return; }
    const container = this.field?.dom ?? this.staticEl;
    if (!container) return;
    const refs = this.field ? this.field.cellRefs() : renderHullSource(h, macroTableFor(this.view, this.getPos()).table).cells;
    const rects = rowRectsOf(h, refs, container);
    const base = this.dom.getBoundingClientRect();
    this.numberEl.classList.add('per-row');
    this.numberEl.replaceChildren(...nums.map((t, k) => {
      const r = rects[numberedRowsIdx[k]];
      const sp = document.createElement('span');
      sp.textContent = t;
      sp.style.top = `${(r.top + r.bottom) / 2 - base.top}px`;
      return sp;
    }));
  }

  private relayoutRaf = 0;
  private scheduleRelayout() { cancelAnimationFrame(this.relayoutRaf); this.relayoutRaf = requestAnimationFrame(() => this.relayout()); }

  /** Wide formulas: size the middle grid track to the content and centre the whole block on the text
   *  column, letting it overflow symmetrically into the margins (never past the page's left edge). */
  private relayout() {
    const dom = this.dom;
    const scroll = dom.closest('.editor-scroll') as HTMLElement | null;
    if (!scroll || !dom.isConnected) return;
    const content = this.contentEl();
    const contentW = Math.ceil(content.scrollWidth + 8);
    const shifted = dom.style.gridTemplateColumns !== '';
    const avail = shifted ? dom.parentElement!.clientWidth : dom.clientWidth;
    const metaW = this.metaEl.offsetWidth;
    const need = contentW + metaW + 10;
    this.layoutNumbers();
    if (need <= avail) {
      if (shifted) { dom.style.marginLeft = ''; dom.style.width = ''; dom.style.gridTemplateColumns = ''; }
      return;
    }
    const pageLeft = scroll.getBoundingClientRect().left + 6;
    const left = dom.getBoundingClientRect().left + scroll.scrollLeft - (parseFloat(dom.style.marginLeft) || 0);
    const leftRoom = Math.max(0, left - pageLeft);
    const shift = Math.round(Math.min(leftRoom, (need - avail) / 2));
    dom.style.gridTemplateColumns = `0 ${contentW}px auto`;
    dom.style.marginLeft = shift > 0 ? `-${shift}px` : '';
    dom.style.width = shift > 0 ? `calc(100% + ${shift}px)` : '';
  }

  private hull() { return this.field ? this.field.hull : parseFormula(this.lastLatex, macroTableFor(this.view, this.getPos()).table); }

  private menu(): MenuItem[] {
    const h = this.hull();
    const numbered = numberedType(h);
    const labels = h.labels.filter(Boolean) as string[];
    return [
      { label: 'Display formula', info: true },
      { label: 'Numbered', shortcut: 'Alt+M N', checked: numbered, action: () => this.toggleNumbering() },
      { label: 'Number this line', checked: h.rows.length > 1 && !!h.numberedRows[this.currentRow()], disabled: h.rows.length < 2, action: () => this.ensureField().execute('numberLineToggle') },
      { label: labels.length ? `Edit label (${labels.join(', ')})…` : 'Add label…', action: () => this.editLabel() },
      { label: 'Copy label name', disabled: !labels.length, action: () => { void navigator.clipboard?.writeText(labels[0] ?? ''); } },
      { label: 'Environment', sub: ENV_MENU.map(e => ({ label: e.label, checked: h.type === e.env, action: () => this.setEnv(e.env) })) },
      { label: 'New line (row)', shortcut: 'Enter', action: () => this.ensureField().execute('newline') },
      { label: 'Convert to inline formula', action: () => { this.selectSelf(); toggleMathDisplay(this.view.state, this.view.dispatch); } },
      { label: 'Delete formula', action: () => deleteFormula(this.view, this.getPos) },
    ];
  }
  private currentRow(): number { const f = this.field; if (!f) return 0; const s = f.cursor.slices[0]; return Math.floor(s.idx / Math.max(1, f.hull.ncols)); }
  private selectSelf() { const pos = this.getPos(); if (pos !== undefined) this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, pos))); }

  private editLabel() {
    const h = this.hull();
    const cur = (h.labels.find(Boolean) ?? '') as string;
    editorContext.openDialog?.('label', {
      equation: true,
      initial: cur || 'eq:',
      hasLabel: !!cur,
      refCount: countLabelRefs(this.view, cur),
      onApply: (name: string) => { this.setLabel(name); if (cur && cur !== name) renameLabelRefs(this.view, cur, name); },
      onRemove: () => this.setLabel(''),
    });
  }

  private commit(fieldLatex: string) {
    if (this.updating) return;
    // the LyX writer adds the newlines around a display formula itself (core/lyx/writer.ts)
    const latex = fieldLatex.replace(/^\n/, '').replace(/\n$/, '');
    const pos = this.getPos();
    if (pos === undefined) return;
    const cur = this.view.state.doc.nodeAt(pos);
    if (!cur || cur.attrs.latex === latex) return;
    this.lastLatex = latex;
    this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...cur.attrs, latex }));
    this.renderMeta();
  }

  private renderMeta() {
    const h = this.hull();
    const numbered = numberedType(h);
    this.dom.classList.toggle('numbered', numbered);
    this.dom.dataset.env = h.type;
    const labels = h.labels.filter(Boolean) as string[];
    this.labelEl.textContent = labels.length ? labels.join(', ') : (numbered ? '+label' : '');
    this.labelEl.title = labels.length ? 'Label: ' + labels.join(', ') + ' (click to edit)' : 'Click to add a label';
    this.labelEl.style.display = numbered || labels.length ? '' : 'none';
  }

  toggleNumbering() { this.ensureField().execute('numberToggle'); this.renderMeta(); }
  setEnv(env: HullType) { this.ensureField().execute('mutate', env); this.renderMeta(); }
  setLabel(label: string) { this.ensureField().execute('label', label); this.renderMeta(); }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    const latex = String(node.attrs.latex);
    if (this.field) this.refreshMacros();
    if (latex !== this.lastLatex) {
      this.lastLatex = latex;
      if (this.field) { if (!this.field.hasFocus()) { this.updating = true; this.field.setLatex(latex); this.updating = false; } }
      else if (this.pending) this.showPlaceholder();
      else this.renderStatic();
      this.renderMeta();
    }
    return true;
  }
  selectNode() { this.dom.classList.add('ProseMirror-selectednode'); }
  deselectNode() { this.dom.classList.remove('ProseMirror-selectednode'); }
  stopEvent(ev: Event) { return (!!this.field && this.field.dom.contains(ev.target as Node)) || this.metaEl.contains(ev.target as Node); }
  ignoreMutation() { return true; }
  focus(where: 'start' | 'end' = 'end') { this.ensureField().focus(where); }
  destroy() { mathViews.delete(this); unwatchLazy(this); cancelAnimationFrame(this.relayoutRaf); this.ro?.disconnect(); this.mo?.disconnect(); this.field?.destroy(); }
}

/* ------------------------------------------------ macro definitions */

/** FormulaMacro inset: shows "\name := definition" with an editable definition. */
export class MacroView implements NodeView {
  dom: HTMLElement;
  field: LyxMathField;
  nameEl: HTMLElement;
  private updating = false;
  private lastDef: string;

  constructor(private node: PMNode, private view: EditorView, private getPos: () => number | undefined) {
    this.dom = document.createElement('span');
    this.dom.className = 'lyx-macro';
    this.nameEl = document.createElement('span');
    this.nameEl.className = 'macro-name';
    this.nameEl.contentEditable = 'false';
    const def = this.parse();
    this.nameEl.textContent = '\\' + (def?.name ?? '?') + (def && def.args ? `[${def.args}]` : '') + ' ≔ ';
    this.lastDef = def?.def ?? '';
    const { key, table } = macroTableFor(view, getPos());
    this.field = new LyxMathField({
      latex: '$' + this.lastDef + '$', display: false, macros: table,
      onChange: latex => this.commit(latex.replace(/^\$|\$$/g, '')),
      onMoveOut: (dir, o) => moveOut(this.view, this.getPos, dir, !!o.insertSpace),
    });
    (this.field as any)._macroKey = key;
    this.dom.append(this.nameEl, this.field.dom);
    mathViews.add(this);
    if (def?.display) { const d = document.createElement('span'); d.className = 'macro-display'; d.textContent = ' (shown as: ' + def.display + ')'; d.contentEditable = 'false'; this.dom.append(d); }
    wire(this.field, () => [{ label: 'Math macro definition', info: true }, { label: 'Delete macro definition', action: () => deleteFormula(this.view, this.getPos) }]);
    this.nameEl.addEventListener('mousedown', (ev) => { ev.preventDefault(); const pos = this.getPos(); if (pos !== undefined) { this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, pos))); this.view.focus(); } });
  }
  private parse() { try { return macroFromLyxLines(JSON.parse(this.node.attrs.lines)); } catch { return null; } }
  private commit(latex: string) {
    if (this.updating || latex === this.lastDef) return;
    const pos = this.getPos();
    if (pos === undefined) return;
    const cur = this.view.state.doc.nodeAt(pos);
    if (!cur) return;
    const lines: string[] = JSON.parse(cur.attrs.lines);
    const d = macroFromLyxLines(lines);
    if (!d) return;
    const cmd = /^\\renewcommand/.test(lines[0]) ? '\\renewcommand' : '\\newcommand';
    lines[0] = `${cmd}{\\${d.name}}${d.args ? `[${d.args}]` : ''}{${latex}}`;
    this.lastDef = latex;
    this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...cur.attrs, lines: JSON.stringify(lines) }));
  }
  refreshMacros() { const { key, table } = macroTableFor(this.view, undefined); this.field.setMacros(table, key); }
  ensureField(): LyxMathField { return this.field; }
  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    const def = this.parse();
    if (def && def.def !== this.lastDef && !this.field.hasFocus()) { this.updating = true; this.lastDef = def.def; this.field.setLatex('$' + def.def + '$'); this.updating = false; }
    return true;
  }
  selectNode() { this.dom.classList.add('ProseMirror-selectednode'); }
  deselectNode() { this.dom.classList.remove('ProseMirror-selectednode'); }
  stopEvent(ev: Event) { return this.field.dom.contains(ev.target as Node); }
  ignoreMutation() { return true; }
  focus(where: 'start' | 'end' = 'end') { this.field.focus(where); }
  destroy() { mathViews.delete(this); this.field.destroy(); }
}

export { activeMathField };
