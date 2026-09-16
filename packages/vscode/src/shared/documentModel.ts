import { lyxToPm, mergeLyx, pmToLyxBody, schema, type LyxDocument, type PMJSON } from '@overlyx/core';

/** A snapshot is also the base against which the next editor change is interpreted. */
export interface DocumentModel { pmDoc: PMJSON; headerLines: string[] }

export function documentModel(pmDoc: unknown, headerLines: string[]): DocumentModel {
  return { pmDoc: schema.nodeFromJSON(pmDoc).toJSON(), headerLines: [...headerLines] };
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

/** Keep independent pending edits when a newer host snapshot arrives. */
export function mergeModels(base: DocumentModel, local: DocumentModel, incoming: DocumentModel): DocumentModel {
  if (sameModel(local, base) || sameModel(local, incoming)) return incoming;
  if (sameModel(incoming, base)) return local;
  const context: LyxDocument = { preamble: [], format: 643, header: { lines: [] }, body: [], trailer: [] };
  const merged = mergeLyx(modelDocument(base, context), modelDocument(local, context), modelDocument(incoming, context));
  return documentModel(lyxToPm(merged), merged.header.lines);
}
