/**
 * Inbound mail for the addresses the privacy notice names (privacy@, contact@ <domain>): a small
 * receiving-only SMTP server, run as its own unprivileged systemd unit (deploy/overlyx-mailin.service)
 * — never inside the OverLyX server, which runs as root: what arrives from the internet is parsed
 * here, as nobody. Nothing is forwarded or sent, so the operator's own addresses stay unknown and
 * no spam reaches an inbox: each accepted message becomes a small JSON file (sender, subject, text,
 * attachment names — no attachments, no HTML) in MAILIN_DIR, which the OverLyX server picks up into
 * its reports (inbox.ts) for the administrators' list in Settings.
 *
 *   MAILIN_PORT        25
 *   MAILIN_DIR         /var/lib/overlyx-mailin (the unit's StateDirectory)
 *   MAILIN_DOMAIN      overlyx.app
 *   MAILIN_RECIPIENTS  privacy,contact   (local parts; anything else is refused at RCPT TO)
 *
 * Limits: 256 KB per message, 3 recipients, 20 messages an hour per sending address (IP), 300 a day
 * in all; a full inbox directory (2000 files) refuses new mail. Plain text only (HTML is turned into
 * text), 20 000 characters kept.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SMTPServer, type SMTPServerOptions } from 'smtp-server';
import { simpleParser } from 'mailparser';

export interface MailinOptions { dir: string; domain: string; recipients: string[]; port: number; host?: string }

export interface StoredMail {
  id: string; receivedAt: number; from: string; fromName: string; to: string[];
  subject: string; text: string; attachments: string[]; remote: string;
}

const MAX_BYTES = 256 * 1024;
const MAX_FILES = 2000;
const clip = (s: unknown, n: number) => String(s ?? '').replace(/\r/g, '').slice(0, n);

/** the per-IP and global limits (sliding hour / day) */
function limiter() {
  const per = new Map<string, number[]>();
  let all: number[] = [];
  return (ip: string): boolean => {
    const now = Date.now();
    const mine = (per.get(ip) ?? []).filter(t => now - t < 3600_000);
    all = all.filter(t => now - t < 86400_000);
    if (mine.length >= 20 || all.length >= 300) { per.set(ip, mine); return false; }
    mine.push(now); all.push(now); per.set(ip, mine);
    if (per.size > 10_000) per.clear();
    return true;
  };
}

export function mailinServer(o: MailinOptions): SMTPServer {
  fs.mkdirSync(o.dir, { recursive: true });
  const allowed = new Set(o.recipients.map(r => `${r.trim().toLowerCase()}@${o.domain.toLowerCase()}`));
  const allow = limiter();
  const options: SMTPServerOptions = {
    name: o.domain,
    banner: 'OverLyX — receiving only',
    authOptional: true,
    disabledCommands: ['AUTH', 'STARTTLS'],
    size: MAX_BYTES,
    maxClients: 20,
    socketTimeout: 30_000,
    closeTimeout: 5_000,
    logger: false,
    onConnect(session, cb) {
      if (!allow(session.remoteAddress)) { cb(Object.assign(new Error('Too many messages, try later'), { responseCode: 421 })); return; }
      cb();
    },
    onMailFrom(_address, _session, cb) {
      if (fs.readdirSync(o.dir).length >= MAX_FILES) { cb(Object.assign(new Error('Mailbox full, try later'), { responseCode: 452 })); return; }
      cb();
    },
    onRcptTo(address, session, cb) {
      const to = address.address.toLowerCase();
      if (!allowed.has(to)) { cb(Object.assign(new Error('No such user here'), { responseCode: 550 })); return; }
      if (session.envelope.rcptTo.length >= 3) { cb(Object.assign(new Error('Too many recipients'), { responseCode: 452 })); return; }
      cb();
    },
    onData(stream, session, cb) {
      const chunks: Buffer[] = [];
      let bytes = 0, tooBig = false;
      stream.on('data', (c: Buffer) => { bytes += c.length; if (bytes > MAX_BYTES) tooBig = true; else chunks.push(c); });
      stream.on('end', async () => {
        if (tooBig || (stream as unknown as { sizeExceeded?: boolean }).sizeExceeded) { cb(Object.assign(new Error('Message too big'), { responseCode: 552 })); return; }
        try {
          const m = await simpleParser(Buffer.concat(chunks), { skipHtmlToText: false, skipImageLinks: true, skipTextLinks: true });
          const from = m.from?.value?.[0];
          const mail: StoredMail = {
            id: crypto.randomBytes(8).toString('hex'),
            receivedAt: Date.now(),
            from: clip(from?.address ?? (session.envelope.mailFrom ? (session.envelope.mailFrom as { address: string }).address : ''), 200),
            fromName: clip(from?.name, 200),
            to: session.envelope.rcptTo.map(r => r.address.toLowerCase()),
            subject: clip(m.subject, 300),
            text: clip(m.text ?? '', 20_000),
            attachments: (m.attachments ?? []).slice(0, 20).map(a => clip(a.filename ?? a.contentType, 200)),
            remote: clip(session.remoteAddress, 64),
          };
          const file = path.join(o.dir, `${mail.receivedAt}-${mail.id}.json`);
          fs.writeFileSync(file + '.tmp', JSON.stringify(mail));
          fs.renameSync(file + '.tmp', file);
          cb();
        } catch (e) {
          cb(Object.assign(new Error('Could not read the message'), { responseCode: 451 }));
          console.error('[mailin]', (e as Error).message);
        }
      });
    },
  };
  return new SMTPServer(options);
}

// run as a program (the systemd unit): listen
if (import.meta.url === `file://${process.argv[1]}`) {
  const o: MailinOptions = {
    port: Number(process.env.MAILIN_PORT ?? 25),
    host: process.env.MAILIN_HOST ?? '0.0.0.0',
    dir: process.env.MAILIN_DIR ?? '/var/lib/overlyx-mailin',
    domain: process.env.MAILIN_DOMAIN ?? 'overlyx.app',
    recipients: (process.env.MAILIN_RECIPIENTS ?? 'privacy,contact').split(',').filter(Boolean),
  };
  const server = mailinServer(o);
  server.on('error', e => console.error('[mailin]', e.message));
  server.listen(o.port, o.host, () => console.log(`[mailin] receiving for ${o.recipients.map(r => `${r}@${o.domain}`).join(', ')} on ${o.host}:${o.port}, into ${o.dir}`));
}
