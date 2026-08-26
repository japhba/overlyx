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
import { prosemirrorJSONToYXmlFragment, yDocToProsemirrorJSON } from 'y-prosemirror';
import {
  parseLyx, writeLyx, lyxToPm, pmToLyxBody, schema, type LyxDocument, type PMJSON,
} from '@overlyx/core';
import { db } from './db.ts';
import { config } from './config.ts';
import { listProjects, resolveProjectPath, type ProjectFile } from './projects.ts';

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
  fileHash = '';
  private saveTimer: NodeJS.Timeout | null = null;
  private persistTimer: NodeJS.Timeout | null = null;
  private unloadTimer: NodeJS.Timeout | null = null;
  saving = false;
  dirty = false;
  lastAutoVersion = 0;

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

  /** Replace the whole CRDT content from a LyX document (external change / restore). */
  loadFromLyx(doc: LyxDocument, origin: string): void {
    this.ydoc.transact(() => {
      const frag = this.fragment;
      if (frag.length) frag.delete(0, frag.length);
      prosemirrorJSONToYXmlFragment(schema, lyxToPm(doc), frag);
      this.setMetaFrom(doc);
    }, origin);
  }

  scheduleSave(): void {
    this.dirty = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.saveToFile(), config.saveDebounceMs);
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.persistState(), 800);
  }

  persistState(): void {
    const state = Y.encodeStateAsUpdate(this.ydoc);
    db.prepare('INSERT INTO ydocs (id, state, file_hash, updated_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state, file_hash=excluded.file_hash, updated_at=excluded.updated_at')
      .run(this.id, Buffer.from(state), this.fileHash, Date.now());
  }

  async saveToFile(): Promise<boolean> {
    if (this.saving) { this.scheduleSave(); return false; }
    this.saving = true;
    try {
      const text = this.toLyxText();
      const hash = sha1(text);
      if (hash !== this.fileHash) {
        const tmp = this.absPath + '.overlyx-tmp';
        fs.writeFileSync(tmp, text, 'utf8');
        fs.renameSync(tmp, this.absPath);
        this.fileHash = hash;
        knownHashes.set(this.absPath, hash);
        this.maybeAutoVersion(text);
      }
      this.dirty = false;
      this.persistState();
      return true;
    } catch (e) {
      console.error('save failed', this.absPath, e);
      return false;
    } finally {
      this.saving = false;
    }
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
      this.unloadTimer = setTimeout(() => void manager.unload(this.id), 5 * 60 * 1000);
    }
  }
}

function sha1(s: string): string { return crypto.createHash('sha1').update(s).digest('hex'); }

/** hashes of file contents we last wrote / read, to distinguish our own writes from external ones */
const knownHashes = new Map<string, string>();

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
    const { project, relPath } = DocManager.parseId(id);
    if (!relPath.endsWith('.lyx')) throw new Error('not a LyX file');
    const absPath = resolveProjectPath(project, relPath);
    if (!fs.existsSync(absPath)) throw new Error('file not found: ' + id);
    const doc = new OpenDoc(id, project, relPath, absPath);
    const text = fs.readFileSync(absPath, 'utf8');
    const hash = sha1(text);
    doc.fileHash = hash;
    knownHashes.set(absPath, hash);
    const row = db.prepare('SELECT state, file_hash FROM ydocs WHERE id = ?').get(id) as { state: Buffer; file_hash: string } | undefined;
    if (row && row.file_hash === hash) {
      Y.applyUpdate(doc.ydoc, new Uint8Array(row.state), 'db');
      // sanity: the stored state must produce the same file; otherwise rebuild
      let ok = false;
      try { ok = doc.fragment.length > 0 && sha1(doc.toLyxText()) === hash; } catch { ok = false; }
      if (!ok) { doc.ydoc.destroy(); return this.openFresh(doc, text); }
    } else {
      return this.openFresh(doc, text);
    }
    this.register(doc);
    return doc;
  }

  private openFresh(doc: OpenDoc, text: string): OpenDoc {
    const fresh = new OpenDoc(doc.id, doc.project, doc.relPath, doc.absPath);
    fresh.fileHash = doc.fileHash;
    const parsed = parseLyx(text);
    fresh.loadFromLyx(parsed, 'file-load');
    fresh.persistState();
    this.register(fresh);
    return fresh;
  }

  private register(doc: OpenDoc): void {
    this.docs.set(doc.id, doc);
    doc.ydoc.on('update', (_u: Uint8Array, origin: unknown) => {
      if (origin === 'file-load' || origin === 'db') return;
      doc.scheduleSave();
    });
    doc.touchUnload();
  }

  async unload(id: string): Promise<void> {
    const doc = this.docs.get(id);
    if (!doc || doc.conns.size) return;
    if (doc.dirty) await doc.saveToFile();
    doc.awareness.destroy();
    doc.ydoc.destroy();
    this.docs.delete(id);
  }

  async saveAll(): Promise<void> {
    for (const d of this.docs.values()) if (d.dirty) await d.saveToFile();
  }

  private watch(): void {
    // watch the whole projects root so that projects created later are covered too
    this.watcher = chokidar.watch(config.projectsDir, { ignoreInitial: true, depth: 7, awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 }, ignored: /(^|[/\\])(\.|node_modules|_build)/ });
    this.watcher.on('change', (file: string) => void this.onExternalChange(file));
    this.watcher.on('add', (file: string) => void this.onExternalChange(file));
  }

  private async onExternalChange(file: string): Promise<void> {
    if (!file.endsWith('.lyx')) return;
    const doc = [...this.docs.values()].find(d => d.absPath === file);
    if (!doc) return;
    let text: string;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
    const hash = sha1(text);
    if (hash === doc.fileHash || hash === knownHashes.get(file)) return;
    console.log(`[docs] external change detected: ${doc.id} — reloading`);
    try {
      const parsed = parseLyx(text);
      doc.fileHash = hash;
      knownHashes.set(file, hash);
      doc.loadFromLyx(parsed, 'file-load');
      doc.persistState();
    } catch (e) {
      console.error('reload failed', e);
    }
  }

  /* ----------------------------------------------------------- versions */

  listVersions(id: string) {
    return db.prepare('SELECT id, name, author, kind, created_at, length(lyx) AS size FROM versions WHERE doc_id = ? ORDER BY created_at DESC').all(id) as { id: number; name: string; author: string; kind: string; created_at: number; size: number }[];
  }

  async createVersion(id: string, name: string, author: string, kind = 'manual'): Promise<number> {
    const doc = await this.open(id);
    const text = doc.toLyxText();
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
