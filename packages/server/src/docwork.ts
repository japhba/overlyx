/**
 * The whole-document work on one document: its CRDT state as the document model, the model written
 * as .tex into the file's text, .tex text parsed in the document's context, a change on disk merged
 * in, the state loaded from a file. Plain computation on a Y.Doc and a few fields (no database, no
 * sockets), so the same code runs on the server's main thread (docs.ts) and in the document workers
 * (docworker.ts), which keep a mirror of every open document and do this work off the event loop.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as Y from 'yjs';
import { yDocToProsemirrorJSON } from 'y-prosemirror';
import { mergeLyx, pmToLyxBody, writeParagraphs, type LyxDocument, type PMJSON } from '@overlyx/core';
import { primePreserveCache, type PreserveCache } from '@overlyx/core/tex/index.ts';
import { projectDir } from './projectfiles.ts';
import { parseDocumentText, writeDocumentText, cachedParseFile } from './texdoc.ts';

/** a top-level paragraph's character range in the .tex text (null: it produced no output) */
export type SourceSpan = { start: number; end: number } | null;

export interface DocMeta {
  preamble: string[];
  format: number;
  headerLines: string[];
  trailer: string[];
}

export interface Rendered { text: string; files: Record<string, string>; spans: SourceSpan[] }

/** What the work needs of a document: an open document on the main thread, a mirror in a worker. */
export interface DocState {
  readonly id: string;
  readonly project: string;
  readonly relPath: string;
  readonly absPath: string;
  readonly ydoc: Y.Doc;
  /** the document has no preamble of its own (a child document / fragment) */
  isChild: boolean;
  /** what the file contained when it was last read or written: the base for merging external changes */
  fileText: string | null;
  /** the base text's parse and writer output between saves (writing into fileText keeps its unchanged LaTeX) */
  preserveCache: PreserveCache;
}

/** The other open documents, by id (a child document's live state is what the master includes). */
export type OpenDocs = (id: string) => DocState | undefined;

export function sha1(s: string): string { return crypto.createHash('sha1').update(s).digest('hex'); }

export function metaOf(ydoc: Y.Doc): DocMeta {
  const m = ydoc.getMap<string>('meta');
  const parse = (k: string, def: unknown) => { try { const v = m.get(k); return v ? JSON.parse(v) : def; } catch { return def; } };
  return {
    preamble: parse('preamble', ['#LyX 2.5 created this file. For more info see https://www.lyx.org/']),
    format: parse('format', 643),
    headerLines: parse('header', []),
    trailer: parse('trailer', []),
  };
}

/** The document model of a CRDT state. */
export function lyxDocumentOf(ydoc: Y.Doc): LyxDocument {
  const meta = metaOf(ydoc);
  const json = yDocToProsemirrorJSON(ydoc, 'prosemirror') as PMJSON;
  return { preamble: meta.preamble, format: meta.format, header: { lines: meta.headerLines }, body: pmToLyxBody(json), trailer: meta.trailer };
}

/** A child document (\\input / \\include) resolved from the live state of an open document, else parsed from disk. */
export function resolveInclude(s: DocState, filename: string, open: OpenDocs): LyxDocument | undefined {
  try {
    const proj = projectDir(s.project);
    const abs = path.resolve(path.dirname(s.absPath), filename.endsWith('.tex') || filename.includes('.') ? filename : filename + '.tex');
    if (!abs.startsWith(proj + path.sep) || !fs.existsSync(abs)) return undefined;
    const rel = path.relative(proj, abs);
    const child = open(`${s.project}/${rel}`);
    if (child) return lyxDocumentOf(child.ydoc);
    return cachedParseFile(s.project, rel).doc;
  } catch { return undefined; }
}

/** `doc` as .tex text written into the file's text (and the sidecar files it owns, and the source map). */
export function renderModel(s: DocState, doc: LyxDocument, open: OpenDocs): Rendered {
  const r = writeDocumentText(doc, s.project, s.relPath, s.isChild, (fn) => resolveInclude(s, fn, open), { base: s.fileText, cache: s.preserveCache });
  return { text: r.text, files: r.files, spans: r.spans };
}

/**
 * The current document as .tex text (plus the sidecar files it owns, e.g. sketch SVGs, and the
 * source map), written into the file's text: the paragraphs, preamble and managed block nobody
 * changed keep their LaTeX as it is on disk.
 */
export function renderDoc(s: DocState, open: OpenDocs): Rendered {
  return renderModel(s, lyxDocumentOf(s.ydoc), open);
}

/** Parse .tex text in the document's context (project layouts, master settings for children). */
export function parseFor(s: DocState, text: string): LyxDocument {
  const r = parseDocumentText(text, s.project, s.relPath);
  s.isChild = r.fragment;
  // the file's own parse is what the next save writes into: remember it
  if (text === s.fileText) primePreserveCache(s.preserveCache, text, r);
  return r.doc;
}

/**
 * Merge a change somebody else made to the file (desktop LyX, git, another editor) into the
 * state, three-way: only what changed on disk relative to what was last read / written
 * (`s.fileText`) is taken over; edits made here meanwhile in other paragraphs are kept. `load`
 * applies the result to the CRDT; `s.fileText` becomes `text`. Returns whether the document now
 * differs from the file (it has to be written), and the text it was compared as.
 */
export function mergeFileText(s: DocState, text: string, open: OpenDocs, load: (doc: LyxDocument) => void): { dirty: boolean; rendered?: Rendered } {
  const parsed = parseFor(s, text);
  const base = s.fileText !== null ? parseFor(s, s.fileText) : null;
  const merged = base ? mergeLyx(base, lyxDocumentOf(s.ydoc), parsed) : parsed;
  s.fileText = text;
  load(merged);
  if (!base) return { dirty: false };
  const rendered = renderDoc(s, open);
  return { dirty: sha1(rendered.text) !== sha1(text), rendered };
}

/**
 * The file (`text`, also `s.fileText`) loaded on top of the document's stored history (already
 * in `s.ydoc`; `sameFile`: it was stored for this very text). Returns a note on what was merged,
 * and whether the state now gives the file back exactly (otherwise the history is dropped and the
 * document is rebuilt from the file).
 */
export function loadOverStored(s: DocState, text: string, sameFile: boolean, open: OpenDocs, load: (doc: LyxDocument) => void): { ok: boolean; note?: string } {
  let note: string | undefined;
  try {
    if (!sameFile) {
      // the file changed while the document was not open (desktop LyX, git, a restart with a
      // changed file): merge it into the stored history as a diff, keeping the epoch, so that
      // clients holding a local copy of this history (offline edits) can still sync
      note = 'file changed since last persisted state — merging';
      load(parseFor(s, text));
    } else {
      const parsed = parseFor(s, text);   // also learns whether this is a child document
      // Same bytes, but a parser normalisation may structure them differently than the stored
      // state does (comment blocks merging into one TeX-Code inset; \begin{definition} becoming
      // a theorem layout once the parser learnt the document's \newtheorem): fold the new
      // structure into the stored history as a diff — the epoch survives, offline copies still
      // sync. Compared structurally — paragraph counts stay equal in most of these cases.
      if (writeParagraphs(parsed.body) !== writeParagraphs(lyxDocumentOf(s.ydoc).body)) {
        note = 'parser normalisation changed the structure — merging';
        load(parsed);
      }
    }
    // sanity: the state must produce exactly the file; otherwise rebuild from scratch
    return { ok: s.ydoc.getXmlFragment('prosemirror').length > 0 && sha1(renderDoc(s, open).text) === sha1(text), note };
  } catch { return { ok: false, note }; }
}
