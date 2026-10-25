/**
 * OverLyX's local tool server (MCP over stdio): Claude Code, Codex or any MCP client on this
 * computer edits LaTeX / markdown documents as tracked changes — when the user asks for that; it
 * edits as usual otherwise — and comments on them, through the files themselves (localEdit.ts) or
 * the VS Code window that has a document open — no account, no server, no sync. The
 * extension registers it with the agents (host/agents.ts); each agent session starts it:
 * dist/agents.cjs, by way of the stable launcher the extension keeps in its global storage.
 */
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { agentAuthorName } from '@overlyx/core/agentname.ts';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { resolveLayoutDir } from '../host/lyxlib.ts';
import { runTool, toolTarget, type ToolName } from './localEdit.ts';
import { openDocuments } from './openDocuments.ts';
import type { EditorAnswer } from './handover.ts';

export const LOCAL_SERVER_NAME = 'overlyx-local';

export const LOCAL_INSTRUCTIONS = `Tracked changes in LaTeX (.tex) and markdown (.md) documents, for the OverLyX editor. Use these tools ONLY when the user asks for it — "with track changes", "as tracked changes", "as suggestions", "so I can review them", or for comments in the document. Otherwise edit files as you normally would, with your own tools; never on your own initiative. When asked, edit the documents with these tools, not with your own file editing (apply_patch, edit/write tools, shell): your edit then becomes TRACKED CHANGES — insertions and deletions attributed to you, which the user accepts or rejects in the OverLyX editor (an editor that has the file open shows them at once, also with unsaved edits; none needs to be open). Read the files with your own tools; paths are relative to your working directory. A document without OverLyX's block in its preamble gets one with the first tracked change (it defines the change marks for LaTeX).

Your changes and comments are signed with your name, your model and whose agent you are, e.g. "Claude (Opus 5.5) [Ada]": pass your model's name (e.g. "Opus 5.5") as model with your first call.

edit_document replaces a passage (old_text → new_text; any LaTeX), write_document writes a whole source or creates a document. Only what actually changes is marked — a word, a digit, a table cell. In the source, pending changes look like \\lyxadded{author}{date}{text} and \\lyxdeleted{author}{date}{text} (in markdown: <ins …>text</ins>, <del …>text</del>); old_text may leave that markup out, and whitespace differences are tolerated. Never write or edit that markup yourself, and leave other people's tracked changes alone. The preamble is never tracked (applied directly, and said so).

Tracked editing must never block you or leave a document broken. On ANY problem with it — an edit that does not match (do not retry a failing tracked edit more than once), markup making a passage hard to address, a result (now_reads) that looks garbled, a build that fails because of your tracked edit, math / tables / environments the tracked form mangles — pass tracked: false: the same edit applied directly, without marks. Do the same when the user asks for direct edits.

Comments: add_comment starts a thread at a passage, reply_to_comment answers a thread (and resolve: true marks it done). In the source a thread is a block of "%% @comment" … "%% @end" lines (in markdown an HTML comment "<!-- @comment … -->") with "Author (date):" headers; change threads only through these tools.

Other files (refs.bib, .sty, macros, figures, code) are not documents: edit them directly with your own tools. Leave the block between "%% OverLyX ---" and "%% end OverLyX ---" alone (regenerated on every save); put preamble additions above it. The tools may rewrite what you wrote into OverLyX's canonical form (spacing, line breaks) — read the file again before editing the same passage.`;

/**
 * Whose changes: the agent (from the client's initialize), the model it said it is (a tool call's
 * `model`) and whose agent it is (`owner`: git's user.name, as the editor signs the user's own
 * changes) — "Claude (Opus 5.5) [Jan]", as OverLyX's server signs them (core agentname.ts).
 */
export function authorFor(client: { name?: string; title?: string } | undefined, model?: string | null, owner?: string | null): string {
  const name = client?.name ?? '';
  const assistant = /^claude/i.test(name) ? 'Claude' : /codex/i.test(name) ? 'Codex' : /^cursor/i.test(name) ? 'Cursor' : /^gemini/i.test(name) ? 'Gemini' : (client?.title || name || 'AI agent').slice(0, 60);
  return agentAuthorName(assistant, model, owner);
}

/** The person the agents on this computer work for: git's user.name where they work, else the account's name. */
function ownerName(cwd: string): string {
  try {
    const name = execFileSync('git', ['config', 'user.name'], { cwd, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (name) return name;
  } catch { /* no git, or no name set */ }
  try { return os.userInfo().username; } catch { return ''; }
}

const ok = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });
const fail = (e: unknown) => ({ content: [{ type: 'text' as const, text: (e as Error)?.message ?? String(e) }], isError: true });

/**
 * Hand a call to the VS Code window that has the document open; null when the file is to be edited
 * here instead: the window cannot be reached (closed meanwhile), or answers `gone` (it would not get
 * to the edit now, agents/handover.ts). A window that took the edit answers within its deadlines;
 * one that holds on past `timeoutMs` may still apply it, so the agent is told rather than the edit
 * done a second time on the file.
 */
export async function handToEditor(endpoint: string, call: { tool: ToolName; args: Record<string, unknown>; author: string; cwd: string },
  timeoutMs = 60_000): Promise<EditorAnswer | null> {
  let res: Response;
  try {
    res = await fetch(`${endpoint}/api/agent/tool`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(call), signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if ((e as Error)?.name !== 'TimeoutError') return null;
    return { error: `The VS Code window that has this document open took the edit but did not finish it within ${Math.round(timeoutMs / 1000)} s; it may still apply once that window responds. Read the file again before editing the same passage.` };
  }
  if (!res.ok) return null;
  const answer = await res.json() as EditorAnswer;
  return answer.gone ? null : answer;
}

export function buildLocalServer(opts: { cwd: string; layoutDir: string; agentsDir?: string }): McpServer {
  const server = new McpServer({ name: LOCAL_SERVER_NAME, version: '1.0.0' }, { instructions: LOCAL_INSTRUCTIONS });
  /** the model the agent last said it is (kept for its later calls: one server per agent session) */
  let model: string | null = null;
  let owner: string | null = null;
  /**
   * A tool call: handed to the VS Code window that has the document open (the edit then applies to
   * its editor, unsaved typing included), else done on the file.
   */
  const call = (tool: ToolName) => async ({ model: said, ...args }: Record<string, unknown>) => {
    try {
      if (typeof said === 'string' && said.trim()) model = said.trim().slice(0, 80);
      owner ??= ownerName(opts.cwd);
      const author = authorFor(server.server.getClientVersion(), model, owner);
      const open = openDocuments(opts.agentsDir);
      const endpoint = open.get(toolTarget(args, opts.cwd));
      if (endpoint) {
        const answer = await handToEditor(endpoint, { tool, args, author, cwd: opts.cwd });
        if (answer) return answer.error !== undefined ? fail(new Error(answer.error)) : ok(answer.result);
      }
      return ok(await runTool(tool, args, { cwd: opts.cwd, layoutDir: opts.layoutDir, author }));
    } catch (e) { return fail(e); }
  };
  const pathArg = z.string().describe('The document file: relative to your working directory (e.g. "paper/main.tex"), or absolute');
  const modelArg = z.string().optional().describe('Your model, by name (e.g. "Opus 5.5", "GPT-5.5"): your tracked changes and comments are signed with it — "Claude (Opus 5.5) [Ada]". Give it at least once; it is kept for your later calls');
  const trackedArg = z.boolean().optional().describe('true (default): tracked changes for the user to review. false: applied directly, without marks — the fallback whenever tracked editing runs into any problem (see the instructions)');

  server.registerTool('edit_document', {
    description: "Edit a LaTeX (.tex) or markdown (.md) document as tracked changes for the OverLyX editor — only when the user asks for tracked changes / suggestions to review (otherwise edit as usual); then use this instead of apply_patch, your own edit tools or the shell. old_text must occur exactly once — include enough surrounding text to make it unique, or set replace_all. Any LaTeX is allowed in new_text (formulas, citations, environments, paragraph breaks). Applied as tracked changes attributed to you and diffed against the file, so only what actually changes is marked; the user reviews them in the OverLyX editor. Tracked-change markup (\\lyxadded / \\lyxdeleted) may be left out of old_text; whitespace differences are tolerated. Returns now_reads: the edited lines as the file now reads, for follow-up edits; applied_directly lists what was applied without marks (the preamble is never tracked). With tracked: false the same edit is applied directly — use that as soon as a tracked edit fails, garbles the passage or breaks the build.",
    inputSchema: {
      path: pathArg,
      old_text: z.string().describe('The passage to replace, copied from the file'),
      new_text: z.string().describe('Its replacement (raw LaTeX, or markdown in a .md document)'),
      replace_all: z.boolean().optional().describe('Replace every occurrence (default: old_text must be unique)'),
      tracked: trackedArg,
      model: modelArg,
    },
  }, call('edit_document'));

  server.registerTool('write_document', {
    description: "Write a document's whole source as tracked changes (only when the user asks for tracked changes), or create the document when the file does not exist. On an existing document the new source is diffed against the file and applied as tracked changes (only what differs is marked) — or, with tracked: false, written directly. For a local change prefer edit_document.",
    inputSchema: { path: pathArg, tex: z.string().describe('The complete source'), tracked: trackedArg, model: modelArg },
  }, call('write_document'));

  server.registerTool('add_comment', {
    description: 'Start a comment thread in a LaTeX or markdown document for the OverLyX editor, signed with your name — when the user asks for comments, or for a question or suggestion they should decide on while you make tracked changes. It sits right after the quoted passage (at), or at the end of the paragraph containing it; without at, at the end of the document.',
    inputSchema: {
      path: pathArg,
      text: z.string().describe('The comment (plain text; new lines start new paragraphs)'),
      at: z.string().optional().describe('A passage of the document text the comment is about, quoted exactly (unique in the document)'),
      model: modelArg,
    },
  }, call('add_comment'));

  server.registerTool('reply_to_comment', {
    description: 'Answer a comment thread of a document (e.g. one the user left for you in OverLyX), and/or mark it resolved once it is dealt with. The thread is found by a quote of its text.',
    inputSchema: {
      path: pathArg,
      comment: z.string().describe('A passage of the thread (any of its messages), unique among the threads'),
      text: z.string().optional().describe('Your reply'),
      resolve: z.boolean().optional().describe('Mark the thread resolved'),
      model: modelArg,
    },
  }, call('reply_to_comment'));

  return server;
}

/** dist/agents.cjs: serve on stdin/stdout until the agent closes them. */
export async function main(): Promise<void> {
  // dist/ lies inside the extension; the LyX files ship in dist/lyxlib (the launcher passes OVERLYX_LAYOUT_DIR for an updated extension)
  const extensionPath = path.resolve(typeof __dirname === 'string' ? __dirname : process.cwd(), '..');
  const layoutDir = resolveLayoutDir(process.env.OVERLYX_LAYOUT_DIR, extensionPath);
  // the launcher's directory (OVERLYX_AGENTS_DIR) also holds the lists of files open in OverLyX editors
  const server = buildLocalServer({ cwd: process.cwd(), layoutDir, agentsDir: process.env.OVERLYX_AGENTS_DIR });
  await server.connect(new StdioServerTransport());
}
