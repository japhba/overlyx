import * as Y from 'yjs';
import { MOVES_MAP, decodeRecord, idKey } from './moves';

/** Keep an unacknowledged local split/join editable until the server has
 * resolved that move together with the remote history. Applying the remote
 * split first can otherwise put the local joined suffix before its prefix. */
export class PendingMoves {
  private pending = new Set<string>();
  private queued: Uint8Array[] = [];
  private queuedItems = new Map<string, Y.Item>();
  private enabled = false;
  private readonly map: Y.Map<unknown>;

  constructor(private readonly doc: Y.Doc) {
    this.map = doc.getMap(MOVES_MAP);
    doc.on('afterTransaction', this.onTransaction);
  }

  private onTransaction = (tr: Y.Transaction) => {
    if (!this.enabled || !tr.local) return;
    for (const key of tr.changed.get(this.map as Y.AbstractType<any>) ?? []) {
      if (typeof key !== 'string') continue;
      const record = decodeRecord(key, this.map.get(key));
      if (record && !record.server && key.startsWith(`c${this.doc.clientID}-`)) this.pending.add(key);
    }
  };

  /** Enabled only by a server that advertises canonical move acknowledgments. */
  enable(): void {
    this.enabled = true;
    // A reloaded offline copy can contain moves authored by its previous client ID.
    for (const [key, value] of this.map) {
      const record = decodeRecord(key, value);
      if (record && !record.server && key.startsWith('c')) this.pending.add(key);
    }
  }

  get waiting(): boolean { return this.enabled && this.pending.size > 0; }

  /** Bytes received from the authoritative server, before they change the
   * editor. The returned update includes all deferred remote edits once every
   * outstanding local move has been adopted. Undefined means keep editing the
   * current local view while those acknowledgments are in flight. */
  receive(update: Uint8Array): Uint8Array | undefined {
    if (!this.waiting && !this.queued.length) return update;
    this.queued.push(update);
    const decoded = Y.decodeUpdate(update);
    // Canonical adopt records expire, but their deletion of this exact local
    // move item remains in the authoritative server's delete set on reconnect.
    // A raw echo or deletion of unrelated content does not acknowledge a move.
    for (const key of this.pending) {
      const item = this.map._map.get(key);
      if (item && (decoded.ds.clients.get(item.id.client) ?? []).some(range => range.clock <= item.id.clock && item.id.clock < range.clock + range.len)) this.pending.delete(key);
    }
    const items = decoded.structs.filter((struct): struct is Y.Item => struct instanceof Y.Item);
    for (const item of items) this.queuedItems.set(idKey(item.id), item);
    const find = (id: Y.ID): Y.Item | null => {
      const queued = this.queuedItems.get(idKey(id));
      if (queued) return queued;
      if (Y.getState(this.doc.store, id.client) <= id.clock) return null;
      const item = Y.getItem(this.doc.store, id);
      return item instanceof Y.Item ? item : null;
    };
    const location = (item: Y.Item, seen = new Set<string>()): { parent: unknown; key: string | null } | null => {
      if (item.parent !== null && item.parentSub !== null) return { parent: item.parent, key: item.parentSub };
      const key = idKey(item.id);
      if (seen.has(key) || seen.size >= 64) return null;
      seen.add(key);
      for (const anchor of [item.origin, item.rightOrigin]) {
        const neighbor = anchor && find(anchor);
        const inherited = neighbor && location(neighbor, seen);
        if (inherited) return { parent: item.parent ?? inherited.parent, key: item.parentSub ?? inherited.key };
      }
      return null;
    };
    for (const struct of items) {
      // A repair key reused after pruning inherits its map/key from a prior
      // item. That item may still be waiting in this queue rather than the doc.
      const at = location(struct);
      if (!at || (at.parent !== MOVES_MAP && at.parent !== this.map) || !at.key?.startsWith('s')) continue;
      for (const value of struct.content.getContent()) {
        const record = decodeRecord(at.key, value);
        if (record?.server) for (const key of record.adopt) this.pending.delete(key);
      }
    }
    if (this.waiting) return undefined;
    const merged = this.queued.length === 1 ? this.queued[0] : Y.mergeUpdates(this.queued);
    this.queued = [];
    this.queuedItems.clear();
    return merged;
  }

  destroy(): void {
    this.doc.off('afterTransaction', this.onTransaction);
    this.pending.clear(); this.queued = [];
    this.queuedItems.clear();
  }
}
