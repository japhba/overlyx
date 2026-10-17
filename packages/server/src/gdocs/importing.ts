/**
 * Google Docs into OverLyX (the picker's *Import from Google Docs…*): a Google Doc becomes a
 * markdown document; one with several tabs a document group (core/docgroup.ts) — a folder named
 * after it with a document per tab, in tab order, titled and nested like the tabs. Each document
 * is linked to its tab (sync.ts) with what the tab holds now as its base, so the first sync (run
 * right away) changes nothing on either side but brings the Google comments over. Imported without
 * sync, the documents are a copy of what the Google Doc holds now: no link, no comments.
 *
 * reconcileGroup keeps a group in step with the Google Doc's tabs afterwards (after each sync of
 * one of its documents): a tab made there becomes a document of the group, and the group's order,
 * titles and nesting follow the tabs. A file keeps its name when its tab is renamed (links and
 * paths to it stay); documents of the folder that are no tab's stay in the group after the tabs. A
 * tab whose document was deleted here stays out (sync.ts gdocs_dropped_tabs): deleting one used to
 * bring it back on the next sync as "Proposal 2.md", then "Proposal 3.md".
 */
import fs from 'node:fs';
import path from 'node:path';
import { GROUP_MANIFEST, parseDocGroup, writeDocGroup, splitDocId, type DocGroupMember } from '@overlyx/core';
import { parseMarkdown, writeMarkdown } from '@overlyx/core/md/index.ts';
import { resolveProjectPath } from '../projectfiles.ts';
import { touchProject } from '../git.ts';
import { manager } from '../docs.ts';
import { flatTabs, tabDocument, readGoogle, strip, toParagraphs, project, type DocsFile, type FlatTab } from './model.ts';
import { googleApiFor, insertLink, linksOfFile, syncDoc, droppedTabs, undropTab, type LinkRow } from './sync.ts';

/** a file name from a title: no path separators or characters file systems and URLs trip over, short */
export function fileStem(title: string): string {
  const s = title.normalize('NFKC').replace(/[\\/:*?"<>|#%\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 80).trim();
  return s || 'Untitled';
}

/** `stem` + `ext` free in `dirAbs` (and not in `taken`): "Notes.md", "Notes 2.md", … */
function freeName(dirAbs: string, stem: string, ext: string, taken: Set<string> = new Set()): string {
  for (let k = 1; ; k++) {
    const name = `${stem}${k > 1 ? ' ' + k : ''}${ext}`;
    if (!taken.has(name) && !fs.existsSync(path.join(dirAbs, name))) return name;
  }
}

/** a tab's content as the text of a markdown document */
function tabMarkdown(whole: DocsFile, tabId: string): string {
  const doc = parseMarkdown('').doc;
  doc.body = toParagraphs(strip(readGoogle(tabDocument(whole, tabId)!).blocks), project(doc).headings, true);
  return writeMarkdown(doc).text;
}

interface Source { fileId: string; userId: number; url: string | null; version: string | null }

/** the tab's document written at `rel` and (with a `src`) linked to the tab, its base what both sides hold now */
async function addTabDocument(projectKey: string, rel: string, whole: DocsFile, tab: FlatTab, src: Source | null): Promise<string> {
  fs.writeFileSync(resolveProjectPath(projectKey, rel), tabMarkdown(whole, tab.id), 'utf8');
  const docId = `${projectKey}/${rel}`;
  if (!src) return docId;
  const doc = await manager.open(docId);
  undropTab(src.fileId, docId, tab.id);
  insertLink({ docId, fileId: src.fileId, userId: src.userId, url: src.url, tabId: tab.id, baseText: doc.textOf(doc.toLyxDocument()), baseGoogle: strip(readGoogle(tabDocument(whole, tab.id)!).blocks), version: src.version });
  return docId;
}

/**
 * Import the Google Doc `fileId` (one the account picked) into `dir` of the project: its documents
 * (the first is the one to open) and the group's folder, if it became one. `sync: false` makes a
 * copy that is not linked to the Google Doc.
 */
export async function importGoogleDoc(projectKey: string, dir: string, fileId: string, userId: number, { sync = true }: { sync?: boolean } = {}): Promise<{ docs: string[]; group: string | null }> {
  const api = googleApiFor(userId);
  const [file, whole] = await Promise.all([api.getFile(fileId), api.getDocumentTabs(fileId)]);
  if (file.trashed) throw new Error('That Google Doc is in the trash');
  if (sync && linksOfFile(fileId).some(l => splitDocId(l.doc_id).project === projectKey)) throw new Error('That Google Doc is synced with a document of this project already');
  const tabs = flatTabs(whole);
  if (!tabs.length) throw new Error('That Google Doc has no tabs to import');
  const title = (file.name || whole.title || '').trim() || 'Google Doc';
  const dirAbs = resolveProjectPath(projectKey, dir);
  fs.mkdirSync(dirAbs, { recursive: true });
  const src: Source | null = sync ? { fileId, userId, url: file.webViewLink ?? null, version: file.version ?? null } : null;
  const docs: string[] = [];
  let group: string | null = null;
  if (tabs.length === 1) {
    docs.push(await addTabDocument(projectKey, path.posix.join(dir, freeName(dirAbs, fileStem(title), '.md')), whole, tabs[0], src));
  } else {
    const folder = freeName(dirAbs, fileStem(title), '');
    group = path.posix.join(dir, folder);
    const folderAbs = path.join(dirAbs, folder);
    fs.mkdirSync(folderAbs);
    const taken = new Set<string>();
    const members: DocGroupMember[] = [];
    for (const t of tabs) {
      const name = freeName(folderAbs, fileStem(t.title), '.md', taken);
      taken.add(name);
      members.push({ file: name, title: t.title, ...(t.level ? { level: t.level } : {}) });
      docs.push(await addTabDocument(projectKey, path.posix.join(group, name), whole, t, src));
    }
    fs.writeFileSync(path.join(folderAbs, GROUP_MANIFEST), writeDocGroup({ version: 1, title, members }), 'utf8');
  }
  touchProject(projectKey, userId);
  // the first syncs: the Google comments come over (each to the tab it quotes)
  if (sync) for (const id of docs) await syncDoc(id);
  return { docs, group };
}

/** one reconciliation per Google Doc at a time (its tabs' documents sync one after the other, each may start one) */
const reconciling = new Map<string, Promise<Reconciled>>();

/**
 * After a sync of `docId` (linked to a tab of `whole`): the group its folder is, in step with the
 * Google Doc's tabs — new tabs become documents, order, titles and nesting follow. For the report:
 * `notes` the documents made, `warnings` tabs left out (a document that is no group's cannot take new tabs).
 */
type Reconciled = { warnings: string[]; notes: string[] };
export function reconcileGroup(docId: string, link: LinkRow, whole: DocsFile): Promise<Reconciled> {
  const prev = reconciling.get(link.file_id) ?? Promise.resolve(null);
  const p = prev.catch(() => null).then(() => reconcile(docId, link, whole));
  reconciling.set(link.file_id, p);
  void p.catch(() => null).finally(() => { if (reconciling.get(link.file_id) === p) reconciling.delete(link.file_id); });
  return p;
}

async function reconcile(docId: string, link: LinkRow, whole: DocsFile): Promise<Reconciled> {
  const { project: key, path: rel } = splitDocId(docId);
  const folderRel = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
  const folderAbs = resolveProjectPath(key, folderRel);
  const manifestAbs = path.join(folderAbs, GROUP_MANIFEST);
  const tabs = flatTabs(whole);
  // the documents of this Google Doc's tabs in this folder (read again: another sync may have added some)
  const inFolder = () => new Map(linksOfFile(link.file_id).filter(l => l.tab_id && splitDocId(l.doc_id).project === key && path.posix.dirname(splitDocId(l.doc_id).path) === (folderRel || '.')).map(l => [l.tab_id!, path.posix.basename(splitDocId(l.doc_id).path)]));
  const known = new Set(linksOfFile(link.file_id).filter(l => splitDocId(l.doc_id).project === key).map(l => l.tab_id));
  // (a tab whose document was deleted or unlinked here stays out)
  const dropped = droppedTabs(link.file_id, docId);
  const fresh = tabs.filter(t => !known.has(t.id) && !dropped.has(t.id));
  const group = fs.existsSync(manifestAbs) ? parseDocGroup(fs.readFileSync(manifestAbs, 'utf8')) : null;
  // the folder's group is this Google Doc's when one of its documents syncs with a tab of it (the one
  // syncing now may have just been linked to one: it joins)
  const tabFiles = new Set(inFolder().values());
  if (!group || !group.members.some(m => m.file === path.posix.basename(rel) || tabFiles.has(m.file))) {
    return { notes: [], warnings: fresh.length ? [`The Google Doc has ${fresh.length === 1 ? 'a tab' : `${fresh.length} tabs`} not synced here (${fresh.map(t => `“${t.title}”`).join(', ')}) — import it again to get every tab as a document group`] : [] };
  }
  const notes: string[] = [];
  const taken = new Set(group.members.map(m => m.file));
  for (const t of fresh) {
    const name = freeName(folderAbs, fileStem(t.title), '.md', taken);
    taken.add(name);
    // (no version: the next automatic sync takes the new document up and brings its comments)
    await addTabDocument(key, path.posix.join(folderRel, name), whole, t, { fileId: link.file_id, userId: link.user_id, url: link.url, version: null });
    notes.push(`New tab “${t.title}” from the Google Doc: ${path.posix.join(folderRel, name)}`);
  }
  const files = inFolder();
  const ordered: DocGroupMember[] = tabs.filter(t => files.has(t.id)).map(t => ({ file: files.get(t.id)!, title: t.title, ...(t.level ? { level: t.level } : {}) }));
  // documents of the folder that are no tab's stay after the tabs' — those still there
  const next = { ...group, members: [...ordered, ...group.members.filter(m => !ordered.some(o => o.file === m.file) && fs.existsSync(path.join(folderAbs, m.file)))] };
  if (writeDocGroup(next) !== writeDocGroup(group)) fs.writeFileSync(manifestAbs, writeDocGroup(next), 'utf8');
  if (fresh.length || writeDocGroup(next) !== writeDocGroup(group)) touchProject(key, link.user_id);
  return { warnings: [], notes };
}
