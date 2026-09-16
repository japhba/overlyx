import type * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import type { DocumentModel } from '../shared/documentModel';

/** The document and undo history outlive refreshable views. Never seed a refresh from init.pmDoc. */
export interface EditorSession {
  ydoc: Y.Doc;
  awareness: Awareness;
  undoManager: Y.UndoManager;
  selection?: unknown;
  binding?: object;
  scrollTop: number;
  headerLines?: string[];
  base: DocumentModel;
}

export const editorSessions: Map<string, EditorSession> = import.meta.hot?.data.sessions ?? new Map();
if (import.meta.hot) import.meta.hot.data.sessions = editorSessions;
