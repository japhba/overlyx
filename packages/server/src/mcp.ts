/**
 * MCP connector: lets an external agent (any MCP-compatible client, e.g. Claude Code or Codex on
 * the user's own machine) read a project's documents, read/add/resolve comment threads, and edit
 * the files on this server — no sync, no shell. The bearer token identifies an
 * *account* (see mcpTokens.ts) — the agent may connect to any project that account can access,
 * with the account's role there: viewers read, editors also comment and edit. By default every
 * document edit is turned into change-tracked insertions/deletions (the same `\lyxadded` /
 * `\lyxdeleted` machinery a human editor's Track Changes produces), attributed to the token's name
 * suffixed "(MCP)" — reviewable like a human collaborator's tracked edit. Tracked editing must not
 * leave a document broken or an agent stuck, so edit_document / write_document also take
 * `tracked: false` (applyPlainSource: the same merge, no marks, a commit right before as the
 * restore point), and the server's MCP_INSTRUCTIONS tell the agent to fall back to it on any
 * problem; the git history (project_history / restore_project) is the way back either way.
 *
 * Raw LaTeX is a first-class input. edit_document replaces a passage of the document's source
 * (old text → new text, the way coding agents edit files); write_document writes a whole source;
 * insert_paragraphs / replace_paragraph / delete_paragraph address paragraphs by index. Whatever
 * the tool, the result is diffed against the live document (trackDiff, docedit.ts), so only what
 * actually changed is marked — a word, a digit, a table cell — never a whole paragraph for a
 * one-word change. read_file/write_file/edit_file reach the project's other text files (refs.bib,
 * macros.tex, …), always directly. propose_edit remains for plain-text paragraphs. Comment threads are found anywhere in the body —
 * inside tables, floats and other insets too; new threads attach at a top-level paragraph.
 * build_pdf compiles with latexmk (viewers may, like in the app) and hands back the warnings,
 * the first errors, whether the build before the agent's changes succeeded, and the compile-log
 * tail. project_history lists the project's commits and restore_project puts the whole project back
 * to one of them (a new commit on top) — the way back from changes that broke the build. The Agent
 * panel's agent also has undo_turn: its turns leave checkpoints (agentwork.ts), and it can take
 * one back exactly.
 */
import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import fs from 'node:fs';
import {
  itemText, paragraph, textItem, insetItem, textInset, addAuthor, lyxAuthorId, fontsEqual,
  setHeaderValue, diffText, commentHeader, formatTimestamp, parseHeader, parseThread, trackDiff, changeStats,
  splitDocId, type LyxDocument, type Item, type TextInset, type Paragraph,
} from '@overlyx/core';
import { replaceInSource } from './docedit.ts';
import { canonicalProject, canonicalDocId } from './namespaces.ts';
import nodePath from 'node:path';
import { manager } from './docs.ts';
import { listProjects, projectDir, resolveProjectPath, assertWritableRelPath, isDocumentFile, newDocumentText, findMaster } from './projects.ts';
import { parseDocumentText, parseFragmentText } from './texdoc.ts';
import { touchProject, repoInfo, restoreProject, commitProject } from './git.ts';
import { buildIncluding, buildErrors, lastBuild, currentJob } from './export.ts';
import { PANEL_AGENT, buildBeforeTurn, agentCheckpoint, undoCheckpoint, panelTracking } from './agentwork.ts';
import { verifyMcpToken } from './mcpTokens.ts';
import { wwwAuthenticate } from './mcpOauth.ts';
import { config } from './config.ts';
import { roleFor, atLeast, logAccess, accessibleProjects } from './access.ts';
import { createOwnedProject } from './projectCreate.ts';
import { ensureRepo } from './git.ts';
import { toSessionUser, type SessionUser } from './auth.ts';
import { db, type UserRow } from './db.ts';

function ok(value: unknown) {
  return { content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}
function fail(e: unknown) {
  return { content: [{ type: 'text' as const, text: (e as Error)?.message ?? String(e) }], isError: true };
}
/** search/fetch answers for ChatGPT: the JSON both as text and as structuredContent (its citation format). */
function okStruct(value: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], structuredContent: value };
}

async function openLyx(project: string, path: string): Promise<{ doc: Awaited<ReturnType<typeof manager.open>>; lyx: LyxDocument }> {
  const doc = await manager.open(`${project}/${path}`);
  return { doc, lyx: doc.toLyxDocument() };
}

function commitEdit(doc: Awaited<ReturnType<typeof manager.open>>, lyx: LyxDocument): void {
  doc.loadFromLyx(lyx, 'mcp');
  doc.dirty = true;
  void doc.saveToFile();
}

function listDocuments(project: string): { path: string; size: number }[] {
  const p = listProjects().find(x => x.name === project);
  return (p?.files ?? []).filter(f => f.kind === 'doc').map(f => ({ path: f.path, size: f.size }));
}

async function readDocument(project: string, path: string) {
  const doc = await manager.open(`${project}/${path}`);
  return doc.readAsync();   // { text, paragraphs: index, layout, depth, text }
}

const authorName = (agentName: string) => `${agentName} (MCP)`;

async function proposeEdit(project: string, agentName: string, path: string, paragraphIndex: number, newText: string) {
  const { doc, lyx } = await openLyx(project, path);
  const par = lyx.body[paragraphIndex];
  if (!par) throw new Error(`No paragraph ${paragraphIndex} — this document has ${lyx.body.length} paragraph(s) (see read_document).`);
  if (par.items.some((it: Item) => it.kind !== 'text')) {
    throw new Error('This paragraph contains a formula, citation, or other inset — propose_edit only supports plain-text paragraphs in this version.');
  }
  const font = par.items[0]?.font ?? {};
  if (!par.items.every((it: Item) => fontsEqual(it.font, font))) {
    throw new Error('This paragraph has mixed formatting (e.g. a bold or italic run) — propose_edit only supports uniformly-formatted paragraphs in this version.');
  }
  const oldText = par.items.map(itemText).join('');
  if (oldText === newText) return { changed: false, message: 'No difference from the current text.' };
  const next = lyx.body.slice();
  next[paragraphIndex] = { ...par, items: [textItem(newText, font)] };
  commitTracked(doc, lyx, next, agentName);
  return { changed: true, paragraph_index: paragraphIndex, runs: diffText(oldText, newText), note: 'Applied as a tracked change; a human reviewer can accept/reject it from the Review toolbar.' };
}

interface CommentEntry { index: number; paragraph_index: number; /** 'body', or where the thread sits: 'Float figure', 'table', … */ location: string; resolved: boolean; messages: { author: string; time: string; text: string }[] }

interface CommentHit { inset: TextInset; paragraph_index: number; location: string }

function insetLabel(ins: TextInset): string { return (ins.arg && ins.arg !== ins.name ? `${ins.name} ${ins.arg}` : ins.name).trim(); }

/** Every comment inset of the document in one stable order — inside tables, floats and other insets too. */
function collectComments(lyx: LyxDocument): CommentHit[] {
  const out: CommentHit[] = [];
  const visitItems = (items: Item[], topIdx: number, loc: string): void => {
    for (const it of items) {
      if (it.kind !== 'inset') continue;
      const ins = it.inset;
      if (ins.type === 'Text' && ins.name === 'Note' && ins.arg === 'Comment') { out.push({ inset: ins, paragraph_index: topIdx, location: loc }); continue; }
      if (ins.type === 'Text') {
        const l = loc === 'body' ? insetLabel(ins) : `${loc} › ${insetLabel(ins)}`;
        for (const p of ins.paragraphs) visitItems(p.items, topIdx, l);
      } else if (ins.type === 'Tabular') {
        const l = loc === 'body' ? 'table' : `${loc} › table`;
        for (const row of ins.rows) for (const cell of row.cells) for (const p of cell.paragraphs) visitItems(p.items, topIdx, l);
      }
    }
  };
  lyx.body.forEach((par, i) => visitItems(par.items, i, 'body'));
  return out;
}

function findComments(lyx: LyxDocument): CommentEntry[] {
  return collectComments(lyx).map((h, i) => {
    const thread = parseThread(h.inset.paragraphs);
    return { index: i, paragraph_index: h.paragraph_index, location: h.location, resolved: thread.resolved, messages: thread.messages };
  });
}

async function listComments(project: string, path: string) {
  const { lyx } = await openLyx(project, path);
  return findComments(lyx);
}

async function addComment(project: string, agentName: string, path: string, text: string, paragraphIndex: number | undefined) {
  const { doc, lyx } = await openLyx(project, path);
  const idx = paragraphIndex ?? lyx.body.length - 1;
  const par = lyx.body[idx];
  if (!par) throw new Error(`No paragraph ${idx} — this document has ${lyx.body.length} paragraph(s).`);
  const header = paragraph('Plain Layout', [textItem(commentHeader(authorName(agentName), formatTimestamp()))]);
  const bodyParagraphs = text.split('\n').map(line => paragraph('Plain Layout', [textItem(line)]));
  const inset = textInset('Note', 'Comment', [header, ...bodyParagraphs], 'open');
  par.items.push(insetItem(inset));
  commitEdit(doc, lyx);
  return { ok: true, paragraph_index: idx };
}

async function resolveComment(project: string, path: string, index: number) {
  const { doc, lyx } = await openLyx(project, path);
  const hits = collectComments(lyx);
  const target = hits[index];
  if (!target) throw new Error(`No comment thread at index ${index} — this document has ${hits.length}.`);
  if (parseThread(target.inset.paragraphs).resolved) return { ok: true, message: 'Already resolved.' };
  const headerPar = target.inset.paragraphs[0];
  const h = parseHeader(headerPar.items.map(itemText).join('').trim());
  if (!h) throw new Error('This comment has no structured author/time header (a plain LyX note) — cannot mark it resolved.');
  headerPar.items = [textItem(commentHeader(h.author, h.time, true))];
  commitEdit(doc, lyx);
  return { ok: true };
}

/* ---------------------------------------------------------------- building */

const LOG_TAIL = 15_000;
const logTail = (log: string) => (log.length > LOG_TAIL ? '…' + log.slice(-LOG_TAIL) : log);

function buildStatus(project: string, path: string) {
  const id = `${project}/${path}`;
  const b = lastBuild(id);
  const job = currentJob(id);
  const running = !!job && (job.status === 'queued' || job.status === 'exporting' || job.status === 'compiling');
  return {
    running,
    job: job ? { status: job.status, requestedBy: job.requestedBy, startedAt: job.startedAt, progress: job.progress } : null,
    last: b ? { status: b.status, warnings: b.warnings, pdf: !!(b.pdf_path && fs.existsSync(b.pdf_path)), updated_at: b.updated_at, log_tail: logTail(b.log) } : null,
  };
}

async function buildDocument(project: string, agentName: string, userId: number, path: string, waitSeconds: number) {
  const id = `${project}/${path}`;
  await manager.open(id);                                   // validates the path, flushes pending state
  logAccess(project, userId, 'build', path);
  // what the build is compared with: the panel agent's last build before its changes in this
  // turn (a build since, e.g. the editor's auto-build, may already include them), else the last one
  const panel = agentName === PANEL_AGENT;
  const turnBefore = panel ? buildBeforeTurn(project, userId, `${project}/${findMaster(project, path) ?? path}`) : undefined;
  const previous = turnBefore !== undefined ? turnBefore?.status ?? null : (lastBuild(id)?.status as 'ok' | 'error' | undefined) ?? null;
  const wait = Math.max(5, Math.min(600, waitSeconds));
  let timer: NodeJS.Timeout | undefined;
  const result = await Promise.race([
    buildIncluding(id, authorName(agentName), Date.now()),   // a build that started before the latest edit does not count
    new Promise<null>(res => { timer = setTimeout(() => res(null), wait * 1000); }),
  ]);
  clearTimeout(timer);
  if (result === null) return { ...buildStatus(project, path), note: `Still building after ${wait}s — the build continues; poll build_status.` };
  const out: Record<string, unknown> = { ok: result.ok, warnings: result.warnings, pdf: !!result.pdfPath, previous_build: previous };
  if (!result.ok) {
    out.errors = buildErrors(result.log);
    if (previous === 'ok') out.note = `The build before ${turnBefore !== undefined ? 'your changes in this turn' : 'this one'} succeeded — a recent edit broke it. If it was yours, fix it${panel ? ', or take your changes back with undo_turn' : ', or step back with project_history + restore_project'}; if tracked-change markup is involved, redo the edit with tracked: false. Never leave the document not compiling.`;
  }
  out.log_tail = logTail(result.log);
  return out;
}

async function undoTurn(project: string, userId: number, turnsBack: number) {
  const { tid, n } = agentCheckpoint(project, userId, turnsBack);
  const r = await undoCheckpoint(tid, project, n, userId);
  return {
    ok: true,
    reverted: r.reverted,
    ...(r.kept.length ? { kept: r.kept } : {}),
    note: 'Taken back: those files are as they were before that turn (edits made since are kept). Your working copy was refreshed — re-read the files before editing them again.',
  };
}


/* ------------------------------------------------------ raw LaTeX + files */

const FRAGMENT_MAX = 256 * 1024;
const DOC_MAX = 20_000_000;
const FILE_MAX = 4 * 1024 * 1024;

/** Register the agent as a change-tracking author and switch tracking on. */
function beginTracking(lyx: LyxDocument, agentName: string): { authorId: number; time: number } {
  const author = authorName(agentName);
  const authorId = lyxAuthorId(author, '');
  addAuthor(lyx.header, authorId, author, '');
  setHeaderValue(lyx.header, 'tracking_changes', 'true');
  return { authorId, time: Math.floor(Date.now() / 1000) };
}

/** Replace the body by `next` as the agent's tracked changes — only what differs is marked. */
function commitTracked(doc: Awaited<ReturnType<typeof manager.open>>, lyx: LyxDocument, next: Paragraph[], agentName: string): { inserted: number; deleted: number } {
  const { authorId, time } = beginTracking(lyx, agentName);
  lyx.body = trackDiff(lyx.body, next, { author: authorId, time });
  commitEdit(doc, lyx);
  return changeStats(lyx.body, { author: authorId, time });
}

/** Parse a raw LaTeX fragment in the document's context (its header: class, macros, packages). */
async function parseFragment(project: string, path: string, latex: string) {
  if (!latex.trim()) throw new Error('Empty LaTeX.');
  if (latex.length > FRAGMENT_MAX) throw new Error('LaTeX fragment too large (256 KB).');
  const doc = await manager.open(`${project}/${path}`);
  const r = parseFragmentText(latex, project, doc.relPath, doc.getMeta().headerLines);
  return { doc, lyx: doc.toLyxDocument(), pars: r.doc.body, warnings: r.warnings };
}

async function insertParagraphs(project: string, agentName: string, path: string, index: number, latex: string) {
  const { doc, lyx, pars, warnings } = await parseFragment(project, path, latex);
  if (!pars.length) throw new Error('The LaTeX parsed to no paragraphs.');
  if (index < 0 || index > lyx.body.length) throw new Error(`Insert position ${index} out of range — the document has ${lyx.body.length} paragraph(s); 0 inserts at the top, ${lyx.body.length} appends.`);
  const next = lyx.body.slice();
  next.splice(index, 0, ...pars);
  commitTracked(doc, lyx, next, agentName);
  return { ok: true, inserted: pars.length, at: index, warnings, note: 'Inserted as a tracked change (reviewable from the Review toolbar); paragraph indices shifted — re-run read_document.' };
}

async function replaceParagraph(project: string, agentName: string, path: string, index: number, latex: string) {
  const { doc, lyx, pars, warnings } = await parseFragment(project, path, latex);
  const par = lyx.body[index];
  if (!par) throw new Error(`No paragraph ${index} — this document has ${lyx.body.length} paragraph(s) (see read_document).`);
  if (!pars.length) throw new Error('The LaTeX parsed to no paragraphs — use delete_paragraph to remove one.');
  const next = lyx.body.slice();
  next.splice(index, 1, ...pars);
  const st = commitTracked(doc, lyx, next, agentName);
  return { ok: true, warnings, inserted_chars: st.inserted, deleted_chars: st.deleted, note: 'Applied as tracked changes — only the words / characters that differ are marked; a reviewer accepts or rejects them.' };
}

async function deleteParagraph(project: string, agentName: string, path: string, index: number) {
  const { doc, lyx } = await openLyx(project, path);
  const par = lyx.body[index];
  if (!par) throw new Error(`No paragraph ${index} — this document has ${lyx.body.length} paragraph(s).`);
  const next = lyx.body.slice();
  next.splice(index, 1);
  commitTracked(doc, lyx, next, agentName);
  return { ok: true, note: 'Marked deleted as a tracked change; the text disappears when a reviewer accepts it.' };
}

/** Before a direct (untracked) edit: what is pending is committed, so the state right before it is a commit restore_project can return to. */
async function restorePoint(project: string, userId: number): Promise<void> {
  try { await commitProject(project, { by: userId }); } catch (e) { console.error(`[mcp] commit before a direct edit of "${project}" failed:`, e); }
}

const docLocks = new Map<string, Promise<unknown>>();
/**
 * Agent edits of one document run one after the other. A direct edit waits for its restore point
 * (a git commit) between reading the document and applying the change; two calls in flight at once
 * (parallel tool calls, two agents) both read the same text, both reported success, and the later
 * one silently replaced the earlier one's change. Serialized, the second call reads the first one's
 * result — and fails clearly when its old_text is gone.
 */
async function withDocLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = docLocks.get(id) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  docLocks.set(id, run);
  try { return await run; }
  finally { if (docLocks.get(id) === run) docLocks.delete(id); }
}

function writeDocument(project: string, userId: number, agentName: string, path: string, tex: string, tracked = true) {
  return withDocLock(`${project}/${path}`, () => writeDocumentLocked(project, userId, agentName, path, tex, tracked));
}

async function writeDocumentLocked(project: string, userId: number, agentName: string, path: string, tex: string, tracked: boolean) {
  if (!tex.trim()) throw new Error('tex missing');
  if (tex.length > DOC_MAX) throw new Error('too large');
  if (!path.endsWith('.tex')) throw new Error('a .tex path is expected');
  assertWritableRelPath(path);
  const abs = resolveProjectPath(project, path);
  if (!fs.existsSync(abs)) {
    const r = parseDocumentText(tex, project, path);   // validate and collect warnings before creating
    fs.mkdirSync(nodePath.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, tex, 'utf8');
    touchProject(project, userId);
    return { ok: true, created: true, warnings: r.warnings };
  }
  const doc = await manager.open(`${project}/${path}`);
  if (!tracked) {
    await doc.parseWarnings(tex);   // a source that does not parse fails here, before the commit
    await restorePoint(project, userId);
    const { result: st, warnings } = await doc.agentEdit('plain', null, { after: tex }, { warnings: true });
    touchProject(project, userId);
    return { ok: true, created: false, tracked: false, changed: st.changed, warnings, note: 'Written directly (no tracked changes); the previous state is in the project history (project_history / restore_project).' };
  }
  const { result: st, warnings } = await doc.agentEdit('tracked', null, { after: tex }, { author: authorName(agentName), warnings: true });
  return {
    ok: true, created: false, warnings, inserted_chars: st.inserted, deleted_chars: st.deleted,
    ...(st.direct.length ? { applied_directly: st.direct } : {}),
    note: st.changed ? 'Applied as tracked changes against the current document — only what differs is marked; a reviewer accepts or rejects them.' : 'The source parsed to the same document — nothing changed.',
  };
}

function editDocument(project: string, userId: number, agentName: string, path: string, oldText: string, newText: string, all: boolean, tracked = true) {
  return withDocLock(`${project}/${path}`, () => editDocumentLocked(project, userId, agentName, path, oldText, newText, all, tracked));
}

async function editDocumentLocked(project: string, userId: number, agentName: string, path: string, oldText: string, newText: string, all: boolean, tracked: boolean) {
  const doc = await manager.open(`${project}/${path}`);
  const replace = { oldText, newText, all };
  if (!tracked) {
    replaceInSource(await doc.textAsync(), oldText, newText, all);   // a passage that does not match fails before the commit
    await restorePoint(project, userId);
    // the edit applies to the document as it is then: whatever was typed meanwhile (during the commit)
    // is kept (an old_text somebody changed meanwhile no longer matches — said, not overwritten), and
    // three-way: an edit somebody made meanwhile elsewhere survives
    const { result: st, warnings } = await doc.agentEdit('plain', null, { replace }, { warnings: true });
    touchProject(project, userId);
    return {
      ok: true, tracked: false, warnings,
      ...(st.changed ? {} : { note: 'The edit parsed to the same document — nothing changed (e.g. only whitespace differed).' }),
      now_reads: st.excerpt,
    };
  }
  const { result: st, warnings } = await doc.agentEdit('tracked', null, { replace }, { author: authorName(agentName), warnings: true });
  return {
    ok: true, inserted_chars: st.inserted, deleted_chars: st.deleted, warnings,
    // what changed decides, not the marks: a preamble edit or one's own pending insertion taken back needs none
    ...(!st.changed ? { note: 'The edit parsed to the same document — nothing changed (e.g. only whitespace differed).' }
      : st.inserted + st.deleted === 0 && !st.direct.length ? { note: 'Applied; nothing in it needed a tracked-change mark (e.g. it took back text of your own pending insertion).' } : {}),
    ...(st.direct.length ? { applied_directly: st.direct } : {}),
    now_reads: st.excerpt,
  };
}

/** A new document from the template — with the account's name as its author, like a document made in the editor (not the token's label). */
function createDocument(project: string, userId: number, accountName: string, relPath: string, title?: string) {
  let rel = relPath;
  if (rel.endsWith('.lyx')) rel = rel.slice(0, -4) + '.tex';
  if (!rel.endsWith('.tex')) rel += '.tex';
  assertWritableRelPath(rel);
  const abs = resolveProjectPath(project, rel);
  if (fs.existsSync(abs)) throw new Error('file exists — write_document replaces an existing document');
  fs.mkdirSync(nodePath.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, newDocumentText({ title, author: accountName }), 'utf8');
  touchProject(project, userId);
  return { ok: true, path: rel };
}

function assertTextFilePath(project: string, rel: string): string {
  if (rel.endsWith('.lyx') || isDocumentFile(project, rel)) throw new Error('This is a document — use read_document / write_document (or the paragraph tools).');
  assertWritableRelPath(rel);   // never reach into a repository's .git (a hook/config would run as the server user)
  return resolveProjectPath(project, rel);
}

function readFile(project: string, rel: string) {
  const abs = assertTextFilePath(project, rel);
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) throw new Error(`not found: ${rel}`);
  if (fs.statSync(abs).size > FILE_MAX) throw new Error('file too large (4 MB)');
  const buf = fs.readFileSync(abs);
  if (buf.includes(0)) throw new Error('not a text file');
  return { text: buf.toString('utf8'), size: buf.length };
}

function writeFile(project: string, userId: number, rel: string, text: string) {
  const abs = assertTextFilePath(project, rel);
  if (Buffer.byteLength(text) > FILE_MAX) throw new Error('file too large (4 MB)');
  fs.mkdirSync(nodePath.dirname(abs), { recursive: true });
  const tmp = abs + '.overlyx-tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, abs);
  touchProject(project, userId);
  return { ok: true, size: Buffer.byteLength(text) };
}

function editFile(project: string, userId: number, rel: string, oldText: string, newText: string, all: boolean) {
  const { text } = readFile(project, rel);
  if (!oldText) throw new Error('old_text is empty — write_file replaces a whole file.');
  const n = text.split(oldText).length - 1;
  if (!n) throw new Error(`old_text does not occur in ${rel} — read_file it again and copy the passage exactly.`);
  if (n > 1 && !all) throw new Error(`old_text occurs ${n} times in ${rel} — include more context, or set replace_all.`);
  const next = all ? text.split(oldText).join(newText) : text.replace(oldText, () => newText);
  return { ...writeFile(project, userId, rel, next), replaced: all ? n : 1 };
}

function listFiles(project: string) {
  const p = listProjects().find(x => x.name === project);
  return (p?.files ?? []).map(f => ({ path: f.path, kind: f.kind, size: f.size }));
}

/* ---------------------------------------------------- search across all projects (ChatGPT's search/fetch pair) */

const docUrl = (project: string, path: string) => `${(config.publicUrl || 'https://overlyx.app').replace(/\/$/, '')}/#/${project.split('/').map(encodeURIComponent).join('/')}/${path}`;

/** Naive full-text search over the account's projects (documents, .tex, .bib) — enough for a
 *  connector's "find the passage, then fetch the file"; projects are small LaTeX trees. */
function searchDocs(user: SessionUser, query: string) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  if (!terms.length) return [];
  const hits: { id: string; title: string; text: string; url: string; score: number }[] = [];
  for (const p of accessibleProjects(user)) {
    for (const f of p.files) {
      if (f.kind !== 'doc' && f.kind !== 'tex' && f.kind !== 'bib') continue;
      let text: string;
      try {
        const abs = resolveProjectPath(p.name, f.path);
        if (fs.statSync(abs).size > FILE_MAX) continue;
        text = fs.readFileSync(abs, 'utf8');
      } catch { continue; }
      const lower = text.toLowerCase();
      let score = 0, first = -1;
      for (const t of terms) { const i = lower.indexOf(t); if (i >= 0) { score++; if (first < 0 || i < first) first = i; } }
      if (!score) continue;
      const snippet = text.slice(Math.max(0, first - 80), first + 200).replace(/\s+/g, ' ').trim();
      hits.push({ id: `${p.name}/${f.path}`, title: `${p.title ?? p.name} — ${f.path}`, text: snippet, url: docUrl(p.name, f.path), score });
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 20).map(({ score: _s, ...r }) => r);
}

async function fetchDoc(user: SessionUser, id: string) {
  id = canonicalDocId(id);   // an id from before its project moved (namespaces.ts)
  const { project, path: rel } = splitDocId(id);
  if (!project || !rel) throw new Error('id must be "owner/project/path" (from search or list_files).');
  if (!atLeast(roleFor(user, project), 'view')) throw new Error(`This account has no access to project "${project}".`);
  let text: string;
  if (isDocumentFile(project, rel)) {
    const doc = await manager.open(id);
    text = await doc.textAsync();
  } else {
    const abs = resolveProjectPath(project, rel);
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) throw new Error(`not found: ${id}`);
    if (fs.statSync(abs).size > FILE_MAX) throw new Error('file too large (4 MB)');
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) throw new Error('not a text file');
    text = buf.toString('utf8');
  }
  return { id, title: id, text, url: docUrl(project, rel), metadata: { project, path: rel } };
}

/**
 * How an agent should work here — the MCP `instructions` a client passes to its model. Tracked
 * changes are the default (reviewable), but they must never leave a document broken or an agent
 * stuck: on any problem it falls back to direct edits, and the git history is the way back.
 */
export const MCP_INSTRUCTIONS = `OverLyX projects are LaTeX documents that people may be editing in a browser at the same time. You edit the files on the OverLyX server directly through these tools; there is nothing to sync.

Workflow: list_projects → list_documents / list_files → read_document (a document's full LaTeX source) or read_file (other text files) → edit → build_pdf.

Editing documents: edit_document (replace a passage) and write_document (a whole source) apply your change as TRACKED CHANGES by default, so the user can review them. Tracked editing must never block you or leave a document broken. On ANY problem with it, switch to direct editing at once by passing tracked: false to edit_document / write_document — the same edit, applied without tracked-change marks. Problems that call for the fallback include: an edit that fails to apply or does not match (do not retry a failing tracked edit more than once); tracked-change markup (\\lyxadded / \\lyxdeleted) making the passage hard to address; a result (now_reads) that looks garbled, duplicated or incomplete; a build that fails after your tracked edit, or whose errors point at tracked-change markup; math, tables, environments or preamble changes the tracked form mangles; the user asking for direct edits. When a tracked edit of yours broke something, take it back (project_history + restore_project, or edit_document with tracked: false restoring the old text) and redo it with tracked: false. Keep other people's tracked changes intact.

Other text files (refs.bib, macros, .sty) are always edited directly: edit_file (replace a passage) or write_file.

After every change run build_pdf and never leave a document that does not compile: fix the error, or step back. project_history lists the project's commits (OverLyX commits every edit shortly after it happens, and right before each of your direct edits); restore_project puts the whole project back to one of them as a new commit, so nothing is lost.

Leave the block between "%% OverLyX ---" and "%% end OverLyX ---" alone (regenerated on every save); put preamble additions above it. OverLyX may rewrite what you wrote into its canonical form (spacing, line breaks) — read again before editing the same passage.`;

/** One MCP server instance for `user`'s account: scoped to `fixedProject` when connected at
 *  /mcp/<project> (the classic form), or across every project the account can reach when
 *  connected at /mcp — each tool then takes `project`, and the account's role in that project
 *  is checked per call. Tools are attributed to `agentName`. */
function buildMcpServer(user: SessionUser, agentName: string, userId: number, fixedProject: string | null): McpServer {
  const server = new McpServer({ name: 'overlyx', version: '1.0.0' }, { instructions: MCP_INSTRUCTIONS });
  const projArg = {
    project: z.string().optional().describe(fixedProject
      ? 'Ignored — this connection is fixed to one project'
      : 'The project to work in — its key "owner/name" from list_projects (required on this all-projects connection)'),
  };
  /** Resolve and authorize the project of one call. */
  const need = (arg: unknown, min: 'view' | 'edit'): string => {
    // a key `<owner>/<name>` from list_projects, or a name the project had before (namespaces.ts)
    const project = fixedProject ?? canonicalProject(String(arg ?? '').trim());
    if (!project) throw new Error('No project given — pass `project` (list_projects names the reachable ones).');
    const role = roleFor(user, project);
    if (!atLeast(role, 'view')) throw new Error(`This account has no access to a project "${project}" (see list_projects).`);
    if (min === 'edit' && !atLeast(role, 'edit')) throw new Error(`This token's account has view-only access to project "${project}" — reading is allowed, editing and commenting are not.`);
    if (!fs.existsSync(projectDir(project))) throw new Error(`No project "${project}".`);
    return project;
  };
  /** `tracked` when a document tool is called without it: tracked, unless it is the panel's agent and its Track changes box is off */
  const trackedDefault = (project: string): boolean => agentName !== PANEL_AGENT || panelTracking(userId, project);

  server.registerTool('list_documents', {
    description: 'List the .tex documents in a project.',
    annotations: { readOnlyHint: true },
    inputSchema: { ...projArg },
  }, async ({ project: p }) => { try { return ok(listDocuments(need(p, 'view'))); } catch (e) { return fail(e); } });

  server.registerTool('read_document', {
    description: 'Read a document: its full LaTeX source (`text` — what edit_document edits), and its paragraphs (index, layout, depth, plain text) for the paragraph tools and add_comment.',
    annotations: { readOnlyHint: true },
    inputSchema: { ...projArg, path: z.string().describe('Project-relative path, e.g. "main.tex"') },
  }, async ({ project: p, path }) => { try { return ok(await readDocument(need(p, 'view'), path)); } catch (e) { return fail(e); } });

  server.registerTool('propose_edit', {
    description: 'Replace the text of one plain-text paragraph. Always applied as a tracked change (insertions/deletions attributed to this agent) — never a silent overwrite. Only works on paragraphs with no formulas/insets and uniform formatting; read_document first to get paragraph indices and check the content is plain.',
    inputSchema: {
      ...projArg,
      path: z.string(),
      paragraph_index: z.number().int().nonnegative().describe('From read_document\'s paragraphs list'),
      new_text: z.string().describe('The complete new text of the paragraph'),
    },
  }, async ({ project: p, path, paragraph_index, new_text }) => { try { return ok(await proposeEdit(need(p, 'edit'), agentName, path, paragraph_index, new_text)); } catch (e) { return fail(e); } });

  server.registerTool('list_comments', {
    description: 'List comment threads in a document: index, the top-level paragraph they belong to, where they sit (body, a float, a table cell, …), messages, resolved state. Finds threads anywhere — inside tables, floats and other insets too.',
    annotations: { readOnlyHint: true },
    inputSchema: { ...projArg, path: z.string() },
  }, async ({ project: p, path }) => { try { return ok(await listComments(need(p, 'view'), path)); } catch (e) { return fail(e); } });

  server.registerTool('add_comment', {
    description: 'Add a new comment thread, attached to the end of a paragraph (default: the last paragraph of the document).',
    inputSchema: {
      ...projArg,
      path: z.string(),
      text: z.string(),
      paragraph_index: z.number().int().nonnegative().optional().describe('Defaults to the last paragraph'),
    },
  }, async ({ project: p, path, text, paragraph_index }) => { try { return ok(await addComment(need(p, 'edit'), agentName, path, text, paragraph_index)); } catch (e) { return fail(e); } });

  server.registerTool('resolve_comment', {
    description: 'Mark a comment thread resolved (index from list_comments, in the same call — the document may have changed since an earlier listing).',
    inputSchema: { ...projArg, path: z.string(), index: z.number().int().nonnegative() },
  }, async ({ project: p, path, index }) => { try { return ok(await resolveComment(need(p, 'edit'), path, index)); } catch (e) { return fail(e); } });

  server.registerTool('build_pdf', {
    description: 'Compile the document to PDF with latexmk and wait for the result (viewers may build, like in the app). Returns ok, the LaTeX warnings, previous_build (whether the build before your changes succeeded), on failure the first errors (file:line: message) and a note when your changes broke it, and the tail of the compile log; on timeout the build keeps running — poll build_status. Humans open the PDF in the app.',
    inputSchema: { ...projArg, path: z.string(), wait_seconds: z.number().int().positive().max(600).optional().describe('How long to wait before returning (default 180; the build continues on timeout)') },
  }, async ({ project: p, path, wait_seconds }) => { try { return ok(await buildDocument(need(p, 'view'), agentName, userId, path, wait_seconds ?? 180)); } catch (e) { return fail(e); } });

  if (agentName === PANEL_AGENT) server.registerTool('undo_turn', {
    description: "Take back every change one of your turns made to the project: its documents return exactly to their state before that turn (your tracked changes of the turn disappear, as if rejected — earlier marks and everybody else's edits since are kept), files it wrote get their old content back, files it created are removed. turns_back 0 (default) = the changes of the turn you are in (e.g. an edit that broke the build and cannot be fixed quickly); 1 = the last earlier turn that changed files, 2 = the one before, … Your working copy is refreshed afterwards.",
    inputSchema: { ...projArg, turns_back: z.number().int().min(0).max(30).optional().describe('0 = this turn (default), 1 = the previous turn that changed files, …') },
  }, async ({ project: p, turns_back }) => { try { return ok(await undoTurn(need(p, 'edit'), userId, turns_back ?? 0)); } catch (e) { return fail(e); } });

  server.registerTool('project_history', {
    description: "The project's recent history: its git commits, newest first (hash, author, date, message). OverLyX commits what people and agents edit a moment after it happens, so a commit from before a change is the state to go back to with restore_project.",
    annotations: { readOnlyHint: true },
    inputSchema: { ...projArg, limit: z.number().int().positive().max(100).optional().describe('How many commits (default 20)') },
  }, async ({ project: p, limit }) => { try { const info = await repoInfo(need(p, 'view'), limit ?? 20); return ok({ commits: info.commits.map(c => ({ ...c, date: new Date(c.date).toISOString() })), uncommitted_files: info.pendingFiles }); } catch (e) { return fail(e); } });

  server.registerTool('restore_project', {
    description: "Step back: put the whole project (every file) back to how it was at a commit from project_history — e.g. before changes that broke the build and cannot be fixed quickly. Done as a new commit on top, so nothing is lost and the restore can itself be undone the same way; edits made since that commit (anybody's) are taken back too, so check project_history first. Open documents take the restored text over.",
    inputSchema: { ...projArg, commit: z.string().describe('A commit hash (7+ hex digits) from project_history') },
  }, async ({ project: p, commit }) => { try { const project = need(p, 'edit'); const r = await restoreProject(project, commit.trim().toLowerCase(), userId); logAccess(project, userId, 'git-push', `restore ${commit.slice(0, 12)} (MCP)`); return ok(r.restored ? { ok: true, restored_files: r.files, note: 'Restored as a new commit. Re-read documents before editing them again.' } : { ok: true, restored_files: [], note: 'The project already is as it was at that commit.' }); } catch (e) { return fail(e); } });

  server.registerTool('build_status', {
    description: "The document's build state: whether a build is running, and the last result (status, LaTeX warnings, compile-log tail, whether a PDF exists).",
    annotations: { readOnlyHint: true },
    inputSchema: { ...projArg, path: z.string() },
  }, async ({ project: p, path }) => { try { return ok(buildStatus(need(p, 'view'), path)); } catch (e) { return fail(e); } });

  server.registerTool('list_files', {
    description: 'All files of the project (kind: doc/tex/bib/image/pdf/…) — documents open with read_document, other text files with read_file.',
    annotations: { readOnlyHint: true },
    inputSchema: { ...projArg },
  }, async ({ project: p }) => { try { return ok(listFiles(need(p, 'view'))); } catch (e) { return fail(e); } });

  server.registerTool('read_file', {
    description: 'Read a text file of the project (refs.bib, macros.tex, .sty, …). For documents use read_document.',
    annotations: { readOnlyHint: true },
    inputSchema: { ...projArg, path: z.string() },
  }, async ({ project: p, path }) => { try { return ok(readFile(need(p, 'view'), path)); } catch (e) { return fail(e); } });

  server.registerTool('write_file', {
    description: 'Write a text file of the project (e.g. add BibTeX entries to refs.bib). Overwrites the file — git history keeps every prior state. For documents use write_document or the paragraph tools.',
    inputSchema: { ...projArg, path: z.string(), text: z.string() },
  }, async ({ project: p, path, text }) => { try { return ok(writeFile(need(p, 'edit'), userId, path, text)); } catch (e) { return fail(e); } });

  server.registerTool('edit_file', {
    description: 'Edit a text file of the project (refs.bib, macros.tex, a .sty, …) by replacing a passage: old_text must occur exactly once unless replace_all. Applied directly, like write_file — git history keeps every prior state. For documents use edit_document.',
    inputSchema: {
      ...projArg, path: z.string(),
      old_text: z.string().describe('The passage to replace, exactly as read_file returned it'),
      new_text: z.string(),
      replace_all: z.boolean().optional(),
    },
  }, async ({ project: p, path, old_text, new_text, replace_all }) => { try { return ok(editFile(need(p, 'edit'), userId, path, old_text, new_text, !!replace_all)); } catch (e) { return fail(e); } });

  server.registerTool('edit_document', {
    description: "Edit a document by replacing a passage of its LaTeX source (the `text` read_document returns): old_text must occur exactly once — include enough surrounding text to make it unique, or set replace_all. Any LaTeX is allowed in new_text (formulas, citations, environments, paragraph breaks). Applied as tracked changes attributed to this agent and diffed against the live document, so only what actually changes is marked (a word, a digit, a table cell); the user reviews them in the editor. Tracked-change markup (\\lyxadded / \\lyxdeleted) may be left out of old_text; whitespace differences are tolerated. Returns now_reads: the edited lines as the document now reads, for follow-up edits; applied_directly lists what was applied without marks (the preamble is never tracked). Prefer this over the paragraph tools. With tracked: false the same edit is applied directly, without marks — use that as soon as a tracked edit fails, garbles the passage or breaks the build.",
    inputSchema: {
      ...projArg,
      path: z.string().describe('Project-relative path, e.g. "main.tex"'),
      old_text: z.string().describe('The passage to replace, copied from the document source'),
      new_text: z.string().describe('Its replacement (raw LaTeX)'),
      replace_all: z.boolean().optional().describe('Replace every occurrence (default: old_text must be unique)'),
      tracked: z.boolean().optional().describe('true (default): a tracked change for review. false: applied directly, no tracked-change marks — the fallback whenever tracked editing runs into any problem (see the server instructions); the previous state stays in the project history'),
    },
  }, async ({ project: p, path, old_text, new_text, replace_all, tracked }) => { try { const project = need(p, 'edit'); return ok(await editDocument(project, userId, agentName, path, old_text, new_text, !!replace_all, tracked ?? trackedDefault(project))); } catch (e) { return fail(e); } });

  server.registerTool('insert_paragraphs', {
    description: 'Insert raw LaTeX (anything: formulas, citations, sections, environments — parsed like the editor parses .tex) as new paragraphs at a position: 0 = top, paragraph count = append. Applied as a tracked insertion, reviewable like any collaborator edit. Indices shift — re-run read_document afterwards.',
    inputSchema: { ...projArg, path: z.string(), index: z.number().int().nonnegative().describe('Position from read_document; the paragraph count appends'), latex: z.string() },
  }, async ({ project: p, path, index, latex }) => { try { return ok(await insertParagraphs(need(p, 'edit'), agentName, path, index, latex)); } catch (e) { return fail(e); } });

  server.registerTool('replace_paragraph', {
    description: 'Replace one paragraph by raw LaTeX (may parse to several paragraphs; formulas, citations, anything allowed). Tracked, and diffed against the old paragraph: only the words / characters that differ are marked (inside tables and footnotes too).',
    inputSchema: { ...projArg, path: z.string(), index: z.number().int().nonnegative().describe("From read_document's paragraphs list"), latex: z.string() },
  }, async ({ project: p, path, index, latex }) => { try { return ok(await replaceParagraph(need(p, 'edit'), agentName, path, index, latex)); } catch (e) { return fail(e); } });

  server.registerTool('delete_paragraph', {
    description: 'Mark one paragraph deleted as a tracked change (the text disappears when a reviewer accepts it).',
    inputSchema: { ...projArg, path: z.string(), index: z.number().int().nonnegative() },
  }, async ({ project: p, path, index }) => { try { return ok(await deleteParagraph(need(p, 'edit'), agentName, path, index)); } catch (e) { return fail(e); } });

  server.registerTool('write_document', {
    description: "Write a document's whole raw LaTeX source, or create the document when the path does not exist. On an existing document the new source is diffed against the current one and applied as tracked changes (only what differs is marked) — or, with tracked: false, written directly. For a local change prefer edit_document.",
    inputSchema: {
      ...projArg, path: z.string(), tex: z.string(),
      tracked: z.boolean().optional().describe('true (default): a tracked change for review. false: applied directly, no tracked-change marks — the fallback whenever tracked editing runs into any problem (see the server instructions); the previous state stays in the project history'),
    },
  }, async ({ project: p, path, tex, tracked }) => { try { const project = need(p, 'edit'); return ok(await writeDocument(project, userId, agentName, path, tex, tracked ?? trackedDefault(project))); } catch (e) { return fail(e); } });

  server.registerTool('create_document', {
    description: 'Create a new .tex document from the standard template (write_document with full source also creates).',
    inputSchema: { ...projArg, path: z.string(), title: z.string().optional() },
  }, async ({ project: p, path, title }) => { try { return ok(createDocument(need(p, 'edit'), userId, user.name, path, title)); } catch (e) { return fail(e); } });

  server.registerTool('list_projects', {
    description: 'The projects this account can reach (name, title, its role in each). On the all-projects connection (/mcp), the other tools take one of these names as `project`.',
    annotations: { readOnlyHint: true },
    inputSchema: {},
  }, async () => { try { return ok(accessibleProjects(user).map(pr => ({ project: pr.name, title: pr.title ?? null, role: pr.role }))); } catch (e) { return fail(e); } });

  // Project creation is account-wide, so it belongs only on /mcp. Once created, the ordinary
  // write_document/write_file tools can populate it; a local client can alternatively push its
  // existing repository with the OverLyX CLI.
  if (!fixedProject) server.registerTool('create_project', {
    description: 'Create an empty project owned by this account. Then populate it with create_document, write_document and write_file, or push an existing local repository with the OverLyX CLI.',
    inputSchema: {
      name: z.string().describe('Project name (letters, numbers, spaces, dot, dash and underscore); the project is created as "<your username>/<name>"'),
      title: z.string().max(200).optional(),
    },
  }, async ({ name, title }) => {
    try {
      const key = createOwnedProject(name, userId, { title: title?.trim() || null }).name;
      await ensureRepo(key);
      return ok({ project: key, title: title?.trim() || null, role: 'owner' });
    } catch (e) { return fail(e); }
  });

  // ChatGPT's connector pair (deep research requires exactly these two; citations need a url)
  server.registerTool('search', {
    description: 'Full-text search across the LaTeX documents, .tex and .bib files of every project this account can access. Returns ids for fetch.',
    annotations: { readOnlyHint: true },
    inputSchema: { query: z.string() },
  }, async ({ query }) => { try { return okStruct({ results: searchDocs(user, query) }); } catch (e) { return fail(e); } });

  server.registerTool('fetch', {
    description: 'The full text of one search result or file, by id ("owner/project/path").',
    annotations: { readOnlyHint: true },
    inputSchema: { id: z.string() },
  }, async ({ id }) => { try { return okStruct(await fetchDoc(user, id)); } catch (e) { return fail(e); } });

  return server;
}

/** the largest JSON-RPC request accepted (a whole document in write_document) */
const REQUEST_MAX = '2mb';

/** POST /mcp/<owner>/<project> — one stateless request/response per JSON-RPC call (no session, no SSE stream kept open). */
export function mcpRouter(): express.Router {
  const r = express.Router();
  r.use(express.json({ limit: REQUEST_MAX }));
  r.post('/', (req, res) => { void handle(req, res); });          // all projects (tools take `project`)
  // fixed to one project: its key, or a name it had before (the flat layout's `/mcp/<name>`)
  r.post('/:owner/:project', (req, res) => { void handle(req, res); });
  r.post('/:project', (req, res) => { void handle(req, res); });
  // a request the body parser refused (too large, not JSON) is answered in JSON-RPC, not with
  // Express's HTML error page (which an MCP client cannot read, and which carried a stack trace)
  r.use((err: { type?: string; status?: number; message?: string }, _req: Request, res: Response, next: express.NextFunction) => {
    if (res.headersSent) { next(err); return; }
    const tooLarge = err.type === 'entity.too.large';
    const parse = err.type === 'entity.parse.failed';
    res.status(tooLarge ? 413 : err.status && err.status < 500 ? err.status : 400).json({
      jsonrpc: '2.0', id: null,
      error: tooLarge
        ? { code: -32600, message: `Request too large: a call may carry at most ${REQUEST_MAX.toUpperCase()}. Write a large document in parts — write_document a first part, then add the rest with insert_paragraphs or edit_document.` }
        : { code: parse ? -32700 : -32600, message: parse ? 'Parse error: the request body is not valid JSON.' : `Invalid request: ${err.message ?? 'unreadable body'}` },
    });
  });
  return r;
}

async function handle(req: Request, res: Response): Promise<void> {
  let project: string | null = null;
  if (req.params.project !== undefined) {
    try { project = canonicalProject((req.params.owner !== undefined ? req.params.owner + '/' : '') + decodeURIComponent(req.params.project)); } catch { res.status(400).json({ error: 'bad project name' }); return; }
  }
  const auth = req.header('authorization') ?? '';
  const m = /^Bearer\s+(\S+)/i.exec(auth);
  // 401 + WWW-Authenticate points OAuth clients (ChatGPT) at the protected-resource metadata
  if (!m) { res.setHeader('WWW-Authenticate', wwwAuthenticate(req)); res.status(401).json({ error: 'Authorization: Bearer <token> required (use your account token from File \u25b8 Git repository\u2026, or connect via OAuth)' }); return; }
  const identity = verifyMcpToken(m[1]);
  if (!identity) { res.setHeader('WWW-Authenticate', wwwAuthenticate(req)); res.status(401).json({ error: 'invalid or expired token' }); return; }
  const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(identity.userId) as UserRow | undefined;
  if (!userRow) { res.status(403).json({ error: 'the account behind this token no longer exists' }); return; }
  const user = toSessionUser(userRow);
  if (project !== null) {
    const role = roleFor(user, project);
    if (!atLeast(role, 'view')) { res.status(403).json({ error: `this token's account has no access to project "${project}"` }); return; }
    if (!fs.existsSync(projectDir(project))) { res.status(404).json({ error: `no project "${project}"` }); return; }
  }

  const server = buildMcpServer(user, identity.name, identity.userId, project);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { void transport.close(); void server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: (e as Error).message ?? String(e) });
  }
}
