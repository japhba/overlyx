/**
 * What is around the pages on the canvas — a setting of the viewer, never written to the file (the
 * editor keeps it per document in this browser): the canvas colour (by default the page's own
 * background, so the frame and the editor around it are one surface), a transparency checkerboard
 * for the canvas, and one under the pages, where a slide without a background of its own shows it
 * (Inkscape's desk and page checkerboards). The page's own colours are reported to the editor,
 * which paints its surroundings to match.
 */
import type { CanvasView } from '../protocol';
import { post, slides, docRect } from './env';

let style: HTMLStyleElement | null = null;
let backdrop: HTMLElement | null = null;
let view: CanvasView = { desk: null, deskChecker: false, pageChecker: false };

export const checker = (a = '#e3e5e8', b = '#ffffff', size = 16) => `repeating-conic-gradient(${a} 0 25%, ${b} 0 50%) 0 0 / ${size}px ${size}px`;

export function setView(v: CanvasView): void { view = v; apply(); }

function apply(): void {
  if (!style) {
    style = document.createElement('style');
    style.setAttribute('data-ol-runtime', '');
    document.head.appendChild(style);
  }
  const desk = view.deskChecker ? checker() : view.desk;
  const rules: string[] = [];
  // the page checkerboard lies under the body: the body itself is then see-through, the canvas on <html>
  if (view.pageChecker) rules.push(`html.ol-edit { background: ${desk ?? currentDesk()} !important; } html.ol-edit body { background: transparent !important; }`);
  else if (desk) rules.push(`html.ol-edit, html.ol-edit body { background: ${desk} !important; }`);
  style.textContent = rules.join('\n');
  refreshView();
}

/** the page's own canvas colour (what its body / html paint) */
function currentDesk(): string {
  const b = getComputedStyle(document.body).backgroundColor;
  if (b && b !== 'rgba(0, 0, 0, 0)') return b;
  const h = getComputedStyle(document.documentElement).backgroundColor;
  return h && h !== 'rgba(0, 0, 0, 0)' ? h : '#ffffff';
}

/** the checkerboards under the slides, where they are now */
export function refreshView(): void {
  if (!view.pageChecker) { backdrop?.remove(); backdrop = null; return; }
  if (!backdrop) {
    backdrop = document.createElement('ol-backdrop');
    backdrop.setAttribute('data-ol-runtime', '');
    backdrop.style.cssText = 'all:initial;position:absolute;left:0;top:0;width:0;height:0;z-index:-2147483647;pointer-events:none;display:block;';
    document.documentElement.appendChild(backdrop);
  }
  const ss = slides();
  const boxes = ss.length ? ss.map(s => docRect(s)) : [{ x: 0, y: 0, w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight }];
  backdrop.innerHTML = boxes.map(r => `<div style="position:absolute;left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;background:${checker('#cfd3d9', '#f4f5f7', 20)}"></div>`).join('');
}

/** the colours the editor paints around the frame: the page's canvas, and the slides' usual background */
export function reportColors(): void {
  const counts = new Map<string, number>();
  for (const s of slides()) {
    const c = getComputedStyle(s);
    const v = c.backgroundColor !== 'rgba(0, 0, 0, 0)' ? c.backgroundColor : '';
    if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let page = '#ffffff', n = 0;
  for (const [k, v] of counts) if (v > n) { n = v; page = k; }
  // what the page itself paints (without the editor's override)
  const prev = style?.textContent ?? '';
  if (style) style.textContent = '';
  const desk = currentDesk();
  if (style) style.textContent = prev;
  post({ ol: 'colors', desk, page });
}
