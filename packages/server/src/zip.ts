/**
 * A small ZIP reader — stored and deflated entries, read through the central directory — and a
 * safe extraction into a project directory. Enough for the archives Overleaf (Menu ▸ Download ▸
 * Source), GitHub and the Finder / Explorer produce; no zip64, no encryption.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export interface ZipEntry {
  name: string;
  size: number;
  dir: boolean;
  /** the entry's content, inflated */
  data(): Buffer;
}

const EOCD = 0x06054b50, CENTRAL = 0x02014b50, LOCAL = 0x04034b50;

export function readZip(buf: Buffer): ZipEntry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error('zip64 archives are not supported');
  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL) throw new Error('corrupt zip file (central directory)');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (flags & 1) throw new Error(`encrypted entry: ${name}`);
    entries.push({
      name, size: usize, dir: name.endsWith('/'),
      data: () => {
        if (local + 30 > buf.length || buf.readUInt32LE(local) !== LOCAL) throw new Error('corrupt zip file (local header)');
        const ln = buf.readUInt16LE(local + 26), lx = buf.readUInt16LE(local + 28);
        const start = local + 30 + ln + lx;
        const raw = buf.subarray(start, start + csize);
        if (method === 0) return Buffer.from(raw);
        if (method === 8) return zlib.inflateRawSync(raw);
        throw new Error(`unsupported compression (method ${method}) for ${name}`);
      },
    });
  }
  return entries;
}

/** A zip entry name as a project-relative path, or null when it must not be written (traversal, hidden system folders, a .git directory). */
export function safeZipPath(name: string, strip = 0): string | null {
  const rel = name.replace(/\\/g, '/').slice(strip);
  if (rel.endsWith('/')) return null;   // a directory entry: created with the files in it
  const parts = rel.split('/').filter(s => s !== '' && s !== '.');
  if (!parts.length) return null;
  if (parts.some(s => s === '..')) return null;
  if (parts[0] === '__MACOSX' || parts.includes('.git') || parts[parts.length - 1] === '.DS_Store') return null;
  if (/^[A-Za-z]:/.test(parts[0])) return null;
  return parts.join('/');
}

/**
 * Extract an archive into `dest` (created when missing). A single top-level folder that wraps
 * everything (GitHub's downloads) is stripped. Returns what was written and what was skipped.
 */
export function extractZip(buf: Buffer, dest: string, opts: { maxFiles?: number; maxBytes?: number } = {}): { files: string[]; skipped: string[] } {
  const entries = readZip(buf).filter(e => !e.dir);
  const maxFiles = opts.maxFiles ?? 5000, maxBytes = opts.maxBytes ?? 1024 * 1024 * 1024;
  if (entries.length > maxFiles) throw new Error(`too many files in the archive (${entries.length})`);
  const total = entries.reduce((s, e) => s + e.size, 0);
  if (total > maxBytes) throw new Error(`the archive unpacks to ${Math.round(total / 1e6)} MB — too large`);
  const tops = new Set(entries.map(e => e.name.replace(/\\/g, '/').split('/')[0]));
  const strip = tops.size === 1 && entries.every(e => e.name.replace(/\\/g, '/').includes('/')) ? [...tops][0].length + 1 : 0;
  const root = path.resolve(dest);
  fs.mkdirSync(root, { recursive: true });
  const files: string[] = [], skipped: string[] = [];
  for (const e of entries) {
    const rel = safeZipPath(e.name, strip);
    if (!rel) { skipped.push(e.name); continue; }
    const abs = path.resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + path.sep)) { skipped.push(e.name); continue; }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, e.data());
    files.push(rel);
  }
  return { files, skipped };
}

/**
 * Overleaf's project list downloads several projects as one archive ("Overleaf Projects -3
 * items.zip") that holds one zip per project. Such an archive is a bundle: every project inside
 * it becomes a project of its own (named after its zip), nothing else is written.
 */
export function bundledZips(buf: Buffer): { name: string; data: () => Buffer }[] | null {
  const entries = readZip(buf).filter(e => !e.dir && safeZipPath(e.name) !== null);
  if (!entries.length || !entries.every(e => /\.zip$/i.test(e.name))) return null;
  return entries.map(e => ({ name: e.name.replace(/\\/g, '/').split('/').pop()!, data: e.data }));
}

/** A legal project name from a zip file name (`CV_Jan_Bauer.zip` → `CV_Jan_Bauer`). */
export function projectNameFromZip(file: string): string {
  const base = file.replace(/\.zip$/i, '').replace(/[^A-Za-z0-9._ -]+/g, '-').replace(/^[-. ]+|[-. ]+$/g, '').slice(0, 60);
  return base || 'overleaf-project';
}
