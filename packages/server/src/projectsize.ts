/**
 * A project's size limit, like GitHub's 1 GB per repository: the project's files together (what its
 * file tree shows — not the version history in .git) may not grow past `config.projectMaxBytes`
 * (OVERLYX_PROJECT_MAX_MB). A write that would cross it is refused (413) at the doors files come in
 * by: uploads, copies, synced clones, git pushes, imports, MCP and the agent panel. A write that
 * keeps or shrinks the size always goes through — a full project can still be edited and tidied up.
 * Documents saving their own edits are never refused (that would lose typing).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import { projectDir } from './projectfiles.ts';

/** how long a measured size is trusted (writes through assertRoom keep it current meanwhile) */
const FRESH_MS = 30_000;
const measured = new Map<string, { bytes: number; at: number }>();

export class ProjectFullError extends Error {
  readonly status = 413;
  constructor(message: string) { super(message); this.name = 'ProjectFullError'; }
}

/** "1 GB", "740 MB", "12 KB" */
export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${+(n / 1024 ** 3).toFixed(n >= 10 * 1024 ** 3 ? 0 : 2)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** The bytes of the files below `dir`: links are not followed, .git directories not counted. */
export function directoryBytes(dir: string): number {
  let total = 0;
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) { if (e.name !== '.git') walk(path.join(d, e.name)); }
      else if (e.isFile()) { try { total += fs.lstatSync(path.join(d, e.name)).size; } catch { /* gone meanwhile */ } }
    }
  };
  walk(dir);
  return total;
}

/** The size of a project's files now (measured at most FRESH_MS ago). */
export function projectBytes(project: string): number {
  const m = measured.get(project);
  if (m && Date.now() - m.at < FRESH_MS) return m.bytes;
  const bytes = directoryBytes(projectDir(project));
  measured.set(project, { bytes, at: Date.now() });
  return bytes;
}

/** What may still come into the project (0 when it is full). */
export function projectRoom(project: string): number {
  return Math.max(0, config.projectMaxBytes - projectBytes(project));
}

/**
 * Throws ProjectFullError unless `adds` bytes (in place of `replaces` bytes, e.g. a file
 * overwritten) fit into the project. On success the bytes are counted as written: the caller writes
 * them next, and a batch (a sync push of many files) cannot slip past the limit file by file.
 */
export function assertRoom(project: string, adds: number, replaces = 0, what = 'This'): void {
  const grows = adds - replaces;
  if (grows <= 0) { noteWritten(project, grows); return; }
  const now = projectBytes(project);
  if (now + grows > config.projectMaxBytes) {
    throw new ProjectFullError(`${what} would take the project past its ${formatBytes(config.projectMaxBytes)} limit: it holds ${formatBytes(now)} and this adds ${formatBytes(grows)}. Delete files to make room — large data belongs outside the project.`);
  }
  noteWritten(project, grows);
}

/** Count a change of the project's size made without assertRoom (or forget the measurement: null). */
export function noteWritten(project: string, delta: number | null): void {
  const m = measured.get(project);
  if (!m) return;
  if (delta === null) measured.delete(project);
  else m.bytes = Math.max(0, m.bytes + delta);
}

/** The size of what is at `abs` now (a file, or a directory with everything in it); 0 when missing. */
export function bytesAt(abs: string): number {
  try {
    const st = fs.lstatSync(abs);
    return st.isDirectory() ? directoryBytes(abs) : st.isFile() ? st.size : 0;
  } catch { return 0; }
}
