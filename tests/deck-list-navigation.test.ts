// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest';
import * as navigation from '../packages/client/src/deliverable/runtime/textnavigation';

afterEach(() => { getSelection()?.removeAllRanges(); document.body.replaceChildren(); });
function box(html: string) {
  const root = document.createElement('div'); root.contentEditable = 'true'; root.innerHTML = html;
  document.body.append(root); root.focus(); getSelection()!.collapse(root, 0); return root;
}
function caret(node: Node, offset: number) {
  expect(getSelection()!.anchorNode).toBe(node); expect(getSelection()!.anchorOffset).toBe(offset);
  expect(getSelection()!.focusNode).toBe(node); expect(getSelection()!.focusOffset).toBe(offset);
  expect(getSelection()!.isCollapsed).toBe(true);
}

it('collapsed list End keeps the last item ready for a structural command', () => {
  const root = box('<ul><li>Classical</li><li>Quantum</li><li>Wave</li></ul>');
  const item = root.querySelector('li:last-child')!;
  expect(navigation.textBoundary(root, true, false)).toBe(true); caret(item, 1);
});
it('collapsed ordered-list Home keeps the first item ready for a structural command', () => {
  const root = box('<ol><li>First</li><li>Last</li></ol>'); const item = root.querySelector('li')!;
  navigation.textBoundary(root, false, false); caret(item, 0);
});
it('collapsed navigation also retains item context when the textbox itself is a list', () => {
  for (const tag of ['ul', 'ol']) {
    const root = document.createElement(tag); root.contentEditable = 'true'; root.innerHTML = '<li>First</li><li>Last</li>'; document.body.append(root);
    navigation.textBoundary(root, false, false); caret(root.firstElementChild!, 0);
    navigation.textBoundary(root, true, false); caret(root.lastElementChild!, 1);
  }
});
it('collapsed list End reaches the final nested item', () => {
  const root = box('<ul><li>First</li><li>Parent<ol><li>Inner</li><li id="last">Deep last</li></ol></li></ul>');
  navigation.textBoundary(root, true, false); caret(root.querySelector('#last')!, 1);
});
it('collapsed list Home reaches a leading nested item', () => {
  const root = box('<ol><li><ul><li id="first">Deep first</li><li>Inner last</li></ul>Tail</li><li>Last</li></ol>');
  navigation.textBoundary(root, false, false); caret(root.querySelector('#first')!, 0);
});
it('collapsed list edges stay inside empty items including a line-break placeholder', () => {
  const root = box('<ul><li id="first"></li><li>Middle</li><li id="last"><br></li></ul>');
  navigation.textBoundary(root, false, false); caret(root.querySelector('#first')!, 0);
  navigation.textBoundary(root, true, false); caret(root.querySelector('#last')!, 1);
});
it('collapsed list End after a noneditable formula keeps a host item boundary', () => {
  const root = box('<ul><li>First</li><li id="last">Energy<span contenteditable="false" class="ol-mathchip"><mjx-container><svg><g><use></use></g></svg></mjx-container></span></li></ul>');
  navigation.textBoundary(root, true, false); caret(root.querySelector('#last')!, 2);
  expect((getSelection()!.anchorNode as Element).closest('svg, mjx-container, .ol-mathchip')).toBeNull();
});
it('collapsed list navigation ignores formatting whitespace outside its edge', () => {
  const root = box(' \n<ul><li>First</li><li id="last">Last</li></ul> \n');
  navigation.textBoundary(root, true, false); caret(root.querySelector('#last')!, 1);
});
it('collapsed general edges keep their original root boundaries beside a list', () => {
  const root = box('<p>Before</p><ul><li>List</li></ul><span>After</span>');
  navigation.textBoundary(root, false, false); caret(root, 0);
  navigation.textBoundary(root, true, false); caret(root, 3);
});
it('Shift navigation preserves the anchor and whole textbox boundaries for lists', () => {
  const root = box('<ul><li>First</li><li>Last</li></ul>'), first = root.querySelector('li')!.firstChild!, last = root.querySelector('li:last-child')!.firstChild!;
  getSelection()!.collapse(first, 2); navigation.textBoundary(root, true, true);
  expect(getSelection()!.anchorNode).toBe(first); expect(getSelection()!.anchorOffset).toBe(2);
  expect(getSelection()!.focusNode).toBe(root); expect(getSelection()!.focusOffset).toBe(1);
  getSelection()!.collapse(last, 3); navigation.textBoundary(root, false, true);
  expect(getSelection()!.anchorNode).toBe(last); expect(getSelection()!.anchorOffset).toBe(3);
  expect(getSelection()!.focusNode).toBe(root); expect(getSelection()!.focusOffset).toBe(0);
});
it('Shift with a stale external anchor retains the existing collapsed root fallback', () => {
  const root = box('<ul><li>First</li><li>Last</li></ul>'), outside = document.createElement('p'); outside.textContent = 'Outside'; document.body.append(outside);
  getSelection()!.collapse(outside.firstChild!, 2); navigation.textBoundary(root, true, true); caret(root, 1);
});

it('list item lookup accepts an element anchor at the item itself', () => {
  const root = box('<ul><li>First</li><li id="last">Last</li></ul>'), item = root.querySelector('#last')!;
  expect(navigation.textListItem(root, item)).toBe(item);
});
it('list item lookup resolves the nearest nested item from its text', () => {
  const root = box('<ul><li>Outer<ul><li id="inner">Inner</li></ul></li></ul>'), item = root.querySelector('#inner')!;
  expect(navigation.textListItem(root, item.firstChild)).toBe(item);
});
it('list item lookup cannot indent an ancestor list outside the editing box', () => {
  const outside = document.createElement('ul'); outside.innerHTML = '<li><div id="box">Inner text</div></li>'; document.body.append(outside);
  const root = outside.querySelector('#box') as HTMLElement; root.contentEditable = 'true';
  expect(navigation.textListItem(root, root.firstChild)).toBeNull();
});
it('list item lookup rejects a stale caret in another textbox', () => {
  const root = box('<ul><li>Here</li></ul>'), other = box('<ul><li>Elsewhere</li></ul>');
  expect(navigation.textListItem(root, other.querySelector('li')!.firstChild)).toBeNull();
});
it('list item lookup rejects detached roots and non-list root edges', () => {
  const root = box('<ul><li>Item</li></ul>');
  expect(navigation.textListItem(root, root)).toBeNull(); const item = root.querySelector('li')!;
  root.remove(); expect(navigation.textListItem(root, item)).toBeNull();
});
