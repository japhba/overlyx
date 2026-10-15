import { afterEach, expect, it, vi } from 'vitest';
import { watchPdfBuild } from '../packages/vscode/src/webview/pdfPolling';
import { lastBuild } from '../packages/vscode/src/host/build';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

afterEach(() => vi.useRealTimers());

it('restores an already compiled PDF after the extension host reloads', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlyx-existing-pdf-'));
  try {
    const tex = path.join(dir, 'main.tex'), pdf = path.join(dir, 'main.pdf');
    expect(lastBuild(dir, tex)).toBeUndefined();
    fs.writeFileSync(pdf, '%PDF-1.4\n');
    const build = lastBuild(dir, tex);
    expect(build).toMatchObject({ status: 'ok', pdf_path: pdf, tex_path: tex, log: '' });
    expect(build?.updated_at).toBe(Math.round(fs.statSync(pdf).mtimeMs));
    expect(lastBuild(dir)).toEqual(build);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

it('finds builds started from another editor after the PDF panel became idle', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockResolvedValueOnce({ job: null, pdf: null })
    .mockResolvedValueOnce({ job: { status: 'compiling' }, pdf: null })
    .mockResolvedValue({ job: { status: 'ok' }, pdf: '/built.pdf' });
  const receive = vi.fn(), failed = vi.fn();
  const watcher = watchPdfBuild({ fetch, receive, failed });
  watcher.poll();
  await vi.advanceTimersByTimeAsync(2000);
  expect(receive).toHaveBeenLastCalledWith({ job: { status: 'compiling' }, pdf: null });
  await vi.advanceTimersByTimeAsync(1000);
  expect(receive).toHaveBeenLastCalledWith({ job: { status: 'ok' }, pdf: '/built.pdf' });
  await vi.advanceTimersByTimeAsync(2000);
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(failed).not.toHaveBeenCalled();
  watcher.dispose();
});

it('announces a requested failure once, recovers from connection errors and stops on close', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockRejectedValueOnce(new Error('disconnected')).mockResolvedValue({ job: { status: 'error' } });
  const failed = vi.fn(), receive = vi.fn();
  const watcher = watchPdfBuild({ fetch, receive, failed });
  watcher.poll(true);
  await vi.advanceTimersByTimeAsync(5000);
  expect(failed).toHaveBeenCalledOnce();
  expect(receive).toHaveBeenCalledTimes(2);
  watcher.dispose();
  await vi.advanceTimersByTimeAsync(10000);
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('ignores responses from superseded polls and from a closed panel', async () => {
  vi.useFakeTimers();
  let first!: (value: any) => void, last!: (value: any) => void;
  const fetch = vi.fn().mockImplementationOnce(() => new Promise(resolve => { first = resolve; }))
    .mockResolvedValueOnce({ job: { status: 'ok' } })
    .mockImplementationOnce(() => new Promise(resolve => { last = resolve; }));
  const receive = vi.fn();
  const watcher = watchPdfBuild({ fetch, receive, failed() {} });
  watcher.poll(); watcher.poll();
  await vi.advanceTimersByTimeAsync(0);
  first({ job: { status: 'compiling' } });
  await vi.advanceTimersByTimeAsync(2000);
  expect(receive).toHaveBeenCalledOnce();
  watcher.dispose(); last({ job: { status: 'error' } });
  await vi.advanceTimersByTimeAsync(10000);
  expect(receive).toHaveBeenCalledOnce();
});
