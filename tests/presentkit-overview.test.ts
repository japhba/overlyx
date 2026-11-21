// @vitest-environment happy-dom
/**
 * Every slide on a grid while presenting (packages/client/src/app/presentkit.ts): a pinch out that
 * begins at the whole slide shrinks it and, past OVERVIEW_AT, snaps into the overview (let go
 * before, it springs back; one that began zoomed in stops at the whole slide); G and - open it;
 * there the arrows and Enter, a click, or Escape go back to a slide; the grid fits every slide
 * when it can and scrolls when they would be too small.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PresentKit, overviewGrid, pullView, OVERVIEW_AT, WHEEL_END_MS, OV_LABEL, type ZoomView } from '../packages/client/src/app/presentkit';

describe('the overview\'s grid', () => {
  it('fits every slide at once, as big as they can be', () => {
    const g = overviewGrid(12, 9 / 16, 1600, 900);
    const rows = Math.ceil(12 / g.cols);
    expect(g.cols * rows).toBeGreaterThanOrEqual(12);
    expect(g.cols * g.w + (g.cols - 1) * g.gap).toBeLessThanOrEqual(1600 - 2 * g.pad);
    expect(rows * (g.h + OV_LABEL) + (rows - 1) * g.gap).toBeLessThanOrEqual(900 - 2 * g.pad);
    // one column more or fewer would make them smaller
    expect(g.w).toBeGreaterThan(300);
  });
  it('scrolls rather than show many slides too small to read; a lone slide is not the whole window', () => {
    const g = overviewGrid(60, 9 / 16, 390, 844);
    expect(g.w).toBeGreaterThanOrEqual(110);
    expect(g.cols).toBeGreaterThanOrEqual(1);
    const one = overviewGrid(1, 9 / 16, 1600, 900);
    expect(one.w).toBeLessThanOrEqual(0.6 * 1600);
    expect(one.h + OV_LABEL).toBeLessThanOrEqual(900);
  });
  it('a pull keeps the slide\'s middle where it is', () => {
    const base = { x: 100, y: 50, w: 800, h: 450 };
    const v = pullView(0.8, base);
    const mid = { x: base.x + base.w / 2, y: base.y + base.h / 2 };
    expect(v.s * mid.x + v.x).toBeCloseTo(mid.x);
    expect(v.s * mid.y + v.y).toBeCloseTo(mid.y);
  });
});

describe('the overview while presenting', () => {
  let root: HTMLElement;
  let kit: PresentKit;
  let current = 0;
  let views: ZoomView[];
  let gone: number[];
  let zoomTold: boolean[];
  let clicks: number;
  let now = 0;
  const N = 7;

  // (happy-dom's WheelEvent is no MouseEvent: its keys and place are given by hand)
  const wheel = (deltaY: number, ctrlKey = true) => {
    const e = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true, composed: true });
    for (const [k, v] of Object.entries({ ctrlKey, clientX: 400, clientY: 225 })) Object.defineProperty(e, k, { value: v });
    root.dispatchEvent(e);
  };
  const key = (k: string) => kit.key(new KeyboardEvent('keydown', { key: k }));
  const overview = () => root.querySelector('ol-present-overview');
  const cells = () => Array.from(overview()!.shadowRoot!.querySelectorAll<HTMLElement>('.cell'));
  const last = () => views[views.length - 1];

  beforeEach(() => {
    vi.useFakeTimers();
    now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    document.body.innerHTML = '';
    root = document.createElement('div');
    document.body.appendChild(root);
    current = 2;
    views = []; gone = []; zoomTold = []; clicks = 0;
    root.addEventListener('click', () => clicks++);
    kit = new PresentKit({
      root,
      base: () => ({ x: 0, y: 0, w: 800, h: 450 }),
      apply: v => { views.push({ ...v }); },
      next: () => undefined,
      prev: () => undefined,
      exit: () => undefined,
      position: () => `${current + 1} / ${N}`,
      at: () => ({ slide: current, step: 1 }),
      onZoom: z => zoomTold.push(z),
      overview: {
        count: () => N,
        aspect: () => 9 / 16,
        thumb: (i, w, h) => { const d = document.createElement('div'); d.className = 'copy'; d.dataset.i = String(i); d.style.cssText = `width:${w}px;height:${h}px`; return d; },
        go: i => { gone.push(i); current = i; kit.slideChanged(); },
      },
    });
    kit.slideChanged();
  });
  afterEach(() => { kit.destroy(); vi.restoreAllMocks(); vi.useRealTimers(); });

  it('a pinch out at the whole slide shrinks it, then snaps into the overview', () => {
    wheel(20);
    expect(last().s).toBeLessThan(1);
    expect(last().s).toBeGreaterThan(OVERVIEW_AT);
    expect(overview()).toBeNull();
    for (let i = 0; i < 6 && !overview(); i++) wheel(20);
    expect(overview()).not.toBeNull();
    expect(kit.overviewOn).toBe(true);
    expect(zoomTold).toContain(true);
    // a copy of every slide, slotted in; the one shown marked
    expect(overview()!.querySelectorAll('.copy')).toHaveLength(N);
    expect(cells()).toHaveLength(N);
    expect(cells()[current].classList.contains('cur')).toBe(true);
    // the rest of that pinch does not take it away again
    wheel(-40);
    expect(kit.overviewOn).toBe(true);
  });

  it('let go before the overview, the slide springs back to the whole of it', () => {
    wheel(15);
    expect(last().s).toBeLessThan(1);
    now += WHEEL_END_MS + 10;
    vi.advanceTimersByTime(WHEEL_END_MS + 10);
    now += 400;
    vi.advanceTimersByTime(100);
    expect(last()).toEqual({ s: 1, x: 0, y: 0 });
    expect(overview()).toBeNull();
  });

  it('zooming out from zoomed in stops at the whole slide', () => {
    key('+'); key('+');
    expect(kit.zoomed).toBe(true);
    for (let i = 0; i < 12; i++) wheel(40);
    expect(kit.zoomed).toBe(false);
    expect(last().s).toBe(1);
    expect(overview()).toBeNull();
    // a new pinch, begun at the whole slide, goes on into the overview
    now += WHEEL_END_MS + 10;
    for (let i = 0; i < 6 && !overview(); i++) wheel(40);
    expect(overview()).not.toBeNull();
  });

  it('G or - open it; the arrows choose, Enter shows that slide', () => {
    expect(key('g')).toBe(true);
    expect(kit.overviewOn).toBe(true);
    expect(key('ArrowRight')).toBe(true);
    expect(key('ArrowRight')).toBe(true);
    expect(cells()[4].classList.contains('sel')).toBe(true);
    expect(key('Enter')).toBe(true);
    expect(gone).toEqual([4]);
    expect(kit.overviewOn).toBe(false);
    expect(zoomTold[zoomTold.length - 1]).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(overview()).toBeNull();
    // at the whole slide, - is "every slide" too; Escape goes back to the one shown
    key('-');
    expect(kit.overviewOn).toBe(true);
    key('Escape');
    expect(kit.overviewOn).toBe(false);
    expect(gone).toEqual([4]);
  });

  it('a click on a slide shows it, and is not the presenter\'s (it would go on)', () => {
    key('g');
    cells()[5].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
    expect(gone).toEqual([5]);
    expect(clicks).toBe(0);
    expect(kit.overviewOn).toBe(false);
  });

  it('not with a single slide', () => {
    kit.destroy();
    kit = new PresentKit({
      root, base: () => ({ x: 0, y: 0, w: 800, h: 450 }), apply: () => undefined, next: () => undefined, prev: () => undefined, exit: () => undefined, position: () => '1 / 1',
      overview: { count: () => 1, aspect: () => 0.5, thumb: () => null, go: () => undefined },
    });
    key('g');
    expect(kit.overviewOn).toBe(false);
    for (let i = 0; i < 6; i++) wheel(40);
    expect(kit.overviewOn).toBe(false);
  });
});
