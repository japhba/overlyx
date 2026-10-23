/**
 * The text column of a page shown beside its article (client app/ArticlePage.tsx), for the ruler over
 * the page: found — the element that holds most of the page's paragraphs and sets their width —,
 * reported to the editor (where its text runs, as wide as the page makes it, as wide as it can get),
 * and given the width the ruler asks for. That width is the reader's, like the editor's text width:
 * a rule of the runtime's on the page shown, never written to the page.
 */

/** the width asked for, from the ruler: the text's (px), 0 the whole width there is, null the page's own */
let want: number | null = null;
let column: HTMLElement | null = null;
let style: HTMLStyleElement | null = null;
/** the column's own width and its widest, measured again when the frame's width changes */
let own = 0, full = 0;

const OUTSIDE = 'nav, header, footer, aside, template, [data-ol-runtime]';

const px = (v: string) => parseFloat(v) || 0;
/** the column's padding and borders, left and right */
function sides(el: HTMLElement): { left: number; right: number } {
  const c = getComputedStyle(el);
  return { left: px(c.paddingLeft) + px(c.borderLeftWidth), right: px(c.paddingRight) + px(c.borderRightWidth) };
}
/** how wide the column's text runs now */
function textWidth(el: HTMLElement): number {
  const c = getComputedStyle(el);
  return el.clientWidth - px(c.paddingLeft) - px(c.paddingRight);
}

/** freed of the page's width rules (FULL), it gets wider */
function widens(el: HTMLElement): boolean {
  const before = el.offsetWidth;
  el.setAttribute('data-ol-column', 'full');
  const after = el.offsetWidth;
  el.removeAttribute('data-ol-column');
  return after > before + 1;
}

/**
 * The element whose width is the text's: the innermost holding half the text of the page's
 * paragraphs (not its navigation or notes), or the first one around it that would be wider without
 * the page's width rules (a body with a max-width around an article without one). A page without
 * paragraphs has none.
 */
function findColumn(): HTMLElement | null {
  const weight = new Map<HTMLElement, number>();
  let total = 0;
  for (const p of Array.from(document.querySelectorAll('p'))) {
    if (p.closest(OUTSIDE)) continue;
    const n = (p.textContent ?? '').trim().length;
    if (!n) continue;
    total += n;
    for (let a = p.parentElement; a && a !== document.documentElement; a = a.parentElement) weight.set(a, (weight.get(a) ?? 0) + n);
  }
  let root: HTMLElement | null = null;
  for (const [el, n] of weight) if (n * 2 >= total && (!root || root.contains(el))) root = el;
  if (!root) return null;
  for (let el: HTMLElement | null = root; el && el !== document.documentElement; el = el.parentElement) if (widens(el)) return el;
  return root;
}

const FULL = '[data-ol-column="full"] { max-width: none !important; width: auto !important; flex: 1 1 auto !important; }';

/** the width asked for, on the column (none: the page's own) */
function apply(): void {
  if (!style) {
    style = document.createElement('style');
    style.setAttribute('data-ol-runtime', '');
    (document.head ?? document.documentElement).appendChild(style);
  }
  column?.removeAttribute('data-ol-column');
  let set = '';
  // (centred in the room the page gives it, never wider than that room)
  if (column && want) {
    const s = sides(column);
    set = `\n[data-ol-column="set"] { box-sizing: border-box !important; width: ${want + s.left + s.right}px !important; max-width: 100% !important; margin-left: auto !important; margin-right: auto !important; flex: 0 1 auto !important; }`;
  }
  style.textContent = FULL + set;
  if (column && want !== null) column.setAttribute('data-ol-column', want === 0 ? 'full' : 'set');
}

/** the column's own width and its widest, at the frame's width now */
function measure(): void {
  if (!column) return;
  const was = column.getAttribute('data-ol-column');
  column.removeAttribute('data-ol-column');
  own = textWidth(column);
  column.setAttribute('data-ol-column', 'full');
  full = textWidth(column);
  if (was) column.setAttribute('data-ol-column', was); else column.removeAttribute('data-ol-column');
}

function send(): void {
  if (window.parent === window) return;
  if (!column) { window.parent.postMessage({ ol: 'viewColumn', none: true }, '*'); return; }
  const r = column.getBoundingClientRect(), s = sides(column);
  window.parent.postMessage({ ol: 'viewColumn', left: r.left + s.left, width: textWidth(column), own, full: Math.max(full, own) }, '*');
}

let queued = false, remeasure = false;
/** applied and reported at the next frame (a dragged handle asks many times a frame) */
function update(again: boolean): void {
  remeasure ||= again;
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    if (remeasure) { remeasure = false; measure(); }
    apply();
    send();
  });
}

/** the width the page loads with (the editor's `w` in its address), set before it shows */
export function startColumn(): void {
  const w = new URLSearchParams(location.search).get('w');
  want = w !== null && /^\d{1,5}$/.test(w) ? Number(w) : null;
  apply();
  column = findColumn();
  apply();
  addEventListener('message', e => {
    const d = e.data as { ol?: string; width?: unknown } | null;
    if (e.source !== window.parent || d?.ol !== 'viewWidth') return;
    want = typeof d.width === 'number' && d.width >= 0 && d.width < 1e5 ? Math.round(d.width) : null;
    update(false);
  });
  addEventListener('resize', () => update(true));
}

/** the page's scripts have built it: its column found again, and reported */
export function columnSettled(): void {
  column?.removeAttribute('data-ol-column');
  column = findColumn();
  update(true);
}
