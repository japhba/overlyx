import { describe, it, expect } from 'vitest';
import { parseLyx } from '../packages/core/src/lyx/parser.ts';
import { writeLyx } from '../packages/core/src/lyx/writer.ts';
import { mergeLyx, align } from '../packages/core/src/lyx/merge.ts';

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
const par = (t: string) => `\n\\begin_layout Standard\n${t}\n\\end_layout\n`;
const doc = (...pars: string[]) => parseLyx(HEAD + pars.map(par).join('') + TAIL);
const pars = (d: ReturnType<typeof doc>) => d.body.map(p => p.items.map(i => (i.kind === 'text' ? i.text : '')).join(''));
const merge = (b: string[], o: string[], t: string[]) => pars(mergeLyx(doc(...b), doc(...o), doc(...t)));

describe('align', () => {
  it('finds a longest common subsequence', () => {
    expect(align(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd'])).toEqual([[0, 0], [2, 2], [3, 3]]);
    expect(align(['a', 'b'], ['b', 'a', 'b'])).toEqual([[0, 1], [1, 2]]);
    expect(align([], ['a'])).toEqual([]);
    expect(align(['a', 'b', 'c'], ['a', 'b', 'c'])).toEqual([[0, 0], [1, 1], [2, 2]]);
  });
  it('anchors on unique paragraphs when the documents are too different for the quadratic pass', () => {
    const a = Array.from({ length: 3000 }, (_, i) => 'p' + i);
    const b = ['new0', ...a.slice(0, 1500).map(x => (x === 'p700' ? 'changed' : x)), 'new1', ...a.slice(1500).map(x => x + '!')];
    const pairs = align(a, b);
    expect(pairs.length).toBeGreaterThan(1400);
    for (const [i, j] of pairs) expect(a[i]).toBe(b[j]);
  });
});

describe('mergeLyx', () => {
  const base = ['one', 'two', 'three', 'four', 'five'];

  it('takes what changed on disk and keeps what changed here', () => {
    expect(merge(base, ['one', 'two', 'three', 'four', 'five here'], ['one on disk', 'two', 'three', 'four', 'five']))
      .toEqual(['one on disk', 'two', 'three', 'four', 'five here']);
  });

  it('nothing changed on disk: ours is returned unchanged', () => {
    expect(merge(base, ['one', 'TWO', 'three', 'inserted', 'four'], base)).toEqual(['one', 'TWO', 'three', 'inserted', 'four']);
  });

  it('nothing changed here: theirs is taken as is', () => {
    expect(merge(base, base, ['zero', 'one', 'three', 'four', 'five', 'six'])).toEqual(['zero', 'one', 'three', 'four', 'five', 'six']);
  });

  it('insertions and deletions on both sides in different places', () => {
    expect(merge(base, ['one', 'two', 'two b', 'three', 'four', 'five'], ['one', 'two', 'three', 'five', 'six']))
      .toEqual(['one', 'two', 'two b', 'three', 'five', 'six']);
  });

  it('the disk wins where both sides changed the same paragraph', () => {
    expect(merge(base, ['one', 'two here', 'three', 'four', 'five'], ['one', 'two on disk', 'three', 'four', 'five']))
      .toEqual(['one', 'two on disk', 'three', 'four', 'five']);
  });

  it('adjacent changes: the disk region absorbs the touching local change', () => {
    // local edit of "two", disk edit of "three": regions touch — the disk's version of the block wins
    expect(merge(base, ['one', 'two here', 'three', 'four', 'five'], ['one', 'two', 'three on disk', 'four', 'five']))
      .toEqual(['one', 'two', 'three on disk', 'four', 'five']);
  });

  it('a paragraph deleted on disk while edited here disappears (disk wins)', () => {
    expect(merge(base, ['one', 'two here', 'three', 'four', 'five'], ['one', 'three', 'four', 'five']))
      .toEqual(['one', 'three', 'four', 'five']);
  });

  it('the header follows the disk when it changed there, ours otherwise', () => {
    const b = doc('x'), o = doc('x'), t = doc('x');
    o.header.lines.push('\\use_hyperref true');
    expect(mergeLyx(b, o, t).header.lines).toContain('\\use_hyperref true');
    t.header.lines.push('\\papersize a4');
    expect(mergeLyx(b, o, t).header.lines).toContain('\\papersize a4');
    expect(mergeLyx(b, o, t).header.lines).not.toContain('\\use_hyperref true');
  });

  it('the result is a writable document', () => {
    const m = mergeLyx(doc(...base), doc('one', 'two here', 'three', 'four', 'five'), doc('one', 'two', 'three', 'four on disk', 'five'));
    expect(writeLyx(m)).toContain('four on disk');
    expect(writeLyx(m)).toContain('two here');
  });
});
