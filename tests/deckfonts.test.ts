import { expect, it } from 'vitest';
import { blankDeck } from '../packages/core/src/html/deliverable.ts';
import { embeddedFontFamilies, fontPortabilityWarning, fontResource, firstFontFamily, googleFontSpec, myDeckFonts } from '../packages/client/src/deliverable/deckfonts';
import { deckFontList, DECK_FONTS } from '../packages/client/src/deliverable/decktoolbar';

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

it('My fonts link all of a Google font: a variable one\'s whole axes, a static one\'s weights, italics only where they exist', () => {
  // css2 wants lower-case axes first, each part alphabetical; ital as a leading 0/1
  expect(googleFontSpec({ f: 'Roboto Flex', c: 'Sans Serif', i: false, w: [], a: [{ t: 'wght', min: 100, max: 1000 }, { t: 'GRAD', min: -200, max: 150 }, { t: 'opsz', min: 8, max: 144 }, { t: 'XTRA', min: 323, max: 603 }] }))
    .toBe('Roboto Flex:opsz,wght,GRAD,XTRA@8..144,100..1000,-200..150,323..603');
  expect(googleFontSpec({ f: 'Inter', c: 'Sans Serif', i: true, w: [], a: [{ t: 'wght', min: 100, max: 900 }, { t: 'opsz', min: 14, max: 32 }] }))
    .toBe('Inter:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900');
  expect(googleFontSpec({ f: 'Lora', c: 'Serif', i: true, w: [700, 400], a: [] })).toBe('Lora:ital,wght@0,400;0,700;1,400;1,700');
  // one weight, no italics: exactly what it has (css2 refuses a query none of whose styles exist)
  expect(googleFontSpec({ f: 'Bebas Neue', c: 'Display', i: false, w: [400], a: [] })).toBe('Bebas Neue:wght@400');
  const link = fontResource('<html><head></head></html>', '"Bebas Neue", sans-serif', 'Bebas Neue:wght@400');
  expect(link).toContain('css2?family=Bebas+Neue:wght@400&display=swap');
  expect(fontResource(link, '"Bebas Neue", sans-serif', 'Bebas Neue:wght@400')).toBe('');
  // a family whose name starts another's is not taken for it
  expect(fontResource('<link href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400">', 'Inter, sans-serif', 'Inter')).toContain('family=Inter:');
});

it('puts My fonts first in the deck font lists, after Default, without the same family twice', () => {
  const mine = myDeckFonts([{ f: 'Inter', c: 'Sans Serif', i: true, w: [], a: [{ t: 'wght', min: 100, max: 900 }] }, { f: 'Source Code Pro', c: 'Monospace', i: false, w: [400, 700], a: [] }]);
  expect(mine.map(f => f.css)).toEqual(['Inter, sans-serif', '"Source Code Pro", monospace']);
  const list = deckFontList(mine);
  expect(list[0].label).toBe('Default');
  expect(list.slice(1, 3).map(f => f.label)).toEqual(['★ Inter', '★ Source Code Pro']);
  expect(list.filter(f => f.css && firstFontFamily(f.css) === 'Inter')).toHaveLength(1);
  expect(list.length).toBe(DECK_FONTS.length);
  expect(deckFontList()).toEqual(DECK_FONTS);
});

