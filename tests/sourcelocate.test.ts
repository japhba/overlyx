/** Cursor → source line matching of the source pane (packages/client/src/app/sourcelocate.ts). */
import { describe, it, expect } from 'vitest';
import { findSourceLine, locateSourceLine, locateSourceCaret, plainWords } from '../packages/client/src/app/sourcelocate.ts';

const NUL = String.fromCharCode(0);
const SRC = [
  '\\documentclass{article}',            // 0
  '\\begin{document}',                    // 1
  'First paragraph with some words',      // 2
  'that continue on a second line.',      // 3
  '',                                     // 4
  'Consider data $X\\in\\bR^{N}$ where $N$ is',  // 5
  'the dimension, i.e.\\ 100\\% of it.',  // 6
  '\\begin{align}',                        // 7
  'a &= b \\\\',                            // 8
  'c &= d',                                // 9
  '\\end{align}',                          // 10
  'Some words. Some words.',               // 11
  '\\end{document}',                       // 12
].join('\n');

describe('findSourceLine', () => {
  it('finds the cursor by the text before it, across the file\'s line breaks', () => {
    const r = findSourceLine(SRC, { before: 'First paragraph with some words that continue on a ', after: 'second line.', parStart: 'First paragraph with some words' });
    expect(r?.line).toBe(3);
    expect(SRC.slice(0, r!.offset).endsWith('continue on a ')).toBe(true);
  });
  it('at a paragraph start it uses the text after the cursor', () => {
    expect(findSourceLine(SRC, { before: '', after: 'that continue on a second line.', parStart: 'First paragraph' })?.line).toBe(3);
  });
  it('stops at characters the writer escapes and at formulas (NUL), and still finds the place', () => {
    // "100% of it" is written as "100\% of it": only the words after the % are searched
    expect(findSourceLine(SRC, { before: `Consider data ${NUL} where ${NUL} is the dimension, i.e. 100% of`, after: ' it.', parStart: 'Consider data ' })?.line).toBe(6);
    // right after an inline formula: "where" follows it in the source
    expect(findSourceLine(SRC, { before: `Consider data ${NUL} where`, after: ` ${NUL} is`, parStart: 'Consider data ' })?.line).toBe(5);
  });
  it('inside a formula it finds the row of a display formula and an inline formula', () => {
    expect(findSourceLine(SRC, { before: '', after: '', formula: { latex: '\\begin{align}\na &= b \\\\\nc &= d\n\\end{align}', row: 1, display: true } })?.line).toBe(9);
    expect(findSourceLine(SRC, { before: '', after: '', formula: { latex: '\\begin{align}\na &= b \\\\\nc &= d\n\\end{align}', row: 0, display: true } })?.line).toBe(8);
    expect(findSourceLine(SRC, { before: `Consider data ${NUL} where `, after: ' is', formula: { latex: 'N', row: 0, display: false }, parStart: 'Consider data' })?.line).toBe(5);
  });
  it('picks the occurrence nearest to the paragraph start when a phrase repeats', () => {
    const r = findSourceLine(SRC, { before: 'Some words. Some words', after: '.', parStart: 'Some words. Some' });
    expect(r?.line).toBe(11);
    expect(SRC.slice(0, r!.offset).endsWith('Some words. Some words')).toBe(true);
  });
  it('returns null when nothing can be found', () => {
    expect(findSourceLine(SRC, { before: 'zzz qqq', after: 'yyy' })).toBeNull();
  });
});

describe('locateSourceLine (SyncTeX inverse search)', () => {
  const text = ['\\section{Intro}', '', 'The promise of deep learning is to discover rich, hierarchical models \\cite{bengio} that represent', 'probability distributions.', '', '\\begin{equation}', '\\min_{G}\\max_{D}V(D,G)=1\\label{eq:m}', '\\end{equation}', '', 'Second paragraph here.'].join('\n');
  const blocks = [
    { kind: 'text' as const, text: 'Intro' },
    { kind: 'text' as const, text: 'The promise of deep learning is to discover rich, hierarchical models \u0000 that represent probability distributions.' },
    { kind: 'math' as const, text: '\\begin{equation}\n\\min_{G}\\max_{D}V(D,G)=1\\label{eq:m}\n\\end{equation}' },
    { kind: 'text' as const, text: 'Second paragraph here.' },
  ];
  it('finds the paragraph of a text line and the offset of its words', () => {
    expect(locateSourceLine(text, 2, blocks)).toEqual({ index: 1, offset: 0 });
    const r = locateSourceLine(text, 3, blocks)!;
    expect(r.index).toBe(1);
    expect(blocks[1].text.slice(r.offset)).toMatch(/^probability distributions/);
  });
  it('finds a formula row in the display formulas', () => {
    expect(locateSourceLine(text, 6, blocks)).toEqual({ index: 2, offset: 0 });
  });
  it('skips an empty or command-only line to the paragraph after it', () => {
    expect(locateSourceLine(text, 0, blocks)).toEqual({ index: 0, offset: 0 });   // \section{Intro} → the heading's words
    expect(locateSourceLine(text, 8, blocks)).toEqual({ index: 3, offset: 0 });
  });
  it('prefers the block that starts with the line (a heading whose word also occurs in a paragraph)', () => {
    const t = ['Experiments demonstrate the potential of the framework.', '', '\\section{Experiments}\\label{sec:exp}', '', 'We trained nets.'].join('\n');
    const b = [{ kind: 'text' as const, text: 'Experiments demonstrate the potential of the framework.' }, { kind: 'text' as const, text: 'Experiments' }, { kind: 'text' as const, text: 'We trained nets.' }];
    expect(locateSourceLine(t, 2, b)).toEqual({ index: 1, offset: 0 });
    expect(locateSourceLine(t, 0, b)).toEqual({ index: 0, offset: 0 });
  });
  it('strips LaTeX to the words the editor shows', () => {
    expect(plainWords('\\emph{Deep} models~\\cite{a,b} of $x^2$ here \\label{s:x}')).toBe('Deep models of here');
  });
});

describe('locateSourceCaret', () => {
  const blocks = [
    { kind: 'text' as const, text: 'First paragraph with some words that continue on a second line.' },
    { kind: 'text' as const, text: `Consider data ${NUL} where ${NUL} is the dimension, i.e. 100% of it.` },
    { kind: 'math' as const, text: '\\begin{align}\na &= b \\\\\nc &= d\n\\end{align}' },
    { kind: 'text' as const, text: 'Some words. Some words.' },
  ];
  it('maps a column on a wrapped line to the character in the paragraph', () => {
    // line 3 = "that continue on a second line."; caret after "on a " (col 19)
    const r = locateSourceCaret(SRC, 3, 19, blocks);
    expect(r).toEqual({ index: 0, offset: 'First paragraph with some words that continue on a '.length });
  });
  it('a caret inside a word lands inside that word', () => {
    const r = locateSourceCaret(SRC, 2, 8, blocks);   // "First pa|ragraph"
    expect(r).toEqual({ index: 0, offset: 8 });
  });
  it('at the start of a line: the line\'s first character', () => {
    expect(locateSourceCaret(SRC, 3, 0, blocks)).toEqual({ index: 0, offset: 'First paragraph with some words '.length });
  });
  it('after a formula and an escaped character the words still match; a formula line gives the formula', () => {
    const r = locateSourceCaret(SRC, 6, 'the dimension, i.e.\\ 100\\% of'.length, blocks);
    expect(r?.index).toBe(1);
    expect(blocks[1].text.slice(0, r!.offset)).toMatch(/100% of$/);
    expect(locateSourceCaret(SRC, 9, 3, blocks)).toEqual({ index: 2, offset: 0 });
  });
  it('a repeated phrase: the occurrence nearest to where the line starts in the block', () => {
    expect(locateSourceCaret(SRC, 11, 'Some words. Some'.length, blocks)).toEqual({ index: 3, offset: 'Some words. Some'.length });
  });
});
