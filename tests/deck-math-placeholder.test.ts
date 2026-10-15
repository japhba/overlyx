// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { chipText, unchip } from '../packages/client/src/deliverable/runtime/mathedit.ts';
import { parseSource, opSplices, applySplices } from '../packages/core/src/html/source.ts';

function chip(tex: string, source: string | null, originalTex = tex): HTMLSpanElement {
  const element = document.createElement('span');
  element.className = 'ol-mathchip';
  element.dataset.olTex = tex;
  element.dataset.olDelim = '[';
  if (source !== null) { element.dataset.olSrc = source; element.dataset.olSrcTex = originalTex; }
  return element;
}

it('retains an original empty Formula placeholder in the before snapshot', () => {
  const empty = chip('', '\\[ \\]');
  expect(chipText(empty)).toBe('\\[ \\]');
  const root = document.createElement('div'); root.append(empty);
  unchip(root);
  expect(root.innerHTML).toBe('\\[ \\]');
});

it('typing into a new Formula replaces the placeholder instead of appending a second display', () => {
  const element = chip('', '\\[ \\]');
  const before = chipText(element);
  element.dataset.olTex = 'x^{2}';
  const html = '<html><head></head><body><section class="slide"><div>\\[ \\]</div></section></body></html>';
  const output = applySplices(html, opSplices(parseSource(html), { t: 'inner', path: [1, 0, 0], before, html: chipText(element) }));
  expect(output).toContain('<div>\\[ x^{2} \\]</div>');
  expect(output).not.toContain('\\[ \\]\\[');
});

it('does not resurrect a nonempty formula cleared by its author or create text for a new empty chip', () => {
  expect(chipText(chip('', '\\[ x^{2} \\]', 'x^{2}'))).toBe('');
  expect(chipText(chip('', null))).toBe('');
});
