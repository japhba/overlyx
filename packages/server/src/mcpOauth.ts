/**
 * OAuth 2.1 for the MCP connector (mcp.ts), so ChatGPT — and any MCP client that speaks the
 * spec's authorization flow — can connect without a hand-copied token: RFC 8414 authorization-
 * server metadata, RFC 9728 protected-resource metadata, RFC 7591 dynamic client registration
 * (ChatGPT registers itself), authorization code + PKCE (S256, public clients), refresh-token
 * rotation. The consent page uses the normal OverLyX session cookie; an approved grant mints an
 * ordinary MCP access token (mcpTokens.ts) with an expiry, named after the client — it shows up
 * with the user's other agent tokens and revoking it there cuts the connection.
 */
import express, { type Request, type Response } from 'express';
import crypto from 'node:crypto';
import { config } from './config.ts';
import { db } from './db.ts';
import { createMcpToken } from './mcpTokens.ts';

const ACCESS_MS = 30 * 24 * 3600 * 1000;   // access tokens; ChatGPT refreshes with the refresh token
const CODE_MS = 10 * 60 * 1000;

interface ClientRow { client_id: string; name: string; redirect_uris: string; created_at: number }
interface CodeRow { code: string; client_id: string; user_id: number; challenge: string; redirect_uri: string; scope: string | null; expires_at: number }
interface GrantRow { id: number; refresh_hash: string; client_id: string; user_id: number; token_id: number | null; created_at: number; last_used_at: number | null }

const sha256hex = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const rand = (n = 32) => crypto.randomBytes(n).toString('base64url');
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function oauthBase(req: Request): string {
  return (config.publicUrl || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

/** The header the MCP endpoint sends on 401 so clients discover where to authorize (RFC 9728). */
export function wwwAuthenticate(req: Request): string {
  return `Bearer resource_metadata="${oauthBase(req)}/.well-known/oauth-protected-resource"`;
}

const clientRow = (id: string) => db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(id) as ClientRow | undefined;
/** Registered (DCR) clients from the table, plus ChatGPT's CIMD form: the client_id IS its chatgpt.com metadata URL. */
const resolveClient = (id: string): ClientRow | undefined =>
  clientRow(id) ?? (/^https:\/\/chatgpt\.com\/oauth\/[\w./-]*client\.json$/.test(id)
    ? { client_id: id, name: 'ChatGPT', redirect_uris: '[]', created_at: 0 }
    : undefined);
const chatgptRedirect = (uri: string) => uri === 'https://chatgpt.com/connector_platform_oauth_redirect' || /^https:\/\/chatgpt\.com\/connector\/oauth\/[\w-]+$/.test(uri);
const redirectAllowed = (c: ClientRow, uri: string) =>
  (JSON.parse(c.redirect_uris) as string[]).includes(uri) || (c.client_id.startsWith('https://chatgpt.com/') && chatgptRedirect(uri));
const validRedirect = (uri: string) => { try { const u = new URL(uri); return u.protocol === 'https:' || u.hostname === 'localhost' || u.hostname === '127.0.0.1'; } catch { return false; } };

/* ------------------------------------------------------------- discovery */

export function wellKnownRoutes(): express.Router {
  const r = express.Router();
  const asMeta = (req: Request, res: Response) => {
    const base = oauthBase(req);
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      authorization_response_iss_parameter_supported: true,
      scopes_supported: ['mcp'],
    });
  };
  const prMeta = (req: Request, res: Response) => {
    const base = oauthBase(req);
    res.json({ resource: `${base}/mcp`, authorization_servers: [base], bearer_methods_supported: ['header'], scopes_supported: ['mcp'] });
  };
  r.get('/.well-known/oauth-authorization-server', asMeta);
  r.get('/.well-known/oauth-authorization-server/mcp', asMeta);      // path-suffix form some clients request
  r.get('/.well-known/oauth-protected-resource', prMeta);
  r.get('/.well-known/oauth-protected-resource/mcp', prMeta);
  return r;
}

/* ------------------------------------------------------------- the flow */

export function oauthRoutes(): express.Router {
  const r = express.Router();
  r.use(express.json({ limit: '64kb' }), express.urlencoded({ extended: false, limit: '64kb' }));

  /** RFC 7591: ChatGPT registers itself before the first authorization. Open registration —
   *  a client row grants nothing by itself; every token still requires a user's consent. */
  r.post('/register', (req, res) => {
    const name = String(req.body?.client_name ?? 'MCP client').slice(0, 80);
    const uris = Array.isArray(req.body?.redirect_uris) ? (req.body.redirect_uris as unknown[]).map(String).slice(0, 10) : [];
    if (!uris.length || !uris.every(validRedirect)) { res.status(400).json({ error: 'invalid_client_metadata', error_description: 'redirect_uris must be https (or localhost) URLs' }); return; }
    const clientId = 'olxc_' + rand(16);
    db.prepare('INSERT INTO oauth_clients (client_id, name, redirect_uris, created_at) VALUES (?,?,?,?)').run(clientId, name, JSON.stringify(uris), Date.now());
    res.status(201).json({
      client_id: clientId, client_name: name, redirect_uris: uris,
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    });
  });

  const page = (res: Response, status: number, body: string) => { res.status(status).type('html').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>OverLyX</title><style>body{font:15px/1.5 system-ui;max-width:26em;margin:12vh auto;padding:0 1em;color:#222}button,.btn{font:inherit;padding:8px 18px;border-radius:8px;border:1px solid #bbb;background:#f6f6f6;cursor:pointer;text-decoration:none;color:inherit;display:inline-block}button.primary{background:#2a7ae2;border-color:#2a7ae2;color:#fff}form{display:inline}.muted{color:#777}</style></head><body>${body}</body></html>`); };

  /** Validate an authorize request; returns what the consent page and the code need, or answers the response itself. */
  function checkAuthorize(req: Request, res: Response): { client: ClientRow; redirectUri: string; state: string; challenge: string; scope: string } | null {
    const q = { ...req.query as Record<string, unknown>, ...req.body as Record<string, unknown> };
    const client = resolveClient(String(q.client_id ?? ''));
    const redirectUri = String(q.redirect_uri ?? '');
    if (!client || !redirectAllowed(client, redirectUri)) { page(res, 400, '<h2>Unknown client</h2><p class="muted">This authorization link is not valid (unregistered client or redirect address).</p>'); return null; }
    const back = (err: string, desc: string) => { const u = new URL(redirectUri); u.searchParams.set('error', err); u.searchParams.set('error_description', desc); if (q.state) u.searchParams.set('state', String(q.state)); u.searchParams.set('iss', oauthBase(req)); res.redirect(u.href); };
    if (String(q.response_type ?? '') !== 'code') { back('unsupported_response_type', 'only code'); return null; }
    if (!q.code_challenge || String(q.code_challenge_method ?? 'S256') !== 'S256') { back('invalid_request', 'PKCE with S256 is required'); return null; }
    return { client, redirectUri, state: String(q.state ?? ''), challenge: String(q.code_challenge), scope: String(q.scope ?? 'mcp') };
  }

  r.get('/authorize', (req, res) => {
    const v = checkAuthorize(req, res);
    if (!v) return;
    if (!req.user) {
      page(res, 200, `<h2>Sign in first</h2><p><b>${esc(v.client.name)}</b> asks to connect to your OverLyX projects, but this browser is not signed in.</p><p><a class="btn" href="/" target="_blank" rel="noreferrer">Open OverLyX and sign in</a></p><p><a class="btn primary" href="${esc(req.originalUrl)}">I signed in — continue</a></p>`);
      return;
    }
    const keep = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'response_type']
      .map(k => `<input type="hidden" name="${k}" value="${esc(String(req.query[k] ?? (k === 'response_type' ? 'code' : k === 'code_challenge_method' ? 'S256' : '')))}">`).join('');
    page(res, 200, `<h2>Connect ${esc(v.client.name)}?</h2>
<p><b>${esc(v.client.name)}</b> wants to work with the OverLyX projects of <b>${esc(req.user.name)}</b> (@${esc(req.user.username)}) — read documents and files, propose tracked-change edits, comment, and build PDFs, with your role in each project.</p>
<p class="muted">This creates an agent token on your account; remove it any time in OverLyX under File ▸ Git repository ▸ agent tokens.</p>
<form method="post" action="/oauth/authorize">${keep}<button class="primary" name="decision" value="approve">Allow</button> <button name="decision" value="deny">Deny</button></form>`);
  });

  r.post('/authorize', (req, res) => {
    const v = checkAuthorize(req, res);
    if (!v) return;
    if (!req.user) { page(res, 401, '<h2>Not signed in</h2><p class="muted">The session expired — reopen the authorization link.</p>'); return; }
    const u = new URL(v.redirectUri);
    if (v.state) u.searchParams.set('state', v.state);
    u.searchParams.set('iss', oauthBase(req));   // RFC 9207 — lets ChatGPT use its stable redirect URI
    if (String(req.body?.decision) !== 'approve') { u.searchParams.set('error', 'access_denied'); res.redirect(u.href); return; }
    const code = 'olxac_' + rand(24);
    db.prepare('INSERT INTO oauth_codes (code, client_id, user_id, challenge, redirect_uri, scope, expires_at) VALUES (?,?,?,?,?,?,?)')
      .run(code, v.client.client_id, req.user.id, v.challenge, v.redirectUri, v.scope, Date.now() + CODE_MS);
    u.searchParams.set('code', code);
    res.redirect(u.href);
  });

  const tokenError = (res: Response, error: string, desc: string, status = 400) => res.status(status).json({ error, error_description: desc });

  /** Mint an access + refresh pair for a user/client; replaces `previous` (rotation). */
  function mintPair(userId: number, client: ClientRow, previous?: GrantRow) {
    if (previous) {
      if (previous.token_id) db.prepare('DELETE FROM mcp_tokens WHERE id = ?').run(previous.token_id);
      db.prepare('DELETE FROM oauth_grants WHERE id = ?').run(previous.id);
    }
    const { id, token } = createMcpToken(userId, `${client.name} (OAuth)`, false, Date.now() + ACCESS_MS);
    const refresh = 'olxrt_' + rand(32);
    db.prepare('INSERT INTO oauth_grants (refresh_hash, client_id, user_id, token_id, created_at) VALUES (?,?,?,?,?)')
      .run(sha256hex(refresh), client.client_id, userId, id, Date.now());
    return { access_token: token, token_type: 'Bearer', expires_in: Math.floor(ACCESS_MS / 1000), refresh_token: refresh, scope: 'mcp' };
  }

  r.post('/token', (req, res) => {
    const b = req.body ?? {};
    const grant = String(b.grant_type ?? '');
    if (grant === 'authorization_code') {
      const row = db.prepare('SELECT * FROM oauth_codes WHERE code = ?').get(String(b.code ?? '')) as CodeRow | undefined;
      if (row) db.prepare('DELETE FROM oauth_codes WHERE code = ?').run(row.code);   // single use, even on failure
      if (!row || Date.now() > row.expires_at) { tokenError(res, 'invalid_grant', 'unknown or expired code'); return; }
      const client = resolveClient(row.client_id);
      if (!client || (b.client_id && String(b.client_id) !== row.client_id)) { tokenError(res, 'invalid_client', 'client mismatch', 401); return; }
      if (b.redirect_uri && String(b.redirect_uri) !== row.redirect_uri) { tokenError(res, 'invalid_grant', 'redirect_uri mismatch'); return; }
      const verifier = String(b.code_verifier ?? '');
      if (!verifier || crypto.createHash('sha256').update(verifier).digest('base64url') !== row.challenge) { tokenError(res, 'invalid_grant', 'PKCE verification failed'); return; }
      res.json(mintPair(row.user_id, client));
      return;
    }
    if (grant === 'refresh_token') {
      const row = db.prepare('SELECT * FROM oauth_grants WHERE refresh_hash = ?').get(sha256hex(String(b.refresh_token ?? ''))) as GrantRow | undefined;
      if (!row) { tokenError(res, 'invalid_grant', 'unknown refresh token'); return; }
      const client = resolveClient(row.client_id);
      if (!client || (b.client_id && String(b.client_id) !== row.client_id)) { tokenError(res, 'invalid_client', 'client mismatch', 401); return; }
      res.json(mintPair(row.user_id, client, row));
      return;
    }
    tokenError(res, 'unsupported_grant_type', 'authorization_code or refresh_token');
  });

  return r;
}
