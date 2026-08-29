/**
 * The OverLyX wordmark: "Over" in a fast italic with motion lines, then "LYX" the way lyx.org draws
 * it — heavy sans-serif capitals, each letter tilted, blue L / yellow Y / red X with a soft shadow.
 * Plain markup + CSS (styles.css `.ol-wordmark`) so it scales with the surrounding font size; the
 * favicon (public/icon.svg, index.html) is the "LYX" part. `play` runs the hover animation (the
 * chrome sweep and the speed lines) without a pointer.
 */
export function Wordmark({ play = false }: { play?: boolean } = {}) {
  return (
    <span class={'ol-wordmark' + (play ? ' play' : '')} aria-label="OverLyX">
      <span class="speed" aria-hidden="true"><i /><i /><i /></span>
      <span class="over">Over</span>
      <span class="lyx"><span class="l">L</span><span class="y">Y</span><span class="x">X</span></span>
    </span>
  );
}
