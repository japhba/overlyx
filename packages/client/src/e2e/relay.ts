/**
 * The browser's end of an encrypted document's relay (server e2e/relay.ts): a WebSocket that carries
 * the document's log of encrypted Yjs updates and its encrypted presence. `RelayClient` decrypts what
 * comes in (in order) and encrypts what goes out; `syncDoc` keeps a Y.Doc in step through one (the
 * project's manifest); the editors' documents go through `E2eSocket` (socket.ts), which speaks
 * y-websocket's protocol to the editor.
 */
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { encrypt, decrypt } from './crypto';

export const S_ENTRY = 0, S_SYNCED = 1, S_ACK = 2, S_AWARENESS = 3, S_GONE = 4, S_PING = 5, S_ERROR = 6, S_COMPACTED = 7;
export const C_UPDATE = 0, C_SNAPSHOT = 1, C_AWARENESS = 2, C_HELLO = 3, C_PONG = 5;
export const KIND_SNAPSHOT = 1;

export interface RelayHandlers {
  /** an entry of the log, decrypted (in log order) */
  entry(seq: number, update: Uint8Array, kind: number): void;
  /** the log up to `head` has been delivered */
  synced(head: number): void;
  ack(tag: number, seq: number): void;
  awareness?(update: Uint8Array): void;
  gone?(clientId: number): void;
  error?(message: string): void;
  close(code: number, reason: string): void;
  /** an entry that could not be decrypted (a wrong key, a tampered log): reported, skipped */
  undecryptable?(seq: number): void;
}

export class RelayClient {
  private ws: WebSocket;
  private chain: Promise<void> = Promise.resolve();
  private nextTag = 1;
  closed = false;

  constructor(readonly project: string, readonly doc: string, private key: CryptoKey, private h: RelayHandlers) {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/e2e?project=${encodeURIComponent(project)}&doc=${encodeURIComponent(doc)}`;
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onmessage = (ev) => this.receive(new Uint8Array(ev.data as ArrayBuffer));
    this.ws.onclose = (ev) => { this.closed = true; this.inOrder(async () => h.close(ev.code, ev.reason)); };
    this.ws.onerror = () => { /* onclose follows */ };
  }

  /** run after everything received before (decryption is asynchronous; the log's order is not) */
  private inOrder(fn: () => Promise<void> | void): void {
    this.chain = this.chain.then(fn).catch(e => console.error('[e2e] relay handler failed', e));
  }

  private receive(data: Uint8Array): void {
    const dec = decoding.createDecoder(data);
    const type = decoding.readVarUint(dec);
    switch (type) {
      case S_ENTRY: {
        const seq = decoding.readVarUint(dec), kind = decoding.readVarUint(dec), payload = decoding.readVarUint8Array(dec);
        this.inOrder(async () => {
          let plain: Uint8Array;
          try { plain = await decrypt(this.key, payload, 'doc', this.doc); }
          catch { console.error(`[e2e] entry ${seq} of ${this.doc} cannot be decrypted`); this.h.undecryptable?.(seq); return; }
          this.h.entry(seq, plain, kind);
        });
        break;
      }
      case S_SYNCED: { const head = decoding.readVarUint(dec); this.inOrder(() => this.h.synced(head)); break; }
      case S_ACK: { const tag = decoding.readVarUint(dec), seq = decoding.readVarUint(dec); this.inOrder(() => this.h.ack(tag, seq)); break; }
      case S_AWARENESS: {
        decoding.readVarUint(dec);   // the sender's connection
        const payload = decoding.readVarUint8Array(dec);
        this.inOrder(async () => {
          try { this.h.awareness?.(await decrypt(this.key, payload, 'aw', this.doc)); } catch { /* not ours */ }
        });
        break;
      }
      case S_GONE: { const id = decoding.readVarUint(dec); this.inOrder(() => this.h.gone?.(id)); break; }
      case S_PING: this.raw(new Uint8Array([C_PONG])); break;
      case S_ERROR: { const m = decoding.readVarString(dec); this.inOrder(() => this.h.error?.(m)); break; }
    }
  }

  get open(): boolean { return this.ws.readyState === WebSocket.OPEN; }

  private raw(msg: Uint8Array): void {
    if (this.ws.readyState === WebSocket.OPEN) { try { this.ws.send(msg); } catch { /* closing */ } }
  }

  /** Encrypt and send an update; returns its tag (the server acknowledges it with its sequence number). */
  sendUpdate(update: Uint8Array): number {
    const tag = this.nextTag++;
    void encrypt(this.key, update, 'doc', this.doc).then(ct => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, C_UPDATE); encoding.writeVarUint(enc, tag); encoding.writeVarUint8Array(enc, ct);
      this.raw(encoding.toUint8Array(enc));
    });
    return tag;
  }

  /** Replace the log up to `upTo` by this state (the merge of exactly those entries). */
  sendSnapshot(upTo: number, state: Uint8Array): void {
    void encrypt(this.key, state, 'doc', this.doc).then(ct => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, C_SNAPSHOT); encoding.writeVarUint(enc, upTo); encoding.writeVarUint8Array(enc, ct);
      this.raw(encoding.toUint8Array(enc));
    });
  }

  sendAwareness(update: Uint8Array): void {
    void encrypt(this.key, update, 'aw', this.doc).then(ct => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, C_AWARENESS); encoding.writeVarUint8Array(enc, ct);
      this.raw(encoding.toUint8Array(enc));
    });
  }

  hello(clientId: number): void {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, C_HELLO); encoding.writeVarUint(enc, clientId);
    this.raw(encoding.toUint8Array(enc));
  }

  close(): void { this.closed = true; try { this.ws.close(); } catch { /* ignore */ } }
}

/** When the log is long enough to be replaced by one snapshot. */
export function wantsCompaction(entries: number, bytes: number): boolean { return entries > 60 || bytes > 1024 * 1024; }

/**
 * The whole content of a document as one update: its log read once (a document nobody has open here —
 * a child document of the one being compiled, a file being copied). Null when it cannot be had.
 */
export function fetchDoc(project: string, doc: string, key: CryptoKey, timeoutMs = 20000): Promise<Uint8Array | null> {
  return new Promise(resolve => {
    const updates: Uint8Array[] = [];
    let done = false;
    const finish = (v: Uint8Array | null) => { if (done) return; done = true; clearTimeout(t); c.close(); resolve(v); };
    const c = new RelayClient(project, doc, key, {
      entry: (_s, u) => updates.push(u),
      synced: () => finish(updates.length ? Y.mergeUpdates(updates) : new Uint8Array([0, 0])),
      ack: () => {},
      close: () => finish(null),
    });
    const t = setTimeout(() => finish(null), timeoutMs);
  });
}

/** Append one update to a document's log (a new document's first state, a change made away from any editor); resolves once the server has it. */
export function seedDoc(project: string, doc: string, key: CryptoKey, update: Uint8Array, timeoutMs = 20000): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false, tag = -1;
    const finish = (e?: Error) => { if (done) return; done = true; clearTimeout(t); c.close(); if (e) reject(e); else resolve(); };
    const c = new RelayClient(project, doc, key, {
      entry: () => {},
      synced: () => { tag = c.sendUpdate(update); },
      ack: (t) => { if (t === tag) finish(); },
      error: (m) => finish(new Error(m)),
      close: (code, reason) => finish(new Error(`the connection closed (${code}${reason ? ': ' + reason : ''})`)),
    });
    const t = setTimeout(() => finish(new Error('the server did not answer')), timeoutMs);
  });
}

/**
 * Keep `ydoc` in step with an encrypted document (reconnecting): remote entries are applied with
 * origin `REMOTE`, local updates sent (batched), the log compacted when it grew long. `onSynced`
 * fires after every (re)connection's initial log.
 */
export const REMOTE = 'e2e-remote';
export function syncDoc(project: string, doc: string, key: CryptoKey, ydoc: Y.Doc, opts: { readOnly?: boolean; onSynced?: () => void; onStatus?: (connected: boolean) => void } = {}): { destroy(): void; synced: () => boolean } {
  let client: RelayClient | null = null;
  let destroyed = false, synced = false, attempts = 0;
  let lastSeq = 0, entries = 0, bytes = 0;
  let pending: Uint8Array[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const unsent: Uint8Array[] = [];
  const flush = () => {
    flushTimer = null;
    if (!pending.length) return;
    if (!client?.open || !synced) { unsent.push(...pending); pending = []; return; }
    const u = Y.mergeUpdates(pending);
    pending = [];
    client.sendUpdate(u);
  };
  const onUpdate = (u: Uint8Array, origin: unknown) => {
    if (origin === REMOTE || opts.readOnly) return;
    pending.push(u);
    if (!flushTimer) flushTimer = setTimeout(flush, 100);
  };
  ydoc.on('update', onUpdate);
  const connect = () => {
    if (destroyed) return;
    synced = false; lastSeq = 0; entries = 0; bytes = 0;
    const server: Uint8Array[] = [];
    const c = client = new RelayClient(project, doc, key, {
      entry: (seq, u) => {
        lastSeq = seq; entries++; bytes += u.length;
        if (!synced) server.push(u);
        Y.applyUpdate(ydoc, u, REMOTE);
      },
      synced: () => {
        synced = true; attempts = 0;
        opts.onStatus?.(true);
        // what the server lacks of ours (edits made while not connected)
        if (!opts.readOnly) {
          const sv = server.length ? Y.encodeStateVectorFromUpdate(Y.mergeUpdates(server)) : new Uint8Array([0]);
          const mine = Y.encodeStateAsUpdate(ydoc, sv);
          unsent.length = 0;
          if (mine.length > 2) c.sendUpdate(mine);
          if (wantsCompaction(entries, bytes) && lastSeq > 0) c.sendSnapshot(lastSeq, Y.mergeUpdates(server));
        }
        opts.onSynced?.();
      },
      ack: () => {},
      close: () => {
        opts.onStatus?.(false);
        if (destroyed || client !== c) return;
        client = null;
        setTimeout(connect, Math.min(30000, 500 * 2 ** attempts++));
      },
    });
  };
  connect();
  return {
    destroy() { destroyed = true; ydoc.off('update', onUpdate); if (flushTimer) { clearTimeout(flushTimer); flush(); } client?.close(); },
    synced: () => synced,
  };
}
