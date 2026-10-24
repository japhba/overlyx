/**
 * E-mail notices to the instance owner (`OVERLYX_OWNER_EMAIL`): that something arrived — a sign-up,
 * a problem report (feedback.ts), mail to privacy@ / contact@ (inbox.ts) — never what: no names,
 * addresses or text, which stay on the server (the privacy notice promises it). `OVERLYX_SMTP_URL`
 * turns them on — an SMTP connection URL with credentials, e.g. a sending service on port 587
 * (`smtp://login:key@smtp-relay.brevo.com:587`; Hetzner blocks outbound 25 and 465), with
 * `OVERLYX_MAIL_FROM` an address of the instance's domain. Without it the notice is only logged.
 * `OVERLYX_SMTP_URL=json` uses nodemailer's JSON transport (nothing leaves the process) — tests use
 * that and read `sentMails`.
 */
import nodemailer, { type Transporter } from 'nodemailer';
import { config } from './config.ts';

let transport: Transporter | null | undefined;
let smtpUser = '';

function getTransport(): Transporter | null {
  if (transport !== undefined) return transport;
  const url = (process.env.OVERLYX_SMTP_URL ?? '').trim();
  if (!url) return (transport = null);
  if (url === 'json') { transport = nodemailer.createTransport({ jsonTransport: true }); return transport; }
  try { smtpUser = decodeURIComponent(new URL(url).username); } catch { /* from falls back to the owner */ }
  transport = nodemailer.createTransport(url);
  return transport;
}

/** What went out (json transport only) — read by the tests. */
export const sentMails: { to: string; subject: string; text: string }[] = [];

/** Fire-and-forget notification to the owner; failures are logged, never thrown to the caller. */
export async function notifyOwner(subject: string, text: string): Promise<void> {
  const to = config.ownerEmail;
  if (!to) return;
  const t = getTransport();
  if (!t) { console.log(`[mail] OVERLYX_SMTP_URL not set — would have mailed ${to}: ${subject}`); return; }
  try {
    // Gmail rewrites the sender to the authenticated account anyway; use it as From when we know it
    const from = process.env.OVERLYX_MAIL_FROM ?? (smtpUser ? `OverLyX <${smtpUser}>` : `OverLyX <${to}>`);
    await t.sendMail({ from, to, subject, text });
    sentMails.push({ to, subject, text });
  } catch (e) {
    console.error('[mail] sending failed:', (e as Error).message);
  }
}

/** An administrator's answer to mail sent to privacy@ / contact@ (feedback.ts answerMail), from that address. Throws when it cannot go out. */
export async function sendAnswer(m: { from: string; to: string; subject: string; text: string }): Promise<void> {
  const t = getTransport();
  if (!t) throw new Error('No mail is sent from this server: OVERLYX_SMTP_URL is not set');
  await t.sendMail({ from: `OverLyX <${m.from}>`, to: m.to, subject: m.subject, text: m.text });
  sentMails.push({ to: m.to, subject: m.subject, text: m.text });
}

/** Where the owner reads what a notice leaves out. */
export const READ_IT = 'Read it in OverLyX: Settings ▸ Account ▸ Messages and reports.';

/** A new account was created (Google sign-in, first visit): tell the owner that someone arrived — who is in Settings ▸ Account. */
export function notifySignup(user: { name: string; username: string; email?: string | null }, totalUsers: number): void {
  if (user.email && user.email.toLowerCase() === config.ownerEmail) return;   // the owner's own account
  void notifyOwner(
    'New OverLyX sign-up',
    `Someone just signed up to ${config.publicUrl || 'your OverLyX instance'}. That makes ${totalUsers} accounts.\n\n` +
    'Who it is: Settings ▸ Account in OverLyX (this e-mail leaves names and addresses out on purpose).\n',
  );
}
