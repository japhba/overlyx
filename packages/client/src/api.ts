export interface User { id: number; username: string; name: string; color: string; isAdmin: boolean; avatar?: string | null }
export interface ProjectFile { path: string; name: string; size: number; mtime: number; kind: 'lyx' | 'bib' | 'image' | 'tex' | 'pdf' | 'other' }
export type Role = 'owner' | 'edit' | 'view';
export interface Project {
  name: string; files: ProjectFile[];
  /** display name (the directory name otherwise) */
  title?: string | null;
  /** 'project' | 'example' (the personal welcome project) */
  kind?: string;
  role?: Role;
  /** how the user got access: owns it / shared with them / joined via link / administrator */
  via?: 'owner' | 'member' | 'link' | 'admin';
  owner?: { id: number; name: string; username: string } | null;
}
export interface ShareMember { id: number; role: 'view' | 'edit'; via: string; email: string | null; user: { id: number; name: string; username: string; color: string; avatar: string | null } | null }
export interface ShareInfo { name?: string; title?: string | null; owner: { id: number; name: string; username: string } | null; members: ShareMember[]; link: { token: string; role: 'view' | 'edit' } | null }
export interface LayoutInfo { name: string; category?: string; labelType?: string; tocLevel?: number; latexType?: string; latexName?: string; isNumbered?: boolean }
export interface BibItem { key: string; author: string; year: string; title: string }
export interface DocMeta {
  id: string; project: string; path: string; role?: Role; textclass: string; modules: string[]; language: string;
  useRefstyle: boolean; citeEngine: string; citeEngineType: string; trackingChanges: boolean; secnumdepth: number; tocdepth: number;
  /** number of entries in the bibliography (meta.bib only holds the cited ones when it is large) */
  bibTotal?: number;
  authors: { id: number; name: string; email?: string }[];
  macros: Record<string, { def: string; args: number; expand: boolean }>;
  macroList: { name: string; args: number; def: string; display?: string; source: string }[];
  bib: BibItem[]; layouts: LayoutInfo[] | null; flexInsets: string[] | null; files: ProjectFile[];
  master: string | null; labels: { name: string; context: string; file: string }[];
}
export interface BuildJob { id: number; status: 'queued' | 'exporting' | 'compiling' | 'ok' | 'error' | 'cancelled'; engine: string; requestedBy: string; startedAt: number; phaseAt: number; finishedAt?: number; progress: string; rerun: boolean }
export interface BuildInfo { status: string; log: string; pdf: string | null; pdf_path: string | null; tex_path: string | null; updated_at: number; warnings: string[]; tex?: string }
export interface VersionInfo { id: number; name: string; author: string; kind: string; created_at: number; size: number }

async function req<T>(method: string, url: string, body?: unknown, raw?: BodyInit): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    credentials: 'same-origin',
  });
  const text = await res.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) { const err = new Error(data.error ?? `${res.status} ${res.statusText}`) as Error & { status: number; data: any }; err.status = res.status; err.data = data; throw err; }
  return data as T;
}

export const encId = (id: string) => encodeURIComponent(id);

export const api = {
  me: () => req<{ user: User | null; google: boolean; signup?: 'open' | 'invited' }>('GET', '/api/auth/me'),
  login: (username: string, password: string) => req<{ user: User }>('POST', '/api/auth/login', { username, password }),
  logout: () => req<{ ok: boolean }>('POST', '/api/auth/logout'),
  projects: () => req<{ projects: Project[] }>('GET', '/api/projects'),
  createProject: (name: string) => req<{ project: Project }>('POST', '/api/projects', { name }),
  deleteProject: (name: string) => req<{ ok: boolean }>('DELETE', `/api/projects/${encodeURIComponent(name)}`),
  // sharing (owner only)
  share: (project: string) => req<ShareInfo>('GET', `/api/projects/${encodeURIComponent(project)}/share`),
  addMember: (project: string, who: string, role: 'view' | 'edit') => req<{ member: ShareMember; share: ShareInfo }>('POST', `/api/projects/${encodeURIComponent(project)}/share/members`, { who, role }),
  setMemberRole: (project: string, id: number, role: 'view' | 'edit') => req<{ share: ShareInfo }>('POST', `/api/projects/${encodeURIComponent(project)}/share/members/${id}`, { role }),
  removeMember: (project: string, id: number) => req<{ share: ShareInfo }>('DELETE', `/api/projects/${encodeURIComponent(project)}/share/members/${id}`),
  setLink: (project: string, role: 'view' | 'edit' | null) => req<{ link: ShareInfo['link']; share: ShareInfo }>('POST', `/api/projects/${encodeURIComponent(project)}/share/link`, { role }),
  setOwner: (project: string, username: string) => req<{ share: ShareInfo }>('POST', `/api/projects/${encodeURIComponent(project)}/share/owner`, { username }),
  /** open a share link (#/share/<token>): join the project; `doc` is the document to open */
  acceptShare: (token: string) => req<{ project: string; title: string | null; role: Role; doc: string | null }>('POST', `/api/share/${encodeURIComponent(token)}/accept`),
  newDoc: (project: string, path: string, opts: { title?: string; textclass?: string } = {}) => req<{ id: string }>('POST', `/api/projects/${encodeURIComponent(project)}/new`, { path, ...opts }),
  /** plain text files (.tex, .bib, …) for the built-in text editor; `mtime` guards against overwriting someone else's save */
  readText: (project: string, path: string) => req<{ text: string; mtime: number; size: number; role: Role }>('GET', `/api/projects/${encodeURIComponent(project)}/text/${path.split('/').map(encodeURIComponent).join('/')}`),
  writeText: (project: string, path: string, text: string, mtime?: number) => req<{ ok: boolean; mtime: number; size: number }>('PUT', `/api/projects/${encodeURIComponent(project)}/text/${path.split('/').map(encodeURIComponent).join('/')}`, mtime !== undefined ? { text, mtime } : { text }),
  upload: (project: string, path: string, file: Blob) => req<{ ok: boolean; path: string }>('POST', `/api/projects/${encodeURIComponent(project)}/upload?path=${encodeURIComponent(path)}`, undefined, file),
  meta: (id: string) => req<DocMeta>('GET', `/api/docs/${encId(id)}/meta`),
  lyxText: (id: string) => fetch(`/api/docs/${encId(id)}/lyx`).then(r => r.text()),
  save: (id: string) => req<{ ok: boolean }>('POST', `/api/docs/${encId(id)}/save`),
  setHeader: (id: string, body: { headerLines?: string[]; preamble?: string; set?: Record<string, string> }) => req<{ ok: boolean; headerLines: string[] }>('POST', `/api/docs/${encId(id)}/header`, body),
  versions: (id: string) => req<{ versions: VersionInfo[] }>('GET', `/api/docs/${encId(id)}/versions`),
  /** `lyx`: explicit content (e.g. offline edits that could not be merged) instead of the current server state */
  createVersion: (id: string, name: string, lyx?: string) => req<{ id: number }>('POST', `/api/docs/${encId(id)}/versions`, lyx !== undefined ? { name, lyx } : { name }),
  getVersion: (id: string, vid: number) => req<{ lyx: string; name: string; created_at: number; author: string }>('GET', `/api/docs/${encId(id)}/versions/${vid}`),
  restoreVersion: (id: string, vid: number) => req<{ ok: boolean }>('POST', `/api/docs/${encId(id)}/versions/${vid}/restore`),
  deleteVersion: (id: string, vid: number) => req<{ ok: boolean }>('DELETE', `/api/docs/${encId(id)}/versions/${vid}`),
  bibSearch: (id: string, q: string, limit = 100) => req<{ entries: BibItem[]; total: number; matches: number }>('GET', `/api/docs/${encId(id)}/bib?q=${encodeURIComponent(q)}&limit=${limit}`),
  /** LaTeX export (returns the source) or a PDF build request (a background job; poll `build`) */
  export: (id: string, format: 'pdf' | 'tex', engine: 'overlyx' | 'lyx' = 'overlyx') => req<{ ok: boolean; log?: string; warnings?: string[]; pdf?: string | null; tex?: string; job?: BuildJob }>('POST', `/api/docs/${encId(id)}/export`, { format, engine }),
  cancelBuild: (id: string) => req<{ ok: boolean }>('POST', `/api/docs/${encId(id)}/export/cancel`),
  build: (id: string, withTex = false) => req<{ build: BuildInfo | null; job: BuildJob | null }>('GET', `/api/docs/${encId(id)}/build${withTex ? '?tex=1' : ''}`),
  users: () => req<{ users: { id: number; username: string; name: string; color: string; isAdmin: number }[] }>('GET', '/api/users'),
  createUser: (username: string, name: string, password?: string) => req<{ user: User; password: string }>('POST', '/api/users', { username, name, password }),
};

const TEXT_EXTS = new Set(['tex', 'sty', 'cls', 'bib', 'bst', 'bbx', 'cbx', 'lbx', 'dtx', 'ins', 'ltx', 'clo', 'lco', 'ldf', 'fd', 'def', 'cfg', 'txt', 'md', 'markdown', 'rst', 'csv', 'tsv', 'json', 'yaml', 'yml', 'toml', 'ini', 'xml', 'html', 'css', 'js', 'ts', 'py', 'sh', 'r', 'm', 'jl', 'lua', 'layout', 'module', 'inc', 'bind', 'ui', 'log', 'aux', 'bbl', 'blg', 'out', 'toc', 'lof', 'lot', 'gitignore', 'latexmkrc']);
const TEXT_NAMES = new Set(['makefile', 'latexmkrc', '.latexmkrc', 'readme', 'license', '.gitignore', 'dockerfile']);
/** Files that open in the built-in text editor (everything else that is not a document opens in a browser tab). */
export function isTextFile(name: string): boolean {
  const base = name.split('/').pop() ?? name;
  if (TEXT_NAMES.has(base.toLowerCase())) return true;
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1).toLowerCase() : '';
  return TEXT_EXTS.has(ext);
}
const AUX_EXTS = new Set(['aux', 'log', 'bbl', 'blg', 'fls', 'fdb_latexmk', 'out', 'toc', 'lof', 'lot', 'nav', 'snm', 'bcf', 'dvi', 'xdv', 'spl', 'idx', 'ind', 'ilg', 'glo', 'gls', 'glg', 'acn', 'acr', 'alg', 'ist', 'loa', 'lol', 'thm', 'vrb', 'xcp', 'upa', 'upb', 'synctex']);
/** LaTeX build products — hidden in the file browser unless "all files" is on. */
export function isAuxFile(name: string): boolean {
  const base = (name.split('/').pop() ?? name).toLowerCase();
  if (base.endsWith('.synctex.gz') || base.endsWith('.run.xml')) return true;
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : '';
  return AUX_EXTS.has(ext);
}

export function graphicsUrl(project: string, path: string, w = 1200): string {
  return `/api/projects/${encodeURIComponent(project)}/graphics/${path.split('/').map(encodeURIComponent).join('/')}?w=${w}`;
}
export function fileUrl(project: string, path: string): string {
  return `/api/projects/${encodeURIComponent(project)}/file/${path.split('/').map(encodeURIComponent).join('/')}`;
}
