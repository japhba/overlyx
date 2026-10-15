/**
 * One-run trusted Chromium pen/palm recovery diagnostic. This file is intentionally excluded
 * from the release Playwright matcher; it exercises CDP input against an immutable private candidate.
 * It does not author source directly and makes no claim about Apple Pencil / iPad hardware.
 */
import { test, expect, type Page, type Frame } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assertPrivateDiagnosticFixture } from './private-diagnostic-fixture';
import { login, userCredentials, BASE_URL, PROJECTS_DIR } from './helpers';

const RUN = process.env.OVERLYX_PEN_DIAG_RUN;
if (!RUN || !/^[a-z0-9-]{6,64}$/i.test(RUN)) throw new Error('Provide a unique safe OVERLYX_PEN_DIAG_RUN.');
const USER = process.env.OVERLYX_BETA_DECK_USER ?? 'luna1';
const NAME = `trusted-pen-recovery-${RUN}`;
const PROJECT = `${USER}/${NAME}`;
const FILE = path.join(PROJECTS_DIR, USER, NAME, 'slides', 'index.html');
const OUT = process.env.OVERLYX_PEN_DIAG_EVIDENCE;
const REQUIRED = ['OVERLYX_E2E_BASE', 'OVERLYX_PROJECTS_DIR', 'OVERLYX_E2E_CREDENTIALS', 'OVERLYX_EXPECTED_APP_SHA256', 'OVERLYX_EXPECTED_RUNTIME_SHA256', 'OVERLYX_PEN_DIAG_EVIDENCE'] as const;

function isolatedPreflight(): void {
  const missing = REQUIRED.filter(k => !process.env[k]);
  if (missing.length) throw new Error(`Trusted pen diagnostic requires explicit isolated variables: ${missing.join(', ')}`);
  // The shared guard validates the private temporary root, data/project layout,
  // credential permissions, and the explicitly approved frozen candidate.
  assertPrivateDiagnosticFixture({ baseURL: BASE_URL, projectsDir: PROJECTS_DIR });
  if (!existsSync(process.env.OVERLYX_E2E_CREDENTIALS!)) {
    throw new Error('Trusted pen diagnostic requires an existing private credential file.');
  }
  if (existsSync(path.join(PROJECTS_DIR, USER, NAME))) throw new Error('Refusing to reuse an existing GUI project.');
  if (!OUT || existsSync(OUT)) throw new Error('Evidence destination must be unique and not already exist.');
  mkdirSync(OUT, { recursive: true });
}

type XY = { x: number; y: number };
type EventRecord = { type: string; trusted: boolean; id: number; pointer: string; pressure: number; buttons: number; target: string; time: number };
type SafeResult = {
  outcome: 'PASS'; run: string; engine: string; appSha256: string; runtimeSha256: string;
  normalStroke: { trustedPen: boolean; pressureRange: [number, number]; sourceStrokeCount: number; saved: boolean; reload: boolean };
  readback: { firstReloadRenderedStrokeCount: number; finalReloadRenderedStrokeCount: number; guiTextExactVisible: boolean; firstStrokePreserved: boolean; undoRemovedSecondStroke: boolean; redoRestoredSameStrokeOrder: boolean; strokeSemanticSha256: [string, string] };
  heldPalm: { trustedTouchStarts: number; trustedTouchMoves: number; trustedPenContinued: boolean; strokeDelta: number; zoomUnchanged: boolean; frameUnchanged: boolean };
  captureLoss: { ownerFound: boolean; trustedMatchingLostCapture: boolean; provisionalOverlayGone: boolean; sourceUnchanged: boolean; strokeCount: number };
  undoRedo: { undoRemovedExactlyLatestStroke: boolean; redoRestoredExactlyOneStroke: boolean };
  recovery: { nextPenSaved: boolean; proseSaved: boolean; afterReload: boolean; sourceStrokeCount: number; guiTextPresent: boolean };
  errors: { page: number; console: number };
  scope: { browser: 'Chromium'; pointerCancellation: 'trusted API-induced lostpointercapture'; physicalPencilOrOSKeyboard: false; postLift400ms: 'not covered' };
};

const frameLocator = (page: Page) => page.frameLocator('.dl-frame');
const editFrame = (page: Page): Frame => page.frames().find(f => /[?&]ol=edit/.test(f.url()))!;
const source = () => readFileSync(FILE, 'utf8');
const countStrokes = (html: string) => (html.match(/<svg class="ol-ink"/g) ?? []).length;

async function installPointerObserver(page: Page): Promise<void> {
  await editFrame(page).evaluate(() => {
    const w = window as Window & { __trustedPenEvents?: EventRecord[] };
    w.__trustedPenEvents = [];
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
      addEventListener(type, (raw: Event) => {
        const e = raw as PointerEvent;
        const target = e.composedPath()[0];
        const tag = target instanceof Element ? target.localName : 'other';
        const cls = target instanceof Element ? target.getAttribute('class') ?? '' : '';
        w.__trustedPenEvents!.push({
          type, trusted: e.isTrusted, id: e.pointerId, pointer: e.pointerType,
          pressure: Number.isFinite(e.pressure) ? e.pressure : -1, buttons: e.buttons,
          target: `${tag}.${String(cls).split(/\s+/).filter(Boolean).slice(0, 2).join('.')}`,
          time: Math.round(performance.now()),
        });
      }, { capture: true });
    }
  });
}

async function drainPointerObserver(page: Page): Promise<EventRecord[]> {
  return editFrame(page).evaluate(() => {
    const w = window as Window & { __trustedPenEvents?: EventRecord[] };
    const e = w.__trustedPenEvents ?? [];
    w.__trustedPenEvents = [];
    return e;
  });
}

async function slidePoint(page: Page, fx: number, fy: number): Promise<XY> {
  const outer = await page.locator('.dl-frame').evaluate(el => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  return frameLocator(page).locator('section.slide').first().evaluate((slide, args) => {
    const r = slide.getBoundingClientRect();
    const w = slide.ownerDocument.defaultView!;
    return { x: args.outer.x + (r.x + r.width * args.fx) / w.innerWidth * args.outer.w, y: args.outer.y + (r.y + r.height * args.fy) / w.innerHeight * args.outer.h };
  }, { outer, fx, fy });
}

async function frameGeometry(page: Page) {
  return page.locator('.dl-frame').evaluate(el => {
    const r = el.getBoundingClientRect();
    return [r.x, r.y, r.width, r.height].map(n => Math.round(n * 10) / 10);
  });
}

/** Canonical SVG DOM semantics, ignoring harmless attribute order/serialization differences. */
async function canonicalSavedStrokes(page: Page, html: string): Promise<string[]> {
  return editFrame(page).evaluate(markup => {
    const parsed = new DOMParser().parseFromString(markup, 'text/html');
    const tree = (el: Element): unknown => ({
      tag: el.localName,
      attrs: Array.from(el.attributes).map(a => [a.name, a.value]).sort(([a], [b]) => a.localeCompare(b)),
      children: Array.from(el.children).map(tree),
    });
    return Array.from(parsed.querySelectorAll('section.slide svg.ol-ink')).map(svg => JSON.stringify(tree(svg)));
  }, html);
}

async function renderedStrokeCount(page: Page): Promise<number> {
  return frameLocator(page).locator('section.slide svg.ol-ink').count();
}

async function assertServedCandidate(page: Page) {
  const finalApproved = process.env.OVERLYX_FINAL_DIAGNOSTICS_APPROVED === '1';
  let proofFile: string;
  if (finalApproved) {
    const configuredProof = process.env.OVERLYX_FINAL_CANDIDATE_PROOF;
    if (!configuredProof) throw new Error('Approved final diagnostics require OVERLYX_FINAL_CANDIDATE_PROOF.');
    proofFile = path.resolve(configuredProof);
  } else {
    proofFile = path.resolve(process.env.OVERLYX_PEN_DIAG_BUILD_PROOF ?? 'scratch/slide-audit/evidence/candidate-v17-build-proof.json');
    const proofRoot = path.resolve('scratch/slide-audit/evidence');
    if (path.dirname(proofFile) !== proofRoot || !/^candidate-v(?:17|18)-build-proof\.json$/.test(path.basename(proofFile))) {
      throw new Error('Trusted pen diagnostic requires the exact local V17 or V18 candidate build proof.');
    }
  }
  const proof = JSON.parse(readFileSync(proofFile, 'utf8')) as { appAsset: string; appSha256: string; runtimeAsset: string; runtimeSha256: string };
  expect(proof.appSha256).toBe(process.env.OVERLYX_EXPECTED_APP_SHA256);
  expect(proof.runtimeSha256).toBe(process.env.OVERLYX_EXPECTED_RUNTIME_SHA256);
  const assets = await page.evaluate(() => performance.getEntriesByType('resource').map(e => new URL(e.name).pathname));
  const appPath = assets.find(p => /^\/assets\/index-[^/]+\.js$/.test(p));
  expect(appPath).toBe(proof.appAsset);
  const hash = async (resource: string) => {
    const response = await page.request.get(new URL(resource, BASE_URL).href);
    expect(response.ok()).toBeTruthy();
    return createHash('sha256').update(await response.body()).digest('hex');
  };
  const [appSha256, runtimeSha256] = await Promise.all([hash(proof.appAsset), hash(proof.runtimeAsset)]);
  expect(appSha256).toBe(proof.appSha256);
  expect(runtimeSha256).toBe(proof.runtimeSha256);
  return { appSha256, runtimeSha256 };
}

async function dispatchPen(cdp: Awaited<ReturnType<import('@playwright/test').BrowserContext['newCDPSession']>>, type: string, point: XY, force: number): Promise<void> {
  await cdp.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, force, pointerType: 'pen' });
}

async function drawPressureStroke(cdp: Awaited<ReturnType<import('@playwright/test').BrowserContext['newCDPSession']>>, start: XY, steps = 12): Promise<void> {
  await dispatchPen(cdp, 'mousePressed', start, 0.2);
  for (let i = 1; i <= steps; i++) await dispatchPen(cdp, 'mouseMoved', { x: start.x + i * 8, y: start.y + Math.sin(i / 2) * 5 }, 0.18 + 0.7 * i / steps);
  await dispatchPen(cdp, 'mouseReleased', { x: start.x + steps * 8, y: start.y }, 0.12);
}

async function dispatchTouch(cdp: Awaited<ReturnType<import('@playwright/test').BrowserContext['newCDPSession']>>, type: 'touchStart' | 'touchMove' | 'touchEnd', points: Array<XY & { id: number }>): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(p => ({ id: p.id, x: p.x, y: p.y, radiusX: 8, radiusY: 8, force: 0.7 })) });
}

test('trusted pen stroke, concurrent palm rejection, lost capture rollback and GUI recovery', async ({ page, context }) => {
  test.setTimeout(150000);
  isolatedPreflight();
  page.setDefaultTimeout(15000);
  const errors = { page: 0, console: 0 };
  page.on('pageerror', () => { errors.page++; });
  page.on('console', msg => { if (msg.type() === 'error') errors.console++; });
  let appSha256 = '', runtimeSha256 = '';
  await login(page, userCredentials(USER), { ui: 'default' });
  await expect(page.locator('[data-new-project]')).toBeVisible();
  const notNow = page.locator('.tour-card button', { hasText: 'Not now' });
  if (await notNow.count()) await notNow.click();
  await page.locator('[data-new-project]').click();
  await page.locator('[data-new-kind="deck"]').click();
  await page.locator('[data-new-name]').fill(NAME);
  await page.locator('[data-new-create]').click();
  await expect(page).toHaveURL(url => url.hash === `#/${PROJECT}/slides/index.html`);
  await expect(page.locator('.dl-frame')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30000 });
  const served = await assertServedCandidate(page);
  appSha256 = served.appSha256;
  runtimeSha256 = served.runtimeSha256;
  await installPointerObserver(page);
  await expect(frameLocator(page).locator('section.slide').first()).toBeVisible();

  const cdp = await context.newCDPSession(page);
  const baseline = source();
  await page.locator('[data-tb="dk-draw"]').click();
  const p1 = await slidePoint(page, 0.22, 0.68);
  await drawPressureStroke(cdp, p1);
  await expect.poll(() => countStrokes(source()), { timeout: 20000 }).toBe(countStrokes(baseline) + 1);
  await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30000 });
  const firstEvents = await drainPointerObserver(page);
  const firstPen = firstEvents.filter(e => e.trusted && e.pointer === 'pen');
  const firstPressure = firstPen.filter(e => e.type === 'pointermove').map(e => e.pressure).filter(p => p >= 0);
  expect(firstPen.some(e => e.type === 'pointerdown')).toBeTruthy();
  expect(firstPen.some(e => e.type === 'pointerup')).toBeTruthy();
  const firstPenId = firstPen.find(e => e.type === 'pointerdown')!.id;
  expect(firstPen.filter(e => e.type === 'pointermove' || e.type === 'pointerup').every(e => e.id === firstPenId)).toBeTruthy();
  expect(firstPressure.length).toBeGreaterThan(3);
  expect(Math.min(...firstPressure)).toBeLessThan(0.35);
  expect(Math.max(...firstPressure)).toBeGreaterThan(0.7);
  expect(countStrokes(source())).toBe(countStrokes(baseline) + 1);
  const firstSavedSource = source();
  const firstStrokeSemantics = await canonicalSavedStrokes(page, firstSavedSource);
  expect(firstStrokeSemantics).toHaveLength(countStrokes(firstSavedSource));
  await page.reload();
  await expect(page.locator('.dl-frame')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30000 });
  expect(source()).toBe(firstSavedSource);
  await expect.poll(() => renderedStrokeCount(page), { timeout: 15000 }).toBe(countStrokes(firstSavedSource));
  const firstReloadRenderedStrokeCount = await renderedStrokeCount(page);
  await installPointerObserver(page);
  await expect(frameLocator(page).locator('section.slide').first()).toBeVisible();
  await page.locator('[data-tb="dk-draw"]').click();

  // A second trusted pen stroke stays whole while two real touch contacts move as a palm.
  const beforePalmSource = source();
  const beforePalmCount = countStrokes(beforePalmSource);
  const zoomBeforePalm = await page.locator('.dl-zoom').inputValue();
  const frameBeforePalm = await frameGeometry(page);
  const p2 = await slidePoint(page, 0.27, 0.53);
  await dispatchPen(cdp, 'mousePressed', p2, 0.28);
  for (let i = 1; i <= 4; i++) await dispatchPen(cdp, 'mouseMoved', { x: p2.x + i * 7, y: p2.y + i }, 0.25 + i * 0.1);
  const palms = [{ id: 41, x: p2.x + 170, y: p2.y + 100 }, { id: 42, x: p2.x + 240, y: p2.y + 120 }];
  await dispatchTouch(cdp, 'touchStart', palms);
  for (let i = 1; i <= 4; i++) {
    await dispatchPen(cdp, 'mouseMoved', { x: p2.x + (i + 4) * 7, y: p2.y + i }, 0.3 + i * 0.1);
    await dispatchTouch(cdp, 'touchMove', palms.map((p, j) => ({ ...p, x: p.x + (j ? -i * 3 : i * 4), y: p.y + i * 2 })));
  }
  await dispatchPen(cdp, 'mouseReleased', { x: p2.x + 63, y: p2.y + 4 }, 0.1);
  await dispatchTouch(cdp, 'touchEnd', []);
  await expect.poll(() => countStrokes(source()), { timeout: 20000 }).toBe(beforePalmCount + 1);
  await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30000 });
  const afterPalmSource = source();
  const palmStrokeSemantics = await canonicalSavedStrokes(page, afterPalmSource);
  expect(palmStrokeSemantics).toHaveLength(beforePalmCount + 1);
  expect(palmStrokeSemantics[0]).toBe(firstStrokeSemantics[0]);
  const secondStrokeSemantics = palmStrokeSemantics[1];
  const palmEvents = await drainPointerObserver(page);
  const touchStarts = palmEvents.filter(e => e.type === 'pointerdown' && e.pointer === 'touch' && e.trusted);
  const touchMoves = palmEvents.filter(e => e.type === 'pointermove' && e.pointer === 'touch' && e.trusted);
  const palmPenIds = palmEvents.filter(e => e.pointer === 'pen' && e.trusted);
  expect(touchStarts.length).toBeGreaterThanOrEqual(2);
  expect(touchMoves.length).toBeGreaterThanOrEqual(2);
  expect(palmPenIds.some(e => e.type === 'pointerdown')).toBeTruthy();
  expect(palmPenIds.some(e => e.type === 'pointerup')).toBeTruthy();
  const palmPenId = palmPenIds.find(e => e.type === 'pointerdown')!.id;
  expect(palmPenIds.filter(e => e.type === 'pointermove' || e.type === 'pointerup').every(e => e.id === palmPenId)).toBeTruthy();
  expect(countStrokes(source()) - beforePalmCount).toBe(1);
  const afterPalmCount = countStrokes(source());
  expect(await page.locator('.dl-zoom').inputValue()).toBe(zoomBeforePalm);
  expect(await frameGeometry(page)).toEqual(frameBeforePalm);

  // Release the actual capture owner for a third provisional stroke, then require trusted matching loss.
  const beforeCancelSource = source();
  const beforeCancelCount = countStrokes(beforeCancelSource);
  const p3 = await slidePoint(page, 0.23, 0.39);
  await dispatchPen(cdp, 'mousePressed', p3, 0.3);
  for (let i = 1; i <= 5; i++) await dispatchPen(cdp, 'mouseMoved', { x: p3.x + i * 8, y: p3.y + 3 }, 0.3 + i * 0.1);
  const activeEvents = await drainPointerObserver(page);
  const pointerDown = activeEvents.find(e => e.type === 'pointerdown' && e.pointer === 'pen' && e.trusted);
  expect(pointerDown).toBeTruthy();
  const pointerId = pointerDown!.id;
  const releaseInfo = await editFrame(page).evaluate(id => {
    const owners = Array.from(document.querySelectorAll('*')).filter(el => {
      try { return (el as Element).hasPointerCapture(id); } catch { return false; }
    });
    if (owners.length !== 1) return { ownerFound: false, released: false };
    (owners[0] as Element).releasePointerCapture(id);
    return { ownerFound: true, released: true };
  }, pointerId);
  expect(releaseInfo.ownerFound).toBeTruthy();
  expect(releaseInfo.released).toBeTruthy();
  await dispatchPen(cdp, 'mouseMoved', { x: p3.x + 70, y: p3.y + 5 }, 0.8);
  await expect.poll(async () => (await editFrame(page).evaluate(() => (window as Window & { __trustedPenEvents?: EventRecord[] }).__trustedPenEvents ?? [])).some(e => e.type === 'lostpointercapture' && e.trusted && e.id === pointerId && e.pointer === 'pen'), { timeout: 5000 }).toBeTruthy();
  await dispatchPen(cdp, 'mouseReleased', { x: p3.x + 70, y: p3.y + 5 }, 0.1);
  await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30000 });
  const cancelEvents = await drainPointerObserver(page);
  const matchingLoss = cancelEvents.filter(e => e.type === 'lostpointercapture' && e.trusted && e.id === pointerId && e.pointer === 'pen');
  const overlayCount = await editFrame(page).locator('svg.ol-ink[data-ol-runtime]').count();
  expect(matchingLoss.length).toBe(1);
  expect(overlayCount).toBe(0);
  expect(source()).toBe(beforeCancelSource);
  expect(countStrokes(source())).toBe(beforeCancelCount);
  await writeFileSync(path.join(OUT!, 'safe-events.json'), JSON.stringify({
    normalPen: firstPen.map(({ type, trusted, id, pointer, pressure, time }) => ({ type, trusted, id, pointer, pressure, time })),
    heldPalm: palmEvents.map(({ type, trusted, id, pointer, pressure, time }) => ({ type, trusted, id, pointer, pressure, time })),
    captureLoss: cancelEvents.map(({ type, trusted, id, pointer, pressure, time }) => ({ type, trusted, id, pointer, pressure, time })),
  }, null, 2));

  // A canceled provisional stroke must not become an undo entry: Undo/Redo act on the latest real stroke.
  await page.locator('[data-tb="dk-undo"]').click();
  await expect.poll(() => countStrokes(source()), { timeout: 20000 }).toBe(beforeCancelCount - 1);
  await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30000 });
  expect(await canonicalSavedStrokes(page, source())).toEqual([firstStrokeSemantics[0]]);
  expect(await canonicalSavedStrokes(page, source())).not.toContain(secondStrokeSemantics);
  await page.locator('[data-tb="dk-redo"]').click();
  await expect.poll(() => countStrokes(source()), { timeout: 20000 }).toBe(beforeCancelCount);
  await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30000 });
  expect(await canonicalSavedStrokes(page, source())).toEqual([firstStrokeSemantics[0], secondStrokeSemantics]);

  // Continue with a fresh stroke and visible GUI-authored prose, then reload and read back.
  const p4 = await slidePoint(page, 0.24, 0.82);
  await drawPressureStroke(cdp, p4, 10);
  await expect.poll(() => countStrokes(source()), { timeout: 20000 }).toBe(beforeCancelCount + 1);
  await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30000 });
  const textValue = `Trusted pen recovery ${RUN}`;
  await page.locator('[data-tb="dk-text"]').click();
  const textStart = await slidePoint(page, 0.58, 0.76);
  const textEnd = { x: textStart.x + 150, y: textStart.y + 48 };
  await page.mouse.move(textStart.x, textStart.y);
  await page.mouse.down();
  await page.mouse.move(textEnd.x, textEnd.y, { steps: 3 });
  await page.mouse.up();
  await expect(frameLocator(page).locator('[contenteditable="true"]')).toBeVisible({ timeout: 10000 });
  await page.keyboard.type(textValue, { delay: 1 });
  await page.keyboard.press('Escape');
  await expect.poll(() => source().includes(textValue), { timeout: 20000 }).toBeTruthy();
  await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30000 });
  const finalSource = source();
  const finalCount = countStrokes(finalSource);
  await page.reload();
  await expect(page.locator('.dl-frame')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30000 });
  const reloadSource = source();
  expect(reloadSource).toBe(finalSource);
  expect(reloadSource).toContain(textValue);
  expect(countStrokes(reloadSource)).toBe(finalCount);
  await expect.poll(() => renderedStrokeCount(page), { timeout: 15000 }).toBe(finalCount);
  const finalReloadRenderedStrokeCount = await renderedStrokeCount(page);
  const renderedGuiText = frameLocator(page).locator('section.slide > p').filter({ hasText: textValue });
  await expect(renderedGuiText).toHaveCount(1);
  await expect(renderedGuiText).toHaveText(textValue);
  const result: SafeResult = {
    outcome: 'PASS', run: RUN, engine: 'Chromium', appSha256, runtimeSha256,
    normalStroke: { trustedPen: true, pressureRange: [Math.min(...firstPressure), Math.max(...firstPressure)], sourceStrokeCount: countStrokes(firstSavedSource), saved: true, reload: true },
    readback: {
      firstReloadRenderedStrokeCount, finalReloadRenderedStrokeCount, guiTextExactVisible: true,
      firstStrokePreserved: true, undoRemovedSecondStroke: true, redoRestoredSameStrokeOrder: true,
      strokeSemanticSha256: [createHash('sha256').update(firstStrokeSemantics[0]).digest('hex'), createHash('sha256').update(secondStrokeSemantics).digest('hex')],
    },
    heldPalm: { trustedTouchStarts: touchStarts.length, trustedTouchMoves: touchMoves.length, trustedPenContinued: true, strokeDelta: afterPalmCount - beforePalmCount, zoomUnchanged: true, frameUnchanged: true },
    captureLoss: { ownerFound: releaseInfo.ownerFound, trustedMatchingLostCapture: matchingLoss.length === 1, provisionalOverlayGone: overlayCount === 0, sourceUnchanged: true, strokeCount: beforeCancelCount },
    undoRedo: { undoRemovedExactlyLatestStroke: true, redoRestoredExactlyOneStroke: true },
    recovery: { nextPenSaved: true, proseSaved: true, afterReload: true, sourceStrokeCount: finalCount, guiTextPresent: true },
    errors, scope: { browser: 'Chromium', pointerCancellation: 'trusted API-induced lostpointercapture', physicalPencilOrOSKeyboard: false, postLift400ms: 'not covered' },
  };
  expect(errors).toEqual({ page: 0, console: 0 });
  writeFileSync(path.join(OUT!, 'result.json'), JSON.stringify(result, null, 2));
});
