/**
 * Is a newer build of the client deployed than the one running in this tab?
 *
 * Tabs stay open for days while the server is redeployed many times; an old bundle keeps working
 * against the new server, but with yesterday's bugs and without new features ("it renders wrong
 * for me but not for you"). The served index.html names its content-hashed assets: when it refers
 * to a script or stylesheet this page does not have, a new build is live.
 */
let lastCheck = 0;

export async function newerVersionAvailable(opts: { minIntervalMs?: number } = {}): Promise<boolean> {
  if (!import.meta.env.PROD) return false;
  const now = Date.now();
  if (now - lastCheck < (opts.minIntervalMs ?? 60000)) return false;
  lastCheck = now;
  try {
    // not a navigation, so the service worker lets it through to the network (cache: no-store)
    const res = await fetch('/index.html', { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'text/html' } });
    if (!res.ok || !/text\/html/.test(res.headers.get('content-type') ?? '')) return false;
    const html = await res.text();
    const served = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(m => m[1]);
    if (!served.length) return false;
    const mine = new Set([...document.querySelectorAll('script[src], link[href]')].map(e => e.getAttribute('src') ?? e.getAttribute('href') ?? ''));
    // the page may have preloaded more chunks than index.html lists; only what it lacks matters
    return served.some(a => !mine.has(a));
  } catch { return false; }
}
