/**
 * Presence in a document, both ways, for agents connected over MCP.
 *
 * People see agents: an external agent working in a document gets an awareness client of its own
 * on the server — a state `{ user: { name: "Claude Code (Jan)", color, agent: true }, cursor }` in
 * the document's Awareness, relayed by ws.ts like any browser's — so the web client and the VS Code
 * extension show it with their ordinary collaborator rendering: an avatar in the presence list and a
 * caret / highlight where it last edited, or at the passage it points at (the `highlight` tool).
 * The state is renewed while the agent is active (the Awareness drops a state after 30 s without an
 * update) and removed after AGENT_IDLE_MS without a tool call touching the document. Browsers cannot
 * overwrite these client ids (ws.ts sanitizeAwarenessUpdate, isAgentClient).
 *
 * Agents see people: presenceIn() lists who is in a document — each browser tab's awareness state,
 * with the account behind it taken from the connection (doc.connUsers, not from what the client
 * claims), its cursor and selection resolved by ycursor.ts, and how long ago it last moved.
 */
import crypto from 'node:crypto';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import { sanitizeAwarenessState } from '@overlyx/core';
import { manager, type OpenDoc } from './docs.ts';
import { describeCursor, type Cursor, type CursorInfo, type SelectionInfo } from './ycursor.ts';

/** an agent's presence in a document ends this long after its last tool call there */
export const AGENT_IDLE_MS = 5 * 60_000;
/** renewal interval (the Awareness drops states not updated for 30 s) */
const RENEW_MS = 10_000;
/** the origin of the awareness updates made here */
export const AGENT_PRESENCE_ORIGIN = 'agent-presence';

/** How an agent looks to the people in a document. */
export interface AgentLook {
  /** identifies the agent (one awareness client per agent and document) */
  key: string;
  name: string;
  color: string;
  /** the account the agent acts for */
  userId: number;
}

interface Entry { doc: OpenDoc; look: AgentLook; clientId: number; clock: number; cursor: Cursor | null; lastActive: number }

const entries = new Map<string, Entry>();
const entryKey = (agentKey: string, docId: string) => `${agentKey}\n${docId}`;

function stateOf(e: Entry): Record<string, unknown> {
  return { user: { name: e.look.name, color: e.look.color, agent: true }, ...(e.cursor ? { cursor: e.cursor } : {}) };
}

/** Apply a state (null: remove) for the entry's client id, as if a client had sent it. */
function apply(e: Entry, state: Record<string, unknown> | null): void {
  e.clock++;
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 1);
  encoding.writeVarUint(enc, e.clientId);
  encoding.writeVarUint(enc, e.clock);
  encoding.writeVarString(enc, JSON.stringify(state));
  try { awarenessProtocol.applyAwarenessUpdate(e.doc.awareness, encoding.toUint8Array(enc), AGENT_PRESENCE_ORIGIN); } catch (err) { console.error('[presence] awareness update failed', e.doc.id, err); }
}

/** the document is still the open one (not unloaded / reset / replaced since) */
const live = (doc: OpenDoc) => !doc.disposed && manager.docs.get(doc.id) === doc;

/**
 * Show the agent in `doc`, or keep showing it (its activity renews the idle timeout). `cursor`:
 * where its caret / highlight goes — undefined keeps the one it has, null shows it without one.
 */
export function showAgent(doc: OpenDoc, look: AgentLook, cursor?: Cursor | null): void {
  const k = entryKey(look.key, doc.id);
  let e = entries.get(k);
  if (e && e.doc !== doc) { entries.delete(k); e = undefined; }   // the document was reopened: a new Awareness
  if (!e) {
    let clientId: number;
    do clientId = crypto.randomInt(1, 2 ** 31); while (doc.awareness.getStates().has(clientId));
    e = { doc, look, clientId, clock: 0, cursor: null, lastActive: 0 };
    entries.set(k, e);
  }
  e.look = look;
  if (cursor !== undefined) e.cursor = cursor;
  e.lastActive = Date.now();
  apply(e, stateOf(e));
  ensureTimer();
}

/** Remove an agent from every document it is shown in (its token went away, tests). */
export function hideAgent(agentKey: string): void {
  for (const [k, e] of entries) {
    if (e.look.key !== agentKey) continue;
    entries.delete(k);
    if (live(e.doc)) apply(e, null);
  }
}

/** The client id is one of the agents' (browsers must not overwrite those states). */
export function isAgentClient(doc: OpenDoc, clientId: number): boolean {
  for (const e of entries.values()) if (e.doc === doc && e.clientId === clientId) return true;
  return false;
}

let timer: NodeJS.Timeout | null = null;
function ensureTimer(): void {
  if (timer) return;
  timer = setInterval(() => {
    const now = Date.now();
    for (const [k, e] of entries) {
      if (!live(e.doc)) { entries.delete(k); continue; }
      if (now - e.lastActive > AGENT_IDLE_MS) { entries.delete(k); apply(e, null); continue; }
      apply(e, stateOf(e));
    }
    if (!entries.size && timer) { clearInterval(timer); timer = null; }
  }, RENEW_MS);
  timer.unref();
}

/* ------------------------------------------------------------------ who is where */

/** when each awareness client of a document last changed its state (moved its cursor, …) */
const lastMoved = new WeakMap<OpenDoc, Map<number, number>>();

/** Start recording when the document's clients move (ws.ts, when the first client connects). */
export function trackMoves(doc: OpenDoc): void {
  if (lastMoved.has(doc)) return;
  const m = new Map<number, number>();
  lastMoved.set(doc, m);
  doc.awareness.on('change', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
    const now = Date.now();
    for (const id of added) m.set(id, now);
    for (const id of updated) m.set(id, now);
    for (const id of removed) m.delete(id);
  });
}

export interface PresentPerson {
  name: string;
  kind: 'person' | 'agent';
  /** a person signed in as the token's own account — "the user" whose "this" / "here" a request means */
  you?: true;
  /** this very agent */
  self?: true;
  /** seconds since the cursor or selection last changed (rounded) */
  moved_seconds_ago?: number;
  cursor: CursorInfo | null;
  selection: SelectionInfo | null;
}

/**
 * The people (each browser tab or editor) and agents in an open document, as `viewerId` (an account)
 * and `selfKey` (the asking agent) see them: their cursors and selections resolved into paragraphs,
 * offsets and text. People who moved most recently come first.
 */
export function presenceIn(doc: OpenDoc, viewerId: number, selfKey: string | null): PresentPerson[] {
  const states = doc.awareness.getStates();
  const moved = lastMoved.get(doc);
  const now = Date.now();
  const out: (PresentPerson & { at: number })[] = [];
  const resolveFor = (cursor: unknown) => describeCursor(doc.ydoc, cursor as Cursor | null);
  for (const [conn, ids] of doc.conns) {
    const uid = doc.connUsers.get(conn);
    for (const id of ids) {
      const st = sanitizeAwarenessState(states.get(id));
      const user = st?.user as { name?: string } | undefined;
      if (!st || !user?.name) continue;
      const r = st.cursor ? resolveFor(st.cursor) : null;
      const at = moved?.get(id) ?? 0;
      out.push({
        name: user.name, kind: 'person', ...(uid === viewerId ? { you: true as const } : {}),
        ...(at ? { moved_seconds_ago: Math.round((now - at) / 1000) } : {}),
        cursor: r?.cursor ?? null, selection: r?.selection ?? null, at,
      });
    }
  }
  for (const e of entries.values()) {
    if (e.doc !== doc) continue;
    const r = e.cursor ? resolveFor(e.cursor) : null;
    out.push({
      name: e.look.name, kind: 'agent', ...(e.look.key === selfKey ? { self: true as const } : {}),
      moved_seconds_ago: Math.round((now - e.lastActive) / 1000),
      cursor: r?.cursor ?? null, selection: r?.selection ?? null, at: e.lastActive,
    });
  }
  out.sort((a, b) => Number(b.kind === 'person') - Number(a.kind === 'person') || b.at - a.at);
  return out.map(({ at: _at, ...p }) => p);
}
