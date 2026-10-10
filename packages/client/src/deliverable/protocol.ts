/**
 * Messages between the deliverable editor (DeliverableEditor.tsx, the app) and the runtime in the
 * sandboxed frame that shows the page (runtime/). The frame has an opaque origin: postMessage is
 * the only way across, and each side checks that a message comes from the other (the frame's
 * window / its parent) and carries `ol`.
 *
 * The editor owns the text (Y.Text) and makes every change of it; the runtime renders the text it
 * was last sent (`version`) and reports what people do on the canvas as operations on that version
 * (core html/source.ts HtmlOp, elements by path) — the editor rebases them onto the current text.
 */
import type { HtmlOp, Path } from '@overlyx/core/html/source.ts';

export type { HtmlOp, Path };

export type DeliverableKind = 'deck' | 'poster' | 'page';
export type Tool = 'select' | 'text' | 'rect' | 'ellipse' | 'line' | 'arrow' | 'formula';

export interface Rect { x: number; y: number; w: number; h: number }

/** what the toolbar shows of the selection */
export interface SelStyle {
  fontSize: string; fontFamily: string; fontWeight: string; fontStyle: string; textDecoration: string;
  color: string; background: string; textAlign: string; borderRadius: string; opacity: string;
  border: string;
}

export interface SelItem {
  path: Path;
  tag: string;
  /** a short name: its text, or what it is */
  label: string;
  /** in the frame's document (CSS px) */
  rect: Rect;
  movable: boolean;
  /** its text can be retyped in place */
  text: boolean;
  /** its height is its own (an image, a shape, a box given one), not its text's */
  fixedHeight: boolean;
  style: SelStyle;
  /** the slide it is on (index), -1 on a web page */
  slide: number;
}

export interface SlideBox { index: number; path: Path; rect: Rect; title: string }

/** editor → runtime */
export type ToRuntime =
  | { ol: 'source'; version: number; html: string }
  | { ol: 'select'; paths: Path[] }
  | { ol: 'editText'; path: Path; selectAll?: boolean }
  | { ol: 'scrollTo'; slide: number; smooth?: boolean }
  | { ol: 'scale'; scale: number }
  | { ol: 'tool'; tool: Tool }
  | { ol: 'exec'; command: string; value?: string }
  | { ol: 'go'; slide: number }
  | { ol: 'peers'; peers: { paths: Path[]; color: string; name: string }[] }
  | { ol: 'current'; slide: number }
  /** a file of the project changed on disk (project-relative): stylesheets and pictures are fetched again, scripts and data reload the page */
  | { ol: 'asset'; path: string; v: number };

/** runtime → editor */
export type FromRuntime =
  | { ol: 'ready'; version: number | null; kind: DeliverableKind; slides: SlideBox[]; width: number; height: number; docHeight: number }
  | { ol: 'layout'; slides: SlideBox[]; width: number; height: number; docHeight: number }
  | { ol: 'selection'; version: number; items: SelItem[] }
  | { ol: 'ops'; version: number; ops: HtmlOp[]; select?: 'inserted' | 'keep'; then?: 'editText' }
  | { ol: 'draw'; version: number; tool: Tool; slide: Path | null; rect: Rect; after?: Path | null }
  | { ol: 'editing'; path: Path | null }
  | { ol: 'key'; key: string; ctrl: boolean; shift: boolean; alt: boolean; meta: boolean }
  | { ol: 'contextmenu'; x: number; y: number; slide?: number }
  | { ol: 'visible'; slide: number }
  | { ol: 'goto'; slide: number }
  | { ol: 'exit' }
  | { ol: 'reload' }
  | { ol: 'pasteFiles'; files: { name: string; type: string; data: ArrayBuffer }[]; slide: Path | null; at: { x: number; y: number } | null }
  | { ol: 'scroll'; y: number };

export const isFromRuntime = (d: unknown): d is FromRuntime => !!d && typeof d === 'object' && typeof (d as { ol?: unknown }).ol === 'string';
