// @vitest-environment happy-dom
/**
 * The autocorrecter's judgement (editor/spell/autocorrect.ts): which typo/suggestion pairs are
 * corrected on the spot, smartphone-style — one edit away (transpositions count as one, two edits
 * for long words), first letter preserved (or its swap), single words only, case carried over.
 * The wiring (space-triggered, never in math/code, Backspace revert) is covered in e2e/spell.spec.ts.
 */
import { describe, it, expect } from 'vitest';
import { editDistance, autocorrectFix, swapCandidates } from '../packages/client/src/editor/spell/autocorrect.ts';

describe('editDistance (Damerau)', () => {
  it('counts a transposition as one edit', () => {
    expect(editDistance('teh', 'the')).toBe(1);
    expect(editDistance('recieve', 'receive')).toBe(1);
  });
  it('substitutions, insertions, deletions', () => {
    expect(editDistance('word', 'ward')).toBe(1);
    expect(editDistance('wrd', 'word')).toBe(1);
    expect(editDistance('woord', 'word')).toBe(1);
    expect(editDistance('kitten', 'sitting')).toBe(3);
  });
});

describe('swapCandidates', () => {
  it('lists each adjacent transposition once', () => {
    expect(swapCandidates('teh')).toEqual(['eth', 'the']);
    expect(swapCandidates('ab')).toEqual(['ba']);
    expect(swapCandidates('aa')).toEqual([]);
  });
});

describe('autocorrectFix', () => {
  it('fixes classic one-edit typos', () => {
    expect(autocorrectFix('teh', ['the'])).toBe('the');
    expect(autocorrectFix('adress', ['address', 'dress'])).toBe('address');
    expect(autocorrectFix('hte', ['the'])).toBe('the');           // first-two-letter swap
  });
  it('prefers a transposition over a substitution, whatever the dictionary order', () => {
    expect(autocorrectFix('teh', ['ten', 'tech', 'the'])).toBe('the');
    expect(autocorrectFix('form', ['from', 'form'])).toBe('from');
  });
  it('keeps the typed capitalisation', () => {
    expect(autocorrectFix('Teh', ['the'])).toBe('The');
  });
  it('allows two edits only on long words', () => {
    expect(autocorrectFix('recieved', ['received'])).toBe('received');
    expect(autocorrectFix('exercize', ['exercise'])).toBe('exercise');   // long: distance 2 ok
    expect(autocorrectFix('cat', ['cost'])).toBeNull();                  // short: distance 2 is a different word
  });
  it('never rewrites into something far away, split, or differently headed', () => {
    expect(autocorrectFix('graident', ['gradient'])).toBe('gradient');
    expect(autocorrectFix('word', ['sword'])).toBeNull();                // first letter changes
    expect(autocorrectFix('alot', ['a lot'])).toBeNull();                // no splitting
    expect(autocorrectFix('chaos', ['chaos'])).toBeNull();               // already right
    expect(autocorrectFix('zzzz', [])).toBeNull();
  });
});
