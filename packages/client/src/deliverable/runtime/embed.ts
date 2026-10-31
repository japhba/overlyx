/**
 * One HTML block of an article (core html/article.ts) as the document editor shows it: running. The
 * server serves the whole page — its styles and scripts, which may draw into the block — with the
 * block between two markers (deliverables.ts embedHtml); everything else on the page is hidden, the
 * block sits flush in the frame, and the frame's height follows the block's (an `embedSize`
 * message to the editor, client editor/articleblocks.ts).
 */
import { follow, type FollowTarget } from './follow';
import { startColumn, columnSettled } from './column';
import { startViewZoom, setViewZoom, stepViewZoom, viewZoom } from './viewzoom';

let shown: Element[] = [];

/** the block's elements: between the server's markers */
function markedBlock(): Element[] {
  const start = document.querySelector('template[data-ol-embed]'), end = document.querySelector('template[data-ol-embed-end]');
  const out: Element[] = [];
  if (!start || !end || start.parentNode !== end.parentNode) return out;
  for (let n = start.nextSibling; n && n !== end; n = n.nextSibling) if (n instanceof Element) out.push(n);
  return out;
}

function sendSize(): void {
  if (window.parent === window) return;
  let height = 0;
  for (const el of shown) {
    const r = el.getBoundingClientRect();
    if (getComputedStyle(el).display !== 'none') height = Math.max(height, r.bottom + scrollY);
  }
  window.parent.postMessage({ ol: 'embedSize', height: Math.ceil(height), found: shown.length > 0 }, '*');
}

export function startEmbed(): void {
  shown = markedBlock();
  const chain = new Set<Element>();
  for (const el of shown) for (let a: Element | null = el; a; a = a.parentElement) chain.add(a);
  const inBlock = (el: Element) => shown.some(s => s === el || s.contains(el));
  const style = document.createElement('style');
  style.setAttribute('data-ol-runtime', '');
  // the page's own frame around the block (padding, centring, background) is the editor's now
  style.textContent = `html, body { background: transparent !important; overflow: hidden !important; }
    [data-ol-embed-chain] { margin: 0 !important; padding: 0 !important; max-width: none !important; min-height: 0 !important; border: 0 !important; transform: none !important; box-shadow: none !important; }
    [data-ol-embed-hidden] { display: none !important; }
    [data-ol-embed-block] { margin-top: 0 !important; margin-bottom: 0 !important; }`;
  document.head.appendChild(style);
  for (const el of Array.from(document.body?.querySelectorAll('*') ?? [])) {
    if (chain.has(el)) { if (!shown.includes(el)) el.setAttribute('data-ol-embed-chain', ''); continue; }
    if (inBlock(el) || !el.parentElement || !chain.has(el.parentElement)) continue;
    if (/^(SCRIPT|STYLE|LINK|TEMPLATE|META)$/.test(el.tagName)) continue;
    el.setAttribute('data-ol-embed-hidden', '');
  }
  if (document.body) document.body.setAttribute('data-ol-embed-chain', '');
  for (const el of shown) el.setAttribute('data-ol-embed-block', '');
  const ro = new ResizeObserver(sendSize);
  ro.observe(document.documentElement);
  for (const el of shown) ro.observe(el);
  sendSize();
}

/** fonts, math and pictures are in: the final size */
export function embedSettled(): void {
  sendSize();
}

/**
 * A page shown beside its article in the editor (client app/ArticlePage.tsx): where it is scrolled to,
 * and how far a pinch magnified it (viewzoom.ts), goes to the editor, which brings a reloaded page back there; the paragraph the editor's cursor is
 * in is brought into view (follow.ts); its text column is as wide as the ruler over it says (column.ts).
 */
export function startViewSync(): void {
  if (window.parent === window) return;
  startColumn();
  // where the page is scrolled to and how far a pinch magnified it (viewzoom.ts)
  let pending = false;
  const tell = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; window.parent.postMessage({ ol: 'viewScroll', y: scrollY, x: scrollX, z: viewZoom() }, '*'); });
  };
  addEventListener('scroll', tell, { passive: true });
  startViewZoom(tell);
  addEventListener('message', e => {
    const d = e.data as { ol?: string; y?: number; x?: number; z?: number } | null;
    if (e.source === window.parent && d?.ol === 'viewScrollTo' && typeof d.y === 'number') {
      if (typeof d.z === 'number') setViewZoom(d.z);
      scrollTo({ left: typeof d.x === 'number' ? d.x : 0, top: d.y, behavior: 'instant' });
    }
    // the pane's − / + (or Ctrl/⌘ + − pressed in the editor beside it): a step of the zoom, 0 back to the page as it is
    const step = (d as { step?: unknown } | null)?.step;
    if (e.source === window.parent && d?.ol === 'viewZoomStep' && (step === 1 || step === -1 || step === 0)) stepViewZoom(step);
    // the editor's cursor moved to another paragraph (follow.ts)
    const t = (d as { target?: FollowTarget } | null)?.target;
    if (e.source === window.parent && d?.ol === 'viewFollow' && t && Array.isArray(t.words) && t.words.every(w => typeof w === 'string')) {
      follow({ words: t.words.slice(0, 400), nth: Number(t.nth) || 0, frac: Number(t.frac) || 0, flash: !!t.flash });
    }
  });
}

/** the page has settled (fonts, math, pictures): the editor may scroll it now */
export function viewSettled(): void {
  if (window.parent === window) return;
  columnSettled();
  window.parent.postMessage({ ol: 'viewReady' }, '*');
}
