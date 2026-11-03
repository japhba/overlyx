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

/** Resources added by both the text picker and Edit theme; bundled choices work offline too. */
export function fontResource(text: string, css: string | null, google?: string): string {
  const bundled = css ? bundledFont(css) : undefined;
  if (bundled) {
    if (embeddedFontFamilies(text).has(bundled.toLowerCase())) return '';
    return `<!--\n${TEMPLATE_FONT_LICENSE}\n-->\n<style>\n${TEMPLATE_FONTS[bundled]}\n</style>`;
  }
  if (!google) return '';
  const family = google.replace(/ /g, '+');
  if (text.includes(`family=${family}`)) return '';
  return `<link href="https://fonts.googleapis.com/css2?family=${family}:ital,wght@0,400;0,700;1,400;1,700&display=swap" rel="stylesheet">`;
}
