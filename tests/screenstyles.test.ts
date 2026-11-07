/**
 * One person's editor styles as a tree (core textstyles.ts): heading levels take what they do not set
 * from All headings, which (like every style) takes the font and colour from Normal text where nothing
 * else sets them; the document's own styles come between, and the person's own values win over them.
 */
import { describe, it, expect } from 'vitest';
import { resolveScreenStyles, screenValue, mergeStyles, type ScreenStyles, type TextStyles } from '../packages/core/src/textstyles.ts';

describe('editor styles inherit', () => {
  const screen: ScreenStyles = { headings: { font: 'Anodyne|wdth=80', weight: 650, color: '#1f4e79' }, subsection: { weight: 500 }, body: { color: '#222222' } };
  const pdf: TextStyles = { section: { size: 'huge' }, subsection: { font: 'Fira Sans' }, quote: { shape: 'italic' } };

  it('heading levels take All headings where they set nothing; their own values win', () => {
    const r = resolveScreenStyles(screen);
    expect(r.section).toEqual({ font: 'Anodyne|wdth=80', weight: 650, color: '#1f4e79' });
    expect(r.subsection).toEqual({ font: 'Anodyne|wdth=80', weight: 500, color: '#1f4e79' });
    expect(r.title).toBeUndefined();
    expect(r.body).toEqual({ color: '#222222' });
    expect('headings' in r).toBe(false);
    // over the document's: the editor layer's (own or from All headings) win key by key
    expect(mergeStyles(pdf, r).subsection).toEqual({ font: 'Anodyne|wdth=80', weight: 500, color: '#1f4e79' });
    expect(mergeStyles(pdf, r).section).toEqual({ size: 'huge', font: 'Anodyne|wdth=80', weight: 650, color: '#1f4e79' });
  });

  it('says where each value comes from', () => {
    expect(screenValue(screen, pdf, 'subsection', 'weight')).toEqual({ value: 500, origin: { from: 'own' } });
    expect(screenValue(screen, pdf, 'section', 'weight')).toEqual({ value: 650, origin: { from: 'parent', parent: 'headings' } });
    expect(screenValue(screen, pdf, 'section', 'size')).toEqual({ value: 'huge', origin: { from: 'document' } });
    // the font and colour from Normal text, nothing else
    expect(screenValue(screen, pdf, 'title', 'color')).toEqual({ value: '#222222', origin: { from: 'body', parent: 'body' } });
    expect(screenValue(screen, pdf, 'title', 'weight')).toEqual({ value: undefined, origin: { from: 'default' } });
    expect(screenValue(screen, pdf, 'quote', 'shape')).toEqual({ value: 'italic', origin: { from: 'document' } });
    expect(screenValue({}, pdf, 'headings', 'size')).toEqual({ value: 'huge', origin: { from: 'document' } });
  });
});
