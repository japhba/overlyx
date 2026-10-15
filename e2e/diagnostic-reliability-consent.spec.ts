/** Opt-in/GPC/204 characterization. Deliberately excluded from the normal release matcher. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { test, expect, type BrowserContext, type Frame, type Locator, type Page, type TestInfo } from '@playwright/test';
import { isReliabilityContext, isReliabilityDurationBucket, parseReliabilityDetail } from '../packages/core/src/reliability.ts';
import { login, PROJECTS_DIR, BASE_URL } from './helpers';
import { assertPrivateDiagnosticFixture } from './private-diagnostic-fixture';

const REQUIRED_ENV = ['OVERLYX_E2E_BASE', 'OVERLYX_PROJECTS_DIR', 'OVERLYX_E2E_CREDENTIALS',
  'OVERLYX_EXPECTED_APP_SHA256', 'OVERLYX_EXPECTED_RUNTIME_SHA256'] as const;
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const made: string[] = [];
const LEGACY_NAMES = new Set(['session', 'view', 'menu', 'palette', 'shortcut', 'toolbar', 'key', 'chord', 'key-unbound', 'dialog', 'notice', 'error', 'undo', 'redo']);
const ROOT_KEYS = new Set(['session', 'reliabilityConsent', 'events']);
const EVENT_KEYS = new Set(['ago', 'name', 'detail', 'ok', 'where', 'dt']);

function requireIsolatedCandidate(): void {
  if (process.env.OVERLYX_FINAL_DIAGNOSTICS_APPROVED === '1') {
    assertPrivateDiagnosticFixture({ baseURL: BASE_URL, projectsDir: PROJECTS_DIR });
  }
  const missing = REQUIRED_ENV.filter(key => !process.env[key]);
  if (missing.length) throw new Error(`Set isolated candidate inputs before this diagnostic (${missing.join(', ')}).`);
  if (process.env.OVERLYX_E2E_BASE !== BASE_URL || process.env.OVERLYX_PROJECTS_DIR !== PROJECTS_DIR) {
    throw new Error('Diagnostic requires explicit base/project variables matching the fixture helpers.');
  }
  const base = new URL(BASE_URL);
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) {
    throw new Error('Diagnostic is limited to an explicitly configured loopback candidate.');
  }
  for (const key of ['OVERLYX_EXPECTED_APP_SHA256', 'OVERLYX_EXPECTED_RUNTIME_SHA256'] as const) {
    if (!/^[a-f0-9]{64}$/i.test(process.env[key]!)) throw new Error(`Expected a 64-character ${key} candidate hash.`);
  }
}

test.afterAll(() => {
  for (const project of made) rmSync(path.join(PROJECTS_DIR, ...project.split('/')), { recursive: true, force: true });
});

type BatchSummary = {
  status: number;
  bodyShapeSafe: boolean;
  sessionTokenShape: boolean;
  reliabilityConsent: boolean;
  legacyCount: number;
  reliability: string[];
  unknownReliabilityCount: number;
};

type Capture = { batches: BatchSummary[]; mode: 'forward' | 'mock-204' };
type Point = { x: number; y: number };
type PointerRecord = { type: string; trusted: boolean; id: number; pointer: string; pressure: number };
type AdminReliabilitySnapshot = {
  events: number;
  sessions: number;
  retentionDays: number;
  counts: Record<'diagnostics.enabled none' | 'gesture.palm-ignored touch' | 'gesture.capture-lost pen', number>;
};

const EXPECTED_DIAGNOSTIC_COUNTS = {
  'diagnostics.enabled none': 1,
  'gesture.palm-ignored touch': 2,
  'gesture.capture-lost pen': 1,
} as const;

function isFiniteCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

async function readAdminReliability(page: Page): Promise<AdminReliabilitySnapshot> {
  const response = await page.request.get('/api/admin/usage?days=30');
  if (response.status() !== 200) throw new Error('Authenticated admin reliability summary request failed.');
  const body = await response.json() as Record<string, unknown>;
  if (body.enabled !== true || body.reliabilityRetentionDays !== 30) throw new Error('Admin reliability configuration did not match the expected enabled/30-day policy.');
  const reliability = body.reliability as Record<string, unknown> | undefined;
  if (!reliability || !isFiniteCount(reliability.events) || !isFiniteCount(reliability.sessions)) {
    throw new Error('Admin reliability aggregate counters were invalid.');
  }
  const details = reliability.details;
  const contexts = reliability.contexts;
  const durations = reliability.durations;
  if (!Array.isArray(details) || !Array.isArray(contexts) || !Array.isArray(durations)) {
    throw new Error('Admin reliability breakdown was incomplete.');
  }
  const counts: AdminReliabilitySnapshot['counts'] = {
    'diagnostics.enabled none': 0,
    'gesture.palm-ignored touch': 0,
    'gesture.capture-lost pen': 0,
  };
  for (const row of details) {
    if (!row || typeof row !== 'object') throw new Error('Admin reliability detail row was invalid.');
    const item = row as Record<string, unknown>;
    if (typeof item.key !== 'string' || !parseReliabilityDetail(item.key) || !isFiniteCount(item.count) || !isFiniteCount(item.sessions)) {
      throw new Error('Admin reliability detail contained an out-of-schema category.');
    }
    if (item.key in counts) counts[item.key as keyof typeof counts] = item.count;
  }
  for (const row of contexts) {
    if (!row || typeof row !== 'object') throw new Error('Admin reliability context row was invalid.');
    const item = row as Record<string, unknown>;
    if (!(item.key === 'unknown' || isReliabilityContext(item.key)) || !isFiniteCount(item.count) || !isFiniteCount(item.sessions)) {
      throw new Error('Admin reliability context contained an out-of-schema category.');
    }
  }
  for (const row of durations) {
    if (!row || typeof row !== 'object') throw new Error('Admin reliability duration row was invalid.');
    const item = row as Record<string, unknown>;
    const bucket = typeof item.key === 'string' && /^\d+$/.test(item.key) ? Number(item.key) : NaN;
    if (!(item.key === 'unknown' || isReliabilityDurationBucket(bucket)) || !isFiniteCount(item.count) || !isFiniteCount(item.sessions)) {
      throw new Error('Admin reliability duration contained an out-of-schema category.');
    }
  }
  return { events: reliability.events, sessions: reliability.sessions, retentionDays: 30, counts };
}

function summarize(body: unknown): Omit<BatchSummary, 'status'> {
  const root = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const events = Array.isArray(root.events) ? root.events : [];
  const reliability: string[] = [];
  let legacyCount = 0, unknownReliabilityCount = 0, bodyShapeSafe = Object.keys(root).every(key => ROOT_KEYS.has(key));
  for (const candidate of events) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) { bodyShapeSafe = false; continue; }
    const event = candidate as Record<string, unknown>;
    if (!Object.keys(event).every(key => EVENT_KEYS.has(key))) bodyShapeSafe = false;
    if (typeof event.ago !== 'number' || !Number.isFinite(event.ago) || event.ago < 0) bodyShapeSafe = false;
    if (event.name === 'reliability') {
      const parsed = parseReliabilityDetail(event.detail);
      if (parsed) reliability.push(`${parsed.event} ${parsed.pointer}`);
      else unknownReliabilityCount++;
      if (!isReliabilityContext(event.where)
        || event.dt !== undefined && !isReliabilityDurationBucket(event.dt)
        || event.ok !== undefined) bodyShapeSafe = false;
    } else if (typeof event.name === 'string' && LEGACY_NAMES.has(event.name)) legacyCount++;
    else bodyShapeSafe = false;
  }
  return {
    bodyShapeSafe,
    sessionTokenShape: typeof root.session === 'string' && /^[a-f0-9]{16}$/i.test(root.session),
    reliabilityConsent: root.reliabilityConsent === true,
    legacyCount,
    reliability,
    unknownReliabilityCount,
  };
}

async function observeUsage(page: Page, mode: Capture['mode']): Promise<Capture> {
  const capture: Capture = { batches: [], mode };
  await page.route('**/api/usage', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    let safe: Omit<BatchSummary, 'status'>;
    try { safe = summarize(route.request().postDataJSON()); }
    catch { safe = { bodyShapeSafe: false, sessionTokenShape: false, reliabilityConsent: false, legacyCount: 0, reliability: [], unknownReliabilityCount: 0 }; }
    if (capture.mode === 'mock-204') {
      capture.batches.push({ ...safe, status: 204 });
      await route.fulfill({ status: 204 });
      return;
    }
    const response = await route.fetch();
    capture.batches.push({ ...safe, status: response.status() });
    await route.fulfill({ response });
  });
  return capture;
}

async function candidateHashes(page: Page): Promise<{ app: string; runtime: string }> {
  const paths = (await Promise.all(page.frames().map(frame => frame.evaluate(() =>
    performance.getEntriesByType('resource').map(entry => new URL(entry.name).pathname)
      .filter(p => /^\/assets\/index-[^/]+\.js$/.test(p) || p === '/_ol/runtime.js'),
  ).catch(() => [] as string[])))).flat();
  const appPath = paths.find(p => /^\/assets\/index-[^/]+\.js$/.test(p));
  const runtimePath = paths.find(p => p === '/_ol/runtime.js');
  if (!appPath || !runtimePath) throw new Error('Could not identify the served candidate app/runtime assets.');
  const hash = async (assetPath: string) => {
    const response = await page.request.get(new URL(assetPath, BASE_URL).href);
    if (!response.ok()) throw new Error(`Candidate asset request failed with HTTP ${response.status()}.`);
    return createHash('sha256').update(await response.body()).digest('hex');
  };
  const hashes = { app: await hash(appPath), runtime: await hash(runtimePath) };
  expect(hashes.app).toBe(process.env.OVERLYX_EXPECTED_APP_SHA256);
  expect(hashes.runtime).toBe(process.env.OVERLYX_EXPECTED_RUNTIME_SHA256);
  return hashes;
}

async function createDeck(page: Page, label: string, info: TestInfo): Promise<{ project: string; hashes: { app: string; runtime: string } }> {
  const name = `diagnostic-reliability-${label}-${RUN}-${info.project.name}`;
  const project = `admin/${name}`;
  const projectDir = path.join(PROJECTS_DIR, 'admin', name);
  if (existsSync(projectDir)) throw new Error('Refusing to reuse an existing diagnostic project.');
  made.push(project);
  await page.locator('[data-new-project]').click();
  await page.locator('[data-new-kind="deck"]').click();
  await page.locator('[data-new-name]').fill(name);
  await page.locator('[data-new-create]').click();
  await expect(page.frameLocator('.dl-frame').locator('section.slide h1').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 20_000 });
  return { project, hashes: await candidateHashes(page) };
}

async function privacySettings(page: Page) {
  await page.locator('[data-user-menu]').click();
  await page.locator('.menu-item:has-text("Settings…")').click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('.settings-nav button', { hasText: 'Privacy' }).click();
  return { dialog, usage: dialog.locator('[data-pref="usageStats"]'), beta: dialog.locator('[data-pref="betaDiagnostics"]') };
}

function editFrame(page: Page): Frame {
  const frame = page.frames().find(candidate => /[?&]ol=edit/.test(candidate.url()));
  if (!frame) throw new Error('Editable canvas frame is not available.');
  return frame;
}

async function installPointerObserver(page: Page): Promise<void> {
  await editFrame(page).evaluate(() => {
    const w = window as Window & { __reliabilityPointers?: PointerRecord[] };
    w.__reliabilityPointers = [];
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
      addEventListener(type, raw => {
        const e = raw as PointerEvent;
        w.__reliabilityPointers!.push({ type, trusted: e.isTrusted, id: e.pointerId, pointer: e.pointerType, pressure: Number.isFinite(e.pressure) ? e.pressure : -1 });
      }, { capture: true });
    }
  });
}

async function drainPointerObserver(page: Page): Promise<PointerRecord[]> {
  return editFrame(page).evaluate(() => {
    const w = window as Window & { __reliabilityPointers?: PointerRecord[] };
    const events = w.__reliabilityPointers ?? [];
    w.__reliabilityPointers = [];
    return events;
  });
}

async function slidePoint(page: Page, fx: number, fy: number): Promise<Point> {
  const outer = await page.locator('.dl-frame').evaluate(el => {
    const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  return page.frameLocator('.dl-frame').locator('section.slide').first().evaluate((slide, args) => {
    const r = slide.getBoundingClientRect(), view = slide.ownerDocument.defaultView!;
    return { x: args.outer.x + (r.x + r.width * args.fx) / view.innerWidth * args.outer.w,
      y: args.outer.y + (r.y + r.height * args.fy) / view.innerHeight * args.outer.h };
  }, { outer, fx, fy });
}

async function dispatchPen(cdp: Awaited<ReturnType<BrowserContext['newCDPSession']>>, type: 'mousePressed' | 'mouseMoved' | 'mouseReleased', point: Point, force: number): Promise<void> {
  await cdp.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, force, pointerType: 'pen' });
}

async function dispatchTouch(cdp: Awaited<ReturnType<BrowserContext['newCDPSession']>>, type: 'touchStart' | 'touchMove' | 'touchEnd', points: Array<Point & { id: number }>): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(point => ({ id: point.id, x: point.x, y: point.y, radiusX: 8, radiusY: 8, force: 0.7 })) });
}

const strokeCount = (html: string) => (html.match(/<svg class="ol-ink"/g) ?? []).length;

async function setChecked(locator: Locator, checked: boolean): Promise<void> {
  if (await locator.isChecked() !== checked) await locator.setChecked(checked);
}

function attachSanitized(info: TestInfo, name: string, extras: Record<string, unknown>, capture: Capture): Promise<void> {
  return info.attach(name, {
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify({ ...extras, mode: capture.mode, batchCount: capture.batches.length, batches: capture.batches }, null, 2)),
  });
}

test('default-off consent gates real canvas signals, then opt-in survives save and cancellation recovery', async ({ page, context }, info) => {
  requireIsolatedCandidate();
  test.setTimeout(150_000);
  const capture = await observeUsage(page, 'forward');
  const errors = { page: 0, console: 0 };
  page.on('pageerror', () => errors.page++);
  page.on('console', message => { if (message.type() === 'error') errors.console++; });
  await login(page, undefined, { ui: 'default' });
  const { project, hashes } = await createDeck(page, 'opt-in', info);
  const sourcePath = path.join(PROJECTS_DIR, ...project.split('/'), 'slides', 'index.html');
  const readSource = () => readFileSync(sourcePath, 'utf8');
  const headingText = 'Canvas reliability recovery';
  const heading = page.frameLocator('.dl-frame').locator('section.slide h1').first();
  await heading.dblclick();
  await page.keyboard.press('Control+a');
  await page.keyboard.type(headingText);
  await page.keyboard.press('Escape');
  await expect.poll(() => readSource().includes(headingText), { timeout: 20_000 }).toBe(true);
  await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 20_000 });
  const settings = await privacySettings(page);
  await expect(settings.beta).not.toBeChecked();
  await setChecked(settings.beta, false);
  await setChecked(settings.usage, false);
  await expect(settings.beta).toBeDisabled();
  await setChecked(settings.usage, true);
  await expect(settings.beta).toBeEnabled();
  await expect(settings.beta).not.toBeChecked();

  // Exercise an actual trusted pen+palm signal while beta consent is off. A reload flushes
  // only after a positive ordinary-usage control has confirmed the page's collector is active.
  await page.keyboard.press('Escape');
  const cdp = await context.newCDPSession(page);
  await installPointerObserver(page);
  const unconsentedBatchStart = capture.batches.length;
  await page.locator('[data-tb="dk-draw"]').click();
  const beforeUnconsented = readSource();
  const pointA = await slidePoint(page, 0.22, 0.68);
  await dispatchPen(cdp, 'mousePressed', pointA, 0.25);
  await dispatchPen(cdp, 'mouseMoved', { x: pointA.x + 9, y: pointA.y + 3 }, 0.6);
  const unconsentedPalms = [{ id: 71, x: pointA.x + 170, y: pointA.y + 100 }, { id: 72, x: pointA.x + 240, y: pointA.y + 120 }];
  await dispatchTouch(cdp, 'touchStart', unconsentedPalms);
  await dispatchPen(cdp, 'mouseMoved', { x: pointA.x + 31, y: pointA.y + 8 }, 0.8);
  await dispatchTouch(cdp, 'touchEnd', []);
  await dispatchPen(cdp, 'mouseReleased', { x: pointA.x + 45, y: pointA.y + 8 }, 0.1);
  await expect.poll(() => strokeCount(readSource()), { timeout: 20_000 }).toBe(strokeCount(beforeUnconsented) + 1);
  await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30_000 });
  const unconsentedEvents = await drainPointerObserver(page);
  const trustedTouchStarts = unconsentedEvents.filter(event => event.type === 'pointerdown' && event.trusted && event.pointer === 'touch');
  expect(trustedTouchStarts.length).toBeGreaterThanOrEqual(2);
  await expect.poll(() => capture.batches.slice(unconsentedBatchStart).some(batch => batch.legacyCount > 0), { timeout: 30_000 }).toBe(true);
  const unconsentedBatches = capture.batches.slice(unconsentedBatchStart);
  expect(unconsentedBatches.some(batch => batch.legacyCount > 0)).toBe(true);
  expect(unconsentedBatches.flatMap(batch => batch.reliability)).toEqual([]);
  await page.reload();
  await expect(page.locator('.dl-frame')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30_000 });
  await expect(page.frameLocator('.dl-frame').locator('section.slide h1').first()).toHaveText(headingText);
  expect(strokeCount(readSource())).toBe(strokeCount(beforeUnconsented) + 1);
  await installPointerObserver(page);

  const optedSettings = await privacySettings(page);
  await expect(optedSettings.usage).toBeChecked();
  const positiveStart = capture.batches.length;
  const adminBaseline = await readAdminReliability(page);
  await setChecked(optedSettings.beta, true);
  await expect(optedSettings.beta).toBeChecked();
  await page.keyboard.press('Escape');

  // Actual trusted pen and concurrent touch input after the explicit opt-in.
  await page.locator('[data-tb="dk-draw"]').click();
  const beforePalm = readSource();
  const beforePalmCount = strokeCount(beforePalm);
  const pointB = await slidePoint(page, 0.27, 0.53);
  await dispatchPen(cdp, 'mousePressed', pointB, 0.28);
  for (let i = 1; i <= 4; i++) await dispatchPen(cdp, 'mouseMoved', { x: pointB.x + i * 7, y: pointB.y + i }, 0.25 + i * 0.1);
  const palms = [{ id: 81, x: pointB.x + 170, y: pointB.y + 100 }, { id: 82, x: pointB.x + 240, y: pointB.y + 120 }];
  await dispatchTouch(cdp, 'touchStart', palms);
  for (let i = 1; i <= 3; i++) {
    await dispatchPen(cdp, 'mouseMoved', { x: pointB.x + (i + 4) * 7, y: pointB.y + i }, 0.3 + i * 0.1);
    await dispatchTouch(cdp, 'touchMove', palms.map((point, j) => ({ ...point, x: point.x + (j ? -i * 3 : i * 4), y: point.y + i * 2 })));
  }
  await dispatchPen(cdp, 'mouseReleased', { x: pointB.x + 63, y: pointB.y + 4 }, 0.1);
  await dispatchTouch(cdp, 'touchEnd', []);
  await expect.poll(() => strokeCount(readSource()), { timeout: 20_000 }).toBe(beforePalmCount + 1);
  await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30_000 });
  const palmEvents = await drainPointerObserver(page);
  const postConsentTouchStarts = palmEvents.filter(event => event.type === 'pointerdown' && event.pointer === 'touch' && event.trusted);
  expect(postConsentTouchStarts.length).toBeGreaterThanOrEqual(2);
  expect(new Set(postConsentTouchStarts.map(event => event.id)).size).toBeGreaterThanOrEqual(2);
  const heldPen = palmEvents.filter(event => event.pointer === 'pen' && event.trusted);
  const heldPenDown = heldPen.find(event => event.type === 'pointerdown');
  const heldPenUp = heldPen.find(event => event.type === 'pointerup');
  expect(heldPenDown).toBeTruthy();
  expect(heldPenUp).toBeTruthy();
  expect(heldPenUp!.id).toBe(heldPenDown!.id);
  expect(heldPen.some(event => event.type === 'pointermove' && event.pressure > 0.6)).toBe(true);

  // A matching lostpointercapture from the real owner must roll back the provisional next stroke.
  const beforeCaptureLoss = readSource();
  const beforeCaptureLossCount = strokeCount(beforeCaptureLoss);
  const pointC = await slidePoint(page, 0.23, 0.39);
  await dispatchPen(cdp, 'mousePressed', pointC, 0.3);
  for (let i = 1; i <= 4; i++) await dispatchPen(cdp, 'mouseMoved', { x: pointC.x + i * 8, y: pointC.y + 3 }, 0.3 + i * 0.1);
  const activeEvents = await drainPointerObserver(page);
  const ownerDown = activeEvents.find(event => event.type === 'pointerdown' && event.trusted && event.pointer === 'pen');
  expect(ownerDown).toBeTruthy();
  const release = await editFrame(page).evaluate(pointerId => {
    const owners = Array.from(document.querySelectorAll('*')).filter(element => {
      try { return (element as Element).hasPointerCapture(pointerId); } catch { return false; }
    });
    if (owners.length !== 1) return { found: false, released: false };
    (owners[0] as Element).releasePointerCapture(pointerId);
    return { found: true, released: true };
  }, ownerDown!.id);
  expect(release).toEqual({ found: true, released: true });
  await dispatchPen(cdp, 'mouseMoved', { x: pointC.x + 70, y: pointC.y + 5 }, 0.8);
  await expect.poll(() => editFrame(page).evaluate(pointerId => {
    const w = window as Window & { __reliabilityPointers?: PointerRecord[] };
    return (w.__reliabilityPointers ?? []).some(event => event.type === 'lostpointercapture' && event.trusted && event.pointer === 'pen' && event.id === pointerId);
  }, ownerDown!.id), { timeout: 5_000 }).toBe(true);
  await dispatchPen(cdp, 'mouseReleased', { x: pointC.x + 70, y: pointC.y + 5 }, 0.1);
  await expect.poll(() => readSource(), { timeout: 10_000 }).toBe(beforeCaptureLoss);
  expect(strokeCount(readSource())).toBe(beforeCaptureLossCount);
  expect(await editFrame(page).locator('svg.ol-ink[data-ol-runtime]').count()).toBe(0);

  // The canvas is still usable: create prose with the GUI after capture loss, then reload.
  const guiText = `Recovered canvas ${RUN}`;
  await page.locator('[data-tb="dk-text"]').click();
  const textStart = await slidePoint(page, 0.58, 0.76);
  await page.mouse.move(textStart.x, textStart.y);
  await page.mouse.down();
  await page.mouse.move(textStart.x + 150, textStart.y + 48, { steps: 3 });
  await page.mouse.up();
  const editor = page.frameLocator('.dl-frame').locator('[contenteditable="true"]');
  await expect(editor).toBeVisible({ timeout: 10_000 });
  await page.keyboard.type(guiText, { delay: 1 });
  await page.keyboard.press('Escape');
  await expect.poll(() => readSource().includes(guiText), { timeout: 20_000 }).toBe(true);
  await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30_000 });
  const positiveCounts = () => {
    const events = capture.batches.slice(positiveStart).flatMap(batch => batch.reliability);
    return {
      'diagnostics.enabled none': events.filter(event => event === 'diagnostics.enabled none').length,
      'gesture.palm-ignored touch': events.filter(event => event === 'gesture.palm-ignored touch').length,
      'gesture.capture-lost pen': events.filter(event => event === 'gesture.capture-lost pen').length,
    };
  };
  await expect.poll(positiveCounts, { timeout: 30_000 }).toEqual(EXPECTED_DIAGNOSTIC_COUNTS);
  const positiveBatches = capture.batches.slice(positiveStart);
  const reliability = positiveBatches.flatMap(batch => batch.reliability);
  expect(positiveCounts()).toEqual(EXPECTED_DIAGNOSTIC_COUNTS);
  const finalSource = readSource();
  const finalStrokeCount = strokeCount(finalSource);
  await page.reload();
  await expect(page.locator('.dl-frame')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30_000 });
  expect(readSource()).toBe(finalSource);
  expect(strokeCount(readSource())).toBe(finalStrokeCount);
  await expect(page.frameLocator('.dl-frame').locator('section.slide h1').first()).toHaveText(headingText);
  const renderedProse = page.frameLocator('.dl-frame').locator('section.slide > p').filter({ hasText: guiText });
  await expect(renderedProse).toHaveCount(1);
  await expect(renderedProse).toHaveText(guiText);
  const adminAfterReload = await readAdminReliability(page);
  const adminReliabilityDelta: AdminReliabilitySnapshot['counts'] = {
    'diagnostics.enabled none': adminAfterReload.counts['diagnostics.enabled none'] - adminBaseline.counts['diagnostics.enabled none'],
    'gesture.palm-ignored touch': adminAfterReload.counts['gesture.palm-ignored touch'] - adminBaseline.counts['gesture.palm-ignored touch'],
    'gesture.capture-lost pen': adminAfterReload.counts['gesture.capture-lost pen'] - adminBaseline.counts['gesture.capture-lost pen'],
  };
  for (const [key, expected] of Object.entries(EXPECTED_DIAGNOSTIC_COUNTS) as Array<[keyof AdminReliabilitySnapshot['counts'], number]>) {
    expect(adminReliabilityDelta[key]).toBe(expected);
  }
  expect(adminAfterReload.events).toBeGreaterThan(adminBaseline.events);
  const safe = capture.batches.every(batch => batch.bodyShapeSafe && batch.sessionTokenShape && batch.unknownReliabilityCount === 0);
  const palmCount = reliability.filter(event => event === 'gesture.palm-ignored touch').length;
  const captureLostCount = reliability.filter(event => event === 'gesture.capture-lost pen').length;
  const allDiagnosticBatchesConsented = capture.batches.filter(batch => batch.reliability.length > 0).every(batch => batch.reliabilityConsent);
  const summary = {
    hashes, defaultBetaConsentWasOff: true, unconsentedTrustedPalmActions: trustedTouchStarts.length,
    unconsentedPositiveControlBatches: unconsentedBatches.length,
    unconsentedLegacyEvents: unconsentedBatches.reduce((n, batch) => n + batch.legacyCount, 0),
    unconsentedReliabilityEvents: unconsentedBatches.reduce((n, batch) => n + batch.reliability.length, 0),
    unconsentedCanvasSavedAndReloaded: true, trustedOptInPalmContacts: postConsentTouchStarts.length,
    palmEventsOncePerContact: palmCount === 2, capturedOwnerReleased: release.found && release.released,
    captureLostEventsExactlyOnce: captureLostCount === 1, headingSavedAndReloaded: true,
    postCancelGuiEditSavedAndReloaded: true, adminReliabilityRetentionDays: adminAfterReload.retentionDays,
    adminReliabilityDelta, adminEventsIncreased: adminAfterReload.events > adminBaseline.events,
    allDiagnosticBatchesConsented, safePayloads: safe, errors,
  };
  await attachSanitized(info, 'canvas-consent-recovery-summary.json', summary, capture);
  expect(reliability).toContain('diagnostics.enabled none');
  expect(palmCount).toBe(2);
  expect(captureLostCount).toBe(1);
  expect(allDiagnosticBatchesConsented).toBe(true);
  expect(safe).toBe(true);
  expect(errors).toEqual({ page: 0, console: 0 });
  expect(project.startsWith('admin/diagnostic-reliability-opt-in-')).toBe(true);
});

test('simulated Global Privacy Control suppresses opted-in usage and diagnostics on page exit', async ({ page }, info) => {
  requireIsolatedCandidate();
  test.setTimeout(60_000);
  await page.addInitScript(() => Object.defineProperty(navigator, 'globalPrivacyControl', { configurable: true, value: true }));
  const capture = await observeUsage(page, 'forward');
  await login(page, undefined, { ui: 'default' });
  const { hashes } = await createDeck(page, 'gpc-simulated', info);
  const settings = await privacySettings(page);
  await setChecked(settings.usage, true);
  await setChecked(settings.beta, true);
  await expect(settings.usage).toBeChecked();
  await expect(settings.beta).toBeChecked();
  expect(await page.evaluate(() => (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl)).toBe(true);
  // Reload triggers the normal page-exit flush path. This models the browser signal in script;
  // it is not evidence from a real GPC-enabled browser profile.
  await page.reload();
  await expect(page.locator('.menubar')).toBeVisible();
  await page.waitForTimeout(1_000);
  expect(capture.batches.length).toBe(0);
  await attachSanitized(info, 'gpc-simulation-summary.json', { simulatedSignal: true, hashes, reliabilityBatches: 0 }, capture);
  expect(capture.batches).toEqual([]);
});

test('simulated collector 204 stops this page load after the first opt-in batch', async ({ page }, info) => {
  requireIsolatedCandidate();
  test.setTimeout(70_000);
  const capture = await observeUsage(page, 'forward');
  await login(page, undefined, { ui: 'default' });
  const { hashes } = await createDeck(page, 'mock-client-stop', info);
  const settings = await privacySettings(page);
  await setChecked(settings.usage, true);
  // Isolate the 204 simulation to the opt-in batch; setup traffic still reaches the private candidate.
  capture.mode = 'mock-204';
  const mockStart = capture.batches.length;
  await setChecked(settings.beta, true);
  await expect.poll(() => capture.batches.length - mockStart, { timeout: 45_000 }).toBeGreaterThan(0);
  const beta = settings.beta;
  await setChecked(beta, false);
  await setChecked(beta, true);
  await expect(beta).toBeChecked();
  // This is a route-level 204 simulation, not a run against OVERLYX_USAGE_STATS=off.
  await page.waitForTimeout(1_000);
  const mockBatches = capture.batches.slice(mockStart);
  const summary = { hashes, simulatedCollectorOffResponse: 204, oneRequestThenStopped: mockBatches.length === 1 };
  await attachSanitized(info, 'simulated-204-stop-summary.json', summary, capture);
  expect(mockBatches.length).toBe(1);
  expect(mockBatches[0].status).toBe(204);
  expect(mockBatches[0].bodyShapeSafe).toBe(true);
  expect(mockBatches[0].reliability).toContain('diagnostics.enabled none');
  expect(mockBatches[0].reliabilityConsent).toBe(true);
  expect(mockBatches[0].unknownReliabilityCount).toBe(0);
});
