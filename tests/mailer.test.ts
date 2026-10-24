/**
 * Owner notices (packages/server/src/mailer.ts): a sign-up, a problem report and mail to privacy@ /
 * contact@ (inbox.ts) are announced to the owner's address without their content — no names,
 * addresses or text leave the server; an unconfigured or owner-own sign-up sends nothing, and mail
 * is announced at most once an hour. OVERLYX_SMTP_URL=json keeps everything in-process.
 */
import { describe, it, expect, beforeAll } from 'vitest';

process.env.OVERLYX_OWNER_EMAIL = 'owner@example.org';
process.env.OVERLYX_SMTP_URL = 'json';
process.env.OVERLYX_PUBLIC_URL = 'https://overlyx.example';

let mailer: typeof import('../packages/server/src/mailer.ts');
let inbox: typeof import('../packages/server/src/inbox.ts');

describe('owner notices', () => {
  beforeAll(async () => {
    mailer = await import('../packages/server/src/mailer.ts');
    inbox = await import('../packages/server/src/inbox.ts');
  });

  it('announce a new account and the count, but not who it is', async () => {
    mailer.notifySignup({ name: 'Ada Lovelace', username: 'ada', email: 'ada@example.com' }, 42);
    await expect.poll(() => mailer.sentMails.length).toBe(1);
    const m = mailer.sentMails[0];
    expect(m.to).toBe('owner@example.org');
    expect(m.subject).toBe('New OverLyX sign-up');
    expect(m.text).toContain('https://overlyx.example');
    expect(m.text).toContain('42 accounts');
    expect(`${m.subject}\n${m.text}`).not.toMatch(/Ada|ada@example\.com|\bada\b/);
  });

  it("the owner's own sign-in is not reported", async () => {
    mailer.notifySignup({ name: 'Owner', username: 'owner', email: 'Owner@Example.org' }, 44);
    await new Promise(r => setTimeout(r, 50));
    expect(mailer.sentMails.length).toBe(1);
  });

  it('announce mail by its number only, once an hour', async () => {
    const t0 = Date.parse('2026-10-25T10:00:00Z');
    expect(inbox.announceMail(1, t0)).toBe(true);
    await expect.poll(() => mailer.sentMails.length).toBe(2);
    expect(mailer.sentMails[1].subject).toBe('OverLyX: a new message to privacy@ / contact@');
    expect(mailer.sentMails[1].text).toContain('Settings ▸ Account ▸ Messages and reports');
    // a burst within the hour waits, then goes out as one notice with the count
    expect(inbox.announceMail(2, t0 + 60_000)).toBe(false);
    expect(inbox.announceMail(1, t0 + 120_000)).toBe(false);
    expect(inbox.announceMail(0, t0 + 3_600_000)).toBe(true);
    await expect.poll(() => mailer.sentMails.length).toBe(3);
    expect(mailer.sentMails[2].subject).toBe('OverLyX: 3 new messages to privacy@ / contact@');
    expect(inbox.announceMail(0, t0 + 2 * 3_600_000)).toBe(false);
  });

  it('an answer to mail goes out from the address it was sent to and stays with the message', async () => {
    const fb = await import('../packages/server/src/feedback.ts');
    const id = fb.storeMail({ from: 'ruth@example.net', fromName: 'Ruth Reader', to: ['privacy@overlyx.example'], subject: 'Please delete my data', text: 'My account is ruth.', attachments: [], receivedAt: Date.now() });
    const before = mailer.sentMails.length;
    expect(await fb.answerMail(id, 'Done: your account is deleted.')).toEqual({ to: 'ruth@example.net', from: 'privacy@overlyx.example' });
    const m = mailer.sentMails[before];
    expect(m).toEqual({ to: 'ruth@example.net', subject: 'Re: Please delete my data', text: 'Done: your account is deleted.' });
    const kept = fb.listReports({ kind: 'mail' }).find(r => r.id === id)!;
    expect(kept.body).toContain('Answered');
    expect(kept.body).toContain('Done: your account is deleted.');
    await expect(fb.answerMail(id + 999, 'x')).rejects.toThrow(/no such message/);
  });
});
