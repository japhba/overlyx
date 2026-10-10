/**
 * TeX math in deliverables: \( \) inline, \[ \] and $$ $$ displayed, typeset by MathJax 4 (SVG
 * output, so a printed PDF has the formulas as vector paths) — unless the page brings its own
 * math library. MathJax comes from the runtime's folder (/_ol/mathjax/), fonts loaded on demand.
 *
 * A formula's TeX is never on screen: until MathJax has typeset it, the element it is in is
 * invisible (`data-ol-texwait`), and a formula typeset before is put in again as a copy of its rendering at
 * once (a text retyped and shown again, an object made anew from a new version of the text, the
 * formula just edited with LyX's formula editor). MathJax's SVG output measures everything in ex
 * of the surrounding font (matchFontHeight), so one rendering fits wherever the formula goes; its
 * glyphs are <use>s of the page's global font cache.
 */
import { BASE } from './env';

let loading: Promise<void> | null = null;
let own = false;
let pageDone: Promise<void> | null = null;

const TEX = /\\\(|\\\[|\$\$/;
const MATH_RE = /\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$/g;
const WAIT = 'data-ol-texwait';
/** MathJax's skipHtmlTags */
const SKIP = new Set(['script', 'noscript', 'style', 'textarea', 'pre', 'code', 'annotation', 'annotation-xml']);

/** the page loads MathJax or KaTeX itself */
function pageHasMath(): boolean {
  return Array.from(document.scripts).some(s => !s.hasAttribute('data-ol-runtime') && /mathjax|katex/i.test(s.src || ''));
}

/** a text MathJax looks into (its ignoreHtmlClass / processHtmlClass, skipHtmlTags) */
function processed(n: Node): boolean {
  for (let e = n.parentElement; e; e = e.parentElement) {
    if (SKIP.has(e.localName) || e.localName === 'mjx-container') return false;
    if (e.classList.contains('ol-tex')) break;
    if (e.classList.contains('ol-notex')) return false;
  }
  return true;
}

/** the texts with TeX in them MathJax would typeset */
function texTexts(root: Element): Text[] {
  const out: Text[] = [];
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) if (TEX.test(n.nodeValue ?? '') && processed(n)) out.push(n as Text);
  return out;
}

/* ------------------------------------------------------------------ formulas typeset before */

const typeset0 = new Map<string, Element>();
const keyOf = (tex: string, display: boolean) => (display ? 'D' : 'I') + tex.replace(/^\s+/, '').replace(/(?<!\\)\s+$/, '');

/** formulas typeset before put in as copies of their renderings; returns the texts that still have TeX */
function reuse(els: Element[]): Text[] {
  const left: Text[] = [];
  for (const root of els) for (const t of texTexts(root)) {
    const s = t.nodeValue ?? '';
    const frag = document.createDocumentFragment();
    let last = 0, hits = 0, miss = false;
    for (const m of s.matchAll(MATH_RE)) {
      const tpl = typeset0.get(keyOf(m[1] ?? m[2] ?? m[3], m[1] === undefined));
      if (!tpl) { miss = true; continue; }
      hits++;
      if (m.index! > last) frag.append(s.slice(last, m.index));
      frag.append(tpl.cloneNode(true));
      last = m.index! + m[0].length;
    }
    if (hits) {
      if (last < s.length) frag.append(s.slice(last));
      const rest = Array.from(frag.childNodes).filter((n): n is Text => n.nodeType === Node.TEXT_NODE && TEX.test(n.nodeValue ?? ''));
      t.replaceWith(frag);
      if (miss) left.push(...rest);
    } else if (miss || TEX.test(s)) left.push(t);
  }
  return left;
}

/** the renderings MathJax just made, kept by their TeX */
function remember(): void {
  const items = window.MathJax?.startup?.document?.math;
  if (!items) return;
  for (const item of items as Iterable<{ math: string; display: boolean; typesetRoot: Element | null }>) {
    const root = item.typesetRoot;
    if (!root || !root.isConnected || root.querySelector('mjx-merror, [data-mjx-error]')) continue;
    const key = keyOf(item.math, !!item.display);
    if (typeset0.has(key)) continue;
    if (typeset0.size >= 400) typeset0.delete(typeset0.keys().next().value!);
    typeset0.set(key, root.cloneNode(true) as Element);
  }
}

/** hidden until typeset: the elements of texts with TeX */
function hideRaw(texts: Text[]): void {
  for (const t of texts) t.parentElement?.setAttribute(WAIT, '');
}
function showRaw(els: Element[] | null): void {
  for (const root of els ?? [document.documentElement]) {
    if (!root.isConnected) continue;
    root.removeAttribute(WAIT);
    for (const e of Array.from(root.querySelectorAll(`[${WAIT}]`))) e.removeAttribute(WAIT);
  }
}

/* ------------------------------------------------------------------ MathJax */

/**
 * At the start: the page's formulas hidden and MathJax on its way (typesetPage typesets them once
 * the page's fonts are there — MathJax matches their x-height).
 */
export function startMath(): void {
  parsing?.disconnect();
  parsing = null;
  if (loading) return;
  if (pageHasMath()) { own = true; loading = Promise.resolve(); showRaw(null); return; }
  const raw = document.body ? texTexts(document.body) : [];
  // math may come later (an edit): MathJax is loaded then
  if (!raw.length) return;
  waitCss();
  hideRaw(raw);
  loading = load();
}

function waitCss(): void {
  if (document.querySelector('style[data-ol-texwait-css]')) return;
  const s = document.createElement('style');
  s.setAttribute('data-ol-runtime', '');
  s.setAttribute('data-ol-texwait-css', '');
  // (invisible, not hidden: it keeps taking clicks — a double-click on a formula still being typeset retypes it)
  s.textContent = `[${WAIT}] { opacity: 0 !important; }`;
  (document.head ?? document.documentElement).appendChild(s);
}

/**
 * While the page is parsed (the runtime is the first thing in its <head>): an element is hidden as
 * soon as a formula's TeX arrives in it, before the browser can paint it — startMath takes over.
 */
let parsing: MutationObserver | null = null;
if (document.readyState === 'loading') {
  waitCss();
  const look = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) { if (TEX.test(n.nodeValue ?? '') && processed(n)) n.parentElement?.setAttribute(WAIT, ''); }
    else if (n.nodeType === Node.ELEMENT_NODE) hideRaw(texTexts(n as Element));
  };
  parsing = new MutationObserver(recs => {
    for (const r of recs) {
      if (r.type === 'characterData') look(r.target);
      else for (const n of Array.from(r.addedNodes)) look(n);
    }
  });
  parsing.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
}

/** the page typeset (nothing to do when the page has no math or its own library) */
export function typesetPage(): Promise<void> {
  return pageDone ??= (async () => {
    startMath();
    if (!loading || own) return;
    await loading;
    await run(null);
  })();
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
        typeset: false,
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
    s.onerror = () => { showRaw(null); resolve(); };
    document.head.appendChild(s);
  });
}

async function run(els: Element[] | null): Promise<void> {
  const mj = window.MathJax;
  try { if (mj?.typesetPromise) await mj.typesetPromise(els ?? undefined); } catch { /* a formula MathJax cannot parse shows as its error */ }
  remember();
  showRaw(els);
}

/** OverLyX's MathJax typesets the page (not the page's own math library, not "no math at all") */
export function mathTypeset(): boolean { return !own && !!window.MathJax?.startup; }

/** typeset math in elements put into the page (after an edit): formulas typeset before at once, the others hidden until MathJax has them */
export async function typeset(els: Element[]): Promise<void> {
  if (own || !els.length) return;
  const left = reuse(els);
  if (!left.length) return;
  if (!loading) {
    startMath();
    if (!loading) return;
  } else hideRaw(left);
  await loading;
  if (!pageDone) { await typesetPage(); return; }
  await pageDone;
  await run(els.filter(e => e.isConnected));
}

/** forget the math of elements taken out of the page */
export function untypeset(els: Element[]): void {
  const mj = window.MathJax;
  if (own || !mj?.typesetClear || !els.length) return;
  try { mj.typesetClear(els); } catch { /* ignore */ }
}
