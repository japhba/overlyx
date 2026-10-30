export type AssetUrls = Record<string, string>;

const EXCLUDED = '[data-ol-runtime], mjx-container, .ol-mathchip, .ol-refchip, .ol-citechip';
const mappedValues = new WeakMap<Element, Map<string, { raw: string; mapped: string }>>();
const STYLE_TEXT = '#style-text';
const cssReferences = () => /\/\*[\s\S]*?\*\/|url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^)]*?))\s*\)|(@import\s+)(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')/gi;

/** Relative CSS resources, including the quoted form of @import. */
export function cssAssetValues(css: string): string[] {
  return Array.from(css.matchAll(cssReferences())).flatMap(match => {
    const value = match[1] ?? match[2] ?? match[3]?.trim() ?? match[5] ?? match[6];
    return value === undefined ? [] : [value];
  });
}

/** Keep commas inside data URLs and preserve candidate descriptors/spacing. */
function srcsetParts(value: string): { start: number; end: number; url: string }[] {
  const parts: { start: number; end: number; url: string }[] = [];
  let pos = 0;
  const space = (ch: string) => /[\t\n\f\r ]/.test(ch);
  while (pos < value.length) {
    while (pos < value.length && (space(value[pos]) || value[pos] === ',')) pos++;
    const start = pos;
    while (pos < value.length && !space(value[pos])) pos++;
    let end = pos;
    while (end > start && value[end - 1] === ',') end--;
    if (end > start) parts.push({ start, end, url: value.slice(start, end) });
    if (end < pos) continue;
    let parentheses = 0;
    while (pos < value.length) {
      const ch = value[pos++];
      if (ch === '(') parentheses++;
      else if (ch === ')') parentheses = Math.max(0, parentheses - 1);
      else if (ch === ',' && !parentheses) break;
    }
  }
  return parts;
}

export const srcsetAssetValues = (value: string): string[] => srcsetParts(value).map(part => part.url);

export function mappedSrcset(value: string, assets: AssetUrls, base: string): string {
  let result = '', end = 0;
  for (const part of srcsetParts(value)) {
    result += value.slice(end, part.start) + mappedAsset(part.url, assets, base);
    end = part.end;
  }
  return result + value.slice(end);
}

/**
 * A deliverable's files are addressed through a capability token (`/ol-d/<token>/…`) that is renewed —
 * after a reconnection the assets were read under a new one while the frame still resolves against the
 * one it opened with: matched without it (else every picture fell back to the network, under an
 * expired token after a night asleep, and showed as a broken image).
 */
const TOKEN = /\/ol-d\/[^/]+\//;
const tokenless = new WeakMap<AssetUrls, Map<string, string>>();
function byFile(assets: AssetUrls): Map<string, string> {
  let index = tokenless.get(assets);
  if (!index) {
    index = new Map();
    for (const [url, value] of Object.entries(assets)) if (TOKEN.test(url)) index.set(url.replace(TOKEN, '/ol-d/~/'), value);
    tokenless.set(assets, index);
  }
  return index;
}

export function mappedAsset(value: string, assets: AssetUrls, base: string): string {
  try {
    const url = new URL(value, base).href;
    return assets[url] ?? (TOKEN.test(url) ? byFile(assets).get(url.replace(TOKEN, '/ol-d/~/')) : undefined) ?? value;
  } catch { return value; }
}

export function mappedCss(css: string, assets: AssetUrls, base: string): string {
  return css.replace(cssReferences(), (whole, double, single, bare, imported, importDouble, importSingle) => {
    const value = double ?? single ?? bare?.trim() ?? importDouble ?? importSingle;
    if (value === undefined) return whole;
    const mapped = mappedAsset(value, assets, base);
    return mapped === value ? whole : imported ? `${imported}"${mapped}"` : `url("${mapped}")`;
  });
}

function setMapped(el: Element, name: string, raw: string, mapped: string): void {
  let values = mappedValues.get(el);
  if (raw !== mapped) {
    if (!values) mappedValues.set(el, values = new Map());
    values.set(name, { raw, mapped });
  } else values?.delete(name);
  if (name === STYLE_TEXT) { if (el.textContent !== mapped) el.textContent = mapped; }
  else if (el.getAttribute(name) !== mapped) el.setAttribute(name, mapped);
}

/** Source reconciliation can supply a new raw attribute without losing it to
 * a display-only data URL before the next canonical serialization. */
export function setMappedAttribute(el: Element, name: string, raw: string, assets: AssetUrls, base: string): void {
  if (el.closest(EXCLUDED) || !['src', 'href', 'poster', 'srcset', 'style'].includes(name)) { el.setAttribute(name, raw); mappedValues.get(el)?.delete(name); return; }
  const mapped = name === 'style' ? mappedCss(raw, assets, base)
    : name === 'srcset' ? mappedSrcset(raw, assets, base) : mappedAsset(raw, assets, base);
  setMapped(el, name, raw, mapped);
}

/** Read canonical source only while the live value is still our display
 * substitution. A later author or page-script edit owns its new value. */
export function mappedAttribute(el: Element, name: string): string | null {
  const value = el.getAttribute(name), old = mappedValues.get(el)?.get(name);
  return old && old.mapped === value ? old.raw : value;
}

/** Render cached resources without changing the editor's canonical source. */
export function mapAssets(root: Element, assets: AssetUrls, base: string): void {
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    if (el.closest(EXCLUDED)) continue;
    for (const name of ['src', 'href', 'poster', 'srcset', 'style']) {
      const value = el.getAttribute(name);
      if (value !== null) {
        const old = mappedValues.get(el)?.get(name);
        setMappedAttribute(el, name, old?.mapped === value ? old.raw : value, assets, base);
      } else mappedValues.get(el)?.delete(name);
    }
    if (el.localName === 'style') {
      const value = el.textContent ?? '', old = mappedValues.get(el)?.get(STYLE_TEXT);
      const raw = old?.mapped === value ? old.raw : value;
      setMapped(el, STYLE_TEXT, raw, mappedCss(raw, assets, base));
    }
  }
}

/** Restore only untouched display substitutions on an immediate DOM clone.
 * Changed attributes retain the user's edit; runtime/chip DOM is never tracked. */
export function restoreMappedAssets(clone: Element, live: Element): void {
  if (clone.localName !== live.localName || clone.namespaceURI !== live.namespaceURI || live.closest(EXCLUDED)) return;
  for (const [name, value] of mappedValues.get(live) ?? []) {
    if (name === STYLE_TEXT) {
      if (live.textContent === value.mapped && clone.textContent === value.mapped) clone.textContent = value.raw;
    } else if (live.getAttribute(name) === value.mapped && clone.getAttribute(name) === value.mapped) clone.setAttribute(name, value.raw);
  }
  const a = Array.from(clone.children), b = Array.from(live.children);
  if (a.length !== b.length) return;
  for (let i = 0; i < a.length; i++) restoreMappedAssets(a[i], b[i]);
}

export function clearMappedAssets(root: Element): void {
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) mappedValues.delete(el);
}

/** A serialized offline frame has a new WeakMap in its runtime. Seed one
 * source-linked element only when its displayed value is the expected mapping;
 * page scripts and later edits keep ownership of any different live value. */
export function rememberMappedSource(live: Element, source: Element, assets: AssetUrls, base: string): void {
  if (live.localName !== source.localName || live.namespaceURI !== source.namespaceURI || live.closest(EXCLUDED) || source.closest(EXCLUDED)) return;
  for (const name of ['src', 'href', 'poster', 'srcset', 'style']) {
    const raw = source.getAttribute(name);
    if (raw === null) { mappedValues.get(live)?.delete(name); continue; }
    const mapped = name === 'style' ? mappedCss(raw, assets, base)
      : name === 'srcset' ? mappedSrcset(raw, assets, base) : mappedAsset(raw, assets, base);
    if (live.getAttribute(name) === mapped) setMapped(live, name, raw, mapped);
    else mappedValues.get(live)?.delete(name);
  }
  if (live.localName === 'style') {
    const raw = source.textContent ?? '', mapped = mappedCss(raw, assets, base);
    if (live.textContent === mapped) setMapped(live, STYLE_TEXT, raw, mapped);
    else mappedValues.get(live)?.delete(STYLE_TEXT);
  }
}
