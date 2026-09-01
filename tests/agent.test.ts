/**
 * The embedded coding agent (packages/server/src/agent.ts) against the codex app-server stub
 * (scripts/codex-stub.mjs, OVERLYX_CODEX_BIN): device-code sign-in completing by itself, per-user
 * state, threads bound to a project, a turn streaming deltas over the SSE events route, the
 * file-change approval round-trip actually writing the file, and the access rules (project role
 * required; only the thread's creator drives it).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import express from 'express';

const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-agent-test');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'projects', 'p'), { recursive: true });
writeFileSync(join(ROOT, 'projects', 'p', 'paper.tex'), '\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n');
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');
process.env.OVERLYX_CODEX_BIN = resolve(process.cwd(), 'scripts/codex-stub.mjs');
process.env.STUB_LOGIN_DELAY = '120';
process.env.STUB_DELAY = '60';

const { agentRoutes, shutdownAgents } = await import('../packages/server/src/agent.ts');
const { createUser } = await import('../packages/server/src/auth.ts');
const { registerProject } = await import('../packages/server/src/access.ts');
const { db } = await import('../packages/server/src/db.ts');

const owner = createUser('owner', 'Owner', 'pw');
const editor = createUser('bob', 'Bob', 'pw');
const outsider = createUser('mallory', 'Mallory', 'pw');
registerProject('p', owner.id);
db.prepare('INSERT INTO project_members (project, user_id, role, via, created_at) VALUES (?,?,?,?,?)').run('p', editor.id, 'edit', 'member', Date.now());

// a bare app: the test authenticates via an x-user header instead of the cookie middleware
const users = { owner, bob: editor, mallory: outsider } as Record<string, { id: number; username: string }>;
const app = express();
app.use(express.json());
app.use((req, _res, next) => { (req as any).user = { ...users[String(req.headers['x-user'] ?? 'owner')], name: 'x', color: '#000', isAdmin: false }; next(); });
app.use('/api', agentRoutes());
const server = http.createServer(app);
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;

afterAll(() => { shutdownAgents(); server.close(); rmSync(ROOT, { recursive: true, force: true }); });

const asUser = (u: string) => ({ 'x-user': u, 'content-type': 'application/json' });
const get = async (path: string, u = 'owner') => { const r = await fetch(base + path, { headers: asUser(u) }); return { status: r.status, body: await r.json() }; };
const post = async (path: string, body: unknown = {}, u = 'owner') => { const r = await fetch(base + path, { method: 'POST', headers: asUser(u), body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Collect SSE events of the project stream until `done` says stop (or the timeout). */
async function collectEvents(u: string, done: (evs: any[]) => boolean, timeoutMs = 8000): Promise<any[]> {
  const res = await fetch(base + '/projects/p/agent/events', { headers: asUser(u) });
  const reader = res.body!.getReader();
  const evs: any[] = [];
  const dec = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value, done: eof } = await Promise.race([reader.read(), sleep(deadline - Date.now()).then(() => ({ value: undefined, done: true }))]) as { value?: Uint8Array; done: boolean };
    if (eof || !value) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      const line = chunk.split('\n').find(l => l.startsWith('data:'));
      if (line) { try { evs.push(JSON.parse(line.slice(5).trim())); } catch { /* hb */ } }
    }
    if (done(evs)) break;
  }
  void reader.cancel().catch(() => { /* closed */ });
  return evs;
}

describe('agent sign-in', () => {
  it('starts unauthenticated, completes the device-code flow by itself', async () => {
    expect((await get('/agent/status')).body).toMatchObject({ enabled: true, authenticated: false });
    const login = await post('/agent/login');
    expect(login.status).toBe(200);
    expect(login.body.userCode).toBe('STUB-CODE');
    expect(login.body.verificationUrl).toContain('https://');
    await sleep(400);   // the stub "signs in" after STUB_LOGIN_DELAY
    const st = await get('/agent/status');
    expect(st.body.authenticated).toBe(true);
    expect(st.body.account?.email).toBe('stub@example.com');
  });
});

describe('threads and turns', () => {
  let tid = '';
  it('starts a thread in the project directory and lists it', async () => {
    const r = await post('/projects/p/agent/threads');
    expect(r.status).toBe(200);
    tid = r.body.id;
    expect(tid).toMatch(/^thread-/);
    const list = await get('/projects/p/agent/threads');
    expect(list.body.threads).toHaveLength(1);
    expect(list.body.threads[0]).toMatchObject({ id: tid, mine: true });
  });

  it('a turn streams deltas and completes over the events route', async () => {
    const events = collectEvents('owner', evs => evs.some(e => e.method === 'turn/completed'));
    await sleep(150);   // subscribe before the turn starts
    const r = await post(`/projects/p/agent/threads/${tid}/turn`, { text: 'hello agent', context: { docId: 'p/paper.tex' } });
    expect(r.status).toBe(200);
    const evs = await events;
    const deltas = evs.filter(e => e.method === 'item/agentMessage/delta').map(e => e.params.delta).join('');
    expect(deltas).toContain('Stub reply to: hello agent');
    expect(evs.some(e => e.method === 'turn/completed')).toBe(true);
    // the first message names the thread
    const list = await get('/projects/p/agent/threads');
    expect(list.body.threads[0].title).toBe('hello agent');
  });

  it('the transcript can be read back — by the creator and by another editor of the project', async () => {
    const own = await get(`/projects/p/agent/threads/${tid}`);
    expect(own.status).toBe(200);
    expect(own.body.mine).toBe(true);
    const items = own.body.thread.turns.flatMap((t: any) => t.items);
    expect(items.some((i: any) => i.type === 'agentMessage' && i.text.includes('hello agent'))).toBe(true);
    const bobs = await get(`/projects/p/agent/threads/${tid}`, 'bob');
    expect(bobs.status).toBe(200);
    expect(bobs.body.mine).toBe(false);
  });

  it('a file change asks for approval; accepting writes the file', async () => {
    // the stub holds the turn until its file-change approval is answered
    const untilRequest = collectEvents('owner', evs => evs.some(e => e.kind === 'request'), 6000);
    await sleep(150);
    const turn = post(`/projects/p/agent/threads/${tid}/turn`, { text: 'please write hello somewhere' });
    const evs = await untilRequest;
    const request = evs.find(e => e.kind === 'request');
    expect(request?.method).toBe('item/fileChange/requestApproval');
    const ok = await post(`/projects/p/agent/threads/${tid}/approval`, { requestId: request.requestId, decision: 'accept' });
    expect(ok.status).toBe(200);
    const file = join(ROOT, 'projects', 'p', 'hello.txt');
    for (let i = 0; i < 30 && !existsSync(file); i++) await sleep(100);
    expect(readFileSync(file, 'utf8')).toContain('hello from the stub agent');
    expect((await turn).status).toBe(200);
  });

  it('only project members reach the agent; only the creator drives a thread', async () => {
    expect((await get('/projects/p/agent/threads', 'mallory')).status).toBe(403);
    expect((await post(`/projects/p/agent/threads/${tid}/turn`, { text: 'hi' }, 'mallory')).status).toBe(403);
    const bob = await post(`/projects/p/agent/threads/${tid}/turn`, { text: 'let me in' }, 'bob');
    expect(bob.status).toBe(403);
    expect(bob.body.error).toContain('creator');
    expect((await post(`/projects/p/agent/threads/${tid}/approval`, { requestId: 'x', decision: 'accept' }, 'bob')).status).toBe(403);
  });

  it('signing out forgets the account', async () => {
    expect((await post('/agent/logout')).status).toBe(200);
    expect((await get('/agent/status')).body.authenticated).toBe(false);
  });
});
