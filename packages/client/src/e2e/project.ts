/**
 * An end-to-end encrypted project as this browser holds it (DOCS.md "End-to-end encrypted projects"):
 * its key, its manifest — the file list, itself an encrypted CRDT document (`files`: path → entry) —
 * and its files: documents (encrypted Yjs logs, opened by the editor through socket.ts) and blobs
 * (everything else, encrypted whole, immutable: a new version is a new blob). Paths, names and
 * sizes are in the manifest only, so the server sees opaque ids and byte counts.
 *
 * An .html file (a deck, a poster, a web page: deliverable/) is a document too, its text a
 * Y.Text('html') as the server's HtmlDoc keeps it; the canvas shows it from here (deckframes.ts).
 *
 * Versions of a document (the Versions panel) are its text at that time, encrypted as a blob and
 * listed in the manifest (`versions`), made by hand or every ten minutes while someone edits it here.
 *
 * localapi.ts answers the app's API requests for such a project from here; the editor finds its
 * documents' ids here (socket.ts).
 */
import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { projectOfDoc, isMarkdownPath, type LyxDocument } from '@overlyx/core';
import { projectKey, createProjectKey, waitingMembers, rotateIfNeeded, keyApi, KeyMissing, type Keyring } from './keys';
import { ensureAccountKeys } from './ui';
import { roles } from './known';
export { noteProjects, markE2eProject, isE2eProject, isE2eDocId, knownE2eProjects } from './known';
import { syncDoc, fetchDoc, seedDoc, REMOTE } from './relay';
import { randomId } from './crypto';
import type { TexContext, LocalProjectView } from './texlocal';

type TexLocal = typeof import('./texlocal');
let X: TexLocal | null = null;
/** the parser, the writer and LyX's library: loaded with the first document of an encrypted project (they are big) */
export async function tex(): Promise<TexLocal> {
  if (!X) { const m = await import('./texlocal'); await m.ensureLyxLib(); X = m; }
  return X;
}
const T = (): TexLocal => { if (!X) throw new Error('the document tools are not loaded yet'); return X; };

export interface FileEntry { id: string; kind: 'doc' | 'blob' | 'dir'; size: number; mtime: number; /** a document without a preamble of its own (a child document) */ fragment?: boolean }
/** a version of a document: its text kept as a blob (`blob`) */
export interface VersionEntry { id: number; name: string; author: string; kind: 'manual' | 'auto'; created_at: number; size: number; blob: string }
/** automatic versions while editing: one per this many ms at most, this many kept per document */
const AUTO_VERSION_MS = 10 * 60 * 1000, AUTO_VERSIONS_KEPT = 60;
/** the project file as the app lists it (api.ts ProjectFile) */
export interface ListedFile { path: string; name: string; size: number; mtime: number; kind: 'doc' | 'lyx' | 'bib' | 'image' | 'tex' | 'pdf' | 'board' | 'html' | 'dir' | 'other' }

/* ---------------------------------------------------------------------- the user */

let user: { id: number; name: string } | null = null;
export function setE2eUser(u: { id: number; name: string } | null): void { user = u; }
export function e2eUser(): { id: number; name: string } {
  if (!user) throw new Error('not signed in');
  return user;
}

/* ------------------------------------------------------------------------- file kinds */

const IMAGE = /\.(png|jpe?g|gif|svg|pdf|eps|ps|tiff?|webp|bmp)$/i;
export function listedKind(path: string, e: FileEntry): ListedFile['kind'] {
  if (e.kind === 'dir') return 'dir';
  if (e.kind === 'doc') return isHtmlDoc(path) ? 'html' : 'doc';
  const p = path.toLowerCase();
  if (p.endsWith('.lyx')) return 'lyx';
  if (p.endsWith('.bib')) return 'bib';
  if (/\.(tex|sty|cls)$/.test(p)) return 'tex';
  if (p.endsWith('.pdf')) return 'pdf';
  if (IMAGE.test(p)) return 'image';
  return 'other';
}
/** Is a file of this name a document (opened in the editor, kept as a CRDT log)? */
export const isDocPath = (path: string) => /\.tex$/i.test(path) || isMarkdownPath(path) || isHtmlDoc(path);
/** an .html document: its text is a Y.Text('html'), not a LyX document */
export const isHtmlDoc = (path: string) => /\.html?$/i.test(path);
const htmlOf = (state: Uint8Array): string => { const d = new Y.Doc(); Y.applyUpdate(d, state); const t = d.getText('html').toString(); d.destroy(); return t; };
/** `text` as the smallest splice of `t` (the common start and end kept) */
function spliceTo(t: Y.Text, text: string): void {
  const old = t.toString();
  if (old === text) return;
  let a = 0;
  while (a < old.length && a < text.length && old[a] === text[a]) a++;
  let b = 0;
  while (b < old.length - a && b < text.length - a && old[old.length - 1 - b] === text[text.length - 1 - b]) b++;
  t.doc!.transact(() => { t.delete(a, old.length - a - b); t.insert(a, text.slice(a, text.length - b)); });
}
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon', pdf: 'application/pdf', txt: 'text/plain', bib: 'text/plain', tex: 'text/plain',
  css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json', html: 'text/html', woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', csv: 'text/csv' };
export const mimeOf = (path: string) => MIME[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream';
const norm = (p: string) => p.split('/').filter(s => s && s !== '.').join('/');

/* ------------------------------------------------------------------------------ project */

export class E2eProject {
  key: Keyring | null = null;
  readonly manifest = new Y.Doc();
  readonly files = this.manifest.getMap<string>('files');
  /** `<document id>/<version id>` → VersionEntry (JSON) */
  readonly versions = this.manifest.getMap<string>('versions');
  ready: Promise<void>;
  /** the documents open in an editor here, by path (their live state) */
  readonly open = new Map<string, Y.Doc>();
  private docs = new Map<string, { at: number; state: Uint8Array; model: LyxDocument | null }>();
  private blobs = new Map<string, Uint8Array>();
  private urls = new Map<string, { id: string; url: string }>();
  private loadingUrls = new Map<string, Promise<string | null>>();
  private sync: { destroy(): void; synced(): boolean } | null = null;
  private persistence: IndexeddbPersistence | null = null;
  private listeners = new Set<() => void>();

  constructor(readonly name: string, readonly role: string, create: boolean) {
    this.ready = this.init(create);
    this.files.observe(() => { for (const l of [...this.listeners]) { try { l(); } catch (e) { console.error(e); } } });
  }

  private async init(create: boolean): Promise<void> {
    const u = e2eUser();
    this.key = create ? await createProjectKey(this.name, u.id) : await projectKey(this.name, u.id);
    // the local copy of the manifest belongs to this project's (first) key: another project made under the same name later has its own
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', this.key.first));
    const tag = [...new Uint8Array(await crypto.subtle.digest('SHA-256', raw)).subarray(0, 6)].map(b => b.toString(16).padStart(2, '0')).join('');
    try { this.persistence = new IndexeddbPersistence(`overlyx-e2e-manifest:${this.name}:${tag}`, this.manifest); await Promise.race([this.persistence.whenSynced, new Promise(r => setTimeout(r, 1500))]); }
    catch { /* no IndexedDB */ }
    await new Promise<void>(resolve => {
      const done = () => resolve();
      this.sync = syncDoc(this.name, 'manifest', this.key!, this.manifest, { readOnly: this.role === 'view', onSynced: done });
      // offline: the copy kept here
      setTimeout(done, this.files.size ? 4000 : 15000);
    });
  }

  onChange(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  entry(path: string): FileEntry | undefined {
    const v = this.files.get(norm(path));
    if (!v) return undefined;
    try { return JSON.parse(v) as FileEntry; } catch { return undefined; }
  }
  private setEntry(path: string, e: FileEntry): void { this.files.set(norm(path), JSON.stringify(e)); }

  paths(): string[] { return [...this.files.keys()].sort(); }

  /** The file list as the app shows it: entries, and the folders they are in. */
  list(): ListedFile[] {
    const out = new Map<string, ListedFile>();
    for (const path of this.paths()) {
      const e = this.entry(path);
      if (!e) continue;
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) {
        const d = parts.slice(0, i).join('/');
        if (!out.has(d)) out.set(d, { path: d, name: parts[i - 1], size: 0, mtime: e.mtime, kind: 'dir' });
      }
      out.set(path, { path, name: parts[parts.length - 1], size: e.size, mtime: e.mtime, kind: listedKind(path, e) });
    }
    return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  private get k(): Keyring { if (!this.key) throw new Error('the project is locked'); return this.key; }
  private writable(): void { if (this.role === 'view') throw Object.assign(new Error('You can only view this project'), { status: 403 }); }

  /* ------------------------------------------------------------------ documents */

  private texContext(path: string): TexContext {
    return { relPath: path, projectText: (rel) => this.cachedText(rel) };
  }

  /** A new document from its text (a template, an upload). */
  async createDoc(path: string, text: string): Promise<void> {
    this.writable();
    path = norm(path);
    if (isHtmlDoc(path)) {
      const d = new Y.Doc();
      d.getText('html').insert(0, text);
      const update = Y.encodeStateAsUpdate(d);
      d.destroy();
      const id = randomId();
      await seedDoc(this.name, id, this.k, update);
      this.docs.set(id, { at: Date.now(), state: update, model: null });
      this.setEntry(path, { id, kind: 'doc', size: text.length, mtime: Date.now() });
      return;
    }
    await tex();
    await this.prefetchTexts();
    const { update, fragment } = T().stateOfText(text, this.texContext(path));
    const id = randomId();
    await seedDoc(this.name, id, this.k, update);
    this.docs.set(id, { at: Date.now(), state: update, model: null });
    this.setEntry(path, { id, kind: 'doc', size: text.length, mtime: Date.now(), ...(fragment ? { fragment: true } : {}) });
  }

  /** The document's whole state: the editor's when it is open here, else read from its log. */
  async docState(path: string, maxAgeMs = 15000): Promise<Uint8Array> {
    const live = this.open.get(norm(path));
    if (live) return Y.encodeStateAsUpdate(live);
    const e = this.entry(path);
    if (!e || e.kind !== 'doc') throw new Error(`no document ${path}`);
    const c = this.docs.get(e.id);
    if (c && Date.now() - c.at < maxAgeMs) return c.state;
    const state = await fetchDoc(this.name, e.id, this.k);
    if (!state) { if (c) return c.state; throw new Error(`${path} could not be loaded`); }
    this.docs.set(e.id, { at: Date.now(), state, model: null });
    return state;
  }

  async docModel(path: string): Promise<LyxDocument> {
    await tex();
    const live = this.open.get(norm(path));
    if (live) return T().lyxDocumentOf(live);
    const state = await this.docState(path);
    const e = this.entry(path)!;
    const c = this.docs.get(e.id);
    if (c?.model && c.state === state) return c.model;
    const d = T().ydocOf(state);
    const model = T().lyxDocumentOf(d);
    d.destroy();
    if (c) c.model = model;
    return model;
  }

  /** Models of every document of the project (for metadata across a master and its children), synchronously readable afterwards. */
  private models = new Map<string, LyxDocument>();
  async prefetchDocs(): Promise<void> {
    await tex();
    const docs = this.paths().filter(p => this.entry(p)?.kind === 'doc' && !isHtmlDoc(p));
    await Promise.all(docs.map(async p => { try { this.models.set(p, await this.docModel(p)); } catch { /* left out */ } }));
  }
  modelNow(path: string): LyxDocument | undefined {
    const live = this.open.get(norm(path));
    return live ? T().lyxDocumentOf(live) : this.models.get(norm(path));
  }

  /** The document's text as the .tex (or .md) file would hold it. */
  async docText(path: string): Promise<string> {
    if (isHtmlDoc(path)) { const live = this.open.get(norm(path)); return live ? live.getText('html').toString() : htmlOf(await this.docState(path)); }
    await tex();
    await this.prefetchDocs();
    await this.prefetchTexts();
    return this.textOfModel(norm(path), await this.docModel(path));
  }
  private textOfModel(path: string, model: LyxDocument): string {
    const ctx = this.texContext(path);
    const master = isMarkdownPath(path) ? null : T().findMasterLocal(path, this.view());
    const fragment = !!master || !!this.entry(path)?.fragment;
    const include = (fn: string) => { const r = T().projectRel(path, fn.endsWith('.tex') || fn.includes('.') ? fn : fn + '.tex'); return r ? this.modelNow(r) : undefined; };
    return T().writeText(model, ctx, fragment, include).text;
  }
  /** A markdown document as .tex (what its PDF is built from). */
  async markdownAsTex(path: string): Promise<string> {
    await tex();
    return T().markdownTex(await this.docModel(path), this.texContext(norm(path)));
  }

  view(): LocalProjectView {
    return { doc: (rel) => this.modelNow(rel), text: (rel) => this.cachedText(rel), paths: this.paths() };
  }

  /** Bring a document to `text` as the smallest change (an upload over it, the source pane). */
  async applyText(path: string, text: string): Promise<void> {
    this.writable();
    if (isHtmlDoc(path)) {
      const live = this.open.get(norm(path));
      if (live) { spliceTo(live.getText('html'), text); return; }
      const e = this.entry(path)!;
      const d = new Y.Doc();
      Y.applyUpdate(d, await this.docState(path, 0));
      const before = Y.encodeStateVector(d);
      spliceTo(d.getText('html'), text);
      const diff = Y.encodeStateAsUpdate(d, before);
      d.destroy();
      await seedDoc(this.name, e.id, this.k, diff);
      this.docs.delete(e.id);
      this.setEntry(path, { ...e, size: text.length, mtime: Date.now() });
      return;
    }
    await tex();
    const parsed = T().parseText(text, this.texContext(norm(path))).doc;
    const live = this.open.get(norm(path));
    if (live) { T().applyLyxDocument(live, parsed); return; }
    const e = this.entry(path)!;
    const d = T().ydocOf(await this.docState(path, 0));
    const before = Y.encodeStateVector(d);
    T().applyLyxDocument(d, parsed);
    const diff = Y.encodeStateAsUpdate(d, before);
    d.destroy();
    await seedDoc(this.name, e.id, this.k, diff);
    this.docs.delete(e.id);
    this.setEntry(path, { ...e, size: text.length, mtime: Date.now() });
  }

  /* ---------------------------------------------------------------------- blobs */

  async readBlob(path: string): Promise<Uint8Array> {
    const e = this.entry(path);
    if (!e || e.kind !== 'blob') throw Object.assign(new Error(`no file ${path}`), { status: 404 });
    const hit = this.blobs.get(e.id);
    if (hit) return hit;
    const res = await fetch(`/api/e2e/projects/${encodeURIComponent(this.name)}/blobs/${e.id}`, { credentials: 'same-origin' });
    if (!res.ok) throw Object.assign(new Error(`${path} could not be loaded (${res.status})`), { status: res.status });
    const plain = await this.k.decrypt(new Uint8Array(await res.arrayBuffer()), 'blob', e.id);
    if (plain.length < 32 * 1024 * 1024) this.blobs.set(e.id, plain);
    return plain;
  }

  /** a text file's content if it is here already (texts are fetched by prefetchTexts) */
  private texts = new Map<string, string>();
  cachedText(rel: string): string | undefined {
    const e = this.entry(rel);
    if (!e || e.kind !== 'blob') return undefined;
    const b = this.blobs.get(e.id);
    return b ? new TextDecoder().decode(b) : this.texts.get(rel);
  }
  /** The project's small text files (\input'ed macros, .bib), for the parser and the metadata. */
  async prefetchTexts(): Promise<void> {
    const want = this.paths().filter(p => /\.(tex|sty|cls|bib|bst|def|cfg|txt)$/i.test(p) && this.entry(p)?.kind === 'blob' && (this.entry(p)?.size ?? 0) < 4 * 1024 * 1024);
    await Promise.all(want.map(p => this.readBlob(p).catch(() => null)));
  }

  /** Encrypt and store bytes as a new blob: its id. */
  private async putBlob(bytes: Uint8Array, path: string): Promise<string> {
    const id = randomId();
    const ct = await this.k.encrypt(bytes, 'blob', id);
    const res = await fetch(`/api/e2e/projects/${encodeURIComponent(this.name)}/blobs/${id}`, { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/octet-stream' }, body: ct.slice().buffer as ArrayBuffer });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw Object.assign(new Error(d.error ?? `could not save ${path} (${res.status})`), { status: res.status }); }
    this.blobs.set(id, bytes);
    return id;
  }

  async writeBlob(path: string, bytes: Uint8Array): Promise<void> {
    this.writable();
    path = norm(path);
    const old = this.entry(path);
    const id = await this.putBlob(bytes, path);
    this.setEntry(path, { id, kind: 'blob', size: bytes.length, mtime: Date.now() });
    this.dropUrl(path);
    if (old && old.kind === 'blob') void this.releaseBlob(old.id);
  }

  private async blobBytes(id: string): Promise<Uint8Array> {
    const hit = this.blobs.get(id);
    if (hit) return hit;
    const res = await fetch(`/api/e2e/projects/${encodeURIComponent(this.name)}/blobs/${id}`, { credentials: 'same-origin' });
    if (!res.ok) throw Object.assign(new Error(`the file could not be loaded (${res.status})`), { status: res.status });
    return this.k.decrypt(new Uint8Array(await res.arrayBuffer()), 'blob', id);
  }

  /** delete a blob nobody's entry names any more */
  private async releaseBlob(id: string): Promise<void> {
    for (const p of this.paths()) if (this.entry(p)?.id === id) return;
    this.blobs.delete(id);
    await fetch(`/api/e2e/projects/${encodeURIComponent(this.name)}/blobs/${id}`, { method: 'DELETE', credentials: 'same-origin' }).catch(() => {});
  }

  /** Any file: a blob's bytes, a document's text. */
  async readFile(path: string): Promise<Uint8Array> {
    const e = this.entry(path);
    if (e?.kind === 'doc') return new TextEncoder().encode(await this.docText(path));
    return this.readBlob(path);
  }

  /** A file uploaded or saved: a document's text becomes (or changes) a document, anything else a blob. */
  async putFile(path: string, bytes: Uint8Array): Promise<void> {
    path = norm(path);
    const e = this.entry(path);
    if (e?.kind === 'doc') { await this.applyText(path, new TextDecoder().decode(bytes)); return; }
    if (!e && isDocPath(path)) {
      const text = new TextDecoder().decode(bytes);
      // a .tex file is a document when it is one (\begin{document}); a preamble or macros file stays a text file
      if (!/\.tex$/i.test(path) || /\\begin\{document\}/.test(text)) { await this.createDoc(path, text); return; }
    }
    await this.writeBlob(path, bytes);
  }

  /* ----------------------------------------------------------------- file operations */

  private under(path: string): string[] { const p = norm(path); return this.paths().filter(q => q === p || q.startsWith(p + '/')); }

  mkdir(path: string): void { this.writable(); this.setEntry(path, { id: '', kind: 'dir', size: 0, mtime: Date.now() }); }

  rename(from: string, to: string): void {
    this.writable();
    const f = norm(from), t = norm(to);
    if (!this.under(f).length) throw Object.assign(new Error(`no file ${from}`), { status: 404 });
    if (this.entry(t)) throw Object.assign(new Error(`${to} exists already`), { status: 409 });
    this.manifest.transact(() => {
      for (const p of this.under(f)) { const v = this.files.get(p)!; this.files.delete(p); this.files.set(t + p.slice(f.length), v); }
    });
    for (const p of [...this.urls.keys()]) { const q = p.replace(/\0img$/, ''); if (q === f || q.startsWith(f + '/')) this.dropUrl(q); }
  }

  async remove(path: string): Promise<void> {
    this.writable();
    const gone = this.under(path).map(p => this.entry(p)!).filter(Boolean);
    this.manifest.transact(() => { for (const p of this.under(path)) this.files.delete(p); });
    for (const e of gone) {
      if (e.kind === 'blob') await this.releaseBlob(e.id);
      else if (e.kind === 'doc') {
        await this.dropVersions(e.id);
        await fetch(`/api/e2e/projects/${encodeURIComponent(this.name)}/docs/${e.id}`, { method: 'DELETE', credentials: 'same-origin' }).catch(() => {});
      }
    }
  }

  async copy(from: string, to: string): Promise<void> {
    this.writable();
    const f = norm(from), t = norm(to);
    for (const p of this.under(f)) {
      const e = this.entry(p)!, dest = t + p.slice(f.length);
      if (e.kind === 'doc') {
        const id = randomId();
        await seedDoc(this.name, id, this.k, await this.docState(p, 0));
        this.setEntry(dest, { ...e, id, mtime: Date.now() });
      } else this.setEntry(dest, { ...e, mtime: Date.now() });   // blobs never change: both names share it
    }
  }

  /* --------------------------------------------------------------------- versions */

  /** The document's versions, newest first. */
  versionsOf(path: string): VersionEntry[] {
    const e = this.entry(path);
    if (!e || e.kind !== 'doc') return [];
    const out: VersionEntry[] = [];
    for (const [k, v] of this.versions) if (k.startsWith(e.id + '/')) { try { out.push(JSON.parse(v) as VersionEntry); } catch { /* skip */ } }
    return out.sort((a, b) => b.created_at - a.created_at);
  }

  /** Keep the document's text as a version (`text`: given, else its text now). */
  async saveVersion(path: string, name: string, kind: VersionEntry['kind'] = 'manual', text?: string): Promise<number> {
    this.writable();
    const e = this.entry(path);
    if (!e || e.kind !== 'doc') throw Object.assign(new Error(`no document ${path}`), { status: 404 });
    const bytes = new TextEncoder().encode(text ?? await this.docText(path));
    const blob = await this.putBlob(bytes, path);
    const now = Date.now();
    const v: VersionEntry = { id: now * 1000 + Math.floor(Math.random() * 1000), name, author: e2eUser().name, kind, created_at: now, size: bytes.length, blob };
    this.versions.set(`${e.id}/${v.id}`, JSON.stringify(v));
    if (kind === 'auto') for (const old of this.versionsOf(path).filter(x => x.kind === 'auto').slice(AUTO_VERSIONS_KEPT)) void this.deleteVersion(path, old.id);
    return v.id;
  }

  async versionText(path: string, vid: number): Promise<{ text: string; version: VersionEntry }> {
    const v = this.versionsOf(path).find(x => x.id === vid);
    if (!v) throw Object.assign(new Error('no such version'), { status: 404 });
    return { text: new TextDecoder().decode(await this.blobBytes(v.blob)), version: v };
  }

  /** Bring the document back to a version (its state now kept as a version first, as the server does). */
  async restoreVersion(path: string, vid: number): Promise<void> {
    const { text, version } = await this.versionText(path, vid);
    await this.saveVersion(path, `before restore of "${version.name}"`, 'auto');
    await this.applyText(path, text);
  }

  async deleteVersion(path: string, vid: number): Promise<void> {
    this.writable();
    const e = this.entry(path);
    const v = this.versionsOf(path).find(x => x.id === vid);
    if (!e || !v) return;
    this.versions.delete(`${e.id}/${v.id}`);
    this.blobs.delete(v.blob);
    await fetch(`/api/e2e/projects/${encodeURIComponent(this.name)}/blobs/${v.blob}`, { method: 'DELETE', credentials: 'same-origin' }).catch(() => {});
  }

  /** a document's versions go with it */
  private async dropVersions(docEntryId: string): Promise<void> {
    const gone: string[] = [];
    this.manifest.transact(() => {
      for (const [k, v] of [...this.versions]) if (k.startsWith(docEntryId + '/')) { this.versions.delete(k); try { gone.push((JSON.parse(v) as VersionEntry).blob); } catch { /* skip */ } }
    });
    for (const b of gone) await fetch(`/api/e2e/projects/${encodeURIComponent(this.name)}/blobs/${b}`, { method: 'DELETE', credentials: 'same-origin' }).catch(() => {});
  }

  private autoTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** An edit made here: an automatic version a while after it, when the newest is older than ten minutes. */
  editedHere(path: string): void {
    if (this.role === 'view' || this.autoTimers.has(path)) return;
    this.autoTimers.set(path, setTimeout(() => {
      this.autoTimers.delete(path);
      const newest = this.versionsOf(path)[0]?.created_at ?? 0;
      if (Date.now() - newest < AUTO_VERSION_MS || !this.open.has(path)) return;
      void this.saveVersion(path, 'autosave', 'auto').catch(e => console.warn('[e2e] automatic version', e));
    }, 60 * 1000));
  }

  /* ------------------------------------------------------------ figures as URLs */

  private dropUrl(path: string): void {
    for (const slot of [path, path + '\0img']) {
      const u = this.urls.get(slot);
      if (u) { URL.revokeObjectURL(u.url); this.urls.delete(slot); }
    }
  }

  /** A URL of the file's content made here (an object URL; `image`: a PDF as its first page), if it is made already; else null — `loadUrl` makes it. */
  urlNow(path: string, image = false): string | null {
    const e = this.entry(path), u = this.urls.get(norm(path) + (image ? '\0img' : ''));
    return e && u && u.id === e.id ? u.url : null;
  }

  /** Make the file's object URL (a PDF figure as an image of its first page when `image`). */
  loadUrl(path: string, image = false): Promise<string | null> {
    path = norm(path);
    const now = this.urlNow(path, image);
    if (now) return Promise.resolve(now);
    const slot = path + (image ? '\0img' : '');
    const busy = this.loadingUrls.get(slot);
    if (busy) return busy;
    const p = (async () => {
      const e = this.entry(path);
      if (!e || e.kind === 'dir') return null;
      let bytes = await this.readFile(path);
      let type = mimeOf(path);
      if (image && type === 'application/pdf') { const png = await pdfFirstPage(bytes); if (png) { bytes = png; type = 'image/png'; } }
      const url = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type }));
      const old = this.urls.get(slot);
      if (old) URL.revokeObjectURL(old.url);
      this.urls.set(slot, { id: e.id, url });
      return url;
    })().finally(() => this.loadingUrls.delete(slot));
    this.loadingUrls.set(slot, p);
    return p;
  }

  destroy(): void {
    for (const t of this.autoTimers.values()) clearTimeout(t);
    this.sync?.destroy();
    void this.persistence?.destroy();
    for (const u of this.urls.values()) URL.revokeObjectURL(u.url);
    this.manifest.destroy();
  }
}

/** a PDF figure's first page as a PNG (graphics in the editor) */
async function pdfFirstPage(bytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc ||= new URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url).toString();
    const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
    const page = await doc.getPage(1);
    const vp = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
    await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport: vp } as never).promise;
    const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/png'));
    void doc.cleanup();
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } catch (e) { console.warn('[e2e] PDF figure', e); return null; }
}

/* ---------------------------------------------------------------------------- registry */

const projects = new Map<string, E2eProject>();

/**
 * The project, opened (its key unwrapped, its manifest synced) on first use. When this browser does
 * not hold the account's keys yet, the person is asked (setup / recovery code) unless `prompt: false`.
 */
export async function openE2eProject(name: string, opts: { create?: boolean; prompt?: boolean; /** the document being opened (opened once a waited-for key comes) */ doc?: string } = {}): Promise<E2eProject> {
  try { return await openOnce(name, opts); }
  catch (e) {
    if (e instanceof KeyMissing && opts.doc) waitedDoc.set(name, opts.doc);
    if (e instanceof KeyMissing && e.reason === 'account' && opts.prompt !== false && await ensureAccountKeys(e2eUser().id)) {
      try { return await openOnce(name, opts); } catch (e2) { if (e2 instanceof KeyMissing && e2.reason === 'waiting') tellWaiting(name); throw e2; }
    }
    if (e instanceof KeyMissing && e.reason === 'waiting' && opts.prompt !== false) tellWaiting(name);
    throw e;
  }
}

/** what the person is told about keys (the web app sets it: e2e/install.ts) */
export const keyNotices = {
  /** this account is a member but holds no key yet */
  waiting: (_project: string) => {},
  /** others wait for the key this account holds */
  othersWaiting: (_project: string, _names: string[]) => {},
  /** the key this account waited for has come (`doc`: the document that could not be opened without it) */
  granted: (_project: string, _doc: string | null) => {},
};
const told = new Set<string>();
const waitedDoc = new Map<string, string>();
/** Tell the person they wait for the key, and watch for it (a member gives it in their Share dialog). */
function tellWaiting(project: string): void {
  if (told.has(project)) return;
  told.add(project);
  keyNotices.waiting(project);
  const poll = setInterval(() => {
    void keyApi.projectKeys(project).then(info => {
      if (!info.mine.length) return;
      clearInterval(poll);
      told.delete(project);
      keyNotices.granted(project, waitedDoc.get(project) ?? null);
      waitedDoc.delete(project);
    }).catch(e => { if ((e as { status?: number }).status === 403 || (e as { status?: number }).status === 404) clearInterval(poll); });
  }, 8000);
}
function openOnce(name: string, opts: { create?: boolean }): Promise<E2eProject> {
  let p = projects.get(name);
  if (!p) {
    p = new E2eProject(name, roles.get(name) ?? (opts.create ? 'owner' : 'edit'), !!opts.create);
    projects.set(name, p);
    const mine = p;
    p.ready.catch(() => { if (projects.get(name) === mine) { projects.delete(name); mine.destroy(); } });
    // someone who held the key left: a new one for those who stay; a member waiting for the key this
    // account holds is told about once a session
    if (mine.role !== 'view') void p.ready.then(() => rotateIfNeeded(name, e2eUser().id).catch(e => console.warn('[e2e] the key could not be replaced', e)))
      .then(() => waitingMembers(name)).then(w => { if (w.length) keyNotices.othersWaiting(name, w.map(m => m.name)); }).catch(() => {});
  }
  return p.ready.then(() => p!);
}

/** the project if it is open and ready here (synchronous callers: figure URLs) */
export function openedE2eProject(name: string): E2eProject | undefined { return projects.get(name); }
/** whether this browser has opened the project (it holds its key) */
export function e2eProjectUnlocked(name: string): boolean { return !!projects.get(name)?.key; }

export function closeE2eProjects(): void { for (const p of projects.values()) p.destroy(); projects.clear(); }

/** The editor registers the documents it has open (their live state is what compiles and metadata read). */
export function registerOpenDoc(docId: string, ydoc: Y.Doc): () => void {
  const project = projectOfDoc(docId), path = docId.slice(project.length + 1);
  let off = false;
  // (an edit typed here, not one that came from the relay: automatic versions)
  const onUpdate = (_u: Uint8Array, _origin: unknown, _d: Y.Doc, tr: Y.Transaction) => { if (tr.local) projects.get(project)?.editedHere(path); };
  void openE2eProject(project).then(p => { if (!off) { p.open.set(path, ydoc); ydoc.on('update', onUpdate); } }).catch(() => {});
  return () => { off = true; ydoc.off('update', onUpdate); const p = projects.get(project); if (p?.open.get(path) === ydoc) p.open.delete(path); };
}

export { REMOTE };
