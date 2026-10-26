/**
 * Deleting an account (Settings ▸ Account ▸ Delete account → POST /api/account/delete) and the
 * trash's expiry — what the privacy notice (privacy.ts) promises about erasure:
 *
 *  - the projects the account owns are erased at once: their directories (git history included),
 *    their rows, build output, versions, published PDF links, sandbox homes, agent working copies,
 *    their trash copies and their mirrors on GitHub. Collaborators lose them too — the dialog lists
 *    the shared ones and points to Share ▸ owner first;
 *  - memberships in other people's projects end; what the person wrote there stays (it is part of
 *    those documents), as does their name in those projects' history and comments;
 *  - sign-ins (git, MCP, OAuth grants, connected agents), the Agent panel's codex home and threads,
 *    the Google Drive and Zotero connections, folded-section state, reports they sent, the cached avatar and
 *    the account row go; activity-log entries and error reports keep no link to the account.
 *  - the nightly backups (scripts/backup.sh, 14 kept) still hold the account until they roll off.
 *
 * Deleted projects and files wait in `<data>/trash` for TRASH_DAYS (restorable by the operator),
 * then pruneTrash erases them along with the archived mirror.
 */
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.ts';
import { config } from './config.ts';
import type { SessionUser } from './auth.ts';
import { resolveProjectPath } from './projects.ts';
import { cleanupProjectData } from './export.ts';
import { deleteMirror, deleteArchivedMirror } from './mirror.ts';
import { removeWorkspace } from './agentwork.ts';
import { forgetAgentUser } from './agent.ts';
import { disconnectDrive } from './gdocs/google.ts';
import { disconnectLessWrong } from './lesswrong/api.ts';
import { disconnectZotero } from './zotero.ts';
import './gdocs/sync.ts';   // its gdocs_links table
import './lesswrong/sync.ts';   // its lesswrong_links table
import { forgetUserReports } from './feedback.ts';

export const TRASH_DAYS = 30;

/** The account the instance belongs to (OVERLYX_OWNER_EMAIL) — not deletable from the app. */
export function isInstanceOwner(user: SessionUser): boolean {
  const owner = config.ownerEmail;
  return !!owner && ((user.email ?? '').toLowerCase() === owner || user.username.toLowerCase() === owner);
}

export interface DeletionPreview {
  /** the projects that will be erased; `people` = how many others can open each */
  owned: { project: string; title: string | null; people: number }[];
  /** other people's projects the account is a member of */
  memberOf: number;
  /** why the account cannot be deleted here (the instance owner), else null */
  refused: string | null;
}

export function deletionPreview(user: SessionUser): DeletionPreview {
  const owned = (db.prepare("SELECT name, title FROM projects WHERE owner_id = ? AND kind != 'example-gone' ORDER BY name").all(user.id) as { name: string; title: string | null }[])
    .map(p => ({
      project: p.name, title: p.title,
      people: (db.prepare('SELECT COUNT(*) AS n FROM project_members WHERE project = ? AND (user_id IS NULL OR user_id != ?)').get(p.name, user.id) as { n: number }).n,
    }));
  const memberOf = (db.prepare('SELECT COUNT(DISTINCT project) AS n FROM project_members WHERE user_id = ?').get(user.id) as { n: number }).n;
  return { owned, memberOf, refused: isInstanceOwner(user) ? 'This is the account of the instance’s owner; it cannot be deleted from the app.' : null };
}

/** What a running server must do for a project or a member (DocManager), handed in by index.ts. */
export interface LiveDocs {
  closeProject(project: string): Promise<void>;
  kick(project: string, userIds: number[], reason?: string): number;
}

const docPrefix = (project: string) => [project.length + 1, project + '/'] as const;

/** Erase one project the deleted account owned (nothing of it is kept, unlike trashProject). */
async function eraseProject(project: string, live: LiveDocs): Promise<void> {
  await live.closeProject(project);
  try { fs.rmSync(resolveProjectPath(project, '.'), { recursive: true, force: true }); }
  catch (e) { console.error(`[account] cannot remove the directory of ${project}:`, (e as Error).message); }
  cleanupProjectData(project);
  for (const t of db.prepare('SELECT thread_id FROM agent_threads WHERE project = ?').all(project) as { thread_id: string }[]) removeWorkspace(t.thread_id);
  db.transaction(() => {
    for (const t of ['project_members', 'share_links', 'admin_grants', 'access_log', 'agent_threads']) db.prepare(`DELETE FROM ${t} WHERE project = ?`).run(project);
    db.prepare('DELETE FROM project_aliases WHERE name = ?').run(project);
    db.prepare('DELETE FROM gdocs_links WHERE substr(doc_id, 1, ?) = ?').run(...docPrefix(project));
    db.prepare('DELETE FROM lesswrong_links WHERE substr(doc_id, 1, ?) = ?').run(...docPrefix(project));
    db.prepare('DELETE FROM projects WHERE name = ?').run(project);
  })();
  await deleteMirror(project);
}

/** The trash entries of a namespace (deleted projects and files of `<owner>/…`). */
function trashEntriesOf(owner: string): string[] {
  const trash = path.join(config.dataDir, 'trash');
  // (`trash/files` holds everybody's deleted files: an account named "files" only owns its own part of it)
  const out = [...(owner === 'files' ? [] : [path.join(trash, owner)]), path.join(trash, 'files', owner)];
  try { for (const n of fs.readdirSync(path.join(trash, 'files'))) if (n.startsWith(owner + '__')) out.push(path.join(trash, 'files', n)); } catch { /* no trash */ }
  return out.filter(p => fs.existsSync(p));
}

/** Project keys of the deleted projects waiting in a namespace's trash (`trash/<owner>/<name>-<stamp>`). */
function trashedProjects(owner: string): string[] {
  try { return fs.readdirSync(path.join(config.dataDir, 'trash', owner)).map(n => stampOf(n)?.name).filter((n): n is string => !!n).map(n => `${owner}/${n}`); }
  catch { return []; }
}

/** `<name>-2026-10-11T10-23-14-123Z` → the name and when it went to the trash */
function stampOf(entry: string): { name: string; at: number } | null {
  const m = /^(.*)-(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z$/.exec(entry);
  if (!m) return null;
  const at = Date.parse(`${m[2]}T${m[3]}:${m[4]}:${m[5]}.${m[6]}Z`);
  return Number.isNaN(at) ? null : { name: m[1], at };
}

/**
 * Delete the account and everything it owns (see the header). The caller checked the confirmation
 * and that the account is not the instance owner's. Returns the erased projects.
 */
export async function deleteAccount(user: SessionUser, live: LiveDocs): Promise<string[]> {
  if (isInstanceOwner(user)) throw new Error('the instance owner’s account cannot be deleted');
  const id = user.id;
  const owned = (db.prepare('SELECT name, kind FROM projects WHERE owner_id = ?').all(id) as { name: string; kind: string }[]);
  const erased: string[] = [];
  for (const p of owned) {
    if (p.kind === 'example-gone') { db.prepare('DELETE FROM projects WHERE name = ?').run(p.name); continue; }
    await eraseProject(p.name, live);
    erased.push(p.name);
  }
  // the namespace: deleted projects waiting in the trash (and their archived mirrors), the empty directory
  for (const p of trashedProjects(user.username)) await deleteMirror(p);
  for (const p of trashEntriesOf(user.username)) fs.rmSync(p, { recursive: true, force: true });
  try { fs.rmdirSync(path.join(config.projectsDir, user.username)); } catch { /* not empty (someone else's project moved in) or absent */ }

  for (const { project } of db.prepare('SELECT DISTINCT project FROM project_members WHERE user_id = ?').all(id) as { project: string }[]) live.kick(project, [id], 'account deleted');
  forgetAgentUser(id);
  for (const t of db.prepare('SELECT thread_id FROM agent_threads WHERE user_id = ?').all(id) as { thread_id: string }[]) removeWorkspace(t.thread_id);
  await disconnectDrive(id).catch(() => undefined);
  await disconnectLessWrong(id).catch(() => undefined);
  disconnectZotero(id);
  db.transaction(() => {
    const agents = (db.prepare('SELECT id FROM mcp_agents WHERE user_id = ?').all(id) as { id: number }[]).map(a => a.id);
    for (const a of agents) db.prepare('DELETE FROM mcp_sessions WHERE agent_id = ?').run(a);
    for (const t of ['project_members', 'git_tokens', 'mcp_tokens', 'oauth_codes', 'oauth_grants', 'mcp_agent_messages', 'mcp_agents',
      'agent_threads', 'user_doc_state', 'starter_projects', 'admin_grants', 'gdocs_links', 'lesswrong_links']) db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(id);
    db.prepare('UPDATE access_log SET user_id = NULL WHERE user_id = ?').run(id);
    db.prepare('UPDATE project_members SET added_by = NULL WHERE added_by = ?').run(id);
    db.prepare('UPDATE pdf_links SET created_by = NULL WHERE created_by = ?').run(id);
    db.prepare('UPDATE pdf_publish SET created_by = NULL WHERE created_by = ?').run(id);
    forgetUserReports(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  })();
  fs.rmSync(path.join(config.dataDir, 'cache', `avatar-${id}`), { force: true });
  console.log(`[account] account ${id} deleted with ${erased.length} project(s)`);
  return erased;
}

/**
 * Trash entries older than `days` are erased, and the archived mirrors of the projects among them
 * deleted (startup and daily housekeeping). Returns how many entries went.
 */
export async function pruneTrash(days = TRASH_DAYS): Promise<number> {
  const trash = path.join(config.dataDir, 'trash');
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const ls = (d: string) => { try { return fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { return []; } };
  let n = 0;
  // trash/<owner>/<name>-<stamp> (projects) and trash/files/<owner>/<name>-<stamp>, trash/files/<owner>__<name>-<stamp> (files)
  for (const top of ls(trash)) {
    const flat = stampOf(top);   // a project deleted before namespaces: trash/<name>-<stamp>
    if (flat) { if (flat.at < cutoff) { fs.rmSync(path.join(trash, top), { recursive: true, force: true }); n++; } continue; }
    const projects = top !== 'files';
    const groups = projects ? [path.join(trash, top)] : [path.join(trash, 'files'), ...ls(path.join(trash, 'files')).filter(d => !stampOf(d)).map(d => path.join(trash, 'files', d))];
    for (const dir of groups) {
      for (const entry of ls(dir)) {
        const s = stampOf(entry);
        if (!s || s.at >= cutoff) continue;
        fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
        n++;
        if (projects) await deleteArchivedMirror(`${top}/${s.name}`);
      }
      if (dir !== path.join(trash, 'files')) try { fs.rmdirSync(dir); } catch { /* not empty */ }
    }
  }
  if (n) console.log(`[trash] erased ${n} entr${n === 1 ? 'y' : 'ies'} older than ${days} days`);
  return n;
}
