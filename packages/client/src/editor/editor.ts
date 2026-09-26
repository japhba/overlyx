/**
 * Editor assembly: ProseMirror view bound to a Yjs document (y-prosemirror), LyX keymap,
 * node views (MathLive, insets, graphics, commands), decorations and collaboration cursors.
 */
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import * as Y from 'yjs';
import { snapshotCovers, localWritesCommitted } from './savedstate';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';
import * as decoding from 'lib0/decoding';
import { ySyncPlugin, yCursorPlugin, yUndoPlugin, initProseMirrorDoc, ySyncPluginKey, relativePositionToAbsolutePosition } from 'y-prosemirror';
import { schema } from '@overlyx/core';
import { inkPlugin } from './plugins/ink';
import { editorContext } from './context';
import { readSavedCursor, writeSavedCursor, restoredCursorPos, type SavedCursor } from './cursormemory';
import { openRewriteMath } from './ai/rewrite';
import { installMathAssist } from './ai/mathassist';
import { getPrefs, subscribePrefs } from '../prefs';
import { assemblePlugins, editorViewProps, editorAttributes, dispatchTransactionProp, installEditorDom, flushDomSelection as flushSelection } from './assembly';
import type { User } from '../api';

installMathAssist();
editorContext.aiRewriteMath = (field) => openRewriteMath(field);

export interface EditorHandle {
  view: EditorView;
  ydoc: Y.Doc;
  provider: WebsocketProvider;
  /** editing is disabled until the document's metadata (authors, change tracking, macros) is known */
  setEditable(on: boolean): void;
  /** viewer of a shared project: no local transaction may change the document (remote updates still apply) */
  setViewOnly(on: boolean): void;
  /** current save / connection state */
  saveState(): SaveState;
  /** forget the local (IndexedDB) copy of this document; used after an epoch conflict */
  discardLocal(): Promise<void>;
  /** move the cursor to where another user (an awareness client) is editing and scroll there; false if unknown */
  gotoUser(clientId: number): boolean;
  destroy(): void;
}

/** A user connected to the document (one entry per browser tab / awareness client). */
export interface PresenceUser { name: string; color: string; username?: string; /** profile picture URL (Google sign-in), if any */ avatar?: string | null; clientId: number; /** has a known cursor position in this document */ hasCursor: boolean; self: boolean }

/**
 * Where the user's edits are: `saved` = the .lyx file on the server contains everything, `saving` =
 * edits are on their way to the server / not written yet, `offline` = no connection (edits are kept
 * in this browser and sync later), `connecting` = not synced yet after opening.
 */
export interface SaveState {
  state: 'saved' | 'saving' | 'offline' | 'connecting' | 'stale';
  /** local edits the server has not confirmed as written */
  pending: boolean;
  /** The newest edits have not yet been committed to browser storage. */
  localPending?: boolean;
  localError?: string;
  /** time of the last write to the .lyx file (server clock, ms) */
  savedAt: number;
  /** offline and nothing cached locally: the document cannot be shown */
  unavailable: boolean;
  /** why there is no connection (diagnostics for the tooltip) */
  detail?: string;
}

export interface EditorOptions {
  docId: string;
  user: User;
  container: HTMLElement;
  marginMode?: boolean;
  /** a child document rendered below its master (combined view) */
  child?: boolean;
  onStatus?: (s: { connected: boolean; synced: boolean; users: PresenceUser[] }) => void;
  /** the selection changed; `docChanged`: because the document changed (typing, remote edits, loading), not by a cursor move */
  onSelectionChange?: (view: EditorView, info: { docChanged: boolean }) => void;
  onDocChange?: (view: EditorView) => void;
  /**
   * The server's document has a different history (epoch) than the local copy — it was re-created
   * (e.g. the server's database was reset). The local state cannot be merged and must be discarded;
   * `pendingLocal` tells whether it holds edits the server never received (the caller can save them
   * as a version before discarding).
   */
  onStale?: (info: { pendingLocal: boolean }) => void;
  /** the server closed the connection because this user's access to the project changed (revoked, or a new role) */
  onAccessChanged?: () => void;
  /** the document is gone on the server (file deleted / project removed / history reset) */
  onGone?: (reason: string) => void;
  onSaveState?: (s: SaveState) => void;
  /** start read-only (until `setEditable(true)`) */
  readOnly?: boolean;
  /** where to put the cursor once the document is loaded (navigation history); null: the remembered place */
  initialCursor?: () => SavedCursor | null;
}

/** IndexedDB database name of a document's local copy */
export const localDbName = (docId: string) => 'overlyx:' + docId;

/**
 * Local copies kept under a document's old id — from before projects lived in their owner's
 * namespace (`thesis/main.tex`, now `jan/thesis/main.tex`) — are copied to its current id, offline
 * edits the server has not seen yet included; the old copy stays. `ids`: old id → current id.
 */
export async function moveLocalCopies(ids: Record<string, string>): Promise<void> {
  const dbs = await (indexedDB as any).databases?.() as { name?: string }[] | undefined;
  const have = new Set((dbs ?? []).map(d => d.name));
  for (const [from, to] of Object.entries(ids)) {
    if (!have.has(localDbName(from)) || have.has(localDbName(to))) continue;
    const ydoc = new Y.Doc();
    const src = new IndexeddbPersistence(localDbName(from), ydoc);
    try {
      await src.whenSynced;
      const [epoch, pending] = await Promise.all([src.get('epoch'), src.get('pending')]);
      const dst = new IndexeddbPersistence(localDbName(to), ydoc);   // stores the loaded state under the new name
      await dst.whenSynced;
      if (epoch !== undefined) await dst.set('epoch', epoch);
      if (pending !== undefined) await dst.set('pending', pending);
      await dst.destroy();
    } catch (e) { console.warn(`[offline] could not move the local copy of ${from}:`, e); }
    finally { await src.destroy(); ydoc.destroy(); }
  }
}

export function createEditor(opts: EditorOptions): EditorHandle {
  const ydoc = new Y.Doc();
  const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  // disableBc: y-websocket would otherwise sync all providers of this origin that share the (empty)
  // room name through a BroadcastChannel — i.e. merge *different documents* open in other tabs or in
  // the combined master+child view into each other. Documents are only synced through the server.
  // y-websocket appends the room name to the url; we pass the doc as a query param instead.
  // The connection is opened once the local copy has been loaded (see below).
  const provider = new WebsocketProvider(wsUrl, '', ydoc, { params: { doc: opts.docId }, disableBc: true, connect: false });
  let destroyed = false;

  /* ---------------------------------------------------------------- offline copy + save state
   * Every document is mirrored in IndexedDB (y-indexeddb): it renders instantly on the next open,
   * and while offline edits keep going into the local copy; on reconnect the Yjs sync exchanges
   * exactly the missing updates in both directions (CRDT merge, no conflicts).
   *
   * Save acknowledgments carry the snapshot actually written, including its delete set.
   * Receipt time says nothing about which local edits reached that completed write. */
  const persistence = new IndexeddbPersistence(localDbName(opts.docId), ydoc);
  let editSeq = 0, savedSeq = 0;
  let localWriteSeq = 0, localSavedSeq = 0;
  let localError: string | undefined;
  let savedAt = 0;
  let localSynced = false;      // IndexedDB copy loaded
  let localEmpty = true;
  let pendingFromStore = false; // the stored copy had unsaved edits when it was last used
  let lastConnInfo = '';
  // A lost connection is reported as "connecting…" for a few seconds before it becomes "offline":
  // the server restarts in ~2 s for a deployment and the WebSocket reconnects right away, which
  // should not read as an outage. (The browser's own offline signal is shown immediately.)
  const RECONNECT_GRACE_MS = 8000;
  let disconnectedAt = 0;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  const inGrace = () => navigator.onLine !== false && disconnectedAt > 0 && Date.now() - disconnectedAt < RECONNECT_GRACE_MS;
  const noteDisconnected = () => {
    if (disconnectedAt) return;
    disconnectedAt = Date.now();
    if (graceTimer) clearTimeout(graceTimer);
    graceTimer = setTimeout(() => { graceTimer = null; emitSaveState(); }, RECONNECT_GRACE_MS + 50);
  };
  const saveState = (): SaveState => {
    const pending = editSeq > savedSeq || pendingFromStore;
    const connected = provider.wsconnected;
    const state: SaveState['state'] = stale ? 'stale' : connected && provider.synced ? (pending ? 'saving' : 'saved') : connected || !localSynced || inGrace() ? 'connecting' : 'offline';
    let detail: string | undefined;
    if (state === 'offline') {
      detail = navigator.onLine === false ? 'the browser reports no network connection' : 'no WebSocket connection to the server';
      if (lastConnInfo) detail += ` (${lastConnInfo})`;
      detail += ' — reconnecting automatically';
    }
    return { state, pending, localPending: localWriteSeq > localSavedSeq, localError, savedAt, unavailable: state === 'offline' && localEmpty, detail };
  };
  let lastEmitted = '';
  const emitSaveState = () => {
    const st = saveState();
    const key = JSON.stringify(st);
    if (key === lastEmitted) return;
    lastEmitted = key;
    if (st.pending !== pendingFromStore || !st.pending) { pendingFromStore = st.pending; void persistence.set('pending', st.pending ? 1 : 0).catch(() => {}); }
    opts.onSaveState?.(st);
  };
  /** origin of updates applied via messageHandlers[5] (the embedded agent's edits): tracked by
   *  the undo manager so Ctrl+Z reverts them, skipped by the local-edit bookkeeping below */
  const AGENT_EDIT_ORIGIN = 'agent-edit';
  ydoc.on('update', (_u: Uint8Array, origin: unknown) => {
    if (origin === provider || origin === persistence || origin === AGENT_EDIT_ORIGIN) return;
    editSeq++;
    const written = ++localWriteSeq;
    emitSaveState();
    // y-indexeddb queues its write before this listener. Its request's success alone
    // is insufficient: wait for transaction completion before saying the edit is kept.
    void persistence.whenSynced.then(async () => {
      if (destroyed) return;
      if (!persistence.db) throw new Error('Browser storage is unavailable');
      await localWritesCommitted(persistence.db);
      if (destroyed) return;
      localSavedSeq = Math.max(localSavedSeq, written);
      localError = undefined;
      emitSaveState();
    }).catch(error => { if (!destroyed) { localError = String(error); emitSaveState(); } });
  });
  ydoc.on('update', () => { localEmpty = ydoc.getXmlFragment('prosemirror').length === 0; });
  (provider as any).messageHandlers[3] = (_enc: unknown, dec: decoding.Decoder) => {
    savedAt = decoding.readVarUint(dec);
    decoding.readVarUint8Array(dec);   // legacy state vector
    if (decoding.hasContent(dec) && snapshotCovers(Y.decodeSnapshot(decoding.readVarUint8Array(dec)), Y.snapshot(ydoc))) {
      savedSeq = editSeq;
      pendingFromStore = false;
    }
    emitSaveState();
  };
  // Message type 4 = server heartbeat (no payload): it only refreshes y-websocket's "last message
  // received" watchdog, so a healthy connection in a throttled background tab stays open.
  (provider as any).messageHandlers[4] = () => {};

  // Message type 2 = document epoch (OverLyX extension, sent by the server before sync step 1). If the
  // server's Yjs history differs from the one our local copy belongs to (the server re-created the
  // document), syncing would merge two unrelated histories: bail out instead and let the UI decide.
  let epoch: string | null = null;
  let stale = false;
  provider.on('connection-close', (ev: CloseEvent | null) => {
    if (ev) lastConnInfo = `closed with code ${ev.code}${ev.reason ? ': ' + ev.reason : ''}`;
    noteDisconnected();
    emitSaveState();
    if (ev?.code === 4003) opts.onAccessChanged?.();
    if (ev?.code === 4001 || ev?.code === 4004) opts.onGone?.(ev.reason || 'document not available');
  });
  provider.on('connection-error', () => { lastConnInfo = 'connection attempt failed'; noteDisconnected(); emitSaveState(); });
  // A remote update dispatched between a mouse click and the browser's (asynchronous)
  // `selectionchange` event would make ProseMirror write its stale state selection back into the
  // DOM and the click would be lost (y-prosemirror restores the *state* selection after applying
  // remote changes). Reading the DOM selection before applying any sync message closes that gap.
  // (Both document updates and awareness updates: remote cursors are decorations, and ProseMirror
  // re-writes the DOM selection whenever decorations change, unless the mouse button is still down.)
  const flushDomSelection = () => flushSelection(viewRef);
  {
    const orig = (provider as any).messageHandlers[0];
    (provider as any).messageHandlers[0] = (...args: unknown[]) => { flushDomSelection(); return orig(...args); };
  }
  // Message type 5 = an edit by the embedded agent (OverLyX extension): the same update bytes the
  // sync copy carries, applied here first with a *tracked* origin so Ctrl+Z can revert the agent
  // like one's own typing (yUndoPlugin below tracks this origin; the MSG_SYNC copy that follows
  // is an idempotent no-op). Other collaborators' edits remain un-undoable, as they should be.
  (provider as any).messageHandlers[5] = (_enc: unknown, dec: decoding.Decoder) => {
    flushDomSelection();
    Y.applyUpdate(ydoc, decoding.readVarUint8Array(dec), AGENT_EDIT_ORIGIN);
  };
  (provider as any).messageHandlers[2] = (_enc: unknown, dec: decoding.Decoder) => {
    const e = decoding.readVarString(dec);
    if (epoch !== null && e !== epoch && !stale) {
      stale = true;
      provider.shouldConnect = false;
      provider.disconnect();
      opts.onStale?.({ pendingLocal: editSeq > savedSeq || pendingFromStore });
      return;
    }
    if (epoch !== e) { epoch = e; void persistence.set('epoch', e).catch(() => {}); }
  };
  const connectAfterLocalLoad = async () => {
    try {
      await Promise.race([persistence.whenSynced, new Promise(r => setTimeout(r, 2500))]);
      const [storedEpoch, pending] = await Promise.all([persistence.get('epoch'), persistence.get('pending')]);
      if (typeof storedEpoch === 'string') epoch = storedEpoch;
      pendingFromStore = pending === 1;
    } catch { /* no IndexedDB (private mode, …): work without a local copy */ }
    localSynced = true;
    localEmpty = ydoc.getXmlFragment('prosemirror').length === 0;
    if (destroyed) return;
    performance.mark('ol:local-loaded');
    if (!localEmpty) restoreCursor();
    emitSaveState();
    // always try — navigator.onLine is unreliable (Chrome reports "offline" behind some VPNs / network
    // setups); a failing attempt just makes y-websocket retry with backoff
    provider.connect();
  };
  void connectAfterLocalLoad();
  const fragment = ydoc.getXmlFragment('prosemirror');
  const { doc: initialDoc, mapping } = initProseMirrorDoc(fragment, schema);

  provider.awareness.setLocalStateField('user', { name: opts.user.name, color: opts.user.color, username: opts.user.username, avatar: opts.user.avatar ?? null });

  const plugins = assemblePlugins({
    sync: [
      ySyncPlugin(fragment, { mapping }),
      yCursorPlugin(provider.awareness, {
        cursorBuilder: (user: { name: string; color: string }, clientId?: number) => {
          const cursor = document.createElement('span');
          cursor.className = 'ProseMirror-yjs-cursor';
          if (clientId !== undefined) cursor.dataset.client = String(clientId);
          cursor.style.borderColor = user.color;
          const label = document.createElement('div');
          label.style.backgroundColor = user.color;
          label.textContent = user.name;
          cursor.appendChild(label);
          return cursor;
        },
      }),
      yUndoPlugin({ trackedOrigins: [AGENT_EDIT_ORIGIN] }),
    ],
    marginMode: opts.marginMode ?? false,
    // margin ink: one layer per document view (child editors of a combined view share the master's margins)
    ink: opts.child ? null : inkPlugin(provider.awareness),
    getView: () => viewRef,
    onUpdate: (view, info) => {
      opts.onSelectionChange?.(view, { docChanged: info.docChanged });
      if (info.docChanged) opts.onDocChange?.(view);
      if (cursorRestored && info.selectionChanged) rememberCursor();
    },
  });

  const state = EditorState.create({ schema, doc: initialDoc, plugins });
  let viewRef: EditorView | null = null;
  // cursor memory (see cursormemory.ts): written a moment after each move, restored once the document is here
  let cursorRestored = false;
  // a restored cursor also gets the keyboard (as in LyX), once editing is allowed and unless something else has it
  let focusWhenEditable = false;
  const focusRestored = () => { const a = document.activeElement; if (!a || a === document.body) view.focus(); };
  let cursorTimer: ReturnType<typeof setTimeout> | undefined;
  const rememberCursor = () => { clearTimeout(cursorTimer); cursorTimer = setTimeout(() => { if (viewRef && !destroyed) writeSavedCursor(opts.docId, viewRef.state); }, 250); };
  const flushCursor = () => { if (cursorRestored && viewRef && !destroyed) { clearTimeout(cursorTimer); writeSavedCursor(opts.docId, viewRef.state); } };
  window.addEventListener('pagehide', flushCursor);
  let editable = !opts.readOnly;
  let viewOnly = false;
  const view: EditorView = new EditorView(opts.container, {
    state,
    editable: () => editable,
    dispatchTransaction: dispatchTransactionProp(() => view, () => viewOnly),
    attributes: editorAttributes(!!opts.child, getPrefs()),
    ...editorViewProps({ docId: opts.docId, viewOnly: () => viewOnly }),
  });
  viewRef = view;
  performance.mark('ol:editor-created');
  // the spell-check switch (Tools ▸ Spell checking) applies to open editors right away
  const unsubscribePrefs = subscribePrefs(p => { view.setProps({ attributes: editorAttributes(!!opts.child, p) }); });
  installEditorDom(view, opts.docId);

  const status = { connected: false, synced: false, users: [] as PresenceUser[] };
  const pushStatus = () => {
    const users: PresenceUser[] = [];
    provider.awareness.getStates().forEach((s, clientId) => { if (s.user) users.push({ name: s.user.name, color: s.user.color, username: s.user.username, avatar: s.user.avatar ?? null, clientId, hasCursor: !!s.cursor, self: clientId === ydoc.clientID }); });
    status.users = users;
    opts.onStatus?.({ ...status });
  };
  /** Absolute document position of another client's cursor head, if it is in this document. */
  const userCursorPos = (clientId: number): number | null => {
    const st = provider.awareness.getStates().get(clientId);
    if (!st?.cursor) return null;
    const ystate = ySyncPluginKey.getState(view.state);
    if (!ystate || ystate.binding.mapping.size === 0) return null;
    try {
      const pos = relativePositionToAbsolutePosition(ystate.doc, ystate.type, Y.createRelativePositionFromJSON(st.cursor.head), ystate.binding.mapping);
      return pos === null ? null : Math.min(pos, view.state.doc.content.size - 1);
    } catch { return null; }
  };
  provider.on('status', (e: { status: string }) => {
    status.connected = e.status === 'connected';
    if (status.connected) { disconnectedAt = 0; if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; } } else noteDisconnected();
    pushStatus(); emitSaveState();
  });
  provider.on('sync', (s: boolean) => {
    status.synced = s;
    if (s) {
      performance.mark('ol:synced');
      // edits stored from an earlier session stay "pending" until the server confirms it wrote them
      if (pendingFromStore) editSeq = Math.max(editSeq, savedSeq + 1);
    }
    pushStatus(); emitSaveState();
  });
  provider.awareness.on('change', pushStatus);
  // The browser's online/offline events give immediate feedback (the WebSocket itself only notices a
  // dead connection through y-websocket's 30 s watchdog). They are hints only: after an "offline"
  // event we keep trying to connect every few seconds, since the flag is wrong in some setups.
  let retry: ReturnType<typeof setInterval> | null = null;
  const stopRetry = () => { if (retry) { clearInterval(retry); retry = null; } };
  const reconnect = () => { if (destroyed || stale) return; if (!provider.wsconnected) { provider.disconnect(); provider.connect(); } };
  const onOnline = () => { stopRetry(); reconnect(); };
  const onOffline = () => {
    if (destroyed || stale) return;
    provider.disconnect(); emitSaveState();
    stopRetry();
    retry = setInterval(() => { if (provider.wsconnected) stopRetry(); else reconnect(); }, 5000);
  };
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  const protectUnstoredEdits = (event: BeforeUnloadEvent) => {
    if (saveState().pending && localWriteSeq > localSavedSeq) { event.preventDefault(); event.returnValue = ''; }
  };
  window.addEventListener('beforeunload', protectUnstoredEdits);
  // Hidden tabs: the page's timers are throttled (Chrome wakes a long-hidden tab once a minute), so
  // the presence renewal (every 15 s, the server drops a user's presence after 30 s) and the
  // reconnect back-off timer fall behind, and the user appeared to go offline whenever their tab
  // was covered. A worker's timer is not throttled: it renews the presence state when the page's
  // own timer missed it and reconnects a dropped connection without waiting for the back-off.
  const renewPresence = () => {
    const aw = provider.awareness;
    const meta = aw.meta.get(ydoc.clientID);
    if (aw.getLocalState() !== null && (!meta || Date.now() - meta.lastUpdated >= 15000)) aw.setLocalState(aw.getLocalState());
  };
  const keepAlive = () => {
    if (destroyed || stale) return;
    if (provider.wsconnected) renewPresence();
    else if (provider.shouldConnect && !provider.wsconnecting && provider.ws === null) provider.connect();
  };
  let heartbeat: Worker | null = null;
  try {
    heartbeat = new Worker(new URL('./heartbeat.ts', import.meta.url), { type: 'module' });
    heartbeat.onmessage = keepAlive;
  } catch { /* no worker support: the page timers still do their best */ }
  // Back in the foreground: reconnect immediately (no back-off) and tell the others we are here.
  const onVisible = () => {
    if (document.visibilityState !== 'visible' || destroyed || stale) return;
    if (!provider.wsconnected && !provider.wsconnecting) reconnect();
    else if (provider.wsconnected) renewPresence();
  };
  document.addEventListener('visibilitychange', onVisible);

  // Cursor where it was the last time this document was open here (else at the start), once the
  // document is available: from the local copy, or from the server. Children (combined view) keep
  // their own start. The remote cursors / formulas render later and change the layout, so the
  // place is scrolled to once more shortly after.
  function restoreCursor() {
    if (cursorRestored || opts.child || destroyed) return;
    cursorRestored = true;
    try {
      const doc = view.state.doc;
      const saved = opts.initialCursor?.() ?? readSavedCursor(opts.docId);
      const sel = saved ? TextSelection.near(doc.resolve(restoredCursorPos(doc, saved))) : TextSelection.atStart(doc);
      view.dispatch(view.state.tr.setSelection(sel).scrollIntoView().setMeta('addToHistory', false));
      if (saved) {
        if (editable) focusRestored(); else focusWhenEditable = true;
        setTimeout(() => { if (!destroyed && view.state.selection.eq(sel)) view.dispatch(view.state.tr.scrollIntoView()); }, 400);
      }
    } catch { /* empty document */ }
  }
  if (!opts.child) {
    const once = (s: boolean) => {
      if (!s) return;
      provider.off('sync', once);
      restoreCursor();
    };
    provider.on('sync', once);
  }

  return {
    view, ydoc, provider,
    setEditable(on: boolean) {
      if (on !== editable) { editable = on; view.setProps({ editable: () => editable }); }
      if (on && focusWhenEditable) { focusWhenEditable = false; focusRestored(); }
    },
    setViewOnly(on: boolean) { viewOnly = on; view.dom.classList.toggle('view-only', on); },
    saveState,
    async discardLocal() { try { await persistence.clearData(); } catch { /* ignore */ } },
    gotoUser(clientId: number) {
      const pos = userCursorPos(clientId);
      if (pos === null) return false;
      try {
        const sel = TextSelection.near(view.state.doc.resolve(pos));
        view.dispatch(view.state.tr.setSelection(sel).scrollIntoView().setMeta('addToHistory', false));
      } catch { return false; }
      view.focus();
      // show where they are: flash their cursor label
      requestAnimationFrame(() => {
        const el = view.dom.querySelector(`.ProseMirror-yjs-cursor[data-client="${clientId}"]`) as HTMLElement | null;
        el?.scrollIntoView({ block: 'center', inline: 'nearest' });
        if (el) { el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1600); }
      });
      return true;
    },
    destroy() {
      flushCursor();
      unsubscribePrefs();
      window.removeEventListener('pagehide', flushCursor);
      destroyed = true;
      stopRetry();
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('beforeunload', protectUnstoredEdits);
      document.removeEventListener('visibilitychange', onVisible);
      heartbeat?.terminate();
      if (graceTimer) clearTimeout(graceTimer);
      // the view first: its Yjs binding must be gone before the provider/awareness fire their last events
      view.destroy();
      provider.awareness.setLocalState(null);
      provider.destroy();
      persistence.destroy();
      ydoc.destroy();
    },
  };
}
