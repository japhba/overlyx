/**
 * Per-account server-side settings (users.settings, a small JSON object). Unlike the client's
 * prefs (localStorage, per browser) these follow the account and gate server behaviour.
 *
 * `allowRecopyTokens`: the account token keeps its plaintext so it can be copied again later from
 * the Git dialog (normally only a hash is stored and the token is shown
 * exactly once). Storing recoverable secrets is a deliberate trade-off, so it is off by default
 * and switched on per account by an administrator (POST /api/admin/users/:id/settings — the
 * Settings panel's Account section). The instance owner (OVERLYX_OWNER_EMAIL) has it on unless
 * explicitly switched off.
 */
import { db } from './db.ts';
import { config } from './config.ts';

export interface UserSettings { allowRecopyTokens: boolean }

export function userSettings(userId: number): UserSettings {
  const row = db.prepare('SELECT email, settings FROM users WHERE id = ?').get(userId) as { email: string | null; settings: string | null } | undefined;
  const isOwner = !!(config.ownerEmail && row?.email && row.email.toLowerCase() === config.ownerEmail);
  const defaults: UserSettings = { allowRecopyTokens: isOwner };
  if (!row?.settings) return defaults;
  try {
    const stored = JSON.parse(row.settings);
    return stored && typeof stored === 'object' ? { ...defaults, ...stored } : defaults;
  } catch { return defaults; }
}

/** Store an override for a user (an administrator's action); only known keys are kept. */
export function setUserSettings(userId: number, patch: Partial<UserSettings>): UserSettings {
  const row = db.prepare('SELECT settings FROM users WHERE id = ?').get(userId) as { settings: string | null } | undefined;
  let stored: Record<string, unknown> = {};
  try { const v = row?.settings ? JSON.parse(row.settings) : {}; if (v && typeof v === 'object') stored = v; } catch { /* start over */ }
  if (typeof patch.allowRecopyTokens === 'boolean') stored.allowRecopyTokens = patch.allowRecopyTokens;
  db.prepare('UPDATE users SET settings = ? WHERE id = ?').run(JSON.stringify(stored), userId);
  return userSettings(userId);
}

/* ------------- per-account keyboard shortcuts (client keybindings.ts syncs them; /api/keys) */

export type UserKeys = Record<string, string | null>;

/** The account's custom shortcut map { "<menu ▸ path>": "Ctrl+Shift+A" | null } (null = default off). */
export function userKeys(userId: number): UserKeys {
  const row = db.prepare('SELECT keybindings FROM users WHERE id = ?').get(userId) as { keybindings: string | null } | undefined;
  if (!row?.keybindings) return {};
  try { const v = JSON.parse(row.keybindings); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
}

/** Replace the account's shortcut map; entries are lightly validated, the rest dropped. */
export function setUserKeys(userId: number, keys: unknown): UserKeys {
  const out: UserKeys = {};
  if (keys && typeof keys === 'object' && !Array.isArray(keys)) {
    for (const [id, v] of Object.entries(keys as Record<string, unknown>).slice(0, 500)) {
      if (!id || id.length > 300) continue;
      if (v === null) out[id] = null;
      else if (typeof v === 'string' && v.length > 0 && v.length <= 60) out[id] = v;
    }
  }
  db.prepare('UPDATE users SET keybindings = ? WHERE id = ?').run(JSON.stringify(out), userId);
  return out;
}

/* ------------- per user and document: the folded sections (client editor/plugins/fold.ts; /api/docs/<id>/folds) */

/** a folded heading, by layout, text and which of the equal headings it is */
export interface SavedFold { l: string; t: string; n: number }
export interface DocFolds { folds: SavedFold[]; /** when the user last changed them (their browser's clock, ms); 0 = never */ at: number }

export function docFolds(userId: number, docId: string): DocFolds {
  const row = db.prepare("SELECT value, updated_at FROM user_doc_state WHERE user_id = ? AND doc_id = ? AND key = 'folds'").get(userId, docId) as { value: string; updated_at: number } | undefined;
  if (!row) return { folds: [], at: 0 };
  try { const v = JSON.parse(row.value); return { folds: Array.isArray(v) ? v : [], at: row.updated_at }; } catch { return { folds: [], at: row.updated_at }; }
}

/** Store the user's folds for a document; entries are validated, `at` is the change's time (never in the future). */
export function setDocFolds(userId: number, docId: string, folds: unknown, at?: unknown): DocFolds {
  const out: SavedFold[] = [];
  if (Array.isArray(folds)) {
    for (const f of folds.slice(0, 1000)) {
      if (!f || typeof f !== 'object') continue;
      const { l, t, n } = f as Record<string, unknown>;
      if (typeof l !== 'string' || typeof t !== 'string' || l.length > 60 || t.length > 1000 || !Number.isInteger(n) || (n as number) < 0) continue;
      out.push({ l, t, n: n as number });
    }
  }
  const now = Date.now();
  const when = typeof at === 'number' && Number.isFinite(at) && at > 0 ? Math.min(Math.round(at), now) : now;
  db.prepare("INSERT INTO user_doc_state (user_id, doc_id, key, value, updated_at) VALUES (?, ?, 'folds', ?, ?) ON CONFLICT(user_id, doc_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .run(userId, docId, JSON.stringify(out), when);
  return { folds: out, at: when };
}

/* ------------- per user and document: when they last opened it (the start screen sorts projects by recency) */

/** A document was opened by the user (every WebSocket connection; the activity log keeps only one entry per 10 minutes). */
export function markDocOpened(userId: number, docId: string): void {
  try {
    db.prepare("INSERT INTO user_doc_state (user_id, doc_id, key, value, updated_at) VALUES (?, ?, 'opened', '', ?) ON CONFLICT(user_id, doc_id, key) DO UPDATE SET updated_at = excluded.updated_at")
      .run(userId, docId, Date.now());
  } catch (e) { console.error('[state] cannot note the open:', e); }
}

/** When the user last opened a document of each project — the newer of this and the activity log (which goes back further). */
export function lastOpenedByProject(userId: number): Map<string, number> {
  const out = new Map<string, number>();
  const note = (project: string, at: number) => { if (at > (out.get(project) ?? 0)) out.set(project, at); };
  for (const r of db.prepare("SELECT project, MAX(at) AS at FROM access_log WHERE user_id = ? AND action = 'open' GROUP BY project").all(userId) as { project: string; at: number }[]) note(r.project, r.at);
  for (const r of db.prepare("SELECT doc_id, updated_at FROM user_doc_state WHERE user_id = ? AND key = 'opened'").all(userId) as { doc_id: string; updated_at: number }[]) note(r.doc_id.split('/')[0], r.updated_at);
  return out;
}
