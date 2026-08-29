/** The line diff used by the AI-repair merge editor (app/diff.ts). */
import { describe, it, expect } from 'vitest';
import { diffLines } from '../packages/client/src/app/diff.ts';

function apply(a: string, diff: ReturnType<typeof diffLines>): { reconstructedA: string; reconstructedB: string } {
  const aLines: string[] = [], bLines: string[] = [];
  for (const l of diff) {
    if (l.type !== 'add') aLines.push(l.text);
    if (l.type !== 'del') bLines.push(l.text);
  }
  return { reconstructedA: aLines.join('\n'), reconstructedB: bLines.join('\n') };
}

describe('diffLines', () => {
  it('identical text is all "same"', () => {
    const d = diffLines('a\nb\nc', 'a\nb\nc');
    expect(d.every(l => l.type === 'same')).toBe(true);
  });

  it('an inserted line shows as add, surrounded by same', () => {
    const d = diffLines('a\nb\nc', 'a\nX\nb\nc');
    expect(d.map(l => l.type)).toEqual(['same', 'add', 'same', 'same']);
  });

  it('a removed line shows as del', () => {
    const d = diffLines('a\nb\nc', 'a\nc');
    expect(d.map(l => l.type)).toEqual(['same', 'del', 'same']);
  });

  it('a changed line shows as del + add (not "same")', () => {
    const d = diffLines('one\ntwo\nthree', 'one\nTWO\nthree');
    expect(d.some(l => l.type === 'del' && l.text === 'two')).toBe(true);
    expect(d.some(l => l.type === 'add' && l.text === 'TWO')).toBe(true);
  });

  it('reconstructs both original and target from the diff', () => {
    const a = 'line1\nline2\nline3\nline4';
    const b = 'line1\nline2 changed\nline3\nline5';
    const d = diffLines(a, b);
    const { reconstructedA, reconstructedB } = apply(a, d);
    expect(reconstructedA).toBe(a);
    expect(reconstructedB).toBe(b);
  });

  it('falls back to a plain remove-all/add-all split for pathologically large inputs', () => {
    const a = Array.from({ length: 2500 }, (_, i) => `a${i}`).join('\n');
    const b = Array.from({ length: 2500 }, (_, i) => `b${i}`).join('\n');
    const d = diffLines(a, b);
    expect(d.filter(l => l.type === 'del')).toHaveLength(2500);
    expect(d.filter(l => l.type === 'add')).toHaveLength(2500);
  });
});
