/**
 * What the usability waves before the beta tripped over (11 Oct 2026), on slides and whiteboards:
 * - a bulleted list made in a paragraph box: the box becomes a <div> with the first save (a <ul>
 *   inside a <p> was pushed out of the box by the parser after a reload);
 * - Tab in a list item nests it and the keyboard stays in the text (it went to the speaker notes);
 * - a run of letters typed at the canvas is typing, not tool shortcuts (stray lines, point editing);
 * - "List items one by one" and then Appear on that list does not hide its first items until a
 *   click of the list's own;
 * - a sticky note takes what is typed (the note stayed empty, and the board ignored Ctrl+Z after).
 * Needs the seeded admin.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { login, collectErrors, texDoc, PROJECTS_DIR } from './helpers';

const RUN = Date.now().toString(36);
const PROJECT = `admin/e2e-betafix-${RUN}`;
const DIR = `${PROJECTS_DIR}/${PROJECT}`;
const FILE = `${DIR}/talk/index.html`;
const BOARD = `${DIR}/plan.board`;
const fileText = () => readFileSync(FILE, 'utf8');

const DECK = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="overlyx" content="deck"><title>Tunnelling</title>
<style>body { margin: 0; background: #dfe3ea; font-family: system-ui, sans-serif; } .slide { width: 1280px; height: 720px; position: relative; overflow: hidden; background: #fff; margin: 0 auto 40px; }</style>
</head><body>
<section class="slide">
  <p id="t" style="position: absolute; left: 100px; top: 100px; width: 600px; margin: 0; font-size: 30px">Classical<br>Quantum<br>Wave</p>
  <ul id="l" style="position: absolute; left: 100px; top: 440px; width: 500px; margin: 0; font-size: 30px"><li>One</li><li>Two</li><li>Three</li></ul>
  <div id="v" style="position: absolute; left: 760px; top: 80px; width: 420px; height: 240px; background: #dde6f3; font-size: 30px">Banner title<br>Some <b>authors</b> here</div>
</section>
</body></html>
`;

test.describe.configure({ mode: 'serial' });
test.beforeAll(() => {
  mkdirSync(`${DIR}/talk`, { recursive: true });
  writeFileSync(`${DIR}/main.tex`, texDoc('Fixes.'));
  writeFileSync(FILE, DECK);
  writeFileSync(BOARD, '{"overlyx":"board","v":1,"objects":{\n}}\n');
});
test.afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const slide = (page: Page) => page.frameLocator('.dl-frame').locator('section.slide').first();
async function at(page: Page, x: number, y: number): Promise<[number, number]> {
  const b = (await slide(page).boundingBox())!;
  const k = b.width / 1280;
  return [b.x + x * k, b.y + y * k];
}
const real = (errors: string[]) => errors.filter(e => !/localStorage/.test(e));

test('slides: a bulleted paragraph box, Tab in a list, letters typed at the canvas, a list one by one', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  expect((await page.request.get('/api/projects')).ok()).toBeTruthy();   // registers the directory
  await page.goto(`/#/${PROJECT}/talk/index.html`);
  await slide(page).waitFor({ timeout: 30000 });
  await page.waitForTimeout(900);
  await page.locator('[data-tb="dk-select"]').click();

  // the paragraph box: retyped, all its text selected, made a bulleted list — saved as a <div> at once
  await page.mouse.dblclick(...await at(page, 160, 120));
  await page.keyboard.press('Control+a');
  await page.locator('[data-tb="dk-ul"]').click();
  await expect.poll(fileText, { timeout: 15000 }).toMatch(/<div id="t"[^>]*><ul>/);
  expect(fileText()).not.toMatch(/<p id="t"[^>]*>\s*<ul/);

  // Tab on the last item nests it; the keyboard stays in the box (not the speaker notes)
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Tab');
  await page.keyboard.type(' tunnels');
  await expect(page.locator('[data-dl-notes]')).not.toBeFocused();
  await expect(page.locator('[data-dl-notes]')).toHaveValue('');
  await expect.poll(() => (/<div id="t"[^>]*>([\s\S]*?)<\/div>/.exec(fileText())?.[1].match(/<ul/g) ?? []).length, { timeout: 15000 }).toBe(2);
  expect(fileText()).toContain('tunnels');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // after a reload the list is still in its box
  await page.reload();
  await slide(page).waitFor({ timeout: 30000 });
  await expect(slide(page).locator('#t li')).toHaveCount(3);

  // letters typed at the canvas with nothing selected: typing, not tools — the pointer stays, a hint says how
  await page.waitForTimeout(600);
  await page.mouse.click(...await at(page, 1100, 650));
  const objects = await slide(page).locator(':scope > *').count();
  await page.keyboard.type('Gamma rays', { delay: 40 });
  await expect(page.locator('[data-tb="dk-select"]')).toHaveClass(/active/);
  await expect(page.locator('body')).toContainText('To type on the slide, double-click a text box');
  await page.mouse.click(...await at(page, 1000, 600));
  await page.waitForTimeout(400);
  expect(await slide(page).locator(':scope > *').count()).toBe(objects);

  // the list's items one by one, then Appear with the list selected: the list itself gets no click of its own
  await page.locator('[data-tb="dk-step"]').click();
  await expect(page.locator('[data-dl-anim]')).toBeVisible();
  await page.mouse.click(...await at(page, 200, 470));
  await page.locator('[data-anim-list]').click();   // (controlled by the canvas's answer, not at once)
  await expect.poll(fileText, { timeout: 15000 }).toMatch(/<ul id="l"[^>]*data-steps="/);
  await page.locator('[data-anim-add="appear"]').click();
  await page.waitForTimeout(800);
  expect(fileText()).not.toMatch(/<ul id="l"[^>]*\sdata-step="/);

  // a banner (a shape with text) aligned to its middle: its two lines stay two lines, the bold word in its line
  await page.mouse.click(...await at(page, 1100, 300));
  await page.locator('[data-tb="dk-align"]').click();
  await page.locator('[data-palette="dk-align"] .tb-pal-item', { hasText: 'Middle' }).click();
  await expect.poll(fileText, { timeout: 15000 }).toMatch(/<div id="v" style="[^"]*display: flex; flex-direction: column; justify-content: center[^"]*"><span class="ol-va">Banner title<br>Some <b>authors<\/b> here<\/span><\/div>/);
  const lines = await slide(page).locator('#v .ol-va').evaluate(e => { const r = document.createRange(); r.selectNodeContents(e); return new Set([...r.getClientRects()].map(x => Math.round(x.top))).size; });
  expect(lines).toBe(2);
  expect(real(errors)).toEqual([]);
});

test('whiteboard: a sticky note takes what is typed; Ctrl+Z undoes a stroke, Ctrl+Shift+Z brings it back', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  await page.goto(`/#/${PROJECT}/plan.board`);
  await page.waitForSelector('.board-tools', { timeout: 30000 });
  await expect(page.locator('.board-conn')).toContainText(/live|view/, { timeout: 20000 });
  const vp = (await page.locator('.board').boundingBox())!;
  const cx = vp.x + vp.width / 2, cy = vp.y + vp.height / 2;

  await page.click('[data-tool="note"]');
  await page.mouse.click(cx - 150, cy - 100);
  await page.keyboard.type('Pump 2 bar, 20 C', { delay: 20 });
  await page.waitForTimeout(1200);   // renders meanwhile (presence) must not empty it
  await expect(page.locator('.board-note-edit')).toHaveValue('Pump 2 bar, 20 C');
  await page.mouse.click(cx + 200, cy + 150);
  await expect(page.locator('.board-note')).toContainText('Pump 2 bar, 20 C');
  await expect.poll(() => readFileSync(BOARD, 'utf8'), { timeout: 15000 }).toContain('Pump 2 bar, 20 C');

  await page.click('[data-tool="pen"]');
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(cx + i * 10, cy + (i % 2 ? 8 : -8), { steps: 2 });
  await page.mouse.up();
  await expect(page.locator('.board-stroke:not(.live)')).toHaveCount(1);
  await page.keyboard.press('Control+z');
  await expect(page.locator('.board-stroke:not(.live)')).toHaveCount(0);
  await page.keyboard.press('Control+Shift+z');
  await expect(page.locator('.board-stroke:not(.live)')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('Edit ▸ Math: toggle inline/display acts on the formula being edited, not the one beside the caret', async ({ page }) => {
  const errors = collectErrors(page);
  writeFileSync(`${DIR}/toggle.tex`, texDoc('Before.\n\n\\begin{equation}\n\\Omega=1\\label{eq:mono}\n\\end{equation}\nfixes the sign.\n\nThe Hamiltonian is $H=B\\sigma$ here, see \\eqref{eq:mono}.'));
  await login(page);
  await page.request.get('/api/projects');
  await page.goto(`/#/${PROJECT}/toggle.tex`);
  await page.waitForSelector('.lyx-editor .lyx-math-inline', { timeout: 30000 });
  // the document's caret right after the display equation, then a click into the inline formula
  await page.locator('.lyx-editor .lyx-par', { hasText: 'fixes the sign' }).click();
  await page.keyboard.press('Home');
  await page.locator('.lyx-editor .lyx-math-inline').first().click();
  await expect(page.locator('.lyx-math-inline .lm-input:focus, .lyx-math-inline.focused, .lyx-math-inline .focused')).not.toHaveCount(0);
  await page.locator('.menubar .menu button', { hasText: 'Edit' }).click();
  await page.locator('.menu-item:visible', { hasText: 'Math: toggle inline/display' }).click();
  const file = `${DIR}/toggle.tex`;
  await page.keyboard.press('Control+s');
  await expect.poll(() => readFileSync(file, 'utf8'), { timeout: 15000 }).toMatch(/\\\[\s*H=B\\sigma\s*\\\]/);
  expect(readFileSync(file, 'utf8')).toMatch(/\\begin\{equation\}[\s\S]*\\label\{eq:mono\}[\s\S]*\\end\{equation\}/);
  expect(errors).toEqual([]);
});

test('End at the end of an exponent leaves the exponent, not the formula', async ({ page }) => {
  const errors = collectErrors(page);
  writeFileSync(`${DIR}/endkey.tex`, texDoc('Energy:\n\n\\[\nE=m\n\\]\nafter.'));
  await login(page);
  await page.request.get('/api/projects');
  await page.goto(`/#/${PROJECT}/endkey.tex`);
  await page.waitForSelector('.lyx-editor .lyx-math-display', { timeout: 30000 });
  const f = page.locator('.lyx-editor .lyx-math-display').first();
  await f.hover(); await f.click();
  await expect(page.locator('.lm-field.focused')).toHaveCount(1);
  await page.keyboard.press('End');
  await page.keyboard.type('c^2');
  await page.keyboard.press('End');        // out of the exponent, still in the formula
  await page.keyboard.type('+1');
  await expect(page.locator('.lm-field.focused')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+s');
  await expect.poll(() => readFileSync(`${DIR}/endkey.tex`, 'utf8'), { timeout: 15000 }).toMatch(/E=mc\^\{2\}\+1/);
  expect(readFileSync(`${DIR}/endkey.tex`, 'utf8')).toContain('after.');
  expect(errors).toEqual([]);
});

test('a formula from the toolbar takes spaces as TeX spaces: "E = mc^2" stays one formula', async ({ page }) => {
  const errors = collectErrors(page);
  writeFileSync(`${DIR}/spaces.tex`, texDoc('Einstein wrote'));
  await login(page);
  await page.request.get('/api/projects');
  await page.goto(`/#/${PROJECT}/spaces.tex`);
  await page.waitForSelector('.lyx-editor .lyx-par', { timeout: 30000 });
  await page.locator('.lyx-editor .lyx-par', { hasText: 'Einstein wrote' }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' ');
  await page.locator('[data-tb="math"]').first().click();
  await expect(page.locator('.lm-field.focused')).toHaveCount(1);
  await page.keyboard.type('E = mc^2');
  await page.keyboard.press('ArrowRight');   // out of the exponent
  await page.keyboard.press('ArrowRight');   // out of the formula
  await page.keyboard.type(' in 1905.');
  await page.keyboard.press('Control+s');
  await expect.poll(() => readFileSync(`${DIR}/spaces.tex`, 'utf8'), { timeout: 15000 }).toContain('Einstein wrote $E=mc^{2}$ in 1905.');
  expect(errors).toEqual([]);
});
