/**
 * Graphics conversion for the WYSIWYG view: embedded graphics (svg, pdf, eps, tiff, ...) are
 * rendered to PNG on demand and cached (a port of the server's graphics.ts, without the sandbox
 * — everything here is the user's own workspace).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const DIRECT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
export function isDirectImage(file: string): boolean { return DIRECT.has(path.extname(file).toLowerCase()); }

const inflight = new Map<string, Promise<string>>();

/** Returns a path to a PNG for the given graphics file (width in px, best effort). */
export async function toPng(absFile: string, cacheDir: string, width = 1200): Promise<string> {
  fs.mkdirSync(cacheDir, { recursive: true });
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

async function tool(cmd: string, args: string[], timeout: number): Promise<void> {
  await run(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 });
}

async function convert(src: string, out: string, width: number): Promise<void> {
  const ext = path.extname(src).toLowerCase();
  const tmp = out + '.tmp';
  try {
    if (ext === '.svg' || ext === '.svgz') {
      try {
        await tool('rsvg-convert', ['-w', String(width), '--keep-aspect-ratio', '-o', tmp + '.png', src], 60000);
        fs.renameSync(tmp + '.png', out);
        return;
      } catch {
        await tool('inkscape', [src, '--export-type=png', '--export-width=' + width, '--export-filename=' + tmp + '.png'], 120000);
        fs.renameSync(tmp + '.png', out);
        return;
      }
    }
    if (ext === '.pdf') {
      await tool('pdftoppm', ['-png', '-r', '150', '-f', '1', '-l', '1', '-singlefile', src, tmp], 60000);
      fs.renameSync(tmp + '.png', out);
      return;
    }
    if (ext === '.eps' || ext === '.ps') {
      await tool('gs', ['-q', '-dSAFER', '-dBATCH', '-dNOPAUSE', '-dEPSCrop', '-r150', '-sDEVICE=png16m', '-sOutputFile=' + tmp + '.png', src], 60000);
      fs.renameSync(tmp + '.png', out);
      return;
    }
    await tool('convert', [src + '[0]', '-resize', `${width}x${width}>`, tmp + '.png'], 60000);
    fs.renameSync(tmp + '.png', out);
  } finally {
    for (const f of [tmp, tmp + '.png']) { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* ignore */ } }
  }
}
