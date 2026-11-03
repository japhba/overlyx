import { expect, it } from 'vitest';
import { blankDeck } from '../packages/core/src/html/deliverable.ts';
import { embeddedFontFamilies, fontPortabilityWarning, fontResource, firstFontFamily } from '../packages/client/src/deliverable/deckfonts';

it('new blank decks carry their default font, including bold, with no font download', () => {
  const html = blankDeck('Example');
  expect(html).toContain('font-family: "Fira Sans", Helvetica, Arial, sans-serif');
  expect(html.includes('font-weight:700;font-style:normal')).toBe(true);
  expect(html).not.toContain('fonts.googleapis.com');
  expect(fontPortabilityWarning('"Fira Sans", sans-serif', embeddedFontFamilies(html))).toBeNull();
  expect(fontResource(html, '"Fira Sans", sans-serif')).toBe('');
});

it('warns for an unavailable primary family even when an embedded fallback exists', () => {
  const embedded = new Set(['example sans']);
  expect(fontPortabilityWarning('"Example Sans", Arial', embedded)).toBeNull();
  const warning = fontPortabilityWarning('Missing, "Example Sans", sans-serif', embedded);
  expect(warning).toContain('Missing is not embedded');
  for (const context of ['editor', 'presenter view', 'render_page', 'PDF']) expect(warning).toContain(context);
  expect(fontPortabilityWarning('inherit', embedded)).toBeNull();
});

it('recognises embedded faces without mistaking a font name, a local face, a comment or a script for an embedded font', () => {
  const face = (family: string, src: string) => `@font-face{font-family:'${family}';src:${src}}`;
  const html = `<html><head><style>
    body { font-family: Named; }
    ${face('Example Sans', 'url("data:font/woff2;base64,AAAA")')}
    ${face('Local', 'local("Local")')}
    ${face('Remote', 'url(https://example.invalid/font.woff2)')}
    /* ${face('Comment', 'url(data:font/woff2;base64,AAAA)')} */
    </style><script>const css = "${face('Script', 'url(data:font/woff2;base64,AAAA)')}";</script></head></html>`;
  expect([...embeddedFontFamilies(html)]).toEqual(['example sans']);
  expect(firstFontFamily('"Example, Sans", serif')).toBe('Example, Sans');
});

it('supplies bundled choices in a portable style block and keeps existing web font links', () => {
  for (const family of ['Fira Sans', 'Carlito', 'CMU Sans']) {
    const resource = fontResource('<html><head></head></html>', `"${family}", sans-serif`);
    expect(embeddedFontFamilies(`<html><head>${resource}</head></html>`).has(family.toLowerCase())).toBe(true);
    expect(resource).toContain('SIL OPEN FONT LICENSE');
  }
  const resource = fontResource('', 'Lora, serif', 'Lora');
  expect(resource).toContain('fonts.googleapis.com/css2?family=Lora');
  expect(fontResource(resource, 'Lora, serif', 'Lora')).toBe('');
});
