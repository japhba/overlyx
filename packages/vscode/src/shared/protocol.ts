/**
 * Messages between the extension host and the webviews (editor and PDF panel).
 * Everything REST-shaped goes over the local HTTP bridge instead (the client's `api` module,
 * pointed at it via OVERLYX_API_BASE); postMessage carries only document sync and UI signals.
 */

/** ProseMirror JSON document (nodes of the editor schema). */
export type PmDoc = { type: string; [k: string]: unknown };

export interface OutlineEntry { pos: number; level: number; text: string; layout: string; num?: string }

/** host → editor webview */
export type HostToEditor =
  | { type: 'init'; docId: string; base: string; pmDoc: PmDoc; headerLines: string[]; fragment: boolean; dark: boolean }
  /** the file changed outside the editor (git, another editor, VS Code undo): new content, applied as a diff */
  | { type: 'externalUpdate'; pmDoc: PmDoc; headerLines: string[] }
  /** move the cursor to a document position (outline click) */
  | { type: 'goto'; pos: number }
  /** run a UI command (keybindings / menus contributed on the VS Code side) */
  | { type: 'command'; name: 'toggleMargin' | 'find' | 'syncToPdf' | 'buildPdf' | 'toggleTracking' }
  /** SyncTeX inverse search: a line (1-based) of the LaTeX as built — locate it and move the cursor */
  | { type: 'inverseSync'; line: number }
  | { type: 'theme'; dark: boolean };

/** editor webview → host */
export type EditorToHost =
  | { type: 'ready' }
  /** the document changed in the editor: full ProseMirror doc + header lines (debounced) */
  | { type: 'update'; pmDoc: PmDoc; headerLines: string[] }
  | { type: 'outline'; items: OutlineEntry[] }
  | { type: 'selection'; pos: number }
  | { type: 'notify'; text: string; kind?: 'info' | 'error' }
  /** flush pending edits and save the TextDocument (Ctrl+S inside the editor) */
  | { type: 'save' }
  /** start a PDF build (and open the PDF panel) / cancel it / just open the panel */
  | { type: 'build' }
  | { type: 'cancelBuild' }
  | { type: 'openPdfPanel' }
  /** open another document of the project (child document, label in another file) */
  | { type: 'openDoc'; id: string; goto?: string; heading?: number }
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
  | { type: 'notify'; text: string; kind?: 'info' | 'error' };
