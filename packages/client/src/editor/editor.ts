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
import { IndexeddbPersistence } from 'y-indexeddb';
import * as decoding from 'lib0/decoding';
import { ySyncPlugin, yCursorPlugin, yUndoPlugin, initProseMirrorDoc, ySyncPluginKey, relativePositionToAbsolutePosition } from 'y-prosemirror';
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
import { setDocumentMacros, setInlineMacroDefs, markMacrosReady } from './lyxmath/macrotable';
import { showContextMenu } from './contextmenu';
import { editorContextMenu } from './editormenu';
import { includeTarget } from './commands';
import type { User } from '../api';

export interface EditorHandle {
  view: EditorView;
  ydoc: Y.Doc;
  provider: WebsocketProvider;
  /** editing is disabled until the document's metadata (authors, change tracking, macros) is known */
  setEditable(on: boolean): void;
  /** viewer of a shared project: no local transaction may change the document (remote updates still apply) */
  setViewOnly(on: boolean): void;
  /** current save / connection state */
  saveState(): SaveState;
  /** forget the local (IndexedDB) copy of this document; used after an epoch conflict */
  discardLocal(): Promise<void>;
  /** move the cursor to where another user (an awareness client) is editing and scroll there; false if unknown */
  gotoUser(clientId: number): boolean;
  destroy(): void;
}

/** A user connected to the document (one entry per browser tab / awareness client). */
export interface PresenceUser { name: string; color: string; username?: string; clientId: number; /** has a known cursor position in this document */ hasCursor: boolean; self: boolean }

/**
 * Where the user's edits are: `saved` = the .lyx file on the server contains everything, `saving` =
 * edits are on their way to the server / not written yet, `offline` = no connection (edits are kept
 * in this browser and sync later), `connecting` = not synced yet after opening.
 */
export interface SaveState {
  state: 'saved' | 'saving' | 'offline' | 'connecting' | 'stale';
  /** local edits the server has not confirmed as written */
  pending: boolean;
  /** time of the last write to the .lyx file (server clock, ms) */
  savedAt: number;
  /** offline and nothing cached locally: the document cannot be shown */
  unavailable: boolean;
  /** why there is no connection (diagnostics for the tooltip) */
  detail?: string;
}

export interface EditorOptions {
  docId: string;
  user: User;
  container: HTMLElement;
  marginMode?: boolean;
  /** a child document rendered below its master (combined view) */
  child?: boolean;
  onStatus?: (s: { connected: boolean; synced: boolean; users: PresenceUser[] }) => void;
  onSelectionChange?: (view: EditorView) => void;
  onDocChange?: (view: EditorView) => void;
  /**
   * The server's document has a different history (epoch) than the local copy — it was re-created
   * (e.g. the server's database was reset). The local state cannot be merged and must be discarded;
   * `pendingLocal` tells whether it holds edits the server never received (the caller can save them
   * as a version before discarding).
   */
  onStale?: (info: { pendingLocal: boolean }) => void;
  /** the server closed the connection because this user's access to the project changed (revoked, or a new role) */
  onAccessChanged?: () => void;
  onSaveState?: (s: SaveState) => void;
  /** start read-only (until `setEditable(true)`) */
  readOnly?: boolean;
}

/** IndexedDB database name of a document's local copy */
export const localDbName = (docId: string) => 'overlyx:' + docId;

export function createEditor(opts: EditorOptions): EditorHandle {
  const ydoc = new Y.Doc();
  const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  // disableBc: y-websocket would otherwise sync all providers of this origin that share the (empty)
  // room name through a BroadcastChannel — i.e. merge *different documents* open in other tabs or in
  // the combined master+child view into each other. Documents are only synced through the server.
  // y-websocket appends the room name to the url; we pass the doc as a query param instead.
  // The connection is opened once the local copy has been loaded (see below).
  const provider = new WebsocketProvider(wsUrl, '', ydoc, { params: { doc: opts.docId }, disableBc: true, connect: false });
  let destroyed = false;

  /* ---------------------------------------------------------------- offline copy + save state
   * Every document is mirrored in IndexedDB (y-indexeddb): it renders instantly on the next open,
   * and while offline edits keep going into the local copy; on reconnect the Yjs sync exchanges
   * exactly the missing updates in both directions (CRDT merge, no conflicts).
   *
   * Save state: local edits are counted (`editSeq`); everything up to `sentSeq` has been handed to
   * the server (sent immediately while connected, or exchanged by the sync after a reconnect); the
   * server's MSG_SAVED (type 3, sent after each write of the .lyx file, ordered after the updates it
   * processed) confirms everything sent before it. */
  const persistence = new IndexeddbPersistence(localDbName(opts.docId), ydoc);
  let editSeq = 0, sentSeq = 0, savedSeq = 0;
  let savedAt = 0;
  let localSynced = false;      // IndexedDB copy loaded
  let localEmpty = true;
  let pendingFromStore = false; // the stored copy had unsaved edits when it was last used
  let lastConnInfo = '';
  const saveState = (): SaveState => {
    const pending = editSeq > savedSeq || (pendingFromStore && !provider.synced);
    const connected = provider.wsconnected;
    const state: SaveState['state'] = stale ? 'stale' : connected && provider.synced ? (pending ? 'saving' : 'saved') : connected || !localSynced ? 'connecting' : 'offline';
    let detail: string | undefined;
    if (state === 'offline') {
      detail = navigator.onLine === false ? 'the browser reports no network connection' : 'no WebSocket connection to the server';
      if (lastConnInfo) detail += ` (${lastConnInfo})`;
      detail += ' — reconnecting automatically';
    }
    return { state, pending, savedAt, unavailable: state === 'offline' && localEmpty, detail };
  };
  let lastEmitted = '';
  const emitSaveState = () => {
    const st = saveState();
    const key = JSON.stringify(st);
    if (key === lastEmitted) return;
    lastEmitted = key;
    if (st.pending !== pendingFromStore || !st.pending) { pendingFromStore = st.pending; void persistence.set('pending', st.pending ? 1 : 0).catch(() => {}); }
    opts.onSaveState?.(st);
  };
  ydoc.on('update', (_u: Uint8Array, origin: unknown) => {
    if (origin === provider || origin === persistence) return;
    editSeq++;
    if (provider.wsconnected && provider.synced) sentSeq = editSeq;   // y-websocket sends local updates right away
    emitSaveState();
  });
  ydoc.on('update', () => { localEmpty = ydoc.getXmlFragment('prosemirror').length === 0; });
  (provider as any).messageHandlers[3] = (_enc: unknown, dec: decoding.Decoder) => {
    savedAt = decoding.readVarUint(dec);
    decoding.readVarUint8Array(dec);   // state vector of the written file (informational)
    savedSeq = sentSeq;
    emitSaveState();
  };

  // Message type 2 = document epoch (OverLyX extension, sent by the server before sync step 1). If the
  // server's Yjs history differs from the one our local copy belongs to (the server re-created the
  // document), syncing would merge two unrelated histories: bail out instead and let the UI decide.
  let epoch: string | null = null;
  let stale = false;
  provider.on('connection-close', (ev: CloseEvent | null) => {
    if (ev) lastConnInfo = `closed with code ${ev.code}${ev.reason ? ': ' + ev.reason : ''}`;
    emitSaveState();
    if (ev?.code === 4003) opts.onAccessChanged?.();
  });
  provider.on('connection-error', () => { lastConnInfo = 'connection attempt failed'; emitSaveState(); });
  // A remote update dispatched between a mouse click and the browser's (asynchronous)
  // `selectionchange` event would make ProseMirror write its stale state selection back into the
  // DOM and the click would be lost (y-prosemirror restores the *state* selection after applying
  // remote changes). Reading the DOM selection before applying any sync message closes that gap.
  // (Both document updates and awareness updates: remote cursors are decorations, and ProseMirror
  // re-writes the DOM selection whenever decorations change, unless the mouse button is still down.)
  const flushDomSelection = () => { try { (viewRef as any)?.domObserver?.flush(); } catch { /* ignore */ } };
  {
    const orig = (provider as any).messageHandlers[0];
    (provider as any).messageHandlers[0] = (...args: unknown[]) => { flushDomSelection(); return orig(...args); };
  }
  (provider as any).messageHandlers[2] = (_enc: unknown, dec: decoding.Decoder) => {
    const e = decoding.readVarString(dec);
    if (epoch !== null && e !== epoch && !stale) {
      stale = true;
      provider.shouldConnect = false;
      provider.disconnect();
      opts.onStale?.({ pendingLocal: editSeq > savedSeq || pendingFromStore });
      return;
    }
    if (epoch !== e) { epoch = e; void persistence.set('epoch', e).catch(() => {}); }
  };
  const connectAfterLocalLoad = async () => {
    try {
      await Promise.race([persistence.whenSynced, new Promise(r => setTimeout(r, 2500))]);
      const [storedEpoch, pending] = await Promise.all([persistence.get('epoch'), persistence.get('pending')]);
      if (typeof storedEpoch === 'string') epoch = storedEpoch;
      pendingFromStore = pending === 1;
    } catch { /* no IndexedDB (private mode, …): work without a local copy */ }
    localSynced = true;
    localEmpty = ydoc.getXmlFragment('prosemirror').length === 0;
    if (destroyed) return;
    performance.mark('ol:local-loaded');
    emitSaveState();
    // always try — navigator.onLine is unreliable (Chrome reports "offline" behind some VPNs / network
    // setups); a failing attempt just makes y-websocket retry with backoff
    provider.connect();
  };
  void connectAfterLocalLoad();
  const fragment = ydoc.getXmlFragment('prosemirror');
  const { doc: initialDoc, mapping } = initProseMirrorDoc(fragment, schema);

  provider.awareness.setLocalStateField('user', { name: opts.user.name, color: opts.user.color, username: opts.user.username });

  const plugins: Plugin[] = [
    ySyncPlugin(fragment, { mapping }),
    yCursorPlugin(provider.awareness, {
      cursorBuilder: (user: { name: string; color: string }, clientId?: number) => {
        const cursor = document.createElement('span');
        cursor.className = 'ProseMirror-yjs-cursor';
        if (clientId !== undefined) cursor.dataset.client = String(clientId);
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
    macroDefsPlugin(() => viewRef),
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
  let viewRef: EditorView | null = null;
  let editable = !opts.readOnly;
  let viewOnly = false;
  let flushing = false;
  const view = new EditorView(opts.container, {
    state,
    editable: () => editable,
    // Decoration-only transactions (y-prosemirror re-renders the remote cursors from a setTimeout
    // after every awareness change) make ProseMirror write its *state* selection back into the DOM.
    // Right after a mouse click the DOM selection is ahead of the state (the browser's
    // `selectionchange` event has not been processed yet), so the click would be lost: read the
    // DOM selection first and re-create the transaction on the fresh state.
    dispatchTransaction(tr) {
      if (viewOnly && tr.docChanged && !tr.getMeta(ySyncPluginKey)) return;   // viewers cannot edit (the server drops their updates anyway)
      if (!flushing && !tr.docChanged && tr.selectionSet === false && tr.selection.eq(view.state.selection)) {
        flushing = true;
        const before = view.state;
        try { (view as any).domObserver.flush(); } catch { /* ignore */ } finally { flushing = false; }
        if (view.state !== before) {
          const fresh = view.state.tr;
          for (const [k, v] of Object.entries((tr as any).meta as Record<string, unknown>)) fresh.setMeta(k, v);
          tr = fresh;
        }
      }
      view.updateState(view.state.apply(tr));
    },
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
  viewRef = view;
  performance.mark('ol:editor-created');
  // A double-click that opened this document (child link, file browser) ends after the new editor
  // exists: its dblclick event must not open a dialog for whatever node now sits under the pointer.
  const createdAt = performance.now();
  view.dom.addEventListener('dblclick', (ev) => { if (performance.now() - createdAt < 600) { ev.stopPropagation(); ev.preventDefault(); } }, true);
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

  const status = { connected: false, synced: false, users: [] as PresenceUser[] };
  const pushStatus = () => {
    const users: PresenceUser[] = [];
    provider.awareness.getStates().forEach((s, clientId) => { if (s.user) users.push({ name: s.user.name, color: s.user.color, username: s.user.username, clientId, hasCursor: !!s.cursor, self: clientId === ydoc.clientID }); });
    status.users = users;
    opts.onStatus?.({ ...status });
  };
  /** Absolute document position of another client's cursor head, if it is in this document. */
  const userCursorPos = (clientId: number): number | null => {
    const st = provider.awareness.getStates().get(clientId);
    if (!st?.cursor) return null;
    const ystate = ySyncPluginKey.getState(view.state);
    if (!ystate || ystate.binding.mapping.size === 0) return null;
    try {
      const pos = relativePositionToAbsolutePosition(ystate.doc, ystate.type, Y.createRelativePositionFromJSON(st.cursor.head), ystate.binding.mapping);
      return pos === null ? null : Math.min(pos, view.state.doc.content.size - 1);
    } catch { return null; }
  };
  provider.on('status', (e: { status: string }) => { status.connected = e.status === 'connected'; pushStatus(); emitSaveState(); });
  provider.on('sync', (s: boolean) => {
    status.synced = s;
    if (s) {
      performance.mark('ol:synced');
      // edits stored from an earlier session stay "pending" until the server confirms it wrote them
      if (pendingFromStore) editSeq = Math.max(editSeq, savedSeq + 1);
      sentSeq = editSeq;   // the sync exchanged everything we had
    }
    pushStatus(); emitSaveState();
  });
  provider.awareness.on('change', pushStatus);
  // The browser's online/offline events give immediate feedback (the WebSocket itself only notices a
  // dead connection through y-websocket's 30 s watchdog). They are hints only: after an "offline"
  // event we keep trying to connect every few seconds, since the flag is wrong in some setups.
  let retry: ReturnType<typeof setInterval> | null = null;
  const stopRetry = () => { if (retry) { clearInterval(retry); retry = null; } };
  const reconnect = () => { if (destroyed || stale) return; if (!provider.wsconnected) { provider.disconnect(); provider.connect(); } };
  const onOnline = () => { stopRetry(); reconnect(); };
  const onOffline = () => {
    if (destroyed || stale) return;
    provider.disconnect(); emitSaveState();
    stopRetry();
    retry = setInterval(() => { if (provider.wsconnected) stopRetry(); else reconnect(); }, 5000);
  };
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);

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
    setEditable(on: boolean) { if (on !== editable) { editable = on; view.setProps({ editable: () => editable }); } },
    setViewOnly(on: boolean) { viewOnly = on; view.dom.classList.toggle('view-only', on); },
    saveState,
    async discardLocal() { try { await persistence.clearData(); } catch { /* ignore */ } },
    gotoUser(clientId: number) {
      const pos = userCursorPos(clientId);
      if (pos === null) return false;
      try {
        const sel = TextSelection.near(view.state.doc.resolve(pos));
        view.dispatch(view.state.tr.setSelection(sel).scrollIntoView().setMeta('addToHistory', false));
      } catch { return false; }
      view.focus();
      // show where they are: flash their cursor label
      requestAnimationFrame(() => {
        const el = view.dom.querySelector(`.ProseMirror-yjs-cursor[data-client="${clientId}"]`) as HTMLElement | null;
        el?.scrollIntoView({ block: 'center', inline: 'nearest' });
        if (el) { el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1600); }
      });
      return true;
    },
    destroy() {
      destroyed = true;
      stopRetry();
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      // the view first: its Yjs binding must be gone before the provider/awareness fire their last events
      view.destroy();
      provider.awareness.setLocalState(null);
      provider.destroy();
      persistence.destroy();
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

type ServerMacros = Record<string, { def: string; args: number; expand: boolean }>;
interface InlineDef { pos: number; name: string; def: string; args: number }
const serverMacrosByView = new WeakMap<EditorView, { macros: ServerMacros; merge: boolean }>();

/**
 * Registers the positional macro definitions of every new document state *before* the view renders
 * it: node views of formulas ask for their macro table when they are created, so the definitions
 * must be known by then (otherwise every formula would be rendered twice on load).
 */
function macroDefsPlugin(getView: () => EditorView | null): Plugin {
  return new Plugin({
    state: {
      init: () => '',
      apply(tr, sig: string, _old, newState) {
        if (!tr.docChanged) return sig;
        const view = getView();
        if (!view) return sig;
        const defs = inlineMacroDefs(newState.doc);
        const next = JSON.stringify(defs);
        if (next === sig) return sig;
        const server = serverMacrosByView.get(view);
        if (server) applyMacros(view, defs, server.macros, server.merge);
        else setInlineMacroDefs(view, defs);   // metadata still loading: positional defs only
        return next;
      },
    },
  });
}

/** FormulaMacro insets of a document (definition + position). */
function inlineMacroDefs(doc: import('prosemirror-model').Node): InlineDef[] {
  const defs: InlineDef[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'macro') return true;
    try {
      const lines: string[] = JSON.parse(node.attrs.lines);
      const m = /^\\(?:re)?newcommand\*?\{\\([A-Za-z]+)\}(?:\[(\d+)\])?\{([\s\S]*)\}$/.exec(lines[0]);
      if (m) {
        let display: string | undefined;
        if (lines[1]?.startsWith('{')) display = lines[1].slice(1, -1);
        defs.push({ pos, name: m[1], def: display || m[3], args: Number(m[2] ?? 0) });
      }
    } catch { /* ignore */ }
    return false;   // macro nodes have no formulas inside
  });
  return defs;
}

function applyMacros(view: EditorView, defs: InlineDef[], serverMacros: ServerMacros, merge: boolean): void {
  // server macros minus the ones this document defines itself (positional defs take over)
  const own = new Set(defs.map(d => d.name));
  const base: ServerMacros = {};
  for (const [k, v] of Object.entries(serverMacros)) if (!own.has(k)) base[k] = v;
  setDocumentMacros(base, merge);
  setInlineMacroDefs(view, defs);
}

/**
 * Macros: server-provided ones (preamble, \input files, child documents) apply everywhere;
 * FormulaMacro insets of this document apply from their position onwards (LyX semantics).
 * `merge` adds to the global dictionary instead of replacing it (child editors of a combined view).
 * The server macros are remembered per view; later document changes re-apply them through
 * `macroDefsPlugin`.
 */
export function refreshMacros(view: EditorView, serverMacros: ServerMacros, merge = false): void {
  serverMacrosByView.set(view, { macros: serverMacros, merge });
  markMacrosReady(view);
  applyMacros(view, inlineMacroDefs(view.state.doc), serverMacros, merge);
}

export { editorContext };
