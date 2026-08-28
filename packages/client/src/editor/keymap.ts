/**
 * LyX (cua.bind + menus.bind + math.bind) keyboard bindings, including the Alt+P / Alt+A /
 * Alt+M / Alt+S prefix chords.
 */
import { keymap } from 'prosemirror-keymap';
import { Plugin, PluginKey, TextSelection, type Command, type EditorState } from 'prosemirror-state';
import { undoInputRule } from 'prosemirror-inputrules';
import { baseKeymap, chainCommands, deleteSelection, joinBackward, selectNodeBackward, joinForward, selectNodeForward, selectAll } from 'prosemirror-commands';
import { undo, redo } from 'y-prosemirror';
import type { EditorView } from 'prosemirror-view';
import {
  paragraphBreak, paragraphBreakInverse, fontCommands, fontDefault, changeDepth, insertMath, toggleMathDisplay,
  insertNewline, insertSpace, insertSpecial, insertERT, insertFootnote, insertNote, insertComment, selectInset, toggleInset,
  moveParagraph, deleteToParagraphEnd, setLayout, setParagraphAttrs, arrowIntoMath, setValueMark, insertHyphens, insertQuote, smartQuote, insertMarginal,
} from './commands';
import { editorContext } from './context';
import { activeMathField } from './lyxmath/field';
import { trackedDelete } from './plugins/changes';

export interface UiActions {
  save(): void;
  viewPdf(): void;
  updatePdf(): void;
  find(): void;
  openDialog(name: string, arg?: unknown): void;
  toggleTrackChanges(): void;
  toggleOutline(): void;
  zoom(delta: number): void;
  openFile(): void;
  newFile(): void;
  toggleCombined?(): void;
  acceptAll?(): void;
  rejectAll?(): void;
  closeTab?(): void;
  toggleSource?(): void;
  /** change the text column width by a step (0 resets) */
  textWidth?(delta: number): void;
}

const ui = (fn: (a: UiActions) => void): Command => () => { const a = editorContext.ui; if (a) fn(a); return true; };

/** LyX word-delete-backward/forward: within a paragraph's text; at an inset or paragraph edge the character command takes over. */
const deleteWord = (dir: -1 | 1, fallback: Command): Command => (state, dispatch, view) => {
  const { $from, empty } = state.selection;
  if (!empty || !$from.parent.isTextblock) return fallback(state, dispatch, view);
  const off = $from.parentOffset;
  const par = $from.parent;
  if (dir < 0) {
    const before = par.textBetween(0, off, '\u0000', '\u0000');
    const m = /(\s*\S+|\s+)$/.exec(before);
    if (!m || m[0].includes('\u0000')) return fallback(state, dispatch, view);
    if (dispatch) dispatch(state.tr.delete($from.pos - m[0].length, $from.pos).scrollIntoView());
    return true;
  }
  const after = par.textBetween(off, par.content.size, '\u0000', '\u0000');
  const m = /^(\S+\s*|\s+)/.exec(after);
  if (!m || m[0].includes('\u0000')) return fallback(state, dispatch, view);
  if (dispatch) dispatch(state.tr.delete($from.pos, $from.pos + m[0].length).scrollIntoView());
  return true;
};

declare module './context' { interface EditorContext { ui?: UiActions } }

const LAYOUT_PREFIX: Record<string, string> = {
  '0': 'Part', '1': 'Chapter', '2': 'Section', '3': 'Subsection', '4': 'Subsubsection', '5': 'Paragraph', '6': 'Subparagraph',
  a: 'Abstract', A: 'Author', B: 'Bibliography', c: 'LyX-Code', C: 'Comment', d: 'Description', D: 'Date', e: 'Enumerate',
  i: 'Itemize', l: 'Labeling', n: 'Enumerate', q: 'Quote', Q: 'Quotation', s: 'Standard', t: 'Title', v: 'Verse', L: 'LaTeX',
};

const SIZE_PREFIX: Record<string, string> = { t: 'tiny', S: 'footnotesize', s: 'small', n: 'normal', l: 'large', L: 'larger', h: 'huge', H: 'giant', '1': 'tiny', '2': 'scriptsize', '3': 'footnotesize', '4': 'small', '5': 'normal', '6': 'large', '7': 'larger', '8': 'largest', '9': 'huge', '0': 'giant' };

export const chordKey = new PluginKey<string | null>('lyx-chord');

/** Prefix-chord plugin: Alt+P (layouts), Alt+A (paragraph), Alt+M (math), Alt+S (size). */
export function chordPlugin(): Plugin<string | null> {
  return new Plugin<string | null>({
    key: chordKey,
    state: {
      init: () => null,
      apply: (tr, prev) => (tr.getMeta(chordKey) !== undefined ? tr.getMeta(chordKey) : prev),
    },
    props: {
      handleKeyDown(view, ev) {
        const prefix = chordKey.getState(view.state);
        const setPrefix = (p: string | null) => view.dispatch(view.state.tr.setMeta(chordKey, p));
        if (prefix) {
          if (ev.key === 'Shift' || ev.key === 'Control' || ev.key === 'Alt' || ev.key === 'Meta') return false;
          setPrefix(null);
          if (ev.key === 'Escape') return true;
          const k = ev.key;
          if (prefix === 'M-p') {
            if (k === '*') { setPrefix('M-p*'); return true; }
            const layout = LAYOUT_PREFIX[k];
            if (layout) { setLayout(layout)(view.state, view.dispatch); return true; }
            if (k === ' ') { editorContext.ui?.openDialog('layout'); return true; }
            if (k === 'ArrowLeft') { changeDepth(-1)(view.state, view.dispatch); return true; }
            if (k === 'ArrowRight') { changeDepth(1)(view.state, view.dispatch); return true; }
            if (k === 'ArrowUp') { moveParagraph(-1)(view.state, view.dispatch); return true; }
            if (k === 'ArrowDown') { moveParagraph(1)(view.state, view.dispatch); return true; }
            if (k === 'Enter') { paragraphBreakInverse(view.state, view.dispatch); return true; }
            return true;
          }
          if (prefix === 'M-p*') {
            const layout = LAYOUT_PREFIX[k];
            if (layout && /^[0-6]$/.test(k)) { setLayout(layout + '*')(view.state, view.dispatch); return true; }
            return true;
          }
          if (prefix === 'M-a') {
            const map: Record<string, Command> = {
              l: setParagraphAttrs({ align: 'left' }), r: setParagraphAttrs({ align: 'right' }), c: setParagraphAttrs({ align: 'center' }),
              j: setParagraphAttrs({ align: 'block' }), e: setParagraphAttrs({ align: null }),
              i: (s, d) => { const cur = s.selection.$from; for (let dd = cur.depth; dd >= 0; dd--) if (cur.node(dd).type.name === 'paragraph') return setParagraphAttrs({ noindent: !cur.node(dd).attrs.noindent })(s, d); return false; },
              s: setParagraphAttrs({ spacing: 'single' }), o: setParagraphAttrs({ spacing: 'onehalf' }), d: setParagraphAttrs({ spacing: 'double' }), f: setParagraphAttrs({ spacing: null }),
            };
            if (map[k]) { map[k](view.state, view.dispatch); return true; }
            if (/^[0-9]$/.test(k)) { editorContext.ui?.openDialog('argument', k === '0' ? 'post:1' : k); return true; }
            return true;
          }
          if (prefix === 'M-s') {
            const size = SIZE_PREFIX[k];
            if (size) { setValueMark('size', size === 'normal' ? null : size)(view.state, view.dispatch); return true; }
            return true;
          }
          if (prefix === 'M-m') {
            if (k === 'm') { insertMath(false)(view); return true; }
            if (k === 'd') { insertMath(true)(view); return true; }
            if (k === 'n') { insertMath(true, 'equation')(view); return true; }
            if (k === 't') { setPrefix('M-m t'); return true; }
            if (k === 'f') { insertMath(false)(view); setTimeout(() => activeMathField()?.execute('insert', '\\frac{#0}{}'), 30); return true; }
            return true;
          }
          if (prefix === 'M-m t') {
            const envs: Record<string, string> = { a: 'align', i: 'simple', d: 'equation', e: 'eqnarray', m: 'multline', g: 'gather', n: 'simple' };
            if (envs[k]) { insertMath(true, envs[k] === 'simple' ? undefined : envs[k])(view); return true; }
            return true;
          }
          return true;
        }
        if (ev.altKey && !ev.ctrlKey && !ev.metaKey) {
          const k = ev.key.toLowerCase();
          if (k === 'p' || k === 'a' || k === 'm' || k === 's') { setPrefix('M-' + k); ev.preventDefault(); return true; }
        }
        // Escape leaves an inset (LyX: cancel)
        return false;
      },
    },
  });
}

const backspace: Command = chainCommands(trackedDelete(-1), undoInputRule, deleteSelection, joinBackward, selectNodeBackward);
const del: Command = chainCommands(trackedDelete(1), deleteSelection, joinForward, selectNodeForward);

export function lyxKeymap(): Plugin {
  const bindings: Record<string, Command> = {
    ...baseKeymap,
    Enter: paragraphBreak,
    'Alt-Enter': paragraphBreakInverse,
    'Mod-Enter': insertNewline('newline'),
    'Shift-Mod-Enter': insertNewline('linebreak'),
    Backspace: backspace,
    'Mod-Backspace': deleteWord(-1, backspace),
    Delete: del,
    'Mod-Delete': deleteWord(1, del),
    'Mod-z': undo,
    'Mod-y': redo,
    'Shift-Mod-z': redo,
    'Mod-a': selectInset,
    'Alt-Mod-a': selectAll,
    'Mod-e': fontCommands.emph,
    'Mod-b': fontCommands.bold,
    'Alt-Mod-b': fontCommands.bold,
    'Mod-u': fontCommands.underline,
    'Shift-Mod-p': fontCommands.typewriter,
    'Shift-Mod-o': fontCommands.strikeout,
    'Shift-Mod-n': fontCommands.noun,
    'Alt-Mod-d': fontDefault,
    'Mod-m': (_s, _d, view) => (view ? insertMath(false)(view) : false),
    'Shift-Mod-m': (_s, _d, view) => (view ? insertMath(true)(view) : false),
    'Alt-Mod-n': (_s, _d, view) => (view ? insertMath(true, 'equation')(view) : false),
    'Mod-l': insertERT,
    'Alt-Mod-f': insertFootnote,
    'Alt-Mod-m': insertMarginal,
    'Alt-Mod-c': insertComment,
    'Alt-Shift-Mod-n': insertNote('Note'),
    'Mod-i': fontCommands.italic,          // the usual italic key; LyX's Ctrl+I (inset-toggle) moved to Ctrl+Alt+I
    'Alt-Mod-i': toggleInset,
    'Shift-Alt-Mod-i': ui(a => a.openDialog('inset')),
    'Mod- ': insertSpace('~'),
    'Alt-Mod- ': insertSpace('\\space{}'),
    'Shift-Mod- ': insertSpace('\\thinspace{}'),
    'Mod-.': insertSpecial('endofsentence'),
    'Alt-.': insertSpecial('ldots'),
    'Alt--': insertSpecial('softhyphen'),
    'Alt-Mod--': insertSpecial('nobreakdash'),
    'Shift-Mod-l': insertSpecial('ligaturebreak'),
    'Mod-/': insertSpecial('breakableslash'),
    'Alt-Shift-ArrowRight': changeDepth(1),
    'Alt-Shift-ArrowLeft': changeDepth(-1),
    'Alt-ArrowUp': moveParagraph(-1),
    'Alt-ArrowDown': moveParagraph(1),
    'Mod-k': deleteToParagraphEnd,
    'Mod-s': ui(a => a.save()),
    F2: ui(a => a.save()),
    'Mod-r': ui(a => a.viewPdf()),
    // LyX binds Ctrl+Shift+R to "update PDF" as well, but in a browser that is the hard-reload key:
    // hijacking it silently started a full latexmk build. Left to the browser on purpose.
    'Mod-f': ui(a => a.find()),
    F3: ui(a => a.find()),
    'Shift-Mod-e': ui(a => a.toggleTrackChanges()),
    'Alt-Mod-o': ui(a => a.toggleOutline()),
    'Alt-Mod-s': ui(a => a.toggleSource?.()),
    'Mod-=': ui(a => a.zoom(1)),
    'Mod-+': ui(a => a.zoom(1)),
    'Mod--': ui(a => a.zoom(-1)),
    'Mod-Alt-=': ui(a => a.textWidth?.(1)),
    'Mod-Alt-+': ui(a => a.textWidth?.(1)),
    'Mod-Alt--': ui(a => a.textWidth?.(-1)),
    'Mod-0': ui(a => a.zoom(0)),
    'Mod-o': ui(a => a.openFile()),
    'Mod-n': ui(a => a.newFile()),
    'Shift-Mod-c': ui(a => a.openDialog('cite')),
    'Shift-Mod-g': ui(a => a.openDialog('graphics')),
    'Alt-Mod-t': ui(a => a.openDialog('table')),
    'Alt-Mod-p': ui(a => a.openDialog('paragraph')),
    'Shift-Mod-i': ui(a => a.openDialog('ref')),
    'Alt-Mod-l': ui(a => a.openDialog('label')),
    'Alt-Mod-k': ui(a => a.openDialog('href')),
    'Mod-ArrowRight': (state, dispatch, view) => arrowIntoMath(1)(state, dispatch, view) || false,
    ArrowRight: (state, dispatch, view) => arrowIntoMath(1)(state, dispatch, view),
    ArrowLeft: (state, dispatch, view) => arrowIntoMath(-1)(state, dispatch, view),
    '"': smartQuote,
    'Alt-"': insertQuote('l', 'e', 's'),
    'Shift-Mod-"': (state, dispatch) => dispatch ? (dispatch(state.tr.insertText('"')), true) : true,
    'Alt-m': (_s, _d, view) => (view ? insertMath(false)(view) : false),
    Escape: escapeInset,
  };
  return keymap(bindings);
}

/** Escape: move the cursor out of the innermost inset (to its right). */
const escapeInset: Command = (state, dispatch) => {
  const $from = state.selection.$from;
  for (let d = $from.depth; d > 0; d--) {
    const n = $from.node(d);
    if (n.type.name === 'inset' || n.type.name === 'table') {
      const after = $from.after(d);
      dispatch?.(state.tr.setSelection(TextSelection.near(state.doc.resolve(after))));
      return true;
    }
  }
  return false;
};

export function isMac(): boolean { return /Mac|iPhone|iPad/.test(navigator.platform); }

export { toggleMathDisplay, type EditorState, type EditorView, insertHyphens };
