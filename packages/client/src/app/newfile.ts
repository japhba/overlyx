/**
 * One way to make a new file in a project, whatever it becomes — the files panel's + File and its
 * right-click New File…, File ▸ New…, a project's first document. There is no separate "document"
 * and "file": the name's ending decides. `.tex` (or no ending) is a LaTeX document from the
 * template, `.md` a Markdown document, `.board` a whiteboard, `.html` slides, a poster or a web page
 * (an HTML deliverable from core's starting point, edited on the canvas — the name says which) or an
 * article (`article.html`, `post.html`: a web page written as a document, core html/article.ts), and
 * `.bib`, `.sty`, `.txt` … an empty text file. Images, PDFs and other binary files are uploaded instead.
 */
import { api } from '../api';
import { noteArticle } from '../articlekinds';
import { uiPrompt } from './Dialogs';
import { starterFor } from '@overlyx/core/html/deliverable.ts';
import type { DeliverableKind } from '@overlyx/core/html/deliverable.ts';

export const NEW_FILE_HINT = 'The ending decides what it is: .tex a LaTeX document, .md a Markdown document, .html slides (poster.html a poster, page.html or site/index.html a web page, article.html or post.html an article — a web page you write like a document; a folder’s index.html goes by the folder’s name), .board a whiteboard, .bib, .sty, .txt … a text file.';

export type NewFileKind = 'doc' | 'board' | 'deliverable' | 'text';

/**
 * which deliverable a new .html file is, by its name: a poster, a web page, else slides. A folder's
 * index.html — how every deliverable is kept — goes by the folder's name (SAB/index.html slides,
 * site/index.html a web page); the project's own index.html is its website.
 */
export function deliverableKindForName(rel: string): DeliverableKind {
  const parts = rel.replace(/\.html?$/i, '').split('/');
  let base = parts.pop() ?? '';
  if (/^(index|home)$/i.test(base)) {
    if (!parts.length) return 'page';
    base = parts.pop()!;
  }
  if (/poster/i.test(base)) return 'poster';
  if (/(^|[^a-z])(page|site|web|website|homepage)([^a-z]|$)/i.test(base)) return 'page';
  return 'deck';
}

const BINARY_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'pdf', 'eps', 'ps', 'tif', 'tiff', 'webp', 'bmp', 'zip', 'gz', 'tgz', 'docx', 'pptx', 'xlsx', 'odt']);

const extOf = (rel: string) => { const base = rel.split('/').pop() ?? rel; const dot = base.lastIndexOf('.'); return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''; };

/** a new .html file named as an article (`article.html`, `post.html`, `blog/essay.html`): written in the document editor */
export function isArticleName(rel: string): boolean {
  return /\.html?$/i.test(rel) && /(^|[^a-z])(article|post|blog|essay|story)([^a-z]|$)/i.test(rel.replace(/\.html?$/i, ''));
}

/** what a new file of this name becomes; null: a binary file (it has to be uploaded) */
export function newFileKind(rel: string): NewFileKind | null {
  const ext = extOf(rel);
  if (!ext || ext === 'tex' || ext === 'lyx' || ext === 'md' || ext === 'markdown') return 'doc';
  if (ext === 'board') return 'board';
  if (ext === 'html' || ext === 'htm') return isArticleName(rel) ? 'doc' : 'deliverable';
  if (BINARY_EXT.has(ext)) return null;
  return 'text';
}

/**
 * Create `rel` (a path inside `project`) as what its ending says; resolves to the id to open — the
 * document or whiteboard (`project/path`; a document without an ending gets `.tex`), a text file
 * `text:project/path`. Never replaces a file: an existing name rejects with the server's message.
 */
export async function createProjectFile(project: string, rel: string): Promise<string> {
  const kind = newFileKind(rel);
  if (kind === null) throw new Error(`.${extOf(rel)} files cannot be made empty here: upload one instead (⇧, or drag it onto the file list)`);
  if (kind === 'doc') {
    const stem = (rel.split('/').pop() ?? rel).replace(/\.(tex|lyx|md|markdown|html?)$/i, '');
    const id = (await api.newDoc(project, rel, { title: stem })).id;
    if (/\.html?$/i.test(rel)) noteArticle(id, true);
    return id;
  }
  if (kind === 'deliverable') {
    // not an empty page (the canvas would have nothing to edit): the starting point of its kind,
    // titled by its name (a folder's index.html by the folder's)
    const parts = rel.replace(/\.html?$/i, '').split('/');
    const stem = parts.length > 1 && /^index$/i.test(parts[parts.length - 1]) ? parts[parts.length - 2] : parts[parts.length - 1];
    const title = stem.replace(/[-_]+/g, ' ').replace(/^\w/, c => c.toUpperCase());
    const r = await api.upload(project, rel, new Blob([starterFor(deliverableKindForName(rel), title)], { type: 'text/html' }), { overwrite: false });
    return project + '/' + r.path;
  }
  const empty = kind === 'board' ? '{"overlyx":"board","v":1,"objects":{\n}}\n' : '';
  const r = await api.upload(project, rel, new Blob([empty], { type: 'application/octet-stream' }), { overwrite: false });
  return (kind === 'board' ? '' : 'text:') + project + '/' + r.path;
}

/**
 * Ask for a name (in `dir`, a folder of the project, '' for its top) and create it; a taken name
 * asks again with the server's error shown. Resolves to the id to open, or null when cancelled.
 */
export async function promptNewFile(project: string, opts: { dir?: string; where?: string; initial?: string; title?: string } = {}): Promise<string | null> {
  const dir = opts.dir ?? '';
  const where = opts.where ?? project + (dir ? '/' + dir : '');
  let name = opts.initial ?? 'untitled.tex', error: string | undefined;
  for (;;) {
    const n = await uiPrompt(opts.title ?? 'New File', `New file in ${where}.\n${NEW_FILE_HINT}${error ? `\n\n${error} — try another name.` : ''}`, name);
    if (!n) return null;
    try { return await createProjectFile(project, (dir ? dir + '/' : '') + n.replace(/^\/+/, '')); }
    catch (e) { name = n; error = (e as Error).message; }
  }
}
