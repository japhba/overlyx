// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ typeset: vi.fn(), post: vi.fn() }));
vi.mock('../packages/client/src/deliverable/runtime/math', () => ({ typeset: mocks.typeset, untypeset: vi.fn() }));
vi.mock('../packages/client/src/deliverable/runtime/env', () => ({ post: mocks.post }));
import * as math from '../packages/client/src/deliverable/runtime/mathedit';

let finishRender: () => void;
let inserted: string[];

beforeEach(() => {
  vi.useFakeTimers();
  mocks.post.mockClear();
  mocks.typeset.mockImplementation(() => new Promise<void>(resolve => { finishRender = resolve; }));
  inserted = [];
  Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn((command: string, _showUI?: boolean, value?: string) => {
    if (command === 'insertText') inserted.push(value ?? '');
    return true;
  }) });
});

afterEach(() => {
  math.closeChip();
  math.flushAfter();
  math.chipHooks.stop = () => {};
  document.body.replaceChildren();
  getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, 'execCommand');
  vi.useRealTimers();
});

function editingChip() {
  const editing = document.createElement('p');
  editing.contentEditable = 'true';
  const chip = document.createElement('span');
  chip.className = 'ol-mathchip';
  chip.dataset.olChip = '801';
  chip.dataset.olTex = 'x';
  chip.dataset.olDelim = '(';
  editing.append('holds ', chip);
  document.body.append(editing);
  math.openChip(chip, null);
  math.shownChip(801);
  return { editing, chip };
}

it('keeps native prose keys behind the closing formula until its caret is restored', async () => {
  const { editing, chip } = editingChip();
  const done = math.doneChip(801, 'x^{2}', 'forward', editing);
  expect(math.openChipEl()).toBe(chip);
  expect(math.chipOpening()).toBe(false);
  math.holdAfter({ key: ' ' });
  expect(inserted).toEqual([]);
  finishRender();
  await done;
  expect(math.openChipEl()).toBeNull();
  expect(inserted).toEqual([' ']);
  expect(getSelection()?.anchorNode).toBe(editing);
  expect(getSelection()?.anchorOffset).toBe(2);
});

it('does not release queued prose at the 600 ms fallback while typesetting is pending', async () => {
  const { editing } = editingChip();
  const done = math.doneChip(801, 'x^{2}', 'forward', editing);
  math.holdAfter({ key: 'o' });
  vi.advanceTimersByTime(2000);
  expect(inserted).toEqual([]);
  finishRender();
  await done;
  expect(inserted).toEqual(['o']);
});

it('replays host-returned space and native letters in one FIFO, including Unicode text', async () => {
  const { editing } = editingChip();
  const done = math.doneChip(801, 'x^{2}', 'forward', editing);
  expect(math.holdIfLeaving([{ key: ' ' }])).toBe(true);
  math.holdAfter({ key: 'o' });
  math.holdAfter({ key: 'k' });
  expect(math.holdIfLeaving([{ key: '', text: ' — café 🙂' }])).toBe(true);
  finishRender();
  await done;
  expect(inserted.join('')).toBe(' ok — café 🙂');
  expect(math.holdIfLeaving([{ key: '!' }])).toBe(false);
});

it('places the atomic math-done prose tail before a later native Escape', async () => {
  const { editing } = editingChip();
  const stop = vi.fn(() => math.closeChip());
  math.chipHooks.stop = stop;
  const done = math.doneChip(801, 'x^{2}', 'forward', editing, '', [{ key: ' ' }, { key: 'o' }, { key: 'k' }]);
  math.holdAfter({ key: 'Escape' });
  finishRender();
  await done;
  expect(inserted.join('')).toBe(' ok');
  expect(stop).toHaveBeenCalledOnce();
});

it('settles a click flush once and a late render cannot reset the next text caret', async () => {
  const { editing } = editingChip();
  const done = math.doneChip(801, 'x^{2}', 'forward', editing);
  math.holdAfter({ key: 'a' });
  math.flushAfter();
  expect(inserted).toEqual(['a']);
  const next = document.createElement('p');
  next.contentEditable = 'true';
  next.textContent = 'next';
  document.body.append(next);
  const range = document.createRange();
  range.setStart(next.firstChild!, 2);
  range.collapse(true);
  getSelection()?.removeAllRanges();
  getSelection()?.addRange(range);
  next.focus();
  finishRender();
  await done;
  expect(getSelection()?.anchorNode).toBe(next.firstChild);
  expect(getSelection()?.anchorOffset).toBe(2);
  expect(mocks.post.mock.calls.filter(([message]) => message.ol === 'mathClose')).toHaveLength(1);
  expect(inserted).toEqual(['a']);
});

it('does not close a newly reopened copy of the same chip when the old render completes', async () => {
  const { editing, chip } = editingChip();
  const done = math.doneChip(801, 'x^{2}', 'forward', editing);
  math.holdAfter({ key: ' ' });
  math.openChip(chip, null);
  math.shownChip(801);
  expect(inserted).toEqual([' ']);
  finishRender();
  await done;
  expect(math.openChipEl()).toBe(chip);
  expect(chip.hasAttribute('data-ol-mathediting')).toBe(true);
  expect(mocks.post.mock.calls.filter(([message]) => message.ol === 'mathClose')).toHaveLength(1);
});

it('an ahead Escape ends retyping once and drops subsequent keys from that old context', async () => {
  const { editing } = editingChip();
  const stop = vi.fn(() => math.closeChip());
  math.chipHooks.stop = stop;
  const done = math.doneChip(801, 'x^{2}', 'forward', editing);
  math.holdIfLeaving([{ key: 'a' }, { key: 'Escape' }, { key: 'z' }]);
  finishRender();
  await done;
  expect(stop).toHaveBeenCalledTimes(1);
  expect(inserted).toEqual(['a']);
  expect(mocks.post.mock.calls.filter(([message]) => message.ol === 'mathClose')).toHaveLength(1);
});

it('closing while rendering drains preceding keys without recursively stopping retyping', async () => {
  const { editing } = editingChip();
  const stop = vi.fn(() => math.closeChip());
  math.chipHooks.stop = stop;
  const done = math.doneChip(801, 'x^{2}', 'forward', editing);
  math.holdIfLeaving([{ key: 'a' }, { key: 'Escape' }, { key: 'z' }]);
  math.closeChip();
  expect(stop).not.toHaveBeenCalled();
  expect(inserted).toEqual(['a']);
  finishRender();
  await done;
  expect(inserted).toEqual(['a']);
  expect(mocks.post.mock.calls.filter(([message]) => message.ol === 'mathClose')).toHaveLength(1);
});

it('force settlement resolves the handoff without waiting for a hung render', async () => {
  const { editing } = editingChip();
  const done = math.doneChip(801, 'x^{2}', 'forward', editing);
  math.holdAfter({ key: 'a' });
  math.flushAfter();
  expect(await done).toBe(true);
  expect(math.holdIfLeaving([{ key: 'b' }])).toBe(false);
  math.typeKeysHere([{ key: 'b' }]);
  expect(inserted.join('')).toBe('ab');
  finishRender();
  await Promise.resolve();
  expect(inserted.join('')).toBe('ab');
});

it('an unexpected render failure retains editable TeX and completes the handoff', async () => {
  const { editing, chip } = editingChip();
  chip.setAttribute('data-ol-texwait', '');
  mocks.typeset.mockRejectedValueOnce(new Error('Test renderer failure'));
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const done = math.doneChip(801, 'x^{2}', 'forward', editing);
  math.holdIfLeaving([{ key: ' ' }, { key: 'o' }, { key: 'k' }]);
  expect(await done).toBe(true);
  expect(inserted.join('')).toBe(' ok');
  expect(chip.dataset.olTex).toBe('x^{2}');
  expect(chip.textContent).toBe('\\(x^{2}\\)');
  expect(chip.hasAttribute('data-ol-texwait')).toBe(false);
  expect(math.openChipEl()).toBeNull();
  expect(warning).toHaveBeenCalledOnce();
});

it('keeps prose in recovery rather than inserting it into another box when its target vanished', async () => {
  const { editing } = editingChip();
  const done = math.doneChip(801, 'x^{2}', 'forward', editing);
  math.holdIfLeaving([{ key: ' ' }, { key: '', text: 'kept <safely>' }]);
  editing.remove();
  finishRender();
  await done;
  expect(inserted).toEqual([]);
  expect(mocks.post).toHaveBeenCalledWith(expect.objectContaining({ ol: 'recoveredText', html: ' kept &lt;safely&gt;' }));
});

it('recovers the atomic prose tail if the formula disappears before mathDone arrives', async () => {
  const { editing, chip } = editingChip();
  chip.remove();
  expect(await math.doneChip(801, 'x^{2}', 'forward', editing, '', [{ key: '', text: ' kept <safely>' }])).toBe(false);
  expect(inserted).toEqual([]);
  expect(mocks.post).toHaveBeenCalledWith(expect.objectContaining({ ol: 'recoveredText', html: ' kept &lt;safely&gt;' }));
  expect(math.openChipEl()).toBeNull();
});

it('a stale different-chip reply cannot finish the current closing job', async () => {
  const { editing, chip } = editingChip();
  const done = math.doneChip(801, 'x^{2}', 'forward', editing);
  math.holdAfter({ key: 'a' });
  expect(await math.doneChip(800, 'old', 'forward', editing, '', [{ key: 'b' }])).toBe(true);
  expect(math.openChipEl()).toBe(chip);
  expect(inserted).toEqual([]);
  expect(mocks.post).toHaveBeenCalledWith(expect.objectContaining({ ol: 'recoveredText', html: 'b' }));
  finishRender();
  await done;
  expect(inserted).toEqual(['a']);
});

it('restores an empty dollar before replaying prose', async () => {
  const { editing, chip } = editingChip();
  const done = math.doneChip(801, '', 'backward', editing, '$');
  math.holdIfLeaving([{ key: 'a' }]);
  expect(await done).toBe(false);
  expect(chip.isConnected).toBe(false);
  expect(editing.textContent).toBe('holds $');
  expect(getSelection()?.anchorNode?.textContent).toBe('$');
  expect(getSelection()?.anchorOffset).toBe(1);
  expect(inserted).toEqual(['a']);
});
