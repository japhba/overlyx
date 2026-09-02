export interface User { id: number; username: string; name: string; color: string; isAdmin: boolean; avatar?: string | null }
/** `doc`: a .tex document (opens in the editor); `tex`: other LaTeX sources (text editor); `lyx`: importable */
export interface ProjectFile { path: string; name: string; size: number; mtime: number; kind: 'doc' | 'lyx' | 'bib' | 'image' | 'tex' | 'pdf' | 'dir' | 'other' }
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
export interface TexHeading { level: number; text: string; n: number; num?: string; starred: boolean }
export interface SyncBox { page: number; x: number; y: number; h: number; v: number; W: number; H: number }
export interface BibItem { key: string; author: string; year: string; title: string }
export interface HealthIssue { code: string; message: string; severity: 'warning' | 'error'; fixable: boolean }
/** ProseMirror JSON (nodes of the editor schema) as the server returns them for AI proposals */
export interface PMJSON { type: string; attrs?: Record<string, any>; content?: PMJSON[]; marks?: { type: string; attrs?: Record<string, any> }[]; text?: string }
export interface AiModelInfo { id: string; label: string; note: string }
export interface AiStatus { available: boolean; model: string; completionModel: string; models: AiModelInfo[] }
export interface AiRewriteRequest { instruction: string; content: PMJSON[]; layout?: string; before?: string; after?: string; model?: string; math?: { latex: string; display: boolean; selection?: string } }
export interface AiRewriteResult { tex: string; nodes: PMJSON[]; original: string }
export interface AiCompleteRequest { kind: 'text' | 'math'; before: string; after: string; formula?: string; paragraph?: string; model?: string }
export interface AiCompleteResult { text: string; nodes: PMJSON[] }
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
  /** structural damage found in the file on disk (an external edit broke an OverLyX convention) */
  health: HealthIssue[];
}
export interface BuildJob { id: number; status: 'queued' | 'exporting' | 'compiling' | 'ok' | 'error' | 'cancelled'; engine: string; requestedBy: string; startedAt: number; phaseAt: number; finishedAt?: number; progress: string; rerun: boolean }
export interface BuildInfo { status: string; log: string; pdf: string | null; pdf_path: string | null; tex_path: string | null; updated_at: number; warnings: string[]; tex?: string }
export interface VersionInfo { id: number; name: string; author: string; kind: string; created_at: number; size: number }
export interface GitCommit { hash: string; author: string; date: number; message: string }
export interface GitInfo { url: string; username: string; role: Role; hasPassword: boolean; branch: string; commits: GitCommit[]; pending: number; pendingFiles: string[]; head: string | null }
export interface GitToken { id: number; name: string; created_at: number; last_used_at: number | null; /** the plaintext, present only for accounts with token re-copy enabled (Settings ▸ Account) */ token?: string }
/** Per-account server-side settings (Settings ▸ Account; userSettings.ts on the server). */
export interface UserSettings { allowRecopyTokens: boolean }
export interface AdminUser { id: number; username: string; name: string; color: string; isAdmin: number; email: string | null; allowRecopyTokens: boolean }
/** the project's off-site mirror (a private repository in the instance's GitHub organisation) */
export interface MirrorStatus { configured: boolean; org: string | null; repo: string | null; url: string | null; enabled: boolean; head: string | null; lastHead: string | null; lastPushAt: number | null; lastAttemptAt: number | null; lastError: string | null; behind: boolean; intervalMs: number }
export type AccessAction = 'open' | 'build' | 'git-fetch' | 'git-push' | 'share' | 'admin-access';
export interface ActivityEntry { id: number; action: AccessAction; detail: string | null; at: number; user: { id: number; name: string; username: string } | null }
export interface AdminProjectInfo { name: string; title: string | null; kind: string; owner: { id: number; name: string; username: string } | null; access: 'owner' | 'member' | 'granted' | null; grantUntil: number | null }

/** The embedded coding agent (agent.ts on the server: OpenAI Codex, the user's own ChatGPT account) */
export interface AgentStatus { enabled: boolean; authenticated: boolean; method?: string | null; account?: { email: string | null; plan: string | null } | null }
export interface AgentLogin { loginId: string; verificationUrl: string; userCode: string }
export interface AgentThreadInfo { id: string; title: string | null; user: { id: number; name: string | null }; mine: boolean; createdAt: number; updatedAt: number }
export interface AgentChange { path: string; kind: string; diff: string }
/** one entry of a thread's transcript (codex's ThreadItem, loosely typed — we render known kinds) */
export interface AgentItem {
  type: string; id: string; text?: string; status?: string;
  content?: { type: string; text?: string }[];
  summary?: string[]; command?: string; cwd?: string; aggregatedOutput?: string | null; exitCode?: number | null;
  changes?: AgentChange[]; server?: string; tool?: string;
}
export interface AgentTurn { id: string; items: AgentItem[]; status: string }
/** one message of the agent events stream (SSE) */
export interface AgentEventMsg { kind: 'notification' | 'request' | 'status'; method?: string; params?: any; requestId?: string; running?: boolean }
export interface AgentTurnContext { docId?: string; content?: PMJSON[]; layout?: string; mathLatex?: string; openDocs?: string[] }
export interface AgentModel { id: string; label: string; description: string; efforts: string[]; defaultEffort: string | null; isDefault: boolean }

/**
 * Base URL for the API. Empty in the web app (same origin); the VS Code extension's webview sets
 * `globalThis.OVERLYX_API_BASE` to its local bridge before importing this module.
 */
export const API_BASE: string = (globalThis as unknown as { OVERLYX_API_BASE?: string }).OVERLYX_API_BASE ?? '';

async function req<T>(method: string, url: string, body?: unknown, raw?: BodyInit, signal?: AbortSignal): Promise<T> {
  const res = await fetch(API_BASE + url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    credentials: 'same-origin',
    signal,
  });
  const text = await res.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) { const err = new Error(data.error ?? `${res.status} ${res.statusText}`) as Error & { status: number; data: any }; err.status = res.status; err.data = data; throw err; }
  return data as T;
}

export const encId = (id: string) => encodeURIComponent(id);

export interface LitHit { id: string; title: string; authors: string[]; year: number | null; venue: string; type: string; doi: string | null; arxiv: string | null; url: string | null; citations: number | null; sources: string[]; dblp?: string }
export interface BibAddResult { key: string; file: string; existed: boolean; bibtex: string; entry: BibItem }
export interface FeedbackInfo { enabled: boolean; repo: string; newIssueUrl: string; version: string; errorReports: boolean }
export const api = {
  literatureSearch: (q: string) => req<{ hits: LitHit[]; sources: string[]; warnings: string[] }>('GET', `/api/bib/search?q=${encodeURIComponent(q)}`),
  literatureSources: () => req<{ enabled: boolean; sources: string[] }>('GET', '/api/bib/sources'),
  bibAdd: (project: string, data: { hit?: LitHit; bibtex?: string }) => req<BibAddResult>('POST', `/api/projects/${encodeURIComponent(project)}/bib/add`, data),
  feedbackInfo: () => req<FeedbackInfo>('GET', '/api/feedback/info'),
  feedback: (data: { kind: 'bug' | 'idea' | 'question'; title: string; body: string; doc?: string | null; error?: string | null }) => req<{ number: number; url: string }>('POST', '/api/feedback', data),
  clientError: (data: { message: string; stack?: string | null }) => req<{ url: string | null }>('POST', '/api/client-error', data),
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
  // git: every project is a repository (clone URL, history); tokens are the password for git over HTTPS
  gitInfo: (project: string) => req<GitInfo>('GET', `/api/projects/${encodeURIComponent(project)}/git`),
  gitCommit: (project: string, message?: string) => req<{ committed: boolean } & Omit<GitInfo, 'url' | 'username' | 'role' | 'hasPassword'>>('POST', `/api/projects/${encodeURIComponent(project)}/git/commit`, message ? { message } : {}),
  mirrorStatus: (project: string) => req<MirrorStatus>('GET', `/api/projects/${encodeURIComponent(project)}/mirror`),
  mirrorUpdate: (project: string, body: { enabled?: boolean; now?: boolean }) => req<MirrorStatus>('POST', `/api/projects/${encodeURIComponent(project)}/mirror`, body),
  /** the owner's activity log of a project */
  activity: (project: string, limit = 50) => req<{ entries: ActivityEntry[] }>('GET', `/api/projects/${encodeURIComponent(project)}/activity?limit=${limit}`),
  // administration: every project, and a logged, time-limited grant to open one
  adminProjects: () => req<{ projects: AdminProjectInfo[] }>('GET', '/api/admin/projects'),
  adminAccess: (project: string, minutes = 60) => req<{ until: number }>('POST', `/api/admin/projects/${encodeURIComponent(project)}/access`, { minutes }),
  gitTokens: () => req<{ tokens: GitToken[] }>('GET', '/api/git/tokens'),
  createGitToken: (name: string) => req<{ id: number; token: string; tokens: GitToken[] }>('POST', '/api/git/tokens', { name }),
  deleteGitToken: (id: number) => req<{ tokens: GitToken[] }>('DELETE', `/api/git/tokens/${id}`),
  /** the signed-in account's server-side settings; administrators switch them per user */
  settings: () => req<{ settings: UserSettings }>('GET', '/api/settings'),
  adminUserSettings: (id: number, patch: Partial<UserSettings>) => req<{ settings: UserSettings }>('POST', `/api/admin/users/${id}/settings`, patch),
  mcpTokens: () => req<{ tokens: GitToken[] }>('GET', '/api/mcp-tokens'),
  createMcpToken: (name: string) => req<{ id: number; token: string; tokens: GitToken[] }>('POST', '/api/mcp-tokens', { name }),
  deleteMcpToken: (id: number) => req<{ tokens: GitToken[] }>('DELETE', `/api/mcp-tokens/${id}`),
  newDoc: (project: string, path: string, opts: { title?: string; textclass?: string } = {}) => req<{ id: string }>('POST', `/api/projects/${encodeURIComponent(project)}/new`, { path, ...opts }),
  /** plain text files (.tex, .bib, …) for the built-in text editor; `mtime` guards against overwriting someone else's save */
  readText: (project: string, path: string) => req<{ text: string; mtime: number; size: number; role: Role }>('GET', `/api/projects/${encodeURIComponent(project)}/text/${path.split('/').map(encodeURIComponent).join('/')}`),
  writeText: (project: string, path: string, text: string, mtime?: number) => req<{ ok: boolean; mtime: number; size: number }>('PUT', `/api/projects/${encodeURIComponent(project)}/text/${path.split('/').map(encodeURIComponent).join('/')}`, mtime !== undefined ? { text, mtime } : { text }),
  upload: (project: string, path: string, file: Blob, opts?: { overwrite?: boolean }) => req<{ ok: boolean; path: string }>('POST', `/api/projects/${encodeURIComponent(project)}/upload?path=${encodeURIComponent(path)}${opts?.overwrite === false ? '&overwrite=0' : ''}`, undefined, file),
  fileOp: (project: string, body: { op: 'rename' | 'delete' | 'mkdir' | 'copy'; from?: string; to?: string }) => req<{ ok: boolean }>('POST', `/api/projects/${encodeURIComponent(project)}/fileops`, body),
  meta: (id: string) => req<DocMeta>('GET', `/api/docs/${encId(id)}/meta`),
  /** the document's LaTeX source (what its .tex file contains) */
  texText: (id: string) => fetch(`${API_BASE}/api/docs/${encId(id)}/tex`).then(r => r.text()),
  /** replace the document by hand-edited LaTeX source */
  applySource: (id: string, text: string) => req<{ ok: boolean; warnings: string[] }>('POST', `/api/docs/${encId(id)}/source`, { text }),
  /** parse pasted LaTeX in the document's context: ProseMirror block JSON to insert */
  parseClip: (id: string, latex: string) => req<{ blocks: unknown[]; warnings: string[] }>('POST', `/api/docs/${encId(id)}/clip`, { latex }),
  header: (id: string) => req<{ headerLines: string[] }>('GET', `/api/docs/${encId(id)}/header`),
  /** convert a .lyx file of the project (and its children) to .tex documents */
  importLyx: (project: string, path: string) => req<{ id: string; created: string[]; warnings: string[]; graphics: { src: string; dest: string; ok: boolean; error?: string }[] }>('POST', `/api/projects/${encodeURIComponent(project)}/import`, { path }),
  save: (id: string) => req<{ ok: boolean }>('POST', `/api/docs/${encId(id)}/save`),
  setHeader: (id: string, body: { headerLines?: string[]; preamble?: string; set?: Record<string, string> }) => req<{ ok: boolean; headerLines: string[] }>('POST', `/api/docs/${encId(id)}/header`, body),
  /** Mend mechanically-fixable structural damage (managed-block markers); returns what was fixed and what remains. */
  repair: (id: string) => req<{ fixed: string[]; remaining: HealthIssue[] }>('POST', `/api/docs/${encId(id)}/repair`),
  /** "Escalate to AI…": asks OpenRouter to propose a fix; nothing is applied yet. */
  aiRepair: (id: string) => req<{ original: string; proposed: string; issues: HealthIssue[] }>('POST', `/api/docs/${encId(id)}/ai-repair`),
  /** Apply an AI-proposed fix once approved in the merge editor. */
  applyAiRepair: (id: string, original: string, proposed: string) => req<{ ok: true; remaining: HealthIssue[] }>('POST', `/api/docs/${encId(id)}/ai-repair/apply`, { original, proposed }),
  /** AI assistance (ai.ts on the server): availability, ⌘K rewrite, autocomplete */
  aiStatus: () => req<AiStatus>('GET', '/api/ai/status'),
  aiRewrite: (id: string, body: AiRewriteRequest, signal?: AbortSignal) => req<AiRewriteResult>('POST', `/api/docs/${encId(id)}/ai/rewrite`, body, undefined, signal),
  aiComplete: (id: string, body: AiCompleteRequest, signal?: AbortSignal) => req<AiCompleteResult>('POST', `/api/docs/${encId(id)}/ai/complete`, body, undefined, signal),
  /** the embedded coding agent (Agent panel; agent.ts on the server) */
  agentStatus: () => req<AgentStatus>('GET', '/api/agent/status'),
  agentLogin: () => req<AgentLogin>('POST', '/api/agent/login'),
  agentLoginCancel: (loginId: string) => req<{ ok: boolean }>('POST', '/api/agent/login/cancel', { loginId }),
  agentLogout: () => req<{ ok: boolean }>('POST', '/api/agent/logout'),
  agentThreads: (project: string) => req<{ threads: AgentThreadInfo[] }>('GET', `/api/projects/${encodeURIComponent(project)}/agent/threads`),
  agentStartThread: (project: string) => req<{ id: string; model: string | null }>('POST', `/api/projects/${encodeURIComponent(project)}/agent/threads`),
  agentThread: (project: string, tid: string) => req<{ thread: { id: string; turns: AgentTurn[] }; mine: boolean }>('GET', `/api/projects/${encodeURIComponent(project)}/agent/threads/${encodeURIComponent(tid)}`),
  agentModels: () => req<{ models: AgentModel[] }>('GET', '/api/agent/models'),
  agentTurn: (project: string, tid: string, body: { text: string; context?: AgentTurnContext; model?: string; effort?: string; clientMessageId?: string }) => req<{ ok: boolean }>('POST', `/api/projects/${encodeURIComponent(project)}/agent/threads/${encodeURIComponent(tid)}/turn`, body),
  agentSteer: (project: string, tid: string, turnId: string, text: string, clientMessageId?: string, context?: AgentTurnContext) => req<{ ok: boolean }>('POST', `/api/projects/${encodeURIComponent(project)}/agent/threads/${encodeURIComponent(tid)}/steer`, { turnId, text, clientMessageId, context }),
  agentApprove: (project: string, tid: string, requestId: string, decision: string) => req<{ ok: boolean }>('POST', `/api/projects/${encodeURIComponent(project)}/agent/threads/${encodeURIComponent(tid)}/approval`, { requestId, decision }),
  agentInterrupt: (project: string, tid: string, turnId: string) => req<{ ok: boolean }>('POST', `/api/projects/${encodeURIComponent(project)}/agent/threads/${encodeURIComponent(tid)}/interrupt`, { turnId }),
  versions: (id: string) => req<{ versions: VersionInfo[] }>('GET', `/api/docs/${encId(id)}/versions`),
  /** `lyx`: explicit content (e.g. offline edits that could not be merged) instead of the current server state */
  createVersion: (id: string, name: string, lyx?: string) => req<{ id: number }>('POST', `/api/docs/${encId(id)}/versions`, lyx !== undefined ? { name, lyx } : { name }),
  getVersion: (id: string, vid: number) => req<{ lyx: string; name: string; created_at: number; author: string }>('GET', `/api/docs/${encId(id)}/versions/${vid}`),
  restoreVersion: (id: string, vid: number) => req<{ ok: boolean }>('POST', `/api/docs/${encId(id)}/versions/${vid}/restore`),
  deleteVersion: (id: string, vid: number) => req<{ ok: boolean }>('DELETE', `/api/docs/${encId(id)}/versions/${vid}`),
  bibSearch: (id: string, q: string, limit = 100) => req<{ entries: BibItem[]; total: number; matches: number }>('GET', `/api/docs/${encId(id)}/bib?q=${encodeURIComponent(q)}&limit=${limit}`),
  /** LaTeX export (returns the source) or a PDF build request (a background job; poll `build`) */
  export: (id: string, format: 'pdf' | 'tex') => req<{ ok: boolean; log?: string; warnings?: string[]; pdf?: string | null; tex?: string; job?: BuildJob }>('POST', `/api/docs/${encId(id)}/export`, { format }),
  cancelBuild: (id: string) => req<{ ok: boolean }>('POST', `/api/docs/${encId(id)}/export/cancel`),
  /** SyncTeX: the PDF boxes (points, origin top-left) of a 1-based line of the built .tex; inverse: the source line under a PDF point. */
  /** headings of a document from its file (the document panel's outline of documents that are not open) */
  docOutline: (id: string) => req<{ headings: TexHeading[]; mtime: number }>('GET', `/api/docs/${encId(id)}/outline`),
  synctexView: (id: string, line: number) => req<{ boxes: SyncBox[] }>('GET', `/api/docs/${encId(id)}/synctex/view?line=${line}`),
  synctexEdit: (id: string, page: number, x: number, y: number) => req<{ file?: string; line: number | null; column?: number }>('GET', `/api/docs/${encId(id)}/synctex/edit?page=${page}&x=${x.toFixed(2)}&y=${y.toFixed(2)}`),
  build: (id: string, withTex = false) => req<{ build: BuildInfo | null; job: BuildJob | null }>('GET', `/api/docs/${encId(id)}/build${withTex ? '?tex=1' : ''}`),
  users: () => req<{ users: AdminUser[] }>('GET', '/api/users'),
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
  return `${API_BASE}/api/projects/${encodeURIComponent(project)}/graphics/${path.split('/').map(encodeURIComponent).join('/')}?w=${w}`;
}
export function fileUrl(project: string, path: string): string {
  return `${API_BASE}/api/projects/${encodeURIComponent(project)}/file/${path.split('/').map(encodeURIComponent).join('/')}`;
}
