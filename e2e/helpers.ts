import { readFileSync } from 'node:fs';
import type { Page, BrowserContext, Browser, BrowserContextOptions } from '@playwright/test';

/**
 * Root of the projects served by the server under test (an isolated copy when OVERLYX_PROJECTS_DIR
 * is set). Projects live in their owner's namespace, `<root>/<owner>/<name>`, with the key
 * `<owner>/<name>`: the specs' scratch projects are the admin's (`admin/e2e-…`).
 */
export const PROJECTS_DIR = process.env.OVERLYX_PROJECTS_DIR ?? '/root/projects';
/** Real papers used as fixtures (read-only; specs copy them into scratch projects under PROJECTS_DIR): the owner's projects. */
export const FIXTURES_DIR = process.env.OVERLYX_E2E_FIXTURES ?? '/root/projects/jan';
export const BASE_URL = process.env.OVERLYX_E2E_BASE ?? 'http://localhost:5173';

/** A minimal .tex document around `body` (paragraphs separated by blank lines). */
export function texDoc(body: string, preamble = ''): string {
  return `\\documentclass{article}\n${preamble ? preamble + '\n' : ''}\\begin{document}\n${body}\n\\end{document}\n`;
}
/** The preamble of a real document (everything up to and including \begin{document}) with a new body. */
export function withPreambleOf(texPath: string, body: string): string {
  const text = readFileSync(texPath, 'utf8');
  const i = text.indexOf('\\begin{document}');
  return text.slice(0, i) + '\\begin{document}\n' + body + '\n\\end{document}\n';
}

export function adminCredentials(): { username: string; password: string } {
  const lines = readFileSync(process.env.OVERLYX_E2E_CREDENTIALS ?? '/root/lyx/overlyx/data/credentials.txt', 'utf8').split('\n').filter(l => l.startsWith('admin\t'));
  const [username, password] = lines[lines.length - 1].split('\t');
  return { username, password };
}

export async function login(page: Page, creds = adminCredentials(), opts: { tour?: boolean } = {}): Promise<void> {
  // the interactive tour is offered once per browser; keep it out of the way unless a spec wants it
  if (!opts.tour) await page.addInitScript(TOUR_SEEN_SCRIPT);
  await page.addInitScript(AUTOCORRECT_OFF_SCRIPT);
  await page.goto('/');
  // with Google sign-in configured the password form is folded away behind a link
  await page.locator('[data-password-login], input[placeholder="Username"]').first().waitFor({ timeout: 20000 });
  const fallback = page.locator('[data-password-login]');
  if (await fallback.count()) await fallback.click();
  await page.getByPlaceholder('Username').fill(creds.username);
  await page.getByPlaceholder('Password').fill(creds.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForSelector('.menubar', { timeout: 20000 });
}

export async function openDoc(page: Page, id: string): Promise<void> {
  await page.goto('/#/' + id);
  await page.waitForSelector('.lyx-editor', { timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length > 0, null, { timeout: 30000 });
}

/**
 * The app's own themed prompt/confirm/alert (app/Dialogs.tsx `uiPrompt`/`uiConfirm`/`uiAlert`,
 * replacing the browser's native dialogs — DOCS.md "usage"). It renders as the frontmost `.dialog`
 * (DialogHost is mounted last), so these helpers always address the one actually on top even when
 * another dialog (e.g. the Git dialog) is open underneath it.
 */
export function dialogLocator(page: Page) { return page.locator('.dialog-backdrop').last().locator('.dialog'); }
/** Accept (OK/primary button) the frontmost prompt/confirm/alert. */
export async function acceptDialog(page: Page): Promise<void> { await dialogLocator(page).locator('button.primary').click(); }
/** Cancel (its Close button — safer than Escape where the page below also binds it) the frontmost prompt/confirm/alert. */
export async function cancelDialog(page: Page): Promise<void> { await dialogLocator(page).locator('.buttons button.btn:not(.primary)', { hasText: 'Close' }).click(); }
/** Fill the frontmost prompt's text field, then accept it (set `submit: false` to leave it open). */
export async function fillDialog(page: Page, value: string, opts: { submit?: boolean } = {}): Promise<void> {
  const dlg = dialogLocator(page);
  await dlg.locator('input[type=text]').fill(value);
  if (opts.submit !== false) await dlg.locator('button.primary').click();
}

export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  return errors;
}

export const TOUR_SEEN_SCRIPT = () => { try { if (!localStorage.getItem('ol.tour')) localStorage.setItem('ol.tour', 'e2e'); } catch { /* ignore */ } };
/** e2e types prose verbatim (papers!): autocorrect stays off unless a spec sets the key itself */
const AUTOCORRECT_OFF_SCRIPT = () => { try { const p = JSON.parse(localStorage.getItem('ol.prefs') ?? '{}'); if (!('autoCorrect' in p)) { p.autoCorrect = false; localStorage.setItem('ol.prefs', JSON.stringify(p)); } } catch { /* ignore */ } };

export async function apiLogin(ctx: BrowserContext, creds = adminCredentials()): Promise<void> {
  await ctx.addInitScript(TOUR_SEEN_SCRIPT);      // pages of this context must not be offered the tour
  const res = await ctx.request.post(BASE_URL + '/api/auth/login', { data: creds });
  if (!res.ok()) throw new Error('api login failed');
}

/**
 * Projects are private to their owner (scratch directories the specs create in the admin's
 * namespace belong to the admin): share one with other test users so that they can open it. Runs
 * as the admin; `project` is the key (`admin/e2e-…`).
 */
export async function shareProject(browser: Browser, project: string, usernames: string[], role: 'view' | 'edit' = 'edit'): Promise<void> {
  const ctx = await browser.newContext();
  try {
    await apiLogin(ctx);
    // listing registers directories that were created on disk by the spec
    await ctx.request.get(BASE_URL + '/api/projects');
    for (const who of usernames) {
      const r = await ctx.request.post(`${BASE_URL}/api/projects/${encodeURIComponent(project)}/share/members`, { data: { who, role } });
      if (!r.ok()) throw new Error(`sharing ${project} with ${who} failed: ${await r.text()}`);
    }
  } finally { await ctx.close(); }
}

/** Credentials of any seeded user (last entry for that user name in the credentials file). */
export function userCredentials(username: string): { username: string; password: string } {
  const lines = readFileSync(process.env.OVERLYX_E2E_CREDENTIALS ?? '/root/lyx/overlyx/data/credentials.txt', 'utf8').split('\n').filter(l => l.startsWith(username + '\t'));
  if (!lines.length) throw new Error(`no credentials for ${username}`);
  const [u, password] = lines[lines.length - 1].split('\t');
  return { username: u, password };
}

/**
 * Two animation frames: what the last click or key started is done and drawn. Chromium usually gets
 * there before a spec's next step, WebKit not. A click that lands on a formula's row rather than in its
 * field focuses the formula a frame later (editor/assembly.ts handleClickOn), and a key pressed in
 * between still goes to the text — Playwright's click on a formula not yet hovered reaches the field
 * directly in Chromium but the row in WebKit (the field replaces the static rendering on pointerenter,
 * just before the press); a formula's caret is drawn on the next frame (lyxmath/field.ts).
 */
export const nextFrames = (page: Page): Promise<void> => page.evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r())))');

/** The engine a page runs in: 'chromium', 'firefox' or 'webkit' (Safari's engine). */
export const browserName = (page: Page): string => page.context().browser()?.browserType().name() ?? 'chromium';

/**
 * Lets the page use the async clipboard (navigator.clipboard). Chromium asks for both permissions;
 * WebKit knows only clipboard-read (it writes without one) and Firefox neither (Playwright's Firefox
 * allows both) — granting an unknown permission throws there.
 */
export async function grantClipboard(context: BrowserContext): Promise<void> {
  const name = context.browser()?.browserType().name() ?? 'chromium';
  if (name === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  else if (name === 'webkit') await context.grantPermissions(['clipboard-read']);
}

/**
 * The clipboard's text. WebKit refuses navigator.clipboard.readText() without a user gesture (Safari
 * shows a Paste button for it), so there the text is pasted (Ctrl+V) into a scratch page of the same context.
 */
export async function readClipboard(page: Page): Promise<string> {
  if (browserName(page) !== 'webkit') return page.evaluate(() => navigator.clipboard.readText());
  const scratch = await page.context().newPage();
  try {
    await scratch.setContent('<textarea></textarea>');
    await scratch.focus('textarea');
    await scratch.keyboard.press('Control+v');
    return await scratch.inputValue('textarea');
  } finally { await scratch.close(); await page.bringToFront(); }
}

/**
 * A context of a touch device (a tablet). Under hasTouch Playwright's WebKit and Firefox leave
 * navigator.maxTouchPoints at 0 (Chromium reports 1) — a real iPad says 5, and the app takes a coarse
 * pointer with touch points for a tablet (plugins/ink.ts isTabletClient) — so there it is set to 5.
 */
export async function newTouchContext(browser: Browser, options: BrowserContextOptions = {}): Promise<BrowserContext> {
  const ctx = await browser.newContext({ ...options, hasTouch: true });
  if (browser.browserType().name() !== 'chromium') await ctx.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { get: () => 5, configurable: true }); });
  return ctx;
}

/** The theme switch (menu bar / VS Code top bar) opens a menu: Default, Light or Dark. */
export async function pickTheme(page: Page, choice: 'Default' | 'Light' | 'Dark'): Promise<void> {
  await page.locator('[data-theme-toggle]').first().click();
  await page.locator('.ctx-menu[data-theme-menu] .ctx-item:not(.info)', { hasText: new RegExp('^' + choice) }).click();
}
