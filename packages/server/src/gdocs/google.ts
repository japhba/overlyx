/**
 * The Google side of the Google Docs sync: an account's Drive authorisation (OAuth, scope
 * `drive.file` — only the files OverLyX creates or is given — kept as an encrypted refresh token)
 * and the few Docs / Drive API calls the sync makes (GoogleApi). Tests replace the API with a
 * simulation (tests/gdocs-fake.ts).
 *
 * Connecting reuses the sign-in's OAuth client and redirect address (/api/auth/google/callback,
 * auth.ts hands the callback over here when the state is a Drive connection's), so nothing new has
 * to be registered with Google — only the Docs and Drive APIs enabled for the client's project.
 */
import crypto from 'node:crypto';
import type { Request as ExpressRequest, Response } from 'express';
import { db } from '../db.ts';
import { config, JWT_SECRET } from '../config.ts';
import type { DocsDocument } from './model.ts';
import type { Request } from './edits.ts';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

db.exec(`
CREATE TABLE IF NOT EXISTS google_drive (
  user_id INTEGER PRIMARY KEY,
  email TEXT,
  refresh_token TEXT NOT NULL,
  access_token TEXT,
  expires_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
`);

/* ------------------------------------------------------------------ tokens at rest */

const KEY = crypto.createHash('sha256').update('overlyx-google-drive:' + JWT_SECRET).digest();
function seal(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), body].map(b => b.toString('base64url')).join('.');
}
function unseal(sealed: string): string {
  const [iv, tag, body] = sealed.split('.').map(s => Buffer.from(s, 'base64url'));
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]).toString('utf8');
}

interface Row { user_id: number; email: string | null; refresh_token: string; access_token: string | null; expires_at: number }

/** the e2e tests' Google: the API simulation (fake.ts), a Drive connection without Google's consent screen */
export const GOOGLE_STUB = process.env.OVERLYX_E2E_GOOGLE_STUB === '1';

export function driveConfigured(): boolean { return GOOGLE_STUB || (!!config.google.clientId && !!config.google.clientSecret); }

export function driveAccount(userId: number): { email: string | null } | null {
  const r = db.prepare('SELECT email FROM google_drive WHERE user_id = ?').get(userId) as { email: string | null } | undefined;
  return r ? { email: r.email } : null;
}

export class GoogleAuthError extends Error {}

/** A valid access token for the account's Drive (refreshed when it is about to expire). */
export async function accessToken(userId: number): Promise<string> {
  const row = db.prepare('SELECT * FROM google_drive WHERE user_id = ?').get(userId) as Row | undefined;
  if (!row) throw new GoogleAuthError('Google Drive is not connected for this account');
  if (row.access_token && row.expires_at > Date.now() + 60_000) return unseal(row.access_token);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.google.clientId, client_secret: config.google.clientSecret, refresh_token: unseal(row.refresh_token), grant_type: 'refresh_token' }),
  });
  const tok = await res.json() as { access_token?: string; expires_in?: number; error?: string };
  if (!tok.access_token) {
    // revoked or expired: the account has to connect again
    if (tok.error === 'invalid_grant') db.prepare('DELETE FROM google_drive WHERE user_id = ?').run(userId);
    throw new GoogleAuthError('Google Drive authorisation failed (' + (tok.error ?? res.status) + ') — connect Google Drive again');
  }
  db.prepare('UPDATE google_drive SET access_token = ?, expires_at = ? WHERE user_id = ?').run(seal(tok.access_token), Date.now() + (tok.expires_in ?? 3600) * 1000, userId);
  return tok.access_token;
}

export async function disconnectDrive(userId: number): Promise<void> {
  const row = db.prepare('SELECT refresh_token FROM google_drive WHERE user_id = ?').get(userId) as { refresh_token: string } | undefined;
  db.prepare('DELETE FROM google_drive WHERE user_id = ?').run(userId);
  if (row && !GOOGLE_STUB) await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(unseal(row.refresh_token)), { method: 'POST' }).catch(() => undefined);
}

/* ------------------------------------------------------------------ connecting (OAuth) */

function redirectUri(req: ExpressRequest): string {
  const base = config.publicUrl || `${req.protocol}://${req.get('host')}`;
  return base.replace(/\/$/, '') + '/api/auth/google/callback';
}

const safeNext = (v: unknown) => (typeof v === 'string' && /^#\/[^\s]*$/.test(v) ? v : '');

/** GET /api/gdocs/connect: to Google's consent screen for Drive access (the account's own Google account). */
export function startConnect(req: ExpressRequest & { user?: { id: number; email?: string | null } }, res: Response): void {
  if (!driveConfigured()) { res.status(404).send('Google is not configured on this server'); return; }
  if (GOOGLE_STUB && req.user) {
    db.prepare('INSERT OR REPLACE INTO google_drive (user_id, email, refresh_token, access_token, expires_at, created_at) VALUES (?, ?, ?, NULL, 0, ?)').run(req.user.id, 'e2e@example.com', seal('stub'), Date.now());
    const next = safeNext(req.query.next).replace(/[?&]gdocs=[^&]*/, '');
    res.redirect('/' + (next || '#/') + (next.includes('?') ? '&' : '?') + 'gdocs=connected');
    return;
  }
  const state = 'drive.' + crypto.randomBytes(16).toString('hex');
  res.cookie('ol_drive_state', state, { httpOnly: true, sameSite: 'lax', maxAge: 600000, path: '/' });
  res.cookie('ol_drive_next', safeNext(req.query.next), { httpOnly: true, sameSite: 'lax', maxAge: 600000, path: '/' });
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', config.google.clientId);
  url.searchParams.set('redirect_uri', redirectUri(req));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', `openid email ${DRIVE_SCOPE}`);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  if (req.user?.email) url.searchParams.set('login_hint', req.user.email);
  url.searchParams.set('state', state);
  res.redirect(url.toString());
}

/** Is this OAuth callback a Drive connection's (its state cookie)? */
export function isDriveCallback(state: unknown, cookies: Record<string, string>): boolean {
  return typeof state === 'string' && state.startsWith('drive.') && cookies.ol_drive_state === state;
}

/** The OAuth callback of a Drive connection: the refresh token is kept for the signed-in account. */
export async function finishConnect(req: ExpressRequest & { user?: { id: number } }, res: Response, cookies: Record<string, string>): Promise<void> {
  const next = safeNext(cookies.ol_drive_next);
  res.clearCookie('ol_drive_state', { path: '/' });
  res.clearCookie('ol_drive_next', { path: '/' });
  // back to the document (its dialog opens again: `gdocs=connected`, or what went wrong)
  const back = (msg?: string) => {
    const base = (next || '#/').replace(/[?&]gdocs=[^&]*/, '');
    res.redirect('/' + base + (base.includes('?') ? '&' : '?') + 'gdocs=' + encodeURIComponent(msg ?? 'connected'));
  };
  if (!req.user) { res.status(401).send('sign in first'); return; }
  if (req.query.error) { back('Google Drive was not connected (' + String(req.query.error) + ')'); return; }
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: String(req.query.code ?? ''), client_id: config.google.clientId, client_secret: config.google.clientSecret, redirect_uri: redirectUri(req), grant_type: 'authorization_code' }),
  });
  const tok = await tokenRes.json() as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; id_token?: string };
  if (!tok.access_token || !tok.refresh_token) { back('Google did not grant offline Drive access — try connecting again'); return; }
  if (!String(tok.scope ?? '').includes(DRIVE_SCOPE)) { back('Google Drive access was not granted (the box for Drive files must be ticked)'); return; }
  let email: string | null = null;
  try {
    const info = await (await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: 'Bearer ' + tok.access_token } })).json() as { email?: string };
    email = info.email ?? null;
  } catch { /* the address is only shown */ }
  db.prepare(`INSERT INTO google_drive (user_id, email, refresh_token, access_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, refresh_token = excluded.refresh_token, access_token = excluded.access_token, expires_at = excluded.expires_at`)
    .run(req.user.id, email, seal(tok.refresh_token), seal(tok.access_token), Date.now() + (tok.expires_in ?? 3600) * 1000, Date.now());
  back();
}

/* ------------------------------------------------------------------ the API */

export interface GReply { id: string; content?: string; htmlContent?: string; author?: { displayName?: string; me?: boolean }; createdTime?: string; deleted?: boolean; action?: string }
export interface GComment {
  id: string; content?: string; author?: { displayName?: string; me?: boolean }; createdTime?: string; modifiedTime?: string;
  resolved?: boolean; deleted?: boolean; quotedFileContent?: { value?: string }; anchor?: string; replies?: GReply[];
}
export interface GFile { id: string; name?: string; webViewLink?: string; trashed?: boolean; version?: string; modifiedTime?: string; lastModifyingUser?: { displayName?: string; me?: boolean } }

export interface GoogleApi {
  createDocument(title: string): Promise<GFile>;
  getDocument(id: string): Promise<DocsDocument>;
  batchUpdate(id: string, requests: Request[], requiredRevisionId?: string): Promise<{ replies: Record<string, unknown>[]; revisionId?: string }>;
  getFile(id: string): Promise<GFile>;
  listComments(id: string): Promise<GComment[]>;
  /** a comment on `quoted` (anchored to `range` of the body where the API allows it) */
  createComment(id: string, c: { content: string; quoted?: string; range?: { startIndex: number; endIndex: number } }): Promise<GComment>;
  createReply(id: string, commentId: string, r: { content?: string; action?: 'resolve' | 'reopen' }): Promise<GReply>;
}

import { GoogleApiError } from './errors.ts';
export { GoogleApiError };

const COMMENT_FIELDS = 'id,content,author(displayName,me),createdTime,modifiedTime,resolved,deleted,quotedFileContent(value),anchor,replies(id,content,author(displayName,me),createdTime,deleted,action)';

/** The Docs / Drive APIs with the account's token. */
export function googleApi(userId: number): GoogleApi {
  const call = async <T,>(method: string, url: string, body?: unknown): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      const token = await accessToken(userId);
      const res = await fetch(url, { method, headers: { authorization: 'Bearer ' + token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      if (res.ok) return (res.status === 204 ? {} : await res.json()) as T;
      const err = await res.json().catch(() => ({})) as { error?: { message?: string; status?: string; errors?: { reason?: string }[] } };
      // rate limits and Google's own hiccups: a second try after a moment
      if ((res.status === 429 || res.status >= 500) && attempt < 2) { await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); continue; }
      throw new GoogleApiError(err.error?.message ?? `Google API ${res.status}`, res.status, err.error?.errors?.[0]?.reason ?? err.error?.status);
    }
  };
  const DOCS = 'https://docs.googleapis.com/v1/documents/';
  const DRIVE = 'https://www.googleapis.com/drive/v3/files/';
  const api: GoogleApi = {
    createDocument: async (title) => {
      const f = await call<GFile>('POST', 'https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink', { name: title, mimeType: 'application/vnd.google-apps.document' });
      return f;
    },
    // (suggestions inline: the indices are the document's own; model.ts reads around them)
    getDocument: (id) => call<DocsDocument>('GET', DOCS + encodeURIComponent(id) + '?suggestionsViewMode=SUGGESTIONS_INLINE'),
    batchUpdate: (id, requests, requiredRevisionId) => call('POST', DOCS + encodeURIComponent(id) + ':batchUpdate', { requests, ...(requiredRevisionId ? { writeControl: { requiredRevisionId } } : {}) }),
    getFile: (id) => call<GFile>('GET', DRIVE + encodeURIComponent(id) + '?fields=id,name,webViewLink,trashed,version,modifiedTime,lastModifyingUser(displayName,me)'),
    listComments: async (id) => {
      const out: GComment[] = [];
      let page = '';
      do {
        const r = await call<{ comments?: GComment[]; nextPageToken?: string }>('GET', DRIVE + encodeURIComponent(id) + `/comments?pageSize=100&includeDeleted=true&fields=nextPageToken,comments(${COMMENT_FIELDS})` + (page ? '&pageToken=' + encodeURIComponent(page) : ''));
        out.push(...(r.comments ?? []));
        page = r.nextPageToken ?? '';
      } while (page);
      return out;
    },
    createComment: async (id, c) => {
      // anchored to the text through the Docs API where the project may (insertComment is in
      // preview); otherwise a Drive comment quoting the text, which Docs shows unanchored
      if (c.range) {
        try {
          const before = new Set((await api.listComments(id)).map(x => x.id));
          await api.batchUpdate(id, [{ insertComment: { content: c.content, range: c.range } }]);
          const made = (await api.listComments(id)).find(x => !before.has(x.id) && x.content === c.content);
          if (made) return made;
        } catch { /* not available: the Drive comment below */ }
      }
      return call<GComment>('POST', DRIVE + encodeURIComponent(id) + `/comments?fields=${encodeURIComponent(COMMENT_FIELDS)}`, { content: c.content, ...(c.quoted ? { quotedFileContent: { mimeType: 'text/plain', value: c.quoted } } : {}) });
    },
    createReply: (id, commentId, r) => call<GReply>('POST', DRIVE + encodeURIComponent(id) + '/comments/' + encodeURIComponent(commentId) + '/replies?fields=id,content,author(displayName,me),createdTime,action', { ...(r.content ? { content: r.content } : {}), ...(r.action ? { action: r.action } : {}) }),
  };
  return api;
}
