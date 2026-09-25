// @vitest-environment happy-dom
/**
 * Section folding (editor/plugins/fold.ts): a heading folds everything up to the next heading of
 * the same or a higher level; the fold is view state only (no document step), survives local
 * edits and a collaborator's change (y-prosemirror replaces the whole document, reusing the node
 * objects of unchanged paragraphs), and a cursor put into folded text unfolds it.
 */
import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { Slice, Fragment, type Node as PMNode } from 'prosemirror-model';
import { schema } from '@overlyx/core';
import { foldPlugin, foldKey, foldHeadings, setSectionFolded, setLevelFolded, foldAllSections, unfoldAllSections, sectionFoldState, foldedCount } from '../packages/client/src/editor/plugins/fold';

const par = (layout: string, text: string) => schema.node('paragraph', { layout }, text ? [schema.text(text)] : []);
/** Section A (with Subsection A1, A2), Section B, trailing text */
function doc(): PMNode {
  return schema.node('doc', null, [
    par('Standard', 'Intro'),
    par('Section', 'A'), par('Standard', 'a text'),
    par('Subsection', 'A1'), par('Standard', 'a1 text'),
    par('Subsection', 'A2'), par('Standard', 'a2 text'),
    par('Section*', 'B'), par('Standard', 'b text'),
  ]);
}
const posOf = (d: PMNode, text: string) => { let at = -1; d.forEach((c, off) => { if (at < 0 && c.textContent === text) at = off; }); return at; };
const hiddenTexts = (s: EditorState) => {
  const st = foldKey.getState(s)!;
  const out: string[] = [];
  s.doc.forEach((c, off) => { if (st.decos.find(off, off + c.nodeSize).some(d => (d as any).type?.attrs?.class === 'lyx-fold-hidden' && d.from === off)) out.push(c.textContent); });
  return out;
};
const run = (s: EditorState, cmd: (st: EditorState, d?: (tr: any) => void) => boolean) => { let next = s; const ok = cmd(s, tr => { next = s.apply(tr); }); return { ok, state: next }; };
function state(): EditorState { return EditorState.create({ doc: doc(), plugins: [foldPlugin()] }); }

describe('section folding', () => {
  it('finds each heading\'s section: up to the next heading of the same or a higher level', () => {
    const hs = foldHeadings(doc());
    expect(hs.map(h => [h.node.textContent, h.level, h.endIndex])).toEqual([['A', 1, 7], ['A1', 2, 5], ['A2', 2, 7], ['B', 1, 9]]);
  });

  it('folding a section hides its body (sub-sections included) and changes nothing in the document', () => {
    const s0 = state();
    const { ok, state: s1 } = run(s0, setSectionFolded(posOf(s0.doc, 'A'), true));
    expect(ok).toBe(true);
    expect(s1.doc.eq(s0.doc)).toBe(true);
    expect(hiddenTexts(s1)).toEqual(['a text', 'A1', 'a1 text', 'A2', 'a2 text']);
    expect(sectionFoldState(s1, posOf(s1.doc, 'A') + 1)).toEqual({ folded: true, foldable: true });
    const { state: s2 } = run(s1, setSectionFolded(posOf(s1.doc, 'A'), 'toggle'));
    expect(hiddenTexts(s2)).toEqual([]);
  });

  it('a cursor inside the section being folded moves to the end of its heading', () => {
    let s = state();
    s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, posOf(s.doc, 'a1 text') + 3)));
    const { state: s1 } = run(s, setSectionFolded(posOf(s.doc, 'A1'), true));
    const h = posOf(s1.doc, 'A1');
    expect(s1.selection.head).toBe(h + 1 + 'A1'.length);
    expect(foldedCount(s1)).toBe(1);
  });

  it('fold all folds every heading with a body; expand all opens them again', () => {
    const { state: s1 } = run(state(), foldAllSections);
    expect(foldedCount(s1)).toBe(4);
    expect(hiddenTexts(s1)).toEqual(['a text', 'A1', 'a1 text', 'A2', 'a2 text', 'b text']);
    const { state: s2 } = run(s1, unfoldAllSections);
    expect(foldedCount(s2)).toBe(0);
    expect(run(s2, unfoldAllSections).ok).toBe(false);
  });

  it('a selection put into folded text (find, the outline, a jump) unfolds the sections hiding it', () => {
    const { state: s1 } = run(state(), foldAllSections);
    const at = posOf(s1.doc, 'a2 text') + 2;
    const s2 = s1.apply(s1.tr.setSelection(TextSelection.create(s1.doc, at, at + 2)));
    expect(foldKey.getState(s2)!.folded).toEqual([posOf(s2.doc, 'A1'), posOf(s2.doc, 'B')]);   // A and A2 opened, A1 and B stay
    // a selection from visible text into a fold (Select All) keeps it
    const s3 = s1.apply(s1.tr.setSelection(TextSelection.create(s1.doc, 1, s1.doc.content.size - 1)));
    expect(foldedCount(s3)).toBe(4);
  });

  it('the fold follows local edits above it and ends when the heading stops being one', () => {
    let { state: s } = run(state(), setSectionFolded(posOf(doc(), 'B'), true));
    s = s.apply(s.tr.insertText('More ', 1));   // typing in the intro shifts B
    expect(foldKey.getState(s)!.folded).toEqual([posOf(s.doc, 'B')]);
    s = s.apply(s.tr.insertText('!', posOf(s.doc, 'B') + 2));   // editing the heading itself
    expect(foldKey.getState(s)!.folded).toEqual([posOf(s.doc, 'B!')]);
    s = s.apply(s.tr.setNodeMarkup(posOf(s.doc, 'B!'), undefined, { ...s.doc.nodeAt(posOf(s.doc, 'B!'))!.attrs, layout: 'Standard' }));
    expect(foldedCount(s)).toBe(0);
  });

  it('survives a collaborator\'s change, which replaces the whole document (unchanged paragraphs keep their node objects)', () => {
    let { state: s } = run(state(), setSectionFolded(posOf(doc(), 'A2'), true));
    // what y-prosemirror does: every top-level node reused except the changed one, all replaced at once
    const kids: PMNode[] = [];
    s.doc.forEach(c => kids.push(c.textContent === 'Intro' ? par('Standard', 'Intro, edited remotely') : c));
    s = s.apply(s.tr.replace(0, s.doc.content.size, new Slice(Fragment.from(kids), 0, 0)));
    expect(foldKey.getState(s)!.folded).toEqual([posOf(s.doc, 'A2')]);
    // a recreated heading with the same layout and text is found again too
    const kids2: PMNode[] = [];
    s.doc.forEach(c => kids2.push(c.textContent === 'A2' ? par('Subsection', 'A2') : c));
    s = s.apply(s.tr.replace(0, s.doc.content.size, new Slice(Fragment.from(kids2), 0, 0)));
    expect(foldKey.getState(s)!.folded).toEqual([posOf(s.doc, 'A2')]);
    expect(hiddenTexts(s)).toEqual(['a2 text']);
  });

  it('folds and expands every heading of a level (all subsections), from a heading or from text in its section', () => {
    const s0 = state();
    const { ok, state: s1 } = run(s0, setLevelFolded(posOf(s0.doc, 'a1 text') + 2, true));   // the cursor in A1's text: level of A1
    expect(ok).toBe(true);
    expect(foldKey.getState(s1)!.folded).toEqual([posOf(s1.doc, 'A1'), posOf(s1.doc, 'A2')]);
    expect(hiddenTexts(s1)).toEqual(['a1 text', 'a2 text']);
    expect(run(s1, setLevelFolded(posOf(s1.doc, 'A2'), true)).ok).toBe(false);   // nothing left to fold at that level
    // expanding the sections' level leaves the subsections folded
    const { state: s2 } = run(s1, setSectionFolded(posOf(s1.doc, 'A'), true));
    const { state: s3 } = run(s2, setLevelFolded(posOf(s2.doc, 'B'), false));
    expect(foldKey.getState(s3)!.folded).toEqual([posOf(s3.doc, 'A1'), posOf(s3.doc, 'A2')]);
    const { state: s4 } = run(s3, setLevelFolded(posOf(s3.doc, 'A1'), false));
    expect(foldedCount(s4)).toBe(0);
  });

  it('an empty section cannot be folded', () => {
    const d = schema.node('doc', null, [par('Section', 'X'), par('Section', 'Y'), par('Standard', 'y')]);
    const s = EditorState.create({ doc: d, plugins: [foldPlugin()] });
    expect(run(s, setSectionFolded(0, true)).ok).toBe(false);
    expect(sectionFoldState(s, 1)).toEqual({ folded: false, foldable: false });
  });
});
