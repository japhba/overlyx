/**
 * A project reopens on the file this person was in last — a document, slides, a PDF, a .bib — on
 * any device. The server notes when each file was opened (a document's connection; `noteShown` for
 * the text editor and the PDF viewer, which keep none) and names the newest in the project list;
 * this browser remembers what it showed since that list came. The newer of the two wins, as long
 * as the file is still there. Which slide of a deck: deliverable/slidememory.ts.
 */
import { api, fileTabId, type Project } from '../api';
import { splitDocId } from '@overlyx/core';

const KEY = 'ol.lastFile:';

/** A file shown in the workspace (its tab id, without "raw:"): the project opens on it next time. */
export function noteShown(id: string): void {
  const view = /^(text|pdf):/.exec(id)?.[1] as 'text' | 'pdf' | undefined;
  const plain = view ? id.slice(view.length + 1) : id;
  const { project, path } = splitDocId(plain);
  if (!project || !path) return;   // the project itself (no documents yet)
  try { localStorage.setItem(KEY + project, JSON.stringify({ id, at: Date.now() })); } catch { /* private window */ }
  if (view) api.markOpened(plain, view).catch(() => { /* offline: this browser still knows */ });
}

/** The file to open `p` on: the one this person was in last, here or elsewhere, if it is still in the project; null: none (its main document then). */
export function lastFileOf(p: Project): string | null {
  let local: { id: string; at: number } | null = null;
  try { const v = JSON.parse(localStorage.getItem(KEY + p.name) ?? 'null'); if (v && typeof v.id === 'string') local = { id: v.id, at: Number(v.at) || 0 }; } catch { /* storage unavailable or damaged */ }
  const there = (id: string | null | undefined): id is string => !!id && p.files.some(f => fileTabId(p.name, f) === id);
  const server = there(p.lastFile) ? p.lastFile : null;
  if (there(local?.id) && (!server || local!.at >= (p.lastOpened ?? 0))) return local!.id;
  return server;
}
