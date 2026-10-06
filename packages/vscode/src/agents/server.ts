/**
 * OverLyX's local tool server (MCP over stdio): Claude Code, Codex or any MCP client on this
 * computer edits the OverLyX documents in its working directory as tracked changes, and comments
 * on them, through the files themselves (localEdit.ts) — no account, no server, no sync. The
 * extension registers it with the agents (host/agents.ts); each agent session starts it:
 * dist/agents.cjs, by way of the stable launcher the extension keeps in its global storage.
 */
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { resolveLayoutDir } from '../host/lyxlib.ts';
import { runTool, toolTarget, type ToolName } from './localEdit.ts';
import { openDocuments } from './openDocuments.ts';

export const LOCAL_SERVER_NAME = 'overlyx-local';

export const LOCAL_INSTRUCTIONS = `OverLyX documents on this computer — .tex files with an OverLyX block in the preamble ("%% OverLyX ---") and their child documents, and any .tex or .md file open in the OverLyX editor in VS Code: edit them with these tools, not with your own file editing (apply_patch, edit/write tools, shell). Your edit then becomes TRACKED CHANGES — insertions and deletions attributed to you, which the user accepts or rejects in the editor (an editor that has the file open shows them at once, also with unsaved edits). Read the files with your own tools; paths are relative to your working directory. Every other file — a README, a plain LaTeX project without OverLyX — you edit as usual; the tools refuse those.

edit_document replaces a passage (old_text → new_text; any LaTeX), write_document writes a whole source or creates a document. Only what actually changes is marked — a word, a digit, a table cell. In the source, pending changes look like \\lyxadded{author}{date}{text} and \\lyxdeleted{author}{date}{text} (in markdown: <ins …>text</ins>, <del …>text</del>); old_text may leave that markup out, and whitespace differences are tolerated. Never write or edit that markup yourself, and leave other people's tracked changes alone. The preamble is never tracked (applied directly, and said so).

Tracked editing must never block you or leave a document broken. On ANY problem with it — an edit that does not match (do not retry a failing tracked edit more than once), markup making a passage hard to address, a result (now_reads) that looks garbled, a build that fails because of your tracked edit, math / tables / environments the tracked form mangles — pass tracked: false: the same edit applied directly, without marks. Do the same when the user asks for direct edits.

Comments: add_comment starts a thread at a passage, reply_to_comment answers a thread (and resolve: true marks it done). In the source a thread is a block of "%% @comment" … "%% @end" lines (in markdown an HTML comment "<!-- @comment … -->") with "Author (date):" headers; change threads only through these tools.

Other files (refs.bib, .sty, macros, figures, code) are not documents: edit them directly with your own tools. Leave the block between "%% OverLyX ---" and "%% end OverLyX ---" alone (regenerated on every save); put preamble additions above it. The tools may rewrite what you wrote into OverLyX's canonical form (spacing, line breaks) — read the file again before editing the same passage.`;

/** Whose changes: the agent's own name, from the client's initialize. */
export function authorFor(client: { name?: string; title?: string } | undefined): string {
  const name = client?.name ?? '';
  if (/^claude[-_ ]?code/i.test(name)) return 'Claude Code';
  if (/codex/i.test(name)) return 'Codex';
  if (/^cursor/i.test(name)) return 'Cursor';
  return (client?.title || name || 'AI agent').slice(0, 60);
}

const ok = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });
const fail = (e: unknown) => ({ content: [{ type: 'text' as const, text: (e as Error)?.message ?? String(e) }], isError: true });

/** What the extension answers a handed-over call (host/agents.ts): the result, the tool's error, or that the document is no longer open there. */
export interface EditorAnswer { result?: unknown; error?: string; gone?: boolean }

/** Hand a call to the VS Code window that has the document open; null when that window cannot be reached (closed meanwhile). */
async function handToEditor(endpoint: string, call: { tool: ToolName; args: Record<string, unknown>; author: string; cwd: string }): Promise<EditorAnswer | null> {
  try {
    const res = await fetch(`${endpoint}/api/agent/tool`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(call), signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return null;
    const answer = await res.json() as EditorAnswer;
    return answer.gone ? null : answer;
  } catch { return null; }
}

export function buildLocalServer(opts: { cwd: string; layoutDir: string; agentsDir?: string }): McpServer {
  const server = new McpServer({ name: LOCAL_SERVER_NAME, version: '1.0.0' }, { instructions: LOCAL_INSTRUCTIONS });
  /**
   * A tool call: handed to the VS Code window that has the document open (the edit then applies to
   * its editor, unsaved typing included), else done on the file.
   */
  const call = (tool: ToolName) => async (args: Record<string, unknown>) => {
    try {
      const author = authorFor(server.server.getClientVersion());
      const open = openDocuments(opts.agentsDir);
      const endpoint = open.get(toolTarget(args, opts.cwd));
      if (endpoint) {
        const answer = await handToEditor(endpoint, { tool, args, author, cwd: opts.cwd });
        if (answer) return answer.error !== undefined ? fail(new Error(answer.error)) : ok(answer.result);
      }
      return ok(await runTool(tool, args, { cwd: opts.cwd, layoutDir: opts.layoutDir, author, isOpen: abs => open.has(abs) }));
    } catch (e) { return fail(e); }
  };
  const pathArg = z.string().describe('The document file: relative to your working directory (e.g. "paper/main.tex"), or absolute');
  const trackedArg = z.boolean().optional().describe('true (default): tracked changes for the user to review. false: applied directly, without marks — the fallback whenever tracked editing runs into any problem (see the instructions)');

  server.registerTool('edit_document', {
    description: "Edit an OverLyX document by replacing a passage of its source — use this instead of apply_patch, your own edit tools or the shell for .tex files with an OverLyX block (\"%% OverLyX ---\" in the preamble), their child documents, and files open in the OverLyX editor; other files you edit as usual (this tool refuses them). old_text must occur exactly once — include enough surrounding text to make it unique, or set replace_all. Any LaTeX is allowed in new_text (formulas, citations, environments, paragraph breaks). Applied as tracked changes attributed to you and diffed against the file, so only what actually changes is marked; the user reviews them in the OverLyX editor. Tracked-change markup (\\lyxadded / \\lyxdeleted) may be left out of old_text; whitespace differences are tolerated. Returns now_reads: the edited lines as the file now reads, for follow-up edits; applied_directly lists what was applied without marks (the preamble is never tracked). With tracked: false the same edit is applied directly — use that as soon as a tracked edit fails, garbles the passage or breaks the build.",
    inputSchema: {
      path: pathArg,
      old_text: z.string().describe('The passage to replace, copied from the file'),
      new_text: z.string().describe('Its replacement (raw LaTeX, or markdown in a .md document)'),
      replace_all: z.boolean().optional().describe('Replace every occurrence (default: old_text must be unique)'),
      tracked: trackedArg,
    },
  }, call('edit_document'));

  server.registerTool('write_document', {
    description: "Write an OverLyX document's whole source, or create the document when the file does not exist. On an existing document the new source is diffed against the file and applied as tracked changes (only what differs is marked) — or, with tracked: false, written directly. For a local change prefer edit_document.",
    inputSchema: { path: pathArg, tex: z.string().describe('The complete source'), tracked: trackedArg },
  }, call('write_document'));

  server.registerTool('add_comment', {
    description: 'Start a comment thread in an OverLyX document, signed with your name — for a question or a suggestion the user should decide on rather than an edit. It sits right after the quoted passage (at), or at the end of the paragraph containing it; without at, at the end of the document.',
    inputSchema: {
      path: pathArg,
      text: z.string().describe('The comment (plain text; new lines start new paragraphs)'),
      at: z.string().optional().describe('A passage of the document text the comment is about, quoted exactly (unique in the document)'),
    },
  }, call('add_comment'));

  server.registerTool('reply_to_comment', {
    description: 'Answer a comment thread of an OverLyX document (e.g. one the user left for you), and/or mark it resolved once it is dealt with. The thread is found by a quote of its text.',
    inputSchema: {
      path: pathArg,
      comment: z.string().describe('A passage of the thread (any of its messages), unique among the threads'),
      text: z.string().optional().describe('Your reply'),
      resolve: z.boolean().optional().describe('Mark the thread resolved'),
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
