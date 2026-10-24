/**
 * Feedback and error reports stay on this server (the `reports` table) — nothing goes to a public
 * issue tracker. The instance owner is told by e-mail that a person's report arrived (mailer.ts
 * notifyOwner — not its content) so somebody reads it; `npx tsx scripts/reports.ts` lists them.
 *
 *   POST /api/feedback       a person's report (bug / idea / question) → one row, kind `feedback`
 *   POST /api/client-error   an error that escaped in the browser → one row per distinct message
 *                            (kind `client-error`); repeats only count up and refresh `last_at`
 *   POST /api/client-glitch  a display glitch the app noticed on a touch screen (client glitches.ts):
 *                            measurements and fixed words only (core glitch.ts), kind `client-glitch`,
 *                            one row per kind of glitch; the first repeats' measurements are added
 *   POST /api/ink-lab        the pen lab's answers (client PenLab.tsx), sent by the person: the ink
 *                            settings compared and what was chosen, the points of the line they wrote
 *                            there only if ticked — numbers and fixed words only (core inklab.ts inkLabReport), kind
 *                            `ink-lab`, one row a sending; kept a year
 *   POST /api/vscode-telemetry  a sanitized extension error, accepted without a web-app session
 *                            (the extension obeys VS Code's telemetry setting; this route is
 *                            separately rate-limited and accepts only a fixed diagnostic schema)
 *   server errors            reportServerError() from the process-level handlers, same dedupe
 *                            (kind `server-error`)
 *
 * What is kept: the reporter's account id (the name is looked up when the reports are read), the app
 * version, browser, message / stack trace, and — only when the person ticked it — the document name.
 * Never document content. VS Code reports carry a telemetry-sanitized exception and coarse runtime
 * versions/platform, no account. Error rows are forgotten 90 days after they were last seen
 * (pruneReports); a person's reports go with their account (forgetUserReports). The privacy notice
 * (privacy.ts) says the same — keep the two in step.
 */
import express from 'express';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { db } from './db.ts';
import { config, REPO_ROOT } from './config.ts';
import { notifyOwner, READ_IT, sendAnswer } from './mailer.ts';
import { glitchReport } from '@overlyx/core/glitch.ts';
import { inkLabReport } from '@overlyx/core/inklab.ts';

// error_reports held the GitHub issue of each distinct error, from when reports were issues
db.exec(`DROP TABLE IF EXISTS error_reports;
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  hash TEXT UNIQUE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  user_id INTEGER,
  version TEXT NOT NULL,
  user_agent TEXT,
  count INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reports_last ON reports(kind, last_at);`);

// Read synchronously at startup: an asynchronous git call lost to its own timeout while the server's
// modules were still loading (the event loop busy for longer than 5 s), and /api/version said 'unknown'.
const gitHead = (...args: string[]): string => {
  try { return execFileSync('git', ['rev-parse', ...args, 'HEAD'], { cwd: REPO_ROOT, timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
};
/** short git commit of the running code (read once at startup) */
export const appVersion = gitHead('--short') || 'unknown';
/** the full commit hash this server runs (GET /api/version; scripts/autodeploy.sh checks it after a deploy) */
export const appCommit = gitHead() || 'unknown';

export interface Reporter { id: number; name: string; username: string; email?: string | null }
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
const KIND: Record<string, string> = { bug: 'Bug', idea: 'Idea', question: 'Question' };

/** The stored title and body of a person's report (who sent it is the row's user_id, not text). */
export function formatFeedback(f: FeedbackInput): { title: string; body: string } {
  const head = [
    `${KIND[f.kind] ?? 'Feedback'} · OverLyX ${appVersion} · ${stamp()}`,
    f.doc ? `Document: ${clean(f.doc, 200)}` : '',
  ].filter(Boolean).join('\n');
  const tail = f.error ? `\n\n--- Last error shown in the app:\n${clean(f.error, 2000)}` : '';
  return { title: clean(f.title, 200) || `${KIND[f.kind] ?? 'Feedback'} (no title)`, body: `${head}\n\n${clean(f.body, 20000)}${tail}` };
}

const insertReport = db.prepare(`INSERT INTO reports (kind, hash, title, body, user_id, version, user_agent, count, created_at, last_at)
  VALUES (@kind, @hash, @title, @body, @user_id, @version, @user_agent, 1, @now, @now)`);

/** Keep one person's report and mail it to the owner. Returns the report's number. */
export function submitFeedback(f: FeedbackInput, who: Reporter): { id: number } {
  const { title, body } = formatFeedback(f);
  const id = Number(insertReport.run({ kind: 'feedback', hash: null, title, body, user_id: who.id, version: appVersion, user_agent: f.userAgent ? clean(f.userAgent, 300) : null, now: Date.now() }).lastInsertRowid);
  console.log(`[feedback] report #${id} (${f.kind}) from ${who.username}`);
  // that a report came, not what it says or who sent it: the report stays on this server
  void notifyOwner(`OverLyX: a new problem report (${KIND[f.kind]?.toLowerCase() ?? 'feedback'}, #${id})`,
    `Someone sent a report with Help ▸ Report a problem. ${READ_IT}\n`);
  return { id };
}

/** messages differing only in numbers / hex ids / quoted names count as the same error */
export function errorHash(kind: string, message: string): string {
  const norm = message.replace(/0x[0-9a-f]+/gi, '#').replace(/\d+/g, '#').replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '""').toLowerCase().slice(0, 300);
  return crypto.createHash('sha256').update(kind + '\n' + norm).digest('hex').slice(0, 16);
}

const errRow = db.prepare('SELECT id, count FROM reports WHERE hash = ?');
const errBump = db.prepare('UPDATE reports SET count = count + 1, last_at = ? WHERE id = ?');
const errAgain = db.prepare("UPDATE reports SET count = count + 1, last_at = ?, body = body || ? WHERE id = ?");

export interface ErrorInput {
  kind: 'client-error' | 'server-error' | 'vscode-error' | 'client-glitch';
  message: string;
  stack?: string | null;
  userAgent?: string;
  who?: Reporter | null;
  /** Server-selected, non-identifying environment fields. */
  details?: Record<string, string>;
  /** the details and stack of this many repeats are added to the report (each can differ) */
  keepRepeats?: number;
}

/**
 * An error report: a new row for a message never seen, otherwise a count bump. A new distinct
 * error is mailed to the owner (at most 10 such mails a day). Returns the report's number (null
 * when reporting is off).
 */
export function reportError(e: ErrorInput): number | null {
  if (!config.errorReports) return null;
  const message = clean(e.message, 1000);
  if (!message) return null;
  const hash = errorHash(e.kind, message);
  const now = Date.now();
  const row = errRow.get(hash) as { id: number; count: number } | undefined;
  const lines = (withMessage: boolean) => [
    ...Object.entries(e.details ?? {}).map(([key, value]) => `${clean(key, 40)}: ${clean(value, 300)}`),
    withMessage ? message : '', e.stack ? clean(e.stack, 4000) : '',
  ].filter(Boolean).join('\n');
  if (row && row.count <= (e.keepRepeats ?? 0)) { errAgain.run(now, `\n\n--- Again, ${stamp()}:\n${lines(false)}`, row.id); return row.id; }
  if (row) { errBump.run(now, row.id); return row.id; }
  const body = lines(true);
  const title = `[${e.kind}] ${message.split('\n')[0].slice(0, 120)}`;
  const id = Number(insertReport.run({ kind: e.kind, hash, title, body, user_id: e.who?.id ?? null, version: appVersion, user_agent: e.userAgent ? clean(e.userAgent, 300) : null, now }).lastInsertRowid);
  // (a glitch is not mailed: there are many kinds of each, and they are read together)
  if (e.kind !== 'client-glitch' && allow('error-mail', 10, 24 * 60 * 60 * 1000)) void notifyOwner(`OverLyX ${e.kind} #${id}: ${message.split('\n')[0].slice(0, 100)}`, `${body}\n\nOverLyX ${appVersion} · ${stamp()}\nAll reports: npx tsx scripts/reports.ts\n`);
  return id;
}

/** Server-side errors from the process-level handlers (never throws). */
export function reportServerError(err: unknown): void {
  const e = err instanceof Error ? err : new Error(String(err));
  try { reportError({ kind: 'server-error', message: e.message, stack: e.stack }); } catch { /* the database may be what failed */ }
}

/** Error reports not seen for `days` are forgotten (startup housekeeping); people's own reports stay until their account goes. */
export function pruneReports(days = 90): number {
  const day = 24 * 60 * 60 * 1000;
  // mail to privacy@ / contact@ (inbox.ts) is kept a year — long enough to answer a request and keep its record; the pen lab's answers as long, for the pens to learn from
  return db.prepare("DELETE FROM reports WHERE kind NOT IN ('feedback', 'mail', 'ink-lab') AND last_at < ?").run(Date.now() - days * day).changes
    + db.prepare("DELETE FROM reports WHERE kind IN ('mail', 'ink-lab') AND last_at < ?").run(Date.now() - 365 * day).changes;
}

/** Reports and mail for the administrators' list (newest first). */
export function listReports(opts: { kind?: string; limit?: number } = {}): { id: number; kind: string; title: string; body: string; count: number; createdAt: number; lastAt: number; from: string | null }[] {
  const rows = db.prepare(`SELECT r.*, u.username, u.display_name AS name FROM reports r LEFT JOIN users u ON u.id = r.user_id
    ${opts.kind ? 'WHERE r.kind = @kind' : ''} ORDER BY r.last_at DESC LIMIT @limit`).all({ kind: opts.kind, limit: Math.min(500, opts.limit ?? 200) }) as any[];
  return rows.map(r => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, count: r.count, createdAt: r.created_at, lastAt: r.last_at, from: r.username ? `${r.name} (${r.username})` : null }));
}
export function deleteReport(id: number): boolean { return db.prepare('DELETE FROM reports WHERE id = ?').run(id).changes > 0; }

/** A message received by mailin.ts: a report of kind `mail` (who wrote is in its text — no account). */
export function storeMail(m: { from: string; fromName: string; to: string[]; subject: string; text: string; attachments: string[]; receivedAt: number }): number {
  const head = [`From: ${m.fromName ? `${m.fromName} <${m.from}>` : m.from}`, `To: ${m.to.join(', ')}`, m.attachments.length ? `Attachments (not kept): ${m.attachments.join(', ')}` : ''].filter(Boolean).join('\n');
  const id = Number(insertReport.run({ kind: 'mail', hash: null, title: clean(m.subject, 300) || '(no subject)', body: `${head}\n\n${clean(m.text, 20000)}`, user_id: null, version: appVersion, user_agent: null, now: m.receivedAt }).lastInsertRowid);
  console.log(`[mail] message #${id} for ${m.to.join(', ')}`);
  return id;
}

/**
 * An administrator answers a message (kind `mail`) from the address it was sent to (privacy@ /
 * contact@), through mailer.ts. The answer is kept in the message's body, so it goes with the
 * message a year after that arrived (pruneReports) — no copy in anyone's mailbox.
 */
export async function answerMail(id: number, answer: string): Promise<{ to: string; from: string }> {
  const r = db.prepare("SELECT title, body FROM reports WHERE id = ? AND kind = 'mail'").get(id) as { title: string; body: string } | undefined;
  if (!r) throw new Error('There is no such message');
  const head = r.body.split('\n\n')[0];
  const sender = /^From: (.*)$/m.exec(head)?.[1] ?? '';
  const to = (/<([^<>\s]+)>\s*$/.exec(sender)?.[1] ?? sender).trim();
  const from = (/^To: (.*)$/m.exec(head)?.[1] ?? '').split(',').map(a => a.trim()).find(a => /^(privacy|contact)@[^\s@]+$/i.test(a));
  if (!/^[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+$/.test(to) || !from) throw new Error('This message has no address to answer to, or was not sent to privacy@ / contact@');
  const text = clean(answer, 20000);
  const title = r.title.replace(/\s+/g, ' ');
  await sendAnswer({ from, to, subject: /^re:/i.test(title) ? title : `Re: ${title}`, text });
  db.prepare('UPDATE reports SET body = ? WHERE id = ?').run(`${r.body}\n\n— Answered ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC from ${from}:\n${text}`, id);
  console.log(`[mail] message #${id} answered from ${from}`);
  return { to, from };
}

/** An account is deleted: its reports go, its link to error reports is cut. */
export function forgetUserReports(userId: number): void {
  db.prepare("DELETE FROM reports WHERE kind IN ('feedback', 'ink-lab') AND user_id = ?").run(userId);
  db.prepare('UPDATE reports SET user_id = NULL WHERE user_id = ?').run(userId);
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
    res.json({ version: appVersion, errorReports: config.errorReports });
  });
  r.post('/feedback', (req, res) => {
    const u = req.user!;
    const b = req.body ?? {};
    const f: FeedbackInput = {
      kind: ['bug', 'idea', 'question'].includes(b.kind) ? b.kind : 'bug', title: clean(b.title, 200), body: clean(b.body, 20000),
      doc: b.doc ? clean(b.doc, 200) : null, error: b.error ? clean(b.error, 2000) : null, userAgent: req.get('user-agent') ?? '',
    };
    if (!f.title && !f.body) { res.status(400).json({ error: 'Please write something.' }); return; }
    if (!allow(`feedback:${u.id}`, 10)) { res.status(429).json({ error: 'That is a lot of feedback for one hour — thank you! Please try again later.' }); return; }
    res.json(submitFeedback(f, { id: u.id, name: u.name, username: u.username, email: u.email }));
  });
  r.post('/client-error', (req, res) => {
    const u = req.user!;
    const b = req.body ?? {};
    if (!config.errorReports) { res.status(204).end(); return; }
    if (!allow('client-error', 60) || !allow(`client-error:${u.id}`, 20)) { res.status(429).json({ error: 'rate limited' }); return; }
    const id = reportError({ kind: 'client-error', message: clean(b.message, 1000), stack: b.stack ? clean(b.stack, 4000) : null, userAgent: req.get('user-agent') ?? '', who: { id: u.id, name: u.name, username: u.username } });
    res.json({ id });
  });
  r.post('/ink-lab', (req, res) => {
    const u = req.user!;
    const lab = inkLabReport(req.body);
    if (!lab) { res.status(400).json({ error: 'not the pen lab\'s answers' }); return; }
    if (!allow(`ink-lab:${u.id}`, 10)) { res.status(429).json({ error: 'That is a lot of sending for one hour — please try again later.' }); return; }
    const now = Date.now();
    const id = Number(insertReport.run({ kind: 'ink-lab', hash: null, title: lab.title, body: lab.body, user_id: u.id, version: appVersion, user_agent: clean(req.get('user-agent') ?? '', 300) || null, now }).lastInsertRowid);
    console.log(`[ink-lab] report #${id}: ${lab.title}`);
    res.json({ id });
  });
  r.post('/client-glitch', (req, res) => {
    const u = req.user!;
    const b = req.body ?? {};
    if (!config.errorReports) { res.status(204).end(); return; }
    const g = glitchReport(b.kind, b.fields, b.trail);
    if (!g) { res.status(400).json({ error: 'not a glitch report' }); return; }
    if (!allow('client-glitch', 60) || !allow(`client-glitch:${u.id}`, 20)) { res.status(429).json({ error: 'rate limited' }); return; }
    const id = reportError({ kind: 'client-glitch', message: g.message, details: g.details, stack: g.trail, keepRepeats: 4, userAgent: req.get('user-agent') ?? '', who: { id: u.id, name: u.name, username: u.username } });
    res.json({ id });
  });
  return r;
}

const VSCODE_FIELDS: Record<string, string> = {
  area: 'Area',
  errorName: 'Error type',
  extensionVersion: 'Extension',
  vscodeVersion: 'VS Code',
  platform: 'Platform',
  arch: 'Architecture',
  remote: 'Extension host',
  uiKind: 'UI',
};

/**
 * Public receiver for the no-account VS Code extension. The extension has no useful secret to
 * authenticate with (anything bundled in a VSIX is public), so use a narrow schema and IP/global
 * rate limits instead. IP addresses are used only in this in-memory limiter and are never stored.
 */
export function vscodeTelemetryRoutes(): express.Router {
  const r = express.Router();
  r.post('/vscode-telemetry', express.json({ limit: '64kb', type: 'application/json' }), (req, res) => {
    if (!config.errorReports) { res.status(204).end(); return; }
    const b = req.body ?? {};
    if (b.schema !== 1 || (b.event !== 'error' && b.event !== 'unhandled-error')) {
      res.status(400).json({ error: 'unsupported diagnostic schema' }); return;
    }
    const ip = req.ip ?? 'x';
    if (!allow('vscode-error', 300) || !allow(`vscode-error:${ip}`, 30)) {
      res.status(429).json({ error: 'rate limited' }); return;
    }
    const message = clean(b.message, 1000);
    if (!message) { res.status(400).json({ error: 'message is required' }); return; }
    const details: Record<string, string> = {};
    for (const [field, label] of Object.entries(VSCODE_FIELDS)) {
      if (typeof b[field] === 'string' || typeof b[field] === 'number' || typeof b[field] === 'boolean') {
        details[label] = clean(b[field], 300);
      }
    }
    const id = reportError({
      kind: 'vscode-error', message, stack: typeof b.stack === 'string' ? clean(b.stack, 4000) : null,
      userAgent: req.get('user-agent') ?? '', details,
    });
    res.json({ id });
  });
  return r;
}
