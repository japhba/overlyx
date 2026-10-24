/**
 * The terms of use, GET /terms (public, no sign-in): the rules for using this OverLyX instance and the
 * limits of the operator's liability. Linked from the start page (its footer and the sign-in box),
 * Help ▸ Terms of use and the privacy notice. Who runs the instance comes from privacy.ts's settings
 * (OVERLYX_OPERATOR, OVERLYX_PRIVACY_CONTACT).
 *
 * The service is free and offered as it is: these terms set rules for users and limit the operator's
 * liability, and promise nothing that the code or the operator would have to keep doing — keep it
 * that way when changing them (what happens to data is the privacy notice's to say).
 */
import type { Request, Response } from 'express';
import { config } from './config.ts';
import { NOTICE_STYLE, esc } from './privacy.ts';

export const TERMS_UPDATED = '24 October 2026';

export function termsHtml(): string {
  const operator = (process.env.OVERLYX_OPERATOR ?? '').trim();
  const contact = (process.env.OVERLYX_PRIVACY_CONTACT ?? '').trim() || config.contactEmail;
  const site = config.publicUrl ? new URL(config.publicUrl).host : 'this OverLyX instance';
  const who = operator ? esc(operator) : `the person who runs ${esc(site)}`;
  const reach = contact
    ? `by e-mail to <a href="mailto:${esc(contact)}">${esc(contact)}</a>, or with <b>Help ▸ Report a problem</b> in the app`
    : 'with <b>Help ▸ Report a problem</b> in the app';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Terms of use · OverLyX</title><link rel="icon" href="/icon.svg"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
${NOTICE_STYLE}</head>
<body><main>
<a class="back" href="/">← OverLyX</a>
<h1>Terms of use</h1>
<p class="sub">Last updated ${TERMS_UPDATED}. These terms apply when you use OverLyX at ${esc(site)}. What happens to your data is in the <a href="/privacy">privacy notice</a>.</p>

<h2>Who offers OverLyX</h2>
<p>OverLyX at ${esc(site)} is run by ${who} (“the operator”) as a private, non-commercial project, free of charge. You can reach them ${reach}. These terms are about this website. OverLyX's source code is open source and comes with its own licence.</p>

<h2>Agreeing to these terms</h2>
<p>By signing in, or by using OverLyX through a share link or the VS Code extension, you agree to these terms. If you do not agree, please do not use OverLyX. You need to be at least 16 years old to have an account.</p>

<h2>A free beta, offered as it is</h2>
<ul>
<li>OverLyX is a beta. It is offered as it is and as available, without any warranty or guarantee: not that it is available, not that it works correctly (the editor, the PDFs it builds or what an AI feature writes), not that it suits a particular purpose, and not that your data is kept.</li>
<li>Features can change or disappear, and the service can be interrupted, limited or ended at any time, with or without notice.</li>
<li>The backups described in the privacy notice protect the service; they are not a promise to you. Keep your own copies of anything that matters: each project's menu has <b>Download as .zip</b>, and projects can be pulled with git.</li>
</ul>

<h2>Your content</h2>
<ul>
<li>What you put into OverLyX stays yours. You allow the operator to store, copy, back up, process, build and show it as far as this is needed to run OverLyX for you and for the people you share it with, and to send it to the services listed in the privacy notice when you use the features that do so.</li>
<li>You are responsible for your content and for having the right to use it. Do not put anything into OverLyX that is illegal, that infringes other people's rights (such as copyright, their personal data or confidentiality), or that is malicious software. If your content or your use of OverLyX breaks the law or someone's rights, that is your responsibility, not the operator's.</li>
<li>You decide whom you share with. Anyone who has a share link or a public PDF link can open what it points to.</li>
</ul>

<h2>Fair use</h2>
<p>Do not attack, overload or probe the service or its server; do not get around sign-in, sharing or limits; do not open other people's projects or accounts without their permission; and do not use OverLyX to send spam or for automated mass access beyond normal use of its git access, its connection for AI apps and the VS Code extension.</p>
<p>The operator may remove content, suspend or delete accounts or block access when these terms are broken, when the law requires it, or when the service or other people are at risk.</p>

<h2>AI features and other services</h2>
<ul>
<li>AI features and the Agent panel can be wrong. Check what they produce before you rely on it.</li>
<li>When you connect an account or key of your own (Google, ChatGPT, Anthropic, OpenRouter, Zotero, LessWrong), that service's terms and prices apply, and what is charged to your key is yours to pay.</li>
</ul>

<h2>Liability</h2>
<p>OverLyX is free. The operator is therefore liable only for intent and gross negligence. For anything else, in particular for lost or damaged data, interruptions and indirect or consequential losses, the operator is not liable, as far as the law allows.</p>
<p>This does not limit liability for injury to life, body or health, for fraud, under product-liability law, or in any other case where the law does not allow liability to be limited or excluded. If you are a consumer, the rights that the law of your country gives you and that cannot be waived remain unaffected.</p>

<h2>Ending</h2>
<p>You can stop using OverLyX at any time. <b>Settings ▸ Account ▸ Delete account</b> deletes your account (the privacy notice says what goes when). The operator can end your use of OverLyX, or OverLyX itself, at any time.</p>

<h2>Changes</h2>
<p>The operator may change these terms. This page always has the current version and its date. If you keep using OverLyX after a change, the new terms apply; if you do not agree with them, stop using OverLyX and delete your account.</p>

<h2>The rest</h2>
<p>If a part of these terms is invalid, the rest still applies.</p>
</main></body></html>`;
}

export function termsPage(_req: Request, res: Response): void {
  res.type('html').set('Cache-Control', 'no-cache').send(termsHtml());
}
