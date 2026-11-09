/**
 * A figure's draft: the sketch of it drawn in OverLyX, kept beside the final figure under the same
 * name with `.olx.svg` for its ending — `figures/plot.pdf` (or .png, .svg …, made by a plotting
 * script, say) and `figures/plot.olx.svg`. The `.olx` tells the two apart; the `.svg` lets LaTeX's
 * build, browsers, slides and Inkscape take the draft as the picture it is. A document shows the one
 * it names (`\includegraphics`, an image's src), so switching between them changes the name there,
 * and the PDF follows.
 */

export const DRAFT_ENDING = '.olx.svg';

/** the endings a final figure may have, in the order one is looked for */
export const FINAL_ENDINGS = ['.pdf', '.svg', '.png', '.jpg', '.jpeg', '.eps', '.gif', '.webp'];

/** a ?query or #fragment after a name (an image's src) */
const tail = (name: string): [string, string] => {
  const i = name.search(/[?#]/);
  return i < 0 ? [name, ''] : [name.slice(0, i), name.slice(i)];
};

/** Is this name (a path, a document's file name, an image src) a figure's draft? */
export function isFigureDraft(name: string): boolean {
  return tail(name)[0].toLowerCase().endsWith(DRAFT_ENDING);
}

/** The name without its ending (the draft's `.olx.svg`, a final's `.pdf`): what a draft and its final share. */
export function figureBase(name: string): string {
  const [n] = tail(name);
  if (isFigureDraft(n)) return n.slice(0, -DRAFT_ENDING.length);
  const slash = n.lastIndexOf('/'), dot = n.lastIndexOf('.');
  return dot > slash + 1 ? n.slice(0, dot) : n;
}

/** The draft of the figure `name` (itself when it is one), in the same folder; a src keeps its query. */
export function draftOfFigure(name: string): string {
  const [, rest] = tail(name);
  return figureBase(name) + DRAFT_ENDING + rest;
}

/** The names the final figure of the draft `name` may have, in the order looked for. */
export function finalCandidates(name: string): string[] {
  const [, rest] = tail(name);
  const base = figureBase(name);
  return FINAL_ENDINGS.map(e => base + e + rest);
}

/** The draft's final figure among `files` (a set of paths named alike), else null. */
export function finalOf(name: string, files: { has(path: string): boolean }): string | null {
  return finalCandidates(name).find(c => files.has(c)) ?? null;
}

/**
 * The name a document gives the other version once it switches: `name` as written there (relative to
 * the document, or to a \graphicspath folder — kept that way) with the ending of `target` (the version's
 * file, wherever it was found). A name written without an ending (`\includegraphics{plot}`) keeps none
 * for the final.
 */
export function switchFigureName(name: string, target: string): string {
  const [, rest] = tail(name);
  const base = figureBase(name);
  if (isFigureDraft(target)) return base + DRAFT_ENDING + rest;
  const [t] = tail(target);
  const slash = t.lastIndexOf('/'), dot = t.lastIndexOf('.');
  const ending = dot > slash + 1 ? t.slice(dot) : '';
  const [n] = tail(name);
  // `plot` (graphicx finds the ending) stays `plot` — unless coming back from the draft, which has one
  const bare = !isFigureDraft(n) && figureBase(n) === n;
  return base + (bare ? '' : ending) + rest;
}

/** An empty draft: a canvas of `w`×`h` CSS px (16:9 unless the final figure's shape is known), transparent. */
export function blankDraftSvg(w = 640, h = 360): string {
  const W = Math.max(16, Math.round(w)), H = Math.max(16, Math.round(h));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"></svg>\n`;
}
