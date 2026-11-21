/**
 * Settings ▸ Account (packages/server/src/profile.ts, sessiongen.ts): the display name is tidied and
 * kept; the password changes only with the current one, wrong ones are counted and wait, an account
 * without a password (Google) and guests are refused in plain words; a change signs the other
 * browsers out (their cookies carry the old session generation) while a new cookie works.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-account-profile-test');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'projects'), { recursive: true });
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');
process.env.OVERLYX_AGENT_USERS = 'off';

const { createUser, createGuest, toSessionUser, signSession, userFromToken, verifyPassword } = await import('../packages/server/src/auth.ts');
const { changeDisplayName, changePassword, profileOf, ProfileError, cleanDisplayName } = await import('../packages/server/src/profile.ts');
const { db } = await import('../packages/server/src/db.ts');

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const fails = (f: () => unknown, status: number, words: RegExp) => {
  try { f(); } catch (e) { expect(e).toBeInstanceOf(ProfileError); expect((e as InstanceType<typeof ProfileError>).status).toBe(status); expect((e as Error).message).toMatch(words); return; }
  throw new Error('did not fail');
};

describe('account profile', () => {
  const ada = toSessionUser(createUser('ada', 'Ada', 'first-password-1'));
  const gina = toSessionUser(createUser('gina', 'Gina', null, { googleSub: 'g-gina', email: 'gina@example.com' }));
  const guest = toSessionUser(createGuest('Visitor'));

  it('renames, tidied; refuses empty, too long, guests', () => {
    expect(cleanDisplayName('  Ada \u0000 <b>Lovelace</b>\n')).toBe('Ada bLovelace/b');
    expect(changeDisplayName(ada, '  Ada   King ')).toBe('Ada King');
    expect((db.prepare('SELECT display_name FROM users WHERE id = ?').get(ada.id) as { display_name: string }).display_name).toBe('Ada King');
    fails(() => changeDisplayName(ada, '   '), 400, /Type the name/);
    fails(() => changeDisplayName(ada, 'x'.repeat(61)), 400, /at most 60/);
    fails(() => changeDisplayName(guest, 'Me'), 403, /guest/);
    expect(profileOf(ada)).toMatchObject({ name: 'Ada King', hasPassword: true, google: false });
    expect(profileOf(gina)).toMatchObject({ hasPassword: false, google: true });
  });

  it('changes the password only with the current one, and signs the other browsers out', () => {
    const before = signSession(ada);
    expect(userFromToken(before)?.id).toBe(ada.id);
    fails(() => changePassword(gina, 'x', 'y'.repeat(12)), 400, /signs in with Google/);
    fails(() => changePassword(guest, 'x', 'y'.repeat(12)), 403, /guest/);
    fails(() => changePassword(ada, 'first-password-1', 'short'), 400, /at least 10/);
    fails(() => changePassword(ada, 'first-password-1', 'first-password-1'), 400, /current one/);
    changePassword(ada, 'first-password-1', 'second-password-2');
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(ada.id) as { password_hash: string };
    expect(verifyPassword('second-password-2', row.password_hash)).toBe(true);
    expect(userFromToken(before)).toBeNull();   // the other browsers: signed out
    expect(userFromToken(signSession(ada))?.id).toBe(ada.id);   // the new cookie works
  });

  it('counts wrong current passwords and makes them wait', () => {
    const t0 = 1_900_000_000_000;
    for (let i = 0; i < 5; i++) fails(() => changePassword(ada, 'wrong', 'third-password-3', t0), 403, /not your current password/);
    fails(() => changePassword(ada, 'second-password-2', 'third-password-3', t0 + 1000), 429, /Too many wrong passwords/);
    changePassword(ada, 'second-password-2', 'third-password-3', t0 + 16 * 60 * 1000);
  });
});
