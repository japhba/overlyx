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
import { userFromCookieHeader } from './auth.ts';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
/** OverLyX extension: the document's epoch, sent before the first sync step (see docs.ts) */
const MSG_EPOCH = 2;
/** OverLyX extension: "the .lyx file on disk contains this state" (timestamp + state vector), sent after every save */
const MSG_SAVED = 3;

function savedMessage(doc: OpenDoc): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SAVED);
  encoding.writeVarUint(enc, Math.round(doc.lastSavedAt));
  encoding.writeVarUint8Array(enc, doc.lastSavedSV);
  return encoding.toUint8Array(enc);
}

function send(doc: OpenDoc, conn: WebSocket, msg: Uint8Array): void {
  if (conn.readyState !== conn.OPEN && conn.readyState !== conn.CONNECTING) { closeConn(doc, conn); return; }
  try { conn.send(msg, (err) => { if (err) closeConn(doc, conn); }); } catch { closeConn(doc, conn); }
}

function closeConn(doc: OpenDoc, conn: WebSocket): void {
  const ids = doc.conns.get(conn);
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
  doc.ydoc.on('update', (update: Uint8Array) => {
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
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws' && url.pathname !== '/ws/') return;
    const user = userFromCookieHeader(req.headers.cookie);
    if (!user) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => void handleConnection(ws, url.searchParams.get('doc') ?? ''));
  });

  wss.on('error', (e) => console.error('wss error', e));
}

async function handleConnection(conn: WebSocket, docId: string): Promise<void> {
  let doc: OpenDoc;
  try {
    doc = await manager.open(decodeURIComponent(docId));
  } catch (e) {
    conn.close(4004, String(e));
    return;
  }
  ensureDocHandlers(doc);
  conn.binaryType = 'arraybuffer';
  doc.conns.set(conn, new Set());

  conn.on('message', (data: ArrayBuffer | Buffer) => {
    try {
      const message = new Uint8Array(data as ArrayBuffer);
      const enc = encoding.createEncoder();
      const dec = decoding.createDecoder(message);
      const type = decoding.readVarUint(dec);
      switch (type) {
        case MSG_SYNC:
          encoding.writeVarUint(enc, MSG_SYNC);
          syncProtocol.readSyncMessage(dec, enc, doc.ydoc, conn);
          if (encoding.length(enc) > 1) send(doc, conn, encoding.toUint8Array(enc));
          break;
        case MSG_AWARENESS:
          awarenessProtocol.applyAwarenessUpdate(doc.awareness, decoding.readVarUint8Array(dec), conn);
          break;
      }
    } catch (e) {
      console.error('ws message error', e);
    }
  });

  let pongReceived = true;
  const ping = setInterval(() => {
    if (!pongReceived) { closeConn(doc, conn); clearInterval(ping); return; }
    if (doc.conns.has(conn)) { pongReceived = false; try { conn.ping(); } catch { closeConn(doc, conn); clearInterval(ping); } }
  }, 30000);
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
}

export { Y };
