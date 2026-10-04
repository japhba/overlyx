/**
 * Agents connected over MCP from elsewhere, end to end (server mcp.ts / mcpAgents.ts /
 * agentPresence.ts, client ExternalAgents.tsx): the admin puts a selection into a document in a
 * real browser and an MCP client — the SDK, as Codex or Claude Code would connect with the account
 * token — reads it back with get_presence; the agent edits and points at a passage, and the browser
 * shows it as a collaborator; a message written in the Agent panel reaches the agent through
 * wait_for_instructions and its reply shows in the panel; "Ask agent about this" pins a passage for
 * the next message; a Claude Code session gets the message pushed (channels); a collaborator can
 * neither see nor reach the admin's agents.
 *
 * MCP is not proxied by the vite dev server: OVERLYX_E2E_SERVER names the server under test when
 * OVERLYX_E2E_BASE is vite (e.g. OVERLYX_E2E_SERVER=http://127.0.0.1:3001).
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { login, openDoc, apiLogin, userCredentials, BASE_URL, PROJECTS_DIR, texDoc } from './helpers';

const PROJECT = 'admin/e2e-mcp';
const DOC = `${PROJECT}/main.tex`;
const SERVER = (process.env.OVERLYX_E2E_SERVER ?? BASE_URL).replace(/\/$/, '');

test.describe.configure({ mode: 'serial' });

let token = '';
const clients: Client[] = [];

test.beforeAll(async ({ browser }) => {
  rmSync(join(PROJECTS_DIR, PROJECT), { recursive: true, force: true });
  mkdirSync(join(PROJECTS_DIR, PROJECT), { recursive: true });
  writeFileSync(join(PROJECTS_DIR, PROJECT, 'main.tex'), texDoc('The first paragraph sets the scene.\n\nThe second paragraph has the quick brown fox and the lazy dog.\n\nThe third paragraph has a typo in it.'));
  // the account's one access token (Git, CLI and MCP) — created, or rotated when an earlier run left one
  const ctx = await browser.newContext();
  await apiLogin(ctx);
  const r = await ctx.request.post(BASE_URL + '/api/git/tokens');
  expect(r.ok()).toBeTruthy();
  token = (await r.json()).token;
  await ctx.close();
});
test.afterAll(async () => {
  for (const c of clients) await c.close().catch(() => { /* closed */ });
  rmSync(join(PROJECTS_DIR, PROJECT), { recursive: true, force: true });
});

/** An MCP client with the account token, as `name` (clientInfo) — 'claude-code' gets a session with an event stream. */
async function connect(name: string): Promise<{ client: Client; pushed: { content: string; meta: Record<string, string> }[] }> {
  const client = new Client({ name, version: 'e2e' });
  const pushed: { content: string; meta: Record<string, string> }[] = [];
  client.fallbackNotificationHandler = async (n) => { if (n.method === 'notifications/claude/channel') pushed.push(n.params as never); };
  await client.connect(new StreamableHTTPClientTransport(new URL(SERVER + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  clients.push(client);
  return { client, pushed };
}
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 70000 });
  const text = (r.content as { text: string }[])[0].text;
  if (r.isError) throw new Error(text);
  try { return JSON.parse(text); } catch { return text; }
}

/** Select `needle` in the editor (as a mouse drag would): ProseMirror takes the DOM selection over. */
async function selectText(page: Page, needle: string): Promise<void> {
  await page.evaluate((s) => {
    const root = document.querySelector('.lyx-editor') as HTMLElement;   // the ProseMirror element itself
    root.focus();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = (n.textContent ?? '').indexOf(s);
      if (i < 0) continue;
      const range = document.createRange();
      range.setStart(n, i); range.setEnd(n, i + s.length);
      const sel = window.getSelection()!;
      sel.removeAllRanges(); sel.addRange(range);
      return;
    }
    throw new Error('not in the document: ' + s);
  }, needle);
}

async function openAgentPanel(page: Page) {
  await page.locator('[data-rail="agent"], [data-tab="agent"]').first().click();
  await expect(page.locator('.agent-wrap')).toBeVisible();
}

test('get_presence sees the selection the user made in the browser, in read_document terms', async ({ page }) => {
  await login(page);
  await openDoc(page, DOC);
  await selectText(page, 'quick brown fox');
  const { client } = await connect('codex-mcp-client');
  const mine = async () => {
    const r = await call(client, 'get_presence', { project: PROJECT, path: 'main.tex' });
    return r.documents[0]?.people.find((p: any) => p.you) ?? null;
  };
  await expect.poll(async () => (await mine())?.selection?.text ?? null, { timeout: 15000 }).toBe('quick brown fox');
  const me = await mine();
  expect(me).toMatchObject({ kind: 'person', cursor: { paragraph: 1 }, selection: { from: { paragraph: 1 }, to: { paragraph: 1 } } });
  expect(me.cursor.excerpt).toContain('quick brown fox‸ and the lazy dog');
  const read = await call(client, 'read_document', { project: PROJECT, path: 'main.tex' });
  expect(read.paragraphs[1].text.slice(me.selection.from.offset, me.selection.to.offset)).toBe('quick brown fox');
  // without a project: where the user is, in any of their projects
  const anywhere = await call(client, 'get_presence', {});
  expect(anywhere.documents.map((d: any) => `${d.project}/${d.path}`)).toContain(DOC);
});

test('the agent appears in the document as a collaborator: its caret on its edit, its highlight on a passage', async ({ page }) => {
  await login(page);
  await openDoc(page, DOC);
  const { client } = await connect('codex-mcp-client');
  await call(client, 'edit_document', { project: PROJECT, path: 'main.tex', old_text: 'the lazy dog', new_text: 'the sleepy dog', tracked: false });
  // the browser's collaborator rendering: a named caret, and an avatar in the presence list
  const caret = page.locator('.ProseMirror-yjs-cursor', { hasText: 'Codex (Admin)' });
  await expect(caret).toHaveCount(1, { timeout: 15000 });
  // (the caret's name label sits in the text: read it without the collaborators' carets)
  const plainText = () => page.evaluate(() => { const c = document.querySelector('.lyx-editor')!.cloneNode(true) as HTMLElement; c.querySelectorAll('.ProseMirror-yjs-cursor').forEach(x => x.remove()); return c.textContent; });
  await expect.poll(plainText).toContain('the sleepy dog');
  // the caret sits right after what the edit changed ("laz" → "sleep"; the "y" was kept)
  expect(await caret.evaluate(el => { const r = document.createRange(); r.setStart(el.closest('.lyx-par')!, 0); r.setEndBefore(el); return r.toString(); })).toMatch(/the sleep$/);
  await expect(page.locator('.menubar .users .avatar.agent')).toHaveCount(1);
  await expect(page.locator('.menubar .users .avatar.agent')).toHaveAttribute('title', /Codex \(Admin\) — an agent connected from elsewhere/);
  // pointing at a passage selects it for everybody to see
  await call(client, 'highlight', { project: PROJECT, path: 'main.tex', quote: 'has a typo in it' });
  await expect(page.locator('.ProseMirror-yjs-selection')).toContainText('has a typo in it', { timeout: 10000 });
  // the agent's place, as other agents and itself see it
  const r = await call(client, 'get_presence', { project: PROJECT, path: 'main.tex' });
  expect(r.documents[0].people.find((p: any) => p.self)).toMatchObject({ kind: 'agent', name: 'Codex (Admin)', selection: { text: 'has a typo in it' } });
});

test('a message from the Agent panel reaches the agent with the selection; its reply shows in the panel', async ({ page }) => {
  await login(page);
  await openDoc(page, DOC);
  const { client } = await connect('codex-mcp-client');
  await openAgentPanel(page);
  await page.locator('[data-agent-tab]', { hasText: 'Codex' }).first().click();
  const view = page.locator('[data-ext-agent]');
  await expect(view).toBeVisible();
  await selectText(page, 'a typo');
  const waiting = call(client, 'wait_for_instructions', { timeout_seconds: 45 });
  await expect(page.locator('[data-ext-status]')).toContainText('Listening', { timeout: 10000 });
  await page.locator('[data-ext-input]').fill('Please fix the typo here');
  await page.keyboard.press('Enter');
  const got = await waiting;
  expect(got.messages).toHaveLength(1);
  const msg = got.messages[0];
  expect(msg.text).toBe('Please fix the typo here');
  expect(msg.from).toMatch(/^Admin \(the owner of your token\)/);
  expect(msg.context).toContain(DOC);
  expect(msg.context).toContain('⟦SELECTION⟧a typo⟦/SELECTION⟧');
  const bubble = view.locator(`[data-ext-msg="${msg.message_id}"]`);
  await expect(bubble).toContainText('The agent has it');
  await expect(bubble).toContainText('your selection');
  await call(client, 'reply', { message_id: msg.message_id, text: 'Fixed **it**: the typo is gone, and $x^2$ renders.' });
  const reply = view.locator('.ext-reply').last();
  await expect(reply).toContainText('Fixed it: the typo is gone', { timeout: 10000 });
  await expect(reply.locator('.agent-math')).toHaveCount(1);
  await expect(bubble).toContainText('Answered');
});

test('"Ask agent about this" pins the selection for the next message, even after the selection moved on', async ({ page }) => {
  await login(page);
  await openDoc(page, DOC);
  const { client } = await connect('codex-mcp-client');
  await selectText(page, 'quick brown fox');
  const box = await page.evaluate(() => { const r = window.getSelection()!.getRangeAt(0).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await page.mouse.click(box.x, box.y, { button: 'right' });
  await page.locator('.ctx-menu .ctx-item', { hasText: 'Ask agent about this' }).click();
  await expect(page.locator('.agent-wrap')).toBeVisible();
  await page.locator('[data-agent-tab]', { hasText: 'Codex' }).first().click();
  await expect(page.locator('[data-ext-pin]')).toContainText('the selected passage');
  await selectText(page, 'sets the scene');   // the selection moves on; the pinned passage is what goes along
  const waiting = call(client, 'wait_for_instructions', { timeout_seconds: 45 });
  await page.locator('[data-ext-input]').fill('What is this about?');
  await page.keyboard.press('Enter');
  const got = await waiting;
  expect(got.messages[0].text).toBe('What is this about?');
  expect(got.messages[0].context).toContain('⟦SELECTION⟧quick brown fox⟦/SELECTION⟧');
  await expect(page.locator('[data-ext-pin]')).toHaveCount(0);   // used up
  await call(client, 'reply', { message_id: got.messages[0].message_id, text: 'A fox and a dog.' });
});

test('Claude Code gets the message pushed into its session (channels)', async ({ page }) => {
  await login(page);
  await openDoc(page, DOC);
  const { client, pushed } = await connect('claude-code');
  await openAgentPanel(page);
  await page.locator('[data-agent-tab]', { hasText: 'Claude Code' }).click();
  const view = page.locator('[data-ext-agent]');
  // not confirmed yet: the panel says how to make it listen, with Claude Code's channels flag
  await expect(view.locator('[data-ext-hint]')).toContainText('--dangerously-load-development-channels server:overlyx');
  await page.locator('[data-ext-input]').fill('Hello from the panel');
  await page.keyboard.press('Enter');
  await expect.poll(() => pushed.length, { timeout: 15000 }).toBe(1);
  expect(pushed[0].content).toMatch(/^Hello from the panel/);
  const id = Number(pushed[0].meta.message_id);
  await expect(view.locator(`[data-ext-msg="${id}"]`)).toContainText('Sent to its session');
  await call(client, 'reply', { message_id: id, text: 'Got it through the channel.' });
  await expect(view.locator('.ext-reply').last()).toContainText('Got it through the channel.', { timeout: 10000 });
  await expect(view.locator(`[data-ext-msg="${id}"]`)).toContainText('Answered');
  // its channel delivered: listening from now on, the hint is gone
  await expect(page.locator('[data-ext-status]')).toContainText('Listening', { timeout: 10000 });
  await expect(view.locator('[data-ext-hint]')).toHaveCount(0);
});

test("a collaborator sees none of the admin's agents and cannot write to them", async ({ browser }) => {
  const admin = await browser.newContext();
  await apiLogin(admin);
  const agents = (await (await admin.request.get(BASE_URL + '/api/mcp-agents')).json()).agents as { id: number; name: string }[];
  expect(agents.map(a => a.name)).toEqual(expect.arrayContaining(['Codex', 'Claude Code']));
  await admin.close();
  const bob = await browser.newContext();
  await apiLogin(bob, userCredentials('bob'));
  expect((await (await bob.request.get(BASE_URL + '/api/mcp-agents')).json()).agents).toEqual([]);
  for (const a of agents) {
    expect((await bob.request.post(`${BASE_URL}/api/mcp-agents/${a.id}/messages`, { data: { text: 'run something' } })).status()).toBe(404);
    expect((await bob.request.get(`${BASE_URL}/api/mcp-agents/${a.id}/messages`)).status()).toBe(404);
  }
  await bob.close();
});
