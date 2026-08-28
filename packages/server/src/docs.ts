/**
 * Document manager: keeps one Y.Doc per open LyX file, persists Yjs state in SQLite,
 * writes the .lyx file back to disk (debounced) and reloads it when it changes externally
 * (e.g. saved from native LyX). Also manages named/automatic versions.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import chokidar, { type FSWatcher } from 'chokidar';
import { yDocToProsemirrorJSON } from 'y-prosemirror';
import {
  parseLyx, writeLyx, mergeLyx, pmToLyxBody, type LyxDocument, type PMJSON,
} from '@overlyx/core';
import { db } from './db.ts';
import { config } from './config.ts';
import { listProjects, resolveProjectPath, type ProjectFile } from './projects.ts';
import { applyLyxDocument } from './ydiff.ts';

/**
 * Read a .lyx file as text. LyX writes UTF-8; a file that is not valid UTF-8 (an old latin-1 file,
 * a corrupted one) is decoded as latin-1 rather than silently turned into U+FFFD characters that
 * would then be written back over the original bytes.
 */
export function readLyxFile(absPath: string): string {
  const buf = fs.readFileSync(absPath);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch {
    console.warn(`[docs] ${absPath} is not valid UTF-8 — decoding as latin-1`);
    return buf.toString('latin1');
  }
}

/** Does this text look like a LyX document we can safely write back? (a header, a body, an end) */
export function looksLikeLyx(text: string, parsed: LyxDocument): boolean {
  return parsed.format > 0 && parsed.header.lines.length > 0 && text.includes('\\begin_body') && text.includes('\\end_document');
}

export interface DocMeta {
  preamble: string[];
  format: number;
  headerLines: string[];
  trailer: string[];
}

export class OpenDoc {
  ydoc = new Y.Doc({ gc: true });
  awareness: awarenessProtocol.Awareness;
  conns = new Map<import('ws').WebSocket, Set<number>>();
  /** which account is behind each connection (to close them when access is revoked) */
  connUsers = new Map<import('ws').WebSocket, number>();
  fileHash = '';
  /** what the file contained when it was last read or written: the base for merging external changes */
  fileText: string | null = null;
  /** the file was deleted on disk (see DocManager.onExternalRemove): nothing is written until it is back */
  fileMissing = false;
  /** identifies this Yjs history; a fresh Y.Doc (after a restart with a changed file) gets a new one */
  epoch = crypto.randomBytes(8).toString('hex');
  private saveTimer: NodeJS.Timeout | null = null;
  private persistTimer: NodeJS.Timeout | null = null;
  private unloadTimer: NodeJS.Timeout | null = null;
  saving = false;
  dirty = false;
  lastAutoVersion = 0;
  /** what the .lyx file on disk contains: state vector of the Y.Doc when it was last written / read */
  lastSavedSV: Uint8Array = Y.encodeStateVector(this.ydoc);
  lastSavedAt = 0;
  /** notified after every successful save (the WebSocket layer tells the clients) */
  savedListeners = new Set<() => void>();
  /** accounts whose edits were written to the file since the last time somebody asked (git commits) */
  editors = new Set<number>();

  constructor(public id: string, public project: string, public relPath: string, public absPath: string) {
    this.awareness = new awarenessProtocol.Awareness(this.ydoc);
    this.awareness.setLocalState(null);
  }

  get fragment(): Y.XmlFragment { return this.ydoc.getXmlFragment('prosemirror'); }
  get meta(): Y.Map<string> { return this.ydoc.getMap<string>('meta'); }

  getMeta(): DocMeta {
    const m = this.meta;
    const parse = (k: string, def: unknown) => { try { const v = m.get(k); return v ? JSON.parse(v) : def; } catch { return def; } };
    return {
      preamble: parse('preamble', ['#LyX 2.5 created this file. For more info see https://www.lyx.org/']),
      format: parse('format', 643),
      headerLines: parse('header', []),
      trailer: parse('trailer', []),
    };
  }

  setMetaFrom(doc: LyxDocument): void {
    const m = this.meta;
    m.set('preamble', JSON.stringify(doc.preamble));
    m.set('format', JSON.stringify(doc.format));
    m.set('header', JSON.stringify(doc.header.lines));
    m.set('trailer', JSON.stringify(doc.trailer));
  }

  /** Current document as LyX AST (from the CRDT state). */
  toLyxDocument(): LyxDocument {
    const meta = this.getMeta();
    const json = yDocToProsemirrorJSON(this.ydoc, 'prosemirror') as PMJSON;
    return { preamble: meta.preamble, format: meta.format, header: { lines: meta.headerLines }, body: pmToLyxBody(json), trailer: meta.trailer };
  }

  toLyxText(): string { return writeLyx(this.toLyxDocument()); }

  /**
   * Load a LyX document into the CRDT (initial load, external change, restore). Applied as a diff:
   * unchanged paragraphs keep their identity so that concurrent / offline edits in them survive.
   */
  loadFromLyx(doc: LyxDocument, origin: string): void {
    applyLyxDocument(this.ydoc, doc, origin);
    if (origin === 'file-load') this.markSaved();
  }

  /** The file on disk now corresponds to the current state. */
  markSaved(): void {
    this.lastSavedSV = Y.encodeStateVector(this.ydoc);
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
    const saveDelay = Math.max(0, Math.min(config.saveDebounceMs, this.saveWindowStart + config.saveMaxWaitMs - now));
    this.saveTimer = setTimeout(() => { this.saveWindowStart = 0; void this.saveToFile(); }, saveDelay);
    if (!this.persistWindowStart) this.persistWindowStart = now;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    const persistDelay = Math.max(0, Math.min(800, this.persistWindowStart + config.persistMaxWaitMs - now));
    this.persistTimer = setTimeout(() => { this.persistWindowStart = 0; this.persistState(); }, persistDelay);
  }

  persistState(): void {
    const state = Y.encodeStateAsUpdate(this.ydoc);
    db.prepare('INSERT INTO ydocs (id, state, file_hash, updated_at, epoch) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state, file_hash=excluded.file_hash, updated_at=excluded.updated_at, epoch=excluded.epoch')
      .run(this.id, Buffer.from(state), this.fileHash, Date.now(), this.epoch);
  }

  /** last save error (cleared by a successful save); a retry is scheduled */
  saveError: string | null = null;
  private retryTimer: NodeJS.Timeout | null = null;

  /**
   * Merge a change somebody else made to the file on disk (desktop LyX, git, another editor)
   * into the CRDT — as a diff, so that unsaved edits in untouched paragraphs survive. Returns
   * true when the file had changed. `text` may be passed by the watcher; otherwise the file is read.
   */
  absorbExternalChange(text?: string): boolean {
    if (text === undefined) {
      try { text = readLyxFile(this.absPath); } catch { return false; }   // missing: see onExternalRemove
    }
    const hash = sha1(text);
    if (hash === this.fileHash || hash === knownHashes.get(this.absPath)) return false;
    const parsed = parseLyx(text);
    if (!looksLikeLyx(text, parsed)) { console.warn(`[docs] ${this.id}: the file on disk is not a LyX document any more — ignoring it`); return false; }
    console.log(`[docs] external change detected: ${this.id} — merging`);
    // three-way: only what changed on disk (relative to what we last read / wrote) is taken over;
    // edits made here meanwhile in other paragraphs are kept (they are saved right after)
    const base = this.fileText !== null ? parseLyx(this.fileText) : null;
    const merged = base ? mergeLyx(base, this.toLyxDocument(), parsed) : parsed;
    this.fileHash = hash;
    this.fileText = text;
    knownHashes.set(this.absPath, hash);
    this.loadFromLyx(merged, 'file-load');
    if (base && sha1(this.toLyxText()) !== hash) this.dirty = true;   // ours differs from the disk: write it
    this.persistState();
    return true;
  }

  async saveToFile(): Promise<boolean> {
    if (this.saving) { this.scheduleSave(); return false; }
    this.saving = true;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    if (this.fileMissing) { this.saving = false; return false; }   // never re-create a deleted file
    try {
      // Somebody may have written the file since we last read it (during the debounce window):
      // merge that first — writing over it would silently discard their change.
      this.absorbExternalChange();
      const sv = Y.encodeStateVector(this.ydoc);
      const text = this.toLyxText();
      const hash = sha1(text);
      if (hash !== this.fileHash) {
        // never replace a document with something that is not one (a bug in the conversion must
        // not destroy the file on disk; the state stays dirty and the next save tries again)
        if (!looksLikeLyx(text, parseLyx(text))) throw new Error('refusing to write: the generated text is not a LyX document');
        // a drastic shrink is probably a mistake: keep what the file had as a version first
        let previous: string | null = null;
        try { previous = readLyxFile(this.absPath); } catch { /* new file */ }
        if (previous && previous.length > 5000 && text.length < previous.length * 0.2) this.snapshot('before large deletion', previous);
        const tmp = this.absPath + '.overlyx-tmp';
        const fd = fs.openSync(tmp, 'w');
        try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(tmp, this.absPath);
        this.fileHash = hash;
        this.fileText = text;
        knownHashes.set(this.absPath, hash);
        this.maybeAutoVersion(text);
        const editors = [...this.editors]; this.editors.clear();
        for (const l of fileWrittenListeners) { try { l(this.project, editors); } catch { /* ignore */ } }
      }
      this.dirty = false;
      this.saveError = null;
      this.persistState();
      this.lastSavedSV = sv;
      this.lastSavedAt = Date.now();
      for (const l of this.savedListeners) { try { l(); } catch { /* ignore */ } }
      return true;
    } catch (e) {
      console.error('save failed', this.absPath, e);
      this.saveError = String(e);
      this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.saveToFile(); }, 15000);
      return false;
    } finally {
      this.saving = false;
    }
  }

  /** Keep a copy of some text as a version of this document (never fails the caller). */
  snapshot(name: string, text: string, kind = 'auto'): void {
    try {
      const authors = [...this.awareness.getStates().values()].map(s => (s as any)?.user?.name).filter(Boolean);
      db.prepare('INSERT INTO versions (doc_id, name, author, kind, created_at, lyx) VALUES (?,?,?,?,?,?)').run(this.id, name, authors.join(', ') || 'system', kind, Date.now(), text);
    } catch (e) { console.error('snapshot failed', this.id, e); }
  }

  /** Stop all timers (the document is being dropped). */
  dispose(): void {
    for (const t of [this.saveTimer, this.persistTimer, this.unloadTimer, this.retryTimer]) if (t) clearTimeout(t);
    this.saveTimer = this.persistTimer = this.unloadTimer = this.retryTimer = null;
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

function sha1(s: string): string { return crypto.createHash('sha1').update(s).digest('hex'); }

/** hashes of file contents we last wrote / read, to distinguish our own writes from external ones */
const knownHashes = new Map<string, string>();

/** Called after a .lyx file was written: (project, ids of the users whose edits it contains). */
export const fileWrittenListeners = new Set<(project: string, userIds: number[]) => void>();

export class DocManager {
  docs = new Map<string, OpenDoc>();
  private watcher: FSWatcher | null = null;

  constructor() {
    this.watch();
  }

  /** ids look like "project/sub/dir/file.lyx" */
  static parseId(id: string): { project: string; relPath: string } {
    const idx = id.indexOf('/');
    if (idx < 0) throw new Error('bad doc id');
    return { project: id.slice(0, idx), relPath: id.slice(idx + 1) };
  }

  async open(id: string): Promise<OpenDoc> {
    const existing = this.docs.get(id);
    if (existing) return existing;
    const t0 = performance.now();
    const doc = this.openCold(id);
    console.log(`[docs] opened ${id} in ${Math.round(performance.now() - t0)} ms`);
    return doc;
  }

  private openCold(id: string): OpenDoc {
    const { project, relPath } = DocManager.parseId(id);
    if (!relPath.endsWith('.lyx')) throw new Error('not a LyX file');
    const absPath = resolveProjectPath(project, relPath);
    if (!fs.existsSync(absPath)) throw new Error('file not found: ' + id);
    const doc = new OpenDoc(id, project, relPath, absPath);
    const text = readLyxFile(absPath);
    if (!looksLikeLyx(text, parseLyx(text))) throw new Error('not a LyX document: ' + id);
    const hash = sha1(text);
    doc.fileHash = hash;
    doc.fileText = text;
    knownHashes.set(absPath, hash);
    const row = db.prepare('SELECT state, file_hash, epoch FROM ydocs WHERE id = ?').get(id) as { state: Buffer; file_hash: string; epoch: string | null } | undefined;
    if (!row) return this.openFresh(doc, text);
    let ok = false;
    try {
      Y.applyUpdate(doc.ydoc, new Uint8Array(row.state), 'db');
      if (row.epoch) doc.epoch = row.epoch;
      if (row.file_hash !== hash) {
        // the file changed while the document was not open (desktop LyX, git, a restart with a
        // changed file): merge it into the stored history as a diff, keeping the epoch, so that
        // clients holding a local copy of this history (offline edits) can still sync
        console.log(`[docs] ${id}: file changed since last persisted state — merging`);
        doc.loadFromLyx(parseLyx(text), 'file-load');
      }
      // sanity: the state must produce exactly the file; otherwise rebuild from scratch
      ok = doc.fragment.length > 0 && sha1(doc.toLyxText()) === hash;
    } catch { ok = false; }
    if (!ok) { doc.ydoc.destroy(); return this.openFresh(doc, text); }
    doc.markSaved();
    doc.lastSavedAt = fs.statSync(absPath).mtimeMs;
    if (row.file_hash !== hash) doc.persistState();
    this.register(doc);
    return doc;
  }

  private openFresh(doc: OpenDoc, text: string): OpenDoc {
    const fresh = new OpenDoc(doc.id, doc.project, doc.relPath, doc.absPath);
    fresh.fileHash = doc.fileHash;
    fresh.fileText = text;
    const parsed = parseLyx(text);
    fresh.loadFromLyx(parsed, 'file-load');
    fresh.lastSavedAt = fs.statSync(doc.absPath).mtimeMs;
    fresh.persistState();
    this.register(fresh);
    return fresh;
  }

  private register(doc: OpenDoc): void {
    this.docs.set(doc.id, doc);
    doc.ydoc.on('update', (_u: Uint8Array, origin: unknown) => {
      if (origin === 'file-load' || origin === 'db') return;
      // updates from the WebSocket carry the connection as origin: remember who edited
      if (origin && typeof origin === 'object') { const uid = doc.connUsers.get(origin as import('ws').WebSocket); if (uid != null) doc.editors.add(uid); }
      doc.scheduleSave();
    });
    doc.touchUnload();
  }

  async unload(id: string): Promise<void> {
    const doc = this.docs.get(id);
    if (!doc || doc.conns.size) return;
    if (doc.dirty) await doc.saveToFile();
    doc.dispose();
    doc.awareness.destroy();
    doc.ydoc.destroy();
    this.docs.delete(id);
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
      if (doc.dirty) await doc.saveToFile();
      for (const c of [...doc.conns.keys()]) { doc.conns.delete(c); try { c.close(4001, 'document reset'); } catch { /* ignore */ } }
      doc.awareness.destroy();
      doc.ydoc.destroy();
      this.docs.delete(id);
    }
    db.prepare('DELETE FROM ydocs WHERE id = ?').run(id);
  }

  /** Save and close every open document of a project (before it is moved away / deleted). */
  async closeProject(project: string): Promise<void> {
    for (const doc of [...this.docs.values()]) {
      if (doc.project !== project) continue;
      if (doc.dirty) await doc.saveToFile();
      this.drop(doc, 'project removed');
    }
    db.prepare("DELETE FROM ydocs WHERE substr(id, 1, ?) = ?").run(project.length + 1, project + '/');
  }

  async saveAll(): Promise<void> {
    for (const d of this.docs.values()) if (d.dirty) await d.saveToFile();
  }
  async saveProject(project: string): Promise<void> {
    for (const d of this.docs.values()) if (d.project === project && d.dirty) await d.saveToFile();
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
    this.watcher = chokidar.watch(config.projectsDir, { ignoreInitial: true, depth: 7, awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 }, ignored: /(^|[/\\])(\.|node_modules|_build)/ });
    this.watcher.on('change', (file: string) => void this.onExternalChange(file));
    this.watcher.on('add', (file: string) => void this.onExternalChange(file));
    this.watcher.on('unlink', (file: string) => void this.onExternalRemove(file));
  }

  private async onExternalChange(file: string): Promise<void> {
    if (!file.endsWith('.lyx')) return;
    const doc = [...this.docs.values()].find(d => d.absPath === file);
    if (!doc) return;
    const wasMissing = doc.fileMissing;
    doc.fileMissing = false;
    try { doc.absorbExternalChange(); }
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
    if (!file.endsWith('.lyx')) return;
    const doc = [...this.docs.values()].find(d => d.absPath === file);
    if (!doc) return;
    doc.fileMissing = true;
    await new Promise(r => setTimeout(r, 1500));
    if (this.docs.get(doc.id) !== doc) return;
    if (fs.existsSync(file)) { doc.fileMissing = false; if (doc.dirty) doc.scheduleSave(); return; }
    console.log(`[docs] ${doc.id}: file removed on disk — closing the document (content kept as a version)`);
    doc.snapshot('file removed on disk', doc.toLyxText());
    this.drop(doc, 'document removed');
  }

  /** Forget an open document without saving it (its file is gone / the project was removed). */
  private drop(doc: OpenDoc, reason: string): void {
    doc.dispose();
    for (const c of [...doc.conns.keys()]) { doc.conns.delete(c); try { c.close(4001, reason); } catch { /* ignore */ } }
    doc.awareness.destroy();
    doc.ydoc.destroy();
    this.docs.delete(doc.id);
  }

  /* ----------------------------------------------------------- versions */

  listVersions(id: string) {
    return db.prepare('SELECT id, name, author, kind, created_at, length(lyx) AS size FROM versions WHERE doc_id = ? ORDER BY created_at DESC').all(id) as { id: number; name: string; author: string; kind: string; created_at: number; size: number }[];
  }

  async createVersion(id: string, name: string, author: string, kind = 'manual', lyx?: string): Promise<number> {
    const doc = await this.open(id);
    const text = lyx ?? doc.toLyxText();
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
    doc.loadFromLyx(parseLyx(v.lyx), 'restore');
    doc.scheduleSave();
  }
}

export const manager = new DocManager();

export function docFiles(project: string): ProjectFile[] {
  return listProjects().find(p => p.name === project)?.files ?? [];
}
