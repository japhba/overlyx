import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { parseLyx, exportLyx } from '../packages/core/src/index.ts';
import { parseTex } from '../packages/core/src/tex/index.ts';
import { LYX_LAYOUTS } from './lyxlib.ts';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overlyx-lyx-transfer-'));
process.env.OVERLYX_DATA_DIR = path.join(root, 'data');
process.env.OVERLYX_PROJECTS_DIR = path.join(root, 'projects');
// (server modules only after the directories are set: they load the configuration, which keeps them)
const { writeZip } = await import('../packages/server/src/zip.ts');
const { importLyxUpload } = await import('../packages/server/src/lyximport.ts');
const pdf = async () => {};
const tex = (body: string) => ['\\documentclass{article}', '\\begin{document}', body, '\\end{document}'].join('\n');
const native = (body: string) => exportLyx(parseTex(tex(body), { layoutDir: LYX_LAYOUTS }).doc);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('native LyX transfer', () => {
  it('exports a desktop-compatible header and keeps text, math and inset content', () => {
    const source = parseTex(tex('\\section{Heading}\nText with $x^2$ and a \\footnote{note}.'), { layoutDir: LYX_LAYOUTS }).doc;
    source.preamble = ['% document note', '\\documentclass{article}'];
    source.header.lines.push('\\overlyx_grid on');
    const out = exportLyx(source);
    expect(out).toMatch(/^#LyX 2\.4/);
    expect(out).toContain('\\lyxformat 615');
    expect(out).not.toMatch(/\\overlyx_|\\crossref_package|\\documentclass/);
    expect(parseLyx(out).body).toEqual(source.body);
    expect(source.header.lines).toContain('\\overlyx_grid on');
  });

  it('imports plain, uppercase and compressed files while retaining the exact original', async () => {
    const original = Buffer.from(native('Hello $x^2$.'));
    for (const [name, bytes] of [['paper.LYX', original], ['paper.lyx', gzipSync(original)]] as const) {
      const project = 'alice/' + (name.endsWith('LYX') ? 'plain' : 'compressed');
      const result = await importLyxUpload(project, name, bytes, pdf);
      expect(result.created).toEqual(['paper.tex']);
      expect(fs.readFileSync(path.join(root, 'projects', project, name))).toEqual(bytes);
      expect(fs.readFileSync(path.join(root, 'projects', project, 'paper.tex'), 'utf8')).toContain('Hello');
    }
  });

  it('imports a project archive with child documents and assets, choosing the master to open', async () => {
    const master = native('Before \\input{a-child.tex} after.').replace('filename "a-child.tex"', 'filename "a-child.lyx"');
    const archive = writeZip([
      { name: 'main.lyx', data: Buffer.from(master) },
      { name: 'a-child.lyx', data: Buffer.from(native('Child content.')) },
      { name: 'figures/plot.png', data: Buffer.from([1, 2, 3]) },
      { name: 'refs.bib', data: Buffer.from('@article{sample,title={Sample}}') },
    ]);
    const result = await importLyxUpload('alice/project', 'paper.zip', archive, pdf);
    expect(result.id).toBe('alice/project/main.tex');
    expect(result.created.sort()).toEqual(['a-child.tex', 'main.tex']);
    const base = path.join(root, 'projects/alice/project');
    expect(fs.readFileSync(path.join(base, 'main.tex'), 'utf8')).toContain('a-child.tex');
    expect(fs.readFileSync(path.join(base, 'a-child.tex'), 'utf8')).not.toContain('\\documentclass');
    expect(fs.readFileSync(path.join(base, 'figures/plot.png'))).toEqual(Buffer.from([1, 2, 3]));
  });

  it('rejects bad documents and output collisions without replacing existing files', async () => {
    await expect(importLyxUpload('alice/bad', 'bad.lyx', Buffer.from('Not a LyX file'), pdf)).rejects.toThrow(/complete LyX/);
    expect(fs.existsSync(path.join(root, 'projects/alice/bad'))).toBe(false);
    const archive = writeZip([{ name: 'main.lyx', data: Buffer.from(native('Source.')) }, { name: 'main.tex', data: Buffer.from('Keep me') }]);
    await expect(importLyxUpload('alice/collision', 'paper.zip', archive, pdf)).rejects.toThrow(/already exists/);
    const dir = path.join(root, 'projects/alice/existing');
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'keep.txt'), 'Keep me');
    await expect(importLyxUpload('alice/existing', 'paper.lyx', Buffer.from(native('Source.')), pdf)).rejects.toThrow();
    expect(fs.readFileSync(path.join(dir, 'keep.txt'), 'utf8')).toBe('Keep me');
  });
});
