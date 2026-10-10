/**
 * The OverLyX wordmark: motion lines, "Over", then "LYX" the way lyx.org draws it — capitals, each
 * letter tilted, blue L / yellow Y / red X. Two looks of the same markup (styles.css `.ol-wordmark`):
 * the Classic interface's chrome italic with a soft shadow, and the Bauhaus one (`bauhaus`, and
 * everywhere in the Modern interface) — flat ink lines, upright geometric "Over", the letters still
 * tilted; on hover "Over" leans forward, the lines stretch and the letters tip further. Plain markup
 * + CSS so it scales with the surrounding font size; the favicon (public/icon.svg) is the compact
 * "O·LYX" form of it. `play` runs the hover animation without a pointer.
 */
export function Wordmark({ play = false, bauhaus = false }: { play?: boolean; bauhaus?: boolean } = {}) {
  return (
    <span class={'ol-wordmark' + (bauhaus ? ' bauhaus' : '') + (play ? ' play' : '')} aria-label="OverLyX">
      <span class="speed" aria-hidden="true"><i /><i /><i /></span>
      <span class="over">Over</span>
      <span class="lyx"><span class="l">L</span><span class="y">Y</span><span class="x">X</span></span>
    </span>
  );
}
