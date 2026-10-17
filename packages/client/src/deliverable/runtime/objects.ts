/**
 * The Objects pane's tree (Inkscape's Objects dialog, PowerPoint's Selection Pane): what is on the
 * slide worked on, front first, with what is in each group and each drawing (a drawing's <g>s and
 * their parts) one level further in. Sent while the pane is open (`objects` on), again whenever it
 * changed; the pane selects from it at any depth, hovers, renames (data-ol-name), locks and
 * restacks (arrange.ts restack).
 */
import type { ObjNode } from '../protocol';
import { post, srcOf, pathOf, slides, slideOf, isForeign, state } from './env';
import { kindOf, kindWord, isGroup, isSvgPart, isLocked, selection, visibleSlideEl } from './edit';

let wanted = false;
let lastSent = '';

export function wantObjects(on: boolean): void {
  wanted = on;
  lastSent = '';
  postObjects();
}

const PART_TAGS = new Set(['rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path', 'text', 'g', 'use', 'image']);
const PAGE_SKIP = new Set(['script', 'style', 'link', 'meta', 'template', 'noscript']);

/** the objects in an element, as the pane nests them (none in a text box, a picture, a one-shape drawing) */
function kidsOf(el: Element): Element[] {
  const live = Array.from(el.children).filter(k => srcOf.has(k) && !isForeign(k));
  if (el === document.body || el.classList.contains('slide')) return live.filter(k => !k.classList.contains('notes') && !PAGE_SKIP.has(k.localName));
  if (isGroup(el)) return live;
  if (el.localName === 'svg' || (el.localName === 'g' && isSvgPart(el))) {
    const parts = live.filter(k => PART_TAGS.has(k.localName));
    return el.localName === 'svg' && parts.length === 1 && parts[0].localName !== 'g' ? [] : parts;
  }
  return [];
}

function labelOf(el: Element, word: string): { label: string; named: boolean } {
  // (an SVG's own names: Inkscape's labels, else ids)
  const name = el.getAttribute('data-ol-name') ?? ((el.localName === 'svg' || isSvgPart(el)) ? el.getAttribute('inkscape:label') ?? el.id : '');
  if (name) return { label: name, named: true };
  const k = kindOf(el);
  if (k === 'text' || k === 'formula' || k === 'shape') {
    const t = ((srcOf.get(el) ?? el).textContent ?? '').replace(/\s+/g, ' ').trim();
    if (t) return { label: t.length > 40 ? t.slice(0, 39) + '…' : t, named: false };
  }
  return { label: word, named: false };
}

/** the slide worked on: the selection's, else the one shown (a web page: its body) */
function rootNow(): { root: Element | null; index: number } {
  if (state.kind === 'page') return { root: document.body, index: -1 };
  const s = selection()[0];
  const slide = (s && slideOf(s)) || visibleSlideEl();
  return { root: slide, index: slide ? slides().indexOf(slide) : -1 };
}

export function objectTree(root: Element): ObjNode[] {
  const out: ObjNode[] = [];
  const walk = (el: Element, depth: number) => {
    for (const k of kidsOf(el).reverse()) {
      // (the SVG editor's drawing is the page: its layers and objects come first)
      if (k.hasAttribute('data-ol-svgfile')) { walk(k, depth); continue; }
      const path = pathOf(k);
      if (!path) continue;
      const kids = kidsOf(k);
      const word = kindWord(k);
      out.push({ path, depth, kind: kindOf(k), word, ...labelOf(k, word), locked: isLocked(k), kids: kids.length });
      if (kids.length) walk(k, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

/** the tree to the pane, when it is open and the tree changed */
export function postObjects(): void {
  if (!wanted) return;
  const { root, index } = rootNow();
  const msg = { ol: 'objects' as const, slide: index, items: root ? objectTree(root) : [] };
  const key = JSON.stringify(msg);
  if (key === lastSent) return;
  lastSent = key;
  post(msg);
}
