/**
 * Agents connected over MCP from elsewhere — Claude Code or Codex on the user's machine, ChatGPT —
 * as OverLyX knows them, and the conversation their owner has with them from inside OverLyX.
 *
 * An agent is one MCP client behind one credential: (token kind, token id, clientInfo.name from the
 * initialize request) → one mcp_agents row. Two sessions of the same client with the same token are
 * the same agent (one conversation; a message goes to whichever is listening). Calls that do not
 * say who they are — stateless clients send clientInfo only once, at initialize — belong to the
 * token's agent that initialized statelessly last.
 *
 * The owner sends an agent instructions from the Agent panel (POST /api/mcp-agents/:id/messages).
 * Only the account the agent's token belongs to may: an agent runs commands on somebody's machine,
 * so collaborators and link guests of a shared project must never reach it. A message carries
 * where the owner is (editorContextLines: the document, the selection as LaTeX, marked in an
 * excerpt) and reaches the agent one of two ways:
 *  - polled: the agent calls the MCP tool wait_for_instructions, a long poll that returns as soon
 *    as a message arrives (or empty after a timeout well below the clients' tool timeouts), works
 *    on it, answers with reply, and polls again — any MCP client can do this;
 *  - pushed: a client that keeps a session with a GET event stream (Claude Code) gets it as a
 *    `notifications/claude/channel` event — Claude Code's "channels", which inject the message
 *    into the running session when started with --dangerously-load-development-channels
 *    server:<name>. Claude Code drops channel events silently when the flag is missing, so a push
 *    counts as delivered only once that session has answered a pushed message (mcp_sessions
 *    .channel_ok); until then the message also stays available to wait_for_instructions.
 * The agent's replies (reply tool) and every state change reach the owner's browser over an SSE
 * stream (GET /api/mcp-agents/events). Sizes are capped and both directions are rate-limited.
 */
import express, { type Request, type Response } from 'express';
import { db } from './db.ts';
import type { SessionUser } from './auth.ts';
import { originAllowed } from './ws.ts';
import { editorContextLines, type TurnContext } from './agent.ts';

export interface ClientInfo { name: string; title?: string; version?: string }
export interface TokenIdentity { kind: 'personal' | 'agent'; id: number; userId: number; name: string }

export interface AgentRow {
  id: number; user_id: number; token_kind: string; token_id: number; client_name: string; client_title: string | null; client_version: string | null;
  created_at: number; last_seen_at: number; last_project: string | null; last_path: string | null; last_tool: string | null; active_at: number | null; stateless_at: number | null;
}
export interface MessageRow {
  id: number; agent_id: number; user_id: number;
  /** 'user': from the owner, in OverLyX, to the agent; 'agent': the agent's reply */
  role: 'user' | 'agent';
  text: string;
  /** JSON { docId, text }: where the owner was when sending (role 'user') */
  context: string | null;
  reply_to: number | null;
  /** user: queued → delivered → answered (or cancelled); agent: final | progress */
  state: string;
  /** how a user message reached the agent: 'poll' | 'push' */
  via: string | null;
  created_at: number; delivered_at: number | null; pushed_at: number | null;
}

/** the longest message the owner can send, and the longest reply */
export const MESSAGE_MAX = 8000;
export const REPLY_MAX = 20000;
/** messages waiting for an agent at most */
const QUEUE_MAX = 25;
/** what one wait_for_instructions call hands out at most */
const BATCH_MAX = 10;
/** messages kept per agent */
const KEEP_MESSAGES = 500;

/** Display names of the MCP clients people use (clientInfo.name → name). */
const CLIENT_TITLES: Record<string, string> = {
  'claude-code': 'Claude Code', 'claude-ai': 'Claude', 'codex-mcp-client': 'Codex', codex: 'Codex', 'openai-mcp': 'ChatGPT',
  'cursor-vscode': 'Cursor', 'gemini-cli-mcp-client': 'Gemini CLI', 'mcp-remote': 'MCP client',
};
const AGENT_COLORS = ['#c2410c', '#0f766e', '#7c3aed', '#be185d', '#1d4ed8', '#4d7c0f', '#a16207', '#0e7490'];

/** MCP clients that get a session (a GET event stream for pushed messages); everybody else stays stateless. */
const SESSION_CLIENTS = new Set(['claude-code']);
export const wantsSession = (client: ClientInfo | null): boolean => !!client && SESSION_CLIENTS.has(client.name);

const tokenLabel = (row: Pick<AgentRow, 'token_kind'>) => (row.token_kind === 'personal' ? 'account token' : 'connector credential');
export const agentTitle = (row: Pick<AgentRow, 'client_name' | 'client_title'>, fallback = 'Agent'): string =>
  CLIENT_TITLES[row.client_name] ?? (row.client_title?.trim() || row.client_name || fallback);
/** "Claude Code (Jan)": how the agent appears to people — as a collaborator and in the Agent panel. */
export function agentLabel(row: AgentRow): string {
  const owner = (db.prepare('SELECT display_name AS name FROM users WHERE id = ?').get(row.user_id) as { name: string } | undefined)?.name ?? '';
  const first = owner.trim().split(/\s+/)[0];
  return first ? `${agentTitle(row)} (${first})` : agentTitle(row);
}
export const agentColor = (row: Pick<AgentRow, 'id'>): string => AGENT_COLORS[row.id % AGENT_COLORS.length];
export const agentRow = (id: number): AgentRow | undefined => db.prepare('SELECT * FROM mcp_agents WHERE id = ?').get(id) as AgentRow | undefined;

/**
 * The agent behind a request: the row for (token, client) — created on first contact — when the
 * client said who it is (initialize, or its session knows), else the token's agent that initialized
 * statelessly last (any of its agents, else a new one named after the token).
 */
export function agentFor(ident: TokenIdentity, client: ClientInfo | null, opts: { stateless?: boolean } = {}): AgentRow {
  const now = Date.now();
  if (client) {
    const name = client.name.trim().slice(0, 80) || 'mcp-client';
    // a new token for a client the account used before with a token that is gone (rotated, revoked):
    // the same agent — its conversation carries over instead of a dead twin staying in the list
    if (!db.prepare('SELECT 1 FROM mcp_agents WHERE token_kind = ? AND token_id = ? AND client_name = ?').get(ident.kind, ident.id, name)) {
      const orphan = (db.prepare('SELECT * FROM mcp_agents WHERE user_id = ? AND client_name = ? ORDER BY last_seen_at DESC').all(ident.userId, name) as AgentRow[]).find(r => !tokenAlive(r));
      if (orphan) db.prepare('UPDATE mcp_agents SET token_kind = ?, token_id = ? WHERE id = ?').run(ident.kind, ident.id, orphan.id);
    }
    db.prepare(`INSERT INTO mcp_agents (user_id, token_kind, token_id, client_name, client_title, client_version, created_at, last_seen_at, stateless_at) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(token_kind, token_id, client_name) DO UPDATE SET client_title = excluded.client_title, client_version = excluded.client_version, last_seen_at = excluded.last_seen_at, stateless_at = COALESCE(excluded.stateless_at, stateless_at)`)
      .run(ident.userId, ident.kind, ident.id, name, client.title?.slice(0, 80) ?? null, client.version?.slice(0, 40) ?? null, now, now, opts.stateless ? now : null);
    scheduleAgentsEvent(ident.userId);
    return db.prepare('SELECT * FROM mcp_agents WHERE token_kind = ? AND token_id = ? AND client_name = ?').get(ident.kind, ident.id, name) as AgentRow;
  }
  // a client that never said who it is: named after its credential (an old named agent token), or generically
  return knownAgent(ident) ?? agentFor(ident, { name: '', title: ident.kind === 'personal' ? 'MCP client' : ident.name }, opts);
}

/** The token's agent that initialized statelessly last (any of its agents), without creating one. */
export function knownAgent(ident: TokenIdentity): AgentRow | null {
  return (db.prepare('SELECT * FROM mcp_agents WHERE token_kind = ? AND token_id = ? ORDER BY stateless_at IS NULL, stateless_at DESC, last_seen_at DESC LIMIT 1').get(ident.kind, ident.id) as AgentRow | undefined) ?? null;
}

/** The agent's credential still exists (a rotated or revoked one does not). */
const tokenAlive = (row: Pick<AgentRow, 'token_kind' | 'token_id'>): boolean =>
  !!db.prepare(`SELECT 1 FROM ${row.token_kind === 'personal' ? 'git_tokens' : 'mcp_tokens'} WHERE id = ?`).get(row.token_id);

/** A tool call of the agent: when it was last seen, and where (the panel lists it). */
export function noteToolCall(agentId: number, tool: string, project: string | null, path: string | null): void {
  const now = Date.now();
  const listening = tool === 'wait_for_instructions' || tool === 'reply';
  db.prepare(`UPDATE mcp_agents SET last_seen_at = ?, last_tool = ?, last_project = COALESCE(?, last_project), last_path = CASE WHEN ? IS NULL THEN last_path ELSE ? END${listening ? '' : ', active_at = ?'} WHERE id = ?`)
    .run(now, tool, project, project, path, ...(listening ? [] : [now]), agentId);
  const row = agentRow(agentId);
  if (row) scheduleAgentsEvent(row.user_id);
}

/* ------------------------------------------------------------------ sessions */

export interface SessionRow { id: string; agent_id: number; token_kind: string; token_id: number; project: string | null; channel_ok: number; created_at: number; last_seen_at: number }

/** A new session (`project`: the connection is fixed to it, /mcp/<owner>/<name>). */
export function recordSession(id: string, agent: AgentRow, project: string | null): void {
  const now = Date.now();
  db.prepare('INSERT OR REPLACE INTO mcp_sessions (id, agent_id, token_kind, token_id, project, channel_ok, created_at, last_seen_at) VALUES (?,?,?,?,?,0,?,?)').run(id, agent.id, agent.token_kind, agent.token_id, project, now, now);
}
export const sessionRow = (id: string): SessionRow | undefined => db.prepare('SELECT * FROM mcp_sessions WHERE id = ?').get(id) as SessionRow | undefined;
export function touchSession(id: string): void { db.prepare('UPDATE mcp_sessions SET last_seen_at = ? WHERE id = ?').run(Date.now(), id); }
export function dropSession(id: string): void { db.prepare('DELETE FROM mcp_sessions WHERE id = ?').run(id); pushers.delete(id); }

/** A live session that can push to its client: its GET stream, if open, carries notifications. */
export interface Pusher {
  sessionId: string;
  agentId: number;
  /** a GET event stream is open right now */
  streamOpen(): boolean;
  /** send a notifications/claude/channel event */
  push(params: { content: string; meta: Record<string, string> }): Promise<void>;
}
const pushers = new Map<string, Pusher>();
export function registerPusher(p: Pusher): void { pushers.set(p.sessionId, p); }
export function unregisterPusher(sessionId: string): void { pushers.delete(sessionId); }
/** A session's GET stream opened or closed: messages waiting go out, the panel learns the state. */
export function streamChanged(sessionId: string): void {
  const p = pushers.get(sessionId);
  if (!p) return;
  const row = agentRow(p.agentId);
  if (row) scheduleAgentsEvent(row.user_id);
  if (p.streamOpen()) void deliver(p.agentId);
}

/* ------------------------------------------------------------------ messages */

const msgRow = (id: number): MessageRow | undefined => db.prepare('SELECT * FROM mcp_agent_messages WHERE id = ?').get(id) as MessageRow | undefined;

export interface PublicMessage { id: number; role: 'user' | 'agent'; text: string; state: string; via: string | null; replyTo: number | null; createdAt: number; deliveredAt: number | null; pushedAt: number | null; context: { docId: string; text: string } | null }
export function publicMessage(m: MessageRow): PublicMessage {
  let context: PublicMessage['context'] = null;
  try { context = m.context ? JSON.parse(m.context) : null; } catch { /* none */ }
  return { id: m.id, role: m.role, text: m.text, state: m.state, via: m.via, replyTo: m.reply_to, createdAt: m.created_at, deliveredAt: m.delivered_at, pushedAt: m.pushed_at, context };
}

/** What the agent gets for one message (wait_for_instructions, and the body of a pushed event). */
export function forAgent(m: MessageRow): { message_id: number; from: string; sent_at: string; text: string; context?: string } {
  const owner = (db.prepare('SELECT display_name AS name FROM users WHERE id = ?').get(m.user_id) as { name: string } | undefined)?.name ?? 'the account owner';
  let context: string | undefined;
  try { const c = m.context ? JSON.parse(m.context) as { text?: string } : null; if (c?.text) context = c.text; } catch { /* none */ }
  return { message_id: m.id, from: `${owner} (the owner of your token), in OverLyX`, sent_at: new Date(m.created_at).toISOString(), text: m.text, ...(context ? { context } : {}) };
}

/** Throttle: `limit` events per `ms` per key. */
function limiter(limit: number, ms: number) {
  const hits = new Map<string | number, number[]>();
  return (key: string | number): boolean => {
    const now = Date.now();
    const list = (hits.get(key) ?? []).filter(t => now - t < ms);
    if (list.length >= limit) { hits.set(key, list); return false; }
    list.push(now); hits.set(key, list);
    if (hits.size > 10_000) hits.clear();
    return true;
  };
}
const sendLimit = limiter(20, 60_000);
const replyLimit = limiter(40, 60_000);

export class AgentMessageError extends Error { constructor(message: string, public status = 400) { super(message); } }

/** The owner's message to their agent, from the Agent panel: stored, then handed to a waiting poll or pushed. */
export async function sendInstruction(user: SessionUser, agentId: number, text: string, ctx: TurnContext | undefined): Promise<MessageRow> {
  const agent = agentRow(agentId);
  // only the account the agent's token belongs to — never a collaborator, never a link guest
  if (!agent || agent.user_id !== user.id || user.guest) throw new AgentMessageError('no such agent', 404);
  const body = text.trim();
  if (!body) throw new AgentMessageError('empty message');
  if (body.length > MESSAGE_MAX) throw new AgentMessageError(`message too long (at most ${MESSAGE_MAX} characters)`, 413);
  if (!sendLimit(user.id)) throw new AgentMessageError('too many messages — wait a minute', 429);
  const queued = (db.prepare("SELECT COUNT(*) AS n FROM mcp_agent_messages WHERE agent_id = ? AND role = 'user' AND state = 'queued'").get(agentId) as { n: number }).n;
  if (queued >= QUEUE_MAX) throw new AgentMessageError(`${QUEUE_MAX} messages are already waiting for this agent — it is not picking them up`, 429);
  const lines = await editorContextLines(ctx, user, user.name || 'The user');
  const context = lines.length ? JSON.stringify({ docId: ctx!.docId, text: lines.join('\n') }) : null;
  const id = Number(db.prepare("INSERT INTO mcp_agent_messages (agent_id, user_id, role, text, context, state, created_at) VALUES (?,?, 'user', ?,?, 'queued', ?)").run(agentId, user.id, body, context, Date.now()).lastInsertRowid);
  db.prepare("DELETE FROM mcp_agent_messages WHERE agent_id = ? AND id NOT IN (SELECT id FROM mcp_agent_messages WHERE agent_id = ? ORDER BY id DESC LIMIT ?)").run(agentId, agentId, KEEP_MESSAGES);
  const m = msgRow(id)!;
  emit(user.id, { kind: 'message', agentId, message: publicMessage(m) });
  await deliver(agentId);
  return msgRow(id)!;
}

/** Take a message back that has not reached the agent yet. */
export function cancelInstruction(user: SessionUser, agentId: number, messageId: number): MessageRow {
  const m = msgRow(messageId);
  if (!m || m.agent_id !== agentId || m.user_id !== user.id || m.role !== 'user') throw new AgentMessageError('no such message', 404);
  if (m.state !== 'queued') throw new AgentMessageError('the agent already has this message', 409);
  db.prepare("UPDATE mcp_agent_messages SET state = 'cancelled' WHERE id = ?").run(messageId);
  const out = msgRow(messageId)!;
  emit(user.id, { kind: 'message', agentId, message: publicMessage(out) });
  scheduleAgentsEvent(user.id);
  return out;
}

/** The agent's answer (reply tool): to one of its messages (default: the last one it got and has not answered), or on its own. */
export function replyFromAgent(agentId: number, sessionId: string | null, text: string, replyTo: number | null, done: boolean): { message: MessageRow; answered: MessageRow | null } {
  const agent = agentRow(agentId);
  if (!agent) throw new AgentMessageError('unknown agent');
  const body = text.trim();
  if (!body) throw new AgentMessageError('empty reply');
  if (body.length > REPLY_MAX) throw new AgentMessageError(`reply too long (at most ${REPLY_MAX} characters) — shorten it, or send it in parts`);
  if (!replyLimit(agentId)) throw new AgentMessageError('too many replies in a minute — wait a little');
  let target: MessageRow | undefined;
  if (replyTo !== null) {
    target = msgRow(replyTo);
    if (!target || target.agent_id !== agentId || target.role !== 'user') throw new AgentMessageError(`no message ${replyTo} for you — message_id comes from wait_for_instructions or the channel event`);
  } else {
    target = db.prepare("SELECT * FROM mcp_agent_messages WHERE agent_id = ? AND role = 'user' AND state = 'delivered' ORDER BY id DESC LIMIT 1").get(agentId) as MessageRow | undefined;
  }
  const now = Date.now();
  if (target) {
    // answering a message it was never handed by a poll: it came through the push — that session's channel works
    if (target.state === 'queued' && target.pushed_at) {
      db.prepare("UPDATE mcp_agent_messages SET state = 'delivered', via = 'push', delivered_at = ? WHERE id = ?").run(now, target.id);
      if (sessionId) db.prepare('UPDATE mcp_sessions SET channel_ok = 1 WHERE id = ?').run(sessionId);
    }
    if (done && target.state !== 'cancelled') db.prepare("UPDATE mcp_agent_messages SET state = 'answered' WHERE id = ?").run(target.id);
  }
  const id = Number(db.prepare("INSERT INTO mcp_agent_messages (agent_id, user_id, role, text, reply_to, state, created_at) VALUES (?,?, 'agent', ?,?,?,?)").run(agentId, agent.user_id, body, target?.id ?? null, done ? 'final' : 'progress', now).lastInsertRowid);
  const message = msgRow(id)!;
  const answered = target ? msgRow(target.id)! : null;
  if (answered) emit(agent.user_id, { kind: 'message', agentId, message: publicMessage(answered) });
  emit(agent.user_id, { kind: 'message', agentId, message: publicMessage(message) });
  scheduleAgentsEvent(agent.user_id);
  return { message, answered };
}

/* ------------------------------------------------------------------ delivery */

interface Waiter { give(rows: MessageRow[]): void }
const waiters = new Map<number, Waiter[]>();
const lastPollEnd = new Map<number, number>();

/**
 * Messages for a poll, marked delivered: the queued ones, and ones a poll handed out that the agent
 * has done nothing about since (no tool call after it) — that answer was most likely lost on the way.
 */
function takeForPoll(agentId: number): MessageRow[] {
  const agent = agentRow(agentId);
  const rows = db.prepare(`SELECT * FROM mcp_agent_messages WHERE agent_id = ? AND role = 'user' AND (state = 'queued' OR (state = 'delivered' AND via = 'poll' AND delivered_at > ?)) ORDER BY id LIMIT ?`)
    .all(agentId, agent?.active_at ?? 0, BATCH_MAX) as MessageRow[];
  if (!rows.length) return [];
  const now = Date.now();
  const mark = db.prepare("UPDATE mcp_agent_messages SET state = 'delivered', via = 'poll', delivered_at = ? WHERE id = ?");
  for (const r of rows) mark.run(now, r.id);
  const out = rows.map(r => msgRow(r.id)!);
  if (agent) for (const m of out) emit(agent.user_id, { kind: 'message', agentId, message: publicMessage(m) });
  return out;
}

/** Hand what is queued to a waiting poll, else push it to a session with an open stream. */
async function deliver(agentId: number): Promise<void> {
  const w = waiters.get(agentId)?.[0];
  if (w) { const rows = takeForPoll(agentId); if (rows.length) w.give(rows); return; }
  const sessions = [...pushers.values()].filter(p => p.agentId === agentId && p.streamOpen());
  if (!sessions.length) return;
  const okOf = (p: Pusher) => sessionRow(p.sessionId)?.channel_ok === 1;
  // a session whose channel has worked first, then the one seen last
  sessions.sort((a, b) => Number(okOf(b)) - Number(okOf(a)) || (sessionRow(b.sessionId)?.last_seen_at ?? 0) - (sessionRow(a.sessionId)?.last_seen_at ?? 0));
  const target = sessions[0];
  const confirmed = okOf(target);
  const rows = db.prepare("SELECT * FROM mcp_agent_messages WHERE agent_id = ? AND role = 'user' AND state = 'queued' AND pushed_at IS NULL ORDER BY id LIMIT ?").all(agentId, BATCH_MAX) as MessageRow[];
  for (const r of rows) {
    const a = forAgent(r);
    const content = a.text + (a.context ? `\n\n— Added by OverLyX (not typed by the user): ${a.context}` : '');
    const meta: Record<string, string> = { message_id: String(r.id), from: a.from.split(' (')[0] };
    try { const c = r.context ? JSON.parse(r.context) as { docId?: string } : null; if (c?.docId) meta.document = c.docId; } catch { /* none */ }
    try { await target.push({ content, meta }); } catch (e) { console.error('[mcp-agents] push failed', e); return; }
    const now = Date.now();
    db.prepare(`UPDATE mcp_agent_messages SET pushed_at = ?${confirmed ? ", state = 'delivered', via = 'push', delivered_at = ?" : ''} WHERE id = ?`).run(now, ...(confirmed ? [now] : []), r.id);
    const agent = agentRow(agentId);
    if (agent) emit(agent.user_id, { kind: 'message', agentId, message: publicMessage(msgRow(r.id)!) });
  }
}

/**
 * The long poll behind wait_for_instructions: messages for the agent as soon as there are any (also
 * ones already waiting), else [] after `ms` or when `signal` aborts (the client went away). `tick`
 * runs every 15 s while waiting (progress notifications keep some clients from timing out).
 */
export function waitForInstructions(agentId: number, ms: number, signal?: AbortSignal, tick?: () => void): Promise<MessageRow[]> {
  const ready = takeForPoll(agentId);
  if (ready.length) return Promise.resolve(ready);
  const userId = agentRow(agentId)?.user_id;
  return new Promise(resolve => {
    let finished = false;
    const list = waiters.get(agentId) ?? [];
    waiters.set(agentId, list);
    const finish = (rows: MessageRow[]) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (ticker) clearInterval(ticker);
      const i = list.indexOf(w);
      if (i >= 0) list.splice(i, 1);
      if (!list.length && waiters.get(agentId) === list) waiters.delete(agentId);
      lastPollEnd.set(agentId, Date.now());
      if (userId !== undefined) scheduleAgentsEvent(userId);
      resolve(rows);
    };
    const w: Waiter = { give: finish };
    const timer = setTimeout(() => finish([]), ms);
    const ticker = tick ? setInterval(() => { try { tick(); } catch { /* ignore */ } }, 15_000) : null;
    if (signal?.aborted) { finish([]); return; }
    signal?.addEventListener('abort', () => finish([]), { once: true });
    list.push(w);
    if (userId !== undefined) scheduleAgentsEvent(userId);
  });
}

/* ------------------------------------------------------------------ what the panel shows */

export interface PublicAgent {
  id: number; name: string; label: string; color: string;
  client: { name: string; version: string | null };
  /** which credential it uses */
  token: string;
  lastSeen: number; project: string | null; path: string | null; lastTool: string | null;
  /** listening: waiting for a message (a poll, or a session whose pushed messages arrive); working: has messages it has not answered; online: seen in the last minutes */
  status: 'listening' | 'working' | 'online' | 'offline';
  /** pushed messages: 'confirmed' (its channel has delivered), 'possible' (a session stream is open), null */
  push: 'confirmed' | 'possible' | null;
  queued: number;
}

const ONLINE_MS = 3 * 60_000;

export function publicAgent(row: AgentRow): PublicAgent {
  const now = Date.now();
  const streams = [...pushers.values()].filter(p => p.agentId === row.id && p.streamOpen());
  const push = streams.some(p => sessionRow(p.sessionId)?.channel_ok === 1) ? 'confirmed' : streams.length ? 'possible' : null;
  const polling = !!waiters.get(row.id)?.length || now - (lastPollEnd.get(row.id) ?? 0) < 20_000;
  const counts = db.prepare("SELECT SUM(state = 'queued') AS queued, SUM(state = 'delivered') AS open FROM mcp_agent_messages WHERE agent_id = ? AND role = 'user'").get(row.id) as { queued: number | null; open: number | null };
  const status = (counts.open ?? 0) > 0 && now - row.last_seen_at < 60 * 60_000 ? 'working'
    : polling || push === 'confirmed' ? 'listening'
    : now - row.last_seen_at < ONLINE_MS || streams.length ? 'online' : 'offline';
  return {
    id: row.id, name: agentTitle(row), label: agentLabel(row), color: agentColor(row),
    client: { name: row.client_name, version: row.client_version }, token: tokenLabel(row),
    lastSeen: row.last_seen_at, project: row.last_project, path: row.last_path, lastTool: row.last_tool,
    status, push, queued: counts.queued ?? 0,
  };
}

/** The account's agents seen in the last 30 days whose credential still works, most recent first. */
export function listAgents(userId: number): PublicAgent[] {
  const rows = db.prepare('SELECT * FROM mcp_agents WHERE user_id = ? AND last_seen_at > ? ORDER BY last_seen_at DESC LIMIT 40').all(userId, Date.now() - 30 * 86400_000) as AgentRow[];
  return rows.filter(tokenAlive).slice(0, 20).map(publicAgent);
}

/* ------------------------------------------------------------------ live updates for the panel */

type PanelEvent = { kind: 'message'; agentId: number; message: PublicMessage } | { kind: 'agents'; agents: PublicAgent[] };
const subscribers = new Map<number, Set<(e: PanelEvent) => void>>();
function emit(userId: number, e: PanelEvent): void {
  for (const fn of subscribers.get(userId) ?? []) { try { fn(e); } catch { /* a closed stream */ } }
}
const agentsTimers = new Map<number, NodeJS.Timeout>();
/** The panel's list of agents changed (status, last seen): sent at most once a second. */
function scheduleAgentsEvent(userId: number): void {
  if (!subscribers.get(userId)?.size || agentsTimers.has(userId)) return;
  agentsTimers.set(userId, setTimeout(() => { agentsTimers.delete(userId); emit(userId, { kind: 'agents', agents: listAgents(userId) }); }, 1000).unref());
}

/** Forget old sessions, idle agents and their conversations. */
export function pruneAgents(): void {
  const now = Date.now();
  db.prepare('DELETE FROM mcp_sessions WHERE last_seen_at < ?').run(now - 30 * 86400_000);
  const old = db.prepare('SELECT id FROM mcp_agents WHERE last_seen_at < ?').all(now - 120 * 86400_000) as { id: number }[];
  for (const { id } of old) { db.prepare('DELETE FROM mcp_agent_messages WHERE agent_id = ?').run(id); db.prepare('DELETE FROM mcp_agents WHERE id = ?').run(id); }
}

/** Routes under /api (signed in; guests are refused before they get here — index.ts GUEST_DENIED). */
export function mcpAgentRoutes(): express.Router {
  const r = express.Router();
  const own = (req: Request, res: Response): AgentRow | null => {
    const row = agentRow(Number(req.params.id));
    if (!row || row.user_id !== req.user!.id || req.user!.guest) { res.status(404).json({ error: 'no such agent' }); return null; }
    return row;
  };
  const fail = (res: Response, e: unknown) => res.status(e instanceof AgentMessageError ? e.status : 500).json({ error: (e as Error).message });

  r.get('/mcp-agents', (req, res) => { res.json({ agents: req.user!.guest ? [] : listAgents(req.user!.id) }); });

  r.get('/mcp-agents/events', (req, res) => {
    if (req.user!.guest) { res.status(403).end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = (e: PanelEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    send({ kind: 'agents', agents: listAgents(req.user!.id) });
    const set = subscribers.get(req.user!.id) ?? new Set();
    subscribers.set(req.user!.id, set);
    set.add(send);
    const hb = setInterval(() => res.write(': hb\n\n'), 20_000);
    req.on('close', () => { clearInterval(hb); set.delete(send); if (!set.size) subscribers.delete(req.user!.id); });
  });

  r.get('/mcp-agents/:id/messages', (req, res) => {
    const row = own(req, res);
    if (!row) return;
    const rows = db.prepare('SELECT * FROM mcp_agent_messages WHERE agent_id = ? ORDER BY id DESC LIMIT 200').all(row.id) as MessageRow[];
    res.json({ agent: publicAgent(row), messages: rows.reverse().map(publicMessage) });
  });

  // changes come from the owner's own page only, never from a cross-site form (a message makes an agent act on somebody's machine)
  const sameSite = (req: Request, res: Response): boolean => {
    if (originAllowed(req) && req.headers['sec-fetch-site'] !== 'cross-site') return true;
    res.status(403).json({ error: 'forbidden' });
    return false;
  };

  r.post('/mcp-agents/:id/messages', (req, res) => { void (async () => {
    if (!sameSite(req, res)) return;
    const row = own(req, res);
    if (!row) return;
    try {
      const m = await sendInstruction(req.user!, row.id, String(req.body?.text ?? ''), req.body?.context as TurnContext | undefined);
      res.json({ message: publicMessage(m) });
    } catch (e) { fail(res, e); }
  })(); });

  r.post('/mcp-agents/:id/messages/:mid/cancel', (req, res) => {
    if (!sameSite(req, res)) return;
    const row = own(req, res);
    if (!row) return;
    try { res.json({ message: publicMessage(cancelInstruction(req.user!, row.id, Number(req.params.mid))) }); } catch (e) { fail(res, e); }
  });

  /** Forget an agent: its conversation goes; it comes back as a new entry when it connects again. */
  r.delete('/mcp-agents/:id', (req, res) => {
    if (!sameSite(req, res)) return;
    const row = own(req, res);
    if (!row) return;
    db.prepare('DELETE FROM mcp_agent_messages WHERE agent_id = ?').run(row.id);
    db.prepare('DELETE FROM mcp_sessions WHERE agent_id = ?').run(row.id);
    db.prepare('DELETE FROM mcp_agents WHERE id = ?').run(row.id);
    for (const p of [...pushers.values()]) if (p.agentId === row.id) pushers.delete(p.sessionId);
    scheduleAgentsEvent(row.user_id);
    res.json({ ok: true });
  });
  return r;
}
