/**
 * Mail received by the separate, unprivileged receiver (mailin.ts) arrives as JSON files in its
 * directory; this moves them into the reports (kind `mail`, feedback.ts storeMail) every minute, where
 * the administrators read them (Settings ▸ Account ▸ Messages and reports, scripts/reports.ts).
 * The files are read as data only, size-capped, and deleted once stored.
 */
import fs from 'node:fs';
import path from 'node:path';
import { storeMail } from './feedback.ts';

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

export function startInboxImport(): void {
  const tick = () => { try { importInbox(); } catch (e) { console.error('[mail] import failed:', e); } };
  tick();
  setInterval(tick, 60_000).unref();
}
