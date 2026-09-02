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
  /** show another document (or file) of the project — in place, one project at a time */
  openInTab?: (id: string, opts?: { goto?: string; heading?: number }) => void;
  /** jump to a label (in any open editor, or open the document that defines it) */
  gotoLabel?: (name: string, from?: EditorView) => void;
  /** the editor view that had the selection last (master or a child document) */
  activeView?: EditorView | null;
  /** the server can answer AI requests (a key is configured); the model names for the UI */
  ai?: { available: boolean; model: string; completionModel: string };
  /** an AI request is in flight (the status bar shows it) */
  aiBusy?: (on: boolean) => void;
  /** ⌘K inside a formula (set by editor/ai/rewrite.ts; the math field calls it) */
  aiRewriteMath?: (field: import('./lyxmath/field').LyxMathField) => void;
  /** the formula field currently being edited (App.tsx tracks focus) — the Agent panel reads its
   *  selection when the ProseMirror selection is empty */
  mathField?: import('./lyxmath/field').LyxMathField | null;
}

export const editorContext: EditorContext = { user: null, meta: null, docId: null, project: null, docDir: '', trackChanges: false, combined: false };

/** Resolve a document-relative file name (graphics, includes) to a project-relative path. */
export function resolveDocPath(file: string, docDir: string = editorContext.docDir): string {
  const parts = [...docDir.split('/').filter(Boolean), ...file.split('/')];
  const out: string[] = [];
  for (const p of parts) { if (p === '..') out.pop(); else if (p !== '.' && p !== '') out.push(p); }
  return out.join('/');
}

/** The inverse of resolveDocPath: a project-relative path as the document references it (LyX stores graphics relative to the document). */
export function toDocRel(projectRel: string, docDir: string = editorContext.docDir): string {
  const parts = docDir.split('/').filter(Boolean);
  if (!parts.length) return projectRel;
  const prefix = parts.join('/') + '/';
  return projectRel.startsWith(prefix) ? projectRel.slice(prefix.length) : '../'.repeat(parts.length) + projectRel;
}

/** Document id / directory of the document a view shows (child editors differ from the workspace document). */
export function viewDocId(view: EditorView): string { return view.dom.dataset.docId ?? editorContext.docId ?? ''; }
export function viewDocDir(view: EditorView): string { return view.dom.dataset.docDir ?? editorContext.docDir; }
export function viewProject(view: EditorView): string { return view.dom.dataset.project ?? editorContext.project ?? ''; }
