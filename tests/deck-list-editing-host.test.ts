// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest';
import { replaceEditingHost, editingTextStyle, carryEditingTextStyle } from '../packages/client/src/deliverable/runtime/editinghost';

afterEach(() => { getSelection()?.removeAllRanges(); document.body.replaceChildren(); });

function fixture(tag = 'p') {
  const host = document.createElement(tag);
  host.setAttribute('contenteditable', 'true');
  host.className = 'sub ol-notex';
  host.setAttribute('data-ol-editing', '');
  host.style.cssText = 'position:absolute;left:100px;top:150px;width:1000px;font:32px sans-serif';
  const text = document.createTextNode('Before Ω 😀 after'); host.append(text);
  document.body.append(host); host.focus();
  return { host, text };
}

it('promotes a focused paragraph to a block host without losing its Unicode caret', () => {
  const { host, text } = fixture(); getSelection()!.collapse(text, text.length);
  const next = replaceEditingHost(host, 'div');
  expect(next.localName).toBe('div'); expect(next.firstChild).toBe(text);
  expect(document.activeElement).toBe(next);
  expect(getSelection()!.anchorNode).toBe(text); expect(getSelection()!.anchorOffset).toBe(text.length);
  expect(next.getAttribute('style')).toBe(host.getAttribute('style'));
  expect(next.className).toBe(host.className); expect(next.hasAttribute('data-ol-editing')).toBe(true);
});

it('preserves a backwards selection and maps host-level endpoints to the new host', () => {
  const { host, text } = fixture('h2');
  getSelection()!.setBaseAndExtent(text, 12, host, 0);
  const next = replaceEditingHost(host, 'div');
  expect(getSelection()!.anchorNode).toBe(text); expect(getSelection()!.anchorOffset).toBe(12);
  expect(getSelection()!.focusNode).toBe(next); expect(getSelection()!.focusOffset).toBe(0);
  expect(getSelection()!.isCollapsed).toBe(false);
});

it('moves an existing formula chip instead of cloning its source-linked descendants', () => {
  const { host } = fixture(); const chip = document.createElement('span');
  chip.className = 'ol-mathchip'; chip.contentEditable = 'false'; chip.dataset.olChip = '7'; host.append(chip);
  getSelection()!.collapse(host, 2);
  const next = replaceEditingHost(host, 'div');
  expect(next.lastChild).toBe(chip); expect(getSelection()!.anchorNode).toBe(next);
  expect(getSelection()!.anchorOffset).toBe(2);
});

it('does not steal focus or another text box selection', () => {
  const { host } = fixture(); const other = document.createElement('div'); other.contentEditable = 'true'; other.textContent = 'Elsewhere';
  document.body.append(other); other.focus(); getSelection()!.collapse(other.firstChild!, 3);
  replaceEditingHost(host, 'div');
  expect(document.activeElement).toBe(other); expect(getSelection()!.anchorNode).toBe(other.firstChild);
  expect(getSelection()!.anchorOffset).toBe(3);
});

it('can restore the original tag after a rejected command without dropping content', () => {
  const { host, text } = fixture(); getSelection()!.collapse(text, 7);
  const promoted = replaceEditingHost(host, 'div'); const restored = replaceEditingHost(promoted, 'p');
  expect(restored.textContent).toBe('Before Ω 😀 after'); expect(restored.firstChild).toBe(text);
  expect(restored.localName).toBe('p'); expect(getSelection()!.anchorNode).toBe(text);
  expect(getSelection()!.anchorOffset).toBe(7); expect(document.activeElement).toBe(restored);
});

it('carries heading-selector typography to the valid list host', () => {
  const theme = document.createElement('style');
  theme.textContent = 'body{font:24px Arial;color:#222}h1{font:600 48px/1.2 Georgia;color:#001f3f}';
  document.body.append(theme);
  const { host } = fixture('h1'); host.style.removeProperty('font');
  const before = editingTextStyle(host);
  expect(before['font-size']).toBe('48px');
  const next = replaceEditingHost(host, 'div');
  const carried = carryEditingTextStyle(next, before);
  expect(carried['font-size']).toBe('48px'); expect(carried['font-weight']).toBe('600');
  expect(editingTextStyle(next)).toEqual(before);
});

it('does not freeze typography that remains inherited through a tag conversion', () => {
  const { host } = fixture(); const before = editingTextStyle(host);
  const next = replaceEditingHost(host, 'div');
  expect(carryEditingTextStyle(next, before)).toEqual({});
  expect(next.getAttribute('style')).toBe(host.getAttribute('style'));
});

it('keeps explicit colour and geometry while carrying only lost heading properties', () => {
  const theme = document.createElement('style'); theme.textContent = 'h2{font:600 48px/1.2 Georgia;color:navy}';
  document.body.append(theme);
  const { host } = fixture('h2'); host.style.removeProperty('font'); host.style.color = 'red';
  const before = editingTextStyle(host);
  const next = replaceEditingHost(host, 'div');
  const carried = carryEditingTextStyle(next, before);
  expect(carried).not.toHaveProperty('color'); expect(next.style.color).toBe('red');
  expect(next.style.left).toBe('100px'); expect(next.style.width).toBe('1000px');
  expect(editingTextStyle(next)).toEqual(before);
});
