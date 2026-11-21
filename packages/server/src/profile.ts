/**
 * Settings ▸ Account: a person changes their own display name and password
 * (POST /api/account/name, POST /api/account/password; index.ts).
 *
 *  - The name is the one collaborators see on cursors, comments and changes from now on; what was
 *    written before keeps the name it was written under (it is in the documents). Guests have no
 *    account to rename (they sign in to keep theirs).
 *  - The password: only with the current one; an account that signs in with Google and has none is
 *    told so. Wrong current passwords are counted per account — five in a quarter of an hour and it
 *    waits. A change signs every other browser out (sessiongen.ts); the caller gives its own a new
 *    cookie. Git / CLI / MCP sign-ins keep working (Settings ▸ Connections revokes them). The keys of
 *    end-to-end encrypted projects are unlocked by the recovery code, never by the password
 *    (client e2e/keys.ts), so they are not touched.
 *
 * Errors are plain sentences for the dialog (ProfileError.status: the HTTP status).
 */
import { db, type UserRow } from './db.ts';
import { hashPassword, verifyPassword, type SessionUser } from './auth.ts';
import { bumpSessionGeneration } from './sessiongen.ts';

export const NAME_MAX = 60;
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;
const TRIES = 5, WAIT_MS = 15 * 60 * 1000;

export class ProfileError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

/** what the account section shows: whether there is a password to change */
export function profileOf(user: SessionUser): { name: string; hasPassword: boolean; google: boolean } {
  const row = db.prepare('SELECT display_name, password_hash, google_sub FROM users WHERE id = ?').get(user.id) as Pick<UserRow, 'display_name' | 'password_hash' | 'google_sub'> | undefined;
  return { name: row?.display_name ?? user.name, hasPassword: !!row?.password_hash, google: !!row?.google_sub };
}

/** a display name as typed, tidied: no control or invisible characters, no angle brackets, single spaces */
export function cleanDisplayName(name: unknown): string {
  return String(name ?? '').normalize('NFC').replace(/[\p{C}<>]/gu, '').replace(/\s+/g, ' ').trim();
}

export function changeDisplayName(user: SessionUser, name: unknown): string {
  if (user.guest) throw new ProfileError('Sign in first: a guest has no account to rename.', 403);
  const n = cleanDisplayName(name);
  if (!n) throw new ProfileError('Type the name people should see.');
  if (n.length > NAME_MAX) throw new ProfileError(`A name can be at most ${NAME_MAX} characters long.`);
  db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(n, user.id);
  return n;
}

const wrong = new Map<number, { n: number; until: number }>();

/** the password changed (every other session signed out); throws ProfileError with what is wrong */
export function changePassword(user: SessionUser, current: unknown, next: unknown, now = Date.now()): void {
  if (user.guest) throw new ProfileError('Sign in first: a guest has no password.', 403);
  const w = wrong.get(user.id);
  if (w && w.n >= TRIES && now < w.until) throw new ProfileError(`Too many wrong passwords — try again in ${Math.ceil((w.until - now) / 60000)} minutes.`, 429);
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id) as { password_hash: string | null } | undefined;
  if (!row) throw new ProfileError('This account no longer exists.', 404);
  if (!row.password_hash) throw new ProfileError('Your account signs in with Google: it has no password to change.', 400);
  if (typeof current !== 'string' || !verifyPassword(current, row.password_hash)) {
    const cur = w && now < w.until ? w : { n: 0, until: 0 };
    cur.n++; cur.until = now + WAIT_MS;
    wrong.set(user.id, cur);
    throw new ProfileError('That is not your current password.', 403);
  }
  if (typeof next !== 'string' || next.length < PASSWORD_MIN) throw new ProfileError(`Choose a new password of at least ${PASSWORD_MIN} characters.`);
  if (next.length > PASSWORD_MAX) throw new ProfileError(`A password can be at most ${PASSWORD_MAX} characters long.`);
  if (next === current) throw new ProfileError('The new password is the current one — choose another.');
  wrong.delete(user.id);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), user.id);
  bumpSessionGeneration(user.id);
}
