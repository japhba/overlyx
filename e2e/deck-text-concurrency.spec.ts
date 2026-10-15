/** Same-box collaboration must preserve saved work and offer recovery for real conflicts. */
import { test, expect, type Page, type Browser, type TestInfo } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { BASE_URL, apiLogin, PROJECTS_DIR, shareProject, userCredentials } from './helpers';

const created: string[] = [];
test.afterAll(() => {
  if (!process.env.OVERLYX_E2E_KEEP) for (const key of created) rmSync(`${PROJECTS_DIR}/${key}`, { recursive: true, force: true });
});
const box = (page: Page) => page.frameLocator('.dl-frame').locator('.sub');

async function session(browser: Browser, info: TestInfo, initial: string) {
  const key = `admin/e2e-text-merge-${Date.now().toString(36)}-${info.project.name}`;
  created.push(key);
  const file = `${PROJECTS_DIR}/${key}/talk/index.html`;
  mkdirSync(`${PROJECTS_DIR}/${key}/talk`, { recursive: true });
  writeFileSync(file, `<!doctype html><html><head><meta name="overlyx" content="deck"><title>Concurrent editing</title>
  <style>body{margin:0}.slide{position:relative;width:1280px;height:720px;background:white}.sub{position:absolute;left:100px;top:150px;width:1000px;font:32px sans-serif}</style></head><body>
  <section class="slide"><p class="sub">${initial}</p><p style="position:absolute;left:100px;top:350px;font:32px sans-serif">Other box</p></section></body></html>`);
  writeFileSync(`${PROJECTS_DIR}/${key}/talk/second.html`, '<html><head><meta name="overlyx" content="deck"></head><body><section class="slide" style="width:1280px;height:720px"><p>Second canvas</p></section></body></html>');
  await shareProject(browser, key, ['u1']);
  const contexts = await Promise.all([browser.newContext({ baseURL: BASE_URL }), browser.newContext({ baseURL: BASE_URL })]);
  const [a, b] = await Promise.all(contexts.map(context => context.newPage()));
  await apiLogin(contexts[0]); await apiLogin(contexts[1], userCredentials('u1'));
  for (const page of [a, b]) {
    await page.goto(`/#/${key}/talk/index.html`);
    await expect(box(page)).toHaveText(initial);
  }
  return { a, b, file, key, source: () => readFileSync(file, 'utf8'), close: async () => { await Promise.all(contexts.map(context => context.close())); } };
}
async function append(page: Page, text: string, finish = true) {
  if (await box(page).getAttribute('contenteditable') !== 'true') await box(page).dblclick();
  await expect(box(page)).toHaveAttribute('contenteditable', 'true');
  await page.keyboard.press('Control+End'); await page.keyboard.type(text);
  if (finish) await page.keyboard.press('Escape');
}

test('a coauthor’s saved insertion survives continued typing in a stale active box and reload', async ({ browser }, info) => {
  const s = await session(browser, info, 'Shared baseline.');
  try {
    await append(s.a, ' OWNER-A');
    await expect(box(s.b)).toContainText('OWNER-A');
    await append(s.b, ' U1-B');
    await expect(box(s.a)).toContainText('U1-B');
    await append(s.a, ' A-ACTIVE', false);
    await expect(box(s.b)).toContainText('A-ACTIVE');
    await append(s.b, ' B-SECOND');
    await expect.poll(s.source).toContain('B-SECOND');
    await append(s.a, ' A-LAST');
    await expect.poll(s.source).toContain('A-LAST');
    expect(s.source()).toContain('B-SECOND');
    await expect(box(s.b)).toContainText('A-LAST');
    await s.a.reload(); await s.b.reload();
    for (const page of [s.a, s.b]) await expect(box(page)).toHaveText('Shared baseline. OWNER-A U1-B A-ACTIVE B-SECOND A-LAST');
    await info.attach('saved-source', { body: s.source(), contentType: 'text/html' });
  } finally { await s.close(); }
});

test('separate corrections inside one paragraph merge without erasing either author', async ({ browser }, info) => {
  const s = await session(browser, info, '35 degrees today; 18 percent canopy.');
  try {
    await box(s.a).dblclick();
    await s.a.keyboard.press('Control+Home');
    await s.a.keyboard.press('Shift+ArrowRight'); await s.a.keyboard.press('Shift+ArrowRight');
    // A keeps an active selection while B corrects a different fact.
    await box(s.b).dblclick();
    await s.b.keyboard.press('Control+Home');
    for (let i = 0; i < '35 degrees today; '.length; i++) await s.b.keyboard.press('ArrowRight');
    await s.b.keyboard.press('Shift+ArrowRight'); await s.b.keyboard.press('Shift+ArrowRight');
    await s.b.keyboard.type('20'); await s.b.keyboard.press('Escape');
    await expect.poll(s.source).toContain('20 percent');
    await s.a.keyboard.type('37'); await s.a.keyboard.press('Escape');
    await expect.poll(s.source).toContain('37 degrees');
    expect(s.source()).toContain('20 percent');
    await expect(s.a.locator('[data-dl-recovery-notice]')).toHaveCount(0);
    await s.a.reload();
    await expect(box(s.a)).toHaveText('37 degrees today; 20 percent canopy.');
  } finally { await s.close(); }
});

test('overlapping corrections keep the saved version and a recoverable draft through reload', async ({ browser }, info) => {
  const s = await session(browser, info, '35 degrees today.');
  try {
    await box(s.a).dblclick(); await s.a.keyboard.press('Control+Home');
    await s.a.keyboard.press('Shift+ArrowRight'); await s.a.keyboard.press('Shift+ArrowRight');
    await box(s.b).dblclick(); await s.b.keyboard.press('Control+Home');
    await s.b.keyboard.press('Shift+ArrowRight'); await s.b.keyboard.press('Shift+ArrowRight');
    await s.b.keyboard.type('39'); await s.b.keyboard.press('Escape');
    await expect.poll(s.source).toContain('39 degrees');
    await s.a.keyboard.type('37');
    const dialog = s.a.getByRole('dialog', { name: 'Recover text', exact: true });
    await expect(dialog).toBeVisible({ timeout: 15000 });
    await expect(dialog.getByRole('textbox', { name: 'Recovered draft' })).toHaveValue('37 degrees today.');
    expect(s.source()).toContain('39 degrees'); expect(s.source()).not.toContain('37 degrees');
    await dialog.getByRole('button', { name: 'Keep for later' }).click();
    await s.a.reload();
    await expect(s.a.locator('[data-dl-recovery-notice]')).toBeVisible();
    await s.a.getByRole('button', { name: 'Recover text', exact: true }).click();
    await s.a.getByRole('button', { name: 'Insert recovered copy' }).click();
    await expect.poll(s.source).toContain('37 degrees');
    expect(s.source()).toContain('39 degrees');
    await expect(s.a.locator('[data-dl-recovery-notice]')).toHaveCount(0);
    await expect(s.a.frameLocator('.dl-frame').locator('section.slide')).toContainText('37 degrees');
    // The user can continue working after recovery, not just dismiss a modal.
    await append(s.a, ' Verified.');
    await expect.poll(s.source).toContain('39 degrees today. Verified.');
  } finally { await s.close(); }
});

test('different-object offline edits merge with online text after reconnect', async ({ browser }, info) => {
  test.skip(info.project.name === 'webkit', 'Playwright WebKit offline emulation does not disable its WebSockets; use physical Safari for this gate.');
  const s = await session(browser, info, 'Shared baseline.');
  try {
    await s.a.context().setOffline(true);
    await expect.poll(() => s.a.evaluate(() => navigator.onLine)).toBe(false);
    await append(s.a, ' OFFLINE-A');
    expect(s.source()).not.toContain('OFFLINE-A');
    const other = s.b.frameLocator('.dl-frame').getByText('Other box', { exact: true });
    await other.dblclick(); await s.b.keyboard.press('Control+End'); await s.b.keyboard.type(' ONLINE-B'); await s.b.keyboard.press('Escape');
    await expect.poll(s.source).toContain('ONLINE-B');
    await s.a.context().setOffline(false);
    await expect.poll(s.source, { timeout: 20000 }).toContain('OFFLINE-A');
    expect(s.source()).toContain('ONLINE-B');
    await s.a.reload();
    await expect(box(s.a)).toContainText('OFFLINE-A');
    await expect(s.a.frameLocator('.dl-frame').getByText('Other box ONLINE-B', { exact: true })).toBeVisible();
  } finally { await s.close(); }
});

test('a remotely deleted active box leaves a recoverable copy and no detached editing state', async ({ browser }, info) => {
  const s = await session(browser, info, 'Shared baseline.');
  try {
    await append(s.a, ' WORK-IN-PROGRESS', false);
    await expect(box(s.b)).toContainText('WORK-IN-PROGRESS');
    await box(s.b).click(); await s.b.keyboard.press('Delete');
    await expect.poll(s.source).not.toContain('class="sub"');
    const dialog = s.a.getByRole('dialog', { name: 'Recover text', exact: true });
    await expect(dialog).toBeVisible({ timeout: 15000 });
    await expect(dialog.getByRole('textbox', { name: 'Recovered draft' })).toHaveValue(/WORK-IN-PROGRESS/);
    await dialog.getByRole('button', { name: 'Insert recovered copy' }).click();
    await expect.poll(s.source).toContain('WORK-IN-PROGRESS');
    await expect(s.a.frameLocator('.dl-frame').locator('[contenteditable="true"]')).toHaveCount(0);
    const other = s.a.frameLocator('.dl-frame').getByText('Other box', { exact: true });
    await other.dblclick(); await s.a.keyboard.press('Control+End'); await s.a.keyboard.type(' STILL-USABLE'); await s.a.keyboard.press('Escape');
    await expect.poll(s.source).toContain('STILL-USABLE');
  } finally { await s.close(); }
});


test('rapid simultaneous saves keep both authors, including each author’s undo and redo', async ({ browser }, info) => {
  const s = await session(browser, info, 'Shared baseline.');
  try {
    for (let round = 0; round < 3; round++) {
      await box(s.a).dblclick(); await box(s.b).dblclick();
      await Promise.all([append(s.a, ` A${round}😀`), append(s.b, ` B${round}Ω`)]);
      for (const token of [`A${round}😀`, `B${round}Ω`]) await expect.poll(s.source).toContain(token);
      await expect.poll(() => box(s.a).textContent()).toContain(`B${round}Ω`);
      await expect.poll(() => box(s.b).textContent()).toContain(`A${round}😀`);
    }
    await s.a.locator('[data-tb="dk-undo"]').click();
    await expect.poll(s.source).not.toContain('A2😀'); expect(s.source()).toContain('B2Ω');
    await s.a.locator('[data-tb="dk-redo"]').click();
    await expect.poll(s.source).toContain('A2😀'); expect(s.source()).toContain('B2Ω');
    await s.a.reload(); await s.b.reload();
    for (const page of [s.a, s.b]) for (let round = 0; round < 3; round++) {
      await expect(box(page)).toContainText(`A${round}😀`); await expect(box(page)).toContainText(`B${round}Ω`);
    }
  } finally { await s.close(); }
});

test('a list conversion and a stale coauthor append preserve valid block structure and both drafts', async ({ browser }, info) => {
  const s = await session(browser, info, 'Shared baseline.');
  try {
    await box(s.a).dblclick(); await box(s.b).dblclick();
    await s.a.keyboard.press('Control+End');
    await s.a.locator('[data-tb="dk-ul"]').click();
    await s.a.keyboard.press('End'); await s.a.keyboard.press('Enter');
    await s.a.keyboard.type('Second paragraph.'); await s.a.keyboard.press('Escape');
    await expect.poll(s.source).toContain('Second paragraph.');
    expect(s.source()).toMatch(/<div class="sub"/);
    await append(s.b, ' COAUTHOR-APPEND');
    await expect.poll(s.source).toContain('COAUTHOR-APPEND');
    expect(s.source()).toContain('Second paragraph.');
    await s.a.reload();
    await expect(box(s.a)).toContainText('Second paragraph.'); await expect(box(s.a)).toContainText('COAUTHOR-APPEND');
    await expect(s.a.frameLocator('.dl-frame').locator('section.slide > .sub')).toHaveCount(1);
  } finally { await s.close(); }
});

test('offline edits survive leaving the file and reloading before reconnecting', async ({ browser }, info) => {
  const s = await session(browser, info, 'Shared baseline.');
  let blockSocket = true;
  try {
    await s.a.context().routeWebSocket('**/ws/**', socket => { if (blockSocket) socket.close(); else socket.connectToServer(); });
    await s.a.reload();
    await expect(s.a.locator('.dl-status')).toHaveText('Offline');
    await append(s.a, ' OFFLINE-DURABLE');
    await expect(s.a.locator('.dl-status')).toHaveText('Offline — saved in this browser');
    expect(s.source()).not.toContain('OFFLINE-DURABLE');
    await s.a.evaluate(() => { location.hash = ''; });
    await expect(s.a.locator('.dl-editor')).toHaveCount(0);
    await s.a.goto(`/#/${s.key}/talk/index.html`);
    await expect(box(s.a)).toContainText('OFFLINE-DURABLE');
    await expect(s.a.locator('.dl-status')).toHaveText('Offline — saved in this browser');
    await s.a.reload();
    await expect(box(s.a)).toContainText('OFFLINE-DURABLE');
    expect(s.source()).not.toContain('OFFLINE-DURABLE');
    blockSocket = false;
    await s.a.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(s.source, { timeout: 20000 }).toContain('OFFLINE-DURABLE');
    await expect(s.a.locator('.dl-status')).toHaveText('Saved');
  } finally { await s.close(); }
});

test('switching files inside the typing buffer preserves a recoverable draft', async ({ browser }, info) => {
  const s = await session(browser, info, 'Shared baseline.');
  try {
    await expect(s.a.locator('.dl-status')).toHaveText('Saved');
    await append(s.a, ' INTERRUPTED-DRAFT', false);
    await expect.poll(() => s.a.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('ol.textRecovery:')).some(k => localStorage.getItem(k)?.includes('INTERRUPTED-DRAFT')))).toBe(true);
    await s.a.evaluate(key => { location.hash = `/${key}/talk/second.html`; }, s.key);
    await expect(s.a.frameLocator('.dl-frame').getByText('Second canvas', { exact: true })).toBeVisible();
    await s.a.evaluate(key => { location.hash = `/${key}/talk/index.html`; }, s.key);
    // Either the autosave beat navigation or the local typing buffer can be recovered.
    await expect.poll(async () => s.source().includes('INTERRUPTED-DRAFT') || await s.a.locator('[data-dl-recovery-notice]').count() > 0).toBe(true);
    if (!s.source().includes('INTERRUPTED-DRAFT')) {
      await s.a.getByRole('button', { name: 'Recover text', exact: true }).click();
      await expect(s.a.getByRole('textbox', { name: 'Recovered draft' })).toHaveValue(/INTERRUPTED-DRAFT/);
      await s.a.getByRole('button', { name: 'Insert recovered copy' }).click();
      await expect.poll(s.source).toContain('INTERRUPTED-DRAFT');
    }
  } finally { await s.close(); }
});

test('a reset collaboration history keeps the older local source available without duplicating the file', async ({ browser }, info) => {
  const s = await session(browser, info, 'Shared baseline.');
  let blockSocket = true;
  try {
    await s.a.context().routeWebSocket('**/ws/**', socket => { if (blockSocket) socket.close(); else socket.connectToServer(); });
    await s.a.reload(); await expect(s.a.locator('.dl-status')).toHaveText('Offline');
    await append(s.a, ' LOCAL-BEFORE-RESET');
    await expect(s.a.locator('.dl-status')).toHaveText('Offline — saved in this browser');
    expect(s.source()).not.toContain('LOCAL-BEFORE-RESET');
    const reset = await s.a.request.post(`/api/docs/${encodeURIComponent(s.key + '/talk/index.html')}/reset`);
    expect(reset.ok()).toBe(true);
    blockSocket = false; await s.a.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(s.a.locator('[data-dl-stale-notice]')).toBeVisible();
    await expect(s.a.getByRole('dialog', { name: 'Recover text', exact: true })).toHaveCount(0);
    expect(s.source()).not.toContain('LOCAL-BEFORE-RESET');
    const downloadPromise = s.a.waitForEvent('download');
    await s.a.getByRole('button', { name: 'Download local source', exact: true }).click();
    const download = await downloadPromise;
    expect(readFileSync((await download.path())!, 'utf8')).toContain('LOCAL-BEFORE-RESET');
    await s.a.getByRole('button', { name: 'Reopen latest file', exact: true }).click();
    await expect(s.a.locator('[data-dl-stale-notice]')).toHaveCount(0);
    await expect(box(s.a)).toHaveText('Shared baseline.');
    expect((s.source().match(/<!doctype/gi) ?? [])).toHaveLength(1);
  } finally { await s.close(); }
});


test('changing an editor to a viewer during the typing buffer keeps rejected text recoverable', async ({ browser }, info) => {
  const s = await session(browser, info, 'Shared baseline.');
  try {
    const share = await (await s.a.request.get(`/api/projects/${encodeURIComponent(s.key)}/share`)).json();
    const member = share.members.find((m: { user: { username: string } | null }) => m.user?.username === 'u1');
    expect(member).toBeTruthy();
    await append(s.b, ' PERMISSION-REJECTED-DRAFT', false);
    const result = await s.a.request.post(`/api/projects/${encodeURIComponent(s.key)}/share/members/${member.id}`, { data: { role: 'view' } });
    expect(result.ok()).toBe(true);
    await s.b.keyboard.press('Escape');
    await expect(s.b.locator('[data-dl-recovery-notice]')).toBeVisible();
    const dialog = s.b.getByRole('dialog', { name: 'Recover text', exact: true });
    if (!await dialog.isVisible()) await s.b.getByRole('button', { name: 'Recover text', exact: true }).click();
    await expect(dialog.getByRole('textbox', { name: 'Recovered draft' })).toHaveValue(/PERMISSION-REJECTED-DRAFT/);
    await dialog.getByRole('button', { name: 'Keep for later', exact: true }).click();
    await s.b.reload();
    await expect(s.b.locator('.dl-status')).toHaveText('View only');
    await s.b.getByRole('button', { name: 'Recover text', exact: true }).click();
    await expect(s.b.getByRole('textbox', { name: 'Recovered draft' })).toHaveValue(/PERMISSION-REJECTED-DRAFT/);
    await expect(s.b.getByRole('button', { name: 'Insert recovered copy' })).toBeDisabled();
    expect(s.source()).not.toContain('PERMISSION-REJECTED-DRAFT');
  } finally { await s.close(); }
});

test('full local draft storage reports the failure while online typing still saves', async ({ browser }, info) => {
  const s = await session(browser, info, 'Shared baseline.');
  try {
    await s.a.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith('ol.textRecovery:')) throw new DOMException('Quota exceeded', 'QuotaExceededError');
        return original.call(this, key, value);
      };
    });
    await append(s.a, ' STORAGE-FULL', false);
    await expect(s.a.getByText('Browser storage is full. Keep this tab open until Saved appears.', { exact: true }).first()).toBeVisible();
    await s.a.keyboard.press('Escape');
    await expect.poll(s.source).toContain('STORAGE-FULL');
    await expect(s.a.locator('.dl-status')).toHaveText('Saved');
    await s.a.reload(); await expect(box(s.a)).toContainText('STORAGE-FULL');
  } finally { await s.close(); }
});

test('unavailable IndexedDB keeps online editing usable and does not claim a local save', async ({ browser }, info) => {
  const s = await session(browser, info, 'Shared baseline.');
  try {
    const errors: string[] = [];
    s.a.on('pageerror', error => errors.push(error.message));
    await s.a.addInitScript(() => { IDBFactory.prototype.open = () => { throw new DOMException('Browser storage disabled', 'SecurityError'); }; });
    await s.a.reload();
    await expect(box(s.a)).toHaveText('Shared baseline.');
    await append(s.a, ' PRIVATE-MODE-ONLINE');
    await expect.poll(s.source).toContain('PRIVATE-MODE-ONLINE');
    await expect(s.a.locator('.dl-status')).toHaveText('Saved');
    expect(errors).toEqual([]);
  } finally { await s.close(); }
});

test('an IndexedDB write failure preserves the draft and reports that offline changes need the tab open', async ({ browser }, info) => {
  const s = await session(browser, info, 'Shared baseline.');
  try {
    const errors: string[] = []; s.a.on('pageerror', error => errors.push(error.message));
    await s.a.context().routeWebSocket('**/ws/**', socket => socket.close());
    await s.a.reload(); await expect(s.a.locator('.dl-status')).toHaveText('Offline');
    await s.a.evaluate(() => {
      const add = IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.add = function (value, key) {
        if (this.name === 'updates') throw new DOMException('Local disk full', 'QuotaExceededError');
        return add.call(this, value, key);
      };
    });
    await append(s.a, ' LOCAL-DISK-FULL');
    await expect(s.a.locator('.dl-status')).toHaveText('Offline — keep this tab open');
    expect(errors).toEqual([]); expect(s.source()).not.toContain('LOCAL-DISK-FULL');
    await s.a.evaluate(() => { location.hash = ''; });
    await expect(s.a.locator('.dl-editor')).toHaveCount(0);
    await s.a.evaluate(key => { location.hash = `/${key}/talk/index.html`; }, s.key);
    await expect(s.a.locator('[data-dl-recovery-notice]')).toBeVisible();
    await s.a.getByRole('button', { name: 'Recover text', exact: true }).click();
    await expect(s.a.getByRole('textbox', { name: 'Recovered draft' })).toHaveValue(/LOCAL-DISK-FULL/);
  } finally { await s.close(); }
});


test('a cached history whose metadata cannot be read stays recoverable instead of merging into a reset file', async ({ browser }, info) => {
  const s = await session(browser, info, 'Shared baseline.');
  try {
    await append(s.a, ' CACHED-SOURCE');
    await expect.poll(s.source).toContain('CACHED-SOURCE');
    await expect(s.a.locator('.dl-status')).toHaveText('Saved');
    const reset = await s.a.request.post(`/api/docs/${encodeURIComponent(s.key + '/talk/index.html')}/reset`);
    expect(reset.ok()).toBe(true);
    await s.a.addInitScript(() => {
      const get = IDBObjectStore.prototype.get;
      IDBObjectStore.prototype.get = function (key) {
        if (this.name === 'custom' && key === 'epoch') throw new DOMException('Metadata read failed', 'UnknownError');
        return get.call(this, key);
      };
    });
    await s.a.reload();
    await expect(s.a.locator('[data-dl-stale-notice]')).toBeVisible();
    const downloadPromise = s.a.waitForEvent('download');
    await s.a.getByRole('button', { name: 'Download local source', exact: true }).click();
    expect(readFileSync((await (await downloadPromise).path())!, 'utf8')).toContain('CACHED-SOURCE');
    expect((s.source().match(/<!doctype/gi) ?? [])).toHaveLength(1);
    expect((s.source().match(/CACHED-SOURCE/g) ?? [])).toHaveLength(1);
  } finally { await s.close(); }
});
