/**
 * The embedded coding agent (packages/server/src/agent.ts) against the codex app-server stub
 * (scripts/codex-stub.mjs, OVERLYX_CODEX_BIN): device-code sign-in completing by itself, per-user
 * state, threads bound to a project, a turn streaming deltas over the SSE events route, files
 * written in the working copy reaching the project, requests to leave the sandbox declined by the
 * server, each thread's sandbox and scope as codex is asked for them (the real codex keeps to
 * them: tests/agent-sandbox.test.ts), and the access rules (project role required; only the
 * thread's creator drives it).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import express from 'express';

const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-agent-test');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'projects', 'owner', 'p'), { recursive: true });
writeFileSync(join(ROOT, 'projects', 'owner', 'p', 'paper.tex'), '\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n');
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');
process.env.OVERLYX_CODEX_BIN = resolve(process.cwd(), 'scripts/codex-stub.mjs');
process.env.STUB_LOGIN_DELAY = '120';
process.env.STUB_DELAY = '60';

const { agentRoutes, shutdownAgents, disconnectAgents, installedCodexVersion } = await import('../packages/server/src/agent.ts');
const { createUser } = await import('../packages/server/src/auth.ts');
const { registerProject } = await import('../packages/server/src/access.ts');
const { db } = await import('../packages/server/src/db.ts');

const owner = createUser('owner', 'Owner', 'pw');
const editor = createUser('bob', 'Bob', 'pw');
const outsider = createUser('mallory', 'Mallory', 'pw');
registerProject('owner/p', owner.id);
db.prepare('INSERT INTO project_members (project, user_id, role, via, created_at) VALUES (?,?,?,?,?)').run('owner/p', editor.id, 'edit', 'member', Date.now());

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
  const res = await fetch(base + '/projects/owner%2Fp/agent/events', { headers: asUser(u) });
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

  it('wires codex to the OverLyX MCP: managed config + internal token in the env', async () => {
    const cfg = readFileSync(join(ROOT, 'data', 'agent-home', String(owner.id), 'config.toml'), 'utf8');
    expect(cfg).toContain('[mcp_servers.overlyx]');
    expect(cfg).toContain('bearer_token_env_var = "OVERLYX_MCP_TOKEN"');
    // the overlyx tools edit as tracked changes the user reviews in the editor — codex must not
    // gate them behind its own approval elicitation (it used to be auto-declined: every write
    // tool returned "user rejected MCP tool call")
    expect(cfg).toContain('default_tools_approval_mode = "approve"');
    const row = db.prepare("SELECT token_plain FROM mcp_tokens WHERE user_id = ? AND name = 'Agent panel'").get(owner.id) as { token_plain: string } | undefined;
    expect(row?.token_plain).toMatch(/^olxmcp_/);
  });
});

describe('threads and turns', () => {
  let tid = '';
  it('starts a thread in the project directory and lists it', async () => {
    const r = await post('/projects/owner%2Fp/agent/threads');
    expect(r.status).toBe(200);
    tid = r.body.id;
    expect(tid).toMatch(/^thread-/);
    const list = await get('/projects/owner%2Fp/agent/threads');
    expect(list.body.threads).toHaveLength(1);
    expect(list.body.threads[0]).toMatchObject({ id: tid, mine: true });
  });

  it('a turn streams deltas and completes over the events route', async () => {
    const events = collectEvents('owner', evs => evs.some(e => e.method === 'turn/completed'));
    await sleep(150);   // subscribe before the turn starts
    const r = await post(`/projects/owner%2Fp/agent/threads/${tid}/turn`, { text: 'hello agent', context: { docId: 'owner/p/paper.tex' }, clientMessageId: 'local-xyz' });
    expect(r.status).toBe(200);
    const evs = await events;
    // the user's message comes back as a real item carrying the client id (the panel dedupes on it)
    const um = evs.find(e => e.method === 'item/completed' && e.params.item?.type === 'userMessage');
    expect(um?.params.item.clientId).toBe('local-xyz');
    const deltas = evs.filter(e => e.method === 'item/agentMessage/delta').map(e => e.params.delta).join('');
    expect(deltas).toContain('Stub reply to: hello agent');
    expect(evs.some(e => e.method === 'turn/completed')).toBe(true);
    // the first message names the thread
    const list = await get('/projects/owner%2Fp/agent/threads');
    expect(list.body.threads[0].title).toBe('hello agent');
  });

  it('codex survives a server handover: the keeper keeps the same process and threads', async () => {
    const before = await get(`/projects/owner%2Fp/agent/threads/${tid}`);
    const nTurns = before.body.thread.turns.length;
    expect(nTurns).toBeGreaterThan(0);
    disconnectAgents();   // what a deploy's restart does now — the keeper keeps codex alive
    await sleep(150);
    const after = await get(`/projects/owner%2Fp/agent/threads/${tid}`);
    expect(after.status).toBe(200);
    expect(after.body.thread.turns.length).toBe(nTurns);   // the same in-memory stub answered
    // …and the reconnected host still drives turns in that thread
    const events = collectEvents('owner', evs => evs.some(e => e.method === 'turn/completed'));
    await sleep(150);
    await post(`/projects/owner%2Fp/agent/threads/${tid}/turn`, { text: 'after handover' });
    const evs = await events;
    expect(evs.filter(e => e.method === 'item/agentMessage/delta').map(e => e.params.delta).join('')).toContain('after handover');
  });

  it('the context item names the open documents and marks the selection in the file', async () => {
    const events = collectEvents('owner', evs => evs.some(e => e.method === 'turn/completed'));
    await sleep(150);
    await post(`/projects/owner%2Fp/agent/threads/${tid}/turn`, { text: 'about this', context: {
      docId: 'owner/p/paper.tex', layout: 'Standard', openDocs: ['owner/p/paper.tex', 'owner/p/notes.tex'],
      content: [{ type: 'paragraph', attrs: { layout: 'Standard', depth: 0 }, content: [{ type: 'text', text: 'Hello.' }] }],
    } });
    const evs = await events;
    const um = evs.find(e => e.method === 'item/completed' && e.params.item?.type === 'userMessage');
    const ctxText = um?.params.item.content?.[0]?.text ?? '';
    expect(ctxText).toContain('Also open in their workspace: owner/p/notes.tex');
    expect(ctxText).toContain('Their current selection in that document:');
    expect(ctxText).toContain('⟦SELECTION⟧Hello.⟦/SELECTION⟧');
    expect(ctxText.trimEnd().endsWith('[/context]')).toBe(true);
  });

  it('lists the models codex offers (hidden ones filtered)', async () => {
    const r = await get('/agent/models');
    expect(r.status).toBe(200);
    expect(r.body.models.map((m: any) => m.id)).toEqual(['stub-model', 'stub-mini']);
    expect(r.body.models[0].efforts).toContain('high');
    expect(r.body.models[0].isDefault).toBe(true);
  });

  it('passes the chosen model and effort through to the turn', async () => {
    const events = collectEvents('owner', evs => evs.some(e => e.method === 'turn/completed'));
    await sleep(150);
    await post(`/projects/owner%2Fp/agent/threads/${tid}/turn`, { text: 'model check', model: 'stub-mini', effort: 'high' });
    const evs = await events;
    const deltas = evs.filter(e => e.method === 'item/agentMessage/delta').map(e => e.params.delta).join('');
    expect(deltas).toContain('[model=stub-mini effort=high]');
  });

  it('steer reaches the running turn (and only for the creator)', async () => {
    expect((await post(`/projects/owner%2Fp/agent/threads/${tid}/steer`, { turnId: 'turn-1', text: 'go left' })).status).toBe(200);
    expect((await post(`/projects/owner%2Fp/agent/threads/${tid}/steer`, { turnId: 'turn-1', text: 'go right' }, 'bob')).status).toBe(403);
  });

  it('the transcript can be read back — by the creator and by another editor of the project', async () => {
    const own = await get(`/projects/owner%2Fp/agent/threads/${tid}`);
    expect(own.status).toBe(200);
    expect(own.body.mine).toBe(true);
    const items = own.body.thread.turns.flatMap((t: any) => t.items);
    expect(items.some((i: any) => i.type === 'agentMessage' && i.text.includes('hello agent'))).toBe(true);
    const bobs = await get(`/projects/owner%2Fp/agent/threads/${tid}`, 'bob');
    expect(bobs.status).toBe(200);
    expect(bobs.body.mine).toBe(false);
  });

  it('a file written in the working copy reaches the project without asking', async () => {
    const turn = await post(`/projects/owner%2Fp/agent/threads/${tid}/turn`, { text: 'please write hello somewhere' });
    expect(turn.status).toBe(200);
    const file = join(ROOT, 'projects', 'owner', 'p', 'hello.txt');
    for (let i = 0; i < 30 && !existsSync(file); i++) await sleep(100);
    expect(readFileSync(file, 'utf8')).toContain('hello from the stub agent');
  });

  it('a request to leave the sandbox is declined by the server and never shown', async () => {
    const events = collectEvents('owner', evs => evs.some(e => e.method === 'turn/completed'));
    await sleep(150);
    await post(`/projects/owner%2Fp/agent/threads/${tid}/turn`, { text: 'now write outside the copy' });
    const evs = await events;
    expect(evs.some(e => e.kind === 'request')).toBe(false);
    expect(evs.filter(e => e.method === 'item/agentMessage/delta').map(e => e.params.delta).join('')).toContain('outside write declined');
    expect((await get(`/projects/owner%2Fp/agent/threads/${tid}`)).body.approvals).toEqual([]);
  });

  it('an MCP elicitation becomes an approval card; accepting answers with an ElicitResult', async () => {
    // codex 0.149+ gates MCP tool calls with an elicitation — blanket-declining it made every
    // overlyx write tool return "user rejected MCP tool call"
    const untilRequest = collectEvents('owner', evs => evs.some(e => e.kind === 'request' && e.method === 'mcpServer/elicitation/request'), 6000);
    await sleep(150);
    const turn = post(`/projects/owner%2Fp/agent/threads/${tid}/turn`, { text: 'please use the mcp tool' });
    const request = (await untilRequest).find(e => e.kind === 'request' && e.method === 'mcpServer/elicitation/request');
    expect(request?.params.message).toContain('insert_paragraphs');
    expect(request?.params._meta?.tool_params_display?.[0]?.name).toBe('latex');
    const untilDone = collectEvents('owner', evs => evs.some(e => e.method === 'turn/completed'));
    await sleep(150);
    expect((await post(`/projects/owner%2Fp/agent/threads/${tid}/approval`, { requestId: request.requestId, decision: 'acceptForSession' })).status).toBe(200);
    const deltas = (await untilDone).filter(e => e.method === 'item/agentMessage/delta').map(e => e.params.delta).join('');
    expect(deltas).toContain('elicitation accepted persist=session');   // the ElicitResult reached the stub
    expect((await turn).status).toBe(200);
  });

  it('only project members reach the agent; only the creator drives a thread', async () => {
    expect((await get('/projects/owner%2Fp/agent/threads', 'mallory')).status).toBe(403);
    expect((await post(`/projects/owner%2Fp/agent/threads/${tid}/turn`, { text: 'hi' }, 'mallory')).status).toBe(403);
    const bob = await post(`/projects/owner%2Fp/agent/threads/${tid}/turn`, { text: 'let me in' }, 'bob');
    expect(bob.status).toBe(403);
    expect(bob.body.error).toContain('creator');
    expect((await post(`/projects/owner%2Fp/agent/threads/${tid}/approval`, { requestId: 'x', decision: 'accept' }, 'bob')).status).toBe(403);
  });

  it('signing out forgets the account', async () => {
    expect((await post('/agent/logout')).status).toBe(200);
    expect((await get('/agent/status')).body.authenticated).toBe(false);
  });
});

describe("each thread's sandbox and scope (agent.ts threadSandbox, panelThreadScope)", () => {
  const home = join(ROOT, 'data', 'agent-home', String(owner.id));
  const live = join(ROOT, 'projects', 'owner', 'p');
  const logged = (method: string) => readFileSync(join(home, 'thread-params.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(l => l.method === method);
  const turnText = async (path: string, body: object) => {
    const events = collectEvents('owner', evs => evs.some(e => e.method === 'turn/completed'));
    await sleep(150);
    const r = await post(path, body);
    const evs = await events;
    const um = evs.find(e => e.method === 'item/completed' && e.params.item?.type === 'userMessage');
    return { status: r.status, input: (um?.params.item.content ?? []).map((c: { text?: string }) => c.text ?? '').join('\n') };
  };
  let tid = '';

  it('the managed config locks codex down by default: system files only, no walking up to a repository, no sub-agents', () => {
    const cfg = readFileSync(join(home, 'config.toml'), 'utf8');
    expect(cfg).toMatch(/^default_permissions = "overlyx"$/m);
    expect(cfg).toMatch(/^project_root_markers = \[\]$/m);
    expect(cfg).toContain('":minimal" = "read"');
    expect(cfg).toContain('multi_agent = false');
    expect(cfg).toContain('exclude = ["OVERLYX_MCP_TOKEN", "CODEX_HOME"]');
    expect(cfg).not.toContain(ROOT);   // no project, no OverLyX data in the fallback
  });

  it('a new thread starts in its sandbox: no way out, only its own project, every directory untrusted', async () => {
    mkdirSync(join(ROOT, 'projects', 'mallory', 'own'), { recursive: true });   // someone else's project on the server
    const r = await post('/projects/owner%2Fp/agent/threads', { scope: 'project' });
    expect(r.status).toBe(200);
    expect(r.body.scope).toBe('project');
    tid = r.body.id;
    const start = logged('thread/start').pop();
    expect(start.approvalPolicy).toBe('never');
    expect(start.cwd).toBe(join(ROOT, 'data', 'agent-start'));
    expect(start.config.default_permissions).toBe('overlyx');
    const prof = start.config['permissions.overlyx'];
    expect(prof.network).toEqual({ enabled: false });
    expect(prof.filesystem[live]).toBe('read');
    expect(prof.filesystem[':project_roots']).toEqual({ '.': 'write' });
    // of the server's own directories, only the project, the start directory and the thread's scratch space
    const row = db.prepare('SELECT scope, mcp_key FROM agent_threads WHERE thread_id = ?').get(tid) as { scope: string; mcp_key: string };
    const scratch = join(ROOT, 'data', 'agent-scratch', row.mcp_key);
    expect(Object.keys(prof.filesystem).filter(k => k.startsWith(ROOT)).sort()).toEqual([start.cwd, scratch, live].sort());
    expect(prof.filesystem[scratch]).toBe('write');
    expect(start.config['shell_environment_policy.set']).toEqual({ HOME: scratch, TMPDIR: scratch });
    expect(Object.keys(start.config.projects)).toEqual(expect.arrayContaining([start.cwd, live, scratch]));
    expect(Object.values(start.config.projects).every(v => (v as { trust_level: string }).trust_level === 'untrusted')).toBe(true);
    expect(row.scope).toBe('project');
    expect(start.config['mcp_servers.overlyx.http_headers']).toEqual({ 'X-OverLyX-Thread': row.mcp_key });
  });

  it('a turn runs in the working copy under the same sandbox; limited to its project, the agent is told so', async () => {
    // the owner also has another project open: a thread limited to owner/p hears nothing of it
    mkdirSync(join(ROOT, 'projects', 'owner', 'q'), { recursive: true });
    registerProject('owner/q', owner.id);
    const t = await turnText(`/projects/owner%2Fp/agent/threads/${tid}/turn`, { text: 'what can you read?', scope: 'project', context: { docId: 'owner/p/paper.tex', openDocs: ['owner/p/paper.tex', 'owner/q/thesis.tex'] } });
    expect(t.status).toBe(200);
    expect(t.input).toContain('The user is editing owner/p/paper.tex');
    expect(t.input).not.toContain('owner/q');
    const elsewhere = await turnText(`/projects/owner%2Fp/agent/threads/${tid}/turn`, { text: 'and this one?', context: { docId: 'owner/q/thesis.tex' } });
    expect(elsewhere.input).not.toContain('owner/q');
    const turn = logged('turn/start').pop();
    expect(turn.cwd).toBe(join(ROOT, 'data', 'agent-work', tid, 'p'));
    expect(turn.approvalPolicy).toBe('never');
    expect(turn.sandboxPolicy).toBeNull();
    expect(t.input).toContain('limited you to this project ("owner/p")');
    expect((await get(`/projects/owner%2Fp/agent/threads/${tid}`)).body.scope).toBe('project');
  });

  it('the panel widens it again: at once for the MCP tools, and the agent hears of it with the next message', async () => {
    const { panelThreadScope } = await import('../packages/server/src/agent.ts');
    const key = (db.prepare('SELECT mcp_key FROM agent_threads WHERE thread_id = ?').get(tid) as { mcp_key: string }).mcp_key;
    expect(panelThreadScope(owner.id, key)).toEqual({ projects: ['owner/p'], readonly: false, panel: true });
    expect((await post(`/projects/owner%2Fp/agent/threads/${tid}/scope`, { scope: 'all' }, 'bob')).status).toBe(403);
    const r = await post(`/projects/owner%2Fp/agent/threads/${tid}/scope`, { scope: 'all' });
    expect(r.body).toEqual({ ok: true, scope: 'all' });
    expect(panelThreadScope(owner.id, key)).toBeNull();
    expect(panelThreadScope(editor.id, key)).toEqual({ projects: [], readonly: true, panel: true });   // not bob's thread
    const t = await turnText(`/projects/owner%2Fp/agent/threads/${tid}/turn`, { text: 'and now?', scope: 'all' });
    expect(t.input).toContain('read all their projects again');
    const t2 = await turnText(`/projects/owner%2Fp/agent/threads/${tid}/turn`, { text: 'still?' });
    expect(t2.input).not.toContain('[context] Note from the OverLyX editor');   // nothing new to tell
  });

  it('after a codex restart a thread is loaded with its sandbox again — an old thread too, read only', async () => {
    shutdownAgents();
    await sleep(400);
    await turnText(`/projects/owner%2Fp/agent/threads/${tid}/turn`, { text: 'after a restart' });
    const resumed = logged('thread/resume').pop();
    expect(resumed.threadId).toBe(tid);
    expect(resumed.approvalPolicy).toBe('never');
    expect(resumed.cwd).toBe(join(ROOT, 'data', 'agent-work', tid, 'p'));
    expect(resumed.config.default_permissions).toBe('overlyx');
    expect(Object.keys(resumed.config.projects)).toContain(resumed.cwd);
    // a thread from before the working copies: its cwd is the live project, which stays read only
    const { NATIVE_EDITS_SINCE } = await import('../packages/server/src/agent.ts');
    db.prepare('INSERT INTO agent_threads (thread_id, project, user_id, title, created_at, updated_at) VALUES (?,?,?,?,?,?)').run('old-thread', 'owner/p', owner.id, 'old', NATIVE_EDITS_SINCE - 1000, NATIVE_EDITS_SINCE - 1000);
    expect((await turnText('/projects/owner%2Fp/agent/threads/old-thread/turn', { text: 'hello old thread' })).status).toBe(200);
    const old = logged('thread/resume').pop();
    expect(old.threadId).toBe('old-thread');
    expect(old.cwd).toBe(live);
    expect(old.config['permissions.overlyx'].filesystem[':project_roots']).toEqual({ '.': 'read' });
    const key = (db.prepare("SELECT mcp_key FROM agent_threads WHERE thread_id = 'old-thread'").get() as { mcp_key: string | null }).mcp_key;
    expect(key).toBeTruthy();
    expect(old.config['mcp_servers.overlyx.http_headers']).toEqual({ 'X-OverLyX-Thread': key });
  });

  it('a thread codex will not sandbox does not run', async () => {
    writeFileSync(join(home, 'ignore-sandbox'), '');
    try {
      shutdownAgents();
      await sleep(400);
      const turn = await post(`/projects/owner%2Fp/agent/threads/${tid}/turn`, { text: 'unsandboxed?' });
      expect(turn.status).toBe(500);
      expect(turn.body.error).toContain('sandbox did not take effect');
      const fresh = await post('/projects/owner%2Fp/agent/threads');
      expect(fresh.status).toBe(500);
    } finally { rmSync(join(home, 'ignore-sandbox'), { force: true }); }
  });
});

describe('legacyThreadNote (threads from before the overlyx MCP tools)', () => {
  it('old threads are told to suggest a new thread for edits (their files are read only), new ones nothing', async () => {
    const { legacyThreadNote, MCP_TOOLS_SINCE } = await import('../packages/server/src/agent.ts');
    expect(legacyThreadNote(Date.now())).toBeNull();
    expect(legacyThreadNote(MCP_TOOLS_SINCE)).toBeNull();
    const note = legacyThreadNote(MCP_TOOLS_SINCE - 1000);
    expect(note).not.toBeNull();
    expect(note!.startsWith('[context]')).toBe(true);
    expect(note!.trimEnd().endsWith('[/context]')).toBe(true);   // the panel strips [context]…[/context] spans
    expect(note).toContain('new thread');
  });
});

describe('codex updates (scripts/update-codex.sh)', () => {
  it("reads the installed codex version through npm's bin link; the stub has none", () => {
    const npm = join(ROOT, 'npm');
    const pkg = join(npm, 'lib', 'node_modules', '@openai', 'codex');
    mkdirSync(join(pkg, 'bin'), { recursive: true });
    mkdirSync(join(npm, 'bin'), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@openai/codex', version: '0.157.0' }));
    writeFileSync(join(pkg, 'bin', 'codex.js'), '');
    symlinkSync('../lib/node_modules/@openai/codex/bin/codex.js', join(npm, 'bin', 'codex'));
    expect(installedCodexVersion('codex', `${join(ROOT, 'nowhere')}:${join(npm, 'bin')}`)).toBe('0.157.0');
    expect(installedCodexVersion(join(npm, 'bin', 'codex'))).toBe('0.157.0');
    expect(installedCodexVersion('codex', join(ROOT, 'nowhere'))).toBeNull();
    expect(installedCodexVersion(process.env.OVERLYX_CODEX_BIN!)).toBeNull();
  });
  it('the smoke test passes a codex that answers initialize and model/list', () => {
    const out = execFileSync(process.execPath, ['scripts/codex-smoke.mjs', process.env.OVERLYX_CODEX_BIN!], { encoding: 'utf8', timeout: 20000 });
    expect(out).toMatch(/answers; \d+ models/);
  });
});
