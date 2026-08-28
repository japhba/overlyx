/**
 * External tools (latexmk, LyX, the image converters) run in a **bubblewrap** sandbox: the system
 * read-only, only the directories named by the caller writable, no network, an own PID namespace,
 * a private /tmp and HOME, an empty environment, no capabilities beyond reading files, and
 * everything killed when the server stops.
 *
 * Why: LaTeX is a programming language and `latexmkrc` is Perl. Anyone who may edit a project can
 * put both there, so a PDF build is arbitrary code — it must not be arbitrary code *on the server*.
 *
 * `OVERLYX_SANDBOX`: `auto` (default: bwrap when installed, else a warning at start-up and no
 * sandbox), `bwrap` (required: refuse to start without it), `none`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';

export interface SandboxSpec {
  /** directories the tool may write to (created if missing) */
  rw: string[];
  /** directories it may read (the system directories are always readable) */
  ro?: string[];
  cwd: string;
  /** the tool's complete environment (nothing of the server's environment is passed on) */
  env?: Record<string, string>;
}

const BWRAP = ['/usr/bin/bwrap', '/usr/local/bin/bwrap', '/bin/bwrap'];
/** read-only system directories: binaries, libraries, the TeX distribution, fonts and their caches */
const SYSTEM_RO = ['/usr', '/etc', '/lib', '/lib64', '/lib32', '/bin', '/sbin', '/opt', '/var/lib/texmf', '/var/cache/fontconfig', '/var/lib/ghostscript'];

let available: boolean | null = null;

/** Whether tools run sandboxed (decided once, logged once). */
export function sandboxAvailable(): boolean {
  if (available === null) {
    const found = BWRAP.some(p => fs.existsSync(p));
    if (config.sandbox === 'none') { available = false; console.warn('[sandbox] OVERLYX_SANDBOX=none: LaTeX builds run unsandboxed'); }
    else if (found) { available = true; }
    else if (config.sandbox === 'bwrap') throw new Error('OVERLYX_SANDBOX=bwrap but bubblewrap is not installed (apt install bubblewrap)');
    else { available = false; console.warn('[sandbox] bubblewrap (bwrap) is not installed: LaTeX builds run UNSANDBOXED — anyone who may edit a project can run commands on this server. Install it: apt install bubblewrap'); }
  }
  return available;
}

/** A persistent HOME for the tools (TeX / fontconfig / inkscape caches, LyX's user directory). */
export function sandboxHome(): string {
  const h = path.join(config.dataDir, 'sandbox-home');
  fs.mkdirSync(h, { recursive: true });
  return h;
}

export interface SandboxedCommand { cmd: string; args: string[]; env: NodeJS.ProcessEnv }

/**
 * The command line that runs `cmd args` under the sandbox. Without a sandbox the command is
 * returned unchanged with `spec.env` merged into the server's environment.
 */
export function sandboxed(cmd: string, args: string[], spec: SandboxSpec): SandboxedCommand {
  if (!sandboxAvailable()) return { cmd, args, env: { ...process.env, ...spec.env } };
  const home = sandboxHome();
  const b: string[] = [];
  for (const d of SYSTEM_RO) if (fs.existsSync(d)) b.push('--ro-bind', d, d);
  b.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp');
  b.push('--bind', home, home);
  for (const d of new Set(spec.ro ?? [])) if (fs.existsSync(d)) b.push('--ro-bind', d, d);
  for (const d of new Set(spec.rw)) { fs.mkdirSync(d, { recursive: true }); b.push('--bind', d, d); }
  // As root, a user namespace would hide the capabilities that read files owned by other users
  // (projects synced from elsewhere often are): skip the user namespace and drop every capability
  // except reading; unprivileged servers get the full unshare (they need the user namespace).
  if (process.getuid?.() === 0) b.push('--unshare-pid', '--unshare-net', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try', '--cap-drop', 'ALL', '--cap-add', 'CAP_DAC_READ_SEARCH');
  else b.push('--unshare-all');
  b.push('--die-with-parent', '--new-session', '--chdir', spec.cwd);
  b.push('--clearenv', '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin', '--setenv', 'LANG', 'C.UTF-8', '--setenv', 'HOME', home, '--setenv', 'TMPDIR', '/tmp');
  for (const [k, v] of Object.entries(spec.env ?? {})) b.push('--setenv', k, v);
  return { cmd: 'bwrap', args: [...b, '--', cmd, ...args], env: { ...process.env } };
}
