/**
 * Coming in through a share link without an account. First the invitation (ShareInvite): somebody
 * opened a share link without a session, and before anything is created the page asks how to come
 * in — with an account, or without one as a guest — with the difference in three lines each. A guest
 * may give a name ("Ada (guest)"), else they are "Anonymous Otter". Then, for a guest, the callout (GuestCallout): it hangs under the Sign in button (top
 * right) and suggests signing in with Google to keep the project — the guest's memberships move to
 * the account (server: access.ts adoptGuest) and the document reopens there. Dismissed for the
 * session; the Sign in button stays.
 */
import { useState } from 'preact/hooks';
import { googleSignInUrl, type Project, type User, type api } from '../api';
import { GoogleG } from './Login';
import { Wordmark } from './Logo';
import { projectTitle } from './Home';
import { projectShortName } from '@overlyx/core';

const DISMISS_KEY = 'ol.guestHint';
/** the name a guest gave last time in this browser, offered again on the next invitation */
const NAME_KEY = 'ol.guestName';

/** no callout this session: the visitor chose to come in as a guest a moment ago, knowing the difference */
function dismissGuestHint() { try { sessionStorage.setItem(DISMISS_KEY, '1'); } catch { /* ignore */ } }

export type SharePreview = Awaited<ReturnType<typeof api.sharePreview>>;

export function ShareInvite({ invite, google, onGuest, onSignIn }: {
  invite: SharePreview; google: boolean;
  /** come in as a guest, under `name` or anonymously (''): the workspace opens, or it rejects with what went wrong */
  onGuest: (name: string) => Promise<void>;
  /** the sign-in page (no Google here, or a username and password) */
  onSignIn: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [name, setName] = useState(() => { try { return localStorage.getItem(NAME_KEY) ?? ''; } catch { return ''; } });
  const title = invite.title ?? projectShortName(invite.project);
  const verb = invite.role === 'view' ? 'view' : 'edit';
  const guest = async () => {
    setBusy(true); setErr('');
    const n = name.trim();
    try { localStorage.setItem(NAME_KEY, n); } catch { /* ignore */ }
    try { dismissGuestHint(); await onGuest(n); }
    catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return (
    <div class="login lp invite" data-share-invite>
      <main class="invite-page">
        <div class="invite-mark"><Wordmark bauhaus /></div>
        <h1>{invite.owner ? `${invite.owner} invited you to ${verb}` : `You’re invited to ${verb}`} <span class="invite-title">“{title}”</span></h1>
        <p class="invite-lede">LaTeX documents, slides and posters, edited and rendered in the same place.</p>
        <div class="invite-options">
          <section class="invite-option account" data-invite-account>
            <h2>Join with your account</h2>
            <ul>
              <li>{verb === 'edit' ? 'Your edits and comments carry your name' : 'Others see you under your name'}</li>
              <li>The project stays on your start screen, on any device</li>
              <li>{google ? 'Free, with a new or existing Google account' : 'With the account you have here'}</li>
            </ul>
            {google
              ? <a class="google" href={googleSignInUrl()} data-google-login><GoogleG /><span>Continue with Google</span></a>
              : <button type="button" class="invite-key" data-invite-signin onClick={onSignIn}>Sign in</button>}
          </section>
          {invite.guests && (
            <section class="invite-option guest" data-invite-guest>
              <h2>Continue without an account</h2>
              <ul>
                <li>Opens right away, nothing to sign up for</li>
                <li>Others see the name you give, or “Anonymous Otter”</li>
                <li>Only in this browser; sign in later to keep the project</li>
              </ul>
              <label class="invite-name">
                <span>Your name <i>(optional)</i></span>
                <input type="text" autocomplete="name" maxLength={60} placeholder="Anonymous" value={name} data-invite-guest-name
                  onInput={e => setName((e.target as HTMLInputElement).value)} onKeyDown={e => { if (e.key === 'Enter' && !busy) void guest(); }} />
              </label>
              <button type="button" class="invite-key outline" disabled={busy} data-invite-guest-go onClick={() => void guest()}>{busy ? 'Opening…' : 'Continue as a guest'}</button>
            </section>
          )}
        </div>
        {err && <p class="err" role="alert">{err}</p>}
        <p class="invite-foot">
          {google && <><button type="button" class="fallback-link" data-password-login onClick={onSignIn}>I have a username and password</button> · </>}
          <a href="/terms" target="_blank" rel="noopener">Terms of use</a> · <a href="/privacy" target="_blank" rel="noopener">Privacy notice</a>
        </p>
      </main>
    </div>
  );
}

export function GuestCallout({ user, project, google, onSignIn }: { user: User; project: Project | null; google: boolean; onSignIn: () => void }) {
  const [hidden, setHidden] = useState(() => { try { return sessionStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; } });
  if (hidden) return null;
  const dismiss = () => { setHidden(true); dismissGuestHint(); };
  const what = project ? `“${projectTitle(project)}”` : 'this project';
  const verb = project?.role === 'view' ? 'read' : 'edit';
  return (
    <div class="guest-callout" role="dialog" aria-label="Sign in to keep this project" data-guest-callout>
      <div class="guest-head">
        <h3>You're in as a guest</h3>
        <button type="button" class="tour-close" title="Not now" onClick={dismiss}>✕</button>
      </div>
      {project?.via === 'public'
        ? <p>{what} is public: you are reading it as <b>{user.name}</b>. Sign in to keep it on your start screen.</p>
        : <p>The link lets you {verb} {what} as <b>{user.name}</b>. Sign in to keep it in your account: it will be on your start screen, and your edits will carry your name.</p>}
      {google
        ? <a class="google" href={googleSignInUrl()} data-google-login><GoogleG /><span>Continue with Google</span></a>
        : <button type="button" class="btn primary" data-guest-signin onClick={onSignIn}>Sign in</button>}
      <button type="button" class="later" data-guest-later onClick={dismiss}>Not now</button>
    </div>
  );
}
