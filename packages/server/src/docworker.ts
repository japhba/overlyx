/**
 * A document worker (docpool.ts): mirrors of the open documents of the projects it serves, and the
 * whole-document work on them — the same functions the main thread would run (docwork.ts,
 * docedit.ts). Requests come one at a time; each first brings the mirrors up to date with the
 * updates the main thread sends along. An op that changes the document does so on the mirror and
 * answers with the CRDT update it made: the main thread applies that to the real document.
 */
import { parentPort } from 'node:worker_threads';
import * as Y from 'yjs';
import { itemText, type LyxDocument } from '@overlyx/core';
import type { PreserveCache } from '@overlyx/core/tex/index.ts';
import { applyLyxDocument } from './ydiff.ts';
import { parseDocumentText, looksLikeDocument } from './texdoc.ts';
import {
  lyxDocumentOf, renderDoc, renderModel, parseFor, mergeFileText, loadOverStored,
  type DocState, type Rendered,
} from './docwork.ts';
import { applyTrackedSource, applyPlainSource, restoreSource, foldEdits, type EditableDoc } from './docedit.ts';
import type { DocInfo, SyncEntry, WorkerRequest, WorkerResponse } from './docpool.ts';

const mirrors = new Map<string, Mirror>();
const lookup = (id: string) => mirrors.get(id);

class Mirror implements DocState, EditableDoc {
  readonly ydoc = new Y.Doc({ gc: true });
  readonly id: string;
  readonly project: string;
  readonly relPath: string;
  readonly absPath: string;
  isChild = false;
  fileText: string | null = null;
  preserveCache: PreserveCache = {};
  retiredMacros = new Set<string>();
  /** what the save right after an edit writes (edited()) */
  saved: Rendered | null = null;

  constructor(d: DocInfo) {
    this.id = d.id; this.project = d.project; this.relPath = d.relPath; this.absPath = d.absPath;
  }

  parse(text: string): LyxDocument { return parseFor(this, text); }
  toLyxDocument(): LyxDocument { return lyxDocumentOf(this.ydoc); }
  toText(): string { return renderDoc(this, lookup).text; }
  textOf(doc: LyxDocument): string { return renderModel(this, doc, lookup).text; }
  loadFromLyx(doc: LyxDocument, origin: string): void { applyLyxDocument(this.ydoc, doc, origin); }

  /**
   * What an open document does after an edit, as far as the text goes: it saves, and the file
   * then holds what was written (the main thread writes `saved` — the same text).
   */
  edited(): void {
    const r = renderDoc(this, lookup);
    this.saved = r;
    if (r.text !== this.fileText && looksLikeDocument(r.text, this.isChild)) this.fileText = r.text;
  }

  /** the main thread's view of the document for this request */
  take(a: { fileText?: string | null; isChild?: boolean }): this {
    if (a.fileText !== undefined) this.fileText = a.fileText;
    if (a.isChild !== undefined) this.isChild = a.isChild;
    return this;
  }
}

/** Run `f` on the mirror and return the CRDT update it made (null: none). */
function capture<T>(m: Mirror, f: () => T): { value: T; update: Uint8Array | null } {
  const updates: Uint8Array[] = [];
  const on = (u: Uint8Array) => { updates.push(u); };
  m.ydoc.on('update', on);
  try {
    const value = f();
    return { value, update: updates.length === 0 ? null : updates.length === 1 ? updates[0] : Y.mergeUpdates(updates) };
  } finally { m.ydoc.off('update', on); }
}

function mirrorOf(d: DocInfo | null): Mirror {
  const m = d && mirrors.get(d.id);
  if (!m) throw Object.assign(new Error(`no mirror of ${d?.id}`), { resync: true });
  return m;
}

function sync(entries: SyncEntry[]): void {
  for (const e of entries) {
    try {
      let m = mirrors.get(e.doc.id);
      if (e.full) {
        mirrors.get(e.doc.id)?.ydoc.destroy();
        m = new Mirror(e.doc);
        mirrors.set(e.doc.id, m);
        Y.applyUpdate(m.ydoc, e.full);
      }
      if (!m) throw new Error(`no mirror of ${e.doc.id}`);
      if (e.updates.length) Y.applyUpdate(m.ydoc, e.updates.length === 1 ? e.updates[0] : Y.mergeUpdates(e.updates));
    } catch (err) {
      mirrors.get(e.doc.id)?.ydoc.destroy();
      mirrors.delete(e.doc.id);
      throw Object.assign(new Error(`mirror of ${e.doc.id} lost: ${String(err)}`), { resync: true });
    }
  }
}

type Args = Record<string, any>;

const ops: Record<string, (doc: DocInfo | null, a: Args) => unknown> = {
  /** the document as .tex text (+ sidecar files, source map) */
  render: (d, a) => renderDoc(mirrorOf(d).take(a), lookup),

  /** the text and the paragraphs (MCP read_document) */
  read: (d, a) => {
    const m = mirrorOf(d).take(a);
    const lyx = m.toLyxDocument();
    return { text: m.toText(), paragraphs: lyx.body.map((p, i) => ({ index: i, layout: p.layout, depth: p.depth, text: p.items.map(itemText).join('') })) };
  },

  /** the CRDT state, for persisting it */
  state: (d) => Y.encodeStateAsUpdate(mirrorOf(d).ydoc),

  /** a document opened on top of its stored history (`state`, which the main thread applied too) */
  open: (d, a) => {
    if (!d) throw new Error('no document');
    mirrors.get(d.id)?.ydoc.destroy();
    const m = new Mirror(d);
    mirrors.set(d.id, m);
    m.fileText = a.text;
    try { Y.applyUpdate(m.ydoc, a.state); } catch { mirrors.delete(d.id); return { ok: false }; }
    const { value, update } = capture(m, () => loadOverStored(m, a.text, a.sameFile, lookup, doc => m.loadFromLyx(doc, 'file-load')));
    if (!value.ok) { m.ydoc.destroy(); mirrors.delete(d.id); }
    return { ...value, update, isChild: m.isChild };
  },

  /** a document built from its file alone: answers with the whole state */
  fresh: (d, a) => {
    if (!d) throw new Error('no document');
    mirrors.get(d.id)?.ydoc.destroy();
    const m = new Mirror(d);
    mirrors.set(d.id, m);
    m.fileText = a.text;
    m.loadFromLyx(m.parse(a.text), 'file-load');
    return { state: Y.encodeStateAsUpdate(m.ydoc), isChild: m.isChild };
  },

  /** a change of the file on disk merged in (docs.ts absorbExternalChange) */
  absorb: (d, a) => {
    const m = mirrorOf(d).take(a);
    const { value, update } = capture(m, () => mergeFileText(m, a.text, lookup, doc => m.loadFromLyx(doc, 'file-load')));
    return { ...value, update, isChild: m.isChild };
  },

  /** LaTeX source loaded as the document (`asDoc`: parsed as the document's file is — a restored version; else as edited source) */
  load: (d, a) => {
    const m = mirrorOf(d).take(a);
    let warnings: string[] = [];
    const { update } = capture(m, () => {
      if (a.asDoc) { m.loadFromLyx(m.parse(a.text), a.origin); return; }
      const r = parseDocumentText(a.text, m.project, m.relPath);
      warnings = r.warnings;
      m.loadFromLyx(r.doc, a.origin);
    });
    return { update, warnings, isChild: m.isChild };
  },

  /** an agent's edit of the source (docedit.ts), with the text the save right after it writes */
  edit: (d, a) => {
    const m = mirrorOf(d).take(a);
    m.retiredMacros = new Set(a.retired);
    m.saved = null;
    const { value, update } = capture(m, () => {
      const warnings = a.warningsOf != null ? parseDocumentText(a.warningsOf, m.project, m.relPath).warnings : undefined;
      const result = a.kind === 'tracked' ? applyTrackedSource(m, a.before, a.after, a.author)
        : a.kind === 'plain' ? applyPlainSource(m, a.before, a.after)
        : { text: restoreSource(m, a.after) };
      return { result, warnings };
    });
    return { ...value, update, saved: m.saved, retired: [...m.retiredMacros], isChild: m.isChild };
  },

  /** another version of the document with the edits between two others carried over (docedit.ts foldEdits) */
  fold: (d, a) => foldEdits(mirrorOf(d).take(a), a.shadow, a.base, a.live),

  /** the warnings of parsing a source in the document's context */
  warnings: (d, a) => parseDocumentText(a.text, d!.project, d!.relPath).warnings,

  forget: (_d, a) => {
    for (const id of a.ids as string[]) { mirrors.get(id)?.ydoc.destroy(); mirrors.delete(id); }
    return null;
  },
};

parentPort!.on('message', (req: WorkerRequest) => {
  let res: WorkerResponse;
  try {
    sync(req.sync);
    const op = ops[req.op];
    if (!op) throw new Error(`unknown op ${req.op}`);
    res = { id: req.id, ok: true, result: op(req.doc, req.args as Args) };
  } catch (e) {
    const err = e as Error & { resync?: boolean };
    res = { id: req.id, ok: false, error: err?.stack ?? String(e), ...(err?.resync ? { resync: true } : {}) };
  }
  parentPort!.postMessage(res);
});
