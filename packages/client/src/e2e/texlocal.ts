/**
 * What the server does with a document's text, done in the browser for end-to-end encrypted
 * projects: .tex / markdown parsed into the document model and written back (core tex/, md/), the
 * CRDT read and written (core collab/), and the document's metadata for the editor — layouts,
 * macros, labels, citations (the server's docmeta.ts and its /meta route). The core reads LyX's
 * library through `node:fs`, which is vfs.ts here: `ensureLyxLib` loads the library first.
 */
import * as Y from 'yjs';
import type { Node as PMNode } from 'prosemirror-model';
import {
  schema, pmToLyxBody, lyxToPmNode, collectMacros, toMathliveMacros, getTextClass, getModules, getAuthors, getPreamble, graphicsSearchDirs,
  headerValue, paramMap, unquote, walkInsets, walkParagraphs, plainText, parseBibtex, type LyxDocument,
} from '@overlyx/core';
import { Reader, writeDocument, markModel2 } from '@overlyx/core/collab/index.ts';
import { parseTex, writeTex, writeTexPreserving, type ParseTexResult, type PreserveCache } from '@overlyx/core/tex/index.ts';
import { applyDocumentTheorems, loadDocumentClass, describeLayouts, flexInsetNames, describeModules } from '@overlyx/core/latex/layouts.ts';
import { isMarkdownPath, MARKDOWN_LAYOUTS, parseMarkdown, writeMarkdown, writeMarkdownPreserving, markdownForLatex } from '@overlyx/core/md/index.ts';
import { mount, mounted } from './vfs';

export const LYX_LIB = '/lyx/lib';
export const LAYOUT_DIR = '/lyx/lib/layouts';

let loading: Promise<void> | null = null;
/** LyX's library in the virtual file system (once per page). */
export function ensureLyxLib(): Promise<void> {
  if (mounted(LAYOUT_DIR)) return Promise.resolve();
  return loading ??= (async () => {
    const st = await (await fetch('/api/e2e/status', { credentials: 'same-origin' })).json() as { lyxlib: string };
    const res = await fetch(`/api/e2e/lyxlib/${encodeURIComponent(st.lyxlib)}`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('LyX\'s layout files could not be loaded');
    const { files } = await res.json() as { files: Record<string, string> };
    mount(LYX_LIB, files);
  })().catch(e => { loading = null; throw e; });
}

/** What a document's text is read and written with: its place in the project, the project's other text files. */
export interface TexContext {
  /** project-relative */
  relPath: string;
  /** a project file's text by project-relative path (the decrypted text files of the project), or undefined */
  projectText: (rel: string) => string | undefined;
  /** the header lines of the master, for a child document */
  masterHeader?: string[];
}

const dirOf = (rel: string) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
/** a path relative to the document, project-relative (null when it leaves the project) */
export function projectRel(docRel: string, name: string): string | null {
  const parts: string[] = [];
  for (const s of `${dirOf(docRel)}/${name}`.split('/')) {
    if (!s || s === '.') continue;
    if (s === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(s);
  }
  return parts.join('/');
}
const reader = (ctx: TexContext) => (name: string) => { const r = projectRel(ctx.relPath, name); return r === null ? undefined : ctx.projectText(r); };

export function parseText(text: string, ctx: TexContext): ParseTexResult {
  if (isMarkdownPath(ctx.relPath)) { const r = parseMarkdown(text); return { doc: r.doc, warnings: r.warnings, fragment: true, sources: r.parSpans, bodyRange: null }; }
  const opts = { layoutDir: LAYOUT_DIR, localDirs: [], readFile: reader(ctx) };
  const first = parseTex(text, opts);
  if (!first.fragment || !ctx.masterHeader) return first;
  return parseTex(text, { ...opts, masterHeader: ctx.masterHeader });
}

export function writeText(doc: LyxDocument, ctx: TexContext, fragment: boolean, resolveInclude?: (fn: string) => LyxDocument | undefined, preserve?: { base: string | null; cache?: PreserveCache }): { text: string; warnings: string[] } {
  if (isMarkdownPath(ctx.relPath)) {
    const r = preserve ? writeMarkdownPreserving(doc, preserve.base) : writeMarkdown(doc);
    return { text: r.text, warnings: r.warnings };
  }
  const base = ctx.relPath.split('/').pop()!.replace(/\.tex$/, '');
  const opts = { layoutDir: LAYOUT_DIR, localDirs: [], readFile: reader(ctx), fragment, basename: base, resolveInclude };
  const r = preserve ? writeTexPreserving(doc, { base: preserve.base, cache: preserve.cache, write: d => writeTex(d, opts), parse: t => parseText(t, ctx) }) : writeTex(doc, opts);
  return { text: r.text, warnings: r.warnings };
}

/** A markdown document as a complete .tex file (what its PDF is built from). */
export function markdownTex(doc: LyxDocument, ctx: TexContext): string {
  return writeTex(markdownForLatex(doc, {}), { layoutDir: LAYOUT_DIR, localDirs: [], readFile: reader(ctx), basename: ctx.relPath.split('/').pop()!.replace(/\.[^.]+$/, '') }).text;
}

/* ------------------------------------------------------------------------- the CRDT */

export function readPm(ydoc: Y.Doc): PMNode { return new Reader(schema, ydoc).read(); }

interface Meta { preamble: string[]; format: number; headerLines: string[]; trailer: string[] }
function metaOf(ydoc: Y.Doc): Meta {
  const m = ydoc.getMap<string>('meta');
  const parse = (k: string, def: unknown) => { try { const v = m.get(k); return v ? JSON.parse(v) : def; } catch { return def; } };
  return { preamble: parse('preamble', ['#LyX 2.5 created this file. For more info see https://www.lyx.org/']), format: parse('format', 643), headerLines: parse('header', []), trailer: parse('trailer', []) };
}

/** The document model of a CRDT state. */
export function lyxDocumentOf(ydoc: Y.Doc): LyxDocument {
  const meta = metaOf(ydoc);
  return { preamble: meta.preamble, format: meta.format, header: { lines: meta.headerLines }, body: pmToLyxBody(readPm(ydoc)), trailer: meta.trailer };
}

/** Bring the CRDT to `doc` as the smallest change (server ydiff.ts applyLyxDocument). */
export function applyLyxDocument(ydoc: Y.Doc, doc: LyxDocument, origin?: unknown): void {
  ydoc.transact(() => {
    writeDocument(schema, ydoc, lyxToPmNode(doc));
    markModel2(ydoc);
    const m = ydoc.getMap<string>('meta');
    const set = (k: string, v: unknown) => { const s = JSON.stringify(v); if (m.get(k) !== s) m.set(k, s); };
    set('preamble', doc.preamble);
    set('format', doc.format);
    set('header', doc.header.lines);
    set('trailer', doc.trailer);
  }, origin);
}

/** A new document's first state, from its text. */
export function stateOfText(text: string, ctx: TexContext): { update: Uint8Array; fragment: boolean } {
  const r = parseText(text, ctx);
  const ydoc = new Y.Doc();
  applyLyxDocument(ydoc, r.doc);
  const update = Y.encodeStateAsUpdate(ydoc);
  ydoc.destroy();
  return { update, fragment: r.fragment };
}

export function ydocOf(update: Uint8Array): Y.Doc { const d = new Y.Doc(); Y.applyUpdate(d, update); return d; }

/* ------------------------------------------------------------------------- metadata */

export interface LocalProjectView {
  /** a document's model by project-relative path (open here, or fetched), undefined if none */
  doc: (rel: string) => LyxDocument | undefined;
  /** a text file's content by project-relative path */
  text: (rel: string) => string | undefined;
  /** the project's files (project-relative paths) */
  paths: string[];
}

const texName = (fn: string) => (fn.endsWith('.tex') || fn.includes('.') ? fn : fn + '.tex');

/** The master of a child document: the outermost document of the project that includes it (directly or through others). */
export function findMasterLocal(rel: string, view: LocalProjectView): string | null {
  const parents = new Map<string, string[]>();
  for (const p of view.paths) {
    if (!p.endsWith('.tex') || p === rel) continue;
    const d = view.doc(p);
    if (!d) continue;
    for (const { inset } of walkInsets(d.body)) {
      if (inset.type !== 'Leaf' || inset.name !== 'CommandInset' || inset.arg !== 'include') continue;
      const target = projectRel(p, texName(unquote(paramMap(inset.params).get('filename'))));
      if (target) parents.set(target, [...(parents.get(target) ?? []), p]);
    }
  }
  let cur = rel, master: string | null = null;
  const seen = new Set([rel]);
  for (let i = 0; i < 6; i++) {
    const p = (parents.get(cur) ?? []).find(x => !seen.has(x));
    if (!p) break;
    seen.add(p); master = cur = p;
  }
  return master;
}

export interface LocalMeta {
  format: 'tex' | 'markdown'; master: string | null; labels: { name: string; context: string; file: string }[]; bibFiles: string[]; citedKeys: string[];
  textclass: string; modules: string[]; language: string; useRefstyle: boolean; citeEngine: string; citeEngineType: string; trackingChanges: boolean;
  secnumdepth: number; tocdepth: number; authors: ReturnType<typeof getAuthors>; macros: ReturnType<typeof toMathliveMacros>;
  macroList: { name: string; args: number; def: string; display?: string; source?: string }[]; layouts: unknown; flexInsets: unknown; graphicsPath: string[];
  availableModules: ReturnType<typeof describeModules>;
  bib: { key: string; author: string; year: string; title: string }[]; bibTotal: number;
}

/** The server's documentMeta + /meta route, for a document of an encrypted project. */
export function documentMetaLocal(rel: string, lyx: LyxDocument, view: LocalProjectView): LocalMeta {
  const markdown = isMarkdownPath(rel);
  const masterRel = markdown ? null : findMasterLocal(rel, view);
  const rootRel = masterRel ?? rel;
  const rootLyx = masterRel ? view.doc(masterRel) ?? lyx : lyx;
  const inProject = (from: string, fn: string) => projectRel(from, fn);
  const includeDoc = (fn: string) => { const r = inProject(rootRel, texName(fn)); return r && r.endsWith('.tex') ? view.doc(r) : undefined; };
  const readFile = (fn: string) => { const r = inProject(rootRel, fn); return r === null ? undefined : view.text(r); };
  const macros = collectMacros(rootLyx, { include: includeDoc, readFile });
  if (masterRel) macros.push(...collectMacros(lyx, { include: includeDoc, readFile }, { includePreamble: false }));
  const labels: LocalMeta['labels'] = [];
  const seenLabels = new Set<string>();
  const collectLabels = (d: LyxDocument, r: string, depth: number) => {
    if (depth > 4 || seenLabels.has(r)) return;
    seenLabels.add(r);
    for (const par of walkParagraphs(d.body)) {
      for (const it of par.items) {
        if (it.kind !== 'inset') continue;
        const ins = it.inset;
        if (ins.type === 'Leaf' && ins.name === 'CommandInset' && ins.arg === 'label') labels.push({ name: unquote(paramMap(ins.params).get('name')), context: plainText([par]).slice(0, 80), file: r });
        else if (ins.type === 'Formula' && !ins.inline) for (const m of ins.latex.matchAll(/\\label\{([^}]*)\}/g)) labels.push({ name: m[1], context: '(equation)', file: r });
        else if (ins.type === 'Leaf' && ins.name === 'CommandInset' && ins.arg === 'include') {
          const c = inProject(r, texName(unquote(paramMap(ins.params).get('filename'))));
          const cd = c ? view.doc(c) : undefined;
          if (c && cd) collectLabels(cd, c, depth + 1);
        }
      }
    }
  };
  collectLabels(rootLyx, rootRel, 0);
  const bibFiles = new Set<string>(), citedKeys = new Set<string>();
  const scanned = new Set<string>([rootRel, rel]);
  const scan = (d: LyxDocument, depth: number) => {
    if (depth > 4) return;
    for (const { inset } of walkInsets(d.body)) {
      if (inset.type !== 'Leaf' || inset.name !== 'CommandInset') continue;
      const pm = paramMap(inset.params);
      if (inset.arg === 'bibtex') { for (const f of unquote(pm.get('bibfiles')).split(',')) if (f.trim()) bibFiles.add(f.trim()); }
      else if (inset.arg === 'citation') { for (const k of unquote(pm.get('key')).split(',')) if (k.trim()) citedKeys.add(k.trim()); }
      else if (inset.arg === 'include') {
        const c = inProject(rootRel, texName(unquote(pm.get('filename'))));
        if (!c || scanned.has(c)) continue;
        scanned.add(c);
        const cd = view.doc(c);
        if (cd) scan(cd, depth + 1);
      }
    }
  };
  scan(rootLyx, 0);
  if (masterRel) scan(lyx, 0);
  let layouts: unknown = null, flexInsets: unknown = null;
  try {
    const L = lyx.header.lines, ps = L.indexOf('\\begin_preamble'), pe = L.indexOf('\\end_preamble');
    const userPre = ps >= 0 && pe > ps ? L.slice(ps + 1, pe).join('\n') : '';
    const dc = applyDocumentTheorems(loadDocumentClass(getTextClass(lyx), getModules(lyx), LAYOUT_DIR, []), userPre, LAYOUT_DIR, []);
    layouts = describeLayouts(dc);
    if (markdown && Array.isArray(layouts)) layouts = (layouts as { name: string }[]).filter(l => MARKDOWN_LAYOUTS.includes(l.name));
    flexInsets = dc.insetLayouts ? flexInsetNames(dc) : null;
  } catch (e) { console.warn('[e2e] layouts:', e); }
  // the bibliography: the files the document names, else every .bib of the project
  const bibPaths = bibFiles.size
    ? [...bibFiles].map(f => inProject(rootRel, f.endsWith('.bib') ? f : f + '.bib')).filter((x): x is string => !!x)
    : view.paths.filter(p => p.endsWith('.bib'));
  const entries = bibPaths.flatMap(p => { const t = view.text(p); try { return t ? parseBibtex(t) : []; } catch { return []; } });
  const seen = new Set<string>();
  const all = entries.filter(e => (seen.has(e.key) ? false : (seen.add(e.key), true)));
  const bib = (all.length > 400 ? all.filter(e => citedKeys.has(e.key)) : all).slice(0, 30000).map(e => ({ key: e.key, author: e.authorShort, year: e.year, title: e.title }));
  return {
    format: markdown ? 'markdown' : 'tex',
    master: masterRel, labels, bibFiles: [...bibFiles], citedKeys: [...citedKeys],
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
    layouts, flexInsets,
    graphicsPath: graphicsSearchDirs(getPreamble(rootLyx), dirOf(rootRel)),
    availableModules: describeModules(LAYOUT_DIR, []),
    bib, bibTotal: all.length,
  };
}
