/**
 * The MCP OAuth flow (packages/server/src/mcpOauth.ts) and the global all-projects endpoint
 * (mcp.ts at /mcp), the way ChatGPT connects: discovery metadata, dynamic client registration,
 * the consent page on the session cookie, code + PKCE → token, the token working against /mcp
 * (list_projects, project-scoped tools, the search/fetch pair), refresh-token rotation, and the
 * per-call access rules.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';

const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-oauth-test');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'projects', 'p'), { recursive: true });
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');

const { wellKnownRoutes, oauthRoutes } = await import('../packages/server/src/mcpOauth.ts');
const { mcpRouter } = await import('../packages/server/src/mcp.ts');
const { createUser, toSessionUser, signSession, authMiddleware } = await import('../packages/server/src/auth.ts');
const { registerProject } = await import('../packages/server/src/access.ts');
const { createMcpToken } = await import('../packages/server/src/mcpTokens.ts');

const owner = createUser('owner', 'Owner', 'pw');
const outsider = createUser('mallory', 'Mallory', 'pw');
registerProject('p', owner.id);
writeFileSync(join(ROOT, 'projects', 'p', 'a.tex'),
  '\\documentclass{article}\n\\begin{document}\nChaotic dynamics of recurrent networks.\n\\end{document}\n');
const cookie = 'ol_session=' + signSession(toSessionUser(owner));

const app = express();
app.use(authMiddleware);
app.use(wellKnownRoutes());
app.use('/oauth', oauthRoutes());
app.use('/mcp', mcpRouter());
const server = http.createServer(app);
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

afterAll(() => { server.close(); rmSync(ROOT, { recursive: true, force: true }); });

const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const pkce = () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
};

/** register a client, walk the consent flow, return an authorization code for `challenge`. */
async function getCode(clientId: string, challenge: string): Promise<string> {
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', state: 'st4te', code_challenge: challenge, code_challenge_method: 'S256', scope: 'mcp' });
  const res = await fetch(`${base}/oauth/authorize`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ ...Object.fromEntries(q), decision: 'approve' }),
  });
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.get('location')!);
  expect(loc.origin + loc.pathname).toBe(REDIRECT);
  expect(loc.searchParams.get('state')).toBe('st4te');
  expect(loc.searchParams.get('iss')).toBeTruthy();
  return loc.searchParams.get('code')!;
}

async function tokenReq(body: Record<string, string>): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form(body) });
  return { status: res.status, body: await res.json() };
}

let rpcId = 0;
function parseBody(raw: string, contentType: string | null): any {
  if (contentType?.includes('text/event-stream')) {
    const line = raw.split('\n').find(l => l.startsWith('data:'));
    return line ? JSON.parse(line.slice(5).trim()) : raw;
  }
  try { return JSON.parse(raw); } catch { return raw; }
}
async function rpc(token: string | null, method: string, params?: unknown, path = '/mcp'): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const raw = await res.text();
  return { status: res.status, body: res.status === 200 ? parseBody(raw, res.headers.get('content-type')) : raw, headers: res.headers };
}
async function callTool(token: string, name: string, args: unknown): Promise<any> {
  const { status, body } = await rpc(token, 'tools/call', { name, arguments: args });
  expect(status).toBe(200);
  const text = body.result.content[0].text;
  if (body.result.isError) throw new Error(text);
  try { return JSON.parse(text); } catch { return text; }
}

let clientId = '';
let access = '';
let refresh = '';

describe('discovery and registration', () => {
  it('serves the authorization-server metadata ChatGPT needs', async () => {
    const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect(meta.code_challenge_methods_supported).toContain('S256');
    expect(meta.registration_endpoint).toContain('/oauth/register');
    expect(meta.authorization_response_iss_parameter_supported).toBe(true);
    const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
    expect(prm.resource.endsWith('/mcp')).toBe(true);
    expect(prm.authorization_servers).toHaveLength(1);
  });

  it('a 401 from the MCP endpoint points at the resource metadata', async () => {
    const r = await rpc(null, 'tools/list');
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toContain('resource_metadata=');
  });

  it('registers a client dynamically (RFC 7591)', async () => {
    const res = await fetch(`${base}/oauth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'ChatGPT test', redirect_uris: [REDIRECT] }),
    });
    expect(res.status).toBe(201);
    const j = await res.json();
    clientId = j.client_id;
    expect(clientId).toMatch(/^olxc_/);
    expect(j.token_endpoint_auth_method).toBe('none');
  });
});

describe('authorization + token', () => {
  it('asks to sign in without a session, shows consent with one', async () => {
    const q = `client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&code_challenge=abc&code_challenge_method=S256`;
    const anon = await (await fetch(`${base}/oauth/authorize?${q}`)).text();
    expect(anon).toContain('Sign in first');
    const html = await (await fetch(`${base}/oauth/authorize?${q}`, { headers: { cookie } })).text();
    expect(html).toContain('Connect ChatGPT test?');
    expect(html).toContain('Owner');
  });

  it('code + PKCE exchange yields a working token pair; codes are single-use', async () => {
    const { verifier, challenge } = pkce();
    const code = await getCode(clientId, challenge);
    const t = await tokenReq({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier });
    expect(t.status).toBe(200);
    expect(t.body.access_token).toMatch(/^olxmcp_/);
    expect(t.body.refresh_token).toMatch(/^olxrt_/);
    expect(t.body.expires_in).toBeGreaterThan(3600);
    access = t.body.access_token; refresh = t.body.refresh_token;
    const again = await tokenReq({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier });
    expect(again.status).toBe(400);
    expect(again.body.error).toBe('invalid_grant');
  });

  it('a wrong PKCE verifier is refused', async () => {
    const { challenge } = pkce();
    const code = await getCode(clientId, challenge);
    const t = await tokenReq({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: 'not-the-verifier-at-all-0000000000000000000' });
    expect(t.status).toBe(400);
    expect(t.body.error).toBe('invalid_grant');
  });
});

describe('the token against the all-projects endpoint', () => {
  it('list_projects, then project-scoped tools', async () => {
    const projects = await callTool(access, 'list_projects', {});
    expect(projects.map((p: any) => p.project)).toContain('p');
    const r = await callTool(access, 'read_document', { project: 'p', path: 'a.tex' });
    expect(r.text).toContain('Chaotic dynamics');
    await expect(callTool(access, 'read_document', { path: 'a.tex' })).rejects.toThrow(/No project given/);
  });

  it('search finds a passage and fetch returns the file, ChatGPT-shaped', async () => {
    const s = await callTool(access, 'search', { query: 'chaotic recurrent' });
    expect(s.results[0].id).toBe('p/a.tex');
    expect(s.results[0].url).toContain('#/p/a.tex');
    const f = await callTool(access, 'fetch', { id: 'p/a.tex' });
    expect(f.text).toContain('Chaotic dynamics');
    expect(f.metadata).toMatchObject({ project: 'p', path: 'a.tex' });
  });

  it('roles are enforced per call', async () => {
    const t = createMcpToken(outsider.id, 'outside-agent').token;
    const projects = await callTool(t, 'list_projects', {});
    expect(projects.map((p: any) => p.project)).not.toContain('p');
    await expect(callTool(t, 'read_document', { project: 'p', path: 'a.tex' })).rejects.toThrow(/no access/);
    await expect(callTool(t, 'fetch', { id: 'p/a.tex' })).rejects.toThrow(/no access/);
  });
});

describe('refresh rotation', () => {
  it('rotates the pair and kills the old access token', async () => {
    const t = await tokenReq({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId });
    expect(t.status).toBe(200);
    expect(t.body.access_token).toMatch(/^olxmcp_/);
    const old = await rpc(access, 'tools/list');
    expect(old.status).toBe(401);
    const projects = await callTool(t.body.access_token, 'list_projects', {});
    expect(projects.map((p: any) => p.project)).toContain('p');
    const reuse = await tokenReq({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId });
    expect(reuse.status).toBe(400);
  });
});
