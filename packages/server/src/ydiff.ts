/**
 * Loading a LyX document into a live Y.Doc as a *diff* rather than a replacement: y-prosemirror's
 * converter matches unchanged paragraphs/insets (prefix, suffix, recursive) and only rewrites what
 * differs, so paragraphs that did not change keep their Yjs identity. Concurrent edits in them —
 * from other users, or from a client that was offline and syncs later — survive an external save
 * from desktop LyX or a version restore. (Deleting and re-inserting everything would silently drop
 * such edits: they would land inside deleted content.)
 */
import * as Y from 'yjs';
import { prosemirrorJSONToYXmlFragment } from 'y-prosemirror';
import { lyxToPm, schema, type LyxDocument } from '@overlyx/core';
import { recordCopies } from '@overlyx/core/moves.ts';

export interface DocMetaMap { preamble: string[]; format: number; headerLines: string[]; trailer: string[] }

/** Apply `doc` to the fragment + meta map inside one transaction with the given origin. */
export function applyLyxDocument(ydoc: Y.Doc, doc: LyxDocument, origin: string): void {
  ydoc.transact(tr => {
    prosemirrorJSONToYXmlFragment(schema, lyxToPm(doc), ydoc.getXmlFragment('prosemirror'));
    // a paragraph the diff split or joined (an external change, an agent's edit): recorded like an
    // editor's, so that what somebody typed meanwhile into the original follows the copy (moves.ts)
    try { recordCopies(tr); } catch (e) { console.error('[moves] recording a copy failed', e); }
    const m = ydoc.getMap<string>('meta');
    const set = (k: string, v: unknown) => { const s = JSON.stringify(v); if (m.get(k) !== s) m.set(k, s); };
    set('preamble', doc.preamble);
    set('format', doc.format);
    set('header', doc.header.lines);
    set('trailer', doc.trailer);
  }, origin);
}
