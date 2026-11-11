/**
 * LaTeX typed into the text of a LaTeX document becomes what it means, as in Overleaf's visual
 * editor: `\textbf{bold}`, `\emph{…}`, `\cite{key}`, `\ref{…}`, `\footnote{…}`, `\href{…}{…}`,
 * `\includegraphics{…}`, `\caption{…}`, a `\section{Title}` alone in its paragraph … once the command
 * is finished — its last `}` typed and the caret gone on (a space, a full stop, Enter, a click
 * elsewhere; a `{` or `[` right after the `}` is its next argument) — and `\LaTeX`, `\today`,
 * `\ldots` … at the space, punctuation or Enter after them. Those are parsed on the server against
 * the document's own preamble, as pasted LaTeX is (plugins/paste.ts): what the editor has no picture
 * of becomes a TeX code box, so it reaches the PDF as typed instead of as a printed backslash.
 *
 * Math typed in the text is a formula, at once: `\alpha `, `\frac{a}{b}`, `\mathbb{R}` — LaTeX itself
 * has no other meaning for them there ("Missing $ inserted"); `$` / `$$` open one to type into
 * (commands.ts typeDollar). Environments alone in their paragraph: `\begin{equation}` (align, gather,
 * multline …) opens a display formula of that kind, `\begin{figure}` / `{table}` a float to type its
 * `\includegraphics`, `\caption` and `\label` into (`\end{figure}` leaves it), `\begin{theorem}` and
 * every other environment of the class its paragraph style (`\end{theorem}` back to ordinary text);
 * the lists are mdrules.ts'. Esc right after a conversion — or Ctrl+Z — gives the typed text back.
 *
 * A command inside the braces of one still open waits for that one; raw TeX, code, markdown
 * documents and HTML articles are left alone.
 */
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import type { Step } from 'prosemirror-transform';
import { Fragment, type Mark, type Node as PMNode, type ResolvedPos } from 'prosemirror-model';
import { schema, SYMBOLS } from '@overlyx/core';
import { api } from '../../api';
import { editorContext, viewDocId } from '../context';
import { inRawText } from '../rawtext';

interface Range { from: number; to: number }
/** the last conversion, taken back by Esc while nothing changed since and the caret is where it left it */
interface Revert { steps: Step[]; caret: number }
interface TypedState {
  /** a command just finished at the caret: converted once the caret leaves it */
  pending: Range | null;
  /** commands being parsed, followed through the edits made meanwhile */
  jobs: Map<object, Range>;
  last: Revert | null;
}
interface Meta { pending?: Range | null; add?: { id: object; range: Range }; remove?: object; last?: Revert | null }

/** what the editor does for the plugin (assembly.ts: commands.ts, which needs a window) */
export interface TypedTexHooks {
  /** a display formula of environment `env` opened at the caret, to be typed into */
  displayMath?(view: EditorView, env: string): boolean;
}

const key = new PluginKey<TypedState>('typed-tex');
const PLAIN = new Set(['Standard', 'Plain Layout']);
/** what ends a command without arguments */
const AFTER_BARE = /^[\s,.;:!?)\]]/;
/** an inline node's (or an inset's) place in the text: one character per position */
const OBJ = String.fromCharCode(0xfffc);

/* ------------------------------------------------------------------ what is math */

/** commands of formulas with arguments that the symbol table does not list */
const MATH_STRUCTURE = new Set(['frac', 'dfrac', 'tfrac', 'cfrac', 'nicefrac', 'unitfrac', 'binom', 'dbinom', 'tbinom', 'sqrt', 'stackrel', 'boldsymbol', 'bm', 'cancel', 'bcancel', 'xcancel', 'cancelto', 'boxed', 'phantom', 'vphantom', 'hphantom', 'mathclap', 'mathllap', 'mathrlap', 'substack', 'pmb', 'xrightarrow', 'xleftarrow', 'xRightarrow', 'xLeftarrow', 'xleftrightarrow', 'xmapsto']);
/** the symbol table's kinds that belong to formulas */
const MATH_KINDS = new Set(['sym', 'macro', 'decoration', 'big', 'matrix', 'split', 'style', 'class', 'underset', 'overset', 'dots', 'font', 'oldfont']);
/** …and of them what LaTeX takes in the text as well (core's .tex reader knows them there) */
const TEXT_TOO = new Set(['underline', 'uline', 'uuline', 'uwave', 'dots', 'ldots', 'bf', 'it', 'rm', 'tt', 'slash', 'astrosun', 'dag', 'ddag', 'CheckedBox', 'LEFTcircle', 'RIGHTcircle']);
/** symbols without arguments: a formula at the space after them */
const BARE_KINDS = new Set(['sym', 'macro', 'dots']);

/** a command that means something only in a formula (`\alpha`, `\frac`, `\mathbb`, `\hat` …) */
export function isMathCommand(name: string): boolean {
  if (MATH_STRUCTURE.has(name)) return true;
  const s = SYMBOLS[name];
  if (!s || !MATH_KINDS.has(s.i) || TEXT_TOO.has(name)) return false;
  if (s.i === 'font') return s.x === 'mathmode';
  return s.c !== 'x' && s.c !== 'textmode';
}
const isMathSymbol = (name: string) => isMathCommand(name) && BARE_KINDS.has(SYMBOLS[name]?.i ?? '');

const MATH_ENVS = new Set(['equation', 'align', 'gather', 'multline', 'flalign', 'eqnarray']);
const FLOATS = new Set(['figure', 'table', 'algorithm']);

/** the class's paragraph style written as environment `name` (theorem → Theorem, quote → Quote …) */
function layoutOfEnvironment(name: string): string | null {
  return editorContext.meta?.layouts?.find(l => l.latexName === name && /environment/i.test(l.latexType ?? ''))?.name ?? null;
}

/* ------------------------------------------------------------------ reading the typed text */

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

/** what is converted: not environments (environment() has them), nothing holding a formula or an inset */
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

/** a command without arguments right before `$pos` (not escaped, not inside an open argument): its range */
function bareBefore($pos: ResolvedPos): (Range & { name: string }) | null {
  const before = $pos.nodeBefore;
  if (!before?.isText || !before.text!.includes('\\')) return null;
  const m = /\\([A-Za-z]+)$/.exec(before.text!);
  if (!m) return null;
  const line = lineBefore($pos), at = line.length - m[0].length;
  if (escaped(line, at) || insideOpenGroup(line, at)) return null;
  return { from: $pos.pos - m[0].length, to: $pos.pos, name: m[1] };
}

/* ------------------------------------------------------------------ converting */

/** the fonts at `pos`, which what replaces the typed command keeps (not a tracked change: that is the plugin's) */
function fontsAt(state: EditorState, pos: number): readonly Mark[] {
  return (state.doc.nodeAt(pos)?.marks ?? []).filter(m => m.type !== schema.marks.change);
}

function formula(latex: string, fonts: readonly Mark[]): PMNode {
  return schema.nodes.math_inline.create({ latex, delim: '$', ...(fonts.length ? { marks: JSON.stringify(fonts.map(m => m.toJSON())) } : {}) });
}

/** a conversion sent: its steps from `fromStep` on are what Esc takes back */
function dispatchConversion(view: EditorView, tr: Transaction, fromStep = 0): void {
  const steps = tr.steps.slice(fromStep).map((s, i) => s.invert(tr.docs[fromStep + i])).reverse();
  tr.setMeta(key, { ...(tr.getMeta(key) as Meta | undefined), last: { steps, caret: tr.selection.head } });
  view.dispatch(tr);
}

/** the command at `r` put in its place, when nothing changed it meanwhile: a formula here, anything else parsed by the server */
function convert(view: EditorView, r: Range, extra: Meta = {}): void {
  const snippet = textOf(view.state.doc, r);
  const bare = snippet !== null && /^\\[A-Za-z]+$/.test(snippet);
  const finished = snippet !== null && convertible(snippet) && (bare || commandRunAt(snippet, snippet.length) === 0);
  if (!finished) { if (Object.keys(extra).length) view.dispatch(view.state.tr.setMeta(key, extra)); return; }
  const name = /^\\([A-Za-z]+)/.exec(snippet)![1];
  if (bare ? isMathSymbol(name) : isMathCommand(name)) {
    const tr = view.state.tr.replaceWith(r.from, r.to, formula(snippet, fontsAt(view.state, r.from)));
    dispatchConversion(view, Object.keys(extra).length ? tr.setMeta(key, extra) : tr);
    return;
  }
  const id = {};
  view.dispatch(view.state.tr.setMeta(key, { ...extra, add: { id, range: r } }));
  const drop = () => { if (!view.isDestroyed && key.getState(view.state)?.jobs.has(id)) view.dispatch(view.state.tr.setMeta(key, { remove: id })); };
  void api.parseClip(viewDocId(view), snippet).then(res => {
    if (view.isDestroyed) return;
    const at = key.getState(view.state)?.jobs.get(id);
    const blocks = res.blocks.map(b => schema.nodeFromJSON(b)).filter(n => n.type.name !== 'doc');
    const tr = at && textOf(view.state.doc, at) === snippet && blocks.length === 1 && blocks[0].type === schema.nodes.paragraph ? replacement(view.state, at, blocks[0], snippet) : null;
    if (!tr) { drop(); return; }
    dispatchConversion(view, tr.setMeta(key, { remove: id }));
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
    const around = fontsAt(state, r.from);
    const nodes: PMNode[] = [];
    b.content.forEach(n => nodes.push(n.isText ? n.mark(n.marks.reduce((set, m) => m.addToSet(set), around)) : n));
    return state.tr.replaceWith(r.from, r.to, Fragment.from(nodes));
  }
  // a heading (`\section{…}`) and the like: the paragraph that holds nothing but the command takes its layout
  if (par.type !== schema.nodes.paragraph || !PLAIN.has(String(par.attrs.layout)) || r.from !== $from.start() || r.to !== $from.end()) return null;
  return state.tr.replaceWith(r.from, r.to, b.content).setNodeMarkup($from.before(), undefined, { ...par.attrs, layout: b.attrs.layout });
}

/**
 * `\begin{name}` / `\end{name}` typed alone in its paragraph (the `}` about to be typed at `$from`):
 * a display formula, a float, a paragraph style — or out of a float or a style again. False: not one.
 */
function environment(view: EditorView, $from: ResolvedPos, begin: boolean, name: string, hooks: TypedTexHooks): boolean {
  const { state } = view;
  const start = $from.start(), end = $from.pos, par = $from.parent;
  const base = name.replace(/\*$/, '');
  if (begin) {
    if (MATH_ENVS.has(base)) {
      if (!hooks.displayMath) return false;
      view.dispatch(state.tr.delete(start, end));
      return hooks.displayMath(view, name);
    }
    if (FLOATS.has(base)) {
      // the float's content, centred (`\centering` is written for it), the caret there: \includegraphics, \caption, \label typed in turn
      const body = schema.nodes.paragraph.create({ layout: 'Plain Layout', align: 'center' });
      const float = schema.nodes.inset.create({ name: 'Float', arg: base, params: JSON.stringify(['placement document', 'alignment document', `wide ${name.endsWith('*')}`, 'sideways false']), status: 'open' }, body);
      const tr = state.tr.replaceWith(start, end, float);
      view.dispatch(tr.setSelection(TextSelection.create(tr.doc, start + 2)).scrollIntoView());
      return true;
    }
    const layout = layoutOfEnvironment(name);
    if (!layout || par.type !== schema.nodes.paragraph || !PLAIN.has(String(par.attrs.layout))) return false;
    view.dispatch(state.tr.delete(start, end).setNodeMarkup($from.before(), undefined, { ...par.attrs, layout }));
    return true;
  }
  // \end{figure} in a figure: out of it, the caret after it (in a paragraph of its own when the float ends its paragraph)
  for (let d = $from.depth - 1; d > 0; d--) {
    const n = $from.node(d);
    if (n.type !== schema.nodes.inset || n.attrs.name !== 'Float' || n.attrs.arg !== base) continue;
    const tr = state.tr.delete(start, end);
    // the paragraph it was typed in (nothing else in it) goes, unless it is all the float has
    if (n.childCount > 1 && $from.depth === d + 1) tr.delete(tr.mapping.map($from.before()), tr.mapping.map($from.after()));
    let after = tr.mapping.map($from.after(d));
    const $after = tr.doc.resolve(after);
    if ($after.parent.isTextblock && $after.parentOffset === $after.parent.content.size) {
      tr.split(after);
      after += 2;
      tr.setNodeMarkup(after - 1, undefined, { ...tr.doc.nodeAt(after - 1)!.attrs, layout: 'Standard', align: null });
    }
    view.dispatch(tr.setSelection(TextSelection.create(tr.doc, after)).scrollIntoView());
    return true;
  }
  // \end{theorem} in a Theorem paragraph: ordinary text again
  if (par.type !== schema.nodes.paragraph || layoutOfEnvironment(name) !== par.attrs.layout) return false;
  view.dispatch(state.tr.delete(start, end).setNodeMarkup($from.before(), undefined, { ...par.attrs, layout: 'Standard' }));
  return true;
}

/** a command without arguments that ends here (typed space or punctuation `typed`, or Enter): a formula or `\centering` at once, the rest parsed */
function convertBare(view: EditorView, r: Range & { name: string }, typed: string): boolean {
  const { state } = view;
  if (isMathSymbol(r.name)) {
    // the character first: Esc takes back the formula, not what was typed after it
    const tr = state.tr.insertText(typed, r.to, r.to);
    tr.replaceWith(r.from, r.to, formula('\\' + r.name, fontsAt(state, r.from)));
    dispatchConversion(view, tr, typed ? 1 : 0);
    return true;
  }
  const $from = state.doc.resolve(r.from), par = $from.parent;
  if (r.name === 'centering' && par.type === schema.nodes.paragraph) {
    // (the space after a command is no text)
    const tr = /\S/.test(typed) ? state.tr.insertText(typed, r.to, r.to) : state.tr;
    const n = tr.steps.length;
    tr.delete(r.from, r.to).setNodeMarkup($from.before(), undefined, { ...par.attrs, align: 'center' });
    dispatchConversion(view, tr, n);
    return true;
  }
  queueMicrotask(() => { if (!view.isDestroyed) convert(view, r); });
  return false;
}

export function typedTexPlugin(hooks: TypedTexHooks = {}): Plugin<TypedState> {
  return new Plugin<TypedState>({
    key,
    state: {
      init: () => ({ pending: null, jobs: new Map(), last: null }),
      apply(tr, prev) {
        const meta = tr.getMeta(key) as Meta | undefined;
        const map = (r: Range): Range => ({ from: tr.mapping.map(r.from, 1), to: tr.mapping.map(r.to, -1) });
        let pending = prev.pending && tr.docChanged ? map(prev.pending) : prev.pending;
        let jobs = tr.docChanged && prev.jobs.size ? new Map([...prev.jobs].map(([id, r]) => [id, map(r)])) : prev.jobs;
        let last = tr.docChanged ? null : prev.last;
        if (meta && 'pending' in meta) pending = meta.pending ?? null;
        if (meta?.add) { jobs = new Map(jobs); jobs.set(meta.add.id, meta.add.range); }
        if (meta?.remove) { jobs = new Map(jobs); jobs.delete(meta.remove); }
        if (meta && 'last' in meta) last = meta.last ?? null;
        if (pending && pending.to <= pending.from) pending = null;
        return pending === prev.pending && jobs === prev.jobs && last === prev.last ? prev : { pending, jobs, last };
      },
    },
    props: {
      handleTextInput(view, from, to, text) {
        const { state } = view;
        const $from = state.doc.resolve(from);
        if (from !== to || !$from.parent.isTextblock || !applies(view, state)) return false;
        if (text === '}') {
          const line = lineBefore($from) + '}';
          // an environment begun or ended, alone in its paragraph
          const env = $from.parentOffset === $from.parent.content.size ? /^\\(begin|end)\{([A-Za-z]+\*?)\}$/.exec(line) : null;
          if (env && environment(view, $from, env[1] === 'begin', env[2], hooks)) return true;
          // a command's closing brace: typed here, the command waits for the caret to leave it
          const at = commandRunAt(line, line.length);
          if (at === null || insideOpenGroup(line, at) || !convertible(line.slice(at))) return false;
          view.dispatch(state.tr.insertText('}', from, to).setMeta(key, { pending: { from: $from.start() + at, to: from + 1 } }));
          return true;
        }
        // a command without arguments, ended by a space or punctuation
        const bare = AFTER_BARE.test(text) ? bareBefore($from) : null;
        return bare ? convertBare(view, bare, text) : false;
      },
      handleKeyDown(view, event) {
        if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
        const { state } = view, sel = state.selection;
        if (event.key === 'Escape') {
          // right after a conversion: the typed text back
          const last = key.getState(state)?.last;
          if (!last || !sel.empty || sel.head !== last.caret) return false;
          const tr = state.tr;
          try { for (const s of last.steps) tr.step(s); } catch { view.dispatch(state.tr.setMeta(key, { last: null })); return false; }
          view.dispatch(tr.setMeta(key, { last: null, pending: null }));
          return true;
        }
        // Enter after `\LaTeX`, `\alpha`, `\centering`: as a space would (the Enter goes on)
        if (event.key === 'Enter' && sel.empty && sel.$from.parent.isTextblock && applies(view, state)) {
          const bare = bareBefore(sel.$from);
          if (bare) convertBare(view, bare, '');
        }
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
