/**
 * A deck's theme in its stylesheet (packages/client/src/deliverable/decktheme.ts — the theme view's
 * pane): the colours named at :root and the fonts of the text and the headings, read and written in
 * place, nothing else of the file changed.
 */
import { describe, it, expect } from 'vitest';
import { deckTheme, themeSplices, hexOf, type ThemeChange } from '../packages/client/src/deliverable/decktheme.ts';
import { applySplices } from '../packages/core/src/html/source.ts';
import { starterDeck, blankDeck } from '../packages/core/src/html/deliverable.ts';

const page = (css: string, head = '') => `<!doctype html>\n<html>\n<head>\n<meta name="overlyx" content="deck">${head}\n<style>\n${css}\n</style>\n</head>\n<body>\n<section class="slide"><h2>T</h2></section>\n</body>\n</html>\n`;
const change = (text: string, ch: ThemeChange) => applySplices(text, themeSplices(text, ch));

describe('the deck theme', () => {
  it('reads the colours at :root (the last declaration counts; not inside @media; not var() or lengths) and the fonts', () => {
    const t = page(`  /* --old: #000; */
  :root { --ink: #1d2433; --accent: #2f6fde; --gap: 12px; --fg: var(--ink); }
  @media (prefers-color-scheme: dark) { :root { --ink: #eee; } }
  :root { --accent: rgb(10, 20, 30); }
  body { margin: 0; font-family: "Fira Sans", Arial, sans-serif; }
  h1, h2 { font-family: inherit; font-weight: 700; }`);
    const th = deckTheme(t);
    expect(th.colors).toEqual([
      { name: '--ink', value: '#1d2433', hex: '#1d2433' },
      { name: '--accent', value: 'rgb(10, 20, 30)', hex: '#0a141e' },
    ]);
    expect(th.text).toEqual({ value: '"Fira Sans", Arial, sans-serif', family: 'Fira Sans' });
    expect(th.headings).toEqual({ value: null, family: null });
  });
  it('the starters: their colours and fonts', () => {
    const th = deckTheme(starterDeck('Talk'));
    expect(th.colors.map(c => c.name)).toEqual(['--paper', '--ink', '--accent', '--muted', '--secondary']);
    expect(th.text.family).toBe('Fira Sans');
    expect(deckTheme(blankDeck('B')).text.family).toBe('-apple-system');
  });
  it('a colour changed where it is declared, nothing else', () => {
    const t = page(`  :root { --ink: #1d2433; --accent: #2f6fde; }\n  :root { --accent: #ff0000; }`);
    const out = change(t, { color: '--accent', value: '#00aa00' });
    expect(out).toBe(t.replace('--accent: #ff0000', '--accent: #00aa00'));
    expect(themeSplices(out, { color: '--accent', value: '#00aa00' })).toEqual([]);
  });
  it('the text font in every rule that sets it, the Google font linked once', () => {
    const t = page(`  body { margin: 0; font-family: Georgia, serif; }\n  .slide { font-family: Georgia; }`);
    const out = change(t, { font: 'text', value: 'Lora, Georgia, serif', google: 'Lora' });
    expect(out).toContain('body { margin: 0; font-family: Lora, Georgia, serif; }');
    expect(out).toContain('.slide { font-family: Lora, Georgia, serif; }');
    expect(out.match(/family=Lora/g)).toHaveLength(1);
    expect(out.indexOf('family=Lora')).toBeLessThan(out.indexOf('</head>'));
    expect(deckTheme(out).text.family).toBe('Lora');
    expect(change(out, { font: 'text', value: 'Lora, Georgia, serif', google: 'Lora' })).toBe(out);
  });
  it('a font where none is set: added to body’s rule, after a `font` shorthand, or a rule of its own', () => {
    expect(change(page('  body { margin: 0 }'), { font: 'text', value: 'Inter, sans-serif' })).toContain('body { margin: 0; font-family: Inter, sans-serif; }');
    const short = page('  body { font: 18px/1.4 Georgia, serif; }');
    expect(deckTheme(short).text.family).toBe('Georgia');
    expect(change(short, { font: 'text', value: 'Inter' })).toContain('body { font: 18px/1.4 Georgia, serif; font-family: Inter; }');
    const none = change(page('  .notes { display: none; }'), { font: 'text', value: 'Inter' });
    expect(none).toContain('  .notes { display: none; }\n  body { font-family: Inter; }\n</style>');
  });
  it('the headings: their rule, else one of their own; "as the text" puts back inherit', () => {
    const t = page('  body { font-family: Inter; }\n  h1, h2 { font-family: inherit; font-weight: 700; }');
    const out = change(t, { font: 'headings', value: '"Playfair Display", Georgia, serif', google: 'Playfair Display' });
    expect(out).toContain('h1, h2 { font-family: "Playfair Display", Georgia, serif; font-weight: 700; }');
    expect(out).toContain('family=Playfair+Display');
    expect(deckTheme(out).headings.family).toBe('Playfair Display');
    expect(change(out, { font: 'headings', value: null })).toContain('h1, h2 { font-family: inherit; font-weight: 700; }');
    const plain = page('  body { font-family: Inter; }');
    expect(change(plain, { font: 'headings', value: 'Lora' })).toContain('  body { font-family: Inter; }\n  h1, h2, h3, h4, h5, h6 { font-family: Lora; }\n</style>');
    expect(themeSplices(plain, { font: 'headings', value: null })).toEqual([]);
  });
  it('a page without a stylesheet gets one in its head, after the font', () => {
    const t = '<!doctype html>\n<html>\n<head>\n<meta name="overlyx" content="deck">\n</head>\n<body><section class="slide"></section></body>\n</html>\n';
    const out = change(t, { font: 'text', value: 'Inter, sans-serif', google: 'Inter' });
    expect(out).toMatch(/<link href="https:\/\/fonts\.googleapis\.com\/css2\?family=Inter[^>]*>\n<style>\n  body \{ font-family: Inter, sans-serif; \}\n<\/style>\n<\/head>/);
  });
  it('hexOf: what the colour grid can show', () => {
    expect(hexOf('#ABC')).toBe('#aabbcc');
    expect(hexOf('rgba(255, 0, 16, .5)')).toBe('#ff0010');
    expect(hexOf('oklch(0.6 0.1 200)')).toBeNull();
  });
});
