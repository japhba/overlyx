/**
 * The math fonts MathJax draws formulas with (Settings ▸ Editor ▸ Math font, the menu:
 * fonts/catalog.ts MATH_FONTS): MathJax 4's own fonts, each made from an OpenType math font.
 * New Computer Modern is part of the bundle; another font's module (its metrics) is loaded when it
 * is chosen. Their data per Unicode block and their woff2 files come with the bundle and are
 * fetched when a formula needs them (the bundler rewrites every path; nothing comes from a CDN).
 */
import type { FontDataClass } from '@mathjax/src/js/output/common/FontData.js';
// the default font is part of the bundle: formulas render at once, before any font module arrived
import * as newcmModule from '@mathjax/mathjax-newcm-font/js/chtml.js';

type FontModule = Record<string, unknown>;
interface FontSource {
  /** the font's CHTML module */
  load: () => Promise<FontModule>;
  /** the package's name: MathJax asks for `@mathjax/<pkg>/js/chtml/dynamic/<block>` */
  pkg: string;
  woff2: Record<string, string>;
  dynamic: Record<string, () => Promise<unknown>>;
  /** a font extension on top of another font (Euler: over New Computer Modern) */
  base?: string;
}

// The globs must be literal. Paths lead to the workspace's node_modules; woff2 files stay files
// (?no-inline: Vite would put the small ones into the bundle as data URLs, hundreds of them).
const SOURCES: Record<string, FontSource> = {
  newcm: {
    pkg: 'mathjax-newcm-font', load: () => import('@mathjax/mathjax-newcm-font/js/chtml.js'),
    woff2: import.meta.glob('../../../../../node_modules/@mathjax/mathjax-newcm-font/chtml/woff2/*.woff2', { query: '?no-inline', import: 'default', eager: true }),
    dynamic: import.meta.glob('../../../../../node_modules/@mathjax/mathjax-newcm-font/mjs/chtml/dynamic/*.js'),
  },
  modern: {
    pkg: 'mathjax-modern-font', load: () => import('@mathjax/mathjax-modern-font/js/chtml.js'),
    woff2: import.meta.glob('../../../../../node_modules/@mathjax/mathjax-modern-font/chtml/woff2/*.woff2', { query: '?no-inline', import: 'default', eager: true }),
    dynamic: import.meta.glob('../../../../../node_modules/@mathjax/mathjax-modern-font/mjs/chtml/dynamic/*.js'),
  },
  tex: {
    pkg: 'mathjax-tex-font', load: () => import('@mathjax/mathjax-tex-font/js/chtml.js'),
    woff2: import.meta.glob('../../../../../node_modules/@mathjax/mathjax-tex-font/chtml/woff2/*.woff2', { query: '?no-inline', import: 'default', eager: true }),
    dynamic: import.meta.glob('../../../../../node_modules/@mathjax/mathjax-tex-font/mjs/chtml/dynamic/*.js'),
  },
  stix2: {
    pkg: 'mathjax-stix2-font', load: () => import('@mathjax/mathjax-stix2-font/js/chtml.js'),
    woff2: import.meta.glob('../../../../../node_modules/@mathjax/mathjax-stix2-font/chtml/woff2/*.woff2', { query: '?no-inline', import: 'default', eager: true }),
    dynamic: import.meta.glob('../../../../../node_modules/@mathjax/mathjax-stix2-font/mjs/chtml/dynamic/*.js'),
  },
  termes: {
    pkg: 'mathjax-termes-font', load: () => import('@mathjax/mathjax-termes-font/js/chtml.js'),
    woff2: import.meta.glob('../../../../../node_modules/@mathjax/mathjax-termes-font/chtml/woff2/*.woff2', { query: '?no-inline', import: 'default', eager: true }),
    dynamic: import.meta.glob('../../../../../node_modules/@mathjax/mathjax-termes-font/mjs/chtml/dynamic/*.js'),
  },
  pagella: {
    pkg: 'mathjax-pagella-font', load: () => import('@mathjax/mathjax-pagella-font/js/chtml.js'),
    woff2: import.meta.glob('../../../../../node_modules/@mathjax/mathjax-pagella-font/chtml/woff2/*.woff2', { query: '?no-inline', import: 'default', eager: true }),
    dynamic: import.meta.glob('../../../../../node_modules/@mathjax/mathjax-pagella-font/mjs/chtml/dynamic/*.js'),
  },
  asana: {
    pkg: 'mathjax-asana-font', load: () => import('@mathjax/mathjax-asana-font/js/chtml.js'),
    woff2: import.meta.glob('../../../../../node_modules/@mathjax/mathjax-asana-font/chtml/woff2/*.woff2', { query: '?no-inline', import: 'default', eager: true }),
    dynamic: import.meta.glob('../../../../../node_modules/@mathjax/mathjax-asana-font/mjs/chtml/dynamic/*.js'),
  },
  bonum: {
    pkg: 'mathjax-bonum-font', load: () => import('@mathjax/mathjax-bonum-font/js/chtml.js'),
    woff2: import.meta.glob('../../../../../node_modules/@mathjax/mathjax-bonum-font/chtml/woff2/*.woff2', { query: '?no-inline', import: 'default', eager: true }),
    dynamic: import.meta.glob('../../../../../node_modules/@mathjax/mathjax-bonum-font/mjs/chtml/dynamic/*.js'),
  },
  schola: {
    pkg: 'mathjax-schola-font', load: () => import('@mathjax/mathjax-schola-font/js/chtml.js'),
    woff2: import.meta.glob('../../../../../node_modules/@mathjax/mathjax-schola-font/chtml/woff2/*.woff2', { query: '?no-inline', import: 'default', eager: true }),
    dynamic: import.meta.glob('../../../../../node_modules/@mathjax/mathjax-schola-font/mjs/chtml/dynamic/*.js'),
  },
  dejavu: {
    pkg: 'mathjax-dejavu-font', load: () => import('@mathjax/mathjax-dejavu-font/js/chtml.js'),
    woff2: import.meta.glob('../../../../../node_modules/@mathjax/mathjax-dejavu-font/chtml/woff2/*.woff2', { query: '?no-inline', import: 'default', eager: true }),
    dynamic: import.meta.glob('../../../../../node_modules/@mathjax/mathjax-dejavu-font/mjs/chtml/dynamic/*.js'),
  },
  fira: {
    pkg: 'mathjax-fira-font', load: () => import('@mathjax/mathjax-fira-font/js/chtml.js'),
    woff2: import.meta.glob('../../../../../node_modules/@mathjax/mathjax-fira-font/chtml/woff2/*.woff2', { query: '?no-inline', import: 'default', eager: true }),
    dynamic: import.meta.glob('../../../../../node_modules/@mathjax/mathjax-fira-font/mjs/chtml/dynamic/*.js'),
  },
  euler: {
    pkg: 'mathjax-euler-font-extension', base: 'newcm', load: () => import('@mathjax/mathjax-euler-font-extension/js/chtml.js'),
    woff2: import.meta.glob('../../../../../node_modules/@mathjax/mathjax-euler-font-extension/chtml/woff2/*.woff2', { query: '?no-inline', import: 'default', eager: true }),
    dynamic: import.meta.glob('../../../../../node_modules/@mathjax/mathjax-euler-font-extension/mjs/chtml/dynamic/*.js'),
  },
};

/** a math font OverLyX has */
export function isMathFont(id: string): boolean { return id in SOURCES; }

/** woff2 file name → bundled URL, over all fonts */
const WOFF2: Record<string, string> = {};
/** `@mathjax/<pkg>/js/chtml/dynamic/<block>.js` → its module */
const DYNAMIC: Record<string, () => Promise<unknown>> = {};
for (const s of Object.values(SOURCES)) {
  for (const [path, url] of Object.entries(s.woff2)) WOFF2[path.slice(path.lastIndexOf('/') + 1)] = url;
  for (const [path, load] of Object.entries(s.dynamic)) DYNAMIC[`@mathjax/${s.pkg}/js/chtml/dynamic/${path.slice(path.lastIndexOf('/') + 1)}`] = load;
}

/** MathJax asks for a font's per-block data by path (its dynamicPrefix + the block's file) */
export function loadFontModule(file: string): Promise<unknown> {
  const key = file.replace(/\/mjs\/chtml\//, '/js/chtml/').replace(/(?<!\.js)$/, '.js');
  const load = DYNAMIC[key];
  return load ? load() : Promise.reject(new Error(`no font data ${file}`));
}

/** the bundled URL of a woff2 file MathJax's CSS names */
function fontURL(src: string): string {
  return src.replace(/url\("[^"]*?\/?([^/"]+\.woff2)"\)/g, (all, file: string) => (WOFF2[file] ? `url("${WOFF2[file]}")` : all));
}

export interface LoadedMathFont {
  id: string;
  /** the CHTML font data class (with its CSS pointing at the bundled woff2 files) */
  data: FontDataClass<never, never, never>;
  /** a font extension to add to `data` (Euler) */
  extension?: unknown;
  /** the Unicode blocks formulas usually need, fetched in the background */
  preloadBlocks: string[];
}

/** the blocks of font data formulas usually need (the rest is fetched when a formula needs it) */
const PRELOAD = ['accents', 'arrows', 'symbols', 'math', 'shapes', 'marrows', 'mshapes', 'variants', 'calligraphic', 'double-struck', 'fraktur', 'script', 'greek', 'latin', 'monospace'];

const loaded = new Map<string, LoadedMathFont>();
const loading = new Map<string, Promise<LoadedMathFont | null>>();

/** the CHTML font class of a module, with the woff2 URLs of its CSS rewritten to the bundle's */
function bundledFont(mod: FontModule): FontDataClass<never, never, never> {
  const Base = Object.values(mod).find(v => typeof v === 'function' && 'defaultFonts' in (v as object)) as FontDataClass<never, never, never> & { addFontURLs(styles: object, fonts: object, url: string): void };
  if (!Base) throw new Error('no font class');
  const patched = Base as unknown as { __overlyx?: boolean; addFontURLs(styles: Record<string, { src: string }>, fonts: Record<string, { src: string }>, url: string): void };
  if (!patched.__overlyx) {
    const orig = patched.addFontURLs.bind(Base);
    patched.addFontURLs = (styles, fonts, url) => {
      orig(styles, fonts, url);
      for (const name of Object.keys(fonts)) if (styles[name]?.src) styles[name] = { ...styles[name], src: fontURL(styles[name].src) };
    };
    patched.__overlyx = true;
  }
  return Base;
}

/** The font, if its module has arrived; else null, and its module is on its way (whenMathFontLoaded). */
export function loadMathFont(id: string): LoadedMathFont | null {
  const hit = loaded.get(id);
  if (hit) return hit;
  void whenMathFontLoaded(id);
  return null;
}

/** Settles once the font's module has arrived: true, or false when there is no such font or it failed to load. */
export function whenMathFontLoaded(id: string): Promise<boolean> {
  if (loaded.has(id)) return Promise.resolve(true);
  let p = loading.get(id);
  if (!p) {
    const src = SOURCES[id];
    if (!src) return Promise.resolve(false);
    p = (async () => {
      try {
        if (src.base) {
          const [baseMod, ext] = await Promise.all([src.base === 'newcm' ? newcmModule as FontModule : SOURCES[src.base].load(), src.load()]);
          const extension = Object.values(ext).find(v => v && typeof v === 'object' && 'name' in (v as object));
          const font: LoadedMathFont = { id, data: bundledFont(baseMod), extension, preloadBlocks: PRELOAD };
          loaded.set(id, font);
          return font;
        }
        const font: LoadedMathFont = { id, data: bundledFont(await src.load()), preloadBlocks: PRELOAD };
        loaded.set(id, font);
        return font;
      } catch (e) {
        console.warn('math font', id, e);
        return null;
      }
    })();
    loading.set(id, p);
  }
  return p.then(f => !!f);
}

loaded.set('newcm', { id: 'newcm', data: bundledFont(newcmModule as FontModule), preloadBlocks: PRELOAD });
