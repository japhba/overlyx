/** A trusted short pan that starts on blank slide content (inside the runtime iframe). */
import { test, expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { login, newTouchContext, PROJECTS_DIR, userCredentials, BASE_URL } from './helpers';

const RUN = `runtime-pan-cancel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const USER = process.env.OVERLYX_BETA_DECK_USER ?? 'luna1';
const REQUIRED_ENV = [
  'OVERLYX_E2E_BASE', 'OVERLYX_PROJECTS_DIR', 'OVERLYX_E2E_CREDENTIALS',
  'OVERLYX_EXPECTED_APP_SHA256', 'OVERLYX_EXPECTED_RUNTIME_SHA256',
] as const;
const made: string[] = [];

test.describe.configure({ mode: 'serial', retries: 0 });

function requirePortableEnvironment(): void {
  const missing = REQUIRED_ENV.filter(key => !process.env[key]);
  if (missing.length) throw new Error(`Set isolated candidate environment variables: ${missing.join(', ')}`);
  if (BASE_URL !== process.env.OVERLYX_E2E_BASE || PROJECTS_DIR !== process.env.OVERLYX_PROJECTS_DIR) {
    throw new Error('Runtime pan-cancel probe requires explicit, matching isolated URL and projects directory.');
  }
}

test.afterAll(() => {
  for (const project of made) rmSync(path.join(PROJECTS_DIR, ...project.split('/')), { recursive: true, force: true });
});

type Point = { x: number; y: number };
type FrameState = { left: number; top: number; width: number; height: number; transform: string; willChange: string };
type PointerRecord = {
  type: string; trusted: boolean; timeMs: number; pointerId: number | null; pointerType: string | null;
  x: number | null; y: number | null; targetTag: string | null; targetClass: string;
  targetIsSlide: boolean; pathHasSlide: boolean;
};

async function createDeck(browser: Browser): Promise<{ context: BrowserContext; page: Page; project: string; file: string; errors: { page: number; console: number } }> {
  const name = RUN;
  const project = `${USER}/${name}`;
  const context = await newTouchContext(browser, { baseURL: BASE_URL, viewport: { width: 1024, height: 768 } });
  const page = await context.newPage();
  const errors = { page: 0, console: 0 };
  page.on('pageerror', () => { errors.page++; });
  page.on('console', message => { if (message.type() === 'error') errors.console++; });
  page.setDefaultTimeout(12_000);
  await login(page, userCredentials(USER), { ui: 'default' });
  await page.locator('[data-new-project]').click();
  await page.locator('[data-new-kind="deck"]').click();
  await page.locator('[data-new-name]').fill(name);
  await page.locator('[data-new-create]').click();
  made.push(project);
  const file = path.join(PROJECTS_DIR, USER, name, 'slides', 'index.html');
  await expect(page).toHaveURL(url => url.hash === `#/${project}/slides/index.html`);
  await expect(page.locator('.dl-frame')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30_000 });
  return { context, page, project, file, errors };
}

async function servedCodeHashes(page: Page): Promise<{ appSha256: string; runtimeSha256: string }> {
  const resources = (await Promise.all(page.frames().map(frame => frame.evaluate(() =>
    performance.getEntriesByType('resource').map(entry => new URL(entry.name).pathname)
      .filter(p => /^\/assets\/index-[^/]+\.js$/.test(p) || p === '/_ol/runtime.js')
      .map(p => ({ p, url: new URL(p, location.href).href })),
  ).catch(() => [] as { p: string; url: string }[])))).flat();
  const hash = async (kind: 'app' | 'runtime', matches: (p: string) => boolean) => {
    const asset = resources.find(resource => matches(resource.p));
    if (!asset) throw new Error(`Could not identify the served ${kind} code asset.`);
    const response = await page.request.get(asset.url);
    if (!response.ok()) throw new Error(`Could not read served ${kind} code (HTTP ${response.status()}).`);
    return createHash('sha256').update(await response.body()).digest('hex');
  };
  const hashes = {
    appSha256: await hash('app', p => /^\/assets\/index-[^/]+\.js$/.test(p)),
    runtimeSha256: await hash('runtime', p => p === '/_ol/runtime.js'),
  };
  expect(hashes.appSha256, 'served app code matches the immutable candidate selected by the job').toBe(process.env.OVERLYX_EXPECTED_APP_SHA256);
  expect(hashes.runtimeSha256, 'served deliverable runtime matches the immutable candidate selected by the job').toBe(process.env.OVERLYX_EXPECTED_RUNTIME_SHA256);
  return hashes;
}

async function readFrame(page: Page): Promise<FrameState> {
  return page.evaluate(() => {
    const frame = document.querySelector('.dl-frame') as HTMLIFrameElement;
    const r = frame.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height,
      transform: frame.style.transform, willChange: frame.style.willChange };
  });
}

async function readCanvasWidth(page: Page): Promise<number> {
  return page.locator('.dl-canvas').evaluate(node => node.getBoundingClientRect().width);
}

async function readPageIndex(page: Page): Promise<string> {
  return (await page.locator('[data-dl-rail-show]').innerText()).replace(/\s+/g, ' ').trim();
}

async function installIframePointerLog(slide: Locator, key: string): Promise<void> {
  await slide.evaluate((node: Element, property: string) => {
    const doc = node.ownerDocument;
    const slideEl = node;
    (doc.defaultView as any)[property] = [];
    const record = (event: Event) => {
      const e = event as PointerEvent;
      const path = event.composedPath();
      const target = path.find(item => item instanceof Element) as Element | undefined;
      (doc.defaultView as any)[property].push({
        type: event.type,
        trusted: event.isTrusted,
        timeMs: performance.now(),
        pointerId: Number.isFinite(e.pointerId) ? e.pointerId : null,
        pointerType: e.pointerType ?? null,
        x: Number.isFinite(e.clientX) ? e.clientX : null,
        y: Number.isFinite(e.clientY) ? e.clientY : null,
        targetTag: target?.tagName ?? null,
        targetClass: target && typeof target.className === 'string' ? target.className.slice(0, 60) : '',
        targetIsSlide: target === slideEl,
        pathHasSlide: path.includes(slideEl),
      });
    };
    const win = doc.defaultView!;
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
      // The runtime stops propagation from its own window-capture handler. Log on that same target,
      // before the event could be stopped from reaching document capture.
      win.addEventListener(type, record, true);
    }
  }, key);
}

async function iframeEvents(slide: Locator, key: string): Promise<PointerRecord[]> {
  return slide.evaluate((node: Element, property: string) =>
    (node.ownerDocument.defaultView as any)[property] as PointerRecord[], key);
}

async function blankSlidePoint(slide: Locator, page: Page): Promise<{ point: Point; hitTag: string; hitIsSlide: boolean; inner: { width: number; height: number } }> {
  const outer = await page.locator('.dl-frame').evaluate(frame => {
    const r = frame.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  });
  return slide.evaluate((node: Element, outerRect: { left: number; top: number; width: number; height: number }) => {
    const win = node.ownerDocument.defaultView!;
    const r = node.getBoundingClientRect();
    const candidates: Point[] = [];
    // Stay clear of starter text and decorations; require the child's real hit target to be the slide.
    for (const [fx, fy] of [[0.78, 0.88], [0.82, 0.9], [0.72, 0.9], [0.8, 0.82], [0.9, 0.82]]) {
      const x = r.left + r.width * fx, y = r.top + r.height * fy;
      if (node.ownerDocument.elementFromPoint(x, y) === node) candidates.push({
        x: outerRect.left + x / win.innerWidth * outerRect.width,
        y: outerRect.top + y / win.innerHeight * outerRect.height,
      });
    }
    const chosen = candidates[0];
    if (!chosen) return { point: { x: NaN, y: NaN }, hitTag: '', hitIsSlide: false, inner: { width: win.innerWidth, height: win.innerHeight } };
    return { point: chosen, hitTag: node.tagName, hitIsSlide: true, inner: { width: win.innerWidth, height: win.innerHeight } };
  }, outer);
}

async function clearIframePointerLog(slide: Locator, key: string): Promise<void> {
  await slide.evaluate((node: Element, property: string) => { (node.ownerDocument.defaultView as any)[property] = []; }, key);
}

async function settledFrame(page: Page): Promise<FrameState | null> {
  const state = await readFrame(page);
  if (state.willChange !== '') return null;
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const again = await readFrame(page);
  if (again.willChange !== '' || state.left !== again.left || state.top !== again.top || state.transform !== again.transform) return null;
  return again;
}

async function saveEvidence(info: { outputPath(name: string): string; attach(name: string, options: { path: string; contentType: string }): Promise<unknown> }, name: string, evidence: unknown): Promise<void> {
  const file = info.outputPath(name);
  writeFileSync(file, JSON.stringify(evidence, null, 2));
  await info.attach(name, { path: file, contentType: 'application/json' });
}

test('trusted short runtime-iframe pan cancellation does not page-turn; normal lift and editing still work', async ({ browser, browserName }, info) => {
  requirePortableEnvironment();
  test.skip(browserName !== 'chromium', 'Uses trusted Chromium CDP touch emulation; not physical-device coverage.');
  test.setTimeout(120_000);
  const { context, page, project, file, errors } = await createDeck(browser);
  const frame = page.frameLocator('.dl-frame');
  const slides = frame.locator('section.slide');
  const firstSlide = slides.first();
  const coverTitle = firstSlide.locator('h1');
  const secondTitle = slides.nth(1).locator('h2').first();
  const marker = `Runtime pan recovery ${RUN}`;
  const key = '__runtimePanCancelPointerEvents';
  let evidence: Record<string, unknown> = { project, input: 'trusted Chromium CDP touch emulation (not hardware)', result: 'incomplete' };
  try {
    const hashes = await servedCodeHashes(page);
    if (await page.locator('.sidebar.left').isVisible().catch(() => false)) await page.locator('.sidebar.left button.hide').click();
    if (await page.locator('.dl-rail').isVisible().catch(() => false)) await page.locator('[data-dl-rail-hide]').click();
    await page.locator('[data-dl-zoom]').selectOption('50');
    await expect(page.locator('[data-dl-zoom]')).toHaveValue('50');
    await expect.poll(() => settledFrame(page), { timeout: 10_000 }).not.toBeNull();
    await expect(coverTitle).toBeVisible();
    await expect(secondTitle).toHaveCount(1);
    await expect(page.locator('[data-dl-rail-show]')).toContainText('Slides · 1 of 2');
    const before = await readFrame(page);
    const canvasWidth = await readCanvasWidth(page);
    const shownBefore = await slides.evaluateAll(items => items.map(item => (item as HTMLElement).offsetHeight > 0 ? 1 : 0).join(''));
    const point = await blankSlidePoint(firstSlide, page);
    const viewport = page.viewportSize()!;
    const calibratedRuntimePan = point.hitIsSlide && Number.isFinite(point.point.x) && Number.isFinite(point.point.y)
      && point.point.x >= 0 && point.point.x < viewport.width && point.point.y >= 0 && point.point.y < viewport.height;
    if (!calibratedRuntimePan) {
      evidence = { project, hashes, browserVersion: browser.version(), viewport,
        input: 'trusted Chromium CDP touch emulation (not physical-device coverage)',
        classification: 'runtime-iframe blank-background calibration unavailable', point };
      await saveEvidence(info, 'runtime-pan-cancel-safe.json', evidence);
      expect(calibratedRuntimePan, 'must calibrate a visible, direct-hit blank section.slide point inside the runtime iframe').toBe(true);
    }
    await installIframePointerLog(firstSlide, key);

    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    const touch = (p: Point, id: number) => ({ x: p.x, y: p.y, id });
    const dispatch = (type: 'touchStart' | 'touchMove' | 'touchCancel' | 'touchEnd', pts: ReturnType<typeof touch>[]) =>
      cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts });
    const positions = [point.point, { x: point.point.x - 10, y: point.point.y }, { x: point.point.x - 30, y: point.point.y }, { x: point.point.x - 50, y: point.point.y }];
    await dispatch('touchStart', [touch(positions[0], 31)]);
    for (const p of positions.slice(1)) await dispatch('touchMove', [touch(p, 31)]);
    const live = await readFrame(page);
    const eventsBeforeCancel = await iframeEvents(firstSlide, key);
    await dispatch('touchCancel', []);
    await expect.poll(() => settledFrame(page), { timeout: 10_000 }).not.toBeNull();
    const afterCancel = await readFrame(page);
    const cancelEvents = await iframeEvents(firstSlide, key);
    const down = cancelEvents.find(event => event.type === 'pointerdown' && event.pointerType === 'touch');
    const pointerId = down?.pointerId;
    const moves = cancelEvents.filter(event => event.type === 'pointermove' && event.pointerType === 'touch' && event.pointerId === pointerId);
    const pointerCancel = cancelEvents.filter(event => event.type === 'pointercancel' && event.pointerId === pointerId && event.trusted);
    const pointerUp = cancelEvents.filter(event => event.type === 'pointerup' && event.pointerId === pointerId && event.trusted);
    const travelAfterDeadzone = Math.abs(positions[3].x - positions[1].x);
    const pointerDownToCancelMs = down && pointerCancel[0] ? pointerCancel[0].timeMs - down.timeMs : null;
    // SlideView starts its fast-swipe clock when the runtime first posts ol:pan, not at pointerdown.
    const panStartToCancelMs = moves[0] && pointerCancel[0] ? pointerCancel[0].timeMs - moves[0].timeMs : null;
    const shownAfterCancel = await slides.evaluateAll(items => items.map(item => (item as HTMLElement).offsetHeight > 0 ? 1 : 0).join(''));
    const readoutAfterCancel = await readPageIndex(page);
    evidence = {
      project, hashes, browserVersion: browser.version(), viewport: { width: 1024, height: 768 },
      input: 'trusted Chromium CDP touch emulation (not physical-device coverage)',
      origin: 'runtime iframe child document; event path includes section.slide and does not include parent canvas',
      zoom: '50%', point, positions, travelAfterDeadzonePx: travelAfterDeadzone,
      runtimeFastTurnThresholdPx: 30, parentPageTurnThresholdPx: '15% of parent canvas width', canvasWidth,
      swipeClockStart: 'first trusted runtime pointermove (runtime posts first ol:pan here)',
      eventsBeforeCancel, eventsAfterCancel: cancelEvents, frameBefore: before, frameDuring: live, frameAfterCancel: afterCancel,
      cancellation: { trustedPointerDown: !!down?.trusted, pointerDownType: down?.pointerType ?? null,
        targetWasSlide: !!down?.targetIsSlide, pathIncludedSlide: !!down?.pathHasSlide,
        trustedPointerMoveCount: moves.filter(event => event.trusted).length,
        trustedPointerCancelCount: pointerCancel.length, trustedPointerUpCount: pointerUp.length,
        pointerDownToCancelMs, panStartToCancelMs },
      pageState: { readoutAfterCancel, shownSlidesBefore: shownBefore, shownSlidesAfterCancel: shownAfterCancel }, errors,
      result: 'cancellation-captured',
    };
    await saveEvidence(info, 'runtime-pan-cancel-safe.json', evidence);

    expect(down?.trusted, 'browser delivered a trusted touch pointerdown inside the runtime').toBe(true);
    expect(down?.pointerType).toBe('touch');
    expect(down?.targetIsSlide, 'start hit blank section.slide, not slide text or an object').toBe(true);
    expect(down?.pathHasSlide).toBe(true);
    expect(moves.filter(event => event.trusted).length).toBeGreaterThanOrEqual(3);
    expect(pointerCancel, 'the runtime receives trusted pointercancel').toHaveLength(1);
    expect(pointerUp, 'cancellation is not delivered as a successful lift').toHaveLength(0);
    expect(panStartToCancelMs, 'cancel arrives less than 250ms after the first runtime pan message').not.toBeNull();
    expect(panStartToCancelMs!).toBeLessThan(250);
    expect(travelAfterDeadzone).toBeGreaterThan(30);
    expect(travelAfterDeadzone).toBeLessThan(0.15 * canvasWidth);
    expect(Math.abs(live.left - before.left), 'runtime-origin pan visibly moves the parent frame').toBeGreaterThan(1);
    expect(Math.abs(afterCancel.left - before.left), 'interrupted pan returns frame to baseline').toBeLessThanOrEqual(1);
    expect(readoutAfterCancel).toBe('Slides · 1 of 2');
    expect(shownAfterCancel).toBe(shownBefore);
    expect(errors).toEqual({ page: 0, console: 0 });

    // Control: the same child-frame path with a normal lift must navigate, proving the cancel
    // assertion isn't passing because iframe gestures never reach the parent view controller.
    const normalPositions = positions;
    await clearIframePointerLog(firstSlide, key);
    await dispatch('touchStart', [touch(normalPositions[0], 32)]);
    for (const p of normalPositions.slice(1)) await dispatch('touchMove', [touch(p, 32)]);
    await dispatch('touchEnd', []);
    await expect(page.locator('[data-dl-rail-show]')).toContainText('Slides · 2 of 2', { timeout: 10_000 });
    await expect.poll(() => settledFrame(page), { timeout: 10_000 }).not.toBeNull();
    const normalEvents = await iframeEvents(firstSlide, key);
    const normalDown = normalEvents.find(event => event.type === 'pointerdown' && event.pointerType === 'touch');
    const normalUp = normalEvents.filter(event => event.type === 'pointerup' && event.pointerId === normalDown?.pointerId && event.trusted);
    const shownAfterLift = await slides.evaluateAll(items => items.map(item => (item as HTMLElement).offsetHeight > 0 ? 1 : 0).join(''));
    expect(normalDown?.trusted).toBe(true);
    expect(normalDown?.targetIsSlide).toBe(true);
    expect(normalUp).toHaveLength(1);
    expect(shownAfterLift).toBe('01');

    // Edit slide two through its normal GUI text flow, then prove the saved project survives reload.
    await expect(secondTitle).toBeVisible();
    await secondTitle.dblclick();
    await page.keyboard.press('Control+a');
    await page.keyboard.type(marker, { delay: 15 });
    await page.keyboard.press('Escape');
    await expect(secondTitle).toHaveText(marker);
    await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30_000 });
    const sourceBeforeReload = readFileSync(file, 'utf8');
    const sourceHashBeforeReload = createHash('sha256').update(sourceBeforeReload).digest('hex');
    expect(sourceBeforeReload).toContain(marker);
    await page.reload();
    await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30_000 });
    const reloadedSecondTitle = page.frameLocator('.dl-frame').locator('section.slide').nth(1).locator('h2').first();
    await expect(reloadedSecondTitle).toHaveText(marker, { timeout: 30_000 });
    const sourceAfterReload = readFileSync(file, 'utf8');
    const sourceHashAfterReload = createHash('sha256').update(sourceAfterReload).digest('hex');
    expect(sourceAfterReload).toContain(marker);
    evidence = {
      ...evidence, result: 'completed',
      normalLift: { trustedPointerDown: !!normalDown?.trusted, targetWasSlide: !!normalDown?.targetIsSlide,
        trustedPointerUpCount: normalUp.length, readout: 'Slides · 2 of 2', shownSlides: shownAfterLift },
      guiEditPersistence: { marker, savedBeforeReload: sourceBeforeReload.includes(marker), sourceHashBeforeReload,
        visibleAfterReload: true, savedAfterReload: sourceAfterReload.includes(marker), sourceHashAfterReload,
        sourceUnchangedAcrossReload: sourceHashAfterReload === sourceHashBeforeReload },
      errors,
    };
    await saveEvidence(info, 'runtime-pan-cancel-safe.json', evidence);
    expect(sourceHashAfterReload, 'reload preserves the exact saved slide source').toBe(sourceHashBeforeReload);
    expect(errors).toEqual({ page: 0, console: 0 });
  } finally {
    if (evidence.result === 'incomplete') await saveEvidence(info, 'runtime-pan-cancel-safe.json', { ...evidence, errors });
    await context.close();
  }
});
