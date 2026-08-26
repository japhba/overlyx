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
import * as decoding from 'lib0/decoding';
import { ySyncPlugin, yCursorPlugin, yUndoPlugin, initProseMirrorDoc } from 'y-prosemirror';
import { schema, unquote, paramMap } from '@overlyx/core';
import { lyxKeymap, chordPlugin } from './keymap';
import { numberingPlugin } from './plugins/numbering';
import { marginPlugin } from './plugins/margin';
import { changeTrackingPlugin } from './plugins/changes';
import { findPlugin } from './plugins/find';
import { MathInlineView, MathDisplayView, MacroView } from './nodeviews/math';
import { InsetView } from './nodeviews/inset';
import { GraphicsView, CommandView, LeafView } from './nodeviews/leaf';
import { editorContext, viewDocDir, viewProject } from './context';
import { setDocumentMacros, setInlineMacroDefs } from './lyxmath/macrotable';
import { showContextMenu } from './contextmenu';
import { editorContextMenu } from './editormenu';
import { includeTarget } from './commands';
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
  /** a child document rendered below its master (combined view) */
  child?: boolean;
  onStatus?: (s: { connected: boolean; synced: boolean; users: { name: string; color: string }[] }) => void;
  onSelectionChange?: (view: EditorView) => void;
  onDocChange?: (view: EditorView) => void;
  /** the server re-created the document (its history changed): this editor's state is stale and must be discarded */
  onStale?: () => void;
}

export function createEditor(opts: EditorOptions): EditorHandle {
  const ydoc = new Y.Doc();
  const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  // disableBc: y-websocket would otherwise sync all providers of this origin that share the (empty)
  // room name through a BroadcastChannel — i.e. merge *different documents* open in other tabs or in
  // the combined master+child view into each other. Documents are only synced through the server.
  const provider = new WebsocketProvider(wsUrl, '', ydoc, { params: { doc: opts.docId }, disableBc: true });
  // y-websocket appends the room name to the url; we pass the doc as a query param instead
  // Message type 2 = document epoch (OverLyX extension, sent by the server before sync step 1). If the
  // server's Yjs history was re-created while this editor was alive (restart + changed file), syncing
  // would merge two unrelated histories: bail out instead and let the UI reload the document.
  let epoch: string | null = null;
  let stale = false;
  (provider as any).messageHandlers[2] = (_enc: unknown, dec: decoding.Decoder) => {
    const e = decoding.readVarString(dec);
    if (epoch !== null && e !== epoch && !stale) {
      stale = true;
      provider.shouldConnect = false;
      provider.disconnect();
      opts.onStale?.();
    }
    epoch = e;
  };
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
    attributes: { class: 'lyx-editor' + (opts.child ? ' lyx-editor-child' : ''), spellcheck: 'true' },
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
      // a statically rendered formula (touch devices: no hover to upgrade it): make it editable and focus it
      if (node.type.name === 'math_inline' || node.type.name === 'math_display') {
        const nv = (view.nodeDOM(nodePos) as any)?.pmViewDesc?.spec;
        if (nv && !nv.mf && nv.ensureField) { const mf = nv.ensureField(); requestAnimationFrame(() => mf.focus()); return true; }
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
      contextmenu(view, ev) {
        const t = ev.target as HTMLElement;
        if (t.closest?.('math-field')) return false;   // the field shows its own menu
        ev.preventDefault();
        showContextMenu(ev.clientX, ev.clientY, editorContextMenu(view, ev));
        return true;
      },
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
  // which document this view shows (child editors in the combined view differ from the workspace document)
  view.dom.dataset.docId = opts.docId;
  view.dom.dataset.project = opts.docId.split('/')[0];
  view.dom.dataset.docDir = opts.docId.split('/').slice(1, -1).join('/');

  // tooltip with author and date for change-tracked text
  view.dom.addEventListener('mouseover', (ev) => {
    const el = (ev.target as HTMLElement).closest?.('.lyx-change, .lyx-inset[data-change]') as HTMLElement | null;
    if (!el || el.title) return;
    el.title = describeChange(el.dataset.change, Number(el.dataset.author), Number(el.dataset.time));
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
  if (!opts.child) {
    const once = (s: boolean) => {
      if (!s) return;
      provider.off('sync', once);
      try { view.dispatch(view.state.tr.setSelection(TextSelection.atStart(view.state.doc))); } catch { /* empty */ }
    };
    provider.on('sync', once);
  }

  return {
    view, ydoc, provider,
    destroy() {
      // the view first: its Yjs binding must be gone before the provider/awareness fire their last events
      view.destroy();
      provider.awareness.setLocalState(null);
      provider.destroy();
      ydoc.destroy();
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
 * Macros: server-provided ones (preamble, \input files, child documents) apply everywhere;
 * FormulaMacro insets of this document apply from their position onwards (LyX semantics).
 * `merge` adds to the global dictionary instead of replacing it (child editors of a combined view).
 */
export function refreshMacros(view: EditorView, serverMacros: Record<string, { def: string; args: number; expand: boolean }>, merge = false): void {
  const defs: { pos: number; name: string; def: string; args: number }[] = [];
  view.state.doc.descendants((node, pos) => {
    if (node.type.name === 'macro') {
      try {
        const lines: string[] = JSON.parse(node.attrs.lines);
        const m = /^\\(?:re)?newcommand\*?\{\\([A-Za-z]+)\}(?:\[(\d+)\])?\{([\s\S]*)\}$/.exec(lines[0]);
        if (m) {
          let display: string | undefined;
          if (lines[1]?.startsWith('{')) display = lines[1].slice(1, -1);
          defs.push({ pos, name: m[1], def: display || m[3], args: Number(m[2] ?? 0) });
        }
      } catch { /* ignore */ }
    }
    return true;
  });
  // server macros minus the ones this document defines itself (positional defs take over)
  const own = new Set(defs.map(d => d.name));
  const base: Record<string, { def: string; args: number; expand: boolean }> = {};
  for (const [k, v] of Object.entries(serverMacros)) if (!own.has(k)) base[k] = v;
  setDocumentMacros(base, merge);
  setInlineMacroDefs(view, defs);
}

export { editorContext };
