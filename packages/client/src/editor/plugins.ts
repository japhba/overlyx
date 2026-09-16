/** Shared editing features; transport and undo ownership stay with each host. */
import { gapCursor } from 'prosemirror-gapcursor';
import { dropCursor } from 'prosemirror-dropcursor';
import { tableEditing } from 'prosemirror-tables';
import { lyxKeymap, chordPlugin } from './keymap';
import { numberingPlugin } from './plugins/numbering';
import { marginPlugin } from './plugins/margin';
import { inkPlugin } from './plugins/ink';
import { changeTrackingPlugin, changesFilterPlugin } from './plugins/changes';
import { fontCarryPlugin } from './plugins/fontcarry';
import { insetCaretPlugin } from './plugins/insetcaret';
import { dragSelectPlugin } from './plugins/dragselect';
import { findPlugin } from './plugins/find';
import { mirrorCaretPlugin } from './plugins/mirrorcaret';
import { aiCompletePlugin } from './ai/complete';
import { autocorrectPlugin } from './spell/autocorrect';
import { markdownRulesPlugin } from './plugins/mdrules';
import type { Plugin } from 'prosemirror-state';
import type { Awareness } from 'y-protocols/awareness';
import { aiRewritePlugin } from './ai/rewrite';
import { spellPlugin } from './spell/plugin';

export function editorPlugins({ awareness, marginMode, child, history }: { awareness: Awareness; marginMode: boolean; child: boolean; history: Plugin[] }): Plugin[] {
  return [
    // AI preview / ghost text come first: their Tab / Escape must win over the LyX bindings and table navigation
    aiRewritePlugin(),
    aiCompletePlugin(),
    spellPlugin(),
    markdownRulesPlugin(),   // `- ` / `1. ` / `# ` at a paragraph start, before autocorrect looks at the space
    autocorrectPlugin(),
    chordPlugin(),
    lyxKeymap(),
    ...history,
    fontCarryPlugin(),
    insetCaretPlugin(),
    dragSelectPlugin(),
    gapCursor(),
    dropCursor({ color: '#3b6ea5' }),
    tableEditing(),
    numberingPlugin(),
    marginPlugin(marginMode),
    // margin ink: one layer per document view (child editors of a combined view share the master's margins)
    ...(child ? [] : [inkPlugin(awareness)]),
    changeTrackingPlugin(),
    changesFilterPlugin(),
    findPlugin(),
    mirrorCaretPlugin(),
  ];
}
