/** Slides keep each inline formula intact; prose pages can wrap formulas between terms. */
export function inlineMathBreaks(doc: Document = document): boolean {
  const setting = doc.querySelector('meta[name="overlyx-math-inline-breaks" i]')?.getAttribute('content')?.trim().toLowerCase();
  if (setting === 'on' || setting === 'off') return setting === 'on';
  const kind = doc.querySelector('meta[name="overlyx" i]')?.getAttribute('content')?.trim().toLowerCase().split(/[\s;,]/)[0];
  if (kind === 'deck' || kind === 'slides') return false;
  if (kind === 'page' || kind === 'webpage' || kind === 'poster') return true;
  return doc.querySelectorAll('.slide').length <= 1;
}
