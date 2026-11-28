/**
 * Following a document's PDF build. Builds are background jobs on the server; `GET /docs/<id>/build`
 * says where the last one and the running one stand, and nothing announces a change — so the open
 * document's PDF pane (App.tsx) and the extension's preview (vscode BuiltPdf.tsx) ask:
 *   - `poll()` asks now, and again every second while a job is queued or running;
 *   - once nothing builds it stops — or, with `idleMs`, keeps asking that often (the extension: a
 *     build may be started from another editor);
 *   - a refusal (4xx: the document is gone, or no longer this person's to see) is an answer, not a
 *     failure: nothing more is asked. Only an answer that did not come (the network, a server
 *     restarting) is asked for again, 3 s, 6 s, 12 s … at most 30 s apart;
 *   - `stop()` ends it for good — the document was left. An answer still on its way is dropped.
 */
const ACTIVE = new Set(['queued', 'exporting', 'compiling']);
/** a build job that has not ended yet */
export const jobActive = (j: { status: string } | null | undefined): boolean => !!j && ACTIVE.has(j.status);

const BUSY_MS = 1000, RETRY_MS = 3000, RETRY_MAX_MS = 30000;

export interface BuildWatch {
  /** ask now; `announce`: the build this is for was asked for by the person — `ended` is told when it is over */
  poll(announce?: boolean): void;
  stop(): void;
}

export function watchBuild<T extends { job?: { status: string } | null }>(options: {
  fetch(): Promise<T>;
  receive(build: T): void;
  /** the build `poll(true)` was called for is over (ok, failed or cancelled) */
  ended?(build: T): void;
  /** the server refused: the watch is over */
  refused?(): void;
  idleMs?: number;
}): BuildWatch {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0, stopped = false;
  const poll = (announce = false) => {
    if (stopped) return;
    const run = ++generation;
    clearTimeout(timer);
    let failures = 0;
    const step = async () => {
      let build: T;
      try { build = await options.fetch(); } catch (e) {
        if (stopped || run !== generation) return;
        const status = (e as { status?: unknown } | null)?.status;
        if (typeof status === 'number' && status >= 400 && status < 500) { stopped = true; options.refused?.(); return; }
        timer = setTimeout(step, Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** failures++));
        return;
      }
      if (stopped || run !== generation) return;
      failures = 0;
      options.receive(build);
      const busy = jobActive(build.job);
      if (!busy && announce) { announce = false; if (build.job) options.ended?.(build); }
      if (busy) timer = setTimeout(step, BUSY_MS);
      else if (options.idleMs) timer = setTimeout(step, options.idleMs);
    };
    void step();
  };
  return { poll, stop() { stopped = true; generation++; clearTimeout(timer); } };
}
