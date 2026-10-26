/**
 * Links to a place in a file — GitHub's "Copy permalink" for every kind of file OverLyX opens. The
 * right-click menus copy `https://overlyx.app/#/<owner>/<project>/<path>?<place>`; opening one goes
 * there and marks the place until the next click or key. The place is said in the file's own terms:
 *
 *   documents   `goto=<label>` where the place carries a label; else `text=<its first words>`, with
 *               `end=<its last words>` when it is long and `before=<the words before it>` when its
 *               first words occur earlier in the document (`n=<k>`: the k-th time, when even those
 *               recur) — Chrome's "Copy link to highlight": a quote outlives the co-authors' edits
 *               that would move a line number. A formula is quoted as `$…$` / `\[…\]`, a picture as
 *               `\includegraphics{file}`. Words edited away since: the longest beginning still there.
 *   text files  `line=12` or `line=12-20` (GitHub's #L12-L20)
 *   PDF files   `page=3`
 *   decks, posters, web pages  `slide=3`, an object on it `obj=2.1` (its place among the slide's
 *               elements; on a web page among the page's)
 *
 * A document's link also says how it was shown, `view=wysiwym,pdf` (app/panes.ts viewParam): the
 * panes left to right and whether on pages — the person opening it sees what the sender saw.
 *
 * What a file's address is, the shell says (`editorContext.webLink`): the web app its own origin,
 * the VS Code extension the overlyx.app project its folder is synced with — no link without one.
 */
import type { EditorView } from 'prosemirror-view';
import { TextSelection } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { paramMap, unquote } from '@overlyx/core';
import { editorContext, viewDocId } from './context';
import type { MenuItem } from './contextmenu';

export interface Place {
  text?: string; end?: string; before?: string; n?: number;
  /** 1-based, first and last */
  line?: [number, number];
  page?: number;
  /** 1-based */
  slide?: number;
  obj?: number[];
}

/** The query that says `p` (without the "?"): `goto` first, then the place's own fields. */
export function placeQuery(p: Place & { goto?: string; view?: string | null }): string {
  const q = new URLSearchParams();
  if (p.goto) q.set('goto', p.goto);
  if (p.text !== undefined) {
    q.set('text', p.text);
    if (p.end) q.set('end', p.end);
    if (p.before) q.set('before', p.before);
    if (p.n && p.n > 1) q.set('n', String(p.n));
  }
  if (p.line) q.set('line', p.line[0] === p.line[1] ? String(p.line[0]) : `${p.line[0]}-${p.line[1]}`);
  if (p.page) q.set('page', String(p.page));
  if (p.slide) q.set('slide', String(p.slide));
  if (p.obj?.length) q.set('obj', p.obj.join('.'));
  if (p.view) q.set('view', p.view);
  // (spaces as %20, not "+": the quote stays readable where links are pasted; the view's commas as they are)
  return q.toString().replace(/\+/g, '%20').replace(/%2C/gi, ',');
}

/** The place a link's query names (`goto` / `heading` are the shell's), null when it names none. */
export function parsePlace(q: URLSearchParams | null): Place | null {
  if (!q) return null;
  const p: Place = {};
  const int = (s: string | null) => (s && /^\d+$/.test(s) ? Number(s) : 0);
  const text = q.get('text');
  if (text) {
    p.text = text;
    if (q.get('end')) p.end = q.get('end')!;
    if (q.get('before')) p.before = q.get('before')!;
    if (int(q.get('n')) > 1) p.n = int(q.get('n'));
  }
  const line = /^(\d+)(?:-L?(\d+))?$/.exec(q.get('line') ?? '');
  if (line && Number(line[1]) > 0) { const a = Number(line[1]), b = Number(line[2] ?? line[1]); p.line = [Math.min(a, b), Math.max(a, b)]; }
  if (int(q.get('page'))) p.page = int(q.get('page'));
  if (int(q.get('slide'))) p.slide = int(q.get('slide'));
  const obj = q.get('obj');
  if (obj && /^\d+(\.\d+)*$/.test(obj)) p.obj = obj.split('.').map(Number);
  return Object.keys(p).length ? p : null;
}

/** The ids of the address: each path segment encoded (a link pasted into a chat stays one link), the viewer's prefix kept. */
export const hashOfId = (id: string) => id.split('/').map(s => encodeURIComponent(s).replace(/%3A/gi, ':')).join('/');

/** The web app's address of a file (its tab id: a document's id, `text:` / `pdf:` ones). */
export const webAppLink = (id: string) => `${location.origin}${location.pathname}#/${hashOfId(id)}`;

/** Whether this shell can make links (the VS Code extension: only for a folder synced with a project). */
export const canLink = (id: string) => !!id && !!editorContext.webLink?.(id);

/**
 * Copy the link to `place` in the file `id` and say so (`what`: "this paragraph", "line 12", …), with
 * the view the file is shown in when it is the open document. Nothing when the shell has no address for the file.
 */
export function copyPlaceLink(id: string, place: (Place & { goto?: string }) | null, what: string): void {
  const base = editorContext.webLink?.(id);
  const view = editorContext.linkView?.(id);
  if (base) copyLinkAt(base, view ? { ...place, view } : place, what);
}

/** Copy the link to `place` in the file at the address `base`, and say so (`notify`; the editor's by default). */
export function copyLinkAt(base: string, place: (Place & { goto?: string; view?: string | null }) | null, what: string, notify = editorContext.notify): void {
  const q = place ? placeQuery(place) : '';
  const url = base + (q ? '?' + q : '');
  if (editorContext.askLinkScope) { editorContext.askLinkScope(url, what); return; }
  const done = () => notify?.(`Link to ${what} copied`);
  const failed = () => notify?.('The link could not be copied: ' + url, 'error');
  try {
    const w = navigator.clipboard?.writeText(url);
    if (w) { w.then(done, () => (legacyCopy(url) ? done() : failed())); return; }
  } catch { /* below */ }
  if (legacyCopy(url)) done(); else failed();
}

/** The link `url` with a share link's token: whoever opens it joins the project first, then lands on the place (app/App.tsx). */
export function withShareToken(url: string, token: string): string {
  const q = url.indexOf('?', url.indexOf('#'));
  return q < 0 ? `${url}?share=${token}` : `${url.slice(0, q)}?share=${token}&${url.slice(q + 1)}`;
}

/**
 * Put `text` on the clipboard — also text still to come (a share link being made): Safari takes
 * the write only inside the click, so the clipboard is handed the promise; false: refused.
 */
export async function copyText(text: string | Promise<string>): Promise<boolean> {
  if (typeof text !== 'string' && typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    try { await navigator.clipboard.write([new ClipboardItem({ 'text/plain': text.then(t => new Blob([t], { type: 'text/plain' })) })]); return true; } catch { /* below */ }
  }
  const s = await text;
  try { await navigator.clipboard.writeText(s); return true; } catch { return legacyCopy(s); }
}

/** execCommand('copy') from a scratch field: where the async clipboard is refused (an unfocused webview, an old Safari) */
function legacyCopy(s: string): boolean {
  const ta = document.createElement('textarea');
  ta.value = s; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
  const back = document.activeElement as HTMLElement | null;
  document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* no */ }
  ta.remove(); back?.focus?.({ preventScroll: true });
  return ok;
}

/* ------------------------------------------------------------- documents: the place as a quote */

/** A document's text as its links quote it, each character with the document range it stands for. */
export interface DocText { text: string; from: number[]; to: number[] }

/** what an inline object is in the quoted text: formulas and pictures as their LaTeX, the rest one placeholder character */
function atomText(n: PMNode): string {
  switch (n.type.name) {
    case 'math_inline': return `$${n.attrs.latex}$`;
    case 'math_display': return `\\[${n.attrs.latex}\\]`;
    case 'graphics': {
      let file = '';
      try { file = unquote(paramMap(JSON.parse(n.attrs.params || '[]')).get('filename')); } catch { /* none */ }
      return `\\includegraphics{${file}}`;
    }
    case 'quotes': return '"';
    case 'space': case 'newline': return ' ';
    default: return '￼';
  }
}

export function docText(doc: PMNode): DocText {
  const parts: string[] = [];
  const from: number[] = [], to: number[] = [];
  const put = (s: string, f: number, t: number) => { parts.push(s); for (let k = 0; k < s.length; k++) { from.push(f); to.push(t); } };
  doc.descendants((n, pos) => {
    if (n.isText) {
      const s = n.text!.replace(/ /g, ' ');
      parts.push(s);
      for (let k = 0; k < s.length; k++) { from.push(pos + k); to.push(pos + k + 1); }
      return false;
    }
    if (n.isTextblock) { if (from.length) put('\n', pos + 1, pos + 1); return true; }
    if (n.isInline && n.isAtom) { put(atomText(n), pos, pos + n.nodeSize); return false; }
    return true;
  });
  return { text: parts.join(''), from, to };
}

const MAX_EXACT = 80, START_MIN = 24, END_MIN = 12, CONTEXT_MAX = 80, FUZZY_MIN = 12;
const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c);
/** the first word boundary at or after `k` (the end of `s` at the latest) */
const wordEnd = (s: string, k: number) => { while (k < s.length && !isSpace(s[k])) k++; return Math.min(k, s.length); };
/** the start of the word `k` lies in (0 at the earliest) */
const wordStart = (s: string, k: number) => { k = Math.max(0, k); while (k > 0 && !isSpace(s[k - 1])) k--; return k; };
/** the index of the `n`-th occurrence of `s` in `t` (-1: fewer) */
function nth(t: string, s: string, n: number): number {
  let i = -1;
  for (let k = 0; k < n; k++) { i = t.indexOf(s, i + 1); if (i < 0) return -1; }
  return i;
}

/** The quote that finds the document range `from`–`to` (null: no text there). */
export function quotePlace(dt: DocText, from: number, to: number): Place | null {
  const t = dt.text;
  let a = dt.from.findIndex(f => f >= from), b = a;
  if (a < 0) return null;
  while (b < t.length && dt.to[b] <= Math.max(to, from + 1)) b++;
  while (a < b && isSpace(t[a])) a++;
  while (b > a && isSpace(t[b - 1])) b--;
  if (a >= b) return null;
  const s = t.slice(a, b);
  const p: Place = {};
  let k = s.length;
  if (s.length > MAX_EXACT) {
    // the first words: enough of them to be found here first (or as many as fit)
    k = wordEnd(s, START_MIN);
    while (t.indexOf(s.slice(0, k)) !== a && k < MAX_EXACT && k < s.length - END_MIN) k = wordEnd(s, k + 1);
    // the last words: the first of them after the start ending where the place ends
    let j = wordStart(s, s.length - END_MIN);
    while (j > k && t.indexOf(s.slice(j), a + k) !== a + j) j = wordStart(s, j - 1);
    if (j > k) p.end = s.slice(j); else k = s.length;
  }
  p.text = s.slice(0, k);
  if (t.indexOf(p.text) !== a) {
    // words before it, until the two together are found here first
    let i = a;
    do { i = wordStart(t, i - 1); } while (i > 0 && a - i < CONTEXT_MAX && t.indexOf(t.slice(i, a) + p.text) !== i);
    p.before = t.slice(i, a);
    const whole = p.before + p.text;
    if (t.indexOf(whole) !== i) { let n = 1; for (let x = t.indexOf(whole); x >= 0 && x < i; x = t.indexOf(whole, x + 1)) n++; p.n = n; }
  }
  return p;
}

/** Where a quote is in the document (`exact`: all of its words were found), null when it is gone. */
export function findPlace(dt: DocText, p: Place): { from: number; to: number; exact: boolean } | null {
  const t = dt.text, start = p.text;
  if (!start) return null;
  let at = -1, len = start.length, exact = true;
  if (p.before) { const i = nth(t, p.before + start, p.n ?? 1); if (i >= 0) at = i + p.before.length; }
  if (at < 0) at = nth(t, start, p.before ? 1 : p.n ?? 1);
  if (at < 0) at = t.indexOf(start);
  // edited since: its longest beginning that is still there
  for (let k = wordStart(start, start.length - 1); at < 0 && k >= FUZZY_MIN; k = wordStart(start, k - 1)) {
    const head = start.slice(0, k).trimEnd();
    at = p.before ? t.indexOf(p.before + head) : -1;
    if (at >= 0) at += p.before!.length; else at = t.indexOf(head);
    len = head.length; exact = false;
  }
  if (at < 0) return null;
  let b = at + len;
  if (p.end) { const e = t.indexOf(p.end, b); if (e >= 0) b = e + p.end.length; else exact = false; }
  return { from: dt.from[at], to: dt.to[b - 1], exact };
}

/** the first label of a node (a section heading's, a float's caption's, a numbered equation's) */
export function labelIn(node: PMNode): string | null {
  let found: string | null = null;
  const of = (n: PMNode) => {
    if (n.type.name === 'command' && n.attrs.cmd === 'label') { try { return unquote(paramMap(JSON.parse(n.attrs.params || '[]')).get('name')) || null; } catch { return null; } }
    if (n.type.name === 'math_display') return /\\label\{([^}]+)\}/.exec(String(n.attrs.latex))?.[1] ?? null;
    return null;
  };
  found = of(node);
  if (!found) node.descendants(n => { if (found) return false; found = of(n); return !found; });
  return found;
}

/**
 * "Copy link to <what>": the document range `range()` gives when chosen — by its label where it has
 * one, else quoted. None where the shell has no address for the document.
 */
export function placeLinkItems(view: EditorView, what: string, range: () => { from: number; to: number; label: string | null } | null): MenuItem[] {
  const id = viewDocId(view);
  if (!canLink(id)) return [];
  return [{ label: `Copy link to ${what}`, icon: 'link', action: () => {
    const r = range();
    const place = r && (r.label ? { goto: r.label } : quotePlace(docText(view.state.doc), r.from, r.to));
    if (place) copyPlaceLink(id, place, what);
    else editorContext.notify?.('Nothing here to link to', 'error');
  } }];
}

/** the formula's entry (nodeviews/math.ts): a numbered equation by its label */
export function formulaLinkItems(view: EditorView, getPos: () => number | undefined): MenuItem[] {
  return placeLinkItems(view, 'this formula', () => {
    const pos = getPos(), node = pos === undefined ? null : view.state.doc.nodeAt(pos);
    return node ? { from: pos!, to: pos! + node.nodeSize, label: labelIn(node) } : null;
  });
}

/**
 * Go to the place a link names in the editor: the caret to its start (not selected — typing must
 * not replace what was linked to), scrolled into view and marked. False when it is not there.
 */
export function showPlace(view: EditorView, p: Place): boolean {
  const r = findPlace(docText(view.state.doc), p);
  if (!r) { editorContext.notify?.('The linked text is no longer in the document', 'error'); return false; }
  view.focus();
  view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(r.from))).scrollIntoView());
  const range = document.createRange();
  try {
    const s = view.domAtPos(r.from), e = view.domAtPos(r.to);
    range.setStart(s.node, s.offset); range.setEnd(e.node, e.offset);
  } catch { return true; }
  // (after the scroll has been laid out; not over the toolbars when scrolled under them)
  const scroller = scrollParent(view.dom);
  requestAnimationFrame(() => markPlace(() => (view.dom.isConnected ? [...range.getClientRects()] : []), () => scroller?.getBoundingClientRect() ?? null));
  if (!r.exact) editorContext.notify?.('The linked text has changed since: its beginning is marked');
  return true;
}

/* ------------------------------------------------------------- the mark over a place */

let unmark: (() => void) | null = null;

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) if (/(auto|scroll)/.test(getComputedStyle(p).overflowY)) return p;
  return null;
}

/** Rectangles merged into one per line (a range's rects repeat for nested elements). */
function lineRects(rects: DOMRect[]): { left: number; top: number; right: number; bottom: number }[] {
  const out: { left: number; top: number; right: number; bottom: number }[] = [];
  for (const r of rects.filter(r => r.width > 0.5 && r.height > 0.5).sort((x, y) => x.top - y.top)) {
    const same = out.find(o => Math.min(o.bottom, r.bottom) - Math.max(o.top, r.top) > 0.5 * Math.min(o.bottom - o.top, r.height));
    if (same) { same.left = Math.min(same.left, r.left); same.right = Math.max(same.right, r.right); same.top = Math.min(same.top, r.top); same.bottom = Math.max(same.bottom, r.bottom); }
    else out.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
  }
  return out;
}

/**
 * Mark the screen rectangles `rects()` gives (asked again as the page scrolls or resizes), inside
 * `clip()` — GitHub's yellow lines — until the next click or key, or until there are none.
 */
export function markPlace(rects: () => DOMRect[], clip: () => DOMRect | null = () => null): void {
  unmark?.();
  const layer = document.createElement('div');
  layer.className = 'place-mark-layer';
  layer.setAttribute('aria-hidden', 'true');
  document.body.appendChild(layer);
  let raf = 0;
  const draw = () => {
    raf = 0;
    const all = rects();
    if (!all.length) { stop(); return; }
    const c = clip();
    if (c) layer.style.clipPath = `inset(${c.top}px ${innerWidth - c.right}px ${innerHeight - c.bottom}px ${c.left}px)`;
    const rs = lineRects(all);
    while (layer.children.length > rs.length) layer.lastChild!.remove();
    while (layer.children.length < rs.length) { const d = document.createElement('div'); d.className = 'place-mark'; layer.appendChild(d); }
    rs.forEach((r, i) => Object.assign((layer.children[i] as HTMLElement).style, { left: `${r.left - 2}px`, top: `${r.top - 1}px`, width: `${r.right - r.left + 4}px`, height: `${r.bottom - r.top + 2}px` }));
  };
  const later = () => { if (!raf) raf = requestAnimationFrame(draw); };
  const born = performance.now();
  // (the click or key that followed the link itself does not count)
  const end = () => { if (performance.now() - born > 150) stop(); };
  const stop = () => {
    cancelAnimationFrame(raf);
    layer.remove();
    removeEventListener('scroll', later, true); removeEventListener('resize', later);
    removeEventListener('pointerdown', end, true); removeEventListener('keydown', end, true);
    if (unmark === stop) unmark = null;
  };
  unmark = stop;
  addEventListener('scroll', later, true); addEventListener('resize', later);
  addEventListener('pointerdown', end, true); addEventListener('keydown', end, true);
  draw();
}
