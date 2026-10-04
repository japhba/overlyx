/**
 * The embedded coding agent: OpenAI Codex, driven over its app-server protocol (JSON-RPC 2.0 as
 * JSON-lines on stdio — the same interface the Codex VS Code extension uses). One codex child
 * process per signed-in *user*, `CODEX_HOME` under data/agent-home/<userId>/ — so credentials
 * (the user's own ChatGPT account, device-code sign-in) and codex's memories are per user and
 * shared across that user's projects. Threads work in a private copy of the project (agentwork.ts:
 * codex's workspace-write sandbox with the copy as its only writable root) and edit files the way
 * coding agents do; their document changes reach the live documents as tracked changes, word by
 * word. Every thread is recorded in agent_threads (db.ts) so access follows
 * the project's sharing: any editor of the project sees its threads and may read transcripts,
 * only the thread's creator drives it.
 *
 * The client talks to routes under /api (agentRoutes): a per-project SSE stream forwards codex's
 * notifications (message/reasoning deltas, command output, diffs, turn lifecycle) and its
 * approval *requests* (command execution / file changes), which the client answers via POST.
 *
 * The codex child is NOT our child: a detached keeper (scripts/agent-keeper.mjs) owns it and
 * bridges its stdio to a unix socket under the user's agent home. A server restart — a deploy —
 * disconnects and reconnects; the turn keeps running, buffered events are replayed, and
 * unanswered approval requests are re-delivered (the systemd unit needs KillMode=process).
 */
import express, { type Request, type Response } from 'express';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import { db } from './db.ts';
import { manager } from './docs.ts';
import { projectDir } from './projects.ts';
import { canonicalProject } from './namespaces.ts';
import { roleFor, atLeast, logAccess } from './access.ts';
import { createMcpToken } from './mcpTokens.ts';
import { selectionToTex, documentContext } from './ai.ts';
import {
  prepareWorkspace, syncWorkspace, pruneWorkspaces, finishTurn, checkBuilds, noteTurnId, listCheckpoints, onCheckpoint,
  publicCheckpoint, undoCheckpoint, UndoError, setPanelTracking, panelTracking, workspaceTracking, type Checkpoint,
} from './agentwork.ts';
import type { PMJSON } from '@overlyx/core';

/* ------------------------------------------------------------------ protocol types (the subset we touch) */

interface JsonRpcMsg { jsonrpc?: string; id?: number | string; method?: string; params?: any; result?: any; error?: { code: number; message: string } }
export interface AgentEvent {
  /** 'checkpoint': what a turn changed in the project, its build check, its undo (params: { threadId, checkpoint }) */
  kind: 'notification' | 'request' | 'status' | 'checkpoint';
  method?: string;
  params?: any;
  /** for kind 'request': answer via POST …/approval with this id */
  requestId?: string;
  running?: boolean;
}

// Threads started before NATIVE_EDITS_SINCE keep the instructions they were started with (codex
// binds them at thread/start): project directory as cwd, read-only, every edit through the
// overlyx MCP document tools — which apply tracked changes word by word too (mcp.ts).

/** Threads from this moment on edit a private working copy with codex's own tools (agentwork.ts). */
export const NATIVE_EDITS_SINCE = Date.parse('2026-09-27T09:48:00Z');
export const isNativeThread = (createdAt: number): boolean => createdAt >= NATIVE_EDITS_SINCE;

const NATIVE_INSTRUCTIONS = (project: string) => `You are embedded in OverLyX, a collaborative WYSIWYG LaTeX editor. The working directory is your private working copy of the user's LaTeX project "${project}", refreshed from the live project at the start of every turn. Edit files here directly with your usual tools (apply_patch; a script for mechanical changes). Every change you make to a .tex document is picked up right away and applied to the live document as tracked changes — marked word by word, a changed digit is one digit — which the user reviews and accepts or rejects in the editor; that is the whole point, so edit exactly what needs to change and leave the rest byte-for-byte alone. Changes to other files (.bib, a new figure or .tex file) are copied into the project; build output you produce here (latexmk's .aux/.log, the PDF next to a .tex) stays here.
The copy does not change under you during a turn, but the live document does — the user edits between and during your turns and your edits are merged in — so read a file afresh at the start of each turn instead of relying on what it said earlier.
Pending tracked changes appear in the source as \\lyxadded{author}{time}{text} and \\lyxdeleted{author}{time}{text}: text inside \\lyxdeleted is already deleted — don't restore it unless asked; edit around and inside these macros freely (you never need to write them yourself). Comment lines starting with %% are OverLyX bookkeeping (notes, settings) — leave them unless asked. Never run git: OverLyX versions every change.
The "overlyx" MCP server (project "${project}") has the comment threads (list_comments / add_comment / resolve_comment), build_pdf, which compiles the live document (your edits are already in it), and undo_turn. Do NOT recompile after every edit: when a turn has changed a .tex document, OverLyX builds it after the turn and shows the user whether the PDF still compiles — compile yourself only when asked, or once at the end of a larger or riskier change (new packages, macros, environments, tables). If build_pdf says your changes broke the build (it compares with the build before your changes), fix the error, or take the turn's changes back with undo_turn when you cannot fix it quickly — never end a turn leaving a document that no longer compiles. undo_turn with turns_back 1, 2, … takes back an earlier turn's changes exactly (the user's edits since are kept) — use it when the user asks you to roll back.
You have internet access through the web_search tool — use it for literature, references and facts (a shell command that needs the network still asks for approval).
By default the user is here to understand and explore their document and the literature around it — answering, explaining, finding and summarizing is the normal mode, and most turns should not touch any file. Editing happens every so often, only when the user explicitly asks for a change; when a request is ambiguous about whether to edit, explain first and offer the edit instead of making it.
Each user message may be preceded by a [context]…[/context] item the editor adds (the user did not write it): the document being edited, the other open documents, and the current selection — quoted, and marked ⟦SELECTION⟧…⟦/SELECTION⟧ in a file excerpt. Use it to resolve "this", "here" or an unqualified request.`;

/** The sandbox of a turn in a working copy: only the copy (and /tmp) is writable. */
const workspaceSandbox = (dir: string) => ({ type: 'workspaceWrite', writableRoots: [dir], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false });

/**
 * A note in front of a turn's message when the panel's Track changes box is off (or back on after
 * a turn with it off): the thread's instructions speak of tracked changes.
 */
function trackingNote(tracked: boolean, wasTracked: boolean | undefined): string | null {
  if (!tracked) return '[context] Note from the OverLyX editor (the user did not write this): Track changes is OFF for this turn — the user unticked it in the agent panel. Your edits to .tex documents go into the live documents directly, without tracked-change marks (the overlyx MCP document tools default to tracked: false too). OverLyX still keeps a checkpoint of the turn that the user can take back. Everything else in your instructions applies. [/context]';
  if (wasTracked === false) return '[context] Note from the OverLyX editor (the user did not write this): Track changes is ON again for this turn — your edits to .tex documents are tracked changes the user reviews, as your instructions say. [/context]';
  return null;
}

/**
 * Threads started before the managed codex config gained the overlyx MCP server were created
 * without the document tools (codex binds a thread's tool set at thread/start; the config change
 * cannot reach an existing thread). Such threads get a per-turn fallback note: edit the .tex
 * directly and write the tracked-change markup by hand. Wrapped as [context]…[/context] so the
 * panel strips it from the echoed user message (AgentPanel CONTEXT_RE is global).
 */
export const MCP_TOOLS_SINCE = Date.parse('2026-09-01T22:02:00Z');
export function legacyThreadNote(createdAt: number, now = new Date()): string | null {
  if (createdAt >= MCP_TOOLS_SINCE) return null;
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], mons = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n: number) => String(n).padStart(2, '0');
  const asctime = `${days[now.getDay()]} ${mons[now.getMonth()]} ${String(now.getDate()).padStart(2, ' ')} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())} ${now.getFullYear()}`;
  return `[context] Note from the OverLyX editor (the user did not write this): this conversation was started before the "overlyx" document tools existed, so those MCP tools may be missing here — a NEW thread would have them. If they are missing and the user asks for a document change, edit the .tex file directly instead (the write triggers an approval card — expected; re-read the file immediately before patching, it changes live, and patch whole lines) and mark the edit up as a tracked change yourself: wrap every insertion in \\lyxadded{Agent panel (MCP)}{${asctime}}{…} and keep every deletion inside \\lyxdeleted{Agent panel (MCP)}{${asctime}}{old text} instead of removing the text. Leave lines starting with %% untouched. [/context]`;
}

/* ------------------------------------------------------------------ per-user codex host */

type Subscriber = { project: string; res: Response };
interface PendingReq { resolve: (v: any) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout }

const agentHomeDir = (userId: number) => path.join(config.dataDir, 'agent-home', String(userId));

const AGENT_TOKEN_NAME = 'Agent panel';
/** The hidden internal MCP credential the embedded agent authenticates with (plaintext kept so
 *  every codex start can pass it via the environment; re-minted if it is ever deleted). */
function agentMcpToken(userId: number): string {
  const row = db.prepare('SELECT token_plain FROM mcp_tokens WHERE user_id = ? AND name = ? AND token_plain IS NOT NULL').get(userId, AGENT_TOKEN_NAME) as { token_plain: string } | undefined;
  return row ? row.token_plain : createMcpToken(userId, AGENT_TOKEN_NAME, true).token;
}

class AgentHost {
  /** connection to this user's keeper, which owns the codex child (scripts/agent-keeper.mjs) */
  conn: net.Socket | null = null;
  /** a keeper connection is up (the events stream reports it) */
  running = false;
  private buf = '';
  /** request ids go to the same codex process across server restarts — seed from the clock so a
   *  new server never reuses an id the previous one left in flight */
  private nextId = (Date.now() % 1000000) * 1000;
  private pending = new Map<number, PendingReq>();
  /** server→client requests (approvals) waiting for the user's decision, by our string key */
  private serverReqs = new Map<string, { id: number | string; method: string; params: any }>();
  private helloResolve: ((h: { initialized?: boolean }) => void) | null = null;
  subscribers = new Set<Subscriber>();
  /** project of each thread this user owns (from agent_threads; new threads added as they start) */
  threadProjects = new Map<string, string>();
  private loaded = new Set<string>();
  private idleTimer: NodeJS.Timeout | null = null;
  private activeTurns = new Set<string>();
  ready: Promise<void> | null = null;

  constructor(public userId: number) {
    const rows = db.prepare('SELECT thread_id, project FROM agent_threads WHERE user_id = ?').all(userId) as { thread_id: string; project: string }[];
    for (const r of rows) this.threadProjects.set(r.thread_id, r.project);
  }

  home(): string { return agentHomeDir(this.userId); }
  private sockPath(): string { return path.join(this.home(), 'keeper.sock'); }

  /** Write the managed codex config; `true` when an existing, different config was replaced
   *  (codex only reads it at process start, so the keeper must then be restarted). */
  private ensureHome(): boolean {
    const h = this.home();
    fs.mkdirSync(h, { recursive: true });
    // OverLyX owns this file — rewritten on every start so the port and settings stay current
    const file = path.join(h, 'config.toml');
    const text = `# OverLyX-managed codex configuration for this account
[features]
memories = true
web_search_request = true

# The agent may search the web (codex's own web_search tool — it runs outside the filesystem
# sandbox, so the read-only sandbox does not block it).
[tools]
web_search = true

# OverLyX's own MCP connector: tracked-change document edits, comments, builds — all of the
# account's projects on one connection (tools take a \`project\` argument). The bearer token
# arrives via the environment at codex start.
[mcp_servers.overlyx]
url = "http://127.0.0.1:${config.port}/mcp"
bearer_token_env_var = "OVERLYX_MCP_TOKEN"
# The tools already apply document edits as tracked changes the user reviews in the editor, so
# codex must not gate them behind its own approval prompt. That prompt arrives as an MCP
# elicitation; the panel used to have no card for it and every write tool came back
# "user rejected MCP tool call".
default_tools_approval_mode = "approve"
`;
    let old: string | null = null;
    try { old = fs.readFileSync(file, 'utf8'); } catch { /* fresh home */ }
    if (old === text) return false;
    fs.writeFileSync(file, text);
    return old !== null;
  }

  /** Connect to this user's keeper (spawning one when none runs). The codex initialize
   *  handshake happens once per codex process: after an OverLyX restart the keeper still holds
   *  the initialized child and hello says so. */
  ensure(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = this.connect().catch(e => { this.ready = null; throw e; });
    return this.ready;
  }

  private dial(): Promise<net.Socket | null> {
    return new Promise(resolve => {
      const c = net.connect(this.sockPath());
      c.once('connect', () => resolve(c));
      c.once('error', () => resolve(null));
    });
  }

  private async connect(): Promise<void> {
    const configChanged = this.ensureHome();
    let sock = await this.dial();
    if (sock && configChanged) {
      // codex reads config.toml only at process start: a changed managed config (a new MCP
      // server, another model…) never reaches a keeper's running codex — old keepers kept
      // serving threads WITHOUT the overlyx MCP tools after the connector was introduced.
      // Ask the keeper to shut down (it kills its codex child; threads resume on demand).
      console.log(`[agent ${this.userId}] managed codex config changed — restarting the keeper`);
      try { sock.write(JSON.stringify({ keeper: 'shutdown' }) + '\n'); } catch { /* gone */ }
      sock.destroy();
      for (let i = 0; i < 40 && fs.existsSync(this.sockPath()); i++) await new Promise(r => setTimeout(r, 100));
      sock = await this.dial();   // a race with a just-spawning keeper: take it if one answers
    }
    if (!sock) {
      this.spawnKeeper();
      for (let i = 0; i < 50 && !sock; i++) { await new Promise(r => setTimeout(r, 100)); sock = await this.dial(); }
      if (!sock) throw new Error('the agent keeper did not start');
    }
    await this.attach(sock);
  }

  private versionPath(): string { return path.join(this.home(), 'codex-version'); }

  /** A newer codex was installed since this user's keeper started its child (a keeper from
   *  before the version stamp counts as outdated). */
  codexOutdated(): boolean {
    const now = installedCodexVersion();
    if (!now) return false;
    let ran = '';
    try { ran = fs.readFileSync(this.versionPath(), 'utf8').trim(); } catch { /* no stamp */ }
    return ran !== now;
  }

  private spawnKeeper(): void {
    try { fs.unlinkSync(this.sockPath()); } catch { /* none */ }
    try { fs.writeFileSync(this.versionPath(), installedCodexVersion() ?? ''); } catch { /* the check just stays off */ }
    const child = spawn(process.execPath, [KEEPER_SCRIPT], {
      detached: true, stdio: 'ignore', cwd: this.home(),
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: process.env.LANG ?? 'C.UTF-8',
        KEEPER_SOCKET: this.sockPath(), KEEPER_BIN: config.agent.bin, KEEPER_HOME: this.home(),
        OVERLYX_MCP_TOKEN: agentMcpToken(this.userId),
        ...(process.env.OVERLYX_KEEPER_IDLE_MS ? { KEEPER_IDLE_MS: process.env.OVERLYX_KEEPER_IDLE_MS } : {}),
      },
    });
    child.unref();
  }

  private attach(sock: net.Socket): Promise<void> {
    this.conn = sock;
    this.buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (d: string) => this.onData(d));
    sock.on('close', () => this.onClose(sock));
    sock.on('error', () => { /* close follows */ });
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.helloResolve = null; reject(new Error('the agent keeper did not answer')); }, 10000);
      this.helloResolve = (h) => {
        clearTimeout(t);
        (async () => {
          if (!h.initialized) {
            // a fresh codex process: none of the threads is loaded in it any more
            this.loaded.clear();
            await this.request('initialize', { clientInfo: { name: 'overlyx', title: 'OverLyX', version: '0.1.0' } });
            this.send({ jsonrpc: '2.0', method: 'initialized' });
            this.control({ keeper: 'mark-initialized' });
          }
          this.running = true;
          this.touch();
        })().then(resolve, reject);
      };
    });
  }

  /** The socket to the keeper went away (server-side stop, keeper exit): in-flight requests fail,
   *  but codex itself may well still run — the next ensure() reconnects and picks the thread up. */
  private onClose(sock: net.Socket): void {
    if (this.conn !== sock) return;
    this.conn = null; this.ready = null; this.running = false;
    for (const p of this.pending.values()) { if (p.timer) clearTimeout(p.timer); p.reject(new Error('the agent connection closed')); }
    this.pending.clear(); this.serverReqs.clear(); this.activeTurns.clear();
    this.emit({ kind: 'status', running: false });
  }

  private send(msg: JsonRpcMsg): void { this.conn?.write(JSON.stringify(msg) + '\n'); }
  private control(msg: object): void { this.conn?.write(JSON.stringify(msg) + '\n'); }

  request(method: string, params?: any, timeoutMs = 30000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const p: PendingReq = { resolve, reject };
      if (timeoutMs > 0) p.timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method}: the agent did not answer in time`)); }, timeoutMs);
      this.pending.set(id, p);
      this.send({ jsonrpc: '2.0', id, method, params });
      this.touch();
    });
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg: JsonRpcMsg & { keeper?: string };
      try { msg = JSON.parse(line); } catch { continue; }
      this.touch();
      if (msg.keeper) this.onKeeper(msg as { keeper: string; [k: string]: unknown });
      else if (msg.id !== undefined && msg.method) this.onServerRequest(msg);
      else if (msg.id !== undefined) {
        const p = this.pending.get(Number(msg.id));
        if (p) { this.pending.delete(Number(msg.id)); if (p.timer) clearTimeout(p.timer); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); }
      } else if (msg.method) this.onNotification(msg);
    }
  }

  /** The keeper's own control lines: the hello on connect, codex stderr, codex exit. */
  private onKeeper(msg: { keeper: string; [k: string]: unknown }): void {
    if (msg.keeper === 'hello' && this.helloResolve) { const r = this.helloResolve; this.helloResolve = null; r(msg as { initialized?: boolean }); }
    else if (msg.keeper === 'stderr' && msg.line) console.error(`[agent ${this.userId}]`, String(msg.line).slice(0, 500));
    else if (msg.keeper === 'exit') {
      console.error(`[agent ${this.userId}] codex exited${msg.code ? ` (${msg.code})` : ''}`);
      this.conn?.destroy();   // onClose does the bookkeeping
    }
  }

  /** codex asks the client something (command / file-change approval): forward to the panel. */
  private onServerRequest(msg: JsonRpcMsg): void {
    const method = msg.method!;
    // Forwarded to the panel as approval cards: codex's command / file-change approvals, and MCP
    // elicitations — codex asks the user to allow an MCP tool call this way (the question in
    // params.message, tool arguments under params._meta). Anything else is unsupported.
    if (!/requestApproval|applyPatchApproval|execCommandApproval|requestUserInput|mcpServer\/elicitation/.test(method)) {
      this.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `${method} is not supported by this client` } });
      return;
    }
    const key = `r${msg.id}`;
    this.serverReqs.set(key, { id: msg.id!, method, params: msg.params });
    this.emit({ kind: 'request', method, params: msg.params, requestId: key }, msg.params?.threadId);
    // nobody may ever answer (tab closed): decline after 10 minutes so the turn can finish
    setTimeout(() => { if (this.serverReqs.has(key)) this.respond(key, { decision: 'decline' }); }, 10 * 60 * 1000).unref();
  }

  respond(requestId: string, result: any): boolean {
    const r = this.serverReqs.get(requestId);
    if (!r) return false;
    this.serverReqs.delete(requestId);
    // an elicitation answers with an MCP ElicitResult, not the approval {decision} shape; codex
    // maps decline → "user rejected MCP tool call", accept → approved (persist: 'session' makes
    // it stick for the rest of the session, like acceptForSession on a command approval)
    if (r.method === 'mcpServer/elicitation/request' && typeof result?.decision === 'string') {
      const d = result.decision;
      result = d === 'accept' ? { action: 'accept', content: null }
        : d === 'acceptForSession' ? { action: 'accept', content: null, _meta: { persist: 'session' } }
        : d === 'cancel' ? { action: 'cancel', content: null }
        : { action: 'decline', content: null };
    }
    this.send({ jsonrpc: '2.0', id: r.id, result });
    return true;
  }

  /** approvals still waiting for an answer in this thread — the thread read returns them so a
   *  reload (or a reconnect after a deploy) shows the pending card again */
  pendingApprovals(threadId: string): { requestId: string; method: string; params: any }[] {
    const out: { requestId: string; method: string; params: any }[] = [];
    for (const [key, r] of this.serverReqs) if (r.params?.threadId === threadId) out.push({ requestId: key, method: r.method, params: r.params });
    return out;
  }

  private onNotification(msg: JsonRpcMsg): void {
    const m = msg.method!, p = msg.params ?? {};
    const tid = p.threadId ?? p.thread?.id;
    if (m === 'turn/started' && tid) this.activeTurns.add(tid);
    if ((m === 'turn/completed' || m === 'error') && tid) {
      this.activeTurns.delete(tid);
      db.prepare('UPDATE agent_threads SET updated_at = ? WHERE thread_id = ?').run(Date.now(), tid);
    }
    if (m === 'thread/name/updated' && tid && p.name) db.prepare('UPDATE agent_threads SET title = ? WHERE thread_id = ?').run(String(p.name).slice(0, 120), tid);
    if (m === 'thread/closed' && tid) this.loaded.delete(tid);
    this.emit({ kind: 'notification', method: m, params: p }, tid);
    if (!tid) return;
    // the agent changed files in its working copy: take them over into the live project
    if (m === 'item/completed' && (p.item?.type === 'fileChange' || p.item?.type === 'commandExecution')) this.scheduleSync(tid);
    if (m === 'turn/started' && p.turn?.id) this.native(tid, () => noteTurnId(tid, String(p.turn.id)));
    if (m === 'turn/completed') this.native(tid, row => this.endTurn(tid, row.project));
  }

  /** Run `f` for a thread that works in a copy (agentwork.ts). */
  private native(tid: string, f: (row: ThreadRow) => unknown): void {
    const row = threadRow(tid);
    if (row && isNativeThread(row.created_at)) f(row);
  }

  private syncTimers = new Map<string, NodeJS.Timeout>();
  private scheduleSync(tid: string): void {
    this.native(tid, row => {
      clearTimeout(this.syncTimers.get(tid));
      this.syncTimers.set(tid, setTimeout(() => {
        this.syncTimers.delete(tid);
        syncWorkspace(tid, row.project, this.userId).catch(e => console.error(`[agent ${this.userId}] sync of ${tid} failed:`, (e as Error).message));
      }, 150));
    });
  }

  /** The turn is over: its last changes go live, its checkpoint closes, and what it changed is built (the panel follows through onCheckpoint). */
  private endTurn(tid: string, project: string): void {
    clearTimeout(this.syncTimers.get(tid));
    this.syncTimers.delete(tid);
    void (async () => {
      const cp = await finishTurn(tid, project, this.userId);
      if (cp) await checkBuilds(tid, project, cp.n);
    })().catch(e => console.error(`[agent ${this.userId}] end of turn in ${tid} failed:`, (e as Error).message));
  }

  emitCheckpoint(tid: string, cp: Checkpoint): void {
    this.emit({ kind: 'checkpoint', params: { threadId: tid, checkpoint: publicCheckpoint(cp) } }, tid);
  }

  /** Push an event to this user's panels — of the thread's project, or all of them for account-level events. */
  private emit(ev: AgentEvent, threadId?: string): void {
    const project = threadId ? this.threadProjects.get(threadId) : null;
    if (threadId && !project) return;   // a thread of another CODEX_HOME context (shouldn't happen)
    const data = `data: ${JSON.stringify(ev)}\n\n`;
    for (const s of this.subscribers) if (!project || s.project === project) s.res.write(data);
  }

  async ensureThreadLoaded(threadId: string): Promise<void> {
    if (this.loaded.has(threadId)) return;
    await this.request('thread/resume', { threadId });
    this.loaded.add(threadId);
  }

  markLoaded(threadId: string, project: string): void { this.loaded.add(threadId); this.threadProjects.set(threadId, project); }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      // an open panel keeps codex running — unless a newer codex was installed since it started
      // (scripts/update-codex.sh): then a quiet one stops too, and the next request starts the new one
      if (this.activeTurns.size || (this.subscribers.size && !this.codexOutdated())) { this.touch(); return; }
      if (this.subscribers.size) console.log(`[agent ${this.userId}] codex ${installedCodexVersion()} is installed — restarting the quiet agent on it`);
      this.stop();
    }, config.agent.idleMs);
    this.idleTimer.unref();
  }

  /** Stop the keeper and its codex child (idle, tests) — threads resume on demand. */
  stop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const c = this.conn;
    this.conn = null; this.ready = null; this.running = false;
    for (const p of this.pending.values()) { if (p.timer) clearTimeout(p.timer); p.reject(new Error('the agent was stopped')); }
    this.pending.clear(); this.serverReqs.clear(); this.activeTurns.clear();
    if (c) {
      try { c.write(JSON.stringify({ keeper: 'shutdown' }) + '\n'); } catch { /* gone */ }
      setTimeout(() => c.destroy(), 300).unref();
    }
  }

  /** Detach only (server shutdown): the keeper keeps codex — and a running turn — alive. */
  disconnect(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.conn?.destroy();
  }
}

/** The version of the @openai/codex package that `bin` runs (a name on PATH or a path, npm's bin
 *  link resolved); null for anything else, such as the test stub. */
export function installedCodexVersion(bin: string = config.agent.bin, pathEnv: string = process.env.PATH ?? ''): string | null {
  const candidates = bin.includes('/') ? [bin] : pathEnv.split(':').filter(Boolean).map(d => path.join(d, bin));
  for (const c of candidates) {
    let real: string;
    try { real = fs.realpathSync(c); } catch { continue; }
    // the nearest package.json above the executable decides
    for (let dir = path.dirname(real); dir !== path.dirname(dir); dir = path.dirname(dir)) {
      let pkg: { name?: unknown; version?: unknown };
      try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { continue; }
      return pkg.name === '@openai/codex' && typeof pkg.version === 'string' ? pkg.version : null;
    }
    return null;
  }
  return null;
}

const KEEPER_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../scripts/agent-keeper.mjs');

const hosts = new Map<number, AgentHost>();
function host(userId: number): AgentHost {
  let h = hosts.get(userId);
  if (!h) { h = new AgentHost(userId); hosts.set(userId, h); }
  return h;
}

/** Server shutdown: detach from the keepers — the codex children keep running and the next
 *  server process (a deploy's restart) reconnects instead of killing a turn in progress. */
export function disconnectAgents(): void { for (const h of hosts.values()) h.disconnect(); }

/** Stop every keeper and codex child (tests, explicit teardown). */
export function shutdownAgents(): void { for (const h of hosts.values()) h.stop(); }

export function agentAvailable(): boolean { return config.agent.enabled; }

/* ------------------------------------------------------------------ selection context */

export interface TurnContext { docId?: string; content?: PMJSON[]; layout?: string; mathLatex?: string; openDocs?: string[] }

/** The input sent to the agent: a context item (where the user is, which documents are open,
 *  what they selected — quoted, and marked in an excerpt of the live file; the client hides
 *  items starting with "[context]") followed by the user's message. */
async function composeInput(text: string, ctx: TurnContext | undefined): Promise<{ type: 'text'; text: string; text_elements: never[] }[]> {
  const item = (t: string) => ({ type: 'text' as const, text: t, text_elements: [] as never[] });
  if (!ctx?.docId) return [item(text)];
  const lines = [`[context] The user is editing ${ctx.docId} in OverLyX.`];
  const others = [...new Set(ctx.openDocs ?? [])].filter(d => d !== ctx.docId).slice(0, 8);
  if (others.length) lines.push(`Also open in their workspace: ${others.join(', ')}.`);
  let sel = '';
  try {
    if (ctx.content?.length) {
      const doc = await manager.open(ctx.docId);
      sel = selectionToTex(doc, ctx.content, ctx.layout ?? 'Standard').trim();
      if (sel) lines.push('Their current selection in that document:', '```latex', sel.slice(0, 6000), '```');
    }
  } catch { /* selection context is best-effort */ }
  if (!sel && ctx.mathLatex?.trim()) {
    sel = ctx.mathLatex.trim();
    lines.push('Their current selection, inside a formula:', '```latex', sel.slice(0, 2000), '```');
  }
  if (sel) {
    // where it sits: an excerpt of the live file with the passage marked (best-effort — the
    // selection may not appear verbatim in the file, e.g. a partial formula)
    try {
      const doc = await manager.open(ctx.docId);
      const excerpt = documentContext(await doc.textAsync(), sel, 5000);
      if (excerpt.includes('⟦SELECTION⟧')) lines.push(`Where the selection sits in ${ctx.docId} (the ⟦SELECTION⟧…⟦/SELECTION⟧ markers are not part of the file):`, '```latex', excerpt, '```');
    } catch { /* best-effort */ }
  }
  // codex concatenates input items into one string when it echoes/stores the user message, so the
  // context block carries an explicit terminator the client can strip it by (AgentPanel userText)
  return [item(lines.join('\n') + '\n[/context]'), item(text)];
}

/* ------------------------------------------------------------------ routes */

interface ThreadRow { thread_id: string; project: string; user_id: number; title: string | null; created_at: number; updated_at: number }
const threadRow = (tid: string) => db.prepare('SELECT * FROM agent_threads WHERE thread_id = ?').get(tid) as ThreadRow | undefined;

export function agentRoutes(): express.Router {
  const r = express.Router();
  if (config.agent.enabled) { try { pruneWorkspaces(); } catch { /* best-effort */ } }
  // what a turn changed, its build check, its undo: to the thread owner's open panels
  onCheckpoint((tid, cp) => { const row = threadRow(tid); if (row) hosts.get(row.user_id)?.emitCheckpoint(tid, cp); });
  r.use(['/agent', '/projects/:project/agent'], (_req, res, next) => { if (!config.agent.enabled) { res.status(404).json({ error: 'the agent is not enabled on this server' }); return; } next(); });

  const fail = (res: Response, e: unknown, code = 500) => { if (!res.headersSent) res.status(code).json({ error: (e as Error)?.message ?? String(e) }); };

  /** at least `min` in `:project`, else 403; returns the role or null */
  const needRole = (req: Request, res: Response, min: 'view' | 'edit'): boolean => {
    req.params.project = canonicalProject(String(req.params.project ?? ''));   // an old name (namespaces.ts)
    const role = roleFor(req.user!, req.params.project);
    if (!atLeast(role, min)) { res.status(403).json({ error: 'You do not have access to this project' }); return false; }
    return true;
  };

  /* ---- account (per user, project-independent) ---- */

  r.get('/agent/status', (req, res) => { void (async () => {
    const userId = req.user!.id;
    const authFile = path.join(agentHomeDir(userId), 'auth.json');
    if (!fs.existsSync(authFile) && !hosts.get(userId)?.conn) { res.json({ enabled: true, authenticated: false }); return; }
    try {
      const h = host(userId); await h.ensure();
      const [auth, acct] = await Promise.all([h.request('getAuthStatus', {}), h.request('account/read', {}).catch(() => null)]);
      const account = acct?.account && acct.account.type === 'chatgpt' ? { email: acct.account.email ?? null, plan: acct.account.planType ?? null } : null;
      res.json({ enabled: true, authenticated: !!auth?.authMethod && auth.authMethod !== null, method: auth?.authMethod ?? null, account });
    } catch (e) { fail(res, e); }
  })(); });

  r.post('/agent/login', (req, res) => { void (async () => {
    try {
      const h = host(req.user!.id); await h.ensure();
      const out = await h.request('account/login/start', { type: 'chatgptDeviceCode' });
      res.json({ loginId: out.loginId, verificationUrl: out.verificationUrl, userCode: out.userCode });
    } catch (e) { fail(res, e); }
  })(); });

  r.post('/agent/login/cancel', (req, res) => { void (async () => {
    try { await host(req.user!.id).request('account/login/cancel', { loginId: String(req.body?.loginId ?? '') }); res.json({ ok: true }); }
    catch (e) { fail(res, e); }
  })(); });

  r.post('/agent/logout', (req, res) => { void (async () => {
    try { const h = host(req.user!.id); await h.ensure(); await h.request('account/logout'); res.json({ ok: true }); }
    catch (e) { fail(res, e); }
  })(); });

  r.get('/agent/models', (req, res) => { void (async () => {
    try {
      const h = host(req.user!.id); await h.ensure();
      const out = await h.request('model/list', {});
      const models = ((out?.data ?? []) as any[]).filter(m => !m.hidden).map(m => ({
        id: String(m.model ?? m.id),
        label: String(m.displayName ?? m.model ?? m.id),
        description: String(m.description ?? ''),
        efforts: ((m.supportedReasoningEfforts ?? []) as any[]).map(e => (typeof e === 'string' ? e : String(e?.effort ?? e?.reasoningEffort ?? ''))).filter(Boolean),
        defaultEffort: m.defaultReasoningEffort ?? null,
        isDefault: !!m.isDefault,
      }));
      res.json({ models });
    } catch (e) { fail(res, e); }
  })(); });

  /* ---- threads of a project ---- */

  r.get('/projects/:project/agent/threads', (req, res) => {
    if (!needRole(req, res, 'edit')) return;
    const rows = db.prepare(`SELECT t.thread_id, t.title, t.user_id, t.created_at, t.updated_at, u.display_name AS name FROM agent_threads t
      LEFT JOIN users u ON u.id = t.user_id WHERE t.project = ? ORDER BY t.updated_at DESC LIMIT 100`).all(String(req.params.project)) as any[];
    res.json({ threads: rows.map(t => ({ id: t.thread_id, title: t.title, user: { id: t.user_id, name: t.name }, mine: t.user_id === req.user!.id, createdAt: t.created_at, updatedAt: t.updated_at })) });
  });

  r.post('/projects/:project/agent/threads', (req, res) => { void (async () => {
    if (!needRole(req, res, 'edit')) return;
    const project = String(req.params.project);
    try {
      const h = host(req.user!.id); await h.ensure();
      const out = await h.request('thread/start', {
        cwd: projectDir(project),
        approvalPolicy: 'on-request',
        // reads are free (the project is the cwd); every write goes through the MCP tools as a
        // tracked change — a direct filesystem write is a sandbox exception the user must grant
        sandbox: 'read-only',
        developerInstructions: NATIVE_INSTRUCTIONS(project),
        ...(config.agent.model ? { model: config.agent.model } : {}),
      });
      const tid = out.thread.id as string;
      db.prepare('INSERT OR REPLACE INTO agent_threads (thread_id, project, user_id, title, created_at, updated_at) VALUES (?,?,?,?,?,?)')
        .run(tid, project, req.user!.id, null, Date.now(), Date.now());
      h.markLoaded(tid, project);
      logAccess(project, req.user!.id, 'open', 'agent-thread');
      res.json({ id: tid, model: out.model ?? null });
    } catch (e) { fail(res, e); }
  })(); });

  r.get('/projects/:project/agent/threads/:tid', (req, res) => { void (async () => {
    if (!needRole(req, res, 'edit')) return;
    const row = threadRow(String(req.params.tid));
    if (!row || row.project !== String(req.params.project)) { res.status(404).json({ error: 'no such thread in this project' }); return; }
    try {
      const h = host(row.user_id); await h.ensure();       // transcripts are read through their owner's codex
      const out = await h.request('thread/read', { threadId: row.thread_id, includeTurns: true });
      const approvals = row.user_id === req.user!.id ? h.pendingApprovals(row.thread_id) : [];
      const checkpoints = isNativeThread(row.created_at) ? listCheckpoints(row.thread_id).map(publicCheckpoint) : [];
      res.json({ thread: out.thread, mine: row.user_id === req.user!.id, user: row.user_id, approvals, checkpoints });
    } catch (e) { fail(res, e); }
  })(); });

  r.post('/projects/:project/agent/threads/:tid/turn', (req, res) => { void (async () => {
    if (!needRole(req, res, 'edit')) return;
    const row = threadRow(String(req.params.tid));
    if (!row || row.project !== String(req.params.project)) { res.status(404).json({ error: 'no such thread in this project' }); return; }
    if (row.user_id !== req.user!.id) { res.status(403).json({ error: "Only the thread's creator can send messages in it (start your own thread)" }); return; }
    const text = String(req.body?.text ?? '').trim();
    if (!text) { res.status(400).json({ error: 'empty message' }); return; }
    try {
      const h = host(req.user!.id); await h.ensure();
      await h.ensureThreadLoaded(row.thread_id);
      const input = await composeInput(text, req.body?.context as TurnContext | undefined);
      const legacy = legacyThreadNote(row.created_at);
      if (legacy) input.unshift({ type: 'text', text: legacy, text_elements: [] });
      if (!row.title) db.prepare('UPDATE agent_threads SET title = ? WHERE thread_id = ?').run(text.slice(0, 100), row.thread_id);
      // per-turn model / reasoning-effort overrides from the panel's selectors (stick for later turns too)
      const model = typeof req.body?.model === 'string' && req.body.model ? String(req.body.model).slice(0, 80) : undefined;
      const effort = typeof req.body?.effort === 'string' && req.body.effort ? String(req.body.effort).slice(0, 20) : undefined;
      // the panel's optimistic message id: codex echoes it on the userMessage item, so the client can dedupe
      const cmid = typeof req.body?.clientMessageId === 'string' && req.body.clientMessageId ? String(req.body.clientMessageId).slice(0, 60) : undefined;
      // cwd: the thread's working copy, mirrored from the live project now (older threads: the
      // project's directory itself — a thread started before the project moved follows it)
      const native = isNativeThread(row.created_at);
      // the panel's Track changes box: off, the turn's document edits go in without tracked-change marks
      const tracked = req.body?.tracked !== false;
      const wasTracked = native ? workspaceTracking(row.thread_id) : panelTracking(req.user!.id, row.project);
      setPanelTracking(req.user!.id, row.project, tracked);
      const note = trackingNote(tracked, wasTracked);
      if (note) input.unshift({ type: 'text', text: note, text_elements: [] });
      const cwd = native ? await prepareWorkspace(row.thread_id, row.project, req.user!.id, tracked) : projectDir(row.project);
      const turn = h.request('turn/start', { threadId: row.thread_id, input, cwd, ...(native ? { sandboxPolicy: workspaceSandbox(cwd) } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(cmid ? { clientUserMessageId: cmid } : {}) }, 0);
      turn.catch(e => console.error(`[agent ${req.user!.id}] turn failed:`, (e as Error).message));
      // the turn runs long; its progress arrives over the events stream — answer as soon as it is accepted
      const quick = await Promise.race([turn.then(t => t), new Promise(r2 => setTimeout(r2, 5000, null))]);
      res.json({ ok: true, turn: quick ? (quick as any).turn ?? null : null });
    } catch (e) { fail(res, e); }
  })(); });

  /** Take back what a turn changed (its checkpoint): the documents as before it, edits made since kept. */
  r.post('/projects/:project/agent/threads/:tid/checkpoints/:n/undo', (req, res) => { void (async () => {
    if (!needRole(req, res, 'edit')) return;
    const row = threadRow(String(req.params.tid));
    if (!row || row.project !== String(req.params.project)) { res.status(404).json({ error: 'no such thread in this project' }); return; }
    if (row.user_id !== req.user!.id) { res.status(403).json({ error: "Only the thread's creator can undo its changes (reject them in the editor instead)" }); return; }
    try {
      const r2 = await undoCheckpoint(row.thread_id, row.project, Number(req.params.n), req.user!.id);
      res.json({ ok: true, checkpoint: publicCheckpoint(r2.checkpoint), reverted: r2.reverted, kept: r2.kept });
    } catch (e) {
      if (e instanceof UndoError) { res.status(409).json({ error: e.message }); return; }
      fail(res, e);
    }
  })(); });

  r.post('/projects/:project/agent/threads/:tid/approval', (req, res) => {
    if (!needRole(req, res, 'edit')) return;
    const row = threadRow(String(req.params.tid));
    if (!row || row.project !== String(req.params.project)) { res.status(404).json({ error: 'no such thread in this project' }); return; }
    if (row.user_id !== req.user!.id) { res.status(403).json({ error: "Only the thread's creator can decide approvals" }); return; }
    const decision = String(req.body?.decision ?? '');
    if (!['accept', 'acceptForSession', 'decline', 'cancel'].includes(decision)) { res.status(400).json({ error: 'bad decision' }); return; }
    const ok = host(row.user_id).respond(String(req.body?.requestId ?? ''), { decision });
    ok ? res.json({ ok: true }) : res.status(404).json({ error: 'this approval request is gone (answered or expired)' });
  });

  /** A message into the *running* turn (guidance with an approval, a course correction) — codex's turn/steer. */
  r.post('/projects/:project/agent/threads/:tid/steer', (req, res) => { void (async () => {
    if (!needRole(req, res, 'edit')) return;
    const row = threadRow(String(req.params.tid));
    if (!row || row.project !== String(req.params.project)) { res.status(404).json({ error: 'no such thread in this project' }); return; }
    if (row.user_id !== req.user!.id) { res.status(403).json({ error: "Only the thread's creator can steer it" }); return; }
    const text = String(req.body?.text ?? '').trim();
    if (!text) { res.status(400).json({ error: 'empty message' }); return; }
    try {
      const h = host(row.user_id); await h.ensure();
      const cmid = typeof req.body?.clientMessageId === 'string' && req.body.clientMessageId ? String(req.body.clientMessageId).slice(0, 60) : undefined;
      const input = await composeInput(text, req.body?.context as TurnContext | undefined);
      const legacy = legacyThreadNote(row.created_at);
      if (legacy) input.unshift({ type: 'text', text: legacy, text_elements: [] });
      await h.request('turn/steer', { threadId: row.thread_id, expectedTurnId: String(req.body?.turnId ?? ''), input, ...(cmid ? { clientUserMessageId: cmid } : {}) });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  })(); });

  r.post('/projects/:project/agent/threads/:tid/interrupt', (req, res) => { void (async () => {
    if (!needRole(req, res, 'edit')) return;
    const row = threadRow(String(req.params.tid));
    if (!row || row.project !== String(req.params.project)) { res.status(404).json({ error: 'no such thread in this project' }); return; }
    if (row.user_id !== req.user!.id) { res.status(403).json({ error: "Only the thread's creator can interrupt it" }); return; }
    try { await host(row.user_id).request('turn/interrupt', { threadId: row.thread_id, turnId: String(req.body?.turnId ?? '') }); res.json({ ok: true }); }
    catch (e) { fail(res, e); }
  })(); });

  /* ---- the events stream: codex's notifications + approval requests for this user & project ---- */

  r.get('/projects/:project/agent/events', (req, res) => {
    if (!needRole(req, res, 'edit')) return;
    const h = host(req.user!.id);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`data: ${JSON.stringify({ kind: 'status', running: h.running })}\n\n`);
    const sub: Subscriber = { project: String(req.params.project), res };
    h.subscribers.add(sub);
    const hb = setInterval(() => res.write(': hb\n\n'), 20000);
    req.on('close', () => { clearInterval(hb); h.subscribers.delete(sub); });
  });

  return r;
}
