/**
 * Per-account server-side settings (users.settings, a small JSON object). Unlike the client's
 * prefs (localStorage, per browser) these follow the account and gate server behaviour.
 *
 * `allowRecopyTokens`: access/agent tokens this user creates keep their plaintext so they can be
 * copied again later from the Git dialog (normally only a hash is stored and a token is shown
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
