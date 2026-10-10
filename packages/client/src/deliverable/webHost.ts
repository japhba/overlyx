/**
 * The deliverable editor in the web app: the page's text is a Y.Text('html') synced with the server
 * (docs.ts HtmlDoc) over the documents' WebSocket, undone with a Y.UndoManager (agents' edits too,
 * like one's own), the folder served at /ol-d/<token>/ (deliverables.ts), uploads and file events
 * through the REST API, others' selections through the awareness.
 */
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import * as decoding from 'lib0/decoding';
import { splitDocId } from '@overlyx/core';
import { api, type User } from '../api';
import { subscribeProjectEvents } from '../projectevents';
import type { DeliverableHost, ChangeOrigin, Peer, Splice } from './host';
import type { Path } from './protocol';

export function webHost(id: string, user: User): DeliverableHost & { destroy(): void } {
  const { project, path } = splitDocId(id);
  const ydoc = new Y.Doc();
  const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  const provider = new WebsocketProvider(wsUrl, '', ydoc, { params: { doc: id }, disableBc: true });
  const handlers = (provider as unknown as { messageHandlers: ((enc: unknown, dec: decoding.Decoder) => void)[] }).messageHandlers;
  handlers[2] = (_e, dec) => { decoding.readVarString(dec); };
  handlers[3] = (_e, dec) => { decoding.readVarUint(dec); decoding.readVarUint8Array(dec); };
  handlers[4] = () => {};
  handlers[5] = (_e, dec) => { Y.applyUpdate(ydoc, decoding.readVarUint8Array(dec), 'agent'); };
  provider.awareness.setLocalStateField('user', { name: user.name, color: user.color, username: user.username, avatar: user.avatar ?? null });
  const text = ydoc.getText('html');
  const undo = new Y.UndoManager(text, { trackedOrigins: new Set(['canvas', 'code', 'agent']), captureTimeout: 600 });
  let readOnly = false;
  void api.readText(project, path).then(r => { readOnly = r.role === 'view'; }).catch(() => {});

  const peersOf = (): Peer[] => {
    const peers: Peer[] = [];
    provider.awareness.getStates().forEach((st, client) => {
      if (client === ydoc.clientID) return;
      const s = st as { user?: { name?: string; color?: string }; htmlSel?: { paths?: Path[] } };
      if (s.htmlSel?.paths?.length) peers.push({ paths: s.htmlSel.paths, color: s.user?.color ?? '#888', name: s.user?.name ?? '' });
    });
    return peers;
  };

  return {
    path,
    text: () => text.toString(),
    apply(splices: Splice[], origin) {
      if (readOnly || !splices.length) return;
      ydoc.transact(() => {
        for (const s of [...splices].sort((a, b) => b.from - a.from || b.to - a.to)) {
          if (s.to > s.from) text.delete(s.from, s.to - s.from);
          if (s.insert) text.insert(s.from, s.insert);
        }
      }, origin);
    },
    onChange(cb) {
      const f = (_e: Y.YTextEvent, tr: Y.Transaction) => cb((tr.origin === 'canvas' || tr.origin === 'code' ? tr.origin : 'remote') as ChangeOrigin);
      text.observe(f);
      return () => text.unobserve(f);
    },
    undo: () => { undo.undo(); },
    redo: () => { undo.redo(); },
    ready: () => provider.synced,
    onReady(cb) {
      const f = (s: boolean) => { if (s) cb(); };
      provider.on('sync', f);
      return () => provider.off('sync', f);
    },
    online: () => provider.wsconnected,
    onStatus(cb) { provider.on('status', cb); return () => provider.off('status', cb); },
    readOnly: () => readOnly,
    link: () => api.deliverableLink(project, path),
    upload: async (rel, data) => { await api.upload(project, rel, data, { overwrite: false }); },
    onAsset: cb => subscribeProjectEvents(project, ev => { if (ev.kind === 'graphics') cb(ev.path, ev.v); }),
    setSelection(paths) { try { provider.awareness.setLocalStateField('htmlSel', { paths }); } catch { /* closing */ } },
    onPeers(cb) {
      const f = () => cb(peersOf());
      provider.awareness.on('change', f);
      return () => provider.awareness.off('change', f);
    },
    downloads(open) {
      const q = `?path=${encodeURIComponent(path)}&download=1`;
      return [
        { label: 'PDF', action: () => window.open(`/api/projects/${encodeURIComponent(project)}/deliverable-pdf${q}`, '_blank') },
        { label: 'Web page (.zip, works offline)', action: () => window.open(`/api/projects/${encodeURIComponent(project)}/deliverable-zip${q}`, '_blank') },
        { label: 'Open in a new tab', action: () => window.open(open('view'), '_blank', 'noopener') },
      ];
    },
    destroy() {
      provider.awareness.setLocalState(null);
      provider.destroy();
      ydoc.destroy();
    },
  };
}
