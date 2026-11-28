/**
 * A document worker stuck on one request no longer stops every document's saves and stored states.
 * Production runs one worker, and its requests are done one after the other: a request that never
 * ended (a parse or merge looping on one pathological file) held all the others — every document's
 * save, merge and the copy of its state in the database — with no log line and nothing on screen.
 * Now a request that runs past the pool's bound ends the worker: that request fails with
 * WorkerTimeout (it is not sent again — it would hang again), the ones behind it with WorkerGone
 * (docs.ts inWorker sends them to the new worker, which rebuilds its mirrors), and the bound is per
 * request — a queue of slow ones is not cut off.
 */
import { it, expect, vi, afterAll } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DocWorkers, WorkerGone, WorkerTimeout } from '../packages/server/src/docpool.ts';

// a stand-in worker: `sleep` blocks its thread for `ms` (`ms` -1: forever), anything else answers its pid-like counter
const dir = join(process.env.TMPDIR ?? '/tmp', 'overlyx-docpool-watchdog-test');
mkdirSync(dir, { recursive: true });
const script = join(dir, 'worker.mjs');
writeFileSync(script, `
import { parentPort, threadId } from 'node:worker_threads';
parentPort.on('message', (req) => {
  if (req.op === 'sleep') { const end = req.args.ms < 0 ? Infinity : Date.now() + req.args.ms; while (Date.now() < end) { /* busy */ } }
  parentPort.postMessage({ id: req.id, ok: true, result: threadId });
});
`);

const pool = new DocWorkers(1, { url: pathToFileURL(script), limitMs: 400 });
afterAll(() => pool.close());

it('ends a worker stuck on a request: that request fails, the ones behind it are handed back, a new worker serves', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const first = await pool.call(0, 'ping', null, [], {});
  const gen = pool.generation(0);
  const stuck = pool.call(0, 'sleep', null, [], { ms: -1 });
  const behind = pool.call(0, 'ping', null, [], {});
  await expect(stuck).rejects.toBeInstanceOf(WorkerTimeout);
  await expect(behind).rejects.toBeInstanceOf(WorkerGone);
  expect(pool.generation(0)).toBe(gen + 1);
  expect(error.mock.calls.some(c => /^\[docs\] document worker 0: .*sleep.*0\.4 s/.test(String(c[0])))).toBe(true);
  const next = await pool.call(0, 'ping', null, [], {});
  expect(next).not.toBe(first);                   // another thread
  expect(pool.enabled).toBe(true);
});

it('measures each request from when the worker began it: slow requests one after another all finish', async () => {
  const gen = pool.generation(0);
  const slow = [0, 1, 2].map(() => pool.call(0, 'sleep', null, [], { ms: 250 }));
  await expect(Promise.all(slow)).resolves.toHaveLength(3);
  expect(pool.generation(0)).toBe(gen);
});

it('stuck requests are not deaths: the pool keeps its workers', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  for (let i = 0; i < 5; i++) await expect(pool.call(0, 'sleep', null, [], { ms: -1 })).rejects.toBeInstanceOf(WorkerTimeout);
  expect(pool.enabled).toBe(true);
  await expect(pool.call(0, 'ping', null, [], {})).resolves.toBeTypeOf('number');
}, 15_000);
