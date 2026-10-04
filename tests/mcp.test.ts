/**
 * The MCP connector (packages/server/src/mcp.ts) end-to-end over real HTTP: JSON-RPC requests
 * against a bare Express app mounting only mcpRouter(), the same way an MCP client would talk to
 * it. Covers auth (per-project bearer token), tools/list, and each tool: read_document,
 * propose_edit (always tracked-change, rejects insets/mixed formatting), list/add/resolve_comment.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { createHash } from 'node:crypto';
import express from 'express';

const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-mcp-test');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'projects', 'owner', 'p'), { recursive: true });
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');

const { mcpRouter } = await import('../packages/server/src/mcp.ts');
const { createMcpToken } = await import('../packages/server/src/mcpTokens.ts');
const { manager } = await import('../packages/server/src/docs.ts');
const { createUser } = await import('../packages/server/src/auth.ts');
const { registerProject } = await import('../packages/server/src/access.ts');
const { db } = await import('../packages/server/src/db.ts');
const { createToken: createPersonalToken, commitProject, ensureRepo } = await import('../packages/server/src/git.ts');

// tokens are account-scoped: the agent gets the account's role in the requested project
const owner = createUser('owner', 'Owner', 'pw');
registerProject('owner/p', owner.id);
const outsider = createUser('mallory', 'Mallory', 'pw');

const file = (name: string) => join(ROOT, 'projects', 'owner', 'p', name);
const doc = (body: string) => `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;

const app = express();
app.use('/mcp', mcpRouter());
const server = http.createServer(app);
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}/mcp/owner/p`;

afterAll(() => { server.close(); rmSync(ROOT, { recursive: true, force: true }); });

let rpcId = 0;
/** The streamable-HTTP transport may answer as plain JSON or as one SSE "message" event; unwrap either. */
function parseBody(raw: string, contentType: string | null): any {
  if (contentType?.includes('text/event-stream')) {
    const line = raw.split('\n').find(l => l.startsWith('data:'));
    return line ? JSON.parse(line.slice(5).trim()) : raw;
  }
  try { return JSON.parse(raw); } catch { return raw; }
}
async function rpcAt(endpoint: string, token: string | null, method: string, params?: unknown): Promise<any> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const raw = await res.text();
  return { status: res.status, body: res.status === 200 ? parseBody(raw, res.headers.get('content-type')) : raw };
}
async function rpc(token: string | null, method: string, params?: unknown): Promise<any> {
  return rpcAt(base, token, method, params);
}

async function callTool(token: string, name: string, args: unknown): Promise<any> {
  const { body } = await rpc(token, 'tools/call', { name, arguments: args });
  const text = body.result.content[0].text;
  if (body.result.isError) throw new Error(text);
  try { return JSON.parse(text); } catch { return text; }
}
async function callToolAt(endpoint: string, token: string, name: string, args: unknown): Promise<any> {
  const { body } = await rpcAt(endpoint, token, 'tools/call', { name, arguments: args });
  const text = body.result.content[0].text;
  if (body.result.isError) throw new Error(text);
  try { return JSON.parse(text); } catch { return text; }
}

beforeAll(() => {
  writeFileSync(file('a.tex'), doc('First paragraph text.\n\nSecond paragraph here.'));
});

describe('auth', () => {
  it('refuses a request with no token', async () => {
    const r = await rpc(null, 'tools/list');
    expect(r.status).toBe(401);
  });

  it('refuses an unknown token with 401 (so OAuth clients re-authorize)', async () => {
    const r = await rpc('olxmcp_bogus', 'tools/list');
    expect(r.status).toBe(401);
  });

  it('accepts a personal Git/CLI token as an MCP bearer token', async () => {
    const token = createPersonalToken(owner.id, 'shared integration').token;
    const r = await rpc(token, 'tools/list');
    expect(r.status).toBe(200);
    expect(r.body.result.tools.map((x: any) => x.name)).toContain('read_document');
  });

  it('refuses a token whose account has no access to the project', async () => {
    const t = createMcpToken(outsider.id, 'agent');
    const r = await rpc(t.token, 'tools/list');
    expect(r.status).toBe(403);
  });

  it('a view-only member reads, but cannot edit or comment', async () => {
    const viewer = createUser('vera', 'Vera', 'pw');
    db.prepare('INSERT INTO project_members (project, user_id, role, via, created_at) VALUES (?,?,?,?,?)').run('owner/p', viewer.id, 'view', 'member', Date.now());
    const t = createMcpToken(viewer.id, 'viewer-agent').token;
    const docs = await callTool(t, 'list_documents', {});
    expect(docs.map((d: { path: string }) => d.path)).toContain('a.tex');
    await expect(callTool(t, 'propose_edit', { path: 'a.tex', paragraph_index: 0, new_text: 'nope' })).rejects.toThrow(/view-only/);
    await expect(callTool(t, 'add_comment', { path: 'a.tex', text: 'hi' })).rejects.toThrow(/view-only/);
  });
});

describe('tools/list', () => {
  it('tells the agent in its instructions to fall back to direct edits on any problem', async () => {
    const t = createMcpToken(owner.id, 'test-agent');
    const { body } = await rpc(t.token, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    const ins: string = body.result.instructions;
    expect(ins).toMatch(/On ANY problem[^.]*tracked: false/);
    expect(ins).toContain('restore_project');
    expect(ins).toContain('\\lyxadded');
  });

  it('lists all the tools', async () => {
    const t = createMcpToken(owner.id, 'test-agent');
    const { status, body } = await rpc(t.token, 'tools/list');
    expect(status).toBe(200);
    const names = body.result.tools.map((x: any) => x.name).sort();
    expect(names).toEqual(['add_comment', 'build_pdf', 'build_status', 'create_document', 'delete_paragraph', 'edit_document', 'edit_file', 'fetch', 'get_presence', 'highlight', 'insert_paragraphs', 'list_comments',
      'list_documents', 'list_files', 'list_projects', 'project_history', 'propose_edit', 'read_document', 'read_file', 'replace_paragraph', 'reply', 'resolve_comment', 'restore_project', 'search',
      'wait_for_instructions', 'write_document', 'write_file']);
  });

  it('creates a project from the account-wide MCP endpoint', async () => {
    const token = createMcpToken(owner.id, 'project-agent').token;
    const allProjects = `http://127.0.0.1:${port}/mcp`;
    const listed = await rpcAt(allProjects, token, 'tools/list');
    expect(listed.body.result.tools.map((x: any) => x.name)).toContain('create_project');
    const created = await callToolAt(allProjects, token, 'create_project', { name: 'MCP import', title: 'Made by an agent' });
    expect(created).toEqual({ project: 'owner/MCP import', title: 'Made by an agent', role: 'owner' });   // in the account's namespace
    expect(existsSync(join(ROOT, 'projects', 'owner', 'MCP import', '.git'))).toBe(true);
    expect(readFileSync(join(ROOT, 'projects', 'owner', 'MCP import', '.git', 'HEAD'), 'utf8')).toContain('refs/heads/main');
    const written = await callToolAt(allProjects, token, 'write_document', { project: 'owner/MCP import', path: 'main.tex', tex: doc('Created through MCP.') });
    expect(written.created).toBe(true);
  });
});

describe('names from before namespaces', () => {
  it('a project\'s old name (an alias, namespaces.ts) still reaches it: /mcp/<name>, `project`, fetch ids', async () => {
    db.prepare('INSERT OR REPLACE INTO project_aliases (alias, name, created_at) VALUES (?, ?, ?)').run('p', 'owner/p', Date.now());
    const t = createMcpToken(owner.id, 'old-agent').token;
    const old = `http://127.0.0.1:${port}/mcp/p`;
    expect((await callToolAt(old, t, 'list_documents', {})).map((d: { path: string }) => d.path)).toContain('a.tex');
    const all = `http://127.0.0.1:${port}/mcp`;
    expect((await callToolAt(all, t, 'list_documents', { project: 'p' })).map((d: { path: string }) => d.path)).toContain('a.tex');
    const projects = await callToolAt(all, t, 'list_projects', {});
    expect(projects.map((x: { project: string }) => x.project)).toContain('owner/p');
    const r = await rpcAt(all, t, 'tools/call', { name: 'fetch', arguments: { id: 'p/a.tex' } });
    const got = r.body.result.structuredContent ?? JSON.parse(r.body.result.content[0].text);
    expect(got.id).toBe('owner/p/a.tex');
    expect(got.url).toMatch(/#\/owner\/p\/a\.tex$/);
    db.prepare('DELETE FROM project_aliases WHERE alias = ?').run('p');
  });
});

describe('read_document / list_documents', () => {
  it('lists the project\'s documents', async () => {
    const t = createMcpToken(owner.id, 'agent').token;
    const docs = await callTool(t, 'list_documents', {});
    expect(docs.map((d: any) => d.path)).toEqual(['a.tex']);
  });

  it('reads paragraphs with stable indices', async () => {
    const t = createMcpToken(owner.id, 'agent').token;
    const r = await callTool(t, 'read_document', { path: 'a.tex' });
    expect(r.paragraphs.map((p: any) => p.text)).toEqual(['First paragraph text.', 'Second paragraph here.']);
    expect(r.text).toContain('First paragraph text.');
  });
});

describe('propose_edit', () => {
  it('applies a tracked change, not a silent overwrite', async () => {
    const t = createMcpToken(owner.id, 'Fixit Bot').token;
    const r = await callTool(t, 'propose_edit', { path: 'a.tex', paragraph_index: 0, new_text: 'First paragraph revised text.' });
    expect(r.changed).toBe(true);
    const openDoc = await manager.open('owner/p/a.tex');
    const text = openDoc.toText();
    expect(text).toContain('\\lyxadded{Fixit Bot (MCP)}');
    expect(text).toContain('revised');
    expect(text).toContain('First paragraph');   // unchanged prefix survives
    // the plain reading (paragraphs as returned by read_document) shows the *proposed* text,
    // since it reflects the live document including the tracked insertion
    const r2 = await callTool(t, 'read_document', { path: 'a.tex' });
    expect(r2.paragraphs[0].text).toContain('revised');
  });

  it('reports no change when new_text equals the current text', async () => {
    const t = createMcpToken(owner.id, 'agent').token;
    const r = await callTool(t, 'read_document', { path: 'a.tex' });
    const r2 = await callTool(t, 'propose_edit', { path: 'a.tex', paragraph_index: 1, new_text: r.paragraphs[1].text });
    expect(r2.changed).toBe(false);
  });

  it('rejects a paragraph containing a formula (not plain text)', async () => {
    writeFileSync(file('b.tex'), doc('Text with $x+y$ inline math.'));
    const t = createMcpToken(owner.id, 'agent').token;
    await expect(callTool(t, 'propose_edit', { path: 'b.tex', paragraph_index: 0, new_text: 'anything' })).rejects.toThrow(/inset/i);
  });

  it('rejects an out-of-range paragraph index', async () => {
    const t = createMcpToken(owner.id, 'agent').token;
    await expect(callTool(t, 'propose_edit', { path: 'a.tex', paragraph_index: 99, new_text: 'x' })).rejects.toThrow(/No paragraph/);
  });
});

describe('comments', () => {
  it('add_comment, list_comments, resolve_comment round-trip', async () => {
    writeFileSync(file('c.tex'), doc('A paragraph to comment on.'));
    const t = createMcpToken(owner.id, 'Reviewer Bot').token;
    const added = await callTool(t, 'add_comment', { path: 'c.tex', text: 'This claim needs a citation.' });
    expect(added.ok).toBe(true);
    const list1 = await callTool(t, 'list_comments', { path: 'c.tex' });
    expect(list1).toHaveLength(1);
    expect(list1[0].resolved).toBe(false);
    expect(list1[0].messages[0].author).toBe('Reviewer Bot (MCP)');
    expect(list1[0].messages[0].text).toBe('This claim needs a citation.');

    const resolved = await callTool(t, 'resolve_comment', { path: 'c.tex', index: 0 });
    expect(resolved.ok).toBe(true);
    const list2 = await callTool(t, 'list_comments', { path: 'c.tex' });
    expect(list2[0].resolved).toBe(true);

    // the raw file LaTeX-escapes brackets inside the comment text (harmless: it's a %% comment,
    // and unescaped again on the next parse — list_comments above already proved that round trip)
    const openDoc = await manager.open('owner/p/c.tex');
    expect(openDoc.toText()).toMatch(/resolved/);
  });

  it('resolve_comment on an out-of-range index fails clearly', async () => {
    const t = createMcpToken(owner.id, 'agent').token;
    await expect(callTool(t, 'resolve_comment', { path: 'c.tex', index: 99 })).rejects.toThrow(/No comment thread/);
  });
});

describe('raw LaTeX', () => {
  it('replace_paragraph accepts formulas and applies a tracked replacement', async () => {
    writeFileSync(file('d.tex'), doc('Plain sentence one.\n\nSecond one.'));
    const t = createMcpToken(owner.id, 'TeX Bot').token;
    const r = await callTool(t, 'replace_paragraph', { path: 'd.tex', index: 0, latex: 'The loss $L=\\sum_i x_i^2$ converges.' });
    expect(r.ok).toBe(true);
    const text = (await manager.open('owner/p/d.tex')).toText();
    expect(text).toContain('\\lyxadded{TeX Bot (MCP)}');
    expect(text).toContain('\\lyxdeleted{TeX Bot (MCP)}');
    expect(text).toContain('x_i^2');
    const read = await callTool(t, 'read_document', { path: 'd.tex' });
    expect(read.text).toContain('converges');
  });

  it('insert_paragraphs inserts a section heading as tracked content', async () => {
    const t = createMcpToken(owner.id, 'TeX Bot').token;
    const before = await callTool(t, 'read_document', { path: 'd.tex' });
    const r = await callTool(t, 'insert_paragraphs', { path: 'd.tex', index: before.paragraphs.length, latex: '\\section{Results}\n\nAll good.' });
    expect(r.inserted).toBe(2);
    const after = await callTool(t, 'read_document', { path: 'd.tex' });
    expect(after.paragraphs.length).toBe(before.paragraphs.length + 2);
    expect(after.paragraphs.at(-2).layout).toBe('Section');
    expect((await manager.open('owner/p/d.tex')).toText()).toContain('Results');
  });

  it('delete_paragraph marks a paragraph deleted (tracked)', async () => {
    const t = createMcpToken(owner.id, 'TeX Bot').token;
    const read = await callTool(t, 'read_document', { path: 'd.tex' });
    const r = await callTool(t, 'delete_paragraph', { path: 'd.tex', index: read.paragraphs.length - 1 });
    expect(r.ok).toBe(true);
    expect((await manager.open('owner/p/d.tex')).toText()).toContain('\\lyxdeleted');
  });

  it('write_document replaces the whole source, and creates a new document', async () => {
    const t = createMcpToken(owner.id, 'TeX Bot').token;
    const r = await callTool(t, 'write_document', { path: 'e.tex', tex: doc('Fresh document with $a=b$.') });
    expect(r.created).toBe(true);
    expect((await callTool(t, 'read_document', { path: 'e.tex' })).text).toContain('a=b');
    const r2 = await callTool(t, 'write_document', { path: 'e.tex', tex: doc('Rewritten entirely.') });
    expect(r2.created).toBe(false);
    expect((await callTool(t, 'read_document', { path: 'e.tex' })).text).toContain('Rewritten');
  });

  it('create_document makes a template document; list_files sees project files', async () => {
    const t = createMcpToken(owner.id, 'TeX Bot').token;
    const r = await callTool(t, 'create_document', { path: 'notes', title: 'Notes' });
    expect(r.path).toBe('notes.tex');
    const docs = await callTool(t, 'list_documents', {});
    expect(docs.map((d: { path: string }) => d.path)).toContain('notes.tex');
    const files = await callTool(t, 'list_files', {});
    expect(files.map((f: { path: string }) => f.path)).toContain('notes.tex');
  });
});

describe('edits are tracked at word / character granularity', () => {
  const CV = String.raw`\section*{Education}

\textbf{PhD in Theoretical Neuroscience}, University College London \hfill 2021--2025\\
Thesis: \emph{Learning dynamics} in recurrent networks. Advisor: \href{https://example.org}{Prof.\ A. Smith}.

\begin{tabular}{ll}
2019--2021 & MSc Physics, \textbf{LMU Munich} \\
2016--2019 & BSc Physics, TU Munich \\
\end{tabular}`;
  const cvDoc = `\\documentclass{article}\n\\usepackage{hyperref}\n\\begin{document}\n${CV}\n\\end{document}\n`;
  const marks = (text: string) => [...text.matchAll(/\\lyx(added|deleted)\{CV Bot \(MCP\)\}\{[^}]*\}\{([^}]*)\}/g)].map(m => `${m[1] === 'added' ? '+' : '-'}${m[2]}`);

  it('edit_document marks only the changed digit of a year in a formatted paragraph', async () => {
    writeFileSync(file('cv.tex'), cvDoc);
    const t = createMcpToken(owner.id, 'CV Bot').token;
    const r = await callTool(t, 'edit_document', { path: 'cv.tex', old_text: '2021--2025', new_text: '2021--2026' });
    expect(r.ok).toBe(true);
    expect(r.inserted_chars).toBe(1);
    expect(r.deleted_chars).toBe(1);
    expect(r.now_reads).toContain('2021--202\\lyxdeleted');
    const text = (await manager.open('owner/p/cv.tex')).toText();
    expect(marks(text)).toEqual(['-5', '+6']);
    expect(text).toContain('\\textbf{PhD in Theoretical Neuroscience}, University College London');
  });

  it('tracked: false applies the edit directly — no marks, others\' tracked changes kept, a commit right before it', async () => {
    await ensureRepo('owner/p');
    writeFileSync(file('plain.tex'), cvDoc);
    const t = createMcpToken(owner.id, 'CV Bot').token;
    await callTool(t, 'edit_document', { path: 'plain.tex', old_text: '2019--2021 & MSc', new_text: '2018--2021 & MSc' });   // a tracked change first
    const r = await callTool(t, 'edit_document', { path: 'plain.tex', old_text: 'Thesis: \\emph{Learning dynamics}', new_text: 'Thesis: \\emph{Learning dynamics and chaos}', tracked: false });
    expect(r.tracked).toBe(false);
    expect(r.now_reads).toContain('\\emph{Learning dynamics and chaos}');
    const text = (await manager.open('owner/p/plain.tex')).toText();
    expect(text).toContain('\\emph{Learning dynamics and chaos}');
    expect(marks(text)).toEqual(['-9', '+8']);              // only the earlier tracked change carries marks
    // the state right before the direct edit is a commit (restore_project can return to it)
    const h = await callTool(t, 'project_history', { limit: 3 });
    expect(h.uncommitted_files).toContain('plain.tex');
    const w = await callTool(t, 'write_document', { path: 'plain.tex', tex: text.replace('TU Munich', 'TU München'), tracked: false });
    expect(w.tracked).toBe(false);
    expect((await manager.open('owner/p/plain.tex')).toText()).toContain('TU München');
    expect(marks((await manager.open('owner/p/plain.tex')).toText())).toEqual(['-9', '+8']);
  });

  it('a follow-up edit may quote the text without the markup, and refines its own change', async () => {
    const t = createMcpToken(owner.id, 'CV Bot').token;
    await callTool(t, 'edit_document', { path: 'cv.tex', old_text: 'London \\hfill{}2021--2026', new_text: 'London \\hfill{}2021--2027' });
    const text = (await manager.open('owner/p/cv.tex')).toText();
    expect(marks(text)).toEqual(['-5', '+7']);
  });

  it('a table cell edit stays in the cell', async () => {
    const t = createMcpToken(owner.id, 'CV Bot').token;
    await callTool(t, 'edit_document', { path: 'cv.tex', old_text: 'BSc Physics, TU Munich', new_text: 'BSc Physics (Hons), TU Munich' });
    const text = (await manager.open('owner/p/cv.tex')).toText();
    expect(marks(text)).toEqual(['-5', '+7', '+ (Hons)']);   // "Physics," → "Physics (Hons),": only the insertion
    expect(text).toContain('\\begin{tabular}{ll}');
  });

  it('replace_paragraph on a formatted paragraph diffs instead of striking the paragraph', async () => {
    const t = createMcpToken(owner.id, 'CV Bot').token;
    const read = await callTool(t, 'read_document', { path: 'cv.tex' });
    const i = read.paragraphs.findIndex((p: any) => p.text.includes('Thesis'));
    const src: string = read.text;
    const par = src.slice(src.indexOf('\\textbf{PhD'), src.indexOf('Smith}.') + 'Smith}.'.length);
    await callTool(t, 'replace_paragraph', { path: 'cv.tex', index: i, latex: par.replace('recurrent', 'spiking') });
    const text = (await manager.open('owner/p/cv.tex')).toText();
    expect(marks(text)).toEqual(['-5', '+7', '-recurrent', '+spiking', '+ (Hons)']);
  });

  it('write_document on an existing document is tracked, not a silent overwrite', async () => {
    const t = createMcpToken(owner.id, 'CV Bot').token;
    const src: string = (await callTool(t, 'read_document', { path: 'cv.tex' })).text;
    const r = await callTool(t, 'write_document', { path: 'cv.tex', tex: src.replace('MSc Physics', 'MSc Theoretical Physics') });
    expect(r.created).toBe(false);
    expect(r.inserted_chars).toBeGreaterThan(0);
    expect(marks((await manager.open('owner/p/cv.tex')).toText())).toContain('+Theoretical ');
  });

  it('explains a failed match: not found (where it diverges), ambiguous, unbalanced braces', async () => {
    const t = createMcpToken(owner.id, 'CV Bot').token;
    await expect(callTool(t, 'edit_document', { path: 'cv.tex', old_text: 'Thesis: \\emph{Learning dynamics} in convolutional networks', new_text: 'x' }))
      .rejects.toThrow(/not found.*first \d+ characters match/s);
    await expect(callTool(t, 'edit_document', { path: 'cv.tex', old_text: 'Physics', new_text: 'Chemistry' })).rejects.toThrow(/occurs \d times/);
    await expect(callTool(t, 'edit_document', { path: 'cv.tex', old_text: 'Advisor:', new_text: 'Advisor: \\textbf{' })).rejects.toThrow(/unbalanced/);
  });
});

describe('edits in flight at the same time', () => {
  it('parallel direct edits of one passage: one applies, the others fail clearly — none is reported done and lost', async () => {
    await ensureRepo('owner/p');
    writeFileSync(file('race.tex'), `\\documentclass{article}\n\\title{Huge Stress Test}\n\\begin{document}\n\\maketitle\nBody text.\n\\end{document}\n`);
    const t = createMcpToken(owner.id, 'Race Bot').token;
    const calls = [1, 2, 3].map(i => callTool(t, 'edit_document', { path: 'race.tex', old_text: 'Huge Stress Test', new_text: `Race Winner ${i}`, tracked: false }));
    const res = await Promise.allSettled(calls);
    const won = res.flatMap((r, i) => (r.status === 'fulfilled' ? [i + 1] : []));
    expect(won).toHaveLength(1);
    for (const r of res) if (r.status === 'rejected') expect(String(r.reason)).toMatch(/not found/);
    const text = (await manager.open('owner/p/race.tex')).toText();
    expect(text).toContain(`\\title{Race Winner ${won[0]}}`);
  });

  it('parallel edits of different passages of one paragraph all arrive, tracked or not', async () => {
    writeFileSync(file('race2.tex'), doc('Alpha beta gamma delta epsilon zeta eta theta.'));
    const t = createMcpToken(owner.id, 'Race Bot').token;
    const res = await Promise.all([
      callTool(t, 'edit_document', { path: 'race2.tex', old_text: 'beta', new_text: 'BETA', tracked: false }),
      callTool(t, 'edit_document', { path: 'race2.tex', old_text: 'delta', new_text: 'DELTA', tracked: false }),
      callTool(t, 'edit_document', { path: 'race2.tex', old_text: 'zeta', new_text: 'ZETA' }),
      callTool(t, 'edit_document', { path: 'race2.tex', old_text: 'theta', new_text: 'THETA', tracked: false }),
    ]);
    expect(res.every(r => r.ok)).toBe(true);
    const text = (await manager.open('owner/p/race2.tex')).toText();
    for (const w of ['BETA', 'DELTA', 'ZETA', 'THETA']) expect(text).toContain(w);
  });

  it('a direct edit applies to the document as it is after its restore point: typing during the commit survives', async () => {
    await ensureRepo('owner/p');
    writeFileSync(file('typing.tex'), doc('Alpha beta gamma.\n\nSecond paragraph.'));
    const t = createMcpToken(owner.id, 'Race Bot').token;
    const live = await manager.open('owner/p/typing.tex');
    // somebody types into the same paragraph while the restore-point commit runs
    const userTypes = (from: string, to: string) => {
      const lyx = live.toLyxDocument();
      const par = lyx.body.find(p => p.items.some(it => it.kind === 'text' && it.text.includes(from)))!;
      for (const it of par.items) if (it.kind === 'text') it.text = it.text.replace(from, to);
      live.loadFromLyx(lyx, 'browser');
    };
    const saveProject = manager.saveProject;
    manager.saveProject = async (project: string) => { manager.saveProject = saveProject; userTypes('gamma.', 'gamma delta.'); return saveProject.call(manager, project); };
    const r = await callTool(t, 'edit_document', { path: 'typing.tex', old_text: 'beta', new_text: 'BETA', tracked: false });
    expect(r.ok).toBe(true);
    expect(live.toText()).toContain('Alpha BETA gamma delta.');
    // … and when the typing changed the very passage, the edit fails instead of overwriting it
    manager.saveProject = async (project: string) => { manager.saveProject = saveProject; userTypes('BETA', 'BETA!'); return saveProject.call(manager, project); };
    await expect(callTool(t, 'edit_document', { path: 'typing.tex', old_text: 'Alpha BETA gamma', new_text: 'Alpha beta gamma', tracked: false })).rejects.toThrow(/not found/);
    manager.saveProject = saveProject;
    expect(live.toText()).toContain('Alpha BETA! gamma delta.');
  });
});

describe('what an edit reports', () => {
  it('create_document puts the account\'s name in \\author, not the token label', async () => {
    const t = createMcpToken(owner.id, 'Account access token').token;
    await callTool(t, 'create_document', { path: 'authored', title: 'A Paper' });
    const text = readFileSync(file('authored.tex'), 'utf8');
    expect(text).toContain('\\author{Owner}');
    expect(text).not.toContain('access token');
  });

  it('a preamble edit is applied directly and said so — not "nothing changed"', async () => {
    writeFileSync(file('pre.tex'), `\\documentclass{article}\n\\usepackage{amssymb}\n\\newcommand{\\R}{\\mathbb{R}}\n\\begin{document}\nA map $f:\\R^n\\to\\R$ here.\n\nAnd $x\\in\\R$ too.\n\\end{document}\n`);
    const t = createMcpToken(owner.id, 'Macro Bot').token;
    const r = await callTool(t, 'edit_document', { path: 'pre.tex', old_text: '\\newcommand{\\R}{\\mathbb{R}}', new_text: '\\newcommand{\\Real}{\\mathbb{R}}' });
    expect(r.note ?? '').not.toMatch(/nothing changed/);
    expect(r.applied_directly.join(' ')).toMatch(/preamble/);
    expect(r.applied_directly.join(' ')).toMatch(/\\R is no longer defined, but 2 formulas still use it/);
    expect(r.now_reads).toContain('\\newcommand{\\Real}{\\mathbb{R}}');
    expect((await manager.open('owner/p/pre.tex')).toText()).toContain('\\newcommand{\\Real}');
  });

  it('a tracked macro rename compiles: the old formulas are removed, not struck out with the gone \\R', async () => {
    const t = createMcpToken(owner.id, 'Macro Bot').token;
    const r1 = await callTool(t, 'edit_document', { path: 'pre.tex', old_text: 'f:\\R^n\\to\\R', new_text: 'f:\\Real^n\\to\\Real' });
    expect(r1.applied_directly.join(' ')).toMatch(/1 old formula removed instead of struck out: it uses \\R/);
    expect(r1.inserted_chars).toBe(1);   // the new formula is a tracked insertion
    const r2 = await callTool(t, 'edit_document', { path: 'pre.tex', old_text: 'x\\in\\R', new_text: 'x\\in\\Real' });
    expect(r2.applied_directly.join(' ')).not.toMatch(/still use/);
    const text = (await manager.open('owner/p/pre.tex')).toText();
    expect(text).not.toMatch(/\\R[^a-zA-Z]/);
    expect(text).toMatch(/\\lyxadded\{Macro Bot \(MCP\)\}\{[^}]*\}\{\$f:\\Real\^n\\to\\Real\$\}/);
    const b = await callTool(t, 'build_pdf', { path: 'pre.tex', wait_seconds: 150 });
    expect(b.errors ?? []).toEqual([]);
    expect(b.ok).toBe(true);
  }, 180_000);

  it('taking back one\'s own pending insertion changes the document and says so', async () => {
    writeFileSync(file('retract.tex'), doc('First sentence. Last sentence.'));
    const t = createMcpToken(owner.id, 'Retract Bot').token;
    const ins = await callTool(t, 'edit_document', { path: 'retract.tex', old_text: 'First sentence.', new_text: 'First sentence. Inserted sentence.' });
    expect(ins.inserted_chars).toBeGreaterThan(0);
    const r = await callTool(t, 'edit_document', { path: 'retract.tex', old_text: 'First sentence. Inserted sentence.', new_text: 'First sentence.' });
    expect(r.note).not.toMatch(/nothing changed/);
    expect((await manager.open('owner/p/retract.tex')).toText()).not.toContain('Inserted');
  });

  it('a request over the size limit gets a JSON-RPC error, not an HTML page', async () => {
    const t = createMcpToken(owner.id, 'Big Bot').token;
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${t}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write_document', arguments: { path: 'big.tex', tex: doc('x'.repeat(2_300_000)) } } }),
    });
    expect(res.status).toBe(413);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error.message).toMatch(/too large.*2MB/);
    const bad = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` }, body: '{"jsonrpc":' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe(-32700);
  });
});

describe('project text files', () => {
  it('write_file / read_file round-trip refs.bib', async () => {
    const t = createMcpToken(owner.id, 'Bib Bot').token;
    const bib = '@article{doe2026, author={Doe, Jane}, title={A Result}, year={2026}}\n';
    const w = await callTool(t, 'write_file', { path: 'refs.bib', text: bib });
    expect(w.ok).toBe(true);
    expect((await callTool(t, 'read_file', { path: 'refs.bib' })).text).toBe(bib);
  });

  it('edit_file replaces a passage of a text file directly, and explains a failed match', async () => {
    const t = createMcpToken(owner.id, 'Bib Bot').token;
    const r = await callTool(t, 'edit_file', { path: 'refs.bib', old_text: 'year={2026}', new_text: 'year={2027}' });
    expect(r.replaced).toBe(1);
    expect(readFileSync(file('refs.bib'), 'utf8')).toContain('year={2027}');
    await expect(callTool(t, 'edit_file', { path: 'refs.bib', old_text: 'year={1999}', new_text: 'x' })).rejects.toThrow(/does not occur/);
    await expect(callTool(t, 'edit_file', { path: 'a.tex', old_text: 'First', new_text: 'x' })).rejects.toThrow(/edit_document|read_document/);
  });

  it('documents are refused (use the document tools)', async () => {
    const t = createMcpToken(owner.id, 'Bib Bot').token;
    await expect(callTool(t, 'read_file', { path: 'a.tex' })).rejects.toThrow(/read_document/);
    await expect(callTool(t, 'write_file', { path: 'a.tex', text: 'x' })).rejects.toThrow(/write_document/);
  });

  it('no tool may reach into .git (a hook or config there would run as the server user)', async () => {
    const t = createMcpToken(owner.id, 'Bib Bot').token;
    // an agent can be steered by injected document content, so these paths must be refused outright
    await expect(callTool(t, 'write_file', { path: '.git/hooks/pre-commit', text: '#!/bin/sh\ntouch /tmp/pwned\n' })).rejects.toThrow(/bad path/);
    await expect(callTool(t, 'write_file', { path: '.git/config', text: '[core]\n' })).rejects.toThrow(/bad path/);
    await expect(callTool(t, 'read_file', { path: '.git/config' })).rejects.toThrow(/bad path/);
    await expect(callTool(t, 'edit_file', { path: 'sub/.git/config', old_text: 'a', new_text: 'b' })).rejects.toThrow(/bad path/);
    await expect(callTool(t, 'write_document', { path: '.git/x.tex', tex: doc('x') })).rejects.toThrow(/bad path/);
    await expect(callTool(t, 'create_document', { path: '.git/hooks/pre-commit' })).rejects.toThrow(/bad path/);
    expect(existsSync(file('.git/hooks/pre-commit'))).toBe(false);
  });

  it('a view-only account cannot use any writing tool', async () => {
    const viewer2 = createUser('viewer2', 'Viewer Two', 'pw');
    db.prepare('INSERT INTO project_members (project, user_id, role, via, created_at) VALUES (?,?,?,?,?)').run('owner/p', viewer2.id, 'view', 'member', Date.now());
    const t = createMcpToken(viewer2.id, 'ro-agent').token;
    await expect(callTool(t, 'write_file', { path: 'refs.bib', text: 'x' })).rejects.toThrow(/view-only/);
    await expect(callTool(t, 'replace_paragraph', { path: 'a.tex', index: 0, latex: 'x' })).rejects.toThrow(/view-only/);
    await expect(callTool(t, 'write_document', { path: 'a.tex', tex: 'x' })).rejects.toThrow(/view-only/);
    await expect(callTool(t, 'edit_document', { path: 'a.tex', old_text: 'First', new_text: 'x' })).rejects.toThrow(/view-only/);
    await expect(callTool(t, 'create_document', { path: 'nope' })).rejects.toThrow(/view-only/);
  });
});

describe('comments inside insets', () => {
  it('list_comments finds threads in floats and tables; resolve works by the same index', async () => {
    writeFileSync(file('f.tex'), doc('Host paragraph.'));
    const core = await import('../packages/core/src/index.ts');
    const t = createMcpToken(owner.id, 'Deep Bot').token;
    const d = await manager.open('owner/p/f.tex');
    const lyx = d.toLyxDocument();
    const mkComment = (text: string) => core.textInset('Note', 'Comment', [
      core.paragraph('Plain Layout', [core.textItem(core.commentHeader('Reviewer (MCP)', core.formatTimestamp()))]),
      core.paragraph('Plain Layout', [core.textItem(text)]),
    ], 'open');
    const float = core.textInset('Float', 'figure', [core.paragraph('Plain Layout', [core.textItem('caption '), core.insetItem(mkComment('inside the float'))])], 'open');
    const table: any = { type: 'Tabular', attrs: [], features: [], columns: [{ attrs: [] }], rows: [{ attrs: [], cells: [{ attrs: [], paragraphs: [core.paragraph('Plain Layout', [core.textItem('cell '), core.insetItem(mkComment('inside the table'))])] }] }] };
    lyx.body[0].items.push(core.insetItem(float), core.insetItem(table));
    d.loadFromLyx(lyx, 'test');
    const list = await callTool(t, 'list_comments', { path: 'f.tex' });
    expect(list).toHaveLength(2);
    expect(list[0].location).toContain('Float');
    expect(list[0].messages[0].text).toBe('inside the float');
    expect(list[1].location).toContain('table');
    const r = await callTool(t, 'resolve_comment', { path: 'f.tex', index: 1 });
    expect(r.ok).toBe(true);
    const list2 = await callTool(t, 'list_comments', { path: 'f.tex' });
    expect(list2[1].resolved).toBe(true);
    expect(list2[0].resolved).toBe(false);
  });
});

describe('build', () => {
  it('build_pdf compiles with latexmk and returns the log; build_status agrees', async () => {
    const t = createMcpToken(owner.id, 'Build Bot').token;
    const r = await callTool(t, 'build_pdf', { path: 'e.tex', wait_seconds: 150 });
    expect(r.ok).toBe(true);
    expect(r.pdf).toBe(true);
    expect(r.log_tail.toLowerCase()).toContain('latexmk');
    const s = await callTool(t, 'build_status', { path: 'e.tex' });
    expect(s.running).toBe(false);
    expect(s.last.status).toBe('ok');
    expect(s.last.pdf).toBe(true);
  }, 180_000);

  it('a build that an edit broke says so: the first errors and a note', async () => {
    const t = createMcpToken(owner.id, 'Build Bot').token;
    await callTool(t, 'edit_document', { path: 'e.tex', old_text: 'Rewritten entirely.', new_text: 'Rewritten \\brokenmacro{} entirely.' });
    const r = await callTool(t, 'build_pdf', { path: 'e.tex', wait_seconds: 150 });
    expect(r.ok).toBe(false);
    expect(r.previous_build).toBe('ok');
    expect(r.errors[0]).toMatch(/Undefined control sequence/);
    expect(r.note).toMatch(/broke it.*project_history \+ restore_project/);
  }, 180_000);

  it('project_history and restore_project step back from an edit that broke the build', async () => {
    const t = createMcpToken(owner.id, 'Build Bot').token;
    await ensureRepo('owner/p');
    writeFileSync(file('r.tex'), doc('Fine text.'));
    await commitProject('owner/p', { message: 'Good state' });
    await callTool(t, 'edit_document', { path: 'r.tex', old_text: 'Fine text.', new_text: 'Fine \\brokenmacro{} text.' });
    await commitProject('owner/p');
    expect(readFileSync(file('r.tex'), 'utf8')).toContain('brokenmacro');
    const h = await callTool(t, 'project_history', { limit: 5 });
    const good = h.commits.find((c: { message: string }) => c.message === 'Good state');
    expect(good).toBeTruthy();
    expect(h.commits[0].message).not.toBe('Good state');
    const r = await callTool(t, 'restore_project', { commit: good.hash.slice(0, 9) });
    expect(r.restored_files).toContain('r.tex');
    expect(readFileSync(file('r.tex'), 'utf8')).not.toContain('brokenmacro');
    expect((await callTool(t, 'read_document', { path: 'r.tex' })).text).not.toContain('brokenmacro');
    // nothing was rewritten: the broken edit is still in the history, above it the restore
    const after = await callTool(t, 'project_history', { limit: 5 });
    expect(after.commits[0].message).toMatch(/^Restore the project to/);
    await expect(callTool(createMcpToken(outsider.id, 'x').token, 'restore_project', { commit: good.hash })).rejects.toThrow();
  });

  it("undo_turn is the Agent panel's: other agents do not see it; with no panel turn it explains", async () => {
    const other = await rpc(createMcpToken(owner.id, 'Build Bot').token, 'tools/list');
    expect(other.body.result.tools.map((x: any) => x.name)).not.toContain('undo_turn');
    const panel = createMcpToken(owner.id, 'Agent panel').token;
    const listed = await rpc(panel, 'tools/list');
    expect(listed.body.result.tools.map((x: any) => x.name)).toContain('undo_turn');
    await expect(callTool(panel, 'undo_turn', {})).rejects.toThrow(/No Agent panel thread has changed this project/);
  });
});

/* ------------------------------------------------------------------ presence, highlights, messages from OverLyX */

const Y = await import('yjs');
const awarenessProtocol = await import('y-protocols/awareness');
const encoding = await import('lib0/encoding');
const { initProseMirrorDoc, absolutePositionToRelativePosition } = await import('y-prosemirror');
const { schema } = await import('@overlyx/core');
const { describeCursor } = await import('../packages/server/src/ycursor.ts');
const { isAgentClient } = await import('../packages/server/src/agentPresence.ts');
const { sendInstruction, cancelInstruction, mcpAgentRoutes, listAgents } = await import('../packages/server/src/mcpAgents.ts');
const { dropLiveSessionsForTests } = await import('../packages/server/src/mcp.ts');
const { toSessionUser, createGuest } = await import('../packages/server/src/auth.ts');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

type OpenDocT = Awaited<ReturnType<typeof manager.open>>;
const sessionUser = (id: number) => toSessionUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id) as never);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const allBase = `http://127.0.0.1:${port}/mcp`;

/** The editor position of `needle` (+ `delta`) in the document, as the browser's ProseMirror counts it. */
function pmPos(d: OpenDocT, needle: string, delta = 0): number {
  const { doc: pm } = initProseMirrorDoc(d.fragment, schema);
  let found = -1;
  pm.descendants((n, pos) => {
    if (found >= 0) return false;
    if (n.isText) { const i = n.text!.indexOf(needle); if (i >= 0) { found = pos + i + delta; return false; } }
    return true;
  });
  if (found < 0) throw new Error('not found: ' + needle);
  return found;
}
/** That position as y-prosemirror's cursor plugin publishes it (a Yjs relative position). */
function relAt(d: OpenDocT, pos: number): unknown {
  const { mapping } = initProseMirrorDoc(d.fragment, schema);
  return Y.relativePositionToJSON(absolutePositionToRelativePosition(pos, d.fragment, mapping));
}
let fakeClientId = 90000;
/** A browser tab of `userId` in the document: a connection as ws.ts registers it, with its awareness state. */
function joinAs(d: OpenDocT, userId: number, name: string, cursor: { anchor: unknown; head: unknown } | null) {
  const conn = { readyState: 1 } as never;
  const id = ++fakeClientId;
  d.conns.set(conn, new Set([id]));
  d.connUsers.set(conn, userId);
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 1); encoding.writeVarUint(enc, id); encoding.writeVarUint(enc, 1);
  encoding.writeVarString(enc, JSON.stringify({ user: { name, color: '#336699' }, ...(cursor ? { cursor } : {}) }));
  awarenessProtocol.applyAwarenessUpdate(d.awareness, encoding.toUint8Array(enc), conn);
  return () => { d.conns.delete(conn); d.connUsers.delete(conn); awarenessProtocol.removeAwarenessStates(d.awareness, [id], null); };
}
/** The awareness states the server shows for agents in the document. */
const agentStates = (d: OpenDocT) => [...d.awareness.getStates().entries()].filter(([, s]) => (s as any)?.user?.agent).map(([id, s]) => ({ id, state: s as any }));
const initialize = (token: string, name: string, endpoint = base) => rpcAt(endpoint, token, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name, version: '1.0' } });
const agentIdOf = (token: string) => {
  const kind = token.startsWith('olxmcp_') ? 'agent' : 'personal';
  const t = db.prepare(`SELECT id FROM ${kind === 'agent' ? 'mcp_tokens' : 'git_tokens'} WHERE token_hash = ?`).get(createHash('sha256').update(token).digest('hex')) as { id: number };
  return (db.prepare('SELECT id FROM mcp_agents WHERE token_kind = ? AND token_id = ? ORDER BY last_seen_at DESC LIMIT 1').get(kind, t.id) as { id: number }).id;
};

const colin = createUser('colin', 'Colin Collab', 'pw');
db.prepare('INSERT INTO project_members (project, user_id, role, via, created_at) VALUES (?,?,?,?,?)').run('owner/p', colin.id, 'edit', 'member', Date.now());

describe('presence: where people are (get_presence)', () => {
  let leave: (() => void)[] = [];
  afterAll(() => leave.forEach(f => f()));

  it("resolves the user's cursor and selection into paragraph, offset, excerpt and the selected text — read_document's terms", async () => {
    writeFileSync(file('pres.tex'), doc('Intro paragraph with some words.\n\nThe second paragraph says $x^2$ and more here.\n\nThird one.'));
    const d = await manager.open('owner/p/pres.tex');
    const from = pmPos(d, 'says'), to = pmPos(d, 'more', 4);
    leave.push(joinAs(d, owner.id, 'Owner', { anchor: relAt(d, from), head: relAt(d, to) }));
    leave.push(joinAs(d, colin.id, 'Colin Collab', { anchor: relAt(d, pmPos(d, 'with')), head: relAt(d, pmPos(d, 'with')) }));
    const t = createMcpToken(owner.id, 'Presence reader').token;
    const r = await callTool(t, 'get_presence', { path: 'pres.tex' });
    expect(r.documents).toHaveLength(1);
    expect(r.documents[0]).toMatchObject({ project: 'owner/p', path: 'pres.tex' });
    const me = r.documents[0].people.find((x: any) => x.you);
    expect(me).toMatchObject({ name: 'Owner', kind: 'person', cursor: { paragraph: 1, layout: 'Standard' }, selection: { from: { paragraph: 1 }, to: { paragraph: 1 }, text: 'says x^2 and more' } });
    expect(me.cursor.excerpt).toBe('The second paragraph says x^2 and more‸ here.');
    // the offsets index read_document's paragraph text
    const pars = (await callTool(t, 'read_document', { path: 'pres.tex' })).paragraphs;
    expect(pars[1].text.slice(me.selection.from.offset, me.selection.to.offset)).toBe('says x^2 and more');
    expect(me.cursor.offset).toBe(me.selection.to.offset);
    const other = r.documents[0].people.find((x: any) => x.name === 'Colin Collab');
    expect(other.you).toBeUndefined();
    expect(other.cursor).toMatchObject({ paragraph: 0, offset: 'Intro paragraph '.length, excerpt: 'Intro paragraph ‸with some words.' });
    expect(other.selection).toBeNull();
    expect(r.legend).toMatch(/you: the user this connection belongs to/);
  });

  it('a selection across paragraphs is quoted with its paragraph break', async () => {
    const d = await manager.open('owner/p/pres.tex');
    const off = joinAs(d, owner.id, 'Owner (tab 2)', { anchor: relAt(d, pmPos(d, 'some')), head: relAt(d, pmPos(d, 'second', 6)) });
    try {
      const r = await callTool(createMcpToken(owner.id, 'p2').token, 'get_presence', { path: 'pres.tex' });
      const tab = r.documents[0].people.find((x: any) => x.name === 'Owner (tab 2)');
      expect(tab.selection).toMatchObject({ from: { paragraph: 0 }, to: { paragraph: 1 }, text: 'some words.\n\nThe second' });
    } finally { off(); }
  });

  it('without a project (all projects): only where the user is; others learn nothing', async () => {
    const mine = await callToolAt(allBase, createMcpToken(owner.id, 'finder').token, 'get_presence', {});
    const doc0 = mine.documents.find((x: any) => x.path === 'pres.tex');
    expect(doc0.people.every((x: any) => x.you)).toBe(true);
    // an outsider: no access to the project — not through the fixed endpoint, not by naming it, not by asking around
    const mal = createMcpToken(outsider.id, 'snoop').token;
    expect((await rpc(mal, 'tools/list')).status).toBe(403);
    await expect(callToolAt(allBase, mal, 'get_presence', { project: 'owner/p' })).rejects.toThrow(/no access/);
    expect((await callToolAt(allBase, mal, 'get_presence', {})).documents).toEqual([]);
  });

  it('a cursor that does not resolve is no cursor (old state, garbage)', async () => {
    const d = await manager.open('owner/p/pres.tex');
    expect(describeCursor(d.ydoc, { anchor: {}, head: {} })).toBeNull();
    expect(describeCursor(d.ydoc, { anchor: { item: { client: 1, clock: 99999 } }, head: { item: { client: 1, clock: 99999 } } })).toBeNull();
    expect(describeCursor(d.ydoc, null)).toBeNull();
  });
});

describe('agents shown to the people in a document', () => {
  it('an agent that reads and edits appears as a collaborator, its caret on what it changed; highlight points at a passage', async () => {
    const t = createMcpToken(owner.id, 'Presence Bot').token;
    await initialize(t, 'codex-mcp-client');
    const d = await manager.open('owner/p/pres.tex');
    await callTool(t, 'read_document', { path: 'pres.tex' });
    let mine = agentStates(d).filter(a => a.state.user.name === 'Codex (Owner)');
    expect(mine).toHaveLength(1);
    expect(mine[0].state.cursor).toBeUndefined();   // reading: present, no caret yet
    expect(isAgentClient(d, mine[0].id)).toBe(true);   // browsers cannot overwrite it (ws.ts)
    await callTool(t, 'edit_document', { path: 'pres.tex', old_text: 'Third one.', new_text: 'Third one, edited.' });
    mine = agentStates(d).filter(a => a.state.user.name === 'Codex (Owner)');
    const at = describeCursor(d.ydoc, mine[0].state.cursor);
    expect(at?.cursor.paragraph).toBe(2);
    expect(at?.selection?.text).toContain('edited');
    // the agent sees itself
    const p = await callTool(t, 'get_presence', { path: 'pres.tex' });
    expect(p.documents[0].people.find((x: any) => x.self)).toMatchObject({ kind: 'agent', name: 'Codex (Owner)' });
    await callTool(t, 'highlight', { path: 'pres.tex', quote: 'SOME   words' });
    const hl = describeCursor(d.ydoc, agentStates(d).find(a => a.state.user.name === 'Codex (Owner)')!.state.cursor);
    expect(hl?.selection).toMatchObject({ from: { paragraph: 0 }, text: 'some words' });
    await callTool(t, 'highlight', { path: 'pres.tex', paragraph_index: 1 });
    const whole = describeCursor(d.ydoc, agentStates(d).find(a => a.state.user.name === 'Codex (Owner)')!.state.cursor);
    expect(whole?.selection?.text).toBe('The second paragraph says x^2 and more here.');
    await expect(callTool(t, 'highlight', { path: 'pres.tex', quote: 'not in this document' })).rejects.toThrow(/not found/);
    await callTool(t, 'highlight', { path: 'pres.tex', clear: true });
    expect(agentStates(d).find(a => a.state.user.name === 'Codex (Owner)')!.state.cursor).toBeUndefined();
  });

  it("the Agent panel's own agent is not shown as a visitor and has no inbox", async () => {
    const panel = createMcpToken(owner.id, 'Agent panel').token;
    const d = await manager.open('owner/p/pres.tex');
    await callTool(panel, 'read_document', { path: 'pres.tex' });
    expect(agentStates(d).some(a => /Agent panel/.test(a.state.user.name))).toBe(false);
    await expect(callTool(panel, 'wait_for_instructions', { timeout_seconds: 1 })).rejects.toThrow(/agents connected from elsewhere/);
  });
});

describe('messages from OverLyX to an agent elsewhere', () => {
  const ownerUser = () => sessionUser(owner.id);

  it('wait_for_instructions returns a message as soon as it is sent, with where the user is; reply answers it', async () => {
    const t = createMcpToken(owner.id, 'Listener').token;
    await initialize(t, 'codex-mcp-client');
    const agentId = agentIdOf(t);
    const t0 = Date.now();
    const waiting = callTool(t, 'wait_for_instructions', { timeout_seconds: 20 });
    await sleep(300);
    expect(listAgents(owner.id).find(a => a.id === agentId)?.status).toBe('listening');
    const sent = await sendInstruction(ownerUser(), agentId, 'Tighten the intro', { docId: 'owner/p/pres.tex', content: [{ type: 'text', text: 'some words' }], layout: 'Standard' });
    const got = await waiting;
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(got.messages).toHaveLength(1);
    expect(got.messages[0]).toMatchObject({ message_id: sent.id, text: 'Tighten the intro' });
    expect(got.messages[0].from).toMatch(/^Owner \(the owner of your token\)/);
    expect(got.messages[0].context).toContain('owner/p/pres.tex');
    expect(got.messages[0].context).toContain('⟦SELECTION⟧some words⟦/SELECTION⟧');
    const r = await callTool(t, 'reply', { message_id: sent.id, text: 'Done: the intro is tighter.' });
    expect(r.answered).toBe(sent.id);
    const rows = db.prepare('SELECT role, state, via, text, reply_to FROM mcp_agent_messages WHERE agent_id = ? ORDER BY id').all(agentId) as any[];
    expect(rows).toEqual([
      { role: 'user', state: 'answered', via: 'poll', text: 'Tighten the intro', reply_to: null },
      { role: 'agent', state: 'final', via: null, text: 'Done: the intro is tighter.', reply_to: sent.id },
    ]);
  });

  it('times out empty, well within a client tool timeout', async () => {
    const t = createMcpToken(owner.id, 'Patient').token;
    await initialize(t, 'codex-mcp-client');
    const t0 = Date.now();
    const got = await callTool(t, 'wait_for_instructions', { timeout_seconds: 1 });
    expect(got.messages).toEqual([]);
    expect(got.note).toMatch(/call wait_for_instructions again/i);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    expect(Date.now() - t0).toBeLessThan(4000);
    // asking for longer than the cap waits the cap at most (50 s) — checked by the schema's clamp, not here
  });

  it('a queued message waits for the next poll; one handed out and then ignored comes again; cancel takes a queued one back', async () => {
    const t = createMcpToken(owner.id, 'Forgetful').token;
    await initialize(t, 'codex-mcp-client');
    const agentId = agentIdOf(t);
    const a = await sendInstruction(ownerUser(), agentId, 'First task', undefined);
    expect((await callTool(t, 'wait_for_instructions', { timeout_seconds: 1 })).messages.map((m: any) => m.message_id)).toEqual([a.id]);
    // no tool call since: the answer was probably lost on the way — handed out again
    expect((await callTool(t, 'wait_for_instructions', { timeout_seconds: 1 })).messages.map((m: any) => m.message_id)).toEqual([a.id]);
    await callTool(t, 'list_documents', {});   // the agent works on it
    expect((await callTool(t, 'wait_for_instructions', { timeout_seconds: 1 })).messages).toEqual([]);
    const b = await sendInstruction(ownerUser(), agentId, 'Never mind this', undefined);
    expect(cancelInstruction(ownerUser(), agentId, b.id).state).toBe('cancelled');
    expect((await callTool(t, 'wait_for_instructions', { timeout_seconds: 1 })).messages).toEqual([]);
    expect(() => cancelInstruction(ownerUser(), agentId, a.id)).toThrow(/already has/);
    // a reply without message_id answers the last message it got
    const r = await callTool(t, 'reply', { text: 'Finished the first task.' });
    expect(r.answered).toBe(a.id);
  });

  it("only the token's own account may write to it: not a collaborator, not a guest, not another site", async () => {
    const t = createMcpToken(owner.id, 'Guarded').token;
    await initialize(t, 'codex-mcp-client');
    const agentId = agentIdOf(t);
    await expect(sendInstruction(sessionUser(colin.id), agentId, 'rm -rf ~', undefined)).rejects.toThrow(/no such agent/);
    const guest = createGuest();
    await expect(sendInstruction(toSessionUser(guest), agentId, 'rm -rf ~', undefined)).rejects.toThrow(/no such agent/);
    // the same over HTTP, through the panel's routes
    const app2 = express();
    app2.use((req, _res, next) => { const id = Number(req.header('x-user')); const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id); if (row) req.user = toSessionUser(row as never); next(); });
    app2.use(express.json());
    app2.use('/api', mcpAgentRoutes());
    const srv2 = http.createServer(app2);
    await new Promise<void>(r => srv2.listen(0, '127.0.0.1', r));
    const api = `http://127.0.0.1:${(srv2.address() as { port: number }).port}/api`;
    const post = (user: number, body: unknown, headers: Record<string, string> = {}) => fetch(`${api}/mcp-agents/${agentId}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-user': String(user), ...headers }, body: JSON.stringify(body) });
    try {
      expect((await post(colin.id, { text: 'hello' })).status).toBe(404);
      expect((await post(guest.id, { text: 'hello' })).status).toBe(404);
      expect((await post(owner.id, { text: 'hello' }, { Origin: 'https://evil.example' })).status).toBe(403);
      expect((await post(owner.id, { text: 'x'.repeat(9000) })).status).toBe(413);
      const ok = await post(owner.id, { text: 'hello', context: { docId: 'owner/p/pres.tex' } });
      expect(ok.status).toBe(200);
      expect((await ok.json()).message).toMatchObject({ role: 'user', state: 'queued', context: { docId: 'owner/p/pres.tex' } });
      // the collaborator's list does not show the owner's agents; the owner's does
      expect((await (await fetch(`${api}/mcp-agents`, { headers: { 'x-user': String(colin.id) } })).json()).agents).toEqual([]);
      const listed = (await (await fetch(`${api}/mcp-agents`, { headers: { 'x-user': String(owner.id) } })).json()).agents;
      expect(listed.find((a: any) => a.id === agentId)).toMatchObject({ name: 'Codex', label: 'Codex (Owner)', token: 'connector credential' });
      expect((await fetch(`${api}/mcp-agents/${agentId}/messages`, { headers: { 'x-user': String(colin.id) } })).status).toBe(404);
      // a context naming a document the sender cannot see is dropped, not read
      const rita = createUser('rita', 'Rita', 'pw');
      const rt = createMcpToken(rita.id, 'Rita bot').token;
      await initialize(rt, 'codex-mcp-client', allBase);
      const ritaAgent = agentIdOf(rt);
      const m = await sendInstruction(sessionUser(rita.id), ritaAgent, 'what does it say?', { docId: 'owner/p/pres.tex', content: [{ type: 'text', text: 'some words' }] });
      expect(m.context).toBeNull();
      // rate limit: 20 a minute
      for (let i = 1; i < 20; i++) await sendInstruction(sessionUser(rita.id), ritaAgent, `msg ${i}`, undefined);
      await expect(sendInstruction(sessionUser(rita.id), ritaAgent, 'one too many', undefined)).rejects.toThrow(/too many/);
    } finally { srv2.close(); }
  });

  it('a view-only account\'s agent listens and replies, and still cannot edit', async () => {
    const vera = db.prepare("SELECT id FROM users WHERE username = 'vera'").get() as { id: number };
    const t = createMcpToken(vera.id, 'Vera bot').token;
    await initialize(t, 'codex-mcp-client');
    const agentId = agentIdOf(t);
    const waiting = callTool(t, 'wait_for_instructions', { timeout_seconds: 10 });
    await sleep(200);
    const m = await sendInstruction(sessionUser(vera.id), agentId, 'Summarize pres.tex', undefined);
    expect((await waiting).messages[0].message_id).toBe(m.id);
    expect((await callTool(t, 'reply', { text: 'It has three paragraphs.' })).answered).toBe(m.id);
    await expect(callTool(t, 'edit_document', { path: 'pres.tex', old_text: 'Third', new_text: 'Fourth' })).rejects.toThrow(/view-only/);
  });

  it('pushes messages into a Claude Code session (channels), counts them delivered once the channel answered, and survives a server restart', async () => {
    const token = createMcpToken(owner.id, 'Claude laptop').token;
    const transport = new StreamableHTTPClientTransport(new URL(allBase), { requestInit: { headers: { Authorization: `Bearer ${token}` } }, reconnectionOptions: { initialReconnectionDelay: 200, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1.5, maxRetries: 5 } });
    const client = new Client({ name: 'claude-code', version: '9.9.9' });
    const pushed: any[] = [];
    client.fallbackNotificationHandler = async (n) => { if (n.method === 'notifications/claude/channel') pushed.push(n.params); };
    await client.connect(transport);
    try {
      expect(transport.sessionId).toBeTruthy();
      expect(client.getServerCapabilities()?.experimental?.['claude/channel']).toEqual({});
      expect(client.getInstructions()).toContain('<channel source="overlyx"');
      const agentId = agentIdOf(token);
      await expect.poll(() => listAgents(owner.id).find(a => a.id === agentId)?.push, { timeout: 5000 }).toBe('possible');
      const m1 = await sendInstruction(sessionUser(owner.id), agentId, 'Pushed hello', { docId: 'owner/p/pres.tex' });
      await expect.poll(() => pushed.length, { timeout: 5000 }).toBe(1);
      expect(pushed[0].content).toMatch(/^Pushed hello\n\n— Added by OverLyX/);
      expect(pushed[0].meta).toMatchObject({ message_id: String(m1.id), from: 'Owner', document: 'owner/p/pres.tex' });
      // not confirmed yet (Claude Code drops channel events silently without the flag): still available to a poll
      expect((db.prepare('SELECT state, pushed_at FROM mcp_agent_messages WHERE id = ?').get(m1.id) as any).state).toBe('queued');
      await client.callTool({ name: 'reply', arguments: { message_id: String(m1.id), text: 'Hi back' } });
      expect(db.prepare('SELECT state, via FROM mcp_agent_messages WHERE id = ?').get(m1.id)).toEqual({ state: 'answered', via: 'push' });
      expect((db.prepare('SELECT channel_ok FROM mcp_sessions WHERE id = ?').get(transport.sessionId) as any).channel_ok).toBe(1);
      expect(listAgents(owner.id).find(a => a.id === agentId)?.push).toBe('confirmed');
      const m2 = await sendInstruction(sessionUser(owner.id), agentId, 'Second push', undefined);
      await expect.poll(() => pushed.length, { timeout: 5000 }).toBe(2);
      expect(db.prepare('SELECT state, via FROM mcp_agent_messages WHERE id = ?').get(m2.id)).toEqual({ state: 'delivered', via: 'push' });
      // a restart: the process forgets its sessions; the client's next request and its event stream bring it back
      await dropLiveSessionsForTests();
      const listed = await client.callTool({ name: 'list_projects', arguments: {} });
      expect(listed.isError).toBeFalsy();
      await expect.poll(() => listAgents(owner.id).find(a => a.id === agentId)?.push, { timeout: 8000 }).toBe('confirmed');
      await sendInstruction(sessionUser(owner.id), agentId, 'After the restart', undefined);
      await expect.poll(() => pushed.length, { timeout: 5000 }).toBe(3);
      expect(pushed[2].content).toBe('After the restart');
      // a session id nobody knows: 404, so the client starts afresh
      const unknown = await fetch(allBase, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}`, 'Mcp-Session-Id': 'not-a-session' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
      expect(unknown.status).toBe(404);
      // somebody else's token cannot use this session
      const stolen = await fetch(allBase, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${createMcpToken(colin.id, 'c').token}`, 'Mcp-Session-Id': transport.sessionId! }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
      expect(stolen.status).toBe(404);
      // without a session there is no event stream
      expect((await fetch(allBase, { headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token}` } })).status).toBe(405);
      const sid = transport.sessionId!;
      await transport.terminateSession();
      expect(db.prepare('SELECT 1 FROM mcp_sessions WHERE id = ?').get(sid)).toBeUndefined();
    } finally {
      await client.close().catch(() => { /* closed */ });
    }
  });
});
