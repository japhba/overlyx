/**
 * Your OverLyX account's settings in the VS Code editors, as in the browser (client
 * app/accountprefs.ts: the editor's fonts, text styles, spell checking …): the bridge (bridge.ts)
 * answers the webviews' /api/prefs from the OverLyX server this computer is signed in to (fonts.ts
 * signedInAccount: the CLI's and the extension's sign-in, overlyx.app first), through its git API
 * (server git.ts). `/api/prefs/account` tells a webview whether to follow the account and whose
 * (webview/accountPrefs.ts); `/api/prefs/signin` runs OverLyX: Sign In…. With
 * `overlyx.accountSettings` off, or signed in nowhere, the editors keep settings of their own.
 */
import { signedInAccount, type SignedIn } from './fonts.ts';

export interface PrefsResponse { status: number; type: string; body: string }
const json = (status: number, v: unknown): PrefsResponse => ({ status, type: 'application/json; charset=utf-8', body: JSON.stringify(v) });

export function accountPrefsService(opts: {
  /** `overlyx.accountSettings` */
  enabled: () => boolean;
  /** OverLyX: Sign In… (resolves when it is done or dismissed) */
  signIn: () => PromiseLike<unknown>;
  /** the server and sign-in (tests give their own) */
  who?: (fresh: boolean) => Promise<SignedIn | null>;
}): (method: string, sub: '' | 'account' | 'signin', body?: unknown) => Promise<PrefsResponse> {
  const who = opts.who ?? signedInAccount;
  const accountJson = async () => {
    const enabled = opts.enabled();
    const a = enabled ? await who(true) : null;
    return json(200, { enabled, account: a ? { host: a.host, username: a.username } : null });
  };
  return async (method, sub, body) => {
    if (sub === 'account') return accountJson();
    if (sub === 'signin') {
      if (method !== 'POST') return json(405, { error: 'not allowed' });
      try { await opts.signIn(); } catch { /* dismissed */ }
      return accountJson();
    }
    if (method !== 'GET' && method !== 'PUT') return json(405, { error: 'not allowed' });
    if (!opts.enabled()) return json(403, { error: 'The setting overlyx.accountSettings is off' });
    const a = await who(false);
    if (!a) return json(401, { error: 'Sign in to OverLyX (OverLyX: Sign In…) to use your account’s settings' });
    try {
      const put = method === 'PUT';
      const r = await fetch(`${a.host}/git/api/prefs`, {
        method,
        headers: { Authorization: a.authorization, ...(put ? { 'content-type': 'application/json' } : {}) },
        ...(put ? { body: JSON.stringify(body ?? {}) } : {}),
        signal: AbortSignal.timeout(20000),
      });
      const text = await r.text();
      // (a server without the route answers with git's text: no settings there)
      return r.ok || (r.headers.get('content-type') ?? '').includes('json') ? { status: r.status, type: 'application/json; charset=utf-8', body: text } : json(r.status, { error: text.trim().slice(0, 200) || 'The OverLyX server refused' });
    } catch {
      return json(503, { error: 'The OverLyX server does not answer' });
    }
  };
}
