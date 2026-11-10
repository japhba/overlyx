/** Placeholder figures (core/figureplaceholder.ts): where one goes, and the files written for it. */
import { describe, it, expect } from 'vitest';
import { canMakePlaceholder, jpegWithDpi, pdfWithJpeg, placeholderEps, placeholderPath, placeholderSvg, pngWithDpi } from '../packages/core/src/figureplaceholder.ts';

const text = (b: Uint8Array) => Buffer.from(b).toString('latin1');

describe('placeholder figures', () => {
  it('goes under the name, .pdf added when it has none', () => {
    expect(placeholderPath('figures/plot.png')).toBe('figures/plot.png');
    expect(placeholderPath('figures/plot')).toBe('figures/plot.pdf');
    expect(placeholderPath('v1.2/plot')).toBe('v1.2/plot.pdf');
    expect(canMakePlaceholder('figures/plot.JPG')).toBe(true);
    expect(canMakePlaceholder('figures/plot.tif')).toBe(false);
  });

  it('writes a PDF whose cross-references point at its objects', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
    const pdf = pdfWithJpeg(jpeg, { w: 8, h: 6 });
    const s = text(pdf);
    expect(s.startsWith('%PDF-1.4\n')).toBe(true);
    expect(s).toContain('/MediaBox [0 0 320 240]');
    expect(s).toContain(`/Width 8 /Height 6 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length}`);
    const start = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(s)![1]);
    expect(s.slice(start, start + 5)).toBe('xref\n');
    const offsets = [...s.slice(start).matchAll(/^(\d{10}) 00000 n $/gm)].map(m => Number(m[1]));
    expect(offsets).toHaveLength(5);
    offsets.forEach((o, i) => expect(s.slice(o, o + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
    // the image's bytes are there unchanged
    expect(s).toContain(text(jpeg));
  });

  it('gives a PNG its resolution after the header, or rewrites the one it has', () => {
    const ihdr = [0, 0, 0, 13, ...Buffer.from('IHDR'), 0, 0, 0, 4, 0, 0, 0, 3, 8, 2, 0, 0, 0, 1, 2, 3, 4];
    const iend = [0, 0, 0, 0, ...Buffer.from('IEND'), 0xae, 0x42, 0x60, 0x82];
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...ihdr, ...iend]);
    const out = pngWithDpi(png, 288);
    const at = 33;
    expect(text(out.subarray(at + 4, at + 8))).toBe('pHYs');
    const dv = new DataView(out.buffer, out.byteOffset);
    expect(dv.getUint32(at + 8)).toBe(Math.round(288 / 0.0254));
    expect(out[at + 16]).toBe(1);
    // its CRC, as zlib's crc32 has it for 11339 px/m both ways, unit metre
    expect(dv.getUint32(at + 17)).toBe(0xa53d96a9);
    expect(text(out.subarray(at + 21 + 4, at + 21 + 8))).toBe('IEND');
    const again = pngWithDpi(out, 144);
    expect(again.length).toBe(out.length);
    expect(new DataView(again.buffer).getUint32(at + 8)).toBe(Math.round(144 / 0.0254));
  });

  it('sets a JPEG’s JFIF density', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
    const out = jpegWithDpi(jpeg, 288);
    expect([...out.subarray(13, 18)]).toEqual([1, 1, 32, 1, 32]);
    expect(jpeg[13]).toBe(0);
  });

  it('writes SVG and EPS', () => {
    const svg = placeholderSvg('a<b>&c.svg');
    expect(svg).toContain('width="320pt" height="240pt"');
    expect(svg).toContain('a&lt;b&gt;&amp;c.svg');
    expect(placeholderEps()).toContain('%%BoundingBox: 0 0 320 240');
  });
});
