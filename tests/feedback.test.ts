/**
 * Feedback and error reports stay on the server (packages/server/src/feedback.ts): a report is one
 * row with the reporter's account and the version, mailed to the owner; an error is one row per
 * distinct message whose repeats count up; the routes enforce auth and limits; nothing is sent to
 * GitHub; error rows expire, a deleted account's reports go.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import express from 'express';

const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-feedback-test');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'data'), { recursive: true });
mkdirSync(join(ROOT, 'projects'), { recursive: true });
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');
process.env.OVERLYX_SMTP_URL = 'json';
process.env.OVERLYX_OWNER_EMAIL = 'owner@example.com';
// a GitHub token from an older configuration must not lead anywhere
process.env.GITHUB_TOKEN = 'must-not-be-used';
process.env.GITHUB_API_URL = 'http://127.0.0.1:9';

const fb = await import('../packages/server/src/feedback.ts');
const { db } = await import('../packages/server/src/db.ts');
const { sentMails } = await import('../packages/server/src/mailer.ts');
const { createUser, toSessionUser, authMiddleware } = await import('../packages/server/src/auth.ts');

const realFetch = globalThis.fetch;
const outbound: string[] = [];
globalThis.fetch = ((url: any, init?: any) => { const u = String(url); if (!u.startsWith('http://127.0.0.1:') || u.startsWith('http://127.0.0.1:9/')) outbound.push(u); return realFetch(url, init); }) as typeof fetch;
afterAll(() => { globalThis.fetch = realFetch; rmSync(ROOT, { recursive: true, force: true }); });

const row = (id: number) => db.prepare('SELECT * FROM reports WHERE id = ?').get(id) as any;
const ada = toSessionUser(createUser('ada', 'Ada Lovelace', null, { email: 'ada@example.com' }));

describe('feedback and error reports, kept on the server', () => {
  it('a report is one row with the account, the version and the opt-in details, mailed to the owner', async () => {
    const r = fb.submitFeedback({ kind: 'bug', title: 'Formula vanished', body: 'I typed `\\alpha` and it disappeared.', doc: 'paper/main.lyx', error: 'TypeError: x is undefined', userAgent: 'TestBrowser/1' }, { id: ada.id, name: 'Ada Lovelace', username: 'ada', email: 'ada@example.com' });
    const x = row(r.id);
    expect(x.kind).toBe('feedback');
    expect(x.title).toBe('Formula vanished');
    expect(x.user_id).toBe(ada.id);
    expect(x.user_agent).toBe('TestBrowser/1');
    expect(x.body).toContain('Bug · OverLyX');
    expect(x.body).toContain('Document: paper/main.lyx');
    expect(x.body).toContain('I typed `\\alpha` and it disappeared.');
    expect(x.body).toContain('TypeError: x is undefined');
    expect(x.body).not.toContain('Ada');   // who sent it is the row's account, not text
    // the mail goes out asynchronously: poll for it (a fixed 20 ms wait failed under the deploy's load)
    const mail = await vi.waitFor(() => sentMails.find(m => m.subject.includes(`#${r.id}`)) ?? Promise.reject(new Error('not mailed yet')), { timeout: 5000, interval: 20 });
    expect(mail.to).toBe('owner@example.com');
    // that a report came, never what it says or who sent it (mailer.ts: the report stays on the server)
    for (const told of [mail.subject, mail.text]) for (const secret of ['Formula vanished', 'alpha', 'Ada', 'ada@example.com']) expect(told).not.toContain(secret);
  });

  it('leaves the document name and the error out unless they were given', () => {
    const r = fb.submitFeedback({ kind: 'idea', title: '', body: 'Dark mode please', doc: null }, { id: ada.id, name: 'Ada', username: 'ada' });
    const x = row(r.id);
    expect(x.title).toBe('Idea (no title)');
    expect(x.body).not.toContain('Document:');
    expect(x.body).not.toContain('Last error');
  });

  it('an error is one row per distinct message; repeats count up', () => {
    const before = (db.prepare('SELECT COUNT(*) AS n FROM reports').get() as { n: number }).n;
    const a = fb.reportError({ kind: 'client-error', message: 'Cannot read properties of undefined (reading "pos") at line 42', stack: 'at foo (app.js:42)', userAgent: 'UA', who: { id: ada.id, name: 'Ada', username: 'ada' } })!;
    expect(row(a).title).toBe('[client-error] Cannot read properties of undefined (reading "pos") at line 42');
    expect(row(a).user_id).toBe(ada.id);
    expect(row(a).body).toContain('at foo (app.js:42)');
    // same error, different numbers → same row, counted
    expect(fb.reportError({ kind: 'client-error', message: 'Cannot read properties of undefined (reading "pos") at line 57' })).toBe(a);
    expect(row(a).count).toBe(2);
    // a different message → a new row; a server error with the same text → its own row (kind is part of the key)
    const b = fb.reportError({ kind: 'client-error', message: 'Something else entirely' })!;
    const c = fb.reportError({ kind: 'server-error', message: 'Something else entirely' })!;
    expect(new Set([a, b, c]).size).toBe(3);
    expect(row(c).kind).toBe('server-error');
    expect((db.prepare('SELECT COUNT(*) AS n FROM reports').get() as { n: number }).n).toBe(before + 3);
  });

  it('errorHash ignores numbers, hex ids and quoted names', () => {
    expect(fb.errorHash('client-error', 'Node 12 not found in "figure 3"')).toBe(fb.errorHash('client-error', 'Node 99 not found in "table"'));
    expect(fb.errorHash('client-error', 'a')).not.toBe(fb.errorHash('server-error', 'a'));
  });

  it('the routes need a session, rate-limit a person, and answer with the report number', async () => {
    const user = createUser('carol', 'Carol', 'pw-not-needed-here');
    const app = express();
    app.use(authMiddleware);
    // pretend the session cookie was valid for carol
    app.use((req, _res, next) => { req.user = toSessionUser(user); next(); });
    app.use(express.json());
    app.use(fb.feedbackRoutes());
    const srv = http.createServer(app);
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    try {
      const info = await (await fetch(`${base}/feedback/info`)).json();
      expect(info).toEqual({ version: expect.any(String), errorReports: true });
      const empty = await fetch(`${base}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(empty.status).toBe(400);
      for (let i = 0; i < 10; i++) {
        const r = await fetch(`${base}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'UA/2' }, body: JSON.stringify({ kind: 'question', title: `Q${i}`, body: 'why?' }) });
        expect(r.status).toBe(200);
        const { id } = await r.json();
        expect(row(id).user_id).toBe(user.id);
        expect(row(id).user_agent).toBe('UA/2');
      }
      const tooMany = await fetch(`${base}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'question', title: 'Q11', body: 'why?' }) });
      expect(tooMany.status).toBe(429);
      const ce = await fetch(`${base}/client-error`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'boom in the browser', stack: 'at x' }) });
      const { id } = await ce.json();
      expect(row(id).kind).toBe('client-error');
      expect(row(id).user_id).toBe(user.id);
      // a display glitch: measurements only, one row per kind, the first repeats' measurements added, not mailed
      const glitch = (scrollY: number) => fetch(`${base}/client-glitch`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'shift', fields: { scroller: 'window', keyboard: 'down', focus: 'math', scrollY, note: 'free text' }, trail: ['50 keyboard down'] }) });
      const g = (await (await glitch(312)).json()).id;
      expect(row(g)).toMatchObject({ kind: 'client-glitch', user_id: user.id });
      expect(row(g).body).toContain('scrollY: 312');
      expect(row(g).body).not.toContain('free text');
      expect((await (await glitch(140)).json()).id).toBe(g);
      expect(row(g)).toMatchObject({ count: 2 });
      expect(row(g).body).toMatch(/--- Again, .*\nscroller: window\n[^]*scrollY: 140/);
      await new Promise(r => setTimeout(r, 50));
      expect(JSON.stringify(sentMails)).not.toContain('client-glitch');
      expect((await fetch(`${base}/client-glitch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'anything', fields: {} }) })).status).toBe(400);
    } finally { srv.close(); }
  });

  it('accepts sanitized VS Code errors without an app session', async () => {
    const app = express();
    app.use(fb.vscodeTelemetryRoutes());
    const srv = http.createServer(app);
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    try {
      const r = await fetch(`${base}/vscode-telemetry`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'overlyx-vscode/0.2.9' },
        body: JSON.stringify({
          schema: 1, event: 'error', area: 'editor.open', errorName: 'TypeError',
          message: 'Cannot read properties of undefined', stack: 'at open (extension.cjs:42:1)',
          extensionVersion: '0.2.9', vscodeVersion: '1.136.1', platform: 'linux', arch: 'x64',
          remote: 'remote', uiKind: 'desktop', ignored: 'must not reach the report',
        }),
      });
      expect(r.status).toBe(200);
      const x = row((await r.json()).id);
      expect(x.kind).toBe('vscode-error');
      expect(x.user_id).toBeNull();
      expect(x.body).toContain('Area: editor.open');
      expect(x.body).toContain('Extension: 0.2.9');
      expect(x.body).toContain('Extension host: remote');
      expect(x.body).not.toContain('must not reach');

      const bad = await fetch(`${base}/vscode-telemetry`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schema: 99, message: 'nope' }),
      });
      expect(bad.status).toBe(400);
    } finally { srv.close(); }
  });

  it('error rows expire after 90 days unseen; a deleted account keeps no reports', () => {
    const old = fb.reportError({ kind: 'server-error', message: 'an old one' })!;
    db.prepare('UPDATE reports SET last_at = ? WHERE id = ?').run(Date.now() - 91 * 24 * 60 * 60 * 1000, old);
    const mine = fb.submitFeedback({ kind: 'bug', title: 'mine', body: 'x' }, { id: ada.id, name: 'Ada', username: 'ada' }).id;
    db.prepare('UPDATE reports SET last_at = ? WHERE id = ?').run(Date.now() - 400 * 24 * 60 * 60 * 1000, mine);
    expect(fb.pruneReports()).toBe(1);
    expect(row(old)).toBeUndefined();
    expect(row(mine)).toBeDefined();   // what a person wrote stays until their account goes
    const err = fb.reportError({ kind: 'client-error', message: 'ada hit this', who: { id: ada.id, name: 'Ada', username: 'ada' } })!;
    fb.forgetUserReports(ada.id);
    expect(row(mine)).toBeUndefined();
    expect(row(err).user_id).toBeNull();
    expect((db.prepare('SELECT COUNT(*) AS n FROM reports WHERE user_id = ?').get(ada.id) as { n: number }).n).toBe(0);
  });

  it('never talks to GitHub', () => {
    expect(outbound).toEqual([]);
  });
});
