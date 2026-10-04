/**
 * Google Docs sync: a document linked to a Google Doc is kept in step with it, both ways.
 *
 * A sync (one at a time per document):
 *  1. reads the Google Doc; what changed there since the last sync (its blocks against the ones
 *     stored then) comes into the document as tracked changes by the Google Docs editor — through
 *     the agents' edit path (docedit.ts applyTrackedSource), so edits made here meanwhile stay;
 *  2. writes the document into the Google Doc, word by word where paragraphs changed (edits.ts) —
 *     comments anchored in Google Docs stay where they are;
 *  3. syncs comment threads: a Google comment becomes a thread at the text it quotes, a thread
 *     written here a Google comment (anchored where the API allows), replies and resolving both ways;
 *  4. remembers the document's text and the Google Doc's blocks as the base of the next sync.
 *
 * Linked documents sync on their own (`auto`): a minute after an edit here, and when Drive says the
 * Google Doc changed. The sync acts with the Drive authorisation of whoever linked the document.
 */
import { addAuthor, commentHeader, formatTimestamp, lyxAuthorId, parseThread, type Item, type LyxDocument, type Paragraph, type TextInset } from '@overlyx/core';
import fs from 'node:fs';
import { splitDocId } from '@overlyx/core';
import { isMarkdownPath } from '@overlyx/core/md/index.ts';
import { resolveProjectPath } from '../projectfiles.ts';
import { db } from '../db.ts';
import { manager, type OpenDoc } from '../docs.ts';
import { project, readGoogle, strip, toParagraphs, blockKey, itemRuns, type GBlock, type Projection } from './model.ts';
import { planRound } from './edits.ts';
import { googleApi, GoogleAuthError, type GComment, type GoogleApi } from './google.ts';

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

export interface LinkRow {
  doc_id: string; file_id: string; user_id: number; url: string | null;
  base_text: string | null; base_google: string | null; comments: string | null;
  auto: number; last_sync: number | null; last_error: string | null; last_version: string | null; created_at: number;
}

export function linkOf(docId: string): LinkRow | null {
  return (db.prepare('SELECT * FROM gdocs_links WHERE doc_id = ?').get(docId) as LinkRow | undefined) ?? null;
}

export function publicLink(l: LinkRow | null): { fileId: string; url: string; auto: boolean; lastSync: number | null; lastError: string | null; linkedBy: number } | null {
  return l ? { fileId: l.file_id, url: l.url ?? `https://docs.google.com/document/d/${l.file_id}/edit`, auto: !!l.auto, lastSync: l.last_sync, lastError: l.last_error, linkedBy: l.user_id } : null;
}

/** the API a link syncs with (tests put a simulation here) */
let apiFor: (userId: number) => GoogleApi = googleApi;
/** (the e2e tests' Google, one simulation for everybody: routes.ts sets it up) */
export function googleApiFor(userId: number): GoogleApi { return apiFor(userId); }
export function setGoogleApiFactory(f: (userId: number) => GoogleApi): void { apiFor = f; }

/* ------------------------------------------------------------------ linking */

/** Link the document to a new Google Doc (in the Drive of `userId`) and write the document into it. */
export async function linkNewGoogleDoc(docId: string, userId: number, title: string): Promise<LinkRow> {
  const api = apiFor(userId);
  const file = await api.createDocument(title);
  db.prepare('INSERT OR REPLACE INTO gdocs_links (doc_id, file_id, user_id, url, auto, created_at) VALUES (?, ?, ?, ?, 1, ?)')
    .run(docId, file.id, userId, file.webViewLink ?? `https://docs.google.com/document/d/${file.id}/edit`, Date.now());
  await syncDoc(docId);
  return linkOf(docId)!;
}

export function unlink(docId: string): void { db.prepare('DELETE FROM gdocs_links WHERE doc_id = ?').run(docId); }
export function setAuto(docId: string, auto: boolean): void { db.prepare('UPDATE gdocs_links SET auto = ? WHERE doc_id = ?').run(auto ? 1 : 0, docId); }

/* ------------------------------------------------------------------ the sync */

export interface SyncReport { pulled: number; pushed: number; rounds: number; comments: { fromGoogle: number; toGoogle: number }; warnings: string[] }

const running = new Map<string, Promise<SyncReport>>();

/** Sync a linked document now (a sync already running is waited for, then this one runs). */
export function syncDoc(docId: string): Promise<SyncReport> {
  const prev = running.get(docId) ?? Promise.resolve(null);
  const p = prev.catch(() => null).then(() => runSync(docId));
  running.set(docId, p);
  void p.catch(() => null).finally(() => { if (running.get(docId) === p) running.delete(docId); });
  return p;
}

async function runSync(docId: string): Promise<SyncReport> {
  const link = linkOf(docId);
  if (!link) throw new Error('This document is not linked to a Google Doc');
  const api = apiFor(link.user_id);
  const report: SyncReport = { pulled: 0, pushed: 0, rounds: 0, comments: { fromGoogle: 0, toGoogle: 0 }, warnings: [] };
  try {
    const doc = await manager.open(docId);
    const markdown = isMarkdownPath(doc.relPath);
    const file = await api.getFile(link.file_id);
    if (file.trashed) throw new Error('The Google Doc is in the trash — restore it, or unlink the document');
    let raw = await api.getDocument(link.file_id);
    const gNow = strip(readGoogle(raw).blocks);

    // 1. what was changed in Google Docs since the last sync: tracked changes here
    if (link.base_google && link.base_text !== null) {
      const baseG = JSON.parse(link.base_google) as GBlock[];
      if (!sameBlocks(baseG, gNow)) {
        const baseDoc = doc.parse(link.base_text);
        const theirs = withGoogleChanges(baseDoc, project(baseDoc), baseG, gNow, markdown);
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

    // 2. the document into the Google Doc
    const ours = doc.toLyxDocument();
    const want = strip(project(ours).blocks);
    for (; report.rounds < 10; report.rounds++) {
      const requests = planRound(raw, want);
      if (!requests.length) break;
      await api.batchUpdate(link.file_id, requests, raw.revisionId || undefined);
      report.pushed += requests.length;
      raw = await api.getDocument(link.file_id);
    }
    if (report.rounds >= 10) report.warnings.push('The Google Doc could not be brought fully in line in one sync');

    // 3. comment threads, both ways (a thread from Google Docs changes the document)
    const { doc: withComments, changed } = await syncComments(api, link, ours, raw, report);
    if (changed) await doc.agentEdit('plain', doc.textOf(ours), { after: doc.textOf(withComments) });

    // 4. the base of the next sync: the document as written to Google (with the comment threads), the Google Doc as it is now
    const after = await api.getFile(link.file_id);
    db.prepare('UPDATE gdocs_links SET base_text = ?, base_google = ?, comments = ?, last_sync = ?, last_error = NULL, last_version = ? WHERE doc_id = ?')
      .run(doc.textOf(withComments), JSON.stringify(strip(readGoogle(raw).blocks)), link.comments, Date.now(), after.version ?? null, docId);
    return report;
  } catch (e) {
    db.prepare('UPDATE gdocs_links SET last_error = ?, last_sync = ? WHERE doc_id = ?').run((e as Error).message, Date.now(), docId);
    throw e;
  }
}

const isTracking = (lines: string[]) => lines.includes('\\tracking_changes true');

const sameBlocks = (a: GBlock[], b: GBlock[]) => a.length === b.length && a.every((x, i) => blockKey(x) === blockKey(b[i]));

/**
 * The base document with the changes made in Google Docs: the regions where the Google Doc's blocks
 * now differ from the ones stored at the last sync, mapped to the base document's paragraphs (through
 * the blocks the base document projects to) and replaced by paragraphs made from the new blocks.
 * Null when nothing maps (no change).
 */
export function withGoogleChanges(baseDoc: LyxDocument, proj: Projection, baseG: GBlock[], gNow: GBlock[], markdown: boolean): LyxDocument | null {
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
export async function syncComments(api: GoogleApi, link: LinkRow, ours: LyxDocument, raw: import('./model.ts').DocsDocument, report: SyncReport): Promise<{ doc: LyxDocument; changed: boolean }> {
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
    const c: GComment = await api.createComment(link.file_id, { content: `${first.author}: ${first.text}`, quoted, range: rangeOf(raw, quoted) });
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
