/**
 * Multi-user editing through real browsers: several users (separate browser contexts, different
 * accounts) edit the same document at the same time — in different paragraphs, in the SAME
 * paragraph, in a formula — and everything must converge, reach the .tex file on disk, show up in
 * the presence avatars, and undo must stay per user.
 *
 * Run against an isolated instance (see README / memory notes), e.g.
 *   OVERLYX_PROJECTS_DIR=$S/projects OVERLYX_E2E_CREDENTIALS=$S/data/credentials.txt \
 *   OVERLYX_E2E_BASE=http://127.0.0.1:3011 npx playwright test e2e/collab.spec.ts
 * The credentials file should contain users u1…u6 (seed.ts); missing ones fall back to admin.
 */
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { login, openDoc, collectErrors, PROJECTS_DIR, adminCredentials, shareProject, userCredentials, texDoc } from './helpers';

const PROJECT = 'e2e-collab';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;
const DOC = `${PROJECT}/collab.tex`;
const FILE = `${DIR}/collab.tex`;
const USERS = 6;

const body = () => {
  let s = '\\title{Collaboration test}\n\\maketitle\n\n';
  for (let i = 0; i < USERS + 2; i++) s += `Paragraph ${i} of the collaboration test.\n\n`;
  s += 'Shared paragraph:\n\n';
  s += 'Formula $a+b$ here.\n\n';
  return s;
};

function credentialsFor(username: string): { username: string; password: string } {
  const file = process.env.OVERLYX_E2E_CREDENTIALS ?? '/root/lyx/overlyx/data/credentials.txt';
  const lines = readFileSync(file, 'utf8').split('\n').filter(l => l.startsWith(username + '\t'));
  if (!lines.length) return adminCredentials();
  const [u, p] = lines[lines.length - 1].split('\t');
  return { username: u, password: p };
}

interface Session { ctx: BrowserContext; page: Page; errors: string[]; user: string }

async function openSessions(browser: Browser, n: number): Promise<Session[]> {
  const sessions: Session[] = [];
  // sequential logins keep the load on the (4 core) test box sane; the pages then run concurrently
  for (let i = 0; i < n; i++) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = collectErrors(page);
    const creds = credentialsFor(`u${i + 1}`);
    await login(page, creds);
    await openDoc(page, DOC);
    sessions.push({ ctx, page, errors, user: creds.username });
  }
  for (const s of sessions) await expect(s.page.locator('.statusbar')).toContainText('connected', { timeout: 30000 });
  return sessions;
}

const par = (page: Page, i: number) => page.locator('.lyx-editor > .lyx-par.lyx-layout-standard').nth(i);
/** document text without the remote-cursor labels (every page shows the *other* users' labels) */
const editorText = (page: Page) => page.evaluate(() => [...document.querySelectorAll('.lyx-editor > .lyx-par')].map(p => {
  const c = p.cloneNode(true) as HTMLElement;
  c.querySelectorAll('.ProseMirror-yjs-cursor').forEach(x => x.remove());
  return c.textContent ?? '';
}).join('\n'));
const relevantErrors = (e: string[]) => e.filter(x => !/favicon|ResizeObserver|404/.test(x));

test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({ browser }) => {
  rmSync(DIR, { recursive: true, force: true }); mkdirSync(DIR, { recursive: true }); writeFileSync(FILE, texDoc(body()));
  await shareProject(browser, PROJECT, ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'].filter(u => { try { userCredentials(u); return true; } catch { return false; } }));
});
test.afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

test(`${USERS} users type at the same time in different paragraphs; everything converges, reaches the file and the presence bar`, async ({ browser }) => {
  test.setTimeout(240000);
  const sessions = await openSessions(browser, USERS);
  const stamp = Date.now().toString(36);
  const markers = sessions.map((_, i) => `U${i + 1}-${stamp}-different`);
  // everybody types concurrently, each into their own paragraph
  await Promise.all(sessions.map(async (s, i) => {
    await par(s.page, i).click();
    await s.page.keyboard.press('End');
    await s.page.keyboard.type(' ' + markers[i], { delay: 25 });
  }));
  // every page shows every marker — in the paragraph it was typed into (a click into a paragraph
  // must not be lost because other users' cursors/edits arrive at the same moment)
  for (const s of sessions) for (let i = 0; i < markers.length; i++) await expect(par(s.page, i)).toContainText(markers[i], { timeout: 30000 });
  // and the same paragraph texts (convergence): compare the DOM text of the edited paragraphs
  const texts = await Promise.all(sessions.map(s => editorText(s.page)));
  const norm = (t: string) => t.replace(/\s+/g, ' ').trim();
  for (let i = 1; i < texts.length; i++) expect(norm(texts[i])).toBe(norm(texts[0]));
  // the .tex file on disk gets all of it
  await expect.poll(() => { const t = readFileSync(FILE, 'utf8'); return markers.filter(m => t.includes(m)).length; }, { timeout: 30000 }).toBe(markers.length);
  // presence: every page lists every user
  for (const s of sessions) {
    await expect(s.page.locator('.menubar .users .avatar')).toHaveCount(USERS, { timeout: 20000 });
    const names = (await s.page.locator('.menubar .users').getAttribute('title') ?? '').split(', ').filter(Boolean);
    expect(new Set(names).size).toBe(USERS);
  }
  for (const s of sessions) expect(relevantErrors(s.errors)).toEqual([]);
  for (const s of sessions) await s.ctx.close();
});

test(`${USERS} users type at the same time in the SAME paragraph`, async ({ browser }) => {
  test.setTimeout(240000);
  const sessions = await openSessions(browser, USERS);
  const stamp = Date.now().toString(36);
  const markers = sessions.map((_, i) => `S${i + 1}${stamp}`);
  const shared = (page: Page) => page.locator('.lyx-editor > .lyx-par.lyx-layout-standard', { hasText: 'Shared paragraph' }).first();
  await Promise.all(sessions.map(async (s, i) => {
    await shared(s.page).click();
    await s.page.keyboard.press('End');
    await s.page.keyboard.type(' ' + markers[i], { delay: 30 });
  }));
  // convergence: the shared paragraph reads the same on every page and no character was lost
  const sharedText = (page: Page) => shared(page).evaluate(p => { const c = p.cloneNode(true) as HTMLElement; c.querySelectorAll('.ProseMirror-yjs-cursor').forEach(x => x.remove()); return (c.textContent ?? '').replace(/\s+/g, ' ').trim(); });
  let text0 = '';
  await expect.poll(async () => {
    const texts = await Promise.all(sessions.map(s => sharedText(s.page)));
    text0 = texts[0];
    return texts.every(t => t === texts[0]);
  }, { timeout: 30000 }).toBe(true);
  for (const m of markers) {
    // every character of every marker is there, in order (typing at the same spot may interleave words,
    // like in any collaborative editor, but nothing may be dropped or reordered)
    let pos = 0;
    for (const ch of m) { pos = text0.indexOf(ch, pos); expect(pos, `character ${ch} of ${m} in "${text0}"`).toBeGreaterThanOrEqual(0); pos++; }
  }
  const contiguous = markers.filter(m => text0.includes(m)).length;
  console.log(`  same-paragraph typing: ${contiguous}/${markers.length} markers stayed contiguous; paragraph: ${text0}`);
  await expect.poll(() => { const t = readFileSync(FILE, 'utf8'); return markers.every(m => [...m].every(ch => t.includes(ch))); }, { timeout: 30000 }).toBe(true);
  for (const s of sessions) expect(relevantErrors(s.errors)).toEqual([]);
  for (const s of sessions) await s.ctx.close();
});

test('two users edit the same formula at the same time; all pages converge to one formula', async ({ browser }) => {
  test.setTimeout(180000);
  const sessions = await openSessions(browser, 3);
  const [a, b, c] = sessions;
  const field = (page: Page) => page.locator('.lyx-editor .lyx-math-inline').first();
  for (const s of [a, b]) {
    await field(s.page).hover();
    await expect(field(s.page).locator('.lm-field')).toHaveCount(1, { timeout: 10000 });
    await field(s.page).click();
    await expect(s.page.locator('.lm-field.focused')).toHaveCount(1, { timeout: 5000 });
    await s.page.keyboard.press('End');
  }
  await Promise.all([
    a.page.keyboard.type('+x', { delay: 60 }),
    b.page.keyboard.type('+y', { delay: 60 }),
  ]);
  await a.page.keyboard.press('Escape'); await b.page.keyboard.press('Escape');
  const latexOf = (page: Page) => page.evaluate(() => ((document.querySelector('.lyx-editor .lyx-math-inline') as any)?.pmViewDesc?.node?.attrs?.latex ?? '') as string);
  let latex = '';
  await expect.poll(async () => { const l = await Promise.all(sessions.map(s => latexOf(s.page))); latex = l[0]; return l.every(x => x === l[0]); }, { timeout: 30000 }).toBe(true);
  console.log(`  concurrent formula edit result: ${latex}`);
  // the formula is one node attribute: concurrent edits of the same formula are last-writer-wins
  // (one user's keystrokes may be lost), but nothing may diverge or get corrupted
  expect(latex).toMatch(/^a\+b/);
  expect(latex.includes('+x') || latex.includes('+y')).toBe(true);
  await expect.poll(() => readFileSync(FILE, 'utf8').includes('$' + latex + '$'), { timeout: 30000 }).toBe(true);
  void c;
  for (const s of sessions) expect(relevantErrors(s.errors)).toEqual([]);
  for (const s of sessions) await s.ctx.close();
});

test('undo is per user: one user undoing removes only their own text', async ({ browser }) => {
  test.setTimeout(180000);
  const [a, b] = await openSessions(browser, 2);
  const stamp = Date.now().toString(36);
  const ma = `UNDO-A-${stamp}`, mb = `UNDO-B-${stamp}`;
  await par(a.page, 1).click(); await a.page.keyboard.press('End');
  await par(b.page, 2).click(); await b.page.keyboard.press('End');
  await Promise.all([a.page.keyboard.type(' ' + ma, { delay: 25 }), b.page.keyboard.type(' ' + mb, { delay: 25 })]);
  for (const s of [a, b]) { await expect(s.page.locator('.lyx-editor')).toContainText(ma, { timeout: 20000 }); await expect(s.page.locator('.lyx-editor')).toContainText(mb, { timeout: 20000 }); }
  await a.page.keyboard.press('Control+z');
  for (const s of [a, b]) {
    await expect(s.page.locator('.lyx-editor')).not.toContainText(ma, { timeout: 20000 });
    await expect(s.page.locator('.lyx-editor')).toContainText(mb);
  }
  await expect.poll(() => { const t = readFileSync(FILE, 'utf8'); return !t.includes(ma) && t.includes(mb); }, { timeout: 30000 }).toBe(true);
  for (const s of [a, b]) expect(relevantErrors(s.errors)).toEqual([]);
  await a.ctx.close(); await b.ctx.close();
});
