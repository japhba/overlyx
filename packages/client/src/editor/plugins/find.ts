/**
 * Find & replace over text nodes and math formulas, with match highlighting.
 * Advanced options beyond plain substring search: whole words, regular expressions (with $1
 * capture groups on replace), search inside math (formula `latex`), restrict to the selection.
 */
import { Plugin, PluginKey, TextSelection } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';

/** A text match spans `[from, to)` in the document. A math match spans the whole formula atom
 *  (`[from, from+1)`) — the actual substring lives inside its `latex` at `[latexOffset, latexOffset+latexLen)`. */
export interface FindMatch { from: number; to: number; kind: 'text' | 'math'; latexOffset?: number; latexLen?: number }
export interface FindOptions { query: string; caseSensitive: boolean; wholeWord: boolean; regex: boolean; searchMath: boolean; selectionOnly: boolean }
export interface FindState extends FindOptions { matches: FindMatch[]; current: number; error: string | null; selRange: { from: number; to: number } | null }

export const findKey = new PluginKey<FindState>('lyx-find');

const WORD = /[\p{L}\p{N}_]/u;
const MATH_TYPES = new Set(['math_inline', 'math_display']);

function escapeRegExp(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Builds the search RegExp, or null (with `error` set) when `regex` mode has an invalid pattern. */
function buildRegex(query: string, caseSensitive: boolean, regex: boolean): { re: RegExp | null; error: string | null } {
  if (!query) return { re: null, error: null };
  try {
    return { re: new RegExp(regex ? query : escapeRegExp(query), caseSensitive ? 'g' : 'gi'), error: null };
  } catch (e) {
    return { re: null, error: (e as Error).message };
  }
}

/** All non-overlapping matches of `re` in `text`, filtered to word boundaries when `wholeWord`. */
function matchesInText(text: string, re: RegExp, wholeWord: boolean): { index: number; length: number }[] {
  const out: { index: number; length: number }[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = re.exec(text)) && guard++ < 20000) {
    const len = m[0].length;
    if (len === 0) { re.lastIndex = m.index + 1; continue; }
    const boundary = !wholeWord || ((m.index === 0 || !WORD.test(text[m.index - 1])) && (m.index + len >= text.length || !WORD.test(text[m.index + len])));
    if (boundary) out.push({ index: m.index, length: len });
    re.lastIndex = m.index + len;
  }
  return out;
}

function search(doc: PMNode, o: FindOptions, selRange: { from: number; to: number } | null): { matches: FindMatch[]; error: string | null } {
  const { re, error } = buildRegex(o.query, o.caseSensitive, o.regex);
  if (!re) return { matches: [], error };
  const out: FindMatch[] = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      let text = '';
      const map: number[] = [];
      node.forEach((child, off) => {
        if (child.isText) { for (let i = 0; i < child.text!.length; i++) { map.push(pos + 1 + off + i); text += child.text![i]; } }
        else {
          // an inline atom (formula, inset, …) counts as one placeholder char in the flattened text …
          map.push(pos + 1 + off); text += '￼';
          // … but a formula's own latex is searched separately when "search math" is on
          if (o.searchMath && MATH_TYPES.has(child.type.name)) {
            const latex = String(child.attrs.latex ?? '');
            const childPos = pos + 1 + off;
            for (const hit of matchesInText(latex, re, o.wholeWord)) out.push({ from: childPos, to: childPos + child.nodeSize, kind: 'math', latexOffset: hit.index, latexLen: hit.length });
          }
        }
      });
      for (const hit of matchesInText(text, re, o.wholeWord)) out.push({ from: map[hit.index], to: map[hit.index + hit.length - 1] + 1, kind: 'text' });
      return false;
    }
    if (o.searchMath && MATH_TYPES.has(node.type.name)) {
      const latex = String(node.attrs.latex ?? '');
      for (const hit of matchesInText(latex, re, o.wholeWord)) out.push({ from: pos, to: pos + node.nodeSize, kind: 'math', latexOffset: hit.index, latexLen: hit.length });
      return false;
    }
    return true;
  });
  out.sort((a, b) => a.from - b.from || (a.latexOffset ?? 0) - (b.latexOffset ?? 0));
  const filtered = selRange ? out.filter(m => m.from >= selRange.from && m.to <= selRange.to) : out;
  return { matches: filtered, error: null };
}

const DEFAULT_OPTIONS: FindOptions = { query: '', caseSensitive: false, wholeWord: false, regex: false, searchMath: false, selectionOnly: false };

export function findPlugin(): Plugin<FindState> {
  return new Plugin<FindState>({
    key: findKey,
    state: {
      init: () => ({ ...DEFAULT_OPTIONS, matches: [], current: -1, error: null, selRange: null }),
      apply(tr, prev, oldState, newState) {
        const meta = tr.getMeta(findKey) as (Partial<FindOptions> & { current?: number; useSelection?: boolean }) | undefined;
        if (meta) {
          const next: FindState = { ...prev, ...meta };
          if (meta.useSelection !== undefined) next.selRange = meta.useSelection ? { from: oldState.selection.from, to: oldState.selection.to } : null;
          const { matches, error } = search(newState.doc, next, next.selectionOnly ? next.selRange : null);
          next.matches = matches; next.error = error;
          if (meta.current === undefined) next.current = matches.length ? Math.min(prev.current < 0 ? 0 : prev.current, matches.length - 1) : -1;
          return next;
        }
        if (tr.docChanged && prev.query) {
          const { matches, error } = search(newState.doc, prev, prev.selectionOnly ? prev.selRange : null);
          return { ...prev, matches, error, current: matches.length ? Math.min(prev.current, matches.length - 1) : -1 };
        }
        return prev;
      },
    },
    props: {
      decorations(state) {
        const s = findKey.getState(state);
        if (!s || !s.matches.length) return null;
        return DecorationSet.create(state.doc, s.matches.map((m, i) => Decoration.inline(m.from, m.to, { class: 'find-match' + (i === s.current ? ' current' : '') })));
      },
    },
  });
}

/** Updates the search query/options. `useSelection` (re)captures the selection as the search scope
 *  when `selectionOnly` is turned on; pass it whenever the "in selection" checkbox is toggled on. */
export function setQuery(view: EditorView, opts: Partial<FindOptions> & { useSelection?: boolean }): void {
  view.dispatch(view.state.tr.setMeta(findKey, opts));
}

export function findNext(view: EditorView, dir: 1 | -1 = 1): void {
  const s = findKey.getState(view.state)!;
  if (!s.matches.length) return;
  const cur = (s.current + dir + s.matches.length) % s.matches.length;
  const m = s.matches[cur];
  view.dispatch(view.state.tr.setMeta(findKey, { current: cur }).setSelection(TextSelection.create(view.state.doc, m.from, m.to)).scrollIntoView());
}

/** Applies `replacement` to one match (regex `$1`… back-references already resolved by the caller). */
function applyReplacement(tr: import('prosemirror-state').Transaction, m: FindMatch, replacement: string): import('prosemirror-state').Transaction {
  if (m.kind === 'math') {
    const node = tr.doc.nodeAt(m.from);
    if (!node) return tr;
    const latex = String(node.attrs.latex ?? '');
    const newLatex = latex.slice(0, m.latexOffset) + replacement + latex.slice(m.latexOffset! + m.latexLen!);
    return tr.setNodeMarkup(m.from, undefined, { ...node.attrs, latex: newLatex });
  }
  return tr.insertText(replacement, m.from, m.to);
}

/** Resolves `$1`/`$2`… in `replacement` against the text actually matched (regex mode only). */
function resolveReplacement(view: EditorView, m: FindMatch, replacement: string, s: FindState): string {
  if (!s.regex || !replacement.includes('$')) return replacement;
  const { re } = buildRegex(s.query, s.caseSensitive, true);
  if (!re) return replacement;
  const source = m.kind === 'math' ? String((view.state.doc.nodeAt(m.from)?.attrs.latex ?? '')).slice(m.latexOffset, m.latexOffset! + m.latexLen!) : view.state.doc.textBetween(m.from, m.to, '￼');
  re.lastIndex = 0;
  const match = re.exec(source);
  if (!match) return replacement;
  return replacement.replace(/\$(\$|&|\d+)/g, (_, g) => (g === '$' ? '$' : g === '&' ? match[0] : match[Number(g)] ?? ''));
}

export function replaceCurrent(view: EditorView, replacement: string): void {
  const s = findKey.getState(view.state)!;
  if (s.current < 0 || !s.matches[s.current]) return;
  const m = s.matches[s.current];
  const tr = applyReplacement(view.state.tr, m, resolveReplacement(view, m, replacement, s));
  view.dispatch(tr);
  findNext(view, 1);
}

export function replaceAll(view: EditorView, replacement: string): number {
  const s = findKey.getState(view.state)!;
  if (!s.matches.length) return 0;
  let tr = view.state.tr;
  // group by `from` (several math matches can share one formula node) and walk positions
  // back-to-front so replacing one match never shifts the positions still to be processed
  const byFrom = new Map<number, FindMatch[]>();
  for (const m of s.matches) (byFrom.get(m.from) ?? byFrom.set(m.from, []).get(m.from)!).push(m);
  for (const from of [...byFrom.keys()].sort((a, b) => b - a)) {
    const group = byFrom.get(from)!;
    if (group[0].kind === 'math') {
      const node = tr.doc.nodeAt(from);
      if (!node) continue;
      let latex = String(node.attrs.latex ?? '');
      for (const m of [...group].sort((a, b) => b.latexOffset! - a.latexOffset!)) {
        latex = latex.slice(0, m.latexOffset) + resolveReplacement(view, m, replacement, s) + latex.slice(m.latexOffset! + m.latexLen!);
      }
      tr = tr.setNodeMarkup(from, undefined, { ...node.attrs, latex });
    } else {
      for (const m of group) tr = applyReplacement(tr, m, resolveReplacement(view, m, replacement, s));
    }
  }
  const n = s.matches.length;
  view.dispatch(tr);
  return n;
}
