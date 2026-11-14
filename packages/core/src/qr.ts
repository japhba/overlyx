/**
 * A QR code encoder (ISO/IEC 18004, model 2): the text as UTF-8 bytes, error correction level M
 * (15 % of the code may be damaged), versions 1–40 — the smallest that holds the text, the mask with
 * the lowest penalty. Small on purpose: no dependency, runs wherever a deck is edited (the browser,
 * offline, the VS Code webview, the server).
 *
 * `qrMatrix(text)` gives the modules (true = dark) without the quiet zone; `qrPath` the dark ones as
 * one SVG path of unit squares, rows merged into runs.
 */

/** error-correction codewords per block, level M, by version (index 0 unused) */
const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
/** number of error-correction blocks, level M, by version */
const BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];

/** the modules that carry data or error correction in a code of this version */
function rawModules(ver: number): number {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}
const dataCodewords = (ver: number) => Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ver] * BLOCKS[ver];

/** how many bytes a code can hold at most (version 40, level M) */
export const QR_MAX_BYTES = 2331;

/* ---- Reed–Solomon over GF(2^8), polynomial 0x11D */

function mul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}
function divisor(degree: number): number[] {
  const out = new Array<number>(degree).fill(0);
  out[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      out[j] = mul(out[j], root);
      if (j + 1 < degree) out[j] ^= out[j + 1];
    }
    root = mul(root, 2);
  }
  return out;
}
function remainder(data: number[], div: number[]): number[] {
  const out = div.map(() => 0);
  for (const b of data) {
    const factor = b ^ out.shift()!;
    out.push(0);
    div.forEach((c, i) => { out[i] ^= mul(c, factor); });
  }
  return out;
}

/** the data codewords with their error correction, interleaved as they are laid into the code */
function withEcc(data: number[], ver: number): number[] {
  const blocks = BLOCKS[ver], ecc = ECC_PER_BLOCK[ver];
  const raw = Math.floor(rawModules(ver) / 8);
  const short = blocks - raw % blocks, shortLen = Math.floor(raw / blocks);
  const div = divisor(ecc);
  const parts: number[][] = [];
  for (let i = 0, k = 0; i < blocks; i++) {
    const dat = data.slice(k, k + shortLen - ecc + (i < short ? 0 : 1));
    k += dat.length;
    const rem = remainder(dat, div);
    if (i < short) dat.push(0);
    parts.push(dat.concat(rem));
  }
  const out: number[] = [];
  for (let i = 0; i < parts[0].length; i++) parts.forEach((p, j) => { if (i !== shortLen - ecc || j >= short) out.push(p[i]); });
  return out;
}

const utf8 = (text: string): number[] => Array.from(new TextEncoder().encode(text));

/** the smallest version that holds `bytes` bytes, or 0 when none does */
function versionFor(bytes: number): number {
  for (let ver = 1; ver <= 40; ver++) if (4 + (ver < 10 ? 8 : 16) + 8 * bytes <= dataCodewords(ver) * 8) return ver;
  return 0;
}

/** whether a text fits into a QR code */
export const qrFits = (text: string): boolean => versionFor(utf8(text).length) > 0;

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  x => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
  (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0,
  (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0,
];

/** the penalty of a finished code (the standard's four rules): the lower, the easier to scan */
function penalty(m: boolean[][]): number {
  const n = m.length;
  let score = 0, dark = 0;
  const line = (get: (i: number) => boolean) => {
    let run = 1, bits = get(0) ? 1 : 0;
    for (let i = 1; i < n; i++) {
      if (get(i) === get(i - 1)) { run++; if (run === 5) score += 3; else if (run > 5) score++; } else run = 1;
      bits = ((bits << 1) | (get(i) ? 1 : 0)) & 0x7ff;
      // a finder-like 1:1:3:1:1 with four light modules on one side
      if (i >= 10 && (bits === 0x05d || bits === 0x5d0)) score += 40;
    }
  };
  for (let y = 0; y < n; y++) line(i => m[y][i]);
  for (let x = 0; x < n; x++) line(i => m[i][x]);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (m[y][x]) dark++;
    if (x + 1 < n && y + 1 < n && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) score += 3;
  }
  return score + Math.floor(Math.abs(dark * 20 - n * n * 10) / (n * n)) * 10;
}

/**
 * The code of `text`: rows of modules, true = dark, without the quiet zone (four light modules are
 * to stay free around it). Null when the text is empty or too long for a code (QR_MAX_BYTES).
 */
export function qrMatrix(text: string): boolean[][] | null {
  const bytes = utf8(text);
  const ver = bytes.length ? versionFor(bytes.length) : 0;
  if (!ver) return null;
  const n = ver * 4 + 17;

  // the bit stream: byte mode, the count, the bytes, the terminator, padding
  const bits: number[] = [];
  const put = (value: number, len: number) => { for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  put(4, 4);
  put(bytes.length, ver < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const cap = dataCodewords(ver) * 8;
  put(0, Math.min(4, cap - bits.length));
  put(0, (8 - bits.length % 8) % 8);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  const words = withEcc(data, ver);

  // the function patterns
  const m: boolean[][] = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  const fn: boolean[][] = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  const set = (x: number, y: number, dark: boolean) => { m[y][x] = dark; fn[y][x] = true; };
  for (let i = 0; i < n; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [n - 4, 3], [3, n - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy;
      if (x >= 0 && x < n && y >= 0 && y < n) set(x, y, d !== 2 && d !== 4);
    }
  }
  const align: number[] = [];
  if (ver > 1) {
    const count = Math.floor(ver / 7) + 2;
    const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (count * 2 - 2)) * 2;
    align.push(6);
    for (let pos = n - 7; align.length < count; pos -= step) align.splice(1, 0, pos);
  }
  align.forEach((cx, i) => align.forEach((cy, j) => {
    const last = align.length - 1;
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));
  const format = (mask: number) => {
    // level M's two bits are 00
    let rem = mask;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const f = ((mask << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((f >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(n - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, n - 15 + i, bit(i));
    set(8, n - 8, true);
  };
  format(0);
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const v = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((v >>> i) & 1) !== 0, a = n - 11 + i % 3, b = Math.floor(i / 3);
      set(a, b, dark); set(b, a, dark);
    }
  }

  // the codewords, in the zigzag from the bottom right
  let k = 0;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < n; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, up = ((right + 1) & 2) === 0, y = up ? n - 1 - vert : vert;
      if (!fn[y][x] && k < words.length * 8) { m[y][x] = ((words[k >>> 3] >>> (7 - (k & 7))) & 1) !== 0; k++; }
    }
  }

  // the mask that scans best
  const flip = (mask: number) => { for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (!fn[y][x] && MASKS[mask](x, y)) m[y][x] = !m[y][x]; };
  let best = 0, least = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    flip(mask); format(mask);
    const p = penalty(m);
    if (p < least) { least = p; best = mask; }
    flip(mask);
  }
  flip(best); format(best);
  return m;
}

/** the dark modules as one SVG path of unit squares (rows merged into runs), `quiet` modules in from the corner */
export function qrPath(m: boolean[][], quiet = 4): string {
  let d = '';
  m.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (!row[x]) continue;
      let w = 1;
      while (x + w < row.length && row[x + w]) w++;
      d += `M${x + quiet} ${y + quiet}h${w}v1h-${w}z`;
      x += w;
    }
  });
  return d;
}
