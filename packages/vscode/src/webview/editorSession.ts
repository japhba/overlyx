import type * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import type { SyncLedger } from '../shared/documentModel';

/** The document and undo history outlive refreshable views. Never seed a refresh from init.pmDoc. */
export interface EditorSession {
  ydoc: Y.Doc;
  awareness: Awareness;
  undoManager: Y.UndoManager;
  selection?: unknown;
  binding?: object;
  scrollTop: number;
  headerLines?: string[];
  /** the updates sent to the host and what the two sides agree on (shared/documentModel.ts) */
  ledger: SyncLedger;
}

export const editorSessions: Map<string, EditorSession> = import.meta.hot?.data.sessions ?? new Map();
if (import.meta.hot) import.meta.hot.data.sessions = editorSessions;
