/**
 * The privacy notice, GET /privacy (public, no sign-in): what OverLyX keeps, who else sees it, how
 * long, and how to delete it. Linked from the start page's footer, Help ▸ Privacy notice and
 * Settings ▸ Privacy / Account.
 *
 * It describes this code — keep it in step when data handling changes: feedback.ts (reports),
 * accounts.ts (deletion, trash), usage.ts (statistics), access.ts (activity log, guests, admin
 * access), mirror.ts (GitHub backup), ai.ts / airepair.ts / agent.ts / bibsearch.ts / gdocs
 * (third parties), scripts/backup.sh (backups).
 *
 * Who runs the instance comes from the environment: OVERLYX_OPERATOR (a name) and
 * OVERLYX_PRIVACY_CONTACT (an e-mail address; else OVERLYX_CONTACT_EMAIL, the contact address of the
 * literature services' polite pools). On overlyx.app both are set in a systemd drop-in
 * (/etc/systemd/system/overlyx.service.d/operator.conf).
 */
import type { Request, Response } from 'express';
import { config } from './config.ts';
import { RELIABILITY_RETENTION_DAYS, RETENTION_DAYS as USAGE_DAYS } from './usage.ts';
import { TRASH_DAYS } from './accounts.ts';

export const PRIVACY_UPDATED = '13 October 2026';

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function privacyHtml(): string {
  const operator = (process.env.OVERLYX_OPERATOR ?? '').trim();
  // the notice's own contact (OVERLYX_PRIVACY_CONTACT) — not sent with the literature searches as
  // OVERLYX_CONTACT_EMAIL is (the OpenAlex / Crossref polite pools); that one is the fallback
  const contact = (process.env.OVERLYX_PRIVACY_CONTACT ?? '').trim() || config.contactEmail;
  const site = config.publicUrl ? new URL(config.publicUrl).host : 'this OverLyX instance';
  // what this server offers: the notice describes it, not a different setup
  const google = !!config.google.clientId;
  const who = operator ? esc(operator) : `the person who runs ${esc(site)}`;
  const reach = contact
    ? `by e-mail to <a href="mailto:${esc(contact)}">${esc(contact)}</a>, or with <b>Help ▸ Report a problem</b> in the app`
    : 'with <b>Help ▸ Report a problem</b> in the app (choose “A question”) — it reaches the operator directly and is not published';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy · OverLyX</title><link rel="icon" href="/icon.svg"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
<style>
:root{--bg:#fbfaf7;--fg:#1b1b1b;--mute:#5d5d5d;--rule:#e2dfd8;--accent:#c8102e}
@media (prefers-color-scheme:dark){:root{--bg:#161616;--fg:#ebe9e4;--mute:#a7a49d;--rule:#33312d;--accent:#ff5a6e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:46rem;margin:0 auto;padding:2.5rem 1rem 4rem}
h1{font-size:2rem;margin:0 0 .25rem;letter-spacing:-.01em}h2{font-size:1.2rem;margin:2.2rem 0 .5rem;padding-top:1rem;border-top:1px solid var(--rule)}
h3{font-size:1rem;margin:1.2rem 0 .3rem}p,li{margin:.4rem 0}ul{padding-left:1.25rem}
.sub{color:var(--mute);margin:0 0 1.5rem}a{color:var(--accent)}table{border-collapse:collapse;width:100%;font-size:.95rem}
td,th{text-align:left;vertical-align:top;padding:.35rem .5rem;border-bottom:1px solid var(--rule)}th{font-weight:600}
.back{display:inline-block;margin-bottom:1.5rem;text-decoration:none}
</style></head>
<body><main>
<a class="back" href="/">← OverLyX</a>
<h1>Privacy notice</h1>
<p class="sub">Last updated ${PRIVACY_UPDATED}. This page says what ${esc(site)} keeps about you, who else sees it, how long it stays, and how to get rid of it. It is a beta: if anything here is unclear or wrong, please tell us.</p>

<h2>Who runs OverLyX</h2>
<p>OverLyX at ${esc(site)} is run by ${who}, who decides how your data is used (the “controller” in data-protection law). You can reach them ${reach}.</p>
<p>The server is rented from Hetzner Online GmbH and stands in their data centre in Falkenstein, Germany. Your documents are stored there.</p>

<h2>What we keep about you</h2>
<h3>Your account</h3>
${google
    ? '<p>When you sign in with Google we receive and keep your name, e-mail address, profile picture and Google account id. We derive a user name from your e-mail address and give you a colour (both show next to your edits). We also keep your settings and keyboard shortcuts.</p>'
    : '<p>Your account was set up by the operator: we keep your name, user name, e-mail address if one was given, a scrambled form of your password (never the password itself) and a colour that shows next to your edits. We also keep your settings and keyboard shortcuts.</p>'}
<p>If you open a share link without signing in, you get a temporary guest account with a random name (“Anonymous Otter”). It is deleted about a month later, or its access moves to your account when you sign in.</p>
<h3>Your projects</h3>
<p>Everything you put into a project stays on the server: files, uploaded images, the PDFs we build, comments, tracked changes and earlier versions. Every project has a version history (a git repository). OverLyX commits your changes to it after a few minutes of editing, with your name and e-mail address as the author.</p>
<h3>The project's activity log</h3>
<p>For each project we note who opened a document, built a PDF, pulled or pushed with git, or changed the sharing. Only the project's owner sees this log. Entries are deleted after 90 days.</p>
<h3>Problem reports</h3>
<p>What you send with <b>Help ▸ Report a problem</b> is stored on this server and only the operator reads it. We never publish it. It contains your text, your account, the app version and your browser, plus the document name and the last error message only if you tick those boxes.</p>
<p>Errors the app runs into are recorded the same way, automatically, with your account attached. They contain the error message, where in the code it happened, the app version and your browser. They never contain the content of your documents. An error record is deleted 90 days after the error last happened. Your own reports are deleted when you delete your account.</p>
<p>The OverLyX extension for VS Code reports its errors in the same way when VS Code's telemetry is on. These reports carry no account and no file names.</p>
<p>At VS Code telemetry level <b>All</b>, the extension can also send anonymous usage categories from its editor, PDF and slide/poster views and native commands, saves, builds, synchronization and agent handoffs. This requires <b>overlyx.usageStatistics</b>, which you can switch off in VS Code Settings; error/crash-only telemetry levels send no usage. Reports contain release versions, coarse OS/architecture and local/remote/desktop/web categories, action/outcome/state categories and bounded timings, with random IDs for an activation or webview load. They include no document or clipboard content, file or workspace paths, host names, account details or persistent machine ID. Disabling collection discards queued events and updates open views immediately. Detailed events are retained for ${RELIABILITY_RETENTION_DAYS} days and ordinary action statistics for ${USAGE_DAYS} days, under the anonymous usage policy below.</p>
<h3>Mail to us</h3>
<p>Mail you send to privacy@ or contact@${esc(site)} is received by this server and kept there; it is never forwarded to anyone's inbox. Only the operator reads it, in the app. It contains what you wrote, your address and the subject; attachments are not kept (only their names). It is deleted a year after it arrived.</p>
<h3>Anonymous usage statistics</h3>
<p>To find what is confusing or broken, the app counts which menu items, buttons and shortcuts are used and which ones fail. These counts are not linked to you. They carry no name, account, document or file name and no text, only a random id that changes with each page load. They are kept for ${USAGE_DAYS} days.</p>
<p>Detailed interaction diagnostics use fixed categories for clicks, context menus, drag/drop, paste/cut and deletion outcomes, selection type, empty/filled and collapsed/margin notes, editing permissions, change tracking, pointer type, API outcomes, connectivity, resource errors and duration buckets. Administrators can examine short action trails around failures, unchanged or repeated attempts and undo. No typed text, clipboard contents, input values, coordinates, URLs, document identifiers or account identifiers are included. These detailed events are kept for ${RELIABILITY_RETENTION_DAYS} days and follow the same usage-statistics switch.</p>
<p>Separate reliability diagnostics are sent only if you give separate consent. They count a fixed list of events and pointer types, coarse contexts and duration buckets — never document text, account details, URLs, coordinates, or free text. They use the same short-lived random page-load id and are kept for ${RELIABILITY_RETENTION_DAYS} days. They are not sent when usage statistics are switched off or your browser sends Global Privacy Control.</p>
<p>You can switch them off in <b>Settings ▸ Privacy</b>. Your browser's Global Privacy Control signal also switches them off.</p>
<h3>Server logs</h3>
<p>The server's logs record events such as “user X opened project Y” or “a build failed”, together with user names and project or file names. For requests that fail, they also record the IP address and browser. The logs help us keep the service running and secure. They are deleted automatically, oldest first, once they reach a fixed size — currently after a few months.</p>
<h3>In your browser</h3>
<p>We set one sign-in cookie (<code>ol_session</code>, valid for 30 days)${google ? ', and short-lived ones (10 minutes) while you sign in with Google or connect Google Drive' : ''}. There are no advertising or tracking cookies.</p>
<p>The app keeps your preferences in your browser. It also keeps copies of the documents you opened there, so it can work offline and reconnect without losing edits. <b>Sign out</b> removes those copies.</p>

<h2>Who else sees your data</h2>
<ul>
<li><b>People you share a project with</b> see your name, user name, picture and colour, and where your cursor is while you are both in a document. They also see your edits, comments, tracked changes, the version history (including the author e-mail addresses in its git commits) and the conversations with the Agent panel in that project.</li>
<li><b>Anyone with a link</b>: if you turn on a share link or a public PDF link, anyone who has the link can open the project or download the PDF. You can turn the link off at any time.</li>
<li><b>The operator and administrators</b> have technical access to the server and can see the list of accounts and projects. To help with a problem, an administrator can give themselves temporary access to a project. Every such access is recorded in the project's activity log, so its owner sees it.</li>
</ul>
<h3>Services we use</h3>
<table>
<tr><th>Service</th><th>What it gets</th><th>When</th></tr>
<tr><td>Hetzner (Germany)</td><td>Hosts the server, so it stores everything above</td><td>Always</td></tr>
${google ? `<tr><td>Google</td><td>Signs you in. With Google Docs sync, the linked document's text and comments go to that Google Doc</td><td>When you sign in; Docs sync only if you connect Google Drive and link a document</td></tr>` : ''}
<tr><td>GitHub (USA)</td><td>A backup copy of every project's version history, in private repositories that only the operator can access, updated every few minutes</td><td>Always. A project's owner can pause it in the project's <b>Git</b> dialog</td></tr>
<tr><td>OpenRouter (USA), and the AI company whose model is used (Google by default; also Anthropic, OpenAI and others you can choose)</td><td>The text around your cursor or your selection, your instruction, and your document's LaTeX source as context. “Escalate to AI” for a document that will not build sends the whole <code>.tex</code> file. Writing a formula with the math keyboard’s pen sends a picture of the handwriting and the formula around the cursor. No account details</td><td>Only when you use an AI feature. All AI features are off until you switch them on in Settings</td></tr>
<tr><td>OpenAI, through your own ChatGPT account</td><td>What the Agent panel's agent reads and writes in the project you give it. Its sign-in and conversations are stored on our server in your account's folder</td><td>Only if you use the Agent panel and sign in to ChatGPT there</td></tr>
<tr><td>AI apps you connect (e.g. Claude Code, ChatGPT)</td><td>Whatever you let them read or change through the sign-in you give them</td><td>Only if you connect one</td></tr>
<tr><td>Google Fonts (fonts.googleapis.com, fonts.gstatic.com)</td><td>The name of a font a markdown document asks for, the first time any document does (the files are kept on this server and served from here: your browser does not contact Google)</td><td>When a document names a font this server does not have</td></tr>
<tr><td>OpenAlex, DBLP, doi.org (Crossref, DataCite), arXiv, OpenReview, bioRxiv, PubMed (NCBI), the ACL Anthology, HAL, Semantic Scholar, Open Library, and SerpApi where enabled</td><td>The words you search for when you look up a citation, and the DOIs, arXiv ids and other identifiers you enter</td><td>When you search for literature</td></tr>
<tr><td>The website of a paper link you paste into the citation search</td><td>A request for that page from our server, to read the paper's title, authors and DOI. It does not get your IP address or account</td><td>Only when you paste such a link</td></tr>
<tr><td>Zotero (Corporation for Digital Scholarship, USA)</td><td>Your Zotero API key and the words you search for, to find the matching items in your Zotero library and its groups. We keep the key, encrypted, until you disconnect Zotero or delete your account; we never write to your library</td><td>Only if you connect Zotero (Settings ▸ Account)</td></tr>
<tr><td>Google Fonts and other font or script hosts</td><td>Slides, posters and web pages can load fonts or libraries from these services. The browser of whoever views them then contacts the service, which sees that viewer's IP address</td><td>When you view a slide deck, poster or page that uses them</td></tr>
</table>
<p>Some of these companies process data in the USA, under their standard data-protection terms (such as the EU–US Data Privacy Framework or the EU's standard contractual clauses). We do not sell your data, and we do not use it for advertising.</p>

<h2>Why we may do this</h2>
<ul>
<li><b>To provide the service you signed up for</b> (contract): your account, your projects, sharing, building PDFs and the backups that protect your work.</li>
<li><b>Our legitimate interests</b>: keeping the service secure, finding and fixing errors (error reports, logs) and improving it (anonymous statistics). You can object, see <a href="#rights">your rights</a>.</li>
<li><b>Your consent</b> for the optional features you switch on: the AI features, Google Drive, Zotero, the Agent panel and connected AI apps. Switching them off withdraws it.</li>
</ul>

<h2>How long we keep it</h2>
<table>
<tr><td>Your account and your projects</td><td>Until you delete them</td></tr>
<tr><td>Deleted projects and files</td><td>${TRASH_DAYS} days in the trash, in case you deleted something by mistake (ask the operator to restore it). After that they are erased, together with their GitHub backup</td></tr>
<tr><td>Nightly backups on the server</td><td>14 days</td></tr>
<tr><td>Activity log, error records</td><td>90 days</td></tr>
<tr><td>Mail to privacy@ / contact@</td><td>A year</td></tr>
<tr><td>Server logs</td><td>A few months (deleted oldest first at a fixed size)</td></tr>
<tr><td>Anonymous usage statistics</td><td>${USAGE_DAYS} days</td></tr>
<tr><td>Consent-only reliability diagnostics</td><td>${RELIABILITY_RETENTION_DAYS} days</td></tr>
<tr><td>Guest accounts</td><td>About a month</td></tr>
</table>

<h2 id="delete">Deleting your account</h2>
<p><b>Settings ▸ Account ▸ Delete account</b> deletes your account immediately, after you confirm with your user name. The following are deleted at the same time:</p>
<ul>
<li>the projects you own, including their history, trash copies and GitHub backups. If you shared them, they are gone for the other people too, so the dialog lists them first; you can make someone else the owner in the project's Share dialog instead;</li>
<li>your access to other people's projects, your sign-ins (git, AI apps), the Agent panel's ChatGPT sign-in and conversations, your Google Drive connection, your problem reports and your settings.</li>
</ul>
<p>What you wrote in other people's projects stays there, because it is part of their documents. So do your name in their history and comments. The activity log and error records keep their entries, but those no longer point to you. The nightly backups still contain your account until they are replaced, after at most 14 days.</p>
<p>To keep your work, download each project first: the project's menu has <b>Download as .zip</b>.</p>

<h2 id="rights">Your rights</h2>
<p>Under the GDPR (and the UK GDPR) you can ask for a copy of the data we hold about you and have it corrected. You can have it deleted, take it with you, restrict or object to how we use it, and withdraw your consent. Write to the operator (see above). We answer within one month.</p>
<p>You can also complain to a data-protection authority: the one where you live (in the UK, the Information Commissioner's Office, <a href="https://ico.org.uk/make-a-complaint/">ico.org.uk</a>), or the one where our server is (Germany).</p>

<h2>Changes</h2>
<p>When OverLyX starts handling data differently, this page changes first and its date above moves.</p>
</main></body></html>`;
}

export function privacyPage(_req: Request, res: Response): void {
  res.type('html').set('Cache-Control', 'no-cache').send(privacyHtml());
}
