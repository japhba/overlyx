/** Shared editor context (current user, document meta, UI hooks) for node views and commands. */
import type { EditorView } from 'prosemirror-view';
import type { DocMeta, User } from '../api';

export interface EditorContext {
  user: User | null;
  meta: DocMeta | null;
  docId: string | null;
  project: string | null;
  /** directory of the document inside the project ('' for the project root) */
  docDir: string;
  /** open the inset settings dialog for the inset node at pos */
  openInsetDialog?: (view: EditorView, pos: number | undefined) => void;
  /** open a document-level dialog by name (graphics, table, label, ref, cite, href, ...) */
  openDialog?: (name: string, arg?: unknown) => void;
  /** notify UI (status bar) */
  notify?: (msg: string, kind?: 'info' | 'error') => void;
  /** last uncaught error shown to the user (offered in the feedback dialog) */
  lastError?: string;
  /** author id used for change tracking */
  changeAuthorId?: number;
  trackChanges: boolean;
  /** master + child documents shown in one view */
  combined: boolean;
  /** open a document in a tab of the workspace (optionally without switching to it) */
  openInTab?: (id: string, opts?: { background?: boolean; goto?: string }) => void;
  /** jump to a label (in any open editor, or open the document that defines it) */
  gotoLabel?: (name: string, from?: EditorView) => void;
  /** the editor view that had the selection last (master or a child document) */
  activeView?: EditorView | null;
}

export const editorContext: EditorContext = { user: null, meta: null, docId: null, project: null, docDir: '', trackChanges: false, combined: false };

/** Resolve a document-relative file name (graphics, includes) to a project-relative path. */
export function resolveDocPath(file: string, docDir: string = editorContext.docDir): string {
  const parts = [...docDir.split('/').filter(Boolean), ...file.split('/')];
  const out: string[] = [];
  for (const p of parts) { if (p === '..') out.pop(); else if (p !== '.' && p !== '') out.push(p); }
  return out.join('/');
}

/** Document id / directory of the document a view shows (child editors differ from the workspace document). */
export function viewDocId(view: EditorView): string { return view.dom.dataset.docId ?? editorContext.docId ?? ''; }
export function viewDocDir(view: EditorView): string { return view.dom.dataset.docDir ?? editorContext.docDir; }
export function viewProject(view: EditorView): string { return view.dom.dataset.project ?? editorContext.project ?? ''; }
