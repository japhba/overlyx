/**
 * The page itself never zooms: every view zooms its own content (slides, boards, the PDF, the text),
 * and a pinch that Safari takes for the page instead — on a toolbar, a panel, between two views — left
 * the whole interface magnified or shrunk on the iPad, with no way back (the app's own pinches answer
 * every later one). Three locks: the viewport's scale bounds (index.html; iOS honours them in a
 * home-screen app and against zooming in on a focused input), `touch-action: pan-x pan-y` on the root
 * (styles.css; no pinch or double-tap zoom of the page, the views' own gestures unaffected), and here:
 * should the page still end up scaled, it is put back at 100 % once the fingers are off it.
 */
let locked = false;

/** the viewport's own setting made again: WebKit then applies its scale bounds anew, which takes the page back to 1 */
function rescale(): void {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (!meta) return;
  const content = meta.content;
  meta.content = content.replace(/initial-scale=[\d.]+/, 'initial-scale=1.0001');
  requestAnimationFrame(() => {
    meta.content = content;
    // (the layout viewport went with it: the app fills the window from its corner)
    if (scrollX || scrollY) scrollTo(0, 0);
  });
}

/** on a touch screen: watch the page's scale from now on */
export function initZoomLock(): void {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  if (locked || !vv || navigator.maxTouchPoints <= 0) return;
  locked = true;
  let fingers = 0, timer: ReturnType<typeof setTimeout> | null = null;
  const check = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (Math.abs(vv.scale - 1) < 0.02) return;
    // not while a pinch goes on: when it ends
    timer = setTimeout(() => { timer = null; if (!fingers && Math.abs(vv.scale - 1) >= 0.02) rescale(); }, 350);
  };
  const opts = { capture: true, passive: true };
  addEventListener('touchstart', e => { fingers = e.touches.length; }, opts);
  for (const t of ['touchend', 'touchcancel'] as const) addEventListener(t, e => { fingers = e.touches.length; if (!fingers) check(); }, opts);
  vv.addEventListener('resize', check);
  check();
}
