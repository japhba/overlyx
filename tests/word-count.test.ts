/**
 * The status bar's word / character count leaves out note boxes and comments (the PDF prints
 * neither); greyed-out text is printed and counts, as in LyX.
 */
import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection, NodeSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../packages/core/src/schema.ts';
import { documentStats } from '../packages/client/src/app/shellutil.tsx';

const plain = (text: string) => schema.nodes.paragraph.create({ layout: 'Plain Layout' }, schema.text(text));
const note = (arg: string, text: string) => schema.nodes.inset.create({ name: 'Note', arg, status: 'open', params: '[]' }, plain(text));
const doc = (...content: (PMNode | string)[]) => schema.nodes.doc.create(null, schema.nodes.paragraph.create({ layout: 'Standard' }, content.map(c => (typeof c === 'string' ? schema.text(c) : c))));
const stats = (state: EditorState) => documentStats({ state } as EditorView);

describe('documentStats', () => {
  const d = doc('one two ', note('Comment', 'a comment here'), 'three ', note('Note', 'boxed note'), note('Greyedout', 'grey words'));

  it('leaves out comments and note boxes, counts greyed-out text', () => {
    const s = stats(EditorState.create({ doc: d }));
    expect(s.words).toBe(5);
    expect(s.chars).toBe('onetwothreegreywords'.length);
  });

  it('a selection across a comment does not count it; one inside it does', () => {
    expect(stats(EditorState.create({ doc: d, selection: TextSelection.create(d, 1, 20) }))).toMatchObject({ sel: true, words: 2 });
    let inside = 0;
    d.descendants((n, pos) => { if (n.isText && n.text === 'a comment here') inside = pos; });
    expect(stats(EditorState.create({ doc: d, selection: TextSelection.create(d, inside, inside + 9) }))).toMatchObject({ sel: true, words: 2 });
  });

  it('a selected comment keeps the document numbers', () => {
    let at = 0;
    d.descendants((n, pos) => { if (n.type.name === 'inset' && n.attrs.arg === 'Comment') at = pos; });
    expect(stats(EditorState.create({ doc: d, selection: NodeSelection.create(d, at) }))).toMatchObject({ sel: false, words: 5 });
  });
});
