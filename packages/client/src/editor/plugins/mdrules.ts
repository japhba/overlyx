/**
 * Google-Docs-style markdown triggers at the start of a paragraph: typing `- ` or `* ` turns a
 * Standard paragraph into a bullet (Itemize), `1. ` / `1) ` into a numbered item (Enumerate),
 * `# `…`###### ` into headings (# = the class's top heading: Chapter where the class has one,
 * Section otherwise). The typed marker disappears; Backspace right after puts it back
 * (prosemirror-inputrules' undoInputRule, bound in keymap.ts). Only Standard / Plain paragraphs
 * change — a heading or a list item already is what it is.
 */
import { InputRule, inputRules } from 'prosemirror-inputrules';
import type { Plugin } from 'prosemirror-state';
import type { LayoutInfo } from '../../api';
import { editorContext } from '../context';

const PLAIN = new Set(['Standard', 'Plain Layout']);
const HEADINGS = ['Chapter', 'Section', 'Subsection', 'Subsubsection', 'Paragraph', 'Subparagraph'];

/** The heading layout for `#` × level in this class (null when the class has none that deep). */
export function headingForHashes(level: number, layouts?: LayoutInfo[] | null): string | null {
  const known = (n: string) => !layouts || !layouts.length || layouts.some(l => l.name === n);
  const ladder = HEADINGS.filter(known);
  return ladder[level - 1] ?? null;
}

function layoutRule(re: RegExp, layoutFor: (m: RegExpMatchArray, layouts?: LayoutInfo[] | null) => string | null): InputRule {
  return new InputRule(re, (state, match, start, end) => {
    const $from = state.selection.$from;
    const par = $from.parent;
    if (par.type.name !== 'paragraph' || start !== $from.start() || !PLAIN.has(String(par.attrs.layout))) return null;
    const layouts = editorContext.meta?.layouts;
    const layout = layoutFor(match, layouts);
    if (!layout || (layouts && layouts.length && !layouts.some(l => l.name === layout))) return null;
    return state.tr.delete(start, end).setNodeMarkup($from.before(), undefined, { ...par.attrs, layout });
  });
}

export function markdownRulesPlugin(): Plugin {
  return inputRules({
    rules: [
      layoutRule(/^[-*]\s$/, () => 'Itemize'),
      layoutRule(/^1[.)]\s$/, () => 'Enumerate'),
      layoutRule(/^(#{1,6})\s$/, (m, layouts) => headingForHashes(m[1].length, layouts)),
    ],
  });
}
