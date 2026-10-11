/**
 * Slides and posters in the dark theme: the canvas around them is a dark grey (unless a canvas colour
 * was chosen for the document), and — if the person asks for it (prefs.invertSlides, off by default:
 * designed slides change colour) — the slides themselves are shown light on dark, as the PDF's pages
 * are (app/pdfdark.ts): inverted with a 180° hue rotation, so colours keep their hue, pictures and
 * videos inverted back to their own colours. On the deck canvas and its rail (deliverable runtime),
 * on layout documents' pages and their thumbnails (styles.css, `data-invert-slides` on <html>, set by
 * theme.ts); never when presenting.
 */
import { useEffect, useState } from 'preact/hooks';
import { getPrefs, subscribePrefs } from '../prefs';

/** the canvas around the slides in the dark theme, when no colour was chosen for it */
export const DARK_DESK = '#2b2c30';

/** the CSS filter that turns a slide light on dark (and, applied once more, a picture back) */
export const INVERT_FILTER = 'invert(1) hue-rotate(180deg)';

export const isDarkTheme = (): boolean => typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark';

/** the theme is dark; the slides are inverted (only ever in the dark theme) */
export function darkSlides(): { dark: boolean; invert: boolean } {
  const dark = isDarkTheme();
  return { dark, invert: dark && getPrefs().invertSlides };
}

/** calls `cb` whenever the theme or the preference changes; returns the unsubscribe */
export function onDarkSlides(cb: () => void): () => void {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const unsub = subscribePrefs(cb);
  return () => { mo.disconnect(); unsub(); };
}

/** Preact hook: `darkSlides()`, re-rendered when it changes */
export function useDarkSlides(): { dark: boolean; invert: boolean } {
  const [s, set] = useState(darkSlides);
  useEffect(() => onDarkSlides(() => set(p => { const n = darkSlides(); return n.dark === p.dark && n.invert === p.invert ? p : n; })), []);
  return s;
}
