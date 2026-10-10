// @vitest-environment happy-dom
/**
 * The deck canvas's new objects and edits as text (deliverable/sourceops.ts, core html/source.ts):
 * the shapes the toolbar draws, a line keeping the direction it was drawn in, the pen's stroke, an
 * SVG file made a safe inline drawing (inlineSvgHtml), and the `reorder` operation behind
 * Arrange ▸ order (the text between the elements stays put, nothing else of the file changes).
 */
import { describe, it, expect } from 'vitest';
import { objectHtml, inlineSvgHtml, penPathD } from '../packages/client/src/deliverable/sourceops.ts';
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
