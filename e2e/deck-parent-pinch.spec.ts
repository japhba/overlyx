/** Release regression: trusted parent-canvas pinch cancellation, recovery, and saved editing. */
import { test, expect, type Browser, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { login, newTouchContext, PROJECTS_DIR, userCredentials, BASE_URL } from './helpers';

const RUN = `parent-pinch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const USER = process.env.OVERLYX_BETA_DECK_USER ?? 'luna1';
const made: string[] = [];
const REQUIRED_ENV = ['OVERLYX_E2E_BASE', 'OVERLYX_PROJECTS_DIR', 'OVERLYX_E2E_CREDENTIALS', 'OVERLYX_BETA_REPORT_DIR', 'OVERLYX_EXPECTED_APP_SHA256', 'OVERLYX_EXPECTED_RUNTIME_SHA256'] as const;

function requirePortableEnvironment(): void {
  const missing = REQUIRED_ENV.filter(key => !process.env[key]);
  if (missing.length) throw new Error(`Parent pinch regression requires explicit isolated environment variables: ${missing.join(', ')}`);
  if (process.env.OVERLYX_E2E_BASE !== BASE_URL || process.env.OVERLYX_PROJECTS_DIR !== PROJECTS_DIR) {
    throw new Error('Parent pinch regression requires matching isolated base URL and project directory variables.');
  }
}

test.afterAll(() => {
  for (const project of made) rmSync(path.join(PROJECTS_DIR, ...project.split('/')), { recursive: true, force: true });
});

async function createDeck(browser: Browser, name: string): Promise<{ context: Awaited<ReturnType<typeof newTouchContext>>; page: Page; project: string; errors: { page: number; console: number } }> {
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
  const project = `${USER}/${name}`;
  made.push(project);
  await expect(page).toHaveURL(url => url.hash === `#/${USER}/${name}/slides/index.html`);
  await expect(page.locator('.dl-frame')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30_000 });
  return { context, page, project, errors };
}

async function servedCodeHashes(page: Page): Promise<{ app: string; runtime: string }> {
  const resources = (await Promise.all(page.frames().map(frame => frame.evaluate(() =>
    performance.getEntriesByType('resource').map(entry => new URL(entry.name).pathname)
      .filter(pathname => /^\/assets\/index-[^/]+\.js$/.test(pathname) || pathname === '/_ol/runtime.js')
      .map(pathname => ({ pathname, url: new URL(pathname, location.href).href })),
  ).catch(() => [] as { pathname: string; url: string }[])))).flat();
  const hashOf = async (kind: string, match: (pathname: string) => boolean) => {
    const asset = resources.find(resource => match(resource.pathname));
    if (!asset) throw new Error(`Could not identify served ${kind} code asset.`);
    const response = await page.request.get(asset.url);
    if (!response.ok()) throw new Error(`Could not read served ${kind} code asset (HTTP ${response.status()}).`);
    return createHash('sha256').update(await response.body()).digest('hex');
  };
  const hashes = {
    app: await hashOf('app', p => /^\/assets\/index-[^/]+\.js$/.test(p)),
    runtime: await hashOf('runtime', p => p === '/_ol/runtime.js'),
  };
  expect(hashes.app, 'served app matches the immutable candidate selected by the beta runner').toBe(process.env.OVERLYX_EXPECTED_APP_SHA256);
  expect(hashes.runtime, 'served runtime matches the immutable candidate selected by the beta runner').toBe(process.env.OVERLYX_EXPECTED_RUNTIME_SHA256);
  return hashes;
}

test('trusted parent-canvas pinch cancellation restores exact geometry; a fresh pinch commits and editing persists', async ({ browser, browserName }, info) => {
  requirePortableEnvironment();
  test.skip(browserName !== 'chromium', 'Uses trusted Chromium CDP touch input; it is not physical-device coverage.');
  test.setTimeout(120_000);
  const { context, page, project, errors } = await createDeck(browser, `gesture-pinch-${RUN}`);
  try {
    const hashes = await servedCodeHashes(page);
    const browserVersion = browser.version();
    // Clear both side drawers through their visible UI before computing any touch point.
    if (await page.locator('.sidebar.left').count()) await page.locator('.sidebar.left button.hide').click();
    if (await page.locator('[data-dl-rail-hide]').count() && await page.locator('.dl-rail').count()) {
      await page.locator('[data-dl-rail-hide]').click();
    }
    await expect(page.locator('.sidebar.left')).toHaveCount(0);
    await expect(page.locator('.dl-rail')).toHaveCount(0);
    await page.locator('[data-dl-zoom]').selectOption('50');
    await expect(page.locator('[data-dl-zoom]')).toHaveValue('50');

    const readStable = async () => page.evaluate(() => new Promise<any>(resolve => {
      const read = () => {
        const frame = document.querySelector('.dl-frame') as HTMLIFrameElement;
        const m = new DOMMatrixReadOnly(getComputedStyle(frame).transform);
        const f = frame.getBoundingClientRect();
        return {
          inline: { transform: frame.style.transform, left: frame.style.left, top: frame.style.top, width: frame.style.width, height: frame.style.height },
          scale: Math.hypot(m.a, m.b), zoom: (document.querySelector('[data-dl-zoom]') as HTMLSelectElement).value,
          solo: frame.classList.contains('solo'), willChange: frame.style.willChange,
          frame: { left: f.left, right: f.right, top: f.top, bottom: f.bottom },
        };
      };
      requestAnimationFrame(() => {
        const a = read();
        requestAnimationFrame(() => {
          const b = read();
          resolve(a.willChange === '' && b.willChange === '' && JSON.stringify(a) === JSON.stringify(b) ? b : null);
        });
      });
    }));
    await expect.poll(readStable, { timeout: 10_000 }).not.toBeNull();
    const before = await page.evaluate(() => {
      const canvas = document.querySelector('.dl-canvas')!;
      const frame = document.querySelector('.dl-frame') as HTMLIFrameElement;
      const c = canvas.getBoundingClientRect(), f = frame.getBoundingClientRect();
      const points: { x: number; y: number; hit: string }[] = [];
      // Use a low horizontal band below the slide, deliberately clear of the QuickBar and fit controls.
      for (let y = f.bottom + 24; y <= c.bottom - 24 && points.length < 1; y += 2) {
        const row: number[] = [];
        // Keep the full 120px expansion inside the viewport/canvas so CDP doesn't rely on
        // browser behavior for contacts that have travelled beyond the visible screen.
        for (let x = c.left + 144; x <= c.right - 144; x += 2) {
          if (document.elementFromPoint(x, y) === canvas) row.push(x);
        }
        if (row.length > 1) points.push({ x: row[0], y, hit: 'canvas' }, { x: row[row.length - 1], y, hit: 'canvas' });
      }
      const matrix = new DOMMatrixReadOnly(getComputedStyle(frame).transform);
      return {
        viewport: { width: innerWidth, height: innerHeight },
        canvas: { left: c.left, right: c.right, top: c.top, bottom: c.bottom },
        frame: { left: f.left, right: f.right, top: f.top, bottom: f.bottom },
        points, zoom: (document.querySelector('[data-dl-zoom]') as HTMLSelectElement).value,
        solo: frame.classList.contains('solo'), scale: Math.hypot(matrix.a, matrix.b),
        inline: { transform: frame.style.transform, left: frame.style.left, top: frame.style.top, width: frame.style.width, height: frame.style.height },
        controlsAtPoints: points.map(p => ({ ...p, hit: document.elementFromPoint(p.x, p.y) === canvas ? 'canvas' : (document.elementFromPoint(p.x, p.y) as Element)?.tagName ?? 'none' })),
      };
    });
    mkdirSync(info.outputDir, { recursive: true });
    await page.screenshot({ path: info.outputPath('r8-stable-layout.png') });
    const calibrationReadback = { appSha256: hashes.app, runtimeSha256: hashes.runtime, browserVersion,
      input: 'trusted Chromium CDP touch emulation (not hardware)', stage: 'pre-activation-calibration', before };
    writeFileSync(info.outputPath('r8-calibration-readback.json'), JSON.stringify(calibrationReadback, null, 2));
    await info.attach('r8-calibration-readback.json', { path: info.outputPath('r8-calibration-readback.json'), contentType: 'application/json' });
    expect(before.zoom, 'zoom select remains at explicit 50%, not Fit').toBe('50');
    expect(before.solo).toBe(true);
    expect(before.points, 'two hit-tested direct-canvas points in the bottom margin').toHaveLength(2);
    expect(before.points[0].y).toBe(before.points[1].y);

    await page.evaluate(() => {
      (window as any).__r8Events = [];
      const record = (event: Event) => {
        const path = event.composedPath() as EventTarget[];
        const target = path.find(item => item instanceof Element) as Element | undefined;
        const simple = (element?: Element) => element ? { tag: element.tagName, className: typeof element.className === 'string' ? element.className.slice(0, 80) : '' } : null;
        const pointer = event as PointerEvent;
        (window as any).__r8Events.push({ type: event.type, pointerId: Number.isFinite(pointer.pointerId) ? pointer.pointerId : null,
          pointerType: pointer.pointerType ?? null, isTrusted: event.isTrusted,
          x: Number.isFinite(pointer.clientX) ? pointer.clientX : null, y: Number.isFinite(pointer.clientY) ? pointer.clientY : null,
          captureListener: 'document', actualTarget: simple(target), parentCanvasInPath: path.includes(document.querySelector('.dl-canvas')!) });
      };
      for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture', 'touchstart', 'touchmove', 'touchend', 'touchcancel']) {
        document.addEventListener(type, record, true);
      }
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    const [left, right] = before.points;
    const touch = (p: { x: number; y: number }, id: number) => ({ x: p.x, y: p.y, id });
    const dispatch = (type: string, touchPoints: ReturnType<typeof touch>[]) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
    await dispatch('touchStart', [touch(left, 1), touch(right, 2)]);
    for (let step = 1; step <= 10; step++) {
      await dispatch('touchMove', [{ x: left.x - 12 * step, y: left.y, id: 1 }, { x: right.x + 12 * step, y: right.y, id: 2 }]);
    }
    await expect.poll(() => page.evaluate(() => {
      const frame = document.querySelector('.dl-frame') as HTMLIFrameElement;
      const m = new DOMMatrixReadOnly(getComputedStyle(frame).transform);
      return Math.hypot(m.a, m.b);
    })).toBeGreaterThanOrEqual(before.scale * 1.1);
    const live = await page.evaluate(() => {
      const frame = document.querySelector('.dl-frame') as HTMLIFrameElement;
      const m = new DOMMatrixReadOnly(getComputedStyle(frame).transform);
      return { scale: Math.hypot(m.a, m.b), inline: { transform: frame.style.transform, left: frame.style.left, top: frame.style.top, width: frame.style.width, height: frame.style.height } };
    });
    const activationEvents = await page.evaluate(() => (window as any).__r8Events);
    const downs = activationEvents.filter((event: any) => event.type === 'pointerdown' && event.pointerType === 'touch' && event.isTrusted);
    const activation = {
      trustedTouchDownCount: downs.length,
      distinctPointerIds: [...new Set(downs.map((event: any) => event.pointerId))].length,
      coordinates: downs.map((event: any) => [event.x, event.y]),
      parentCanvasPath: downs.every((event: any) => event.parentCanvasInPath),
      actualTargets: downs.map((event: any) => event.actualTarget),
      scaleRatio: live.scale / before.scale,
    };
    writeFileSync(info.outputPath('activation.json'), JSON.stringify({ appSha256: hashes.app, runtimeSha256: hashes.runtime, before, live, activation, activationEvents }, null, 2));
    expect(activation.trustedTouchDownCount, 'both trusted touch pointers reached the document').toBe(2);
    expect(activation.distinctPointerIds, 'the two touch pointers had distinct browser pointer ids').toBe(2);
    expect(new Set(activation.coordinates.map((p: number[]) => p.join(','))).size, 'the touch starts had distinct screen points').toBe(2);
    expect(activation.parentCanvasPath, 'both touch event paths included the parent canvas').toBe(true);
    expect(activation.scaleRatio, 'pinch activation must change the slide scale by at least ten percent before judging cancel').toBeGreaterThanOrEqual(1.1);
    await page.screenshot({ path: info.outputPath('r8-before-cancel.png') });
    await dispatch('touchCancel', []);
    await expect.poll(readStable, { timeout: 10_000 }).not.toBeNull();
    const postCancelEvents = await page.evaluate(() => (window as any).__r8Events);
    const cancelDelivered = {
      trustedPointerCancelCount: postCancelEvents.filter((event: any) => event.type === 'pointercancel' && event.isTrusted).length,
      trustedTouchCancelCount: postCancelEvents.filter((event: any) => event.type === 'touchcancel' && event.isTrusted).length,
      cancelEvents: postCancelEvents.filter((event: any) => event.type === 'pointercancel' || event.type === 'touchcancel'),
    };
    const afterCancel = await readStable();
    expect(afterCancel, 'post-cancel frame motion stopped and two paint frames agreed').not.toBeNull();
    const afterCancelState = afterCancel!;
    await page.screenshot({ path: info.outputPath('r8-after-cancel.png') });
    const readback = { appSha256: hashes.app, runtimeSha256: hashes.runtime, browserVersion, input: 'trusted Chromium CDP touch emulation (not hardware)', before, live, activation, activationEvents, cancelDelivered, afterCancel: afterCancelState, postCancelEvents, errors };
    writeFileSync(info.outputPath('r8-readback.json'), JSON.stringify(readback, null, 2));
    await info.attach('r8-readback.json', { body: Buffer.from(JSON.stringify(readback, null, 2)), contentType: 'application/json' });
    expect(cancelDelivered.trustedPointerCancelCount, 'both browser pointers receive trusted pointercancel').toBe(2);
    expect(new Set(cancelDelivered.cancelEvents.filter((event: any) => event.type === 'pointercancel').map((event: any) => event.pointerId)).size)
      .toBe(activation.distinctPointerIds);
    expect(cancelDelivered.trustedTouchCancelCount, 'the browser also delivers trusted touchcancel').toBe(1);
    expect(afterCancelState.inline, 'cancel restores exact starting iframe inline geometry').toEqual(before.inline);
    expect(afterCancelState.zoom).toBe(before.zoom);

    // A second trusted gesture must remain usable and commit on an ordinary finger lift.
    const nextLeft = before.points[0], nextRight = before.points[1];
    await dispatch('touchStart', [touch(nextLeft, 4), touch(nextRight, 5)]);
    for (let step = 1; step <= 10; step++) {
      await dispatch('touchMove', [{ x: nextLeft.x - 12 * step, y: nextLeft.y, id: 4 }, { x: nextRight.x + 12 * step, y: nextRight.y, id: 5 }]);
      await page.waitForTimeout(20);
    }
    const secondLive = await page.evaluate(() => {
      const frame = document.querySelector('.dl-frame') as HTMLIFrameElement;
      const m = new DOMMatrixReadOnly(getComputedStyle(frame).transform);
      return { scale: Math.hypot(m.a, m.b), inline: { transform: frame.style.transform, left: frame.style.left, top: frame.style.top, width: frame.style.width, height: frame.style.height } };
    });
    const secondDowns = await page.evaluate(() => (window as any).__r8Events.filter((event: any) => event.type === 'pointerdown' && event.pointerType === 'touch' && event.isTrusted));
    await dispatch('touchEnd', []);
    await expect.poll(readStable, { timeout: 10_000 }).not.toBeNull();
    const afterNormalLift = await readStable();
    const allEvents = await page.evaluate(() => (window as any).__r8Events);
    const committedIds = new Set(secondDowns.slice(2).map((event: any) => event.pointerId));
    const normalEndEvents = allEvents.filter((event: any) => committedIds.has(event.pointerId));
    const committed = {
      trustedPointerUpCount: normalEndEvents.filter((event: any) => event.type === 'pointerup' && event.isTrusted).length,
      trustedPointerCancelCount: normalEndEvents.filter((event: any) => event.type === 'pointercancel' && event.isTrusted).length,
      trustedTouchEndCount: allEvents.filter((event: any) => event.type === 'touchend' && event.isTrusted).length,
      settled: afterNormalLift,
    };
    const followupReadback = {
      browserVersion, appSha256: hashes.app, runtimeSha256: hashes.runtime,
      secondGesture: { secondLive, secondDowns, committed, events: allEvents },
      priorCancel: { before, live, activation, cancelDelivered, afterCancel: afterCancelState },
      errors,
    };
    writeFileSync(info.outputPath('follow-up-pinch-before-assertions.json'), JSON.stringify(followupReadback, null, 2));
    expect(secondDowns).toHaveLength(4);
    expect(new Set(secondDowns.slice(2).map((event: any) => event.pointerId)).size).toBe(2);
    expect(secondLive.scale / afterCancelState.scale, 'a fresh trusted pinch after cancellation changes the slide scale by at least ten percent').toBeGreaterThanOrEqual(1.1);
    expect(committed.trustedPointerUpCount).toBe(2);
    expect(committed.trustedPointerCancelCount).toBe(0);
    // Chromium emits one trusted DOM touchend for each independently lifted contact.
    expect(committed.trustedTouchEndCount).toBe(2);
    expect(committed.settled!.scale / before.scale, 'normal lift commits rather than rolling the pinch back').toBeGreaterThanOrEqual(1.1);

    await page.locator('[data-dl-zoom]').selectOption('fit');
    await expect(page.locator('[data-dl-zoom]')).toHaveValue('fit');
    await expect.poll(readStable, { timeout: 10_000 }).not.toBeNull();
    const titleText = 'Pinch recovery verified';
    const slideTitle = page.frameLocator('.dl-frame').locator('section.slide').first().locator('h1');
    await slideTitle.dblclick();
    await page.keyboard.press('Control+a');
    await page.keyboard.type(titleText, { delay: 35 });
    await page.keyboard.press('Escape');
    await expect(slideTitle).toHaveText(titleText);
    const sourceFile = path.join(PROJECTS_DIR, ...project.split('/'), 'slides', 'index.html');
    await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30_000 });
    await expect.poll(() => readFileSync(sourceFile, 'utf8'), { timeout: 30_000 }).toContain(`>${titleText}</h1>`);
    await page.reload();
    await expect(page.frameLocator('.dl-frame').locator('section.slide').first().locator('h1')).toHaveText(titleText);
    await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30_000 });
    const finalReadback = { browserVersion, committed, titleText, sourceContainsTitle: readFileSync(sourceFile, 'utf8').includes(`>${titleText}</h1>`), errors };
    writeFileSync(info.outputPath('follow-up-gesture-and-edit.json'), JSON.stringify(finalReadback, null, 2));
    expect(finalReadback.sourceContainsTitle).toBe(true);
    expect(errors).toEqual({ page: 0, console: 0 });
  } finally { await context.close(); }
});

