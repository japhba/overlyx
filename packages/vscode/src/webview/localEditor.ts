/**
 * The OverLyX editor without a server: the same ProseMirror assembly as the web client's
 * createEditor (editor.ts), but on a purely local Y.Doc — no WebSocket provider, no IndexedDB,
 * no presence. The document comes in as ProseMirror JSON from the extension host (which parsed
 * the .tex file) and leaves as ProseMirror JSON after each change; external file changes are
 * applied as a Yjs diff so the cursor and unsynced edits survive.
 */
import { EditorState, Plugin, TextSelection } from 'prosemirror-state';
import { EditorView, type NodeView } from 'prosemirror-view';
import { Fragment, Slice, type Node as PMNode } from 'prosemirror-model';
import { keymap } from 'prosemirror-keymap';
import { gapCursor } from 'prosemirror-gapcursor';
import { dropCursor } from 'prosemirror-dropcursor';
import { tableEditing } from 'prosemirror-tables';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { ySyncPlugin, yCursorPlugin, yUndoPlugin, undo, redo, initProseMirrorDoc, prosemirrorJSONToYXmlFragment } from 'y-prosemirror';
import { schema, unquote, paramMap } from '@overlyx/core';
import { lyxKeymap, chordPlugin } from '@client/editor/keymap';
import { numberingPlugin } from '@client/editor/plugins/numbering';
import { marginPlugin } from '@client/editor/plugins/margin';
import { changeTrackingPlugin, changesFilterPlugin } from '@client/editor/plugins/changes';
import { fontCarryPlugin } from '@client/editor/plugins/fontcarry';
import { insetCaretPlugin } from '@client/editor/plugins/insetcaret';
import { dragSelectPlugin } from '@client/editor/plugins/dragselect';
import { findPlugin } from '@client/editor/plugins/find';
import { mirrorCaretPlugin } from '@client/editor/plugins/mirrorcaret';
import { MathInlineView, MathDisplayView, MacroView } from '@client/editor/nodeviews/math';
import { InsetView } from '@client/editor/nodeviews/inset';
import { GraphicsView, CommandView, LeafView } from '@client/editor/nodeviews/leaf';
import { editorContext, viewDocDir, viewProject } from '@client/editor/context';
import { sliceText } from '@client/editor/cliptext';
import { showContextMenu } from '@client/editor/contextmenu';
import { editorContextMenu } from '@client/editor/editormenu';
import { includeTarget } from '@client/editor/commands';
import { aiRewritePlugin } from '@client/editor/ai/rewrite';
import { aiCompletePlugin } from '@client/editor/ai/complete';
import { spellPlugin, misspelledAt, spellSuggest } from '@client/editor/spell/plugin';
import { macroDefsPlugin, describeChange } from '@client/editor/editor';
import { getPrefs, subscribePrefs } from '@client/prefs';
import { api } from '@client/api';

function guarded(node: PMNode, make: () => NodeView): NodeView {
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

function editorAttributes(p: { spellcheck: boolean; spellEngine: string }): Record<string, string> {
  return { class: 'lyx-editor', spellcheck: p.spellcheck && p.spellEngine === 'browser' ? 'true' : 'false' };
}

export interface LocalEditorHandle {
  view: EditorView;
  ydoc: Y.Doc;
  /** apply new content that arrived from the file (as a diff: unchanged paragraphs keep identity) */
  applyExternal(pmDoc: unknown): void;
  destroy(): void;
}

export interface LocalEditorOptions {
  docId: string;
  container: HTMLElement;
  pmDoc: unknown;
  marginMode?: boolean;
  onSelectionChange?: (view: EditorView, info: { docChanged: boolean }) => void;
  onDocChange?: (view: EditorView) => void;
}

const EXTERNAL_ORIGIN = 'vscode-file';

export function createLocalEditor(opts: LocalEditorOptions): LocalEditorHandle {
  const ydoc = new Y.Doc();
  const fragment = ydoc.getXmlFragment('prosemirror');
  ydoc.transact(() => { prosemirrorJSONToYXmlFragment(schema, opts.pmDoc, fragment); }, EXTERNAL_ORIGIN);
  const awareness = new Awareness(ydoc);
  awareness.setLocalStateField('user', { name: 'You', color: '#3b6ea5' });

  const { doc: initialDoc, mapping } = initProseMirrorDoc(fragment, schema);
  let viewRef: EditorView | null = null;

  const plugins: Plugin[] = [
    ySyncPlugin(fragment, { mapping }),
    yCursorPlugin(awareness),
    yUndoPlugin(),
    aiRewritePlugin(),
    aiCompletePlugin(),
    spellPlugin(),
    chordPlugin(),
    lyxKeymap(),
    keymap({ 'Mod-z': undo, 'Mod-y': redo, 'Mod-Z': redo, 'Shift-Mod-z': redo }),
    fontCarryPlugin(),
    insetCaretPlugin(),
    dragSelectPlugin(),
    gapCursor(),
    dropCursor({ color: '#3b6ea5' }),
    tableEditing(),
    numberingPlugin(),
    marginPlugin(opts.marginMode ?? false),
    changeTrackingPlugin(),
    changesFilterPlugin(),
    findPlugin(),
    mirrorCaretPlugin(),
    macroDefsPlugin(() => viewRef),
    new Plugin({
      view: () => ({
        update: (view, prev) => {
          if (!prev.selection.eq(view.state.selection) || prev.doc !== view.state.doc) opts.onSelectionChange?.(view, { docChanged: prev.doc !== view.state.doc });
          if (prev.doc !== view.state.doc) opts.onDocChange?.(view);
        },
      }),
    }),
  ];

  const state = EditorState.create({ schema, doc: initialDoc, plugins });
  const view = new EditorView(opts.container, {
    state,
    nodeViews: {
      math_inline: (node, view, getPos) => guarded(node, () => new MathInlineView(node, view, getPos as () => number | undefined)),
      math_display: (node, view, getPos) => guarded(node, () => new MathDisplayView(node, view, getPos as () => number | undefined)),
      macro: (node, view, getPos) => guarded(node, () => new MacroView(node, view, getPos as () => number | undefined)),
      inset: (node, view, getPos) => guarded(node, () => new InsetView(node, view, getPos as () => number | undefined)),
      graphics: (node, view, getPos) => guarded(node, () => new GraphicsView(node, view, getPos as () => number | undefined)),
      command: (node, view, getPos) => guarded(node, () => new CommandView(node, view, getPos as () => number | undefined)),
      leaf: (node, view, getPos) => guarded(node, () => new LeafView(node, view, getPos as () => number | undefined)),
    },
    attributes: editorAttributes(getPrefs()),
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
      if (node.type.name === 'math_inline' || node.type.name === 'math_display') {
        const nv = (view.nodeDOM(nodePos) as any)?.pmViewDesc?.spec;
        if (nv && !nv.mf && nv.ensureField) { const mf = nv.ensureField(); requestAnimationFrame(() => mf.focus()); return true; }
        return false;
      }
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
      contextmenu(view, ev) {
        const t = ev.target as HTMLElement;
        if (t.closest?.('math-field')) return false;
        if (ev.shiftKey) return false;
        ev.preventDefault();
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
      const text = event.clipboardData?.getData('text/plain');
      const html = event.clipboardData?.getData('text/html');
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
        if (/\\[a-zA-Z]+|\\\[|\\\(|\$[^$\n][^$]*\$/.test(text)) {
          void api.parseClip(view.dom.dataset.docId ?? opts.docId, text).then(r => {
            const blocks = (r.blocks as unknown[]).map(b => schema.nodeFromJSON(b)).filter(n => n.type.name !== 'doc');
            if (!blocks.length) { plainPaste(); return; }
            const single = blocks.length === 1 && blocks[0].type.name === 'paragraph' && blocks[0].attrs.layout === 'Standard' && !blocks[0].attrs.depth;
            const slice = single ? new Slice(Fragment.from(blocks[0].content), 0, 0) : new Slice(Fragment.from(blocks), 0, 0);
            view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView());
            view.focus();
          }).catch(e => { console.warn('LaTeX paste fell back to plain text:', e); plainPaste(); });
          return true;
        }
        plainPaste();
        return true;
      }
      return false;
    },
  });
  viewRef = view;
  const unsubscribePrefs = subscribePrefs(p => { view.setProps({ attributes: editorAttributes(p) }); });
  view.dom.dataset.docId = opts.docId;
  view.dom.dataset.project = opts.docId.split('/')[0];
  view.dom.dataset.docDir = opts.docId.split('/').slice(1, -1).join('/');

  view.dom.addEventListener('mouseover', (ev) => {
    const el = (ev.target as HTMLElement).closest?.('.lyx-change, .lyx-inset[data-change]') as HTMLElement | null;
    if (!el || el.title) return;
    el.title = describeChange(el.dataset.change, Number(el.dataset.author), Number(el.dataset.time));
  });

  // start with the cursor at the beginning
  try { view.dispatch(view.state.tr.setSelection(TextSelection.atStart(view.state.doc)).setMeta('addToHistory', false)); } catch { /* empty */ }

  return {
    view, ydoc,
    applyExternal(pmDoc: unknown) {
      ydoc.transact(() => { prosemirrorJSONToYXmlFragment(schema, pmDoc, fragment); }, EXTERNAL_ORIGIN);
    },
    destroy() {
      unsubscribePrefs();
      view.destroy();
      awareness.destroy();
      ydoc.destroy();
    },
  };
}
