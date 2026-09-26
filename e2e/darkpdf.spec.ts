/**
 * Dark PDF pages (app/pdfdark.ts): in the dark theme the PDF pane shows the pages light on dark —
 * the paper in the editor's page colour, colours keeping their hue — while a photograph keeps its
 * colours; the ◐ switch in the PDF toolbar (only in the dark theme) goes back to the PDF's own colours.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { login, collectErrors, PROJECTS_DIR, texDoc } from './helpers';

const PROJECT = 'admin/e2e-darkpdf';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;

test.beforeAll(async ({ browser }) => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  // a colourful photograph and a plot on white, drawn in a canvas
  const p = await browser.newPage();
  const [photo, plot] = await p.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 480; c.height = 320;
    const x = c.getContext('2d')!;
    const g = x.createLinearGradient(0, 0, 480, 320); g.addColorStop(0, '#1e6fd9'); g.addColorStop(0.5, '#f2b233'); g.addColorStop(1, '#2a8a3a');
    x.fillStyle = g; x.fillRect(0, 0, 480, 320);
    for (let i = 0; i < 3000; i++) { x.fillStyle = `hsla(${(i * 37) % 360},70%,${30 + (i % 40)}%,0.5)`; x.fillRect((i * 97) % 480, (i * 53) % 320, 6, 6); }
    const d = document.createElement('canvas'); d.width = 480; d.height = 320;
    const y = d.getContext('2d')!;
    y.fillStyle = '#fff'; y.fillRect(0, 0, 480, 320);
    y.strokeStyle = '#1f5fbf'; y.lineWidth = 3; y.beginPath(); for (let i = 0; i <= 420; i++) { const v = 150 - 100 * Math.sin(i / 40); i ? y.lineTo(40 + i, v) : y.moveTo(40, v); } y.stroke();
    return [c.toDataURL('image/jpeg', 0.92), d.toDataURL('image/png')];
  });
  await p.close();
  writeFileSync(`${DIR}/photo.jpg`, Buffer.from(photo.split(',')[1], 'base64'));
  writeFileSync(`${DIR}/plot.png`, Buffer.from(plot.split(',')[1], 'base64'));
  // a PDF figure (as \includegraphics of a matplotlib PDF): a flat, light heat map beside a grainy photograph, on white
  const fig = await browser.newPage();
  const [heat, grain] = await fig.evaluate(() => {
    const h = document.createElement('canvas'); h.width = 64; h.height = 64;
    const a = h.getContext('2d')!;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { a.fillStyle = (x + y) % 2 ? '#ffd0a0' : '#a8ccff'; a.fillRect(x * 8, y * 8, 8, 8); }
    const g = document.createElement('canvas'); g.width = 256; g.height = 256;
    const b = g.getContext('2d')!;
    const img = b.createImageData(256, 256);
    // grain a few pixels across, as a photograph has detail at every scale (single-pixel noise would average out when drawn smaller)
    for (let i = 0; i < img.data.length; i += 4) { const p = i / 4, cell = ((p % 256) >> 3) + 97 * ((p >> 8) >> 3); const v = (Math.sin(cell * 12.9898) * 43758.5453 % 1 + 1) % 1; img.data[i] = 60 + v * 150; img.data[i + 1] = 90 + v * 120; img.data[i + 2] = 40 + v * 90; img.data[i + 3] = 255; }
    b.putImageData(img, 0, 0);
    return [h.toDataURL('image/png'), g.toDataURL('image/png')];
  });
  await fig.setContent(`<body style="margin:0;background:#fff"><div style="display:flex;gap:90px;padding:70px 90px"><img src="${heat}" style="width:140px;height:140px;image-rendering:pixelated"><img src="${grain}" style="width:140px;height:140px"></div><div style="margin:0 90px;border-top:2px solid #000"></div></body>`);
  writeFileSync(`${DIR}/fig.pdf`, await fig.pdf({ width: '600px', height: '300px', printBackground: true }));
  await fig.close();
  writeFileSync(`${DIR}/figure.tex`, texDoc('\\begin{figure}[h]\\centering\\includegraphics[width=0.9\\linewidth]{fig.pdf}\\caption{A PDF figure.}\\end{figure}', '\\usepackage{graphicx}'));
  writeFileSync(`${DIR}/main.tex`, texDoc([
    'Dark pages: \\textcolor{red}{red text} and black text.',
    '',
    '\\begin{figure}[h]\\centering\\includegraphics[width=0.45\\linewidth]{photo.jpg}\\hfill\\includegraphics[width=0.45\\linewidth]{plot.png}\\caption{A photograph and a plot.}\\end{figure}',
  ].join('\n'), '\\usepackage{graphicx}\n\\usepackage{xcolor}'));
});
test.afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

/** RGB of the first page's canvas at fractions (fx, fy) of its size */
const pixel = (page: Page, fx: number, fy: number) => page.evaluate(([fx, fy]) => {
  const c = document.querySelector<HTMLCanvasElement>('.pdf-pane .pdf-page-box canvas.ready')!;
  const d = c.getContext('2d')!.getImageData(Math.floor(c.width * fx), Math.floor(c.height * fy), 1, 1).data;
  return [d[0], d[1], d[2]];
}, [fx, fy]);
/** where the photograph is: the centre of the most colourful pixels (as fractions of the canvas) */
const photoSpot = (page: Page) => page.evaluate(() => {
  const c = document.querySelector<HTMLCanvasElement>('.pdf-pane .pdf-page-box canvas.ready')!;
  const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < c.height; y += 3) for (let x = 0; x < c.width; x += 3) {
    const i = (y * c.width + x) * 4, max = Math.max(d[i], d[i + 1], d[i + 2]), min = Math.min(d[i], d[i + 1], d[i + 2]);
    if (max > 60 && (max - min) / max > 0.5) { sx += x; sy += y; n++; }
  }
  return [sx / n / c.width, sy / n / c.height];
});
const near = (a: number[], b: number[], tol: number) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

test('dark pages: the paper in the page colour, colours keep their hue, the photograph its colours; ◐ switches back', async ({ page }) => {
  const errors = collectErrors(page);
  await page.addInitScript(() => { try { const p = JSON.parse(localStorage.getItem('ol.prefs') || '{}'); p.autoBuild = 'off'; delete p.darkPdf; localStorage.setItem('ol.prefs', JSON.stringify(p)); localStorage.setItem('ol.theme', 'light'); } catch { /* ignore */ } });
  await login(page);
  await page.goto(`/#/${PROJECT}/main.tex`);
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length > 0, null, { timeout: 30000 });
  await page.locator('[data-pane-chip="pdf"]').click();
  await page.locator('[data-pdf-build]').click();
  await page.waitForSelector('.pdf-pane .pdf-page-box canvas.ready', { timeout: 180000 });
  await page.waitForTimeout(500);

  // light theme: the PDF's own colours, no switch
  await expect(page.locator('[data-pdf-dark]')).toHaveCount(0);
  expect(near(await pixel(page, 0.03, 0.03), [255, 255, 255], 2)).toBe(true);
  const spot = await photoSpot(page);
  const photoLight = await pixel(page, spot[0], spot[1]);

  // dark theme: the paper takes the editor's page colour (#121216), the photograph keeps its colours
  await page.locator('.menubar .theme-toggle').click();
  await expect(page.locator('.pdf-viewer')).toHaveClass(/dark-pages/);
  await expect(page.locator('[data-pdf-dark]')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => pixel(page, 0.03, 0.03), { timeout: 10000 }).toEqual([18, 18, 22]);
  expect(near(await pixel(page, spot[0], spot[1]), photoLight, 6)).toBe(true);

  // the sepia tone: the ink follows the editor's text colour — the paper stays the page colour
  await page.evaluate(() => { document.documentElement.dataset.tone = 'sepia'; });
  await page.waitForTimeout(600);
  expect(await pixel(page, 0.03, 0.03)).toEqual([18, 18, 22]);

  // ◐: the PDF's own colours again, kept as a preference
  await page.evaluate(() => { document.documentElement.dataset.tone = 'white'; });
  await page.locator('[data-pdf-dark]').click();
  await expect(page.locator('[data-pdf-dark]')).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => pixel(page, 0.03, 0.03), { timeout: 10000 }).toEqual([255, 255, 255]);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ol.prefs') || '{}').darkPdf)).toBe(false);
  await page.locator('[data-pdf-dark]').click();
  await expect.poll(() => pixel(page, 0.03, 0.03), { timeout: 10000 }).toEqual([18, 18, 22]);
  await page.locator('.menubar .theme-toggle').click();
  expect(errors.filter(e => !/favicon|ResizeObserver|willReadFrequently/.test(e))).toEqual([]);
});

test('a PDF figure is judged as a whole: its heat map turns dark with it, the photograph in it keeps its colours', async ({ page }) => {
  await page.addInitScript(() => { try { const p = JSON.parse(localStorage.getItem('ol.prefs') || '{}'); p.autoBuild = 'off'; delete p.darkPdf; localStorage.setItem('ol.prefs', JSON.stringify(p)); localStorage.setItem('ol.theme', 'light'); } catch { /* ignore */ } });
  await login(page);
  await page.goto(`/#/${PROJECT}/figure.tex`);
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par, .lyx-editor .lyx-inset').length > 0, null, { timeout: 30000 });
  await page.locator('[data-pane-chip="pdf"]').click();
  await page.locator('[data-pdf-build]').click();
  await page.waitForSelector('.pdf-pane .pdf-page-box canvas.ready', { timeout: 180000 });
  await page.waitForTimeout(500);
  // light: the heat map's peach blocks and the photograph's middle, found by their colours
  const spots = await page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('.pdf-pane .pdf-page-box canvas.ready')!;
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let hx = 0, hy = 0, hn = 0, gx = 0, gy = 0, gn = 0;
    for (let y = 0; y < c.height; y += 2) for (let x = 0; x < c.width; x += 2) {
      const i = (y * c.width + x) * 4, [r, g, b] = [d[i], d[i + 1], d[i + 2]];
      if (r > 240 && g > 190 && g < 225 && b > 140 && b < 180) { hx += x; hy += y; hn++; }   // #ffd0a0
      else if (g > r && r > b && g < 215 && r + g + b < 560 && r + g + b > 150) { gx += x; gy += y; gn++; }   // the photograph's greens
    }
    return { heat: [hx / hn / c.width, hy / hn / c.height], grain: [gx / gn / c.width, gy / gn / c.height], hn, gn };
  });
  expect(spots.hn).toBeGreaterThan(100);
  expect(spots.gn).toBeGreaterThan(100);
  // a peach block of the heat map: the centre of a block next to the found centroid is not needed — average a small area
  const area = (fx: number, fy: number) => page.evaluate(([fx, fy]) => {
    const c = document.querySelector<HTMLCanvasElement>('.pdf-pane .pdf-page-box canvas.ready')!;
    const d = c.getContext('2d')!.getImageData(Math.floor(c.width * fx) - 6, Math.floor(c.height * fy) - 6, 12, 12).data;
    let l = 0; for (let i = 0; i < d.length; i += 4) l += (d[i] + d[i + 1] + d[i + 2]) / 3;
    return l / (d.length / 4);
  }, [fx, fy]);
  const heatLight = await area(spots.heat[0], spots.heat[1]);
  const grainLight = await pixel(page, spots.grain[0], spots.grain[1]);
  expect(heatLight).toBeGreaterThan(180);

  await page.locator('.menubar .theme-toggle').click();
  await expect(page.locator('.pdf-viewer')).toHaveClass(/dark-pages/);
  await expect.poll(() => pixel(page, 0.03, 0.03), { timeout: 10000 }).toEqual([18, 18, 22]);
  // the heat map is dark with the figure; the photograph in the same figure is as it was
  expect(await area(spots.heat[0], spots.heat[1])).toBeLessThan(110);
  expect(near(await pixel(page, spots.grain[0], spots.grain[1]), grainLight, 8)).toBe(true);
  await page.locator('.menubar .theme-toggle').click();
});

