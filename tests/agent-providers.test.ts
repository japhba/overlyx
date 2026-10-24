/**
 * The Agent panel's providers besides the ChatGPT sign-in (agentkeys.ts, agentnet.ts, agent.ts):
 * API keys checked with the provider and kept for the account, the model picker's list across
 * providers, codex threads started on the account's OpenAI / OpenRouter key (codex's model
 * provider pointing at the proxy), the proxy itself — the account's key on the way out, internal
 * requests and known agent credentials only, model requests only — and a Claude engine thread on
 * the Anthropic key: started, one turn streamed over the events route (the real engine and Claude
 * Code against a stand-in Anthropic API; skipped where the Agent SDK's Claude Code or bwrap is missing).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import express from 'express';

const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-agent-providers-test');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'projects', 'owner', 'p'), { recursive: true });
writeFileSync(join(ROOT, 'projects', 'owner', 'p', 'paper.tex'), '\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n');
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');
process.env.OVERLYX_CODEX_BIN = resolve(process.cwd(), 'scripts/codex-stub.mjs');

/* the providers' stand-in: keys are checked, models listed, model requests echo the credential they arrived with */
const seen: { path: string; auth: string; key: string }[] = [];
const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    const auth = String(req.headers.authorization ?? ''), key = String(req.headers['x-api-key'] ?? '');
    seen.push({ path: `${req.method} ${req.url}`, auth, key });
    const json = (status: number, v: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
    const good = /good/.test(auth + key);
    if (req.url?.startsWith('/openai/v1/models')) return good ? json(200, { data: [] }) : json(401, { error: { message: 'bad key' } });
    if (req.url?.startsWith('/openrouter/v1/key')) return good ? json(200, { data: { label: 'x' } }) : json(401, { error: { message: 'bad key' } });
    if (req.url?.startsWith('/openrouter/v1/models')) return json(200, { data: [
      { id: 'anthropic/claude-sonnet-9', name: 'Anthropic: Claude Sonnet 9', created: 30, supported_parameters: ['tools', 'reasoning'] },
      { id: 'anthropic/claude-sonnet-9:batch', name: 'batch', created: 30, supported_parameters: ['tools', 'reasoning'] },
      { id: 'google/gemini-9-pro', name: 'Google: Gemini 9 Pro', created: 20, supported_parameters: ['tools', 'reasoning'] },
      { id: 'google/gemini-9-image', name: 'Google: Gemini 9 Image', created: 25, supported_parameters: ['tools', 'reasoning'] },
      { id: 'openai/gpt-9-chat', name: 'OpenAI: GPT-9 Chat', created: 10, supported_parameters: ['temperature'] },
    ] });
    if (req.url?.startsWith('/anthropic/v1/models')) {
      if (!good) return json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
      return json(200, { data: [{ type: 'model', id: 'claude-test-9', display_name: 'Claude Test 9', created_at: '2026-10-01T00:00:00Z' }], has_more: false, first_id: 'claude-test-9', last_id: 'claude-test-9' });
    }
    if (req.url?.startsWith('/anthropic/v1/messages')) {
      if (req.url.includes('count_tokens')) return json(200, { input_tokens: 1 });
      const j = JSON.parse(body || '{}');
      if (!j.stream) return json(200, { id: 'm', type: 'message', role: 'assistant', model: j.model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = (e: string, d: object) => res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
      ev('message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: j.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
      ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello from ' } });
      ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Claude.' } });
      ev('content_block_stop', { type: 'content_block_stop', index: 0 });
      ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } });
      ev('message_stop', { type: 'message_stop' });
      res.end();
      return;
    }
    if (req.url?.includes('/v1/responses')) return json(200, { echo: { auth, body: JSON.parse(body || '{}') } });
    json(404, {});
  });
});
await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
const up = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
process.env.OVERLYX_LLM_UPSTREAM_OPENAI = `${up}/openai`;
process.env.OVERLYX_LLM_UPSTREAM_OPENROUTER = `${up}/openrouter`;
process.env.OVERLYX_LLM_UPSTREAM_ANTHROPIC = `${up}/anthropic`;

const { agentRoutes, shutdownAgents } = await import('../packages/server/src/agent.ts');
const { llmProxy, listenInternal, mintInternalToken, isInternalRequest } = await import('../packages/server/src/agentnet.ts');
const { createUser } = await import('../packages/server/src/auth.ts');
const { registerProject } = await import('../packages/server/src/access.ts');
const { createMcpToken } = await import('../packages/server/src/mcpTokens.ts');
const { db } = await import('../packages/server/src/db.ts');

const owner = createUser('owner', 'Owner', 'pw');
const other = createUser('olga', 'Olga', 'pw');
registerProject('owner/p', owner.id);

const users = { owner, olga: other } as Record<string, { id: number; username: string }>;
const app = express();
app.use('/internal/llm', llmProxy());
app.use(express.json());
app.use((req, _res, next) => { (req as any).user = { ...users[String(req.headers['x-user'] ?? 'owner')], name: 'x', color: '#000', isAdmin: false }; next(); });
app.use('/api', agentRoutes());
const server = http.createServer(app);
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const base = `${origin}/api`;
// the sandboxed Claude engine's way in: the MCP tools stand-in (the proxy is the real one)
const mcpSeen: string[] = [];
const mcp = express.Router();
mcp.use(express.json(), (req, res) => {
  mcpSeen.push(String(req.headers['x-overlyx-thread'] ?? ''));
  const j = req.body ?? {};
  if (j.method === 'initialize') { res.json({ jsonrpc: '2.0', id: j.id, result: { protocolVersion: j.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '1' } } }); return; }
  if (j.method === 'tools/list') { res.json({ jsonrpc: '2.0', id: j.id, result: { tools: [] } }); return; }
  res.status(202).end();
});
const internal = listenInternal(mcp);

afterAll(() => { shutdownAgents(); server.close(); internal.close(); upstream.close(); rmSync(ROOT, { recursive: true, force: true }); });

const asUser = (u: string) => ({ 'x-user': u, 'content-type': 'application/json' });
const call = async (method: string, path: string, body?: unknown, u = 'owner') => { const r = await fetch(base + path, { method, headers: asUser(u), ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: r.status, body: await r.json() }; };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('API keys', () => {
  it('are checked with the provider before they are kept', async () => {
    expect((await call('PUT', '/agent/keys/openrouter', { key: 'sk-or-bad' })).status).toBe(400);
    expect((await call('PUT', '/agent/keys/openrouter', { key: 'sk-or-good-1234' })).body).toMatchObject({ ok: true, hint: '…1234' });
    expect((await call('PUT', '/agent/keys/openai', { key: 'sk-good-openai-5678' })).body).toMatchObject({ ok: true, hint: '…5678' });
    expect((await call('PUT', '/agent/keys/nonsense', { key: 'x' })).status).toBe(404);
  });

  it('are sealed at rest and shown only by their last characters', async () => {
    const rows = db.prepare('SELECT sealed FROM agent_keys WHERE user_id = ?').all(owner.id) as { sealed: string }[];
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.sealed).not.toContain('good');
    const st = (await call('GET', '/agent/status')).body;
    expect(st.authenticated).toBe(true);
    expect(st.providers.openrouter).toMatchObject({ connected: true, hint: '…1234' });
    expect(st.providers.chatgpt.connected).toBe(false);
    expect((await call('GET', '/agent/status', undefined, 'olga')).body.authenticated).toBe(false);
  });

  it('the picker lists every provider the account has, each model tagged with its provider', async () => {
    const { models } = (await call('GET', '/agent/models')).body as { models: { id: string; provider: string; isDefault: boolean }[] };
    // codex's catalogue on the OpenAI key; OpenRouter's thinned to tool-calling text models, no variants
    expect(models.filter(m => m.provider === 'openai').map(m => m.id)).toEqual(['stub-model', 'stub-mini']);
    expect(models.filter(m => m.provider === 'openrouter').map(m => m.id)).toEqual(['anthropic/claude-sonnet-9', 'google/gemini-9-pro']);
    expect(models.find(m => m.id === 'anthropic/claude-sonnet-9')?.isDefault).toBe(true);
    expect(models.some(m => m.provider === 'chatgpt')).toBe(false);
  });
});

describe('codex threads on a key', () => {
  it('start with codex\'s model provider for the key, and without web search on OpenRouter', async () => {
    expect((await call('POST', '/projects/owner%2Fp/agent/threads', { provider: 'openrouter', model: 'x' }, 'olga')).status).toBe(403);   // not in the project
    expect((await call('POST', '/projects/owner%2Fp/agent/threads', { provider: 'anthropic', model: 'x' })).status).toBe(400);   // no key yet
    const r = await call('POST', '/projects/owner%2Fp/agent/threads', { provider: 'openrouter', model: 'google/gemini-9-pro' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ provider: 'openrouter' });
    const log = readFileSync(join(ROOT, 'data', 'agent-home', String(owner.id), 'thread-params.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const start = log.find(l => l.method === 'thread/start' && l.threadId === r.body.id);
    expect(start).toMatchObject({ modelProvider: 'overlyx-openrouter', model: 'google/gemini-9-pro' });
    expect(start.config['tools.web_search']).toBe(false);
    const cfg = readFileSync(join(ROOT, 'data', 'agent-home', String(owner.id), 'config.toml'), 'utf8');
    expect(cfg).toContain('[model_providers.overlyx-openrouter]');
    expect(cfg).toMatch(/base_url = "http:\/\/127\.0\.0\.1:\d+\/internal\/llm\/openrouter\/v1"/);
    const list = (await call('GET', '/projects/owner%2Fp/agent/threads')).body.threads;
    expect(list[0]).toMatchObject({ id: r.body.id, provider: 'openrouter', model: 'google/gemini-9-pro' });
  });
});

describe('the provider proxy', () => {
  const panelToken = createMcpToken(owner.id, 'Agent panel', true).token;
  const otherToken = createMcpToken(owner.id, 'some agent', true).token;
  const send = (path: string, headers: Record<string, string>, method = 'POST') => fetch(`${origin}/internal/llm${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(method === 'POST' ? { body: '{"model":"m","input":"hi"}' } : {}) });

  it('puts the account\'s key on an internal request from an agent credential', async () => {
    const r = await send('/openrouter/v1/responses', { authorization: `Bearer ${panelToken}` });
    expect(r.status).toBe(200);
    const j = await r.json() as { echo: { auth: string; body: { input: string } } };
    expect(j.echo.auth).toBe('Bearer sk-or-good-1234');
    expect(j.echo.body.input).toBe('hi');
    const internalToken = mintInternalToken(owner.id);
    const r2 = await send('/openai/v1/responses', { authorization: `Bearer ${internalToken}` });
    expect(((await r2.json()) as { echo: { auth: string } }).echo.auth).toBe('Bearer sk-good-openai-5678');
  });

  it('refuses requests from outside, unknown credentials, other tokens and anything but model requests', async () => {
    expect((await send('/openrouter/v1/responses', { authorization: `Bearer ${panelToken}`, 'x-forwarded-for': '203.0.113.9' })).status).toBe(403);
    expect((await send('/openrouter/v1/responses', {})).status).toBe(401);
    expect((await send('/openrouter/v1/responses', { authorization: 'Bearer olxint_made-up' })).status).toBe(401);
    expect((await send('/openrouter/v1/responses', { authorization: `Bearer ${otherToken}` })).status).toBe(401);
    expect((await send('/openai/v1/files', { authorization: `Bearer ${panelToken}` })).status).toBe(403);
    expect((await send('/openai/v1/organization/api_keys', { authorization: `Bearer ${panelToken}` }, 'GET')).status).toBe(403);
    // a provider the account has no key for
    expect((await send('/anthropic/v1/messages', { 'x-api-key': panelToken })).status).toBe(401);
    expect(seen.some(s => s.path.includes('/v1/files') || s.path.includes('api_keys'))).toBe(false);
  });

  it('tells internal requests from forwarded ones', () => {
    const req = (addr: string | undefined, headers: Record<string, string> = {}) => ({ headers, socket: { remoteAddress: addr } }) as any;
    expect(isInternalRequest(req('127.0.0.1'))).toBe(true);
    expect(isInternalRequest(req(undefined))).toBe(true);   // the internal socket
    expect(isInternalRequest(req('::ffff:127.0.0.1'))).toBe(true);
    expect(isInternalRequest(req('127.0.0.1', { 'x-forwarded-for': '1.2.3.4' }))).toBe(false);
    expect(isInternalRequest(req('127.0.0.1', { forwarded: 'for=1.2.3.4' }))).toBe(false);
    expect(isInternalRequest(req('10.0.0.5'))).toBe(false);
  });
});

const claudeInstalled = (() => {
  try { execFileSync('bwrap', ['--version'], { stdio: 'ignore' }); } catch { return false; }
  return existsSync(resolve(process.cwd(), 'node_modules/@anthropic-ai/claude-agent-sdk/package.json'));
})();

describe.skipIf(!claudeInstalled)('a Claude engine thread on the Anthropic key', () => {
  it('starts, runs a turn in Claude Code and streams its answer', async () => {
    expect((await call('PUT', '/agent/keys/anthropic', { key: 'sk-ant-good-9999' })).body).toMatchObject({ ok: true });
    const { models } = (await call('GET', '/agent/models')).body as { models: { id: string; provider: string }[] };
    expect(models.filter(m => m.provider === 'anthropic').map(m => m.id)).toEqual(['claude-test-9']);
    const t = await call('POST', '/projects/owner%2Fp/agent/threads', { provider: 'anthropic', model: 'claude-test-9' });
    expect(t.status).toBe(200);
    const tid = t.body.id as string;
    // the events of both engines come over the one stream
    const res = await fetch(base + '/projects/owner%2Fp/agent/events', { headers: asUser('owner') });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    await sleep(150);
    const turn = await call('POST', `/projects/owner%2Fp/agent/threads/${tid}/turn`, { text: 'say hello', clientMessageId: 'local-c1' });
    expect(turn.status).toBe(200);
    let text = '', buf = '';
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline && !/"turn\/completed"/.test(text)) {
      const { value, done } = await Promise.race([reader.read(), sleep(deadline - Date.now()).then(() => ({ value: undefined, done: true }))]) as { value?: Uint8Array; done: boolean };
      if (done || !value) break;
      buf += dec.decode(value, { stream: true });
      text = buf;
    }
    void reader.cancel().catch(() => undefined);
    const evs = buf.split('\n\n').map(c => c.split('\n').find(l => l.startsWith('data:'))).filter(Boolean).map(l => { try { return JSON.parse(l!.slice(5)); } catch { return null; } }).filter(Boolean);
    const deltas = evs.filter(e => e.method === 'item/agentMessage/delta').map(e => e.params.delta).join('');
    expect(deltas).toBe('Hello from Claude.');
    expect(evs.find(e => e.method === 'item/completed' && e.params.item?.type === 'userMessage')?.params.item.clientId).toBe('local-c1');
    expect(evs.find(e => e.method === 'turn/completed')?.params.turn.status).toBe('completed');
    // the model saw the account's key — the engine only its internal credential
    expect(seen.filter(s => s.path.startsWith('POST /anthropic/v1/messages')).every(s => s.key === 'sk-ant-good-9999')).toBe(true);
    expect(mcpSeen.length).toBeGreaterThan(0);
    const read = await call('GET', `/projects/owner%2Fp/agent/threads/${tid}`);
    expect(read.body.provider).toBe('anthropic');
    expect(read.body.thread.turns[0].items.map((i: { type: string }) => i.type)).toEqual(['userMessage', 'agentMessage']);
  }, 120_000);
});
