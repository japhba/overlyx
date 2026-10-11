/**
 * The touch math keyboard (client editor/mathkbd): its smart fraction (MathCursor.operandStart),
 * every key's LaTeX parses, the pen's ink layout and scratch-out gesture (the server's side of the
 * pen is in ai.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { parseFormula, writeFormula, parseCell, MathCursor } from '../packages/core/src/math';
import { PAGES, SIDE_KEYS, type KeyAction, type KeyDef } from '../packages/client/src/editor/mathkbd/keys';
import { inkLayout, scratchedOut, reversals, INK_LETTER, INK_PAD, INK_MAX_W, type Stroke } from '../packages/client/src/editor/mathkbd/ink';

/** a cursor at the end of a formula */
function at(latex: string) {
  const c = new MathCursor(parseFormula(latex, {}), {});
  c.idx = c.lastidx; c.pos = c.lastpos;
  return c;
}
/** the a/b key: the operand before the cursor becomes the numerator */
function frac(latex: string): string {
  const c = at(latex);
  c.selectOperand();
  c.niceInsertAtom(parseCell('\\frac{}{}', {}, 'math')[0]);
  c.interpretChar('9');
  return writeFormula(c.hull);
}

describe('the fraction key takes the operand before the cursor', () => {
  it('a number, a product, a script', () => {
    expect(frac('$2x$')).toBe('$\\frac{2x}{9}$');
    expect(frac('$a+bc$')).toBe('$a+\\frac{bc}{9}$');
    expect(frac('$y=x^{2}$')).toBe('$y=\\frac{x^{2}}{9}$');
  });
  it('a bracketed group whole, with what it is applied to', () => {
    expect(frac('$1+(a+b)$')).toBe('$1+\\frac{(a+b)}{9}$');
    expect(frac('$f(x)$')).toBe('$\\frac{f(x)}{9}$');
    expect(frac('$\\sin x$')).toBe('$\\sin\\frac{x}{9}$');
  });
  it('nothing before the cursor: an empty fraction, the cursor in its numerator', () => {
    expect(frac('$$')).toBe('$\\frac{9}{}$');
    expect(frac('$a=$')).toBe('$a=\\frac{9}{}$');
  });
  it('an unbalanced bracket stops it', () => {
    expect(frac('$a)$')).toBe('$a)\\frac{9}{}$');
  });
});

function actions(a: KeyAction): KeyAction[] { return 'seq' in a ? a.seq.flatMap(actions) : [a]; }
function allKeys(): KeyDef[] {
  const out: KeyDef[] = [];
  const add = (k: KeyDef) => { out.push(k); k.alt?.forEach(add); if (k.shifted) add(k.shifted); };
  for (const p of PAGES) p.rows.flat().forEach(add);
  SIDE_KEYS.flat().forEach(add);
  return out;
}

describe('the keys', () => {
  it('every LaTeX a key inserts parses into atoms (no unknown commands)', () => {
    for (const k of allKeys()) for (const a of actions(k.a)) {
      if (!('insert' in a)) continue;
      const cell = parseCell(a.insert.replace(/#0|#\?/g, ''), {}, 'math');
      expect(cell.length, `${k.name}: ${a.insert}`).toBeGreaterThan(0);
      // and writes back as LaTeX
      expect(writeFormula(parseFormula(`$${a.insert.replace(/#0|#\?/g, '')}$`, {})).length).toBeGreaterThan(2);
    }
  });
  it('every key has a name (screen readers, tooltips) and a label', () => {
    for (const k of allKeys()) {
      expect(k.name, JSON.stringify(k)).toBeTruthy();
      expect(k.label ?? k.tex, k.name).toBeTruthy();
    }
  });
  it('the root key (field command root) enters the index; a selection goes under the root', () => {
    // (as LyxMathField.execute('root') does it)
    const root = (c: MathCursor) => { const sel = c.grabAndEraseSelection(); c.insertAtom({ t: 'sqrt', body: sel ? parseCell(sel, {}, 'math') : [], index: [] }); c.editInsertedInset(); };
    const c = at('$$');
    root(c);
    c.interpretChar('3');
    expect(writeFormula(c.hull)).toBe('$\\sqrt[3]{}$');
    const d = at('$ab$');
    d.selectOperand();
    root(d);
    d.interpretChar('3');
    expect(writeFormula(d.hull)).toBe('$\\sqrt[3]{ab}$');
  });
});

const line = (x0: number, y0: number, x1: number, y1: number, n = 8): Stroke => ({ pts: Array.from({ length: n }, (_, i) => { const f = n > 1 ? i / (n - 1) : 0; return { x: x0 + (x1 - x0) * f, y: y0 + (y1 - y0) * f, t: i, p: 0.5 }; }) });

describe('the ink picture', () => {
  it('letters are scaled to the benchmark height; the margin is kept', () => {
    // two "letters" 100 px high and a dot: the median letter is 100 → 40 px
    const l = inkLayout([line(0, 0, 10, 100), line(30, 0, 40, 100), line(60, 50, 60, 50, 1)])!;
    expect(l.k).toBeCloseTo(INK_LETTER / 100, 5);
    expect(l.h).toBe(Math.round(100 * l.k + 2 * INK_PAD));
    expect(l.x0).toBeCloseTo(0 - INK_PAD / l.k, 5);
  });
  it('a long line of writing is scaled down to fit', () => {
    const strokes = Array.from({ length: 80 }, (_, i) => line(i * 50, 0, i * 50 + 20, 40));
    const l = inkLayout(strokes)!;
    expect(l.w).toBeLessThanOrEqual(INK_MAX_W);
  });
  it('no ink, no picture', () => { expect(inkLayout([])).toBeNull(); });
});

/** a zigzag across [x0, x1] at height y, `turns` times back */
function zigzag(x0: number, x1: number, y: number, turns: number): Stroke {
  const pts = [];
  for (let i = 0; i <= turns; i++) for (let j = 0; j < 6; j++) {
    const f = j / 6, x = i % 2 ? x1 - (x1 - x0) * f : x0 + (x1 - x0) * f;
    pts.push({ x, y: y + (i % 2 ? 4 : -4), t: i * 6 + j, p: 0.5 });
  }
  return { pts };
}

describe('scratching out', () => {
  const written = [line(0, 0, 10, 40), line(20, 0, 30, 40), line(200, 0, 210, 40)];
  it('a zigzag over strokes erases them (not the ones beside it)', () => {
    expect(reversals(zigzag(-5, 35, 20, 5), 6)).toBe(5);
    expect(scratchedOut(zigzag(-5, 35, 20, 5), written)).toEqual([0, 1]);
  });
  it('writing is not a zigzag: a W, an M, a sum sign', () => {
    const w: Stroke = { pts: [[0, 0], [10, 40], [20, 10], [30, 40], [40, 0]].map(([x, y], t) => ({ x, y, t, p: 0.5 })) };
    expect(scratchedOut(w, written)).toBeNull();
    const sigma: Stroke = { pts: [[40, 0], [0, 0], [20, 20], [0, 40], [40, 40]].map(([x, y], t) => ({ x, y, t, p: 0.5 })) };
    expect(scratchedOut(sigma, written)).toBeNull();
  });
  it('a straight stroke (a box of no width) is crossed out too', () => {
    expect(scratchedOut(zigzag(280, 320, 80, 5), [line(300, 40, 300, 110)])).toEqual([0]);
  });
  it('a zigzag over nothing erases nothing (it is ink)', () => {
    expect(scratchedOut(zigzag(400, 440, 20, 5), written)).toBeNull();
  });
});
