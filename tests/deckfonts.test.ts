import { expect, it } from 'vitest';
import { blankDeck } from '../packages/core/src/html/deliverable.ts';
import { embeddedFontFamilies, fontPortabilityWarning, fontResource, firstFontFamily, googleFontSpec, myDeckFonts, deckFontFor } from '../packages/client/src/deliverable/deckfonts';
import { deckFontSections, deckFontByName, embeddedDeckFonts, DECK_FONTS } from '../packages/client/src/deliverable/decktoolbar';

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

it('makes a deck font of any Google family: its CSS family with its category\'s generic one, the css2 query of all of it', () => {
  expect(deckFontFor({ f: 'Inter', c: 'Sans Serif', i: true, w: [], a: [{ t: 'wght', min: 100, max: 900 }] }))
    .toEqual({ label: 'Inter', css: 'Inter, sans-serif', google: 'Inter:ital,wght@0,100..900;1,100..900' });
  expect(deckFontFor({ f: 'Source Code Pro', c: 'Monospace', i: false, w: [400, 700], a: [] }).css).toBe('"Source Code Pro", monospace');
  expect(deckFontFor({ f: 'EB Garamond', c: 'Serif', i: true, w: [400], a: [] }).css).toBe('"EB Garamond", serif');
  expect(deckFontFor({ f: 'Caveat', c: 'Handwriting', i: false, w: [400], a: [] }).css).toBe('Caveat, cursive');
  // My fonts are the same fonts, starred
  const mine = myDeckFonts([{ f: 'Inter', c: 'Sans Serif', i: true, w: [], a: [{ t: 'wght', min: 100, max: 900 }] }]);
  expect(mine).toEqual([{ label: '★ Inter', css: 'Inter, sans-serif', google: 'Inter:ital,wght@0,100..900;1,100..900', mine: true }]);
});

it('lists the deck\'s own fonts — Default, then the embedded ones — and takes a family by name as the embedded font when there is one', () => {
  expect(DECK_FONTS[0]).toEqual({ label: 'Default', css: null });
  // every embedded font travels with the HTML (no Google link)
  expect(embeddedDeckFonts().map(f => firstFontFamily(f.css!))).toEqual(['Anodyne', 'Instrument Sans', 'Fira Sans', 'Carlito', 'CMU Sans', 'DejaVu Sans']);
  for (const f of embeddedDeckFonts()) expect(fontResource('<html><head></head></html>', f.css, f.google)).toContain('@font-face');
  const picked: (string | null)[] = [];
  const [lead, embedded] = deckFontSections('Fira Sans', f => picked.push(f.css), { label: 'Default', active: false, pick: () => picked.push(null) });
  expect(lead.lead).toBe(true);
  expect(lead.items.map(it => it.label)).toEqual(['Default']);
  expect(embedded.lead).toBeFalsy();
  // (each with its family, so that Google's same-named family is not listed twice; the one in use marked)
  expect(embedded.items.map(it => it.family)).toEqual(['Anodyne', 'Instrument Sans', 'Fira Sans', 'Carlito', 'CMU Sans', 'DejaVu Sans']);
  expect(embedded.items.filter(it => it.active).map(it => it.label)).toEqual(['Fira Sans']);
  embedded.items[0].pick(); lead.items[0].pick();
  expect(picked).toEqual(['Anodyne, sans-serif', null]);
  // no lead row unless asked for (the theme's text font has no "none")
  expect(deckFontSections('', () => {})).toHaveLength(1);
  // a name: the embedded font first (My fonts' Fira Sans is the bundled one), else Google's, else the name alone
  const fira = { f: 'Fira Sans', c: 'Sans Serif', i: true, w: [400, 700], a: [] };
  expect(deckFontByName('Fira Sans', fira)).toEqual(DECK_FONTS.find(f => f.css === '"Fira Sans", sans-serif'));
  expect(deckFontByName('Lora', { f: 'Lora', c: 'Serif', i: true, w: [400, 700], a: [] }).google).toBe('Lora:ital,wght@0,400;0,700;1,400;1,700');
  expect(deckFontByName('Some Font', null)).toEqual({ label: 'Some Font', css: '"Some Font", sans-serif', google: 'Some Font' });
});



it('embeds Anodyne, the house font, chosen from the bundled list or the font list: never a Google Fonts link', () => {
  const picked = deckFontFor({ f: 'Anodyne', c: 'Sans Serif', a: [{ t: 'wght', min: 100, max: 900 }, { t: 'GRAD', min: -100, max: 150 }], w: [], i: true });
  for (const css of [DECK_FONTS.find(f => f.label.startsWith('Anodyne'))!.css!, picked.css!]) {
    const res = fontResource('<html><head></head><body></body></html>', css, picked.google);
    expect(res).toContain('font-family:"Anodyne";font-weight:100 900');
    expect(res).toMatch(/url\(data:font\/woff2;base64,/);
    expect(res).not.toContain('googleapis');
    expect(fontPortabilityWarning(css, embeddedFontFamilies(`<style>${res.replace(/^[\s\S]*<style>|<\/style>[\s\S]*$/g, '')}</style>`))).toBeNull();
  }
});
