/**
 * Access tokens for the MCP connector (mcp.ts): one token per external agent, scoped to the
 * *account* that created it — the agent authenticates with `Authorization: Bearer olxmcp_...`
 * and may then connect to any project that account can access, with the account's role there
 * (mcp.ts checks it on every request: viewers read, editors also comment and propose
 * tracked-change edits). Same shape as git.ts's personal access tokens.
 *
 * Normally only a hash is stored and the token is shown exactly once; for accounts with the
 * `allowRecopyTokens` setting (userSettings.ts) the plaintext is kept too, so the Git dialog can
 * offer Copy again later.
 */
import crypto from 'node:crypto';
import { db } from './db.ts';

export interface McpTokenRow { id: number; user_id: number; name: string; token_hash: string; token_plain: string | null; created_at: number; last_used_at: number | null; expires_at: number | null }

function hashToken(token: string): string { return crypto.createHash('sha256').update(token).digest('hex'); }

/** A new MCP token for the user; `storePlain` keeps the plaintext for later re-copy (see above);
 *  `expiresAt` for OAuth-issued tokens (mcpOauth.ts) — hand-created tokens do not expire. */
export function createMcpToken(userId: number, name: string, storePlain = false, expiresAt: number | null = null): { id: number; token: string } {
  const token = 'olxmcp_' + crypto.randomBytes(24).toString('base64url');
  const info = db.prepare('INSERT INTO mcp_tokens (user_id, name, token_hash, token_plain, created_at, expires_at) VALUES (?,?,?,?,?,?)')
    .run(userId, name.trim().slice(0, 60) || 'agent', hashToken(token), storePlain ? token : null, Date.now(), expiresAt);
  return { id: Number(info.lastInsertRowid), token };
}

/** The user's agent tokens; with `includeSecrets`, rows whose plaintext was kept carry `token`. */
export function listMcpTokens(userId: number, includeSecrets = false): { id: number; name: string; created_at: number; last_used_at: number | null; token?: string }[] {
  const rows = db.prepare('SELECT id, name, created_at, last_used_at, token_plain FROM mcp_tokens WHERE user_id = ? ORDER BY created_at DESC').all(userId) as
    { id: number; name: string; created_at: number; last_used_at: number | null; token_plain: string | null }[];
  return rows.map(({ token_plain, ...r }) => (includeSecrets && token_plain ? { ...r, token: token_plain } : r));
}

export function deleteMcpToken(userId: number, id: number): boolean {
  return db.prepare('DELETE FROM mcp_tokens WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}

/** The account + token identity behind a bearer secret, or null. Updates last_used_at (throttled). */
export function verifyMcpToken(secret: string): { id: number; userId: number; name: string } | null {
  if (!secret || !secret.startsWith('olxmcp_')) return null;
  const row = db.prepare('SELECT * FROM mcp_tokens WHERE token_hash = ?').get(hashToken(secret)) as McpTokenRow | undefined;
  if (!row) return null;
  if (row.expires_at && Date.now() > row.expires_at) return null;
  if (!row.last_used_at || Date.now() - row.last_used_at > 60_000) db.prepare('UPDATE mcp_tokens SET last_used_at = ? WHERE id = ?').run(Date.now(), row.id);
  return { id: row.id, userId: row.user_id, name: row.name };
}
