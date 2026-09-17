// @vitest-environment happy-dom
/**
 * The web client and the VS Code extension are two shells around ONE editor: the plugins, node
 * views and view handlers come from client/src/editor/assembly.ts, the LyX toolbars from
 * client/src/app/toolbars.tsx, the document helpers from client/src/app/shellutil.tsx. Before
 * that, each shell kept its own copy and they drifted apart (the extension lacked autocorrect,
 * markdown headings, image paste, the delimiter buttons, …). These checks fail as soon as a shell
 * grows an editor or a toolbar of its own again — shell-specific buttons belong in the slots.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { EditorState } from 'prosemirror-state';
import { schema } from '../packages/core/src/schema.ts';
import { assemblePlugins, editorViewProps, editorNodeViews } from '../packages/client/src/editor/assembly.ts';
import { buildToolbars, type ToolbarContext } from '../packages/client/src/app/toolbars.tsx';
import type { ToolButton } from '../packages/client/src/app/Toolbar.tsx';

const read = (p: string) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const SHELLS = { web: 'packages/client/src/app/App.tsx', vscode: 'packages/vscode/src/webview/EditorShell.tsx' };
const EDITORS = { web: 'packages/client/src/editor/editor.ts', vscode: 'packages/vscode/src/webview/localEditor.ts' };

describe('one editor assembly for both front ends', () => {
  // what only assembly.ts may do: instantiate editor plugins, node views and view handlers
  const ASSEMBLY_ONLY = [
    'numberingPlugin(', 'marginPlugin(', 'changeTrackingPlugin(', 'changesFilterPlugin(', 'lyxKeymap(', 'chordPlugin(', 'spellPlugin(',
    'markdownRulesPlugin(', 'autocorrectPlugin(', 'dragSelectPlugin(', 'findPlugin(', 'fontCarryPlugin(', 'insetCaretPlugin(', 'mirrorCaretPlugin(',
    'pasteTargetsPlugin(', 'aiRewritePlugin(', 'aiCompletePlugin(', 'gapCursor(', 'dropCursor(', 'tableEditing(', 'macroDefsPlugin(',
    'handlePaste', 'handleDrop', 'handleClickOn', 'handleDoubleClickOn', 'handleDOMEvents', 'nodeViews:', 'new MathInlineView', 'new InsetView',
    'clipboardTextSerializer', 'function guarded',
  ];
  for (const [name, file] of Object.entries(EDITORS)) {
    it(`the ${name} editor is built from assemblePlugins / editorViewProps / installEditorDom`, () => {
      const src = read(file);
      expect(src).toMatch(/assemblePlugins\(\{/);
      expect(src).toMatch(/\.\.\.editorViewProps\(\{/);
      expect(src).toMatch(/installEditorDom\(view, /);
      expect(src).toMatch(/editorAttributes\(/);
      expect(src).toMatch(/dispatchTransactionProp\(/);
      for (const s of ASSEMBLY_ONLY) expect(src, `${file} must not define ${s} itself — add it to editor/assembly.ts`).not.toContain(s);
    });
  }

  it('the assembled plugin set is complete and constructs a state', () => {
    const plugins = assemblePlugins({ sync: [], marginMode: false, getView: () => null });
    // the sync plugins the front end provides come first
    const marker = { key: 'marker$' } as any;
    const withSync = assemblePlugins({ sync: [marker], marginMode: true, getView: () => null });
    expect(withSync[0]).toBe(marker);
    expect(withSync.length).toBe(plugins.length + 1);
    // ink is optional (web master editor only) and slots in after the margin plugin
    const withInk = assemblePlugins({ sync: [], marginMode: false, ink: marker, getView: () => null });
    expect(withInk.length).toBe(plugins.length + 1);
    expect(plugins.length).toBeGreaterThanOrEqual(22);
    const state = EditorState.create({ schema, plugins });
    expect(state.plugins.length).toBe(plugins.length);
  });

  it('the view props cover every LyX node type and every interaction', () => {
    const nv = editorNodeViews();
    expect(Object.keys(nv).sort()).toEqual(['command', 'graphics', 'inset', 'leaf', 'macro', 'math_display', 'math_inline']);
    const props = editorViewProps({ docId: 'p/a.tex' });
    for (const k of ['nodeViews', 'clipboardTextSerializer', 'handleDoubleClickOn', 'handleClickOn', 'handleDOMEvents', 'handlePaste', 'handleDrop']) expect(props, k).toHaveProperty(k);
    expect(Object.keys(props.handleDOMEvents!).sort()).toEqual(['contextmenu', 'keyup']);
  });
});

describe('one toolbar definition for both front ends', () => {
  // ids of LyX's toolbars: a shell may not declare them itself
  const SHARED_IDS = ['spellcheck', 'undo', 'find', 'emph', 'textcolor', 'math', 'graphics', 'margin', 'tb-math', 'pdf', 'outputsync', 'l-section', 'label', 'nomencl', 'footnote', 'paragraph',
    'm-display', 'm-frac', 'm-dangle', 'm-delims', 'm-delim-grow', 'm-delim-shrink', 'm-matrix', 't-addrow', 't-settings', 'r-track', 'r-output', 'r-acceptall', 'r-comment'];
  for (const [name, file] of Object.entries(SHELLS)) {
    it(`the ${name} shell takes its toolbars and helpers from the shared modules`, () => {
      const src = read(file);
      expect(src).toMatch(/buildToolbars\(\{/);
      for (const id of SHARED_IDS) expect(src, `${file} declares the toolbar button '${id}' itself — it belongs in app/toolbars.tsx`).not.toContain(`id: '${id}'`);
      for (const fn of ['function bcp47', 'function suggestLabel', 'function applyAuthorColors', 'function hashAuthor', 'function LayoutPicker', 'function debounce', 'MATH_PANEL_PREVIEW: Record', 'const textStylesPalette', 'const tbTogglePalette', 'const marksAtCursor'])
        expect(src, `${file} keeps its own ${fn} — use app/shellutil.tsx / app/toolbars.tsx`).not.toContain(fn);
      // zoom scales the font through --editor-zoom in both shells; CSS `zoom` on a container breaks
      // mouse hit testing (the extension's drags stopped following the pointer when zoomed)
      expect(src, `${file} must zoom through applyEditorZoom (app/shellutil.tsx)`).toMatch(/applyEditorZoom\(zoom\)/);
      expect(src, `${file} must not use CSS zoom`).not.toMatch(/style=\{\{\s*zoom|--editor-zoom/);
      // the sun/moon switch (with its right-click tone menu) is MenuBar's ThemeToggle in both shells
      expect(src, `${file} builds its own theme switch — use ThemeToggle from app/MenuBar.tsx`).not.toContain('class="theme-toggle"');
      // presentation mode (View menu entry from editorViewMenu.ts, keys from the hook) is one module for both
      expect(src, `${file} must install presentation mode with usePresentation() (app/presentation.ts)`).toContain('usePresentation()');
      expect(src, `${file} must not handle data-presenting itself`).not.toContain('presenting');
    });
  }

  const ctx = (slots?: ToolbarContext['slots'], extra: Partial<ToolbarContext> = {}): ToolbarContext => ({
    view: null, docId: 'p/a.tex', meta: null, headerLines: [], layout: 'Standard', mathField: null, tracking: false, marginMode: false,
    prefs: { spellcheck: true, spellEngine: 'browser', aiCompleteText: false, aiCompleteMath: false, aiButton: false } as any,
    tbMode: () => 'auto', setToolbar: () => {}, run: () => {}, runView: () => {}, mathExec: () => {}, mathPanels: [{ id: 'latex_greek', title: 'Greek', palette: { title: 'Greek', items: [] } }],
    clipboard: () => {}, setDialog: () => {}, openFind: () => {}, notify: () => {}, toggleTracking: () => {}, toggleMargin: () => {}, build: () => {}, syncToPdf: () => {},
    slots, ...extra,
  });
  const ids = (groups: ToolButton[][]) => groups.flat().map(b => b.id);

  it('builds all seven LyX toolbars with unique ids, the same for every shell', () => {
    const tb = buildToolbars(ctx());
    const all = [...ids(tb.standard), ...ids(tb.viewUpdate), ...ids(tb.extra), ...ids(tb.math), ...ids(tb.mathPanels), ...ids(tb.table), ...ids(tb.review)];
    expect(new Set(all).size).toBe(all.length);
    for (const id of SHARED_IDS) expect(all, id).toContain(id);
    expect(ids(tb.mathPanels)).toEqual(['mp-latex_greek']);
    // without a formula, a table or tracked changes the contextual toolbars stay hidden in automatic mode
    expect([tb.showMath, tb.showTable, tb.showReview]).toEqual([false, false, false]);
    expect(buildToolbars(ctx(undefined, { tracking: true })).showReview).toBe(true);
    expect(buildToolbars(ctx(undefined, { tbMode: () => 'on' })).showMath).toBe(true);
  });

  it('shell-specific buttons land in their slots, around the shared ones', () => {
    const b = (id: string): ToolButton => ({ id, title: id, icon: id, action: () => {} });
    const tb = buildToolbars(ctx({ leading: [b('new'), b('open')], navigation: [b('navback')], sidebars: [b('outline')], tools: [b('ink'), b('comments-panel')], pdf: [b('pdfmaster')] }, { updatePdf: () => {} }));
    expect(tb.standard[0].map(x => x.id)).toEqual(['new', 'open']);
    const editing = ids([tb.standard[2]]);
    expect(editing.slice(-2)).toEqual(['find', 'navback']);
    const last = ids([tb.standard[tb.standard.length - 1]]);
    expect(last).toEqual(['outline', 'margin', 'ink', 'comments-panel', 'tb-math', 'tb-table', 'tb-review']);
    expect(ids([tb.viewUpdate[0]])).toEqual(['pdf', 'update', 'pdfmaster']);
    // no slots, no Update: the extension's view/update row
    expect(ids([buildToolbars(ctx()).viewUpdate[0]])).toEqual(['pdf']);
    expect(buildToolbars(ctx()).standard[0].map(x => x.id)).toEqual(['spellcheck']);
  });

  it('the review toolbar reflects the header (Show changes in output)', () => {
    const on = buildToolbars(ctx(undefined, { headerLines: ['\\output_changes true'] }));
    expect(on.review[0].find(x => x.id === 'r-output')!.active).toBe(true);
    expect(buildToolbars(ctx()).review[0].find(x => x.id === 'r-output')!.active).toBe(false);
  });
});
