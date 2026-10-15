/** GUI regression for keeping the math field editable while its real lazy keyboard module is pending. */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { login, PROJECTS_DIR, userCredentials } from './helpers';
import { assertPrivateDiagnosticFixture } from './private-diagnostic-fixture';

const BASE = process.env.OVERLYX_E2E_BASE!;
const RUN = process.env.OVERLYX_KEYBOARD_HELD_RUN!;
const FALLBACK_BOUND_MS = Number(process.env.OVERLYX_KEYBOARD_TEXT_FALLBACK_BOUND_MS);
const EVIDENCE = path.resolve(`scratch/slide-audit/evidence/keyboard-held-recovery/${RUN}`);
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
    const pill = document.querySelector('.mk-pill');
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
      expandedKeyboardVisible: !!root && visible(root) && visibleKeys > 0,
      visibleExpandedKeyCount: visibleKeys,
      miniToggleVisible: !!pill && visible(pill),
    };
  });
  const draftTextPresent = await slide.evaluate((el: Element, value: string) => (el.textContent ?? '').includes(value), marker).catch(() => false);
  const rawStatus = await page.locator('.dl-status').innerText().catch(() => '');
  const saveStatus = ['Saved', 'Saving…', 'Offline', 'Offline — saved in this browser', 'Offline — keep this tab open'].includes(rawStatus) ? rawStatus : 'other';
  return { ...field, saveStatus, draftTextPresent };
}

test('GUI stays text-editable through a five-second held keyboard import and ignores its late arrival', async ({ browser, browserName }) => {
  if (!/^[A-Za-z0-9_-]+$/.test(RUN ?? '')
    || !/^[a-f0-9]{64}$/.test(process.env.OVERLYX_EXPECTED_APP_SHA256 ?? '')
    || !/^[a-f0-9]{64}$/.test(process.env.OVERLYX_EXPECTED_RUNTIME_SHA256 ?? '')
    || !/^[a-f0-9]{64}$/.test(process.env.OVERLYX_EXPECTED_KEYBOARD_SHA256 ?? '')
    || !Number.isFinite(FALLBACK_BOUND_MS) || FALLBACK_BOUND_MS < 100 || FALLBACK_BOUND_MS > 4_000) {
    throw new Error('Set a unique run ID, immutable app/runtime/keyboard hashes and a 100–4000 ms fallback bound.');
  }
  assertPrivateDiagnosticFixture({ baseURL: BASE, projectsDir: PROJECTS_DIR });
  expect(browserName).toBe('chromium');
  test.setTimeout(150_000);
  mkdirSync(EVIDENCE, { recursive: true });
  const context = await browser.newContext({ baseURL: BASE, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  let releaseHeldRequest!: () => void;
  let releaseWasCalled = false;
  const heldGate = new Promise<void>(resolve => { releaseHeldRequest = resolve; });
  try {
    const page = await context.newPage();
    // Keep service-worker support enabled; only block this fresh top-level registration, with a
    // guard before touching the opaque runtime iframe's navigator.serviceWorker getter.
    await page.addInitScript(() => {
      if (window.top !== window) return;
      const sw = navigator.serviceWorker;
      if (!sw) return;
      Object.defineProperty(sw, 'register', { configurable: true, value: () => Promise.resolve(undefined) });
    });
    const errors = { page: 0, console: 0 };
    page.on('pageerror', () => { errors.page++; });
    page.on('console', message => { if (message.type() === 'error') errors.console++; });

    await login(page, userCredentials(OWNER), { ui: 'default' });
    const name = `e2e-keyboard-held-recovery-${RUN}`;
    if (existsSync(path.join(PROJECTS_DIR, OWNER, name))) throw new Error('GUI project already exists; choose a fresh run ID.');
    for (const stage of ['before-5s', 'at-5s-immediate', 'at-5s-settled', 'before-source-poll-held', 'after-source-poll-held', 'reopened-held-formula', 'after-late-arrival', 'after-release-close-immediate', 'after-release-close', 'after-next-prose', 'result']) {
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
    const keyboardPaths = [...new Set([...swText.matchAll(/"(\/assets\/keyboard-[A-Za-z0-9_-]+\.js)"/g)].map(m => m[1]))];
    if (keyboardPaths.length !== 1) throw new Error('Expected one public keyboard chunk in this build precache manifest.');
    const keyboardPath = keyboardPaths[0];
    const keyboardBasename = path.basename(keyboardPath);
    const appDigest = await codeSha(page, pathname => /^\/assets\/index-[^/]+\.js$/.test(pathname));
    const runtimeDigest = await codeSha(page, pathname => pathname === '/_ol/runtime.js');
    expect(appDigest).toBe(process.env.OVERLYX_EXPECTED_APP_SHA256);
    expect(runtimeDigest).toBe(process.env.OVERLYX_EXPECTED_RUNTIME_SHA256);

    const network = { requests: 0, responses: 0, responseStatus: 0, responseMime: 'unknown' as Mime, responseSha256: '' };
    let requestStartedAt = 0;
    let resolveRequestSeen!: () => void;
    const requestSeen = new Promise<void>(resolve => { resolveRequestSeen = resolve; });
    let resolveResponseSeen!: () => void;
    const responseSeen = new Promise<void>(resolve => { resolveResponseSeen = resolve; });
    await page.route(new URL(keyboardPath, BASE).href, async route => {
      network.requests++;
      requestStartedAt ||= Date.now();
      resolveRequestSeen();
      await heldGate;
      try { await route.continue(); } catch { /* context shutdown; don't retain raw errors */ }
    });
    page.on('response', async response => {
      let responsePath: string;
      try { responsePath = new URL(response.url()).pathname; } catch { return; }
      if (responsePath !== keyboardPath) return;
      network.responses++;
      network.responseStatus = response.status();
      const mime = response.headers()['content-type'] ?? '';
      network.responseMime = /javascript/i.test(mime) ? 'javascript' : /html/i.test(mime) ? 'html' : 'other';
      const body = await response.body().catch(() => null);
      if (body) network.responseSha256 = sha256(body);
      resolveResponseSeen();
    });

    const proseMarker = 'Held keyboard text fallback';
    await page.locator('[data-tb="dk-text"]').click();
    const slideBox = await slide.boundingBox();
    if (!slideBox) throw new Error('New slide did not expose page-space geometry.');
    await page.mouse.click(slideBox.x + slideBox.width * 0.30, slideBox.y + slideBox.height * 0.32);
    const prose = slide.locator('[contenteditable="true"]').last();
    await expect(prose).toBeVisible({ timeout: 15_000 });
    await expect(prose).toBeFocused();
    await page.keyboard.type(`${proseMarker}: `, { delay: 15 });
    await page.keyboard.press('Control+m');

    let requestObserved = false;
    await Promise.race([requestSeen.then(() => { requestObserved = true; }), new Promise<void>(resolve => setTimeout(resolve, 15_000))]);
    const beforeFiveSeconds = await fieldState(page, slide, proseMarker);
    saveEvidence('before-5s', {
      projectBasename: path.basename(project), appSha256: appDigest, runtimeSha256: runtimeDigest, keyboardChunkBasename: keyboardBasename,
      elapsedFromRequestMs: requestStartedAt ? Date.now() - requestStartedAt : null,
      requestObserved, requestCount: network.requests, responseCount: network.responses,
      heldWithoutResponse: requestObserved && network.requests === 1 && network.responses === 0,
      state: beforeFiveSeconds, hardwareTypingDuringHold: false, errors: { ...errors },
    });

    const fallbackPollStartedAt = Date.now();
    let fallbackSeenByBound = false;
    try {
      await page.waitForFunction(() => {
        const input = document.querySelector('[data-dl-mathedit] .lm-input');
        return input instanceof HTMLElement && input.getAttribute('inputmode') === 'text' && document.activeElement === input;
      }, null, { timeout: FALLBACK_BOUND_MS, polling: 25 });
      fallbackSeenByBound = true;
    } catch { /* quantified timeout is saved below before the strict assertion */ }
    const fallbackWaitElapsedMs = Date.now() - fallbackPollStartedAt;
    // The observation latency is measured against the intercepted module request, not merely
    // against the start of our bounded poll. It is first-observed latency (polling every 25 ms).
    const fallbackLatencyMs = fallbackSeenByBound && requestStartedAt ? Date.now() - requestStartedAt : null;
    const fiveSecondDeadline = requestStartedAt ? requestStartedAt + 5_000 : Date.now() + 5_000;
    await new Promise<void>(resolve => setTimeout(resolve, Math.max(0, fiveSecondDeadline - Date.now())));
    const fiveSecondImmediateState = await fieldState(page, slide, proseMarker);
    const immediateSource = sourceFlags(sourceFile, proseMarker);
    const immediateReadbackAtMs = requestStartedAt ? Date.now() - requestStartedAt : null;
    const requestStillHeld = requestObserved && network.requests === 1 && network.responses === 0;
    saveEvidence('at-5s-immediate', {
      projectBasename: path.basename(project), keyboardChunkBasename: keyboardBasename,
      fallbackBoundMs: FALLBACK_BOUND_MS, fallbackSeenByBound, fallbackLatencyMs,
      fallbackWaitElapsedMs,
      sinceRequestMs: immediateReadbackAtMs, requestCount: network.requests, responseCount: network.responses,
      requestStillHeld, state: fiveSecondImmediateState, immediateSourceReadback: immediateSource,
      immediateReadbackAtMs, hardwareTypingDuringHold: false, errors: { ...errors },
    });
    const fiveSecondNoInput = await fieldState(page, slide, proseMarker);
    saveEvidence('at-5s-settled', {
      projectBasename: path.basename(project), keyboardChunkBasename: keyboardBasename,
      fallbackBoundMs: FALLBACK_BOUND_MS, fallbackSeenByBound, fallbackLatencyMs,
      fallbackWaitElapsedMs,
      sinceRequestMs: requestStartedAt ? Date.now() - requestStartedAt : null,
      requestCount: network.requests, responseCount: network.responses, requestStillHeld,
      state: fiveSecondNoInput, hardwareTypingDuringHold: false, errors: { ...errors },
    });

    // Strict gate: no keyboard input is sent until the pending import is still unresolved and the
    // same visible prose/math field has switched to a focused text input within the chosen bound.
    expect(requestObserved).toBe(true);
    expect(network.requests).toBe(1);
    expect(requestStillHeld).toBe(true);
    expect(fallbackSeenByBound).toBe(true);
    expect(fallbackLatencyMs).not.toBeNull();
    expect(fiveSecondNoInput).toMatchObject({ fieldVisible: true, inputFocused: true, inputMode: 'text', inputModeAttribute: 'text', draftTextPresent: true, expandedKeyboardVisible: false, visibleExpandedKeyCount: 0 });
    expect(fiveSecondNoInput.miniToggleVisible).toBe(false);
    expect(fiveSecondNoInput.saveStatus).toBe('Saved');
    expect(immediateSource.proseSaved).toBe(true);

    await page.keyboard.type('x+1', { delay: 20 });
    const liveMath = await page.frameLocator('.dl-frame').locator('.ol-mathchip[data-ol-mathediting]').getAttribute('data-ol-tex').catch(() => null);
    const liveMathHasX1 = (liveMath ?? '').replace(/\s/g, '').includes('x+1');
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-dl-mathedit]')).toHaveCount(0, { timeout: 15_000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30_000 });
    const beforeSourcePollStatus = await fieldState(page, slide, proseMarker);
    const sourceBeforePoll = sourceFlags(sourceFile, proseMarker);
    saveEvidence('before-source-poll-held', {
      projectBasename: path.basename(project), liveMathHasX1,
      uiSaveStatusImmediatelyAfterSave: beforeSourcePollStatus.saveStatus,
      sourceCountsImmediatelyAfterSave: sourceBeforePoll,
      heldWithoutResponse: network.requests === 1 && network.responses === 0,
      sourceReadAtMsAfterRequest: requestStartedAt ? Date.now() - requestStartedAt : null,
      errors: { ...errors },
    });
    let formulaPersisted = false;
    try { await expect.poll(() => sourceFlags(sourceFile, proseMarker).formulaX1Saved, { timeout: 15_000 }).toBe(true); formulaPersisted = true; } catch { /* safe timeout evidence is recorded before strict checks */ }
    const sourceAfterPoll = sourceFlags(sourceFile, proseMarker);
    saveEvidence('after-source-poll-held', { formulaPersisted, sourceReadback: sourceAfterPoll, requestCount: network.requests, responseCount: network.responses, errors: { ...errors } });
    expect(liveMathHasX1).toBe(true);
    expect(formulaPersisted).toBe(true);
    expect(sourceAfterPoll.formulaX1Saved).toBe(true);

    const savedMath = slide.locator('mjx-container').last();
    await expect(savedMath).toBeVisible();
    const savedMathBox = await savedMath.boundingBox();
    if (!savedMathBox) throw new Error('Saved formula did not expose page-space geometry for reopening.');
    await page.mouse.dblclick(savedMathBox.x + savedMathBox.width / 2, savedMathBox.y + savedMathBox.height / 2);
    await expect(page.locator('[data-dl-mathedit] .lm-field')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-dl-mathedit] .lm-input')).toHaveAttribute('inputmode', 'text');
    const reopenedMath = await page.frameLocator('.dl-frame').locator('.ol-mathchip[data-ol-mathediting]').getAttribute('data-ol-tex').catch(() => null);
    const reopenedMathHasX1 = (reopenedMath ?? '').replace(/\s/g, '') === 'x+1';
    const reopenedState = await fieldState(page, slide, proseMarker);
    saveEvidence('reopened-held-formula', {
      projectBasename: path.basename(project), keyboardChunkBasename: keyboardBasename,
      reopenedMathHasX1, state: reopenedState,
      heldWithoutResponse: network.requests === 1 && network.responses === 0,
      sourceReadback: sourceFlags(sourceFile, proseMarker), errors: { ...errors },
    });
    expect(reopenedMathHasX1).toBe(true);
    expect(reopenedState).toMatchObject({ fieldVisible: true, inputFocused: true, inputMode: 'text', draftTextPresent: true, expandedKeyboardVisible: false, visibleExpandedKeyCount: 0 });
    expect(network.requests).toBe(1);
    expect(network.responses).toBe(0);

    releaseWasCalled = true;
    releaseHeldRequest();
    let responseObserved = false;
    await Promise.race([responseSeen.then(() => { responseObserved = true; }), new Promise<void>(resolve => setTimeout(resolve, 20_000))]);
    if (responseObserved) {
      await page.waitForFunction(basename => performance.getEntriesByType('resource').some(entry => new URL(entry.name).pathname.endsWith(`/${basename}`)), keyboardBasename, { timeout: 5_000 }).catch(() => undefined);
    }
    const lateArrivalSamples: Array<{ elapsedMs: number; inputMode: string | null; inputFocused: boolean; expandedKeyboardVisible: boolean; visibleExpandedKeyCount: number; miniToggleVisible: boolean }> = [];
    const lateArrivalStartedAt = Date.now();
    const lateArrivalDeadline = lateArrivalStartedAt + 1_000;
    while (Date.now() < lateArrivalDeadline && lateArrivalSamples.length < 80) {
      const state = await fieldState(page, slide, proseMarker).catch(() => null);
      if (state) lateArrivalSamples.push({ elapsedMs: Date.now() - lateArrivalStartedAt, inputMode: state.inputMode, inputFocused: state.inputFocused, expandedKeyboardVisible: state.expandedKeyboardVisible, visibleExpandedKeyCount: state.visibleExpandedKeyCount, miniToggleVisible: state.miniToggleVisible });
      await new Promise<void>(resolve => setTimeout(resolve, 25));
    }
    const postArrivalState = await fieldState(page, slide, proseMarker);
    const lateArrivalAudit = {
      watchMs: Date.now() - lateArrivalStartedAt,
      samples: lateArrivalSamples.length,
      everInputModeNone: lateArrivalSamples.some(sample => sample.inputMode === 'none'),
      everExpandedKeyboard: lateArrivalSamples.some(sample => sample.expandedKeyboardVisible || sample.visibleExpandedKeyCount > 0),
      everMiniToggle: lateArrivalSamples.some(sample => sample.miniToggleVisible),
      finalState: postArrivalState,
    };
    saveEvidence('after-late-arrival', {
      projectBasename: path.basename(project), keyboardChunkBasename: keyboardBasename,
      responseObserved, requestCount: network.requests, responseCount: network.responses,
      responseStatus: network.responseStatus, responseMime: network.responseMime, responseSha256: network.responseSha256,
      expectedKeyboardSha256: process.env.OVERLYX_EXPECTED_KEYBOARD_SHA256,
      fallbackBoundMs: FALLBACK_BOUND_MS, fallbackSeenByBound, fallbackLatencyMs,
      fallbackWaitElapsedMs,
      lateArrivalAudit, errors: { ...errors },
    });
    expect(responseObserved).toBe(true);
    expect(network.requests).toBe(1);
    expect(network.responses).toBe(1);
    expect(network.responseStatus).toBe(200);
    expect(network.responseMime).toBe('javascript');
    expect(network.responseSha256).toBe(process.env.OVERLYX_EXPECTED_KEYBOARD_SHA256);
    expect(lateArrivalAudit.everInputModeNone).toBe(false);
    expect(lateArrivalAudit.everExpandedKeyboard).toBe(false);
    expect(postArrivalState).toMatchObject({ fieldVisible: true, inputFocused: true, inputMode: 'text', inputModeAttribute: 'text', expandedKeyboardVisible: false, visibleExpandedKeyCount: 0 });

    await page.keyboard.press('Escape');
    await expect(page.locator('[data-dl-mathedit]')).toHaveCount(0, { timeout: 15_000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30_000 });
    const immediateReleaseClose = await fieldState(page, slide, proseMarker);
    saveEvidence('after-release-close-immediate', { state: immediateReleaseClose, errors: { ...errors } });
    let closeUiClearedWithinBound = false;
    try {
      await expect.poll(async () => {
        const state = await fieldState(page, slide, proseMarker);
        return !state.fieldVisible && !state.expandedKeyboardVisible && state.visibleExpandedKeyCount === 0 && !state.miniToggleVisible;
      }, { timeout: 1_000, intervals: [25] }).toBe(true);
      closeUiClearedWithinBound = true;
    } catch { /* preserve the immediate and final UI states before the strict cleanup assertion */ }
    const afterReleaseClose = await fieldState(page, slide, proseMarker);
    saveEvidence('after-release-close', { state: afterReleaseClose, errors: { ...errors } });
    expect(closeUiClearedWithinBound).toBe(true);
    expect(afterReleaseClose).toMatchObject({ fieldVisible: false, inputFocused: false, expandedKeyboardVisible: false, visibleExpandedKeyCount: 0, miniToggleVisible: false });
    expect(sourceFlags(sourceFile, proseMarker).formulaX1Saved).toBe(true);

    await page.reload();
    const reopenedSlide = page.frameLocator('.dl-frame').locator('section.slide').first();
    await expect(reopenedSlide).toContainText(proseMarker, { timeout: 30_000 });
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
    const nextSourceImmediate = sourceFlags(sourceFile, proseMarker, 'Prose after held keyboard request');
    const nextSaveStatusImmediate = await fieldState(page, reopenedSlide, proseMarker);
    saveEvidence('after-next-prose', { nextSourceImmediate, saveStatus: nextSaveStatusImmediate.saveStatus, errors: { ...errors } });
    let nextProsePersisted = false;
    try { await expect.poll(() => sourceFlags(sourceFile, proseMarker, 'Prose after held keyboard request').nextProseSaved, { timeout: 15_000 }).toBe(true); nextProsePersisted = true; } catch { /* preserve the pre-poll checkpoint */ }
    expect(nextProsePersisted).toBe(true);
    await page.reload();
    await expect(page.frameLocator('.dl-frame').locator('section.slide').first()).toContainText('Prose after held keyboard request');
    await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30_000 });
    saveEvidence('result', {
      projectBasename: path.basename(project), appSha256: appDigest, runtimeSha256: runtimeDigest,
      keyboardChunkBasename: keyboardBasename, fallbackBoundMs: FALLBACK_BOUND_MS, fallbackSeenByBound, fallbackLatencyMs,
      fallbackWaitElapsedMs,
      heldAtFiveSeconds: { requestCount: 1, responseCount: 0, state: fiveSecondNoInput, sourceReadbackImmediately: immediateSource },
      lateArrivalAudit, response: { status: network.responseStatus, mime: network.responseMime, jsSha256: network.responseSha256 },
      sourceReadback: { formulaPersisted, nextProsePersisted, sourceAfterPoll, reloaded: true }, errors: { ...errors },
    });
    expect(errors).toEqual({ page: 0, console: 0 });
  } finally {
    if (!releaseWasCalled) releaseHeldRequest();
    await context.close();
  }
});
