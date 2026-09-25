// @vitest-environment happy-dom
/**
 * Fonts: the editor's faces (Settings ▸ Editor ▸ Font) and the document's font sets (Document ▸
 * Settings ▸ Fonts) — packages/client/src/fonts. Every font set must name fonts LyX knows (so a .lyx
 * file opens with them in LyX) and load its matching math package in the PDF; every set names an
 * editor face; "As in the document" finds the face closest to a document's roman font.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { loadLatexFonts } from '../packages/core/src/latex/latexfonts.ts';
import { parseTex, writeTex } from '../packages/core/src/tex/index.ts';
import { markEditedSettings } from '../packages/core/src/tex/preamble.ts';
import { EDITOR_FACES, DOCUMENT_FONT_SETS, documentFace, matchFontSet, fontSetValues, fontValues, googleFontsUrl, editorFace } from '../packages/client/src/fonts/catalog.ts';
import { setDocumentFonts, resolvedFace } from '../packages/client/src/fonts/editorfont.ts';
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

describe('editor faces', () => {
  it('each load from Google Fonts unless built in, and draw formulas with a math font', () => {
    expect(editorFace('cm').google).toBeUndefined();
    expect(googleFontsUrl(editorFace('cm'))).toBe('');
    for (const f of EDITOR_FACES.filter(x => x.id !== 'cm')) {
      expect(f.math, f.id).toBeTruthy();
      expect(f.mathItalic, f.id).toBeTruthy();
      expect(googleFontsUrl(f), f.id).toMatch(/^https:\/\/fonts\.googleapis\.com\/css2\?family=[^ ]+&display=swap$/);
    }
    expect(googleFontsUrl(editorFace('libertinus'))).toContain('family=Libertinus+Serif:ital,wght@0,400;0,700;1,400;1,700&family=Libertinus+Sans');
    expect(editorFace('nonsense').id).toBe('cm');
  });

  it('the sans-serif is San Francisco where the system has it, SF Compact first on phones, with the bundled Fira Math', () => {
    const sans = editorFace('sans');
    expect(sans.text).toMatch(/^var\(--sf-font\), "Fira Sans", sans-serif$/);
    expect(sans.math).toMatch(/^var\(--sf-font\), "Fira Sans", "Fira Math"$/);
    expect(sans.mathItalic).toMatch(/^var\(--sf-font\), "Fira Sans"$/);
    // Fira Math is not on Google Fonts: bundled, and never asked of Google
    expect(googleFontsUrl(sans)).toContain('family=Fira+Sans:ital');
    expect(googleFontsUrl(sans)).not.toContain('Math');
    const css = readFileSync(join(__dirname, '../packages/client/src/styles.css'), 'utf8');
    expect(css).toContain("@import './fonts/fira-math/fonts.css';");
    expect(readFileSync(join(__dirname, '../packages/client/src/fonts/fira-math/fonts.css'), 'utf8')).toMatch(/font-family: "Fira Math"; src: url\("\.\/FiraMath-Regular\.otf"\)/);
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
    expect(documentFace(['\\font_roman "tgpagella" "default"'])).toBe('palatino');
    expect(documentFace(['\\font_roman "xcharter" "default"'])).toBe('charis');
    expect(documentFace(['\\font_roman "IBMPlexSerif" "default"'])).toBe('cm');
    // with non-TeX fonts the system font name counts
    expect(documentFace(['\\font_roman "default" "TeX Gyre Termes"', '\\use_non_tex_fonts true'])).toBe('stix');
    expect(documentFace(['\\font_roman "palatino" "TeX Gyre Termes"'])).toBe('palatino');
  });
});

describe('applying the editor font', () => {
  const root = () => document.documentElement;
  const link = () => document.getElementById('ol-editor-fonts') as HTMLLinkElement | null;
  // the stylesheet links are checked, not fetched
  (window as unknown as { happyDOM: { settings: { disableCSSFileLoading: boolean } } }).happyDOM.settings.disableCSSFileLoading = true;
  beforeEach(() => { setPref('editorFont', 'cm'); setDocumentFonts([]); });

  it('Computer Modern is built in: no variables, no stylesheet', () => {
    expect(root().style.getPropertyValue('--editor-font')).toBe('');
    expect(root().dataset.editorFont).toBeUndefined();
    expect(link()).toBeNull();
  });

  it('a web font sets the text and formula fonts and links its stylesheet', () => {
    setPref('editorFont', 'libertinus');
    expect(root().style.getPropertyValue('--editor-font')).toContain('Libertinus Serif');
    expect(root().style.getPropertyValue('--math-font')).toContain('Libertinus Math');
    expect(root().style.getPropertyValue('--editor-sans-font')).toContain('Libertinus Sans');
    expect(root().dataset.editorFont).toBe('libertinus');
    expect(link()?.href).toContain('fonts.googleapis.com/css2?family=Libertinus+Serif');
    // a face without its own sans keeps the default one
    setPref('editorFont', 'stix');
    expect(root().style.getPropertyValue('--editor-sans-font')).toBe('');
    expect(link()?.href).toContain('family=STIX+Two+Text');
    setPref('editorFont', 'cm');
    expect(link()).toBeNull();
    expect(root().dataset.editorFont).toBeUndefined();
  });

  it('"As in the document" follows the document shown', () => {
    setPref('editorFont', 'document');
    expect(root().dataset.editorFont).toBeUndefined();
    setDocumentFonts(['\\font_roman "CrimsonPro" "default"', '\\font_math "cochineal-ntxm" "auto"']);
    expect(resolvedFace('document')).toBe('crimson');
    expect(root().dataset.editorFont).toBe('crimson');
    setDocumentFonts(['\\font_roman "default" "default"']);
    expect(root().dataset.editorFont).toBeUndefined();
  });
});
