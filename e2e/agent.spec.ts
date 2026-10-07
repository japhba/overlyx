/**
 * The Agent panel (app/AgentPanel.tsx + packages/server/src/agent.ts) against the codex
 * app-server stub: the server under test must run with OVERLYX_CODEX_BIN=scripts/codex-stub.mjs
 * and OVERLYX_E2E_AGENT_STUB=1 exported for this spec. Covers the device-code sign-in (the stub
 * completes it by itself), a streamed reply in a fresh thread, a file the agent writes in its
 * working copy reaching the project, a patch there arriving as word-level tracked changes, what the
 * agent may read (all my projects / this project only), and the thread list.
 */
import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { login, PROJECTS_DIR, texDoc, grantClipboard, readClipboard, browserName, acceptDialog } from './helpers';

const PROJECT = 'admin/e2e-agent';
const DOC = `${PROJECT}/paper.tex`;
const AGENT_STUB = !!process.env.OVERLYX_E2E_AGENT_STUB;

test.skip(!AGENT_STUB, 'needs the codex stub (OVERLYX_CODEX_BIN=scripts/codex-stub.mjs, OVERLYX_E2E_AGENT_STUB=1)');

test.beforeAll(() => {
  rmSync(join(PROJECTS_DIR, PROJECT), { recursive: true, force: true });
  mkdirSync(join(PROJECTS_DIR, PROJECT), { recursive: true });
  writeFileSync(join(PROJECTS_DIR, PROJECT, 'paper.tex'), texDoc('The agent will help with this paper.'));
});
test.afterAll(() => { rmSync(join(PROJECTS_DIR, PROJECT), { recursive: true, force: true }); });

test('sign in, ask, let it write, limit what it reads, find the thread again', async ({ page, context }) => {
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
  await grantClipboard(context);
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
  if (browserName(page) === 'webkit') {
    // Playwright's WebKit runs no copy for Ctrl+C on text outside an editable element (Safari's ⌘C does):
    // the copy event Safari sends, then the clipboard the paste below reads
    const copied = await page.evaluate(() => {
      const data = new DataTransfer();
      getSelection()!.anchorNode!.parentElement!.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
      return data.getData('text/plain');
    });
    expect(copied).toBe('$E=mc^2$');
    await page.evaluate(t => navigator.clipboard.writeText(t), copied);
  } else {
    await page.keyboard.press('Control+c');
    expect(await readClipboard(page)).toBe('$E=mc^2$');
  }
  // pasted into the document it becomes a real, editable formula again
  await page.locator('.lyx-editor .lyx-par').first().click({ position: { x: 12, y: 8 } });
  await page.keyboard.press('End');
  await page.keyboard.press('Control+v');
  await expect(page.locator('.lyx-editor .lyx-math-inline')).toHaveCount(1, { timeout: 10000 });

  // a file the agent writes in its working copy reaches the project without asking
  await page.locator('.agent-compose textarea').fill('write hello for me');
  await page.keyboard.press('Enter');
  const helloFile = join(PROJECTS_DIR, PROJECT, 'hello.txt');
  await expect.poll(() => existsSync(helloFile), { timeout: 10000 }).toBe(true);
  expect(readFileSync(helloFile, 'utf8')).toContain('hello from the stub agent');
  await expect(page.locator('.agent-msg.assistant').last()).toContainText('Stub reply', { timeout: 15000 });

  // the agent patches the document in its working copy: the live document gets just the changed
  // word as tracked changes (the rest of the sentence untouched), in the editor and in the file
  await page.locator('.agent-compose textarea').fill('edit the paper please');
  await page.keyboard.press('Enter');
  await expect(page.locator('.lyx-editor .lyx-change-deleted')).toHaveText('help', { timeout: 15000 });
  await expect(page.locator('.lyx-editor .lyx-change-inserted')).toHaveText('assist');
  await expect(page.locator('.lyx-editor')).toContainText('The agent will helpassist with this paper.');
  await expect.poll(() => readFileSync(join(PROJECTS_DIR, DOC), 'utf8'), { timeout: 10000 }).toMatch(/\\lyxdeleted\{Agent panel \(MCP\)\}\{[^}]*\}\{help\}\\lyxadded\{Agent panel \(MCP\)\}\{[^}]*\}\{assist\}/);
  // the turn ends with its checkpoint: what it changed, and the way back
  const firstCp = page.locator('[data-agent="checkpoint"]').last();
  await expect(firstCp).toContainText('Changed paper.tex +6 −4', { timeout: 15000 });
  await expect(firstCp.locator('[data-agent-undo]')).toBeVisible();

  // a turn that breaks the build: the document built before, so the check says so — and Undo
  // takes the turn back exactly (the earlier help → assist change stays). Track changes is
  // unticked for it: its edit goes into the text as it is, no marks — Undo works all the same
  const built = await page.request.post(`/api/docs/${encodeURIComponent(DOC)}/export`, { data: { format: 'pdf' } });
  expect(built.ok()).toBe(true);
  await expect.poll(async () => (await (await page.request.get(`/api/docs/${encodeURIComponent(DOC)}/build`)).json()).build?.status, { timeout: 60000 }).toBe('ok');
  const trackBox = page.locator('[data-agent-tracked] input');
  await expect(trackBox).toBeChecked();
  await trackBox.uncheck();
  await page.locator('.agent-compose textarea').fill('break the paper please');
  await page.keyboard.press('Enter');
  const brokeCp = page.locator('[data-agent="checkpoint"]').last();
  await expect(brokeCp.locator('[data-agent-build="error"][data-broke="1"]')).toContainText('paper.tex no longer builds', { timeout: 60000 });
  await expect(brokeCp).toContainText('Undefined control sequence');
  await expect(brokeCp.locator('[data-agent-fix]')).toBeVisible();
  await expect(page.locator('.lyx-editor')).toContainText('brokenmacro');
  await expect.poll(() => readFileSync(join(PROJECTS_DIR, DOC), 'utf8'), { timeout: 10000 }).toContain('\\brokenmacro{} this paper.');
  expect(readFileSync(join(PROJECTS_DIR, DOC), 'utf8')).not.toMatch(/\\lyxadded\{[^}]*\}\{[^}]*\}\{[^}]*brokenmacro/);
  await brokeCp.locator('[data-agent-undo]').click();
  await acceptDialog(page);
  await expect(brokeCp).toContainText('Took back paper.tex', { timeout: 15000 });
  await expect(page.locator('.lyx-editor')).not.toContainText('brokenmacro');
  await expect(page.locator('.lyx-editor .lyx-change-inserted')).toHaveText('assist');
  await expect.poll(() => readFileSync(join(PROJECTS_DIR, DOC), 'utf8'), { timeout: 10000 }).not.toContain('brokenmacro');
  await trackBox.check();

  // codex gating an overlyx MCP tool call arrives as an elicitation: the card shows the
  // question and the tool arguments; allowing it answers with an ElicitResult (accept)
  await page.locator('.agent-compose textarea').fill('use the mcp tool please');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-agent="approval"]')).toContainText('Allow overlyx.insert_paragraphs?', { timeout: 15000 });
  await expect(page.locator('[data-agent="approval"]')).toContainText('latex: \\section{Probe}');
  await page.locator('[data-agent="approval"] [data-approve="accept"]').click();
  await expect(page.locator('.agent-msg.assistant').last()).toContainText('elicitation accepted', { timeout: 15000 });

  // markdown links in the reply render as real links
  await page.locator('.agent-compose textarea').fill('see [the docs](https://example.org/d) here');
  await page.keyboard.press('Enter');
  await expect(page.locator('.agent-msg.assistant a[href="https://example.org/d"]').last()).toHaveText('the docs', { timeout: 15000 });

  // block markdown in a reply: a GFM table and a block quote render as such (the stub answers with one)
  await page.locator('.agent-compose textarea').fill('show me a table');
  await page.keyboard.press('Enter');
  const tabled = page.locator('.agent-msg.assistant', { has: page.locator('table.agent-table') }).last();
  await expect(tabled).toBeVisible({ timeout: 15000 });
  await expect(tabled.locator('table.agent-table th')).toHaveText(['Model', 'Acc']);
  await expect(tabled.locator('table.agent-table td').last()).toHaveText('92.1');
  await expect(tabled.locator('table.agent-table td').last()).toHaveCSS('text-align', 'right');
  await expect(tabled.locator('blockquote.agent-quote b')).toHaveText('note');

  // a request to leave the sandbox never becomes a card: the server declines it by itself
  await page.locator('.agent-compose textarea').fill('write outside the copy');
  await page.keyboard.press('Enter');
  await expect(page.locator('.agent-msg.assistant').last()).toContainText('outside write declined', { timeout: 15000 });
  await expect(page.locator('[data-agent="approval"]')).toHaveCount(0);

  // a pending approval survives a reload: the thread read returns it and the card comes back
  await page.locator('.agent-compose textarea').fill('use the mcp tool once more');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-agent="approval"]')).toBeVisible({ timeout: 15000 });
  await page.reload();
  await page.waitForSelector('.lyx-editor', { timeout: 30000 });
  await expect(page.locator('[data-agent="approval"]')).toBeVisible({ timeout: 15000 });
  await page.locator('[data-agent="approval"] [data-approve="decline"]').click();
  await expect(page.locator('.agent-msg.assistant').last()).toContainText('elicitation decline', { timeout: 15000 });

  // what the agent may read: all my projects by default; limited to this project, the thread keeps
  // it (also after a reload) and the agent is told before the next message
  const scopeSel = page.locator('select[data-agent-scope]');
  await expect(scopeSel).toHaveValue('all');
  const tid = await page.evaluate(() => localStorage.getItem('ol.agent.sel:admin/e2e-agent'));
  const scopeSaved = page.waitForResponse(r => r.url().includes('/scope') && r.request().method() === 'POST');
  await scopeSel.selectOption('project');
  expect((await scopeSaved).status()).toBe(200);
  const threadScope = async () => (await (await page.request.get(`/api/projects/${encodeURIComponent(PROJECT)}/agent/threads/${tid}`)).json()).scope;
  expect(await threadScope()).toBe('project');
  await page.reload();
  await page.waitForSelector('.lyx-editor', { timeout: 30000 });
  await expect(page.locator('select[data-agent-scope]')).toHaveValue('project', { timeout: 15000 });
  await page.locator('.agent-compose textarea').fill('what can you read?');
  await page.keyboard.press('Enter');
  await expect(page.locator('.agent-msg.assistant').last()).toContainText('Stub reply to: what can you read?', { timeout: 15000 });
  await expect(page.locator('.agent-msg.user').last()).not.toContainText('[context]');   // the scope note stays hidden
  await page.locator('select[data-agent-scope]').selectOption('all');
  await expect.poll(threadScope).toBe('all');

  // a turn that fails (here: the ChatGPT account's usage limit) says so in the transcript, also
  // after a reload; codex's retries before it ("Reconnecting... 1/5") neither end the turn nor pop up
  await page.locator('.agent-compose textarea').fill('pretend we hit the usage limit');
  await page.keyboard.press('Enter');
  const failed = page.locator('[data-agent="error"]');
  await expect(failed).toContainText('You’ve hit your usage limit', { timeout: 15000 });
  await expect(failed).toHaveCount(1);
  await expect(failed.locator('a[href="https://chatgpt.com/codex/settings/usage"]')).toHaveCount(1);
  await expect(page.getByText('Reconnecting...')).toHaveCount(0);
  await page.reload();
  await page.waitForSelector('.lyx-editor', { timeout: 30000 });
  await expect(page.locator('[data-agent="error"]')).toContainText('You’ve hit your usage limit', { timeout: 15000 });

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
