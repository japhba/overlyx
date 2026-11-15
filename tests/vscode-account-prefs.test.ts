/**
 * The account's settings in the VS Code editors (vscode host/accountprefs.ts): the bridge says whose
 * settings to follow, passes /api/prefs to the server's git API with the sign-in, and says so when it
 * is switched off or signed in nowhere.
 */
import { describe, it, expect, afterAll } from 'vitest';
import http from 'node:http';
import { accountPrefsService } from '../packages/vscode/src/host/accountprefs.ts';

const asked: string[] = [];
const server = http.createServer((req, res) => {
  asked.push(`${req.method} ${req.url}`);
  if (req.headers.authorization !== 'Basic dGVzdA==') { res.statusCode = 401; res.end('Invalid username or token/password\n'); return; }
  res.setHeader('content-type', 'application/json');
  if (req.method === 'PUT') { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { res.end(JSON.stringify({ prefs: JSON.parse(b).set })); }); return; }
  res.end(JSON.stringify({ prefs: { 'pref.editorFont': { value: 'gf:Lora', at: 1 } } }));
});
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
afterAll(() => server.close());
const host = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

let enabled = true, signedIn = true, signIns = 0;
const prefs = accountPrefsService({
  enabled: () => enabled,
  signIn: async () => { signIns++; signedIn = true; },
  who: async () => (signedIn ? { host, username: 'ada', authorization: 'Basic dGVzdA==' } : null),
});
const body = async (p: Promise<{ status: number; body: string }>) => { const r = await p; return { status: r.status, v: JSON.parse(r.body) }; };

describe('the bridge\'s account settings', () => {
  it('names the account and passes reads and changes on', async () => {
    expect((await body(prefs('GET', 'account'))).v).toEqual({ enabled: true, account: { host, username: 'ada' } });
    expect((await body(prefs('GET', ''))).v.prefs['pref.editorFont'].value).toBe('gf:Lora');
    const put = await body(prefs('PUT', '', { set: { 'pref.spellcheck': { value: false, at: 2 } } }));
    expect(put.v.prefs['pref.spellcheck'].value).toBe(false);
    expect(asked).toEqual(['GET /git/api/prefs', 'PUT /git/api/prefs']);
  });
  it('signed in nowhere: no account, 401 — and Sign in brings one', async () => {
    signedIn = false;
    expect((await body(prefs('GET', 'account'))).v.account).toBeNull();
    expect((await body(prefs('GET', ''))).status).toBe(401);
    expect((await body(prefs('POST', 'signin'))).v.account).toEqual({ host, username: 'ada' });
    expect(signIns).toBe(1);
  });
  it('switched off: the editors keep their own', async () => {
    enabled = false;
    expect((await body(prefs('GET', 'account'))).v).toEqual({ enabled: false, account: null });
    expect((await body(prefs('GET', ''))).status).toBe(403);
    enabled = true;
  });
});
