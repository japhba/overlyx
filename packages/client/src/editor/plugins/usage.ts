/**
 * Usage statistics inside the editor (src/usage.ts): a modifier combination that reached the end
 * of the plugin chain unhandled ("key-unbound" — the person expected something to happen and
 * nothing did), and undo / redo from the Yjs undo manager however they were triggered, so that an
 * action undone right away can be counted. Last in assembly.ts's plugin order on purpose.
 */
import { Plugin } from 'prosemirror-state';
import { yUndoPluginKey } from 'y-prosemirror';
import type { UndoManager } from 'yjs';
import { recordUsage, unboundKeyLabel } from '../../usage';

export function usagePlugin(): Plugin {
  return new Plugin({
    props: {
      handleKeyDown(_view, ev) {
        const label = unboundKeyLabel(ev);
        if (label) recordUsage('key-unbound', label);
        return false;
      },
    },
    view(view) {
      const um = (yUndoPluginKey.getState(view.state) as { undoManager?: UndoManager } | undefined)?.undoManager;
      const popped = (e: { type: 'undo' | 'redo' }) => recordUsage(e.type === 'redo' ? 'redo' : 'undo');
      um?.on('stack-item-popped', popped);
      return { destroy() { um?.off('stack-item-popped', popped); } };
    },
  });
}
