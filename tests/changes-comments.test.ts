import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state';
import { chainCommands, deleteSelection } from 'prosemirror-commands';
import { schema } from '../packages/core/src/schema.ts';
import { changeOf, changeTrackingPlugin, trackedDelete } from '../packages/client/src/editor/plugins/changes.ts';
import { editorContext } from '../packages/client/src/editor/context.ts';

function setup() {
  const comment = schema.nodes.inset.create({ name: 'Note', arg: 'Comment', status: 'open' },
    schema.nodes.paragraph.create(null, schema.text('Comment text')));
  const doc = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null,
    [schema.text('Before '), comment, schema.text(' after')]));
  const pos = 1 + 'Before '.length;
  return { state: EditorState.create({ doc, plugins: [changeTrackingPlugin()] }), pos, comment, textPos: pos + 2 };
}

describe('comment deletion while suggesting', () => {
  beforeEach(() => { editorContext.trackChanges = true; editorContext.changeAuthorId = 7; });
  afterEach(() => { editorContext.trackChanges = false; editorContext.changeAuthorId = undefined; });

  it.each([-1, 1] as const)('leaves character deletion inside a comment to normal editing (direction %s)', dir => {
    let { state, textPos } = setup();
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, textPos + 3)));
    let dispatched = false;
    expect(trackedDelete(dir)(state, () => { dispatched = true; })).toBe(false);
    expect(dispatched).toBe(false);
  });

  it.each([-1, 1] as const)('removes selected comment text directly (direction %s)', dir => {
    let { state, pos, textPos } = setup();
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, textPos + 8, textPos + 12)));
    expect(chainCommands(trackedDelete(dir), deleteSelection)(state, tr => { state = state.apply(tr); })).toBe(true);
    const body = state.doc.nodeAt(pos)!.firstChild!;
    expect(body.textContent).toBe('Comment ');
    expect(changeOf(body.firstChild!)).toBeNull();
  });

  it.each(['selected', 'backspace', 'delete'] as const)('removes a whole comment directly (%s)', action => {
    let { state, pos, comment } = setup();
    const selection = action === 'selected' ? NodeSelection.create(state.doc, pos)
      : TextSelection.create(state.doc, action === 'backspace' ? pos + comment.nodeSize : pos);
    state = state.apply(state.tr.setSelection(selection));
    expect(trackedDelete(action === 'backspace' ? -1 : 1)(state, tr => { state = state.apply(tr); })).toBe(true);
    expect(state.doc.textContent).toBe('Before  after');
    expect(state.doc.firstChild!.childCount).toBe(1);
    expect(changeOf(state.doc.firstChild!.firstChild!)).toBeNull();
  });

  it.each([-1, 1] as const)('still tracks deletion in surrounding document text (direction %s)', dir => {
    let { state } = setup();
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 3)));
    expect(trackedDelete(dir)(state, tr => { state = state.apply(tr); })).toBe(true);
    expect(state.doc.textContent).toBe('Before Comment text after');
    expect(changeOf(state.doc.nodeAt(dir === -1 ? 2 : 3)!)).toMatchObject({ type: 'deleted', author: 7 });
  });
});
