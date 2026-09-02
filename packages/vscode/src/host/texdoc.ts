/**
 * Parsing and writing .tex documents in the context of a project directory: the project's own
 * layout files, the master's settings for child documents, and a cache of parsed files that are
 * not open. Ported from the server's texdoc.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseTex, writeTex, type ParseTexResult } from '@overlyx/core/tex/index.ts';
import type { LyxDocument } from '@overlyx/core';
import { findMaster, readTextFile, resolveInside } from './project.ts';

export interface TexContext { root: string; layoutDir: string }

/** A file read relative to a document, refusing to leave the project. */
export function readerFor(ctx: TexContext, absDocPath: string): (name: string) => string | undefined {
  const dir = path.dirname(absDocPath);
  return (name: string) => {
    try {
      const abs = path.resolve(dir, name);
      if (!abs.startsWith(ctx.root + path.sep)) return undefined;
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > 8 * 1024 * 1024) return undefined;
      return fs.readFileSync(abs, 'utf8');
    } catch { return undefined; }
  };
}

const parseCache = new Map<string, { key: string; result: ParseTexResult }>();

/** Parse a .tex file that is not open (child documents, masters), cached by mtime + size. */
export function cachedParseFile(ctx: TexContext, relPath: string, depth = 0): ParseTexResult {
  const abs = resolveInside(ctx.root, relPath);
  const st = fs.statSync(abs);
  const key = `${st.mtimeMs}:${st.size}:${depth}`;
  const hit = parseCache.get(abs);
  if (hit && hit.key === key) return hit.result;
  const result = parseDocumentText(readTextFile(abs), ctx, relPath, depth);
  if (parseCache.size > 200) parseCache.clear();
  parseCache.set(abs, { key, result });
  return result;
}

/** Header lines of the master of a child document (its class, modules, settings), if it has one. */
export function masterHeaderFor(ctx: TexContext, relPath: string, depth = 0): string[] | undefined {
  if (depth > 3) return undefined;
  const masterRel = findMaster(ctx.root, relPath);
  if (!masterRel) return undefined;
  try { return cachedParseFile(ctx, masterRel, depth + 1).doc.header.lines; } catch { return undefined; }
}

export function parseDocumentText(text: string, ctx: TexContext, relPath: string, depth = 0): ParseTexResult {
  const abs = resolveInside(ctx.root, relPath);
  const opts = { layoutDir: ctx.layoutDir, localDirs: [ctx.root, path.dirname(abs)], readFile: readerFor(ctx, abs) };
  const first = parseTex(text, opts);
  if (!first.fragment) return first;
  const masterHeader = masterHeaderFor(ctx, relPath, depth);
  return masterHeader ? parseTex(text, { ...opts, masterHeader }) : first;
}

/** Parse a LaTeX fragment (pasted text) in a document's context: its own header drives the layouts. */
export function parseFragmentText(latex: string, ctx: TexContext, relPath: string, masterHeader: string[]): ParseTexResult {
  const abs = resolveInside(ctx.root, relPath);
  return parseTex(latex, { layoutDir: ctx.layoutDir, localDirs: [ctx.root, path.dirname(abs)], readFile: readerFor(ctx, abs), masterHeader });
}

export function writeDocumentText(doc: LyxDocument, ctx: TexContext, relPath: string, fragment: boolean, resolveInclude?: (filename: string) => LyxDocument | undefined): { text: string; warnings: string[] } {
  const abs = resolveInside(ctx.root, relPath);
  const r = writeTex(doc, {
    layoutDir: ctx.layoutDir, localDirs: [ctx.root, path.dirname(abs)], readFile: readerFor(ctx, abs),
    fragment, basename: path.basename(relPath, '.tex'), resolveInclude,
  });
  return { text: r.text, warnings: r.warnings };
}

/** Resolve a child document referenced by an include inset, for the writer's requirement scan. */
export function includeResolver(ctx: TexContext, relPath: string): (filename: string) => LyxDocument | undefined {
  const dir = path.dirname(resolveInside(ctx.root, relPath));
  return (fn: string) => {
    try {
      const name = fn.endsWith('.tex') || fn.includes('.') ? fn : fn + '.tex';
      const abs = path.resolve(dir, name);
      if (!abs.startsWith(ctx.root + path.sep) || !abs.endsWith('.tex') || !fs.existsSync(abs)) return undefined;
      return cachedParseFile(ctx, path.relative(ctx.root, abs)).doc;
    } catch { return undefined; }
  };
}
