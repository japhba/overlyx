// @vitest-environment happy-dom
/**
 * A tracked paragraph break (`endChange`, LyX's change at the end of a paragraph) belongs to the
 * break it was made on. Splitting the paragraph — Enter, Alt+Enter, a plain-text paste of several
 * paragraphs — makes a new break inside it; the old one is still at the end of the text that was
 * after the caret. LyX (Text::breakParagraph) moves the end-of-paragraph change to the second half
 * and gives the new break none (an insertion while tracking). Enter left the change on the first
 * half: a suggested deletion of the break after the paragraph then deleted the break just typed
 * (accepted, it joined the two halves instead of the paragraph with the next one); a pasted text
 * copied it onto every pasted paragraph.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema } from '@overlyx/core';
import { paragraphBreak, paragraphBreakInverse } from '../packages/client/src/editor/commands';
import { changeTrackingPlugin } from '../packages/client/src/editor/plugins/changes';
import { editorViewProps } from '../packages/client/src/editor/assembly';
import { editorContext } from '../packages/client/src/editor/context';

const deletedBy3 = JSON.stringify({ type: 'deleted', author: 3, time: 1700000000 });

function state(): EditorState {
  const doc = schema.nodes.doc.create(null, [
    schema.nodes.paragraph.create({ layout: 'Standard', endChange: deletedBy3 }, [schema.text('onetwo')]),
    schema.nodes.paragraph.create({ layout: 'Standard' }, [schema.text('next')]),
  ]);
  const s = EditorState.create({ doc, plugins: [changeTrackingPlugin()] });
  return s.apply(s.tr.setSelection(TextSelection.create(s.doc, 4)));   // after "one"
}
/** each paragraph: [text, who and what its break is] */
const pars = (s: EditorState) => s.doc.content.content.map(p => {
  const c = p.attrs.endChange ? JSON.parse(p.attrs.endChange) : null;
  return [p.textContent, c ? `${c.type}:${c.author}` : null];
});

describe('splitting a paragraph whose break is a tracked change', () => {
  beforeEach(() => { editorContext.trackChanges = false; editorContext.changeAuthorId = 7; });

  it('Enter: the change stays with the break it was made on, the new break is plain', () => {
    let s = state();
    expect(paragraphBreak(s, tr => { s = s.apply(tr); })).toBe(true);
    expect(pars(s)).toEqual([['one', null], ['two', 'deleted:3'], ['next', null]]);
  });

  it('Enter while suggesting: the new break is the typist\'s insertion', () => {
    editorContext.trackChanges = true;
    let s = state();
    expect(paragraphBreak(s, tr => { s = s.apply(tr); })).toBe(true);
    expect(pars(s)).toEqual([['one', 'inserted:7'], ['two', 'deleted:3'], ['next', null]]);
  });

  it('Alt+Enter: the same', () => {
    let s = state();
    expect(paragraphBreakInverse(s, tr => { s = s.apply(tr); })).toBe(true);
    expect(pars(s)).toEqual([['one', null], ['two', 'deleted:3'], ['next', null]]);
  });

  it('a pasted plain text of several paragraphs: only the last keeps the change', () => {
    const view = new EditorView(document.createElement('div'), { state: state() });
    const data = new DataTransfer();
    data.setData('text/plain', 'a\n\nb\n\nc');
    const ev = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(ev, 'clipboardData', { value: data });
    expect(editorViewProps({ docId: 'p/doc.tex' }).handlePaste!(view, ev, view.state.doc.slice(0, 0))).toBe(true);
    expect(pars(view.state)).toEqual([['onea', null], ['b', null], ['ctwo', 'deleted:3'], ['next', null]]);
    view.destroy();
  });
});
