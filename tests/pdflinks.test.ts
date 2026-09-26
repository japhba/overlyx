/**
 * Public PDF links (server/pdflinks.ts), publishing PDFs into a GitHub repository
 * (server/pdfpublish.ts) and the TeX magic comment that picks the build engine (server/export.ts).
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-pdflinks-test');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'data'), { recursive: true });
mkdirSync(join(ROOT, 'projects'), { recursive: true });
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');

const { pdfLinkFileName, createPdfLink, pdfLinkFor, pdfLinkByToken, deletePdfLink, projectChangedSince } = await import('../packages/server/src/pdflinks.ts');
const { magicEngine, linkDocumentAssets, texInputs } = await import('../packages/server/src/export.ts');
const { blobSha, normalizeTarget, setPublishTarget, publishTargetFor, deletePublishTarget } = await import('../packages/server/src/pdfpublish.ts');
const fs = await import('node:fs');

describe('public PDF links', () => {
  it('names the file after the project (not its owner) for its main document, project-document otherwise', () => {
    expect(pdfLinkFileName('jan/CV/main.tex')).toBe('CV.pdf');
    expect(pdfLinkFileName('jan/CV/main.tex', 'Curriculum Vitae (2026)')).toBe('Curriculum_Vitae_2026.pdf');
    expect(pdfLinkFileName('jan/thesis/chapters/appendix.tex')).toBe('thesis-appendix.pdf');
    expect(pdfLinkFileName('jan/My Paper/main.lyx', null)).toBe('My_Paper.pdf');
  });
  it('one link per document, a stable token, gone when turned off', () => {
    const a = createPdfLink('u/p/main.tex', 1);
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(createPdfLink('u/p/main.tex', 1).token).toBe(a.token);   // turning it on again keeps the address people have
    expect(pdfLinkByToken(a.token)?.doc_id).toBe('u/p/main.tex');
    expect(pdfLinkByToken('not a token')).toBeUndefined();
    expect(pdfLinkByToken(a.token.toUpperCase() + 'x')).toBeUndefined();
    expect(deletePdfLink('u/p/main.tex')).toBe(true);
    expect(pdfLinkFor('u/p/main.tex')).toBeUndefined();
    expect(pdfLinkByToken(a.token)).toBeUndefined();
  });
  it('notices files written after a build, ignoring build products and backups', () => {
    const dir = join(ROOT, 'projects', 'u', 'chg');
    mkdirSync(join(dir, 'figs'), { recursive: true });
    fs.writeFileSync(join(dir, 'main.tex'), 'x');
    const t = Date.now() + 1000;
    expect(projectChangedSince('u/chg', t)).toBe(false);
    fs.writeFileSync(join(dir, 'main.tex~'), 'backup');
    fs.utimesSync(join(dir, 'main.tex~'), new Date(t + 5000), new Date(t + 5000));
    expect(projectChangedSince('u/chg', t)).toBe(false);
    fs.writeFileSync(join(dir, 'figs', 'plot.png'), 'p');
    fs.utimesSync(join(dir, 'figs', 'plot.png'), new Date(t + 5000), new Date(t + 5000));
    expect(projectChangedSince('u/chg', t)).toBe(true);
  });
});

describe('fonts next to the document', () => {
  it('are linked into the build directory (fontspec Path=./) and on the font search paths', () => {
    const doc = join(ROOT, 'projects', 'fonts'), build = join(ROOT, 'build-fonts');
    mkdirSync(doc, { recursive: true }); mkdirSync(build, { recursive: true });
    for (const f of ['Cabin-VariableFont_wdth,wght.ttf', 'Serif.otf', 'notes.txt', 'main.tex']) fs.writeFileSync(join(doc, f), f);
    linkDocumentAssets(doc, build);
    expect(fs.lstatSync(join(build, 'Cabin-VariableFont_wdth,wght.ttf')).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(join(build, 'Serif.otf')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(join(build, 'notes.txt'))).toBe(false);   // found through TEXINPUTS, not linked
    expect(fs.existsSync(join(build, 'main.tex'))).toBe(false);    // documents are written by the exporter
    const env = texInputs(doc, build);
    for (const k of ['TTFONTS', 'OPENTYPEFONTS', 'TEXINPUTS']) expect(env[k]).toBe(`${build}:${doc}:`);
  });
});

describe('TeX magic comments pick the engine', () => {
  it('reads the TeXShop / LaTeX Workshop forms in the first lines only', () => {
    expect(magicEngine('%!TEX TS-program = lualatex\n\\documentclass{article}')).toBe('-pdflua');
    expect(magicEngine('% !TeX program = xelatex\n')).toBe('-pdfxe');
    expect(magicEngine('% !TEX program = pdflatex')).toBe('-pdf');
    expect(magicEngine('%!TEX encoding = UTF-8\n\\documentclass{article}')).toBeNull();
    expect(magicEngine('\\documentclass{article}\n' + '% filler\n'.repeat(50) + '%!TEX TS-program = lualatex')).toBeNull();
    expect(magicEngine('% !TeX program = latexmk')).toBeNull();
  });
});

describe('publishing into a GitHub repository', () => {
  it("computes git's blob id", () => {
    expect(blobSha(Buffer.from('hello\n'))).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });
  it('normalises the target and refuses nonsense', () => {
    expect(normalizeTarget({ repo: 'https://github.com/japhba/japhba.github.io.git', path: '/static/uploads/cv/cv_jan_bauer.pdf', branch: ' main ' })).toEqual({ repo: 'japhba/japhba.github.io', path: 'static/uploads/cv/cv_jan_bauer.pdf', branch: 'main' });
    expect(normalizeTarget({ repo: 'a/b', path: 'x.pdf' }).branch).toBeNull();
    expect(() => normalizeTarget({ repo: 'japhba', path: 'x.pdf' })).toThrow(/owner\/name/);
    expect(() => normalizeTarget({ repo: 'a/b', path: 'dir/' })).toThrow(/file/);
    expect(() => normalizeTarget({ repo: 'a/b', path: '../x.pdf' })).toThrow(/file/);
    expect(() => normalizeTarget({ repo: 'a/b', path: '.github/workflows/x.yml' })).toThrow(/file/);
    expect(() => normalizeTarget({ repo: 'a/b', path: 'x.pdf', branch: 'bad branch' })).toThrow(/branch/);
  });
  it('stores one target per document', () => {
    setPublishTarget('u/p/main.tex', { repo: 'a/b', path: 'x.pdf' }, 1);
    expect(publishTargetFor('u/p/main.tex')).toMatchObject({ repo: 'a/b', path: 'x.pdf', branch: null });
    setPublishTarget('u/p/main.tex', { repo: 'a/c', path: 'y.pdf', branch: 'gh-pages' }, 1);
    expect(publishTargetFor('u/p/main.tex')).toMatchObject({ repo: 'a/c', path: 'y.pdf', branch: 'gh-pages' });
    expect(deletePublishTarget('u/p/main.tex')).toBe(true);
    expect(publishTargetFor('u/p/main.tex')).toBeUndefined();
  });
});
