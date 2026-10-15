// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { api, type ZipImportResult } from '../packages/client/src/api';
import { OverleafImport } from '../packages/client/src/app/OverleafImport';

vi.mock('../packages/client/src/usage', () => ({ recordUsage: () => {}, dialogKey: (title: string) => title }));
let root: HTMLDivElement;
afterEach(async () => { if (root) { await act(() => render(null, root)); root.remove(); } vi.restoreAllMocks(); });
const result = (name: string): ZipImportResult => ({ ok: true, name, files: 1, skipped: [], projects: [], errors: [] });
async function open(zips: File[]) {
  root = document.createElement('div'); document.body.append(root);
  const imported = vi.fn();
  await act(() => render(h(OverleafImport, { existing: [], onClose: () => {}, onImported: imported, notify: () => {}, initial: { zips } }), root));
  return { imported, button: () => root.querySelector<HTMLButtonElement>('[data-overleaf-import-zip]')!, rows: () => [...root.querySelectorAll<HTMLTableRowElement>('[data-zip-row]')] };
}

it('finishes each ZIP row after the working state replaces it and excludes completed imports', async () => {
  let finish!: (value: ZipImportResult) => void;
  const pending = new Promise<ZipImportResult>(resolve => { finish = resolve; });
  const request = vi.spyOn(api, 'importZip').mockReturnValueOnce(pending).mockResolvedValueOnce(result('second'));
  const ui = await open([new File(['first'], 'first.zip'), new File(['second'], 'second.zip')]);
  await act(() => ui.button().click());
  expect(ui.rows()[0].textContent).toContain('importing…'); expect(ui.button().disabled).toBe(true);
  await act(async () => { finish(result('first')); await pending; });
  expect(ui.rows().map(row => row.className)).toEqual(['ok', 'ok']);
  expect(ui.rows().map(row => row.textContent)).toEqual([expect.stringContaining('1 file'), expect.stringContaining('1 file')]);
  expect(ui.button().disabled).toBe(true); expect(request).toHaveBeenCalledTimes(2); expect(ui.imported).toHaveBeenCalledTimes(1);
});

it('shows a failed ZIP error and retries that file without importing a completed sibling again', async () => {
  const request = vi.spyOn(api, 'importZip').mockRejectedValueOnce(new Error('The archive could not be imported')).mockResolvedValueOnce(result('second')).mockResolvedValueOnce(result('first'));
  const first = new File(['first'], 'first.zip'), second = new File(['second'], 'second.zip');
  const ui = await open([first, second]);
  await act(async () => { ui.button().click(); });
  await vi.waitFor(async () => { await act(() => {}); expect(ui.rows().map(row => row.className)).toEqual(['error', 'ok']); });
  expect(ui.rows()[0].textContent).toContain('The archive could not be imported'); expect(ui.button().disabled).toBe(false);
  await act(async () => { ui.button().click(); });
  await vi.waitFor(async () => { await act(() => {}); expect(ui.rows().map(row => row.className)).toEqual(['ok', 'ok']); }); expect(ui.button().disabled).toBe(true);
  expect(request.mock.calls.map(([name, file]) => [name, file])).toEqual([['first', first], ['second', second], ['first', first]]);
});
