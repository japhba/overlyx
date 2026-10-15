// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { CiteDialog, Dialog } from '../packages/client/src/app/Dialogs';
import type { DocMeta } from '../packages/client/src/api';

vi.mock('../packages/client/src/usage', () => ({ recordUsage: () => {}, dialogKey: (title: string) => title }));
let root: HTMLDivElement, previous: HTMLElement;
afterEach(async () => {
  if (root) { await act(() => render(null, root)); root.remove(); }
  previous?.remove();
  vi.restoreAllMocks();
});
function mountPoint(tag: 'button' | 'iframe' | 'div' = 'button') {
  previous = document.createElement(tag);
  if (tag === 'div') { previous.contentEditable = 'true'; previous.tabIndex = 0; }
  document.body.append(previous); previous.focus();
  root = document.createElement('div'); document.body.append(root);
  return vi.spyOn(previous, 'focus');
}
const entry = { key: 'illustration2025', author: 'Example Researcher', year: '2025', title: 'Illustrative results' };
const meta = { bib: [entry], bibTotal: 1, citeEngine: 'basic' } as DocMeta;
const initial = { keys: [entry.key], cmd: 'cite', before: '', after: '' };
const close = () => render(null, root);
const closeButton = () => [...root.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Close')!;
const insertButton = () => root.querySelector<HTMLButtonElement>('[data-cite-insert]')!;

it('ordinary Dialog cancellation restores its previous focus by default', async () => {
  const focus = mountPoint();
  await act(() => render(h(Dialog, { title: 'Ordinary dialog', onClose: close, children: h('input', { autofocus: true }) }), root));
  expect(document.activeElement).not.toBe(previous);
  await act(() => closeButton().click());
  expect(document.activeElement).toBe(previous);
  expect(focus).toHaveBeenCalledTimes(1);
});

it('Dialog cleanup evaluates the latest restore predicate rather than its mount-time value', async () => {
  const focus = mountPoint(), original = vi.fn(() => true), latest = vi.fn(() => false);
  const dialog = (restoreFocus: () => boolean) => h(Dialog, { title: 'Focus handoff', onClose: close, restoreFocus, children: h('input', { autofocus: true }) });
  await act(() => render(dialog(original), root));
  await act(() => render(dialog(latest), root));
  await act(() => closeButton().click());
  expect(original).not.toHaveBeenCalled();
  expect(latest).toHaveBeenCalledTimes(1);
  expect(focus).not.toHaveBeenCalled();
});

it('successful queued canvas citation leaves focus to the delivered command instead of focusing the iframe at close', async () => {
  const focus = mountPoint('iframe'), queued: (() => void)[] = [];
  const insert = vi.fn((keys: string[], cmd: string, before: string, after: string, entries: unknown[]) => {
    queued.push(() => { previous.focus(); previous.dataset.inserted = `\\${cmd}{${keys.join(',')}}`; });
  });
  await act(() => render(h(CiteDialog, { meta, initial, restoreFocusOnInsert: false, onInsert: insert, onClose: close }), root));
  await act(() => insertButton().click());
  expect(insert).toHaveBeenCalledWith([entry.key], 'cite', '', '', [entry]);
  expect(root.querySelector('[role="dialog"]')).toBeNull();
  expect(focus).not.toHaveBeenCalled();
  expect(document.activeElement).not.toBe(previous);
  expect(queued).toHaveLength(1);
  queued[0]();
  expect(focus).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(previous);
  expect(previous.dataset.inserted).toBe('\\cite{illustration2025}');
});

it('cancel still restores canvas focus when successful-insert restoration is disabled', async () => {
  const focus = mountPoint('iframe'), insert = vi.fn();
  await act(() => render(h(CiteDialog, { meta, initial, restoreFocusOnInsert: false, onInsert: insert, onClose: close }), root));
  await act(() => closeButton().click());
  expect(insert).not.toHaveBeenCalled();
  expect(focus).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(previous);
});

it('Escape cancellation restores canvas focus and never queues an insertion', async () => {
  const focus = mountPoint('iframe'), insert = vi.fn();
  await act(() => render(h(CiteDialog, { meta, initial, restoreFocusOnInsert: false, onInsert: insert, onClose: close }), root));
  await act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  expect(root.querySelector('[role="dialog"]')).toBeNull();
  expect(insert).not.toHaveBeenCalled();
  expect(focus).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(previous);
});

it('ordinary document insertion keeps its synchronous editor focus without a redundant restoration', async () => {
  const focus = mountPoint('div');
  const insert = vi.fn(() => { previous.textContent = '[illustration2025]'; previous.focus(); });
  await act(() => render(h(CiteDialog, { meta, initial, onInsert: insert, onClose: close }), root));
  await act(() => insertButton().click());
  expect(insert).toHaveBeenCalledTimes(1);
  expect(previous.textContent).toBe('[illustration2025]');
  expect(focus).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(previous);
});

it('a failed synchronous insertion does not mark the dialog as inserted or suppress later cancel restoration', async () => {
  const focus = mountPoint('iframe'), failure = new Error('Insertion unavailable'), onClose = vi.fn(close);
  let reported: unknown;
  const error = (event: ErrorEvent) => { reported = event.error; event.preventDefault(); };
  window.addEventListener('error', error);
  try {
    await act(() => render(h(CiteDialog, { meta, initial, restoreFocusOnInsert: false, onInsert: () => { throw failure; }, onClose }), root));
    try { await act(() => insertButton().click()); } catch (e) { reported = e; }
    expect(reported).toBe(failure);
    expect(onClose).not.toHaveBeenCalled();
    expect(root.querySelector('[role="dialog"]')).not.toBeNull();
    expect(focus).not.toHaveBeenCalled();
    await act(() => closeButton().click());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(previous);
  } finally { window.removeEventListener('error', error); }
});
