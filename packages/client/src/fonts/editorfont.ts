/**
 * The editor's fonts (Settings ▸ Editor ▸ Text font and Math font: prefs.editorFont and
 * prefs.editorMathFont; the catalogue is fonts/catalog.ts). They become CSS variables on <html> —
 * --editor-font for the text, --editor-sans-font / --editor-mono-font for Text Style ▸ Family,
 * --math-scale for the size of formulas, --mf-<face> for the faces of the math font — plus
 * `data-editor-font` (absent for Computer Modern), `data-math-font` (absent for KaTeX's own) and
 * `data-math-letters="text"`, which the formula rules in styles.css look at. The fonts themselves are
 * declared in fonts/web/webfonts.css; a browser fetches a file only once text on the page uses it.
 * "As in the document" follows the roman font of the open document: both shells report their
 * document's settings with setDocumentFonts (tests/parity.test.ts).
 */
import { getPrefs, subscribePrefs, type Prefs } from '../prefs';
import { editorFace, documentFace, resolvedMathFont, mathScale, FOLLOW_DOCUMENT } from './catalog';

let docFace = 'cm';

/** The face shown for a Text font preference, given the open document's closest face. */
export function resolvedFace(pref: string, forDocument = docFace): string {
  return editorFace(pref === FOLLOW_DOCUMENT ? forDocument : pref).id;
}

/** The math font shown for the preferences. */
export function resolvedMath(p: Pick<Prefs, 'editorFont' | 'editorMathFont'> = getPrefs()): string {
  return resolvedMathFont(p.editorMathFont, resolvedFace(p.editorFont)).id;
}

/** the faces of a built math font (scripts/build-editor-fonts.py): variable → family suffix */
const MATH_FACES: [string, string][] = [
  ['main', ''], ['ams', ' AMS'], ['it', ' It'], ['bf', ' Bf'], ['bfit', ' BfIt'], ['cal', ' Cal'], ['frak', ' Frak'], ['bb', ' Bb'],
  ['sf', ' Sf'], ['tt', ' Tt'], ['s1', ' S1'], ['s2', ' S2'], ['s3', ' S3'], ['s4', ' S4'],
];

function apply(p: Prefs): void {
  if (typeof document === 'undefined') return;
  const face = editorFace(resolvedFace(p.editorFont));
  const math = resolvedMathFont(p.editorMathFont, face.id);
  const scale = mathScale(face);
  const root = document.documentElement;
  const vars: [string, string | undefined][] = [
    ['--editor-font', face.id === 'cm' ? undefined : face.text],
    ['--editor-sans-font', face.sans], ['--editor-mono-font', face.mono],
    ['--math-scale', face.id === 'cm' ? undefined : String(scale)],
    ...MATH_FACES.map(([v, suffix]): [string, string | undefined] => [`--mf-${v}`, math.built ? `"OLM ${math.built}${suffix}"` : undefined]),
  ];
  for (const [name, value] of vars) {
    if (value === undefined) root.style.removeProperty(name); else root.style.setProperty(name, value);
  }
  if (face.id !== 'cm') root.dataset.editorFont = face.id; else delete root.dataset.editorFont;
  if (math.built) root.dataset.mathFont = math.id; else delete root.dataset.mathFont;
  if (math.textLetters) root.dataset.mathLetters = 'text'; else delete root.dataset.mathLetters;
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
