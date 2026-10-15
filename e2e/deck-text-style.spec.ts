/** Regression for the short labels whose immediate font/colour commands did not persist in GUI authoring. */
import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { login, PROJECTS_DIR, collectErrors } from './helpers';
import { nativePointReference } from './native-style-geometry';

test('new short labels accept immediate point size and text colour, save and reopen', async ({ page }, info) => {
  test.setTimeout(45000);
  const name = `e2e-text-style-${Date.now().toString(36)}-${info.project.name}`;
  const file = `${PROJECTS_DIR}/admin/${name}/slides/index.html`;
  const errors = collectErrors(page);
  await page.addInitScript(() => {
    if (window !== window.top) return;
    const state: Record<string, unknown> = {};
    (window as unknown as { __textStyleProbe: Record<string, unknown> }).__textStyleProbe = state;
    addEventListener('message', event => {
      const m = event.data;
      if (m?.ol === 'selection') state.selection = { version:m.version,
        items:(m.items ?? []).map((item: any) => ({ kind:item.kind, path:item.path, name:item.name,
          color:item.style?.color, fontSize:item.style?.fontSize })) };
      if (m?.ol === 'editing') state.editing = { path:m.path };
    });
  });
  await login(page);
  await page.locator('[data-new-project]').click();
  await page.locator('[data-new-kind="deck"]').click();
  await page.locator('[data-new-name]').fill(name);
  await page.locator('[data-new-create]').click();
  const slide = page.frameLocator('.dl-frame').locator('section.slide').first();
  await expect(slide).toBeVisible({ timeout:30000 });
  await page.locator('[data-dl-zoom]').selectOption('fit');
  await page.locator('[data-tb="dk-text"]').click();
  const box = (await slide.boundingBox())!;
  await page.mouse.click(box.x+box.width*0.1, box.y+box.height*0.8);
  await page.keyboard.type('FAST LABEL', { delay:0 });
  await page.keyboard.press('Escape');
  const label = slide.getByText('FAST LABEL', { exact:true });
  await expect(label).toBeVisible();
  // Exactly the initial authoring helper's visible actions; no source-ack sleep or Objects-pane
  // re-selection is inserted to conceal a fast-create/context bug.
  await page.locator('[data-tb="dk-select"]').click();
  await label.click();
  const before = await label.evaluate(el => ({ style:el.getAttribute('style'), color:getComputedStyle(el).color, fontSize:getComputedStyle(el).fontSize }));
  const size = page.locator('[data-dk-size] input').last();
  await size.fill('13');
  await size.press('Enter');
  await page.locator('[data-tb="dk-color"]').click();
  await page.locator('[data-palette="dk-color"] [data-color="#ffd966"]').click();
  const current = () => label.evaluate(el => ({ style:el.getAttribute('style'), color:getComputedStyle(el).color, fontSize:getComputedStyle(el).fontSize }));
  const expectThirteenPointGold = async () => {
    await expect.poll(async () => (await current()).color).toBe('rgb(255, 217, 102)');
    // Native references include the engine's computed-size quantization. The
    // saved source below still requires exactly 13pt, immediately and on reload.
    await expect.poll(async () => {
      const font = await label.evaluate(nativePointReference, 13);
      return font.actual === font.expected && font.lower !== font.expected && font.upper !== font.expected;
    }).toBe(true);
  };
  mkdirSync(info.outputDir, { recursive:true });
  writeFileSync(info.outputPath('font-colour-immediate.json'), JSON.stringify({ before, afterImmediate:await current(),
    context:await page.evaluate(() => (window as unknown as { __textStyleProbe: unknown }).__textStyleProbe),
    savedParagraph:/<p[^>]*>FAST LABEL<\/p>/.exec(readFileSync(file, 'utf8'))?.[0] }, null,2));
  await expectThirteenPointGold();
  await expect.poll(() => readFileSync(file, 'utf8')).toMatch(/<p[^>]*font-size: 13pt[^>]*color: #ffd966[^>]*>FAST LABEL<\/p>/);
  const after = await current();
  await page.reload();
  await expect(label).toBeVisible({ timeout:30000 });
  await expectThirteenPointGold();
  writeFileSync(info.outputPath('font-colour-readback.json'), JSON.stringify({ before, after, reopened:await current(),
    savedParagraph:/<p[^>]*>FAST LABEL<\/p>/.exec(readFileSync(file, 'utf8'))?.[0] }, null,2));
  expect(errors).toEqual([]);
});
