import { useMemo } from 'preact/hooks';
import type { EditorView } from 'prosemirror-view';
import { nodeText } from '../editor/cliptext';
import { Dialog } from './Dialogs';

/** Document ▸ Statistics: words and characters of the selection or the whole document (notes and comments excluded, like LyX's default). */
export function StatsDialog({ view, onClose }: { view: EditorView; onClose: () => void }) {
  const stats = useMemo(() => {
    const sel = view.state.selection;
    const count = (text: string) => ({ words: (text.match(/[\p{L}\p{N}]+(?:[’'\-][\p{L}\p{N}]+)*/gu) ?? []).length, chars: text.replace(/\s/g, '').length, charsSpaces: text.length });
    const textOf = (from: number, to: number) => {
      let out = '';
      view.state.doc.nodesBetween(from, to, (node, pos) => {
        if (node.type.name === 'inset' && /^Note$/.test(node.attrs.name)) return false;   // LyX notes / comments are not counted
        if (node.isText) out += node.text!.slice(Math.max(0, from - pos), Math.max(0, to - pos));
        else if (node.isAtom && node.isInline) out += nodeText(node);
        else if (node.isTextblock) out += '\n';
        return true;
      });
      return out;
    };
    return { selection: sel.empty ? null : count(textOf(sel.from, sel.to)), document: count(textOf(0, view.state.doc.content.size)) };
  }, [view, view.state.doc, view.state.selection]);
  const row = (label: string, c: { words: number; chars: number; charsSpaces: number }) => <tr><td>{label}</td><td>{c.words.toLocaleString()}</td><td>{c.chars.toLocaleString()}</td><td>{c.charsSpaces.toLocaleString()}</td></tr>;
  return <Dialog title="Statistics" onClose={onClose} buttons={<button onClick={onClose}>Close</button>}>
    <table class="stats"><thead><tr><th></th><th>Words</th><th>Characters</th><th>Characters (with spaces)</th></tr></thead>
      <tbody>{stats.selection && row('Selection', stats.selection)}{row('Document', stats.document)}</tbody></table>
    <p class="hint">Formulas count as one word each; LyX notes and comments are not counted.</p>
  </Dialog>;
}

