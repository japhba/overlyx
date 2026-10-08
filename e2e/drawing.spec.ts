/**
 * Drawing on layout pages: connectors (editor/layout/connectors.ts) — an arrow drawn from one object's
 * connection point to another's stays attached when the objects move and lets go when one goes; the
 * objects list (objects.ts) — select, hide, rename; guides and the grid (guides.ts) — a guide dragged
 * out of the ruler and back, the grid shown; an SVG pasted as shapes and an SVG picture converted to
 * shapes (svgimport.ts). What lands in the .tex file each time. Needs the seeded admin.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { login, collectErrors, PROJECTS_DIR, grantClipboard, browserName } from './helpers';

const PROJECT = `admin/e2e-drawing-${Date.now().toString(36)}`;
const DIR = `${PROJECTS_DIR}/${PROJECT}`;

test.describe.configure({ mode: 'serial' });

const DECK = String.raw`\documentclass[aspectratio=169]{beamer}
\begin{document}
\begin{frame}[plain]
\olshape{x=20mm,y=20mm,w=30mm,h=20mm,vb=0 0 30 20,fill=white,draw=black,name=A}{M 0 0 L 30 0 L 30 20 L 0 20 Z}
\olshape{x=100mm,y=50mm,w=30mm,h=20mm,vb=0 0 30 20,fill=white,draw=black,name=B}{M 0 0 L 30 0 L 30 20 L 0 20 Z}
\begin{olbox}{x=20mm,y=70mm,w=60mm,h=10mm,font=14pt}
Some words
\end{olbox}
\end{frame}

\begin{frame}[plain]
\olimage{x=40mm,y=20mm,w=60mm,h=40mm,name=Icon}{icon.svg}
\end{frame}

\end{document}
`;

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="60" height="40" viewBox="0 0 60 40"><rect x="2" y="2" width="26" height="36" fill="#e8a33d"/><circle cx="45" cy="20" r="12" fill="#2f5597"/></svg>`;

test.beforeAll(() => {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${DIR}/deck.tex`, DECK);
  writeFileSync(`${DIR}/shapes.tex`, DECK);
  writeFileSync(`${DIR}/icon.svg`, ICON);
});
test.afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const fileText = (name: string) => readFileSync(`${DIR}/${name}`, 'utf8');
const shown = (page: Page) => page.locator('.lyx-editor .ol-page-wrap.ol-shown');

async function open(page: Page, file: string): Promise<{ x: number; y: number; mm: number }> {
  await page.evaluate(() => { try { localStorage.removeItem('ol.objects'); localStorage.removeItem('ol.canvas.grid'); localStorage.removeItem('ol.canvas.rulers'); localStorage.removeItem('ol.canvas.guides'); localStorage.removeItem('ol.canvas.snapGrid'); } catch { /* */ } });
  await page.goto(`/#/${PROJECT}/${file}`);
  await page.waitForSelector('.lyx-editor .ol-page-wrap.ol-shown .ol-page', { timeout: 30000 });
  await page.waitForTimeout(600);
  const b = (await shown(page).locator('section.ol-page').boundingBox())!;
  return { x: b.x, y: b.y, mm: b.width / 160 };
}

test('connectors: an arrow from one object\'s connection point to another\'s follows them, and lets go of one deleted', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  const p = await open(page, 'deck.tex');
  const at = (x: number, y: number) => [p.x + x * p.mm, p.y + y * p.mm] as const;
  await page.locator('[data-tb="ol-t-arrow"]').click();
  // over A: its connection points show
  await page.mouse.move(...at(35, 30));
  await expect(shown(page).locator('.ol-site')).toHaveCount(5);
  // from A's right edge to B's left edge
  await page.mouse.move(...at(50, 30));
  await page.mouse.down();
  await page.mouse.move(...at(80, 45), { steps: 4 });
  await page.mouse.move(...at(100, 60), { steps: 4 });
  await expect(shown(page).locator('.ol-site.ol-site-on')).toHaveCount(2);
  await page.mouse.up();
  await expect.poll(() => fileText('deck.tex'), { timeout: 15000 }).toMatch(/arrows=-Stealth,from=o1\.e,to=o2\.w\}\{M 0 0 L 50 30\}/);
  expect(fileText('deck.tex')).toMatch(/name=A,id=o1\}/);
  // the arrow selected: its two ends, both attached
  await expect(shown(page).locator('.ol-endpt.ol-endpt-on')).toHaveCount(2);

  // B moved down 10 mm (arrow keys): the arrow follows
  await page.mouse.click(...at(115, 52));
  await page.keyboard.press('Shift+ArrowDown');
  await expect.poll(() => fileText('deck.tex'), { timeout: 15000 }).toMatch(/from=o1\.e,to=o2\.w\}\{M 0 0 L 50 40\}/);
  // B deleted: the arrow keeps its place and lets go of it
  await page.keyboard.press('Delete');
  await expect.poll(() => fileText('deck.tex'), { timeout: 15000 }).toMatch(/arrows=-Stealth,from=o1\.e\}\{M 0 0 L 50 40\}/);
  // undo: B and the attachment come back
  await page.keyboard.press('Control+z');
  await expect.poll(() => fileText('deck.tex'), { timeout: 15000 }).toMatch(/from=o1\.e,to=o2\.w\}/);
  expect(errors).toEqual([]);
});

test('the objects list: select, hide and rename; the master-less page\'s objects top-most first', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  await open(page, 'deck.tex');
  await page.locator('[data-tb="ol-objects"]').click();
  const rows = page.locator('.ol-objects .ol-objects-row');
  await expect(page.locator('.ol-objects')).toBeVisible();
  // top-most first: the arrow of the test before, then the text box
  await expect(rows.locator('.ol-objects-name')).toHaveText(['Connector', 'Some words', 'B', 'A']);
  const a = rows.filter({ hasText: /^A$/ });
  await a.locator('.ol-objects-name').click();
  await expect(shown(page).locator('.ol-selframe')).toHaveCount(1);
  await expect(a).toHaveClass(/selected/);
  // the eye: hidden on the canvas and in the file
  await a.hover();
  await a.locator('.ol-objects-eye').click();
  await expect(shown(page).locator(':scope > section.ol-page > .ol-shape.ol-hidden-obj')).toHaveCount(1);
  await expect.poll(() => fileText('deck.tex'), { timeout: 15000 }).toMatch(/name=A,id=o1,hide\}/);
  // a double click renames
  await rows.nth(1).locator('.ol-objects-name').dblclick();
  await page.keyboard.type('Caption');
  await page.keyboard.press('Enter');
  await expect.poll(() => fileText('deck.tex'), { timeout: 15000 }).toMatch(/font=14pt,name=Caption\}\nSome words/);
  await page.locator('.ol-objects-close').click();
  await expect(page.locator('.ol-objects')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('guides and the grid: a guide out of the ruler, kept in the file; back onto the ruler, gone; the grid shown', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  const p = await open(page, 'deck.tex');
  const ruler = (await page.locator('.ol-ruler-top').boundingBox())!;
  await page.mouse.move(p.x + 60 * p.mm, ruler.y + ruler.height / 2);
  await page.mouse.down();
  await page.mouse.move(p.x + 60 * p.mm, p.y + 25 * p.mm, { steps: 4 });
  await page.mouse.move(p.x + 60 * p.mm, p.y + 30 * p.mm, { steps: 4 });
  await page.mouse.up();
  await expect(shown(page).locator('.ol-guideline-y')).toHaveCount(1);
  await expect.poll(() => fileText('deck.tex'), { timeout: 15000 }).toMatch(/"overlyx_guides":"y(29\.\d|30(\.\d)?)"/);
  // dragged back onto the ruler: gone
  const g = (await shown(page).locator('.ol-guideline-y').boundingBox())!;
  await page.mouse.move(g.x + g.width / 3, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + g.width / 3, ruler.y + ruler.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(shown(page).locator('.ol-guideline-y')).toHaveCount(0);
  await expect.poll(() => fileText('deck.tex'), { timeout: 15000 }).toContain('"overlyx_guides":""');
  // the grid, from the Grid and guides palette
  await page.locator('[data-tb="ol-grid"]').click();
  await page.locator('[data-ol-pref="grid"]').check();
  await expect(shown(page).locator('.ol-grid')).toHaveCount(1);
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('an SVG pasted becomes shapes; an SVG picture converted to shapes in its place', async ({ page, context }) => {
  test.skip(browserName(page) !== 'chromium', 'the clipboard API (Chromium)');
  const errors = collectErrors(page);
  await grantClipboard(context);
  await login(page);
  const p = await open(page, 'shapes.tex');
  // nothing selected, the SVG's markup as text on the clipboard
  await page.mouse.click(p.x + 150 * p.mm, p.y + 5 * p.mm);
  await page.evaluate(t => navigator.clipboard.writeText(t), ICON);
  await page.keyboard.press('Control+v');
  await expect(shown(page).locator(':scope > section.ol-page > .ol-group .ol-shape')).toHaveCount(2);
  await expect.poll(() => fileText('shapes.tex'), { timeout: 15000 }).toMatch(/\\begin\{olgroup\}\{\}\n\\olshape\{[^}]*fill=\[HTML\]E8A33D[^}]*\}[^\n]*\n\\olshape\{[^}]*fill=\[HTML\]2F5597/);

  // the second slide's SVG picture: Convert to shapes (its menu)
  await page.locator('.ol-slide-rail .ol-rail-item').nth(1).click();
  const img = shown(page).locator('.ol-image');
  await expect(img).toHaveCount(1);
  await img.click({ button: 'right' });
  await page.locator('.ctx-menu .ctx-item', { hasText: 'Convert to shapes' }).click();
  await expect(shown(page).locator('.ol-image')).toHaveCount(0);
  await expect(shown(page).locator(':scope > section.ol-page > .ol-group .ol-shape')).toHaveCount(2);
  await expect.poll(() => fileText('shapes.tex'), { timeout: 15000 }).not.toContain('icon.svg');
  expect(errors).toEqual([]);
});
