/** Real source-pane input, held refresh, offline preview and explicit reconnect retry. */
import { test, expect, type Page, type ConsoleMessage, type Request } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { login, openDoc, PROJECTS_DIR, texDoc } from './helpers';
import { expectedOfflineTexConsole, expectedOfflineTexRequest, pairedOfflineTexConsoleCount } from './offline-auth-errors';

const PROJECT = 'admin/e2e-source-refresh-recovery';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;
test.use({ serviceWorkers: 'block' }); // These cases must hold/observe the real source GET, not a SW fetch.
test.beforeAll(() => {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${DIR}/late.tex`, texDoc('Refresh control preview.\n\nSecond control paragraph.'));
  writeFileSync(`${DIR}/offline.tex`, texDoc('Cached control preview.\n\nSecond cached paragraph.'));
});
test.afterAll(() => rmSync(DIR, { recursive: true, force: true }));

async function source(page: Page, file: string, marker: string) {
  await login(page);
  await openDoc(page, `${PROJECT}/${file}.tex`);
  await page.getByRole('button', { name: 'TeX', exact: true }).click();
  const textarea = page.locator('.source-pane textarea.source');
  await expect(textarea).toBeVisible();
  await expect(textarea).toHaveValue(new RegExp(marker), { timeout: 15000 });
  return textarea;
}
// Only this controlled document's source/auth refreshes and native socket failures are expected.
const nativeOfflineFailures = new Map([
  ['Failed to load resource: net::ERR_INTERNET_DISCONNECTED', 'net::ERR_INTERNET_DISCONNECTED'],
  ['Failed to load resource: net::ERR_FAILED', 'net::ERR_FAILED'],
  ['Failed to load resource: Load failed', 'Load failed'],
]);
function controlledRefreshUrl(value: string, origin: string): boolean {
  try {
    const url = new URL(value);
    if (url.origin !== origin || url.username || url.password || url.hash) return false;
    return (url.pathname === '/api/auth/me' && !url.search)
      || (url.pathname === `/api/docs/${encodeURIComponent(`${PROJECT}/offline.tex`)}/tex`
        && (url.search === '' || url.search === '?map=1'));
  } catch { return false; }
}
function controlledOfflineRequest(request: Pick<Request, 'method' | 'url' | 'failure'>, origin: string, offline: boolean): boolean {
  return offline && request.method() === 'GET' && controlledRefreshUrl(request.url(), origin)
    && [...nativeOfflineFailures.values()].includes(request.failure()?.errorText ?? '');
}
function controlledOfflineConsole(message: Pick<ConsoleMessage, 'text' | 'location'>, origin: string, offline: boolean): boolean {
  return offline && nativeOfflineFailures.has(message.text()) && controlledRefreshUrl(message.location().url, origin);
}
function controlledOfflineSocket(text: string, origin: string, offline: boolean): boolean {
  if (!offline) return false;
  const match = /^WebSocket connection to '([^']+)' failed: Error in connection establishment: net::ERR_INTERNET_DISCONNECTED$/.exec(text)
    ?? /^Firefox can’t establish a connection to the server at (\S+)\.$/.exec(text)
    ?? /^The connection to (\S+) was interrupted while the page was loading\.$/.exec(text);
  if (!match) return false;
  try {
    const url = new URL(match[1]), parent = new URL(origin);
    return url.protocol === (parent.protocol === 'https:' ? 'wss:' : 'ws:') && url.host === parent.host
      && !url.username && !url.password && !url.hash && ['/ws', '/ws/'].includes(url.pathname)
      && [...url.searchParams.keys()].length === 1 && url.searchParams.get('doc') === `${PROJECT}/offline.tex`;
  } catch { return false; }
}
const isMap = (url: URL) => /^\/api\/docs\/[^/]+\/tex$/.test(url.pathname) && url.search === '?map=1';

test('a late generated-source response cannot replace a typed draft or its undo history', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const textarea = await source(page, 'late', 'Refresh control preview');
  let held = false, fulfilled = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(isMap, async route => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    held = true;
    await gate;
    await route.fulfill({ response });
    fulfilled = true;
  }, { times: 1 });
  const paragraph = page.locator('.lyx-editor > .lyx-par').first();
  await paragraph.click(); await page.keyboard.press('End');
  await page.keyboard.type(' earlier-refresh');
  await expect.poll(() => held, { timeout: 15000 }).toBe(true);
  await expect(page.locator('.save-state')).toContainText('All changes saved');
  const mod = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform) ? 'Meta' : 'Control');
  await textarea.click();
  await page.keyboard.press(mod === 'Meta' ? 'Meta+ArrowDown' : 'Control+End');
  await page.keyboard.type('\n\\section{unfinished-draft');
  // Source input pairs braces: remove the supplied closer through the GUI.
  const paired = await textarea.inputValue();
  expect(paired.endsWith('\\section{unfinished-draft}')).toBe(true);
  expect(await textarea.evaluate(el => (el as HTMLTextAreaElement).selectionStart)).toBe(paired.length - 1);
  await page.keyboard.press('Delete');
  const draft = await textarea.inputValue();
  expect(draft.endsWith('\\section{unfinished-draft')).toBe(true);
  expect((draft.match(/\{/g) ?? []).length - (draft.match(/\}/g) ?? []).length).toBe(1);
  release();
  await expect.poll(() => fulfilled, { timeout: 15000 }).toBe(true);
  // Wait for the existing automatic lint/apply cycle AFTER response fulfillment.
  // An immediate textarea check alone could pass before the old response is processed.
  await expect(page.locator('[data-apply-state]')).toHaveAttribute('data-apply-state', 'held', { timeout: 15000 });
  await expect(textarea).toHaveValue(draft);
  await page.keyboard.press(`${mod}+z`);
  await expect(textarea).not.toHaveValue(draft);
  await page.keyboard.press(`${mod}+Shift+z`);
  await expect(textarea).toHaveValue(draft);
  const saved = readFileSync(`${DIR}/late.tex`, 'utf8');
  expect(saved).toContain('earlier-refresh');
  expect(saved).not.toContain('unfinished-draft');
  expect(errors).toEqual([]);
});

test('an offline source refresh keeps its cached preview and retries after reconnect without losing writing', async ({ page, context }) => {
  const pageErrors: string[] = [], unexpectedConsoles: string[] = [];
  const consoleUrls: string[] = [], failedUrls: string[] = [];
  const transportConsoleUrls: string[] = [], transportFailedUrls: string[] = [];
  let intentionallyOffline = false;
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('requestfailed', request => {
    const origin = new URL(page.url()).origin;
    if (expectedOfflineTexRequest(request, origin, intentionallyOffline)) failedUrls.push(request.url());
    if (controlledOfflineRequest(request, origin, intentionallyOffline)) transportFailedUrls.push(request.url());
  });
  page.on('console', message => {
    if (message.type() !== 'error') return;
    if (/TypeError|ReferenceError|Content Security Policy|Refused to/.test(message.text())) {
      unexpectedConsoles.push(message.text()); return;
    }
    if (expectedOfflineTexConsole(message, new URL(page.url()).origin, intentionallyOffline)) {
      consoleUrls.push(message.location().url); return;
    }
    if (controlledOfflineConsole(message, new URL(page.url()).origin, intentionallyOffline)) {
      transportConsoleUrls.push(message.location().url); return;
    }
    if (controlledOfflineSocket(message.text(), new URL(page.url()).origin, intentionallyOffline)) return;
    unexpectedConsoles.push(message.text());
  });
  const textarea = await source(page, 'offline', 'Cached control preview');
  const cached = await textarea.inputValue();
  const origin = new URL(page.url()).origin;
  const currentSource = (url: URL) => controlledRefreshUrl(url.href, origin) && url.pathname !== '/api/auth/me';
  // Passing through the real GET disables HTTP caching in every engine.
  // The native offline switch, rather than a mocked abort, must cause failure.
  const offlineSourceFailures: string[] = [];
  page.on('requestfailed', request => {
    if (intentionallyOffline && request.method() === 'GET' && currentSource(new URL(request.url()))) {
      offlineSourceFailures.push(request.url());
    }
  });
  await page.route(currentSource, route => route.continue());
  const paragraph = page.locator('.lyx-editor > .lyx-par').first();
  try {
    intentionallyOffline = true; await context.setOffline(true);
    await paragraph.click(); await page.keyboard.press('End');
    await page.keyboard.type(' cached-refresh');
    await expect(page.locator('[data-source-refresh="stale"]')).toBeVisible({ timeout: 15000 });
    expect(offlineSourceFailures.some(url => new URL(url).search === '?map=1')).toBe(true);
    expect(offlineSourceFailures.some(url => new URL(url).search === '')).toBe(true);
    await expect(textarea).toHaveValue(cached);
    // Reading/copying a stale preview must not move the live document's selection.
    const selection = () => page.evaluate(() => {
      const view = (window as any).overlyx.activeView;
      return { from: view.state.selection.from, to: view.state.selection.to };
    });
    const before = await selection();
    await textarea.click(); await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowRight');
    const started = Date.now(); let movedWhileStale = false;
    // Observe beyond the existing 120ms caret debounce, retaining any mismatch even if it later returns.
    await expect.poll(async () => {
      const current = await selection();
      if (current.from !== before.from || current.to !== before.to) movedWhileStale = true;
      return Date.now() - started;
    }, { timeout: 3000, intervals: [25, 50, 100] }).toBeGreaterThanOrEqual(250);
    expect(movedWhileStale).toBe(false);
    await context.setOffline(false); intentionallyOffline = false;
    await expect(page.locator('.save-state')).toContainText('All changes saved', { timeout: 30000 });
    await page.getByRole('button', { name: 'Retry source', exact: true }).click();
    await expect(textarea).toHaveValue(/cached-refresh/, { timeout: 15000 });
    await expect(page.locator('[data-source-refresh="stale"]')).toHaveCount(0);
    await expect(page.locator('.save-state')).toContainText('All changes saved', { timeout: 30000 });
    await page.reload();
    await expect(page.locator('.lyx-editor > .lyx-par').first()).toContainText('cached-refresh');
    const saved = readFileSync(`${DIR}/offline.tex`, 'utf8');
    expect(saved.match(/cached-refresh/g)).toHaveLength(1);
    expect(saved).toContain('Cached control preview');
    expect(pairedOfflineTexConsoleCount(consoleUrls, failedUrls)).toBe(consoleUrls.length);
    expect(pairedOfflineTexConsoleCount(transportConsoleUrls, transportFailedUrls)).toBe(transportConsoleUrls.length);
    expect(pageErrors).toEqual([]); expect(unexpectedConsoles).toEqual([]);
  } finally { intentionallyOffline = false; await context.setOffline(false); }
});

test('HTTP 400 source errors preserve the cached preview and undo history, then Retry recovers saved writing', async ({ page }) => {
  writeFileSync(`${DIR}/http400.tex`, texDoc('HTTP control preview.\n\nSecond HTTP paragraph.'));
  const pageErrors: string[] = [], unexpectedConsoles: string[] = [];
  const consoleUrls: string[] = [], responseUrls: string[] = [];
  const controlledRequests = new Set<Request>();
  let inControlledPhase = false;
  const controlledUrl = (value: string) => {
    try {
      const url = new URL(value), origin = new URL(page.url()).origin;
      return url.origin === origin && !url.username && !url.password && !url.hash
        && url.pathname === `/api/docs/${encodeURIComponent(`${PROJECT}/http400.tex`)}/tex`
        && (url.search === '' || url.search === '?map=1');
    } catch { return false; }
  };
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('response', response => {
    const request = response.request();
    if (controlledRequests.has(request) && request.method() === 'GET' && response.status() === 400 && controlledUrl(response.url())) responseUrls.push(response.url());
  });
  page.on('console', message => {
    if (message.type() !== 'error') return;
    // Only exact native resource errors paired below to this case's fulfilled GET 400s.
    if (inControlledPhase && message.text() === 'Failed to load resource: the server responded with a status of 400 (Bad Request)'
        && controlledUrl(message.location().url)) { consoleUrls.push(message.location().url); return; }
    unexpectedConsoles.push(message.text());
  });
  const textarea = await source(page, 'http400', 'HTTP control preview');
  const mod = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform) ? 'Meta' : 'Control');
  await textarea.click(); await page.keyboard.press(mod === 'Meta' ? 'Meta+ArrowDown' : 'Control+End');
  await page.keyboard.type('\n% source-undo-control');
  await expect(page.locator('[data-apply-state]')).toHaveAttribute('data-apply-state', 'ok', { timeout: 15000 });
  await expect(page.locator('.save-state')).toContainText('All changes saved', { timeout: 30000 });
  const cached = await textarea.inputValue(); expect(cached).toContain('% source-undo-control');
  inControlledPhase = true;
  const pattern = (url: URL) => controlledUrl(url.href);
  const handler = async (route: import('@playwright/test').Route) => {
    if (route.request().method() !== 'GET') { await route.continue(); return; }
    controlledRequests.add(route.request());
    await route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"CONTROL_HTTP400_SOURCE_ERROR"}' });
  };
  await page.route(pattern, handler);
  const paragraph = page.locator('.lyx-editor > .lyx-par').first();
  try {
    await paragraph.click(); await page.keyboard.press('End'); await page.keyboard.type(' ');
    await expect(page.locator('[data-source-refresh="stale"]')).toBeVisible({ timeout: 15000 });
    expect(responseUrls.some(url => new URL(url).search === '?map=1')).toBe(true);
    expect(responseUrls.some(url => new URL(url).search === '')).toBe(true);
    await expect(textarea).toHaveValue(cached);
    await textarea.click(); await page.keyboard.press(`${mod}+z`); await expect(textarea).not.toHaveValue(cached);
    await page.keyboard.press(`${mod}+Shift+z`); await expect(textarea).toHaveValue(cached);
    await expect(page.locator('[data-apply-state]')).toHaveAttribute('data-apply-state', 'ok', { timeout: 15000 });
    await expect(page.locator('.save-state')).toContainText('All changes saved', { timeout: 30000 });
    // New live writing follows the intentional history check and cannot be undone by it.
    await paragraph.click(); await page.keyboard.press('End'); await page.keyboard.type(' http400-retry-writing');
    await expect(page.locator('.save-state')).toContainText('All changes saved', { timeout: 30000 });
    await expect(textarea).toHaveValue(cached);
    await page.unroute(pattern, handler);
    await page.getByRole('button', { name: 'Retry source', exact: true }).click();
    await expect(textarea).toHaveValue(/http400-retry-writing/, { timeout: 15000 });
    await expect(page.locator('[data-source-refresh="stale"]')).toHaveCount(0);
    await expect(page.locator('.save-state')).toContainText('All changes saved', { timeout: 30000 });
    inControlledPhase = false;
    await page.reload(); await expect(page.locator('.lyx-editor > .lyx-par').first()).toContainText('http400-retry-writing');
    const saved = readFileSync(`${DIR}/http400.tex`, 'utf8');
    expect(saved.match(/http400-retry-writing/g)).toHaveLength(1); expect(saved).toContain('HTTP control preview');
    expect(saved).not.toContain('CONTROL_HTTP400_SOURCE_ERROR');
    expect(pairedOfflineTexConsoleCount(consoleUrls, responseUrls)).toBe(consoleUrls.length);
    expect(pageErrors).toEqual([]); expect(unexpectedConsoles).toEqual([]);
  } finally { inControlledPhase = false; await page.unroute(pattern, handler); }
});
