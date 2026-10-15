import { expect, it } from 'vitest';
import type { Page } from '@playwright/test';
import { expectedOfflineAuthConsole, expectedOfflineAuthRequest, expectedOfflineTexConsole, expectedOfflineTexRequest, pairedOfflineTexConsoleCount } from '../e2e/offline-auth-errors';
import { collectErrors } from '../e2e/helpers';

const origin = 'http://127.0.0.1:3000';
const texUrl = `${origin}/api/docs/admin%2Fproject%2Fdoc.tex/tex`;
const texConsoleText = 'Failed to load resource: WebKit encountered an internal error';
const texFailureText = 'WebKit encountered an internal error';
const message = (url = `${origin}/api/auth/me`, text = 'Failed to load resource: net::ERR_FAILED') => ({
  type: () => 'error', text: () => text, location: () => ({ url, lineNumber: 0, columnNumber: 0 }),
});
const request = (url = `${origin}/api/auth/me`, method = 'GET', errorText = 'net::ERR_FAILED') => ({
  url: () => url, method: () => method, failure: () => ({ errorText }),
});

it('recognizes only the exact same-origin auth refresh console error during intentional offline mode', () => {
  expect(expectedOfflineAuthConsole(message(), origin, true)).toBe(true);
  expect(expectedOfflineAuthConsole(message(), origin, false)).toBe(false);
  for (const url of [`http://other.test/api/auth/me`, `${origin}/api/auth/login`, `${origin}/api/documents`, `${origin}/api/auth/me?retry=1`, `${origin}/api/auth/me#x`, 'invalid']) {
    expect(expectedOfflineAuthConsole(message(url), origin, true), url).toBe(false);
  }
  for (const text of ['net::ERR_FAILED', 'Failed to load resource: net::ERR_ABORTED', 'TypeError: failed', 'Failed to load resource: net::ERR_FAILED extra']) {
    expect(expectedOfflineAuthConsole(message(undefined, text), origin, true), text).toBe(false);
  }
});

it('requires a real failed GET to the same exact offline auth refresh endpoint', () => {
  expect(expectedOfflineAuthRequest(request(), origin, true)).toBe(true);
  expect(expectedOfflineAuthRequest(request(), origin, false)).toBe(false);
  expect(expectedOfflineAuthRequest(request(undefined, 'POST'), origin, true)).toBe(false);
  expect(expectedOfflineAuthRequest(request(undefined, 'GET', 'net::ERR_INTERNET_DISCONNECTED'), origin, true)).toBe(false);
  for (const url of ['https://other.test/api/auth/me', `${origin}/api/auth/login`, `${origin}/api/auth/me?retry=1`, 'invalid']) {
    expect(expectedOfflineAuthRequest(request(url), origin, true), url).toBe(false);
  }
  expect(expectedOfflineAuthRequest({ ...request(), failure: () => null }, origin, true)).toBe(false);
});

it('recognizes only the exact same-origin offline TeX-source fetch console failure', () => {
  expect(expectedOfflineTexConsole(message(texUrl, texConsoleText), origin, true)).toBe(true);
  expect(expectedOfflineTexConsole(message(`${texUrl}?map=1`, texConsoleText), origin, true)).toBe(true);
  expect(expectedOfflineTexConsole(message(texUrl, texConsoleText), origin, false)).toBe(false);
  for (const url of [
    `http://other.test${new URL(texUrl).pathname}`, `${origin.replace('://', '://user:pass@')}${new URL(texUrl).pathname}`,
    `${origin}/api/docs/first/second/tex`, `${origin}/api/docs//tex`, `${origin}/api/docs/admin%2Fdoc.tex/source`,
    `${texUrl}?other=1`, `${texUrl}?map=0`, `${texUrl}?map=1&other=1`, `${texUrl}#fragment`, 'invalid',
  ]) expect(expectedOfflineTexConsole(message(url, texConsoleText), origin, true), 'URL boundary').toBe(false);
  for (const text of [
    'Failed to load resource: net::ERR_FAILED', 'Failed to load resource: net::ERR_INTERNET_DISCONNECTED',
    'TypeError: Load failed', 'Blocked by Content Security Policy', `${texConsoleText} extra`,
  ]) expect(expectedOfflineTexConsole(message(texUrl, text), origin, true), 'console grammar boundary').toBe(false);
});

it('requires a failed same-origin GET for the exact offline TeX-source route', () => {
  expect(expectedOfflineTexRequest(request(texUrl, 'GET', texFailureText), origin, true)).toBe(true);
  expect(expectedOfflineTexRequest(request(`${texUrl}?map=1`, 'GET', texFailureText), origin, true)).toBe(true);
  expect(expectedOfflineTexRequest(request(texUrl, 'GET', texFailureText), origin, false)).toBe(false);
  expect(expectedOfflineTexRequest(request(texUrl, 'POST', texFailureText), origin, true)).toBe(false);
  expect(expectedOfflineTexRequest(request(texUrl, 'GET', 'net::ERR_FAILED'), origin, true)).toBe(false);
  expect(expectedOfflineTexRequest({ ...request(texUrl), failure: () => null }, origin, true)).toBe(false);
  for (const url of [
    `http://other.test${new URL(texUrl).pathname}`, `${origin.replace('://', '://user:pass@')}${new URL(texUrl).pathname}`,
    `${origin}/api/docs/first/second/tex`, `${origin}/api/docs//tex`, `${texUrl}?other=1`,
    `${texUrl}?map=0`, `${texUrl}?map=1&other=1`, `${texUrl}#fragment`, 'invalid',
  ]) expect(expectedOfflineTexRequest(request(url, 'GET', texFailureText), origin, true), 'request URL boundary').toBe(false);
});

it('pairs an allowed offline TeX console error with one failed GET at the identical URL', () => {
  expect(pairedOfflineTexConsoleCount([texUrl], [texUrl])).toBe(1);
  expect(pairedOfflineTexConsoleCount([`${texUrl}?map=1`, texUrl], [texUrl, `${texUrl}?map=1`])).toBe(2);
  expect(pairedOfflineTexConsoleCount([texUrl], [])).toBe(0);
  expect(pairedOfflineTexConsoleCount([texUrl], [`${texUrl}?map=1`])).toBe(0);
  expect(pairedOfflineTexConsoleCount([texUrl, texUrl], [texUrl])).toBe(1);
});

it('keeps console and page errors by default', () => {
  const callbacks = new Map<string, (value: unknown) => void>();
  const page = { on: (event: string, callback: (value: unknown) => void) => { callbacks.set(event, callback); } } as unknown as Page;
  const errors = collectErrors(page);
  callbacks.get('console')!(message());
  callbacks.get('pageerror')!(new Error('Failed to load resource: net::ERR_FAILED'));
  expect(errors).toEqual(['console: Failed to load resource: net::ERR_FAILED', 'pageerror: Failed to load resource: net::ERR_FAILED']);
});

it('optional console classification preserves all page errors, other URLs, and online failures', () => {
  let offline = true, allowed = 0;
  const callbacks = new Map<string, (value: unknown) => void>();
  const page = { on: (event: string, callback: (value: unknown) => void) => { callbacks.set(event, callback); } } as unknown as Page;
  const errors = collectErrors(page, { allowConsole: value => {
    if (!expectedOfflineAuthConsole(value, origin, offline)) return false;
    allowed++;
    return true;
  } });
  callbacks.get('console')!(message());
  callbacks.get('pageerror')!(new Error('Failed to load resource: net::ERR_FAILED'));
  callbacks.get('console')!(message(`${origin}/api/documents`));
  offline = false;
  callbacks.get('console')!(message());
  expect(allowed).toBe(1);
  expect(errors).toEqual(['pageerror: Failed to load resource: net::ERR_FAILED', 'console: Failed to load resource: net::ERR_FAILED', 'console: Failed to load resource: net::ERR_FAILED']);
});
