/**
 * Anonymous usage statistics: which actions people take and which of them go wrong, so that
 * counter-intuitive parts of the interface show up in the data (Settings ▸ Privacy switches it off;
 * the server's OVERLYX_USAGE_STATS=off switches it off for everyone).
 *
 * What is recorded — only the *kind* of action, never what it was applied to:
 *   menu / palette / shortcut   the menu path of the command ("Edit ▸ Text Style ▸ Bold")
 *   toolbar                     the button id ("emph", "m-frac ▸ \frac")
 *   key / chord                 a LyX key binding that ran, and whether the command did anything
 *   key-unbound                 a modifier combination that reached the editor and nothing handled
 *   dialog                      a dialog's title, whether it was applied or dismissed, how long it was open
 *   notice                      an error message shown in the status bar — its template, not its data
 *   error                       an uncaught error's message template
 *   undo / redo                 (so that "undone right after action X" can be counted)
 *   view                        which kind of screen is shown (start page, editor, source, board …)
 *   session                     platform, touch, window width class — once per page load
 * Every event carries `where` the action happened (text, math, table, inset, form, dialog, ui),
 * a per-page-load random session id, and the time. No user id, document id, project name, file
 * name, text or formula ever leaves the browser: `scrub()` removes quoted strings, file names,
 * e-mail addresses and numbers from every detail before it is queued, and the server applies the
 * same scrubbing again. Events go in batches to POST /api/usage (packages/server/src/usage.ts);
 * scripts/usage-report.ts and GET /api/admin/usage summarise them.
 *
 * The VS Code extension shares this code but sends nothing (it has no OverLyX account and its
 * telemetry is limited to crash diagnostics — packages/vscode/src/host/telemetry.ts).
 */
import { API_BASE } from './api';
import { getPrefs } from './prefs';
import { editorContext } from './editor/context';

export type UsageName = 'session' | 'view' | 'menu' | 'palette' | 'shortcut' | 'toolbar' | 'key' | 'chord' | 'key-unbound' | 'dialog' | 'notice' | 'error' | 'undo' | 'redo';
export const USAGE_NAMES: readonly UsageName[] = ['session', 'view', 'menu', 'palette', 'shortcut', 'toolbar', 'key', 'chord', 'key-unbound', 'dialog', 'notice', 'error', 'undo', 'redo'];
/** the action kinds the report treats as "the user did something on purpose" */
export const ACTION_NAMES: readonly UsageName[] = ['menu', 'palette', 'shortcut', 'toolbar', 'key', 'chord'];

export interface UsageEvent {
  /** milliseconds before the batch was sent */
  ago: number;
  name: UsageName;
  detail: string;
  /** did the action do something (a command that returned false did not) / was a dialog applied */
  ok?: boolean;
  /** text | math | table | inset | form | dialog | ui */
  where?: string;
  /** a duration (dialogs: how long it was open), ms */
  dt?: number;
}

export const DETAIL_MAX = 120;

/* ------------------------------------------------------------------ scrubbing (pure) */

/**
 * Remove everything that could identify a person or a document from a detail string: quoted
 * spans (labels, titles, names the messages quote), file names and paths, e-mail addresses,
 * numbers. What remains is the template of the message. Applied on the client before queueing
 * and again on the server before storing.
 */
export function scrub(s: string, max = DETAIL_MAX): string {
  return String(s ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/“[^”]*”|"[^"]*"|‘[^’]*’|`[^`]*`|'[^']{2,}'/g, '“…”')
    .replace(/\S+@\S+/g, '<email>')
    .replace(/\S*?(?:\/|\\|\.(?:tex|lyx|bib|pdf|png|jpe?g|svg|gif|eps|md|txt|board|json|zip|csv|sty|cls))\b[^\s:;,!?()[\]]*/gi, '<file>')
    .replace(/\d+(?:[.,]\d+)?/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** An error message shown to the user, reduced to its template: scrubbed, and cut after the first ": " (what follows is the data — an exception's text, a server answer). */
export function noticeTemplate(msg: string): string {
  const cut = msg.replace(/:\s.*$/s, ': …');
  return scrub(cut);
}

/** A dialog's identity: its title without the part that describes the object ("Table Settings — row 1 of 3 …" → "Table Settings"). */
export function dialogKey(title: string): string {
  return scrub(title.split(' — ')[0].split(' – ')[0]);
}

const cleanLabel = (s: string) => s.replace(/\s*▸\s*$/, '').replace(/…$/, '').trim();

/**
 * A menu command's identity: "Menu ▸ Submenu ▸ Label". Entries whose label is document content
 * (the Navigate menu's headings) pass a fixed `stat` instead of their label (MenuBar.tsx MenuEntry).
 */
export function menuKey(path: string[], label: string): string {
  return scrub([...path, cleanLabel(label)].join(' ▸ '));
}

/** What kind of screen a location hash shows — never the id itself. */
export function viewKind(hash: string): string {
  const raw = decodeURIComponent(hash.replace(/^#\/?/, '')).split('?')[0];
  if (!raw) return 'home';
  if (raw.startsWith('raw:')) return 'source';
  if (raw.startsWith('text:')) return raw.endsWith('.md') ? 'markdown' : 'text';
  if (raw.endsWith('.board')) return 'board';
  if (raw.endsWith('.pdf')) return 'pdf';
  if (raw.endsWith('.bib')) return 'bib';
  return 'editor';
}

export interface KeyLike { key: string; code?: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Dead', 'Unidentified', 'Process']);
/** the browser's own combinations: pressing them in the editor is not an unanswered request */
const NATIVE_KEYS = new Set(['Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+Shift+V', 'Ctrl+P', 'Ctrl+T', 'Ctrl+W', 'Ctrl+Shift+T', 'Ctrl+Shift+R', 'Ctrl+Tab', 'Ctrl+Shift+Tab', 'Ctrl+L', 'Alt+Tab', 'Ctrl+Shift+I', 'Ctrl+Shift+J', 'Ctrl+Shift+C', 'Ctrl+U', 'Alt+D', 'Ctrl+Insert', 'Shift+Insert', 'Shift+Delete']);

/** "Ctrl+Shift+K" for a key event with a modifier that could be a shortcut; null for typing, navigation and the browser's own keys. */
export function unboundKeyLabel(ev: KeyLike, mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)): string | null {
  if (MODIFIER_KEYS.has(ev.key)) return null;
  const primary = mac ? ev.metaKey : ev.ctrlKey;
  // Alt alone types accented characters on a Mac; Alt+letter on Windows/Linux may be a menu mnemonic — only with a primary modifier is it certainly a request
  if (!primary && !(ev.altKey && ev.ctrlKey)) return null;
  if (/^(Arrow|Home$|End$|Page|Backspace$|Delete$|Enter$|Escape$)/.test(ev.key)) return null;
  const code = ev.code ?? '';
  let key: string;
  let m: RegExpExecArray | null;
  if ((m = /^Key([A-Z])$/.exec(code))) key = m[1];
  else if ((m = /^(?:Digit|Numpad)(\d)$/.exec(code))) key = m[1];
  else if (code === 'Space' || ev.key === ' ') key = 'Space';
  else if (ev.key.length === 1) key = ev.key.toUpperCase();
  else key = ev.key;
  if (!/^[\w+\-=\[\]\\;',./`~!@#$%^&*(){}|:"<>?]{1,12}$/.test(key)) return null;
  const mods = [(mac ? ev.metaKey : ev.ctrlKey) && 'Ctrl', (mac ? ev.ctrlKey : ev.metaKey) && (mac ? 'Control' : 'Meta'), ev.altKey && 'Alt', ev.shiftKey && 'Shift'].filter(Boolean) as string[];
  const label = [...mods, key].join('+');
  return NATIVE_KEYS.has(label) ? null : label;
}

/* ------------------------------------------------------------------ recording */

/** Where the keyboard focus / selection is, as a class: what the person was doing when they acted. */
export function whereNow(): string {
  if (typeof document === 'undefined') return 'ui';
  const el = document.activeElement as HTMLElement | null;
  if (editorContext.mathField || el?.closest?.('.lm-field')) return 'math';
  if (el?.closest?.('[role="dialog"]')) return 'dialog';
  if (el?.closest?.('.lyx-editor')) {
    const anchor = document.getSelection()?.anchorNode;
    const at = anchor ? (anchor.nodeType === 1 ? anchor as Element : anchor.parentElement) : null;
    if (at?.closest('td, th')) return 'table';
    if (at?.closest('.lyx-inset')) return 'inset';
    return 'text';
  }
  if (el?.closest?.('.source-pane, .codearea')) return 'source';
  if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return 'form';
  return 'ui';
}

const QUEUE_MAX = 500;
const BATCH_AT = 40;
const FLUSH_MS = 20000;

let sessionId = '';
let queue: (UsageEvent & { at: number })[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
/** the server answered that statistics are off (204) or the route does not exist: stop for this page load */
let stopped = false;
let inited = false;

function newSessionId(): string {
  try { return crypto.randomUUID().replace(/-/g, '').slice(0, 16); } catch { return Math.random().toString(16).slice(2, 18).padEnd(16, '0'); }
}

/** Statistics are sent only from the web app (not the VS Code webview), when the preference is on and the browser does not signal Global Privacy Control. */
export function usageEnabled(): boolean {
  if (stopped || API_BASE !== '' || typeof window === 'undefined') return false;
  if ((navigator as unknown as { globalPrivacyControl?: boolean }).globalPrivacyControl) return false;
  return getPrefs().usageStats !== false;
}

/** Queue one event (no-op when statistics are off). `detail` is scrubbed here. */
export function recordUsage(name: UsageName, detail = '', extra: { ok?: boolean; dt?: number; where?: string } = {}): void {
  if (!usageEnabled()) return;
  const ev: UsageEvent & { at: number } = { at: Date.now(), ago: 0, name, detail: scrub(detail), where: extra.where ?? whereNow() };
  if (extra.ok !== undefined) ev.ok = extra.ok;
  if (extra.dt !== undefined && Number.isFinite(extra.dt)) ev.dt = Math.max(0, Math.round(extra.dt));
  queue.push(ev);
  if (queue.length > QUEUE_MAX) queue.splice(0, queue.length - QUEUE_MAX);
  if (queue.length >= BATCH_AT) void flushUsage();
  else if (!timer) timer = setTimeout(() => { timer = null; void flushUsage(); }, FLUSH_MS);
}

/** the queued events, for tests */
export function pendingUsage(): UsageEvent[] { return queue.map(({ at: _at, ...e }) => e); }

function batchBody(events: (UsageEvent & { at: number })[], now: number): string {
  return JSON.stringify({ session: sessionId, events: events.map(({ at, ...e }) => ({ ...e, ago: Math.max(0, now - at) })) });
}

/**
 * Send what is queued. `beacon`: the page is going away — hand the batch to the browser
 * (sendBeacon) instead of awaiting a response.
 */
export async function flushUsage(beacon = false): Promise<void> {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!queue.length || !usageEnabled()) { if (!usageEnabled()) queue = []; return; }
  const events = queue;
  queue = [];
  if (!sessionId) sessionId = newSessionId();
  const body = batchBody(events, Date.now());
  if (beacon && typeof navigator !== 'undefined' && navigator.sendBeacon) {
    try { if (navigator.sendBeacon(API_BASE + '/api/usage', new Blob([body], { type: 'application/json' }))) return; } catch { /* fall through to fetch */ }
  }
  try {
    const res = await fetch(API_BASE + '/api/usage', { method: 'POST', headers: { 'content-type': 'application/json' }, body, credentials: 'same-origin', keepalive: true });
    if (res.status === 204 || res.status === 403 || res.status === 404) stopped = true;
    else if (!res.ok && res.status !== 400 && res.status !== 429) queue = [...events, ...queue].slice(-QUEUE_MAX);   // a server hiccup: keep them for the next attempt
  } catch {
    queue = [...events, ...queue].slice(-QUEUE_MAX);   // offline: retry with the next batch
  }
}

/** Coarse, non-identifying description of the client for the session event. */
export function sessionDetail(ua = navigator.userAgent, width = window.innerWidth, touch = navigator.maxTouchPoints > 0): string {
  const platform = /iPhone|iPad|iPod/.test(ua) ? 'ios' : /Android/.test(ua) ? 'android' : /Mac/.test(ua) ? 'mac' : /Windows/.test(ua) ? 'windows' : /Linux|X11/.test(ua) ? 'linux' : 'other';
  const browser = /Firefox\//.test(ua) ? 'firefox' : /Edg\//.test(ua) ? 'edge' : /Chrome\//.test(ua) ? 'chrome' : /Safari\//.test(ua) ? 'safari' : 'other';
  const size = width < 700 ? 'narrow' : width < 1200 ? 'medium' : 'wide';
  return `${platform} ${browser} ${size}${touch ? ' touch' : ''}`;
}

/**
 * Web app start-up (main.tsx): the session event, a view event per screen change, and flushing
 * when the page is hidden or closed.
 */
export function initUsage(): void {
  if (inited || typeof window === 'undefined') return;
  inited = true;
  sessionId = newSessionId();
  recordUsage('session', sessionDetail(), { where: 'ui' });
  let lastView = '';
  const view = () => { const k = viewKind(location.hash); if (k !== lastView) { lastView = k; recordUsage('view', k, { where: 'ui' }); } };
  view();
  window.addEventListener('hashchange', view);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void flushUsage(true); });
  window.addEventListener('pagehide', () => void flushUsage(true));
}

/** tests: forget the queue and the stop flag */
export function resetUsageForTests(): void { queue = []; stopped = false; inited = false; sessionId = ''; if (timer) { clearTimeout(timer); timer = null; } }
