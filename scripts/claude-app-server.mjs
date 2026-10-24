#!/usr/bin/env node
/**
 * The Agent panel's Claude engine: Claude Code through the Agent SDK, behind the part of codex's
 * app-server protocol (JSON-RPC 2.0, JSON lines on stdio) that the server speaks — agent.ts's
 * AgentHost drives it exactly as it drives `codex app-server`, the keeper (agent-keeper.mjs) owns
 * it across server restarts, and the panel, the working copies, checkpoints and builds
 * (agentwork.ts) work the same on either engine. One process per account (its home:
 * data/agent-home/<id>/claude), one Claude Code process per running turn.
 *
 * Methods: initialize, thread/start, thread/resume, thread/read, turn/start, turn/steer,
 * turn/interrupt. Notifications: turn/started, item/started, item/agentMessage/delta,
 * item/reasoning/summaryTextDelta, item/completed, turn/completed — with codex's item shapes:
 * userMessage, agentMessage, reasoning, commandExecution (Bash), fileChange (Edit, Write,
 * NotebookEdit), mcpToolCall (the overlyx tools) and toolCall (Read, Grep, WebSearch …).
 *
 * The sandbox: every Claude Code process runs under bwrap with the settings the server sends with
 * each turn (`overlyxSandbox`: what sandbox.ts sandboxParts gives for the thread's working copy,
 * the live project read only, the thread's scratch HOME and Claude Code's own configuration
 * directory) — no network, no other project, none of OverLyX's data; a turn without them is not
 * run. Model requests and the MCP tools go through scripts/claude-sandbox-entry.mjs's forwarder to
 * OverLyX's internal socket (agentnet.ts) with an internal credential that works nowhere else; the
 * account's Anthropic key stays with the server. No filesystem settings are loaded (no project
 * CLAUDE.md, hooks, skills or .mcp.json: project files anyone with edit access can write), and
 * only the tools below exist.
 *
 * Transcripts: data/agent-home/<id>/claude/threads/<thread>/thread.json (what the thread is, its
 * Claude Code session) and turns.json (each finished turn's items, for thread/read); Claude Code's
 * own session files sit in that thread's directory too (CLAUDE_CONFIG_DIR).
 *
 * Environment (agent.ts AgentHost.spawnKeeper): HOME, OVERLYX_AGENT_TOKEN (the internal
 * credential), OVERLYX_AGENT_NET (the internal socket), OVERLYX_SANDBOX_ENTRY (the forwarder).
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.HOME;
const TOKEN = process.env.OVERLYX_AGENT_TOKEN ?? '';
const NET = process.env.OVERLYX_AGENT_NET ?? '';
const ENTRY = process.env.OVERLYX_SANDBOX_ENTRY ?? path.join(path.dirname(new URL(import.meta.url).pathname), 'claude-sandbox-entry.mjs');
/** the forwarder's port inside the sandbox (its own network namespace: nothing else listens there) */
const PORT = 8765;
const THREADS = path.join(HOME, 'threads');

/** the tools Claude Code has here: files and commands in the working copy, web search, subagents, a plan list */
const TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'NotebookEdit', 'WebSearch', 'Task', 'TodoWrite'];
const ALLOWED = new Set(TOOLS);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

const log = (...a) => process.stderr.write(`[claude-engine] ${a.join(' ')}\n`);

/* ------------------------------------------------------------------ JSON-RPC over stdio */

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
const reply = (id, result) => send({ id, result });
const fail = (id, message, code = -32600) => send({ id, error: { code, message } });
const notify = (method, params) => send({ method, params });

let inBuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  inBuf += d;
  let i;
  while ((i = inBuf.indexOf('\n')) >= 0) {
    const line = inBuf.slice(0, i).trim(); inBuf = inBuf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method && msg.id !== undefined) void dispatch(msg);
    // notifications from the client ('initialized') and answers to requests: nothing to do
  }
});
process.stdin.on('end', () => process.exit(0));

async function dispatch(msg) {
  const p = msg.params ?? {};
  try {
    switch (msg.method) {
      case 'initialize': return reply(msg.id, { userAgent: 'overlyx-claude-engine/1' });
      case 'thread/start': return reply(msg.id, startThread(p));
      case 'thread/resume': return reply(msg.id, resumeThread(p));
      case 'thread/read': return reply(msg.id, { thread: threadView(loadMeta(p.threadId), p.includeTurns !== false) });
      case 'turn/start': return reply(msg.id, startTurn(p));
      case 'turn/steer': return reply(msg.id, steerTurn(p));
      case 'turn/interrupt': return reply(msg.id, await interruptTurn(p));
      case 'model/list': return reply(msg.id, { data: [] });
      default: return fail(msg.id, `${msg.method} is not supported by the Claude engine`, -32601);
    }
  } catch (e) { fail(msg.id, e?.message ?? String(e)); }
}

/* ------------------------------------------------------------------ threads on disk */

const threadDir = (tid) => {
  if (!/^[A-Za-z0-9-]{8,80}$/.test(String(tid ?? ''))) throw new Error('bad thread id');
  return path.join(THREADS, tid);
};
function loadMeta(tid) {
  try { return JSON.parse(fs.readFileSync(path.join(threadDir(tid), 'thread.json'), 'utf8')); }
  catch { throw new Error(`no such thread: ${tid}`); }
}
function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}
const saveMeta = (meta) => { fs.mkdirSync(threadDir(meta.id), { recursive: true }); writeJson(path.join(threadDir(meta.id), 'thread.json'), meta); };
function readTurns(tid) {
  try { return JSON.parse(fs.readFileSync(path.join(threadDir(tid), 'turns.json'), 'utf8')); } catch { return []; }
}
function loadTurns(tid) {
  const turns = readTurns(tid);
  // the turn that was running when this engine stopped (a restart, a crash): kept, as interrupted
  const cur = path.join(threadDir(tid), 'current.json');
  if (!running.has(tid) && fs.existsSync(cur)) {
    try { turns.push({ ...JSON.parse(fs.readFileSync(cur, 'utf8')), status: 'interrupted', error: { message: 'The agent stopped in the middle of this turn (OverLyX restarted its engine).' } }); saveTurns(tid, turns); } catch { /* unreadable */ }
    fs.rmSync(cur, { force: true });
  }
  return turns;
}
const saveTurns = (tid, turns) => writeJson(path.join(threadDir(tid), 'turns.json'), turns);
/** the running turn so far (a restart in the middle keeps it: loadTurns) */
const saveCurrent = (run) => { try { writeJson(path.join(threadDir(run.tid), 'current.json'), { id: run.turnId, items: run.items }); } catch { /* best-effort */ } };

/** the thread as codex describes one (thread/start, thread/resume, thread/read) */
function threadView(meta, withTurns) {
  const turns = withTurns ? [...loadTurns(meta.id)] : [];
  const run = running.get(meta.id);
  if (withTurns && run) turns.push({ id: run.turnId, status: 'inProgress', error: null, items: [...run.items] });
  return { id: meta.id, preview: meta.preview ?? '', modelProvider: 'anthropic', createdAt: Math.floor(meta.createdAt / 1000), updatedAt: Math.floor((meta.updatedAt ?? meta.createdAt) / 1000), cwd: meta.cwd ?? null, turns };
}

/** what thread/start and thread/resume answer: the thread runs only in OverLyX's sandbox, and never asks to leave it */
const loaded = (meta) => ({ thread: threadView(meta, false), model: meta.model ?? null, modelProvider: 'anthropic', cwd: meta.cwd ?? null, approvalPolicy: 'never', activePermissionProfile: { id: 'overlyx' } });

function startThread(p) {
  const meta = {
    id: crypto.randomUUID(), createdAt: Date.now(), cwd: p.cwd ?? null,
    model: typeof p.model === 'string' && p.model ? p.model : null,
    instructions: typeof p.developerInstructions === 'string' ? p.developerInstructions : '',
    mcpKey: String(p.config?.['overlyx.mcpKey'] ?? ''), sessionId: null,
  };
  saveMeta(meta);
  return loaded(meta);
}

function resumeThread(p) {
  const meta = loadMeta(p.threadId);
  if (p.config?.['overlyx.mcpKey']) meta.mcpKey = String(p.config['overlyx.mcpKey']);
  if (typeof p.model === 'string' && p.model) meta.model = p.model;
  if (p.cwd) meta.cwd = p.cwd;
  saveMeta(meta);
  loadTurns(meta.id);   // a turn cut off by a restart of this engine is filed now
  return loaded(meta);
}

/* ------------------------------------------------------------------ turns */

/** the running turn of each thread */
const running = new Map();

/** The turn's input: the editor's context item and the user's message, as Claude Code's user message. */
const inputText = (input) => (Array.isArray(input) ? input : []).filter(x => x?.type === 'text').map(x => String(x.text ?? '')).join('\n\n');
const userMessage = (text) => ({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });

/** An async queue of user messages: the turn's message, then whatever steers it; closed when the last one is answered. */
function inputQueue() {
  const items = [];
  let wake = null, closed = false;
  return {
    push(m) { items.push(m); wake?.(); },
    close() { closed = true; wake?.(); },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (items.length) { yield items.shift(); continue; }
        if (closed) return;
        await new Promise(r => { wake = r; });
        wake = null;
      }
    },
  };
}

function emitUser(run, input, clientId) {
  const item = { type: 'userMessage', id: 'user-' + crypto.randomUUID(), content: (Array.isArray(input) ? input : []).filter(x => x?.type === 'text').map(x => ({ type: 'text', text: String(x.text ?? '') })), clientId: clientId ?? null };
  run.items.push(item);
  notify('item/completed', { threadId: run.tid, turnId: run.turnId, item });
}

function startTurn(p) {
  const meta = loadMeta(p.threadId);
  if (running.has(meta.id)) throw new Error('a turn is already running in this thread');
  const sb = p.overlyxSandbox;
  if (!sb || !Array.isArray(sb.bwrap) || !Array.isArray(sb.pre) || typeof sb.configDir !== 'string') throw new Error('this turn came without its sandbox — not running it');
  if (!TOKEN || !NET) throw new Error('the Claude engine has no way to OverLyX (its credential or socket is missing)');
  const cwd = String(p.cwd ?? meta.cwd ?? '');
  if (!path.isAbsolute(cwd)) throw new Error('the turn needs its working directory');
  const model = typeof p.model === 'string' && p.model ? p.model : meta.model;
  if (model && model !== meta.model) { meta.model = model; }
  meta.cwd = cwd;
  meta.updatedAt = Date.now();
  const text = inputText(p.input);
  if (!meta.preview) meta.preview = text.replace(/\[context\][\s\S]*?\[\/context\]\s*/g, '').slice(0, 200);
  saveMeta(meta);
  const run = {
    tid: meta.id, turnId: 'turn-' + crypto.randomUUID(), items: [], tools: new Map(), blocks: new Map(), msgId: 'm',
    queue: inputQueue(), inputs: 1, results: 0, q: null, interrupted: false, error: null, resultText: '', costUsd: 0,
    ac: new AbortController(),
  };
  run.texts = [text];
  running.set(meta.id, run);
  notify('turn/started', { threadId: run.tid, turn: { id: run.turnId, status: 'inProgress', items: [], error: null } });
  emitUser(run, p.input, p.clientUserMessageId);
  run.queue.push(userMessage(text));
  const effort = typeof p.effort === 'string' && EFFORTS.has(p.effort) ? p.effort : undefined;
  void drive(run, meta, { cwd, model, effort, sb }).catch(e => log('turn failed:', e?.message ?? e));
  return { turn: { id: run.turnId, status: 'inProgress', items: [], error: null } };
}

function steerTurn(p) {
  const run = running.get(String(p.threadId ?? ''));
  if (!run || (p.expectedTurnId && p.expectedTurnId !== run.turnId)) throw new Error('no such running turn');
  run.inputs++;
  emitUser(run, p.input, p.clientUserMessageId);
  run.texts.push(inputText(p.input));
  run.queue.push(userMessage(inputText(p.input)));
  return { turnId: run.turnId };
}

async function interruptTurn(p) {
  const run = running.get(String(p.threadId ?? ''));
  if (!run) return {};
  run.interrupted = true;
  try { if (run.q) await run.q.interrupt(); else run.ac.abort(); } catch { run.ac.abort(); }
  run.queue.close();
  return {};
}

/** Claude Code, started under bwrap with the turn's sandbox: its environment goes in as --setenv, the forwarder in front. */
function sandboxedSpawn(sb, o) {
  const extra = [];
  // the Claude Code executable and the forwarder: read only, where they are
  for (const d of new Set([path.dirname(o.command), path.dirname(ENTRY), path.dirname(fs.realpathSync(process.execPath))])) {
    if (!d.startsWith('/usr/')) extra.push('--ro-bind', d, d);
  }
  extra.push('--ro-bind', path.dirname(NET), path.dirname(NET));
  for (const [k, v] of Object.entries(o.env ?? {})) {
    if (v === undefined || ['HOME', 'TMPDIR', 'PATH', 'PWD', 'OLDPWD', 'SHLVL', '_'].includes(k)) continue;
    extra.push('--setenv', k, String(v));
  }
  const argv = [...sb.pre, 'bwrap', ...sb.bwrap, ...extra, '--', process.execPath, ENTRY, o.command, ...o.args];
  const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], signal: o.signal });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { for (const l of String(d).split('\n')) if (l.trim()) log('claude:', l.trim().slice(0, 300)); });
  return child;
}

async function drive(run, meta, { cwd, model, effort, sb }) {
  const options = (resume) => ({
    cwd, model: model ?? undefined, effort, resume: resume ?? undefined,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: meta.instructions },
    settingSources: [], strictMcpConfig: true,
    mcpServers: { overlyx: { type: 'http', url: `http://127.0.0.1:${PORT}/mcp`, headers: { Authorization: `Bearer ${TOKEN}`, 'X-OverLyX-Thread': meta.mcpKey } } },
    tools: TOOLS,
    permissionMode: 'default',
    // the sandbox decides what a tool can reach; here only which tools exist
    canUseTool: async (name, input) => (ALLOWED.has(name) || name.startsWith('mcp__overlyx__')
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: `${name} is not available in OverLyX's Agent panel.` }),
    includePartialMessages: true,
    thinking: { type: 'adaptive', display: 'summarized' },
    persistSession: true,
    abortController: run.ac,
    env: {
      LANG: 'C.UTF-8', CLAUDE_CONFIG_DIR: sb.configDir,
      ANTHROPIC_API_KEY: TOKEN, ANTHROPIC_BASE_URL: `http://127.0.0.1:${PORT}/internal/llm/anthropic`,
      DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'overlyx/1', OL_SOCK: NET, OL_PORT: String(PORT),
    },
    spawnClaudeCodeProcess: (o) => sandboxedSpawn(sb, o),
  });
  const once = async (resume) => {
    run.q = query({ prompt: run.queue, options: options(resume) });
    for await (const m of run.q) {
      onMessage(run, meta, m);
      if (m.type === 'result' && run.results >= run.inputs && !(m.queued_turn_count > 0)) run.queue.close();
    }
  };
  try {
    try { await once(meta.sessionId); }
    catch (e) {
      // Claude Code lost the session (its files are gone): go on in a fresh one
      if (!meta.sessionId || run.results || run.items.some(i => i.type !== 'userMessage') || !/conversation|session/i.test(e?.message ?? '')) throw e;
      log(`thread ${meta.id}: session ${meta.sessionId} could not be resumed — starting a new one`);
      meta.sessionId = null; saveMeta(meta);
      run.queue = inputQueue();
      for (const text of run.texts) run.queue.push(userMessage(text));
      await once(null);
    }
  } catch (e) {
    if (!run.interrupted) run.error = e?.message ?? String(e);
  } finally {
    finishTurn(run, meta);
  }
}

/* ------------------------------------------------------------------ Claude Code's messages → codex's items */

const relPath = (cwd, p) => { const s = String(p ?? ''); const r = path.relative(cwd, s); return !r || r.startsWith('..') ? s : r; };
const lines = (s, sign, max = 400) => String(s ?? '').split('\n').slice(0, max).map(l => sign + l).join('\n');
const textOf = (content) => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(c => c?.type === 'text' ? c.text : c?.type === 'image' ? '[image]' : '').join('\n') : '';

/** The item a tool call shows as in the panel. */
function toolItem(id, name, input, cwd) {
  const inp = input ?? {};
  if (name === 'Bash') return { type: 'commandExecution', id, command: String(inp.command ?? ''), cwd, status: 'inProgress', aggregatedOutput: '', exitCode: null };
  if (name === 'Edit' || name === 'MultiEdit') {
    const edits = name === 'Edit' ? [inp] : Array.isArray(inp.edits) ? inp.edits : [];
    const rel = relPath(cwd, inp.file_path);
    return { type: 'fileChange', id, status: 'inProgress', changes: [{ path: rel, kind: 'update', diff: `--- a/${rel}\n+++ b/${rel}\n` + edits.map(e => `${lines(e.old_string, '-')}\n${lines(e.new_string, '+')}`).join('\n') }] };
  }
  if (name === 'Write') {
    const rel = relPath(cwd, inp.file_path);
    let exists = false;
    try { exists = fs.statSync(String(inp.file_path)).isFile(); } catch { /* a new file */ }
    return { type: 'fileChange', id, status: 'inProgress', changes: [{ path: rel, kind: exists ? 'update' : 'add', diff: `+++ b/${rel}\n` + lines(inp.content, '+') }] };
  }
  if (name === 'NotebookEdit') { const rel = relPath(cwd, inp.notebook_path); return { type: 'fileChange', id, status: 'inProgress', changes: [{ path: rel, kind: 'update', diff: lines(inp.new_source, '+') }] }; }
  if (name.startsWith('mcp__overlyx__')) return { type: 'mcpToolCall', id, server: 'overlyx', tool: name.slice('mcp__overlyx__'.length), arguments: inp, status: 'inProgress' };
  const detail = name === 'Read' ? relPath(cwd, inp.file_path) : name === 'Glob' || name === 'Grep' ? String(inp.pattern ?? '') + (inp.path ? ` in ${relPath(cwd, inp.path)}` : '')
    : name === 'WebSearch' ? String(inp.query ?? '') : name === 'Task' ? String(inp.description ?? '') : name === 'TodoWrite' ? `${(inp.todos ?? []).length} items` : '';
  return { type: 'toolCall', id, tool: name, detail, status: 'inProgress' };
}

function upsertItem(run, item, method) {
  const i = run.items.findIndex(x => x.id === item.id);
  if (i >= 0) run.items[i] = item; else run.items.push(item);
  notify(method, { threadId: run.tid, turnId: run.turnId, item });
  if (method === 'item/completed') saveCurrent(run);
}

function onMessage(run, meta, m) {
  if (m.parent_tool_use_id) return;   // a subagent's own work: the panel shows its Task call
  if (m.type === 'system' && m.subtype === 'init' && m.session_id && m.session_id !== meta.sessionId) { meta.sessionId = m.session_id; saveMeta(meta); return; }
  if (m.type === 'stream_event') { onStream(run, m.event ?? {}); return; }
  if (m.type === 'assistant') {
    for (const b of m.message?.content ?? []) {
      if (b?.type !== 'tool_use' || run.tools.has(b.id)) continue;
      const item = toolItem(b.id, String(b.name ?? ''), b.input, meta.cwd);
      run.tools.set(b.id, item);
      upsertItem(run, item, 'item/started');
    }
    return;
  }
  if (m.type === 'user') {
    for (const b of Array.isArray(m.message?.content) ? m.message.content : []) {
      if (b?.type !== 'tool_result') continue;
      const item = run.tools.get(b.tool_use_id);
      if (!item) continue;
      const failed = b.is_error === true;
      const out = textOf(b.content);
      const done = item.type === 'commandExecution' ? { ...item, status: failed ? 'failed' : 'completed', aggregatedOutput: out.slice(-20000), exitCode: failed ? 1 : 0 }
        : item.type === 'fileChange' ? { ...item, status: failed ? 'failed' : 'completed' }
        : { ...item, status: failed ? 'failed' : 'completed', output: out.slice(0, 4000) };
      run.tools.set(b.tool_use_id, done);
      upsertItem(run, done, 'item/completed');
    }
    return;
  }
  if (m.type === 'result') {
    run.results++;
    if (typeof m.total_cost_usd === 'number') run.costUsd = m.total_cost_usd;
    if (typeof m.result === 'string') run.resultText = m.result;
    if (m.is_error || m.subtype !== 'success') {
      const why = (typeof m.result === 'string' && m.result) || (Array.isArray(m.errors) ? m.errors.join('; ') : '') || m.subtype;
      if (!run.interrupted) run.error = why;
    }
  }
}

/** Streamed text and thinking: items as they grow. Tool calls come complete with the assistant message instead. */
function onStream(run, ev) {
  if (ev.type === 'message_start') { run.msgId = ev.message?.id ?? crypto.randomUUID(); run.blocks.clear(); return; }
  if (ev.type === 'content_block_start') {
    const kind = ev.content_block?.type;
    if (kind !== 'text' && kind !== 'thinking') return;
    const id = `${run.msgId}-${ev.index}`;
    const item = kind === 'text' ? { type: 'agentMessage', id, text: '' } : { type: 'reasoning', id, summary: [''], content: [] };
    run.blocks.set(ev.index, item);
    upsertItem(run, item, 'item/started');
    return;
  }
  const item = run.blocks.get(ev.index);
  if (!item) return;
  if (ev.type === 'content_block_delta') {
    const d = ev.delta ?? {};
    if (d.type === 'text_delta' && item.type === 'agentMessage') {
      item.text += d.text ?? '';
      notify('item/agentMessage/delta', { threadId: run.tid, turnId: run.turnId, itemId: item.id, delta: d.text ?? '' });
    } else if (d.type === 'thinking_delta' && item.type === 'reasoning') {
      item.summary[0] += d.thinking ?? '';
      notify('item/reasoning/summaryTextDelta', { threadId: run.tid, turnId: run.turnId, itemId: item.id, delta: d.thinking ?? '', summaryIndex: 0 });
    }
    return;
  }
  if (ev.type === 'content_block_stop') {
    run.blocks.delete(ev.index);
    if (item.type === 'agentMessage' && !item.text.trim()) { run.items = run.items.filter(x => x.id !== item.id); return; }
    upsertItem(run, { ...item, summary: item.summary ? [...item.summary] : undefined }, 'item/completed');
  }
}

function finishTurn(run, meta) {
  running.delete(run.tid);
  // tool calls still open (the turn was stopped or failed in the middle): over
  for (const [id, item] of run.tools) if (item.status === 'inProgress') { const done = { ...item, status: 'failed' }; run.tools.set(id, done); upsertItem(run, done, 'item/completed'); }
  if (!run.error && !run.interrupted && run.resultText.trim() && !run.items.some(i => i.type === 'agentMessage')) {
    upsertItem(run, { type: 'agentMessage', id: `${run.turnId}-answer`, text: run.resultText }, 'item/completed');
  }
  const status = run.interrupted ? 'interrupted' : run.error ? 'failed' : 'completed';
  const turn = { id: run.turnId, status, error: run.error ? { message: run.error } : null, items: run.items, costUsd: run.costUsd };
  try {
    const turns = readTurns(run.tid);
    turns.push(turn);
    saveTurns(run.tid, turns);
    fs.rmSync(path.join(threadDir(run.tid), 'current.json'), { force: true });
    meta.updatedAt = Date.now();
    saveMeta(meta);
  } catch (e) { log('could not save the turn:', e?.message ?? e); }
  notify('turn/completed', { threadId: run.tid, turn: { id: run.turnId, status, error: turn.error, items: [] } });
}

for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => {
  for (const run of running.values()) { run.interrupted = true; run.ac.abort(); }
  setTimeout(() => process.exit(0), 1500).unref();
});
