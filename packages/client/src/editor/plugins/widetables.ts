/**
 * Tables on a line of their own: a LyX tabular, or a formula that is one matrix / array (a table
 * typed as `$\begin{matrix}…\end{matrix}$`), alone in its paragraph. They are centred on the text
 * column, as `\centering` prints them. One wider than the column spills out into both margins by
 * the same amount, as far as the page reaches on the left; the rest overflows to the right and the
 * page scrolls. That is the rule for wide display formulas too (nodeviews/math.ts relayout).
 *
 * The paragraph gets the class `ol-solo-table` and, when its table spills, `--ol-spill: <px>` (a node
 * decoration: ProseMirror owns the paragraph's DOM); styles.css does the rest. The editor root gets
 * `--ol-column`, the text column's width, which the p{…} columns given relative to the text width use
 * (core schema.ts lyxLengthCss).
 */
import { Plugin, PluginKey, type EditorState, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';

export const wideTablesKey = new PluginKey<DecorationSet>('wideTables');

const TABLE_ENV = /^\s*\\begin\{((?:[pbBvV]?matrix|smallmatrix|array|tabular)\*?)\}[^]*\\end\{\1\}\s*$/;
/** a formula that is a table: one matrix / array / tabular environment, nothing around it */
export function isTableFormula(latex: string): boolean { return TABLE_ENV.test(latex); }

/**
 * What may stand beside the table in its paragraph: blanks, labels, and what takes a line of its
 * own anyway — a caption (below the table in a float), a display formula, a figure.
 */
const besideTable = (n: PMNode) => (n.isText && !n.text!.trim()) || (n.type.name === 'command' && n.attrs.cmd === 'label')
  || n.type.name === 'math_display' || n.type.name === 'graphics' || (n.type.name === 'inset' && n.attrs.name === 'Caption');

/** the table is alone on its line (see besideTable), and the paragraph is not set flush left or right */
export function isSoloTable(par: PMNode): boolean {
  if (!par.isTextblock || par.type.name !== 'paragraph') return false;
  const align = par.attrs.align as string | null | undefined;
  if (align === 'left' || align === 'right') return false;
  let table: PMNode | null = null;
  let other = false;
  par.forEach(child => {
    if (besideTable(child)) return;
    if (!table && (child.type.name === 'table' || (child.type.name === 'math_inline' && isTableFormula(String(child.attrs.latex))))) table = child;
    else other = true;
  });
  return !!table && !other;
}

interface Spec { soloTable: true; spill: number; blank?: true }
const deco = (from: number, to: number, spill: number) =>
  Decoration.node(from, to, spill ? { class: 'ol-solo-table', style: `--ol-spill: ${spill}px` } : { class: 'ol-solo-table' }, { soloTable: true, spill } satisfies Spec);

function scan(doc: PMNode, from: number, to: number, out: Decoration[]): void {
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.isTextblock && isSoloTable(node)) {
      out.push(deco(pos, pos + node.nodeSize, 0));
      // a blank beside the table (before the caption) would push it off the centre by its width
      node.forEach((child, off) => { if (child.isText) out.push(Decoration.inline(pos + 1 + off, pos + 1 + off + child.nodeSize, { class: 'ol-solo-blank' }, { soloTable: true, blank: true })); });
    }
    // on into insets and table cells (their paragraphs hold tables too), not into text or formulas
    return !node.isLeaf && !node.isAtom;
  });
}

function build(state: EditorState): DecorationSet {
  const out: Decoration[] = [];
  scan(state.doc, 0, state.doc.content.size, out);
  return DecorationSet.create(state.doc, out);
}

/** after an edit: the marks move with the text; only the paragraphs the edit touched are looked at again */
function remap(tr: Transaction, prev: DecorationSet): DecorationSet {
  let set = prev.map(tr.mapping, tr.doc);
  const ranges: [number, number][] = [];
  tr.mapping.maps.forEach((m, i) => m.forEach((_a, _b, from, to) => {
    const rest = tr.mapping.slice(i + 1);
    ranges.push([rest.map(from, -1), rest.map(to, 1)]);
  }));
  const size = tr.doc.content.size;
  for (const [a, b] of ranges) {
    const from = Math.max(0, Math.min(a, size)), to = Math.max(from, Math.min(b, size));
    // the textblocks around the change, whole (a paragraph gains or loses its only table)
    const $from = tr.doc.resolve(from), $to = tr.doc.resolve(to);
    const start = $from.depth ? $from.before(Math.max(1, $from.depth)) : from;
    const end = $to.depth ? $to.after(Math.max(1, $to.depth)) : to;
    // (find() also returns the neighbours that only touch the range: they stay)
    const old = set.find(start, end, s => (s as Spec).soloTable).filter(d => d.from >= start && d.to <= end);
    const spillAt = new Map(old.filter(d => !d.spec.blank).map(d => [d.from, (d.spec as Spec).spill]));
    set = set.remove(old);
    const found: Decoration[] = [];
    scan(tr.doc, start, end, found);
    set = set.add(tr.doc, found.map(d => (d.spec.blank ? d : deco(d.from, d.to, spillAt.get(d.from) ?? 0))));
  }
  return set;
}

/** measured spills: [paragraph position, px] */
type SpillMeta = [number, number][];

export function wideTablesPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: wideTablesKey,
    state: {
      init: (_, state) => build(state),
      apply(tr, prev) {
        let set = tr.docChanged ? remap(tr, prev) : prev;
        const spills = tr.getMeta(wideTablesKey) as SpillMeta | undefined;
        if (spills) for (const [pos, spill] of spills) {
          const old = set.find(pos, pos + 1, s => (s as Spec).soloTable && !s.blank).find(d => d.from === pos);
          if (old) set = set.remove([old]).add(tr.doc, [deco(old.from, old.to, spill)]);
        }
        return set;
      },
    },
    props: { decorations(state) { return wideTablesKey.getState(state) ?? null; } },
    view(view) {
      let raf = 0;
      const observed = new Set<Element>();
      const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => schedule());
      const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; measure(view); }); };
      /**
       * Watch the column and every solo table: a width change (typing in a cell, a formula drawn, the
       * ruler, the window) measures again, and so does a table newly watched (the observer reports it
       * at once) — a keystroke elsewhere measures nothing.
       */
      const watch = () => {
        if (!ro) return;
        const want = new Set<Element>([view.dom]);
        for (const d of solos(view.state)) {
          const el = soloElement(view, d.from);
          if (el) want.add(el);
        }
        for (const el of observed) if (!want.has(el)) { ro.unobserve(el); observed.delete(el); }
        for (const el of want) if (!observed.has(el)) { ro.observe(el); observed.add(el); }
      };
      watch();
      if (!ro) schedule();
      return {
        update(v, prevState) { if (wideTablesKey.getState(v.state) !== wideTablesKey.getState(prevState)) watch(); },
        destroy() { cancelAnimationFrame(raf); ro?.disconnect(); },
      };
    },
  });
}

/** the paragraphs' decorations (not the blanks') */
const solos = (state: EditorState) => (wideTablesKey.getState(state) ?? DecorationSet.empty).find(undefined, undefined, s => !s.blank);

/** the table (or table formula) of the solo paragraph at `pos` */
function soloElement(view: EditorView, pos: number): HTMLElement | null {
  const par = view.nodeDOM(pos) as HTMLElement | null;
  return par?.querySelector?.<HTMLElement>(':scope > .lyx-tabular, :scope > .lyx-math-inline') ?? null;
}

/**
 * How far each solo table spills into the left margin: half of what it is wider than its paragraph,
 * but never past the page's left edge (6px short of it). Dispatched only when something changed.
 */
function measure(view: EditorView): void {
  if (view.isDestroyed) return;
  const root = view.dom as HTMLElement;
  const column = Math.round(root.clientWidth);
  if (column && root.style.getPropertyValue('--ol-column') !== column + 'px') root.style.setProperty('--ol-column', column + 'px');
  const scroll = root.closest('.editor-scroll') as HTMLElement | null;
  const pageLeft = scroll ? scroll.getBoundingClientRect().left - scroll.scrollLeft + 6 : 6 - window.scrollX;
  const changes: SpillMeta = [];
  for (const d of solos(view.state)) {
    const par = view.nodeDOM(d.from) as HTMLElement | null;
    const el = soloElement(view, d.from);
    if (!par || !el || !el.offsetParent) continue;   // folded away, or not drawn yet
    const cs = getComputedStyle(par);
    const padL = parseFloat(cs.paddingLeft) || 0;
    const avail = par.clientWidth - padL - (parseFloat(cs.paddingRight) || 0);
    const w = el.offsetWidth;
    const leftRoom = par.getBoundingClientRect().left + padL - pageLeft;
    const spill = w > avail + 1 ? Math.round(Math.max(0, Math.min(leftRoom, (w - avail) / 2))) : 0;
    if (Math.abs(spill - (d.spec as Spec).spill) > 1) changes.push([d.from, spill]);
  }
  if (changes.length) view.dispatch(view.state.tr.setMeta(wideTablesKey, changes).setMeta('addToHistory', false));
}
