/**
 * Mail received by the separate, unprivileged receiver (mailin.ts) arrives as JSON files in its
 * directory; this moves them into the reports (kind `mail`, feedback.ts storeMail) every minute, where
 * the administrators read them (Settings ▸ Account ▸ Messages and reports, scripts/reports.ts).
 * The files are read as data only, size-capped, and deleted once stored. The owner is told by e-mail
 * that mail came (mailer.ts: how many, nothing of it — the privacy notice promises it is never
 * forwarded), at most once an hour so that a burst of spam is one notice.
 */
import fs from 'node:fs';
import path from 'node:path';
import { storeMail } from './feedback.ts';
import { notifyOwner, READ_IT } from './mailer.ts';

export const MAIL_INBOX = (process.env.OVERLYX_MAIL_INBOX ?? '/var/lib/overlyx-mailin').trim();

export function importInbox(dir = MAIL_INBOX): number {
  let names: string[];
  try { names = fs.readdirSync(dir).filter(n => /^\d+-[0-9a-f]+\.json$/.test(n)).sort(); } catch { return 0; }
  let n = 0;
  for (const name of names.slice(0, 200)) {
    const file = path.join(dir, name);
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.size > 64 * 1024) { fs.rmSync(file, { force: true }); continue; }
      const m = JSON.parse(fs.readFileSync(file, 'utf8'));
      const str = (v: unknown, max: number) => String(v ?? '').slice(0, max);
      storeMail({
        from: str(m.from, 200), fromName: str(m.fromName, 200), to: Array.isArray(m.to) ? m.to.slice(0, 3).map((t: unknown) => str(t, 200)) : [],
        subject: str(m.subject, 300), text: str(m.text, 20000), attachments: Array.isArray(m.attachments) ? m.attachments.slice(0, 20).map((a: unknown) => str(a, 200)) : [],
        receivedAt: Number(m.receivedAt) || Date.now(),
      });
      fs.rmSync(file, { force: true });
      n++;
    } catch (e) { console.error('[mail] cannot import', name, (e as Error).message); try { fs.renameSync(file, file + '.bad'); } catch { /* ignore */ } }
  }
  return n;
}

const NOTICE_GAP_MS = 60 * 60 * 1000;
let unannounced = 0;
let lastNotice = 0;

/** New mail was stored: tell the owner how many messages are waiting (not from whom or about what), at most once per NOTICE_GAP_MS. */
export function announceMail(stored: number, now = Date.now()): boolean {
  unannounced += stored;
  if (!unannounced || now - lastNotice < NOTICE_GAP_MS) return false;
  const n = unannounced;
  unannounced = 0; lastNotice = now;
  void notifyOwner(`OverLyX: ${n === 1 ? 'a new message' : `${n} new messages`} to privacy@ / contact@`,
    `${n === 1 ? 'A message has' : `${n} messages have`} arrived. ${READ_IT}\n\n` +
    'This notice leaves out who wrote and what on purpose: that mail stays on the server.\n');
  return true;
}

export function startInboxImport(): void {
  const tick = () => { try { announceMail(importInbox()); } catch (e) { console.error('[mail] import failed:', e); } };
  tick();
  setInterval(tick, 60_000).unref();
}
