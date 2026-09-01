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

test('sign in, ask, approve a file change, find the thread again', async ({ page }) => {
  test.setTimeout(120000);
  await login(page);
  await page.goto('/#/' + DOC);
  await page.waitForSelector('.lyx-editor', { timeout: 30000 });

  // open the Agent panel (rail button when the sidebar is collapsed, panel tab otherwise)
  await page.locator('[data-rail="agent"], [data-tab="agent"]').first().click();
  await expect(page.locator('.agent-panel')).toBeVisible();

  // device-code sign-in: the stub "approves" it after a moment and the panel switches over
  await page.locator('[data-agent-login]').click();
  await expect(page.locator('[data-agent-code]')).toHaveText('STUB-CODE');
  await expect(page.locator('.agent-compose textarea')).toBeVisible({ timeout: 15000 });

  // a first message starts a thread; the stubbed reply streams in
  await page.locator('.agent-compose textarea').fill('hello agent');
  await page.keyboard.press('Enter');
  await expect(page.locator('.agent-msg.assistant')).toContainText('Stub reply to: hello agent', { timeout: 15000 });
  await expect(page.locator('.agent-msg.user')).toContainText('hello agent');   // context items stay hidden

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
});
