/**
 * LaTeX typed into the text of a LaTeX document becomes what it means, as in Overleaf's visual
 * editor: `\textbf{bold}`, `\emph{…}`, `\cite{key}`, `\ref{…}`, `\footnote{…}`, `\href{…}{…}`, a
 * `\section{Title}` alone in its paragraph … once the command is finished — its last `}` typed and
 * the caret gone on (a space, a full stop, Enter, a click elsewhere; a `{` or `[` right after the `}`
 * is its next argument) — and `\LaTeX`, `\today`, `\ldots` … at the space or punctuation after them.
 * The command is parsed on the server against the document's own preamble, as pasted LaTeX is
 * (plugins/paste.ts): what the editor has no picture of becomes a TeX code box, so it reaches the
 * PDF as typed instead of as a printed backslash. Math is only what `$` / `$$` open (commands.ts
 * typeDollar), as in Overleaf: `\alpha` or `\frac{a}{b}` typed in the text stays TeX code as typed,
 * and the build says "Missing $ inserted". `\begin{itemize}` and `\item ` are mdrules.ts'. A command inside the braces of one still open waits for that one;
 * raw TeX, code, markdown documents and HTML articles are left alone. Ctrl+Z gives the typed text back.
 */
import { Plugin, PluginKey, type EditorState } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { Fragment, type Mark, type Node as PMNode, type ResolvedPos } from 'prosemirror-model';
import { schema } from '@overlyx/core';
import { api } from '../../api';
import { viewDocId } from '../context';
import { inRawText } from '../rawtext';

interface Range { from: number; to: number }
interface TypedState {
  /** a command just finished at the caret: converted once the caret leaves it */
  pending: Range | null;
  /** commands being parsed, followed through the edits made meanwhile */
  jobs: Map<object, Range>;
}
interface Meta { pending?: Range | null; add?: { id: object; range: Range }; remove?: object }

const key = new PluginKey<TypedState>('typed-tex');
const PLAIN = new Set(['Standard', 'Plain Layout']);
/** what ends a command without arguments, as mdrules.ts' math symbols */
const AFTER_BARE = /^[\s,.;:!?)\]]/;
/** an inline node's (or an inset's) place in the text: one character per position */
const OBJ = '￼';

/** a backslash before `i` escapes it when there is an odd number of them (`\\` is a line break) */
function escaped(text: string, i: number): boolean {
  let n = 0;
  while (i - n - 1 >= 0 && text[i - n - 1] === '\\') n++;
  return n % 2 === 1;
}

/** the `{` or `[` the bracket at `close` closes (-1: none) */
function opener(text: string, close: number): number {
  if (text[close] === ']') {
    for (let j = close - 1; j >= 0; j--) if (text[j] === '[' && !escaped(text, j)) return j;
    return -1;
  }
  let depth = 0;
  for (let j = close - 1; j >= 0; j--) {
    if (escaped(text, j)) continue;
    if (text[j] === '}') depth++;
    else if (text[j] === '{') { if (!depth) return j; depth--; }
  }
  return -1;
}

/**
 * Where a finished command ends at `end` begins — `\name`, a `*` perhaps, then its `[…]` and
 * `{…}` arguments, the last a `{…}` closed at `end` — or null.
 */
export function commandRunAt(text: string, end: number): number | null {
  if (end < 1 || text[end - 1] !== '}' || escaped(text, end - 1)) return null;
  let i = end;
  while (i > 0 && (text[i - 1] === '}' || text[i - 1] === ']') && !escaped(text, i - 1)) {
    const open = opener(text, i - 1);
    if (open < 0) return null;
    i = open;
  }
  const m = /\\[A-Za-z]+\*?$/.exec(text.slice(0, i));
  if (!m) return null;
  const start = i - m[0].length;
  return escaped(text, start) ? null : start;
}

/** inside the braces of a command still being typed: an unclosed `{` before `start` */
export function insideOpenGroup(text: string, start: number): boolean {
  let depth = 0;
  for (let j = start - 1; j >= 0; j--) {
    if (escaped(text, j)) continue;
    if (text[j] === '}') depth++;
    else if (text[j] === '{') { if (!depth) return true; depth--; }
  }
  return false;
}

/** what is converted: not environments (mdrules.ts has the lists), nothing holding a formula or an inset */
export function convertible(snippet: string): boolean {
  return !snippet.includes(OBJ) && !/^\\(begin|end)\b/.test(snippet);
}

/** the paragraph's text up to `$pos`, one character per position (inline nodes as OBJ) */
function lineBefore($pos: ResolvedPos): string {
  let s = '';
  $pos.parent.forEach((n, offset) => { if (offset < $pos.parentOffset) s += n.isText ? n.text! : OBJ.repeat(n.nodeSize); });
  return s.slice(0, $pos.parentOffset);
}

/** the text of a range inside one paragraph, when it is only text */
function textOf(doc: PMNode, r: Range): string | null {
  if (r.to <= r.from || r.to > doc.content.size) return null;
  const $a = doc.resolve(r.from), $b = doc.resolve(r.to);
  if ($a.parent !== $b.parent || !$a.parent.isTextblock) return null;
  const t = doc.textBetween(r.from, r.to, '', OBJ);
  return t.length === r.to - r.from && !t.includes(OBJ) ? t : null;
}

/** a LaTeX document's text: not markdown, not an HTML article, not raw TeX or code */
function applies(view: EditorView, state: EditorState): boolean {
  return !/\.(md|markdown|html?)$/i.test(viewDocId(view)) && !inRawText(state);
}

/** the command at `r` parsed and put in its place, when nothing changed it meanwhile */
function convert(view: EditorView, r: Range, extra: Meta = {}): void {
  const snippet = textOf(view.state.doc, r);
  const finished = snippet !== null && convertible(snippet) && (commandRunAt(snippet, snippet.length) === 0 || /^\\[A-Za-z]+$/.test(snippet));
  if (!finished) { if (Object.keys(extra).length) view.dispatch(view.state.tr.setMeta(key, extra)); return; }
  const id = {};
  view.dispatch(view.state.tr.setMeta(key, { ...extra, add: { id, range: r } }));
  const drop = () => { if (!view.isDestroyed && key.getState(view.state)?.jobs.has(id)) view.dispatch(view.state.tr.setMeta(key, { remove: id })); };
  void api.parseClip(viewDocId(view), snippet).then(res => {
    if (view.isDestroyed) return;
    const at = key.getState(view.state)?.jobs.get(id);
    const blocks = res.blocks.map(b => schema.nodeFromJSON(b)).filter(n => n.type.name !== 'doc');
    const tr = at && textOf(view.state.doc, at) === snippet && blocks.length === 1 && blocks[0].type === schema.nodes.paragraph ? replacement(view.state, at, blocks[0], snippet) : null;
    if (!tr) { drop(); return; }
    view.dispatch(tr.setMeta(key, { remove: id }));
  }).catch(drop);
}

/** the change that puts the parsed paragraph `b` in place of the command typed at `r` (null: none to make) */
function replacement(state: EditorState, r: Range, b: PMNode, snippet: string) {
  if (!b.content.size) return null;
  const $from = state.doc.resolve(r.from), par = $from.parent;
  if (b.attrs.layout === 'Standard' && !b.attrs.depth) {
    // (the parse gave the text back as it was: nothing to do)
    if (b.childCount === 1 && b.firstChild!.isText && !b.firstChild!.marks.length && b.textContent === snippet) return null;
    // the fonts the command was typed in, under what it sets itself
    const around: readonly Mark[] = (state.doc.nodeAt(r.from)?.marks ?? []).filter(m => m.type !== schema.marks.change);
    const nodes: PMNode[] = [];
    b.content.forEach(n => nodes.push(n.isText ? n.mark(n.marks.reduce((set, m) => m.addToSet(set), around)) : n));
    return state.tr.replaceWith(r.from, r.to, Fragment.from(nodes));
  }
  // a heading (`\section{…}`) and the like: the paragraph that holds nothing but the command takes its layout
  if (par.type !== schema.nodes.paragraph || !PLAIN.has(String(par.attrs.layout)) || r.from !== $from.start() || r.to !== $from.end()) return null;
  return state.tr.replaceWith(r.from, r.to, b.content).setNodeMarkup($from.before(), undefined, { ...par.attrs, layout: b.attrs.layout });
}

export function typedTexPlugin(): Plugin<TypedState> {
  return new Plugin<TypedState>({
    key,
    state: {
      init: () => ({ pending: null, jobs: new Map() }),
      apply(tr, prev) {
        const meta = tr.getMeta(key) as Meta | undefined;
        const map = (r: Range): Range => ({ from: tr.mapping.map(r.from, 1), to: tr.mapping.map(r.to, -1) });
        let pending = prev.pending && tr.docChanged ? map(prev.pending) : prev.pending;
        let jobs = tr.docChanged && prev.jobs.size ? new Map([...prev.jobs].map(([id, r]) => [id, map(r)])) : prev.jobs;
        if (meta && 'pending' in meta) pending = meta.pending ?? null;
        if (meta?.add) { jobs = new Map(jobs); jobs.set(meta.add.id, meta.add.range); }
        if (meta?.remove) { jobs = new Map(jobs); jobs.delete(meta.remove); }
        if (pending && pending.to <= pending.from) pending = null;
        return pending === prev.pending && jobs === prev.jobs ? prev : { pending, jobs };
      },
    },
    props: {
      handleTextInput(view, from, to, text) {
        const { state } = view;
        const $from = state.doc.resolve(from);
        if (from !== to || !$from.parent.isTextblock || !applies(view, state)) return false;
        if (text === '}') {
          // the command's closing brace: typed here, the command waits for the caret to leave it
          const line = lineBefore($from) + '}';
          const at = commandRunAt(line, line.length);
          if (at === null || insideOpenGroup(line, at) || !convertible(line.slice(at))) return false;
          view.dispatch(state.tr.insertText('}', from, to).setMeta(key, { pending: { from: $from.start() + at, to: from + 1 } }));
          return true;
        }
        // a command without arguments, ended by a space or punctuation (the character is typed as usual)
        const before = $from.nodeBefore;
        if (!AFTER_BARE.test(text) || !before?.isText || !before.text!.includes('\\')) return false;
        const m = /\\([A-Za-z]+)$/.exec(before.text!);
        if (!m) return false;
        const line = lineBefore($from), at = line.length - m[0].length;
        if (escaped(line, at) || insideOpenGroup(line, at)) return false;
        const r = { from: from - m[0].length, to: from };
        queueMicrotask(() => { if (!view.isDestroyed) convert(view, r); });
        return false;
      },
    },
    view: () => {
      let queued = false;
      return {
        update(view) {
          if (queued || !key.getState(view.state)?.pending) return;
          // (not from inside the update: the change goes out once this one is through)
          queued = true;
          queueMicrotask(() => {
            queued = false;
            if (view.isDestroyed) return;
            const p = key.getState(view.state)?.pending;
            const { from, to } = view.state.selection;
            if (!p || (from >= p.from && to <= p.to)) return;
            // its next argument begun right after the `}`: the command goes on (its next `}` waits again)
            const next = view.state.doc.textBetween(p.to, Math.min(p.to + 1, view.state.doc.content.size), '', OBJ);
            if (next === '{' || next === '[') { view.dispatch(view.state.tr.setMeta(key, { pending: null })); return; }
            convert(view, p, { pending: null });
          });
        },
      };
    },
  });
}
