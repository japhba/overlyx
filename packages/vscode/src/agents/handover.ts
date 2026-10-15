/**
 * When an agent's call is handed to the VS Code window that has the document open (host/agents.ts,
 * agents/server.ts), the window only takes it while it can finish it. Applying an edit there goes
 * through VS Code's document API, and with Remote-SSH that API is answered by the window on the
 * user's own computer: while the connection is down (a laptop asleep, a dropped network) the
 * extension host lives on and its bridge still answers, but the document never reloads and edits
 * never apply. The agent's tool server must not wait on that, so a handed-over call is answered
 * `gone` — the tool server then edits the file, which the window merges like any change on disk once
 * it is back — whenever the window does not answer a probe at once, or the edit has not begun to
 * apply within a deadline (still queued behind a stuck edit, or the reload never came). Up to the
 * moment it applies, an edit can be abandoned without a trace; from then on it is the window's, and
 * its outcome is waited for: never applied twice.
 *
 * No VS Code API here (the tool server imports it too).
 */

/** The answer to a handed-over call: the result, the tool's error, or that the file is to be edited instead. */
export interface EditorAnswer { result?: unknown; error?: string; gone?: boolean }

/** The window cannot do its part of an edit now (thrown before anything was applied). */
export class WindowUnreachable extends Error {}

/** What a handed-over job is told: whether it was abandoned, and to call `begin` right before it applies the edit. */
export interface HandOver {
  readonly signal: AbortSignal;
  /** Throws if the call was abandoned; otherwise the edit is the window's from here on. */
  begin(): void;
}

export const PROBE_MS = 3000;
export const BEGIN_MS = 15_000;

const within = <T>(p: PromiseLike<T>, ms: number): Promise<{ value: T } | null> => new Promise(resolve => {
  const t = setTimeout(() => resolve(null), ms);
  Promise.resolve(p).then(value => { clearTimeout(t); resolve({ value }); }, () => { clearTimeout(t); resolve(null); });
});

/**
 * Runs a handed-over call in the window: `probe` is a round trip through the window (answered there),
 * `job` the edit (undefined when the document is no longer open here).
 */
export async function inEditor<T>(probe: () => PromiseLike<unknown>, job: (h: HandOver) => Promise<T> | undefined,
  opts: { probeMs?: number; beginMs?: number } = {}): Promise<EditorAnswer> {
  if (!await within(probe(), opts.probeMs ?? PROBE_MS)) return { gone: true };
  const ac = new AbortController();
  let begun = false;
  const handOver: HandOver = {
    signal: ac.signal,
    begin() { if (ac.signal.aborted) throw new WindowUnreachable('abandoned: the window did not begin the edit in time'); begun = true; },
  };
  const running = job(handOver);
  if (!running) return { gone: true };
  let timer: NodeJS.Timeout | undefined;
  const abandoned = new Promise<'abandoned'>(resolve => { timer = setTimeout(() => { if (!begun) { ac.abort(); resolve('abandoned'); } }, opts.beginMs ?? BEGIN_MS); });
  try {
    const outcome = await Promise.race([running.then(result => ({ result })), abandoned]);
    return outcome === 'abandoned' ? { gone: true } : outcome;
  } catch (e) {
    if (e instanceof WindowUnreachable && !begun) return { gone: true };
    return { error: (e as Error)?.message ?? String(e) };
  } finally {
    clearTimeout(timer);
    running.catch(() => undefined);   // an abandoned job ends in WindowUnreachable, unobserved
  }
}
