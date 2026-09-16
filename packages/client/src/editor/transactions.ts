/** Shared transaction handling for browser and embedded document views. */
import type { Transaction } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { ySyncPluginKey } from 'y-prosemirror';

export function editorTransactions(readOnly: () => boolean): (this: EditorView, tr: Transaction) => void {
  let flushing = false;
  return function (tr) {
    // y-prosemirror queues awareness updates with setTimeout; they can arrive after teardown.
    if (this.isDestroyed) return;
    // Preserve clicks whose DOM selection has not reached ProseMirror before an awareness update.
    if (readOnly() && tr.docChanged && !tr.getMeta(ySyncPluginKey)) return;   // viewers cannot edit (the server drops their updates anyway)
    if (!flushing && !tr.docChanged && tr.selectionSet === false && tr.selection.eq(this.state.selection)) {
      flushing = true;
      const before = this.state;
      try { (this as any).domObserver.flush(); } catch { /* ignore */ } finally { flushing = false; }
      if (this.state !== before) {
        const fresh = this.state.tr;
        for (const [k, v] of Object.entries((tr as any).meta as Record<string, unknown>)) fresh.setMeta(k, v);
        tr = fresh;
      }
    }
    this.updateState(this.state.apply(tr));
  };
}
