// @vitest-environment happy-dom
/**
 * Deleting with the keyboard while suggesting (tracked changes on) follows one rule, whichever key
 * does it — the one LyX has (Paragraph::eraseChar): the typist's own suggested text goes, any other
 * text is struck through as a deletion, and the caret ends before what was struck through, so the
 * next press goes on to the text before it.
 *  - Ctrl/⌥+Backspace deleted a word and left the caret after the struck-through word: the next
 *    press "deleted" the same word again (the general rule put it back as a deletion), and the key
 *    did nothing from then on.
 *  - Backspace over somebody else's suggested insertion removed it outright, without a trace (a
 *    deletion across paragraphs struck it through, as LyX does).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '@overlyx/core';
import { lyxKeymap } from '../packages/client/src/editor/keymap';
import { changeTrackingPlugin, changeOf } from '../packages/client/src/editor/plugins/changes';
import { editorContext } from '../packages/client/src/editor/context';

const change = (type: 'inserted' | 'deleted', author: number) => schema.marks.change.create({ type, author, time: 1700000000 });
const docOf = (...content: PMNode[]) => schema.nodes.doc.create(null, [schema.nodes.paragraph.create({ layout: 'Standard' }, content)]);

function editor(d: PMNode, caret: number): EditorView {
  let state = EditorState.create({ doc: d, plugins: [lyxKeymap(), changeTrackingPlugin()] });
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, caret)));
  return new EditorView(document.createElement('div'), { state });
}
function press(view: EditorView, key: string, mod = false): boolean {
  const mac = /Mac/.test(navigator.platform);
  const ev = new KeyboardEvent('keydown', { key, ctrlKey: mod && !mac, metaKey: mod && mac, bubbles: true, cancelable: true });
  return !!view.someProp('handleKeyDown', f => f(view, ev));
}
/** the paragraph's runs: [text, change type, author] */
const runs = (view: EditorView) => view.state.doc.firstChild!.content.content.map(n => [n.text, changeOf(n)?.type ?? null, changeOf(n)?.author ?? null]);

describe('keyboard deletions while suggesting', () => {
  beforeEach(() => { editorContext.trackChanges = true; editorContext.changeAuthorId = 7; });

  it('Ctrl+Backspace strikes through one word per press, the caret before it', () => {
    const v = editor(docOf(schema.text('one two three')), 14);
    expect(press(v, 'Backspace', true)).toBe(true);
    expect(runs(v)).toEqual([['one two', null, null], [' three', 'deleted', 7]]);
    expect(v.state.selection.from).toBe(8);
    expect(press(v, 'Backspace', true)).toBe(true);
    expect(runs(v)).toEqual([['one', null, null], [' two three', 'deleted', 7]]);
    expect(v.state.selection.from).toBe(4);
    v.destroy();
  });

  it('Ctrl+Backspace removes the typist\'s own suggested word', () => {
    const v = editor(docOf(schema.text('one'), schema.text(' two', [change('inserted', 7)])), 8);
    expect(press(v, 'Backspace', true)).toBe(true);
    expect(runs(v)).toEqual([['one', null, null]]);
    expect(v.state.selection.from).toBe(4);
    v.destroy();
  });

  it('Ctrl+Delete strikes through the word after the caret, the caret after it', () => {
    const v = editor(docOf(schema.text('one two')), 1);
    expect(press(v, 'Delete', true)).toBe(true);
    expect(runs(v)).toEqual([['one ', 'deleted', 7], ['two', null, null]]);
    expect(v.state.selection.from).toBe(5);
    v.destroy();
  });

  it('Backspace strikes through somebody else\'s suggested insertion instead of removing it', () => {
    const v = editor(docOf(schema.text('one'), schema.text('X', [change('inserted', 3)])), 5);
    expect(press(v, 'Backspace')).toBe(true);
    expect(runs(v)).toEqual([['one', null, null], ['X', 'deleted', 7]]);
    expect(v.state.selection.from).toBe(4);
    v.destroy();
  });

  it('Backspace removes the typist\'s own suggested insertion', () => {
    const v = editor(docOf(schema.text('one'), schema.text('X', [change('inserted', 7)])), 5);
    expect(press(v, 'Backspace')).toBe(true);
    expect(runs(v)).toEqual([['one', null, null]]);
    v.destroy();
  });
});
