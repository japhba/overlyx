/**
 * Damaged / unusual .lyx input must never make the parser throw, and must never turn into a
 * file that LyX cannot read after a save: what the writer produces from a damaged file is still
 * structurally complete, and the text of the document survives.
 */
import { describe, it, expect } from 'vitest';
import { parseLyx } from '../packages/core/src/lyx/parser.ts';
import { writeLyx } from '../packages/core/src/lyx/writer.ts';

const HEAD = `#LyX 2.5 created this file. For more info see https://www.lyx.org/
\\lyxformat 643
\\begin_document
\\begin_header
\\textclass article
\\end_header

\\begin_body
`;
const TAIL = `
\\end_body
\\end_document
`;
const doc = (body: string) => HEAD + body + TAIL;

function twice(text: string): { first: string; second: string } {
  const first = writeLyx(parseLyx(text));
  return { first, second: writeLyx(parseLyx(first)) };
}

describe('parser robustness', () => {
  it('a well-formed document round-trips', () => {
    const t = doc('\n\\begin_layout Standard\nHello world.\n\\end_layout\n');
    expect(writeLyx(parseLyx(t))).toBe(t);
  });

  it('an unterminated inset with only parameter lines does not swallow the rest of the document', () => {
    const t = doc('\n\\begin_layout Standard\nBefore \n\\begin_inset CommandInset ref\nLatexCommand ref\nreference "sec:x"\n\\end_layout\n\n\\begin_layout Standard\nAfter\n\\end_layout\n');
    const { first, second } = twice(t);
    expect(first).toBe(second);                                      // stable
    expect(first).toContain('\\end_inset');                           // the inset is closed
    expect(first.indexOf('\\end_inset')).toBeLessThan(first.indexOf('After'));
    expect((first.match(/\\end_layout/g) ?? []).length).toBe(2);      // both paragraphs survive
    expect(first.trimEnd().endsWith('\\end_document')).toBe(true);
    expect(first).toContain('After');
  });

  it('an unterminated text inset is closed by the writer', () => {
    const t = doc('\n\\begin_layout Standard\n\\begin_inset Note Note\nstatus open\n\n\\begin_layout Plain Layout\ninside\n\\end_layout\n\n\\end_layout\n');
    const { first, second } = twice(t);
    expect(first).toBe(second);
    expect(first).toContain('inside');
    expect(first.trimEnd().endsWith('\\end_document')).toBe(true);
  });

  it('unknown \\begin_… tokens are kept verbatim on their own lines', () => {
    const t = doc('\n\\begin_layout Standard\n\\begin_wibble\nfoo\n\\end_wibble\nbar\n\\end_layout\n');
    const { first, second } = twice(t);
    expect(first).toBe(t);
    expect(second).toBe(t);
  });

  it('unknown commands and an unbalanced \\end_deeper survive', () => {
    const t = doc('\n\\begin_layout Standard\n\\frobnicate 3\ntext\n\\end_layout\n\n\\end_deeper\n\\begin_layout Standard\nmore\n\\end_layout\n');
    const { first } = twice(t);
    expect(first).toContain('\\frobnicate 3');
    expect(first).toContain('more');
  });

  it('a missing \\end_body / \\end_document is added', () => {
    const t = HEAD + '\n\\begin_layout Standard\nx\n\\end_layout\n';
    const first = writeLyx(parseLyx(t));
    expect(first.trimEnd().endsWith('\\end_body\n\\end_document')).toBe(true);
  });

  it('CRLF line endings and a BOM are normalised, not corrupted', () => {
    const t = '\uFEFF' + doc('\n\\begin_layout Standard\nHello\n\\end_layout\n').replace(/\n/g, '\r\n');
    const p = parseLyx(t);
    expect(p.format).toBe(643);
    const first = writeLyx(p);
    expect(first).not.toContain('\r');
    expect(first).not.toContain('\uFEFF');
    expect(first).toContain('Hello');
  });

  it('an empty file or a non-LyX file yields format 0 (the server refuses to open it)', () => {
    expect(parseLyx('').format).toBe(0);
    expect(parseLyx('just some text\nnot lyx\n').format).toBe(0);
    expect(parseLyx('\\lyxformat abc\n').format).toBe(0);
  });
});
