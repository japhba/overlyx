// @vitest-environment happy-dom
/**
 * Fonts: the editor's text faces and math fonts (Settings ▸ Editor ▸ Text font / Math font) and the
 * document's font sets (Document ▸ Settings ▸ Fonts) — packages/client/src/fonts. Every font set must
 * name fonts LyX knows (so a .lyx file opens with them in LyX) and load its matching math package in
 * the PDF; every set names an editor face; "As in the document" finds the face closest to a
 * document's roman font. Every text face the catalogue offers is served with the client (fonts/web,
 * scripts/build-editor-fonts.py); every math font is one of MathJax's, bundled with it
 * (editor/lyxmath/mathfonts.ts).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { loadLatexFonts } from '../packages/core/src/latex/latexfonts.ts';
import { parseTex, writeTex } from '../packages/core/src/tex/index.ts';
import { markEditedSettings } from '../packages/core/src/tex/preamble.ts';
import { EDITOR_FACES, MATH_FONTS, DOCUMENT_FONT_SETS, documentFace, matchFontSet, fontSetValues, fontValues, editorFace, mathFont, resolvedMathFont, mathScale, CM_X_HEIGHT } from '../packages/client/src/fonts/catalog.ts';
import { setDocumentFonts, resolvedFace, resolvedMath } from '../packages/client/src/fonts/editorfont.ts';
import { TEXT_X_HEIGHT } from '../packages/client/src/fonts/web/metrics.gen.ts';
import { setPref } from '../packages/client/src/prefs.ts';
import { isMathFont } from '../packages/client/src/editor/lyxmath/mathfonts.ts';
import { currentMathFont } from '../packages/client/src/editor/lyxmath/mathjax.ts';

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

  it('math fonts are MathJax\'s, each bundled with its font data and x-height; former ids get the closest', () => {
    expect(MATH_FONTS.map(m => m.id)).toEqual(['newcm', 'modern', 'tex', 'stix2', 'termes', 'pagella', 'asana', 'bonum', 'schola', 'dejavu', 'euler', 'fira']);
    for (const m of MATH_FONTS) {
      expect(isMathFont(m.id), m.id).toBe(true);
      expect(m.xHeight, m.id).toBeGreaterThan(0.4);
      expect(m.xHeight, m.id).toBeLessThan(0.55);
    }
    // the stand-in faces of the KaTeX days (26 Sep 2026) are gone; a preference naming one gets the nearest
    expect(existsSync(join(WEB, 'math'))).toBe(false);
    expect(WEBFONTS).not.toContain('OLM ');
    expect(mathFont('cm').id).toBe('tex');
    expect(mathFont('libertinus').id).toBe('stix2');
    expect(mathFont('concrete').id).toBe('euler');
    expect(mathFont('fira-text').id).toBe('fira');
    expect(mathFont('nonsense').id).toBe('newcm');
  });

  it('"Matching the text font" is the MathJax font closest in style; formulas are sized to the text\'s x-height', () => {
    expect(resolvedMathFont('match', 'cm').id).toBe('newcm');
    expect(resolvedMathFont('match', 'garamond').id).toBe('pagella');
    expect(resolvedMathFont('match', 'palatino').id).toBe('pagella');
    expect(resolvedMathFont('match', 'termes').id).toBe('termes');
    expect(resolvedMathFont('match', 'concrete').id).toBe('euler');
    expect(resolvedMathFont('euler', 'palatino').id).toBe('euler');
    // the formula's x-height is 1.1 times the text's
    expect(mathScale(editorFace('cm'), mathFont('newcm'))).toBeCloseTo(1.1 * CM_X_HEIGHT / 0.442, 3);
    expect(mathScale(editorFace('garamond'), mathFont('pagella'))).toBeCloseTo(1.1 * TEXT_X_HEIGHT.garamond / 0.482, 3);
  });

  it('the sans-serif is San Francisco where the system has it, SF Compact first on phones; its formulas are Fira Math', () => {
    const sans = editorFace('sans');
    expect(sans.text).toMatch(/^var\(--sf-font\), "OLT fira", sans-serif$/);
    expect(resolvedMathFont('match', 'sans').id).toBe('fira');
    const css = readFileSync(join(__dirname, '../packages/client/src/styles.css'), 'utf8');
    // Apple's keywords for the system font in every engine, and nothing that means another system's UI font
    const sf = css.match(/^ {2}--sf-font: ([^;]+);/m)![1];
    expect(sf).toBe('-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro", "SF Pro Display"');
    const phone = css.match(/@media \(pointer: coarse\) and \(max-width: 700px\)[^{]*\{\s*:root \{ --sf-font: ([^;]+);/)![1];
    expect(phone).toBe('"SF Compact Text", "SF Compact", ' + sf);
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

  it('Computer Modern is built in: no text variables; formulas in New Computer Modern', () => {
    expect(v('--editor-font')).toBe('');
    expect(Number(v('--math-scale'))).toBeCloseTo(mathScale(editorFace('cm'), mathFont('newcm')), 3);
    expect(root().dataset.editorFont).toBeUndefined();
    expect(root().dataset.mathFont).toBe('newcm');
    expect(currentMathFont()).toBe('newcm');
  });

  it('a face sets the text and, matching, the math font; either can be chosen on its own', () => {
    setPref('editorFont', 'libertinus');
    expect(v('--editor-font')).toBe('"OLT libertinus", "CMU Serif", serif');
    expect(v('--editor-sans-font')).toBe('"OLT libertinus sans"');
    expect(Number(v('--math-scale'))).toBeCloseTo(mathScale(editorFace('libertinus'), mathFont('stix2')), 3);
    expect(root().dataset.editorFont).toBe('libertinus');
    expect(root().dataset.mathFont).toBe('stix2');
    expect(currentMathFont()).toBe('stix2');
    // a face without its own sans keeps the default one
    setPref('editorFont', 'stix');
    expect(v('--editor-sans-font')).toBe('');
    // the math font alone
    setPref('editorMathFont', 'euler');
    expect(v('--editor-font')).toContain('OLT stix2');
    expect(resolvedMath()).toBe('euler');
    expect(currentMathFont()).toBe('euler');
    expect(Number(v('--math-scale'))).toBeCloseTo(mathScale(editorFace('stix'), mathFont('euler')), 3);
    setPref('editorFont', 'sans');
    setPref('editorMathFont', 'match');
    expect(root().dataset.mathFont).toBe('fira');
    setPref('editorFont', 'cm');
    expect(root().dataset.editorFont).toBeUndefined();
    expect(root().dataset.mathFont).toBe('newcm');
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
    expect(root().dataset.mathFont).toBe('newcm');
  });
});
