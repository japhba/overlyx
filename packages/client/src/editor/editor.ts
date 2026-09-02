/**
 * Editor assembly: ProseMirror view bound to a Yjs document (y-prosemirror), LyX keymap,
 * node views (MathLive, insets, graphics, commands), decorations and collaboration cursors.
 */
import { EditorState, Plugin, TextSelection } from 'prosemirror-state';
import { EditorView, type NodeView } from 'prosemirror-view';
import { Fragment, Slice, type Node as PMNode } from 'prosemirror-model';
import { sliceText } from './cliptext';
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
import { changeTrackingPlugin, changesFilterPlugin } from './plugins/changes';
import { fontCarryPlugin } from './plugins/fontcarry';
import { insetCaretPlugin } from './plugins/insetcaret';
import { dragSelectPlugin } from './plugins/dragselect';
import { findPlugin } from './plugins/find';
import { mirrorCaretPlugin } from './plugins/mirrorcaret';
import { MathInlineView, MathDisplayView, MacroView } from './nodeviews/math';
import { InsetView } from './nodeviews/inset';
import { GraphicsView, CommandView, LeafView } from './nodeviews/leaf';
import { editorContext, viewDocDir, viewProject } from './context';
import { imageFiles, insertImageFiles, isSvgMarkup, looksLikeImageFileName, svgFile } from './imagepaste';
import { setDocumentMacros, setInlineMacroDefs, markMacrosReady } from './lyxmath/macrotable';
import { showContextMenu } from './contextmenu';
import { editorContextMenu } from './editormenu';
import { includeTarget } from './commands';
import { readSavedCursor, writeSavedCursor, restoredCursorPos, type SavedCursor } from './cursormemory';
import { aiRewritePlugin, openRewriteMath } from './ai/rewrite';
import { aiCompletePlugin } from './ai/complete';
import { installMathAssist } from './ai/mathassist';
import { getPrefs, subscribePrefs } from '../prefs';
import { spellPlugin, misspelledAt, spellSuggest } from './spell/plugin';
import { autocorrectPlugin } from './spell/autocorrect';
import { api, type User } from '../api';

installMathAssist();
editorContext.aiRewriteMath = (field) => openRewriteMath(field);

/**
 * A node view that throws (a malformed attribute that arrived over the wire, a rendering bug) must
 * not take the whole editor down: it is replaced by a marker that shows the error, and an `update`
 * that throws makes ProseMirror re-create the view instead of propagating.
 */
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
export interface PresenceUser { name: string; color: string; username?: string; /** profile picture URL (Google sign-in), if any */ avatar?: string | null; clientId: number; /** has a known cursor position in this document */ hasCursor: boolean; self: boolean }

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
  /** the selection changed; `docChanged`: because the document changed (typing, remote edits, loading), not by a cursor move */
  onSelectionChange?: (view: EditorView, info: { docChanged: boolean }) => void;
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
  /** the document is gone on the server (file deleted / project removed / history reset) */
  onGone?: (reason: string) => void;
  onSaveState?: (s: SaveState) => void;
  /** start read-only (until `setEditable(true)`) */
  readOnly?: boolean;
  /** where to put the cursor once the document is loaded (navigation history); null: the remembered place */
  initialCursor?: () => SavedCursor | null;
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
  // A lost connection is reported as "connecting…" for a few seconds before it becomes "offline":
  // the server restarts in ~2 s for a deployment and the WebSocket reconnects right away, which
  // should not read as an outage. (The browser's own offline signal is shown immediately.)
  const RECONNECT_GRACE_MS = 8000;
  let disconnectedAt = 0;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  const inGrace = () => navigator.onLine !== false && disconnectedAt > 0 && Date.now() - disconnectedAt < RECONNECT_GRACE_MS;
  const noteDisconnected = () => {
    if (disconnectedAt) return;
    disconnectedAt = Date.now();
    if (graceTimer) clearTimeout(graceTimer);
    graceTimer = setTimeout(() => { graceTimer = null; emitSaveState(); }, RECONNECT_GRACE_MS + 50);
  };
  const saveState = (): SaveState => {
    const pending = editSeq > savedSeq || (pendingFromStore && !provider.synced);
    const connected = provider.wsconnected;
    const state: SaveState['state'] = stale ? 'stale' : connected && provider.synced ? (pending ? 'saving' : 'saved') : connected || !localSynced || inGrace() ? 'connecting' : 'offline';
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
  /** origin of updates applied via messageHandlers[5] (the embedded agent's edits): tracked by
   *  the undo manager so Ctrl+Z reverts them, skipped by the local-edit bookkeeping below */
  const AGENT_EDIT_ORIGIN = 'agent-edit';
  ydoc.on('update', (_u: Uint8Array, origin: unknown) => {
    if (origin === provider || origin === persistence || origin === AGENT_EDIT_ORIGIN) return;
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
  // Message type 4 = server heartbeat (no payload): it only refreshes y-websocket's "last message
  // received" watchdog, so a healthy connection in a throttled background tab stays open.
  (provider as any).messageHandlers[4] = () => {};

  // Message type 2 = document epoch (OverLyX extension, sent by the server before sync step 1). If the
  // server's Yjs history differs from the one our local copy belongs to (the server re-created the
  // document), syncing would merge two unrelated histories: bail out instead and let the UI decide.
  let epoch: string | null = null;
  let stale = false;
  provider.on('connection-close', (ev: CloseEvent | null) => {
    if (ev) lastConnInfo = `closed with code ${ev.code}${ev.reason ? ': ' + ev.reason : ''}`;
    noteDisconnected();
    emitSaveState();
    if (ev?.code === 4003) opts.onAccessChanged?.();
    if (ev?.code === 4001 || ev?.code === 4004) opts.onGone?.(ev.reason || 'document not available');
  });
  provider.on('connection-error', () => { lastConnInfo = 'connection attempt failed'; noteDisconnected(); emitSaveState(); });
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
  // Message type 5 = an edit by the embedded agent (OverLyX extension): the same update bytes the
  // sync copy carries, applied here first with a *tracked* origin so Ctrl+Z can revert the agent
  // like one's own typing (yUndoPlugin below tracks this origin; the MSG_SYNC copy that follows
  // is an idempotent no-op). Other collaborators' edits remain un-undoable, as they should be.
  (provider as any).messageHandlers[5] = (_enc: unknown, dec: decoding.Decoder) => {
    flushDomSelection();
    Y.applyUpdate(ydoc, decoding.readVarUint8Array(dec), AGENT_EDIT_ORIGIN);
  };
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
    if (!localEmpty) restoreCursor();
    emitSaveState();
    // always try — navigator.onLine is unreliable (Chrome reports "offline" behind some VPNs / network
    // setups); a failing attempt just makes y-websocket retry with backoff
    provider.connect();
  };
  void connectAfterLocalLoad();
  const fragment = ydoc.getXmlFragment('prosemirror');
  const { doc: initialDoc, mapping } = initProseMirrorDoc(fragment, schema);

  provider.awareness.setLocalStateField('user', { name: opts.user.name, color: opts.user.color, username: opts.user.username, avatar: opts.user.avatar ?? null });

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
    yUndoPlugin({ trackedOrigins: [AGENT_EDIT_ORIGIN] }),
    // AI preview / ghost text come first: their Tab / Escape must win over the LyX bindings and table navigation
    aiRewritePlugin(),
    aiCompletePlugin(),
    spellPlugin(),
    autocorrectPlugin(),
    chordPlugin(),
    lyxKeymap(),
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
          if (cursorRestored && !prev.selection.eq(view.state.selection)) rememberCursor();
        },
      }),
    }),
  ];

  const state = EditorState.create({ schema, doc: initialDoc, plugins });
  let viewRef: EditorView | null = null;
  // cursor memory (see cursormemory.ts): written a moment after each move, restored once the document is here
  let cursorRestored = false;
  // a restored cursor also gets the keyboard (as in LyX), once editing is allowed and unless something else has it
  let focusWhenEditable = false;
  const focusRestored = () => { const a = document.activeElement; if (!a || a === document.body) view.focus(); };
  let cursorTimer: ReturnType<typeof setTimeout> | undefined;
  const rememberCursor = () => { clearTimeout(cursorTimer); cursorTimer = setTimeout(() => { if (viewRef && !destroyed) writeSavedCursor(opts.docId, viewRef.state); }, 250); };
  const flushCursor = () => { if (cursorRestored && viewRef && !destroyed) { clearTimeout(cursorTimer); writeSavedCursor(opts.docId, viewRef.state); } };
  window.addEventListener('pagehide', flushCursor);
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
      math_inline: (node, view, getPos) => guarded(node, () => new MathInlineView(node, view, getPos as () => number | undefined)),
      math_display: (node, view, getPos) => guarded(node, () => new MathDisplayView(node, view, getPos as () => number | undefined)),
      macro: (node, view, getPos) => guarded(node, () => new MacroView(node, view, getPos as () => number | undefined)),
      inset: (node, view, getPos) => guarded(node, () => new InsetView(node, view, getPos as () => number | undefined)),
      graphics: (node, view, getPos) => guarded(node, () => new GraphicsView(node, view, getPos as () => number | undefined)),
      command: (node, view, getPos) => guarded(node, () => new CommandView(node, view, getPos as () => number | undefined)),
      leaf: (node, view, getPos) => guarded(node, () => new LeafView(node, view, getPos as () => number | undefined)),
    },
    attributes: editorAttributes(!!opts.child, getPrefs()),
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
        if (!viewOnly) void insertImageFiles(view, images);
        return true;
      }
      const text = event.clipboardData?.getData('text/plain');
      const html = event.clipboardData?.getData('text/html');
      // SVG markup on the text clipboard ("Copy as SVG" in drawing tools): an image, not text
      if (text && !viewOnly && isSvgMarkup(text)) { void insertImageFiles(view, [svgFile(text)]); return true; }
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
        if (!viewOnly && /\\[a-zA-Z]+|\\\[|\\\(|\$[^$\n][^$]*\$/.test(text)) {
          void api.parseClip(view.dom.dataset.docId ?? opts.docId, text).then(r => {
            const blocks = (r.blocks as unknown[]).map(b => schema.nodeFromJSON(b)).filter(n => n.type.name !== 'doc');
            if (!blocks.length) { plainPaste(); return; }
            // a single plain paragraph flows into the current one; anything structured is inserted as whole paragraphs (closed slice — an open one would dissolve the first block's layout)
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
    // files dragged in from the computer: images are uploaded and inserted where they were dropped
    handleDrop(view, event, _slice, moved) {
      if (moved || !event.dataTransfer?.files.length) return false;   // internal drags and text drops: ProseMirror's own handling
      if (viewOnly) return true;
      const images = imageFiles(event.dataTransfer);
      if (!images.length) { editorContext.notify?.('Only images can be dropped into the text — other files go into the file browser', 'error'); return true; }
      const pos = view.posAtCoords({ left: event.clientX, top: event.clientY });
      void insertImageFiles(view, images, pos ? pos.pos : null);
      return true;
    },
  });
  viewRef = view;
  performance.mark('ol:editor-created');
  // the spell-check switch (Tools ▸ Spell checking) applies to open editors right away
  const unsubscribePrefs = subscribePrefs(p => { view.setProps({ attributes: editorAttributes(!!opts.child, p) }); });
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
    provider.awareness.getStates().forEach((s, clientId) => { if (s.user) users.push({ name: s.user.name, color: s.user.color, username: s.user.username, avatar: s.user.avatar ?? null, clientId, hasCursor: !!s.cursor, self: clientId === ydoc.clientID }); });
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
  provider.on('status', (e: { status: string }) => {
    status.connected = e.status === 'connected';
    if (status.connected) { disconnectedAt = 0; if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; } } else noteDisconnected();
    pushStatus(); emitSaveState();
  });
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
  // Hidden tabs: the page's timers are throttled (Chrome wakes a long-hidden tab once a minute), so
  // the presence renewal (every 15 s, the server drops a user's presence after 30 s) and the
  // reconnect back-off timer fall behind, and the user appeared to go offline whenever their tab
  // was covered. A worker's timer is not throttled: it renews the presence state when the page's
  // own timer missed it and reconnects a dropped connection without waiting for the back-off.
  const renewPresence = () => {
    const aw = provider.awareness;
    const meta = aw.meta.get(ydoc.clientID);
    if (aw.getLocalState() !== null && (!meta || Date.now() - meta.lastUpdated >= 15000)) aw.setLocalState(aw.getLocalState());
  };
  const keepAlive = () => {
    if (destroyed || stale) return;
    if (provider.wsconnected) renewPresence();
    else if (provider.shouldConnect && !provider.wsconnecting && provider.ws === null) provider.connect();
  };
  let heartbeat: Worker | null = null;
  try {
    heartbeat = new Worker(new URL('./heartbeat.ts', import.meta.url), { type: 'module' });
    heartbeat.onmessage = keepAlive;
  } catch { /* no worker support: the page timers still do their best */ }
  // Back in the foreground: reconnect immediately (no back-off) and tell the others we are here.
  const onVisible = () => {
    if (document.visibilityState !== 'visible' || destroyed || stale) return;
    if (!provider.wsconnected && !provider.wsconnecting) reconnect();
    else if (provider.wsconnected) renewPresence();
  };
  document.addEventListener('visibilitychange', onVisible);

  // Cursor where it was the last time this document was open here (else at the start), once the
  // document is available: from the local copy, or from the server. Children (combined view) keep
  // their own start. The remote cursors / formulas render later and change the layout, so the
  // place is scrolled to once more shortly after.
  function restoreCursor() {
    if (cursorRestored || opts.child || destroyed) return;
    cursorRestored = true;
    try {
      const doc = view.state.doc;
      const saved = opts.initialCursor?.() ?? readSavedCursor(opts.docId);
      const sel = saved ? TextSelection.near(doc.resolve(restoredCursorPos(doc, saved))) : TextSelection.atStart(doc);
      view.dispatch(view.state.tr.setSelection(sel).scrollIntoView().setMeta('addToHistory', false));
      if (saved) {
        if (editable) focusRestored(); else focusWhenEditable = true;
        setTimeout(() => { if (!destroyed && view.state.selection.eq(sel)) view.dispatch(view.state.tr.scrollIntoView()); }, 400);
      }
    } catch { /* empty document */ }
  }
  if (!opts.child) {
    const once = (s: boolean) => {
      if (!s) return;
      provider.off('sync', once);
      restoreCursor();
    };
    provider.on('sync', once);
  }

  return {
    view, ydoc, provider,
    setEditable(on: boolean) {
      if (on !== editable) { editable = on; view.setProps({ editable: () => editable }); }
      if (on && focusWhenEditable) { focusWhenEditable = false; focusRestored(); }
    },
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
      flushCursor();
      unsubscribePrefs();
      window.removeEventListener('pagehide', flushCursor);
      destroyed = true;
      stopRetry();
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisible);
      heartbeat?.terminate();
      if (graceTimer) clearTimeout(graceTimer);
      // the view first: its Yjs binding must be gone before the provider/awareness fire their last events
      view.destroy();
      provider.awareness.setLocalState(null);
      provider.destroy();
      persistence.destroy();
      ydoc.destroy();
    },
  };
}

function editorAttributes(child: boolean, p: { spellcheck: boolean; spellEngine: string }): Record<string, string> {
  // the browser's checker only when it is the chosen engine (two sets of underlines otherwise)
  return { class: 'lyx-editor' + (child ? ' lyx-editor-child' : ''), spellcheck: p.spellcheck && p.spellEngine === 'browser' ? 'true' : 'false' };
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
export function macroDefsPlugin(getView: () => EditorView | null): Plugin {
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
