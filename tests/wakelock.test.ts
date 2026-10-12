// @vitest-environment happy-dom
/**
 * The screen kept on while presenting (packages/client/src/app/wakelock.ts): the Screen Wake Lock
 * asked for at once, again when the system let go of it (the page hidden and shown again) or on the
 * next touch after a refusal, let go at the end — also when it arrives after the end; nothing where
 * the browser has none.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { keepAwake } from '../packages/client/src/app/wakelock';

class Sentinel extends EventTarget {
  released = false;
  readonly type = 'screen';
  onrelease = null;
  async release(): Promise<void> { this.released = true; }
}

function fakeWakeLock(refuse = () => false) {
  const locks: Sentinel[] = [];
  const request = vi.fn(async () => {
    if (refuse()) throw new DOMException('not now', 'NotAllowedError');
    const l = new Sentinel();
    locks.push(l);
    return l;
  });
  Object.defineProperty(navigator, 'wakeLock', { value: { request }, configurable: true });
  return { request, locks };
}
const settle = () => new Promise(r => setTimeout(r, 0));
let hidden = false;
Object.defineProperty(document, 'visibilityState', { get: () => (hidden ? 'hidden' : 'visible'), configurable: true });

afterEach(() => { delete (navigator as { wakeLock?: unknown }).wakeLock; hidden = false; });

describe('keepAwake', () => {
  it('holds the lock, asks again once the page is back in view, lets go at the end', async () => {
    const { request, locks } = fakeWakeLock();
    const stop = keepAwake(window);
    await settle();
    expect(request).toHaveBeenCalledTimes(1);
    expect(locks[0].released).toBe(false);
    // held: a touch asks for nothing more
    window.dispatchEvent(new Event('pointerdown'));
    await settle();
    expect(request).toHaveBeenCalledTimes(1);
    // the page hidden: the system lets go; shown again: asked for again
    hidden = true;
    locks[0].released = true;
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(request).toHaveBeenCalledTimes(1);
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(request).toHaveBeenCalledTimes(2);
    stop();
    expect(locks[1].released).toBe(true);
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pointerdown'));
    await settle();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('refused, asks again on the next touch; a lock arriving after the end is let go at once', async () => {
    let no = true;
    const { request, locks } = fakeWakeLock(() => no);
    const stop = keepAwake(window);
    await settle();
    expect(request).toHaveBeenCalledTimes(1);
    expect(locks).toHaveLength(0);
    no = false;
    window.dispatchEvent(new Event('pointerdown'));
    await settle();
    expect(request).toHaveBeenCalledTimes(2);
    expect(locks[0].released).toBe(false);
    stop();
    expect(locks[0].released).toBe(true);
    // asked for, then ended before it came
    const stop2 = keepAwake(window);
    stop2();
    await settle();
    expect(locks[1].released).toBe(true);
  });

  it('nothing where the browser has no wake lock', () => {
    expect(() => keepAwake(window)()).not.toThrow();
  });
});
