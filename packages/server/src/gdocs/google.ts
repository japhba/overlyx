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
import { config } from '../config.ts';
import { sealer } from '../sealed.ts';
import type { DocsDocument, DocsFile } from './model.ts';
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

const { seal, open, reseal } = sealer('google-drive');
reseal('google_drive', 'refresh_token');
reseal('google_drive', 'access_token');

interface Row { user_id: number; email: string | null; refresh_token: string; access_token: string | null; expires_at: number }

/** the e2e tests' Google: the API simulation (fake.ts), a Drive connection without Google's consent screen */
export const GOOGLE_STUB = process.env.OVERLYX_E2E_GOOGLE_STUB === '1';

export function driveConfigured(): boolean { return GOOGLE_STUB || (!!config.google.clientId && !!config.google.clientSecret); }

/**
 * Google's file picker (linking or importing a Google Doc that exists): an API key of the server's
 * Google project, restricted to the Picker API (GOOGLE_PICKER_API_KEY), and the project's number as
 * the picker's app id — what makes a picked file one the `drive.file` authorisation covers. The
 * number is the OAuth client id's prefix (GOOGLE_APP_ID overrides it).
 */
export function pickerConfigured(): boolean { return GOOGLE_STUB || (driveConfigured() && !!config.google.pickerKey); }
export function pickerAppId(): string { return config.google.appId || config.google.clientId.split('-')[0] || ''; }

export function driveAccount(userId: number): { email: string | null } | null {
  const r = db.prepare('SELECT email FROM google_drive WHERE user_id = ?').get(userId) as { email: string | null } | undefined;
  return r ? { email: r.email } : null;
}

export class GoogleAuthError extends Error {}

/**
 * How long one request to Google may take. Without a limit a connection that stalls never settles,
 * and the document's sync (one at a time) waits on it until the server restarts.
 */
const API_TIMEOUT_MS = 30_000;
/** … and a DOCX upload, which Drive converts before it answers */
const UPLOAD_TIMEOUT_MS = 120_000;

/** fetch with a time limit; no answer is a GoogleApiError too (status 0), in words a person can read */
async function timedFetch(url: string, init: RequestInit, ms = API_TIMEOUT_MS): Promise<globalThis.Response> {
  try { return await fetch(url, { ...init, signal: AbortSignal.timeout(ms) }); }
  catch (e) {
    const timeout = (e as Error).name === 'TimeoutError';
    throw new GoogleApiError(timeout ? `Google did not answer within ${Math.round(ms / 1000)} seconds` : `Google could not be reached (${(e as Error).message})`, 0, timeout ? 'timeout' : 'network');
  }
}

/** A valid access token for the account's Drive (refreshed when it is about to expire). */
export async function accessToken(userId: number): Promise<string> {
  const row = db.prepare('SELECT * FROM google_drive WHERE user_id = ?').get(userId) as Row | undefined;
  if (!row) throw new GoogleAuthError('Google Drive is not connected for this account');
  const fresh = row.access_token && row.expires_at > Date.now() + 60_000 ? open(row.access_token) : null;
  if (fresh) return fresh;
  const refresh = open(row.refresh_token);
  if (refresh === null) {
    db.prepare('DELETE FROM google_drive WHERE user_id = ?').run(userId);
    throw new GoogleAuthError('The Google Drive authorisation can no longer be read — connect Google Drive again');
  }
  const res = await timedFetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.google.clientId, client_secret: config.google.clientSecret, refresh_token: refresh, grant_type: 'refresh_token' }),
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
  const refresh = row && open(row.refresh_token);
  if (refresh && !GOOGLE_STUB) await timedFetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(refresh), { method: 'POST' }).catch(() => undefined);
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
  const tokenRes = await timedFetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: String(req.query.code ?? ''), client_id: config.google.clientId, client_secret: config.google.clientSecret, redirect_uri: redirectUri(req), grant_type: 'authorization_code' }),
  });
  const tok = await tokenRes.json() as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; id_token?: string };
  if (!tok.access_token || !tok.refresh_token) { back('Google did not grant offline Drive access — try connecting again'); return; }
  if (!String(tok.scope ?? '').includes(DRIVE_SCOPE)) { back('Google Drive access was not granted (the box for Drive files must be ticked)'); return; }
  let email: string | null = null;
  try {
    const info = await (await timedFetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: 'Bearer ' + tok.access_token } })).json() as { email?: string };
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
  /** Real Google uses DOCX conversion; optional for the legacy API simulation. */
  importDocument?(title: string, docx: Uint8Array): Promise<GFile>;
  /** The Google Doc's whole content replaced by a DOCX, converted by Drive (same file, link, sharing and history). */
  replaceWithDocx?(id: string, docx: Uint8Array): Promise<void>;
  /** the first tab's body (a Google Doc without tabs has just that one) */
  getDocument(id: string): Promise<DocsDocument>;
  /** every tab's body (documents.get with includeTabsContent) */
  getDocumentTabs(id: string): Promise<DocsFile>;
  /** `revisionId`: the Google Doc's revision this write made */
  batchUpdate(id: string, requests: Request[], requiredRevisionId?: string): Promise<{ replies: Record<string, unknown>[]; revisionId?: string }>;
  getFile(id: string): Promise<GFile>;
  listComments(id: string): Promise<GComment[]>;
  /** a comment on `quoted` (anchored to `range` of the body — of a tab's, with its tabId — where the API allows it) */
  createComment(id: string, c: { content: string; quoted?: string; range?: { startIndex: number; endIndex: number; tabId?: string } }): Promise<GComment>;
  createReply(id: string, commentId: string, r: { content?: string; action?: 'resolve' | 'reopen' }): Promise<GReply>;
  /** delete a comment (Drive allows it for the account's own) */
  deleteComment?(id: string, commentId: string): Promise<void>;
}

import { GoogleApiError, retryDelay } from './errors.ts';
export { GoogleApiError };

const COMMENT_FIELDS = 'id,content,author(displayName,me),createdTime,modifiedTime,resolved,deleted,quotedFileContent(value),anchor,replies(id,content,author(displayName,me),createdTime,deleted,action)';

/** The Docs / Drive APIs with the account's token. */
export function googleApi(userId: number): GoogleApi {
  const call = async <T,>(method: string, url: string, body?: unknown): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      const token = await accessToken(userId);
      let res: globalThis.Response;
      try {
        res = await timedFetch(url, { method, headers: { authorization: 'Bearer ' + token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      } catch (e) {
        // no answer: a read is asked again; a write may have been made, and is not repeated blindly (the next sync reads it back)
        const wait = method === 'GET' ? retryDelay(0, undefined, attempt) : null;
        if (wait === null) throw e;
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      if (res.ok) return (res.status === 204 ? {} : await res.json()) as T;
      const err = await res.json().catch(() => ({})) as { error?: { message?: string; status?: string; errors?: { reason?: string }[]; details?: { reason?: string }[] } };
      // (Drive names the reason in errors[], the Docs API in status and an ErrorInfo of details[])
      const reason = err.error?.errors?.[0]?.reason ?? err.error?.details?.find(d => d.reason)?.reason ?? err.error?.status;
      const wait = retryDelay(res.status, reason, attempt, res.headers.get('retry-after'));
      if (wait === null) throw new GoogleApiError(err.error?.message ?? `Google API ${res.status}`, res.status, reason);
      await new Promise(r => setTimeout(r, wait));
    }
  };
  const DOCS = 'https://docs.googleapis.com/v1/documents/';
  const DRIVE = 'https://www.googleapis.com/drive/v3/files/';
  const api: GoogleApi = {
    importDocument: async (title, docx) => {
      const boundary = 'overlyx-' + crypto.randomUUID();
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` + JSON.stringify({ name: title, mimeType: 'application/vnd.google-apps.document' }) + `\r\n--${boundary}\r\nContent-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document\r\n\r\n`),
        Buffer.from(docx), Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      // A create with an unknown outcome must not be retried: conversion cannot use a
      // preallocated Drive ID, so a retry could create a second document.
      const token = await accessToken(userId);
      const res = await timedFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink,mimeType', {
        method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'multipart/related; boundary=' + boundary }, body,
      }, UPLOAD_TIMEOUT_MS);
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: { message?: string } };
        throw new GoogleApiError(err.error?.message ?? `Google Docs import failed (${res.status})`, res.status);
      }
      const file = await res.json() as GFile & { mimeType?: string };
      if (file.mimeType !== 'application/vnd.google-apps.document') throw new Error('Google did not convert the DOCX to a native Google Doc.');
      return file;
    },
    replaceWithDocx: async (id, docx) => {
      // Not retried either: a second upload of the same content would only cost time, but an upload
      // with an unknown outcome is better read back by the next sync than repeated blindly.
      const token = await accessToken(userId);
      const res = await timedFetch(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(id)}?uploadType=media&fields=id,mimeType`, {
        method: 'PATCH', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }, body: Buffer.from(docx),
      }, UPLOAD_TIMEOUT_MS);
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: { message?: string } };
        throw new GoogleApiError(err.error?.message ?? `Google Docs upload failed (${res.status})`, res.status);
      }
      const file = await res.json() as { mimeType?: string };
      if (file.mimeType !== 'application/vnd.google-apps.document') throw new Error('Google did not keep the upload a native Google Doc.');
    },
    createDocument: async (title) => {
      const f = await call<GFile>('POST', 'https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink', { name: title, mimeType: 'application/vnd.google-apps.document' });
      return f;
    },
    // (suggestions inline: the indices are the document's own; model.ts reads around them)
    getDocument: (id) => call<DocsDocument>('GET', DOCS + encodeURIComponent(id) + '?suggestionsViewMode=SUGGESTIONS_INLINE'),
    getDocumentTabs: (id) => call<DocsFile>('GET', DOCS + encodeURIComponent(id) + '?includeTabsContent=true&suggestionsViewMode=SUGGESTIONS_INLINE'),
    // (BatchUpdateDocumentResponse: its writeControl names the revision the write made)
    batchUpdate: async (id, requests, requiredRevisionId) => {
      const r = await call<{ replies?: Record<string, unknown>[]; writeControl?: { requiredRevisionId?: string } }>('POST', DOCS + encodeURIComponent(id) + ':batchUpdate', { requests, ...(requiredRevisionId ? { writeControl: { requiredRevisionId } } : {}) });
      return { replies: r.replies ?? [], revisionId: r.writeControl?.requiredRevisionId };
    },
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
    deleteComment: async (id, commentId) => { await call('DELETE', DRIVE + encodeURIComponent(id) + '/comments/' + encodeURIComponent(commentId)); },
    createReply: (id, commentId, r) => call<GReply>('POST', DRIVE + encodeURIComponent(id) + '/comments/' + encodeURIComponent(commentId) + '/replies?fields=id,content,author(displayName,me),createdTime,action', { ...(r.content ? { content: r.content } : {}), ...(r.action ? { action: r.action } : {}) }),
  };
  return api;
}
