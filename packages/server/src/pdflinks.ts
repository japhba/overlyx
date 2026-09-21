/**
 * Public PDF links: a stable address, `https://<server>/pdf/<token>/<name>.pdf`, that serves the
 * latest build of one document to anyone — the CV linked from a personal web page, the current
 * draft handed to a reader without an account. The owner turns it on per document in the Share
 * dialog (and off again; a new link gets a new token, the old one dies).
 *
 * What is served is the last PDF latexmk produced (a build with errors that still made a PDF
 * counts). When the project's files are newer than that build, a rebuild is queued in the
 * background — the page's readers see the current PDF now and the fresh one on the next fetch;
 * a document that was never built is built while the first reader waits.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db } from './db.ts';
import { projectDir, listProjects, isBackupFile } from './projects.ts';
import { lastBuild, requestBuild, buildPdf, currentJob } from './export.ts';

export interface PdfLinkRow { token: string; doc_id: string; created_by: number | null; created_at: number; hits: number; last_hit_at: number | null }

const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

export function pdfLinkFor(docId: string): PdfLinkRow | undefined {
  return db.prepare('SELECT * FROM pdf_links WHERE doc_id = ?').get(docId) as PdfLinkRow | undefined;
}
export function pdfLinkByToken(token: string): PdfLinkRow | undefined {
  if (!TOKEN_RE.test(token)) return undefined;
  return db.prepare('SELECT * FROM pdf_links WHERE token = ?').get(token) as PdfLinkRow | undefined;
}
export function pdfLinksOf(project: string): PdfLinkRow[] {
  return db.prepare('SELECT * FROM pdf_links WHERE substr(doc_id, 1, ?) = ? ORDER BY doc_id').all(project.length + 1, project + '/') as PdfLinkRow[];
}

/** Turn the link on for a document (an existing link is kept — it is what people already point at). */
export function createPdfLink(docId: string, userId: number | null): PdfLinkRow {
  const have = pdfLinkFor(docId);
  if (have) return have;
  const token = crypto.randomBytes(18).toString('base64url');
  db.prepare('INSERT INTO pdf_links (token, doc_id, created_by, created_at) VALUES (?,?,?,?)').run(token, docId, userId, Date.now());
  return pdfLinkFor(docId)!;
}
export function deletePdfLink(docId: string): boolean {
  return db.prepare('DELETE FROM pdf_links WHERE doc_id = ?').run(docId).changes > 0;
}
export function countHit(token: string): void {
  db.prepare('UPDATE pdf_links SET hits = hits + 1, last_hit_at = ? WHERE token = ?').run(Date.now(), token);
}

/**
 * The file name readers see: the project's name for its main document (`CV.pdf`), the project and
 * the document otherwise (`thesis-appendix.pdf`). Only characters every browser and file system take.
 */
export function pdfLinkFileName(docId: string, title?: string | null): string {
  const slash = docId.indexOf('/');
  const project = slash >= 0 ? docId.slice(0, slash) : docId;
  const rel = slash >= 0 ? docId.slice(slash + 1) : '';
  const base = path.basename(rel).replace(/\.(tex|lyx)$/i, '');
  const clean = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
  const projectPart = clean(title || project) || 'document';
  const name = /^main$/i.test(base) || !base ? projectPart : `${projectPart}-${clean(base) || 'document'}`;
  return name + '.pdf';
}

/** The documents of a project that can carry a link, the main document first. */
export function linkableDocs(project: string): string[] {
  const files = listProjects().find(p => p.name === project)?.files ?? [];
  const mainFirst = (a: string, b: string) => Number(!/(^|\/)main\.tex$/.test(a)) - Number(!/(^|\/)main\.tex$/.test(b)) || a.split('/').length - b.split('/').length || a.localeCompare(b);
  return files.filter(f => f.kind === 'doc' && !isBackupFile(f.name)).map(f => f.path).sort(mainFirst);
}

/** Whether a file of the project changed after `since` (a build). Stops at the first newer file; large projects are not walked to the end. */
export function projectChangedSince(project: string, since: number): boolean {
  const root = projectDir(project);
  let seen = 0;
  const walk = (dir: string, depth: number): boolean => {
    if (depth > 6) return false;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === '_build' || e.name === 'svg-inkscape' || e.name === 'node_modules' || e.name === '__pycache__') continue;
      if (++seen > 3000) return false;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (walk(full, depth + 1)) return true; continue; }
      if (!e.isFile()) continue;
      if (isBackupFile(e.name)) continue;
      try { if (fs.statSync(full).mtimeMs > since) return true; } catch { /* vanished */ }
    }
    return false;
  };
  return walk(root, 0);
}

export interface ServedPdf { path: string; updatedAt: number; fileName: string; building: boolean }

const REBUILD_INTERVAL_MS = 60000;
const lastPublicBuild = new Map<string, number>();

/**
 * The PDF to serve for a link: the last build, rebuilt in the background when the project changed
 * since (at most once a minute per document); built now, while the reader waits, when there is
 * none yet. Returns null when no PDF can be produced.
 */
export async function pdfForLink(link: PdfLinkRow, title: string | null | undefined, opts: { waitMs?: number } = {}): Promise<ServedPdf | null> {
  const docId = link.doc_id;
  const project = docId.split('/')[0];
  const fileName = pdfLinkFileName(docId, title);
  const have = () => { const b = lastBuild(docId); return b?.pdf_path && fs.existsSync(b.pdf_path) ? { path: b.pdf_path, updatedAt: b.updated_at } : null; };
  const job = currentJob(docId);
  const running = !!job && (job.status === 'queued' || job.status === 'exporting' || job.status === 'compiling');
  let cur = have();
  if (cur) {
    const last = lastPublicBuild.get(docId) ?? 0;
    if (!running && Date.now() - last > REBUILD_INTERVAL_MS && projectChangedSince(project, cur.updatedAt)) {
      lastPublicBuild.set(docId, Date.now());
      requestBuild(docId, 'overlyx', 'public link');
      return { ...cur, fileName, building: true };
    }
    return { ...cur, fileName, building: running };
  }
  // nothing built yet: build it now, but never let a reader hang for long
  if (!running) lastPublicBuild.set(docId, Date.now());
  const timeout = new Promise<'timeout'>(res => setTimeout(() => res('timeout'), opts.waitMs ?? 90000));
  const result = await Promise.race([buildPdf(docId, { requestedBy: 'public link' }), timeout]);
  cur = have();
  if (cur) return { ...cur, fileName, building: result === 'timeout' };
  return null;
}
