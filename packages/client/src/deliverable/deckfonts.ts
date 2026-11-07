/** Embedded deck fonts travel with the HTML; other fonts can fall back differently on each machine. */
import { parseSource, walk, innerRange } from '@overlyx/core/html/source.ts';
import { TEMPLATE_FONTS, TEMPLATE_FONT_LICENSE } from '@overlyx/core/html/scientific-fonts.ts';

/** The first requested family, preserving commas inside quoted names. */
export function firstFontFamily(css: string): string {
  return /^\s*("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^,]+)/.exec(css)?.[1].trim().replace(/^["']|["']$/g, '') ?? '';
}

export function bundledFont(css: string): string | undefined {
  const family = firstFontFamily(css).toLowerCase();
  return Object.keys(TEMPLATE_FONTS).find(f => f.toLowerCase() === family);
}

/** Only inline data fonts are embedded in this HTML; a linked font still needs its resource to load. */
export function embeddedFontFamilies(text: string): Set<string> {
  const families = new Set<string>();
  for (const el of walk(parseSource(text).doc)) {
    if (el.tagName !== 'style') continue;
    const range = innerRange(el);
    if (!range) continue;
    const css = text.slice(range.from, range.to).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const face of css.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
      if (!/(?:^|;)\s*src\s*:[^}]*url\(\s*["']?data:/i.test(face[1])) continue;
      const family = /(?:^|;)\s*font-family\s*:\s*("[^"]*"|'[^']*'|[^;]+)/i.exec(face[1]);
      if (family) families.add(firstFontFamily(family[1]).toLowerCase());
    }
  }
  return families;
}

export function fontPortabilityWarning(css: string, embedded: ReadonlySet<string>): string | null {
  const family = firstFontFamily(css);
  if (!family || /^(inherit|initial|unset)$/i.test(family) || embedded.has(family.toLowerCase())) return null;
  return `${family} is not embedded in this HTML. If unavailable, the editor, presenter view, render_page and PDF each use that machine’s fallback font. Text widths and formula sizes can differ. Choose a bundled font to embed it.`;
}

/**
 * Resources added by both the text picker and Edit theme; bundled choices work offline too. `google`:
 * a family (regular, bold and their italics), or a whole css2 family query (`Inter:ital,wght@…`,
 * googleFontSpec) — My fonts, with every weight or axis the family has.
 */
export function fontResource(text: string, css: string | null, google?: string): string {
  const bundled = css ? bundledFont(css) : undefined;
  if (bundled) {
    if (embeddedFontFamilies(text).has(bundled.toLowerCase())) return '';
    return `<!--\n${TEMPLATE_FONT_LICENSE}\n-->\n<style>\n${TEMPLATE_FONTS[bundled]}\n</style>`;
  }
  if (!google) return '';
  const [name, styles] = google.split(':');
  const family = name.replace(/ /g, '+');
  if (new RegExp(`family=${family.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9+])`).test(text)) return '';
  return `<link href="https://fonts.googleapis.com/css2?family=${family}:${styles ?? 'ital,wght@0,400;0,700;1,400;1,700'}&display=swap" rel="stylesheet">`;
}

/** what a family of Google's catalogue offers (fonts/googlefont.ts CatalogFamily): axes (variable), static weights, italics, category */
export interface GoogleFamilyStyles { f: string; c: string; a: { t: string; min: number; max: number }[]; w: number[]; i: boolean }

/**
 * The css2 query for all of a Google font (`Family:ital,wdth,wght@0,75..100,100..900;1,…`): a variable
 * font's whole axes (Text ▸ Typography's width and any weight), a static one's every weight, the
 * italics when it has them — the fixed regular / bold / italic query gives only those four (and
 * nothing for a family without a regular: css2 answers 400 when none of the styles asked exists).
 * Axes as css2 wants them: lower-case tags first, each part alphabetical.
 */
export function googleFontSpec(e: GoogleFamilyStyles): string {
  const num = (v: number) => String(Math.round(v * 1000) / 1000);
  const axes = e.a.filter(a => a.t !== 'ital' && /^[A-Za-z]{4}$/.test(a.t))
    .sort((x, y) => Number(x.t !== x.t.toLowerCase()) - Number(y.t !== y.t.toLowerCase()) || (x.t < y.t ? -1 : x.t > y.t ? 1 : 0));
  const italic = e.i || e.a.some(a => a.t === 'ital');
  if (axes.length) {
    const ranges = axes.map(a => (a.min === a.max ? num(a.min) : `${num(a.min)}..${num(a.max)}`)).join(',');
    return `${e.f}:${italic ? 'ital,' : ''}${axes.map(a => a.t).join(',')}@${italic ? `0,${ranges};1,${ranges}` : ranges}`;
  }
  const weights = [...new Set(e.w.filter(w => w >= 1 && w <= 1000))].sort((a, b) => a - b);
  if (!weights.length) weights.push(400);
  return italic ? `${e.f}:ital,wght@${[...weights.map(w => `0,${w}`), ...weights.map(w => `1,${w}`)].join(';')}` : `${e.f}:wght@${weights.join(';')}`;
}

/** a font of the deck's font lists (decktoolbar DECK_FONTS, the theme pane): `mine` one of My fonts */
export interface DeckFont { label: string; css: string | null; google?: string; mine?: boolean }

/** a Google font as a deck font (a family of the catalogue, fonts/googlefont.ts): its CSS family with the generic one of its category, the css2 query of all of it */
export function deckFontFor(e: GoogleFamilyStyles): DeckFont {
  const generic = /monospace/i.test(e.c) ? 'monospace' : /^serif$/i.test(e.c) ? 'serif' : /handwriting/i.test(e.c) ? 'cursive' : 'sans-serif';
  const name = /^[A-Za-z][A-Za-z-]*$/.test(e.f) ? e.f : JSON.stringify(e.f);
  return { label: e.f, css: `${name}, ${generic}`, google: googleFontSpec(e) };
}

/** My fonts (the account's Google fonts, fonts/myfonts.ts) as deck fonts */
export function myDeckFonts(entries: GoogleFamilyStyles[]): DeckFont[] {
  return entries.map(e => ({ ...deckFontFor(e), label: '★ ' + e.f, mine: true }));
}

/**
 * The bundled fonts drawn in the editor's own page too, so that the font list shows each in its face
 * (they are otherwise only inside the deck's frame): once, when a deck font list first opens.
 */
let previewed = false;
export function previewBundledFonts(): void {
  if (previewed || typeof document === 'undefined') return;
  previewed = true;
  const style = document.createElement('style');
  style.dataset.olDeckFonts = '';
  style.textContent = Object.values(TEMPLATE_FONTS).join('\n');
  document.head.appendChild(style);
}
