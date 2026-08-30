/**
 * Document ▸ Start Appendix Here (packages/client/src/editor/commands.ts toggleAppendix): the
 * marker belongs to one paragraph — Enter after it must not carry it into the new paragraph (it
 * used to, and the writer then emitted \appendix before every paragraph of the appendix).
 */
import { describe, it, expect, vi } from 'vitest';
vi.hoisted(() => { const g = globalThis as any; if (typeof g.window === 'undefined') g.window = g; });
import { EditorState, TextSelection } from 'prosemirror-state';
import { schema } from '../packages/core/src/schema.ts';
import { pmToLyxBody } from '../packages/core/src/convert.ts';
import { toggleAppendix, paragraphBreak } from '../packages/client/src/editor/commands.ts';

function stateWith(text: string) {
  const doc = schema.nodes.doc.create(null, [schema.nodes.paragraph.create({ layout: 'Section' }, schema.text(text))]);
  return EditorState.create({ doc, selection: TextSelection.create(doc, 1 + text.length) });
}
const apply = (state: EditorState, cmd: (s: EditorState, d: (tr: any) => void) => boolean) => { let out = state; cmd(state, tr => { out = state.apply(tr); }); return out; };

describe('start of appendix', () => {
  it('toggles the marker on the cursor paragraph and writes \\start_of_appendix once', () => {
    let st = apply(stateWith('Proofs'), toggleAppendix);
    expect(st.doc.firstChild!.attrs.appendix).toBe(true);
    const body = pmToLyxBody(st.doc);
    expect(body[0].params.start_of_appendix).toBe(true);
    st = apply(st, toggleAppendix);
    expect(st.doc.firstChild!.attrs.appendix).toBe(false);
  });
  it('Enter at the end of the marked paragraph gives an unmarked Standard paragraph', () => {
    let st = apply(stateWith('Proofs'), toggleAppendix);
    st = apply(st, paragraphBreak);
    expect(st.doc.childCount).toBe(2);
    expect(st.doc.child(0).attrs.appendix).toBe(true);
    expect(st.doc.child(1).attrs.layout).toBe('Standard');
    expect(st.doc.child(1).attrs.appendix).toBe(false);
    expect(pmToLyxBody(st.doc).filter(p => p.params.start_of_appendix)).toHaveLength(1);
  });
  it('splitting the marked paragraph in the middle keeps the marker on the first half only', () => {
    let st = apply(stateWith('Proofs'), toggleAppendix);
    st = st.apply(st.tr.setSelection(TextSelection.create(st.doc, 3)));
    st = apply(st, paragraphBreak);
    expect(st.doc.child(0).attrs.appendix).toBe(true);
    expect(st.doc.child(1).attrs.appendix).toBe(false);
  });
});
