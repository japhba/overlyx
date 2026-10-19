import type * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import type { EditorState } from 'prosemirror-state';
import type { Binding } from '@overlyx/core/collab/index.ts';
import type { SyncLedger } from '../shared/documentModel';

/** The document and undo history outlive refreshable views. Never seed a refresh from init.pmDoc. */
export interface EditorSession {
  ydoc: Y.Doc;
  awareness: Awareness;
  /** the editor's binding to the CRDT (client editor/collab.ts) */
  binding?: Binding;
  /** the last editor state: its undo history continues in the next view (reconfigured with that view's plugins) */
  state?: EditorState;
  selection?: unknown;
  scrollTop: number;
  headerLines?: string[];
  /** the updates sent to the host and what the two sides agree on (shared/documentModel.ts) */
  ledger: SyncLedger;
}

export const editorSessions: Map<string, EditorSession> = import.meta.hot?.data.sessions ?? new Map();
if (import.meta.hot) import.meta.hot.data.sessions = editorSessions;
