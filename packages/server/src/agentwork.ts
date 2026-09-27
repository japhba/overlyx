/**
 * The Agent panel's private working copy of a project — so the embedded agent edits files the
 * way it was trained to (apply_patch, a script), and OverLyX still gets reviewable edits.
 *
 * Each thread works in data/agent-work/<thread>/<project name>/: at the start of every turn the
 * live project is mirrored in (documents as their live source, other text files copied, binary
 * files symlinked read-only), and whenever the agent has changed files (a patch applied, a
 * command run, the turn over) its changes go back: a .tex document is diffed against what was
 * mirrored and applied to the live document as the agent's tracked changes (docedit.ts — word by
 * word, merged with whatever people typed meanwhile); other files are copied into the project.
 * The copy never changes under the agent during a turn. The agent never touches the live project
 * directly (its sandbox's only writable root is the copy); build output it produces in the copy
 * (latexmk's .aux, .log, the PDF next to a .tex) stays there.
 *
 * What was mirrored is kept next to the copy (<thread>.base/, <thread>.json) so a server restart
 * in the middle of a turn loses nothing: the next sync still knows what the agent changed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import { manager, docFiles, readTextFile } from './docs.ts';
import { projectDir, resolveProjectPath, isDocumentFile } from './projects.ts';
import { applyTrackedSource } from './docedit.ts';
import { touchProject } from './git.ts';

/** The tracked-change author of the panel's edits (the same as its MCP edits, so its own changes are recognised either way). */
export const AGENT_AUTHOR = 'Agent panel (MCP)';

/** Text files mirrored as copies (others are symlinked); new files of these kinds are copied back. */
const TEXT_EXT = new Set(['.tex', '.bib', '.sty', '.cls', '.bst', '.bbx', '.cbx', '.dtx', '.ins', '.txt', '.md', '.csv', '.tsv', '.dat', '.json', '.yaml', '.yml', '.py', '.r', '.jl', '.m', '.sh', '.lua', '.latexmkrc', '.cfg', '.def', '.clo', '.ldf']);
/** New binary files of these kinds are copied back too (a figure the agent made) */
const FIGURE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.eps', '.pdf', '.webp']);
/** LaTeX / tool output that never goes back into the project */
const AUX_EXT = new Set(['.aux', '.log', '.out', '.toc', '.lof', '.lot', '.fls', '.fdb_latexmk', '.bbl', '.blg', '.bcf', '.xml', '.nav', '.snm', '.vrb', '.idx', '.ind', '.ilg', '.xdv', '.dvi', '.gz', '.synctex', '.run', '.pyc', '.tmp', '.bak', '.swp']);
const MAX_TEXT = 4 * 1024 * 1024;
const MAX_NEW = 20 * 1024 * 1024;

type Kind = 'copy' | 'link';
interface Manifest { project: string; files: Record<string, Kind>; usedAt: number }

const root = () => path.join(config.dataDir, 'agent-work');
const safeId = (tid: string) => tid.replace(/[^A-Za-z0-9._-]/g, '_');
const manifestPath = (tid: string) => path.join(root(), safeId(tid) + '.json');
const baseDir = (tid: string) => path.join(root(), safeId(tid) + '.base');

/** The agent's working directory for a thread of `project`. */
export function workspaceDir(tid: string, project: string): string {
  return path.join(root(), safeId(tid), path.basename(projectDir(project)));
}

function readManifest(tid: string): Manifest | null {
  try { return JSON.parse(fs.readFileSync(manifestPath(tid), 'utf8')) as Manifest; } catch { return null; }
}

function writeAtomic(file: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.overlyx-tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

const readBase = (tid: string, rel: string): string | null => { try { return fs.readFileSync(path.join(baseDir(tid), rel), 'utf8'); } catch { return null; } };
const writeBase = (tid: string, rel: string, text: string) => writeAtomic(path.join(baseDir(tid), rel), text);

/** One operation at a time per thread (mirroring and syncing both touch the copy). */
const chains = new Map<string, Promise<unknown>>();
function serial<T>(tid: string, f: () => Promise<T>): Promise<T> {
  const next = (chains.get(tid) ?? Promise.resolve()).then(f, f);
  chains.set(tid, next.catch(() => undefined));
  return next;
}

/** The live source of a document: the open document's, else the file's. */
function liveText(project: string, rel: string): string {
  const open = manager.docs.get(`${project}/${rel}`);
  return open ? open.toText() : readTextFile(resolveProjectPath(project, rel));
}

/* ------------------------------------------------------------------ live → copy */

/** Mirror the live project into the thread's copy (taking over anything not synced yet first); returns the copy's path. */
export function prepareWorkspace(tid: string, project: string, userId: number): Promise<string> {
  return serial(tid, async () => {
    const dir = workspaceDir(tid, project);
    if (fs.existsSync(dir)) await syncNow(tid, project, userId);
    fs.mkdirSync(dir, { recursive: true });
    const old = readManifest(tid);
    const manifest: Manifest = { project, files: {}, usedAt: Date.now() };
    for (const f of docFiles(project)) {
      if (f.kind === 'dir') continue;
      const live = resolveProjectPath(project, f.path), dst = path.join(dir, f.path);
      const ext = path.extname(f.name).toLowerCase() || f.name.toLowerCase();
      let text: string | null = null;
      if ((f.kind === 'doc' || TEXT_EXT.has(ext)) && f.size <= MAX_TEXT) {
        try { text = f.kind === 'doc' ? liveText(project, f.path) : fs.readFileSync(live, 'utf8'); } catch { continue; }
        if (text.includes('\0')) text = null;
      }
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      let st: fs.Stats | null = null;
      try { st = fs.lstatSync(dst); } catch { /* new */ }
      if (text !== null) {
        if (st?.isSymbolicLink() || st?.isDirectory()) fs.rmSync(dst, { recursive: true, force: true });
        let cur: string | null = null;
        try { cur = st?.isFile() ? fs.readFileSync(dst, 'utf8') : null; } catch { /* unreadable */ }
        if (cur !== text) writeAtomic(dst, text);
        writeBase(tid, f.path, text);
        manifest.files[f.path] = 'copy';
      } else {
        if (!(st?.isSymbolicLink() && fs.readlinkSync(dst) === live)) { if (st) fs.rmSync(dst, { recursive: true, force: true }); fs.symlinkSync(live, dst); }
        manifest.files[f.path] = 'link';
      }
    }
    // what disappeared from the project (renamed, deleted) disappears from the copy too
    for (const rel of Object.keys(old?.files ?? {})) {
      if (manifest.files[rel]) continue;
      fs.rmSync(path.join(dir, rel), { force: true });
      fs.rmSync(path.join(baseDir(tid), rel), { force: true });
    }
    writeAtomic(manifestPath(tid), JSON.stringify(manifest));
    return dir;
  });
}

/* ------------------------------------------------------------------ copy → live */

export interface SyncedFile { path: string; action: 'tracked' | 'copied' | 'created'; inserted?: number; deleted?: number; error?: string }

/** Take the agent's changes in its copy over into the live project. */
export function syncWorkspace(tid: string, project: string, userId: number): Promise<SyncedFile[]> {
  return serial(tid, () => syncNow(tid, project, userId));
}

function* walk(dir: string, rel = ''): Generator<string> {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.latexmkrc') continue;
    if (e.name === 'node_modules' || e.name === '__pycache__' || e.name.startsWith('_minted') || e.name.endsWith('.overlyx-tmp')) continue;
    const r = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory()) yield* walk(dir, r);
    else if (e.isFile()) yield r;               // symlinks are never followed: they point at the live project
  }
}

/** Build output next to its source: foo.pdf beside foo.tex, latexmk's auxiliary files. */
function isOutput(dir: string, rel: string): boolean {
  const ext = path.extname(rel).toLowerCase();
  if (AUX_EXT.has(ext) || /\.synctex(\.gz)?$|\.run\.xml$|\.fdb_latexmk$/.test(rel)) return true;
  return ext === '.pdf' && fs.existsSync(path.join(dir, rel.slice(0, -4) + '.tex'));
}

async function syncNow(tid: string, project: string, userId: number): Promise<SyncedFile[]> {
  const dir = workspaceDir(tid, project);
  const manifest = readManifest(tid);
  if (!manifest || !fs.existsSync(dir)) return [];
  const out: SyncedFile[] = [];
  let touched = false;
  for (const rel of walk(dir)) {
    const abs = path.join(dir, rel);
    const kind = manifest.files[rel];
    const ext = path.extname(rel).toLowerCase() || path.basename(rel).toLowerCase();
    try {
      const st = fs.statSync(abs);
      if (kind === 'copy') {
        if (st.size > MAX_TEXT) continue;
        const text = fs.readFileSync(abs, 'utf8');
        const base = readBase(tid, rel);
        if (base === null || text === base) continue;
        if (isDocumentFile(project, rel)) {
          const doc = await manager.open(`${project}/${rel}`);
          const r = applyTrackedSource(doc, base, text, AGENT_AUTHOR);
          out.push({ path: rel, action: 'tracked', inserted: r.inserted, deleted: r.deleted });
        } else {
          writeAtomic(resolveProjectPath(project, rel), text);
          out.push({ path: rel, action: 'copied' });
          touched = true;
        }
        writeBase(tid, rel, text);
        continue;
      }
      // a file the agent created (or put in place of a link)
      if (isOutput(dir, rel) || st.size > MAX_NEW) continue;
      if (!TEXT_EXT.has(ext) && !FIGURE_EXT.has(ext)) continue;
      const live = resolveProjectPath(project, rel);
      const data = fs.readFileSync(abs);
      const existed = fs.existsSync(live);
      if (existed && isDocumentFile(project, rel)) continue;   // never overwrite a live document untracked
      writeAtomic(live, data);
      out.push({ path: rel, action: existed ? 'copied' : 'created' });
      touched = true;
      if (TEXT_EXT.has(ext) && !data.includes(0)) { writeBase(tid, rel, data.toString('utf8')); manifest.files[rel] = 'copy'; }
      else { fs.rmSync(abs); fs.symlinkSync(live, abs); manifest.files[rel] = 'link'; }
    } catch (e) {
      out.push({ path: rel, action: 'tracked', error: (e as Error).message });
    }
  }
  if (touched) touchProject(project, userId);
  manifest.usedAt = Date.now();
  writeAtomic(manifestPath(tid), JSON.stringify(manifest));
  if (out.length) console.log(`[agent-work ${tid}] ${out.map(f => `${f.path}: ${f.error ? 'failed — ' + f.error : f.action + (f.inserted !== undefined ? ` +${f.inserted}/−${f.deleted}` : '')}`).join('; ')}`);
  return out;
}

/** Remove the copies of threads nobody has used for `days` days. */
export function pruneWorkspaces(days = 30): void {
  let names: string[];
  try { names = fs.readdirSync(root()); } catch { return; }
  const cutoff = Date.now() - days * 86400_000;
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const tid = n.slice(0, -5);
    const m = readManifest(tid);
    if (m && m.usedAt > cutoff) continue;
    for (const p of [path.join(root(), tid), baseDir(tid), manifestPath(tid)]) fs.rmSync(p, { recursive: true, force: true });
  }
}
