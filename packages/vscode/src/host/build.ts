/**
 * PDF builds with latexmk, in the document's own directory (LaTeX-Workshop style — the .tex file
 * on disk is the LaTeX source). A port of the server's export.ts job model without the export
 * step, sandbox and database: one job per document, re-run when requested while building,
 * results kept in memory. SyncTeX runs against the built PDF next to the file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { headerValue, type LyxDocument } from '@overlyx/core';

export type JobStatus = 'queued' | 'exporting' | 'compiling' | 'ok' | 'error' | 'cancelled';
export interface BuildJob {
  id: number; docId: string; status: JobStatus; requestedBy: string;
  startedAt: number; phaseAt: number; finishedAt?: number; progress: string; rerun: boolean;
  cancel?: () => void;
}
export interface PublicJob { id: number; status: JobStatus; engine: string; requestedBy: string; startedAt: number; phaseAt: number; finishedAt?: number; progress: string; rerun: boolean }
export interface BuildRecord { status: 'ok' | 'error'; log: string; pdf_path: string | null; tex_path: string | null; updated_at: number; warnings: string[] }

export interface BuildRequest {
  docId: string;
  /** absolute path of the .tex file to compile (the master, for a child document) */
  absPath: string;
  /** header of the compiled document (engine choice); null: pdflatex */
  header: LyxDocument['header'] | null;
  latexmk: string;
  /** called right before compiling (the provider saves dirty documents here) */
  prepare?: () => Promise<void>;
}

const jobs = new Map<string, BuildJob>();
const lastBuilds = new Map<string, BuildRecord>();
const queue: { job: BuildJob; req: BuildRequest }[] = [];
let active = 0;
let nextJobId = 1;
const MAX_BUILDS = 2;

export function publicJob(j: BuildJob): PublicJob {
  return { id: j.id, status: j.status, engine: 'overlyx', requestedBy: j.requestedBy, startedAt: j.startedAt, phaseAt: j.phaseAt, finishedAt: j.finishedAt, progress: j.progress, rerun: j.rerun };
}
export function currentJob(docId: string): BuildJob | undefined { return jobs.get(docId); }
export function lastBuild(docId: string): BuildRecord | undefined { return lastBuilds.get(docId); }

export function requestBuild(req: BuildRequest, requestedBy = 'you'): BuildJob {
  const cur = jobs.get(req.docId);
  if (cur && (cur.status === 'queued' || cur.status === 'exporting' || cur.status === 'compiling')) {
    if (cur.status !== 'queued') cur.rerun = true;
    return cur;
  }
  const job: BuildJob = { id: nextJobId++, docId: req.docId, status: 'queued', requestedBy, startedAt: Date.now(), phaseAt: Date.now(), progress: '', rerun: false };
  jobs.set(req.docId, job);
  queue.push({ job, req });
  pump();
  return job;
}

export function cancelBuild(docId: string): boolean {
  const j = jobs.get(docId);
  if (!j) return false;
  if (j.status === 'queued') {
    const i = queue.findIndex(q => q.job === j);
    if (i >= 0) queue.splice(i, 1);
    j.status = 'cancelled'; j.finishedAt = Date.now();
    return true;
  }
  if (j.status === 'exporting' || j.status === 'compiling') { j.rerun = false; j.status = 'cancelled'; j.cancel?.(); return true; }
  return false;
}

function pump(): void {
  while (active < MAX_BUILDS && queue.length) {
    const { job, req } = queue.shift()!;
    active++;
    void runJob(job, req).finally(() => {
      active--;
      if (job.rerun) { job.rerun = false; requestBuild(req, job.requestedBy); }
      pump();
    });
  }
}

const isCancelled = (job: BuildJob): boolean => (job.status as JobStatus) === 'cancelled';

async function runJob(job: BuildJob, req: BuildRequest): Promise<void> {
  try {
    job.status = 'exporting'; job.phaseAt = Date.now();
    await req.prepare?.();
    if (isCancelled(job)) { job.finishedAt = Date.now(); return; }
    job.status = 'compiling'; job.phaseAt = Date.now();
    const r = await runLatexmk(job, req);
    if (isCancelled(job)) { job.finishedAt = Date.now(); return; }
    lastBuilds.set(job.docId, r);
    job.status = r.status; job.finishedAt = Date.now();
  } catch (e) {
    lastBuilds.set(job.docId, { status: 'error', log: 'build failed: ' + String(e), pdf_path: null, tex_path: req.absPath, updated_at: Date.now(), warnings: [] });
    job.status = 'error'; job.finishedAt = Date.now();
  }
}

function runLatexmk(job: BuildJob, req: BuildRequest): Promise<BuildRecord> {
  const cwd = path.dirname(req.absPath);
  const base = path.basename(req.absPath, '.tex');
  const outFmt = req.header ? headerValue(req.header, 'default_output_format') ?? 'default' : 'default';
  const nonTex = req.header ? headerValue(req.header, 'use_non_tex_fonts') === 'true' : false;
  const engineFlag = outFmt === 'pdf5' ? '-pdflua' : outFmt === 'pdf4' || nonTex ? '-pdfxe' : '-pdf';
  const args = [engineFlag, '-g', '-interaction=nonstopmode', '-file-line-error', '-synctex=1', base + '.tex'];
  return new Promise((resolve) => {
    const child = spawn(req.latexmk, args, { cwd, detached: true, env: { ...process.env, max_print_line: '1000' } });
    let out = '';
    let lineBuf = '';
    const onData = (d: Buffer) => {
      const s = d.toString();
      out += s;
      lineBuf += s;
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop() ?? '';
      for (const l of lines) if (l.trim()) job.progress = l.slice(0, 200);
      if (out.length > 4_000_000) out = out.slice(-2_000_000);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    const timeout = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* ignore */ } }, 420000);
    job.cancel = () => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* ignore */ } };
    child.on('error', (e) => { clearTimeout(timeout); resolve({ status: 'error', log: `could not run ${req.latexmk}: ${e.message}\nInstall TeX Live / latexmk, or set overlyx.latexmk.`, pdf_path: null, tex_path: req.absPath, updated_at: Date.now(), warnings: [] }); });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      job.cancel = undefined;
      const pdf = path.join(cwd, base + '.pdf');
      const logFile = path.join(cwd, base + '.log');
      let log = out;
      const warnings: string[] = [];
      let realErrors = code !== 0;
      if (fs.existsSync(logFile)) {
        const full = fs.readFileSync(logFile, 'utf8');
        log = extractErrors(full) + '\n\n---- latexmk output ----\n' + out.slice(-20000);
        // errors raised inside the generated bibliography come from malformed .bib entries, not
        // from the document: the PDF is still produced, so report them as warnings (as LyX does)
        const errs = errorLocations(full);
        const bbl = errs.filter(e => /\.bbl$/.test(e.file));
        realErrors = errs.length > bbl.length || (code !== 0 && errs.length === 0);
        if (bbl.length) warnings.push(...bbl.map(e => `bibliography: ${path.basename(e.file)}:${e.line}: ${e.message}`));
      }
      const ok = !realErrors && fs.existsSync(pdf);
      resolve({ status: ok ? 'ok' : 'error', log, pdf_path: fs.existsSync(pdf) ? pdf : null, tex_path: req.absPath, updated_at: Date.now(), warnings });
    });
  });
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

/* ---------------------------------------------------------------- SyncTeX */

export interface SyncBox { page: number; x: number; y: number; h: number; v: number; W: number; H: number }

function synctexFiles(docId: string): { dir: string; pdf: string; tex: string } | null {
  const b = lastBuilds.get(docId);
  if (!b?.pdf_path || !b.tex_path || !fs.existsSync(b.pdf_path)) return null;
  const dir = path.dirname(b.pdf_path);
  const pdf = path.basename(b.pdf_path);
  if (!fs.existsSync(path.join(dir, pdf.replace(/\.pdf$/, '.synctex.gz')))) return null;
  return { dir, pdf, tex: path.basename(b.tex_path) };
}

function synctex(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('synctex', args, { cwd, timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => (err && !out ? reject(err) : resolve(String(out))));
  });
}

/** Forward search: where line `line` (1-based) of the built .tex ended up in the PDF. */
export async function synctexView(docId: string, line: number, column = 0): Promise<SyncBox[]> {
  const f = synctexFiles(docId);
  if (!f) return [];
  const out = await synctex(['view', '-i', `${line}:${column}:${f.tex}`, '-o', f.pdf], f.dir);
  const boxes: SyncBox[] = [];
  let cur: Partial<SyncBox> = {};
  for (const l of out.split('\n')) {
    const m = /^([A-Za-z]+):(-?[\d.]+)$/.exec(l.trim());
    if (!m) continue;
    const [, k, v] = m;
    if (k === 'Page') { if (cur.page !== undefined) boxes.push(cur as SyncBox); cur = { page: Number(v) }; }
    else if (['x', 'y', 'h', 'v', 'W', 'H'].includes(k)) (cur as Record<string, number>)[k] = Number(v);
  }
  if (cur.page !== undefined) boxes.push(cur as SyncBox);
  return boxes.filter(b => b.h !== undefined && b.v !== undefined).slice(0, 8);
}

/** Inverse search: the source line under a point of the PDF (x/y in points from the page's top-left). */
export async function synctexEdit(docId: string, page: number, x: number, y: number): Promise<{ file: string; line: number; column: number } | null> {
  const f = synctexFiles(docId);
  if (!f) return null;
  const out = await synctex(['edit', '-o', `${page}:${x.toFixed(2)}:${y.toFixed(2)}:${f.pdf}`], f.dir);
  const get = (k: string) => new RegExp(`^${k}:(.*)$`, 'm').exec(out)?.[1]?.trim();
  const line = Number(get('Line') ?? NaN);
  if (!Number.isFinite(line)) return null;
  return { file: get('Input') ?? '', line, column: Number(get('Column') ?? 0) || 0 };
}
