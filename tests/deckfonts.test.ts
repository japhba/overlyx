import { expect, it } from 'vitest';
import { blankDeck } from '../packages/core/src/html/deliverable.ts';
import { embeddedFontFamilies, fontPortabilityWarning, fontResource, firstFontFamily } from '../packages/client/src/deliverable/deckfonts';

it('new blank decks carry their default font, Instrument Sans, with its weight and width axes and no font download', () => {
  const html = blankDeck('Example');
  expect(html).toContain('font-family: "Instrument Sans", sans-serif');
  expect(html).toContain('font-family:"Instrument Sans";font-weight:400 700;font-style:normal;font-stretch:75% 100%');
  expect(html).toContain('font-family:"Instrument Sans";font-weight:400 700;font-style:italic;font-stretch:75% 100%');
  expect(html).not.toContain('fonts.googleapis.com');
  expect(fontPortabilityWarning('"Instrument Sans", sans-serif', embeddedFontFamilies(html))).toBeNull();
  expect(fontResource(html, '"Instrument Sans", sans-serif')).toBe('');
});

it('bundles DejaVu Sans in all four faces, with its Bitstream Vera and Arev licences', () => {
  const resource = fontResource('<html><head></head></html>', '"DejaVu Sans", sans-serif');
  for (const face of ['font-weight:400;font-style:normal', 'font-weight:700;font-style:normal', 'font-weight:400;font-style:italic', 'font-weight:700;font-style:italic'])
    expect(resource).toContain(`font-family:"DejaVu Sans";${face}`);
  expect(resource).toContain('Bitstream Vera Fonts Copyright');
  expect(resource).toContain('Arev Fonts Copyright');
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
  for (const family of ['Instrument Sans', 'Fira Sans', 'Carlito', 'CMU Sans', 'DejaVu Sans']) {
    const resource = fontResource('<html><head></head></html>', `"${family}", sans-serif`);
    expect(embeddedFontFamilies(`<html><head>${resource}</head></html>`).has(family.toLowerCase())).toBe(true);
    expect(resource).toContain('SIL OPEN FONT LICENSE');
  }
  const resource = fontResource('', 'Lora, serif', 'Lora');
  expect(resource).toContain('fonts.googleapis.com/css2?family=Lora');
  expect(fontResource(resource, 'Lora, serif', 'Lora')).toBe('');
});
