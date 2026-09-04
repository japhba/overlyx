/**
 * The guest callout: somebody opened a share link without an account and is in the document as
 * "Anonymous Otter". It hangs under the Sign in button (top right) and suggests signing in with
 * Google to keep the project — the guest's memberships move to the account (server: access.ts
 * adoptGuest) and the document reopens there. Dismissed for the session; the Sign in button stays.
 */
import { useState } from 'preact/hooks';
import { googleSignInUrl, type Project, type User } from '../api';
import { GoogleG } from './Login';
import { projectTitle } from './Home';

const DISMISS_KEY = 'ol.guestHint';

export function GuestCallout({ user, project, google, onSignIn }: { user: User; project: Project | null; google: boolean; onSignIn: () => void }) {
  const [hidden, setHidden] = useState(() => { try { return sessionStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; } });
  if (hidden) return null;
  const dismiss = () => { setHidden(true); try { sessionStorage.setItem(DISMISS_KEY, '1'); } catch { /* ignore */ } };
  const what = project ? `“${projectTitle(project)}”` : 'this project';
  const verb = project?.role === 'view' ? 'read' : 'edit';
  return (
    <div class="guest-callout" role="dialog" aria-label="Sign in to keep this project" data-guest-callout>
      <div class="guest-head">
        <h3>You're in as a guest</h3>
        <button type="button" class="tour-close" title="Not now" onClick={dismiss}>✕</button>
      </div>
      <p>The link lets you {verb} {what} as <b>{user.name}</b>. Sign in to keep it in your account: it will be on your start screen, and your edits will carry your name.</p>
      {google
        ? <a class="google" href={googleSignInUrl()} data-google-login><GoogleG /><span>Continue with Google</span></a>
        : <button type="button" class="btn primary" data-guest-signin onClick={onSignIn}>Sign in</button>}
      <button type="button" class="later" data-guest-later onClick={dismiss}>Not now</button>
    </div>
  );
}
