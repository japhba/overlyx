/**
 * Other people's comments are theirs (client editor/plugins/commentguard.ts): this editor's own
 * edits inside someone else's message are refused; one's own messages, replies, resolving and
 * taking the whole thread out still work.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../packages/core/src/schema.ts';
import { commentHeader } from '../packages/core/src/index.ts';
import { commentGuardPlugin, allowCommentEdit, lockedAuthor } from '../packages/client/src/editor/plugins/commentguard.ts';
import { editorContext } from '../packages/client/src/editor/context.ts';

const plain = (text = '') => schema.nodes.paragraph.create({ layout: 'Plain Layout' }, text ? schema.text(text) : undefined);
const header = (who: string) => plain(commentHeader(who, '2026-10-10 12:00'));
const thread = (...pars: PMNode[]) => schema.nodes.inset.create({ name: 'Note', arg: 'Comment', params: '[]', status: 'open' }, pars);

function setup(t: PMNode) {
  const doc = schema.nodes.doc.create(null, [schema.nodes.paragraph.create({ layout: 'Standard' }, [schema.text('Before '), t, schema.text(' after.')])]);
  let start = -1;
  doc.descendants((n, pos) => { if (n.type.name === 'inset') { start = pos; return false; } return true; });
  const state = EditorState.create({ doc, plugins: [commentGuardPlugin()] });
  /** the position inside the thread's paragraph `i`, `off` characters in */
  const at = (i: number, off = 0) => { let p = start + 1; for (let k = 0; k < i; k++) p += state.doc.nodeAt(start)!.child(k).nodeSize; return p + 1 + off; };
  return { state, start, node: state.doc.nodeAt(start)!, at };
}

describe('other people’s comments', () => {
  beforeEach(() => { editorContext.user = { id: 1, name: 'Ada', username: 'ada', color: '#000' } as typeof editorContext.user; editorContext.myNames = []; });

  it('cannot be typed into, cut or joined into; one’s own message can', () => {
    const { state, at } = setup(thread(header('Bob'), plain('Check this.'), header('Ada'), plain('Done.')));
    expect(state.apply(state.tr.insertText('X', at(1, 2))).doc.eq(state.doc)).toBe(true);
    expect(state.apply(state.tr.insertText('X', at(0, 1))).doc.eq(state.doc)).toBe(true);
    expect(state.apply(state.tr.delete(at(1, 0), at(1, 5))).doc.eq(state.doc)).toBe(true);
    // Backspace at the start of my header joins it into Bob's message
    expect(state.apply(state.tr.delete(at(2, 0) - 2, at(2, 0))).doc.eq(state.doc)).toBe(true);
    expect(state.apply(state.tr.addMark(at(1, 0), at(1, 5), schema.marks.emph.create({ value: 'on' }))).doc.eq(state.doc)).toBe(true);
    // mine
    expect(state.apply(state.tr.insertText('X', at(3, 2))).doc.textContent).toContain('DoXne.');
  });

  it('a reply at the thread’s end, resolving, and the whole thread taken out go through', () => {
    const { state, start, node } = setup(thread(header('Bob'), plain('Check this.')));
    const end = start + node.nodeSize - 1;
    const reply = state.apply(state.tr.insert(end, [header('Ada'), plain('Yes')]));
    expect(reply.doc.textContent).toContain('Yes');
    const resolved = state.apply(allowCommentEdit(state.tr.replaceWith(start + 1, start + 1 + node.firstChild!.nodeSize, plain(commentHeader('Bob', '2026-10-10 12:00', true)))));
    expect(resolved.doc.textContent).toContain('[resolved]');
    const gone = state.apply(state.tr.delete(start - 3, start + node.nodeSize + 2));
    expect(gone.doc.textContent).not.toContain('Check');
    // a selection over the text with the thread in it
    expect(state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, state.doc.content.size - 1)).deleteSelection()).doc.textContent).toBe('');
  });

  it('a plain LyX comment (no author) and comments under one’s other name stay open', () => {
    const a = setup(thread(plain('Anyone may edit this.')));
    expect(a.state.apply(a.state.tr.insertText('X', a.at(0, 1))).doc.textContent).toContain('AXnyone');
    editorContext.myNames = ['Ada Lovelace'];
    const b = setup(thread(header('Ada Lovelace'), plain('Mine from elsewhere.')));
    expect(lockedAuthor(b.state.doc, b.at(1, 1), b.at(1, 1))).toBeNull();
    const c = setup(thread(header('Bob'), plain('His.')));
    expect(lockedAuthor(c.state.doc, c.at(1, 1), c.at(1, 1))).toBe('Bob');
  });
});
