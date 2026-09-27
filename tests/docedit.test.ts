/**
 * replaceInSource (packages/server/src/docedit.ts): the text-replacement step of edit_document,
 * tolerant of the tracked-change markup and whitespace an agent may leave out of its quote.
 */
import { describe, it, expect } from 'vitest';
import { replaceInSource, changeWrappers, excerptOfChange } from '../packages/server/src/docedit.ts';

const ADD = (s: string) => `\\lyxadded{Jan}{Sun Sep 27 10:00:00 2026}{${s}}`;
const DEL = (s: string) => `\\lyxdeleted{Jan}{Sun Sep 27 10:00:00 2026}{${s}}`;

describe('replaceInSource', () => {
  it('replaces a unique exact passage', () => {
    expect(replaceInSource('one two three', 'two', 'TWO')).toBe('one TWO three');
  });

  it('refuses an ambiguous passage unless replace_all', () => {
    expect(() => replaceInSource('a x b x c', 'x', 'y')).toThrow(/occurs 2 times/);
    expect(replaceInSource('a x b x c', 'x', 'y', true)).toBe('a y b y c');
  });

  it('matches a quote without the markup (the text as it reads now)', () => {
    const src = `A ${DEL('old')}${ADD('new')} word.`;
    expect(replaceInSource(src, 'A new word.', 'A newer word.')).toBe('A newer word.');
  });

  it('a match ending inside a change keeps the rest of it marked', () => {
    const src = `foo ${ADD('bar baz')} qux`;
    expect(replaceInSource(src, 'foo bar', 'FOO BAR')).toBe(`FOO BAR${ADD(' baz')} qux`);
    expect(replaceInSource(src, 'baz qux', 'BAZ QUX')).toBe(`foo ${ADD('bar ')}BAZ QUX`);
  });

  it('also matches with the deleted text kept in the quote', () => {
    const src = `keep ${DEL('gone')} this`;
    expect(replaceInSource(src, 'keep gone this', 'kept')).toBe('kept');
  });

  it('tolerates different whitespace', () => {
    expect(replaceInSource('first line\n  second   line', 'line second line', 'L')).toBe('first L');
  });

  it('refuses a replacement that unbalances braces', () => {
    expect(() => replaceInSource('\\textbf{a} b', 'b', '\\emph{b')).toThrow(/unbalanced/);
  });

  it('says where a near miss diverges', () => {
    expect(() => replaceInSource('The quick brown fox jumps over the lazy dog.', 'The quick brown fox leaps', 'x'))
      .toThrow(/first 20 characters match.*jumps over.*leaps/s);
  });

  it('finds change wrappers with nested groups', () => {
    const src = `x ${ADD('\\textbf{b} and {c}')} y`;
    const [w] = changeWrappers(src);
    expect(src.slice(w.contentStart, w.contentEnd)).toBe('\\textbf{b} and {c}');
    expect(src.slice(w.end)).toBe(' y');
  });
});

describe('excerptOfChange', () => {
  it('returns the changed lines with context', () => {
    const a = '\\begin{document}\n1\n2\n3\n4\n5\n6\n\\end{document}';
    const b = a.replace('4', 'four');
    expect(excerptOfChange(a, b)).toBe('2\n3\nfour\n5\n6');
    expect(excerptOfChange(a, a)).toBe('');
  });
});
