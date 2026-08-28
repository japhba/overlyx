/**
 * Feedback and error reports go straight to GitHub issues of the project's repository
 * (`GITHUB_REPO`, default japhba/overlyx) using `GITHUB_TOKEN` — a fine-grained token with
 * "Issues: read and write" on that repository is enough. Without a token the client is handed the
 * URL of a pre-filled "new issue" form instead.
 *
 *   POST /api/feedback       a person's report (bug / idea / question) → one issue, label `feedback`
 *   POST /api/client-error   an error that escaped in the browser → issue per distinct message
 *                            (label `client-error`); repeats become a comment, at most one per
 *                            10 minutes per message, so a broken deploy cannot flood the tracker.
 *   server errors            reportServerError() from the process-level handlers, same dedupe
 *                            (label `server-error`)
 *
 * What leaves the server: the reporter's display name and user name, the app version, the browser's
 * user agent, the message / stack trace, and — only when the person ticked it — the document name.
 * Never document content. The repository may be public: the client says so before sending.
 */
import express from 'express';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { db } from './db.ts';
import { config, REPO_ROOT } from './config.ts';

db.exec(`CREATE TABLE IF NOT EXISTS error_reports (
  hash TEXT PRIMARY KEY,
  issue INTEGER NOT NULL,
  issue_url TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  last_comment_at INTEGER NOT NULL
)`);

export const github = config.github;
export const feedbackEnabled = (): boolean => !!(github.token && github.repo);
export const newIssueUrl = (title = '', body = ''): string =>
  `https://github.com/${github.repo}/issues/new?${new URLSearchParams({ title, body }).toString()}`;

/** short git commit of the running code (read once, asynchronously) */
export let appVersion = 'unknown';
execFile('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT, timeout: 5000 }, (err, out) => { if (!err && out.trim()) appVersion = out.trim(); });

async function gh(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${github.api}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${github.token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json',
      'user-agent': 'overlyx-feedback', 'x-github-api-version': '2022-11-28',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GitHub ${method} ${path}: ${res.status} ${data?.message ?? ''}`.trim());
  return data;
}

const LABELS: Record<string, { color: string; description: string }> = {
  feedback: { color: '0e8a16', description: 'Sent from the app (Help ▸ Report a problem)' },
  'client-error': { color: 'd73a4a', description: 'Uncaught error in the browser, reported automatically' },
  'server-error': { color: 'b60205', description: 'Uncaught error on the server, reported automatically' },
};
let labelsReady: Promise<void> | null = null;
/** create the labels we use (once per process; a label that exists answers 422, which is fine) */
function ensureLabels(): Promise<void> {
  if (!labelsReady) labelsReady = (async () => {
    for (const [name, l] of Object.entries(LABELS)) {
      try { await gh('POST', `/repos/${github.repo}/labels`, { name, ...l }); }
      catch (e) { if (!/422/.test(String(e))) console.warn('[feedback]', (e as Error).message); }
    }
  })();
  return labelsReady;
}

export interface Reporter { name: string; username: string }
export interface FeedbackInput {
  kind: 'bug' | 'idea' | 'question';
  title: string;
  body: string;
  /** document name, only when the person chose to include it */
  doc?: string | null;
  /** last error message shown in the app, only when the person chose to include it */
  error?: string | null;
  userAgent?: string;
}

const clean = (s: unknown, max: number) => String(s ?? '').replace(/\r/g, '').trim().slice(0, max);
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

export function formatFeedback(f: FeedbackInput, who: Reporter): { title: string; body: string } {
  const KIND: Record<string, string> = { bug: 'Bug', idea: 'Idea', question: 'Question' };
  const head = [
    `**${KIND[f.kind] ?? 'Feedback'}** reported by ${clean(who.name, 80)} (\`${clean(who.username, 40)}\`) · OverLyX \`${appVersion}\` · ${stamp()}`,
    f.doc ? `**Document:** \`${clean(f.doc, 200)}\`` : '',
    f.userAgent ? `**Browser:** ${clean(f.userAgent, 300)}` : '',
  ].filter(Boolean).join('\n');
  const tail = f.error ? `\n\n---\n**Last error shown in the app:**\n\`\`\`\n${clean(f.error, 2000)}\n\`\`\`` : '';
  return { title: clean(f.title, 200) || `${KIND[f.kind] ?? 'Feedback'} from ${clean(who.name, 80)}`, body: `${head}\n\n---\n\n${clean(f.body, 20000)}${tail}` };
}

/** Create one issue for a person's report. */
export async function submitFeedback(f: FeedbackInput, who: Reporter): Promise<{ number: number; url: string }> {
  await ensureLabels();
  const { title, body } = formatFeedback(f, who);
  const issue = await gh('POST', `/repos/${github.repo}/issues`, { title, body, labels: ['feedback'] });
  return { number: issue.number, url: issue.html_url };
}

/** messages differing only in numbers / hex ids / quoted names count as the same error */
export function errorHash(kind: string, message: string): string {
  const norm = message.replace(/0x[0-9a-f]+/gi, '#').replace(/\d+/g, '#').replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '""').toLowerCase().slice(0, 300);
  return crypto.createHash('sha256').update(kind + '\n' + norm).digest('hex').slice(0, 16);
}

const COMMENT_EVERY_MS = 10 * 60 * 1000;
const errRow = db.prepare('SELECT * FROM error_reports WHERE hash = ?');
const errInsert = db.prepare('INSERT INTO error_reports (hash, issue, issue_url, count, first_at, last_at, last_comment_at) VALUES (?, ?, ?, 1, ?, ?, ?)');
const errBump = db.prepare('UPDATE error_reports SET count = count + 1, last_at = ? WHERE hash = ?');
const errCommented = db.prepare('UPDATE error_reports SET last_comment_at = ? WHERE hash = ?');
interface ErrRow { hash: string; issue: number; issue_url: string; count: number; first_at: number; last_at: number; last_comment_at: number }

export interface ErrorInput { kind: 'client-error' | 'server-error'; message: string; stack?: string | null; userAgent?: string; who?: Reporter | null }

/**
 * An error report: a new issue for a message never seen, otherwise a count bump and — not more
 * often than every 10 minutes — a comment on the existing issue. Returns the issue URL (null when
 * reporting is off).
 */
export async function reportError(e: ErrorInput): Promise<string | null> {
  if (!feedbackEnabled() || !config.errorReports) return null;
  const message = clean(e.message, 1000);
  if (!message) return null;
  const hash = errorHash(e.kind, message);
  const now = Date.now();
  const details = [
    `OverLyX \`${appVersion}\` · ${stamp()}${e.who ? ` · ${clean(e.who.name, 80)} (\`${clean(e.who.username, 40)}\`)` : ''}`,
    e.userAgent ? `Browser: ${clean(e.userAgent, 300)}` : '',
    '```', message, e.stack ? clean(e.stack, 4000) : '', '```',
  ].filter(Boolean).join('\n');
  const row = errRow.get(hash) as ErrRow | undefined;
  if (row) {
    errBump.run(now, hash);
    if (now - row.last_comment_at >= COMMENT_EVERY_MS) {
      errCommented.run(now, hash);
      try { await gh('POST', `/repos/${github.repo}/issues/${row.issue}/comments`, { body: `Seen again (${row.count + 1}× so far)\n\n${details}` }); }
      catch (err) { console.warn('[feedback] comment failed:', (err as Error).message); }
    }
    return row.issue_url;
  }
  // first occurrence: claim the hash before the request so that a burst creates one issue only
  errInsert.run(hash, 0, '', now, now, now);
  try {
    await ensureLabels();
    const issue = await gh('POST', `/repos/${github.repo}/issues`, { title: `[${e.kind}] ${message.split('\n')[0].slice(0, 120)}`, body: details, labels: [e.kind] });
    db.prepare('UPDATE error_reports SET issue = ?, issue_url = ? WHERE hash = ?').run(issue.number, issue.html_url, hash);
    return issue.html_url;
  } catch (err) {
    db.prepare('DELETE FROM error_reports WHERE hash = ?').run(hash);
    console.warn('[feedback] issue creation failed:', (err as Error).message);
    return null;
  }
}

/** Server-side errors from the process-level handlers (never throws). */
export function reportServerError(err: unknown): void {
  const e = err instanceof Error ? err : new Error(String(err));
  reportError({ kind: 'server-error', message: e.message, stack: e.stack }).catch(() => {});
}

/** simple per-key rate limit (sliding hour) */
const buckets = new Map<string, number[]>();
export function allow(key: string, max: number, windowMs = 60 * 60 * 1000): boolean {
  const now = Date.now();
  const arr = (buckets.get(key) ?? []).filter(t => now - t < windowMs);
  if (arr.length >= max) { buckets.set(key, arr); return false; }
  arr.push(now); buckets.set(key, arr);
  return true;
}

/** Routes; mounted on the authenticated /api router. */
export function feedbackRoutes(): express.Router {
  const r = express.Router();
  r.get('/feedback/info', (_req, res) => {
    res.json({ enabled: feedbackEnabled(), repo: github.repo, newIssueUrl: newIssueUrl(), version: appVersion, errorReports: feedbackEnabled() && config.errorReports });
  });
  r.post('/feedback', async (req, res) => {
    const u = req.user!;
    const b = req.body ?? {};
    const f: FeedbackInput = {
      kind: ['bug', 'idea', 'question'].includes(b.kind) ? b.kind : 'bug', title: clean(b.title, 200), body: clean(b.body, 20000),
      doc: b.doc ? clean(b.doc, 200) : null, error: b.error ? clean(b.error, 2000) : null, userAgent: req.get('user-agent') ?? '',
    };
    if (!f.title && !f.body) { res.status(400).json({ error: 'Please write something.' }); return; }
    const who = { name: u.name, username: u.username };
    if (!feedbackEnabled()) { const { title, body } = formatFeedback(f, who); res.status(503).json({ error: 'Feedback is not connected to GitHub on this server.', fallback: newIssueUrl(title, body) }); return; }
    if (!allow(`feedback:${u.id}`, 10)) { res.status(429).json({ error: 'That is a lot of feedback for one hour — thank you! Please try again later.' }); return; }
    try { res.json(await submitFeedback(f, who)); }
    catch (e) { const { title, body } = formatFeedback(f, who); res.status(502).json({ error: (e as Error).message, fallback: newIssueUrl(title, body) }); }
  });
  r.post('/client-error', async (req, res) => {
    const u = req.user!;
    const b = req.body ?? {};
    if (!feedbackEnabled() || !config.errorReports) { res.status(204).end(); return; }
    if (!allow('client-error', 60) || !allow(`client-error:${u.id}`, 20)) { res.status(429).json({ error: 'rate limited' }); return; }
    const url = await reportError({ kind: 'client-error', message: clean(b.message, 1000), stack: b.stack ? clean(b.stack, 4000) : null, userAgent: req.get('user-agent') ?? '', who: { name: u.name, username: u.username } });
    res.json({ url });
  });
  return r;
}
