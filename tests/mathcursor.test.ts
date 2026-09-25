/**
 * The LyX math cursor (port of Cursor.cpp / InsetMathNest): keystroke sequences must produce the
 * same LaTeX and cursor positions as LyX.
 */
import { describe, it, expect } from 'vitest';
import { parseFormula, writeFormula, MathCursor, completeCommand, isKnownCommand, atomCells, type MacroTable, type Slice } from '../packages/core/src/math';

const MACROS: MacroTable = { inv: { nargs: 1 }, Pfi: { nargs: 0 }, cum: { nargs: 2 } };

/** a cursor at the end of a formula */
function at(latex: string, macros = MACROS) {
  const h = parseFormula(latex, macros);
  const c = new MathCursor(h, macros);
  c.idx = c.lastidx; c.pos = c.lastpos;
  return c;
}
/** type a string LyX-style: characters go through interpretChar, "\n" is Enter (macro close) */
function type(c: MathCursor, s: string) {
  for (const ch of s) { if (ch === '\n') { c.macroModeClose(); continue; } c.interpretChar(ch); }
}
const out = (c: MathCursor) => writeFormula(c.hull);
const right = (c: MathCursor, n = 1) => { for (let i = 0; i < n; i++) c.mathForward(); };
const left = (c: MathCursor, n = 1) => { for (let i = 0; i < n; i++) { const old = c.clone(); c.mathBackward(); c.notifyLeave(old); } };

describe('typing', () => {
  it('characters, symbols via macro mode, spaces leave insets', () => {
    const c = at('$$');
    type(c, 'a+b');
    expect(out(c)).toBe('$a+b$');
    type(c, '\\alpha ');            // space closes the macro name
    expect(out(c)).toBe('$a+b\\alpha$');
    type(c, 'x');
    expect(out(c)).toBe('$a+b\\alpha x$');
  });
  it('^ and _ create scripts on the previous atom; Space leaves the script', () => {
    const c = at('$$');
    type(c, 'x^2');
    expect(out(c)).toBe('$x^{2}$');
    expect(c.depth).toBe(2);
    type(c, ' ');                    // leave the superscript
    expect(c.depth).toBe(1);
    type(c, '_i');
    expect(out(c)).toBe('$x^{2}_{i}$');   // merged into the same script inset, written 2.5-style
    expect(c.depth).toBe(2);
    type(c, ' +1');
    expect(out(c)).toBe('$x^{2}_{i}+1$');
  });
  it('\\frac enters the numerator; Tab-like cell forward moves to the denominator', () => {
    const c = at('$$');
    type(c, '\\frac ');
    expect(out(c)).toBe('$\\frac{}{}$');
    type(c, 'a');
    c.cellForward();
    type(c, 'b');
    expect(out(c)).toBe('$\\frac{a}{b}$');
    c.cellForward();                 // LyX: Tab in the last cell wraps around to the first one
    expect(c.depth).toBe(2); expect(c.idx).toBe(0);
    type(c, ' +c');                  // Space leaves the fraction
    expect(out(c)).toBe('$\\frac{a}{b}+c$');
  });
  it('\\sqrt, \\left( … and a user macro with an argument', () => {
    const c = at('$$');
    type(c, '\\sqrt x');
    expect(out(c)).toBe('$\\sqrt{x}$');
    type(c, ' +\\left(y');
    expect(out(c)).toBe('$\\sqrt{x}+\\left(y\\right)$');
    type(c, ' \\inv A');
    expect(out(c)).toBe('$\\sqrt{x}+\\left(y\\right)\\inv A$');
  });
  it('typing in a \\text cell inserts spaces and letters upright; ~ is \\sim in math', () => {
    const c = at('$$');
    type(c, '\\text if x');
    expect(out(c)).toBe('$\\text{if x}$');
    type(c, ' ');                    // after a non-space a space is inserted …
    expect(out(c)).toBe('$\\text{if x }$');
    type(c, ' ');                    // … but never two in a row
    expect(out(c)).toBe('$\\text{if x }$');
    c.cellForward();
    type(c, 'a~b');
    expect(out(c)).toBe('$\\text{if x }a\\sim b$');
  });
  it('the selection becomes the argument of the inserted inset', () => {
    const c = at('$a+b$');
    c.selHandle(true); left(c, 3); c.selHandle(true);
    expect(c.grabSelection()).toBe('a+b');
    c.handleNest({ t: 'sqrt', body: [] });
    expect(out(c)).toBe('$\\sqrt{a+b}$');
  });
});

describe('navigation', () => {
  it('right/left enter insets cell by cell like LyX', () => {
    const c = at('$\\frac{a}{b}x$');
    c.idx = 0; c.pos = 0;
    const trail: string[] = [];
    for (let i = 0; i < 8 && c.mathForward(); i++) trail.push(`${c.depth}:${c.idx}:${c.pos}`);
    // into the numerator, after a, then out of the fraction (LyX: Down reaches the denominator), after x
    expect(trail).toEqual(['2:0:0', '2:0:1', '1:0:1', '1:0:2']);
    expect(c.mathForward()).toBe(false);   // leaves the formula
  });
  it('up/down between scripts and fraction cells', () => {
    const c = at('$x^{2}_{i}$');
    left(c, 1);                          // into the subscript (last cell)
    expect(c.inset?.t).toBe('script');
    expect(c.upDown(true)).toBe(true);   // LyX: from the subscript, Up goes to the nucleus
    expect(c.idx).toBe(0);
    const f = at('$\\frac{a}{b}$');
    left(f, 1);
    expect(f.idx).toBe(1);
    expect(f.upDown(true)).toBe(true);
    expect(f.idx).toBe(0);
  });
  it('Home/End within a cell, then across cells', () => {
    const c = at('$abc$');
    expect(c.lineBegin()).toBe(true); expect(c.pos).toBe(0);
    expect(c.lineBegin()).toBe(false);
    expect(c.lineEnd()).toBe(true); expect(c.pos).toBe(3);
  });
});

describe('deletion', () => {
  it('Backspace at the inner left edge dissolves the inset (pullArg)', () => {
    const c = at('$\\left(x+y\\right)$');
    left(c, 4);
    expect(c.depth).toBe(2); expect(c.pos).toBe(0);
    c.backspace();
    expect(out(c)).toBe('$x+y$');
  });
  it('Delete at the inner right edge dissolves a one-cell inset; empty insets are removed', () => {
    const c = at('$\\sqrt{x}$');
    left(c, 1);
    expect(c.pos).toBe(1);
    c.erase();
    expect(out(c)).toBe('$x$');
    const e = at('$\\sqrt{}$');
    left(e, 1);
    e.backspace();
    expect(out(e)).toBe('$ $');
  });
  it('a big inset is selected before it is deleted (confirmDeletion)', () => {
    const c = at('$a\\frac{b}{c}$');
    c.backspace();
    expect(c.selection).toBe(true);
    expect(out(c)).toBe('$a\\frac{b}{c}$');
    c.backspace();
    expect(out(c)).toBe('$a$');
  });
  it('a macro argument: Backspace at its start replaces the macro by the argument', () => {
    const c = at('$\\inv{xy}$');
    left(c, 3);
    expect(c.inset?.t).toBe('macro'); expect(c.pos).toBe(0);
    c.backspace();
    expect(out(c)).toBe('$xy$');
  });
  it('empty scripts vanish when the cursor leaves them', () => {
    const c = at('$x$');
    type(c, '^');
    expect(out(c)).toBe('$x^{}$');
    const old = c.clone();
    c.popForward(); c.notifyLeave(old);
    expect(out(c)).toBe('$x$');
    expect(c.pos).toBe(1);
  });
  it('Backspace in macro mode shortens the name, then removes the backslash', () => {
    const c = at('$$');
    type(c, '\\alp');
    c.backspace(); c.backspace(); c.backspace();
    expect(c.inMacroMode()).toBe(true);
    c.backspace();
    expect(c.inMacroMode()).toBe(false);
    expect(out(c)).toBe('$ $');
  });
});

describe('rows, numbering, labels, mutation', () => {
  it('Enter in an inline formula turns it into align and splits at the relation', () => {
    const c = at('$a=b$');
    c.newline();
    expect(c.hull.type).toBe('align');
    expect(out(c)).toBe('\n\\begin{align*}\na & =b\\\\\n\\end{align*}\n');   // LyX: an unlabelled formula stays unnumbered; the empty row adds no line
    type(c, 'c=d');                    // the cursor stays in the relation column, as in LyX
    expect(out(c)).toBe('\n\\begin{align*}\na & =b\\\\\n & c=d\n\\end{align*}\n');
  });
  it('number toggle, per-line numbering and labels', () => {
    const c = at('\n\\begin{align}\na & =b\\\\\nc & =d\n\\end{align}\n');
    c.numberLineToggle();                 // cursor is in the last row
    expect(out(c)).toBe('\n\\begin{align}\na & =b\\\\\nc & =d\\nonumber \n\\end{align}\n');
    c.setLabel('eq:cd');
    expect(out(c)).toBe('\n\\begin{align}\na & =b\\\\\nc & =d\\label{eq:cd}\n\\end{align}\n');
    c.numberToggle();
    expect(out(c)).toBe('\n\\begin{align*}\na & =b\\\\\nc & =d\n\\end{align*}\n');
  });
  it('\\right| after \\left. closes the pair with the typed delimiter (evaluation bars)', () => {
    const c = at('x=');
    type(c, '\\left.\n');
    type(c, 'f');
    type(c, '\\right|\n');
    type(c, '_');
    type(c, 'a');
    c.posForward();
    expect(out(c)).toBe('x=\\left.f\\right|_{a}');
  });
  it('a label can be put on another row than the cursor\'s (the formula\'s label chip picks the numbered one)', () => {
    const c = at('\n\\begin{align}\na & =b\\nonumber \\\\\nc & =d\n\\end{align}\n');
    c.idx = 0; c.pos = 0;                 // cursor in the unnumbered first row
    c.setLabel('eq:cd', 1);
    expect(out(c)).toBe('\n\\begin{align}\na & =b\\nonumber \\\\\nc & =d\\label{eq:cd}\n\\end{align}\n');
    c.setLabel('eq:ab');                  // LyX math-label proper: the cursor\'s row, numbered by the label
    expect(out(c)).toBe('\n\\begin{align}\na & =b\\label{eq:ab}\\\\\nc & =d\\label{eq:cd}\n\\end{align}\n');
  });
  it('Delete at the end of a row removes the label first, then the number (InsetMathHull)', () => {
    const c = at('\n\\begin{equation}\nE=mc^{2}\\label{eq:demo}\n\\end{equation}\n');
    c.erase();                            // 1st Del: the label goes
    expect(out(c)).toBe('\n\\begin{equation}\nE=mc^{2}\n\\end{equation}\n');
    c.erase();                            // 2nd Del: the number goes
    expect(out(c)).toBe('\n\\[\nE=mc^{2}\n\\]\n');
    expect(c.erase()).toBe(false);        // 3rd Del: nothing left — the cursor leaves the formula
    expect(out(c)).toBe('\n\\[\nE=mc^{2}\n\\]\n');
    // per-row in an align: only the current row's label is touched (the row stays numbered), and only in the last column
    const a = at('\n\\begin{align}\na & =b\\label{eq:ab}\\\\\nc & =d\\label{eq:cd}\n\\end{align}\n');
    a.erase();
    expect(out(a)).toBe('\n\\begin{align}\na & =b\\label{eq:ab}\\\\\nc & =d\n\\end{align}\n');
    a.idx = 0; a.pos = a.lastpos;         // end of the first row's LEFT column: not the last column — no label change
    expect(a.erase()).toBe(false);
    expect(out(a)).toBe('\n\\begin{align}\na & =b\\label{eq:ab}\\\\\nc & =d\n\\end{align}\n');
  });
  it('mutating between environments keeps the content', () => {
    const c = at('\n\\begin{align}\na & =b\\\\\nc & =d\n\\end{align}\n');
    c.mutate('gather');
    expect(out(c)).toBe('\n\\begin{gather}\na=b\\\\\nc=d\n\\end{gather}\n');
    c.mutate('equation');
    expect(out(c)).toBe('\n\\[\na=bc=d\n\\]\n');
    c.mutate('simple');
    expect(out(c)).toBe('$a=bc=d$');
  });
});

describe('command completion (Tab in macro mode)', () => {
  it('offers document macros first, then LyX symbols and commands, shortest first', () => {
    expect(completeCommand('alp', MACROS)).toEqual(['alpha']);
    expect(completeCommand('in', MACROS).slice(0, 3)).toEqual(['inv', 'inf', 'int']);   // \inv is a document macro
    expect(completeCommand('fra', MACROS)[0]).toBe('frac');
    expect(completeCommand('', MACROS)).toEqual([]);
  });
  it('knows which names are commands', () => {
    expect(isKnownCommand('alpha', MACROS)).toBe(true);
    expect(isKnownCommand('frac', MACROS)).toBe(true);
    expect(isKnownCommand('inv', MACROS)).toBe(true);
    expect(isKnownCommand('alp', MACROS)).toBe(false);
  });
});

describe('selection with anchor and cursor at different depths (normalAnchor)', () => {
  function withAnchor(latex: string, anchor: (h: ReturnType<typeof parseFormula>) => Slice[]) {
    const h = parseFormula(latex, {});
    const c = new MathCursor(h, {});
    c.slices = anchor(h);
    c.resetAnchor();
    return { h, c, frac: atomCells(h)[0][4] };
  }
  it('an anchor inside a fraction and the cursor after it select the fraction whole', () => {
    const { h, c, frac } = withAnchor('$abc+\\frac{u}{v}+xyz$', h => [{ owner: h, idx: 0, pos: 4 }, { owner: atomCells(h)[0][4], idx: 0, pos: 1 }]);
    c.slices = [{ owner: h, idx: 0, pos: 6 }]; c.setSelection();
    expect(c.selection).toBe(true);
    expect(c.grabSelection()).toBe('\\frac{u}{v}+');
    c.slices = [{ owner: h, idx: 0, pos: 2 }]; c.setSelection();
    expect(c.grabSelection()).toBe('c+\\frac{u}{v}');
    c.slices = [{ owner: h, idx: 0, pos: 4 }]; c.setSelection();   // right before the fraction: still the fraction
    expect(c.selection).toBe(true);
    expect(c.grabSelection()).toBe('\\frac{u}{v}');
    c.slices = [{ owner: h, idx: 0, pos: 4 }, { owner: frac, idx: 0, pos: 1 }]; c.setSelection();   // back where it started
    expect(c.selection).toBe(false);
  });
  it('numerator and denominator: whole cells of the fraction', () => {
    const { h, c, frac } = withAnchor('$abc+\\frac{u}{v}+xyz$', h => [{ owner: h, idx: 0, pos: 4 }, { owner: atomCells(h)[0][4], idx: 0, pos: 0 }]);
    c.slices = [{ owner: h, idx: 0, pos: 4 }, { owner: frac, idx: 1, pos: 1 }]; c.setSelection();
    const r = c.selRange()!;
    expect([r.idx1, r.idx2]).toEqual([0, 1]);
    expect(c.selCells(r)).toEqual([[0, 1]]);
  });
  it('setCursorSelectionTo (Shift+click) takes an inset off the anchor whole, on the side it lies', () => {
    const { h, c, frac } = withAnchor('$abc+\\frac{u}{v}+xyz$', h => [{ owner: h, idx: 0, pos: 6 }]);
    c.setCursorSelectionTo([{ owner: h, idx: 0, pos: 4 }, { owner: frac, idx: 0, pos: 1 }]);
    expect(c.grabSelection()).toBe('\\frac{u}{v}+');
    expect(c.depth).toBe(1);
    const { c: c2, frac: f2, h: h2 } = withAnchor('$abc+\\frac{u}{v}+xyz$', h => [{ owner: h, idx: 0, pos: 1 }]);
    c2.setCursorSelectionTo([{ owner: h2, idx: 0, pos: 4 }, { owner: f2, idx: 1, pos: 0 }]);
    expect(c2.grabSelection()).toBe('bc+\\frac{u}{v}');
  });
  it('setSelection without a move is no selection; a click elsewhere keeps the anchor for Shift+click', () => {
    const { h, c } = withAnchor('$abc$', h => [{ owner: h, idx: 0, pos: 1 }]);
    c.setSelection();
    expect(c.selection).toBe(false);
    c.setCursorSelectionTo([{ owner: h, idx: 0, pos: 3 }]);
    expect(c.grabSelection()).toBe('bc');
  });
});

describe('math-mode (Ctrl+M): \\text{} in math, math again inside text (LyX LFUN_MATH_MODE)', () => {
  it('math inside \\text{} is \\ensuremath, not a second \\text', () => {
    const c = at('$0$');
    c.mathMode();
    expect(c.mode).toBe('text');
    type(c, ' (requires ');
    c.mathMode();
    expect(c.mode).toBe('math');
    type(c, 'p(x)');
    expect(out(c)).toBe('$0\\text{ (requires \\ensuremath{p(x)}}$');
  });
  it('wraps a selection inside text into math', () => {
    const h = parseFormula('$\\text{if xy}$', {});
    const c = new MathCursor(h, {});
    const text = atomCells(h)[0][0];
    c.slices = [{ owner: h, idx: 0, pos: 0 }, { owner: text, idx: 0, pos: 3 }];
    c.resetAnchor();
    c.setCursorSelectionTo([{ owner: h, idx: 0, pos: 0 }, { owner: text, idx: 0, pos: 5 }]);
    expect(c.grabSelection()).toBe('xy');
    c.mathMode();
    expect(out(c)).toBe('$\\text{if \\ensuremath{xy}}$');
  });
});
