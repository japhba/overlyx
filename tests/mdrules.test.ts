/**
 * Markdown-style layout triggers (packages/client/src/editor/plugins/mdrules.ts): `- ` at the
 * start of a Standard paragraph makes it a bullet, `1. ` a numbered item, `# ` a heading; the
 * marker is removed. Nothing happens mid-paragraph, in a heading, or for a layout the document
 * class does not have. Exercised through the plugin's handleTextInput, as the view would.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { undoInputRule } from 'prosemirror-inputrules';
import { schema } from '../packages/core/src/schema.ts';
import { markdownRulesPlugin, headingForHashes } from '../packages/client/src/editor/plugins/mdrules.ts';
import { editorContext } from '../packages/client/src/editor/context.ts';

const plugin = markdownRulesPlugin();

function setup(text: string, layout = 'Standard', cursor?: number) {
  const par = schema.nodes.paragraph.create({ layout }, text ? [schema.text(text)] : []);
  let state = EditorState.create({ doc: schema.nodes.doc.create(null, [par]), plugins: [plugin] });
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, cursor ?? 1 + text.length)));
  const view = { state, dispatch(tr: any) { view.state = view.state.apply(tr); }, composing: false };
  return view;
}
/** type one character at the cursor the way the browser would (handleTextInput first, else insert) */
function type(view: ReturnType<typeof setup>, ch: string): boolean {
  const { from, to } = view.state.selection;
  const handled = plugin.props.handleTextInput!.call(plugin, view as any, from, to, ch) as boolean;
  if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to));
  return handled;
}
const layoutOf = (view: ReturnType<typeof setup>) => view.state.doc.firstChild!.attrs.layout;
const textOf = (view: ReturnType<typeof setup>) => view.state.doc.firstChild!.textContent;

describe('markdown layout triggers', () => {
  beforeEach(() => { editorContext.meta = null; });

  it('"- " and "* " start a bullet list, the marker disappears', () => {
    for (const m of ['-', '*']) {
      const v = setup(m);
      expect(type(v, ' ')).toBe(true);
      expect(layoutOf(v)).toBe('Itemize');
      expect(textOf(v)).toBe('');
    }
  });

  it('"1. " and "1) " start a numbered list; other numbers do not', () => {
    const v = setup('1.'); type(v, ' ');
    expect(layoutOf(v)).toBe('Enumerate');
    const w = setup('1)'); type(w, ' ');
    expect(layoutOf(w)).toBe('Enumerate');
    const x = setup('2.'); expect(type(x, ' ')).toBe(false);
    expect(layoutOf(x)).toBe('Standard'); expect(textOf(x)).toBe('2. ');
  });

  it('# … ###### become headings of the class (article: # = Section; book: # = Chapter)', () => {
    const v = setup('#'); type(v, ' ');
    expect(layoutOf(v)).toBe('Chapter');   // no class known: the full ladder
    editorContext.meta = { layouts: [{ name: 'Standard' }, { name: 'Section' }, { name: 'Subsection' }, { name: 'Subsubsection' }, { name: 'Itemize' }] } as never;
    const a = setup('#'); type(a, ' '); expect(layoutOf(a)).toBe('Section');
    const b = setup('##'); type(b, ' '); expect(layoutOf(b)).toBe('Subsection');
    const c = setup('####'); expect(type(c, ' ')).toBe(false);   // the class has nothing that deep
    expect(headingForHashes(1, [{ name: 'Chapter' }, { name: 'Section' }] as never)).toBe('Chapter');
    expect(headingForHashes(3, [{ name: 'Section' }] as never)).toBeNull();
  });

  it('a layout the class lacks is left alone (Enumerate missing → "1. " stays text)', () => {
    editorContext.meta = { layouts: [{ name: 'Standard' }, { name: 'Itemize' }] } as never;
    const v = setup('1.'); expect(type(v, ' ')).toBe(false);
    expect(textOf(v)).toBe('1. ');
    const w = setup('-'); expect(type(w, ' ')).toBe(true);
    expect(layoutOf(w)).toBe('Itemize');
  });

  it('only at the very start of a Standard / Plain paragraph', () => {
    const mid = setup('see -'); expect(type(mid, ' ')).toBe(false);
    const head = setup('-', 'Section'); expect(type(head, ' ')).toBe(false);
    expect(layoutOf(head)).toBe('Section');
    const item = setup('-', 'Itemize'); expect(type(item, ' ')).toBe(false);
    const plain = setup('-', 'Plain Layout'); expect(type(plain, ' ')).toBe(true);
    expect(layoutOf(plain)).toBe('Itemize');
    // the cursor at the start of a paragraph that already has text: the rest becomes the item
    const before = setup('-rest', 'Standard', 2); expect(type(before, ' ')).toBe(true);
    expect(layoutOf(before)).toBe('Itemize'); expect(textOf(before)).toBe('rest');
  });

  it('Backspace right after the trigger restores the marker and the layout (undoInputRule)', () => {
    const v = setup('-'); type(v, ' ');
    expect(layoutOf(v)).toBe('Itemize');
    expect(undoInputRule(v.state, v.dispatch)).toBe(true);
    expect(layoutOf(v)).toBe('Standard');
    expect(textOf(v)).toBe('- ');
  });
});
