/**
 * What is around the pages of a layout document (the "desk", Inkscape's word): by default the
 * same colour as the pages, so a slide sits on one surface; a right-click on it changes its colour
 * or makes it — or the pages where they have no fill of their own — a transparency checkerboard.
 * A setting of this browser per document (`ol.canvas:<doc>`), never written to the file. Also here:
 * the "Back to the slide" button, shown when the current page has gone (mostly) out of view —
 * scrolled or zoomed far into the canvas — and files dropped on the canvas beside the pages, which
 * go on the current page. Created by the layout controller for its scroller (both shells).
 */
import type { EditorView } from 'prosemirror-view';
import { showContextMenu, type MenuItem } from '../contextmenu';
import { imageFiles } from '../imagepaste';
import { placeImageFiles, placeSvg } from './images';

export interface DeskView { desk: string | null; deskChecker: boolean; pageChecker: boolean }
const NONE: DeskView = { desk: null, deskChecker: false, pageChecker: false };
const CHECKER = 'repeating-conic-gradient(#e3e5e8 0 25%, #ffffff 0 50%) 0 0 / 16px 16px';

function key(view: EditorView): string { return 'ol.canvas:' + (view.dom.dataset.docId ?? view.dom.dataset.project ?? 'layout'); }
function load(view: EditorView): DeskView {
  try { const v = JSON.parse(localStorage.getItem(key(view)) ?? 'null'); return v && typeof v === 'object' ? { ...NONE, ...v } : NONE; } catch { return NONE; }
}
function save(view: EditorView, v: DeskView): void {
  try { if (!v.desk && !v.deskChecker && !v.pageChecker) localStorage.removeItem(key(view)); else localStorage.setItem(key(view), JSON.stringify(v)); } catch { /* private window */ }
}

export interface DeskHandle { destroy(): void; refresh(): void }

export function attachDesk(view: EditorView, scroller: HTMLElement, opts: { currentPage(): number | null; fit(): void; zoomed(): boolean }): DeskHandle {
  let v = load(view);
  const page = () => scroller.querySelector<HTMLElement>('.editor-page');

  /** the pages' own colour: what "same as the page" means */
  const pageColor = (): string => {
    const p = view.dom.querySelector<HTMLElement>('.ol-page');
    const c = p ? getComputedStyle(p).backgroundColor : '';
    return c && c !== 'rgba(0, 0, 0, 0)' ? c : '#ffffff';
  };
  const apply = () => {
    const el = page();
    if (el) el.style.setProperty('--canvas-bg', v.deskChecker ? CHECKER : (v.desk ?? pageColor()));
    view.dom.classList.toggle('ol-page-checker', v.pageChecker);
    view.dom.classList.toggle('ol-desk-match', !v.desk && !v.deskChecker);
  };
  const set = (patch: Partial<DeskView>) => { v = { ...v, ...patch }; save(view, v); apply(); };

  const menuItems = (x: number, y: number): MenuItem[] => [
    { label: 'Canvas colour', sub: [
      { label: 'Same as the page', checked: !v.desk && !v.deskChecker, action: () => set({ desk: null, deskChecker: false }) },
      { label: 'White', checked: v.desk === '#ffffff', action: () => set({ desk: '#ffffff', deskChecker: false }) },
      { label: 'Light grey', checked: v.desk === '#e7e8ea', action: () => set({ desk: '#e7e8ea', deskChecker: false }) },
      { label: 'Dark grey', checked: v.desk === '#3c4043', action: () => set({ desk: '#3c4043', deskChecker: false }) },
      { label: 'Black', checked: v.desk === '#000000', action: () => set({ desk: '#000000', deskChecker: false }) },
      { label: 'Other colour…', action: () => pickColor(x, y, v.desk ?? '#e7e8ea', c => set({ desk: c, deskChecker: false })) },
    ] },
    { label: 'Checkerboard canvas', checked: v.deskChecker, action: () => set({ deskChecker: !v.deskChecker }) },
    { label: 'Checkerboard on pages without a fill (shows transparency)', checked: v.pageChecker, action: () => set({ pageChecker: !v.pageChecker }) },
    { sep: true },
    { label: 'Back to the slide', action: refocus },
  ];

  /* a right-click on the canvas beside the pages */
  const onContext = (e: MouseEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest('.ol-page, .ol-rail, .ol-objects, .ol-sorter, .ol-ruler, .ol-notes-add, .ol-page-notes')) return;
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, menuItems(e.clientX, e.clientY));
  };

  /* files dropped beside the pages: onto the current page */
  const onDragOver = (e: DragEvent) => { if (e.dataTransfer?.types.includes('Files') && !(e.target as HTMLElement).closest('.ProseMirror')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } };
  const onDrop = (e: DragEvent) => {
    if (!e.dataTransfer?.files.length || (e.target as HTMLElement).closest('.ProseMirror')) return;
    const images = imageFiles(e.dataTransfer);
    if (!images.length) return;
    e.preventDefault();
    e.stopPropagation();
    const svgs = images.filter(f => f.type === 'image/svg+xml' || /\.svg$/i.test(f.name));
    if (svgs.length === 1 && images.length === 1) void svgs[0].text().then(t => { if (!placeSvg(view, t)) void placeImageFiles(view, images); });
    else void placeImageFiles(view, images);
  };

  /* "Back to the slide" */
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ol-refocus';
  btn.setAttribute('data-ol-refocus', '');
  btn.title = 'Show the whole slide again';
  btn.addEventListener('click', () => refocus());
  document.body.appendChild(btn);
  function refocus(): void {
    opts.fit();
    const pos = opts.currentPage();
    const dom = pos !== null ? view.nodeDOM(pos) as HTMLElement | null : view.dom.querySelector<HTMLElement>('.ol-page-wrap');
    (dom?.closest?.('.ol-page-wrap') as HTMLElement | null ?? dom)?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
    btn.classList.remove('on');
  }
  let raf = 0;
  const check = () => {
    raf = 0;
    const sr = scroller.getBoundingClientRect();
    const pos = opts.currentPage();
    const dom = pos !== null ? view.nodeDOM(pos) as HTMLElement | null : null;
    const pg = (dom?.querySelector?.('.ol-page') ?? dom) as HTMLElement | null;
    if (!pg || !sr.width || !scroller.isConnected) { btn.classList.remove('on'); return; }
    const r = pg.getBoundingClientRect();
    const ix = Math.max(0, Math.min(sr.right, r.right) - Math.max(sr.left, r.left)), iy = Math.max(0, Math.min(sr.bottom, r.bottom) - Math.max(sr.top, r.top));
    const seen = (ix * iy) / Math.max(1, r.width * r.height), fills = (ix * iy) / Math.max(1, sr.width * sr.height);
    const lost = seen < 0.35 && fills < 0.6;
    // scrolled away from the page: back to it; zoomed into it: the whole page again
    const zoomed = opts.zoomed();
    btn.classList.toggle('on', lost || zoomed);
    btn.classList.toggle('lost', lost);
    btn.textContent = lost ? '⤢ Back to the slide' : '⤢ Fit the slide';
    btn.style.left = `${sr.left + sr.width / 2}px`;
    btn.style.top = `${sr.bottom - 52}px`;
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(check); };

  scroller.addEventListener('contextmenu', onContext);
  scroller.addEventListener('dragover', onDragOver);
  scroller.addEventListener('drop', onDrop);
  scroller.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
  ro?.observe(view.dom);
  apply();
  schedule();
  return {
    refresh() { apply(); schedule(); },
    destroy() {
      scroller.removeEventListener('contextmenu', onContext);
      scroller.removeEventListener('dragover', onDragOver);
      scroller.removeEventListener('drop', onDrop);
      scroller.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      ro?.disconnect();
      if (raf) cancelAnimationFrame(raf);
      btn.remove();
      page()?.style.removeProperty('--canvas-bg');
      view.dom.classList.remove('ol-page-checker', 'ol-desk-match');
    },
  };
}

/** a colour from the system picker (the canvas's "Other colour…") */
function pickColor(x: number, y: number, current: string, onPick: (c: string) => void): void {
  const input = document.createElement('input');
  input.type = 'color';
  input.value = /^#[0-9a-f]{6}$/i.test(current) ? current : '#e7e8ea';
  input.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:1px;height:1px;opacity:0;`;
  document.body.appendChild(input);
  input.addEventListener('change', () => { onPick(input.value); input.remove(); });
  input.addEventListener('blur', () => setTimeout(() => input.remove(), 200));
  input.click();
}
