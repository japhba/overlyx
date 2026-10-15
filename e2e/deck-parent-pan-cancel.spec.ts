/** Focused GUI regression: a trusted interrupted parent-canvas pan must not page-turn. */
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { login, newTouchContext, PROJECTS_DIR, userCredentials, BASE_URL } from './helpers';

const RUN = `parent-pan-cancel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
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
    throw new Error('Parent pan-cancel probe requires explicit, matching isolated URL and projects directory.');
  }
}

test.afterAll(() => {
  for (const project of made) rmSync(path.join(PROJECTS_DIR, ...project.split('/')), { recursive: true, force: true });
});

type Errors = { page: number; console: number };

async function createDeck(browser: Browser, suffix: string): Promise<{ context: BrowserContext; page: Page; project: string; file: string; errors: Errors }> {
  const name = `${RUN}-${suffix}`;
  const project = `${USER}/${name}`;
  const context = await newTouchContext(browser, { baseURL: BASE_URL, viewport: { width: 1024, height: 768 } });
  const page = await context.newPage();
  const errors: Errors = { page: 0, console: 0 };
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

async function prepareTouchSurface(page: Page): Promise<{ zoom: string; solo: boolean; canvas: Box; frame: Box; panPoints: Point[] }> {
  // Use the normal visible controls, so coordinates are calibrated after the real drawer widths settle.
  if (await page.locator('.sidebar.left').isVisible().catch(() => false)) await page.locator('.sidebar.left button.hide').click();
  if (await page.locator('.dl-rail').isVisible().catch(() => false)) await page.locator('[data-dl-rail-hide]').click();
  await expect(page.locator('.sidebar.left')).toHaveCount(0);
  await expect(page.locator('.dl-rail')).toHaveCount(0);
  await page.locator('[data-dl-zoom]').selectOption('50');
  await expect(page.locator('[data-dl-zoom]')).toHaveValue('50');

  const geometry = await page.evaluate(() => {
    const canvas = document.querySelector('.dl-canvas')!;
    const frame = document.querySelector('.dl-frame') as HTMLIFrameElement;
    const c = canvas.getBoundingClientRect(), f = frame.getBoundingClientRect();
    const center = c.left + c.width / 2;
    const yMin = Math.max(c.top + 24, f.bottom + 12);
    const yMax = c.bottom - 24;
    const choices: number[] = [];
    let yChosen = NaN;
    for (let y = yMin; y <= yMax && Number.isNaN(yChosen); y += 2) {
      const xs: number[] = [];
      for (let x = Math.max(c.left + 100, center - 180); x <= Math.min(c.right - 100, center + 180); x += 2) {
        if (document.elementFromPoint(x, y) === canvas) xs.push(x);
      }
      if (xs.length >= 3) { yChosen = y; choices.push(...xs); }
    }
    const nearest = (target: number) => choices.length ? choices.reduce((best, x) => Math.abs(x - target) < Math.abs(best - target) ? x : best) : NaN;
    return {
      zoom: (document.querySelector('[data-dl-zoom]') as HTMLSelectElement).value,
      solo: frame.classList.contains('solo'),
      canvas: { left: c.left, right: c.right, top: c.top, bottom: c.bottom, width: c.width, height: c.height },
      frame: { left: f.left, right: f.right, top: f.top, bottom: f.bottom, width: f.width, height: f.height },
      points: [nearest(center - 80), nearest(center), nearest(center + 80)].map(x => ({ x, y: yChosen, directCanvasHit: Number.isFinite(x) && document.elementFromPoint(x, yChosen) === canvas })),
    };
  });
  return { zoom: geometry.zoom, solo: geometry.solo, canvas: geometry.canvas, frame: geometry.frame, panPoints: geometry.points };
}

type Point = { x: number; y: number; directCanvasHit: boolean };
type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number };

async function capturePointerEvents(page: Page, key: string): Promise<void> {
  await page.evaluate(property => {
    (window as any)[property] = [];
    const canvas = document.querySelector('.dl-canvas');
    const record = (event: Event) => {
      const e = event as PointerEvent;
      const path = event.composedPath();
      const target = path.find(item => item instanceof Element) as Element | undefined;
      (window as any)[property].push({
        type: event.type,
        trusted: event.isTrusted,
        timeMs: performance.now(),
        pointerId: Number.isFinite(e.pointerId) ? e.pointerId : null,
        pointerType: e.pointerType ?? null,
        x: Number.isFinite(e.clientX) ? e.clientX : null,
        y: Number.isFinite(e.clientY) ? e.clientY : null,
        target: target ? { tag: target.tagName, className: typeof target.className === 'string' ? target.className.slice(0, 60) : '' } : null,
        parentCanvasInPath: path.includes(canvas!),
        defaultPrevented: event.defaultPrevented,
      });
    };
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture', 'touchstart', 'touchmove', 'touchend', 'touchcancel']) {
      document.addEventListener(type, record, true);
    }
  }, key);
}

async function readFrame(page: Page): Promise<{ rect: Box; inline: { transform: string; left: string; top: string; width: string; height: string }; willChange: string }> {
  return page.evaluate(() => {
    const frame = document.querySelector('.dl-frame') as HTMLIFrameElement;
    const r = frame.getBoundingClientRect();
    return {
      rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height },
      inline: { transform: frame.style.transform, left: frame.style.left, top: frame.style.top, width: frame.style.width, height: frame.style.height },
      willChange: frame.style.willChange,
    };
  });
}

async function sampleFrameAcrossAnimationFrames(page: Page): Promise<{ first: Awaited<ReturnType<typeof readFrame>>; second: Awaited<ReturnType<typeof readFrame>> }> {
  return page.evaluate(() => new Promise(resolve => {
    const sample = () => {
      const frame = document.querySelector('.dl-frame') as HTMLIFrameElement;
      const r = frame.getBoundingClientRect();
      return {
        rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height },
        inline: { transform: frame.style.transform, left: frame.style.left, top: frame.style.top, width: frame.style.width, height: frame.style.height },
        willChange: frame.style.willChange,
      };
    };
    requestAnimationFrame(() => {
      const first = sample();
      requestAnimationFrame(() => resolve({ first, second: sample() }));
    });
  }));
}

async function waitTwoFrames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function recorded(page: Page, key: string): Promise<any[]> {
  return page.evaluate(property => (window as any)[property] as any[], key);
}

async function saveSafe(info: any, name: string, evidence: unknown): Promise<void> {
  const file = info.outputPath(name);
  const json = JSON.stringify(evidence, null, 2);
  writeFileSync(file, json);
  await info.attach(name, { path: file, contentType: 'application/json' });
}

test('trusted fast parent-canvas pan cancelled before lift does not turn to the next slide', async ({ browser, browserName }, info) => {
  requirePortableEnvironment();
  test.skip(browserName !== 'chromium', 'Uses trusted Chromium CDP touch emulation; not physical-device coverage.');
  test.setTimeout(120_000);
  const { context, page, project, file, errors } = await createDeck(browser, 'one-finger');
  const title = page.frameLocator('.dl-frame').locator('section.slide').first().locator('h1');
  let evidence: Record<string, unknown> = { project, input: 'trusted Chromium CDP touch emulation (not hardware)', result: 'incomplete' };
  try {
    const hashes = await servedCodeHashes(page);
    const surface = await prepareTouchSurface(page);
    await expect(title).toBeVisible();
    const startingTitle = (await title.textContent())?.trim() ?? '';
    expect(startingTitle).not.toBe('');
    const slidesInFrame = page.frameLocator('.dl-frame').locator('section.slide');
    const shownBefore = await slidesInFrame.evaluateAll(items => items.map(item => (item as HTMLElement).offsetHeight > 0 ? 1 : 0).join(''));
    const before = await readFrame(page);
    const points = surface.panPoints;
    const calibratedParentPan = surface.solo && !!points[1]?.directCanvasHit && !!points[1].y
      && points[1].y > surface.frame.bottom && !!before.rect;
    if (!calibratedParentPan) {
      evidence = { project, hashes, input: 'trusted Chromium CDP touch emulation (not hardware)', classification: 'calibration-unavailable', surface, before };
      await saveSafe(info, 'parent-pan-cancel-safe.json', evidence);
      expect(calibratedParentPan, 'must calibrate a clear, direct-hit parent-canvas margin at 50% after recording its geometry').toBe(true);
    }
    const canvasWidth = surface.canvas.width;
    const start = points[1], xPositions = [start.x, start.x - 10, start.x - 30, start.x - 50];
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    const touch = (x: number, id = 1) => ({ x, y: start.y, id });
    const dispatch = (type: 'touchStart' | 'touchMove' | 'touchCancel' | 'touchEnd', touchPoints: ReturnType<typeof touch>[]) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
    const key = '__parentPanCancelEvents';
    await capturePointerEvents(page, key);
    await dispatch('touchStart', [touch(xPositions[0])]);
    for (const x of xPositions.slice(1)) await dispatch('touchMove', [touch(x)]);
    const live = await readFrame(page);
    const beforeCancelEvents = await recorded(page, key);
    await dispatch('touchCancel', []);
    await waitTwoFrames(page);
    await expect.poll(async () => (await readFrame(page)).willChange).toBe('');
    const after = await readFrame(page);
    const events = await recorded(page, key);
    const shownAfterCancel = await slidesInFrame.evaluateAll(items => items.map(item => (item as HTMLElement).offsetHeight > 0 ? 1 : 0).join(''));
    const titleAfterCancel = { visible: await title.isVisible(), text: (await title.textContent())?.trim() ?? '' };
    const pointerDown = events.find(event => event.type === 'pointerdown' && event.pointerType === 'touch');
    const pointerMoves = events.filter(event => event.type === 'pointermove' && event.pointerType === 'touch' && event.pointerId === pointerDown?.pointerId);
    const trustedPointerCancel = events.filter(event => event.type === 'pointercancel' && event.pointerId === pointerDown?.pointerId && event.trusted);
    const trustedTouchCancel = events.filter(event => event.type === 'touchcancel' && event.trusted);
    const travelAfterDeadzone = Math.abs(xPositions[2] - xPositions[1]) + Math.abs(xPositions[3] - xPositions[2]);
    const firstMoveTime = pointerMoves[0]?.timeMs ?? null;
    const cancelTime = trustedPointerCancel[0]?.timeMs ?? null;
    const gestureMs = firstMoveTime !== null && cancelTime !== null ? cancelTime - firstMoveTime : null;
    evidence = {
      project, hashes, browserVersion: browser.version(), viewport: { width: 1024, height: 768 },
      input: 'trusted Chromium CDP touch emulation (not hardware)', zoom: surface.zoom, solo: surface.solo,
      sourceThresholds: { touchDeadzonePx: 10, fastPageTurnTravelPx: 30, pageTurnWidthFraction: 0.15 },
      surface: { canvas: surface.canvas, frame: surface.frame, start, startDirectCanvasHit: start.directCanvasHit },
      coordinates: xPositions.map(x => ({ x, y: start.y })),
      travelAfterDeadzonePx: travelAfterDeadzone, pageTurnThresholdPx: 0.15 * canvasWidth,
      eventsBeforeCancel: beforeCancelEvents, live, afterCancel: after, events,
      cancelDelivery: { trustedPointerCancelCount: trustedPointerCancel.length, trustedTouchCancelCount: trustedTouchCancel.length,
        trustedPointerUpCount: events.filter(event => event.type === 'pointerup' && event.pointerId === pointerDown?.pointerId && event.trusted).length,
        gestureMs, trustedPointerDown: !!pointerDown?.trusted, pointerDownCanvasPath: !!pointerDown?.parentCanvasInPath },
      visual: { shownSlidesBefore: shownBefore, shownSlidesAfterCancel: shownAfterCancel, startingTitle: titleAfterCancel,
        frameMovedDuringPan: Math.abs(live.rect.left - before.rect.left) > 1,
        frameReturnedNearBaseline: Math.abs(after.rect.left - before.rect.left) <= 1, frameAtBaseline: before },
      errors,
    };
    await saveSafe(info, 'parent-pan-cancel-safe.json', evidence);

    expect(pointerDown?.trusted, 'the pan begins with trusted touch input').toBe(true);
    expect(pointerDown?.pointerType).toBe('touch');
    expect(pointerDown?.parentCanvasInPath, 'the owned touch reaches the parent canvas').toBe(true);
    expect(pointerMoves.length).toBeGreaterThanOrEqual(3);
    expect(start.directCanvasHit).toBe(true);
    expect(travelAfterDeadzone, 'the post-deadzone finger motion exceeds the fast-fling edge').toBeGreaterThan(30);
    expect(travelAfterDeadzone, 'the travel remains below the 15% page-turn threshold').toBeLessThan(0.15 * canvasWidth);
    expect(gestureMs, 'the move-to-cancel sequence is a fast gesture under 250ms').not.toBeNull();
    expect(gestureMs!).toBeLessThan(250);
    expect(Math.abs(live.rect.left - before.rect.left), 'visible frame CSS position changes during pan').toBeGreaterThan(1);
    expect(trustedPointerCancel.length, 'the browser delivered a trusted pointercancel').toBe(1);
    expect(trustedTouchCancel.length, 'the browser delivered a trusted DOM touchcancel').toBeGreaterThan(0);
    expect(evidence.cancelDelivery && (evidence.cancelDelivery as any).trustedPointerUpCount, 'cancel is not mistaken for a normal lift').toBe(0);
    expect(Math.abs(after.rect.left - before.rect.left), 'cancel returns the slide to the original cover position').toBeLessThanOrEqual(1);

    // Reopen the rail only after the gesture, to read the app's actual page index and prove navigation still works.
    await page.locator('[data-dl-rail-show]').click();
    const pageReadout = page.locator('.dl-rail-count');
    await expect(pageReadout).toBeVisible();
    const pageReadoutAfterCancel = (await pageReadout.textContent())?.trim() ?? '';
    const thumbnails = page.frameLocator('.dl-railframe').locator('section.slide');
    await thumbnails.first().click();
    await expect(pageReadout).toHaveText('Slide 1 of 2');
    await thumbnails.nth(1).click();
    await expect(pageReadout).toHaveText('Slide 2 of 2');
    await thumbnails.first().click();
    await expect(pageReadout).toHaveText('Slide 1 of 2');
    await expect(title).toHaveText(startingTitle);
    evidence.pageReadoutAfterCancel = pageReadoutAfterCancel;
    evidence.followUpNavigation = 'normal rail navigation 1→2→1 passed';
    evidence.errors = errors;
    await saveSafe(info, 'parent-pan-cancel-safe.json', evidence);
    expect(shownBefore, 'the starting cover was the visible slide before the gesture').toBe('10');
    expect(shownAfterCancel, 'cancel leaves the original cover slide visible').toBe(shownBefore);
    expect(titleAfterCancel.visible && titleAfterCancel.text === startingTitle, 'the original cover title stays visible after cancellation').toBe(true);
    expect(pageReadoutAfterCancel, 'the current slide index is unchanged by cancellation').toBe('Slide 1 of 2');
    expect(errors).toEqual({ page: 0, console: 0 });

    // Control case: replay the same trusted 50 px finger path, but lift normally.
    // This proves the cancellation oracle is not simply a disabled swipe/page-turn gesture.
    const normalSurface = await prepareTouchSurface(page);
    const frameImmediatelyAfterPreparation = await readFrame(page);
    const stableWaitStartedAt = Date.now();
    await expect.poll(async () => (await readFrame(page)).willChange).toBe('');
    const stableWaitMs = Date.now() - stableWaitStartedAt;
    const preparedFrames = await sampleFrameAcrossAnimationFrames(page);
    const preparationStable = preparedFrames.first.willChange === '' && preparedFrames.second.willChange === '' &&
      JSON.stringify(preparedFrames.first) === JSON.stringify(preparedFrames.second);
    if (!preparationStable) {
      evidence.normalPreparation = {
        classification: 'calibration-unavailable',
        frameImmediatelyAfterPreparation, stableWaitMs,
        firstRaf: preparedFrames.first, secondRaf: preparedFrames.second,
        reason: 'The frame was still moving across consecutive animation frames before normal-lift input; no gesture result inferred.',
      };
      await saveSafe(info, 'parent-pan-cancel-safe.json', evidence);
      expect(preparationStable, 'must establish a stable frame across consecutive animation frames before the normal-lift control').toBe(true);
    }
    const normalStart = normalSurface.panPoints[1]!;
    expect(normalSurface.solo && normalStart.directCanvasHit && normalStart.y > normalSurface.frame.bottom,
      'normal-lift control uses a fresh, direct-hit parent-canvas margin').toBe(true);
    const normalXs = [normalStart.x, normalStart.x - 10, normalStart.x - 30, normalStart.x - 50];
    const normalTouch = (x: number, id = 4) => ({ x, y: normalStart.y, id });
    const normalKey = '__parentPanNormalEndEvents';
    await capturePointerEvents(page, normalKey);
    const normalBefore = preparedFrames.second;
    await dispatch('touchStart', [normalTouch(normalXs[0])]);
    for (const x of normalXs.slice(1)) await dispatch('touchMove', [normalTouch(x)]);
    const normalLive = await readFrame(page);
    await dispatch('touchEnd', []);
    await waitTwoFrames(page);
    await expect.poll(async () => (await readFrame(page)).willChange).toBe('');
    const normalEvents = await recorded(page, normalKey);
    const normalDown = normalEvents.find(event => event.type === 'pointerdown' && event.trusted && event.pointerType === 'touch');
    const normalPointerId = normalDown?.pointerId;
    const normalMoves = normalEvents.filter(event => event.type === 'pointermove' && event.pointerId === normalPointerId && event.pointerType === 'touch');
    const normalUps = normalEvents.filter(event => event.type === 'pointerup' && event.pointerId === normalPointerId && event.trusted);
    const normalTouchEnds = normalEvents.filter(event => event.type === 'touchend' && event.trusted);
    const normalSlideState = await slidesInFrame.evaluateAll(items => items.map(item => (item as HTMLElement).offsetHeight > 0 ? 1 : 0).join(''));
    const normalTitleAfterLift = { visible: await title.isVisible(), matchesStartingTitle: (await title.textContent())?.trim() === startingTitle };
    const normalPointerUpTime = normalUps[0]?.timeMs ?? null;
    const normalGestureMs = normalMoves.length && normalPointerUpTime !== null
      ? normalPointerUpTime - (normalMoves[0]?.timeMs ?? normalPointerUpTime) : null;

    await page.locator('[data-dl-rail-show]').click();
    await expect(pageReadout).toBeVisible();
    const readoutAfterNormalLift = (await pageReadout.textContent())?.trim() ?? '';
    evidence.normalLiftControl = {
      coordinates: normalXs.map(x => ({ x, y: normalStart.y })),
      travelPx: Math.abs(normalXs[3] - normalXs[1]),
      directCanvasHit: normalStart.directCanvasHit,
      preparationStableAcrossRafs: preparationStable,
      frameImmediatelyAfterPreparation, stableWaitMs,
      stableSamples: preparedFrames,
      normalBefore, normalLive, normalAfter: await readFrame(page),
      trustedPointerDown: !!normalDown?.trusted,
      pointerDownIdObserved: normalPointerId ?? null,
      trustedPointerMoveCountForObservedId: normalMoves.filter(event => event.trusted).length,
      trustedPointerUpCountForObservedId: normalUps.length,
      trustedTouchEndCount: normalTouchEnds.length,
      firstMoveToPointerUpMs: normalGestureMs,
      eventTimeline: normalEvents.filter(event => event.pointerId === normalPointerId || event.type === 'touchend')
        .map(({ type, trusted, timeMs, pointerId, pointerType, x, y, parentCanvasInPath }) => ({ type, trusted, timeMs, pointerId, pointerType, x, y, parentCanvasInPath })),
      visibleSlidesAfterLift: normalSlideState,
      titleAfterLift: normalTitleAfterLift,
      pageReadoutAfterLift: readoutAfterNormalLift,
      errors,
    };
    await saveSafe(info, 'parent-pan-cancel-safe.json', evidence);
    await expect(pageReadout).toHaveText('Slide 2 of 2');
    await thumbnails.first().click();
    await expect(pageReadout).toHaveText('Slide 1 of 2');
    await expect(title).toHaveText(startingTitle);

    const marker = `Saved after normal pan ${RUN}`;
    await title.dblclick();
    await page.keyboard.press('Control+a');
    await page.keyboard.type(marker, { delay: 20 });
    await page.keyboard.press('Escape');
    await expect(title).toHaveText(marker);
    await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30_000 });
    const sourceBeforeReload = readFileSync(file, 'utf8');
    const sourceHashBeforeReload = createHash('sha256').update(sourceBeforeReload).digest('hex');
    expect(sourceBeforeReload).toContain(marker);
    await page.reload();
    await expect(page.frameLocator('.dl-frame').locator('section.slide').first().locator('h1')).toHaveText(marker, { timeout: 30_000 });
    await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30_000 });
    const sourceAfterReload = readFileSync(file, 'utf8');
    const sourceHashAfterReload = createHash('sha256').update(sourceAfterReload).digest('hex');
    expect(sourceAfterReload).toContain(marker);
    evidence.followUpNavigation = 'normal rail navigation 1→2→1 passed after cancel; trusted normal lift advanced to slide 2';
    evidence.guiEditPersistence = {
      marker, savedBeforeReload: sourceBeforeReload.includes(marker), sourceHashBeforeReload,
      visibleAfterReload: true, savedAfterReload: sourceAfterReload.includes(marker), sourceHashAfterReload,
      sourceUnchangedAcrossReload: sourceHashAfterReload === sourceHashBeforeReload,
    };
    evidence.result = 'completed';
    evidence.errors = errors;
    await saveSafe(info, 'parent-pan-cancel-safe.json', evidence);
    expect(normalDown?.trusted, 'normal-lift control begins with trusted touch input').toBe(true);
    expect(normalDown?.parentCanvasInPath).toBe(true);
    expect(normalMoves.filter(event => event.trusted).length).toBeGreaterThanOrEqual(3);
    expect(normalUps, 'normal lift must deliver trusted pointerup').toHaveLength(1);
    expect(normalTouchEnds.length, 'normal lift must deliver trusted DOM touchend').toBeGreaterThan(0);
    expect(Math.abs(normalLive.rect.left - normalBefore.rect.left), 'normal-lift control pans before release').toBeGreaterThan(1);
    expect(normalSlideState, 'same path with normal lift advances from cover to second slide').toBe('01');
    expect(readoutAfterNormalLift).toBe('Slide 2 of 2');
    expect(sourceAfterReload, 'GUI title edit is present after reload').toContain(marker);
    expect(sourceHashAfterReload, 'reload does not change the saved source').toBe(sourceHashBeforeReload);
    expect(errors).toEqual({ page: 0, console: 0 });
  } finally {
    if (evidence.result === 'incomplete') await saveSafe(info, 'parent-pan-cancel-safe.json', { ...evidence, errors });
    await context.close();
  }
});

test('trusted three-finger pan cancellation does not undo a saved title edit', async ({ browser, browserName }, info) => {
  requirePortableEnvironment();
  test.skip(browserName !== 'chromium', 'Uses trusted Chromium CDP touch emulation; not physical-device coverage.');
  test.setTimeout(120_000);
  const { context, page, project, file, errors } = await createDeck(browser, 'three-finger');
  const title = page.frameLocator('.dl-frame').locator('section.slide').first().locator('h1');
  const marker = `Saved pan cancel marker ${RUN}`;
  let evidence: Record<string, unknown> = { project, input: 'trusted Chromium CDP touch emulation (not hardware)', result: 'incomplete' };
  try {
    const hashes = await servedCodeHashes(page);
    const surface = await prepareTouchSurface(page);
    await expect(title).toBeVisible();
    await title.dblclick();
    await page.keyboard.press('Control+a');
    await page.keyboard.type(marker, { delay: 20 });
    await page.keyboard.press('Escape');
    await expect(title).toHaveText(marker);
    await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30_000 });
    const sourceBefore = readFileSync(file, 'utf8');
    const sourceHashBefore = createHash('sha256').update(sourceBefore).digest('hex');
    expect(sourceBefore).toContain(marker);
    const points = surface.panPoints;
    const calibratedTriPan = surface.solo && points.length === 3 && points.every(point => point.directCanvasHit)
      && !!points[1]?.y && points[1].y > surface.frame.bottom;
    if (!calibratedTriPan) {
      evidence = { project, hashes, input: 'trusted Chromium CDP touch emulation (not hardware)', classification: 'calibration-unavailable', surface };
      await saveSafe(info, 'parent-tri-cancel-safe.json', evidence);
      expect(calibratedTriPan, 'must calibrate three direct-hit canvas margin points at 50% after recording their geometry').toBe(true);
    }
    const start = points.map(point => ({ x: point.x, y: point.y }));
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    const touch = (point: { x: number; y: number }, id: number) => ({ x: point.x, y: point.y, id });
    const ids = [11, 12, 13];
    const dispatch = (type: 'touchStart' | 'touchMove' | 'touchCancel', touchPoints: ReturnType<typeof touch>[]) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
    const key = '__parentTriCancelEvents';
    await capturePointerEvents(page, key);
    await dispatch('touchStart', [touch(start[0], ids[0])]);
    await dispatch('touchStart', [touch(start[0], ids[0]), touch(start[1], ids[1])]);
    await dispatch('touchStart', [touch(start[0], ids[0]), touch(start[1], ids[1]), touch(start[2], ids[2])]);
    const moved = start.map(point => ({ x: point.x - 60, y: point.y }));
    await dispatch('touchMove', moved.map((point, i) => touch(point, ids[i])));
    const liveEvents = await recorded(page, key);
    await dispatch('touchCancel', []);
    await waitTwoFrames(page);
    await expect.poll(async () => (await readFrame(page)).willChange).toBe('');
    await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30_000 });
    const afterEvents = await recorded(page, key);
    const pointerDowns = afterEvents.filter(event => event.type === 'pointerdown' && event.pointerType === 'touch' && event.trusted);
    const pointerCancels = afterEvents.filter(event => event.type === 'pointercancel' && event.trusted);
    const touchCancels = afterEvents.filter(event => event.type === 'touchcancel' && event.trusted);
    const hudText = await page.locator('[data-dl-zoomhud]').textContent().catch(() => '');
    const sourceAfter = readFileSync(file, 'utf8');
    const sourceHashAfter = createHash('sha256').update(sourceAfter).digest('hex');
    evidence = {
      project, hashes, browserVersion: browser.version(), viewport: { width: 1024, height: 768 },
      input: 'trusted Chromium CDP touch emulation (not hardware)', zoom: surface.zoom, solo: surface.solo,
      surface: { canvas: surface.canvas, frame: surface.frame, start }, moved,
      marker, markerSavedBefore: sourceBefore.includes(marker), sourceHashBefore, sourceHashAfter,
      eventsBeforeCancel: liveEvents, eventsAfterCancel: afterEvents,
      delivery: { trustedPointerDownCount: pointerDowns.length, distinctTrustedIds: [...new Set(pointerDowns.map(event => event.pointerId))].length,
        trustedPointerCancelCount: pointerCancels.length, trustedTouchCancelCount: touchCancels.length,
        trustedPointerUpCount: afterEvents.filter(event => event.type === 'pointerup' && event.trusted).length,
        allStartHitsWereParentCanvas: pointerDowns.length === 3 && pointerDowns.every(event => event.parentCanvasInPath) },
      noUndo: { hudText, markerVisible: await title.textContent().then(text => text?.trim() === marker), sourceContainsMarker: sourceAfter.includes(marker),
        exactSourceUnchanged: sourceHashAfter === sourceHashBefore },
      errors,
    };
    await saveSafe(info, 'parent-tri-cancel-safe.json', evidence);
    expect(pointerDowns).toHaveLength(3);
    expect(new Set(pointerDowns.map(event => event.pointerId)).size).toBe(3);
    expect(pointerDowns.every(event => event.parentCanvasInPath), 'all three trusted contacts are owned by the parent canvas').toBe(true);
    expect(pointerCancels).toHaveLength(3);
    expect(touchCancels.length).toBeGreaterThan(0);
    expect(afterEvents.filter(event => event.type === 'pointerup' && event.trusted)).toHaveLength(0);
    expect(String(hudText)).not.toMatch(/undo|redo/i);
    expect(await title.textContent().then(text => text?.trim())).toBe(marker);
    expect(sourceAfter).toContain(marker);
    expect(sourceHashAfter, 'a canceled three-finger gesture must not undo or otherwise change saved source').toBe(sourceHashBefore);
    expect(errors).toEqual({ page: 0, console: 0 });
  } finally {
    if (evidence.result === 'incomplete') await saveSafe(info, 'parent-tri-cancel-safe.json', { ...evidence, errors });
    await context.close();
  }
});
