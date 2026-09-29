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
    expect(names).toEqual(['add_comment', 'build_pdf', 'build_status', 'create_document', 'delete_paragraph', 'edit_document', 'edit_file', 'fetch', 'insert_paragraphs', 'list_comments',
      'list_documents', 'list_files', 'list_projects', 'project_history', 'propose_edit', 'read_document', 'read_file', 'replace_paragraph', 'resolve_comment', 'restore_project', 'search', 'write_document', 'write_file']);
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
