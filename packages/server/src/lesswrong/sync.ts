/**
 * LessWrong sync: a document linked to a LessWrong draft is kept in step with it, both ways —
 * written here (LaTeX or markdown), read and commented on LessWrong before it is published there.
 *
 * A sync (one at a time per document):
 *  1. reads the draft (LessWrong's MCP read_post, as markdown — without its open suggestions:
 *     model.ts withoutSuggestions); what changed there since the last sync comes into the document
 *     as edits by "LessWrong" — directly while Editing, as tracked changes while Suggesting (or for
 *     review when a draft that held text was linked) — through the agents' edit path, so edits made
 *     here meanwhile stay;
 *  2. writes the document into the draft: rounds of quoted-text edits (model.ts planPush) until the
 *     draft holds the document, reading it again after each round; what LessWrong keeps its own way
 *     afterwards is remembered as the same (model.ts settle);
 *  3. syncs comment threads: a thread written here becomes a LessWrong comment at the text it
 *     follows; with the draft's link-sharing key, LessWrong's comment threads come here too, with
 *     their replies, replies written here go there, and a thread resolved there is resolved here;
 *  4. remembers the document's text and the draft's markdown as the base of the next sync.
 *
 * The draft's title, its publishing, and images from the project stay LessWrong's: the sync never
 * creates or publishes a post (LessWrong's API cannot), it fills the draft it is given.
 *
 * Linked documents sync on their own (`auto`): a minute after an edit here, and every few minutes
 * for edits made on LessWrong (often while the document is open here, rarely when nobody touched it
 * for a day). The sync acts with the LessWrong authorisation of whoever linked the document.
 */
import { addAuthor, formatTimestamp, lyxAuthorId, parseThread, type LyxDocument, type TextInset } from '@overlyx/core';
import { db } from '../db.ts';
import { manager, type OpenDoc } from '../docs.ts';
import { sealer } from '../sealed.ts';
import { threadsOf, placeThread, quoteFor, threadParagraphs, msgSig, linkerMayEdit, documentExists, isTracking, changedChars, type ThreadRef } from '../gdocs/sync.ts';
import { projectDocument, readBlocks, withoutSuggestions, withLessWrongChanges, planPush, settle, opKey, normText, type Equivalences, type LwBlock, type LwOp } from './model.ts';
import { lessWrongApi, lessWrongAccount, LessWrongAuthError, LW_URL, type LessWrongApi, type LwThread } from './api.ts';

db.exec(`
CREATE TABLE IF NOT EXISTS lesswrong_links (
  doc_id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  link_key TEXT,
  user_id INTEGER NOT NULL,
  title TEXT,
  draft INTEGER,
  base_text TEXT,
  base_lw TEXT,
  equiv TEXT,
  comments TEXT,
  auto INTEGER NOT NULL DEFAULT 1,
  last_sync INTEGER,
  last_change INTEGER,
  last_error TEXT,
  last_warnings TEXT,
  created_at INTEGER NOT NULL
);
`);

const { seal, unseal } = sealer('lesswrong-key');

export interface LwLinkRow {
  doc_id: string; post_id: string; link_key: string | null; user_id: number; title: string | null; draft: number | null;
  base_text: string | null; base_lw: string | null; equiv: string | null; comments: string | null;
  auto: number; last_sync: number | null; last_change: number | null; last_error: string | null; last_warnings: string | null; created_at: number;
}

export function lwLinkOf(docId: string): LwLinkRow | null {
  return (db.prepare('SELECT * FROM lesswrong_links WHERE doc_id = ?').get(docId) as LwLinkRow | undefined) ?? null;
}

export function publicLwLink(l: LwLinkRow | null) {
  if (!l) return null;
  const acc = lessWrongAccount(l.user_id);
  const done = lastReports.get(l.doc_id);
  return {
    postId: l.post_id, title: l.title, draft: l.draft === null ? null : !!l.draft,
    url: `${LW_URL}/editPost?postId=${encodeURIComponent(l.post_id)}`,
    comments: !!l.link_key, auto: !!l.auto, lastSync: l.last_sync, lastError: l.last_error, linkedBy: l.user_id,
    warnings: l.last_warnings ? JSON.parse(l.last_warnings) as string[] : [],
    /** the linker's LessWrong authorisation: until when (null: gone — they must connect again) */
    authUntil: acc?.expiresAt ?? null,
    /** a sync under way: what it is doing */
    syncing: progress.get(l.doc_id) ?? null,
    /** what the last sync of this server's run did (the dialog says it when a background sync ends) */
    lastReport: done ? { at: done.at, pulled: done.pulled, pushed: done.pushed, comments: done.comments, warnings: done.warnings.length } : null,
  };
}

/** a sync under way, by document: its phase, the edits sent so far, since when (the dialog and the ⇄ chip show it) */
export interface LwProgress { phase: string; edits: number; round: number; since: number }
const progress = new Map<string, LwProgress>();
const lastReports = new Map<string, LwSyncReport & { at: number }>();
const phase = (docId: string, what: string, more: Partial<LwProgress> = {}) => {
  const p = progress.get(docId);
  progress.set(docId, { edits: 0, round: 0, since: Date.now(), ...p, phase: what, ...more });
};

/** the sync running now (linking starts one and does not wait for it) */
export function lwSyncing(docId: string): Promise<LwSyncReport> | null { return running.get(docId) ?? null; }

/** the API a link syncs with (tests put a simulation here) */
let apiFor: (userId: number) => LessWrongApi = lessWrongApi;
export function lessWrongApiFor(userId: number): LessWrongApi { return apiFor(userId); }
export function setLessWrongApiFactory(f: (userId: number) => LessWrongApi): void { apiFor = f; }

const keyOf = (l: LwLinkRow) => (l.link_key ? unseal(l.link_key) : null);

/* ------------------------------------------------------------------ linking */

/**
 * Link the document to a LessWrong draft (one the account may edit: its own, or one shared with it
 * to edit — `key`, the link-sharing key of its edit URL, also lets comment threads come back). An
 * empty draft gets the document; an empty document the draft. When both hold text, `keep`:
 * - 'ours': the document's text replaces the draft's;
 * - 'merge': what the draft holds differently comes in as tracked changes, for review here.
 */
export async function linkPost(docId: string, userId: number, ref: { postId: string; key: string | null }, keep: 'ours' | 'merge' = 'ours'): Promise<LwLinkRow> {
  if (!linkerMayEdit({ doc_id: docId, user_id: userId })) throw new Error('You cannot edit this document');
  const existing = lwLinkOf(docId);
  if (existing) return existing;
  const other = db.prepare('SELECT doc_id FROM lesswrong_links WHERE post_id = ?').get(ref.postId) as { doc_id: string } | undefined;
  if (other) throw new Error(`That LessWrong draft already syncs with ${other.doc_id.split('/').pop()} — unlink that document first`);
  const api = apiFor(userId);
  const post = await api.readPost(ref.postId, ref.key);
  // the link-sharing routes say whether the draft is in the editor the agent API works with
  if (ref.key) await api.readThreads(ref.postId, ref.key);
  if (lwLinkOf(docId)) return lwLinkOf(docId)!;   // (linked meanwhile: a second click)
  const doc = await manager.open(docId);
  const ours = doc.toLyxDocument();
  const proj = projectDocument(ours);
  const lw = withoutSuggestions(post.markdown).text;
  const theirsEmpty = !readBlocks(lw).blocks.length, oursEmpty = !proj.blocks.length;
  // the base: what both sides "held at the last sync" — nothing (the other side's text comes over), the draft as it
  // is (nothing to bring in: the document's text goes over), or the document as it is (the draft's differences come in)
  const baseLw = theirsEmpty || oursEmpty ? '' : keep === 'ours' ? lw : proj.markdown;
  db.prepare(`INSERT INTO lesswrong_links (doc_id, post_id, link_key, user_id, title, draft, base_text, base_lw, auto, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`)
    .run(docId, ref.postId, ref.key ? seal(ref.key) : null, userId, post.title || null, post.draft === null ? null : post.draft ? 1 : 0, doc.textOf(ours), baseLw, Date.now());
  // the first sync can take a while (LessWrong takes one edit per call): it runs on, the dialog shows its progress
  phase(docId, 'Starting');
  void syncDoc(docId, { pullTracked: keep === 'merge' && !theirsEmpty && !oursEmpty }).catch(() => undefined);
  return lwLinkOf(docId)!;
}

/** the draft's link-sharing key, given (or replaced) later: comment threads then come back too */
export async function setLinkKey(docId: string, key: string | null): Promise<void> {
  const l = lwLinkOf(docId);
  if (!l) throw new Error('This document is not linked to a LessWrong draft');
  if (key) await apiFor(l.user_id).readThreads(l.post_id, key);
  db.prepare('UPDATE lesswrong_links SET link_key = ? WHERE doc_id = ?').run(key ? seal(key) : null, docId);
}

export function unlinkPost(docId: string): void { db.prepare('DELETE FROM lesswrong_links WHERE doc_id = ?').run(docId); }
export function setLwAuto(docId: string, auto: boolean): void { db.prepare('UPDATE lesswrong_links SET auto = ? WHERE doc_id = ?').run(auto ? 1 : 0, docId); }

/** files of a project deleted or renamed in the explorer (gdocs/sync.ts filesMoved) */
export function lwFilesMoved(projectKey: string, from: string, to: string | null): void {
  const old = `${projectKey}/${from}`;
  const rows = db.prepare('SELECT doc_id FROM lesswrong_links WHERE doc_id = ? OR substr(doc_id, 1, ?) = ?').all(old, old.length + 1, old + '/') as { doc_id: string }[];
  for (const { doc_id } of rows) {
    if (to === null) unlinkPost(doc_id);
    else db.prepare('UPDATE lesswrong_links SET doc_id = ? WHERE doc_id = ?').run(`${projectKey}/${to}` + doc_id.slice(old.length), doc_id);
  }
}

/* ------------------------------------------------------------------ the sync */

export interface LwSyncReport { pulled: number; pushed: number; rounds: number; comments: { fromLessWrong: number; toLessWrong: number }; warnings: string[]; notes: string[] }

const running = new Map<string, Promise<LwSyncReport>>();

/** Sync a linked document now (a sync already running is waited for, then this one runs). */
export function syncDoc(docId: string, opts: { pullTracked?: boolean } = {}): Promise<LwSyncReport> {
  const prev = running.get(docId) ?? Promise.resolve(null);
  const p = prev.catch(() => null).then(() => runSync(docId, opts));
  running.set(docId, p);
  void p.catch(() => null).finally(() => { if (running.get(docId) === p) running.delete(docId); });
  return p;
}

/** at most this many rounds of edits per sync */
const ROUNDS = 12;

async function runSync(docId: string, opts: { pullTracked?: boolean }): Promise<LwSyncReport> {
  const link = lwLinkOf(docId);
  if (!link) throw new Error('This document is not linked to a LessWrong draft');
  if (!linkerMayEdit(link)) { unlinkPost(docId); throw new Error('The person who linked this document to LessWrong may not edit it any more: the link is removed'); }
  const api = apiFor(link.user_id);
  const key = keyOf(link);
  const report: LwSyncReport = { pulled: 0, pushed: 0, rounds: 0, comments: { fromLessWrong: 0, toLessWrong: 0 }, warnings: [], notes: [] };
  const warnings = new Set<string>();
  try {
    phase(docId, 'Reading the draft on LessWrong', { since: Date.now(), edits: 0, round: 0 });
    const doc = await manager.open(docId);
    let post = await api.readPost(link.post_id, key);
    const read = () => { const w = withoutSuggestions(post.markdown); return { text: w.text, suggestions: w.count, blocks: readBlocks(w.text).blocks }; };
    let lw = read();
    let equiv: Equivalences = link.equiv ? JSON.parse(link.equiv) : {};
    let changed = false;

    // 1. what was changed on LessWrong since the last sync: edits here
    if (link.base_lw !== null && link.base_text !== null) {
      const baseLw = readBlocks(link.base_lw).blocks;
      if (!sameKeys(baseLw, lw.blocks)) {
        const baseDoc = doc.parse(link.base_text);
        const theirs = withLessWrongChanges(baseDoc, projectDocument(baseDoc).blocks, baseLw, lw.blocks, equiv);
        const after = theirs ? doc.textOf(theirs) : link.base_text;
        if (after !== link.base_text) {
          phase(docId, 'Bringing in edits made on LessWrong');
          const tracking = isTracking(doc.getMeta().headerLines);
          const r = await doc.agentEdit(tracking || opts.pullTracked ? 'tracked' : 'plain', link.base_text, { after }, { author: 'LessWrong' });
          report.pulled = 'inserted' in r.result ? r.result.inserted + r.result.deleted : changedChars(link.base_text, after);
          // the agents' edit path may switch change tracking; the document's mode stays as it was
          const lines = doc.getMeta().headerLines;
          if (isTracking(lines) !== tracking) {
            const fixed = lines.map(l => (/^\\tracking_changes\b/.test(l) ? `\\tracking_changes ${tracking}` : l));
            doc.ydoc.transact(() => { doc.meta.set('header', JSON.stringify(fixed)); }, 'header');
          }
          changed = true;
        }
      }
    }

    // 2. the document into the draft, round by round (each finds its places in the draft as it is then)
    const proj = projectDocument(doc.toLyxDocument());
    if (proj.left.length) warnings.add('Not sent to LessWrong: ' + proj.left.join(', ') + '.');
    const skip = new Set<string>();
    const agentName = 'OverLyX';
    let last = '';
    for (; report.rounds < ROUNDS; report.rounds++) {
      const ops = planPush(lw.blocks, proj.blocks, proj.doc, equiv, skip, warnings);
      if (!ops.length) break;
      // the same edits again: LessWrong took them without the draft changing — not tried again
      const sig = ops.map(opKey).join('\n');
      if (sig === last) { for (const o of ops) skip.add(opKey(o)); continue; }
      last = sig;
      phase(docId, `Writing into the draft (round ${report.rounds + 1}: ${ops.length} ${ops[0].op === 'delete' ? 'removals' : ops[0].op === 'replace' ? 'word changes' : 'insertions'})`, { round: report.rounds + 1 });
      for (const op of ops) {
        try {
          const r = await apply(api, link.post_id, key, op, agentName);
          if (r.ok) { report.pushed++; phase(docId, progress.get(docId)?.phase ?? '', { edits: report.pushed }); }
          else { skip.add(opKey(op)); warnings.add(`LessWrong did not take an edit (“${op.what}”): ${r.note}`); }
        } catch (e) {
          if (e instanceof LessWrongAuthError) throw e;
          skip.add(opKey(op));
          warnings.add(`LessWrong did not take an edit (“${op.what}”): ${(e as Error).message}`);
        }
      }
      phase(docId, 'Reading the draft again');
      post = await api.readPost(link.post_id, key);
      lw = read();
      changed = true;
    }
    const s = settle(lw.blocks, proj.blocks, equiv, sameText);
    equiv = s.equiv;
    if (s.unsettled) warnings.add(`${s.unsettled} paragraph${s.unsettled === 1 ? '' : 's'} of the LessWrong draft still differ from the document.`);
    if (lw.suggestions) report.notes.push('the draft has open suggestions on LessWrong: they come here once accepted there');

    // 3. comment threads (with the link-sharing key: both ways)
    phase(docId, 'Comment threads');
    const before = doc.toLyxDocument();
    const { doc: withComments, changed: threadsChanged } = await syncComments(api, link, key, before, report, warnings);
    if (threadsChanged) await doc.agentEdit('plain', doc.textOf(before), { after: doc.textOf(withComments) });

    // 4. the base of the next sync: the document as it is now, the draft as it is now
    report.warnings = [...warnings];
    db.prepare(`UPDATE lesswrong_links SET base_text = ?, base_lw = ?, equiv = ?, comments = ?, title = ?, draft = ?, last_sync = ?, last_error = NULL, last_warnings = ?${changed || threadsChanged ? ', last_change = ?' : ''} WHERE doc_id = ?`)
      .run(doc.textOf(doc.toLyxDocument()), lw.text, JSON.stringify(equiv), link.comments, post.title || link.title, post.draft === null ? link.draft : post.draft ? 1 : 0, Date.now(), JSON.stringify(report.warnings), ...(changed || threadsChanged ? [Date.now()] : []), docId);
    lastReports.set(docId, { ...report, at: Date.now() });
    // (counts only, when something happened or what was left out changed: the service log)
    if (report.pulled || report.pushed || skip.size || JSON.stringify(report.warnings) !== (link.last_warnings ?? '[]')) {
      console.log(`[lesswrong] ${docId}: synced \u2014 ${report.pulled} characters in, ${report.pushed} edits out, ${skip.size} refused, ${report.warnings.length} warnings, ${report.rounds} rounds`);
    }
    return report;
  } catch (e) {
    db.prepare('UPDATE lesswrong_links SET last_error = ?, last_sync = ? WHERE doc_id = ?').run((e as Error).message, Date.now(), docId);
    lastReports.set(docId, { ...report, at: Date.now() });
    throw e;
  } finally {
    progress.delete(docId);
  }
}

const sameKeys = (a: LwBlock[], b: LwBlock[]) => a.length === b.length && a.every((x, i) => x.key === b[i].key);
/** the same words (LessWrong holds the block its own way: markup, escaping, numbering) */
const sameText = (a: LwBlock, b: LwBlock) => {
  const t = (x: LwBlock) => normText(x.pars.map(p => p.text).join(' ')).replace(/[^\p{L}\p{N}]+/gu, '');
  return t(a) === t(b);
};

function apply(api: LessWrongApi, postId: string, key: string | null, op: LwOp, agentName: string) {
  if (op.op === 'replace') return api.replaceText(postId, key, { quote: op.quote, replacement: op.replacement, agentName });
  if (op.op === 'insert') return api.insertBlock(postId, key, { location: op.location, markdown: op.markdown, agentName });
  return api.deleteBlock(postId, key, { prefix: op.prefix, agentName });
}

/* ------------------------------------------------------------------ comments */

interface LwThreadEntry {
  /** the LessWrong thread (null: posted without one — not followed) */
  lid: string | null;
  /** the thread's first message here */
  sig: string;
  /** messages here already sent or taken over */
  msgs: string[];
  /** LessWrong comments of the thread already taken over or written by the sync */
  seen: number;
  resolved: boolean;
  closed?: boolean;
}

/** markdown's markup in a quote taken as text (LessWrong reads quotes as markdown) */
const mdQuote = (s: string) => s.replace(/([\\`*_[\]$~^<])/g, '\\$1');
const lwTime = (t: number | null) => formatTimestamp(t ? new Date(t) : new Date());

/**
 * Comment threads. Here → LessWrong always (a new thread as a comment at the text it follows, by
 * "<author> (OverLyX)"); with the link-sharing key also LessWrong → here, replies both ways, and a
 * thread resolved on LessWrong (gone from its open threads) resolved here. Updates `link.comments`.
 */
async function syncComments(api: LessWrongApi, link: LwLinkRow, key: string | null, ours: LyxDocument, report: LwSyncReport, warnings: Set<string>): Promise<{ doc: LyxDocument; changed: boolean }> {
  const doc: LyxDocument = JSON.parse(JSON.stringify(ours));
  const map: LwThreadEntry[] = link.comments ? JSON.parse(link.comments) : [];
  let changed = false;
  const find = (sig: string): ThreadRef | undefined => {
    const all = threadsOf(doc);
    const exact = all.find(t => { const m = parseThread(t.inset.paragraphs).messages[0]; return m && msgSig(m) === sig; });
    if (exact) return exact;
    const [a, tm] = sig.split('|');
    const loose = all.filter(t => { const m = parseThread(t.inset.paragraphs).messages[0]; return m && m.author === a && m.time === tm; });
    return loose.length === 1 ? loose[0] : undefined;
  };
  const save = () => { link.comments = JSON.stringify(map); db.prepare('UPDATE lesswrong_links SET comments = ? WHERE doc_id = ?').run(link.comments, link.doc_id); };

  // LessWrong → here (its open threads: only through the link-sharing routes)
  const open: LwThread[] | null = key ? await api.readThreads(link.post_id, key).catch(e => { warnings.add('LessWrong’s comment threads could not be read: ' + (e as Error).message); return null; }) : null;
  if (open) {
    const ids = new Set(open.map(t => t.id));
    for (const th of open) {
      if (th.type !== 'comment' || !th.comments.length) continue;
      let entry = map.find(e => e.lid === th.id);
      // a thread this sync posted, its id not known then
      if (!entry && th.comments[0].author.endsWith(' (OverLyX)')) {
        const text = normText(th.comments[0].text).slice(0, 40);
        entry = map.find(e => !e.lid && normText(e.sig.split('|').slice(2).join('|')).startsWith(text.slice(0, 30)));
        if (!entry) continue;
        entry.lid = th.id;
      }
      if (!entry) {
        const messages = th.comments.map(c => ({ author: c.author, time: lwTime(c.time), text: c.text }));
        const inset: TextInset = { type: 'Text', name: 'Note', arg: 'Comment', params: [], status: 'open', paragraphs: threadParagraphs(messages, false) };
        placeThread(doc, th.quote.replace(/\[\^[^\]]*\]/g, ''), inset);
        for (const m of messages) addAuthor(doc.header, lyxAuthorId(m.author, ''), m.author, '');
        map.push({ lid: th.id, sig: msgSig(messages[0]), msgs: messages.map(msgSig), seen: th.comments.length, resolved: false });
        report.comments.fromLessWrong++;
        changed = true;
        continue;
      }
      if (entry.closed) continue;
      const t = find(entry.sig);
      if (!t) { entry.closed = true; continue; }   // deleted here (LessWrong's API cannot resolve it there)
      const fresh = th.comments.slice(entry.seen);
      if (fresh.length) {
        const thread = parseThread(t.inset.paragraphs);
        const messages = [...thread.messages, ...fresh.map(c => ({ author: c.author, time: lwTime(c.time), text: c.text }))];
        for (const m of messages.slice(thread.messages.length)) { entry.msgs.push(msgSig(m)); addAuthor(doc.header, lyxAuthorId(m.author, ''), m.author, ''); }
        t.inset.paragraphs = threadParagraphs(messages, thread.resolved);
        entry.seen = th.comments.length;
        report.comments.fromLessWrong += fresh.length;
        changed = true;
      }
    }
    // resolved (or deleted) on LessWrong: resolved here
    for (const e of map) {
      if (e.closed || !e.lid || ids.has(e.lid)) continue;
      const t = find(e.sig);
      if (t) {
        const thread = parseThread(t.inset.paragraphs);
        if (!thread.resolved) { t.inset.paragraphs = threadParagraphs(thread.messages, true); changed = true; }
      }
      e.resolved = true;
      e.closed = true;
    }
  }

  // here → LessWrong: replies to threads it has, then threads it does not have yet
  for (const e of map) {
    if (e.closed || !e.lid) continue;
    const t = find(e.sig);
    if (!t) continue;
    for (const m of parseThread(t.inset.paragraphs).messages.slice(1)) {
      const sig = msgSig(m);
      if (e.msgs.includes(sig)) continue;
      if (!key) { warnings.add('Replies written here reach LessWrong only with the draft’s link-sharing key (File ▸ LessWrong).'); break; }
      await api.replyToComment(link.post_id, key, { threadId: e.lid, comment: m.text, agentName: `${m.author} (OverLyX)` });
      e.msgs.push(sig);
      e.seen++;
      report.comments.toLessWrong++;
    }
  }
  for (const t of threadsOf(doc)) {
    const thread = parseThread(t.inset.paragraphs);
    if (!thread.isStructured || !thread.messages.length || thread.resolved) continue;
    const first = thread.messages[0];
    const sig = msgSig(first);
    if (map.some(e => e.sig === sig) || map.some(e => !e.closed && e.sig.startsWith(`${first.author}|${first.time}|`) && find(e.sig) === t)) continue;
    // without the key the replies so far go along in the comment (later ones cannot)
    const rest = key ? [] : thread.messages.slice(1);
    const comment = [first.text, ...rest.map(m => `**${m.author}:** ${m.text}`)].join('\n\n');
    const quoted = quoteFor(t.before);
    const r = await api.commentOnDraft(link.post_id, key, { quote: quoted ? mdQuote(quoted) : undefined, comment, agentName: `${first.author} (OverLyX)` });
    const entry: LwThreadEntry = { lid: r.threadId, sig, msgs: [sig, ...rest.map(msgSig)], seen: 1, resolved: false };
    map.push(entry);
    save();   // at once: a sync that fails later must not post it again
    report.comments.toLessWrong++;
    if (key && r.threadId) {
      for (const m of thread.messages.slice(1)) {
        await api.replyToComment(link.post_id, key, { threadId: r.threadId, comment: m.text, agentName: `${m.author} (OverLyX)` });
        entry.msgs.push(msgSig(m));
        entry.seen++;
      }
    }
  }
  link.comments = JSON.stringify(map);
  return { doc, changed };
}

/* ------------------------------------------------------------------ syncing on its own */

let timer: NodeJS.Timeout | null = null;

/**
 * Every minute: each linked document with `auto` that was saved since its last sync is synced;
 * the others are read from LessWrong every few minutes while open here, every ten when something
 * changed in the last day, hourly otherwise.
 */
export function startLessWrongAutoSync(intervalMs = 60_000): void {
  if (timer) return;
  timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref();
}

async function tick(): Promise<void> {
  const links = db.prepare('SELECT * FROM lesswrong_links WHERE auto = 1').all() as LwLinkRow[];
  const now = Date.now();
  for (const l of links) {
    if (running.has(l.doc_id)) continue;
    if (!documentExists(l.doc_id)) { unlinkPost(l.doc_id); continue; }
    if (!linkerMayEdit(l)) { unlinkPost(l.doc_id); console.log(`[lesswrong] ${l.doc_id}: unlinked (its linker may not edit it any more)`); continue; }
    const open = manager.docs.get(l.doc_id) as OpenDoc | undefined;
    const changedHere = !!open && open.lastSavedAt > (l.last_sync ?? 0);
    const every = open ? 3 * 60_000 : now - (l.last_change ?? l.created_at) < 86_400_000 ? 10 * 60_000 : 60 * 60_000;
    if (!changedHere && now - (l.last_sync ?? 0) < every) continue;
    try { await syncDoc(l.doc_id); }
    catch (e) { console.warn(`[lesswrong] ${l.doc_id}: ${(e as Error).message}`); }
  }
}
