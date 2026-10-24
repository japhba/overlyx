/**
 * A new blank deck's page size (the user, 24 Oct 2026: "match my iPad's aspect, and other aspect
 * options on creation, informed by device and common choices"): this screen's — on a tablet the page
 * a drawing fills edge to edge — or one of core's DECK_SIZES, landscape or portrait. The last one
 * chosen is kept for the next deck, also for the decks made without a dialog (▭ Slides on a blank
 * page, a name ending in .html, + New slides of an empty project).
 */
import { DECK_SIZES, type PagePreset, type PageSize } from '@overlyx/core/html/deliverable.ts';

export interface DeckSizeChoice { id: string; portrait: boolean }

/** the iPads by their screens in points, landscape: which one this is */
const IPADS: [number, number, string][] = [
  [1024, 768, 'iPad 9.7″'], [1080, 810, 'iPad 10.2″'], [1112, 834, 'iPad Pro 10.5″ / iPad Air 10.5″'], [1133, 744, 'iPad mini'],
  [1180, 820, 'iPad / iPad Air 11″'], [1194, 834, 'iPad Pro 11″'], [1210, 834, 'iPad Pro 11″'],
  [1366, 1024, 'iPad Pro 12.9″ / iPad Air 13″'], [1376, 1032, 'iPad Pro 13″'],
];

// (iPadOS calls itself a Mac; a Mac has no touch points)
const isIpad = () => /iPad/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const isPhone = () => /iPhone|Android.+Mobile/.test(navigator.userAgent);
const isTablet = () => isIpad() || (!isPhone() && navigator.maxTouchPoints > 1 && Math.min(screen.width, screen.height) >= 600);

/** this screen as a page size (landscape), named after the device; null: no screen to measure */
export function deviceSize(): PagePreset | null {
  if (typeof screen === 'undefined') return null;
  const w = Math.max(screen.width, screen.height), h = Math.min(screen.width, screen.height);
  if (!(w >= 320 && h >= 240)) return null;
  const model = isIpad() ? IPADS.find(([a, b]) => a === w && b === h)?.[2] : undefined;
  const label = isIpad() ? 'This iPad' : isPhone() ? 'This phone' : isTablet() ? 'This tablet' : 'This screen';
  const hint = isTablet() || isPhone()
    ? `${model ? model + ': ' : ''}the shape of the whole screen, so a page you draw on fills it edge to edge`
    : 'The shape of this screen: the slides fill it when presented here';
  return { id: 'device', label, hint, width: w, height: h, unit: 'px' };
}

/** what a new deck can be: this screen's size, then the common slide and paper sizes */
export function deckSizes(): PagePreset[] {
  const d = deviceSize();
  return d ? [d, ...DECK_SIZES] : [...DECK_SIZES];
}

/** a preset turned to the orientation */
export function turned(p: PageSize, portrait: boolean): PageSize {
  const long = Math.max(p.width, p.height), short = Math.min(p.width, p.height);
  return portrait ? { width: short, height: long, unit: p.unit } : { width: long, height: short, unit: p.unit };
}

/** the page size of a choice (an unknown one: the first there is) */
export function sizeOf(c: DeckSizeChoice): PageSize {
  const sizes = deckSizes();
  return turned(sizes.find(s => s.id === c.id) ?? sizes[0], c.portrait);
}

const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
/** "4:3", "16:9" — or "1.44 : 1" when the whole numbers are not small */
export function ratioLabel(s: PageSize): string {
  const w = Math.round(s.width * 100), h = Math.round(s.height * 100), g = gcd(w, h);
  return w / g <= 21 && h / g <= 21 ? `${w / g}:${h / g}` : `${(Math.max(w, h) / Math.min(w, h)).toFixed(2)} : 1`;
}

/** "1280 × 720", "297 × 210 mm" */
export function sizeText(s: PageSize): string {
  return `${s.width} × ${s.height}${s.unit === 'px' ? '' : ' ' + s.unit}`;
}

const KEY = 'ol.deckSize';

/** the choice the dialog starts with: the last one, else this screen on a tablet (as it is held now), else 16:9 */
export function initialDeckSize(): DeckSizeChoice {
  try {
    const c = JSON.parse(localStorage.getItem(KEY) ?? 'null') as DeckSizeChoice | null;
    if (c && typeof c.id === 'string' && deckSizes().some(s => s.id === c.id)) return { id: c.id, portrait: !!c.portrait };
  } catch { /* no storage */ }
  return isTablet() && deviceSize() ? { id: 'device', portrait: innerHeight > innerWidth } : { id: '16:9', portrait: false };
}

export function rememberDeckSize(c: DeckSizeChoice): void {
  try { localStorage.setItem(KEY, JSON.stringify(c)); } catch { /* no storage */ }
}

/** the size of a deck made without asking: the last one chosen, else this tablet's or 16:9 */
export const usualDeckSize = (): PageSize => sizeOf(initialDeckSize());
