/**
 * An Overleaf import started on the landing page, before signing in. The zips (File objects) and
 * the Git links + token are parked in IndexedDB — it survives the trip to Google and back — and
 * the start page picks them up once there is an account (Home.tsx) and runs the import. A stash
 * older than an hour is dropped; a synchronous flag in sessionStorage lets the app know one is
 * waiting without opening the database (the tour stays out of the way then). The zips are kept as
 * their bytes, not as File objects: Safari cannot store a Blob in IndexedDB in a private window
 * ("Error preparing Blob/File data to be stored in object store"), and the import was lost.
 */
const DB = 'overlyx:pending-import', STORE = 'import', KEY = 'current', FLAG = 'ol.pendingImport';
const MAX_AGE = 60 * 60 * 1000;

export interface PendingImport { links: string; token: string; zips: File[]; at: number }
/** A zip as stored: its bytes and what makes it a File again. */
interface StoredZip { name: string; type: string; lastModified: number; bytes: ArrayBuffer }
interface Stored { links: string; token: string; zips: (StoredZip | File)[]; at: number }

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error ?? new Error('indexedDB'));
    r.onblocked = () => rej(new Error('indexedDB blocked'));
  });
}
function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(db => new Promise<T>((res, rej) => {
    const t = db.transaction(STORE, mode);
    const q = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); res(q.result); };
    t.onerror = () => { db.close(); rej(t.error ?? new Error('indexedDB')); };
    t.onabort = () => { db.close(); rej(t.error ?? new Error('indexedDB aborted')); };
  }));
}
const setFlag = (on: boolean) => { try { if (on) sessionStorage.setItem(FLAG, '1'); else sessionStorage.removeItem(FLAG); } catch { /* ignore */ } };

/** Whether an import is waiting for the sign-in (cheap, synchronous). */
export function pendingImportFlag(): boolean { try { return sessionStorage.getItem(FLAG) === '1'; } catch { return false; } }

/** Park what the visitor chose; nothing chosen clears the stash. */
export async function stashPendingImport(p: { links: string; token: string; zips: File[] }): Promise<void> {
  const empty = !p.zips.length && !p.links.trim();
  setFlag(!empty);
  if (empty) { await tx('readwrite', s => s.delete(KEY)).catch(() => {}); return; }
  const zips = await Promise.all(p.zips.map(async f => ({ name: f.name, type: f.type, lastModified: f.lastModified, bytes: await f.arrayBuffer() })));
  const rec: Stored = { links: p.links, token: p.token, zips, at: Date.now() };
  await tx('readwrite', s => s.put(rec, KEY));
}

/** The waiting import, removed from the stash (null when there is none or it is stale). */
export async function takePendingImport(): Promise<PendingImport | null> {
  setFlag(false);
  let rec: Stored | undefined;
  try { rec = await tx<Stored | undefined>('readonly', s => s.get(KEY)); } catch { return null; }
  if (!rec) return null;
  await tx('readwrite', s => s.delete(KEY)).catch(() => {});
  if (Date.now() - rec.at > MAX_AGE) return null;
  // (a stash written before the zips were kept as bytes holds File objects; one that lost them yields nothing usable)
  const zips = (rec.zips ?? []).flatMap(z => z instanceof Blob ? [z] : z?.bytes instanceof ArrayBuffer ? [new File([z.bytes], z.name, { type: z.type, lastModified: z.lastModified })] : []);
  return zips.length || rec.links.trim() ? { links: rec.links, token: rec.token, zips, at: rec.at } : null;
}
