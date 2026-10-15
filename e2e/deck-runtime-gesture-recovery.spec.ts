/** Trusted touch cancellation and recovery inside the deliverable runtime iframe. */
import { test, expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { login, newTouchContext, PROJECTS_DIR, userCredentials, BASE_URL } from './helpers';

const RUN = `runtime-gesture-recovery-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const USER = process.env.OVERLYX_BETA_DECK_USER ?? 'luna1';
const REQUIRED_ENV = [
  'OVERLYX_E2E_BASE', 'OVERLYX_PROJECTS_DIR', 'OVERLYX_E2E_CREDENTIALS',
  'OVERLYX_EXPECTED_APP_SHA256', 'OVERLYX_EXPECTED_RUNTIME_SHA256',
] as const;
const made: string[] = [];

function requirePortableEnvironment(): void {
  const missing = REQUIRED_ENV.filter(key => !process.env[key]);
  if (missing.length) throw new Error(`Runtime gesture recovery requires explicit isolated variables: ${missing.join(', ')}`);
  if (BASE_URL !== process.env.OVERLYX_E2E_BASE || PROJECTS_DIR !== process.env.OVERLYX_PROJECTS_DIR) {
    throw new Error('Runtime gesture recovery requires matching isolated base URL and projects directory.');
  }
}

test.afterAll(() => {
  for (const project of made) rmSync(path.join(PROJECTS_DIR, ...project.split('/')), { recursive: true, force: true });
});

type Point = { x: number; y: number };
type PointerRecord = {
  type: string; trusted: boolean; timeMs: number; pointerId: number | null; pointerType: string | null;
  x: number | null; y: number | null; targetTag: string | null; targetClass: string;
  targetIsSlide: boolean; pathHasSlide: boolean;
};
type FrameState = {
  zoom: string; solo: boolean; willChange: string; scale: number;
  inline: { transform: string; left: string; top: string; width: string; height: string };
};

async function createDeck(browser: Browser, suffix: string): Promise<{
  context: BrowserContext; page: Page; project: string; file: string; errors: { page: number; console: number };
}> {
  const name = `${RUN}-${suffix}`;
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
  const hash = async (kind: 'app' | 'runtime', matches: (pathname: string) => boolean) => {
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
  expect(hashes.appSha256, 'served app matches the immutable candidate selected by the beta runner').toBe(process.env.OVERLYX_EXPECTED_APP_SHA256);
  expect(hashes.runtimeSha256, 'served runtime matches the immutable candidate selected by the beta runner').toBe(process.env.OVERLYX_EXPECTED_RUNTIME_SHA256);
  return hashes;
}

async function frameNow(page: Page): Promise<FrameState> {
  return page.evaluate(() => {
    const frame = document.querySelector('.dl-frame') as HTMLIFrameElement;
    const matrix = new DOMMatrixReadOnly(getComputedStyle(frame).transform);
    return {
      zoom: (document.querySelector('[data-dl-zoom]') as HTMLSelectElement).value,
      solo: frame.classList.contains('solo'), willChange: frame.style.willChange, scale: Math.hypot(matrix.a, matrix.b),
      inline: { transform: frame.style.transform, left: frame.style.left, top: frame.style.top, width: frame.style.width, height: frame.style.height },
    };
  });
}

async function stableFrame(page: Page): Promise<FrameState | null> {
  return page.evaluate(() => new Promise<FrameState | null>(resolve => {
    const read = (): FrameState => {
      const frame = document.querySelector('.dl-frame') as HTMLIFrameElement;
      const matrix = new DOMMatrixReadOnly(getComputedStyle(frame).transform);
      return {
        zoom: (document.querySelector('[data-dl-zoom]') as HTMLSelectElement).value,
        solo: frame.classList.contains('solo'), willChange: frame.style.willChange, scale: Math.hypot(matrix.a, matrix.b),
        inline: { transform: frame.style.transform, left: frame.style.left, top: frame.style.top, width: frame.style.width, height: frame.style.height },
      };
    };
    requestAnimationFrame(() => {
      const first = read();
      requestAnimationFrame(() => {
        const second = read();
        resolve(first.willChange === '' && second.willChange === '' && JSON.stringify(first) === JSON.stringify(second) ? second : null);
      });
    });
  }));
}

/** Pick visible points whose true hit target is the slide itself, then map the opaque iframe to viewport CSS px. */
async function blankSlideTouches(page: Page, slide: Locator, fractions: number[]): Promise<{
  viewport: { width: number; height: number }; frame: { left: number; top: number; width: number; height: number };
  inner: { width: number; height: number }; childPoints: Point[]; screenPoints: Point[]; directSlideHits: boolean[];
}> {
  const outer = await page.locator('.dl-frame').evaluate(frame => {
    const r = frame.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  });
  const viewport = page.viewportSize()!;
  return slide.evaluate((node: Element, args: { outer: typeof outer; fractions: number[]; viewport: { width: number; height: number } }) => {
    const win = node.ownerDocument.defaultView!;
    const r = node.getBoundingClientRect();
    let childPoints: Point[] = [];
    for (const fy of [0.82, 0.88, 0.76, 0.7, 0.92]) {
      const row = args.fractions.map(fx => ({ x: r.left + r.width * fx, y: r.top + r.height * fy }));
      if (row.every(point => node.ownerDocument.elementFromPoint(point.x, point.y) === node)) { childPoints = row; break; }
    }
    const screenPoints = childPoints.map(point => ({
      x: args.outer.left + point.x / win.innerWidth * args.outer.width,
      y: args.outer.top + point.y / win.innerHeight * args.outer.height,
    }));
    return {
      viewport: args.viewport,
      frame: args.outer, inner: { width: win.innerWidth, height: win.innerHeight }, childPoints, screenPoints,
      directSlideHits: childPoints.map(point => node.ownerDocument.elementFromPoint(point.x, point.y) === node),
    };
  }, { outer, fractions, viewport });
}

async function installRuntimePointerLog(slide: Locator, key: string): Promise<void> {
  await slide.evaluate((node: Element, property: string) => {
    const win = node.ownerDocument.defaultView!;
    (win as any)[property] = [];
    const record = (event: Event) => {
      const pointer = event as PointerEvent;
      const path = event.composedPath();
      const target = path.find(item => item instanceof Element) as Element | undefined;
      (win as any)[property].push({
        type: event.type, trusted: event.isTrusted, timeMs: performance.now(),
        pointerId: Number.isFinite(pointer.pointerId) ? pointer.pointerId : null,
        pointerType: pointer.pointerType ?? null,
        x: Number.isFinite(pointer.clientX) ? pointer.clientX : null,
        y: Number.isFinite(pointer.clientY) ? pointer.clientY : null,
        targetTag: target?.tagName ?? null,
        targetClass: target && typeof target.className === 'string' ? target.className.slice(0, 60) : '',
        targetIsSlide: target === node, pathHasSlide: path.includes(node),
      });
    };
    // Runtime itself handles at window capture and stops propagation; same-window capture listeners still run.
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture', 'touchstart', 'touchmove', 'touchend', 'touchcancel']) {
      win.addEventListener(type, record, true);
    }
  }, key);
}

async function clearRuntimePointerLog(slide: Locator, key: string): Promise<void> {
  await slide.evaluate((node: Element, property: string) => { (node.ownerDocument.defaultView as any)[property] = []; }, key);
}

async function runtimeEvents(slide: Locator, key: string): Promise<PointerRecord[]> {
  return slide.evaluate((node: Element, property: string) => (node.ownerDocument.defaultView as any)[property] as PointerRecord[], key);
}

async function paintFrames(page: Page, count: number): Promise<void> {
  await page.evaluate(n => new Promise<void>(resolve => {
    const next = () => { if (--n <= 0) resolve(); else requestAnimationFrame(next); };
    requestAnimationFrame(next);
  }), count);
}

async function watchHistoryHud(page: Page, key: string): Promise<void> {
  await page.evaluate(property => {
    const state = { seen: false, observer: null as MutationObserver | null };
    const containsHud = (node: Node): boolean => {
      if (!(node instanceof Element)) return !!node.parentElement?.closest('[data-dl-hud]');
      return node.matches('[data-dl-hud]') || !!node.querySelector('[data-dl-hud]') || !!node.closest('[data-dl-hud]');
    };
    state.observer = new MutationObserver(records => {
      if (records.some(record => containsHud(record.target) || [...record.addedNodes].some(containsHud))) state.seen = true;
    });
    state.observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    (window as any)[property] = state;
  }, key);
}

async function saveEvidence(info: { outputPath(name: string): string; attach(name: string, options: { path: string; contentType: string }): Promise<unknown> }, name: string, data: unknown): Promise<void> {
  const file = info.outputPath(name);
  writeFileSync(file, JSON.stringify(data, null, 2));
  await info.attach(name, { path: file, contentType: 'application/json' });
}

function childCdp(context: BrowserContext, page: Page) {
  return context.newCDPSession(page).then(async cdp => {
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    const touch = (point: Point, id: number) => ({ x: point.x, y: point.y, id });
    const dispatch = (type: 'touchStart' | 'touchMove' | 'touchCancel' | 'touchEnd', points: ReturnType<typeof touch>[]) =>
      cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
    return { cdp, touch, dispatch };
  });
}

test('runtime iframe pinch cancel restores exact baseline; ordinary lift commits and saved editing survives reload', async ({ browser, browserName }, info) => {
  requirePortableEnvironment();
  test.skip(browserName !== 'chromium', 'Uses trusted Chromium CDP touch emulation; not physical iPad/Pencil coverage.');
  test.setTimeout(120_000);
  const { context, page, project, file, errors } = await createDeck(browser, 'two-finger');
  const slides = page.frameLocator('.dl-frame').locator('section.slide');
  const slide = slides.first();
  let evidence: Record<string, unknown> = { project, input: 'trusted Chromium CDP touch emulation (not hardware)', result: 'incomplete' };
  try {
    const hashes = await servedCodeHashes(page);
    if (await page.locator('.sidebar.left').isVisible().catch(() => false)) await page.locator('.sidebar.left button.hide').click();
    if (await page.locator('.dl-rail').isVisible().catch(() => false)) await page.locator('[data-dl-rail-hide]').click();
    await page.locator('[data-dl-zoom]').selectOption('50');
    await expect(page.locator('[data-dl-zoom]')).toHaveValue('50');
    await expect.poll(() => stableFrame(page), { timeout: 10_000 }).not.toBeNull();
    const title = slide.locator('h1').first();
    await expect(title).toBeVisible();
    const before = await stableFrame(page);
    expect(before).not.toBeNull();
    expect(before!.zoom).toBe('50');
    expect(before!.solo).toBe(true);
    const points = await blankSlideTouches(page, slide, [0.2, 0.8]);
    await saveEvidence(info, 'runtime-pinch-calibration-readback.json', {
      project, hashes, browserVersion: browser.version(), viewport: page.viewportSize(),
      input: 'trusted Chromium CDP touch emulation (not physical iPad/Pencil coverage)',
      stage: 'pre-activation-calibration', before, points,
    });
    expect(points.childPoints, 'both touch points are calibrated inside the iframe').toHaveLength(2);
    expect(points.directSlideHits, 'both points hit blank section.slide directly').toEqual([true, true]);
    const viewport = page.viewportSize()!;
    expect(points.screenPoints.every(p => p.x >= 0 && p.x < viewport.width && p.y >= 0 && p.y < viewport.height)).toBe(true);

    const key = '__runtimeIframePinchEvents';
    await installRuntimePointerLog(slide, key);
    const { dispatch, touch } = await childCdp(context, page);
    const ids = [41, 42];
    const [left, right] = points.screenPoints;
    await dispatch('touchStart', [touch(left, ids[0]), touch(right, ids[1])]);
    for (let step = 1; step <= 10; step++) {
      await dispatch('touchMove', [
        touch({ x: left.x - 12 * step, y: left.y }, ids[0]),
        touch({ x: right.x + 12 * step, y: right.y }, ids[1]),
      ]);
    }
    await expect.poll(async () => (await stableFrame(page))?.scale ?? 0, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(before!.scale * 1.1);
    const live = await stableFrame(page);
    const activationEvents = await runtimeEvents(slide, key);
    const downEvents = activationEvents.filter(event => event.type === 'pointerdown' && event.pointerType === 'touch' && event.trusted);
    const actualIds = [...new Set(downEvents.map(event => event.pointerId))];
    const activation = { trustedDownCount: downEvents.length, distinctActualPointerIds: actualIds.length,
      points: downEvents.map(event => ({ x: event.x, y: event.y, targetIsSlide: event.targetIsSlide })),
      scaleRatio: live!.scale / before!.scale };
    expect(activation.trustedDownCount, 'two trusted touch contacts reached the runtime window').toBe(2);
    expect(activation.distinctActualPointerIds, 'browser-assigned pointer ids are distinct').toBe(2);
    expect(downEvents.every(event => event.targetIsSlide && event.pathHasSlide)).toBe(true);
    expect(activation.scaleRatio, 'pinch is truly active before cancellation is judged').toBeGreaterThanOrEqual(1.1);

    await dispatch('touchCancel', []);
    await expect.poll(() => stableFrame(page), { timeout: 10_000 }).not.toBeNull();
    const canceledEvents = await runtimeEvents(slide, key);
    const pointerCancels = canceledEvents.filter(event => event.type === 'pointercancel' && event.trusted);
    const pointerUps = canceledEvents.filter(event => event.type === 'pointerup' && event.trusted);
    const touchCancels = canceledEvents.filter(event => event.type === 'touchcancel' && event.trusted);
    const afterCancel = await stableFrame(page);
    const cancelEvidence = { pointerCancelCount: pointerCancels.length,
      canceledActualIds: [...new Set(pointerCancels.map(event => event.pointerId))].length,
      pointerUpCount: pointerUps.length, touchCancelCount: touchCancels.length, afterCancel };
    evidence = { project, hashes, browserVersion: browser.version(), viewport, input: 'trusted Chromium CDP touch emulation (not hardware)',
      framePoints: points, before, live, activation, activationEvents, cancelEvidence, canceledEvents, errors,
      result: 'canceled-pinch-captured' };
    await saveEvidence(info, 'runtime-pinch-cancel-readback.json', evidence);
    expect(pointerCancels, 'each active runtime pointer received trusted pointercancel').toHaveLength(2);
    expect(cancelEvidence.canceledActualIds).toBe(2);
    expect(pointerUps, 'canceled contacts were not lifted normally').toHaveLength(0);
    expect(touchCancels, 'the trusted DOM touchcancel was also delivered').toHaveLength(1);
    expect(afterCancel!.inline, 'iframe geometry returns exactly to the saved 50% baseline').toEqual(before!.inline);
    expect(afterCancel!.zoom).toBe('50');

    // Fresh control with the same calibration and ≥10% zoom: a normal lift must commit.
    await clearRuntimePointerLog(slide, key);
    await dispatch('touchStart', [touch(left, 51), touch(right, 52)]);
    for (let step = 1; step <= 10; step++) {
      await dispatch('touchMove', [
        touch({ x: left.x - 12 * step, y: left.y }, 51),
        touch({ x: right.x + 12 * step, y: right.y }, 52),
      ]);
      await page.waitForTimeout(20);
    }
    await expect.poll(async () => (await frameNow(page)).scale, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(before!.scale * 1.1);
    const normalLive = await frameNow(page);
    const normalMovesEvents = await runtimeEvents(slide, key);
    const normalDowns = normalMovesEvents.filter(event => event.type === 'pointerdown' && event.pointerType === 'touch' && event.trusted);
    const normalIds = [...new Set(normalDowns.map(event => event.pointerId))];
    await dispatch('touchEnd', []);
    await expect.poll(() => stableFrame(page), { timeout: 10_000 }).not.toBeNull();
    const normalEvents = await runtimeEvents(slide, key);
    const normalPointerUps = normalEvents.filter(event => event.type === 'pointerup' && event.trusted);
    const normalPointerCancels = normalEvents.filter(event => event.type === 'pointercancel' && event.trusted);
    const normalTouchEnds = normalEvents.filter(event => event.type === 'touchend' && event.trusted);
    const afterNormalLift = await stableFrame(page);
    const normalControl = { trustedDownCount: normalDowns.length, distinctActualPointerIds: normalIds.length,
      liveScaleRatio: normalLive!.scale / before!.scale, trustedPointerUpCount: normalPointerUps.length,
      trustedPointerCancelCount: normalPointerCancels.length, trustedTouchEndCount: normalTouchEnds.length,
      afterNormalLift };
    evidence = { ...evidence, normalControl, normalEvents, errors };
    await saveEvidence(info, 'runtime-pinch-cancel-readback.json', evidence);
    expect(normalDowns).toHaveLength(2);
    expect(normalIds).toHaveLength(2);
    expect(normalLive!.scale / before!.scale, 'same gesture reaches the ≥10% live activation threshold').toBeGreaterThanOrEqual(1.1);
    expect(normalPointerUps).toHaveLength(2);
    expect(normalPointerCancels).toHaveLength(0);
    expect(normalTouchEnds).toHaveLength(2);
    expect(afterNormalLift!.scale / before!.scale, 'normal lift commits the pinch rather than rolling it back').toBeGreaterThanOrEqual(1.1);

    await page.locator('[data-dl-zoom]').selectOption('fit');
    await expect(page.locator('[data-dl-zoom]')).toHaveValue('fit');
    await expect.poll(() => stableFrame(page), { timeout: 10_000 }).not.toBeNull();
    const marker = `Saved after runtime pinch ${RUN}`;
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
    const reloadedTitle = page.frameLocator('.dl-frame').locator('section.slide').first().locator('h1').first();
    await expect(reloadedTitle).toHaveText(marker, { timeout: 30_000 });
    await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30_000 });
    const sourceAfterReload = readFileSync(file, 'utf8');
    const sourceHashAfterReload = createHash('sha256').update(sourceAfterReload).digest('hex');
    const persistence = { marker, savedBeforeReload: sourceBeforeReload.includes(marker),
      sourceHashBeforeReload, visibleAfterReload: true, savedAfterReload: sourceAfterReload.includes(marker), sourceHashAfterReload };
    evidence = { ...evidence, result: 'completed', persistence, errors };
    await saveEvidence(info, 'runtime-pinch-cancel-readback.json', evidence);
    expect(sourceHashAfterReload).toBe(sourceHashBeforeReload);
    expect(errors).toEqual({ page: 0, console: 0 });
  } finally {
    if (evidence.result === 'incomplete') await saveEvidence(info, 'runtime-pinch-cancel-readback.json', { ...evidence, errors });
    await context.close();
  }
});

test('runtime iframe three-finger cancel does not undo saved title or change source', async ({ browser, browserName }, info) => {
  requirePortableEnvironment();
  test.skip(browserName !== 'chromium', 'Uses trusted Chromium CDP touch emulation; not physical iPad/Pencil coverage.');
  test.setTimeout(120_000);
  const { context, page, project, file, errors } = await createDeck(browser, 'three-finger-cancel');
  const slide = page.frameLocator('.dl-frame').locator('section.slide').first();
  const title = slide.locator('h1').first();
  const marker = `Saved before canceled tri ${RUN}`;
  let evidence: Record<string, unknown> = { project, input: 'trusted Chromium CDP touch emulation (not hardware)', result: 'incomplete' };
  try {
    const hashes = await servedCodeHashes(page);
    if (await page.locator('.sidebar.left').isVisible().catch(() => false)) await page.locator('.sidebar.left button.hide').click();
    if (await page.locator('.dl-rail').isVisible().catch(() => false)) await page.locator('[data-dl-rail-hide]').click();
    await page.locator('[data-dl-zoom]').selectOption('50');
    await expect(page.locator('[data-dl-zoom]')).toHaveValue('50');
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
    const baseline = await stableFrame(page);
    expect(baseline).not.toBeNull();
    const points = await blankSlideTouches(page, slide, [0.17, 0.5, 0.83]);
    await saveEvidence(info, 'runtime-tri-calibration-readback.json', {
      project, hashes, browserVersion: browser.version(), viewport: page.viewportSize(),
      input: 'trusted Chromium CDP touch emulation (not physical iPad/Pencil coverage)',
      stage: 'pre-activation-calibration', baseline, points,
    });
    expect(points.childPoints).toHaveLength(3);
    expect(points.directSlideHits).toEqual([true, true, true]);
    const viewport = page.viewportSize()!;
    expect(points.screenPoints.every(p => p.x >= 0 && p.x < viewport.width && p.y >= 0 && p.y < viewport.height)).toBe(true);

    const key = '__runtimeIframeTriCancelEvents';
    await installRuntimePointerLog(slide, key);
    const hudKey = '__triCancelHudObserved';
    await watchHistoryHud(page, hudKey);
    const { dispatch, touch } = await childCdp(context, page);
    await dispatch('touchStart', points.screenPoints.map((point, i) => touch(point, 61 + i)));
    const downEvents = (await runtimeEvents(slide, key)).filter(event => event.type === 'pointerdown' && event.pointerType === 'touch' && event.trusted);
    await dispatch('touchCancel', []);
    await paintFrames(page, 4);
    const events = await runtimeEvents(slide, key);
    const cancels = events.filter(event => event.type === 'pointercancel' && event.trusted);
    const ups = events.filter(event => event.type === 'pointerup' && event.trusted);
    const touchCancels = events.filter(event => event.type === 'touchcancel' && event.trusted);
    const actualDownIds = [...new Set(downEvents.map(event => event.pointerId))];
    const canceledIds = [...new Set(cancels.map(event => event.pointerId))];
    const triStart = downEvents.length === 3 ? downEvents[2].timeMs : null;
    const finalCancel = cancels.length ? cancels[cancels.length - 1].timeMs : null;
    const activeToCancelMs = triStart !== null && finalCancel !== null ? finalCancel - triStart : null;
    const hudPresent = await page.locator('[data-dl-hud]').count();
    const hudObserved = await page.evaluate(property => {
      const state = (window as any)[property];
      state?.observer?.disconnect();
      return !!state?.seen;
    }, hudKey);
    const sourceAfter = readFileSync(file, 'utf8');
    const sourceHashAfter = createHash('sha256').update(sourceAfter).digest('hex');
    evidence = { project, hashes, browserVersion: browser.version(), viewport,
      input: 'trusted Chromium CDP touch emulation (not hardware)', points, baseline,
      downEvents, events, actualDownIds, canceledIds, activeToCancelMs,
      cancellation: { trustedPointerCancelCount: cancels.length, trustedPointerUpCount: ups.length, trustedTouchCancelCount: touchCancels.length },
      noUndo: { marker, hudPresent, hudObserved, sourceHashBefore, sourceHashAfter, sourceUnchanged: sourceHashBefore === sourceHashAfter }, errors,
      result: 'three-finger-cancel-captured' };
    await saveEvidence(info, 'runtime-tri-cancel-readback.json', evidence);
    expect(downEvents).toHaveLength(3);
    expect(actualDownIds).toHaveLength(3);
    expect(downEvents.every(event => event.targetIsSlide && event.pathHasSlide)).toBe(true);
    expect(cancels).toHaveLength(3);
    expect(canceledIds).toHaveLength(3);
    expect(ups).toHaveLength(0);
    expect(touchCancels.length).toBeGreaterThan(0);
    expect(activeToCancelMs, 'three-contact cancel is observed within tap-undo timing').not.toBeNull();
    expect(activeToCancelMs!).toBeLessThan(500);
    expect(hudObserved, 'cancel must not emit an Undo/Redo HUD, including transient HUDs').toBe(false);
    expect(hudPresent).toBe(0);
    expect(sourceHashAfter, 'cancel leaves the previously saved document source byte-for-byte unchanged').toBe(sourceHashBefore);
    await expect(title).toHaveText(marker);
    expect(errors).toEqual({ page: 0, console: 0 });

    await page.reload();
    const reloadedTitle = page.frameLocator('.dl-frame').locator('section.slide').first().locator('h1').first();
    await expect(reloadedTitle).toHaveText(marker, { timeout: 30_000 });
    await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30_000 });
    const sourceAfterReload = readFileSync(file, 'utf8');
    expect(createHash('sha256').update(sourceAfterReload).digest('hex')).toBe(sourceHashBefore);
    evidence = { ...evidence, result: 'completed', reloadedMarkerVisible: true, sourceHashAfterReload: sourceHashBefore, errors };
    await saveEvidence(info, 'runtime-tri-cancel-readback.json', evidence);
    expect(errors).toEqual({ page: 0, console: 0 });
  } finally {
    if (evidence.result === 'incomplete') await saveEvidence(info, 'runtime-tri-cancel-readback.json', { ...evidence, errors });
    await context.close();
  }
});
