/**
 * HTML deliverables (deliverable/DeliverableEditor.tsx, its runtime in the sandboxed frame, server
 * deliverables.ts): a deck made from File ▸ New slides / poster / page…, then on the canvas — an
 * object selected and dragged, text retyped in place, a text box drawn, an object deleted and the
 * deletion undone, a new slide from the rail, speaker notes, the code view, a change written to the
 * file by somebody else (an agent) shown live, presenting. What lands in index.html each time.
 * Needs the seeded admin.
 */
import { test, expect, type Page } from '@playwright/test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { login, collectErrors, BASE_URL, PROJECTS_DIR } from './helpers';

const RUN = Date.now().toString(36);
const NAME = `e2e-deck-${RUN}`;
const PROJECT = `admin/${NAME}`;
const FILE = `${PROJECTS_DIR}/${PROJECT}/talk/index.html`;
const fileText = () => readFileSync(FILE, 'utf8');

test.describe.configure({ mode: 'serial' });
test.afterAll(() => rmSync(`${PROJECTS_DIR}/${PROJECT}`, { recursive: true, force: true }));

const frame = (page: Page) => page.frameLocator('.dl-frame');
const slides = (page: Page) => frame(page).locator('section.slide');

async function open(page: Page): Promise<void> {
  await page.goto(`/#/${PROJECT}/talk/index.html`);
  await slides(page).first().waitFor({ timeout: 30000 });
  await expect(slides(page).first().locator('h1 mjx-container, h1')).not.toHaveCount(0);
  await page.waitForTimeout(800);
}

/** the page's own errors: MathJax's note that the sandboxed frame has no localStorage is not one */
const real = (errors: string[]) => errors.filter(e => !/localStorage/.test(e));

test('a deck from the New dialog: select, drag, retype, draw, delete and undo', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  expect((await page.request.post(BASE_URL + '/api/projects', { data: { name: NAME } })).ok()).toBeTruthy();
  writeFileSync(`${PROJECTS_DIR}/${PROJECT}/main.tex`, '\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n');
  await page.goto(`/#/${PROJECT}/main.tex`);
  await page.waitForSelector('.lyx-editor .lyx-par', { timeout: 30000 });
  await page.locator('.menubar').getByText('File', { exact: true }).click();
  await page.getByText('New slides / poster / page…').click();
  await page.locator('.ol-newkind[data-kind="deck"]').click();
  await page.locator('[data-deliverable-title]').fill('Light and matter');
  await page.locator('[data-deliverable-folder]').fill('talk');
  await page.locator('[data-create-deliverable]').click();
  await expect(page).toHaveURL(new RegExp(`#/${PROJECT}/talk/index\\.html$`));
  await slides(page).first().waitFor({ timeout: 30000 });
  expect(fileText()).toContain('<meta name="overlyx" content="deck">');
  expect(fileText()).toContain('<title>Light and matter</title>');
  await expect(slides(page)).toHaveCount(2);
  // the formula typeset
  await expect(slides(page).nth(1).locator('mjx-container')).toHaveCount(1, { timeout: 15000 });
  // the rail shows both slides
  await expect(page.frameLocator('.dl-railframe').locator('section.slide')).toHaveCount(2, { timeout: 15000 });

  // select the title: the toolbar shows its size; drag it
  const h1 = slides(page).first().locator('h1');
  await h1.click();
  await expect(page.locator('[data-dk-size] input')).toHaveValue('64');
  const b = (await h1.boundingBox())!;
  const scale = b.width / 1040;
  await page.mouse.move(b.x + 40, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 40 + 30 * scale, b.y + b.height / 2 + 20 * scale, { steps: 4 });
  await page.mouse.move(b.x + 40 + 60 * scale, b.y + b.height / 2 + 40 * scale, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => /<h1 style="([^"]*)">/.exec(fileText())?.[1], { timeout: 15000 }).toMatch(/left: 1[78]\dpx; top: 2[89]\dpx; width: 1040px/);
  const left = Number(/<h1 style="[^"]*left: (\d+)px/.exec(fileText())![1]);
  expect(Math.abs(left - 180)).toBeLessThan(6);

  // double-click the subtitle and retype the end of it
  const sub = slides(page).first().locator('p.muted');
  await sub.dblclick();
  await page.keyboard.press('End');
  await page.keyboard.type(' — OverLyX');
  await expect.poll(fileText, { timeout: 15000 }).toContain('Your name · Venue · Date — OverLyX</p>');
  await page.keyboard.press('Escape');

  // a text box drawn: click with the T tool on the first slide, type over its "Text"
  await page.locator('[data-tb="dk-text"]').click();
  const s1 = (await slides(page).first().boundingBox())!;
  await page.mouse.click(s1.x + s1.width * 0.1, s1.y + s1.height * 0.8);
  await expect.poll(fileText, { timeout: 15000 }).toMatch(/<p style="position: absolute; left: \d+px; top: \d+px; width: 520px; margin: 0">Text<\/p>\n<\/section>/);
  await page.waitForTimeout(600);
  await page.keyboard.type('A new box');
  await expect.poll(fileText, { timeout: 15000 }).toContain('margin: 0">A new box</p>');
  await page.keyboard.press('Escape');

  // the decorative shape on slide 2: selected, deleted, the deletion undone
  const shape = slides(page).nth(1).locator('div[style*="border-radius: 24px"]');
  await shape.scrollIntoViewIfNeeded();
  await shape.click();
  // the contextual toolbar: a selected object brings its tools (Delete among them)
  await expect(page.locator('.dl-toolbar [data-tb="dk-delete"]')).toBeEnabled();
  await page.keyboard.press('Delete');
  await expect.poll(fileText, { timeout: 15000 }).not.toContain('border-radius: 24px');
  await page.keyboard.press('Control+z');
  await expect.poll(fileText, { timeout: 15000 }).toContain('border-radius: 24px');
  expect(real(errors)).toEqual([]);
});

test('slides from the rail, speaker notes, the code view, a change on disk shown live, presenting', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  await open(page);
  // a new slide after the first: the design of the first, its text gone
  await page.frameLocator('.dl-railframe').locator('section.slide').first().click();
  await page.locator('[data-dl-newslide]').click();
  await expect(slides(page)).toHaveCount(3, { timeout: 15000 });
  await expect.poll(() => (fileText().match(/<section class="slide">/g) ?? []).length, { timeout: 15000 }).toBe(3);
  expect(fileText()).toMatch(/<\/section>\n\n<section class="slide">\n {2}<div class="bar"[^\n]*\n {2}<h1 [^>]*>Title<\/h1>\n<\/section>\n\n<section/);

  // speaker notes of the slide in view (scroll to the last one)
  await page.frameLocator('.dl-railframe').locator('section.slide').nth(2).click();
  await page.waitForTimeout(500);
  const notes = page.locator('[data-dl-notes]');
  await expect(notes).toHaveValue('Speaker notes go here.');
  await notes.fill('Mention the experiment.');
  await notes.blur();
  await expect.poll(fileText, { timeout: 15000 }).toContain('<aside class="notes">Mention the experiment.</aside>');

  // the code view: an edit there shows on the canvas
  await page.locator('[data-dl-code]').click();
  const code = page.locator('[data-dl-codearea]');
  await expect(code).toHaveValue(/<!doctype html>/);
  const v = await code.inputValue();
  const at = v.indexOf('One message per slide');
  await code.focus();
  await code.evaluate((ta: HTMLTextAreaElement, i: number) => { ta.setSelectionRange(i, i + 3); }, at);
  await page.keyboard.type('Just one');
  await expect(slides(page).nth(2).locator('li').first()).toHaveText('Just one message per slide', { timeout: 15000 });
  await expect.poll(fileText, { timeout: 15000 }).toContain('<li>Just one message per slide</li>');
  await page.locator('[data-dl-code]').click();

  // somebody else (an agent) writes the file: the canvas shows it
  writeFileSync(FILE, fileText().replace('>The idea</h2>', '>The wave</h2>'));
  await expect(slides(page).nth(2).locator('h2')).toHaveText('The wave', { timeout: 15000 });

  // presenting from the first slide (chosen in the rail): one at a time, the arrow keys, Escape ends it
  await page.frameLocator('.dl-railframe').locator('section.slide').first().click();
  await page.waitForTimeout(300);
  await page.locator('[data-dl-present]').click();
  const pres = page.frameLocator('.dl-presenting iframe');
  await expect(pres.locator('section.slide[data-ol-current]')).toHaveCount(1, { timeout: 15000 });
  await expect(pres.locator('section.slide').nth(0)).toHaveAttribute('data-ol-current');
  await page.keyboard.press('ArrowRight');
  await expect(pres.locator('section.slide').nth(1)).toHaveAttribute('data-ol-current');
  await expect(pres.locator('section.slide').nth(0)).not.toHaveAttribute('data-ol-current');
  await page.keyboard.press('Escape');
  await expect(page.locator('.dl-presenting')).toHaveCount(0, { timeout: 10000 });
  expect(real(errors)).toEqual([]);
});

test('the PDF and the website download', async ({ page }) => {
  await login(page);
  const q = `?path=${encodeURIComponent('talk/index.html')}`;
  const pdf = await page.request.get(`${BASE_URL}/api/projects/${encodeURIComponent(PROJECT)}/deliverable-pdf${q}`);
  expect(pdf.status()).toBe(200);
  const buf = await pdf.body();
  expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
  expect((buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length).toBe(3);
  const zip = await page.request.get(`${BASE_URL}/api/projects/${encodeURIComponent(PROJECT)}/deliverable-zip${q}`);
  expect(zip.status()).toBe(200);
  const z = await zip.body();
  expect(z.subarray(0, 2).toString()).toBe('PK');
  expect(z.toString('latin1')).toContain('_overlyx/runtime.js');
});
