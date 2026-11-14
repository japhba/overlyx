import { describe, expect, it } from 'vitest';
import { qrMatrix, qrPath, qrFits, QR_MAX_BYTES } from '../packages/core/src/qr';
import { qrHtml, qrEditOps, qrPlaceholderAt, qrTextAt, qrWarning } from '../packages/client/src/deliverable/qrcode';
import { applyOp, parseSource, opSplices, applySplices } from '../packages/core/src/html/source';
import { scientificPoster } from '../packages/core/src/html/scientific';

/** GF(256) arithmetic of the standard, written apart from the encoder's */
const EXP: number[] = [], LOG: number[] = [];
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x = (x << 1) ^ (x & 0x80 ? 0x11d : 0); }
const gmul = (a: number, b: number) => (a && b ? EXP[(LOG[a] + LOG[b]) % 255] : 0);
const syndromesZero = (block: number[], ecc: number) => Array.from({ length: ecc }, (_, i) => block.reduce((acc, c) => gmul(acc, EXP[i]) ^ c, 0)).every(s => s === 0);

/** read a version-1 or version-2 code back: format bits, unmasking, the zigzag, the byte segment */
function read(m: boolean[][]): { text: string; codewords: number[] } {
  const n = m.length, ver = (n - 17) / 4;
  let f = 0;
  const bits = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
  bits.forEach(([x, y], i) => { if (m[y][x]) f |= 1 << i; });
  f ^= 0x5412;
  const mask = (f >> 10) & 7;
  expect(f >> 13).toBe(0);   // level M
  const fn = (x: number, y: number) => (x < 9 && y < 9) || (x >= n - 8 && y < 9) || (x < 9 && y >= n - 8) || x === 6 || y === 6
    || (ver === 2 && x >= n - 9 && x <= n - 5 && y >= n - 9 && y <= n - 5);
  const masks = [(x: number, y: number) => (x + y) % 2 === 0, (_x: number, y: number) => y % 2 === 0, (x: number) => x % 3 === 0, (x: number, y: number) => (x + y) % 3 === 0,
    (x: number, y: number) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x: number, y: number) => (x * y) % 2 + (x * y) % 3 === 0,
    (x: number, y: number) => ((x * y) % 2 + (x * y) % 3) % 2 === 0, (x: number, y: number) => ((x + y) % 2 + (x * y) % 3) % 2 === 0];
  const stream: number[] = [];
  let up = true;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < n; v++) for (let j = 0; j < 2; j++) {
      const x = right - j, y = up ? n - 1 - v : v;
      if (!fn(x, y)) stream.push((m[y][x] ? 1 : 0) ^ (masks[mask](x, y) ? 1 : 0));
    }
    up = !up;
  }
  const codewords: number[] = [];
  for (let i = 0; i + 8 <= stream.length; i += 8) codewords.push(stream.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  expect(codewords[0] >> 4).toBe(4);   // byte mode
  const len = ((codewords[0] & 15) << 4) | (codewords[1] >> 4);
  const bytes = Array.from({ length: len }, (_, i) => ((codewords[i + 1] & 15) << 4) | (codewords[i + 2] >> 4));
  return { text: new TextDecoder().decode(new Uint8Array(bytes)), codewords };
}

describe('the QR encoder (core qr.ts)', () => {
  it('writes a code a reader reads back, its error correction consistent', () => {
    for (const [text, ecc, total] of [['A', 10, 26], ['https://overlyx.app', 16, 44], ['Grüße — 日本語 ✓', 16, 44]] as const) {
      const m = qrMatrix(text)!;
      expect(m.length).toBe(total === 26 ? 21 : 25);
      const r = read(m);
      expect(r.text).toBe(text);
      expect(r.codewords.length).toBe(total);
      expect(syndromesZero(r.codewords, ecc)).toBe(true);
    }
  });
  it('has the three finder patterns and the timing lines', () => {
    const m = qrMatrix('https://example.org/poster')!, n = m.length;
    for (const [cx, cy] of [[3, 3], [n - 4, 3], [3, n - 4]]) {
      expect(m[cy][cx]).toBe(true); expect(m[cy - 2][cx]).toBe(false); expect(m[cy - 3][cx]).toBe(true);
    }
    for (let i = 8; i < n - 8; i++) { expect(m[6][i]).toBe(i % 2 === 0); expect(m[i][6]).toBe(i % 2 === 0); }
  });
  it('grows with the text and refuses what no code holds', () => {
    expect(qrMatrix('x'.repeat(200))!.length).toBe(57);          // version 10
    expect(qrMatrix('x'.repeat(QR_MAX_BYTES))!.length).toBe(177); // version 40
    expect(qrMatrix('x'.repeat(QR_MAX_BYTES + 1))).toBeNull();
    expect(qrMatrix('')).toBeNull();
    expect(qrFits('é'.repeat(1166))).toBe(false);
  });
  it('draws the dark modules as runs', () => {
    expect(qrPath([[true, true, false], [false, false, true]], 1)).toBe('M1 1h2v1h-2zM3 2h1v1h-1z');
  });
});

describe('QR codes in a deck (qrcode.ts)', () => {
  const place = 'position: absolute; left: 100px; top: 80px; width: 200px; height: 200px';
  const page = (body: string) => `<!doctype html><html><head><title>t</title></head><body><section class="slide">${body}</section></body></html>`;
  it('writes an SVG that keeps its text', () => {
    const html = qrHtml('https://example.org/?a=1&b="2"', place)!;
    expect(html).toMatch(/^<svg data-ol-qr="https:\/\/example\.org\/\?a=1&amp;b=&quot;2&quot;" role="img" aria-label="QR code: [^"]+" style="position: absolute; left: 100px; top: 80px; width: 200px; height: 200px; background: #ffffff" viewBox="0 0 (\d+) \1" shape-rendering="crispEdges"><path fill="#000000" d="M[^"]+"\/><\/svg>$/);
    expect(qrTextAt(page(html), [1, 0, 0])).toBe('https://example.org/?a=1&b="2"');
    expect(qrTextAt(page('<p>x</p>'), [1, 0, 0])).toBeNull();
    expect(qrHtml('', place)).toBeNull();
  });
  it('changes the link where the code is: place, colour and name stay', () => {
    const html = qrHtml('short', place, '#123456')!.replace('<svg ', '<svg data-ol-name="Ours" ');
    let text = page(html);
    const src = parseSource(text);
    text = applySplices(text, qrEditOps(text, [1, 0, 0], 'https://example.org/a/much/longer/address/than/before')!.flatMap(op => opSplices(src, op)));
    expect(qrTextAt(text, [1, 0, 0])).toBe('https://example.org/a/much/longer/address/than/before');
    expect(text).toContain('data-ol-name="Ours"');
    expect(text).toContain(place);
    expect(text).toContain('fill="#123456"');
    expect(text).toContain(`viewBox="0 0 ${qrMatrix('https://example.org/a/much/longer/address/than/before')!.length + 8} `);
    expect(text).toContain(`d="${qrPath(qrMatrix('https://example.org/a/much/longer/address/than/before')!)}"`);
  });
  it('finds the poster designs’ "QR code" placeholder from its words or its outline', () => {
    const poster = scientificPoster('A poster');
    const { doc } = parseSource(poster);
    let label: number[] | null = null;
    const visit = (el: any, path: number[]) => {
      const kids = (el.childNodes ?? []).filter((c: any) => 'tagName' in c);
      kids.forEach((k: any, i: number) => {
        if (!label && k.tagName === 'p' && k.childNodes.length === 1 && k.childNodes[0].value === 'QR code') label = [...path, i];
        visit(k, [...path, i]);
      });
    };
    visit(doc.childNodes.find((c: any) => c.tagName === 'html'), []);
    expect(label).not.toBeNull();
    const ph = qrPlaceholderAt(poster, label!)!;
    expect(ph.remove).toEqual([label]);
    expect(ph.replace).toEqual([...label!.slice(0, -1), label![label!.length - 1] - 1]);
    expect(ph.place).toMatch(/^position: absolute; left: [\d.]+px; top: [\d.]+px; width: ([\d.]+px); height: \1$/);
    expect(qrPlaceholderAt(poster, ph.replace)).toEqual({ place: ph.place, replace: ph.replace, remove: [label] });
    // the code in its place: the outline replaced, the words gone
    let text = applyOp(poster, { t: 'outer', path: ph.replace, html: qrHtml('https://example.org', ph.place)! });
    text = applyOp(text, { t: 'remove', paths: [label!] });
    expect(qrTextAt(text, ph.replace)).toBe('https://example.org');
    expect(qrPlaceholderAt(text, ph.replace)).toBeNull();
    // an ordinary text is none
    expect(qrPlaceholderAt(page('<p style="position: absolute; left: 1px; top: 2px; width: 30px">Results</p>'), [1, 0, 0])).toBeNull();
  });
  it('warns when a recoloured code may not scan', () => {
    expect(qrWarning('#000000', 'rgb(255, 255, 255)')).toBeNull();
    expect(qrWarning('rgb(0, 51, 102)', 'rgb(255, 255, 255)')).toBeNull();
    expect(qrWarning('#f2c94c', 'rgb(255, 255, 255)')).toMatch(/too pale/);
    expect(qrWarning('#ffffff', 'rgb(20, 20, 20)')).toMatch(/dark squares on a light ground/);
    expect(qrWarning(null, null)).toMatch(/cannot be scanned/);
  });
});
