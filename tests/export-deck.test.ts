/** Pictures, handouts and notes pages of a deck: the sizes the server renders, the handout's pages. */
import { describe, it, expect } from 'vitest';
import { maxPictureScale, pictureScale, pictureSize, pageMm, dpiScale, PICTURE_MAX_PIXELS, PICTURE_MAX_TOTAL, handoutPerPage, handoutPaper } from '../packages/core/src/html/exportsize.ts';
import { handoutHtml, handoutGrid } from '../packages/core/src/html/handout.ts';

describe('picture sizes', () => {
  const slide = { width: 1280, height: 720 };
  const a0 = { width: 3179, height: 4494 };

  it('a slide exports at 4K, an A0 poster at 150 dpi but not at 300', () => {
    expect(pictureScale(3, slide)).toBe(3);
    expect(pictureSize(slide, 3)).toEqual({ width: 3840, height: 2160 });
    expect(pictureScale(dpiScale(150), a0)).toBeCloseTo(150 / 96);
    expect(pictureScale(dpiScale(300), a0)).toBeLessThan(300 / 96);
    const most = pictureSize(a0, maxPictureScale(a0));
    expect(most.width * most.height).toBeLessThanOrEqual(PICTURE_MAX_PIXELS * 1.001);
    expect(pageMm(a0)).toEqual({ width: 841, height: 1189 });
  });

  it('many slides together stay within the total', () => {
    const s = maxPictureScale(slide, 200);
    expect(s).toBeLessThan(2);
    expect(1280 * 720 * s * s * 200).toBeLessThanOrEqual(PICTURE_MAX_TOTAL * 1.001);
    expect(maxPictureScale(slide, 12)).toBeGreaterThanOrEqual(4);
  });

  it('nonsense asks for the size on screen', () => {
    expect(pictureScale(NaN, slide)).toBe(1);
    expect(pictureScale(-2, slide)).toBe(1);
    expect(handoutPerPage('5')).toBe(3);
    expect(handoutPerPage('6')).toBe(6);
    expect(handoutPaper('letter')).toBe('letter');
    expect(handoutPaper('legal')).toBe('a4');
  });
});

describe('handouts', () => {
  const slides = Array.from({ length: 7 }, (_, i) => ({ src: `http://x/${i}.jpg`, number: i + 1, title: `Slide <${i + 1}>`, notes: i === 1 ? 'Say "hello" & wave\nthen go on' : '' }));
  const base = { title: 'A <talk>', paper: 'a4' as const, aspect: 16 / 9, slides };

  it('sets the slides out as PowerPoint does', () => {
    expect(handoutGrid(1)).toEqual({ cols: 1, rows: 1, lines: false });
    expect(handoutGrid(3)).toEqual({ cols: 1, rows: 3, lines: true });
    expect(handoutGrid(4)).toEqual({ cols: 2, rows: 2, lines: false });
    expect(handoutGrid(6)).toEqual({ cols: 2, rows: 3, lines: false });
  });

  it('7 slides, 3 a page: three pages, lines beside every slide, numbers as in the deck', () => {
    const html = handoutHtml({ ...base, layout: 'handout', per: 3 });
    expect(html.match(/<section class="page">/g)).toHaveLength(3);
    expect(html.match(/<div class="lines">/g)).toHaveLength(7);
    expect(html.match(/<img /g)).toHaveLength(7);
    expect(html).toContain('<div class="n">7</div>');
    expect(html).toContain('3 / 3');
    expect(html).toContain('A &lt;talk&gt;');
    expect(html).not.toContain('<talk>');
    expect(html).toContain('size: 210mm 297mm');
  });

  it('6 a page on Letter: two pages, no lines', () => {
    const html = handoutHtml({ ...base, layout: 'handout', per: 6, paper: 'letter' });
    expect(html.match(/<section class="page">/g)).toHaveLength(2);
    expect(html).not.toContain('class="lines"');
    expect(html).toContain('size: 215.9mm 279.4mm');
  });

  it('notes pages: a page a slide, the notes as text under it', () => {
    const html = handoutHtml({ ...base, layout: 'notes', per: 3 });
    expect(html.match(/<section class="np">/g)).toHaveLength(7);
    expect(html).toContain('<div class="notes">Say &quot;hello&quot; &amp; wave\nthen go on</div>');
    expect(html).toContain('Slide 2');
  });

  it('a slide fits its cell whatever its shape', () => {
    for (const aspect of [16 / 9, 4 / 3, 210 / 297]) for (const per of [1, 2, 3, 4, 6] as const) {
      const html = handoutHtml({ ...base, aspect, layout: 'handout', per });
      const m = /\.cell img \{ display: block; width: ([\d.]+)mm; height: ([\d.]+)mm/.exec(html)!;
      const g = handoutGrid(per);
      expect(Number(m[1])).toBeLessThanOrEqual(182.01 / (g.lines ? 2 : g.cols));
      expect(Number(m[2]) * g.rows).toBeLessThanOrEqual(260);
      expect(Number(m[1]) / Number(m[2])).toBeCloseTo(aspect, 1);
    }
  });
});
