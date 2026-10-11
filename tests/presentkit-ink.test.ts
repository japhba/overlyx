// @vitest-environment happy-dom
/**
 * Drawing on slides while presenting, and the control bar that stays out of the audience's sight
 * (packages/client/src/app/presentkit.ts): slide units through the fit and the zoom, the eraser's
 * reach, strokes kept per slide; a tap brings the bar without going on, a second sends it away, it
 * fades by itself, the mouse brings it only near the bottom edge, a stroke sends it away; once a pen
 * has drawn, fingers tap and swipe instead of drawing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PresentKit, inkFrame, toSlide, strokesHit, strokeSvg, SLIDE_UNITS, TAP_IDLE_MS, INK_COLORS, type InkStroke } from '../packages/client/src/app/presentkit';

describe('slide units', () => {
  const base = { x: 80, y: 0, w: 1440, h: 810 };
  it('a screen point and back, with or without the zoom', () => {
    for (const v of [{ s: 1, x: 0, y: 0 }, { s: 2.5, x: -900, y: -300 }]) {
      const f = inkFrame(v, base)!;
      const u = toSlide({ x: 700, y: 400 }, f);
      expect(f.ox + f.k * u[0]).toBeCloseTo(700);
      expect(f.oy + f.k * u[1]).toBeCloseTo(400);
    }
    // the slide's corners: 0 and SLIDE_UNITS across, in proportion down
    const f = inkFrame({ s: 1, x: 0, y: 0 }, base)!;
    expect(toSlide({ x: 80, y: 0 }, f)).toEqual([0, 0]);
    const br = toSlide({ x: 1520, y: 810 }, f);
    expect(br[0]).toBeCloseTo(SLIDE_UNITS);
    expect(br[1]).toBeCloseTo(SLIDE_UNITS * 810 / 1440);
    expect(inkFrame({ s: 1, x: 0, y: 0 }, null)).toBeNull();
  });
  it('the eraser reaches a stroke within its radius plus half the stroke\'s width', () => {
    const strokes: InkStroke[] = [
      { marker: false, color: INK_COLORS[0], w: 2, pts: [[0, 0], [100, 0]] },
      { marker: true, color: INK_COLORS[1], w: 20, pts: [[0, 100], [100, 100]] },
      { marker: false, color: INK_COLORS[0], w: 2, pts: [[500, 500]] },
    ];
    expect(strokesHit(strokes, [50, 5], 5)).toEqual([0]);
    expect(strokesHit(strokes, [50, 7], 5)).toEqual([]);
    expect(strokesHit(strokes, [50, 85], 5)).toEqual([1]);
    expect(strokesHit(strokes, [503, 500], 5)).toEqual([2]);
    expect(strokesHit(strokes, [150, 0], 5)).toEqual([]);
  });
  it('a stroke as SVG: the highlighter translucent, only the palette\'s colours', () => {
    expect(strokeSvg({ marker: true, color: INK_COLORS[1], w: 12, pts: [[0, 0], [10, 10]] })).toContain('stroke-opacity="0.38"');
    const evil = strokeSvg({ marker: false, color: '"/><script>', w: 2, pts: [[0, 0], [10, 10]] });
    expect(evil).not.toContain('script');
    expect(evil).toContain(`stroke="${INK_COLORS[0]}"`);
  });
});

describe('the kit on a presenting surface', () => {
  let root: HTMLElement;
  let kit: PresentKit;
  let slide = 1;
  let next: ReturnType<typeof vi.fn>;
  let clicks: number;
  const H = () => window.innerHeight;

  const pointer = (type: string, pointerType: string, x: number, y: number, id = 1, extra: Record<string, unknown> = {}) =>
    root.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true, composed: true, ...extra } as PointerEventInit));
  const click = (x: number, y: number) => root.dispatchEvent(new MouseEvent('click', { clientX: x, clientY: y, bubbles: true, cancelable: true, composed: true }));
  const tap = (pointerType: string, x: number, y: number, id = 1) => { pointer('pointerdown', pointerType, x, y, id); pointer('pointerup', pointerType, x, y, id); click(x, y); };
  const stroke = (pointerType: string, pts: [number, number][], id = 1) => {
    pointer('pointerdown', pointerType, pts[0][0], pts[0][1], id);
    for (const [x, y] of pts.slice(1)) pointer('pointermove', pointerType, x, y, id);
    const [x, y] = pts[pts.length - 1];
    pointer('pointerup', pointerType, x, y, id);
    click(x, y);
  };
  const shadow = () => root.querySelector('ol-present-ui')!.shadowRoot!;
  const barShown = () => shadow().querySelector('.bar')!.classList.contains('show');
  const key = (k: string, mods: KeyboardEventInit = {}) => kit.key(new KeyboardEvent('keydown', { key: k, ...mods }));

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    root = document.createElement('div');
    document.body.appendChild(root);
    slide = 1;
    clicks = 0;
    next = vi.fn();
    // the presenter's own click (it goes on): reached only when the kit lets the click through
    root.addEventListener('click', () => clicks++);
    kit = new PresentKit({
      root,
      base: () => ({ x: 0, y: 0, w: 800, h: 450 }),
      apply: () => undefined,
      next: next as unknown as () => void,
      prev: () => undefined,
      exit: () => undefined,
      position: () => `${slide} / 3`,
    });
    kit.slideChanged();
  });
  afterEach(() => { kit.destroy(); vi.useRealTimers(); });

  it('a tap on a touch screen brings the bar and does not go on; a second sends it away; it fades by itself', () => {
    expect(barShown()).toBe(false);
    tap('touch', 300, 200);
    expect(barShown()).toBe(true);
    expect(clicks).toBe(0);
    expect(next).not.toHaveBeenCalled();
    tap('touch', 300, 200);
    expect(barShown()).toBe(false);
    tap('touch', 300, 200);
    vi.advanceTimersByTime(TAP_IDLE_MS + 50);
    expect(barShown()).toBe(false);
    // a swipe still goes on, and shows no bar
    pointer('pointerdown', 'touch', 400, 200);
    pointer('pointermove', 'touch', 330, 202);
    pointer('pointermove', 'touch', 250, 204);
    pointer('pointerup', 'touch', 250, 204);
    expect(next).toHaveBeenCalledTimes(1);
    expect(barShown()).toBe(false);
  });

  it('a mouse click still goes on; the mouse brings the bar only near the bottom edge', () => {
    tap('mouse', 300, 200);
    expect(clicks).toBe(1);
    expect(barShown()).toBe(false);
    pointer('pointermove', 'mouse', 300, 200, 1, { buttons: 0 });
    expect(barShown()).toBe(false);
    pointer('pointermove', 'mouse', 300, H() - 30, 1, { buttons: 0 });
    expect(barShown()).toBe(true);
  });

  it('the pen draws on the slide, sends the bar away, and its strokes stay with their slide', () => {
    key('p', { ctrlKey: true });
    expect(kit.toolOn).toBe('pen');
    expect(root.classList.contains('olpk-drawing')).toBe(true);
    tap('touch', 100, 100);
    expect(barShown()).toBe(true);
    expect(kit.strokes).toHaveLength(0);
    stroke('mouse', [[100, 100], [150, 120], [200, 160], [260, 170]]);
    expect(kit.strokes).toHaveLength(1);
    expect(barShown()).toBe(false);
    // drawing is not a click on the slide
    expect(clicks).toBe(0);
    expect(shadow().querySelectorAll('g.strokes path')).toHaveLength(1);
    // another slide: its own (none); back: the stroke again
    slide = 2; kit.slideChanged();
    expect(kit.strokes).toHaveLength(0);
    expect(shadow().querySelectorAll('g.strokes path')).toHaveLength(0);
    slide = 1; kit.slideChanged();
    expect(kit.strokes).toHaveLength(1);
    // the eraser takes it away
    key('e', { ctrlKey: true });
    expect(kit.toolOn).toBe('eraser');
    stroke('mouse', [[300, 300], [150, 121], [140, 118]]);
    expect(kit.strokes).toHaveLength(0);
    // E clears the slide; Escape puts the tool away
    key('p', { ctrlKey: true });
    stroke('mouse', [[100, 100], [200, 200]]);
    expect(kit.strokes).toHaveLength(1);
    key('E');
    expect(kit.strokes).toHaveLength(0);
    expect(key('Escape')).toBe(true);
    expect(kit.toolOn).toBeNull();
    expect(key('Escape')).toBe(false);
  });

  it('once a pen has drawn, a finger taps and swipes instead of drawing; a palm under the pen is ignored', () => {
    key('i', { ctrlKey: true });
    expect(kit.toolOn).toBe('marker');
    // before any pen: a finger draws
    stroke('touch', [[100, 100], [200, 100]]);
    expect(kit.strokes).toHaveLength(1);
    expect(kit.strokes[0].marker).toBe(true);
    stroke('pen', [[100, 200], [200, 220]], 7);
    expect(kit.strokes).toHaveLength(2);
    // now a finger's swipe goes on and draws nothing
    pointer('pointerdown', 'touch', 400, 300, 2);
    pointer('pointermove', 'touch', 300, 302, 2);
    pointer('pointermove', 'touch', 250, 304, 2);
    pointer('pointerup', 'touch', 250, 304, 2);
    expect(next).toHaveBeenCalledTimes(1);
    expect(kit.strokes).toHaveLength(2);
    // a palm on the glass while the pen writes: the stroke goes on, nothing is pinched
    pointer('pointerdown', 'pen', 100, 300, 8);
    pointer('pointermove', 'pen', 150, 310, 8);
    pointer('pointerdown', 'touch', 500, 400, 3);
    pointer('pointermove', 'pen', 200, 320, 8);
    pointer('pointerup', 'pen', 200, 320, 8);
    pointer('pointerup', 'touch', 500, 400, 3);
    expect(kit.strokes).toHaveLength(3);
    expect(kit.zoomed).toBe(false);
  });

  it('a tap with a drawing tool in hand makes no dot: it brings the bar', () => {
    key('p', { ctrlKey: true });
    tap('touch', 300, 200);
    expect(kit.strokes).toHaveLength(0);
    expect(barShown()).toBe(true);
  });
});
