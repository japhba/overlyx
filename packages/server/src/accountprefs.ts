/**
 * A person's preferences that follow their account to every device (client app/accountprefs.ts):
 * the editor's settings (fonts, text styles, spell checking, AI switches …), the theme, the personal
 * dictionary, recent fonts and colours — each kept as its own key with the time it was chosen, so
 * that a font chosen on the iPad does not undo spell checking switched off on the laptop.
 *
 * `GET /api/prefs` gives them all; `PUT /api/prefs { set: { key: { value, at } }, onlyNew }` stores
 * some. A value chosen earlier than the one the account holds (a device that was offline, sending
 * late) leaves the newer one as it is; with `onlyNew` (a browser's first sync, uploading what it
 * had kept for itself) only keys the account has no value for are written — the account's win.
 * Times are the browser's clock, never later than the server's.
 */
import { db } from './db.ts';

export interface AccountPref { value: unknown; at: number }
export type AccountPrefs = Record<string, AccountPref>;

/** keys look like `pref.editorFont` or `ls.ol.theme` */
const KEY = /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/;
export const PREFS_LIMITS = { keys: 200, valueBytes: 64 * 1024, totalBytes: 512 * 1024 };

export function accountPrefs(userId: number): AccountPrefs {
  const out: AccountPrefs = {};
  for (const r of db.prepare('SELECT key, value, updated_at FROM user_prefs WHERE user_id = ?').all(userId) as { key: string; value: string; updated_at: number }[]) {
    try { out[r.key] = { value: JSON.parse(r.value), at: r.updated_at }; } catch { /* a broken row is skipped */ }
  }
  return out;
}

/** Store some of the account's preferences (see above); what does not look right is left out. Gives them all back. */
export function setAccountPrefs(userId: number, set: unknown, onlyNew = false): AccountPrefs {
  if (!set || typeof set !== 'object' || Array.isArray(set)) return accountPrefs(userId);
  const now = Date.now();
  const upsert = db.prepare(onlyNew
    ? 'INSERT INTO user_prefs (user_id, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, key) DO NOTHING'
    : 'INSERT INTO user_prefs (user_id, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at WHERE excluded.updated_at >= user_prefs.updated_at');
  const count = (db.prepare('SELECT COUNT(*) AS n FROM user_prefs WHERE user_id = ?').get(userId) as { n: number }).n;
  const have = new Set((db.prepare('SELECT key FROM user_prefs WHERE user_id = ?').all(userId) as { key: string }[]).map(r => r.key));
  let total = (db.prepare('SELECT COALESCE(SUM(LENGTH(value)), 0) AS b FROM user_prefs WHERE user_id = ?').get(userId) as { b: number }).b;
  let added = 0;
  db.transaction(() => {
    for (const [key, entry] of Object.entries(set as Record<string, unknown>).slice(0, PREFS_LIMITS.keys)) {
      if (!KEY.test(key) || !entry || typeof entry !== 'object' || !('value' in entry)) continue;
      const json = JSON.stringify((entry as { value: unknown }).value ?? null);
      if (json.length > PREFS_LIMITS.valueBytes || total + json.length > PREFS_LIMITS.totalBytes) continue;
      if (!have.has(key) && count + added >= PREFS_LIMITS.keys) continue;
      const at = (entry as { at?: unknown }).at;
      const when = typeof at === 'number' && Number.isFinite(at) && at > 0 ? Math.min(Math.round(at), now) : now;
      upsert.run(userId, key, json, when);
      total += json.length;
      if (!have.has(key)) { have.add(key); added++; }
    }
  })();
  return accountPrefs(userId);
}
