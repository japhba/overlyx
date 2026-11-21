/**
 * A WebSocket whose client breaks the protocol (an invalid frame, one over maxPayload) gets an 'error'
 * event from the ws library. The connection's error listener was attached only once its document had
 * opened — a big one takes seconds — and an 'error' with no listener is an uncaught exception: the
 * whole server went down (the Tandem crash's class, 21 Nov 2026). Now the listener is there from the
 * start.
 */
import { it, expect, vi, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';

const ROOT = vi.hoisted(() => {
  const root = (process.env.TMPDIR ?? '/tmp') + '/overlyx-ws-early-error-test';
  process.env.OVERLYX_DATA_DIR = root + '/data';
  process.env.OVERLYX_PROJECTS_DIR = root + '/projects';
  process.env.OVERLYX_DOC_WORKERS = '0';
  return root;
});
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'projects', 'alice', 'p'), { recursive: true });

const { attachWebSocket } = await import('../packages/server/src/ws.ts');
const { manager } = await import('../packages/server/src/docs.ts');
const { createUser, toSessionUser, signSession } = await import('../packages/server/src/auth.ts');
const { registerProject } = await import('../packages/server/src/access.ts');
const { connectParams } = await import('../packages/core/src/collab/connect.ts');

const server = http.createServer();
afterAll(() => { server.close(); });

it('a client breaking the protocol while its document opens does not take the server down', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const user = createUser('alice', 'Alice', null);
  registerProject('alice/p', user.id, {});
  writeFileSync(join(ROOT, 'projects', 'alice', 'p', 'main.tex'), '\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n');
  // the document takes a moment to open (a big one: seconds)
  const realOpen = manager.open.bind(manager);
  vi.spyOn(manager, 'open').mockImplementation(async (id: string) => { await new Promise(r => setTimeout(r, 400)); return realOpen(id); });
  const crashes: unknown[] = [];
  const onCrash = (e: unknown) => { crashes.push(e); };
  process.prependListener('uncaughtException', onCrash);
  try {
    attachWebSocket(server);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const cookie = `ol_session=${signSession(toSessionUser(user))}`;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?${new URLSearchParams(connectParams('alice/p/main.tex'))}`, { headers: { cookie } });
    await once(ws, 'open');
    ws.on('error', () => { /* the server closes it */ });
    // a frame with a reserved opcode (3), masked, empty: the server's receiver rejects it
    (ws as unknown as { _socket: import('node:net').Socket })._socket.write(Buffer.from([0x83, 0x80, 0, 0, 0, 0]));
    await once(ws, 'close');
    await new Promise(r => setTimeout(r, 700));   // the open finishes; the connection is gone
    expect(crashes).toEqual([]);
    expect(manager.docs.get('alice/p/main.tex')?.conns.size ?? 0).toBe(0);
  } finally { process.removeListener('uncaughtException', onCrash); }
});
