/** Word-level diff (core/lyx/tokendiff.ts) that turns a plain-text edit into same/del/add runs. */
import { describe, it, expect } from 'vitest';
import { diffText, tokenize } from '../packages/core/src/lyx/tokendiff.ts';

function reconstruct(runs: ReturnType<typeof diffText>, side: 'old' | 'new'): string {
  return runs.filter(r => side === 'old' ? r.type !== 'add' : r.type !== 'del').map(r => r.text).join('');
}

describe('tokenize', () => {
  it('splits into alternating word / whitespace runs', () => {
    expect(tokenize('foo  bar\tbaz')).toEqual(['foo', '  ', 'bar', '\t', 'baz']);
  });
});

describe('diffText', () => {
  it('identical text is one "same" run', () => {
    const d = diffText('hello world', 'hello world');
    expect(d).toEqual([{ type: 'same', text: 'hello world' }]);
  });

  it('a single word change is del + add, not a rewrite of the whole sentence', () => {
    const d = diffText('The cat sat on the mat.', 'The dog sat on the mat.');
    expect(d.filter(r => r.type === 'del').map(r => r.text)).toEqual(['cat']);
    expect(d.filter(r => r.type === 'add').map(r => r.text)).toEqual(['dog']);
    expect(d[0].type).toBe('same'); // "The " unchanged prefix
  });

  it('an appended sentence is a pure "add" at the end', () => {
    const d = diffText('First sentence.', 'First sentence. Second sentence.');
    expect(d[0]).toEqual({ type: 'same', text: 'First sentence.' });
    expect(d[d.length - 1].type).toBe('add');
    expect(d[d.length - 1].text).toContain('Second sentence.');
  });

  it('reconstructs both the old and the new text from the runs', () => {
    const oldText = 'Results improved substantially over the baseline in every condition.';
    const newText = 'Results improved noticeably over the strong baseline in most conditions.';
    const d = diffText(oldText, newText);
    expect(reconstruct(d, 'old')).toBe(oldText);
    expect(reconstruct(d, 'new')).toBe(newText);
  });

  it('coalesces adjacent same-type tokens into one run', () => {
    const d = diffText('aaa bbb', 'xxx yyy');
    // "aaa"/"xxx" and "bbb"/"yyy" differ, the space between is common -> del,same,del,add,... shaped;
    // no two consecutive runs should share a type (coalesced), and no word is split into pieces
    const types = d.map(r => r.type);
    for (let i = 1; i < types.length; i++) expect(types[i]).not.toBe(types[i - 1]);
    expect(reconstruct(d, 'old')).toBe('aaa bbb');
    expect(reconstruct(d, 'new')).toBe('xxx yyy');
  });
});
