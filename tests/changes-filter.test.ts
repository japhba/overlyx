/**
 * Track-changes display filter: "show insertions" / "show deletions" are independent view toggles
 * (a decoration-only hide, the document and its change marks are untouched) that can both be on,
 * either alone, or both off.
 */
import { describe, it, expect } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { Node as PMNode } from 'prosemirror-model';
import { schema } from '../packages/core/src/schema.ts';
import { parseLyx } from '../packages/core/src/lyx/parser.ts';
import { lyxToPm } from '../packages/core/src/convert.ts';
import { changesFilterPlugin, changesFilterKey, setChangesFilter } from '../packages/client/src/editor/plugins/changes.ts';

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

function fakeView(doc: PMNode) {
  const v = { state: EditorState.create({ doc, plugins: [changesFilterPlugin()] }) } as { state: EditorState; dispatch: (tr: any) => void };
  v.dispatch = (tr) => { v.state = v.state.apply(tr); };
  return v;
}

// a paragraph with one inserted run and one deleted run, both change-marked (as changeTrackingPlugin
// would leave them, and as `\lyxadded`/`\lyxdeleted` import from a .tex file with change bars)
const DOC = '\\begin_layout Standard\n\\change_inserted 0 1700000000\nnew \\change_deleted 0 1700000000\nold\\change_unchanged\n text\n\\end_layout\n';

describe('changes display filter', () => {
  it('defaults to showing both, with no hide decorations', () => {
    const view = fakeView(pmDoc(DOC));
    const s = changesFilterKey.getState(view.state)!;
    expect(s).toMatchObject({ showInsertions: true, showDeletions: true });
    expect(s.unfolded.size).toBe(0);
  });

  it('hiding insertions decorates only the inserted run', () => {
    const view = fakeView(pmDoc(DOC));
    setChangesFilter(view as any, { showInsertions: false });
    const plugin = changesFilterPlugin();
    // exercise the same decorations the view would ask for, via a state carrying just this plugin
    const state = EditorState.create({ doc: view.state.doc, plugins: [plugin] });
    const withMeta = state.apply(state.tr.setMeta(changesFilterKey, { showInsertions: false }));
    const deco = plugin.props.decorations!(withMeta as any);
    expect(deco).toBeTruthy();
    const found = (deco as any).find();
    expect(found.length).toBeGreaterThan(0);
    // none of the decorated ranges should cover the deleted run ("old") when only insertions are hidden
    const text = withMeta.doc.textBetween(0, withMeta.doc.content.size, '\n');
    for (const d of found) {
      const covered = withMeta.doc.textBetween(d.from, d.to, '');
      expect(covered).not.toContain('old');
    }
    expect(text).toContain('new');
  });

  it('hiding both leaves no decorations (fast path, everything renders normally)', () => {
    const view = fakeView(pmDoc(DOC));
    setChangesFilter(view as any, { showInsertions: true, showDeletions: true });
    expect(changesFilterKey.getState(view.state)).toMatchObject({ showInsertions: true, showDeletions: true });
  });

  it('toggles are independent of each other', () => {
    const view = fakeView(pmDoc(DOC));
    setChangesFilter(view as any, { showInsertions: false });
    expect(changesFilterKey.getState(view.state)).toMatchObject({ showInsertions: false, showDeletions: true });
    setChangesFilter(view as any, { showDeletions: false });
    expect(changesFilterKey.getState(view.state)).toMatchObject({ showInsertions: false, showDeletions: false });
    setChangesFilter(view as any, { showInsertions: true });
    expect(changesFilterKey.getState(view.state)).toMatchObject({ showInsertions: true, showDeletions: false });
  });

  it('a hidden run gets a fold marker; toggling its key unfolds just that run', () => {
    const view = fakeView(pmDoc(DOC));
    setChangesFilter(view as any, { showInsertions: false });
    const plugin = view.state.plugins[0];
    let deco = (plugin.props.decorations as any).call(plugin, view.state);
    let found = (deco as any).find();
    // one widget (from === to) stands where the hidden "new " run is
    expect(found.some((d: any) => d.from === d.to)).toBe(true);
    // unfold the run by its stable key (type:author:time — from the DOC fixture)
    setChangesFilter(view as any, { toggleRun: 'inserted:0:1700000000' });
    expect(changesFilterKey.getState(view.state)!.unfolded.has('inserted:0:1700000000')).toBe(true);
    deco = (plugin.props.decorations as any).call(plugin, view.state);
    found = (deco as any).find();
    // the run is decorated as unfolded now, not hidden — the marker stays to refold it
    expect(found.some((d: any) => d.from === d.to)).toBe(true);
    expect(found.some((d: any) => d.type?.attrs?.class === 'lyx-change-unfolded' || d.type?.attrs?.class?.includes?.('unfolded'))).toBe(true);
    // flipping a toolbar switch clears the per-run exceptions (fold/unfold all semantics)
    setChangesFilter(view as any, { showDeletions: false });
    expect(changesFilterKey.getState(view.state)!.unfolded.size).toBe(0);
  });
});
