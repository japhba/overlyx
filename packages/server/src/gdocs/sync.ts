/**
 * Google Docs sync: a document linked to a Google Doc is kept in step with it, both ways.
 *
 * A sync (one at a time per document):
 *  1. reads the Google Doc; what changed there since the last sync (its blocks against the ones
 *     stored then) comes into the document as tracked changes by the Google Docs editor — through
 *     the agents' edit path (docedit.ts applyTrackedSource), so edits made here meanwhile stay;
 *  2. writes the document into the Google Doc, word by word where paragraphs changed (edits.ts) —
 *     comments anchored in Google Docs stay where they are. Formulas and images reach Google Docs
 *     only through a DOCX upload (the Docs API cannot insert an equation): when the ones here differ
 *     from the Google Doc's — or an older text link still shows them as `$…$` — the whole document
 *     is uploaded into the same Google Doc again (reexport), which turns them into native equations
 *     and images. The open comment threads go along as Word comments, so Google anchors them at
 *     their text again; the sync takes those comments over and deletes the old ones (adoptComments);
 *  3. syncs comment threads: a Google comment becomes a thread at the text it quotes, a thread
 *     written here a Google comment (anchored where the API allows), replies and resolving both ways;
 *  4. remembers the document's text and the Google Doc's blocks as the base of the next sync.
 *
 * Linked documents sync on their own (`auto`): a minute after an edit here, and when Drive says the
 * Google Doc changed. The sync acts with the Drive authorisation of whoever linked the document.
 *
 * Tabs: a link may name a tab of the Google Doc (`tab_id`; a link made by creating a Google Doc
 * names none and syncs the first). The sync then reads every tab (includeTabsContent), works on
 * that tab's body as a document of its own (model.ts tabDocument) and aims its requests at it
 * (edits.ts inTab). The tabs of one Google Doc are a document group here (importing.ts); comments
 * belong to a file, not to a tab, so each Google comment goes to the tab whose text holds what it
 * quotes (the group's first tab when none does), once — a comment one tab took stays that tab's.
 */
import { addAuthor, commentHeader, formatTimestamp, lyxAuthorId, parseThread, type Item, type LyxDocument, type Paragraph, type TextInset } from '@overlyx/core';
import fs from 'node:fs';
import { splitDocId } from '@overlyx/core';
import { isMarkdownPath } from '@overlyx/core/md/index.ts';
import { resolveProjectPath } from '../projectfiles.ts';
import { db } from '../db.ts';
import { manager, type OpenDoc } from '../docs.ts';
import { project, readGoogle, strip, toParagraphs, blockKey, itemRuns, nativeKeys, hasUnknownObjects, MEDIA_WARNING, UNKNOWN_WARNING, flatTabs, tabDocument, type DocsDocument, type DocsFile, type GBlock, type Projection } from './model.ts';
import { planRound, inTab } from './edits.ts';
import { buildDocx, markThreads } from './docx.ts';
import { attachObjectSources, bindImportedObjects, type ObjectBindings } from './native.ts';
import { reconcileGroup } from './importing.ts';
import { googleApi, GoogleAuthError, type GComment, type GoogleApi } from './google.ts';
import { roleFor, atLeast } from '../access.ts';
import { toSessionUser } from '../auth.ts';
import type { UserRow } from '../db.ts';

db.exec(`
CREATE TABLE IF NOT EXISTS gdocs_links (
  doc_id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  url TEXT,
  base_text TEXT,
  base_google TEXT,
  comments TEXT,
  auto INTEGER NOT NULL DEFAULT 1,
  last_sync INTEGER,
  last_error TEXT,
  last_version TEXT,
  created_at INTEGER NOT NULL
);
`);
// (tab_id: the tab a link syncs with — none: the Google Doc's first)
const linkColumns = new Set((db.prepare('PRAGMA table_info(gdocs_links)').all() as { name: string }[]).map(c => c.name));
for (const [name, type] of [['format', "TEXT NOT NULL DEFAULT 'text'"], ['objects', 'TEXT'], ['last_warnings', 'TEXT'], ['tab_id', 'TEXT']]) {
  if (!linkColumns.has(name)) db.exec(`ALTER TABLE gdocs_links ADD COLUMN ${name} ${type}`);
}

export interface LinkRow {
  doc_id: string; file_id: string; user_id: number; url: string | null;
  base_text: string | null; base_google: string | null; comments: string | null;
  auto: number; last_sync: number | null; last_error: string | null; last_version: string | null; created_at: number;
  format: 'text' | 'docx'; objects: string | null; last_warnings: string | null;
  tab_id: string | null;
}

export function linkOf(docId: string): LinkRow | null {
  return (db.prepare('SELECT * FROM gdocs_links WHERE doc_id = ?').get(docId) as LinkRow | undefined) ?? null;
}

export function publicLink(l: LinkRow | null) {
  if (!l) return null;
  const url = l.url ?? `https://docs.google.com/document/d/${l.file_id}/edit`;
  return { fileId: l.file_id, tabId: l.tab_id, url: l.tab_id ? `${url.replace(/[?#].*$/, '')}?tab=${encodeURIComponent(l.tab_id)}` : url, auto: !!l.auto, lastSync: l.last_sync, lastError: l.last_error, linkedBy: l.user_id, format: l.format, warnings: l.last_warnings ? JSON.parse(l.last_warnings) as string[] : [] };
}

/** the links to one Google Doc (the documents of its tabs) */
export function linksOfFile(fileId: string): LinkRow[] {
  return db.prepare('SELECT * FROM gdocs_links WHERE file_id = ?').all(fileId) as LinkRow[];
}

/** A link with its base: what both sides held at the "last sync" (the next sync takes the differences from there). */
export function insertLink(l: { docId: string; fileId: string; userId: number; url: string | null; tabId: string | null; baseText: string | null; baseGoogle: GBlock[] | null; version: string | null }): void {
  db.prepare('INSERT OR REPLACE INTO gdocs_links (doc_id, file_id, user_id, url, tab_id, base_text, base_google, auto, last_sync, last_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)')
    .run(l.docId, l.fileId, l.userId, l.url, l.tabId, l.baseText, l.baseGoogle ? JSON.stringify(l.baseGoogle) : null, l.baseText === null ? null : Date.now(), l.version, Date.now());
}

/** the API a link syncs with (tests put a simulation here) */
let apiFor: (userId: number) => GoogleApi = googleApi;
/** (the e2e tests' Google, one simulation for everybody: routes.ts sets it up) */
export function googleApiFor(userId: number): GoogleApi { return apiFor(userId); }
export function setGoogleApiFactory(f: (userId: number) => GoogleApi): void { apiFor = f; }

/* ------------------------------------------------------------------ linking */

/** Link the document to a new Google Doc (in the Drive of `userId`) and write the document into it. */
const linking = new Map<string, Promise<LinkRow>>();
export function linkNewGoogleDoc(docId: string, userId: number, title: string): Promise<LinkRow> {
  if (!linkerMayEdit({ doc_id: docId, user_id: userId })) return Promise.reject(new Error('The person who linked this document to Google Docs may not edit it any more'));
  const pending = linking.get(docId);
  if (pending) return pending;
  const task = createLink(docId, userId, title);
  linking.set(docId, task);
  void task.finally(() => { if (linking.get(docId) === task) linking.delete(docId); }).catch(() => undefined);
  return task;
}

async function createLink(docId: string, userId: number, title: string): Promise<LinkRow> {
  const existing = linkOf(docId);
  if (existing) return existing;
  const api = apiFor(userId);
  if (api.importDocument) {
    const doc = await manager.open(docId);
    const snapshot = doc.toLyxDocument(), baseText = doc.textOf(snapshot);
    const file = await api.importDocument(title, await buildDocx(snapshot, doc.project, doc.relPath, { comments: true }));
    let raw = await api.getDocument(file.id);
    const { bindings, requests } = bindImportedObjects(raw, project(snapshot, true).blocks);
    if (requests.length) {
      await api.batchUpdate(file.id, requests, raw.revisionId || undefined);
      raw = await api.getDocument(file.id);
    }
    raw = attachObjectSources(raw, bindings);
    if (hasUnknownObjects(strip(readGoogle(raw).blocks))) throw new Error('The imported Google Doc could not be matched to its images or equations; it was left unlinked.');
    if (!linkerMayEdit({ doc_id: docId, user_id: userId })) throw new Error('The person who linked this document to Google Docs may not edit it any more');
    db.prepare(`INSERT INTO gdocs_links (doc_id, file_id, user_id, url, auto, created_at, format, objects, base_text, base_google) VALUES (?, ?, ?, ?, 1, ?, 'docx', ?, ?, ?)`)
      .run(docId, file.id, userId, file.webViewLink ?? null, Date.now(), JSON.stringify(bindings), baseText, JSON.stringify(strip(readGoogle(raw).blocks)));
    await adoptComments(api, linkOf(docId)!, snapshot, new Set());
    await syncDoc(docId);
    return linkOf(docId)!;
  }
  // The e2e/legacy simulation has no Word converter. Real Google always takes the DOCX path.
  const file = await api.createDocument(title);
  db.prepare('INSERT OR REPLACE INTO gdocs_links (doc_id, file_id, user_id, url, auto, created_at) VALUES (?, ?, ?, ?, 1, ?)')
    .run(docId, file.id, userId, file.webViewLink ?? `https://docs.google.com/document/d/${file.id}/edit`, Date.now());
  await syncDoc(docId);
  return linkOf(docId)!;
}

/**
 * Link the document to a Google Doc that exists (picked in Google's picker — what gives the
 * `drive.file` authorisation access to it), to `tabId` or its first tab. Neither side is
 * overwritten: the base is the document as it is on both sides, so the first sync brings what the
 * Google Doc holds differently as tracked changes by the Google side, to accept or reject here.
 */
export async function linkExistingGoogleDoc(docId: string, userId: number, fileId: string, tabId: string | null): Promise<LinkRow> {
  const api = apiFor(userId);
  const [file, whole] = await Promise.all([api.getFile(fileId), api.getDocumentTabs(fileId)]);
  if (file.trashed) throw new Error('That Google Doc is in the trash');
  const tab = tabId ?? flatTabs(whole)[0]?.id ?? null;
  if (!tab || !tabDocument(whole, tab)) throw new Error('That Google Doc has no such tab');
  const doc = await manager.open(docId);
  const ours = doc.toLyxDocument();
  insertLink({ docId, fileId, userId, url: file.webViewLink ?? null, tabId: tab, baseText: doc.textOf(ours), baseGoogle: strip(project(ours).blocks), version: null });
  await syncDoc(docId);
  return linkOf(docId)!;
}

export function unlink(docId: string): void { db.prepare('DELETE FROM gdocs_links WHERE doc_id = ?').run(docId); }
export function setAuto(docId: string, auto: boolean): void { db.prepare('UPDATE gdocs_links SET auto = ? WHERE doc_id = ?').run(auto ? 1 : 0, docId); }

/* ------------------------------------------------------------------ the sync */

/** `warnings`: what was left out of the sync; `notes`: what it did besides the text (a tab of the Google Doc that became a document) */
export interface SyncReport { pulled: number; pushed: number; rounds: number; comments: { fromGoogle: number; toGoogle: number }; warnings: string[]; notes: string[] }

const running = new Map<string, Promise<SyncReport>>();

/** Sync a linked document now (a sync already running is waited for, then this one runs). */
export function syncDoc(docId: string): Promise<SyncReport> {
  const prev = running.get(docId) ?? Promise.resolve(null);
  const p = prev.catch(() => null).then(() => runSync(docId));
  running.set(docId, p);
  void p.catch(() => null).finally(() => { if (running.get(docId) === p) running.delete(docId); });
  return p;
}

/**
 * Whether the person who linked the document may still edit it: a collaborator removed from the
 * project (or made a viewer) must not keep its text flowing to and from their Google Doc.
 */
function linkerMayEdit(link: Pick<LinkRow, 'doc_id' | 'user_id'>): boolean {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(link.user_id) as UserRow | undefined;
  if (!row) return false;
  return atLeast(roleFor(toSessionUser(row), splitDocId(link.doc_id).project), 'edit');
}

async function runSync(docId: string): Promise<SyncReport> {
  const link = linkOf(docId);
  if (!link) throw new Error('This document is not linked to a Google Doc');
  if (!linkerMayEdit(link)) { unlink(docId); throw new Error('The person who linked this document to Google Docs may not edit it any more: the link is removed'); }
  const api = apiFor(link.user_id);
  const report: SyncReport = { pulled: 0, pushed: 0, rounds: 0, comments: { fromGoogle: 0, toGoogle: 0 }, warnings: [], notes: [] };
  try {
    const doc = await manager.open(docId);
    const markdown = isMarkdownPath(doc.relPath);
    const file = await api.getFile(link.file_id);
    if (file.trashed) throw new Error('The Google Doc is in the trash — restore it, or unlink the document');
    let bindings: ObjectBindings = link.objects ? JSON.parse(link.objects) : {};
    let native = link.format === 'docx';
    // a link to a tab: the tab's body as the document to sync (every tab read: the comments are shared out by their text)
    let whole = null as DocsFile | null;
    const readRaw = async (): Promise<DocsDocument> => {
      if (!link.tab_id) return attachObjectSources(await api.getDocument(link.file_id), bindings);
      whole = await api.getDocumentTabs(link.file_id);
      const t = tabDocument(whole, link.tab_id);
      if (!t) { unlink(docId); throw new Error('Its tab was deleted from the Google Doc: this document is no longer synced (it stays as it is)'); }
      return attachObjectSources(t, bindings);
    };
    const aimed = (requests: ReturnType<typeof planRound>) => (link.tab_id ? inTab(requests, link.tab_id) : requests);
    let raw = await readRaw();
    const gNow = strip(readGoogle(raw).blocks);
    if (hasUnknownObjects(gNow)) report.warnings.push(UNKNOWN_WARNING);

    // 1. what was changed in Google Docs since the last sync: tracked changes here
    if (link.base_google && link.base_text !== null) {
      const baseG = JSON.parse(link.base_google) as GBlock[];
      if (!sameBlocks(baseG, gNow)) {
        const baseDoc = doc.parse(link.base_text);
        const theirs = withGoogleChanges(baseDoc, project(baseDoc, native), baseG, gNow, markdown, report.warnings);
        if (theirs) {
          const author = `${file.lastModifyingUser?.displayName || 'Google Docs'} (Google Docs)`;
          const tracking = isTracking(doc.getMeta().headerLines);
          const r = await doc.agentEdit('tracked', link.base_text, { after: doc.textOf(theirs) }, { author });
          report.pulled = r.result.inserted + r.result.deleted;
          // the agents' edit path turns change tracking on; Google's changes are tracked, the document's mode stays
          const lines = doc.getMeta().headerLines;
          if (isTracking(lines) !== tracking) {
            const fixed = lines.map(l => (/^\\tracking_changes\b/.test(l) ? `\\tracking_changes ${tracking}` : l));
            doc.ydoc.transact(() => { doc.meta.set('header', JSON.stringify(fixed)); }, 'header');
          }
        }
      }
    }

    // 2. the document into the Google Doc: formulas and images by a DOCX upload when they differ, then the text
    const ours = doc.toLyxDocument();
    const uploaded = await reexport(api, link, doc, ours, raw, gNow, report);
    if (uploaded) { raw = uploaded.raw; bindings = uploaded.bindings; native = true; }
    const want = strip(project(ours, native).blocks);
    for (; report.rounds < 10; report.rounds++) {
      const requests = planRound(raw, want, report.warnings);
      if (!requests.length) break;
      await api.batchUpdate(link.file_id, aimed(requests), raw.revisionId || undefined);
      report.pushed += requests.length;
      raw = await readRaw();
    }
    if (report.rounds >= 10) report.warnings.push('The Google Doc could not be brought fully in line in one sync');

    // 3. comment threads, both ways (a thread from Google Docs changes the document)
    const { doc: withComments, changed } = await syncComments(api, link, ours, raw, report, whole ? commentScope(link, whole) : undefined);
    if (changed) await doc.agentEdit('plain', doc.textOf(ours), { after: doc.textOf(withComments) });

    // 4. the base of the next sync: the document as written to Google (with the comment threads), the Google Doc as it is now
    const after = await api.getFile(link.file_id);
    report.warnings = [...new Set(report.warnings)];
    db.prepare('UPDATE gdocs_links SET base_text = ?, base_google = ?, comments = ?, last_sync = ?, last_error = NULL, last_version = ?, last_warnings = ? WHERE doc_id = ?')
      .run(doc.textOf(withComments), JSON.stringify(strip(readGoogle(raw).blocks)), link.comments, Date.now(), after.version ?? null, JSON.stringify(report.warnings), docId);
    // the tabs of a Google Doc that is a group here: tabs made there since become documents, titles and order follow
    if (whole) { const g = await reconcileGroup(docId, link, whole); report.warnings.push(...g.warnings); report.notes.push(...g.notes); }
    return report;
  } catch (e) {
    db.prepare('UPDATE gdocs_links SET last_error = ?, last_sync = ? WHERE doc_id = ?').run((e as Error).message, Date.now(), docId);
    throw e;
  }
}

/** a DOCX upload that failed, by document: for these formulas and images (not tried again until they change) */
const reexportFailed = new Map<string, string>();

/**
 * Upload the document into its Google Doc again as DOCX when the formulas and images here differ from
 * the Google Doc's (an older text link: when there are any) — the only way they become native Google
 * Docs equations and images. Never over a Google Doc this would take something from: another tab,
 * images or equations made in Google Docs, suggestions still open there, or changes made there since
 * `raw` was read (the next sync brings them in first). Returns the Google Doc as uploaded, with its
 * objects bound to their sources, or null when nothing was uploaded.
 */
async function reexport(api: GoogleApi, link: LinkRow, doc: OpenDoc, ours: LyxDocument, raw: DocsDocument, gNow: GBlock[], report: SyncReport): Promise<{ raw: DocsDocument; bindings: ObjectBindings } | null> {
  if (!api.replaceWithDocx) return null;
  const blocks = project(ours, true).blocks;
  const mine = JSON.stringify(nativeKeys(strip(blocks)));
  if (link.format === 'docx' ? mine === JSON.stringify(nativeKeys(gNow)) : mine === '[]') return null;
  if (link.tab_id || hasUnknownObjects(gNow)) return null;   // planRound / the pull say what was left out
  if (/"suggested(Insertion|Deletion)Ids":\[\s*"/.test(JSON.stringify(raw.body))) { report.warnings.push('Formulas and images were not exported: the Google Doc has open suggestions — accept or reject them there first.'); return null; }
  if (reexportFailed.get(link.doc_id) === mine) { report.warnings.push(MEDIA_WARNING); return null; }
  const now = await api.getDocument(link.file_id);
  if (raw.revisionId && now.revisionId !== raw.revisionId) return null;   // edited in Google Docs just now
  const before = new Set((await api.listComments(link.file_id)).map(c => c.id));
  try {
    await api.replaceWithDocx(link.file_id, await buildDocx(ours, doc.project, doc.relPath, { comments: true }));
  } catch (e) {
    reexportFailed.set(link.doc_id, mine);
    report.warnings.push(`Formulas and images could not be exported to the Google Doc: ${(e as Error).message}`);
    return null;
  }
  let fresh = await api.getDocument(link.file_id);
  let bindings: ObjectBindings = {};
  try {
    const b = bindImportedObjects(fresh, blocks);
    if (b.requests.length) {
      await api.batchUpdate(link.file_id, b.requests, fresh.revisionId || undefined);
      fresh = await api.getDocument(link.file_id);
    }
    bindings = b.bindings;
  } catch {
    // uploaded, but its objects do not line up with the document's: they stay out of the sync (unknown objects) until they change here
    reexportFailed.set(link.doc_id, mine);
    report.warnings.push(UNKNOWN_WARNING);
  }
  const objects = JSON.stringify(bindings);
  db.prepare("UPDATE gdocs_links SET format = 'docx', objects = ? WHERE doc_id = ?").run(objects, link.doc_id);
  link.format = 'docx';
  link.objects = objects;
  report.notes.push('formulas and images uploaded to the Google Doc');
  await adoptComments(api, link, ours, before, report);
  return { raw: attachObjectSources(fresh, bindings), bindings };
}

/**
 * After a DOCX upload that carried the open threads as Word comments (buildDocx `comments`): each
 * thread takes over the comment Google made of its Word comment — anchored at its text — with its
 * replies posted again, and the comment it had before is deleted (resolved where Drive does not
 * allow that). Comments the upload made that match no thread are deleted too. Comments that appeared
 * meanwhile from anybody else are left alone (the sync takes them in as usual). The comments let go
 * stay in the map, closed, so that the sync never takes them for new ones. `before`: the comment ids
 * before the upload.
 */
async function adoptComments(api: GoogleApi, link: LinkRow, ours: LyxDocument, before: Set<string>, report?: SyncReport): Promise<void> {
  const made = (await api.listComments(link.file_id)).filter(c => !before.has(c.id) && !c.deleted && c.author?.me !== false);
  if (!made.length) return;
  const map: ThreadEntry[] = link.comments ? JSON.parse(link.comments) : [];
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const free = new Set(made.map(c => c.id));
  const retire = async (gid: string) => {
    try { if (!api.deleteComment) throw new Error('no delete'); await api.deleteComment(link.file_id, gid); }
    catch { await api.createReply(link.file_id, gid, { action: 'resolve' }).catch(() => undefined); }
  };
  let moved = 0;
  for (const t of markThreads(ours).threads) {
    const c = made.find(x => free.has(x.id) && norm(x.content ?? '') === norm(t.content));
    if (!c) continue;
    free.delete(c.id);
    const sig = msgSig(t.messages[0]);
    const entry: ThreadEntry = { gid: c.id, sig, replies: (c.replies ?? []).map(r => r.id), msgs: [sig], resolved: false };
    for (const m of t.messages.slice(1)) {
      const r = await api.createReply(link.file_id, c.id, { content: `${m.author}: ${m.text}` });
      entry.replies.push(r.id);
      entry.msgs.push(msgSig(m));
    }
    for (const old of map.filter(e => !e.closed && e.sig === sig)) { await retire(old.gid); old.closed = true; }
    map.push(entry);
    moved++;
  }
  for (const gid of free) { await retire(gid); map.push({ gid, sig: '', replies: [], msgs: [], resolved: true, closed: true }); }
  link.comments = JSON.stringify(map);
  // at once: a sync that fails later must not take the new comments for comments made in Google Docs
  db.prepare('UPDATE gdocs_links SET comments = ? WHERE doc_id = ?').run(link.comments, link.doc_id);
  if (moved) report?.notes.push(`${moved} comment${moved === 1 ? '' : 's'} anchored in the Google Doc again`);
}

const isTracking = (lines: string[]) => lines.includes('\\tracking_changes true');

const sameBlocks = (a: GBlock[], b: GBlock[]) => a.length === b.length && a.every((x, i) => blockKey(x) === blockKey(b[i]));

/**
 * The base document with the changes made in Google Docs: the regions where the Google Doc's blocks
 * now differ from the ones stored at the last sync, mapped to the base document's paragraphs (through
 * the blocks the base document projects to) and replaced by paragraphs made from the new blocks.
 * Null when nothing maps (no change).
 */
export function withGoogleChanges(baseDoc: LyxDocument, proj: Projection, baseG: GBlock[], gNow: GBlock[], markdown: boolean, warnings: string[] = []): LyxDocument | null {
  const kBase = baseG.map(blockKey), kNow = gNow.map(blockKey), kProj = proj.blocks.map(blockKey);
  const changes = lcsRegions(kBase, kNow);
  if (!changes.length) return null;
  // stored Google blocks ↔ the base document's own blocks (they match but where the base had text Google could not show)
  const toProj = new Map(lcsPairs(kBase, kProj));
  const body = baseDoc.body.slice();
  const projStart = (i: number): number => {
    // the body index the stored block i starts at (the next block that maps, else the end)
    for (let k = i; k < baseG.length; k++) { const p = toProj.get(k); if (p !== undefined) return proj.blocks[p].src; }
    return body.length;
  };
  const edits: { from: number; to: number; pars: Paragraph[] }[] = [];
  for (const { a, b, c, d } of changes) {
    const before = baseG.slice(a, b), after = gNow.slice(c, d);
    if (hasUnknownObjects([...before, ...after])) { warnings.push(UNKNOWN_WARNING); continue; }
    if (JSON.stringify(nativeKeys(before)) !== JSON.stringify(nativeKeys(after))) { warnings.push(MEDIA_WARNING); continue; }
    const srcs = new Set<number>();
    for (let k = a; k < b; k++) { const p = toProj.get(k); if (p !== undefined) srcs.add(proj.blocks[p].src); }
    const pars = toParagraphs(gNow.slice(c, d), proj.headings, markdown);
    if (srcs.size) {
      const lo = Math.min(...srcs), hi = Math.max(...srcs);
      edits.push({ from: lo, to: hi + 1, pars });
    } else if (b > a) {
      // blocks that never mapped (text Google showed differently): left alone
      continue;
    } else {
      const at = projStart(a);
      edits.push({ from: at, to: at, pars });
    }
  }
  if (!edits.length) return null;
  edits.sort((x, y) => y.from - x.from);
  for (const e of edits) {
    // a replaced paragraph keeps what Google Docs never showed of it: its notes and comment threads
    const kept = body.slice(e.from, e.to).flatMap(p => p.items.filter(isNote));
    if (kept.length && e.pars.length) e.pars[e.pars.length - 1] = { ...e.pars[e.pars.length - 1], items: [...e.pars[e.pars.length - 1].items, ...kept] };
    body.splice(e.from, e.to - e.from, ...e.pars);
  }
  return { ...baseDoc, body };
}

const isNote = (it: Item) => it.kind === 'inset' && it.inset.type === 'Text' && it.inset.name === 'Note';

function lcsPairs(a: string[], b: string[]): [number, number][] {
  const n = a.length, m = b.length, W = m + 1;
  const dp = new Uint32Array((n + 1) * W);
  for (let x = n - 1; x >= 0; x--) for (let y = m - 1; y >= 0; y--) dp[x * W + y] = a[x] === b[y] ? dp[(x + 1) * W + y + 1] + 1 : Math.max(dp[(x + 1) * W + y], dp[x * W + y + 1]);
  const out: [number, number][] = [];
  let x = 0, y = 0;
  while (x < n && y < m) {
    if (a[x] === b[y]) { out.push([x, y]); x++; y++; } else if (dp[(x + 1) * W + y] >= dp[x * W + y + 1]) x++; else y++;
  }
  return out;
}

function lcsRegions(a: string[], b: string[]): { a: number; b: number; c: number; d: number }[] {
  const out: { a: number; b: number; c: number; d: number }[] = [];
  let i = 0, j = 0;
  for (const [pi, pj] of [...lcsPairs(a, b), [a.length, b.length] as [number, number]]) {
    if (pi > i || pj > j) out.push({ a: i, b: pi, c: j, d: pj });
    i = pi + 1; j = pj + 1;
  }
  return out;
}

/* ------------------------------------------------------------------ comments */

/** Which Google comments a tab's document takes (a link to a tab of a Google Doc linked tab by tab). */
interface CommentScope { claimed: Set<string>; mine: (c: GComment) => boolean }

const norm = (t: string) => t.replace(/\s+/g, ' ').trim();

/**
 * A comment goes to the first tab whose text holds what it quotes — of the tabs linked here; to the
 * first linked tab when none does (or it quotes nothing) — unless another tab's document took it already.
 */
export function commentScope(link: LinkRow, whole: DocsFile): CommentScope {
  const linked = new Set(linksOfFile(link.file_id).map(l => l.tab_id ?? ''));
  const tabs = flatTabs(whole).filter(t => linked.has(t.id));
  const texts = new Map(tabs.map(t => [t.id, norm(readGoogle(tabDocument(whole, t.id)!).blocks.map(b => (b.t === 'p' ? b.runs.map(r => r.text).join('') : b.cells.flat(2).map(r => r.text).join(' '))).join(' '))]));
  const claimed = new Set<string>();
  for (const other of linksOfFile(link.file_id)) if (other.doc_id !== link.doc_id && other.comments) for (const e of JSON.parse(other.comments) as ThreadEntry[]) claimed.add(e.gid);
  return {
    claimed,
    mine: c => {
      const q = norm(c.quotedFileContent?.value ?? '');
      const home = (q && tabs.find(t => texts.get(t.id)!.includes(q))) || tabs[0];
      return !!home && home.id === link.tab_id;
    },
  };
}

interface ThreadEntry {
  /** the Google comment */
  gid: string;
  /** the thread's first message here (author, time, text) */
  sig: string;
  /** Google replies already taken over or written by the sync */
  replies: string[];
  /** messages here already sent or taken over */
  msgs: string[];
  resolved: boolean;
  /** gone on one side: no longer synced */
  closed?: boolean;
}

const msgSig = (m: { author: string; time: string; text: string }) => `${m.author}|${m.time}|${m.text.replace(/\s+/g, ' ').trim().slice(0, 60)}`;

interface ThreadRef { inset: TextInset; par: number; before: string }

/** the comment threads of the body with their insets (to change them in place) */
function threadsOf(doc: LyxDocument): ThreadRef[] {
  const out: ThreadRef[] = [];
  doc.body.forEach((p, par) => {
    let before = '';
    for (const it of p.items) {
      if (it.kind === 'inset' && it.inset.type === 'Text' && it.inset.name === 'Note' && it.inset.arg === 'Comment') { out.push({ inset: it.inset, par, before }); continue; }
      if (it.change?.type === 'deleted') continue;
      before += itemRuns([it]).map(r => r.text).join('');
    }
  });
  return out;
}

const gTime = (iso?: string) => formatTimestamp(iso ? new Date(iso) : new Date());
const plain = (text: string) => ({ layout: 'Plain Layout', depth: 0, params: {}, items: text ? [{ kind: 'text', text, font: {} } as Item] : [] });

/** the paragraphs of a thread (core/comments.ts: "Author (time):" headers, message lines) */
function threadParagraphs(messages: { author: string; time: string; text: string }[], resolved: boolean): Paragraph[] {
  const out: Paragraph[] = [];
  messages.forEach((m, i) => {
    out.push(plain(commentHeader(m.author, m.time, resolved && i === 0)));
    for (const line of m.text.split(/\r?\n/)) out.push(plain(line));
  });
  return out;
}

/** the text of a Google comment / reply (Docs gives HTML in htmlContent; content is plain) */
const gText = (c: { content?: string }) => (c.content ?? '').trim();

/** where a comment on `quoted` goes: right after that text in the body (the end of the document when it is not found) */
function placeThread(doc: LyxDocument, quoted: string, inset: TextInset): void {
  const q = quoted.replace(/\s+/g, ' ').trim();
  const body = doc.body;
  if (q) {
    for (const p of body) {
      // the paragraph's text as Docs shows it, item by item
      const spans: { item: number; start: number; end: number }[] = [];
      let text = '';
      p.items.forEach((it, k) => {
        if (it.change?.type === 'deleted') return;
        const t = itemRuns([it]).map(r => r.text).join('');
        spans.push({ item: k, start: text.length, end: text.length + t.length });
        text += t;
      });
      const norm = text.replace(/\s+/g, ' ');
      const at = norm.indexOf(q);
      if (at < 0) continue;
      // (whitespace normalisation only shrinks runs of spaces; map the end back)
      let end = 0, seen = 0;
      for (; end < text.length && seen < at + q.length; end++) if (!(/\s/.test(text[end]) && /\s/.test(text[end - 1] ?? ''))) seen++;
      const span = spans.find(s => s.end >= end && s.start < end) ?? spans[spans.length - 1];
      const it = p.items[span.item];
      const node: Item = { kind: 'inset', font: {}, inset };
      if (it.kind === 'text' && end < span.end) {
        const cut = end - span.start;
        p.items.splice(span.item, 1, { ...it, text: it.text.slice(0, cut) }, node, { ...it, text: it.text.slice(cut) });
      } else p.items.splice(span.item + 1, 0, node);
      return;
    }
  }
  const last = [...body].reverse().find(p => p.items.length) ?? body[body.length - 1];
  last.items.push({ kind: 'inset', font: {}, inset });
}

/** the text before a thread, as a comment's quote: the end of the sentence or phrase it follows */
function quoteFor(before: string): string {
  const t = before.replace(/\s+/g, ' ').trimEnd();
  if (!t) return '';
  const cut = Math.max(t.lastIndexOf('. ', t.length - 2), t.lastIndexOf('; ', t.length - 2), t.length - 80);
  return t.slice(Math.max(0, cut > 0 ? cut + (t[cut] === '.' || t[cut] === ';' ? 2 : 0) : 0)).trim();
}

/** the body range of `quoted` in the Google Doc (for an anchored comment) */
function rangeOf(raw: import('./model.ts').DocsDocument, quoted: string): { startIndex: number; endIndex: number } | undefined {
  if (!quoted) return undefined;
  for (const s of raw.body.content) {
    if (!s.paragraph) continue;
    let text = '';
    const starts: number[] = [];
    for (const e of s.paragraph.elements) {
      const c = e.textRun?.content ?? (e.footnoteReference ? '￼' : '');
      for (let k = 0; k < c.length; k++) starts.push(e.startIndex + k);
      text += c;
    }
    const at = text.lastIndexOf(quoted);
    if (at >= 0) return { startIndex: starts[at], endIndex: starts[at + quoted.length - 1] + 1 };
  }
  return undefined;
}

/**
 * Comment threads both ways. Returns the document with the threads changed by Google Docs (new
 * comments, replies, resolved) — `changed` when there were any — and updates `link.comments`.
 */
export async function syncComments(api: GoogleApi, link: LinkRow, ours: LyxDocument, raw: import('./model.ts').DocsDocument, report: SyncReport, scope?: CommentScope): Promise<{ doc: LyxDocument; changed: boolean }> {
  const doc: LyxDocument = JSON.parse(JSON.stringify(ours));
  const map: ThreadEntry[] = link.comments ? JSON.parse(link.comments) : [];
  const comments = await api.listComments(link.file_id);
  let changed = false;
  const threads = () => threadsOf(doc);
  const find = (sig: string): ThreadRef | undefined => {
    const all = threads();
    const exact = all.find(t => { const m = parseThread(t.inset.paragraphs).messages[0]; return m && msgSig(m) === sig; });
    if (exact) return exact;
    // the first message edited here: the same author and time
    const [a, tm] = sig.split('|');
    const loose = all.filter(t => { const m = parseThread(t.inset.paragraphs).messages[0]; return m && m.author === a && m.time === tm; });
    return loose.length === 1 ? loose[0] : undefined;
  };
  const addAuthorOf = (name: string) => addAuthor(doc.header, lyxAuthorId(name, ''), name, '');

  // Google → here
  for (const c of comments) {
    let entry = map.find(e => e.gid === c.id);
    if (c.deleted) { if (entry) entry.closed = true; continue; }
    const replies = (c.replies ?? []).filter(r => !r.deleted);
    // another tab's comment (or one another tab's document took)
    if (!entry && scope && (scope.claimed.has(c.id) || !scope.mine(c))) continue;
    if (!entry) {
      const messages = [{ author: c.author?.displayName || 'Google Docs', time: gTime(c.createdTime), text: gText(c) }, ...replies.filter(r => gText(r)).map(r => ({ author: r.author?.displayName || 'Google Docs', time: gTime(r.createdTime), text: gText(r) }))];
      const inset: TextInset = { type: 'Text', name: 'Note', arg: 'Comment', params: [], status: 'open', paragraphs: threadParagraphs(messages, !!c.resolved) };
      placeThread(doc, c.quotedFileContent?.value ?? '', inset);
      for (const m of messages) addAuthorOf(m.author);
      map.push({ gid: c.id, sig: msgSig(messages[0]), replies: replies.map(r => r.id), msgs: messages.map(msgSig), resolved: !!c.resolved });
      report.comments.fromGoogle++;
      changed = true;
      continue;
    }
    if (entry.closed) continue;
    const t = find(entry.sig);
    if (!t) {
      // the thread was deleted here: resolved in Google Docs, and no longer synced
      if (!c.resolved) await api.createReply(link.file_id, c.id, { action: 'resolve', content: 'Deleted in OverLyX.' }).catch(() => undefined);
      entry.closed = true;
      continue;
    }
    const thread = parseThread(t.inset.paragraphs);
    let messages = thread.messages.slice();
    let resolved = thread.resolved;
    let touched = false;
    for (const r of replies) {
      if (entry.replies.includes(r.id)) continue;
      entry.replies.push(r.id);
      if (!gText(r)) continue;   // a bare resolve / reopen
      const m = { author: r.author?.displayName || 'Google Docs', time: gTime(r.createdTime), text: gText(r) };
      messages.push(m);
      entry.msgs.push(msgSig(m));
      addAuthorOf(m.author);
      report.comments.fromGoogle++;
      touched = true;
    }
    if (!!c.resolved !== entry.resolved) {
      // resolved / reopened in Google Docs
      resolved = !!c.resolved;
      entry.resolved = resolved;
      touched = true;
    } else if (thread.resolved !== entry.resolved) {
      await api.createReply(link.file_id, c.id, { action: thread.resolved ? 'resolve' : 'reopen' });
      entry.resolved = thread.resolved;
    }
    if (touched) {
      t.inset.paragraphs = threadParagraphs(messages, resolved);
      changed = true;
    }
    // replies written here
    messages = parseThread(t.inset.paragraphs).messages;
    for (const m of messages.slice(1)) {
      const sig = msgSig(m);
      if (entry.msgs.includes(sig)) continue;
      const r = await api.createReply(link.file_id, c.id, { content: m.text });
      entry.replies.push(r.id);
      entry.msgs.push(sig);
      report.comments.toGoogle++;
    }
  }

  // here → Google: threads not synced yet
  for (const t of threads()) {
    const thread = parseThread(t.inset.paragraphs);
    if (!thread.isStructured || !thread.messages.length) continue;
    const first = thread.messages[0];
    const sig = msgSig(first);
    if (map.some(e => e.sig === sig) || map.some(e => !e.closed && e.sig.startsWith(`${first.author}|${first.time}|`) && find(e.sig) === t)) continue;
    const quoted = quoteFor(t.before);
    const range = rangeOf(raw, quoted);
    const c: GComment = await api.createComment(link.file_id, { content: `${first.author}: ${first.text}`, quoted, range: range && link.tab_id ? { ...range, tabId: link.tab_id } : range });
    const entry: ThreadEntry = { gid: c.id, sig, replies: [], msgs: [sig], resolved: false };
    for (const m of thread.messages.slice(1)) {
      const r = await api.createReply(link.file_id, c.id, { content: `${m.author}: ${m.text}` });
      entry.replies.push(r.id);
      entry.msgs.push(msgSig(m));
    }
    if (thread.resolved) { await api.createReply(link.file_id, c.id, { action: 'resolve' }); entry.resolved = true; }
    map.push(entry);
    report.comments.toGoogle++;
  }
  link.comments = JSON.stringify(map);
  return { doc, changed };
}

/* ------------------------------------------------------------------ syncing on its own */

function documentExists(docId: string): boolean {
  try {
    const { project, path: rel } = splitDocId(docId);
    return !!project && !!rel && fs.existsSync(resolveProjectPath(project, rel));
  } catch { return false; }
}

let timer: NodeJS.Timeout | null = null;

/**
 * Every minute: each linked document with `auto` whose document was saved since its last sync,
 * or whose Google Doc changed (Drive's version), is synced. Started by the server.
 */
export function startAutoSync(intervalMs = 60_000): void {
  if (timer) return;
  timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref();
}

async function tick(): Promise<void> {
  const links = db.prepare('SELECT * FROM gdocs_links WHERE auto = 1').all() as LinkRow[];
  for (const l of links) {
    if (running.has(l.doc_id)) continue;
    // a document that is gone (deleted, its project removed) is not synced any more
    if (!documentExists(l.doc_id)) { unlink(l.doc_id); continue; }
    // nor is one whose linker lost access to it
    if (!linkerMayEdit(l)) { unlink(l.doc_id); console.log(`[gdocs] ${l.doc_id}: unlinked (its linker may not edit it any more)`); continue; }
    try {
      const open = manager.docs.get(l.doc_id) as OpenDoc | undefined;
      const changedHere = !!open && open.lastSavedAt > (l.last_sync ?? 0);
      let changedThere = false;
      if (!changedHere) {
        const f = await apiFor(l.user_id).getFile(l.file_id);
        changedThere = !!f.version && f.version !== l.last_version;
      }
      if (changedHere || changedThere) await syncDoc(l.doc_id);
    } catch (e) {
      if (e instanceof GoogleAuthError) db.prepare('UPDATE gdocs_links SET last_error = ? WHERE doc_id = ?').run(e.message, l.doc_id);
      else console.warn(`[gdocs] ${l.doc_id}: ${(e as Error).message}`);
    }
  }
}
