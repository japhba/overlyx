/**
 * Your OverLyX account's settings in this editor, as in the browser (client app/accountprefs.ts:
 * fonts, text styles, spell checking …), when VS Code is signed in to OverLyX and
 * `overlyx.accountSettings` is on (host/accountprefs.ts answers through the bridge). Looked at when
 * the editor starts and again when it gets the focus (a sign-in or sign-out meanwhile). VS Code
 * decides its theme and telemetry itself, and the AI switches do nothing here: those stay out.
 */
import { useEffect, useState } from 'preact/hooks';
import { startAccountPrefs } from '@client/app/accountprefs';
import { G } from './globals';

export interface AccountState {
  /** `overlyx.accountSettings` */
  enabled: boolean;
  /** whose settings this editor follows (null: its own) */
  account: { host: string; username: string } | null;
}

/** keys of the client's SYNCED_LABELS that VS Code keeps for itself */
const EXCLUDE = [
  'ls.ol.theme', 'pref.usageStats', 'pref.betaDiagnostics',
  'pref.aiButton', 'pref.aiRewrite', 'pref.aiCompleteText', 'pref.aiCompleteMath', 'pref.aiCompleteDelay', 'pref.aiModel', 'pref.aiCompletionModel', 'pref.aiInk',
];

let state: AccountState = { enabled: true, account: null };
const listeners = new Set<() => void>();
let running: { key: string; stop: () => void } | null = null;

/** a number for the account (the client's sync state is kept per account id) */
function idOf(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 1) || 1;
}

function take(v: { enabled?: unknown; account?: { host?: unknown; username?: unknown } | null }): void {
  const a = v.account && typeof v.account.host === 'string' && typeof v.account.username === 'string' ? { host: v.account.host, username: v.account.username } : null;
  const key = a ? a.host + '|' + a.username : '';
  if (key !== (running?.key ?? '')) {
    running?.stop();
    running = key ? { key, stop: startAccountPrefs(idOf(key), { exclude: EXCLUDE }) } : null;
  }
  state = { enabled: v.enabled !== false, account: a };
  for (const l of listeners) { try { l(); } catch { /* ignore */ } }
}

async function check(): Promise<void> {
  try {
    const r = await fetch(`${G.base}/api/prefs/account`);
    if (r.ok) take(await r.json());
  } catch { /* the bridge is gone: the window is closing */ }
}

/** Follow the account's settings while VS Code is signed in (editorMain.tsx, once). */
export function followAccountPrefs(): void {
  void check();
  let last = Date.now();
  window.addEventListener('focus', () => { if (Date.now() - last > 3000) { last = Date.now(); void check(); } });
}

/** OverLyX: Sign In…, then follow the account it signed in to */
export async function signInForPrefs(): Promise<void> {
  try {
    const r = await fetch(`${G.base}/api/prefs/signin`, { method: 'POST' });
    if (r.ok) take(await r.json());
  } catch { /* ignore */ }
}

export function useAccountState(): AccountState {
  const [s, set] = useState(state);
  useEffect(() => { const l = () => set(state); listeners.add(l); l(); return () => { listeners.delete(l); }; }, []);
  return s;
}
