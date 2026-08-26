/**
 * LyX-style editing commands on top of ProseMirror.
 */
import { type Command, type EditorState, TextSelection, NodeSelection, Selection, type Transaction } from 'prosemirror-state';
import { type Node as PMNode, type MarkType, Fragment, type Attrs, type ResolvedPos } from 'prosemirror-model';
import { splitBlock } from 'prosemirror-commands';
import type { EditorView } from 'prosemirror-view';
import { schema, commentHeader, formatTimestamp, unquote, paramMap } from '@overlyx/core';
import { nextLayout, isHeadingLayout } from './layouts';
import { editorContext } from './context';
import { MathInlineView, MathDisplayView, pendingFocus } from './nodeviews/math';

/* ------------------------------------------------------------ paragraphs */

/** The paragraph containing the selection head (may be inside an inset). */
export function currentParagraph(state: EditorState): { node: PMNode; pos: number; depth: number } | null {
  const $from = state.selection.$from;
  for (let d = $from.depth; d >= 0; d--) {
    const n = $from.node(d);
    if (n.type.name === 'paragraph') return { node: n, pos: $from.before(d), depth: d };
  }
  return null;
}

export function inInset(state: EditorState): boolean {
  const $from = state.selection.$from;
  for (let d = $from.depth; d > 0; d--) {
    const t = $from.node(d).type.name;
    if (t === 'inset' || t === 'table_cell') return true;
  }
  return false;
}

/** Apply a layout to all paragraphs touched by the selection. */
export function setLayout(layout: string): Command {
  return (state, dispatch) => {
    const { from, to } = state.selection;
    const tr = state.tr;
    let any = false;
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (node.type.name === 'paragraph') {
        if (node.attrs.layout !== layout) tr.setNodeMarkup(pos, undefined, { ...node.attrs, layout });
        any = true;
        return false;
      }
      return true;
    });
    if (!any) return false;
    if (dispatch) dispatch(tr.scrollIntoView());
    return true;
  };
}

export function setParagraphAttrs(attrs: Partial<Record<string, unknown>>): Command {
  return (state, dispatch) => {
    const { from, to } = state.selection;
    const tr = state.tr;
    let any = false;
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (node.type.name === 'paragraph') { tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs }); any = true; return false; }
      return true;
    });
    if (!any) return false;
    if (dispatch) dispatch(tr);
    return true;
  };
}

export function changeDepth(delta: number): Command {
  return (state, dispatch) => {
    const { from, to } = state.selection;
    const tr = state.tr;
    let any = false;
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (node.type.name === 'paragraph') {
        const depth = Math.max(0, Math.min(8, (node.attrs.depth as number) + delta));
        if (depth !== node.attrs.depth) { tr.setNodeMarkup(pos, undefined, { ...node.attrs, depth }); any = true; }
        return false;
      }
      return true;
    });
    if (!any) return false;
    if (dispatch) dispatch(tr);
    return true;
  };
}

/** Enter: split paragraph; the new paragraph gets LyX's "next layout". */
export const paragraphBreak: Command = (state, dispatch) => {
  const cur = currentParagraph(state);
  if (!cur) return false;
  const { $from } = state.selection;
  const atEnd = $from.parentOffset === $from.parent.content.size;
  const inset = inInset(state);
  const layouts = editorContext.meta?.layouts;
  const next = nextLayout(cur.node.attrs.layout, inset, layouts);
  if (!dispatch) return true;
  let tr = state.tr.deleteSelection();
  const pos = tr.selection.from;
  const $pos = tr.doc.resolve(pos);
  // paragraphs are always splittable in our schema (block+ / paragraph+)
  const attrs = { ...cur.node.attrs, layout: atEnd ? next : cur.node.attrs.layout, endChange: null };
  tr = tr.split(pos, 1, [{ type: schema.nodes.paragraph, attrs }]);
  if (!atEnd && isHeadingLayout(cur.node.attrs.layout, layouts)) {
    // splitting in the middle of a heading keeps the layout (LyX behaviour)
  }
  // paragraph break inside a change-tracked document
  if (editorContext.trackChanges && editorContext.changeAuthorId !== undefined) {
    const before = tr.doc.resolve(tr.selection.from).before();
    const prev = tr.doc.resolve(before - 1).nodeBefore;
    if (prev && prev.type.name === 'paragraph') {
      tr = tr.setNodeMarkup(before - prev.nodeSize, undefined, { ...prev.attrs, endChange: JSON.stringify({ type: 'inserted', author: editorContext.changeAuthorId, time: Math.floor(Date.now() / 1000) }) });
    }
  }
  void $pos;
  dispatch(tr.scrollIntoView());
  return true;
};

/** Alt+Enter — "paragraph-break inverse": new paragraph with the default layout (or keep). */
export const paragraphBreakInverse: Command = (state, dispatch) => {
  const cur = currentParagraph(state);
  if (!cur) return false;
  const inset = inInset(state);
  const def = inset ? 'Plain Layout' : 'Standard';
  const layout = cur.node.attrs.layout === def ? def : def;
  if (!dispatch) return true;
  let tr = state.tr.deleteSelection();
  tr = tr.split(tr.selection.from, 1, [{ type: schema.nodes.paragraph, attrs: { ...cur.node.attrs, layout, endChange: null } }]);
  dispatch(tr.scrollIntoView());
  return true;
};

/* ----------------------------------------------------------------- fonts */

/** LyX font toggles are value marks: emph on/off, series bold/medium ... */
export function toggleValueMark(markName: string, onValue: string, offValue?: string): Command {
  return (state, dispatch) => {
    const type: MarkType = schema.marks[markName];
    const { from, to, empty, $cursor } = state.selection as TextSelection;
    const has = (marks: readonly { type: MarkType; attrs: Attrs }[]) => marks.find(m => m.type === type);
    if (empty && $cursor) {
      const marks = state.storedMarks ?? $cursor.marks();
      const cur = has(marks);
      const on = cur?.attrs.value === onValue;
      if (!dispatch) return true;
      if (on) dispatch(state.tr.setStoredMarks(marks.filter(m => m.type !== type).concat(offValue ? [type.create({ value: offValue })] : [])));
      else dispatch(state.tr.setStoredMarks(marks.filter(m => m.type !== type).concat([type.create({ value: onValue })])));
      return true;
    }
    // range: if every text node has the mark "on" → remove; else set
    let allOn = true, anyText = false;
    state.doc.nodesBetween(from, to, (node) => {
      if (node.isText) { anyText = true; const m = has(node.marks); if (!(m && m.attrs.value === onValue)) allOn = false; }
    });
    if (!anyText) return false;
    if (!dispatch) return true;
    let tr = state.tr;
    if (allOn) { tr = tr.removeMark(from, to, type); if (offValue) tr = tr.addMark(from, to, type.create({ value: offValue })); }
    else { tr = tr.removeMark(from, to, type).addMark(from, to, type.create({ value: onValue })); }
    dispatch(tr);
    return true;
  };
}

export function setValueMark(markName: string, value: string | null): Command {
  return (state, dispatch) => {
    const type: MarkType = schema.marks[markName];
    const { from, to, empty, $cursor } = state.selection as TextSelection;
    if (!dispatch) return true;
    if (empty && $cursor) {
      const marks = (state.storedMarks ?? $cursor.marks()).filter(m => m.type !== type);
      dispatch(state.tr.setStoredMarks(value ? marks.concat([type.create({ value })]) : marks));
      return true;
    }
    let tr = state.tr.removeMark(from, to, type);
    if (value) tr = tr.addMark(from, to, type.create({ value }));
    dispatch(tr);
    return true;
  };
}

export const fontCommands = {
  emph: toggleValueMark('emph', 'on', undefined),
  bold: toggleValueMark('series', 'bold', undefined),
  noun: toggleValueMark('noun', 'on'),
  underline: toggleValueMark('bar', 'under'),
  strikeout: toggleValueMark('strikeout', 'on'),
  typewriter: toggleValueMark('family', 'typewriter'),
  sans: toggleValueMark('family', 'sans'),
  italic: toggleValueMark('shape', 'italic'),
  smallcaps: toggleValueMark('shape', 'smallcaps'),
  slanted: toggleValueMark('shape', 'slanted'),
  uuline: toggleValueMark('uuline', 'on'),
  uwave: toggleValueMark('uwave', 'on'),
  xout: toggleValueMark('xout', 'on'),
};

/** Reset all font attributes on the selection (LyX "font-default"). */
export const fontDefault: Command = (state, dispatch) => {
  const { from, to, empty } = state.selection;
  if (!dispatch) return true;
  if (empty) { dispatch(state.tr.setStoredMarks([])); return true; }
  let tr = state.tr;
  for (const name of ['family', 'series', 'shape', 'size', 'emph', 'bar', 'strikeout', 'xout', 'uuline', 'uwave', 'noun', 'color', 'numeric']) tr = tr.removeMark(from, to, schema.marks[name]);
  dispatch(tr);
  return true;
};

/* ---------------------------------------------------------------- insets */

function insertInline(state: EditorState, node: PMNode): Transaction {
  const tr = state.tr.replaceSelectionWith(node, false);
  return tr;
}

export function insertNode(node: PMNode, selectInside = false): Command {
  return (state, dispatch) => {
    if (!dispatch) return true;
    const tr = insertInline(state, node);
    if (selectInside) {
      const pos = tr.selection.from - node.nodeSize;
      tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 2)));
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** Insert a text-containing inset around the selection (or empty), cursor inside. */
export function insertTextInset(name: string, arg = '', params: string[] = [], status: 'open' | 'collapsed' | null = 'open', initialParagraphs?: PMNode[]): Command {
  return (state, dispatch) => {
    const { from, to, empty } = state.selection;
    let paras: PMNode[];
    if (initialParagraphs) paras = initialParagraphs;
    else if (!empty && state.selection instanceof TextSelection && state.selection.$from.sameParent(state.selection.$to)) {
      const slice = state.doc.slice(from, to);
      paras = [schema.nodes.paragraph.create({ layout: 'Plain Layout' }, slice.content)];
    } else paras = [schema.nodes.paragraph.create({ layout: 'Plain Layout' })];
    const attrs: Record<string, unknown> = { name, arg, params: JSON.stringify(params), status };
    if (editorContext.trackChanges && editorContext.changeAuthorId !== undefined) {
      attrs.marks = JSON.stringify([{ type: 'change', attrs: { type: 'inserted', author: editorContext.changeAuthorId, time: Math.floor(Date.now() / 1000) } }]);
    }
    const node = schema.nodes.inset.create(attrs, Fragment.from(paras));
    if (!dispatch) return true;
    let tr = state.tr.replaceSelectionWith(node, false);
    const pos = tr.selection.from - node.nodeSize;
    // cursor at end of the first paragraph inside
    const inner = pos + 1 + 1 + (paras[0].content.size);
    tr = tr.setSelection(TextSelection.create(tr.doc, Math.min(inner, tr.doc.content.size)));
    dispatch(tr.scrollIntoView());
    return true;
  };
}

export const insertNote = (kind: 'Note' | 'Comment' | 'Greyedout') => insertTextInset('Note', kind, [], 'open');
export const insertFootnote = insertTextInset('Foot', '', [], 'open');
export const insertMarginal = insertTextInset('Marginal', '', [], 'open');
export const insertERT = insertTextInset('ERT', '', [], 'open');
export const insertBox = insertTextInset('Box', 'Frameless', ['position "t"', 'hor_pos "c"', 'has_inner_box 1', 'inner_pos "t"', 'use_parbox 0', 'use_makebox 0', 'width "100col%"', 'special "none"', 'height "1in"', 'height_special "totalheight"', 'thickness "0.4pt"', 'separation "3pt"', 'shadowsize "4pt"', 'framecolor "black"', 'backgroundcolor "none"'], 'open');
export const insertBranch = (name: string) => insertTextInset('Branch', name, ['inverted 0'], 'open');
export const insertFlex = (name: string) => insertTextInset('Flex', name, [], 'collapsed');
export const insertArgument = (n: string) => insertTextInset('Argument', n, [], 'open');
export const insertIndex = insertTextInset('Index', 'idx', ['range none', 'pageformat default'], 'collapsed');
export const insertListing = insertTextInset('listings', '', ['lstparams ""', 'inline false'], 'open');
export const insertCaption = insertTextInset('Caption', 'Standard', [], null);

/** OverLyX comment thread: a Note Comment inset with an author/time header paragraph. */
export const insertComment: Command = (state, dispatch) => {
  const user = editorContext.user?.name ?? 'Anonymous';
  const header = schema.nodes.paragraph.create({ layout: 'Plain Layout' }, schema.text(commentHeader(user, formatTimestamp())));
  const body = schema.nodes.paragraph.create({ layout: 'Plain Layout' });
  const cmd = insertTextInset('Note', 'Comment', [], 'open', [header, body]);
  return cmd(state, (tr) => {
    // the cursor sits at the end of the header paragraph: +1 closes it, +1 opens the body paragraph
    const pos = tr.selection.from + 2;
    dispatch?.(tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(pos, tr.doc.content.size)))).scrollIntoView());
  });
};

export function insertFloat(type: 'figure' | 'table' | 'algorithm' = 'figure'): Command {
  return (state, dispatch) => {
    const caption = schema.nodes.inset.create({ name: 'Caption', arg: 'Standard', params: '[]', status: null }, schema.nodes.paragraph.create({ layout: 'Plain Layout' }));
    const p1 = schema.nodes.paragraph.create({ layout: 'Plain Layout', align: 'center' });
    const p2 = schema.nodes.paragraph.create({ layout: 'Plain Layout' }, caption);
    const content = type === 'table' ? [p2, p1] : [p1, p2];
    const float = schema.nodes.inset.create({ name: 'Float', arg: type, params: JSON.stringify(['placement document', 'alignment document', 'wide false', 'sideways false']), status: 'open' }, Fragment.from(content));
    if (!dispatch) return true;
    let tr = state.tr.replaceSelectionWith(float, false);
    const pos = tr.selection.from - float.nodeSize;
    tr = tr.setSelection(TextSelection.create(tr.doc, pos + 2));
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** Graphics inset parameters (LyX InsetGraphicsParams). Flags are written as bare words. */
export interface GraphicsOpts {
  lyxscale?: string; draft?: boolean; scale?: string; width?: string; height?: string; keepAspectRatio?: boolean;
  rotateAngle?: string; rotateOrigin?: string; scaleBeforeRotation?: boolean; BoundingBox?: string; clip?: boolean; special?: string; groupId?: string;
}

/** Parameter lines in the order LyX writes them (InsetGraphicsParams::Write). */
export function graphicsParams(filename: string, o: GraphicsOpts = {}): string[] {
  const params = [`\tfilename ${filename}`];
  if (o.lyxscale) params.push(`\tlyxscale ${o.lyxscale}`);
  if (o.draft) params.push('\tdraft');
  if (o.scale) params.push(`\tscale ${o.scale}`);
  if (o.width) params.push(`\twidth ${o.width}`);
  if (o.height) params.push(`\theight ${o.height}`);
  if (o.keepAspectRatio) params.push('\tkeepAspectRatio');
  if (o.rotateAngle && o.rotateAngle !== '0') params.push(`\trotateAngle ${o.rotateAngle}`);
  if (o.rotateOrigin && o.rotateOrigin !== 'center') params.push(`\trotateOrigin ${o.rotateOrigin}`);
  if (o.scaleBeforeRotation) params.push('\tscaleBeforeRotation');
  if (o.BoundingBox) params.push(`\tBoundingBox ${o.BoundingBox}`);
  if (o.clip) params.push('\tclip');
  if (o.special) params.push(`\tspecial ${o.special}`);
  if (o.groupId) params.push(`\tgroupId ${o.groupId}`);
  params.push('');
  return params;
}

/** The inverse of graphicsParams for an existing inset. */
export function graphicsOpts(params: string[]): GraphicsOpts & { filename: string } {
  const p = paramMap(params);
  const str = (k: string) => p.get(k) || undefined;
  return {
    filename: p.get('filename') ?? '', lyxscale: str('lyxscale'), draft: p.has('draft'), scale: str('scale'), width: str('width'), height: str('height'),
    keepAspectRatio: p.has('keepAspectRatio'), rotateAngle: str('rotateAngle'), rotateOrigin: str('rotateOrigin'), scaleBeforeRotation: p.has('scaleBeforeRotation'),
    BoundingBox: str('BoundingBox'), clip: p.has('clip'), special: str('special'), groupId: str('groupId'),
  };
}

export function insertGraphics(filename: string, opts: GraphicsOpts = {}): Command {
  return insertNode(schema.nodes.graphics.create({ params: JSON.stringify(graphicsParams(filename, opts)) }));
}

export function insertCommand(cmd: string, params: string[]): Command {
  return insertNode(schema.nodes.command.create({ cmd, params: JSON.stringify([...params, '']) }));
}
export const insertLabel = (name: string) => insertCommand('label', ['LatexCommand label', `name "${name}"`]);
export const insertRef = (name: string, kind = 'ref') => insertCommand('ref', [`LatexCommand ${kind}`, `reference "${name}"`, 'plural "false"', 'caps "false"', 'noprefix "false"', 'nolink "false"']);
export const insertCite = (keys: string[], cmd = 'cite', before = '', after = '') => {
  const p = [`LatexCommand ${cmd}`];
  if (after) p.push(`after "${after}"`);
  if (before) p.push(`before "${before}"`);
  p.push(`key "${keys.join(',')}"`, 'literal "false"');
  return insertCommand('citation', p);
};
export const insertHref = (target: string, name = '') => insertCommand('href', ['LatexCommand href', `name "${name}"`, `target "${target}"`, 'literal "false"']);
export const insertInclude = (filename: string, kind = 'include') => insertCommand('include', [`LatexCommand ${kind}`, `filename "${filename}"`, 'literal "true"']);
export const insertBibtex = (files: string, style = 'plain') => insertCommand('bibtex', ['LatexCommand bibtex', 'btprint "btPrintCited"', `bibfiles "${files}"`, `options "${style}"`, 'encoding "default"']);
export const insertToc = (kind = 'tableofcontents') => insertCommand('toc', [`LatexCommand ${kind}`]);
export const insertIndexPrint = insertCommand('index_print', ['LatexCommand printindex', 'type "idx"', 'name "Index"', 'literal "false"']);

export const insertQuote = (side: 'l' | 'r', style = 'e', level = 'd') => insertNode(schema.nodes.quotes.create({ kind: `${style}${side}${level}` }));
export const insertSpace = (kind: string) => insertNode(schema.nodes.space.create({ kind }));
export const insertNewline = (kind: 'newline' | 'linebreak' = 'newline') => insertNode(schema.nodes.newline.create({ kind }));
export const insertNewpage = (kind = 'newpage') => insertNode(schema.nodes.newpage.create({ kind }));
export const insertSpecial = (arg: string) => insertNode(schema.nodes.special.create({ token: '\\SpecialChar', arg }));
export const insertHyphens = (token: '\\twohyphens' | '\\threehyphens') => insertNode(schema.nodes.special.create({ token, arg: '' }));
export const insertVSpace = (kind = 'defskip') => insertNode(schema.nodes.leaf.create({ name: 'VSpace', arg: kind, params: '[]' }));
export const insertMacroDef = (name: string, args = 0, def = '') => insertNode(schema.nodes.macro.create({ lines: JSON.stringify([`\\newcommand{\\${name}}${args ? `[${args}]` : ''}{${def}}`]) }));

/** Smart quotes: typing " inserts a LyX Quotes inset (opening/closing by context). */
export const smartQuote: Command = (state, dispatch) => {
  const $from = state.selection.$from;
  const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 1), $from.parentOffset, undefined, ' ');
  const nodeBefore = $from.nodeBefore;
  const opening = $from.parentOffset === 0 || /[\s(\[{]/.test(before) || (nodeBefore && !nodeBefore.isText && nodeBefore.type.name !== 'quotes');
  const style = (editorContext.meta?.language ?? 'english').startsWith('german') ? 'g' : (editorContext.meta?.language ?? '').startsWith('french') ? 'f' : 'e';
  return insertQuote(opening ? 'l' : 'r', style)(state, dispatch);
};

/* ------------------------------------------------------------------ math */

export function insertMath(display: boolean, env?: string): (view: EditorView) => boolean {
  return (view) => {
    const { state } = view;
    let node: PMNode;
    const attrs: Record<string, unknown> = {};
    if (editorContext.trackChanges && editorContext.changeAuthorId !== undefined) attrs.marks = JSON.stringify([{ type: 'change', attrs: { type: 'inserted', author: editorContext.changeAuthorId, time: Math.floor(Date.now() / 1000) } }]);
    // selected text becomes the formula content
    const sel = state.selection;
    const selText = sel.empty ? '' : state.doc.textBetween(sel.from, sel.to, ' ');
    if (display) {
      const e = env ?? 'simple';
      const latex = e === 'simple' ? `\\[\n${selText}\n\\]` : `\\begin{${e}}\n${selText}\n\\end{${e}}`;
      node = schema.nodes.math_display.create({ ...attrs, latex });
    } else {
      node = schema.nodes.math_inline.create({ ...attrs, latex: selText, delim: '$' });
    }
    const pos = state.selection.from;   // the node is inserted where the selection starts
    pendingFocus.pos = pos; pendingFocus.keys = [];
    const tr = state.tr.replaceSelectionWith(node, false);
    view.dispatch(tr);
    // focus the mathfield (the node view DOM exists right after dispatch; retry on the next frame)
    const focusField = (): boolean => {
      const nv = (view as any).nodeDOM(pos) as HTMLElement | null;
      (nv as any)?.pmViewDesc?.spec?.ensureField?.();
      const mf = nv?.querySelector?.('math-field') as any;
      if (!mf) return false;
      mf.focus(); mf.executeCommand('moveToMathfieldEnd');
      return true;
    };
    if (!focusField()) requestAnimationFrame(() => focusField());
    return true;
  };
}

/** Toggle inline <-> display for the math node at/near the selection. */
export const toggleMathDisplay: Command = (state, dispatch) => {
  const sel = state.selection;
  let pos = -1, node: PMNode | null = null;
  if (sel instanceof NodeSelection && (sel.node.type.name === 'math_inline' || sel.node.type.name === 'math_display')) { pos = sel.from; node = sel.node; }
  else {
    const nb = sel.$from.nodeBefore, na = sel.$from.nodeAfter;
    if (nb && (nb.type.name === 'math_inline' || nb.type.name === 'math_display')) { pos = sel.from - nb.nodeSize; node = nb; }
    else if (na && (na.type.name === 'math_inline' || na.type.name === 'math_display')) { pos = sel.from; node = na; }
  }
  if (!node) return false;
  if (!dispatch) return true;
  let repl: PMNode;
  if (node.type.name === 'math_inline') repl = schema.nodes.math_display.create({ marks: node.attrs.marks, latex: `\\[\n${node.attrs.latex}\n\\]` });
  else {
    const m = /\\\[\s*([\s\S]*?)\s*\\\]/.exec(node.attrs.latex) ?? /\\begin\{[a-z*]+\}\s*([\s\S]*?)\s*\\end\{[a-z*]+\}/.exec(node.attrs.latex);
    repl = schema.nodes.math_inline.create({ marks: node.attrs.marks, latex: (m?.[1] ?? node.attrs.latex).replace(/\\label\{[^}]*\}/g, '').trim(), delim: '$' });
  }
  dispatch(state.tr.replaceWith(pos, pos + node.nodeSize, repl));
  return true;
};

/* --------------------------------------------------------------- navigation */

/** Move the cursor into an adjacent math field when arrow keys reach it. */
export function arrowIntoMath(dir: -1 | 1): (state: EditorState, dispatch: ((tr: Transaction) => void) | undefined, view?: EditorView) => boolean {
  return (state, _dispatch, view) => {
    if (!view) return false;
    const sel = state.selection;
    if (!(sel instanceof TextSelection) || !sel.empty) return false;
    const $c = sel.$cursor!;
    const node = dir > 0 ? $c.nodeAfter : $c.nodeBefore;
    if (!node || (node.type.name !== 'math_inline' && node.type.name !== 'math_display' && node.type.name !== 'macro')) return false;
    const pos = dir > 0 ? $c.pos : $c.pos - node.nodeSize;
    const dom = view.nodeDOM(pos) as HTMLElement | null;
    (dom as any)?.pmViewDesc?.spec?.ensureField?.();
    const mf = dom?.querySelector?.('math-field') as any;
    if (!mf) return false;
    mf.focus();
    mf.executeCommand(dir > 0 ? 'moveToMathfieldStart' : 'moveToMathfieldEnd');
    return true;
  };
}

/** Select the whole inset around the cursor (Ctrl+A in LyX: inset-select-all). */
export const selectInset: Command = (state, dispatch) => {
  const $from = state.selection.$from;
  for (let d = $from.depth; d > 0; d--) {
    const n = $from.node(d);
    if (n.type.name === 'inset' || n.type.name === 'table_cell') {
      const start = $from.start(d), end = $from.end(d);
      if (state.selection.from === start && state.selection.to === end) continue;
      dispatch?.(state.tr.setSelection(TextSelection.create(state.doc, start, end)));
      return true;
    }
  }
  dispatch?.(state.tr.setSelection(TextSelection.create(state.doc, 0, state.doc.content.size)));
  return true;
};

/** Toggle open/collapsed on the inset around the cursor (Ctrl+I: inset-toggle). */
export const toggleInset: Command = (state, dispatch) => {
  const $from = state.selection.$from;
  for (let d = $from.depth; d > 0; d--) {
    const n = $from.node(d);
    if (n.type.name === 'inset') {
      const pos = $from.before(d);
      const status = n.attrs.status === 'collapsed' ? 'open' : 'collapsed';
      let tr = state.tr.setNodeMarkup(pos, undefined, { ...n.attrs, status });
      if (status === 'collapsed') tr = tr.setSelection(TextSelection.near(tr.doc.resolve(pos + n.nodeSize)));
      dispatch?.(tr);
      return true;
    }
  }
  // node selection on an inset?
  const sel = state.selection;
  if (sel instanceof NodeSelection && sel.node.type.name === 'inset') {
    dispatch?.(state.tr.setNodeMarkup(sel.from, undefined, { ...sel.node.attrs, status: sel.node.attrs.status === 'collapsed' ? 'open' : 'collapsed' }));
    return true;
  }
  return false;
};

export function setAllInsets(status: 'open' | 'collapsed'): Command {
  return (state, dispatch) => {
    const tr = state.tr;
    state.doc.descendants((node, pos) => {
      if (node.type.name === 'inset' && node.attrs.status && node.attrs.status !== status) tr.setNodeMarkup(pos, undefined, { ...node.attrs, status });
      return true;
    });
    if (!tr.docChanged) return false;
    dispatch?.(tr);
    return true;
  };
}

/** Move the paragraph up/down (Alt+Up/Down: paragraph-move-up/down). */
export function moveParagraph(dir: -1 | 1): Command {
  return (state, dispatch) => {
    const cur = currentParagraph(state);
    if (!cur) return false;
    const $pos = state.doc.resolve(cur.pos);
    const parent = $pos.parent;
    const index = $pos.index();
    const target = index + dir;
    if (target < 0 || target >= parent.childCount) return false;
    const other = parent.child(target);
    const otherPos = dir < 0 ? cur.pos - other.nodeSize : cur.pos + cur.node.nodeSize;
    if (!dispatch) return true;
    const offset = state.selection.from - cur.pos;
    let tr = state.tr;
    if (dir < 0) {
      tr = tr.delete(cur.pos, cur.pos + cur.node.nodeSize).insert(otherPos, cur.node);
      tr = tr.setSelection(TextSelection.create(tr.doc, otherPos + offset));
    } else {
      tr = tr.delete(cur.pos, cur.pos + cur.node.nodeSize).insert(cur.pos + other.nodeSize, cur.node);
      tr = tr.setSelection(TextSelection.create(tr.doc, cur.pos + other.nodeSize + offset));
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** Delete to end of line/paragraph (Ctrl+K: line-delete-forward). */
export const deleteToParagraphEnd: Command = (state, dispatch) => {
  const $from = state.selection.$from;
  const end = $from.end();
  if ($from.pos === end) return false;
  dispatch?.(state.tr.delete($from.pos, end));
  return true;
};

/* ------------------------------------------------------------------ tables */

export function insertTable(rows: number, cols: number): Command {
  return (state, dispatch) => {
    const cell = (r: number, c: number) => {
      const attrs: [string, string][] = [['alignment', 'center'], ['valignment', 'top']];
      if (r === 0) attrs.push(['topline', 'true']);
      attrs.push(['bottomline', 'true']);
      if (c === 0) attrs.push(['leftline', 'true']);
      attrs.push(['rightline', 'true'], ['usebox', 'none']);
      return schema.nodes.table_cell.create({ attrs: JSON.stringify(attrs) }, schema.nodes.paragraph.create({ layout: 'Plain Layout' }));
    };
    const rowsN: PMNode[] = [];
    for (let r = 0; r < rows; r++) {
      const cells: PMNode[] = [];
      for (let c = 0; c < cols; c++) cells.push(cell(r, c));
      rowsN.push(schema.nodes.table_row.create({ attrs: '[]' }, Fragment.from(cells)));
    }
    const columns = Array.from({ length: cols }, () => [['alignment', 'center'], ['valignment', 'top']]);
    const table = schema.nodes.table.create({ attrs: JSON.stringify([['version', '3'], ['rows', String(rows)], ['columns', String(cols)]]), features: JSON.stringify([['tabularvalignment', 'middle']]), columns: JSON.stringify(columns) }, Fragment.from(rowsN));
    if (!dispatch) return true;
    let tr = state.tr.replaceSelectionWith(table, false);
    const pos = tr.selection.from - table.nodeSize;
    tr = tr.setSelection(TextSelection.create(tr.doc, pos + 4));
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** Set a LyX cell attribute (e.g. topline true, alignment left) on selected cells. */
/** The table, row and cell around the cursor with their indices. */
export interface TableContext {
  table: PMNode; tablePos: number; row: PMNode; rowPos: number; cell: PMNode; cellPos: number;
  rowIndex: number; colIndex: number; nrows: number; ncols: number;
}
export function tableContext(state: EditorState): TableContext | null {
  const $from = state.selection.$from;
  let cell: { node: PMNode; pos: number } | null = null, row: { node: PMNode; pos: number } | null = null, table: { node: PMNode; pos: number } | null = null;
  for (let d = $from.depth; d >= 0; d--) {
    const n = $from.node(d);
    if (n.type.name === 'table_cell' && !cell) cell = { node: n, pos: $from.before(d) };
    else if (n.type.name === 'table_row' && !row) row = { node: n, pos: $from.before(d) };
    else if (n.type.name === 'table' && !table) { table = { node: n, pos: $from.before(d) }; break; }
  }
  if (!cell || !row || !table) return null;
  let colIndex = 0, rowIndex = 0, ncols = 0;
  row.node.forEach((c, offset) => { if (row!.pos + 1 + offset < cell!.pos) colIndex += c.attrs.colspan ?? 1; });
  table.node.forEach((r, offset, i) => { if (table!.pos + 1 + offset === row!.pos) rowIndex = i; let n = 0; r.forEach(c => { n += c.attrs.colspan ?? 1; }); ncols = Math.max(ncols, n); });
  return { table: table.node, tablePos: table.pos, row: row.node, rowPos: row.pos, cell: cell.node, cellPos: cell.pos, rowIndex, colIndex, nrows: table.node.childCount, ncols };
}

function withAttr(attrs: [string, string][], key: string, value: string | null): [string, string][] {
  const out = attrs.map(a => [a[0], a[1]] as [string, string]);
  const i = out.findIndex(a => a[0] === key);
  if (value === null) { if (i >= 0) out.splice(i, 1); }
  else if (i >= 0) out[i] = [key, value];
  else { const ub = out.findIndex(a => a[0] === 'usebox'); out.splice(ub >= 0 ? ub : out.length, 0, [key, value]); }
  return out;
}
const jsonAttrs = (s: string): [string, string][] => { try { return JSON.parse(s || '[]'); } catch { return []; } };

export interface TableChanges { cell?: [string, string | null][]; column?: [string, string | null][]; row?: [string, string | null][]; table?: [string, string | null][] }

/** Apply the table-settings dialog in one transaction: cell attrs, column attrs (+ alignment of the
 *  column's cells, as LyX does), row attrs (lines go to the row's cells) and table features. */
export function setTableAttrs(ch: TableChanges): Command {
  return (state, dispatch) => {
    const ctx = tableContext(state);
    if (!ctx) return false;
    const tr = state.tr;
    const setCell = (pos: number, node: PMNode, kv: [string, string | null][]) => {
      let attrs = jsonAttrs(node.attrs.attrs);
      for (const [k, v] of kv) attrs = withAttr(attrs, k, v);
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, attrs: JSON.stringify(attrs) });
    };
    if (ch.cell?.length) setCell(ctx.cellPos, ctx.cell, ch.cell);
    if (ch.row?.length) {
      const lines = ch.row.filter(([k]) => /line$/.test(k));
      const rest = ch.row.filter(([k]) => !/line$/.test(k));
      if (lines.length) ctx.row.forEach((c, offset) => { const pos = ctx.rowPos + 1 + offset; setCell(pos, pos === ctx.cellPos && ch.cell?.length ? tr.doc.nodeAt(pos)! : c, lines); });
      if (rest.length) { let attrs = jsonAttrs(ctx.row.attrs.attrs); for (const [k, v] of rest) attrs = withAttr(attrs, k, v); tr.setNodeMarkup(ctx.rowPos, undefined, { ...ctx.row.attrs, attrs: JSON.stringify(attrs) }); }
    }
    if (ch.column?.length || ch.table?.length) {
      const columns: [string, string][][] = (() => { try { return JSON.parse(ctx.table.attrs.columns || '[]'); } catch { return []; } })();
      while (columns.length < ctx.ncols) columns.push([['alignment', 'center'], ['valignment', 'top']]);
      if (ch.column?.length) {
        columns[ctx.colIndex] = ch.column.reduce((a, [k, v]) => withAttr(a, k, v), columns[ctx.colIndex]);
        const align = ch.column.filter(([k]) => k === 'alignment' || k === 'valignment');
        if (align.length) ctx.table.forEach((r, roff) => {
          let ci = 0;
          r.forEach((c, coff) => { const pos = ctx.tablePos + 1 + roff + 1 + coff; if (ci === ctx.colIndex) setCell(pos, tr.doc.nodeAt(pos)!, align); ci += c.attrs.colspan ?? 1; });
        });
      }
      let features = jsonAttrs(ctx.table.attrs.features);
      for (const [k, v] of ch.table ?? []) features = withAttr(features, k, v);
      tr.setNodeMarkup(ctx.tablePos, undefined, { ...ctx.table.attrs, columns: JSON.stringify(columns), features: JSON.stringify(features) });
    }
    if (dispatch) dispatch(tr);
    return true;
  };
}

export function setCellAttr(key: string, value: string | null): Command {
  return (state, dispatch) => {
    const { from, to } = state.selection;
    const tr = state.tr;
    let any = false;
    const apply = (node: PMNode, pos: number) => {
      const attrs: [string, string][] = JSON.parse(node.attrs.attrs || '[]');
      const idx = attrs.findIndex(a => a[0] === key);
      if (value === null) { if (idx >= 0) attrs.splice(idx, 1); }
      else if (idx >= 0) attrs[idx] = [key, value];
      else {
        // keep LyX's attribute ordering roughly: insert before usebox
        const ub = attrs.findIndex(a => a[0] === 'usebox');
        attrs.splice(ub >= 0 ? ub : attrs.length, 0, [key, value]);
      }
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, attrs: JSON.stringify(attrs) });
      any = true;
    };
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (node.type.name === 'table_cell') { apply(node, pos); return false; }
      return true;
    });
    if (!any) {
      // cursor inside a cell
      const $from = state.selection.$from;
      for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === 'table_cell') { apply($from.node(d), $from.before(d)); break; }
    }
    if (!any) return false;
    dispatch?.(tr);
    return true;
  };
}

export function findMathView(view: EditorView, pos: number): MathInlineView | MathDisplayView | null {
  const dom = view.nodeDOM(pos) as any;
  return dom?.pmViewDesc?.spec ?? null;
}

export function selectionParentInset(state: EditorState): { node: PMNode; pos: number } | null {
  const $from = state.selection.$from;
  for (let d = $from.depth; d > 0; d--) {
    const n = $from.node(d);
    if (n.type.name === 'inset') return { node: n, pos: $from.before(d) };
  }
  const sel = state.selection;
  if (sel instanceof NodeSelection && sel.node.type.name === 'inset') return { node: sel.node, pos: sel.from };
  return null;
}

export function nearestNode(state: EditorState, types: string[]): { node: PMNode; pos: number } | null {
  const sel = state.selection;
  if (sel instanceof NodeSelection && types.includes(sel.node.type.name)) return { node: sel.node, pos: sel.from };
  const $from = sel.$from;
  const nb = $from.nodeBefore, na = $from.nodeAfter;
  if (na && types.includes(na.type.name)) return { node: na, pos: $from.pos };
  if (nb && types.includes(nb.type.name)) return { node: nb, pos: $from.pos - nb.nodeSize };
  for (let d = $from.depth; d > 0; d--) {
    const n = $from.node(d);
    if (types.includes(n.type.name)) return { node: n, pos: $from.before(d) };
  }
  return null;
}

export { splitBlock, Selection, type ResolvedPos };

/** LyX "dissolve inset": replace an inset by its content (paragraph contents joined inline). */
export function dissolveInset(pos: number): Command {
  return (state, dispatch) => {
    const node = state.doc.nodeAt(pos);
    if (!node || node.type.name !== 'inset') return false;
    if (!dispatch) return true;
    const content: PMNode[] = [];
    node.forEach((para, _o, i) => {
      if (i > 0 && content.length) content.push(state.schema.text(' '));
      para.forEach(c => content.push(c));
    });
    const tr = state.tr.replaceWith(pos, pos + node.nodeSize, content);
    dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(pos))));
    return true;
  };
}

/** Project-relative id of the child document referenced by an include command node. */
export function includeTarget(node: PMNode, project: string, docDir: string): string | null {
  if (node.type.name !== 'command' || node.attrs.cmd !== 'include') return null;
  let fn = '';
  try { fn = unquote(paramMap(JSON.parse(node.attrs.params || '[]')).get('filename')); } catch { return null; }
  if (!fn) return null;
  const parts = [...docDir.split('/').filter(Boolean), ...fn.split('/')];
  const out: string[] = [];
  for (const p of parts) { if (p === '..') out.pop(); else if (p !== '.' && p !== '') out.push(p); }
  return project + '/' + out.join('/');
}
