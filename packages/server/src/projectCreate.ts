/** Shared project creation for the Git CLI API and account-wide MCP endpoint. */
import fs from 'node:fs';
import type { ProjectRow } from './db.ts';
import { projectRow, registerProject } from './access.ts';
import { createProject, resolveProjectPath } from './projects.ts';

const PROJECT_NAME = /^[A-Za-z0-9._ -]+$/;

/**
 * Create a project directory and its ownership row as one application-level operation. Repository
 * initialisation stays with the caller: MCP wants an initial commit, while the CLI wants an
 * unborn remote that can accept an existing, unrelated Git history.
 */
export function createOwnedProject(name: string, ownerId: number, opts: { title?: string | null; kind?: string } = {}): ProjectRow {
  name = name.trim();
  if (!PROJECT_NAME.test(name)) throw new Error('invalid project name (use letters, numbers, spaces, dot, dash or underscore)');
  if (fs.existsSync(resolveProjectPath(name, '.')) || projectRow(name)) throw new Error(`a project named "${name}" already exists`);
  createProject(name);
  try { return registerProject(name, ownerId, opts); }
  catch (e) {
    // Nothing can have been written yet: remove only the directory we just made, and only if empty.
    try { fs.rmdirSync(resolveProjectPath(name, '.')); } catch { /* leave it for recovery */ }
    throw e;
  }
}
