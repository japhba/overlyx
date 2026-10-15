/** A zoom's 160ms idle release must not cut off a parent-canvas finger pan. */
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { login, newTouchContext, PROJECTS_DIR, userCredentials, BASE_URL } from './helpers';

const RUN = `zoom-pan-handoff-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
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
    throw new Error('Zoom/pan handoff probe requires explicit, matching isolated URL and projects directory.');
  }
}

test.afterAll(() => {
  for (const project of made) rmSync(path.join(PROJECTS_DIR, ...project.split('/')), { recursive: true, force: true });
});

type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number };
type FrameState = { rect: Box; inline: { transform: string; left: string; top: string; width: string; height: string }; willChange: string };

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
  expect(hashes.appSha256, 'served app matches immutable candidate selected by the job').toBe(process.env.OVERLYX_EXPECTED_APP_SHA256);
  expect(hashes.runtimeSha256, 'served runtime matches immutable candidate selected by the job').toBe(process.env.OVERLYX_EXPECTED_RUNTIME_SHA256);
  return hashes;
}

async function readFrame(page: Page): Promise<FrameState> {
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

async function waitTwoFrames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function installTimerAudit(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any;
    const nativeSet = window.setTimeout.bind(window);
    const nativeClear = window.clearTimeout.bind(window);
    const tracked = new Map<number, any>();
    const audit = { phase: 'setup', armed: true, timers: [] as any[] };
    w.__zoomPanTimerAudit = audit;
    w.setTimeout = function (handler: any, delay?: number, ...args: any[]) {
      if (!audit.armed || Number(delay) !== 160 || typeof handler !== 'function') return nativeSet(handler, delay, ...args);
      const record: any = { sequence: audit.timers.length + 1, delayMs: 160, createdAt: performance.now(), createPhase: audit.phase, state: 'pending' };
      const wrapped = (...callbackArgs: any[]) => {
        record.state = 'fired'; record.firedAt = performance.now(); record.firePhase = audit.phase;
        return Reflect.apply(handler, window, callbackArgs);
      };
      const id = nativeSet(wrapped, 160, ...args);
      record.id = Number.isFinite(id) ? id : null;
      tracked.set(id, record);
      audit.timers.push(record);
      return id;
    };
    w.clearTimeout = function (id: number) {
      const record = tracked.get(id);
      if (record && record.state === 'pending') {
        record.state = 'cleared'; record.clearedAt = performance.now(); record.clearPhase = audit.phase;
      }
      return nativeClear(id);
    };
    w.__zoomPanPointerEvents = [];
    const canvas = document.querySelector('.dl-canvas');
    const record = (event: Event) => {
      const e = event as PointerEvent;
      const path = event.composedPath();
      if (event.type === 'pointerdown' && audit.phase === 'zoom-50') audit.phase = 'pan-before-deadline';
      (w.__zoomPanPointerEvents as any[]).push({
        type: event.type, phase: audit.phase, trusted: event.isTrusted, timeMs: performance.now(),
        pointerId: Number.isFinite(e.pointerId) ? e.pointerId : null, pointerType: e.pointerType ?? null,
        x: Number.isFinite(e.clientX) ? e.clientX : null, y: Number.isFinite(e.clientY) ? e.clientY : null,
        parentCanvasInPath: path.includes(canvas!),
        timers160: audit.timers.filter((timer: any) => timer.delayMs === 160).map((timer: any) => ({
          sequence: timer.sequence, state: timer.state, createdAt: timer.createdAt,
          clearedAt: timer.clearedAt ?? null, firedAt: timer.firedAt ?? null,
        })),
      });
    };
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture', 'touchend', 'touchcancel']) document.addEventListener(type, record, true);
  });
}

async function setAuditPhase(page: Page, phase: string): Promise<void> {
  await page.evaluate(value => { (window as any).__zoomPanTimerAudit.phase = value; }, phase);
}

async function auditSnapshot(page: Page): Promise<{ now: number; timers: any[]; pointerEvents: any[] }> {
  return page.evaluate(() => ({
    now: performance.now(),
    timers: (window as any).__zoomPanTimerAudit.timers.map((timer: any) => ({ ...timer })),
    pointerEvents: [...(window as any).__zoomPanPointerEvents],
  }));
}

async function saveSafe(info: any, evidence: unknown): Promise<void> {
  const file = info.outputPath('zoom-pan-handoff-safe.json');
  writeFileSync(file, JSON.stringify(evidence, null, 2));
  await info.attach('zoom-pan-handoff-safe.json', { path: file, contentType: 'application/json' });
}

test('quick 75→50% zoom followed by a trusted parent pan keeps one finger through the old idle deadline', async ({ browser, browserName }, info) => {
  requirePortableEnvironment();
  test.skip(browserName !== 'chromium', 'Uses trusted Chromium CDP touch emulation; not physical-device coverage.');
  test.setTimeout(120_000);
  const { context, page, project, file, errors } = await createDeck(browser);
  const titleOne = page.frameLocator('.dl-frame').locator('section.slide').first().locator('h1');
  let evidence: Record<string, unknown> = { project, input: 'trusted Chromium CDP touch emulation (not hardware)', result: 'incomplete' };
  try {
    const hashes = await servedCodeHashes(page);
    await expect(titleOne).toBeVisible();
    const startingTitle = (await titleOne.textContent())?.trim() ?? '';
    expect(startingTitle).not.toBe('');
    const zoom = page.locator('[data-dl-zoom]');
    if (await page.locator('.sidebar.left').isVisible().catch(() => false)) await page.locator('.sidebar.left button.hide').click();
    if (await page.locator('.dl-rail').isVisible().catch(() => false)) await page.locator('[data-dl-rail-hide]').click();
    await expect(page.locator('.sidebar.left')).toHaveCount(0);
    await expect(page.locator('.dl-rail')).toHaveCount(0);

    // Start at the intended 50% canvas geometry and let that setup zoom finish before arming telemetry.
    await zoom.selectOption('50');
    await expect(zoom).toHaveValue('50');
    await expect.poll(async () => (await readFrame(page)).willChange).toBe('');
    await waitTwoFrames(page);
    const baseline = await readFrame(page);
    // Precompute a direct parent-canvas margin point at stable 50% before arming either zoom timer.
    const surface = await page.evaluate(() => {
      const canvas = document.querySelector('.dl-canvas')!;
      const frame = document.querySelector('.dl-frame') as HTMLIFrameElement;
      const c = canvas.getBoundingClientRect(), f = frame.getBoundingClientRect();
      const center = c.left + c.width / 2;
      const yMin = Math.max(c.top + 24, f.bottom + 12), yMax = c.bottom - 24;
      let y = NaN, x = NaN;
      for (let cy = yMin; cy <= yMax && Number.isNaN(y); cy += 2) {
        for (let cx = Math.max(c.left + 100, center - 180); cx <= Math.min(c.right - 100, center + 180); cx += 2) {
          if (document.elementFromPoint(cx, cy) === canvas) { x = cx; y = cy; break; }
        }
      }
      return {
        zoomValue: (document.querySelector('[data-dl-zoom]') as HTMLSelectElement).value,
        canvas: { left: c.left, right: c.right, top: c.top, bottom: c.bottom, width: c.width, height: c.height },
        frame: { left: f.left, right: f.right, top: f.top, bottom: f.bottom, width: f.width, height: f.height,
          transform: frame.style.transform, willChange: frame.style.willChange },
        start: { x, y, directCanvasHit: Number.isFinite(x) && Number.isFinite(y) && document.elementFromPoint(x, y) === canvas },
      };
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await installTimerAudit(page);
    const selectionStartedAt = await page.evaluate(() => performance.now());
    await setAuditPhase(page, 'zoom-75');
    await zoom.selectOption('75');
    const afterZoom75At = await page.evaluate(() => performance.now());
    await setAuditPhase(page, 'zoom-50');
    await zoom.selectOption('50');
    // Do not query the page, initialize CDP, or pause for calibration after the second zoom.
    // The trusted initial 30px path is sent first; timer identity and actual event target are read afterward.
    const start = surface.start;
    const xs = [start.x, start.x - 10, start.x - 30, start.x - 50];
    const touch = (x: number, id = 1) => ({ x, y: start.y, id });
    const dispatch = (type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel', touchPoints: ReturnType<typeof touch>[]) =>
      cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
    await dispatch('touchStart', [touch(xs[0])]);
    await dispatch('touchMove', [touch(xs[1])]);
    await dispatch('touchMove', [touch(xs[2])]);
    const afterInitialPan = await auditSnapshot(page);
    const timers75 = afterInitialPan.timers.filter(timer => timer.delayMs === 160 && timer.createPhase === 'zoom-75');
    const timers50 = afterInitialPan.timers.filter(timer => timer.delayMs === 160 && timer.createPhase === 'zoom-50');
    const exactZoomTimerPair = afterInitialPan.timers.length === 2 && timers75.length === 1 && timers50.length === 1;
    const timer75 = timers75[0], timer50 = timers50[0];
    const selection = { selectionStartedAt, afterZoom75At, zoom75ElapsedMs: afterZoom75At - selectionStartedAt,
      zoom50TimerCreatedAt: timer50?.createdAt ?? null, zoom50TimerGapAfter75TimerMs: timer50 && timer75 ? timer50.createdAt - timer75.createdAt : null };
    const pointerDown = afterInitialPan.pointerEvents.find(event => event.type === 'pointerdown' && event.pointerType === 'touch');
    const pointerId = pointerDown?.pointerId;
    const preMoves = afterInitialPan.pointerEvents.filter(event => event.type === 'pointermove' && event.pointerId === pointerId && event.trusted);
    const firstPanMove = preMoves.find(event => Math.abs(event.x - start.x) >= 30);
    const deadlineAt = timer50 ? timer50.createdAt + 160 : null;
    const timerAtFirstPan = firstPanMove?.timers160?.find((timer: any) => timer.sequence === timer50?.sequence);
    const firstPanBeforeDeadline = !!firstPanMove && deadlineAt !== null && firstPanMove.timeMs < deadlineAt;
    const zoomTimerWasPendingAtPan = timerAtFirstPan?.state === 'pending';
    const zoomTimerClearedByPan = !!firstPanMove && !!timer50 && timer50.state === 'cleared' &&
      typeof timer50.clearedAt === 'number' && timer50.clearedAt >= firstPanMove.timeMs && timer50.clearedAt < timer50.createdAt + 160;
    const zoomTimerFiredAfterPan = !!firstPanMove && !!timer50 && timer50.state === 'fired' &&
      typeof timer50.firedAt === 'number' && timer50.firedAt >= firstPanMove.timeMs;
    const zoomTimerStillLiveAfterPan = timer50?.state === 'pending' || zoomTimerClearedByPan || zoomTimerFiredAfterPan;
    const parentHitPath = pointerDown?.trusted && pointerDown.parentCanvasInPath && firstPanMove?.parentCanvasInPath;
    if (surface.zoomValue !== '50' || !surface.start.directCanvasHit || !(surface.start.y > surface.frame.bottom) ||
      !exactZoomTimerPair || timer75?.state !== 'cleared' || timer75.clearPhase !== 'zoom-50' ||
      !pointerDown?.trusted || !pointerDown.parentCanvasInPath || !firstPanMove || !firstPanMove.trusted ||
      !firstPanMove.parentCanvasInPath || !firstPanBeforeDeadline || !zoomTimerWasPendingAtPan || !zoomTimerStillLiveAfterPan ||
      Math.abs(xs[2] - xs[1]) !== 20) {
      evidence = { project, hashes, viewport: { width: 1024, height: 768 }, baseline, selection, surface,
        timers: afterInitialPan.timers, pointerDown, preMoves, firstPanMove, timerAtFirstPan, timer50AfterInitialPan: timer50,
        calibration: { exactZoomTimerPair, parentHitPath, firstPanBeforeDeadline, zoomTimerWasPendingAtPan, zoomTimerClearedByPan,
          zoomTimerFiredAfterPan, zoomTimerStillLiveAfterPan, deadlineAt, snapshotAt: afterInitialPan.now },
        pointerTimeline: afterInitialPan.pointerEvents, classification: 'calibration-unavailable',
        reason: 'Could not prove a uniquely paired live 50% zoom timer and trusted parent-canvas first pan before its deadline.' };
      await dispatch('touchCancel', []);
      await saveSafe(info, evidence);
      expect(false, 'Chromium zoom/pan calibration must be established; otherwise this candidate case is uncertified.').toBe(true);
    }

    const preDeadline = afterInitialPan;
    const timerAfterFirstPan = preDeadline.timers.find(timer => timer.sequence === timer50.sequence);
    const parentPageTurnThresholdPx = 0.15 * surface.canvas.width;
    const postDeadzonePanPx = Math.abs(xs[2] - xs[1]) + Math.abs(xs[3] - xs[2]);
    await setAuditPhase(page, 'wait-past-deadline');
    const remaining = Math.max(0, deadlineAt + 20 - preDeadline.now);
    await page.waitForTimeout(remaining);
    // One small read both confirms the deadline passed and advances telemetry phase, avoiding
    // a full event-log copy plus a second round trip before the final trusted move.
    const afterDeadlineBeforeMove = await page.evaluate(sequence => {
      const audit = (window as any).__zoomPanTimerAudit;
      const timer = audit.timers.find((item: any) => item.sequence === sequence);
      const snapshot = { now: performance.now(), timer: timer ? { ...timer } : null };
      audit.phase = 'pan-after-deadline';
      return snapshot;
    }, timer50.sequence);
    await dispatch('touchMove', [touch(xs[3])]);
    await dispatch('touchEnd', []);
    await waitTwoFrames(page);
    const afterLift = await auditSnapshot(page);
    const pointerEvents = afterLift.pointerEvents.filter(event => event.pointerId === pointerId || event.type === 'touchend');
    const moves = pointerEvents.filter(event => event.type === 'pointermove' && event.trusted);
    const up = pointerEvents.find(event => event.type === 'pointerup' && event.trusted);
    const touchEnd = pointerEvents.find(event => event.type === 'touchend' && event.trusted);
    const firstPanAt = firstPanMove.timeMs;
    const panToUpMs = up ? up.timeMs - firstPanAt : null;
    const downToUpMs = up && pointerDown ? up.timeMs - pointerDown.timeMs : null;
    const afterTimer = afterLift.timers.find(timer => timer.sequence === timer50.sequence);
    const exactTimerPairThroughLift = afterLift.timers.length === 2 &&
      afterLift.timers.some(timer => timer.sequence === timer75.sequence) &&
      afterLift.timers.some(timer => timer.sequence === timer50.sequence);
    const slides = page.frameLocator('.dl-frame').locator('section.slide');
    const shownAfterLift = await slides.evaluateAll(items => items.map(item => (item as HTMLElement).offsetHeight > 0 ? 1 : 0).join(''));
    const titleAfterLift = { visible: await titleOne.isVisible(), stillOriginal: (await titleOne.textContent())?.trim() === startingTitle };
    await page.locator('[data-dl-rail-show]').click();
    const pageReadout = page.locator('.dl-rail-count');
    await expect(pageReadout).toBeVisible();
    const pageReadoutAfterLift = (await pageReadout.textContent())?.trim() ?? '';
    evidence = {
      project, hashes, browserVersion: browser.version(), viewport: { width: 1024, height: 768 },
      input: 'trusted Chromium CDP touch emulation (not hardware)', zoomPath: 'GUI select 75%, then GUI select 50%',
      sourceThresholds: { parentTouchDeadzonePx: 10, panPageFastEdgePx: 30, pageTurnWidthFraction: 0.15, zoomIdleReleaseMs: 160 },
      baseline, selection, surface,
      timerLifecycle: { expectedOnePerGuiZoom: exactZoomTimerPair, exactlyTwoTimersThroughLift: exactTimerPairThroughLift,
        zoom75: timer75, zoom50AfterInitialPan: timer50,
        zoom50AfterFirstPan: timerAfterFirstPan, deadlineAt, waitRequestedMs: remaining,
        observationAfterDeadlineBeforeMove: afterDeadlineBeforeMove.timer,
        zoom50AfterLift: afterTimer },
      gesture: {
        path: xs.map(x => ({ x, y: start.y })), totalFingerTravelPx: Math.abs(xs[3] - xs[0]),
        firstPanPixelsBeforeDeadline: Math.abs(xs[2] - xs[1]), lastPanPixelsAfterDeadline: Math.abs(xs[3] - xs[2]),
        postDeadzonePanPx, parentPageTurnThresholdPx,
        pointerDown, firstPanPointerMove: firstPanMove, trustedMoveCount: moves.length, trustedPointerUp: up,
        trustedTouchEnd: touchEnd, firstPanToUpMs: panToUpMs, pointerDownToUpMs: downToUpMs,
        timeFromZoomTimerToFirstPanMs: firstPanAt - timer50.createdAt,
        finalMoveAfterDeadline: moves.some(event => event.x === xs[3] && event.timeMs > deadlineAt),
        eventTimeline: pointerEvents,
      },
      observedResult: { shownSlidesAfterLift: shownAfterLift, titleAfterLift, pageReadoutAfterLift }, errors,
      result: 'gesture-observed',
    };
    await saveSafe(info, evidence);
    if (!exactTimerPairThroughLift || panToUpMs === null || panToUpMs >= 250 ||
      !moves.some(event => event.x === xs[3] && event.timeMs > deadlineAt)) {
      evidence.classification = 'calibration-unavailable';
      evidence.reason = 'Timer identity, first-pan timing, post-deadline motion, or the fast-lift window was ambiguous; no product result inferred.';
      await saveSafe(info, evidence);
      throw new Error('Infrastructure calibration failed: the timed zoom/pan overlap could not be established unambiguously within the fast-lift window.');
    }
    expect(exactZoomTimerPair, 'timer telemetry observed only the two controlled GUI zoom idle timers').toBe(true);
    expect(timer75.state, 'the next GUI zoom cleared the 75% zoom idle timer').toBe('cleared');
    expect(timer75.clearPhase).toBe('zoom-50');
    expect(pointerDown?.trusted && pointerDown.parentCanvasInPath, 'trusted touch began on the parent canvas margin').toBe(true);
    expect(firstPanMove.timeMs, 'first parent pan started before the current 50% zoom timer deadline').toBeLessThan(deadlineAt);
    expect(firstPanAt - timer50.createdAt, 'first pan overlapped the current zoom idle timer').toBeLessThan(160);
    expect(afterDeadlineBeforeMove.now, 'the finger remained down beyond the original zoom deadline').toBeGreaterThan(deadlineAt);
    expect(moves.some(event => event.x === xs[3] && event.timeMs > deadlineAt), 'the second pan segment happened after that deadline').toBe(true);
    expect(Math.abs(xs[2] - xs[1]), 'first parent-pan segment stays below the fast-fling edge').toBeLessThan(30);
    expect(postDeadzonePanPx, 'total pan remains below the 15% parent-page turn threshold').toBeLessThan(parentPageTurnThresholdPx);
    expect(up, 'the gesture ended with a trusted pointerup').toBeTruthy();
    expect(touchEnd, 'the gesture ended with a trusted DOM touchend').toBeTruthy();
    expect(panToUpMs, 'normal lift occurred within 250ms of first pan').not.toBeNull();
    expect(panToUpMs!).toBeLessThan(250);
    // Record down-to-up as context only; the source fast-flick clock starts at the first pan move.
    expect(pageReadoutAfterLift, 'same continuous finger reaches slide two after the zoom timer deadline').toBe('Slide 2 of 2');
    expect(shownAfterLift, 'continued finger motion and normal lift advance to slide two').toBe('01');
    expect(afterTimer?.state, 'finger pan clears the old zoom idle timer instead of letting it release mid-gesture').toBe('cleared');
    expect(afterTimer?.firedAt, 'the zoom idle timer must not fire during the finger pan').toBeUndefined();
    await page.frameLocator('.dl-railframe').locator('section.slide').first().click();
    await expect(pageReadout).toHaveText('Slide 1 of 2');
    await expect(titleOne).toHaveText(startingTitle);
    const marker = `Saved zoom pan handoff ${RUN}`;
    await titleOne.dblclick();
    await page.keyboard.press('Control+a');
    await page.keyboard.type(marker, { delay: 20 });
    await page.keyboard.press('Escape');
    await expect(titleOne).toHaveText(marker);
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
    evidence.result = 'completed';
    evidence.guiEditPersistence = {
      marker, savedBeforeReload: sourceBeforeReload.includes(marker), sourceHashBeforeReload,
      visibleAfterReload: true, savedAfterReload: sourceAfterReload.includes(marker), sourceHashAfterReload,
      sourceUnchangedAcrossReload: sourceHashAfterReload === sourceHashBeforeReload,
    };
    evidence.errors = errors;
    await saveSafe(info, evidence);
    expect(sourceHashAfterReload, 'GUI source remained exact across reload').toBe(sourceHashBeforeReload);
    expect(errors).toEqual({ page: 0, console: 0 });
  } finally {
    if (Object.keys(evidence).length) await saveSafe(info, evidence);
    await context.close();
  }
});
