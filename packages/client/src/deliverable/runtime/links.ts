/**
 * Links in a page shown inside OverLyX — the page pane beside an article, an article's running HTML
 * blocks, a presentation: a link that leaves OverLyX opens in a new tab (never inside the frame: it
 * is no browser, and most sites refuse to be framed); one to another file of the project goes to the
 * editor around the frame (`openPath`), which opens it in OverLyX, when `internal` (else a new tab
 * too); a place on the same page is scrolled to. A page opened in a tab of its own keeps its links.
 */
export function startLinks(internal: boolean): void {
  if (window.parent === window) return;
  addEventListener('click', e => {
    // (a page's own script handling the click — a tab bar, a widget — has the say)
    if (e.defaultPrevented || e.button !== 0) return;
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!a || a.hasAttribute('download') || /^\s*javascript:/i.test(a.getAttribute('href') ?? '')) return;
    let url: URL, here: URL;
    try { url = new URL(a.href, document.baseURI); here = new URL(location.href); } catch { return; }
    // a place on this page
    if (url.origin === here.origin && url.pathname === here.pathname && url.hash) return;
    e.preventDefault();
    const inProject = url.origin === here.origin ? /^\/ol-d\/[^/]+\/(.+)$/.exec(url.pathname) : null;
    if (inProject && internal) { window.parent.postMessage({ ol: 'openPath', path: decodeURIComponent(inProject[1]) + url.hash }, '*'); return; }
    if (inProject) url.search = '';   // (the file itself, not a mode of the runtime)
    window.open(url.href, '_blank', 'noopener,noreferrer');
  });
}
