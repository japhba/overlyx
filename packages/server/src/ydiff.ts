/**
 * Loading a LyX document into a live Y.Doc as a *diff* rather than a replacement: the CRDT is
 * brought from what it reads as to the document by the smallest change (core collab/write.ts:
 * paragraphs that did not change are matched, the rest diffed word by word, a split paragraph is a
 * marker inserted), so whatever others typed meanwhile — other users, or a client that was offline
 * and syncs later — survives an external save from desktop LyX, a version restore or an agent's edit.
 * (Deleting and re-inserting everything would silently drop such edits: they would land inside
 * deleted content.)
 */
import * as Y from 'yjs';
import { lyxToPmNode, type LyxDocument } from '@overlyx/core';
import { writePm } from './collabdoc.ts';

export interface DocMetaMap { preamble: string[]; format: number; headerLines: string[]; trailer: string[] }

/** Apply `doc` to the document and the meta map inside one transaction with the given origin. */
export function applyLyxDocument(ydoc: Y.Doc, doc: LyxDocument, origin: string): void {
  ydoc.transact(() => {
    writePm(ydoc, lyxToPmNode(doc));
    const m = ydoc.getMap<string>('meta');
    const set = (k: string, v: unknown) => { const s = JSON.stringify(v); if (m.get(k) !== s) m.set(k, s); };
    set('preamble', doc.preamble);
    set('format', doc.format);
    set('header', doc.header.lines);
    set('trailer', doc.trailer);
  }, origin);
}
