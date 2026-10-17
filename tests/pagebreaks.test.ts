/**
 * The Pages view's page breaks: where a build's pages begin, read from SyncTeX and the PDF's words
 * (core pagebreaks.ts), and where that is in the document (client editor/plugins/pages.ts).
 */
import { describe, it, expect } from 'vitest';
import { pageBreaks, parsePdfWords, schema, type PdfPageWords } from '../packages/core/src/index.ts';
import { matchWords, placeBreaks } from '../packages/client/src/editor/plugins/pages.ts';

const SP = 65536, BP = 72 / 72.27;
/** a line of body text from source line `src`, baseline at `v` pt */
const line = (src: number, v: number) => `(1,${src}:8799518,${Math.round(v * SP)}:22609920,455111,127431\nx1,${src}:9000000,${Math.round(v * SP)}\ng1,${src}:9500000,${Math.round(v * SP)}\nx1,${src}:10000000,${Math.round(v * SP)}\n)`;
/** a page as LaTeX ships it: the head, the 550pt text block, the foot (its page number set while line `fired` was read) */
const page = (n: number, body: string[], fired: number) => [
  `{${n}`, '[1,10:4736286,46220574:26673152,41484288,0', '[1,10:8799518,46220574:22609920,40435712,0',
  '[1,10:8799518,6571294:22609920,786432,0', '(1,10:8799518,6571294:22609920,0,0', 'h1,10:8799518,6571294:22609920,0,0', ')', ']',
  '[1,10:8799518,44254494:22609920,36044800,0', ...body, ']',
  `(1,${fired}:8799518,46220574:22609920,422343,0`, `x1,${fired}:15000000,46220574`, ')', ']', ']', `}${n}`,
].join('\n');
const SYNCTEX = [
  'SyncTeX Version:1', 'Input:1:/build/./doc.tex', 'Input:2:/usr/share/texlive/article.cls', 'Output:pdf', 'Magnification:1000', 'Unit:1', 'X Offset:0', 'Y Offset:0', 'Content:',
  // page 1: paragraph 5, then paragraph 7 begins (its figure, line 6, is deferred to page 2)
  page(1, [line(5, 140), line(5, 152), line(5, 164), line(7, 176), line(7, 188)], 7),
  // page 2: the figure on top, then the rest of paragraph 7, then paragraph 9
  page(2, ['[1,6:8799518,240000000:22609920,6000000,0', line(6, 130), ']', line(7, 230), line(7, 242), line(9, 254), line(9, 266)], 9),
  page(3, [line(11, 140), line(11, 152)], 11),
].join('\n');

const word = (text: string, x: number, v: number) => ({ x0: x * BP, x1: (x + 20) * BP, y0: (v - 7) * BP, y1: (v + 2) * BP, text });
const WORDS: PdfPageWords[] = [
  { w: 612, h: 792, words: [word('1', 300, 705)] },
  { w: 612, h: 792, words: [word('Figure', 200, 130), word('work', 140, 230), word('model', 170, 230), word('fits', 200, 230), word('2', 300, 705)] },
  { w: 612, h: 792, words: [word('3', 300, 705)] },
];

describe('where the pages of a build begin (SyncTeX)', () => {
  it('finds each page\'s first paragraph, past a deferred figure, without the running head and foot', () => {
    const r = pageBreaks(SYNCTEX, 'doc.tex', 3, WORDS);
    expect(r.pages).toBe(3);
    expect(r.starts.map(s => [s.page, s.line, s.before, s.total])).toEqual([[2, 7, 2, 4], [3, 11, 0, 2]]);
    expect(r.starts[0].words).toEqual(['work', 'model', 'fits']);
    expect(r.frames[0]).toMatchObject({ page: 1, width: 345, height: 550, footer: '1' });
    expect(r.frames[0].top).toBeCloseTo(125.27, 1);
    expect(r.frames[0].paperW).toBeCloseTo(614.3, 0);
    expect(r.lead).toBe(12);
    expect(r.lineWidth).toBe(345);
  });

  it('reads pdftotext -bbox', () => {
    const w = parsePdfWords('<doc><page width="612.000000" height="792.000000"><word xMin="1" yMin="2" xMax="3" yMax="4">a&amp;b</word></page><page width="595" height="842"></page></doc>');
    expect(w).toEqual([{ w: 612, h: 792, words: [{ x0: 1, y0: 2, x1: 3, y1: 4, text: 'a&b' }] }, { w: 595, h: 842, words: [] }]);
  });
});

describe('where that is in the document', () => {
  it('matches a PDF line\'s words: a hyphenated word\'s second half, a section number, the nearest of repeats', () => {
    expect(matchWords('the network model fits well', ['work', 'model', 'fits'], 0)).toBe(4);
    expect(matchWords('Working together', ['5', 'Working', 'together'], 0)).toBe(0);
    expect(matchWords('a bb cc x a bb cc', ['a', 'bb', 'cc'], 12)).toBe(10);
    expect(matchWords('nothing alike here', ['other', 'words', 'entirely'], 0)).toBe(null);
  });

  it('places a break before a paragraph, or inside one at the page\'s first word', () => {
    const par = (t: string) => schema.nodes.paragraph.create({ layout: 'Standard' }, schema.text(t));
    const doc = schema.nodes.doc.create(null, [par('First paragraph of the text.'), par('Second paragraph begins page two.'), par('Third one runs on and the network model fits on page three.')]);
    const tex = ['\\begin{document}', 'First paragraph of the text.', 'Second paragraph begins page two.', 'Third one runs on and the network model fits on page three.', '\\end{document}'].join('\n');
    const marks = placeBreaks(doc, tex, { pages: 3, frames: [], lead: null, lineWidth: null, starts: [
      { page: 2, line: 3, before: 0, total: 1 },
      { page: 3, line: 4, before: 1, total: 2, words: ['work', 'model', 'fits'] },
    ] });
    const second = doc.child(0).nodeSize, third = second + doc.child(1).nodeSize;
    expect(marks[0]).toEqual({ pos: second, page: 2, inline: false });
    expect(marks[1]).toEqual({ pos: third + 1 + 'Third one runs on and the '.length, page: 3, inline: true });
  });
});
