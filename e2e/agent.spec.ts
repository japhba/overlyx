/**
 * The Agent panel (app/AgentPanel.tsx + packages/server/src/agent.ts) against the codex
 * app-server stub: the server under test must run with OVERLYX_CODEX_BIN=scripts/codex-stub.mjs
 * and OVERLYX_E2E_AGENT_STUB=1 exported for this spec. Covers the device-code sign-in (the stub
 * completes it by itself), a streamed reply in a fresh thread, the file-change approval writing
 * into the project, and the thread list.
 */
import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { login, PROJECTS_DIR, texDoc } from './helpers';

const PROJECT = 'e2e-agent';
const DOC = `${PROJECT}/paper.tex`;
const AGENT_STUB = !!process.env.OVERLYX_E2E_AGENT_STUB;

test.skip(!AGENT_STUB, 'needs the codex stub (OVERLYX_CODEX_BIN=scripts/codex-stub.mjs, OVERLYX_E2E_AGENT_STUB=1)');

test.beforeAll(() => {
  rmSync(join(PROJECTS_DIR, PROJECT), { recursive: true, force: true });
  mkdirSync(join(PROJECTS_DIR, PROJECT), { recursive: true });
  writeFileSync(join(PROJECTS_DIR, PROJECT, 'paper.tex'), texDoc('The agent will help with this paper.'));
});
test.afterAll(() => { rmSync(join(PROJECTS_DIR, PROJECT), { recursive: true, force: true }); });

test('sign in, ask, approve a file change, find the thread again', async ({ page, context }) => {
  test.setTimeout(120000);
  await login(page);
  // the Agent panel is hidden until AI assistance is activated in the settings
  await page.evaluate(() => localStorage.setItem('ol.prefs', JSON.stringify({ aiButton: true })));
  await page.goto('/#/' + DOC);
  await page.reload();
  await page.waitForSelector('.lyx-editor', { timeout: 30000 });

  // open the Agent panel (rail button when the sidebar is collapsed, panel tab otherwise)
  await page.locator('[data-rail="agent"], [data-tab="agent"]').first().click();
  await expect(page.locator('.agent-panel')).toBeVisible();

  // device-code sign-in: the stub "approves" it after a moment and the panel switches over
  await page.locator('[data-agent-login]').click();
  await expect(page.locator('[data-agent-code]')).toHaveText('STUB-CODE');
  await expect(page.locator('.agent-compose textarea')).toBeVisible({ timeout: 15000 });

  // the model and effort selectors come from codex's model list
  await expect(page.locator('select[data-agent-model]')).toBeVisible();
  await expect(page.locator('select[data-agent-model] option', { hasText: 'Stub Model' })).toHaveCount(1);
  await expect(page.locator('select[data-agent-effort]')).toHaveValue('medium');

  // a first message starts a thread; the stubbed reply streams in
  await page.locator('.agent-compose textarea').fill('hello agent');
  await page.keyboard.press('Enter');
  await expect(page.locator('.agent-msg.assistant')).toContainText('Stub reply to: hello agent', { timeout: 15000 });
  await expect(page.locator('.agent-msg.user')).toContainText('hello agent');   // context items stay hidden
  await expect(page.locator('.agent-msg.user')).toHaveCount(1);                 // the echoed item replaces the local bubble — no doubling

  // equations render through the LyX math renderer — in the reply and in the user's own bubble
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator('.agent-compose textarea').fill('prove $E=mc^2$ please');
  await page.keyboard.press('Enter');
  await expect(page.locator('.agent-msg.assistant .agent-math[data-latex="E=mc^2"]').last()).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.agent-msg.user .agent-math[data-latex="E=mc^2"]')).toHaveCount(1);
  // drag-select + copy an equation: the clipboard carries its LaTeX source
  await page.locator('.agent-msg.assistant').last().click();
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('.agent-msg.assistant .agent-math')].pop()!;
    const r = document.createRange(); r.selectNodeContents(el);
    const sel = window.getSelection()!; sel.removeAllRanges(); sel.addRange(r);
  });
  await page.keyboard.press('Control+c');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('$E=mc^2$');
  // pasted into the document it becomes a real, editable formula again
  await page.locator('.lyx-editor .lyx-par').first().click({ position: { x: 12, y: 8 } });
  await page.keyboard.press('End');
  await page.keyboard.press('Control+v');
  await expect(page.locator('.lyx-editor .lyx-math-inline')).toHaveCount(1, { timeout: 10000 });

  // a file change asks for approval; allowing it writes into the project
  await page.locator('.agent-compose textarea').fill('write hello for me');
  await page.keyboard.press('Enter');
  await page.locator('[data-agent="approval"] [data-approve="accept"]').click({ timeout: 15000 });
  const helloFile = join(PROJECTS_DIR, PROJECT, 'hello.txt');
  await expect.poll(() => existsSync(helloFile), { timeout: 10000 }).toBe(true);
  expect(readFileSync(helloFile, 'utf8')).toContain('hello from the stub agent');
  await expect(page.locator('.agent-msg.assistant').last()).toContainText('Stub reply', { timeout: 15000 });

  // the thread is in the project's list under its first message
  await page.locator('[data-agent-back]').click();
  await expect(page.locator('[data-agent-thread] .title').first()).toContainText('hello agent');
  await page.locator('[data-agent-thread]').first().click();
  await expect(page.locator('.agent-msg.assistant').first()).toContainText('Stub reply to: hello agent');

  // a reload comes back to the same view: panel open on the same thread, user bubbles included
  // (the transcript path joins codex's concatenated input — the context block must strip cleanly)
  await page.reload();
  await page.waitForSelector('.lyx-editor', { timeout: 30000 });
  await expect(page.locator('.agent-msg.assistant').first()).toContainText('Stub reply to: hello agent', { timeout: 15000 });
  await expect(page.locator('.agent-msg.user').first()).toContainText('hello agent');
  await expect(page.locator('.agent-msg.user').first()).not.toContainText('[context]');
});
