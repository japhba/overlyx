/** Reproduce rapid native poster-object nudging through the GUI and verify saved coordinates. */
import { test, expect, type Page } from '@playwright/test';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { login, userCredentials, PROJECTS_DIR } from './helpers';

const RUN = process.env.OVERLYX_BETA_RUN ?? Date.now().toString(36);
const NAME = `beta-nudge-gui-${RUN}`;
const PROJECT = `luna3/${NAME}`;
const FILE = path.join(PROJECTS_DIR, PROJECT, 'poster/index.html');
const slide = (page: Page) => page.frameLocator('.dl-frame').locator('section.slide').first();

function nativeShapePosition(): { left: number; top: number } | null {
  const html = readFileSync(FILE, 'utf8');
  const styles = [...html.matchAll(/<div\b[^>]*\bstyle="([^"]*)"/gi)].map(m => m[1]);
  const style = styles.reverse().find(s => /left:\s*-?[\d.]+px/i.test(s) && /top:\s*-?[\d.]+px/i.test(s));
  if (!style) return null; // autosave may still leave the starter document on disk briefly
  const left = style.match(/(?:^|;)\s*left:\s*(-?[\d.]+)px/i)?.[1];
  const top = style.match(/(?:^|;)\s*top:\s*(-?[\d.]+)px/i)?.[1];
  if (left === undefined || top === undefined) return null;
  return { left: Number(left), top: Number(top) };
}

test('GUI: ten Shift+ArrowRight presses at 30ms spacing move a native poster shape by 100px', async ({ page }, info) => {
  test.setTimeout(45000);
  await page.setViewportSize({ width: 1600, height: 1100 });
  await login(page, userCredentials('luna3'));
  const tour = page.locator('.tour-card button', { hasText: 'Not now' });
  if (await tour.count()) await tour.click();
  await page.locator('[data-new-project]').click();
  await page.locator('[data-new-kind="poster"]').click();
  await page.locator('[data-new-name]').fill(NAME);
  await page.locator('[data-new-create]').click();
  await expect(slide(page)).toBeVisible({ timeout: 15000 });

  // Clear only this temporary GUI-created project using canvas selection, then insert a native rectangle.
  await slide(page).click({ position: { x: 8, y: 500 } });
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await expect(slide(page).locator(':scope > *')).toHaveCount(0);
  await page.locator('[data-tb="dk-shapes"]').click();
  await page.locator('[data-palette="dk-shapes"] [title="Rectangle"]').click();
  const box = await slide(page).boundingBox();
  if (!box) throw new Error('poster canvas has no visible bounds');
  const at = (x: number, y: number) => ({ x: box.x + x / 841 * box.width, y: box.y + y / 1189 * box.height });
  const a = at(80, 160), b = at(140, 220);
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 6 }); await page.mouse.up();
  const shape = slide(page).locator(':scope > div').last();
  await expect(shape).toBeVisible();
  await shape.click(); // Select through the visible canvas; focus stays on the editor, not the Objects pane.
  await expect(page.locator('[data-tb="dk-delete"]')).toBeVisible();
  const domBefore = await shape.evaluate(el => ({ left: parseFloat((el as HTMLElement).style.left), top: parseFloat((el as HTMLElement).style.top) }));
  await expect.poll(() => nativeShapePosition(), { timeout: 10000 }).toEqual(domBefore);
  const before = nativeShapePosition()!;

  const startedAt = new Date().toISOString();
  const monotonicStart = performance.now();
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press('Shift+ArrowRight');
    if (i < 9) await page.waitForTimeout(30);
  }
  const sequenceFinishedAt = new Date().toISOString();
  const sequenceElapsedMs = performance.now() - monotonicStart;
  let after = nativeShapePosition();
  for (let i = 0; i < 30 && (!after || (after.left === before.left && after.top === before.top)); i++) {
    await page.waitForTimeout(100);
    after = nativeShapePosition();
  }
  after ??= before;
  await page.reload();
  await expect(slide(page)).toBeVisible();
  await expect.poll(() => nativeShapePosition(), { timeout: 10000 }).toBeTruthy();
  const afterReload = nativeShapePosition()!;
  const observation = { project: PROJECT, presses: 10, interKeyDelayMs: 30, expectedDeltaX: 100, before, after, afterReload,
    deltaX: after.left - before.left, deltaY: after.top - before.top, startedAt, sequenceFinishedAt, sequenceElapsedMs };
  const evidenceDir = 'scratch/slide-audit/evidence/luna3';
  mkdirSync(evidenceDir, { recursive: true });
  const evidencePath = path.join(evidenceDir, `beta-nudge-readback-${RUN}.json`);
  writeFileSync(evidencePath, JSON.stringify(observation, null, 2));
  await info.attach('native-nudge-readback', { path: evidencePath, contentType: 'application/json' });
  expect(afterReload, JSON.stringify(observation)).toEqual(after);
  expect(afterReload.left, JSON.stringify(observation)).toBe(before.left + 100);
  expect(afterReload.top, JSON.stringify(observation)).toBe(before.top);
});
