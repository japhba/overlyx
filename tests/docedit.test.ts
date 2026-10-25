/**
 * replaceInSource (packages/server/src/docedit.ts): the text-replacement step of edit_document,
 * tolerant of the tracked-change markup and whitespace an agent may leave out of its quote.
 */
import { describe, it, expect, vi } from 'vitest';
import { applyTrackedSource, replaceInSource, changeWrappers, excerptOfChange, type EditableDoc } from '../packages/server/src/docedit.ts';
import { parseTex, writeTex } from '../packages/core/src/tex/index.ts';
import { resolveChanges } from '../packages/core/src/lyx/trackdiff.ts';

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

describe('refining a pending tracked insertion', () => {
  it('attaches an adjacent tracked break to a heading, preserving a separate empty paragraph after a blank line', () => {
    const adjacent = `\\paragraph*{Heading}${ADD('¶')}\n\nBody.`;
    const parsed = parseTex(adjacent);
    expect(parsed.doc.body.map(p => p.layout)).toEqual(['Paragraph*', 'Standard']);
    expect(parsed.doc.body[0].endChange?.type).toBe('inserted');
    expect(adjacent.slice(parsed.sources[0]!.start, parsed.sources[0]!.end)).toBe(`\\paragraph*{Heading}${ADD('¶')}`);
    const separate = parseTex(`\\paragraph*{Heading}\n\n${ADD('¶')}\n\nBody.`).doc;
    expect(separate.body.map(p => [p.layout, p.items.length, p.endChange?.type]))
      .toEqual([['Paragraph*', 1, undefined], ['Standard', 0, 'inserted'], ['Standard', 1, undefined]]);
  });

  it('keeps its marks and paragraph structure through repeated source edits, including a figure', () => {
    const source = (body: string) => `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;
    const original = source('Intro.\n\n\\subsection*{Next}\n\nTail.');
    let live = parseTex(original).doc;
    const doc: EditableDoc = {
      parse: text => parseTex(text).doc,
      toLyxDocument: () => live,
      toText: () => writeTex(live).text,
      textOf: d => writeTex(d).text,
      loadFromLyx: d => { live = d; },
      edited() {},
      retiredMacros: new Set(),
    };
    const block = String.raw`\subsection*{New block}

First inserted paragraph.

\paragraph*{One}

One body.

\paragraph*{Two}

Two body.

\begin{figure}
\centering{}\caption{The estimate is 9.}
\end{figure}

\subsection*{Next}`;
    let now = 1790000000000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const edit = (from: string, to: string) => {
      now += 60_000;
      const before = doc.toText();
      return applyTrackedSource(doc, before, replaceInSource(before, from, to), 'Assistant');
    };
    const body = (text: string) => text.slice(text.indexOf('\\begin{document}'), text.indexOf('\\end{document}'));
    const expectRoundTrip = () => {
      const parsed = doc.parse(doc.toText());
      expect(parsed.body.map(p => [p.layout, p.items.length, p.endChange]))
        .toEqual(live.body.map(p => [p.layout, p.items.length, p.endChange]));
      expect(writeTex(parsed).text).toBe(doc.toText());
      expect(live.body.every(p => p.items.length > 0)).toBe(true);
    };
    try {
      edit('\\subsection*{Next}', block);
      expectRoundTrip();
      for (const [from, to] of [['9', '7'], ['7', '5']]) {
        const before = doc.toText();
        const result = edit(`The estimate is ${from}.`, `The estimate is ${to}.`);
        expect(result).toMatchObject({ inserted: 0, deleted: 0, changed: true });
        expect(result.after).toBe(before.replace(`The estimate is ${from}.`, `The estimate is ${to}.`));
        expectRoundTrip();
      }
      const expanded = 'Two body, with a calculation.\n\n\\begin{equation}\nx=1\n\\end{equation}\n\nMore text.';
      edit('Two body.', expanded);
      expectRoundTrip();
      const before = doc.toText();
      edit('The estimate is 5.', 'The estimate is 3.');
      expect(doc.toText()).toBe(before.replace('The estimate is 5.', 'The estimate is 3.'));
      expectRoundTrip();
      expect(body(writeTex({ ...live, body: resolveChanges(live.body, false) }).text))
        .toBe(body(writeTex(doc.parse(original)).text));
      const expected = original.replace('\\subsection*{Next}', block).replace('Two body.', expanded).replace('The estimate is 9.', 'The estimate is 3.');
      expect(body(writeTex({ ...live, body: resolveChanges(live.body, true) }).text))
        .toBe(body(writeTex(doc.parse(expected)).text));
    } finally { clock.mockRestore(); }
  });
});
