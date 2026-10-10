/**
 * Citations in a deliverable, as LaTeX shows them: every `\cite{key}` (natbib's \citep, \citet …)
 * of the page's text becomes its label — `[1]`, `Knuth (1984)` — and an element of class
 * "ol-bibliography" lists the works cited (numbered in the order first cited, or by author and year:
 * `<meta name="overlyx-citations" content="authoryear">`). The entries come with the page
 * (window.__OL.bib, from the project's .bib files) and from the editor for keys cited since
 * (`bib` messages). A key no .bib file has shows `?`, as in LaTeX.
 *
 * A rendered citation is an <ol-cite> element (the runtime's, not the source's: env.ts isForeign)
 * keeping its LaTeX in data-ol-cite; while a text is retyped, its citations are chips
 * (runtime/mathedit.ts) labelled here too.
 */
import { findCites, citeRegExp, hasCite, citeNumbers, citeText, referencePieces, bibliographyOrder, type CiteEntry, type CiteStyle } from '@overlyx/core/html/refs.ts';
import { MODE } from './env';

const entries = new Map<string, CiteEntry>(Object.entries(window.__OL?.bib ?? {}));
const style: CiteStyle = window.__OL?.citeStyle ?? 'numeric';
export const CITE_WAIT = 'data-ol-citewait';

/** texts a citation is looked for in (not code, scripts, formulas, the runtime's own, a text being retyped) */
function eligible(n: Node): boolean {
  const el = n.parentElement;
  return !!el && !el.closest('script, style, textarea, code, pre, mjx-container, ol-cite, [data-ol-runtime], [contenteditable="true"], .ol-notex');
}

/** the citations written in `roots` rendered (their labels set by refreshCites) */
export function renderCites(roots: Element[]): boolean {
  let any = false;
  for (const root of roots) {
    if (!root.isConnected) continue;
    const texts: Text[] = [];
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) if (hasCite(n.nodeValue ?? '') && eligible(n)) texts.push(n as Text);
    for (const t of texts) {
      const s = t.nodeValue ?? '';
      const frag = document.createDocumentFragment();
      let last = 0;
      for (const m of s.matchAll(citeRegExp())) {
        if (m.index! > last) frag.append(s.slice(last, m.index));
        const c = document.createElement('ol-cite');
        c.setAttribute('data-ol-cite', m[0]);
        frag.append(c);
        last = m.index! + m[0].length;
      }
      if (last < s.length) frag.append(s.slice(last));
      t.replaceWith(frag);
      any = true;
    }
    root.removeAttribute(CITE_WAIT);
    for (const e of Array.from(root.querySelectorAll(`[${CITE_WAIT}]`))) e.removeAttribute(CITE_WAIT);
  }
  return any;
}

/** the keys cited on the page, in order (the editor fetches the entries of new ones) */
export function citedNow(): string[] {
  const keys: string[] = [];
  for (const el of Array.from(document.querySelectorAll('ol-cite, .ol-citechip'))) for (const c of findCites(el.getAttribute('data-ol-cite') ?? '')) keys.push(...c.keys);
  return keys;
}

/** entries the editor sends (keys cited since the page was served) */
export function addEntries(list: CiteEntry[]): void {
  for (const e of list) entries.set(e.key, e);
  refreshCites();
}

/** every citation's label and every list of references as the page's citations are now */
export function refreshCites(): void {
  const els = Array.from(document.querySelectorAll<HTMLElement>('ol-cite, .ol-citechip'));
  const cites = els.map(el => findCites(el.getAttribute('data-ol-cite') ?? '')[0]).filter(Boolean);
  const order: string[] = [];
  for (const c of cites) order.push(...c.keys);
  const numbers = citeNumbers(order);
  for (const el of els) {
    const c = findCites(el.getAttribute('data-ol-cite') ?? '')[0];
    if (!c) continue;
    const text = citeText(c, numbers, entries, style);
    if (el.textContent !== text) el.textContent = text;
    // (keys no .bib file has: the agents' render_page reports them, report.ts)
    const missing = c.keys.filter(k => !entries.has(k));
    if (missing.length) el.setAttribute('data-ol-missing', missing.join(', ')); else el.removeAttribute('data-ol-missing');
    el.title = c.keys.map(k => entries.get(k)?.title ?? `${k}: not in the project's .bib files`).join('\n');
  }
  for (const list of Array.from(document.querySelectorAll<HTMLElement>('.ol-bibliography'))) fillBibliography(list, [...numbers.keys()], numbers);
}

function fillBibliography(el: HTMLElement, keys: string[], numbers: Map<string, number>): void {
  const ks = bibliographyOrder(keys, numbers, entries, style);
  const list = document.createElement(style === 'numeric' ? 'ol' : 'ul');
  list.className = 'ol-refs';
  list.setAttribute('data-ol-runtime', '');
  for (const k of ks) {
    const li = document.createElement('li');
    if (style === 'numeric') li.value = numbers.get(k) ?? 0;
    for (const p of referencePieces(entries.get(k)!)) {
      if (p.em) { const i = document.createElement('i'); i.textContent = p.text; li.append(i); }
      else li.append(p.text);
    }
    list.append(li);
  }
  if (!ks.length && MODE === 'edit') {
    const li = document.createElement('li');
    li.className = 'ol-refs-empty';
    li.textContent = keys.length ? 'The works cited are not in the project’s .bib files.' : 'The works cited (\\cite{…}) are listed here.';
    list.append(li);
  }
  const old = el.querySelector(':scope > .ol-refs');
  if (old && old.outerHTML === list.outerHTML) return;
  if (old) old.replaceWith(list); else el.append(list);
}

export const CITE_CSS = `ol-cite { white-space: nowrap; }
  [${CITE_WAIT}] { opacity: 0 !important; }
  :where(.ol-refs) { margin: 0; padding-left: 2.2em; }
  :where(ol.ol-refs > li)::marker { content: "[" counter(list-item) "]\\2002"; }
  :where(ul.ol-refs) { list-style: none; padding-left: 1.6em; text-indent: -1.6em; }
  :where(.ol-refs > li) { margin: 0 0 .45em; }
  :where(.ol-refs-empty) { list-style: none; opacity: .55; font-style: italic; }`;
