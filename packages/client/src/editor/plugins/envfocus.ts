/**
 * The environment the cursor is in. A table (LyX tabular) that holds the selection carries the
 * class `ol-editing`; styles.css draws the dotted cell grid — LyX's hint for cell boundaries without a
 * line — only then, and likewise shows the boxes of a formula's empty cells only while that formula's
 * field has the keyboard. Reading a document shows tables and formulas as they print; the scaffolding
 * appears where one is working.
 *
 * A formula field taking the keyboard leaves the editor's selection where it was (in a table cell,
 * say), so the plugin also listens to the math focus: while a field is focused, only the tables that
 * contain that formula stay marked.
 */
import { Plugin, PluginKey, type EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import { activeMathField, mathFocusListeners } from '../lyxmath/field';

export const envFocusKey = new PluginKey<DecorationSet>('envFocus');
export interface Range { from: number; to: number }

/** the [from, to) ranges of the tables that hold the whole selection, outermost first */
export function editingTables(state: EditorState): Range[] {
  const { $from, to } = state.selection;
  const out: Range[] = [];
  for (let d = 1; d <= $from.depth; d++) {
    if ($from.node(d).type.spec.tableRole !== 'table') continue;
    const after = $from.after(d);
    if (to <= after) out.push({ from: $from.before(d), to: after });
  }
  return out;
}

/** the tables to mark in a view: those around the selection — narrowed to the ones around the focused formula, if one has the keyboard */
export function markedTables(view: EditorView): Range[] {
  const tables = editingTables(view.state);
  const field = activeMathField();
  if (!field || !view.dom.contains(field.dom)) return tables;
  return tables.filter(r => (view.nodeDOM(r.from) as HTMLElement | null)?.contains(field.dom));
}

const build = (state: EditorState, ranges: Range[]) => ranges.length ? DecorationSet.create(state.doc, ranges.map(r => Decoration.node(r.from, r.to, { class: 'ol-editing' }))) : DecorationSet.empty;
const rangesOf = (set: DecorationSet): Range[] => set.find().map(d => ({ from: d.from, to: d.to }));
const same = (a: Range[], b: Range[]) => a.length === b.length && a.every((r, i) => r.from === b[i].from && r.to === b[i].to);

export function envFocusPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: envFocusKey,
    state: {
      init: (_, state) => build(state, editingTables(state)),
      apply(tr, prev, _old, state) {
        const set = tr.getMeta(envFocusKey) as Range[] | undefined;
        if (set) return build(state, set);
        return tr.docChanged || tr.selectionSet ? build(state, editingTables(state)) : prev;
      },
    },
    props: { decorations(state) { return envFocusKey.getState(state) ?? null; } },
    view(view) {
      // after a state change or a formula focus change: bring the marks in line with the focused field
      // (a microtask: not nested in the update, and after the math module has recorded the focus)
      const sync = () => queueMicrotask(() => {
        if (view.isDestroyed) return;
        const want = markedTables(view);
        if (!same(want, rangesOf(envFocusKey.getState(view.state) ?? DecorationSet.empty))) view.dispatch(view.state.tr.setMeta(envFocusKey, want).setMeta('addToHistory', false));
      });
      mathFocusListeners.add(sync);
      return { update: sync, destroy() { mathFocusListeners.delete(sync); } };
    },
  });
}
