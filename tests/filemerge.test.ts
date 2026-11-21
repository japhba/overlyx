/** The three-way merges of a deck's text (by lines) and a board's objects (server filemerge.ts). */
import { it, expect } from 'vitest';
import { mergeLines, mergeObjects } from '../packages/server/src/filemerge.ts';

const L = (...xs: string[]) => xs.map(x => x + '\n').join('');
/** the splices applied to ours give the merged text */
function check(base: string, ours: string, theirs: string) {
  const m = mergeLines(base, ours, theirs);
  let t = ours;
  for (const s of [...m.splices].reverse()) t = t.slice(0, s.from) + s.insert + t.slice(s.from + s.removed);
  expect(t).toBe(m.text);
  return m;
}

it('takes each side\'s change where only it changed', () => {
  const base = L('a', 'b', 'c', 'd', 'e', 'f');
  expect(check(base, L('a', 'B', 'c', 'd', 'e', 'f'), L('a', 'b', 'c', 'd', 'E', 'f'))).toMatchObject({ text: L('a', 'B', 'c', 'd', 'E', 'f'), conflicts: 0 });
  expect(check(base, L('a', 'b', 'c', 'd', 'e', 'f', 'g'), L('x', 'a', 'b', 'c', 'e', 'f'))).toMatchObject({ text: L('x', 'a', 'b', 'c', 'e', 'f', 'g'), conflicts: 0 });
  expect(check(base, base, L('a', 'c'))).toMatchObject({ text: L('a', 'c'), conflicts: 0 });
  expect(check(base, L('a', 'c'), base)).toMatchObject({ text: L('a', 'c'), conflicts: 0, splices: [] });
});

it('the same change on both sides counts once', () => {
  const base = L('a', 'b', 'c');
  expect(check(base, L('a', 'X', 'c'), L('a', 'X', 'c'))).toMatchObject({ text: L('a', 'X', 'c'), conflicts: 0 });
});

it('lines both changed (or adjacent changes) take theirs and count as a conflict', () => {
  const base = L('a', 'b', 'c', 'd', 'e');
  expect(check(base, L('a', 'OURS', 'c', 'd', 'E'), L('a', 'THEIRS', 'c', 'd', 'e'))).toMatchObject({ text: L('a', 'THEIRS', 'c', 'd', 'E'), conflicts: 1 });
  expect(check(base, L('a', 'B', 'c', 'd', 'e'), L('a', 'b', 'C', 'd', 'e'))).toMatchObject({ text: L('a', 'b', 'C', 'd', 'e'), conflicts: 1 });
});

it('a last line without a newline, and empty texts', () => {
  expect(check('a\nm\nb', 'a\nm\nB', 'A\nm\nb')).toMatchObject({ text: 'A\nm\nB', conflicts: 0 });
  expect(check('', 'ours\n', '')).toMatchObject({ text: 'ours\n', conflicts: 0 });
  expect(check('', '', 'theirs\n')).toMatchObject({ text: 'theirs\n', conflicts: 0 });
});

it('board objects: one side\'s changes taken, both changed takes theirs', () => {
  const base = { a: { t: 1 }, b: { t: 2 }, c: { t: 3 } };
  const ours = new Map<string, unknown>([['a', { t: 10 }], ['b', { t: 2 }], ['d', { t: 4 }]]);   // a changed, c erased, d drawn
  const theirs = { a: { t: 1 }, b: { t: 20 }, c: { t: 3 }, e: { t: 5 } };                         // b changed, e added
  const m = mergeObjects(base, ours, theirs);
  expect(m.conflicts).toBe(0);
  expect([...m.set]).toEqual([['b', { t: 20 }], ['e', { t: 5 }]]);
  const both = mergeObjects(base, new Map<string, unknown>([['a', { t: 10 }], ['b', { t: 2 }], ['c', { t: 3 }]]), { a: { t: 11 }, b: { t: 2 } });
  expect(both.conflicts).toBe(1);
  expect([...both.set]).toEqual([['a', { t: 11 }], ['c', undefined]]);
});
