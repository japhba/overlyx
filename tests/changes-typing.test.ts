/**
 * Typing next to a tracked change (the mode switch's Suggesting → Editing, app/EditModeSwitch.tsx):
 * the change mark is not inclusive, so text typed at the end of an insertion or a deletion does
 * not become part of it — untracked while tracking is off, the typist's own insertion while it is on.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../packages/core/src/schema.ts';
import { changeTrackingPlugin, changeOf } from '../packages/client/src/editor/plugins/changes.ts';
import { editorContext } from '../packages/client/src/editor/context.ts';

const change = (type: 'inserted' | 'deleted', author = 3) => schema.marks.change.create({ type, author, time: 1700000000 });
const docOf = (...content: PMNode[]) => schema.nodes.doc.create(null, [schema.nodes.paragraph.create({ layout: 'Standard' }, content)]);

/** type `text` at `pos` (the end of the paragraph when omitted) and list the paragraph's runs */
function typeAt(d: PMNode, text: string, pos = d.content.size - 1) {
  let state = EditorState.create({ doc: d, plugins: [changeTrackingPlugin()] });
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
  state = state.apply(state.tr.insertText(text));
  return state.doc.firstChild!.content.content.map(n => [n.text, changeOf(n)?.type ?? null, changeOf(n)?.author ?? null]);
}

describe('typing next to a tracked change', () => {
  beforeEach(() => { editorContext.trackChanges = false; editorContext.changeAuthorId = 7; });

  it('tracking off: text typed after an insertion is plain', () => {
    expect(typeAt(docOf(schema.text('Hello'), schema.text(' added', [change('inserted')])), ' plain'))
      .toEqual([['Hello', null, null], [' added', 'inserted', 3], [' plain', null, null]]);
  });

  it('tracking off: text typed after a deletion is not deleted', () => {
    expect(typeAt(docOf(schema.text('Hello'), schema.text(' gone', [change('deleted')])), ' plain'))
      .toEqual([['Hello', null, null], [' gone', 'deleted', 3], [' plain', null, null]]);
  });

  it('tracking off: text typed inside a suggestion joins it', () => {
    expect(typeAt(docOf(schema.text('Hello'), schema.text(' added', [change('inserted')])), 'X', 9))
      .toEqual([['Hello', null, null], [' adXded', 'inserted', 3]]);
  });

  it('tracking on: text typed after somebody else\'s insertion or a deletion is the typist\'s insertion', () => {
    editorContext.trackChanges = true;
    expect(typeAt(docOf(schema.text('Hello'), schema.text(' added', [change('inserted')])), ' mine'))
      .toEqual([['Hello', null, null], [' added', 'inserted', 3], [' mine', 'inserted', 7]]);
    expect(typeAt(docOf(schema.text('Hello'), schema.text(' gone', [change('deleted')])), ' mine'))
      .toEqual([['Hello', null, null], [' gone', 'deleted', 3], [' mine', 'inserted', 7]]);
  });

  it('tracking on: typing on at the end of one\'s own insertion extends it, whatever its time', () => {
    editorContext.trackChanges = true;
    expect(typeAt(docOf(schema.text('Hello'), schema.text(' mine', [change('inserted', 7)])), ' more'))
      .toEqual([['Hello', null, null], [' mine more', 'inserted', 7]]);
  });
});
