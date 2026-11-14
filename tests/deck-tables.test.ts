// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { tableHtml, tablePlace, tsvTable, clipTable } from '../packages/client/src/deliverable/tablemodel';

describe('tables on slides and posters (tablemodel.ts)', () => {
  it('writes a plain, readable table: a header row, one row per line, its place on the slide', () => {
    const html = tableHtml(3, 2, { x: 160, y: 240.04, w: 960 });
    expect(html).toBe([
      '<table class="ol-table" style="position: absolute; left: 160px; top: 240px; width: 960px">',
      '  <tr><th></th><th></th></tr>',
      '  <tr><td></td><td></td></tr>',
      '  <tr><td></td><td></td></tr>',
      '</table>',
    ].join('\n'));
  });

  it('escapes what goes in the cells and keeps their line breaks', () => {
    const html = tableHtml(1, 2, null, [['a < b & c', 'one\ntwo']], false);
    expect(html).toContain('<td>a &lt; b &amp; c</td><td>one<br>two</td>');
    expect(html).not.toContain('style=');
  });

  it('puts a new table in the middle of the slide, wider with more columns', () => {
    const narrow = tablePlace(2, 3, 1280, 720, 32), wide = tablePlace(6, 3, 1280, 720, 32);
    expect(wide.w).toBeGreaterThan(narrow.w);
    expect(narrow.x * 2 + narrow.w).toBeCloseTo(1280, 0);
    expect(wide.w).toBeLessThanOrEqual(1280 * 0.84 + 1);
  });

  it('reads cells copied from a spreadsheet (tab-separated lines), squared to the longest row', () => {
    expect(tsvTable('Method\tAccuracy\nOurs\t0.93\nBaseline\n')).toEqual([['Method', 'Accuracy'], ['Ours', '0.93'], ['Baseline', '']]);
    expect(tsvTable('just some text')).toBeNull();
    expect(tsvTable('one line\twith a tab')).toEqual([['one line', 'with a tab']]);
  });

  it('prefers the HTML table a spreadsheet puts on the clipboard', () => {
    const html = '<meta charset="utf-8"><table><tr><td>A</td><td>B</td></tr><tr><td> 1 </td><td>2</td></tr></table>';
    expect(clipTable(html, 'A\tB\n1\t2')).toEqual([['A', 'B'], ['1', '2']]);
    expect(clipTable('<p>no table</p>', 'plain words')).toBeNull();
  });
});
