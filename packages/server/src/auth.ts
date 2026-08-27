import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { parse as parseCookie } from 'cookie';
import type { Request, Response, NextFunction, Router } from 'express';
import express from 'express';
import { db, pickColor, type UserRow } from './db.ts';
import { config, JWT_SECRET } from './config.ts';

export interface SessionUser { id: number; username: string; name: string; color: string; isAdmin: boolean; avatar?: string | null }

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384 }).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) return false;
  const [alg, salt, hash] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const test = crypto.scryptSync(password, salt, 64, { N: 16384 });
  const ref = Buffer.from(hash, 'hex');
  return test.length === ref.length && crypto.timingSafeEqual(test, ref);
}

/** Generate a strong random password (letters, digits, symbols; 20 chars). */
export function generatePassword(len = 20): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_!@#%+=';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export function createUser(username: string, displayName: string, password: string | null, opts: { email?: string; googleSub?: string; isAdmin?: boolean; avatar?: string } = {}): UserRow {
  const stmt = db.prepare('INSERT INTO users (username, display_name, password_hash, color, email, google_sub, is_admin, created_at, avatar_url) VALUES (?,?,?,?,?,?,?,?,?)');
  const info = stmt.run(username, displayName, password ? hashPassword(password) : null, pickColor(), opts.email ?? null, opts.googleSub ?? null, opts.isAdmin ? 1 : 0, Date.now(), opts.avatar ?? null);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid) as UserRow;
}

export function toSessionUser(u: UserRow): SessionUser {
  // the profile picture is served through our own origin (see /api/users/:id/avatar): third-party
  // image hosts get blocked by privacy extensions / referrer rules, and it works offline this way
  return { id: u.id, username: u.username, name: u.display_name, color: u.color, isAdmin: !!u.is_admin, avatar: u.avatar_url ? `/api/users/${u.id}/avatar` : null };
}

export function signSession(u: SessionUser): string {
  return jwt.sign({ sub: String(u.id), username: u.username }, JWT_SECRET, { expiresIn: `${config.sessionDays}d` });
}

export function userFromToken(token: string | undefined): SessionUser | null {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { sub: string };
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(payload.sub)) as UserRow | undefined;
    return row ? toSessionUser(row) : null;
  } catch {
    return null;
  }
}

export function userFromCookieHeader(cookieHeader: string | undefined): SessionUser | null {
  if (!cookieHeader) return null;
  const c = parseCookie(cookieHeader);
  return userFromToken(c.ol_session);
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express { interface Request { user?: SessionUser } }
}

export function authMiddleware(req: Request, _res: Response, next: NextFunction): void {
  req.user = userFromCookieHeader(req.headers.cookie) ?? undefined;
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) { res.status(401).json({ error: 'not authenticated' }); return; }
  next();
}

function setSessionCookie(res: Response, u: SessionUser): void {
  res.cookie('ol_session', signSession(u), {
    httpOnly: true, sameSite: 'lax', secure: config.publicUrl.startsWith('https'),
    maxAge: config.sessionDays * 24 * 3600 * 1000, path: '/',
  });
}

/* ------------------------------------------------------------------ routes */

const loginAttempts = new Map<string, { n: number; until: number }>();

export function authRouter(): Router {
  const r = express.Router();

  r.post('/login', express.json(), (req, res) => {
    const { username, password } = req.body ?? {};
    const ip = req.ip ?? 'x';
    const la = loginAttempts.get(ip);
    if (la && la.n >= 8 && Date.now() < la.until) { res.status(429).json({ error: 'too many attempts, try again later' }); return; }
    const row = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username ?? '').trim().toLowerCase()) as UserRow | undefined;
    if (!row || !verifyPassword(String(password ?? ''), row.password_hash)) {
      const cur = loginAttempts.get(ip) ?? { n: 0, until: 0 };
      cur.n++; cur.until = Date.now() + 10 * 60 * 1000;
      loginAttempts.set(ip, cur);
      res.status(401).json({ error: 'invalid credentials' });
      return;
    }
    loginAttempts.delete(ip);
    const u = toSessionUser(row);
    setSessionCookie(res, u);
    res.json({ user: u });
  });

  r.post('/logout', (_req, res) => {
    res.clearCookie('ol_session', { path: '/' });
    res.json({ ok: true });
  });

  r.get('/me', (req, res) => {
    res.json({ user: req.user ?? null, google: !!config.google.clientId });
  });

  // --- Google OAuth (active when GOOGLE_CLIENT_ID/SECRET are configured)
  r.get('/google', (req, res) => {
    if (!config.google.clientId) { res.status(404).send('Google login not configured'); return; }
    const state = crypto.randomBytes(16).toString('hex');
    res.cookie('ol_oauth_state', state, { httpOnly: true, sameSite: 'lax', maxAge: 600000, path: '/' });
    const redirect = redirectUri(req);
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', config.google.clientId);
    url.searchParams.set('redirect_uri', redirect);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', state);
    res.redirect(url.toString());
  });

  r.get('/google/callback', async (req, res) => {
    try {
      const cookies = parseCookie(req.headers.cookie ?? '');
      if (!req.query.state || req.query.state !== cookies.ol_oauth_state) { res.status(400).send('bad state'); return; }
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: String(req.query.code), client_id: config.google.clientId, client_secret: config.google.clientSecret,
          redirect_uri: redirectUri(req), grant_type: 'authorization_code',
        }),
      });
      const tok = await tokenRes.json() as { id_token?: string; access_token?: string };
      if (!tok.access_token) { res.status(401).send('google auth failed'); return; }
      const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: 'Bearer ' + tok.access_token } });
      const info = await infoRes.json() as { sub: string; email?: string; name?: string; email_verified?: boolean; picture?: string };
      let row = db.prepare('SELECT * FROM users WHERE google_sub = ?').get(info.sub) as UserRow | undefined;
      if (!row && info.email) row = db.prepare('SELECT * FROM users WHERE email = ?').get(info.email) as UserRow | undefined;
      if (!row) {
        // only pre-registered (by email) users or an open policy: we register by email domain-free default
        const base = (info.email ?? 'google_' + info.sub).split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '');
        let username = base; let k = 1;
        while (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) username = `${base}${k++}`;
        row = createUser(username, info.name ?? username, null, { email: info.email, googleSub: info.sub, avatar: info.picture });
      } else if (!row.google_sub) {
        db.prepare('UPDATE users SET google_sub = ? WHERE id = ?').run(info.sub, row.id);
      }
      // keep the profile picture fresh on every sign-in
      if (info.picture !== undefined && info.picture !== row.avatar_url) {
        db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(info.picture ?? null, row.id);
        row = db.prepare('SELECT * FROM users WHERE id = ?').get(row.id) as UserRow;
      }
      setSessionCookie(res, toSessionUser(row));
      res.redirect('/');
    } catch (e) {
      res.status(500).send('google auth error: ' + String(e));
    }
  });

  return r;
}

function redirectUri(req: Request): string {
  const base = config.publicUrl || `${req.protocol}://${req.get('host')}`;
  return base.replace(/\/$/, '') + '/api/auth/google/callback';
}
