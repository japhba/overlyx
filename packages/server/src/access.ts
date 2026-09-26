/**
 * Who may see and edit which project — a Google-Docs-like model:
 *
 *  - every project has an **owner** and lives in the owner's namespace: `<owner>/<name>`, the
 *    directory `<projects root>/<owner>/<name>` (namespaces.ts, core projectKey.ts). New projects
 *    belong to whoever created them; a directory without a row in a namespace is adopted by that
 *    namespace's account, one at the top level (created by hand) moves into the instance owner's
 *    namespace (`OVERLYX_OWNER_EMAIL`, else the first admin);
 *  - the owner **shares** it with people (by username or e-mail — an e-mail that has not signed in
 *    yet is kept as an invitation and matched on the first Google sign-in) as *viewer* or *editor*;
 *  - or turns on **link sharing**: anyone who opens `/#/share/<token>` joins as viewer/editor —
 *    without an account as a **guest** (a temporary account, see `adoptGuest`); turning the link
 *    off revokes what was granted through it;
 *  - administrators do **not** see everything: an administrator opens somebody else's project only through
 *    an explicit, time-limited grant ("open as administrator"), which is written to the project's activity log;
 *  - the **activity log** of a project (who opened, built, pulled, pushed, shared, and administrator
 *    access) is visible to its owner;
 *  - every account gets a personal **example project** ("Welcome to OverLyX") the first time its
 *    project list is requested.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { LLANGLE_PREAMBLE, isProjectKey, splitProjectKey } from '@overlyx/core';
import { db, type MemberRow, type ProjectRow, type UserRow } from './db.ts';
import { config } from './config.ts';
import type { SessionUser } from './auth.ts';
import { listProjects, namespaces, resolveProjectPath, type Project } from './projects.ts';
import { freeKey, moveFlatProjects, moveProject } from './namespaces.ts';

export type Role = 'owner' | 'edit' | 'view';
const RANK: Record<Role, number> = { view: 1, edit: 2, owner: 3 };
export function atLeast(role: Role | null | undefined, min: Role): boolean { return !!role && RANK[role] >= RANK[min]; }
export function isRole(x: unknown): x is 'view' | 'edit' { return x === 'view' || x === 'edit'; }

export function projectRow(name: string): ProjectRow | undefined {
  return db.prepare('SELECT * FROM projects WHERE name = ?').get(name) as ProjectRow | undefined;
}

export function registerProject(name: string, ownerId: number | null, opts: { title?: string | null; kind?: string } = {}): ProjectRow {
  db.prepare('INSERT OR IGNORE INTO projects (name, title, owner_id, kind, created_at) VALUES (?,?,?,?,?)')
    .run(name, opts.title ?? null, ownerId, opts.kind ?? 'project', Date.now());
  return projectRow(name)!;
}

/** The instance owner (OVERLYX_OWNER_EMAIL, matched against e-mail or username), else the first admin. */
export function defaultOwner(): UserRow | undefined {
  if (config.ownerEmail) {
    const u = db.prepare('SELECT * FROM users WHERE lower(email) = ? OR username = ? ORDER BY id LIMIT 1').get(config.ownerEmail, config.ownerEmail) as UserRow | undefined;
    if (u) return u;
  }
  return db.prepare('SELECT * FROM users WHERE is_admin = 1 ORDER BY id LIMIT 1').get() as UserRow | undefined;
}

/**
 * Give every project directory that has no row yet an owner: the account whose namespace it is in.
 * Directories at the top level (created by hand, or of the flat layout from before namespaces) move
 * into their owner's namespace first — the instance owner's, when no row names one. Cheap; run on
 * every listing.
 */
export function adoptProjects(): void {
  moveFlatProjects(defaultOwner()?.username ?? null);
  if (!fs.existsSync(config.projectsDir)) return;
  const known = new Set((db.prepare('SELECT name FROM projects').all() as { name: string }[]).map(r => r.name));
  const users = namespaces();
  for (const ns of fs.readdirSync(config.projectsDir, { withFileTypes: true })) {
    if (!ns.isDirectory() || !users.has(ns.name)) continue;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(path.join(config.projectsDir, ns.name), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const key = `${ns.name}/${e.name}`;
      if (!e.isDirectory() || e.name.startsWith('.') || known.has(key) || !isProjectKey(key)) continue;
      const owner = db.prepare('SELECT id FROM users WHERE username = ?').get(ns.name) as { id: number } | undefined;
      registerProject(key, owner?.id ?? null);
      console.log(`[access] adopted project directory "${key}"`);
    }
  }
}

function userEmail(user: SessionUser): string { return (user.email ?? '').trim().toLowerCase(); }

/** The user's role in a project (null = no access). An administrator's access is an explicit, logged grant (see below). */
export function roleFor(user: SessionUser, project: string): Role | null {
  if (!isProjectKey(project)) return null;
  const row = projectRow(project);
  if (!row) return null;
  if (row.owner_id === user.id) return 'owner';
  if (user.isAdmin && adminGrantActive(user.id, project)) return 'owner';
  const m = db.prepare(`SELECT role FROM project_members WHERE project = ? AND (user_id = ? OR (email IS NOT NULL AND email = ?))
                        ORDER BY CASE role WHEN 'edit' THEN 0 ELSE 1 END LIMIT 1`).get(project, user.id, userEmail(user) || '\0') as { role: string } | undefined;
  return m && isRole(m.role) ? m.role : null;
}

export interface ProjectAccess extends Project {
  title: string | null;
  kind: string;
  role: Role;
  /** how the user got in: owns it / shared with them / joined via link / administrator */
  via: 'owner' | 'member' | 'link' | 'admin';
  owner: { id: number; name: string; username: string } | null;
}

/** Projects the user can open, with their role in each. */
export function accessibleProjects(user: SessionUser): ProjectAccess[] {
  adoptProjects();
  const rows = new Map((db.prepare('SELECT * FROM projects').all() as ProjectRow[]).map(r => [r.name, r]));
  const memberships = new Map<string, MemberRow>();
  for (const m of db.prepare('SELECT * FROM project_members WHERE user_id = ? OR (email IS NOT NULL AND email = ?)').all(user.id, userEmail(user) || '\0') as MemberRow[]) {
    const prev = memberships.get(m.project);
    if (!prev || (m.role === 'edit' && prev.role !== 'edit')) memberships.set(m.project, m);
  }
  const owners = new Map((db.prepare('SELECT id, display_name, username FROM users').all() as { id: number; display_name: string; username: string }[]).map(u => [u.id, { id: u.id, name: u.display_name, username: u.username }]));
  const out: ProjectAccess[] = [];
  for (const p of listProjects()) {
    const row = rows.get(p.name);
    const m = memberships.get(p.name);
    let role: Role | null = null;
    let via: ProjectAccess['via'] = 'member';
    if (row?.owner_id === user.id) { role = 'owner'; via = 'owner'; }
    else if (m && isRole(m.role)) { role = m.role; via = m.via === 'link' ? 'link' : 'member'; }
    else if (user.isAdmin && adminGrantActive(user.id, p.name)) { role = 'owner'; via = 'admin'; }
    if (!role) continue;
    out.push({ ...p, title: row?.title ?? null, kind: row?.kind ?? 'project', role, via, owner: row?.owner_id != null ? owners.get(row.owner_id) ?? null : null });
  }
  return out;
}

/* ---------------------------------------------------------- administrators */

/** An administrator's grant on a project: owner rights for a while, always logged. */
export function adminGrantActive(userId: number, project: string): boolean {
  const r = db.prepare('SELECT until FROM admin_grants WHERE project = ? AND user_id = ?').get(project, userId) as { until: number } | undefined;
  return !!r && r.until > Date.now();
}

/** Give an administrator owner rights on a project for `minutes` (at most a day); the owner sees it in the activity log. */
export function grantAdminAccess(user: SessionUser, project: string, minutes = 60): number {
  if (!user.isAdmin) throw new Error('administrators only');
  if (!isProjectKey(project) || !projectRow(project)) throw new Error('project not found');
  const m = Math.max(1, Math.min(Math.round(Number(minutes) || 60), 24 * 60));
  const until = Date.now() + m * 60 * 1000;
  db.prepare('INSERT INTO admin_grants (project, user_id, until) VALUES (?, ?, ?) ON CONFLICT(project, user_id) DO UPDATE SET until = excluded.until').run(project, user.id, until);
  logAccess(project, user.id, 'admin-access', `${m} min`);
  return until;
}

export interface AdminProjectInfo {
  name: string; title: string | null; kind: string;
  owner: { id: number; name: string; username: string } | null;
  /** how the administrator can open it now: as owner/member like anyone, through an active grant, or not at all */
  access: 'owner' | 'member' | 'granted' | null;
  grantUntil: number | null;
}

/** Every project on the instance, for the administration section of the start screen. */
export function projectsForAdmin(user: SessionUser): AdminProjectInfo[] {
  if (!user.isAdmin) return [];
  adoptProjects();
  const rows = new Map((db.prepare('SELECT * FROM projects').all() as ProjectRow[]).map(r => [r.name, r]));
  const owners = new Map((db.prepare('SELECT id, display_name, username FROM users').all() as { id: number; display_name: string; username: string }[]).map(u => [u.id, { id: u.id, name: u.display_name, username: u.username }]));
  const mine = new Set(accessibleProjects(user).filter(p => p.via !== 'admin').map(p => p.name));
  return listProjects().map(p => {
    const row = rows.get(p.name);
    const g = db.prepare('SELECT until FROM admin_grants WHERE project = ? AND user_id = ?').get(p.name, user.id) as { until: number } | undefined;
    const granted = !!g && g.until > Date.now();
    return {
      name: p.name, title: row?.title ?? null, kind: row?.kind ?? 'project',
      owner: row?.owner_id != null ? owners.get(row.owner_id) ?? null : null,
      access: mine.has(p.name) ? (row?.owner_id === user.id ? 'owner' : 'member') : granted ? 'granted' : null,
      grantUntil: granted ? g!.until : null,
    };
  });
}

/* ------------------------------------------------------------ activity log */

export type AccessAction = 'open' | 'build' | 'git-fetch' | 'git-push' | 'share' | 'admin-access';
/** repeated opens / pulls by the same person are one entry per 10 minutes */
const DEDUPE_MS = 10 * 60 * 1000;

/** Record who did what in a project (never throws — logging must not break the action). */
export function logAccess(project: string, userId: number | null, action: AccessAction, detail: string | null = null): void {
  try {
    if (action === 'open' || action === 'git-fetch' || action === 'git-push') {
      const last = db.prepare('SELECT at FROM access_log WHERE project = ? AND user_id IS ? AND action = ? AND detail IS ? ORDER BY at DESC LIMIT 1').get(project, userId, action, detail) as { at: number } | undefined;
      if (last && Date.now() - last.at < DEDUPE_MS) return;
    }
    db.prepare('INSERT INTO access_log (project, user_id, action, detail, at) VALUES (?, ?, ?, ?, ?)').run(project, userId, action, detail, Date.now());
  } catch (e) { console.error('[access] cannot write the activity log:', e); }
}

export interface ActivityEntry { id: number; action: AccessAction; detail: string | null; at: number; user: { id: number; name: string; username: string } | null }

/** The newest entries of a project's activity log (owner's view). */
export function activityOf(project: string, limit = 50): ActivityEntry[] {
  const rows = db.prepare(`SELECT l.id, l.action, l.detail, l.at, u.id AS uid, u.display_name AS uname, u.username
                           FROM access_log l LEFT JOIN users u ON u.id = l.user_id WHERE l.project = ? ORDER BY l.at DESC, l.id DESC LIMIT ?`).all(project, Math.max(1, Math.min(limit, 500))) as
    { id: number; action: AccessAction; detail: string | null; at: number; uid: number | null; uname: string | null; username: string | null }[];
  return rows.map(r => ({ id: r.id, action: r.action, detail: r.detail, at: r.at, user: r.uid != null ? { id: r.uid, name: r.uname ?? '', username: r.username ?? '' } : null }));
}

/** Forget entries older than `days` (startup housekeeping). */
export function pruneAccessLog(days = 90): void {
  db.prepare('DELETE FROM access_log WHERE at < ?').run(Date.now() - days * 24 * 60 * 60 * 1000);
  db.prepare('DELETE FROM admin_grants WHERE until < ?').run(Date.now());
}

/* ----------------------------------------------------------------- sharing */

export interface ShareInfo {
  name: string;
  title: string | null;
  owner: { id: number; name: string; username: string } | null;
  members: { id: number; role: string; via: string; email: string | null; user: { id: number; name: string; username: string; color: string; avatar: string | null } | null }[];
  link: { token: string; role: 'view' | 'edit' } | null;
}

export function shareInfo(project: string): ShareInfo {
  const row = projectRow(project);
  const owner = row?.owner_id != null ? db.prepare('SELECT id, display_name AS name, username FROM users WHERE id = ?').get(row.owner_id) as ShareInfo['owner'] : null;
  const members = (db.prepare('SELECT * FROM project_members WHERE project = ? ORDER BY created_at').all(project) as MemberRow[]).map(m => {
    const u = m.user_id != null ? db.prepare('SELECT id, display_name AS name, username, color, avatar_url FROM users WHERE id = ?').get(m.user_id) as { id: number; name: string; username: string; color: string; avatar_url: string | null } | undefined : undefined;
    return { id: m.id, role: m.role, via: m.via, email: m.email, user: u ? { id: u.id, name: u.name, username: u.username, color: u.color, avatar: u.avatar_url ? `/api/users/${u.id}/avatar` : null } : null };
  });
  return { name: project, title: row?.title ?? null, owner: owner ?? null, members, link: row?.link_token && isRole(row.link_role) ? { token: row.link_token, role: row.link_role } : null };
}

/** Share with a person: `who` is a username or an e-mail address. */
export function addMember(project: string, who: string, role: 'view' | 'edit', addedBy: SessionUser): MemberRow {
  const row = projectRow(project);
  if (!row) throw new Error('project not found');
  const key = who.trim().toLowerCase();
  if (!key) throw new Error('enter a username or e-mail address');
  let user: UserRow | undefined;
  let email: string | null = null;
  if (key.includes('@')) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(key)) throw new Error('not a valid e-mail address');
    user = db.prepare('SELECT * FROM users WHERE lower(email) = ?').get(key) as UserRow | undefined;
    email = key;
  } else {
    user = db.prepare('SELECT * FROM users WHERE username = ?').get(key) as UserRow | undefined;
    if (!user) throw new Error(`no user "${key}" — use their e-mail address to invite them`);
  }
  if (user && user.id === row.owner_id) throw new Error('that is the owner of the project');
  if (user?.is_guest) throw new Error('that is a guest — they have to sign in before you can share with them by name');
  const now = Date.now();
  if (user) {
    db.prepare(`INSERT INTO project_members (project, user_id, email, role, via, added_by, created_at) VALUES (?,?,?,?,?,?,?)
                ON CONFLICT(project, user_id) WHERE user_id IS NOT NULL DO UPDATE SET role = excluded.role, via = excluded.via`)
      .run(project, user.id, null, role, email ? 'email' : 'user', addedBy.id, now);
    // an older invitation of the same e-mail is superseded
    if (email) db.prepare('DELETE FROM project_members WHERE project = ? AND user_id IS NULL AND email = ?').run(project, email);
    return db.prepare('SELECT * FROM project_members WHERE project = ? AND user_id = ?').get(project, user.id) as MemberRow;
  }
  db.prepare(`INSERT INTO project_members (project, user_id, email, role, via, added_by, created_at) VALUES (?,?,?,?,?,?,?)
              ON CONFLICT(project, email) WHERE email IS NOT NULL DO UPDATE SET role = excluded.role`)
    .run(project, null, email, role, 'email', addedBy.id, now);
  return db.prepare('SELECT * FROM project_members WHERE project = ? AND email = ?').get(project, email) as MemberRow;
}

export function memberRow(project: string, memberId: number): MemberRow | undefined {
  return db.prepare('SELECT * FROM project_members WHERE id = ? AND project = ?').get(memberId, project) as MemberRow | undefined;
}

/** The accounts that came in through the share link. */
export function linkMemberIds(project: string): number[] {
  return (db.prepare("SELECT user_id FROM project_members WHERE project = ? AND via = 'link' AND user_id IS NOT NULL").all(project) as { user_id: number }[]).map(r => r.user_id);
}

export function setMemberRole(project: string, memberId: number, role: 'view' | 'edit'): boolean {
  return db.prepare('UPDATE project_members SET role = ? WHERE id = ? AND project = ?').run(role, memberId, project).changes > 0;
}

export function removeMember(project: string, memberId: number): boolean {
  return db.prepare('DELETE FROM project_members WHERE id = ? AND project = ?').run(memberId, project).changes > 0;
}

/** Turn link sharing on (with a role) or off (revoking everyone who joined through the link). */
export function setLink(project: string, role: 'view' | 'edit' | null): ShareInfo['link'] {
  const row = projectRow(project);
  if (!row) throw new Error('project not found');
  if (!role) {
    db.prepare('UPDATE projects SET link_token = NULL, link_role = NULL WHERE name = ?').run(project);
    db.prepare("DELETE FROM project_members WHERE project = ? AND via = 'link'").run(project);
    return null;
  }
  const token = row.link_token ?? crypto.randomBytes(18).toString('base64url');
  db.prepare('UPDATE projects SET link_token = ?, link_role = ? WHERE name = ?').run(token, role, project);
  // people who came in through the link follow the link's role
  db.prepare("UPDATE project_members SET role = ? WHERE project = ? AND via = 'link'").run(role, project);
  return { token, role };
}

/** The project a share link opens, if the link is live. */
export function linkProject(token: string): ProjectRow | undefined {
  const row = db.prepare('SELECT * FROM projects WHERE link_token = ?').get(token) as ProjectRow | undefined;
  return row && isRole(row.link_role) ? row : undefined;
}

/** A signed-in user (or guest) opens a share link: they join the project with the link's role. */
export function acceptLink(token: string, user: SessionUser): { project: ProjectRow; role: Role } {
  const row = linkProject(token);
  if (!row || !isRole(row.link_role)) throw new Error('This link is not valid (any more). Ask the owner to share the project again.');
  const current = roleFor(user, row.name);
  if (atLeast(current, row.link_role)) return { project: row, role: current! };
  db.prepare(`INSERT INTO project_members (project, user_id, email, role, via, added_by, created_at) VALUES (?,?,?,?,?,?,?)
              ON CONFLICT(project, user_id) WHERE user_id IS NOT NULL DO UPDATE SET role = excluded.role, via = excluded.via`)
    .run(row.name, user.id, null, row.link_role, 'link', row.owner_id, Date.now());
  return { project: row, role: row.link_role };
}

/** The account a project is handed to (by username or e-mail); throws when there is none. */
export function newOwner(username: string): { id: number; username: string } {
  const u = db.prepare('SELECT id, username, is_guest FROM users WHERE username = ? OR lower(email) = ?').get(username.toLowerCase(), username.toLowerCase()) as { id: number; username: string; is_guest: number } | undefined;
  if (!u) throw new Error(`no user "${username}"`);
  if (u.is_guest) throw new Error('a guest cannot own a project — they have to sign in first');
  return { id: u.id, username: u.username };
}

/**
 * Hand a project to another account: it moves into the new owner's namespace (the old key stays an
 * alias). Nothing of the project may be open (DocManager.closeProject). Returns the new key.
 */
export function setOwner(project: string, owner: { id: number; username: string }): string {
  db.prepare('UPDATE projects SET owner_id = ? WHERE name = ?').run(owner.id, project);
  db.prepare('DELETE FROM project_members WHERE project = ? AND user_id = ?').run(project, owner.id);
  const { owner: ns, name } = splitProjectKey(project);
  if (ns === owner.username) return project;
  const to = freeKey(owner.username, name);
  moveProject(project, to);
  return to;
}

/** After a sign-in with a known e-mail: invitations addressed to that e-mail now belong to the account. */
export function bindInvitations(userId: number, email: string | null | undefined): void {
  const key = (email ?? '').trim().toLowerCase();
  if (!key) return;
  for (const m of db.prepare('SELECT * FROM project_members WHERE user_id IS NULL AND email = ?').all(key) as MemberRow[]) {
    const existing = db.prepare('SELECT id, role FROM project_members WHERE project = ? AND user_id = ?').get(m.project, userId) as { id: number; role: string } | undefined;
    if (existing) {
      if (m.role === 'edit' && existing.role !== 'edit') db.prepare('UPDATE project_members SET role = ? WHERE id = ?').run('edit', existing.id);
      db.prepare('DELETE FROM project_members WHERE id = ?').run(m.id);
    } else {
      db.prepare('UPDATE project_members SET user_id = ? WHERE id = ?').run(userId, m.id);
    }
  }
}

/**
 * A guest signs in: what the guest gathered through share links now belongs to the account (like
 * `bindInvitations` for e-mail invitations), the guest account is gone. An explicit membership of
 * the account is never lowered, and a link's `edit` still raises a `view` one (as `acceptLink`
 * does). Returns the projects whose access changed for the guest (their connections are stale).
 */
export function adoptGuest(guest: SessionUser, userId: number): string[] {
  if (!guest.guest || guest.id === userId) return [];
  const moved: string[] = [];
  db.transaction(() => {
    for (const m of db.prepare('SELECT * FROM project_members WHERE user_id = ?').all(guest.id) as MemberRow[]) {
      moved.push(m.project);
      const owner = projectRow(m.project)?.owner_id === userId;
      const existing = db.prepare('SELECT id, role FROM project_members WHERE project = ? AND user_id = ?').get(m.project, userId) as { id: number; role: string } | undefined;
      if (owner || existing) {
        if (existing && m.role === 'edit' && existing.role !== 'edit') db.prepare("UPDATE project_members SET role = 'edit', via = 'link' WHERE id = ?").run(existing.id);
        db.prepare('DELETE FROM project_members WHERE id = ?').run(m.id);
      } else {
        db.prepare('UPDATE project_members SET user_id = ? WHERE id = ?').run(userId, m.id);
      }
    }
    db.prepare('UPDATE access_log SET user_id = ? WHERE user_id = ?').run(userId, guest.id);
    // the guest's folded sections come along (the account's own win where both have some)
    db.prepare('UPDATE OR IGNORE user_doc_state SET user_id = ? WHERE user_id = ?').run(userId, guest.id);
    db.prepare('DELETE FROM user_doc_state WHERE user_id = ?').run(guest.id);
    db.prepare('DELETE FROM users WHERE id = ? AND is_guest = 1').run(guest.id);
  })();
  return moved;
}

/** Guests whose session has expired are forgotten (startup housekeeping). */
export function pruneGuests(days = config.sessionDays + 1): number {
  const stale = (db.prepare('SELECT id FROM users WHERE is_guest = 1 AND created_at < ?').all(Date.now() - days * 24 * 60 * 60 * 1000) as { id: number }[]).map(r => r.id);
  db.transaction(() => {
    for (const id of stale) {
      db.prepare('DELETE FROM project_members WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM user_doc_state WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
    }
  })();
  return stale.length;
}

/** Is this e-mail invited anywhere (for the `invited` sign-up policy)? */
export function isInvited(email: string | null | undefined): boolean {
  const key = (email ?? '').trim().toLowerCase();
  if (!key) return false;
  if (config.ownerEmail && key === config.ownerEmail) return true;
  return !!db.prepare('SELECT 1 FROM project_members WHERE email = ? LIMIT 1').get(key) || !!db.prepare('SELECT 1 FROM users WHERE lower(email) = ? LIMIT 1').get(key);
}

/** Move a project directory to the data dir's trash and forget its rows. Returns the trash path. */
export function trashProject(project: string): string {
  const dir = resolveProjectPath(project, '.');
  const trash = path.join(config.dataDir, 'trash');
  fs.mkdirSync(trash, { recursive: true });
  const dest = path.join(trash, `${project}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dir)) {
    try { fs.renameSync(dir, dest); }
    catch { fs.cpSync(dir, dest, { recursive: true }); fs.rmSync(dir, { recursive: true, force: true }); }
  }
  const row = projectRow(project);
  db.prepare('DELETE FROM project_members WHERE project = ?').run(project);
  // administrator grants and the activity log belong to this project, not to a later one of the same name
  db.prepare('DELETE FROM admin_grants WHERE project = ?').run(project);
  db.prepare('DELETE FROM access_log WHERE project = ?').run(project);
  // old names do not lead to a later project of this name
  db.prepare('DELETE FROM project_aliases WHERE name = ?').run(project);
  // a deleted example project is not re-created: keep a tombstone row, under a hidden name that no
  // project can take (core isProjectName)
  if (row?.kind === 'example') db.prepare("UPDATE projects SET name = ?, kind = 'example-gone', link_token = NULL, link_role = NULL WHERE name = ?").run(project.replace('/', '/.deleted-') + '-' + Date.now(), project);
  else db.prepare('DELETE FROM projects WHERE name = ?').run(project);
  return dest;
}

/* ---------------------------------------------------------- example project */

export const WELCOME_TITLE = 'Welcome to OverLyX';
const TEMPLATE_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../templates/welcome');

/** Plain text for a LyX file body: no backslashes / control characters (they would be LyX syntax). */
function lyxSafe(s: string): string { return s.replace(/[\\\x00-\x1f]/g, '').trim() || 'there'; }

/**
 * Every account gets its own copy of the example project the first time it is asked for. The
 * document is personalised (the account's name is its author), so there is one per user; deleting
 * it is final (a tombstone row prevents re-creation). Guests get none: they are here for somebody
 * else's project, and their account is temporary.
 */
export function ensureWelcomeProject(user: SessionUser): string | null {
  if (user.guest) return null;
  const existing = db.prepare("SELECT name, kind FROM projects WHERE owner_id = ? AND kind IN ('example', 'example-gone') ORDER BY created_at LIMIT 1").get(user.id) as { name: string; kind: string } | undefined;
  if (existing) return existing.kind === 'example' ? existing.name : null;
  if (!fs.existsSync(path.join(TEMPLATE_DIR, 'welcome.tex'))) return null;
  const name = freeKey(user.username, 'welcome');
  const dir = resolveProjectPath(name, '.');
  fs.mkdirSync(dir, { recursive: true });
  copyTemplate(TEMPLATE_DIR, dir, { NAME: lyxSafe(user.name), FIRSTNAME: lyxSafe(user.name).split(/\s+/)[0], USERNAME: user.username, LLANGLE: LLANGLE_PREAMBLE.trimEnd() });
  registerProject(name, user.id, { title: WELCOME_TITLE, kind: 'example' });
  console.log(`[access] created example project "${name}" for ${user.username}`);
  return name;
}

function copyTemplate(from: string, to: string, vars: Record<string, string>): void {
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name), dst = path.join(to, e.name);
    if (e.isDirectory()) { fs.mkdirSync(dst, { recursive: true }); copyTemplate(src, dst, vars); continue; }
    if (/\.(lyx|bib|tex)$/.test(e.name)) {
      // placeholders: @@NAME@@ in .tex files ("%%" starts a comment there), %%NAME%% elsewhere
      const text = fs.readFileSync(src, 'utf8').replace(/(?:%%|@@)([A-Z]+)(?:%%|@@)/g, (m, k: string) => vars[k] ?? m);
      fs.writeFileSync(dst, text, 'utf8');
    } else {
      fs.copyFileSync(src, dst);
    }
  }
}

/** The personalised text of the example document (for tests and previews). */
export function welcomeDocumentText(name: string): string {
  const vars = { NAME: lyxSafe(name), FIRSTNAME: lyxSafe(name).split(/\s+/)[0], USERNAME: name, LLANGLE: LLANGLE_PREAMBLE.trimEnd() };
  return fs.readFileSync(path.join(TEMPLATE_DIR, 'welcome.tex'), 'utf8').replace(/(?:%%|@@)([A-Z]+)(?:%%|@@)/g, (m, k: string) => (vars as Record<string, string>)[k] ?? m);
}
