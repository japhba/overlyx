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

/* ------------------------------------------------------------------ writing (for "download project as zip") */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function dosDateTime(d = new Date()): { date: number; time: number } {
  return {
    date: (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
  };
}

/**
 * Build a ZIP archive (deflated where that is smaller, stored otherwise) from in-memory entries —
 * the write side of `readZip` above, same layout, so round-tripping through this module works.
 * No zip64: fine for a project's files (readZip's own ceiling is 65535 entries / 4 GB anyway).
 */
export function writeZip(entries: { name: string; data: Buffer }[]): Buffer {
  const { date, time } = dosDateTime();
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const deflated = zlib.deflateRawSync(e.data);
    const useDeflate = deflated.length < e.data.length;
    const payload = useDeflate ? deflated : e.data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(e.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);   // UTF-8 file name
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, payload);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(CENTRAL, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + payload.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBuf, eocd]);
}
