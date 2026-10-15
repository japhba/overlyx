/** GUI characterization: hold the real optional math-keyboard request, then let its JS load normally. */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { login, PROJECTS_DIR, userCredentials } from './helpers';

const BASE = process.env.OVERLYX_E2E_BASE!;
const RUN = process.env.OVERLYX_KEYBOARD_HELD_RUN!;
const EVIDENCE = path.resolve(`scratch/slide-audit/evidence/keyboard-held/${RUN}`);
const OWNER = 'luna1';
type Mime = 'javascript' | 'html' | 'other' | 'unknown';

function sha256(data: Buffer): string { return createHash('sha256').update(data).digest('hex'); }
function routeKey(page: Page): string {
  const segments = new URL(page.url()).hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (segments.length < 4 || segments.at(-2) !== 'slides' || segments.at(-1) !== 'index.html') throw new Error('The GUI did not navigate to a project deck after + New.');
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
function sourceFlags(file: string, proseMarker: string, nextMarker?: string) {
  const source = readFileSync(file, 'utf8');
  const formulas = [...source.matchAll(/\\\(([^]*?)\\\)/g)].map(match => (match[1] ?? '').replace(/\s/g, ''));
  return {
    proseSaved: source.includes(proseMarker),
    formulaCount: formulas.length,
    formulaX1Saved: formulas.some(formula => formula === 'x+1'),
    nextProseSaved: nextMarker ? source.includes(nextMarker) : false,
  };
}
async function fieldState(page: Page, slide: Locator, marker: string) {
  const field = await page.evaluate(() => {
    const input = document.querySelector('[data-dl-mathedit] .lm-input');
    const root = document.querySelector('.mk');
    const visible = (el: Element) => {
      const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const visibleKeys = root ? Array.from(root.querySelectorAll('.mk-key')).filter(visible).length : 0;
    return {
      fieldVisible: !!input && !!input.closest('.lm-field') && visible(input.closest('.lm-field')!),
      inputFocused: !!input && document.activeElement === input,
      inputMode: input instanceof HTMLElement ? (input as HTMLElement & { inputMode?: string }).inputMode ?? null : null,
      inputModeAttribute: input?.getAttribute('inputmode') ?? null,
      customMathKeyboardVisible: !!root && visible(root),
      visibleCustomKeyCount: visibleKeys,
    };
  });
  const draftTextPresent = await slide.evaluate((el: Element, value: string) => (el.textContent ?? '').includes(value), marker).catch(() => false);
  const rawStatus = await page.locator('.dl-status').innerText().catch(() => '');
  const status = ['Saved', 'Saving…', 'Offline', 'Offline — saved in this browser', 'Offline — keep this tab open'].includes(rawStatus) ? rawStatus : 'other';
  return { ...field, saveStatus: status, draftTextPresent };
}

test('GUI holds the actual keyboard chunk for five seconds, records the stuck state, then resumes', async ({ browser, browserName }) => {
  if (!/^[A-Za-z0-9_-]+$/.test(RUN ?? '')
    || !/^[a-f0-9]{64}$/.test(process.env.OVERLYX_EXPECTED_APP_SHA256 ?? '')
    || !/^[a-f0-9]{64}$/.test(process.env.OVERLYX_EXPECTED_RUNTIME_SHA256 ?? '')) throw new Error('Set a unique run ID and immutable app/runtime hashes.');
  if (PROJECTS_DIR !== '/root/lyx/overlyx-slide-audit/scratch/slide-audit/projects'
    || process.env.OVERLYX_E2E_CREDENTIALS !== '/root/lyx/overlyx-slide-audit/scratch/slide-audit/data/credentials.txt'
    || BASE !== 'http://127.0.0.1:3017') throw new Error('Refusing to use non-isolated project paths or server origin.');
  expect(browserName).toBe('chromium');
  test.setTimeout(150_000);
  mkdirSync(EVIDENCE, { recursive: true });

  const context = await browser.newContext({ baseURL: BASE, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  let releaseHeldRequest!: () => void;
  let releaseWasCalled = false;
  const heldGate = new Promise<void>(resolve => { releaseHeldRequest = resolve; });
  try {
    const page = await context.newPage();
    // Keep service-worker support enabled; touch only the fresh parent registration, never the
    // opaque runtime iframe's navigator.serviceWorker getter (Playwright's `block` mode did that).
    await page.addInitScript(() => {
      if (window.top !== window) return;
      const sw = navigator.serviceWorker;
      if (!sw) return;
      Object.defineProperty(sw, 'register', { configurable: true, value: () => Promise.resolve(undefined) });
    });
    const pageErrors = { page: 0, console: 0 };
    page.on('pageerror', () => { pageErrors.page++; });
    page.on('console', message => { if (message.type() === 'error') pageErrors.console++; });

    await login(page, userCredentials(OWNER), { ui: 'default' });
    const name = `e2e-keyboard-held-${RUN}`;
    if (existsSync(path.join(PROJECTS_DIR, OWNER, name))) throw new Error('GUI project already exists; choose a fresh run ID.');
    for (const stage of ['held-before', 'held-at-5s', 'released', 'after-math', 'after-next-prose-save', 'result']) {
      if (existsSync(path.join(EVIDENCE, `${stage}.json`))) throw new Error('Evidence checkpoint already exists; choose a fresh run ID.');
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
    const paths = [...new Set([...swText.matchAll(/"(\/assets\/keyboard-[A-Za-z0-9_-]+\.js)"/g)].map(m => m[1]))];
    if (paths.length !== 1) throw new Error('Expected one public keyboard chunk in this build precache manifest.');
    const keyboardPath = paths[0];
    const keyboardBasename = path.basename(keyboardPath);
    const appDigest = await codeSha(page, pathname => /^\/assets\/index-[^/]+\.js$/.test(pathname));
    const runtimeDigest = await codeSha(page, pathname => pathname === '/_ol/runtime.js');
    expect(appDigest).toBe(process.env.OVERLYX_EXPECTED_APP_SHA256);
    expect(runtimeDigest).toBe(process.env.OVERLYX_EXPECTED_RUNTIME_SHA256);

    const requestState = { requests: 0, responses: 0, responseStatus: 0, responseMime: 'unknown' as Mime, responseJsSha256: '' };
    let resolveRequestSeen!: () => void;
    const requestSeen = new Promise<void>(resolve => { resolveRequestSeen = resolve; });
    let resolveResponseSeen!: () => void;
    const responseSeen = new Promise<void>(resolve => { resolveResponseSeen = resolve; });
    const requestedAt = { ms: 0 };
    await page.route(new URL(keyboardPath, BASE).href, async route => {
      requestState.requests++;
      requestedAt.ms ||= Date.now();
      resolveRequestSeen();
      await heldGate;
      try { await route.continue(); } catch { /* context is closing; no raw error is retained */ }
    });
    page.on('response', async response => {
      let pathname: string;
      try { pathname = new URL(response.url()).pathname; } catch { return; }
      if (pathname !== keyboardPath) return;
      requestState.responses++;
      requestState.responseStatus = response.status();
      const mime = response.headers()['content-type'] ?? '';
      requestState.responseMime = /javascript/i.test(mime) ? 'javascript' : /html/i.test(mime) ? 'html' : 'other';
      const body = await response.body().catch(() => null);
      if (body) requestState.responseJsSha256 = sha256(body);
      resolveResponseSeen();
    });

    const marker = 'Held keyboard request prose';
    await page.locator('[data-tb="dk-text"]').click();
    const slideBox = await slide.boundingBox();
    if (!slideBox) throw new Error('New slide did not expose page-space geometry.');
    await page.mouse.click(slideBox.x + slideBox.width * 0.30, slideBox.y + slideBox.height * 0.32);
    const prose = slide.locator('[contenteditable="true"]').last();
    await expect(prose).toBeVisible({ timeout: 15_000 });
    await expect(prose).toBeFocused();
    await page.keyboard.type(`${marker}: `, { delay: 15 });
    await page.keyboard.press('Control+m');

    let requestObserved = false;
    await Promise.race([requestSeen.then(() => { requestObserved = true; }), new Promise<void>(resolve => setTimeout(resolve, 15_000))]);
    const beforeGateState = await fieldState(page, slide, marker);
    const beforeGate = {
      elapsedMs: requestedAt.ms ? Date.now() - requestedAt.ms : null,
      requestObserved,
      requestCount: requestState.requests,
      responseCount: requestState.responses,
      requestStillHeldWithoutResponse: requestObserved && requestState.requests === 1 && requestState.responses === 0,
      state: beforeGateState,
      hardwareTypingDuringHold: false,
      errors: { ...pageErrors },
    };
    saveEvidence('held-before', { projectBasename: path.basename(project), keyboardChunkBasename: keyboardBasename, appSha256: appDigest, runtimeSha256: runtimeDigest, ...beforeGate });

    const fiveSecondDeadline = requestedAt.ms ? requestedAt.ms + 5_000 : Date.now() + 5_000;
    await new Promise<void>(resolve => setTimeout(resolve, Math.max(0, fiveSecondDeadline - Date.now())));
    const atFiveSecondsState = await fieldState(page, slide, marker);
    const atFiveSeconds = {
      sinceRequestMs: requestedAt.ms ? Date.now() - requestedAt.ms : null,
      heldForMs: requestedAt.ms ? Date.now() - requestedAt.ms : null,
      requestObserved,
      requestCount: requestState.requests,
      responseCount: requestState.responses,
      requestStillHeldWithoutResponse: requestObserved && requestState.requests === 1 && requestState.responses === 0,
      state: atFiveSecondsState,
      hardwareTypingDuringHold: false,
      errors: { ...pageErrors },
    };
    const noMathKeyboardAfterFiveSeconds = atFiveSeconds.state.inputMode === 'none'
      && !atFiveSeconds.state.customMathKeyboardVisible
      && atFiveSeconds.state.visibleCustomKeyCount === 0;
    saveEvidence('held-at-5s', { projectBasename: path.basename(project), keyboardChunkBasename: keyboardBasename, noMathKeyboardAfterFiveSeconds, ...atFiveSeconds });

    releaseWasCalled = true;
    releaseHeldRequest();
    let responseObserved = false;
    await Promise.race([responseSeen.then(() => { responseObserved = true; }), new Promise<void>(resolve => setTimeout(resolve, 20_000))]);
    const recoveryDeadline = Date.now() + 20_000;
    let recoveryState: Awaited<ReturnType<typeof fieldState>> | null = null;
    while (Date.now() < recoveryDeadline) {
      recoveryState = await fieldState(page, slide, marker).catch(() => null);
      if (recoveryState?.customMathKeyboardVisible && recoveryState.visibleCustomKeyCount > 0) break;
      if (recoveryState?.inputMode === 'text' && recoveryState.inputFocused) break;
      await new Promise<void>(resolve => setTimeout(resolve, 50));
    }
    const recoveryMs = requestedAt.ms ? Date.now() - requestedAt.ms : null;
    saveEvidence('released', {
      projectBasename: path.basename(project), keyboardChunkBasename: keyboardBasename,
      requestCount: requestState.requests, responseCount: requestState.responses, responseObserved,
      responseStatus: requestState.responseStatus, responseMime: requestState.responseMime,
      responseJsSha256: requestState.responseJsSha256, recoveryMs, state: recoveryState,
      errors: { ...pageErrors },
    });
    expect(requestObserved).toBe(true);
    expect(requestState.requests).toBe(1);
    expect(requestState.responses).toBe(1);
    expect(responseObserved).toBe(true);
    expect(requestState.responseStatus).toBe(200);
    expect(requestState.responseMime).toBe('javascript');
    expect(recoveryState && ((recoveryState.customMathKeyboardVisible && recoveryState.visibleCustomKeyCount > 0) || (recoveryState.inputMode === 'text' && recoveryState.inputFocused))).toBe(true);

    await page.keyboard.type('x+1', { delay: 20 });
    const liveMath = await page.frameLocator('.dl-frame').locator('.ol-mathchip[data-ol-mathediting]').getAttribute('data-ol-tex').catch(() => null);
    const liveMathHasX1 = (liveMath ?? '').replace(/\s/g, '').includes('x+1');
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-dl-mathedit]')).toHaveCount(0, { timeout: 15_000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30_000 });
    let formulaPersisted = false;
    try { await expect.poll(() => sourceFlags(sourceFile, marker).formulaX1Saved, { timeout: 15_000 }).toBe(true); formulaPersisted = true; } catch { /* preserve the safe checkpoint before the strict assertion */ }
    const sourceAfterMath = sourceFlags(sourceFile, marker);
    const formulaCount = sourceAfterMath.formulaCount;
    const formulaSaved = sourceAfterMath.formulaX1Saved;
    const proseSaved = sourceAfterMath.proseSaved;
    saveEvidence('after-math', {
      projectBasename: path.basename(project), appSha256: appDigest, runtimeSha256: runtimeDigest,
      keyboardChunkBasename: keyboardBasename, noMathKeyboardAfterFiveSeconds, heldAtFiveSeconds: atFiveSeconds,
      recovered: { requestCount: requestState.requests, responseCount: requestState.responses, responseStatus: requestState.responseStatus, responseMime: requestState.responseMime, responseJsSha256: requestState.responseJsSha256, recoveryMs, state: recoveryState },
      liveMathHasX1, formulaPersisted, sourceReadback: { proseSaved, formulaSaved, formulaCount }, errors: { ...pageErrors },
    });
    expect(liveMathHasX1).toBe(true);
    expect(proseSaved).toBe(true);
    expect(formulaPersisted).toBe(true);
    expect(formulaSaved).toBe(true);
    await page.reload();
    const reopenedSlide = page.frameLocator('.dl-frame').locator('section.slide').first();
    await expect(reopenedSlide).toContainText(marker, { timeout: 30_000 });
    await expect(reopenedSlide.locator('mjx-container')).toBeVisible();
    await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30_000 });
    await page.locator('[data-tb="dk-text"]').click();
    const reopenedBox = await reopenedSlide.boundingBox();
    if (!reopenedBox) throw new Error('Reloaded slide did not expose page-space geometry.');
    await page.mouse.click(reopenedBox.x + reopenedBox.width * 0.72, reopenedBox.y + reopenedBox.height * 0.70);
    const nextText = reopenedSlide.locator('[contenteditable="true"]').last();
    await expect(nextText).toBeVisible({ timeout: 15_000 });
    await expect(nextText).toBeFocused();
    await page.keyboard.type('Prose after held keyboard request', { delay: 15 });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30_000 });
    let nextProsePersisted = false;
    try { await expect.poll(() => sourceFlags(sourceFile, marker, 'Prose after held keyboard request').nextProseSaved, { timeout: 15_000 }).toBe(true); nextProsePersisted = true; } catch { /* preserve safe state for the strict assertion */ }
    const finalSource = sourceFlags(sourceFile, marker, 'Prose after held keyboard request');
    const nextProseSaved = finalSource.nextProseSaved;
    saveEvidence('after-next-prose-save', { projectBasename: path.basename(project), proseSaved, formulaSaved, formulaPersisted, nextProseSaved, nextProsePersisted, formulaCount: finalSource.formulaCount, errors: { ...pageErrors } });
    expect(nextProsePersisted).toBe(true);
    expect(nextProseSaved).toBe(true);
    await page.reload();
    await expect(page.frameLocator('.dl-frame').locator('section.slide').first()).toContainText('Prose after held keyboard request');
    await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30_000 });
    expect(pageErrors.page).toBe(0);
    expect(atFiveSeconds.requestStillHeldWithoutResponse).toBe(true);
    expect(noMathKeyboardAfterFiveSeconds).toBe(true);
    saveEvidence('result', {
      projectBasename: path.basename(project), appSha256: appDigest, runtimeSha256: runtimeDigest,
      keyboardChunkBasename: keyboardBasename, noMathKeyboardAfterFiveSeconds, heldAtFiveSeconds: atFiveSeconds,
      recovered: { requestCount: requestState.requests, responseCount: requestState.responses, responseStatus: requestState.responseStatus, responseMime: requestState.responseMime, responseJsSha256: requestState.responseJsSha256, recoveryMs, state: recoveryState },
      sourceReadback: { proseSaved, formulaSaved, formulaPersisted, nextProseSaved, nextProsePersisted, formulaCount: finalSource.formulaCount, reloaded: true }, errors: { ...pageErrors },
    });
  } finally {
    if (!releaseWasCalled) releaseHeldRequest();
    await context.close();
  }
});
