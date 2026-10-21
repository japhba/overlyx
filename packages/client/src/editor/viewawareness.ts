/**
 * The collaboration awareness of a document's editor view, for what reaches the other clients of the
 * document without being part of it (layout/present.ts: presenting on several screens at once). Set
 * where the view is made with its provider (editor.ts); absent where there are no others.
 */
import type { EditorView } from 'prosemirror-view';
import type { Awareness } from 'y-protocols/awareness';

const byView = new WeakMap<EditorView, Awareness>();

export function setViewAwareness(view: EditorView, awareness: Awareness): void { byView.set(view, awareness); }
export function viewAwareness(view: EditorView): Awareness | null { return byView.get(view) ?? null; }
