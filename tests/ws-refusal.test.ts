/**
 * A refused WebSocket upgrade (no session, no access) was a bare HTTP status, which a browser cannot
 * read (close code 1006, as for a network failure): the editor retried for ever and said "offline".
 * An editor that asks (core collab/connect.ts REFUSAL_PARAMS) gets a close code it can read; one that
 * does not — an older bundle in an open tab, for which a 44xx close would end its retries for good —
 * gets the bare status as before. And an editor's ping is answered at once (the connection watch's
 * check after the browser said "offline", client editor/connection.ts).
 */
import { it, expect, vi, afterAll, beforeAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';

const ROOT = vi.hoisted(() => {
  const root = (process.env.TMPDIR ?? '/tmp') + '/overlyx-ws-refusal-test';
  process.env.OVERLYX_DATA_DIR = root + '/data';
  process.env.OVERLYX_PROJECTS_DIR = root + '/projects';
  process.env.OVERLYX_DOC_WORKERS = '0';
  return root;
});
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'projects', 'alice', 'p'), { recursive: true });

const { attachWebSocket } = await import('../packages/server/src/ws.ts');
const { createUser, toSessionUser, signSession } = await import('../packages/server/src/auth.ts');
const { registerProject } = await import('../packages/server/src/access.ts');
const { connectParams, REFUSAL_PARAMS, CLOSE_SIGNED_OUT, CLOSE_NO_ACCESS } = await import('../packages/core/src/collab/connect.ts');

const server = http.createServer();
let base = '', alice = '', bob = '';
beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const a = createUser('alice', 'Alice', null), b = createUser('bob', 'Bob', null);
  registerProject('alice/p', a.id, {});
  writeFileSync(join(ROOT, 'projects', 'alice', 'p', 'main.tex'), '\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n');
  alice = `ol_session=${signSession(toSessionUser(a))}`;
  bob = `ol_session=${signSession(toSessionUser(b))}`;
  attachWebSocket(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `ws://127.0.0.1:${(server.address() as { port: number }).port}/ws?`;
});
afterAll(() => { server.close(); });

const url = (asks: boolean) => base + new URLSearchParams({ ...connectParams('alice/p/main.tex'), ...(asks ? REFUSAL_PARAMS : {}) });
/** how the connection ends: a close code, or the HTTP status of a refused upgrade */
async function outcome(asks: boolean, cookie?: string): Promise<{ close?: number; reason?: string; status?: number }> {
  const ws = new WebSocket(url(asks), cookie ? { headers: { cookie } } : {});
  return new Promise(resolve => {
    ws.on('unexpected-response', (_req, res) => { resolve({ status: res.statusCode }); ws.terminate(); });
    ws.on('close', (code, reason) => resolve({ close: code, reason: reason.toString() }));
    ws.on('error', () => { /* the outcome comes with the close */ });
  });
}

it('signed out: a close code the editor can read when it asks, the bare 401 otherwise', async () => {
  expect(await outcome(true)).toEqual({ close: CLOSE_SIGNED_OUT, reason: 'signed out' });
  expect(await outcome(false)).toEqual({ status: 401 });
});

it('no access: a close code when asked, the bare 403 otherwise', async () => {
  expect(await outcome(true, bob)).toEqual({ close: CLOSE_NO_ACCESS, reason: 'no access' });
  expect(await outcome(false, bob)).toEqual({ status: 403 });
});

it('an editor with access connects, and its ping is answered at once', async () => {
  const ws = new WebSocket(url(true), { headers: { cookie: alice } });
  const got: number[][] = [];
  ws.on('message', (d: Buffer) => { got.push([...d]); });
  await once(ws, 'open');
  // (the first messages: epoch, sync step 1, saved — then quiet until the heartbeat, 10 s later)
  await new Promise(r => setTimeout(r, 500));
  const before = got.length;
  const t0 = Date.now();
  ws.send(new Uint8Array([4]));
  while (got.length === before && Date.now() - t0 < 2000) await new Promise(r => setTimeout(r, 10));
  expect(got.slice(before)).toEqual([[4]]);
  expect(Date.now() - t0).toBeLessThan(1000);
  ws.close();
  await once(ws, 'close');
});
