/**
 * The LessWrong side of the LessWrong sync: an account's authorisation and the calls the sync makes.
 *
 * LessWrong's agent API is an MCP server (`/api/mcp`, ForumMagnum app/api/mcp/mcpServer.ts) behind
 * OAuth 2.1 (`/oauth/*`, server/oauth/oauthProvider.ts): OverLyX registers itself as a client once
 * (dynamic client registration — no secret to set up on this server), the account connects with
 * PKCE on LessWrong's consent page, and the access token (90 days, no refresh: connect again then)
 * is kept encrypted. The MCP server is stateless (a fresh server per request), so each tool call is
 * one JSON-RPC POST with the bearer token, no session.
 *
 * Its tools read a draft as markdown and edit it by quoted text (read_post, replace_text,
 * insert_block, delete_block, comment_on_draft); only posts in LessWrong's rich-text (Lexical)
 * editor — not its Markdown mode. Comment threads can be read and answered only through the
 * link-sharing routes (`/api/editPost`, `/api/agent/replyToComment`), which need the draft's
 * link-sharing key ("Anyone with the link can: Edit", the key in its edit URL): with a key, threads
 * sync both ways; without one, only threads written here reach LessWrong.
 */
import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { parse as parseCookie } from 'cookie';
import { db } from '../db.ts';
import { config } from '../config.ts';
import { sealer } from '../sealed.ts';
import type { InsertLocation } from './model.ts';

/** LessWrong (another ForumMagnum site, or the tests' simulation, by OVERLYX_LESSWRONG_URL) */
export const LW_URL = (process.env.OVERLYX_LESSWRONG_URL || 'https://www.lesswrong.com').replace(/\/$/, '');
const MCP_URL = LW_URL + '/api/mcp';
const SCOPE = 'lesswrong:access';
/** the e2e tests' LessWrong: the simulation (fake.ts), connected without LessWrong's consent page */
export const LESSWRONG_STUB = process.env.OVERLYX_E2E_LESSWRONG_STUB === '1';

const { seal, unseal } = sealer('lesswrong');

db.exec(`
CREATE TABLE IF NOT EXISTS lesswrong_client (
  redirect_uri TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  client_secret TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS lesswrong_accounts (
  user_id INTEGER PRIMARY KEY,
  token TEXT NOT NULL,
  scope TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
`);

export class LessWrongAuthError extends Error {}
export class LessWrongApiError extends Error {}

/* ------------------------------------------------------------------ the account's authorisation */

export function lessWrongAccount(userId: number): { expiresAt: number } | null {
  const r = db.prepare('SELECT expires_at FROM lesswrong_accounts WHERE user_id = ?').get(userId) as { expires_at: number } | undefined;
  return r && r.expires_at > Date.now() ? { expiresAt: r.expires_at } : null;
}

function accessToken(userId: number): string {
  const r = db.prepare('SELECT token, expires_at FROM lesswrong_accounts WHERE user_id = ?').get(userId) as { token: string; expires_at: number } | undefined;
  if (!r) throw new LessWrongAuthError('LessWrong is not connected for this account — connect it in File ▸ LessWrong');
  if (r.expires_at <= Date.now()) throw new LessWrongAuthError('The LessWrong authorisation expired (after 90 days) — connect LessWrong again in File ▸ LessWrong');
  return unseal(r.token);
}

async function clientFor(redirectUri: string): Promise<{ id: string; secret: string }> {
  const row = db.prepare('SELECT client_id, client_secret FROM lesswrong_client WHERE redirect_uri = ?').get(redirectUri) as { client_id: string; client_secret: string } | undefined;
  if (row) return { id: row.client_id, secret: unseal(row.client_secret) };
  const res = await fetch(LW_URL + '/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'OverLyX', redirect_uris: [redirectUri], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'client_secret_post' }),
  });
  const c = await res.json().catch(() => ({})) as { client_id?: string; client_secret?: string; error_description?: string };
  if (!res.ok || !c.client_id || !c.client_secret) throw new LessWrongApiError('LessWrong did not register OverLyX as an app: ' + (c.error_description ?? res.status));
  db.prepare('INSERT OR REPLACE INTO lesswrong_client (redirect_uri, client_id, client_secret, created_at) VALUES (?, ?, ?, ?)').run(redirectUri, c.client_id, seal(c.client_secret), Date.now());
  return { id: c.client_id, secret: c.client_secret };
}

function redirectUri(req: Request): string {
  const base = config.publicUrl || `${req.protocol}://${req.get('host')}`;
  return base.replace(/\/$/, '') + '/api/lesswrong/callback';
}

const safeNext = (v: unknown) => (typeof v === 'string' && /^#\/[^\s]*$/.test(v) ? v : '');
const back = (res: Response, next: string, msg?: string) => {
  const base = (next || '#/').replace(/[?&]lesswrong=[^&]*/, '');
  res.redirect('/' + base + (base.includes('?') ? '&' : '?') + 'lesswrong=' + encodeURIComponent(msg ?? 'connected'));
};

/**
 * A connection under way — its state, who asked, the PKCE verifier, where to go back to — in an
 * encrypted cookie (not the server's memory: a deploy while someone is on LessWrong's consent page
 * must not lose it).
 */
interface Pending { state: string; userId: number; verifier: string; next: string; redirectUri: string; at: number }
const PENDING_COOKIE = 'ol_lw_connect';
const pendingSeal = sealer('lesswrong-connect');
const PENDING_MS = 30 * 60_000;
function pendingOf(req: Request): Pending | null {
  const raw = parseCookie(req.headers.cookie ?? '')[PENDING_COOKIE];
  if (!raw) return null;
  try { const p = JSON.parse(pendingSeal.unseal(raw)) as Pending; return Date.now() - p.at < PENDING_MS ? p : null; } catch { return null; }
}

/** GET /api/lesswrong/connect: to LessWrong's consent page (signed in there, or signing in first). */
export async function startConnect(req: Request & { user?: { id: number } }, res: Response): Promise<void> {
  const next = safeNext(req.query.next);
  if (!req.user) { res.status(401).send('Sign in first'); return; }
  if (LESSWRONG_STUB) { storeToken(req.user.id, 'stub', 90 * 86400, SCOPE); back(res, next); return; }
  try {
    const uri = redirectUri(req);
    const client = await clientFor(uri);
    const state = crypto.randomBytes(16).toString('hex');
    const verifier = crypto.randomBytes(32).toString('base64url');
    const p: Pending = { state, userId: req.user.id, verifier, next, redirectUri: uri, at: Date.now() };
    res.cookie(PENDING_COOKIE, pendingSeal.seal(JSON.stringify(p)), { httpOnly: true, sameSite: 'lax', secure: uri.startsWith('https:'), maxAge: PENDING_MS, path: '/api/lesswrong' });
    console.log(`[lesswrong] user ${req.user.id}: to LessWrong's consent page (client ${client.id}, back to ${uri})`);
    const url = new URL(LW_URL + '/oauth/authorize');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', client.id);
    url.searchParams.set('redirect_uri', uri);
    url.searchParams.set('scope', SCOPE);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', crypto.createHash('sha256').update(verifier).digest('base64url'));
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('resource', MCP_URL);
    res.redirect(url.toString());
  } catch (e) {
    console.warn(`[lesswrong] user ${req.user.id}: connecting failed before LessWrong's consent page: ${(e as Error).message.slice(0, 200)}`);
    back(res, next, (e as Error).message);
  }
}

/**
 * POST /api/lesswrong/callback (outside the signed-in API): LessWrong's consent page answers its
 * form with a 307 redirect (Next.js NextResponse.redirect), so the browser repeats the POST here —
 * cross-site, so without the session cookie (SameSite=Lax). Sent on as a GET, it has it.
 */
export function callbackPost(req: Request, res: Response): void { res.redirect(303, req.originalUrl); }

/** GET /api/lesswrong/callback (outside the signed-in API): LessWrong's answer — the token kept for the account that asked. */
export async function finishConnect(req: Request & { user?: { id: number } }, res: Response): Promise<void> {
  const p = pendingOf(req);
  const fail = (status: number, msg: string, why: string) => { console.warn(`[lesswrong] callback: ${why}`); res.status(status).type('text/plain').send(msg); };
  if (!p || p.state !== String(req.query.state ?? '')) { fail(400, 'This LessWrong connection is unknown or expired — connect again from File ▸ LessWrong.', p ? 'state does not match' : 'no connection under way (cookie missing or expired)'); return; }
  res.clearCookie(PENDING_COOKIE, { path: '/api/lesswrong' });
  if (!req.user || req.user.id !== p.userId) { fail(401, 'Sign in to OverLyX with the account that connected LessWrong, then connect again from File ▸ LessWrong.', req.user ? `signed in as ${req.user.id}, connection was user ${p.userId}` : 'not signed in'); return; }
  if (req.query.error) { console.warn(`[lesswrong] user ${p.userId}: LessWrong answered ${String(req.query.error).slice(0, 60)}`); back(res, p.next, 'LessWrong was not connected (' + String(req.query.error) + ')'); return; }
  try {
    const client = await clientFor(p.redirectUri);
    const r = await fetch(LW_URL + '/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: String(req.query.code ?? ''), redirect_uri: p.redirectUri, client_id: client.id, client_secret: client.secret, code_verifier: p.verifier, resource: MCP_URL }),
    });
    const tok = await r.json().catch(() => ({})) as { access_token?: string; expires_in?: number; scope?: string; error_description?: string; error?: string };
    if (!tok.access_token) {
      console.warn(`[lesswrong] user ${p.userId}: token exchange refused (${r.status} ${tok.error ?? ''}: ${(tok.error_description ?? '').slice(0, 200)})`);
      back(res, p.next, 'LessWrong did not grant access (' + (tok.error_description ?? tok.error ?? r.status) + ')');
      return;
    }
    storeToken(p.userId, tok.access_token, tok.expires_in ?? 90 * 86400, tok.scope ?? SCOPE);
    console.log(`[lesswrong] user ${p.userId}: connected (scope ${tok.scope ?? SCOPE}, ${Math.round((tok.expires_in ?? 0) / 86400)} days)`);
    back(res, p.next);
  } catch (e) {
    console.warn(`[lesswrong] user ${p.userId}: token exchange failed: ${(e as Error).message.slice(0, 200)}`);
    back(res, p.next, 'LessWrong was not connected: ' + (e as Error).message);
  }
}

function storeToken(userId: number, token: string, expiresIn: number, scope: string): void {
  db.prepare(`INSERT INTO lesswrong_accounts (user_id, token, scope, expires_at, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET token = excluded.token, scope = excluded.scope, expires_at = excluded.expires_at`)
    .run(userId, seal(token), scope, Date.now() + expiresIn * 1000, Date.now());
}

/** forget (and revoke) the account's LessWrong authorisation */
export async function disconnectLessWrong(userId: number): Promise<void> {
  const r = db.prepare('SELECT token FROM lesswrong_accounts WHERE user_id = ?').get(userId) as { token: string } | undefined;
  db.prepare('DELETE FROM lesswrong_accounts WHERE user_id = ?').run(userId);
  if (!r || LESSWRONG_STUB) return;
  const c = db.prepare('SELECT client_id, client_secret FROM lesswrong_client LIMIT 1').get() as { client_id: string; client_secret: string } | undefined;
  if (c) await fetch(LW_URL + '/oauth/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: unseal(r.token), client_id: c.client_id, client_secret: unseal(c.client_secret) }) }).catch(() => undefined);
}

/* ------------------------------------------------------------------ the API */

export interface LwPost { id: string; title: string; draft: boolean | null; markdown: string }
export interface LwComment { author: string; time: number | null; text: string }
export interface LwThread { id: string; type: string; quote: string; comments: LwComment[] }

/** the result of an edit: whether it was made, and LessWrong's note (why not) */
export interface LwEdit { ok: boolean; note: string }

export interface LessWrongApi {
  readPost(postId: string, key: string | null): Promise<LwPost>;
  replaceText(postId: string, key: string | null, a: { quote: string; replacement: string; agentName: string }): Promise<LwEdit>;
  insertBlock(postId: string, key: string | null, a: { location: InsertLocation; markdown: string; agentName: string }): Promise<LwEdit>;
  deleteBlock(postId: string, key: string | null, a: { prefix: string; agentName: string }): Promise<LwEdit>;
  commentOnDraft(postId: string, key: string | null, a: { quote?: string; comment: string; agentName: string }): Promise<{ threadId: string | null; anchored: boolean }>;
  /** the open comment threads (only with the draft's link-sharing key) */
  readThreads(postId: string, key: string): Promise<LwThread[]>;
  /** a reply in a thread (only with the draft's link-sharing key) */
  replyToComment(postId: string, key: string, a: { threadId: string; comment: string; agentName: string }): Promise<void>;
}

let rpcId = 0;

/** one MCP tool call: its text */
async function callTool(token: string, name: string, args: Record<string, unknown>): Promise<string> {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(90_000),
  });
  if (res.status === 401) throw new LessWrongAuthError('LessWrong refused the authorisation — connect LessWrong again in File ▸ LessWrong');
  const raw = await res.text();
  // (a JSON answer, or one server-sent event carrying it)
  const json = (res.headers.get('content-type') ?? '').includes('text/event-stream')
    ? raw.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).filter(Boolean).pop() ?? ''
    : raw;
  let body: { result?: { content?: { type: string; text?: string }[]; isError?: boolean }; error?: { message?: string } };
  try { body = JSON.parse(json); } catch { throw new LessWrongApiError(`LessWrong answered ${res.status}: ${raw.slice(0, 200)}`); }
  if (body.error) throw new LessWrongApiError('LessWrong: ' + (body.error.message ?? 'error'));
  const text = (body.result?.content ?? []).map(c => c.text ?? '').join('\n');
  if (body.result?.isError) throw new LessWrongApiError(explain(text));
  return text;
}

/** LessWrong's refusals, with what to do */
function explain(text: string): string {
  if (/unauthori[sz]ed|access denied|not found/i.test(text)) return `LessWrong: ${text} — the draft must be yours (or shared with you to edit), in LessWrong's rich-text editor rather than Markdown mode`;
  return 'LessWrong: ' + text;
}

const parseJson = <T>(text: string): T => { try { return JSON.parse(text) as T; } catch { throw new LessWrongApiError('LessWrong: ' + text.slice(0, 300)); } };

/** read_post's answer: `# <title>`, `postId: …`, `draft: …`, a blank line, the markdown */
export function parseReadPost(text: string, postId: string): LwPost {
  const m = /^# (.*)\n\npostId: (\S+)\ndraft: (\S+)\n\n?/.exec(text);
  if (!m) return { id: postId, title: '', draft: null, markdown: text };
  return { id: m[2], title: m[1], draft: m[3] === 'true' ? true : m[3] === 'false' ? false : null, markdown: text.slice(m[0].length) };
}

/**
 * The "Comment Threads" section of `/api/editPost` (app/api/(markdown)/editorMarkdownUtils.tsx
 * serializeThreadsToMarkdown): `### Thread \`id\` · type`, the quote as `> ` lines, then
 * `**author** (YYYY-MM-DD, HH:MM): text` per comment (UTC).
 */
export function parseThreads(page: string): LwThread[] {
  const at = page.indexOf('## Comment Threads');
  if (at < 0) return [];
  const out: LwThread[] = [];
  let cur: LwThread | null = null, msg: LwComment | null = null;
  for (const line of page.slice(at).split('\n')) {
    const t = /^### Thread `([^`]+)` · (\S+)/.exec(line);
    if (t) { cur = { id: t[1], type: t[2], quote: '', comments: [] }; msg = null; out.push(cur); continue; }
    if (!cur) continue;
    if (/^(\* \* \*|---+|___+)\s*$/.test(line) || /^#{1,2} /.test(line)) { cur = null; msg = null; continue; }   // the section ends
    const c = /^\*\*(.+?)\*\* \((\d{4})-(\d\d)-(\d\d), (\d\d):(\d\d)\): ?(.*)$/.exec(line);
    if (c) { msg = { author: c[1], time: Date.UTC(+c[2], +c[3] - 1, +c[4], +c[5], +c[6]), text: c[7] }; cur.comments.push(msg); continue; }
    if (!msg && line.startsWith('>')) { cur.quote += (cur.quote ? '\n' : '') + line.replace(/^> ?/, ''); continue; }
    if (msg) msg.text += '\n' + line;
  }
  for (const th of out) for (const c of th.comments) c.text = c.text.trim();
  return out;
}

/** The agent API with the account's authorisation. */
export function lessWrongApi(userId: number): LessWrongApi {
  const tool = (name: string, args: Record<string, unknown>) => callTool(accessToken(userId), name, args);
  const withKey = (key: string | null) => (key ? { key } : {});
  const edit = (r: { replaced?: boolean; inserted?: boolean; deleted?: boolean; note?: string }) => ({ ok: !!(r.replaced ?? r.inserted ?? r.deleted), note: r.note ?? '' });
  return {
    async readPost(postId, key) {
      return parseReadPost(await tool('read_post', { postId, ...withKey(key) }), postId);
    },
    async replaceText(postId, key, a) {
      return edit(parseJson(await tool('replace_text', { postId, ...withKey(key), quote: a.quote, replacement: a.replacement, mode: 'edit', agentName: a.agentName })));
    },
    async insertBlock(postId, key, a) {
      return edit(parseJson(await tool('insert_block', { postId, ...withKey(key), location: a.location, markdown: a.markdown, mode: 'edit', agentName: a.agentName })));
    },
    async deleteBlock(postId, key, a) {
      return edit(parseJson(await tool('delete_block', { postId, ...withKey(key), prefix: a.prefix, mode: 'edit', agentName: a.agentName })));
    },
    async commentOnDraft(postId, key, a) {
      const r = parseJson<{ threadId?: string; anchorStatus?: string }>(await tool('comment_on_draft', { postId, ...withKey(key), ...(a.quote ? { quote: a.quote } : {}), comment: a.comment, agentName: a.agentName }));
      return { threadId: r.threadId ?? null, anchored: r.anchorStatus === 'attached_by_quote_match' };
    },
    async readThreads(postId, key) {
      const res = await fetch(`${LW_URL}/api/editPost?postId=${encodeURIComponent(postId)}&key=${encodeURIComponent(key)}`, { headers: { accept: 'text/markdown' }, signal: AbortSignal.timeout(60_000) });
      const page = await res.text();
      if (/^(Unable to access shared draft|No accessible shared draft|This draft uses the)/.test(page)) throw new LessWrongApiError('LessWrong: ' + page.slice(0, 300));
      return parseThreads(page);
    },
    async replyToComment(postId, key, a) {
      const res = await fetch(`${LW_URL}/api/agent/replyToComment`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ postId, key, threadId: a.threadId, comment: a.comment, agentName: a.agentName }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new LessWrongApiError('LessWrong: ' + ((await res.json().catch(() => ({}))) as { error?: string }).error);
    },
  };
}

/** A post's id and link-sharing key from what was pasted: an edit URL (`/editPost?postId=…&key=…`), a post's URL (`/posts/<id>/…`) or an id. */
export function parsePostRef(input: string): { postId: string; key: string | null } | null {
  const s = input.trim();
  if (/^[A-Za-z0-9]{17}$/.test(s)) return { postId: s, key: null };
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (!/(^|\.)lesswrong\.com$/i.test(u.hostname) && u.origin !== LW_URL) return null;
  const id = u.searchParams.get('postId') ?? /\/posts\/([A-Za-z0-9]{17})(\/|$)/.exec(u.pathname)?.[1] ?? null;
  if (!id || !/^[A-Za-z0-9]+$/.test(id)) return null;
  const key = u.searchParams.get('key');
  return { postId: id, key: key && /^[A-Za-z0-9_-]+$/.test(key) ? key : null };
}
