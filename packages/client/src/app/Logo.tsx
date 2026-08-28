/**
 * The OverLyX wordmark: "Over" in a fast italic with motion lines, then "LYX" the way lyx.org draws
 * it — heavy sans-serif capitals, each letter tilted, blue L / violet Y / pink X with a soft shadow.
 * Plain markup + CSS (styles.css `.ol-wordmark`) so it scales with the surrounding font size; the
 * favicon (public/icon.svg, index.html) is the "LYX" part.
 */
export function Wordmark() {
  return (
    <span class="ol-wordmark" aria-label="OverLyX">
      <span class="speed" aria-hidden="true"><i /><i /><i /></span>
      <span class="over">Over</span>
      <span class="lyx"><span class="l">L</span><span class="y">Y</span><span class="x">X</span></span>
    </span>
  );
}
