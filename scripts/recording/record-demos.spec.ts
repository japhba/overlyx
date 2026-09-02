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
 * The VS Code clip is recorded separately by record-vscode.mjs (xvfb).
 */
import { test, expect, type BrowserContext, type Page, type Browser } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
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
async function recordingContext(browser: Browser, theme: Theme, user?: string): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    viewport: SIZE,
    recordVideo: { dir: OUT, size: SIZE },
    colorScheme: theme,
    reducedMotion: 'no-preference',
  });
  await ctx.addInitScript(() => { try { const p = JSON.parse(localStorage.getItem('ol.prefs') ?? '{}'); p.autoCorrect = false; p.spellcheck = false; localStorage.setItem('ol.prefs', JSON.stringify(p)); localStorage.setItem('ol.tabs', '[]'); } catch { /* ignore */ } });
  await apiLogin(ctx, user ? userCredentials(user) : undefined);
  return ctx;
}

async function openDoc(ctx: BrowserContext, project: string): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(BASE_URL + '/#/' + project + '/main.tex');
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length > 0, null, { timeout: 30000 });
  await page.waitForTimeout(900);   // fonts, KaTeX, presence settle before the clip starts
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
async function finish(ctx: BrowserContext, page: Page, name: string, theme: Theme, t0: number, opened: number): Promise<void> {
  await page.waitForTimeout(1800);   // rest on the final state before the clip halts
  const video = page.video()!;
  await ctx.close();
  encode(await video.path(), name, theme, t0 - opened);
}

for (const theme of ['light', 'dark'] as const) {
  test(`wysiwyg (${theme})`, async ({ browser }) => {
    const project = theme === 'light' ? 'spectral-learning' : 'spectral-dynamics';
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
    const project = theme === 'light' ? 'kernel-regression' : 'kernel-methods';
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
    await expect(page.locator('.lyx-editor .lyx-math-inline .katex').first()).toBeVisible({ timeout: 10000 });
    await finish(ctx, page, 'tex', theme, t0, opened);
  });

  test(`collab (${theme})`, async ({ browser }) => {
    const project = theme === 'light' ? 'deep-ensembles' : 'loss-landscapes';
    const ctx = await recordingContext(browser, theme);
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
    await bob;
    await finish(ctx, page, 'collab', theme, t0, opened);   // bob stays connected: his avatar is part of the final frame
    await bobCtx.close();
  });
}
