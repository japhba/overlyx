/**
 * Display glitches on a touch screen (core glitch.ts): a stroke point far off is found, with what it
 * was; a report keeps measurements and fixed words only.
 */
import { describe, it, expect } from 'vitest';
import { StrokeWatch, cleanGlitch, glitchReport } from '../packages/core/src/glitch.ts';

const screen = { w: 1024, h: 768 };
const line = (w: StrokeWatch, from: number, to: number, y = 300, t0 = 0) => { for (let x = from; x <= to; x += 4) w.add(x, y, t0 + x / 4, 'coalesced'); };

describe('a stroke that jumps across the screen', () => {
  it('a hand-drawn stroke, fast as it may be, is none', () => {
    const w = new StrokeWatch('deck', 'pen', screen);
    w.add(100, 300, 0, 'down');
    line(w, 104, 900);
    w.add(904, 300, 230, 'up');
    expect(w.end()).toBeNull();
  });

  it('one stray point at the screen corner: where, what kind of event, and that the next came back', () => {
    const w = new StrokeWatch('board', 'pen', screen);
    w.add(400, 300, 0, 'down');
    line(w, 404, 500, 300, 0);
    w.add(0, 0, 126, 'move');
    line(w, 504, 520, 300, 126);
    expect(w.end()).toMatchObject({ engine: 'board', pointer: 'pen', sample: 'move', before: 'coalesced', at: 'middle', spike: 'yes', place: 'origin', dt: 1 });
  });

  it('the surface scrolling mid-stroke moves the line, the hand need not have', () => {
    const w = new StrokeWatch('doc-ink', 'pen', screen);
    w.add(400, 300, 0, 'down', 0, 0);
    w.add(404, 300, 4, 'coalesced', 0, 0);
    w.add(408, 300, 8, 'coalesced', 0, 600);
    expect(w.end()).toMatchObject({ at: 'last', place: 'inside', scrolled: 600, jump: 78 });
  });
});

describe('a glitch report', () => {
  it('keeps measurements and fixed words, drops anything else', () => {
    const g = cleanGlitch('shift', { scroller: 'window', scrollY: 312.4, focus: 'math', keyboard: 'down', title: 'My thesis', focusAt: 'somewhere', container: 'Not A Class' },
      ['120 focus math below', '80 keyboard down', '40 typed my secret words', '10 scroll 312']);
    expect(g).toEqual({ kind: 'shift', fields: { scroller: 'window', scrollY: 312.4, focus: 'math', keyboard: 'down' }, trail: ['120 focus math below', '80 keyboard down', '10 scroll 312'] });
    expect(cleanGlitch('crash', {}, [])).toBeNull();
  });

  it('its message tells one glitch from another, its details are the measurements', () => {
    const r = glitchReport('shift', { scroller: 'window', keyboard: 'down', focus: 'math', focusAt: 'below', app: 'home-screen', scrollY: 312 }, ['120 focus math below'])!;
    expect(r.message).toBe('The interface scrolled out of place · the window · keyboard down · focus math below · home-screen');
    expect(r.details.scrollY).toBe('312');
    expect(r.trail).toContain('120 focus math below');
    expect(glitchReport('jump', { engine: 'deck', pointer: 'pen', sample: 'coalesced', at: 'middle', spike: 'yes', place: 'origin' }, [])!.message)
      .toBe('A stroke jumped across the screen · deck · pen · coalesced point, middle of the stroke · one stray point · at the screen corner (0, 0)');
  });
  it('a touch taken for the palm: how broad it was, nothing else', () => {
    const r = glitchReport('palm', { engine: 'deck', contact: 124, contactH: 96, frameScale: 0.98, zoom: 0.75, title: 'x' }, [])!;
    expect(r.message).toBe('A touch was taken for the palm by its breadth · deck · about 120 px on the screen');
    expect(r.details).toEqual({ engine: 'deck', contact: '124', contactH: '96', frameScale: '0.98', zoom: '0.75' });
  });
});
