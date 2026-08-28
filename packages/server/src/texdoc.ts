/**
 * .tex documents in the context of a project: parsing and writing with the project's own layout
 * files, the master's settings for child documents, and a cache of parsed files that are not open.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseTex, writeTex, importLyx, type ParseTexResult } from '@overlyx/core/tex/index.ts';
import type { LyxDocument } from '@overlyx/core';
import { config } from './config.ts';
import { projectDir, findMaster, resolveProjectPath } from './projects.ts';

/** A file read relative to a document, refusing to leave the project. */
export function readerFor(project: string, absDocPath: string): (name: string) => string | undefined {
  const proj = projectDir(project);
  const dir = path.dirname(absDocPath);
  return (name: string) => {
    try {
      const abs = path.resolve(dir, name);
      if (!abs.startsWith(proj + path.sep)) return undefined;
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > 8 * 1024 * 1024) return undefined;
      return fs.readFileSync(abs, 'utf8');
    } catch { return undefined; }
  };
}

const parseCache = new Map<string, { key: string; result: ParseTexResult }>();

/** Parse a .tex file that is not open (child documents, masters), cached by mtime + size. */
export function cachedParseFile(project: string, relPath: string, depth = 0): ParseTexResult {
  const abs = resolveProjectPath(project, relPath);
  const st = fs.statSync(abs);
  const key = `${st.mtimeMs}:${st.size}:${depth}`;
  const hit = parseCache.get(abs);
  if (hit && hit.key === key) return hit.result;
  const result = parseDocumentText(readTextFile(abs), project, relPath, depth);
  if (parseCache.size > 200) parseCache.clear();
  parseCache.set(abs, { key, result });
  return result;
}

/** Header lines of the master of a child document (its class, modules, settings), if it has one. */
export function masterHeaderFor(project: string, relPath: string, depth = 0): string[] | undefined {
  if (depth > 3) return undefined;
  const masterRel = findMaster(project, relPath);
  if (!masterRel) return undefined;
  try { return cachedParseFile(project, masterRel, depth + 1).doc.header.lines; } catch { return undefined; }
}

export function parseDocumentText(text: string, project: string, relPath: string, depth = 0): ParseTexResult {
  const abs = resolveProjectPath(project, relPath);
  const opts = { layoutDir: config.layoutDir, localDirs: [projectDir(project), path.dirname(abs)], readFile: readerFor(project, abs) };
  const first = parseTex(text, opts);
  if (!first.fragment) return first;
  const masterHeader = masterHeaderFor(project, relPath, depth);
  return masterHeader ? parseTex(text, { ...opts, masterHeader }) : first;
}

export function writeDocumentText(doc: LyxDocument, project: string, relPath: string, fragment: boolean, resolveInclude?: (filename: string) => LyxDocument | undefined): { text: string; warnings: string[] } {
  const abs = resolveProjectPath(project, relPath);
  const r = writeTex(doc, {
    layoutDir: config.layoutDir, localDirs: [projectDir(project), path.dirname(abs)], readFile: readerFor(project, abs),
    fragment, basename: path.basename(relPath, '.tex'), resolveInclude,
  });
  return { text: r.text, warnings: r.warnings };
}

/**
 * Read a text file. Files are UTF-8; one that is not valid UTF-8 (an old latin-1 file, a
 * corrupted one) is decoded as latin-1 rather than silently turned into U+FFFD characters that
 * would then be written back over the original bytes.
 */
export function readTextFile(absPath: string): string {
  const buf = fs.readFileSync(absPath);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch {
    console.warn(`[docs] ${absPath} is not valid UTF-8 — decoding as latin-1`);
    return buf.toString('latin1');
  }
}

/** Does the text look like something we may write back as a document? */
export function looksLikeDocument(text: string, fragment: boolean): boolean {
  if (fragment) return !text.includes('\0');
  return /\\begin\{document\}/.test(text) && /\\end\{document\}/.test(text);
}

/* -------------------------------------------------------------- import */

export interface ImportResult { id: string; created: string[]; warnings: string[]; graphics: { src: string; dest: string; ok: boolean; error?: string }[] }

/**
 * Import a .lyx file (and the child documents it includes) into .tex files next to them. The
 * .lyx files are left untouched. Graphics pdflatex cannot include are converted to PDF.
 */
export async function importLyxFile(project: string, relPath: string, toPdf: (src: string, dest: string) => Promise<void>, seen = new Set<string>()): Promise<ImportResult> {
  const abs = resolveProjectPath(project, relPath);
  const proj = projectDir(project);
  const dir = path.dirname(abs);
  const text = readTextFile(abs);
  const result: ImportResult = { id: `${project}/${relPath.replace(/\.lyx$/i, '.tex')}`, created: [], warnings: [], graphics: [] };
  seen.add(relPath);
  // children first (their .tex files must exist for the master's requirement collection)
  const children: string[] = [];
  for (const m of text.matchAll(/^filename "([^"]+\.lyx)"$/gm)) {
    const childAbs = path.resolve(dir, m[1]);
    if (!childAbs.startsWith(proj + path.sep) || !fs.existsSync(childAbs)) continue;
    const childRel = path.relative(proj, childAbs);
    if (seen.has(childRel)) continue;
    children.push(childRel);
  }
  for (const c of children) {
    const r = await importLyxFile(project, c, toPdf, seen);
    result.created.push(...r.created); result.warnings.push(...r.warnings); result.graphics.push(...r.graphics);
  }
  const isChild = !!findMaster(project, relPath) || isIncludedByAnyLyx(project, relPath);
  const { parseLyx } = await import('@overlyx/core');
  const r = importLyx(text, {
    layoutDir: config.layoutDir, localDirs: [proj, dir], readFile: readerFor(project, abs), fragment: isChild, sourceName: path.basename(relPath),
    resolveInclude: (fn) => { try { const p = path.resolve(dir, fn); if (!p.startsWith(proj + path.sep) || !fs.existsSync(p)) return undefined; return parseLyx(readTextFile(p)); } catch { return undefined; } },
  });
  const out = abs.replace(/\.lyx$/i, '.tex');
  fs.writeFileSync(out + '.overlyx-tmp', r.tex, 'utf8');
  fs.renameSync(out + '.overlyx-tmp', out);
  result.created.push(path.relative(proj, out));
  result.warnings.push(...r.warnings.map(w => `${path.basename(relPath)}: ${w}`));
  for (const g of r.graphics) {
    const src = path.resolve(dir, g.src), dest = path.resolve(dir, g.dest);
    if (!src.startsWith(proj + path.sep) || !dest.startsWith(proj + path.sep)) continue;
    if (!fs.existsSync(src)) { result.graphics.push({ src: g.src, dest: g.dest, ok: false, error: 'missing' }); continue; }
    if (fs.existsSync(dest)) { result.graphics.push({ src: g.src, dest: g.dest, ok: true }); continue; }
    try { fs.mkdirSync(path.dirname(dest), { recursive: true }); await toPdf(src, dest); result.graphics.push({ src: g.src, dest: g.dest, ok: true }); }
    catch (e) { result.graphics.push({ src: g.src, dest: g.dest, ok: false, error: String(e) }); }
  }
  return result;
}

/** Is this .lyx file included by another .lyx file of the project (a child document)? */
function isIncludedByAnyLyx(project: string, relPath: string): boolean {
  const proj = projectDir(project);
  const walk = (d: string, depth: number): boolean => {
    if (depth > 5) return false;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (walk(p, depth + 1)) return true; continue; }
      if (!e.name.endsWith('.lyx') || e.name.endsWith('~')) continue;
      const rel = path.relative(proj, p);
      if (rel === relPath) continue;
      let t: string;
      try { t = fs.readFileSync(p, 'utf8'); } catch { continue; }
      for (const m of t.matchAll(/^filename "([^"]+\.lyx)"$/gm)) {
        if (path.normalize(path.join(path.dirname(rel), m[1])) === relPath) return true;
      }
    }
    return false;
  };
  return walk(proj, 0);
}
