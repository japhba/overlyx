/** Startup failures must leave the current source reachable and offer an explicit retry. */
import { test, expect, type Page } from '@playwright/test';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { login, userCredentials, PROJECTS_DIR } from './helpers';

const frameTitle = (page: Page) => page.frameLocator('.dl-frame').locator('section.slide').first().locator('h1');
const requireFixture = () => test.skip(['OVERLYX_E2E_BASE', 'OVERLYX_PROJECTS_DIR', 'OVERLYX_E2E_CREDENTIALS'].some(key => !process.env[key]), 'Requires an isolated GUI test instance');
async function create(page: Page, name: string) {
  await login(page, userCredentials('luna5'), { ui: 'default' });
  await page.locator('[data-new-project]').click();
  await page.locator('[data-new-kind="deck"]').click();
  await page.locator('[data-new-name]').fill(name);
  await page.locator('[data-new-create]').click();
}
async function retryAndEdit(page: Page, file: string) {
  await page.locator('[data-dl-retry-open]').click();
  await expect(frameTitle(page)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-dl-opening]')).toHaveCount(0);
  await frameTitle(page).dblclick();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('Editable after canvas startup recovery');
  await page.keyboard.press('Escape');
  await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 20_000 });
  await expect.poll(() => readFileSync(file, 'utf8')).toContain('Editable after canvas startup recovery');
  await page.reload();
  await expect(frameTitle(page)).toHaveText('Editable after canvas startup recovery', { timeout: 30_000 });
}

test('an unresponsive canvas offers Code and Retry, then permits editing, saving and reloading', async ({ page }) => {
  requireFixture();
  const name = `canvas-timeout-${Date.now().toString(36)}`;
  const dir = path.join(PROJECTS_DIR, 'luna5', name), file = path.join(dir, 'slides/index.html');
  let hold = true, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/ol-d/**', async route => {
    if (hold && route.request().isNavigationRequest() && new URL(route.request().url()).searchParams.get('ol') === 'edit') {
      await gate;
      await route.continue().catch(() => {});
    } else await route.continue();
  });
  try {
    await create(page, name);
    const failure = page.locator('[data-dl-opening="failed"]');
    await expect(failure).toBeVisible({ timeout: 35_000 });
    await expect(failure).toContainText('The canvas could not start');
    await failure.getByRole('button', { name: 'Open Code', exact: true }).click();
    await expect(page.locator('[data-dl-codearea]')).toHaveValue(/name="overlyx" content="deck"/);
    await page.locator('[data-dl-code]').click();
    hold = false;
    await retryAndEdit(page, file);
  } finally { release(); rmSync(dir, { recursive: true, force: true }); }
});

test('an unresponsive cached offline bootstrap offers recovery without losing the source', async ({ page, context, browserName }) => {
  requireFixture();
  test.skip(browserName === 'webkit', 'Playwright WebKit fails emulated-offline navigation before consulting the service worker');
  const name = `canvas-offline-bootstrap-${Date.now().toString(36)}`;
  const dir = path.join(PROJECTS_DIR, 'luna5', name), file = path.join(dir, 'slides/index.html');
  try {
    await create(page, name);
    await expect(frameTitle(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.dl-status')).toHaveText('Saved');
    await page.waitForFunction(() => navigator.serviceWorker?.controller != null);
    const replaced = await page.evaluate(async () => {
      let count = 0;
      for (const name of await caches.keys()) if (name.startsWith('overlyx-shell-')) {
        const cache = await caches.open(name);
        const response = await cache.match('/_ol/offline-frame.html');
        if (!response) continue;
        // Deleting Cache API data alone still permits Firefox's HTTP cache to
        // recover the bootstrap. An inert cached response guarantees that this
        // fault really prevents the runtime from starting in every browser.
        await cache.put('/_ol/offline-frame.html', new Response('<!doctype html><title>Unavailable canvas</title>', { headers: response.headers }));
        count++;
      }
      return count;
    });
    expect(replaced).toBeGreaterThan(0);
    await context.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    const failure = page.locator('[data-dl-opening="failed"]');
    await expect(failure).toBeVisible({ timeout: 35_000 });
    await failure.getByRole('button', { name: 'Open Code', exact: true }).click();
    await expect(page.locator('[data-dl-codearea]')).toHaveValue(/name="overlyx" content="deck"/);
    await page.locator('[data-dl-code]').click();
    await context.setOffline(false);
    await retryAndEdit(page, file);
  } finally { await context.setOffline(false); rmSync(dir, { recursive: true, force: true }); }
});
