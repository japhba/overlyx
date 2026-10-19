/**
 * A document's CRDT on the server, model 2 (core collab/model.ts): read as the document model,
 * written as the smallest change; and the conversion of states stored in model 1.
 *
 * Model 1 was y-prosemirror's tree (an XmlFragment `prosemirror`, a Y.XmlElement per paragraph).
 * A state stored in it is converted when its document is opened: the tree is read as y-prosemirror
 * read it (exactly what the editors showed), written as flows into a fresh history (a new epoch: an
 * editor's local copy of the old history cannot merge into the new one), and the old state is kept
 * (`ydocs_model1`) for a while, so that an old local copy's offline edits can still be merged
 * (legacyMerge in docs.ts): they are applied to the old state there, and what they changed is merged
 * into the document three-way, as a change of the file is. (Pure computation: the document workers
 * use it too; the old states are kept by docs.ts.)
 */
import * as Y from 'yjs';
import { yDocToProsemirrorJSON } from 'y-prosemirror';
import type { Node as PMNode } from 'prosemirror-model';
import { schema, pmToLyxBody, type LyxDocument } from '@overlyx/core';
import { Reader, writeDocument, markModel2, isModel2, hasModel1Content, BODY, PAGES, MODEL_KEY } from '@overlyx/core/collab/index.ts';

/** The document the CRDT reads as. */
export function readPm(ydoc: Y.Doc): PMNode {
  if (!isModel2(ydoc) && hasModel1Content(ydoc)) return schema.nodeFromJSON(yDocToProsemirrorJSON(ydoc, 'prosemirror'));
  return new Reader(schema, ydoc).read();
}

/** Bring the CRDT to `next` (inside the caller's transaction), as the smallest change. */
export function writePm(ydoc: Y.Doc, next: PMNode): void {
  writeDocument(schema, ydoc, next);
  markModel2(ydoc);
}

/** The CRDT holds nothing yet (no paragraph, no page). */
export function isEmptyDoc(ydoc: Y.Doc): boolean {
  return ydoc.getText(BODY).length === 0 && ydoc.getMap(PAGES).size === 0;
}

/** the settings (preamble, header, …) of a state: the `meta` map's entries */
function metaEntries(ydoc: Y.Doc): [string, unknown][] {
  return [...ydoc.getMap('meta').entries()].filter(([k]) => k !== MODEL_KEY);
}

/** The document model of a model-1 state (what its editors showed). */
export function model1Document(state: Uint8Array): { pm: PMNode; meta: Map<string, unknown> } {
  const old = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(old, state);
    return { pm: schema.nodeFromJSON(yDocToProsemirrorJSON(old, 'prosemirror')), meta: new Map(metaEntries(old)) };
  } finally { old.destroy(); }
}

/** the body of a model-1 state as LyX paragraphs (for three-way merges) */
export function model1Body(pm: PMNode): LyxDocument['body'] { return pmToLyxBody(pm); }

/**
 * A stored state in model 1, converted: the state of a fresh model-2 history that reads as the same
 * document with the same settings. Null when the state is not model 1.
 */
export function convertModel1(state: Uint8Array): Uint8Array | null {
  const probe = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(probe, state);
    if (isModel2(probe) || !hasModel1Content(probe)) return null;
    const pm = schema.nodeFromJSON(yDocToProsemirrorJSON(probe, 'prosemirror'));
    const next = new Y.Doc();
    next.transact(() => {
      const meta = next.getMap('meta');
      for (const [k, v] of metaEntries(probe)) meta.set(k, v);
      writePm(next, pm);
    }, 'convert');
    const out = Y.encodeStateAsUpdate(next);
    next.destroy();
    return out;
  } finally { probe.destroy(); }
}
