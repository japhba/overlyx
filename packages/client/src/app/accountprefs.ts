/**
 * A person's preferences follow their account to every device (server accountprefs.ts, `/api/prefs`):
 * the editor's settings (prefs.ts — fonts, text styles, spell checking, the AI switches …) except
 * the few that depend on the device (DEVICE_PREF_KEYS), and a few things other modules keep in
 * localStorage (SYNCED_STORAGE: the theme, recent colours and fonts).
 * Settings ▸ This device (DeviceSettings.tsx) shows what stays on the device, and lets a setting be
 * kept "on this device only".
 *
 * Each setting is its own key with the time it was chosen; the newer choice wins, per key.
 *
 * The first sync of a browser (no `ol.prefsSync` yet): the account's values win — a device that has
 * not synced yet is the stale one. Where the account has no value, what this browser had chosen
 * (not the defaults) goes up, but only if no other device put one there in the meantime (`onlyNew`)
 * — so the first device to sign in after the change brings its settings along, and nobody's are
 * overwritten by a browser that comes later. A browser that synced for another account adopts but
 * never uploads (its values are that person's).
 *
 * After that: a change here goes up at once (a prefs change) or within seconds (the localStorage
 * keys); the account's values are fetched again when the window comes back into focus.
 * The VS Code extension's editors too, when VS Code is signed in to OverLyX (vscode
 * webview/accountPrefs.ts, through the extension's bridge): without the keys VS Code decides itself
 * (`exclude` — its theme, its telemetry setting).
 */
import { api, type AccountPrefs } from '../api';
import { getUserPrefs, adoptUserPrefs, subscribePrefs, DEFAULT_PREFS, DEVICE_PREF_KEYS, type Prefs } from '../prefs';
import { setThemePref } from './theme';

/** localStorage keys other modules keep, kept whole with the account */
// (not the personal dictionary yet: the spell checker keeps its words in memory and would write back
// a list without the words another device added)
export const SYNCED_STORAGE = ['ol.theme', 'ol.customColors', 'ol.recentFonts'] as const;
const STATE_KEY = 'ol.prefsSync';
const DEVICE_ONLY_KEY = 'ol.deviceOnly';
/** flags that belong to a setting: kept on the device with it */
const FOLLOWS: Record<string, string> = { 'pref.editorFontChosen': 'pref.editorFont', 'pref.autoCorrectChosen': 'pref.autoCorrect' };

/** what Settings ▸ This device calls each setting that follows the account */
export const SYNCED_LABELS: Record<string, string> = {
  'pref.editorFont': 'Editor text font', 'pref.editorMathFont': 'Editor math font', 'pref.screenStyles': 'Text styles in my editor',
  'pref.spellcheck': 'Spell checking', 'pref.spellEngine': 'Spell checker', 'pref.autoCorrect': 'Autocorrect typos',
  'pref.selectionBar': 'Quick menu over selected words',
  'pref.showResolvedComments': 'Resolved comments in the text', 'pref.autoBuild': 'Build the PDF automatically', 'pref.autoBuildDelay': 'Wait before building',
  'pref.shortcutTips': 'Shortcut tips', 'ls.ol.theme': 'Theme', 'pref.darkPages': 'Smart invert of pages', 'pref.invertFigures': 'Smart invert of figures',
  'pref.darkTone': 'Text tone of the dark theme', 'ls.ol.customColors': 'Custom colours', 'ls.ol.recentFonts': 'Recently used fonts',
  'pref.aiButton': 'The ✦ AI button', 'pref.aiRewrite': 'Rewrite with AI', 'pref.aiCompleteText': 'Autocomplete text', 'pref.aiCompleteMath': 'Autocomplete formulas',
  'pref.aiCompleteDelay': 'Pause before suggesting', 'pref.aiModel': 'Rewrite model', 'pref.aiCompletionModel': 'Autocomplete model',
  'pref.aiInk': 'Read handwritten formulas', 'pref.speechEngine': 'Spoken comments put into words by',
  'pref.usageStats': 'Anonymous usage statistics', 'pref.betaDiagnostics': 'Beta reliability diagnostics',
};

interface SyncState {
  user: number;
  /** each key's value as last agreed with the account (JSON) and the account's time for it */
  values: Record<string, string>; at: Record<string, number>;
  /** when the account was last reached */
  syncedAt?: number;
}

const readJson = <T,>(key: string): T | null => { try { const v = JSON.parse(localStorage.getItem(key) ?? 'null'); return v && typeof v === 'object' ? v as T : null; } catch { return null; } };
const writeJson = (key: string, v: unknown) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private window: this session only */ } };

/* ------------------------------------------------------------ on this device only */

let deviceOnlySet = new Set<string>(readJson<string[]>(DEVICE_ONLY_KEY) ?? []);
/** keys this shell never syncs (startAccountPrefs `exclude`) */
let excluded = new Set<string>();
/** whether a key of SYNCED_LABELS follows the account here at all */
export const followsAccount = (key: string): boolean => !excluded.has(key);
const listeners = new Set<() => void>();
const changed = () => { for (const l of listeners) { try { l(); } catch { /* ignore */ } } };
export function subscribeAccountPrefs(l: () => void): () => void { listeners.add(l); return () => { listeners.delete(l); }; }

/** settings kept on this device only (keys of SYNCED_LABELS) */
export function deviceOnly(): ReadonlySet<string> { return deviceOnlySet; }
const isDeviceOnly = (key: string) => deviceOnlySet.has(FOLLOWS[key] ?? key) || excluded.has(FOLLOWS[key] ?? key);

/** Keep a setting on this device only, or let it follow the account again (it takes the account's value then). */
export function setDeviceOnly(key: string, on: boolean): void {
  const next = new Set(deviceOnlySet);
  if (on) next.add(key); else next.delete(key);
  deviceOnlySet = next;
  writeJson(DEVICE_ONLY_KEY, [...next]);
  if (!on && state) {
    // the account's value wins when it comes back: this device's is not sent (agreed as it is), and any time of the account's is newer
    const mine = snapshot();
    for (const k of [key, ...Object.keys(FOLLOWS).filter(f => FOLLOWS[f] === key)]) { if (k in mine) state.values[k] = mine[k]; delete state.at[k]; delete pendingAt[k]; }
    saveState();
    void sync();
  }
  changed();
}

/* ------------------------------------------------------------ what is synced */

const prefKeys = (): (keyof Prefs)[] => [...new Set([...Object.keys(DEFAULT_PREFS), 'editorFontChosen', 'autoCorrectChosen'] as (keyof Prefs)[])]
  .filter(k => !(DEVICE_PREF_KEYS as readonly string[]).includes(k));

/** this browser's value of every synced key, as JSON */
export function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  const p = getUserPrefs();
  for (const k of prefKeys()) if (!isDeviceOnly('pref.' + k)) out['pref.' + k] = JSON.stringify(p[k] ?? null);
  for (const k of SYNCED_STORAGE) {
    if (isDeviceOnly('ls.' + k)) continue;
    let v: string | null = null;
    try { v = localStorage.getItem(k); } catch { /* none */ }
    out['ls.' + k] = JSON.stringify(v);
  }
  return out;
}

/** the value one gets without choosing (not uploaded by a browser's first sync) */
export function isDefault(key: string, json: string): boolean {
  if (key.startsWith('pref.')) return json === JSON.stringify((DEFAULT_PREFS as unknown as Record<string, unknown>)[key.slice(5)] ?? null);
  return json === 'null';
}

/** put the account's values into this browser */
function apply(values: Record<string, unknown>): void {
  const patch: Partial<Prefs> = {};
  for (const [key, value] of Object.entries(values)) {
    if (key.startsWith('pref.')) {
      const k = key.slice(5) as keyof Prefs;
      (patch as Record<string, unknown>)[k] = value === null ? (DEFAULT_PREFS as unknown as Record<string, unknown>)[k] : value;
    } else if (key === 'ls.ol.theme') {
      setThemePref(value === 'light' || value === 'dark' ? value : 'system');
    } else if (key.startsWith('ls.')) {
      try { if (value === null) localStorage.removeItem(key.slice(3)); else localStorage.setItem(key.slice(3), String(value)); } catch { /* private window */ }
    }
  }
  if (Object.keys(patch).length) adoptUserPrefs(patch);
}

/* ------------------------------------------------------------ the sync */

let state: SyncState | null = null;
let userId = 0;
let running: Promise<void> | null = null;
let again = false;
/** when each key changed here and has not gone up yet (this browser's clock) */
const pendingAt: Record<string, number> = {};
let lastError = '';

const saveState = () => { if (state) writeJson(STATE_KEY, state); };
export function syncStatus(): { at: number | null; error: string } { return { at: state?.syncedAt ?? null, error: lastError }; }

/** Take the account's values that are newer than what this browser agreed on last. */
function adopt(server: AccountPrefs, mine: Record<string, string>): void {
  if (!state) return;
  const take: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(server)) {
    if (!(key in mine) || isDeviceOnly(key)) continue;   // unknown here, or kept on this device
    const json = JSON.stringify(entry.value ?? null);
    // only what changed on the account since (a value agreed on stays; a change made here meanwhile stays unless the account's is newer)
    if (state.at[key] !== undefined && entry.at <= state.at[key]) continue;
    if (pendingAt[key] && entry.at < pendingAt[key]) continue;
    state.values[key] = json; state.at[key] = entry.at;
    if (json !== mine[key]) take[key] = entry.value ?? null;
  }
  saveState();
  apply(take);
}

async function run(): Promise<void> {
  const stored = readJson<SyncState>(STATE_KEY);
  if (!state) {
    // the first sync of this browser (for this account)
    const server = (await api.accountPrefs()).prefs;
    const mine = snapshot();
    const up: AccountPrefs = {};
    if (!stored) for (const [key, json] of Object.entries(mine)) if (!(key in server) && !isDefault(key, json)) up[key] = { value: JSON.parse(json), at: Date.now() };
    const after = Object.keys(up).length ? (await api.setAccountPrefs(up, true)).prefs : server;
    state = { user: userId, values: {}, at: {} };
    adopt(after, mine);
    // what neither side had chosen counts as agreed
    for (const [key, json] of Object.entries(mine)) if (!(key in state.values)) state.values[key] = json;
  } else {
    // what changed here since goes up (the account keeps the newer choice), then the account's newer values come down
    const mine = snapshot();
    const up: AccountPrefs = {};
    // (a key this browser has not agreed on yet — new in this version — is not a change made here: the account's is taken, else this one agreed)
    for (const [key, json] of Object.entries(mine)) if (key in state.values && state.values[key] !== json) up[key] = { value: JSON.parse(json), at: pendingAt[key] ?? Date.now() };
    const server = Object.keys(up).length ? (await api.setAccountPrefs(up)).prefs : (await api.accountPrefs()).prefs;
    for (const key of Object.keys(up)) delete pendingAt[key];
    // what went up and was kept is agreed; what the account had newer is taken
    for (const key of Object.keys(up)) if (server[key] && JSON.stringify(server[key].value ?? null) === mine[key]) { state.values[key] = mine[key]; state.at[key] = server[key].at; }
    const now = snapshot();
    adopt(server, now);
    for (const [key, json] of Object.entries(now)) if (!(key in state.values)) state.values[key] = json;
  }
  state.syncedAt = Date.now();
  saveState();
}

/** sync now (once at a time; a request meanwhile runs once more after it) */
export function sync(): Promise<void> {
  if (!userId) return Promise.resolve();
  if (running) { again = true; return running; }
  running = run().then(() => { lastError = ''; }, e => { lastError = (e as Error).message || 'offline'; }).finally(() => {
    running = null;
    changed();
    if (again) { again = false; void sync(); }
  });
  return running;
}

let stop: (() => void) | null = null;
/**
 * After sign-in (not for guests): sync the account's preferences, and keep them in step. Gives a stop
 * function. `exclude`: keys of SYNCED_LABELS this shell keeps for itself (VS Code: its theme …).
 */
export function startAccountPrefs(id: number, opts: { exclude?: readonly string[] } = {}): () => void {
  stop?.();
  userId = id;
  excluded = new Set(opts.exclude ?? []);
  const stored = readJson<SyncState>(STATE_KEY);
  state = stored && stored.user === id && stored.values ? stored : null;
  if (stored && stored.user !== id) writeJson(STATE_KEY, { ...stored, user: id, values: {}, at: {} });   // another account's browser: adopt, never upload
  void sync();
  let pushTimer: ReturnType<typeof setTimeout> | null = null;
  const soon = () => { if (pushTimer) clearTimeout(pushTimer); pushTimer = setTimeout(() => void sync(), 700); };
  const unsub = subscribePrefs(() => {
    if (!state) return;
    const mine = snapshot();
    let any = false;
    for (const [key, json] of Object.entries(mine)) if (key in state.values && state.values[key] !== json) { pendingAt[key] ??= Date.now(); any = true; }
    if (any) soon();
  });
  // the localStorage keys of other modules: looked at every few seconds
  const tick = setInterval(() => {
    if (!state || running) return;
    const mine = snapshot();
    let any = false;
    for (const k of SYNCED_STORAGE) { const key = 'ls.' + k; if (key in mine && key in state.values && state.values[key] !== mine[key]) { pendingAt[key] ??= Date.now(); any = true; } }
    if (any) soon();
  }, 4000);
  let lastPull = Date.now();
  const back = () => { if (document.visibilityState === 'visible' && Date.now() - lastPull > 15_000) { lastPull = Date.now(); void sync(); } };
  const away = () => { if (document.visibilityState === 'hidden' && Object.keys(pendingAt).length) void sync(); };
  const hourly = setInterval(() => { lastPull = Date.now(); void sync(); }, 5 * 60_000);
  window.addEventListener('focus', back);
  document.addEventListener('visibilitychange', back);
  document.addEventListener('visibilitychange', away);
  stop = () => {
    unsub(); clearInterval(tick); clearInterval(hourly); if (pushTimer) clearTimeout(pushTimer);
    window.removeEventListener('focus', back);
    document.removeEventListener('visibilitychange', back);
    document.removeEventListener('visibilitychange', away);
    userId = 0; state = null; stop = null;
  };
  return stop;
}
