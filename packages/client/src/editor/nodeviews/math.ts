/**
 * Node views for math: inline formulas, display formulas and macro definitions,
 * edited in place with MathLive (WYSIWYG while typing, no compile step).
 */
import type { Node as PMNode } from 'prosemirror-model';
import { NodeSelection, TextSelection } from 'prosemirror-state';
import type { EditorView, NodeView } from 'prosemirror-view';
import type { MathfieldElement } from 'mathlive';
import { createMathfield, parseDisplayMath, serializeDisplayMath, MATH_ALT_M, type DisplayMath, isNumberedEnv } from '../math';
import { macroFromLyxLines } from '@overlyx/core';

function isMac() { return /Mac/.test(navigator.platform); }

/** Shared wiring: focus in/out, move-out events, keyboard bridge. */
function wire(mf: MathfieldElement, view: EditorView, getPos: () => number | undefined, opts: { onChange: (latex: string) => void; onCommit?: () => void }) {
  let altM = false;
  mf.addEventListener('input', () => { opts.onChange(mf.value); });
  mf.addEventListener('change', () => { opts.onCommit?.(); });
  mf.addEventListener('move-out', (ev: Event) => {
    const dir = (ev as CustomEvent).detail?.direction as string;
    const pos = getPos();
    if (pos === undefined) return;
    const node = view.state.doc.nodeAt(pos);
    const size = node ? node.nodeSize : 1;
    let target = dir === 'backward' || dir === 'upward' ? pos : pos + size;
    if (dir === 'upward' || dir === 'downward') {
      target = dir === 'upward' ? pos : pos + size;
    }
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(target), dir === 'backward' || dir === 'upward' ? -1 : 1)));
    view.focus();
  });
  mf.addEventListener('focusin', () => { mf.classList.add('focused'); });
  mf.addEventListener('focusout', () => { mf.classList.remove('focused'); altM = false; });
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
    const passthrough = mod && ['s', 'r', 'z', 'y', 'f', 'o', 'p'].includes(ev.key.toLowerCase()) && !ev.altKey;
    if (!passthrough) ev.stopPropagation();
  });
  // prevent ProseMirror from handling mouse selection inside the field
  mf.addEventListener('mousedown', (ev) => { ev.stopPropagation(); });
}

export class MathInlineView implements NodeView {
  dom: HTMLElement;
  mf: MathfieldElement;
  private updating = false;

  constructor(private node: PMNode, private view: EditorView, private getPos: () => number | undefined) {
    this.dom = document.createElement('span');
    this.dom.className = 'lyx-math-inline';
    this.mf = createMathfield({ latex: node.attrs.latex, display: false });
    this.dom.appendChild(this.mf);
    wire(this.mf, view, getPos, {
      onChange: (latex) => {
        if (this.updating) return;
        const pos = this.getPos();
        if (pos === undefined) return;
        const cur = this.view.state.doc.nodeAt(pos);
        if (!cur || cur.attrs.latex === latex) return;
        this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...cur.attrs, latex }).setMeta('addToHistory', true));
      },
    });
  }
  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    if (this.mf.value !== node.attrs.latex && document.activeElement !== this.mf) {
      this.updating = true;
      this.mf.value = node.attrs.latex;
      this.updating = false;
    }
    return true;
  }
  selectNode() { this.dom.classList.add('ProseMirror-selectednode'); }
  deselectNode() { this.dom.classList.remove('ProseMirror-selectednode'); }
  stopEvent(ev: Event) { return ev.target === this.mf || this.mf.contains(ev.target as Node); }
  ignoreMutation() { return true; }
  focus(atEnd = false) {
    this.mf.focus();
    this.mf.executeCommand(atEnd ? 'moveToMathfieldEnd' : 'moveToMathfieldStart');
  }
  destroy() { this.mf.remove(); }
}

export class MathDisplayView implements NodeView {
  dom: HTMLElement;
  mf: MathfieldElement;
  numberEl: HTMLElement;
  labelEl: HTMLElement;
  dm: DisplayMath;
  private updating = false;

  constructor(private node: PMNode, private view: EditorView, private getPos: () => number | undefined) {
    this.dm = parseDisplayMath(node.attrs.latex);
    this.dom = document.createElement('span');
    this.dom.className = 'lyx-math-display';
    this.mf = createMathfield({ latex: this.bodyForMathlive(), display: true });
    this.numberEl = document.createElement('span');
    this.numberEl.className = 'eq-number';
    this.numberEl.contentEditable = 'false';
    this.labelEl = document.createElement('span');
    this.labelEl.className = 'eq-labels';
    this.labelEl.contentEditable = 'false';
    this.dom.append(this.mf, this.numberEl, this.labelEl);
    this.renderMeta();
    wire(this.mf, view, getPos, {
      onChange: (latex) => {
        if (this.updating) return;
        this.commit(latex);
      },
    });
    this.mf.addEventListener('lyx-math-command', (ev: Event) => {
      const key = (ev as CustomEvent).detail.key as string;
      if (key === 'n') this.toggleNumbering();
      if (key === 'd') { /* already display */ }
    });
    this.labelEl.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      const cur = prompt('Equation label (empty to remove):', this.dm.labels.find(Boolean) ?? 'eq:');
      if (cur === null) return;
      this.setLabel(cur.trim() || null);
    });
  }

  private bodyForMathlive(): string {
    const env = this.dm.env;
    if (env === 'simple' || env === 'equation' || env === 'equation*' || env === 'unknown') return this.dm.body.trim();
    // multi-line environments: hand MathLive the equivalent environment (aligned/gathered/multline)
    const inner = env.startsWith('align') || env.startsWith('flalign') || env.startsWith('eqnarray') || env.startsWith('xalignat') ? 'aligned' :
      env.startsWith('alignat') ? 'alignedat' : env.startsWith('gather') ? 'gathered' : 'gathered';
    const arg = inner === 'alignedat' ? (this.dm.envArg || '{2}') : '';
    return `\\begin{${inner}}${arg}${this.dm.body.trim()}\\end{${inner}}`;
  }

  private bodyFromMathlive(latex: string): string {
    const env = this.dm.env;
    if (env === 'simple' || env === 'equation' || env === 'equation*' || env === 'unknown') return latex;
    const m = /^\s*\\begin\{(aligned|alignedat|gathered)\}(\{[^}]*\})?([\s\S]*)\\end\{\1\}\s*$/.exec(latex);
    return m ? m[3] : latex;
  }

  private commit(latex: string) {
    const pos = this.getPos();
    if (pos === undefined) return;
    const cur = this.view.state.doc.nodeAt(pos);
    if (!cur) return;
    const text = serializeDisplayMath(this.dm, this.bodyFromMathlive(latex));
    if (cur.attrs.latex === text) return;
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
    this.dm = { ...this.dm, env: next };
    this.commit(this.mf.value);
    this.renderMeta();
  }

  setEnv(env: DisplayMath['env']) {
    const wasMulti = !['simple', 'equation', 'equation*', 'unknown'].includes(this.dm.env);
    const body = this.bodyFromMathlive(this.mf.value);
    this.dm = { ...this.dm, env, body, envArg: env.startsWith('alignat') ? (this.dm.envArg || '{2}') : '' };
    const isMulti = !['simple', 'equation', 'equation*', 'unknown'].includes(env);
    if (wasMulti !== isMulti) { this.updating = true; this.mf.value = this.bodyForMathlive(); this.updating = false; }
    this.commit(this.mf.value);
    this.renderMeta();
  }

  setLabel(label: string | null) {
    const idx = Math.max(0, this.dm.labels.findIndex(Boolean));
    const labels = [...this.dm.labels];
    while (labels.length <= idx) labels.push(null);
    labels[idx] = label;
    this.dm = { ...this.dm, labels };
    this.commit(this.mf.value);
    this.renderMeta();
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    if (node.attrs.latex !== serializeDisplayMath(this.dm, this.bodyFromMathlive(this.mf.value))) {
      this.dm = parseDisplayMath(node.attrs.latex);
      if (document.activeElement !== this.mf) {
        this.updating = true;
        this.mf.value = this.bodyForMathlive();
        this.updating = false;
      }
      this.renderMeta();
    }
    return true;
  }
  selectNode() { this.dom.classList.add('ProseMirror-selectednode'); }
  deselectNode() { this.dom.classList.remove('ProseMirror-selectednode'); }
  stopEvent(ev: Event) { return this.mf.contains(ev.target as Node) || this.labelEl.contains(ev.target as Node); }
  ignoreMutation() { return true; }
  focus(atEnd = false) {
    this.mf.focus();
    this.mf.executeCommand(atEnd ? 'moveToMathfieldEnd' : 'moveToMathfieldStart');
  }
  destroy() { this.mf.remove(); }
}

/** FormulaMacro inset: shows "\name := definition" with an editable definition. */
export class MacroView implements NodeView {
  dom: HTMLElement;
  mf: MathfieldElement;
  nameEl: HTMLElement;
  private updating = false;

  constructor(private node: PMNode, private view: EditorView, private getPos: () => number | undefined) {
    this.dom = document.createElement('span');
    this.dom.className = 'lyx-macro';
    this.nameEl = document.createElement('span');
    this.nameEl.className = 'macro-name';
    this.nameEl.contentEditable = 'false';
    const def = this.parse();
    this.nameEl.textContent = '\\' + (def?.name ?? '?') + (def && def.args ? `[${def.args}]` : '') + ' ≔ ';
    this.mf = createMathfield({ latex: def?.def ?? '', display: false });
    this.dom.append(this.nameEl, this.mf);
    if (def?.display) { const d = document.createElement('span'); d.className = 'macro-display'; d.textContent = ' (shown as: ' + def.display + ')'; d.contentEditable = 'false'; this.dom.append(d); }
    wire(this.mf, view, getPos, {
      onChange: (latex) => {
        if (this.updating) return;
        const pos = this.getPos();
        if (pos === undefined) return;
        const cur = this.view.state.doc.nodeAt(pos);
        if (!cur) return;
        const lines: string[] = JSON.parse(cur.attrs.lines);
        const d = macroFromLyxLines(lines);
        if (!d) return;
        const cmd = /^\\renewcommand/.test(lines[0]) ? '\\renewcommand' : '\\newcommand';
        lines[0] = `${cmd}{\\${d.name}}${d.args ? `[${d.args}]` : ''}{${latex}}`;
        this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...cur.attrs, lines: JSON.stringify(lines) }));
      },
    });
    this.nameEl.addEventListener('mousedown', (ev) => { ev.preventDefault(); const pos = this.getPos(); if (pos !== undefined) { this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, pos))); this.view.focus(); } });
  }
  private parse() { try { return macroFromLyxLines(JSON.parse(this.node.attrs.lines)); } catch { return null; } }
  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    const def = this.parse();
    if (def && this.mf.value !== def.def && document.activeElement !== this.mf) { this.updating = true; this.mf.value = def.def; this.updating = false; }
    return true;
  }
  selectNode() { this.dom.classList.add('ProseMirror-selectednode'); }
  deselectNode() { this.dom.classList.remove('ProseMirror-selectednode'); }
  stopEvent(ev: Event) { return this.mf.contains(ev.target as Node); }
  ignoreMutation() { return true; }
  focus() { this.mf.focus(); }
  destroy() { this.mf.remove(); }
}
