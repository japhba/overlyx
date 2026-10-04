/**
 * What the slide rail (rail.ts) and the slide sorter (sorter.ts) share: drawing a page's thumbnail, the
 * page a DOM change belongs to, the New slide layout picker, the slide clipboard and undo steps.
 */
import type { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { yUndoPluginKey } from 'y-prosemirror';
import { clean } from './beamerslides';
import { SLIDE_LAYOUTS, type SlideLayout } from './slidelayouts';

/** the width a page is drawn at before it is scaled into its thumbnail */
const DRAW_W = 320;
/** selection and editing marks of objects: not a change of the page's look */
const UI_CLASSES = new Set(['ol-sel', 'ol-edited', 'ol-selatom', 'ProseMirror-selectednode', 'focused', 'ol-hover']);

export const div = (cls: string) => { const d = document.createElement('div'); d.className = cls; return d; };
export function button(cls: string, text: string, title: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button'; b.className = cls; b.textContent = text; b.title = title;
  return b;
}

/** The page wrapper whose look a DOM change of the editor changes, if any (selection marks, overlays and labels do not count). */
export function pageOfMutation(r: MutationRecord): HTMLElement | null {
  const t = (r.target.nodeType === 1 ? r.target : r.target.parentElement) as HTMLElement | null;
  if (!t || t.closest('.ol-overlay, .ol-page-label, .ol-notes-add')) return null;
  if (r.type === 'attributes' && r.attributeName === 'class') {
    const before = new Set((r.oldValue ?? '').split(/\s+/).filter(Boolean)), after = new Set(t.classList);
    if (![...before, ...after].some(c => before.has(c) !== after.has(c) && !UI_CLASSES.has(c))) return null;
  }
  const wrap = t.closest('.ol-page-wrap') as HTMLElement | null;
  // the wrapper's own attributes (its transition, whether it has notes) do not show on the page
  return wrap && !(r.type === 'attributes' && t === wrap) ? wrap : null;
}

/** whole pages copied with Ctrl+C in a rail or the sorter (any document of this tab) */
let slideClipboard: PMNode[] = [];
export const getSlideClipboard = (): PMNode[] => slideClipboard;
export function setSlideClipboard(pages: PMNode[]): void { slideClipboard = pages; }

/** each slide command is a step of its own for Ctrl+Z (the undo manager joins changes less than 0.5 s apart) */
export function undoStep(view: EditorView): void {
  try { (yUndoPluginKey.getState(view.state) as { undoManager?: { stopCapturing(): void } } | undefined)?.undoManager?.stopCapturing(); } catch { /* no undo manager */ }
}

/**
 * A copy of a page as the editor shows it, for a thumbnail: drawn at DRAW_W px (like the presentation's
 * stage, not an editor — `.lyx-editor` — the page's own rules at its own scale), to be scaled with
 * `transform` (scaleThumb). Null while the page has no DOM.
 */
export function drawPage(view: EditorView, wrap: HTMLElement, page: { w: number; h: number }): HTMLElement | null {
  const section = wrap.querySelector(':scope > .ol-page') as HTMLElement | null;
  if (!section) return null;
  const holder = div('ol-layout ol-rail-holder');
  // the editor's page variables (fonts, TeX spacing, list metrics), at the drawing scale
  const src = view.dom.style;
  for (let i = 0; i < src.length; i++) {
    const name = src[i];
    if (name.startsWith('--ol-') && !['--ol-fit-pt', '--ol-pt', '--ol-mm', '--ol-rail-w'].includes(name)) holder.style.setProperty(name, src.getPropertyValue(name));
  }
  const basept = getComputedStyle(view.dom).getPropertyValue('--ol-basept');
  if (basept) holder.style.setProperty('--ol-basept', basept);
  holder.style.setProperty('--ol-mm', `${DRAW_W / page.w}px`);
  holder.style.setProperty('--ol-pt', `${DRAW_W / page.w / 2.845276}px`);
  holder.style.setProperty('--ol-page-w', String(page.w));
  holder.style.setProperty('--ol-page-h', String(page.h));
  if (view.dom.dataset.olFont) holder.dataset.olFont = view.dom.dataset.olFont;
  const copy = section.cloneNode(true) as HTMLElement;
  copy.className = 'ol-page ol-rail-page';
  clean(copy);
  copy.querySelectorAll('.ol-notes, .ol-raw-unplaced, .ol-box-prompt').forEach(n => n.remove());
  copy.querySelectorAll('.ol-sel, .ol-edited, .ol-selatom').forEach(n => n.classList.remove('ol-sel', 'ol-edited', 'ol-selatom'));
  copy.querySelectorAll('[id]').forEach(n => n.removeAttribute('id'));
  holder.append(copy);
  holder.inert = true;
  return holder;
}

/** a drawn page (drawPage) into its clip box, `width` px wide */
export function scaleThumb(clip: HTMLElement, holder: HTMLElement | null, width: number, page: { w: number; h: number }): void {
  if (holder) holder.style.transform = `scale(${width / DRAW_W})`;
  clip.style.width = `${width}px`;
  clip.style.height = `${width * page.h / page.w}px`;
}

/**
 * The New slide layout picker under / above `anchor`, inside `host` (positioned); `pick` gets the chosen
 * layout. Returns the function that closes it (Esc and a click elsewhere close it too, then `closed`).
 */
export function layoutPicker(host: HTMLElement, anchor: HTMLElement, pick: (l: SlideLayout) => void, closed: () => void): () => void {
  const pop = div('ol-rail-pop');
  pop.dataset.railLayoutPicker = '';
  const heading = div('ol-rail-pop-title');
  heading.textContent = 'New slide';
  pop.append(heading);
  const grid = div('ol-rail-pop-grid');
  let off = () => {};
  const close = () => { off(); pop.remove(); closed(); };
  for (const l of SLIDE_LAYOUTS) {
    const b = button('ol-rail-layout', '', l.label);
    b.dataset.layout = l.id;
    b.innerHTML = layoutIcon(l.id);
    const cap = document.createElement('span');
    cap.textContent = l.label;
    b.append(cap);
    b.addEventListener('click', () => { close(); pick(l.id); });
    grid.append(b);
  }
  pop.append(grid);
  host.append(pop);
  const r = anchor.getBoundingClientRect(), base = host.getBoundingClientRect();
  // above the anchor when it is in the lower half of the host, else below it
  if (r.top - base.top > base.height / 2) pop.style.bottom = `${base.bottom - r.top + 6}px`;
  else pop.style.top = `${r.bottom - base.top + 6}px`;
  pop.style.left = `${Math.max(8, Math.min(r.left - base.left, base.width - 300))}px`;
  const away = (e: Event) => { if (!pop.contains(e.target as Node) && e.target !== anchor) close(); };
  const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('pointerdown', away, true);
  document.addEventListener('keydown', esc, true);
  off = () => { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', esc, true); };
  (grid.querySelector('button[data-layout="content"]') as HTMLElement | null)?.focus();
  return close;
}


/** a layout's sketch for the picker: title bars, text lines, columns */
function layoutIcon(id: SlideLayout): string {
  const bar = (x: number, y: number, w: number, h = 3) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="1" class="t"/>`;
  const lines = (x: number, y: number, w: number, k: number) => Array.from({ length: k }, (_, i) => `<rect x="${x}" y="${y + i * 4}" width="${i === k - 1 ? w * 0.6 : w}" height="1.6" rx="0.8" class="l"/>`).join('');
  const body: Record<SlideLayout, string> = {
    title: bar(12, 13, 40, 5) + lines(18, 22, 28, 1),
    content: bar(6, 5, 34) + lines(6, 13, 52, 4),
    section: bar(6, 17, 36, 5) + `<rect x="6" y="24.5" width="10" height="1" class="t"/>` + lines(6, 28, 26, 1),
    two: bar(6, 5, 34) + lines(6, 13, 24, 4) + lines(34, 13, 24, 4),
    comparison: bar(6, 5, 34) + bar(6, 12, 16, 2) + bar(34, 12, 16, 2) + lines(6, 17, 24, 3) + lines(34, 17, 24, 3),
    titleonly: bar(6, 5, 34),
    statement: bar(10, 14, 44, 4) + bar(18, 20, 28, 4),
    blank: '',
  };
  return `<svg viewBox="0 0 64 36" aria-hidden="true"><rect x="0.5" y="0.5" width="63" height="35" rx="2" class="p"/>${body[id]}</svg>`;
}
