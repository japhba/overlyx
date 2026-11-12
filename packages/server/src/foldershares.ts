/**
 * Folder shares: one folder of a project shared on its own instead of the whole project — with
 * people by name or e-mail (`folder_members`), or through a share link that names it
 * (`share_links.path`). Whoever comes in that way is never a row of `project_members`, so
 * `roleFor` (access.ts) — and with it every route, the WebSocket, git, search, MCP, the agent —
 * does not know them and refuses them. Only what asks about a path (`roleAt`) lets them in: the
 * folder's files and documents, their builds and pictures (index.ts needPaths and the /docs routes,
 * ws.ts, deliverables.ts).
 *
 * A folder shared for editing is built as a project of its own (`confinedRoot`): builds, typeset
 * snippets and printed pages of its documents see only that folder, so that whoever edits it cannot
 * \input, include or link the rest of the project into a PDF they can read.
 *
 * The database only (export.ts and snippets.ts use it without access.ts).
 */
import path from 'node:path';
import { db, type FolderMemberRow } from './db.ts';

/**
 * A folder as a share names it: project-relative, normalised, never the top of the project (that is
 * sharing the project) and never inside `.git`. Null: no such path.
 */
export function sharePath(p: unknown): string | null {
  if (typeof p !== 'string' || p.includes('\0') || p.includes('\\')) return null;
  const parts = p.split('/').filter(s => s !== '' && s !== '.');
  if (!parts.length || parts.some(s => s === '..' || s.toLowerCase() === '.git')) return null;
  return parts.join('/');
}

/** Whether the project path `rel` is the folder `folder` or lies inside it (a path climbing out with `..`, or absolute, never does). */
export function withinPath(rel: string, folder: string): boolean {
  if (typeof rel !== 'string' || rel.includes('\0')) return false;
  const n = path.posix.normalize(rel).replace(/\/+$/, '');
  if (n.startsWith('/') || n === '..' || n.startsWith('../')) return false;
  return n === folder || n.startsWith(folder + '/');
}

/** A person's folder shares in a project — by account, or by the e-mail address they were invited at. */
export function folderRows(project: string, userId: number, email: string): FolderMemberRow[] {
  return db.prepare('SELECT * FROM folder_members WHERE project = ? AND (user_id = ? OR (email IS NOT NULL AND email = ?))').all(project, userId, email || '\0') as FolderMemberRow[];
}

/** A person's folder shares in every project (their project list). */
export function folderRowsOf(userId: number, email: string): FolderMemberRow[] {
  return db.prepare('SELECT * FROM folder_members WHERE user_id = ? OR (email IS NOT NULL AND email = ?)').all(userId, email || '\0') as FolderMemberRow[];
}

/** One folder each, with the strongest role a share of it gives. */
export function mergeFolders(rows: Pick<FolderMemberRow, 'path' | 'role' | 'via'>[]): { path: string; role: 'view' | 'edit'; via: string }[] {
  const out = new Map<string, { path: string; role: 'view' | 'edit'; via: string }>();
  for (const r of rows) {
    if (r.role !== 'view' && r.role !== 'edit') continue;
    const had = out.get(r.path);
    if (!had || (r.role === 'edit' && had.role !== 'edit')) out.set(r.path, { path: r.path, role: r.role, via: r.via });
  }
  return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The folder the builds of the document at `rel` are confined to: the innermost folder holding it
 * that is shared for editing on its own (with people, or by a link); '' — none, the whole project.
 */
export function confinedRoot(project: string, rel: string): string {
  const rows = db.prepare(`SELECT path FROM folder_members WHERE project = ? AND role = 'edit'
    UNION SELECT path FROM share_links WHERE project = ? AND path IS NOT NULL AND role = 'edit'`).all(project, project) as { path: string }[];
  let root = '';
  for (const r of rows) if (r.path.length > root.length && withinPath(rel, r.path)) root = r.path;
  return root;
}

/**
 * A file or folder of the project renamed (`to`) or deleted (null): the shares of it and of the
 * folders inside it follow a rename; a deleted folder's shares stay and reach nothing until a folder
 * of that name is back.
 */
export function foldersMoved(project: string, from: string, to: string | null): void {
  if (to === null) return;
  const moved = (p: string) => (p === from ? to : p.startsWith(from + '/') ? to + p.slice(from.length) : null);
  db.transaction(() => {
    for (const r of db.prepare('SELECT id, path FROM folder_members WHERE project = ?').all(project) as { id: number; path: string }[]) {
      const p = moved(r.path);
      // (the person has a share of the new place already: that one stays)
      if (p !== null && !db.prepare('UPDATE OR IGNORE folder_members SET path = ? WHERE id = ?').run(p, r.id).changes) db.prepare('DELETE FROM folder_members WHERE id = ?').run(r.id);
    }
    for (const r of db.prepare('SELECT token, path FROM share_links WHERE project = ? AND path IS NOT NULL').all(project) as { token: string; path: string }[]) {
      const p = moved(r.path);
      if (p !== null) db.prepare('UPDATE share_links SET path = ? WHERE token = ?').run(p, r.token);
    }
  })();
}
