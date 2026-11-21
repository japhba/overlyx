import { describe, expect, it } from 'vitest';
import { findSections, matchesAll, queryTerms } from '../packages/client/src/app/settingssearch';

const SECTIONS = [
  { scope: 'user', id: 'editor', label: 'Editor', words: 'spell checking, autocorrect, Zotero' },
  { scope: 'user', id: 'fonts', label: 'Fonts', words: 'text font, math font, My fonts' },
  { scope: 'device', id: 'drawing', label: 'Drawing & pen', words: 'pen tip, pressure, calibration, scribble to erase' },
  { scope: 'project', id: 'fonts', label: 'Fonts', words: 'text font, math font' },
];

describe('Settings search', () => {
  it('finds sections by name and keywords, every word, any case, accents ignored', () => {
    expect(findSections('pen', SECTIONS).map(s => s.id)).toEqual(['drawing']);
    expect(findSections('ZOTERO', SECTIONS).map(s => s.id)).toEqual(['editor']);
    expect(findSections('math font', SECTIONS).map(s => s.scope)).toEqual(['user', 'project']);
    expect(findSections('calib', SECTIONS).map(s => s.id)).toEqual(['drawing']);
    expect(findSections('fónts my', SECTIONS).map(s => s.scope)).toEqual(['user']);
  });
  it('an empty query finds nothing; a row matches only with every word', () => {
    expect(findSections('  ', SECTIONS)).toEqual([]);
    expect(matchesAll(queryTerms('spell check'), 'Spell checking — misspelt words are underlined')).toBe(true);
    expect(matchesAll(queryTerms('spell zotero'), 'Spell checking')).toBe(false);
    expect(matchesAll([], 'anything')).toBe(false);
  });
});
