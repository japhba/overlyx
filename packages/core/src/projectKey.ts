/**
 * Projects live in their owner's namespace, like repositories on GitHub: a project's key is
 * `<owner>/<name>` — the owner's username, then the project's name (unique per owner, so two people
 * can each have a "thesis") — and its directory is `<projects root>/<owner>/<name>`. A document id
 * is the key followed by the file's path in the project: `jan/thesis/chapters/intro.tex`, which is
 * also what the web client's URL shows (`/#/jan/thesis/chapters/intro.tex`), the same for everyone
 * who can open the project.
 */

/** A project's name, as a person types it (no slash): letters, digits, space, dot, dash, underscore. */
export const PROJECT_NAME_RE = /^[A-Za-z0-9._ -]+$/;
/** An owner: a username (lower case letters, digits, dot, dash, underscore — auth.ts). */
const OWNER_RE = /^[A-Za-z0-9._-]+$/;
const dots = (s: string) => s === '.' || s === '..';

/** A name for a new project: no slash, not hidden (listings skip dot directories), not `.`/`..`. */
export function isProjectName(name: string): boolean {
  return PROJECT_NAME_RE.test(name) && name.trim() === name && !name.startsWith('.');
}

/** `<owner>/<name>`, both parts safe as directory names. */
export function isProjectKey(key: string): boolean {
  const i = key.indexOf('/');
  if (i <= 0) return false;
  const owner = key.slice(0, i), name = key.slice(i + 1);
  return OWNER_RE.test(owner) && !dots(owner) && PROJECT_NAME_RE.test(name) && !dots(name);
}

export function projectKey(owner: string, name: string): string { return `${owner}/${name}`; }

/** The owner and the name of a project key (`name` is the whole key when it has no owner part). */
export function splitProjectKey(key: string): { owner: string; name: string } {
  const i = key.indexOf('/');
  return i < 0 ? { owner: '', name: key } : { owner: key.slice(0, i), name: key.slice(i + 1) };
}

/** A project's name without its owner (for labels). */
export function projectShortName(key: string): string { return splitProjectKey(key).name; }

/** `owner/name/dir/file.tex` → `{ project: 'owner/name', path: 'dir/file.tex' }` (empty parts when the id is too short). */
export function splitDocId(id: string): { project: string; path: string } {
  const a = id.indexOf('/');
  const b = a < 0 ? -1 : id.indexOf('/', a + 1);
  if (b < 0) return { project: a < 0 ? '' : id, path: '' };
  return { project: id.slice(0, b), path: id.slice(b + 1) };
}

/** The project key of a document id. */
export function projectOfDoc(id: string): string { return splitDocId(id).project; }

/** The path of a document id inside its project. */
export function docPathOf(id: string): string { return splitDocId(id).path; }

/** The directory of a document inside its project (`''` at the project's top level). */
export function docDirOf(id: string): string {
  const p = docPathOf(id);
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

const TEXT_EXTS = new Set(['tex', 'sty', 'cls', 'bib', 'bst', 'bbx', 'cbx', 'lbx', 'dtx', 'ins', 'ltx', 'clo', 'lco', 'ldf', 'fd', 'def', 'cfg', 'txt', 'md', 'markdown', 'rst', 'csv', 'tsv', 'json', 'yaml', 'yml', 'toml', 'ini', 'xml', 'html', 'css', 'js', 'ts', 'py', 'sh', 'r', 'm', 'jl', 'lua', 'layout', 'module', 'inc', 'bind', 'ui', 'log', 'aux', 'bbl', 'blg', 'out', 'toc', 'lof', 'lot', 'gitignore', 'latexmkrc']);
const TEXT_NAMES = new Set(['makefile', 'latexmkrc', '.latexmkrc', 'readme', 'license', '.gitignore', 'dockerfile']);
/** Files the web app opens in its text editor (everything else that is not a document opens in a browser tab). */
export function isTextFile(name: string): boolean {
  const base = name.split('/').pop() ?? name;
  if (TEXT_NAMES.has(base.toLowerCase())) return true;
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1).toLowerCase() : '';
  return TEXT_EXTS.has(ext);
}

/** Extensions a file's name ends in, so that a link to it needs no path (`README.md`); names ending in a web domain (`docs.rs`, `bun.sh`, `claude.ai`) are left out. */
const LINK_FILE_EXTS = new Set(['tex', 'ltx', 'sty', 'cls', 'bib', 'bst', 'lyx', 'board', 'md', 'markdown', 'txt', 'rst', 'html', 'htm', 'pdf', 'eps', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'tif', 'tiff',
  'py', 'ipynb', 'r', 'jl', 'm', 'c', 'h', 'cpp', 'hpp', 'js', 'mjs', 'ts', 'tsx', 'json', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'csv', 'tsv', 'dat', 'npy', 'npz', 'mat', 'h5', 'pkl',
  'zip', 'gz', 'tgz', 'tar', 'log', 'mp4', 'mov', 'webm', 'mp3', 'wav', 'docx', 'xlsx', 'pptx', 'odt', 'tikz', 'pgf']);

/**
 * A link's target as a path relative to its document (`README.md`, `../talk/index.html`,
 * `notes/plan.tex#goal`, `#sec:intro`) or null for a web address. LaTeX's `\href{README.md}{…}`,
 * hyperref's `run:` and `file:` links (LyX's file hyperlinks), Markdown's `[…](README.md)` and HTML's
 * `<a href="README.md">` name files this way. Without a path a name is a file's when it has no dot or
 * ends in a file's extension (`README.md`); `example.org` and `www.…` are web addresses.
 */
export function relativeLink(target: string): string | null {
  const t = target.trim();
  const local = /^(run|file):(?!\/\/)/i.exec(t);
  if (local) return t.slice(local[0].length) || null;
  if (!t || /^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('//')) return null;
  if (/^(\.{0,2}\/|[#?])/.test(t)) return t;
  const first = t.split(/[/?#]/)[0];
  if (/^(www\.|localhost$)/i.test(first)) return null;
  return !first.includes('.') || LINK_FILE_EXTS.has(first.slice(first.lastIndexOf('.') + 1).toLowerCase()) ? t : null;
}

/**
 * A project file's address in the web app on the server at `origin`: the tab it opens in there, as
 * the client's fileTabId names it — documents, slides, posters and boards as themselves, PDFs in the
 * PDF viewer (`pdf:`), other text files in the text editor (`text:`) — or the project's for a file
 * that opens in none. Links to a place in it extend it (client editor/permalink.ts); the VS Code
 * extension makes them for folders synced with a project.
 */
export function webFileAddress(origin: string, project: string, path: string): string {
  const enc = (s: string) => s.split('/').map(encodeURIComponent).join('/');
  const ext = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '';
  const prefix = ['tex', 'md', 'markdown', 'html', 'htm', 'board'].includes(ext) ? '' : ext === 'pdf' ? 'pdf:' : ext !== 'lyx' && isTextFile(path) ? 'text:' : null;
  return `${origin.replace(/\/+$/, '')}/#/${prefix === null || !path ? enc(project) : prefix + enc(`${project}/${path}`)}`;
}
