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

/** Keep independent pending edits when a newer host snapshot arrives. */
export function mergeModels(base: DocumentModel, local: DocumentModel, incoming: DocumentModel): DocumentModel {
  if (sameModel(local, base) || sameModel(local, incoming)) return incoming;
  if (sameModel(incoming, base)) return local;
  const context: LyxDocument = { preamble: [], format: 643, header: { lines: [] }, body: [], trailer: [] };
  const merged = mergeLyx(modelDocument(base, context), modelDocument(local, context), modelDocument(incoming, context));
  return documentModel(lyxToPm(merged), merged.header.lines);
}
