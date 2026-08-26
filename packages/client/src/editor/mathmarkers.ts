/**
 * LyX-like inset markers and cell-edge deletion for MathLive fields.
 *
 * Markers (LyX: MathRow.cpp drawMarkers, InsetMath::marker): every math inset that has cells — \frac,
 * \sqrt, \left…\right, \text{}, scripts, decorations, macros with arguments — gets small corner marks
 * while the cursor is inside it or the mouse hovers over it. Fractions, grids and macros get four
 * corners (MARKER2), everything else the two lower corners; a macro that is being edited also shows
 * its name (BOX_MARKER). All insets on the cursor's path are marked, not only the innermost one.
 *
 * Deletion (LyX: Cursor::backspace / Cursor::erase → pullArg): Backspace at the inner left edge of a
 * cell or Delete at its inner right edge dissolves the inset, i.e. replaces it by the cell's content.
 *
 * MathLive has no public atom API, so this reads the field's internal model (`_mathfield.model`):
 * `model.at(offset)` is the atom before the caret, atoms know their `parent`/`parentBranch`, and the
 * rendered spans carry `data-atom-id`, which is what the field itself uses for hit-testing.
 */
import type { MathfieldElement } from 'mathlive';

type Kind = 'lower' | 'both' | 'box';
/** A marked inset: `atom` identifies it, the rect is the union of the boxes of `atom` and `extra`. */
interface Inset { atom: any; kind: Kind; name?: string; extra?: any[] }

const internal = (mf: MathfieldElement): any => (mf as any)._mathfield ?? null;

/** The data string of an `\htmlData{…}{…}` atom (our expanded macro / argument wrappers). */
function htmlData(atom: any): string | null {
  return atom?.command === '\\htmlData' && typeof atom.args?.[0] === 'string' ? atom.args[0] : null;
}
const macroName = (hd: string): string | null => /(?:^|,)lyxmacro=([^,]+)/.exec(hd)?.[1] ?? null;
const isArg = (hd: string): boolean => /(?:^|,)lyxarg=/.test(hd);

/** Insets whose single cell replaces them when dissolved (LyX: nargs() == 1 nests). */
const ONE_CELL = new Set(['leftright', 'surd', 'accent', 'overunder', 'group', 'phantom', 'box', 'enclose', 'mathstyle']);

/** LyX marker type for `atom` seen as the inset containing `branch`; null when LyX draws none. */
function kindOf(atom: any, branch?: string): Kind | null {
  const hd = htmlData(atom);
  if (hd) return macroName(hd) ? 'both' : null;
  switch (atom.type) {
    case 'genfrac': case 'array': return 'both';
    case 'box': case 'enclose': return null;       // InsetMathBoxed / InsetMathFBox: NO_MARKER
    case 'root': case 'first': case 'latexgroup': case 'prompt': case 'placeholder': return null;
    default: break;
  }
  if (ONE_CELL.has(atom.type)) return 'lower';
  if (branch === 'superscript' || branch === 'subscript') return 'lower';   // an operator carrying its own limits
  return null;
}

/** The run of text-mode atoms (one `\text{…}` cell) around `atom`. */
function textRun(atom: any): any[] {
  const run = [atom];
  for (let a = atom.leftSibling; a && a.mode === 'text' && a.type !== 'first'; a = a.leftSibling) run.unshift(a);
  for (let a = atom.rightSibling; a && a.mode === 'text'; a = a.rightSibling) run.push(a);
  return run;
}
const textInset = (atom: any): Inset => { const run = textRun(atom); return { atom: run[0], kind: 'lower', extra: run.slice(1) }; };

/** MathLive keeps scripts in a `subsup` atom after their base; LyX's script inset spans both. */
function scriptInset(subsup: any): Inset {
  const base = subsup.leftSibling;
  return { atom: subsup, kind: 'lower', extra: base && base.type !== 'first' ? [base] : [] };
}

/** `atom` as the inset that contains its `branch` (undefined: the atom itself, for hovering). */
function containerInset(atom: any, branch?: string): Inset | null {
  if (atom.type === 'subsup') return !branch || branch === 'superscript' || branch === 'subscript' ? scriptInset(atom) : null;
  const k = kindOf(atom, branch);
  return k ? { atom, kind: k } : null;
}

/** All insets the caret is inside, innermost first. */
function editingInsets(model: any): Inset[] {
  const atom = model.at(model.position);
  if (!atom) return [];
  const out: Inset[] = [];
  // insets collected since the last macro boundary: kept when they turn out to be inside an argument,
  // dropped when they belong to a macro's expansion template (LyX: macro_nesting → no markers)
  let pending: Inset[] = [];
  let skipping = false;
  if (atom.mode === 'text' && atom.type !== 'first') pending.push(textInset(atom));
  let child = atom;
  for (let a = atom.parent; a && a.type !== 'root'; child = a, a = a.parent) {
    const hd = htmlData(a);
    if (hd && isArg(hd)) { out.push(...pending); pending = []; skipping = true; }
    else if (hd && macroName(hd)) { if (!skipping) pending = []; out.push(...pending, { atom: a, kind: 'box', name: macroName(hd)! }); pending = []; skipping = false; }
    else if (!skipping) { const ins = containerInset(a, child.parentBranch); if (ins) pending.push(ins); }
  }
  out.push(...pending);
  return out;
}

/** The innermost inset under the mouse pointer (LyX highlights hovered insets too). */
function hoverInset(mf: MathfieldElement, model: any, x: number, y: number): Inset | null {
  const root = mf.shadowRoot;
  if (!root) return null;
  let el = (root as unknown as DocumentOrShadowRoot).elementFromPoint(x, y) as Element | null;
  for (; el && el !== (root as unknown as Node); el = el.parentElement) {
    const id = el.getAttribute?.('data-atom-id');
    if (!id) continue;
    const atom = (model.atoms as any[]).find(a => a.id === id);
    if (!atom) return null;
    if (atom.mode === 'text' && atom.type !== 'first') return textInset(atom);
    if (atom.rightSibling?.type === 'subsup') return scriptInset(atom.rightSibling);
    let child: any = null;
    let skipping = false;
    for (let a = atom; a && a.type !== 'root'; child = a, a = a.parent) {
      const hd = htmlData(a);
      if (hd && isArg(hd)) skipping = true;
      else if (hd && macroName(hd)) return { atom: a, kind: 'both' };
      else if (!skipping) { const ins = containerInset(a, child?.parentBranch); if (ins) return ins; }
    }
    return null;
  }
  return null;
}

interface Box { l: number; t: number; r: number; b: number }

/** Rendered boxes by atom id: one query per redraw instead of one per atom. */
function boxIndex(root: ShadowRoot): Map<string, Element[]> {
  const idx = new Map<string, Element[]>();
  for (const el of root.querySelectorAll('[data-atom-id]')) {
    const id = el.getAttribute('data-atom-id')!;
    const list = idx.get(id);
    if (list) list.push(el); else idx.set(id, [el]);
  }
  return idx;
}

function rectOf(idx: Map<string, Element[]>, inset: Inset): Box | null {
  let box: Box | null = null;
  const add = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return;
    box = box ? { l: Math.min(box.l, r.left), t: Math.min(box.t, r.top), r: Math.max(box.r, r.right), b: Math.max(box.b, r.bottom) } : { l: r.left, t: r.top, r: r.right, b: r.bottom };
  };
  const nodesOf = (a: any): Element[] => (a?.id && idx.get(a.id)) || [];
  for (const a of [inset.atom, ...(inset.extra ?? [])]) {
    let nodes = nodesOf(a);
    if (!nodes.length) nodes = (a.children as any[]).flatMap(nodesOf);
    nodes.forEach(add);
    for (const b of ['superscript', 'subscript']) for (const c of a[b] ?? []) nodesOf(c).forEach(add);
  }
  return box;
}

const COLOR = '#c000c0';   // LyX Color_mathframe (magenta)
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

function corner(x: number, y: number, h: 'left' | 'right', v: 'top' | 'bottom'): string {
  return `<div style="position:absolute;box-sizing:border-box;left:${x}px;top:${y}px;width:3px;height:3px;border-${h}:1px solid ${COLOR};border-${v}:1px solid ${COLOR}"></div>`;
}

function draw(mf: MathfieldElement, insets: Inset[]): void {
  const root = mf.shadowRoot;
  if (!root) return;
  let layer = root.querySelector('.lyx-mk') as HTMLElement | null;
  if (!insets.length) { if (layer) layer.replaceChildren(); return; }
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'lyx-mk';
    // `contain` keeps overlay updates from invalidating the layout of the page around the field
    layer.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:5;contain:layout style';
    root.appendChild(layer);
  }
  const base = layer.getBoundingClientRect();
  const idx = boxIndex(root);
  const parts: string[] = [];
  for (const ins of insets) {
    const r = rectOf(idx, ins);
    if (!r) continue;
    // LyX reserves a 2px margin around the inset and draws the corners just outside it
    const l = r.l - base.left - 2, rt = r.r - base.left - 1, t = r.t - base.top - 1, b = r.b - base.top - 2;
    parts.push(corner(l, b, 'left', 'bottom'), corner(rt, b, 'right', 'bottom'));
    if (ins.kind !== 'lower') parts.push(corner(l, t, 'left', 'top'), corner(rt, t, 'right', 'top'));
    if (ins.kind === 'box' && ins.name) {
      parts.push(`<div style="position:absolute;left:${l}px;top:${t - 10}px;font:8px/10px system-ui,sans-serif;color:#7a1f7a;background:#f6e3f6;padding:0 2px;border-radius:2px;white-space:nowrap">\\${esc(ins.name)}</div>`);
    }
  }
  layer.innerHTML = parts.join('');
}

/** Draw LyX-style markers around the insets that contain the caret / the mouse pointer. */
export function installMarkers(mf: MathfieldElement): void {
  let raf = 0;
  let hover: Inset | null = null;
  const redraw = () => {
    raf = 0;
    last = performance.now();
    const mfi = internal(mf);
    const model = mfi?.model;
    if (!model) return;
    // a re-render is pending: measuring now would force a layout of the stale content (and a second one
    // after the render) — try again next frame
    if (mfi.dirty) { raf = requestAnimationFrame(redraw); return; }
    const list = mf.hasFocus() ? editingInsets(model) : [];
    if (hover && !list.some(i => i.atom === hover!.atom)) list.push(hover);
    draw(mf, list);
  };
  // MathLive renders a keystroke in two passes (content, then caret); collapse them into one redraw
  let last = 0;
  let timer = 0;
  const schedule = () => {
    if (raf || timer) return;
    const wait = 30 - (performance.now() - last);
    if (wait > 0) timer = window.setTimeout(() => { timer = 0; raf = requestAnimationFrame(redraw); }, wait);
    else raf = requestAnimationFrame(redraw);
  };
  // caret moves only touch attributes in the field's DOM, content changes replace nodes (observer below)
  for (const ev of ['selection-change', 'focusin', 'focusout']) mf.addEventListener(ev, schedule);
  mf.addEventListener('pointermove', (ev: PointerEvent) => {
    const model = internal(mf)?.model;
    if (!model) return;
    const h = hoverInset(mf, model, ev.clientX, ev.clientY);
    if ((h?.atom ?? null) !== (hover?.atom ?? null)) { hover = h; schedule(); }
  });
  mf.addEventListener('pointerleave', () => { if (hover) { hover = null; schedule(); } });
  const observe = () => {
    const root = mf.shadowRoot;
    if (!root) return;
    // the field re-renders its content on every model change (the caret is part of the markup)
    new MutationObserver(records => {
      if (records.every(r => (r.target as Element).closest?.('.lyx-mk') || (r.target as Element).classList?.contains('lyx-mk'))) return;
      schedule();
    }).observe(root, { childList: true, subtree: true });
  };
  if (mf.shadowRoot && (mf as any)._mathfield) observe(); else mf.addEventListener('mount', observe, { once: true });
  (mf as any).__lyxRedraw = redraw;   // for tests
}

/** LyX math keys: Backspace/Delete at a cell edge dissolve the inset (and select a big inset before
 *  deleting it), Space leaves the inset; the caret never rests in a macro's expansion template. */
export function installLyxKeys(mf: MathfieldElement): void {
  mf.addEventListener('keydown', (ev: KeyboardEvent) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey || mf.readOnly) return;
    let handled = false;
    if ((ev.key === 'Backspace' || ev.key === 'Delete') && !ev.shiftKey) {
      const dir = ev.key === 'Backspace' ? 'backward' : 'forward';
      handled = dissolveAtCaret(mf, dir) || confirmDeletion(mf, dir);
    } else if (ev.key === ' ') handled = spaceAtCaret(mf);
    if (handled) { ev.preventDefault(); ev.stopImmediatePropagation(); }
  }, { capture: true });
  let lastPos = -1;
  let pointer = false;   // the caret was placed with the mouse: go to the nearest cell edge, not "onwards"
  mf.addEventListener('pointerdown', () => { pointer = true; }, { capture: true });
  mf.addEventListener('selection-change', () => {
    const model = internal(mf)?.model;
    if (!model) return;
    if (model.selectionIsCollapsed) keepOutOfTemplates(model, pointer ? -1 : lastPos);
    pointer = false;
    lastPos = model.position;
  });
}

/** The macro whose expansion (not one of its argument cells) contains `atom`, or null: our expanded
 *  templates (`\htmlData{lyxmacro=…}`) and MathLive's own `macro` atoms (argument-less macros). */
function templateOf(atom: any): any {
  for (let a = atom.parent; a && a.type !== 'root'; a = a.parent) {
    const hd = htmlData(a);
    if (hd && isArg(hd)) return null;
    if ((hd && macroName(hd)) || a.type === 'macro') return a;
  }
  return null;
}

/** LyX only ever places the cursor in a macro's argument cells (or around the macro): a caret that
 *  lands in the expansion template is moved on to the next cell in the direction of travel, or to
 *  the nearest cell edge after a mouse click. */
function keepOutOfTemplates(model: any, lastPos: number): void {
  const atom = model.at(model.position);
  if (!atom) return;
  const macro = templateOf(atom);
  if (!macro) return;
  const pos = model.position;
  const stops: number[] = [model.offsetOf(macro.leftSibling)];          // before the macro
  for (const a of macro.children as any[]) { const hd = htmlData(a); if (hd && isArg(hd)) stops.push(model.offsetOf(a.firstChild), model.offsetOf(a.lastChild)); }
  stops.push(model.offsetOf(macro));                                      // after the macro
  let target: number | undefined;
  if (lastPos >= 0 && lastPos < pos) target = stops.find(s => s > pos);
  else if (lastPos >= 0 && lastPos > pos) target = [...stops].reverse().find(s => s < pos);
  if (target === undefined) target = stops.reduce((best, s) => (Math.abs(s - pos) < Math.abs(best - pos) ? s : best), stops[0]);
  if (target !== pos) model.position = target;
}

/** LyX (Cursor::backspace/erase + InsetMathNest::confirmDeletion): deleting across a "big" inset first
 *  selects it; the next Backspace/Delete removes the selection. */
function confirmDeletion(mf: MathfieldElement, dir: 'backward' | 'forward'): boolean {
  const model = internal(mf)?.model;
  if (!model || !model.selectionIsCollapsed || mf.mode !== 'math') return false;
  const cur = model.at(model.position);
  const atom = dir === 'backward' ? cur : cur?.rightSibling;
  if (!atom || atom.type === 'first') return false;
  let first = atom, last = atom;
  if (atom.mode === 'text') { const run = textRun(atom); first = run[0]; last = run[run.length - 1]; }
  else if (atom.type === 'subsup') { const b = atom.leftSibling; if (b && b.type !== 'first') first = b; }
  else if (dir === 'forward' && atom.rightSibling?.type === 'subsup') last = atom.rightSibling;
  else if (!(htmlData(atom) && macroName(htmlData(atom)!)) && !ONE_CELL.has(atom.type) && !['genfrac', 'array', 'box', 'enclose'].includes(atom.type)) return false;
  mf.selection = { ranges: [[model.offsetOf(first.leftSibling), model.offsetOf(last)]] } as any;
  return true;
}

/** The inset that owns the caret's cell (a macro for the cells of its arguments), or null at top level. */
function owningInset(atom: any): any {
  let p = atom.parent;
  if (!p || p.type === 'root') return null;
  const hd = htmlData(p);
  if (hd && isArg(hd)) { while (p && !(htmlData(p) && macroName(htmlData(p)!))) p = p.parent; }
  return p && p.type !== 'root' ? p : null;
}

/** LyX (InsetMathNest::interpretChar): Space leaves the current inset; at the very end it leaves the
 *  formula and becomes a space in the text; elsewhere at top level it does nothing. */
export function spaceAtCaret(mf: MathfieldElement): boolean {
  const model = internal(mf)?.model;
  if (!model || mf.mode !== 'math') return false;          // \text{} cells and LaTeX command mode keep MathLive's behaviour
  if (!model.selectionIsCollapsed) { model.position = model.position; return true; }   // LyX: just clear the selection
  const atom = model.at(model.position);
  const owner = atom && owningInset(atom);
  if (owner) { model.position = model.offsetOf(owner); return true; }
  if (model.position >= model.lastOffset) mf.dispatchEvent(new CustomEvent('move-out', { detail: { direction: 'forward', insertSpace: true } }));
  return true;
}

/** Backspace at the inner left edge / Delete at the inner right edge of a cell dissolves the inset (LyX pullArg). */
export function dissolveAtCaret(mf: MathfieldElement, dir: 'backward' | 'forward'): boolean {
  const mfi = internal(mf);
  const model = mfi?.model;
  if (!model || !model.selectionIsCollapsed) return false;
  const atom = model.at(model.position);
  if (!atom) return false;

  // \text{…}: MathLive has no cell around text atoms, only the right edge is distinguishable
  if (atom.mode === 'text' && atom.type !== 'first') {
    if (dir !== 'forward' || atom.rightSibling?.mode === 'text') return false;
    const run = textRun(atom);
    mfi.snapshot('deleteForward');   // insert() only records the state after the change
    const latex = run.map(a => { const v = String(a.value ?? ''); return v === ' ' ? '\\ ' : /[\\{}^_$%&#~]/.test(v) ? '' : v; }).join('');
    mf.selection = { ranges: [[model.offsetOf(run[0]) - 1, model.offsetOf(run[run.length - 1])]] } as any;
    mf.insert(latex, { insertionMode: 'replaceSelection', selectionMode: 'after', format: 'latex', mode: 'math' });
    mfi.popUndoStack();              // drop insert()'s own snapshot so one undo restores the text cell
    return true;
  }

  if (dir === 'backward' ? atom.type !== 'first' : !atom.isLastSibling) return false;
  const parent = atom.parent;
  const branch = atom.parentBranch as string;
  if (!parent || parent.type === 'root') return false;

  let target = parent;                 // the inset that goes away
  let pull: () => any[];               // detaches and returns the atoms that replace it
  const hd = htmlData(parent);
  if (hd && isArg(hd)) {
    // argument of an expanded LyX macro: the whole macro is replaced by this argument's content
    let m = parent.parent;
    while (m && !(htmlData(m) && macroName(htmlData(m)!))) m = m.parent;
    if (!m || m.type === 'root') return false;
    target = m;
    pull = () => parent.removeBranch(branch);
  } else if (hd) return false;
  else if (parent.type === 'genfrac') {
    // only the outer edges; MathLive already merges the cells at the inner ones
    if (branch !== (dir === 'backward' ? 'above' : 'below')) return false;
    pull = () => [...parent.removeBranch('above'), ...parent.removeBranch('below')];
  } else if (ONE_CELL.has(parent.type) && branch === 'body') pull = () => parent.removeBranch('body');
  else return false;   // scripts, arrays, …: MathLive's own behaviour

  const container = target.parent;
  if (!container) return false;
  const before = target.leftSibling;
  mfi.snapshot(dir === 'backward' ? 'deleteBackward' : 'deleteForward');
  model.deferNotifications({ content: true, selection: true, type: dir === 'backward' ? 'deleteContentBackward' : 'deleteContentForward' }, () => {
    const kids = pull().filter((a: any) => a.type !== 'first');
    container.addChildrenAfter(kids, target);
    container.removeChild(target);
    model.position = dir === 'backward' || !kids.length ? model.offsetOf(before) : model.offsetOf(kids[kids.length - 1]);
  });
  mfi.dirty = true;
  mfi.scrollIntoView();
  return true;
}
