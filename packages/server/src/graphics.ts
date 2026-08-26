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

const execFileP = promisify(execFile);
const cacheDir = path.join(config.dataDir, 'cache');
const inflight = new Map<string, Promise<string>>();

const DIRECT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

export function isDirectImage(file: string): boolean { return DIRECT.has(path.extname(file).toLowerCase()); }

/** Returns a path to a PNG for the given graphics file (width in px, best effort). */
export async function toPng(absFile: string, width = 1200): Promise<string> {
  const st = fs.statSync(absFile);
  const key = crypto.createHash('sha1').update(`${absFile}|${st.mtimeMs}|${st.size}|${width}`).digest('hex');
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
  const tmp = out + '.tmp';
  try {
    if (ext === '.svg' || ext === '.svgz') {
      try {
        await execFileP('rsvg-convert', ['-w', String(width), '--keep-aspect-ratio', '-o', tmp + '.png', src], { timeout: 60000 });
        fs.renameSync(tmp + '.png', out);
        return;
      } catch (e) {
        await execFileP('inkscape', [src, '--export-type=png', '--export-width=' + width, '--export-filename=' + tmp + '.png'], { timeout: 120000 });
        fs.renameSync(tmp + '.png', out);
        return;
      }
    }
    if (ext === '.pdf') {
      // 150 dpi first page
      await execFileP('pdftoppm', ['-png', '-r', '150', '-f', '1', '-l', '1', '-singlefile', src, tmp], { timeout: 60000 });
      fs.renameSync(tmp + '.png', out);
      return;
    }
    if (ext === '.eps' || ext === '.ps') {
      await execFileP('gs', ['-q', '-dSAFER', '-dBATCH', '-dNOPAUSE', '-dEPSCrop', '-r150', '-sDEVICE=png16m', '-sOutputFile=' + tmp + '.png', src], { timeout: 60000 });
      fs.renameSync(tmp + '.png', out);
      return;
    }
    await execFileP('convert', [src + '[0]', '-resize', `${width}x${width}>`, tmp + '.png'], { timeout: 60000 });
    fs.renameSync(tmp + '.png', out);
  } finally {
    for (const f of [tmp, tmp + '.png']) { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* ignore */ } }
  }
}

/** Convert an image to PDF for LaTeX (svg/eps/...). */
export async function toPdf(src: string, dest: string): Promise<void> {
  const ext = path.extname(src).toLowerCase();
  if (ext === '.pdf') { fs.copyFileSync(src, dest); return; }
  if (ext === '.svg' || ext === '.svgz') {
    try { await execFileP('rsvg-convert', ['-f', 'pdf', '-o', dest, src], { timeout: 120000 }); return; }
    catch { await execFileP('inkscape', [src, '--export-type=pdf', '--export-filename=' + dest], { timeout: 180000 }); return; }
  }
  if (ext === '.eps' || ext === '.ps') {
    await execFileP('gs', ['-q', '-dSAFER', '-dBATCH', '-dNOPAUSE', '-dEPSCrop', '-sDEVICE=pdfwrite', '-sOutputFile=' + dest, src], { timeout: 120000 });
    return;
  }
  await execFileP('convert', [src, dest], { timeout: 120000 });
}
