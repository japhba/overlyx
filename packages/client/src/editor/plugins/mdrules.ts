/**
 * Google-Docs-style markdown triggers at the start of a paragraph: typing `- ` or `* ` turns a
 * Standard paragraph into a bullet (Itemize), `1. ` / `1) ` into a numbered item (Enumerate),
 * `# `…`###### ` into headings (# = the class's top heading: Chapter where the class has one,
 * Section otherwise), `! `…`!!!!!! ` into matching unnumbered headings. The typed marker
 * disappears; Backspace right after puts it back
 * (prosemirror-inputrules' undoInputRule, bound in keymap.ts). Only Standard / Plain paragraphs
 * change — a heading or a list item already is what it is.
 *
 * Lists typed the LaTeX way: `\begin{itemize}` (enumerate, description) alone in a paragraph makes
 * it the list's first item, `\item ` starts an item (a bullet in ordinary text; nothing more in a
 * list, which already is one), `\end{itemize}` alone in an item leaves the list. Other commands typed
 * in the text are typedtex.ts' (math typed there too: `\alpha `, `\frac{a}{b}` become formulas).
 */
import { InputRule, inputRules } from 'prosemirror-inputrules';
import { inRawText } from '../rawtext';
import type { Plugin } from 'prosemirror-state';
import type { LayoutInfo } from '../../api';
import { editorContext } from '../context';

const PLAIN = new Set(['Standard', 'Plain Layout']);
const HEADINGS = ['Chapter', 'Section', 'Subsection', 'Subsubsection', 'Paragraph', 'Subparagraph'];

/** The heading for repeated # (numbered) or ! (unnumbered), at the same depth in this class. */
export function headingForHashes(level: number, layouts?: LayoutInfo[] | null, unnumbered = false): string | null {
  const known = (n: string) => !layouts || !layouts.length || layouts.some(l => l.name === n);
  // Keep both markers at the same depth even if a class lacks one starred counterpart.
  const ladder = HEADINGS.filter(n => known(n) || known(n + '*'));
  const heading = ladder[level - 1];
  const name = heading && heading + (unnumbered ? '*' : '');
  return name && known(name) ? name : null;
}

function layoutRule(re: RegExp, layoutFor: (m: RegExpMatchArray, layouts?: LayoutInfo[] | null) => string | null): InputRule {
  return new InputRule(re, (state, match, start, end) => {
    const $from = state.selection.$from;
    const par = $from.parent;
    if (par.type.name !== 'paragraph' || start !== $from.start() || !PLAIN.has(String(par.attrs.layout)) || inRawText(state)) return null;
    const layouts = editorContext.meta?.layouts;
    const layout = layoutFor(match, layouts);
    if (!layout || (layouts && layouts.length && !layouts.some(l => l.name === layout))) return null;
    return state.tr.delete(start, end).setNodeMarkup($from.before(), undefined, { ...par.attrs, layout });
  });
}

const LISTS: Record<string, string> = { itemize: 'Itemize', enumerate: 'Enumerate', description: 'Description' };
const LIST_LAYOUTS = new Set(Object.values(LISTS));

/** `\item ` at the start of a paragraph: a bullet in ordinary text, only the item it already is in a list */
const itemRule = new InputRule(/^\\item\s$/, (state, _match, start, end) => {
  const $from = state.selection.$from, par = $from.parent;
  if (par.type.name !== 'paragraph' || start !== $from.start() || inRawText(state)) return null;
  if (LIST_LAYOUTS.has(String(par.attrs.layout))) return state.tr.delete(start, end);
  return PLAIN.has(String(par.attrs.layout)) ? state.tr.delete(start, end).setNodeMarkup($from.before(), undefined, { ...par.attrs, layout: 'Itemize' }) : null;
});

/** `\end{itemize}` alone in a list's item: out of the list (into the one around it, nested) */
const endListRule = new InputRule(/^\\end\{(itemize|enumerate|description)\}$/, (state, _match, start, end) => {
  const $from = state.selection.$from, par = $from.parent;
  if (par.type.name !== 'paragraph' || start !== $from.start() || end !== $from.end() || !LIST_LAYOUTS.has(String(par.attrs.layout)) || inRawText(state)) return null;
  const depth = Number(par.attrs.depth) || 0;
  let layout = 'Standard';
  if (depth > 0) {
    // the item of the list around it: the paragraph before, one level out
    const container = $from.node($from.depth - 1), index = $from.index($from.depth - 1);
    for (let i = index - 1; i >= 0; i--) {
      const b = container.child(i);
      if ((Number(b.attrs.depth) || 0) < depth) { layout = String(b.attrs.layout); break; }
    }
  }
  return state.tr.delete(start, end).setNodeMarkup($from.before(), undefined, { ...par.attrs, layout, depth: Math.max(0, depth - 1) });
});

export function markdownRulesPlugin(): Plugin {
  return inputRules({
    rules: [
      layoutRule(/^[-*]\s$/, () => 'Itemize'),
      layoutRule(/^1[.)]\s$/, () => 'Enumerate'),
      layoutRule(/^(#{1,6})\s$/, (m, layouts) => headingForHashes(m[1].length, layouts)),
      layoutRule(/^(!{1,6})\s$/, (m, layouts) => headingForHashes(m[1].length, layouts, true)),
      layoutRule(/^\\begin\{(itemize|enumerate|description)\}$/, m => LISTS[m[1]]),
      itemRule,
      endListRule,
    ],
  });
}
