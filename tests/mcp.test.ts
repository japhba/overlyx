/**
 * The MCP connector (packages/server/src/mcp.ts) end-to-end over real HTTP: JSON-RPC requests
 * against a bare Express app mounting only mcpRouter(), the same way an MCP client would talk to
 * it. Covers auth (per-project bearer token), tools/list, and each tool: read_document,
 * propose_edit (always tracked-change, rejects insets/mixed formatting), list/add/resolve_comment.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import express from 'express';

const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-mcp-test');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'projects', 'p'), { recursive: true });
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');

const { mcpRouter } = await import('../packages/server/src/mcp.ts');
const { createMcpToken } = await import('../packages/server/src/mcpTokens.ts');
const { manager } = await import('../packages/server/src/docs.ts');
const { createUser } = await import('../packages/server/src/auth.ts');
const { registerProject } = await import('../packages/server/src/access.ts');
const { db } = await import('../packages/server/src/db.ts');

// tokens are account-scoped: the agent gets the account's role in the requested project
const owner = createUser('owner', 'Owner', 'pw');
registerProject('p', owner.id);
const outsider = createUser('mallory', 'Mallory', 'pw');

const file = (name: string) => join(ROOT, 'projects', 'p', name);
const doc = (body: string) => `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;

const app = express();
app.use('/mcp', mcpRouter());
const server = http.createServer(app);
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}/mcp/p`;

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
async function rpc(token: string | null, method: string, params?: unknown): Promise<any> {
  const res = await fetch(base, {
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

async function callTool(token: string, name: string, args: unknown): Promise<any> {
  const { body } = await rpc(token, 'tools/call', { name, arguments: args });
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

  it('refuses an unknown token', async () => {
    const r = await rpc('olxmcp_bogus', 'tools/list');
    expect(r.status).toBe(403);
  });

  it('refuses a token whose account has no access to the project', async () => {
    const t = createMcpToken(outsider.id, 'agent');
    const r = await rpc(t.token, 'tools/list');
    expect(r.status).toBe(403);
  });

  it('a view-only member reads, but cannot edit or comment', async () => {
    const viewer = createUser('vera', 'Vera', 'pw');
    db.prepare('INSERT INTO project_members (project, user_id, role, via, created_at) VALUES (?,?,?,?,?)').run('p', viewer.id, 'view', 'member', Date.now());
    const t = createMcpToken(viewer.id, 'viewer-agent').token;
    const docs = await callTool(t, 'list_documents', {});
    expect(docs.map((d: { path: string }) => d.path)).toContain('a.tex');
    await expect(callTool(t, 'propose_edit', { path: 'a.tex', paragraph_index: 0, new_text: 'nope' })).rejects.toThrow(/view-only/);
    await expect(callTool(t, 'add_comment', { path: 'a.tex', text: 'hi' })).rejects.toThrow(/view-only/);
  });
});

describe('tools/list', () => {
  it('lists all the tools', async () => {
    const t = createMcpToken(owner.id, 'test-agent');
    const { status, body } = await rpc(t.token, 'tools/list');
    expect(status).toBe(200);
    const names = body.result.tools.map((x: any) => x.name).sort();
    expect(names).toEqual(['add_comment', 'create_document', 'delete_paragraph', 'insert_paragraphs', 'list_comments', 'list_documents',
      'list_files', 'propose_edit', 'read_document', 'read_file', 'replace_paragraph', 'resolve_comment', 'write_document', 'write_file']);
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
    const openDoc = await manager.open('p/a.tex');
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
    const openDoc = await manager.open('p/c.tex');
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
    const text = (await manager.open('p/d.tex')).toText();
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
    expect((await manager.open('p/d.tex')).toText()).toContain('Results');
  });

  it('delete_paragraph marks a paragraph deleted (tracked)', async () => {
    const t = createMcpToken(owner.id, 'TeX Bot').token;
    const read = await callTool(t, 'read_document', { path: 'd.tex' });
    const r = await callTool(t, 'delete_paragraph', { path: 'd.tex', index: read.paragraphs.length - 1 });
    expect(r.ok).toBe(true);
    expect((await manager.open('p/d.tex')).toText()).toContain('\\lyxdeleted');
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

describe('project text files', () => {
  it('write_file / read_file round-trip refs.bib', async () => {
    const t = createMcpToken(owner.id, 'Bib Bot').token;
    const bib = '@article{doe2026, author={Doe, Jane}, title={A Result}, year={2026}}\n';
    const w = await callTool(t, 'write_file', { path: 'refs.bib', text: bib });
    expect(w.ok).toBe(true);
    expect((await callTool(t, 'read_file', { path: 'refs.bib' })).text).toBe(bib);
  });

  it('documents are refused (use the document tools)', async () => {
    const t = createMcpToken(owner.id, 'Bib Bot').token;
    await expect(callTool(t, 'read_file', { path: 'a.tex' })).rejects.toThrow(/read_document/);
    await expect(callTool(t, 'write_file', { path: 'a.tex', text: 'x' })).rejects.toThrow(/write_document/);
  });

  it('a view-only account cannot use any writing tool', async () => {
    const viewer2 = createUser('viewer2', 'Viewer Two', 'pw');
    db.prepare('INSERT INTO project_members (project, user_id, role, via, created_at) VALUES (?,?,?,?,?)').run('p', viewer2.id, 'view', 'member', Date.now());
    const t = createMcpToken(viewer2.id, 'ro-agent').token;
    await expect(callTool(t, 'write_file', { path: 'refs.bib', text: 'x' })).rejects.toThrow(/view-only/);
    await expect(callTool(t, 'replace_paragraph', { path: 'a.tex', index: 0, latex: 'x' })).rejects.toThrow(/view-only/);
    await expect(callTool(t, 'write_document', { path: 'a.tex', tex: 'x' })).rejects.toThrow(/view-only/);
    await expect(callTool(t, 'create_document', { path: 'nope' })).rejects.toThrow(/view-only/);
  });
});
