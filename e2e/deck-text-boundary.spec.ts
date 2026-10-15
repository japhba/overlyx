/** GUI regression coverage for textbox Home/End boundaries and an atomic final inline formula. */
import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { login, BASE_URL, PROJECTS_DIR } from './helpers';

const created: string[] = [];
test.afterAll(() => {
  if (!process.env.OVERLYX_E2E_KEEP) for (const key of created) rmSync(`${PROJECTS_DIR}/${key}`, { recursive: true, force: true });
});

async function waitSaved(page: import('@playwright/test').Page): Promise<void> {
  await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30000 });
}

function assertPrivateAuditEnvironment(): void {
  if (!process.env.OVERLYX_PROJECTS_DIR || process.env.OVERLYX_PROJECTS_DIR !== PROJECTS_DIR ||
      !process.env.OVERLYX_E2E_CREDENTIALS ||
      !process.env.OVERLYX_E2E_BASE || process.env.OVERLYX_E2E_BASE !== BASE_URL) {
    throw new Error('Boundary GUI probe requires explicit, matching isolated project, credential and base-URL environment variables.');
  }
}

test('textbox Home/End selection extends to either boundary and typing preserves a final inline formula', async ({ page }, info) => {
  test.setTimeout(90000);
  assertPrivateAuditEnvironment();
  const key = `admin/e2e-text-boundary-${Date.now().toString(36)}-${info.project.name}`;
  created.push(key);
  const file = `${PROJECTS_DIR}/${key}/slides/index.html`;
  mkdirSync(`${PROJECTS_DIR}/${key}/slides`, { recursive: true });
  writeFileSync(file, String.raw`<!doctype html><html><head><meta charset="utf-8"><meta name="overlyx" content="deck"><title>Text boundaries</title>
  <style>body{margin:0}.slide{position:relative;width:1280px;height:720px;background:white;font:32px sans-serif}.sub{position:absolute;left:100px;top:120px;width:1000px;margin:0;font:32px sans-serif}.second{top:300px}</style></head><body>
  <section class="slide"><p class="sub">Shared baseline. A0😀 B0Ω B1Ω \(x^2\)</p><p class="sub second">Other baseline.</p></section></body></html>`);
  const source = () => readFileSync(file, 'utf8');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  await login(page, undefined, { ui: 'default' });
  await page.request.get('/api/projects');
  await page.goto(`/#/${key}/slides/index.html`);
  const slide = page.frameLocator('.dl-frame').locator('section.slide');
  const first = slide.locator('.sub').first();
  const second = slide.locator('.sub').nth(1);
  const formula = first.locator('mjx-container [data-mml-node="math"]');
  await expect(first).toBeVisible({ timeout: 30000 });
  await expect(formula).toHaveAttribute('data-latex', /x\^\{?2\}?/);
  await waitSaved(page);

  const selection = () => page.frameLocator('.dl-frame').locator('html').evaluate(() => {
    const root = document.querySelector('.sub[contenteditable="true"]') as HTMLElement | null;
    const s = getSelection();
    return root && s ? {
      collapsed: s.isCollapsed,
      text: s.toString(),
      anchorRoot: s.anchorNode === root,
      anchorOffset: s.anchorOffset,
      focusRoot: s.focusNode === root,
      focusOffset: s.focusOffset,
      childCount: root.childNodes.length,
    } : null;
  });

  // GUI retyping, whole textbox selection from the final formula back to Home.
  await first.dblclick({ position: { x: 16, y: 12 } });
  await expect(first).toHaveAttribute('contenteditable', 'true');
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Control+Shift+Home');
  const backwards = await selection();
  expect(backwards).not.toBeNull();
  expect(backwards!.collapsed).toBe(false);
  expect(backwards!.anchorRoot).toBe(true);
  expect(backwards!.anchorOffset).toBe(backwards!.childCount);
  expect(backwards!.focusRoot).toBe(true);
  expect(backwards!.focusOffset).toBe(0);
  expect(backwards!.text).toContain('Shared baseline. A0😀 B0Ω B1Ω');

  // Collapse to the end, append after the final formula, and commit through the GUI.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.type(' after', { delay: 25 });
  await page.keyboard.press('Escape');
  await waitSaved(page);
  await expect.poll(source).toContain(' after');
  await expect.poll(() => first.locator('mjx-container').count()).toBe(1);
  await expect(first.locator('mjx-container [data-mml-node="math"]')).toHaveAttribute('data-latex', /x\^\{?2\}?/);
  const savedAfterFormula = source();
  const formulaSourceAt = savedAfterFormula.indexOf('\\(x');
  const appendedTextAt = savedAfterFormula.indexOf(' after');
  expect(formulaSourceAt).toBeGreaterThan(savedAfterFormula.indexOf('B1Ω'));
  expect(appendedTextAt).toBeGreaterThan(formulaSourceAt);

  // GUI retyping, whole plain-text box selection from Home through End, then prepend text.
  await second.dblclick({ position: { x: 16, y: 12 } });
  await expect(second).toHaveAttribute('contenteditable', 'true');
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('Control+Shift+End');
  const forwards = await selection();
  expect(forwards).not.toBeNull();
  expect(forwards!.collapsed).toBe(false);
  expect(forwards!.anchorRoot).toBe(true);
  expect(forwards!.anchorOffset).toBe(0);
  expect(forwards!.focusRoot).toBe(true);
  expect(forwards!.focusOffset).toBe(forwards!.childCount);
  expect(forwards!.text).toBe('Other baseline.');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.type('Prefix: ', { delay: 25 });
  await page.keyboard.press('Escape');
  await waitSaved(page);
  await expect.poll(source).toContain('Prefix: Other baseline.');
  await expect(second).toHaveText('Prefix: Other baseline.');
  await expect.poll(source).toContain('Shared baseline. A0😀 B0Ω B1Ω');
  await page.reload();
  await waitSaved(page);
  await expect(first).toContainText('Shared baseline. A0😀 B0Ω B1Ω after');
  await expect(first.locator('mjx-container')).toHaveCount(1);
  await expect(first.locator('mjx-container [data-mml-node="math"]')).toHaveAttribute('data-latex', /x\^\{?2\}?/);
  await expect(second).toHaveText('Prefix: Other baseline.');
  const reloadedSource = source();
  const reloadedFormulaAt = reloadedSource.indexOf('\\(x');
  const reloadedTextAt = reloadedSource.indexOf(' after');
  expect(reloadedFormulaAt).toBeGreaterThan(reloadedSource.indexOf('B1Ω'));
  expect(reloadedTextAt).toBeGreaterThan(reloadedFormulaAt);
  expect(errors).toEqual([]);
});
