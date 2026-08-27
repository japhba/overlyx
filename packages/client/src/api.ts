export interface User { id: number; username: string; name: string; color: string; isAdmin: boolean; avatar?: string | null }
export interface ProjectFile { path: string; name: string; size: number; mtime: number; kind: 'lyx' | 'bib' | 'image' | 'tex' | 'pdf' | 'other' }
export interface Project { name: string; files: ProjectFile[] }
export interface LayoutInfo { name: string; category?: string; labelType?: string; tocLevel?: number; latexType?: string; latexName?: string; isNumbered?: boolean }
export interface BibItem { key: string; author: string; year: string; title: string }
export interface DocMeta {
  id: string; project: string; path: string; textclass: string; modules: string[]; language: string;
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
  if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`);
  return data as T;
}

export const encId = (id: string) => encodeURIComponent(id);

export const api = {
  me: () => req<{ user: User | null; google: boolean }>('GET', '/api/auth/me'),
  login: (username: string, password: string) => req<{ user: User }>('POST', '/api/auth/login', { username, password }),
  logout: () => req<{ ok: boolean }>('POST', '/api/auth/logout'),
  projects: () => req<{ projects: Project[] }>('GET', '/api/projects'),
  createProject: (name: string) => req<{ project: Project }>('POST', '/api/projects', { name }),
  newDoc: (project: string, path: string, opts: { title?: string; textclass?: string } = {}) => req<{ id: string }>('POST', `/api/projects/${encodeURIComponent(project)}/new`, { path, ...opts }),
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

export function graphicsUrl(project: string, path: string, w = 1200): string {
  return `/api/projects/${encodeURIComponent(project)}/graphics/${path.split('/').map(encodeURIComponent).join('/')}?w=${w}`;
}
export function fileUrl(project: string, path: string): string {
  return `/api/projects/${encodeURIComponent(project)}/file/${path.split('/').map(encodeURIComponent).join('/')}`;
}
