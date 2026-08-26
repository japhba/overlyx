/**
 * Node views for math: inline formulas, display formulas and macro definitions,
 * edited in place with MathLive (WYSIWYG while typing, no compile step).
 */
import type { Node as PMNode } from 'prosemirror-model';
import { NodeSelection, TextSelection } from 'prosemirror-state';
import type { EditorView, NodeView } from 'prosemirror-view';
import type { MathfieldElement } from 'mathlive';
import { createMathfield, parseDisplayMath, serializeDisplayMath, MATH_ALT_M, type DisplayMath, type HullType, isNumberedEnv, applyMacros, macroVersion, setFieldLatex, getFieldLatex, renderStaticMath, macroDictFor, mathViews } from '../math';
import { macroFromLyxLines } from '@overlyx/core';
import { showContextMenu, type MenuItem } from '../contextmenu';
import { toggleMathDisplay } from '../commands';

function isMac() { return /Mac/.test(navigator.platform); }

/** Position of a formula that was just inserted by the user and should grab the keyboard once mounted. */
export const pendingFocus: { pos: number | null; keys: string[] } = { pos: null, keys: [] };

function focusWhenMounted(mf: MathfieldElement, getPos: () => number | undefined) {
  const pos = getPos();
  if (pos === undefined || pendingFocus.pos !== pos) return;
  pendingFocus.pos = null;
  const doFocus = () => {
    mf.focus();
    mf.executeCommand('moveToMathfieldEnd');
    // replay characters typed before the field was ready
    const keys = pendingFocus.keys.splice(0);
    for (const k of keys) mf.executeCommand(['insert', k]);
  };
  if ((mf as any).isConnected && (mf as any).shadowRoot?.querySelector('.ML__content')) doFocus();
  else mf.addEventListener('mount', doFocus, { once: true });
}

/* ------------------------------------------------ lazy upgrade of static formulas */

interface Upgradable { dom: HTMLElement; upgrade(): void }
const lazyQueue: Upgradable[] = [];
let pumping = false;
const io = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const v = (e.target as any).__lyxMathView as Upgradable | undefined;
    if (v && !lazyQueue.includes(v)) lazyQueue.push(v);
  }
  pump();
}, { rootMargin: '900px 0px' }) : null;

/** Upgrade a few formulas per frame so that scrolling stays smooth. */
function pump() {
  if (pumping) return;
  pumping = true;
  const step = () => {
    const batch = lazyQueue.splice(0, 6);
    for (const v of batch) v.upgrade();
    if (lazyQueue.length) requestAnimationFrame(step); else pumping = false;
  };
  requestAnimationFrame(step);
}
function watchLazy(v: Upgradable) { (v.dom as any).__lyxMathView = v; io?.observe(v.dom); }
function unwatchLazy(v: Upgradable) { io?.unobserve(v.dom); const i = lazyQueue.indexOf(v); if (i >= 0) lazyQueue.splice(i, 1); }

/** Menu entries shared by all formula kinds. */
function commonMathMenu(mf: MathfieldElement): MenuItem[] {
  const ins = (latex: string) => () => { mf.focus(); mf.executeCommand(['insert', latex]); };
  return [
    { label: 'Insert', sub: [
      { label: 'Fraction', shortcut: 'Alt+M F', action: ins('\\frac{#0}{#?}') },
      { label: 'Square root', shortcut: 'Alt+M S', action: ins('\\sqrt{#0}') },
      { label: 'Parentheses \\left( \\right)', shortcut: 'Alt+M (', action: ins('\\left(#0\\right)') },
      { label: 'Brackets \\left[ \\right]', shortcut: 'Alt+M [', action: ins('\\left[#0\\right]') },
      { label: 'Braces \\left\\{ \\right\\}', shortcut: 'Alt+M {', action: ins('\\left\\{#0\\right\\}') },
      { label: 'Norm \\left| \\right|', shortcut: 'Alt+M |', action: ins('\\left|#0\\right|') },
      { label: 'Text \\text{}', shortcut: 'Ctrl+M', action: ins('\\text{#0}') },
      { label: 'Sum', shortcut: 'Alt+M U', action: ins('\\sum_{#?}^{#?}') },
      { label: 'Integral', shortcut: 'Alt+M I', action: ins('\\int_{#?}^{#?}') },
      { label: 'Matrix (2×2)', action: ins('\\begin{pmatrix}#0 & #? \\\\ #? & #?\\end{pmatrix}') },
      { label: 'Cases', action: ins('\\begin{cases}#0 & #? \\\\ #? & #?\\end{cases}') },
    ] },
    { label: 'Copy LaTeX', action: () => { void navigator.clipboard?.writeText(getFieldLatex(mf)); } },
    { label: 'Copy MathML', action: () => { try { void navigator.clipboard?.writeText(mf.getValue('math-ml')); } catch { /* ignore */ } } },
  ];
}

/** Shared wiring: focus in/out, move-out events, keyboard bridge, context menu. */
function wire(mf: MathfieldElement, view: EditorView, getPos: () => number | undefined, opts: { onChange: (latex: string) => void; onCommit?: () => void; menu?: () => MenuItem[] }) {
  let altM = false;
  mf.addEventListener('input', () => { opts.onChange(getFieldLatex(mf)); });
  mf.addEventListener('change', () => { opts.onCommit?.(); });
  mf.addEventListener('move-out', (ev: Event) => {
    const dir = (ev as CustomEvent).detail?.direction as string;
    const pos = getPos();
    if (pos === undefined) return;
    const node = view.state.doc.nodeAt(pos);
    const size = node ? node.nodeSize : 1;
    const target = dir === 'backward' || dir === 'upward' ? pos : pos + size;
    let tr = view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(target), dir === 'backward' || dir === 'upward' ? -1 : 1));
    if ((ev as CustomEvent).detail?.insertSpace) tr = tr.insertText(' ');   // LyX: Space at the end of a formula leaves it and becomes a text space
    view.dispatch(tr);
    view.focus();
  });
  mf.addEventListener('focusin', () => { mf.classList.add('focused'); });
  mf.addEventListener('focusout', () => { mf.classList.remove('focused'); altM = false; });
  // capture phase: MathLive's own contextmenu handler (inside the shadow root) stops propagation
  mf.addEventListener('contextmenu', (ev: MouseEvent) => {
    ev.preventDefault(); ev.stopPropagation();
    const items = [...(opts.menu?.() ?? []), { sep: true }, ...commonMathMenu(mf)];
    showContextMenu(ev.clientX, ev.clientY, items);
  }, { capture: true });
  mf.addEventListener('keydown', (ev: KeyboardEvent) => {
    const mod = isMac() ? ev.metaKey : ev.ctrlKey;
    // Alt+M prefix (LyX math bindings)
    if (ev.altKey && ev.key.toLowerCase() === 'm' && !mod) { altM = true; ev.preventDefault(); ev.stopPropagation(); return; }
    if (altM) {
      altM = false;
      const ins = MATH_ALT_M[ev.key];
      if (ins) { mf.executeCommand(['insert', ins]); ev.preventDefault(); ev.stopPropagation(); return; }
      if (ev.key === 'x') { mf.executeCommand('moveToSubscript'); ev.preventDefault(); ev.stopPropagation(); return; }
      if (ev.key === 'e') { mf.executeCommand('moveToSuperscript'); ev.preventDefault(); ev.stopPropagation(); return; }
      if (ev.key === 'm') { mf.executeCommand(['insert', '\\text{#0}']); ev.preventDefault(); ev.stopPropagation(); return; }
      if (ev.key === 'n' || ev.key === 'd' || ev.key === 't') {
        // handled by the display math view (numbering / type); bubble as custom event
        mf.dispatchEvent(new CustomEvent('lyx-math-command', { detail: { key: ev.key }, bubbles: true }));
        ev.preventDefault(); ev.stopPropagation(); return;
      }
    }
    if (mod && ev.key.toLowerCase() === 'm' && !ev.shiftKey) {
      // Ctrl+M inside math: LyX inserts a text box
      mf.executeCommand(['insert', '\\text{#0}']);
      ev.preventDefault(); ev.stopPropagation(); return;
    }
    if (ev.key === 'Escape') {
      const pos = getPos();
      if (pos !== undefined) {
        const node = view.state.doc.nodeAt(pos);
        view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos + (node?.nodeSize ?? 1)))));
        view.focus();
      }
      ev.preventDefault(); ev.stopPropagation(); return;
    }
    // Ctrl+Space: protected space in text; in math LyX inserts a thin space
    if (mod && ev.key === ' ') { mf.executeCommand(['insert', '\\,']); ev.preventDefault(); ev.stopPropagation(); return; }
    // Do not let ProseMirror see keystrokes meant for the field, except global shortcuts
    const passthrough = mod && ['s', 'r', 'z', 'y', 'f', 'o', 'p', 'w'].includes(ev.key.toLowerCase()) && !ev.altKey;
    if (!passthrough) ev.stopPropagation();
  });
  // prevent ProseMirror from handling mouse selection inside the field
  mf.addEventListener('mousedown', (ev) => { ev.stopPropagation(); });
}

function deleteFormula(view: EditorView, getPos: () => number | undefined) {
  const pos = getPos();
  if (pos === undefined) return;
  const node = view.state.doc.nodeAt(pos);
  if (!node) return;
  view.dispatch(view.state.tr.delete(pos, pos + node.nodeSize));
  view.focus();
}

export class MathInlineView implements NodeView {
  dom: HTMLElement;
  mf: MathfieldElement | null = null;
  private staticEl: HTMLElement | null = null;
  private staticKey = '';
  private updating = false;
  private lastLatex: string;

  constructor(private node: PMNode, private view: EditorView, private getPos: () => number | undefined) {
    this.dom = document.createElement('span');
    this.dom.className = 'lyx-math-inline';
    this.lastLatex = String(node.attrs.latex);
    this.dom.classList.toggle('empty', !this.lastLatex.trim());
    mathViews.add(this);
    if (pendingFocus.pos !== null && pendingFocus.pos === getPos()) this.upgrade();
    else { this.renderStatic(); watchLazy(this); }
    this.dom.addEventListener('pointerenter', () => this.upgrade());
  }

  private renderStatic() {
    if (!this.staticEl) { this.staticEl = document.createElement('span'); this.staticEl.className = 'lyx-math-static'; this.dom.replaceChildren(this.staticEl); }
    const el = this.staticEl, latex = this.lastLatex;
    renderStaticMath({ latex, display: false, view: this.view, pos: this.getPos(), apply: (html, key) => { if (this.staticEl === el && this.lastLatex === latex) { el.innerHTML = html; this.staticKey = key; } } });
  }

  /** Replace the static rendering by an editable MathLive field. */
  upgrade() {
    if (this.mf) return;
    unwatchLazy(this);
    const mf = createMathfield({ latex: this.lastLatex, display: false, view: this.view, pos: this.getPos() });
    (mf as any).__lyxPos = this.getPos;
    this.mf = mf;
    this.dom.replaceChildren(mf);
    this.staticEl = null;
    focusWhenMounted(mf, this.getPos);
    wire(mf, this.view, this.getPos, {
      onChange: (latex) => {
        if (this.updating || latex === this.lastLatex) return;
        const pos = this.getPos();
        if (pos === undefined) return;
        const cur = this.view.state.doc.nodeAt(pos);
        if (!cur || cur.attrs.latex === latex) return;
        this.lastLatex = latex;
        this.dom.classList.toggle('empty', !latex.trim());
        this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...cur.attrs, latex }).setMeta('addToHistory', true));
      },
      menu: () => [
        { label: 'Inline formula', info: true },
        { label: 'Convert to display formula', action: () => { this.selectSelf(); toggleMathDisplay(this.view.state, this.view.dispatch); } },
        { label: 'Delete formula', action: () => deleteFormula(this.view, this.getPos) },
      ],
    });
  }
  ensureField(): MathfieldElement { this.upgrade(); return this.mf!; }
  refreshMacros() {
    if (this.mf) applyMacros(this.mf, true, this.getPos(), this.view);
    else if (this.staticKey !== macroDictFor(this.view, this.getPos()).key) this.renderStatic();
  }
  private selectSelf() { const pos = this.getPos(); if (pos !== undefined) this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, pos))); }
  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    const latex = String(node.attrs.latex);
    if (this.mf) {
      if ((this.mf as any).__lyxMacroVersion !== macroVersion) applyMacros(this.mf, true, this.getPos(), this.view);
      if (latex !== this.lastLatex && document.activeElement !== this.mf) {
        this.updating = true;
        this.lastLatex = latex;
        setFieldLatex(this.mf, latex);
        this.dom.classList.toggle('empty', !latex.trim());
        this.updating = false;
      }
    } else if (latex !== this.lastLatex) {
      this.lastLatex = latex;
      this.dom.classList.toggle('empty', !latex.trim());
      this.renderStatic();
    }
    return true;
  }
  selectNode() { this.dom.classList.add('ProseMirror-selectednode'); }
  deselectNode() { this.dom.classList.remove('ProseMirror-selectednode'); }
  stopEvent(ev: Event) { return !!this.mf && (ev.target === this.mf || this.mf.contains(ev.target as Node)); }
  ignoreMutation() { return true; }
  focus(atEnd = false) {
    const mf = this.ensureField();
    mf.focus();
    mf.executeCommand(atEnd ? 'moveToMathfieldEnd' : 'moveToMathfieldStart');
  }
  destroy() { mathViews.delete(this); unwatchLazy(this); this.mf?.remove(); }
}

const ENV_MENU: { env: HullType; label: string }[] = [
  { env: 'simple', label: 'Plain display  \\[ … \\]' },
  { env: 'equation', label: 'equation (numbered)' },
  { env: 'equation*', label: 'equation*' },
  { env: 'align', label: 'align' },
  { env: 'align*', label: 'align*' },
  { env: 'gather', label: 'gather' },
  { env: 'gather*', label: 'gather*' },
  { env: 'multline', label: 'multline' },
  { env: 'multline*', label: 'multline*' },
  { env: 'eqnarray', label: 'eqnarray' },
  { env: 'flalign', label: 'flalign' },
  { env: 'alignat', label: 'alignat' },
];

export class MathDisplayView implements NodeView {
  dom: HTMLElement;
  mf: MathfieldElement | null = null;
  private staticEl: HTMLElement | null = null;
  private staticKey = '';
  numberEl: HTMLElement;
  labelEl: HTMLElement;
  metaEl: HTMLElement;
  dm: DisplayMath;
  private updating = false;
  private lastLatex: string;
  private ro: ResizeObserver | null = null;
  private mo: MutationObserver | null = null;

  constructor(private node: PMNode, private view: EditorView, private getPos: () => number | undefined) {
    this.lastLatex = String(node.attrs.latex);
    this.dm = parseDisplayMath(this.lastLatex);
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
    else { this.renderStatic(); watchLazy(this); }
    this.dom.addEventListener('pointerenter', () => this.upgrade());
  }

  private contentEl(): HTMLElement { return this.mf ?? this.staticEl!; }

  private renderStatic() {
    if (!this.staticEl) return;
    const el = this.staticEl, latex = this.bodyForMathlive();
    renderStaticMath({ latex, display: true, view: this.view, pos: this.getPos(), apply: (html, key) => { if (this.staticEl === el) { el.innerHTML = html; this.staticKey = key; this.scheduleRelayout(); } } });
  }

  upgrade() {
    if (this.mf) return;
    unwatchLazy(this);
    const mf = createMathfield({ latex: this.bodyForMathlive(), display: true, view: this.view, pos: this.getPos() });
    (mf as any).__lyxPos = this.getPos;
    this.mf = mf;
    if (this.staticEl) { this.staticEl.replaceWith(mf); this.staticEl = null; } else this.dom.insertBefore(mf, this.metaEl);
    this.ro?.observe(mf);
    focusWhenMounted(mf, this.getPos);
    wire(mf, this.view, this.getPos, {
      onChange: (latex) => { if (!this.updating) this.commit(latex); },
      menu: () => this.menu(),
    });
    mf.addEventListener('lyx-math-command', (ev: Event) => {
      const key = (ev as CustomEvent).detail.key as string;
      if (key === 'n') this.toggleNumbering();
    });
  }
  ensureField(): MathfieldElement { this.upgrade(); return this.mf!; }
  refreshMacros() {
    if (this.mf) applyMacros(this.mf, true, this.getPos(), this.view);
    else if (this.staticKey !== macroDictFor(this.view, this.getPos()).key) this.renderStatic();
  }

  private syncNumber() {
    const n = this.dom.getAttribute('data-eqnum') ?? '';
    if (this.numberEl.textContent !== n) this.numberEl.textContent = n;
    this.numberEl.style.display = n ? '' : 'none';
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
    const latexEl = (this.mf ? this.mf.shadowRoot?.querySelector('.ML__latex') : content.querySelector('.ML__latex')) as HTMLElement | null;
    const contentW = Math.ceil(Math.max(content.scrollWidth, latexEl?.scrollWidth ?? 0) + 8);
    const shifted = dom.style.gridTemplateColumns !== '';
    // reads first; the container width is the text column width unless we already stretched it
    const avail = shifted ? dom.parentElement!.clientWidth : dom.clientWidth;
    const metaW = this.metaEl.offsetWidth;
    const need = contentW + metaW + 10;
    if (need <= avail) {
      if (shifted) { dom.style.marginLeft = ''; dom.style.width = ''; dom.style.gridTemplateColumns = ''; }
      return;
    }
    // room between the column and the page's left edge, independent of horizontal scrolling and of a previous shift
    const pageLeft = scroll.getBoundingClientRect().left + 6;
    const left = dom.getBoundingClientRect().left + scroll.scrollLeft - (parseFloat(dom.style.marginLeft) || 0);
    const leftRoom = Math.max(0, left - pageLeft);
    const shift = Math.round(Math.min(leftRoom, (need - avail) / 2));
    dom.style.gridTemplateColumns = `0 ${contentW}px auto`;
    dom.style.marginLeft = shift > 0 ? `-${shift}px` : '';
    dom.style.width = shift > 0 ? `calc(100% + ${shift}px)` : '';
  }

  private menu(): MenuItem[] {
    const numbered = isNumberedEnv(this.dm.env);
    const labels = this.dm.labels.filter(Boolean) as string[];
    return [
      { label: 'Display formula', info: true },
      { label: 'Numbered equation', shortcut: 'Alt+M N', checked: numbered, action: () => this.toggleNumbering() },
      { label: labels.length ? `Edit label (${labels.join(', ')})…` : 'Add label…', action: () => this.editLabel() },
      { label: 'Copy label name', disabled: !labels.length, action: () => { void navigator.clipboard?.writeText(labels[0] ?? ''); } },
      { label: 'Environment', sub: ENV_MENU.map(e => ({ label: e.label, checked: this.dm.env === e.env || (this.dm.env === 'unknown' && e.env === 'equation'), action: () => this.setEnv(e.env) })) },
      { label: 'Convert to inline formula', action: () => { this.selectSelf(); toggleMathDisplay(this.view.state, this.view.dispatch); } },
      { label: 'Delete formula', action: () => deleteFormula(this.view, this.getPos) },
    ];
  }
  private selectSelf() { const pos = this.getPos(); if (pos !== undefined) this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, pos))); }

  private editLabel() {
    const cur = prompt('Equation label (empty to remove):', this.dm.labels.find(Boolean) ?? 'eq:');
    if (cur === null) return;
    this.setLabel(cur.trim() || null);
  }

  private bodyForMathlive(): string {
    const env = this.dm.env;
    if (env === 'simple' || env === 'equation' || env === 'equation*' || env === 'unknown') return this.dm.body.trim();
    // multi-line environments: hand MathLive the equivalent environment (aligned/gathered/multline)
    const inner = env.startsWith('align') || env.startsWith('flalign') || env.startsWith('eqnarray') || env.startsWith('xalignat') ? 'aligned' :
      env.startsWith('alignat') ? 'alignedat' : 'gathered';
    const arg = inner === 'alignedat' ? (this.dm.envArg || '{2}') : '';
    return `\\begin{${inner}}${arg}${this.dm.body.trim()}\\end{${inner}}`;
  }

  private bodyFromMathlive(latex: string): string {
    const env = this.dm.env;
    if (env === 'simple' || env === 'equation' || env === 'equation*' || env === 'unknown') return latex;
    const m = /^\s*\\begin\{(aligned|alignedat|gathered)\}(\{[^}]*\})?([\s\S]*)\\end\{\1\}\s*$/.exec(latex);
    return m ? m[3] : latex;
  }

  /** Current body text (from the field if it exists, else the parsed one). */
  private currentBody(): string { return this.mf ? this.bodyFromMathlive(getFieldLatex(this.mf)) : this.dm.body; }

  private commit(latex: string) { this.commitBody(this.bodyFromMathlive(latex)); }

  private commitBody(body: string) {
    const pos = this.getPos();
    if (pos === undefined) return;
    const cur = this.view.state.doc.nodeAt(pos);
    if (!cur) return;
    const text = serializeDisplayMath(this.dm, body);
    if (cur.attrs.latex === text) return;
    this.lastLatex = text;
    this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...cur.attrs, latex: text }));
  }

  private renderMeta() {
    const numbered = isNumberedEnv(this.dm.env);
    this.dom.classList.toggle('numbered', numbered);
    this.dom.dataset.env = this.dm.env;
    const labels = this.dm.labels.filter(Boolean) as string[];
    this.labelEl.textContent = labels.length ? labels.join(', ') : (numbered ? '+label' : '');
    this.labelEl.title = labels.length ? 'Label: ' + labels.join(', ') + ' (click to edit)' : 'Click to add a label';
    this.labelEl.style.display = numbered || labels.length ? '' : 'none';
  }

  toggleNumbering() {
    const env = this.dm.env;
    let next: typeof env;
    if (env === 'simple') next = 'equation';
    else if (env === 'equation') next = 'simple';
    else if (env === 'unknown') next = 'equation';
    else next = (env.endsWith('*') ? env.slice(0, -1) : env + '*') as typeof env;
    const body = this.currentBody();
    this.dm = { ...this.dm, env: next };
    this.commitBody(body);
    this.renderMeta();
  }

  setEnv(env: DisplayMath['env']) {
    const wasMulti = !['simple', 'equation', 'equation*', 'unknown'].includes(this.dm.env);
    const body = this.currentBody();
    this.dm = { ...this.dm, env, body, envArg: env.startsWith('alignat') ? (this.dm.envArg || '{2}') : '' };
    const isMulti = !['simple', 'equation', 'equation*', 'unknown'].includes(env);
    if (wasMulti !== isMulti) {
      this.updating = true;
      if (this.mf) setFieldLatex(this.mf, this.bodyForMathlive()); else this.renderStatic();
      this.updating = false;
    }
    this.commitBody(body);
    this.renderMeta();
  }

  setLabel(label: string | null) {
    const idx = Math.max(0, this.dm.labels.findIndex(Boolean));
    const labels = [...this.dm.labels];
    while (labels.length <= idx) labels.push(null);
    labels[idx] = label;
    const body = this.currentBody();
    this.dm = { ...this.dm, labels };
    this.commitBody(body);
    this.renderMeta();
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    if (this.mf && (this.mf as any).__lyxMacroVersion !== macroVersion) applyMacros(this.mf, true, this.getPos(), this.view);
    const latex = String(node.attrs.latex);
    if (latex !== this.lastLatex) {
      this.lastLatex = latex;
      this.dm = parseDisplayMath(latex);
      if (this.mf) {
        if (document.activeElement !== this.mf) {
          this.updating = true;
          setFieldLatex(this.mf, this.bodyForMathlive());
          this.updating = false;
        }
      } else this.renderStatic();
      this.renderMeta();
    }
    return true;
  }
  selectNode() { this.dom.classList.add('ProseMirror-selectednode'); }
  deselectNode() { this.dom.classList.remove('ProseMirror-selectednode'); }
  stopEvent(ev: Event) { return (!!this.mf && this.mf.contains(ev.target as Node)) || this.metaEl.contains(ev.target as Node); }
  ignoreMutation() { return true; }
  focus(atEnd = false) {
    const mf = this.ensureField();
    mf.focus();
    mf.executeCommand(atEnd ? 'moveToMathfieldEnd' : 'moveToMathfieldStart');
  }
  destroy() { mathViews.delete(this); unwatchLazy(this); cancelAnimationFrame(this.relayoutRaf); this.ro?.disconnect(); this.mo?.disconnect(); this.mf?.remove(); }
}

/** FormulaMacro inset: shows "\name := definition" with an editable definition. */
export class MacroView implements NodeView {
  dom: HTMLElement;
  mf: MathfieldElement;
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
    this.mf = createMathfield({ latex: this.lastDef, display: false, view });
    this.dom.append(this.nameEl, this.mf);
    mathViews.add(this);
    if (def?.display) { const d = document.createElement('span'); d.className = 'macro-display'; d.textContent = ' (shown as: ' + def.display + ')'; d.contentEditable = 'false'; this.dom.append(d); }
    wire(this.mf, view, getPos, {
      onChange: (latex) => {
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
      },
      menu: () => [{ label: 'Math macro definition', info: true }, { label: 'Delete macro definition', action: () => deleteFormula(this.view, this.getPos) }],
    });
    this.nameEl.addEventListener('mousedown', (ev) => { ev.preventDefault(); const pos = this.getPos(); if (pos !== undefined) { this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, pos))); this.view.focus(); } });
  }
  private parse() { try { return macroFromLyxLines(JSON.parse(this.node.attrs.lines)); } catch { return null; } }
  refreshMacros() { applyMacros(this.mf, true, undefined, this.view); }
  ensureField(): MathfieldElement { return this.mf; }
  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    const def = this.parse();
    if (def && def.def !== this.lastDef && document.activeElement !== this.mf) { this.updating = true; this.lastDef = def.def; setFieldLatex(this.mf, def.def); this.updating = false; }
    return true;
  }
  selectNode() { this.dom.classList.add('ProseMirror-selectednode'); }
  deselectNode() { this.dom.classList.remove('ProseMirror-selectednode'); }
  stopEvent(ev: Event) { return this.mf.contains(ev.target as Node); }
  ignoreMutation() { return true; }
  focus() { this.mf.focus(); }
  destroy() { mathViews.delete(this); this.mf.remove(); }
}
