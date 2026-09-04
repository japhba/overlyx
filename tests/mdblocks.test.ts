/**
 * Block structure of the agent transcript's markdown-lite (packages/client/src/app/mdblocks.ts):
 * GFM tables, block quotes, fenced code, headings and rules become blocks; everything else stays
 * running text (rendered pre-wrapped, so plain lines and list bullets keep their breaks).
 */
import { describe, it, expect } from 'vitest';
import { parseBlocks, splitRow } from '../packages/client/src/app/mdblocks.ts';

describe('parseBlocks', () => {
  it('plain text is one text block, newlines kept', () => {
    expect(parseBlocks('a\n- one\n- two\n\nb')).toEqual([{ kind: 'text', text: 'a\n- one\n- two\n\nb' }]);
  });

  it('a GFM table with alignment and escaped pipes; the text around it loses only the blank separators', () => {
    const md = 'Results:\n\n| Model | Acc |\n|:--|--:|\n| BERT | 92.1 |\n| a \\| b | 3 |\n\nDone.';
    const blocks = parseBlocks(md);
    expect(blocks).toEqual([
      { kind: 'text', text: 'Results:' },
      { kind: 'table', align: ['left', 'right'], head: ['Model', 'Acc'], rows: [['BERT', '92.1'], ['a | b', '3']] },
      { kind: 'text', text: 'Done.' },
    ]);
  });

  it('tables without outer pipes, short rows padded, long rows cut', () => {
    const blocks = parseBlocks('a | b | c\n--- | --- | ---\n1 | 2\n1 | 2 | 3 | 4');
    expect(blocks).toEqual([{ kind: 'table', align: [null, null, null], head: ['a', 'b', 'c'], rows: [['1', '2', ''], ['1', '2', '3']] }]);
  });

  it('a pipe line without a delimiter row is just text, and so is a lone dash line after prose', () => {
    expect(parseBlocks('x | y\nz')).toEqual([{ kind: 'text', text: 'x | y\nz' }]);
    expect(parseBlocks('a\n---\nb')).toEqual([{ kind: 'text', text: 'a' }, { kind: 'rule' }, { kind: 'text', text: 'b' }]);
  });

  it('block quotes nest and hold blocks of their own', () => {
    const blocks = parseBlocks('> quoted line\n> $$E=mc^2$$\n>> deeper\nafter');
    expect(blocks).toEqual([
      { kind: 'quote', blocks: [
        { kind: 'text', text: 'quoted line\n$$E=mc^2$$' },
        { kind: 'quote', blocks: [{ kind: 'text', text: 'deeper' }] },
      ] },
      { kind: 'text', text: 'after' },
    ]);
  });

  it('fenced code keeps its content verbatim (no table or quote inside it)', () => {
    const blocks = parseBlocks('```latex\n> not a quote\n| a | b |\n|---|---|\n```\ntail');
    expect(blocks).toEqual([{ kind: 'code', lang: 'latex', code: '> not a quote\n| a | b |\n|---|---|' }, { kind: 'text', text: 'tail' }]);
    // an unclosed fence runs to the end
    expect(parseBlocks('```\nx\ny')).toEqual([{ kind: 'code', lang: '', code: 'x\ny' }]);
  });

  it('headings and rules', () => {
    expect(parseBlocks('# Title\n### Sub ##\n***\n#notaheading')).toEqual([
      { kind: 'heading', level: 1, text: 'Title' },
      { kind: 'heading', level: 3, text: 'Sub' },
      { kind: 'rule' },
      { kind: 'text', text: '#notaheading' },
    ]);
  });
});

describe('splitRow', () => {
  it('strips the outer pipes, trims cells, unescapes \\|', () => {
    expect(splitRow('| a | b\\|c |')).toEqual(['a', 'b|c']);
    expect(splitRow('a|b')).toEqual(['a', 'b']);
    expect(splitRow('| |')).toEqual(['']);
  });
});
