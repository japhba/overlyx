/**
 * Typing math the LaTeX way, and figures that keep up with their files:
 *  - `$` opens an inline formula, `$` inside closes it, `$$` makes a display formula, Backspace in
 *    the empty formula gives the dollar back (a literal $ in the text);
 *  - the ( )↑ / ( )↓ math toolbar buttons grow and shrink the delimiter pair around the cursor;
 *  - a graphics file rewritten on disk reloads in the editor (no page reload), and in the dark
 *    theme line art is shown light-on-dark while a photo-like picture is left alone;
 *  - a comment thread shows as a card with avatar, name and time. Needs the seeded admin.
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { login, openDoc, texDoc, PROJECTS_DIR } from './helpers';

const PROJECT = 'e2e-dollar';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;

/** a small RGBA PNG painted by `px(x, y)` */
function png(w: number, h: number, px: (x: number, y: number) => [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const [r, g, b] = px(x, y); const i = y * (w * 3 + 1) + 1 + x * 3; raw[i] = r; raw[i + 1] = g; raw[i + 2] = b; } }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const lineArt = (shift = 0) => png(120, 80, (x, y) => (x === 10 + shift || y === 70 || y === Math.round(60 - x / 3) ? [0, 0, 0] : [255, 255, 255]));
const photo = () => png(120, 80, (x, y) => [(x * 2) % 256, (y * 3) % 256, ((x + y) * 5) % 256]);

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(`${DIR}/figs`, { recursive: true });
  writeFileSync(`${DIR}/dollar.tex`, texDoc('Type here.\n\nSecond.'));
  writeFileSync(`${DIR}/delims.tex`, texDoc('Formula: $(a+b)$ end.'));
  writeFileSync(`${DIR}/figs/plot.png`, lineArt());
  writeFileSync(`${DIR}/figs/photo.png`, photo());
  writeFileSync(`${DIR}/figs.tex`, texDoc('A plot: \\includegraphics[width=4cm]{figs/plot.png}\n\nA picture: \\includegraphics[width=4cm]{figs/photo.png}'));
  writeFileSync(`${DIR}/thread.tex`, texDoc('Some text %\n%% @comment\n%% Jan Bauer (2026-08-26 14:03):\n%%\n%% Please check this claim.\n%%\n%% Kirsten Fischer (2026-08-27 09:10):\n%%\n%% Done.\n%% @end\nwith a thread.'));
});
test.afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

const fieldLatex = (page: import('@playwright/test').Page, sel: string) => page.evaluate(s => ((document.querySelector(s) as any)?.pmViewDesc?.node?.attrs?.latex ?? null) as string | null, sel);

test('$ opens an inline formula, $ closes it, $$ a display formula; Backspace right after $ gives the dollar back', async ({ page }) => {
  await login(page);
  await openDoc(page, `${PROJECT}/dollar.tex`);
  await page.waitForTimeout(500);
  const pars = page.locator('.lyx-editor > .lyx-par');
  await pars.nth(0).click({ position: { x: 4, y: 8 } });
  await page.keyboard.press('End');
  await page.keyboard.type(' $');
  await expect(page.locator('.lyx-math-inline .lm-field.focused')).toHaveCount(1);
  await page.keyboard.type('x+1');
  await page.keyboard.type('$');   // the closing dollar: cursor after the formula
  await expect(page.locator('.lm-field.focused')).toHaveCount(0);
  await page.keyboard.type(' and');
  await expect(pars.nth(0)).toHaveText(/Type here\..*and$/);
  expect(await fieldLatex(page, '.lyx-editor .lyx-math-inline')).toBe('x+1');
  // $$ → display formula (the empty inline one is converted, the cursor stays inside)
  await page.keyboard.type(' $$');
  await expect(page.locator('.lyx-math-display .lm-field.focused')).toHaveCount(1, { timeout: 5000 });
  await page.keyboard.type('y');
  await page.keyboard.press('Escape');
  await expect.poll(() => readFileSync(`${DIR}/dollar.tex`, 'utf8'), { timeout: 15000 }).toMatch(/\$x\+1\$ and[\s\S]*\\\[\s*y\s*\\\]/);
  // Backspace in the empty formula that $ opened: a literal dollar
  await pars.nth(1).click({ position: { x: 4, y: 8 } });
  await page.keyboard.press('End');
  await page.keyboard.type(' costs $');
  await expect(page.locator('.lyx-math-inline .lm-field.focused')).toHaveCount(1);
  await page.keyboard.press('Backspace');
  await expect(pars.nth(1)).toHaveText('Second. costs $');
  await page.keyboard.type('5');
  await expect(pars.nth(1)).toHaveText('Second. costs $5');
  await expect.poll(() => readFileSync(`${DIR}/dollar.tex`, 'utf8'), { timeout: 15000 }).toContain('costs \\$5');
});

test('the math toolbar grows and shrinks the delimiters around the cursor', async ({ page }) => {
  await login(page);
  await openDoc(page, `${PROJECT}/delims.tex`);
  await page.waitForTimeout(500);
  const wrap = page.locator('.lyx-editor .lyx-math-inline').first();
  await wrap.click();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');   // after (
  await page.keyboard.press('ArrowRight');   // after a
  await expect(page.locator('.lm-field.focused')).toHaveCount(1);
  await page.locator('[data-tb="m-delim-grow"]').click();
  await expect.poll(() => fieldLatex(page, '.lyx-editor .lyx-math-inline')).toBe('\\bigl(a+b\\bigr)');
  await page.locator('[data-tb="m-delim-grow"]').click();
  await expect.poll(() => fieldLatex(page, '.lyx-editor .lyx-math-inline')).toBe('\\Bigl(a+b\\Bigr)');
  await page.locator('[data-tb="m-delim-shrink"]').click();
  await page.locator('[data-tb="m-delim-shrink"]').click();
  await expect.poll(() => fieldLatex(page, '.lyx-editor .lyx-math-inline')).toBe('(a+b)');
  // still inside: typing continues after a
  await page.keyboard.type('c');
  await expect.poll(() => fieldLatex(page, '.lyx-editor .lyx-math-inline')).toBe('(ac+b)');
});

test('a rewritten graphics file reloads by itself; dark theme inverts line art but not a photo', async ({ page }) => {
  await login(page);
  await openDoc(page, `${PROJECT}/figs.tex`);
  const imgs = page.locator('.lyx-editor .lyx-graphics img');
  await expect(imgs).toHaveCount(2);
  const src0 = await imgs.nth(0).getAttribute('src');
  expect(src0).not.toContain('&v=');
  await expect.poll(() => imgs.nth(0).evaluate(i => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth)).toBe(120);
  writeFileSync(`${DIR}/figs/plot.png`, lineArt(40));
  await expect.poll(() => imgs.nth(0).getAttribute('src'), { timeout: 10000 }).toContain('&v=');
  await expect.poll(() => imgs.nth(1).getAttribute('src')).not.toContain('&v=');   // the other file did not change
  // smart invert: classes come from the pixels, the filter only applies in the dark theme
  await expect(page.locator('.lyx-graphics').nth(0)).toHaveClass(/smart-invert/);
  await expect(page.locator('.lyx-graphics').nth(1)).not.toHaveClass(/smart-invert/);
  await page.locator('.menubar .theme-toggle').click();
  await expect.poll(() => imgs.nth(0).evaluate(i => getComputedStyle(i).filter)).toMatch(/invert/);
  expect(await imgs.nth(1).evaluate(i => getComputedStyle(i).filter)).not.toMatch(/invert/);
  await page.locator('.menubar .theme-toggle').click();
});

test('a comment thread is a card: avatar, name and time per message, Reply / Resolve', async ({ page }) => {
  await login(page);
  await openDoc(page, `${PROJECT}/thread.tex`);
  const card = page.locator('.lyx-inset-note-comment').first();
  await expect(card.locator('.comment-header')).toHaveCount(2);
  await expect(card.locator('.comment-header').nth(0)).toHaveAttribute('data-initials', 'JB');
  await expect(card.locator('.comment-header').nth(1)).toHaveAttribute('data-initials', 'KF');
  await expect(card.locator('.comment-who').nth(0)).toHaveText('Jan Bauer');
  await expect(card.locator('.comment-when').nth(1)).toHaveText('2026-08-27 09:10');
  await expect(card.locator('.inset-action')).toHaveText(['Reply', 'Resolve']);
  // the header text itself is unchanged in the file
  expect(readFileSync(`${DIR}/thread.tex`, 'utf8')).toContain('%% Jan Bauer (2026-08-26 14:03):');
});
