/**
 * Growing / shrinking the delimiter pair around the cursor (MathCursor.delimResize, the ( )↑ / ( )↓
 * toolbar buttons): plain → \big → \Big → \bigg → \Bigg → \left…\right and back; the cursor keeps
 * its place in the content.
 */
import { describe, it, expect } from 'vitest';
import { parseFormula, writeFormula } from '../packages/core/src/math';
import { MathCursor, enclosingDelims } from '../packages/core/src/math/cursor.ts';
import { parseCell } from '../packages/core/src/math/parse.ts';

/** a cursor in the first cell of `$…$` at position `pos` */
function cursorIn(latex: string, pos: number) {
  const h = parseFormula(latex);
  const c = new MathCursor(h);
  c.pos = pos;
  return { h, c };
}
const tex = (h: ReturnType<typeof parseFormula>) => writeFormula(h);

describe('enclosingDelims', () => {
  it('finds the innermost pair around the position, and the pair just closed before it', () => {
    const cell = parseCell('a(b[c]d)e');
    expect(enclosingDelims(cell, 3)).toMatchObject({ open: 1, close: 7, size: '' });      // between b and [
    expect(enclosingDelims(cell, 5)).toMatchObject({ open: 3, close: 5, size: '' });      // inside [c]
    expect(enclosingDelims(cell, 8)).toMatchObject({ open: 1, close: 7 });                // right after )
    expect(enclosingDelims(cell, 0)).toBeNull();
    expect(enclosingDelims(cell, 9)).toBeNull();
  });
});

describe('delimResize', () => {
  it('grows plain parentheses step by step up to \\left…\\right, keeping the cursor inside', () => {
    const { h, c } = cursorIn('$a(b+c)d$', 3);   // after b
    expect(c.delimResize(1)).toBe(true);
    expect(tex(h)).toBe('$a\\bigl(b+c\\bigr)d$');
    expect(c.pos).toBe(3);
    c.delimResize(1); c.delimResize(1); c.delimResize(1);
    expect(tex(h)).toBe('$a\\Biggl(b+c\\Biggr)d$');
    expect(c.delimResize(1)).toBe(true);
    expect(tex(h)).toBe('$a\\left(b+c\\right)d$');
    expect(c.depth).toBe(2);   // now inside the \left…\right inset
    expect(c.pos).toBe(1);     // still after b
    expect(c.delimResize(1)).toBe(false);   // nothing bigger
  });
  it('shrinks \\left…\\right to \\Bigg and on down to plain', () => {
    const { h, c } = cursorIn('$\\left[x\\right]$', 0);
    c.push(h.rows[0].cells[0][0] as any); c.pos = 1;   // cursor after x, inside the inset
    expect(c.delimResize(-1)).toBe(true);
    expect(tex(h)).toBe('$\\Biggl[x\\Biggr]$');
    expect(c.depth).toBe(1); expect(c.pos).toBe(2);
    c.delimResize(-1); c.delimResize(-1); c.delimResize(-1);
    expect(tex(h)).toBe('$\\bigl[x\\bigr]$');
    expect(c.delimResize(-1)).toBe(true);
    expect(tex(h)).toBe('$[x]$');
    expect(c.delimResize(-1)).toBe(false);
  });
  it('handles \\{ \\}, \\langle \\rangle and | |', () => {
    const a = cursorIn('$\\{x\\}$', 1); a.c.delimResize(1); expect(tex(a.h)).toBe('$\\bigl\\{ x\\bigr\\}$');
    const b = cursorIn('$\\langle x\\rangle $', 1); b.c.delimResize(1); expect(tex(b.h)).toBe('$\\bigl\\langle x\\bigr\\rangle$');
    const d = cursorIn('$|x|$', 1); d.c.delimResize(1); expect(tex(d.h)).toBe('$\\bigl|x\\bigr|$');
  });
  it('does nothing without a pair around the cursor, or with an invisible \\left. side', () => {
    const { h, c } = cursorIn('$a+b$', 1);
    expect(c.delimResize(1)).toBe(false);
    expect(tex(h)).toBe('$a+b$');
    const e = cursorIn('$\\left.x\\right|$', 0); e.c.push(e.h.rows[0].cells[0][0] as any); e.c.pos = 1;
    expect(e.c.delimResize(-1)).toBe(false);
  });
});
