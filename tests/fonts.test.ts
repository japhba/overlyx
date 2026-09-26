// @vitest-environment happy-dom
/**
 * Fonts: the editor's text faces and math fonts (Settings ▸ Editor ▸ Text font / Math font) and the
 * document's font sets (Document ▸ Settings ▸ Fonts) — packages/client/src/fonts. Every font set must
 * name fonts LyX knows (so a .lyx file opens with them in LyX) and load its matching math package in
 * the PDF; every set names an editor face; "As in the document" finds the face closest to a
 * document's roman font. Every face and math font the catalogue offers is served with the client
 * (fonts/web, scripts/build-editor-fonts.py), with every face KaTeX's fonts need.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { loadLatexFonts } from '../packages/core/src/latex/latexfonts.ts';
import { parseTex, writeTex } from '../packages/core/src/tex/index.ts';
import { markEditedSettings } from '../packages/core/src/tex/preamble.ts';
import { EDITOR_FACES, MATH_FONTS, DOCUMENT_FONT_SETS, documentFace, matchFontSet, fontSetValues, fontValues, editorFace, mathFont, resolvedMathFont, mathScale, CM_X_HEIGHT } from '../packages/client/src/fonts/catalog.ts';
import { setDocumentFonts, resolvedFace, resolvedMath } from '../packages/client/src/fonts/editorfont.ts';
import { MATH_FACES, TEXT_X_HEIGHT } from '../packages/client/src/fonts/web/metrics.gen.ts';
import { setPref } from '../packages/client/src/prefs.ts';

const FONTS = loadLatexFonts(join(__dirname, '../lyx/lib/latexfonts'));
const SAMPLE = '\\documentclass{article}\n\\usepackage{amsmath}\n\\usepackage{amssymb}\n\\begin{document}\nText $\\alpha + \\sum_i x_i^2$.\n\\end{document}\n';

/** The managed block of a .tex document saved with a font set chosen in Document ▸ Settings. */
function managedWith(id: string): string {
  const set = DOCUMENT_FONT_SETS.find(s => s.id === id)!;
  const { doc } = parseTex(SAMPLE);
  const before = [...doc.header.lines];
  const get = (k: string) => doc.header.lines.find(l => l.startsWith('\\' + k + ' '))?.slice(k.length + 2) ?? '';
  const values = fontSetValues(set, { font_roman: get('font_roman'), font_sans: get('font_sans'), font_typewriter: get('font_typewriter'), font_math: get('font_math'), font_sf_scale: get('font_sf_scale') });
  for (const [k, v] of Object.entries(values)) {
    const i = doc.header.lines.findIndex(l => l.startsWith('\\' + k + ' '));
    if (i >= 0) doc.header.lines[i] = `\\${k} ${v}`; else doc.header.lines.push(`\\${k} ${v}`);
  }
  doc.header.lines = markEditedSettings(before, doc.header.lines, Object.keys(values));
  const text = writeTex(doc, { basename: 'x' }).text;
  return text.slice(text.indexOf('%% OverLyX'), text.indexOf('%% end OverLyX'));
}

describe('document font sets', () => {
  it('name fonts of lib/latexfonts in the right family, and editor faces that exist', () => {
    for (const s of DOCUMENT_FONT_SETS) {
      for (const [name, family] of [[s.roman, 'rm'], [s.sans, 'sf'], [s.typewriter, 'tt'], [s.math, 'math']] as const) {
        if (name === 'default' || name === 'auto') continue;
        expect(FONTS.get(name), `${s.id}: ${name}`).toBeDefined();
        expect(FONTS.get(name)!.family, `${s.id}: ${name}`).toBe(family);
      }
      expect(EDITOR_FACES.some(f => f.id === s.face), s.id).toBe(true);
    }
  });

  it('load the text font with its own math font in the PDF', () => {
    const expected: Record<string, RegExp[]> = {
      cm: [],
      lmodern: [/\\usepackage\{lmodern\}/],
      libertinus: [/\\usepackage\{libertinus\}/, /\\usepackage\{libertinust1math\}/],
      times: [/\\renewcommand\{\\rmdefault\}\{ptm\}/, /\\usepackage\[scaled=0\.92\]\{helvet\}/, /\\usepackage\{courier\}/, /\\usepackage\{newtxmath\}/],
      palatino: [/\\usepackage\{mathpazo\}/],
      charter: [/\\usepackage\[charter\]\{mathdesign\}/],
      utopia: [/\\usepackage\{fourier\}/],
      crimson: [/\\usepackage\[lf\]\{CrimsonPro\}/, /\\usepackage\[cochineal\]\{newtxmath\}/],
    };
    expect(Object.keys(expected).sort()).toEqual(DOCUMENT_FONT_SETS.map(s => s.id).sort());
    for (const [id, res] of Object.entries(expected)) {
      const block = managedWith(id);
      for (const re of res) expect(block, id).toMatch(re);
      if (id === 'cm') expect(block, id).not.toMatch(/\\usepackage(\[[^\]]*\])?\{(lmodern|libertinus|mathpazo|newtxmath|fourier|mathdesign)\}/);
    }
  });

  it('are recognised in the dialog and keep the non-TeX names', () => {
    const current = { font_roman: '"default" "Libertinus Serif"', font_sans: '"default" "default"', font_typewriter: '"default" "default"', font_math: '"auto" "auto"', font_sf_scale: '100 100' };
    expect(matchFontSet(current)?.id).toBe('cm');
    const times = fontSetValues(DOCUMENT_FONT_SETS.find(s => s.id === 'times')!, current);
    expect(times).toEqual({ font_roman: '"times" "Libertinus Serif"', font_sans: '"helvet" "default"', font_typewriter: '"courier" "default"', font_math: '"newtxmath" "auto"', font_sf_scale: '92 100' });
    expect(matchFontSet(times)?.id).toBe('times');
    expect(matchFontSet({ ...times, font_math: '"auto" "auto"' })).toBeUndefined();
    // a header without the keys is LaTeX's default
    expect(matchFontSet({ font_roman: '', font_sans: '', font_typewriter: '', font_math: '' })?.id).toBe('cm');
    expect(fontValues('"libertinus" "Libertinus Serif"')).toEqual(['libertinus', 'Libertinus Serif']);
    expect(fontValues('92 100')).toEqual(['92', '100']);
  });
});

const WEB = join(__dirname, '../packages/client/src/fonts/web');
const WEBFONTS = readFileSync(join(WEB, 'webfonts.css'), 'utf8');
/** the @font-face rules of a family: [url, descriptors] */
function faces(family: string): string[] {
  return [...WEBFONTS.matchAll(/@font-face \{ font-family: "([^"]+)"; src: url\("\.\/([^"]+)"\)[^}]*\}/g)].filter(m => m[1] === family).map(m => m[2]);
}

describe('editor faces', () => {
  it('are served with the client unless built in or the computer’s own, each with its x-height and a math font that exists', () => {
    for (const f of EDITOR_FACES) {
      expect(MATH_FONTS.some(m => m.id === f.math), f.id).toBe(true);
      expect(f.xHeight, f.id).toBeGreaterThan(0.35);
      expect(f.xHeight, f.id).toBeLessThan(0.6);
      for (const family of [f.text, f.sans, f.mono].filter(Boolean).flatMap(v => [...v!.matchAll(/"(OLT [^"]+)"/g)].map(m => m[1]))) {
        const urls = faces(family);
        expect(urls.length, `${f.id}: ${family}`).toBeGreaterThan(0);
        for (const u of urls) expect(existsSync(join(WEB, u)), u).toBe(true);
      }
    }
    // the four styles of a text face, the Latin part for every one
    for (const style of ['regular', 'italic', 'bold', 'bolditalic']) expect(faces('OLT stix2')).toContain(`text/stix2/text-${style}-latin.woff2`);
    expect(WEBFONTS).toMatch(/"OLT stix2"; src: url\("\.\/text\/stix2\/text-italic-latin\.woff2"\) format\("woff2"\); font-style: italic; font-weight: 400;/);
    expect(editorFace('stix').xHeight).toBe(TEXT_X_HEIGHT.stix2);
    expect(editorFace('nonsense').id).toBe('cm');
    // no third-party font service any more
    const css = readFileSync(join(__dirname, '../packages/client/src/styles.css'), 'utf8');
    expect(css + WEBFONTS).not.toMatch(/googleapis|gstatic/);
    expect(css).toContain("@import './fonts/web/webfonts.css';");
  });

  it('math fonts are built with every face KaTeX\'s fonts need', () => {
    const built = MATH_FONTS.filter(m => m.built);
    expect(built.length).toBeGreaterThanOrEqual(30);
    for (const m of built) {
      const got = MATH_FACES[m.built!];
      expect(got, m.id).toBeDefined();
      for (const face of ['main', 'it', 'bf', 'bfit', 'cal', 'bb', 'size1', 'size2']) expect(got, `${m.id}: ${face}`).toContain(face);
      for (const face of got) {
        const suffix = { main: '', it: ' It', bf: ' Bf', bfit: ' BfIt', cal: ' Cal', frak: ' Frak', bb: ' Bb', sf: ' Sf', tt: ' Tt', size1: ' S1', size2: ' S2', size3: ' S3', size4: ' S4' }[face];
        expect(faces(`OLM ${m.built}${suffix}`), `${m.id}: ${face}`).toEqual([`math/${m.built}/${face}.woff2`]);
        expect(existsSync(join(WEB, `math/${m.built}/${face}.woff2`))).toBe(true);
      }
      // the AMS family: the same file, without the ASCII letters (\Bbbk is a "k" in KaTeX_AMS)
      expect(WEBFONTS).toContain(`@font-face { font-family: "OLM ${m.built} AMS"; src: url("./math/${m.built}/main.woff2") format("woff2"); font-display: swap; unicode-range: U+00A0-10FFFF; }`);
    }
    // italic and bold faces are declared with the style KaTeX's CSS asks for, so nothing is synthesised
    expect(WEBFONTS).toMatch(/"OLM stix2 It"; src: url\("\.\/math\/stix2\/it\.woff2"\) format\("woff2"\); font-style: italic; font-weight: 400;/);
    expect(WEBFONTS).toMatch(/"OLM stix2 BfIt"; [^}]*font-style: italic; font-weight: 700;/);
    expect(WEBFONTS).toMatch(/"OLM stix2 Bf"; [^}]*font-style: normal; font-weight: 700;/);
    expect(mathFont('nonsense').id).toBe('cm');
  });

  it('"Matching the text font" is the face\'s own math font; formulas are sized to the face\'s x-height', () => {
    expect(resolvedMathFont('match', 'cm').id).toBe('cm');
    expect(resolvedMathFont('match', 'garamond').id).toBe('garamond');
    expect(resolvedMathFont('match', 'palatino').id).toBe('pagella');
    expect(resolvedMathFont('euler', 'palatino').id).toBe('euler');
    expect(mathScale(editorFace('cm'))).toBe(1.1);
    expect(mathScale(editorFace('garamond'))).toBeCloseTo(1.1 * TEXT_X_HEIGHT.garamond / CM_X_HEIGHT, 3);
  });

  it('the sans-serif is San Francisco where the system has it, SF Compact first on phones; its formulas take their letters from it, the rest from Fira Math', () => {
    const sans = editorFace('sans');
    expect(sans.text).toMatch(/^var\(--sf-font\), "OLT fira", sans-serif$/);
    expect(resolvedMathFont('match', 'sans')).toMatchObject({ id: 'fira-text', built: 'fira', textLetters: true });
    const css = readFileSync(join(__dirname, '../packages/client/src/styles.css'), 'utf8');
    // Apple's keywords for the system font in every engine, and nothing that means another system's UI font
    const sf = css.match(/^ {2}--sf-font: ([^;]+);/m)![1];
    expect(sf).toBe('-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro", "SF Pro Display"');
    const phone = css.match(/@media \(pointer: coarse\) and \(max-width: 700px\)[^{]*\{\s*:root \{ --sf-font: ([^;]+);/)![1];
    expect(phone).toBe('"SF Compact Text", "SF Compact", ' + sf);
    expect(css).toMatch(/html\[data-math-letters="text"\] \.lyx-editor \.katex :is\(\.mathnormal, \.mathit, \.mathbf, \.boldsymbol\) \{ font-family: var\(--editor-font\); font-size-adjust: 0\.4306; \}/);
    // the face that was called Noto Sans
    expect(editorFace('noto').id).toBe('sans');
    expect(resolvedFace('noto')).toBe('sans');
  });

  it('"As in the document" is the face closest to the roman font', () => {
    expect(documentFace([])).toBe('cm');
    expect(documentFace(['\\font_roman "libertinus" "default"'])).toBe('libertinus');
    expect(documentFace(['\\font_roman "tgpagella" "default"'])).toBe('pagella');
    expect(documentFace(['\\font_roman "xcharter" "default"'])).toBe('xcharter');
    expect(documentFace(['\\font_roman "IBMPlexSerif" "default"'])).toBe('plex');
    expect(documentFace(['\\font_roman "kpfonts" "default"'])).toBe('kp');
    expect(documentFace(['\\font_roman "unknownfont" "default"'])).toBe('cm');
    // with non-TeX fonts the system font name counts
    expect(documentFace(['\\font_roman "default" "TeX Gyre Termes"', '\\use_non_tex_fonts true'])).toBe('termes');
    expect(documentFace(['\\font_roman "palatino" "TeX Gyre Termes"'])).toBe('pagella');
  });
});

describe('applying the editor font', () => {
  const root = () => document.documentElement;
  const v = (name: string) => root().style.getPropertyValue(name);
  beforeEach(() => { setPref('editorFont', 'cm'); setPref('editorMathFont', 'match'); setDocumentFonts([]); });

  it('Computer Modern is built in: no variables', () => {
    expect(v('--editor-font')).toBe('');
    expect(v('--mf-main')).toBe('');
    expect(v('--math-scale')).toBe('');
    expect(root().dataset.editorFont).toBeUndefined();
    expect(root().dataset.mathFont).toBeUndefined();
  });

  it('a face sets the text and, matching, the formula faces; either can be chosen on its own', () => {
    setPref('editorFont', 'libertinus');
    expect(v('--editor-font')).toBe('"OLT libertinus", "CMU Serif", serif');
    expect(v('--editor-sans-font')).toBe('"OLT libertinus sans"');
    expect(v('--mf-main')).toBe('"OLM libertinus"');
    expect(v('--mf-it')).toBe('"OLM libertinus It"');
    expect(v('--mf-s2')).toBe('"OLM libertinus S2"');
    expect(v('--mf-ams')).toBe('"OLM libertinus AMS"');
    expect(Number(v('--math-scale'))).toBeCloseTo(mathScale(editorFace('libertinus')), 3);
    expect(root().dataset.editorFont).toBe('libertinus');
    expect(root().dataset.mathFont).toBe('libertinus');
    // a face without its own sans keeps the default one
    setPref('editorFont', 'stix');
    expect(v('--editor-sans-font')).toBe('');
    expect(v('--mf-main')).toBe('"OLM stix2"');
    // the math font alone
    setPref('editorMathFont', 'euler');
    expect(v('--editor-font')).toContain('OLT stix2');
    expect(v('--mf-it')).toBe('"OLM euler It"');
    expect(resolvedMath()).toBe('euler');
    // KaTeX's own Computer Modern beside another text face
    setPref('editorMathFont', 'cm');
    expect(v('--mf-main')).toBe('');
    expect(root().dataset.mathFont).toBeUndefined();
    expect(root().dataset.editorFont).toBe('stix');
    setPref('editorFont', 'sans');
    setPref('editorMathFont', 'match');
    expect(root().dataset.mathFont).toBe('fira-text');
    expect(root().dataset.mathLetters).toBe('text');
    expect(v('--mf-main')).toBe('"OLM fira"');
    setPref('editorFont', 'cm');
    expect(root().dataset.mathLetters).toBeUndefined();
    expect(root().dataset.editorFont).toBeUndefined();
  });

  it('"As in the document" follows the document shown', () => {
    setPref('editorFont', 'document');
    expect(root().dataset.editorFont).toBeUndefined();
    setDocumentFonts(['\\font_roman "CrimsonPro" "default"', '\\font_math "cochineal-ntxm" "auto"']);
    expect(resolvedFace('document')).toBe('crimson');
    expect(root().dataset.editorFont).toBe('crimson');
    expect(root().dataset.mathFont).toBe(editorFace('crimson').math);
    setDocumentFonts(['\\font_roman "default" "default"']);
    expect(root().dataset.editorFont).toBeUndefined();
    expect(root().dataset.mathFont).toBeUndefined();
  });
});
