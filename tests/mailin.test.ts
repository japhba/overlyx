/**
 * Mail for the privacy notice's address (server mailin.ts, inbox.ts): the receiver takes mail only for
 * its own addresses, keeps text and attachment names (never attachments), refuses everyone else,
 * forwards nothing; the OverLyX server moves the received messages into its reports (kind `mail`),
 * which the administrators list, kept a year.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import nodemailer from 'nodemailer';

const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-mailin-test');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'data'), { recursive: true });
mkdirSync(join(ROOT, 'projects'), { recursive: true });
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');
const INBOX = join(ROOT, 'inbox');

const { mailinServer } = await import('../packages/server/src/mailin.ts');
const { importInbox } = await import('../packages/server/src/inbox.ts');
const { listReports, pruneReports } = await import('../packages/server/src/feedback.ts');
const { db } = await import('../packages/server/src/db.ts');

const server = mailinServer({ dir: INBOX, domain: 'example.org', recipients: ['privacy', 'contact'], port: 0 });
await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
const port = (server.server.address() as { port: number }).port;
const smtp = nodemailer.createTransport({ host: '127.0.0.1', port, secure: false, ignoreTLS: true, tls: { rejectUnauthorized: false } });
afterAll(async () => { smtp.close(); await new Promise<void>(r => server.close(() => r())); rmSync(ROOT, { recursive: true, force: true }); });

describe('mail for privacy@ / contact@', () => {
  it('takes a message for its own address: sender, subject, text, attachment names', async () => {
    await smtp.sendMail({
      from: '"Ruth Reader" <ruth@example.net>', to: 'privacy@example.org', subject: 'Please delete my data',
      text: 'Hello, I would like a copy of my data.', html: '<p>Hello, I would like a copy of my data.</p>',
      attachments: [{ filename: 'id.pdf', content: 'not kept' }],
    });
    const files = readdirSync(INBOX).filter(f => f.endsWith('.json'));
    expect(files).toHaveLength(1);
    const m = JSON.parse(readFileSync(join(INBOX, files[0]), 'utf8'));
    expect(m).toMatchObject({ from: 'ruth@example.net', fromName: 'Ruth Reader', to: ['privacy@example.org'], subject: 'Please delete my data', attachments: ['id.pdf'] });
    expect(m.text).toContain('I would like a copy of my data.');
    expect(JSON.stringify(m)).not.toContain('not kept');
  });

  it('refuses any other address — it relays and forwards nothing', async () => {
    await expect(smtp.sendMail({ from: 'x@example.net', to: 'jan@example.org', subject: 'hi', text: 'x' })).rejects.toThrow(/550|No such user/);
    await expect(smtp.sendMail({ from: 'x@example.net', to: 'someone@gmail.com', subject: 'relay?', text: 'x' })).rejects.toThrow(/550|No such user/);
    expect(readdirSync(INBOX).filter(f => f.endsWith('.json'))).toHaveLength(1);
  });

  it('the server moves the messages into its reports, for the administrators; kept a year', () => {
    expect(importInbox(INBOX)).toBe(1);
    expect(readdirSync(INBOX).filter(f => f.endsWith('.json'))).toHaveLength(0);
    const r = listReports({ kind: 'mail' });
    expect(r).toHaveLength(1);
    expect(r[0].title).toBe('Please delete my data');
    expect(r[0].body).toContain('From: Ruth Reader <ruth@example.net>');
    expect(r[0].body).toContain('Attachments (not kept): id.pdf');
    // a malformed file is put aside, never crashes the import
    writeFileSync(join(INBOX, '1-abcdef.json'), '{not json');
    expect(importInbox(INBOX)).toBe(0);
    expect(readdirSync(INBOX)).toContain('1-abcdef.json.bad');
    // ninety days later it is still there; after a year it goes
    db.prepare("UPDATE reports SET last_at = ? WHERE kind = 'mail'").run(Date.now() - 200 * 86400_000);
    pruneReports();
    expect(listReports({ kind: 'mail' })).toHaveLength(1);
    db.prepare("UPDATE reports SET last_at = ? WHERE kind = 'mail'").run(Date.now() - 400 * 86400_000);
    pruneReports();
    expect(listReports({ kind: 'mail' })).toHaveLength(0);
  });
});
