/**
 * One way to make a new file in a project, whatever it becomes — the files panel's + File and its
 * right-click New File…, File ▸ New…, a project's first document. There is no separate "document"
 * and "file": the name's ending decides. `.tex` (or no ending) is a LaTeX document from the
 * template, `.md` a Markdown document, `.board` a whiteboard, and `.bib`, `.sty`, `.txt` … an empty
 * text file. Images, PDFs and other binary files are uploaded instead.
 */
import { api } from '../api';
import { uiPrompt } from './Dialogs';

export const NEW_FILE_HINT = 'The ending decides what it is: .tex a LaTeX document, .md a Markdown document, .board a whiteboard, .bib, .sty, .txt … a text file.';

export type NewFileKind = 'doc' | 'board' | 'text';

const BINARY_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'pdf', 'eps', 'ps', 'tif', 'tiff', 'webp', 'bmp', 'zip', 'gz', 'tgz', 'docx', 'pptx', 'xlsx', 'odt']);

const extOf = (rel: string) => { const base = rel.split('/').pop() ?? rel; const dot = base.lastIndexOf('.'); return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''; };

/** what a new file of this name becomes; null: a binary file (it has to be uploaded) */
export function newFileKind(rel: string): NewFileKind | null {
  const ext = extOf(rel);
  if (!ext || ext === 'tex' || ext === 'lyx' || ext === 'md' || ext === 'markdown') return 'doc';
  if (ext === 'board') return 'board';
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
    const stem = (rel.split('/').pop() ?? rel).replace(/\.(tex|lyx|md|markdown)$/i, '');
    return (await api.newDoc(project, rel, { title: stem })).id;
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
