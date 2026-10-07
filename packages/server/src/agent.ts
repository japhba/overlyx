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
 * What the agent can read (threadSandbox): its commands see the thread's working copy and the
 * system's files, nothing else on disk — no other project, of this user or anyone. The user's other
 * projects are reachable only through the overlyx MCP tools, and only while the thread's scope
 * (the panel's "Reads" choice: all my projects, the default, or this project only) allows it.
 *
 * The client talks to routes under /api (agentRoutes): a per-project SSE stream forwards codex's
 * notifications (message/reasoning deltas, command output, diffs, turn lifecycle) and its
 * requests to the user (allowing an MCP tool call, a question), which the client answers via POST;
 * requests to leave the sandbox are declined by the server (onServerRequest).
 *
 * The codex child is NOT our child: a detached keeper (scripts/agent-keeper.mjs) owns it and
 * bridges its stdio to a unix socket under the user's agent home. A server restart — a deploy —
 * disconnects and reconnects; the turn keeps running, buffered events are replayed, and
 * unanswered approval requests are re-delivered (the systemd unit needs KillMode=process).
 */
import express, { type Request, type Response } from 'express';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
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
  publicCheckpoint, undoCheckpoint, UndoError, setPanelTracking, panelTracking, workspaceTracking, scratchDir, type Checkpoint,
} from './agentwork.ts';
import type { AccessScope } from './tokenAuth.ts';
import { projectOfDoc, type PMJSON } from '@overlyx/core';
import type { SessionUser } from './auth.ts';

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
Your shell sees only this working copy, the system's files and a scratch HOME — no other project is on disk for you. The user's other projects are reachable through the overlyx MCP tools (list_projects, read_document, …) as long as the user lets you read them (the agent panel can limit you to this project); there is no way out of the sandbox, so don't ask for one.
The copy does not change under you during a turn, but the live document does — the user edits between and during your turns and your edits are merged in — so read a file afresh at the start of each turn instead of relying on what it said earlier.
Pending tracked changes appear in the source as \\lyxadded{author}{time}{text} and \\lyxdeleted{author}{time}{text}: text inside \\lyxdeleted is already deleted — don't restore it unless asked; edit around and inside these macros freely (you never need to write them yourself). Comment lines starting with %% are OverLyX bookkeeping (notes, settings) — leave them unless asked. Never run git: OverLyX versions every change.
The "overlyx" MCP server (project "${project}") has the comment threads (list_comments / add_comment / resolve_comment), build_pdf, which compiles the live document (your edits are already in it), and undo_turn. Do NOT recompile after every edit: when a turn has changed a .tex document, OverLyX builds it after the turn and shows the user whether the PDF still compiles — compile yourself only when asked, or once at the end of a larger or riskier change (new packages, macros, environments, tables). If build_pdf says your changes broke the build (it compares with the build before your changes), fix the error, or take the turn's changes back with undo_turn when you cannot fix it quickly — never end a turn leaving a document that no longer compiles. undo_turn with turns_back 1, 2, … takes back an earlier turn's changes exactly (the user's edits since are kept) — use it when the user asks you to roll back.
You have internet access through the web_search tool — use it for literature, references and facts (a shell command that needs the network still asks for approval).
By default the user is here to understand and explore their document and the literature around it — answering, explaining, finding and summarizing is the normal mode, and most turns should not touch any file. Editing happens every so often, only when the user explicitly asks for a change; when a request is ambiguous about whether to edit, explain first and offer the edit instead of making it.
Each user message may be preceded by a [context]…[/context] item the editor adds (the user did not write it): the document being edited, the other open documents, and the current selection — quoted, and marked ⟦SELECTION⟧…⟦/SELECTION⟧ in a file excerpt. Use it to resolve "this", "here" or an unqualified request.`;

/* ------------------------------------------------------------------ what a thread may read and write */

/** codex's permission profile for the panel's threads (threadSandbox; the managed config.toml holds a locked-down default of the same name) */
const PROFILE = 'overlyx';
/** Read-only besides codex's `:minimal` (/usr, /bin, /lib*, /etc): the TeX distribution's generated
 *  files and the font caches — what sandbox.ts binds for builds — so latexmk works in the copy. */
const SANDBOX_READ = ['/var/lib/texmf', '/var/cache/fontconfig', '/var/lib/ghostscript', '/opt'];
/** What `:minimal` shows of /etc that no command needs (commands run as root): password hashes,
 *  host keys, private certificates, the host's service and network configuration. */
const SANDBOX_DENY = [
  '/etc/shadow', '/etc/shadow-', '/etc/gshadow', '/etc/gshadow-', '/etc/sudoers', '/etc/sudoers.d', '/etc/security',
  '/etc/ssh', '/etc/ssl/private', '/etc/letsencrypt', '/etc/caddy', '/etc/credstore', '/etc/credstore.encrypted',
  '/etc/cloud', '/etc/netplan', '/etc/NetworkManager', '/etc/wireguard', '/etc/systemd', '/etc/crypttab', '/etc/krb5.keytab', '/etc/hetzner-build',
];
const exists = (p: string) => { try { fs.lstatSync(p); return true; } catch { return false; } };

/** The directory new threads start in: empty, and nothing the agent can write (their turns then move to the working copy). */
const startDir = () => { const d = path.join(config.dataDir, 'agent-start'); fs.mkdirSync(d, { recursive: true }); return d; };

/** The parts of the profile that hold for every thread — also the managed config's default, should a thread ever load without its own. */
function baseFilesystem(): Record<string, unknown> {
  const fsys: Record<string, unknown> = { ':minimal': 'read' };
  for (const p of SANDBOX_READ) if (exists(p)) fsys[p] = 'read';
  for (const p of SANDBOX_DENY) if (exists(p)) fsys[p] = 'deny';
  return fsys;
}

export interface ThreadSandbox { cwd: string; approvalPolicy: 'never'; config: Record<string, unknown> }

/**
 * Where a thread runs and what it may touch, given to codex at thread/start and thread/resume
 * (codex binds it to the loaded thread). Commands — and codex's own file tools, which go through
 * the same sandbox (view_image, apply_patch) — see the system's files (baseFilesystem), the turn's
 * working directory (`:project_roots`: the copy, writable; for threads from before the copies the
 * live project directory, read only), the live project read only (the copy's binary files are
 * symlinks into it; its .git hidden) and a scratch HOME/TMPDIR of the thread. Nothing else exists
 * in there: not the other projects (theirs are reached through the MCP tools, as far as
 * panelThreadScope allows), not OverLyX's data (the database, codex's sign-ins), no network.
 *
 * approvalPolicy 'never': codex offers no way out — an approved escalation would run the command
 * unsandboxed, as root (onServerRequest declines any that comes anyway). Every directory is marked
 * untrusted: codex trusts the directory a thread with a writable sandbox starts in, and a trusted
 * directory's .codex/config.toml — a project file any editor can write — would be loaded, its MCP
 * servers started unsandboxed. The header tells the MCP server which thread is calling.
 */
export function threadSandbox(t: { project: string; key: string; cwd: string; native: boolean }): ThreadSandbox {
  const live = projectDir(t.project), home = scratchDir(t.key), start = startDir();
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(t.cwd, { recursive: true });
  const fsys = baseFilesystem();
  fsys[start] = 'read';
  fsys[live] = 'read';
  if (exists(path.join(live, '.git'))) fsys[path.join(live, '.git')] = 'deny';
  fsys[home] = 'write';
  fsys[':project_roots'] = { '.': t.native ? 'write' : 'read' };
  const untrusted = Object.fromEntries([...new Set([t.cwd, start, live, home])].map(d => [d, { trust_level: 'untrusted' }]));
  return {
    cwd: t.cwd,
    approvalPolicy: 'never',
    config: {
      default_permissions: PROFILE,
      [`permissions.${PROFILE}`]: { filesystem: fsys, network: { enabled: false } },
      projects: untrusted,
      'shell_environment_policy.set': { HOME: home, TMPDIR: home },
      'mcp_servers.overlyx.http_headers': { 'X-OverLyX-Thread': t.key },
    },
  };
}

/** codex answered thread/start or thread/resume: the thread must run under threadSandbox's settings, else it is not used at all. */
function assertSandboxed(res: any, tid: string): void {
  if (res?.approvalPolicy !== 'never' || res?.activePermissionProfile?.id !== PROFILE) {
    throw new Error(`the agent's sandbox did not take effect for thread ${tid} (approval ${JSON.stringify(res?.approvalPolicy)}, profile ${JSON.stringify(res?.activePermissionProfile?.id ?? null)}) — not running it`);
  }
}

/** A thread's MCP key (the X-OverLyX-Thread header); threads from before the keys get one now. */
function threadKey(tid: string): string {
  const row = db.prepare('SELECT mcp_key FROM agent_threads WHERE thread_id = ?').get(tid) as { mcp_key: string | null } | undefined;
  if (row?.mcp_key) return row.mcp_key;
  const key = crypto.randomBytes(18).toString('base64url');
  db.prepare('UPDATE agent_threads SET mcp_key = ? WHERE thread_id = ?').run(key, tid);
  return key;
}

/** The panel's "Reads" choice for a thread: 'project' (only its own project) or 'all' (every project its user can open — the default). */
export type ThreadScope = 'all' | 'project';
const scopeOf = (v: unknown): ThreadScope => (v === 'project' ? 'project' : 'all');

/**
 * What the Agent panel's agent reaches through the MCP tools in the thread behind `key` (its
 * X-OverLyX-Thread header; mcp.ts): its own project only, or the user's projects (null: as the
 * account — projects shared with them included). An unknown thread reaches nothing.
 */
export function panelThreadScope(userId: number, key: string | undefined): AccessScope | null {
  const row = key ? db.prepare('SELECT project, scope FROM agent_threads WHERE mcp_key = ? AND user_id = ?').get(key, userId) as { project: string; scope: string | null } | undefined : undefined;
  if (!row) return { projects: [], readonly: true, panel: true };
  return scopeOf(row.scope) === 'project' ? { projects: [row.project], readonly: false, panel: true } : null;
}

/** The scope each thread's agent was last told about (scopeNote) — kept in memory, a restart just tells it again. */
const scopeTold = new Map<string, ThreadScope>();

/** A note in front of a turn's message when the thread is limited to its project, or no longer is. */
function scopeNote(tid: string, project: string, scope: ThreadScope): string | null {
  const told = scopeTold.get(tid);
  scopeTold.set(tid, scope);
  if (scope === 'project') return `[context] Note from the OverLyX editor (the user did not write this): the user limited you to this project ("${project}") in the agent panel — the overlyx MCP tools reach no other project now; don't try, and say so if a request needs another project. [/context]`;
  if (told === 'project') return '[context] Note from the OverLyX editor (the user did not write this): the user let you read all their projects again — the overlyx MCP tools (list_projects) reach them. [/context]';
  return null;
}

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
 * cannot reach an existing thread). They used to fall back to editing the .tex directly with
 * hand-written tracked-change markup; their files are read only now (threadSandbox), so the note
 * says to start a new thread instead. Wrapped as [context]…[/context] so the panel strips it from
 * the echoed user message (AgentPanel CONTEXT_RE is global).
 */
export const MCP_TOOLS_SINCE = Date.parse('2026-09-01T22:02:00Z');
export function legacyThreadNote(createdAt: number): string | null {
  if (createdAt >= MCP_TOOLS_SINCE) return null;
  return '[context] Note from the OverLyX editor (the user did not write this): this conversation was started before the "overlyx" document tools existed, so those MCP tools may be missing here — a NEW thread would have them. If they are missing and the user asks for a document change, this conversation cannot make it (its files are read only): say so and suggest starting a new thread. [/context]';
}

/** codex's config.toml for every account's agent home — OverLyX owns it and rewrites it on every start (AgentHost.ensureHome). */
export function managedCodexConfig(): string {
  const base = Object.entries(baseFilesystem()).map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`).join('\n');
  return `# OverLyX-managed codex configuration for this account

# Every thread gets its own sandbox at thread/start and thread/resume (agent.ts threadSandbox): its
# working copy and the system's files, nothing else. The profile below is the fallback — system
# files only, no writes — should a thread ever load without it.
default_permissions = "${PROFILE}"
# A thread's directory is its project root: no walking up to a repository around the data
# directory, whose .codex/config.toml and AGENTS.md are not the agent's business.
project_root_markers = []

[permissions.${PROFILE}.filesystem]
${base}

[permissions.${PROFILE}.network]
enabled = false

# Commands get neither the MCP credential nor the location of codex's home (its sign-in).
[shell_environment_policy]
exclude = ["OVERLYX_MCP_TOKEN", "CODEX_HOME"]

[features]
memories = true
web_search_request = true
# Sub-agents take image paths in their input and read those files outside the sandbox.
multi_agent = false

# The agent may search the web (codex's own web_search tool — it runs outside the filesystem
# sandbox, so the read-only sandbox does not block it).
[tools]
web_search = true

# OverLyX's own MCP connector: tracked-change document edits, comments, builds — the account's
# projects on one connection (tools take a \`project\` argument), as far as the calling thread's
# scope allows (each thread adds its X-OverLyX-Thread header). The bearer token arrives via the
# environment at codex start.
[mcp_servers.overlyx]
url = "http://127.0.0.1:${config.port}/mcp"
bearer_token_env_var = "OVERLYX_MCP_TOKEN"
# The tools already apply document edits as tracked changes the user reviews in the editor, so
# codex must not gate them behind its own approval prompt. That prompt arrives as an MCP
# elicitation; the panel used to have no card for it and every write tool came back
# "user rejected MCP tool call".
default_tools_approval_mode = "approve"
`;
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
    const text = managedCodexConfig();
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

  /** codex asks the client something: an MCP tool call to allow or a question for the user — forward to the panel. */
  private onServerRequest(msg: JsonRpcMsg): void {
    const method = msg.method!;
    // A command, file-change or permission approval can only ask to leave the thread's sandbox
    // (threadSandbox; approvalPolicy 'never' should mean none arrives): accepted, it would run as
    // root outside the thread's scope. Declined here, never shown.
    const refusal = sandboxRefusal(method);
    if (refusal) {
      console.warn(`[agent ${this.userId}] declined ${method} — the agent stays in its sandbox`);
      this.send({ jsonrpc: '2.0', id: msg.id, result: refusal });
      return;
    }
    // Forwarded to the panel as cards: MCP elicitations — codex asks the user to allow an MCP tool
    // call this way (the question in params.message, tool arguments under params._meta) — and the
    // agent's questions to the user. Anything else is unsupported.
    if (!/requestUserInput|mcpServer\/elicitation/.test(method)) {
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

  /** Load a thread into codex (after a codex restart) — under its sandbox, which codex binds at load; `cwd`: where its turns run. */
  async ensureThreadLoaded(row: ThreadRow, cwd: string): Promise<void> {
    if (this.loaded.has(row.thread_id)) return;
    const box = threadSandbox({ project: row.project, key: threadKey(row.thread_id), cwd, native: isNativeThread(row.created_at) });
    const res = await this.request('thread/resume', { threadId: row.thread_id, cwd: box.cwd, approvalPolicy: box.approvalPolicy, config: box.config });
    assertSandboxed(res, row.thread_id);
    this.loaded.add(row.thread_id);
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

/** The answer that turns down an approval request of `method` — null for requests that are not about leaving the sandbox. */
function sandboxRefusal(method: string): object | null {
  if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') return { decision: 'decline' };
  if (method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' };
  if (method === 'applyPatchApproval' || method === 'execCommandApproval') return { decision: { denied: { rejection: 'The OverLyX agent cannot leave its sandbox.' } } };
  return /requestApproval/.test(method) ? { decision: 'decline' } : null;
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

/**
 * Where the user is, as lines of text for an agent: the document being edited, the other open
 * documents, and what they selected — quoted as LaTeX, and marked in an excerpt of the live file.
 * Empty without a document. Only documents `user` may view are read (the ids come from the client).
 * Used for the Agent panel's turns and for messages to an agent connected from elsewhere (mcpAgents.ts).
 */
export async function editorContextLines(ctx: TurnContext | undefined, user: SessionUser, who = 'The user'): Promise<string[]> {
  if (!ctx?.docId || typeof ctx.docId !== 'string') return [];
  if (!atLeast(roleFor(user, projectOfDoc(ctx.docId)), 'view')) return [];
  const lines = [`${who} is editing ${ctx.docId} in OverLyX.`];
  const others = [...new Set(Array.isArray(ctx.openDocs) ? ctx.openDocs : [])].filter(d => typeof d === 'string' && d !== ctx.docId && atLeast(roleFor(user, projectOfDoc(d)), 'view')).slice(0, 8);
  if (others.length) lines.push(`Also open in their workspace: ${others.join(', ')}.`);
  let sel = '';
  try {
    if (Array.isArray(ctx.content) && ctx.content.length) {
      const doc = await manager.open(ctx.docId);
      sel = selectionToTex(doc, ctx.content, ctx.layout ?? 'Standard').trim();
      if (sel) lines.push('Their current selection in that document:', '```latex', sel.slice(0, 6000), '```');
    }
  } catch { /* selection context is best-effort */ }
  if (!sel && typeof ctx.mathLatex === 'string' && ctx.mathLatex.trim()) {
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
  return lines;
}

/** The input sent to the agent: a context item (editorContextLines; the client hides items
 *  starting with "[context]") followed by the user's message. A thread limited to its project
 *  hears nothing of documents elsewhere (open in other tabs, say). */
async function composeInput(text: string, ctx: TurnContext | undefined, user: SessionUser, onlyProject?: string): Promise<{ type: 'text'; text: string; text_elements: never[] }[]> {
  const item = (t: string) => ({ type: 'text' as const, text: t, text_elements: [] as never[] });
  if (ctx && onlyProject) {
    const here = (d: unknown) => typeof d === 'string' && projectOfDoc(d) === onlyProject;
    ctx = here(ctx.docId) ? { ...ctx, openDocs: (Array.isArray(ctx.openDocs) ? ctx.openDocs : []).filter(here) } : undefined;
  }
  const lines = await editorContextLines(ctx, user);
  if (!lines.length) return [item(text)];
  lines[0] = '[context] ' + lines[0];
  // codex concatenates input items into one string when it echoes/stores the user message, so the
  // context block carries an explicit terminator the client can strip it by (AgentPanel userText)
  return [item(lines.join('\n') + '\n[/context]'), item(text)];
}

/* ------------------------------------------------------------------ routes */

interface ThreadRow { thread_id: string; project: string; user_id: number; title: string | null; created_at: number; updated_at: number; scope: string | null; mcp_key: string | null }
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
    const scope = scopeOf(req.body?.scope);
    try {
      const h = host(req.user!.id); await h.ensure();
      // the thread starts in an empty directory under its sandbox (its first turn moves it into
      // the working copy, which exists only once codex has named the thread)
      const key = crypto.randomBytes(18).toString('base64url');
      const box = threadSandbox({ project, key, cwd: startDir(), native: true });
      const out = await h.request('thread/start', {
        cwd: box.cwd,
        approvalPolicy: box.approvalPolicy,
        config: box.config,
        developerInstructions: NATIVE_INSTRUCTIONS(project),
        ...(config.agent.model ? { model: config.agent.model } : {}),
      });
      const tid = out.thread.id as string;
      assertSandboxed(out, tid);
      db.prepare('INSERT OR REPLACE INTO agent_threads (thread_id, project, user_id, title, created_at, updated_at, scope, mcp_key) VALUES (?,?,?,?,?,?,?,?)')
        .run(tid, project, req.user!.id, null, Date.now(), Date.now(), scope === 'project' ? 'project' : null, key);
      h.markLoaded(tid, project);
      logAccess(project, req.user!.id, 'open', 'agent-thread');
      res.json({ id: tid, model: out.model ?? null, scope });
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
      res.json({ thread: out.thread, mine: row.user_id === req.user!.id, user: row.user_id, approvals, checkpoints, scope: scopeOf(row.scope) });
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
      // the panel's Reads choice, sent with every message: it holds for this turn on
      const scope = req.body?.scope === undefined ? scopeOf(row.scope) : scopeOf(req.body.scope);
      if (scope !== scopeOf(row.scope)) db.prepare('UPDATE agent_threads SET scope = ? WHERE thread_id = ?').run(scope === 'project' ? 'project' : null, row.thread_id);
      // cwd: the thread's working copy, mirrored from the live project now (older threads: the
      // project's directory itself — a thread started before the project moved follows it)
      const native = isNativeThread(row.created_at);
      // the panel's Track changes box: off, the turn's document edits go in without tracked-change marks
      const tracked = req.body?.tracked !== false;
      const wasTracked = native ? workspaceTracking(row.thread_id) : panelTracking(req.user!.id, row.project);
      setPanelTracking(req.user!.id, row.project, tracked);
      const cwd = native ? await prepareWorkspace(row.thread_id, row.project, req.user!.id, tracked) : projectDir(row.project);
      await h.ensureThreadLoaded(row, cwd);
      const input = await composeInput(text, req.body?.context as TurnContext | undefined, req.user!, scope === 'project' ? row.project : undefined);
      const legacy = legacyThreadNote(row.created_at);
      if (legacy) input.unshift({ type: 'text', text: legacy, text_elements: [] });
      if (!row.title) db.prepare('UPDATE agent_threads SET title = ? WHERE thread_id = ?').run(text.slice(0, 100), row.thread_id);
      // per-turn model / reasoning-effort overrides from the panel's selectors (stick for later turns too)
      const model = typeof req.body?.model === 'string' && req.body.model ? String(req.body.model).slice(0, 80) : undefined;
      const effort = typeof req.body?.effort === 'string' && req.body.effort ? String(req.body.effort).slice(0, 20) : undefined;
      // the panel's optimistic message id: codex echoes it on the userMessage item, so the client can dedupe
      const cmid = typeof req.body?.clientMessageId === 'string' && req.body.clientMessageId ? String(req.body.clientMessageId).slice(0, 60) : undefined;
      for (const note of [trackingNote(tracked, wasTracked), scopeNote(row.thread_id, row.project, scope)]) if (note) input.unshift({ type: 'text', text: note, text_elements: [] });
      // the sandbox stays the one the thread was loaded with (threadSandbox): its working directory
      // is the turn's cwd, and no turn may bring an approval policy that lets it out
      const turn = h.request('turn/start', { threadId: row.thread_id, input, cwd, approvalPolicy: 'never', ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(cmid ? { clientUserMessageId: cmid } : {}) }, 0);
      turn.catch(e => console.error(`[agent ${req.user!.id}] turn failed:`, (e as Error).message));
      // the turn runs long; its progress arrives over the events stream — answer as soon as it is accepted
      const quick = await Promise.race([turn.then(t => t), new Promise(r2 => setTimeout(r2, 5000, null))]);
      res.json({ ok: true, turn: quick ? (quick as any).turn ?? null : null });
    } catch (e) { fail(res, e); }
  })(); });

  /** The panel's Reads choice for a thread: 'project' (only its own project) or 'all' — effective with the agent's next MCP call. */
  r.post('/projects/:project/agent/threads/:tid/scope', (req, res) => {
    if (!needRole(req, res, 'edit')) return;
    const row = threadRow(String(req.params.tid));
    if (!row || row.project !== String(req.params.project)) { res.status(404).json({ error: 'no such thread in this project' }); return; }
    if (row.user_id !== req.user!.id) { res.status(403).json({ error: "Only the thread's creator can change what its agent reads" }); return; }
    const scope = scopeOf(req.body?.scope);
    db.prepare('UPDATE agent_threads SET scope = ? WHERE thread_id = ?').run(scope === 'project' ? 'project' : null, row.thread_id);
    res.json({ ok: true, scope });
  });

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
      const input = await composeInput(text, req.body?.context as TurnContext | undefined, req.user!, scopeOf(row.scope) === 'project' ? row.project : undefined);
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
