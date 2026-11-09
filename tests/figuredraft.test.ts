/** A figure's draft beside its final file (core/figuredraft.ts): the names that pair them. */
import { describe, it, expect } from 'vitest';
import { isFigureDraft, figureBase, draftOfFigure, finalCandidates, finalOf, switchFigureName, blankDraftSvg } from '../packages/core/src/figuredraft.ts';

describe('figure drafts', () => {
  it('pairs a final figure with its draft by name', () => {
    expect(draftOfFigure('figures/plot.pdf')).toBe('figures/plot.olx.svg');
    expect(draftOfFigure('figures/plot')).toBe('figures/plot.olx.svg');
    expect(draftOfFigure('figures/plot.olx.svg')).toBe('figures/plot.olx.svg');
    expect(draftOfFigure('images/a.png?v=3')).toBe('images/a.olx.svg?v=3');
    // a dot in a folder's name is no ending
    expect(draftOfFigure('v1.2/plot')).toBe('v1.2/plot.olx.svg');
    expect(figureBase('figures/plot.OLX.SVG')).toBe('figures/plot');
    expect(isFigureDraft('figures/plot.svg')).toBe(false);
    expect(isFigureDraft('figures/plot.olx.svg#x')).toBe(true);
  });

  it('finds the final among the project files, PDF first', () => {
    const files = new Set(['figures/plot.png', 'figures/plot.pdf', 'figures/plot.olx.svg']);
    expect(finalCandidates('figures/plot.olx.svg')[0]).toBe('figures/plot.pdf');
    expect(finalOf('figures/plot.olx.svg', files)).toBe('figures/plot.pdf');
    expect(finalOf('figures/other.olx.svg', files)).toBeNull();
    // the draft itself is never its own final
    expect(finalOf('figures/x.olx.svg', new Set(['figures/x.olx.svg']))).toBeNull();
  });

  it('switches the name a document writes, keeping how it is written', () => {
    expect(switchFigureName('../figures/plot.pdf', 'figures/plot.olx.svg')).toBe('../figures/plot.olx.svg');
    expect(switchFigureName('../figures/plot.olx.svg', 'figures/plot.png')).toBe('../figures/plot.png');
    // \includegraphics{plot}: graphicx finds the ending, the draft needs its own
    expect(switchFigureName('plot', 'figures/plot.olx.svg')).toBe('plot.olx.svg');
    expect(switchFigureName('plot.olx.svg', 'figures/plot.pdf')).toBe('plot.pdf');
    expect(switchFigureName('images/a.olx.svg?v=2', 'deck/images/a.jpg')).toBe('images/a.jpg?v=2');
  });

  it('makes an empty canvas of the final figure’s shape', () => {
    expect(blankDraftSvg()).toContain('viewBox="0 0 640 360"');
    expect(blankDraftSvg(640, 480.4)).toContain('height="480"');
  });
});
