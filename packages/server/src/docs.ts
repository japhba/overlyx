/**
 * Document manager: keeps one Y.Doc per open .tex document, persists Yjs state in SQLite,
 * writes the .tex file back to disk (debounced) and reloads it when it changes externally
 * (git, another editor). Also manages named/automatic versions.
 *
 * The whole-document work — making the text of a save, parsing, merging an external change or an
 * agent's edit — is done by the document workers (docpool.ts) on their mirrors of the documents,
 * so that one document's work never stalls the server for everybody; this module keeps the CRDT,
 * the files and the database, and does every step that changes a document in order (`exclusive`).
 * Without workers (OVERLYX_DOC_WORKERS=0, the tests) the same work runs here, synchronously.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import chokidar, { type FSWatcher } from 'chokidar';
import { isProjectKey, splitDocId, itemText, type LyxDocument } from '@overlyx/core';
import { checkTexHealth, repairTex, type HealthIssue, type PreserveCache } from '@overlyx/core/tex/index.ts';
import { db } from './db.ts';
import { config } from './config.ts';
import { listProjects, resolveProjectPath, projectDir, type ProjectFile } from './projects.ts';
import { applyLyxDocument } from './ydiff.ts';
import { readTextFile, looksLikeDocument, parseDocumentText } from './texdoc.ts';
import { sha1, metaOf, lyxDocumentOf, renderDoc, renderModel, parseFor, mergeFileText, loadOverStored, type DocState, type DocMeta, type Rendered, type SourceSpan } from './docwork.ts';
import { DocWorkers, WorkerGone, MirrorLost, type SyncEntry } from './docpool.ts';
import { documentMeta, type DocumentMeta } from './docmeta.ts';
import { applyTrackedSource, applyPlainSource, restoreSource, foldEdits, replaceInSource, type EditableDoc, type TrackedResult } from './docedit.ts';

export type { SourceSpan, DocMeta };
export { readTextFile, looksLikeDocument };
/** @deprecated name kept for older call sites */
export const readLyxFile = readTextFile;

/** the document workers (docpool.ts) */
export const docWorkers = new DocWorkers(config.docWorkers);

export class OpenDoc implements DocState, EditableDoc {
  ydoc = new Y.Doc({ gc: true });
  awareness: awarenessProtocol.Awareness;
  conns = new Map<import('ws').WebSocket, Set<number>>();
  /** which account is behind each connection (to close them when access is revoked) */
  connUsers = new Map<import('ws').WebSocket, number>();
  fileHash = '';
  /** what the file contained when it was last read or written: the base for merging external changes */
  fileText: string | null = null;
  /** the base text's parse and writer output between saves (writing into fileText keeps its unchanged LaTeX) */
  preserveCache: PreserveCache = {};
  /** the file was deleted on disk (see DocManager.onExternalRemove): nothing is written until it is back */
  fileMissing = false;
  /** identifies this Yjs history; a fresh Y.Doc (after a restart with a changed file) gets a new one */
  epoch = crypto.randomBytes(8).toString('hex');
  private saveTimer: NodeJS.Timeout | null = null;
  private persistTimer: NodeJS.Timeout | null = null;
  private unloadTimer: NodeJS.Timeout | null = null;
  /** saves running or waiting for their turn */
  private saves = 0;
  dirty = false;
  lastAutoVersion = 0;
  /** the document has no preamble of its own (a child document / fragment) */
  isChild = false;
  /** what the .tex file on disk contains: state vector of the Y.Doc when it was last written / read */
  lastSavedSV: Uint8Array = Y.encodeStateVector(this.ydoc);
  lastSavedSnapshot: Uint8Array = Y.encodeSnapshot(Y.snapshot(this.ydoc));
  lastSavedAt = 0;
  /** notified after every successful save (the WebSocket layer tells the clients) */
  savedListeners = new Set<() => void>();
  /** accounts whose edits were written to the file since the last time somebody asked (git commits) */
  editors = new Set<number>();
  /** commands this document defined itself until an agent's edit renamed or removed them (docedit.ts: their struck-out uses would not compile) */
  retiredMacros = new Set<string>();
  /** counts the CRDT's updates: work done for one count is current as long as it stays */
  updateSeq = 0;
  /** the update count the last successful save started from */
  private savedSeq = -1;
  /** the update count of the state last persisted */
  private persistedSeq = -1;
  /** the document's mirror in a document worker: which worker (and its generation), the updates not sent there yet */
  wsync = { slot: -1, gen: -1, pending: [] as Uint8Array[] };
  /** text a worker made for exactly this state (`seq`) written into `base`: the next save writes it as it is */
  private prepared: { seq: number; base: string | null; r: Rendered } | null = null;
  /** the changes of the document (saves, merges, agents' edits) one after the other */
  private queue: Promise<unknown> = Promise.resolve();
  /** when the last save ended and how long it took (ms): a slow one makes the next wait longer */
  private lastSaveEnd = 0;
  private lastSaveCost = 0;
  /** dropped from memory: work still under way is discarded */
  disposed = false;

  constructor(public id: string, public project: string, public relPath: string, public absPath: string) {
    this.awareness = new awarenessProtocol.Awareness(this.ydoc);
    this.awareness.setLocalState(null);
  }

  /**
   * From now on every update counts, and goes to the worker's mirror with the next request. Called
   * once the document is loaded: the state it was loaded with is the mirror's already, and without
   * a listener Yjs does not encode it again (a big document's takes a while).
   */
  trackUpdates(): void {
    this.ydoc.on('update', (u: Uint8Array) => {
      this.updateSeq++;
      if (this.wsync.slot >= 0 && docWorkers.enabled) this.wsync.pending.push(u);
    });
  }

  get fragment(): Y.XmlFragment { return this.ydoc.getXmlFragment('prosemirror'); }
  get meta(): Y.Map<string> { return this.ydoc.getMap<string>('meta'); }

  /** the whole-document work runs in a document worker (else here) */
  get usesWorker(): boolean { return docWorkers.enabled; }
  /** a save is running or waiting */
  get saving(): boolean { return this.saves > 0; }

  getMeta(): DocMeta { return metaOf(this.ydoc); }

  setMetaFrom(doc: LyxDocument): void {
    const m = this.meta;
    m.set('preamble', JSON.stringify(doc.preamble));
    m.set('format', JSON.stringify(doc.format));
    m.set('header', JSON.stringify(doc.header.lines));
    m.set('trailer', JSON.stringify(doc.trailer));
  }

  /** Current document as the document model (from the CRDT state). */
  toLyxDocument(): LyxDocument { return lyxDocumentOf(this.ydoc); }

  /**
   * Current document as .tex text (plus the sidecar files it owns, e.g. sketch SVGs, and the source
   * map), written into the file's text: the paragraphs, preamble and managed block nobody changed
   * keep their LaTeX as it is on disk. Here, on the main thread: renderAsync is the same in a worker.
   */
  protected render(): Rendered { return renderDoc(this, openDocs); }

  /** The same as render(), made by the document worker. */
  async renderAsync(): Promise<Rendered> {
    if (!this.usesWorker) return this.render();
    return await inWorker(this, 'render', { fileText: this.fileText, isChild: this.isChild }) as Rendered;
  }

  /** Current document as .tex text. */
  toText(): string { return this.render().text; }
  async textAsync(): Promise<string> { return (await this.renderAsync()).text; }

  /** Another version of this document (parsed, e.g. a merge result) as .tex text, written the way toText writes the current one. */
  textOf(doc: LyxDocument): string { return renderModel(this, doc, openDocs).text; }

  /** Current document as .tex text with its source map: the character range of every top-level paragraph (the source pane's cursor / scroll sync). */
  toTextMap(): { text: string; spans: SourceSpan[] } {
    const r = this.render();
    return { text: r.text, spans: r.spans };
  }
  async textMapAsync(): Promise<{ text: string; spans: SourceSpan[] }> {
    const r = await this.renderAsync();
    return { text: r.text, spans: r.spans };
  }

  /**
   * Write the document's sidecar files (sketch SVGs regenerated from the CRDT state). Only .svg
   * files inside the project are written, and only when their content actually changed — the
   * generator is deterministic, so an untouched drawing never dirties the git history.
   */
  private writeSidecars(files: Record<string, string>): void {
    const proj = projectDir(this.project);
    const dir = path.dirname(this.absPath);
    for (const [rel, content] of Object.entries(files)) {
      if (!rel.endsWith('.svg')) continue;
      try {
        const abs = path.resolve(dir, rel);
        if (!abs.startsWith(proj + path.sep)) continue;
        try { if (fs.readFileSync(abs, 'utf8') === content) continue; } catch { /* new file */ }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
      } catch (e) { console.error('sidecar write failed', this.id, rel, e); }
    }
  }

  /**
   * Structural health of the file as it stands on disk (or last read/written): whether an
   * external edit broke the OverLyX conventions the parser silently papers over otherwise.
   * `fileText === null` (never loaded) means nothing to check yet.
   */
  health(): HealthIssue[] {
    return this.fileText === null ? [] : checkTexHealth(this.fileText, { isFragment: this.isChild });
  }

  /**
   * Snapshots the current file as a version, then loads `text` like any external change and writes
   * it to the file as it is (the reviewed text: a save writes into the file's text, so the repair
   * must be in the file, not only in the document).
   */
  private applyRepairedText(text: string, versionName: string): void {
    this.snapshot(versionName, this.fileText ?? '');
    this.absorbExternalChange(text);
    this.writeText(text);
    this.dirty = true;
    void this.saveToFile();
  }

  /**
   * Mends the mechanically-fixable issues (managed-block markers) in the file on disk.
   * Returns the remaining (non-mechanically-fixable) issues.
   */
  repair(): { fixed: HealthIssue['code'][]; remaining: HealthIssue[] } {
    const issues = this.health();
    const { text, fixed } = repairTex(this.fileText ?? '', issues);
    if (fixed.length) this.applyRepairedText(text, 'before repair');
    return { fixed, remaining: this.health() };
  }

  /**
   * Applies a fix proposed by "Escalate to AI" once the user has reviewed it in the merge editor.
   * `expectedOriginal` must match the file text the proposal was generated from — otherwise the
   * file changed underneath it (another save, another editor) and applying it blindly could
   * silently discard that change.
   */
  applyAiRepair(text: string, expectedOriginal: string): { ok: true; remaining: HealthIssue[] } | { ok: false; error: string } {
    if ((this.fileText ?? '') !== expectedOriginal) return { ok: false, error: 'The file changed since this repair was proposed — reload and try again.' };
    this.applyRepairedText(text, 'before AI repair');
    return { ok: true, remaining: this.health() };
  }
  /** @deprecated use toText() */
  toLyxText(): string { return this.toText(); }

  /** Parse .tex text in this document's context (project layouts, master settings for children). */
  parse(text: string): LyxDocument { return parseFor(this, text); }

  /**
   * Load a LyX document into the CRDT (initial load, external change, restore). Applied as a diff:
   * unchanged paragraphs keep their identity so that concurrent / offline edits in them survive.
   */
  loadFromLyx(doc: LyxDocument, origin: string): void {
    applyLyxDocument(this.ydoc, doc, origin);
    if (origin === 'file-load') this.markSaved();
  }

  /** An edit changed the document (docedit.ts): save it. */
  edited(): void {
    this.dirty = true;
    void this.saveToFile();
  }

  /** The file on disk now corresponds to the current state. */
  markSaved(): void {
    this.lastSavedSV = Y.encodeStateVector(this.ydoc);
    this.lastSavedSnapshot = Y.encodeSnapshot(Y.snapshot(this.ydoc));
    this.lastSavedAt = Date.now();
    for (const l of this.savedListeners) { try { l(); } catch { /* ignore */ } }
  }

  /** when the current debounce window started (0 = none): continuous typing must not starve the save */
  private saveWindowStart = 0;
  private persistWindowStart = 0;

  scheduleSave(): void {
    this.dirty = true;
    const now = Date.now();
    // Debounce, but with a maximum wait: while several users type continuously the debounce timer
    // would be reset on every keystroke and the file would never be written (nor the state persisted).
    if (!this.saveWindowStart) this.saveWindowStart = now;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    let saveDelay = Math.max(0, Math.min(config.saveDebounceMs, this.saveWindowStart + config.saveMaxWaitMs - now));
    // A document whose save takes long (a big one: seconds of a document worker's time) is saved at
    // most every other such period while people type in it, so that the worker has time for the
    // other documents it serves; a small one's saves take milliseconds and are not held back.
    saveDelay = Math.max(saveDelay, this.lastSaveEnd + Math.min(this.lastSaveCost, config.saveMaxWaitMs) - now);
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.saveWindowStart = 0; this.saveFromTimer(); }, saveDelay);
    if (!this.persistWindowStart) this.persistWindowStart = now;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    const persistDelay = Math.max(0, Math.min(800, this.persistWindowStart + config.persistMaxWaitMs - now));
    this.persistTimer = setTimeout(() => { this.persistTimer = null; this.persistWindowStart = 0; void this.persistStateAsync(); }, persistDelay);
  }

  /** The debounced save: after the one under way (if any); none when nothing changed since the last one. */
  private saveFromTimer(): void {
    if (this.disposed) return;
    if (this.saving) { this.scheduleSave(); return; }
    if (this.usesWorker && this.savedSeq === this.updateSeq && !this.saveError) {
      // nothing changed since the last save (it wrote this very state): only look for a change on disk
      this.dirty = false;
      void this.exclusive(() => this.absorbLocked()).catch(e => console.error('reload failed', this.id, e));
      return;
    }
    void this.saveToFile();
  }

  persistState(): void {
    const state = Y.encodeStateAsUpdate(this.ydoc);
    this.persistedSeq = this.updateSeq;
    this.writeState(state);
  }

  /** Persist a state made elsewhere (a worker built it): it must be the document's current one. */
  persistStateBytes(state: Uint8Array): void {
    this.persistedSeq = this.updateSeq;
    this.writeState(state);
  }

  private writeState(state: Uint8Array): void {
    db.prepare('INSERT INTO ydocs (id, state, file_hash, updated_at, epoch) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state, file_hash=excluded.file_hash, updated_at=excluded.updated_at, epoch=excluded.epoch')
      .run(this.id, Buffer.from(state.buffer, state.byteOffset, state.byteLength), this.fileHash, Date.now(), this.epoch);
  }

  /** persistState with the state encoded by the document worker (a big document's takes a while) */
  async persistStateAsync(): Promise<void> {
    if (this.disposed) return;
    if (!this.usesWorker) { this.persistState(); return; }
    const seq = this.updateSeq;
    let state: Uint8Array;
    try { state = await inWorker(this, 'state', {}) as Uint8Array; }
    catch (e) { console.error('persist failed in the worker, persisting here', this.id, e); if (!this.disposed) this.persistState(); return; }
    // a newer state may have been persisted meanwhile (persistState): never go back to an older one
    if (this.disposed || seq < this.persistedSeq) return;
    this.persistedSeq = seq;
    this.writeState(state);
  }

  /** last save error (cleared by a successful save); a retry is scheduled */
  saveError: string | null = null;
  private retryTimer: NodeJS.Timeout | null = null;

  /** Run the steps that change the document (and its file) one at a time, in the order asked. */
  private exclusive<T>(f: () => Promise<T>): Promise<T> {
    const run = this.queue.then(f, f);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Merge a change somebody else made to the file on disk (desktop LyX, git, another editor)
   * into the CRDT — as a diff, so that unsaved edits in untouched paragraphs survive. Returns
   * true when the file had changed. `text` may be passed by the watcher; otherwise the file is read.
   * (Synchronous, on the main thread: absorbExternalChangeAsync is the same in the worker.)
   */
  absorbExternalChange(text?: string): boolean {
    const t = this.changedFileText(text);
    if (t === null) return false;
    console.log(`[docs] external change detected: ${this.id} — merging`);
    const hash = sha1(t);
    const fileTextBefore = this.fileText;
    // three-way: only what changed on disk (relative to what we last read / wrote) is taken over;
    // edits made here meanwhile in other paragraphs are kept (they are saved right after)
    const { dirty } = mergeFileText(this, t, openDocs, doc => {
      this.fileHash = hash;
      knownHashes.set(this.absPath, hash);
      this.loadFromLyx(doc, 'file-load');
    });
    if (fileTextBefore !== null && dirty) this.dirty = true;   // ours differs from the disk: write it
    this.persistState();
    return true;
  }

  /** The file's text when it changed since it was last read or written (by somebody else); else null. */
  private changedFileText(text?: string): string | null {
    if (text === undefined) {
      try { text = readTextFile(this.absPath); } catch { return null; }   // missing: see onExternalRemove
    }
    const hash = sha1(text);
    if (process.env.OVERLYX_DEBUG_WATCH) console.log(`[docs] absorb ${this.id} hash=${hash.slice(0, 8)} file=${this.fileHash.slice(0, 8)} known=${knownHashes.get(this.absPath)?.slice(0, 8)} len=${text.length}`);
    if (hash === this.fileHash || hash === knownHashes.get(this.absPath)) return null;
    if (!looksLikeDocument(text, this.isChild)) { console.warn(`[docs] ${this.id}: the file on disk is not a document any more — ignoring it`); return null; }
    return text;
  }

  /** absorbExternalChange, with the merge made by the document worker. */
  absorbExternalChangeAsync(text?: string): Promise<boolean> {
    if (!this.usesWorker) return Promise.resolve(this.absorbExternalChange(text));
    return this.exclusive(() => this.absorbLocked(text));
  }

  private async absorbLocked(text?: string): Promise<boolean> {
    if (this.disposed) return false;
    if (!this.usesWorker) return this.absorbExternalChange(text);
    const t = this.changedFileText(text);
    if (t === null) return false;
    console.log(`[docs] external change detected: ${this.id} — merging`);
    const hash = sha1(t);
    const seq = this.updateSeq, base = this.fileText;
    const r = await inWorker(this, 'absorb', { text: t, fileText: base, isChild: this.isChild }) as { dirty: boolean; rendered?: Rendered; update: Uint8Array | null; isChild: boolean };
    if (this.disposed) return false;
    this.isChild = r.isChild;
    this.fileHash = hash;
    this.fileText = t;
    knownHashes.set(this.absPath, hash);
    // edits that arrived while the worker merged are not in the merge's view of the file
    const quiet = this.updateSeq === seq;
    if (r.update) Y.applyUpdate(this.ydoc, r.update, 'file-load');
    if (quiet) {
      this.markSaved();
      if (r.rendered) this.prepared = { seq: this.updateSeq, base: t, r: r.rendered };
    }
    if (base !== null && r.dirty) this.dirty = true;   // ours differs from the disk: write it
    await this.persistStateAsync();
    return true;
  }

  /**
   * Write the document to its file. Resolves once the file holds (at least) the state the
   * document had when this was called — after the save under way, if there is one.
   */
  saveToFile(): Promise<boolean> {
    if (!this.usesWorker) return Promise.resolve(this.saveNow());
    const want = this.updateSeq;
    const waits = this.saves > 0;
    this.saves++;
    return this.exclusive(async () => {
      // a save that ended while this one waited may have written this state already
      if (waits && this.savedSeq >= want && !this.saveError) return true;
      return this.saveLocked();
    }).finally(() => { this.saves--; });
  }

  /** The save, all of it on the main thread (no document workers). */
  private saveNow(): boolean {
    if (this.saves) { this.scheduleSave(); return false; }
    this.saves++;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    // never re-create a deleted file — but a file that is back on disk (removed and re-created by a
    // tool, the watcher's events arriving out of order) is written again
    if (this.fileMissing && fs.existsSync(this.absPath)) this.fileMissing = false;
    if (this.fileMissing) { this.saves--; return false; }
    try {
      // Somebody may have written the file since we last read it (during the debounce window):
      // merge that first — writing over it would silently discard their change.
      this.absorbExternalChange();
      const seq = this.updateSeq;
      const sv = Y.encodeStateVector(this.ydoc);
      const snapshot = Y.encodeSnapshot(Y.snapshot(this.ydoc));
      const { text, files } = this.render();
      if (!this.writeOut(text, files)) return false;
      this.dirty = false;
      this.saveError = null;
      this.persistState();
      this.saved(seq, sv, snapshot);
      return true;
    } catch (e) {
      this.saveFailed(e);
      return false;
    } finally {
      this.saves--;
    }
  }

  private async saveLocked(): Promise<boolean> {
    if (this.disposed) return false;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    if (this.fileMissing && fs.existsSync(this.absPath)) this.fileMissing = false;
    if (this.fileMissing) return false;
    const t0 = performance.now();
    try {
      // Somebody may have written the file since we last read it (during the debounce window):
      // merge that first — writing over it would silently discard their change.
      await this.absorbLocked();
      for (let round = 0; ; round++) {
        if (this.disposed) return false;
        const seq = this.updateSeq, base = this.fileText;
        const sv = Y.encodeStateVector(this.ydoc);
        const snapshot = Y.encodeSnapshot(Y.snapshot(this.ydoc));
        const p = this.prepared;
        this.prepared = null;
        const { text, files } = p && p.seq === seq && p.base === base ? p.r : await this.renderAsync();
        if (this.disposed) return false;
        // the text took a while: a change written to the file meanwhile is merged first (and the
        // text made again), not written over
        if (round < 2 && await this.absorbLocked()) continue;
        if (!this.writeOut(text, files)) return false;
        if (this.updateSeq === seq) this.dirty = false;   // else the edits since are saved next
        this.saveError = null;
        await this.persistStateAsync();
        this.saved(seq, sv, snapshot);
        return true;
      }
    } catch (e) {
      this.saveFailed(e);
      return false;
    } finally {
      this.lastSaveCost = performance.now() - t0;
      this.lastSaveEnd = Date.now();
    }
  }

  /**
   * Write a save's text (and sidecar files) when it differs from what the file holds. False when
   * the file was deleted meanwhile (the watcher reports that a moment later): it is never re-created
   * (DocManager.onExternalRemove closes the document; a file put back is merged and saved).
   */
  private writeOut(text: string, files: Record<string, string>): boolean {
    if (!fs.existsSync(this.absPath)) { this.fileMissing = true; return false; }
    this.writeSidecars(files);   // even when the .tex itself is unchanged (a stroke changes only the SVG)
    const hash = sha1(text);
    if (hash === this.fileHash) return true;
    // never replace a document with something that is not one (a bug in the conversion must
    // not destroy the file on disk; the state stays dirty and the next save tries again)
    if (!looksLikeDocument(text, this.isChild)) throw new Error('refusing to write: the generated text is not a document');
    // a drastic shrink is probably a mistake: keep what the file had as a version first
    let previous: string | null = null;
    try { previous = readTextFile(this.absPath); } catch { /* new file */ }
    if (previous && previous.length > 5000 && text.length < previous.length * 0.2) this.snapshot('before large deletion', previous);
    this.writeText(text);
    return true;
  }

  /** A save of state `seq` succeeded: the clients are told what the file holds now. */
  private saved(seq: number, sv: Uint8Array, snapshot: Uint8Array): void {
    this.savedSeq = seq;
    this.lastSavedSV = sv;
    this.lastSavedSnapshot = snapshot;
    this.lastSavedAt = Date.now();
    for (const l of this.savedListeners) { try { l(); } catch { /* ignore */ } }
  }

  private saveFailed(e: unknown): void {
    console.error('save failed', this.absPath, e);
    this.saveError = String(e);
    if (this.disposed) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.saveToFile(); }, 15000);
  }

  /** Write `text` to the file (atomically) as what it holds now; the git layer is told who edited. */
  private writeText(text: string): void {
    const hash = sha1(text);
    const tmp = this.absPath + '.overlyx-tmp';
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, this.absPath);
    if (process.env.OVERLYX_DEBUG_WATCH) console.log(`[docs] wrote ${this.id} hash=${hash.slice(0, 8)} len=${text.length}`);
    this.fileHash = hash;
    this.fileText = text;
    knownHashes.set(this.absPath, hash);
    this.maybeAutoVersion(text);
    const editors = [...this.editors]; this.editors.clear();
    for (const l of fileWrittenListeners) { try { l(this.project, editors); } catch { /* ignore */ } }
  }

  /* --------------------------------------------- the work in the document worker */

  /**
   * Apply a CRDT update a worker made (an edit of its mirror). Returns whether nothing else had
   * changed the document since the request (`seq`): then what the worker computed for its state
   * holds for the document's.
   */
  private applyWorkerUpdate(update: Uint8Array | null, origin: string, seq: number): boolean {
    const quiet = this.updateSeq === seq;
    if (update) Y.applyUpdate(this.ydoc, update, origin);
    return quiet;
  }

  /**
   * LaTeX source loaded as the document (as a diff: untouched paragraphs keep their identity).
   * `asDoc`: parsed as the document's file is (a restored version); else as source edited by hand,
   * whose parse warnings are returned.
   */
  async loadText(text: string, origin: string, asDoc = false): Promise<string[]> {
    if (!this.usesWorker) {
      if (asDoc) { this.loadFromLyx(this.parse(text), origin); return []; }
      const r = parseDocumentText(text, this.project, this.relPath);
      this.loadFromLyx(r.doc, origin);
      return r.warnings;
    }
    return this.exclusive(async () => {
      const seq = this.updateSeq;
      const r = await inWorker(this, 'load', { text, origin, asDoc, fileText: this.fileText, isChild: this.isChild }) as { update: Uint8Array | null; warnings: string[]; isChild: boolean };
      if (this.disposed) throw new Error('the document was closed');
      this.isChild = r.isChild;
      this.applyWorkerUpdate(r.update, origin, seq);
      return r.warnings;
    });
  }

  /**
   * An agent's edit of the source (docedit.ts: tracked, plain or a restore), made by the document
   * worker; resolves once the file holds it, as the main-thread version does. `before`: the source
   * the agent edited (null: the document's text now); the edited source is `after`, or `before` with
   * a passage replaced (docedit.ts replaceInSource: its EditError when the passage is not there).
   * `warnings`: also answer with the parse warnings of the edited source.
   */
  async agentEdit<K extends EditKind>(kind: K, before: string | null, edit: AgentEditSource, opts: { author?: string; warnings?: boolean } = {}): Promise<{ result: EditResults[K]; warnings: string[] }> {
    const author = opts.author ?? '';
    if (!this.usesWorker) {
      const b = before ?? this.toText();
      const after = 'after' in edit ? edit.after : replaceInSource(b, edit.replace.oldText, edit.replace.newText, edit.replace.all);
      const warnings = opts.warnings ? parseDocumentText(after, this.project, this.relPath).warnings : [];
      const result = kind === 'tracked' ? applyTrackedSource(this, b, after, author) : kind === 'plain' ? applyPlainSource(this, b, after) : { text: restoreSource(this, after) };
      return { result: result as EditResults[K], warnings };
    }
    const r = await this.exclusive(async () => {
      const seq = this.updateSeq, base = this.fileText;
      const res = await inWorker(this, 'edit', { kind, before, ...edit, author, retired: [...this.retiredMacros], fileText: base, isChild: this.isChild }) as
        { result: EditResults[K]; warnings: string[]; update: Uint8Array | null; saved: Rendered | null; retired: string[]; isChild: boolean };
      if (this.disposed) throw new Error('the document was closed');
      this.isChild = res.isChild;
      this.retiredMacros = new Set(res.retired);
      if (this.applyWorkerUpdate(res.update, 'mcp', seq) && res.saved) this.prepared = { seq: this.updateSeq, base, r: res.saved };
      return res;
    });
    if (r.saved) { this.dirty = true; await this.saveToFile(); }
    return { result: r.result, warnings: r.warnings };
  }

  /** docedit.ts foldEdits, in the document worker. */
  async foldEditsAsync(shadow: string, base: string, live: string): Promise<{ text: string; conflicts: number }> {
    if (!this.usesWorker) return foldEdits(this, shadow, base, live);
    return await inWorker(this, 'fold', { shadow, base, live, fileText: this.fileText, isChild: this.isChild }) as { text: string; conflicts: number };
  }

  /** The text and the paragraphs (index, layout, depth, plain text) — MCP read_document. */
  async readAsync(): Promise<{ text: string; paragraphs: { index: number; layout: string; depth: number; text: string }[] }> {
    if (!this.usesWorker) {
      const lyx = this.toLyxDocument();
      return { text: this.toText(), paragraphs: lyx.body.map((p, i) => ({ index: i, layout: p.layout, depth: p.depth, text: p.items.map(itemText).join('') })) };
    }
    return await inWorker(this, 'read', { fileText: this.fileText, isChild: this.isChild }) as { text: string; paragraphs: { index: number; layout: string; depth: number; text: string }[] };
  }

  /** What the editor needs to know about the document besides its content (docmeta.ts), and its structural health. */
  async metaAsync(): Promise<DocumentMeta & { health: HealthIssue[] }> {
    if (!this.usesWorker) return { ...documentMeta(this, openDocs), health: this.health() };
    return await inWorker(this, 'meta', { fileText: this.fileText, isChild: this.isChild }) as DocumentMeta & { health: HealthIssue[] };
  }

  /** a big document: what a connecting client lacks (all of it on a first visit) is encoded by the worker */
  get bigForSync(): boolean { return this.usesWorker && (this.fileText?.length ?? 0) > 100_000; }

  /** What a client whose state vector is `sv` lacks, as an update (sync step 2), encoded by the document worker. */
  async missingFor(sv: Uint8Array): Promise<Uint8Array> {
    if (!this.usesWorker) return Y.encodeStateAsUpdate(this.ydoc, sv);
    return await inWorker(this, 'missing', { sv }) as Uint8Array;
  }

  /** The warnings of parsing a source in this document's context. */
  async parseWarnings(text: string): Promise<string[]> {
    if (!this.usesWorker) return parseDocumentText(text, this.project, this.relPath).warnings;
    return await inWorker(this, 'warnings', { text }) as string[];
  }

  /** What the document's worker needs before a request: its whole state (a new mirror) or the updates since the last one. */
  syncEntry(slot: number, gen: number): SyncEntry | null {
    const info = { id: this.id, project: this.project, relPath: this.relPath, absPath: this.absPath };
    if (this.wsync.slot === slot && this.wsync.gen === gen) {
      if (!this.wsync.pending.length) return null;
      const updates = this.wsync.pending;
      this.wsync.pending = [];
      return { doc: info, updates };
    }
    this.wsync = { slot, gen, pending: [] };
    return { doc: info, full: Y.encodeStateAsUpdate(this.ydoc), updates: [] };
  }

  /** Keep a copy of some text as a version of this document (never fails the caller). */
  snapshot(name: string, text: string, kind = 'auto'): void {
    try {
      const authors = [...this.awareness.getStates().values()].map(s => (s as any)?.user?.name).filter(Boolean);
      db.prepare('INSERT INTO versions (doc_id, name, author, kind, created_at, lyx) VALUES (?,?,?,?,?,?)').run(this.id, name, authors.join(', ') || 'system', kind, Date.now(), text);
    } catch (e) { console.error('snapshot failed', this.id, e); }
  }

  /** Stop all timers (the document is being dropped); the worker forgets its mirror. */
  dispose(): void {
    this.disposed = true;
    for (const t of [this.saveTimer, this.persistTimer, this.unloadTimer, this.retryTimer]) if (t) clearTimeout(t);
    this.saveTimer = this.persistTimer = this.unloadTimer = this.retryTimer = null;
    if (this.wsync.slot >= 0) docWorkers.forget(this.wsync.slot, this.wsync.gen, this.id);
    this.wsync = { slot: -1, gen: -1, pending: [] };
  }

  maybeAutoVersion(text: string): void {
    const now = Date.now();
    if (now - this.lastAutoVersion < config.autoVersionIntervalMs) return;
    const last = db.prepare('SELECT created_at, lyx FROM versions WHERE doc_id = ? ORDER BY created_at DESC LIMIT 1').get(this.id) as { created_at: number; lyx: string } | undefined;
    if (last && last.lyx === text) { this.lastAutoVersion = now; return; }
    if (last && now - last.created_at < config.autoVersionIntervalMs) { this.lastAutoVersion = last.created_at; return; }
    const authors = [...this.awareness.getStates().values()].map(s => (s as any)?.user?.name).filter(Boolean);
    db.prepare('INSERT INTO versions (doc_id, name, author, kind, created_at, lyx) VALUES (?,?,?,?,?,?)')
      .run(this.id, 'autosave', authors.join(', ') || 'system', 'auto', now, text);
    // prune old autosaves (keep 60)
    db.prepare(`DELETE FROM versions WHERE doc_id = ? AND kind = 'auto' AND id NOT IN (SELECT id FROM versions WHERE doc_id = ? AND kind = 'auto' ORDER BY created_at DESC LIMIT 60)`).run(this.id, this.id);
    this.lastAutoVersion = now;
  }

  touchUnload(): void {
    if (this.unloadTimer) clearTimeout(this.unloadTimer);
    if (this.conns.size === 0) {
      // keep idle documents in memory for a long while: the first open after an unload is the slow
      // (parse / rebuild) path, and a loaded document costs only a few MB
      this.unloadTimer = setTimeout(() => void manager.unload(this.id), config.unloadAfterMs);
    }
  }
}

type EditKind = 'tracked' | 'plain' | 'restore';
interface EditResults { tracked: TrackedResult; plain: ReturnType<typeof applyPlainSource>; restore: { text: string } }
/** what an agent's edit makes of the source: the whole new text, or a passage replaced */
export type AgentEditSource = { after: string } | { replace: { oldText: string; newText: string; all: boolean } };

/** The open documents by id, for including a child document's live state. */
const openDocs = (id: string): OpenDoc | undefined => manager.docs.get(id);

/**
 * Run `op` for `doc` in the document worker of its project — the worker's mirrors of the
 * project's open documents brought up to date first (a master includes its children). `created`:
 * the op makes the document's mirror itself (opening). A worker that died meanwhile is replaced
 * and the request sent again once, with the whole state.
 */
async function inWorker(doc: OpenDoc, op: string, args: unknown, created = false): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const slot = docWorkers.slotOf(doc.project), gen = docWorkers.generation(slot);
    const sync: SyncEntry[] = [];
    for (const d of manager.docs.values()) {
      if (d.project !== doc.project || d === doc || !d.usesWorker) continue;
      const e = d.syncEntry(slot, gen);
      if (e) sync.push(e);
    }
    if (created) doc.wsync = { slot, gen, pending: [] };
    else { const e = doc.syncEntry(slot, gen); if (e) sync.push(e); }
    try {
      return await docWorkers.call(slot, op, { id: doc.id, project: doc.project, relPath: doc.relPath, absPath: doc.absPath }, sync, args);
    } catch (e) {
      if (attempt > 0 || !(e instanceof WorkerGone || e instanceof MirrorLost)) throw e;
      // the mirrors are gone: the next attempt sends the whole states
      for (const d of manager.docs.values()) if (d.project === doc.project) d.wsync = { slot: -1, gen: -1, pending: [] };
      if (!created) doc.wsync = { slot: -1, gen: -1, pending: [] };
    }
  }
}

/**
 * A whiteboard document (.board): the same Yjs sync, presence and persistence machinery as a
 * .tex document, but the state is a flat Y.Map('objects') of board items (strokes, images,
 * notes) and the file on disk is JSON — no LaTeX anywhere. External changes replace the state
 * (boards have no three-way merge; concurrent live editing is already conflict-free via Yjs).
 */
export class BoardDoc extends OpenDoc {
  constructor(id: string, project: string, relPath: string, absPath: string) {
    super(id, project, relPath, absPath);
    this.isChild = true;   // saveToFile's looksLikeDocument check: boards have no \begin{document}
  }

  get objects(): Y.Map<unknown> { return this.ydoc.getMap('objects'); }

  /** a board's JSON takes no time to make: no document worker */
  override get usesWorker(): boolean { return false; }

  override health(): HealthIssue[] { return []; }

  protected override render(): Rendered {
    const m = this.objects;
    const keys = [...m.keys()].sort();
    let s = '{"overlyx":"board","v":1,"objects":{';
    s += keys.map(k => `\n${JSON.stringify(k)}: ${JSON.stringify(m.get(k))}`).join(',');
    return { text: s + '\n}}\n', files: {}, spans: [] };
  }

  /** Load board JSON into the CRDT; only objects that differ are touched, so cursors and undo of others survive. */
  loadFromJson(text: string, origin: string): void {
    let objs: Record<string, unknown> = {};
    try {
      const j = JSON.parse(text) as { objects?: Record<string, unknown> };
      if (j && typeof j === 'object' && j.objects && typeof j.objects === 'object') objs = j.objects;
    } catch { console.warn(`[docs] ${this.id}: board file is not valid JSON — starting empty`); }
    this.ydoc.transact(() => {
      const m = this.objects;
      for (const k of [...m.keys()]) if (!(k in objs)) m.delete(k);
      for (const [k, v] of Object.entries(objs)) {
        if (JSON.stringify(m.get(k)) !== JSON.stringify(v)) m.set(k, v);
      }
    }, origin);
    if (origin === 'file-load') this.markSaved();
  }

  override absorbExternalChange(text?: string): boolean {
    if (text === undefined) {
      try { text = readTextFile(this.absPath); } catch { return false; }
    }
    const hash = sha1(text);
    if (hash === this.fileHash || hash === knownHashes.get(this.absPath)) return false;
    this.fileHash = hash;
    this.fileText = text;
    knownHashes.set(this.absPath, hash);
    this.loadFromJson(text, 'file-load');
    if (sha1(this.toText()) !== hash) this.dirty = true;   // ours differs (normalisation): write it back
    this.persistState();
    return true;
  }
}

/** hashes of file contents we last wrote / read, to distinguish our own writes from external ones */
const knownHashes = new Map<string, string>();

/** A stored version in LyX's format (from before the switch to .tex, or offline edits a browser could only keep that way)? */
const isLyxText = (text: string) => /^\s*#LyX|^\\lyxformat/m.test(text.slice(0, 400));

/**
 * A stored version is .tex text — or, for versions from before the switch to .tex and for offline
 * edits a browser could only keep in LyX's format, a LyX document: those are read as such.
 */
export async function parseVersionText(doc: OpenDoc, text: string): Promise<LyxDocument> {
  if (isLyxText(text)) {
    const { parseLyx } = await import('@overlyx/core');
    const { prepareForTex } = await import('@overlyx/core/tex/index.ts');
    const d = parseLyx(text);
    prepareForTex(d);
    d.preamble = [];
    return d;
  }
  return doc.parse(text);
}

/** Called after a document was written: (project, ids of the users whose edits it contains). */
export const fileWrittenListeners = new Set<(project: string, userIds: number[]) => void>();

/**
 * Called (debounced) when files appear or disappear in a project — whoever the writer was:
 * another user's upload, the agent, a git push, a LaTeX build. Feeds the clients' file browsers
 * (SSE, `GET /api/projects/:project/events`) so they refresh themselves.
 */
export const projectChangedListeners = new Set<(project: string) => void>();
/** a graphics file of a project was written or created: (project, project-relative path, mtime) — the editors reload the image */
export const graphicsChangedListeners = new Set<(project: string, file: string, version: number) => void>();
const GRAPHICS_FILE = /\.(png|jpe?g|gif|webp|svgz?|pdf|eps|ps|tiff?|bmp)$/i;

type DbState = { state: Buffer; file_hash: string; epoch: string | null };

export class DocManager {
  docs = new Map<string, OpenDoc>();
  /** documents being opened (the first open of a big one takes a moment): later requests wait for it */
  private opening = new Map<string, Promise<OpenDoc>>();
  private watcher: FSWatcher | null = null;
  private changeTimers = new Map<string, NodeJS.Timeout>();

  constructor() {
    this.watch();
  }

  /** ids look like "owner/project/sub/dir/file.tex" (core projectKey.ts) */
  static parseId(id: string): { project: string; relPath: string } {
    const { project, path: relPath } = splitDocId(id);
    if (!project || !relPath) throw new Error('bad doc id');
    return { project, relPath };
  }

  async open(id: string): Promise<OpenDoc> {
    const existing = this.docs.get(id);
    if (existing) return existing;
    let p = this.opening.get(id);
    if (!p) {
      p = (async () => {
        const t0 = performance.now();
        const doc = await this.openCold(id);
        console.log(`[docs] opened ${id} in ${Math.round(performance.now() - t0)} ms`);
        return doc;
      })();
      this.opening.set(id, p);
      p.catch(() => undefined).finally(() => this.opening.delete(id));
    }
    return p;
  }

  private async openCold(id: string): Promise<OpenDoc> {
    const { project, relPath } = DocManager.parseId(id);
    if (!relPath.endsWith('.tex') && !relPath.endsWith('.board')) throw new Error('not a .tex document');
    const absPath = resolveProjectPath(project, relPath);
    if (!fs.existsSync(absPath)) throw new Error('file not found: ' + id);
    if (relPath.endsWith('.board')) return this.openBoardCold(id, project, relPath, absPath);
    const doc = new OpenDoc(id, project, relPath, absPath);
    const text = readTextFile(absPath);
    if (text.includes('\0')) throw new Error('not a text document: ' + id);
    const hash = sha1(text);
    doc.fileHash = hash;
    doc.fileText = text;
    knownHashes.set(absPath, hash);
    const row = db.prepare('SELECT state, file_hash, epoch FROM ydocs WHERE id = ?').get(id) as DbState | undefined;
    if (!row) return this.openFresh(doc, text);
    const ok = await this.loadStored(doc, text, row);
    if (!ok) { doc.dispose(); doc.ydoc.destroy(); return this.openFresh(doc, text); }
    doc.markSaved();
    doc.lastSavedAt = fs.statSync(absPath).mtimeMs;
    if (row.file_hash !== hash) await doc.persistStateAsync();
    this.register(doc);
    return doc;
  }

  /**
   * The stored history (the persisted Yjs state) with the file loaded on top (docwork.ts
   * loadOverStored); false when that does not give the file back.
   */
  private async loadStored(doc: OpenDoc, text: string, row: DbState): Promise<boolean> {
    const sameFile = row.file_hash === doc.fileHash;
    try {
      Y.applyUpdate(doc.ydoc, new Uint8Array(row.state), 'db');
      if (row.epoch) doc.epoch = row.epoch;
    } catch { return false; }
    if (!doc.usesWorker) {
      const r = loadOverStored(doc, text, sameFile, openDocs, d => doc.loadFromLyx(d, 'file-load'));
      if (r.note) console.log(`[docs] ${doc.id}: ${r.note}`);
      return r.ok;
    }
    try {
      const r = await inWorker(doc, 'open', { text, state: new Uint8Array(row.state), sameFile }, true) as { ok: boolean; note?: string; update: Uint8Array | null; isChild: boolean };
      if (r.note) console.log(`[docs] ${doc.id}: ${r.note}`);
      if (!r.ok) return false;
      doc.isChild = r.isChild;
      if (r.update) Y.applyUpdate(doc.ydoc, r.update, 'file-load');
      return true;
    } catch (e) {
      console.error(`[docs] ${doc.id}: loading the stored state failed`, e);
      return false;
    }
  }

  private openBoardCold(id: string, project: string, relPath: string, absPath: string): BoardDoc {
    const text = readTextFile(absPath);
    const hash = sha1(text);
    const setup = (doc: BoardDoc) => { doc.fileHash = hash; doc.fileText = text; knownHashes.set(absPath, hash); };
    const row = db.prepare('SELECT state, file_hash, epoch FROM ydocs WHERE id = ?').get(id) as DbState | undefined;
    if (row) {
      const doc = new BoardDoc(id, project, relPath, absPath);
      setup(doc);
      try {
        Y.applyUpdate(doc.ydoc, new Uint8Array(row.state), 'db');
        if (row.epoch) doc.epoch = row.epoch;
        if (row.file_hash !== hash) {
          console.log(`[docs] ${id}: board file changed since last persisted state — reloading`);
          doc.loadFromJson(text, 'file-load');
        }
        doc.markSaved();
        doc.lastSavedAt = fs.statSync(absPath).mtimeMs;
        if (row.file_hash !== hash) doc.persistState();
        this.register(doc);
        return doc;
      } catch { doc.ydoc.destroy(); }
    }
    const fresh = new BoardDoc(id, project, relPath, absPath);
    setup(fresh);
    fresh.loadFromJson(text, 'file-load');
    fresh.lastSavedAt = fs.statSync(absPath).mtimeMs;
    fresh.persistState();
    this.register(fresh);
    return fresh;
  }

  private async openFresh(doc: OpenDoc, text: string): Promise<OpenDoc> {
    const fresh = new OpenDoc(doc.id, doc.project, doc.relPath, doc.absPath);
    fresh.fileHash = doc.fileHash;
    fresh.fileText = text;
    if (fresh.usesWorker) {
      // the worker parses the file and builds the state; here it is only applied
      const r = await inWorker(fresh, 'fresh', { text }, true) as { steps: Uint8Array[]; state: Uint8Array; isChild: boolean };
      fresh.isChild = r.isChild;
      // a step at a time (a big document's state takes a while): other requests are served in
      // between; no update listeners yet, so nothing encodes it again
      for (const [i, u] of r.steps.entries()) {
        if (i) await new Promise(res => setImmediate(res));
        Y.applyUpdate(fresh.ydoc, u, 'file-load');
      }
      fresh.markSaved();
      fresh.lastSavedAt = fs.statSync(doc.absPath).mtimeMs;
      fresh.persistStateBytes(r.state);
    } else {
      const parsed = fresh.parse(text);
      fresh.loadFromLyx(parsed, 'file-load');
      fresh.lastSavedAt = fs.statSync(doc.absPath).mtimeMs;
      fresh.persistState();
    }
    this.register(fresh);
    return fresh;
  }

  private register(doc: OpenDoc): void {
    this.docs.set(doc.id, doc);
    doc.trackUpdates();
    doc.ydoc.on('update', (_u: Uint8Array, origin: unknown) => {
      if (origin === 'file-load' || origin === 'db') return;
      // updates from the WebSocket carry the connection as origin: remember who edited
      if (origin && typeof origin === 'object') { const uid = doc.connUsers.get(origin as import('ws').WebSocket); if (uid != null) doc.editors.add(uid); }
      doc.scheduleSave();
    });
    doc.touchUnload();
  }

  /** Forget an open document (its file is saved, gone, or its project removed). */
  private forgetDoc(doc: OpenDoc): void {
    doc.dispose();
    doc.awareness.destroy();
    doc.ydoc.destroy();
    if (this.docs.get(doc.id) === doc) this.docs.delete(doc.id);
    if (![...this.docs.values()].some(d => d.project === doc.project)) docWorkers.release(doc.project);
  }

  async unload(id: string): Promise<void> {
    const doc = this.docs.get(id);
    if (!doc || doc.conns.size) return;
    if (doc.dirty || doc.saving) await doc.saveToFile();
    if (this.docs.get(id) !== doc || doc.conns.size) return;   // opened again meanwhile
    this.forgetDoc(doc);
  }

  /**
   * Drop the collaboration history of a document (admin tool): the .lyx file on disk is kept (a
   * pending save is written first), the persisted Yjs state is deleted and every client is
   * disconnected; the next open starts a fresh history with a new epoch. Clients holding a local
   * copy of the old history keep their unsynced edits as a version when they reconnect.
   */
  async reset(id: string): Promise<void> {
    const doc = this.docs.get(id);
    if (doc) {
      if (doc.dirty || doc.saving) await doc.saveToFile();
      for (const c of [...doc.conns.keys()]) { doc.conns.delete(c); try { c.close(4001, 'document reset'); } catch { /* ignore */ } }
      this.forgetDoc(doc);
    }
    db.prepare('DELETE FROM ydocs WHERE id = ?').run(id);
  }

  /** Save and close every open document of a project (before it is moved away / deleted). */
  async closeProject(project: string): Promise<void> {
    for (const doc of [...this.docs.values()]) {
      if (doc.project !== project) continue;
      if (doc.dirty || doc.saving) await doc.saveToFile();
      this.drop(doc, 'project removed');
    }
    db.prepare("DELETE FROM ydocs WHERE substr(id, 1, ?) = ?").run(project.length + 1, project + '/');
  }

  /** Write every document with unsaved changes (and wait for the saves under way). */
  async saveAll(): Promise<void> {
    await Promise.all([...this.docs.values()].filter(d => d.dirty || d.saving).map(d => d.saveToFile()));
  }
  async saveProject(project: string): Promise<void> {
    await Promise.all([...this.docs.values()].filter(d => d.project === project && (d.dirty || d.saving)).map(d => d.saveToFile()));
  }

  /**
   * Close the connections of some users (or of everybody) to the documents of a project — after
   * their access changed. The client reconnects and learns its new role (or that it has none).
   */
  kick(project: string, userIds: number[] | 'all', reason = 'access changed'): number {
    let n = 0;
    for (const doc of this.docs.values()) {
      if (doc.project !== project) continue;
      for (const [c, uid] of [...doc.connUsers]) {
        if (userIds !== 'all' && !userIds.includes(uid)) continue;
        try { c.close(4003, reason); } catch { /* ignore */ }
        n++;
      }
    }
    return n;
  }

  private watch(): void {
    // watch the whole projects root so that projects created later are covered too
    // hidden directories, node_modules and build directories *inside* the projects root are not
    // watched (the root itself may live under a dotted path)
    const root = config.projectsDir;
    const ignored = (p: string) => path.relative(root, p).split(path.sep).some(seg => (seg.startsWith('.') && seg !== '.' && seg !== '..') || seg === 'node_modules' || seg === '_build');
    this.watcher = chokidar.watch(root, { ignoreInitial: true, depth: 8, awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 }, ignored });
    this.watcher.on('change', (file: string) => void this.onExternalChange(file));
    this.watcher.on('add', (file: string) => void this.onExternalChange(file));
    this.watcher.on('unlink', (file: string) => void this.onExternalRemove(file));
    // structural changes only ('change' would fire on every document save while someone types)
    this.watcher.on('all', (event: string, file: string) => {
      if (event !== 'change') this.notifyProjectChanged(file);
      if ((event === 'change' || event === 'add') && GRAPHICS_FILE.test(file)) this.notifyGraphicsChanged(file);
    });
  }

  /** A figure was (re)written — a plot script ran, a file was uploaded: tell the editors showing it. */
  private notifyGraphicsChanged(file: string): void {
    const parts = path.relative(config.projectsDir, file).split(path.sep);
    const project = parts.splice(0, 2).join('/');   // <owner>/<name>
    if (!isProjectKey(project) || project.startsWith('.') || !parts.length) return;
    let version = Date.now();
    try { version = Math.round(fs.statSync(file).mtimeMs); } catch { /* gone again */ }
    for (const l of graphicsChangedListeners) l(project, parts.join('/'), version);
  }

  /** Tell the subscribed clients (debounced per project) that the project's file list changed. */
  private notifyProjectChanged(file: string): void {
    const project = path.relative(config.projectsDir, file).split(path.sep).slice(0, 2).join('/');
    if (!isProjectKey(project) || project.startsWith('.')) return;
    clearTimeout(this.changeTimers.get(project));
    this.changeTimers.set(project, setTimeout(() => {
      this.changeTimers.delete(project);
      for (const l of projectChangedListeners) l(project);
    }, 500));
  }

  private async onExternalChange(file: string): Promise<void> {
    if (!file.endsWith('.tex') && !file.endsWith('.board')) return;
    const doc = [...this.docs.values()].find(d => d.absPath === file);
    if (process.env.OVERLYX_DEBUG_WATCH) console.log(`[docs] fs change ${file} open=${!!doc} hash=${doc?.fileHash.slice(0, 8)} known=${knownHashes.get(file)?.slice(0, 8)}`);
    if (!doc) return;
    const wasMissing = doc.fileMissing;
    doc.fileMissing = false;
    try { await doc.absorbExternalChangeAsync(); }
    catch (e) { console.error('reload failed', e); }
    if (wasMissing && doc.dirty) doc.scheduleSave();
  }

  /**
   * The file of an open document disappeared (deleted, moved, renamed). Editors that write through
   * a temporary file, and `git checkout`, remove and re-create: wait a moment. If it is really gone
   * the document is closed — its current content is kept as a version so nothing is lost — and
   * the clients are told (close code 4001); the next save would otherwise silently re-create it.
   */
  private async onExternalRemove(file: string): Promise<void> {
    if (!file.endsWith('.tex') && !file.endsWith('.board')) return;
    const doc = [...this.docs.values()].find(d => d.absPath === file);
    if (process.env.OVERLYX_DEBUG_WATCH) console.log(`[docs] fs change ${file} open=${!!doc} hash=${doc?.fileHash.slice(0, 8)} known=${knownHashes.get(file)?.slice(0, 8)}`);
    if (!doc) return;
    doc.fileMissing = true;
    await new Promise(r => setTimeout(r, 1500));
    if (this.docs.get(doc.id) !== doc) return;
    if (fs.existsSync(file)) { doc.fileMissing = false; if (doc.dirty) doc.scheduleSave(); return; }
    console.log(`[docs] ${doc.id}: file removed on disk — closing the document (content kept as a version)`);
    let text: string;
    try { text = await doc.textAsync(); } catch (e) { console.error('[docs] text of a removed document failed', doc.id, e); text = doc.fileText ?? ''; }
    if (this.docs.get(doc.id) !== doc) return;
    doc.snapshot('file removed on disk', text);
    this.drop(doc, 'document removed');
  }

  /** Forget an open document without saving it (its file is gone / the project was removed). */
  private drop(doc: OpenDoc, reason: string): void {
    for (const c of [...doc.conns.keys()]) { doc.conns.delete(c); try { c.close(4001, reason); } catch { /* ignore */ } }
    this.forgetDoc(doc);
  }

  /* ----------------------------------------------------------- versions */

  listVersions(id: string) {
    return db.prepare('SELECT id, name, author, kind, created_at, length(lyx) AS size FROM versions WHERE doc_id = ? ORDER BY created_at DESC').all(id) as { id: number; name: string; author: string; kind: string; created_at: number; size: number }[];
  }

  async createVersion(id: string, name: string, author: string, kind = 'manual', lyx?: string): Promise<number> {
    const doc = await this.open(id);
    const text = lyx ?? await doc.textAsync();
    const info = db.prepare('INSERT INTO versions (doc_id, name, author, kind, created_at, lyx) VALUES (?,?,?,?,?,?)').run(id, name || 'version', author, kind, Date.now(), text);
    return Number(info.lastInsertRowid);
  }

  getVersion(id: string, vid: number): { lyx: string; name: string; created_at: number; author: string } | undefined {
    return db.prepare('SELECT lyx, name, created_at, author FROM versions WHERE id = ? AND doc_id = ?').get(vid, id) as any;
  }

  async restoreVersion(id: string, vid: number, author: string): Promise<void> {
    const v = this.getVersion(id, vid);
    if (!v) throw new Error('version not found');
    const doc = await this.open(id);
    await this.createVersion(id, 'before restore of "' + v.name + '"', author, 'auto');
    if (doc instanceof BoardDoc) doc.loadFromJson(v.lyx, 'restore');
    else if (isLyxText(v.lyx)) doc.loadFromLyx(await parseVersionText(doc, v.lyx), 'restore');
    else await doc.loadText(v.lyx, 'restore', true);
    doc.scheduleSave();
  }
}

export const manager = new DocManager();

export function docFiles(project: string): ProjectFile[] {
  return listProjects().find(p => p.name === project)?.files ?? [];
}
