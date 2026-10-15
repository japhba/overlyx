/**
 * Bounded Chromium touch-emulation diagnostic for a service-worker update. Two isolated
 * browser profiles are used in one Chromium process: one uses the ordinary HTTP cache, the other
 * has only its HTTP cache cleared/disabled after activation to model expiry/eviction. This prevents
 * the first trial's service-worker fallback from contaminating the second. Service-worker caches
 * are observed but never cleared or modified. This is not a physical iPad result.
 */
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { login, newTouchContext, PROJECTS_DIR, userCredentials } from './helpers';
import { assertPrivateDiagnosticFixture, readFinalDiagnosticCandidateProof } from './private-diagnostic-fixture';

const BASE = process.env.OVERLYX_E2E_BASE!;
const RUN = process.env.OVERLYX_SW_UPGRADE_RUN!;
const OWNER = 'luna1';
const ROOT = path.resolve(process.env.OVERLYX_SW_UPGRADE_EVIDENCE_DIR ?? 'scratch/slide-audit/evidence/sw-v15-v16-upgrade');
const READY = path.join(ROOT, `ready-${RUN}.json`);
const GO = path.join(ROOT, `.go-new-assets-${RUN}`);
const OUTPUT = path.join(ROOT, `result-${RUN}.json`);
const OLD_DIST = process.env.OVERLYX_SW_OLD_DIST!;
const NEW_DIST = process.env.OVERLYX_SW_NEW_DIST!;
const VIEWPORT = { width: 820, height: 1180 };

type AssetObservation = {
  basename: string;
  status: number;
  mime: 'javascript' | 'html' | 'other' | 'unknown';
  fromServiceWorker: boolean;
  sha256?: string;
  bytes?: number;
};

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function mathSourceValues(source: string): string[] {
  return Array.from(source.matchAll(/\\\[([\s\S]*?)\\\]|\\\(([\s\S]*?)\\\)/g), match => (match[1] ?? match[2] ?? '').trim());
}

function requirePrivateEnvironment(): void {
  assertPrivateDiagnosticFixture({ baseURL: BASE, projectsDir: PROJECTS_DIR });
  if (!RUN || !OLD_DIST || !NEW_DIST) {
    throw new Error('Refusing to write outside the isolated slide-audit setup or to a non-private server.');
  }
  if (process.env.OVERLYX_FINAL_DIAGNOSTICS_APPROVED === '1' &&
    NEW_DIST !== readFinalDiagnosticCandidateProof().dist) {
    throw new Error('Upgrade diagnostic final distribution does not match the approved candidate proof.');
  }
}

function publicBundleNames(dist: string): { app: string; auxiliary: string; keyboard: string; appSha256: string; auxiliarySha256: string; keyboardSha256: string } {
  const html = readFileSync(path.join(dist, 'index.html'), 'utf8');
  const app = [...html.matchAll(/src="(\/assets\/index-[^"]+\.js)"/g)][0]?.[1]?.split('/').at(-1);
  const sw = readFileSync(path.join(dist, 'sw.js'), 'utf8');
  const keyboard = [...sw.matchAll(/"\/assets\/(keyboard-[^"]+\.js)"/g)][0]?.[1];
  const auxiliary = [...sw.matchAll(/"\/assets\/(index-[^"]+\.js)"/g)].map(match => match[1]).find(name => name !== app);
  if (!app || !auxiliary || !keyboard) throw new Error(`Could not identify app and lazy chunks in immutable candidate ${path.basename(path.dirname(dist))}.`);
  const appBytes = readFileSync(path.join(dist, 'assets', app));
  const auxiliaryBytes = readFileSync(path.join(dist, 'assets', auxiliary));
  const keyboardBytes = readFileSync(path.join(dist, 'assets', keyboard));
  return { app, auxiliary, keyboard, appSha256: sha256(appBytes), auxiliarySha256: sha256(auxiliaryBytes), keyboardSha256: sha256(keyboardBytes) };
}

const OLD = publicBundleNames(OLD_DIST);
const NEW = publicBundleNames(NEW_DIST);
const OLD_APP = OLD.app;
const NEW_APP = NEW.app;
const OLD_KEYBOARD = OLD.keyboard;
const NEW_KEYBOARD = NEW.keyboard;
const OLD_AUX = OLD.auxiliary;
const NEW_AUX = NEW.auxiliary;

async function createDeck(page: Page, name: string): Promise<string> {
  const existingProject = path.join(PROJECTS_DIR, OWNER, name);
  if (existsSync(existingProject)) throw new Error('Refusing to reuse an existing isolated diagnostic project; choose a globally unique run ID.');
  await login(page, userCredentials(OWNER), { ui: 'default' });
  await page.locator('[data-new-project]').click();
  await page.locator('[data-new-kind="deck"]').click();
  await page.locator('[data-new-name]').fill(name);
  await page.locator('[data-new-create]').click();
  const project = `${OWNER}/${name}`;
  await expect(page).toHaveURL(url => url.hash === `#/${project}/slides/index.html`);
  await expect(page.locator('.dl-frame')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30_000 });
  return project;
}

async function activeSwState(page: Page) {
  return page.evaluate(async ({ oldChunk, oldAux, newChunk, newAux }) => {
    const registration = await navigator.serviceWorker.getRegistration();
    const controller = navigator.serviceWorker.controller;
    const shellKeys = (await caches.keys()).filter(key => key.startsWith('overlyx-shell-')).sort();
    const oldUrl = new URL(`/assets/${oldChunk}`, location.origin).href;
    const oldCached = await caches.match(oldUrl);
    const oldAuxUrl = new URL(`/assets/${oldAux}`, location.origin).href;
    const oldAuxCached = await caches.match(oldAuxUrl);
    const newKeyboardCached = await caches.match(new URL(`/assets/${newChunk}`, location.origin).href);
    const newAuxCached = await caches.match(new URL(`/assets/${newAux}`, location.origin).href);
    const executed = performance.getEntriesByType('resource').some(entry => new URL(entry.name).pathname.endsWith(`/${oldChunk}`));
    return {
      controllerPresent: !!controller,
      registrationActive: registration?.active?.state === 'activated',
      shellKeys,
      oldKeyboardInSwCache: !!oldCached,
      oldAuxInSwCache: !!oldAuxCached,
      newKeyboardInSwCache: !!newKeyboardCached,
      newAuxInSwCache: !!newAuxCached,
      oldKeyboardExecuted: executed,
      oldAuxExecuted: performance.getEntriesByType('resource').some(entry => new URL(entry.name).pathname.endsWith(`/${oldAux}`)),
      appBundleNames: performance.getEntriesByType('resource')
        .map(entry => new URL(entry.name).pathname.split('/').at(-1) ?? '')
        .filter(name => /^index-[^/]+\.js$/.test(name)),
    };
  }, { oldChunk: OLD_KEYBOARD, oldAux: OLD_AUX, newChunk: NEW_KEYBOARD, newAux: NEW_AUX });
}

function checkpoint(stage: string, data: Record<string, unknown>): void {
  const file = path.join(ROOT, `checkpoint-${RUN}-${stage}.json`);
  if (existsSync(file)) throw new Error(`Evidence checkpoint already exists for stage ${stage}; choose a new RUN.`);
  writeFileSync(file, JSON.stringify({ run: RUN, stage, timestamp: new Date().toISOString(), ...data }, null, 2) + '\n');
}

async function waitForParentGo(): Promise<void> {
  await expect.poll(() => existsSync(GO), {
    timeout: 120_000,
    intervals: [500, 1000, 2000],
    message: `Wait for parent to verify new-build assets and create ${path.relative(process.cwd(), GO)}`,
  }).toBe(true);
}

async function addUnsavedDraft(page: Page, text: string): Promise<{ activeEditor: boolean; sourceContainsDraft: boolean; status: string }> {
  await page.locator('[data-tb="dk-text"]').click();
  const slide = page.frameLocator('.dl-frame').locator('section.slide').first();
  const box = await slide.boundingBox();
  if (!box) throw new Error('Touch viewport has no visible slide canvas.');
  await page.touchscreen.tap(box.x + box.width * 0.34, box.y + box.height * 0.62);
  const editor = slide.locator('[contenteditable="true"]').last();
  await expect(editor).toBeVisible({ timeout: 10_000 });
  await page.keyboard.type(text, { delay: 18 });
  const sourceFile = path.join(PROJECTS_DIR, OWNER, new URL(page.url()).hash.slice(2).split('/')[1], 'slides', 'index.html');
  return {
    activeEditor: await editor.evaluate(el => el === document.activeElement || el.contains(document.activeElement)),
    sourceContainsDraft: readFileSync(sourceFile, 'utf8').includes(text),
    status: (await page.locator('.dl-status').textContent())?.trim() ?? 'unknown',
  };
}

async function updateServiceWorker(page: Page) {
  const changed = page.evaluate(() => new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true })));
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.update());
  await expect.poll(() => changed.then(() => true), { timeout: 45_000, intervals: [250, 500, 1000], message: 'Wait for a real new-build service-worker controllerchange event.' }).toBe(true);
  await expect.poll(async () => {
    const state = await activeSwState(page);
    return state.controllerPresent && state.registrationActive;
  }, { timeout: 60_000, intervals: [250, 500, 1000], message: 'After controllerchange, wait for the new controller to become active; retained old shell assets are allowed.' }).toBe(true);
  return activeSwState(page);
}

async function observeKeyboardAttempt(page: Page, context: BrowserContext, project: string, disableHttpCache: boolean): Promise<Record<string, unknown>> {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  if (disableHttpCache) {
    await cdp.send('Network.clearBrowserCache');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  }
  const responses: AssetObservation[] = [];
  const requests: Array<{ basename: string; failure: 'net-error' | 'other' }> = [];
  const responseBodyJobs: Promise<void>[] = [];
  const bodyDigests: Array<{ basename: string; sha256?: string; bytes?: number; bodyRead: boolean }> = [];
  page.on('response', response => {
    let basename = '';
    try { basename = new URL(response.url()).pathname.split('/').at(-1) ?? ''; } catch { return; }
    if (![OLD_KEYBOARD, NEW_KEYBOARD, OLD_AUX, NEW_AUX].includes(basename)) return;
    responseBodyJobs.push((async () => {
      try {
        const body = await response.body();
        bodyDigests.push({ basename, sha256: sha256(body), bytes: body.byteLength, bodyRead: true });
      } catch {
        bodyDigests.push({ basename, bodyRead: false });
      }
    })());
  });
  cdp.on('Network.responseReceived', event => {
    let basename = '';
    try { basename = new URL(event.response.url).pathname.split('/').at(-1) ?? ''; } catch { return; }
    if (![OLD_KEYBOARD, NEW_KEYBOARD, OLD_AUX, NEW_AUX].includes(basename)) return;
    const mime = /javascript|ecmascript/i.test(event.response.mimeType) ? 'javascript'
      : /html/i.test(event.response.mimeType) ? 'html' : event.response.mimeType ? 'other' : 'unknown';
    responses.push({ basename, status: event.response.status, mime, fromServiceWorker: !!event.response.fromServiceWorker });
  });
  cdp.on('Network.loadingFailed', event => {
    if (!event.errorText) return;
    const request = event.requestId;
    const name = cdpRequests.get(request);
    if (name && [OLD_KEYBOARD, NEW_KEYBOARD, OLD_AUX, NEW_AUX].includes(name)) requests.push({ basename: name, failure: event.errorText.includes('ERR_') ? 'net-error' : 'other' });
  });
  const cdpRequests = new Map<string, string>();
  cdp.on('Network.requestWillBeSent', event => {
    try {
      const basename = new URL(event.request.url).pathname.split('/').at(-1) ?? '';
      if ([OLD_KEYBOARD, NEW_KEYBOARD, OLD_AUX, NEW_AUX].includes(basename)) cdpRequests.set(event.requestId, basename);
    } catch { /* URLs are intentionally not retained. */ }
  });

  await page.locator('[data-tb="dk-text"]').click();
  const slide = page.frameLocator('.dl-frame').locator('section.slide').first();
  const box = await slide.boundingBox();
  if (!box) throw new Error('Touch viewport has no visible slide canvas for the formula attempt.');
  await page.touchscreen.tap(box.x + box.width * 0.28, box.y + box.height * 0.70);
  const editor = slide.locator('[contenteditable="true"]').last();
  await expect(editor).toBeVisible({ timeout: 10_000 });
  await page.keyboard.type(disableHttpCache ? 'expiry-cache check ' : 'ordinary-cache check ', { delay: 14 });
  await expect(page.locator('[data-tb="dk-math"]')).toBeVisible({ timeout: 10_000 });
  await page.locator('[data-tb="dk-math"]').click();
  const field = page.locator('[data-dl-mathedit] .lm-field');
  await expect(field).toBeVisible({ timeout: 15_000 });
  await page.touchscreen.tap((await field.boundingBox())!.x + 8, (await field.boundingBox())!.y + 8);
  await page.waitForTimeout(1800);
  const keyboardVisible = await page.locator('.mk').isVisible().catch(() => false);
  const inputMode = await page.locator('[data-dl-mathedit] .lm-input').getAttribute('inputmode').catch(() => null);
  const oldBundleStillRunning = await page.evaluate(oldApp => performance.getEntriesByType('resource').some(entry => new URL(entry.name).pathname.endsWith(`/${oldApp}`)), OLD_APP);
  const newBundleLoaded = await page.evaluate(newApp => performance.getEntriesByType('resource').some(entry => new URL(entry.name).pathname.endsWith(`/${newApp}`)), NEW_APP);
  let formulaAfterTouchKeys: string | null = null;
  if (keyboardVisible) {
    for (const name of ['x', 'Plus', '1']) {
      const key = page.locator(`.mk .mk-key[data-mk-key="${name}"]`).first();
      if (!await key.isVisible().catch(() => false)) continue;
      const keyBox = await key.boundingBox();
      if (!keyBox) continue;
      await page.touchscreen.tap(keyBox.x + keyBox.width / 2, keyBox.y + keyBox.height / 2);
    }
    formulaAfterTouchKeys = await page.frameLocator('.dl-frame').locator('.ol-mathchip[data-ol-mathediting]').getAttribute('data-ol-tex').catch(() => null);
  }
  await Promise.allSettled(responseBodyJobs);
  const result = {
    httpCacheDisabled: disableHttpCache,
    httpCacheTreatment: disableHttpCache ? 'CDP Network.clearBrowserCache + Network.setCacheDisabled(true); SW CacheStorage untouched' : 'ordinary browser HTTP cache',
    oldAppBundleStillRunning: oldBundleStillRunning,
    newAppBundleLoadedBeforeReload: newBundleLoaded,
    keyboardVisible,
    inputMode,
    formulaAfterTouchKeys,
    mathFieldVisible: await field.isVisible().catch(() => false),
    assetResponses: responses,
    assetFailures: requests,
    assetBodyDigests: bodyDigests,
    oldKeyboardExpectedSha256: OLD.keyboardSha256,
    oldKeyboardExactJavascriptBody: bodyDigests.some(item => item.basename === OLD_KEYBOARD && item.sha256 === OLD.keyboardSha256 && item.bodyRead),
    oldKeyboardSuccessfulJavascriptResponse: responses.some(item => item.basename === OLD_KEYBOARD && item.status === 200 && item.mime === 'javascript'),
  };
  // Close native editing through the GUI, save prose if the math field failed, and retain the
  // source for round-trip verification. A failed module import itself is diagnostic evidence.
  await page.keyboard.press('Escape').catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});
  await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30_000 });
  const sourceFile = path.join(PROJECTS_DIR, ...project.split('/'), 'slides', 'index.html');
  const source = readFileSync(sourceFile, 'utf8');
  const draftMarker = disableHttpCache ? 'expiry-cache check' : 'ordinary-cache check';
  const mathValues = mathSourceValues(source);
  const exactFormulaCount = mathValues.filter(value => value.replace(/\s/g, '') === 'x+1').length;
  Object.assign(result, {
    proseSaved: source.includes(draftMarker),
    mathSourceValues: mathValues,
    exactFormulaCount,
    formulaSaved: exactFormulaCount === 1 && !mathValues.some(value => value.length === 0),
  });
  checkpoint(disableHttpCache ? 'cache-disabled-module-attempt' : 'ordinary-cache-module-attempt', { project: project.split('/').at(-1), result });
  await cdp.detach();
  return result;
}

test('old touch tabs retain drafts through service-worker activation and load the exact old lazy keyboard module', async ({ browser, browserName }) => {
  requirePrivateEnvironment();
  test.setTimeout(350_000);
  test.skip(browserName !== 'chromium', 'The bounded service-worker/cache diagnostic uses Chromium CDP only.');
  const oldBuild = OLD;
  const newBuild = NEW;
  expect(oldBuild.appSha256).toBe(process.env.OVERLYX_EXPECTED_OLD_APP_SHA256);
  expect(newBuild.appSha256).toBe(process.env.OVERLYX_EXPECTED_NEW_APP_SHA256);
  mkdirSync(ROOT, { recursive: true });
  if (existsSync(READY) || existsSync(GO)) throw new Error('This run already has a readiness or GO marker; choose a new RUN without removing prior evidence.');
  if (existsSync(OUTPUT) || ['after-sw-activation', 'ordinary-cache-module-attempt', 'cache-disabled-module-attempt', 'new-reload-roundtrip-complete'].some(stage => existsSync(path.join(ROOT, `checkpoint-${RUN}-${stage}.json`)))) throw new Error('This run already has evidence; choose a new RUN without overwriting it.');

  const contextA = await newTouchContext(browser, { baseURL: BASE, viewport: VIEWPORT, deviceScaleFactor: 2, isMobile: true });
  const contextB = await newTouchContext(browser, { baseURL: BASE, viewport: VIEWPORT, deviceScaleFactor: 2, isMobile: true });
  try {
  const a = await contextA.newPage();
  const b = await contextB.newPage();
  a.setDefaultTimeout(15_000);
  b.setDefaultTimeout(15_000);
  const aProject = await createDeck(a, `sw-upgrade-a-${RUN}`);
  const bProject = await createDeck(b, `sw-upgrade-b-${RUN}`);
  const savedTitles = [aProject, bProject].map(project => {
    const saved = readFileSync(path.join(PROJECTS_DIR, ...project.split('/'), 'slides', 'index.html'), 'utf8');
    return { project: project.split('/').at(-1), hasSlide: /<section\b[^>]*class=["'][^"']*slide/.test(saved), hasStarterTitle: /<h1\b[^>]*>\s*\S/.test(saved) };
  });
  expect(savedTitles.every(item => item.hasSlide && item.hasStarterTitle)).toBe(true);
  await expect.poll(async () => {
    const [stateA, stateB] = await Promise.all([activeSwState(a), activeSwState(b)]);
    return [stateA, stateB].every(state => state.controllerPresent && state.registrationActive && state.oldKeyboardInSwCache);
  }, { timeout: 60_000, intervals: [500, 1000, 2000], message: 'Wait for each old-build page to be controlled by the installed worker and its pre-cached lazy keyboard chunk.' }).toBe(true);
  const beforeA = await activeSwState(a);
  const beforeB = await activeSwState(b);
  checkpoint('old-controlled-precondition', { oldBuild, newBuild, savedTitles, oldPageA: beforeA, oldPageB: beforeB });
  expect(beforeA.controllerPresent && beforeB.controllerPresent).toBe(true);
  expect(beforeA.registrationActive && beforeB.registrationActive).toBe(true);
  expect(beforeA.oldKeyboardInSwCache && beforeB.oldKeyboardInSwCache).toBe(true);
  expect(beforeA.oldKeyboardExecuted || beforeB.oldKeyboardExecuted).toBe(false);
  expect(beforeA.oldAuxExecuted || beforeB.oldAuxExecuted).toBe(false);
  expect(beforeA.oldAuxInSwCache && beforeB.oldAuxInSwCache).toBe(true);
  expect(beforeA.appBundleNames).toContain(OLD_APP);
  expect(beforeB.appBundleNames).toContain(OLD_APP);

  const ready = {
    run: RUN,
    purpose: 'ready-for-parent-to-switch-server-from-old-build-to-new-build',
    browser: browserName,
    browserVersion: browser.version(),
    viewport: VIEWPORT,
    touchEmulation: true,
    profileCount: 2,
    cacheIsolation: 'two independent browser contexts; same Chromium process and private origin',
    projectNames: [`${OWNER}/sw-upgrade-a-${RUN}`, `${OWNER}/sw-upgrade-b-${RUN}`],
    savedTitles,
    oldPublicAssets: oldBuild,
    newPublicAssets: newBuild,
    oldPageA: beforeA,
    oldPageB: beforeB,
    httpCacheDisabledForBaseline: false,
  };
  writeFileSync(READY, JSON.stringify(ready, null, 2) + '\n');
  await waitForParentGo();

  // A's newly created deck is saved. B now has a focused GUI text draft while the new build
  // replaces the service-worker shell; record whether the source autosaved before update.
  const draftB = await addUnsavedDraft(b, `upgrade-live-draft-${RUN}`);
  const [afterA, afterB] = await Promise.all([updateServiceWorker(a), updateServiceWorker(b)]);
  const draftAfterControllerChange = await b.frameLocator('.dl-frame').locator('body').evaluate((body, marker) => {
    const matches = Array.from(body.querySelectorAll('*')).filter(el => el.children.length === 0 && (el.textContent ?? '').includes(marker));
    return {
      matchingElements: matches.length,
      visibleMatchingElement: matches.some(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; }),
      matchingContentEditable: matches.some(el => !!el.closest('[contenteditable="true"]')),
      activeEditor: matches.some(el => { const edit = el.closest('[contenteditable="true"]'); return !!edit && (edit === document.activeElement || edit.contains(document.activeElement)); }),
    };
  }, `upgrade-live-draft-${RUN}`).catch(() => ({ matchingElements: 0, visibleMatchingElement: false, matchingContentEditable: false, activeEditor: false }));
  const draftSourceAfterControllerChange = readFileSync(path.join(PROJECTS_DIR, ...bProject.split('/'), 'slides', 'index.html'), 'utf8').includes(`upgrade-live-draft-${RUN}`);
  checkpoint('after-sw-activation', { oldBuild, newBuild, draftBBeforeUpdate: draftB, draftBAfterControllerChange: draftAfterControllerChange, draftSourceAfterControllerChange, afterControllerChangePageA: afterA, afterControllerChangePageB: afterB });
  expect(afterA.controllerPresent && afterB.controllerPresent).toBe(true);
  expect(afterA.registrationActive && afterB.registrationActive).toBe(true);
  expect(afterA.appBundleNames).toContain(OLD_APP);
  expect(afterB.appBundleNames).toContain(OLD_APP);
  expect(afterA.appBundleNames).not.toContain(NEW_APP);
  expect(afterB.appBundleNames).not.toContain(NEW_APP);
  expect(draftAfterControllerChange.visibleMatchingElement).toBe(true);
  expect(draftAfterControllerChange.matchingContentEditable).toBe(true);

  // Separate old, still-running realms: ordinary browser HTTP-cache attempt first, then an
  // explicit cache-disabled attempt. The latter only models expiry; it never alters SW CacheStorage.
  const ordinary = await observeKeyboardAttempt(a, contextA, aProject, false);
  const swCacheAfterOrdinaryAttempt = await activeSwState(a);
  const expiredHttpCache = await observeKeyboardAttempt(b, contextB, bProject, true);
  const sourceB = readFileSync(path.join(PROJECTS_DIR, ...bProject.split('/'), 'slides', 'index.html'), 'utf8');
  const sourceDraftSurvived = sourceB.includes(`upgrade-live-draft-${RUN}`);

  // A full navigation now loads the new main bundle from the new shell and proves normal recovery.
  await b.reload();
  await expect(b.frameLocator('.dl-frame').locator('section.slide').first()).toBeVisible({ timeout: 30_000 });
  const pageBReloadContainsDraft = (await b.frameLocator('.dl-frame').locator('section.slide').first().textContent())?.includes(`upgrade-live-draft-${RUN}`) ?? false;
  const afterReload = await activeSwState(b);
  const newBundleAfterReload = afterReload.appBundleNames.includes(NEW_APP);

  const result = {
    run: RUN,
    browser: browserName,
    browserVersion: browser.version(),
    touchEmulation: true,
    viewport: VIEWPORT,
    oldPublicAssets: oldBuild,
    newPublicAssets: newBuild,
    draftBBeforeUpdate: draftB,
    draftBAfterControllerChange: draftAfterControllerChange,
    draftSourceAfterControllerChange,
    afterControllerChangePageA: afterA,
    afterControllerChangePageB: afterB,
    ordinaryHttpCacheAttempt: ordinary,
    newSwStateAfterOrdinaryAttempt: swCacheAfterOrdinaryAttempt,
    cacheDisabledExpirySimulation: expiredHttpCache,
    pageBSourceStillContainsDraft: sourceDraftSurvived,
    newBundleAfterReload,
    afterNewReload: afterReload,
    strictOutcomeChecks: {
      ordinaryExactOldKeyboardJs: (ordinary as any).oldKeyboardExactJavascriptBody && (ordinary as any).oldKeyboardSuccessfulJavascriptResponse,
      expiryExactOldKeyboardJs: (expiredHttpCache as any).oldKeyboardExactJavascriptBody && (expiredHttpCache as any).oldKeyboardSuccessfulJavascriptResponse,
      ordinaryTouchFormula: (ordinary as any).keyboardVisible && (ordinary as any).formulaAfterTouchKeys === 'x+1' && (ordinary as any).formulaSaved,
      expiryTouchFormula: (expiredHttpCache as any).keyboardVisible && (expiredHttpCache as any).formulaAfterTouchKeys === 'x+1' && (expiredHttpCache as any).formulaSaved,
      oldAppStillRunningWithoutNewBundleLoad: (ordinary as any).oldAppBundleStillRunning && (expiredHttpCache as any).oldAppBundleStillRunning && !(ordinary as any).newAppBundleLoadedBeforeReload && !(expiredHttpCache as any).newAppBundleLoadedBeforeReload,
      visibleDraftRemainedEditable: draftAfterControllerChange.visibleMatchingElement && draftAfterControllerChange.matchingContentEditable,
      draftSourceSurvived: sourceDraftSurvived,
      newBundleAfterReload,
      pageBReloadContainsDraft,
    },
    assertionScope: 'strict: both profiles must load old keyboard JS by exact digest and save x+1; new controller activation preserves the live draft; old shell cache retention is permitted',
  };
  checkpoint('new-reload-roundtrip-complete', result);
  writeFileSync(OUTPUT, JSON.stringify(result, null, 2) + '\n');
  expect((ordinary as any).proseSaved).toBe(true);
  expect((expiredHttpCache as any).proseSaved).toBe(true);
  expect(sourceDraftSurvived).toBe(true);
  expect(newBundleAfterReload).toBe(true);
  expect((ordinary as any).oldKeyboardExactJavascriptBody && (ordinary as any).oldKeyboardSuccessfulJavascriptResponse).toBe(true);
  expect((expiredHttpCache as any).oldKeyboardExactJavascriptBody && (expiredHttpCache as any).oldKeyboardSuccessfulJavascriptResponse).toBe(true);
  expect((ordinary as any).oldAppBundleStillRunning).toBe(true);
  expect((expiredHttpCache as any).oldAppBundleStillRunning).toBe(true);
  expect((ordinary as any).newAppBundleLoadedBeforeReload).toBe(false);
  expect((expiredHttpCache as any).newAppBundleLoadedBeforeReload).toBe(false);
  expect((ordinary as any).keyboardVisible).toBe(true);
  expect((expiredHttpCache as any).keyboardVisible).toBe(true);
  expect((ordinary as any).formulaAfterTouchKeys).toBe('x+1');
  expect((expiredHttpCache as any).formulaAfterTouchKeys).toBe('x+1');
  expect((ordinary as any).formulaSaved).toBe(true);
  expect((expiredHttpCache as any).formulaSaved).toBe(true);
  expect(pageBReloadContainsDraft).toBe(true);
  expect(draftAfterControllerChange.visibleMatchingElement && draftAfterControllerChange.matchingContentEditable).toBe(true);
  } finally {
    await Promise.allSettled([contextA.close(), contextB.close()]);
  }
});
