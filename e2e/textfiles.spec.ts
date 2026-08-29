/**
 * The file browser shows one project at a time (switcher, build files hidden), and text files
 * (.tex, .bib, …) open in the built-in text editor with autosave and conflict detection.
 * Needs the seeded users admin and bob.
 */
import { test, expect, type Browser, type BrowserContext } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { apiLogin, adminCredentials, userCredentials, shareProject, BASE_URL, PROJECTS_DIR } from './helpers';

const PROJECT = 'e2e-text';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;
const LYX = `\\documentclass{article}
\\input{macros}
\\begin{document}
Hello text files.
\\end{document}
`;
const MACROS = '% macros for the paper\n\\newcommand{\\E}{\\mathbb{E}}\n\\newcommand{\\R}{\\mathbb{R}}\n';

test.describe.configure({ mode: 'serial' });

async function asUser(browser: Browser, username?: string): Promise<BrowserContext> {
  const ctx = await browser.newContext();
  await apiLogin(ctx, username ? userCredentials(username) : adminCredentials());
  return ctx;
}

test.beforeAll(async ({ browser }) => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(`${DIR}/figures`, { recursive: true });
  writeFileSync(`${DIR}/main.tex`, LYX);
  writeFileSync(`${DIR}/macros.tex`, MACROS);
  writeFileSync(`${DIR}/refs.bib`, '@book{knuth1984, author={Donald E. Knuth}, title={The TeXbook}, year={1984}}\n');
  writeFileSync(`${DIR}/main.aux`, '\\relax\n');
  writeFileSync(`${DIR}/main.log`, 'This is pdfTeX\n');
  writeFileSync(`${DIR}/main.tex~`, LYX);
  await shareProject(browser, PROJECT, ['bob'], 'view');
});
test.afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

test('the file browser shows one project at a time and hides build files', async ({ browser }) => {
  const admin = await asUser(browser);
  const page = await admin.newPage();
  await page.goto('/#/' + PROJECT + '/main.tex');
  await page.waitForSelector('.lyx-editor', { timeout: 30000 });
  const tree = page.locator('.filetree');
  await expect(tree).toHaveAttribute('data-project', PROJECT);
  await expect(tree.locator('select')).toHaveValue(PROJECT);
  await expect(tree.locator('.tree-row.file')).toHaveCount(3);          // main.tex, macros.tex, refs.bib
  await expect(tree.locator('[data-file="main.aux"]')).toHaveCount(0);
  await expect(tree.locator('[data-file="main.tex~"]')).toHaveCount(0);
  await expect(tree.locator('.project-info')).toContainText('Your project');
  await tree.locator('button', { hasText: 'All files' }).click();
  await expect(tree.locator('[data-file="main.aux"]')).toHaveCount(1);
  await expect(tree.locator('[data-file="main.tex~"]')).toHaveCount(1);
  await tree.locator('button', { hasText: 'Fewer' }).click();
  // other projects are one switch away, not in the same tree
  const options = await tree.locator('select option').allTextContents();
  expect(options.some(o => o.startsWith('Welcome to OverLyX'))).toBe(true);
  await expect(tree.locator('[data-file="welcome.tex"]')).toHaveCount(0);
  await tree.locator('select').selectOption('welcome-admin');
  await expect(tree).toHaveAttribute('data-project', 'welcome-admin');
  await expect(tree.locator('[data-file="welcome.tex"]')).toHaveCount(1);
  await expect(tree.locator('[data-file="macros.tex"]')).toHaveCount(0);
  // opening a document switches back to its project
  await tree.locator('select').selectOption(PROJECT);
  await expect(tree.locator('[data-file="macros.tex"]')).toHaveCount(1);
  await admin.close();
});

test('text files open in a tab with the text editor; edits are saved automatically', async ({ browser }) => {
  const admin = await asUser(browser);
  const page = await admin.newPage();
  await page.goto('/#/' + PROJECT + '/main.tex');
  await page.waitForSelector('.lyx-editor', { timeout: 30000 });
  await page.locator('.filetree [data-file="macros.tex"]').click();
  await expect(page).toHaveURL(/#\/text:e2e-text\/macros\.tex$/);
  const ed = page.locator('.text-editor');
  await expect(ed).toBeVisible();
  await expect(ed.locator('textarea')).toHaveValue(MACROS);
  await expect(ed.locator('.state')).toHaveText('✓ Saved');
  await expect(page.locator('.tabbar .tab.active')).toContainText('macros.tex');
  await expect(page.locator('.toolbar')).toHaveCount(0);            // no LyX toolbars for a text file
  expect(await ed.locator('pre.hl .l').count()).toBeGreaterThanOrEqual(3);   // one overlay block per line (numbered by CSS)
  // type at the end: autosaved to disk
  await ed.locator('textarea').focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\\newcommand{\\N}{\\mathbb{N}}');
  await expect(ed.locator('.state')).toHaveText('Unsaved changes…');
  await expect(ed.locator('.state')).toHaveText('✓ Saved', { timeout: 10000 });
  expect(readFileSync(`${DIR}/macros.tex`, 'utf8')).toBe(MACROS + '\\newcommand{\\N}{\\mathbb{N}}');
  // Tab inserts spaces, Ctrl+S saves right away
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.type('% indented');
  await page.keyboard.press('Control+s');
  await expect(ed.locator('.state')).toHaveText('✓ Saved', { timeout: 10000 });
  expect(readFileSync(`${DIR}/macros.tex`, 'utf8')).toContain('\n  % indented');
  // the document tab still works next to it
  await page.locator('.tabbar .tab', { hasText: 'main.tex' }).click();
  await page.waitForSelector('.lyx-editor', { timeout: 30000 });
  await expect(page.locator('.text-editor')).toHaveCount(0);
  await page.locator('.tabbar .tab', { hasText: 'macros.tex' }).click();
  await expect(page.locator('.text-editor textarea')).toHaveValue(/% indented/);
  await admin.close();
});

test('a change on the server is detected instead of overwritten', async ({ browser }) => {
  const admin = await asUser(browser);
  const page = await admin.newPage();
  await page.goto('/#/' + PROJECT + '/refs.bib');
  const ed = page.locator('.text-editor');
  await expect(ed.locator('.state')).toHaveText('✓ Saved');
  // someone else (or git, or desktop LyX) writes the file meanwhile
  const other = '@book{lamport1994, author={Leslie Lamport}, title={LaTeX}, year={1994}}\n';
  writeFileSync(`${DIR}/refs.bib`, other);
  const t = new Date(Date.now() + 5000); utimesSync(`${DIR}/refs.bib`, t, t);
  await ed.locator('textarea').focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('% mine');
  await expect(ed.locator('.te-conflict')).toBeVisible({ timeout: 10000 });
  await expect(ed.locator('.state')).toContainText('changed on the server');
  expect(readFileSync(`${DIR}/refs.bib`, 'utf8')).toBe(other);          // nothing overwritten
  await ed.locator('button', { hasText: "Take the server's version" }).click();
  await expect(ed.locator('textarea')).toHaveValue(other);
  await expect(ed.locator('.state')).toHaveText('✓ Saved');
  // and the other way round: overwrite deliberately
  writeFileSync(`${DIR}/refs.bib`, other + '% theirs\n');
  const t2 = new Date(Date.now() + 10000); utimesSync(`${DIR}/refs.bib`, t2, t2);
  await ed.locator('textarea').focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('% mine again');
  await expect(ed.locator('.te-conflict')).toBeVisible({ timeout: 10000 });
  await ed.locator('button', { hasText: 'Overwrite with mine' }).click();
  await expect(ed.locator('.state')).toHaveText('✓ Saved', { timeout: 10000 });
  expect(readFileSync(`${DIR}/refs.bib`, 'utf8')).toBe(other + '% mine again');
  await admin.close();
});

test('a viewer can read text files but not change them', async ({ browser }) => {
  const bob = await asUser(browser, 'bob');
  const page = await bob.newPage();
  await page.goto('/#/' + PROJECT + '/macros.tex');
  const ed = page.locator('.text-editor');
  await expect(ed.locator('.state')).toHaveText('👁 view only');
  await expect(ed.locator('textarea')).toHaveAttribute('readonly', '');
  await expect(page.locator('.filetree .project-info')).toContainText('view only');
  await expect(page.locator('.filetree button', { hasText: '+ File' })).toHaveCount(0);
  const r = await bob.request.put(`${BASE_URL}/api/projects/${PROJECT}/text/macros.tex`, { data: { text: 'hacked' } });
  expect(r.status()).toBe(403);
  expect(readFileSync(`${DIR}/macros.tex`, 'utf8')).not.toContain('hacked');
  // creating a text file needs edit rights; .lyx files are never served as text
  const admin = await asUser(browser);
  expect((await admin.request.get(`${BASE_URL}/api/projects/${PROJECT}/text/main.tex`)).status()).toBe(400);
  expect((await admin.request.put(`${BASE_URL}/api/projects/${PROJECT}/text/notes/todo.md`, { data: { text: '# todo\n' } })).ok()).toBe(true);
  expect(readFileSync(`${DIR}/notes/todo.md`, 'utf8')).toBe('# todo\n');
  await bob.close(); await admin.close();
});

test('the text editor has its own undo/redo, bracket matching and VS Code-style editing keys', async ({ browser }) => {
  const admin = await asUser(browser);
  const page = await admin.newPage();
  await page.goto('/#/text:' + PROJECT + '/macros.tex');
  const ed = page.locator('.text-editor');
  const ta = ed.locator('textarea');
  await expect(ta).toHaveValue(/newcommand/);
  await expect(ed.locator('.state')).toHaveText('✓ Saved');
  const initial = await ta.inputValue();
  await ta.focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('\\begin{itemize}');
  await page.keyboard.press('Enter');                       // Enter after \begin{…} adds the \end
  await expect(ta).toHaveValue(/\\begin\{itemize\}\n +\n *\\end\{itemize\}$/);   // (indented like the line before)
  await page.keyboard.type('\\item x{');                    // the brace is auto-closed …
  await expect(ta).toHaveValue(/\\item x\{\}\n *\\end/);
  await page.keyboard.press('Backspace');                   // … and Backspace removes the pair
  await expect(ta).toHaveValue(/\\item x\n *\\end/);
  // the matching pair of the bracket at the cursor is marked in the overlay
  await page.keyboard.type('{a}');
  await page.keyboard.press('ArrowLeft');
  await expect(ed.locator('pre.hl .hl-match')).toHaveCount(2);
  await expect(ed.locator('pre.hl .hl-match').first()).toHaveText('{');
  await page.keyboard.press('End');
  // Ctrl+/ comments the line and back, Alt+↑ moves it up
  await page.keyboard.press('Control+Slash');
  await expect(ta).toHaveValue(/\n +% \\item x\{a\}\n/);
  await page.keyboard.press('Control+Slash');
  await expect(ta).toHaveValue(/\n +\\item x\{a\}\n/);
  await page.keyboard.press('Alt+ArrowUp');
  await expect(ta).toHaveValue(/\n +\\item x\{a\}\n *\\begin\{itemize\}\n/);
  // undo walks all of it back, redo forward again; everything lands on disk
  let steps = 0;
  while ((await ta.inputValue()) !== initial && steps < 30) { await page.keyboard.press('Control+z'); steps++; }
  expect(steps).toBeGreaterThan(2);
  expect(steps).toBeLessThan(30);
  await page.keyboard.press('Control+y');
  await expect(ta).not.toHaveValue(initial);
  await page.keyboard.press('Control+Shift+z');
  await expect(ed.locator('.state')).toHaveText('✓ Saved', { timeout: 10000 });
  expect(readFileSync(`${DIR}/macros.tex`, 'utf8')).toBe(await ta.inputValue());
  await admin.close();
});
