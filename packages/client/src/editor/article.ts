/**
 * An HTML article in the document editor (core html/article.ts): the page's look — the custom
 * properties its stylesheet sets at :root (core articletheme.ts articleVars, sent with the
 * document's meta) — taken on by the editor (styles.css `.ol-article`, each as --ol-a-<name>), its
 * fonts loaded, its formulas sized to its text. What the page styles beyond them shows in the page
 * pane (app/ArticlePage.tsx).
 */
import type { EditorView } from 'prosemirror-view';
import { loadGoogleFont } from '../fonts/googlefont';
import { mathFont } from '../fonts/catalog';
import { subscribePrefs } from '../prefs';

const GENERIC = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-[a-z-]+|-apple-system|blinkmacsystemfont|emoji|math|inherit|initial|unset)$/i;

/** the families of a font-family list, quotes off */
function families(list: string): string[] {
  return list.split(',').map(f => f.trim().replace(/^["']|["']$/g, '')).filter(f => f && !GENERIC.test(f));
}

/** where the look goes: the pane around the editor (its background is the page's paper), else the editor */
const hostOf = (view: EditorView): HTMLElement => (view.dom.closest('.editor-scroll') as HTMLElement | null) ?? view.dom;

/** the article shown, its formulas fitted again when fonts arrive or the math font changes */
let fitted: EditorView | null = null;

/** the height of a font's capital H (em), measured by the browser (0: unknown) */
function capHeight(family: string): number {
  try {
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return 0;
    ctx.font = `100px ${family}`;
    return ctx.measureText('H').actualBoundingBoxAscent / 100 || 0;
  } catch { return 0; }
}

/**
 * An article's formulas sized to its text font (the page's, not the editor's face that
 * fonts/editorfont.ts sizes --math-scale for): their capitals as tall as the text's. Matching
 * x-heights, as for the editor's faces, made them too large beside a sans-serif with a tall
 * x-height (system-ui, Inter), and an article's formulas are mostly capitals and Greek.
 */
function fitMath(view: EditorView): void {
  if (!view.dom.isConnected || !view.dom.classList.contains('ol-article')) return;
  const host = hostOf(view);
  const text = capHeight(getComputedStyle(view.dom).fontFamily);
  const math = mathFont(document.documentElement.dataset.mathFont ?? '');
  if (text > 0.4 && text < 1) host.style.setProperty('--math-scale', String(Math.round(Math.min(1.25, Math.max(0.85, text / math.capHeight)) * 1000) / 1000));
  else host.style.removeProperty('--math-scale');
}

if (typeof document !== 'undefined') {
  document.fonts?.addEventListener?.('loadingdone', () => { if (fitted) fitMath(fitted); });
  // (after fonts/editorfont.ts has set the math font)
  subscribePrefs(() => setTimeout(() => { if (fitted) fitMath(fitted); }, 0));
}

/** The page's look on the editor (null: none — another kind of document). */
export function applyArticleLook(view: EditorView, vars: Record<string, string> | null): void {
  const host = hostOf(view);
  for (const el of new Set([host, view.dom])) {
    for (const p of Array.from(el.style)) if (p.startsWith('--ol-a-')) el.style.removeProperty(p);
  }
  host.style.removeProperty('--math-scale');
  host.classList.toggle('ol-article-host', !!vars);
  view.dom.classList.toggle('ol-article', !!vars);
  fitted = vars ? view : null;
  if (!vars) return;
  for (const [k, v] of Object.entries(vars)) {
    // (a value is the page's own CSS: nothing that could end the declaration)
    if (!/^--[\w-]{1,60}$/.test(k) || v.length > 400 || /[;{}<>]/.test(v)) continue;
    host.style.setProperty('--ol-a-' + k.slice(2), v);
  }
  for (const [k, v] of Object.entries(vars)) if (/^--font/.test(k)) for (const f of families(v).slice(0, 1)) loadGoogleFont(f);
  fitMath(view);
  void document.fonts?.ready.then(() => { if (fitted === view) fitMath(view); });
}
