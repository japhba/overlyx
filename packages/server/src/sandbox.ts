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
import crypto from 'node:crypto';
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
  /** its HOME (writable): sandboxHome(project) for a project's builds; false: an empty one that is thrown away; default the shared one */
  home?: string | false;
}

const BWRAP = ['/usr/bin/bwrap', '/usr/local/bin/bwrap', '/bin/bwrap'];
/** read-only system directories: binaries, libraries, the TeX distribution, fonts and their caches */
const SYSTEM_RO = ['/usr', '/lib', '/lib64', '/lib32', '/bin', '/sbin', '/opt', '/var/lib/texmf', '/var/cache/fontconfig', '/var/lib/ghostscript'];
/**
 * Not the whole of `/etc`: the build runs as uid 0 (see below), so binding all of `/etc` would let a
 * document read `/etc/shadow`, the host's SSH keys and the like — via `\input` (blocked by
 * openin_any=p) but also via a `-shell-escape` command, which that setting does not reach. Bind only
 * what LaTeX, fontconfig and the dynamic linker actually need. `/etc/texmf/web2c/texmf.cnf` is the
 * first texmf.cnf kpathsea finds, so the TeX distribution will not run without it.
 */
const ETC_RO = [
  '/etc/texmf', '/etc/fonts', '/etc/alternatives',
  '/etc/ld.so.cache', '/etc/ld.so.conf', '/etc/ld.so.conf.d',
  '/etc/nsswitch.conf', '/etc/passwd', '/etc/group',
  '/etc/ssl', '/etc/ca-certificates.conf',
];

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

/**
 * A persistent HOME for the tools (TeX / fontconfig / inkscape caches, LyX's user directory).
 * With a project: that project's own — a build runs the project's code (latexmkrc), and whatever it
 * leaves in its HOME (a ~/.latexmkrc, a TeX file under ~/texmf) is read by every later build that
 * shares it, so builds of different projects never share one. A new one starts as a copy of the
 * shared HOME (its LuaTeX font cache saves a slow first build); the shared one is written only by
 * the image converters, never by a project's build.
 */
export function sandboxHome(project?: string): string {
  const shared = path.join(config.dataDir, 'sandbox-home');
  fs.mkdirSync(shared, { recursive: true });
  if (!project) return shared;
  const h = path.join(config.dataDir, 'sandbox-homes', crypto.createHash('sha1').update(project).digest('hex').slice(0, 16));
  if (!fs.existsSync(h)) {
    const tmp = `${h}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(h), { recursive: true });
      fs.cpSync(shared, tmp, { recursive: true, verbatimSymlinks: true });
      fs.renameSync(tmp, h);
    } catch {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.mkdirSync(h, { recursive: true });   // another build made it meanwhile (or the copy failed: an empty HOME works too)
    }
  }
  return h;
}

/** Remove a project's HOME (the project is gone). */
export function removeSandboxHome(project: string): void {
  fs.rmSync(path.join(config.dataDir, 'sandbox-homes', crypto.createHash('sha1').update(project).digest('hex').slice(0, 16)), { recursive: true, force: true });
}

export interface SandboxedCommand { cmd: string; args: string[]; env: NodeJS.ProcessEnv }

/**
 * The command line that runs `cmd args` under the sandbox. Without a sandbox the command is
 * returned unchanged with `spec.env` merged into the server's environment.
 */
export function sandboxed(cmd: string, args: string[], spec: SandboxSpec): SandboxedCommand {
  if (!sandboxAvailable()) return { cmd, args, env: { ...process.env, ...spec.env } };
  const home = spec.home === false ? '/tmp/home' : spec.home ?? sandboxHome();
  const b: string[] = [];
  for (const d of [...SYSTEM_RO, ...ETC_RO]) if (fs.existsSync(d)) b.push('--ro-bind', d, d);
  b.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp');
  if (spec.home === false) b.push('--dir', home);
  else { fs.mkdirSync(home, { recursive: true }); b.push('--bind', home, home); }
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
