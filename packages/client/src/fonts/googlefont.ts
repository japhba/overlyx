/**
 * A Google font a document names (a markdown document's front matter: its body font with Text font ▸
 * "As in the document", a heading font): its @font-face rules come from this server, which fetched the
 * files from Google Fonts (server googlefonts.ts) — the browser never asks Google, and the CSP keeps
 * font-src 'self'. Loaded once per family; one that is no Google font gets an empty stylesheet.
 */
const loaded = new Set<string>();

export function loadGoogleFont(family: string): void {
  if (typeof document === 'undefined' || loaded.has(family) || !/^[A-Za-z0-9][A-Za-z0-9 ]{0,59}$/.test(family)) return;
  loaded.add(family);
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/api/fonts/google.css?family=' + encodeURIComponent(family);
  link.dataset.googleFont = family;
  document.head.appendChild(link);
}
