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
 * state on the next request. A request that runs past a bound (REQUEST_LIMIT_MS: a parse or merge
 * that never ends) would hold every request behind it — every document's saves and stored states —
 * so the worker is ended and replaced the same way, and that request fails (WorkerTimeout).
 * OVERLYX_DOC_WORKERS=0 does everything on the main thread, as before.
 */
import { Worker } from 'node:worker_threads';

/** a document as the worker knows it */
export interface DocInfo { id: string; project: string; relPath: string; absPath: string }

/** bring a worker's mirror of a document up to date: its whole state (a new mirror), or the updates since the last request */
export interface SyncEntry { doc: DocInfo; full?: Uint8Array; updates: Uint8Array[] }

export interface WorkerRequest { id: number; op: string; doc: DocInfo | null; sync: SyncEntry[]; args: unknown }
export type WorkerResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string; stack?: string; resync?: boolean };

/** The worker went away while the request was in it (it is replaced; the request may be sent again). */
export class WorkerGone extends Error {}
/** The worker could not bring its mirrors up to date: they were dropped; send the whole state again. */
export class MirrorLost extends Error {}
/** The request ran past the bound and its worker was ended (not to be sent again: it would hang again). */
export class WorkerTimeout extends Error {}

/**
 * How long a worker may take over one request. The longest a real document's request takes is a few
 * seconds (a 240 kB thesis: open 2.3 s, a tracked agent's edit 3.4 s; six times that, 1.4 MB: 6.8 s
 * and 20 s — measured on the production box, 28 Nov 2026); a request past this is stuck.
 */
const REQUEST_LIMIT_MS = 120_000;

interface Call { op: string; resolve: (v: unknown) => void; reject: (e: Error) => void }

interface Slot {
  worker: Worker | null;
  /** incremented whenever the worker is replaced: mirrors made by an earlier one are gone */
  gen: number;
  /** the requests not answered yet, in the order sent: the first is the one the worker is on */
  calls: Map<number, Call>;
  /** ends the worker when the request it is on takes too long (armed whenever it begins one) */
  watchdog: NodeJS.Timeout | null;
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
  private readonly url: URL;
  private readonly limitMs: number;

  /** (`url`, `limitMs`: a stand-in worker and a shorter bound, for tests) */
  constructor(readonly size: number, opts: { url?: URL; limitMs?: number } = {}) {
    this.slots = Array.from({ length: Math.max(0, size) }, () => ({ worker: null, gen: 0, calls: new Map(), watchdog: null, projects: 0 }));
    this.url = opts.url ?? WORKER_URL;
    this.limitMs = opts.limitMs ?? REQUEST_LIMIT_MS;
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
      s.calls.set(id, { op, resolve, reject });
      if (s.calls.size === 1) { w.ref(); this.watch(slot, w); }
      try { w.postMessage({ id, op, doc, sync, args } satisfies WorkerRequest); }
      catch (e) { s.calls.delete(id); if (!s.calls.size) this.idle(s, w); reject(e as Error); }
    });
  }

  /** The worker begins the first request in line: it has the bound's time for it. */
  private watch(slot: number, w: Worker): void {
    const s = this.slots[slot];
    if (s.watchdog) clearTimeout(s.watchdog);
    const head = s.calls.keys().next().value;
    s.watchdog = setTimeout(() => {
      s.watchdog = null;
      const c = head === undefined ? undefined : s.calls.get(head);
      if (s.worker !== w || !c) return;
      console.error(`[docs] document worker ${slot}: a request (${c.op}) ran past ${this.limitMs / 1000} s — the worker is ended and replaced`);
      s.calls.delete(head!);
      c.reject(new WorkerTimeout(`the document worker took over ${this.limitMs / 1000} s (${c.op})`));
      this.lost(slot, w, 'ended: a request ran too long');
      void w.terminate();
    }, this.limitMs);
    s.watchdog.unref();
  }

  /** nothing to do: the worker no longer keeps the server up, and nothing is timed */
  private idle(s: Slot, w: Worker): void {
    if (s.worker !== w) return;
    w.unref();
    if (s.watchdog) { clearTimeout(s.watchdog); s.watchdog = null; }
  }

  /** The worker `w` of a slot is gone (exited, or ended): its mirrors with it; what it was asked is handed back. */
  private lost(slot: number, w: Worker, why: string): void {
    const s = this.slots[slot];
    if (s.worker !== w) return;
    s.worker = null;
    s.gen++;
    if (s.watchdog) { clearTimeout(s.watchdog); s.watchdog = null; }
    const calls = [...s.calls.values()];
    s.calls.clear();
    for (const c of calls) c.reject(new WorkerGone(`document worker ${slot} ${why}`));
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
    const w = new Worker(this.url, { name: `overlyx-doc-${slot}`, ...(viaTsx ? {} : { execArgv: ['--import', 'tsx'] }) });
    w.unref();
    s.worker = w;
    w.on('message', (m: WorkerResponse) => {
      const c = s.calls.get(m.id);
      if (!c) return;
      s.calls.delete(m.id);
      if (!s.calls.size) this.idle(s, w);
      else if (s.worker === w) this.watch(slot, w);   // on to the next one
      if (m.ok) c.resolve(m.result);
      else c.reject(Object.assign(m.resync ? new MirrorLost(m.error) : new Error(m.error), m.stack ? { stack: m.stack } : {}));
    });
    w.on('error', (e) => console.error(`[docs] document worker ${slot} failed:`, e));
    w.on('exit', (code) => {
      if (s.worker !== w) return;   // (ended by its watchdog: replaced already)
      this.lost(slot, w, `exited (${code})`);
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
