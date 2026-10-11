import { useEffect, useState } from 'preact/hooks';

/** a wordmark has arrived on this page already (the arrival plays once per page load) */
let arrived = false;
/** how long the arriving wordmark holds the hover pose before it relaxes */
const ARRIVE_HOLD_MS = 450;

/**
 * The OverLyX wordmark: motion lines (Classic only), "Over", then "LYX" the way lyx.org draws it — capitals, each
 * letter tilted, blue L / yellow Y / red X. Two looks of the same markup (styles.css `.ol-wordmark`):
 * the Classic interface's chrome italic with a soft shadow, and the Bauhaus one (`bauhaus`, and
 * everywhere in the Modern interface) — no motion lines, upright geometric "Over", the letters still
 * tilted; on hover "Over" leans forward and the letters tip further. Plain markup
 * + CSS so it scales with the surrounding font size; the favicon (public/icon.svg) is the
 * wordmark's LYX over an upright O. `play` runs the hover animation without a pointer. `arrive`: the page's
 * first wordmark (the landing page's, or the menu bar's when one is signed in already) starts in the
 * hover pose and relaxes back — the hover's leave, once per page load.
 */
export function Wordmark({ play = false, bauhaus = false, arrive = false }: { play?: boolean; bauhaus?: boolean; arrive?: boolean } = {}) {
  const [entering, setEntering] = useState(() => arrive && !arrived);
  useEffect(() => {
    if (!entering) return;
    arrived = true;
    // held from the moment it can be seen: once its fonts are in and the page has painted
    let t = 0, alive = true;
    const fonts = (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts?.ready ?? Promise.resolve();
    void fonts.then(() => requestAnimationFrame(() => { if (alive) t = window.setTimeout(() => setEntering(false), ARRIVE_HOLD_MS); }));
    return () => { alive = false; clearTimeout(t); };
  }, []);
  return (
    <span class={'ol-wordmark' + (bauhaus ? ' bauhaus' : '') + (play || entering ? ' play' : '')} aria-label="OverLyX">
      <span class="speed" aria-hidden="true"><i /><i /><i /></span>
      <span class="over">Over</span>
      <span class="lyx"><span class="l">L</span><span class="y">Y</span><span class="x">X</span></span>
    </span>
  );
}
