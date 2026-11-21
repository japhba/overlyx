/**
 * Which browser sign-ins of an account are still good: every session cookie (auth.ts signSession)
 * carries the account's session generation, and a cookie of an older generation no longer signs
 * anybody in. Changing the password (profile.ts) moves the generation on, so every other browser is
 * signed out while the one that changed it gets a fresh cookie. Accounts that never changed it are
 * generation 0 (no row), as are the cookies made before generations existed.
 *
 * Git / CLI / MCP credentials (tokenAuth.ts) are not sessions: they keep working until revoked in
 * Settings ▸ Connections.
 */
import { db } from './db.ts';

db.exec(`
CREATE TABLE IF NOT EXISTS session_generations (
  user_id INTEGER PRIMARY KEY,
  gen INTEGER NOT NULL,
  changed_at INTEGER NOT NULL
);
`);

const read = db.prepare('SELECT gen FROM session_generations WHERE user_id = ?');

/** the account's current session generation */
export function sessionGeneration(userId: number): number {
  return (read.get(userId) as { gen: number } | undefined)?.gen ?? 0;
}

/** sign every existing session of the account out (the caller then gives its own browser a new cookie) */
export function bumpSessionGeneration(userId: number): number {
  const next = sessionGeneration(userId) + 1;
  db.prepare('INSERT INTO session_generations (user_id, gen, changed_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET gen = excluded.gen, changed_at = excluded.changed_at')
    .run(userId, next, Date.now());
  return next;
}
