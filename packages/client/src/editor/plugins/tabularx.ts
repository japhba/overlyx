/**
 * X columns (LyX's variable-width columns, tabularx): the text in them wraps, and they share equally
 * what the table's other columns leave of the table width, as tabularx sets them. The schema draws an
 * X column `calc((table width − var(--ol-xrest)) / n)` (core schema.ts colgroupDOM); this plugin
 * measures `--ol-xrest`, the width the other columns take as drawn, and sets it on the table (a node
 * decoration: ProseMirror owns the table's DOM). It measures again when a table with X columns or
 * the text column changes size — typing in a natural column widens it, and the X columns give way.
 */
import { Plugin, PluginKey, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { TableMap } from 'prosemirror-tables';
import { isVarwidthColumn } from '@overlyx/core';

export const tabularxKey = new PluginKey<DecorationSet>('tabularx');

interface Spec { tabularx: true; rest: number }

/** which columns of a table are X columns; null when none is */
export function xColumns(table: PMNode): boolean[] | null {
  let cols: [string, string][][];
  try { cols = JSON.parse(table.attrs.columns || '[]'); } catch { return null; }
  if (!Array.isArray(cols)) return null;
  const x = cols.map(isVarwidthColumn);
  return x.some(Boolean) ? x : null;
}

const deco = (pos: number, node: PMNode, rest: number) =>
  Decoration.node(pos, pos + node.nodeSize, rest ? { style: `--ol-xrest: ${rest}px` } : {}, { tabularx: true, rest } satisfies Spec);

function scan(doc: PMNode, from: number, to: number, out: Decoration[]): void {
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === 'table' && xColumns(node)) out.push(deco(pos, node, 0));
    // on into insets and table cells (a table in a cell), not into text or formulas
    return !node.isLeaf && !node.isAtom;
  });
}

/** after an edit: the decorations move with their tables; the top-level paragraphs the edit touched are scanned again */
function remap(tr: Transaction, prev: DecorationSet): DecorationSet {
  let set = prev.map(tr.mapping, tr.doc);
  const size = tr.doc.content.size;
  tr.mapping.maps.forEach((m, i) => m.forEach((_a, _b, from, to) => {
    const rest = tr.mapping.slice(i + 1);
    const a = Math.max(0, Math.min(rest.map(from, -1), size)), b = Math.max(a, Math.min(rest.map(to, 1), size));
    const $a = tr.doc.resolve(a), $b = tr.doc.resolve(b);
    const start = $a.depth ? $a.before(1) : a, end = $b.depth ? $b.after(1) : b;
    const old = set.find(start, end, s => (s as Spec).tabularx).filter(d => d.from >= start && d.to <= end);
    const restAt = new Map(old.map(d => [d.from, (d.spec as Spec).rest]));
    set = set.remove(old);
    const found: Decoration[] = [];
    scan(tr.doc, start, end, found);
    set = set.add(tr.doc, found.map(d => deco(d.from, tr.doc.nodeAt(d.from)!, restAt.get(d.from) ?? 0)));
  }));
  return set;
}

/** measured widths: [table position, px the other columns take] */
type RestMeta = [number, number][];

export function tabularxPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: tabularxKey,
    state: {
      init: (_, state) => { const out: Decoration[] = []; scan(state.doc, 0, state.doc.content.size, out); return DecorationSet.create(state.doc, out); },
      apply(tr, prev) {
        let set = tr.docChanged ? remap(tr, prev) : prev;
        const rests = tr.getMeta(tabularxKey) as RestMeta | undefined;
        if (rests) for (const [pos, rest] of rests) {
          const old = set.find(pos, pos + 1, s => (s as Spec).tabularx).find(d => d.from === pos);
          const node = tr.doc.nodeAt(pos);
          if (old && node) set = set.remove([old]).add(tr.doc, [deco(pos, node, rest)]);
        }
        return set;
      },
    },
    props: { decorations(state) { return tabularxKey.getState(state) ?? null; } },
    view(view) {
      let raf = 0;
      const observed = new Set<Element>();
      const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => schedule());
      const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; measure(view); }); };
      /** watch the text column and every table with X columns (a table newly watched is reported at once) */
      const watch = () => {
        if (!ro) return;
        const want = new Set<Element>([view.dom]);
        for (const d of tables(view)) { const el = view.nodeDOM(d.from); if (el instanceof Element) want.add(el); }
        for (const el of observed) if (!want.has(el)) { ro.unobserve(el); observed.delete(el); }
        for (const el of want) if (!observed.has(el)) { ro.observe(el); observed.add(el); }
      };
      watch();
      if (!ro) schedule();
      return {
        update(v, prevState) { if (tabularxKey.getState(v.state) !== tabularxKey.getState(prevState)) watch(); },
        destroy() { cancelAnimationFrame(raf); ro?.disconnect(); },
      };
    },
  });
}

const tables = (view: EditorView) => (tabularxKey.getState(view.state) ?? DecorationSet.empty).find();

/**
 * The width the columns other than the X columns take, per table: of each such column, the drawn
 * width of a cell that spans only it (a <col>'s width is its cells' border-box width). Dispatched
 * only when it changed.
 */
function measure(view: EditorView): void {
  if (view.isDestroyed) return;
  const changes: RestMeta = [];
  for (const d of tables(view)) {
    const table = view.state.doc.nodeAt(d.from);
    const el = view.nodeDOM(d.from) as HTMLElement | null;
    const x = table && xColumns(table);
    if (!table || !x || !el || !el.offsetParent) continue;   // folded away, or not drawn yet
    let map: TableMap;
    try { map = TableMap.get(table); } catch { continue; }
    let rest = 0;
    for (let c = 0; c < map.width; c++) {
      if (x[c]) continue;
      for (let r = 0; r < map.height; r++) {
        const off = map.map[r * map.width + c];
        if ((table.nodeAt(off)?.attrs.colspan ?? 1) !== 1) continue;
        const td = view.nodeDOM(d.from + 1 + off) as HTMLElement | null;
        if (td) { rest += td.offsetWidth; break; }
      }
    }
    if (Math.abs(rest - (d.spec as Spec).rest) > 1) changes.push([d.from, rest]);
  }
  if (changes.length) view.dispatch(view.state.tr.setMeta(tabularxKey, changes).setMeta('addToHistory', false));
}
