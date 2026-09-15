// @vitest-environment happy-dom
import { describe, expect, it, beforeEach } from 'vitest';
import { EditorState, TextSelection, type Command } from 'prosemirror-state';
import { Fragment, Slice } from 'prosemirror-model';
import { schema } from '../packages/core/src/schema.ts';
import { changeTrackingPlugin, rejectAllChanges, acceptAllChanges, allChanges, resolveSelectionChanges } from '../packages/client/src/editor/plugins/changes.ts';
import { editorContext } from '../packages/client/src/editor/context.ts';
import { findPlugin, findKey, setQuery } from '../packages/client/src/editor/plugins/find.ts';
import { lyxToPmNode, pmToLyxBody } from '../packages/core/src/index.ts';
import { parseTex, writeTex } from '../packages/core/src/tex/index.ts';
import * as Y from 'yjs';
import { snapshotCovers } from '../packages/client/src/editor/savedstate.ts';
import * as tables from '../packages/client/src/editor/tablecommands.ts';
import { deleteRow as pmDeleteRow, addColumnAfter } from 'prosemirror-tables';
import { referenceTargets, referenceTransaction } from '../packages/client/src/editor/references.ts';

const p = (text: string) => schema.nodes.paragraph.create({ layout: 'Standard' }, text ? schema.text(text) : null);
const stateOf = (...text: string[]) => EditorState.create({ doc: schema.nodes.doc.create(null, text.map(p)), plugins: [changeTrackingPlugin()] });
const run = (state: EditorState, cmd: Command) => { cmd(state, tr => { state = state.apply(tr); }); return state; };

describe('review preserves the original', () => {
  beforeEach(() => { editorContext.trackChanges = true; editorContext.changeAuthorId = 7; });
  it('rejects selection replacement back to the exact original', () => {
    const original = stateOf('Original sentence.');
    const changed = original.apply(original.tr.insertText('Revised', 1, 9));
    expect(run(changed, rejectAllChanges()).doc.toJSON()).toEqual(original.doc.toJSON());
    expect(run(changed, acceptAllChanges()).doc.textContent).toBe('Revised sentence.');
  });
  it('tracks cut transactions', () => {
    const original = stateOf('Cut this text.');
    const changed = original.apply(original.tr.delete(1, 10));
    expect(run(changed, rejectAllChanges()).doc.toJSON()).toEqual(original.doc.toJSON());
    expect(run(changed, acceptAllChanges()).doc.textContent).toBe('text.');
  });
  it('rejects an inserted paragraph boundary', () => {
    const original = stateOf('Hello world');
    const changed = original.apply(original.tr.split(6));
    expect(run(changed, rejectAllChanges()).doc.toJSON()).toEqual(original.doc.toJSON());
    expect(run(changed, acceptAllChanges()).doc.childCount).toBe(2);
  });
  it('restores a joined paragraph boundary', () => {
    const original = stateOf('Hello', 'world');
    const changed = original.apply(original.tr.join(7));
    expect(run(changed, rejectAllChanges()).doc.toJSON()).toEqual(original.doc.toJSON());
    expect(run(changed, acceptAllChanges()).doc.textContent).toBe('Helloworld');
    expect(run(changed, acceptAllChanges()).doc.childCount).toBe(1);
  });
  it('cancels an inserted paragraph break when it is joined again', () => {
    const original = stateOf('Hello world');
    const split = original.apply(original.tr.split(6));
    const joined = split.apply(split.tr.join(7));
    expect(joined.doc.toJSON()).toEqual(original.doc.toJSON());
    expect(allChanges(joined.doc)).toEqual([]);
  });
  it('navigates and rejects a paragraph break independently', () => {
    const original = stateOf('Hello world');
    let changed = original.apply(original.tr.split(6));
    const [boundary] = allChanges(changed.doc);
    expect(boundary.boundary).toBe(true);
    changed = changed.apply(changed.tr.setSelection(TextSelection.create(changed.doc, boundary.from, boundary.to)));
    expect(run(changed, resolveSelectionChanges(false)).doc.toJSON()).toEqual(original.doc.toJSON());
  });
  it('rejects replacement across paragraphs', () => {
    const original = stateOf('First paragraph', 'Second paragraph');
    const changed = original.apply(original.tr.insertText('New', 4, 24));
    expect(run(changed, rejectAllChanges()).doc.toJSON()).toEqual(original.doc.toJSON());
  });
  it.each([['Original sentence.'], ['Original paragraph', 'Second paragraph']])('reviews a paste containing multiple paragraphs (%s)', (...text) => {
    let original = stateOf(...text);
    original = original.apply(original.tr.setSelection(TextSelection.create(original.doc, 1, text.length > 1 ? 26 : 9)));
    const paste = original.tr.replaceSelection(new Slice(Fragment.from([p('First pasted paragraph'), p('Second pasted paragraph')]), 0, 0));
    const changed = original.apply(paste);
    expect(run(changed, rejectAllChanges()).doc.toJSON()).toEqual(original.doc.toJSON());
    expect(run(changed, acceptAllChanges()).doc.toJSON()).toEqual(paste.doc.toJSON());
  });
  it.each([tables.appendRow, tables.appendColumn, tables.deleteRow, tables.deleteColumn, pmDeleteRow, addColumnAfter])('rejects table structure changes without losing the original grid', command => {
    const parsed = parseTex(String.raw`\begin{tabular}{cc}A & B\\ C & D\end{tabular}`);
    let original = EditorState.create({ doc: lyxToPmNode(parsed.doc), plugins: [changeTrackingPlugin()] });
    let cell = 0;
    original.doc.descendants((node, pos) => { if (!cell && node.isText) cell = pos; });
    original = original.apply(original.tr.setSelection(TextSelection.create(original.doc, cell)));
    const changed = run(original, command);
    expect(changed.doc.eq(original.doc)).toBe(false);
    expect(run(changed, rejectAllChanges()).doc.toJSON()).toEqual(original.doc.toJSON());
    let count = 0; run(changed, acceptAllChanges()).doc.descendants(n => { if (n.type.name === 'table') count++; });
    expect(count).toBe(1);
  });
});

it('a delayed save cannot confirm newer insertions or deletions', () => {
  const d = new Y.Doc();
  const t = d.getText('text'); t.insert(0, 'A');
  const saved = Y.snapshot(d);
  t.insert(1, 'B');
  expect(snapshotCovers(saved, Y.snapshot(d))).toBe(false);
  const beforeDelete = Y.snapshot(d); t.delete(0, 1);
  expect(snapshotCovers(beforeDelete, Y.snapshot(d))).toBe(false);
  expect(snapshotCovers(Y.snapshot(d), saved)).toBe(true);
  d.destroy();
});

it('find visits footnotes and table cells, and searches each formula once', () => {
  const parsed = parseTex(String.raw`\documentclass{article}\begin{document}needle\footnote{needle $needle$}\begin{tabular}{c}needle\end{tabular}\end{document}`);
  let state = EditorState.create({ doc: lyxToPmNode(parsed.doc), plugins: [findPlugin()] });
  const view = { get state() { return state; }, dispatch(tr: any) { state = state.apply(tr); } } as any;
  setQuery(view, { query: 'needle', searchMath: true });
  expect(findKey.getState(state)!.matches).toHaveLength(4);
});

it('creates unique heading labels and a reference atomically at the writing cursor', () => {
  editorContext.trackChanges = false;
  const parsed = parseTex(String.raw`\section{Introduction}\label{sec:introduction} Text.

\section{Introduction}

Write here.`);
  let state = EditorState.create({ doc: lyxToPmNode(parsed.doc) });
  state = state.apply(state.tr.setSelection(TextSelection.atEnd(state.doc)));
  const targets = referenceTargets(state.doc);
  const target = targets.find(t => !t.label)!;
  expect(target).toBeDefined();
  state = state.apply(referenceTransaction(state, target.key, 'cref', { targets }));
  const refs: string[] = [];
  state.doc.descendants(n => { if (n.type.name === 'command') refs.push(n.attrs.params); });
  expect(refs.some(r => r.includes('sec:introduction-2'))).toBe(true);
  expect(state.doc.lastChild!.lastChild!.attrs.cmd).toBe('ref');
  expect(state.doc.lastChild!.lastChild!.attrs.params).toContain('sec:introduction-2');
});

it.each([String.raw`\[a=b\]`, String.raw`$$a=b$$`, String.raw`\begin{align*}a&=b\\c&=d\end{align*}`])('creates numbered references to an unlabelled equation: %s', body => {
  const parsed = parseTex(body + '\n\nWrite here.');
  let state = EditorState.create({ doc: lyxToPmNode(parsed.doc) });
  state = state.apply(state.tr.setSelection(TextSelection.atEnd(state.doc)));
  const targets = referenceTargets(state.doc);
  const target = targets.find(t => t.kind === 'equation')!;
  expect(target).toBeDefined();
  state = state.apply(referenceTransaction(state, target.key, 'eqref', { targets }));
  const text = writeTex({ ...parsed.doc, body: pmToLyxBody(state.doc.toJSON()) }).text;
  const label = /\\label\{([^}]+)\}/.exec(text)?.[1];
  expect(label).toBeDefined();
  expect(text).toContain('\\eqref{' + label + '}');
  expect(text).toMatch(/\\begin\{(?:equation|align)\}/);
});
