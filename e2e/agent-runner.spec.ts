/**
 * Claude Code on the user's computer, started from the Agent panel (`overlyx agent run`,
 * server agentRunner.ts): the runner appears as "Claude Code on <computer>", the panel offers the
 * models and efforts its Claude Code takes, a message runs `claude -p` with the ones picked (a fake
 * `claude` here, printing stream-json), its tool calls arrive as progress and its last message as
 * the answer; Stop ends a turn; when the runner is gone the panel says how to start it.
 * Needs OVERLYX_E2E_SERVER (the CLI talks to the server directly; vite does not proxy /cli).
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hostname, tmpdir } from 'node:os';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { login, openDoc, apiLogin, BASE_URL, PROJECTS_DIR, texDoc } from './helpers';

const PROJECT = 'admin/e2e-runner';
const SERVER = (process.env.OVERLYX_E2E_SERVER ?? BASE_URL).replace(/\/$/, '');
const CLI = resolve('packages/cli/bin/overlyx.js');
const DIR = join(tmpdir(), 'overlyx-e2e-runner');
const FAKE = join(DIR, 'bin'), CFG = join(DIR, 'config'), LOG = join(DIR, 'claude.log');
const COMPUTER = hostname().replace(/[^\w.-]+/g, '-').slice(0, 60) || 'computer';
const env = () => ({ ...process.env, OVERLYX_CONFIG_DIR: CFG, PATH: `${FAKE}:${process.env.PATH}` });

test.describe.configure({ mode: 'serial' });
let runner: ChildProcess | null = null;

const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === '--help') { console.log("  --effort <level>  Effort level (low, medium, high, xhigh, max)\\n  --model <model>  an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet') or a full name\\n  --permission-mode <mode> (choices: \\"dontAsk\\")\\n  --tools <tools...>"); process.exit(0); }
if (args[0] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }
let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ args, input }) + '\\n');
  const out = o => process.stdout.write(JSON.stringify({ ...o, session_id: 'e2e-session' }) + '\\n');
  out({ type: 'system', subtype: 'init', model: 'claude-e2e' });
  if (input.includes('SLOW')) { setInterval(() => {}, 1000); return; }
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__overlyx__read_document', input: { project: ${JSON.stringify(PROJECT)}, path: 'main.tex' } }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'Done: the paragraph reads well.' });
});
`;

function startRunner() {
  runner = spawn(process.execPath, [CLI, 'agent', 'run', '--host', SERVER], { env: env(), stdio: 'ignore' });
}

test.beforeAll(async ({ browser }) => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(FAKE, { recursive: true });
  writeFileSync(join(FAKE, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  rmSync(join(PROJECTS_DIR, PROJECT), { recursive: true, force: true });
  mkdirSync(join(PROJECTS_DIR, PROJECT), { recursive: true });
  writeFileSync(join(PROJECTS_DIR, PROJECT, 'main.tex'), texDoc('A paragraph for the agent.'));
  // the CLI signed in with the account's token (rotated: an earlier run may have left one)
  const ctx = await browser.newContext();
  await apiLogin(ctx);
  const r = await ctx.request.post(BASE_URL + '/api/git/tokens');
  expect(r.ok()).toBeTruthy();
  const token = (await r.json()).token as string;
  await ctx.close();
  execFileSync(process.execPath, [CLI, 'auth', 'login', '--host', SERVER, '--username', 'admin', '--token', token], { env: env(), stdio: 'ignore' });
  startRunner();
});
test.afterAll(() => {
  runner?.kill();
  rmSync(join(PROJECTS_DIR, PROJECT), { recursive: true, force: true });
  rmSync(DIR, { recursive: true, force: true });
});

test('the panel picks model and effort; Claude Code runs on the computer with them; progress and the answer arrive; Stop ends a turn', async ({ page }) => {
  await login(page);
  await openDoc(page, `${PROJECT}/main.tex`);
  await page.locator('[data-rail="agent"], [data-tab="agent"]').first().click();
  await page.locator('[data-agent-tab]', { hasText: `Claude Code on ${COMPUTER}` }).first().click({ timeout: 20000 });
  const view = page.locator('[data-ext-agent]');
  await expect(view.locator('[data-ext-status]')).toContainText(`Ready on ${COMPUTER}`, { timeout: 20000 });
  await expect(view.locator('[data-runner-model] option')).toHaveText(['Default model', 'fable', 'opus', 'sonnet', 'haiku']);
  await expect(view.locator('[data-runner-effort] option')).toHaveText(['Default effort', 'low', 'medium', 'high', 'xhigh', 'max']);
  await view.locator('[data-runner-model]').selectOption('opus');
  await view.locator('[data-runner-effort]').selectOption('high');
  await view.locator('[data-runner-fresh]').click();
  await view.locator('[data-ext-input]').fill('Check the first paragraph');
  await view.locator('[data-ext-send]').click();
  const mine = view.locator('[data-ext-msg]', { hasText: 'Check the first paragraph' }).last();
  await expect(mine.locator('[data-ext-options]')).toHaveText('opus · effort high · new conversation');
  await expect(view.locator('.ext-reply:not(.progress)', { hasText: 'Done: the paragraph reads well.' }).last()).toBeVisible({ timeout: 20000 });
  await expect(view.locator('.ext-reply.progress', { hasText: 'read_document' }).last()).toContainText('main.tex');
  await expect(mine.locator('.ext-state')).toHaveText('Answered');
  const call = JSON.parse(readFileSync(LOG, 'utf8').trim().split('\n').at(-1)!);
  expect(call.args.slice(call.args.indexOf('--model'), call.args.indexOf('--model') + 2)).toEqual(['--model', 'opus']);
  expect(call.args.slice(call.args.indexOf('--effort'), call.args.indexOf('--effort') + 2)).toEqual(['--effort', 'high']);
  expect(call.args).not.toContain('--resume');
  expect(call.input).toContain('Check the first paragraph');

  // a long turn: the header says so, Stop ends it
  await view.locator('[data-ext-input]').fill('SLOW: take your time');
  await view.locator('[data-ext-send]').click();
  await expect(view.locator('[data-ext-status]')).toContainText(`Working on ${COMPUTER}`, { timeout: 20000 });
  await view.locator('[data-ext-stop]').click();
  await expect(view.locator('.ext-reply:not(.progress)').last()).toHaveText('Stopped.', { timeout: 20000 });
  await expect(view.locator('[data-ext-status]')).toContainText(`Ready on ${COMPUTER}`);
});

test('without its runner the agent shows offline, with how to start it on that computer', async ({ page }) => {
  runner?.kill();
  await login(page);
  await openDoc(page, `${PROJECT}/main.tex`);
  await page.locator('[data-rail="agent"], [data-tab="agent"]').first().click();
  await page.locator('[data-agent-tab]', { hasText: `Claude Code on ${COMPUTER}` }).first().click({ timeout: 20000 });
  const view = page.locator('[data-ext-agent]');
  await expect(view.locator('[data-ext-status]')).toContainText('Offline', { timeout: 20000 });
  await expect(view.locator('[data-ext-hint]')).toContainText('overlyx agent install');
});
