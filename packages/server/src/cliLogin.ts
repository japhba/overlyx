/**
 * Signing the CLI in through the browser (`overlyx auth login`), the way Claude Code and gh do:
 * the CLI opens /cli/login with a PKCE challenge and the port of a listener on 127.0.0.1; the
 * user — signed in to OverLyX in that browser — authorizes it, and is redirected back to the listener
 * with a one-time code (a plain navigation: no request from the page to the local network, which
 * Chrome would ask permission for). A CLI without a browser of its own (SSH, a server) asks for the
 * `manual` page instead, which shows the code to paste into the terminal. The CLI exchanges the code with its verifier at /cli/token
 * for a credential of its own (mcpTokens.ts, "OverLyX CLI on <computer>", revocable on its own in
 * File ▸ Git repository; the account token is not touched) — good for the CLI, git and the MCP bridge.
 * With Settings ▸ Account ▸ Fine-grained access the page also offers to narrow it to some projects
 * and/or read only (credentialScope.ts); the CLI suggests the project whose clone it runs in.
 */
import express, { type Request, type Response } from 'express';
import crypto from 'node:crypto';
import { createMcpToken } from './mcpTokens.ts';
import { db } from './db.ts';
import type { SessionUser } from './auth.ts';
import type { AccessScope } from './tokenAuth.ts';
import { SCOPE_CSS, describeScope, scopeFields, scopeFromForm } from './credentialScope.ts';

const CODE_MS = 5 * 60 * 1000;
const codes = new Map<string, { userId: number; challenge: string; client: string; scope: AccessScope | null; expires: number }>();

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const s256 = (v: string) => crypto.createHash('sha256').update(v).digest('base64url');

interface LoginRequest { port: number; state: string; challenge: string; client: string; manual: boolean; /** the project whose clone the CLI runs in (a suggestion for fine-grained access) */ project: string }

function parse(q: Record<string, unknown>): LoginRequest | null {
  const port = Number(q.port), state = String(q.state ?? ''), challenge = String(q.challenge ?? ''), client = String(q.client ?? '').trim().slice(0, 60) || 'a computer';
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return null;
  if (!/^[\w-]{8,128}$/.test(state) || !/^[\w-]{43}$/.test(challenge)) return null;
  const project = String(q.project ?? '').trim();
  return { port, state, challenge, client, manual: q.mode === 'manual', project: project.length <= 200 && /^[^/\s][^/]*\/[^/]+$/.test(project) ? project : '' };
}

function page(res: Response, status: number, body: string, formTo?: string): void {
  // (Chromium checks form-action on the redirect after the POST: the listener's origin is allowed)
  res.setHeader('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${formTo ? ' ' + formTo : ''}; frame-ancestors 'none'; base-uri 'none'`);
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>OverLyX CLI</title><style>body{font:15px/1.5 system-ui;max-width:28em;margin:12vh auto;padding:0 1em;color:#222}button,.btn{font:inherit;padding:8px 18px;border-radius:8px;border:1px solid #bbb;background:#f6f6f6;cursor:pointer;text-decoration:none;color:inherit;display:inline-block}button.primary{background:#2a7ae2;border-color:#2a7ae2;color:#fff}form{display:inline}.muted{color:#777}code.big{display:block;font-size:17px;padding:10px 12px;background:#f2f2f2;border-radius:8px;word-break:break-all;margin:8px 0;user-select:all}${SCOPE_CSS}</style></head><body>${body}</body></html>`);
}

const loopback = (v: LoginRequest) => `http://127.0.0.1:${v.port}`;

/** The authorization page; again with `error` and the choices made when the form cannot be granted. */
function consent(res: Response, v: LoginRequest, user: SessionUser, error?: string, previous?: Record<string, unknown>): void {
  const keep = (['port', 'state', 'challenge', 'client', 'project'] as const).map(k => `<input type="hidden" name="${k}" value="${esc(String(v[k]))}">`).join('')
    + (v.manual ? '<input type="hidden" name="mode" value="manual">' : '');
  const fields = scopeFields(user, { suggest: v.project || null, previous });
  page(res, error ? 400 : 200, `<h2>Sign in the OverLyX CLI?</h2>
<p>The OverLyX CLI on <b>${esc(v.client)}</b> asks to act as <b>${esc(user.name)}</b> (@${esc(user.username)}): ${fields ? 'the projects chosen below' : 'your projects'}, with your role in each — git, builds, and the AI agents on that computer that use it.</p>
<p class="muted">Only continue if you just ran <code>overlyx auth login</code> yourself. It gets a credential of its own; revoke it any time in OverLyX under File ▸ Git repository.</p>
${error ? `<p class="err">${esc(error)}</p>` : ''}<form method="post" action="/cli/login">${keep}${fields}<button class="primary" name="decision" value="approve">Authorize</button> <button name="decision" value="deny">Cancel</button></form>`, v.manual ? undefined : loopback(v));
}

export function cliLoginRoutes(): express.Router {
  const r = express.Router();

  r.get('/cli/login', (req, res) => {
    const v = parse(req.query as Record<string, unknown>);
    if (!v) { page(res, 400, '<h2>Not a valid sign-in link</h2><p class="muted">Run <code>overlyx auth login</code> again.</p>'); return; }
    if (!req.user || req.user.guest) {
      page(res, 200, `<h2>Sign in to OverLyX first</h2><p>The OverLyX CLI on <b>${esc(v.client)}</b> asks to sign in, but this browser is not signed in to OverLyX.</p><p><a class="btn" href="/" target="_blank" rel="noreferrer">Open OverLyX and sign in</a></p><p><a class="btn primary" href="${esc(req.originalUrl)}">I signed in — continue</a></p>`);
      return;
    }
    consent(res, v, req.user);
  });

  r.post('/cli/login', express.urlencoded({ extended: false }), (req, res) => {
    const v = parse(req.body ?? {});
    if (!v) { page(res, 400, '<h2>Not a valid sign-in request</h2>'); return; }
    if (!req.user || req.user.guest) { page(res, 401, '<h2>Not signed in</h2><p class="muted">The session expired — open the sign-in link again.</p>'); return; }
    if (String(req.body?.decision) !== 'approve') { page(res, 200, '<h2>Cancelled</h2><p class="muted">The CLI was not signed in. You can close this tab.</p>'); return; }
    const asked = scopeFromForm(req.user, req.body ?? {});
    if ('error' in asked) { consent(res, v, req.user, asked.error, req.body); return; }
    for (const [k, c] of codes) if (c.expires < Date.now()) codes.delete(k);
    const code = 'olxcli_' + crypto.randomBytes(24).toString('base64url');
    codes.set(code, { userId: req.user.id, challenge: v.challenge, client: v.client, scope: asked.scope, expires: Date.now() + CODE_MS });
    if (!v.manual) {
      // back to the terminal's listener
      res.redirect(`${loopback(v)}/callback?state=${encodeURIComponent(v.state)}&code=${encodeURIComponent(code)}`);
      return;
    }
    page(res, 200, `<h2>Authorized</h2><p>Paste this code into the terminal where you ran <code>overlyx auth login</code>:</p><code class="big">${esc(code)}</code><p class="muted">It works once, for five minutes, and only for that terminal.</p>`);
  });

  r.post('/cli/token', express.json(), (req, res) => {
    const code = String(req.body?.code ?? ''), verifier = String(req.body?.verifier ?? '');
    const c = codes.get(code);
    codes.delete(code);
    if (!c || c.expires < Date.now() || s256(verifier) !== c.challenge) { res.status(400).json({ error: 'invalid or expired sign-in code — run overlyx auth login again' }); return; }
    const user = db.prepare('SELECT username, display_name FROM users WHERE id = ?').get(c.userId) as { username: string; display_name: string } | undefined;
    if (!user) { res.status(400).json({ error: 'the account no longer exists' }); return; }
    const { token } = createMcpToken(c.userId, `OverLyX CLI on ${c.client}`, false, null, c.scope);
    res.json({ token, username: user.username, name: user.display_name, ...(c.scope ? { scope: c.scope, access: describeScope(c.scope) } : {}) });
  });

  return r;
}
