// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../packages/client/src/deliverable/runtime/math', () => ({ typeset: vi.fn(), untypeset: vi.fn() }));
vi.mock('../packages/client/src/deliverable/runtime/env', () => ({ post: vi.fn() }));
vi.mock('../packages/client/src/deliverable/runtime/cite', () => ({ refreshCites: vi.fn() }));
import { insertRefChip, unchip } from '../packages/client/src/deliverable/runtime/mathedit';

afterEach(() => { getSelection()?.removeAllRanges(); document.body.replaceChildren(); });

function collapse(node: Node, offset = 0) {
  const range = document.createRange(); range.setStart(node, offset); range.collapse(true);
  getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
}

function fixture(source: string, kind: 'citation' | 'reference' | 'formula') {
  const editing = document.createElement('p'); editing.contentEditable = 'true';
  const chip = document.createElement('span'); chip.contentEditable = 'false';
  chip.className = kind === 'formula' ? 'ol-mathchip' : `ol-refchip ${kind === 'citation' ? 'ol-citechip' : 'ol-tex'}`;
  chip.dataset.olSrc = source;
  if (kind === 'formula') { chip.dataset.olTex = 'x^{2}'; chip.dataset.olSrcTex = 'x^{2}'; chip.dataset.olDelim = '('; }
  const label = document.createTextNode(kind === 'citation' ? '[1]' : '(1)');
  chip.append(label); editing.append('Known ', chip); document.body.append(editing);
  return { editing, chip, label };
}

it('a reference inserted after native End inside a citation survives serialization beside it', () => {
  const { editing, chip, label } = fixture('\\citep{knuth84}', 'citation');
  collapse(label, label.length);
  insertRefChip(editing, '\\eqref{eq:sum}');
  const nested = !!chip.querySelector('.ol-refchip');
  const adjacent = editing.querySelectorAll(':scope > .ol-refchip').length;
  unchip(editing);
  expect(editing.innerHTML).toBe('Known \\citep{knuth84}\\eqref{eq:sum}');
  expect(nested).toBe(false);
  expect(adjacent).toBe(2);
});

it('a citation inserted from an existing reference SVG preserves both source commands', () => {
  const { editing, chip } = fixture('\\eqref{eq:first}', 'reference');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS(svg.namespaceURI, 'use'); svg.append(use); chip.replaceChildren(svg);
  collapse(use);
  insertRefChip(editing, '\\citep{knuth84}');
  const nested = !!chip.querySelector('.ol-refchip');
  unchip(editing);
  expect(editing.innerHTML).toBe('Known \\eqref{eq:first}\\citep{knuth84}');
  expect(nested).toBe(false);
});

it('picker insertion treats a generated formula as atomic too', () => {
  const { editing, chip } = fixture('\\(x^{2}\\)', 'formula');
  collapse(chip, chip.childNodes.length);
  insertRefChip(editing, '\\eqref{eq:sum}');
  const nested = !!chip.querySelector('.ol-refchip');
  unchip(editing);
  expect(editing.innerHTML).toBe('Known \\(x^{2}\\)\\eqref{eq:sum}');
  expect(nested).toBe(false);
});

it('keeps a valid prose caret at its original position', () => {
  const editing = document.createElement('p'); editing.contentEditable = 'true';
  editing.textContent = 'Before after'; document.body.append(editing);
  collapse(editing.firstChild!, 7);
  insertRefChip(editing, '\\eqref{eq:sum}'); unchip(editing);
  expect(editing.innerHTML).toBe('Before \\eqref{eq:sum}after');
});

it('replaces a normal prose selection without moving it to the end', () => {
  const editing = document.createElement('p'); editing.contentEditable = 'true';
  editing.textContent = 'Before selected after'; document.body.append(editing);
  const range = document.createRange(); range.setStart(editing.firstChild!, 7); range.setEnd(editing.firstChild!, 15);
  getSelection()!.addRange(range);
  insertRefChip(editing, '\\eqref{eq:sum}'); unchip(editing);
  expect(editing.innerHTML).toBe('Before \\eqref{eq:sum} after');
});
