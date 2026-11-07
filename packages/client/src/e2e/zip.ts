/**
 * A .zip made in the browser: the download of an end-to-end encrypted project (the server cannot
 * make one, it has only ciphertext). Each file deflated where the browser can (CompressionStream
 * 'deflate-raw'), else stored; no ZIP64, so up to 4 GB.
 */

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC[(c ^ data[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflate(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const out = await new Response(new Blob([data.slice().buffer as ArrayBuffer]).stream().pipeThrough(new CompressionStream('deflate-raw' as CompressionFormat))).arrayBuffer();
    return new Uint8Array(out);
  } catch { return null; }
}

/** MS-DOS time and date of a moment (local time, as zip tools show it) */
function dosTime(ms: number): { time: number; date: number } {
  const d = new Date(ms);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** The zip of these files (`path` with `/`, a folder as `name/` with no data). */
export async function makeZip(files: { path: string; data: Uint8Array; mtime?: number }[]): Promise<Blob> {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.path);
    const crc = crc32(f.data);
    const packed = f.data.length > 64 && !f.path.endsWith('/') ? await deflate(f.data) : null;
    const useDeflate = !!packed && packed.length < f.data.length;
    const body = useDeflate ? packed! : f.data;
    const { time, date } = dosTime(f.mtime ?? Date.now());
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);   // the name is UTF-8
    local.setUint16(8, useDeflate ? 8 : 0, true);
    local.setUint16(10, time, true); local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true); local.setUint32(22, f.data.length, true);
    local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true); cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, useDeflate ? 8 : 0, true);
    cd.setUint16(12, time, true); cd.setUint16(14, date, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, body.length, true); cd.setUint32(24, f.data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(38, f.path.endsWith('/') ? 0x10 : 0, true);   // a folder
    cd.setUint32(42, offset, true);
    parts.push(new Uint8Array(local.buffer), name, body);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + body.length;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)].map(p => p.slice().buffer as ArrayBuffer), { type: 'application/zip' });
}
