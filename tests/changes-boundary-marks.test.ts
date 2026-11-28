// @vitest-environment happy-dom
/**
 * The ¶ of a tracked paragraph break (changeTrackingPlugin's decorations) stays the same element
 * while one moves the caret or types elsewhere: it was made anew on every update — a caret move
 * too — so ProseMirror redrew it, and the paragraph around it, on every keystroke. A click on it
 * selects the break where it is now, not where it was drawn.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema } from '@overlyx/core';
import { changeTrackingPlugin, changesFilterPlugin } from '../packages/client/src/editor/plugins/changes';
import { editorContext } from '../packages/client/src/editor/context';

const inserted = JSON.stringify({ type: 'inserted', author: 3, time: 1700000000 });

function editor(): EditorView {
  const doc = schema.nodes.doc.create(null, [
    schema.nodes.paragraph.create({ layout: 'Standard', endChange: inserted }, [schema.text('one')]),
    schema.nodes.paragraph.create({ layout: 'Standard' }, [schema.text('two')]),
  ]);
  const state = EditorState.create({ doc, plugins: [changeTrackingPlugin(), changesFilterPlugin()] });
  const place = document.createElement('div');
  document.body.appendChild(place);
  return new EditorView(place, { state });
}
const pilcrow = (v: EditorView) => v.dom.querySelector('.lyx-change-boundary') as HTMLElement;

describe('the ¶ of a tracked paragraph break', () => {
  beforeEach(() => { editorContext.trackChanges = false; });

  it('stays the same element when the caret moves and when text is typed elsewhere', () => {
    const v = editor();
    const el = pilcrow(v);
    expect(el).toBeTruthy();
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 7)));
    expect(pilcrow(v)).toBe(el);
    v.dispatch(v.state.tr.insertText('x', 8));
    expect(pilcrow(v)).toBe(el);
    v.destroy();
  });

  it('a click selects the break where it is after text was typed before it', () => {
    const v = editor();
    v.dispatch(v.state.tr.insertText('more ', 1));   // "more one": the break moves on by 5
    pilcrow(v).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect([v.state.selection.from, v.state.selection.to]).toEqual([9, 11]);
    v.destroy();
  });
});
