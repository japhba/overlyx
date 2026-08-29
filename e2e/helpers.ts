import { readFileSync } from 'node:fs';
import type { Page, BrowserContext, Browser } from '@playwright/test';

/** Root of the projects served by the server under test (an isolated copy when OVERLYX_PROJECTS_DIR is set). */
export const PROJECTS_DIR = process.env.OVERLYX_PROJECTS_DIR ?? '/root/projects';
/** Real papers used as fixtures (read-only; specs copy them into scratch projects under PROJECTS_DIR). */
export const FIXTURES_DIR = process.env.OVERLYX_E2E_FIXTURES ?? '/root/projects';
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

export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  return errors;
}

export const TOUR_SEEN_SCRIPT = () => { try { if (!localStorage.getItem('ol.tour')) localStorage.setItem('ol.tour', 'e2e'); } catch { /* ignore */ } };

export async function apiLogin(ctx: BrowserContext, creds = adminCredentials()): Promise<void> {
  await ctx.addInitScript(TOUR_SEEN_SCRIPT);      // pages of this context must not be offered the tour
  const res = await ctx.request.post(BASE_URL + '/api/auth/login', { data: creds });
  if (!res.ok()) throw new Error('api login failed');
}

/**
 * Projects are private to their owner (scratch directories created by the specs belong to the
 * admin): share one with other test users so that they can open it. Runs as the admin.
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
