/**
 * Self-update logic that needs no VS Code: reading a GitHub "latest release", comparing versions,
 * picking the .vsix asset. The VS Code side (notifications, install command) lives in updater.ts.
 */

export interface ReleaseInfo {
  version: string;
  /** human page of the release (release notes) */
  url: string;
  /** direct download of the .vsix asset */
  vsixUrl: string;
  notes: string;
}

/** "1.2.3" (a leading v is fine) → comparable triple; null when unparsable. */
export function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** true when `a` is a newer version than `b`. */
export function isNewer(a: string, b: string): boolean {
  const pa = parseVersion(a), pb = parseVersion(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) { if (pa[i] !== pb[i]) return pa[i] > pb[i]; }
  return false;
}

/** GitHub /releases/latest JSON → the release, or null when it carries no .vsix. */
export function releaseFromGithub(json: unknown): ReleaseInfo | null {
  const r = json as { tag_name?: string; html_url?: string; body?: string; assets?: { name?: string; browser_download_url?: string }[] };
  if (!r || typeof r.tag_name !== 'string') return null;
  const version = r.tag_name.replace(/^v/, '');
  if (!parseVersion(version)) return null;
  const asset = (r.assets ?? []).find(a => typeof a.name === 'string' && a.name.endsWith('.vsix') && a.browser_download_url);
  if (!asset?.browser_download_url) return null;
  return { version, url: r.html_url ?? '', vsixUrl: asset.browser_download_url, notes: (r.body ?? '').slice(0, 4000) };
}

/** URL of the latest-release endpoint for an owner/repo (or a full override, e.g. in tests). */
export function latestReleaseUrl(repo: string, apiOverride?: string): string {
  if (apiOverride) return apiOverride;
  return `https://api.github.com/repos/${repo}/releases/latest`;
}

export async function fetchLatestRelease(repo: string, apiOverride?: string): Promise<ReleaseInfo | null> {
  const res = await fetch(latestReleaseUrl(repo, apiOverride), {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'overlyx-vscode' },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 404) return null;   // no releases yet
  if (!res.ok) throw new Error(`release check failed: ${res.status}`);
  return releaseFromGithub(await res.json());
}
