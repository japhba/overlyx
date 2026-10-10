/**
 * Formulas in a text being retyped are edited with LyX's formula editor. While edit.ts retypes a
 * text, each \( \), \[ \] or $$ $$ of it is a "chip": the typeset formula, one character for the
 * text around it (contenteditable=false). A click on a chip, an arrow key into it or Ctrl+M (a new
 * one) opens LyX's math field over it in the editor (DeliverableEditor places a LyxMathField on the
 * chip's box; the chip, hidden meanwhile, keeps the room the formula takes), which sends the
 * formula back as it changes (`mathSet`) and when it is left (`mathDone`). Written back as text
 * the formula keeps the source it had, unless it was changed.
 */
import type { Rect } from '../protocol';
import { post } from './env';
import { typeset, untypeset } from './math';

const MATH_RE = /\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$/g;
const DELIMS: Record<string, [string, string]> = { '(': ['\\(', '\\)'], '[': ['\\[', '\\]'], '$$': ['$$', '$$'] };

let seq = 0;
/** the chip whose formula is open in the editor */
let open: HTMLElement | null = null;

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

function rectOf(c: HTMLElement): Rect {
  // a displayed formula: the box of the formula itself (centred in the line), not of the whole line
  const inner = c.querySelector('mjx-container > svg') ?? c.querySelector('mjx-container') ?? c;
  const r = (inner.getBoundingClientRect().width ? inner : c).getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/** the editor opens LyX's formula editor on the chip (`at`: a click there, frame client px) */
export function openChip(c: HTMLElement, at: { x: number; y: number } | null, where: 'start' | 'end' = 'end'): void {
  if (open && open !== c) closeChip();
  open = c;
  c.setAttribute('data-ol-mathediting', '');
  const s = getComputedStyle(c);
  post({ ol: 'mathEdit', id: Number(c.dataset.olChip), tex: c.dataset.olTex ?? '', display: c.dataset.olDelim !== '(', rect: rectOf(c), fontPx: parseFloat(s.fontSize) || 16, color: s.color, at, where });
}

/** the formula open in the editor changed: the chip follows (hidden, it keeps the formula's room) */
export async function setChip(id: number, tex: string): Promise<void> {
  const c = chipById(id);
  if (!c) return;
  await render(c, tex);
  if (open === c) post({ ol: 'mathRect', id, rect: rectOf(c) });
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
export async function doneChip(id: number, tex: string, dir: 'forward' | 'backward' | null, editing: HTMLElement | null): Promise<boolean> {
  const c = chipById(id);
  if (open === c) open = null;
  if (!c) return false;
  await render(c, tex);
  c.removeAttribute('data-ol-mathediting');
  const keep = !!tex.trim();
  if (!editing || !editing.contains(c)) { if (!keep) c.remove(); return keep; }
  editing.focus({ preventScroll: true });
  const sel = getSelection();
  if (dir || !keep) {
    const r = document.createRange();
    if (keep && dir === 'forward') r.setStartAfter(c); else r.setStartBefore(c);
    r.collapse(true);
    if (!keep) c.remove();
    sel?.removeAllRanges();
    sel?.addRange(r);
  }
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

/** where the open chip is now (the page scrolled, the text reflowed) */
export function trackChip(): void {
  if (open && open.isConnected) post({ ol: 'mathRect', id: Number(open.dataset.olChip), rect: rectOf(open) });
}

/** a new (empty) formula at the caret of the text being retyped, opened at once */
export function insertChip(editing: HTMLElement, display: boolean): void {
  const c = chip('', display ? '[' : '(', null);
  const sel = getSelection();
  let r = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  if (!r || !editing.contains(r.startContainer)) { r = document.createRange(); r.selectNodeContents(editing); r.collapse(false); }
  r.deleteContents();
  r.insertNode(c);
  r.setStartAfter(c); r.collapse(true);
  sel?.removeAllRanges(); sel?.addRange(r);
  openChip(c, null, 'end');
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
