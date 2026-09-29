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

// beamer's overlays in a text box: an item from slide 2, a phrase only on slide 3
const OVERLAYS = String.raw`\documentclass[aspectratio=169]{beamer}
\begin{document}
\begin{frame}[plain]
\begin{olbox}{x=10mm,y=10mm,w=120mm,h=60mm,font=14pt}
\begin{itemize}
\item<1-> Point one
\item<2-> Point two
\end{itemize}
\only<3>{Only on three}
\end{olbox}
\end{frame}
\end{document}
`;

// an ordinary (linear) beamer deck: title from the preamble, frames with overlays
const DECK = String.raw`\documentclass[aspectratio=169]{beamer}
\title{Deck title}
\author{Somebody}
\begin{document}
\begin{frame}
\titlepage
\end{frame}

\begin{frame}{Incremental}
\begin{itemize}[<+->]
\item First
\item Second
\end{itemize}
Before \pause after the pause.
\end{frame}

\begin{frame}{Only and alert}
\only<1>{On one.}\only<2>{On two.} \alert<2>{Alerted on two.}
\begin{columns}
\column{0.5\textwidth}
Left column
\column{0.5\textwidth}
Right column
\end{columns}
\end{frame}
\end{document}
`;

// TeX's lines in text boxes: a display formula alone in a centred box, a top-aligned line of text
const TEXLINES = String.raw`\documentclass[aspectratio=169]{beamer}
\begin{document}
\begin{frame}[plain]
\begin{olbox}{x=10mm,y=10mm,w=100mm,h=30mm,font=20pt,leading=1.2,valign=c,fill=blue!10}
\[
x^{2}+y^{2}=z^{2}
\]
\end{olbox}
\begin{olbox}{x=10mm,y=50mm,w=100mm,h=20mm,font=20pt,leading=1.2}
Hello world
\end{olbox}
\end{frame}
\end{document}
`;

// selecting: two shapes above a text box
const SELECT = String.raw`\documentclass[aspectratio=169]{beamer}
\begin{document}
\begin{frame}[plain]
\olshape{x=30mm,y=20mm,w=25mm,h=20mm,vb=0 0 25 20,fill=blue,name=A}{M 0 0 L 25 0 L 25 20 L 0 20 Z}
\olshape{x=60mm,y=20mm,w=25mm,h=20mm,vb=0 0 25 20,fill=red,name=B}{M 0 0 L 25 0 L 25 20 L 0 20 Z}
\begin{olbox}{x=20mm,y=50mm,w=70mm,h=15mm,font=14pt}
Some words in a box
\end{olbox}
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
  writeFileSync(`${DIR}/zoom.tex`, SLIDES);
  writeFileSync(`${DIR}/overlays.tex`, OVERLAYS);
  writeFileSync(`${DIR}/deck.tex`, DECK);
  writeFileSync(`${DIR}/texlines.tex`, TEXLINES);
  writeFileSync(`${DIR}/select.tex`, SELECT);
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

test('a layout document opens with its whole page in the window; a pinch (Ctrl + wheel) zooms about the pointer', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  await openLayout(page, 'zoom.tex');
  const scroller = (await page.locator('.editor-scroll').boundingBox())!;
  const pg0 = (await page.locator('.ol-page').first().boundingBox())!;
  // the whole page is visible (both sides) and the status bar says so
  expect(pg0.width).toBeLessThanOrEqual(scroller.width);
  expect(pg0.height).toBeLessThanOrEqual(scroller.height);
  await expect(page.locator('.zoom-select')).toHaveValue('fit');
  // zoom in about a point of the page: that point stays under the pointer
  const px = pg0.x + pg0.width * 0.3, py = pg0.y + pg0.height * 0.4;
  await page.mouse.move(px, py);
  await page.keyboard.down('Control');
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -20); await page.waitForTimeout(30); }
  await page.keyboard.up('Control');
  await page.waitForTimeout(300);
  const pg1 = (await page.locator('.ol-page').first().boundingBox())!;
  expect(pg1.width).toBeGreaterThan(pg0.width * 1.5);
  expect(Math.abs(pg1.x + pg1.width * 0.3 - px)).toBeLessThan(6);
  expect(Math.abs(pg1.y + pg1.height * 0.4 - py)).toBeLessThan(6);
  await expect(page.locator('.zoom-select')).not.toHaveValue('fit');
  // Ctrl+Minus steps out, Fit goes back to the whole page
  await page.keyboard.press('Control+Minus');
  await page.waitForTimeout(200);
  expect((await page.locator('.ol-page').first().boundingBox())!.width).toBeLessThan(pg1.width);
  await page.selectOption('.zoom-select', 'fit');
  await page.waitForTimeout(200);
  expect(Math.abs((await page.locator('.ol-page').first().boundingBox())!.width - pg0.width)).toBeLessThan(2);
  expect(errors).toEqual([]);
});

test("presentation: beamer's overlays in a box's text (\\item<2->, \\only<3>)", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  await openLayout(page, 'overlays.tex');
  const pg = (await page.locator('.ol-page').first().boundingBox())!;
  await page.mouse.click(pg.x + pg.width - 8, pg.y + pg.height - 8);
  await page.keyboard.press('F5');
  await expect(page.locator('.ol-present')).toBeVisible();
  await expect(page.locator('.ol-present-counter')).toContainText('1/3');
  const item2 = page.locator('.ol-present .lyx-par', { hasText: 'Point two' });
  const only = page.locator('.ol-present .lyx-inset', { hasText: 'Only on three' });
  await expect(item2).toHaveClass(/ol-hidden/);
  await expect(only).toBeHidden();
  await page.keyboard.press('ArrowRight');
  await expect(item2).not.toHaveClass(/ol-hidden/);
  await expect(only).toBeHidden();
  await page.keyboard.press('ArrowRight');
  await expect(only).toBeVisible();
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('an ordinary beamer deck: F5 presents its frames — title page, incremental lists, pauses, \\only, \\alert, columns', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  await page.goto(`/#/${PROJECT}/deck.tex`);
  await page.waitForSelector('.lyx-editor .lyx-par[data-layout="Frame"]', { timeout: 30000 });
  await page.waitForTimeout(800);
  // the frame title is labelled as LyX does
  await expect(page.locator('.lyx-inset-argument[data-arg="4"] .inset-label').first()).toHaveText('Frame title');
  await page.locator('.lyx-editor .lyx-par').first().click();
  await page.keyboard.press('F5');
  await expect(page.locator('.ol-present')).toBeVisible();
  // the title page from the preamble's \title and \author
  await expect(page.locator('.ol-present-stage .bm-tp-title')).toHaveText('Deck title');
  await expect(page.locator('.ol-present-stage .bm-tp-author')).toHaveText('Somebody');
  await page.keyboard.press('ArrowRight');
  // [<+->]: the items one per slide; the text after \pause on the slide after them
  await expect(page.locator('.ol-present-stage .bm-frametitle')).toHaveText('Incremental');
  const second = page.locator('.ol-present-stage .lyx-par', { hasText: 'Second' });
  const afterPause = page.locator('.ol-present-stage .ol-ov-after-pause');
  await expect(page.locator('.ol-present-counter')).toContainText('1/4');
  await expect(second).toHaveClass(/ol-hidden/);
  await page.keyboard.press('ArrowRight');
  await expect(second).not.toHaveClass(/ol-hidden/);
  await expect(afterPause).toHaveClass(/ol-hidden/);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(afterPause).not.toHaveClass(/ol-hidden/);
  await page.keyboard.press('ArrowRight');
  // \only / \alert, and two columns side by side
  await expect(page.locator('.ol-present-stage .bm-frametitle')).toHaveText('Only and alert');
  const onOne = page.locator('.ol-present-stage .lyx-inset[data-arg="Only"]', { hasText: 'On one.' });
  const onTwo = page.locator('.ol-present-stage .lyx-inset[data-arg="Only"]', { hasText: 'On two.' });
  await expect(onOne).toBeVisible();
  await expect(onTwo).toBeHidden();
  const cols = page.locator('.ol-present-stage .bm-column');
  await expect(cols).toHaveCount(2);
  const [a, b] = [(await cols.nth(0).boundingBox())!, (await cols.nth(1).boundingBox())!];
  expect(b.x).toBeGreaterThan(a.x + a.width * 0.8);
  await page.keyboard.press('ArrowRight');
  await expect(onTwo).toBeVisible();
  await expect(onOne).toBeHidden();
  await expect(page.locator('.ol-present-stage .ol-ov-alert')).toContainText('Alerted on two');
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

test("text boxes set their lines as TeX does: the first line's letters at the top, a display formula below TeX's empty line", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  await openLayout(page, 'texlines.tex');
  await expect(page.locator('.ol-page .lyx-math-display.ol-disp-first.ol-disp-last mjx-container')).toBeVisible({ timeout: 15000 });
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector('.lyx-editor')!).getPropertyValue('--ol-tex-lines').trim())).toBe('1');
  const m = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll<HTMLElement>('.ol-page .ol-box')];
    const disp = boxes[0], text = boxes[1];
    const r = (e: Element) => e.getBoundingClientRect();
    const math = disp.querySelector('mjx-math')!, par = disp.querySelector('.lyx-par')!, display = disp.querySelector('.lyx-math-display')!;
    // the text box's first baseline: a range's box reaches the font's descent below it
    const content = text.querySelector<HTMLElement>('.ol-box-content')!;
    const node = text.querySelector('.lyx-par')!.firstChild!;
    const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, 5);
    const cs = getComputedStyle(content), f = parseFloat(cs.fontSize);
    const ctx = document.createElement('canvas').getContext('2d')!;
    ctx.font = `100px ${cs.fontFamily}`;
    const tm = ctx.measureText('bdfhklAT');
    const baseline = range.getBoundingClientRect().bottom - tm.fontBoundingBoxDescent / 100 * f;
    return {
      mathCentre: (r(math).top + r(math).bottom) / 2, boxCentre: (r(disp).top + r(disp).bottom) / 2,
      trailing: r(par).bottom - r(display).bottom,
      firstBaseline: baseline - r(content).top, tallest: tm.actualBoundingBoxAscent / 100 * f,
    };
  });
  // TeX puts an empty line above a display that starts a paragraph: in a centred box the formula sits below the middle
  expect(m.mathCentre).toBeGreaterThan(m.boxCentre + 1);
  // and nothing after one that ends it (ProseMirror's trailing break takes no room)
  expect(Math.abs(m.trailing)).toBeLessThan(1);
  // the first baseline is as far below the box's top as the tallest letters reach (TeX's first line), not half the leading + the font's ascent
  expect(Math.abs(m.firstBaseline - m.tallest)).toBeLessThan(1.5);
  expect(errors).toEqual([]);
});

test('selecting like Inkscape: a click on nothing deselects, rubber bands from the canvas and with Shift, Ctrl locks the axis, Space leaves a copy; an arrow pointer', async ({ page }) => {
  const errors = collectErrors(page);
  await login(page);
  await openLayout(page, 'select.tex');
  const pg = (await page.locator('.ol-page').first().boundingBox())!;
  const at = (x: number, y: number): [number, number] => [pg.x + x / 160 * pg.width, pg.y + y / 90 * pg.height];
  const frames = page.locator('.ol-selframe:not(.ol-thin):not(.ol-union)');
  // the shapes by name — the first one: a copy left by Space comes later in the page
  const state = () => page.evaluate(() => {
    const v = (window as any).overlyx.activeView;
    const shapes: Record<string, { x: number; y: number }> = {};
    let count = 0;
    v.state.doc.descendants((n: any) => { if (n.type.name === 'ol_shape') { count++; if (n.attrs.name && !shapes[n.attrs.name]) shapes[n.attrs.name] = { x: n.attrs.x, y: n.attrs.y }; } return true; });
    return { sel: v.state.selection.constructor.name.replace(/^_/, ''), editing: !!document.querySelector('.ol-editing'), frames: document.querySelectorAll('.ol-selframe').length, count, shapes, text: v.state.doc.textContent };
  });
  const cursorAt = (x: number, y: number) => page.evaluate(([cx, cy]) => getComputedStyle(document.elementFromPoint(cx, cy)!).cursor, at(x, y));

  // an arrow over the page and over objects — not the text cursor
  expect(await cursorAt(120, 75)).toBe('default');
  expect(await cursorAt(40, 30)).toBe('default');
  expect(await cursorAt(30, 57)).toBe('default');

  // a click on an object selects it; the page does not move when the toolbar follows the selection
  await page.mouse.click(...at(40, 30));
  await expect(frames).toHaveCount(1);
  expect(Math.abs((await page.locator('.ol-page').first().boundingBox())!.y - pg.y)).toBeLessThan(1);
  // a click beside the page: nothing selected (and no caret dropped into a box); Delete then deletes nothing
  await page.mouse.click(pg.x - 20, pg.y + pg.height / 2);
  let s = await state();
  expect(s).toMatchObject({ sel: 'GapCursor', editing: false, frames: 0 });
  await page.keyboard.press('Delete');
  await page.keyboard.type('q');
  s = await state();
  expect(s.count).toBe(2);
  expect(s.text).not.toContain('q');

  // editing the box: the text cursor over it; a click on an empty spot of the page leaves it
  await page.mouse.click(...at(30, 57));
  await page.mouse.click(...at(30, 57));
  await expect(page.locator('.ol-editing')).toHaveCount(1);
  expect(await cursorAt(30, 57)).toBe('text');
  await page.mouse.click(...at(120, 75));
  expect(await state()).toMatchObject({ sel: 'GapCursor', editing: false, frames: 0 });

  // a rubber band that starts beside the page selects what it encloses
  const [lx, ly] = [pg.x - 15, at(0, 12)[1]];
  await page.mouse.move(lx, ly); await page.mouse.down();
  for (let i = 1; i <= 8; i++) { const [tx, ty] = at(95, 45); await page.mouse.move(lx + (tx - lx) * i / 8, ly + (ty - ly) * i / 8); }
  await page.mouse.up();
  await expect(page.locator('.ol-selframe.ol-union')).toHaveCount(1);
  await expect(page.locator('.ol-selframe.ol-thin')).toHaveCount(2);
  // Shift+click takes one out again
  await page.keyboard.down('Shift'); await page.mouse.click(...at(40, 30)); await page.keyboard.up('Shift');
  await expect(frames).toHaveCount(1);
  await page.mouse.click(pg.x - 20, pg.y + 20);
  await expect(page.locator('.ol-selframe')).toHaveCount(0);
  // with Shift a drag that starts on an object is a rubber band too
  const [bx, by] = at(22, 62), [ex, ey] = at(95, 15);
  await page.keyboard.down('Shift');
  await page.mouse.move(bx, by); await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(bx + (ex - bx) * i / 8, by + (ey - by) * i / 8);
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await expect(page.locator('.ol-selframe.ol-thin')).toHaveCount(2);
  s = await state();
  expect(s.shapes.A).toEqual({ x: 30, y: 20 });   // nothing moved
  await page.mouse.click(pg.x - 20, pg.y + 20);

  // Ctrl while dragging (Inkscape): only horizontally, though the pointer wanders up and down
  const [ax0, ay0] = at(40, 30);
  await page.mouse.move(ax0, ay0); await page.mouse.down();
  await page.keyboard.down('Control');
  for (const [dx, dy] of [[10, 3], [25, -4], [40, 6], [60, 5]]) await page.mouse.move(ax0 + dx, ay0 + dy);
  await page.mouse.up();
  await page.keyboard.up('Control');
  s = await state();
  expect(s.shapes.A.y).toBe(20);
  expect(s.shapes.A.x).toBeGreaterThan(35);
  // pressed while the pointer rests, it applies at once: pressed, the drag snaps back onto the axis
  const bStart = s.shapes.B;
  const [b0x, b0y] = at(bStart.x + 10, bStart.y + 10);
  await page.mouse.move(b0x, b0y); await page.mouse.down();
  await page.mouse.move(b0x + 8, b0y + 30); await page.mouse.move(b0x + 10, b0y + 40);
  await page.keyboard.down('Control');
  const mid = await state();
  expect(mid.shapes.B.x).toBe(bStart.x);
  expect(mid.shapes.B.y).toBeGreaterThan(bStart.y);
  await page.keyboard.up('Control');
  // Space leaves a copy where the object is at that moment, and the drag goes on
  await page.keyboard.press(' ');
  await page.mouse.move(b0x + 10, b0y + 80);
  await page.mouse.up();
  s = await state();
  expect(s.count).toBe(3);
  expect(s.shapes.B.y).toBeGreaterThan(mid.shapes.B.y);
  await page.keyboard.press('Control+z');
  expect((await state()).count).toBe(2);
  expect(errors).toEqual([]);
});
