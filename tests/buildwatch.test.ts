import { afterEach, expect, it, vi } from 'vitest';
import { watchBuild } from '../packages/client/src/app/buildwatch';

afterEach(() => vi.useRealTimers());

const refusal = (status: number) => Object.assign(new Error('You do not have access to this project'), { status });

it('takes a refusal for an answer: a document one may not see is asked for once (510 denied requests in six sessions)', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockRejectedValue(refusal(403));
  const receive = vi.fn(), refused = vi.fn();
  const watch = watchBuild({ fetch, receive, refused });
  watch.poll();
  await vi.advanceTimersByTimeAsync(120000);
  expect(fetch).toHaveBeenCalledOnce();
  expect(refused).toHaveBeenCalledOnce();
  expect(receive).not.toHaveBeenCalled();
  // … and stays over: a later build request of the same pane does not start it again
  watch.poll(true);
  await vi.advanceTimersByTimeAsync(10000);
  expect(fetch).toHaveBeenCalledOnce();
});

it('asks an unreachable server again, each time later, and at once goes on when it answers', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
  const receive = vi.fn();
  const watch = watchBuild({ fetch, receive });
  watch.poll();
  await vi.advanceTimersByTimeAsync(0);
  expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(3000);    // 3 s
  expect(fetch).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(6000);    // 6 s
  expect(fetch).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(12000 + 24000);
  expect(fetch).toHaveBeenCalledTimes(5);
  await vi.advanceTimersByTimeAsync(5 * 60000 + 1000);   // never more than 30 s apart, never more often
  expect(fetch).toHaveBeenCalledTimes(15);
  // a server error (5xx) is no refusal either
  fetch.mockRejectedValueOnce(refusal(502)).mockResolvedValueOnce({ job: { status: 'compiling' } }).mockResolvedValue({ job: { status: 'ok' } });
  await vi.advanceTimersByTimeAsync(70000);
  expect(receive).toHaveBeenCalledTimes(2);
  expect(receive).toHaveBeenLastCalledWith({ job: { status: 'ok' } });
  // nothing builds: nothing more is asked
  const asked = fetch.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60000);
  expect(fetch).toHaveBeenCalledTimes(asked);
  watch.stop();
});

it('ends with the document: after stop() nothing is asked and an answer on its way is dropped', async () => {
  vi.useFakeTimers();
  let answer!: (value: unknown) => void;
  const fetch = vi.fn().mockImplementationOnce(() => new Promise(resolve => { answer = resolve; })).mockResolvedValue({ job: { status: 'compiling' } });
  const receive = vi.fn();
  const watch = watchBuild({ fetch, receive });
  watch.poll();
  await vi.advanceTimersByTimeAsync(0);
  watch.stop();
  answer({ job: { status: 'compiling' } });
  await vi.advanceTimersByTimeAsync(10000);
  expect(receive).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledOnce();
});

it('tells the end of a build one asked for once, whatever it was', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockResolvedValueOnce({ job: { status: 'queued' } }).mockResolvedValueOnce({ job: { status: 'compiling' } }).mockResolvedValue({ job: { status: 'cancelled' } });
  const ended = vi.fn();
  const watch = watchBuild({ fetch, receive() {}, ended, idleMs: 2000 });
  watch.poll(true);
  await vi.advanceTimersByTimeAsync(10000);
  expect(ended).toHaveBeenCalledOnce();
  expect(ended).toHaveBeenCalledWith({ job: { status: 'cancelled' } });
  watch.stop();
});

// the extension's preview (vscode BuiltPdf.tsx) stays subscribed while idle: builds start in other editors
it('with idleMs, finds builds started elsewhere after the pane became idle', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockResolvedValueOnce({ job: null, pdf: null })
    .mockResolvedValueOnce({ job: { status: 'compiling' }, pdf: null })
    .mockResolvedValue({ job: { status: 'ok' }, pdf: '/built.pdf' });
  const receive = vi.fn(), ended = vi.fn();
  const watch = watchBuild({ fetch, receive, ended, idleMs: 2000 });
  watch.poll();
  await vi.advanceTimersByTimeAsync(2000);
  expect(receive).toHaveBeenLastCalledWith({ job: { status: 'compiling' }, pdf: null });
  await vi.advanceTimersByTimeAsync(1000);
  expect(receive).toHaveBeenLastCalledWith({ job: { status: 'ok' }, pdf: '/built.pdf' });
  await vi.advanceTimersByTimeAsync(2000);
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(ended).not.toHaveBeenCalled();
  watch.stop();
});

it('ignores the answers of a superseded poll', async () => {
  vi.useFakeTimers();
  let first!: (value: unknown) => void;
  const fetch = vi.fn().mockImplementationOnce(() => new Promise(resolve => { first = resolve; })).mockResolvedValue({ job: { status: 'ok' } });
  const receive = vi.fn();
  const watch = watchBuild({ fetch, receive });
  watch.poll(); watch.poll();
  await vi.advanceTimersByTimeAsync(0);
  first({ job: { status: 'compiling' } });
  await vi.advanceTimersByTimeAsync(5000);
  expect(receive).toHaveBeenCalledOnce();
  expect(receive).toHaveBeenCalledWith({ job: { status: 'ok' } });
});
