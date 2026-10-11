/**
 * The theme switch's choices across the webviews (host/appearance.ts): smart invert of the pages
 * and their figures and the dark theme's text tone (client prefs), and the theme itself. A change
 * made in this webview goes to the host, which passes it to the other webviews; theirs arrive here.
 * The editor shows the switch and applies its own theme (`onTheme`); a PDF panel or a slide editor
 * follows the switch's theme, Default being VS Code's (`setHostDark`).
 */
import { G, vscode, applyTheme } from './globals';
import { getPrefs, setPref, subscribePrefs, type Prefs } from '@client/prefs';
import type { Appearance, ThemeChoice } from '../shared/protocol';

const KEYS = ['darkPages', 'invertFigures', 'darkTone'] as const;
const pick = (p: Prefs): Appearance => ({ darkPages: p.darkPages, invertFigures: p.invertFigures, darkTone: p.darkTone });
const same = (a: Appearance, b: Appearance) => KEYS.every(k => a[k] === b[k]);

let hostDark = G.dark;
let theme: ThemeChoice = 'system';
const shownDark = () => (theme === 'system' ? hostDark : theme === 'dark');

export function relayAppearance(onTheme?: (t: ThemeChoice) => void): void {
  let last = pick(getPrefs());
  let applying = false;
  subscribePrefs(p => {
    const now = pick(p);
    if (applying || same(now, last)) return;
    last = now;
    vscode.postMessage({ type: 'appearance', appearance: now });
  });
  addEventListener('message', (ev: MessageEvent) => {
    const m = ev.data as { type?: string; appearance?: Appearance } | null;
    if (m?.type !== 'appearance' || !m.appearance) return;
    const a = m.appearance;
    applying = true;
    try {
      if (a.darkPages !== undefined) setPref('darkPages', a.darkPages);
      if (a.invertFigures !== undefined) setPref('invertFigures', a.invertFigures);
      if (a.darkTone !== undefined) setPref('darkTone', a.darkTone);
    } finally { applying = false; }
    last = pick(getPrefs());
    if (a.theme) {
      theme = a.theme;
      if (onTheme) onTheme(a.theme); else applyTheme(shownDark());
    }
  });
}

/** VS Code's own theme (at the start, and when it changes): shown unless the switch chose Light or Dark */
export function setHostDark(dark: boolean): void { hostDark = dark; applyTheme(shownDark()); }

/** the editor's switch chose a theme: to the other webviews */
export function shareTheme(t: ThemeChoice): void { vscode.postMessage({ type: 'appearance', appearance: { theme: t } satisfies Appearance }); }
