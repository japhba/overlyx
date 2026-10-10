/** Types of what overlyx.js exports for the VS Code extension, which bundles its sync engine (packages/vscode/src/host/sync.ts). */

export interface SyncChanges {
  sent: { path: string; deleted?: boolean; status?: string; conflicts?: number }[];
  received: { path: string; deleted?: boolean }[];
  conflicts: { path: string; kind: 'copy' | 'restored' | 'tracked'; copy?: string; count?: number; at?: number }[];
  waiting: string[];
  notSent: string[];
  errors: { path: string; error: string }[];
}

export interface SyncStatus {
  /** idle: in step; paused: the engine waits (another process, another branch, git busy) — `message` says why */
  state: 'idle' | 'syncing' | 'paused' | 'offline' | 'error' | 'signin';
  message: string;
  lastSync: number;
  conflicts: (SyncChanges['conflicts'][number] & { at: number })[];
  waiting: string[];
  notSent: string[];
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
  isBusy?: (rel: string) => boolean;
  onStatus?: (status: SyncStatus) => void;
  log?: (line: string) => void;
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
}

export function blobHash(buf: Buffer): string;
export function parseSyncRemote(url: string): { host: string; project: string } | null;
export function syncTarget(dir: string): Promise<SyncTarget | null>;
export function syncCredentials(host: string, dir: string): Promise<SyncAuth | null>;
export function syncEngineFor(dir: string, opts?: Partial<SyncEngineOptions>): Promise<{ engine?: SyncEngine; target?: SyncTarget; error?: string; signin?: boolean }>;
export function knownSyncHosts(): string[];
export function describeChanges(c: SyncChanges): string[];
export function signInWithBrowser(host: string, ui: { open(url: string): Promise<unknown>; manual?: boolean; askCode?(): Promise<string | null | undefined>; project?: string }): Promise<SyncAuth>;
