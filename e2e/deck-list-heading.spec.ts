/** Theme tag-selector typography should survive converting a heading textbox into a list. */
import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { login, BASE_URL, PROJECTS_DIR } from './helpers';

const key = (browser: string) => `admin/e2e-list-heading-${Date.now().toString(36)}-${browser}`;
const sourcePath = (project: string) => `${PROJECTS_DIR}/${project}/slides/index.html`;
function assertPrivateAuditEnvironment(): void {
  if (!process.env.OVERLYX_PROJECTS_DIR || process.env.OVERLYX_PROJECTS_DIR !== PROJECTS_DIR ||
      !process.env.OVERLYX_E2E_CREDENTIALS ||
      !process.env.OVERLYX_E2E_BASE || process.env.OVERLYX_E2E_BASE !== BASE_URL) {
    throw new Error('Heading GUI probe requires explicit, matching isolated project, credential and base-URL environment variables.');
  }
}

async function waitSaved(page: import('@playwright/test').Page): Promise<void> {
  await expect(page.locator('.dl-status')).toHaveText('Saved', { timeout: 30000 });
}

test('heading theme typography survives GUI conversion to an unordered list', async ({ page }, info) => {
  test.setTimeout(120000);
  assertPrivateAuditEnvironment();
  const project = key(info.project.name);
  const file = sourcePath(project);
  mkdirSync(`${PROJECTS_DIR}/${project}/slides`, { recursive: true });
  writeFileSync(file, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="overlyx" content="deck"><title>Heading list fidelity</title>
  <style>
    body{margin:0;font:24px Arial,sans-serif;color:#222}
    .slide{position:relative;width:1280px;height:720px;overflow:hidden;background:white}
    h1,h2{font-size:48px;font-weight:600;font-family:Georgia,serif;color:#001f3f;line-height:1.2}
  </style></head><body><section class="slide">
  <h1 id="theme-h1" style="position:absolute;left:100px;top:100px;width:1000px;margin:0">Primary heading</h1>
  <h2 id="theme-h2" style="position:absolute;left:100px;top:300px;width:1000px;margin:0">Secondary heading</h2>
  </section></body></html>`);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(`page: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  await login(page, undefined, { ui: 'default' });
  await page.request.get('/api/projects');
  await page.goto(`/#/${project}/slides/index.html`);
  const frame = page.frameLocator('.dl-frame');
  const slide = frame.locator('section.slide');
  await expect(slide).toBeVisible({ timeout: 30000 });
  await waitSaved(page);

  type Style = { fontSize: string; fontFamily: string; fontWeight: string; color: string; lineHeight: string };
  const readStyle = (locator: import('@playwright/test').Locator): Promise<Style> => locator.evaluate(el => {
    const css = getComputedStyle(el);
    return { fontSize: css.fontSize, fontFamily: css.fontFamily, fontWeight: css.fontWeight, color: css.color, lineHeight: css.lineHeight };
  });
  const samples: Array<{ tag: string; before: Style; after: Style }> = [];

  for (const item of [
    { tag: 'h1', id: 'theme-h1', title: 'Primary heading', second: 'Second primary item' },
    { tag: 'h2', id: 'theme-h2', title: 'Secondary heading', second: 'Second secondary item' },
  ]) {
    const heading = slide.locator(`#${item.id}`);
    const before = await readStyle(heading);
    expect(before.fontSize).toBe('48px');
    expect(before.fontFamily).toBe('Georgia, serif');
    expect(before.fontWeight).toBe('600');
    expect(before.color).toBe('rgb(0, 31, 63)');
    expect(Math.abs(parseFloat(before.lineHeight) - 57.6)).toBeLessThan(0.1);

    // Start real text retyping, choose the native unordered-list toolbar control, then create row two.
    await heading.dblclick({ position: { x: 28, y: 20 } });
    await expect(heading).toHaveAttribute('contenteditable', 'true');
    await page.keyboard.press('Control+End');
    await page.locator('[data-tb="dk-ul"]').click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type(item.second, { delay: 20 });
    await page.keyboard.press('Escape');
    await waitSaved(page);

    const list = slide.locator('ul').filter({ hasText: item.second });
    await expect(list.locator('li')).toHaveText([item.title, item.second]);
    const firstItem = list.locator('li').first();
    const after = await readStyle(firstItem);
    samples.push({ tag: item.tag, before, after });
    expect.soft(after.fontSize, `${item.tag}: font-size after conversion`).toBe(before.fontSize);
    expect.soft(after.fontFamily, `${item.tag}: font-family after conversion`).toBe(before.fontFamily);
    expect.soft(after.fontWeight, `${item.tag}: font-weight after conversion`).toBe(before.fontWeight);
    expect.soft(after.color, `${item.tag}: color after conversion`).toBe(before.color);
    expect.soft(after.lineHeight, `${item.tag}: line-height after conversion`).toBe(before.lineHeight);

    // Collaboration may acknowledge the edit before the separately debounced
    // physical source-file write reaches disk. Capture only a fresh snapshot
    // that already contains the exact GUI-authored list structure.
    let saved = '';
    await expect.poll(() => {
      const current = readFileSync(file, 'utf8');
      const titleAt = current.indexOf(item.title);
      const secondAt = current.indexOf(item.second);
      if (titleAt < 0 || secondAt <= titleAt) return false;
      const ulStart = current.lastIndexOf('<ul', titleAt);
      const ulEnd = current.indexOf('</ul>', secondAt);
      if (ulStart < 0 || ulEnd <= secondAt) return false;
      const liCount = (current.slice(ulStart, ulEnd).match(/<li\b/g) ?? []).length;
      if (liCount !== 2) return false;
      saved = current;
      return true;
    }, { timeout: 15000 }).toBe(true);
    const titleAt = saved.indexOf(item.title);
    const secondAt = saved.indexOf(item.second);
    expect(titleAt, `${item.tag}: original title persisted`).toBeGreaterThan(-1);
    expect(secondAt, `${item.tag}: second list item persisted after the title`).toBeGreaterThan(titleAt);
    const ulStart = saved.lastIndexOf('<ul', titleAt);
    const ulEnd = saved.indexOf('</ul>', secondAt);

    expect(ulStart, `${item.tag}: source contains a list start before title`).toBeGreaterThan(-1);
    expect(ulEnd, `${item.tag}: source contains a list end after second item`).toBeGreaterThan(secondAt);
    expect((saved.slice(ulStart, ulEnd).match(/<li\b/g) ?? []).length, `${item.tag}: exactly two list items persisted`).toBe(2);
    await expect.poll(() => readFileSync(file, 'utf8')).toBe(saved);
  }

  await page.evaluate(() => window.scrollTo(0, 0));
  await info.attach('heading-list-style-metrics.json', { body: JSON.stringify(samples, null, 2), contentType: 'application/json' });
  const committed = readFileSync(file, 'utf8');
  await page.reload();
  await waitSaved(page);
  expect(readFileSync(file, 'utf8')).toBe(committed);
  for (const item of [
    { id: 'theme-h1', title: 'Primary heading', second: 'Second primary item' },
    { id: 'theme-h2', title: 'Secondary heading', second: 'Second secondary item' },
  ]) {
    const list = page.frameLocator('.dl-frame').locator('section.slide ul').filter({ hasText: item.second });
    await expect(list.locator('li')).toHaveText([item.title, item.second]);
  }
  expect(errors).toEqual([]);
});
