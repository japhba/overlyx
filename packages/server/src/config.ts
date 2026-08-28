import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '../../..');

export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  dataDir: path.resolve(process.env.OVERLYX_DATA_DIR ?? path.join(REPO_ROOT, 'data')),
  /** directory whose sub-directories are projects (each may hold .lyx files) */
  projectsDir: path.resolve(process.env.OVERLYX_PROJECTS_DIR ?? '/root/projects'),
  layoutDir: process.env.LYX_LAYOUT_DIR ?? (fs.existsSync('/root/lyx/lib/layouts') ? '/root/lyx/lib/layouts' : path.join(REPO_ROOT, 'lyx/lib/layouts')),
  lyxBin: process.env.OVERLYX_LYX_BIN ?? 'lyx',
  lyx2lyx: process.env.OVERLYX_LYX2LYX ?? (fs.existsSync('/root/lyx/lib/lyx2lyx/lyx2lyx') ? '/root/lyx/lib/lyx2lyx/lyx2lyx' : path.join(REPO_ROOT, 'lyx/lib/lyx2lyx/lyx2lyx')),
  publicUrl: process.env.OVERLYX_PUBLIC_URL ?? '',
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
  },
  /**
   * E-mail (or username) of the instance owner: this account is an administrator and owns every
   * project directory that exists without an owner (the ones that predate sharing / were created
   * by hand). Unset: the first admin account.
   */
  ownerEmail: (process.env.OVERLYX_OWNER_EMAIL ?? '').trim().toLowerCase(),
  /**
   * Who may create an account with "Sign in with Google": `open` (anyone — like Google Docs, they
   * only see their own and shared projects) or `invited` (only e-mails that a project was shared with).
   */
  signup: (process.env.OVERLYX_SIGNUP === 'invited' ? 'invited' : 'open') as 'open' | 'invited',
  clientDist: path.resolve(process.env.OVERLYX_CLIENT_DIST ?? path.join(REPO_ROOT, 'packages/client/dist')),
  /** debounce for writing .lyx files back to disk (ms) */
  saveDebounceMs: Number(process.env.OVERLYX_SAVE_DEBOUNCE ?? 1500),
  /** longest time edits may stay unwritten while people type continuously (ms) */
  saveMaxWaitMs: Number(process.env.OVERLYX_SAVE_MAX_WAIT ?? 10000),
  /** same for persisting the Yjs state in SQLite (ms) */
  persistMaxWaitMs: Number(process.env.OVERLYX_PERSIST_MAX_WAIT ?? 5000),
  /** concurrent PDF builds (each latexmk run is one core; more only queue up) */
  maxBuilds: Math.max(1, Number(process.env.OVERLYX_MAX_BUILDS ?? 2)),
  /** `nice` level for latexmk / LyX so that builds never starve the editor */
  buildNiceness: Number(process.env.OVERLYX_BUILD_NICE ?? 10),
  /** sandbox for latexmk / LyX / image converters (see sandbox.ts): auto | bwrap | none */
  sandbox: (['auto', 'bwrap', 'none'].includes(process.env.OVERLYX_SANDBOX ?? '') ? process.env.OVERLYX_SANDBOX : 'auto') as 'auto' | 'bwrap' | 'none',
  /** idle time after which an open document is released from memory (ms) */
  unloadAfterMs: Number(process.env.OVERLYX_UNLOAD_MS ?? 6 * 60 * 60 * 1000),
  /** minimum interval between automatic versions (ms) */
  autoVersionIntervalMs: Number(process.env.OVERLYX_AUTOVERSION_MS ?? 10 * 60 * 1000),
  /** every project is a git repository served at /git/<project>.git (OVERLYX_GIT=off disables it) */
  git: process.env.OVERLYX_GIT !== 'off',
  /** idle time after the last change before OverLyX commits it (ms) */
  gitCommitMs: Number(process.env.OVERLYX_GIT_COMMIT_MS ?? 2 * 60 * 1000),
  /** longest time changes may stay uncommitted while editing goes on (ms) */
  gitCommitMaxWaitMs: Number(process.env.OVERLYX_GIT_COMMIT_MAX_WAIT ?? 15 * 60 * 1000),
  /** feedback + error reports become GitHub issues of this repository (feedback.ts); needs a token with Issues: write */
  github: {
    repo: (process.env.GITHUB_REPO ?? 'japhba/overlyx').trim(),
    token: (process.env.GITHUB_TOKEN ?? '').trim(),
    api: (process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, ''),
  },
  /** automatic issues for uncaught browser / server errors (OVERLYX_ERROR_REPORTS=off keeps only Help ▸ Report a problem) */
  errorReports: process.env.OVERLYX_ERROR_REPORTS !== 'off',
  sessionDays: 30,
};

fs.mkdirSync(config.dataDir, { recursive: true });
for (const d of ['cache', 'build', 'uploads']) fs.mkdirSync(path.join(config.dataDir, d), { recursive: true });

const secretFile = path.join(config.dataDir, 'secret.key');
if (!fs.existsSync(secretFile)) {
  fs.writeFileSync(secretFile, crypto.randomBytes(48).toString('hex'), { mode: 0o600 });
}
export const JWT_SECRET = fs.readFileSync(secretFile, 'utf8').trim();
