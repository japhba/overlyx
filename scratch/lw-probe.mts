// A look at File ▸ LessWrong against the stub (OVERLYX_E2E_LESSWRONG_STUB=1): connect, link, sync, a comment from LessWrong.
import { chromium } from 'playwright';
import { login, BASE_URL } from '../e2e/helpers';
const OUT = process.env.SHOTS ?? '/tmp';
const browser = await chromium.launch();
const ctx = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1300, height: 900 } });
const page = await ctx.newPage();
const errors: string[] = [];
page.on('pageerror', e => errors.push(String(e)));
await login(page);
await page.goto(BASE_URL + '/#/admin/lwtest/post.md');
await page.waitForSelector('.lyx-editor', { timeout: 30000 });
await page.waitForTimeout(1500);
const openDialog = async () => {
  await page.getByRole('menuitem', { name: 'File' }).or(page.locator('.menubar >> text=File')).first().click();
  await page.getByText('LessWrong (sync, comments)…').click();
  await page.waitForSelector('[data-lesswrong]');
};
await openDialog();
await page.screenshot({ path: OUT + '/lw-1-connect.png' });
await page.click('[data-lw-connect]');
await page.waitForSelector('[data-lw-url]', { timeout: 20000 });
await page.screenshot({ path: OUT + '/lw-2-link.png' });
// a draft on (simulated) LessWrong, shared with its key
const made = await page.evaluate(async () => (await fetch('/api/lesswrong/e2e/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'My post', key: 'k3y' }) })).json());
await page.fill('[data-lw-url]', made.url);
await page.click('[data-lw-link]');
await page.waitForSelector('[data-lw-sync]', { timeout: 20000 });
const lw = await page.evaluate(async () => (await fetch('/api/lesswrong/e2e/post?doc=admin/lwtest/post.md')).json());
console.log('DRAFT:\n' + lw.markdown);
// a reader on LessWrong edits and comments
await page.evaluate(async () => {
  const h = { 'content-type': 'application/json' };
  await fetch('/api/lesswrong/e2e/edit', { method: 'POST', headers: h, body: JSON.stringify({ doc: 'admin/lwtest/post.md', from: 'says something', to: 'says something new' }) });
  await fetch('/api/lesswrong/e2e/comment', { method: 'POST', headers: h, body: JSON.stringify({ doc: 'admin/lwtest/post.md', quote: 'The second paragraph', content: 'Source for this?' }) });
});
await page.click('[data-lw-sync]');
await page.waitForTimeout(2500);
await page.screenshot({ path: OUT + '/lw-3-synced.png' });
await page.keyboard.press('Escape');
await page.waitForTimeout(800);
const text = await page.locator('.lyx-editor').first().innerText();
console.log('EDITOR has new words:', text.includes('says something new'));
await page.screenshot({ path: OUT + '/lw-4-editor.png' });
const chip = await page.locator('[data-sync-chip]').first().textContent().catch(() => null);
console.log('CHIP:', chip);
console.log('ERRORS:', errors);
await browser.close();
