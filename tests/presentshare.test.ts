// @vitest-environment happy-dom
/**
 * Presenting on several screens at once (packages/client/src/app/presentshare.ts, presentkit.ts): the
 * shared strokes' encoding and its checks, merging the presenters' strokes, erasing anyone's, keeping
 * those of a presenter that stopped, a late joiner getting them, the cap on what one shares, the slide
 * keys, and "Linked" — whichever screen moves takes the others along, following is no move, a screen
 * joining late follows the first. Then two kits wired to each other as two screens.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  PresentShare, encodePts, decodePts, encodeStroke, decodeStroke, readPresent, checkedPresent, slideKey, leads,
  INK_CAP, GONE_CAP, type PresentState, type SharedStroke,
} from '../packages/client/src/app/presentshare';
import { PresentKit, INK_COLORS, PALM_AFTER_MS, PRESENT_LINKED_KEY, type InkStroke } from '../packages/client/src/app/presentkit';
import { MAX_AWARENESS_STATE_JSON } from '../packages/core/src/awareness';

const line = (x0: number, y0: number, n = 20): [number, number][] => Array.from({ length: n }, (_, i) => [x0 + i * 7.3, y0 + Math.sin(i / 2) * 9]);
const stroke = (id: string, x0 = 100, y0 = 100, n = 20): SharedStroke => ({ id, marker: false, color: INK_COLORS[0], w: 3, pts: line(x0, y0, n) });
/** one screen's state as the others see it in the awareness (through JSON, as it travels) */
const wire = (s: PresentState) => JSON.parse(JSON.stringify(s)) as unknown;

describe('encoding', () => {
  it('points in quarter units, each as the step from the one before, back as they were', () => {
    const pts: [number, number][] = [[0, 0], [10.25, 3.5], [9.75, -2], [999.5, 562.25]];
    expect(encodePts(pts)).toBe('0,0,41,14,-2,-22,3959,2257');
    expect(decodePts(encodePts(pts))).toEqual(pts);
    // to the nearest quarter
    expect(decodePts(encodePts([[1.13, 2.9]]))).toEqual([[1.25, 3]]);
  });
  it('anything else is no points: letters, an odd count, far off the slide', () => {
    for (const bad of ['1,2,x,4', '1,2,3', '1e5,2', '80001,0', 5, null, '1,2;3,4']) expect(decodePts(bad)).toBeNull();
    expect(decodePts('')).toEqual([]);
  });
  it('a stroke: its id, highlighter, colour and width, its points simplified; others rejected', () => {
    const s = stroke('ab.1');
    const back = decodeStroke(encodeStroke(s))!;
    expect(back.id).toBe('ab.1');
    expect(back.color).toBe(INK_COLORS[0]);
    expect(back.pts.length).toBeLessThanOrEqual(s.pts.length);
    // simplified: every point drawn within half a px (of a 1500 px wide slide) of the line shared, and the quarter units
    const seg = (p: [number, number], a: [number, number], b: [number, number]) => {
      const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy, t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
      return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
    };
    for (const p of s.pts) expect(Math.min(...back.pts.slice(1).map((q, i) => seg(p, back.pts[i], q)))).toBeLessThan(0.35 + 0.2);
    expect(decodeStroke(encodeStroke({ ...s, marker: true }))!.marker).toBe(true);
    for (const bad of ['AB;0;#ff0000;3;0,0', 'a b;0;#ff0000;3;0,0', 'a.1;2;#ff0000;3;0,0', 'a.1;0;red;3;0,0', 'a.1;0;#ff0000;-1;0,0', 'a.1;0;#ff0000;3;', 'a.1;0;"/><x;3;0,0'])
      expect(decodeStroke(bad)).toBeNull();
    expect(decodeStroke('ab.1;0;#ff0000;3;0,0')).not.toBeNull();
  });
  it('a state that is not one is nobody presenting; its strokes are decoded again only when they changed', () => {
    for (const bad of [null, 'x', { v: 2 }, { v: 1, id: 'a', iv: 0, at: { slide: 0, step: 0, n: 0, linked: true, t0: 1 }, ink: {} }]) expect(readPresent(bad, 1)).toBeNull();
    const a = new PresentShare('a');
    const s = wire(a.state(new Map([['s0', [stroke('a.1')]]]), 's0', null, null));
    const p = readPresent(s, 7)!;
    expect(p.ink.get('s0')).toHaveLength(1);
    const again = readPresent(s, 7, p)!;
    expect(again.ink).toBe(p.ink);
  });
  it('a frame\'s state is checked before it is shared: what is not a stroke is left out', () => {
    const a = new PresentShare('a');
    const s = wire(a.state(new Map([['s0', [stroke('a.1')]]]), 's0', null, null)) as PresentState;
    s.ink.s0.push('<script>');
    (s.ink as Record<string, unknown>)['<bad key>'] = [encodeStroke(stroke('a.2'))];
    const c = checkedPresent(s)!;
    expect(c.ink.s0).toHaveLength(1);
    expect(Object.keys(c.ink)).toEqual(['s0']);
    expect(checkedPresent({ ...s, at: { slide: -1 } })).toBeNull();
  });
});

describe('several presenters', () => {
  const own = (...list: [string, InkStroke[]][]) => new Map(list);

  it('each shows the others\' strokes on the same slide, each once', () => {
    const a = new PresentShare('a'), b = new PresentShare('b');
    const sa = stroke(a.newId()), sb = stroke(b.newId(), 300, 300);
    b.setPeers([{ client: 1, state: wire(a.state(own(['s0', [sa]]), 's0', null, null)) }]);
    a.setPeers([{ client: 2, state: wire(b.state(own(['s0', [sb]], ['s1', [stroke(b.newId())]]), 's0', null, null)) }]);
    expect(a.merged('s0', [sa]).map(s => s.id)).toEqual([sa.id, sb.id]);
    expect(b.merged('s0', [sb]).map(s => s.id)).toEqual([sb.id, sa.id]);
    expect(a.merged('s1', [])).toHaveLength(1);
    expect(a.merged('s2', [])).toHaveLength(0);
    expect(a.presenters).toBe(1);
  });

  it('erasing another\'s stroke: it goes on every screen, and its owner stops sharing it', () => {
    const a = new PresentShare('a'), b = new PresentShare('b');
    const sa = stroke(a.newId());
    const aInk = own(['s0', [sa]]);
    b.setPeers([{ client: 1, state: wire(a.state(aInk, 's0', null, null)) }]);
    b.erase([sa.id]);
    expect(b.merged('s0', [])).toHaveLength(0);
    // a hears of it: hidden there, and no longer in its state
    expect(a.setPeers([{ client: 2, state: wire(b.state(own(), 's0', null, null)) }])).toBe(true);
    expect(a.merged('s0', [sa])).toHaveLength(0);
    expect((a.state(aInk, 's0', null, null)).ink.s0 ?? []).toHaveLength(0);
    // the erased ones told are the newest few hundred
    b.erase(Array.from({ length: GONE_CAP + 50 }, (_, i) => `z.${i}`));
    expect(b.state(own(), 's0', null, null).gone).toHaveLength(GONE_CAP);
  });

  it('a presenter joining late gets the strokes made so far; one that stops leaves them with the others', () => {
    const a = new PresentShare('a'), b = new PresentShare('b'), c = new PresentShare('c');
    const sa = stroke(a.newId());
    const aState = wire(a.state(own(['s2', [sa]]), 's2', null, null));
    b.setPeers([{ client: 1, state: aState }]);
    c.setPeers([{ client: 1, state: aState }]);
    expect(c.merged('s2', [])).toHaveLength(1);
    // a stops presenting: b keeps its strokes and shares them on
    expect(b.setPeers([])).toBe(true);
    expect(b.merged('s2', [])).toHaveLength(1);
    const d = new PresentShare('d');
    d.setPeers([{ client: 2, state: wire(b.state(own(), 's0', null, null)) }]);
    expect(d.merged('s2', []).map(s => s.id)).toEqual([sa.id]);
  });

  it('what one shares stays within its cap — the slide shown and the newest strokes first — far under the server\'s limit', () => {
    const a = new PresentShare('a');
    const ink = new Map<string, InkStroke[]>();
    for (let k = 0; k < 40; k++) ink.set(slideKey(k), Array.from({ length: 12 }, () => stroke(a.newId(), 50, 50, 300)));
    const st = a.state(ink, slideKey(5), null, null);
    const chars = Object.values(st.ink).flat().reduce((n, e) => n + e.length, 0);
    expect(chars).toBeLessThanOrEqual(INK_CAP);
    expect(chars).toBeGreaterThan(INK_CAP * 0.8);
    expect(st.ink[slideKey(5)]).toHaveLength(12);
    expect(st.ink[slideKey(39)]).toHaveLength(12);
    expect(st.ink[slideKey(0)]).toBeUndefined();
    expect(JSON.stringify(st).length).toBeLessThan(MAX_AWARENESS_STATE_JSON / 4);
  });

  it('slides are keyed by their index, the same on every screen', () => {
    expect(slideKey(0)).toBe('s0');
    expect(slideKey(11)).toBe('s11');
  });
});

describe('Linked: the slide shown', () => {
  const st = (s: PresentShare) => wire(s.state(new Map(), 's0', null, null));

  it('whichever screen moves takes the others along; following is no move of their own', () => {
    const a = new PresentShare('a'), b = new PresentShare('b');
    a.place(0, 1); b.place(0, 1);
    a.setPeers([{ client: 2, state: st(b), mine: true }]);
    b.setPeers([{ client: 1, state: st(a), mine: true }]);
    // neither has moved: no one follows the other... (the first to present leads those that came later)
    a.at.t0 = b.at.t0 = 1000;
    b.setPeers([{ client: 1, state: st(a), mine: true }]);
    expect(b.leader()).toBeNull();
    a.moved(3, 1);
    b.setPeers([{ client: 1, state: st(a), mine: true }]);
    const f = b.leader()!;
    expect(f).toMatchObject({ slide: 3, step: 1 });
    b.moved(3, 1, f);
    expect(b.at.n).toBe(a.at.n);
    // b following is no news for a
    a.setPeers([{ client: 2, state: st(b), mine: true }]);
    expect(a.leader()).toBeNull();
    expect(b.leader()).toBeNull();
    // now b moves: a goes along
    b.moved(4, 2);
    a.setPeers([{ client: 2, state: st(b), mine: true }]);
    expect(a.leader()).toMatchObject({ slide: 4, step: 2 });
  });

  it('a screen joining late follows the one presenting already, not the other way round', () => {
    const first = new PresentShare('z'), late = new PresentShare('a');
    first.at.t0 = 1000; late.at.t0 = 5000;
    first.place(6, 1); late.place(0, 1);
    late.setPeers([{ client: 1, state: st(first), mine: true }]);
    first.setPeers([{ client: 2, state: st(late), mine: true }]);
    expect(late.leader()).toMatchObject({ slide: 6 });
    expect(first.leader()).toBeNull();
    expect(leads(first.at, first.id, late.at, late.id)).toBe(true);
  });

  it('someone else presenting the document does not turn this screen\'s slides (its strokes still show)', () => {
    const a = new PresentShare('a'), b = new PresentShare('b');
    a.place(0, 1); b.place(0, 1);
    a.moved(5, 1);
    const sa = stroke(a.newId());
    b.setPeers([{ client: 1, state: wire(a.state(new Map([['s0', [sa]]]), 's0', null, null)), mine: false }]);
    expect(b.leader()).toBeNull();
    expect(b.leader(true)).toBeNull();
    expect(b.merged('s0', [])).toHaveLength(1);
    expect(b.screens).toBe(0);
    expect(b.presenters).toBe(1);
  });

  it('unlinked, a screen goes its own way and takes no one along; linked again, it joins the others', () => {
    const a = new PresentShare('a'), b = new PresentShare('b');
    a.place(0, 1); b.place(0, 1);
    b.setLinked(false);
    a.moved(2, 1);
    b.setPeers([{ client: 1, state: st(a), mine: true }]);
    expect(b.leader()).toBeNull();
    b.moved(7, 1);
    a.setPeers([{ client: 2, state: st(b), mine: true }]);
    expect(a.leader()).toBeNull();
    b.setLinked(true);
    expect(b.leader(true)).toMatchObject({ slide: 2 });
  });
});

describe('two kits as two screens', () => {
  interface Screen { kit: PresentKit; root: HTMLElement; slide: number; step: number; goTo: ReturnType<typeof vi.fn>; out: PresentState | null }
  let now = 0;
  let screens: Screen[] = [];

  const make = (client: number): Screen => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const sc = { root, slide: 0, step: 1, out: null } as Screen;
    sc.goTo = vi.fn((slide: number, step: number) => { sc.slide = slide; sc.step = step; sc.kit.slideChanged(); });
    sc.kit = new PresentKit({
      root, base: () => ({ x: 0, y: 0, w: 800, h: 450 }), apply: () => undefined,
      next: () => { sc.slide++; sc.step = 1; sc.kit.slideChanged(); }, prev: () => undefined, exit: () => undefined,
      position: () => `${sc.slide + 1} / 9`,
      at: () => ({ slide: sc.slide, step: sc.step }),
      goTo: sc.goTo as unknown as (slide: number, step: number) => void,
      share: state => {
        sc.out = state;
        // the awareness: the other screen hears of it
        for (const other of screens) if (other !== sc) other.kit.setPeers(state ? [{ client, state: wire(state), mine: true }] : []);
      },
    });
    return sc;
  };
  const pointer = (sc: Screen, type: string, x: number, y: number, extra: Record<string, unknown> = {}) =>
    sc.root.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: 'mouse', clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true, composed: true, ...extra } as PointerEventInit));
  const draw = (sc: Screen, pts: [number, number][]) => {
    pointer(sc, 'pointerdown', ...pts[0]);
    for (const p of pts.slice(1)) pointer(sc, 'pointermove', ...p);
    pointer(sc, 'pointerup', ...pts[pts.length - 1]);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    localStorage.removeItem(PRESENT_LINKED_KEY);
    document.body.innerHTML = '';
    screens = [];
    screens.push(make(1));
    screens[0].kit.slideChanged();
    now += 5000;
    screens.push(make(2));
    screens[1].kit.slideChanged();
    // each hears of the other as it is now (the awareness: the late one's state comes to the first)
    screens[0].kit.setPeers([{ client: 2, state: wire(screens[1].out!), mine: true }]);
    screens[1].kit.setPeers([{ client: 1, state: wire(screens[0].out!), mine: true }]);
  });
  afterEach(() => { for (const s of screens) s.kit.destroy(); vi.restoreAllMocks(); vi.useRealTimers(); });

  it('a stroke drawn on one shows on the other while it is drawn and once it is finished; the other\'s eraser takes it from both', () => {
    const [a, b] = screens;
    a.kit.setTool('pen');
    pointer(a, 'pointerdown', 100, 100);
    for (const [x, y] of [[150, 120], [200, 160], [260, 170]] as const) { now += 60; vi.advanceTimersByTime(60); pointer(a, 'pointermove', x, y); }
    vi.advanceTimersByTime(60);
    // drawn: on b too, as it goes
    expect(b.root.querySelector('ol-present-ui')!.shadowRoot!.querySelectorAll('g.remote path').length).toBe(1);
    pointer(a, 'pointerup', 260, 170);
    expect(b.kit.strokes).toHaveLength(1);
    expect(b.root.querySelector('ol-present-ui')!.shadowRoot!.querySelectorAll('g.remote path').length).toBe(0);
    // b erases it: gone on a too (both kits listen on the one window here: a's pen put away first)
    a.kit.setTool(null);
    b.kit.setTool('eraser');
    now += PALM_AFTER_MS;
    draw(b, [[300, 300], [150, 121], [140, 118]]);
    expect(b.kit.strokes).toHaveLength(0);
    expect(a.kit.strokes).toHaveLength(0);
  });

  it('linked: a move on either takes the other along; the laser shows on the other in the same place on the slide', () => {
    const [a, b] = screens;
    expect(b.kit.linked).toBe(true);
    a.kit.host.next();
    expect(b.goTo).toHaveBeenCalledWith(1, 1);
    expect(b.slide).toBe(1);
    // following was no move: a is not taken back
    expect(a.goTo).not.toHaveBeenCalled();
    b.kit.host.next();
    expect(a.slide).toBe(2);
    // the laser: held on a, shown on b
    a.kit.setLaser(true);
    pointer(a, 'pointerdown', 400, 200);
    now += 60; vi.advanceTimersByTime(60);
    pointer(a, 'pointermove', 420, 210);
    vi.advanceTimersByTime(60);
    const live = b.root.querySelector('ol-present-ui')!.shadowRoot!.querySelector('g.live')!;
    expect(live.querySelector('circle.head')).not.toBeNull();
    expect(Number(live.querySelector('circle.head')!.getAttribute('cx'))).toBeCloseTo(420, 0);
    pointer(a, 'pointerup', 420, 210);
    a.kit.setLaser(false);
    expect(live.querySelector('circle.head')).toBeNull();
  });

  it('the late screen followed the one presenting first; "Linked" off, it goes its own way', () => {
    const [a, b] = screens;
    a.slide = 4; a.kit.slideChanged();
    expect(b.slide).toBe(4);
    b.kit.setLinked(false);
    expect(localStorage.getItem(PRESENT_LINKED_KEY)).toBe('0');
    b.kit.host.next();
    expect(b.slide).toBe(5);
    expect(a.slide).toBe(4);
    a.kit.host.next();
    a.kit.host.next();
    expect(a.slide).toBe(6);
    expect(b.slide).toBe(5);
    // linked again: to where a is
    b.kit.setLinked(true);
    expect(b.slide).toBe(6);
  });
});
