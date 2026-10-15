/**
 * What keeps a document in step from elsewhere right now — the "⇄ in sync" chip of the web
 * interface (`GET /api/docs/<id>/external`, app/SyncChip.tsx):
 *
 * - **synced clones** of its project: the VS Code extension and `overlyx sync --watch` (the CLI's
 *   sync engine). sync.ts notes each of their requests here. A clone counts while its long poll
 *   (`wait`) is open and for PEER_TTL_MS after its last request: a watching clone asks again within
 *   a second of each answer (the server holds a wait ~25 s), so one that stopped, went offline or
 *   paused (another branch, git busy: it looks again after 30 s) drops out within about a minute.
 *   The engine says what it is (`X-OverLyX-Sync-App`: vscode / cli) and on which computer
 *   (`X-OverLyX-Sync-Host`); for engines from before those headers, the credential's name tells
 *   ("OverLyX for VS Code on <host>", "OverLyX CLI on <host>").
 * - **its Google Docs link** (gdocs/): synced on its own every minute, or on request.
 *
 * The computer's name is shown only to the clone's own account; collaborators see whose clone it is.
 */
import crypto from 'node:crypto';
import type { Request } from 'express';
import { verifyAccessToken } from './tokenAuth.ts';
import { linkOf, publicLink } from './gdocs/sync.ts';
import type { SessionUser } from './auth.ts';

/** a clone is shown this long after its last request (its next long poll follows within a second) */
export const PEER_TTL_MS = Number(process.env.OVERLYX_SYNC_PEER_TTL_MS ?? 75_000);

export type PeerApp = 'vscode' | 'cli' | 'other';

interface Peer { userId: number; name: string; username: string; app: PeerApp; host: string | null; since: number; lastSeen: number; open: number }

/** project → clone key → peer */
const peers = new Map<string, Map<string, Peer>>();

/** credential name by Authorization header (engines without the headers), a few hundred at most */
const credentialNames = new Map<string, string | null>();

function credentialName(req: Request): string | null {
  const h = req.headers.authorization ?? '';
  const key = crypto.createHash('sha256').update(h).digest('hex');
  if (credentialNames.has(key)) return credentialNames.get(key)!;
  let name: string | null = null;
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(h);
  if (m) {
    const dec = Buffer.from(m[1], 'base64').toString('utf8');
    const secret = dec.slice(dec.indexOf(':') + 1);
    name = verifyAccessToken(secret)?.name ?? null;
  }
  if (credentialNames.size > 500) credentialNames.clear();
  credentialNames.set(key, name);
  return name;
}

const header = (req: Request, name: string): string | null => {
  const v = req.headers[name];
  if (typeof v !== 'string' || !v) return null;
  try { return decodeURIComponent(v).slice(0, 100); } catch { return null; }
};

/** What kind of clone sent the request, and on which computer. */
export function peerIdentity(req: Request): { app: PeerApp; host: string | null } {
  const app = header(req, 'x-overlyx-sync-app');
  if (app) return { app: app === 'vscode' || app === 'cli' ? app : 'other', host: header(req, 'x-overlyx-sync-host') };
  const cred = credentialName(req) ?? '';
  const host = / on (.+)$/.exec(cred)?.[1]?.slice(0, 100) ?? null;
  return { app: /VS ?Code/i.test(cred) ? 'vscode' : /\bCLI\b/.test(cred) ? 'cli' : 'other', host };
}

function prune(project: string, now = Date.now()): Map<string, Peer> | undefined {
  const ps = peers.get(project);
  if (!ps) return undefined;
  for (const [k, p] of ps) if (!p.open && now - p.lastSeen > PEER_TTL_MS) ps.delete(k);
  if (!ps.size) { peers.delete(project); return undefined; }
  return ps;
}

/**
 * A synced clone of `project` made a request (sync.ts). Returns `done`, to call when a request held
 * open (the long poll) ends — the clone counts as present all that time.
 */
export function notePeer(project: string, user: SessionUser, req: Request): () => void {
  const { app, host } = peerIdentity(req);
  const key = `${user.id}\n${app}\n${host ?? ''}`;
  const now = Date.now();
  let ps = prune(project, now);
  if (!ps) { ps = new Map(); peers.set(project, ps); }
  let p = ps.get(key);
  if (!p) { p = { userId: user.id, name: user.name, username: user.username, app, host, since: now, lastSeen: now, open: 0 }; ps.set(key, p); }
  p.lastSeen = now;
  p.open++;
  const peer = p;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    peer.open--;
    peer.lastSeen = Date.now();
  };
}

export interface ClonePeer {
  /** whose clone: the account's name and username */
  name: string; username: string;
  app: PeerApp;
  /** the computer's name — only for the viewer's own clones */
  host: string | null;
  mine: boolean;
  /** first seen (this server's run), last request */
  since: number; lastSeen: number;
}

/** The synced clones of `project` right now, as `viewer` may see them (the own first). */
export function clonesOf(project: string, viewer: SessionUser): ClonePeer[] {
  const ps = prune(project);
  if (!ps) return [];
  return [...ps.values()]
    .map(p => ({ name: p.name, username: p.username, app: p.app, host: p.userId === viewer.id ? p.host : null, mine: p.userId === viewer.id, since: p.since, lastSeen: p.open ? Date.now() : p.lastSeen }))
    .sort((a, b) => Number(b.mine) - Number(a.mine) || a.name.localeCompare(b.name) || a.since - b.since);
}

export interface ExternalSync {
  clones: ClonePeer[];
  google: { url: string; auto: boolean; lastSync: number | null; lastError: string | null } | null;
}

/** Everything `docId` is kept in step with, for the web interface's sync chip. */
export function externalSyncOf(docId: string, project: string, viewer: SessionUser): ExternalSync {
  const l = publicLink(linkOf(docId));
  return {
    clones: clonesOf(project, viewer),
    google: l ? { url: l.url, auto: l.auto, lastSync: l.lastSync, lastError: l.lastError } : null,
  };
}

/** (tests) forget every clone */
export function resetPeers(): void { peers.clear(); credentialNames.clear(); }
