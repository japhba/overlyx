/**
 * The presenter view of a deck being presented (PowerPoint's Presenter View, Keynote's presenter
 * display): the slide shown, big — still the presenting surface, where the pen, the laser and a pinch
 * work as they do full screen —; what the next click shows (the next step, else the next slide); the
 * speaker notes, A− / A+; the time since the presentation began (pause, reset) and the clock; every
 * slide in a strip, a tap goes there. S or the bar's presenter-view button switches it on and off; the
 * bar stays under the slide meanwhile (app/presentkit.ts pin).
 *
 * Linked with another screen of the same account (app/presentshare.ts), it is the remote control of
 * the presentation shown there: an iPad in the presenter view turns the laptop's slides, and what is
 * drawn on it shows there. In the editor, *Audience window* opens the slides in a window of their own
 * (on another screen where the browser lets the editor place it: DeliverableEditor.tsx).
 *
 * The panels are a shadow tree over the page (styles of their own, out of the page's reach); the
 * copies of slides in them are the page's own elements slotted in, so the page's styles draw them.
 * They take no pointer: a touch on a copy is its panel's (an iPad scrolls the strip).
 */
import { slides } from './env';
import { slideStepCount, showSlideStep } from './steps';

export interface StageRect { x: number; y: number; w: number; h: number }

export interface PresenterHost {
  /** the slide shown (its index among those presented) and its step */
  at(): { slide: number; step: number };
  go(slide: number): void;
  next(): void;
  prev(): void;
  /** when the presentation began (ms since 1970): the timer counts from it */
  began(): number;
  /** where the slide is drawn: there (window px), or the whole window (null) */
  setStage(r: StageRect | null): void;
  /** the presenting bar held at that place, always shown (null: back at the bottom edge) */
  pinBar(p: { left: number; top: number } | null): void;
  barHeight(): number;
  /** the view switched or the notes' size changed: kept by the editor (the frame has no storage) */
  changed(on: boolean, notes: number): void;
  /** the editor opens the slides in a window of their own; absent: no editor around (a page presented by itself) */
  audience?(): void;
}

export const NOTES_PX = 22;
const NOTES_MIN = 12, NOTES_MAX = 60;

const ICON = {
  pause: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M5 3v10M11 3v10" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  play: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M5 3l8 5-8 5z" fill="currentColor"/></svg>',
  reset: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M3.2 8a4.8 4.8 0 1 0 1.5-3.5M3 2.5v3h3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  prev: '<svg width="18" height="18" viewBox="0 0 16 16"><path d="M10.5 3 5.5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  next: '<svg width="18" height="18" viewBox="0 0 16 16"><path d="M5.5 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  screen: '<svg width="16" height="16" viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="8.5" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5.5 14h5M8 11v3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
};

const CSS = `:host { all: initial; }
  * { box-sizing: border-box; }
  section { position: fixed; pointer-events: auto; color: #e8eaed; font: 14px/1.35 "OL Inter", Inter, Roboto, sans-serif;
    -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
  .side { display: flex; flex-direction: column; gap: 10px; }
  .card { background: #202124; border-radius: 10px; padding: 10px 12px; min-height: 0; }
  .info { display: flex; flex-direction: column; gap: 6px; }
  .row { display: flex; align-items: center; gap: 6px; }
  .time { font-size: 30px; font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: .01em; min-width: 3.4em; }
  .time.paused { color: #fdd663; }
  .clock { margin-left: auto; font-size: 20px; font-variant-numeric: tabular-nums; color: #bdc1c6; }
  .pos { color: #bdc1c6; font-variant-numeric: tabular-nums; }
  .lab { display: flex; align-items: center; gap: 6px; color: #9aa0a6; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 6px; }
  .lab .sz { margin-left: auto; display: inline-flex; gap: 2px; text-transform: none; letter-spacing: 0; }
  .nbox { position: relative; display: flex; align-items: center; justify-content: center; background: #000; border-radius: 4px; overflow: hidden; }
  .nbox .end { color: #9aa0a6; font-size: 15px; padding: 18px; text-align: center; }
  .notes { flex: 1 1 auto; display: flex; flex-direction: column; }
  .ntext { flex: 1 1 auto; overflow: auto; -webkit-overflow-scrolling: touch; touch-action: pan-y; white-space: pre-wrap; overflow-wrap: anywhere;
    line-height: 1.4; color: #f1f3f4; padding-right: 4px; -webkit-user-select: text; user-select: text; }
  .ntext.none { color: #9aa0a6; font-style: italic; }
  .acts { display: flex; flex-wrap: wrap; gap: 6px; }
  button { all: unset; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-width: 34px; height: 34px; padding: 0 10px;
    border-radius: 17px; cursor: pointer; color: #e8eaed; font: 13px/1 "OL Inter", Inter, Roboto, sans-serif; background: rgba(255,255,255,.08); white-space: nowrap; }
  button:hover { background: rgba(255,255,255,.16); }
  button:focus-visible { outline: 2px solid #8ab4f8; }
  button[hidden] { display: none; }
  .acts button { flex: 1 1 auto; }
  .strip { overflow-x: auto; overflow-y: hidden; -webkit-overflow-scrolling: touch; touch-action: pan-x; scrollbar-width: thin; }
  .track { display: flex; gap: 8px; height: 100%; align-items: flex-start; padding: 2px 2px 0; }
  .th { position: relative; flex: none; padding: 0; height: auto; min-width: 0; border-radius: 4px; background: #000; overflow: hidden; outline: 2px solid transparent; outline-offset: 1px; }
  .th:hover { background: #000; outline-color: rgba(138,180,248,.5); }
  .th.cur { outline: 3px solid #8ab4f8; }
  .th .n { position: absolute; left: 4px; bottom: 3px; padding: 1px 5px; border-radius: 4px; background: rgba(32,33,36,.82); color: #fff; font-size: 11px; font-variant-numeric: tabular-nums; }
  @media (pointer: coarse) { button { min-width: 44px; height: 44px; border-radius: 22px; font-size: 15px; } .time { font-size: 34px; } }
  .portrait .info, .portrait .next { flex: none; }`;

/** a copy of a slide at its step `step`, for a panel: the page's element, its runtime marks off */
function copyOf(s: HTMLElement, step: number, w: number, h: number): HTMLElement {
  const c = s.cloneNode(true) as HTMLElement;
  c.removeAttribute('data-ol-current');
  c.removeAttribute('id');
  c.setAttribute('data-ol-copy', '');
  showSlideStep(c, step);
  // (a canvas's picture is no part of its element)
  const from = s.querySelectorAll('canvas'), to = c.querySelectorAll('canvas');
  to.forEach((cv, i) => { try { cv.getContext('2d')?.drawImage(from[i], 0, 0); } catch { /* tainted or gone */ } });
  c.style.cssText += `;position:absolute;left:0;top:0;margin:0;width:${w}px;height:${h}px;transform-origin:0 0;box-shadow:none;display:block`;
  return c;
}

/** a holder for a copy, slotted into the panel `slot`: `bw` × `bh` px, the copy scaled into it */
function holder(slot: string, copy: HTMLElement, w: number, h: number, bw: number, bh: number): HTMLElement {
  const k = Math.min(bw / w, bh / h);
  copy.style.transform = `scale(${k})`;
  const d = document.createElement('div');
  d.setAttribute('slot', slot);
  d.setAttribute('data-ol-runtime', '');
  d.style.cssText = `all:initial;display:block;position:relative;overflow:hidden;pointer-events:none;width:${Math.round(w * k)}px;height:${Math.round(h * k)}px`;
  d.append(copy);
  return d;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** 1:05 or 1:02:05 */
export function elapsedText(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export class PresenterView {
  on = false;
  notes = NOTES_PX;
  private host: PresenterHost;
  private el: HTMLElement;
  private sr: ShadowRoot;
  private side: HTMLElement;
  private strip: HTMLElement;
  private track: HTMLElement;
  private timeEl: HTMLElement;
  private clockEl: HTMLElement;
  private posEl: HTMLElement;
  private nbox: HTMLElement;
  private ntext: HTMLElement;
  private pauseBtn: HTMLElement;
  /** the timer: counting from `base` (null: from when the presentation began), or held at `paused` ms */
  private base: number | null = null;
  private paused: number | null = null;
  private tick: ReturnType<typeof setInterval> | undefined;
  private thumbsT: ReturnType<typeof setTimeout> | undefined;
  /** the slides' size (the deck's: every slide has the one presented) */
  private size = { w: 960, h: 540 };
  private thumbH = 80;
  private shownThumbs = -1;

  constructor(host: PresenterHost) {
    this.host = host;
    this.el = document.createElement('ol-presenter');
    this.el.setAttribute('data-ol-runtime', '');
    this.el.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483000;pointer-events:none;display:none;';
    this.sr = this.el.attachShadow({ mode: 'open' });
    this.sr.innerHTML = `<style>${CSS}</style>
      <section class="side" aria-label="Presenter view">
        <div class="card info">
          <div class="row"><span class="time" title="Time since the presentation began">0:00</span>
            <button data-a="pause" title="Pause the timer" aria-label="Pause the timer">${ICON.pause}</button>
            <button data-a="reset" title="Start the timer again from 0:00" aria-label="Reset the timer">${ICON.reset}</button>
            <span class="clock" title="The time of day"></span></div>
          <div class="row"><button data-a="prev" title="Back (←)" aria-label="Back">${ICON.prev}</button><span class="pos"></span><button data-a="next" title="On (→)" aria-label="On">${ICON.next}</button></div>
        </div>
        <div class="card next"><div class="lab">Next</div><div class="nbox"><slot name="next"></slot><div class="end" hidden>End of the presentation</div></div></div>
        <div class="card notes"><div class="lab"><span>Notes</span><span class="sz"><button data-a="smaller" title="Smaller notes" aria-label="Smaller notes">A−</button><button data-a="larger" title="Larger notes" aria-label="Larger notes">A+</button></span></div><div class="ntext"></div></div>
        <div class="acts"><button data-a="audience" title="The slides in a window of their own — drag it to the projector, or it opens there where the browser may place windows; this one keeps the presenter view" hidden>${ICON.screen} Audience window</button>
          <button data-a="off" title="Only the slide (S)">Slides only</button></div>
      </section>
      <section class="strip" aria-label="All slides"><div class="track"></div></section>`;
    this.side = this.sr.querySelector('.side') as HTMLElement;
    this.strip = this.sr.querySelector('.strip') as HTMLElement;
    this.track = this.sr.querySelector('.track') as HTMLElement;
    this.timeEl = this.sr.querySelector('.time') as HTMLElement;
    this.clockEl = this.sr.querySelector('.clock') as HTMLElement;
    this.posEl = this.sr.querySelector('.pos') as HTMLElement;
    this.nbox = this.sr.querySelector('.nbox') as HTMLElement;
    this.ntext = this.sr.querySelector('.ntext') as HTMLElement;
    this.pauseBtn = this.sr.querySelector('[data-a="pause"]') as HTMLElement;
    (this.sr.querySelector('[data-a="audience"]') as HTMLElement).hidden = !host.audience;
    this.sr.addEventListener('click', e => {
      const b = (e.target as Element).closest?.('button');
      if (!b) return;
      e.preventDefault(); e.stopPropagation();
      const a = b.getAttribute('data-a');
      if (b.classList.contains('th')) this.host.go(Number(b.getAttribute('data-i')));
      else if (a === 'pause') this.togglePause();
      else if (a === 'reset') { this.base = Date.now(); if (this.paused !== null) this.paused = 0; this.paint(); }
      else if (a === 'prev') this.host.prev();
      else if (a === 'next') this.host.next();
      else if (a === 'smaller' || a === 'larger') this.setNotes(this.notes * (a === 'larger' ? 1.15 : 1 / 1.15), true);
      else if (a === 'audience') this.host.audience?.();
      else if (a === 'off') this.set(false, true);
    });
    (document.body ?? document.documentElement).appendChild(this.el);
    addEventListener('resize', () => this.layout());
  }

  /** an event on the panels (not on the slide) */
  contains(t: EventTarget | null): boolean { return this.on && t instanceof Node && (t === this.el || this.el.contains(t)); }

  /** on or off; `tell`: the editor keeps it */
  set(on: boolean, tell = false): void {
    if (on === this.on) { if (tell) this.host.changed(this.on, this.notes); return; }
    this.on = on;
    this.el.style.display = on ? 'block' : 'none';
    clearInterval(this.tick);
    if (on) {
      this.tick = setInterval(() => this.paint(), 500);
      this.shownThumbs = -1;
      this.layout();
      this.update();
    } else {
      for (const c of Array.from(this.el.children)) c.remove();
      this.host.setStage(null);
      this.host.pinBar(null);
    }
    if (tell) this.host.changed(this.on, this.notes);
  }

  setNotes(px: number, tell = false): void {
    this.notes = Math.round(clamp(px, NOTES_MIN, NOTES_MAX));
    this.ntext.style.fontSize = `${this.notes}px`;
    if (tell) this.host.changed(this.on, this.notes);
  }

  private togglePause(): void {
    const now = Date.now();
    if (this.paused === null) this.paused = now - (this.base ?? this.host.began());
    else { this.base = now - this.paused; this.paused = null; }
    this.paint();
  }

  /** the timer, the clock and where the presentation is */
  private paint(): void {
    if (!this.on) return;
    const ms = this.paused ?? Date.now() - (this.base ?? this.host.began());
    this.timeEl.textContent = elapsedText(ms);
    this.timeEl.classList.toggle('paused', this.paused !== null);
    this.pauseBtn.innerHTML = this.paused === null ? ICON.pause : ICON.play;
    this.pauseBtn.title = this.paused === null ? 'Pause the timer' : 'Go on with the timer';
    this.clockEl.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const a = this.host.at(), n = slides().length, steps = slideStepCount(slides()[a.slide]);
    this.posEl.textContent = n ? `Slide ${a.slide + 1} of ${n}${steps > 1 ? ` · step ${a.step} of ${steps}` : ''}` : '';
  }

  /** where the panels, the slide and the bar go: the slide big at the left (on top, upright), the rest beside (under) it, the slides along the bottom */
  layout(): void {
    if (!this.on) return;
    const W = innerWidth, H = innerHeight, pad = 12, gap = 12;
    const cur = slides()[this.host.at().slide];
    if (cur && cur.offsetWidth && cur.offsetHeight) this.size = { w: cur.offsetWidth, h: cur.offsetHeight };
    const aspect = this.size.h / this.size.w;
    const barH = this.host.barHeight() + 14;
    const portrait = W < H * 1.05;
    this.side.classList.toggle('portrait', portrait);
    this.thumbH = Math.round(portrait ? clamp(H * 0.08, 48, 96) : clamp(H * 0.12, 54, 120));
    const stripH = this.thumbH + 16;
    let stage: StageRect, side: StageRect;
    if (!portrait) {
      const sideW = clamp(W * 0.3, 240, 480), w = W - sideW - 2 * pad - gap;
      // (as tall as the slide is at that width: the bar right under it, the rest of the column the strip's)
      stage = { x: pad, y: pad, w, h: Math.min(H - 2 * pad - barH - stripH, w * aspect) };
      side = { x: W - pad - sideW, y: pad, w: sideW, h: H - 2 * pad };
    } else {
      const w = W - 2 * pad;
      stage = { x: pad, y: pad, w, h: Math.min(w * aspect, H * 0.42) };
      const top = stage.y + stage.h + barH;
      side = { x: pad, y: top, w, h: H - top - stripH - pad - gap / 2 };
    }
    const place = (el: HTMLElement, r: StageRect) => { el.style.left = `${r.x}px`; el.style.top = `${r.y}px`; el.style.width = `${r.w}px`; el.style.height = `${Math.max(0, r.h)}px`; };
    place(this.side, side);
    place(this.strip, { x: pad, y: H - pad - stripH, w: portrait ? W - 2 * pad : stage.w, h: stripH });
    this.host.setStage(stage);
    this.host.pinBar({ left: stage.x, top: stage.y + stage.h + 6 });
    this.shownThumbs = -1;
    this.update();
  }

  /** the slide or its step changed: what comes next, the notes, the strip's mark */
  update(): void {
    if (!this.on) return;
    const ss = slides(), { slide, step } = this.host.at(), s = ss[slide];
    for (const c of Array.from(this.el.querySelectorAll(':scope > [slot="next"]'))) c.remove();
    const end = this.nbox.querySelector('.end') as HTMLElement;
    const steps = slideStepCount(s);
    const next = !s ? null : step < steps ? { el: s, step: step + 1 } : ss[slide + 1] ? { el: ss[slide + 1], step: 1 } : null;
    end.hidden = !!next;
    // (the box as wide as its card, as tall as the slide's shape lets — at most 40 % of the panel)
    const bw = Math.max(40, this.nbox.clientWidth || this.side.clientWidth - 24);
    const bh = Math.max(30, Math.min(bw * this.size.h / this.size.w, this.side.clientHeight * 0.4));
    this.nbox.style.height = `${Math.round(bh)}px`;
    if (next) this.el.append(holder('next', copyOf(next.el, next.step, this.size.w, this.size.h), this.size.w, this.size.h, bw, bh));
    // the notes: the slide's <aside class="notes"> (sourceops.ts slideNotes), as text
    const notes = s ? Array.from(s.children).filter(c => c.localName === 'aside' && c.classList.contains('notes')).map(c => (c.textContent ?? '').trim()).filter(Boolean).join('\n\n') : '';
    this.ntext.textContent = notes || 'No notes for this slide.';
    this.ntext.classList.toggle('none', !notes);
    this.ntext.style.fontSize = `${this.notes}px`;
    if (this.shownThumbs !== ss.length) this.thumbs();
    this.mark();
    this.paint();
  }

  /** the deck changed (an edit while presenting): the copies made again, a moment later */
  sourceChanged(): void {
    if (!this.on) return;
    clearTimeout(this.thumbsT);
    this.thumbsT = setTimeout(() => { this.shownThumbs = -1; this.update(); }, 400);
  }

  /** every slide in the strip, as it ends (all its steps shown) */
  private thumbs(): void {
    const ss = slides();
    this.shownThumbs = ss.length;
    for (const c of Array.from(this.el.querySelectorAll(':scope > [slot^="t"]'))) c.remove();
    const { w, h } = this.size, th = this.thumbH, tw = Math.round(th * w / h);
    this.track.innerHTML = ss.map((_, i) => `<button class="th" data-i="${i}" title="Slide ${i + 1}" aria-label="Slide ${i + 1}" style="width:${tw}px;height:${th}px"><slot name="t${i}"></slot><span class="n">${i + 1}</span></button>`).join('');
    ss.forEach((s, i) => this.el.append(holder(`t${i}`, copyOf(s, slideStepCount(s), w, h), w, h, tw, th)));
  }

  /** the slide shown marked in the strip, and in view there */
  private mark(): void {
    const i = this.host.at().slide;
    for (const b of Array.from(this.track.querySelectorAll<HTMLElement>('.th'))) {
      const on = Number(b.dataset.i) === i;
      b.classList.toggle('cur', on);
      if (on) {
        const l = b.offsetLeft, r = l + b.offsetWidth, sl = this.strip.scrollLeft, sw = this.strip.clientWidth;
        if (l < sl || r > sl + sw) this.strip.scrollTo({ left: Math.max(0, l - (sw - b.offsetWidth) / 2), behavior: 'smooth' });
      }
    }
  }
}
