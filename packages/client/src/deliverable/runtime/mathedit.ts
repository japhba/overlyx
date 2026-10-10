/**
 * Formulas in a text being retyped are edited with LyX's formula editor. While edit.ts retypes a
 * text, each \( \), \[ \] or $$ $$ of it is a "chip": the typeset formula, one character for the
 * text around it (contenteditable=false). A click on a chip, an arrow key into it or Ctrl+M (a new
 * one) opens LyX's math field over it in the editor: DeliverableEditor lays a LyxMathField exactly
 * over the chip — same font (MathJax's New Computer Modern), same size, same baseline, growing from
 * the same side — and once it is drawn (`mathShown`) the chip is hidden, keeping the room the
 * formula takes. The field sends the formula back as it changes (`mathSet`: the chip typeset
 * again, so the text around it reflows) and when it is left (`mathDone`: the chip shown, then
 * `mathClose` takes the field away — never a moment without the formula). Written back as text
 * the formula keeps the source it had, unless it was changed.
 */
import type { MathBox, KeyPress } from '../protocol';
import { post } from './env';
import { typeset, untypeset } from './math';

const MATH_RE = /\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$/g;
const DELIMS: Record<string, [string, string]> = { '(': ['\\(', '\\)'], '[': ['\\[', '\\]'], '$$': ['$$', '$$'] };

let seq = 0;
/** the chip whose formula is open in the editor */
let open: HTMLElement | null = null;
let openedAt = 0;

export const isChip = (n: Node | null | undefined): n is HTMLElement => n instanceof HTMLElement && n.classList.contains('ol-mathchip');

function chip(tex: string, delim: string, src: string | null): HTMLElement {
  const c = document.createElement('span');
  c.className = 'ol-mathchip ol-tex';
  c.contentEditable = 'false';
  c.dataset.olChip = String(++seq);
  c.dataset.olTex = tex;
  c.dataset.olDelim = delim;
  if (src !== null) { c.dataset.olSrc = src; c.dataset.olSrcTex = tex; }
  const [a, b] = DELIMS[delim];
  c.textContent = a + tex + b;
  return c;
}

/** the formulas of a text (its source markup, just put in) made chips at once, typeset when `ready` resolves */
export function chipify(el: HTMLElement): { chips: HTMLElement[]; ready: Promise<void> } {
  const chips: HTMLElement[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: n => (n.parentElement?.closest('script, style, code, pre, textarea') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const texts: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (/\\\(|\\\[|\$\$/.test(n.nodeValue ?? '')) texts.push(n as Text);
  for (const t of texts) {
    const s = t.nodeValue ?? '';
    const frag = document.createDocumentFragment();
    let last = 0, found = 0;
    for (const m of s.matchAll(MATH_RE)) {
      found++;
      if (m.index! > last) frag.append(s.slice(last, m.index));
      const delim = m[1] !== undefined ? '(' : m[2] !== undefined ? '[' : '$$';
      const c = chip((m[1] ?? m[2] ?? m[3]).trim(), delim, m[0]);
      chips.push(c);
      frag.append(c);
      last = m.index! + m[0].length;
    }
    if (!found) continue;
    if (last < s.length) frag.append(s.slice(last));
    t.replaceWith(frag);
  }
  return { chips, ready: chips.length ? typeset(chips) : Promise.resolve() };
}

/** a chip as text again: its source as written, or the formula as it is now */
export function chipText(c: HTMLElement): string {
  const tex = c.dataset.olTex ?? '';
  if (!tex.trim()) return '';
  if (c.dataset.olSrc !== undefined && c.dataset.olSrcTex === tex) return c.dataset.olSrc;
  const [a, b] = DELIMS[c.dataset.olDelim ?? '('] ?? DELIMS['('];
  return c.dataset.olDelim === '(' ? `${a}${tex}${b}` : `${a} ${tex} ${b}`;
}

/** the chips of a copy of the text (cleanHtml) put back as text */
export function unchip(root: HTMLElement): void {
  for (const c of Array.from(root.querySelectorAll<HTMLElement>('.ol-mathchip'))) {
    // the no-break space a browser types beside an uneditable element is a space
    const p = c.previousSibling, n = c.nextSibling;
    if (p?.nodeType === Node.TEXT_NODE && p.nodeValue?.endsWith('\u00a0')) p.nodeValue = p.nodeValue.slice(0, -1) + ' ';
    if (n?.nodeType === Node.TEXT_NODE && n.nodeValue?.startsWith('\u00a0')) n.nodeValue = ' ' + n.nodeValue.slice(1);
    c.replaceWith(document.createTextNode(chipText(c)));
  }
}

const chipById = (id: number): HTMLElement | null => document.querySelector<HTMLElement>(`.ol-mathchip[data-ol-chip="${id}"]`);

/** MathJax's em per ex of the text (1 / its font's x-height), read off a formula it drew */
let emPerEx = 1 / 0.442;

/** where the chip's formula is drawn: its box, baseline, em and the side it grows from */
function boxOf(c: HTMLElement): MathBox {
  const cont = c.querySelector<HTMLElement>('mjx-container');
  const svg = cont?.querySelector<SVGSVGElement>(':scope > svg') ?? null;
  const s = getComputedStyle(c);
  const vb = svg?.viewBox?.baseVal;
  let r: DOMRect, em: number, baseline: number;
  if (svg && vb && vb.height && svg.getBoundingClientRect().height) {
    // (the viewBox is in thousandths of the math font's em, its y = 0 the baseline)
    const r0 = svg.getBoundingClientRect();
    em = r0.height * 1000 / vb.height;
    baseline = r0.top - vb.y / vb.height * r0.height;
    // an inline formula is in pieces where its line may break (MathJax's inline breaks): all of them on its first line
    let x0 = r0.left, x1 = r0.right, y0 = r0.top, y1 = r0.bottom;
    for (const p of Array.from(cont!.children)) {
      const pr = p.getBoundingClientRect();
      if (p === svg || !pr.width || pr.top >= r0.bottom || pr.bottom <= r0.top) continue;
      x0 = Math.min(x0, pr.left); x1 = Math.max(x1, pr.right); y0 = Math.min(y0, pr.top); y1 = Math.max(y1, pr.bottom);
    }
    r = new DOMRect(x0, y0, x1 - x0, y1 - y0);
    const ex = parseFloat(svg.getAttribute('height') ?? '');
    if (ex > 0) emPerEx = ex * 1000 / vb.height;
  } else {
    // an empty formula: its baseline and the text's x-height from a mark beside it
    r = c.getBoundingClientRect();
    const m = document.createElement('span');
    m.setAttribute('data-ol-runtime', '');
    m.style.cssText = 'display:inline-block;width:0;height:1ex;vertical-align:baseline;padding:0;border:0;margin:0';
    c.after(m);
    const mr = m.getBoundingClientRect();
    m.remove();
    baseline = mr.bottom;
    em = (mr.height || parseFloat(s.fontSize) * 0.45) * emPerEx;
  }
  // a displayed formula is centred in its line by MathJax; an inline one goes with its line
  const ta = getComputedStyle(cont && c.dataset.olDelim !== '(' ? cont : c).textAlign;
  const rtl = s.direction === 'rtl';
  const align = /center/.test(ta) ? 'center' : ta === 'right' || (ta === 'end' && !rtl) || (ta === 'start' && rtl) ? 'right' : 'left';
  return { rect: { x: r.left, y: r.top, w: r.width, h: r.height }, baseline, em, align };
}

/** the editor opens LyX's formula editor on the chip (`at`: a click there, frame client px) */
export function openChip(c: HTMLElement, at: { x: number; y: number } | null, where: 'start' | 'end' = 'end', dollar?: '$' | '$$'): void {
  if (open && open !== c) closeChip();
  open = c;
  openedAt = performance.now();
  held = [];
  post({ ol: 'mathEdit', id: Number(c.dataset.olChip), tex: c.dataset.olTex ?? '', display: c.dataset.olDelim !== '(', box: boxOf(c), color: getComputedStyle(c).color, at, where, dollar });
}

export const keyPress = (e: KeyboardEvent): KeyPress => ({ key: e.key, shift: e.shiftKey || undefined, ctrl: e.ctrlKey || undefined, alt: e.altKey || undefined, meta: e.metaKey || undefined });
export const isModifierKey = (e: KeyboardEvent) => e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta' || e.key === 'AltGraph' || e.key === 'CapsLock';

/** keys typed while the chip was opening (LyX's formula editor had not the keyboard yet) */
let held: KeyPress[] = [];
export function holdKey(k: KeyPress): void { held.push(k); }

/**
 * Keys typed in the text while the formula is being left (the editor gave the keyboard back, its
 * mathDone not here yet): typed once the caret is beside the formula again.
 */
let after: KeyPress[] = [];
let afterTimer: ReturnType<typeof setTimeout> | null = null;
export function holdAfter(k: KeyPress): void {
  after.push(k);
  if (!afterTimer) afterTimer = setTimeout(flushAfter, 600);
}
/** the keys typed ahead after a formula applied now (a click or a new retyping comes after them) */
export function flushAfter(): void {
  if (afterTimer) { clearTimeout(afterTimer); afterTimer = null; }
  const keys = after;
  after = [];
  typeKeysHere(keys, chipHooks.stop);
}
/** edit.ts's end of retyping (an Escape typed ahead) */
export const chipHooks = { stop: () => {} };

/** keys typed ahead, applied to the text being retyped at its caret (what they would have done there) */
export function typeKeysHere(keys: KeyPress[], stop?: () => void): void {
  const sel = getSelection();
  for (const k of keys) {
    if (k.ctrl || k.meta) continue;
    if (k.key.length === 1 && !k.alt) document.execCommand('insertText', false, k.key);
    else if (k.key === 'Backspace') document.execCommand('delete');
    else if (k.key === 'Delete') document.execCommand('forwardDelete');
    else if (k.key === 'Enter') document.execCommand(k.shift ? 'insertLineBreak' : 'insertParagraph');
    else if (k.key === 'ArrowLeft' || k.key === 'ArrowRight') sel?.modify(k.shift ? 'extend' : 'move', k.key === 'ArrowLeft' ? 'backward' : 'forward', 'character');
    else if (k.key === 'Escape') { stop?.(); return; }
  }
}

/** the editor drew its field over the chip: the chip hidden (it keeps its room), the keys typed meanwhile handed over */
export function shownChip(id: number): void {
  const c = chipById(id);
  if (c && c === open) c.setAttribute('data-ol-mathediting', '');
  post({ ol: 'mathKeys', id, keys: c && c === open ? held : [] });
  held = [];
}

/** the formula open in the editor changed: the chip follows (hidden, it keeps the formula's room) */
export async function setChip(id: number, tex: string): Promise<void> {
  const c = chipById(id);
  if (!c) return;
  await render(c, tex);
  if (open === c) post({ ol: 'mathRect', id, box: boxOf(c) });
}

async function render(c: HTMLElement, tex: string): Promise<void> {
  if (c.dataset.olTex === tex && c.querySelector('mjx-container')) return;
  c.dataset.olTex = tex;
  untypeset([c]);
  const [a, b] = DELIMS[c.dataset.olDelim ?? '('] ?? DELIMS['('];
  c.textContent = a + tex + b;
  if (tex.trim()) await typeset([c]);
  else c.textContent = '';
}

/**
 * The formula editor left the formula: the chip shown again (gone when the formula was emptied),
 * the caret beside it on the side it was left by. Returns whether the chip is still there.
 */
export async function doneChip(id: number, tex: string, dir: 'forward' | 'backward' | null, editing: HTMLElement | null, putBack = ''): Promise<boolean> {
  const c = chipById(id);
  if (open === c) open = null;
  if (!c) { post({ ol: 'mathClose', id }); return false; }
  await render(c, tex);
  c.removeAttribute('data-ol-mathediting');
  // the formula is there again: the editor's field can go
  post({ ol: 'mathClose', id });
  const keep = !!tex.trim();
  if (!editing || !editing.contains(c)) { if (!keep) c.remove(); return keep; }
  editing.focus({ preventScroll: true });
  const sel = getSelection();
  if (dir || !keep) {
    const r = document.createRange();
    if (keep && dir === 'forward') r.setStartAfter(c); else r.setStartBefore(c);
    r.collapse(true);
    if (!keep && putBack) {
      // Backspace in the empty formula `$` opened: the typed dollar back as text, the caret after it
      const t = document.createTextNode(putBack);
      // (the space typed before it was the end of the text then: a browser made it a no-break space)
      const p = c.previousSibling;
      if (p?.nodeType === Node.TEXT_NODE && p.nodeValue?.endsWith('\u00a0')) p.nodeValue = p.nodeValue.slice(0, -1) + ' ';
      c.replaceWith(t);
      r.setStart(t, putBack.length); r.collapse(true);
    } else if (!keep) c.remove();
    sel?.removeAllRanges();
    sel?.addRange(r);
  }
  flushAfter();
  return keep;
}

/** the chip open in the editor: closed without its answer (the retyping ended) */
export function closeChip(): void {
  if (!open) return;
  open.removeAttribute('data-ol-mathediting');
  open = null;
  post({ ol: 'mathClose' });
}

export function openChipEl(): HTMLElement | null { return open && open.isConnected ? open : null; }
/** a formula opened that LyX's formula editor has not taken yet (keys typed meanwhile are the formula's) */
export function chipOpening(): boolean { return !!open && open.isConnected && !open.hasAttribute('data-ol-mathediting') && performance.now() - openedAt < 1500; }

/** where the open chip is now (the page scrolled, the text reflowed) */
export function trackChip(): void {
  if (open && open.isConnected) post({ ol: 'mathRect', id: Number(open.dataset.olChip), box: boxOf(open) });
}

/** a new (empty) formula at the caret of the text being retyped, opened at once (`dollar`: by typing `$`) */
export function insertChip(editing: HTMLElement, display: boolean, dollar?: '$' | '$$'): void {
  const c = chip('', display ? '[' : '(', null);
  const sel = getSelection();
  let r = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  if (!r || !editing.contains(r.startContainer)) { r = document.createRange(); r.selectNodeContents(editing); r.collapse(false); }
  r.deleteContents();
  r.insertNode(c);
  r.setStartAfter(c); r.collapse(true);
  sel?.removeAllRanges(); sel?.addRange(r);
  openChip(c, null, 'end', dollar);
}

/** `$$` typed: the open (empty, inline) formula made a displayed one, opened again */
export function displayChip(id: number): void {
  const c = chipById(id);
  if (!c || c !== open || c.dataset.olDelim !== '(') return;
  const d = chip('', '[', null);
  c.replaceWith(d);
  open = null;
  const r = document.createRange();
  r.setStartAfter(d); r.collapse(true);
  const sel = getSelection();
  sel?.removeAllRanges(); sel?.addRange(r);
  openChip(d, null, 'end', '$$');
}

/** the chip just before / after a collapsed caret (an arrow key goes into it) */
export function chipBeside(dir: 'before' | 'after'): HTMLElement | null {
  const sel = getSelection();
  if (!sel || !sel.isCollapsed || !sel.rangeCount) return null;
  const n = sel.anchorNode, o = sel.anchorOffset;
  if (!n) return null;
  let sib: Node | null;
  if (n.nodeType === Node.TEXT_NODE) {
    const len = (n.nodeValue ?? '').length;
    if (dir === 'before' ? o > 0 : o < len) return null;
    sib = dir === 'before' ? n.previousSibling : n.nextSibling;
  } else sib = n.childNodes[dir === 'before' ? o - 1 : o] ?? null;
  while (sib && sib.nodeType === Node.TEXT_NODE && !sib.nodeValue) sib = dir === 'before' ? sib.previousSibling : sib.nextSibling;
  return isChip(sib) ? sib : null;
}

export const CHIP_CSS = `.ol-mathchip { cursor: pointer !important; border-radius: 3px; -webkit-user-select: all; user-select: all; }
  .ol-mathchip:hover { background: rgba(47,111,222,.10); }
  .ol-mathchip[data-ol-mathediting] { visibility: hidden; }
  .ol-mathchip:empty::before { content: '\\2026'; opacity: .5; }`;
