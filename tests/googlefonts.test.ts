/**
 * Google fonts (server googlefonts.ts): the catalogue decides what a family is; a variable family's
 * files and a static family's faces come from the google/fonts repository, the css2 API when that
 * fails; fetched once, cached, a name Google lacks remembered. \olfont's families go into the build.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, rmSync, mkdtempSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = vi.hoisted(() => {
  const r = require('node:path').join(require('node:os').tmpdir(), 'overlyx-googlefonts-test');
  process.env.OVERLYX_DATA_DIR = require('node:path').join(r, 'data');
  return r;
});
rmSync(ROOT, { recursive: true, force: true });
const { googleFont, fontFaces, setFetch, validFamily, olfontFamilies, provideFaceFonts, houseFontWarmups } = await import('../packages/server/src/googlefonts.ts');
const { fontspecFiles } = await import('../packages/core/src/md/typesetting.ts');

const CATALOG = ")]}'" + JSON.stringify({
  axisRegistry: [{ tag: 'wght', displayName: 'Weight' }, { tag: 'opsz', displayName: 'Optical size' }],
  familyMetadataList: [
    { family: 'Inter', category: 'Sans Serif', fonts: { 400: {}, '400i': {}, 700: {} }, axes: [{ tag: 'wght', min: 100, max: 900, defaultValue: 400 }, { tag: 'opsz', min: 14, max: 32, defaultValue: 14 }], popularity: 5 },
    { family: 'Lato', category: 'Sans Serif', fonts: { 300: {}, 400: {}, '400i': {}, 700: {} }, axes: [], popularity: 9 },
    { family: 'Lora', category: 'Serif', fonts: { 400: {}, 700: {}, '400i': {} }, axes: [], popularity: 30 },
  ],
});
const CSS = (fam: string) => `@font-face {\n  font-family: '${fam}';\n  font-style: normal;\n  font-weight: 400;\n  src: url(https://fonts.gstatic.com/s/x/v1/regular.ttf) format('truetype');\n}\n@font-face {\n  font-family: '${fam}';\n  font-style: italic;\n  font-weight: 700;\n  src: url(https://fonts.gstatic.com/s/x/v1/bolditalic.ttf) format('truetype');\n}\n`;
const BYTES = () => new Response(new Uint8Array([0, 1, 0, 0, 7]));
const asked: string[] = [];

/** Google and GitHub as the tests need them: Inter variable in the repository, Lato static there, Lora only on the css2 API */
beforeEach(() => {
  asked.length = 0;
  setFetch((async (u: string) => {
    const url = decodeURIComponent(String(u));
    asked.push(url);
    if (url === 'https://fonts.google.com/metadata/fonts') return new Response(CATALOG);
    if (url.endsWith('ofl/inter/Inter[opsz,wght].ttf') || url.endsWith('ofl/inter/Inter-Italic[opsz,wght].ttf')) return BYTES();
    if (url === 'https://api.github.com/repos/google/fonts/contents/ofl/lato') return Response.json([{ name: 'Lato-Light.ttf', type: 'file' }, { name: 'Lato-Regular.ttf', type: 'file' }, { name: 'Lato-Italic.ttf', type: 'file' }, { name: 'OFL.txt', type: 'file' }]);
    if (url.includes('ofl/lato/Lato-')) return BYTES();
    if (url.includes('css2?family=Lora')) return new Response(CSS('Lora'));
    if (url.startsWith('https://fonts.gstatic.com/')) return BYTES();
    return new Response('', { status: 404 });
  }) as typeof fetch);
});

describe('google fonts', () => {
  it('takes a variable family as its variable font files, once', async () => {
    const f = (await googleFont('inter'))!;
    expect(f.family).toBe('Inter');
    expect(f.files.map(x => [x.file, x.style])).toEqual([['inter-var.ttf', 'normal'], ['inter-italic-var.ttf', 'italic']]);
    expect(f.axes?.map(a => a.t)).toEqual(['wght', 'opsz']);
    expect(existsSync(join(f.dir, 'inter-var.ttf'))).toBe(true);
    const faces = fontFaces(f);
    expect(faces).toEqual({ regular: 'inter-var.ttf', bold: 'inter-var.ttf', italic: 'inter-italic-var.ttf', boldItalic: 'inter-italic-var.ttf', variable: true });
    // (the PDF sets each face by its weight)
    expect(fontspecFiles({ path: './ol-fonts/inter/', ...faces })).toContain('BoldFont=inter-var.ttf, BoldFeatures={RawFeature={axis={wght=700}}}');
    asked.length = 0;
    expect((await googleFont('Inter'))!.files.length).toBe(2);
    expect(asked).toEqual([]);
  });

  it('takes a static family as the faces of its repository folder', async () => {
    const f = (await googleFont('Lato'))!;
    expect(f.axes).toBeUndefined();
    expect(f.files.map(x => x.style)).toEqual(['normal', 'italic']);
    expect(asked.some(u => u.includes('api.github.com'))).toBe(true);
  });

  it('falls back on the css2 API', async () => {
    const f = (await googleFont('Lora'))!;
    expect(asked.find(u => u.includes('css2'))).toBe('https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,700;1,400;1,700');
    expect(f.files.map(x => x.file)).toEqual(['lora-400.ttf', 'lora-700i.ttf']);
    expect(fontFaces(f)).toEqual({ regular: 'lora-400.ttf', bold: undefined, italic: undefined, boldItalic: 'lora-700i.ttf' });
  });

  it('remembers a name Google does not know, and refuses names that are no family name', async () => {
    expect(await googleFont('No Such Font')).toBeNull();
    const before = asked.length;
    expect(await googleFont('No Such Font')).toBeNull();
    expect(asked.length).toBe(before);
    expect(validFamily('Inter')).toBe(true);
    expect(validFamily('../etc')).toBe(false);
    expect(await googleFont('x}\\\\bad')).toBeNull();
  });

  it("puts \\olfont's families into the build directory", async () => {
    expect(olfontFamilies('a \\olfont[300][+onum]{Inter}{x} \\olfont{Lato}{y} \\olfont{Inter}{z} \\DeclareDocumentCommand \\olfont {')).toEqual(['Inter', 'Lato']);
    const dir = mkdtempSync(join(tmpdir(), 'olfont-build-'));
    const root = await provideFaceFonts('\\olfont{Inter}{x}', dir);
    expect(root).toBe(join(dir, 'ol-fonts'));
    expect(readdirSync(join(dir, 'ol-fonts', 'inter')).sort()).toEqual(['inter-italic-var.ttf', 'inter-var.ttf']);
    expect(await provideFaceFonts('no fonts', dir)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves Anodyne, the house font, from the repository: variable woff2 to the web, static faces with MATH and the text as a variable font to TeX', async () => {
    const f = await googleFont('anodyne');
    expect(f?.family).toBe('Anodyne');
    expect(f?.axes?.map(a => a.t)).toEqual(['wght', 'wdth', 'GRAD']);
    expect(f!.files.every(x => x.file.endsWith('.woff2') && x.range && existsSync(join(f!.dir, x.file)))).toBe(true);
    expect(fontFaces(f!)).toEqual({ regular: 'Anodyne-Regular.ttf', bold: 'Anodyne-Bold.ttf', italic: 'Anodyne-Italic.ttf', boldItalic: 'Anodyne-BoldItalic.ttf' });
    expect(asked).toEqual([]);  // never asks Google
    expect(olfontFamilies('\\setsansfont{Anodyne}\\setmathfont{Anodyne}')).toEqual(['Anodyne']);
    const dir = mkdtempSync(join(tmpdir(), 'olfont-build-'));
    await provideFaceFonts('\\setsansfont{Anodyne}', dir);
    // (the static faces fontspec finds by name, and "Anodyne Variable" for any weight, width and grade)
    const files = ['Anodyne-Bold.ttf', 'Anodyne-BoldItalic.ttf', 'Anodyne-Italic.ttf', 'Anodyne-Regular.ttf', 'AnodyneVariable-Italic.ttf', 'AnodyneVariable.ttf'];
    expect(readdirSync(join(dir, 'ol-fonts', 'anodyne')).sort()).toEqual(files);
    // each face LuaTeX has not cached in the build's HOME is loaded alone first, from where the build has it
    const home = mkdtempSync(join(tmpdir(), 'olfont-home-'));
    expect(houseFontWarmups('\\setsansfont{Anodyne}', home).map(w => w.file).sort()).toEqual(files);
    mkdirSync(join(home, '.texlive2023', 'texmf-var', 'luatex-cache', 'generic', 'fonts', 'otl'), { recursive: true });
    writeFileSync(join(home, '.texlive2023', 'texmf-var', 'luatex-cache', 'generic', 'fonts', 'otl', 'anodyne-regular.luc'), '');
    const left = houseFontWarmups('\\olfont[wght=550]{Anodyne}{x}', home);
    expect(left).toHaveLength(5);
    expect(left[0].doc).toContain('\\setmainfont{Anodyne-Italic.ttf}[Path=./ol-fonts/anodyne/]');
    expect(houseFontWarmups('\\setsansfont{Inter}', home)).toEqual([]);
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });
});
