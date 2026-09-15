/** Self-contained OAuth browser tests: isolated accounts/database, no external requests. */
import { test, expect } from '@playwright/test';
import { fork, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let root: string, base: string, session: string, server: ChildProcess;
const redirect = 'https://chatgpt.com/connector_platform_oauth_redirect';

test.use({ browserName: 'chromium', javaScriptEnabled: false });
test.beforeAll(async () => {
  root = mkdtempSync(join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-oauth-browser-'));
  server = fork(new URL('./fixtures/mcpoauth-server.ts', import.meta.url), [], {
    execArgv: ['--import', 'tsx'],
    env: { ...process.env, OVERLYX_DATA_DIR: join(root, 'data'), OVERLYX_PROJECTS_DIR: join(root, 'projects'), OVERLYX_PUBLIC_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let log = '';
  server.stdout!.on('data', chunk => { log += chunk; });
  server.stderr!.on('data', chunk => { log += chunk; });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.once('exit', code => reject(new Error(`OAuth fixture exited (${code}): ${log}`)));
    server.once('message', (message: { base: string; session: string }) => {
      ({ base, session } = message); resolve();
    });
  });
});
test.afterAll(async () => {
  if (server && server.exitCode === null && server.signalCode === null) {
    const stopped = once(server, 'exit');
    server.kill('SIGTERM');
    await stopped;
  }
  if (root) rmSync(root, { recursive: true, force: true });
});

for (const flow of [
  { name: 'Allow with a registered ChatGPT client', redirect, decision: 'Allow' },
  { name: 'Allow with ChatGPT CIMD', redirect, decision: 'Allow', client: 'https://chatgpt.com/oauth/client.json' },
  { name: 'Allow with a callback-specific ChatGPT client', redirect: 'https://chatgpt.com/connector/oauth/test-callback', decision: 'Allow', client: 'https://chatgpt.com/oauth/test-callback/client.json' },
  { name: 'Allow with another registered MCP client', redirect: 'https://mcp-client.example/callback', decision: 'Allow' },
  { name: 'Deny returns to ChatGPT without a code', redirect, decision: 'Deny' },
]) {
  test(flow.name, async ({ page, context }) => {
    await context.addCookies([{ name: 'ol_session', value: session, url: base, httpOnly: true, sameSite: 'Lax' }]);
    const callbackOrigin = new URL(flow.redirect).origin;
    // Playwright's route handler skips redirected requests. Intercept the callback through
    // CDP so the browser enforces CSP on the real 302 without contacting an external host.
    const cdp = await context.newCDPSession(page);
    cdp.on('Fetch.requestPaused', async ({ requestId }) => {
      await cdp.send('Fetch.fulfillRequest', {
        requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html' }],
        body: Buffer.from('<p>OAuth callback received</p>').toString('base64'),
      });
    });
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: `${callbackOrigin}/*`, requestStage: 'Request' }] });
    let clientId = flow.client;
    if (!clientId) {
      const registered = await page.request.post(`${base}/oauth/register`, { data: { client_name: 'Browser client', redirect_uris: [flow.redirect] } });
      expect(registered.status()).toBe(201);
      clientId = (await registered.json()).client_id;
    }
    const verifier = crypto.randomBytes(32).toString('base64url');
    const query = new URLSearchParams({
      client_id: clientId!, redirect_uri: flow.redirect, response_type: 'code', state: 'state&with=reserved#chars',
      code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', scope: 'mcp',
    });
    const violations: string[] = [];
    page.on('console', message => { if (/form-action/.test(message.text())) violations.push(message.text()); });
    const consent = await page.goto(`${base}/oauth/authorize?${query}`);
    expect(consent!.status()).toBe(200);
    await page.getByRole('button', { name: flow.decision, exact: true }).click();
    await expect(page, violations.join('\n')).toHaveURL(url => url.origin + url.pathname === flow.redirect, { timeout: 5000 });
    await expect(page.getByText('OAuth callback received', { exact: true })).toBeVisible();
    expect(violations).toEqual([]);
    const callback = new URL(page.url());
    expect(callback.searchParams.get('state')).toBe(query.get('state'));
    expect(callback.searchParams.get('iss')).toBe(base);
    if (flow.decision === 'Deny') {
      expect(callback.searchParams.get('error')).toBe('access_denied');
      expect(callback.searchParams.has('code')).toBe(false);
      return;
    }
    expect(callback.searchParams.get('code')).toMatch(/^olxac_/);
    const token = await page.request.post(`${base}/oauth/token`, { form: {
      grant_type: 'authorization_code', client_id: clientId!, redirect_uri: flow.redirect,
      code: callback.searchParams.get('code')!, code_verifier: verifier,
    } });
    expect(token.status()).toBe(200);
    expect(await token.json()).toMatchObject({ access_token: expect.stringMatching(/^olxmcp_/), refresh_token: expect.stringMatching(/^olxrt_/) });
  });
}
