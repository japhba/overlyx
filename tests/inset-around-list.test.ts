/**
 * Selected bullets moved into a note (commands.ts insertTextInset): the note takes the bullets' place
 * as a paragraph of its own. It used to go into the first bullet, which stayed as an empty item holding
 * it (`\item %` before `%% @note` in the .tex, an empty bullet in the PDF).
 */
import { describe, it, expect, vi } from 'vitest';
vi.hoisted(() => { const g = globalThis as any; if (typeof g.window === 'undefined') { g.window = g; /* MathJax reads navigator.appVersion (node's navigator has none) */ if (g.navigator && g.navigator.appVersion === undefined) Object.defineProperty(g.navigator, 'appVersion', { value: '', configurable: true }); } });
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../packages/core/src/schema.ts';
import { insertNote } from '../packages/client/src/editor/commands.ts';

const par = (layout: string, text: string, depth = 0) => schema.nodes.paragraph.create({ layout, depth }, schema.text(text));
const apply = (state: EditorState, cmd: (s: EditorState, d: (tr: any) => void) => boolean) => { let out = state; cmd(state, tr => { out = state.apply(tr); }); return out; };
/** A selection from the start of paragraph `a` to the end of paragraph `b` (indices into the doc). */
function select(doc: PMNode, a: number, b: number) {
  let from = 0, to = 0, pos = 0;
  doc.forEach((p, off, i) => { if (i === a) from = off + 1; if (i === b) to = off + 1 + p.content.size; pos = off; });
  return EditorState.create({ doc, selection: TextSelection.create(doc, from, to) });
}
const shape = (doc: PMNode): string => { const out: string[] = []; doc.forEach(p => { let s = `${p.attrs.layout}/${p.attrs.depth}:`; p.forEach(c => { s += c.type.name === 'inset' ? `[${c.attrs.arg} ${shape(c)}]` : c.textContent; }); out.push(s); }); return out.join(' | '); };

describe('a note around selected bullets', () => {
  it('replaces the bullets with a paragraph holding the note', () => {
    const doc = schema.nodes.doc.create(null, [par('Standard', 'Intro'), par('Itemize', 'one'), par('Itemize', 'two'), par('Standard', 'After')]);
    const st = apply(select(doc, 1, 2), insertNote('Note'));
    expect(shape(st.doc)).toBe('Standard/0:Intro | Standard/0:[Note Itemize/0:one | Itemize/0:two] | Standard/0:After');
    expect(st.selection.$from.parent.textContent).toBe('one');
  });
  it('keeps nested bullets nested in their parent item, their depths starting at 0 in the note', () => {
    const doc = schema.nodes.doc.create(null, [par('Itemize', 'parent'), par('Itemize', 'a', 1), par('Itemize', 'b', 2), par('Itemize', 'next')]);
    const st = apply(select(doc, 1, 2), insertNote('Note'));
    expect(shape(st.doc)).toBe('Itemize/0:parent | Standard/1:[Note Itemize/0:a | Itemize/1:b] | Itemize/0:next');
  });
  it('text selected across paragraphs still goes into the first one (LyX)', () => {
    const doc = schema.nodes.doc.create(null, [par('Itemize', 'one'), par('Itemize', 'two')]);
    const st = apply(EditorState.create({ doc, selection: TextSelection.create(doc, 2, 8) }), insertNote('Note'));
    expect(shape(st.doc)).toBe('Itemize/0:o[Note Itemize/0:ne | Itemize/0:tw]o');
  });
});
