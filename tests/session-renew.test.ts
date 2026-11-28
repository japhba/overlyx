/**
 * A session the app uses is renewed (auth.ts authMiddleware): it ends 30 days after it was last used,
 * not 30 days after the sign-in — until 28 Nov 2026 everybody was signed out mid-work a month after
 * signing in, however much they used OverLyX.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import { rmSync } from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import jwt from 'jsonwebtoken';

const ROOT = vi.hoisted(() => {
  const root = (process.env.OVERLYX_SCRATCH ?? process.env.TMPDIR ?? '/tmp') + '/overlyx-session-renew-test';
  process.env.OVERLYX_DATA_DIR = root + '/data';
  process.env.OVERLYX_PROJECTS_DIR = root + '/projects';
  process.env.OVERLYX_DOC_WORKERS = '0';
  return root;
});
rmSync(ROOT, { recursive: true, force: true });

const { authMiddleware, createUser, toSessionUser, signSession, userFromToken } = await import('../packages/server/src/auth.ts');
const { JWT_SECRET } = await import('../packages/server/src/config.ts');
const { bumpSessionGeneration } = await import('../packages/server/src/sessiongen.ts');

const app = express();
app.use(authMiddleware);
app.get(['/api/me', '/app.js'], (req, res) => { res.json({ user: req.user?.username ?? null }); });
const server = http.createServer(app).listen(0);
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
afterAll(() => { server.close(); rmSync(ROOT, { recursive: true, force: true }); });

const ada = toSessionUser(createUser('ada', 'Ada', 'pw'));
/** a cookie signed `days` ago, valid 30 days from then */
const issued = (days: number, gen?: number) => jwt.sign({ sub: String(ada.id), username: 'ada', ...(gen ? { gen } : {}), iat: Math.floor(Date.now() / 1000) - days * 86400 }, JWT_SECRET, { expiresIn: '30d' });
const ask = async (path: string, token: string) => {
  const r = await fetch(base + path, { headers: { cookie: `ol_session=${token}` } });
  const cookie = r.headers.get('set-cookie');
  return { user: (await r.json()).user as string | null, renewed: cookie?.match(/ol_session=([^;]+)/)?.[1] ?? null };
};

describe('a session in use is renewed', () => {
  it('a cookie from today is left as it is', async () => {
    expect(await ask('/api/me', signSession(ada))).toEqual({ user: 'ada', renewed: null });
  });

  it('a cookie 29 days old gets a new one valid for 30 days from now — on the app\'s requests, not on a static file', async () => {
    const old = issued(29);
    expect((await ask('/app.js', old)).renewed).toBeNull();
    const r = await ask('/api/me', old);
    expect(r.user).toBe('ada');
    expect(userFromToken(r.renewed!)?.username).toBe('ada');
    const exp = (jwt.decode(r.renewed!) as { exp: number }).exp;
    expect(exp * 1000 - Date.now()).toBeGreaterThan(29.9 * 86400 * 1000);
  });

  it('a cookie signed out by a password change is not renewed, and the renewed one is signed out by the next', async () => {
    const before = issued(5);
    const renewed = (await ask('/api/me', before)).renewed!;
    bumpSessionGeneration(ada.id);
    expect(await ask('/api/me', before)).toEqual({ user: null, renewed: null });
    expect(await ask('/api/me', renewed)).toEqual({ user: null, renewed: null });
  });
});
