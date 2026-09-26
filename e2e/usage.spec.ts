/**
 * Anonymous usage statistics end to end: actions in the editor (a toolbar button, a menu entry, an
 * unanswered shortcut, a dismissed dialog) arrive at POST /api/usage as one batch that names the
 * kind of action and nothing about the document or the person; the administrator summary lists
 * them; Settings ▸ Privacy switches the statistics off.
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { login, collectErrors, PROJECTS_DIR } from './helpers';

const DIR = `${PROJECTS_DIR}/admin/e2e-usage`;
const FILE = `${DIR}/main.tex`;
const body = '\\documentclass{article}\n\\begin{document}\n\nHello statistics, a first paragraph.\n\nA second paragraph for the cursor.\n\n\\end{document}\n';

test.beforeAll(() => { rmSync(DIR, { recursive: true, force: true }); mkdirSync(DIR, { recursive: true }); writeFileSync(FILE, body); });
test.afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

test('actions arrive as one anonymous, scrubbed batch; the summary lists them; the Privacy setting switches them off', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  await page.evaluate(() => { localStorage.setItem('ol.tabs', '[]'); localStorage.setItem('ol.combined', '0'); });
  const batches: { session: string; events: { name: string; detail: string; ok?: boolean; where?: string; dt?: number }[] }[] = [];
  page.on('request', r => { if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/usage') { try { batches.push(JSON.parse(r.postData() ?? '{}')); } catch { /* not ours */ } } });
  await page.goto('/#/admin/e2e-usage/main.tex');
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length >= 2, null, { timeout: 60000 });
  await expect(page.locator('.statusbar')).toContainText('connected', { timeout: 20000 });

  // a toolbar button on a selection (a real change, so that Undo has something to take back), then the menu's Undo
  await page.locator('.lyx-editor .lyx-par').first().click();
  await page.keyboard.press('End');
  for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+ArrowLeft');
  await page.waitForFunction(() => (document.getSelection()?.toString().length ?? 0) >= 5);
  await page.locator('[data-tb="emph"]').click();
  await expect(page.locator('.lyx-editor .lyx-par').first().locator('em, [data-emph], .lyx-emph').first()).toBeVisible();
  await page.locator('.menubar .menu button', { hasText: 'Edit' }).click();
  await page.locator('.menu-item', { hasText: 'Undo' }).first().click();
  // a shortcut nothing answers
  await page.locator('.lyx-editor .lyx-par').nth(1).click();
  await page.keyboard.press('Control+Shift+K');
  // a dialog opened and dismissed
  await page.locator('.menubar .menu button', { hasText: 'Insert' }).click();
  await page.locator('.menu-item', { hasText: 'Citation' }).first().click();
  await expect(page.locator('[role="dialog"] h2')).toHaveText('Citation');
  await page.keyboard.press('Escape');
  await expect(page.locator('[role="dialog"]')).toHaveCount(0);

  // the batch goes out on its own within 20 s
  const req = await page.waitForRequest(r => r.method() === 'POST' && new URL(r.url()).pathname === '/api/usage', { timeout: 40000 });
  const res = await req.response();
  expect(res!.status()).toBe(200);
  expect(await res!.json()).toMatchObject({ stored: expect.any(Number) });
  await expect.poll(() => batches.length).toBeGreaterThan(0);
  const batch = batches[0];
  expect(batch.session).toMatch(/^[a-f0-9]{16}$/);
  const keys = batch.events.map(e => `${e.name} ${e.detail}`);
  expect(keys.some(k => /^session (mac|windows|linux|ios|android|other) \w+ (narrow|medium|wide)/.test(k))).toBe(true);
  expect(keys).toContain('view editor');
  expect(keys).toContain('toolbar emph');
  expect(keys).toContain('menu Edit ▸ Undo');
  expect(keys).toContain('undo ');
  expect(keys).toContain('key-unbound Ctrl+Shift+K');
  expect(batch.events.find(e => e.name === 'dialog')).toMatchObject({ detail: 'Citation', ok: false, where: 'dialog' });
  expect(batch.events.find(e => e.name === 'toolbar')!.where).toBe('text');
  // nothing about the document, the project or the person
  const text = JSON.stringify(batch);
  for (const secret of ['e2e-usage', 'main.tex', 'Hello statistics', 'admin', 'Admin']) expect(text, secret).not.toContain(secret);

  // administrators see the summary; the rows do not know who acted
  const summary = await (await page.request.get('/api/admin/usage?days=1')).json();
  expect(summary.enabled).toBe(true);
  expect(summary.actions.map((a: { key: string }) => a.key)).toEqual(expect.arrayContaining(['toolbar emph', 'menu Edit ▸ Undo']));
  expect(summary.unboundKeys.map((k: { key: string }) => k.key)).toContain('Ctrl+Shift+K');
  expect(summary.dialogs.find((d: { key: string }) => d.key === 'Citation')).toMatchObject({ dismissed: expect.any(Number) });
  expect(JSON.stringify(summary)).not.toMatch(/e2e-usage|main\.tex|"admin"/);

  // Settings ▸ Privacy: the switch, and what is sent
  await page.locator('.menubar .menu button', { hasText: 'Tools' }).click();
  await page.click('.menu-item:has-text("Settings")');
  const dlg = page.locator('[role="dialog"]');
  await dlg.locator('.settings-nav button', { hasText: 'Privacy' }).click();
  const sw = dlg.locator('[data-pref="usageStats"]');
  await expect(sw).toBeChecked();
  await expect(dlg.locator('[data-setting="usage-what"]')).toContainText('Never your name');
  await sw.uncheck();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ol.prefs') ?? '{}').usageStats)).toBe(false);
  await page.keyboard.press('Escape');
  // switched off: a further action queues nothing — leaving the page sends no batch and the summary does not change
  const emphBefore = summary.actions.find((a: { key: string }) => a.key === 'toolbar emph').count;
  await page.locator('.lyx-editor .lyx-par').first().click();
  await page.locator('[data-tb="emph"]').click();
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await page.waitForTimeout(1500);
  const after = await (await page.request.get('/api/admin/usage?days=1')).json();
  expect(after.actions.find((a: { key: string }) => a.key === 'toolbar emph').count).toBe(emphBefore);
  expect(errors).toEqual([]);
});
