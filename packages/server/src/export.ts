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
import { manager, DocManager } from './docs.ts';
import { projectDir, resolveProjectPath, findMaster } from './projects.ts';
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
  return { TEXINPUTS: inputs, BIBINPUTS: inputs, BSTINPUTS: inputs, openout_any: 'a', max_print_line: '1000' };
}

export async function buildPdf(docId: string, opts: { engine?: 'overlyx' | 'lyx' } = {}): Promise<BuildResult> {
  const existing = running.get(docId);
  if (existing) return existing;
  const p = (opts.engine === 'lyx' ? buildViaLyx(docId) : buildViaOverlyx(docId)).finally(() => running.delete(docId));
  running.set(docId, p);
  return p;
}

async function buildViaOverlyx(requestedId: string): Promise<BuildResult> {
  // a child document is built through its master (LyX: master-buffer-view); the child's live
  // content is used because open documents are resolved from the CRDT state
  const { project, relPath } = DocManager.parseId(requestedId);
  const masterRel = findMaster(project, relPath);
  const docId = masterRel ? `${project}/${masterRel}` : requestedId;
  const doc = await manager.open(docId);
  const docDir = path.dirname(doc.absPath);
  let exp: Awaited<ReturnType<typeof exportTex>>;
  try {
    exp = await exportTex(docId);
  } catch (e) {
    const r: BuildResult = { ok: false, log: 'export failed: ' + String(e), warnings: [] };
    record(requestedId, r);
    return r;
  }
  const base = path.basename(exp.main, '.tex');
  const args = ['-pdf', '-g', '-interaction=nonstopmode', '-file-line-error', '-synctex=1'];
  // honour a latexmkrc in the document directory (e.g. for -shell-escape needed by the svg package)
  for (const rc of ['latexmkrc', '.latexmkrc']) {
    const f = path.join(docDir, rc);
    if (fs.existsSync(f)) { args.push('-r', f); break; }
  }
  args.push(base + '.tex');
  const r = await run('latexmk', args, {
    cwd: exp.dir, env: texInputs(docDir, exp.dir), timeoutMs: 420000,
  });
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
          // try lyx2lyx first (works when a matching LyX version is installed), else a header downgrade
          const r = await run('python3', [config.lyx2lyx, '-t', '620', '-o', d, s], { cwd: dir, timeoutMs: 120000 });
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
