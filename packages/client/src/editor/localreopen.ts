/**
 * The local copy (y-indexeddb) after the browser closed its database on its own — Safari does so
 * for a tab left in the background or under storage pressure: no write goes through any more, and
 * each one rejects with "AbortError: The connection was closed." (error report #11, 19 Nov 2026).
 * The database is opened again and the whole document written once, so the copy is complete again.
 * Only an abnormal closure fires `close`; a page closing the database itself never does.
 */
import { openDB, createStores } from 'lib0/indexeddb';
import { storeState, type IndexeddbPersistence } from 'y-indexeddb';

export function keepLocalCopyOpen(p: IndexeddbPersistence, onReopened: () => void): void {
  const watch = (db: IDBDatabase) => db.addEventListener('close', () => {
    if (p._destroyed) return;
    p.db = null;   // y-indexeddb writes nothing while it has no database (its update handler checks)
    const next = openDB(p.name, d => createStores(d, [['updates', { autoIncrement: true }], ['custom']]));
    p._db = next;   // get / set / del wait for this one
    next.then(d => {
      if (p._destroyed) { d.close(); return; }
      p.db = d;
      watch(d);
      return storeState(p, true).then(onReopened);
    }).catch(() => { /* still closed: the save indicator keeps saying the local copy fails */ });
  });
  p._db.then(watch, () => {});
}
