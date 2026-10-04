/**
 * A document worker (docpool.ts): mirrors of the open documents of the projects it serves, and the
 * whole-document work on them — the same functions the main thread would run (docwork.ts,
 * docedit.ts). Requests come one at a time; each first brings the mirrors up to date with the
 * updates the main thread sends along. An op that changes the document does so on the mirror and
 * answers with the CRDT update it made: the main thread applies that to the real document.
 */
import { parentPort } from 'node:worker_threads';
import * as Y from 'yjs';
import { prosemirrorJSONToYXmlFragment } from 'y-prosemirror';
import { itemText, lyxToPm, schema, type LyxDocument } from '@overlyx/core';
import type { PreserveCache } from '@overlyx/core/tex/index.ts';
import { applyLyxDocument } from './ydiff.ts';
import { parseDocumentText, looksLikeDocument } from './texdoc.ts';
import {
  lyxDocumentOf, renderDoc, renderModel, parseResultFor, mergeFileText, loadOverStored,
  type DocState, type Rendered,
} from './docwork.ts';
import { applyTrackedSource, applyPlainSource, restoreSource, foldEdits, replaceInSource, type EditableDoc } from './docedit.ts';
import type { DocInfo, SyncEntry, WorkerRequest, WorkerResponse } from './docpool.ts';

const mirrors = new Map<string, Mirror>();
/** top-level blocks per step of building a document from its file (fresh) */
const FRESH_STEP = 100;
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
  /** the parser's warnings for the texts parsed in this request */
  warnings = new Map<string, string[]>();
  /** counts the mirror's updates: the text made for one count holds while it stays (in one request) */
  private seq = 0;
  private memo: { seq: number; base: string | null; r: Rendered } | null = null;

  constructor(d: DocInfo) {
    this.id = d.id; this.project = d.project; this.relPath = d.relPath; this.absPath = d.absPath;
    this.ydoc.on('update', () => { this.seq++; });
  }

  parse(text: string): LyxDocument {
    const r = parseResultFor(this, text);
    this.warnings.set(text, r.warnings);
    return r.doc;
  }
  toLyxDocument(): LyxDocument { return lyxDocumentOf(this.ydoc); }
  /**
   * The document's text — made once per state and file text within a request (an agent's edit asks
   * for the text before it twice: what it edits, and what it reports as changed), as one synchronous
   * call after another gives the same text anyway.
   */
  render(): Rendered {
    const m = this.memo;
    if (m && m.seq === this.seq && m.base === this.fileText) return m.r;
    const r = renderDoc(this, lookup);
    this.memo = { seq: this.seq, base: this.fileText, r };
    return r;
  }
  toText(): string { return this.render().text; }
  textOf(doc: LyxDocument): string { return renderModel(this, doc, lookup).text; }
  loadFromLyx(doc: LyxDocument, origin: string): void { applyLyxDocument(this.ydoc, doc, origin); }

  /**
   * What an open document does after an edit, as far as the text goes: it saves, and the file
   * then holds what was written (the main thread writes `saved` — the same text).
   */
  edited(): void {
    const r = this.render();
    this.saved = r;
    if (r.text !== this.fileText && looksLikeDocument(r.text, this.isChild)) this.fileText = r.text;
  }

  /** the main thread's view of the document for this request (what an earlier one remembered is dropped) */
  take(a: { fileText?: string | null; isChild?: boolean }): this {
    if (a.fileText !== undefined) this.fileText = a.fileText;
    if (a.isChild !== undefined) this.isChild = a.isChild;
    this.memo = null;
    this.warnings.clear();
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
  render: (d, a) => mirrorOf(d).take(a).render(),

  /** the text and the paragraphs (MCP read_document) */
  read: (d, a) => {
    const m = mirrorOf(d).take(a);
    const lyx = m.toLyxDocument();
    return { text: m.toText(), paragraphs: lyx.body.map((p, i) => ({ index: i, layout: p.layout, depth: p.depth, text: p.items.map(itemText).join('') })) };
  },

  /** the CRDT state, for persisting it */
  state: (d) => Y.encodeStateAsUpdate(mirrorOf(d).ydoc),

  /** what a client with state vector `sv` lacks (sync step 2) */
  missing: (d, a) => Y.encodeStateAsUpdate(mirrorOf(d).ydoc, a.sv),

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

  /**
   * A document built from its file alone: answers with the whole state, and with the same as steps
   * of a hundred top-level blocks each — the main thread applies a big document's a step at a time
   * and serves other requests in between.
   */
  fresh: (d, a) => {
    if (!d) throw new Error('no document');
    mirrors.get(d.id)?.ydoc.destroy();
    const m = new Mirror(d);
    mirrors.set(d.id, m);
    m.fileText = a.text;
    const doc = m.parse(a.text);
    const pm = lyxToPm(doc) as { type: string; content?: unknown[] };
    const blocks = pm.content ?? [];
    const steps: Uint8Array[] = [];
    for (let k = FRESH_STEP; k < blocks.length; k += FRESH_STEP) {
      const { update } = capture(m, () => prosemirrorJSONToYXmlFragment(schema, { ...pm, content: blocks.slice(0, k) }, m.ydoc.getXmlFragment('prosemirror')));
      if (update) steps.push(update);
    }
    // the whole of it (the blocks so far are its first ones: the rest is appended) and its settings
    const { update } = capture(m, () => m.loadFromLyx(doc, 'file-load'));
    if (update) steps.push(update);
    return { steps, state: Y.encodeStateAsUpdate(m.ydoc), isChild: m.isChild };
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

  /**
   * An agent's edit of the source (docedit.ts), with the text the save right after it writes.
   * `before` null: the document's text now; `replace`: the edited text is `before` with a passage
   * replaced (docedit.ts replaceInSource — its EditError, e.g. a passage not found, is the answer).
   */
  edit: (d, a) => {
    const m = mirrorOf(d).take(a);
    m.retiredMacros = new Set(a.retired);
    m.saved = null;
    const before: string = a.before ?? m.toText();
    const after: string = a.replace ? replaceInSource(before, a.replace.oldText, a.replace.newText, a.replace.all) : a.after;
    const { value, update } = capture(m, () => a.kind === 'tracked' ? applyTrackedSource(m, before, after, a.author)
      : a.kind === 'plain' ? applyPlainSource(m, before, after)
      : { text: restoreSource(m, after) });
    return { result: value, warnings: m.warnings.get(after) ?? [], update, saved: m.saved, retired: [...m.retiredMacros], isChild: m.isChild };
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
    res = { id: req.id, ok: false, error: err?.message ?? String(e), stack: err?.stack, ...(err?.resync ? { resync: true } : {}) };
  }
  parentPort!.postMessage(res);
});
