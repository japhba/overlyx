import { test, expect, type Page } from '@playwright/test';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { login, userCredentials, PROJECTS_DIR } from './helpers';

const RUN = process.env.OVERLYX_TEXT_PROBE_RUN ?? Date.now().toString(36);
const NAME = `luna4-text-selection-probe-${RUN}`;
const FILE = path.join(PROJECTS_DIR, 'luna4', NAME, 'slides', 'index.html');
const APPEND = ' A repairable observation chain joins orbit time, sensor quality, local checks, and crew decisions across cloudy coastal passes without treating missing scenes as zero risk.';
const frame = (p: Page) => p.frameLocator('.dl-frame');
const slides = (p: Page) => frame(p).locator('section.slide');

test('GUI selection offsets, replacement splice, live text and saved HTML agree', async ({ page }, info) => {
  page.setDefaultTimeout(8000);
  page.setDefaultNavigationTimeout(30000);
  await login(page, userCredentials('luna4'));
  await page.locator('[data-new-project]').click();
  await page.locator('[data-new-kind="deck"]').click();
  await page.locator('[data-new-name]').fill(NAME);
  await page.locator('[data-new-create]').click();
  await slides(page).first().waitFor({ timeout: 30000 });
  await expect(slides(page)).toHaveCount(2);
  // The editor shows one slide at a time; select slide 2 through its visible rail thumbnail first.
  await page.frameLocator('.dl-railframe').locator('section.slide').nth(1).click();
  await expect(slides(page).nth(1)).toBeVisible();
  const li = slides(page).nth(1).locator('li').nth(1);
  await li.dblclick();
  const before = await li.evaluate(el => el.textContent ?? '');
  await page.keyboard.press('End');
  const afterEnd = await li.evaluate(el => {
    const s = getSelection();
    const node = s?.focusNode;
    return { text: el.textContent ?? '', focusOffset: s?.focusOffset ?? -1, focusNode: node?.nodeName ?? '', focusText: node?.textContent ?? '' };
  });
  await page.keyboard.press('Control+Shift+ArrowLeft');
  const selection = await li.evaluate(el => {
    const s = getSelection();
    if (!s?.anchorNode || !s.focusNode) return null;
    const off = (node: Node, at: number) => { const r = document.createRange(); r.selectNodeContents(el); r.setEnd(node, at); return r.toString().length; };
    const a = off(s.anchorNode, s.anchorOffset), f = off(s.focusNode, s.focusOffset);
    return { selected: s.toString(), anchor: a, focus: f, start: Math.min(a, f), end: Math.max(a, f) };
  });
  expect(selection).not.toBeNull();
  const expected = before.slice(0, selection!.start) + APPEND + before.slice(selection!.end);
  await info.attach('selection-before-typing', { body: Buffer.from(JSON.stringify({ before, afterEnd, selection, expected }, null, 2)), contentType: 'application/json' });
  await page.keyboard.type(APPEND, { delay: 0 });
  await page.keyboard.press('Escape');
  await expect.poll(() => readFileSync(FILE, 'utf8')).toContain(APPEND.trimStart());
  const live = await li.evaluate(el => el.textContent ?? '');
  const saved = readFileSync(FILE, 'utf8');
  const result = { before, selection, expected, live, liveEqualsExpected: live === expected, sourceHasWholeAppend: saved.includes(APPEND.trimStart()), sourceIncludesExpectedRaw: saved.includes(expected) };
  mkdirSync('scratch/slide-audit/evidence/luna4', { recursive: true });
  writeFileSync(`scratch/slide-audit/evidence/luna4/text-selection-${RUN}.json`, JSON.stringify(result, null, 2));
  await info.attach('live-and-saved-after-typing', { body: Buffer.from(JSON.stringify(result, null, 2)), contentType: 'application/json' });
  await info.attach('after-edit-screenshot', { body: await page.screenshot(), contentType: 'image/png' });
  expect(live).toBe(expected);
  expect(saved).toContain(APPEND.trimStart());
});
