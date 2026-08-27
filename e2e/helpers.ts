import { readFileSync } from 'node:fs';
import type { Page, BrowserContext } from '@playwright/test';

/** Root of the projects served by the server under test (an isolated copy when OVERLYX_PROJECTS_DIR is set). */
export const PROJECTS_DIR = process.env.OVERLYX_PROJECTS_DIR ?? '/root/projects';
/** Real papers used as fixtures (read-only; specs copy them into scratch projects under PROJECTS_DIR). */
export const FIXTURES_DIR = process.env.OVERLYX_E2E_FIXTURES ?? '/root/projects';
export const BASE_URL = process.env.OVERLYX_E2E_BASE ?? 'http://localhost:5173';

export function adminCredentials(): { username: string; password: string } {
  const lines = readFileSync(process.env.OVERLYX_E2E_CREDENTIALS ?? '/root/lyx/overlyx/data/credentials.txt', 'utf8').split('\n').filter(l => l.startsWith('admin\t'));
  const [username, password] = lines[lines.length - 1].split('\t');
  return { username, password };
}

export async function login(page: Page, creds = adminCredentials()): Promise<void> {
  await page.goto('/');
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

export async function apiLogin(ctx: BrowserContext, creds = adminCredentials()): Promise<void> {
  const res = await ctx.request.post(BASE_URL + '/api/auth/login', { data: creds });
  if (!res.ok()) throw new Error('api login failed');
}
