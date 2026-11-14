/**
 * Slides on the clipboard (packages/client/src/deliverable/slideclip.ts): what a copy carries, and
 * how a paste goes into the same deck and into another one — that deck's look where its stylesheet
 * knows the classes, the slides' own rules, custom properties and pictures brought along, what was
 * on every slide of the old deck replaced by what is on every slide of the new one.
 */
import { describe, it, expect } from 'vitest';
import { slidesClip, readSlidesClip, hasSlidesClip, pastePlan, pasteOps, relativeAssets, withAssets, joinPath, cssRules, PASTED_ATTR } from '../packages/client/src/deliverable/slideclip.ts';
import { followUps } from '../packages/client/src/deliverable/deckmaster.ts';
import { applySplices, opSplices, parseSource, type HtmlOp } from '../packages/core/src/html/source.ts';
import { reviewOps } from '../packages/core/src/html/review.ts';
import { slideElements } from '../packages/core/src/html/deliverable.ts';

const deck = (css: string, body: string) => `<!doctype html>\n<html>\n<head>\n<meta name="overlyx" content="deck">\n<style>\n${css}\n</style>\n</head>\n<body>\n${body}\n</body>\n</html>`;
const A = deck(`:root { --accent: #c00; --soft: color-mix(in srgb, var(--accent) 20%, white); }
.slide { width: 1280px; height: 720px; background: white; }
.slide h2 { color: var(--accent); }
.callout { border: 2px solid var(--soft); padding: 12px; }
@media print { .callout { border-color: black; } .slide { box-shadow: none; } }
.lead { font-size: 40px; }`,
`<section class="slide">
  <div data-ol-master="m1" class="bar" style="position: absolute; left: 0; top: 0; width: 1280px; height: 40px; background: var(--accent)"></div>
  <h2>One</h2>
  <p class="callout lead">Said <b>once</b></p>
  <img src="images/cat.png" alt="" style="position: absolute; left: 100px; top: 200px; width: 300px">
</section>

<section class="slide" style="background: url(../shared/paper.jpg)">
  <div data-ol-master="m1" class="bar" style="position: absolute; left: 0; top: 0; width: 1280px; height: 40px; background: var(--accent)"></div>
  <h2>Two</h2>
</section>`);
const B = deck(`:root { --ink: #124; }
.slide { width: 1280px; height: 720px; background: #f4f0e6; }
.slide h2 { color: var(--ink); }
.lead { font-size: 32px; font-style: italic; }`,
`<section class="slide">
  <p data-ol-master="m1" class="foot" style="position: absolute; left: 40px; top: 680px">A talk</p>
  <h2>First of B</h2>
</section>

<section class="slide">
  <p data-ol-master="m1" class="foot" style="position: absolute; left: 40px; top: 680px">A talk</p>
  <h2>Second of B</h2>
</section>`);
const apply = (text: string, ops: HtmlOp[], stamp: string | null = null) => {
  const src = parseSource(text);
  const after = applySplices(text, reviewOps(src, ops, stamp).flatMap(op => opSplices(src, op)));
  return applySplices(after, followUps(text, after).splices);
};
const titles = (text: string) => slideElements(parseSource(text).doc).length + ':' + [...text.matchAll(/<h2>(.*?)<\/h2>/g)].map(m => m[1]).join('|');

describe('copying slides', () => {
  const c = slidesClip(A, [1, 0], { deck: 'ada/talks/a/index.html', dir: 'a' })!;
  it('carries the slides in their order, their words as plain text, in a comment the clipboard keeps', () => {
    expect(hasSlidesClip(c.html)).toBe(true);
    expect(c.html).toMatch(/^<!--overlyx-slides [A-Za-z0-9+/=]+--><p>One Said once<\/p><p>Two<\/p>$/);
    expect(c.plain).toBe('One Said once\n\nTwo');
    const back = readSlidesClip('<meta charset="utf-8">' + c.html)!;
    expect(back.slides.length).toBe(2);
    expect(back.slides[0]).toContain('<h2>One</h2>');
    expect(back.deck).toBe('ada/talks/a/index.html');
    expect(readSlidesClip('<p>words</p>')).toBeNull();
  });
  it('with the rules for the classes they use and the custom properties behind them', () => {
    expect(c.clip.rules.some(r => r.startsWith('.callout'))).toBe(true);
    expect(c.clip.rules.some(r => r.startsWith('.lead'))).toBe(true);
    expect(c.clip.rules.some(r => /^@media print \{\s*\.callout/.test(r) && !r.includes('box-shadow'))).toBe(true);
    expect(c.clip.rules.some(r => r.startsWith('.slide h2'))).toBe(false);
    expect(c.clip.vars).toEqual({ '--accent': '#c00', '--soft': 'color-mix(in srgb, var(--accent) 20%, white)' });
  });
});

describe('pasting slides', () => {
  const c = slidesClip(A, [0, 1], { deck: 'ada/talks/a/index.html', dir: 'a' })!.clip;
  it('into the same deck: as they are, after the slide shown, linked objects still linked', () => {
    const plan = pastePlan(A, c, 'ada/talks/a/index.html', 0);
    expect(plan).toMatchObject({ foreign: false, style: null, assets: [] });
    const r = pasteOps(A, 0, plan.slides, plan.style)!;
    const out = apply(A, r.ops);
    expect(titles(out)).toBe('4:One|One|Two|Two');
    expect(r.sel).toEqual([1, 2]);
    expect(out.match(/data-ol-master="m1"/g)?.length).toBe(4);
  });
  it('into another deck: its look, what was the slides’ own brought along', () => {
    const plan = pastePlan(B, c, 'ada/talks/b/index.html', 1);
    expect(plan.foreign).toBe(true);
    // the receiving deck knows .lead (its rule wins) but not .callout; --accent and --soft are not its own
    expect(plan.style).toContain(`<style ${PASTED_ATTR}>`);
    expect(plan.style).toContain('.callout { border: 2px solid var(--soft); padding: 12px; }');
    expect(plan.style).toContain('@media print');
    expect(plan.style).not.toContain('.lead {');
    expect(plan.style).toContain('--accent: #c00;');
    expect(plan.style).toContain('--soft: color-mix(in srgb, var(--accent) 20%, white);');
    expect(plan.assets.sort()).toEqual(['../shared/paper.jpg', 'images/cat.png']);
    // the old deck's bar is replaced by this deck's footer, linked with the others
    expect(plan.slides.join('')).not.toContain('class="bar"');
    const slides = plan.slides.map(s => withAssets(s, { 'images/cat.png': 'images/cat-1.png', '../shared/paper.jpg': 'images/paper.jpg' }));
    const r = pasteOps(B, 1, slides, plan.style)!;
    const out = apply(B, r.ops);
    expect(titles(out)).toBe('4:First of B|Second of B|One|Two');
    expect(out.match(/class="foot"/g)?.length).toBe(4);
    expect(out).toContain('src="images/cat-1.png"');
    expect(out).toContain('url(images/paper.jpg)');
    expect(out.indexOf(PASTED_ATTR)).toBeLessThan(out.indexOf('</head>'));
    // a second paste brings no second copy of the rules
    const again = pastePlan(out, c, 'ada/talks/b/index.html', 3);
    expect(again.style).toBeNull();
  });
  it('into a deck with nothing on every slide: the old deck’s objects stay, the slide’s own', () => {
    const plain = B.replace(/\s*<p data-ol-master[^\n]*\n/g, '\n');
    const plan = pastePlan(plain, c, 'x', 0);
    expect(plan.slides[0]).toContain('class="bar"');
    expect(plan.slides.join('')).not.toContain('data-ol-master');
  });
  it('while suggesting: the pasted slides are suggested additions', () => {
    const plan = pastePlan(B, c, 'ada/talks/b/index.html', 0);
    const out = apply(B, pasteOps(B, 0, plan.slides, null)!.ops, 'Ada|2026-11-14T10:00:00Z');
    expect(out.match(/<section class="slide"[^>]*\sdata-ol-ins=/g)?.length).toBe(2);
  });
});

describe('helpers', () => {
  it('relative addresses only', () => expect(relativeAssets('<img src="a.png"><img src="https://x.org/b.png"><img src="/c.png"><img src="data:image/png;base64,AA"><svg><image href="d/e.svg"/></svg><div style="background: url(&quot;f g.jpg&quot;)">')).toEqual(['a.png', 'd/e.svg', 'f g.jpg']));
  it('joins a folder and a relative address inside the project', () => {
    expect(joinPath('talks/a', 'images/cat.png')).toBe('talks/a/images/cat.png');
    expect(joinPath('talks/a', '../shared/p%20q.jpg?v=2')).toBe('talks/shared/p q.jpg');
    expect(joinPath('a', '../../etc')).toBeNull();
  });
  it('reads rules past comments and strings', () => {
    expect(cssRules('/* a { */ .a::after { content: "}"; } @import url(x.css); .b{color:red}').map(r => r.prelude)).toEqual(['.a::after', '.b']);
  });
});
