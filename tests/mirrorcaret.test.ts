/**
 * The source pane's mirrored selection in the document (client editor/plugins/mirrorcaret.ts): it maps
 * through edits, and an edit that swallows it (the source pane replaces a whole stretch) leaves the
 * caret instead of tinting everything it replaced.
 */
import { describe, it, expect } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { schema } from '../packages/core/src/schema.ts';
import { mirrorCaretPlugin, mirrorCaretKey } from '../packages/client/src/editor/plugins/mirrorcaret.ts';

const par = (t: string) => schema.nodes.paragraph.create({ layout: 'Standard' }, schema.text(t));
const make = () => EditorState.create({ doc: schema.nodes.doc.create(null, [par('Alpha bravo charlie.'), par('Delta echo.')]), plugins: [mirrorCaretPlugin()] });

describe('mirror caret', () => {
  it('keeps the range through an edit beside it', () => {
    let s = make();
    s = s.apply(s.tr.setMeta(mirrorCaretKey, { from: 7, to: 12, head: 12 }));
    s = s.apply(s.tr.insertText('X', 2));
    expect(mirrorCaretKey.getState(s)).toEqual({ from: 8, to: 13, head: 13 });
  });
  it('collapses to the caret when an edit replaces the range', () => {
    let s = make();
    s = s.apply(s.tr.setMeta(mirrorCaretKey, { from: 7, to: 12, head: 12 }));
    // the source pane's apply: the whole document replaced
    s = s.apply(s.tr.replaceWith(0, s.doc.content.size, [par('Alpha bravo charlie!'), par('Delta echo.')]));
    const m = mirrorCaretKey.getState(s)!;
    expect(m.from).toBe(m.to);
    expect(m.head).toBe(m.from);
  });
});
