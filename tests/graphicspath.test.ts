import { describe, it, expect } from 'vitest';
import { graphicsSearchDirs } from '../packages/core/src/tex/graphicspath.ts';

describe('graphicsSearchDirs', () => {
  it('reads the folders of \\graphicspath, project-relative from the document\'s folder', () => {
    expect(graphicsSearchDirs('\\usepackage{graphicx}\n\\graphicspath{{figures/}{tex/figures/}}', '.')).toEqual(['figures/', 'tex/figures/']);
    expect(graphicsSearchDirs('\\graphicspath{{../}{../figures/}}', 'notes/poster')).toEqual(['notes/', 'notes/figures/']);
    expect(graphicsSearchDirs('\\graphicspath{ {./img} {"my figs/"} }', 'paper')).toEqual(['paper/img/', 'paper/my figs/']);
  });

  it('keeps the project root, drops what leaves the project or is absolute, and the last \\graphicspath counts', () => {
    expect(graphicsSearchDirs('\\graphicspath{{../}}', 'tex')).toEqual(['']);
    expect(graphicsSearchDirs('\\graphicspath{{../../x/}{/abs/}{~/figs/}{figures/}}', 'tex')).toEqual(['tex/figures/']);
    expect(graphicsSearchDirs('\\graphicspath{{old/}}\n% \\graphicspath{{commented/}}\n\\graphicspath{{new/}}', '')).toEqual(['new/']);
    expect(graphicsSearchDirs('\\usepackage{graphicx}', '')).toEqual([]);
  });

  it('can retain relative folders above a local project, while still excluding absolute folders', () => {
    const local = { allowOutsideProject: true };
    expect(graphicsSearchDirs('\\graphicspath{{../figures/}{../../shared/}{../figures/}}', '.', local)).toEqual(['../figures/', '../../shared/']);
    expect(graphicsSearchDirs('\\graphicspath{{../../../shared/}{../../figures/}{../}}', 'notes/parts', local)).toEqual(['../shared/', 'figures/', 'notes/']);
    expect(graphicsSearchDirs('\\graphicspath{{../figures/}{/abs/}{C:/figures/}{~/figures/}}', '', local)).toEqual(['../figures/']);
  });
});
