/**
 * An HTML article in the document editor (core html/article.ts): the page's look — the custom
 * properties its stylesheet sets at :root (core articletheme.ts articleVars, sent with the
 * document's meta) — taken on by the editor (styles.css `.ol-article`, each as --ol-a-<name>), its
 * fonts loaded. What the page styles beyond them shows in the page pane (app/ArticlePage.tsx).
 */
import type { EditorView } from 'prosemirror-view';
import { loadGoogleFont } from '../fonts/googlefont';

const GENERIC = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-[a-z-]+|-apple-system|blinkmacsystemfont|emoji|math|inherit|initial|unset)$/i;

/** the families of a font-family list, quotes off */
function families(list: string): string[] {
  return list.split(',').map(f => f.trim().replace(/^["']|["']$/g, '')).filter(f => f && !GENERIC.test(f));
}

/** where the look goes: the pane around the editor (its background is the page's paper), else the editor */
const hostOf = (view: EditorView): HTMLElement => (view.dom.closest('.editor-scroll') as HTMLElement | null) ?? view.dom;

/** The page's look on the editor (null: none — another kind of document). */
export function applyArticleLook(view: EditorView, vars: Record<string, string> | null): void {
  const host = hostOf(view);
  for (const el of new Set([host, view.dom])) {
    for (const p of Array.from(el.style)) if (p.startsWith('--ol-a-')) el.style.removeProperty(p);
  }
  host.classList.toggle('ol-article-host', !!vars);
  view.dom.classList.toggle('ol-article', !!vars);
  if (!vars) return;
  for (const [k, v] of Object.entries(vars)) {
    // (a value is the page's own CSS: nothing that could end the declaration)
    if (!/^--[\w-]{1,60}$/.test(k) || v.length > 400 || /[;{}<>]/.test(v)) continue;
    host.style.setProperty('--ol-a-' + k.slice(2), v);
  }
  for (const [k, v] of Object.entries(vars)) if (/^--font/.test(k)) for (const f of families(v).slice(0, 1)) loadGoogleFont(f);
}
