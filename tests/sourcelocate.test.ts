/** Cursor → source line matching of the source pane (packages/client/src/app/sourcelocate.ts). */
import { describe, it, expect } from 'vitest';
import { findSourceLine } from '../packages/client/src/app/sourcelocate.ts';

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
