import { vscode } from './globals';

/** a globe (the web), drawn like the theme switch's icons */
const GLOBE = <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.6 2.5 3.9 5.5 3.9 9s-1.3 6.5-3.9 9M12 3c-2.6 2.5-3.9 5.5-3.9 9s1.3 6.5 3.9 9" /></svg>;

/**
 * "Open in browser": the file on overlyx.app, where its folder is synced with a project (host/sync.ts).
 * VS Code's editor title has the same as a globe, easy to miss among VS Code's own buttons and gone
 * when the title bar's actions are hidden. `link()` says the address, with the place (the cursor's
 * paragraph, the slide shown); the host opens it after checking it is the synced project's server.
 */
export function OpenOnWeb({ link, message }: { link: () => string | null; message: 'openOnWeb' | 'dlOpenOnWeb' }) {
  return <button type="button" class="small-btn open-on-web" title="Open on overlyx.app — this file in the browser, where you are in it"
    onClick={() => { const url = link(); if (url) vscode.postMessage({ type: message, url }); }}>{GLOBE}<span>Open in browser</span></button>;
}
