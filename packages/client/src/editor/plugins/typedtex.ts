/**
 * LaTeX typed into the text of a LaTeX document becomes what it means, as in Overleaf's visual
 * editor. A heading, a font or a footnote at its `{`: `\section{` alone at a paragraph's start makes
 * it the heading, typed on as one; `\textbf{`, `\emph{`, `\texttt{` … type on in that font;
 * `\footnote{`, `\marginpar{` and a float's `\caption{` open their inset to type in — the `}` that
 * closes it then only ends it (the font, the inset left), as Overleaf's own `}` does. `\cite{key}`,
 * `\ref{…}`, `\label{…}`, `\url{…}`, `\includegraphics{…}` at their `}`; commands of more arguments
 * or unknown ones (`\href{…}{…}`) once finished — the last `}` typed and the caret gone on (a space,
 * a full stop, Enter, a click elsewhere; a `{` or `[` right after the `}` is its next argument) — and
 * `\LaTeX`, `\today`, `\ldots` … at the space, punctuation or Enter after them. Those are parsed on
 * the server against the document's own preamble, as pasted LaTeX is (plugins/paste.ts): what the
 * editor has no picture of becomes a TeX code box, so it reaches the PDF as typed instead of as a
 * printed backslash.
 *
 * Math typed in the text is a formula, at once: `\alpha `, `\frac{a}{b}`, `\mathbb{R}` — LaTeX itself
 * has no other meaning for them there ("Missing $ inserted"); `$` / `$$` open one to type into
 * (commands.ts typeDollar). Environments alone in their paragraph: `\begin{equation}` (align, gather,
 * multline …) opens a display formula of that kind, `\begin{figure}` / `{table}` a float to type its
 * `\includegraphics`, `\caption` and `\label` into (`\end{figure}` leaves it), `\begin{theorem}` and
 * every other environment of the class its paragraph style (`\end{theorem}` back to ordinary text);
 * the lists are mdrules.ts'. Esc right after a conversion — or Ctrl+Z — gives the typed text back.
 *
 * Command names complete as in a formula (lyxmath/field.ts, LyX's completion): the rest of the name
 * shown faintly after `\sec`, `\begin{fig`, `\end{` (the environment the caret is in), Tab takes it
 * and finishes the command — its `{`, the `}` of an environment, the space after a symbol.
 *
 * A command inside the braces of one still open waits for that one; raw TeX, code, markdown
 * documents and HTML articles are left alone.
 */
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import type { Step } from 'prosemirror-transform';
import { Fragment, type Mark, type Node as PMNode, type ResolvedPos } from 'prosemirror-model';
import { schema, SYMBOLS, completeCommand, isKnownCommand } from '@overlyx/core';
import { api } from '../../api';
import { editorContext, viewDocId } from '../context';
import { inRawText } from '../rawtext';
import { STANDARD_LAYOUTS } from '../layouts';

interface Range { from: number; to: number }
/** the last conversion, taken back by Esc while nothing changed since and the caret is where it left it (`opened`: a group with it) */
interface Revert { steps: Step[]; caret: number; opened?: boolean }
/**
 * What a typed `{` opened, which its `}` ends: a heading's paragraph, a font, an inset — at `pos`
 * (the paragraph's or the inset's place), its text from `from`. It lasts while the caret is in there.
 */
interface Group { kind: 'par' | 'font' | 'inset'; pos: number; from: number; layout?: string; mark?: Mark; prev?: Mark | null }
interface TypedState {
  /** a command just finished at the caret: converted once the caret leaves it */
  pending: Range | null;
  /** commands being parsed, followed through the edits made meanwhile */
  jobs: Map<object, Range>;
  last: Revert | null;
  /** the groups open, innermost last */
  open: Group[];
  /** the completion dismissed (Esc) at this caret, until the text changes */
  hintOff: number | null;
}
interface Meta { pending?: Range | null; add?: { id: object; range: Range }; remove?: object; last?: Revert | null; push?: Group; pop?: boolean; hintOff?: number | null }

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

/** formula commands of two arguments (the rest take one) */
const MATH_TWO = new Set(['frac', 'dfrac', 'tfrac', 'cfrac', 'nicefrac', 'unitfrac', 'binom', 'dbinom', 'tbinom', 'stackrel', 'cancelto']);
const mathArity = (name: string) => (MATH_TWO.has(name) || SYMBOLS[name]?.i === 'underset' || SYMBOLS[name]?.i === 'overset' ? 2 : 1);
/** a formula command typed with a `{` after it (the rest end at a space) */
const mathTakesArg = (name: string) => MATH_STRUCTURE.has(name) || ['decoration', 'font', 'underset', 'overset'].includes(SYMBOLS[name]?.i ?? '');

const MATH_ENVS = new Set(['equation', 'align', 'gather', 'multline', 'flalign', 'eqnarray']);
const FLOATS = new Set(['figure', 'table', 'algorithm']);
const LISTS = ['itemize', 'enumerate', 'description'];

/* ------------------------------------------------------------------ text commands */

/** fonts a `{` opens: the mark (core tex/parse.ts FONT_CMDS) */
const FONTS: Record<string, [string, string]> = {
  textbf: ['series', 'bold'], textmd: ['series', 'medium'], emph: ['emph', 'on'], textit: ['shape', 'italic'], textsl: ['shape', 'slanted'],
  textsc: ['shape', 'smallcaps'], textup: ['shape', 'up'], texttt: ['family', 'typewriter'], textsf: ['family', 'sans'], textrm: ['family', 'roman'],
  underline: ['bar', 'under'], uline: ['bar', 'under'], uuline: ['uuline', 'on'], uwave: ['uwave', 'on'], sout: ['strikeout', 'on'], xout: ['xout', 'on'], noun: ['noun', 'on'],
};
/** insets a `{` opens, to type in (a caption only in a float) */
const INSETS: Record<string, { name: string; arg: string; status: string | null }> = {
  footnote: { name: 'Foot', arg: '', status: 'open' }, marginpar: { name: 'Marginal', arg: '', status: 'open' }, caption: { name: 'Caption', arg: 'Standard', status: null },
};
/** commands of one argument: what they mean at its `}` */
const ONE_ARG = new Set(['cite', 'citep', 'citet', 'citealp', 'citealt', 'citeauthor', 'citeyear', 'parencite', 'textcite', 'autocite', 'footcite', 'nocite',
  'ref', 'eqref', 'pageref', 'autoref', 'cref', 'Cref', 'nameref', 'vref', 'label', 'url', 'includegraphics', 'input', 'include', 'bibliography']);
/** what completion offers besides those, the headings, environments and formulas' commands: with an argument, or without */
const TEXT_ARG = ['href', 'textcolor', 'hspace', 'vspace', 'begin', 'end', 'bibliographystyle'];
const TEXT_BARE = ['LaTeX', 'TeX', 'LyX', 'today', 'ldots', 'centering', 'noindent', 'newline', 'newpage', 'clearpage', 'maketitle', 'tableofcontents',
  'item', 'appendix', 'hfill', 'vfill', 'bigskip', 'medskip', 'smallskip', 'printbibliography'];

const layouts = () => editorContext.meta?.layouts ?? STANDARD_LAYOUTS;
/** the class's heading (or title, author …) written as command `name` (section → Section, section* → Section*) */
function commandLayout(name: string): string | null {
  return layouts().find(l => /^command$/i.test(l.latexType ?? '') && (l.latexName ?? l.name.toLowerCase()) === name)?.name ?? null;
}

/** the class's paragraph style written as environment `name` (theorem → Theorem, quote → Quote …) */
function layoutOfEnvironment(name: string): string | null {
  return editorContext.meta?.layouts?.find(l => l.latexName === name && /environment/i.test(l.latexType ?? ''))?.name ?? null;
}

/* ------------------------------------------------------------------ completion */

const shortestFirst = (a: string, b: string) => a.length - b.length || a.localeCompare(b);
let textNames: { of: unknown; names: string[] } | null = null;
/** the text's command names: the class's headings, fonts, insets, references … (not LyX's own lyx… commands) */
function textCommandNames(): string[] {
  const ls = layouts();
  if (textNames?.of !== ls) {
    const heads = ls.filter(l => /^command$/i.test(l.latexType ?? '')).map(l => l.latexName ?? l.name.toLowerCase()).filter(n => /^[A-Za-z]+\*?$/.test(n) && !n.startsWith('lyx'));
    textNames = { of: ls, names: [...new Set([...heads, ...Object.keys(FONTS), ...Object.keys(INSETS), ...ONE_ARG, ...TEXT_ARG, ...TEXT_BARE])].sort(shortestFirst) };
  }
  return textNames.names;
}
function environmentNames(): string[] {
  const mine = layouts().filter(l => /environment/i.test(l.latexType ?? '') && l.latexName && /^[A-Za-z]+\*?$/.test(l.latexName) && !l.latexName.startsWith('lyx')).map(l => l.latexName!);
  return [...new Set([...MATH_ENVS, ...[...MATH_ENVS].map(n => n + '*'), ...FLOATS, ...[...FLOATS].map(n => n + '*'), ...LISTS, ...mine])].sort(shortestFirst);
}
/** what finishes the text's command `name` once its name is complete: its `{`, the space after it — null: not one of the text's */
function textFinisher(name: string): '{' | ' ' | null {
  if (FONTS[name] || INSETS[name] || ONE_ARG.has(name) || TEXT_ARG.includes(name) || commandLayout(name)) return '{';
  return TEXT_BARE.includes(name) ? ' ' : null;
}
/** …a formula's (or any LaTeX symbol's) */
function finisher(name: string): '{' | ' ' | null {
  return textFinisher(name) ?? (isMathCommand(name) && mathTakesArg(name) ? '{' : isKnownCommand(name, {}) ? ' ' : null);
}
/** the environment the caret is in, which `\end{` closes: its paragraph's (a list, a theorem …), else a float's */
function openEnvironment($pos: ResolvedPos): string | null {
  const layout = String($pos.parent.attrs.layout ?? '');
  const l = layouts().find(x => x.name === layout && /environment/i.test(x.latexType ?? ''));
  if (l) return l.latexName ?? (LISTS.includes(layout.toLowerCase()) ? layout.toLowerCase() : null);
  for (let d = $pos.depth - 1; d > 0; d--) {
    const n = $pos.node(d);
    if (n.type === schema.nodes.inset && n.attrs.name === 'Float') return String(n.attrs.arg) + (String(n.attrs.params).includes('wide true') ? '*' : '');
  }
  return null;
}

interface Completion { pos: number; suffix: string; finish: '{' | ' ' | '}' }
/** the command (or environment) name being typed at the caret: the rest of it, and what finishes it — or null */
function completion(state: EditorState): Completion | null {
  const { $head, empty } = state.selection;
  const before = $head.nodeBefore, after = $head.nodeAfter;
  if (!empty || !$head.parent.isTextblock || !before?.isText || !/\\(?:[A-Za-z]+|(?:begin|end)\{[A-Za-z]*\*?)$/.test(before.text!.slice(-40))) return null;
  if (after?.isText && /^[A-Za-z*]/.test(after.text!)) return null;   // (in the middle of a word)
  const line = lineBefore($head), pos = $head.pos;
  const env = /\\(begin|end)\{([A-Za-z]*\*?)$/.exec(line);
  if (env) {
    if (escaped(line, line.length - env[0].length)) return null;
    const typed = env[2], names = environmentNames();
    if (!typed) { const open = env[1] === 'end' ? openEnvironment($head) : null; return open ? { pos, suffix: open, finish: '}' } : null; }
    if (names.includes(typed)) return { pos, suffix: '', finish: '}' };
    const cand = names.find(n => n.startsWith(typed));
    return cand ? { pos, suffix: cand.slice(typed.length), finish: '}' } : null;
  }
  const m = /\\([A-Za-z]+)$/.exec(line);
  if (!m || escaped(line, line.length - m[0].length)) return null;
  // a name of the text's as typed, else the text's that it begins (`\sec` → section, not the secant), else a formula's
  const typed = m[1], text = textFinisher(typed);
  if (text) return { pos, suffix: '', finish: text };
  const cand = textCommandNames().find(n => n.startsWith(typed)) ?? (finisher(typed) ? typed : completeCommand(typed, {}, 1)[0]);
  return cand ? { pos, suffix: cand.slice(typed.length), finish: finisher(cand.replace(/\*$/, '')) ?? ' ' } : null;
}

/** a character typed as the keyboard would: through the plugins' text input (this one's, mdrules'), else inserted */
function typeChar(view: EditorView, ch: string): void {
  const { from, to } = view.state.selection;
  const deflt = () => view.state.tr.insertText(ch, from, to);
  if (!view.someProp('handleTextInput', f => f(view, from, to, ch, deflt))) view.dispatch(deflt());
}

/** Tab: the name completed and the command finished (`\sec` → a heading to type, `\alp` → α, `\begin{fig` → a figure) */
function acceptCompletion(view: EditorView, c: Completion): void {
  if (c.suffix) view.dispatch(view.state.tr.insertText(c.suffix, c.pos, c.pos).scrollIntoView());
  typeChar(view, c.finish);
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
  const meta = tr.getMeta(key) as Meta | undefined;
  const steps = tr.steps.slice(fromStep).map((s, i) => s.invert(tr.docs[fromStep + i])).reverse();
  tr.setMeta(key, { ...meta, last: { steps, caret: tr.selection.head, opened: !!meta?.push } });
  view.dispatch(tr);
}

/** how many `{…}` arguments a typed command has (its `[…]` aside) */
function bracedGroups(snippet: string): number {
  let n = 0, depth = 0;
  for (let i = 0; i < snippet.length; i++) {
    if (escaped(snippet, i)) continue;
    if (snippet[i] === '{' && !depth++) n++;
    else if (snippet[i] === '}') depth--;
  }
  return n;
}

/**
 * `\section{`, `\textbf{`, `\footnote{` … its `{` about to be typed at `$from`: the paragraph a heading,
 * the font on, the inset open, to type on in — false: not one of those (the `{` is typed).
 */
function openGroup(view: EditorView, $from: ResolvedPos): boolean {
  const { state } = view;
  const line = lineBefore($from);
  const m = /\\([A-Za-z]+\*?)$/.exec(line);
  if (!m) return false;
  const at = line.length - m[0].length;
  if (escaped(line, at) || insideOpenGroup(line, at)) return false;
  const name = m[1], start = $from.start() + at, par = $from.parent;
  // the `{` typed first: Esc gives back `\name{`
  const tr = state.tr.insertText('{', $from.pos), end = $from.pos + 1;
  const layout = at === 0 && par.type === schema.nodes.paragraph && ($from.depth === 1 || par.attrs.layout === 'Standard') ? commandLayout(name) : null;
  if (layout) {
    tr.delete(start, end).setNodeMarkup($from.before(), undefined, { ...par.attrs, layout });
    return opened(view, tr, { kind: 'par', pos: $from.before(), from: start, layout });
  }
  const font = FONTS[name];
  if (font) {
    const around = fontsAt(state, start), type = schema.marks[font[0]];
    const prev = type.isInSet(around) ?? null;
    // (\emph in emphasized text: upright, as LaTeX has it)
    const mark = type.create({ value: name === 'emph' && prev?.attrs.value === 'on' ? 'off' : font[1] });
    tr.delete(start, end).setStoredMarks(mark.addToSet(around));
    return opened(view, tr, { kind: 'font', pos: $from.before(), from: start, mark, prev });
  }
  const inset = INSETS[name];
  if (inset && (name !== 'caption' || inFloat($from))) {
    tr.replaceWith(start, end, schema.nodes.inset.create({ ...inset, params: '[]' }, schema.nodes.paragraph.create({ layout: 'Plain Layout' })));
    tr.setSelection(TextSelection.create(tr.doc, start + 2)).scrollIntoView();
    return opened(view, tr, { kind: 'inset', pos: start, from: start + 2 });
  }
  return false;
}
function opened(view: EditorView, tr: Transaction, group: Group): true {
  dispatchConversion(view, tr.setMeta(key, { push: group }), 1);
  return true;
}
const inFloat = ($pos: ResolvedPos) => { for (let d = $pos.depth - 1; d > 0; d--) if ($pos.node(d).type === schema.nodes.inset && ['Float', 'Wrap'].includes($pos.node(d).attrs.name)) return true; return false; };

/** the `}` that ends the innermost open group, about to be typed at `$from`: the font off, the inset left — false: it is no such `}` */
function closeGroup(view: EditorView, $from: ResolvedPos): boolean {
  const { state } = view;
  const g = key.getState(state)?.open.at(-1);
  if (!g) return false;
  // (not one that closes a command typed inside it: `\cite{key}` in a heading)
  const line = lineBefore($from), off = g.kind === 'inset' ? 0 : Math.max(0, g.from - $from.start());
  if (insideOpenGroup(line.slice(off), line.length - off)) return false;
  const atEnd = $from.parentOffset === $from.parent.content.size;
  if (g.kind === 'font') {
    const marks = (state.storedMarks ?? $from.marks()).filter(m => m.type !== g.mark!.type);
    view.dispatch(state.tr.setStoredMarks(g.prev ? g.prev.addToSet(marks) : marks).setMeta(key, { pop: true }));
    return true;
  }
  if (!atEnd) return false;
  if (g.kind === 'par') { view.dispatch(state.tr.setMeta(key, { pop: true })); return true; }
  // the inset's end: the caret after it
  const d = $from.depth - 1;
  if (d < 1 || $from.before(d) !== g.pos || $from.index(d) !== $from.node(d).childCount - 1) return false;
  view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, $from.after(d))).setMeta(key, { pop: true }).scrollIntoView());
  return true;
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
  let current: EditorView | null = null;
  return new Plugin<TypedState>({
    key,
    state: {
      init: () => ({ pending: null, jobs: new Map(), last: null, open: [], hintOff: null }),
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
        // the open groups: the one ended, then those the caret is still in, then the one opened
        let open = meta?.pop ? prev.open.slice(0, -1) : prev.open;
        if (open.length && (tr.docChanged || tr.selectionSet)) {
          const $head = tr.selection.$head, kept: Group[] = [];
          for (const g of open) {
            const pos = tr.mapping.map(g.pos, 1);
            let inside = false;
            for (let d = $head.depth; d > 0 && !inside; d--) inside = $head.before(d) === pos;
            // (a heading no more — taken back by Ctrl+Z, say — ends its group too)
            if (!inside || (g.layout && tr.doc.nodeAt(pos)?.attrs.layout !== g.layout)) break;
            kept.push(tr.docChanged ? { ...g, pos, from: tr.mapping.map(g.from, -1) } : g);
          }
          if (kept.length !== open.length || tr.docChanged) open = kept;
        }
        if (meta?.push) open = [...open, meta.push];
        let hintOff = tr.docChanged ? null : prev.hintOff;
        if (meta && 'hintOff' in meta) hintOff = meta.hintOff ?? null;
        return pending === prev.pending && jobs === prev.jobs && last === prev.last && open === prev.open && hintOff === prev.hintOff ? prev : { pending, jobs, last, open, hintOff };
      },
    },
    props: {
      // the rest of the command name being typed, faint after the caret (Tab takes it)
      decorations(state) {
        if (!current || !applies(current, state)) return null;
        const c = completion(state);
        if (!c?.suffix || key.getState(state)?.hintOff === c.pos) return null;
        const hint = Decoration.widget(c.pos, () => {
          const span = document.createElement('span');
          span.className = 'tex-hint';
          span.textContent = c.suffix;
          span.title = 'Tab completes it, Esc hides it';
          return span;
        }, { side: 1, ignoreSelection: true, key: 'tex-hint:' + c.suffix });
        return DecorationSet.create(state.doc, [hint]);
      },
      handleTextInput(view, from, to, text) {
        const { state } = view;
        const $from = state.doc.resolve(from);
        if (from !== to || !$from.parent.isTextblock || !applies(view, state)) return false;
        if (text === '{') return openGroup(view, $from);
        if (text === '}') {
          if (closeGroup(view, $from)) return true;
          const line = lineBefore($from) + '}';
          // an environment begun or ended, alone in its paragraph
          const env = $from.parentOffset === $from.parent.content.size ? /^\\(begin|end)\{([A-Za-z]+\*?)\}$/.exec(line) : null;
          if (env && environment(view, $from, env[1] === 'begin', env[2], hooks)) return true;
          // a command's closing brace: typed here
          const at = commandRunAt(line, line.length);
          if (at === null || insideOpenGroup(line, at) || !convertible(line.slice(at))) return false;
          const range = { from: $from.start() + at, to: from + 1 }, snippet = line.slice(at), name = /^\\([A-Za-z]+)/.exec(snippet)![1];
          // its only argument, or all a formula's: what it means at once
          if (ONE_ARG.has(name) || (isMathCommand(name) && bracedGroups(snippet) >= mathArity(name))) {
            view.dispatch(state.tr.insertText('}', from, to));
            convert(view, range);
            return true;
          }
          // the rest wait for the caret to leave it (another argument may follow)
          view.dispatch(state.tr.insertText('}', from, to).setMeta(key, { pending: range }));
          return true;
        }
        // a command without arguments, ended by a space or punctuation
        const bare = AFTER_BARE.test(text) ? bareBefore($from) : null;
        return bare ? convertBare(view, bare, text) : false;
      },
      handleKeyDown(view, event) {
        const { state } = view, sel = state.selection;
        // the `}` that ends a group, at its key (with whatever modifiers make a `}`): as text input the
        // browser has put it inside the footnote already, and takes the caret back in after it
        if (event.key === '}' && !event.metaKey && (event.altKey || !event.ctrlKey) && sel.empty && sel.$from.parent.isTextblock && applies(view, state) && closeGroup(view, sel.$from)) return true;
        if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
        if (event.key === 'Tab' && applies(view, state)) {
          // the command name being typed: completed and finished
          const c = completion(state);
          if (!c) return false;
          acceptCompletion(view, c);
          return true;
        }
        if (event.key === 'Escape') {
          // a completion shown: away with it
          const c = applies(view, state) ? completion(state) : null;
          if (c?.suffix && key.getState(state)?.hintOff !== c.pos) { view.dispatch(state.tr.setMeta(key, { hintOff: c.pos })); return true; }
          // right after a conversion: the typed text back
          const last = key.getState(state)?.last;
          if (!last || !sel.empty || sel.head !== last.caret) return false;
          const tr = state.tr;
          try { for (const s of last.steps) tr.step(s); } catch { view.dispatch(state.tr.setMeta(key, { last: null })); return false; }
          view.dispatch(tr.setMeta(key, { last: null, pending: null, pop: last.opened }));
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
    view: (v) => {
      let queued = false;
      current = v;
      return {
        destroy() { if (current === v) current = null; },
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
