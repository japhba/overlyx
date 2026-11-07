/**
 * A WebSocket stand-in for the editor's y-websocket provider (editor/editor.ts) on a document of an
 * end-to-end encrypted project: towards the editor it speaks y-websocket's protocol with OverLyX's
 * extensions (the epoch, "saved" acknowledgements, the heartbeat) as the server would; towards the
 * server it speaks the encrypted relay's (relay.ts). The editor, its offline copy, cursors, undo
 * and save state stay as they are.
 *
 * The server only orders and stores ciphertext, so what it would do is done here: the log is read and
 * merged into a shadow of the server's state; the editor is told that state's vector (sync step 1,
 * which makes it send what the server lacks) and the state itself (step 2); local updates go out
 * batched; an update the server acknowledged joins the shadow, and once nothing is outstanding the
 * editor hears "saved" with the shadow's snapshot. A long log is replaced by a snapshot.
 */
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import { RelayClient, wantsCompaction } from './relay';
import { openE2eProject, isE2eDocId } from './project';

const MSG_SYNC = 0, MSG_AWARENESS = 1, MSG_EPOCH = 2, MSG_SAVED = 3, MSG_PING = 4;
const BATCH_MS = 120;
/**
 * per document: the server's state when "saved" was said last, and when that state came about — a
 * build compares it with its PDF's time. Neither a reconnection nor a reload makes it newer: the state
 * a page first meets counts as older than anything the page builds (0: the log keeps no times), what
 * changes it later (an edit here or a co-author's) as made then.
 */
const saved = new Map<string, { snap: Y.Snapshot; at: number }>();

export class E2eSocket {
  static readonly CONNECTING = 0; static readonly OPEN = 1; static readonly CLOSING = 2; static readonly CLOSED = 3;
  readonly CONNECTING = 0; readonly OPEN = 1; readonly CLOSING = 2; readonly CLOSED = 3;
  readyState = 0;
  binaryType = 'arraybuffer';
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  private client: RelayClient | null = null;
  private shadow = new Y.Doc();
  private synced = false;
  private readOnly = false;
  private lastSeq = 0; private entries = 0; private bytes = 0;
  private initial: Uint8Array[] = [];
  private queue: Uint8Array[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sent = new Map<number, Uint8Array>();
  private helloSent = false;
  /** each presence client's last clock (a removal must carry a newer one) */
  private clocks = new Map<number, number>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  /** the document's id: its history (a document made later under the same name is another one, and the editor's local copy of the old one must not merge into it) */
  private epoch = '';

  constructor(url: string) {
    void this.start(new URL(url).searchParams.get('doc') ?? '');
  }

  private async start(docId: string): Promise<void> {
    try {
      if (!isE2eDocId(docId)) throw new Error('not an encrypted document');
      const p = await openE2eProject(docId.split('/').slice(0, 2).join('/'), { doc: docId });
      await p.ready;
      if (this.readyState === 3) return;
      const path = docId.split('/').slice(2).join('/');
      const entry = p.entry(path);
      if (!entry || entry.kind !== 'doc') { this.fail(4004, 'document not available'); return; }
      this.readOnly = p.role === 'view';
      this.epoch = entry.id;
      this.client = new RelayClient(p.name, entry.id, p.key!, {
        entry: (seq, u, kind) => this.onEntry(seq, u, kind),
        synced: () => this.onSynced(),
        ack: (tag) => this.onAck(tag),
        awareness: (u) => this.onAwareness(u),
        gone: (id) => this.onGone(id),
        error: (m) => console.warn('[e2e] relay:', m),
        close: (code, reason) => this.fail(code === 1000 ? 1006 : code, reason),
      });
    } catch (e) {
      console.warn('[e2e] cannot open the document:', e);
      this.fail(4004, (e as Error).message || 'document not available');
    }
  }

  private deliver(msg: Uint8Array): void {
    if (this.readyState !== 1) return;
    this.onmessage?.({ data: msg.slice().buffer as ArrayBuffer });
  }
  private message(type: number, write: (enc: encoding.Encoder) => void): Uint8Array {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, type);
    write(enc);
    return encoding.toUint8Array(enc);
  }

  private onEntry(seq: number, u: Uint8Array, _kind: number): void {
    this.lastSeq = seq; this.entries++; this.bytes += u.length;
    if (!this.synced) { this.initial.push(u); return; }
    Y.applyUpdate(this.shadow, u);
    this.deliver(this.message(MSG_SYNC, enc => syncProtocol.writeUpdate(enc, u)));
    this.deliverSaved();
  }

  private onSynced(): void {
    if (this.synced) return;
    this.synced = true;
    const server = this.initial.length ? Y.mergeUpdates(this.initial) : null;
    if (server) Y.applyUpdate(this.shadow, server);
    this.initial = [];
    this.readyState = 1;
    this.onopen?.(new Event('open'));
    // the epoch first (the document's id: its log is its one history), then step 1 with the server's
    // state vector — the editor answers with what the server lacks — then the server's state
    this.deliver(this.message(MSG_EPOCH, enc => encoding.writeVarString(enc, 'e2e:' + this.epoch)));
    this.deliver(this.message(MSG_SYNC, enc => { encoding.writeVarUint(enc, syncProtocol.messageYjsSyncStep1); encoding.writeVarUint8Array(enc, Y.encodeStateVector(this.shadow)); }));
    this.deliver(this.message(MSG_SYNC, enc => { encoding.writeVarUint(enc, syncProtocol.messageYjsSyncStep2); encoding.writeVarUint8Array(enc, Y.encodeStateAsUpdate(this.shadow)); }));
    this.deliverSaved();
    if (!this.readOnly && server && wantsCompaction(this.entries, this.bytes)) this.client?.sendSnapshot(this.lastSeq, server);
    // the provider's watchdog closes a connection that heard nothing for 30 s
    this.pingTimer = setInterval(() => this.deliver(new Uint8Array([MSG_PING])), 10000);
  }

  private deliverSaved(): void {
    const now = Y.snapshot(this.shadow);
    let s = saved.get(this.epoch);
    if (!s) saved.set(this.epoch, s = { snap: now, at: 0 });
    else if (!Y.equalSnapshots(s.snap, now)) saved.set(this.epoch, s = { snap: now, at: Date.now() });
    const snap = Y.encodeSnapshot(now);
    const at = s.at;
    this.deliver(this.message(MSG_SAVED, enc => {
      encoding.writeVarUint(enc, at);
      encoding.writeVarUint8Array(enc, Y.encodeStateVector(this.shadow));
      encoding.writeVarUint8Array(enc, snap);
    }));
  }

  private onAck(tag: number): void {
    const u = this.sent.get(tag);
    if (!u) return;
    this.sent.delete(tag);
    Y.applyUpdate(this.shadow, u);
    if (!this.sent.size && !this.queue.length) this.deliverSaved();
  }

  private onAwareness(u: Uint8Array): void {
    try {
      const dec = decoding.createDecoder(u);
      const n = decoding.readVarUint(dec);
      for (let i = 0; i < n; i++) { const id = decoding.readVarUint(dec), clock = decoding.readVarUint(dec); decoding.readVarString(dec); this.clocks.set(id, clock); }
    } catch { return; }
    this.deliver(this.message(MSG_AWARENESS, enc => encoding.writeVarUint8Array(enc, u)));
  }

  /** a browser tab left: its presence is removed (the server cannot say so inside the encrypted states) */
  private onGone(id: number): void {
    const clock = this.clocks.get(id);
    if (clock === undefined) return;
    this.clocks.delete(id);
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 1); encoding.writeVarUint(enc, id); encoding.writeVarUint(enc, clock + 1); encoding.writeVarString(enc, 'null');
    this.deliver(this.message(MSG_AWARENESS, e => encoding.writeVarUint8Array(e, encoding.toUint8Array(enc))));
  }

  /** what the provider sends */
  send(data: ArrayBuffer | Uint8Array): void {
    if (this.readyState !== 1 || !this.client) return;
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const dec = decoding.createDecoder(bytes);
    const type = decoding.readVarUint(dec);
    if (type === MSG_SYNC) {
      const kind = decoding.readVarUint(dec);
      if (kind === syncProtocol.messageYjsSyncStep1) return;   // the full state comes with every connection
      const u = decoding.readVarUint8Array(dec);
      if (this.readOnly || u.length <= 2) return;
      // the editor's answer to step 1 carries its whole delete set: nothing to send when the server has it all
      if (kind === syncProtocol.messageYjsSyncStep2 && !this.adds(u)) return;
      this.queue.push(u);
      if (!this.timer) this.timer = setTimeout(() => this.flush(), BATCH_MS);
    } else if (type === MSG_AWARENESS) {
      const u = decoding.readVarUint8Array(dec);
      if (!this.helloSent) {
        // the first states are this tab's own: its client id, so the others hear when it leaves
        try { const d = decoding.createDecoder(u); if (decoding.readVarUint(d) > 0) { this.client.hello(decoding.readVarUint(d)); this.helloSent = true; } } catch { /* ignore */ }
      }
      this.client.sendAwareness(u);
    }
    // (the offline base, awareness queries: nothing the relay could use)
  }

  /** whether an update would change the server's state */
  private adds(u: Uint8Array): boolean {
    const probe = new Y.Doc();
    try {
      Y.applyUpdate(probe, Y.encodeStateAsUpdate(this.shadow));
      const before = Y.snapshot(probe);
      Y.applyUpdate(probe, u);
      return !Y.equalSnapshots(before, Y.snapshot(probe));
    } catch { return true; } finally { probe.destroy(); }
  }

  private flush(): void {
    this.timer = null;
    if (!this.queue.length || !this.client) return;
    const u = Y.mergeUpdates(this.queue);
    this.queue = [];
    this.sent.set(this.client.sendUpdate(u), u);
  }

  private fail(code: number, reason: string): void {
    if (this.readyState === 3) return;
    const wasOpen = this.readyState === 1;
    this.readyState = 3;
    this.cleanup();
    if (!wasOpen) this.onerror?.(new Event('error'));
    this.onclose?.({ code, reason });
  }

  private cleanup(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    this.client?.close();
    this.client = null;
    this.shadow.destroy();
  }

  close(): void {
    if (this.readyState === 3) return;
    // edits still in the batch go out first
    if (this.timer && this.client?.open) { clearTimeout(this.timer); this.flush(); }
    this.readyState = 3;
    const c = this.client;
    this.client = null;
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    // let the last batch leave before the socket closes
    setTimeout(() => { c?.close(); this.shadow.destroy(); }, 300);
  }
}
