/** Pasted/dropped images: file-type detection, LaTeX-safe names, SVG-markup detection, doc-relative paths. */
import { describe, it, expect, vi } from 'vitest';
vi.hoisted(() => { const g = globalThis as any; if (typeof g.window === 'undefined') g.window = g; });
import { imageExt, safeGraphicsName, uploadBaseName, pastedName, isSvgMarkup } from '../packages/client/src/editor/imagepaste.ts';
import { toDocRel, resolveDocPath } from '../packages/client/src/editor/context.ts';

describe('imageExt', () => {
  it('maps MIME types to graphics extensions', () => {
    expect(imageExt({ type: 'image/png' })).toBe('png');
    expect(imageExt({ type: 'image/jpeg', name: 'photo.jpeg' })).toBe('jpg');
    expect(imageExt({ type: 'image/svg+xml' })).toBe('svg');
    expect(imageExt({ type: 'application/pdf' })).toBe('pdf');
  });
  it('falls back to the file name when the type is missing or generic', () => {
    expect(imageExt({ type: '', name: 'Figure.PNG' })).toBe('png');
    expect(imageExt({ type: 'application/octet-stream', name: 'plot.eps' })).toBe('eps');
  });
  it('rejects non-image files', () => {
    expect(imageExt({ type: 'text/plain', name: 'notes.txt' })).toBe(null);
    expect(imageExt({ type: '', name: 'refs.bib' })).toBe(null);
    expect(imageExt({ type: '', name: 'noextension' })).toBe(null);
  });
});

describe('safeGraphicsName', () => {
  it('strips directory, extension and characters LaTeX chokes on', () => {
    expect(safeGraphicsName('My Figure (v2).png')).toBe('My-Figure-v2');
    expect(safeGraphicsName('a/b/plot.svg')).toBe('plot');
    expect(safeGraphicsName('C:\\Users\\me\\Screen Shot.jpg')).toBe('Screen-Shot');
    expect(safeGraphicsName('fig.v2.png')).toBe('fig.v2');
  });
  it('never returns an empty name', () => {
    expect(safeGraphicsName('')).toBe('image');
    expect(safeGraphicsName('....png')).toBe('image');
    expect(safeGraphicsName('***.png')).toBe('image');
  });
});

describe('uploadBaseName', () => {
  it('keeps a meaningful file name', () => {
    expect(uploadBaseName({ name: 'plot.png' })).toBe('plot');
    expect(uploadBaseName({ name: 'network diagram.svg' })).toBe('network-diagram');
  });
  it('replaces the browsers\' generic clipboard names with a timestamp', () => {
    expect(uploadBaseName({ name: 'image.png' })).toMatch(/^pasted-\d{8}-\d{6}$/);
    expect(uploadBaseName({ name: 'grafik.png' })).toMatch(/^pasted-/);
    expect(uploadBaseName({ name: '' })).toMatch(/^pasted-/);
  });
});

describe('pastedName', () => {
  it('is pasted-YYYYMMDD-HHMMSS in local time', () => {
    expect(pastedName(new Date(2026, 8, 2, 15, 30, 59))).toBe('pasted-20260902-153059');
    expect(pastedName(new Date(2026, 0, 1, 0, 0, 0))).toBe('pasted-20260101-000000');
  });
});

describe('isSvgMarkup', () => {
  it('recognises SVG documents, with or without prolog', () => {
    expect(isSvgMarkup('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>')).toBe(true);
    expect(isSvgMarkup('  <?xml version="1.0"?>\n<!DOCTYPE svg><svg viewBox="0 0 1 1"/>')).toBe(true);
    expect(isSvgMarkup('<!-- exported --><svg>\n</svg>')).toBe(true);
    expect(isSvgMarkup('<SVG WIDTH="10">')).toBe(true);
  });
  it('leaves other text alone', () => {
    expect(isSvgMarkup('\\textbf{bold} and $x^2$')).toBe(false);
    expect(isSvgMarkup('<div><svg></svg></div>')).toBe(false);
    expect(isSvgMarkup('svg is a nice format')).toBe(false);
    expect(isSvgMarkup('')).toBe(false);
  });
});

describe('toDocRel', () => {
  it('is the inverse of resolveDocPath', () => {
    expect(toDocRel('figures/x.png', '')).toBe('figures/x.png');
    expect(toDocRel('chapters/fig.png', 'chapters')).toBe('fig.png');
    expect(toDocRel('figures/x.png', 'chapters')).toBe('../figures/x.png');
    expect(toDocRel('figures/x.png', 'a/b')).toBe('../../figures/x.png');
    for (const [p, d] of [['figures/x.png', ''], ['figures/x.png', 'chapters'], ['a/b/c.png', 'a/b'], ['top.png', 'deep/er']] as const) {
      expect(resolveDocPath(toDocRel(p, d), d)).toBe(p);
    }
  });
});
