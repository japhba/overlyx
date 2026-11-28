/**
 * Which browser sign-ins of an account are still good: every session cookie (auth.ts signSession)
 * carries the account's session generation, and a cookie of an older generation no longer signs
 * anybody in. Changing the password (profile.ts) moves the generation on, so every other browser is
 * signed out while the one that changed it gets a fresh cookie. Accounts that never changed it are
 * generation 0 (no row), as are the cookies made before generations existed.
 *
 * A cookie is looked at when a request comes in; what a session holds open after that — a document's
 * WebSocket, the encrypted relay, an event stream — registers how to end it (`holdOpen`), and signing
 * the sessions out ends all of it at once. An editor left open in another browser would otherwise go
 * on reading and writing the document for as long as its connection lives, which is exactly what a
 * person changing their password wants to stop. The browser that changed it is disconnected with the
 * others and connects again with its new cookie (the editors reconnect by themselves).
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

/** sign every existing session of the account out — what they hold open ends too (the caller then gives its own browser a new cookie) */
export function bumpSessionGeneration(userId: number): number {
  const next = sessionGeneration(userId) + 1;
  db.prepare('INSERT INTO session_generations (user_id, gen, changed_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET gen = excluded.gen, changed_at = excluded.changed_at')
    .run(userId, next, Date.now());
  endOpenConnections(userId);
  return next;
}

const held = new Map<number, Set<() => void>>();

/**
 * Something a session of the account keeps open beyond its request: `end` closes it when the
 * account's sessions are signed out. Returns what to call when it closed by itself.
 */
export function holdOpen(userId: number, end: () => void): () => void {
  let set = held.get(userId);
  if (!set) held.set(userId, set = new Set());
  set.add(end);
  return () => { const s = held.get(userId); if (s?.delete(end) && !s.size) held.delete(userId); };
}

/** End everything the account's sessions hold open (a password change, the account's deletion); how many connections that were. */
export function endOpenConnections(userId: number): number {
  const set = held.get(userId);
  if (!set) return 0;
  held.delete(userId);
  for (const end of set) { try { end(); } catch { /* closing already */ } }
  return set.size;
}
