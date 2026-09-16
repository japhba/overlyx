/**
 * Messages between the extension host and the webviews (editor and PDF panel).
 * Everything REST-shaped goes over the local HTTP bridge instead (the client's `api` module,
 * pointed at it via OVERLYX_API_BASE); postMessage carries only document sync and UI signals.
 */

import type { DocumentModel, SyncTag } from './documentModel';

/** ProseMirror JSON document (nodes of the editor schema). */
export type PmDoc = { type: string; [k: string]: unknown };

export interface OutlineEntry { pos: number; level: number; text: string; layout: string; num?: string }

/** host → editor webview */
export type HostToEditor =
  | { type: 'relatedInit'; id: string; pmDoc: PmDoc; headerLines: string[]; meta: import('@client/api').DocMeta; ack: SyncTag | null }
  | { type: 'relatedExternalUpdate'; id: string; pmDoc: PmDoc; headerLines: string[]; ack: SyncTag | null }
  | { type: 'metadataChanged' }
  | { type: 'relatedError'; id: string; error: string }
  | { type: 'init'; docId: string; base: string; pmDoc: PmDoc; headerLines: string[]; fragment: boolean; dark: boolean; ack: SyncTag | null }
  /**
   * The file's content as the host now has it — changed outside the editor (git, another editor,
   * VS Code undo), or re-read after one of the editor's own updates was written. `ack` names the
   * last editor update it reflects, so the editor merges it against the right base (documentModel.ts).
   */
  | { type: 'externalUpdate'; pmDoc: PmDoc; headerLines: string[]; ack: SyncTag | null }
  /** move the cursor to a document position (outline click) */
  | { type: 'goto'; pos: number }
  | { type: 'navigate'; label?: string; heading?: number }
  /** run a UI command (keybindings / menus contributed on the VS Code side) */
  | { type: 'command'; name: 'toggleMargin' | 'toggleCombined' | 'find' | 'syncToPdf' | 'buildPdf' | 'toggleTracking' }
  /** SyncTeX inverse search: a line (1-based) of the LaTeX as built — locate it and move the cursor */
  | { type: 'inverseSync'; line: number }
  | { type: 'theme'; dark: boolean };

/** editor webview → host */
export type EditorToHost =
  | { type: 'hostCommand'; name: 'openSource' | 'openFile' | 'newFile' | 'closeTab' | 'outline' | 'back' | 'forward' | 'theme' | 'timeline' | 'scm'; id: string }
  | { type: 'loadRelated'; id: string }
  | { type: 'updateRelated'; id: string; pmDoc: PmDoc; headerLines: string[]; base: DocumentModel; sync: SyncTag }
  | { type: 'ready' }
  /** the document changed in the editor: full ProseMirror doc + header lines (debounced), numbered by `sync` */
  | { type: 'update'; pmDoc: PmDoc; headerLines: string[]; base: DocumentModel; sync: SyncTag }
  | { type: 'outline'; items: OutlineEntry[] }
  | { type: 'selection'; pos: number }
  | { type: 'notify'; text: string; kind?: 'info' | 'error'; stack?: string }
  /** flush pending edits and save the TextDocument (Ctrl+S inside the editor) */
  | { type: 'save' }
  /** start a PDF build (and open the PDF panel) / cancel it / just open the panel */
  | { type: 'build'; open: boolean }
  | { type: 'cancelBuild' }
  | { type: 'openPdfPanel' }
  /** open another document of the project (child document, label in another file) */
  | { type: 'openDoc'; id: string; goto?: string; heading?: number; beside?: boolean }
  /** SyncTeX forward search result: show this box in the PDF panel */
  | { type: 'syncTarget'; target: { page: number; x: number; y: number; w?: number; h?: number; seq: number } };

/** host → PDF webview */
export type HostToPdf =
  | { type: 'init'; docId: string; base: string; dark: boolean }
  | { type: 'syncTarget'; target: { page: number; x: number; y: number; w?: number; h?: number; seq: number } }
  | { type: 'theme'; dark: boolean };

/** PDF webview → host */
export type PdfToHost =
  | { type: 'ready' }
  /** double-click in the PDF: inverse search at this point (PDF points from the page's top-left) */
  | { type: 'inverse'; page: number; x: number; y: number }
  | { type: 'notify'; text: string; kind?: 'info' | 'error'; stack?: string };
