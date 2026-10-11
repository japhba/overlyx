/**
 * Graphics conversion for the WYSIWYG view: any embedded graphic (svg, pdf, eps, tiff, ...)
 * is rendered to PNG on demand and cached.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.ts';
import { sandboxed } from './sandbox.ts';

const execFileRaw = promisify(execFile);
export const cacheDir = path.join(config.dataDir, 'cache');

/**
 * Run a converter sandboxed on a user's file: it reads the source's directory and writes only a fresh
 * directory of its own, with a HOME that is thrown away — never the shared cache (every user's
 * converted pictures) nor a HOME later builds use. `args(o)` is its command line writing to `o`; the
 * files it made there (`o`, or `o` with an extension added: `made`) are moved to `out` afterwards.
 */
async function tool(cmd: string, args: (o: string) => string[], src: string, out: string, timeout: number, made: (o: string) => string = o => o): Promise<void> {
  const work = fs.mkdtempSync(path.join(path.dirname(out), '.convert-'));
  try {
    const o = path.join(work, 'out' + path.extname(out));
    const s = sandboxed(cmd, args(o), { rw: [work], ro: [path.dirname(src)], cwd: work, env: {}, home: false });
    await execFileRaw(s.cmd, s.args, { timeout, env: s.env, maxBuffer: 4 * 1024 * 1024 });
    const f = made(o);
    const st = fs.lstatSync(f);
    if (!st.isFile()) throw new Error(`${cmd} did not write its output`);
    fs.renameSync(f, out);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
const inflight = new Map<string, Promise<string>>();

const DIRECT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

export function isDirectImage(file: string): boolean { return DIRECT.has(path.extname(file).toLowerCase()); }

/** Returns a path to a PNG for the given graphics file (width in px, best effort). */
export async function toPng(absFile: string, width = 1200): Promise<string> {
  const st = fs.statSync(absFile);
  const key = crypto.createHash('sha1').update(`transparent-pdf|${absFile}|${st.mtimeMs}|${st.size}|${width}`).digest('hex');
  const out = path.join(cacheDir, key + '.png');
  if (fs.existsSync(out)) return out;
  const running = inflight.get(key);
  if (running) return running;
  const p = convert(absFile, out, width).then(() => out).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function convert(src: string, out: string, width: number): Promise<void> {
  const ext = path.extname(src).toLowerCase();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  if (ext === '.svg' || ext === '.svgz') {
    try {
      await tool('rsvg-convert', o => ['-w', String(width), '--keep-aspect-ratio', '-o', o, src], src, out, 60000);
    } catch {
      await tool('inkscape', o => [src, '--export-type=png', '--export-width=' + width, '--export-filename=' + o], src, out, 120000);
    }
    return;
  }
  if (ext === '.pdf') {
    // 150 dpi first page (pdftocairo adds the .png to the name it is given)
    await tool('pdftocairo', o => ['-png', '-transp', '-r', '150', '-f', '1', '-l', '1', '-singlefile', src, o.replace(/\.png$/, '')], src, out, 60000);
    return;
  }
  if (ext === '.eps' || ext === '.ps') {
    await tool('gs', o => ['-q', '-dSAFER', '-dBATCH', '-dNOPAUSE', '-dEPSCrop', '-r150', '-sDEVICE=png16m', '-sOutputFile=' + o, src], src, out, 60000);
    return;
  }
  await tool('convert', o => [src + '[0]', '-resize', `${width}x${width}>`, o], src, out, 60000);
}

/** The first page of a PDF as SVG (vector, for HTML deliverables), cached. */
export async function toSvg(absFile: string): Promise<string> {
  const st = fs.statSync(absFile);
  const key = crypto.createHash('sha1').update(`svg|${absFile}|${st.mtimeMs}|${st.size}`).digest('hex');
  const out = path.join(cacheDir, key + '.svg');
  if (fs.existsSync(out)) return out;
  const running = inflight.get(key);
  if (running) return running;
  const p = (async () => {
    fs.mkdirSync(cacheDir, { recursive: true });
    await tool('pdftocairo', o => ['-svg', '-f', '1', '-l', '1', absFile, o], absFile, out, 60000);
    return out;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Convert an image to PDF for LaTeX (svg/eps/...). */
export async function toPdf(src: string, dest: string): Promise<void> {
  const ext = path.extname(src).toLowerCase();
  if (ext === '.pdf') { fs.copyFileSync(src, dest); return; }
  if (ext === '.svg' || ext === '.svgz') {
    try { await tool('rsvg-convert', o => ['-f', 'pdf', '-o', o, src], src, dest, 120000); return; }
    catch { await tool('inkscape', o => [src, '--export-type=pdf', '--export-filename=' + o], src, dest, 180000); return; }
  }
  if (ext === '.eps' || ext === '.ps') {
    await tool('gs', o => ['-q', '-dSAFER', '-dBATCH', '-dNOPAUSE', '-dEPSCrop', '-sDEVICE=pdfwrite', '-sOutputFile=' + o, src], src, dest, 120000);
    return;
  }
  await tool('convert', o => [src, o], src, dest, 120000);
}
