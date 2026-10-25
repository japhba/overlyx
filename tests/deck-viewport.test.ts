/**
 * The one-slide canvas's place (packages/client/src/deliverable/viewport.ts): Apple's rubber band
 * past the pan range, its inverse (a pull caught mid-spring goes on from where it shows), the range
 * itself, and the spring that brings the slide back; a pull far enough past an edge sets the slide
 * free, and let go near its place it snaps back in.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rubber, banded, unband, panRange, freeRange, spring, clampTo, SlideView, BREAK, snapDistance, PAGE_SCROLL, ADD_PAGE } from '../packages/client/src/deliverable/viewport.ts';
import { pinchFactor, pinchLock, triGesture, PINCH_START, PAN_BREAK } from '../packages/client/src/deliverable/gestures.ts';

describe('the slide canvas', () => {
  it('pulls past an edge against a growing resistance, never as far as the canvas', () => {
    expect(rubber(0, 800)).toBe(0);
    const a = rubber(100, 800), b = rubber(200, 800), c = rubber(5000, 800);
    expect(a).toBeGreaterThan(0); expect(a).toBeLessThan(100);
    expect(b - a).toBeLessThan(a);           // each further px shows less
    expect(c).toBeLessThan(800);
    expect(rubber(-100, 800)).toBeCloseTo(-a, 9);
  });
  it('pans freely inside its range, on the band outside it, and the band can be undone', () => {
    const r: [number, number] = [-150, 150];
    expect(banded(80, r, 800)).toBe(80);
    expect(banded(250, r, 800)).toBeCloseTo(150 + rubber(100, 800), 9);
    for (const raw of [-900, -300, -151, 0, 149, 260, 1200]) expect(unband(banded(raw, r, 800), r, 800)).toBeCloseTo(raw, 6);
  });
  it('has no range when the slide fits (it stays in the middle), else as much as overflows', () => {
    expect(panRange(700, 1000, 32)).toEqual([0, 0]);
    // fitted edge to edge: no wobble; a little past the canvas, the margin comes in with it
    expect(panRange(1000, 1000, 32)).toEqual([0, 0]);
    expect(panRange(1010, 1000, 32)).toEqual([-10, 10]);
    expect(panRange(1200, 1000, 32)).toEqual([-132, 132]);
    expect(clampTo(500, panRange(1200, 1000, 32))).toBe(132);
  });
  it('springs back with a small overshoot and settles within half a second', () => {
    const xs = [0, 0.05, 0.1, 0.2, 0.3, 0.45, 0.6].map(t => spring(100, t));
    expect(xs[0]).toBe(100);
    expect(Math.min(...xs)).toBeLessThan(0);   // overshoots the middle a little
    expect(Math.min(...xs)).toBeGreaterThan(-15);
    expect(Math.abs(spring(100, 0.6))).toBeLessThan(2);
  });
});

describe('a slide pulled loose', () => {
  const box = { w: 1000, h: 700 }, rect = { x: 48, y: 48, w: 1280, h: 720 };
  const FIT = 0.73;
  // (reduced motion: no springs, the slide goes where it goes at once)
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    vi.stubGlobal('requestAnimationFrame', (f: (t: number) => void) => setTimeout(() => f(performance.now()), 16));
    vi.stubGlobal('cancelAnimationFrame', (h: ReturnType<typeof setTimeout>) => clearTimeout(h));
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  const make = (scale = FIT) => {
    const frame = { style: {} } as unknown as HTMLElement;
    const free: boolean[] = [];
    const v = new SlideView(() => frame, () => ({ box, rect, scale, margin: 32 }), { onFree: f => free.push(f) });
    /** where it shows, from the middle (screen px) */
    const at = () => {
      const p = v.place()!;
      return { x: p.tx - (box.w / 2 - (rect.x + rect.w / 2) * p.s), y: p.ty - (box.h / 2 - (rect.y + rect.h / 2) * p.s) };
    };
    const letGo = () => vi.advanceTimersByTime(200);
    return { v, free, at, letGo };
  };

  it('a short pull springs back; a little further, it comes loose and stays where it is let go', () => {
    const { v, free, at, letGo } = make();
    v.scroll(0, BREAK - 60);
    expect(at().y).toBeGreaterThan(0);
    letGo();
    expect(at().y).toBeCloseTo(0, 6);
    expect(v.isFree()).toBe(false);
    v.scroll(0, BREAK - 60);
    v.scroll(0, 80);
    expect(v.isFree()).toBe(true);
    expect(free).toEqual([true]);
    const y = at().y;
    expect(y).toBeGreaterThan(rubber(BREAK, box.h));   // (it caught up with some of the pull)
    letGo();
    expect(at().y).toBeCloseTo(y, 6);
    // free, it follows a scroll one to one
    v.scroll(-50, 30);
    expect(at().x).toBeCloseTo(-50, 6);
    expect(at().y).toBeCloseTo(y + 30, 6);
  });

  it('let go near its place it snaps back in; so does Fit, from anywhere', () => {
    const { v, free, at, letGo } = make();
    v.scroll(0, BREAK + 40);
    letGo();
    expect(v.isFree()).toBe(true);
    v.scroll(0, -(at().y - snapDistance(box) + 10));
    letGo();
    expect(v.isFree()).toBe(false);
    expect(at().y).toBeCloseTo(0, 6);
    expect(free).toEqual([true, false]);
    v.scroll(BREAK + 40, 0);
    v.scroll(300, 0);
    letGo();
    expect(at().x).toBeGreaterThan(300);
    v.recentre(false);
    expect(at()).toEqual({ x: 0, y: 0 });
    expect(free).toEqual([true, false, true, false]);
  });

  it('zoomed in, a scroll that reaches the edge on its way only bounces; one begun at the edge comes loose', () => {
    const { v, at, letGo } = make(2);
    const hi = panRange(rect.w * 2, box.w, 32)[1];
    for (let i = 0; i < 4; i++) v.scroll(500, 0);
    expect(v.isFree()).toBe(false);
    letGo();
    expect(at().x).toBeCloseTo(hi, 6);
    v.scroll(100, 0);
    v.scroll(100, 0);
    expect(v.isFree()).toBe(true);
  });

  it('a finger comes loose by pulling, wherever the pull began, and catches up with the finger', () => {
    const { v, at } = make(2);
    const hi = panRange(rect.w * 2, box.w, 32)[1];
    v.panBy(hi + BREAK - 1, 0);
    expect(v.isFree()).toBe(false);
    v.panBy(2, 0);
    expect(v.isFree()).toBe(true);
    expect(at().x).toBeCloseTo(hi + BREAK + 1, 6);
  });

  it('loose, some of it stays on the canvas', () => {
    const w = rect.w * FIT;
    const [lo, hi] = freeRange(w, box.w, 32);
    expect(hi).toBe(-lo);
    expect(box.w / 2 + hi - w / 2).toBeCloseTo(box.w - 0.2 * w, 6);   // a fifth of it still in
    expect(freeRange(100, 1000, 32)[1]).toBe(1000 / 2 + 50 - 48);
    const { v, at, letGo } = make();
    v.scroll(BREAK + 10, 0);
    v.scroll(5000, 0);
    letGo();
    expect(at().x).toBeCloseTo(hi, 6);
    expect(v.isFree()).toBe(true);
  });
});

describe('zooming the slide (a pinch, a trackpad)', () => {
  const box = { w: 1000, h: 700 }, rect = { x: 48, y: 48, w: 1280, h: 720 };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    vi.stubGlobal('requestAnimationFrame', (f: (t: number) => void) => setTimeout(() => f(performance.now()), 16));
    vi.stubGlobal('cancelAnimationFrame', (h: ReturnType<typeof setTimeout>) => clearTimeout(h));
    vi.stubGlobal('devicePixelRatio', 2);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  const make = () => {
    const frame = { style: {} as Record<string, string> };
    let scale = 0.6;
    const v = new SlideView(() => frame as unknown as HTMLElement, () => ({ box, rect, scale, margin: 32 }));
    return { v, frame, setScale: (s: number) => { scale = s; } };
  };

  it('a pinch keeps what was under the fingers under them, at the scale their distance gives — shown before the editor catches up', () => {
    const { v, setScale } = make();
    v.render();
    // the fingers' middle was over the frame's (400, 300); now at the canvas' (300, 300), twice as far apart
    v.placeAt(1.2, 400, 300, 300, 300);
    expect(v.scaleNow()).toBe(1.2);
    const p = v.toCanvas(400, 300)!;
    expect(p.x).toBeCloseTo(300, 6);
    expect(p.y).toBeCloseTo(300, 6);
    // (and back: the frame's point under a canvas point)
    const q = v.toFrame(300, 300)!;
    expect(q.x).toBeCloseTo(400, 6);
    expect(q.y).toBeCloseTo(300, 6);
    // the editor's scale catches up: the view's own is given up, the place stays
    setScale(1.2);
    v.render();
    expect(v.toCanvas(400, 300)!.x).toBeCloseTo(300, 6);
    // pulled past the edge of its range while pinching: on the rubber band, as iOS does
    v.placeAt(1.2, 400, 300, 700, 300);
    expect(v.toCanvas(400, 300)!.x).toBeLessThan(700);
    expect(v.toCanvas(400, 300)!.x).toBeGreaterThan(454);
  });

  it('a wheel zoom keeps the point under the pointer and shows the new scale at once', () => {
    const { v } = make();
    v.render();
    const before = v.toCanvas(700, 400)!;
    // (past the canvas both ways: the slide pans as far as it must for the point to stay)
    v.zoomTo(1.2, before.x, before.y);
    expect(v.scaleNow()).toBe(1.2);
    const after = v.toCanvas(700, 400)!;
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it('passes the scale a pinch shows on as it goes, once a frame: the page draws its handles for it', () => {
    const told: number[] = [];
    const frame = { style: {} as Record<string, string> };
    let scale = 0.6;
    const v = new SlideView(() => frame as unknown as HTMLElement, () => ({ box, rect, scale, margin: 32 }), { onLive: s => told.push(s) });
    v.render();
    v.placeAt(0.8, 400, 300, 300, 300);
    v.placeAt(1.0, 400, 300, 300, 300);
    expect(told).toEqual([]);
    vi.advanceTimersByTime(20);
    expect(told).toEqual([1.0]);
    v.placeAt(1.2, 400, 300, 300, 300);
    vi.advanceTimersByTime(20);
    expect(told).toEqual([1.0, 1.2]);
    // back to where it began: nothing changes in the editor, so the page hears its scale from here
    v.placeAt(0.6, 400, 300, 300, 300);
    vi.advanceTimersByTime(20);
    expect(told).toEqual([1.0, 1.2, 0.6]);
    // the editor catches up with a pinch: nothing more (it tells the page itself)
    v.placeAt(0.9, 400, 300, 300, 300);
    vi.advanceTimersByTime(20);
    scale = 0.9;
    v.render();
    vi.advanceTimersByTime(20);
    expect(told).toEqual([1.0, 1.2, 0.6, 0.9]);
  });

  it('is a layer of its own only while it moves; at rest it is drawn again on whole device px (iPad blur)', () => {
    const { v, frame } = make();
    v.placeAt(1.234, 401.3, 299.7, 517.77, 333.33);
    expect(frame.style.willChange).toBe('transform');
    vi.advanceTimersByTime(250);
    expect(frame.style.willChange).toBe('');
    const [, tx, ty] = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(frame.style.transform)!.map(Number);
    expect(Number.isInteger(tx * 2)).toBe(true);
    expect(Number.isInteger(ty * 2)).toBe(true);
  });
});

describe('fingers on the canvas (gestures.ts)', () => {
  it('two fingers that pan, never quite as far apart, do not zoom', () => {
    const lock = pinchLock();
    for (let i = 1; i <= 20; i++) expect(pinchFactor(lock, 200, 200 * (1 + (i % 2 ? 0.09 : -0.08)), i * 6)).toBe(1);
    expect(lock.mode).toBe('pan');
    // a pan's fingers spreading a little more: still a pan; by a third and more: a zoom, from the scale it had
    expect(pinchFactor(lock, 200, 250, 130)).toBe(1);
    const z = pinchFactor(lock, 200, 200 * Math.exp(PAN_BREAK + 0.1), 130);
    expect(lock.mode).toBe('zoom');
    expect(z).toBeCloseTo(Math.exp(0.1), 6);
  });

  it('a pinch zooms once the fingers have clearly come closer or gone further apart, without a jump', () => {
    const lock = pinchLock();
    expect(pinchFactor(lock, 200, 220, 2)).toBe(1);
    expect(lock.mode).toBe('wait');
    const just = pinchFactor(lock, 200, 200 * Math.exp(PINCH_START + 0.001), 3);
    expect(lock.mode).toBe('zoom');
    expect(just).toBeCloseTo(1, 2);
    // from then on, as their distance: twice as far apart again, twice the scale
    const a = pinchFactor(lock, 200, 300, 4), b = pinchFactor(lock, 200, 600, 4);
    expect(b / a).toBeCloseTo(2, 6);
    // pinched in
    const inward = pinchLock();
    expect(pinchFactor(inward, 200, 100, 4)).toBeCloseTo(0.5 * Math.exp(PINCH_START), 6);
  });

  it('three fingers: a tap or a swipe left undoes, a swipe right redoes, a slow touch does nothing', () => {
    expect(triGesture(2, 3, 120)).toBe('undo');
    expect(triGesture(-90, 10, 400)).toBe('undo');
    expect(triGesture(90, -10, 400)).toBe('redo');
    expect(triGesture(4, 2, 900)).toBe(null);
    expect(triGesture(10, 120, 300)).toBe(null);
  });
});

describe('a swipe sideways turns the page (Safari\'s swipe between pages)', () => {
  const box = { w: 1000, h: 700 }, rect = { x: 48, y: 48, w: 1280, h: 720 };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    vi.stubGlobal('requestAnimationFrame', (f: (t: number) => void) => setTimeout(() => f(performance.now()), 16));
    vi.stubGlobal('cancelAnimationFrame', (h: ReturnType<typeof setTimeout>) => clearTimeout(h));
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  const make = (scale = 0.7, pages = true) => {
    const frame = { style: {} } as unknown as HTMLElement;
    const turned: number[] = [], free: boolean[] = [];
    const v = new SlideView(() => frame, () => ({ box, rect, scale, margin: 32 }), { pages: () => pages, onPage: d => turned.push(d), onFree: f => free.push(f) });
    v.render();
    const letGo = () => vi.advanceTimersByTime(200);
    return { v, turned, free, letGo };
  };

  it('a scroll sideways: the next slide (swiped left) or the one before, once a swipe, however long its momentum', () => {
    const { v, turned, letGo } = make();
    for (let i = 0; i < 12; i++) v.scroll(-30, 2);
    expect(turned).toEqual([1]);
    letGo();
    for (let i = 0; i < 4; i++) v.scroll(PAGE_SCROLL / 3, 0);
    expect(turned).toEqual([1, -1]);
    letGo();
    // up and down: no page; nor a short sideways nudge
    for (let i = 0; i < 6; i++) v.scroll(3, -40);
    v.scroll(-20, 0);
    letGo();
    expect(turned).toEqual([1, -1]);
  });

  it('zoomed in, it pans first; only a swipe begun at that side\'s edge turns the page — and sideways it never comes loose', () => {
    const { v, turned, free, letGo } = make(1.2);
    for (let i = 0; i < 6; i++) v.scroll(-30, 0);
    expect(turned).toEqual([]);
    // panned to its right edge; a new swipe on: the next slide
    for (let i = 0; i < 40; i++) v.scroll(-30, 0);
    letGo();
    expect(turned).toEqual([]);
    for (let i = 0; i < 8; i++) v.scroll(-30, 0);
    expect(turned).toEqual([1]);
    for (let i = 0; i < 40; i++) v.scroll(-30, 0);
    letGo();
    expect(free).toEqual([]);
  });

  it('a finger: far enough or a flick turns the page, a short slow pull springs back; two fingers never page', () => {
    const { v, turned } = make();
    v.panBy(-20, 0); v.release();
    expect(turned).toEqual([]);
    v.panBy(-25, 0); v.panBy(-25, 0); v.release();   // a flick
    expect(turned).toEqual([1]);
    v.panBy(40, 0); vi.advanceTimersByTime(400); v.panBy(20, 0); v.release();   // slow and short
    expect(turned).toEqual([1]);
    v.panBy(100, 0); vi.advanceTimersByTime(400); v.panBy(80, 0); v.release();   // slow, a sixth of the canvas
    expect(turned).toEqual([1, -1]);
    v.panBy(-60, 0); v.placeAt(0.8, 640, 360, 500, 350); v.release();
    expect(turned).toEqual([1, -1]);
  });

  it('a finger that pans the slide into its edge and goes on turns the page from there (Fit margins: a little wider than the canvas)', () => {
    // (0.85: 88 px wider than the canvas — its pan range ±76 px)
    const { v, turned, free } = make(0.85);
    for (let i = 0; i < 5; i++) v.panBy(-40, 0);   // a flick: to the edge, and on
    v.release();
    expect(turned).toEqual([1]);
    // slowly, only the way past the edge counts: a little springs back, a sixth of the canvas turns the page
    const a = make(0.85);
    a.v.panBy(-50, 0); vi.advanceTimersByTime(400); a.v.panBy(-50, 0); a.v.panBy(-36, 0); a.v.release();
    expect(a.turned).toEqual([]);
    const b = make(0.85);
    b.v.panBy(-50, 0); vi.advanceTimersByTime(400); b.v.panBy(-50, 0); for (let i = 0; i < 5; i++) b.v.panBy(-40, 0); b.v.release();
    expect(b.turned).toEqual([1]);
    // the next slide comes in (centred): flicked the other way, the one before
    b.v.enter(1);
    for (let i = 0; i < 5; i++) b.v.panBy(40, 0);
    b.v.release();
    expect(b.turned).toEqual([1, -1]);
    expect([...free, ...a.free, ...b.free]).toEqual([]);
  });

  it('zoomed in on a detail, a quick pan that overshoots the edge does not turn the page; pulled on far enough, it does — never loose', () => {
    // (1.4: its pan range ±428 px)
    const q = make(1.4);
    for (let i = 0; i < 12; i++) q.v.panBy(-40, 0);   // 52 px past the edge, quickly
    q.v.release();
    expect(q.turned).toEqual([]);
    const f = make(1.4);
    for (let i = 0; i < 20; i++) f.v.panBy(-40, 0);
    f.v.release();
    expect(f.turned).toEqual([1]);
    expect([...q.free, ...f.free]).toEqual([]);
  });

  it('on past the last slide, a finger adds one once pulled far enough — not a flick, not a scroll; the "+" fills as it goes', () => {
    const frame = { style: {} } as unknown as HTMLElement;
    const turned: number[] = [], shown: (number | null)[] = [];
    const v = new SlideView(() => frame, () => ({ box, rect, scale: 0.7, margin: 32 }), { pages: () => true, onPage: d => turned.push(d), addsPage: () => true, adding: k => shown.push(k) });
    v.render();
    v.panBy(-25, 0); v.panBy(-25, 0); v.release();   // a flick: no new slide
    expect(turned).toEqual([]);
    expect(shown.at(-1)).toBeNull();
    const step = (ADD_PAGE * box.w) / 4;
    for (let i = 0; i < 4; i++) v.panBy(-step - 0.1, 0);
    expect(shown.at(-1)).toBeGreaterThanOrEqual(1);
    v.release();
    expect(turned).toEqual([1]);
    vi.advanceTimersByTime(400);
    for (let i = 0; i < 12; i++) v.scroll(-30, 0);   // a scroll past the last: nothing
    vi.advanceTimersByTime(200);
    expect(turned).toEqual([1]);
    v.panBy(60, 0); vi.advanceTimersByTime(70); v.release();   // back: the slide before, as ever
    expect(turned).toEqual([1, -1]);
  });

  it('zoomed in on a detail, panning the last slide into its edge and on never adds one', () => {
    const frame = { style: {} } as unknown as HTMLElement;
    const turned: number[] = [];
    const v = new SlideView(() => frame, () => ({ box, rect, scale: 3, margin: 32 }), { pages: () => true, onPage: d => turned.push(d), addsPage: () => true });
    v.render();
    for (let i = 0; i < 60; i++) v.panBy(-40, 0);   // across the slide, into its edge, and far on
    v.release();
    expect(turned).toEqual([]);
  });

  it('a canceled short flick settles without paging, while a normal lift still pages', () => {
    const { v, turned } = make();
    const home = v.place();
    v.panBy(-40, 0);
    vi.advanceTimersByTime(70);
    v.release(true);
    expect(turned).toEqual([]);
    expect(v.place()).toEqual(home);
    // Canceling discards the swipe: the next gesture starts afresh.
    v.panBy(-40, 0);
    vi.advanceTimersByTime(70);
    v.release();
    expect(turned).toEqual([1]);
  });

  it.each(['zoom', 'wheel'])('a new finger swipe supersedes a pending %s release instead of losing its first motion', previous => {
    const { v, turned } = make();
    if (previous === 'zoom') v.zoomTo(0.5, 500, 350); // Releases in 160ms.
    else v.scroll(-20, 0); // The wheel releases in 140ms, with its own swipe identity.
    vi.advanceTimersByTime(100);
    v.panBy(-20, 0);
    vi.advanceTimersByTime(70); // The older input timer would release this unfinished swipe.
    v.panBy(-20, 0);
    v.release();
    expect(turned).toEqual([1]);
  });

  it('a poster (one page), or a slide pulled loose: sideways it pulls as ever', () => {
    const { v, turned, free, letGo } = make(0.7, false);
    for (let i = 0; i < 20; i++) v.scroll(-30, 0);
    letGo();
    expect(turned).toEqual([]);
    expect(free).toEqual([true]);
    for (let i = 0; i < 20; i++) v.scroll(30, 0);
    letGo();
    expect(turned).toEqual([]);
  });

  it('only sideways turns the page — up and down never: they pull the slide, far enough loose (the way to the canvas round it)', () => {
    const { v, turned, free } = make(0.7, true);
    v.panBy(0, -60); v.panBy(0, -60); v.release();   // up, quickly
    v.panBy(0, 80); vi.advanceTimersByTime(400); v.panBy(0, 60); v.release();   // down, slowly, a fifth of the canvas
    expect(turned).toEqual([]);
    expect(free).toEqual([]);
    v.panBy(-60, 0); v.panBy(-60, 0); v.release();   // left: the next
    expect(turned).toEqual([1]);
    for (let i = 0; i < 10; i++) v.panBy(0, -40);   // up, far: loose
    v.release();
    expect(turned).toEqual([1]);
    expect(free).toEqual([true]);
    // zoomed in mid-slide, pulled far on past its edge sideways: it pans, then turns the page (the one before) — never loose
    const z = make(1.4, true);
    for (let i = 0; i < 30; i++) z.v.panBy(30, 0);
    z.v.release(); vi.advanceTimersByTime(1000);
    expect(z.turned).toEqual([-1]);
    expect(z.free).toEqual([]);
  });

  it('on past the last slide, up or down never adds one', () => {
    const frame = { style: {} } as unknown as HTMLElement;
    const turned: number[] = [], shown: (number | null)[] = [];
    const v = new SlideView(() => frame, () => ({ box, rect, scale: 0.7, margin: 32 }), { pages: () => true, onPage: d => turned.push(d), addsPage: () => true, adding: k => shown.push(k) });
    v.render();
    for (let i = 0; i < 12; i++) v.panBy(0, -40);
    v.release();
    expect(turned).toEqual([]);
    expect(shown).toEqual([]);
  });

  it('the next slide comes in from the side it was swiped from', () => {
    const { v } = make();
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const x = () => v.place()!.tx - (box.w / 2 - (rect.x + rect.w / 2) * v.place()!.s);
    v.enter(1);
    expect(x()).toBeGreaterThan(100);
    vi.advanceTimersByTime(1000);
    expect(Math.abs(x())).toBeLessThan(1);
  });
});
