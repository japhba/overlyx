// @vitest-environment happy-dom
/**
 * A slide's list items moved by drag and drop (deliverable/runtime/listdrag.ts): the operations it
 * sends — `move` into another list or a nested one; out of a nested list that is left empty, the list
 * removed and the item inserted (one commit, splices that do not overlap) — and how the pointer picks
 * between places at the same height (the end of a nested list and the outer list's next place).
 */
import { describe, it, expect } from 'vitest';
import { applyOp, parseSource, elementAt } from '../packages/core/src/html/source.ts';
import { rebasedSplices, applyTo } from '../packages/client/src/deliverable/sourceops.ts';
import { pick, type Target } from '../packages/client/src/deliverable/runtime/listdrag.ts';

const HTML = `<html><head></head><body>
<div id="t">
  <ul>
    <li>one</li>
    <li>two
      <ul>
        <li>two a</li>
      </ul>
    </li>
    <li>three</li>
  </ul>
</div>
</body></html>`;
// paths from <html>: body = [1], div = [1,0], outer ul = [1,0,0], its items [1,0,0,k], the nested ul [1,0,0,1,0]
const items = (text: string) => Array.from(text.matchAll(/<li>([a-z ]+?)\s*(?=<)/g)).map(m => m[1].trim());

describe('list items moved on a slide', () => {
  it('a move within the list', () => {
    const out = applyOp(HTML, { t: 'move', path: [1, 0, 0, 2], parent: [1, 0, 0], index: 0 });
    expect(items(out)).toEqual(['three', 'one', 'two', 'two a']);
  });
  it('a move into a nested list', () => {
    const out = applyOp(HTML, { t: 'move', path: [1, 0, 0, 0], parent: [1, 0, 0, 1, 0], index: 1 });
    expect(items(out)).toEqual(['two', 'two a', 'one', 'three']);
    expect(out).toMatch(/<li>two a<\/li>\s*<li>one<\/li>\s*<\/ul>/);
  });
  it('out of a nested list left empty: the list goes, the item is inserted — one commit, no overlap', () => {
    const src = parseSource(HTML);
    const li = elementAt(src.doc, [1, 0, 0, 1, 0, 0])!;
    expect(li).toBeTruthy();
    const html = HTML.slice(li.sourceCodeLocation!.startOffset, li.sourceCodeLocation!.endOffset);
    const splices = rebasedSplices(HTML, HTML, [{ t: 'remove', paths: [[1, 0, 0, 1, 0]] }, { t: 'insert', parent: [1, 0, 0], index: 0, html }])!;
    expect(splices).toHaveLength(2);
    const out = applyTo(HTML, splices);
    expect(items(out)).toEqual(['two a', 'one', 'two', 'three']);
    expect(out).not.toMatch(/<ul>\s*<\/ul>/);
  });
});

describe('the place under the pointer', () => {
  const list = {} as HTMLElement, nested = {} as HTMLElement;
  const t = (l: HTMLElement, y: number, x: number): Target => ({ list: l, before: null, y, x, right: 900 });
  const targets = [t(list, 100, 50), t(list, 200, 50), t(nested, 199, 90), t(list, 300, 50)];
  it('the nearest line', () => {
    expect(pick(targets, 60, 110, 1)).toBe(targets[0]);
    expect(pick(targets, 60, 290, 1)).toBe(targets[3]);
  });
  it('at about the same height: the innermost list the pointer is right of', () => {
    expect(pick(targets, 120, 201, 1)).toBe(targets[2]);
    expect(pick(targets, 40, 201, 1)).toBe(targets[1]);
  });
});
