/**
 * Document workers: the whole-document work (parsing, writing, merging, tracked diffs — docwork.ts,
 * docedit.ts) runs in a few `worker_threads`, so that one document's save never makes every other
 * user of the server wait. Each worker keeps a mirror Y.Doc of the open documents it serves, kept
 * up to date with the CRDT updates the main thread forwards along with each request (docs.ts
 * OpenDoc.wsync); it does the work on the mirror and answers with the text, or with the CRDT
 * update an edit made, which the main thread applies to the real document.
 *
 * All documents of a project go to the same worker (a master includes its children's live state).
 * A worker processes one request at a time, in the order they were sent. A worker that dies (out
 * of memory on a pathological file) is replaced; its mirrors are rebuilt from the main thread's
 * state on the next request. OVERLYX_DOC_WORKERS=0 does everything on the main thread, as before.
 */
import { Worker } from 'node:worker_threads';

/** a document as the worker knows it */
export interface DocInfo { id: string; project: string; relPath: string; absPath: string }

/** bring a worker's mirror of a document up to date: its whole state (a new mirror), or the updates since the last request */
export interface SyncEntry { doc: DocInfo; full?: Uint8Array; updates: Uint8Array[] }

export interface WorkerRequest { id: number; op: string; doc: DocInfo | null; sync: SyncEntry[]; args: unknown }
export type WorkerResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string; resync?: boolean };

/** The worker went away while the request was in it (it is replaced; the request may be sent again). */
export class WorkerGone extends Error {}
/** The worker could not bring its mirrors up to date: they were dropped; send the whole state again. */
export class MirrorLost extends Error {}

interface Slot {
  worker: Worker | null;
  /** incremented whenever the worker is replaced: mirrors made by an earlier one are gone */
  gen: number;
  calls: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  /** projects assigned to this worker */
  projects: number;
}

const WORKER_URL = new URL('./docworker.ts', import.meta.url);

export class DocWorkers {
  private slots: Slot[];
  private assigned = new Map<string, number>();
  private nextId = 1;
  private deaths: number[] = [];
  /** the workers died too often: everything is done on the main thread from now on */
  private broken = false;

  constructor(readonly size: number) {
    this.slots = Array.from({ length: Math.max(0, size) }, () => ({ worker: null, gen: 0, calls: new Map(), projects: 0 }));
  }

  get enabled(): boolean { return this.slots.length > 0 && !this.broken; }

  /** The worker serving a project (assigned to the one with the fewest projects on first use). */
  slotOf(project: string): number {
    let s = this.assigned.get(project);
    if (s === undefined) {
      s = 0;
      for (let i = 1; i < this.slots.length; i++) if (this.slots[i].projects < this.slots[s].projects) s = i;
      this.assigned.set(project, s);
      this.slots[s].projects++;
    }
    return s;
  }

  /** A project has no open documents any more: its worker may be given to another one. */
  release(project: string): void {
    const s = this.assigned.get(project);
    if (s === undefined) return;
    this.assigned.delete(project);
    this.slots[s].projects--;
  }

  generation(slot: number): number { return this.slots[slot].gen; }

  /** Send a request; resolves with the op's result, rejects with its error (WorkerGone / MirrorLost: try again). */
  call(slot: number, op: string, doc: DocInfo | null, sync: SyncEntry[], args: unknown): Promise<unknown> {
    const s = this.slots[slot];
    const w = s.worker ?? this.spawn(slot);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      s.calls.set(id, { resolve, reject });
      if (s.calls.size === 1) w.ref();
      try { w.postMessage({ id, op, doc, sync, args } satisfies WorkerRequest); }
      catch (e) { s.calls.delete(id); if (!s.calls.size) w.unref(); reject(e as Error); }
    });
  }

  /** Tell a worker to drop its mirror of a document (closed); nothing to wait for. */
  forget(slot: number, gen: number, docId: string): void {
    const s = this.slots[slot];
    if (!s || s.gen !== gen || !s.worker) return;
    this.call(slot, 'forget', null, [], { ids: [docId] }).catch(() => { /* gone anyway */ });
  }

  /** Start the workers now (server start): loading their modules takes a moment the first open should not wait for. */
  warm(): void {
    if (!this.enabled) return;
    for (let i = 0; i < this.slots.length; i++) if (!this.slots[i].worker) this.spawn(i);
  }

  private spawn(slot: number): Worker {
    const s = this.slots[slot];
    // the server runs TypeScript through tsx (`node --import tsx`), and a worker inherits that; a
    // process that loaded TypeScript some other way (vitest) has the worker register tsx itself
    const viaTsx = process.execArgv.some(a => a.includes('tsx'));
    const w = new Worker(WORKER_URL, { name: `overlyx-doc-${slot}`, ...(viaTsx ? {} : { execArgv: ['--import', 'tsx'] }) });
    w.unref();
    s.worker = w;
    w.on('message', (m: WorkerResponse) => {
      const c = s.calls.get(m.id);
      if (!c) return;
      s.calls.delete(m.id);
      if (!s.calls.size && s.worker === w) w.unref();
      if (m.ok) c.resolve(m.result);
      else c.reject(m.resync ? new MirrorLost(m.error) : new Error(m.error));
    });
    w.on('error', (e) => console.error(`[docs] document worker ${slot} failed:`, e));
    w.on('exit', (code) => {
      if (s.worker !== w) return;
      s.worker = null;
      s.gen++;
      const calls = [...s.calls.values()];
      s.calls.clear();
      for (const c of calls) c.reject(new WorkerGone(`document worker ${slot} exited (${code})`));
      if (this.closing) return;
      console.error(`[docs] document worker ${slot} exited (code ${code}) — replaced on the next request`);
      const now = Date.now();
      this.deaths = this.deaths.filter(t => now - t < 60_000).concat(now);
      if (this.deaths.length >= 5) {
        this.broken = true;
        console.error('[docs] document workers keep dying — doing the document work on the main thread from now on');
      }
    });
    return w;
  }

  private closing = false;

  /** Stop the workers (tests; the server simply exits). */
  async close(): Promise<void> {
    this.closing = true;
    await Promise.all(this.slots.map(s => s.worker?.terminate()));
  }
}
