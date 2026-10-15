// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../packages/client/src/deliverable/runtime/math', () => ({ typeset: vi.fn(), untypeset: vi.fn() }));
vi.mock('../packages/client/src/deliverable/runtime/env', () => ({ post: vi.fn() }));
import { recoverChipCaret } from '../packages/client/src/deliverable/runtime/mathedit';

afterEach(() => { getSelection()?.removeAllRanges(); document.body.replaceChildren(); });

function fixture(kind = 'ol-mathchip') {
  const editing = document.createElement('p');
  editing.contentEditable = 'true';
  const chip = document.createElement('span');
  chip.className = kind;
  chip.contentEditable = 'false';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS(svg.namespaceURI, 'use');
  svg.append(use); chip.append(svg); editing.append('Before ', chip, ' after');
  document.body.append(editing);
  return { editing, chip, use };
}

function collapse(node: Node, offset = 0) {
  const range = document.createRange(); range.setStart(node, offset); range.collapse(true);
  getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
}

it('recovers an End caret inside generated math SVG to the following prose boundary', () => {
  const { editing, use } = fixture(); collapse(use);
  expect(recoverChipCaret(editing, 'after')).toBe(true);
  expect(getSelection()!.anchorNode).toBe(editing);
  expect(getSelection()!.anchorOffset).toBe(2);
  expect(getSelection()!.isCollapsed).toBe(true);
});

it('can recover to the preceding boundary for Delete/right-arrow navigation', () => {
  const { editing, use } = fixture(); collapse(use);
  expect(recoverChipCaret(editing, 'before')).toBe(true);
  expect(getSelection()!.anchorNode).toBe(editing);
  expect(getSelection()!.anchorOffset).toBe(1);
});

it('also treats reference chips as atomic instead of typing into their generated SVG', () => {
  const { editing, use } = fixture('ol-refchip'); collapse(use);
  expect(recoverChipCaret(editing, 'after')).toBe(true);
  expect(getSelection()!.anchorNode).toBe(editing);
  expect(getSelection()!.anchorOffset).toBe(2);
});

it('does not move a valid prose caret or an already valid chip boundary', () => {
  const { editing } = fixture(); const text = editing.firstChild!;
  collapse(text, 3); expect(recoverChipCaret(editing, 'after')).toBe(false);
  expect(getSelection()!.anchorNode).toBe(text); expect(getSelection()!.anchorOffset).toBe(3);
  collapse(editing, 2); expect(recoverChipCaret(editing, 'before')).toBe(false);
  expect(getSelection()!.anchorOffset).toBe(2);
});

it('leaves noncollapsed selections and a different editing object untouched', () => {
  const { editing, use } = fixture();
  const range = document.createRange(); range.setStart(editing.firstChild!, 1); range.setEnd(use, 0);
  getSelection()!.addRange(range); expect(recoverChipCaret(editing, 'after')).toBe(false);
  const other = document.createElement('p'); document.body.append(other);
  collapse(use); expect(recoverChipCaret(other, 'after')).toBe(false);
  expect(getSelection()!.anchorNode).toBe(use);
});

it('does not act on a detached source/rendering chip', () => {
  const { editing, use } = fixture(); collapse(use); editing.remove();
  expect(recoverChipCaret(editing, 'after')).toBe(false);
});
