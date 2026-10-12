// @vitest-environment happy-dom
/**
 * Drawing on slides while presenting, and the control bar that stays out of the audience's sight
 * (packages/client/src/app/presentkit.ts): slide units through the fit and the zoom, the eraser's
 * reach, strokes kept per slide; a tap brings the bar without going on, a second sends it away, it
 * fades by itself, the mouse brings it only near the bottom edge, a stroke sends it away; only the
 * Pencil draws (with the pen when no tool is in hand) unless the bar's "Fingers draw" is on — fingers
 * tap, swipe and pinch; the hand resting on the glass while the Pencil writes counts for nothing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PresentKit, inkFrame, toSlide, strokesHit, strokeSvg, SLIDE_UNITS, TAP_IDLE_MS, INK_COLORS, PALM_AFTER_MS, PRESENT_FINGERS_KEY, type InkStroke } from '../packages/client/src/app/presentkit';

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
  let fingersTold: boolean[];
  let clicks: number;
  /** performance.now(), moved on by the tests (the hand's touches are told by how soon after the Pencil they come) */
  let now = 0;
  const later = (ms = PALM_AFTER_MS + 50) => { now += ms; };
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
    now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    localStorage.removeItem(PRESENT_FINGERS_KEY);
    fingersTold = [];
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
      onFingersDraw: on => fingersTold.push(on),
    });
    kit.slideChanged();
  });
  afterEach(() => { kit.destroy(); vi.restoreAllMocks(); vi.useRealTimers(); });

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

  it('only the Pencil draws: a finger with the tool in hand swipes, taps and pinches instead', () => {
    key('i', { ctrlKey: true });
    expect(kit.toolOn).toBe('marker');
    expect(kit.fingersDrawOn).toBe(false);
    // a finger's swipe goes on and draws nothing, even before any Pencil
    stroke('touch', [[400, 300], [330, 302], [250, 304]], 2);
    expect(next).toHaveBeenCalledTimes(1);
    expect(kit.strokes).toHaveLength(0);
    expect(clicks).toBe(0);
    // the Pencil draws with the tool in hand
    stroke('pen', [[100, 200], [150, 210], [200, 220]], 7);
    expect(kit.strokes).toHaveLength(1);
    expect(kit.strokes[0].marker).toBe(true);
    later();
    // two fingers pinch, the tool still in hand
    pointer('pointerdown', 'touch', 300, 200, 3);
    pointer('pointerdown', 'touch', 400, 200, 4);
    pointer('pointermove', 'touch', 250, 200, 3);
    pointer('pointermove', 'touch', 450, 200, 4);
    pointer('pointerup', 'touch', 250, 200, 3);
    pointer('pointerup', 'touch', 450, 200, 4);
    expect(kit.zoomed).toBe(true);
    expect(kit.strokes).toHaveLength(1);
    // zoomed, a finger pans and does not draw
    const z = kit.zoom;
    stroke('touch', [[300, 200], [340, 230], [380, 260]], 5);
    expect(kit.zoom).not.toEqual(z);
    expect(kit.strokes).toHaveLength(1);
    // no tool in hand: the Pencil draws with the pen, and its stroke does not go on
    kit.resetZoom();
    key('Escape');
    expect(kit.toolOn).toBeNull();
    later();
    stroke('pen', [[100, 300], [160, 320], [220, 330]], 8);
    expect(kit.strokes).toHaveLength(2);
    expect(kit.strokes[1].marker).toBe(false);
    expect(kit.strokes[1].color).toBe(INK_COLORS[0]);
    expect(clicks).toBe(0);
    expect(next).toHaveBeenCalledTimes(1);
    // the laser in hand: the Pencil points, a finger still swipes
    later();
    key('l');
    pointer('pointerdown', 'pen', 300, 300, 9);
    pointer('pointermove', 'pen', 380, 330, 9);
    vi.advanceTimersByTime(50);
    expect(shadow().querySelectorAll('g.live g.held path')).not.toHaveLength(0);
    pointer('pointerup', 'pen', 340, 310, 9);
    expect(kit.strokes).toHaveLength(2);
    later();
    stroke('touch', [[400, 300], [330, 302], [250, 304]], 10);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('"Fingers draw" on the bar: a finger draws with the tool in hand, kept in this browser and told to the host', () => {
    const btn = shadow().querySelector<HTMLElement>('button[data-k="fingers"]')!;
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    btn.click();
    expect(kit.fingersDrawOn).toBe(true);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(localStorage.getItem(PRESENT_FINGERS_KEY)).toBe('1');
    expect(fingersTold).toEqual([true]);
    // no tool in hand: a finger still swipes
    stroke('touch', [[400, 300], [330, 302], [250, 304]], 2);
    expect(next).toHaveBeenCalledTimes(1);
    expect(kit.strokes).toHaveLength(0);
    key('p', { ctrlKey: true });
    // (picking a tool leaves the switch alone)
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    stroke('touch', [[100, 100], [150, 100], [200, 100]], 3);
    expect(kit.strokes).toHaveLength(1);
    expect(next).toHaveBeenCalledTimes(1);
    // the host's own setting arriving: shown, not told back
    kit.setFingersDraw(false, false);
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(fingersTold).toEqual([true]);
    stroke('touch', [[100, 150], [150, 150], [200, 150]], 4);
    expect(kit.strokes).toHaveLength(1);
    // a new presentation starts with what this browser kept
    kit.destroy();
    kit = new PresentKit({ root, base: () => ({ x: 0, y: 0, w: 800, h: 450 }), apply: () => undefined, next: () => undefined, prev: () => undefined, exit: () => undefined, position: () => '1 / 3' });
    expect(kit.fingersDrawOn).toBe(true);
  });

  it('the hand on the glass while the Pencil writes counts for nothing: under it, just after it, or down before it', () => {
    // a palm while the pen writes: the stroke goes on, nothing is pinched
    pointer('pointerdown', 'pen', 100, 300, 8);
    pointer('pointermove', 'pen', 150, 310, 8);
    pointer('pointerdown', 'touch', 500, 400, 3);
    pointer('pointerdown', 'touch', 560, 420, 4);
    pointer('pointermove', 'touch', 600, 450, 4);
    pointer('pointermove', 'pen', 200, 320, 8);
    pointer('pointerup', 'pen', 200, 320, 8);
    pointer('pointerup', 'touch', 500, 400, 3);
    pointer('pointerup', 'touch', 600, 450, 4);
    expect(kit.strokes).toHaveLength(1);
    expect(kit.zoomed).toBe(false);
    // a palm coming down just after the pen lifts and dragging: no next slide, no bar
    now += 100;
    stroke('touch', [[400, 300], [330, 302], [250, 304]], 5);
    expect(next).not.toHaveBeenCalled();
    expect(clicks).toBe(0);
    tap('touch', 300, 200, 6);
    expect(barShown()).toBe(false);
    // the hand down first (two touches pinching), then the pen: the pinch is put back, the pen draws
    later();
    pointer('pointerdown', 'touch', 300, 300, 11);
    pointer('pointerdown', 'touch', 380, 320, 12);
    pointer('pointermove', 'touch', 250, 300, 11);
    pointer('pointermove', 'touch', 450, 330, 12);
    expect(kit.zoomed).toBe(true);
    pointer('pointerdown', 'pen', 100, 100, 13);
    expect(kit.zoomed).toBe(false);
    pointer('pointermove', 'pen', 150, 120, 13);
    pointer('pointermove', 'touch', 500, 340, 12);
    pointer('pointermove', 'pen', 200, 140, 13);
    pointer('pointerup', 'pen', 200, 140, 13);
    expect(kit.zoomed).toBe(false);
    expect(kit.strokes).toHaveLength(2);
    // the hand lifting later is no swipe, no tap
    later();
    pointer('pointermove', 'touch', 100, 340, 12);
    pointer('pointerup', 'touch', 100, 340, 12);
    pointer('pointerup', 'touch', 250, 300, 11);
    click(250, 300);
    expect(next).not.toHaveBeenCalled();
    expect(clicks).toBe(0);
    expect(barShown()).toBe(false);
    // a finger after all that: a swipe goes on again
    stroke('touch', [[400, 300], [330, 302], [250, 304]], 14);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('a tap with a drawing tool in hand makes no dot: it brings the bar', () => {
    key('p', { ctrlKey: true });
    tap('touch', 300, 200);
    expect(kit.strokes).toHaveLength(0);
    expect(barShown()).toBe(true);
  });
});
