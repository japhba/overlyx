/**
 * The screen kept on while presenting: an iPad dims and locks after a minute or two without a touch,
 * in the middle of a talk. The Screen Wake Lock (Safari 16.4+, Chromium, Firefox 126+), asked for
 * again whenever the page comes back into view (the system lets go of it while the page is hidden)
 * and on the next touch, should the browser have refused it outside one. Only a top-level document
 * may hold it (a frame needs the permission policy, which the presenting frame is not given): the
 * editor asks for the frame it presents in. Where the browser has none, nothing happens.
 *
 * Returns the release.
 */
export function keepAwake(win: Window = window): () => void {
  const wl = win.navigator.wakeLock;
  if (!wl) return () => undefined;
  const doc = win.document;
  let lock: WakeLockSentinel | null = null;
  let asking = false, done = false;
  const ask = () => {
    if (done || asking || (lock && !lock.released) || doc.visibilityState !== 'visible') return;
    asking = true;
    wl.request('screen').then(l => {
      asking = false;
      if (done) void l.release().catch(() => undefined);
      else lock = l;
    }, () => { asking = false; });
  };
  doc.addEventListener('visibilitychange', ask);
  win.addEventListener('pointerdown', ask, true);
  ask();
  return () => {
    done = true;
    doc.removeEventListener('visibilitychange', ask);
    win.removeEventListener('pointerdown', ask, true);
    if (lock && !lock.released) void lock.release().catch(() => undefined);
    lock = null;
  };
}
