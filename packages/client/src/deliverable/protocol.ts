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
export type Tool = 'select' | 'text' | 'rect' | 'roundrect' | 'ellipse' | 'triangle' | 'diamond' | 'star' | 'hexagon' | 'line' | 'arrow' | 'pen' | 'bezier' | 'formula';

/** what kind of object the toolbar is showing tools for */
export type ObjKind = 'text' | 'shape' | 'line' | 'image' | 'svg' | 'svgpart' | 'group' | 'formula' | 'other';

/** PowerPoint's / Inkscape's arrangement commands, carried out by the runtime on the selection */
export type ArrangeHow =
  | 'front' | 'forward' | 'backward' | 'back'
  | 'align-left' | 'align-center' | 'align-right' | 'align-top' | 'align-middle' | 'align-bottom'
  | 'center-h' | 'center-v' | 'distribute-h' | 'distribute-v'
  | 'rotate-cw' | 'rotate-ccw' | 'rotate-reset' | 'flip-h' | 'flip-v'
  | 'group' | 'ungroup' | 'lock' | 'unlock'
  /** Inkscape's Path menu (runtime/pathedit.ts) */
  | 'union' | 'difference' | 'intersection' | 'exclusion' | 'combine' | 'break-apart' | 'to-path' | 'reverse' | 'simplify' | 'edit-nodes';

/** the node editor's commands (Inkscape's node toolbar) */
export type NodeCmd = 'insert' | 'delete' | 'corner' | 'smooth' | 'straight' | 'curve' | 'break' | 'join' | 'close' | 'all' | 'done';

/** the selection's fill and outline as the toolbar sets them (null removes; undefined leaves alone) */
export interface Paint {
  fill?: string | null;
  stroke?: string | null;
  strokeWidth?: number | null;
  dash?: 'solid' | 'dashed' | 'dotted' | null;
  radius?: number | null;
  opacity?: number | null;
  shadow?: boolean;
  arrowStart?: boolean;
  arrowEnd?: boolean;
}

/** how the editor shows what is around the pages (a view setting of this browser, never written to the file) */
export interface CanvasView {
  /** the canvas colour, null = the page's own background */
  desk: string | null;
  deskChecker: boolean;
  /** a transparency checkerboard under the pages */
  pageChecker: boolean;
}

export interface Rect { x: number; y: number; w: number; h: number }

/**
 * Where a formula is on the slide, for LyX's formula editor to lie exactly over it (frame client
 * px): its box, its baseline, the size of its font's em as MathJax drew it (scaled to the text's
 * x-height), and the side it grows from as it changes (a centred line grows both ways).
 */
/** a key typed (the formula editor's type-ahead: keys typed while a formula opened or was left) */
export interface KeyPress { key: string; shift?: boolean; ctrl?: boolean; alt?: boolean; meta?: boolean }

export interface MathBox { rect: Rect; baseline: number; em: number; align: 'left' | 'center' | 'right' }

/** what the toolbar shows of the selection */
export interface SelStyle {
  fontSize: string; fontFamily: string; fontWeight: string; fontStyle: string; textDecoration: string;
  color: string; background: string; textAlign: string; borderRadius: string; opacity: string;
  border: string;
  /** fill and outline as the paint tools see them (for an SVG: its shapes' fill / stroke) */
  fill: string | null; stroke: string | null; strokeWidth: number; dash: 'solid' | 'dashed' | 'dotted' | 'none';
  /** degrees clockwise (the CSS `rotate` property), flips (the `scale` property) */
  rotate: number; flipX: boolean; flipY: boolean;
  shadow: boolean; arrowStart: boolean; arrowEnd: boolean; lineHeight: string;
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
  kind: ObjKind;
  /** PowerPoint's lock: selected but not moved or resized (data-ol-locked) */
  locked: boolean;
  /** a picture inside a crop frame (div.ol-crop) */
  cropped: boolean;
  /** text can be typed into it (a text box, or a shape — empty or not) */
  canText: boolean;
  /** a picture's src as written (for Replace / Remove background) */
  src?: string;
}

export interface SlideBox { index: number; path: Path; rect: Rect; title: string }

/** editor → runtime */
export type ToRuntime =
  | { ol: 'source'; version: number; html: string }
  | { ol: 'select'; paths: Path[] }
  /** `math`: its first formula opened in LyX's formula editor at once (a new formula object) */
  | { ol: 'editText'; path: Path; selectAll?: boolean; math?: boolean }
  | { ol: 'scrollTo'; slide: number; smooth?: boolean }
  | { ol: 'scale'; scale: number; anchor?: { docY: number; screenY: number } }
  | { ol: 'tool'; tool: Tool }
  | { ol: 'exec'; command: string; value?: string }
  | { ol: 'go'; slide: number }
  | { ol: 'peers'; peers: { paths: Path[]; color: string; name: string }[] }
  | { ol: 'current'; slide: number }
  /** a file of the project changed on disk (project-relative): stylesheets and pictures are fetched again, scripts and data reload the page */
  | { ol: 'asset'; path: string; v: number }
  | { ol: 'arrange'; how: ArrangeHow }
  | { ol: 'paint'; paint: Paint }
  | { ol: 'view'; view: CanvasView }
  /** crop mode for a picture (optionally with an aspect / a round frame at once) — runtime/crop.ts */
  | { ol: 'crop'; path: Path; aspect?: number | null; shape?: 'rect' | 'circle' }
  /** cropped at once to an aspect or shape, or the crop reset — no crop mode */
  | { ol: 'cropPreset'; path: Path; aspect: number | null; shape?: 'rect' | 'circle'; reset?: boolean }
  /** in crop mode: the frame to an aspect / shape */
  | { ol: 'cropAspect'; aspect: number | null; shape?: 'rect' | 'circle' }
  /** the toolbar's Done / Cancel of crop mode */
  | { ol: 'endCrop'; commit: boolean }
  /** presenting: back to the whole slide (Escape left full screen while it was zoomed) */
  | { ol: 'unzoom' }
  /** the formula open in LyX's formula editor changed (runtime/mathedit.ts: the chip follows) */
  | { ol: 'mathSet'; id: number; tex: string }
  /** LyX's formula editor left the formula (`dir`: by an arrow key / Escape, the caret goes that side; null: elsewhere; `putBack`: Backspace in the empty formula `$` opened gives the typed dollar back as text) */
  | { ol: 'mathDone'; id: number; tex: string; dir: 'forward' | 'backward' | null; putBack?: string }
  /** `$$` typed: the empty inline formula `$` opened becomes a displayed one (as in documents) */
  | { ol: 'mathDisplay'; id: number }
  /** LyX's formula editor is drawn over the formula: the formula itself hidden meanwhile (the runtime answers with mathKeys) */
  | { ol: 'mathShown'; id: number }
  /** keys typed ahead that came after the formula was left by them (the closing `$` of `$x$ and`): the text's */
  | { ol: 'typeKeys'; keys: KeyPress[] }
  /** a new formula at the caret of the text being retyped (the toolbar's ∑ while typing) */
  | { ol: 'insertMath'; display: boolean }
  /** a command of the node editor (editing a path's points) */
  | { ol: 'nodes'; cmd: NodeCmd };

/** runtime → editor */
export type FromRuntime =
  | { ol: 'ready'; version: number | null; kind: DeliverableKind; slides: SlideBox[]; width: number; height: number; docHeight: number }
  | { ol: 'layout'; kind: DeliverableKind; slides: SlideBox[]; width: number; height: number; docHeight: number }
  | { ol: 'selection'; version: number; items: SelItem[] }
  | { ol: 'ops'; version: number; ops: HtmlOp[]; select?: 'inserted' | 'keep' | Path[]; then?: 'editText' }
  /** a new object drawn: its box (slide px), and for lines / the pen the points (slide px, in drawing order) */
  | { ol: 'draw'; version: number; tool: Tool; slide: Path | null; rect: Rect; after?: Path | null; pts?: [number, number][]; d?: string; closed?: boolean }
  | { ol: 'editing'; path: Path | null }
  | { ol: 'key'; key: string; ctrl: boolean; shift: boolean; alt: boolean; meta: boolean }
  /** `on`: what was right-clicked — an object (now selected), a slide's empty area, or the canvas around the pages */
  | { ol: 'contextmenu'; x: number; y: number; slide?: number; on?: 'object' | 'slide' | 'canvas' }
  | { ol: 'visible'; slide: number }
  | { ol: 'goto'; slide: number }
  | { ol: 'exit' }
  | { ol: 'reload' }
  | { ol: 'pasteFiles'; files: { name: string; type: string; data: ArrayBuffer }[]; slide: Path | null; at: { x: number; y: number } | null }
  | { ol: 'scroll'; y: number }
  /** a pinch or Ctrl+wheel in the frame: zoom by `factor` about a point (frame client px; its document y) */
  | { ol: 'zoom'; factor: number; clientX: number; clientY: number; pageY: number }
  /** sideways panning asked for in the frame (frame px; the editor pans what overflows its canvas) */
  | { ol: 'pan'; dx: number }
  /** the page's own colours: what is around its slides (the body's background) and the slides' usual one */
  | { ol: 'colors'; desk: string; page: string }
  /** crop mode started (the picture's path) or ended (null) */
  | { ol: 'cropping'; path: Path | null }
  /** presenting: the slide is zoomed in (or not any more) */
  | { ol: 'presentZoom'; zoomed: boolean }
  /**
   * a formula of the text being retyped to edit with LyX's formula editor (runtime/mathedit.ts):
   * where it is and how big its letters are, its colour; `at`: the click into it; `dollar`: opened
   * by typing `$` (or `$$`) in the text (LyxMathField.dollar)
   */
  | { ol: 'mathEdit'; id: number; tex: string; display: boolean; box: MathBox; color: string; at: { x: number; y: number } | null; where: 'start' | 'end'; dollar?: '$' | '$$' }
  /** the keys typed in the text after the formula was opened there, before LyX's formula editor had the keyboard: the formula's, before any typed since */
  | { ol: 'mathKeys'; id: number; keys: KeyPress[] }
  /** the formula being edited moved (scrolled, reflowed, typeset again as it changed) */
  | { ol: 'mathRect'; id: number; box: MathBox }
  /** the formula editor closes: the formula is shown again (`id`, after mathDone), or the retyping ended while one was open */
  | { ol: 'mathClose'; id?: number }
  /** the node editor is on (the path edited, how many of its nodes are selected) or off (null) */
  | { ol: 'nodeEditing'; path: Path | null; selected: number; total: number };

export const isFromRuntime = (d: unknown): d is FromRuntime => !!d && typeof d === 'object' && typeof (d as { ol?: unknown }).ol === 'string';
