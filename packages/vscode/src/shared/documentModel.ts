import { lyxToPm, mergeLyx, mergeApart, pmToLyxBody, schema, trackDiff, addAuthor, writeParagraphs, type LyxDocument, type PMJSON } from '@overlyx/core';

/** A snapshot is also the base against which the next editor change is interpreted. */
export interface DocumentModel { pmDoc: PMJSON; headerLines: string[] }

/**
 * What the file can hold of an editor document. A formula's `editClock` (the web editor's count of
 * edits to it, for telling concurrent formula edits apart) is not written: kept in the model, every
 * update with a just-edited formula differed from the file's parse — the host took it for a merge
 * and sent the file's version back, which, arriving while the formula was being typed, replaced it
 * and reported a "concurrent formula edit".
 */
export function documentModel(pmDoc: unknown, headerLines: string[]): DocumentModel {
  return { pmDoc: withoutEditClocks(schema.nodeFromJSON(pmDoc).toJSON()), headerLines: [...headerLines] };
}

function withoutEditClocks(node: PMJSON): PMJSON {
  if (node.attrs && 'editClock' in node.attrs) { const { editClock: _clock, ...rest } = node.attrs; node.attrs = rest; }
  node.content?.forEach(withoutEditClocks);
  return node;
}

export function sameModel(a: DocumentModel, b: DocumentModel): boolean { return JSON.stringify(a) === JSON.stringify(b); }

export function modelDocument(model: DocumentModel, context: LyxDocument): LyxDocument {
  return { ...context, body: pmToLyxBody(model.pmDoc), header: { lines: model.headerLines } };
}

/** Names one editor update: a per-editor-session token and a sequence number within it. */
export interface SyncTag { epoch: string; seq: number }

/**
 * The editor's side of the update protocol. Every update it sends is numbered; every snapshot the
 * host pushes back says which update it had applied (`ack`). A snapshot is merged against the model
 * of *that* update — not against whatever was sent since. Without this, a snapshot the host computed
 * before a later update reached it (its re-read after a save, a refresh on focus) was taken for the
 * newer state: with local == "base" the snapshot replaced the document and undid the later update in
 * the editor, although the file kept it — text deleted a moment ago came back.
 */
export class SyncLedger {
  readonly epoch = Math.random().toString(36).slice(2, 10);
  private seq = 0;
  /** updates sent and not yet reflected by a snapshot, oldest first */
  private pending: { seq: number; model: DocumentModel }[] = [];
  /** what both sides last agreed on: the newest acknowledged update, or the last snapshot applied while nothing was pending */
  private agreed: DocumentModel;
  constructor(initial: DocumentModel) { this.agreed = initial; }

  /** the base of the next update: the last model sent, or the agreed one */
  get base(): DocumentModel { return this.pending.length ? this.pending[this.pending.length - 1].model : this.agreed; }
  get inFlight(): number { return this.pending.length; }

  /** number an update about to be sent */
  send(model: DocumentModel): SyncTag { this.pending.push({ seq: ++this.seq, model }); return { epoch: this.epoch, seq: this.seq }; }

  /** the base to merge a snapshot against, given the update it acknowledges; acknowledged updates are retired */
  baseFor(ack: SyncTag | null | undefined): DocumentModel {
    if (ack && ack.epoch === this.epoch) while (this.pending.length && this.pending[0].seq <= ack.seq) this.agreed = this.pending.shift()!.model;
    return this.agreed;
  }

  /** the snapshot has been merged into the editor: with nothing in flight it is the agreed model */
  applied(incoming: DocumentModel): void { if (!this.pending.length) this.agreed = incoming; }
}

/** Whether a paragraph `ours` changed or added (not in `base`) is missing from the merge: the file's side won it. */
export function droppedOurs(base: LyxDocument, ours: LyxDocument, merged: LyxDocument): boolean {
  const key = (p: LyxDocument['body'][number]) => writeParagraphs([p]);
  const inBase = new Set(base.body.map(key)), inMerged = new Set(merged.body.map(key));
  return ours.body.some(p => { const k = key(p); return !inBase.has(k) && !inMerged.has(k); });
}

/** who edits in this editor: the author of its tracked changes */
export interface ChangeAuthor { id: number; name: string }

/**
 * `ours` (the editor's, not yet in the file) merged with `theirs` (the file, changed meanwhile by
 * the synced clone, an agent, git): each side's changes kept where they touch different paragraphs
 * (mergeApart). Where both changed the same paragraph the file's version is the text, and — with
 * `author` — ours is laid over it as that author's tracked change (as the server does for a synced
 * clone's, docedit.ts applySyncedSource): accept it and the paragraph is ours, reject it and it is the
 * file's; nothing is lost. Without an author ours is `dropped` (the caller keeps a draft and says so).
 */
export function mergeWithFile(base: LyxDocument, ours: LyxDocument, theirs: LyxDocument, author?: ChangeAuthor | null): { merged: LyxDocument; dropped: boolean; tracked: boolean } {
  const merged = mergeLyx(base, ours, theirs, mergeApart);
  if (!droppedOurs(base, ours, merged)) return { merged, dropped: false, tracked: false };
  if (!author) return { merged, dropped: true, tracked: false };
  // the same merge with ours winning the paragraphs both changed; the difference is ours, tracked
  const oursWins = mergeLyx(base, ours, theirs, (b, o, t) => mergeApart(b, t, o));
  oursWins.header = { ...oursWins.header, lines: [...oursWins.header.lines] };
  addAuthor(oursWins.header, author.id, author.name, '');
  oursWins.body = trackDiff(merged.body, oursWins.body, { author: author.id, time: Math.floor(Date.now() / 1000) });
  return { merged: oursWins, dropped: false, tracked: true };
}

/** Keep independent pending edits when a newer host snapshot arrives (a paragraph both changed: see mergeWithFile). */
export function mergeModels(base: DocumentModel, local: DocumentModel, incoming: DocumentModel, author?: ChangeAuthor | null): DocumentModel {
  if (sameModel(local, base) || sameModel(local, incoming)) return incoming;
  if (sameModel(incoming, base)) return local;
  const context: LyxDocument = { preamble: [], format: 643, header: { lines: [] }, body: [], trailer: [] };
  const { merged } = mergeWithFile(modelDocument(base, context), modelDocument(local, context), modelDocument(incoming, context), author);
  return documentModel(lyxToPm(merged), merged.header.lines);
}
