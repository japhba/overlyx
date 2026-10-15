// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest';
import { textBoundary } from '../packages/client/src/deliverable/runtime/textnavigation';

afterEach(() => { getSelection()?.removeAllRanges(); document.body.replaceChildren(); });

function fixture() {
  const root = document.createElement('p'); root.contentEditable = 'true';
  const text = document.createTextNode('Shared baseline. A0😀 B0Ω B1Ω A1😀'); root.append(text);
  document.body.append(root); root.focus(); getSelection()!.collapse(text, 28);
  return { root, text };
}

it('moves the observed middle-of-Unicode caret to the actual textbox end', () => {
  const { root } = fixture(); expect(textBoundary(root, true, false)).toBe(true);
  expect(getSelection()!.anchorNode).toBe(root); expect(getSelection()!.anchorOffset).toBe(1);
  expect(getSelection()!.isCollapsed).toBe(true);
});

it('moves Home to the start without calculating code-point versus UTF-16 offsets', () => {
  const { root } = fixture(); textBoundary(root, false, false);
  expect(getSelection()!.anchorNode).toBe(root); expect(getSelection()!.anchorOffset).toBe(0);
});

it('extends from a collapsed End boundary back to Home', () => {
  const { root } = fixture();
  textBoundary(root, true, false);
  expect(getSelection()!.anchorNode).toBe(root);
  expect(getSelection()!.anchorOffset).toBe(1);
  expect(root.contains(root)).toBe(true);
  textBoundary(root, false, true);
  expect(getSelection()!.anchorNode).toBe(root);
  expect(getSelection()!.anchorOffset).toBe(1);
  expect(getSelection()!.focusNode).toBe(root);
  expect(getSelection()!.focusOffset).toBe(0);
  expect(getSelection()!.isCollapsed).toBe(false);
  expect(getSelection()!.toString()).toBe('Shared baseline. A0😀 B0Ω B1Ω A1😀');
});

it('extends from a collapsed Home boundary forward to End', () => {
  const { root } = fixture();
  textBoundary(root, false, false);
  expect(getSelection()!.anchorNode).toBe(root);
  expect(getSelection()!.anchorOffset).toBe(0);
  textBoundary(root, true, true);
  expect(getSelection()!.anchorNode).toBe(root);
  expect(getSelection()!.anchorOffset).toBe(0);
  expect(getSelection()!.focusNode).toBe(root);
  expect(getSelection()!.focusOffset).toBe(1);
  expect(getSelection()!.isCollapsed).toBe(false);
  expect(getSelection()!.toString()).toBe('Shared baseline. A0😀 B0Ω B1Ω A1😀');
});

it('Shift+End preserves the Unicode text anchor and extends to the end', () => {
  const { root, text } = fixture(); getSelection()!.collapse(text, 26);
  textBoundary(root, true, true);
  expect(getSelection()!.anchorNode).toBe(text); expect(getSelection()!.anchorOffset).toBe(26);
  expect(getSelection()!.focusNode).toBe(root); expect(getSelection()!.focusOffset).toBe(1);
  expect(getSelection()!.toString()).toBe('B1Ω A1😀');
});

it('Shift+Home retains a backwards anchor rather than reversing or collapsing it', () => {
  const { root, text } = fixture(); textBoundary(root, false, true);
  expect(getSelection()!.anchorNode).toBe(text); expect(getSelection()!.anchorOffset).toBe(28);
  expect(getSelection()!.focusNode).toBe(root); expect(getSelection()!.focusOffset).toBe(0);
  expect(getSelection()!.isCollapsed).toBe(false);
});

it('a final noneditable math chip has a host boundary, never an SVG endpoint', () => {
  const { root, text } = fixture(); const chip = document.createElement('span');
  chip.contentEditable = 'false'; chip.className = 'ol-mathchip';
  chip.innerHTML = '<mjx-container><svg><g><use></use></g></svg></mjx-container>'; root.append(chip);
  getSelection()!.collapse(text, 4); textBoundary(root, true, false);
  expect(getSelection()!.focusNode).toBe(root); expect(getSelection()!.focusOffset).toBe(2);
});

it('extends across nested blocks to the whole textbox boundary', () => {
  const { root } = fixture(); root.innerHTML = '<ul><li>First 😀</li><li>Last Ω</li></ul>';
  const text = root.querySelector('li')!.firstChild!; getSelection()!.collapse(text, 6);
  textBoundary(root, true, true);
  expect(getSelection()!.anchorNode).toBe(text); expect(getSelection()!.anchorOffset).toBe(6);
  expect(getSelection()!.focusNode).toBe(root); expect(getSelection()!.focusOffset).toBe(1);
});

it('does not extend a stale selection in a different object, or act on a detached root', () => {
  const { root } = fixture(); const other = document.createElement('p'); other.textContent = 'Elsewhere'; document.body.append(other);
  getSelection()!.collapse(other.firstChild!, 3); textBoundary(root, true, true);
  expect(getSelection()!.anchorNode).toBe(root); expect(getSelection()!.isCollapsed).toBe(true);
  root.remove(); expect(textBoundary(root, false, false)).toBe(false);
});
