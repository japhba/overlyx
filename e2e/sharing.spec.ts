/**
 * Google-Docs-like access model: projects are private to their owner, shared with people
 * (viewer / editor) or through a link; every account gets its own example project.
 * Needs the seeded users admin, bob, carol and u1 (see README, "Tests").
 */
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { apiLogin, adminCredentials, userCredentials, BASE_URL, PROJECTS_DIR } from './helpers';

const PROJECT = 'e2e-share';
const DOC = `${PROJECT}/main.tex`;
const FILE = `${PROJECTS_DIR}/${DOC}`;
const enc = (id: string) => encodeURIComponent(id);
const DATA_DIR = dirname(process.env.OVERLYX_E2E_CREDENTIALS ?? '/root/lyx/overlyx/data/credentials.txt');

interface ProjectInfo { name: string; title: string | null; kind: string; role: string; via: string; files: { path: string }[] }

test.describe.configure({ mode: 'serial' });

async function asUser(browser: Browser, username?: string): Promise<BrowserContext> {
  const ctx = await browser.newContext();
  await apiLogin(ctx, username ? userCredentials(username) : adminCredentials());
  return ctx;
}
const projectsOf = async (ctx: BrowserContext): Promise<ProjectInfo[]> => ((await (await ctx.request.get(BASE_URL + '/api/projects')).json()) as { projects: ProjectInfo[] }).projects;
const metaStatus = async (ctx: BrowserContext) => (await ctx.request.get(`${BASE_URL}/api/docs/${enc(DOC)}/meta`)).status();

async function openDocPage(ctx: BrowserContext, id = DOC): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto('/#/' + id);
  await page.waitForSelector('.lyx-editor', { timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length > 0, null, { timeout: 30000 });
  await expect(page.locator('.statusbar')).toContainText('connected', { timeout: 20000 });
  return page;
}

async function openShareDialog(page: Page) {
  await page.locator('.menubar .menu button', { hasText: 'File' }).click();
  await page.locator('.menu-item', { hasText: 'Share project' }).click();
  const dlg = page.locator('.dialog');
  await expect(dlg).toContainText('People with access', { timeout: 10000 });
  return dlg;
}

/**
 * Speak the sync protocol directly (as a tampered client would) and try to change the document
 * header through the Y.Doc's meta map. Returns whether the server accepted the change.
 */
async function pushHeaderOverWebSocket(ctx: BrowserContext, doc: string, textclass: string): Promise<boolean> {
  const cookie = (await ctx.cookies()).filter(c => c.name === 'ol_session').map(c => `${c.name}=${c.value}`).join('; ');
  const ydoc = new Y.Doc();
  const ws = new WebSocket(BASE_URL.replace(/^http/, 'ws') + '/ws?doc=' + encodeURIComponent(doc), { headers: { cookie } });
  ws.binaryType = 'arraybuffer';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('websocket sync timeout')), 15000);
    ws.on('open', () => { const e = encoding.createEncoder(); encoding.writeVarUint(e, 0); syncProtocol.writeSyncStep1(e, ydoc); ws.send(encoding.toUint8Array(e)); });
    ws.on('message', (data: ArrayBuffer) => {
      const dec = decoding.createDecoder(new Uint8Array(data));
      if (decoding.readVarUint(dec) !== 0) return;
      const reply = encoding.createEncoder(); encoding.writeVarUint(reply, 0);
      const kind = syncProtocol.readSyncMessage(dec, reply, ydoc, 'remote');
      if (encoding.length(reply) > 1) ws.send(encoding.toUint8Array(reply));
      if (kind === syncProtocol.messageYjsSyncStep2) { clearTimeout(timer); resolve(); }
    });
    ws.on('error', reject);
    ws.on('close', (code) => { if (code >= 4000) { clearTimeout(timer); reject(new Error('closed ' + code)); } });
  });
  const meta = ydoc.getMap<string>('meta');
  const header = JSON.parse(meta.get('header') ?? '[]') as string[];
  const update = await new Promise<Uint8Array>(res => { ydoc.once('update', (u: Uint8Array) => res(u)); meta.set('header', JSON.stringify(header.map(l => (l.startsWith('\\textclass ') ? '\\textclass ' + textclass : l)))); });
  const e = encoding.createEncoder(); encoding.writeVarUint(e, 0); syncProtocol.writeUpdate(e, update); ws.send(encoding.toUint8Array(e));
  await new Promise(r => setTimeout(r, 800));
  ws.close();
  const text = await (await ctx.request.get(`${BASE_URL}/api/docs/${enc(doc)}/tex`)).text();
  return new RegExp('\\\\documentclass(\\[[^\\]]*\\])?\\{' + textclass + '\\}').test(text);
}

test.beforeAll(async ({ browser }) => {
  rmSync(`${PROJECTS_DIR}/${PROJECT}`, { recursive: true, force: true });
  const admin = await asUser(browser);
  await admin.request.delete(`${BASE_URL}/api/projects/${PROJECT}`);   // leftovers of an earlier run
  expect((await admin.request.post(BASE_URL + '/api/projects', { data: { name: PROJECT } })).ok()).toBe(true);
  expect((await admin.request.post(`${BASE_URL}/api/projects/${PROJECT}/new`, { data: { path: 'main.tex', title: 'A shared paper' } })).ok()).toBe(true);
  // the admin's own example project must not be shared with bob (earlier runs / manual tests)
  await admin.request.get(BASE_URL + '/api/projects');
  const share = await admin.request.get(`${BASE_URL}/api/projects/welcome-admin/share`);
  if (share.ok()) for (const m of (await share.json()).members as { id: number; user: { username: string } | null }[]) if (m.user?.username === 'bob') await admin.request.delete(`${BASE_URL}/api/projects/welcome-admin/share/members/${m.id}`);
  await admin.close();
});

test('a project is private to its owner', async ({ browser }) => {
  const bob = await asUser(browser, 'bob');
  expect((await projectsOf(bob)).map(p => p.name)).not.toContain(PROJECT);
  expect(await metaStatus(bob)).toBe(403);
  expect((await bob.request.get(`${BASE_URL}/api/docs/${enc(DOC)}/tex`)).status()).toBe(403);
  expect((await bob.request.get(`${BASE_URL}/api/projects/${PROJECT}/file/main.tex`)).status()).toBe(403);
  expect((await bob.request.post(`${BASE_URL}/api/projects/${PROJECT}/new`, { data: { path: 'x.tex' } })).status()).toBe(403);
  expect((await bob.request.get(`${BASE_URL}/api/projects/${PROJECT}/share`)).status()).toBe(403);
  await expect(pushHeaderOverWebSocket(bob, DOC, 'book')).rejects.toThrow();   // the WebSocket upgrade is refused
  // the UI: not in the file browser, and the URL alone does not open it
  const page = await bob.newPage();
  await page.goto('/#/' + DOC);
  await page.waitForSelector('.menubar');
  await expect(page.locator('.statusbar .msg.error')).toContainText('access', { timeout: 15000 });
  await expect(page.locator('.filetree[data-project="e2e-share"]')).toHaveCount(0);
  await bob.close();
});

test('every account gets its own personalised example project', async ({ browser }) => {
  const bob = await asUser(browser, 'bob');
  const ex = (await projectsOf(bob)).find(p => p.kind === 'example' && p.via === 'owner');
  expect(ex).toBeTruthy();
  expect([ex!.name, ex!.title, ex!.role, ex!.via]).toEqual(['welcome-bob', 'Welcome to OverLyX', 'owner', 'owner']);
  const text = readFileSync(`${PROJECTS_DIR}/welcome-bob/welcome.tex`, 'utf8');
  expect(text).toMatch(/\\author\{Bob/);
  expect(text).not.toContain('@@');
  // the start screen shows it first; it opens and renders (formulas incl. the double angle brackets)
  const page = await bob.newPage();
  await page.goto('/');
  await page.waitForSelector('.home', { timeout: 20000 });
  await expect(page.locator('.home-card.example')).toContainText('Bob');
  await page.locator('.home-card.example button', { hasText: 'Start the tour' }).click();
  await page.waitForSelector('.lyx-editor', { timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length > 20, null, { timeout: 30000 });
  await expect(page.locator('.lyx-editor')).toContainText('Welcome to OverLyX');
  await expect(page.locator('.lyx-editor')).toContainText('Bob');
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .katex').length > 5, null, { timeout: 30000 });
  expect(await page.locator('.lyx-editor .katex-error').count()).toBe(0);
  await expect(page.locator('.statusbar .readonly-badge')).toHaveCount(0);
  // one per account, invisible to others
  const admin = await asUser(browser);
  expect((await projectsOf(admin)).find(p => p.name === 'welcome-admin')?.via).toBe('owner');
  expect((await projectsOf(bob)).map(p => p.name)).not.toContain('welcome-admin');
  expect((await bob.request.get(`${BASE_URL}/api/docs/${enc('welcome-admin/welcome.tex')}/meta`)).status()).toBe(403);
  await bob.close(); await admin.close();
});

test('sharing with a person: a viewer only reads, an editor can type', async ({ browser }) => {
  const admin = await asUser(browser);
  const pageA = await openDocPage(admin);
  const dlg = await openShareDialog(pageA);
  await dlg.locator('input[placeholder="Username or e-mail address"]').fill('bob');
  await dlg.locator('.share-add select').selectOption('view');
  await dlg.locator('.share-add button', { hasText: 'Add' }).click();
  await expect(dlg.locator('[data-member="bob"]')).toBeVisible();
  await expect(dlg.locator('[data-member="bob"] select')).toHaveValue('view');

  const bob = await asUser(browser, 'bob');
  expect((await projectsOf(bob)).find(p => p.name === PROJECT)?.role).toBe('view');
  expect(await metaStatus(bob)).toBe(200);
  const pageB = await openDocPage(bob);
  await expect(pageB.locator('.statusbar .readonly-badge')).toBeVisible({ timeout: 15000 });
  await expect(pageB.locator('.docpanel[data-project="e2e-share"] .badge')).toHaveText('view');
  const before = readFileSync(FILE, 'utf8');
  await pageB.locator('.lyx-editor .lyx-par').last().click();
  await pageB.keyboard.type('VIEWER-TYPED');
  await pageB.waitForTimeout(2500);
  expect(await pageB.locator('.lyx-editor').innerText()).not.toContain('VIEWER-TYPED');
  expect(readFileSync(FILE, 'utf8')).toBe(before);
  // a viewer's updates are dropped by the server even when the client is bypassed
  expect(await pushHeaderOverWebSocket(bob, DOC, 'book')).toBe(false);
  expect((await bob.request.post(`${BASE_URL}/api/docs/${enc(DOC)}/header`, { data: { set: { textclass: 'book' } } })).status()).toBe(403);
  // …but they may compile
  expect((await bob.request.post(`${BASE_URL}/api/docs/${enc(DOC)}/export`, { data: { format: 'tex' } })).ok()).toBe(true);

  // promoted to editor
  await dlg.locator('[data-member="bob"] select').selectOption('edit');
  await expect.poll(async () => (await projectsOf(bob)).find(p => p.name === PROJECT)?.role).toBe('edit');
  await pageB.reload();
  await pageB.waitForSelector('.lyx-editor', { timeout: 30000 });
  await expect(pageB.locator('.statusbar')).toContainText('connected', { timeout: 20000 });
  await expect(pageB.locator('.statusbar .readonly-badge')).toHaveCount(0);
  await pageB.locator('.lyx-editor .lyx-par').last().click();
  await pageB.keyboard.type('EDITOR-TYPED');
  await expect.poll(() => readFileSync(FILE, 'utf8'), { timeout: 15000 }).toContain('EDITOR-TYPED');
  expect(await pushHeaderOverWebSocket(bob, DOC, 'report')).toBe(true);
  expect(await pushHeaderOverWebSocket(bob, DOC, 'article')).toBe(true);
  // the owner sees bob's cursor label; bob cannot share the project on
  await expect(pageA.locator('.menubar .users .avatar[data-username="bob"]')).toBeVisible({ timeout: 15000 });
  expect((await bob.request.get(`${BASE_URL}/api/projects/${PROJECT}/share`)).status()).toBe(403);
  await bob.close(); await admin.close();
});

test('link sharing: joining through the link, revoked when the link is turned off', async ({ browser }) => {
  const admin = await asUser(browser);
  const pageA = await openDocPage(admin);
  const dlg = await openShareDialog(pageA);
  await dlg.locator('[data-link-mode]').selectOption('link');
  await expect(dlg.locator('[data-link-role]')).toBeVisible();
  await dlg.locator('[data-link-role]').selectOption('edit');
  const url = await dlg.locator('.share-link input').inputValue();
  expect(url).toMatch(/#\/share\/[A-Za-z0-9_-]{20,}$/);

  const carol = await asUser(browser, 'carol');
  expect((await projectsOf(carol)).map(p => p.name)).not.toContain(PROJECT);
  const pageC = await carol.newPage();
  await pageC.goto(url.replace(/^https?:\/\/[^/]+/, ''));
  await pageC.waitForURL(/#\/e2e-share\/main\.tex$/, { timeout: 20000 });
  await pageC.waitForSelector('.lyx-editor', { timeout: 30000 });
  await expect(pageC.locator('.statusbar .msg')).toContainText('You can now edit', { timeout: 10000 });
  await expect(pageC.locator('.statusbar')).toContainText('connected', { timeout: 20000 });
  expect((await projectsOf(carol)).find(p => p.name === PROJECT)?.via).toBe('link');
  await expect(pageC.locator('.filetree[data-project="e2e-share"] .badge')).toHaveText('edit');
  await pageC.locator('.lyx-editor .lyx-par').last().click();
  await pageC.keyboard.type('LINK-TYPED');
  await expect.poll(() => readFileSync(FILE, 'utf8'), { timeout: 15000 }).toContain('LINK-TYPED');
  await expect(dlg.locator('[data-member="carol"]')).toContainText('via link', { timeout: 10000 });   // the dialog refreshes itself

  // restricted again: carol is out, the old link is dead
  await dlg.locator('[data-link-mode]').selectOption('restricted');
  await expect(dlg.locator('[data-member="carol"]')).toHaveCount(0, { timeout: 10000 });
  await expect.poll(() => metaStatus(carol)).toBe(403);
  const u1 = await asUser(browser, 'u1');
  const pageU = await u1.newPage();
  await pageU.goto(url.replace(/^https?:\/\/[^/]+/, ''));
  await expect(pageU.locator('.statusbar .msg.error')).toContainText('not valid', { timeout: 15000 });
  await expect(pageU).toHaveURL(/\/#?$/);
  await expect(pageU.locator('.home')).toBeVisible();
  await carol.close(); await u1.close(); await admin.close();
});

test('an invitation by e-mail is bound to the account that signs in with that address', async ({ browser }) => {
  const admin = await asUser(browser);
  const username = `dave${Date.now()}`;
  const email = `${username}@example.com`;
  const r = await admin.request.post(`${BASE_URL}/api/projects/${PROJECT}/share/members`, { data: { who: email.toUpperCase(), role: 'edit' } });
  expect(r.ok()).toBe(true);
  const invited = (await r.json()).share.members.find((m: { email: string | null }) => m.email === email);
  expect(invited.user).toBeNull();
  // the account appears (created by the admin here; with Google sign-in this happens by itself)
  const created = await admin.request.post(BASE_URL + '/api/users', { data: { username, name: 'Dave', email } });
  expect(created.ok()).toBe(true);
  const { password } = await created.json();
  const dave = await browser.newContext();
  await apiLogin(dave, { username, password });
  expect((await projectsOf(dave)).find(p => p.name === PROJECT)?.role).toBe('edit');
  const share = await (await admin.request.get(`${BASE_URL}/api/projects/${PROJECT}/share`)).json();
  expect(share.members.find((m: { user: { username: string } | null }) => m.user?.username === username)).toBeTruthy();
  await dave.close(); await admin.close();
});

test('the owner can delete a project (it goes to the trash)', async ({ browser }) => {
  const admin = await asUser(browser);
  const page = await admin.newPage();
  await page.goto('/');
  await page.waitForSelector('.home', { timeout: 20000 });
  page.on('dialog', d => void d.accept());
  await page.locator(`.home-card[data-project="${PROJECT}"] button`, { hasText: 'Delete' }).click();
  await expect(page.locator(`.home-card[data-project="${PROJECT}"]`)).toHaveCount(0, { timeout: 15000 });
  expect(existsSync(`${PROJECTS_DIR}/${PROJECT}`)).toBe(false);
  expect(readdirSync(`${DATA_DIR}/trash`).some(n => n.startsWith(PROJECT + '-'))).toBe(true);
  expect((await projectsOf(admin)).map(p => p.name)).not.toContain(PROJECT);
  await admin.close();
});
