/**
 * Local copies from before the CRDT's model 2 (core collab/model.ts, 20 Oct 2026): editors kept
 * each document in IndexedDB as y-prosemirror's tree (`overlyx:<doc id>`). Such a copy can hold
 * edits made offline that the server never received. The server kept the old state of every
 * document it converted; the copy goes there whole, the server merges what it adds (three-way, the
 * way a changed file is merged), and the copy is deleted. A copy without unsaved edits is deleted at
 * once. Offline, nothing happens: the next open tries again.
 */
import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { api } from '../api';

/** the IndexedDB name prefix of the old copies */
export const LEGACY_DB_PREFIX = 'overlyx:';

const busy = new Set<string>();

export async function salvageLegacyCopy(docId: string): Promise<void> {
  const name = LEGACY_DB_PREFIX + docId;
  if (busy.has(name)) return;
  let dbs: { name?: string }[] | undefined;
  try { dbs = await (indexedDB as unknown as { databases?: () => Promise<{ name?: string }[]> }).databases?.(); } catch { return; }
  if (!dbs?.some(d => d.name === name)) return;
  busy.add(name);
  const ydoc = new Y.Doc();
  const store = new IndexeddbPersistence(name, ydoc);
  try {
    await store.whenSynced;
    const pending = await store.get('pending');
    if (pending === 1 && ydoc.share.has('prosemirror') && ydoc.getXmlFragment('prosemirror').length > 0) {
      const r = await api.legacyMerge(docId, Y.encodeStateAsUpdate(ydoc));
      if (r.merged) console.info(`[offline] the edits kept from the old editor were merged into ${docId}`);
      else if (r.reason) console.info(`[offline] the old local copy of ${docId}: ${r.reason}`);
    }
    await store.clearData();
  } catch (e) {
    console.warn(`[offline] the old local copy of ${docId} is kept for now:`, e);
    try { await store.destroy(); } catch { /* closed */ }
  } finally {
    busy.delete(name);
    ydoc.destroy();
  }
}
