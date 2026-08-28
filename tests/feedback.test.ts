/**
 * Feedback → GitHub issues (packages/server/src/feedback.ts) against a stub of the GitHub API:
 * a report becomes one issue with the reporter and version; an error becomes one issue per
 * distinct message with repeats as comments (rate limited); the routes enforce auth and limits;
 * without a token the client gets a pre-filled issue URL instead.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

// --- a GitHub API stub: records issues and comments, checks the token
const issues: any[] = [], comments: any[] = [], labels: string[] = [];
const stub = express();
stub.use(express.json());
stub.use((req, res, next) => { if (req.headers.authorization !== 'Bearer test-token') { res.status(401).json({ message: 'Bad credentials' }); return; } next(); });
stub.post('/repos/:o/:r/labels', (req, res) => { if (labels.includes(req.body.name)) { res.status(422).json({ message: 'Validation Failed' }); return; } labels.push(req.body.name); res.status(201).json(req.body); });
stub.post('/repos/:o/:r/issues', (req, res) => { const n = issues.length + 1; issues.push({ number: n, ...req.body }); res.status(201).json({ number: n, html_url: `https://github.com/${req.params.o}/${req.params.r}/issues/${n}` }); });
stub.post('/repos/:o/:r/issues/:n/comments', (req, res) => { comments.push({ issue: Number(req.params.n), ...req.body }); res.status(201).json({ id: comments.length }); });
const stubServer = http.createServer(stub);
await new Promise<void>(r => stubServer.listen(0, '127.0.0.1', r));
const port = (stubServer.address() as { port: number }).port;
process.env.GITHUB_API_URL = `http://127.0.0.1:${port}`;
process.env.GITHUB_TOKEN = 'test-token';
process.env.GITHUB_REPO = 'acme/overlyx';

const fb = await import('../packages/server/src/feedback.ts');
const { createUser, toSessionUser, authMiddleware } = await import('../packages/server/src/auth.ts');

afterAll(() => { stubServer.close(); rmSync(ROOT, { recursive: true, force: true }); });

describe('feedback → GitHub issues', () => {
  it('a report becomes one issue with the reporter, the version and the opt-in details', async () => {
    const r = await fb.submitFeedback({ kind: 'bug', title: 'Formula vanished', body: 'I typed `\\alpha` and it disappeared.', doc: 'paper/main.lyx', error: 'TypeError: x is undefined', userAgent: 'TestBrowser/1' }, { name: 'Ada Lovelace', username: 'ada' });
    expect(r).toEqual({ number: 1, url: 'https://github.com/acme/overlyx/issues/1' });
    const i = issues[0];
    expect(i.title).toBe('Formula vanished');
    expect(i.labels).toEqual(['feedback']);
    expect(i.body).toContain('**Bug** reported by Ada Lovelace (`ada`)');
    expect(i.body).toContain('**Document:** `paper/main.lyx`');
    expect(i.body).toContain('**Browser:** TestBrowser/1');
    expect(i.body).toContain('I typed `\\alpha` and it disappeared.');
    expect(i.body).toContain('TypeError: x is undefined');
    expect(labels).toEqual(['feedback', 'client-error', 'server-error']);
  });

  it('leaves the document name out unless it was given', async () => {
    await fb.submitFeedback({ kind: 'idea', title: '', body: 'Dark mode please', doc: null }, { name: 'Bob', username: 'bob' });
    const i = issues[1];
    expect(i.title).toBe('Idea from Bob');
    expect(i.body).not.toContain('Document:');
    expect(i.body).not.toContain('Last error');
  });

  it('an error is one issue per distinct message; repeats bump the count and comment at most every 10 minutes', async () => {
    const before = issues.length;
    const u1 = await fb.reportError({ kind: 'client-error', message: 'Cannot read properties of undefined (reading "pos") at line 42', stack: 'at foo (app.js:42)', userAgent: 'UA', who: { name: 'Ada', username: 'ada' } });
    expect(u1).toMatch(/issues\/\d+$/);
    expect(issues.length).toBe(before + 1);
    expect(issues[before].title).toBe('[client-error] Cannot read properties of undefined (reading "pos") at line 42');
    expect(issues[before].labels).toEqual(['client-error']);
    // same error, different numbers → same issue, no immediate comment
    const u2 = await fb.reportError({ kind: 'client-error', message: 'Cannot read properties of undefined (reading "pos") at line 57' });
    expect(u2).toBe(u1);
    expect(issues.length).toBe(before + 1);
    expect(comments.length).toBe(0);
    // a different message → a new issue; a server error with the same text → its own issue (kind is part of the key)
    await fb.reportError({ kind: 'client-error', message: 'Something else entirely' });
    await fb.reportError({ kind: 'server-error', message: 'Something else entirely' });
    expect(issues.length).toBe(before + 3);
    expect(issues[before + 2].labels).toEqual(['server-error']);
  });

  it('errorHash ignores numbers, hex ids and quoted names', () => {
    expect(fb.errorHash('client-error', 'Node 12 not found in "figure 3"')).toBe(fb.errorHash('client-error', 'Node 99 not found in "table"'));
    expect(fb.errorHash('client-error', 'a')).not.toBe(fb.errorHash('server-error', 'a'));
  });

  it('the routes need a session, rate-limit a person, and report the issue URL', async () => {
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
      expect(info.enabled).toBe(true);
      expect(info.repo).toBe('acme/overlyx');
      expect(info.newIssueUrl).toContain('https://github.com/acme/overlyx/issues/new');
      const empty = await fetch(`${base}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(empty.status).toBe(400);
      const before = issues.length;
      for (let i = 0; i < 10; i++) {
        const r = await fetch(`${base}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'UA/2' }, body: JSON.stringify({ kind: 'question', title: `Q${i}`, body: 'why?' }) });
        expect(r.status).toBe(200);
        expect((await r.json()).url).toMatch(/issues\/\d+$/);
      }
      expect(issues.length).toBe(before + 10);
      expect(issues[before].body).toContain('(`carol`)');
      expect(issues[before].body).toContain('UA/2');
      const tooMany = await fetch(`${base}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'question', title: 'Q11', body: 'why?' }) });
      expect(tooMany.status).toBe(429);
      const ce = await fetch(`${base}/client-error`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'boom in the browser', stack: 'at x' }) });
      expect((await ce.json()).url).toMatch(/issues\/\d+$/);
    } finally { srv.close(); }
  });

  it('without a token the client is handed a pre-filled new-issue URL', async () => {
    const token = fb.github.token;
    fb.github.token = '';
    try {
      expect(fb.feedbackEnabled()).toBe(false);
      const app = express();
      app.use((req, _res, next) => { req.user = { id: 1, username: 'x', name: 'X', color: '#000', isAdmin: false } as any; next(); });
      app.use(express.json());
      app.use(fb.feedbackRoutes());
      const srv = http.createServer(app);
      await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
      const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
      try {
        const r = await fetch(`${base}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'bug', title: 'T', body: 'B' }) });
        expect(r.status).toBe(503);
        const j = await r.json();
        expect(j.fallback).toContain('https://github.com/acme/overlyx/issues/new?title=T&body=');
        expect(new URL(j.fallback).searchParams.get('body')).toContain('**Bug** reported by X (`x`)');
        const ce = await fetch(`${base}/client-error`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'ignored' }) });
        expect(ce.status).toBe(204);
        expect(await fb.reportError({ kind: 'server-error', message: 'ignored too' })).toBeNull();
      } finally { srv.close(); }
    } finally { fb.github.token = token; }
  });
});
