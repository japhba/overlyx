/**
 * Markdown documents in the editor (a `.md` file, written as markdown by core md/): the same
 * WYSIWYG editing, restricted to what markdown can hold, with the editing primitives of markdown
 * editors (Typora, Vditor):
 *  - typing the markup formats on the spot — `**bold**`, `*em*` / `_em_`, `` `code` ``, `~~strike~~`;
 *    `> ` starts a quote, "```lang" + Enter a code block, `---` + Enter a horizontal rule (`# `, `- `
 *    and `1. ` are plugins/mdrules.ts, for every document);
 *  - what markdown cannot express does not get in: pasted or applied layouts become the closest
 *    markdown block (a chapter heading → `#`), font attributes it has no syntax for are dropped,
 *    and the LaTeX-only shortcuts (labels, citations, margin notes …) say so instead of inserting;
 *  - markdown pasted as plain text arrives as structure.
 * Active only in markdown documents (the shells pass `markdown` to assemblePlugins).
 */
import { InputRule, inputRules } from 'prosemirror-inputrules';
import { keymap } from 'prosemirror-keymap';
import { Plugin, TextSelection, type EditorState, type Transaction, type Command } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { Fragment, Slice, type Mark, type Node as PMNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import { ySyncPluginKey } from 'y-prosemirror';
import { schema, paragraphsToPm, isMarkdownPath, MARKDOWN_LAYOUTS, markdownLayoutFor } from '@overlyx/core';
import { inRawText } from './rawtext';
import { editorContext } from './context';
import { pasteBlocksIntoEmpty } from './plugins/paste';

/** Is this document (id or path) written as markdown? */
export function isMarkdownDoc(docId: string | null | undefined): boolean {
  return !!docId && isMarkdownPath(docId);
}

/* ------------------------------------------------------------------ marks markdown has */

/** a font mark as markdown keeps it, or null (dropped) — italic and slanted are written as emphasis */
function markdownMark(m: Mark): Mark | null {
  const v = String(m.attrs.value ?? '');
  switch (m.type.name) {
    case 'emph': return v === 'on' ? m : null;
    case 'series': return v === 'bold' ? m : null;
    case 'shape': return v === 'italic' || v === 'slanted' ? schema.marks.emph.create({ value: 'on' }) : null;
    case 'family': return v === 'typewriter' ? m : null;
    case 'strikeout': return v === 'on' ? m : null;
    case 'xout': return v === 'on' ? schema.marks.strikeout.create({ value: 'on' }) : null;
    case 'bar': return v === 'under' ? m : null;
    case 'uuline': case 'uwave': return v === 'on' ? schema.marks.bar.create({ value: 'under' }) : null;
    case 'change': case 'lang': case 'nospellcheck': return m;
    default: return null;
  }
}

function cleanMarks(marks: readonly Mark[]): readonly Mark[] | null {
  let changed = false;
  const out: Mark[] = [];
  for (const m of marks) {
    const k = markdownMark(m);
    if (k !== m) changed = true;
    if (k) out.push(k);
  }
  if (!changed) return null;
  // deduplicated and ordered as the schema wants them
  let set: readonly Mark[] = [];
  for (const m of out) set = m.addToSet(set);
  return set;
}

/** a pasted fragment as markdown can hold it: layouts mapped, unsupported font marks dropped */
function cleanFragment(f: Fragment): Fragment {
  const nodes: PMNode[] = [];
  f.forEach(n => {
    if (n.isText) {
      const m = cleanMarks(n.marks);
      nodes.push(m ? n.mark(m) : n);
      return;
    }
    let node = n;
    if (n.type.name === 'paragraph' && !MARKDOWN_LAYOUTS.includes(String(n.attrs.layout)) && n.attrs.layout !== 'Plain Layout') {
      node = n.type.create({ ...n.attrs, layout: markdownLayoutFor(String(n.attrs.layout)) }, n.content, n.marks);
    }
    if (node.content.size) node = node.copy(cleanFragment(node.content));
    nodes.push(node);
  });
  return Fragment.fromArray(nodes);
}

/**
 * Paragraph layouts and font marks of the changed part of the document, made markdown's. Only for
 * local edits (a collaborator's arrive cleaned already); a top-level paragraph whose layout markdown
 * lacks — Ctrl+1 (Chapter), Alt+P D (Description), a toolbar's layout box — becomes the closest one.
 */
function normalizeChanged(transactions: readonly Transaction[], state: EditorState): Transaction | null {
  if (!transactions.some(t => t.docChanged && !t.getMeta(ySyncPluginKey))) return null;
  const ranges: [number, number][] = [];
  for (const t of transactions) {
    if (!t.docChanged) continue;
    t.mapping.maps.forEach((map, i) => {
      map.forEach((_a, _b, from, to) => {
        let f = from, e = to;
        for (let k = i + 1; k < t.mapping.maps.length; k++) { f = t.mapping.maps[k].map(f, -1); e = t.mapping.maps[k].map(e, 1); }
        // later transactions of the batch move it again
        for (const later of transactions.slice(transactions.indexOf(t) + 1)) { f = later.mapping.map(f, -1); e = later.mapping.map(e, 1); }
        ranges.push([Math.max(0, f), Math.min(state.doc.content.size, e)]);
      });
    });
  }
  if (!ranges.length) return null;
  let tr: Transaction | null = null;
  for (const [from, to] of ranges) {
    state.doc.nodesBetween(Math.max(0, from - 1), Math.min(state.doc.content.size, to + 1), (node, pos) => {
      if (node.type.name === 'paragraph') {
        const layout = String(node.attrs.layout);
        if (layout !== 'Plain Layout' && !MARKDOWN_LAYOUTS.includes(layout)) {
          tr ??= state.tr;
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, layout: markdownLayoutFor(layout) });
        }
        return true;
      }
      if (node.isText) {
        const m = cleanMarks(node.marks);
        if (m) {
          tr ??= state.tr;
          for (const old of node.marks) tr.removeMark(pos, pos + node.nodeSize, old);
          for (const k of m) tr.addMark(pos, pos + node.nodeSize, k);
        }
      }
      return true;
    });
  }
  return tr;
}

/* ------------------------------------------------------------------ typing the markup */

/** `**x**` and friends: the delimiters go, the text between gets the mark (not what is typed next) */
function markRule(re: RegExp, mark: string, value: string): InputRule {
  return new InputRule(re, (state, match, start, end) => {
    if (inRawText(state)) return null;
    const full = match[0], inner = match[1];
    const lead = (full.length - inner.length) >> 1;   // the delimiters are as long on both sides
    const innerStart = start + lead, innerEnd = innerStart + inner.length;
    if (innerEnd > end) return null;
    const m = schema.marks[mark].create({ value });
    const tr = state.tr.delete(innerEnd, end).delete(start, innerStart);
    tr.addMark(start, start + inner.length, m);
    tr.removeStoredMark(m.type);
    return tr;
  });
}

const PLAIN = new Set(['Standard', 'Plain Layout']);

/** `> ` at the start of a paragraph: a quote */
const quoteRule = new InputRule(/^>\s$/, (state, _m, start, end) => {
  const $from = state.selection.$from;
  const par = $from.parent;
  if (par.type.name !== 'paragraph' || start !== $from.start() || !PLAIN.has(String(par.attrs.layout)) || $from.depth > 1) return null;
  return state.tr.delete(start, end).setNodeMarkup($from.before(), undefined, { ...par.attrs, layout: 'Quote' });
});

function codeBlockNode(lang: string, text = ''): PMNode {
  const lines = text.split('\n');
  return schema.nodes.inset.create(
    { name: 'listings', arg: '', params: JSON.stringify([`lstparams "${lang ? 'language=' + lang : ''}"`, 'inline false']), status: 'open' },
    lines.map(l => schema.nodes.paragraph.create({ layout: 'Plain Layout' }, l ? schema.text(l) : null)),
  );
}

/**
 * Enter after a paragraph that is only "```lang" makes it a code block (the cursor inside); after
 * `---` / `***` / `___`, a horizontal rule (the cursor in a new paragraph below); after `$$`, a
 * display formula; on an empty quote line, the quote ends.
 */
const enterMarkup: Command = (state, dispatch, view) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.depth !== 1) return false;
  const par = $from.parent;
  if (par.type.name !== 'paragraph' || $from.parentOffset !== par.content.size || !PLAIN.has(String(par.attrs.layout)) && par.attrs.layout !== 'Quote' && !/^(Itemize|Enumerate)$/.test(String(par.attrs.layout))) return false;
  const text = par.textContent;
  const start = $from.start(), endPos = $from.end();
  // Enter on an empty quote line leaves the quote (as on an empty list item)
  if (par.attrs.layout === 'Quote' && par.content.size === 0) {
    if (!dispatch) return true;
    dispatch(state.tr.setNodeMarkup($from.before(), undefined, { ...par.attrs, layout: 'Standard' }).scrollIntoView());
    return true;
  }
  const fence = /^(```|~~~)\s*([\w+#.-]*)\s*$/.exec(text);
  if (fence && par.childCount <= 1) {
    if (!dispatch) return true;
    const node = codeBlockNode(fence[2]);
    const tr = state.tr.replaceWith(start, endPos, node);
    dispatch(tr.setSelection(TextSelection.create(tr.doc, start + 2)).scrollIntoView());
    return true;
  }
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(text) && PLAIN.has(String(par.attrs.layout))) {
    if (!dispatch) return true;
    const rule = schema.nodes.command.create({ cmd: 'line', params: JSON.stringify(['LatexCommand rule', 'width "100text%"', 'height "0.4pt"']) });
    let tr = state.tr.replaceWith(start, endPos, rule);
    tr = tr.setNodeMarkup($from.before(), undefined, { ...par.attrs, noindent: true });
    const after = $from.before() + tr.doc.nodeAt($from.before())!.nodeSize;
    tr = tr.insert(after, schema.nodes.paragraph.create({ layout: 'Standard' }));
    dispatch(tr.setSelection(TextSelection.create(tr.doc, after + 1)).scrollIntoView());
    return true;
  }
  if (text === '$$' && view) {
    if (!dispatch) return true;
    dispatch(state.tr.delete(start, endPos));
    void import('./commands').then(C => C.insertMath(true)(view));
    return true;
  }
  return false;
};

/** a top-level block `node` (a code block, a rule) in place of the empty paragraph at the cursor, else after its paragraph */
function placeBlock(state: EditorState, inline: PMNode, attrs: Record<string, unknown>, caretInside: boolean): Transaction | null {
  let tr = state.tr;
  if (!tr.selection.empty) tr = tr.deleteSelection();
  const $from = tr.selection.$from;
  if ($from.depth < 1) return null;
  const parStart = $from.before(1), par = $from.node(1);
  let at: number;
  if (par.content.size === 0 && par.type.name === 'paragraph') {
    tr.setNodeMarkup(parStart, undefined, { ...par.attrs, ...attrs }).insert(parStart + 1, inline);
    at = parStart;
  } else {
    at = parStart + par.nodeSize;
    tr.insert(at, schema.nodes.paragraph.create({ layout: 'Standard', ...attrs }, inline));
  }
  const after = at + tr.doc.nodeAt(at)!.nodeSize;
  if (caretInside) return tr.setSelection(TextSelection.create(tr.doc, at + 3)).scrollIntoView();
  if (after >= tr.doc.content.size) tr.insert(after, schema.nodes.paragraph.create({ layout: 'Standard' }));
  return tr.setSelection(TextSelection.create(tr.doc, after + 1)).scrollIntoView();
}

/** Insert ▸ Code block: the selected text in a code block, or an empty one with the cursor in it */
export const insertCodeBlock: Command = (state, dispatch) => {
  const { from, to, empty } = state.selection;
  const text = empty ? '' : state.doc.textBetween(from, to, '\n', ' ');
  const tr = placeBlock(state, codeBlockNode('', text), {}, true);
  if (!tr) return false;
  dispatch?.(tr);
  return true;
};

/** Insert ▸ Horizontal rule (`---`), the cursor in the paragraph after it */
export const insertRule: Command = (state, dispatch) => {
  const rule = schema.nodes.command.create({ cmd: 'line', params: JSON.stringify(['LatexCommand rule', 'width "100text%"', 'height "0.4pt"']) });
  const tr = placeBlock(state, rule, { noindent: true }, false);
  if (!tr) return false;
  dispatch?.(tr);
  return true;
};

/** the LaTeX-only shortcuts: a word instead of an inset markdown cannot hold */
function notInMarkdown(what: string): Command {
  return () => { editorContext.notify?.(`Markdown has no ${what} — this is a markdown document`, 'info'); return true; };
}

export function markdownPlugins(): Plugin[] {
  return [
    inputRules({
      rules: [
        markRule(/(?<![*\\])\*\*([^*\s](?:[^*]*[^*\s])?)\*\*$/, 'series', 'bold'),
        markRule(/(?<![_\\\p{L}\p{N}])__([^_\s](?:[^_]*[^_\s])?)__$/u, 'series', 'bold'),
        markRule(/(?<![*\\])\*([^*\s](?:[^*]*[^*\s])?)\*$/, 'emph', 'on'),
        markRule(/(?<![_\\\p{L}\p{N}])_([^_\s](?:[^_]*[^_\s])?)_$/u, 'emph', 'on'),
        markRule(/(?<![~\\])~~([^~\s](?:[^~]*[^~\s])?)~~$/, 'strikeout', 'on'),
        markRule(/(?<![`\\])`([^`]+)`$/, 'family', 'typewriter'),
        quoteRule,
      ],
    }),
    keymap({
      Enter: enterMarkup,
      'Alt-Mod-m': notInMarkdown('margin notes'),
      'Alt-Mod-l': notInMarkdown('labels'),
      'Shift-Mod-i': notInMarkdown('cross-references'),
      'Shift-Mod-c': notInMarkdown('citations'),
      'Alt-Mod-p': notInMarkdown('paragraph settings'),
      'Shift-Mod-n': notInMarkdown('small caps'),
    }),
    taskPlugin(),
    new Plugin({
      appendTransaction: (trs, _old, state) => normalizeChanged(trs, state),
      props: {
        transformPasted: (slice: Slice) => new Slice(cleanFragment(slice.content), slice.openStart, slice.openEnd),
      },
    }),
  ];
}

/* ------------------------------------------------------------------ task lists */

const TASK = /^\[([ xX])\] /;

/** `- [ ] task` / `- [x] done`: a box to tick in front of the item (the text keeps the markup, hidden) */
function taskDecorations(doc: PMNode): DecorationSet {
  const decos: Decoration[] = [];
  doc.forEach((par, offset) => {
    if (par.type.name !== 'paragraph' || (par.attrs.layout !== 'Itemize' && par.attrs.layout !== 'Enumerate')) return;
    const first = par.firstChild;
    const m = first?.isText ? TASK.exec(first.text!) : null;
    if (!m) return;
    const start = offset + 1, done = m[1] !== ' ';
    decos.push(Decoration.widget(start, () => {
      const box = document.createElement('span');
      box.className = 'md-task-box' + (done ? ' done' : '');
      box.dataset.taskAt = String(start + 1);
      box.title = done ? 'Done — click to reopen' : 'Click when done';
      return box;
    }, { side: -1, key: 'task' + (done ? 'x' : 'o') + start }));
    decos.push(Decoration.inline(start, start + 4, { class: 'md-task-src' }));
    if (done && par.content.size > 4) decos.push(Decoration.inline(start + 4, start + par.content.size, { class: 'md-task-done-text' }));
  });
  return DecorationSet.create(doc, decos);
}

function taskPlugin(): Plugin {
  return new Plugin({
    state: {
      init: (_c, state) => taskDecorations(state.doc),
      apply: (tr, old) => (tr.docChanged ? taskDecorations(tr.doc) : old),
    },
    props: {
      decorations(state) { return this.getState(state); },
      handleDOMEvents: {
        mousedown(view, ev) {
          const box = (ev.target as HTMLElement).closest?.('.md-task-box') as HTMLElement | null;
          if (!box || !view.editable) return false;
          ev.preventDefault();
          const at = Number(box.dataset.taskAt);
          const cur = view.state.doc.textBetween(at, at + 1);
          view.dispatch(view.state.tr.insertText(cur === ' ' ? 'x' : ' ', at, at + 1));
          return true;
        },
      },
    },
  });
}

/* ------------------------------------------------------------------ pasting markdown */

/** Does pasted plain text look like markdown (more than a sentence or two of prose)? */
export function looksLikeMarkdown(text: string): boolean {
  return /^(#{1,6} |[-*+] |\d+[.)] |> |```|~~~|\| |\$\$)/m.test(text) || /\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)|!\[[^\]\n]*\]\(/.test(text);
}

/** Plain text pasted into a markdown document, parsed as markdown and inserted as structure. */
export async function pasteMarkdown(view: EditorView, text: string): Promise<void> {
  const { parseMarkdown } = await import('@overlyx/core/md/index.ts');
  if (view.isDestroyed) return;
  const body = parseMarkdown(text.replace(/\r\n/g, '\n')).doc.body;
  const blocks = paragraphsToPm(body, 'Standard').map(j => schema.nodeFromJSON(j));
  const single = blocks.length === 1 && blocks[0].attrs.layout === 'Standard' && !blocks[0].attrs.depth;
  const slice = single ? new Slice(blocks[0].content, 0, 0) : new Slice(Fragment.from(blocks), 1, 1);
  // into an empty paragraph the blocks take its place (a pasted heading stays one)
  if (!single && pasteBlocksIntoEmpty(view, slice)) return;
  view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView());
}
