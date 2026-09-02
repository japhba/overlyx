/**
 * Owner notifications (packages/server/src/mailer.ts): the sign-up notice reaches the owner's
 * address with the new account's e-mail, and an unconfigured or owner-own sign-up sends nothing.
 * OVERLYX_SMTP_URL=json keeps everything in-process (nodemailer JSON transport).
 */
import { describe, it, expect, beforeAll } from 'vitest';

process.env.OVERLYX_OWNER_EMAIL = 'owner@example.org';
process.env.OVERLYX_SMTP_URL = 'json';
process.env.OVERLYX_PUBLIC_URL = 'https://overlyx.example';

let mailer: typeof import('../packages/server/src/mailer.ts');

describe('sign-up notifications', () => {
  beforeAll(async () => { mailer = await import('../packages/server/src/mailer.ts'); });

  it('mails the owner the name, e-mail and count of a new account', async () => {
    mailer.notifySignup({ name: 'Ada Lovelace', username: 'ada', email: 'ada@example.com' }, 42);
    await expect.poll(() => mailer.sentMails.length).toBe(1);
    const m = mailer.sentMails[0];
    expect(m.to).toBe('owner@example.org');
    expect(m.subject).toBe('New OverLyX sign-up: ada@example.com');
    expect(m.text).toContain('Ada Lovelace');
    expect(m.text).toContain('ada@example.com');
    expect(m.text).toContain('https://overlyx.example');
    expect(m.text).toContain('42 accounts');
  });

  it('an account without a shared e-mail is reported by its username', async () => {
    mailer.notifySignup({ name: 'Mystery', username: 'google_123', email: null }, 43);
    await expect.poll(() => mailer.sentMails.length).toBe(2);
    expect(mailer.sentMails[1].subject).toBe('New OverLyX sign-up: google_123');
    expect(mailer.sentMails[1].text).toContain('(none shared)');
  });

  it("the owner's own sign-in is not reported", async () => {
    mailer.notifySignup({ name: 'Owner', username: 'owner', email: 'Owner@Example.org' }, 44);
    await new Promise(r => setTimeout(r, 50));
    expect(mailer.sentMails.length).toBe(2);
  });
});
