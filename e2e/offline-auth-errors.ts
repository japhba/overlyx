import type { ConsoleMessage, Request } from '@playwright/test';

const AUTH_REFRESH_FAILED = 'Failed to load resource: net::ERR_FAILED';
const OFFLINE_TEX_CONSOLE_FAILED = 'Failed to load resource: WebKit encountered an internal error';
const OFFLINE_TEX_REQUEST_FAILED = 'WebKit encountered an internal error';

function isOfflineAuthRefresh(url: string, origin: string, offline: boolean): boolean {
  if (!offline) return false;
  try {
    const target = new URL(url);
    return target.origin === origin && target.pathname === '/api/auth/me' && !target.search && !target.hash;
  } catch { return false; }
}

/** Chromium can report this one offline auth fetch as ERR_FAILED instead of ERR_INTERNET_DISCONNECTED. */
export function expectedOfflineAuthConsole(message: Pick<ConsoleMessage, 'text' | 'location'>, origin: string, offline: boolean): boolean {
  return message.text() === AUTH_REFRESH_FAILED && isOfflineAuthRefresh(message.location().url, origin, offline);
}

export function expectedOfflineAuthRequest(request: Pick<Request, 'url' | 'method' | 'failure'>, origin: string, offline: boolean): boolean {
  return request.method() === 'GET' && request.failure()?.errorText === 'net::ERR_FAILED'
    && isOfflineAuthRefresh(request.url(), origin, offline);
}

/** A WebKit offline source refresh can fail after the document changes while the TeX pane is hidden. */
function isOfflineTexSource(url: string, origin: string, offline: boolean): boolean {
  if (!offline) return false;
  try {
    const target = new URL(url);
    return target.origin === origin && !target.username && !target.password
      && /^\/api\/docs\/[^/]+\/tex$/.test(target.pathname)
      && (target.search === '' || target.search === '?map=1') && !target.hash;
  } catch { return false; }
}

export function expectedOfflineTexConsole(message: Pick<ConsoleMessage, 'text' | 'location'>, origin: string, offline: boolean): boolean {
  return message.text() === OFFLINE_TEX_CONSOLE_FAILED && isOfflineTexSource(message.location().url, origin, offline);
}

export function expectedOfflineTexRequest(request: Pick<Request, 'url' | 'method' | 'failure'>, origin: string, offline: boolean): boolean {
  return request.method() === 'GET' && request.failure()?.errorText === OFFLINE_TEX_REQUEST_FAILED
    && isOfflineTexSource(request.url(), origin, offline);
}

/** Pair each allowed console URL to one actual failed GET; never use aggregate suppression alone. */
export function pairedOfflineTexConsoleCount(consoleUrls: readonly string[], failedGetUrls: readonly string[]): number {
  const remaining = new Map<string, number>();
  for (const url of failedGetUrls) remaining.set(url, (remaining.get(url) ?? 0) + 1);
  let paired = 0;
  for (const url of consoleUrls) {
    const count = remaining.get(url) ?? 0;
    if (!count) continue;
    paired++;
    if (count === 1) remaining.delete(url); else remaining.set(url, count - 1);
  }
  return paired;
}
