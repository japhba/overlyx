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
}

interface TokenRow {
  id: number;
  user_id: number;
  name: string;
  last_used_at: number | null;
  expires_at?: number | null;
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
  return { kind, id: row.id, userId: row.user_id, name: row.name };
}
