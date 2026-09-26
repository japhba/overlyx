import { test, expect, type WebSocketRoute } from '@playwright/test';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { login, openDoc, PROJECTS_DIR, texDoc } from './helpers';

const dir = `${PROJECTS_DIR}/admin/e2e-reliability`;
test.beforeAll(() => {
  mkdirSync(dir, { recursive: true });
  for (const name of ['save', 'paste', 'ui']) writeFileSync(`${dir}/${name}.tex`, texDoc('First paragraph.\n\nSecond paragraph.\n\n\\section{A new target}\n\nTarget text.'));
});
test.afterAll(() => rmSync(dir, { recursive: true, force: true }));

test('a delayed save acknowledgment does not confirm a newer deletion', async ({ page, context }) => {
  let holdAck = false, holdUpdates = false;
  const acks: (string | Buffer)[] = [], updates: (string | Buffer)[] = [];
  let socket: WebSocketRoute, upstream: WebSocketRoute;
  await context.routeWebSocket(url => url.pathname.startsWith('/ws'), route => {
    socket = route; upstream = route.connectToServer();
    upstream.onMessage(m => { if (holdAck && Buffer.from(m)[0] === 3) acks.push(m); else route.send(m); });
    route.onMessage(m => { if (holdUpdates && Buffer.from(m)[0] === 0) updates.push(m); else upstream.send(m); });
  });
  await login(page); await openDoc(page, 'admin/e2e-reliability/save.tex');
  expect((await page.request.get('/api/projects')).status()).toBe(200);
  await expect(page.locator('.save-state')).toContainText('All changes saved');
  const first = page.locator('.lyx-editor > .lyx-par').first();
  await first.click(); await page.keyboard.press('End');
  holdAck = true;
  await page.keyboard.type(' SAVED-A');
  await expect.poll(() => acks.length).toBeGreaterThan(0);
  holdUpdates = true;
  await page.keyboard.press('Backspace');
  for (const ack of acks.splice(0)) socket!.send(ack);
  holdAck = false;
  await page.waitForTimeout(200);
  await expect(page.locator('.save-state')).not.toContainText('All changes saved');
  expect(readFileSync(`${dir}/save.tex`, 'utf8')).toContain('SAVED-A');
  holdUpdates = false;
  for (const update of updates.splice(0)) upstream!.send(update);
  await expect(page.locator('.save-state')).toContainText('All changes saved');
  expect(readFileSync(`${dir}/save.tex`, 'utf8')).not.toContain('SAVED-A');
});

test('delayed LaTeX paste stays at its original target after moving the cursor', async ({ page }) => {
  await login(page); await openDoc(page, 'admin/e2e-reliability/paste.tex');
  let release!: () => void, requested = false;
  const gate = new Promise<void>(r => { release = r; });
  await page.route('**/api/docs/**/clip', async route => { requested = true; await gate; await route.continue(); });
  const paragraphs = page.locator('.lyx-editor > .lyx-par');
  await paragraphs.first().click(); await page.keyboard.press('End');
  await page.evaluate(() => {
    const data = new DataTransfer(); data.setData('text/plain', '$x^2$');
    document.querySelector('.lyx-editor')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect.poll(() => requested).toBe(true);
  await paragraphs.nth(1).click(); await page.keyboard.press('End');
  await page.keyboard.type(' later');
  release();
  await expect(paragraphs.first().locator('.lyx-math-inline')).toHaveCount(1);
  await expect(paragraphs.nth(1).locator('.lyx-math-inline')).toHaveCount(0);
  await page.keyboard.type(' still here');
  await expect(paragraphs.nth(1)).toContainText('still here');
});

test('view modes, automatic reference labels and accessible narrow dialogs', async ({ page }) => {
  await login(page); await openDoc(page, 'admin/e2e-reliability/ui.tex');
  // the pane switch: TeX beside the document, then WYSIWYG off (the source alone), then on again
  await page.getByRole('button', { name: 'TeX', exact: true }).click();
  await expect(page.locator('textarea.source')).toBeVisible();
  await page.getByRole('button', { name: 'WYSIWYG', exact: true }).click();
  await expect(page.locator('.editor-scroll')).toBeHidden();
  await page.getByRole('button', { name: 'WYSIWYG', exact: true }).click();
  await expect(page.locator('.editor-scroll')).toBeVisible();
  await page.locator('.lyx-editor > .lyx-par').first().click(); await page.keyboard.press('End');
  await page.evaluate(() => (window as any).overlyx.openDialog('ref'));
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: /A new target/ }).click();
  await dialog.getByLabel('Format', { exact: true }).selectOption('cref');
  await dialog.getByRole('button', { name: 'Insert', exact: true }).click();
  await expect.poll(() => readFileSync(`${dir}/ui.tex`, 'utf8')).toContain('\\label{sec:a-new-target}');
  await expect.poll(() => readFileSync(`${dir}/ui.tex`, 'utf8')).toContain('\\cref{sec:a-new-target}');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => (window as any).overlyx.openDialog('graphics'));
  await expect(dialog.getByLabel('File', { exact: true })).toBeFocused();
  for (let i = 0; i < 22; i++) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
  }
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.lyx-editor')).toBeFocused();
});
