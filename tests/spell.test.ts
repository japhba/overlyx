/**
 * The spell checker's tokenizer (packages/client/src/editor/spell/tokenize.ts): which words of a
 * document are checked — prose only, not formulas, commands, code insets, acronyms, LyX's
 * "no spellcheck" text — and the dictionary chosen for a LyX language name.
 */
import { describe, it, expect } from 'vitest';
import { schema } from '../packages/core/src/index.ts';
import { wordsOf, checkableBlocks, isProseWord } from '../packages/client/src/editor/spell/tokenize.ts';
import { dictionaryFor } from '../packages/client/src/editor/spell/plugin.ts';

const t = (s: string, marks: any[] = []) => schema.text(s, marks);
const par = (content: any[], layout = 'Standard') => schema.nodes.paragraph.create({ layout, depth: 0 }, content);

describe('wordsOf', () => {
  it('finds prose words with document positions, skipping formulas and commands', () => {
    const p = par([t('The Lyapunov exponent '), schema.nodes.math_inline.create({ latex: '\\lambda', delim: '$' }), t(" isn't zero, see "), schema.nodes.command.create({ cmd: 'citation', params: '["LatexCommand cite","key \\"sompolinsky1988chaos\\""]' }), t('.')]);
    const doc = schema.nodes.doc.create(null, [p]);
    const words = wordsOf(doc.child(0), 0).map(w => [w.word, doc.textBetween(w.from, w.to)]);
    expect(words).toEqual([['The', 'The'], ['Lyapunov', 'Lyapunov'], ['exponent', 'exponent'], ["isn't", "isn't"], ['zero', 'zero'], ['see', 'see']]);
  });
  it('leaves out acronyms, identifiers, single letters, typewriter and no-spellcheck text', () => {
    expect(isProseWord('RNN')).toBe(false);
    expect(isProseWord('RNNs')).toBe(false);
    expect(isProseWord('camelCase')).toBe(false);
    expect(isProseWord('a')).toBe(false);
    expect(isProseWord('Networks')).toBe(true);
    expect(isProseWord('Straße')).toBe(true);
    const p = par([t('plain '), t('code_name', [schema.marks.family.create({ value: 'typewriter' })]), t(' '), t('LyXword', [schema.marks.nospellcheck.create({ value: 'true' })])]);
    expect(wordsOf(p, 0).map(w => w.word)).toEqual(['plain']);
  });
  it('checks nothing in code layouts', () => {
    expect(wordsOf(par([t('int main')], 'LyX-Code'), 0)).toEqual([]);
  });
});

describe('checkableBlocks', () => {
  it('walks paragraphs, note insets and table cells, but not ERT / listings', () => {
    const ert = schema.nodes.inset.create({ name: 'ERT', arg: '', params: '[]', status: 'open' }, [par([t('\\raw{latex}')], 'Plain Layout')]);
    const note = schema.nodes.inset.create({ name: 'Note', arg: 'Note', params: '[]', status: 'open' }, [par([t('note text')], 'Plain Layout')]);
    const doc = schema.nodes.doc.create(null, [par([t('first '), ert, t(' after')]), par([t('second '), note])]);
    const blocks = checkableBlocks(doc);
    const texts = blocks.map(b => b.node.textContent);
    expect(texts).toContain('first \\raw{latex} after');   // the outer paragraph (wordsOf reads only its own text nodes)
    expect(texts).toContain('note text');
    expect(texts).not.toContain('\\raw{latex}');            // the ERT's inner paragraph is not a block to check
    for (const b of blocks) expect(doc.nodeAt(b.pos)).toBe(b.node);
  });
});

describe('dictionaryFor', () => {
  it('maps LyX language names', () => {
    expect(dictionaryFor('english')).toBe('en');
    expect(dictionaryFor('british')).toBe('en-gb');
    expect(dictionaryFor('ngerman')).toBe('de');
    expect(dictionaryFor('french')).toBe('fr');
    expect(dictionaryFor(undefined)).toBe('en');
    expect(dictionaryFor('polish')).toBe('en');
  });
});
