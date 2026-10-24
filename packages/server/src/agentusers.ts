/**
 * Agents never run as root. When the server does (production), every account's agent engine —
 * codex or the Claude engine, its keeper and everything they run — has an unprivileged uid of its
 * own (`agentUid`: AGENT_ID_BASE + the account's id, its own gid, no supplementary groups, no
 * entry in /etc/passwd), started through setpriv in a systemd scope of its own (memory and task
 * limits). So an agent that leaves its sandbox is an ordinary user: no capability, nothing of
 * root's (the database, secrets, /root), no other account's agent files, no project — the
 * projects directory is root's alone; a working copy hard-links the project's files it needs.
 *
 * Its files live in `config.agentDir` (beside the projects, not under /root), each owned by the
 * account's uid: agent-home/<id> (CODEX_HOME, the Claude engine's home), agent-work/<thread> (the
 * working copy; the server's manifest, bases and checkpoints beside it stay root's), and
 * agent-scratch/<key>. The directories above them are passable but not listable (0711). What the
 * uids run must be readable by them: `agentRuntime` keeps copies of the keeper, the Claude engine
 * and the Agent SDK there (the checkout is in /root). Files the server writes into a working copy
 * take the copy's owner (confined.ts).
 *
 * Before agent users the agents' files were in the data directory: `migrateAgentData` moves them
 * once and hands them to their uids.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config, REPO_ROOT } from './config.ts';
import { db } from './db.ts';

export const AGENT_ID_BASE = 2_100_000;

/** The uid (and gid) the account's agents run as; null: as the server's own user (it is not root, or agent users are off). */
export const agentUid = (userId: number): number | null => (config.agent.users ? AGENT_ID_BASE + userId : null);

/** Hand `p` to the account's agent uid (links are changed themselves, never followed); `recursive` for a directory's contents too. */
export function giveTo(p: string, userId: number, recursive = false): void {
  const uid = agentUid(userId);
  if (uid === null) return;
  const own = (f: string) => { try { fs.lchownSync(f, uid, uid); } catch { /* gone meanwhile */ } };
  own(p);
  if (!recursive) return;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const f = path.join(p, e.name);
    if (e.isDirectory()) giveTo(f, userId, true); else own(f);
  }
}

const passed = new Set<string>();
/** Hand the directory `dir` to the account's agent uid, private to it (0700). */
export function privateTo(dir: string, userId: number): void {
  if (agentUid(userId) === null) return;
  giveTo(dir, userId);
  try { fs.chmodSync(dir, 0o700); } catch { /* gone meanwhile */ }
}

/** A directory the agent uids pass through to their own entries in it without seeing the others (0711, root's). */
export function passDir(dir: string): string {
  if (passed.has(dir) && fs.existsSync(dir)) return dir;
  fs.mkdirSync(dir, { recursive: true });
  if (config.agent.users) { try { fs.chmodSync(dir, 0o711); } catch { /* best-effort */ } }
  passed.add(dir);
  return dir;
}

/* ------------------------------------------------------------------ what the agent uids run */

const SCRIPTS = path.join(REPO_ROOT, 'scripts');
const SDK_PARENT = path.join(REPO_ROOT, 'node_modules', '@anthropic-ai');

/** the Agent SDK and its platform's Claude Code, as installed */
function sdkPackages(): string[] {
  try { return fs.readdirSync(SDK_PARENT).filter(n => n === 'claude-agent-sdk' || n.startsWith('claude-agent-sdk-')); } catch { return []; }
}
function sdkVersion(): string {
  try { return JSON.parse(fs.readFileSync(path.join(SDK_PARENT, 'claude-agent-sdk', 'package.json'), 'utf8')).version ?? 'none'; } catch { return 'none'; }
}

let runtimeReady: Promise<string> | null = null;
let runtimeKey = '';

/**
 * The agent runtime for the agent uids: `<agentDir>/agent-runtime/run-<hash>/` with the keeper,
 * the Claude engine and its sandbox entry, and node_modules (a link to the copy of the Agent SDK,
 * `sdk-<version>`, made once per version). Root's, readable by everyone. Older runs are removed
 * (keepers that run on one keep their open files).
 */
export function agentRuntime(): Promise<string> {
  const files = { 'agent-keeper.mjs': path.join(SCRIPTS, 'agent-keeper.mjs'), 'claude-app-server.mjs': config.agent.claudeServer, 'claude-sandbox-entry.mjs': path.join(SCRIPTS, 'claude-sandbox-entry.mjs') };
  const h = crypto.createHash('sha256');
  const version = sdkVersion();
  h.update(version);
  for (const f of Object.values(files)) h.update(fs.readFileSync(f));
  const key = h.digest('hex').slice(0, 16);
  if (runtimeReady && runtimeKey === key) return runtimeReady;
  runtimeKey = key;
  runtimeReady = (async () => {
    const base = path.join(config.agentDir, 'agent-runtime');
    fs.mkdirSync(base, { recursive: true, mode: 0o755 });
    const sdkDir = path.join(base, `sdk-${version}`);
    if (!fs.existsSync(sdkDir) && sdkPackages().length) {
      const tmp = `${sdkDir}.${process.pid}.tmp`;
      fs.rmSync(tmp, { recursive: true, force: true });
      for (const pkg of sdkPackages()) await fs.promises.cp(path.join(SDK_PARENT, pkg), path.join(tmp, 'node_modules', '@anthropic-ai', pkg), { recursive: true, verbatimSymlinks: true });
      fs.renameSync(tmp, sdkDir);
    }
    const run = path.join(base, `run-${key}`);
    if (!fs.existsSync(run)) {
      const tmp = `${run}.${process.pid}.tmp`;
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.mkdirSync(tmp, { recursive: true, mode: 0o755 });
      for (const [name, from] of Object.entries(files)) fs.copyFileSync(from, path.join(tmp, name));
      if (fs.existsSync(sdkDir)) fs.symlinkSync(path.join(sdkDir, 'node_modules'), path.join(tmp, 'node_modules'));
      fs.renameSync(tmp, run);
    }
    // the newest few stay (a keeper started on an older one may still read from it)
    const old = (prefix: string, keep: string) => fs.readdirSync(base).filter(n => n.startsWith(prefix) && n !== path.basename(keep) && !n.endsWith('.tmp'))
      .map(n => ({ n, t: fs.statSync(path.join(base, n)).mtimeMs })).sort((a, b) => b.t - a.t).slice(2);
    for (const { n } of [...old('run-', run), ...old('sdk-', sdkDir)]) fs.rmSync(path.join(base, n), { recursive: true, force: true });
    return run;
  })();
  runtimeReady.catch(() => { runtimeReady = null; });
  return runtimeReady;
}

/* ------------------------------------------------------------------ moving in */

/**
 * The agents' files from before agent users (in the data directory) move to `config.agentDir`
 * once, and every account's files are handed to its uid. Keepers still running on the old files
 * end by themselves when their socket disappears with them.
 */
export function migrateAgentData(): void {
  if (path.resolve(config.agentDir) !== path.resolve(config.dataDir)) {
    fs.mkdirSync(config.agentDir, { recursive: true });
    for (const name of ['agent-home', 'agent-work', 'agent-scratch']) {
      const from = path.join(config.dataDir, name), to = path.join(config.agentDir, name);
      if (!fs.existsSync(from)) continue;
      if (!fs.existsSync(to)) {
        const tmp = `${to}.moving`;
        fs.rmSync(tmp, { recursive: true, force: true });
        // (sockets stay behind: a keeper's, which goes with its keeper)
        fs.cpSync(from, tmp, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true, filter: src => { try { return !fs.lstatSync(src).isSocket(); } catch { return false; } } });
        fs.renameSync(tmp, to);
      }
      fs.rmSync(from, { recursive: true, force: true });
      console.log(`[agent] moved ${from} to ${to}`);
    }
  }
  if (!config.agent.users) return;
  passDir(config.agentDir);
  const marker = path.join(config.agentDir, '.owned');
  if (fs.existsSync(marker)) return;
  // the accounts' files to their uids (once: what is made afterwards is made theirs)
  const home = passDir(path.join(config.agentDir, 'agent-home'));
  for (const n of fs.readdirSync(home)) if (/^\d+$/.test(n)) { giveTo(path.join(home, n), Number(n), true); privateTo(path.join(home, n), Number(n)); }
  const work = passDir(path.join(config.agentDir, 'agent-work'));
  const scratch = passDir(path.join(config.agentDir, 'agent-scratch'));
  for (const t of db.prepare('SELECT thread_id, user_id, mcp_key FROM agent_threads').all() as { thread_id: string; user_id: number; mcp_key: string | null }[]) {
    const dir = path.join(work, t.thread_id.replace(/[^A-Za-z0-9._-]/g, '_'));
    if (fs.existsSync(dir)) { giveTo(dir, t.user_id, true); privateTo(dir, t.user_id); }
    for (const n of ['.base', '.turns']) { try { fs.chmodSync(dir + n, 0o700); } catch { /* none */ } }
    if (t.mcp_key) { const s = path.join(scratch, t.mcp_key.replace(/[^A-Za-z0-9_-]/g, '_')); if (fs.existsSync(s)) { giveTo(s, t.user_id, true); privateTo(s, t.user_id); } }
  }
  fs.writeFileSync(marker, new Date().toISOString() + '\n');
  console.log('[agent] the agents\' files belong to their own uids now');
}
