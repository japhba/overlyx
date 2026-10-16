/**
 * A magnifying glass over the document: freeze its layout width, then transform the rendered page.
 * Font sizes, line breaks and document contents do not change. The scroller stays in screen pixels;
 * transformed overflow supplies the extra scroll range. The rest of the application never scales.
 */
import { useLayoutEffect } from 'preact/hooks';
import type { RefObject } from 'preact';
import { hostedZoomPill } from './zoomhud';
import './documentviewport.css';

export const VIEW_ZOOM_MIN = 1, VIEW_ZOOM_MAX = 4;
const clamp = (z: number) => Math.max(VIEW_ZOOM_MIN, Math.min(VIEW_ZOOM_MAX, z));
const listeners = new Set<() => void>();
let active: DocumentViewport | null = null;
export const viewportZoom = () => active ? active.scale : null;
export const onViewportZoom = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };
const announce = () => listeners.forEach(cb => cb());
export function resetViewportZoom(): void { active?.reset(); }

type SavedStyle = { el: HTMLElement; css: Map<string, string> };
const remember = (el: HTMLElement, properties: string[]): SavedStyle => ({ el, css: new Map(properties.map(p => [p, el.style.getPropertyValue(p)])) });
const restore = ({ el, css }: SavedStyle) => { for (const [p, v] of css) { if (v) el.style.setProperty(p, v); else el.style.removeProperty(p); } };

export class DocumentViewport {
  scale = 1;
  private pageStyle: SavedStyle;
  private rulerStyle: SavedStyle | null;
  private width = 0;
  private rulerWidth = 0;
  private rulerHeight = 0;
  private rulerOrigin = 0;
  private raf = 0;
  private settle = 0;
  private pending: { z: number; x: number; y: number; toX: number; toY: number } | null = null;
  private hud;

  constructor(readonly scroller: HTMLElement, readonly page: HTMLElement, readonly editor: HTMLElement) {
    this.pageStyle = remember(page, ['width', 'min-width', 'max-width', 'transform', 'transform-origin', 'will-change']);
    const ruler = scroller.querySelector<HTMLElement>(':scope > .ruler');
    this.rulerStyle = ruler ? remember(ruler, ['width', 'max-width', 'transform', 'transform-origin', 'margin-bottom', 'will-change']) : null;
    this.hud = hostedZoomPill(() => scroller, 'data-viewport-zoomhud', 'View');
    scroller.dataset.viewportZoom = '1';
  }

  /** Coalesce a trackpad stream to one transform per frame; anchor in unscaled page coordinates. */
  by(logDelta: number, x: number, y: number, toX = x, toY = y): void {
    const z = clamp((this.pending?.z ?? this.scale) * Math.exp(logDelta));
    this.pending = { z, x: this.pending?.x ?? x, y: this.pending?.y ?? y, toX, toY };
    if (!this.raf) this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      const p = this.pending; this.pending = null;
      if (p) this.zoomAt(p.z, p.x, p.y, p.toX, p.toY);
    });
  }

  zoomAt(z: number, x: number, y: number, toX = x, toY = y): void {
    z = clamp(z);
    if (Math.abs(z - 1) < 0.005) z = 1;
    if (z === this.scale && x === toX && y === toY) return;
    const before = this.page.getBoundingClientRect();
    const px = (x - before.left) / this.scale, py = (y - before.top) / this.scale;
    if (this.scale === 1 && z !== 1) {
      // Read before writing: the logical width remains fixed even when scrollbars appear.
      this.width = before.width;
      const r = this.rulerStyle?.el;
      if (r) { this.rulerWidth = r.offsetWidth; this.rulerHeight = r.offsetHeight; this.rulerOrigin = before.left - r.getBoundingClientRect().left; }
    }
    this.scale = z;
    clearTimeout(this.settle); this.settle = 0;
    this.scroller.dataset.viewportZoom = String(z);
    if (z === 1) {
      restore(this.pageStyle);
      if (this.rulerStyle) restore(this.rulerStyle);
    } else {
      Object.assign(this.page.style, { width: `${this.width}px`, minWidth: `${this.width}px`, maxWidth: `${this.width}px`,
        transform: `scale(${z})`, transformOrigin: '0 0', willChange: 'transform' });
      const ruler = this.rulerStyle?.el;
      if (ruler) Object.assign(ruler.style, { width: `${this.rulerWidth}px`, maxWidth: 'none',
        transform: `scale(${z})`, transformOrigin: `${this.rulerOrigin}px 0`, marginBottom: `${this.rulerHeight * (z - 1)}px`, willChange: 'transform' });
      // Let Chrome rasterize the final scale sharply once the gesture rests, rather than keeping
      // the temporary layer's stretched pixels for subsequent typing.
      this.settle = window.setTimeout(() => {
        this.settle = 0;
        for (const saved of [this.pageStyle, this.rulerStyle]) if (saved) {
          const value = saved.css.get('will-change');
          if (value) saved.el.style.setProperty('will-change', value); else saved.el.style.removeProperty('will-change');
        }
      }, 180);
    }
    const after = this.page.getBoundingClientRect();
    this.scroller.scrollLeft += after.left + px * z - toX;
    this.scroller.scrollTop += after.top + py * z - toY;
    this.hud.show(z);
    this.scroller.dispatchEvent(new Event('ol:viewport-zoom'));
    if (active === this) announce();
  }

  reset(): void {
    cancelAnimationFrame(this.raf); this.raf = 0; this.pending = null;
    const r = this.scroller.getBoundingClientRect();
    this.zoomAt(1, r.left + r.width / 2, r.top + r.height / 2);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    clearTimeout(this.settle);
    restore(this.pageStyle);
    if (this.rulerStyle) restore(this.rulerStyle);
    delete this.scroller.dataset.viewportZoom;
    this.hud.dispose();
  }
}

/** Both shells install this on their document pane; PDF and layout canvases own their own zoom. */
export function useDocumentViewportZoom(ref: RefObject<HTMLElement>, docId: string | null): void {
  useLayoutEffect(() => {
    const sc = ref.current;
    if (!sc) return;
    let controller: DocumentViewport | null = null;
    const sync = () => {
      if (controller?.editor.isConnected && controller.page.contains(controller.editor) && !controller.editor.classList.contains('ol-layout')) return;
      controller?.destroy();
      const page = sc.querySelector<HTMLElement>(':scope > .editor-page');
      const editor = page?.querySelector<HTMLElement>('.lyx-editor');
      controller = page && editor && !editor.classList.contains('ol-layout') ? new DocumentViewport(sc, page, editor) : null;
      active = controller;
      announce();
    };
    const observer = new MutationObserver(sync);
    observer.observe(sc, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    sync();
    const inPane = (target: EventTarget | null) => target instanceof Node && sc.contains(target);
    const wheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.defaultPrevented) return;
      e.preventDefault(); // browser zoom would magnify the surrounding interface too
      if (!controller || !inPane(e.target)) return;
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? sc.clientHeight : 1);
      controller.by(Math.max(-0.3, Math.min(0.3, -dy * 0.01)), e.clientX, e.clientY);
    };
    let touch: { d: number; x: number; y: number } | null = null;
    const two = (t: TouchList) => ({ d: Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY), x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
    const onTouch = (e: TouchEvent) => {
      if (e.type === 'touchstart') {
        if (e.defaultPrevented || e.touches.length !== 2 || !controller || !inPane(e.target)) return;
        e.preventDefault(); touch = two(e.touches); return;
      }
      if (!touch || !controller) return;
      if (e.type === 'touchmove' && e.touches.length === 2) {
        e.preventDefault();
        const now = two(e.touches);
        if (touch.d > 0 && now.d > 0) controller.by(Math.log(now.d / touch.d), touch.x, touch.y, now.x, now.y);
        touch = now;
      } else if (e.touches.length < 2) touch = null;
    };
    let last = 1;
    const gesture = (e: Event & { scale?: number; clientX?: number; clientY?: number }) => {
      if (e.defaultPrevented) return;
      e.preventDefault();
      if (touch || !controller || !inPane(e.target)) return;
      if (e.type === 'gesturestart') { last = 1; return; }
      const z = e.scale ?? 1;
      if (e.type === 'gesturechange' && z > 0) {
        const r = sc.getBoundingClientRect();
        controller.by(Math.log(z / last), e.clientX ?? r.left + r.width / 2, e.clientY ?? r.top + r.height / 2);
        last = z;
      }
    };
    const opts = { passive: false };
    window.addEventListener('wheel', wheel, opts);
    for (const t of ['gesturestart', 'gesturechange', 'gestureend']) window.addEventListener(t, gesture, opts);
    for (const t of ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const) document.addEventListener(t, onTouch, opts);
    return () => {
      observer.disconnect(); controller?.destroy();
      if (active === controller) { active = null; announce(); }
      window.removeEventListener('wheel', wheel);
      for (const t of ['gesturestart', 'gesturechange', 'gestureend']) window.removeEventListener(t, gesture);
      for (const t of ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const) document.removeEventListener(t, onTouch);
    };
  }, [ref, docId]);
}
