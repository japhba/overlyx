/**
 * The deliverable editor in the web app: the page's text is a Y.Text('html') synced with the server
 * (docs.ts HtmlDoc) over the documents' WebSocket, undone with a Y.UndoManager (agents' edits too,
 * like one's own), the folder served at /ol-d/<token>/ (deliverables.ts), uploads and file events
 * through the REST API, others' selections through the awareness.
 */
import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { WebsocketProvider } from 'y-websocket';
import { connectParams } from '@overlyx/core/collab/connect.ts';
import * as decoding from 'lib0/decoding';
import { splitDocId } from '@overlyx/core';
import { lastSlide, noteSlide } from './slidememory';
import { api, type User } from '../api';
import { subscribeProjectEvents } from '../projectevents';
import type { DeliverableHost, ChangeOrigin, Peer, Splice } from './host';
import type { Path, TextCaret } from './protocol';
import { safeColor } from './runtime/carets';
import { localWritesCommitted, snapshotCovers } from '../editor/savedstate';
import { offlineFrames } from './offlineframes';
import { noteArticle } from '../articlekinds';
import { PRESENT_FIELD, watchPresenters } from '../app/presentshare';

/** Check that storage can actually be opened and written before y-indexeddb installs
 * its listeners. Its constructor leaves an unhandled rejection when private mode
 * rejects opening the database; online editing must still remain usable then. */
async function checkLocalStorage(name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => { finished = true; reject(new Error('Browser storage did not load')); }, 2500);
    const fail = (error: unknown) => { clearTimeout(timer); if (!finished) { finished = true; reject(error); } };
    let request: IDBOpenDBRequest;
    try { request = indexedDB.open(name, 1); }
    catch (error) { fail(error); return; }
    request.onupgradeneeded = () => { request.result.createObjectStore('updates', { autoIncrement: true }); request.result.createObjectStore('custom'); };
    request.onerror = () => fail(request.error);
    request.onsuccess = () => {
      const db = request.result;
      if (finished) { db.close(); return; }
      try {
        const tx = db.transaction(['updates', 'custom'], 'readwrite');
        // The exact document database must accept the same empty Yjs update the
        // persistence constructor stores before loading its cached history.
        tx.objectStore('updates').add(new Uint8Array([0, 0]));
        tx.oncomplete = () => { db.close(); clearTimeout(timer); finished = true; resolve(); };
        tx.onabort = () => { db.close(); fail(tx.error ?? new Error('Browser storage write failed')); };
        tx.onerror = () => {};
      } catch (error) { db.close(); fail(error); }
    };
  });
}

export function webHost(id: string, user: User): DeliverableHost & { destroy(): void } {
  const { project, path } = splitDocId(id);
  const ydoc = new Y.Doc();
  const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  // Load this history before connecting: an offline reopen must not start with a
  // fresh empty document, and histories from a replaced server file must not merge.
  const provider = new WebsocketProvider(wsUrl, '', ydoc, { params: connectParams(id), disableBc: true, connect: false });
  let persistence: IndexeddbPersistence | null = null;
  const handlers = (provider as unknown as { messageHandlers: ((enc: unknown, dec: decoding.Decoder, ...context: unknown[]) => void)[] }).messageHandlers;
  const text = ydoc.getText('html');
  // the text as one string for each version of it, not made anew at every ask: on a deck with much ink
  // it is half a MB, asked for many times an edit — and two equal copies compared as strings (a memo's
  // inputs) went through it a character at a time (while a change is being made: made each time)
  let shown: string | null = null, changing = false;
  ydoc.on('beforeTransaction', () => { changing = true; });
  ydoc.on('beforeObserverCalls', () => { changing = false; });
  text.observe(() => { shown = null; });
  const textNow = () => (changing ? text.toString() : (shown ??= text.toString()));
  const frames = offlineFrames(user.id, textNow, () => api.deliverableLink(project, path));
  const warmFrames = () => frames.changed();
  text.observe(warmFrames);
  const undo = new Y.UndoManager(text, { trackedOrigins: new Set(['canvas', 'code', 'agent']), captureTimeout: 600 });
  let destroyed = false, localReady = false, stale = false;
  let epoch: string | null = null;
  let editSeq = 0, savedSeq = 0, localWriteSeq = 0, localSavedSeq = 0;
  let pendingFromStore = false, localError: string | undefined;
  let storageFailed = false;
  const metadataFailures = new Map<string, string>();
  const storageWrites = new Set<Promise<void>>();
  const safeStorageWrites = (mirror: IndexeddbPersistence) => {
    // Observe completion/abort of the actual update transaction. The package's
    // fire-and-forget request can throw on quota failure and a later read barrier
    // cannot tell that earlier transaction failed. Keep failed drafts until saved.
    ydoc.off('update', mirror._storeUpdate);
    mirror._storeUpdate = (update, origin) => {
      if (origin === mirror || !mirror.db) return;
      const full = storageFailed;
      const compact = mirror._dbsize >= 500;
      let failed: unknown;
      let tx: IDBTransaction | undefined;
      const write = new Promise<void>((resolve, reject) => {
        try {
          tx = mirror.db!.transaction('updates', 'readwrite');
          const updates = tx.objectStore('updates');
          const save = () => {
            if (compact) updates.clear();
            updates.add(full || compact ? Y.encodeStateAsUpdate(ydoc) : update);
          };
          tx.oncomplete = () => { mirror._dbsize = compact ? 1 : mirror._dbsize + 1; if (full) { storageFailed = false; if (!metadataFailures.size) localError = undefined; } resolve(); };
          tx.onabort = () => reject(failed ?? tx!.error ?? new Error('Browser storage write failed'));
          tx.onerror = () => {};
          if (compact) {
            const all = updates.getAll();
            all.onsuccess = () => {
              try { ydoc.transact(() => all.result.forEach(bytes => Y.applyUpdate(ydoc, bytes)), mirror); save(); }
              catch (error) { failed = error; tx!.abort(); }
            };
          } else save();
        } catch (error) { failed = error; try { tx?.abort(); } catch { /* already ended */ } reject(error); }
      });
      storageWrites.add(write);
      void write.then(() => { storageWrites.delete(write); }, error => {
        storageWrites.delete(write); storageFailed = true; localError = String(error); emitSave();
      });
    };
    ydoc.on('update', mirror._storeUpdate);
  };
  let wanted: Y.Snapshot | null = null;
  const saveListeners = new Set<() => void>(), readyListeners = new Set<() => void>();
  const emitSave = () => { if (!destroyed) saveListeners.forEach(callback => callback()); };
  const pending = () => editSeq > savedSeq || pendingFromStore;
  const setMetadata = (key: string, value: string | number): Promise<void> => {
    const db = persistence?.db;
    if (!db) return Promise.resolve();
    const write = new Promise<void>((resolve, reject) => {
      try {
        const tx = db.transaction('custom', 'readwrite');
        tx.objectStore('custom').put(value, key);
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error ?? new Error('Browser metadata write failed'));
        tx.onerror = () => {};
      } catch (error) { reject(error); }
    });
    void write.then(() => {
      metadataFailures.delete(key);
      if (!storageFailed && !metadataFailures.size) localError = undefined;
    }, error => {
      metadataFailures.set(key, String(error)); localError = String(error); emitSave();
    });
    return write;
  };
  const storePending = () => { void setMetadata('pending', pending() ? 1 : 0).catch(error => { localError = String(error); emitSave(); }); };
  handlers[2] = (_e, dec) => {
    const next = decoding.readVarString(dec);
    if (epoch !== null && epoch !== next) {
      stale = true; provider.shouldConnect = false; provider.disconnect(); emitSave(); return;
    }
    epoch = next;
    void setMetadata('epoch', next).catch(error => { localError = String(error); emitSave(); });
  };
  // Epoch arrives before sync: do not even apply a new history once it mismatched.
  const syncHandler = handlers[0];
  handlers[0] = (enc, dec, ...context) => { if (!stale) syncHandler(enc, dec, ...context); };
  handlers[3] = (_e, dec) => {
    decoding.readVarUint(dec); decoding.readVarUint8Array(dec);
    if (decoding.hasContent(dec)) {
      const saved = Y.decodeSnapshot(decoding.readVarUint8Array(dec));
      if (snapshotCovers(saved, wanted ?? Y.snapshot(ydoc))) {
        savedSeq = editSeq; wanted = null; pendingFromStore = false; storePending();
      }
    }
    emitSave();
  };
  handlers[4] = () => {};
  handlers[5] = (_e, dec) => { if (!stale) Y.applyUpdate(ydoc, decoding.readVarUint8Array(dec), 'agent'); };
  provider.awareness.setLocalStateField('user', { name: user.name, color: user.color, username: user.username, avatar: user.avatar ?? null });
  ydoc.on('update', (_update: Uint8Array, origin: unknown) => {
    if (origin !== 'canvas' && origin !== 'code' && origin !== undo) return;
    editSeq++; wanted = Y.snapshot(ydoc);
    const written = ++localWriteSeq;
    storePending(); emitSave();
    // y-indexeddb queues its write before this listener. Wait for the containing
    // transaction, not just its request, before calling that local copy durable.
    void (persistence?.whenSynced ?? Promise.reject(new Error(localError ?? 'Browser storage is unavailable'))).then(async () => {
      if (destroyed) return;
      if (!persistence?.db) throw new Error('Browser storage is unavailable');
      await Promise.all([...storageWrites]);
      if (storageFailed) throw new Error(localError ?? 'Browser storage write failed');
      await localWritesCommitted(persistence.db);
      if (storageFailed || metadataFailures.size) throw new Error(localError ?? 'Browser metadata write failed');
      if (destroyed) return;
      localSavedSeq = Math.max(localSavedSeq, written); localError = undefined; emitSave();
    }).catch(error => { if (!destroyed) { localError = String(error); emitSave(); } });
  });
  provider.on('status', ({ status }: { status: string }) => { if (status === 'disconnected') frames.disconnected(); emitSave(); });
  provider.on('sync', (synced: boolean) => {
    if (synced && !stale) readyListeners.forEach(callback => callback());
    emitSave();
  });
  const onOnline = () => { if (!destroyed && !stale && localReady) { provider.disconnect(); provider.connect(); } emitSave(); };
  const onOffline = () => { frames.disconnected(); provider.disconnect(); emitSave(); };
  window.addEventListener('offline', onOffline); window.addEventListener('online', onOnline);
  void (async () => {
    try {
      await checkLocalStorage('overlyx:' + id);
      if (destroyed) return;
      persistence = new IndexeddbPersistence('overlyx:' + id, ydoc);
      safeStorageWrites(persistence);
      // A late cache must never be applied to a connected new history.
      await Promise.race([persistence.whenSynced, new Promise((_, reject) => setTimeout(() => reject(new Error('Browser storage did not load')), 2500))]);
      const [storedEpoch, storedPending] = await new Promise<[unknown, unknown]>((resolve, reject) => {
        const tx = persistence!.db!.transaction('custom', 'readonly');
        const epochRequest = tx.objectStore('custom').get('epoch'), pendingRequest = tx.objectStore('custom').get('pending');
        tx.oncomplete = () => resolve([epochRequest.result, pendingRequest.result]);
        tx.onabort = () => reject(tx.error ?? new Error('Browser metadata read failed'));
      });
      if (typeof storedEpoch === 'string') epoch = storedEpoch;
      else if (text.length) {
        // A cached history whose epoch write failed cannot safely be merged
        // with a server history. Keep its source downloadable for recovery.
        stale = true; provider.shouldConnect = false;
      }
      pendingFromStore = text.length > 0 && storedPending !== 0;
      if (pendingFromStore) wanted = Y.snapshot(ydoc);
    } catch (error) {
      localError = String(error);
      if (text.length && epoch === null) {
        stale = true; provider.shouldConnect = false;
      }
      // Prevent a delayed cache from merging into the history we now fetch.
      void persistence?.destroy().catch(() => {});
    }
    if (destroyed) return;
    localReady = true;
    if (text.length) readyListeners.forEach(callback => callback());
    emitSave(); if (!stale) provider.connect();
  })();
  let readOnly = false;
  const refreshRole = () => api.readText(project, path).then(r => { readOnly = r.role === 'view'; emitSave(); }).catch(() => {});
  void refreshRole();
  provider.on('connection-close', (event: CloseEvent | null) => {
    if (event?.code !== 4003) return;
    // Block immediately while the new role loads. A buffered keystroke must not
    // be reported accepted just because a view-only socket ignores its update.
    readOnly = true; emitSave(); void refreshRole();
  });
  provider.on('sync', (synced: boolean) => { if (synced) void refreshRole(); });

  // (another person's awareness is checked: it goes into the page's frame)
  const isPath = (p: unknown): p is Path => Array.isArray(p) && p.length < 64 && p.every(i => Number.isInteger(i) && i >= 0);
  const caretOf = (c: unknown): TextCaret | null => {
    const x = c as TextCaret | null;
    return x && isPath(x.path) && Number.isInteger(x.anchor) && Number.isInteger(x.head) && x.anchor >= 0 && x.head >= 0 ? { path: x.path, anchor: x.anchor, head: x.head } : null;
  };
  const peersOf = (): Peer[] => {
    const peers: Peer[] = [];
    provider.awareness.getStates().forEach((st, client) => {
      if (client === ydoc.clientID) return;
      const s = st as { user?: { name?: string; color?: string; username?: string }; htmlSel?: { paths?: unknown[] }; htmlCaret?: unknown; htmlSlide?: unknown };
      const paths = Array.isArray(s.htmlSel?.paths) ? s.htmlSel!.paths!.filter(isPath).slice(0, 200) : [];
      const caret = caretOf(s.htmlCaret);
      const slide = Number.isInteger(s.htmlSlide) && (s.htmlSlide as number) >= 0 ? s.htmlSlide as number : undefined;
      if (!paths.length && !caret && slide === undefined) return;
      peers.push({ paths, caret, slide, color: safeColor(s.user?.color), name: String(s.user?.name || s.user?.username || '').slice(0, 60) });
    });
    return peers;
  };

  /** the page made an article: its editor left first (its text must not sync into the document), then reopened as a document */
  const makeArticle = async () => {
    const back = location.hash;
    location.hash = '#/' + project;
    try { await api.asArticle(id); noteArticle(id, true); location.hash = '#/' + id; }
    catch (e) { location.hash = back; throw e; }
  };
  return {
    makeArticle,
    path,
    docId: id,
    author: () => user.name || user.username,
    bibliography: async keys => (keys.length ? (await api.bibKeys(id, keys)).entries : []),
    text: textNow,
    apply(splices: Splice[], origin, separateUndo = false) {
      if (readOnly || stale || !splices.length) return;
      if (separateUndo) undo.stopCapturing();
      try {
        ydoc.transact(() => {
          for (const s of [...splices].sort((a, b) => b.from - a.from || b.to - a.to)) {
            if (s.to > s.from) text.delete(s.from, s.to - s.from);
            if (s.insert) text.insert(s.from, s.insert);
          }
        }, origin);
      } finally { if (separateUndo) undo.stopCapturing(); }
    },
    onChange(cb) {
      const f = (_e: Y.YTextEvent, tr: Y.Transaction) => cb((tr.origin === 'canvas' || tr.origin === 'code' ? tr.origin : 'remote') as ChangeOrigin);
      text.observe(f);
      return () => text.unobserve(f);
    },
    undo: () => { if (!stale) undo.undo(); },
    redo: () => { if (!stale) undo.redo(); },
    ready: () => provider.synced || localReady && text.length > 0,
    onReady(cb) { readyListeners.add(cb); return () => readyListeners.delete(cb); },
    online: () => provider.wsconnected,
    onStatus(cb) { provider.on('status', cb); return () => provider.off('status', cb); },
    readOnly: () => readOnly || stale,
    saveState: () => ({ pending: pending(), localPending: localWriteSeq > localSavedSeq, localError,
      state: stale ? 'stale' : navigator.onLine === false || !provider.wsconnected ? (localReady ? 'offline' : 'connecting') : !provider.synced ? 'connecting' : pending() ? 'saving' : 'saved' }),
    discardLocal: async () => { await persistence?.destroy(); await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase('overlyx:' + id); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); request.onblocked = () => reject(new Error('Close other tabs displaying this file, then reopen it.')); }); },
    onSaveState(cb) { saveListeners.add(cb); return () => saveListeners.delete(cb); },
    link: () => api.deliverableLink(project, path),
    offlineFrame: frames.frame,
    offlineResources: frames.resources,
    onOfflineResources: frames.onResources,
    upload: async (rel, data) => {
      await api.upload(project, rel, data, { overwrite: false });
      try { await frames.uploaded(rel, data); } catch { /* The server upload succeeded; caching is optional. */ }
    },
    onAsset: cb => subscribeProjectEvents(project, ev => { if (ev.kind === 'graphics') { frames.changed(true); cb(ev.path, ev.v); } }),
    setSelection(paths) { try { provider.awareness.setLocalStateField('htmlSel', { paths }); } catch { /* closing */ } },
    setCaret(caret) { try { provider.awareness.setLocalStateField('htmlCaret', caret); } catch { /* closing */ } },
    setSlide(slide) { try { if (provider.awareness.getLocalState()?.htmlSlide !== slide) provider.awareness.setLocalStateField('htmlSlide', slide); } catch { /* closing */ } },
    lastSlide: () => lastSlide(id),
    noteSlide: slide => noteSlide(id, slide),
    onPeers(cb) {
      const f = () => cb(peersOf());
      provider.awareness.on('change', f);
      return () => provider.awareness.off('change', f);
    },
    setPresent(state) { try { provider.awareness.setLocalStateField(PRESENT_FIELD, state); } catch { /* closing */ } },
    onPresent: cb => watchPresenters(provider.awareness, cb),
    downloads(open) {
      const q = `?path=${encodeURIComponent(path)}&download=1`;
      return [
        { label: 'PDF', action: () => window.open(`/api/projects/${encodeURIComponent(project)}/deliverable-pdf${q}`, '_blank') },
        { label: 'Web page (.zip, works offline)', action: () => window.open(`/api/projects/${encodeURIComponent(project)}/deliverable-zip${q}`, '_blank') },
        { label: 'Open in a new tab', action: () => window.open(open('view'), '_blank', 'noopener') },
      ];
    },
    destroy() {
      text.unobserve(warmFrames); frames.destroy();
      destroyed = true;
      window.removeEventListener('offline', onOffline); window.removeEventListener('online', onOnline);
      saveListeners.clear(); readyListeners.clear();
      provider.awareness.setLocalState(null);
      provider.destroy();
      void persistence?.destroy().catch(() => {});
      ydoc.destroy();
    },
  };
}
