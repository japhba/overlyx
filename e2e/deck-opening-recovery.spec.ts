/** GUI regression for opening a private editable deck after a transient deliverable-link failure. */
import { test, expect, type Page, type Request } from '@playwright/test';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { login, userCredentials, PROJECTS_DIR } from './helpers';
import { classifyOpeningFailures, type EventSourceClose as ClassifiedEventSourceClose, type OpeningFailure } from './opening-recovery-failures';

const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const USER = process.env.OVERLYX_LINK_RECOVERY_USER ?? process.env.OVERLYX_BETA_DECK_USER ?? 'luna1';
const TARGET_TITLE = 'Editable deck after link recovery';
const MARKER = 'Recovery remains editable after reconnect.';
const createdProjects: string[] = [];
const REQUIRED_ENV = ['OVERLYX_E2E_BASE', 'OVERLYX_PROJECTS_DIR', 'OVERLYX_E2E_CREDENTIALS'] as const;

function requirePortableEnvironment(): void {
  const missing = REQUIRED_ENV.filter(key => !process.env[key]);
  if (missing.length) test.skip(true, `Set the isolated e2e environment (${missing.join(', ')}) before creating private fixture projects.`);
}

test.afterAll(() => {
  for (const project of createdProjects) rmSync(path.join(PROJECTS_DIR, project), { recursive: true, force: true });
});

type Injection = 'transport' | 'forbidden';
type HitTargetCategory = 'retry' | 'files-drawer' | 'other' | 'none';
type FailureDestination = 'public-runtime' | 'api-metadata' | 'private-deliverable' | 'landing-demo-media' | 'static' | 'sse' | 'ws' | 'other';
type WorkflowPhase = 'before-login' | 'login-done' | 'new-deck-created' | 'panel' | 'recovered' | 'titleSaved' | 'proseSaved' | 'reload';
type RequestProfile = {
  id: number;
  at: number;
  destination: FailureDestination;
  resourceType: string;
  protocol: 'http' | 'data' | 'blob' | 'other';
  mode: 'edit' | 'thumb' | 'present' | 'other';
  frame: 'main-frame' | 'child-frame' | 'non-navigation' | 'unknown';
  workflowPhase: WorkflowPhase;
  publicAsset: string | null;
};
type EventSourceFailure = OpeningFailure & { workflowPhase: WorkflowPhase };
type EventSourceClose = ClassifiedEventSourceClose & { closedCount: number; workflowPhase: WorkflowPhase };
type PrivateTelemetry = { startedAt: number; failures: OpeningFailure[]; eventSourceFailures: EventSourceFailure[]; eventSourceCloses: EventSourceClose[] };
type Signals = {
  pageErrors: number;
  unexpectedConsoleErrors: number;
  expectedTransportConsoleErrors: number;
  expectedForbiddenConsoleErrors: number;
  targetTransportFailures: number;
  unexpectedTargetFailures: number;
  unrelatedRequestFailures: number;
  unrelatedFailureBuckets: Record<string, number>;
  expectedLifecycleRequestFailures: number;
  classifiedRequestFailureTotal: number;
  unexpectedRequestFailures: number;
  expectedRequestFailureClasses: { demoMedia: number; projectEvents: number };
  classifyRequestFailures?: () => void;
  unrelatedHttpErrorResponses: number;
  targetResponseStatuses: number[];
  phases: { label: string; requestCount: number; injectedFailureCount: number; responseStatuses: number[] }[];
  phoneRetry?: {
    viewport: { width: number; height: number };
    box: { x: number; y: number; width: number; height: number } | null;
    hitTarget: HitTargetCategory;
    openingState: string | null;
  };
  reloadWindow?: { durationMs: number; pendingAtStart: number };
  beginExplicitReload?: () => void;
  endExplicitReload?: () => void;
  workflowPhases: { phase: WorkflowPhase; atMs: number }[];
  markWorkflowPhase: (phase: WorkflowPhase) => void;
  eventSourceCloseEvidence?: {
    closedCount: number;
    closures: { endpoint: 'project-events' | 'other'; atMs: number; closedCount: number; workflowPhase: WorkflowPhase; matchedFailure: null | { errorCode: string; deltaMs: number; workflowPhase: WorkflowPhase } }[];
  };
};

const signalsByPage = new WeakMap<Page, Signals>();
const privateTelemetryByPage = new WeakMap<Page, PrivateTelemetry>();

function watchFailureSignals(page: Page, pathForProject: string): Promise<Signals> {
  const startedAt = Date.now();
  let workflowPhase: WorkflowPhase = 'before-login';
  const workflowPhases: Signals['workflowPhases'] = [];
  const markWorkflowPhase: Signals['markWorkflowPhase'] = phase => {
    workflowPhase = phase;
    workflowPhases.push({ phase, atMs: Date.now() - startedAt });
  };
  const signals: Signals = {
    pageErrors: 0,
    unexpectedConsoleErrors: 0,
    expectedTransportConsoleErrors: 0,
    expectedForbiddenConsoleErrors: 0,
    targetTransportFailures: 0,
    unexpectedTargetFailures: 0,
    unrelatedRequestFailures: 0,
    unrelatedFailureBuckets: {},
    expectedLifecycleRequestFailures: 0,
    classifiedRequestFailureTotal: 0,
    unexpectedRequestFailures: 0,
    expectedRequestFailureClasses: { demoMedia: 0, projectEvents: 0 },
    unrelatedHttpErrorResponses: 0,
    targetResponseStatuses: [],
    phases: [],
    workflowPhases,
    markWorkflowPhase,
  };
  let nextRequestId = 0;
  let reloadStartedAt: number | undefined;
  let reloadEndedAt: number | undefined;
  const requestIds = new WeakMap<Request, number>();
  const requestStarts = new WeakMap<Request, RequestProfile>();
  const pendingRequests = new Map<number, RequestProfile>();
  const privateTelemetry: PrivateTelemetry = { startedAt, failures: [], eventSourceFailures: [], eventSourceCloses: [] };
  privateTelemetryByPage.set(page, privateTelemetry);
  signals.classifyRequestFailures = () => {
    const classification = classifyOpeningFailures(process.env.OVERLYX_E2E_BASE ?? '', privateTelemetry.failures, privateTelemetry.eventSourceCloses);
    signals.expectedLifecycleRequestFailures = classification.expectedLifecycle;
    signals.classifiedRequestFailureTotal = classification.total;
    signals.unexpectedRequestFailures = classification.unexpected + Math.abs(signals.unrelatedRequestFailures - classification.total);
    signals.expectedRequestFailureClasses = {
      demoMedia: classification.expectedDemoMedia,
      projectEvents: classification.expectedProjectEvents,
    };
  };
  let pendingBeforeReload = new Set<number>();
  let closedEventSourceCount = 0;
  const eventSourceEndpoint = (rawUrl: string): EventSourceClose['endpoint'] => {
    try { return /^\/api\/projects\/[^/]+\/events$/.test(new URL(rawUrl).pathname) ? 'project-events' : 'other'; }
    catch { return 'other'; }
  };
  const profile = (request: Request, id: number, at: number): RequestProfile => {
    const rawUrl = request.url();
    let url: URL;
    try { url = new URL(rawUrl); } catch { return { id, at, destination: 'other', resourceType: request.resourceType(), protocol: 'other', mode: 'other', frame: 'unknown', workflowPhase, publicAsset: null }; }
    const resourceType = request.resourceType();
    let destination: FailureDestination = 'other';
    let publicAsset: string | null = null;
    let protocol: RequestProfile['protocol'] = 'other';
    let mode: RequestProfile['mode'] = 'other';
    let frame: RequestProfile['frame'] = 'non-navigation';
    if (url.protocol === 'http:' || url.protocol === 'https:') protocol = 'http';
    else if (url.protocol === 'data:') protocol = 'data';
    else if (url.protocol === 'blob:') protocol = 'blob';
    const demo = url.pathname.match(/^\/landing\/(wysiwyg|tex|slides|drawing|collab|vscode)-(light|dark)\.(webm|mp4)$/);
    if (demo && resourceType === 'media') {
      destination = 'landing-demo-media';
      publicAsset = `${demo[1]}-${demo[2]}-${demo[3]}`;
    }
    else if (url.protocol === 'ws:' || url.protocol === 'wss:' || resourceType === 'websocket') destination = 'ws';
    else if (resourceType === 'eventsource') destination = 'sse';
    else if (url.pathname.startsWith('/ol-d/')) destination = 'private-deliverable';
    else if (url.pathname.startsWith('/_ol/')) destination = 'public-runtime';
    else if (/^\/api\/projects\/[^/]+\/deliverable-(?:link|file|asset)(?:\/|$)/.test(url.pathname)) destination = 'private-deliverable';
    else if (url.pathname.startsWith('/api/')) destination = 'api-metadata';
    else if (url.pathname.startsWith('/assets/') || /\.(?:css|js|mjs|map|woff2?|ttf|otf|png|jpe?g|svg|ico)$/i.test(url.pathname)) destination = 'static';
    const rawMode = url.searchParams.get('ol');
    if (rawMode === 'edit' || rawMode === 'thumb' || rawMode === 'present') mode = rawMode;
    if (request.isNavigationRequest()) {
      try { frame = request.frame() === page.mainFrame() ? 'main-frame' : 'child-frame'; }
      catch { frame = 'unknown'; }
    }
    return { id, at, destination, resourceType, protocol, mode, frame, workflowPhase, publicAsset };
  };
  const failureCode = (request: Request): string => {
    const value = request.failure()?.errorText ?? '';
    return value.match(/net::(ERR_[A-Z0-9_]+)/)?.[1] ?? 'other';
  };
  const recordUnrelatedFailure = (request: Request) => {
    const info = requestStarts.get(request);
    const at = Date.now();
    let phase = 'before-reload';
    if (info && pendingBeforeReload.has(info.id)) phase = reloadEndedAt !== undefined && at > reloadEndedAt ? 'pending-before-reload-failed-after' : 'pending-before-reload-failed-during';
    else if (reloadStartedAt !== undefined && at >= reloadStartedAt && (reloadEndedAt === undefined || at <= reloadEndedAt)) phase = 'during-reload';
    else if (reloadEndedAt !== undefined && at > reloadEndedAt) phase = 'after-reload';
    const fallback = info ?? profile(request, -1, at);
    const bucket = `${fallback.destination}|${fallback.publicAsset ?? 'unlisted'}|${fallback.resourceType}|${fallback.protocol}|${fallback.mode}|${fallback.frame}|${failureCode(request)}|${fallback.workflowPhase}|${workflowPhase}|${phase}`;
    signals.unrelatedFailureBuckets[bucket] = (signals.unrelatedFailureBuckets[bucket] ?? 0) + 1;
  };
  signalsByPage.set(page, signals);
  page.on('request', request => {
    const id = ++nextRequestId;
    const info = profile(request, id, Date.now());
    requestIds.set(request, id);
    requestStarts.set(request, info);
    pendingRequests.set(id, info);
  });
  page.on('requestfinished', request => {
    const id = requestIds.get(request);
    if (id !== undefined) pendingRequests.delete(id);
  });
  page.on('pageerror', () => { signals.pageErrors++; });
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (text === 'Failed to load resource: net::ERR_INTERNET_DISCONNECTED') signals.expectedTransportConsoleErrors++;
    else if (text === 'Failed to load resource: the server responded with a status of 403 (Forbidden)') signals.expectedForbiddenConsoleErrors++;
    else signals.unexpectedConsoleErrors++;
  });
  page.on('requestfailed', request => {
    const requestPath = new URL(request.url()).pathname;
    if (requestPath === pathForProject && request.failure()?.errorText === 'net::ERR_INTERNET_DISCONNECTED') signals.targetTransportFailures++;
    else if (requestPath === pathForProject) signals.unexpectedTargetFailures++;
    else {
      signals.unrelatedRequestFailures++;
      recordUnrelatedFailure(request);
      const failedAt = Date.now();
      const requestId = requestIds.get(request) ?? ++nextRequestId;
      const info = requestStarts.get(request) ?? profile(request, requestId, failedAt);
      const failure: OpeningFailure = {
        id: requestId,
        url: request.url(),
        errorCode: failureCode(request),
        resourceType: request.resourceType(),
        protocol: info.protocol,
        destination: info.destination,
        startedAt: info.at,
        failedAt,
        startPhase: info.workflowPhase,
        failurePhase: workflowPhase,
      };
      privateTelemetry.failures.push(failure);
      if (request.resourceType() === 'eventsource') privateTelemetry.eventSourceFailures.push({ ...failure, workflowPhase });
    }
    const id = requestIds.get(request);
    if (id !== undefined) pendingRequests.delete(id);
  });
  page.on('response', response => {
    if (new URL(response.url()).pathname === pathForProject) signals.targetResponseStatuses.push(response.status());
    else if (response.status() >= 400) signals.unrelatedHttpErrorResponses++;
  });
  signals.beginExplicitReload = () => {
    signals.markWorkflowPhase('reload');
    reloadStartedAt = Date.now();
    pendingBeforeReload = new Set(pendingRequests.keys());
    signals.reloadWindow = { durationMs: 0, pendingAtStart: pendingBeforeReload.size };
  };
  signals.endExplicitReload = () => {
    reloadEndedAt = Date.now();
    if (signals.reloadWindow) signals.reloadWindow.durationMs = reloadEndedAt - (reloadStartedAt ?? reloadEndedAt);
  };
  return (async () => {
    await page.exposeBinding('__olE2eEventSourceClosed', (source, detail: { url?: unknown; at?: unknown }) => {
      if (typeof detail?.url !== 'string' || typeof detail?.at !== 'number' || !Number.isFinite(detail.at)) return;
      const parentMainRealm = source.frame === page.mainFrame();
      if (!parentMainRealm) return;
      privateTelemetry.eventSourceCloses.push({ url: detail.url, at: detail.at, closedCount: ++closedEventSourceCount, endpoint: eventSourceEndpoint(detail.url), parentMainRealm, workflowPhase });
    });
    await page.addInitScript(() => {
      if (window.top !== window) return;
      const bridge = (window as Window & { __olE2eEventSourceClosed?: (detail: { url: string; at: number }) => void }).__olE2eEventSourceClosed;
      const original = EventSource.prototype.close;
      EventSource.prototype.close = function (...args: []): void {
        try { bridge?.({ url: String(this.url), at: Date.now() }); } catch { /* diagnostic only */ }
        return original.apply(this, args);
      };
    });
    return signals;
  })();
}

async function attachSafeSignals(page: Page, signals: Signals): Promise<void> {
  signals.classifyRequestFailures?.();
  const telemetry = privateTelemetryByPage.get(page);
  if (telemetry) {
    const classification = classifyOpeningFailures(process.env.OVERLYX_E2E_BASE ?? '', telemetry.failures, telemetry.eventSourceCloses);
    const pairedFailures = new Map(classification.projectEventsPairs.map(pair => [pair.closeIndex, telemetry.failures.find(failure => failure.id === pair.failureId)]));
    signals.eventSourceCloseEvidence = {
      closedCount: telemetry.eventSourceCloses.length,
      closures: telemetry.eventSourceCloses.map((close, closeIndex) => {
        const match = pairedFailures.get(closeIndex);
        return {
          endpoint: close.endpoint,
          atMs: Math.round(close.at - telemetry.startedAt),
          closedCount: close.closedCount,
          workflowPhase: close.workflowPhase,
          matchedFailure: match ? { errorCode: match.errorCode, deltaMs: Math.round(match.failedAt - close.at), workflowPhase: match.failurePhase as WorkflowPhase } : null,
        };
      }),
    };
  }
  // Keep the evidence useful without serializing request URLs, response bodies, or credentials.
  await test.info().attach('deliverable-link-phases.json', {
    body: Buffer.from(JSON.stringify({
      phases: signals.phases,
      workflowPhases: signals.workflowPhases,
      ...(signals.eventSourceCloseEvidence ? { eventSourceCloseEvidence: signals.eventSourceCloseEvidence } : {}),
      ...(signals.phoneRetry ? { phoneRetry: signals.phoneRetry } : {}),
      counts: {
        pageErrors: signals.pageErrors,
        unexpectedConsoleErrors: signals.unexpectedConsoleErrors,
        expectedTransportConsoleErrors: signals.expectedTransportConsoleErrors,
        expectedForbiddenConsoleErrors: signals.expectedForbiddenConsoleErrors,
        targetTransportFailures: signals.targetTransportFailures,
        unexpectedTargetFailures: signals.unexpectedTargetFailures,
        unrelatedRequestFailures: signals.unrelatedRequestFailures,
        unrelatedFailureBuckets: signals.unrelatedFailureBuckets,
        expectedLifecycleRequestFailures: signals.expectedLifecycleRequestFailures,
        classifiedRequestFailureTotal: signals.classifiedRequestFailureTotal,
        expectedRequestFailureClasses: signals.expectedRequestFailureClasses,
        unexpectedRequestFailures: signals.unexpectedRequestFailures,
        unrelatedHttpErrorResponses: signals.unrelatedHttpErrorResponses,
      },
      ...(signals.reloadWindow ? { reloadWindow: signals.reloadWindow } : {}),
    }, null, 2)),
    contentType: 'application/json',
  });
}

test.afterEach(async ({ page }) => {
  const signals = signalsByPage.get(page);
  if (signals) await attachSafeSignals(page, signals);
});

async function createPrivateDeck(page: Page, name: string, signals: Signals): Promise<{ project: string; file: string }> {
  const project = `${USER}/${name}`;
  const file = path.join(PROJECTS_DIR, USER, name, 'slides', 'index.html');
  createdProjects.push(project);
  signals.markWorkflowPhase('before-login');
  await login(page, userCredentials(USER), { ui: 'default' });
  signals.markWorkflowPhase('login-done');
  await page.locator('[data-new-project]').click();
  await page.locator('[data-new-kind="deck"]').click();
  await page.locator('[data-new-name]').fill(name);
  await page.locator('[data-new-create]').click();
  signals.markWorkflowPhase('new-deck-created');
  return { project, file };
}

function failTargetLink(page: Page, project: string, injection: Injection) {
  const targetPath = `/api/projects/${encodeURIComponent(project)}/deliverable-link`;
  let intercepted = 0;
  let injected = 0;
  let inFlight = 0;
  let released = false;
  const routeReady = page.route('**/api/projects/**/deliverable-link*', async route => {
    if (new URL(route.request().url()).pathname !== targetPath) { await route.continue(); return; }
    intercepted++;
    inFlight++;
    try {
      // Hold the whole target request class in the injected failure mode, including any
      // independent warm-up request; none may win a race and open the canvas behind the panel.
      if (!released && injection === 'transport') {
        injected++;
        await route.abort('internetdisconnected');
        return;
      }
      if (!released && injection === 'forbidden') {
        injected++;
        await route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"forbidden"}' });
        return;
      }
      await route.continue();
    } finally { inFlight--; }
  });
  return {
    targetPath,
    routeReady,
    count: () => intercepted,
    injectedCount: () => injected,
    inFlight: () => inFlight,
    release: () => { released = true; },
  };
}

async function editAndVerify(page: Page, file: string, signals: Signals): Promise<void> {
  const slides = page.frameLocator('.dl-frame').locator('section.slide');
  const heading = slides.first().locator('h1');
  await expect(heading).toBeVisible({ timeout: 30_000 });
  await heading.dblclick();
  await page.keyboard.press('Control+a');
  await page.keyboard.type(TARGET_TITLE);
  await page.keyboard.press('Escape');
  await expect(heading).toHaveText(TARGET_TITLE);
  await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 20_000 });
  await expect.poll(() => readFileSync(file, 'utf8'), { timeout: 20_000 }).toContain(TARGET_TITLE);
  signals.markWorkflowPhase('titleSaved');

  // Prove a new canvas action still works after recovery, then reload from the saved source.
  const body = slides.first().locator('p').first();
  await body.dblclick();
  await page.keyboard.press('End');
  await page.keyboard.type(` ${MARKER}`);
  await page.keyboard.press('Escape');
  await expect.poll(() => readFileSync(file, 'utf8'), { timeout: 20_000 }).toContain(MARKER);
  await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 20_000 });
  signals.markWorkflowPhase('proseSaved');
  signals.beginExplicitReload?.();
  await page.reload();
  signals.endExplicitReload?.();
  await expect(slides.first().locator('h1')).toHaveText(TARGET_TITLE, { timeout: 30_000 });
  await expect.poll(() => readFileSync(file, 'utf8'), { timeout: 20_000 }).toContain(MARKER);
}

test('Retry opens a private deck after a transient link transport failure on a phone viewport', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'The injected transport/HTTP console categories are asserted with Chromium wording.');
  requirePortableEnvironment();
  test.setTimeout(120_000);
  page.setDefaultTimeout(12_000);
  const name = `deck-link-recovery-transport-${RUN}`;
  const project = `${USER}/${name}`;
  const targetPath = `/api/projects/${encodeURIComponent(project)}/deliverable-link`;
  const signals = await watchFailureSignals(page, targetPath);
  const interception = failTargetLink(page, project, 'transport');
  await interception.routeReady;
  const { file } = await createPrivateDeck(page, name, signals);

  const opening = page.locator('[data-dl-opening="failed"]');
  await expect(opening).toBeVisible({ timeout: 30_000 });
  signals.markWorkflowPhase('panel');
  signals.phases.push({ label: 'transport-panel-visible', requestCount: interception.count(), injectedFailureCount: interception.injectedCount(), responseStatuses: [...signals.targetResponseStatuses] });
  const retry = page.locator('[data-dl-retry-open]');
  await expect(retry).toBeVisible();
  await expect(page.locator('.dl-frame')).toHaveCount(0);
  await expect.poll(() => interception.inFlight()).toBe(0);
  expect(await page.evaluate(() => navigator.onLine)).toBe(true);
  const injectedFailuresAtPanel = interception.injectedCount();
  expect(injectedFailuresAtPanel).toBeGreaterThan(0);
  signals.phases.push({ label: 'transport-panel-settled', requestCount: interception.count(), injectedFailureCount: injectedFailuresAtPanel, responseStatuses: [...signals.targetResponseStatuses] });

  // Resize only after the recovery action is visible, mirroring a phone user retrying in-place.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(retry).toBeVisible();
  const retryBox = await retry.boundingBox();
  const hitTarget = retryBox ? await page.evaluate(({ x, y, width, height }): HitTargetCategory => {
    const target = document.elementFromPoint(x + width / 2, y + height / 2);
    if (!target) return 'none';
    if (target.closest('[data-dl-retry-open]')) return 'retry';
    if (target.closest('.sidebar.left')) return 'files-drawer';
    return 'other';
  }, { x: retryBox.x, y: retryBox.y, width: retryBox.width, height: retryBox.height }) : 'none';
  const viewport = page.viewportSize();
  signals.phoneRetry = {
    viewport: viewport ?? { width: 0, height: 0 },
    box: retryBox ? { x: retryBox.x, y: retryBox.y, width: retryBox.width, height: retryBox.height } : null,
    hitTarget,
    openingState: await page.locator('[data-dl-opening]').getAttribute('data-dl-opening'),
  };
  expect(retryBox, 'Retry control has a measurable phone-viewport box').not.toBeNull();
  expect(retryBox!.x).toBeGreaterThanOrEqual(0);
  expect(retryBox!.y).toBeGreaterThanOrEqual(0);
  expect(retryBox!.x + retryBox!.width).toBeLessThanOrEqual(390);
  expect(retryBox!.y + retryBox!.height).toBeLessThanOrEqual(844);
  interception.release();
  await retry.click();
  await expect(page.frameLocator('.dl-frame').locator('section.slide').first()).toBeVisible({ timeout: 30_000 });
  signals.markWorkflowPhase('recovered');
  signals.phases.push({ label: 'transport-recovered', requestCount: interception.count(), injectedFailureCount: interception.injectedCount(), responseStatuses: [...signals.targetResponseStatuses] });
  await editAndVerify(page, file, signals);
  signals.phases.push({ label: 'transport-reload-verified', requestCount: interception.count(), injectedFailureCount: interception.injectedCount(), responseStatuses: [...signals.targetResponseStatuses] });
  await expect.poll(() => signals.targetTransportFailures).toBe(injectedFailuresAtPanel);
  expect(signals.targetTransportFailures).toBe(injectedFailuresAtPanel);
  expect(signals.unexpectedTargetFailures).toBe(0);
  expect(signals.targetResponseStatuses.length).toBeGreaterThanOrEqual(2);
  expect(signals.targetResponseStatuses.every(status => status === 200)).toBe(true);
  expect([0, injectedFailuresAtPanel]).toContain(signals.expectedTransportConsoleErrors);
  expect(signals.pageErrors).toBe(0);
  expect(signals.unexpectedConsoleErrors).toBe(0);
  signals.classifyRequestFailures?.();
  expect(signals.unexpectedRequestFailures).toBe(0);
  expect(signals.unrelatedHttpErrorResponses).toBe(0);
});

test('403 is shown as denied without automatic retry; manual retry opens the private deck', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'The injected transport/HTTP console categories are asserted with Chromium wording.');
  requirePortableEnvironment();
  test.setTimeout(120_000);
  page.setDefaultTimeout(12_000);
  const name = `deck-link-recovery-403-${RUN}`;
  const project = `${USER}/${name}`;
  const targetPath = `/api/projects/${encodeURIComponent(project)}/deliverable-link`;
  const signals = await watchFailureSignals(page, targetPath);
  const interception = failTargetLink(page, project, 'forbidden');
  await interception.routeReady;
  const { file } = await createPrivateDeck(page, name, signals);

  const denied = page.locator('[data-dl-opening="denied"]');
  await expect(denied).toBeVisible({ timeout: 30_000 });
  signals.markWorkflowPhase('panel');
  const retry = page.locator('[data-dl-retry-open]');
  await expect(retry).toBeVisible();
  await expect(page.locator('.dl-frame')).toHaveCount(0);
  await expect.poll(() => interception.inFlight()).toBe(0);
  expect(await page.evaluate(() => navigator.onLine)).toBe(true);
  const deniedRequestCount = interception.count();
  const injected403sAtPanel = interception.injectedCount();
  signals.phases.push({ label: '403-panel-visible', requestCount: deniedRequestCount, injectedFailureCount: injected403sAtPanel, responseStatuses: [...signals.targetResponseStatuses] });
  expect(injected403sAtPanel).toBeGreaterThan(0);
  await expect.poll(() => signals.targetResponseStatuses.length).toBe(injected403sAtPanel);
  const forbiddenResponsesAtPanel = signals.targetResponseStatuses.length;
  signals.phases.push({ label: '403-panel-responses-settled', requestCount: interception.count(), injectedFailureCount: interception.injectedCount(), responseStatuses: [...signals.targetResponseStatuses] });
  expect(signals.targetResponseStatuses).toEqual(Array(forbiddenResponsesAtPanel).fill(403));
  signals.phases.push({ label: '403-denied-settled', requestCount: deniedRequestCount, injectedFailureCount: injected403sAtPanel, responseStatuses: [...signals.targetResponseStatuses] });
  await page.waitForTimeout(2_000); // longer than the 1 s transient backoff; denied must not retry
  await expect.poll(() => interception.inFlight()).toBe(0);
  signals.phases.push({ label: '403-after-no-retry-window', requestCount: interception.count(), injectedFailureCount: interception.injectedCount(), responseStatuses: [...signals.targetResponseStatuses] });
  expect(interception.count()).toBe(deniedRequestCount);
  signals.phases.push({ label: '403-no-auto-retry-after-backoff', requestCount: interception.count(), injectedFailureCount: interception.injectedCount(), responseStatuses: [...signals.targetResponseStatuses] });

  interception.release();
  await retry.click();
  await expect(page.frameLocator('.dl-frame').locator('section.slide').first()).toBeVisible({ timeout: 30_000 });
  signals.markWorkflowPhase('recovered');
  signals.phases.push({ label: '403-manual-recovery', requestCount: interception.count(), injectedFailureCount: interception.injectedCount(), responseStatuses: [...signals.targetResponseStatuses] });
  await editAndVerify(page, file, signals);
  signals.phases.push({ label: '403-reload-verified', requestCount: interception.count(), injectedFailureCount: interception.injectedCount(), responseStatuses: [...signals.targetResponseStatuses] });
  await expect.poll(() => signals.targetResponseStatuses.length).toBeGreaterThanOrEqual(forbiddenResponsesAtPanel + 2);
  expect(signals.targetResponseStatuses.slice(0, forbiddenResponsesAtPanel)).toEqual(Array(forbiddenResponsesAtPanel).fill(403));
  expect(signals.targetResponseStatuses.slice(forbiddenResponsesAtPanel).filter(status => status === 200).length).toBeGreaterThanOrEqual(2);
  expect([0, forbiddenResponsesAtPanel]).toContain(signals.expectedForbiddenConsoleErrors);
  expect(signals.targetTransportFailures).toBe(0);
  expect(signals.unexpectedTargetFailures).toBe(0);
  expect(signals.pageErrors).toBe(0);
  expect(signals.unexpectedConsoleErrors).toBe(0);
  signals.classifyRequestFailures?.();
  expect(signals.unexpectedRequestFailures).toBe(0);
  expect(signals.unrelatedHttpErrorResponses).toBe(0);
});
