/** Shared editor context (current user, document meta, UI hooks) for node views and commands. */
import type { EditorView } from 'prosemirror-view';
import type { DocMeta, User } from '../api';

export interface EditorContext {
  user: User | null;
  meta: DocMeta | null;
  docId: string | null;
  project: string | null;
  /** open the inset settings dialog for the inset node at pos */
  openInsetDialog?: (view: EditorView, pos: number | undefined) => void;
  /** open a document-level dialog by name (graphics, table, label, ref, cite, href, ...) */
  openDialog?: (name: string, arg?: unknown) => void;
  /** notify UI (status bar) */
  notify?: (msg: string, kind?: 'info' | 'error') => void;
  /** author id used for change tracking */
  changeAuthorId?: number;
  trackChanges: boolean;
}

export const editorContext: EditorContext = { user: null, meta: null, docId: null, project: null, trackChanges: false };
