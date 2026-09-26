/**
 * The editor's fonts (Settings ▸ Editor ▸ Text font and Math font: prefs.editorFont and
 * prefs.editorMathFont; the catalogue is fonts/catalog.ts). The text font becomes CSS variables on
 * <html> — --editor-font for the text, --editor-sans-font / --editor-mono-font for Text Style ▸
 * Family — plus `data-editor-font` (absent for Computer Modern); the text fonts are declared in
 * fonts/web/webfonts.css, and a browser fetches a file only once text on the page uses it. The
 * math font is MathJax's (editor/lyxmath/mathjax.ts setMathFont); --math-scale sizes formulas so
 * that their x-height is 1.1 times the text's. "As in the document" follows the roman font of the
 * open document: both shells report their document's settings with setDocumentFonts
 * (tests/parity.test.ts).
 */
import { getPrefs, subscribePrefs, type Prefs } from '../prefs';
import { editorFace, documentFace, resolvedMathFont, mathScale, FOLLOW_DOCUMENT } from './catalog';
import { setMathFont } from '../editor/lyxmath/mathjax';

let docFace = 'cm';

/** The face shown for a Text font preference, given the open document's closest face. */
export function resolvedFace(pref: string, forDocument = docFace): string {
  return editorFace(pref === FOLLOW_DOCUMENT ? forDocument : pref).id;
}

/** The math font shown for the preferences. */
export function resolvedMath(p: Pick<Prefs, 'editorFont' | 'editorMathFont'> = getPrefs()): string {
  return resolvedMathFont(p.editorMathFont, resolvedFace(p.editorFont)).id;
}

function apply(p: Prefs): void {
  const face = editorFace(resolvedFace(p.editorFont));
  const math = resolvedMathFont(p.editorMathFont, face.id);
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
  const face = documentFace(headerLines);
  if (face === docFace) return;
  docFace = face;
  apply(getPrefs());
}

subscribePrefs(apply);
apply(getPrefs());
