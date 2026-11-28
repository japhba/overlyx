/**
 * A password change signs the account's other browsers out (sessiongen.ts). Their cookies stopped
 * working at once, but an editor they had open kept its WebSocket — reading and writing the document
 * for as long as the connection lived. Now what a session holds open ends with it (holdOpen), and
 * only a browser with the new cookie connects again.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';

const ROOT = vi.hoisted(() => {
  const root = (process.env.OVERLYX_SCRATCH ?? process.env.TMPDIR ?? '/tmp') + '/overlyx-session-signout-test';
  process.env.OVERLYX_DATA_DIR = root + '/data';
  process.env.OVERLYX_PROJECTS_DIR = root + '/projects';
  process.env.OVERLYX_DOC_WORKERS = '0';
  process.env.OVERLYX_AGENT_USERS = 'off';
  return root;
});
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'projects', 'ada', 'p'), { recursive: true });
writeFileSync(join(ROOT, 'projects', 'ada', 'p', 'main.tex'), '\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n');

const { attachWebSocket } = await import('../packages/server/src/ws.ts');
const { createUser, toSessionUser, signSession } = await import('../packages/server/src/auth.ts');
const { registerProject } = await import('../packages/server/src/access.ts');
const { changePassword } = await import('../packages/server/src/profile.ts');
const { holdOpen, endOpenConnections, bumpSessionGeneration } = await import('../packages/server/src/sessiongen.ts');
const { connectParams } = await import('../packages/core/src/collab/connect.ts');

const server = http.createServer();
afterAll(() => { server.close(); rmSync(ROOT, { recursive: true, force: true }); });

describe('what a session holds open', () => {
  it('ends when the account\'s sessions are signed out — that account\'s, once, and not what closed by itself', () => {
    const ended: string[] = [];
    holdOpen(101, () => ended.push('a'));
    const gone = holdOpen(101, () => ended.push('closed by itself'));
    holdOpen(102, () => ended.push('somebody else'));
    holdOpen(101, () => { throw new Error('closing already'); });   // one that fails does not keep the others open
    holdOpen(101, () => ended.push('b'));
    gone();
    expect(endOpenConnections(101)).toBe(3);
    expect(ended).toEqual(['a', 'b']);
    expect(endOpenConnections(101)).toBe(0);
    bumpSessionGeneration(102);
    expect(ended).toEqual(['a', 'b', 'somebody else']);
  });

  it('an open editor is disconnected by a password change, and only the new cookie connects again', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const row = createUser('ada', 'Ada', 'first-password-1');
    const ada = toSessionUser(row);
    registerProject('ada/p', row.id, {});
    attachWebSocket(server);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const url = `ws://127.0.0.1:${port}/ws?${new URLSearchParams(connectParams('ada/p/main.tex'))}`;
    const old = `ol_session=${signSession(ada)}`;

    const ws = new WebSocket(url, { headers: { cookie: old } });
    await once(ws, 'message');   // the document is open and syncing
    const closed = once(ws, 'close');
    changePassword(ada, 'first-password-1', 'second-password-2');
    const [code] = await closed;
    expect(code).toBe(4003);

    // the other browser's editor tries again with the cookie it has: refused
    const again = new WebSocket(url, { headers: { cookie: old } });
    again.on('error', () => undefined);
    const [, refusal] = await once(again, 'unexpected-response') as [unknown, http.IncomingMessage];
    expect(refusal.statusCode).toBe(401);
    again.terminate();

    // the browser that changed the password got a new cookie: it is back
    const fresh = new WebSocket(url, { headers: { cookie: `ol_session=${signSession(ada)}` } });
    await once(fresh, 'message');
    fresh.close();
    await once(fresh, 'close');
  });
});
