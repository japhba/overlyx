/** A preview stays subscribed while idle: builds can be started in another editor. */
export function watchPdfBuild<T extends { job?: { status: string } | null }>(options: {
  fetch(): Promise<T>;
  receive(build: T): void;
  failed(build: T): void;
}) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0, disposed = false;
  const poll = (announce = false) => {
    if (disposed) return;
    const run = ++generation;
    clearTimeout(timer);
    const step = async () => {
      let build: T;
      try { build = await options.fetch(); }
      catch { if (!disposed && run === generation) timer = setTimeout(step, 3000); return; }
      if (disposed || run !== generation) return;
      options.receive(build);
      const busy = !!build.job && ['queued', 'exporting', 'compiling'].includes(build.job.status);
      if (!busy) {
        if (announce && build.job && build.job.status !== 'ok') options.failed(build);
        announce = false;
      }
      timer = setTimeout(step, busy ? 1000 : 2000);
    };
    void step();
  };
  return { poll, dispose() { disposed = true; generation++; clearTimeout(timer); } };
}
