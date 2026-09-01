/**
 * MCP connector: lets an external agent (any MCP-compatible client) read a project's documents,
 * read/add/resolve comment threads, and propose text edits. The bearer token identifies an
 * *account* (see mcpTokens.ts) — the agent may connect to any project that account can access,
 * with the account's role there: viewers read, editors also comment and propose edits. Edits are NEVER applied as a plain overwrite: every
 * `propose_edit` call is turned into change-tracked insertions/deletions (the same `\lyxadded` /
 * `\lyxdeleted` machinery a human editor's Track Changes produces), attributed to the token's name
 * suffixed "(MCP)" — so a misbehaving or over-eager agent is always reviewable and revertible from
 * the Review toolbar / Versions, exactly like a human collaborator's tracked edit.
 *
 * Raw LaTeX is a first-class input: insert_paragraphs / replace_paragraph accept any LaTeX
 * (formulas, citations, sections, environments — the same .tex parser as the editor) and are
 * applied as tracked changes; write_document replaces or creates a whole document's source,
 * untracked like the raw-source view (Versions/git keep the prior state); read_file/write_file
 * reach the project's other text files (refs.bib, macros.tex, …). propose_edit remains the
 * word-diff tool for plain-text paragraphs. Comment threads are found anywhere in the body —
 * inside tables, floats and other insets too; new threads attach at a top-level paragraph.
 * build_pdf compiles with latexmk (viewers may, like in the app) and hands back the warnings
 * and the compile-log tail.
 */
import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import fs from 'node:fs';
import {
  plainText, itemText, paragraph, textItem, insetItem, textInset, addAuthor, lyxAuthorId, fontsEqual,
  setHeaderValue, diffText, commentHeader, formatTimestamp, parseHeader, parseThread,
  type LyxDocument, type Item, type TextInset,
} from '@overlyx/core';
import nodePath from 'node:path';
import { manager } from './docs.ts';
import { listProjects, projectDir, resolveProjectPath, isDocumentFile, newDocumentText } from './projects.ts';
import { parseDocumentText, parseFragmentText } from './texdoc.ts';
import { touchProject } from './git.ts';
import { buildPdf as runBuild, lastBuild, currentJob } from './export.ts';
import { verifyMcpToken } from './mcpTokens.ts';
import { roleFor, atLeast, logAccess } from './access.ts';
import { toSessionUser } from './auth.ts';
import { db, type UserRow } from './db.ts';

function ok(value: unknown) {
  return { content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}
function fail(e: unknown) {
  return { content: [{ type: 'text' as const, text: (e as Error)?.message ?? String(e) }], isError: true };
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
  const { doc, lyx } = await openLyx(project, path);
  return {
    text: doc.toText(),
    paragraphs: lyx.body.map((p, i) => ({ index: i, layout: p.layout, depth: p.depth, text: p.items.map(itemText).join('') })),
  };
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
  const author = authorName(agentName);
  const authorId = lyxAuthorId(author, '');
  const time = Math.floor(Date.now() / 1000);
  const runs = diffText(oldText, newText);
  par.items = runs.map(r => textItem(r.text, font, r.type === 'same' ? undefined : { type: r.type === 'add' ? 'inserted' : 'deleted', author: authorId, time }));
  addAuthor(lyx.header, authorId, author, '');
  setHeaderValue(lyx.header, 'tracking_changes', 'true');
  commitEdit(doc, lyx);
  return { changed: true, paragraph_index: paragraphIndex, runs, note: 'Applied as a tracked change; a human reviewer can accept/reject it from the Review toolbar.' };
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
  const wait = Math.max(5, Math.min(600, waitSeconds));
  let timer: NodeJS.Timeout | undefined;
  const result = await Promise.race([
    runBuild(id, { requestedBy: authorName(agentName) }),
    new Promise<null>(res => { timer = setTimeout(() => res(null), wait * 1000); }),
  ]);
  clearTimeout(timer);
  if (result === null) return { ...buildStatus(project, path), note: `Still building after ${wait}s — the build continues; poll build_status.` };
  return { ok: result.ok, warnings: result.warnings, pdf: !!result.pdfPath, log_tail: logTail(result.log) };
}


/* ------------------------------------------------------ raw LaTeX + files */

const FRAGMENT_MAX = 256 * 1024;
const DOC_MAX = 20_000_000;
const FILE_MAX = 4 * 1024 * 1024;

function trackItems(items: Item[], authorId: number, type: 'inserted' | 'deleted', time: number): void {
  for (const it of items) it.change = { type, author: authorId, time };
}

/** Register the agent as a change-tracking author and switch tracking on. */
function beginTracking(lyx: LyxDocument, agentName: string): { authorId: number; time: number } {
  const author = authorName(agentName);
  const authorId = lyxAuthorId(author, '');
  addAuthor(lyx.header, authorId, author, '');
  setHeaderValue(lyx.header, 'tracking_changes', 'true');
  return { authorId, time: Math.floor(Date.now() / 1000) };
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
  const { authorId, time } = beginTracking(lyx, agentName);
  for (const p of pars) trackItems(p.items, authorId, 'inserted', time);
  lyx.body.splice(index, 0, ...pars);
  commitEdit(doc, lyx);
  return { ok: true, inserted: pars.length, at: index, warnings, note: 'Inserted as a tracked change (reviewable from the Review toolbar); paragraph indices shifted — re-run read_document.' };
}

async function replaceParagraph(project: string, agentName: string, path: string, index: number, latex: string) {
  const { doc, lyx, pars, warnings } = await parseFragment(project, path, latex);
  const par = lyx.body[index];
  if (!par) throw new Error(`No paragraph ${index} — this document has ${lyx.body.length} paragraph(s) (see read_document).`);
  if (!pars.length) throw new Error('The LaTeX parsed to no paragraphs — use delete_paragraph to remove one.');
  const { authorId, time } = beginTracking(lyx, agentName);
  const plain = (p: typeof par) => p.items.every((it: Item) => it.kind === 'text' && fontsEqual(it.font, p.items[0]?.font ?? {}));
  if (pars.length === 1 && plain(par) && plain(pars[0]) && pars[0].layout === par.layout) {
    // plain text to plain text: a word-level diff, like propose_edit — the minimal reviewable change
    const font = par.items[0]?.font ?? {};
    const runs = diffText(par.items.map(itemText).join(''), pars[0].items.map(itemText).join(''));
    par.items = runs.map(r => textItem(r.text, font, r.type === 'same' ? undefined : { type: r.type === 'add' ? 'inserted' : 'deleted', author: authorId, time }));
  } else {
    trackItems(par.items, authorId, 'deleted', time);
    for (const p of pars) trackItems(p.items, authorId, 'inserted', time);
    lyx.body.splice(index + 1, 0, ...pars);
  }
  commitEdit(doc, lyx);
  return { ok: true, warnings, note: 'Applied as a tracked change (old text marked deleted, new content inserted); a reviewer accepts or rejects it.' };
}

async function deleteParagraph(project: string, agentName: string, path: string, index: number) {
  const { doc, lyx } = await openLyx(project, path);
  const par = lyx.body[index];
  if (!par) throw new Error(`No paragraph ${index} — this document has ${lyx.body.length} paragraph(s).`);
  const { authorId, time } = beginTracking(lyx, agentName);
  trackItems(par.items, authorId, 'deleted', time);
  commitEdit(doc, lyx);
  return { ok: true, note: 'Marked deleted as a tracked change; the text disappears when a reviewer accepts it.' };
}

async function writeDocument(project: string, userId: number, path: string, tex: string) {
  if (!tex.trim()) throw new Error('tex missing');
  if (tex.length > DOC_MAX) throw new Error('too large');
  if (!path.endsWith('.tex')) throw new Error('a .tex path is expected');
  const abs = resolveProjectPath(project, path);
  if (!fs.existsSync(abs)) {
    const r = parseDocumentText(tex, project, path);   // validate and collect warnings before creating
    fs.mkdirSync(nodePath.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, tex, 'utf8');
    touchProject(project, userId);
    return { ok: true, created: true, warnings: r.warnings };
  }
  const doc = await manager.open(`${project}/${path}`);
  const r = parseDocumentText(tex, doc.project, doc.relPath);
  doc.loadFromLyx(r.doc, 'source');
  doc.scheduleSave();
  return { ok: true, created: false, warnings: r.warnings, note: 'Replaced the whole source (not a tracked change — like the raw-source view; the prior state is kept in Versions and git).' };
}

function createDocument(project: string, userId: number, agentName: string, relPath: string, title?: string) {
  let rel = relPath;
  if (rel.endsWith('.lyx')) rel = rel.slice(0, -4) + '.tex';
  if (!rel.endsWith('.tex')) rel += '.tex';
  const abs = resolveProjectPath(project, rel);
  if (fs.existsSync(abs)) throw new Error('file exists — write_document replaces an existing document');
  fs.mkdirSync(nodePath.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, newDocumentText({ title, author: authorName(agentName) }), 'utf8');
  touchProject(project, userId);
  return { ok: true, path: rel };
}

function assertTextFilePath(project: string, rel: string): string {
  if (rel.endsWith('.lyx') || isDocumentFile(project, rel)) throw new Error('This is a document — use read_document / write_document (or the paragraph tools).');
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

function listFiles(project: string) {
  const p = listProjects().find(x => x.name === project);
  return (p?.files ?? []).map(f => ({ path: f.path, kind: f.kind, size: f.size }));
}

/** Builds one MCP server instance scoped to `project`, tools attributed to `agentName`; without `canEdit` the mutating tools refuse. */
function buildMcpServer(project: string, agentName: string, canEdit: boolean, userId: number): McpServer {
  const server = new McpServer({ name: 'overlyx', version: '1.0.0' });
  const needEdit = () => { if (!canEdit) throw new Error("This token's account has view-only access to this project — reading is allowed, editing and commenting are not."); };

  server.registerTool('list_documents', {
    description: 'List the .tex documents in this project.',
    inputSchema: {},
  }, async () => { try { return ok(listDocuments(project)); } catch (e) { return fail(e); } });

  server.registerTool('read_document', {
    description: 'Read a document: its full LaTeX text, and its paragraphs (index, layout, depth, plain text) for addressing propose_edit / add_comment.',
    inputSchema: { path: z.string().describe('Project-relative path, e.g. "main.tex"') },
  }, async ({ path }) => { try { return ok(await readDocument(project, path)); } catch (e) { return fail(e); } });

  server.registerTool('propose_edit', {
    description: 'Replace the text of one plain-text paragraph. Always applied as a tracked change (insertions/deletions attributed to this agent) — never a silent overwrite. Only works on paragraphs with no formulas/insets and uniform formatting; read_document first to get paragraph indices and check the content is plain.',
    inputSchema: {
      path: z.string(),
      paragraph_index: z.number().int().nonnegative().describe('From read_document\'s paragraphs list'),
      new_text: z.string().describe('The complete new text of the paragraph'),
    },
  }, async ({ path, paragraph_index, new_text }) => { try { needEdit(); return ok(await proposeEdit(project, agentName, path, paragraph_index, new_text)); } catch (e) { return fail(e); } });

  server.registerTool('list_comments', {
    description: 'List comment threads in a document: index, the top-level paragraph they belong to, where they sit (body, a float, a table cell, …), messages, resolved state. Finds threads anywhere — inside tables, floats and other insets too.',
    inputSchema: { path: z.string() },
  }, async ({ path }) => { try { return ok(await listComments(project, path)); } catch (e) { return fail(e); } });

  server.registerTool('add_comment', {
    description: 'Add a new comment thread, attached to the end of a paragraph (default: the last paragraph of the document).',
    inputSchema: {
      path: z.string(),
      text: z.string(),
      paragraph_index: z.number().int().nonnegative().optional().describe('Defaults to the last paragraph'),
    },
  }, async ({ path, text, paragraph_index }) => { try { needEdit(); return ok(await addComment(project, agentName, path, text, paragraph_index)); } catch (e) { return fail(e); } });

  server.registerTool('resolve_comment', {
    description: 'Mark a comment thread resolved (index from list_comments, in the same call — the document may have changed since an earlier listing).',
    inputSchema: { path: z.string(), index: z.number().int().nonnegative() },
  }, async ({ path, index }) => { try { needEdit(); return ok(await resolveComment(project, path, index)); } catch (e) { return fail(e); } });

  server.registerTool('build_pdf', {
    description: 'Compile the document to PDF with latexmk and wait for the result (viewers may build, like in the app). Returns ok, the LaTeX warnings, and the tail of the compile log; on timeout the build keeps running — poll build_status. Humans open the PDF in the app.',
    inputSchema: { path: z.string(), wait_seconds: z.number().int().positive().max(600).optional().describe('How long to wait before returning (default 180; the build continues on timeout)') },
  }, async ({ path, wait_seconds }) => { try { return ok(await buildDocument(project, agentName, userId, path, wait_seconds ?? 180)); } catch (e) { return fail(e); } });

  server.registerTool('build_status', {
    description: "The document's build state: whether a build is running, and the last result (status, LaTeX warnings, compile-log tail, whether a PDF exists).",
    inputSchema: { path: z.string() },
  }, async ({ path }) => { try { return ok(buildStatus(project, path)); } catch (e) { return fail(e); } });

  server.registerTool('list_files', {
    description: 'All files of the project (kind: doc/tex/bib/image/pdf/…) — documents open with read_document, other text files with read_file.',
    inputSchema: {},
  }, async () => { try { return ok(listFiles(project)); } catch (e) { return fail(e); } });

  server.registerTool('read_file', {
    description: 'Read a text file of the project (refs.bib, macros.tex, .sty, …). For documents use read_document.',
    inputSchema: { path: z.string() },
  }, async ({ path }) => { try { return ok(readFile(project, path)); } catch (e) { return fail(e); } });

  server.registerTool('write_file', {
    description: 'Write a text file of the project (e.g. add BibTeX entries to refs.bib). Overwrites the file — git history keeps every prior state. For documents use write_document or the paragraph tools.',
    inputSchema: { path: z.string(), text: z.string() },
  }, async ({ path, text }) => { try { needEdit(); return ok(writeFile(project, userId, path, text)); } catch (e) { return fail(e); } });

  server.registerTool('insert_paragraphs', {
    description: 'Insert raw LaTeX (anything: formulas, citations, sections, environments — parsed like the editor parses .tex) as new paragraphs at a position: 0 = top, paragraph count = append. Applied as a tracked insertion, reviewable like any collaborator edit. Indices shift — re-run read_document afterwards.',
    inputSchema: { path: z.string(), index: z.number().int().nonnegative().describe('Position from read_document; the paragraph count appends'), latex: z.string() },
  }, async ({ path, index, latex }) => { try { needEdit(); return ok(await insertParagraphs(project, agentName, path, index, latex)); } catch (e) { return fail(e); } });

  server.registerTool('replace_paragraph', {
    description: 'Replace one paragraph by raw LaTeX (may parse to several paragraphs; formulas, citations, anything allowed). Tracked: plain-text→plain-text becomes a word-level diff; anything else marks the old paragraph deleted and inserts the new content after it.',
    inputSchema: { path: z.string(), index: z.number().int().nonnegative().describe("From read_document's paragraphs list"), latex: z.string() },
  }, async ({ path, index, latex }) => { try { needEdit(); return ok(await replaceParagraph(project, agentName, path, index, latex)); } catch (e) { return fail(e); } });

  server.registerTool('delete_paragraph', {
    description: 'Mark one paragraph deleted as a tracked change (the text disappears when a reviewer accepts it).',
    inputSchema: { path: z.string(), index: z.number().int().nonnegative() },
  }, async ({ path, index }) => { try { needEdit(); return ok(await deleteParagraph(project, agentName, path, index)); } catch (e) { return fail(e); } });

  server.registerTool('write_document', {
    description: "Replace a document's whole raw LaTeX source, or create the document when the path does not exist. NOT a tracked change — like the raw-source view; the prior state stays in Versions and git. Prefer replace_paragraph / insert_paragraphs for reviewable edits.",
    inputSchema: { path: z.string(), tex: z.string() },
  }, async ({ path, tex }) => { try { needEdit(); return ok(await writeDocument(project, userId, path, tex)); } catch (e) { return fail(e); } });

  server.registerTool('create_document', {
    description: 'Create a new .tex document from the standard template (write_document with full source also creates).',
    inputSchema: { path: z.string(), title: z.string().optional() },
  }, async ({ path, title }) => { try { needEdit(); return ok(createDocument(project, userId, agentName, path, title)); } catch (e) { return fail(e); } });

  return server;
}

/** POST /mcp/:project — one stateless request/response per JSON-RPC call (no session, no SSE stream kept open). */
export function mcpRouter(): express.Router {
  const r = express.Router();
  r.use(express.json({ limit: '2mb' }));
  r.post('/:project', (req, res) => { void handle(req, res); });
  return r;
}

async function handle(req: Request, res: Response): Promise<void> {
  let project: string;
  try { project = decodeURIComponent(req.params.project); } catch { res.status(400).json({ error: 'bad project name' }); return; }
  const auth = req.header('authorization') ?? '';
  const m = /^Bearer\s+(\S+)/i.exec(auth);
  if (!m) { res.status(401).json({ error: 'Authorization: Bearer <token> required (create one in File \u25b8 Git repository\u2026)' }); return; }
  const identity = verifyMcpToken(m[1]);
  if (!identity) { res.status(403).json({ error: 'invalid token' }); return; }
  const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(identity.userId) as UserRow | undefined;
  const role = userRow ? roleFor(toSessionUser(userRow), project) : null;
  if (!atLeast(role, 'view')) { res.status(403).json({ error: `this token's account has no access to project "${project}"` }); return; }
  if (!fs.existsSync(projectDir(project))) { res.status(404).json({ error: `no project "${project}"` }); return; }

  const server = buildMcpServer(project, identity.name, atLeast(role, 'edit'), identity.userId);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { void transport.close(); void server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: (e as Error).message ?? String(e) });
  }
}
