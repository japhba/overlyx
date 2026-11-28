/**
 * Password checks (packages/server/src/auth.ts verifyPassword, the sign-in route, git.ts Basic auth):
 * off the event loop, the same work whether the name exists or not (the time does not tell), and
 * the per-address limit holds when the attempts arrive all at once.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';

const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-password-checks-test');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'projects'), { recursive: true });
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');
process.env.OVERLYX_AGENT_USERS = 'off';
delete process.env.OVERLYX_GIT;

const { createUser, verifyPassword, authRouter } = await import('../packages/server/src/auth.ts');
const gitmod = await import('../packages/server/src/git.ts');
const express = (await import('express')).default;

createUser('ada', 'Ada', 'ada-password-1');
createUser('gina', 'Gina', null, { googleSub: 'g-gina', email: 'gina@example.com' });
const { hashPassword } = await import('../packages/server/src/auth.ts');

describe('password checks', () => {
  it('leave the event loop free while they run', async () => {
    const stored = hashPassword('right-password');
    let ticked = false;
    setImmediate(() => { ticked = true; });
    expect(await verifyPassword('right-password', stored)).toBe(true);
    expect(ticked).toBe(true);
    expect(await verifyPassword('wrong-password', stored)).toBe(false);
    expect(await verifyPassword('', null)).toBe(false);
    expect(await verifyPassword('x', 'bcrypt$whatever$00')).toBe(false);
  });

  it('do the same work for a name that does not exist, an account without a password, and a real one', async () => {
    const scrypt = vi.spyOn(crypto, 'scrypt');
    for (const [name, secret] of [['nobody', 'some-password'], ['gina', 'some-password'], ['ada', 'wrong-password']]) {
      scrypt.mockClear();
      expect(await gitmod.userForCredentials(name, secret)).toBeNull();
      expect(scrypt, name).toHaveBeenCalledTimes(1);
    }
    expect((await gitmod.userForCredentials('ada', 'ada-password-1'))?.username).toBe('ada');
    // tokens are looked up, never hashed as passwords
    scrypt.mockClear();
    expect(await gitmod.userForCredentials('ada', 'olx_not-a-real-token')).toBeNull();
    expect(scrypt).not.toHaveBeenCalled();
    scrypt.mockRestore();
  });

  it('sign in with the right password, and not with a wrong one or none', async () => {
    const app = express();
    app.use('/api/auth', authRouter());
    const server = app.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const login = (username: string, password: string) => fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
    try {
      expect((await login('ada', 'wrong-password')).status).toBe(401);
      expect((await login('nobody', 'ada-password-1')).status).toBe(401);
      expect((await login('gina', '')).status).toBe(401);
      const ok = await login('ada', 'ada-password-1');
      expect(ok.status).toBe(200);
      expect(ok.headers.get('set-cookie')).toMatch(/ol_session=/);
      expect((await ok.json()).user.username).toBe('ada');
    } finally { server.close(); }
  });

  it('keep the sign-in limit when the attempts arrive at once', async () => {
    const app = express();
    app.use('/api/auth', authRouter());
    app.use('/git', gitmod.gitRouter());
    const server = app.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const logins = await Promise.all(Array.from({ length: 20 }, () => fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'ada', password: 'wrong-password' }) }).then(r => r.status)));
      expect(logins.filter(s => s === 401)).toHaveLength(8);
      expect(logins.filter(s => s === 429)).toHaveLength(12);
      const basic = 'Basic ' + Buffer.from('ada:wrong-password').toString('base64');
      const gits = await Promise.all(Array.from({ length: 20 }, () => fetch(`${base}/git/api/user`, { headers: { authorization: basic } }).then(r => r.status)));
      expect(gits.filter(s => s === 401)).toHaveLength(10);
      expect(gits.filter(s => s === 429)).toHaveLength(10);
    } finally { server.close(); }
  });
});
