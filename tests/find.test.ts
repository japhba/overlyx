/**
 * Advanced find & replace: whole words, regular expressions (with $1 back-references on replace),
 * search inside math formulas, and restricting the search to the current selection.
 */
import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { Node as PMNode } from 'prosemirror-model';
import { schema } from '../packages/core/src/schema.ts';
import { parseLyx } from '../packages/core/src/lyx/parser.ts';
import { lyxToPm } from '../packages/core/src/convert.ts';
import { findPlugin, findKey, setQuery, findNext, replaceCurrent, replaceAll } from '../packages/client/src/editor/plugins/find.ts';

const HEAD = `#LyX 2.5 created this file. For more info see https://www.lyx.org/
\\lyxformat 643
\\begin_document
\\begin_header
\\textclass article
\\end_header

\\begin_body
`;
const TAIL = `
\\end_body
\\end_document
`;

function pmDoc(body: string): PMNode {
  return PMNode.fromJSON(schema, lyxToPm(parseLyx(HEAD + body + TAIL)));
}

/** A minimal stand-in for EditorView: only .state / .dispatch are used by the find module. */
function fakeView(doc: PMNode) {
  const v = { state: EditorState.create({ doc, plugins: [findPlugin()] }) } as { state: EditorState; dispatch: (tr: any) => void };
  v.dispatch = (tr) => { v.state = v.state.apply(tr); };
  return v;
}

describe('find & replace', () => {
  it('plain search finds every occurrence, case-insensitively by default', () => {
    const view = fakeView(pmDoc('\\begin_layout Standard\nfoo Foo FOO bar\n\\end_layout\n'));
    setQuery(view as any, { query: 'foo' });
    expect(findKey.getState(view.state)!.matches).toHaveLength(3);
  });

  it('case sensitive narrows the match set', () => {
    const view = fakeView(pmDoc('\\begin_layout Standard\nfoo Foo FOO\n\\end_layout\n'));
    setQuery(view as any, { query: 'Foo', caseSensitive: true });
    expect(findKey.getState(view.state)!.matches).toHaveLength(1);
  });

  it('whole word excludes substrings inside larger words', () => {
    const view = fakeView(pmDoc('\\begin_layout Standard\ncat catalog concatenate\n\\end_layout\n'));
    setQuery(view as any, { query: 'cat', wholeWord: true });
    expect(findKey.getState(view.state)!.matches).toHaveLength(1);
  });

  it('regex mode matches a pattern and reports an error for an invalid one', () => {
    const view = fakeView(pmDoc('\\begin_layout Standard\nfoo123 bar456 baz\n\\end_layout\n'));
    setQuery(view as any, { query: '[a-z]+\\d+', regex: true });
    expect(findKey.getState(view.state)!.matches).toHaveLength(2);
    setQuery(view as any, { query: '[a-z+', regex: true });
    expect(findKey.getState(view.state)!.error).toBeTruthy();
    expect(findKey.getState(view.state)!.matches).toHaveLength(0);
  });

  it('regex replace resolves $1 back-references', () => {
    const view = fakeView(pmDoc('\\begin_layout Standard\nJohn Smith\n\\end_layout\n'));
    setQuery(view as any, { query: '(\\w+) (\\w+)', regex: true });
    replaceCurrent(view as any, '$2 $1');
    expect(view.state.doc.textContent).toContain('Smith John');
  });

  it('search math finds text inside formula latex and replace edits the latex attr', () => {
    const view = fakeView(pmDoc('\\begin_layout Standard\nSee\n\\begin_inset Formula $\\alpha + \\beta$\n\\end_inset\n\n here.\n\\end_layout\n'));
    setQuery(view as any, { query: 'alpha', searchMath: true });
    const s = findKey.getState(view.state)!;
    expect(s.matches).toHaveLength(1);
    expect(s.matches[0].kind).toBe('math');
    replaceCurrent(view as any, 'gamma');
    let latex = '';
    view.state.doc.descendants(n => { if (n.type.name === 'math_inline') latex = n.attrs.latex; return true; });
    expect(latex).toContain('gamma');
    expect(latex).not.toContain('alpha');
  });

  it('without search math, formulas are not matched', () => {
    const view = fakeView(pmDoc('\\begin_layout Standard\nSee\n\\begin_inset Formula $\\alpha$\n\\end_inset\n\n here.\n\\end_layout\n'));
    setQuery(view as any, { query: 'alpha' });
    expect(findKey.getState(view.state)!.matches).toHaveLength(0);
  });

  it('replace all replaces every match, including several occurrences inside one formula', () => {
    const view = fakeView(pmDoc('\\begin_layout Standard\nx x x\n\\begin_inset Formula $x + x$\n\\end_inset\n\n\n\\end_layout\n'));
    setQuery(view as any, { query: 'x', wholeWord: true, searchMath: true });
    const n = replaceAll(view as any, 'y');
    expect(n).toBe(5);
    let latex = '';
    view.state.doc.descendants(n2 => { if (n2.type.name === 'math_inline') latex = n2.attrs.latex; return true; });
    expect(latex).toBe('y + y');
    expect(view.state.doc.textContent.includes('x')).toBe(false);
  });

  it('findNext wraps around and selects the match', () => {
    const view = fakeView(pmDoc('\\begin_layout Standard\nfoo bar foo\n\\end_layout\n'));
    setQuery(view as any, { query: 'foo' });
    findNext(view as any, 1);
    const first = view.state.selection.from;
    findNext(view as any, 1);
    findNext(view as any, 1); // wraps back to the first match
    expect(view.state.selection.from).toBe(first);
  });

  it('restricting to the selection only matches inside it', () => {
    const view = fakeView(pmDoc('\\begin_layout Standard\nfoo bar\n\\end_layout\n\n\\begin_layout Standard\nfoo baz\n\\end_layout\n'));
    // select just the first paragraph
    const p1end = view.state.doc.child(0).nodeSize;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, p1end - 1)));
    setQuery(view as any, { query: 'foo', selectionOnly: true, useSelection: true } as any);
    expect(findKey.getState(view.state)!.matches).toHaveLength(1);
  });
});
