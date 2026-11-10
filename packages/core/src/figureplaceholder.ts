/**
 * Placeholder figures: a stand-in for a figure the document names before its file is there
 * (`\includegraphics{figures/plot.pdf}` with the plotting script yet to run) — a grey frame crossed
 * corner to corner with the file's name on it, in the format the name asks for, so the editor and the
 * PDF build show where the figure goes. The real figure saved under the same name replaces it.
 *
 * The vector formats are written here. The raster ones are drawn by the client (editor/placeholder.ts):
 * a PDF wraps its JPEG (pdfWithJpeg), a PNG or JPEG gets the resolution that makes it as big as the
 * vector ones in LaTeX (pngWithDpi, jpegWithDpi).
 */

/** the endings a placeholder is made for */
export const PLACEHOLDER_ENDINGS = ['.pdf', '.png', '.jpg', '.jpeg', '.svg', '.eps', '.webp'];

/** its size in pt: 4:3, 11.3 cm wide (as mwe's example-image) — the figure's own width wins where the document sets one */
export const PLACEHOLDER_PT = { w: 320, h: 240 };

/** its colours (grey levels 0–1): ground, cross, frame, name, the word "placeholder" */
export const PLACEHOLDER_GREYS = { ground: 0.925, cross: 0.78, frame: 0.62, name: 0.35, note: 0.55 };

const hex = (g: number) => '#' + Math.round(g * 255).toString(16).padStart(2, '0').repeat(3);
export const placeholderColor = (k: keyof typeof PLACEHOLDER_GREYS) => hex(PLACEHOLDER_GREYS[k]);

/** The ending of a file name (lower case, with its dot), '' when it has none. */
export function figureEnding(name: string): string {
  const slash = name.lastIndexOf('/'), dot = name.lastIndexOf('.');
  return dot > slash + 1 ? name.slice(dot).toLowerCase() : '';
}

/** Where a placeholder for the figure at `rel` goes: there, `.pdf` added when the name has no ending (graphicx looks for that first). */
export function placeholderPath(rel: string): string {
  return figureEnding(rel) ? rel : rel + '.pdf';
}

/** Can a placeholder be made at `rel` (placeholderPath)? */
export function canMakePlaceholder(rel: string): boolean {
  return PLACEHOLDER_ENDINGS.includes(figureEnding(placeholderPath(rel)));
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The placeholder as SVG, `label` (the file's name) on it. */
export function placeholderSvg(label: string, w = PLACEHOLDER_PT.w, h = PLACEHOLDER_PT.h): string {
  // (no text measuring here: a long name gets a smaller size, at about 0.56 em a character)
  const size = Math.max(6, Math.min(20, (0.8 * w) / Math.max(1, label.length * 0.56)));
  const c = placeholderColor;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}pt" height="${h}pt" viewBox="0 0 ${w} ${h}">
  <rect width="${w}" height="${h}" fill="${c('ground')}"/>
  <path d="M0 0L${w} ${h}M0 ${h}L${w} 0" stroke="${c('cross')}" stroke-width="1"/>
  <rect x="0.75" y="0.75" width="${w - 1.5}" height="${h - 1.5}" fill="none" stroke="${c('frame')}" stroke-width="1.5"/>
  <rect x="${w * 0.08}" y="${h / 2 - size * 1.1}" width="${w * 0.84}" height="${size * 2.2 + 12}" fill="${c('ground')}"/>
  <text x="${w / 2}" y="${h / 2 + size * 0.1}" text-anchor="middle" font-family="sans-serif" font-weight="600" font-size="${size.toFixed(1)}" fill="${c('name')}">${esc(label)}</text>
  <text x="${w / 2}" y="${h / 2 + size * 0.1 + 16}" text-anchor="middle" font-family="sans-serif" font-size="10" fill="${c('note')}">placeholder</text>
</svg>
`;
}

/** The placeholder as EPS: the frame and its cross (no text, which would have to name a PostScript font). */
export function placeholderEps(w = PLACEHOLDER_PT.w, h = PLACEHOLDER_PT.h): string {
  const g = PLACEHOLDER_GREYS;
  return `%!PS-Adobe-3.0 EPSF-3.0
%%BoundingBox: 0 0 ${w} ${h}
%%Title: placeholder
%%EndComments
gsave
${g.ground} setgray 0 0 ${w} ${h} rectfill
${g.cross} setgray 1 setlinewidth 0 0 moveto ${w} ${h} lineto stroke 0 ${h} moveto ${w} 0 lineto stroke
${g.frame} setgray 1.5 setlinewidth 0.75 0.75 ${w - 1.5} ${h - 1.5} rectstroke
grestore
showpage
%%EOF
`;
}

const ascii = (s: string) => new TextEncoder().encode(s);
const chars = (b: Uint8Array) => String.fromCharCode(...b);

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** A one-page PDF of `wPt` × `hPt` showing the JPEG (`px` its pixel size) over the whole page. */
export function pdfWithJpeg(jpeg: Uint8Array, px: { w: number; h: number }, wPt = PLACEHOLDER_PT.w, hPt = PLACEHOLDER_PT.h): Uint8Array<ArrayBuffer> {
  const draw = ascii(`q ${wPt} 0 0 ${hPt} 0 0 cm /Im0 Do Q\n`);
  const objects: Uint8Array[][] = [
    [ascii('<< /Type /Catalog /Pages 2 0 R >>')],
    [ascii('<< /Type /Pages /Kids [3 0 R] /Count 1 >>')],
    [ascii(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wPt} ${hPt}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`)],
    [ascii(`<< /Type /XObject /Subtype /Image /Width ${px.w} /Height ${px.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, ascii('\nendstream')],
    [ascii(`<< /Length ${draw.length} >>\nstream\n`), draw, ascii('endstream')],
  ];
  // (the second line's bytes above 127 tell file tools the PDF is binary)
  const parts: Uint8Array[] = [ascii('%PDF-1.4\n'), new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])];
  let at = parts[0].length + parts[1].length;
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(at);
    for (const p of [ascii(`${i + 1} 0 obj\n`), ...body, ascii('\nendobj\n')]) { parts.push(p); at += p.length; }
  });
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')}`;
  parts.push(ascii(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`));
  return concat(parts);
}

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** The PNG with a pHYs chunk saying `dpi` (one already there rewritten, else one put after the header). */
export function pngWithDpi(png: Uint8Array<ArrayBuffer>, dpi: number): Uint8Array<ArrayBuffer> {
  if (png.length < 33 || chars(png.subarray(12, 16)) !== 'IHDR') return png;
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(4 + 4 + 9 + 4);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, 9);
  chunk.set(ascii('pHYs'), 4);
  dv.setUint32(8, ppm); dv.setUint32(12, ppm); chunk[16] = 1;
  dv.setUint32(17, crc32(chunk.subarray(4, 17)));
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  for (let at = 8; at + 12 <= png.length;) {
    const len = view.getUint32(at), type = chars(png.subarray(at + 4, at + 8));
    if (type === 'pHYs') return concat([png.subarray(0, at), chunk, png.subarray(at + 12 + len)]);
    if (type === 'IDAT' || type === 'IEND') break;
    at += 12 + len;
  }
  return concat([png.subarray(0, 33), chunk, png.subarray(33)]);
}

/** The JPEG's JFIF header set to `dpi` (canvases write 1:1, no unit — 72 dpi to LaTeX); a JPEG without one is left alone. */
export function jpegWithDpi(jpeg: Uint8Array<ArrayBuffer>, dpi: number): Uint8Array<ArrayBuffer> {
  const jfif = jpeg.length > 18 && jpeg[0] === 0xff && jpeg[1] === 0xd8 && jpeg[2] === 0xff && jpeg[3] === 0xe0
    && chars(jpeg.subarray(6, 11)) === 'JFIF\0';
  if (!jfif) return jpeg;
  const out = jpeg.slice();
  out[13] = 1;
  out[14] = dpi >> 8; out[15] = dpi & 0xff;
  out[16] = dpi >> 8; out[17] = dpi & 0xff;
  return out;
}
