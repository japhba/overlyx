/** Import a local LyX document or project archive into a new, exclusively created directory. */
import fs from 'node:fs';
import path from 'node:path';
import { parseLyx } from '@overlyx/core';
import { collect, projectDir, resolveProjectPath } from './projectfiles.ts';
import { extractZip } from './zip.ts';
import { projectRoom, noteWritten, assertRoom } from './projectsize.ts';
import { importLyxFile, readLyxText, type ImportResult } from './texdoc.ts';

export async function importLyxUpload(project: string, filename: string, data: Buffer,
  toPdf: (src: string, dest: string) => Promise<void>, folder = ''): Promise<ImportResult & { files: number; skipped: string[] }> {
  if (!/^[^/\\\x00]+\.(lyx|zip)$/i.test(filename)) throw new Error('Choose a .lyx file or a .zip containing LyX documents');
  if (!data.length) throw new Error('No file received');
  const dest = folder ? resolveProjectPath(project, folder) : projectDir(project);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.mkdirSync(dest); // never replace an existing document, folder or project
  try {
    let skipped: string[] = [];
    if (/\.zip$/i.test(filename)) { skipped = extractZip(data, dest, { maxBytes: projectRoom(project) }).skipped; noteWritten(project, null); }
    else { assertRoom(project, data.length, 0, 'This file'); fs.writeFileSync(path.join(dest, filename), data); }
    const files = collect(dest, dest, [], 0).filter(f => f.kind !== 'dir');
    const lyx = files.filter(f => /\.lyx$/i.test(f.name));
    if (!lyx.length) throw new Error('The archive contains no .lyx documents');
    // Validate every source and collision before converting anything.
    const included = new Set<string>();
    for (const f of lyx) {
      const text = readLyxText(path.join(dest, f.path));
      const doc = parseLyx(text);
      if (!doc.format || !/^\\begin_body\r?$/m.test(text) || !/^\\end_document\r?$/m.test(text)) throw new Error(`${f.path} is not a complete LyX document`);
      if (fs.existsSync(path.join(dest, f.path.replace(/\.lyx$/i, '.tex')))) throw new Error(`${f.path}: a .tex file with the same name already exists in the archive`);
      for (const m of text.matchAll(/^filename "([^"]+\.lyx)"\r?$/gim)) included.add(path.normalize(path.join(path.dirname(f.path), m[1])));
    }
    const result: ImportResult & { files: number; skipped: string[] } = { id: '', created: [], warnings: [], graphics: [], files: files.length, skipped };
    const seen = new Set<string>();
    // Masters first: recursive import handles their children and keeps their relative paths.
    lyx.sort((a, b) => Number(included.has(a.path)) - Number(included.has(b.path)));
    for (const f of lyx) {
      const rel = folder ? path.join(folder, f.path) : f.path;
      if (seen.has(rel)) continue;
      const r = await importLyxFile(project, rel, toPdf, seen);
      if (!result.id) result.id = r.id;
      result.created.push(...r.created); result.warnings.push(...r.warnings); result.graphics.push(...r.graphics);
    }
    result.warnings.push(...result.graphics.filter(g => !g.ok).map(g => `${g.src}: ${g.error ?? 'could not convert graphic'}`));
    return result;
  } catch (e) {
    fs.rmSync(dest, { recursive: true, force: true });
    throw e;
  }
}
