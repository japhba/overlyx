import type { LayoutCheck, DocGroup, PageBreaks } from '@overlyx/core';
import { isTextFile } from '@overlyx/core/projectKey.ts';
import { offlineGet } from './offline-api';
import { noteProjectFiles } from './articlekinds';
import { recordInteraction } from './usage';
import { apiInteraction, requestOutcome } from '@overlyx/core/interactions.ts';
import type { PageSize } from '@overlyx/core/html/deliverable.ts';

export interface User {
  id: number; username: string; name: string; color: string; isAdmin: boolean; avatar?: string | null;
  /** a temporary account: came in through a share link without signing in; signing in keeps what the link opened */
  guest?: boolean;
}

/** Google sign-in, returning to `next` (a location hash like `#/project/doc.tex`) afterwards. */
export function googleSignInUrl(next: string = location.hash): string {
  return '/api/auth/google' + (next.startsWith('#/') && next.length > 2 ? '?next=' + encodeURIComponent(next) : '');
}
/** `doc`: a .tex document (opens in the editor); `tex`: other LaTeX sources (text editor); `lyx`: importable */
export interface ProjectFile {
  path: string; name: string; size: number; mtime: number; kind: 'doc' | 'lyx' | 'bib' | 'image' | 'tex' | 'pdf' | 'board' | 'html' | 'dir' | 'other';
  /** an HTML file: the kind of deliverable it is (none: a plain web page) */
  deliverable?: 'deck' | 'poster' | 'page';
  /** a document that is an HTML article (core html/article.ts): kind 'doc', written in the document editor */
  format?: 'article';
  /** a directory that is a document group (core/docgroup.ts): its documents in order, their titles */
  group?: DocGroup;
}
export type Role = 'owner' | 'edit' | 'view';
export interface Project {
  /** the project's key, `<owner>/<name>` (core projectKey.ts): documents are `<key>/<path>`, the URL `#/<key>/<path>` */
  name: string; files: ProjectFile[];
  /** display name (the name without the owner otherwise) */
  title?: string | null;
  /** 'project' | 'example' (the personal welcome project) */
  kind?: string;
  role?: Role;
  /** how the user got access: owns it / shared with them / joined via link / opened it while public / administrator */
  via?: 'owner' | 'member' | 'link' | 'public' | 'admin';
  /** anyone may view it and clone it, without an account (Share ▸ Public) */
  public?: boolean;
  owner?: { id: number; name: string; username: string; avatar?: string | null } | null;
  /** when this user last opened the project (server clock), null: never */
  lastOpened?: number | null;
  /** the file this user was in last (a tab id: a document's, or `text:`/`pdf:` + a file's — app/lastfile.ts), null: none noted */
  lastFile?: string | null;
  /** who joined it besides the owner (server access.ts projectPeople): names and avatars, in the order they came */
  members?: ProjectPerson[];
  /** invitations to an address without an account yet */
  invited?: number;
}
export interface ProjectPerson { name: string; username: string; color: string; avatar: string | null; role: 'view' | 'edit'; via: string; since: number; guest: boolean }
export interface ShareMember { id: number; role: 'view' | 'edit'; via: string; /** via 'link': the share link they came in through (it may be off since) */ link?: string | null; email: string | null; user: { id: number; name: string; username: string; color: string; avatar: string | null } | null }
/** a zip import: `projects` lists every project the archive produced (several for an Overleaf bundle of zips), `errors` the ones that failed */
export interface ZipImportResult { ok: boolean; name: string; files: number; skipped: string[]; projects: { name: string; files: number; skipped: string[] }[]; errors: { name: string; error: string }[] }
export interface LyxImportResult { id: string; created: string[]; warnings: string[]; files: number; skipped: string[] }
/** a public PDF link of a document (Share dialog); the address is `/pdf/<token>/<fileName>` on this origin */
export interface PdfLinkInfo { doc: string; token: string; hits: number; lastHitAt: number | null; createdAt: number; fileName: string; built: boolean }
export const pdfLinkUrl = (l: { token: string; fileName: string }) => `${location.origin}/pdf/${l.token}/${encodeURIComponent(l.fileName)}`;
/** a document's PDF is committed into a GitHub repository after every successful build (administrators; the server's GITHUB_PUBLISH_TOKEN) */
export interface PdfPublishInfo { doc: string; repo: string; path: string; branch: string | null; lastPushedAt: number | null; lastAttemptAt: number | null; lastError: string | null; htmlUrl: string }
export interface PdfLinksInfo { docs: string[]; links: PdfLinkInfo[]; publish: PdfPublishInfo[]; publishAvailable: boolean }
/** a share link: its role is its own for good (another role is another link); `joined`: the people who came in through it */
export interface ShareLinkInfo { token: string; role: 'view' | 'edit'; createdAt: number; joined: number }
export interface ShareInfo { name?: string; title?: string | null; owner: { id: number; name: string; username: string } | null; members: ShareMember[]; links: ShareLinkInfo[];
  /** anyone may view it at its address and clone it, no account needed; `visitors`: who opened it so */
  public?: boolean; visitors?: number }
export interface LayoutInfo { name: string; category?: string; labelType?: string; tocLevel?: number; latexType?: string; latexName?: string; isNumbered?: boolean }
export interface TexHeading { level: number; text: string; n: number; num?: string; starred: boolean }
export interface SyncBox { page: number; x: number; y: number; h: number; v: number; W: number; H: number }
export interface BibItem { key: string; author: string; year: string; title: string }
export interface HealthIssue { code: string; message: string; severity: 'warning' | 'error'; fixable: boolean }
/** ProseMirror JSON (nodes of the editor schema) as the server returns them for AI proposals */
export interface PMJSON { type: string; attrs?: Record<string, any>; content?: PMJSON[]; marks?: { type: string; attrs?: Record<string, any> }[]; text?: string }
export interface AiModelInfo { id: string; label: string; note: string; /** Artificial Analysis Intelligence Index */ aa?: number; /** measured rewrite (⌘J) response time */ speed: string }
export interface AiStatus { available: boolean; model: string; completionModel: string; inkModel?: string; models: AiModelInfo[] }
/** the math keyboard's pen: the handwriting as a PNG data URL, the formula around the cursor */
export interface AiInkRequest { image: string; before?: string; after?: string; text?: boolean; /** handwritten notes (the lasso's Convert to text): text with $…$ math, not a formula */ notes?: boolean }
export interface AiRewriteRequest { instruction: string; content: PMJSON[]; layout?: string; before?: string; after?: string; model?: string; math?: { latex: string; display: boolean; selection?: string }; source?: { text: string; before?: string; after?: string }; history?: { instruction: string; tex: string }[] }
export interface AiRewriteResult { tex: string; nodes: PMJSON[]; original: string }
export interface AiCompleteRequest { kind: 'text' | 'math'; before: string; after: string; formula?: string; paragraph?: string; model?: string }
export interface AiCompleteResult { text: string; nodes: PMJSON[] }
/** two versions of a paragraph after an offline merge (editor/plugins/mergereview.ts): the current text and the offline author's */
export interface AiMergeRequest { current: PMJSON[]; offline: PMJSON[]; layout?: string; name: string; before?: string; after?: string }
/** one version made from both, by the account's own AI (`via`: its name) */
export interface AiMergeResult { tex: string; nodes: PMJSON[]; note: string; via: string }
export interface DocMeta {
  availableModules?: import('@overlyx/core').ModuleInfo[];
  /** what the file is written as (a markdown document offers only what markdown can hold, an HTML article what HTML can) */
  format?: 'tex' | 'markdown' | 'article';
  /** an HTML article: the custom properties its page sets at :root (editor/article.ts shows it in them) */
  article?: { vars: Record<string, string> };
  id: string; project: string; path: string; role?: Role; textclass: string; modules: string[]; language: string;
  useRefstyle: boolean; citeEngine: string; citeEngineType: string; trackingChanges: boolean; secnumdepth: number; tocdepth: number;
  /** number of entries in the bibliography (meta.bib only holds the cited ones when it is large) */
  bibTotal?: number;
  authors: { id: number; name: string; email?: string }[];
  macros: Record<string, { def: string; args: number; optional?: string; expand: boolean }>;
  macroList: { name: string; args: number; def: string; display?: string; source: string }[];
  bib: BibItem[]; layouts: LayoutInfo[] | null; flexInsets: string[] | null; files: ProjectFile[];
  master: string | null; labels: { name: string; context: string; file: string }[];
  /** the folders of the document's (its master's) \graphicspath, project-relative ('' or ending in '/'): figures are looked for there too */
  graphicsPath?: string[];
  /** structural damage found in the file on disk (an external edit broke an OverLyX convention) */
  health: HealthIssue[];
}
/** a folded heading (editor/plugins/fold.ts): its layout, text, and which of the equal headings it is */
export interface SavedFold { l: string; t: string; n: number }
export interface BuildJob { id: number; status: 'queued' | 'exporting' | 'compiling' | 'ok' | 'error' | 'cancelled'; engine: string; requestedBy: string; startedAt: number; phaseAt: number; finishedAt?: number; progress: string; rerun: boolean }
export interface BuildInfo { status: string; log: string; pdf: string | null; pdf_path: string | null; tex_path: string | null; updated_at: number; warnings: string[]; tex?: string; /** when the PDF file was written (server clock) */ pdf_at?: number | null; /** when that build read the document (server clock; null: an older build) */ source_at?: number | null }
export interface VersionInfo { id: number; name: string; author: string; kind: string; created_at: number; size: number }
export interface GitCommit { hash: string; author: string; date: number; message: string }
export interface GitInfo { url: string; username: string; role: Role; hasPassword: boolean; branch: string; commits: GitCommit[]; pending: number; pendingFiles: string[]; head: string | null }
export interface GitToken { id: number; name: string; created_at: number; last_used_at: number | null; expires_at?: number | null; /** the plaintext, present only for accounts with token re-copy enabled (Settings ▸ Account) */ token?: string; /** a credential narrowed at its authorization (Settings ▸ Account ▸ Fine-grained access); absent/null = the whole account */ scope?: CredentialScope | null }
/** what a narrowed credential reaches: these projects (null = all) and/or only reading */
export interface CredentialScope { projects: string[] | null; readonly: boolean }
/** Per-account server-side settings (Settings ▸ Account; userSettings.ts on the server). */
export interface UserSettings { allowRecopyTokens: boolean; fineGrainedAccess: boolean; paragraphSkip: boolean; interface: 'classic' | 'modern' | null }
export interface AdminUser { id: number; username: string; name: string; color: string; isAdmin: number; email: string | null; allowRecopyTokens: boolean }
/** the project's off-site mirror (a private repository in the instance's GitHub organisation) */
export interface MirrorStatus { configured: boolean; org: string | null; repo: string | null; url: string | null; enabled: boolean; head: string | null; lastHead: string | null; lastPushAt: number | null; lastAttemptAt: number | null; lastError: string | null; behind: boolean; intervalMs: number }
export type AccessAction = 'open' | 'build' | 'git-fetch' | 'git-push' | 'share' | 'admin-access' | 'write' | 'bib-add';
export interface ActivityEntry { id: number; action: AccessAction; detail: string | null; at: number; user: { id: number; name: string; username: string } | null }
export interface AdminProjectInfo { name: string; title: string | null; kind: string; owner: { id: number; name: string; username: string } | null; access: 'owner' | 'member' | 'granted' | null; grantUntil: number | null }

/** The embedded coding agent (agent.ts on the server): OpenAI Codex on the user's own ChatGPT account
 *  or OpenAI / OpenRouter key, Claude Code on their Anthropic key (agentkeys.ts) */
export type AgentProvider = 'chatgpt' | 'openai' | 'openrouter' | 'anthropic';
/** one provider of the account: signed in / a key kept (its last characters); `available`: offered on this server */
export interface AgentProviderStatus { connected: boolean; account?: { email: string | null; plan: string | null } | null; hint?: string | null; available?: boolean }
export interface AgentStatus {
  enabled: boolean;
  /** any provider connected */
  authenticated: boolean; method?: string | null;
  /** the ChatGPT sign-in's account */
  account?: { email: string | null; plan: string | null } | null;
  providers?: Partial<Record<AgentProvider, AgentProviderStatus>>;
}
export interface AgentLogin { loginId: string; verificationUrl: string; userCode: string }
/** one run of the off-site backup or its restore check, as its status file has it */
export interface BackupRun { ok: boolean; started: string; finished: string; snapshot?: string; added?: string; files?: string; note?: string }
export interface AgentThreadInfo { id: string; title: string | null; user: { id: number; name: string | null }; mine: boolean; createdAt: number; updatedAt: number; provider?: AgentProvider; model?: string | null }
export interface AgentChange { path: string; kind: string; diff: string }
/** one entry of a thread's transcript (codex's ThreadItem, loosely typed — we render known kinds) */
export interface AgentItem {
  type: string; id: string; text?: string; status?: string;
  content?: { type: string; text?: string }[];
  summary?: string[]; command?: string; cwd?: string; aggregatedOutput?: string | null; exitCode?: number | null;
  changes?: AgentChange[]; server?: string; tool?: string;
  /** (type 'toolCall', the Claude engine's other tools) what it was called on, and what came back */
  detail?: string; output?: string;
  /** (client-side, type 'overlyxCheckpoint') what the turn changed in the project — rendered as a checkpoint card */
  checkpoint?: AgentCheckpoint;
}
export interface AgentTurn { id: string; items: AgentItem[]; status: string; error?: { message?: string } | null }
/** what the Agent panel's agent may read: every project of the user (and shared with them), or only the thread's own (agent.ts panelThreadScope) */
export type AgentScope = 'all' | 'project';

/** a build of a document an agent turn changed, compared with its build before the change (agentwork.ts) */
export interface AgentBuildCheck { doc: string; status: 'building' | 'ok' | 'error'; before: 'ok' | 'error' | null; broke: boolean; errors: string[] }
/** what one agent turn changed in the project, and whether it was taken back (agentwork.ts Checkpoint) */
export interface AgentCheckpoint {
  n: number; turnId: string | null; startedAt: number; updatedAt: number; finished: boolean;
  files: { path: string; kind: 'doc' | 'file'; created?: boolean; inserted?: number; deleted?: number }[];
  builds: AgentBuildCheck[];
  undone: null | { at: number; by: number; kept: { path: string; why: string }[] };
}
/** one message of the agent events stream (SSE); kind 'checkpoint' carries { threadId, checkpoint } */
export interface AgentEventMsg { kind: 'notification' | 'request' | 'status' | 'checkpoint'; method?: string; params?: any; requestId?: string; running?: boolean }
export interface AgentTurnContext { docId?: string; content?: PMJSON[]; layout?: string; mathLatex?: string; openDocs?: string[] }
export interface AgentModel { id: string; label: string; description: string; efforts: string[]; defaultEffort: string | null; isDefault: boolean; /** where it runs (older servers: the ChatGPT sign-in) */ provider?: AgentProvider }
/** an agent connected over MCP from elsewhere (Claude Code, Codex, ChatGPT …; mcpAgents.ts on the server) */
export interface ExternalAgent {
  id: number; name: string; label: string; color: string;
  client: { name: string; version: string | null }; token: string;
  lastSeen: number; project: string | null; path: string | null; lastTool: string | null;
  /** listening: waiting for a message; working: has messages it has not answered; online: seen in the last minutes */
  status: 'listening' | 'working' | 'online' | 'offline';
  /** pushed messages (Claude Code channels): 'confirmed' once its channel delivered, 'possible' while a session stream is open */
  push: 'confirmed' | 'possible' | null;
  queued: number;
}
/** one message between the owner and an external agent: role 'user' from OverLyX, 'agent' its reply */
export interface ExternalAgentMessage {
  id: number; role: 'user' | 'agent'; text: string;
  /** user: queued → delivered → answered (or cancelled); agent: final | progress */
  state: string; via: 'poll' | 'push' | null; replyTo: number | null;
  createdAt: number; deliveredAt: number | null; pushedAt: number | null;
  context: { docId: string; text: string } | null;
}
/** the external-agents event stream (SSE): the list changed, or a message was added / changed */
export type ExternalAgentEvent = { kind: 'agents'; agents: ExternalAgent[] } | { kind: 'message'; agentId: number; message: ExternalAgentMessage };

/**
 * Base URL for the API. Empty in the web app (same origin); the VS Code extension's webview sets
 * `globalThis.OVERLYX_API_BASE` to its local bridge before importing this module.
 */
export const API_BASE: string = (globalThis as unknown as { OVERLYX_API_BASE?: string }).OVERLYX_API_BASE ?? '';

async function req<T>(method: string, url: string, body?: unknown, raw?: BodyInit, signal?: AbortSignal): Promise<T> {
  const action = apiInteraction(method, url), start = performance.now();
  let res: Response;
  try { res = await fetch(API_BASE + url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : raw instanceof Blob ? { 'content-type': raw.type || 'application/octet-stream' } : undefined,
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    credentials: 'same-origin',
    signal,
  }); } catch (e) {
    if (action) recordInteraction(action, signal?.aborted ? 'cancelled' : 'offline', { target: 'api', durationMs: performance.now() - start });
    throw e;
  }
  if (action) recordInteraction(action, requestOutcome(res.status), { target: 'api', durationMs: performance.now() - start });
  const text = await res.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) { const err = new Error(data.error ?? `${res.status} ${res.statusText}`) as Error & { status: number; data: any }; err.status = res.status; err.data = data; throw err; }
  return data as T;
}

export const encId = (id: string) => encodeURIComponent(id);

export interface GdocsLink { fileId: string; tabId: string | null; url: string; auto: boolean; lastSync: number | null; lastError: string | null; linkedBy: number; format: 'text' | 'docx'; warnings: string[] }
export interface GdocsStatus {
  configured: boolean; picker: boolean; account: { email: string | null } | null; link: GdocsLink | null; canEdit: boolean; guest: boolean;
  /** an unlinked document of a folder whose other documents are a Google Doc's tabs: that Google Doc, and its tabs nothing syncs with */
  folder?: { fileId: string; name: string; tabs: { id: string; title: string }[] } | null;
}
/** what Google's file picker needs (app/gpicker.ts); the e2e stub offers the simulated account's Google Docs */
/** a synced clone of the project working right now (server syncPeers.ts) — `host` only for the viewer's own */
export interface SyncClone { name: string; username: string; app: 'vscode' | 'cli' | 'other'; host: string | null; mine: boolean; since: number; lastSeen: number }
/** what keeps a document in step from elsewhere: synced clones of its project, its Google Docs and LessWrong links */
export interface ExternalSync {
  clones: SyncClone[];
  /** `account`: the linker's Google Drive authorisation is there; `mine`: the viewer linked it */
  google: { url: string; auto: boolean; lastSync: number | null; lastError: string | null; account: boolean; mine: boolean } | null;
  googleUnlinked?: boolean;
  /** `authUntil`: the linker's LessWrong authorisation (null: gone); `comments`: both ways; `syncing`: a sync under way */
  lesswrong?: { url: string; title: string | null; auto: boolean; lastSync: number | null; lastError: string | null; authUntil: number | null; comments: boolean; mine: boolean; syncing: LessWrongProgress | null };
}
/** a document's link to a LessWrong draft (server lesswrong/sync.ts publicLwLink) */
/** a LessWrong sync under way (server lesswrong/sync.ts LwProgress) */
export interface LessWrongProgress { phase: string; edits: number; round: number; since: number }
export interface LessWrongLink {
  postId: string; title: string | null; draft: boolean | null; url: string; comments: boolean; auto: boolean; lastSync: number | null; lastError: string | null; linkedBy: number; warnings: string[];
  authUntil: number | null; syncing: LessWrongProgress | null;
  lastReport: { at: number; pulled: number; pushed: number; comments: { fromLessWrong: number; toLessWrong: number }; warnings: number } | null;
}
export interface LessWrongStatus { account: { expiresAt: number } | null; link: LessWrongLink | null; canEdit: boolean; guest: boolean }
export interface LessWrongReport { pulled: number; pushed: number; rounds: number; comments: { fromLessWrong: number; toLessWrong: number }; warnings: string[]; notes: string[] }
export type GdocsPicker = { stub: true; files: { id: string; name: string }[] } | { stub?: false; apiKey: string; appId: string; token: string };
/** a front matter value of a markdown document (core md/typesetting.ts FMValue) */
export type MdFrontMatterValue = string | string[] | { [key: string]: MdFrontMatterValue };
export interface GdocsTab { id: string; title: string; level: number; parent: string | null }

/** keys of the projects the server listed for this user (a link naming one needs no resolveId) */
export const knownProjects = new Set<string>();

/** a paper found online, a paper link resolved, or an item of the account's Zotero library (server bibsearch.ts, citelinks.ts, zotero.ts) */
export interface LitHit { id: string; title: string; authors: string[]; year: number | null; venue: string; type: string; doi: string | null; arxiv: string | null; url: string | null; citations: number | null; sources: string[]; dblp?: string; bibtex?: string; note?: string }
/** the account's Zotero connection (server zotero.ts); the key itself never comes back */
export interface ZoteroStatus { connected: boolean; username?: string; libraries?: string[] }
/** `file`: the .bib that has the entry (in the project); `bib`: its name as the document lists it (beside the document) */
export interface BibAddResult { key: string; file: string; bib?: string; existed: boolean; copiedFrom?: string; bibtex: string; entry: BibItem }
export interface FeedbackInfo { version: string; errorReports: boolean }
/** a problem report, error record or mail for the administrators (server feedback.ts listReports) */
export interface AdminReport { id: number; kind: string; title: string; body: string; count: number; createdAt: number; lastAt: number; from: string | null }
/** what deleting the account erases (server accounts.ts deletionPreview) */
export interface DeletionPreview { owned: { project: string; title: string | null; people: number }[]; memberOf: number; refused: string | null }
export const api = {
  literatureSearch: (q: string) => req<{ hits: LitHit[]; sources: string[]; warnings: string[]; zotero?: boolean }>('GET', `/api/bib/search?q=${encodeURIComponent(q)}`),
  literatureSources: () => req<{ enabled: boolean; sources: string[]; zotero?: ZoteroStatus }>('GET', '/api/bib/sources'),
  zotero: () => req<ZoteroStatus>('GET', '/api/zotero'),
  connectZotero: (key: string) => req<ZoteroStatus>('POST', '/api/zotero', { key }),
  disconnectZotero: () => req<ZoteroStatus>('DELETE', '/api/zotero'),
  /** `doc`: the document it is for — the entry goes into the cited.bib beside it */
  bibAdd: (project: string, data: { hit?: LitHit; bibtex?: string; doc?: string }) => req<BibAddResult>('POST', `/api/projects/${encodeURIComponent(project)}/bib/add`, data),
  feedbackInfo: () => req<FeedbackInfo>('GET', '/api/feedback/info'),
  feedback: (data: { kind: 'bug' | 'idea' | 'question'; title: string; body: string; doc?: string | null; error?: string | null }) => req<{ id: number }>('POST', '/api/feedback', data),
  clientError: (data: { message: string; stack?: string | null }) => req<{ id: number | null }>('POST', '/api/client-error', data),
  /** a display glitch the app noticed (glitches.ts; measurements and fixed words only, core glitch.ts) */
  clientGlitch: (data: { kind: string; fields: Record<string, string | number>; trail: string[] }) => req<{ id: number | null }>('POST', '/api/client-glitch', data),
  /** the pen lab's answers (PenLab.tsx; server feedback.ts): the settings compared and what was chosen, the writing if ticked */
  inkLab: (data: Record<string, unknown>) => req<{ id: number }>('POST', '/api/ink-lab', data),
  accountDeletion: () => req<DeletionPreview>('GET', '/api/account/deletion'),
  /** administrators: problem reports, error records, mail to privacy@ / contact@ (server feedback.ts) */
  adminReports: (kind?: string) => req<{ reports: AdminReport[] }>('GET', `/api/admin/reports${kind ? `?kind=${encodeURIComponent(kind)}` : ''}`),
  deleteAdminReport: (id: number) => req<{ ok: boolean }>('DELETE', `/api/admin/reports/${id}`),
  /** answer mail to privacy@ / contact@ from that address (server feedback.ts answerMail) */
  answerAdminReport: (id: number, text: string) => req<{ ok: boolean; to: string; from: string }>('POST', `/api/admin/reports/${id}/answer`, { text }),
  deleteAccount: (confirm: string) => req<{ ok: boolean; projects: string[] }>('POST', '/api/account/delete', { confirm }),
  me: () => req<{ user: User | null; google: boolean; signup?: 'open' | 'invited' }>('GET', '/api/auth/me'),
  login: (username: string, password: string) => req<{ user: User }>('POST', '/api/auth/login', { username, password }),
  logout: () => req<{ ok: boolean }>('POST', '/api/auth/logout'),
  projects: () => req<{ projects: Project[] }>('GET', '/api/projects').then(r => { for (const p of r.projects) knownProjects.add(p.name); noteProjectFiles(r.projects); return r; }),
  createProject: (name: string) => req<{ project: Project }>('POST', '/api/projects', { name }),
  /** the current id of a document (or project) an old link names — before projects lived in their owner's namespace */
  resolveId: (id: string) => req<{ id: string }>('GET', `/api/resolve?id=${encodeURIComponent(id)}`),
  resolveIds: (ids: string[]) => req<{ ids: Record<string, string> }>('POST', '/api/resolve', { ids }),
  /** Overleaf import: clone the selected projects with the user's Overleaf Git token (per-project results), or unpack a downloaded zip */
  importOverleaf: (body: { token: string; projects: { id: string; name: string }[] }) => req<{ results: { id: string; name: string; ok: boolean; error?: string }[] }>('POST', '/api/import/overleaf', body),
  importZip: (name: string, file: Blob) => req<ZipImportResult>('POST', `/api/import/zip?name=${encodeURIComponent(name)}`, undefined, file),
  importLyxProject: (name: string, file: File) => req<LyxImportResult & { ok: boolean; name: string }>('POST', `/api/import/lyx?name=${encodeURIComponent(name)}&filename=${encodeURIComponent(file.name)}`, undefined, file),
  uploadLyx: (project: string, file: File, dir = '') => req<LyxImportResult>('POST', `/api/projects/${encodeURIComponent(project)}/import-lyx?filename=${encodeURIComponent(file.name)}&dir=${encodeURIComponent(dir)}`, undefined, file),
  // public PDF links (owner only): a stable address that serves a document's latest build to anyone
  pdfLinks: (project: string) => req<PdfLinksInfo>('GET', `/api/projects/${encodeURIComponent(project)}/pdf-links`),
  setPdfPublish: (project: string, body: { doc: string; repo: string; path: string; branch?: string | null }) => req<{ publish: PdfPublishInfo[] }>('POST', `/api/projects/${encodeURIComponent(project)}/pdf-publish`, body),
  pushPdfPublish: (project: string, doc: string) => req<{ publish: PdfPublishInfo[] }>('POST', `/api/projects/${encodeURIComponent(project)}/pdf-publish/push`, { doc }),
  deletePdfPublish: (project: string, doc: string) => req<{ publish: PdfPublishInfo[] }>('DELETE', `/api/projects/${encodeURIComponent(project)}/pdf-publish/${encodeURIComponent(doc)}`),
  createPdfLink: (project: string, doc: string) => req<{ link: PdfLinkInfo; links: PdfLinkInfo[] }>('POST', `/api/projects/${encodeURIComponent(project)}/pdf-links`, { doc }),
  deletePdfLink: (project: string, token: string) => req<{ ok: boolean; links: PdfLinkInfo[] }>('DELETE', `/api/projects/${encodeURIComponent(project)}/pdf-links/${encodeURIComponent(token)}`),
  deleteProject: (name: string) => req<{ ok: boolean }>('DELETE', `/api/projects/${encodeURIComponent(name)}`),
  // sharing (owner only)
  share: (project: string) => req<ShareInfo>('GET', `/api/projects/${encodeURIComponent(project)}/share`),
  addMember: (project: string, who: string, role: 'view' | 'edit') => req<{ member: ShareMember; share: ShareInfo }>('POST', `/api/projects/${encodeURIComponent(project)}/share/members`, { who, role }),
  setMemberRole: (project: string, id: number, role: 'view' | 'edit') => req<{ share: ShareInfo }>('POST', `/api/projects/${encodeURIComponent(project)}/share/members/${id}`, { role }),
  removeMember: (project: string, id: number) => req<{ share: ShareInfo }>('DELETE', `/api/projects/${encodeURIComponent(project)}/share/members/${id}`),
  createLink: (project: string, role: 'view' | 'edit') => req<{ link: ShareLinkInfo; share: ShareInfo }>('POST', `/api/projects/${encodeURIComponent(project)}/share/links`, { role }),
  /** turn a share link off; `remove`: the people who came in through it lose their access too */
  revokeLink: (project: string, token: string, remove: boolean) => req<{ share: ShareInfo }>('DELETE', `/api/projects/${encodeURIComponent(project)}/share/links/${encodeURIComponent(token)}${remove ? '?remove=1' : ''}`),
  setPublic: (project: string, on: boolean) => req<{ share: ShareInfo }>('POST', `/api/projects/${encodeURIComponent(project)}/share/public`, { public: on }),
  setOwner: (project: string, username: string) => req<{ share: ShareInfo }>('POST', `/api/projects/${encodeURIComponent(project)}/share/owner`, { username }),
  /**
   * what a share link opens, joining nothing (the page that asks a visitor without a session how to
   * come in: app/Guest.tsx ShareInvite); `guests`: whether coming in without an account is possible
   */
  sharePreview: (token: string) => req<{ project: string; title: string | null; owner: string | null; role: Role; guests: boolean }>('GET', `/api/share/${encodeURIComponent(token)}`),
  /**
   * open a share link (#/share/<token>[/<path>]): join the project; `doc` is its main document, `file`
   * the linked file when the project has it. Without a session the server opens a guest session and
   * returns its `user`, named `name` when the visitor gave one ("Ada (guest)") or else "Anonymous Otter".
   */
  acceptShare: (token: string, path?: string | null, name?: string) => req<{ project: string; title: string | null; role: Role; doc: string | null; file: Pick<ProjectFile, 'path' | 'name' | 'kind'> | null; user?: User }>('POST', `/api/share/${encodeURIComponent(token)}/accept${path ? '?path=' + encodeURIComponent(path) : ''}`, name ? { name } : undefined),
  /**
   * open a project at its address: a public one puts it on the visitor's list (and lets a visitor
   * without a session in as a guest: `user`); 404 when it is not public and not theirs
   */
  visitPublic: (project: string, path?: string | null) => req<{ project: string; title: string | null; role: Role; doc: string | null; file: Pick<ProjectFile, 'path' | 'name' | 'kind'> | null; user?: User; public: boolean }>('POST', `/api/public/${encodeURIComponent(project)}/visit${path ? '?path=' + encodeURIComponent(path) : ''}`),
  // git: every project is a repository (clone URL, history); the account token is the HTTPS password
  gitInfo: (project: string) => req<GitInfo>('GET', `/api/projects/${encodeURIComponent(project)}/git`),
  gitRestore: (project: string, commit: string) => req<{ restored: boolean; files: string[] } & Omit<GitInfo, 'url' | 'username' | 'role' | 'hasPassword'>>('POST', `/api/projects/${encodeURIComponent(project)}/git/restore`, { commit }),
  gitCommit: (project: string, message?: string) => req<{ committed: boolean } & Omit<GitInfo, 'url' | 'username' | 'role' | 'hasPassword'>>('POST', `/api/projects/${encodeURIComponent(project)}/git/commit`, message ? { message } : {}),
  mirrorStatus: (project: string) => req<MirrorStatus>('GET', `/api/projects/${encodeURIComponent(project)}/mirror`),
  mirrorUpdate: (project: string, body: { enabled?: boolean; now?: boolean }) => req<MirrorStatus>('POST', `/api/projects/${encodeURIComponent(project)}/mirror`, body),
  /** the owner's activity log of a project */
  activity: (project: string, limit = 50) => req<{ entries: ActivityEntry[] }>('GET', `/api/projects/${encodeURIComponent(project)}/activity?limit=${limit}`),
  // administration: every project, and a logged, time-limited grant to open one
  adminProjects: () => req<{ projects: AdminProjectInfo[] }>('GET', '/api/admin/projects'),
  adminAccess: (project: string, minutes = 60) => req<{ until: number }>('POST', `/api/admin/projects/${encodeURIComponent(project)}/access`, { minutes }),
  gitTokens: () => req<{ tokens: GitToken[] }>('GET', '/api/git/tokens'),
  rotateGitToken: () => req<{ id: number; token: string; tokens: GitToken[] }>('POST', '/api/git/tokens'),
  deleteGitToken: (id: number) => req<{ tokens: GitToken[] }>('DELETE', `/api/git/tokens/${id}`),
  /** the signed-in account's server-side settings; administrators switch them per user */
  settings: () => req<{ settings: UserSettings }>('GET', '/api/settings'),
  /** the account's custom keyboard shortcuts (keybindings.ts syncs them) */
  /** the user's folded sections of a document (editor/plugins/fold.ts), kept with the account */
  folds: (id: string) => req<{ folds: SavedFold[]; at: number }>('GET', `/api/docs/${encId(id)}/folds`),
  setFolds: (id: string, folds: SavedFold[], at: number) => req<{ folds: SavedFold[]; at: number }>('PUT', `/api/docs/${encId(id)}/folds`, { folds, at }),
  /** where the user was in a document: a deck's slide (deliverable/slidememory.ts) */
  place: (id: string) => req<{ slide: number | null; at: number }>('GET', `/api/docs/${encId(id)}/place`),
  setPlace: (id: string, slide: number, at: number) => req<{ slide: number | null; at: number }>('PUT', `/api/docs/${encId(id)}/place`, { slide, at }),
  /** a file shown in the text editor or the PDF viewer (they keep no connection that would say so): its project reopens on it */
  markOpened: (id: string, view: 'text' | 'pdf') => req<{ ok: boolean }>('PUT', `/api/docs/${encId(id)}/opened`, { view }),
  keys: () => req<{ keys: Record<string, string | null> }>('GET', '/api/keys'),
  setKeys: (keys: Record<string, string | null>) => req<{ keys: Record<string, string | null> }>('POST', '/api/keys', { keys }),
  setSettings: (patch: { fineGrainedAccess?: boolean; paragraphSkip?: boolean; interface?: 'classic' | 'modern' }) => req<{ settings: UserSettings }>('POST', '/api/settings', patch),
  adminUserSettings: (id: number, patch: Partial<UserSettings>) => req<{ settings: UserSettings }>('POST', `/api/admin/users/${id}/settings`, patch),
  mcpTokens: () => req<{ tokens: GitToken[] }>('GET', '/api/mcp-tokens'),
  deleteMcpToken: (id: number) => req<{ tokens: GitToken[] }>('DELETE', `/api/mcp-tokens/${id}`),
  newDoc: (project: string, path: string, opts: { title?: string; textclass?: string; /** a layout document from this page preset (core PAGE_PRESETS) */ layout?: string } = {}) => req<{ id: string }>('POST', `/api/projects/${encodeURIComponent(project)}/new`, { path, ...opts }),
  /** plain text files (.tex, .bib, …) for the built-in text editor; `mtime` guards against overwriting someone else's save */
  /** a new HTML deliverable (deck / poster / web page): the folder `dir` with its index.html */
  /** `template` "blank" with `size`: an empty deck of that page size (core blankDeck) */
  newDeliverable: (project: string, dir: string, kind: 'deck' | 'poster' | 'page', title?: string, template?: string, size?: PageSize) => req<{ id: string; path: string }>('POST', `/api/projects/${encodeURIComponent(project)}/deliverables`, { dir, kind, title, template, size }),
  /** the sandboxed address of a deliverable's folder (server deliverables.ts) */
  deliverableLink: async (project: string, path: string) => {
    const url = `/api/projects/${encodeURIComponent(project)}/deliverable-link?path=${encodeURIComponent(path)}`;
    let network = false;
    const link = await offlineGet(API_BASE + url, async () => { const value = await req<{ base: string; entry: string; expires: number }>('GET', url); network = true; return value; });
    // A cached folder identifies this account's local copy; no server token is
    // used for an offline srcdoc, so its old expiry must not block local opening.
    return network ? link : { ...link, expires: 0 };
  },
  readText: (project: string, path: string) => req<{ text: string; mtime: number; size: number; role: Role }>('GET', `/api/projects/${encodeURIComponent(project)}/text/${path.split('/').map(encodeURIComponent).join('/')}`),
  writeText: (project: string, path: string, text: string, mtime?: number) => req<{ ok: boolean; mtime: number; size: number }>('PUT', `/api/projects/${encodeURIComponent(project)}/text/${path.split('/').map(encodeURIComponent).join('/')}`, mtime !== undefined ? { text, mtime } : { text }),
  upload: (project: string, path: string, file: Blob, opts?: { overwrite?: boolean }) => req<{ ok: boolean; path: string }>('POST', `/api/projects/${encodeURIComponent(project)}/upload?path=${encodeURIComponent(path)}${opts?.overwrite === false ? '&overwrite=0' : ''}`, undefined, file),
  fileOp: (project: string, body: { op: 'rename' | 'delete' | 'mkdir' | 'copy'; from?: string; to?: string }) => req<{ ok: boolean }>('POST', `/api/projects/${encodeURIComponent(project)}/fileops`, body),
  meta: (id: string) => {
    const url = `/api/docs/${encId(id)}/meta`;
    return offlineGet(API_BASE + url, () => req<DocMeta>('GET', url));
  },
  /** the document's LaTeX source (what its .tex file contains) */
  texText: (id: string) => fetch(`${API_BASE}/api/docs/${encId(id)}/tex`).then(async r => { if (!r.ok) throw Object.assign(new Error(`${r.status} ${r.statusText}`), { status: r.status }); return r.text(); }),
  /** the LaTeX source with its source map: the character range of every top-level paragraph (null: the server has none) */
  texMap: (id: string) => req<{ text: string; spans: ({ start: number; end: number } | null)[] | null }>('GET', `/api/docs/${encId(id)}/tex?map=1`),
  /** replace the document by hand-edited LaTeX source */
  applySource: (id: string, text: string) => req<{ ok: boolean; warnings: string[] }>('POST', `/api/docs/${encId(id)}/source`, { text }),
  /** a local copy kept by an editor of the CRDT's old model (its whole Yjs state): what it has that the server lacks is merged in (editor/legacycopy.ts) */
  legacyMerge: (id: string, state: Uint8Array) => req<{ merged: boolean; reason?: string }>('POST', `/api/docs/${encId(id)}/legacy-merge`, undefined, new Blob([state as unknown as BlobPart], { type: 'application/octet-stream' })),
  /** parse pasted LaTeX in the document's context: ProseMirror block JSON to insert */
  parseClip: (id: string, latex: string) => req<{ blocks: unknown[]; warnings: string[] }>('POST', `/api/docs/${encId(id)}/clip`, { latex }),
  header: (id: string) => req<{ headerLines: string[] }>('GET', `/api/docs/${encId(id)}/header`),
  /** convert a .lyx file of the project (and its children) to .tex documents */
  importLyx: (project: string, path: string) => req<{ id: string; created: string[]; warnings: string[]; graphics: { src: string; dest: string; ok: boolean; error?: string }[] }>('POST', `/api/projects/${encodeURIComponent(project)}/import`, { path }),
  save: (id: string) => req<{ ok: boolean }>('POST', `/api/docs/${encId(id)}/save`),
  /** a markdown document's front matter keys (core md/typesetting.ts) and the font pairs offered */
  mdFrontMatter: (id: string) => req<{ vars: Record<string, MdFrontMatterValue>; fonts: { label: string; main: string; math: string; hint: string }[] }>('GET', `/api/docs/${encId(id)}/frontmatter`),
  /** set front matter keys (null takes one out); the document's settings follow */
  setMdFrontMatter: (id: string, set: Record<string, unknown>) => req<{ ok: boolean; vars: Record<string, MdFrontMatterValue>; headerLines: string[] }>('POST', `/api/docs/${encId(id)}/frontmatter`, { set }),
  setHeader: (id: string, body: { headerLines?: string[]; preamble?: string; set?: Record<string, string> }) => req<{ ok: boolean; headerLines: string[] }>('POST', `/api/docs/${encId(id)}/header`, body),
  /** Mend mechanically-fixable structural damage (managed-block markers); returns what was fixed and what remains. */
  repair: (id: string) => req<{ fixed: string[]; remaining: HealthIssue[] }>('POST', `/api/docs/${encId(id)}/repair`),
  /** "Escalate to AI…": asks OpenRouter to propose a fix; nothing is applied yet. */
  aiRepair: (id: string) => req<{ original: string; proposed: string; issues: HealthIssue[] }>('POST', `/api/docs/${encId(id)}/ai-repair`),
  /** Apply an AI-proposed fix once approved in the merge editor. */
  applyAiRepair: (id: string, original: string, proposed: string) => req<{ ok: true; remaining: HealthIssue[] }>('POST', `/api/docs/${encId(id)}/ai-repair/apply`, { original, proposed }),
  /** AI assistance (ai.ts on the server): availability, ⌘J rewrite, autocomplete */
  aiStatus: () => req<AiStatus>('GET', '/api/ai/status'),
  aiRewrite: (id: string, body: AiRewriteRequest, signal?: AbortSignal) => req<AiRewriteResult>('POST', `/api/docs/${encId(id)}/ai/rewrite`, body, undefined, signal),
  aiComplete: (id: string, body: AiCompleteRequest, signal?: AbortSignal) => req<AiCompleteResult>('POST', `/api/docs/${encId(id)}/ai/complete`, body, undefined, signal),
  aiInk: (body: AiInkRequest, signal?: AbortSignal) => req<{ candidates: string[] }>('POST', '/api/ai/ink', body, undefined, signal),
  /** the account's own AI (server linkedai.ts: the Agent panel's ChatGPT sign-in, or a listening MCP agent): its name, null when none is linked */
  aiLinked: () => req<{ via: string | null }>('GET', '/api/ai/linked'),
  aiMerge: (id: string, body: AiMergeRequest, signal?: AbortSignal) => req<AiMergeResult>('POST', `/api/docs/${encId(id)}/ai/merge`, body, undefined, signal),
  /** the embedded coding agent (Agent panel; agent.ts on the server) */
  agentStatus: () => req<AgentStatus>('GET', '/api/agent/status'),
  /** administrators: the off-site backup's and its restore check's last runs (scripts/backup-offsite.sh, backup-check.sh) */
  adminBackups: () => req<{ configured: boolean; backup: BackupRun | null; check: BackupRun | null }>('GET', '/api/admin/backups'),
  agentLogin: () => req<AgentLogin>('POST', '/api/agent/login'),
  agentLoginCancel: (loginId: string) => req<{ ok: boolean }>('POST', '/api/agent/login/cancel', { loginId }),
  agentLogout: () => req<{ ok: boolean }>('POST', '/api/agent/logout'),
  /** an API key for the panel: the server checks it with the provider and keeps it for the account */
  agentSetKey: (provider: Exclude<AgentProvider, 'chatgpt'>, key: string) => req<{ ok: boolean; hint: string }>('PUT', `/api/agent/keys/${provider}`, { key }),
  agentRemoveKey: (provider: Exclude<AgentProvider, 'chatgpt'>) => req<{ ok: boolean }>('DELETE', `/api/agent/keys/${provider}`),
  agentThreads: (project: string) => req<{ threads: AgentThreadInfo[] }>('GET', `/api/projects/${encodeURIComponent(project)}/agent/threads`),
  agentStartThread: (project: string, scope?: AgentScope, provider?: AgentProvider, model?: string) => req<{ id: string; model: string | null; scope: AgentScope; provider?: AgentProvider }>('POST', `/api/projects/${encodeURIComponent(project)}/agent/threads`, { scope, provider, model }),
  agentThread: (project: string, tid: string) => req<{ thread: { id: string; turns: AgentTurn[] }; mine: boolean; approvals?: { requestId: string; method: string; params: unknown }[]; checkpoints?: AgentCheckpoint[]; scope?: AgentScope; provider?: AgentProvider; model?: string | null }>('GET', `/api/projects/${encodeURIComponent(project)}/agent/threads/${encodeURIComponent(tid)}`),
  /** what the thread's agent may read through the MCP tools: all the user's projects, or only this one */
  agentSetScope: (project: string, tid: string, scope: AgentScope) => req<{ ok: boolean; scope: AgentScope }>('POST', `/api/projects/${encodeURIComponent(project)}/agent/threads/${encodeURIComponent(tid)}/scope`, { scope }),
  agentUndo: (project: string, tid: string, n: number) => req<{ ok: boolean; checkpoint: AgentCheckpoint; reverted: string[]; kept: { path: string; why: string }[] }>('POST', `/api/projects/${encodeURIComponent(project)}/agent/threads/${encodeURIComponent(tid)}/checkpoints/${n}/undo`),
  agentModels: () => req<{ models: AgentModel[] }>('GET', '/api/agent/models'),
  agentTurn: (project: string, tid: string, body: { text: string; context?: AgentTurnContext; model?: string; effort?: string; clientMessageId?: string; /** false: the turn's document edits go in without tracked-change marks */ tracked?: boolean; scope?: AgentScope }) => req<{ ok: boolean }>('POST', `/api/projects/${encodeURIComponent(project)}/agent/threads/${encodeURIComponent(tid)}/turn`, body),
  agentSteer: (project: string, tid: string, turnId: string, text: string, clientMessageId?: string, context?: AgentTurnContext) => req<{ ok: boolean }>('POST', `/api/projects/${encodeURIComponent(project)}/agent/threads/${encodeURIComponent(tid)}/steer`, { turnId, text, clientMessageId, context }),
  agentApprove: (project: string, tid: string, requestId: string, decision: string) => req<{ ok: boolean }>('POST', `/api/projects/${encodeURIComponent(project)}/agent/threads/${encodeURIComponent(tid)}/approval`, { requestId, decision }),
  agentInterrupt: (project: string, tid: string, turnId: string) => req<{ ok: boolean }>('POST', `/api/projects/${encodeURIComponent(project)}/agent/threads/${encodeURIComponent(tid)}/interrupt`, { turnId }),
  /** agents connected over MCP from elsewhere, and the owner's messages to them */
  externalAgents: () => req<{ agents: ExternalAgent[] }>('GET', '/api/mcp-agents'),
  externalAgentMessages: (id: number) => req<{ agent: ExternalAgent; messages: ExternalAgentMessage[] }>('GET', `/api/mcp-agents/${id}/messages`),
  externalAgentSend: (id: number, text: string, context?: AgentTurnContext) => req<{ message: ExternalAgentMessage }>('POST', `/api/mcp-agents/${id}/messages`, { text, context }),
  externalAgentCancel: (id: number, mid: number) => req<{ message: ExternalAgentMessage }>('POST', `/api/mcp-agents/${id}/messages/${mid}/cancel`),
  externalAgentForget: (id: number) => req<{ ok: boolean }>('DELETE', `/api/mcp-agents/${id}`),
  versions: (id: string) => req<{ versions: VersionInfo[] }>('GET', `/api/docs/${encId(id)}/versions`),
  /** `lyx`: explicit content (e.g. offline edits that could not be merged) instead of the current server state */
  createVersion: (id: string, name: string, lyx?: string) => req<{ id: number }>('POST', `/api/docs/${encId(id)}/versions`, lyx !== undefined ? { name, lyx } : { name }),
  getVersion: (id: string, vid: number) => req<{ lyx: string; name: string; created_at: number; author: string }>('GET', `/api/docs/${encId(id)}/versions/${vid}`),
  restoreVersion: (id: string, vid: number) => req<{ ok: boolean }>('POST', `/api/docs/${encId(id)}/versions/${vid}/restore`),
  deleteVersion: (id: string, vid: number) => req<{ ok: boolean }>('DELETE', `/api/docs/${encId(id)}/versions/${vid}`),
  /** the entries of `keys` in a document's bibliography (with their fields: decks render citations from them) */
  bibKeys: (id: string, keys: string[]) => req<{ entries: (BibItem & { type?: string; fields?: Record<string, string>; authorShort?: string })[] }>('GET', `/api/docs/${encId(id)}/bib?keys=${encodeURIComponent(keys.join(','))}`),
  bibSearch: (id: string, q: string, limit = 100) => req<{ entries: BibItem[]; total: number; matches: number }>('GET', `/api/docs/${encId(id)}/bib?q=${encodeURIComponent(q)}&limit=${limit}`),
  /** LaTeX export (returns the source) or a PDF build request (a background job; poll `build`) */
  /** a web page (a deliverable) made an article: written in the document editor from now on */
  asArticle: (id: string) => req<{ ok: boolean; id: string }>('POST', `/api/docs/${encId(id)}/as-article`),
  export: (id: string, format: 'pdf' | 'tex', opts: { auto?: boolean } = {}) => req<{ ok: boolean; log?: string; warnings?: string[]; pdf?: string | null; tex?: string; job?: BuildJob }>('POST', `/api/docs/${encId(id)}/export`, { format, ...(opts.auto ? { auto: true } : {}) }),
  cancelBuild: (id: string) => req<{ ok: boolean }>('POST', `/api/docs/${encId(id)}/export/cancel`),
  /** SyncTeX: the PDF boxes (points, origin top-left) of a 1-based line of the built .tex; inverse: the source line under a PDF point. */
  /** headings of a document from its file (the document panel's outline of documents that are not open) */
  docOutline: (id: string) => req<{ headings: TexHeading[]; mtime: number }>('GET', `/api/docs/${encId(id)}/outline`),
  synctexView: (id: string, line: number) => req<{ boxes: SyncBox[] }>('GET', `/api/docs/${encId(id)}/synctex/view?line=${line}`),
  /** the Pages view: where the last build's pages begin in the built .tex, with their geometry (core pagebreaks.ts); null before a build */
  synctexPages: (id: string) => req<{ breaks: PageBreaks | null }>('GET', `/api/docs/${encId(id)}/synctex/pages`),
  synctexEdit: (id: string, page: number, x: number, y: number) => req<{ file?: string; line: number | null; column?: number }>('GET', `/api/docs/${encId(id)}/synctex/edit?page=${page}&x=${x.toFixed(2)}&y=${y.toFixed(2)}`),
  /** a layout document's text boxes as TeX set them in the last build (the editor's check against the PDF) */
  layoutCheck: (id: string) => req<LayoutCheck>('GET', `/api/docs/${encId(id)}/layoutcheck`),
  // the Google Docs sync (server gdocs/)
  externalSync: (id: string) => req<ExternalSync>('GET', `/api/docs/${encId(id)}/external`),
  gdocsStatus: (id: string) => req<GdocsStatus>('GET', `/api/gdocs/status?doc=${encId(id)}`),
  gdocsLink: (id: string, title: string) => req<{ link: GdocsLink }>('POST', `/api/docs/${encId(id)}/gdocs/link`, { title }),
  /** link the document to a Google Doc that exists (picked): its differences come in as tracked changes */
  /** `keep` 'ours': this document's text replaces the Google Doc's (tab's); 'merge': the Google Doc's differences come in as tracked changes */
  gdocsLinkExisting: (id: string, fileId: string, tabId: string | null, keep: 'merge' | 'ours' = 'merge') => req<{ link: GdocsLink }>('POST', `/api/docs/${encId(id)}/gdocs/link`, { fileId, tabId, keep }),
  /** the account's Drive connection, without a document */
  gdocsAccount: () => req<GdocsStatus>('GET', '/api/gdocs/status'),
  gdocsPicker: () => req<GdocsPicker>('GET', '/api/gdocs/picker'),
  gdocsFile: (fileId: string) => req<{ id: string; name: string; tabs: GdocsTab[] }>('GET', `/api/gdocs/file?id=${encodeURIComponent(fileId)}`),
  /** a picked Google Doc into the project: a document, or a document group of its tabs (the first document to open) */
  gdocsImport: (project: string, fileId: string, dir: string, sync = true) => req<{ id: string; docs: string[]; group: string | null }>('POST', `/api/projects/${encodeURIComponent(project)}/gdocs/import`, { fileId, dir, sync }),
  gdocsSync: (id: string) => req<{ link: GdocsLink; report: { pulled: number; pushed: number; comments: { fromGoogle: number; toGoogle: number }; warnings: string[]; notes: string[] } }>('POST', `/api/docs/${encId(id)}/gdocs/sync`),
  gdocsAuto: (id: string, auto: boolean) => req<{ link: GdocsLink }>('POST', `/api/docs/${encId(id)}/gdocs/auto`, { auto }),
  gdocsUnlink: (id: string) => req<{ ok: boolean }>('POST', `/api/docs/${encId(id)}/gdocs/unlink`),
  gdocsDisconnect: () => req<{ ok: boolean }>('POST', '/api/gdocs/disconnect'),
  // the LessWrong sync (server lesswrong/)
  lwStatus: (id: string) => req<LessWrongStatus>('GET', `/api/lesswrong/status?doc=${encId(id)}`),
  /** link to the draft `url` names; `keep` when both hold text: 'ours' replaces the draft's, 'merge' brings its differences as tracked changes */
  lwLink: (id: string, url: string, keep: 'ours' | 'merge') => req<{ link: LessWrongLink }>('POST', `/api/docs/${encId(id)}/lesswrong/link`, { url, keep }),
  /** the draft's link-sharing address (its comment threads then sync both ways) */
  lwKey: (id: string, url: string) => req<{ link: LessWrongLink }>('POST', `/api/docs/${encId(id)}/lesswrong/key`, { url }),
  /** `report` null: the sync runs on (the link's `syncing`) */
  lwSync: (id: string) => req<{ link: LessWrongLink; report: LessWrongReport | null }>('POST', `/api/docs/${encId(id)}/lesswrong/sync`),
  lwAuto: (id: string, auto: boolean) => req<{ link: LessWrongLink }>('POST', `/api/docs/${encId(id)}/lesswrong/auto`, { auto }),
  lwUnlink: (id: string) => req<{ ok: boolean }>('POST', `/api/docs/${encId(id)}/lesswrong/unlink`),
  lwDisconnect: () => req<{ ok: boolean }>('POST', '/api/lesswrong/disconnect'),
  build: (id: string, withTex = false) => req<{ build: BuildInfo | null; job: BuildJob | null; /** the server's clock */ now?: number }>('GET', `/api/docs/${encId(id)}/build${withTex ? '?tex=1' : ''}`),
  users: () => req<{ users: AdminUser[] }>('GET', '/api/users'),
  createUser: (username: string, name: string, password?: string) => req<{ user: User; password: string }>('POST', '/api/users', { username, name, password }),
};

/** Files that open in the built-in text editor (everything else that is not a document opens in a browser tab): core projectKey.ts. */
export { isTextFile };
/** The tab a project file opens in (`#/<id>`): documents as they are, PDFs in the viewer, text files in the text editor; null for files that open elsewhere (LyX files are imported, images in a browser tab). */
export function fileTabId(project: string, f: Pick<ProjectFile, 'path' | 'name' | 'kind'>): string | null {
  const id = `${project}/${f.path}`;
  if (f.kind === 'doc' || f.kind === 'board' || f.kind === 'html') return id;
  if (f.kind === 'pdf') return 'pdf:' + id;
  return f.kind !== 'lyx' && isTextFile(f.name) ? 'text:' + id : null;
}
const AUX_EXTS = new Set(['olx', 'olsrc', 'aux', 'log', 'bbl', 'blg', 'fls', 'fdb_latexmk', 'out', 'toc', 'lof', 'lot', 'nav', 'snm', 'bcf', 'dvi', 'xdv', 'spl', 'idx', 'ind', 'ilg', 'glo', 'gls', 'glg', 'acn', 'acr', 'alg', 'ist', 'loa', 'lol', 'thm', 'vrb', 'xcp', 'upa', 'upb', 'synctex']);
/** LaTeX build products — hidden in the file browser unless "all files" is on. */
export function isAuxFile(name: string): boolean {
  const base = (name.split('/').pop() ?? name).toLowerCase();
  if (base.endsWith('.synctex.gz') || base.endsWith('.run.xml')) return true;
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : '';
  return AUX_EXTS.has(ext);
}

/** `alt`: where else the file may be (project-relative, tried in order when `path` is missing — the \graphicspath folders: editor/context.ts figureUrl) */
export function graphicsUrl(project: string, path: string, w = 1200, alt: string[] = []): string {
  // Encode the whole path so the browser cannot consume ../ segments before the host resolves it.
  return `${API_BASE}/api/projects/${encodeURIComponent(project)}/graphics/${encodeURIComponent(path)}?w=${w}${alt.map(a => '&alt=' + encodeURIComponent(a)).join('')}`;
}
export function fileUrl(project: string, path: string): string {
  return `${API_BASE}/api/projects/${encodeURIComponent(project)}/file/${encodeURIComponent(path)}`;
}
/** The whole project as a downloadable .zip (the project card's "Download" and the Git dialog). */
export function zipUrl(project: string, format?: 'lyx'): string {
  return `${API_BASE}/api/projects/${encodeURIComponent(project)}/zip${format ? '?format=lyx' : ''}`;
}
