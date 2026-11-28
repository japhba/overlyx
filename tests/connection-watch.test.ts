/**
 * The editors' connection watch (client editor/connection.ts) with the real y-websocket provider
 * (3.1.0, the version every bundle shipped with) over a socket this test plays the server for:
 * the browser's `offline` hint no longer tears down a socket that answers, a dead one is replaced at
 * once, a closed one reads "connecting…" for the grace, and a refusal (signed out, no access) stops the
 * retries, says why, and is tried again when that could have changed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import { WebsocketProvider } from 'y-websocket';
import { watchConnection, PROBE_MS, RECONNECT_GRACE_MS, REFUSED_FIRST_MS, REFUSED_RETRY_MS, type ConnectionWatch, type WatchEnv } from '../packages/client/src/editor/connection';
import { CLOSE_SIGNED_OUT, CLOSE_NO_ACCESS } from '../packages/core/src/collab/connect.ts';

class FakeSocket {
  static all: FakeSocket[] = [];
  readonly CONNECTING = 0; readonly OPEN = 1; readonly CLOSING = 2; readonly CLOSED = 3;
  readyState = 0;
  binaryType = 'arraybuffer';
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: Uint8Array[] = [];
  constructor(readonly url: string) { FakeSocket.all.push(this); }
  send(d: ArrayBuffer | Uint8Array) { this.sent.push(new Uint8Array(d as ArrayBuffer)); }
  close() { this.readyState = 3; }
  // the server's side
  open() { this.readyState = 1; this.onopen?.({}); }
  receive(bytes: Uint8Array) { this.onmessage?.({ data: bytes.slice().buffer as ArrayBuffer }); }
  sync() { const enc = encoding.createEncoder(); encoding.writeVarUint(enc, 0); syncProtocol.writeSyncStep2(enc, new Y.Doc()); this.receive(encoding.toUint8Array(enc)); }
  shut(code: number, reason = '') { this.readyState = 3; this.onclose?.({ code, reason }); }
  refuseUpgrade() { this.onerror?.({}); this.shut(1006); }
  pings() { return this.sent.filter(m => m.length === 1 && m[0] === 4).length; }
}
const last = () => FakeSocket.all[FakeSocket.all.length - 1];

let provider: WebsocketProvider, watch: ConnectionWatch, env: WatchEnv & { window: EventTarget; document: EventTarget }, browserOnline: boolean, changes: number, refusals: string[];
beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
  browserOnline = true; changes = 0; refusals = [];
  env = { window: new EventTarget(), document: new EventTarget(), online: () => browserOnline, visible: () => true, ticker: () => null };
  provider = new WebsocketProvider('ws://test/ws', '', new Y.Doc(), { params: { doc: 'a/b/c.tex', refusal: 'close' }, disableBc: true, connect: false, WebSocketPolyfill: FakeSocket as unknown as typeof WebSocket });
  watch = watchConnection(provider, { active: () => true, onChange: () => { changes++; }, onRefused: why => { refusals.push(why); } }, env);
  provider.connect();
});
afterEach(() => { watch.destroy(); provider.destroy(); vi.useRealTimers(); });
const connected = () => { last().open(); last().sync(); expect(provider.synced).toBe(true); };
const browserGoes = (on: boolean) => { browserOnline = on; env.window.dispatchEvent(new Event(on ? 'online' : 'offline')); };

describe('the browser says "offline"', () => {
  it('a socket that answers the ping stays: no new socket, nothing re-synced, never "offline"', () => {
    connected();
    browserGoes(false);
    expect(last().pings()).toBe(1);
    vi.advanceTimersByTime(300);
    last().receive(new Uint8Array([4]));   // the server's answer
    vi.advanceTimersByTime(PROBE_MS * 3);
    expect(FakeSocket.all).toHaveLength(1);
    expect(provider.wsconnected && provider.synced).toBe(true);
    expect(watch.offline()).toBe(false);
    // the hint flapping (eight times in half a minute in the telemetry) asks again, nothing more
    for (let i = 0; i < 8; i++) { browserGoes(true); browserGoes(false); last().receive(new Uint8Array([4])); vi.advanceTimersByTime(PROBE_MS + 1); }
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('a socket that hears nothing is replaced, and the editor says "offline" at once', () => {
    connected();
    browserGoes(false);
    expect(watch.offline()).toBe(false);   // (open: the probe decides)
    vi.advanceTimersByTime(PROBE_MS + 1);
    expect(FakeSocket.all).toHaveLength(2);   // a new attempt right away
    expect(FakeSocket.all[0].readyState).toBe(3);
    expect(provider.wsconnected).toBe(false);
    expect(watch.offline()).toBe(true);
    expect(watch.detail()).toMatch(/browser reports no network/);
    // the network back: connected again without waiting for the back-off
    last().refuseUpgrade();
    const before = FakeSocket.all.length;
    browserGoes(true);
    expect(FakeSocket.all.length).toBe(before + 1);
    connected();
    expect(watch.offline()).toBe(false);
  });

  it('with no open socket it says "offline" at once, without the grace', () => {
    connected();
    last().shut(1006);
    expect(watch.offline()).toBe(false);   // the grace: a server restart takes ~2 s
    browserGoes(false);
    expect(watch.offline()).toBe(true);
  });
});

describe('a lost connection', () => {
  it('reads "connecting…" for the grace, then "offline", while y-websocket keeps trying; a sync ends it', () => {
    connected();
    last().shut(1006);
    for (let t = 0; t < RECONNECT_GRACE_MS - 1000; t += 500) { vi.advanceTimersByTime(500); if (last().readyState === 0) last().refuseUpgrade(); }
    expect(watch.offline()).toBe(false);
    const n = changes;
    vi.advanceTimersByTime(1100);
    expect(watch.offline()).toBe(true);
    expect(changes).toBeGreaterThan(n);   // said when the grace ended, not at the next event
    vi.advanceTimersByTime(3000);
    connected();
    expect(watch.offline()).toBe(false);
  });

  it('a socket opened and closed at once (no sync) does not restart the grace', () => {
    connected();
    last().shut(1006);
    for (let i = 0; i < 6; i++) { vi.advanceTimersByTime(2600); last().open(); last().shut(4004, 'document not available'); }
    expect(watch.offline()).toBe(true);
  });
});

describe('a refused connection', () => {
  it('signed out: the reason, and attempts 5 s, 10 s, 20 s … apart, once a minute at most', () => {
    last().open(); last().shut(CLOSE_SIGNED_OUT, 'signed out');
    expect(watch.refused()).toBe('signed-out');
    expect(refusals).toEqual(['signed-out']);
    const gaps: number[] = [];
    let since = 0;
    for (let t = 0; t < 6 * REFUSED_RETRY_MS; t += 100) {
      vi.advanceTimersByTime(100); since += 100;
      if (last().readyState === 0) { gaps.push(since); since = 0; last().open(); last().shut(CLOSE_SIGNED_OUT, 'signed out'); }
    }
    // (y-websocket's own retries, ≤ 2.5 s apart, are over: its rule for 4400–4499)
    expect(gaps.slice(0, 6)).toEqual([REFUSED_FIRST_MS, 2 * REFUSED_FIRST_MS, 4 * REFUSED_FIRST_MS, 8 * REFUSED_FIRST_MS, REFUSED_RETRY_MS, REFUSED_RETRY_MS]);
    expect(refusals).toEqual(['signed-out']);   // said once
    expect(watch.refused()).toBe('signed-out');
  });

  it('signed in again in another tab: tried at once, and the refusal ends with the sync', () => {
    last().open(); last().shut(CLOSE_SIGNED_OUT, 'signed out');
    env.window.dispatchEvent(Object.assign(new Event('storage'), { key: 'ol.something' }));
    expect(FakeSocket.all).toHaveLength(1);
    env.window.dispatchEvent(Object.assign(new Event('storage'), { key: 'ol.user' }));
    expect(FakeSocket.all).toHaveLength(2);
    connected();
    expect(watch.refused()).toBe(null);
    vi.advanceTimersByTime(REFUSED_RETRY_MS * 2);
    expect(FakeSocket.all).toHaveLength(2);   // no retry timer left behind
  });

  it('no access: said, and tried again when the window gets the focus or the tab comes back', () => {
    last().open(); last().shut(CLOSE_NO_ACCESS, 'no access');
    expect(watch.refused()).toBe('no-access');
    env.window.dispatchEvent(new Event('focus'));
    expect(FakeSocket.all).toHaveLength(2);
    last().open(); last().shut(CLOSE_NO_ACCESS, 'no access');
    env.document.dispatchEvent(new Event('visibilitychange'));
    expect(FakeSocket.all).toHaveLength(3);
  });

  it('other closes are no refusal: y-websocket reconnects with its back-off', () => {
    connected();
    last().shut(4003, 'access changed');
    expect(watch.refused()).toBe(null);
    vi.advanceTimersByTime(3000);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('nothing is tried for an editor that may not connect (a stale copy, destroyed)', () => {
    watch.destroy();
    let active = false;
    watch = watchConnection(provider, { active: () => active, onChange: () => {} }, env);
    last().open(); last().shut(CLOSE_SIGNED_OUT);
    vi.advanceTimersByTime(REFUSED_RETRY_MS + 1);
    env.window.dispatchEvent(new Event('focus'));
    browserGoes(true);
    expect(FakeSocket.all).toHaveLength(1);
    active = true;
    env.window.dispatchEvent(new Event('focus'));
    expect(FakeSocket.all).toHaveLength(2);
  });
});
