import fs from 'node:fs';
import path from 'node:path';
import { isProjectKey } from '@overlyx/core';
import { isMarkdownPath } from '@overlyx/core/md/index.ts';
import { config } from './config.ts';
import { db } from './db.ts';
import { type ProjectFile, texInfo, collect, resolveProjectPath, projectDir, isBackupFile } from './projectfiles.ts';

export { type ProjectFile, fileKind, resolveProjectPath, projectDir, isBackupFile, findMaster } from './projectfiles.ts';

/** `name`: the project's key, `<owner>/<name>` (core projectKey.ts) */
export interface Project { name: string; path: string; files: ProjectFile[] }

/**
 * The top-level directories of the projects root that are namespaces: one per account, named by its
 * username (`<root>/<owner>/<name>` is a project). Anything else at the top level is not listed —
 * a directory put there by hand is moved into a namespace first (access.ts adoptProjects).
 */
export function namespaces(): Set<string> {
  return new Set((db.prepare('SELECT username FROM users').all() as { username: string }[]).map(r => r.username));
}

export function listProjects(opts: { files?: boolean } = {}): Project[] {
  const root = config.projectsDir;
  if (!fs.existsSync(root)) return [];
  const owners = namespaces();
  const out: Project[] = [];
  for (const ns of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ns.isDirectory() || ns.name.startsWith('.') || !owners.has(ns.name)) continue;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(path.join(root, ns.name), { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const name = `${ns.name}/${entry.name}`;
      if (!entry.isDirectory() || entry.name.startsWith('.') || !isProjectKey(name)) continue;
      const p = path.join(root, ns.name, entry.name);
      // `files: false`: names only (the CLI's project list needs no walk through every project)
      out.push({ name, path: p, files: opts.files === false ? [] : classifyDocs(p, collect(p, p, [], 0)) });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Mark .tex files that are documents (own \\begin{document}, written by OverLyX, or \\input by a document's body). */
function classifyDocs(root: string, files: ProjectFile[]): ProjectFile[] {
  const byPath = new Map(files.map(f => [f.path, f]));
  const docs: ProjectFile[] = [];
  for (const f of files) {
    if (f.kind !== 'tex' || !f.name.endsWith('.tex') || isBackupFile(f.name)) continue;
    let st: fs.Stats;
    try { st = fs.statSync(path.join(root, f.path)); } catch { continue; }
    const info = texInfo(path.join(root, f.path), st);
    if (info.hasDocument || info.authored) { f.kind = 'doc'; docs.push(f); }
  }
  // children (transitively)
  const queue = [...docs];
  const seen = new Set(docs.map(d => d.path));
  while (queue.length) {
    const d = queue.shift()!;
    let st: fs.Stats;
    try { st = fs.statSync(path.join(root, d.path)); } catch { continue; }
    for (const inc of texInfo(path.join(root, d.path), st).includes) {
      const rel = path.normalize(path.join(path.dirname(d.path), inc.endsWith('.tex') ? inc : inc + '.tex'));
      const f = byPath.get(rel);
      if (f && f.kind === 'tex' && !seen.has(rel)) { f.kind = 'doc'; seen.add(rel); queue.push(f); }
    }
  }
  return files;
}

/** Is the project file a document (opened in the document editor, never served as plain text)? */
export function isDocumentFile(project: string, relPath: string): boolean {
  if (isMarkdownPath(relPath)) return true;
  if (!relPath.endsWith('.tex')) return false;
  const root = projectDir(project);
  const rel = path.normalize(relPath);
  return classifyDocs(root, collect(root, root, [], 0)).some(f => f.path === rel && f.kind === 'doc');
}

/** Child documents (\\input / \\include from the body) of a document, project-relative, in order. */
export function childDocuments(project: string, relPath: string, depth = 0, out: string[] = []): string[] {
  if (depth > 5) return out;
  const root = projectDir(project);
  const abs = path.join(root, relPath);
  let st: fs.Stats;
  try { st = fs.statSync(abs); } catch { return out; }
  for (const inc of texInfo(abs, st).includes) {
    const rel = path.normalize(path.join(path.dirname(relPath), inc.endsWith('.tex') ? inc : inc + '.tex'));
    if (out.includes(rel) || rel === relPath || !fs.existsSync(path.join(root, rel))) continue;
    out.push(rel);
    childDocuments(project, rel, depth + 1, out);
  }
  return out;
}

/**
 * Refuse a project-relative path that a user must not write to: one that escapes the project, is
 * empty, or reaches into a git repository's `.git`. Writing `.git/config` or `.git/hooks/*` would
 * turn a later `git` run (which happens as the server user) into arbitrary code execution, so no
 * write route — upload, text, new document, file operations, fetched PDFs — may touch it.
 * (`.gitignore`, `.gitattributes`, `.gitmodules` are ordinary tracked files and stay allowed.)
 */
export function assertWritableRelPath(rel: string): void {
  const parts = String(rel).split(/[/\\]+/);
  for (const p of parts) {
    if (p === '' || p === '.' || p === '..') throw new Error('bad path');
    const low = p.toLowerCase();
    if (low === '.git' || low === 'git~1') throw new Error('bad path');   // .git, and its NTFS 8.3 short name
  }
}

export function createProject(name: string): Project {
  const dir = resolveProjectPath(name, '.');
  fs.mkdirSync(dir, { recursive: true });
  return { name, path: dir, files: [] };
}

/** New documents start from the templates both shells share (core newdoc.ts). */
export { newMarkdownText, newDocumentText } from '@overlyx/core';
