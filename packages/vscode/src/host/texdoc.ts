/**
 * Parsing and writing .tex documents in the context of a project directory: the project's own
 * layout files, the master's settings for child documents, and a cache of parsed files that are
 * not open. Ported from the server's texdoc.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseTex, writeTex, writeTexPreserving, type ParseTexResult, type PreserveCache } from '@overlyx/core/tex/index.ts';
import { layoutTemplate, setHeaderValue, markEditedSettings, type LyxDocument } from '@overlyx/core';
import { parseMarkdown, writeMarkdown, writeMarkdownPreserving, isMarkdownPath, markdownForLatex, type MarkdownPreserveCache } from '@overlyx/core/md/index.ts';
import { findMaster, readTextFile, resolveInside } from './project.ts';

export interface TexContext { root: string; layoutDir: string; /** Unsaved text in an open VS Code document. */ readText?: (absolutePath: string) => string | undefined }

/** A file read relative to a document, refusing to leave the project. */
export function readerFor(ctx: TexContext, absDocPath: string): (name: string) => string | undefined {
  const dir = path.dirname(absDocPath);
  return (name: string) => {
    try {
      const abs = path.resolve(dir, name);
      if (!abs.startsWith(ctx.root + path.sep)) return undefined;
      const open = ctx.readText?.(abs);
      if (open !== undefined) return open;
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
  const open = ctx.readText?.(abs);
  if (open !== undefined) return parseDocumentText(open, ctx, relPath, depth);
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

/**
 * Do two texts describe the same document? VS Code touches the text we wrote when the file is
 * saved (trailing whitespace trimmed, a final newline added, line endings): the parsed model is
 * unchanged, and pushing it back into the editor would only undo whatever was typed meanwhile.
 */
export function sameDocumentText(a: string, b: string, ctx: TexContext, relPath: string): boolean {
  if (a === b) return true;
  if (a.replace(/\s+/g, '') !== b.replace(/\s+/g, '')) return false;   // cheap: only whitespace may differ
  try {
    const pa = parseDocumentText(a, ctx, relPath), pb = parseDocumentText(b, ctx, relPath);
    return JSON.stringify(pa.doc.body) === JSON.stringify(pb.doc.body) && JSON.stringify(pa.doc.header.lines) === JSON.stringify(pb.doc.header.lines) && pa.doc.preamble.join('\n') === pb.doc.preamble.join('\n');
  } catch { return false; }
}

export function parseDocumentText(text: string, ctx: TexContext, relPath: string, depth = 0): ParseTexResult {
  // a markdown document (core md/): no preamble of its own, no master
  if (isMarkdownPath(relPath)) { const r = parseMarkdown(text); return { doc: r.doc, warnings: r.warnings, fragment: true, sources: r.parSpans, bodyRange: null }; }
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

/**
 * The document as .tex text. With `preserve`, written into the text the file holds now (`base`):
 * what did not change keeps its LaTeX byte for byte (core tex/preserve.ts), as the server saves.
 */
export function writeDocumentText(doc: LyxDocument, ctx: TexContext, relPath: string, fragment: boolean, resolveInclude?: (filename: string) => LyxDocument | undefined, preserve?: { base: string | null; cache?: PreserveCache }): { text: string; warnings: string[]; files: Record<string, string>; spans: ({ start: number; end: number } | null)[] } {
  if (isMarkdownPath(relPath)) {
    let cache: MarkdownPreserveCache | undefined;
    if (preserve?.cache) { cache = mdCaches.get(preserve.cache); if (!cache) mdCaches.set(preserve.cache, cache = {}); }
    const r = preserve ? writeMarkdownPreserving(doc, preserve.base, cache) : writeMarkdown(doc);
    return { text: r.text, warnings: r.warnings, files: {}, spans: r.spans };
  }
  const abs = resolveInside(ctx.root, relPath);
  const opts = {
    layoutDir: ctx.layoutDir, localDirs: [ctx.root, path.dirname(abs)], readFile: readerFor(ctx, abs),
    fragment, basename: path.basename(relPath, '.tex'), resolveInclude,
  };
  const r = preserve
    ? writeTexPreserving(doc, { base: preserve.base, cache: preserve.cache, write: d => writeTex(d, opts), parse: t => parseDocumentText(t, ctx, relPath) })
    : writeTex(doc, opts);
  return { text: r.text, warnings: r.warnings, files: r.files, spans: r.spans };
}

/** a markdown document's parse of the file text between saves (the counterpart of the .tex PreserveCache) */
const mdCaches = new WeakMap<PreserveCache, MarkdownPreserveCache>();

/** A markdown document as a complete .tex file, for its PDF (built with LuaLaTeX). */
export function markdownAsTex(doc: LyxDocument, ctx: TexContext, relPath: string): string {
  const abs = resolveInside(ctx.root, relPath);
  return writeTex(markdownForLatex(doc), { layoutDir: ctx.layoutDir, localDirs: [ctx.root, path.dirname(abs)], readFile: readerFor(ctx, abs), basename: path.basename(relPath).replace(/\.[^.]+$/, '') }).text;
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

/**
 * A new layout document (slides, poster, page; core layout/templates.ts) written through the .tex
 * writer, so its managed block (the layout macros, the page size) is there before the first edit
 * and the file compiles right away — what the server's newLayoutDocumentText writes.
 */
export function newLayoutDocumentText(ctx: TexContext, relPath: string, preset: string, opts: { title?: string; author?: string }): string {
  const tpl = layoutTemplate(preset, opts);
  const doc = parseDocumentText(tpl.text, ctx, relPath).doc;
  const before = [...doc.header.lines];
  for (const [k, v] of Object.entries(tpl.settings)) setHeaderValue(doc.header, k, v);
  doc.header.lines = markEditedSettings(before, doc.header.lines, Object.keys(tpl.settings));
  return writeDocumentText(doc, ctx, relPath, false).text;
}
