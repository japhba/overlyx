// SyncTeX's searches in core (synctex.ts), for the builds of end-to-end encrypted projects in the
// browser: on a file pdfLaTeX wrote for fixtures/synctex/main.tex, the answers of the `synctex` program.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { synctexView, synctexEdit } from '../packages/core/src/synctex.ts';

const TEXT = readFileSync(join(import.meta.dirname, 'fixtures/synctex/main.synctex'), 'utf8');
const near = (a: number, b: number) => Math.abs(a - b) < 0.05;

describe('synctexView', () => {
  it('finds the lines of the PDF a source line went into, as `synctex view` does', () => {
    // synctex view -i 4:0:main.tex: the paragraph's first two lines
    const boxes = synctexView(TEXT, 'main.tex', 4);
    expect(boxes.map(b => b.page)).toEqual([1, 1]);
    expect(near(boxes[0].y, 156.585541) && near(boxes[0].v, 158.52272) && near(boxes[0].h, 133.768356)).toBe(true);
    expect(near(boxes[0].W, 343.71106) && near(boxes[0].H, 8.855677)).toBe(true);
    expect(near(boxes[1].y, 168.54071)).toBe(true);
  });

  it('takes the next line with material for a comment line', () => {
    expect(synctexView(TEXT, 'main.tex', 9)[0]?.y).toBeCloseTo(222.338974, 1);
  });

  it('knows no other file', () => {
    expect(synctexView(TEXT, 'other.tex', 4)).toEqual([]);
  });
});

describe('synctexEdit', () => {
  it('finds the source line under a point, as `synctex edit` does', () => {
    expect(synctexEdit(TEXT, 1, 150, 140)).toEqual({ file: 'main.tex', line: 3, column: -1 });
    expect(synctexEdit(TEXT, 1, 300, 170)?.line).toBe(5);
    expect(synctexEdit(TEXT, 1, 140, 300)?.line).toBe(13);
  });

  it('has nothing on a page that is not there', () => {
    expect(synctexEdit(TEXT, 7, 100, 100)).toBeNull();
  });
});
