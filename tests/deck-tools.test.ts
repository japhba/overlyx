// @vitest-environment happy-dom
/**
 * The deck canvas's new objects and edits as text (deliverable/sourceops.ts, core html/source.ts):
 * the shapes the toolbar draws, a line keeping the direction it was drawn in, the pen's stroke (in
 * Draw's ink: deckink.ts), an SVG file made a safe inline drawing (inlineSvgHtml), and the `reorder` operation behind
 * Arrange ▸ order (the text between the elements stays put, nothing else of the file changes).
 */
import { describe, it, expect } from 'vitest';
import { objectHtml, inlineSvgHtml, penPathD } from '../packages/client/src/deliverable/sourceops.ts';
import { loadDeckInk, saveDeckInk, patchDeckInk, deckInkStyle, defaultDeckInk } from '../packages/client/src/deliverable/deckink.ts';
import { freeOutline, outlinePathD, outlineBox, type FreePt } from '../packages/client/src/deliverable/runtime/freehand.ts';
import { applyOp, opSplices, parseSource, rebaseOp } from '../packages/core/src/html/source.ts';

describe('objects drawn on a slide', () => {
  it('polygon shapes are SVG stretched to their box, with an outline of constant width', () => {
    const star = objectHtml('star', { x: 10, y: 20, w: 200, h: 100 }, 'deck');
    expect(star).toMatch(/^<svg style="position: absolute; left: 10px; top: 20px; width: 200px; height: 100px; overflow: visible" viewBox="0 0 100 100" preserveAspectRatio="none"><polygon points="50,4 /);
    expect(star).toContain('vector-effect="non-scaling-stroke"');
    for (const t of ['triangle', 'diamond', 'hexagon'] as const) expect(objectHtml(t, { x: 0, y: 0, w: 50, h: 50 }, 'deck')).toContain('<polygon');
    expect(objectHtml('roundrect', { x: 0, y: 0, w: 50, h: 50 }, 'deck')).toContain('border-radius: 28px');
  });

  it('a line goes from where the drag started to where it ended', () => {
    // drawn from the lower right to the upper left
    const html = objectHtml('arrow', { x: 500, y: 550, w: 200, h: 100 }, 'deck', 1, [[700, 650], [500, 550]]);
    expect(html).toContain('left: 500px; top: 550px; width: 200px; height: 100px');
    expect(html).toContain('<line x1="200" y1="100" x2="0" y2="0"');
    expect(html).toContain('marker-end="url(#ah)"');
    // a click (no drag): a horizontal line of the default length
    expect(objectHtml('line', { x: 5, y: 6, w: 0, h: 0 }, 'deck')).toContain('<line x1="0" y1="0" x2="240" y2="0"');
  });

  it("the pen's stroke is a smooth path through its points, in its own box", () => {
    expect(penPathD([[0, 0], [10, 10], [20, 0]])).toBe('M0 0Q10 10 15 5L20 0');
    const html = objectHtml('pen', { x: 100, y: 50, w: 20, h: 10 }, 'deck', 1, [[100, 50], [110, 60], [120, 50]]);
    expect(html).toContain('left: 100px; top: 50px; width: 20px; height: 10px');
    expect(html).toContain('<path d="M0 0Q10 10 15 5L20 0" fill="none"');
    expect(objectHtml('pen', { x: 0, y: 0, w: 0, h: 0 }, 'deck', 1, [[1, 1]])).toBe('');
  });

  it("Draw's strokes are in the pen's ink; the highlighter's translucent and multiplied over what is under it", () => {
    const pts: [number, number][] = [[0, 0], [10, 10], [20, 0]];
    const pen = objectHtml('pen', { x: 0, y: 0, w: 20, h: 10 }, 'deck', 1, pts, undefined, { color: '#d93025', width: 8, opacity: 1 });
    expect(pen).toContain('stroke="#d93025" stroke-width="8" stroke-linecap');
    expect(pen).not.toContain('mix-blend-mode');
    const hl = objectHtml('pen', { x: 0, y: 0, w: 20, h: 10 }, 'deck', 1, pts, undefined, { color: '#fbbc04', width: 24, opacity: 0.35 });
    expect(hl).toContain('overflow: visible; mix-blend-mode: multiply"');
    expect(hl).toContain('stroke="#fbbc04" stroke-width="24" stroke-opacity="0.35"');
    // a colour that is no colour does not reach the page
    expect(objectHtml('pen', { x: 0, y: 0, w: 20, h: 10 }, 'deck', 1, pts, undefined, { color: '"><script>', width: 4, opacity: 1 })).toContain('stroke="#1d2433"');
  });
});

describe("Draw's strokes as GoodNotes draws them (runtime/freehand.ts)", () => {
  /** half the stroke's width at x (the outline of a level stroke along y = 0, where its edges cross x) */
  const half = (poly: number[][], x: number) => {
    let h = 0;
    for (let i = 0; i < poly.length; i++) {
      const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length];
      if ((ax - x) * (bx - x) > 0 || ax === bx) continue;
      h = Math.max(h, Math.abs(ay + (by - ay) * (x - ax) / (bx - ax)));
    }
    return h;
  };
  const level = (n: number, press: (t: number) => number): FreePt[] => Array.from({ length: n + 1 }, (_, i) => [i * 4, 0, press(i / n)]);

  it("is a little thinner at the start and the end — short, blunt tapers, no needle; the Pencil's pressure makes it wider", () => {
    for (const pressure of [true, false]) {
      const poly = freeOutline(level(100, () => 0.5), { width: 6, pressure, last: true });
      const mid = half(poly, 200);
      expect(mid).toBeGreaterThan(2);
      for (const x of [1, 399]) {
        expect(half(poly, x)).toBeLessThan(mid * 0.6);
        expect(half(poly, x)).toBeGreaterThan(mid * 0.25);
      }
      // (as wide as the rest a width and a half in)
      expect(half(poly, 9)).toBeGreaterThan(mid * 0.85);
      expect(half(poly, 391)).toBeGreaterThan(mid * 0.85);
    }
    const hard = freeOutline(level(100, () => 1), { width: 6, pressure: true, last: true });
    const light = freeOutline(level(100, () => 0.15), { width: 6, pressure: true, last: true });
    expect(half(hard, 200)).toBeGreaterThan(half(light, 200) * 1.6);
  });

  it("the highlighter is an even band; a tap is a dot", () => {
    const poly = freeOutline(level(100, () => 0.5), { width: 20, highlighter: true, last: true });
    expect(half(poly, 30)).toBeCloseTo(10, 0);
    expect(half(poly, 200)).toBeCloseTo(10, 0);
    const dot = outlineBox(freeOutline([[50, 50, 0.5]], { width: 6, pressure: true, last: true }));
    expect(dot.w).toBeGreaterThan(3);
    expect(dot.h).toBeGreaterThan(3);
  });

  it('is written as one closed path, moved into its own box', () => {
    const poly = freeOutline(level(20, () => 0.5), { width: 4, last: true });
    const b = outlineBox(poly);
    const d = outlinePathD(poly, -b.x, -b.y);
    expect(d).toMatch(/^M[\d.]+ [\d.]+Q/);
    expect(d.endsWith('Z')).toBe(true);
    expect(d).not.toMatch(/-\d/);   // (nothing left of or above its box)
    const html = objectHtml('pen', { x: 10, y: 20, w: b.w, h: b.h }, 'deck', 1, undefined, { d, closed: true }, { color: '#d93025', width: 4, opacity: 1 });
    expect(html).toMatch(/^<svg class="ol-ink" style="position: absolute; left: 10px; top: 20px; /);
    expect(html).toContain(`<path d="${d}" fill="#d93025"/>`);
    const hl = objectHtml('pen', { x: 0, y: 0, w: 9, h: 9 }, 'deck', 1, undefined, { d: 'M0 0L9 9Z" onload="x', closed: true }, { color: '#fbbc04', width: 24, opacity: 0.35 });
    expect(hl).toContain('mix-blend-mode: multiply');
    expect(hl).toContain('fill="#fbbc04" fill-opacity="0.35"');
    expect(hl).not.toContain('onload');
  });
});

describe("Draw's pens (deckink.ts)", () => {
  it('a preset clicked again and changed replaces that preset and is drawn with; the other pen keeps its own', () => {
    const ink = defaultDeckInk();
    const a = patchDeckInk(ink, { slotColor: { idx: 1, color: '#123456' } });
    expect(a.pens.pen.colors[1]).toBe('#123456');
    expect(a.pens.pen.color).toBe('#123456');
    expect(ink.pens.pen.colors[1]).not.toBe('#123456');   // (a new object)
    const b = patchDeckInk(a, { pen: 'highlighter', width: 40 });
    expect(b.pen).toBe('highlighter');
    expect(b.pens.highlighter.width).toBe(40);
    expect(b.pens.pen.color).toBe('#123456');
    expect(patchDeckInk(b, { slotWidth: { idx: 9, width: 3 } })).toEqual(b);   // no such preset
  });

  it("the stroke's ink: the highlighter translucent, widths scaled to the page (a poster's as thick, seen whole, as a slide's)", () => {
    const ink = defaultDeckInk();
    expect(deckInkStyle(ink)).toEqual({ color: ink.pens.pen.color, width: 4, opacity: 1 });
    expect(deckInkStyle(ink, 2560).width).toBe(8);
    expect(deckInkStyle(patchDeckInk(ink, { pen: 'highlighter' })).opacity).toBeLessThan(1);
  });

  it("is kept in this browser; what is broken in storage is the default's", () => {
    saveDeckInk(patchDeckInk(defaultDeckInk(), { pen: 'highlighter', color: '#4285f4' }));
    const back = loadDeckInk();
    expect(back.pen).toBe('highlighter');
    expect(back.pens.highlighter.color).toBe('#4285f4');
    localStorage.setItem('ol.deckInk', JSON.stringify({ pen: 'brush', pens: { pen: { color: 'red', width: -1, colors: [1, 2], widths: 'x' } } }));
    expect(loadDeckInk()).toEqual(defaultDeckInk());
    localStorage.setItem('ol.deckInk', '{');
    expect(loadDeckInk()).toEqual(defaultDeckInk());
    localStorage.removeItem('ol.deckInk');
  });
});

describe('an SVG file as a drawing on the page', () => {
  const SVG = `<?xml version="1.0"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" width="200" height="100" viewBox="0 0 200 100" onload="alert(0)">
  <sodipodi:namedview id="nv" pagecolor="#fff"/>
  <script>alert(1)</script>
  <foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>
  <defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/></linearGradient><symbol id="s" viewBox="0 0 10 10"><rect width="10" height="10"/></symbol></defs>
  <style>@import url(https://evil.example/x.css); #r1 { stroke: red; } .k { fill: url(#g); }</style>
  <rect id="r1" x="10" y="10" width="80" height="80" fill="url(#g)" onclick="alert(2)" sodipodi:nodetypes="cccc"/>
  <image href="https://tracker.example/p.png" width="10" height="10"/>
  <image xlink:href="data:image/png;base64,iVBORw0KGgo=" width="10" height="10"/>
  <use xlink:href="#s" x="100" y="10" width="40" height="40"/>
  <a href="javascript:alert(3)"><circle cx="150" cy="70" r="20" style="fill: url(https://evil.example/p.svg#x)"/></a>
</svg>`;
  const html = inlineSvgHtml(SVG, { x: 640, y: 360, maxW: 768 }, 'sX')!;

  it('keeps the drawing, removes what could run or reach out', () => {
    expect(html).toBeTruthy();
    expect(html).not.toMatch(/<script|onload|onclick|foreignObject|sodipodi|javascript:|evil\.example|tracker\.example|<!DOCTYPE|<\?xml/i);
    expect(html).toContain('<rect id="sX-r1"');
    expect(html).toContain('data:image/png;base64');
  });

  it('gives its ids a prefix and follows them in references and styles', () => {
    expect(html).toContain('<linearGradient id="sX-g">');
    expect(html).toContain('fill="url(#sX-g)"');
    expect(html).toMatch(/xlink:href="#sX-s"|href="#sX-s"/);
    expect(html).toContain('#sX-r1 { stroke: red; }');
    expect(html).toContain('fill: url(#sX-g)');
  });

  it('is placed centred on the drop point, its size from width / height or the viewBox, at most maxW wide', () => {
    expect(html).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]*style="position: absolute; left: 540px; top: 310px; width: 200px; height: 100px; overflow: visible"/);
    const wide = inlineSvgHtml('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2000 1000"><rect width="10" height="10"/></svg>', { x: 640, y: 360, maxW: 768 }, 'w')!;
    expect(wide).toContain('width: 768px; height: 384px');
    const page = inlineSvgHtml('<svg xmlns="http://www.w3.org/2000/svg" width="50mm" height="20mm"><rect width="10" height="10"/></svg>', null, 'p')!;
    expect(page).toContain('width: 189px; max-width: 100%; height: auto');
    expect(page).toContain('viewBox="0 0 188.98 75.59"');
  });

  it('is not made of what is no SVG (then the file goes in as a picture or is refused)', () => {
    expect(inlineSvgHtml('not really an svg', null, 'x')).toBeNull();
    expect(inlineSvgHtml('<html><body>hi</body></html>', null, 'x')).toBeNull();
    expect(inlineSvgHtml('<svg xmlns="http://www.w3.org/2000/svg">' + 'x'.repeat(500_000) + '</svg>', null, 'x')).toBeNull();
  });
});

describe('the reorder operation (Arrange ▸ order)', () => {
  const T = `<body>\n<section class="slide">\n  <div id="a"></div>\n  <div id="b"></div>\n  <!-- c -->\n  <div id="c"></div>\n</section>\n</body>`;

  it('puts the children in the new order, the text between them in its place', () => {
    const out = applyOp(T, { t: 'reorder', parent: [1, 0], order: [1, 2, 0] });
    expect(out).toBe(`<body>\n<section class="slide">\n  <div id="b"></div>\n  <div id="c"></div>\n  <!-- c -->\n  <div id="a"></div>\n</section>\n</body>`);
  });

  it('changes nothing for the same order and refuses an order that does not fit the children', () => {
    expect(opSplices(parseSource(T), { t: 'reorder', parent: [1, 0], order: [0, 1, 2] })).toEqual([]);
    expect(() => applyOp(T, { t: 'reorder', parent: [1, 0], order: [0, 1] })).toThrow();
    expect(() => applyOp(T, { t: 'reorder', parent: [1, 0], order: [0, 0, 1] })).toThrow();
  });

  it("an SVG's camel-case attribute is replaced, not written a second time (the parser keys locations in lower case)", () => {
    const svg = '<body>\n<svg viewBox="0 0 10 10" preserveAspectRatio="none"><path d="M0 0"/></svg>\n</body>';
    const out = applyOp(svg, { t: 'attr', path: [1, 0], name: 'viewBox', value: '-1 -1 12 12' });
    expect(out).toBe('<body>\n<svg viewBox="-1 -1 12 12" preserveAspectRatio="none"><path d="M0 0"/></svg>\n</body>');
    expect(applyOp(svg, { t: 'attr', path: [1, 0], name: 'preserveAspectRatio', value: null })).toBe('<body>\n<svg viewBox="0 0 10 10"><path d="M0 0"/></svg>\n</body>');
  });

  it('is rebased like the other operations (by its parent)', () => {
    const newer = T.replace('<body>', '<body class="x">');
    expect(rebaseOp(T, newer, { t: 'reorder', parent: [1, 0], order: [2, 1, 0] })).toEqual({ t: 'reorder', parent: [1, 0], order: [2, 1, 0] });
  });
});
