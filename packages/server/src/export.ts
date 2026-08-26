/**
 * Export pipeline: LyX document -> LaTeX (OverLyX exporter) -> PDF via latexmk.
 * Alternative path: native LyX binary (lyx2lyx downgrade + `lyx -E pdf2`), used as a
 * reference/fallback.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { parseLyx, writeLyx, type LyxDocument } from '@overlyx/core';
import { config } from './config.ts';
import { db } from './db.ts';
import { manager } from './docs.ts';
import { projectDir, resolveProjectPath } from './projects.ts';
import { toPdf } from './graphics.ts';

export interface BuildResult { ok: boolean; log: string; pdfPath?: string; texPath?: string; warnings: string[]; tex?: string }

const running = new Map<string, Promise<BuildResult>>();

export function buildDir(docId: string): string {
  const d = path.join(config.dataDir, 'build', crypto.createHash('sha1').update(docId).digest('hex').slice(0, 16));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function run(cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env } });
    let out = '';
    const cap = (d: Buffer) => { out += d.toString(); if (out.length > 2_000_000) out = out.slice(-1_000_000); };
    child.stdout.on('data', cap); child.stderr.on('data', cap);
    const t = setTimeout(() => { child.kill('SIGKILL'); out += '\n[timeout]'; }, opts.timeoutMs ?? 240000);
    child.on('close', (code) => { clearTimeout(t); resolve({ code: code ?? -1, out }); });
    child.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out: out + '\n' + String(e) }); });
  });
}

type ExporterModule = {
  exportLatex: (doc: LyxDocument, opts: Record<string, unknown>) => { tex: string; files: Record<string, string>; graphics: { src: string; dest: string }[]; warnings: string[] };
};

async function loadExporter(): Promise<ExporterModule | null> {
  try {
    return await import('@overlyx/core/latex/index.ts') as unknown as ExporterModule;
  } catch (e) {
    console.warn('[export] OverLyX LaTeX exporter unavailable:', (e as Error).message);
    return null;
  }
}

/** Export the document to LaTeX (+ children, graphics) into the build dir. */
export async function exportTex(docId: string): Promise<{ dir: string; main: string; warnings: string[]; tex: string }> {
  const doc = await manager.open(docId);
  const lyx = doc.toLyxDocument();
  const dir = buildDir(docId);
  const docDir = path.dirname(doc.absPath);
  const base = path.basename(doc.relPath, '.lyx');
  const exporter = await loadExporter();
  if (!exporter) throw new Error('LaTeX exporter not available');
  const resolveInclude = (fn: string): LyxDocument | undefined => {
    try {
      const abs = path.resolve(docDir, fn);
      if (!abs.startsWith(projectDir(doc.project))) return undefined;
      // use the live CRDT version if the child is open in the editor
      const rel = path.relative(projectDir(doc.project), abs);
      const open = manager.docs.get(doc.project + '/' + rel);
      if (open) return open.toLyxDocument();
      return parseLyx(fs.readFileSync(abs, 'utf8'));
    } catch { return undefined; }
  };
  const res = exporter.exportLatex(lyx, { resolveInclude, basename: base, layoutDir: config.layoutDir, docDir });
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

export function texInputs(docDir: string, buildDirPath: string): NodeJS.ProcessEnv {
  const inputs = `${buildDirPath}//:${docDir}//:`;
  return { TEXINPUTS: inputs, BIBINPUTS: inputs, BSTINPUTS: inputs, openout_any: 'a', max_print_line: '1000' };
}

export async function buildPdf(docId: string, opts: { engine?: 'overlyx' | 'lyx' } = {}): Promise<BuildResult> {
  const existing = running.get(docId);
  if (existing) return existing;
  const p = (opts.engine === 'lyx' ? buildViaLyx(docId) : buildViaOverlyx(docId)).finally(() => running.delete(docId));
  running.set(docId, p);
  return p;
}

async function buildViaOverlyx(docId: string): Promise<BuildResult> {
  const doc = await manager.open(docId);
  const docDir = path.dirname(doc.absPath);
  let exp: Awaited<ReturnType<typeof exportTex>>;
  try {
    exp = await exportTex(docId);
  } catch (e) {
    const r: BuildResult = { ok: false, log: 'export failed: ' + String(e), warnings: [] };
    record(docId, r);
    return r;
  }
  const base = path.basename(exp.main, '.tex');
  const r = await run('latexmk', ['-pdf', '-interaction=nonstopmode', '-file-line-error', '-synctex=1', base + '.tex'], {
    cwd: exp.dir, env: texInputs(docDir, exp.dir), timeoutMs: 300000,
  });
  const pdf = path.join(exp.dir, base + '.pdf');
  const logFile = path.join(exp.dir, base + '.log');
  let log = r.out;
  if (fs.existsSync(logFile)) log = extractErrors(fs.readFileSync(logFile, 'utf8')) + '\n\n---- latexmk output ----\n' + r.out.slice(-20000);
  const ok = r.code === 0 && fs.existsSync(pdf);
  const res: BuildResult = { ok, log, pdfPath: fs.existsSync(pdf) ? pdf : undefined, texPath: exp.main, warnings: exp.warnings, tex: exp.tex };
  record(docId, res);
  return res;
}

/** Native LyX build: mirror the project into the build dir with lyx2lyx-downgraded copies. */
async function buildViaLyx(docId: string): Promise<BuildResult> {
  const doc = await manager.open(docId);
  await manager.saveAll();
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
          const r = await run('python3', [config.lyx2lyx, '-t', '620', '-o', d, s], { cwd: dir, timeoutMs: 120000 });
          if (r.code !== 0) { log += `lyx2lyx failed for ${e.name}:\n${r.out}\n`; fs.writeFileSync(d, writeLyx(parsed)); }
        } else fs.copyFileSync(s, d);
      } else {
        try { fs.copyFileSync(s, d); } catch { /* ignore */ }
      }
    }
  };
  await walk(projDir, dir);
  const target = path.join(dir, doc.relPath);
  const pdf = target.replace(/\.lyx$/, '.pdf');
  const r = await run(config.lyxBin, ['-batch', '-E', 'pdf2', pdf, target], { cwd: path.dirname(target), env: { QT_QPA_PLATFORM: 'offscreen' }, timeoutMs: 400000 });
  log += r.out;
  const ok = fs.existsSync(pdf);
  const res: BuildResult = { ok, log, pdfPath: ok ? pdf : undefined, warnings: [] };
  record(docId, res);
  return res;
}

function record(docId: string, r: BuildResult): void {
  db.prepare('INSERT INTO builds (doc_id, status, log, pdf_path, tex_path, updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(doc_id) DO UPDATE SET status=excluded.status, log=excluded.log, pdf_path=excluded.pdf_path, tex_path=excluded.tex_path, updated_at=excluded.updated_at')
    .run(docId, r.ok ? 'ok' : 'error', r.log.slice(-200000), r.pdfPath ?? null, r.texPath ?? null, Date.now());
}

export function lastBuild(docId: string): { status: string; log: string; pdf_path: string | null; tex_path: string | null; updated_at: number } | undefined {
  return db.prepare('SELECT status, log, pdf_path, tex_path, updated_at FROM builds WHERE doc_id = ?').get(docId) as any;
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
