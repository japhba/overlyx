/**
 * The relay of an end-to-end encrypted document (store.ts): a WebSocket at `/e2e?project=…&doc=…`
 * over which the browsers of a document's editors exchange encrypted Yjs updates and presence. The
 * server cannot read any of it: it appends updates to the document's log, numbers them and passes
 * them on, hands a connecting browser the log, and lets a browser replace the log's oldest entries
 * by a snapshot. Presence (cursors, names) is relayed encrypted too and never stored.
 *
 * Wire format (lib0 encoding), server → browser:
 *   0 ENTRY seq kind data · 1 SYNCED head · 2 ACK tag seq · 3 AWARENESS from data · 4 GONE clientId
 *   5 PING · 6 ERROR message · 7 COMPACTED upTo
 * browser → server:
 *   0 UPDATE tag data · 1 SNAPSHOT upTo data · 2 AWARENESS data · 3 HELLO clientId · 5 PONG
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { WebSocket, WebSocketServer } from 'ws';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import type { SessionUser } from '../auth.ts';
import { roleFor, atLeast } from '../access.ts';
import { canonicalProject } from '../namespaces.ts';
import { assertRoom, ProjectFullError } from '../projectsize.ts';
import { isE2eProject, e2eEnabled, OPAQUE_ID, MANIFEST_DOC, entriesSince, appendUpdate, compact, headSeq, KIND_UPDATE } from './store.ts';

export const S_ENTRY = 0, S_SYNCED = 1, S_ACK = 2, S_AWARENESS = 3, S_GONE = 4, S_PING = 5, S_ERROR = 6, S_COMPACTED = 7;
export const C_UPDATE = 0, C_SNAPSHOT = 1, C_AWARENESS = 2, C_HELLO = 3, C_PONG = 5;
/** one update or snapshot (a big pasted document) */
const MAX_ENTRY = 32 * 1024 * 1024;
/** one presence message */
const MAX_AWARENESS = 64 * 1024;
const HEARTBEAT_MS = 10000;

interface Conn { ws: WebSocket; user: SessionUser; readOnly: boolean; clientIds: Set<number>; id: number }
/** the connections of each document: `<project>\0<doc>` */
const rooms = new Map<string, Set<Conn>>();
let nextConn = 1;

function message(type: number, write: (enc: encoding.Encoder) => void): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, type);
  write(enc);
  return encoding.toUint8Array(enc);
}

function send(c: Conn, msg: Uint8Array): void {
  if (c.ws.readyState !== c.ws.OPEN) return;
  try { c.ws.send(msg); } catch { /* closing */ }
}

/** The upgrade of `/e2e` (ws.ts hands it here once the user is known). */
export function e2eUpgrade(wss: WebSocketServer, req: IncomingMessage, socket: Duplex, head: Buffer, user: SessionUser): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const refuse = (status: string) => { socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
  if (!e2eEnabled) { refuse('503 Service Unavailable'); return; }
  const project = canonicalProject(url.searchParams.get('project') ?? '');
  const doc = url.searchParams.get('doc') ?? '';
  if (!(doc === MANIFEST_DOC || OPAQUE_ID.test(doc))) { refuse('400 Bad Request'); return; }
  if (!isE2eProject(project)) { refuse('404 Not Found'); return; }
  const role = roleFor(user, project);
  if (!role) { refuse('403 Forbidden'); return; }
  const since = Math.max(0, Number(url.searchParams.get('since') ?? 0) || 0);
  wss.handleUpgrade(req, socket, head, (ws) => connect(ws, project, doc, user, role === 'view', since));
}

function connect(ws: WebSocket, project: string, doc: string, user: SessionUser, readOnly: boolean, since: number): void {
  ws.binaryType = 'arraybuffer';
  const key = `${project}\0${doc}`;
  const c: Conn = { ws, user, readOnly, clientIds: new Set(), id: nextConn++ };
  let room = rooms.get(key);
  if (!room) rooms.set(key, room = new Set());
  room.add(c);
  const others = () => [...(rooms.get(key) ?? [])].filter(o => o !== c);

  // the log, then where it ends
  try {
    for (const e of entriesSince(project, doc, since)) send(c, message(S_ENTRY, enc => { encoding.writeVarUint(enc, e.seq); encoding.writeVarUint(enc, e.kind); encoding.writeVarUint8Array(enc, e.data); }));
    send(c, message(S_SYNCED, enc => encoding.writeVarUint(enc, headSeq(project, doc))));
  } catch (e) {
    console.error('[e2e] cannot read the log of', project, doc, e);
    try { ws.close(1011, 'log unavailable'); } catch { /* ignore */ }
    return;
  }

  const fail = (msg: string) => send(c, message(S_ERROR, enc => encoding.writeVarString(enc, msg)));
  ws.on('message', (raw: ArrayBuffer | Buffer) => {
    try {
      const data = raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      const dec = decoding.createDecoder(data);
      const type = decoding.readVarUint(dec);
      switch (type) {
        case C_UPDATE: {
          const tag = decoding.readVarUint(dec);
          const payload = decoding.readVarUint8Array(dec);
          if (c.readOnly) { fail('You can only view this project'); return; }
          if (payload.length > MAX_ENTRY) { fail('This change is too large'); return; }
          try { assertRoom(project, payload.length, 0, 'This change'); } catch (e) { if (e instanceof ProjectFullError) { fail(e.message); return; } throw e; }
          const seq = appendUpdate(project, doc, payload, user.id);
          send(c, message(S_ACK, enc => { encoding.writeVarUint(enc, tag); encoding.writeVarUint(enc, seq); }));
          const entry = message(S_ENTRY, enc => { encoding.writeVarUint(enc, seq); encoding.writeVarUint(enc, KIND_UPDATE); encoding.writeVarUint8Array(enc, payload); });
          for (const o of others()) send(o, entry);
          break;
        }
        case C_SNAPSHOT: {
          const upTo = decoding.readVarUint(dec);
          const payload = decoding.readVarUint8Array(dec);
          if (c.readOnly || payload.length > MAX_ENTRY) return;
          if (compact(project, doc, upTo, payload, user.id)) send(c, message(S_COMPACTED, enc => encoding.writeVarUint(enc, upTo)));
          break;
        }
        case C_AWARENESS: {
          const payload = decoding.readVarUint8Array(dec);
          if (payload.length > MAX_AWARENESS) return;
          const msg = message(S_AWARENESS, enc => { encoding.writeVarUint(enc, c.id); encoding.writeVarUint8Array(enc, payload); });
          for (const o of others()) send(o, msg);
          break;
        }
        case C_HELLO: {
          // the presence client id of this browser tab, so that the others hear when it is gone
          const id = decoding.readVarUint(dec);
          if (c.clientIds.size < 8) c.clientIds.add(id);
          break;
        }
        case C_PONG: break;
      }
    } catch (e) {
      console.error('[e2e] relay message failed', project, doc, e);
    }
  });

  let alive = true, tick = 0;
  const ping = new Uint8Array([S_PING]);
  const timer = setInterval(() => {
    tick++;
    if (tick % 3 === 0) {
      // a role that ended or changed closes the connection (the browser reconnects and learns the new one)
      const role = roleFor(user, project);
      if (!role || (role === 'view') !== readOnly || !atLeast(role, 'view')) { try { ws.close(4003, 'access changed'); } catch { /* ignore */ } return; }
      if (!alive) { try { ws.terminate(); } catch { /* ignore */ } return; }
      alive = false;
      try { ws.ping(); } catch { /* closing */ }
    }
    send(c, ping);
  }, HEARTBEAT_MS);
  ws.on('pong', () => { alive = true; });
  const close = () => {
    clearInterval(timer);
    const r = rooms.get(key);
    if (!r?.delete(c)) return;
    if (!r.size) rooms.delete(key);
    for (const id of c.clientIds) {
      const msg = message(S_GONE, enc => encoding.writeVarUint(enc, id));
      for (const o of r) send(o, msg);
    }
  };
  ws.on('close', close);
  ws.on('error', close);
}

/** Close every connection of a project's documents (deleted, or a member removed: `userIds`). */
export function kickE2e(project: string, userIds?: number[]): void {
  for (const [key, room] of rooms) {
    if (!key.startsWith(project + '\0')) continue;
    for (const c of room) if (!userIds || userIds.includes(c.user.id)) { try { c.ws.close(4003, 'access changed'); } catch { /* ignore */ } }
  }
}
