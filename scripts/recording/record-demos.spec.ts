/**
 * Records the landing-page demo clips (packages/client/public/landing/*) by driving the real
 * editor and capturing Playwright video: WYSIWYG text + math typing, the raw .tex split staying
 * in sync both ways, and two authors editing live. Each clip is recorded twice — with the light
 * and the dark theme (the landing page picks the variant matching the visitor's theme).
 *
 * Not an e2e test (own config, never picked up by the main suite). Run against an isolated
 * instance, from the repo root:
 *
 *   S=/tmp/overlyx-demo; mkdir -p $S/projects $S/data
 *   OVERLYX_DATA_DIR=$S/data npx tsx packages/server/src/seed.ts admin Admin bob Bob
 *   OVERLYX_DATA_DIR=$S/data OVERLYX_PROJECTS_DIR=$S/projects PORT=3002 npx tsx packages/server/src/index.ts &
 *   (cd packages/client && OVERLYX_API_PORT=3002 npx vite --port 5175 &)
 *   OVERLYX_E2E_BASE=http://localhost:5175 OVERLYX_PROJECTS_DIR=$S/projects \
 *     OVERLYX_E2E_CREDENTIALS=$S/data/credentials.txt npx playwright test -c scripts/recording
 *
 * The VS Code clip is recorded separately by record-vscode.mjs (xvfb). The slides and drawing clips
 * use the Modern interface and the starter talk / poster (packages/server/templates/starters/web);
 * the slides need the deck runtime in the server's client dist (OVERLYX_CLIENT_DIST, built with
 * `OVERLYX_RUNTIME_OUT=$S/dist/_ol npx vite build -c runtime.vite.config.ts` in packages/client).
 * Record one clip with `-g "slides"`.
 */
import { test, expect, type BrowserContext, type Page, type Browser } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { apiLogin, shareProject, userCredentials, BASE_URL, PROJECTS_DIR } from '../../e2e/helpers';
import { resumeAtEnd, setLayout, inlineLatex, displayLatex } from '../../e2e/papertyping';

const OUT = path.resolve(__dirname, 'out');
const DEST = path.resolve(__dirname, '../../packages/client/public/landing');
const SIZE = { width: 1280, height: 800 };
type Theme = 'light' | 'dark';

const doc = (title: string, author: string, body: string) =>
  `\\documentclass[11pt]{article}\n\\usepackage[T1]{fontenc}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amsmath}\n\\usepackage{amssymb}\n\\usepackage{graphicx}\n\n\\begin{document}\n\\title{${title}}\n\\author{${author}}\n\\maketitle\n\n${body}\n\\end{document}\n`;

function writeProject(name: string, tex: string): void {
  mkdirSync(path.join(PROJECTS_DIR, name), { recursive: true });
  writeFileSync(path.join(PROJECTS_DIR, name, 'main.tex'), tex);
}

/** Drop a previous run's copy of the project (server state included) and register the new files. */
async function freshProject(ctx: BrowserContext, name: string, tex: string): Promise<void> {
  await ctx.request.delete(BASE_URL + '/api/projects/' + encodeURIComponent(name)).catch(() => {});
  writeProject(name, tex);
  await ctx.request.get(BASE_URL + '/api/projects');
}

/** A context whose video becomes the clip; logged in as the admin unless `user` says otherwise. */
async function recordingContext(browser: Browser, theme: Theme, user?: string, ui: 'classic' | 'modern' = 'classic'): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    viewport: SIZE,
    recordVideo: { dir: OUT, size: SIZE },
    colorScheme: theme,
    reducedMotion: 'no-preference',
  });
  await ctx.addInitScript(() => { try { const p = JSON.parse(localStorage.getItem('ol.prefs') ?? '{}'); p.autoCorrect = false; p.spellcheck = false; localStorage.setItem('ol.prefs', JSON.stringify(p)); localStorage.setItem('ol.tabs', '[]'); } catch { /* ignore */ } });
  await ctx.addInitScript((ui: string) => { try { localStorage.setItem('ol.ui', ui); } catch { /* ignore */ } }, ui);
  await apiLogin(ctx, user ? userCredentials(user) : undefined);
  return ctx;
}

async function openDoc(ctx: BrowserContext, project: string): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(BASE_URL + '/#/' + project + '/main.tex');
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length > 0, null, { timeout: 30000 });
  await page.waitForTimeout(900);   // fonts, formulas, presence settle before the clip starts
  return page;
}

/** Caret to the very end of one paragraph: click its bottom-right corner, then End (End alone only reaches the end of the clicked visual line). */
async function caretToParEnd(page: Page, par: ReturnType<Page['locator']>): Promise<void> {
  const box = (await par.boundingBox())!;
  await par.click({ position: { x: box.width - 6, y: box.height - 6 } });
  await page.waitForTimeout(250);
  await page.keyboard.press('End');
  await page.waitForTimeout(150);
}

/** Cut the head (setup before `from` ms into the raw recording), encode webm + mp4 + poster. */
function encode(raw: string, name: string, theme: Theme, fromMs: number): void {
  mkdirSync(DEST, { recursive: true });
  const trim = Math.max(0, fromMs / 1000 - 0.2).toFixed(2);
  const base = path.join(DEST, `${name}-${theme}`);
  const run = (args: string[]) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' });
  run(['-ss', trim, '-i', raw, '-c:v', 'libvpx-vp9', '-crf', '42', '-b:v', '0', '-cpu-used', '4', '-row-mt', '1', '-vf', 'fps=24', '-an', base + '.webm']);
  run(['-ss', trim, '-i', raw, '-c:v', 'libx264', '-crf', '27', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-vf', 'fps=24', '-an', base + '.mp4']);
  run(['-ss', (Number(trim) + 0.3).toFixed(2), '-i', raw, '-frames:v', '1', '-q:v', '4', base + '.jpg']);
}

/** Close the context and turn its (single recorded) page's video into the published clip. */
async function finish(ctx: BrowserContext, page: Page, name: string, theme: Theme, t0: number, opened: number, tailMs = 1800): Promise<void> {
  await page.waitForTimeout(tailMs);   // rest on the final state before the clip halts
  const video = page.video()!;
  await ctx.close();
  encode(await video.path(), name, theme, t0 - opened);
}


/** the drawing clip's slide: a Bauhaus study — a blue square and a blue circle over its corner (to become one shape), a red circle */
const DRAWDECK = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="overlyx" content="deck">
<title>Composition</title>
<style>
  body { margin: 0; background: #dfe3ea; font-family: system-ui, sans-serif; color: #1c1b19; }
  .slide { width: 1280px; height: 720px; position: relative; overflow: hidden; background: #fbfaf7; margin: 0 auto 40px; }
  .kicker { font-size: 20px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #84807a; margin: 0; }
  h2 { font-size: 46px; font-weight: 800; margin: 0; }
</style>
</head>
<body>

<section class="slide">
  <p class="kicker" style="position: absolute; left: 100px; top: 70px; width: 600px">Study</p>
  <h2 style="position: absolute; left: 100px; top: 104px; width: 1000px">Square, circle, triangle</h2>
  <div style="position: absolute; left: 160px; top: 250px; width: 230px; height: 230px; background: #2152a3"></div>
  <div style="position: absolute; left: 290px; top: 360px; width: 200px; height: 200px; border-radius: 50%; background: #2152a3"></div>
  <div style="position: absolute; left: 560px; top: 200px; width: 120px; height: 120px; border-radius: 50%; background: #d6402b"></div>
</section>

</body>
</html>
`;

const STARTERS = path.resolve(__dirname, '../../packages/server/templates/starters/web');

/** A project with the starter talk and poster (the name filled in), registered fresh. */
async function freshWebProject(ctx: BrowserContext, name: string): Promise<void> {
  await ctx.request.delete(BASE_URL + '/api/projects/' + encodeURIComponent(name)).catch(() => {});
  for (const d of ['talk', 'poster']) {
    mkdirSync(path.join(PROJECTS_DIR, name, d), { recursive: true });
    writeFileSync(path.join(PROJECTS_DIR, name, d, 'index.html'), readFileSync(path.join(STARTERS, d, 'index.html'), 'utf8').replace(/@@NAME@@/g, 'Ada Lovelace'));
  }
  await ctx.request.get(BASE_URL + '/api/projects');
}

/** a point of slide `n` (slide px, 1280 × 720) on the page */
async function slidePoint(page: Page, x: number, y: number, n = 0): Promise<{ x: number; y: number }> {
  const b = (await page.frameLocator('.dl-frame').locator('section.slide').nth(n).boundingBox())!;
  const k = b.width / 1280;
  return { x: b.x + x * k, y: b.y + y * k };
}

/** RECORD_PROBE=<dir>: a screenshot per step, to see where a recording goes wrong */
let snapN = 0;
async function snap(page: Page, label: string): Promise<void> {
  if (process.env.RECORD_PROBE) await page.screenshot({ path: path.join(process.env.RECORD_PROBE, `${String(++snapN).padStart(2, '0')}-${label}.png`) });
}

/** a hand-moved pointer: eased from where it is to (x, y) in about `ms` (timed by the clock, not by steps — each move costs time of its own) */
async function glide(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, ms = 600): Promise<void> {
  const start = Date.now();
  for (;;) {
    const t = Math.min(1, (Date.now() - start) / ms), e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    await page.mouse.move(from.x + (to.x - from.x) * e, from.y + (to.y - from.y) * e);
    if (t >= 1) return;
    await page.waitForTimeout(12);
  }
}

for (const theme of ['light', 'dark'] as const) {
  test(`slides (${theme})`, async ({ browser }) => {
    const project = theme === 'light' ? 'admin/sky-talk' : 'admin/sky-lecture';
    const ctx = await recordingContext(browser, theme, undefined, 'modern');
    // presenting asks for fullscreen, which shrinks a headless window to 800 × 600: refused, the presentation fills the window
    await ctx.addInitScript(() => { Element.prototype.requestFullscreen = () => Promise.reject(new Error('not while recording')); });
    await freshWebProject(ctx, project);
    const opened = Date.now();
    const page = await ctx.newPage();
    await page.goto(BASE_URL + '/#/' + project + '/talk/index.html');
    await page.frameLocator('.dl-frame').locator('section.slide').first().waitFor({ timeout: 30000 });
    await page.waitForTimeout(2500);   // fonts, formulas, the rail's thumbnails
    await page.mouse.move(640, 760);
    const t0 = Date.now();
    await page.waitForTimeout(400);
    // the sun: picked up, carried down towards the horizon
    const sun = await slidePoint(page, 1040, 200);
    await glide(page, { x: 640, y: 760 }, sun, 600);
    await page.mouse.down();
    await page.waitForTimeout(120);
    const low = await slidePoint(page, 1010, 420);
    await glide(page, sun, low, 900);
    await page.mouse.up();
    await page.waitForTimeout(500);
    await snap(page, 'sun');
    // the title: retyped in place
    const title = await slidePoint(page, 840, 320);
    await glide(page, low, title, 450);
    await page.mouse.dblclick(title.x, title.y);
    await page.waitForTimeout(250);
    await page.keyboard.press('End');
    await page.keyboard.type('?', { delay: 60 });
    await page.waitForTimeout(450);
    await snap(page, 'title');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    await snap(page, 'before-present');
    // presenting: the first slide, the next one, the laser
    await page.locator('[data-dl-present]').click();
    const pres = page.frameLocator('.dl-presenting iframe');
    await expect(pres.locator('section.slide[data-ol-current]')).toHaveCount(1, { timeout: 15000 });
    await page.waitForTimeout(1100);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(700);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(600);
    await page.keyboard.press('l');
    await page.mouse.move(330, 470);
    await glide(page, { x: 330, y: 470 }, { x: 560, y: 520 }, 600);
    await glide(page, { x: 560, y: 520 }, { x: 800, y: 470 }, 600);
    await snap(page, 'laser');
    await page.waitForTimeout(600);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    await page.keyboard.press('Escape');
    await expect(page.locator('.dl-presenting')).toHaveCount(0, { timeout: 10000 });
    await page.waitForTimeout(500);
    await snap(page, 'after-present');
    // the poster beside it, the same canvas
    const posterFile = page.locator('[data-file="poster/index.html"]');
    if (!(await posterFile.isVisible())) await page.locator('.tree-row.folder > .fname:text-is("poster")').click();
    await posterFile.click();
    await expect(page.frameLocator('.dl-frame').locator('h1', { hasText: 'Why the sky is blue' })).toBeVisible({ timeout: 30000 });
    await finish(ctx, page, 'slides', theme, t0, opened, 2200);
  });

  test(`drawing (${theme})`, async ({ browser }) => {
    const project = theme === 'light' ? 'admin/bauhaus-study' : 'admin/bauhaus-shapes';
    const ctx = await recordingContext(browser, theme, undefined, 'modern');
    await ctx.request.delete(BASE_URL + '/api/projects/' + encodeURIComponent(project)).catch(() => {});
    mkdirSync(path.join(PROJECTS_DIR, project, 'study'), { recursive: true });
    writeFileSync(path.join(PROJECTS_DIR, project, 'study', 'index.html'), DRAWDECK);
    await ctx.request.get(BASE_URL + '/api/projects');
    const opened = Date.now();
    const page = await ctx.newPage();
    await page.goto(BASE_URL + '/#/' + project + '/study/index.html');
    await page.frameLocator('.dl-frame').locator('section.slide').first().waitFor({ timeout: 30000 });
    await page.waitForTimeout(2000);
    let at = { x: 640, y: 780 };
    await page.mouse.move(at.x, at.y);
    const t0 = Date.now();
    const go = async (x: number, y: number, ms = 400) => { const to = await slidePoint(page, x, y); await glide(page, at, to, ms); at = to; return to; };
    await page.waitForTimeout(250);
    // square and circle: one shape (Path ▸ Union)
    await go(200, 290, 600); await page.mouse.down(); await page.mouse.up();
    await page.waitForTimeout(180);
    await go(440, 520, 450);
    await page.keyboard.down('Shift'); await page.mouse.down(); await page.mouse.up(); await page.keyboard.up('Shift');
    await page.waitForTimeout(300);
    await page.locator('[data-tb="dk-path"]').click();
    await page.waitForTimeout(300);
    await page.locator('[data-palette="dk-path"] .tb-pal-item', { hasText: 'Union' }).click();
    await page.waitForTimeout(540);
    await snap(page, 'union');
    // its points: the square's top corner pulled up and out
    const inside = await go(220, 300, 400);
    await page.mouse.dblclick(inside.x, inside.y);
    await expect(page.locator('[data-tb="dk-node-done"]')).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(360);
    await go(160, 250, 400);
    await page.mouse.down();
    await go(100, 200, 800);
    await page.mouse.up();
    await page.waitForTimeout(420);
    await snap(page, 'nodes');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    // a triangle drawn beside it, filled yellow
    await page.locator('[data-tb="dk-shapes"]').click();
    await page.waitForTimeout(240);
    await page.locator('[data-palette="dk-shapes"] .tb-pal-item[title="Triangle"]').click();
    await go(760, 300, 500);
    await page.mouse.down();
    await go(1020, 540, 700);
    await page.mouse.up();
    await page.waitForTimeout(240);
    await page.locator('[data-tb="dk-fill"]').click();
    await page.waitForTimeout(240);
    await page.locator('[data-palette="dk-fill"] [data-color="#f1c232"]').click();
    await page.waitForTimeout(360);
    await snap(page, 'triangle');
    // a Bézier curve under it: click, drag, click, Enter
    await page.locator('[data-tb="dk-lines"]').click();
    await page.waitForTimeout(240);
    await page.locator('[data-palette="dk-lines"] .tb-pal-item[title^="Path"]').click();
    const c0 = await go(640, 620, 500); await page.mouse.down(); await page.mouse.up();
    await go(860, 560, 500); await page.mouse.down(); await go(980, 560, 450); await page.mouse.up();
    const c2 = await go(1150, 620, 500); await page.mouse.down(); await page.mouse.up();
    await page.waitForTimeout(150);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await snap(page, 'bezier');
    // and a scribble with the pen
    await page.locator('[data-tb="dk-lines"]').click();
    await page.waitForTimeout(240);
    await page.locator('[data-palette="dk-lines"] .tb-pal-item[title="Scribble (pen)"]').click();
    await go(1050, 190, 450);
    await page.mouse.down();
    const box = (await page.frameLocator('.dl-frame').locator('section.slide').first().boundingBox())!, k = box.width / 1280;
    for (const start = Date.now(); ;) {
      const t = Math.min(1, (Date.now() - start) / 1300), a = t * Math.PI * 6;
      at = { x: box.x + (1050 + 150 * t + 34 * Math.sin(a)) * k, y: box.y + (190 + 34 - 34 * Math.cos(a) + 30 * t) * k };
      await page.mouse.move(at.x, at.y);
      if (t >= 1) break;
      await page.waitForTimeout(10);
    }
    await page.mouse.up();
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
    await page.locator('[data-tb="dk-select"]').click();
    await go(900, 160, 500); await page.mouse.down(); await page.mouse.up();
    await snap(page, 'end');
    void c0; void c2;
    await finish(ctx, page, 'drawing', theme, t0, opened, 2000);
  });

  test(`wysiwyg (${theme})`, async ({ browser }) => {
    const project = theme === 'light' ? 'admin/spectral-learning' : 'admin/spectral-dynamics';   // the admin's namespace
    const ctx = await recordingContext(browser, theme);
    await freshProject(ctx, project, doc('Spectral Learning Dynamics', 'Ada Lovelace',
      '\\section{Introduction}\n\nGradient descent couples the modes of a deep network through the spectrum of the input correlations. Each mode converges at a rate set by its singular value, so a network learns the strongest structure in the data first.\n'));
    const opened = Date.now();
    const page = await openDoc(ctx, project);
    const t0 = Date.now();
    await page.waitForTimeout(600);
    await resumeAtEnd(page);
    await page.keyboard.press('Enter');
    await setLayout(page, '2');
    await page.keyboard.type('Learning dynamics', { delay: 40 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(250);
    await page.keyboard.type('Each mode relaxes on its own timescale ', { delay: 28 });
    await inlineLatex(page, '\\tau_\\alpha');
    await page.keyboard.type(', so the training error decays as a sum of exponentials:', { delay: 28 });
    await displayLatex(page, 'E(t)=\\sum_\\alpha s_\\alpha^{2}e^{-2t/\\tau_\\alpha}', { numbered: true });
    // rest the caret in the text so the clip does not end on the label chip
    await page.locator('.lyx-editor > .lyx-par.lyx-layout-standard').first().click();
    await page.keyboard.press('End');
    await finish(ctx, page, 'wysiwyg', theme, t0, opened);
  });

  test(`tex (${theme})`, async ({ browser }) => {
    const project = theme === 'light' ? 'admin/kernel-regression' : 'admin/kernel-methods';
    const ctx = await recordingContext(browser, theme);
    await freshProject(ctx, project, doc('Kernel Regression without Regularization', 'Ada Lovelace',
      '\\section{Setup}\n\nThe kernel regression estimator interpolates the training data whenever the kernel matrix is invertible. Generalization is then controlled by the spectrum of the kernel operator.\n'));
    const opened = Date.now();
    const page = await ctx.newPage();
    await page.goto(BASE_URL + '/#/raw:' + project + '/main.tex');
    await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length > 0, null, { timeout: 30000 });
    const ta = page.locator('.source-pane.right textarea.source');
    await expect(ta).toHaveValue(/\\section\{Setup\}/, { timeout: 15000 });
    await page.waitForTimeout(900);
    const t0 = Date.now();
    await page.waitForTimeout(500);
    // WYSIWYG side: a sentence with an emphasis — the LaTeX on the right follows
    await caretToParEnd(page, page.locator('.lyx-editor > .lyx-par.lyx-layout-standard').first());
    await page.keyboard.type(' The spectrum, ', { delay: 30 });
    await page.keyboard.press('Control+e');
    await page.keyboard.type('not the smoothness alone', { delay: 30 });
    await page.keyboard.press('Control+e');
    await page.keyboard.type(', sets the pace.', { delay: 30 });
    await expect(ta).toHaveValue(/\\emph\{not the smoothness alone\}/, { timeout: 10000 });
    await page.waitForTimeout(900);
    // source side: replace a phrase with raw LaTeX (math included) — the WYSIWYG follows
    await ta.click();
    await ta.evaluate((el, phrase) => {
      const t = el as HTMLTextAreaElement;
      // the .tex writer wraps paragraphs, so the phrase may contain a line break
      const m = new RegExp(phrase.split(' ').join('\\s+')).exec(t.value);
      if (!m) throw new Error('phrase not in source');
      t.setSelectionRange(m.index, m.index + m[0].length);
    }, 'whenever the kernel matrix is invertible');
    await page.waitForTimeout(500);
    await page.keyboard.type('in the ridgeless limit $\\lambda\\to0$', { delay: 34 });
    await expect(page.locator('.lyx-editor .lyx-par', { hasText: 'ridgeless limit' }).first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.lyx-editor .lyx-math-inline mjx-container').first()).toBeVisible({ timeout: 10000 });
    await finish(ctx, page, 'tex', theme, t0, opened);
  });

  test(`collab (${theme})`, async ({ browser }) => {
    const project = theme === 'light' ? 'admin/deep-ensembles' : 'admin/loss-landscapes';
    const ctx = await recordingContext(browser, theme);
    // the recorded (admin) view shows comment threads in the margin, Google-Docs style
    await ctx.addInitScript(() => { try { localStorage.setItem('ol.margin', '1'); } catch { /* ignore */ } });
    await freshProject(ctx, project, doc('Why Ensembles Work', 'Admin',
      '\\section{Ensembles}\n\nAveraging the predictions of independently trained networks reduces variance without touching the bias.\n\n\\section{Loss landscapes}\n\nSolutions found by stochastic gradient descent are connected by paths of low loss.\n'));
    await shareProject(browser, project, ['bob']);
    const opened = Date.now();
    const page = await openDoc(ctx, project);
    const t0 = Date.now();
    // bob joins a beat later: his avatar pops into the presence bar, then he types in §2
    const bobCtx = await browser.newContext({ viewport: SIZE });
    await bobCtx.addInitScript(() => { try { localStorage.setItem('ol.tour', 'demo'); } catch { /* ignore */ } });
    await apiLogin(bobCtx, userCredentials('bob'));
    const bob = (async () => {
      await page.waitForTimeout(500);
      const p2 = await bobCtx.newPage();
      await p2.goto(BASE_URL + '/#/' + project + '/main.tex');
      await p2.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length > 0, null, { timeout: 30000 });
      await caretToParEnd(p2, p2.locator('.lyx-editor > .lyx-par.lyx-layout-standard').nth(1));
      await p2.waitForTimeout(500);
      await p2.keyboard.type(' Along such paths the members of an ensemble stay diverse.', { delay: 55 });
      return p2;
    })();
    await expect(page.locator('.menubar .users .avatar')).toHaveCount(2, { timeout: 15000 });
    await page.waitForTimeout(600);
    await caretToParEnd(page, page.locator('.lyx-editor > .lyx-par.lyx-layout-standard').first());
    await page.keyboard.type(' The gain grows with the disagreement between the members.', { delay: 34 });
    const p2 = await bob;
    // bob opens a comment thread on the sentence the admin just wrote; the admin's margin shows it
    await page.waitForTimeout(400);
    await caretToParEnd(p2, p2.locator('.lyx-editor > .lyx-par.lyx-layout-standard').first());
    await p2.keyboard.press('Control+Alt+c');
    await expect(p2.locator('.lyx-inset-note-comment')).toHaveCount(1, { timeout: 5000 });
    await p2.keyboard.type('Do we have a citation for this?', { delay: 45 });
    await expect(page.locator('.lyx-inset-note-comment')).toContainText('Do we have a citation', { timeout: 10000 });
    // ride out the save debounce, then make sure the known save/merge race did not eat the typed
    // sentences ([[overlyx-e2e-flakes]] — a scrambled run must fail and be re-recorded, not shipped)
    await page.waitForTimeout(2400);
    await expect(page.locator('.lyx-editor')).toContainText('disagreement between the members.');
    await expect(page.locator('.lyx-editor')).toContainText('ensemble stay diverse.');
    await finish(ctx, page, 'collab', theme, t0, opened, 800);   // bob stays connected: his avatar is part of the final frame
    await bobCtx.close();
  });
}
