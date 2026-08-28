/**
 * Export pipeline: LyX document -> LaTeX (OverLyX exporter) -> PDF via latexmk.
 * Alternative path: native LyX binary (lyx2lyx downgrade + `lyx -E pdf2`), used as a
 * reference/fallback.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { parseLyx, writeLyx, headerValue, type LyxDocument } from '@overlyx/core';
import { config } from './config.ts';
import { db } from './db.ts';
import { manager, DocManager } from './docs.ts';
import { projectDir, resolveProjectPath, findMaster } from './projects.ts';
import { toPdf, cacheDir } from './graphics.ts';
import { sandboxed, type SandboxSpec } from './sandbox.ts';
import type { ExportRequest, ExportResponse } from './exportworker.ts';

export interface BuildResult { ok: boolean; log: string; pdfPath?: string; texPath?: string; warnings: string[]; tex?: string }

/* ------------------------------------------------------------------ build jobs
 * PDF builds are background jobs: a request enqueues one and returns at once; clients poll
 * `buildStatus`. At most `config.maxBuilds` compile at a time (latexmk runs `nice`d so the editor
 * stays responsive), one per document — a request while a build runs marks it for a re-run with
 * the latest content. The LaTeX export itself runs in a worker thread (exportworker.ts). */

export type JobStatus = 'queued' | 'exporting' | 'compiling' | 'ok' | 'error' | 'cancelled';
export interface BuildJob {
  id: number;
  docId: string;
  engine: 'overlyx' | 'lyx';
  status: JobStatus;
  requestedBy: string;
  startedAt: number;
  phaseAt: number;
  finishedAt?: number;
  /** last line of latexmk output */
  progress: string;
  rerun: boolean;
  result?: BuildResult;
  cancel?: () => void;
  waiters: ((r: BuildResult) => void)[];
}
export interface PublicJob { id: number; status: JobStatus; engine: string; requestedBy: string; startedAt: number; phaseAt: number; finishedAt?: number; progress: string; rerun: boolean }

const jobs = new Map<string, BuildJob>();
const queue: BuildJob[] = [];
let active = 0;
let nextJobId = 1;

export function publicJob(j: BuildJob): PublicJob {
  return { id: j.id, status: j.status, engine: j.engine, requestedBy: j.requestedBy, startedAt: j.startedAt, phaseAt: j.phaseAt, finishedAt: j.finishedAt, progress: j.progress, rerun: j.rerun };
}

/** Enqueue a build (or attach to the running one) and return its job. */
export function requestBuild(docId: string, engine: 'overlyx' | 'lyx', requestedBy: string): BuildJob {
  const cur = jobs.get(docId);
  if (cur && (cur.status === 'queued' || cur.status === 'exporting' || cur.status === 'compiling')) {
    if (cur.status !== 'queued') cur.rerun = true;   // the content may have changed: build once more afterwards
    return cur;
  }
  const job: BuildJob = { id: nextJobId++, docId, engine, status: 'queued', requestedBy, startedAt: Date.now(), phaseAt: Date.now(), progress: '', rerun: false, waiters: [] };
  jobs.set(docId, job);
  queue.push(job);
  pump();
  return job;
}

/** The active job of a document (running or the last finished one). */
export function currentJob(docId: string): BuildJob | undefined { return jobs.get(docId); }

export function cancelBuild(docId: string): boolean {
  const j = jobs.get(docId);
  if (!j) return false;
  if (j.status === 'queued') { const i = queue.indexOf(j); if (i >= 0) queue.splice(i, 1); finish(j, { ok: false, log: 'cancelled', warnings: [] }, 'cancelled'); return true; }
  if (j.status === 'exporting' || j.status === 'compiling') { j.rerun = false; j.status = 'cancelled'; j.cancel?.(); return true; }
  return false;
}

/** Wait for a document's build to finish (used by the synchronous API variant). */
export function buildPdf(docId: string, opts: { engine?: 'overlyx' | 'lyx'; requestedBy?: string } = {}): Promise<BuildResult> {
  const job = requestBuild(docId, opts.engine === 'lyx' ? 'lyx' : 'overlyx', opts.requestedBy ?? 'api');
  if (job.result && (job.status === 'ok' || job.status === 'error' || job.status === 'cancelled')) return Promise.resolve(job.result);
  return new Promise(res => job.waiters.push(res));
}

function pump(): void {
  while (active < config.maxBuilds && queue.length) {
    const job = queue.shift()!;
    active++;
    void runJob(job).finally(() => {
      active--;
      if (job.rerun) { job.rerun = false; requestBuild(job.docId, job.engine, job.requestedBy); }
      pump();
    });
  }
}

function setPhase(job: BuildJob, status: JobStatus): void { job.status = status; job.phaseAt = Date.now(); }
/** (a cancel request may have changed the status while a step was awaited) */
const isCancelled = (job: BuildJob): boolean => (job.status as JobStatus) === 'cancelled';

function finish(job: BuildJob, r: BuildResult, status: JobStatus): void {
  job.result = r; job.status = status; job.finishedAt = Date.now(); job.cancel = undefined;
  for (const w of job.waiters.splice(0)) w(r);
}

async function runJob(job: BuildJob): Promise<void> {
  const t0 = Date.now();
  try {
    const r = job.engine === 'lyx' ? await buildViaLyx(job) : await buildViaOverlyx(job);
    finish(job, r, isCancelled(job) ? 'cancelled' : r.ok ? 'ok' : 'error');
  } catch (e) {
    finish(job, { ok: false, log: 'build failed: ' + String(e), warnings: [] }, 'error');
  }
  console.log(`[build] ${job.docId} (${job.engine}) ${job.status} in ${Math.round((Date.now() - t0) / 1000)} s`);
}

/** Forget the build products and versions of a project's documents (the project was deleted). */
export function cleanupProjectData(project: string): void {
  const ids = new Set<string>();
  for (const t of ['builds', 'versions']) {
    for (const r of db.prepare(`SELECT DISTINCT doc_id FROM ${t} WHERE substr(doc_id, 1, ?) = ?`).all(project.length + 1, project + '/') as { doc_id: string }[]) ids.add(r.doc_id);
    db.prepare(`DELETE FROM ${t} WHERE substr(doc_id, 1, ?) = ?`).run(project.length + 1, project + '/');
  }
  for (const id of ids) {
    const d = path.join(config.dataDir, 'build', crypto.createHash('sha1').update(id).digest('hex').slice(0, 16));
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

export function buildDir(docId: string): string {
  const d = path.join(config.dataDir, 'build', crypto.createHash('sha1').update(docId).digest('hex').slice(0, 16));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

interface RunHandle { done: Promise<{ code: number; out: string }>; kill: () => void }
/** Spawn a (niced) command, collecting its output; `onLine` receives every output line. */
function run(cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; nice?: boolean; onLine?: (l: string) => void; sandbox?: Omit<SandboxSpec, 'cwd' | 'env'> }): RunHandle {
  let child: ChildProcess;
  let killed = false;
  const done = new Promise<{ code: number; out: string }>((resolve) => {
    // detached: the command leads its own process group, so cancelling kills latexmk *and* the
    // pdflatex/bibtex it spawned (they would otherwise keep the output pipes open and run on)
    let env: NodeJS.ProcessEnv = { ...process.env, ...opts.env };
    if (opts.sandbox) {
      const s = sandboxed(cmd, args, { ...opts.sandbox, cwd: opts.cwd, env: Object.fromEntries(Object.entries(opts.env ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string')) });
      cmd = s.cmd; args = s.args; env = s.env;
    }
    const spawnOpts = { cwd: opts.cwd, env, detached: true };
    child = opts.nice ? spawn('nice', ['-n', String(config.buildNiceness), cmd, ...args], spawnOpts) : spawn(cmd, args, spawnOpts);
    let out = '';
    let partial = '';
    const cap = (d: Buffer) => {
      const text = d.toString();
      out += text; if (out.length > 2_000_000) out = out.slice(-1_000_000);
      if (opts.onLine) {
        partial += text;
        const lines = partial.split('\n'); partial = lines.pop() ?? '';
        for (const l of lines) if (l.trim()) opts.onLine(l);
      }
    };
    child.stdout?.on('data', cap); child.stderr?.on('data', cap);
    const t = setTimeout(() => { killGroup(child, 'SIGKILL'); out += '\n[timeout]'; }, opts.timeoutMs ?? 240000);
    child.on('close', (code) => { clearTimeout(t); resolve({ code: killed ? -2 : code ?? -1, out: killed ? out + '\n[cancelled]' : out }); });
    child.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out: out + '\n' + String(e) }); });
  });
  return { done, kill: () => { killed = true; killGroup(child, 'SIGTERM'); setTimeout(() => killGroup(child, 'SIGKILL'), 3000); } };
}
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid || child.exitCode !== null) return;
  try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* gone */ } }
}

/* ------------------------------------------------------------------ export worker */

let worker: Worker | null = null;
let nextExportId = 1;
const pendingExports = new Map<number, { resolve: (r: ExportResponse) => void; reject: (e: Error) => void }>();

function exportWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL('./exportworker.ts', import.meta.url));
  w.on('message', (r: ExportResponse) => { const p = pendingExports.get(r.id); if (p) { pendingExports.delete(r.id); p.resolve(r); } });
  const fail = (e: unknown) => {
    console.error('[export] worker failed:', e);
    if (worker === w) worker = null;
    for (const [id, p] of pendingExports) { pendingExports.delete(id); p.reject(new Error('export worker failed: ' + String(e))); }
  };
  w.on('error', fail);
  w.on('exit', (code) => { if (code !== 0) fail('exit ' + code); else if (worker === w) worker = null; });
  worker = w;
  return w;
}

function exportInWorker(req: Omit<ExportRequest, 'id'>): Promise<ExportResponse> {
  const id = nextExportId++;
  return new Promise((resolve, reject) => {
    pendingExports.set(id, { resolve, reject });
    try { exportWorker().postMessage({ id, ...req } satisfies ExportRequest); } catch (e) { pendingExports.delete(id); reject(e as Error); }
  });
}

/** Export the document to LaTeX (+ children, graphics) into the build dir. */
export async function exportTex(docId: string): Promise<{ dir: string; main: string; warnings: string[]; tex: string }> {
  const doc = await manager.open(docId);
  const lyx = doc.toLyxDocument();
  const dir = buildDir(docId);
  const docDir = path.dirname(doc.absPath);
  const base = path.basename(doc.relPath, '.lyx');
  // live content of the project's open documents (child documents being edited)
  const openDocs: Record<string, LyxDocument> = {};
  for (const d of manager.docs.values()) if (d.project === doc.project && d.id !== docId) openDocs[d.relPath] = d.toLyxDocument();
  const t0 = Date.now();
  const r = await exportInWorker({ lyx, docDir, projectDir: projectDir(doc.project), basename: base, layoutDir: config.layoutDir, openDocs });
  if (!r.ok) throw new Error(r.error ?? 'export failed');
  console.log(`[export] ${docId}: LaTeX export ${Date.now() - t0} ms (worker)`);
  const res = { tex: r.tex!, files: r.files ?? {}, graphics: r.graphics ?? [], warnings: r.warnings ?? [] };
  linkDocumentAssets(docDir, dir);
  const main = path.join(dir, base + '.tex');
  fs.writeFileSync(main, res.tex, 'utf8');
  for (const [name, content] of Object.entries(res.files)) {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  }
  for (const g of res.graphics) {
    try {
      const src = path.resolve(docDir, g.src);
      const dest = path.join(dir, g.dest);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (!fs.existsSync(dest) || fs.statSync(dest).mtimeMs < fs.statSync(src).mtimeMs) await toPdf(src, dest);
    } catch (e) {
      res.warnings.push(`graphics conversion failed for ${g.src}: ${String(e)}`);
    }
  }
  return { dir, main, warnings: res.warnings, tex: res.tex };
}

/**
 * Make the document's graphics and asset directories visible in the build directory (symlinks),
 * like LyX's temp-dir export. Packages such as `svg` need the files in the working directory to
 * find/keep their conversion cache (svg-inkscape/) and to compare timestamps.
 */
export function linkDocumentAssets(docDir: string, buildDirPath: string): void {
  const LINK_EXT = new Set(['.svg', '.svgz', '.png', '.jpg', '.jpeg', '.eps', '.ps', '.tif', '.tiff', '.gif', '.bmp', '.webp', '.pdf_tex', '.pdf']);
  // Sub-directories are re-created as real directories with symlinked files (never symlinked as a
  // whole): LaTeX may write .aux/.bbl files into them, and those must land in the build directory,
  // not in the user's project.
  let count = 0;
  const linkDir = (srcDir: string, destDir: string, depth: number) => {
    if (depth > 4 || count > 5000) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(srcDir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'svg-inkscape') continue;
      const src = path.join(srcDir, e.name);
      const dest = path.join(destDir, e.name);
      if (e.isDirectory()) {
        try { const st = fs.lstatSync(dest); if (st.isSymbolicLink()) fs.unlinkSync(dest); } catch { /* does not exist */ }
        try { fs.mkdirSync(dest, { recursive: true }); } catch { /* ignore */ }
        linkDir(src, dest, depth + 1);
        continue;
      }
      // in sub-directories every file may be needed (\input{sub/file}); at the top level only graphics
      // (other files are found through TEXINPUTS, and the exporter writes the .tex files itself)
      if (depth === 0 && !LINK_EXT.has(path.extname(e.name).toLowerCase())) continue;
      // a PDF next to a document of the same name is that document's output (LyX's, or an earlier
      // build), not a figure: linking it would make the build write into the user's project
      if (/\.pdf$/i.test(e.name) && ['.lyx', '.tex'].some(x => fs.existsSync(path.join(srcDir, e.name.replace(/\.pdf$/i, x))))) continue;
      try {
        const st = fs.lstatSync(dest);
        if (st.isSymbolicLink()) { if (fs.readlinkSync(dest) === src) continue; fs.unlinkSync(dest); }
        else continue; // a real file produced by the build (or the exporter): leave it alone
      } catch { /* does not exist */ }
      try { fs.symlinkSync(src, dest); count++; } catch { /* ignore */ }
    }
  };
  linkDir(docDir, buildDirPath, 0);
  // the svg package writes its cache next to the document when compiling locally; share it
  const cache = path.join(docDir, 'svg-inkscape');
  if (!fs.existsSync(cache)) { try { fs.mkdirSync(cache); } catch { /* ignore */ } }
  const cacheLink = path.join(buildDirPath, 'svg-inkscape');
  try { if (!fs.existsSync(cacheLink)) fs.symlinkSync(cache, cacheLink); } catch { /* ignore */ }
}

export function texInputs(docDir: string, buildDirPath: string): NodeJS.ProcessEnv {
  // not recursive: a stray main.bbl/main.aux in some sub-directory of the project must not be picked up
  const inputs = `${buildDirPath}:${docDir}:`;
  // openout_any=p: TeX may only write below the build directory (the sandbox enforces the same)
  return { TEXINPUTS: inputs, BIBINPUTS: inputs, BSTINPUTS: inputs, openout_any: 'p', max_print_line: '1000' };
}

async function buildViaOverlyx(job: BuildJob): Promise<BuildResult> {
  const requestedId = job.docId;
  // a child document is built through its master (LyX: master-buffer-view); the child's live
  // content is used because open documents are resolved from the CRDT state
  const { project, relPath } = DocManager.parseId(requestedId);
  const masterRel = findMaster(project, relPath);
  const docId = masterRel ? `${project}/${masterRel}` : requestedId;
  const doc = await manager.open(docId);
  if (doc.dirty) await doc.saveToFile();   // the file on disk matches what is being built
  const docDir = path.dirname(doc.absPath);
  setPhase(job, 'exporting');
  job.cancel = () => { /* the export cannot be interrupted; its result is discarded (see isCancelled below) */ };
  let exp: Awaited<ReturnType<typeof exportTex>>;
  try {
    exp = await exportTex(docId);
  } catch (e) {
    const r: BuildResult = { ok: false, log: 'export failed: ' + String(e), warnings: [] };
    record(requestedId, r);
    return r;
  }
  if (isCancelled(job)) return { ok: false, log: 'cancelled', warnings: [] };
  setPhase(job, 'compiling');
  const base = path.basename(exp.main, '.tex');
  // the TeX engine: non-TeX fonts (fontspec) need XeTeX or LuaTeX — like LyX, XeTeX unless the
  // document's default output format says LuaTeX (pdf5); an explicit pdf4 / pdf5 is honoured too
  const header = doc.toLyxDocument().header;
  const outFmt = headerValue(header, 'default_output_format') ?? 'default';
  const nonTex = headerValue(header, 'use_non_tex_fonts') === 'true';
  const engineFlag = outFmt === 'pdf5' ? '-pdflua' : outFmt === 'pdf4' || nonTex ? '-pdfxe' : '-pdf';
  // build products must be real files in the build directory, never links into the project
  for (const ext of ['.pdf', '.synctex.gz', '.aux', '.log', '.out', '.bbl', '.blg', '.toc', '.fls', '.fdb_latexmk']) {
    const f = path.join(exp.dir, base + ext);
    try { if (fs.lstatSync(f).isSymbolicLink()) fs.unlinkSync(f); } catch { /* not there */ }
  }
  // honour a latexmkrc in the document directory (e.g. for -shell-escape needed by the svg package);
  // it is read where it appears on the command line, so it comes first: our engine choice wins
  const args: string[] = [];
  for (const rc of ['latexmkrc', '.latexmkrc']) {
    const f = path.join(docDir, rc);
    if (fs.existsSync(f)) { args.push('-r', f); break; }
  }
  args.push(engineFlag, '-g', '-interaction=nonstopmode', '-file-line-error', '-synctex=1', base + '.tex');
  const proc = run('latexmk', args, {
    cwd: exp.dir, env: texInputs(docDir, exp.dir), timeoutMs: 420000, nice: true,
    // the build directory (and the svg package's cache next to the document) are the only writable places
    sandbox: { rw: [exp.dir, path.join(docDir, 'svg-inkscape')], ro: [projectDir(project), cacheDir] },
    onLine: (l) => { job.progress = l.slice(0, 200); },
  });
  job.cancel = () => { job.status = 'cancelled'; proc.kill(); };
  const r = await proc.done;
  job.cancel = undefined;
  if (isCancelled(job)) { const c: BuildResult = { ok: false, log: 'cancelled', warnings: [] }; record(requestedId, c); return c; }
  const pdf = path.join(exp.dir, base + '.pdf');
  const logFile = path.join(exp.dir, base + '.log');
  let log = r.out;
  const warnings = [...exp.warnings];
  let realErrors = r.code !== 0;
  if (fs.existsSync(logFile)) {
    const full = fs.readFileSync(logFile, 'utf8');
    log = extractErrors(full) + '\n\n---- latexmk output ----\n' + r.out.slice(-20000);
    // errors raised inside the generated bibliography come from malformed .bib entries, not from the
    // document: the PDF is still produced, so report them as warnings (as LyX does)
    const errs = errorLocations(full);
    const bbl = errs.filter(e => /\.bbl$/.test(e.file));
    realErrors = errs.length > bbl.length || (r.code !== 0 && errs.length === 0);
    if (bbl.length) warnings.push(...bbl.map(e => `bibliography: ${path.basename(e.file)}:${e.line}: ${e.message}`));
  }
  const ok = !realErrors && fs.existsSync(pdf);
  if (masterRel) log = `(built master document ${masterRel})\n` + log;
  const res: BuildResult = { ok, log, pdfPath: fs.existsSync(pdf) ? pdf : undefined, texPath: exp.main, warnings, tex: exp.tex };
  record(requestedId, res);
  if (docId !== requestedId) record(docId, res);
  return res;
}

/**
 * Downgrade a LyX 2.5 (format 643) file header so that LyX 2.4 (format 620) can read it.
 * Only header keys differ between the formats for ordinary documents; the body is kept.
 */
export function downgradeTo620(text: string): string {
  const drop = ['\\table_border_color', '\\table_odd_row_color', '\\table_even_row_color', '\\table_alt_row_colors_start', '\\crossref_package', '\\use_formatted_ref', '\\nomencl_options', '\\docbook_', '\\use_minted', '\\use_lineno', '\\lineno_options'];
  const cmap: Record<string, string> = { '\\backgroundcolor': '#ffffff', '\\fontcolor': '#000000', '\\notefontcolor': '#cccccc', '\\boxbgcolor': '#ff0000' };
  const out: string[] = [];
  let inHeader = false;
  for (const l of text.split('\n')) {
    if (l.startsWith('\\lyxformat')) { out.push('\\lyxformat 620'); continue; }
    if (l === '\\begin_header') inHeader = true;
    if (l === '\\end_header') inHeader = false;
    if (inHeader) {
      if (drop.some(d => l.startsWith(d))) {
        if (l.startsWith('\\crossref_package')) out.push('\\use_refstyle ' + (l.includes('prettyref') ? '0' : '1'));
        continue;
      }
      const k = l.split(' ')[0];
      if (k in cmap && !l.split(' ').pop()!.startsWith('#')) { out.push(k + ' ' + cmap[k]); continue; }
      if (l.startsWith('\\justification default')) { out.push('\\justification true'); continue; }
    }
    if (l.startsWith('tuple "')) continue;
    out.push(l);
  }
  return out.join('\n');
}

/** Native LyX build: mirror the project into the build dir with downgraded copies. */
async function buildViaLyx(job: BuildJob): Promise<BuildResult> {
  const docId = job.docId;
  const doc = await manager.open(docId);
  await manager.saveProject(doc.project);
  setPhase(job, 'exporting');
  const projDir = projectDir(doc.project);
  const dir = path.join(buildDir(docId), 'lyx');
  fs.mkdirSync(dir, { recursive: true });
  let log = '';
  // mirror files
  const walk = async (src: string, dst: string) => {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const s = path.join(src, e.name), d = path.join(dst, e.name);
      if (e.isDirectory()) { await walk(s, d); continue; }
      if (e.name.endsWith('.lyx')) {
        const text = fs.readFileSync(s, 'utf8');
        const parsed = parseLyx(text);
        if (parsed.format > 620) {
          // try lyx2lyx first (works when a matching LyX version is installed), else a header downgrade
          const r = await run('python3', [config.lyx2lyx, '-t', '620', '-o', d, s], { cwd: dir, timeoutMs: 120000 }).done;
          if (r.code !== 0 || !fs.existsSync(d)) { log += `lyx2lyx unavailable for ${e.name} (using header downgrade)\n`; fs.writeFileSync(d, downgradeTo620(writeLyx(parsed))); }
        } else fs.copyFileSync(s, d);
      } else {
        try { fs.copyFileSync(s, d); } catch { /* ignore */ }
      }
    }
  };
  await walk(projDir, dir);
  const target = path.join(dir, doc.relPath);
  const pdf = target.replace(/\.lyx$/, '.pdf');
  setPhase(job, 'compiling');
  const proc = run(config.lyxBin, ['-batch', '-E', 'pdf2', pdf, target], { cwd: path.dirname(target), env: { QT_QPA_PLATFORM: 'offscreen' }, timeoutMs: 400000, nice: true, sandbox: { rw: [dir], ro: [cacheDir] }, onLine: (l) => { job.progress = l.slice(0, 200); } });
  job.cancel = () => { job.status = 'cancelled'; proc.kill(); };
  const r = await proc.done;
  job.cancel = undefined;
  log += r.out;
  const ok = !isCancelled(job) && fs.existsSync(pdf);
  const res: BuildResult = { ok, log, pdfPath: ok ? pdf : undefined, warnings: [] };
  record(docId, res);
  return res;
}

function record(docId: string, r: BuildResult): void {
  db.prepare('INSERT INTO builds (doc_id, status, log, pdf_path, tex_path, updated_at, warnings) VALUES (?,?,?,?,?,?,?) ON CONFLICT(doc_id) DO UPDATE SET status=excluded.status, log=excluded.log, pdf_path=excluded.pdf_path, tex_path=excluded.tex_path, updated_at=excluded.updated_at, warnings=excluded.warnings')
    .run(docId, r.ok ? 'ok' : 'error', r.log.slice(-200000), r.pdfPath ?? null, r.texPath ?? null, Date.now(), JSON.stringify(r.warnings ?? []));
}

export interface BuildRow { status: string; log: string; pdf_path: string | null; tex_path: string | null; updated_at: number; warnings: string[] }
export function lastBuild(docId: string): BuildRow | undefined {
  const row = db.prepare('SELECT status, log, pdf_path, tex_path, updated_at, warnings FROM builds WHERE doc_id = ?').get(docId) as (Omit<BuildRow, 'warnings'> & { warnings: string | null }) | undefined;
  if (!row) return undefined;
  let warnings: string[] = [];
  try { warnings = row.warnings ? JSON.parse(row.warnings) : []; } catch { /* ignore */ }
  return { ...row, warnings };
}

/** Pull "! error" blocks and file:line:error lines out of a LaTeX log. */
/** Errors of a -file-line-error log: { file, line, message }. */
export function errorLocations(log: string): { file: string; line: number; message: string }[] {
  const out: { file: string; line: number; message: string }[] = [];
  for (const l of log.split('\n')) {
    const m = /^(.+?):(\d+): (.*)$/.exec(l);
    if (m && !/^(l|line)$/.test(m[1])) out.push({ file: m[1], line: Number(m[2]), message: m[3] });
    else if (l.startsWith('! ')) out.push({ file: '', line: 0, message: l.slice(2) });
  }
  return out;
}

export function extractErrors(log: string): string {
  const lines = log.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('!') || /^[^:\s]+\.tex:\d+:/.test(l) || /^LaTeX (Error|Warning)/.test(l) || /Undefined control sequence/.test(l) || /Citation .* undefined|Reference .* undefined/.test(l)) {
      out.push(lines.slice(i, i + 3).join('\n'));
      i += 2;
    }
  }
  return out.length ? out.join('\n\n') : '(no errors found in log)';
}

export { resolveProjectPath };
