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
import type { HtmlOp, Path, SourcePatch } from '@overlyx/core/html/source.ts';
import type { CiteEntry } from '@overlyx/core/html/refs.ts';
import type { MathJaxMacro } from '@overlyx/core/html/deckextras.ts';
import type { ReliabilityEvent, ReliabilityPointer } from '@overlyx/core/reliability.ts';
import type { GlitchFields } from '@overlyx/core/glitch.ts';
import type { PresentState, PresenterState } from '../app/presentshare';

export type { HtmlOp, Path };
export type { ReliabilityEvent, ReliabilityPointer };

export type DeliverableKind = 'deck' | 'poster' | 'page';
/**
 * `references`: a list of the works cited (an element of class ol-bibliography, runtime/cite.ts);
 * `pen`: Draw — freehand strokes in the pen's or the highlighter's ink (InkStyle), one after the
 * other; `eraser`: removes the strokes it passes over; `lasso`: a loop drawn round things selects them
 * (Draw's: the kinds and colours InkStyle.lasso lets it take)
 */
export type Tool = 'select' | 'lasso' | 'text' | 'rect' | 'roundrect' | 'ellipse' | 'triangle' | 'diamond' | 'star' | 'hexagon' | 'line' | 'arrow' | 'pen' | 'eraser' | 'bezier' | 'formula' | 'references';

/** the ink a stroke is drawn in (Draw): colour, width in slide px, opacity (the highlighter's < 1, laid over what is under it as a highlighter is) */
/**
 * Draw's pen, GoodNotes' settings (0..1 each): a ball pen (an even, round line) or a fountain pen with
 * its tip sharpness (round or pointed ends), pressure sensitivity and tip flatness (a flat nib: down-
 * strokes full, up-strokes hairlines); the stroke stabilization (smoothing) and rounding (straight or curved
 * from one reported point to the next) of either; the pressure the hand usually writes with (measured by
 * the pen calibration, PenCalibration.tsx). runtime/freehand.ts.
 */
export interface Nib {
  ball: boolean; sharpness: number; sensitivity: number; flatness: number; stabilization: number; rounding: number; usual: number;
  /** found in the pen lab (PenLab.tsx; freehand.ts NibOpts): the pressure's smoothing (screen px), where the ink breaks off and is full (parts of the stroke's strongest pressure) — else the engine's own */
  pressSmooth?: number; liftLo?: number; liftHi?: number;
}

export interface InkStyle {
  color: string; width: number; opacity: number;
  /** the pen's (not the highlighter's) */
  nib?: Nib;
  /** fingers move the slide and only the pen draws ('pan': a Pencil has drawn in this browser), or draw too; unsaid: once a Pencil has drawn here */
  fingers?: 'pan' | 'draw';
  /** scribbling over strokes erases them (GoodNotes) */
  scribble?: boolean;
  /** a pen (the Pencil, a stylus) draws as soon as it touches the slide, Draw or not (its settings; never when the page can't be changed) */
  penInks?: boolean;
  /** draw and hold: a stroke held still at its end becomes a shape (core/shapesnap.ts) */
  snap?: boolean;
  /** the eraser's settings (deckink.ts EraserSet) */
  eraser?: { precise: boolean; size: 0 | 1 | 2; hlOnly: boolean; back: boolean };
  /** what the lasso takes, and of which colours (lower-case #rrggbb; none: any) */
  lasso?: { kinds: ('ink' | 'shapes' | 'pictures' | 'text')[]; colors: string[] };
}

/** what kind of object the toolbar is showing tools for */
export type ObjKind = 'text' | 'shape' | 'line' | 'image' | 'svg' | 'svgpart' | 'group' | 'formula' | 'ink' | 'other';

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

/** Draw's stroke, a run at one width (runtime/freehand.ts): its path data in the stroke's box */
export interface InkRunD { w: number; d: string }

/** the selection's fill and outline as the toolbar sets them (null removes; undefined leaves alone) */
export interface Paint {
  /** Draw's ink, whichever way the stroke is painted (a filled outline before, stroked runs now) */
  ink?: string;
  /** Draw's strokes thinner (< 1) or thicker (> 1): their widths times this */
  inkScale?: number;
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
export interface KeyPress { key: string; text?: string; shift?: boolean; ctrl?: boolean; alt?: boolean; meta?: boolean }

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
  /** the list it is or holds: its items appear one by one from step `steps` (data-steps), or all at once (null) */
  list?: { path: Path; steps: number | null };
  /** a layout's placeholder (decklayouts.ts): its role, and whether nothing is in it yet */
  ph?: { role: string; empty: boolean };
  /** on every slide (deckmaster.ts data-ol-master): its key */
  master?: string;
}

/** `deleted`: deleted as a suggestion (shown faded until accepted; not presented); `skipped`: Skip slide (deckmaster.ts: not presented, not printed) */
export interface SlideBox { index: number; path: Path; rect: Rect; title: string; deleted?: boolean; skipped?: boolean }

/** how the canvas shows the review (runtime/review.ts) */
export interface ReviewView {
  /** suggested additions / deletions shown (the mode switch's Show changes) */
  ins: boolean;
  del: boolean;
  /** Suggesting is on: retyped words are marked as they are typed */
  suggesting: boolean;
  /** this person's name, for the marks typed here */
  me: string;
  /** the comment thread looked at: its object (pin highlighted), the words it is on (highlighted) */
  focus: { path: Path; quote?: string } | null;
}

/**
 * A deck or poster on the canvas shows one slide at a time (runtime edit.ts): the slide shown, where it
 * is in the frame's document (CSS px) and the frame's height that holds it with room around it.
 * `content`: where what is on it is (its text, pictures, drawings, filled or framed boxes — not its
 * background), the slide's margins left out: what Fit content zooms to (none: nothing on it).
 */
export interface Solo { slide: number; rect: Rect; height: number; content?: Rect }

/** what an object does at a step when presenting (core html/steps.ts) */
export type StepKind = 'appear' | 'disappear';

/** a row of the Animation pane: an object of the slide appears or disappears at a step (`up` / `down`: it can move that way) */
/** a row of the Objects pane (runtime/objects.ts): an object of the slide, of a group or of a drawing; `kids`: the rows nested under it */
export interface ObjNode { path: Path; depth: number; kind: ObjKind; word: string; label: string; named: boolean; locked: boolean; kids: number }

export interface StepRow { path: Path; label: string; kind: StepKind; step: number; up: boolean; down: boolean; selected: boolean }

/** the Animation pane's commands, carried out by the runtime on the slide worked on (runtime/animate.ts) */
export type StepCmd =
  /** the selection appears / disappears on the next clicks, one each in the order its objects were clicked (`together`: all on one) */
  | { how: 'add'; kind: StepKind; together?: boolean }
  /** click-in-order mode on (what the objects clicked do) or off */
  | { how: 'order'; kind: StepKind | null }
  /** an event a notch earlier or later */
  | { how: 'move'; path: Path; step: number; dir: -1 | 1 }
  | { how: 'remove'; path: Path; step: number }
  /** the selection shown throughout */
  | { how: 'clear' }
  /** a list's items one by one, or all at once */
  | { how: 'list'; path: Path; on: boolean };

/**
 * A caret in a text being retyped: the text box (its path) and places in its text — a character, a
 * formula, a citation, a line break, the start of a paragraph or list item each one place (runtime
 * carets.ts). `head` is where the caret is, `anchor` where the selected words start.
 */
export interface TextCaret { path: Path; anchor: number; head: number }
/** how selected words look (computed, as SelStyle has them) */
export type WordsStyle = Pick<SelStyle, 'fontSize' | 'fontFamily' | 'fontWeight' | 'fontStyle' | 'textDecoration' | 'color'>;

/** another person on the page: what they selected, the text they retype, the slide they look at */
export interface PeerInfo { paths: Path[]; color: string; name: string; caret?: TextCaret | null; slide?: number }

/** editor → runtime */
export type ToRuntime =
  | { ol: 'exportSvg'; id: number; except?: string }
  /** the text at `version`: all of it, or (`patch`) as patches of version `base` (core html/source.ts sourcePatch), which the frame shows now */
  | { ol: 'source'; version: number; html?: string; patch?: { base: number; list: SourcePatch[] } }
  | { ol: 'assets'; urls: Record<string, string> }
  | { ol: 'folder'; base: string }
  | { ol: 'select'; paths: Path[] }
  /** `math`: its first formula opened in LyX's formula editor at once (a new formula object) */
  | { ol: 'editText'; path: Path; selectAll?: boolean; math?: boolean }
  /** end the retyping of a text (before an undo from the toolbar: the box being retyped does not take new versions) */
  | { ol: 'stopText'; save?: boolean }
  | { ol: 'scrollTo'; slide: number; smooth?: boolean }
  | { ol: 'scale'; scale: number; anchor?: { docY: number; screenY: number } }
  /** (`held`: Draw is open — the pen does not go back to Select after a stroke it took itself) */
  | { ol: 'tool'; tool: Tool; ink?: InkStyle; held?: boolean }
  /** the lasso's Convert on the selected strokes (runtime notetools.ts): shapes, or the handwriting read (it answers inkRead) */
  | { ol: 'inkConvert'; as: 'shapes' | 'notes' | 'formula' }
  /** what the handwriting was read as: the selected strokes give way to it */
  | { ol: 'inkTyped'; text: string; as: 'notes' | 'formula' }
  /** the guides shown on the slides (guides.ts) or not */
  | { ol: 'guides'; show: boolean }
  | { ol: 'exec'; command: string; value?: string }
  | { ol: 'go'; slide: number }
  | { ol: 'peers'; peers: PeerInfo[] }
  /**
   * The editor's dark theme (app/darkpages.ts): `invert` — the slides shown light on dark (smart
   * invert, prefs.darkPages; the canvas and the rail, never presenting); `figures` — line-art pictures
   * inverted with them, photographs back in their colours (prefs.invertFigures; without it every
   * picture keeps its colours); `desk` — the rail's background (the canvas's comes with the view),
   * null for the page's own
   */
  | { ol: 'dark'; invert: boolean; figures?: boolean; desk: string | null }
  | { ol: 'current'; slide: number }
  /** a file of the project changed on disk (project-relative): stylesheets and pictures are fetched again, scripts and data reload the page */
  | { ol: 'asset'; path: string; v: number }
  | { ol: 'arrange'; how: ArrangeHow }
  | { ol: 'paint'; paint: Paint }
  /** the selected text boxes aligned to their top, middle or bottom (runtime arrange.ts valign) */
  | { ol: 'valign'; v: 'flex-start' | 'center' | 'flex-end' }
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
  /** presenting: fingers draw too, or only the Pencil does (app/presentkit.ts; kept by the editor, the frame has no storage) */
  | { ol: 'presentFingers'; on: boolean }
  /** presenting: the bar's "Linked" as this browser keeps it */
  | { ol: 'presentLinked'; on: boolean }
  /** presenting: the other screens presenting the document, their `present` awareness states as they came (app/presentshare.ts checks them) */
  | { ol: 'presentPeers'; peers: PresenterState[] }
  /** the formula open in LyX's formula editor changed (runtime/mathedit.ts: the chip follows) */
  | { ol: 'mathSet'; id: number; tex: string }
  /** LyX's formula editor left the formula (`dir`: by an arrow key / Escape, the caret goes that side; null: elsewhere; `putBack`: Backspace in the empty formula `$` opened gives the typed dollar back as text) */
  | { ol: 'mathDone'; id: number; tex: string; dir: 'forward' | 'backward' | null; putBack?: string; keys?: KeyPress[] }
  /** `$$` typed: the empty inline formula `$` opened becomes a displayed one (as in documents) */
  | { ol: 'mathDisplay'; id: number }
  /** LyX's formula editor is drawn over the formula: the formula itself hidden meanwhile (the runtime answers with mathKeys) */
  | { ol: 'mathShown'; id: number }
  /** bibliography entries of keys cited since the page was served (runtime/cite.ts) */
  | { ol: 'bib'; entries: CiteEntry[] }
  /** a citation or reference (`\cite{…}`, `\eqref{…}`) put at the caret of the text being retyped, as a chip */
  | { ol: 'insertRef'; src: string }
  /** keys typed ahead that came after the formula was left by them (the closing `$` of `$x$ and`): the text's */
  | { ol: 'typeKeys'; keys: KeyPress[] }
  /** a new formula at the caret of the text being retyped (the toolbar's ∑ while typing) */
  | { ol: 'insertMath'; display: boolean }
  /** a command of the node editor (editing a path's points) */
  | { ol: 'nodes'; cmd: NodeCmd }
  /** a command of the Animation pane */
  | { ol: 'steps'; cmd: StepCmd }
  /** Ctrl+A with the keyboard in the editor (not in the canvas): every object of the slide shown */
  | { ol: 'selectAll' }
  /** the Objects pane opened or closed: its tree is sent (`objects`) while it is open */
  | { ol: 'objects'; on: boolean }
  /** the Objects pane's row under the pointer: that object outlined on the canvas */
  | { ol: 'hover'; path: Path | null }
  /** the Objects pane's drag: `path` in front of (or behind) its sibling `ref` */
  | { ol: 'restack'; path: Path; ref: Path; front: boolean }
  /** Object shortcuts with the keyboard in the host: use the canvas's current selection. */
  | { ol: 'canvasKey'; key: 'Escape' | 'Delete' | 'Backspace' | 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown'; shift: boolean }
  /** how the review is shown, Suggesting on or off */
  | { ol: 'review'; view: ReviewView }
  /** Ctrl+Alt+M or the Comment button: what a new comment is on (the runtime answers with `comment`) */
  | { ol: 'newComment' }
  /** the right-click menu's weave chosen: the crossing right-clicked woven (or its weave undone) — runtime/weave.ts */
  | { ol: 'weave' }
  /** Ctrl+V with the keyboard in the editor: what the clipboard holds, pasted on the canvas (runtime/clip.ts) */
  | { ol: 'paste'; html: string; plain: string; files: { name: string; type: string; data: ArrayBuffer }[] }
  /** how the deck's text looks where the editor asks (a new slide's placeholders take it: decklayouts.ts) — answered with `looks` */
  | { ol: 'looks'; id: number; paths: Path[] };

/** the computed type of a text element (CSS values as the browser gives them) */
export interface TextLook { fontSize: string; lineHeight: string; fontFamily: string; fontWeight: string; color: string }

/** runtime → editor */
export type FromRuntime =
  | { ol: 'exportedSvg'; id: number; svg?: string; error?: string }
  | { ol: 'offlineBoot'; opaque: true }
  /** `macros`: those of the .tex files the page links (for LyX's formula editor) */
  | { ol: 'ready'; version: number | null; kind: DeliverableKind; slides: SlideBox[]; width: number; height: number; docHeight: number; macros?: Record<string, MathJaxMacro>; solo?: Solo }
  | { ol: 'layout'; version: number | null; kind: DeliverableKind; slides: SlideBox[]; width: number; height: number; docHeight: number; solo?: Solo }
  | { ol: 'selection'; version: number; items: SelItem[] }
  /** something selected is being moved, resized or turned (`on`), or that is over: the editor's quick menu steps aside */
  | { ol: 'dragging'; on: boolean }
  | { ol: 'ops'; version: number; ops: HtmlOp[]; select?: 'inserted' | 'keep' | Path[]; then?: 'editText' }
  /** a new object drawn: its box (slide px), and for lines / the pen the points (slide px, in drawing order) */
  /** `scratch`: the stroke was a scribble over these strokes (core/scratchout.ts) — it is added, then they and it go, as a step of its own */
  | { ol: 'draw'; version: number; tool: Tool; slide: Path | null; rect: Rect; after?: Path | null; pts?: [number, number][]; d?: string; closed?: boolean; runs?: InkRunD[]; scratch?: Path[];
      /** draw and hold: the shape the stroke became (core/shapesnap.ts), written a step after the stroke as drawn */
      snap?: { kind: string; rect: Rect; runs: InkRunD[] } }
  /** a pen touched the slide with nothing but Select in hand: it draws (InkStyle.penInks); `done`: its stroke is over and Select is in hand again (Draw was not open) */
  | { ol: 'penInks'; done?: boolean }
  /** the eraser's "back to the pen after erasing" */
  | { ol: 'toolBack'; tool: Tool }
  /** the colours used on the slide shown (the lasso's colour filter offers them) */
  | { ol: 'slideColors'; colors: string[] }
  /** the selected handwriting to be read (inkConvert): its lines in document px, its box in the frame's client px */
  | { ol: 'inkRead'; as: 'notes' | 'formula'; lines: [number, number][][]; rect: Rect }
  /** Convert ▸ Shapes done: so many of the strokes became shapes */
  | { ol: 'inkConverted'; as: 'shapes'; count: number; of: number }
  | { ol: 'editing'; path: Path | null }
  /** A local draft whose target disappeared: the host keeps it available for recovery. */
  | { ol: 'recoveredText'; html: string; reason: string }
  /** Keystrokes still buffered in the iframe: protect navigation before they reach the host. */
  | { ol: 'textPending'; on: boolean; html?: string }
  /** a Pencil drew (the first time on this page): fingers move the slide in this browser from now on */
  | { ol: 'pencil' }
  /** the Pencil is on the screen, or has lifted: the hand resting beside the slide moves nothing meanwhile */
  | { ol: 'penDown'; down: boolean }
  /** content-free, allowlisted gesture reliability signal (never pointer coordinates or object/source data) */
  | { ol: 'reliability'; event: ReliabilityEvent; pointer: ReliabilityPointer }
  /** a stroke with a point far off (core glitch.ts StrokeWatch: measurements only), for the editor to report (glitches.ts) */
  | { ol: 'glitch'; fields: GlitchFields }
  /** a pen stroke's moves and the page's frames a second (app/penrate.ts): an iPad held to 60 Hz is told how to change it (app/promotion.ts) */
  | { ol: 'penRate'; moves: number; frames: number }
  /** words pasted on the canvas: a new text box with them (`after`: the object selected on that slide) */
  | { ol: 'pasteText'; version: number; slide: Path | null; after: Path | null; text: string }
  /** what Ctrl+C copies of the selection now (null: nothing), for the editor to answer a copy at once (runtime/clip.ts) */
  | { ol: 'clip'; html: string | null; plain: string | null }
  /** where the caret is in the text being retyped (null: none), for the others */
  | { ol: 'caret'; caret: TextCaret | null }
  /**
   * the words selected in the text being retyped, for the quick menu: their box (the frame's document,
   * CSS px) and how the first of them look; null: none (the menu goes back to the box). `choosing`:
   * the pointer is still selecting them (the menu waits until it is lifted)
   */
  | { ol: 'words'; rect: Rect | null; style?: WordsStyle; choosing?: boolean }
  | { ol: 'key'; key: string; ctrl: boolean; shift: boolean; alt: boolean; meta: boolean }
  /** `on`: what was right-clicked — an object (now selected), a slide's empty area, or the canvas around the pages; `weave`: two shapes cross there (runtime/weave.ts) */
  /** (`at`: the point of the slide right-clicked, slide px — a guide added there) */
  | { ol: 'contextmenu'; x: number; y: number; slide?: number; on?: 'object' | 'slide' | 'canvas'; weave?: { label: string; undo: boolean }; at?: { x: number; y: number } }
  | { ol: 'visible'; slide: number }
  | { ol: 'goto'; slide: number }
  | { ol: 'exit' }
  | { ol: 'reload' }
  /** patches came for a version the frame does not show: all of the text, please */
  | { ol: 'needSource' }
  | { ol: 'pasteFiles'; files: { name: string; type: string; data: ArrayBuffer }[]; slide: Path | null; at: { x: number; y: number } | null }
  | { ol: 'scroll'; y: number }
  /** a pinch or Ctrl+wheel in the frame: zoom by `factor` about a point (frame client px; its document y) */
  | { ol: 'zoom'; factor: number; clientX: number; clientY: number; pageY: number }
  /** panning asked for in the frame (frame px; the editor pans what overflows its canvas): a wheel or trackpad scroll, a finger */
  /** `screen`: the deltas are the pointer's on the screen (screenX/Y: the frame's own px change as it is zoomed and moved) */
  | { ol: 'pan'; dx: number; dy?: number; finger?: boolean; screen?: boolean }
  /**
   * two fingers on one slide (solo): where they are, in the frame's px (`x`, `y`) and on the screen
   * (`sx`, `sy`); the editor zooms and moves the slide so that what was under them at the start stays
   * under them. `cancel`: a third finger came — back to where it was.
   */
  | { ol: 'pinch'; phase: 'start' | 'move' | 'end' | 'cancel'; pts: { x: number; y: number; sx: number; sy: number }[] }
  /** three fingers: a tap or a swipe left undoes, a swipe right redoes */
  | { ol: 'history'; redo: boolean }
  /** the finger that panned was lifted or interrupted; cancellation settles without a release flick */
  | { ol: 'panEnd'; cancel?: boolean }
  /** drawing (the pen, the eraser, the lasso in hand), a finger tapped the slide: it neither drew nor moved it (the editor's bars come back, or go) */
  | { ol: 'fingerTap' }
  /** the page's own colours: what is around its slides (the body's background) and the slides' usual one */
  | { ol: 'colors'; desk: string; page: string }
  /** crop mode started (the picture's path) or ended (null) */
  | { ol: 'cropping'; path: Path | null }
  /** a double click on a picture that is an SVG file: the editor opens it in the drawing editor (`src` as written) */
  | { ol: 'editSvg'; src: string }
  /** presenting: the slide is zoomed in (or not any more) */
  | { ol: 'presentZoom'; zoomed: boolean }
  /** presenting: the bar's "Fingers draw" switched */
  | { ol: 'presentFingers'; on: boolean }
  /** presenting: the bar's "Linked" switched */
  | { ol: 'presentLinked'; on: boolean }
  /** presenting: this presenter's state for the other screens (app/presentshare.ts; null: it ended) — the editor checks it and shares it */
  | { ol: 'presentShare'; state: PresentState | null }
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
  | { ol: 'nodeEditing'; path: Path | null; selected: number; total: number }
  /** the Animation pane's rows: the sequence of the slide worked on (-1: none), its number of steps, click-in-order mode */
  | { ol: 'sequence'; slide: number; rows: StepRow[]; steps: number; ordering: StepKind | null }
  /** the Objects pane's tree of the slide worked on (while the pane is open) */
  | { ol: 'objects'; slide: number; items: ObjNode[] }
  /** a comment pin pressed (`open`: show its threads), or what a new comment is on (the object or slide, the words selected in the text being retyped) */
  | { ol: 'comment'; path: Path | null; quote?: string; slide: number; open: boolean }
  /** the answer to `looks`: each path's look (null: no such element) */
  | { ol: 'looks'; id: number; looks: (TextLook | null)[] }
  /** an empty picture placeholder tapped (decklayouts.ts): the editor asks for a picture to put in its place */
  | { ol: 'placeholderPicture'; path: Path };

/** the room (screen px) left of the rail's thumbnails for their numbers: the editor makes the rail's frame that much wider, the rail's page lays its slides out right of it */
export const RAIL_NUM = 20;

export const isFromRuntime = (d: unknown): d is FromRuntime => !!d && typeof d === 'object' && typeof (d as { ol?: unknown }).ol === 'string';
