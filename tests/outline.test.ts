/**
 * Outline operations (packages/client/src/editor/outline.ts): moving a section among its siblings
 * takes its whole subtree along; promote / demote change every heading level in it.
 */
import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { schema } from '../packages/core/src/schema.ts';
import { moveSection, shiftSection, sectionAt, canMoveSection, canShiftSection } from '../packages/client/src/editor/outline.ts';
import { shiftLayout } from '../packages/client/src/editor/layouts.ts';

const par = (layout: string, text: string) => schema.nodes.paragraph.create({ layout }, schema.text(text));
const mk = (...pars: ReturnType<typeof par>[]) => schema.nodes.doc.create(null, pars);
const outline = (s: EditorState) => { const out: string[] = []; s.doc.forEach(n => out.push(`${n.attrs.layout}:${n.textContent}`)); return out; };
const stateAt = (doc: ReturnType<typeof mk>, text: string) => {
  let pos = 1;
  doc.descendants((n, p) => { if (n.isText && n.text === text) { pos = p + 1; return false; } return true; });
  return EditorState.create({ schema, doc, selection: TextSelection.create(doc, pos) });
};
const apply = (s: EditorState, cmd: ReturnType<typeof moveSection>) => { let out = s; const ok = cmd(s, tr => { out = s.apply(tr); }); return { ok, state: out }; };
const textAtCursor = (s: EditorState) => s.selection.$from.parent.textContent;

const doc = mk(
  par('Standard', 'intro'),
  par('Section', 'A'), par('Standard', 'a1'), par('Subsection', 'A.1'), par('Standard', 'a11'),
  par('Section', 'B'), par('Standard', 'b1'),
  par('Section', 'C'), par('Subsection', 'C.1'), par('Standard', 'c11'), par('Subsection', 'C.2'),
);
const ORIG = ['Standard:intro', 'Section:A', 'Standard:a1', 'Subsection:A.1', 'Standard:a11', 'Section:B', 'Standard:b1', 'Section:C', 'Subsection:C.1', 'Standard:c11', 'Subsection:C.2'];

describe('outline operations', () => {
  it('finds the section a position is in', () => {
    const s = stateAt(doc, 'a11');
    expect(sectionAt(s.doc, s.selection.from)).toEqual({ start: 3, end: 5, level: 2 });   // A.1, up to B
    expect(sectionAt(s.doc, 1)).toBeNull();                                                 // before any heading
    expect(sectionAt(s.doc, stateAt(doc, 'b1').selection.from)).toEqual({ start: 5, end: 7, level: 1 });
  });

  it('moves a section down / up with its subsections, the cursor staying in it', () => {
    const down = apply(stateAt(doc, 'a1'), moveSection(1));
    expect(down.ok).toBe(true);
    expect(outline(down.state)).toEqual(['Standard:intro', 'Section:B', 'Standard:b1', 'Section:A', 'Standard:a1', 'Subsection:A.1', 'Standard:a11', 'Section:C', 'Subsection:C.1', 'Standard:c11', 'Subsection:C.2']);
    expect(textAtCursor(down.state)).toBe('a1');
    const up = apply(stateAt(doc, 'b1'), moveSection(-1));
    expect(outline(up.state)).toEqual(outline(down.state));
    expect(textAtCursor(up.state)).toBe('b1');
    // back again
    const back = apply(down.state, moveSection(-1));
    expect(outline(back.state)).toEqual(ORIG);
    // among subsections: C.1 ↔ C.2
    const c = apply(stateAt(doc, 'c11'), moveSection(1));
    expect(outline(c.state).slice(7)).toEqual(['Section:C', 'Subsection:C.2', 'Subsection:C.1', 'Standard:c11']);
  });

  it('never leaves the parent: no sibling, no move', () => {
    const s = stateAt(doc, 'a11');                       // A.1 is the only subsection of A
    expect(canMoveSection(s, s.selection.from, 1)).toBe(false);
    expect(canMoveSection(s, s.selection.from, -1)).toBe(false);
    expect(apply(s, moveSection(1)).ok).toBe(false);
    const first = stateAt(doc, 'a1');                    // A is the first section
    expect(canMoveSection(first, first.selection.from, -1)).toBe(false);
    const last = stateAt(doc, 'C');
    expect(canMoveSection(last, last.selection.from, 1)).toBe(false);
    expect(apply(stateAt(doc, 'intro'), moveSection(1)).ok).toBe(false);   // not in a section
  });

  it('a section given by position (an outline item) moves without the cursor being in it', () => {
    const s = stateAt(doc, 'intro');
    let bPos = 0; s.doc.forEach((n, off) => { if (n.textContent === 'B') bPos = off + 1; });
    const r = apply(s, moveSection(-1, bPos));
    expect(outline(r.state).slice(0, 4)).toEqual(['Standard:intro', 'Section:B', 'Standard:b1', 'Section:A']);
  });

  it('promotes / demotes every heading of the section', () => {
    const demoted = apply(stateAt(doc, 'a1'), shiftSection(1));
    expect(outline(demoted.state).slice(1, 5)).toEqual(['Subsection:A', 'Standard:a1', 'Subsubsection:A.1', 'Standard:a11']);
    const promoted = apply(demoted.state, shiftSection(-1));
    expect(outline(promoted.state)).toEqual(ORIG);
    // starred headings keep their star; the ladder ends at Subparagraph
    const d2 = mk(par('Subparagraph*', 'x'), par('Standard', 'y'));
    const s2 = stateAt(d2, 'y');
    expect(canShiftSection(s2, s2.selection.from, 1)).toBe(false);
    expect(outline(apply(s2, shiftSection(-1)).state)[0]).toBe('Paragraph*:x');
  });

  it('skips heading layouts the class does not have (an article: Section promotes to Part)', () => {
    const article = [{ name: 'Part' }, { name: 'Section' }, { name: 'Subsection' }, { name: 'Subsubsection' }, { name: 'Paragraph' }, { name: 'Subparagraph' }];
    expect(shiftLayout('Section', -1, article)).toBe('Part');
    expect(shiftLayout('Section', -1)).toBe('Chapter');
    expect(shiftLayout('Part', -1, article)).toBeNull();
    expect(shiftLayout('Subsection*', 1)).toBe('Subsubsection*');
    const s = stateAt(doc, 'a1');
    expect(outline(apply(s, shiftSection(-1, undefined, article)).state)[1]).toBe('Part:A');
  });
});
