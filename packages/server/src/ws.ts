/**
 * Yjs WebSocket sync (same wire protocol as y-websocket): message 0 = sync, 1 = awareness.
 */
import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Server } from 'node:http';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { manager, type OpenDoc } from './docs.ts';
import { userFromCookieHeader, type SessionUser } from './auth.ts';
import { roleFor, logAccess } from './access.ts';
import { canonicalDocId } from './namespaces.ts';
import { splitDocId, sanitizeAwarenessState, MAX_AWARENESS_STATE_JSON } from '@overlyx/core';
import { hasModel, connectParams } from '@overlyx/core/collab/connect.ts';
import { markDocOpened } from './userSettings.ts';
import { config } from './config.ts';
import { isAgentClient, trackMoves } from './agentPresence.ts';
import { offlineBase, applyClientUpdate } from './offlinemerge.ts';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
/** OverLyX extension: the document's epoch, sent before the first sync step (see docs.ts) */
const MSG_EPOCH = 2;
/** OverLyX extension: "the .lyx file on disk contains this state" (timestamp + state vector), sent after every save */
const MSG_SAVED = 3;
/**
 * OverLyX extension: server heartbeat (no payload). y-websocket closes a connection on which it has
 * not received *any* message for 30 s; normally its own awareness renewals (echoed by the server
 * every 15 s) keep it alive, but browsers throttle the timers of hidden tabs (Chrome: one wake-up
 * per minute after five minutes in the background), so a lone background tab used to flap between
 * connected and "offline". A heartbeat that does not depend on client timers keeps a healthy
 * connection open; a dead one still trips the watchdog.
 */
const MSG_PING = 4;
/** an update that came from the embedded agent (origin 'mcp'), sent additionally under this type
 *  so clients can apply it with an undo-tracked origin (see editor.ts messageHandlers[5]) */
const MSG_AGENT_EDIT = 5;
/** OverLyX extension: an editor with offline edits sends the state they were made on, before its sync step 2 (offlinemerge.ts) */
const MSG_OFFLINE_BASE = 7;
const HEARTBEAT_MS = 10000;
/*
 * The CRDT model editors must hold the document in (core collab/model.ts), from the connection's
 * `model` parameter (core collab/connect.ts: .tex and markdown documents only). An editor of an
 * older bundle (y-prosemirror's tree, model 1) would show the converted document as empty and its
 * typing would go nowhere: it gets no sync at all — its connection stays open, so it shows "new
 * version — reload", and its edits stay in its local copy, which the reloaded editor hands to the
 * server to merge (client editor/legacycopy.ts).
 */

function savedMessage(doc: OpenDoc): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SAVED);
  encoding.writeVarUint(enc, Math.round(doc.lastSavedAt));
  encoding.writeVarUint8Array(enc, doc.lastSavedSV);
  // A vector alone cannot acknowledge deletions: those do not advance the client's clock.
  encoding.writeVarUint8Array(enc, doc.lastSavedSnapshot);
  return encoding.toUint8Array(enc);
}

function send(doc: OpenDoc, conn: WebSocket, msg: Uint8Array): void {
  if (conn.readyState !== conn.OPEN && conn.readyState !== conn.CONNECTING) { closeConn(doc, conn); return; }
  try { conn.send(msg, (err) => { if (err) closeConn(doc, conn); }); } catch { closeConn(doc, conn); }
}

function closeConn(doc: OpenDoc, conn: WebSocket): void {
  const ids = doc.conns.get(conn);
  doc.connUsers.delete(conn);
  if (ids) {
    doc.conns.delete(conn);
    awarenessProtocol.removeAwarenessStates(doc.awareness, [...ids], null);
    doc.touchUnload();
  }
  try { conn.close(); } catch { /* ignore */ }
}

const docHandlers = new WeakSet<OpenDoc>();

function ensureDocHandlers(doc: OpenDoc): void {
  if (docHandlers.has(doc)) return;
  docHandlers.add(doc);
  trackMoves(doc);   // when each client last moved (agentPresence.ts presenceIn)
  doc.ydoc.on('update', (update: Uint8Array, origin: unknown) => {
    // An agent (MCP) edit goes out twice: first tagged as MSG_AGENT_EDIT so new clients apply it
    // with an undo-tracked origin (Ctrl+Z reverts the agent like one's own typing), then as the
    // ordinary sync update — Yjs updates are idempotent, so the second apply is a no-op for
    // clients that handled the first, and old clients that drop the unknown type still sync.
    if (origin === 'mcp') {
      const ea = encoding.createEncoder();
      encoding.writeVarUint(ea, MSG_AGENT_EDIT);
      encoding.writeVarUint8Array(ea, update);
      const am = encoding.toUint8Array(ea);
      for (const c of doc.conns.keys()) send(doc, c, am);
    }
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeUpdate(enc, update);
    const msg = encoding.toUint8Array(enc);
    for (const c of doc.conns.keys()) send(doc, c, msg);
  });
  doc.awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    const changed = added.concat(updated, removed);
    if (origin && typeof origin === 'object' && 'readyState' in (origin as object)) {
      const ids = doc.conns.get(origin as WebSocket);
      if (ids) { for (const a of added) ids.add(a); for (const r of removed) ids.delete(r); }
    }
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_AWARENESS);
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(doc.awareness, changed));
    const msg = encoding.toUint8Array(enc);
    for (const c of doc.conns.keys()) send(doc, c, msg);
  });
  doc.savedListeners.add(() => {
    const msg = savedMessage(doc);
    for (const c of doc.conns.keys()) send(doc, c, msg);
  });
}

export function attachWebSocket(server: Server): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // an upgrade for any other path (a browser extension probing the site, …) must not leave the
    // socket dangling: nobody else answers it and the proxy in front keeps it open for minutes
    if (url.pathname !== '/ws' && url.pathname !== '/ws/') { socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    // browsers send the page's origin: a foreign site must not be able to open a socket with our cookie
    if (!originAllowed(req)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
    const user = userFromCookieHeader(req.headers.cookie);
    if (!user) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    // (an exception in this listener would take the whole server down: answer it instead)
    try {
      // an id from before its project moved (namespaces.ts) joins the document under its current key
      // (searchParams decodes it already: a second decode broke on a '%' in a file name)
      const docId = canonicalDocId(url.searchParams.get('doc') ?? '');
      const { project, path: rel } = splitDocId(docId);
      const role = roleFor(user, project);
      if (!role) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
      logAccess(project, user.id, 'open', rel || null);
      markDocOpened(user.id, docId);
      const model = url.searchParams.get('model'), needs = connectParams(docId).model;
      const current = !hasModel(docId) || model === needs;
      // (the maintenance worker screens the log for "withheld": an editor of this version would be a bug)
      if (!current) console.warn(`[ws] ${docId}: sync withheld from an outdated editor (model ${model ?? 'none'}, needs ${needs}) until it reloads`);
      wss.handleUpgrade(req, socket, head, (ws) => void (current ? handleConnection(ws, docId, user, role === 'view') : holdOutdated(ws)));
    } catch (e) {
      console.error('[ws] upgrade failed:', e);
      try { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); socket.destroy(); } catch { /* gone */ }
    }
  });

  wss.on('error', (e) => console.error('wss error', e));
}

/** Same-origin check for the upgrade: the Origin's host must be ours (the request's Host, the public URL, or localhost in development). */
export function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;   // not a browser (curl, tests)
  let host: string;
  try { host = new URL(origin).host; } catch { return false; }
  if (host === req.headers.host) return true;
  if (config.publicUrl) { try { if (host === new URL(config.publicUrl).host) return true; } catch { /* ignore */ } }
  return /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) && process.env.NODE_ENV !== 'production';
}

/** Whether the user still has the role a connection was opened with (an error counts as no). */
function roleStillHolds(user: SessionUser, project: string, readOnly: boolean): boolean {
  try {
    const role = roleFor(user, project);
    return !!role && (role === 'view') === readOnly;
  } catch { return false; }
}

async function handleConnection(conn: WebSocket, docId: string, user: SessionUser, readOnly: boolean): Promise<void> {
  // what the client sends while the document is being opened (its sync step 1 comes right away;
  // a big document takes a moment) is handled once it is open — after the epoch, as always
  conn.binaryType = 'arraybuffer';
  const early: (ArrayBuffer | Buffer)[] = [];
  const keep = (data: ArrayBuffer | Buffer) => { early.push(data); };
  conn.on('message', keep);
  let doc: OpenDoc;
  try {
    doc = await manager.open(docId);
  } catch (e) {
    conn.close(4004, String(e));
    return;
  } finally {
    conn.off('message', keep);
  }
  if (conn.readyState !== conn.OPEN) return;   // gone while the document was opened
  ensureDocHandlers(doc);
  doc.conns.set(conn, new Set());
  doc.connUsers.set(conn, user.id);

  const onMessage = (data: ArrayBuffer | Buffer) => {
    try {
      const message = new Uint8Array(data as ArrayBuffer);
      const enc = encoding.createEncoder();
      const dec = decoding.createDecoder(message);
      const type = decoding.readVarUint(dec);
      switch (type) {
        case MSG_SYNC: {
          const kind = decoding.readVarUint(dec);
          if (kind === syncProtocol.messageYjsSyncStep1) answerStep1(doc, conn, decoding.readVarUint8Array(dec));
          else if (!readOnly && (kind === syncProtocol.messageYjsSyncStep2 || kind === syncProtocol.messageYjsUpdate)) {
            // a viewer's are dropped: it only ever gets the document
            applyClientUpdate(doc, conn, decoding.readVarUint8Array(dec), kind === syncProtocol.messageYjsSyncStep2);
          }
          break;
        }
        case MSG_OFFLINE_BASE: {
          if (!readOnly) offlineBase(conn, decoding.readVarUint8Array(dec), user.name);
          break;
        }
        case MSG_AWARENESS: {
          // another connection's client ids, and the agents' (agentPresence.ts), are not this client's to set
          const update = sanitizeAwarenessUpdate(decoding.readVarUint8Array(dec), id => isAgentClient(doc, id) || [...doc.conns].some(([c, ids]) => c !== conn && ids.has(id)));
          if (update) awarenessProtocol.applyAwarenessUpdate(doc.awareness, update, conn);
          break;
        }
      }
    } catch (e) {
      console.error('ws message error', e);
    }
  };
  conn.on('message', onMessage);

  // liveness: a protocol ping every 30 s (answered by the browser's network stack even when the
  // page is throttled or frozen) and an application-level heartbeat every 10 s (see MSG_PING)
  let pongReceived = true;
  let tick = 0;
  const heartbeat = new Uint8Array([MSG_PING]);
  const ping = setInterval(() => {
    if (!doc.conns.has(conn)) { clearInterval(ping); return; }
    tick++;
    if (tick % 3 === 0) {
      // the role was decided at the upgrade: whatever ended or changed it since (an administrator's
      // grant running out, an e-mail invitation withdrawn, …) closes the connection like a kick —
      // the client reconnects and learns its new role, or that it has none
      if (!roleStillHolds(user, doc.project, readOnly)) { try { conn.close(4003, 'access changed'); } catch { /* ignore */ } closeConn(doc, conn); clearInterval(ping); return; }
      if (!pongReceived) { closeConn(doc, conn); clearInterval(ping); return; }
      pongReceived = false;
      try { conn.ping(); } catch { closeConn(doc, conn); clearInterval(ping); return; }
    }
    send(doc, conn, heartbeat);
  }, HEARTBEAT_MS);
  conn.on('pong', () => { pongReceived = true; });
  conn.on('close', () => { closeConn(doc, conn); clearInterval(ping); });
  conn.on('error', () => { closeConn(doc, conn); clearInterval(ping); });

  // epoch first: a client that knows a different epoch must not merge its stale history into this doc
  {
    const enc0 = encoding.createEncoder();
    encoding.writeVarUint(enc0, MSG_EPOCH);
    encoding.writeVarString(enc0, doc.epoch);
    send(doc, conn, encoding.toUint8Array(enc0));
  }
  // initial sync step 1 + awareness
  {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, doc.ydoc);
    send(doc, conn, encoding.toUint8Array(enc));
    send(doc, conn, savedMessage(doc));
    const states = doc.awareness.getStates();
    if (states.size > 0) {
      const enc2 = encoding.createEncoder();
      encoding.writeVarUint(enc2, MSG_AWARENESS);
      encoding.writeVarUint8Array(enc2, awarenessProtocol.encodeAwarenessUpdate(doc.awareness, [...states.keys()]));
      send(doc, conn, encoding.toUint8Array(enc2));
    }
  }
  for (const data of early) onMessage(data);
}

export { Y };

/**
 * An editor of an older bundle (the model check in attachWebSocket): the connection stays open — heartbeats only, nothing it
 * sends is applied, nothing of the document goes to it.
 */
function holdOutdated(conn: WebSocket): void {
  const heartbeat = new Uint8Array([MSG_PING]);
  const ping = setInterval(() => { try { conn.send(heartbeat); } catch { clearInterval(ping); } }, HEARTBEAT_MS);
  conn.on('close', () => clearInterval(ping));
  conn.on('error', () => clearInterval(ping));
}

/** sync step 2: what the client with state vector `sv` lacks */
function answerStep1(doc: OpenDoc, conn: WebSocket, sv: Uint8Array): void {
  if (doc.bigForSync) {
    // what the client lacks of a big document (all of it, on its first visit) takes a while
    // to encode: the document worker does it, the answer is sent when it is ready
    void sendMissing(doc, conn, sv);
    return;
  }
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SYNC);
  syncProtocol.writeSyncStep2(enc, doc.ydoc, sv);
  send(doc, conn, encoding.toUint8Array(enc));
}

/** Sync step 2 for a client whose state vector is `sv`, encoded by the document worker. */
async function sendMissing(doc: OpenDoc, conn: WebSocket, sv: Uint8Array): Promise<void> {
  let update: Uint8Array;
  try { update = await doc.missingFor(sv); }
  catch (e) { console.error('[ws] encoding the sync in the worker failed — here instead', doc.id, e); update = Y.encodeStateAsUpdate(doc.ydoc, sv); }
  if (!doc.conns.has(conn)) return;
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SYNC);
  encoding.writeVarUint(enc, syncProtocol.messageYjsSyncStep2);
  encoding.writeVarUint8Array(enc, update);
  send(doc, conn, encoding.toUint8Array(enc));
}

/**
 * An awareness update as a client sent it, with every state checked before it is applied and relayed
 * to the other clients of the document (`sanitizeAwarenessState`: a malformed cursor once wiped
 * documents in the receiving editors). States that are too large or not JSON are relayed as
 * removals; entries for a client id another connection owns (`ownedElsewhere`) are dropped, so one
 * client cannot overwrite somebody else's presence. Null when nothing is left or the update is unreadable.
 */
export function sanitizeAwarenessUpdate(update: Uint8Array, ownedElsewhere: (clientId: number) => boolean = () => false): Uint8Array | null {
  try {
    const dec = decoding.createDecoder(update);
    const entries: { clientId: number; clock: number; json: string }[] = [];
    const n = decoding.readVarUint(dec);
    for (let i = 0; i < n; i++) {
      const clientId = decoding.readVarUint(dec);
      const clock = decoding.readVarUint(dec);
      const raw = decoding.readVarString(dec);
      if (ownedElsewhere(clientId)) continue;
      let state: unknown = null;
      if (raw.length <= MAX_AWARENESS_STATE_JSON) { try { state = JSON.parse(raw); } catch { state = null; } }
      entries.push({ clientId, clock, json: JSON.stringify(state === null ? null : sanitizeAwarenessState(state)) });
    }
    if (!entries.length) return null;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, entries.length);
    for (const e of entries) { encoding.writeVarUint(enc, e.clientId); encoding.writeVarUint(enc, e.clock); encoding.writeVarString(enc, e.json); }
    return encoding.toUint8Array(enc);
  } catch { return null; }
}

