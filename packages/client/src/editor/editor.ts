/**
 * Editor assembly: ProseMirror view bound to a Yjs document (y-prosemirror), LyX keymap,
 * node views (MathLive, insets, graphics, commands), decorations and collaboration cursors.
 */
import { EditorState, Plugin, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { gapCursor } from 'prosemirror-gapcursor';
import { dropCursor } from 'prosemirror-dropcursor';
import { tableEditing } from 'prosemirror-tables';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { ySyncPlugin, yCursorPlugin, yUndoPlugin, initProseMirrorDoc } from 'y-prosemirror';
import { schema } from '@overlyx/core';
import { lyxKeymap, chordPlugin } from './keymap';
import { numberingPlugin } from './plugins/numbering';
import { marginPlugin } from './plugins/margin';
import { changeTrackingPlugin } from './plugins/changes';
import { findPlugin } from './plugins/find';
import { MathInlineView, MathDisplayView, MacroView } from './nodeviews/math';
import { InsetView } from './nodeviews/inset';
import { GraphicsView, CommandView, LeafView } from './nodeviews/leaf';
import { editorContext } from './context';
import { setDocumentMacros, configureMathlive } from './math';
import type { User } from '../api';

export interface EditorHandle {
  view: EditorView;
  ydoc: Y.Doc;
  provider: WebsocketProvider;
  destroy(): void;
}

export interface EditorOptions {
  docId: string;
  user: User;
  container: HTMLElement;
  marginMode?: boolean;
  onStatus?: (s: { connected: boolean; synced: boolean; users: { name: string; color: string }[] }) => void;
  onSelectionChange?: (view: EditorView) => void;
  onDocChange?: (view: EditorView) => void;
}

export function createEditor(opts: EditorOptions): EditorHandle {
  configureMathlive();
  const ydoc = new Y.Doc();
  const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  const provider = new WebsocketProvider(wsUrl, '', ydoc, { params: { doc: opts.docId } });
  // y-websocket appends the room name to the url; we pass the doc as a query param instead
  const fragment = ydoc.getXmlFragment('prosemirror');
  const { doc: initialDoc, mapping } = initProseMirrorDoc(fragment, schema);

  provider.awareness.setLocalStateField('user', { name: opts.user.name, color: opts.user.color, username: opts.user.username });

  const plugins: Plugin[] = [
    ySyncPlugin(fragment, { mapping }),
    yCursorPlugin(provider.awareness, {
      cursorBuilder: (user: { name: string; color: string }) => {
        const cursor = document.createElement('span');
        cursor.className = 'ProseMirror-yjs-cursor';
        cursor.style.borderColor = user.color;
        const label = document.createElement('div');
        label.style.backgroundColor = user.color;
        label.textContent = user.name;
        cursor.appendChild(label);
        return cursor;
      },
    }),
    yUndoPlugin(),
    chordPlugin(),
    lyxKeymap(),
    gapCursor(),
    dropCursor({ color: '#3b6ea5' }),
    tableEditing(),
    numberingPlugin(),
    marginPlugin(opts.marginMode ?? false),
    changeTrackingPlugin(),
    findPlugin(),
    new Plugin({
      view: () => ({
        update: (view, prev) => {
          if (!prev.selection.eq(view.state.selection) || prev.doc !== view.state.doc) opts.onSelectionChange?.(view);
          if (prev.doc !== view.state.doc) opts.onDocChange?.(view);
        },
      }),
    }),
  ];

  const state = EditorState.create({ schema, doc: initialDoc, plugins });
  const view = new EditorView(opts.container, {
    state,
    nodeViews: {
      math_inline: (node, view, getPos) => new MathInlineView(node, view, getPos as () => number | undefined),
      math_display: (node, view, getPos) => new MathDisplayView(node, view, getPos as () => number | undefined),
      macro: (node, view, getPos) => new MacroView(node, view, getPos as () => number | undefined),
      inset: (node, view, getPos) => new InsetView(node, view, getPos as () => number | undefined),
      graphics: (node, view, getPos) => new GraphicsView(node, view, getPos as () => number | undefined),
      command: (node, view, getPos) => new CommandView(node, view, getPos as () => number | undefined),
      leaf: (node, view, getPos) => new LeafView(node, view, getPos as () => number | undefined),
    },
    attributes: { class: 'lyx-editor', spellcheck: 'true' },
    handleDoubleClickOn(view, pos, node) {
      if (node.type.name === 'command' && node.attrs.cmd === 'include') {
        editorContext.openDialog?.('open-include', node);
        return true;
      }
      return false;
    },
    handleClickOn(view, pos, node, nodePos, event) {
      // clicking a collapsed inset opens it
      if (node.type.name === 'inset' && node.attrs.status === 'collapsed' && (event.target as HTMLElement).closest('.inset-label')) return false;
      return false;
    },
    handlePaste(view, event) {
      // plain-text paste: keep LyX semantics (no HTML structure)
      const text = event.clipboardData?.getData('text/plain');
      const html = event.clipboardData?.getData('text/html');
      if (text && !html) {
        const paras = text.replace(/\r\n/g, '\n').split(/\n{2,}/);
        if (paras.length === 1) { view.dispatch(view.state.tr.insertText(text.replace(/\n/g, ' '))); return true; }
        let tr = view.state.tr.deleteSelection();
        paras.forEach((p, i) => {
          if (i > 0) tr = tr.split(tr.selection.from);
          tr = tr.insertText(p.replace(/\n/g, ' '));
        });
        view.dispatch(tr);
        return true;
      }
      return false;
    },
  });

  const status = { connected: false, synced: false, users: [] as { name: string; color: string }[] };
  const pushStatus = () => {
    const users: { name: string; color: string }[] = [];
    provider.awareness.getStates().forEach((s) => { if (s.user) users.push({ name: s.user.name, color: s.user.color }); });
    status.users = users;
    opts.onStatus?.({ ...status });
  };
  provider.on('status', (e: { status: string }) => { status.connected = e.status === 'connected'; pushStatus(); });
  provider.on('sync', (s: boolean) => { status.synced = s; pushStatus(); });
  provider.awareness.on('change', pushStatus);

  // put cursor at start once synced
  const once = (s: boolean) => {
    if (!s) return;
    provider.off('sync', once);
    try { view.dispatch(view.state.tr.setSelection(TextSelection.atStart(view.state.doc))); } catch { /* empty */ }
  };
  provider.on('sync', once);

  return {
    view, ydoc, provider,
    destroy() {
      provider.awareness.setLocalState(null);
      provider.destroy();
      view.destroy();
      ydoc.destroy();
    },
  };
}

/** Scan the document for FormulaMacro insets and merge with server-provided macros. */
export function refreshMacros(view: EditorView, serverMacros: Record<string, { def: string; args: number; expand: boolean }>): void {
  const macros = { ...serverMacros };
  view.state.doc.descendants((node) => {
    if (node.type.name === 'macro') {
      try {
        const lines: string[] = JSON.parse(node.attrs.lines);
        const m = /^\\(?:re)?newcommand\{\\([A-Za-z]+)\}(?:\[(\d+)\])?\{([\s\S]*)\}$/.exec(lines[0]);
        if (m) {
          let display: string | undefined;
          if (lines[1]?.startsWith('{')) display = lines[1].slice(1, -1);
          macros[m[1]] = { def: display || m[3], args: Number(m[2] ?? 0), expand: false };
        }
      } catch { /* ignore */ }
    }
    return true;
  });
  setDocumentMacros(macros);
}

export { editorContext };
