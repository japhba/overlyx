import type { Snapshot } from 'yjs';

/** A transaction spanning both stores completes after earlier Yjs updates and pending flags. */
export function localWritesCommitted(db: IDBDatabase): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['updates', 'custom'], 'readonly');
    tx.objectStore('updates').count();
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('Local storage transaction was aborted'));
  });
}

/** Does the completed disk write cover every insertion AND deletion we need saved? */
export function snapshotCovers(saved: Snapshot, wanted: Snapshot): boolean {
  for (const [client, clock] of wanted.sv) if ((saved.sv.get(client) ?? 0) < clock) return false;
  for (const [client, ranges] of wanted.ds.clients) {
    const have = saved.ds.clients.get(client) ?? [];
    let i = 0;
    for (const range of ranges) {
      while (i < have.length && have[i].clock + have[i].len <= range.clock) i++;
      if (i === have.length || have[i].clock > range.clock || have[i].clock + have[i].len < range.clock + range.len) return false;
    }
  }
  return true;
}
