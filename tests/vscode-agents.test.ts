/**
 * The VS Code extension's local tools for AI agents on the user's computer (packages/vscode/src/
 * agents): edits of document files as tracked changes, comments, the stdio MCP server agents start,
 * and the registration with Claude Code / Codex — against scratch directories and fake `claude` /
 * `codex` executables (the real ones and their configs are never touched).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseTex } from '../packages/core/src/tex/parse.ts';
import { parseThread, type Paragraph } from '@overlyx/core';
import { LYX_LAYOUTS } from './lyxlib.ts';

// per process: another run of the suite (a parallel session) must not wipe this one's projects
const ROOT = path.join(process.env.OVERLYX_SCRATCH ?? os.tmpdir(), `overlyx-vscode-agents-test-${process.pid}`);
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));
// the agents' configs, for everything below: never the real ones
process.env.CLAUDE_CONFIG_DIR = path.join(ROOT, 'claude-home');
process.env.CODEX_HOME = path.join(ROOT, 'codex-home');

const { editDocument, writeDocument, addComment, replyToComment } = await import('../packages/vscode/src/agents/localEdit.ts');
const reg = await import('../packages/vscode/src/agents/register.ts');
const { authorFor } = await import('../packages/vscode/src/agents/server.ts');
const { publishOpenDocuments, openDocuments } = await import('../packages/vscode/src/agents/openDocuments.ts');

const here = path.dirname(fileURLToPath(import.meta.url));
const lc = (cwd: string, author = 'Claude Code') => ({ cwd, layoutDir: LYX_LAYOUTS, author });

const PAPER = `\\documentclass{article}
\\usepackage{amsmath,amssymb}
\\newcommand{\\E}{\\mathbb{E}}
\\begin{document}
\\section{Intro}

The quick brown fox jumps over the lazy dog. We compute $\\E[x]$ here.

Another paragraph   with odd   spacing that nobody touches.
\\end{document}
`;

let n = 0;
/** a fresh project directory with `files` */
function project(files: Record<string, string | Buffer>): string {
  const dir = path.join(ROOT, `p${++n}`);
  for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); }
  return dir;
}
const read = (dir: string, rel = 'main.tex') => fs.readFileSync(path.join(dir, rel), 'utf8');

/** the comment threads of a .tex document, as parsed back from the file */
function threads(text: string): ReturnType<typeof parseThread>[] {
  const out: ReturnType<typeof parseThread>[] = [];
  const visit = (pars: Paragraph[]) => { for (const p of pars) for (const it of p.items) if (it.kind === 'inset' && it.inset.type === 'Text') { if (it.inset.name === 'Note' && it.inset.arg === 'Comment') out.push(parseThread(it.inset.paragraphs)); else visit(it.inset.paragraphs); } };
  visit(parseTex(text, { layoutDir: LYX_LAYOUTS }).doc.body);
  return out;
}

describe('local tools: document files edited as tracked changes', () => {
  it('marks only what changed, attributed to the agent; untouched paragraphs keep their bytes', async () => {
    const dir = project({ 'main.tex': PAPER });
    const r = await editDocument('main.tex', { old_text: 'quick brown fox', new_text: 'quick red fox' }, lc(dir));
    expect(r).toMatchObject({ ok: true, inserted_chars: 3, deleted_chars: 5 });
    const text = read(dir);
    expect(text).toMatch(/\\lyxdeleted\{Claude Code\}\{[^}]+\}\{brown\}\\lyxadded\{Claude Code\}\{[^}]+\}\{red\} fox jumps/);
    expect(text).toContain('Another paragraph   with odd   spacing that nobody touches.');
    expect(text).toContain('\\DeclareRobustCommand{\\lyxadded}');   // the markup's definitions, in the OverLyX block
    expect(r.now_reads).toContain('\\lyxadded{Claude Code}');
    // a follow-up edit may quote the passage without the markup
    const again = await editDocument('main.tex', { old_text: 'quick red fox jumps', new_text: 'quick red fox leaps' }, lc(dir, 'Codex'));
    expect(again.ok).toBe(true);
    expect(read(dir)).toMatch(/\\lyxadded\{Codex\}\{[^}]+\}\{leaps\}/);
  });

  it('tracked: false applies the edit directly; mismatches and ambiguities are explained', async () => {
    const dir = project({ 'main.tex': PAPER });
    const r = await editDocument('main.tex', { old_text: 'lazy dog', new_text: 'sleepy dog', tracked: false }, lc(dir));
    expect(r).toMatchObject({ ok: true, tracked: false });
    expect(read(dir)).toContain('over the sleepy dog.');
    expect(read(dir)).not.toContain('\\lyxadded');
    await expect(editDocument('main.tex', { old_text: 'purple fox', new_text: 'x' }, lc(dir))).rejects.toThrow();
    await expect(editDocument('main.tex', { old_text: 'paragraph', new_text: 'para' }, lc(dir))).resolves.toMatchObject({ ok: true });
    await expect(editDocument('main.tex', { old_text: 'e', new_text: 'E' }, lc(dir))).rejects.toThrow(/occurs \d+ times/);
    await expect(editDocument('notes.txt', { old_text: 'a', new_text: 'b' }, lc(dir))).rejects.toThrow(/\.tex or \.md document/);
    await expect(editDocument('missing.tex', { old_text: 'a', new_text: 'b' }, lc(dir))).rejects.toThrow(/does not exist/);
  });

  it('write_document creates a document, and diffs a new source against an existing one', async () => {
    const dir = project({ 'main.tex': PAPER });
    const created = await writeDocument('sub/new.tex', { tex: PAPER.replace('Intro', 'Fresh') }, lc(dir));
    expect(created).toMatchObject({ ok: true, created: true });
    expect(read(dir, 'sub/new.tex')).toBe(PAPER.replace('Intro', 'Fresh'));
    const r = await writeDocument(path.join(dir, 'main.tex'), { tex: PAPER.replace('We compute', 'We estimate') }, lc('/'));
    expect(r).toMatchObject({ ok: true, created: false, inserted_chars: 8, deleted_chars: 7 });
    expect(read(dir)).toMatch(/\\lyxdeleted\{Claude Code\}\{[^}]+\}\{compute\}\\lyxadded\{Claude Code\}\{[^}]+\}\{estimate\}/);
  });

  it('a child document is edited in its master\'s context; markdown documents get <ins> / <del>', async () => {
    const dir = project({
      'main.tex': PAPER.replace('Another paragraph', '\\input{chapter}\n\nAnother paragraph'),
      'chapter.tex': '\\section{Chapter}\n\nChild text with a typo: teh end.\n',
      'notes.md': '# Notes\n\nThe quick brown fox jumps.\n\nSecond   paragraph stays.\n',
    });
    await editDocument('chapter.tex', { old_text: 'teh end', new_text: 'the end' }, lc(dir));
    expect(read(dir, 'chapter.tex')).toMatch(/\\lyxdeleted\{Claude Code\}\{[^}]+\}\{teh\}\\lyxadded\{Claude Code\}\{[^}]+\}\{the\} end/);
    expect(read(dir, 'chapter.tex')).not.toContain('\\documentclass');
    await editDocument('notes.md', { old_text: 'brown fox', new_text: 'red fox' }, lc(dir));
    const md = read(dir, 'notes.md');
    expect(md).toMatch(/<del author="Claude Code" datetime="[^"]+">brown<\/del><ins author="Claude Code" datetime="[^"]+">red<\/ins> fox/);
    expect(md).toContain('Second   paragraph stays.');
  });

  it('the windows\' lists of open documents: written per process, read while that process lives', () => {
    const agents = path.join(ROOT, 'agents-open');
    publishOpenDocuments(agents, ['/a/main.tex', '/b/notes.md'], 'http://127.0.0.1:1/t/x');
    publishOpenDocuments(agents, ['/c/gone.tex'], 'http://127.0.0.1:2/t/y', 2 ** 22 + 12345);   // a window that is no more
    expect([...openDocuments(agents)].sort()).toEqual([['/a/main.tex', 'http://127.0.0.1:1/t/x'], ['/b/notes.md', 'http://127.0.0.1:1/t/x']]);
    expect((fs.statSync(path.join(agents, 'open', `${process.pid}.json`)).mode & 0o777).toString(8)).toBe('600');   // the endpoint carries the bridge's token
    publishOpenDocuments(agents, []);
    expect(openDocuments(agents).size).toBe(0);
    expect(openDocuments(undefined).size).toBe(0);
  });

  it('any .tex / .md document — the user asked for tracked changes: no OverLyX block, project or open editor needed', async () => {
    const dir = project({ '.git/HEAD': 'ref: refs/heads/main\n', 'paper.tex': PAPER, 'README.md': '# Readme\n\nSome text.\n' });
    await editDocument('paper.tex', { old_text: 'lazy', new_text: 'sleepy' }, lc(dir));
    expect(read(dir, 'paper.tex')).toMatch(/%% OverLyX -+\n[\s\S]*\\DeclareRobustCommand\{\\lyxadded\}[\s\S]*\\lyxadded\{Claude Code\}\{[^}]+\}\{sleepy\}/);   // the block arrives with the first change
    await editDocument('README.md', { old_text: 'Some text', new_text: 'Some prose' }, lc(dir));
    expect(read(dir, 'README.md')).toMatch(/Some <del author="Claude Code" datetime="[^"]+">text\.<\/del><ins author="Claude Code" datetime="[^"]+">prose\.<\/ins>/);
  });

  it('refuses a file that is not UTF-8 instead of rewriting its bytes', async () => {
    const dir = project({ 'main.tex': Buffer.from(PAPER.replace('quick', 'qu\xe9ck'), 'latin1') });
    await expect(editDocument('main.tex', { old_text: 'lazy', new_text: 'sleepy' }, lc(dir))).rejects.toThrow(/not UTF-8/);
  });

  it('parallel edits of one file all land (one after the other)', async () => {
    const dir = project({ 'main.tex': PAPER });
    const rs = await Promise.all([
      editDocument('main.tex', { old_text: 'quick', new_text: 'fast' }, lc(dir)),
      editDocument('main.tex', { old_text: 'lazy', new_text: 'sleepy' }, lc(dir)),
      editDocument('main.tex', { old_text: 'nobody touches', new_text: 'nobody ever touches' }, lc(dir)),
    ]);
    expect(rs.every(r => r.ok)).toBe(true);
    const text = read(dir);
    for (const w of ['fast', 'sleepy', 'ever ']) expect(text).toMatch(new RegExp(`\\\\lyxadded\\{Claude Code\\}\\{[^}]+\\}\\{${w}\\}`));
  });
});

describe('local tools: comments', () => {
  it('a thread at a quoted passage, a reply, resolved — parsed back from the file', async () => {
    const dir = project({ 'main.tex': PAPER });
    await addComment('main.tex', { text: 'Is the dog really lazy?', at: 'the lazy dog' }, lc(dir));
    expect(read(dir)).toMatch(/the lazy dog%\n%% @comment\n%% Claude Code \(\d{4}-\d\d-\d\d \d\d:\d\d\):\n%%\n%% Is the dog really lazy\?\n%% @end\n\. We compute/);
    await addComment('main.tex', { text: 'A closing remark.' }, lc(dir, 'Codex'));
    let ts = threads(read(dir));
    expect(ts.map(t => t.messages[0].author)).toEqual(['Claude Code', 'Codex']);
    const r = await replyToComment('main.tex', { comment: 'really lazy', text: 'Yes, it is.', resolve: true }, lc(dir, 'Codex'));
    expect(r).toMatchObject({ ok: true, replied: true, resolved: true });
    ts = threads(read(dir));
    expect(ts[0].resolved).toBe(true);
    expect(ts[0].messages.map(m => [m.author, m.text])).toEqual([['Claude Code', 'Is the dog really lazy?'], ['Codex', 'Yes, it is.']]);
    expect(ts[1].resolved).toBe(false);
  });

  it('explains a passage or thread it cannot find, or finds twice', async () => {
    const dir = project({ 'main.tex': PAPER });
    await expect(addComment('main.tex', { text: 'x', at: 'purple fox' }, lc(dir))).rejects.toThrow(/not found/);
    await addComment('main.tex', { text: 'First thought about the fox.', at: 'brown fox' }, lc(dir));
    await addComment('main.tex', { text: 'Second thought about the fox.', at: 'odd   spacing' }, lc(dir));
    await expect(replyToComment('main.tex', { comment: 'about the fox', text: 'x' }, lc(dir))).rejects.toThrow(/2 comment threads/);
    await expect(replyToComment('main.tex', { comment: 'unicorn', text: 'x' }, lc(dir))).rejects.toThrow(/threads begin: "First thought/);
    await expect(replyToComment('main.tex', { comment: 'Second thought' }, lc(dir))).rejects.toThrow(/nothing to do/);
  });
});

describe('local tools: the MCP server agents start (stdio)', () => {
  const ENTRY = path.join(here, '../packages/vscode/src/agents/entry.ts');
  // the server runs in the project directory, where `--import tsx` would not resolve
  const TSX = pathToFileURL(path.join(here, '../node_modules/tsx/dist/loader.mjs')).href;

  async function session(cwd: string, clientName: string, calls: { name: string; arguments: object }[]): Promise<any[]> {
    const child = spawn(process.execPath, ['--import', TSX, ENTRY], { cwd, env: { ...process.env, OVERLYX_LAYOUT_DIR: LYX_LAYOUTS, OVERLYX_AGENTS_DIR: path.join(cwd, '.agents') }, stdio: ['pipe', 'pipe', 'pipe'] });
    const answers = new Map<number, any>();
    let buf = '', err = '';
    child.stderr.on('data', d => { err += d; });
    const waiters = new Map<number, (m: any) => void>();
    child.stdout.on('data', d => {
      buf += d;
      for (let i; (i = buf.indexOf('\n')) >= 0;) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); answers.set(m.id, m); waiters.get(m.id)?.(m); }
    });
    let id = 0;
    const rpc = (method: string, params: object) => new Promise<any>((resolve, reject) => {
      const k = ++id;
      const t = setTimeout(() => reject(new Error(`no answer to ${method}: ${err}`)), 30000);
      waiters.set(k, m => { clearTimeout(t); resolve(m); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: k, method, params }) + '\n');
    });
    const out: any[] = [await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: clientName, version: '1' } })];
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    out.push(await rpc('tools/list', {}));
    for (const c of calls) out.push(await rpc('tools/call', c));
    child.stdin.end();
    await new Promise(r => child.on('exit', r));
    return out;
  }

  it('tells the agent how to edit, lists its tools, edits as the client it is', async () => {
    const dir = project({ 'paper/main.tex': PAPER });
    // open in an OverLyX editor of this (living) process — the file has no OverLyX block
    publishOpenDocuments(path.join(dir, '.agents'), [path.join(dir, 'paper/main.tex')]);
    const [init, list, edit, bad] = await session(dir, 'codex-mcp-client', [
      { name: 'edit_document', arguments: { path: 'paper/main.tex', old_text: 'brown', new_text: 'red' } },
      { name: 'edit_document', arguments: { path: 'paper/main.tex', old_text: 'unicorn', new_text: 'x' } },
    ]);
    expect(init.result.serverInfo.name).toBe('overlyx-local');
    expect(init.result.instructions).toMatch(/TRACKED CHANGES/);
    // only when the user asks for it — the instructions (Claude Code) and the descriptions (Codex) both say so
    expect(init.result.instructions).toMatch(/^Tracked changes in LaTeX \(\.tex\) and markdown \(\.md\) documents, for the OverLyX editor\. Use these tools ONLY when the user asks for it/);
    expect(list.result.tools.find((t: { name: string }) => t.name === 'edit_document').description).toMatch(/only when the user asks for tracked changes/);
    expect(list.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(['add_comment', 'edit_document', 'reply_to_comment', 'write_document']);
    if (edit.result.isError) throw new Error(edit.result.content[0].text);
    expect(JSON.parse(edit.result.content[0].text)).toMatchObject({ ok: true, inserted_chars: 3, deleted_chars: 5 });
    expect(read(dir, 'paper/main.tex')).toMatch(/\\lyxadded\{Codex\}\{[^}]+\}\{red\}/);
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0].text).toMatch(/old_text/);
  }, 60000);

  it('hands a call for a document open in a VS Code window to that window; falls back to the file once it is gone', async () => {
    const dir = project({ 'main.tex': PAPER });
    const calls: any[] = [];
    let open = true;
    const http = await import('node:http');
    const bridge = http.createServer((req, res) => {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        if (req.url !== '/t/tok/api/agent/tool') { res.statusCode = 404; res.end(); return; }
        calls.push(JSON.parse(body));
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(open ? { result: { ok: true, via: 'editor' } } : { gone: true }));
      });
    });
    await new Promise<void>(r => bridge.listen(0, '127.0.0.1', r));
    const endpoint = `http://127.0.0.1:${(bridge.address() as { port: number }).port}/t/tok`;
    publishOpenDocuments(path.join(dir, '.agents'), [path.join(dir, 'main.tex')], endpoint);
    try {
      const [, , handed] = await session(dir, 'claude-code', [{ name: 'edit_document', arguments: { path: 'main.tex', old_text: 'lazy', new_text: 'sleepy' } }]);
      expect(JSON.parse(handed.result.content[0].text)).toEqual({ ok: true, via: 'editor' });
      expect(calls).toEqual([{ tool: 'edit_document', args: { path: 'main.tex', old_text: 'lazy', new_text: 'sleepy' }, author: 'Claude Code', cwd: dir }]);
      expect(read(dir)).toBe(PAPER);   // the window edits it, not the tool server
      open = false;   // closed meanwhile: the file itself
      const [, , direct] = await session(dir, 'claude-code', [{ name: 'edit_document', arguments: { path: 'main.tex', old_text: 'lazy', new_text: 'sleepy' } }]);
      expect(JSON.parse(direct.result.content[0].text)).toMatchObject({ ok: true, inserted_chars: 6 });
      expect(read(dir)).toMatch(/\\lyxadded\{Claude Code\}\{[^}]+\}\{sleepy\}/);
    } finally { bridge.close(); }
  }, 60000);

  it('names the author after the agent', () => {
    expect(authorFor({ name: 'claude-code', version: '2.1' } as never)).toBe('Claude Code');
    expect(authorFor({ name: 'codex-mcp-client' })).toBe('Codex');
    expect(authorFor({ name: 'my-agent', title: 'My Agent' })).toBe('My Agent');
    expect(authorFor(undefined)).toBe('AI agent');
  });
});

describe('registering with Claude Code and Codex', () => {
  const FAKE = path.join(ROOT, 'fake-agents');
  const LOG = path.join(FAKE, 'claude.log');
  const STATE = path.join(process.env.CLAUDE_CONFIG_DIR!, '.claude.json');
  const cmd = { command: '/usr/share/code/code', args: ['/home/u/.config/Code/User/globalStorage/overlyx.overlyx-vscode/agents/overlyx-local.cjs'], env: { ELECTRON_RUN_AS_NODE: '1' } };
  let savedPath: string | undefined;

  beforeAll(() => {
    fs.mkdirSync(FAKE, { recursive: true });
    // a stand-in `claude`: logs its arguments; `mcp add-json` stores the server where Claude Code keeps it
    fs.writeFileSync(path.join(FAKE, 'claude'), `#!/usr/bin/env node
const fs = require('fs'); const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify(a) + '\\n');
if (a[0] === 'mcp' && a[1] === 'add-json') { let s = {}; try { s = JSON.parse(fs.readFileSync(${JSON.stringify(STATE)}, 'utf8')); } catch {} s.mcpServers = { ...s.mcpServers, [a[4]]: JSON.parse(a[5]) }; fs.mkdirSync(require('path').dirname(${JSON.stringify(STATE)}), { recursive: true }); fs.writeFileSync(${JSON.stringify(STATE)}, JSON.stringify(s)); }
if (a[0] === 'mcp' && a[1] === 'remove') process.exit(1);
`, { mode: 0o755 });
    fs.writeFileSync(path.join(FAKE, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    savedPath = process.env.PATH;
  });
  beforeEach(() => { process.env.PATH = `${FAKE}:${savedPath}`; });

  it('finds the agents on PATH', async () => {
    expect(await reg.detectAgents()).toEqual({ claude: true, codex: true });
    process.env.PATH = '/nonexistent';
    expect((await reg.detectAgents()).claude).toBe(false);
  });

  it('Claude Code: user scope via add-json, recognised as current, tools allowed once', async () => {
    fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR!, { recursive: true });
    fs.writeFileSync(reg.claudeSettingsFile(), JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(ls:*)'] } }));
    fs.rmSync(LOG, { force: true });
    expect(reg.claudeRegistered()).toBe(false);
    await reg.registerClaude(cmd);
    const calls = fs.readFileSync(LOG, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(calls).toEqual([
      ['mcp', 'remove', 'overlyx-local', '-s', 'user'],
      ['mcp', 'remove', 'overlyx-local', '-s', 'local'],
      ['mcp', 'add-json', '-s', 'user', 'overlyx-local', JSON.stringify({ type: 'stdio', ...cmd })],
    ]);
    expect(reg.claudeRegistered(cmd)).toBe(true);
    expect(reg.claudeRegistered({ ...cmd, command: '/snap/code/current/usr/share/code/code' })).toBe(false);
    expect(reg.allowClaudeTools(true)).toBe(true);
    expect(reg.allowClaudeTools(true)).toBe(false);
    expect(JSON.parse(fs.readFileSync(reg.claudeSettingsFile(), 'utf8'))).toEqual({ model: 'opus', permissions: { allow: ['Bash(ls:*)', 'mcp__overlyx-local'] } });
    expect(reg.allowClaudeTools(false)).toBe(true);
    expect(JSON.parse(fs.readFileSync(reg.claudeSettingsFile(), 'utf8')).permissions.allow).toEqual(['Bash(ls:*)']);
  });

  it('Codex: a table in config.toml, other content kept, stale tables replaced, other forms refused', () => {
    fs.mkdirSync(process.env.CODEX_HOME!, { recursive: true });
    const file = reg.codexConfigFile();
    fs.writeFileSync(file, 'model = "gpt-6"\n\n[mcp_servers.overlyx]\ncommand = "/usr/bin/overlyx"\nargs = ["mcp", "serve"]\n');
    reg.registerCodex(cmd);
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('model = "gpt-6"');
    expect(text).toContain('[mcp_servers.overlyx]\ncommand = "/usr/bin/overlyx"');
    expect(text).toContain(`[mcp_servers.overlyx-local]\n# OverLyX VS Code extension: tracked edits and comments in the documents on this computer\ncommand = "/usr/share/code/code"\nargs = ["${cmd.args[0]}"]\nenv = { ELECTRON_RUN_AS_NODE = "1" }\ndefault_tools_approval_mode = "approve"\n`);
    expect(reg.codexRegistered(cmd)).toBe(true);
    reg.registerCodex(cmd);
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
    const moved = { ...cmd, command: '/opt/code/code' };
    expect(reg.codexRegistered(moved)).toBe(false);
    reg.registerCodex(moved);
    const after = fs.readFileSync(file, 'utf8');
    expect(after.match(/\[mcp_servers\.overlyx-local\]/g)).toHaveLength(1);
    expect(after).toContain('command = "/opt/code/code"');
    expect(fs.readFileSync(file + '.bak', 'utf8')).toContain('model = "gpt-6"');
    // the note in Codex's personal instructions (its model follows AGENTS.md before tool descriptions): added once, the rest kept
    const notes = reg.codexInstructionsFile();
    expect(fs.readFileSync(notes, 'utf8')).toMatch(/^<!-- OverLyX \(VS Code extension\): begin[^\n]*-->\n## Tracked changes in LaTeX \/ markdown documents \(OverLyX\)\nOnly when the user asks for tracked changes.*`overlyx-local` MCP server.*Otherwise edit as usual\.\n<!-- OverLyX: end -->\n$/s);
    expect(reg.codexInstructed()).toBe(true);
    reg.instructCodex(false);
    fs.writeFileSync(notes, '# Mine\n\nAlways answer in English.\n');
    expect(reg.instructCodex(true)).toBe(true);
    expect(reg.instructCodex(true)).toBe(false);
    expect(fs.readFileSync(notes, 'utf8')).toMatch(/^# Mine\n\nAlways answer in English\.\n\n<!-- OverLyX/);
    expect(reg.unregisterCodex()).toBe(true);
    expect(fs.readFileSync(notes, 'utf8')).toBe('# Mine\n\nAlways answer in English.\n');
    reg.instructCodex(true); reg.instructCodex(false);
    expect(fs.readFileSync(notes, 'utf8')).toBe('# Mine\n\nAlways answer in English.\n');
    fs.rmSync(notes); reg.instructCodex(true); reg.instructCodex(false);
    expect(fs.existsSync(notes)).toBe(false);   // nothing of the user's: no file left behind
    expect(fs.readFileSync(file, 'utf8')).not.toContain('overlyx-local');
    expect(fs.readFileSync(file, 'utf8')).toContain('[mcp_servers.overlyx]');
    fs.writeFileSync(file, 'mcp_servers.overlyx-local.command = "x"\n');
    expect(() => reg.registerCodex(cmd)).toThrow(/another form/);
  });

  it('the launcher starts the registered version — or, after an update removed it, the newest installed one', () => {
    const exts = path.join(ROOT, 'extensions');
    const mk = (dir: string, says: string) => { fs.mkdirSync(path.join(exts, dir, 'dist'), { recursive: true }); fs.writeFileSync(path.join(exts, dir, 'dist', 'agents.cjs'), `process.stdout.write(${JSON.stringify(says)} + ' ' + process.env.OVERLYX_LAYOUT_DIR)`); };
    mk('overlyx.overlyx-vscode-0.3.40', 'v40');
    const storage = path.join(ROOT, 'globalStorage', 'agents');
    const launcher = reg.installLauncher(storage, { main: path.join(exts, 'overlyx.overlyx-vscode-0.3.40', 'dist', 'agents.cjs'), layoutDir: '/layouts/40', extensionsDir: exts, extensionId: 'overlyx.overlyx-vscode' });
    const run = () => execFileSync(process.execPath, [launcher], { encoding: 'utf8', env: { ...process.env, OVERLYX_LAYOUT_DIR: '' } });
    expect(run()).toBe('v40 /layouts/40');
    // the update: 0.3.41 installed, 0.3.40 removed — before the extension has run again
    mk('overlyx.overlyx-vscode-0.3.41', 'v41');
    fs.rmSync(path.join(exts, 'overlyx.overlyx-vscode-0.3.40'), { recursive: true });
    expect(run()).toBe(`v41 ${path.join(exts, 'overlyx.overlyx-vscode-0.3.41', 'dist', 'lyxlib', 'layouts')}`);
    expect(reg.launcherCommand('/snap/code/187/usr/share/code/code', launcher).command).toBe('/snap/code/current/usr/share/code/code');
    expect(reg.launcherCommand('/usr/share/code/code', launcher)).toEqual({ command: '/usr/share/code/code', args: [launcher], env: { ELECTRON_RUN_AS_NODE: '1' } });
  });
});
