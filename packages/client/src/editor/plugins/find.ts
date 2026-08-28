/** Find & replace over text nodes, with match highlighting. */
import { Plugin, PluginKey, TextSelection } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';

export interface FindState { query: string; caseSensitive: boolean; wholeWord: boolean; matches: { from: number; to: number }[]; current: number }
export const findKey = new PluginKey<FindState>('lyx-find');

const WORD = /[\p{L}\p{N}_]/u;
function search(doc: PMNode, query: string, cs: boolean, wholeWord = false): { from: number; to: number }[] {
  if (!query) return [];
  const out: { from: number; to: number }[] = [];
  const q = cs ? query : query.toLowerCase();
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    // search within the textblock's text (joining text nodes; inline nodes count as one char)
    let text = '';
    const map: number[] = [];
    node.forEach((child, off) => {
      if (child.isText) { for (let i = 0; i < child.text!.length; i++) { map.push(pos + 1 + off + i); text += child.text![i]; } }
      else { map.push(pos + 1 + off); text += '￼'; }
    });
    const hay = cs ? text : text.toLowerCase();
    let idx = hay.indexOf(q);
    while (idx >= 0) {
      const boundary = !wholeWord || ((idx === 0 || !WORD.test(text[idx - 1])) && (idx + q.length >= text.length || !WORD.test(text[idx + q.length])));
      if (boundary) out.push({ from: map[idx], to: map[idx + q.length - 1] + 1 });
      idx = hay.indexOf(q, idx + 1);
    }
    return false;
  });
  return out;
}

export function findPlugin(): Plugin<FindState> {
  return new Plugin<FindState>({
    key: findKey,
    state: {
      init: () => ({ query: '', caseSensitive: false, wholeWord: false, matches: [], current: -1 }),
      apply(tr, prev, _o, newState) {
        const meta = tr.getMeta(findKey) as Partial<FindState> | undefined;
        if (meta) {
          const next = { ...prev, ...meta };
          next.matches = search(newState.doc, next.query, next.caseSensitive, next.wholeWord);
          if (meta.current === undefined) next.current = next.matches.length ? Math.min(prev.current < 0 ? 0 : prev.current, next.matches.length - 1) : -1;
          return next;
        }
        if (tr.docChanged && prev.query) {
          const matches = search(newState.doc, prev.query, prev.caseSensitive, prev.wholeWord);
          return { ...prev, matches, current: matches.length ? Math.min(prev.current, matches.length - 1) : -1 };
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

export function setQuery(view: EditorView, query: string, caseSensitive: boolean, wholeWord = false): void {
  view.dispatch(view.state.tr.setMeta(findKey, { query, caseSensitive, wholeWord }));
}

export function findNext(view: EditorView, dir: 1 | -1 = 1): void {
  const s = findKey.getState(view.state)!;
  if (!s.matches.length) return;
  const cur = (s.current + dir + s.matches.length) % s.matches.length;
  const m = s.matches[cur];
  view.dispatch(view.state.tr.setMeta(findKey, { current: cur }).setSelection(TextSelection.create(view.state.doc, m.from, m.to)).scrollIntoView());
}

export function replaceCurrent(view: EditorView, replacement: string): void {
  const s = findKey.getState(view.state)!;
  if (s.current < 0 || !s.matches[s.current]) return;
  const m = s.matches[s.current];
  view.dispatch(view.state.tr.insertText(replacement, m.from, m.to));
  findNext(view, 1);
}

export function replaceAll(view: EditorView, replacement: string): number {
  const s = findKey.getState(view.state)!;
  let tr = view.state.tr;
  for (const m of [...s.matches].reverse()) tr = tr.insertText(replacement, m.from, m.to);
  const n = s.matches.length;
  if (n) view.dispatch(tr);
  return n;
}
