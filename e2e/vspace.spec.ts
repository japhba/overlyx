/**
 * LyX-style rendering details: vertical spaces drawn like LyX (the real gap, arrows and a brown
 * label — packages/client/src/editor/nodeviews/leaf.ts renderVSpace), and \bibitem inside a
 * tracked insertion staying a bibliography entry instead of an ERT box (tex/parse.ts).
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { login, PROJECTS_DIR, texDoc } from './helpers';

const PROJECT = 'e2e-vspace';
const DOC = `${PROJECT}/spaces.tex`;

test.beforeAll(() => {
  rmSync(join(PROJECTS_DIR, PROJECT), { recursive: true, force: true });
  mkdirSync(join(PROJECTS_DIR, PROJECT), { recursive: true });
  writeFileSync(join(PROJECTS_DIR, PROJECT, 'spaces.tex'), texDoc(
    'Before.\n\n\\vspace{2cm}\n\nAfter.\n\n\\bigskip\n\nEnd.\n\n'
    + '\\begin{thebibliography}{9}\n\\lyxadded{Agent panel (MCP)}{Wed Sep  3 12:00:00 2026}{\\bibitem{k1} Some Author. A paper.}\n\\end{thebibliography}'
  ));
});
test.afterAll(() => { rmSync(join(PROJECTS_DIR, PROJECT), { recursive: true, force: true }); });

test('vertical space draws like LyX; a tracked \\bibitem stays a bibliography entry', async ({ page }) => {
  await login(page);
  await page.goto('/#/' + DOC);
  await page.waitForSelector('.lyx-editor', { timeout: 30000 });
  const vs = page.locator('.lyx-vspace');
  await expect(vs).toHaveCount(2);
  await expect(vs.first()).toContainText('Vertical space (2cm)');
  const box = await vs.first().boundingBox();
  expect(box!.height).toBeGreaterThan(60);   // 2cm ≈ 75px: the gap is the real size
  await expect(vs.nth(1)).toContainText('Vertical space (Big skip)');
  // the tracked bibliography entry parses as a bibitem chip, not an ERT box with a dashed border
  await expect(page.locator('.lyx-bibitem')).toHaveCount(1);
  await expect(page.locator('.lyx-inset-ert')).toHaveCount(0);
});
