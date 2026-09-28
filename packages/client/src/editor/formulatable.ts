/**
 * A table typed as a formula (`$\begin{matrix}…\end{matrix}$`, an `array`) made a real table: LaTeX
 * sets a formula's cells in math mode, on one line — they never wrap, and a matrix has at most ten
 * columns (amsmath's MaxMatrixCols). A tabular's text can wrap (the table toolbar's column width:
 * `X`, `p{…}`), so "Convert to table" writes the grid as a tabular — the `\text{…}` of the cells as
 * text, the rest as inline formulas — and reads it back the way pasted LaTeX is read (the document's
 * own parser, plugins/paste.ts).
 */
import type { EditorView } from 'prosemirror-view';
import { TextSelection } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { schema, parseFormula, writeCellLatex, type Atom, type Cell, type Grid, type Hull, type MacroTable, type Mode } from '@overlyx/core';
import { api } from '../api';
import { viewDocId, editorContext } from './context';

/** grids that are a table and nothing more (a delimited matrix — pmatrix … — is mathematics) */
const TABLE_ENVS = new Set(['matrix', 'smallmatrix', 'array', 'tabular']);

/** the one table grid a formula consists of (blanks around it allowed), or null */
export function formulaTableGrid(h: Hull): Grid | null {
  if (h.rows.length !== 1 || h.ncols !== 1) return null;
  const atoms = (h.rows[0].cells[0] ?? []).filter(a => !(a.t === 'space' || (a.t === 'char' && a.c === ' ')));
  const g = atoms.length === 1 && atoms[0].t === 'grid' ? atoms[0] : null;
  return g && TABLE_ENVS.has(g.env) ? g : null;
}

/** the latex of a formula is a table (see formulaTableGrid) */
export function isFormulaTable(latex: string, macros: MacroTable = {}): boolean {
  try { return !!formulaTableGrid(parseFormula(latex, macros)); } catch { return false; }
}

/** the table grid of a formula node (an inline formula's latex has no `$` around it), or null */
export function formulaNodeGrid(node: PMNode, macros: MacroTable = {}): Grid | null {
  if (node.type.name !== 'math_inline' && node.type.name !== 'math_display') return null;
  const latex = String(node.attrs.latex);
  try { return formulaTableGrid(parseFormula(node.type.name === 'math_inline' ? `$${latex}$` : latex, macros)); } catch { return null; }
}

/** text fonts of math mode, and the math fonts that are one around a `\text{…}` (`\mathbf{\text{a}}` is `\textbf{a}`) */
const MATH_TO_TEXT: Record<string, string> = { mathbf: 'textbf', mathrm: 'textrm', mathit: 'textit', mathsf: 'textsf', mathtt: 'texttt', boldsymbol: 'textbf' };
/** what reads the same set as text or as math: numbers and punctuation (`1`, `.5`, `?`) */
const PLAIN = /^[0-9.,;:!?]$/;

/** a math cell as text-mode LaTeX: its text as text, the math between as `$…$` */
export function cellAsText(cell: Cell, mode: Mode = 'math'): string {
  let out = '';
  let run: Atom[] = [];
  const flush = () => {
    if (!run.length) return;
    out += run.every(a => a.t === 'char' && PLAIN.test(a.c)) ? run.map(a => (a as { c: string }).c).join('') : `$${writeCellLatex(run).trim()}$`;
    run = [];
  };
  for (const a of cell) {
    const t = atomAsText(a, mode);
    if (t === null) run.push(a);
    else { flush(); out += t; }
  }
  flush();
  return out;
}

/** an atom's text-mode LaTeX, or null when it is mathematics (it goes into a `$…$` run) */
function atomAsText(a: Atom, mode: Mode): string | null {
  switch (a.t) {
    case 'font':
      if (a.mode === 'text') return a.n === 'text' ? cellAsText(a.body, 'text') : `\\${a.n}{${cellAsText(a.body, 'text')}}`;
      if (MATH_TO_TEXT[a.n] && a.body.length === 1 && a.body[0].t === 'font' && a.body[0].mode === 'text') return `\\${MATH_TO_TEXT[a.n]}{${atomAsText(a.body[0], 'math')}}`;
      return mode === 'text' ? `$${writeCellLatex([a])}$` : null;
    case 'box': return a.n === 'mbox' ? cellAsText(a.body, 'text') : mode === 'text' || a.n === 'fbox' ? `\\${a.n}{${cellAsText(a.body, 'text')}}` : null;
    case 'ensuremath': return `$${writeCellLatex(a.body).trim()}$`;
    case 'href': return `\\href{${a.target}}{${cellAsText(a.body, mode)}}`;
    case 'style': return mode === 'text' ? `{\\${a.n} ${cellAsText(a.body, 'text')}}` : null;
    default: return mode === 'text' ? writeCellLatex([a]) : null;
  }
}

/** the grid as a tabular: matrix columns are centred; an array keeps its column spec */
export function gridAsTabular(g: Grid): string {
  const spec = (g.env === 'array' || g.env === 'tabular') && g.halign ? g.halign : 'c'.repeat(g.ncols);
  const pos = g.valign === 't' || g.valign === 'b' ? `[${g.valign}]` : '';
  const rows = g.rows.map(r => {
    const cells: string[] = [];
    for (let c = 0; c < g.ncols;) {
      const m = r.multi?.find(x => x.col === c);
      const text = cellAsText(r.cells[c] ?? [], g.env === 'tabular' ? 'text' : 'math').trim();
      cells.push(m ? `\\multicolumn{${m.ncols}}{${m.align}}{${text}}` : text);
      c += m ? m.ncols : 1;
    }
    return '\\hline '.repeat(r.hlines ?? 0) + cells.join(' & ') + ' \\\\';
  });
  return `\\begin{tabular}${pos}{${spec}}\n${rows.join('\n')}\n\\end{tabular}`;
}

function firstTable(nodes: PMNode[]): PMNode | null {
  for (const n of nodes) {
    if (n.type.name === 'table') return n;
    let found: PMNode | null = null;
    n.descendants(d => { if (!found && d.type.name === 'table') found = d; return !found; });
    if (found) return found;
  }
  return null;
}

/**
 * Replace the table formula at `pos` with a table (one undo step), the cursor in its first cell.
 * False (and a note) when the formula is no table, changed meanwhile, or could not be read back.
 */
export async function convertFormulaToTable(view: EditorView, pos: number, macros: MacroTable = {}): Promise<boolean> {
  const node = view.state.doc.nodeAt(pos);
  if (!node) return false;
  const latex = String(node.attrs.latex);
  const g = formulaNodeGrid(node, macros);
  if (!g) return false;
  let table: PMNode | null = null;
  try {
    const r = await api.parseClip(viewDocId(view), gridAsTabular(g));
    table = firstTable(r.blocks.map(b => schema.nodeFromJSON(b)));
  } catch (e) { console.warn('formula → table:', e); }
  const now = view.isDestroyed ? null : view.state.doc.nodeAt(pos);
  if (!table || !now || now.type !== node.type || now.attrs.latex !== latex) {
    if (!view.isDestroyed) editorContext.notify?.(table ? 'The formula changed meanwhile: not converted' : 'The formula could not be made a table', 'error');
    return false;
  }
  const tr = view.state.tr.replaceWith(pos, pos + now.nodeSize, table);
  tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 4)));   // table › row › cell › paragraph
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}
