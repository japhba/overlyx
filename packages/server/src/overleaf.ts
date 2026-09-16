/**
 * Importing Overleaf projects. Overleaf has no API that lists a user's projects, but every
 * project is a git repository at https://git.overleaf.com/<project id> (the Git integration of
 * paid and institutional Overleaf accounts, authenticated with a Git token from the account
 * settings); free accounts download the project as a zip (Menu ▸ Download ▸ Source), which
 * zip.ts unpacks. A cloned project keeps its Overleaf history and `origin`; the token is handed
 * to git through GIT_ASKPASS and is never written anywhere.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.ts';
import { gitEnv } from './git.ts';

const execFileP = promisify(execFile);

/** The 24-hex project id from an Overleaf link (`…/project/<id>`, `git.overleaf.com/<id>`) or a bare id; null otherwise. */
export function overleafProjectId(ref: string): string | null {
  const s = ref.trim();
  const m = /^(?:https?:\/\/)?(?:www\.)?(?:[a-z0-9-]+\.)?overleaf\.com\/(?:project\/)?([0-9a-f]{24})(?:[/?#]|$)/i.exec(s) ?? /^([0-9a-f]{24})$/i.exec(s);
  return m ? m[1].toLowerCase() : null;
}

export const overleafGitUrl = (id: string) => `https://git.overleaf.com/${id}`;

/** The askpass helper that answers git's prompts with the token from the environment (written once into the data directory). */
function askpassScript(): string {
  const dir = path.join(config.dataDir, 'git-home');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'overleaf-askpass.sh');
  const body = '#!/bin/sh\ncase "$1" in\n  [Uu]sername*) printf \'%s\\n\' git ;;\n  *) printf \'%s\\n\' "$OVERLEAF_GIT_TOKEN" ;;\nesac\n';
  try { if (fs.readFileSync(file, 'utf8') !== body) throw new Error('rewrite'); } catch { fs.writeFileSync(file, body, { mode: 0o700 }); }
  fs.chmodSync(file, 0o700);
  return file;
}

/** git's error output as one sentence for the user */
export function describeCloneError(stderr: string): string {
  const s = stderr.toLowerCase();
  if (/authentication failed|invalid username or (password|token)|could not read username|401/.test(s)) return 'Overleaf rejected the Git token — check it in Overleaf ▸ Account settings ▸ Git integration (Git access needs a paid or institutional Overleaf plan).';
  if (/repository.*not found|\bnot found\b|404|does not appear to be a git repository|403/.test(s)) return 'Overleaf has no project with this id for your account (is the link right, and do you have access to the project?).';
  if (/could not resolve host|unable to access|network is unreachable|connection timed out|timed out/.test(s)) return 'Overleaf could not be reached from this server.';
  const line = stderr.split('\n').map(l => l.trim()).filter(Boolean).pop() ?? 'git clone failed';
  return line.replace(/^fatal:\s*/i, '');
}

/** Clone an Overleaf project into `dest` (which must not exist). On failure nothing is left behind. */
export async function cloneOverleafProject(id: string, token: string, dest: string, opts: { timeoutMs?: number } = {}): Promise<void> {
  if (!/^[0-9a-f]{24}$/.test(id)) throw new Error('not an Overleaf project id');
  if (fs.existsSync(dest)) throw new Error('a project with this name exists already');
  try {
    await execFileP('git', ['clone', '--quiet', overleafGitUrl(id), dest], {
      env: gitEnv({ GIT_ASKPASS: askpassScript(), OVERLEAF_GIT_TOKEN: token, GIT_TERMINAL_PROMPT: '0' }),
      timeout: opts.timeoutMs ?? 300000, maxBuffer: 4 * 1024 * 1024,
    });
  } catch (e) {
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* nothing to clean */ }
    const err = e as { stderr?: string; killed?: boolean; message?: string };
    if (err.killed) throw new Error('the clone took too long and was stopped');
    throw new Error(describeCloneError(String(err.stderr ?? err.message ?? e)));
  }
}
