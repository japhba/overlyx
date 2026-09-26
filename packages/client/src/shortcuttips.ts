/**
 * Shortcut tips: an action that has a shortcut but was taken with the mouse (a toolbar button, a
 * menu entry, the command palette, the right-click menu) shows a small tip with its shortcut —
 * from the third time on, five times per shortcut. Pressing the shortcut once ends its tips (it has
 * been learnt); "Don't show again" in the tip switches them all off (pref `shortcutTips`, Settings ▸
 * Editor turns them back on). The counts are kept per browser in localStorage `ol.shortcutTips`.
 *
 * Plain DOM, no framework: the right-click menu (editor/contextmenu.ts) uses it as well as the
 * Preact toolbars and menus, in the web client and in the VS Code webview alike.
 */
import { getPrefs, setPref } from './prefs';
import { formatShortcut } from './app/shortcuts';
import { canonical, keyFromEvent } from './app/keybindings';

/** uses without the shortcut before the tips start, and how many tips a shortcut gets */
export const TIP_AFTER = 2;
export const TIP_TIMES = 5;
const SHOW_MS = 5000;
const STORAGE = 'ol.shortcutTips';
const MAX_ENTRIES = 400;

/** per shortcut: n = taken without it, shown = tips shown, learnt = the shortcut was pressed */
export interface TipCount { n: number; shown: number; learnt?: boolean }
type Counts = Record<string, TipCount>;

let counts: Counts | null = null;
function load(): Counts {
  if (counts) return counts;
  try { const v = JSON.parse(localStorage.getItem(STORAGE) ?? '{}'); counts = v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { counts = {}; }
  return counts!;
}
function save(): void {
  const c = load();
  const keys = Object.keys(c);
  if (keys.length > MAX_ENTRIES) for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete c[k];
  try { localStorage.setItem(STORAGE, JSON.stringify(c)); } catch { /* ignore */ }
}
/** for tests */
export function resetShortcutTips(): void { counts = {}; try { localStorage.removeItem(STORAGE); } catch { /* ignore */ } hideShortcutTip(); }
export function shortcutTipCount(shortcut: string): TipCount | undefined { const k = normalizeShortcut(shortcut); return k ? load()[k] : undefined; }

const GLYPHS: Record<string, string> = { '⌃': 'Control', '⌥': 'Alt', '⇧': 'Shift', '⌘': 'Ctrl' };

/** one key combination in the menus' text form: '⌥⇧⌘O' / '⌘+Alt+C' / 'ctrl+e' → 'Ctrl+Alt+Shift+O' / 'Ctrl+Alt+C' / 'Ctrl+E'; a gesture ('double-click', 'Ctrl+click') stays as written */
function normalizeCombo(tok: string): string {
  let mods = '';
  let i = 0;
  while (i < tok.length && GLYPHS[tok[i]]) { mods += GLYPHS[tok[i]] + '+'; i++; }
  let rest = tok.slice(i);
  if (mods && rest.startsWith('+') && rest.length > 1) rest = rest.slice(1);
  const text = mods + rest;
  return canonical(text) ?? text;
}

/** The shortcut a menu entry or button shows, in one comparable form ('Ctrl+E', 'Alt+M F', 'Ctrl+Z / Ctrl+Y'); null when there is none. */
export function normalizeShortcut(s: string | undefined | null): string | null {
  const t = (s ?? '').trim();
  if (!t) return null;
  return t.split(' / ').map(alt => alt.split(', ').map(part => part.split(/\s+/).map(normalizeCombo).join(' ')).join(', ')).join(' / ');
}

/**
 * A toolbar button's tooltip split into the action and the shortcut at its end:
 * 'Emphasis (Ctrl+E)' → Emphasis / Ctrl+E, 'Insert ( ) (Alt+M ()' → Insert ( ) / Alt+M (,
 * 'Sync to PDF — show the cursor's place … (Ctrl+Alt+J)' → Sync to PDF / Ctrl+Alt+J.
 */
export function splitTitle(title: string | undefined): { label: string; shortcut?: string } {
  const t = title ?? '';
  const m = /\s*\(((?:Ctrl|Alt|Shift|Cmd|Meta|F\d|[⌘⌥⇧⌃])[^]*)\)\s*$/.exec(t);
  const label = (m ? t.slice(0, m.index) : t).split(' — ')[0].trim();
  return m ? { label, shortcut: m[1].trim() } : { label };
}

/** what a key press could have been: the combination, and a chord with the combination before it ('Alt+M F') */
let lastCombo: { key: string; at: number } | null = null;
function pressedCandidates(e: KeyboardEvent): string[] {
  const combo = keyFromEvent(e);
  const out: string[] = [];
  if (combo) out.push(combo);
  if (lastCombo && Date.now() - lastCombo.at < 3000 && !['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) {
    const plain = combo ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key);
    out.push(`${lastCombo.key} ${plain}`);
  }
  if (combo) lastCombo = { key: combo, at: Date.now() };
  else if (!['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) lastCombo = null;
  return out;
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.repeat) return;
  const pressed = pressedCandidates(e);
  if (!pressed.length) return;
  const c = load();
  let changed = false;
  for (const [key, entry] of Object.entries(c)) {
    if (entry.learnt) continue;
    const alts = key.split(/ \/ |, /);
    if (alts.some(a => pressed.includes(a))) { entry.learnt = true; changed = true; if (shownKey === key) hideShortcutTip(); }
  }
  if (changed) save();
}

/* ------------------------------------------------------------------ the tip */

let tip: HTMLElement | null = null;
let shownKey: string | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let lastPointer: { x: number; y: number; at: number } | null = null;

export function hideShortcutTip(): void {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  tip?.remove();
  tip = null;
  shownKey = null;
}

type Anchor = Element | DOMRect | { x: number; y: number } | null | undefined;
function anchorRect(a: Anchor): { left: number; top: number; bottom: number } | null {
  if (a instanceof Element) {
    if (!a.isConnected) return null;
    const r = a.getBoundingClientRect();
    return r.width || r.height ? { left: r.left, top: r.top, bottom: r.bottom } : null;
  }
  if (a && 'width' in a) return { left: a.left, top: a.top, bottom: a.bottom };
  if (a) return { left: a.x, top: a.y, bottom: a.y + 4 };
  return null;
}

function showTip(key: string, label: string, anchor: Anchor): void {
  hideShortcutTip();
  const el = document.createElement('div');
  el.className = 'shortcut-tip';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.dataset.shortcut = key;
  const text = document.createElement('span');
  text.className = 'shortcut-tip-text';
  if (label) { const l = document.createElement('span'); l.className = 'shortcut-tip-label'; l.textContent = label; text.append(l); }
  const kbd = document.createElement('kbd');
  kbd.textContent = formatShortcut(key);
  text.append(kbd);
  const off = document.createElement('button');
  off.type = 'button';
  off.className = 'shortcut-tip-off';
  off.textContent = "Don't show again";
  off.title = 'No more shortcut tips (Settings ▸ Editor turns them back on)';
  off.addEventListener('click', () => { setPref('shortcutTips', false); hideShortcutTip(); });
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'shortcut-tip-close';
  close.textContent = '×';
  close.title = 'Close';
  close.setAttribute('aria-label', 'Close');
  close.addEventListener('click', () => hideShortcutTip());
  el.append(text, off, close);
  // the tip never takes the keyboard focus from the editor
  el.addEventListener('mousedown', e => e.preventDefault());
  el.addEventListener('mouseenter', () => { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } });
  el.addEventListener('mouseleave', () => { hideTimer = setTimeout(hideShortcutTip, SHOW_MS / 2); });
  document.body.appendChild(el);
  tip = el;
  shownKey = key;
  // below the button / where the menu entry was, inside the window; above it when there is no room below
  const recent = lastPointer && Date.now() - lastPointer.at < 2000 ? lastPointer : null;
  const at = anchorRect(anchor) ?? anchorRect(recent) ?? { left: window.innerWidth / 2 - el.offsetWidth / 2, top: window.innerHeight - 72, bottom: window.innerHeight - 72 };
  const w = el.offsetWidth, h = el.offsetHeight;
  const left = Math.max(6, Math.min(at.left, window.innerWidth - w - 6));
  const top = at.bottom + 6 + h <= window.innerHeight - 6 ? at.bottom + 6 : Math.max(6, at.top - h - 6);
  el.style.left = left + 'px';
  el.style.top = top + 'px';
  hideTimer = setTimeout(hideShortcutTip, SHOW_MS);
}

/**
 * An action was taken without its shortcut: count it, and show the tip when it is due.
 * `label` names the action ("Emphasis"), `anchor` is where the tip goes (the button, the menu
 * entry's rectangle); without one it goes where the pointer last was.
 */
export function tookActionWithout(shortcut: string | undefined | null, label: string, anchor?: Anchor): void {
  if (typeof document === 'undefined') return;
  const key = normalizeShortcut(shortcut);
  if (!key || getPrefs().shortcutTips === false) return;
  const c = load();
  const entry = c[key] ?? (c[key] = { n: 0, shown: 0 });
  const due = !entry.learnt && entry.n >= TIP_AFTER && entry.shown < TIP_TIMES;
  entry.n++;
  if (due) entry.shown++;
  save();
  if (due) showTip(key, label.replace(/\s*▸\s*$/, '').replace(/…$/, '').trim(), anchor);
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('pointerdown', e => {
    lastPointer = { x: e.clientX, y: e.clientY, at: Date.now() };
    if (tip && !tip.contains(e.target as Node)) hideShortcutTip();
  }, true);
}
