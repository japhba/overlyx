/**
 * "Smart invert" for figures in the dark theme (like iOS Smart Invert, which turns the interface
 * dark but leaves photos alone): a plot or a diagram — dark strokes on a white or transparent
 * ground — is shown light-on-dark, a photograph is left as it is. The decision is made from the
 * image's own pixels, sampled from a small canvas copy: mostly-light (or transparent) pixels with
 * a few dark or coloured ones is line art; many mid-grey or saturated pixels is a photo.
 */
export type FigureKind = 'lineart' | 'photo';

/** Classify RGBA pixel data (any size; a 48–96 px thumbnail is plenty). */
export function classifyPixels(data: ArrayLike<number>): FigureKind {
  let n = 0, ground = 0, dark = 0, colourful = 0, mid = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    n++;
    if (data[i + 3] < 40) { ground++; continue; }   // transparent: the page shows through
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const sat = max ? (max - min) / max : 0;
    if (lum > 215 && sat < 0.2) ground++;
    else if (sat > 0.3) colourful++;
    else if (lum < 100) dark++;
    else mid++;
  }
  if (!n) return 'photo';
  const groundF = ground / n, darkF = dark / n, colourF = colourful / n, midF = mid / n;
  // a light ground that is most of the picture, not too many greys (anti-aliasing only) and not a
  // predominantly coloured picture; and something drawn on it at all
  return groundF >= 0.4 && midF <= 0.25 && colourF <= 0.45 && darkF + colourF + midF >= 0.002 ? 'lineart' : 'photo';
}

/** Classify a loaded <img>; null when its pixels cannot be read (cross-origin without CORS). */
export function classifyImage(img: HTMLImageElement): FigureKind | null {
  const w = img.naturalWidth, h = img.naturalHeight;
  if (!w || !h) return null;
  try {
    const canvas = document.createElement('canvas');
    const cw = Math.min(64, w), ch = Math.max(1, Math.min(64, Math.round(cw * h / w)));
    canvas.width = cw; canvas.height = ch;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, cw, ch);
    return classifyPixels(ctx.getImageData(0, 0, cw, ch).data);
  } catch { return null; }
}
