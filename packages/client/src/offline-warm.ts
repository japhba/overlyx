/** Warm protected offline responses only after the session identity is known. */
export async function warmOfflineResponses(hash: string, request: typeof fetch = fetch): Promise<void> {
  try {
    const response = await request('/api/auth/me', { credentials: 'same-origin' });
    if (!response.ok || !(await response.json()).user) return;
  } catch { return; }
  const urls = ['/api/projects'];
  // View prefixes and shared links are not document IDs; preserve the normal deep-link route.
  let id = '';
  try { id = decodeURIComponent(hash.replace(/^#\/?/, '').split('?')[0]).replace(/^(raw|text|pdf):/, ''); } catch { /* malformed */ }
  if (id && !id.startsWith('share/') && !/[?&]share=/.test(hash) && id.includes('/')) urls.push(`/api/docs/${encodeURIComponent(id)}/meta`);
  await Promise.all(urls.map(url => request(url, { credentials: 'same-origin' }).catch(() => undefined)));
}
