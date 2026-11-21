/**
 * The notice that a change on disk won over edits made in the editor, which are kept in History
 * (server docnotices.ts, WebSocket message 8, client app/disknotice.ts): an editor connected at the
 * time is told at once; one who was not — the edits were rescued at an open nobody watched, or at
 * the start — is told at their next open, once; a viewer is not told.
 */
import { it, expect, vi, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';

const ROOT = vi.hoisted(() => {
  const root = (process.env.TMPDIR ?? '/tmp') + '/overlyx-doc-notices-test';
  process.env.OVERLYX_DATA_DIR = root + '/data';
  process.env.OVERLYX_PROJECTS_DIR = root + '/projects';
  process.env.OVERLYX_DOC_WORKERS = '0';
  return root;
});
rmSync(ROOT, { recursive: true, force: true });
const dir = join(ROOT, 'projects', 'alice', 'p');
mkdirSync(dir, { recursive: true });

const { attachWebSocket } = await import('../packages/server/src/ws.ts');
const { manager, HtmlDoc } = await import('../packages/server/src/docs.ts');
const { createUser, toSessionUser, signSession } = await import('../packages/server/src/auth.ts');
const { registerProject } = await import('../packages/server/src/access.ts');
const { db } = await import('../packages/server/src/db.ts');
const { connectParams } = await import('../packages/core/src/collab/connect.ts');
const { noticeText } = await import('../packages/client/src/app/disknotice.ts');

const server = http.createServer();
afterAll(() => { server.close(); });
let port = 0;

const deck = (two: string, five: string) => `<!doctype html>\n<html>\n<head>\n<meta name="overlyx" content="deck">\n</head>\n<body>\n<section class="slide">\n  <h1>One</h1>\n</section>\n<section class="slide">\n  <h1>${two}</h1>\n</section>\n<section class="slide">\n  <h1>Three</h1>\n</section>\n<section class="slide">\n  <h1>Five ${five}</h1>\n</section>\n</body>\n</html>\n`;
const restart = (doc: unknown) => (manager as any).forgetDoc(doc);
async function waitFor(f: () => boolean, ms = 3000): Promise<boolean> {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await new Promise(r => setTimeout(r, 30))) if (f()) return true;
  return f();
}
/** an editor connected to a document: the notices it was sent (it says each was seen, as the card does after a few seconds — unless `see` is false) */
async function connect(user: { id: number }, id: string, see = true): Promise<{ ws: WebSocket; notices: any[] }> {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id) as any;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?${new URLSearchParams(connectParams(id))}`, { headers: { cookie: `ol_session=${signSession(toSessionUser(u))}` } });
  const notices: any[] = [];
  ws.on('message', (data: Buffer) => {
    const dec = decoding.createDecoder(new Uint8Array(data));
    if (decoding.readVarUint(dec) !== 8) return;
    const n = JSON.parse(decoding.readVarString(dec));
    notices.push(n);
    if (see) { const e = encoding.createEncoder(); encoding.writeVarUint(e, 8); encoding.writeVarUint(e, n.id); ws.send(encoding.toUint8Array(e)); }
  });
  await once(ws, 'open');
  return { ws, notices };
}
const edit = (doc: InstanceType<typeof HtmlDoc>, from: string, to: string) => { const at = doc.html.toString().indexOf(from); doc.ydoc.transact(() => { doc.html.delete(at, from.length); doc.html.insert(at, to); }, 'test'); };

it('told at once when connected, at the next open when not, each person once; viewers not', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const alice = createUser('alice', 'Alice', null), bob = createUser('bob', 'Bob', null), vera = createUser('vera', 'Vera', null);
  registerProject('alice/p', alice.id, {});
  db.prepare("INSERT INTO project_members (project, user_id, role, via, created_at) VALUES ('alice/p', ?, 'edit', 'invite', 0), ('alice/p', ?, 'view', 'invite', 0)").run(bob.id, vera.id);
  attachWebSocket(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;

  // 1. edits stored, not written; the server stops; the file changes the same line meanwhile
  writeFileSync(join(dir, 'deck.html'), deck('Two', ''));
  const doc = await manager.open('alice/p/deck.html') as InstanceType<typeof HtmlDoc>;
  edit(doc, '<h1>Two</h1>', '<h1>Deux EDITED HERE</h1>');
  edit(doc, '<h1>Five </h1>', '<h1>Five EDITED</h1>');
  doc.persistState();
  restart(doc);
  writeFileSync(join(dir, 'deck.html'), deck('Two CHANGED ON DISK', ''));
  // the next start's pass (or any open) rescues it: nobody is connected
  const again = await manager.open('alice/p/deck.html');
  const versionId = manager.listVersions('alice/p/deck.html').find(v => v.name === 'before a change on disk')!.id;

  // alice opens it while the page reloads (the card never seen): told again at the next open
  const gone = await connect(alice, 'alice/p/deck.html', false);
  expect(await waitFor(() => gone.notices.length === 1)).toBe(true);
  gone.ws.close();
  await new Promise(r => setTimeout(r, 150));   // (its answer is in)
  // alice opens it: told, about that version, as a restart — then not again
  const a = await connect(alice, 'alice/p/deck.html');
  expect(await waitFor(() => a.notices.length === 1)).toBe(true);
  expect(a.notices[0]).toMatchObject({ doc: 'alice/p/deck.html', version: versionId, kind: 'restart', places: 1 });
  expect(noticeText(a.notices[0]).title).toBe('Edits recovered after a restart');
  a.ws.close();
  await new Promise(r => setTimeout(r, 150));   // (its answer is in)
  const a2 = await connect(alice, 'alice/p/deck.html');
  await new Promise(r => setTimeout(r, 300));
  expect(a2.notices).toEqual([]);                          // once
  // a viewer made no edits: not told
  const v = await connect(vera, 'alice/p/deck.html');
  await new Promise(r => setTimeout(r, 300));
  expect(v.notices).toEqual([]);

  // 2. a change on disk while alice and the viewer are connected: both told at once
  edit(again as InstanceType<typeof HtmlDoc>, '<h1>One</h1>', '<h1>Uno TYPED</h1>');
  const disk = (again as InstanceType<typeof HtmlDoc>).html.toString().replace('<h1>Uno TYPED</h1>', '<h1>Eins ON DISK</h1>');
  writeFileSync(join(dir, 'deck.html'), disk);
  again.absorbExternalChange(disk);
  expect(await waitFor(() => a2.notices.length === 1 && v.notices.length === 1)).toBe(true);
  expect(a2.notices[0]).toMatchObject({ kind: 'disk', places: 1 });
  expect(noticeText(a2.notices[0]).title).toBe('The file changed outside the editor');

  // 3. bob was not there for either: told about both at his next open, then never again
  const b = await connect(bob, 'alice/p/deck.html');
  expect(await waitFor(() => b.notices.length === 2)).toBe(true);
  expect(b.notices.map(n => n.kind)).toEqual(['restart', 'disk']);
  b.ws.close();
  await new Promise(r => setTimeout(r, 150));   // (its answer is in)
  const b2 = await connect(bob, 'alice/p/deck.html');
  await new Promise(r => setTimeout(r, 300));
  expect(b2.notices).toEqual([]);
  for (const c of [a2, v, b2]) c.ws.close();
});
