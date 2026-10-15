/** GUI regression: presentation returns to the same editable slide and accepts slide-navigation keys. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { login, userCredentials, PROJECTS_DIR, BASE_URL } from './helpers';

const REQUIRED_ENV = ['OVERLYX_E2E_BASE', 'OVERLYX_PROJECTS_DIR', 'OVERLYX_E2E_CREDENTIALS'] as const;
const USER = process.env.OVERLYX_PRESENT_RETURN_USER ?? 'admin';
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const PROJECT_NAME = `e2e-presenter-return-${RUN}`;
const PROJECT = `${USER}/${PROJECT_NAME}`;
const EXPECTED_TITLES = ['Return check: slide one', 'Return check: slide two', 'Return check: slide three'];
const EDITED_TITLE = 'Return handoff: slide two edited';
const editorFrame = (page: Page) => page.frameLocator('.dl-frame');
const editorSlides = (page: Page) => editorFrame(page).locator('section.slide');
const railSlides = (page: Page) => page.frameLocator('.dl-railframe').locator('section.slide');

test.afterEach(() => {
  // Only the unique project created by this test is eligible for cleanup.
  if (!/^[A-Za-z0-9._-]+$/.test(USER) || !/^e2e-presenter-return-[a-z0-9-]+$/.test(PROJECT_NAME)) return;
  const root = path.resolve(PROJECTS_DIR);
  const target = path.resolve(root, USER, PROJECT_NAME);
  if (!target.startsWith(root + path.sep)) throw new Error('refusing to clean a path outside the isolated projects root');
  rmSync(target, { recursive: true, force: true });
});

async function servedSha(page: Page, asset: string): Promise<string> {
  const response = await page.request.get(new URL(asset, BASE_URL).toString());
  expect(response.ok(), 'served candidate asset is readable').toBeTruthy();
  return createHash('sha256').update(await response.body()).digest('hex');
}

async function visibleCanvasTitle(page: Page): Promise<string | null> {
  return editorSlides(page).evaluateAll(nodes => {
    const frame = document.documentElement;
    const visible = nodes.map(node => {
      const el = node as HTMLElement;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const inViewport = rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 &&
        rect.left < frame.clientWidth && rect.top < frame.clientHeight;
      const shown = style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && inViewport;
      return { shown, heading: el.querySelector('h1,h2,h3')?.textContent?.trim() ?? '' };
    }).filter(item => item.shown && item.heading);
    return visible.length === 1 ? visible[0].heading : null;
  });
}

async function setTitle(page: Page, index: number, title: string): Promise<void> {
  await railSlides(page).nth(index).click();
  const heading = editorSlides(page).nth(index).locator('h1,h2,h3').first();
  await expect(heading).toBeVisible();
  await heading.dblclick();
  await page.keyboard.press('Control+a');
  await page.keyboard.type(title);
  await page.keyboard.press('Escape');
  await expect(editorSlides(page).nth(index).locator('h1,h2,h3').first()).toHaveText(title);
}

async function saveEvidence(info: TestInfo, evidence: Record<string, unknown>): Promise<void> {
  const file = info.outputPath('presenter-return-safe.json');
  mkdirSync(path.dirname(file), { recursive: true });
  const body = JSON.stringify(evidence, null, 2) + '\n';
  writeFileSync(file, body);
  await info.attach('presenter-return-safe.json', { body: Buffer.from(body), contentType: 'application/json' });
}

test('present from slide 2, return there, and navigate to 3 then 2 by keyboard', async ({ page }, info) => {
  const missing = REQUIRED_ENV.filter(key => !process.env[key]);
  test.skip(missing.length > 0, `requires an isolated beta environment: ${missing.join(', ')}`);
  const expectedAppSha = process.env.OVERLYX_PRESENT_RETURN_EXPECTED_APP_SHA256;
  const expectedRuntimeSha = process.env.OVERLYX_PRESENT_RETURN_EXPECTED_RUNTIME_SHA256;
  if (!/^[a-f0-9]{64}$/.test(expectedAppSha ?? '') || !/^[a-f0-9]{64}$/.test(expectedRuntimeSha ?? '')) {
    throw new Error('requires the immutable candidate app and runtime SHA-256 values from the beta runner');
  }
  test.setTimeout(90000);
  page.setDefaultTimeout(12000);

  const errors = { pageErrorCount: 0, consoleErrorCount: 0 };
  page.on('pageerror', () => { errors.pageErrorCount++; });
  page.on('console', message => { if (message.type() === 'error') errors.consoleErrorCount++; });
  const evidence: Record<string, unknown> = {
    test: 'presenter return and editor slide navigation',
    projectKind: 'fresh three-slide GUI-created deck',
    expectedTitles: EXPECTED_TITLES,
    servedAppSha256: null,
    servedRuntimeSha256: null,
    errors,
    observations: {},
  };

  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, userCredentials(USER), { ui: 'default' });
    await page.locator('[data-new-project]').click();
    await page.locator('[data-new-kind="deck"]').click();
    await page.locator('[data-new-name]').fill(PROJECT_NAME);
    await page.locator('[data-new-create]').click();
    await expect(editorSlides(page).first()).toBeVisible({ timeout: 30000 });
    await page.locator('[data-dl-zoom]').selectOption('fit');
    await expect(railSlides(page)).toHaveCount(2);

    await page.locator('[data-dl-newslide]').click();
    await expect(railSlides(page)).toHaveCount(3);
    for (let i = 0; i < EXPECTED_TITLES.length; i++) await setTitle(page, i, EXPECTED_TITLES[i]);
    await expect(editorSlides(page).nth(1).locator('h1,h2,h3').first()).toHaveText(EXPECTED_TITLES[1]);

    const root = await page.request.get(new URL('/', BASE_URL).toString());
    expect(root.ok()).toBeTruthy();
    const html = await root.text();
    const appAsset = html.match(/<script\b[^>]*\bsrc="([^"]+\.js)"/)?.[1];
    expect(appAsset, 'current served app asset is identified from the page shell').toBeTruthy();
    evidence.servedAppSha256 = await servedSha(page, appAsset!);
    evidence.servedRuntimeSha256 = await servedSha(page, '/_ol/runtime.js');
    expect(evidence.servedAppSha256, 'served app matches the immutable candidate selected by the beta runner').toBe(expectedAppSha);
    expect(evidence.servedRuntimeSha256, 'served runtime matches the immutable candidate selected by the beta runner').toBe(expectedRuntimeSha);

    await railSlides(page).nth(1).click();
    await expect(editorSlides(page).nth(1).locator('h1,h2,h3').first()).toHaveText(EXPECTED_TITLES[1]);
    const beforePresent = await visibleCanvasTitle(page);

    await page.locator('[data-dl-present]').click();
    const presenter = page.frameLocator('.dl-presenting iframe');
    const current = () => presenter.locator('section.slide[data-ol-current]');
    await expect(current()).toHaveCount(1, { timeout: 15000 });
    await expect(current()).toContainText(EXPECTED_TITLES[1]);
    const startTitle = (await current().locator('h1,h2,h3').first().innerText()).trim();
    await page.keyboard.press('ArrowRight');
    await expect(current()).toContainText(EXPECTED_TITLES[2]);
    const nextTitle = (await current().locator('h1,h2,h3').first().innerText()).trim();
    await page.keyboard.press('ArrowLeft');
    await expect(current()).toContainText(EXPECTED_TITLES[1]);
    const previousTitle = (await current().locator('h1,h2,h3').first().innerText()).trim();
    await page.keyboard.press('Escape');
    await expect(page.locator('.dl-presenting')).toHaveCount(0, { timeout: 10000 });

    const afterEscape = {
      overlayGone: (await page.locator('.dl-presenting').count()) === 0,
      visibleCanvasTitle: await visibleCanvasTitle(page),
      slideTwoHeadingVisible: await editorSlides(page).nth(1).locator('h1,h2,h3').first().isVisible(),
    };

    // Exercise a real post-presentation edit on the returned slide, not just focus/visibility.
    const returnedHeading = editorSlides(page).nth(1).locator('h1,h2,h3').first();
    await expect(returnedHeading).toBeVisible();
    await returnedHeading.dblclick();
    await expect(returnedHeading).toHaveAttribute('contenteditable', 'true');
    await expect(returnedHeading).toBeFocused();
    await page.keyboard.press('Control+a');
    await page.keyboard.type(EDITED_TITLE, { delay: 8 });
    await page.keyboard.press('Escape');
    await expect(returnedHeading).toHaveText(EDITED_TITLE);
    await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 15000 });
    const sourceFile = path.join(PROJECTS_DIR, USER, PROJECT_NAME, 'slides', 'index.html');
    const sourceAfterEdit = readFileSync(sourceFile, 'utf8');
    expect(sourceAfterEdit).toContain(EXPECTED_TITLES[0]);
    expect(sourceAfterEdit).toContain(EDITED_TITLE);
    expect(sourceAfterEdit).not.toContain(EXPECTED_TITLES[1]);
    expect(sourceAfterEdit).toContain(EXPECTED_TITLES[2]);

    await page.keyboard.press('PageDown');
    const afterPageDown = await visibleCanvasTitle(page);
    await page.keyboard.press('PageUp');
    const afterPageUp = await visibleCanvasTitle(page);
    await expect.poll(() => readFileSync(sourceFile, 'utf8')).toContain(EDITED_TITLE);
    const sourceAfterNavigation = readFileSync(sourceFile, 'utf8');
    const statusAfterNavigation = await page.locator('.dl-status').innerText();
    await page.reload();
    await expect(editorSlides(page).first()).toBeVisible({ timeout: 30000 });
    await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 15000 });
    const reloadedTitles = await Promise.all(EXPECTED_TITLES.map((_, index) =>
      editorSlides(page).nth(index).locator('h1,h2,h3').first().innerText()));
    const updatedTitles = [EXPECTED_TITLES[0], EDITED_TITLE, EXPECTED_TITLES[2]];
    expect(reloadedTitles).toEqual(updatedTitles);
    const sourceAfterReload = readFileSync(sourceFile, 'utf8');
    for (const title of updatedTitles) expect(sourceAfterReload).toContain(title);
    expect(sourceAfterReload).not.toContain(EXPECTED_TITLES[1]);
    await railSlides(page).nth(1).click();
    await expect(visibleCanvasTitle(page)).resolves.toBe(EDITED_TITLE);

    evidence.observations = {
      beforePresent,
      presenter: { startTitle, nextTitle, previousTitle },
      afterEscape,
      postReturnEdit: {
        headingWasEditableAndFocused: true,
        title: EDITED_TITLE,
        saveStatus: 'Saved',
        sourceContainsAllTitles: true,
        statusAfterNavigation,
        sourceAfterNavigationContainsEditedTitle: sourceAfterNavigation.includes(EDITED_TITLE),
      },
      editorKeyboard: { pageDownTitle: afterPageDown, pageUpTitle: afterPageUp },
      reload: { titles: reloadedTitles, sourceContainsAllTitles: true, selectedSlideTitle: await visibleCanvasTitle(page) },
    };

    expect(beforePresent).toBe(EXPECTED_TITLES[1]);
    expect(startTitle).toBe(EXPECTED_TITLES[1]);
    expect(nextTitle).toBe(EXPECTED_TITLES[2]);
    expect(previousTitle).toBe(EXPECTED_TITLES[1]);
    expect(afterEscape.overlayGone).toBe(true);
    expect(afterEscape.visibleCanvasTitle).toBe(EXPECTED_TITLES[1]);
    expect(afterPageDown).toBe(EXPECTED_TITLES[2]);
    expect(afterPageUp).toBe(EDITED_TITLE);
    expect(await visibleCanvasTitle(page)).toBe(EDITED_TITLE);
    expect(errors).toEqual({ pageErrorCount: 0, consoleErrorCount: 0 });
  } finally {
    evidence.errors = errors;
    await saveEvidence(info, evidence);
  }
});
