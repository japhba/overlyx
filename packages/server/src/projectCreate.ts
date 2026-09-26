/** Shared project creation for the Git CLI API and account-wide MCP endpoint. */
import fs from 'node:fs';
import { isProjectName, projectKey } from '@overlyx/core';
import { db, type ProjectRow } from './db.ts';
import { projectRow, registerProject } from './access.ts';
import { createProject, resolveProjectPath } from './projects.ts';

export const PROJECT_NAME_ERROR = 'invalid project name (use letters, numbers, spaces, dot, dash or underscore)';

/**
 * The key of a new project of this account: `<username>/<name>` (core projectKey.ts). The name may
 * come with the account's own namespace in front (`jan/thesis`, as the key reads elsewhere).
 * Throws on a name that is not allowed.
 */
export function ownProjectKey(ownerId: number, name: string): string {
  const owner = db.prepare('SELECT username FROM users WHERE id = ?').get(ownerId) as { username: string } | undefined;
  if (!owner) throw new Error('no such account');
  name = name.trim();
  if (name.startsWith(owner.username + '/')) name = name.slice(owner.username.length + 1);
  if (!isProjectName(name)) throw new Error(PROJECT_NAME_ERROR);
  return projectKey(owner.username, name);
}

/**
 * Create a project directory and its ownership row as one application-level operation. Repository
 * initialisation stays with the caller: MCP wants an initial commit, while the CLI wants an
 * unborn remote that can accept an existing, unrelated Git history. `name` is the project's name in
 * the owner's namespace; the row's `name` is the new project's key.
 */
export function createOwnedProject(name: string, ownerId: number, opts: { title?: string | null; kind?: string } = {}): ProjectRow {
  const key = ownProjectKey(ownerId, name);
  if (fs.existsSync(resolveProjectPath(key, '.')) || projectRow(key)) throw new Error(`a project named "${key}" already exists`);
  createProject(key);
  try { return registerProject(key, ownerId, opts); }
  catch (e) {
    // Nothing can have been written yet: remove only the directory we just made, and only if empty.
    try { fs.rmdirSync(resolveProjectPath(key, '.')); } catch { /* leave it for recovery */ }
    throw e;
  }
}
