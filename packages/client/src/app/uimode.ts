/**
 * The interface: Classic (LyX's toolbars, menus and status bar) or Modern (OverLyX's own quiet look:
 * a title with the menus under it, one toolbar strip, tools that appear when what they work on is
 * selected). Interface only — every function is the same in both. `data-ui` on <html>
 * is all the stylesheet looks at (modern.css); toolbars.tsx builds the Modern row from the same
 * buttons. Kept in this browser (`ol.ui`, applied before the first paint — main.tsx imports this
 * module early) and in the account (users.settings.interface), so a new browser follows the choice;
 * new accounts start in Modern; the welcome card (Tour.tsx), Settings ▸ Interface and View ▸ Interface
 * let anyone choose Classic.
 */
import { useEffect, useState } from 'preact/hooks';
import { api } from '../api';

export type UiMode = 'classic' | 'modern';

const KEY = 'ol.ui';
const listeners = new Set<() => void>();
let mode: UiMode = load();
// A choice made here takes precedence over settings requested before that choice.
let localChoiceVersion = 0;

function load(): UiMode {
  try { return localStorage.getItem(KEY) === 'classic' ? 'classic' : 'modern'; } catch { return 'modern'; }
}

export function uiMode(): UiMode { return mode; }
export function uiChoiceVersion(): number { return localChoiceVersion; }

/** switch the interface (`save`: also for the account, so other browsers follow) */
export function setUiMode(m: UiMode, save = true): void {
  // Even choosing the current mode is an explicit preference. Account adoption is not.
  if (save) localChoiceVersion++;
  mode = m;
  try { localStorage.setItem(KEY, m); } catch { /* private window */ }
  apply();
  if (save) void api.setSettings({ interface: m }).catch(() => undefined);
}

/** the account's choice, once the settings arrived (made in another browser) */
export function adoptAccountUi(m: UiMode | null | undefined): void {
  if (m && m !== mode) setUiMode(m, false);
}

function apply(): void {
  document.documentElement.dataset.ui = mode;
  listeners.forEach(l => l());
}

/** Preact hook: re-renders when the interface changes */
export function useUiMode(): UiMode {
  const [, tick] = useState(0);
  useEffect(() => { const l = () => tick(n => n + 1); listeners.add(l); return () => { listeners.delete(l); }; }, []);
  return mode;
}

apply();
