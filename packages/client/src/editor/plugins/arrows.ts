/**
 * Arrows typed as text become arrows (the user, 7 Nov 2026: "make -> and <- always render as a proper
 * arrow, same for --> and <--"): -> →, <- ←, --> ⟶, <-- ⟵, and the double-headed <-> ↔, <--> ⟷ that
 * the same keys make on the way. The typed character goes in as ordinary typing first; the arrow
 * replaces it in a transaction of its own, so Ctrl/⌘+Z (or Backspace right after) gives back what was
 * typed — and that spot is then left as typed: the characters put back never turn into an arrow again
 * (typing "-" after a restored "<-" stays "<--").
 *
 * Formulas type in their own field and never come here; raw TeX (ERT, listings, code paragraphs),
 * code-like insets (code, URL, file name, label) and typewriter (inline code) text stay literal. The
 * .tex writer writes the arrows through LyX's unicodesymbols (\textrightarrow, \textleftarrow,
 * \ensuremath{\longrightarrow} …); markdown and HTML keep the characters.
 */
import { Plugin, PluginKey, type EditorState, type Transaction } from 'prosemirror-state';
import { isHistoryTransaction } from 'prosemirror-history';
import type { EditorView } from 'prosemirror-view';
import { inRawText } from '../rawtext';

/** the text before the caret, ending with the character just typed → the arrow it makes (longest first) */
export const ARROW_RULES: [RegExp, string][] = [
  [/(?:⟵|←-|<--|<–)>$/, '⟷'],
  [/(?:←|<-)>$/, '↔'],
  [/(?:--|–)>$/, '⟶'],
  [/->$/, '→'],
  [/(?:←|<-)-$/, '⟵'],
  [/<-$/, '←'],
];
const ARROWS = new Set(ARROW_RULES.map(([, a]) => a));

/** the arrow the text before the caret makes with `typed` after it, and how many characters (the typed one included) it replaces */
export function arrowFor(before: string, typed: string): { arrow: string; length: number } | null {
  if (typed !== '>' && typed !== '-') return null;
  const s = before + typed;
  for (const [re, arrow] of ARROW_RULES) {
    const m = re.exec(s);
    if (m) return { arrow, length: m[0].length };
  }
  return null;
}

interface Range { from: number; to: number }
/** an arrow made: `prior` the text it replaced (what ⌘Z brings back), `typed` the keys behind it (what Backspace brings back: "<--" for a ⟵ made from ← and -) */
interface Conversion extends Range { prior: string; typed: string; at: number }
interface ArrowState { last: Conversion | null; kept: Range[] }
export const arrowsKey = new PluginKey<ArrowState>('lyx-arrows');

const CODE_INSETS = new Set(['ERT', 'listings', 'Preamble', 'Label', 'Flex Code', 'Flex URL', 'Flex Filename']);

/** where typed characters stay literal */
function literalAt(state: EditorState, pos: number): boolean {
  const $p = state.doc.resolve(pos);
  if (!$p.parent.isTextblock || inRawText(state)) return true;
  for (let d = $p.depth; d > 0; d--) {
    const n = $p.node(d);
    if (n.type.name === 'inset' && (CODE_INSETS.has(String(n.attrs.name)) || CODE_INSETS.has(`${n.attrs.name} ${n.attrs.arg ?? ''}`.trim()))) return true;
  }
  return (state.storedMarks ?? $p.marks()).some(m => m.type.name === 'nospellcheck' || (m.type.name === 'family' && m.attrs.value === 'typewriter'));
}

const overlaps = (a: Range, b: Range) => a.from < b.to && b.from < a.to;

function restore(view: EditorView, c: Conversion): void {
  const st = view.state;
  const marks = st.doc.nodeAt(c.from)?.marks ?? [];
  view.dispatch(st.tr.replaceWith(c.from, c.to, st.schema.text(c.typed, marks)).setMeta(arrowsKey, { kept: { from: c.from, to: c.from + c.typed.length } }));
}

export function arrowsPlugin(): Plugin<ArrowState> {
  return new Plugin<ArrowState>({
    key: arrowsKey,
    state: {
      init: () => ({ last: null, kept: [] }),
      apply(tr: Transaction, st: ArrowState): ArrowState {
        const meta = tr.getMeta(arrowsKey) as { last?: Conversion; kept?: Range } | undefined;
        if (!tr.docChanged && !meta) return st;
        let kept = st.kept.map(r => ({ from: tr.mapping.map(r.from, 1), to: tr.mapping.map(r.to, -1) })).filter(r => r.to > r.from);
        let last = st.last && { ...st.last, from: tr.mapping.map(st.last.from, -1), to: tr.mapping.map(st.last.to, -1) };
        // the conversion undone (⌘Z): its characters are back — they stay as typed
        if (last && isHistoryTransaction(tr)) {
          const end = last.from + last.prior.length;
          if (end <= tr.doc.content.size && tr.doc.textBetween(last.from, end) === last.prior) kept.push({ from: last.from, to: end });
          last = null;
        }
        if (meta?.kept) { kept.push(meta.kept); last = null; }
        if (meta?.last) last = meta.last;
        return { last, kept: kept.slice(-50) };
      },
    },
    props: {
      handleTextInput(view, from, to, text, deflt) {
        if (from !== to || (text !== '>' && text !== '-')) return false;
        const state = view.state;
        if (literalAt(state, from)) return false;
        const $from = state.doc.resolve(from);
        const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 3), $from.parentOffset, undefined, '\ufffc');
        const hit = arrowFor(before, text);
        if (!hit) return false;
        const start = from - (hit.length - 1);
        if (arrowsKey.getState(state)?.kept.some(r => overlaps(r, { from: start, to: from }))) return false;
        // the typed character first, as typing (its own undo step) …
        view.dispatch(deflt());
        const st = view.state;
        const end = from + 1;
        const prior = before.slice(before.length - (hit.length - 1)) + text;
        if (end > st.doc.content.size || st.doc.textBetween(start, end) !== prior) return true;
        // an arrow made from the one just made (← then - is ⟵): Backspace gives back all the keys
        const prev = arrowsKey.getState(st)?.last;
        const typed = prev && prev.from === start && prior.startsWith(st.doc.textBetween(prev.from, prev.to)) ? prev.typed + prior.slice(prev.to - prev.from) : prior;
        // … then the arrow in its own step, which ⌘Z takes back alone
        const marks = st.doc.nodeAt(start)?.marks ?? [];
        const tr = st.tr.replaceWith(start, end, st.schema.text(hit.arrow, marks));
        view.dispatch(tr.setMeta(arrowsKey, { last: { from: start, to: start + hit.arrow.length, prior, typed, at: Date.now() } }));
        return true;
      },
      handleKeyDown(view, ev) {
        // Backspace right after an arrow just made: the typed characters come back (and stay)
        if (ev.key !== 'Backspace' || ev.metaKey || ev.ctrlKey || ev.altKey || ev.shiftKey) return false;
        const c = arrowsKey.getState(view.state)?.last;
        const sel = view.state.selection;
        if (!c || Date.now() - c.at > 10000 || !sel.empty || sel.from !== c.to || c.to > view.state.doc.content.size) return false;
        if (!ARROWS.has(view.state.doc.textBetween(c.from, c.to))) return false;
        restore(view, c);
        return true;
      },
    },
  });
}
