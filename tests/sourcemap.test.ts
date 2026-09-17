/**
 * The source pane's source map (packages/client/src/app/sourcemap.ts): which paragraph a source
 * offset belongs to, offsets and spans carried through edits typed into the source, and the
 * cursor found within its own paragraph — plus the writer's spans themselves (core writeTex).
 */
import { describe, it, expect } from 'vitest';
import { spanIndexAt, editRange, mapOffset, mapSpans, sourceOffsetInSpan, locateInSpan, unbalancedBraceAt, offsetOfLine, lineOfOffset, spansFit, type Span } from '../packages/client/src/app/sourcemap.ts';
import { commentMask } from '../packages/client/src/app/codearea.ts';
import { parseTex, writeTex } from '../packages/core/src/tex/index.ts';
import { plainText } from '../packages/core/src/index.ts';

const LINES = [
  '\\begin{document}',          // 0
  '',                           // 1
  '\\section{Intro}',           // 2
  '',                           // 3
  'First words here.',          // 4
  '\\begin{itemize}',           // 5
  '\\item One',                 // 6
  '\\item Two',                 // 7
  '\\end{itemize}',             // 8
  'Some words. Some words.',    // 9
  '',                           // 10
  '\\end{document}',            // 11
];
const TEXT = LINES.join('\n');
const at = (line: number, col = 0) => offsetOfLine(TEXT, line) + col;
const span = (line: number): Span => ({ start: at(line), end: at(line) + LINES[line].length });
// paragraphs: \section, First words, \item One, \item Two, Some words
const SPANS: Span[] = [span(2), span(4), span(6), span(7), span(9)];

describe('spanIndexAt', () => {
  it('finds the paragraph whose span contains the offset, including its end', () => {
    expect(spanIndexAt(SPANS, at(4, 3), TEXT)).toBe(1);
    expect(spanIndexAt(SPANS, at(4) + LINES[4].length, TEXT)).toBe(1);
    expect(spanIndexAt(SPANS, at(7, 2), TEXT)).toBe(3);
  });
  it('gives a \\begin line to the paragraph that follows and an \\end line to the one before', () => {
    expect(spanIndexAt(SPANS, at(5, 4), TEXT)).toBe(2);
    expect(spanIndexAt(SPANS, at(8, 4), TEXT)).toBe(3);
  });
  it('gives blank lines to the paragraph before, the preamble to the first paragraph and the tail to the last', () => {
    expect(spanIndexAt(SPANS, at(3), TEXT)).toBe(0);
    expect(spanIndexAt(SPANS, at(0, 3), TEXT)).toBe(0);
    expect(spanIndexAt(SPANS, at(11, 3), TEXT)).toBe(4);
  });
  it('skips paragraphs without output', () => {
    expect(spanIndexAt([null, ...SPANS], at(0), TEXT)).toBe(1);
    expect(spanIndexAt([null, null], 3, TEXT)).toBe(-1);
  });
});

describe('editRange / mapOffset / mapSpans', () => {
  it('describes an insertion, a deletion and a replacement by common prefix and suffix', () => {
    expect(editRange('abc', 'abc')).toBeNull();
    expect(editRange('abc', 'abXc')).toEqual({ from: 2, oldTo: 2, newTo: 3 });
    expect(editRange('abXc', 'abc')).toEqual({ from: 2, oldTo: 3, newTo: 2 });
    expect(editRange('hello world', 'hello there world')).toEqual({ from: 6, oldTo: 6, newTo: 12 });
    expect(editRange('aaa', 'aaaa')).toEqual({ from: 3, oldTo: 3, newTo: 4 });
  });
  it('maps offsets: unchanged before, shifted after, clamped inside', () => {
    const e = editRange('one two three', 'one 2 three')!;   // "two" → "2"
    expect(mapOffset(2, e)).toBe(2);
    expect(mapOffset(13, e)).toBe(11);
    expect(mapOffset(5, e)).toBe(4);
    expect(mapOffset(5, e, true)).toBe(5);
  });
  it('lets a paragraph grow with text typed at its end and inside it, and shifts the ones after', () => {
    const typed = TEXT.slice(0, at(4) + LINES[4].length) + ' More.' + TEXT.slice(at(4) + LINES[4].length);
    const spans = mapSpans(SPANS, editRange(TEXT, typed));
    expect(typed.slice(spans[1]!.start, spans[1]!.end)).toBe('First words here. More.');
    expect(typed.slice(spans[2]!.start, spans[2]!.end)).toBe('\\item One');
    expect(typed.slice(spans[4]!.start, spans[4]!.end)).toBe('Some words. Some words.');
    const inside = TEXT.slice(0, at(4, 6)) + 'new ' + TEXT.slice(at(4, 6));
    const s2 = mapSpans(SPANS, editRange(TEXT, inside));
    expect(inside.slice(s2[1]!.start, s2[1]!.end)).toBe('First new words here.');
  });
  it('keeps text typed on a blank line before a paragraph out of it, and collapses a deleted paragraph', () => {
    const typed = TEXT.slice(0, at(3)) + 'Typed' + TEXT.slice(at(3));
    const spans = mapSpans(SPANS, editRange(TEXT, typed));
    expect(typed.slice(spans[1]!.start, spans[1]!.end)).toBe('First words here.');
    const gone = TEXT.slice(0, at(6)) + TEXT.slice(at(8));   // both items deleted
    const s3 = mapSpans(SPANS, editRange(TEXT, gone));
    expect(s3[2]!.end - s3[2]!.start).toBeLessThanOrEqual(1);   // (a prefix / suffix diff cannot tell which of two identical backslashes went)
    expect(gone.slice(s3[4]!.start, s3[4]!.end)).toBe('Some words. Some words.');
  });
});

describe('sourceOffsetInSpan / locateInSpan', () => {
  it('finds the cursor by its words inside the paragraph only — the same words elsewhere do not matter', () => {
    const off = sourceOffsetInSpan(TEXT, SPANS[4]!, { before: 'Some words. Some ', after: 'words.', parStart: 'Some words. Some words.' });
    expect(TEXT.slice(off, off + 6)).toBe('words.');
    expect(off).toBe(at(9) + 'Some words. Some '.length);
    // unusable words: the paragraph's start
    expect(sourceOffsetInSpan(TEXT, SPANS[2]!, { before: '', after: '', parStart: '' })).toBe(at(6));
  });
  it('locates a source caret in the paragraph\'s own block and falls back to its start on command-only lines', () => {
    const blocks = [{ kind: 'text' as const, text: 'Some words. Some words.' }];
    expect(locateInSpan(TEXT, SPANS[4]!, at(9, 12), blocks)).toEqual({ index: 0, offset: 12 });
    expect(locateInSpan(TEXT, SPANS[2]!, at(6, 3), [{ kind: 'text', text: 'One' }])).toEqual({ index: 0, offset: 0 });
  });
  it('helpers: offsetOfLine / lineOfOffset agree; spansFit needs one span per paragraph', () => {
    for (let l = 0; l < LINES.length; l++) expect(lineOfOffset(TEXT, offsetOfLine(TEXT, l))).toBe(l);
    expect(offsetOfLine(TEXT, 99)).toBe(TEXT.length);
    expect(spansFit(SPANS, 5)).toBe(true);
    expect(spansFit(SPANS, 4)).toBe(false);
    expect(spansFit(null, 0)).toBe(false);
  });
});

describe('unbalancedBraceAt', () => {
  it('points at the first unclosed opening brace or the first stray closing one; comments and \\{ do not count', () => {
    const t1 = 'a {b {c} d';
    expect(unbalancedBraceAt(t1, commentMask(t1))).toBe(2);
    const t2 = 'a {b} c} d';
    expect(unbalancedBraceAt(t2, commentMask(t2))).toBe(7);
    const t3 = 'ok {x} % { comment\n\\{ literal';
    expect(unbalancedBraceAt(t3, commentMask(t3))).toBe(-1);
  });
});

describe('writeTex spans (the writer\'s source map)', () => {
  const src = [
    '\\documentclass{article}', '\\begin{document}', '\\section{Introduction}', '',
    'First paragraph with some words', 'that continue on a second line.', '',
    '\\begin{itemize}', '\\item One item', '\\item Two item', '\\end{itemize}', '',
    'Consider data $X\\in\\mathbb{R}^{N}$ where $N$ is the dimension.', '\\begin{align}', 'a &= b \\\\', 'c &= d', '\\end{align}',
    'Some words. Some words.\\footnote{A footnote paragraph.}', '', '\\end{document}', '',
  ].join('\n');
  it('gives every body paragraph the range of the text it was written to, in order, trimmed', () => {
    const r = parseTex(src, {});
    const w = writeTex(r.doc, {});
    expect(w.spans).toHaveLength(r.doc.body.length);
    let last = 0;
    for (let i = 0; i < w.spans.length; i++) {
      const s = w.spans[i]!;
      expect(s.start).toBeGreaterThanOrEqual(last);
      const written = w.text.slice(s.start, s.end);
      expect(written).toBe(written.trim());
      // the paragraph's own words are in its span
      const words = plainText([r.doc.body[i]]).split(/\s+/).filter(x => /^[a-z]+$/i.test(x) && x.length > 3);
      for (const wd of words.slice(0, 3)) expect(written).toContain(wd);
      last = s.end;
    }
    expect(w.text.slice(w.spans[0]!.start, w.spans[0]!.end)).toBe('\\section{Introduction}');
    expect(w.text.slice(w.spans[2]!.start, w.spans[2]!.end)).toBe('\\item One item');
    expect(w.text.indexOf('\\begin{document}')).toBeLessThan(w.spans[0]!.start);
  });
  it('is offset by the settings line of a child document (fragment)', () => {
    const child = parseTex('First child paragraph.\n\nSecond child paragraph.\n', {});
    const w = writeTex(child.doc, { fragment: true });
    expect(w.spans).toHaveLength(2);
    expect(w.text.slice(w.spans[0]!.start, w.spans[0]!.end)).toBe('First child paragraph.');
    expect(w.text.slice(w.spans[1]!.start, w.spans[1]!.end)).toBe('Second child paragraph.');
  });
});
