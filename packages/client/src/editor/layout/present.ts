/**
 * Presentation mode of layout documents: the pages full screen, one at a time, with beamer's
 * overlay steps (an object with `step=2-` appears on the second click), its entrance effect (fade,
 * fly in, zoom, wipe) and the page's transition (fade, push, wipe, …) — what the PDF shows as
 * overlay pages, played live. Each page is a copy of the editor's own DOM, re-sized by giving the
 * copy its own `--ol-mm` (everything on a page is sized in it), so text and formulas stay sharp.
 *
 * Keys: → ↓ Space Enter PageDown N (next step), ← ↑ Backspace PageUp P (back), Home / End,
 * a page number then Enter, B / . (black screen), W / , (white screen), L (laser pointer),
 * S (presenter view: notes, next page, timer — in a second window), Esc (end).
 */
import type { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { pageSizeOf, pageFontsOf } from '@overlyx/core';
import { pages as docPages, isLayoutDoc } from './commands';
import { layoutControllerOf } from './controller';
import { annotateOverlays, applyOverlays, OverlayCounter } from './overlays';
import { beamerSlides, hasFrames, clean } from './beamerslides';

/** the page's fonts (editor/layout/controller.ts readHeader): the presentation draws with the same */
const PAGE_FONT_VARS = ['--ol-page-font', '--ol-text-scale', '--ol-math-rel'];

interface Slide { el: HTMLElement; steps: number; transition: string | null; notes: string; name: string | null; pos: number }

/** Is the object shown on step `n` of its page (a beamer overlay specification like `2-`, `-3`, `1,3-5`)? */
export function stepVisible(spec: string | null | undefined, n: number): boolean {
  if (!spec) return true;
  for (const part of spec.split(',')) {
    const p = part.trim().replace(/^[a-z]+@/, '');   // alert@2- etc.: the steps
    const m = /^(\d*)\s*-\s*(\d*)$/.exec(p);
    if (m) { const a = m[1] ? Number(m[1]) : 1, b = m[2] ? Number(m[2]) : Infinity; if (n >= a && n <= b) return true; continue; }
    if (/^\d+$/.test(p) && Number(p) === n) return true;
  }
  return false;
}

/** How many steps a page has: the highest step any of its objects names (1 without animations). */
export function stepCount(page: PMNode): number {
  let max = 1;
  page.descendants(n => {
    const s = n.attrs?.step;
    if (typeof s === 'string') for (const d of s.match(/\d+/g) ?? []) max = Math.max(max, Number(d));
    return n.type.name === 'ol_page' || n.type.name === 'ol_group';
  });
  return max;
}

let active: Presentation | null = null;

export function isPresentingLayout(): boolean { return !!active; }

/** Can the document be presented: a layout document, or a beamer deck of frames (beamerslides.ts)? */
export function canPresent(view: EditorView): boolean {
  if (isLayoutDoc(view.state.doc)) return true;
  return !!layoutControllerOf(view)?.beamer && hasFrames(view.state.doc);
}

export function startPresentation(view: EditorView, opts: { fromCurrent?: boolean } = {}): void {
  if (active) return;
  const ctl = layoutControllerOf(view);
  let slides: Slide[], start = 0, deck: 'layout' | 'beamer';
  if (isLayoutDoc(view.state.doc)) {
    const list = docPages(view.state.doc);
    if (!list.length) return;
    slides = list.map(p => layoutSlide(view, p.node, p.pos));
    deck = 'layout';
    if (opts.fromCurrent) {
      const cur = ctl?.currentPage();
      if (cur) start = Math.max(0, list.findIndex(p => p.pos === cur.pos));
    }
  } else if (ctl?.beamer && hasFrames(view.state.doc)) {
    slides = beamerSlides(view, ctl.preamble);
    if (!slides.length) return;
    deck = 'beamer';
    if (opts.fromCurrent) {
      const at = view.state.selection.from;
      slides.forEach((sl, i) => { if (sl.pos <= at) start = i; });
    }
  } else return;
  active = new Presentation(view, slides, ctl?.page ?? pageSizeOf([]), start, deck);
}

/** a copy of the editor's page, stripped of everything that belongs to editing */
function layoutSlide(view: EditorView, node: PMNode, pos: number): Slide {
  const live = view.nodeDOM(pos) as HTMLElement | null;
  const section = live?.querySelector(':scope > .ol-page') as HTMLElement | null;
  const el = (section ?? document.createElement('section')).cloneNode(true) as HTMLElement;
  el.className = 'ol-page ol-present-page';
  clean(el);
  el.querySelectorAll('.ol-selatom').forEach(n => n.classList.remove('ol-selatom'));
  el.querySelectorAll('.ol-notes, .ol-raw-unplaced').forEach(n => n.remove());
  let notes = '';
  node.forEach(c => { if (c.type.name === 'ol_notes') notes = c.textContent; });
  // the objects' steps and effects from the document (the copy's data attributes may lag)
  const objs = [...el.querySelectorAll<HTMLElement>('.ol-obj, .ol-group')];
  let i = 0;
  const walk = (n: PMNode) => n.forEach(c => {
    if (c.type.name === 'ol_notes') return;
    if (c.type.name === 'ol_raw' && c.attrs.placed === false) return;
    const e = objs[i++];
    if (e) { e.dataset.step = c.attrs.step ?? ''; e.dataset.effect = c.attrs.effect ?? ''; }
    if (c.type.name === 'ol_group') walk(c);
  });
  walk(node);
  // beamer overlays in the boxes' text (\pause, \item<2->, \only<…>{}…), counted through the page in order
  const counter = new OverlayCounter();
  for (const content of el.querySelectorAll<HTMLElement>('.ol-box-content')) annotateOverlays([...content.querySelectorAll<HTMLElement>(':scope > .lyx-par')], counter);
  return { el, steps: Math.max(stepCount(node), counter.max), transition: node.attrs.transition ?? null, notes, name: node.attrs.name ?? null, pos };
}

class Presentation {
  private root: HTMLElement;
  private stage: HTMLElement;
  private slides: Slide[] = [];
  private index = 0;
  private step = 1;
  private typed = '';
  private counter: HTMLElement;
  private laser: HTMLElement;
  private laserOn = false;
  private presenter: Window | null = null;
  private startedAt = Date.now();
  private page: { w: number; h: number };
  private cleanup: (() => void)[] = [];
  private fontVars: Record<string, string> | null = null;

  constructor(private view: EditorView, slides: Slide[], page: { w: number; h: number }, start: number, private deck: 'layout' | 'beamer') {
    this.page = page;
    this.root = document.createElement('div');
    this.root.className = 'ol-present';
    this.root.tabIndex = -1;
    this.stage = document.createElement('div');
    this.stage.className = 'ol-present-stage ol-layout' + (deck === 'beamer' ? ' bm-deck' : '');
    this.stage.dataset.olFont = view.dom.dataset.olFont ?? 'sans';
    if (deck === 'beamer') {
      // a linear deck's fonts from its preamble (a layout document's are on the editor already)
      const f = pageFontsOf(layoutControllerOf(view)?.preamble ?? '', 'beamer');
      this.stage.dataset.olFont = f.id;
      this.fontVars = { '--ol-page-font': f.family, '--ol-text-scale': String(f.textScale), '--ol-math-rel': String(Math.round(f.mathScale / f.textScale * 1000) / 1000) };
    }
    this.counter = document.createElement('div');
    this.counter.className = 'ol-present-counter';
    this.laser = document.createElement('div');
    this.laser.className = 'ol-present-laser';
    this.root.append(this.stage, this.counter, this.laser);
    this.slides = slides;
    document.body.append(this.root);
    this.fit();
    this.index = start;
    this.show(start, 1, null);
    const onKey = (e: KeyboardEvent) => this.key(e);
    const onResize = () => this.fit();
    const onFs = () => { if (!document.fullscreenElement) this.end(); };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    document.addEventListener('fullscreenchange', onFs);
    this.cleanup.push(() => window.removeEventListener('keydown', onKey, true), () => window.removeEventListener('resize', onResize), () => document.removeEventListener('fullscreenchange', onFs));
    this.root.addEventListener('click', e => { if (e.button === 0) this.next(); });
    this.root.addEventListener('contextmenu', e => { e.preventDefault(); this.prev(); });
    this.root.addEventListener('wheel', e => { if (Math.abs(e.deltaY) > 20) { if (e.deltaY > 0) this.next(); else this.prev(); } }, { passive: true });
    this.root.addEventListener('mousemove', e => {
      this.root.classList.add('ol-present-moving');
      clearTimeout((this.root as unknown as { _t?: number })._t);
      (this.root as unknown as { _t?: number })._t = window.setTimeout(() => this.root.classList.remove('ol-present-moving'), 1500);
      if (this.laserOn) { this.laser.style.left = e.clientX + 'px'; this.laser.style.top = e.clientY + 'px'; }
    });
    this.root.requestFullscreen?.().catch(() => { /* a window-sized presentation still works */ });
    this.root.focus();
  }

  private fit(): void {
    const W = window.innerWidth, H = window.innerHeight;
    const pxPerMm = Math.min(W / this.page.w, H / this.page.h);
    this.stage.style.setProperty('--ol-mm', `${pxPerMm}px`);
    this.stage.style.setProperty('--ol-pt', `${pxPerMm / 2.845276}px`);
    this.stage.style.setProperty('--ol-page-w', String(this.page.w));
    this.stage.style.setProperty('--ol-page-h', String(this.page.h));
    const cs = getComputedStyle(this.view.dom);
    this.stage.style.setProperty('--ol-basept', cs.getPropertyValue('--ol-basept') || '11');
    for (const v of PAGE_FONT_VARS) { const x = this.fontVars?.[v] ?? cs.getPropertyValue(v); if (x) this.stage.style.setProperty(v, x); }
  }

  private apply(slide: Slide, step: number, entering: boolean): void {
    applyOverlays(slide.el, step);
    for (const e of slide.el.querySelectorAll<HTMLElement>('[data-step]')) {
      const vis = stepVisible(e.dataset.step, step);
      const was = !e.classList.contains('ol-hidden');
      e.classList.toggle('ol-hidden', !vis);
      if (vis && (!was || entering) && e.dataset.step && e.dataset.effect && stepStarts(e.dataset.step, step)) {
        const cls = 'ol-fx-' + e.dataset.effect;
        e.classList.remove(cls); void e.offsetWidth; e.classList.add(cls);
        e.addEventListener('animationend', () => e.classList.remove(cls), { once: true });
      }
    }
  }

  private show(index: number, step: number, dir: 1 | -1 | null): void {
    const prev = this.stage.firstElementChild as HTMLElement | null;
    const slide = this.slides[index];
    const changing = !prev || prev !== slide.el;
    this.index = index; this.step = step;
    if (changing) {
      for (const e of slide.el.querySelectorAll<HTMLElement>('[data-step]')) e.classList.toggle('ol-hidden', !stepVisible(e.dataset.step, step));
      applyOverlays(slide.el, step);
      this.transition(prev, slide, dir);
    } else this.apply(slide, step, true);
    this.counter.textContent = `${index + 1} / ${this.slides.length}${slide.steps > 1 ? ` · ${step}/${slide.steps}` : ''}`;
    this.updatePresenter();
  }

  private transition(prev: HTMLElement | null, slide: Slide, dir: 1 | -1 | null): void {
    const el = slide.el;
    el.classList.remove('ol-tr-in', 'ol-tr-fade', 'ol-tr-push', 'ol-tr-wipe', 'ol-tr-back');
    this.stage.append(el);
    if (!prev || !slide.transition || dir === null) { prev?.remove(); return; }
    const kind = slide.transition === 'push' || slide.transition === 'cover' ? 'push' : slide.transition === 'wipe' || slide.transition === 'boxin' || slide.transition === 'splitverticalin' || slide.transition === 'blindsvertical' ? 'wipe' : 'fade';
    el.classList.add('ol-tr-in', 'ol-tr-' + kind);
    if (dir < 0) el.classList.add('ol-tr-back');
    prev.classList.add('ol-tr-out');
    const done = () => { prev.remove(); prev.classList.remove('ol-tr-out'); el.classList.remove('ol-tr-in', 'ol-tr-' + kind, 'ol-tr-back'); };
    el.addEventListener('animationend', done, { once: true });
    setTimeout(done, 900);
  }

  next(): void {
    const s = this.slides[this.index];
    if (this.step < s.steps) this.show(this.index, this.step + 1, 1);
    else if (this.index < this.slides.length - 1) this.show(this.index + 1, 1, 1);
    else this.blank('end');
  }

  prev(): void {
    if (this.root.classList.contains('ol-present-blank')) { this.root.classList.remove('ol-present-blank', 'ol-present-white', 'ol-present-end'); return; }
    if (this.step > 1) this.show(this.index, this.step - 1, -1);
    else if (this.index > 0) { const p = this.slides[this.index - 1]; this.show(this.index - 1, p.steps, -1); }
  }

  private blank(kind: 'black' | 'white' | 'end'): void {
    const on = !this.root.classList.contains('ol-present-blank');
    this.root.classList.toggle('ol-present-blank', on);
    this.root.classList.toggle('ol-present-white', on && kind === 'white');
    this.root.classList.toggle('ol-present-end', on && kind === 'end');
  }

  private key(e: KeyboardEvent): void {
    const k = e.key;
    e.stopPropagation();
    if (k === 'Escape') { e.preventDefault(); this.end(); return; }
    if (/^\d$/.test(k)) { this.typed += k; e.preventDefault(); return; }
    if (k === 'Enter' && this.typed) { const n = Number(this.typed) - 1; this.typed = ''; if (n >= 0 && n < this.slides.length) this.show(n, 1, null); e.preventDefault(); return; }
    this.typed = '';
    if (this.root.classList.contains('ol-present-end') && !['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'p', 'P'].includes(k)) { e.preventDefault(); this.end(); return; }
    switch (k) {
      case 'ArrowRight': case 'ArrowDown': case ' ': case 'Enter': case 'PageDown': case 'n': case 'N': e.preventDefault(); this.next(); return;
      case 'ArrowLeft': case 'ArrowUp': case 'Backspace': case 'PageUp': case 'p': case 'P': e.preventDefault(); this.prev(); return;
      case 'Home': e.preventDefault(); this.show(0, 1, null); return;
      case 'End': e.preventDefault(); this.show(this.slides.length - 1, this.slides[this.slides.length - 1].steps, null); return;
      case 'b': case 'B': case '.': e.preventDefault(); this.blank('black'); return;
      case 'w': case 'W': case ',': e.preventDefault(); this.blank('white'); return;
      case 'l': case 'L': e.preventDefault(); this.laserOn = !this.laserOn; this.root.classList.toggle('ol-present-laser-on', this.laserOn); return;
      case 's': case 'S': e.preventDefault(); this.openPresenter(); return;
      default: e.preventDefault();
    }
  }

  /** the presenter view: this page, the next one, the notes and a timer, in a second window */
  private openPresenter(): void {
    if (this.presenter && !this.presenter.closed) { this.presenter.focus(); return; }
    const w = window.open('', 'overlyx-presenter', 'width=1100,height=720');
    if (!w) return;
    this.presenter = w;
    const d = w.document;
    d.open();
    d.write('<!doctype html><html><head><meta charset="utf-8"><title>Presenter view — OverLyX</title></head><body class="ol-presenter"></body></html>');
    d.close();
    for (const s of document.querySelectorAll('link[rel="stylesheet"], style')) d.head.append(s.cloneNode(true));
    const style = d.createElement('style');
    style.textContent = `body.ol-presenter{margin:0;background:#1d1f24;color:#eee;font:15px/1.4 system-ui,sans-serif;display:grid;grid-template-columns:3fr 2fr;grid-template-rows:auto 1fr;gap:14px;padding:14px;height:100vh;box-sizing:border-box}
      .pv-cur,.pv-next{position:relative;background:#000;overflow:hidden;border-radius:4px} .pv-next{opacity:.85}
      .pv-notes{grid-column:1/3;background:#2a2d34;border-radius:6px;padding:12px 16px;font-size:20px;overflow:auto;white-space:pre-wrap}
      .pv-bar{position:fixed;right:18px;top:10px;font-size:22px;font-variant-numeric:tabular-nums;color:#ffd}
      .pv-cur .ol-page,.pv-next .ol-page{box-shadow:none}`;
    d.head.append(style);
    d.body.innerHTML = '<div class="pv-cur"></div><div class="pv-next"></div><div class="pv-notes"></div><div class="pv-bar"></div>';
    w.addEventListener('keydown', e => this.key(e));
    const tick = setInterval(() => {
      if (w.closed) { clearInterval(tick); return; }
      const s = Math.floor((Date.now() - this.startedAt) / 1000);
      const bar = d.querySelector('.pv-bar');
      if (bar) bar.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}  ·  ${this.index + 1}/${this.slides.length}`;
    }, 500);
    this.cleanup.push(() => clearInterval(tick));
    this.updatePresenter();
  }

  private updatePresenter(): void {
    const w = this.presenter;
    if (!w || w.closed) return;
    const d = w.document;
    const place = (cls: string, slide: Slide | undefined, step: number) => {
      const box = d.querySelector('.' + cls) as HTMLElement | null;
      if (!box) return;
      box.replaceChildren();
      if (!slide) { box.textContent = cls === 'pv-next' ? 'End of the presentation' : ''; return; }
      const r = box.getBoundingClientRect();
      const px = Math.min(r.width / this.page.w, r.height / this.page.h) || 2;
      const holder = d.createElement('div');
      holder.className = 'lyx-editor ol-layout' + (this.deck === 'beamer' ? ' bm-deck' : '');
      holder.dataset.olFont = this.stage.dataset.olFont ?? 'sans';
      holder.style.cssText = `--ol-mm:${px}px;--ol-pt:${px / 2.845276}px;--ol-page-w:${this.page.w};--ol-page-h:${this.page.h};--ol-basept:${this.stage.style.getPropertyValue('--ol-basept')};max-width:none`;
      for (const v of PAGE_FONT_VARS) { const x = this.stage.style.getPropertyValue(v); if (x) holder.style.setProperty(v, x); }
      const copy = slide.el.cloneNode(true) as HTMLElement;
      copy.classList.remove('ol-tr-in', 'ol-tr-out', 'ol-tr-fade', 'ol-tr-push', 'ol-tr-wipe');
      for (const e of copy.querySelectorAll<HTMLElement>('[data-step]')) e.classList.toggle('ol-hidden', !stepVisible(e.dataset.step, step));
      applyOverlays(copy, step);
      holder.append(copy);
      box.append(holder);
    };
    const cur = this.slides[this.index];
    place('pv-cur', cur, this.step);
    const nxt = this.step < cur.steps ? [cur, this.step + 1] as const : [this.slides[this.index + 1], 1] as const;
    place('pv-next', nxt[0], nxt[1]);
    const notes = d.querySelector('.pv-notes');
    if (notes) notes.textContent = cur.notes || (cur.name ? cur.name : 'No notes for this page.');
  }

  end(): void {
    if (active !== this) return;
    active = null;
    for (const f of this.cleanup) f();
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => { /* ignore */ });
    this.root.remove();
    try { this.presenter?.close(); } catch { /* ignore */ }
    this.view.focus();
  }
}

/** does the object's specification begin a visible run at step n (it entered on this step)? */
function stepStarts(spec: string, n: number): boolean {
  return stepVisible(spec, n) && !stepVisible(spec, n - 1);
}
