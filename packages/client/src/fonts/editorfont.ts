/**
 * The editor's typeface (Settings ▸ Editor ▸ Font, prefs.editorFont; the catalogue is fonts/catalog.ts).
 * A face becomes CSS variables on <html> — --editor-font for the text, --editor-sans-font /
 * --editor-mono-font for Text Style ▸ Family, --math-font / --math-italic-font / --math-scale for the
 * formulas — plus `data-editor-font` (absent for the built-in Computer Modern), which is what the
 * formula rules in styles.css look at. A web font's Google Fonts stylesheet is linked only once it is
 * chosen. "As in the document" follows the roman font of the open document: both shells report
 * their document's settings with setDocumentFonts (tests/parity.test.ts).
 */
import { getPrefs, subscribePrefs, type Prefs } from '../prefs';
import { editorFace, documentFace, googleFontsUrl, FOLLOW_DOCUMENT } from './catalog';

const LINK_ID = 'ol-editor-fonts';
let docFace = 'cm';

/** The face shown for a preference, given the open document's closest face. */
export function resolvedFace(pref: string, forDocument = docFace): string {
  return editorFace(pref === FOLLOW_DOCUMENT ? forDocument : pref).id;
}

function apply(p: Prefs): void {
  if (typeof document === 'undefined') return;
  const face = editorFace(resolvedFace(p.editorFont));
  const root = document.documentElement;
  const vars: [string, string | undefined][] = [
    ['--editor-font', face.id === 'cm' ? undefined : face.text],
    ['--editor-sans-font', face.sans], ['--editor-mono-font', face.mono],
    ['--math-font', face.math], ['--math-italic-font', face.mathItalic],
    ['--math-scale', face.mathScale === undefined ? undefined : String(face.mathScale)],
  ];
  for (const [name, value] of vars) {
    if (value === undefined) root.style.removeProperty(name); else root.style.setProperty(name, value);
  }
  if (face.math) root.dataset.editorFont = face.id; else delete root.dataset.editorFont;
  const url = googleFontsUrl(face);
  let link = document.getElementById(LINK_ID) as HTMLLinkElement | null;
  if (!url) { link?.remove(); return; }
  if (!link) {
    link = document.createElement('link');
    link.id = LINK_ID;
    link.rel = 'stylesheet';
    document.head.appendChild(link);
  }
  if (link.getAttribute('href') !== url) link.href = url;
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
