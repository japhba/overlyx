/**
 * TeX math in deliverables: \( \) inline, \[ \] and $$ $$ displayed, typeset by MathJax 4 (SVG
 * output, so a printed PDF has the formulas as vector paths) — unless the page brings its own
 * math library. MathJax comes from the runtime's folder (/_ol/mathjax/), fonts loaded on demand.
 */
import { BASE } from './env';

let loading: Promise<void> | null = null;
let own = false;

/** the page loads MathJax or KaTeX itself */
function pageHasMath(): boolean {
  return Array.from(document.scripts).some(s => !s.hasAttribute('data-ol-runtime') && /mathjax|katex/i.test(s.src || ''));
}

/** MathJax loaded and the page typeset once (nothing to do when the page has no math or its own library) */
export function startMath(): Promise<void> {
  if (loading) return loading;
  if (pageHasMath()) { own = true; loading = Promise.resolve(); return loading; }
  const text = document.body?.textContent ?? '';
  if (!/\\\(|\\\[|\$\$/.test(text)) {
    loading = Promise.resolve();
    // math may come later (an edit): MathJax is loaded then
    return loading;
  }
  loading = load();
  return loading;
}

function load(): Promise<void> {
  return new Promise<void>((resolve) => {
    window.MathJax = {
      loader: { load: [], paths: { mathjax: BASE + 'mathjax', fonts: BASE + 'mathjax/fonts' } },
      tex: { inlineMath: [['\\(', '\\)']], displayMath: [['\\[', '\\]'], ['$$', '$$']], processEscapes: true },
      svg: { fontCache: 'global' },
      // no menu, no speech or braille (their worker would be fetched from the page's opaque origin), no enrichment
      options: {
        enableMenu: false, enableSpeech: false, enableBraille: false, enableEnrichment: false, enableExplorer: false,
        a11y: { speech: false, braille: false },
        menuOptions: { settings: { speech: false, braille: false, enrich: false, collapsible: false, assistiveMml: false } },
        ignoreHtmlClass: 'ol-notex', processHtmlClass: 'ol-tex',
      },
      startup: {
        typeset: true,
        ready() {
          window.MathJax.startup.defaultReady();
          window.MathJax.startup.promise.then(() => resolve(), () => resolve());
        },
      },
    };
    const s = document.createElement('script');
    s.src = BASE + 'mathjax/tex-svg.js';
    s.async = true;
    s.setAttribute('data-ol-runtime', '');
    s.onerror = () => resolve();
    document.head.appendChild(s);
  });
}

/** OverLyX's MathJax typesets the page (not the page's own math library, not "no math at all") */
export function mathTypeset(): boolean { return !own && !!window.MathJax?.startup; }

/** typeset math in elements put into the page (after an edit) */
export async function typeset(els: Element[]): Promise<void> {
  if (own || !els.length) return;
  if (!loading) {
    if (!els.some(e => /\\\(|\\\[|\$\$/.test(e.textContent ?? ''))) return;
    loading = load();
    await loading;
    return;   // the startup typesets the whole page
  }
  await loading;
  const mj = window.MathJax;
  if (!mj?.typesetPromise) return;
  try { await mj.typesetPromise(els); } catch { /* a formula MathJax cannot parse shows as its error */ }
}

/** forget the math of elements taken out of the page */
export function untypeset(els: Element[]): void {
  const mj = window.MathJax;
  if (own || !mj?.typesetClear || !els.length) return;
  try { mj.typesetClear(els); } catch { /* ignore */ }
}
