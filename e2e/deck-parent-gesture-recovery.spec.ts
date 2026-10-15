/** Normal GUI regression cases for rail interruption/recovery. Pinch calibration is opt-in elsewhere. */
import { test, expect, type Browser, type Page } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { login, newTouchContext, PROJECTS_DIR, userCredentials, BASE_URL } from './helpers';

const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const USER = process.env.OVERLYX_BETA_DECK_USER ?? 'luna1';
const made: string[] = [];
const REQUIRED_ENV = ['OVERLYX_E2E_BASE', 'OVERLYX_PROJECTS_DIR', 'OVERLYX_E2E_CREDENTIALS',
  'OVERLYX_EXPECTED_APP_SHA256', 'OVERLYX_EXPECTED_RUNTIME_SHA256'] as const;

function requirePortableEnvironment(): void {
  const missing = REQUIRED_ENV.filter(key => !process.env[key]);
  if (missing.length) throw new Error(`Set the isolated e2e environment (${missing.join(', ')}) before creating a private fixture deck.`);
  if (process.env.OVERLYX_E2E_BASE !== BASE_URL || process.env.OVERLYX_PROJECTS_DIR !== PROJECTS_DIR) {
    throw new Error('Gesture GUI probe requires explicit, matching isolated base URL and project directory variables.');
  }
}

test.afterAll(() => {
  for (const project of made) rmSync(path.join(PROJECTS_DIR, ...project.split('/')), { recursive: true, force: true });
});

async function createDeck(browser: Browser, name: string, viewport: { width: number; height: number }): Promise<{ context: Awaited<ReturnType<typeof newTouchContext>>; page: Page; project: string; errors: { page: number; console: number } }> {
  const context = await newTouchContext(browser, { baseURL: BASE_URL, viewport });
  const page = await context.newPage();
  const errors = collectErrors(page);
  page.setDefaultTimeout(12_000);
  await page.setViewportSize(viewport);
  await login(page, userCredentials(USER), { ui: 'default' });
  await page.locator('[data-new-project]').click();
  await page.locator('[data-new-kind="deck"]').click();
  await page.locator('[data-new-name]').fill(name);
  await page.locator('[data-new-create]').click();
  const project = `${USER}/${name}`;
  made.push(project);
  await expect(page).toHaveURL(url => url.hash === `#/${project}/slides/index.html`);
  await expect(page.locator('.dl-frame')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30_000 });
  return { context, page, project, errors };
}

function collectErrors(page: Page): { page: number; console: number } {
  const errors = { page: 0, console: 0 };
  page.on('pageerror', () => { errors.page++; });
  page.on('console', message => { if (message.type() === 'error') errors.console++; });
  return errors;
}

async function servedCodeHashes(page: Page): Promise<{ app: string; runtime: string }> {
  const entries = await Promise.all(page.frames().map(frame => frame.evaluate(() =>
    performance.getEntriesByType('resource').map(entry => new URL(entry.name).pathname)
      .filter(path => /^\/assets\/index-[^/]+\.js$/.test(path) || path === '/_ol/runtime.js')
      .map(path => ({ path, url: new URL(path, location.href).href })),
  ).catch(() => [] as { path: string; url: string }[])));
  const resources = entries.flat();
  const hashOf = async (kind: 'app' | 'runtime', pathMatch: (path: string) => boolean) => {
    const asset = resources.find(resource => pathMatch(resource.path));
    if (!asset) throw new Error(`Could not identify the served ${kind} JavaScript asset for this page.`);
    const response = await page.request.get(asset.url);
    if (!response.ok()) throw new Error(`Could not read the served ${kind} JavaScript asset (HTTP ${response.status()}).`);
    return createHash('sha256').update(await response.body()).digest('hex');
  };
  const hashes = {
    app: await hashOf('app', p => /^\/assets\/index-[^/]+\.js$/.test(p)),
    runtime: await hashOf('runtime', p => p === '/_ol/runtime.js'),
  };
  const expectedApp = process.env.OVERLYX_EXPECTED_APP_SHA256;
  const expectedRuntime = process.env.OVERLYX_EXPECTED_RUNTIME_SHA256;
  expect(hashes.app, 'served app bundle matches requested immutable candidate').toBe(expectedApp);
  expect(hashes.runtime, 'served runtime matches requested immutable candidate').toBe(expectedRuntime);
  return hashes;
}

test('rail grip interruption: synthetic lostpointercapture is recorded distinctly from trusted mouse drag', async ({ browser, browserName }, info) => {
  requirePortableEnvironment();
  test.skip(browserName !== 'chromium', 'This focused interruption probe is run in Chromium only.');
  test.setTimeout(120_000);
  const { context, page, errors } = await createDeck(browser, `gesture-rail-${RUN}`, { width: 1024, height: 768 });
  try {
    const hashes = await servedCodeHashes(page);
    const grip = page.locator('[data-dl-railgrip]');
    const rail = page.locator('.dl-rail');
    await expect(grip).toBeVisible();
    const initial = await page.evaluate(() => ({
      width: document.querySelector('.dl-rail')!.getBoundingClientRect().width,
      stored: localStorage.getItem('ol.deckRail'),
    }));
    const box = (await grip.boundingBox())!;
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 48, y, { steps: 4 });
    await expect.poll(() => rail.evaluate(el => el.getBoundingClientRect().width)).not.toBe(initial.width);
    const moved = await rail.evaluate(el => el.getBoundingClientRect().width);

    // This dispatched event is deliberately synthetic: it probes the component's event cleanup,
    // but does not claim to reproduce an OS/hardware pointer-capture loss.
    const syntheticEvent = await grip.evaluate(el => {
      const event = new PointerEvent('lostpointercapture', { bubbles: true, cancelable: false, pointerId: 1, pointerType: 'mouse', isPrimary: true });
      el.dispatchEvent(event);
      return { isTrusted: event.isTrusted, dispatchedAtGrip: event.target === el };
    });
    await page.waitForTimeout(50);
    const afterSyntheticLoss = await page.evaluate(() => ({
      width: document.querySelector('.dl-rail')!.getBoundingClientRect().width,
      stored: localStorage.getItem('ol.deckRail'),
      gripActive: document.querySelector('[data-dl-railgrip]')!.classList.contains('on'),
    }));
    // A continued physical mouse move tests whether the active drag listener is still live.
    await page.mouse.move(x + 72, y, { steps: 2 });
    const afterStrayMove = await rail.evaluate(el => el.getBoundingClientRect().width);
    await page.screenshot({ path: info.outputPath('rail-after-interruption.png') });
    await page.mouse.up(); // releases the real GUI drag even if the tested cancellation path is broken
    const finalStored = await page.evaluate(() => localStorage.getItem('ol.deckRail'));
    await info.attach('rail-interruption-readback.json', {
      body: Buffer.from(JSON.stringify({ appSha256: hashes.app, runtimeSha256: hashes.runtime, viewport: { width: 1024, height: 768 }, drag: 'real Playwright mouse input', interruption: 'synthetic lostpointercapture dispatch; isTrusted is false', initial, moved, syntheticEvent, afterSyntheticLoss, afterStrayMove, finalStored, errors }, null, 2)),
      contentType: 'application/json',
    });
    writeFileSync(info.outputPath('rail-interruption-readback.json'), JSON.stringify({ appSha256: hashes.app, runtimeSha256: hashes.runtime, viewport: { width: 1024, height: 768 }, drag: 'real Playwright mouse input', interruption: 'synthetic lostpointercapture dispatch; isTrusted is false', initial, moved, syntheticEvent, afterSyntheticLoss, afterStrayMove, finalStored, errors }, null, 2));

    // Desired cancellation oracle: discard the preview, clear active state, and ignore later moves.
    expect(syntheticEvent.isTrusted, 'the lost-capture edge is explicitly a test-dispatched synthetic event').toBe(false);
    expect(afterSyntheticLoss.width, 'interruption restores the original rail width').toBe(initial.width);
    expect(afterSyntheticLoss.gripActive, 'interruption clears the grip active class').toBe(false);
    expect(afterSyntheticLoss.stored, 'an interrupted drag does not persist a partial width').toBe(initial.stored);
    expect(afterStrayMove, 'later mouse movement cannot keep changing the interrupted rail').toBe(initial.width);
    expect(errors).toEqual({ page: 0, console: 0 });
  } finally { await context.close(); }
});

test('rail grip rolls back on browser-generated lostpointercapture after explicit capture release', async ({ browser, browserName }, info) => {
  requirePortableEnvironment();
  test.skip(browserName !== 'chromium', 'Native pointer-capture lifecycle probe is Chromium-only.');
  test.setTimeout(120_000);
  const { context, page, errors } = await createDeck(browser, `gesture-native-loss-${RUN}`, { width: 1024, height: 768 });
  try {
    const hashes = await servedCodeHashes(page);
    const grip = page.locator('[data-dl-railgrip]');
    const rail = page.locator('.dl-rail');
    await expect(grip).toBeVisible();
    await page.evaluate(() => {
      (window as any).__nativeCapture = { down: null, lost: null };
      document.addEventListener('pointerdown', event => {
        if ((event.target as Element)?.closest?.('[data-dl-railgrip]')) {
          (window as any).__nativeCapture.down = { pointerId: event.pointerId, isTrusted: event.isTrusted, pointerType: event.pointerType };
        }
      }, true);
      document.addEventListener('lostpointercapture', event => {
        if ((event.target as Element)?.closest?.('[data-dl-railgrip]')) {
          (window as any).__nativeCapture.lost = { pointerId: event.pointerId, isTrusted: event.isTrusted, pointerType: event.pointerType };
        }
      }, true);
    });
    const initial = await page.evaluate(() => ({
      width: document.querySelector('.dl-rail')!.getBoundingClientRect().width,
      stored: localStorage.getItem('ol.deckRail'),
    }));
    const box = (await grip.boundingBox())!;
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 48, y, { steps: 4 });
    await expect.poll(() => rail.evaluate(el => el.getBoundingClientRect().width)).not.toBe(initial.width);
    const moved = await rail.evaluate(el => el.getBoundingClientRect().width);
    const capture = await page.evaluate(() => {
      const record = (window as any).__nativeCapture.down;
      const gripElement = document.querySelector('[data-dl-railgrip]') as Element & { hasPointerCapture(id: number): boolean };
      return { ...record, hasPointerCapture: record ? gripElement.hasPointerCapture(record.pointerId) : false };
    });
    const captureEvidence = { appSha256: hashes.app, runtimeSha256: hashes.runtime,
      viewport: { width: 1024, height: 768 }, stage: 'pre-assertion-native-capture-readback',
      initial, moved, capture, errors };
    mkdirSync(info.outputDir, { recursive: true });
    writeFileSync(info.outputPath('rail-native-capture-before-assertions.json'), JSON.stringify(captureEvidence, null, 2));
    await info.attach('rail-native-capture-before-assertions.json', {
      path: info.outputPath('rail-native-capture-before-assertions.json'), contentType: 'application/json',
    });
    expect(capture.pointerId, 'a real browser mouse pointerdown supplied an actual pointer id').toEqual(expect.any(Number));
    expect(capture.isTrusted, 'the initiating pointerdown came from real Playwright mouse input').toBe(true);
    expect(capture.pointerType).toBe('mouse');
    expect(capture.hasPointerCapture, 'the grip owns native capture for that pointer id').toBe(true);

    // The API call asks the browser to release its real capture. The following real move gives
    // the UA a dispatch point for the pending lostpointercapture; the resulting event must be trusted.
    await grip.evaluate((el, pointerId) => (el as Element & { releasePointerCapture(id: number): void }).releasePointerCapture(pointerId), capture.pointerId);
    await page.mouse.move(x + 56, y, { steps: 1 });
    await expect.poll(() => page.evaluate(() => (window as any).__nativeCapture.lost)).not.toBeNull();
    const afterLoss = await page.evaluate(() => ({
      loss: (window as any).__nativeCapture.lost,
      width: document.querySelector('.dl-rail')!.getBoundingClientRect().width,
      stored: localStorage.getItem('ol.deckRail'),
      gripActive: document.querySelector('[data-dl-railgrip]')!.classList.contains('on'),
    }));
    await page.mouse.move(x + 80, y, { steps: 2 });
    const afterStrayMove = await rail.evaluate(el => el.getBoundingClientRect().width);
    await page.mouse.up();

    // A fresh ordinary drag must still work after the browser-generated loss.
    const nextBox = (await grip.boundingBox())!;
    const nx = nextBox.x + nextBox.width / 2, ny = nextBox.y + nextBox.height / 2;
    await page.mouse.move(nx, ny);
    await page.mouse.down();
    await page.mouse.move(nx + 36, ny, { steps: 3 });
    await expect.poll(() => rail.evaluate(el => el.getBoundingClientRect().width)).not.toBe(initial.width);
    const nextMoved = await rail.evaluate(el => el.getBoundingClientRect().width);
    await page.mouse.up();
    const nextFinal = await page.evaluate(() => ({
      width: document.querySelector('.dl-rail')!.getBoundingClientRect().width,
      stored: localStorage.getItem('ol.deckRail'),
      gripActive: document.querySelector('[data-dl-railgrip]')!.classList.contains('on'),
    }));
    const evidence = {
      appSha256: hashes.app, runtimeSha256: hashes.runtime,
      viewport: { width: 1024, height: 768 },
      interruption: 'API-induced native pointer capture release; browser-generated lostpointercapture, not physical OS loss',
      initial, moved, capture, afterLoss, afterStrayMove, nextMoved, nextFinal, errors,
    };
    mkdirSync(info.outputDir, { recursive: true });
    writeFileSync(info.outputPath('rail-native-capture-loss.json'), JSON.stringify(evidence, null, 2));
    await info.attach('rail-native-capture-loss.json', { body: Buffer.from(JSON.stringify(evidence, null, 2)), contentType: 'application/json' });
    await page.screenshot({ path: info.outputPath('rail-native-capture-loss.png') });

    expect(afterLoss.loss.isTrusted, 'the lostpointercapture was delivered by the browser, not dispatched by the test').toBe(true);
    expect(afterLoss.loss.pointerId).toBe(capture.pointerId);
    expect(afterLoss.width, 'native interruption restores original rail width').toBe(initial.width);
    expect(afterLoss.gripActive, 'native interruption clears active drag styling').toBe(false);
    expect(afterLoss.stored, 'interrupted native drag does not persist a partial width').toBe(initial.stored);
    expect(afterStrayMove, 'subsequent movement cannot mutate interrupted rail preview').toBe(initial.width);
    expect(nextMoved, 'a fresh regular drag still resizes the rail').not.toBe(initial.width);
    expect(nextFinal.width).toBe(nextMoved);
    expect(nextFinal.stored).not.toBe(initial.stored);
    expect(nextFinal.gripActive).toBe(false);
    expect(errors).toEqual({ page: 0, console: 0 });
  } finally { await context.close(); }
});
