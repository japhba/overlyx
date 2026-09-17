/** editor/plugins/envfocus.ts: the table that holds the selection is marked, and only that one. */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { EditorState, TextSelection } from 'prosemirror-state';
import { lyxToPm, schema } from '@overlyx/core';
import { parseTex } from '../packages/core/src/tex/index.ts';
import { envFocusPlugin, envFocusKey, editingTables } from '../packages/client/src/editor/plugins/envfocus.ts';

const doc = () => {
  const r = parseTex('Before.\n\n\\begin{tabular}{cc}\na & \\\\\n & d\n\\end{tabular}\n\nAfter.\n', { layoutDir: path.resolve('lyx/lib/layouts'), localDirs: [] });
  return schema.nodeFromJSON(lyxToPm(r.doc));
};

describe('envFocusPlugin', () => {
  it('marks the table around the cursor and nothing else', () => {
    const d = doc();
    let table = -1, cellText = -1, after = -1;
    d.descendants((n, pos) => {
      if (n.type.spec.tableRole === 'table' && table < 0) table = pos;
      if (n.isText && n.text === 'a') cellText = pos;
      if (n.isText && n.text === 'After.') after = pos;
      return true;
    });
    expect(table).toBeGreaterThan(0);
    let state = EditorState.create({ schema, doc: d, plugins: [envFocusPlugin()] });
    expect(editingTables(state)).toEqual([]);
    expect(envFocusKey.getState(state)!.find().length).toBe(0);
    // into a cell
    state = state.apply(state.tr.setSelection(TextSelection.create(d, cellText + 1)));
    const ranges = editingTables(state);
    expect(ranges).toEqual([{ from: table, to: table + d.nodeAt(table)!.nodeSize }]);
    const decos = envFocusKey.getState(state)!.find();
    expect(decos.length).toBe(1);
    expect(decos[0].from).toBe(table);
    expect((decos[0].spec as any)?.class ?? (decos[0] as any).type.attrs.class).toBe('ol-editing');
    // out again
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, after + 2)));
    expect(editingTables(state)).toEqual([]);
    expect(envFocusKey.getState(state)!.find().length).toBe(0);
    // a selection reaching out of the table is not "editing within" it
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, cellText + 1, after + 2)));
    expect(editingTables(state)).toEqual([]);
  });
});
