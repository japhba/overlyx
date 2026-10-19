/** Lightweight, unattended issue/log → fix → deploy loop. Run through maintenance.sh (flock). */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { usageSummary } from '../packages/server/src/usageReport.ts';

export interface Signal { key: string; revision: string; kind: string; title: string; detail: string; priority: number; issue?: number }
export interface Seen { revision: string; attempts: number; nextAt: number; lastAt: number; outcome: string }
export interface State { seen: Record<string, Seen>; lastScan: number; pending?: { keys: string[]; issues: number[]; commit: string } }
export const digest = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 24);
// Repeated errors get another look when their count doubles, rather than on every occurrence.
export const countRevision = (count: number) => String(Math.floor(Math.log2(Math.max(1, count))));
export function eligible(signal: Signal, seen: Seen | undefined, now: number): boolean {
  const changed = seen && signal.revision !== seen.revision &&
    (!/^\d+$/.test(signal.revision) || !/^\d+$/.test(seen.revision) || Number(signal.revision) > Number(seen.revision));
  return !seen || !!changed || seen.outcome === 'retry' && seen.attempts < 3 && now >= seen.nextAt;
}
export function finish(signal: Signal, seen: Seen | undefined, outcome: string, now: number): Seen {
  const attempts = seen?.revision === signal.revision ? seen.attempts + 1 : 1;
  return { revision: signal.revision, attempts, nextAt: now + Math.min(24, 2 ** attempts) * 3600000, lastAt: now, outcome };
}
export function privateText(value: unknown, max = 9000): string {
  return String(value ?? '').replace(/\b(?:Bearer|token|password|secret|api[_-]?key)\s*[:= ]\s*\S+/gi, '[credential]')
    .replace(/\b(?:gh[pousr]_[\w]+|sk-[\w-]{15,})\b/g, '[credential]')
    .replace(/[^\s<>]+@[^\s<>]+\.[a-z]{2,}/gi, '<email>').slice(0, max);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stateDir = process.env.OVERLYX_MAINTENANCE_STATE ?? '/var/lib/overlyx-maintenance';
const production = process.env.OVERLYX_PRODUCTION ?? '/root/lyx/overlyx-production';
const source = process.env.OVERLYX_MAINTENANCE_SOURCE ?? '/root/lyx/overlyx';
const checkout = process.env.OVERLYX_MAINTENANCE_CHECKOUT ?? '/root/lyx/overlyx-maintenance';
const repo = process.env.OVERLYX_MAINTENANCE_REPO ?? 'japhba/overlyx';
const dbFile = process.env.OVERLYX_MAINTENANCE_DB ?? path.join(process.env.OVERLYX_DATA_DIR ?? path.join(source, 'data'), 'overlyx.sqlite');
// Set for the unprivileged worker (deploy/overlyx-maintenance.service): root screens the database, the
// service journal and GitHub beforehand (--collect) and leaves the sanitized signals here for it.
const inbox = process.env.OVERLYX_MAINTENANCE_INBOX;
const site = process.env.OVERLYX_SITE_URL ?? 'https://overlyx.app';
const log = (s: string) => console.log(`[maintenance] ${s}`);
function command(bin: string, args: string[], cwd = root, timeout = 60000): string {
  return execFileSync(bin, args, { cwd, timeout, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
const git = (args: string[]) => command('git', args, checkout);
function save(state: State) {
  fs.writeFileSync(path.join(stateDir, 'state.new'), JSON.stringify(state, null, 2));
  fs.renameSync(path.join(stateDir, 'state.new'), path.join(stateDir, 'state.json'));
}

export function databaseSignals(db: Database.Database, since: number): Signal[] {
  const signals: Signal[] = [];
  // Deliberately never join accounts or export user_id, browser identity, or email headers.
  const reports = db.prepare(`SELECT id, kind, title, body, count, version FROM reports
    WHERE last_at >= ? AND kind != 'mail' ORDER BY last_at DESC LIMIT 100`).all(since) as any[];
  for (const r of reports) signals.push({ key: `report:${r.id}`, revision: digest(`${r.title}\n${r.body}`) + ':' + countRevision(r.count),
    kind: r.kind, title: privateText(r.title, 300), detail: privateText(`Report #${r.id}; release ${r.version}; occurrences ${r.count}\n${r.body}`), priority: r.kind === 'feedback' ? 2 : 3 });
  const usage = usageSummary(db, { sinceMs: since, top: 20 });
  for (const [kind, rows] of [['usage-error', usage.errors], ['interaction-trail', usage.interactions.problemTrails]] as const) {
    for (const r of rows) signals.push({ key: `${kind}:${digest(r.key)}`, revision: countRevision(r.count), kind,
      title: privateText(r.key, 400), detail: `${r.count} occurrences in ${r.sessions} anonymous sessions. These are signals, not confirmed bugs.`, priority: kind === 'usage-error' ? 3 : 5 });
  }
  for (const r of usage.suspicious.slice(0, 10)) {
    if (r.failed + r.repeated + r.undone < 3) continue;
    signals.push({ key: `usage-action:${digest(r.key)}`, revision: countRevision(r.failed + r.repeated + r.undone), kind: 'usage-action',
      title: privateText(r.key, 400), detail: JSON.stringify({ count: r.count, sessions: r.sessions, failed: r.failed, repeated: r.repeated, undone: r.undone, where: r.where }), priority: 6 });
  }
  return signals;
}

async function collect(lastScan: number): Promise<Signal[]> {
  const signals: Signal[] = [];
  const failures: string[] = [];
  try {
    const issues = JSON.parse(command('gh', ['issue', 'list', '-R', repo, '--state', 'open', '--limit', '100', '--json', 'number,title,body,updatedAt,labels,comments']));
    for (const i of issues) {
      const labels = i.labels.map((l: any) => l.name);
      if (labels.some((l: string) => ['wontfix', 'duplicate', 'maintenance-ignore'].includes(l))) continue;
      signals.push({ key: `issue:${i.number}`, revision: i.updatedAt, issue: i.number, kind: 'github-issue', priority: labels.includes('bug') ? 0 : 1,
        title: privateText(i.title, 300), detail: privateText(JSON.stringify({ body: i.body, labels, comments: i.comments.slice(-5).map((c: any) => ({ body: c.body })) })) });
    }
  } catch { failures.push('GitHub issues'); }
  try {
    const db = new Database(dbFile, { readonly: true, fileMustExist: true });
    try { signals.push(...databaseSignals(db, Date.now() - 7 * 86400000)); } finally { db.close(); }
  } catch { failures.push('local reports/usage'); }
  try {
    const since = new Date(lastScan || Date.now() - 86400000).toISOString();
    const lines = command('journalctl', ['-u', 'overlyx', '--since', since, '-n', '300', '--no-pager', '-o', 'cat']);
    const groups = new Map<string, string[]>();
    for (const line of lines.split('\n')) {
      if (!/error|exception|unhandled|failed|fatal/i.test(line)) continue;
      const template = privateText(line, 500).replace(/\b[\da-f]{8,}\b/gi, '#').replace(/\d+/g, '#');
      const lines = groups.get(template) ?? []; lines.push(privateText(line, 1200)); groups.set(template, lines);
    }
    for (const [title, lines] of groups) signals.push({ key: `journal:${digest(title)}`, revision: '1', kind: 'server-log', priority: 4, title, detail: lines.slice(-5).join('\n') });
  } catch { failures.push('service journal'); }
  if (failures.length) log(`could not read ${failures.join(', ')}; other sources still screened`);
  if (failures.length === 3) throw new Error('All monitoring sources unavailable');
  return signals;
}

// Root's half of an unprivileged run (the unit's ExecStartPre). The inbox is root's (setgid to the
// worker's group): the worker reads the signals and can plant nothing that root would follow.
async function collectInto(dir: string) {
  const mark = path.join(dir, 'collector.json');
  const lastScan = fs.existsSync(mark) ? Number(JSON.parse(fs.readFileSync(mark, 'utf8')).lastScan) || 0 : 0;
  const now = Date.now();
  const signals = await collect(lastScan);
  const file = path.join(dir, 'signals.json');
  fs.writeFileSync(file + '.new', JSON.stringify({ at: now, signals }));
  fs.chmodSync(file + '.new', 0o640); fs.renameSync(file + '.new', file);
  fs.writeFileSync(mark, JSON.stringify({ lastScan: now }));
  log(`collected ${signals.length} signals for the worker`);
}

function collected(dir: string): Signal[] {
  const { at, signals } = JSON.parse(fs.readFileSync(path.join(dir, 'signals.json'), 'utf8'));
  if (Date.now() - at > 3600000) log(`the collected evidence is ${Math.round((Date.now() - at) / 60000)} minutes old`);
  return signals;
}

function prepareCheckout() {
  if (!fs.existsSync(path.join(checkout, '.git'))) {
    // the worker pushes to this remote with a deploy key of its own (scripts/maintenance.sh has none)
    const origin = process.env.OVERLYX_MAINTENANCE_ORIGIN ?? command('git', ['remote', 'get-url', 'origin'], source);
    command('git', ['clone', '--quiet', '--no-checkout', origin, checkout]);
    git(['checkout', '-B', 'master', 'origin/master']);
    git(['config', 'user.name', 'OverLyX']); git(['config', 'user.email', 'overlyx@localhost']);
  }
  git(['fetch', 'origin', '--quiet']);
  // Only this worker owns this checkout. Archive failed/unfinished work before resynchronizing.
  const dirty = git(['status', '--porcelain']);
  const ahead = git(['rev-list', '--count', 'origin/master..HEAD']);
  if (dirty || ahead !== '0') {
    git(['add', '-A']);
    fs.writeFileSync(path.join(stateDir, `unfinished-${Date.now()}.patch`), git(['diff', '--cached', '--binary', 'origin/master']));
    git(['reset', '--hard', 'origin/master']);
  } else git(['merge', '--ff-only', 'origin/master']);
  // Hardlinks, not node_modules symlinks: workspace packages and ProseMirror must resolve here.
  const lock = digest(fs.readFileSync(path.join(checkout, 'package-lock.json'), 'utf8'));
  const marker = path.join(checkout, '.git', 'maintenance-dependencies');
  if (!fs.existsSync(marker) || fs.readFileSync(marker, 'utf8') !== lock) {
    const modules = [path.join(checkout, 'node_modules'), ...fs.readdirSync(path.join(checkout, 'packages'), { withFileTypes: true })
      .filter(entry => entry.isDirectory()).map(entry => path.join(checkout, 'packages', entry.name, 'node_modules'))];
    for (const dir of modules) fs.rmSync(dir, { recursive: true, force: true });
    let linked = false;
    try {   // an unprivileged worker may not hardlink production's files: it installs its own
      if (fs.readFileSync(path.join(production, 'package-lock.json'), 'utf8') === fs.readFileSync(path.join(checkout, 'package-lock.json'), 'utf8')) {
        command('cp', ['-al', path.join(production, 'node_modules'), path.join(checkout, 'node_modules')]);
        for (const name of fs.readdirSync(path.join(production, 'packages'))) {
          const from = path.join(production, 'packages', name, 'node_modules'), to = path.join(checkout, 'packages', name, 'node_modules');
          if (fs.existsSync(from) && !fs.existsSync(to)) command('cp', ['-al', from, to]);
        }
        linked = true;
      }
    } catch { for (const dir of modules) fs.rmSync(dir, { recursive: true, force: true }); }
    if (!linked) command('npm', ['ci', '--no-audit', '--no-fund'], checkout, 15 * 60000);
    fs.writeFileSync(marker, lock);
  }
}

async function loggedProcess(bin: string, args: string[], file: string, timeout: number, input?: string): Promise<void> {
  const fd = fs.openSync(file, 'a');
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(bin, args, { cwd: checkout, stdio: ['pipe', fd, fd], env: { ...process.env, OVERLYX_DEPLOY_FULL: '0' }, detached: true });
      const kill = () => { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} };
      const timer = setTimeout(kill, timeout);
      child.once('error', e => { clearTimeout(timer); reject(e); });
      child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`${bin} failed; inspect ${file}`)); });
      child.stdin.on('error', () => {}); child.stdin.end(input);
    });
  } finally { fs.closeSync(fd); }
}

const resultSchema = { type: 'object', additionalProperties: false, properties: {
  outcome: { type: 'string', enum: ['fixed', 'no_fix', 'defer'] }, summary: { type: 'string' }, checks: { type: 'array', items: { type: 'string' } },
}, required: ['outcome', 'summary', 'checks'] };

// Publishing is a push: the production server's autodeploy (root, scripts/autodeploy.sh) deploys what
// reaches origin/master, and `Deploy: no-checks` leaves it the build and the verification. The worker
// holds no rights on production; it waits until the site serves its commit.
async function deploy(state: State, runDir: string) {
  const push = () => command('git', ['push', '--quiet', 'origin', 'HEAD:refs/heads/master'], checkout, 120000);
  try { push(); } catch {
    git(['fetch', 'origin', '--quiet']);
    try { git(['rebase', 'origin/master']); } catch { git(['rebase', '--abort']); throw new Error('Concurrent changes conflict; fix retained for another attempt'); }
    push();
  }
  state.pending!.commit = git(['rev-parse', 'HEAD']); save(state);
  fs.appendFileSync(path.join(runDir, 'deploy.log'), `pushed ${state.pending!.commit}\n`);
  await served(state.pending!.commit);
  for (const number of state.pending!.issues) {
    // Closing a fixed issue is part of the authorized workflow; never copy private logs into it.
    // (Without a GitHub login the commit's "Fixes #n" has closed it already.)
    try { command('gh', ['issue', 'close', String(number), '-R', repo, '--reason', 'completed']); } catch { log(`could not close resolved issue #${number}`); }
  }
  log(`deployed ${state.pending!.commit.slice(0, 10)}`);
  delete state.pending; save(state);
}

async function served(commit: string) {
  const until = Date.now() + 15 * 60000;
  for (;;) {
    let live = '';
    try { live = String((await (await fetch(`${site}/api/version`, { signal: AbortSignal.timeout(10000) })).json() as { commit?: string }).commit ?? ''); } catch { /* restarting */ }
    if (live === commit) return;
    if (/^[0-9a-f]{40}$/.test(live)) {   // a later push deployed on top of ours
      try { git(['fetch', 'origin', '--quiet']); git(['merge-base', '--is-ancestor', commit, live]); return; } catch { /* older, or not fetched yet */ }
    }
    if (Date.now() > until) throw new Error(`${site} serves ${live.slice(0, 10) || 'nothing'}, not ${commit.slice(0, 10)}: see journalctl -u overlyx-autodeploy`);
    await new Promise(resolve => setTimeout(resolve, 20000));
  }
}

async function main() {
  process.umask(0o077);
  if (process.argv.includes('--collect')) {
    if (!inbox) throw new Error('--collect needs OVERLYX_MAINTENANCE_INBOX');
    return collectInto(inbox);
  }
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const stateFile = path.join(stateDir, 'state.json');
  const state: State = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { seen: {}, lastScan: 0 };
  // A restart or network failure after committing must retry deployment, not discard the fix.
  if (state.pending && !process.argv.includes('--scan')) {
    try {
      git(['fetch', 'origin', '--quiet']);
      try { git(['rebase', 'origin/master']); } catch { git(['rebase', '--abort']); throw new Error('Pending deployment conflicts with newer work'); }
      state.pending.commit = git(['rev-parse', 'HEAD']); save(state);
      await deploy(state, stateDir);
    } catch (e) {
      log(String(e));
      for (const key of state.pending!.keys) {
        state.seen[key].outcome = 'retry'; state.seen[key].nextAt = Date.now();
      }
      delete state.pending; save(state); return;
    }
  }
  const signals = inbox ? collected(inbox) : await collect(state.lastScan);
  const now = Date.now();
  const queue = signals.filter(s => eligible(s, state.seen[s.key], now)).sort((a, b) => a.priority - b.priority);
  log(`screened ${signals.length} signals; ${queue.length} new or retryable`);
  state.lastScan = now;
  for (const [key, s] of Object.entries(state.seen)) if (now - s.lastAt > 90 * 86400000) delete state.seen[key];
  save(state);
  if (process.argv.includes('--scan') || !queue.length) return;
  prepareCheckout();
  const signal = queue[0];
  const runDir = path.join(stateDir, 'runs', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  // Keep at most 30 private run transcripts. No trace or report is written inside the repository.
  const runs = fs.readdirSync(path.dirname(runDir)).sort();
  for (const old of runs.slice(0, -30)) fs.rmSync(path.join(path.dirname(runDir), old), { recursive: true, force: true });
  fs.writeFileSync(path.join(runDir, 'input.json'), JSON.stringify({ signal, related: signals.filter(s => s.key !== signal.key).slice(0, 12) }, null, 2));
  fs.writeFileSync(path.join(runDir, 'schema.json'), JSON.stringify(resultSchema));
  const prompt = fs.readFileSync(path.join(root, 'scripts/maintenance-prompt.txt'), 'utf8') + `\nPrivate evidence: ${path.join(runDir, 'input.json')}\n`;
  // Record the attempt before starting, so a killed run does not produce an immediate retry storm.
  state.seen[signal.key] = finish(signal, state.seen[signal.key], 'retry', now); save(state);
  log(`investigating ${signal.kind} (${signal.key})`);
  try {
    await loggedProcess('codex', ['exec', '--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true', '-c', 'approval_policy="never"',
      '--json', '--output-schema', path.join(runDir, 'schema.json'), '--output-last-message', path.join(runDir, 'result.json'), '-'],
      path.join(runDir, 'agent.jsonl'), 15 * 60000, prompt);
    const result = JSON.parse(fs.readFileSync(path.join(runDir, 'result.json'), 'utf8'));
    if (!['fixed', 'no_fix', 'defer'].includes(result.outcome) || !Array.isArray(result.checks)) throw new Error('Invalid worker result');
    if (result.outcome === 'fixed' && git(['status', '--porcelain'])) {
      git(['add', '-A']); git(['diff', '--cached', '--check']);
      git(['commit', '-m', 'Fix production issue discovered by maintenance worker', ...(signal.issue ? ['-m', `Fixes #${signal.issue}`] : []), '-m', 'Deploy: no-checks']);
      // Another agent can push while this worker investigates; rebase only our own commit.
      git(['fetch', 'origin', '--quiet']);
      try { git(['rebase', 'origin/master']); } catch { git(['rebase', '--abort']); throw new Error('Concurrent changes conflict; fix retained for another attempt'); }
      state.pending = { keys: [signal.key], issues: signal.issue ? [signal.issue] : [], commit: git(['rev-parse', 'HEAD']) };
      state.seen[signal.key].outcome = 'fixed'; save(state);
      await deploy(state, runDir);
    } else {
      state.seen[signal.key].outcome = result.outcome === 'defer' ? 'retry' : 'no_fix'; save(state);
      log(`finished ${signal.key}: ${result.outcome}`);
    }
  } catch (e) { log(String(e)); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { log(String(e)); process.exitCode = 1; });
}
