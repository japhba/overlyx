/** GUI-only fault injection: a failed optional math-keyboard chunk must leave the math field usable. */
import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { login, PROJECTS_DIR, userCredentials } from './helpers';
import { assertPrivateDiagnosticFixture } from './private-diagnostic-fixture';

const BASE = process.env.OVERLYX_E2E_BASE!;
const RUN = process.env.OVERLYX_KEYBOARD_FALLBACK_RUN!;
const EVIDENCE = path.resolve(`scratch/slide-audit/evidence/keyboard-fallback/${RUN}`);
const OWNER = 'luna1';

function sha256(data: Buffer): string { return createHash('sha256').update(data).digest('hex'); }
function routeKey(page: Page): string {
  const segments = new URL(page.url()).hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (segments.length < 4 || segments.at(-2) !== 'slides' || segments.at(-1) !== 'index.html') {
    throw new Error('The GUI did not navigate to a project deck after + New.');
  }
  return segments.slice(0, 2).join('/');
}
async function codeSha(page: Page, predicate: (pathname: string) => boolean): Promise<string> {
  const paths = (await Promise.all(page.frames().map(frame => frame.evaluate(() =>
    performance.getEntriesByType('resource').map(entry => new URL(entry.name).pathname),
  ).catch(() => [] as string[])))).flat();
  const pathname = paths.find(predicate);
  if (!pathname) throw new Error('Expected public application asset was not observed.');
  const response = await page.request.get(new URL(pathname, BASE).href);
  if (!response.ok()) throw new Error(`Read-only public asset fetch returned HTTP ${response.status()}.`);
  return sha256(await response.body());
}
function saveEvidence(stage: string, data: Record<string, unknown>): void {
  writeFileSync(path.join(EVIDENCE, `${stage}.json`), JSON.stringify({ run: RUN, stage, at: new Date().toISOString(), ...data }, null, 2) + '\n', { flag: 'wx' });
}
type ErrorCategory = 'keyboard-chunk-503' | 'keyboard-path-unconfirmed' | 'security-localstorage' | 'resizeobserver-loop' | 'abort' | 'other';
function safeName(name: string): string {
  return ['Error', 'TypeError', 'ReferenceError', 'SecurityError', 'SyntaxError', 'URIError', 'AbortError', 'RangeError', 'EvalError'].includes(name) ? name : 'Other';
}
function errorLedger(page: Page, startedAt: number, fault: { responseAtMs: number | null }) {
  const totals = { page: 0, console: 0 };
  const categories: Record<ErrorCategory, number> = {
    'keyboard-chunk-503': 0, 'keyboard-path-unconfirmed': 0, 'security-localstorage': 0,
    'resizeobserver-loop': 0, abort: 0, other: 0,
  };
  const samples: Array<{ channel: 'page' | 'console'; name: string; category: ErrorCategory; keyboardBasenameMatch: boolean; millisecondsAfterFaultResponse: number | null }> = [];
  let keyboardBasename = '';
  let keyboardPathname = '';
  const setKeyboardAsset = (pathname: string) => { keyboardPathname = pathname; keyboardBasename = path.basename(pathname); };
  const classify = (name: string, messageText: string, locationUrl: string): { category: ErrorCategory; matched: boolean; afterFaultMs: number | null } => {
    let matched = !!keyboardBasename && messageText.includes(keyboardBasename);
    if (!matched && keyboardPathname && locationUrl) {
      try { matched = new URL(locationUrl).pathname === keyboardPathname; } catch { /* only a boolean is retained */ }
    }
    const afterFaultMs = fault.responseAtMs === null ? null : Math.max(0, Date.now() - startedAt - fault.responseAtMs);
    if (matched && afterFaultMs !== null && afterFaultMs <= 15_000) return { category: 'keyboard-chunk-503', matched, afterFaultMs };
    if (matched) return { category: 'keyboard-path-unconfirmed', matched, afterFaultMs };
    if (name === 'SecurityError' || /localStorage/i.test(messageText)) return { category: 'security-localstorage', matched, afterFaultMs };
    if (/ResizeObserver loop|undelivered notifications/i.test(messageText)) return { category: 'resizeobserver-loop', matched, afterFaultMs };
    if (name === 'AbortError' || /aborted|aborterror/i.test(messageText)) return { category: 'abort', matched, afterFaultMs };
    return { category: 'other', matched, afterFaultMs };
  };
  const record = (channel: 'page' | 'console', name: string, messageText: string, locationUrl: string) => {
    const classified = classify(name, messageText, locationUrl);
    if (channel === 'page') totals.page++; else totals.console++;
    categories[classified.category]++;
    if (samples.length < 40) samples.push({ channel, name: safeName(name), category: classified.category, keyboardBasenameMatch: classified.matched, millisecondsAfterFaultResponse: classified.afterFaultMs });
  };
  page.on('pageerror', error => record('page', error.name, error.message, ''));
  page.on('console', message => { if (message.type() === 'error') record('console', 'ConsoleError', message.text(), message.location().url); });
  return { setKeyboardAsset, snapshot: () => ({ totals: { ...totals }, categories: { ...categories }, samples: samples.map(sample => ({ ...sample })) }) };
}

test('GUI + New deck stays editable when the optional math keyboard chunk returns 503', async ({ browser, browserName }) => {
  if (!/^[A-Za-z0-9_-]+$/.test(RUN ?? '')
    || !/^[a-f0-9]{64}$/.test(process.env.OVERLYX_EXPECTED_APP_SHA256 ?? '')
    || !/^[a-f0-9]{64}$/.test(process.env.OVERLYX_EXPECTED_RUNTIME_SHA256 ?? '')) {
    throw new Error('Set a unique run identifier and immutable app/runtime hashes before this GUI diagnostic.');
  }
  assertPrivateDiagnosticFixture({ baseURL: BASE, projectsDir: PROJECTS_DIR });
  expect(browserName).toBe('chromium');
  test.setTimeout(150_000);
  mkdirSync(EVIDENCE, { recursive: true });

  // The fresh context has no prior registrations. Let Playwright's service-worker support remain
  // enabled, and block only this origin's top-level registration. The guard must run before reading
  // navigator.serviceWorker because Chromium's opaque runtime iframe cannot access that getter.
  const context = await browser.newContext({
    baseURL: BASE,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  try {
    const page = await context.newPage();
    await page.addInitScript(() => {
      if (window.top !== window) return;
      const sw = navigator.serviceWorker;
      if (!sw) return;
      Object.defineProperty(sw, 'register', { configurable: true, value: () => Promise.resolve(undefined) });
    });
    const startAt = Date.now();
    const faultTiming = { responseAtMs: null as number | null };
    const errors = errorLedger(page, startAt, faultTiming);

    await login(page, userCredentials(OWNER), { ui: 'default' });
    const name = `e2e-keyboard-fallback-${RUN}`;
    if (existsSync(path.join(PROJECTS_DIR, OWNER, name))) throw new Error('GUI project already exists; choose a fresh run identifier.');
    for (const stage of ['keyboard-failure-field-state', 'keyboard-failure-settled-state', 'saved-after-math', 'result']) {
      if (existsSync(path.join(EVIDENCE, `${stage}.json`))) throw new Error('Evidence checkpoint already exists; choose a fresh run identifier.');
    }
    await page.locator('[data-new-project]').click();
    await page.locator('[data-new-kind="deck"]').click();
    await page.locator('[data-new-name]').fill(name);
    await page.locator('[data-new-create]').click();
    const slide = page.frameLocator('.dl-frame').locator('section.slide').first();
    await expect(slide).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30_000 });
    const project = routeKey(page);
    const sourceFile = path.join(PROJECTS_DIR, ...project.split('/'), 'slides', 'index.html');

    // Derive the route from the public precache manifest served by this build, then intercept only
    // that exact lazy chunk. No source document, HTML, or other JS request is modified.
    const swResponse = await page.request.get(new URL('/sw.js', BASE).href);
    if (!swResponse.ok()) throw new Error(`Public precache manifest fetch returned HTTP ${swResponse.status()}.`);
    const swText = await swResponse.text();
    const keyboardPaths = [...new Set([...swText.matchAll(/"(\/assets\/keyboard-[A-Za-z0-9_-]+\.js)"/g)].map(m => m[1]))];
    if (keyboardPaths.length !== 1) throw new Error('Expected one public keyboard chunk in this build precache manifest.');
    const keyboardPath = keyboardPaths[0];
    errors.setKeyboardAsset(keyboardPath);
    const fault = { requests: 0, fulfilled: false, status: 0, mime: 'unknown' as 'javascript' | 'html' | 'other' | 'unknown', returnedHtml: false, responseAtMs: null as number | null };
    let resolveFaultResponse!: () => void;
    const faultResponseServed = new Promise<void>(resolve => { resolveFaultResponse = resolve; });
    await page.route(new URL(keyboardPath, BASE).href, async route => {
      fault.requests++;
      const response = {
        status: 503,
        contentType: 'application/javascript; charset=utf-8',
        headers: { 'cache-control': 'no-store' },
        body: '/* controlled keyboard-chunk failure for GUI diagnostic */',
      };
      fault.status = response.status;
      fault.mime = /javascript/i.test(response.contentType) ? 'javascript' : /html/i.test(response.contentType) ? 'html' : 'other';
      fault.returnedHtml = /<html|<!doctype/i.test(response.body);
      await route.fulfill(response);
      fault.fulfilled = true;
      fault.responseAtMs = Date.now() - startAt;
      faultTiming.responseAtMs = fault.responseAtMs;
      resolveFaultResponse();
    });

    const appDigest = await codeSha(page, pathname => /^\/assets\/index-[^/]+\.js$/.test(pathname));
    const runtimeDigest = await codeSha(page, pathname => pathname === '/_ol/runtime.js');
    expect(appDigest).toBe(process.env.OVERLYX_EXPECTED_APP_SHA256);
    expect(runtimeDigest).toBe(process.env.OVERLYX_EXPECTED_RUNTIME_SHA256);

    // Real GUI text-box creation and edit; Ctrl+M is issued from the focused editable text.
    await page.locator('[data-tb="dk-text"]').click();
    const slideBox = await slide.boundingBox();
    if (!slideBox) throw new Error('New slide did not expose page-space geometry.');
    await page.mouse.click(slideBox.x + slideBox.width * 0.30, slideBox.y + slideBox.height * 0.32);
    const prose = slide.locator('[contenteditable="true"]').last();
    await expect(prose).toBeVisible({ timeout: 15_000 });
    await expect(prose).toHaveAttribute('contenteditable', 'true');
    await expect(prose).toBeFocused();
    await page.keyboard.type('Fallback remains editable: ', { delay: 15 });
    await page.keyboard.press('Control+m');

    const field = page.locator('[data-dl-mathedit] .lm-field');
    const input = page.locator('[data-dl-mathedit] .lm-input');
    let responseCompleted = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      faultResponseServed.then(() => { responseCompleted = true; }),
      new Promise<void>(resolve => { timeoutHandle = setTimeout(resolve, 15_000); }),
    ]);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    const focusAndKeyboard = await page.evaluate(() => {
      const input = document.querySelector('[data-dl-mathedit] .lm-input');
      const active = document.activeElement;
      const keyboard = document.querySelector('.mk');
      return {
        inputFocused: !!input && active === input,
        fieldVisible: !!input && !!input.closest('.lm-field') && (input.closest('.lm-field') as HTMLElement).getBoundingClientRect().width > 0,
        customMathKeyboardVisible: !!keyboard && (() => { const r = (keyboard as HTMLElement).getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(keyboard).visibility !== 'hidden' && getComputedStyle(keyboard).display !== 'none'; })(),
        inputMode: input instanceof HTMLElement ? (input as HTMLElement & { inputMode?: string }).inputMode ?? null : null,
        inputModeAttribute: input?.getAttribute('inputmode') ?? null,
      };
    });
    const fallbackState = { fault: { ...fault, basename: path.basename(keyboardPath) }, responseCompleted, fieldVisible: await field.isVisible().catch(() => false), focusAndKeyboard, errors: { ...errors } };
    saveEvidence('keyboard-failure-field-state', { ...fallbackState, errors: errors.snapshot() });
    expect(responseCompleted).toBe(true);
    expect(fault.requests).toBeGreaterThan(0);
    expect(fault.fulfilled).toBe(true);
    expect(fault.status).toBe(503);
    expect(fault.mime).toBe('javascript');
    expect(fault.returnedHtml).toBe(false);
    expect(fallbackState.fieldVisible).toBe(true);

    // Do not type into the math field until the async import failure/catch has had a bounded chance
    // to settle. Record the early snapshot above as well as this settled snapshot before assertions.
    const fallbackPollStartedAt = Date.now();
    let fallbackSettled = false;
    try {
      await page.waitForFunction(() => {
        const input = document.querySelector('[data-dl-mathedit] .lm-input');
        return input instanceof HTMLElement && input.getAttribute('inputmode') === 'text' && document.activeElement === input;
      }, null, { timeout: 1_500, polling: 25 });
      fallbackSettled = true;
    } catch { /* timeout is evidence; the strict assertion follows the checkpoint */ }
    const fallbackLatencyMs = Date.now() - fallbackPollStartedAt;
    const settledFieldState = await page.evaluate(() => {
      const input = document.querySelector('[data-dl-mathedit] .lm-input');
      const keyboard = document.querySelector('.mk');
      return {
        inputFocused: !!input && document.activeElement === input,
        fieldVisible: !!input && !!input.closest('.lm-field') && (input.closest('.lm-field') as HTMLElement).getBoundingClientRect().width > 0,
        customMathKeyboardVisible: !!keyboard && (() => { const r = (keyboard as HTMLElement).getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(keyboard).visibility !== 'hidden' && getComputedStyle(keyboard).display !== 'none'; })(),
        inputMode: input instanceof HTMLElement ? (input as HTMLElement & { inputMode?: string }).inputMode ?? null : null,
        inputModeAttribute: input?.getAttribute('inputmode') ?? null,
      };
    });
    const settledErrors = errors.snapshot();
    saveEvidence('keyboard-failure-settled-state', {
      fault: { ...fault, basename: path.basename(keyboardPath) },
      fallbackSettled,
      fallbackLatencyMs,
      settledFieldState,
      errors: settledErrors,
    });
    expect(fallbackSettled).toBe(true);
    expect(settledFieldState).toMatchObject({ inputFocused: true, fieldVisible: true, customMathKeyboardVisible: false, inputMode: 'text', inputModeAttribute: 'text' });
    expect(settledErrors.totals.page).toBe(0);
    expect(settledErrors.categories).toMatchObject({ 'keyboard-path-unconfirmed': 0, 'security-localstorage': 0, 'resizeobserver-loop': 0, abort: 0, other: 0 });

    // Continue using ordinary desktop keyboard input in the still-focused math field.
    await page.keyboard.type('x+1', { delay: 25 });
    const liveMath = await page.frameLocator('.dl-frame').locator('.ol-mathchip[data-ol-mathediting]').getAttribute('data-ol-tex').catch(() => null);
    expect((liveMath ?? '').replace(/\s/g, '')).toContain('x+1');
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-dl-mathedit]')).toHaveCount(0, { timeout: 15_000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30_000 });
    const sourceAfterMath = readFileSync(sourceFile, 'utf8');
    const sourceHasProse = sourceAfterMath.includes('Fallback remains editable:');
    const sourceHasMath = [...sourceAfterMath.matchAll(/\\\(([^]*?)\\\)/g)].some(match => (match[1] ?? '').replace(/\s/g, '') === 'x+1');
    expect(sourceHasProse).toBe(true);
    expect(sourceHasMath).toBe(true);
    saveEvidence('saved-after-math', { sourceHasProse, sourceHasMath, fault: { ...fault, basename: path.basename(keyboardPath) }, errors: errors.snapshot() });

    await page.reload();
    const reopenedSlide = page.frameLocator('.dl-frame').locator('section.slide').first();
    await expect(reopenedSlide).toContainText('Fallback remains editable:', { timeout: 30_000 });
    await expect(reopenedSlide.locator('mjx-container')).toHaveCount(1, { timeout: 30_000 });
    await expect(reopenedSlide.locator('mjx-container')).toBeVisible();
    await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30_000 });
    const sourceAfterReload = readFileSync(sourceFile, 'utf8');
    expect(sourceAfterReload.includes('Fallback remains editable:')).toBe(true);
    expect([...sourceAfterReload.matchAll(/\\\(([^]*?)\\\)/g)].some(match => (match[1] ?? '').replace(/\s/g, '') === 'x+1')).toBe(true);

    // Verify the next normal prose action, after reload, still completes and persists.
    await page.locator('[data-tb="dk-text"]').click();
    const reopenedBox = await reopenedSlide.boundingBox();
    if (!reopenedBox) throw new Error('Reloaded slide did not expose page-space geometry.');
    await page.mouse.click(reopenedBox.x + reopenedBox.width * 0.72, reopenedBox.y + reopenedBox.height * 0.70);
    const nextText = reopenedSlide.locator('[contenteditable="true"]').last();
    await expect(nextText).toBeVisible({ timeout: 15_000 });
    await expect(nextText).toBeFocused();
    await page.keyboard.type('Next prose action works', { delay: 15 });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30_000 });
    expect(readFileSync(sourceFile, 'utf8').includes('Next prose action works')).toBe(true);
    await page.reload();
    await expect(page.frameLocator('.dl-frame').locator('section.slide').first()).toContainText('Next prose action works');
    await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30_000 });
    saveEvidence('result', {
      projectBasename: path.basename(project),
      appSha256: appDigest,
      runtimeSha256: runtimeDigest,
      keyboardChunkBasename: path.basename(keyboardPath),
      serviceWorkers: 'default enabled; guarded init script blocks only top-level registration; no prior worker in fresh context',
      failedChunk: { ...fault, basename: path.basename(keyboardPath) },
      sourceReadback: { prose: true, formula: true, postReloadProse: true },
      fieldStateAtFallback: focusAndKeyboard,
      fallbackSettled,
      fallbackLatencyMs,
      settledFieldState,
      errors: errors.snapshot(),
    });
  } finally {
    await context.close();
  }
});

test('Control: the same GUI formula flow with the keyboard chunk unmodified', async ({ browser, browserName }) => {
  if (!/^[A-Za-z0-9_-]+$/.test(RUN ?? '')
    || !/^[a-f0-9]{64}$/.test(process.env.OVERLYX_EXPECTED_APP_SHA256 ?? '')
    || !/^[a-f0-9]{64}$/.test(process.env.OVERLYX_EXPECTED_RUNTIME_SHA256 ?? '')) {
    throw new Error('Set a unique run identifier and immutable app/runtime hashes before this GUI diagnostic.');
  }
  assertPrivateDiagnosticFixture({ baseURL: BASE, projectsDir: PROJECTS_DIR });
  expect(browserName).toBe('chromium');
  test.setTimeout(150_000);
  const context = await browser.newContext({
    baseURL: BASE,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  try {
    const page = await context.newPage();
    await page.addInitScript(() => {
      if (window.top !== window) return;
      const sw = navigator.serviceWorker;
      if (!sw) return;
      Object.defineProperty(sw, 'register', { configurable: true, value: () => Promise.resolve(undefined) });
    });
    const startAt = Date.now();
    const errors = errorLedger(page, startAt, { responseAtMs: null });
    const keyboardFetch = { requests: 0, status: 0, mime: 'unknown' as 'javascript' | 'html' | 'other' | 'unknown' };

    await login(page, userCredentials(OWNER), { ui: 'default' });
    const name = `e2e-keyboard-control-${RUN}`;
    if (existsSync(path.join(PROJECTS_DIR, OWNER, name))) throw new Error('Control project already exists; choose a fresh run identifier.');
    for (const stage of ['control-after-math', 'control-result']) {
      if (existsSync(path.join(EVIDENCE, `${stage}.json`))) throw new Error('Control evidence already exists; choose a fresh run identifier.');
    }
    await page.locator('[data-new-project]').click();
    await page.locator('[data-new-kind="deck"]').click();
    await page.locator('[data-new-name]').fill(name);
    await page.locator('[data-new-create]').click();
    const slide = page.frameLocator('.dl-frame').locator('section.slide').first();
    await expect(slide).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30_000 });
    const project = routeKey(page);
    const sourceFile = path.join(PROJECTS_DIR, ...project.split('/'), 'slides', 'index.html');

    const swResponse = await page.request.get(new URL('/sw.js', BASE).href);
    if (!swResponse.ok()) throw new Error(`Public precache manifest fetch returned HTTP ${swResponse.status()}.`);
    const swText = await swResponse.text();
    const keyboardPaths = [...new Set([...swText.matchAll(/"(\/assets\/keyboard-[A-Za-z0-9_-]+\.js)"/g)].map(m => m[1]))];
    if (keyboardPaths.length !== 1) throw new Error('Expected one public keyboard chunk in this build precache manifest.');
    const keyboardPath = keyboardPaths[0];
    errors.setKeyboardAsset(keyboardPath);
    page.on('response', response => {
      try {
        if (new URL(response.url()).pathname !== keyboardPath) return;
        keyboardFetch.requests++;
        keyboardFetch.status = response.status();
        const mime = response.headers()['content-type'] ?? '';
        keyboardFetch.mime = /javascript/i.test(mime) ? 'javascript' : /html/i.test(mime) ? 'html' : 'other';
      } catch { /* only safe numeric/MIME metadata is retained */ }
    });

    const appDigest = await codeSha(page, pathname => /^\/assets\/index-[^/]+\.js$/.test(pathname));
    const runtimeDigest = await codeSha(page, pathname => pathname === '/_ol/runtime.js');
    expect(appDigest).toBe(process.env.OVERLYX_EXPECTED_APP_SHA256);
    expect(runtimeDigest).toBe(process.env.OVERLYX_EXPECTED_RUNTIME_SHA256);
    await page.locator('[data-tb="dk-text"]').click();
    const slideBox = await slide.boundingBox();
    if (!slideBox) throw new Error('Control slide did not expose page-space geometry.');
    await page.mouse.click(slideBox.x + slideBox.width * 0.30, slideBox.y + slideBox.height * 0.32);
    const prose = slide.locator('[contenteditable="true"]').last();
    await expect(prose).toBeVisible({ timeout: 15_000 });
    await expect(prose).toBeFocused();
    await page.keyboard.type('Control flow remains editable: ', { delay: 15 });
    await page.keyboard.press('Control+m');
    const field = page.locator('[data-dl-mathedit] .lm-field');
    await expect(field).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => keyboardFetch.requests, { timeout: 15_000 }).toBeGreaterThan(0);
    await page.keyboard.type('x+1', { delay: 25 });
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-dl-mathedit]')).toHaveCount(0, { timeout: 15_000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30_000 });
    const sourceAfterMath = readFileSync(sourceFile, 'utf8');
    const sourceHasProse = sourceAfterMath.includes('Control flow remains editable:');
    const sourceHasMath = [...sourceAfterMath.matchAll(/\\\(([^]*?)\\\)/g)].some(match => (match[1] ?? '').replace(/\s/g, '') === 'x+1');
    expect(sourceHasProse).toBe(true);
    expect(sourceHasMath).toBe(true);
    saveEvidence('control-after-math', { projectBasename: path.basename(project), keyboardFetch: { ...keyboardFetch, basename: path.basename(keyboardPath) }, sourceReadback: { prose: sourceHasProse, formula: sourceHasMath }, errors: errors.snapshot() });

    await page.reload();
    const reopenedSlide = page.frameLocator('.dl-frame').locator('section.slide').first();
    await expect(reopenedSlide).toContainText('Control flow remains editable:', { timeout: 30_000 });
    await expect(reopenedSlide.locator('mjx-container')).toHaveCount(1, { timeout: 30_000 });
    await expect(reopenedSlide.locator('mjx-container')).toBeVisible();
    await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30_000 });
    await page.locator('[data-tb="dk-text"]').click();
    const reopenedBox = await reopenedSlide.boundingBox();
    if (!reopenedBox) throw new Error('Control reload slide did not expose page-space geometry.');
    await page.mouse.click(reopenedBox.x + reopenedBox.width * 0.72, reopenedBox.y + reopenedBox.height * 0.70);
    const nextText = reopenedSlide.locator('[contenteditable="true"]').last();
    await expect(nextText).toBeVisible({ timeout: 15_000 });
    await expect(nextText).toBeFocused();
    await page.keyboard.type('Control next prose action works', { delay: 15 });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30_000 });
    expect(readFileSync(sourceFile, 'utf8').includes('Control next prose action works')).toBe(true);
    await page.reload();
    await expect(page.frameLocator('.dl-frame').locator('section.slide').first()).toContainText('Control next prose action works');
    await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30_000 });
    saveEvidence('control-result', {
      projectBasename: path.basename(project), appSha256: appDigest, runtimeSha256: runtimeDigest,
      keyboardChunkBasename: path.basename(keyboardPath), serviceWorkers: 'default enabled; guarded init script blocks only top-level registration; no prior worker in fresh context',
      keyboardFetch: { ...keyboardFetch, basename: path.basename(keyboardPath) },
      sourceReadback: { prose: true, formula: true, postReloadProse: true }, errors: errors.snapshot(),
    });
  } finally {
    await context.close();
  }
});
