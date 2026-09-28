/**
 * Layout documents (pages of positioned objects, editor/layout): a new slide deck from File ▸ New
 * slides / poster / page…, drawing a text box and typing into it (a formula too), selecting, moving
 * and resizing a shape with the mouse, undo, the Layout toolbar's z-order and fill, what lands in the
 * .tex file (a plain beamer document), the presentation with its overlay steps, and the font size box
 * in an ordinary document (text, a formula, table cells). Needs the seeded admin.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { login, texDoc, collectErrors, PROJECTS_DIR } from './helpers';

const PROJECT = 'admin/e2e-layout';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;

test.describe.configure({ mode: 'serial' });

const SLIDES = String.raw`\documentclass[aspectratio=169]{beamer}
\definecolor{jblue}{RGB}{2,61,107}
\begin{document}
\begin{frame}[plain]
\olshape{x=20mm,y=20mm,w=30mm,h=20mm,vb=0 0 30 20,fill=jblue,name=Blue}{M 0 0 L 30 0 L 30 20 L 0 20 Z}
\begin{olbox}{x=70mm,y=20mm,w=60mm,h=10mm,font=14pt}
First words
\end{olbox}
\olshape{x=20mm,y=55mm,w=30mm,h=20mm,vb=0 0 30 20,fill=red,step=2-,name=Later}{M 0 0 L 30 0 L 30 20 L 0 20 Z}
\end{frame}

\begin{frame}[plain]
\begin{olbox}{x=10mm,y=10mm,w=100mm,h=20mm,font=24pt}
Second page
\end{olbox}
\end{frame}
\end{document}
`;

const TOOLS = String.raw`\documentclass[aspectratio=169]{beamer}
\begin{document}
\begin{frame}[plain]
\olshape{x=20mm,y=20mm,w=30mm,h=30mm,vb=0 0 30 30,fill=blue!20,draw=blue,name=Circle}{M 30 15 C 30 23.28 23.28 30 15 30 C 6.72 30 0 23.28 0 15 C 0 6.72 6.72 0 15 0 C 23.28 0 30 6.72 30 15 Z}
\olimage{x=80mm,y=20mm,w=40mm,h=30mm,name=Pic}{pic.png}
\end{frame}
\end{document}
`;

test.beforeAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${DIR}/main.tex`, texDoc('Some text here and a formula $x^{2}$ in it.\n\n\\begin{tabular}{cc}\na & b\\tabularnewline\nc & d\\tabularnewline\n\\end{tabular}'));
  writeFileSync(`${DIR}/slides.tex`, SLIDES);
  writeFileSync(`${DIR}/present.tex`, SLIDES);
  writeFileSync(`${DIR}/tools.tex`, TOOLS);
  // a 40 × 30 px PNG for the crop test
  writeFileSync(`${DIR}/pic.png`, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACgAAAAeCAIAAADRv8uKAAAAKklEQVR4nO3NMQ0AAAgDsAmb/yALGXA06d9MeyJisVgsFovFYrFYLP4bL9HP3Ew1mJ9PAAAAAElFTkSuQmCC', 'base64'));
});
test.afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

async function openLayout(page: Page, file: string): Promise<void> {
  await page.goto(`/#/${PROJECT}/${file}`);
  await page.waitForSelector('.lyx-editor.ol-layout .ol-page', { timeout: 30000 });
  await page.waitForTimeout(800);
}
const fileText = (name: string) => readFileSync(`${DIR}/${name}`, 'utf8');

test('a new slide deck from the File menu is a beamer file of layout pages', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  await page.goto(`/#/${PROJECT}/main.tex`);
  await page.waitForSelector('.lyx-editor .lyx-par');
  await page.locator('.menubar').getByText('File', { exact: true }).click();
  await page.getByText('New slides / poster / page…').click();
  await page.locator('[data-preset="slides43"]').click();
  await page.locator('[data-layout-name]').fill('talk.tex');
  await page.locator('[data-create-layout]').click();
  await page.waitForSelector('.lyx-editor.ol-layout .ol-page', { timeout: 30000 });
  await expect(page.locator('.ol-page')).toHaveCount(2);
  await expect(page.locator('[data-toolbar="layout"]')).toBeVisible();
  const text = fileText('talk.tex');
  expect(text).toContain('\\documentclass[aspectratio=43]{beamer}');
  expect(text).toContain('\\newenvironment{olbox}');
  expect(text).toMatch(/\\begin\{frame\}\[plain\]\n\\begin\{olbox\}/);
  expect(errors).toEqual([]);
});

test('draw a text box, type with a formula, move and resize a shape, undo', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  await openLayout(page, 'slides.tex');
  const pg = (await page.locator('.ol-page').first().boundingBox())!;
  const pxPerMm = pg.width / 160;

  // the text tool: drag a box, type into it
  await page.locator('[data-tb="ol-t-text"]').click();
  await page.mouse.move(pg.x + 70 * pxPerMm, pg.y + 45 * pxPerMm);
  await page.mouse.down();
  await page.mouse.move(pg.x + 140 * pxPerMm, pg.y + 60 * pxPerMm, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.type('Hello $x^2$ layout');
  await expect(page.locator('.ol-box').nth(1)).toContainText('Hello');
  await expect(page.locator('.ol-box').nth(1).locator('.lyx-math-inline')).toHaveCount(1);
  await expect.poll(() => fileText('slides.tex'), { timeout: 15000 }).toContain('Hello $x^{2}$ layout');
  expect(fileText('slides.tex')).toMatch(/\\begin\{olbox\}\{x=70mm,y=45mm,w=70mm,h=[\d.]+mm,grow\}\nHello \$x\^\{2\}\$ layout\n\\end\{olbox\}/);

  // Esc leaves the text for the box, Esc again deselects; a click selects the blue shape
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  const blue = page.locator('.ol-shape').first();
  const b0 = (await blue.boundingBox())!;
  await page.mouse.click(b0.x + b0.width / 2, b0.y + b0.height / 2);
  await expect(page.locator('.ol-selframe')).toHaveCount(1);
  // drag it 10 mm right, 5 mm down (Alt: no snapping)
  await page.keyboard.down('Alt');
  await page.mouse.move(b0.x + b0.width / 2, b0.y + b0.height / 2);
  await page.mouse.down();
  await page.mouse.move(b0.x + b0.width / 2 + 10 * pxPerMm, b0.y + b0.height / 2 + 5 * pxPerMm, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await expect.poll(() => fileText('slides.tex'), { timeout: 15000 }).toMatch(/\\olshape\{x=30mm,y=25mm,w=30mm,h=20mm,[^}]*name=Blue\}/);
  // the east handle: 10 mm wider
  const h = (await page.locator('.ol-h-e').first().boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.keyboard.down('Alt'); await page.keyboard.up('Alt');
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 + 10 * pxPerMm, h.y + h.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => fileText('slides.tex'), { timeout: 15000 }).toMatch(/\\olshape\{x=30mm,y=25mm,w=40mm,h=20mm,/);
  // arrow keys nudge by 1 mm
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => fileText('slides.tex'), { timeout: 15000 }).toMatch(/\\olshape\{x=29mm,y=25mm,w=40mm/);
  // undo twice: the width comes back
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await expect.poll(() => fileText('slides.tex'), { timeout: 15000 }).toMatch(/\\olshape\{x=30mm,y=25mm,w=30mm,h=20mm,/);
  expect(errors).toEqual([]);
});

test('toolbar: bring to front and fill colour; a rectangle drawn with the shape tool', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  await openLayout(page, 'slides.tex');
  const blue = page.locator('.ol-shape').first();
  const b = (await blue.boundingBox())!;
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await page.locator('[data-tb="ol-front"]').click();
  // the blue shape is drawn last now (written last on its page)
  await expect.poll(() => { const t = fileText('slides.tex'); const page1 = t.slice(t.indexOf('\\begin{frame}'), t.indexOf('\\end{frame}')); return page1.lastIndexOf('name=Blue') > page1.lastIndexOf('\\end{olbox}'); }, { timeout: 15000 }).toBe(true);
  await page.locator('[data-tb="ol-fill"]').click();
  await page.locator('[data-palette="ol-fill"] [data-color="orange"]').click();
  await expect.poll(() => fileText('slides.tex'), { timeout: 15000 }).toMatch(/fill=orange,name=Blue/);

  await page.keyboard.press('Escape');
  await page.keyboard.press('r');
  const pg = (await page.locator('.ol-page').first().boundingBox())!;
  const pxPerMm = pg.width / 160;
  await page.mouse.move(pg.x + 100 * pxPerMm, pg.y + 65 * pxPerMm);
  await page.keyboard.down('Alt');
  await page.mouse.down();
  await page.mouse.move(pg.x + 120 * pxPerMm, pg.y + 80 * pxPerMm, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await expect.poll(() => fileText('slides.tex'), { timeout: 15000 }).toMatch(/\\olshape\{x=100mm,y=65mm,w=20mm,h=15mm,vb=0 0 20 15,fill=\[HTML\]DCE9F7,draw=\[HTML\]2F5597,line=0.8pt\}\{M 0 0 L 20 0 L 20 15 L 0 15 Z\}/);
  expect(errors).toEqual([]);
});

test('editing a box stays in the box: Ctrl+A and typing replace only its text; the right-click menu on objects', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  await openLayout(page, 'slides.tex');
  const box = page.locator('.ol-box', { hasText: 'First words' });
  const bb = (await box.boundingBox())!;
  await page.mouse.dblclick(bb.x + 10, bb.y + bb.height / 2);
  await page.keyboard.press('Control+a');
  await page.keyboard.type('Replaced');
  await expect.poll(() => fileText('slides.tex'), { timeout: 15000 }).toMatch(/\n\\begin\{olbox\}\{x=70mm,y=20mm,w=60mm,h=10mm,font=14pt\}\nReplaced\n\\end\{olbox\}/);
  expect(fileText('slides.tex')).toContain('Second page');
  await expect(page.locator('.ol-page')).toHaveCount(2);
  // the arrows stop at the box's edge (the caret stays in it)
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowDown');
  await page.keyboard.type('!');
  await expect.poll(() => fileText('slides.tex'), { timeout: 15000 }).toContain('\nReplaced!\n');
  await page.keyboard.press('Escape');
  // right-click on the red shape: its menu; Delete removes it
  const red = page.locator('.ol-shape:has(path[fill="#ff0000"])');
  const rb = (await red.boundingBox())!;
  await page.mouse.click(rb.x + rb.width / 2, rb.y + rb.height / 2, { button: 'right' });
  await page.locator('.ctx-menu .ctx-label', { hasText: /^Delete$/ }).click();
  await expect.poll(() => fileText('slides.tex'), { timeout: 15000 }).not.toContain('name=Later');
  // on the empty page: a text box there
  const pg = (await page.locator('.ol-page').first().boundingBox())!;
  await page.mouse.click(pg.x + pg.width * 0.1, pg.y + pg.height * 0.85, { button: 'right' });
  await page.locator('.ctx-menu .ctx-label', { hasText: 'Text box here' }).click();
  await page.keyboard.type('Corner note');
  await expect.poll(() => fileText('slides.tex'), { timeout: 15000 }).toContain('Corner note');
  expect(errors).toEqual([]);
});

test('a raw LaTeX object is typeset with the document\'s preamble and shown as its image', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  await openLayout(page, 'slides.tex');
  await page.locator('[data-tb="ol-raw"]').click();
  await expect(page.locator('.ol-rawedit-code')).toBeVisible();
  await page.locator('.ol-rawedit-code').fill('\\begin{tikzpicture}\\fill[jblue] (0,0) circle (5mm);\\end{tikzpicture}');
  await page.keyboard.press('Control+Enter');
  await expect(page.locator('.ol-raw.ol-rendered')).toHaveCount(1, { timeout: 60000 });
  await expect.poll(() => fileText('slides.tex'), { timeout: 15000 }).toMatch(/\\begin\{olraw\}\{[^}]*\}\n\\begin\{tikzpicture\}\\fill\[jblue\] \(0,0\) circle \(5mm\);\\end\{tikzpicture\}\n\\end\{olraw\}/);
  expect(errors).toEqual([]);
});

test('the node editor moves a node with its handles; the crop tool crops from an edge', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  await openLayout(page, 'tools.tex');
  const pg = (await page.locator('.ol-page').first().boundingBox())!;
  const mm = pg.width / 160;
  const circle = (await page.locator('.ol-shape').first().boundingBox())!;
  await page.mouse.dblclick(circle.x + circle.width / 2, circle.y + circle.height / 2);
  await expect(page.locator('.ol-node')).toHaveCount(5);
  await expect(page.locator('.ol-ctl')).toHaveCount(8);
  // the first node (the right-most point) 5 mm further right: the box grows by 5 mm
  const node = (await page.locator('.ol-node').first().boundingBox())!;
  await page.mouse.move(node.x + node.width / 2, node.y + node.height / 2);
  await page.mouse.down();
  await page.mouse.move(node.x + node.width / 2 + 5 * mm, node.y + node.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => fileText('tools.tex'), { timeout: 15000 }).toMatch(/\\olshape\{x=20mm,y=20mm,w=35(\.\d+)?mm,h=30mm,vb=0 0 35(\.\d+)? 30,[^}]*name=Circle\}\{M 35(\.\d+)? 15 C 35/);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  // crop: double-click the image, the west handle 10 mm to the right
  const img = (await page.locator('.ol-image').first().boundingBox())!;
  await page.mouse.dblclick(img.x + img.width / 2, img.y + img.height / 2);
  const w = (await page.locator('.ol-crop-h.ol-h-w').boundingBox())!;
  await page.mouse.move(w.x + w.width / 2, w.y + w.height / 2);
  await page.mouse.down();
  await page.mouse.move(w.x + w.width / 2 + 10 * mm, w.y + w.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => fileText('tools.tex'), { timeout: 15000 }).toMatch(/\\olimage\{x=90mm,y=20mm,w=30mm,h=30mm,crop=0\.25 0 0 0,name=Pic\}\{pic\.png\}/);
  expect(errors).toEqual([]);
});

test('presentation: F5, overlay steps, the next page, Esc', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  await openLayout(page, 'present.tex');
  const pg = (await page.locator('.ol-page').first().boundingBox())!;
  await page.mouse.click(pg.x + pg.width - 8, pg.y + pg.height - 8);   // empty page: focus, nothing selected
  await page.keyboard.press('F5');
  await expect(page.locator('.ol-present')).toBeVisible();
  // step 1: the red shape (step=2-) is hidden
  await expect(page.locator('.ol-present .ol-shape.ol-hidden')).toHaveCount(1);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.ol-present .ol-shape.ol-hidden')).toHaveCount(0);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.ol-present-stage')).toContainText('Second page');
  await page.keyboard.press('Escape');
  await expect(page.locator('.ol-present')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the font size box: text, a formula as a whole, table cells', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  await page.goto(`/#/${PROJECT}/main.tex`);
  await page.waitForSelector('.lyx-editor > .lyx-par');
  await page.waitForTimeout(600);
  const par = page.locator('.lyx-editor > .lyx-par').first();
  const pb = (await par.boundingBox())!;
  await page.mouse.click(pb.x + 2, pb.y + pb.height / 2);
  await page.keyboard.press('Home');
  for (let i = 0; i < 9; i++) await page.keyboard.press('Shift+ArrowRight');
  await page.locator('.fs-input').click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('12');
  await page.keyboard.press('Enter');
  await expect.poll(() => fileText('main.tex'), { timeout: 15000 }).toContain('{\\large Some text}');
  // the formula: in it, "−" twice (10 → 9 → 8 pt at the article's 10 pt)
  const f = (await page.locator('.lyx-math-inline').first().boundingBox())!;
  await page.mouse.click(f.x + f.width / 2, f.y + f.height / 2);
  await page.locator('.fs-step').first().click();
  await page.locator('.fs-step').first().click();
  await expect.poll(() => fileText('main.tex'), { timeout: 15000 }).toContain('{\\footnotesize $x^{2}$}');
  // table cells: a drag across them, 14 pt (no named size at 10 pt: \fontsize)
  const cells = page.locator('.lyx-tabular td');
  const c0 = (await cells.first().boundingBox())!, c3 = (await cells.last().boundingBox())!;
  await page.mouse.move(c0.x + 4, c0.y + c0.height / 2); await page.mouse.down();
  await page.mouse.move(c3.x + c3.width - 4, c3.y + c3.height / 2, { steps: 6 }); await page.mouse.up();
  await page.locator('.fs-input').click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('14');
  await page.keyboard.press('Enter');
  await expect.poll(() => fileText('main.tex'), { timeout: 15000 }).toContain('{\\fontsize{14}{16.8}\\selectfont a}');
  expect(errors).toEqual([]);
});
