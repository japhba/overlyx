/**
 * The page brought up to date with a new version of its text, touching only what changed: an
 * object retyped on one slide is replaced, everything else keeps its live state — typeset math,
 * what the page's scripts drew, a playing video. Elements are matched by their source; one whose
 * source is unchanged is kept as it is, one whose attributes changed keeps its children, one whose
 * own text changed (or that changed into another element) is made anew and its math typeset.
 * A change of any script reloads the page instead: scripts cannot be run twice safely.
 */
import { state, srcOf, liveOf, link, isForeign, post } from './env';
import { typeset, untypeset } from './math';

/** the element being retyped (contenteditable): left alone until that ends */
export const guard = { editing: null as Element | null };

const parser = new DOMParser();

function kids(el: Element): Element[] {
  return Array.from(el.children).filter(c => !isForeign(c));
}

/** Pair the live page with its source (first version): the elements in order, by name; returns how many source elements found no partner. */
export function pairAll(src: Document): number {
  let missing = 0;
  const pair = (live: Element, s: Element) => {
    link(live, s);
    const lk = kids(live);
    let j = 0;
    for (const c of Array.from(s.children)) {
      let k = j;
      while (k < lk.length && (lk[k].localName !== c.localName || srcOf.has(lk[k]))) k++;
      if (k >= lk.length) { missing++; continue; }
      pair(lk[k], c);
      j = k + 1;
    }
  };
  pair(document.documentElement, src.documentElement);
  return missing;
}

function scriptsOf(d: Document): string {
  return Array.from(d.querySelectorAll('script')).map(s => s.outerHTML).join('\n');
}

/** Take a new version of the text: true when the page was updated in place, false when it reloads. */
export function applySource(html: string, version: number): boolean {
  const next = parser.parseFromString(html, 'text/html');
  const prev = state.src;
  state.html = html;
  state.version = version;
  if (!prev) {
    state.src = next;
    pairAll(next);
    return true;
  }
  if (scriptsOf(prev) !== scriptsOf(next)) {
    state.src = next;
    post({ ol: 'reload' });
    location.reload();
    return false;
  }
  state.src = next;
  const added: Element[] = [];
  reconcile(document.documentElement, prev.documentElement, next.documentElement, added);
  typesetting = typeset(added.filter(a => a.isConnected));
  return true;
}

let typesetting: Promise<void> = Promise.resolve();
/** settles when the formulas of the last version are typeset (formulas typeset before are at once) */
export function whenTypeset(): Promise<void> { return typesetting; }

/** the element's own text (its text nodes), the part a recursion into its children would not see */
function ownText(el: Element): string {
  let s = '';
  for (const n of Array.from(el.childNodes)) if (n.nodeType === Node.TEXT_NODE) s += n.nodeValue;
  // (the whitespace between elements changes with every element put in or taken out)
  return s.replace(/\s+/g, '');
}

/** re-point the live elements of an unchanged subtree at the new source */
function relink(live: Element, s0: Element, s1: Element): void {
  const a = [s0, ...Array.from(s0.querySelectorAll('*'))];
  const b = [s1, ...Array.from(s1.querySelectorAll('*'))];
  for (let i = 0; i < a.length && i < b.length; i++) {
    const l = liveOf.get(a[i]);
    if (l) link(l, b[i]);
  }
  if (!liveOf.get(s1)) link(live, s1);
}

function fresh(s1: Element): Element {
  const el = document.importNode(s1, true);
  const a = [s1, ...Array.from(s1.querySelectorAll('*'))];
  const b = [el, ...Array.from(el.querySelectorAll('*'))];
  for (let i = 0; i < a.length; i++) link(b[i], a[i]);
  return el;
}

function syncAttributes(live: Element, s0: Element, s1: Element): void {
  // only what the source changed: attributes the page's scripts set stay
  for (const a of Array.from(s0.attributes)) if (!s1.hasAttribute(a.name) && !a.name.startsWith('data-ol-')) live.removeAttribute(a.name);
  for (const a of Array.from(s1.attributes)) if (s0.getAttribute(a.name) !== a.value && !a.name.startsWith('data-ol-')) {
    try { live.setAttribute(a.name, a.value); } catch { /* an attribute name the DOM refuses */ }
  }
}

function reconcile(live: Element, s0: Element, s1: Element, added: Element[]): Element {
  if (live === guard.editing) { relink(live, s0, s1); return live; }
  if (s0.outerHTML === s1.outerHTML) { relink(live, s0, s1); return live; }
  if (s0.localName === s1.localName && live.localName === s1.localName && ownText(s0) === ownText(s1) && s1.localName !== 'template') {
    syncAttributes(live, s0, s1);
    link(live, s1);
    reconcileChildren(live, s0, s1, added);
    return live;
  }
  const el = fresh(s1);
  untypeset([live]);
  live.replaceWith(el);
  added.push(el);
  return el;
}

/** match two lists of source elements: identical ones by a longest common subsequence */
function lcs(a: string[], b: string[]): [number, number][] {
  const n = a.length, m = b.length;
  if (n * m > 250000) {
    // big lists: identical prefix and suffix only
    const out: [number, number][] = [];
    let i = 0;
    while (i < n && i < m && a[i] === b[i]) { out.push([i, i]); i++; }
    let k = 0;
    while (k < n - i && k < m - i && a[n - 1 - k] === b[m - 1 - k]) k++;
    for (let t = k; t > 0; t--) out.push([n - t, m - t]);
    return out;
  }
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: [number, number][] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push([i, j]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return out;
}

function reconcileChildren(live: Element, s0: Element, s1: Element, added: Element[]): void {
  const a = Array.from(s0.children), b = Array.from(s1.children);
  const pairs = lcs(a.map(e => e.outerHTML), b.map(e => e.outerHTML));
  const result: (Element | null)[] = new Array(b.length).fill(null);
  const usedA = new Set<number>();
  for (const [i, j] of pairs) {
    usedA.add(i);
    const l = liveOf.get(a[i]);
    if (l && l.parentElement === live) { relink(l, a[i], b[j]); result[j] = l; }
  }
  // the changed ones between two matched ones: in pairs by position (same name) or anew
  const bounds = [...pairs, [a.length, b.length] as [number, number]];
  let pa = 0, pb = 0;
  for (const [ea, eb] of bounds) {
    const ga: number[] = [], gb: number[] = [];
    for (let i = pa; i < ea; i++) if (!usedA.has(i)) ga.push(i);
    for (let j = pb; j < eb; j++) gb.push(j);
    const n = Math.min(ga.length, gb.length);
    for (let k = 0; k < n; k++) {
      const s0c = a[ga[k]], s1c = b[gb[k]];
      const l = liveOf.get(s0c);
      if (l && l.parentElement === live) { result[gb[k]] = reconcile(l, s0c, s1c, added); usedA.add(ga[k]); }
    }
    pa = ea + 1; pb = eb + 1;
  }
  // the source's elements no longer there go
  for (let i = 0; i < a.length; i++) {
    if (usedA.has(i)) continue;
    const l = liveOf.get(a[i]);
    if (l && l.parentElement === live && !result.includes(l)) { untypeset([l]); l.remove(); }
  }
  // new ones, and everything in the source's order (the page's own elements stay where they are)
  let prev: Element | null = null;
  for (let j = 0; j < b.length; j++) {
    let el = result[j];
    if (!el) { el = fresh(b[j]); added.push(el); }
    if (prev) { if (prev.nextElementSibling !== el && el !== prev) prev.after(el); }
    else if (!el.parentElement || el.parentElement !== live) {
      const first = kids(live)[0];
      if (first) first.before(el); else live.appendChild(el);
    } else {
      // the first one: before every other element of the source
      const firstSourced = kids(live).find(k => srcOf.has(k));
      if (firstSourced && firstSourced !== el) firstSourced.before(el);
    }
    prev = el;
  }
}
