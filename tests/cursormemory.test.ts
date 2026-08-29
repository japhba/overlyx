/**
 * Cursor memory (packages/client/src/editor/cursormemory.ts): the saved cursor comes back to the
 * same place, also after the document changed before it.
 */
import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { schema } from '../packages/core/src/schema.ts';
import { cursorToSave, restoredCursorPos } from '../packages/client/src/editor/cursormemory.ts';

const par = (...content: (string | ReturnType<typeof schema.node>)[]) =>
  schema.nodes.paragraph.create({ layout: 'Standard' }, content.map(c => typeof c === 'string' ? schema.text(c) : c));
const doc = (...pars: ReturnType<typeof par>[]) => schema.nodes.doc.create(null, pars);
const math = (latex: string) => schema.nodes.math_inline.create({ latex });

describe('cursor memory', () => {
  const d = doc(par('First paragraph of the document.'), par('Second one with a formula ', math('x^2'), ' and more words after it.'), par('Third.'));

  it('saves the offset and the text before the cursor (atoms as U+FFFC)', () => {
    const state = EditorState.create({ schema, doc: d, selection: TextSelection.create(d, 71) });   // after "and more"
    const saved = cursorToSave(state);
    expect(saved.pos).toBe(71);
    expect(saved.ctx).toBe('Second one with a formula ￼ and more');
    expect(restoredCursorPos(d, saved)).toBe(71);
  });

  it('finds the place again when text was inserted before it', () => {
    const state = EditorState.create({ schema, doc: d, selection: TextSelection.create(d, 71) });
    const saved = cursorToSave(state);
    const changed = doc(par('A brand new first paragraph, and then. '), ...[0, 1, 2].map(i => d.child(i)));
    const pos = restoredCursorPos(changed, saved);
    expect(changed.textBetween(pos - 5, pos)).toBe(' more');
    expect(changed.resolve(pos).parent.textContent).toContain('Second one');
  });

  it('falls back to the clamped offset when the context is gone or too short', () => {
    expect(restoredCursorPos(d, { pos: 10_000, ctx: 'nowhere to be found at all' })).toBe(d.content.size);
    expect(restoredCursorPos(d, { pos: 5, ctx: 'zzz' })).toBe(5);
    expect(restoredCursorPos(d, { pos: 5, ctx: '' })).toBe(5);
  });

  it('prefers the match closest to the old offset', () => {
    const rep = doc(par('same words here'), par('same words here'), par('same words here'));
    const saved = { pos: 2 + 17 + 1 + 10, ctx: 'same words' };   // in the second paragraph
    expect(rep.resolve(restoredCursorPos(rep, saved)).index(0)).toBe(1);
  });
});
