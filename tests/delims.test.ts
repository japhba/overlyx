import { describe, it, expect } from 'vitest';
import { parseFormula, writeFormula, parseCell, writeCellLatex, MathCursor, renderHullSource, LLANGLE_PREAMBLE, definesLlangle, llanglePreamble, hasLlangleSnippet } from '@overlyx/core';

const rt = (s: string) => writeFormula(parseFormula(s));

describe('double angle brackets (\\llangle … \\rrangle)', () => {
  it('round-trips as \\left … \\right delimiters', () => {
    const src = '$\\left\\llangle x\\right\\rrangle $';
    const h = parseFormula(src);
    const atom = h.rows[0].cells[0][0] as any;
    expect(atom.t).toBe('delim');
    expect(atom.l).toBe('llangle');
    expect(atom.r).toBe('rrangle');
    expect(rt(src)).toBe(src);
  });
  it('is a big-inset delimiter (\\bigl\\llangle) like in LyX for its list', () => {
    const src = '$\\bigl\\llangle x\\bigr\\rrangle$';
    const cell = parseCell(src.slice(1, -1), {});
    expect(cell[0]).toMatchObject({ t: 'big', n: 'bigl', d: '\\llangle' });
    expect(cell[2]).toMatchObject({ t: 'big', n: 'bigr', d: '\\rrangle' });
    expect(rt(src)).toBe(src);
  });
  it('renders for KaTeX as two kerned angle glyphs of the same size', () => {
    const { latex } = renderHullSource(parseFormula('$\\left\\llangle x\\right\\rrangle +\\bigl\\llangle y\\bigr\\rrangle $'), {});
    expect(latex).toContain('\\left\\langle\\!\\langle');
    expect(latex).toContain('\\bigl\\langle\\mkern-4.5mu\\bigl\\langle');
    expect(latex).toContain('\\bigr\\rangle\\mkern-4.5mu\\bigr\\rangle');
  });
  it('preamble snippet detection', () => {
    expect(hasLlangleSnippet(LLANGLE_PREAMBLE)).toBe(true);
    expect(definesLlangle('\\usepackage{amsmath}')).toBe(false);
    expect(definesLlangle('\\newcommand{\\llangle}[1][]{x}')).toBe(true);
    expect(definesLlangle('', ['llangle'])).toBe(true);
    expect(definesLlangle('\\usepackage{MnSymbol}')).toBe(true);
    expect(llanglePreamble(true)).not.toContain('\\providecommand{\\llangle}');
    expect(llanglePreamble(false)).toContain('\\providecommand{\\llangle}');
    expect(llanglePreamble(false)).toContain('\\protected\\def\\left');
  });
});

describe('sized delimiters from the toolbar', () => {
  const cursorIn = (latex: string) => { const h = parseFormula('$' + latex + '$'); const c = new MathCursor(h, {}); c.idx = 0; c.pos = c.lastpos; return { h, c }; };
  it('\\left … \\right via handleNest wraps a selection', () => {
    const { h, c } = cursorIn('a+b');
    c.selectAll();
    c.handleNest({ t: 'delim', l: 'llangle', r: 'rrangle', body: [] });
    expect(writeFormula(h)).toBe('$\\left\\llangle a+b\\right\\rrangle $');
  });
  it('typing \\bigl then a named delimiter gives a big inset for \\llangle', () => {
    const { h, c } = cursorIn('');
    for (const ch of '\\bigl') c.interpretChar(ch);
    for (const ch of '\\llangle') c.interpretChar(ch);
    c.interpretChar(' ');
    expect(writeFormula(h).replace(/\s+/g, ' ')).toContain('\\bigl\\llangle');
  });
  it('writes plain, big and auto forms as LyX does', () => {
    expect(rt('$\\llangle x\\rrangle$')).toBe('$\\llangle x\\rrangle$');
    expect(rt('$\\Biggl\\{x\\Biggr\\}$')).toBe('$\\Biggl\\{ x\\Biggr\\}$');   // LyX: pending space after a named big delimiter
    expect(rt('$\\left|x\\right|$')).toBe('$\\left|x\\right|$');
    expect(rt('$\\left\\Vert x\\right\\Vert $')).toBe('$\\left\\Vert x\\right\\Vert $');
  });
});
