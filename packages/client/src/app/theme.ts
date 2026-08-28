/**
 * Light / dark theme. The preference (`ol.theme` in localStorage: 'light' | 'dark'; absent = follow
 * the system) is turned into `data-theme` on <html>, which is all the stylesheet looks at (the
 * tokens in styles.css). Imported first by main.tsx so the attribute is set before the first paint.
 */
import { useEffect, useState } from 'preact/hooks';

export type Theme = 'light' | 'dark';
export type ThemePref = Theme | 'system';

const KEY = 'ol.theme';
const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
const listeners = new Set<() => void>();
let pref: ThemePref = load();

function load(): ThemePref {
  try { const v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : 'system'; } catch { return 'system'; }
}

export function themePref(): ThemePref { return pref; }
/** the theme actually shown */
export function currentTheme(): Theme { return pref === 'system' ? (media?.matches ? 'dark' : 'light') : pref; }

export function setThemePref(p: ThemePref): void {
  pref = p;
  try { if (p === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, p); } catch { /* ignore */ }
  apply();
}
/** the menu-bar button: flip what is shown (and remember it; View ▸ Theme ▸ System goes back to following the OS) */
export function toggleTheme(): void { setThemePref(currentTheme() === 'dark' ? 'light' : 'dark'); }

function apply(): void {
  const t = currentTheme();
  document.documentElement.dataset.theme = t;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t === 'dark' ? '#1c1c21' : '#3b6ea5');
  listeners.forEach(l => l());
}

media?.addEventListener('change', () => { if (pref === 'system') apply(); });
apply();

/** Preact hook: re-renders when the preference or the system theme changes. */
export function useTheme(): { pref: ThemePref; theme: Theme } {
  const [, tick] = useState(0);
  useEffect(() => { const l = () => tick(n => n + 1); listeners.add(l); return () => { listeners.delete(l); }; }, []);
  return { pref, theme: currentTheme() };
}
