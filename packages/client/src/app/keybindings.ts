/**
 * User keyboard shortcuts. Commands are the menu items (id = their menu path, "View ▸ Outline");
 * a user may give any of them another shortcut, or none, from the command palette (Help menu,
 * Ctrl+Shift+P). Stored per browser in localStorage `ol.keys` as { [id]: 'Ctrl+Shift+9' | null }
 * (null = the default shortcut is switched off). The palette's global key listener runs the custom
 * shortcuts and swallows the default keys of commands that were rebound (MenuBar.tsx).
 *
 * Shortcut strings are canonical: modifiers in the order Control, Ctrl, Alt, Shift, Meta, then the
 * key ('Ctrl+Alt+O', 'Alt+Shift+→', 'Ctrl+Space'). 'Ctrl' is the platform's command key (⌘ on a
 * Mac, where 'Control' is the real control key) — the same convention as the menus use.
 */
import { isMacPlatform } from './shortcuts';

export type Bindings = Record<string, string | null>;
const STORAGE = 'ol.keys';

let bindings: Bindings = load();
const listeners = new Set<() => void>();

function load(): Bindings {
  try { const v = JSON.parse(localStorage.getItem(STORAGE) ?? '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}
function save() { try { localStorage.setItem(STORAGE, JSON.stringify(bindings)); } catch { /* ignore */ } }

export function getBindings(): Bindings { return bindings; }
/** `key`: a canonical shortcut, null = no shortcut, undefined = back to the default */
export function setBinding(id: string, key: string | null | undefined): void {
  const next = { ...bindings };
  if (key === undefined) delete next[id]; else next[id] = key;
  bindings = next;
  save();
  for (const l of listeners) l();
}
export function resetAllBindings(): void { bindings = {}; save(); for (const l of listeners) l(); }
export function subscribeBindings(l: () => void): () => void { listeners.add(l); return () => { listeners.delete(l); }; }
export const isCustom = (id: string): boolean => Object.prototype.hasOwnProperty.call(bindings, id);
/** the shortcut in force for a command: the user's, or the default */
export function effectiveShortcut(id: string, def?: string): string | undefined {
  return isCustom(id) ? (bindings[id] ?? undefined) : def;
}

const MOD_ORDER = ['Control', 'Ctrl', 'Alt', 'Shift', 'Meta'];
const MOD_NAMES: Record<string, string> = { control: 'Control', ctrl: 'Ctrl', cmd: 'Ctrl', command: 'Ctrl', mod: 'Ctrl', alt: 'Alt', option: 'Alt', shift: 'Shift', meta: 'Meta', win: 'Meta' };
const KEY_NAMES: Record<string, string> = {
  ' ': 'Space', space: 'Space', spacebar: 'Space', enter: 'Enter', return: 'Enter', escape: 'Esc', esc: 'Esc', backspace: 'Backspace', delete: 'Delete', del: 'Delete',
  tab: 'Tab', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', insert: 'Insert',
  arrowleft: '←', left: '←', arrowright: '→', right: '→', arrowup: '↑', up: '↑', arrowdown: '↓', down: '↓',
};

function keyName(k: string): string | null {
  if (!k) return null;
  const n = KEY_NAMES[k.toLowerCase()];
  if (n) return n;
  if (/^F([1-9]|1[0-2])$/i.test(k)) return k.toUpperCase();
  if ([...k].length === 1) return k.toUpperCase();
  return null;
}

/** canonical form of a shortcut string, or null when it is not a single key combination (chords, alternatives) */
export function canonical(s: string | undefined | null): string | null {
  if (!s) return null;
  const t = s.trim();
  if (!t || /\s/.test(t)) return null;
  let key: string, mods: string;
  if (t.endsWith('++')) { key = '+'; mods = t.slice(0, -2); }
  else { const i = t.lastIndexOf('+'); if (i < 0) { key = t; mods = ''; } else { key = t.slice(i + 1); mods = t.slice(0, i); } }
  const parts = mods ? mods.split('+') : [];
  const set = new Set<string>();
  for (const p of parts) { const m = MOD_NAMES[p.toLowerCase()]; if (!m) return null; set.add(m); }
  const kn = keyName(key);
  if (!kn) return null;
  return [...MOD_ORDER.filter(m => set.has(m)), kn].join('+');
}

export interface KeyLike { key: string; code?: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }

/**
 * The canonical shortcut a key event stands for, or null when it is no shortcut (a modifier alone,
 * plain typing without Ctrl/Alt/Meta — function keys excepted).
 */
export function keyFromEvent(e: KeyLike, mac = isMacPlatform()): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Dead', 'Unidentified'].includes(e.key)) return null;
  const set = new Set<string>();
  if (mac) { if (e.metaKey) set.add('Ctrl'); if (e.ctrlKey) set.add('Control'); }
  else { if (e.ctrlKey) set.add('Ctrl'); if (e.metaKey) set.add('Meta'); }
  if (e.altKey) set.add('Alt');
  if (e.shiftKey) set.add('Shift');
  let key: string | null = null;
  const code = e.code ?? '';
  let m: RegExpExecArray | null;
  if ((m = /^Key([A-Z])$/.exec(code))) key = m[1];
  else if ((m = /^(?:Digit|Numpad)(\d)$/.exec(code))) key = m[1];
  else if (code === 'Space') key = 'Space';
  else key = keyName(e.key);
  if (!key) return null;
  const fkey = /^F\d+$/.test(key);
  if (!fkey && !set.has('Ctrl') && !set.has('Control') && !set.has('Alt') && !set.has('Meta')) return null;
  if (key === 'Esc' && set.size === 0) return null;
  return [...MOD_ORDER.filter(x => set.has(x)), key].join('+');
}
