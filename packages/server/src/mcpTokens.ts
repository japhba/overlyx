/**
 * Access tokens for the MCP connector (mcp.ts): one project, one token — an external agent
 * authenticates with `Authorization: Bearer olxmcp_...` and gets exactly that project's tools
 * (read, comment, propose tracked-change edits; see mcp.ts for what each tool does and why edits
 * always go through change tracking). Same shape as git.ts's tokens, scoped to a project instead
 * of a user since the caller is an agent, not a signed-in account.
 */
import crypto from 'node:crypto';
import { db } from './db.ts';

export interface McpTokenRow { id: number; project: string; name: string; token_hash: string; created_at: number; last_used_at: number | null }

function hashToken(token: string): string { return crypto.createHash('sha256').update(token).digest('hex'); }

/** A new MCP token for `project` (shown once; only its hash is stored). */
export function createMcpToken(project: string, name: string): { id: number; token: string } {
  const token = 'olxmcp_' + crypto.randomBytes(24).toString('base64url');
  const info = db.prepare('INSERT INTO mcp_tokens (project, name, token_hash, created_at) VALUES (?,?,?,?)')
    .run(project, name.trim().slice(0, 60) || 'agent', hashToken(token), Date.now());
  return { id: Number(info.lastInsertRowid), token };
}

export function listMcpTokens(project: string): { id: number; name: string; created_at: number; last_used_at: number | null }[] {
  return db.prepare('SELECT id, name, created_at, last_used_at FROM mcp_tokens WHERE project = ? ORDER BY created_at DESC').all(project) as any;
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
