/**
 * Smartphone/Mac-style autocorrect (Tools \u25b8 Autocorrect typos): when a word is finished with a
 * space or punctuation, a minor typo is replaced by the dictionary's suggestion on the spot —
 * local and instant (the same Hunspell worker as the spell checker, no model call). "Minor"
 * means: the top suggestion is one edit away (two for long words, transpositions count as one),
 * keeps the first letter, and is a single word; acronyms, identifiers, code-like insets and
 * verbatim layouts are never touched — and formulas live in the math field, which this plugin
 * never sees. The correction flashes briefly; Backspace right after it puts the typed word back
 * and stops that word from being corrected again this session (Ctrl+Z works too).
 */
import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import { getPrefs } from '../../prefs';
import { spellingOn, spellCheckWord, spellSuggest, isPersonal } from './plugin';
import { NO_SPELL_INSETS, NO_SPELL_LAYOUTS, isProseWord } from './tokenize';

interface Correction { from: number; to: number; original: string; at: number }
interface AcState { deco: DecorationSet; last: Correction | null }
export const autocorrectKey = new PluginKey<AcState>('lyx-autocorrect');

/** Damerau-Levenshtein distance (adjacent transposition counts 1), capped at 3. */
export function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 3;
  const m = a.length, n = b.length;
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return Math.min(3, d[m][n]);
}

function matchCase(typed: string, fix: string): string {
  return /^\p{Lu}/u.test(typed) ? fix.charAt(0).toUpperCase() + fix.slice(1) : fix;
}

/** Common words, to break ties between several dictionary-valid corrections. */
const COMMON = new Set(('the and for are but not you all can was has had his her its one two out who get see now new use how our any they this that with from have been were their there which would could should about into than then them when what where some more also only over such very each because under after before while these those other first may many most made make well will way even must both does say said she him too own same since still through during without against being down just like time work used using'.split(' ')));

/** The adjacent-letter swaps of a word — the most common typo, and the one Hunspell's
 *  suggestions often miss ('teh' suggests 'ten', never 'the'). */
export function swapCandidates(word: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < word.length; i++) {
    if (word[i] === word[i + 1]) continue;
    const c = word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2);
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

/** One adjacent transposition apart (the most common typo: 'teh' → 'the')? */
function isSwap(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i + 1 < a.length; i++) {
    if (a[i] !== b[i]) return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  }
  return false;
}

/** The correction for a freshly typed typo, judged from the dictionary's suggestions — or null.
 *  Ranked, not first-hit: a pure transposition wins, then the smallest edit distance, then the
 *  dictionary's own order (nspell's order is not frequency — 'teh' may list 'ten' before 'the'). */
export function autocorrectFix(word: string, suggestions: string[]): string | null {
  const w = word.toLowerCase();
  let best: { fix: string; score: number } | null = null;
  for (const [i, s] of suggestions.slice(0, 5).entries()) {
    const c = s.toLowerCase();
    if (c === w) continue;
    const firstOk = c[0] === w[0] || (c[0] === w[1] && c[1] === w[0]);   // 'hte' → 'the' still counts
    if (!firstOk) continue;                      // otherwise the first letter must survive (the classic guard)
    if (/[\s-]/.test(s)) continue;              // no splitting into two words or hyphenating
    const dist = editDistance(w, c);
    if (!(dist === 1 || (dist === 2 && w.length >= 6))) continue;
    const score = (isSwap(w, c) ? 0 : 100) + dist * 10 + i;
    if (!best || score < best.score) best = { fix: matchCase(word, s), score };
  }
  return best?.fix ?? null;
}

const SEP = new Set([' ', '.', ',', ';', ':', '!', '?', ')', ']']);
/** words the user put back with Backspace: theirs, for the rest of the session */
const noCorrect = new Set<string>();

function maybeCorrect(view: EditorView, from: number, typed: string): void {
  if (typed.length !== 1 || !SEP.has(typed)) return;
  if (!getPrefs().autoCorrect || !spellingOn()) return;
  const state = view.state;
  if (from < 1 || from > state.doc.content.size) return;
  const $from = state.doc.resolve(from);
  const par = $from.parent;
  if (!par.isTextblock || NO_SPELL_LAYOUTS.has(String(par.attrs.layout))) return;
  for (let d = $from.depth; d > 0; d--) {
    const n = $from.node(d);
    if (n.type.name === 'inset' && NO_SPELL_INSETS.has(String(n.attrs.name))) return;
  }
  const off = $from.parentOffset;
  const before = par.textBetween(Math.max(0, off - 40), off, undefined, '\u0000');
  const m = /([\p{L}\p{M}]+(?:['\u2019][\p{L}\p{M}]+)*)$/u.exec(before);
  if (!m) return;
  const word = m[1];
  const start = from - word.length;
  const prev = before.slice(0, before.length - word.length).slice(-1);
  if (prev && !/[\s\u0000("'\u201c\u2018[]/.test(prev)) return;   // part of a larger token (URL, identifier)
  if (word.length < 3 || !isProseWord(word) || noCorrect.has(word.toLowerCase()) || isPersonal(word)) return;
  void (async () => {
    if (await spellCheckWord(word)) return;
    // swapped letters first, straight against the dictionary; then Hunspell's suggestions
    const swaps = swapCandidates(word.toLowerCase());
    const ok = await Promise.all(swaps.map(c => spellCheckWord(c)));
    const valid = swaps.filter((_, i) => ok[i]);
    const fix = valid.length
      ? matchCase(word, valid.find(c => COMMON.has(c)) ?? valid[0])
      : autocorrectFix(word, await spellSuggest(word));
    if (!fix || fix === word) return;
    // the check ran while the user kept typing: only correct what is still there
    const st = view.state;
    if (start < 0 || from > st.doc.content.size || st.doc.textBetween(start, from) !== word) return;
    const marks = st.doc.nodeAt(start)?.marks ?? [];
    const tr = st.tr.replaceWith(start, from, st.schema.text(fix, marks));
    tr.setMeta(autocorrectKey, { from: start, to: start + fix.length, original: word, at: Date.now() } satisfies Correction);
    view.dispatch(tr);
  })();
}

export function autocorrectPlugin(): Plugin<AcState> {
  return new Plugin<AcState>({
    key: autocorrectKey,
    state: {
      init: () => ({ deco: DecorationSet.empty, last: null }),
      apply(tr, st): AcState {
        const meta = tr.getMeta(autocorrectKey);
        if (meta === 'clear') return { deco: DecorationSet.empty, last: null };
        if (meta) return { deco: DecorationSet.create(tr.doc, [Decoration.inline(meta.from, meta.to, { class: 'ol-autocorrected' })]), last: meta as Correction };
        if (!st.deco.find().length && !st.last) return st;
        return {
          deco: st.deco.map(tr.mapping, tr.doc),
          last: st.last ? { ...st.last, from: tr.mapping.map(st.last.from), to: tr.mapping.map(st.last.to) } : null,
        };
      },
    },
    props: {
      decorations(state) { return autocorrectKey.getState(state)?.deco ?? DecorationSet.empty; },
      handleTextInput(view, from, _to, text) { maybeCorrect(view, from, text); return false; },
      handleKeyDown(view, ev) {
        // Backspace right after a correction: the typed word comes back (and stays)
        if (ev.key !== 'Backspace' || ev.metaKey || ev.ctrlKey || ev.altKey) return false;
        const c = autocorrectKey.getState(view.state)?.last;
        if (!c || Date.now() - c.at > 6000) return false;
        const sel = view.state.selection;
        if (!sel.empty || sel.from !== c.to + 1) return false;   // only directly after the separator
        const st = view.state;
        if (c.from < 0 || c.to > st.doc.content.size) return false;
        noCorrect.add(c.original.toLowerCase());
        const marks = st.doc.nodeAt(c.from)?.marks ?? [];
        view.dispatch(st.tr.replaceWith(c.from, c.to, st.schema.text(c.original, marks)).setMeta(autocorrectKey, 'clear'));
        return true;
      },
    },
  });
}
