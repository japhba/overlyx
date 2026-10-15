/** Imported projects must finish visibly; rejected archives must show an actionable error. */
import { test, expect } from '@playwright/test';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { writeZip } from '../packages/server/src/zip';
import { login, userCredentials, PROJECTS_DIR } from './helpers';

const source = '<!doctype html><html><head><meta name="overlyx" content="deck"><style>.slide{width:1280px;height:720px;background:white;position:relative}h1{position:absolute;left:100px;top:100px}</style></head><body><section class="slide"><h1>Imported field briefing</h1></section></body></html>';
const requireFixture = () => test.skip(['OVERLYX_E2E_BASE', 'OVERLYX_PROJECTS_DIR', 'OVERLYX_E2E_CREDENTIALS'].some(key => !process.env[key]), 'Requires an isolated GUI test instance');
async function choose(page: import('@playwright/test').Page, name: string, buffer: Buffer) {
  await login(page, userCredentials('luna6'), { ui: 'default' });
  await page.locator('[data-import-overleaf]').click();
  const panel = page.locator('[data-overleaf-import]');
  await panel.locator('[data-overleaf-zip]').setInputFiles({ name: `${name}.zip`, mimeType: 'application/zip', buffer });
  await panel.locator('[data-overleaf-import-zip]').click();
  return { panel, row: panel.locator('[data-zip-row]') };
}

test('GUI ZIP import finishes visibly and the imported slide can be edited, saved and reloaded', async ({ page }) => {
  requireFixture();
  const name = `zip-success-${Date.now().toString(36)}`, dir = path.join(PROJECTS_DIR, 'luna6', name), file = path.join(dir, 'index.html');
  try {
    const { panel, row } = await choose(page, name, writeZip([{ name: 'index.html', data: Buffer.from(source) }]));
    await expect(row).toHaveClass('ok', { timeout: 30_000 });
    await expect(row).toContainText('1 file'); await expect(row.locator('.working')).toHaveCount(0);
    await expect(panel.locator('[data-overleaf-import-zip]')).toBeDisabled();
    await page.getByRole('dialog', { name: 'Import from Overleaf' }).getByRole('button', { name: 'Close', exact: true }).click();
    const card = page.locator(`.home-card[data-project="luna6/${name}"]`);
    await expect(card).toBeVisible();
    expect(readFileSync(file, 'utf8')).toBe(source);
    // Open the imported project through its Home card, then its HTML file.
    await card.locator('a[href$="/index.html"]').first().click();
    const title = page.frameLocator('.dl-frame').locator('h1');
    await expect(title).toHaveText('Imported field briefing', { timeout: 30_000 });
    await title.dblclick(); await page.keyboard.press('Control+a'); await page.keyboard.type('Imported and editable'); await page.keyboard.press('Escape');
    await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 20_000 });
    await expect.poll(() => readFileSync(file, 'utf8')).toContain('Imported and editable');
    await page.reload(); await expect(title).toHaveText('Imported and editable', { timeout: 30_000 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a rejected ZIP shows its error and enables another import attempt', async ({ page }) => {
  requireFixture();
  const name = `zip-rejected-${Date.now().toString(36)}`, dir = path.join(PROJECTS_DIR, 'luna6', name);
  try {
    const { panel, row } = await choose(page, name, Buffer.from('This is deliberately not an archive.'));
    await expect(row).toHaveClass('error', { timeout: 30_000 });
    await expect(row.locator('.status.error')).toContainText(/zip/i);
    await expect(row.locator('.working')).toHaveCount(0);
    await expect(panel.locator('[data-overleaf-import-zip]')).toBeEnabled();
    await expect(row.locator('input')).toBeEnabled();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
