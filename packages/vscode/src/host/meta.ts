/**
 * Document metadata for the editor webview — macros, labels, bibliography, layouts — the same
 * shape as the server's GET /api/docs/:id/meta (a port of that handler, without users/roles).
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  collectMacros, toMathliveMacros, parseBibtex, headerValue, getAuthors, getTextClass, getModules,
  paramMap, unquote, walkInsets, plainText, checkTexHealth,
  type LyxDocument,
} from '@overlyx/core';
import { loadDocumentClass, describeLayouts, flexInsetNames } from '@overlyx/core/latex/layouts.ts';
import { collectFiles, findMaster, isBackupFile, readTextFile } from './project.ts';
import { cachedParseFile, type TexContext } from './texdoc.ts';

export interface MetaInput {
  ctx: TexContext;
  project: string;
  relPath: string;
  /** the live document (the open editor's state), already parsed */
  lyx: LyxDocument;
  isChild: boolean;
  /** the current file text (for the health check); null when unknown */
  fileText: string | null;
}

const bibCache = new Map<string, { key: string; entries: ReturnType<typeof parseBibtex> }>();
function cachedBib(abs: string): ReturnType<typeof parseBibtex> {
  try {
    const st = fs.statSync(abs);
    const key = `${st.mtimeMs}:${st.size}`;
    const hit = bibCache.get(abs);
    if (hit && hit.key === key) return hit.entries;
    const entries = parseBibtex(fs.readFileSync(abs, 'utf8'));
    bibCache.set(abs, { key, entries });
    return entries;
  } catch { return []; }
}

export function bibEntriesFor(input: Pick<MetaInput, 'ctx' | 'relPath' | 'lyx'>): ReturnType<typeof parseBibtex> {
  const { bib } = scanBib(input.ctx, input.relPath, input.lyx);
  return bib;
}

function scanBib(ctx: TexContext, relPath: string, rootLyx: LyxDocument, alsoDoc?: LyxDocument) {
  const proj = ctx.root;
  const docDir = path.dirname(path.join(proj, relPath));
  const safe = (fn: string) => { const abs = path.resolve(docDir, fn); return abs.startsWith(proj) ? abs : null; };
  const texName = (fn: string) => (fn.endsWith('.tex') || fn.includes('.') ? fn : fn + '.tex');
  const bibFiles = new Set<string>();
  const citedKeys = new Set<string>();
  const scanned = new Set<string>([relPath]);
  const scan = (d: LyxDocument, depth: number) => {
    if (depth > 4) return;
    for (const { inset } of walkInsets(d.body)) {
      if (inset.type !== 'Leaf' || inset.name !== 'CommandInset') continue;
      const pm = paramMap(inset.params);
      if (inset.arg === 'bibtex') {
        for (const f of unquote(pm.get('bibfiles')).split(',')) if (f.trim()) bibFiles.add(f.trim());
      } else if (inset.arg === 'citation') {
        for (const k of unquote(pm.get('key')).split(',')) if (k.trim()) citedKeys.add(k.trim());
      } else if (inset.arg === 'include') {
        const fn = texName(unquote(pm.get('filename')));
        const abs = safe(fn);
        if (abs && fn.endsWith('.tex') && fs.existsSync(abs)) {
          const rel = path.relative(proj, abs);
          if (scanned.has(rel)) continue;
          scanned.add(rel);
          try { scan(cachedParseFile(ctx, rel).doc, depth + 1); } catch { /* ignore */ }
        }
      }
    }
  };
  scan(rootLyx, 0);
  if (alsoDoc) scan(alsoDoc, 0);
  const bib: ReturnType<typeof parseBibtex> = [];
  for (const f of bibFiles) {
    const abs = safe(f.endsWith('.bib') ? f : f + '.bib');
    if (abs && fs.existsSync(abs)) bib.push(...cachedBib(abs));
  }
  if (!bib.length) {
    for (const f of collectFiles(proj)) {
      if (f.kind === 'bib' && !isBackupFile(f.name)) bib.push(...cachedBib(path.join(proj, f.path)));
    }
  }
  const seen = new Set<string>();
  return { bib: bib.filter(e => (seen.has(e.key) ? false : (seen.add(e.key), true))), citedKeys };
}

export function buildMeta(input: MetaInput): Record<string, unknown> {
  const { ctx, project, relPath, lyx, isChild } = input;
  const proj = ctx.root;
  const masterRel = isChild ? findMaster(proj, relPath) : null;
  const masterId = masterRel ? `${project}/${masterRel}` : null;
  const readDoc = (rel: string): LyxDocument => cachedParseFile(ctx, rel).doc;
  const rootRel = masterRel ?? relPath;
  const rootLyx = masterRel ? readDoc(masterRel) : lyx;
  const docDir = path.dirname(path.join(proj, rootRel));
  const safe = (fn: string) => { const abs = path.resolve(docDir, fn); return abs.startsWith(proj) ? abs : null; };
  const texName = (fn: string) => (fn.endsWith('.tex') || fn.includes('.') ? fn : fn + '.tex');
  const includeDoc = (fn: string) => {
    const abs = safe(texName(fn));
    if (!abs || !abs.endsWith('.tex') || !fs.existsSync(abs)) return undefined;
    try { return readDoc(path.relative(proj, abs)); } catch { return undefined; }
  };
  const readFile = (fn: string) => { const abs = safe(fn); try { return abs ? fs.readFileSync(abs, 'utf8') : undefined; } catch { return undefined; } };

  const macros = collectMacros(rootLyx, { include: includeDoc, readFile });
  if (masterRel) macros.push(...collectMacros(lyx, { include: includeDoc, readFile }));

  // labels across the master tree (for the cross-reference dialog)
  const labels: { name: string; context: string; file: string }[] = [];
  const seenLabelFiles = new Set<string>();
  const collectLabels = (d: LyxDocument, rel: string, depth: number) => {
    if (depth > 4 || seenLabelFiles.has(rel)) return;
    seenLabelFiles.add(rel);
    const dir = path.dirname(path.join(proj, rel));
    for (const { inset, par } of walkInsets(d.body)) {
      if (inset.type === 'Leaf' && inset.name === 'CommandInset' && inset.arg === 'label') {
        labels.push({ name: unquote(paramMap(inset.params).get('name')), context: plainText([par]).slice(0, 80), file: rel });
      } else if (inset.type === 'Formula' && !inset.inline) {
        for (const m of inset.latex.matchAll(/\\label\{([^}]*)\}/g)) labels.push({ name: m[1], context: '(equation)', file: rel });
      } else if (inset.type === 'Leaf' && inset.name === 'CommandInset' && inset.arg === 'include') {
        const fn = texName(unquote(paramMap(inset.params).get('filename')));
        if (fn.endsWith('.tex')) {
          const abs = path.resolve(dir, fn);
          if (abs.startsWith(proj) && fs.existsSync(abs)) {
            try { collectLabels(readDoc(path.relative(proj, abs)), path.relative(proj, abs), depth + 1); } catch { /* ignore */ }
          }
        }
      }
    }
  };
  collectLabels(rootLyx, rootRel, 0);

  const { bib: bibAll, citedKeys } = scanBib(ctx, rootRel, rootLyx, masterRel ? lyx : undefined);
  const bibUnique = bibAll.length > 400 ? bibAll.filter(e => citedKeys.has(e.key)) : bibAll;

  let layouts: unknown = null;
  let flexInsets: unknown = null;
  try {
    const dc = loadDocumentClass(getTextClass(rootLyx), getModules(rootLyx), ctx.layoutDir, [proj, docDir]);
    layouts = describeLayouts(dc);
    flexInsets = dc.insetLayouts ? flexInsetNames(dc) : null;
  } catch { layouts = null; }

  const health = input.fileText === null ? [] : checkTexHealth(input.fileText, { isFragment: isChild });

  return {
    id: `${project}/${relPath}`, project, path: relPath, master: masterId,
    role: 'edit',
    labels,
    textclass: getTextClass(rootLyx), modules: getModules(rootLyx),
    language: headerValue(lyx.header, 'language') ?? 'english',
    useRefstyle: headerValue(lyx.header, 'use_refstyle') === '1',
    citeEngine: headerValue(lyx.header, 'cite_engine') ?? 'basic',
    citeEngineType: headerValue(lyx.header, 'cite_engine_type') ?? 'default',
    trackingChanges: headerValue(lyx.header, 'tracking_changes') === 'true',
    bibTotal: bibAll.length,
    secnumdepth: Number(headerValue(lyx.header, 'secnumdepth') ?? 3),
    tocdepth: Number(headerValue(lyx.header, 'tocdepth') ?? 3),
    authors: getAuthors(lyx.header),
    macros: toMathliveMacros(macros),
    macroList: macros.map(m => ({ name: m.name, args: m.args, def: m.def, display: m.display, source: m.source })),
    bib: bibUnique.slice(0, 30000).map(e => ({ key: e.key, author: e.authorShort, year: e.year, title: e.title })),
    layouts, flexInsets,
    files: collectFiles(proj),
    health,
  };
}

export { readTextFile };
