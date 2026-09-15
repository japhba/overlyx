/**
 * OAuth and legacy named-agent credentials, scoped to the *account* that created them. New manual
 * connections use the account's single `olx_...` token; `olxmcp_...` remains for OAuth rotation,
 * the embedded agent and backward compatibility. Either form works as an MCP Bearer credential
 * and may then connect to any project that account can access, with the account's role there
 * (mcp.ts checks it on every request: viewers read, editors also comment and propose
 * tracked-change edits). Same storage shape as git.ts's account access token.
 *
 * Normally only a hash is stored and the token is shown exactly once; for accounts with the
 * `allowRecopyTokens` setting (userSettings.ts) the plaintext is kept too, so the Git dialog can
 * offer Copy again later.
 */
import crypto from 'node:crypto';
import { db } from './db.ts';
import { verifyAccessToken } from './tokenAuth.ts';

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

/** OAuth and legacy agent credentials; with `includeSecrets`, kept plaintext is returned. */
export function listMcpTokens(userId: number, includeSecrets = false): { id: number; name: string; created_at: number; last_used_at: number | null; expires_at: number | null; token?: string }[] {
  const rows = db.prepare('SELECT id, name, created_at, last_used_at, expires_at, token_plain FROM mcp_tokens WHERE user_id = ? ORDER BY created_at DESC').all(userId) as
    { id: number; name: string; created_at: number; last_used_at: number | null; expires_at: number | null; token_plain: string | null }[];
  return rows.map(({ token_plain, ...r }) => (includeSecrets && token_plain ? { ...r, token: token_plain } : r));
}

export function deleteMcpToken(userId: number, id: number): boolean {
  return db.prepare('DELETE FROM mcp_tokens WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}

/**
 * The account + credential identity behind an MCP bearer secret, or null. Both the account token
 * and OAuth/legacy credentials work; the row's name remains the MCP author/audit name.
 */
export function verifyMcpToken(secret: string): { id: number; userId: number; name: string } | null {
  const identity = verifyAccessToken(secret);
  return identity ? { id: identity.id, userId: identity.userId, name: identity.name } : null;
}
