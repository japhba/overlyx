/** Forget everything cached in this browser (API responses cached by the service worker, local document copies) — at sign-out and after deleting the account. */
export async function clearLocalData(): Promise<void> {
  try { for (const key of Object.keys(localStorage)) if (key.startsWith('ol.textRecovery:')) localStorage.removeItem(key); } catch { /* private mode */ }
  try { if ('caches' in window) for (const k of await caches.keys()) if (k.startsWith('overlyx-api')) await caches.delete(k); } catch { /* ignore */ }
  try {
    const dbs = await (indexedDB as any).databases?.() as { name?: string }[] | undefined;
    for (const d of dbs ?? []) if (d.name?.startsWith('overlyx:')) indexedDB.deleteDatabase(d.name);
  } catch { /* ignore */ }
}
