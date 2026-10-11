/**
 * Smart invert — the pages in the dark theme, one switch for all of them (prefs.darkPages, on by
 * default; the theme switch's menu, MenuBar.tsx themeMenuItems). On, the content of every page is
 * shown light on dark, colours keeping their hue:
 *  - documents (.tex, .md): the editor's page is dark through the theme's tokens (styles.css);
 *  - PDFs: the paper in the page colour, the ink in the text tone, baked into the canvas (app/pdfdark.ts);
 *  - HTML slides and posters: each slide inverted with a 180° hue rotation in the deck runtime's
 *    canvas and rail frames (`{ol:'dark'}`, runtime/darkpages.ts);
 *  - layout documents' pages (beamer objects) and their thumbnails (styles.css).
 * Off, every page keeps its own colours: a document is white paper inside the dark interface (the
 * light theme's tokens on `.editor-page`, styles.css), a PDF and the slides as they print.
 * With prefs.invertFigures the figures go with the page — a plot or diagram on a white base turns
 * light on dark, a photograph keeps its colours (editor/figureinvert.ts judges each by its pixels);
 * without it every picture keeps its colours. Presenting shows slides as designed, always.
 *
 * theme.ts mirrors both preferences on <html> (`data-dark-pages`, `data-invert-figures`) for the
 * stylesheet, which combines them with `data-theme` — set by theme.ts in the web client and by the
 * host in the VS Code webviews, so the rules hold in both.
 */
import { useEffect, useState } from 'preact/hooks';
import { getPrefs, setPref, subscribePrefs } from '../prefs';
import { parseColor, HUE180 } from './pdfdark';

/** the canvas around the slides in the dark theme, when no colour was chosen for it */
export const DARK_DESK = '#2b2c30';

/** the CSS filter that turns a slide light on dark (and, applied once more, a picture back) */
export const INVERT_FILTER = 'invert(1) hue-rotate(180deg)';

/** a colour as INVERT_FILTER shows it (inverted, then turned 180° in hue, in sRGB) — for what is painted beside an inverted page */
export function invertedColor(css: string): string {
  const c = parseColor(css);
  if (!c) return css;
  const v = c.map(x => 1 - x);
  const ch = (i: number) => Math.round(255 * Math.max(0, Math.min(1, HUE180[3 * i] * v[0] + HUE180[3 * i + 1] * v[1] + HUE180[3 * i + 2] * v[2])));
  return `rgb(${ch(0)}, ${ch(1)}, ${ch(2)})`;
}

export const isDarkTheme = (): boolean => typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark';

export interface DarkPages {
  /** the theme is dark */
  dark: boolean;
  /** the pages are shown light on dark (only ever in the dark theme) */
  invert: boolean;
  /** …and their figures with them: line art inverted, photographs in their colours */
  figures: boolean;
}

export function darkPages(): DarkPages {
  const dark = isDarkTheme();
  const p = getPrefs();
  const invert = dark && p.darkPages;
  return { dark, invert, figures: invert && p.invertFigures };
}

/** switch smart invert of the pages on or off (everywhere: one preference) */
export function toggleDarkPages(): void { setPref('darkPages', !getPrefs().darkPages); }

/** calls `cb` whenever the theme or the preferences change; returns the unsubscribe */
export function onDarkPages(cb: () => void): () => void {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const unsub = subscribePrefs(cb);
  return () => { mo.disconnect(); unsub(); };
}

/** Preact hook: `darkPages()`, re-rendered when it changes */
export function useDarkPagesState(): DarkPages {
  const [s, set] = useState(darkPages);
  useEffect(() => onDarkPages(() => set(p => { const n = darkPages(); return n.dark === p.dark && n.invert === p.invert && n.figures === p.figures ? p : n; })), []);
  return s;
}
