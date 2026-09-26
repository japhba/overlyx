/**
 * The editor assembly shared by every OverLyX front end — the web client's createEditor
 * (editor.ts: a Yjs document synced with the server) and the VS Code webview's createLocalEditor
 * (packages/vscode/src/webview/localEditor.ts: a local Y.Doc fed from the .tex file). It holds
 * the ProseMirror plugins in their order, the node views, the view props (clicks, paste, drop,
 * context menu, keyboard) and the DOM wiring of a view. A front end adds only what differs: how
 * the document is synced and what happens on selection changes.
 *
 * Anything that belongs to editing itself goes here, not into one of the front ends: a plugin or a
 * handler added to one shell only is exactly the divergence this file exists to prevent
 * (tests/parity.test.ts checks that neither front end assembles an editor of its own).
 */
import { Plugin, type EditorState, type Transaction } from 'prosemirror-state';
import type { EditorView, EditorProps, NodeView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { gapCursor } from 'prosemirror-gapcursor';
import { dropCursor } from 'prosemirror-dropcursor';
import { tableEditing } from 'prosemirror-tables';
import { ySyncPluginKey } from 'y-prosemirror';
import { unquote, paramMap, projectOfDoc, docDirOf } from '@overlyx/core';
import { lyxKeymap, chordPlugin } from './keymap';
import { numberingPlugin } from './plugins/numbering';
import { foldPlugin } from './plugins/fold';
import { marginPlugin } from './plugins/margin';
import { changeTrackingPlugin, changesFilterPlugin } from './plugins/changes';
import { fontCarryPlugin } from './plugins/fontcarry';
import { insetCaretPlugin } from './plugins/insetcaret';
import { envFocusPlugin } from './plugins/envfocus';
import { dragSelectPlugin } from './plugins/dragselect';
import { findPlugin } from './plugins/find';
import { mirrorCaretPlugin } from './plugins/mirrorcaret';
import { markdownRulesPlugin } from './plugins/mdrules';
import { pasteTargetsPlugin, pasteLatex } from './plugins/paste';
import { autocorrectPlugin } from './spell/autocorrect';
import { spellPlugin, misspelledAt, spellSuggest } from './spell/plugin';
import { aiRewritePlugin } from './ai/rewrite';
import { aiCompletePlugin } from './ai/complete';
import { macroDefsPlugin } from './macrodefs';
import { usagePlugin } from './plugins/usage';
import { MathInlineView, MathDisplayView, MacroView } from './nodeviews/math';
import { InsetView } from './nodeviews/inset';
import { GraphicsView, CommandView, LeafView } from './nodeviews/leaf';
import { editorContext, viewDocDir, viewProject } from './context';
import { imageFiles, insertImageFiles, isSvgMarkup, looksLikeImageFileName, svgFile } from './imagepaste';
import { sliceText } from './cliptext';
import { showContextMenu } from './contextmenu';
import { editorContextMenu } from './editormenu';
import { includeTarget } from './commands';

/**
 * A node view that throws (a malformed attribute that arrived over the wire, a rendering bug) must
 * not take the whole editor down: it is replaced by a marker that shows the error, and an `update`
 * that throws makes ProseMirror re-create the view instead of propagating.
 */
export function guarded(node: PMNode, make: () => NodeView): NodeView {
  let v: NodeView;
  try { v = make(); }
  catch (e) {
    console.error(`node view for ${node.type.name} failed`, e, node.toJSON());
    const dom = document.createElement(node.isInline ? 'span' : 'div');
    dom.className = 'lyx-broken';
    dom.title = `This ${node.type.name} could not be displayed: ${String(e)}`;
    dom.textContent = `⚠ ${node.type.name}`;
    dom.contentEditable = 'false';
    return { dom, update: () => false };
  }
  const update = v.update?.bind(v);
  if (update) v.update = (n, decos, inner) => { try { return update(n, decos, inner); } catch (e) { console.error(`node view update for ${node.type.name} failed`, e); return false; } };
  return v;
}

/** The node views of the LyX schema (formulas, macros, insets, graphics, commands, leaves). */
export function editorNodeViews(): NonNullable<EditorProps['nodeViews']> {
  return {
    math_inline: (node, view, getPos) => guarded(node, () => new MathInlineView(node, view, getPos as () => number | undefined)),
    math_display: (node, view, getPos) => guarded(node, () => new MathDisplayView(node, view, getPos as () => number | undefined)),
    macro: (node, view, getPos) => guarded(node, () => new MacroView(node, view, getPos as () => number | undefined)),
    inset: (node, view, getPos) => guarded(node, () => new InsetView(node, view, getPos as () => number | undefined)),
    graphics: (node, view, getPos) => guarded(node, () => new GraphicsView(node, view, getPos as () => number | undefined)),
    command: (node, view, getPos) => guarded(node, () => new CommandView(node, view, getPos as () => number | undefined)),
    leaf: (node, view, getPos) => guarded(node, () => new LeafView(node, view, getPos as () => number | undefined)),
  };
}

/** The editable element's attributes; the browser's spell checker only when it is the chosen engine (two sets of underlines otherwise). */
export function editorAttributes(child: boolean, p: { spellcheck: boolean; spellEngine: string }): Record<string, string> {
  return { class: 'lyx-editor' + (child ? ' lyx-editor-child' : ''), spellcheck: p.spellcheck && p.spellEngine === 'browser' ? 'true' : 'false' };
}

export interface AssemblyOptions {
  /** how the document is synced: the front end's ySyncPlugin, yCursorPlugin and yUndoPlugin, in that order (they come first) */
  sync: Plugin[];
  marginMode: boolean;
  /** margin ink — only where a collaboration awareness carries the strokes (the web client's master editor) */
  ink?: Plugin | null;
  /** the view once it exists (macro definitions are registered per view) */
  getView: () => EditorView | null;
  /** every state update that moved the selection or changed the document */
  onUpdate?: (view: EditorView, info: { docChanged: boolean; selectionChanged: boolean }) => void;
}

/** The ProseMirror plugins of an OverLyX editor, in the order the key bindings depend on. */
export function assemblePlugins(o: AssemblyOptions): Plugin[] {
  return [
    ...o.sync,
    // AI preview / ghost text come first: their Tab / Escape must win over the LyX bindings and table navigation
    aiRewritePlugin(),
    aiCompletePlugin(),
    spellPlugin(),
    markdownRulesPlugin(),   // `- ` / `1. ` / `# ` at a paragraph start, before autocorrect looks at the space
    autocorrectPlugin(),
    chordPlugin(),
    foldPlugin(),   // section folding (before the keymap: ↑ / ↓ beside a fold skip the hidden text)
    lyxKeymap(),
    fontCarryPlugin(),
    insetCaretPlugin(),
    dragSelectPlugin(),
    gapCursor(),
    dropCursor({ color: '#3b6ea5' }),
    tableEditing(),
    envFocusPlugin(),
    numberingPlugin(),
    marginPlugin(o.marginMode),
    ...(o.ink ? [o.ink] : []),
    changeTrackingPlugin(),
    changesFilterPlugin(),
    findPlugin(),
    pasteTargetsPlugin(),
    mirrorCaretPlugin(),
    macroDefsPlugin(o.getView),
    new Plugin({
      view: () => ({
        update: (view, prev: EditorState) => {
          const docChanged = prev.doc !== view.state.doc;
          const selectionChanged = !prev.selection.eq(view.state.selection);
          if (docChanged || selectionChanged) o.onUpdate?.(view, { docChanged, selectionChanged });
        },
      }),
    }),
    usagePlugin(),   // last: a key nothing above handled is an unanswered request (usage statistics)
  ];
}

export interface ViewPropsOptions {
  docId: string;
  onFocus?: (view: EditorView) => void;
  /** a viewer of a shared project: nothing typed, pasted or dropped may change the document */
  viewOnly?: () => boolean;
}

/**
 * Publish the DOM selection to ProseMirror before it can act on a stale one. Native arrow
 * movement precedes `selectionchange`; the same goes for a remote update or a decoration-only
 * transaction dispatched between a mouse click and the browser's (asynchronous) event.
 */
export function flushDomSelection(view: EditorView | null | undefined): void {
  try { (view as unknown as { domObserver?: { flush(): void } } | null)?.domObserver?.flush(); } catch { /* the view is closing */ }
}

/**
 * Decoration-only transactions (y-prosemirror re-renders the remote cursors from a setTimeout
 * after every awareness change) make ProseMirror write its *state* selection back into the DOM.
 * Right after a mouse click the DOM selection is ahead of the state (the browser's
 * `selectionchange` event has not been processed yet), so the click would be lost: read the
 * DOM selection first and re-create the transaction on the fresh state. Viewers cannot edit (the
 * server drops their updates anyway).
 */
export function dispatchTransactionProp(getView: () => EditorView, viewOnly: () => boolean): (tr: Transaction) => void {
  let flushing = false;
  return (tr: Transaction) => {
    const view = getView();
    // Awareness callbacks can outlive a view replaced by a live update.
    if (view.isDestroyed) return;
    if (viewOnly() && tr.docChanged && !tr.getMeta(ySyncPluginKey)) return;
    if (!flushing && !tr.docChanged && tr.selectionSet === false && tr.selection.eq(view.state.selection)) {
      flushing = true;
      const before = view.state;
      try { flushDomSelection(view); } finally { flushing = false; }
      if (view.state !== before) {
        const fresh = view.state.tr;
        for (const [k, v] of Object.entries((tr as unknown as { meta: Record<string, unknown> }).meta)) fresh.setMeta(k, v);
        tr = fresh;
      }
    }
    view.updateState(view.state.apply(tr));
  };
}

/**
 * The view props every OverLyX editor shares: node views, the text/plain clipboard, double-click
 * and Ctrl+click on references, links and child documents, the context menu (with spelling
 * suggestions), paste (images, SVG markup, LaTeX parsed into structure, plain text as paragraphs)
 * and dropped image files.
 */
export function editorViewProps(o: ViewPropsOptions): Pick<EditorProps, 'nodeViews' | 'clipboardTextSerializer' | 'handleDoubleClickOn' | 'handleClickOn' | 'handleDOMEvents' | 'handlePaste' | 'handleDrop'> {
  const viewOnly = () => o.viewOnly?.() ?? false;
  return {
    nodeViews: editorNodeViews(),
    // text/plain for the clipboard: formulas as $…$, references as \ref{…}, … (see cliptext.ts)
    clipboardTextSerializer: sliceText,
    handleDoubleClickOn(view, _pos, node, nodePos) {
      if (node.type.name === 'command' && node.attrs.cmd === 'include') {
        const id = includeTarget(node, viewProject(view), viewDocDir(view));
        if (id) editorContext.openInTab?.(id);
        return true;
      }
      if (node.type.name === 'command' && (node.attrs.cmd === 'ref' || node.attrs.cmd === 'citation')) {
        editorContext.openDialog?.(node.attrs.cmd === 'ref' ? 'ref' : 'cite', { pos: nodePos, node });
        return true;
      }
      return false;
    },
    handleClickOn(view, _pos, node, nodePos, event) {
      // a click on a formula's row — its margins, or a statically rendered formula (touch devices: no hover
      // to upgrade it) — enters the formula; a right-click is left to ProseMirror, which selects the formula
      // whole for the menu that follows (editormenu.ts: the formula's entries, Cut / Copy / Paste)
      if (node.type.name === 'math_inline' || node.type.name === 'math_display') {
        if (event.button !== 0) return false;
        const nv = (view.nodeDOM(nodePos) as any)?.pmViewDesc?.spec;
        if (nv?.ensureField) { const mf = nv.ensureField(); requestAnimationFrame(() => mf.focus()); return true; }
        return false;
      }
      // Ctrl/Cmd+click: follow cross-references, hyperlinks and child documents
      if (!(event.metaKey || event.ctrlKey) || node.type.name !== 'command') return false;
      let p: Map<string, string>;
      try { p = paramMap(JSON.parse(node.attrs.params || '[]')); } catch { return false; }
      const cmd = node.attrs.cmd as string;
      if (cmd === 'ref') { editorContext.gotoLabel?.(unquote(p.get('reference')).split(',')[0].trim(), view); return true; }
      if (cmd === 'href') { const t = unquote(p.get('target')); window.open(/^[a-z]+:/i.test(t) ? t : 'https://' + t, '_blank', 'noopener'); return true; }
      if (cmd === 'include') { const id = includeTarget(node, viewProject(view), viewDocDir(view)); if (id) editorContext.openInTab?.(id); return true; }
      return false;
    },
    handleDOMEvents: {
      ...(o.onFocus ? { focus(view: EditorView) { editorContext.activeView = view; o.onFocus!(view); return false; } } : {}),
      keyup(view, event) {
        // Native arrow movement precedes selectionchange; publish its final position
        // before source mirroring or a decoration update can use the previous caret.
        if (/^(Arrow|Home$|End$|Page)/.test(event.key)) flushDomSelection(view);
        return false;
      },
      contextmenu(view, ev) {
        // (a formula field shows its own menu and stops the event before it gets here — nodeviews/math.ts)
        if (ev.shiftKey) return false;                  // Shift+right-click: the browser's own menu
        ev.preventDefault();
        // a misspelt word under the pointer: fetch the suggestions first (a few ms), then the menu
        const coords = view.posAtCoords({ left: ev.clientX, top: ev.clientY });
        const bad = coords ? misspelledAt(view.state, coords.pos) : null;
        if (bad) {
          const { clientX, clientY } = ev;
          void spellSuggest(bad.word).then(list => { showContextMenu(clientX, clientY, editorContextMenu(view, ev, { ...bad, suggestions: list })); });
        } else showContextMenu(ev.clientX, ev.clientY, editorContextMenu(view, ev));
        return true;
      },
    },
    handlePaste(view, event) {
      // an image on the clipboard (a screenshot, a copied image file): upload it, insert a graphics inset
      const images = imageFiles(event.clipboardData);
      if (images.length) {
        if (!viewOnly()) void insertImageFiles(view, images);
        return true;
      }
      const text = event.clipboardData?.getData('text/plain');
      const html = event.clipboardData?.getData('text/html');
      // SVG markup on the text clipboard ("Copy as SVG" in drawing tools): an image, not text
      if (text && !viewOnly() && isSvgMarkup(text)) { void insertImageFiles(view, [svgFile(text)]); return true; }
      /** plain text without LaTeX: LyX semantics (blank line = new paragraph, no HTML structure) */
      const plainPaste = () => {
        const paras = text!.replace(/\r\n/g, '\n').split(/\n{2,}/);
        if (paras.length === 1) { view.dispatch(view.state.tr.insertText(text!.replace(/\n/g, ' '))); return; }
        let tr = view.state.tr.deleteSelection();
        paras.forEach((p, i) => {
          if (i > 0) tr = tr.split(tr.selection.from);
          tr = tr.insertText(p.replace(/\n/g, ' '));
        });
        view.dispatch(tr);
      };
      if (text && !html) {
        // just an image file's name: Safari (and Firefox on macOS) deliver only that for a file
        // copied in the Finder — paste it as text, but say how to get the image itself in
        if (looksLikeImageFileName(text)) {
          plainPaste();
          editorContext.notify?.('Only the file’s name was on the clipboard — to insert the image, drag the file into the text (or copy it in Chrome)');
          return true;
        }
        // pasted LaTeX (a \command, $…$, \[ …) is parsed on the server against this document's own
        // preamble and inserted as real structure — sections, formulas, citations, lists
        if (!viewOnly() && /\\[a-zA-Z]+|\\\[|\\\(|\$[^$\n][^$]*\$/.test(text)) {
          void pasteLatex(view, view.dom.dataset.docId ?? o.docId, text);
          return true;
        }
        plainPaste();
        return true;
      }
      return false;
    },
    // files dragged in from the computer: images are uploaded and inserted where they were dropped
    handleDrop(view, event, _slice, moved) {
      if (moved || !event.dataTransfer?.files.length) return false;   // internal drags and text drops: ProseMirror's own handling
      if (viewOnly()) return true;
      const images = imageFiles(event.dataTransfer);
      if (!images.length) { editorContext.notify?.('Only images can be dropped into the text — other files go into the file browser', 'error'); return true; }
      const pos = view.posAtCoords({ left: event.clientX, top: event.clientY });
      void insertImageFiles(view, images, pos ? pos.pos : null);
      return true;
    },
  };
}

/** "Inserted by Jane Doe on 3/2/2026, 10:12" for a tracked change. */
export function describeChange(type: string | undefined, authorId: number, time: number): string {
  const author = editorContext.meta?.authors.find(a => a.id === authorId)?.name ?? `author ${authorId}`;
  const when = time ? new Date(time * 1000).toLocaleString() : '';
  return `${type === 'deleted' ? 'Deleted' : 'Inserted'} by ${author}${when ? ' on ' + when : ''}`;
}

/**
 * Wire a freshly created view's DOM: which document it shows (child editors in the combined view
 * differ from the workspace document), the author/date tooltip of change-tracked text and nodes
 * (`data-changed`, see changeDomAttrs in the schema), and the guard against the double-click that
 * opened this document (child link, file browser) landing in the new editor and opening a dialog
 * for whatever node now sits under the pointer.
 */
export function installEditorDom(view: EditorView, docId: string): void {
  const createdAt = performance.now();
  view.dom.addEventListener('dblclick', (ev) => { if (performance.now() - createdAt < 600) { ev.stopPropagation(); ev.preventDefault(); } }, true);
  view.dom.dataset.docId = docId;
  view.dom.dataset.project = projectOfDoc(docId);
  view.dom.dataset.docDir = docDirOf(docId);
  view.dom.addEventListener('mouseover', (ev) => {
    const el = (ev.target as HTMLElement).closest?.('.lyx-change, .lyx-inset[data-change]') as HTMLElement | null;
    if (!el || el.title) return;
    el.title = describeChange(el.dataset.change ?? el.dataset.changed, Number(el.dataset.author), Number(el.dataset.time));
  });
}
