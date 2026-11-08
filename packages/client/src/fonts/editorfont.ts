/**
 * The editor's fonts (Settings ▸ Fonts ▸ Text font and Math font: prefs.editorFont and
 * prefs.editorMathFont; the catalogue is fonts/catalog.ts). The text font becomes CSS variables on
 * <html> — --editor-font for the text, --editor-sans-font / --editor-mono-font for Text Style ▸
 * Family — plus `data-editor-font` (absent for Computer Modern); the text fonts are declared in
 * fonts/web/webfonts.css, and a browser fetches a file only once text on the page uses it. The
 * math font is MathJax's (editor/lyxmath/mathjax.ts setMathFont); --math-scale sizes formulas to
 * the text's size (x-heights matched beside a math font not the face's own). "As in the document"
 * follows the roman font of the open document: both shells report their document's settings with setDocumentFonts
 * (tests/parity.test.ts). A document with a font of its own shows it whatever the text font chosen
 * (`documentSetsFont`: the document is Settings' most specific scope).
 */
import { getPrefs, subscribePrefs, type Prefs } from '../prefs';
import { editorFace, documentFace, faceForFontName, resolvedMathFont, mathScale, mathFont, FOLLOW_DOCUMENT, GOOGLE_FACE } from './catalog';
import { readTexStyles, headerPreamble, FAMILY_FONTS, validFontFamily } from '@overlyx/core';
import { loadGoogleFont } from './googlefont';
import { setMathFont } from '../editor/lyxmath/mathjax';

let docFace = 'cm';
/** the math font a layout document's pages are drawn with (null: the editor's own choice) */
let layoutMath: string | null = null;

/** The face shown for a Text font preference, given the open document's closest face. */
export function resolvedFace(pref: string, forDocument = docFace): string {
  return editorFace(pref === FOLLOW_DOCUMENT ? forDocument : pref).id;
}

/**
 * Does the open document choose a font of its own (anything but LaTeX's Computer Modern)? Then the
 * editor shows it whatever the project's or the person's text font (Settings' scopes: the document
 * is the most specific); those apply to documents that keep LaTeX's.
 */
export const documentSetsFont = () => docFace !== 'cm';
/** the face the editor draws for the text font that applies (prefs.getPrefs: the project's over the person's) */
export const shownFace = (pref: string): string => resolvedFace(documentSetsFont() ? FOLLOW_DOCUMENT : pref);

/** The math font shown for the preferences. */
export function resolvedMath(p: Pick<Prefs, 'editorFont' | 'editorMathFont'> = getPrefs()): string {
  return resolvedMathFont(p.editorMathFont, shownFace(p.editorFont)).id;
}

function apply(p: Prefs): void {
  const face = editorFace(shownFace(p.editorFont));
  if (face.id.startsWith(GOOGLE_FACE)) loadGoogleFont(face.id.slice(GOOGLE_FACE.length));
  const math = layoutMath ? mathFont(layoutMath) : resolvedMathFont(p.editorMathFont, face.id);
  setMathFont(math.id);
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const vars: [string, string | undefined][] = [
    ['--editor-font', face.id === 'cm' ? undefined : face.text],
    ['--editor-sans-font', face.sans], ['--editor-mono-font', face.mono],
    ['--math-scale', String(mathScale(face, math))],
  ];
  for (const [name, value] of vars) {
    if (value === undefined) root.style.removeProperty(name); else root.style.setProperty(name, value);
  }
  if (face.id !== 'cm') root.dataset.editorFont = face.id; else delete root.dataset.editorFont;
  root.dataset.mathFont = math.id;
}

/** The open document's settings (header lines): "As in the document" shows the face closest to its roman font. */
export function setDocumentFonts(headerLines: string[]): void {
  // (a \setmainfont of the preamble's own has the last word in the PDF: core textstyles.ts)
  const tex = readTexStyles(headerPreamble(headerLines)).body?.set.font;
  const face = tex && !FAMILY_FONTS[tex] ? faceForFontName(tex)?.id ?? (validFontFamily(tex) ? GOOGLE_FACE + tex : documentFace(headerLines)) : documentFace(headerLines);
  if (face === docFace) return;
  docFace = face;
  apply(getPrefs());
}

/**
 * A layout document's pages are paper: their formulas are drawn in the font its PDF has — a
 * sans-serif page (beamer's default math, notomath, sfmath) in Fira Math — whatever math font the
 * editor uses for linear documents (editor/layout/controller.ts; null gives the choice back). An
 * HTML deck, poster or page likewise: its formulas are MathJax's New Computer Modern, and LyX's
 * formula editor over one of them must be too (deliverable/DeliverableEditor.tsx).
 */
export function setLayoutMathFont(id: string | null): void {
  if (id === layoutMath) return;
  layoutMath = id;
  apply(getPrefs());
}

subscribePrefs(apply);
apply(getPrefs());
