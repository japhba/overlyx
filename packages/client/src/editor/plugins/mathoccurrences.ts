/**
 * The same symbol elsewhere in the document's formulas (the user, 7 Nov 2026: "on selecting a symbol,
 * highlight in a different shade other places of the same symbol too"), as VS Code shows a word's
 * other occurrences. A symbol is one atom of a formula selected in its field (Shift+arrow, a drag, a
 * double click) — or a whole formula that is that one atom, selected as a node. What matches is core
 * math/mathjax.ts `symbolKey`: a letter in its math font (x lights up the x of x_i and of x^2, not
 * \mathbf{x}), a symbol command (\alpha, \nabla), and a symbol with scripts, an accent, a font or a
 * macro by what it writes (x_i only x_i).
 *
 * Cheap by construction: the renderer gives every atom of an editable formula the class of its key
 * (`lm-k-…`), so showing the occurrences is one CSS rule under the editor's root — no formula is
 * drawn again. Formulas far off screen are not fields yet and carry no classes; they light up when
 * they come into view and become fields.
 */
import { NodeSelection, Plugin } from 'prosemirror-state';
import { atomCells, parseFormula, symbolKey, type Atom } from '@overlyx/core';
import { mathCursorListeners, mathFocusListeners, type LyxMathField } from '../lyxmath/field';

interface Shown { root: HTMLElement; key: string }
/** what the formula field with the keyboard has selected, and what the editor has selected as a node */
const shown: { field: Shown | null; node: Shown | null } = { field: null, node: null };
let sheet: HTMLStyleElement | null = null;
let marked: HTMLElement | null = null;

function show(): void {
  const cur = shown.field ?? shown.node;
  if (marked && marked !== cur?.root) delete marked.dataset.olOcc;
  marked = cur?.root ?? null;
  if (!cur) { if (sheet) sheet.textContent = ''; return; }
  cur.root.dataset.olOcc = cur.key;
  if (!sheet) { sheet = document.createElement('style'); sheet.dataset.ol = 'math-occurrences'; document.head.appendChild(sheet); }
  sheet.textContent = `[data-ol-occ="${cur.key}"] .lm-k-${cur.key} { background: var(--math-occ-bg); box-shadow: inset 0 0 0 1px var(--math-occ-line); border-radius: 2px; }`;
}

/** the key of the one atom selected in a formula field, if one is */
export function fieldSymbolKey(field: LyxMathField): string | null {
  const c = field.cursor;
  const r = c.selRange();
  if (!r || r.idx1 !== r.idx2 || r.to - r.from !== 1) return null;
  const atom = atomCells(r.owner)[r.idx1]?.[r.from];
  if (!atom) return null;
  // the font it stands in (the renderer's ctx.font): the innermost font around the selection's cell
  let font = '';
  for (let k = 0; k <= r.depth; k++) {
    const o = c.slices[k]?.owner as Atom | undefined;
    if (o && (o.t === 'font' || o.t === 'oldfont')) font = o.n;
    else if (o && o.t === 'class' && (o.n === 'bm' || o.n === 'boldsymbol' || o.n === 'heavysymbol')) font = 'boldsymbol';
  }
  return symbolKey(atom, font);
}

/** the key of a formula that is a single symbol (`$\alpha$`, `$x_i$`) */
export function formulaSymbolKey(latex: string): string | null {
  try {
    const hull = parseFormula(latex, {});
    const cells = hull.rows.flatMap(r => r.cells).filter(c => c.length);
    return cells.length === 1 && cells[0].length === 1 ? symbolKey(cells[0][0]) : null;
  } catch { return null; }
}

function fieldChanged(field: LyxMathField | null): void {
  const key = field && field.hasFocus() ? fieldSymbolKey(field) : null;
  const root = field?.dom.closest<HTMLElement>('.ProseMirror') ?? null;
  const next = key && root ? { root, key } : null;
  if (next?.key === shown.field?.key && next?.root === shown.field?.root) return;
  shown.field = next;
  show();
}

let wired = false;
export function mathOccurrencesPlugin(): Plugin {
  if (!wired && typeof document !== 'undefined') {
    wired = true;
    mathCursorListeners.add(fieldChanged);
    mathFocusListeners.add(fieldChanged);
  }
  return new Plugin({
    view(view) {
      const update = () => {
        const sel = view.state.selection;
        const node = sel instanceof NodeSelection && (sel.node.type.name === 'math_inline' || sel.node.type.name === 'math_display') ? sel.node : null;
        const key = node ? formulaSymbolKey(String(node.attrs.latex)) : null;
        const mine = shown.node?.root === view.dom;
        if (key) { if (!mine || shown.node!.key !== key) { shown.node = { root: view.dom, key }; show(); } }
        else if (mine) { shown.node = null; show(); }
      };
      return {
        update,
        destroy() { if (shown.node?.root === view.dom) { shown.node = null; show(); } if (shown.field?.root === view.dom) { shown.field = null; show(); } },
      };
    },
  });
}
