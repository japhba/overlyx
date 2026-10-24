/**
 * How the Agent panel's agents reach the AI providers and OverLyX's MCP tools without holding a
 * secret that works from anywhere else.
 *
 * - **The provider proxy**, `/internal/llm/<provider>/…`: codex threads on an OpenAI or OpenRouter
 *   key (its model providers in the managed config, agent.ts) and Claude Code threads on an
 *   Anthropic key (scripts/claude-app-server.mjs) send their model requests here with an internal
 *   credential; the proxy puts the account's own key (agentkeys.ts) on the request and streams the
 *   answer back. The key never reaches an agent, its commands or its sandbox.
 * - **Internal credentials** (`olxint_…`): what Claude Code's sandbox authenticates with, to the
 *   proxy and to /mcp. They work only on internal requests — so one that leaks out of a sandbox
 *   (its commands see their process's environment) opens nothing from outside. Codex's panel
 *   credential (an `olxmcp_` token named PANEL_AGENT, which its commands never see) is accepted by
 *   the proxy too, on internal requests only.
 * - **Internal requests**: over the internal socket, or from the loopback interface without the
 *   forwarding headers a reverse proxy (Caddy) adds to every request from outside.
 * - **The internal socket** (`data/agent-net/overlyx.sock`): Claude Code's sandbox has no network;
 *   its directory is bound in read only and a forwarder inside the sandbox
 *   (scripts/claude-sandbox-entry.mjs) turns 127.0.0.1:8765 into it. It serves the proxy and /mcp,
 *   nothing else.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import express, { type Request, type Response } from 'express';
import { config } from './config.ts';
import { db } from './db.ts';
import { PANEL_AGENT } from './agentwork.ts';
import { verifyMcpToken } from './mcpTokens.ts';
import { isKeyProvider, keyOf, upstreamOf, PROVIDER_NAMES, type KeyProvider } from './agentkeys.ts';

db.exec(`
CREATE TABLE IF NOT EXISTS agent_net_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_net_tokens_user ON agent_net_tokens(user_id);
`);

export const INTERNAL_PREFIX = 'olxint_';
const hash = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

/** A new internal credential for the account (its earlier ones stop working: one engine process holds it). */
export function mintInternalToken(userId: number): string {
  const token = INTERNAL_PREFIX + crypto.randomBytes(24).toString('base64url');
  db.transaction(() => {
    db.prepare('DELETE FROM agent_net_tokens WHERE user_id = ?').run(userId);
    db.prepare('INSERT INTO agent_net_tokens (token_hash, user_id, created_at) VALUES (?,?,?)').run(hash(token), userId, Date.now());
  })();
  return token;
}

/** The account behind an internal credential, or null. */
export function verifyInternalToken(secret: string): number | null {
  if (!secret.startsWith(INTERNAL_PREFIX)) return null;
  const row = db.prepare('SELECT user_id FROM agent_net_tokens WHERE token_hash = ?').get(hash(secret)) as { user_id: number } | undefined;
  return row ? row.user_id : null;
}

export function forgetInternalTokens(userId: number): void { db.prepare('DELETE FROM agent_net_tokens WHERE user_id = ?').run(userId); }

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/;
/** A request from this machine itself — the internal socket, or loopback with no sign of a reverse proxy in front. */
export function isInternalRequest(req: Request | http.IncomingMessage): boolean {
  const h = req.headers;
  if (h['x-forwarded-for'] !== undefined || h.forwarded !== undefined || h['x-real-ip'] !== undefined || h['x-forwarded-host'] !== undefined) return false;
  const addr = req.socket.remoteAddress;
  return addr === undefined || LOOPBACK.test(addr);
}

/** The credential a request carries: `Authorization: Bearer …` or Anthropic's `x-api-key`. */
function credentialOf(req: Request): string {
  const m = /^Bearer\s+(\S+)/i.exec(req.header('authorization') ?? '');
  return m ? m[1] : (req.header('x-api-key') ?? '').trim();
}

/** The account an internal request's credential belongs to: an internal credential or codex's panel credential. */
function accountOf(req: Request): number | null {
  const secret = credentialOf(req);
  if (!secret) return null;
  const internal = verifyInternalToken(secret);
  if (internal !== null) return internal;
  const identity = verifyMcpToken(secret);
  return identity && identity.name === PANEL_AGENT ? identity.userId : null;
}

/* ------------------------------------------------------------------ the provider proxy */

/** what an agent may call with the account's key: model requests (and their model lists), nothing that manages the account */
const ALLOWED: Record<KeyProvider, RegExp> = {
  openai: /^(POST \/v1\/responses(\/compact)?|POST \/v1\/chat\/completions|GET \/v1\/models(\/[\w.:-]+)?)$/,
  openrouter: /^(POST \/v1\/responses|POST \/v1\/chat\/completions|GET \/v1\/models)$/,
  anthropic: /^(POST \/v1\/messages(\/count_tokens)?|GET \/v1\/models(\/[\w.-]+)?)$/,
};
/** request headers that never go on: the credential, hop-by-hop, cookies, OverLyX's own */
const DROP_REQ = /^(authorization|x-api-key|cookie|host|connection|keep-alive|proxy-.*|te|trailer|transfer-encoding|upgrade|content-length|accept-encoding|forwarded|x-forwarded-.*|x-real-ip|x-overlyx-.*)$/i;
/** response headers that come back to the agent */
const KEEP_RES = /^(content-type|request-id|x-request-id|retry-after|openai-.*|x-ratelimit-.*|anthropic-.*|x-openrouter-.*|x-codex-.*)$/i;

const errorBody = (provider: KeyProvider, message: string) => provider === 'anthropic'
  ? { type: 'error', error: { type: 'authentication_error', message } }
  : { error: { message, type: 'invalid_request_error', code: 'overlyx' } };

export function llmProxy(): express.Router {
  const r = express.Router();
  r.use('/:provider', express.raw({ type: () => true, limit: '100mb' }), (req: Request, res: Response) => { void (async () => {
    const provider = req.params.provider;
    if (!isKeyProvider(provider)) { res.status(404).json({ error: 'no such provider' }); return; }
    if (!isInternalRequest(req)) { res.status(403).json(errorBody(provider, 'This endpoint is for OverLyX\'s own agents.')); return; }
    const userId = accountOf(req);
    if (userId === null) { res.status(401).json(errorBody(provider, 'unknown agent credential')); return; }
    const sub = req.url.replace(/\?.*$/, '');
    if (!ALLOWED[provider].test(`${req.method} ${sub}`)) { res.status(403).json(errorBody(provider, `${req.method} ${sub} is not something the Agent panel's agent may call with your key`)); return; }
    const key = keyOf(userId, provider);
    if (!key) { res.status(401).json(errorBody(provider, `There is no ${PROVIDER_NAMES[provider]} key on this OverLyX account any more — add it again in the Agent panel's model menu.`)); return; }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && !DROP_REQ.test(k)) headers[k] = v;
    if (provider === 'anthropic') headers['x-api-key'] = key; else headers.authorization = `Bearer ${key}`;
    if (provider === 'openrouter') { headers['x-title'] = 'OverLyX'; if (config.publicUrl) headers['http-referer'] = config.publicUrl; }
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableFinished) ac.abort(); });
    const t0 = Date.now();
    let up: globalThis.Response;
    try {
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : new Uint8Array(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
      up = await fetch(upstreamOf(provider) + req.url, { method: req.method, headers, body, signal: ac.signal });
    } catch (e) {
      if (!res.headersSent) res.status(502).json(errorBody(provider, `${PROVIDER_NAMES[provider]} could not be reached: ${(e as Error).message}`));
      return;
    }
    res.status(up.status);
    up.headers.forEach((v, k) => { if (KEEP_RES.test(k)) res.setHeader(k, v); });
    console.log(`[agent-llm] user ${userId} ${provider} ${req.method} ${sub} → ${up.status} (${Date.now() - t0} ms to headers)`);
    if (!up.body) { res.end(); return; }
    const stream = Readable.fromWeb(up.body as import('node:stream/web').ReadableStream);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  })(); });
  return r;
}

/* ------------------------------------------------------------------ the internal socket */

export const agentNetDir = () => path.join(config.dataDir, 'agent-net');
export const agentNetSocket = () => path.join(agentNetDir(), 'overlyx.sock');

/**
 * Serve the provider proxy and `mcp` (the /mcp router) on the internal socket; returns the server
 * (closed with the main one). The socket is replaced on every start: sandboxes bind its directory,
 * so the new one is what they reach after a restart.
 */
export function listenInternal(mcp: express.Router): http.Server {
  const app = express();
  app.disable('x-powered-by');
  app.use('/internal/llm', llmProxy());
  app.use('/mcp', mcp);
  app.use((_req, res) => { res.status(404).json({ error: 'not here' }); });
  fs.mkdirSync(agentNetDir(), { recursive: true });
  try { fs.unlinkSync(agentNetSocket()); } catch { /* none */ }
  const server = http.createServer(app);
  server.on('error', e => console.error('[agent-net] the internal socket failed:', e.message));
  server.listen(agentNetSocket());
  return server;
}
