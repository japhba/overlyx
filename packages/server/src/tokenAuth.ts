/**
 * Shared validation for the account access token (`olx_…`) and OAuth/legacy connector
 * credentials (`olxmcp_…`). Either wire credential authenticates Git, the CLI and MCP.
 */
import crypto from 'node:crypto';
import { db } from './db.ts';

export interface AccessTokenIdentity {
  kind: 'personal' | 'agent';
  id: number;
  userId: number;
  name: string;
  /** what the credential may reach, when it was narrowed at its authorization; null = the whole account */
  scope: AccessScope | null;
}

/**
 * A credential narrowed by its owner on the authorization page (CLI sign-in, OAuth connection —
 * offered with Settings ▸ Account ▸ Fine-grained access): only these projects (null = all of the
 * account's, including new ones) and/or read only. Enforced by access.ts roleFor/accessibleProjects.
 */
export interface AccessScope {
  projects: string[] | null; readonly: boolean;
  /** narrowed by the Agent panel's per-thread setting, not at a sign-in (refusals say where to change it) */
  panel?: true;
}

/** The stored form (mcp_tokens.scope, JSON) → a scope; an unreadable one reaches nothing. */
export function parseScope(json: string | null | undefined): AccessScope | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as { projects?: unknown; readonly?: unknown };
    const projects = v.projects == null ? null : Array.isArray(v.projects) ? v.projects.filter((p): p is string => typeof p === 'string') : [];
    return { projects, readonly: v.readonly === true };
  } catch { return { projects: [], readonly: true }; }
}

interface TokenRow {
  id: number;
  user_id: number;
  name: string;
  last_used_at: number | null;
  expires_at?: number | null;
  scope?: string | null;
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Resolve either token family and throttle its last-used bookkeeping. Expired OAuth tokens fail. */
export function verifyAccessToken(secret: string): AccessTokenIdentity | null {
  let kind: AccessTokenIdentity['kind'];
  let table: 'git_tokens' | 'mcp_tokens';
  if (secret.startsWith('olxmcp_')) { kind = 'agent'; table = 'mcp_tokens'; }
  else if (secret.startsWith('olx_')) { kind = 'personal'; table = 'git_tokens'; }
  else return null;

  const row = db.prepare(`SELECT * FROM ${table} WHERE token_hash = ?`).get(hashToken(secret)) as TokenRow | undefined;
  if (!row || (row.expires_at != null && Date.now() > row.expires_at)) return null;
  if (!row.last_used_at || Date.now() - row.last_used_at > 60_000) {
    db.prepare(`UPDATE ${table} SET last_used_at = ? WHERE id = ?`).run(Date.now(), row.id);
  }
  return { kind, id: row.id, userId: row.user_id, name: row.name, scope: parseScope(row.scope) };
}
