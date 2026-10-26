/** Shared editor context (current user, document meta, UI hooks) for node views and commands. */
import type { EditorView } from 'prosemirror-view';
import type { AiStatus, DocMeta, User } from '../api';
import { graphicsUrl } from '../api';

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
  /** when this window last applied its LaTeX source pane (SourcePane apply): formulas the server rebuilds from it come back without their edit clock — ours, not a competing edit (mathconflict.ts) */
  sourceAppliedAt?: number;
  /** fetch the document's metadata again (an author the editor does not know yet showed up in a change) — App.tsx */
  refreshAuthors?: () => void;
  /** other names this person's comments carry (VS Code: git's user.name besides "You") — plugins/commentguard.ts */
  myNames?: string[];
  /** author id used for change tracking */
  changeAuthorId?: number;
  trackChanges: boolean;
  /** master + child documents shown in one view */
  combined: boolean;
  /** open a document in a tab of the workspace (optionally without switching to it) */
  /** show another document (or file) of the project — in place, one project at a time */
  openInTab?: (id: string, opts?: { goto?: string; heading?: number }) => void;
  /** Host-specific destination for opening a document separately. */
  separateDocument?: { label: string; open(id: string): void };
  /** jump to a label (in any open editor, or open the document that defines it) */
  gotoLabel?: (name: string, from?: EditorView) => void;
  /** the editor view that had the selection last (master or a child document) */
  activeView?: EditorView | null;
  /** the server can answer AI requests (a key is configured); the models offered, for the UI */
  ai?: AiStatus;
  /** an AI request is in flight (the status bar shows it) */
  aiBusy?: (on: boolean) => void;
  /** ⌘J inside a formula (set by editor/ai/rewrite.ts; the math field calls it) */
  aiRewriteMath?: (field: import('./lyxmath/field').LyxMathField) => void;
  /** ⌘K inside a formula: the link box (set by editor/links.ts; the math field calls it) */
  mathLink?: (field: import('./lyxmath/field').LyxMathField) => void;
  /** the formula field currently being edited (App.tsx tracks focus) — the Agent panel reads its
   *  selection when the ProseMirror selection is empty */
  mathField?: import('./lyxmath/field').LyxMathField | null;
  /** documents open in the workspace panel (the active one first) — sent to the agent as context */
  openDocs?: () => string[];
  /** "Ask agent about this" (right-click menu): pin the selection for the Agent panel's next message — set by a shell that has the panel */
  askAgent?: () => void;
  /**
   * The web address of a file (a document's id, a `text:` / `pdf:` tab id), which the "Copy link to …"
   * entries extend by the place (editor/permalink.ts): the web app's own, the VS Code extension's
   * when the folder is synced with a project — null (no such entries) otherwise
   */
  webLink?: (id: string) => string | null;
  /**
   * "Copy link to …" in a shell that can share: who may open the link `url` is asked first — the
   * people with access, or anyone, through a new share link (app/CopyLinkDialog.tsx); unset: copied
   * as it is
   */
  askLinkScope?: (url: string, what: string) => void;
  /** How the shell shows the document `id` when it is the open one, as a link's `view=` (app/panes.ts viewParam); null for other files */
  linkView?: (id: string) => string | null;
}

export const editorContext: EditorContext = { user: null, meta: null, docId: null, project: null, docDir: '', trackChanges: false, combined: false };

/**
 * `editorContext.meta` tells who listens when it is replaced (the shells assign it after every
 * metadata fetch — a project event after an agent or a collaborator changed the bibliography, Reload
 * metadata, the settings dialog, change tracking turned on): what was drawn from it — the authors of
 * tracked changes, citations' author and year — is redrawn without a reload.
 */
const metaListeners = new Set<() => void>();
let currentMeta: DocMeta | null = null;
Object.defineProperty(editorContext, 'meta', {
  enumerable: true,
  get: () => currentMeta,
  set(m: DocMeta | null) {
    if (m === currentMeta) return;
    currentMeta = m;
    for (const fn of metaListeners) { try { fn(); } catch (e) { console.error('metadata listener failed', e); } }
  },
});
/** Call `fn` whenever `editorContext.meta` is replaced; returns the unsubscribe. */
export function onMetaChange(fn: () => void): () => void {
  metaListeners.add(fn);
  return () => { metaListeners.delete(fn); };
}

/** Resolve a document-relative file name (graphics, includes) to a project-relative path. */
export function resolveDocPath(file: string, docDir: string = editorContext.docDir): string {
  const parts = [...docDir.split('/').filter(Boolean), ...file.split('/')];
  const out: string[] = [];
  for (const p of parts) {
    if (p === '..' && out.length && out[out.length - 1] !== '..') out.pop();
    else if (p !== '.' && p !== '') out.push(p);
  }
  return out.join('/');
}

/**
 * Where a figure's file name (`\includegraphics`, an image object) may be, project-relative, in the
 * order graphicx looks: beside the document, then in the folders of its \graphicspath (the metadata's).
 */
export function figureCandidates(file: string, docDir: string = editorContext.docDir): string[] {
  const out = [resolveDocPath(file, docDir)];
  if (file.startsWith('/')) return out;
  for (const dir of editorContext.meta?.graphicsPath ?? []) {
    const c = resolveDocPath(file, dir);
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

/** The image URL of a figure: the graphics endpoint takes the first candidate that exists (figureCandidates). */
export function figureUrl(project: string, file: string, docDir: string = editorContext.docDir, w = 1200): string {
  const [first, ...alt] = figureCandidates(file, docDir);
  return graphicsUrl(project, first, w, alt);
}

/** The figure's file as the project's file list knows it (the first candidate found, its extension added), project-relative; else the first candidate. */
export function figureFile(file: string, docDir: string = editorContext.docDir): string {
  const cands = figureCandidates(file, docDir);
  const has = new Set((editorContext.meta?.files ?? []).map(f => f.path));
  for (const c of cands) {
    if (has.has(c)) return c;
    const ext = /\.[A-Za-z0-9]{1,5}$/.test(c) ? undefined : ['.pdf', '.png', '.jpg', '.jpeg', '.eps', '.svg'].find(e => has.has(c + e));
    if (ext) return c + ext;
  }
  return cands[0];
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
