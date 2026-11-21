/** Types of what overlyx.js exports for the VS Code extension, which bundles its sync engine (packages/vscode/src/host/sync.ts). */

export interface SyncChanges {
  sent: { path: string; deleted?: boolean; status?: string; conflicts?: number }[];
  received: { path: string; deleted?: boolean; from?: string }[];
  conflicts: { path: string; kind: 'copy' | 'restored' | 'tracked'; copy?: string; count?: number; at?: number }[];
  waiting: string[];
  notSent: string[];
  /** changed here by git back to the commit's version (stash, reset --hard, checkout -- .): not sent */
  held: string[];
  errors: { path: string; error: string }[];
}

export interface SyncStatus {
  /** idle: in step; paused: the engine waits (another process, another branch, git busy) — `message` says why */
  state: 'idle' | 'syncing' | 'paused' | 'offline' | 'error' | 'signin';
  /** why a paused engine waits: another engine syncs the clone (it is in step), another branch, git busy, an older checkout */
  cause?: 'lock' | 'branch' | 'git' | 'checkout' | null;
  message: string;
  lastSync: number;
  conflicts: (SyncChanges['conflicts'][number] & { at: number })[];
  waiting: string[];
  notSent: string[];
  held: string[];
}

export interface SyncTarget { host: string; project: string; remote: string; url: string }
export interface SyncAuth { username: string; token: string }

export interface SyncEngineOptions {
  dir: string;
  host: string;
  project: string;
  remote: string;
  auth: SyncAuth;
  client?: string;
  /** what runs the engine, sent to the server (the web interface shows it): 'cli' unless said */
  app?: 'vscode' | 'cli';
  isBusy?: (rel: string) => boolean;
  onStatus?: (status: SyncStatus) => void;
  log?: (line: string) => void;
  /** send the files git put back without holding them (`overlyx sync --send-restored`) */
  sendRestored?: boolean;
}

export class SyncEngine {
  constructor(opts: SyncEngineOptions);
  o: SyncEngineOptions;
  status: SyncStatus;
  /** while watch() runs: sync soon (a file was saved) */
  poke?: () => void;
  sync(): Promise<SyncChanges>;
  round(): Promise<SyncChanges>;
  watch(opts?: { watchFiles?: boolean }): Promise<void>;
  stop(): void;
  unlock(): void;
  /** send the files git put back all the same */
  sendHeld(paths?: string[]): Promise<SyncChanges>;
  /** the server's version of every file that differs here (or of `paths`); `dryRun`: only what it would do. Local versions are kept in `kept`. */
  takeServer(opts?: { dryRun?: boolean; paths?: string[] | null }): Promise<{ replace: string[]; remove: string[]; busy: string[]; kept: string | null; failed: string[] }>;
  /** undo takeServer: the versions kept in that folder go back in place */
  restoreKept(kept: string): Promise<string[]>;
}

export function blobHash(buf: Buffer): string;
/** A detached HEAD onto `branch` when no file and no commit is affected; null when attached, else why not. */
export function attachDetachedHead(dir: string, branch: string): Promise<null | 'attached already' | 'no commit' | 'commits'>;
export function parseSyncRemote(url: string): { host: string; project: string } | null;
export function enclosingRepo(dir: string): Promise<string | null>;
export function addProjectSubmodule(host: string, auth: SyncAuth, project: string, parent: string, name?: string): Promise<string>;
export function ignoreInRepo(top: string, dir: string): Promise<boolean>;
/** files the sync never adds to a project (NFS temp files, editor swap/backup files, its own conflict copies) */
export function syncIgnored(rel: string): boolean;
export function syncTarget(dir: string): Promise<SyncTarget | null>;
export function syncCredentials(host: string, dir: string): Promise<SyncAuth | null>;
export function syncEngineFor(dir: string, opts?: Partial<SyncEngineOptions>): Promise<{ engine?: SyncEngine; target?: SyncTarget; error?: string; signin?: boolean }>;
export function knownSyncHosts(): string[];
export function describeChanges(c: SyncChanges): string[];
export function signInWithBrowser(host: string, ui: { open(url: string): Promise<unknown>; manual?: boolean; askCode?(): Promise<string | null | undefined>; project?: string; app?: "vscode" }): Promise<SyncAuth>;
export function signedInHosts(): { host: string; username: string }[];
export function signOutOf(host: string): boolean;
export function accountOf(host: string, auth: SyncAuth): Promise<{ username: string; name: string | null; email: string | null }>;
export function remoteProjects(host: string, auth: SyncAuth): Promise<{ name: string; title: string | null; role: string }[]>;
export function cloneProject(host: string, auth: SyncAuth, project: string, parent: string, name?: string): Promise<string>;
