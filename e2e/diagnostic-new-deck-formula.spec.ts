/** One-shot native GUI diagnosis of the visible Formula tool on a fresh + New deck. */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { login, PROJECTS_DIR } from './helpers';

const BASE = process.env.OVERLYX_E2E_BASE!;
const RUN = process.env.OVERLYX_FORMULA_PROBE_RUN!;
const EVIDENCE = path.resolve(`scratch/slide-audit/evidence/new-deck-formula/${RUN}`);

function sha256(value: Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function routeFrom(page: Page): string {
  const hash = new URL(page.url()).hash;
  const segments = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (segments.length < 4 || segments.at(-2) !== 'slides' || segments.at(-1) !== 'index.html') {
    throw new Error('The GUI did not navigate to a project deck route after New.');
  }
  return segments.slice(0, 2).join('/');
}

async function assetShaFromPerformance(page: Page, matcher: (pathname: string) => boolean): Promise<{ pathname: string; sha256: string }> {
  const paths = (await Promise.all(page.frames().map(frame => frame.evaluate(() =>
    performance.getEntriesByType('resource').map(entry => new URL(entry.name).pathname),
  ).catch(() => [] as string[])))).flat();
  const pathname = paths.find(matcher);
  if (!pathname) throw new Error('Expected code asset was not observed in browser performance entries.');
  const response = await page.request.get(new URL(pathname, BASE).href);
  if (!response.ok()) throw new Error(`Read-only candidate code fetch returned HTTP ${response.status()}.`);
  return { pathname, sha256: sha256(await response.body()) };
}

async function toolState(page: Page) {
  const button = page.locator('[data-tb="dk-formula"]').first();
  return {
    visible: await button.isVisible().catch(() => false),
    className: await button.getAttribute('class').catch(() => null),
    activeClass: await button.evaluate(el => el.classList.contains('active')).catch(() => false),
    title: await button.getAttribute('title').catch(() => null),
    ariaPressed: await button.getAttribute('aria-pressed').catch(() => null),
    disabled: await button.isDisabled().catch(() => true),
  };
}

async function eventTypes(page: Page) {
  const host = await page.evaluate(() => ((window as any).__formulaProbeMessages ?? []).slice(-80));
  const frame = await page.frameLocator('.dl-frame').locator('html').evaluate(el => ((window as any).__formulaProbeMessages ?? []).slice(-80)).catch(() => []);
  return { host, frame };
}

async function clickpoint(slide: Locator) {
  // The argument is the first slide locator inside .dl-frame. This is geometry + hit-target readback only.
  const framePoint = await slide.evaluate((el: Element) => {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width * 0.84, y = r.top + r.height * 0.76;
    let n: Element | null = document.elementFromPoint(x, y);
    const target = n ? { tag: n.tagName.toLowerCase(), className: typeof n.className === 'string' ? n.className : '', inSlide: el.contains(n) } : null;
    return { local: { x, y }, slide: { x: r.x, y: r.y, width: r.width, height: r.height }, target };
  });
  const pageBox = await slide.boundingBox();
  if (!pageBox) throw new Error('The first slide has no page-space bounds.');
  return { ...framePoint, page: { x: pageBox.x + pageBox.width * 0.84, y: pageBox.y + pageBox.height * 0.76 } };
}

test('GUI New deck formula tool inserts one formula on a blank point and then editing recovers', async ({ browser, browserName }) => {
  if (!RUN || !/^[A-Za-z0-9_-]+$/.test(RUN)
    || !/^[a-f0-9]{64}$/.test(process.env.OVERLYX_EXPECTED_APP_SHA256 ?? '')
    || !/^[a-f0-9]{64}$/.test(process.env.OVERLYX_EXPECTED_RUNTIME_SHA256 ?? '')) {
    throw new Error('Set an explicit unique run identifier and both immutable candidate code hashes before starting the GUI diagnostic.');
  }
  if (process.env.OVERLYX_PROJECTS_DIR !== '/root/lyx/overlyx-slide-audit/scratch/slide-audit/projects'
    || process.env.OVERLYX_E2E_CREDENTIALS !== '/root/lyx/overlyx-slide-audit/scratch/slide-audit/data/credentials.txt'
    || BASE !== 'http://127.0.0.1:3017') throw new Error('Refusing to use non-isolated project paths or server origin.');
  test.setTimeout(150_000);
  expect(browserName).toBe('chromium');
  const runEvidence = path.join(EVIDENCE, 'interaction.json');
  mkdirSync(EVIDENCE, { recursive: true });

  const context = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  try {
    const page = await context.newPage();
    const errors = { page: 0, console: 0 };
    page.on('pageerror', () => { errors.page++; });
    page.on('console', message => { if (message.type() === 'error') errors.console++; });
    await page.addInitScript(() => {
      (window as any).__formulaProbeMessages = [];
      window.addEventListener('message', (event: MessageEvent) => {
        const value = event.data;
        if (value && typeof value === 'object' && typeof value.ol === 'string') {
          const events = (window as any).__formulaProbeMessages as string[];
          events.push(value.ol);
          if (events.length > 120) events.shift();
        }
      });
    });
    await login(page, undefined, { ui: 'default', tour: true });
    const notNow = page.getByRole('button', { name: 'Not now', exact: true }).last();
    if (await notNow.isVisible().catch(() => false)) await notNow.click();
    const continueInterface = page.locator('[data-interface-done]');
    if (await continueInterface.isVisible().catch(() => false)) await continueInterface.click();

    const name = `e2e-new-deck-formula-luna1-${RUN}`;
    await page.locator('[data-new-project]').click();
    await page.locator('[data-new-kind="deck"]').click();
    await page.locator('[data-new-name]').fill(name);
    await page.locator('[data-new-create]').click();
    const firstSlide = page.frameLocator('.dl-frame').locator('section.slide').first();
    await expect(firstSlide).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30_000 });
    await page.keyboard.press('Escape');

    const project = routeFrom(page);
    const sourceFile = path.join(PROJECTS_DIR, ...project.split('/'), 'slides', 'index.html');
    const appAsset = await assetShaFromPerformance(page, p => /^\/assets\/index-[^/]+\.js$/.test(p));
    const runtimeAsset = await assetShaFromPerformance(page, p => p === '/_ol/runtime.js');
    const errorsBefore = { ...errors };
    const stateBefore = await toolState(page);
    const fieldCountBefore = await page.locator('[data-dl-mathedit] .lm-field').count();
    const slidePoint = await clickpoint(firstSlide);
    const beforeToolClick = { route: project, appAsset, runtimeAsset, errorsBefore, stateBefore, fieldCountBefore, slidePoint, events: await eventTypes(page) };
    expect(appAsset.sha256).toBe(process.env.OVERLYX_EXPECTED_APP_SHA256);
    expect(runtimeAsset.sha256).toBe(process.env.OVERLYX_EXPECTED_RUNTIME_SHA256);
    expect(fieldCountBefore).toBe(0);

    await page.locator('[data-tb="dk-formula"]').click();
    const stateAfterToolClick = await toolState(page);
    await page.mouse.click(slidePoint.page.x, slidePoint.page.y);
    const field = page.locator('[data-dl-mathedit] .lm-field');
    const interactionBeforeAssert = {
      ...beforeToolClick,
      stateAfterToolClick,
      stateAfterCanvasClick: await toolState(page),
      fieldCountAfterClick: await page.locator('[data-dl-mathedit] .lm-field').count(),
      eventsAfterClick: await eventTypes(page),
      errorsAfterClick: { ...errors },
    };
    writeFileSync(runEvidence, JSON.stringify(interactionBeforeAssert, null, 2) + '\n');
    await expect(field).toBeVisible({ timeout: 15_000 });
    await page.keyboard.type('x+1', { delay: 35 });
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-dl-mathedit]')).toHaveCount(0, { timeout: 15_000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30_000 });
    let source = readFileSync(sourceFile, 'utf8');
    let display = Array.from(source.matchAll(/\\\[([\s\S]*?)\\\]/g), match => (match[1] ?? '').trim());
    expect(display).toEqual(['x+1']);
    await page.reload();
    const reopenedSlide = page.frameLocator('.dl-frame').locator('section.slide').first();
    await expect(reopenedSlide.locator('mjx-container')).toHaveCount(1, { timeout: 30_000 });
    await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30_000 });
    source = readFileSync(sourceFile, 'utf8');
    display = Array.from(source.matchAll(/\\\[([\s\S]*?)\\\]/g), match => (match[1] ?? '').trim());
    expect(display).toEqual(['x+1']);

    const math = reopenedSlide.locator('mjx-container').first();
    const mathBox = await math.boundingBox();
    if (!mathBox) throw new Error('Saved formula has no visible rendered bounds after reload.');
    await page.mouse.dblclick(mathBox.x + mathBox.width / 2, mathBox.y + mathBox.height / 2);
    await expect(field).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-dl-mathedit]')).toHaveCount(0, { timeout: 15_000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30_000 });
    source = readFileSync(sourceFile, 'utf8');
    display = Array.from(source.matchAll(/\\\[([\s\S]*?)\\\]/g), match => (match[1] ?? '').trim());
    expect(display).toEqual([]);

    await page.locator('[data-tb="dk-text"]').click();
    const blankBox = await reopenedSlide.boundingBox();
    if (!blankBox) throw new Error('First slide bounds disappeared after formula clear.');
    await page.mouse.click(blankBox.x + blankBox.width * 0.80, blankBox.y + blankBox.height * 0.77);
    const textEditor = reopenedSlide.locator('[contenteditable="true"]').last();
    await expect(textEditor).toBeVisible({ timeout: 15_000 });
    await page.keyboard.type('Continue after formula clear', { delay: 20 });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30_000 });
    await expect.poll(() => readFileSync(sourceFile, 'utf8'), { timeout: 15_000 }).toContain('Continue after formula clear');
    await page.reload();
    await expect(page.frameLocator('.dl-frame').locator('section.slide').first()).toContainText('Continue after formula clear');
    expect(errors).toEqual({ page: 0, console: 0 });

    const final = { project, appAsset, runtimeAsset, displayFormulasAfterClear: display.length, proseSurvivedReload: true, errors };
    writeFileSync(path.join(EVIDENCE, 'result.json'), JSON.stringify(final, null, 2) + '\n');
  } finally {
    await context.close();
  }
});
