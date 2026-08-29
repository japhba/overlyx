/**
 * MCP connector: lets an external agent (any MCP-compatible client) read a project's documents,
 * read/add/resolve comment threads, and propose text edits — all scoped to one project by a
 * per-project bearer token (see mcpTokens.ts). Edits are NEVER applied as a plain overwrite: every
 * `propose_edit` call is turned into change-tracked insertions/deletions (the same `\lyxadded` /
 * `\lyxdeleted` machinery a human editor's Track Changes produces), attributed to the token's name
 * suffixed "(MCP)" — so a misbehaving or over-eager agent is always reviewable and revertible from
 * the Review toolbar / Versions, exactly like a human collaborator's tracked edit.
 *
 * v1 scope, deliberately: `propose_edit` only rewrites a paragraph that is plain, uniformly
 * formatted text (no inline formulas/insets, no mixed bold/italic runs) — anything else is
 * rejected with an explanit error rather than guessing at how to preserve formatting/insets
 * inside a word-level diff. Comments are only read/added/resolved at the top level of the document
 * body (not inside tables/floats/other insets).
 */
import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import fs from 'node:fs';
import {
  plainText, itemText, paragraph, textItem, insetItem, textInset, addAuthor, lyxAuthorId, fontsEqual,
  setHeaderValue, diffText, commentHeader, formatTimestamp, parseHeader, parseThread,
  type LyxDocument, type Item,
} from '@overlyx/core';
import { manager } from './docs.ts';
import { listProjects, projectDir } from './projects.ts';
import { verifyMcpToken } from './mcpTokens.ts';

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

interface CommentEntry { index: number; paragraph_index: number; resolved: boolean; messages: { author: string; time: string; text: string }[] }

function findComments(lyx: LyxDocument): CommentEntry[] {
  const out: CommentEntry[] = [];
  lyx.body.forEach((par, parIdx) => {
    for (const it of par.items) {
      if (it.kind === 'inset' && it.inset.type === 'Text' && it.inset.name === 'Note' && it.inset.arg === 'Comment') {
        const thread = parseThread(it.inset.paragraphs);
        out.push({ index: out.length, paragraph_index: parIdx, resolved: thread.resolved, messages: thread.messages });
      }
    }
  });
  return out;
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
  const entries = findComments(lyx);
  const target = entries[index];
  if (!target) throw new Error(`No comment thread at index ${index} — this document has ${entries.length}.`);
  if (target.resolved) return { ok: true, message: 'Already resolved.' };
  let n = -1;
  for (const par of lyx.body) {
    for (const it of par.items) {
      if (it.kind === 'inset' && it.inset.type === 'Text' && it.inset.name === 'Note' && it.inset.arg === 'Comment') {
        n++;
        if (n !== index) continue;
        const headerPar = it.inset.paragraphs[0];
        const headerText = headerPar.items.map(itemText).join('');
        const h = parseHeader(headerText.trim());
        if (!h) throw new Error('This comment has no structured author/time header (a plain LyX note) — cannot mark it resolved.');
        headerPar.items = [textItem(commentHeader(h.author, h.time, true))];
        commitEdit(doc, lyx);
        return { ok: true };
      }
    }
  }
  throw new Error(`No comment thread at index ${index}.`);
}

/** Builds one MCP server instance scoped to `project`, tools attributed to `agentName`. */
function buildMcpServer(project: string, agentName: string): McpServer {
  const server = new McpServer({ name: 'overlyx', version: '1.0.0' });

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
  }, async ({ path, paragraph_index, new_text }) => { try { return ok(await proposeEdit(project, agentName, path, paragraph_index, new_text)); } catch (e) { return fail(e); } });

  server.registerTool('list_comments', {
    description: 'List comment threads in a document (index, which paragraph they are attached to, messages, resolved state).',
    inputSchema: { path: z.string() },
  }, async ({ path }) => { try { return ok(await listComments(project, path)); } catch (e) { return fail(e); } });

  server.registerTool('add_comment', {
    description: 'Add a new comment thread, attached to the end of a paragraph (default: the last paragraph of the document).',
    inputSchema: {
      path: z.string(),
      text: z.string(),
      paragraph_index: z.number().int().nonnegative().optional().describe('Defaults to the last paragraph'),
    },
  }, async ({ path, text, paragraph_index }) => { try { return ok(await addComment(project, agentName, path, text, paragraph_index)); } catch (e) { return fail(e); } });

  server.registerTool('resolve_comment', {
    description: 'Mark a comment thread resolved (index from list_comments, in the same call — the document may have changed since an earlier listing).',
    inputSchema: { path: z.string(), index: z.number().int().nonnegative() },
  }, async ({ path, index }) => { try { return ok(await resolveComment(project, path, index)); } catch (e) { return fail(e); } });

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
  if (!m) { res.status(401).json({ error: 'Authorization: Bearer <token> required (see Share → MCP tokens)' }); return; }
  const identity = verifyMcpToken(m[1]);
  if (!identity || identity.project !== project) { res.status(403).json({ error: 'invalid token for this project' }); return; }
  if (!fs.existsSync(projectDir(project))) { res.status(404).json({ error: `no project "${project}"` }); return; }

  const server = buildMcpServer(project, identity.name);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { void transport.close(); void server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: (e as Error).message ?? String(e) });
  }
}
