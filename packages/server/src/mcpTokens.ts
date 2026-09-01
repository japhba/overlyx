/**
 * Access tokens for the MCP connector (mcp.ts): one project, one token — an external agent
 * authenticates with `Authorization: Bearer olxmcp_...` and gets exactly that project's tools
 * (read, comment, propose tracked-change edits; see mcp.ts for what each tool does and why edits
 * always go through change tracking). Same shape as git.ts's tokens, scoped to a project instead
 * of a user since the caller is an agent, not a signed-in account.
 *
 * Normally only a hash is stored and the token is shown exactly once; for accounts with the
 * `allowRecopyTokens` setting (userSettings.ts) the plaintext is kept too, so the Git dialog can
 * offer Copy again later.
 */
import crypto from 'node:crypto';
import { db } from './db.ts';

export interface McpTokenRow { id: number; project: string; name: string; token_hash: string; token_plain: string | null; created_at: number; last_used_at: number | null }

function hashToken(token: string): string { return crypto.createHash('sha256').update(token).digest('hex'); }

/** A new MCP token for `project`; `storePlain` keeps the plaintext for later re-copy (see above). */
export function createMcpToken(project: string, name: string, storePlain = false): { id: number; token: string } {
  const token = 'olxmcp_' + crypto.randomBytes(24).toString('base64url');
  const info = db.prepare('INSERT INTO mcp_tokens (project, name, token_hash, token_plain, created_at) VALUES (?,?,?,?,?)')
    .run(project, name.trim().slice(0, 60) || 'agent', hashToken(token), storePlain ? token : null, Date.now());
  return { id: Number(info.lastInsertRowid), token };
}

/** The project's tokens; with `includeSecrets`, rows whose plaintext was kept carry `token`. */
export function listMcpTokens(project: string, includeSecrets = false): { id: number; name: string; created_at: number; last_used_at: number | null; token?: string }[] {
  const rows = db.prepare('SELECT id, name, created_at, last_used_at, token_plain FROM mcp_tokens WHERE project = ? ORDER BY created_at DESC').all(project) as
    { id: number; name: string; created_at: number; last_used_at: number | null; token_plain: string | null }[];
  return rows.map(({ token_plain, ...r }) => (includeSecrets && token_plain ? { ...r, token: token_plain } : r));
}

export function deleteMcpToken(project: string, id: number): boolean {
  return db.prepare('DELETE FROM mcp_tokens WHERE id = ? AND project = ?').run(id, project).changes > 0;
}

/** The project + token identity behind a bearer secret, or null. Updates last_used_at (throttled). */
export function verifyMcpToken(secret: string): { id: number; project: string; name: string } | null {
  if (!secret || !secret.startsWith('olxmcp_')) return null;
  const row = db.prepare('SELECT * FROM mcp_tokens WHERE token_hash = ?').get(hashToken(secret)) as McpTokenRow | undefined;
  if (!row) return null;
  if (!row.last_used_at || Date.now() - row.last_used_at > 60_000) db.prepare('UPDATE mcp_tokens SET last_used_at = ? WHERE id = ?').run(Date.now(), row.id);
  return { id: row.id, project: row.project, name: row.name };
}
