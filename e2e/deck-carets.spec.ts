/**
 * Two people on one slide deck (deliverable runtime carets.ts / edit.ts, webHost awareness): while
 * one retypes a text box, the other sees their caret — a bar in their colour with their name — where
 * it really is, the words they select, also past a formula (a chip for the one typing, MathJax for
 * the other), and nothing once they leave the box; the rail shows who is on which slide. In a beamer
 * Layout document the text boxes are the document's own text: the remote caret is y-prosemirror's.
 * Needs the seeded admin and u1.
 */
import { test, expect, type Page, type Browser, type Frame } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { login, userCredentials, shareProject, BASE_URL, PROJECTS_DIR } from './helpers';
import { starterDeck } from '../packages/core/src/html/deliverable';

const RUN = Date.now().toString(36);
const created: string[] = [];
test.afterAll(() => { for (const p of created) rmSync(`${PROJECTS_DIR}/${p}`, { recursive: true, force: true }); });

async function twoPeople(browser: Browser, project: string, file: string): Promise<[Page, Page]> {
  await shareProject(browser, project, ['u1']);
  const pages: Page[] = [];
  for (const who of [undefined, userCredentials('u1')]) {
    const ctx = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1300, height: 850 } });
    const p = await ctx.newPage();
    await login(p, who);
    await p.goto(`/#/${project}/${file}`);
    pages.push(p);
  }
  return [pages[0], pages[1]];
}

const canvas = async (p: Page): Promise<Frame> => (await (await p.locator('.dl-frame').elementHandle())!.contentFrame())!;
const rail = async (p: Page): Promise<Frame> => (await (await p.locator('.dl-railframe').elementHandle())!.contentFrame())!;
type Drawn = { name: string; x: number; y: number; h: number; selected: number };
const carets = async (p: Page): Promise<Drawn[]> => (await canvas(p)).evaluate('window.__ol.peerCarets()') as Promise<Drawn[]>;
/** where the caret of the one typing is (page px of their frame: both frames lay the slide out alike) */
const ownCaret = async (p: Page): Promise<{ x: number; y: number }> => (await canvas(p)).evaluate(`(() => {
  const r = getSelection().getRangeAt(0).cloneRange(); r.collapse(false);
  const q = r.getClientRects()[0] || r.getBoundingClientRect();
  return { x: q.left + scrollX, y: q.top + scrollY };
})()`) as Promise<{ x: number; y: number }>;

test('a deck: the other person\'s caret, selection and slide', async ({ browser }) => {
  test.setTimeout(120000);
  const project = `admin/e2e-carets-${RUN}`;
  created.push(project);
  mkdirSync(`${PROJECTS_DIR}/${project}/talk`, { recursive: true });
  writeFileSync(`${PROJECTS_DIR}/${project}/talk/index.html`, starterDeck('Carets'));
  const [a, b] = await twoPeople(browser, project, 'talk/index.html');
  for (const p of [a, b]) await p.frameLocator('.dl-frame').locator('section.slide').first().waitFor({ timeout: 30000 });
  await a.waitForTimeout(1200);

  // Admin retypes the subtitle and types at its end
  await a.frameLocator('.dl-frame').locator('section.slide').first().locator('p.muted').dblclick();
  await a.waitForTimeout(300);
  await a.keyboard.press('End');
  await a.keyboard.type(' and more', { delay: 30 });
  await expect.poll(async () => (await carets(b)).length, { timeout: 10000 }).toBe(1);
  await expect.poll(async () => (await carets(b))[0].x, { timeout: 10000 }).toBeGreaterThan(0);
  // where it really is: the text arrived first, then the caret placed in it
  const mine = await ownCaret(a);
  await expect.poll(async () => Math.abs((await carets(b))[0].x - mine.x), { timeout: 10000 }).toBeLessThan(3);
  const seen = (await carets(b))[0];
  expect(seen.name).toBe('Admin');
  expect(Math.abs(seen.y - mine.y)).toBeLessThan(6);
  expect(seen.selected).toBe(0);

  // a word selected: highlighted for the other
  await a.keyboard.press('Shift+Control+ArrowLeft');
  await expect.poll(async () => (await carets(b))[0]?.selected ?? 0, { timeout: 10000 }).toBeGreaterThan(0);

  // the rail: Admin on the first slide
  await expect.poll(async () => (await rail(b)).evaluate('window.__ol.railPeers()'), { timeout: 10000 }).toEqual([{ slide: 0, name: 'Admin' }]);

  // done: the caret goes
  await a.keyboard.press('Escape');
  await expect.poll(async () => (await carets(b)).length, { timeout: 10000 }).toBe(0);

  // past a formula: a chip for Admin, MathJax's output for U1 — one place in both
  await a.frameLocator('.dl-railframe').locator('section.slide').nth(1).click();
  await expect.poll(async () => (await rail(b)).evaluate('window.__ol.railPeers()'), { timeout: 10000 }).toEqual([{ slide: 1, name: 'Admin' }]);
  await b.frameLocator('.dl-railframe').locator('section.slide').nth(1).click();
  await expect(b.frameLocator('.dl-frame').locator('section.slide').nth(1).locator('mjx-container')).toHaveCount(1, { timeout: 15000 });
  const li = a.frameLocator('.dl-frame').locator('section.slide').nth(1).locator('li').nth(1);
  const lb = (await li.boundingBox())!;
  // (a double click on the item's first word: the list is retyped, the caret in that word)
  await a.mouse.dblclick(lb.x + 12, lb.y + lb.height / 2);
  await a.waitForTimeout(500);
  await a.keyboard.press('End');
  await a.keyboard.type(' ok', { delay: 30 });
  const atEnd = await ownCaret(a);
  await expect.poll(async () => Math.abs(((await carets(b))[0]?.x ?? -99) - atEnd.x), { timeout: 10000 }).toBeLessThan(3);
  // after the formula (its right edge, page px)
  const fpage = await (await canvas(b)).evaluate(`(() => { const r = document.querySelectorAll('section.slide')[1].querySelectorAll('li')[1].querySelector('mjx-container').getBoundingClientRect(); return r.right + scrollX; })()`) as number;
  expect((await carets(b))[0].x).toBeGreaterThan(fpage);
  await a.keyboard.press('Escape');
  await expect.poll(async () => (await carets(b)).length, { timeout: 10000 }).toBe(0);
  await a.context().close();
  await b.context().close();
});

test('a beamer layout document: the other person\'s caret in a text box', async ({ browser }) => {
  test.setTimeout(120000);
  const project = `admin/e2e-carets-layout-${RUN}`;
  created.push(project);
  mkdirSync(`${PROJECTS_DIR}/${project}`, { recursive: true });
  writeFileSync(`${PROJECTS_DIR}/${project}/slides.tex`, String.raw`\documentclass[aspectratio=169]{beamer}
\begin{document}
\begin{frame}[plain]
\begin{olbox}{x=20mm,y=20mm,w=100mm,h=20mm,font=20pt}
First words of the box
\end{olbox}
\end{frame}
\end{document}
`);
  const [a, b] = await twoPeople(browser, project, 'slides.tex');
  for (const p of [a, b]) await p.locator('.lyx-editor .ol-box').first().waitFor({ timeout: 30000 });
  await a.waitForTimeout(1000);
  await a.locator('.lyx-editor .ol-box-content').first().dblclick();
  await a.keyboard.press('End');
  await a.keyboard.type(' typed', { delay: 30 });
  const remote = b.locator('.lyx-editor .ol-box .ProseMirror-yjs-cursor');
  await expect(remote).toHaveCount(1, { timeout: 10000 });
  await expect(remote).toContainText('Admin');
  await expect(remote).toBeVisible();
  // beside the text typed
  const word = b.locator('.lyx-editor .ol-box-content').first();
  await expect(word).toContainText('First words of the box typed');
  const cb = (await remote.boundingBox())!, wb = (await word.boundingBox())!;
  const mid = cb.y + cb.height / 2;
  expect(mid).toBeGreaterThan(wb.y);
  expect(mid).toBeLessThan(wb.y + wb.height);
  expect(cb.x).toBeGreaterThan(wb.x + wb.width / 3);
  await a.context().close();
  await b.context().close();
});
