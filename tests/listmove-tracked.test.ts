// @vitest-environment happy-dom
/**
 * A list item moved while changes are tracked (editor/listmove.ts through plugins/changes.ts): as LyX
 * records a move — the item struck through where it was, inserted where it went; a depth change at
 * its own place (dragged right, dropped where it is) is not a tracked change, like Tab.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { schema } from '../packages/core/src/schema.ts';
import { changeTrackingPlugin, changeOf } from '../packages/client/src/editor/plugins/changes.ts';
import { editorContext } from '../packages/client/src/editor/context.ts';
import { listUnitAt, moveUnit, childPos } from '../packages/client/src/editor/listmove.ts';

const LIST: [string, number, string][] = [['Itemize', 0, 'a'], ['Itemize', 1, 'a1'], ['Itemize', 0, 'b'], ['Itemize', 0, 'c']];
function mk() {
  const doc = schema.nodes.doc.create(null, LIST.map(([layout, depth, text]) => schema.nodes.paragraph.create({ layout, depth }, schema.text(text))));
  return EditorState.create({ doc, plugins: [changeTrackingPlugin()] });
}
const unit = (s: EditorState, i: number) => listUnitAt(s.doc, childPos({ parent: s.doc, start: 0 }, i) + 1)!;
const rows = (s: EditorState) => {
  const out: string[] = [];
  s.doc.forEach(n => { const ch = n.firstChild ? changeOf(n.firstChild) : null; out.push(`${n.textContent}${ch ? ':' + ch.type : ''}`); });
  return out;
};

describe('moving a list item while tracking changes', () => {
  beforeEach(() => { editorContext.trackChanges = true; editorContext.changeAuthorId = 7; });
  afterEach(() => { editorContext.trackChanges = false; });

  it('is a deletion where it was and an insertion where it went (one transaction)', () => {
    const s = mk();
    const s2 = s.applyTransaction(moveUnit(s, unit(s, 3), { gap: 0, depth: 0 })!).state;
    expect(rows(s2)).toEqual(['c:inserted', 'a', 'a1', 'b', 'c:deleted']);
  });
  it('an item with sub-items: all of them', () => {
    const s = mk();
    const s2 = s.applyTransaction(moveUnit(s, unit(s, 0), { gap: 4, depth: 0 })!).state;
    expect(rows(s2)).toEqual(['a:deleted', 'a1:deleted', 'b', 'c', 'a:inserted', 'a1:inserted']);
  });
  it('only deeper at its own place: no tracked change', () => {
    const s = mk();
    const s2 = s.applyTransaction(moveUnit(s, unit(s, 2), { gap: 2, depth: 1 })!).state;
    expect(rows(s2)).toEqual(['a', 'a1', 'b', 'c']);
    expect(s2.doc.child(2).attrs.depth).toBe(1);
  });
});
