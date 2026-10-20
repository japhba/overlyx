/**
 * The server's own check after a start (packages/server/src/selfcheck.ts): a .tex document, a
 * markdown file, an HTML deck and a whiteboard open over its websocket as their editors open them,
 * and a server that holds them back fails it (20 Oct 2026: for a day no deck opened, silently).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { WebSocketServer } from 'ws';

const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-selfcheck-test');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'projects'), { recursive: true });
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');
process.env.HOST = '127.0.0.1';

const { attachWebSocket } = await import('../packages/server/src/ws.ts');
const { runSelfCheck, selfCheckState } = await import('../packages/server/src/selfcheck.ts');
const { projectRow } = await import('../packages/server/src/access.ts');

const servers: http.Server[] = [];
async function listen(server: http.Server): Promise<number> {
  servers.push(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return (server.address() as { port: number }).port;
}
afterAll(() => { for (const s of servers) s.close(); rmSync(ROOT, { recursive: true, force: true }); });

describe('the self-check after a start', () => {
  it('opens a .tex document, a markdown file, a deck and a whiteboard, as their editors do', async () => {
    const server = http.createServer();
    attachWebSocket(server);
    const port = await listen(server);
    expect(await runSelfCheck(port)).toEqual({ docs: 'ok' });
    expect(selfCheckState()).toEqual({ docs: 'ok' });
    // its project is not a person's: the mirror leaves it out
    expect(projectRow('overlyx-check/docs')?.kind).toBe('check');
    // the next start: the account, the project and the files are there already
    expect(await runSelfCheck(port)).toEqual({ docs: 'ok' });
  }, 60000);

  it('checks what the editors do: every one connects with connectParams (core collab/connect.ts)', () => {
    const src = join(import.meta.dirname, '..', 'packages');
    const files = (readdirSync(src, { recursive: true }) as string[]).filter(f => /\.(ts|tsx)$/.test(f) && !f.includes('node_modules') && !/(^|\/)dist/.test(f));
    const providers = files.flatMap(f => (readFileSync(join(src, f), 'utf8').match(/new WebsocketProvider\([^\n]*/g) ?? []).map(l => `${f}: ${l}`));
    expect(providers.length).toBeGreaterThanOrEqual(3);
    for (const p of providers) expect(p).toMatch(/params: connectParams\(/);
  });

  it('fails, naming each document, when the server sends nothing (as it held the decks)', async () => {
    const server = http.createServer();
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, () => { /* held: nothing sent */ }));
    const port = await listen(server);
    const r = await runSelfCheck(port, 1500);
    expect(r.docs).toBe('failed');
    for (const f of ['main.tex', 'notes.md', 'deck/index.html', 'board.board']) expect(r.detail).toContain(`${f}: nothing arrived`);
    wss.close();
  }, 30000);
});
