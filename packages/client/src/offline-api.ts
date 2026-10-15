/** Persist the document-opening response even when its first request precedes
 * service-worker control. Each signed-in account has a separate private cache. */
export async function offlineGet<T>(url: string, load: () => Promise<T>): Promise<T> {
  let cache: Cache | undefined;
  let account: number | undefined;
  const current = () => {
    try { const id = JSON.parse(localStorage.getItem('ol.user') ?? 'null')?.id; return Number.isSafeInteger(id) && id > 0 ? id as number : undefined; }
    catch { return undefined; }
  };
  try {
    account = current();
    if (account !== undefined && typeof caches !== 'undefined') cache = await caches.open(`overlyx-api-user-${account}`);
  } catch { /* Storage can be unavailable; online requests still work. */ }
  try {
    const result = await load();
    try { if (account !== undefined && current() === account) await cache?.put(url, new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } })); }
    catch { /* A failed optional cache must not reject a successful request. */ }
    return result;
  } catch (error) {
    // An authoritative denial/deletion must never open an older cached copy.
    if (account !== undefined && current() === account && !(error as { status?: number } | null)?.status) {
      try {
        const hit = await cache?.match(url);
        if (hit) { const result = await hit.json() as T; if (current() === account) return result; }
      } catch { /* Preserve the request's error. */ }
    }
    throw error;
  }
}
