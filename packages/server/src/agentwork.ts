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
 *
 * Every turn that changes files leaves a checkpoint (<thread>.turns/<n>/): per file, the version
 * the agent's changes can be taken back to (a document's live source before its first change of
 * the turn, with what people edited meanwhile folded in) and the version the agent left. When the
 * turn is over the documents it changed are built, and the result compared with their last build
 * before it — so a turn that broke the PDF says so. undoCheckpoint takes a turn back exactly:
 * the documents return to their state before it, marks and all, while edits made since (typing,
 * accepting or rejecting a change) survive; files it copied in get their old content back, files
 * it created go to the trash.
 */
import fs from 'node:fs';
import path from 'node:path';
import { changeStats, lyxAuthorId, type Change } from '@overlyx/core';
import { config } from './config.ts';
import { db } from './db.ts';
import { manager, docFiles, readTextFile, type OpenDoc } from './docs.ts';
import { projectDir, resolveProjectPath, isDocumentFile, findMaster } from './projects.ts';
import { lastBuild, buildIncluding, buildErrors, requestBuild } from './export.ts';
import { touchProject } from './git.ts';
import { lstatIn, readFileIn, readTextIn, readlinkIn, writeFileIn, symlinkIn, removeIn } from './confined.ts';

/** The name the panel's agent has on the MCP server (its token's name) … */
export const PANEL_AGENT = 'Agent panel';
/** … and the tracked-change author of its edits (the same as its MCP edits, so its own changes are recognised either way). */
export const AGENT_AUTHOR = `${PANEL_AGENT} (MCP)`;

/** Text files mirrored as copies (others are symlinked); new files of these kinds are copied back. */
const TEXT_EXT = new Set(['.tex', '.bib', '.sty', '.cls', '.bst', '.bbx', '.cbx', '.dtx', '.ins', '.txt', '.md', '.csv', '.tsv', '.dat', '.json', '.yaml', '.yml', '.py', '.r', '.jl', '.m', '.sh', '.lua', '.latexmkrc', '.cfg', '.def', '.clo', '.ldf']);
/** New binary files of these kinds are copied back too (a figure the agent made) */
const FIGURE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.eps', '.pdf', '.webp']);
/** LaTeX / tool output that never goes back into the project */
const AUX_EXT = new Set(['.olx', '.olsrc', '.aux', '.log', '.out', '.toc', '.lof', '.lot', '.fls', '.fdb_latexmk', '.bbl', '.blg', '.bcf', '.xml', '.nav', '.snm', '.vrb', '.idx', '.ind', '.ilg', '.xdv', '.dvi', '.gz', '.synctex', '.run', '.pyc', '.tmp', '.bak', '.swp']);
const MAX_TEXT = 4 * 1024 * 1024;
const MAX_NEW = 20 * 1024 * 1024;

type Kind = 'copy' | 'link';
interface Manifest {
  project: string;
  files: Record<string, Kind>;
  usedAt: number;
  /** the turn running (or last run) in the copy: its changes go into checkpoint `n` */
  turn?: { n: number; startedAt: number; turnId: string | null };
  /** false: the turn's document changes go in directly, without tracked-change marks (the panel's Track changes box) */
  tracked?: boolean;
}

/**
 * The panel's Track changes box, per user and project, as of their last turn: the default of the
 * MCP document tools' `tracked` for the panel's agent (threads without a working copy edit through them).
 */
const panelTrackingState = new Map<string, boolean>();
export function setPanelTracking(userId: number, project: string, tracked: boolean): void { panelTrackingState.set(`${userId}\0${project}`, tracked); }
export function panelTracking(userId: number, project: string): boolean { return panelTrackingState.get(`${userId}\0${project}`) ?? true; }
/** whether the thread's last turn tracked its changes (undefined: no turn in a working copy yet) */
export function workspaceTracking(tid: string): boolean | undefined { const m = readManifest(tid); return m?.turn ? m.tracked !== false : undefined; }

const root = () => path.join(config.dataDir, 'agent-work');
const safeId = (tid: string) => tid.replace(/[^A-Za-z0-9._-]/g, '_');
const manifestPath = (tid: string) => path.join(root(), safeId(tid) + '.json');
const baseDir = (tid: string) => path.join(root(), safeId(tid) + '.base');

/** A thread's scratch HOME and TMPDIR (agent.ts threadSandbox), by its MCP key — codex names the thread only after it has started in its sandbox. */
export const scratchDir = (key: string) => path.join(config.dataDir, 'agent-scratch', key.replace(/[^A-Za-z0-9_-]/g, '_'));

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

const turnsDir = (tid: string) => path.join(root(), safeId(tid) + '.turns');
const cpDir = (tid: string, n: number) => path.join(turnsDir(tid), String(n));

/** The live source of a document: the open document's, else the file's. */
async function liveText(project: string, rel: string): Promise<string> {
  const open = manager.docs.get(`${project}/${rel}`);
  return open ? await open.textAsync() : readTextFile(resolveProjectPath(project, rel));
}

/* ------------------------------------------------------------------ live → copy */

/**
 * Mirror the live project into the thread's copy (taking over anything not synced yet first); returns
 * the copy's path. `tracked` false: the new turn's document changes go in without tracked-change marks.
 */
export function prepareWorkspace(tid: string, project: string, userId: number, tracked = true): Promise<string> {
  return serial(tid, async () => {
    const dir = workspaceDir(tid, project);
    if (fs.existsSync(dir)) await syncNow(tid, project, userId);
    fs.mkdirSync(dir, { recursive: true });
    const old = readManifest(tid);
    const manifest: Manifest = { project, files: {}, usedAt: Date.now(), ...(tracked ? {} : { tracked: false }) };
    for (const f of docFiles(project)) {
      if (f.kind === 'dir') continue;
      const live = resolveProjectPath(project, f.path);
      const ext = path.extname(f.name).toLowerCase() || f.name.toLowerCase();
      let text: string | null = null;
      if ((f.kind === 'doc' || TEXT_EXT.has(ext)) && f.size <= MAX_TEXT) {
        try { text = f.kind === 'doc' ? await liveText(project, f.path) : fs.readFileSync(live, 'utf8'); } catch { continue; }
        if (text.includes('\0')) text = null;
      }
      // the agent may have left anything in its copy — a link in place of a directory included: every
      // operation on it goes through confined.ts, which never follows one (the server runs as root)
      if (text !== null) {
        if (readTextIn(dir, f.path) !== text) writeFileIn(dir, f.path, text);
        writeBase(tid, f.path, text);
        manifest.files[f.path] = 'copy';
      } else {
        if (readlinkIn(dir, f.path) !== live) symlinkIn(dir, f.path, live);
        manifest.files[f.path] = 'link';
      }
    }
    // what disappeared from the project (renamed, deleted) disappears from the copy too
    for (const rel of Object.keys(old?.files ?? {})) {
      if (manifest.files[rel]) continue;
      removeIn(dir, rel);
      fs.rmSync(path.join(baseDir(tid), rel), { force: true });
    }
    // a new turn: its changes go into a new checkpoint (made when it first changes something)
    const prev = old?.turn ? readCheckpoint(tid, old.turn.n) : null;
    if (prev && !prev.finished) writeCheckpoint(tid, { ...prev, finished: true });
    manifest.turn = { n: Math.max(old?.turn?.n ?? 0, lastCheckpointNumber(tid)) + 1, startedAt: Date.now(), turnId: null };
    writeAtomic(manifestPath(tid), JSON.stringify(manifest));
    pruneCheckpoints(tid);
    return dir;
  });
}

/* ------------------------------------------------------------------ copy → live */

export interface SyncedFile { path: string; action: 'tracked' | 'edited' | 'copied' | 'created'; inserted?: number; deleted?: number; error?: string }

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
    // (the copy can change while it is walked: syncNow reads each file through confined.ts again)
  }
}

/** Build output next to its source: foo.pdf beside foo.tex, latexmk's auxiliary files. */
function isOutput(dir: string, rel: string): boolean {
  const ext = path.extname(rel).toLowerCase();
  if (AUX_EXT.has(ext) || /\.synctex(\.gz)?$|\.run\.xml$|\.fdb_latexmk$/.test(rel)) return true;
  return ext === '.pdf' && !!lstatIn(dir, rel.slice(0, -4) + '.tex')?.isFile();
}

async function syncNow(tid: string, project: string, userId: number): Promise<SyncedFile[]> {
  const dir = workspaceDir(tid, project);
  const manifest = readManifest(tid);
  if (!manifest || !fs.existsSync(dir)) return [];
  const out: SyncedFile[] = [];
  let touched = false;
  for (const rel of walk(dir)) {
    const kind = manifest.files[rel];
    const ext = path.extname(rel).toLowerCase() || path.basename(rel).toLowerCase();
    try {
      const st = lstatIn(dir, rel);
      if (!st?.isFile()) continue;   // gone meanwhile, or a link now
      if (kind === 'copy') {
        if (st.size > MAX_TEXT) continue;
        const buf = readFileIn(dir, rel, MAX_TEXT);
        if (buf === null) continue;
        const text = buf.toString('utf8');
        const base = readBase(tid, rel);
        if (base === null || text === base) continue;
        if (isDocumentFile(project, rel)) {
          const doc = await manager.open(`${project}/${rel}`);
          if (manifest.tracked === false) {
            // Track changes off: the agent's change goes in as it is (the checkpoint can still take it back)
            const { result: r } = await doc.agentEdit('plain', base, { after: text });
            out.push({ path: rel, action: 'edited' });
            if (r.after !== r.before) await recordDoc(tid, manifest, doc, rel, r.before, r.after);
          } else {
            const { result: r } = await doc.agentEdit('tracked', base, { after: text }, { author: AGENT_AUTHOR });
            out.push({ path: rel, action: 'tracked', inserted: r.inserted, deleted: r.deleted });
            if (r.after !== r.before) await recordDoc(tid, manifest, doc, rel, r.before, r.after);
          }
        } else {
          const live = resolveProjectPath(project, rel);
          const prev = readIfFile(live);
          writeAtomic(live, text);
          out.push({ path: rel, action: 'copied' });
          touched = true;
          recordFile(tid, manifest, rel, prev, Buffer.from(text, 'utf8'));
        }
        writeBase(tid, rel, text);
        continue;
      }
      // a file the agent created (or put in place of a link)
      if (isOutput(dir, rel) || st.size > MAX_NEW) continue;
      if (!TEXT_EXT.has(ext) && !FIGURE_EXT.has(ext)) continue;
      const live = resolveProjectPath(project, rel);
      const data = readFileIn(dir, rel, MAX_NEW);
      if (data === null) continue;
      const existed = fs.existsSync(live);
      if (existed && isDocumentFile(project, rel)) continue;   // never overwrite a live document untracked
      const prev = existed ? readIfFile(live) : null;
      writeAtomic(live, data);
      out.push({ path: rel, action: existed ? 'copied' : 'created' });
      touched = true;
      recordFile(tid, manifest, rel, prev, data);
      if (TEXT_EXT.has(ext) && !data.includes(0)) { writeBase(tid, rel, data.toString('utf8')); manifest.files[rel] = 'copy'; }
      else { symlinkIn(dir, rel, live); manifest.files[rel] = 'link'; }
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
    const key = (db.prepare('SELECT mcp_key FROM agent_threads WHERE thread_id = ?').get(tid) as { mcp_key: string | null } | undefined)?.mcp_key;
    // the copy and the scratch HOME are the agent's: removed without following anything in them
    for (const p of [path.join(root(), tid), ...(key ? [scratchDir(key)] : [])]) removeIn(path.dirname(p), path.basename(p));
    for (const p of [baseDir(tid), turnsDir(tid), manifestPath(tid)]) fs.rmSync(p, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ checkpoints */

export interface CheckpointFile {
  path: string;
  /** 'doc': a document (the agent's changes are tracked in it); 'file': another file, copied into the project */
  kind: 'doc' | 'file';
  /** the agent created the file */
  created?: boolean;
  /** characters of the turn's tracked changes (documents; counted when the turn is over) */
  inserted?: number;
  deleted?: number;
}

/** A build of a document the turn changed, compared with its last build before the change. */
export interface BuildCheck {
  /** the document built (a child document is built through its master) */
  doc: string;
  status: 'building' | 'ok' | 'error';
  /** the last build before the agent's first change: 'ok', 'error', or null when there was none */
  before: 'ok' | 'error' | null;
  /** it built before and fails now, or fails with errors it did not have before */
  broke: boolean;
  /** the build's first errors, one line each */
  errors: string[];
}

export interface Checkpoint {
  n: number;
  /** codex's turn id (null while unknown) */
  turnId: string | null;
  startedAt: number;
  /** when the agent last changed a file in it */
  updatedAt: number;
  /** the turn is over (no more changes go into this checkpoint) */
  finished: boolean;
  files: CheckpointFile[];
  builds: BuildCheck[];
  /** taken back: when, by whom, and what could not be (edited since) */
  undone: null | { at: number; by: number; kept: { path: string; why: string }[] };
  /** the build state of the documents to check, before the agent changed them */
  buildBefore: Record<string, { status: 'ok' | 'error'; errors: string[] } | null>;
}

const agentAuthorId = () => lyxAuthorId(AGENT_AUTHOR, '');
const readIfFile = (f: string): Buffer | null => { try { return fs.statSync(f).isFile() ? fs.readFileSync(f) : null; } catch { return null; } };
const readUtf8 = (f: string): string | null => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };

function readCheckpoint(tid: string, n: number): Checkpoint | null {
  try { return JSON.parse(fs.readFileSync(path.join(cpDir(tid, n), 'checkpoint.json'), 'utf8')) as Checkpoint; } catch { return null; }
}
const checkpointListeners = new Set<(tid: string, cp: Checkpoint) => void>();
/** Called whenever a checkpoint with changes is written (a change recorded, the turn over, a build checked, an undo). */
export function onCheckpoint(fn: (tid: string, cp: Checkpoint) => void): () => void { checkpointListeners.add(fn); return () => { checkpointListeners.delete(fn); }; }

function writeCheckpoint(tid: string, cp: Checkpoint): void {
  writeAtomic(path.join(cpDir(tid, cp.n), 'checkpoint.json'), JSON.stringify(cp));
  if (cp.files.length) for (const l of checkpointListeners) { try { l(tid, cp); } catch (e) { console.error('[agent-work] checkpoint listener failed:', e); } }
}
function checkpointNumbers(tid: string): number[] {
  try { return fs.readdirSync(turnsDir(tid)).map(Number).filter(n => Number.isInteger(n) && n > 0).sort((a, b) => a - b); } catch { return []; }
}
const lastCheckpointNumber = (tid: string) => checkpointNumbers(tid).at(-1) ?? 0;

/** Keep the last 30 checkpoints of a thread. */
function pruneCheckpoints(tid: string, keep = 30): void {
  const ns = checkpointNumbers(tid);
  for (const n of ns.slice(0, Math.max(0, ns.length - keep))) fs.rmSync(cpDir(tid, n), { recursive: true, force: true });
}

/** A thread's checkpoints, oldest first (what the panel shows under each turn). */
export function listCheckpoints(tid: string): Checkpoint[] {
  return checkpointNumbers(tid).map(n => readCheckpoint(tid, n)).filter((c): c is Checkpoint => !!c && c.files.length > 0);
}

/** The checkpoint the running turn's changes go into (created on its first change). */
function currentCheckpoint(tid: string, manifest: Manifest): Checkpoint {
  if (!manifest.turn) manifest.turn = { n: lastCheckpointNumber(tid) + 1, startedAt: Date.now(), turnId: null };   // a turn that began before checkpoints existed
  const t = manifest.turn;
  return readCheckpoint(tid, t.n) ?? { n: t.n, turnId: t.turnId, startedAt: t.startedAt, updatedAt: Date.now(), finished: false, files: [], builds: [], undone: null, buildBefore: {} };
}

/** The document a change to `rel` is built through: its master, or itself. */
const buildTarget = (project: string, rel: string) => `${project}/${findMaster(project, rel) ?? rel}`;

function buildState(docId: string): { status: 'ok' | 'error'; errors: string[] } | null {
  const b = lastBuild(docId);
  if (!b) return null;
  return b.status === 'ok' ? { status: 'ok', errors: [] } : { status: 'error', errors: buildErrors(b.log) };
}

/** The agent changed document `rel`: the live source went from `before` to `after`. */
async function recordDoc(tid: string, manifest: Manifest, doc: OpenDoc, rel: string, before: string, after: string): Promise<void> {
  const cp = currentCheckpoint(tid, manifest);
  const dir = cpDir(tid, cp.n), sh = path.join(dir, 'shadow', rel), af = path.join(dir, 'after', rel);
  if (!cp.files.some(f => f.path === rel)) {
    cp.files.push({ path: rel, kind: 'doc' });
    writeAtomic(sh, before);
    const target = buildTarget(manifest.project, rel);
    if (!(target in cp.buildBefore)) cp.buildBefore[target] = buildState(target);
    // and a version to go back to by hand (File ▸ Versions), whatever happens to the checkpoint
    void manager.createVersion(doc.id, 'before an Agent panel change', AGENT_AUTHOR, 'agent', before).then(() => pruneAgentVersions(doc.id)).catch(() => { /* best effort */ });
  } else {
    // people edited the document between two of the agent's changes: carry that over
    const prevAfter = readUtf8(af), shadow = readUtf8(sh);
    if (prevAfter !== null && shadow !== null && prevAfter !== before) writeAtomic(sh, (await doc.foldEditsAsync(shadow, prevAfter, before)).text);
  }
  writeAtomic(af, after);
  cp.updatedAt = Date.now();
  writeCheckpoint(tid, cp);
}

/** The agent's version of another file went into the project (`prev`: what was there, null if nothing). */
function recordFile(tid: string, manifest: Manifest, rel: string, prev: Buffer | null, next: Buffer): void {
  const cp = currentCheckpoint(tid, manifest);
  const dir = cpDir(tid, cp.n);
  if (!cp.files.some(f => f.path === rel)) {
    cp.files.push({ path: rel, kind: 'file', ...(prev === null ? { created: true } : {}) });
    if (prev !== null) writeAtomic(path.join(dir, 'shadow', rel), prev);
  }
  writeAtomic(path.join(dir, 'after', rel), next);
  cp.updatedAt = Date.now();
  writeCheckpoint(tid, cp);
}

function pruneAgentVersions(docId: string, keep = 30): void {
  db.prepare(`DELETE FROM versions WHERE doc_id = ? AND kind = 'agent' AND id NOT IN (SELECT id FROM versions WHERE doc_id = ? AND kind = 'agent' ORDER BY created_at DESC LIMIT ?)`).run(docId, docId, keep);
}

/** The changes of checkpoint `cp` by the agent (its author, marked within the checkpoint's time). */
function ofCheckpoint(cp: Checkpoint): (c: Change) => boolean {
  const a = agentAuthorId(), t0 = Math.floor(cp.startedAt / 1000), t1 = Math.ceil(cp.updatedAt / 1000);
  return c => c.author === a && c.time >= t0 && c.time <= t1;
}

/** The checkpoint the thread's running (or last) turn is filling, if it changed anything yet. */
export function activeCheckpoint(tid: string): Checkpoint | null {
  const m = readManifest(tid);
  const cp = m?.turn ? readCheckpoint(tid, m.turn.n) : null;
  return cp && cp.files.length ? cp : null;
}

/** A checkpoint as the panel sees it (without the earlier build logs). */
export function publicCheckpoint(cp: Checkpoint): Omit<Checkpoint, 'buildBefore'> {
  const { buildBefore: _b, ...rest } = cp;
  return rest;
}

/** codex named the running turn. */
export function noteTurnId(tid: string, turnId: string): void {
  const m = readManifest(tid);
  if (!m?.turn || m.turn.turnId === turnId) return;
  m.turn.turnId = turnId;
  writeAtomic(manifestPath(tid), JSON.stringify(m));
  const cp = readCheckpoint(tid, m.turn.n);
  if (cp && !cp.turnId) writeCheckpoint(tid, { ...cp, turnId });
}

/**
 * The turn is over: take its last changes over, close its checkpoint (with the size of its
 * changes) and return it — null when it changed nothing. `checkBuilds` then builds what it changed.
 */
export function finishTurn(tid: string, project: string, userId: number): Promise<Checkpoint | null> {
  return serial(tid, async () => {
    await syncNow(tid, project, userId);
    const m = readManifest(tid);
    const cp = m?.turn ? readCheckpoint(tid, m.turn.n) : null;
    if (!cp || cp.finished || !cp.files.length) return cp && cp.files.length ? cp : null;
    const mine = ofCheckpoint(cp);
    for (const f of cp.files) {
      if (f.kind !== 'doc') continue;
      const open = manager.docs.get(`${project}/${f.path}`);
      if (!open) continue;
      const st = changeStats(open.toLyxDocument().body, mine);
      f.inserted = st.inserted; f.deleted = st.deleted;
    }
    cp.finished = true;
    cp.builds = Object.entries(cp.buildBefore).filter(([, b]) => b !== null).map(([doc, b]) => ({ doc: doc.slice(project.length + 1), status: 'building', before: b!.status, broke: false, errors: [] }));
    writeCheckpoint(tid, cp);
    return cp;
  });
}

/** Signature of an error line, without where it happened (lines move when text is inserted above). */
const errorKey = (e: string) => e.replace(/^[^:\s]+:\d+: /, '').replace(/ — at «.*»$/, '');

/**
 * Build the documents a finished turn changed (reusing a build that already includes its last
 * change) and record whether it broke them.
 */
export async function checkBuilds(tid: string, project: string, n: number): Promise<void> {
  const cp0 = readCheckpoint(tid, n);
  if (!cp0) return;
  for (const b of cp0.builds) {
    if (b.status !== 'building') continue;
    let r;
    try { r = await buildIncluding(`${project}/${b.doc}`, PANEL_AGENT, cp0.updatedAt); }
    catch (e) { r = { ok: false, log: 'build failed: ' + String(e), warnings: [] }; }
    await serial(tid, async () => {
      const cur = readCheckpoint(tid, n);
      if (!cur) return;
      const before = cur.buildBefore[`${project}/${b.doc}`];
      const errors = r.ok ? [] : buildErrors(r.log);
      const had = new Set((before?.errors ?? []).map(errorKey));
      const broke = !r.ok && (before?.status === 'ok' || errors.some(e => !had.has(errorKey(e))) || (!errors.length && before?.status !== 'error'));
      cur.builds = cur.builds.map(x => (x.doc === b.doc ? { ...x, status: r.ok ? 'ok' : 'error', broke, errors } : x));
      writeCheckpoint(tid, cur);
    });
  }
}

/** What the running turn of `userId`'s agent in `project` found before its changes (build_pdf's comparison). */
export function buildBeforeTurn(project: string, userId: number, docId: string): { status: 'ok' | 'error'; errors: string[] } | null | undefined {
  const t = latestThread(project, userId);
  const m = t ? readManifest(t) : null;
  const cp = m?.turn ? readCheckpoint(t!, m.turn.n) : null;
  return cp && docId in cp.buildBefore ? cp.buildBefore[docId] : undefined;
}

/** The thread of `userId` in `project` whose turn started last (the one an MCP call of theirs comes from). */
function latestThread(project: string, userId: number): string | null {
  const rows = db.prepare('SELECT thread_id FROM agent_threads WHERE project = ? AND user_id = ?').all(project, userId) as { thread_id: string }[];
  let best: string | null = null, at = -1;
  for (const r of rows) {
    const m = readManifest(r.thread_id);
    if (m?.turn && m.project === project && m.turn.startedAt > at) { best = r.thread_id; at = m.turn.startedAt; }
  }
  return best;
}

export interface UndoResult { checkpoint: Checkpoint; reverted: string[]; kept: { path: string; why: string }[] }

export class UndoError extends Error {}

/**
 * Take checkpoint `n` back. Documents return to their version before the turn with everything
 * edited since carried over (a paragraph edited since keeps its current text — reported in
 * `kept`); files it wrote get their old content back unless they changed since; files it created
 * go to the trash. The thread's working copy follows, so the agent sees the result.
 */
export function undoCheckpoint(tid: string, project: string, n: number, userId: number): Promise<UndoResult> {
  return serial(tid, async () => {
    await syncNow(tid, project, userId);   // what the agent wrote last belongs to the checkpoint too
    const cp = readCheckpoint(tid, n);
    if (!cp || !cp.files.length) throw new UndoError('There is no such checkpoint.');
    if (cp.undone) throw new UndoError('These changes were taken back already.');
    const manifest = readManifest(tid);
    const dir = cpDir(tid, n), copy = workspaceDir(tid, project);
    const reverted: string[] = [], kept: { path: string; why: string }[] = [];
    let touched = false;
    // the working copy follows the live project (text null: the file is gone)
    const refresh = (rel: string, text: string | null) => {
      const kind = manifest?.files[rel];
      if (!manifest || !kind) return;
      if (text === null) { removeIn(copy, rel); fs.rmSync(path.join(baseDir(tid), rel), { force: true }); delete manifest.files[rel]; }
      else if (kind === 'copy') { writeFileIn(copy, rel, text); writeBase(tid, rel, text); }
    };
    for (const f of cp.files) {
      const shadowFile = path.join(dir, 'shadow', f.path), afterFile = path.join(dir, 'after', f.path);
      const live = resolveProjectPath(project, f.path);
      try {
        if (f.kind === 'doc') {
          const shadow = readUtf8(shadowFile), after = readUtf8(afterFile);
          if (shadow === null || after === null) { kept.push({ path: f.path, why: 'its checkpoint is incomplete' }); continue; }
          let doc: OpenDoc;
          try { doc = await manager.open(`${project}/${f.path}`); } catch { kept.push({ path: f.path, why: 'the document is gone' }); continue; }
          const now = await doc.textAsync();
          const { text: target, conflicts } = await doc.foldEditsAsync(shadow, after, now);
          const text = target === now ? now : (await doc.agentEdit('restore', now, { after: target })).result.text;
          if (conflicts) kept.push({ path: f.path, why: `${conflicts > 1 ? `${conflicts} paragraphs` : 'a paragraph'} edited since ${conflicts > 1 ? 'were' : 'was'} left as ${conflicts > 1 ? 'they are' : 'it is'}` });
          reverted.push(f.path);
          refresh(f.path, text);
          continue;
        }
        const cur = readIfFile(live), after = readIfFile(afterFile);
        if (cur === null) { if (f.created) reverted.push(f.path); else kept.push({ path: f.path, why: 'it was deleted since' }); continue; }
        if (!after || !cur.equals(after)) { kept.push({ path: f.path, why: 'it was changed since' }); continue; }
        if (f.created) {
          if (manager.docs.has(`${project}/${f.path}`)) { kept.push({ path: f.path, why: 'it is open in the editor — delete it from the file list' }); continue; }
          toTrash(project, f.path, live);
          refresh(f.path, null);
        } else {
          const old = readIfFile(shadowFile);
          if (old === null) { kept.push({ path: f.path, why: 'its checkpoint is incomplete' }); continue; }
          writeAtomic(live, old);
          if (manifest?.files[f.path] === 'copy') refresh(f.path, old.toString('utf8'));   // (a link shows the live file anyway)
        }
        reverted.push(f.path);
        touched = true;
      } catch (e) {
        kept.push({ path: f.path, why: (e as Error).message });
      }
    }
    cp.undone = { at: Date.now(), by: userId, kept };
    writeCheckpoint(tid, cp);
    if (manifest) {
      // later changes of the same turn go into a checkpoint of their own
      if (manifest.turn?.n === n) manifest.turn = { n: n + 1, startedAt: Date.now(), turnId: manifest.turn.turnId };
      writeAtomic(manifestPath(tid), JSON.stringify(manifest));
    }
    if (touched) touchProject(project, userId);
    // the turn had broken the build: build again, so the PDF recovers without anyone asking
    for (const b of cp.builds) if (b.broke) requestBuild(`${project}/${b.doc}`, 'overlyx', PANEL_AGENT, { auto: true });
    console.log(`[agent-work ${tid}] checkpoint ${n} undone: ${reverted.join(', ') || 'nothing'}${kept.length ? `; kept ${kept.map(k => k.path).join(', ')}` : ''}`);
    return { checkpoint: cp, reverted, kept };
  });
}

/** Like the file list's Delete: into the data directory's trash, never into the void. */
function toTrash(project: string, rel: string, abs: string): void {
  const dest = path.join(config.dataDir, 'trash', 'files', `${project.replace(/\//g, '__')}-${new Date().toISOString().replace(/[:.]/g, '-')}`, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try { fs.renameSync(abs, dest); } catch { fs.copyFileSync(abs, dest); fs.rmSync(abs, { force: true }); }
}

/**
 * The checkpoint an MCP call of `userId`'s panel agent means by `turnsBack` (0: its running turn,
 * 1: the turn before that changed files, …) — for undo_turn.
 */
export function agentCheckpoint(project: string, userId: number, turnsBack: number): { tid: string; n: number } {
  const tid = latestThread(project, userId);
  if (!tid) throw new UndoError('No Agent panel thread has changed this project — undo_turn takes back changes made from the Agent panel.');
  const m = readManifest(tid);
  const cps = listCheckpoints(tid).filter(c => !c.undone).reverse();
  const current = m?.turn;
  const isCurrent = (c: Checkpoint) => !!current && (c.n === current.n || (!!current.turnId && c.turnId === current.turnId));
  if (turnsBack === 0) {
    const c = cps.find(isCurrent);
    if (!c) throw new UndoError('You have not changed any file in this turn (or it was taken back already).');
    return { tid, n: c.n };
  }
  const earlier = cps.filter(c => !isCurrent(c));
  const c = earlier[turnsBack - 1];
  if (!c) throw new UndoError(`There are only ${earlier.length} earlier turn(s) with changes that were not taken back.`);
  return { tid, n: c.n };
}
