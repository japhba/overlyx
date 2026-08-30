/**
 * PDF builds: the document's .tex text (the file on disk is the LaTeX source) -> latexmk.
 * The build directory gets a copy of the master and its child documents with graphics that
 * pdflatex cannot include (svg, eps, ...) converted to PDF, plus links to the project's assets.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { headerValue } from '@overlyx/core';
import { config } from './config.ts';
import { db } from './db.ts';
import { manager, DocManager } from './docs.ts';
import { projectDir, resolveProjectPath, findMaster, childDocuments } from './projects.ts';
import { toPdf, cacheDir } from './graphics.ts';
import { sandboxed, type SandboxSpec } from './sandbox.ts';
import { readTextFile } from './texdoc.ts';

export interface BuildResult { ok: boolean; log: string; pdfPath?: string; texPath?: string; warnings: string[]; tex?: string }

/* ------------------------------------------------------------------ build jobs
 * PDF builds are background jobs: a request enqueues one and returns at once; clients poll
 * `buildStatus`. At most `config.maxBuilds` compile at a time (latexmk runs `nice`d so the editor
 * stays responsive), one per document — a request while a build runs marks it for a re-run with
 * the latest content. */

export type JobStatus = 'queued' | 'exporting' | 'compiling' | 'ok' | 'error' | 'cancelled';
export interface BuildJob {
  id: number;
  docId: string;
  engine: 'overlyx';
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
export function requestBuild(docId: string, _engine: string, requestedBy: string): BuildJob {
  const cur = jobs.get(docId);
  if (cur && (cur.status === 'queued' || cur.status === 'exporting' || cur.status === 'compiling')) {
    if (cur.status !== 'queued') cur.rerun = true;   // the content may have changed: build once more afterwards
    return cur;
  }
  const job: BuildJob = { id: nextJobId++, docId, engine: 'overlyx', status: 'queued', requestedBy, startedAt: Date.now(), phaseAt: Date.now(), progress: '', rerun: false, waiters: [] };
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
export function buildPdf(docId: string, opts: { engine?: string; requestedBy?: string } = {}): Promise<BuildResult> {
  const job = requestBuild(docId, 'overlyx', opts.requestedBy ?? 'api');
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
    const r = await buildViaLatexmk(job);
    finish(job, r, isCancelled(job) ? 'cancelled' : r.ok ? 'ok' : 'error');
  } catch (e) {
    finish(job, { ok: false, log: 'build failed: ' + String(e), warnings: [] }, 'error');
  }
  console.log(`[build] ${job.docId} ${job.status} in ${Math.round((Date.now() - t0) / 1000)} s`);
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

/* ------------------------------------------------------------------ export */

const PDFLATEX_FORMATS = new Set(['pdf', 'png', 'jpg', 'jpeg', 'mps']);

/**
 * Rewrite \includegraphics references to formats pdflatex cannot include (svg, eps, tif, ...)
 * to PDF copies converted into the build directory (same relative path, .pdf extension).
 */
async function rewriteGraphics(text: string, texDir: string, buildTexDir: string, warnings: string[]): Promise<string> {
  const re = /\\includegraphics\s*(\*?)\s*(\[[^\]]*\])?\s*\{([^}]*)\}/g;
  const jobs: { m: string; name: string }[] = [];
  for (const m of text.matchAll(re)) jobs.push({ m: m[0], name: m[3].trim() });
  let out = text;
  const done = new Map<string, string>();
  for (const j of jobs) {
    if (done.has(j.name)) continue;
    const norm = j.name.replace(/\\/g, '/');
    const ext = norm.includes('.') ? norm.slice(norm.lastIndexOf('.') + 1).toLowerCase() : '';
    if (!ext || PDFLATEX_FORMATS.has(ext)) { done.set(j.name, j.name); continue; }
    const src = path.resolve(texDir, norm);
    const dest = path.join(buildTexDir, norm.slice(0, norm.lastIndexOf('.')) + '.pdf');
    const newName = norm.slice(0, norm.lastIndexOf('.')) + '.pdf';
    try {
      if (!fs.existsSync(src)) { warnings.push(`graphics file not found: ${j.name}`); done.set(j.name, j.name); continue; }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      try { if (fs.lstatSync(dest).isSymbolicLink()) fs.unlinkSync(dest); } catch { /* not there */ }
      if (!fs.existsSync(dest) || fs.statSync(dest).mtimeMs < fs.statSync(src).mtimeMs) await toPdf(src, dest);
      done.set(j.name, newName);
    } catch (e) {
      warnings.push(`graphics conversion failed for ${j.name}: ${String(e)}`);
      done.set(j.name, j.name);
    }
  }
  for (const [name, newName] of done) {
    if (name === newName) continue;
    out = out.split('{' + name + '}').join('{' + newName + '}');
  }
  return out;
}

/** Live text of a project document: the open document's state, else the file. */
function documentText(project: string, rel: string): string {
  const open = manager.docs.get(`${project}/${rel}`);
  if (open) return open.fileText ?? open.toText();
  return readTextFile(resolveProjectPath(project, rel));
}

/** Put the document and its children into the build dir (graphics converted) and return the main file. */
export async function exportTex(docId: string): Promise<{ dir: string; main: string; warnings: string[]; tex: string }> {
  const doc = await manager.open(docId);
  await manager.saveProject(doc.project);   // the files on disk match what is being built
  const dir = buildDir(docId);
  const docDir = path.dirname(doc.absPath);
  const warnings: string[] = [];
  linkDocumentAssets(docDir, dir);
  const files = [doc.relPath, ...childDocuments(doc.project, doc.relPath)];
  const proj = projectDir(doc.project);
  let mainText = '';
  for (const rel of files) {
    let text: string;
    try { text = documentText(doc.project, rel); } catch { continue; }
    const relToDoc = path.relative(docDir, path.join(proj, rel));
    if (relToDoc.startsWith('..')) continue;   // outside the document's directory: found through TEXINPUTS
    const target = path.join(dir, relToDoc);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try { if (fs.lstatSync(target).isSymbolicLink()) fs.unlinkSync(target); } catch { /* not there */ }
    const rewritten = await rewriteGraphics(text, path.dirname(path.join(proj, rel)), path.dirname(target), warnings);
    fs.writeFileSync(target, rewritten, 'utf8');
    if (rel === doc.relPath) mainText = rewritten;
  }
  return { dir, main: path.join(dir, path.basename(doc.relPath)), warnings, tex: mainText };
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
      // (other files are found through TEXINPUTS, and the documents are written by exportTex)
      if (depth === 0 && !LINK_EXT.has(path.extname(e.name).toLowerCase())) continue;
      if (e.name.endsWith('.tex')) continue;
      // a PDF next to a document of the same name is that document's output (an earlier build),
      // not a figure: linking it would make the build write into the user's project
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

async function buildViaLatexmk(job: BuildJob): Promise<BuildResult> {
  const requestedId = job.docId;
  // a child document is built through its master; the child's live content is used because open
  // documents are written to disk first
  const { project, relPath } = DocManager.parseId(requestedId);
  const masterRel = findMaster(project, relPath);
  const docId = masterRel ? `${project}/${masterRel}` : requestedId;
  const doc = await manager.open(docId);
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

/** Pull "! error" blocks and file:line:error lines out of a LaTeX log. */
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

/* ---------------------------------------------------------------- SyncTeX */

/** A box in the PDF (points, origin at the page's top-left): `x`/`y` its reference point, `h`/`v` the left/bottom of the box, `W`/`H` its width and height. */
export interface SyncBox { page: number; x: number; y: number; h: number; v: number; W: number; H: number }

/** The last build's PDF, .synctex.gz and .tex names — or null when there is nothing to synchronize with. */
function synctexFiles(docId: string): { dir: string; pdf: string; tex: string } | null {
  const b = lastBuild(docId);
  if (!b?.pdf_path || !fs.existsSync(b.pdf_path)) return null;
  const dir = path.dirname(b.pdf_path), pdf = path.basename(b.pdf_path);
  if (!fs.existsSync(path.join(dir, pdf.replace(/\.pdf$/, '.synctex.gz')))) return null;
  return { dir, pdf, tex: pdf.replace(/\.pdf$/, '.tex') };
}

function synctex(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('synctex', args, { cwd, timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => (err && !out ? reject(err) : resolve(String(out))));
  });
}

/** Forward search: where line `line` (1-based) of the built .tex ended up in the PDF (`synctex view`); several boxes when the line spans more than one. */
export async function synctexView(docId: string, line: number, column = 0): Promise<SyncBox[]> {
  const f = synctexFiles(docId);
  if (!f) return [];
  const out = await synctex(['view', '-i', `${line}:${column}:${f.tex}`, '-o', f.pdf], f.dir);
  const boxes: SyncBox[] = [];
  let cur: Partial<SyncBox> | null = null;
  for (const l of out.split('\n')) {
    const m = /^(Page|x|y|h|v|W|H):(.*)$/.exec(l.trim());
    if (!m) continue;
    if (m[1] === 'Page') { if (cur?.page) boxes.push(cur as SyncBox); cur = { page: Number(m[2]) }; continue; }
    if (cur) (cur as Record<string, number>)[m[1]] = Number(m[2]);
  }
  if (cur?.page) boxes.push(cur as SyncBox);
  return boxes.filter(b => b.page > 0 && Number.isFinite(b.h) && Number.isFinite(b.v));
}

/** Inverse search: the source line under a point of the PDF (`synctex edit`; x/y in points from the page's top-left). */
export async function synctexEdit(docId: string, page: number, x: number, y: number): Promise<{ file: string; line: number; column: number } | null> {
  const f = synctexFiles(docId);
  if (!f) return null;
  const out = await synctex(['edit', '-o', `${page}:${x.toFixed(2)}:${y.toFixed(2)}:${f.pdf}`], f.dir);
  const file = /^Input:(.*)$/m.exec(out)?.[1]?.trim() ?? '';
  const line = Number(/^Line:(\d+)/m.exec(out)?.[1] ?? NaN);
  const column = Number(/^Column:(-?\d+)/m.exec(out)?.[1] ?? -1);
  if (!Number.isFinite(line) || line < 1) return null;
  return { file: path.basename(file), line, column };
}
