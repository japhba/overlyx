/**
 * The OverLyX wordmark: "Over" in a fast italic with motion lines, then "LyX" in the colours of the
 * lyx.org logo (blue L, yellow y, red X, serif). Plain markup + CSS (styles.css `.ol-wordmark`) so it
 * scales with the surrounding font size; the favicon (public/icon.svg, index.html) is the "LyX" part.
 */
export function Wordmark() {
  return (
    <span class="ol-wordmark" aria-label="OverLyX">
      <span class="speed" aria-hidden="true"><i /><i /><i /></span>
      <span class="over">Over</span>
      <span class="lyx"><span class="l">L</span><span class="y">y</span><span class="x">X</span></span>
    </span>
  );
}
