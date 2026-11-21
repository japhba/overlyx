/**
 * The local copy after the browser closed its database (Safari; error report #11 "AbortError: The
 * connection was closed."): editor/localreopen.ts opens it again and writes the whole document once;
 * the closing's rejected writes are no "Something went wrong" (error-reporting.ts STORAGE_CLOSED).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const opened: { name: string; db: EventTarget & { close: () => void } }[] = [];
vi.mock('lib0/indexeddb', () => ({
  openDB: (name: string) => { const db = Object.assign(new EventTarget(), { close: vi.fn() }); opened.push({ name, db }); return Promise.resolve(db); },
  createStores: () => {},
}));
const stored: unknown[] = [];
vi.mock('y-indexeddb', () => ({ storeState: (p: unknown, force: boolean) => { stored.push([p, force]); return Promise.resolve(); } }));

const { keepLocalCopyOpen } = await import('../packages/client/src/editor/localreopen');
const { STORAGE_CLOSED } = await import('../packages/client/src/error-reporting');

const tick = () => new Promise(r => setTimeout(r, 0));
const persistence = () => {
  const db = new EventTarget() as EventTarget & IDBDatabase;
  return { name: 'overlyx-doc:jan/p/a.tex', db, _db: Promise.resolve(db), _destroyed: false } as never as import('y-indexeddb').IndexeddbPersistence & { db: IDBDatabase | null };
};

describe('the local copy after the browser closed its database', () => {
  beforeEach(() => { opened.length = 0; stored.length = 0; });

  it('opens it again, writes the whole document, says so — and watches the new one too', async () => {
    const p = persistence(), first = p.db!;
    const reopened = vi.fn();
    keepLocalCopyOpen(p, reopened);
    await tick();
    first.dispatchEvent(new Event('close'));
    expect(p.db).toBeNull();          // no writes into the closed one meanwhile
    await tick(); await tick();
    expect(opened.map(o => o.name)).toEqual(['overlyx-doc:jan/p/a.tex']);
    expect(p.db).toBe(opened[0].db);
    expect(await p._db).toBe(opened[0].db);
    expect(stored).toEqual([[p, true]]);
    expect(reopened).toHaveBeenCalledTimes(1);
    opened[0].db.dispatchEvent(new Event('close'));
    await tick(); await tick();
    expect(opened).toHaveLength(2);
  });

  it('leaves a closed editor alone', async () => {
    const p = persistence(), first = p.db!;
    keepLocalCopyOpen(p, () => {});
    await tick();
    (p as { _destroyed: boolean })._destroyed = true;
    first.dispatchEvent(new Event('close'));
    await tick();
    expect(opened).toHaveLength(0);
  });

  it('the rejections of the cut-off writes are known (lib0 wraps the DOMException: "AbortError: …")', () => {
    for (const m of ['AbortError: The connection was closed.', 'The connection was closed.', 'InvalidStateError: The database connection is closing.']) expect(STORAGE_CLOSED.test(m)).toBe(true);
    for (const m of ['AbortError: The operation was aborted.', 'The connection was closed by the editor', 'TypeError: x is undefined']) expect(STORAGE_CLOSED.test(m)).toBe(false);
  });
});
