/**
 * How large the pictures of a deck's slides or of a poster may get when the server renders them
 * (render-export.ts) — shared with the export dialog, which shows the size in pixels before
 * anything is rendered and never offers what the server would refuse.
 *
 * The limits are this small server's, not the format's: a picture is held uncompressed by the
 * renderer while it is drawn (4 bytes a pixel), so an A0 poster at 300 dpi (139 million pixels)
 * would take more than half a gigabyte. For print the PDF is the right file: it stays sharp at any
 * size.
 */

/** one picture: A0 at 150 dpi (4967 × 7022) still fits */
export const PICTURE_MAX_PIXELS = 36_000_000;
/** all the slides of a deck in one .zip */
export const PICTURE_MAX_TOTAL = 480_000_000;
/** the longest side Chromium draws */
export const PICTURE_MAX_SIDE = 16000;
export const PICTURE_MIN_SCALE = 0.25;

export interface PagePx { width: number; height: number }

/** the largest factor (picture pixels per CSS pixel) the server renders `count` pages of this size at */
export function maxPictureScale(page: PagePx, count = 1): number {
  const w = Math.max(1, page.width), h = Math.max(1, page.height), n = Math.max(1, count);
  const one = Math.sqrt(Math.min(PICTURE_MAX_PIXELS, PICTURE_MAX_TOTAL / n) / (w * h));
  return Math.max(PICTURE_MIN_SCALE, Math.min(one, PICTURE_MAX_SIDE / Math.max(w, h), 8));
}

/** the factor asked for, within what the server renders */
export function pictureScale(want: number, page: PagePx, count = 1): number {
  const s = Number.isFinite(want) && want > 0 ? want : 1;
  return Math.max(PICTURE_MIN_SCALE, Math.min(s, maxPictureScale(page, count)));
}

/** the picture's size in pixels at a factor */
export function pictureSize(page: PagePx, scale: number): PagePx {
  return { width: Math.round(page.width * scale), height: Math.round(page.height * scale) };
}

/** CSS pixels are 1/96 in: a poster's printed size, and the factor of a print resolution */
export const CSS_DPI = 96;
export const dpiScale = (dpi: number): number => dpi / CSS_DPI;
export const pageMm = (page: PagePx): PagePx => ({ width: Math.round(page.width / CSS_DPI * 25.4), height: Math.round(page.height / CSS_DPI * 25.4) });

/** handouts: slides per page, and the paper */
export const HANDOUT_PER_PAGE = [1, 2, 3, 4, 6] as const;
export type HandoutPerPage = typeof HANDOUT_PER_PAGE[number];
export type HandoutPaper = 'a4' | 'letter';
export const handoutPerPage = (v: unknown): HandoutPerPage => (HANDOUT_PER_PAGE as readonly number[]).includes(Number(v)) ? Number(v) as HandoutPerPage : 3;
export const handoutPaper = (v: unknown): HandoutPaper => v === 'letter' ? 'letter' : 'a4';
