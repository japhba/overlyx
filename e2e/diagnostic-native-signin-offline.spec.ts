/**
 * Diagnostic-only original-V7 regression probe: anonymous service-worker warm, GUI sign-in,
 * GUI deck edit/save, then Chromium offline reload. It logs no credential, cached user details,
 * request/response data, URL, or raw error text; authentication cache/localStorage are booleans only.
 */
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as Y from 'yjs';
import { login, PROJECTS_DIR, userCredentials } from './helpers';

const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const NAME = `native-signin-offline-${RUN}`;
const PROJECT = `luna1/${NAME}`;
const FILE = path.join(PROJECTS_DIR, 'luna1', NAME, 'slides', 'index.html');
const TITLE = 'Native sign-in offline canvas probe';
const frame = (page: Page) => page.frameLocator('.dl-frame');
const slides = (page: Page) => frame(page).locator('section.slide');

type State = {
  phase: string;
  controlled: boolean;
  apiCacheAvailable: boolean;
  authMeCached: boolean;
  cachedAuthMeIdentityPresent: boolean | null;
  projectsCached: boolean;
  localUserPresent: boolean;
  ui: 'canvas' | 'workspace' | 'login' | 'other';
  navigationIsReload: boolean;
  hashMatchesExpected: boolean;
  editorCount: number;
  frameCount: number;
  status: 'saved' | 'saving' | 'modified' | 'unsaved' | 'loading' | 'offline' | 'other' | 'none';
  documentNameBasename: string | null;
  homeVisible: boolean;
  indexedDbDocumentPresent: boolean;
  indexedDbContainsTitle: boolean;
  cachedTargetProjectPresent: boolean;
  /** The generic service-worker API cache is intentionally separate from the account-scoped cache below. */
  cachedDocumentMetaPresent: boolean;
  privateApiCacheAvailable: boolean;
  privateDocumentMetaCached: boolean;
  privateDeliverableLinkCached: boolean;
  privateDeliverablePageCached: boolean;
  privateApiCacheEntryCount: number;
  publicRuntimeCacheCount: number;
  publicRuntimeFileCount: number;
  failedEndpointCategories: Record<'deliverable-link' | 'meta' | 'runtime' | 'frame' | 'other', number>;
};

type FailedCategories = State['failedEndpointCategories'];

/** `true` means some HTTP response arrived; `false` means the unique uncached request rejected. */
async function publicConnectivityProbe(page: Page, nonce: string): Promise<boolean> {
  return page.evaluate(async probeNonce => {
    try {
      // The unique path has never been cached; the SW's /_ol/ cache-first branch misses it by
      // pathname before forwarding to the network. Do not inspect or retain the response body.
      const path = `/_ol/__connectivity-probe-${encodeURIComponent(probeNonce)}.js?nonce=${encodeURIComponent(probeNonce)}`;
      await fetch(path, { cache: 'no-store', credentials: 'omit' });
      return true;
    } catch { return false; }
  }, nonce);
}

async function localDocUpdates(page: Page): Promise<number[][] | null> {
  return page.evaluate(async projectId => {
    try {
      const dbName = `overlyx:${projectId}/slides/index.html`;
      const dbs = await (indexedDB as any).databases?.() as { name?: string }[] | undefined;
      if (!dbs?.some(db => db.name === dbName)) return null;
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(dbName);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      try {
        return await new Promise<number[][]>((resolve, reject) => {
          const tx = db.transaction('updates', 'readonly');
          const req = tx.objectStore('updates').getAll();
          req.onsuccess = () => resolve((req.result as Uint8Array[]).map(update => Array.from(new Uint8Array(update))));
          req.onerror = () => reject(req.error);
        });
      } finally { db.close(); }
    } catch { return null; }
  }, PROJECT);
}

async function safeState(page: Page, phase: string, failedEndpointCategories: FailedCategories): Promise<State> {
  const state = await page.evaluate(async ({ phaseName, expectedHash, projectId }) => {
    const cacheNames = await caches.keys().catch(() => [] as string[]);
    let apiCacheAvailable = cacheNames.includes('overlyx-api');
    let authMeCached = false, projectsCached = false, cachedTargetProjectPresent = false, cachedDocumentMetaPresent = false;
    let cachedAuthMeIdentityPresent: boolean | null = null;
    let cachedAuthUserId: number | undefined;
    if (apiCacheAvailable) {
      try {
        const cache = await caches.open('overlyx-api');
        const me = await cache.match('/api/auth/me');
        authMeCached = !!me;
        if (me) {
          try {
            const payload = await me.clone().json() as { user?: { id?: unknown } | null };
            cachedAuthMeIdentityPresent = !!payload.user;
            const id = payload.user?.id;
            if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) cachedAuthUserId = id;
          } catch { cachedAuthMeIdentityPresent = null; }
        }
        const projects = await cache.match('/api/projects');
        projectsCached = !!projects;
        cachedDocumentMetaPresent = !!(await cache.match(`/api/docs/${encodeURIComponent(projectId + '/slides/index.html')}/meta`));
        if (projects) {
          try {
            const payload = await projects.clone().json() as { projects?: { name?: string }[] };
            cachedTargetProjectPresent = !!payload.projects?.some(project => project.name === projectId);
          } catch { cachedTargetProjectPresent = false; }
        }
      } catch { apiCacheAvailable = false; }
    }
    let localUserId: number | undefined;
    try {
      const id = JSON.parse(localStorage.getItem('ol.user') ?? 'null')?.id;
      if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) localUserId = id;
    } catch { /* only a boolean is included in diagnostic output */ }
    const privateUserId = localUserId ?? cachedAuthUserId;
    const privateCacheName = privateUserId === undefined ? '' : `overlyx-api-user-${privateUserId}`;
    let privateApiCacheAvailable = false;
    let privateDocumentMetaCached = false, privateDeliverableLinkCached = false, privateDeliverablePageCached = false;
    let privateApiCacheEntryCount = 0;
    if (privateCacheName && cacheNames.includes(privateCacheName)) {
      try {
        const cache = await caches.open(privateCacheName), requests = await cache.keys();
        privateApiCacheAvailable = true;
        privateApiCacheEntryCount = requests.length;
        const docMetaPath = `/api/docs/${encodeURIComponent(projectId + '/slides/index.html')}/meta`;
        const deliverableLinkPath = `/api/projects/${encodeURIComponent(projectId)}/deliverable-link`;
        for (const request of requests) {
          const key = new URL(request.url);
          if (key.pathname === docMetaPath) privateDocumentMetaCached = true;
          if (key.pathname === deliverableLinkPath && key.searchParams.get('path') === 'slides/index.html') privateDeliverableLinkCached = true;
          if (key.pathname.startsWith('/ol-d/') && key.pathname.endsWith('/slides/index.html') && key.searchParams.get('ol') === 'edit') privateDeliverablePageCached = true;
        }
      } catch { privateApiCacheAvailable = false; }
    }
    const runtimeCaches = cacheNames.filter(name => name.startsWith('overlyx-runtime-'));
    let publicRuntimeFileCount = 0;
    for (const name of runtimeCaches) {
      try {
        const requests = await (await caches.open(name)).keys();
        publicRuntimeFileCount += requests.filter(request => /^\/_ol\/[A-Za-z0-9_./-]+\.js$/.test(new URL(request.url).pathname)).length;
      } catch { /* count only entries which can be safely inspected */ }
    }
    const hasFrame = !!document.querySelector('.dl-frame');
    const hasWorkspace = !!document.querySelector('.menubar');
    const hasLogin = !!document.querySelector('[data-password-login], input[placeholder="Username"]');
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    const editorCount = document.querySelectorAll('.dl-editor').length;
    const frameCount = document.querySelectorAll('.dl-frame').length;
    const rawStatus = document.querySelector('.dl-status')?.textContent?.trim().toLowerCase() ?? '';
    const status = rawStatus === 'saved' ? 'saved' : rawStatus === 'saving' ? 'saving' : rawStatus === 'modified' ? 'modified' : rawStatus === 'unsaved' ? 'unsaved' : rawStatus.includes('load') ? 'loading' : rawStatus.includes('offline') ? 'offline' : rawStatus ? 'other' : 'none';
    const fullName = document.querySelector('.mt-name')?.textContent?.trim() ?? '';
    const documentNameBasename = fullName ? fullName.split(/[\\/]/).pop()!.slice(0, 100) : null;
    return {
      phase: phaseName,
      controlled: !!navigator.serviceWorker?.controller,
      apiCacheAvailable,
      authMeCached,
      cachedAuthMeIdentityPresent,
      projectsCached,
      localUserPresent: localStorage.getItem('ol.user') !== null,
      ui: hasFrame ? 'canvas' : hasWorkspace ? 'workspace' : hasLogin ? 'login' : 'other',
      navigationIsReload: nav?.type === 'reload',
      hashMatchesExpected: location.hash.includes(expectedHash),
      editorCount,
      frameCount,
      status,
      documentNameBasename,
      homeVisible: !!document.querySelector('.menubar .brand'),
      indexedDbDocumentPresent: false,
      indexedDbContainsTitle: false,
      cachedTargetProjectPresent,
      cachedDocumentMetaPresent,
      privateApiCacheAvailable,
      privateDocumentMetaCached,
      privateDeliverableLinkCached,
      privateDeliverablePageCached,
      privateApiCacheEntryCount,
      publicRuntimeCacheCount: runtimeCaches.length,
      publicRuntimeFileCount,
    };
  }, { phaseName: phase, expectedHash: `${PROJECT}/slides/index.html`, projectId: PROJECT });
  const updates = await localDocUpdates(page);
  let indexedDbContainsTitle = false;
  if (updates) {
    const doc = new Y.Doc();
    try {
      for (const update of updates) Y.applyUpdate(doc, new Uint8Array(update));
      indexedDbContainsTitle = doc.getText('html').toString().includes(TITLE);
    } catch { indexedDbContainsTitle = false; }
    finally { doc.destroy(); }
  }
  return {
    ...state,
    indexedDbDocumentPresent: updates !== null,
    indexedDbContainsTitle,
    failedEndpointCategories: { ...failedEndpointCategories },
  };
}

async function saveEvidence(info: TestInfo, states: State[], final: State | null, extras: {
  controllerReady: boolean; offlineReloadResolved: boolean; offlineUiSettled: boolean; sourceReadback: boolean;
  onlineCanvasRecoveredWithoutReload: boolean; onlineTitleVisibleWithoutReload: boolean;
  offlineRenderedTitleVerified: boolean; offlineRenderedMathVerified: boolean; offlineReadbackStayedOffline: boolean;
  publicConnectivityProbeRespondedOnline: boolean; offlineConnectivityProbeBlockedBeforeContent: boolean;
  offlineConnectivityProbeBlockedAfterContent: boolean; navigatorOnLineBeforeContent: boolean | null;
  navigatorOnLineAfterContent: boolean | null; offlineMathFailureStage: string; offlineTitleFailureStage: string;
  onlineStateWithoutReload: State | null;
}): Promise<void> {
  const out = info.outputPath('native-signin-offline-state.json');
  const report = JSON.stringify({ diagnosticOnly: true, browser: info.project.name, viewport: { width: 1400, height: 900 }, states, final, ...extras }, null, 2);
  writeFileSync(out, report);
  await info.attach('sanitized-native-signin-offline-state', { path: out, contentType: 'application/json' });
}

test('diagnostic only: native GUI sign-in then offline reload retains the signed-in slide canvas', async ({ page, context, browserName }, info) => {
  test.skip(browserName !== 'chromium', 'Offline emulation is tested in Chromium only for this probe.');
  test.setTimeout(150_000);
  page.setDefaultTimeout(12_000);
  const states: State[] = [];
  let controllerReady = false;
  let offlineReloadResolved = false;
  let offlineUiSettled = false;
  let sourceReadback = false;
  let onlineCanvasRecoveredWithoutReload = false;
  let onlineTitleVisibleWithoutReload = false;
  let offlineRenderedTitleVerified = false;
  let offlineRenderedMathVerified = false;
  let offlineReadbackStayedOffline = false;
  let publicConnectivityProbeRespondedOnline = false;
  let offlineConnectivityProbeBlockedBeforeContent = false;
  let offlineConnectivityProbeBlockedAfterContent = false;
  let navigatorOnLineBeforeContent: boolean | null = null;
  let navigatorOnLineAfterContent: boolean | null = null;
  let offlineMathFailureStage = 'not-run';
  let offlineTitleFailureStage = 'not-run';
  let onlineStateWithoutReload: State | null = null;
  let final: State | null = null;
  const failedEndpointCategories: FailedCategories = { 'deliverable-link': 0, meta: 0, runtime: 0, frame: 0, other: 0 };
  const categorize = (url: string, resourceType?: string, isFrame = false): keyof FailedCategories => {
    const pathname = new URL(url).pathname;
    if (pathname.includes('/deliverable-link')) return 'deliverable-link';
    if (pathname.endsWith('/meta')) return 'meta';
    if (pathname.startsWith('/_ol/')) return 'runtime';
    if (pathname.startsWith('/ol-d/') || isFrame || resourceType === 'document') return 'frame';
    return 'other';
  };

  try {
    page.on('requestfailed', request => {
      let isFrame = false;
      try { isFrame = request.frame() !== page.mainFrame(); } catch { /* only safe category is retained */ }
      failedEndpointCategories[categorize(request.url(), request.resourceType(), isFrame)]++;
    });
    page.on('response', response => {
      if (response.status() >= 400 && new URL(response.url()).pathname.startsWith('/api/')) {
        failedEndpointCategories[categorize(response.url())]++;
      }
    });
    // A new Playwright context gives this test an empty origin/service-worker cache.
    await page.goto('/');
    await page.waitForFunction(async () => {
      if (!('serviceWorker' in navigator)) return false;
      const reg = await navigator.serviceWorker.ready;
      return !!reg.active && !!navigator.serviceWorker.controller;
    }, null, { timeout: 30_000 });
    controllerReady = true;
    await page.waitForFunction(async () => {
      try { return !!(await (await caches.open('overlyx-api')).match('/api/auth/me')); }
      catch { return false; }
    }, null, { timeout: 20_000 });
    states.push(await safeState(page, 'landing-after-service-worker-control-before-sign-in', failedEndpointCategories));

    // This uses the normal username/password form and clicks Sign in; no API login shortcut.
    await login(page, userCredentials('luna1'), { ui: 'default' });
    await expect(page.locator('.menubar')).toBeVisible();
    await expect(page.locator('[data-new-project]')).toBeVisible();
    states.push(await safeState(page, 'after-native-sign-in-before-new-deck', failedEndpointCategories));

    await page.locator('[data-new-project]').click();
    await page.locator('[data-new-kind="deck"]').click();
    await page.locator('[data-new-name]').fill(NAME);
    await page.locator('[data-new-create]').click();
    await expect(page).toHaveURL(new RegExp(`#/${PROJECT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/slides/index\\.html$`));
    await expect(slides(page)).toHaveCount(2);
    const title = slides(page).first().locator('h1');
    await title.dblclick();
    await expect(title).toHaveAttribute('contenteditable', 'true');
    await expect.poll(() => title.evaluate(el => document.activeElement === el)).toBe(true);
    await page.keyboard.press('Control+a');
    await page.keyboard.type(TITLE);
    await page.keyboard.press('Escape');
    await expect(title).toHaveText(TITLE);
    await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 20_000 });
    await expect.poll(() => readFileSync(FILE, 'utf8'), { timeout: 20_000 }).toContain(TITLE);
    sourceReadback = readFileSync(FILE, 'utf8').includes(TITLE);
    states.push(await safeState(page, 'deck-saved-online-before-offline-reload', failedEndpointCategories));
    publicConnectivityProbeRespondedOnline = await publicConnectivityProbe(page, `${RUN}-online`);

    await context.setOffline(true);
    let uiWaitFailed = false;
    try {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 25_000 });
      offlineReloadResolved = true;
      await page.waitForFunction(() => !!document.querySelector('.dl-frame') || !!document.querySelector('[data-password-login], input[placeholder="Username"]'), null, { timeout: 30_000 });
      offlineUiSettled = true;
    } catch { uiWaitFailed = true; /* record only outcome booleans; never include raw navigation/error text */ }
    final = await safeState(page, 'after-offline-hard-reload', failedEndpointCategories);
    states.push(final);

    // Chromium's navigator.onLine can stay true under this CDP offline emulation. Record it, but
    // use a unique public request that cannot hit Cache Storage to establish actual transport.
    navigatorOnLineBeforeContent = await page.evaluate(() => navigator.onLine).catch(() => null);
    offlineConnectivityProbeBlockedBeforeContent = !(await publicConnectivityProbe(page, `${RUN}-offline-before`));
    // Verify content while the browser is still offline: a frame element alone is not proof that
    // its slide document rendered. The editor canvas shows one slide at a time; use the real rail
    // thumbnails to move to slide 2, verify actual MathJax glyph paths, then return to slide 1/title.
    if (final.frameCount > 0) {
      try {
        offlineMathFailureStage = 'rail-thumbnail-list';
        const thumbnails = page.frameLocator('.dl-railframe').locator('section.slide');
        await expect(thumbnails).toHaveCount(2, { timeout: 12_000 });
        offlineMathFailureStage = 'click-slide-2-thumbnail';
        await thumbnails.nth(1).click();
        const secondSlide = slides(page).nth(1);
        offlineMathFailureStage = 'slide-2-visible';
        await expect(secondSlide).toBeVisible({ timeout: 8_000 });
        const formula = secondSlide.locator('mjx-container [data-mml-node="math"]').first();
        offlineMathFailureStage = 'math-semantics-visible';
        await expect(formula).toBeVisible({ timeout: 12_000 });
        offlineMathFailureStage = 'math-svg-glyph-paths';
        await expect.poll(() => secondSlide.locator('mjx-container svg path[d]').count(), { timeout: 12_000 }).toBeGreaterThan(0);
        offlineRenderedMathVerified = await formula.isVisible() && await secondSlide.locator('mjx-container svg path[d]').count() > 0;
        offlineMathFailureStage = offlineRenderedMathVerified ? 'verified' : 'verification-readback-false';
      } catch { offlineRenderedMathVerified = false; }
      try {
        offlineTitleFailureStage = 'click-slide-1-thumbnail';
        const thumbnails = page.frameLocator('.dl-railframe').locator('section.slide');
        await thumbnails.first().click();
        const firstTitle = slides(page).first().locator('h1');
        offlineTitleFailureStage = 'slide-1-title-visible';
        await expect(firstTitle).toBeVisible({ timeout: 8_000 });
        offlineTitleFailureStage = 'slide-1-title-text';
        await expect(firstTitle).toHaveText(TITLE, { timeout: 8_000 });
        offlineRenderedTitleVerified = await firstTitle.isVisible() && (await firstTitle.textContent())?.trim() === TITLE;
        offlineTitleFailureStage = offlineRenderedTitleVerified ? 'verified' : 'verification-readback-false';
      } catch { offlineRenderedTitleVerified = false; }
    }
    navigatorOnLineAfterContent = await page.evaluate(() => navigator.onLine).catch(() => null);
    offlineConnectivityProbeBlockedAfterContent = !(await publicConnectivityProbe(page, `${RUN}-offline-after`));
    offlineReadbackStayedOffline = offlineConnectivityProbeBlockedBeforeContent && offlineConnectivityProbeBlockedAfterContent;

    // Return online without reloading: record whether this route recovers without a retry.
    await context.setOffline(false);
    try {
      await page.waitForSelector('.dl-frame', { timeout: 7_000 });
      onlineCanvasRecoveredWithoutReload = true;
      onlineTitleVisibleWithoutReload = await slides(page).first().locator('h1').textContent().then(s => s?.trim() === TITLE).catch(() => false);
    } catch { /* outcome booleans only */ }
    onlineStateWithoutReload = await safeState(page, 'after-network-restored-without-reload', failedEndpointCategories).catch(() => null);

    // Expected product behavior: the offline shell restores the authenticated user and its local slide.
    // If original V7 instead presents sign-in, this deliberately fails as an observed product bug.
    expect(offlineReloadResolved, 'the service worker should serve the cached app shell offline').toBe(true);
    expect(offlineUiSettled && !uiWaitFailed, 'offline reload should settle into an app state').toBe(true);
    expect(final.ui, 'offline reload should reopen the slide canvas, not the login form').toBe('canvas');
    expect(final.cachedAuthMeIdentityPresent, 'cached auth/me should represent a signed-in identity').toBe(true);
    expect(final.localUserPresent, 'the offline bootstrap should retain the signed-in local user').toBe(true);
    expect(publicConnectivityProbeRespondedOnline, 'the unique public probe can reach an HTTP response before offline mode').toBe(true);
    expect(offlineReadbackStayedOffline, 'rail navigation and rendered-content checks occurred with network disabled').toBe(true);
    expect(offlineRenderedTitleVerified, 'the offline slide document rendered the saved title before connectivity returned').toBe(true);
    expect(offlineRenderedMathVerified, 'the offline second slide rendered its starter formula as MathJax SVG before connectivity returned').toBe(true);
    await expect(slides(page).first().locator('h1')).toHaveText(TITLE, { timeout: 10_000 });
    expect(readFileSync(FILE, 'utf8')).toContain(TITLE);
  } finally {
    if (!final) final = await safeState(page, 'final-state-after-probe-or-failure', failedEndpointCategories).catch(() => null);
    await saveEvidence(info, states, final, { controllerReady, offlineReloadResolved, offlineUiSettled, sourceReadback, onlineCanvasRecoveredWithoutReload, onlineTitleVisibleWithoutReload, offlineRenderedTitleVerified, offlineRenderedMathVerified, offlineReadbackStayedOffline, publicConnectivityProbeRespondedOnline, offlineConnectivityProbeBlockedBeforeContent, offlineConnectivityProbeBlockedAfterContent, navigatorOnLineBeforeContent, navigatorOnLineAfterContent, offlineMathFailureStage, offlineTitleFailureStage, onlineStateWithoutReload });
    await context.setOffline(false).catch(() => {});
  }
});
