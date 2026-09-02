/**
 * E-mail notifications to the instance owner (`OVERLYX_OWNER_EMAIL`). `OVERLYX_SMTP_URL` turns
 * them on — an SMTP connection URL with credentials, e.g. for a Gmail account with an app
 * password: `smtps://you%40gmail.com:app-password@smtp.gmail.com/`. Without it the notification
 * is only logged: outbound port 25 is blocked on this kind of host, so there is no useful
 * unauthenticated transport. `OVERLYX_SMTP_URL=json` uses nodemailer's JSON transport (nothing
 * leaves the process) — tests use that and read `sentMails`.
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

/** A new account was created (Google sign-in, first visit): tell the owner who arrived. */
export function notifySignup(user: { name: string; username: string; email?: string | null }, totalUsers: number): void {
  if (user.email && user.email.toLowerCase() === config.ownerEmail) return;   // the owner's own account
  void notifyOwner(
    `New OverLyX sign-up: ${user.email ?? user.username}`,
    `${user.name} just signed up to ${config.publicUrl || 'your OverLyX instance'}.\n\n` +
    `  e-mail:   ${user.email ?? '(none shared)'}\n` +
    `  username: ${user.username}\n` +
    `  when:     ${new Date().toISOString()}\n\n` +
    `That makes ${totalUsers} accounts.\n`,
  );
}
