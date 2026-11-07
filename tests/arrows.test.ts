/**
 * Arrows typed as text (packages/client/src/editor/plugins/arrows.ts): -> →, <- ←, --> ⟶, <-- ⟵;
 * ⌘Z or Backspace right after gives the typed characters back, and they then stay as typed.
 */
import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state';
import { history, undo } from 'prosemirror-history';
import { schema } from '../packages/core/src/schema.ts';
import { arrowsPlugin, arrowFor } from '../packages/client/src/editor/plugins/arrows.ts';
import { undoGroupsPlugin } from '../packages/client/src/editor/plugins/undogroups.ts';
import { parseTex, writeTex } from '../packages/core/src/tex/index.ts';
import { LYX_LAYOUTS } from './lyxlib';

/** a stand-in for the view: what the plugin's props use of it */
function editor(text: string, layout = 'Standard') {
  const plugin = arrowsPlugin();
  const doc = schema.nodes.doc.create(null, [schema.nodes.paragraph.create({ layout }, text ? schema.text(text) : undefined)]);
  let state = EditorState.create({ schema, doc, plugins: [undoGroupsPlugin(), history({ newGroupDelay: 500 }), plugin] });
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, state.doc.content.size - 1)));
  const view = {
    get state() { return state; },
    dispatch(tr: Transaction) { state = state.apply(tr); },
  };
  const type = (s: string) => {
    for (const ch of s) {
      const { from, to } = state.selection;
      const deflt = () => state.tr.insertText(ch, from, to);
      if (!plugin.props.handleTextInput!.call(plugin, view as any, from, to, ch, deflt)) view.dispatch(deflt());
    }
  };
  const backspace = () => {
    const ev = { key: 'Backspace', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false } as KeyboardEvent;
    if (plugin.props.handleKeyDown!.call(plugin, view as any, ev)) return;
    const { from } = state.selection;
    view.dispatch(state.tr.delete(from - 1, from));
  };
  return { view, type, backspace, text: () => state.doc.textContent, undo: () => undo(state, view.dispatch) };
}

describe('arrowFor', () => {
  it('knows the arrows, longest first', () => {
    expect(arrowFor('a -', '>')).toEqual({ arrow: '→', length: 2 });
    expect(arrowFor('a--', '>')).toEqual({ arrow: '⟶', length: 3 });
    expect(arrowFor('a <', '-')).toEqual({ arrow: '←', length: 2 });
    expect(arrowFor('a ←', '-')).toEqual({ arrow: '⟵', length: 2 });
    expect(arrowFor('a ←', '>')).toEqual({ arrow: '↔', length: 2 });
    expect(arrowFor('a ⟵', '>')).toEqual({ arrow: '⟷', length: 2 });
    expect(arrowFor('a -', '-')).toBeNull();
    expect(arrowFor('<!-', '-')).toBeNull();
    expect(arrowFor('a b', '>')).toBeNull();
  });
});

describe('typing arrows', () => {
  it('turns -> <- --> <-- into arrows as they are typed', () => {
    const e = editor('');
    e.type('a -> b <- c --> d <-- e <-> f');
    expect(e.text()).toBe('a → b ← c ⟶ d ⟵ e ↔ f');
  });
  it('⌘Z gives the typed characters back, and they are not turned into an arrow again', () => {
    const e = editor('');
    e.type('x <-');
    expect(e.text()).toBe('x ←');
    e.undo();
    expect(e.text()).toBe('x <-');
    e.type('-');
    expect(e.text()).toBe('x <--');
    e.type(' y ->');
    expect(e.text()).toBe('x <-- y →');   // elsewhere it still works
  });
  it('Backspace right after gives back all the keys typed, and they stay', () => {
    const e = editor('');
    e.type('p <--');
    expect(e.text()).toBe('p ⟵');
    e.backspace();
    expect(e.text()).toBe('p <--');
    e.type('>');
    expect(e.text()).toBe('p <-->');
  });
  it('leaves code paragraphs alone', () => {
    const e = editor('', 'LyX-Code');
    e.type('a -> b');
    expect(e.text()).toBe('a -> b');
  });
});

describe('arrows in the .tex file', () => {
  it('are written so pdfLaTeX compiles them and read back as the characters typed', () => {
    const opts = { layoutDir: LYX_LAYOUTS, localDirs: [] };
    const doc = parseTex('\\documentclass{article}\n\\begin{document}\nA → B ← C ⟶ D ⟵ E ↔ F ⟷ G\n\\end{document}\n', opts).doc;
    const tex = writeTex(doc).text;
    expect(tex).toContain('A \\textrightarrow{} B \\textleftarrow{} C \\ensuremath{\\longrightarrow} D \\ensuremath{\\longleftarrow}');
    expect(JSON.stringify(parseTex(tex, opts).doc)).toContain('A → B ← C ⟶ D ⟵ E ↔ F ⟷ G');
  });
});
