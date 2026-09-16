// @vitest-environment happy-dom
/**
 * `$` typed in the text opens an inline formula (commands.ts typeDollar / keymap '$'); the math
 * field then treats `$` as the closing dollar and a second `$` in the empty formula as `$$`
 * (field.ts dollarKey); Backspace in the empty formula puts the typed dollars back (moveOut in
 * nodeviews/math.ts). Raw LaTeX keeps the character.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { schema } from '../packages/core/src/schema.ts';
import { typeDollar, inRawText } from '../packages/client/src/editor/commands.ts';
import { pendingFocus } from '../packages/client/src/editor/nodeviews/math.ts';

function stateWith(par: any, cursor: number) {
  const doc = schema.nodes.doc.create(null, [par]);
  const s = EditorState.create({ doc, schema });
  return s.apply(s.tr.setSelection(TextSelection.create(doc, cursor)));
}
const plainPar = (text: string, layout = 'Standard') => schema.nodes.paragraph.create({ layout }, text ? [schema.text(text)] : []);
function fakeView(state: EditorState) {
  const view: any = { state, dispatch(tr: any) { view.state = view.state.apply(tr); }, nodeDOM: () => null, focus() {} };
  return view;
}

describe('$ opens a formula', () => {
  beforeEach(() => { (globalThis as any).requestAnimationFrame = (f: () => void) => { f(); return 0; }; pendingFocus.pos = null; pendingFocus.dollar = ''; });

  it('inserts an empty inline formula at the cursor and marks it as opened by $', () => {
    const v = fakeView(stateWith(plainPar('costs '), 7));
    expect(typeDollar(v.state, v.dispatch, v)).toBe(true);
    const par = v.state.doc.firstChild!;
    expect(par.childCount).toBe(2);
    expect(par.child(1).type.name).toBe('math_inline');
    expect(par.child(1).attrs.latex).toBe('');
    expect(pendingFocus.dollar).toBe('$');   // consumed by the node view when the field is focused
  });

  it('wraps a selection into the formula', () => {
    let s = stateWith(plainPar('let x be'), 5);
    s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, 5, 6)));
    const v = fakeView(s);
    expect(typeDollar(v.state, v.dispatch, v)).toBe(true);
    const par = v.state.doc.firstChild!;
    expect(par.child(1).type.name).toBe('math_inline');
    expect(par.child(1).attrs.latex).toBe('x');
    expect(par.textContent).toBe('let  be');
  });

  it('stays a character inside raw LaTeX (ERT), listings and code paragraphs', () => {
    const ert = schema.nodes.inset.create({ name: 'ERT', arg: '', status: 'open' }, [plainPar('\\foo', 'Plain Layout')]);
    const s = stateWith(schema.nodes.paragraph.create({ layout: 'Standard' }, [ert]), 3);
    expect(inRawText(s)).toBe(true);
    const v = fakeView(s);
    expect(typeDollar(v.state, v.dispatch, v)).toBe(false);
    expect(inRawText(stateWith(plainPar('x = 1', 'LyX-Code'), 2))).toBe(true);
    expect(inRawText(stateWith(plainPar('text'), 2))).toBe(false);
  });
});
