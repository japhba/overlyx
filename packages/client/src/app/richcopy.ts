/**
 * Plain-text (LaTeX) form of a DOM selection over rendered agent output. The transcript shows
 * formulas through the math editor's KaTeX path; copying that DOM verbatim would yield glyph
 * soup, so the rendered spans carry their source in `data-latex` and a copy handler rebuilds the
 * text with the formulas as `$…$` / `\[…\]` again. The result pastes as a real formula into the
 * editor (the LaTeX paste path), into a formula (the field strips the delimiters), into the
 * composer, or into any .tex file. Returns null when no rendered formula is in the selection —
 * there the browser's own copy is already right.
 */

function mathText(el: Element): string {
  const latex = el.getAttribute('data-latex') ?? '';
  return el.hasAttribute('data-display') ? `\\[\n${latex}\n\\]` : `$${latex}$`;
}

const BLOCK = new Set(['DIV', 'P', 'PRE']);

function nodeText(n: Node): string {
  if (n.nodeType === 3 /* text */) return (n as Text).data;
  if (n.nodeType !== 1 /* element */ && n.nodeType !== 11 /* fragment */) return '';
  const el = n.nodeType === 1 ? (n as Element) : null;
  if (el?.hasAttribute('data-latex')) return mathText(el);
  if (el?.tagName === 'BR') return '\n';
  let s = '';
  n.childNodes.forEach(c => {
    const block = c.nodeType === 1 && BLOCK.has((c as Element).tagName);
    if (block && s && !s.endsWith('\n')) s += '\n';
    s += nodeText(c);
    if (block && s && !s.endsWith('\n')) s += '\n';
  });
  return s;
}

export function latexSelectionText(sel: Selection | null): string | null {
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  let out = '', any = false;
  for (let i = 0; i < sel.rangeCount; i++) {
    const range = sel.getRangeAt(i);
    // a drag inside one formula's own KaTeX DOM: that formula as a whole
    const anc = range.commonAncestorContainer;
    const host = (anc.nodeType === 1 ? (anc as Element) : anc.parentElement)?.closest('[data-latex]');
    if (host) { out += mathText(host); any = true; continue; }
    const frag = range.cloneContents();
    if (frag.querySelector('[data-latex]')) any = true;
    out += nodeText(frag);
  }
  return any ? out.replace(/\n{3,}/g, '\n\n').trim() : null;
}
