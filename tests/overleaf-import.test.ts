/**
 * Importing Overleaf projects: the zip reader / safe extraction (server/zip.ts), Overleaf link
 * parsing (server/overleaf.ts, client OverleafImport.tsx) and the clone error wording.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { readZip, extractZip, safeZipPath, bundledZips, projectNameFromZip } from '../packages/server/src/zip.ts';
import { overleafProjectId, overleafGitUrl, describeCloneError } from '../packages/server/src/overleaf.ts';
import { parseOverleafRefs, projectNameFrom } from '../packages/client/src/app/OverleafImport.tsx';

async function zipOf(files: Record<string, string>, opts: { compress?: boolean } = {}): Promise<Buffer> {
  const z = new JSZip();
  for (const [k, v] of Object.entries(files)) z.file(k, v);
  return Buffer.from(await z.generateAsync({ type: 'nodebuffer', compression: opts.compress === false ? 'STORE' : 'DEFLATE' }));
}

describe('zip reader', () => {
  it('lists and inflates deflated and stored entries', async () => {
    for (const compress of [true, false]) {
      const buf = await zipOf({ 'main.tex': '\\documentclass{article}\n\\begin{document}Hi\\end{document}\n', 'figs/plot.pdf': 'PDF-ish ' + 'x'.repeat(5000) }, { compress });
      const entries = readZip(buf).filter(e => !e.dir);
      expect(entries.map(e => e.name).sort()).toEqual(['figs/plot.pdf', 'main.tex']);
      expect(entries.find(e => e.name === 'main.tex')!.data().toString()).toContain('\\begin{document}');
      expect(entries.find(e => e.name === 'figs/plot.pdf')!.data().length).toBe(5008);
    }
  });
  it('rejects things that are not zip files', () => {
    expect(() => readZip(Buffer.from('%PDF-1.4 not a zip at all'))).toThrow(/not a zip/);
  });
});

describe('extractZip', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ovx-zip-'));
  it('writes the files, strips a single wrapping folder, skips traversal and .git', async () => {
    const buf = await zipOf({ 'paper-main/main.tex': 'A', 'paper-main/sections/intro.tex': 'B', 'paper-main/.git/config': 'nope', 'paper-main/__MACOSX/._main.tex': 'junk' });
    const dest = tmp();
    const r = extractZip(buf, dest);
    expect(r.files.sort()).toEqual(['main.tex', 'sections/intro.tex']);
    expect(r.skipped.length).toBe(2);
    expect(fs.readFileSync(path.join(dest, 'sections/intro.tex'), 'utf8')).toBe('B');
    expect(fs.existsSync(path.join(dest, '.git'))).toBe(false);
  });
  it('keeps the layout when files sit at the top level (Overleaf archives)', async () => {
    const buf = await zipOf({ 'main.tex': 'A', 'refs.bib': 'B', 'figures/f.png': 'C' });
    const dest = tmp();
    expect(extractZip(buf, dest).files.sort()).toEqual(['figures/f.png', 'main.tex', 'refs.bib']);
  });
  it("recognises Overleaf's bundle of project zips (the project list's download) and names the projects after them", async () => {
    const inner = await zipOf({ 'main.tex': 'A', 'res.cls': 'B' });
    const other = await zipOf({ 'paper.tex': 'C' });
    const bundle = new JSZip();
    bundle.file('CV_Jan_Bauer.zip', inner);
    bundle.file('My Paper (final).zip', other);
    const buf = Buffer.from(await bundle.generateAsync({ type: 'nodebuffer', compression: 'STORE' }));
    const parts = bundledZips(buf)!;
    expect(parts.map(p => p.name).sort()).toEqual(['CV_Jan_Bauer.zip', 'My Paper (final).zip']);
    expect(readZip(parts.find(p => p.name === 'CV_Jan_Bauer.zip')!.data()).map(e => e.name).sort()).toEqual(['main.tex', 'res.cls']);
    expect(projectNameFromZip('CV_Jan_Bauer.zip')).toBe('CV_Jan_Bauer');
    expect(projectNameFromZip('My Paper (final).zip')).toBe('My Paper -final');
    // an ordinary project archive is not a bundle, even when it carries a zip among its files
    expect(bundledZips(inner)).toBeNull();
    expect(bundledZips(await zipOf({ 'main.tex': 'A', 'data/raw.zip': 'Z' }))).toBeNull();
    // Finder's leftovers do not make it one
    const mac = new JSZip(); mac.file('CV.zip', inner); mac.file('__MACOSX/._CV.zip', 'junk');
    expect(bundledZips(Buffer.from(await mac.generateAsync({ type: 'nodebuffer' })))!.map(p => p.name)).toEqual(['CV.zip']);
  });
  it('safeZipPath refuses escapes', () => {
    expect(safeZipPath('../etc/passwd')).toBeNull();
    expect(safeZipPath('a/../../b')).toBeNull();
    expect(safeZipPath('C:/x')).toBeNull();
    expect(safeZipPath('./a//b.tex')).toBe('a/b.tex');
    expect(safeZipPath('dir/')).toBeNull();
  });
});

describe('Overleaf links', () => {
  const id = '5f1a2b3c4d5e6f7a8b9c0d1e';
  it('finds the project id in the forms people paste', () => {
    for (const s of [id, `https://www.overleaf.com/project/${id}`, `https://www.overleaf.com/project/${id}/detacher`, `www.overleaf.com/project/${id}?x=1`, `https://git.overleaf.com/${id}`, `https://git.overleaf.com/${id}.git`.replace('.git', '')]) {
      expect(overleafProjectId(s)).toBe(id);
    }
    expect(overleafProjectId('https://www.overleaf.com/read/abcdefghijkl')).toBeNull();   // a read-only share link has no clonable id
    expect(overleafProjectId('https://example.com/project/' + id)).toBeNull();
    expect(overleafGitUrl(id)).toBe(`https://git.overleaf.com/${id}`);
  });
  it('the client extracts every id from a pasted list, once each', () => {
    const other = 'aaaaaaaaaaaaaaaaaaaaaaaa';
    expect(parseOverleafRefs(`https://www.overleaf.com/project/${id}\n${other}\nhttps://www.overleaf.com/project/${id}\nnot a link`)).toEqual([id, other]);
    expect(projectNameFrom('My Paper (final).zip')).toBe('My Paper -final');
    expect(projectNameFrom('.zip')).toBe('overleaf-project');
  });
  it('explains clone failures in plain words', () => {
    expect(describeCloneError("fatal: Authentication failed for 'https://git.overleaf.com/x/'")).toMatch(/token/);
    expect(describeCloneError('remote: Not Found\nfatal: repository not found')).toMatch(/no project with this id/);
    expect(describeCloneError('fatal: unable to access: Could not resolve host: git.overleaf.com')).toMatch(/could not be reached/);
  });
});
