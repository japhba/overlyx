/**
 * What the editor needs to know about a document besides its content (GET /api/docs/…/meta): its
 * class, layouts and modules, macros (with the master's and the children's), labels across the
 * master tree, the bibliography files it uses and the keys it cites, document settings, authors.
 * Computed from the document's state and the project's files — in a document
 * worker for an open document (docpool.ts; a big document's walk takes a while), else here.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  collectMacros, toMathliveMacros, getTextClass, getModules, getAuthors, headerValue, paramMap, unquote, walkInsets,
  walkParagraphs as walkParagraphsAll, plainText, type LyxDocument,
} from '@overlyx/core';
import { applyDocumentTheorems, loadDocumentClass, describeLayouts, flexInsetNames } from '@overlyx/core/latex/layouts.ts';
import { config } from './config.ts';
import { projectDir, findMaster } from './projectfiles.ts';
import { cachedParseFile } from './texdoc.ts';
import { lyxDocumentOf, type DocState, type OpenDocs } from './docwork.ts';

export interface DocumentMeta {
  master: string | null;
  labels: { name: string; context: string; file: string }[];
  /** bibliography files the document tree names (as written), and the keys it cites */
  bibFiles: string[];
  citedKeys: string[];
  textclass: string;
  modules: string[];
  language: string;
  useRefstyle: boolean;
  citeEngine: string;
  citeEngineType: string;
  trackingChanges: boolean;
  secnumdepth: number;
  tocdepth: number;
  authors: ReturnType<typeof getAuthors>;
  macros: ReturnType<typeof toMathliveMacros>;
  macroList: { name: string; args: number; def: string; display?: string; source?: string }[];
  layouts: unknown;
  flexInsets: unknown;
  /** where the time went (ms) */
  timings: Record<string, number>;
}

export function documentMeta(s: DocState, open: OpenDocs): DocumentMeta {
  const timings: Record<string, number> = {};
  let tPrev = performance.now();
  const lap = (name: string) => { const t = performance.now(); timings[name] = Math.round(t - tPrev); tPrev = t; };
  const lyx = lyxDocumentOf(s.ydoc);
  lap('toLyx');
  const proj = projectDir(s.project);
  // child documents inherit macros, bibliography and labels from their master
  const masterRel = findMaster(s.project, s.relPath);
  lap('findMaster');
  const readDoc = (rel: string): LyxDocument => {
    const o = open(`${s.project}/${rel}`);
    if (o) return lyxDocumentOf(o.ydoc);
    return cachedParseFile(s.project, rel).doc;
  };
  const rootRel = masterRel ?? s.relPath;
  const rootLyx = masterRel ? readDoc(masterRel) : lyx;
  const docDir = path.dirname(path.join(proj, rootRel));
  const safe = (fn: string) => { const abs = path.resolve(docDir, fn); return abs.startsWith(proj) ? abs : null; };
  const texName = (fn: string) => (fn.endsWith('.tex') || fn.includes('.') ? fn : fn + '.tex');
  const includeDoc = (fn: string) => { const abs = safe(texName(fn)); if (!abs || !abs.endsWith('.tex') || !fs.existsSync(abs)) return undefined; try { return readDoc(path.relative(proj, abs)); } catch { return undefined; } };
  const macros = collectMacros(rootLyx, {
    include: includeDoc,
    readFile: (fn) => { const abs = safe(fn); try { return abs ? fs.readFileSync(abs, 'utf8') : undefined; } catch { return undefined; } },
  });
  if (masterRel) {
    // the child's own macros come last (they override for the child's view)
    macros.push(...collectMacros(lyx, { include: includeDoc, readFile: (fn) => { const abs = safe(fn); try { return abs ? fs.readFileSync(abs, 'utf8') : undefined; } catch { return undefined; } } }, { includePreamble: false }));
  }
  lap('macros');
  // labels across the master tree (for the cross-reference dialog)
  const labels: { name: string; context: string; file: string }[] = [];
  const seenLabelFiles = new Set<string>();
  const collectLabels = (d: LyxDocument, rel: string, depth: number) => {
    if (depth > 4 || seenLabelFiles.has(rel)) return;
    seenLabelFiles.add(rel);
    const dir = path.dirname(path.join(proj, rel));
    for (const par of walkParagraphsAll(d.body)) {
      for (const it of par.items) {
        if (it.kind !== 'inset') continue;
        const ins = it.inset;
        if (ins.type === 'Leaf' && ins.name === 'CommandInset' && ins.arg === 'label') {
          labels.push({ name: unquote(paramMap(ins.params).get('name')), context: plainText([par]).slice(0, 80), file: rel });
        } else if (ins.type === 'Formula' && !ins.inline) {
          for (const m of ins.latex.matchAll(/\\label\{([^}]*)\}/g)) labels.push({ name: m[1], context: '(equation)', file: rel });
        } else if (ins.type === 'Leaf' && ins.name === 'CommandInset' && ins.arg === 'include') {
          const fn = texName(unquote(paramMap(ins.params).get('filename')));
          if (fn.endsWith('.tex')) {
            const abs = path.resolve(dir, fn);
            if (abs.startsWith(proj) && fs.existsSync(abs)) { try { collectLabels(readDoc(path.relative(proj, abs)), path.relative(proj, abs), depth + 1); } catch { /* ignore */ } }
          }
        }
      }
    }
  };
  collectLabels(rootLyx, rootRel, 0);
  lap('labels');
  // bibliography files referenced by bibtex insets (in this doc and children), and the keys cited
  const bibFiles = new Set<string>();
  const citedKeys = new Set<string>();
  const scanned = new Set<string>([rootRel, s.relPath]);
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
          if (scanned.has(rel)) continue;     // child documents may include each other (appendix ↔ macros file)
          scanned.add(rel);
          try { scan(readDoc(rel), depth + 1); } catch { /* ignore */ }
        }
      }
    }
  };
  scan(rootLyx, 0);
  if (masterRel) scan(lyx, 0);
  lap('bibscan');
  let layouts: unknown = null;
  let flexInsets: unknown = null;
  try {
    const L = lyx.header.lines, ps = L.indexOf('\\begin_preamble'), pe = L.indexOf('\\end_preamble');
    const userPre = ps >= 0 && pe > ps ? L.slice(ps + 1, pe).join('\n') : '';
    const dc = applyDocumentTheorems(loadDocumentClass(getTextClass(lyx), getModules(lyx), config.layoutDir, [proj, docDir]), userPre, config.layoutDir, [proj, docDir]);
    layouts = describeLayouts(dc);
    flexInsets = dc.insetLayouts ? flexInsetNames(dc) : null;
  } catch {
    layouts = null;
  }
  lap('layouts');
  return {
    master: masterRel ? `${s.project}/${masterRel}` : null,
    labels, bibFiles: [...bibFiles], citedKeys: [...citedKeys],
    textclass: getTextClass(lyx), modules: getModules(lyx),
    language: headerValue(lyx.header, 'language') ?? 'english',
    useRefstyle: headerValue(lyx.header, 'use_refstyle') === '1',
    citeEngine: headerValue(lyx.header, 'cite_engine') ?? 'basic',
    citeEngineType: headerValue(lyx.header, 'cite_engine_type') ?? 'default',
    trackingChanges: headerValue(lyx.header, 'tracking_changes') === 'true',
    secnumdepth: Number(headerValue(lyx.header, 'secnumdepth') ?? 3),
    tocdepth: Number(headerValue(lyx.header, 'tocdepth') ?? 3),
    authors: getAuthors(lyx.header),
    macros: toMathliveMacros(macros),
    macroList: macros.map(m => ({ name: m.name, args: m.args, def: m.def, display: m.display, source: m.source })),
    layouts, flexInsets, timings,
  };
}
