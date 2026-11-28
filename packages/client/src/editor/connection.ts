/**
 * How an editor keeps its connection to the server (a y-websocket provider) and what it may say
 * about it — one rule for the document editor (editor.ts) and the deliverable editor
 * (deliverable/webHost.ts). The connection's own evidence decides; the browser's hints only hasten
 * a check:
 *
 * - The browser's `offline` event (navigator.onLine: wrong behind some VPNs, and on some Macs it
 *   flips several times a minute — 230 flips in 53 sessions a week, Nov 2026) does not close an open
 *   socket. It sends a ping the server answers at once (server ws.ts MSG_PING); a socket that hears
 *   nothing within PROBE_MS is dead and is replaced — and with the browser's word that the network is
 *   gone, the editor says "offline" at once. A socket that answers stays: no re-sync, no presence
 *   leaving and joining for the others, no "offline" while saving works.
 * - Otherwise a dead socket is found by y-websocket's watchdog (30 s without any message; the server
 *   sends one every 10 s) or by its closing.
 * - A socket that closed reads as "connecting…" for RECONNECT_GRACE_MS — a server restart for a
 *   deployment takes ~2 s and should not read as an outage — unless the browser says it is offline.
 * - `online` and the tab coming back to the foreground reconnect at once, without the back-off.
 * - Hidden tabs: browsers throttle the page's timers (Chrome: once a minute), so the presence renewal
 *   (every 15 s; the server drops a presence after 30 s) and the reconnect back-off fell behind. A
 *   worker's timer (heartbeat.ts) is not throttled: it renews the presence and reconnects.
 * - A refused connection — the session is signed out, or the user has no access to the document: the
 *   server closes with CLOSE_SIGNED_OUT / CLOSE_NO_ACCESS for editors that ask (`REFUSAL_PARAMS`, core
 *   collab/connect.ts) — stops y-websocket (its rule for 4400–4499). The editor says why and tries
 *   again when that could have changed: the tab comes back or gets the focus, the network comes
 *   back, somebody signs in in another tab — and by itself after 5 s, 10 s, 20 s … once a minute
 *   at most (access given a moment later, a race, is not waited out for a minute).
 */
import type { WebsocketProvider } from 'y-websocket';
import { CLOSE_SIGNED_OUT, CLOSE_NO_ACCESS } from '@overlyx/core/collab/connect.ts';
import type { Refusal } from './refusal';

export type { Refusal };

export const RECONNECT_GRACE_MS = 8000;
/** how long an open socket may take to answer a ping before it counts as dead */
export const PROBE_MS = 4000;
/** when a refused editor tries again by itself: after REFUSED_FIRST_MS, then twice as long each time, REFUSED_RETRY_MS at most */
export const REFUSED_FIRST_MS = 5000, REFUSED_RETRY_MS = 60000;
/** message type of the server's heartbeat, and of the ping it answers with one (server ws.ts) */
const MSG_PING = 4;

export interface ConnectionWatch {
  /** why the server refuses this editor; null: it does not (or has not said so since it last synced) */
  refused(): Refusal | null;
  /** no connection and none expected soon: closed longer than the grace, or closed while the browser says it is offline */
  offline(): boolean;
  /** why there is no connection, in words (the indicator's tooltip) */
  detail(): string;
  destroy(): void;
}

export interface WatchOptions {
  /** the editor may connect (false: a stale local copy that must not sync) */
  active(): boolean;
  /** what the watch says may have changed */
  onChange(): void;
  /** the server refused the connection (said when the reason changes) */
  onRefused?(why: Refusal): void;
}

/** what the watch listens to: the page's window and document, and a timer browsers do not throttle */
export interface WatchEnv {
  window: EventTarget;
  document: EventTarget;
  /** the browser's hint (navigator.onLine) */
  online(): boolean;
  visible(): boolean;
  /** a timer that ticks in hidden tabs too; null: none */
  ticker(): Pick<Worker, 'onmessage' | 'terminate'> | null;
}

const browserEnv = (): WatchEnv => ({
  window, document,
  online: () => navigator.onLine !== false,
  visible: () => document.visibilityState === 'visible',
  ticker: () => { try { return new Worker(new URL('./heartbeat.ts', import.meta.url), { type: 'module' }); } catch { return null; } },
});

/** the key App.tsx keeps the signed-in user under: written when somebody signs in, in any tab */
const USER_KEY = 'ol.user';

export function watchConnection(provider: WebsocketProvider, opts: WatchOptions, env: WatchEnv = browserEnv()): ConnectionWatch {
  let destroyed = false;
  const usable = () => !destroyed && opts.active();
  let disconnectedAt = 0;
  let lastInfo = '';
  let refused: Refusal | null = null, refusals = 0;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let probeTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const clear = (t: ReturnType<typeof setTimeout> | null) => { if (t) clearTimeout(t); return null; };

  /** a new socket now, whatever the back-off says */
  const restart = () => { if (!usable()) return; provider.disconnect(); provider.connect(); };
  const noteDisconnected = () => {
    if (disconnectedAt) return;
    disconnectedAt = Date.now();
    graceTimer = clear(graceTimer);
    graceTimer = setTimeout(() => { graceTimer = null; opts.onChange(); }, RECONNECT_GRACE_MS + 50);
  };
  const renewPresence = () => {
    const aw = provider.awareness;
    const meta = aw.meta.get(aw.clientID);
    if (aw.getLocalState() !== null && (!meta || Date.now() - meta.lastUpdated >= 15000)) aw.setLocalState(aw.getLocalState());
  };
  // the server's heartbeat, and its answer to a ping: counted (y-websocket's time of the last message
  // is Date.now(), which some browsers round to 100 ms or more — an answer could look like no news)
  let pings = 0;
  (provider as unknown as { messageHandlers: (() => void)[] }).messageHandlers[MSG_PING] = () => { pings++; };
  /** ask an open socket whether it is alive: the server answers a ping at once */
  const probe = () => {
    if (probeTimer || !provider.wsconnected || !provider.ws) return;
    const heard = pings;
    try { provider.ws.send(new Uint8Array([MSG_PING])); } catch { restart(); return; }
    probeTimer = setTimeout(() => {
      probeTimer = null;
      if (provider.wsconnected && pings === heard) restart();
    }, PROBE_MS);
  };

  const onStatus = ({ status }: { status: string }) => { if (status !== 'connected') noteDisconnected(); opts.onChange(); };
  // (the grace and a refusal end when the server synced: a socket that opens and is closed at once is no connection)
  const onSync = (synced: boolean) => {
    if (!synced) return;
    disconnectedAt = 0; graceTimer = clear(graceTimer); retryTimer = clear(retryTimer);
    lastInfo = ''; refusals = 0;
    if (refused) { refused = null; opts.onChange(); }
  };
  const onClose = (ev: CloseEvent | null) => {
    probeTimer = clear(probeTimer);
    if (ev) lastInfo = `closed with code ${ev.code}${ev.reason ? ': ' + ev.reason : ''}`;
    noteDisconnected();
    const why: Refusal | null = ev?.code === CLOSE_SIGNED_OUT ? 'signed-out' : ev?.code === CLOSE_NO_ACCESS ? 'no-access' : null;
    if (why) {
      retryTimer = clear(retryTimer);
      retryTimer = setTimeout(() => { retryTimer = null; restart(); }, Math.min(REFUSED_RETRY_MS, REFUSED_FIRST_MS * 2 ** refusals++));
      if (why !== refused) { refused = why; opts.onRefused?.(why); }
    }
    opts.onChange();
  };
  const onError = () => { lastInfo = 'connection attempt failed'; noteDisconnected(); opts.onChange(); };
  provider.on('status', onStatus);
  provider.on('sync', onSync);
  provider.on('connection-close', onClose);
  provider.on('connection-error', onError);

  const onOnline = () => { if (refused || !provider.wsconnected) restart(); opts.onChange(); };
  const onOffline = () => { if (usable()) probe(); opts.onChange(); };
  // back in the foreground: reconnect without the back-off, and tell the others we are here
  const onVisible = () => {
    if (!env.visible() || !usable()) return;
    if (!provider.wsconnected && !provider.wsconnecting) restart();
    else if (provider.wsconnected) renewPresence();
  };
  // a refused editor: what could have changed its answer
  const onChance = () => { if (refused && !provider.wsconnected && !provider.wsconnecting) restart(); };
  const onStorage = (ev: Event) => { if ((ev as StorageEvent).key === USER_KEY) onChance(); };
  env.window.addEventListener('online', onOnline);
  env.window.addEventListener('offline', onOffline);
  env.window.addEventListener('focus', onChance);
  env.window.addEventListener('storage', onStorage);
  env.document.addEventListener('visibilitychange', onVisible);
  const ticker = env.ticker();
  if (ticker) ticker.onmessage = () => {
    if (!usable()) return;
    if (provider.wsconnected) renewPresence();
    else if (provider.shouldConnect && !provider.wsconnecting && provider.ws === null) provider.connect();
  };

  return {
    refused: () => refused,
    offline: () => !provider.wsconnected && (!env.online() || (disconnectedAt > 0 && Date.now() - disconnectedAt >= RECONNECT_GRACE_MS)),
    detail: () => (env.online() ? 'no WebSocket connection to the server' : 'the browser reports no network connection') + (lastInfo ? ` (${lastInfo})` : '') + ' — reconnecting automatically',
    destroy() {
      destroyed = true;
      graceTimer = clear(graceTimer); probeTimer = clear(probeTimer); retryTimer = clear(retryTimer);
      provider.off('status', onStatus);
      provider.off('sync', onSync);
      provider.off('connection-close', onClose);
      provider.off('connection-error', onError);
      env.window.removeEventListener('online', onOnline);
      env.window.removeEventListener('offline', onOffline);
      env.window.removeEventListener('focus', onChance);
      env.window.removeEventListener('storage', onStorage);
      env.document.removeEventListener('visibilitychange', onVisible);
      ticker?.terminate();
    },
  };
}
