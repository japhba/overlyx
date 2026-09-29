/**
 * The check of layout text boxes against the PDF (core layout/check.ts): what the layout macros
 * write to <job>.olx, parsed and paired with the boxes of the document as built and as it is now.
 */
import { describe, it, expect } from 'vitest';
import { parseOlx, olboxBlocks, layoutCheck, boxKey, texLengthPt } from '../packages/core/src/layout/check.ts';

const OLX = `olx params above=11.0pt ashort=0.0pt below=11.0pt bshort=6.5pt leftmargin=21.90005pt labelsep=5.475pt itemsep=3.0pt
olx box 1 1 x=30mm y=26mm w=610mm h=70mm natural=169.96747pt inner=199.16928pt baselineskip=99.44043pt
olx box 1 1 x=30mm y=104mm w=100mm h=18mm natural=33.98528pt inner=51.21495pt baselineskip=49.60022pt
olx box 1 1 x=30mm y=104mm w=100mm h=18mm natural=60pt inner=51.21495pt baselineskip=49.60022pt
olx box 1 2 x=30mm y=26mm w=610mm h=70mm natural=169.96747pt inner=199.16928pt baselineskip=99.44043pt
olx box 2 1 x=10mm y=10mm w=50mm h=20mm natural=20pt inner=56.9pt baselineskip=14pt`;

const tex = (a: string, b: string, c: string) => String.raw`\documentclass{beamer}
\begin{document}
\begin{frame}[plain]
\begin{olbox}{x=30mm,y=26mm,w=610mm,h=70mm,font=88pt}
${a}
\end{olbox}
% \begin{olbox}{x=1mm,y=1mm,w=1mm,h=1mm} a comment \end{olbox}
\begin{olbox}{x=30mm,y=104mm,w=100mm,h=18mm,name={A, b}}
${b}
\end{olbox}
\begin{olbox}{x=30mm,y=104mm,w=100mm,h=18mm}
Twin
\end{olbox}
\end{frame}
\begin{frame}[plain]
\begin{olbox}{x=10mm,y=10mm,w=50mm,h=20mm}
${c}
\end{olbox}
\end{frame}
\end{document}
`;

describe('layout check', () => {
  it('reads TeX lengths and the records (the class spacing once, a box per slide)', () => {
    expect(texLengthPt('30mm')).toBeCloseTo(85.358, 2);
    expect(texLengthPt('12pt')).toBe(12);
    expect(Number.isNaN(texLengthPt('wide'))).toBe(true);
    const { params, boxes } = parseOlx(OLX);
    expect(params).toEqual({ above: 11, ashort: 0, below: 11, bshort: 6.5, leftmargin: 21.90005, labelsep: 5.475, itemsep: 3 });
    expect(boxes).toHaveLength(5);
    expect(boxes[0]).toMatchObject({ frame: 1, slide: 1, x: 30, y: 26, w: 610, h: 70 });
    expect(boxes[0].natural).toBeCloseTo(169.967, 3);
  });

  it("finds each frame's boxes by geometry (the n-th of equal ones), comments left out", () => {
    const f = olboxBlocks(tex('Title', 'Body', 'Other'));
    expect(f.map(fr => fr.map(b => b.key))).toEqual([
      [`${boxKey(30, 26, 610, 70)}#0`, `${boxKey(30, 104, 100, 18)}#0`, `${boxKey(30, 104, 100, 18)}#1`],
      [`${boxKey(10, 10, 50, 20)}#0`],
    ]);
  });

  it('pairs records with boxes: one per box (the first slide), fresh while its source is unchanged', () => {
    const built = tex('Title', 'Body', 'Other');
    const c = layoutCheck(OLX, built, tex('Title', 'Body edited', 'Other'));
    expect(c.boxes.map(b => [b.page, b.key, b.fresh])).toEqual([
      [0, `${boxKey(30, 26, 610, 70)}#0`, true],
      [0, `${boxKey(30, 104, 100, 18)}#0`, false],   // edited since the build
      [0, `${boxKey(30, 104, 100, 18)}#1`, true],    // its twin: the second record of that geometry on the slide
      [1, `${boxKey(10, 10, 50, 20)}#0`, true],
    ]);
    expect(c.boxes[2].natural).toBe(60);
    // a box moved since the build is not found at all
    const moved = layoutCheck(OLX, built, built.replace('x=10mm,y=10mm', 'x=12mm,y=10mm'));
    expect(moved.boxes.find(b => b.page === 1)?.fresh).toBe(false);
    // no build output: nothing
    expect(layoutCheck('', built, built)).toEqual({ params: null, boxes: [] });
  });
});
