import { describe, expect, it } from 'vitest';
import { cleanTexError, cleanTypeset, preambleFacts, typesetReport } from '../packages/core/src/typeset.ts';
import { placeSelection } from '../packages/vscode/src/shared/agentSelection.ts';

describe('typesetting reports (core typeset.ts)', () => {
  it('keeps command names and fixed words, never what the formula said', () => {
    expect(cleanTexError('Missing argument for \\frac')).toBe('Missing argument for \\frac');
    expect(cleanTexError("Unknown environment 'pmatrix*'")).toBe("Unknown environment 'pmatrix*'");
    expect(cleanTexError("'the quick brown fox 42' is not a valid unit")).toBe('… is not a valid unit');
    expect(cleanTypeset({ problem: 'undefined', command: 'not a command' })).toBeNull();
    expect(cleanTypeset({ problem: 'undefined', command: '\\ket', packages: ['physics', '../secret file'], latex: 'x' }))
      .toEqual({ problem: 'undefined', command: '\\ket', packages: ['physics'] });
  });

  it('says how the preamble has the command', () => {
    const pre = '\\usepackage{amsmath,mathtools}\n\\NewDocumentCommand{\\Pfi}{m}{\\Phi_{#1}}\n% \\def\\gone{x}\n\\input{macros}';
    expect(preambleFacts(pre, '\\Pfi')).toEqual({ defined: 'definition', via: '\\NewDocumentCommand', packages: ['amsmath', 'mathtools'], inputs: 1 });
    expect(preambleFacts(pre, '\\gone').defined).toBe('absent');
    expect(preambleFacts('\\global\\def\\R{\\mathbb R}', '\\R')).toMatchObject({ defined: 'definition', via: '\\def' });
    expect(preambleFacts('\\let\\vec\\mathbf\n\\renewcommand{\\vecx}{}', '\\vec')).toMatchObject({ defined: 'definition', via: '\\let' });
    expect(preambleFacts('\\foo{\\bar}', '\\bar').defined).toBe('mentioned');
    const r = typesetReport({ problem: 'undefined', command: '\\Pfi', defined: 'definition', via: '\\NewDocumentCommand', format: 'tex', app: 'vscode' });
    expect(r?.message).toBe('Not typeset: \\Pfi is unknown to the editor · defined in the preamble with \\NewDocumentCommand');
    expect(r?.details).toMatchObject({ format: 'tex', app: 'vscode', via: '\\NewDocumentCommand' });
  });
});

describe('the selection for agents (vscode shared/agentSelection.ts)', () => {
  const text = '\\section{Intro}\nFirst words here.\nA second line of it.\n\n$$x^2$$ and more text.\n';
  const spans = [{ start: 0, end: 15 }, { start: 16, end: 53 }, { start: 55, end: text.length - 1 }];
  const ctx = (before: string, after: string) => ({ before, after, prev: null });

  it('gives the lines of the source the selection is on', () => {
    const p = placeSelection(text, spans, { text: 'second line', blocks: 3, from: { block: 1, ctx: ctx('First words here. A ', 'second line of it.') }, to: { block: 1, ctx: ctx('First words here. A second line', ' of it.') } });
    expect(p).toEqual({ startLine: 3, endLine: 3, source: 'A second line of it.' });
    const two = placeSelection(text, spans, { text: 'here …', blocks: 3, from: { block: 1, ctx: ctx('First words ', 'here. A second line of it.') }, to: { block: 2, ctx: ctx('\u0000 and', ' more text.') } });
    expect([two.startLine, two.endLine]).toEqual([2, 5]);
  });

  it('places a caret, and without a fitting source map by the words alone', () => {
    const caret = placeSelection(text, null, { text: '', blocks: 9, from: { block: 0, ctx: ctx('First words ', 'here. A second line of it.') }, to: { block: 0, ctx: null } });
    expect(caret.startLine).toBe(2);
    expect(caret.endLine).toBe(2);
  });
});
