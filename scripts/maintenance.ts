/**
 * Lightweight, unattended issue/log → fix loop. Run through maintenance.sh (flock). The worker holds no
 * GitHub key: it leaves each ready fix in its outbox, and root's promoter (maint-promote.ts, the unit's
 * ExecStopPost) deploys it or queues it for the owner, depending on whom the evidence came from.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { usageSummary } from '../packages/server/src/usageReport.ts';
import { secretReasons } from './maint-policy.ts';

// trusted: written by someone allowed to steer the worker (see issueSignals) — only such evidence can
// lead to a fix that goes live without the owner looking at it
export interface Signal { key: string; revision: string; kind: string; title: string; detail: string; priority: number; issue?: number; trusted?: boolean }
export interface Seen { revision: string; attempts: number; nextAt: number; lastAt: number; outcome: string }
// tainted: the checkout last served untrusted evidence (its node_modules or ignored files may have been
// changed by that run) — a trusted run starts from a clean install
export interface State { seen: Record<string, Seen>; lastScan: number; tainted?: boolean; pending?: unknown }
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

/**
 * Open GitHub issues as signals. The repository is public: anyone can open an issue or comment on one,
 * so only issues opened by `trusted` GitHub accounts (the owner's, by default) are trusted, and of
 * their comments only those by trusted accounts are passed on. GitHub vouches for the author — a
 * signature in the text would be anyone's to copy. The revision follows the text passed on, so a
 * stranger's comment does not reopen the owner's issue.
 */
export function issueSignals(issues: any[], trusted: Set<string>): Signal[] {
  const signals: Signal[] = [];
  const by = (x: any) => trusted.has(String(x?.author?.login ?? '').toLowerCase());
  for (const i of issues) {
    const labels = i.labels.map((l: any) => l.name);
    if (labels.some((l: string) => ['wontfix', 'duplicate', 'maintenance-ignore'].includes(l))) continue;
    const ok = by(i);
    const comments = (i.comments ?? []).filter((c: any) => !ok || by(c)).slice(-5).map((c: any) => ({ body: c.body }));
    const title = privateText(i.title, 300), detail = privateText(JSON.stringify({ body: i.body, labels, comments }));
    signals.push({ key: `issue:${i.number}`, revision: digest(`${title}\n${detail}`), issue: i.number, kind: 'github-issue',
      priority: labels.includes('bug') ? 0 : 1, title, detail, trusted: ok });
  }
  return signals;
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
// the GitHub accounts whose issues may steer the worker (comma-separated logins; the repository's owner)
const trustedLogins = new Set((process.env.OVERLYX_MAINTENANCE_TRUSTED ?? repo.split('/')[0]).split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
// ready fixes for root's promoter (maint-promote.ts reads them as this account)
const outbox = path.join(stateDir, 'outbox');
const log = (s: string) => console.log(`[maintenance] ${s}`);
function command(bin: string, args: string[], cwd = root, timeout = 60000): string {
  return execFileSync(bin, args, { cwd, timeout, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
// (no hooks or fsmonitor from the checkout: Codex works in it, the runner commits in it)
const git = (args: string[]) => command('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], checkout);
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
    kind: r.kind, title: privateText(r.title, 300), detail: privateText(`Report #${r.id}; release ${r.version}; occurrences ${r.count}\n${r.body}`), priority: r.kind === 'feedback' ? 2 : 3, trusted: false });
  const usage = usageSummary(db, { sinceMs: since, top: 20 });
  for (const [kind, rows] of [['usage-error', usage.errors], ['interaction-trail', usage.interactions.problemTrails]] as const) {
    for (const r of rows) signals.push({ key: `${kind}:${digest(r.key)}`, revision: countRevision(r.count), kind,
      title: privateText(r.key, 400), detail: `${r.count} occurrences in ${r.sessions} anonymous sessions. These are signals, not confirmed bugs.`, priority: kind === 'usage-error' ? 3 : 5, trusted: false });
  }
  // LaTeX the editor could only show as TeX code, met in several anonymous sessions: a candidate for
  // drawing it (scripts/maintenance-prompt.txt says how to judge one). Trusted: only a name that
  // passed the pattern below and fixed words reach the worker.
  for (const r of usage.macros.listed.slice(0, 10)) {
    const [kind, name] = r.key.split(' ');
    if (!/^(math|env|text)$/.test(kind) || !/^\\?[A-Za-z]{2,32}\*?$/.test(name ?? '')) continue;
    signals.push({ key: `unrendered-macro:${r.key}`, revision: countRevision(r.sessions), kind: 'unrendered-macro',
      title: `${kind === 'env' ? `\\begin{${name}}` : name} shown as TeX code (${kind === 'text' ? 'a TeX-code box in the text' : 'in formulas'})`,
      detail: `${r.count} times in ${r.sessions} anonymous sessions. Judge whether OverLyX should draw it (see the unrendered-macro rules in your instructions); if so, implement the rendering; if not, answer no_fix.`, priority: 7, trusted: true });
  }
  for (const r of usage.suspicious.slice(0, 10)) {
    if (r.failed + r.repeated + r.undone < 3) continue;
    signals.push({ key: `usage-action:${digest(r.key)}`, revision: countRevision(r.failed + r.repeated + r.undone), kind: 'usage-action',
      title: privateText(r.key, 400), detail: JSON.stringify({ count: r.count, sessions: r.sessions, failed: r.failed, repeated: r.repeated, undone: r.undone, where: r.where }), priority: 6, trusted: false });
  }
  return signals;
}

async function collect(lastScan: number): Promise<Signal[]> {
  const signals: Signal[] = [];
  const failures: string[] = [];
  try {
    const issues = JSON.parse(command('gh', ['issue', 'list', '-R', repo, '--state', 'open', '--limit', '100', '--json', 'number,title,body,updatedAt,labels,comments,author']));
    signals.push(...issueSignals(issues, trustedLogins));
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
      if (!/error|exception|unhandled|failed|fatal|withheld/i.test(line)) continue;
      const template = privateText(line, 500).replace(/\b[\da-f]{8,}\b/gi, '#').replace(/\d+/g, '#');
      const lines = groups.get(template) ?? []; lines.push(privateText(line, 1200)); groups.set(template, lines);
    }
    for (const [title, lines] of groups) signals.push({ key: `journal:${digest(title)}`, revision: '1', kind: 'server-log', priority: 4, title, detail: lines.slice(-5).join('\n'), trusted: false });
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

function prepareCheckout(state: State, trusted: boolean) {
  const origin = process.env.OVERLYX_MAINTENANCE_ORIGIN ?? command('git', ['remote', 'get-url', 'origin'], source);
  if (!fs.existsSync(path.join(checkout, '.git'))) {
    // fetched anonymously (the repository is public): the worker has no GitHub key
    command('git', ['clone', '--quiet', '--no-checkout', origin, checkout]);
    git(['checkout', '-B', 'master', 'origin/master']);
    git(['config', 'user.name', 'OverLyX']); git(['config', 'user.email', 'overlyx@localhost']);
  }
  git(['remote', 'set-url', 'origin', origin]);
  git(['fetch', 'origin', '--quiet']);
  // Only this worker owns this checkout. Archive failed/unfinished work before resynchronizing.
  const dirty = git(['status', '--porcelain']);
  const ahead = git(['rev-list', '--count', 'origin/master..HEAD']);
  if (dirty || ahead !== '0') {
    git(['add', '-A']);
    fs.writeFileSync(path.join(stateDir, `unfinished-${Date.now()}.patch`), git(['diff', '--cached', '--binary', 'origin/master']));
    git(['reset', '--hard', 'origin/master']);
  } else git(['merge', '--ff-only', 'origin/master']);
  const marker = path.join(checkout, '.git', 'maintenance-dependencies');
  // (no record: the runs before trust was marked all served evidence anyone could write)
  if (trusted && state.tainted !== false) {
    // a run on untrusted evidence could write anywhere in the checkout but .git — node_modules too
    log('starting from a clean install after a run on untrusted evidence');
    fs.rmSync(marker, { force: true });
    git(['clean', '-ffdxq']);
  } else git(['clean', '-ffdq']);
  // Hardlinks, not node_modules symlinks: workspace packages and ProseMirror must resolve here.
  const lock = digest(fs.readFileSync(path.join(checkout, 'package-lock.json'), 'utf8'));
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
  if (trusted) state.tainted = false;
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
      child.stdin!.on('error', () => {}); child.stdin!.end(input);
    });
  } finally { fs.closeSync(fd); }
}

const resultSchema = { type: 'object', additionalProperties: false, properties: {
  outcome: { type: 'string', enum: ['fixed', 'no_fix', 'defer'] }, summary: { type: 'string' }, checks: { type: 'array', items: { type: 'string' } },
}, required: ['outcome', 'summary', 'checks'] };

// Handing over: the commit, as a patch, goes into the outbox; root's promoter (maint-promote.ts) applies
// it to origin/master and either pushes it (trusted evidence, within the fixed rules, passed review) or
// queues it for the owner. The runner's claim of which signal it fixed is checked there against root's
// own record of the evidence.
function handOver(signal: Signal, result: { summary: string; checks: string[] }) {
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${digest(signal.key).slice(0, 8)}`;
  const entry = { id, created: Date.now(), base: git(['rev-parse', 'origin/master']),
    signal: { key: signal.key, kind: signal.kind, issue: signal.issue, trusted: !!signal.trusted },
    summary: privateText(result.summary, 2000), checks: result.checks.slice(0, 20).map(c => privateText(c, 300)),
    patch: git(['format-patch', '-1', '--stdout', '--binary', 'HEAD']) };
  fs.mkdirSync(outbox, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(outbox, `${id}.json.new`), JSON.stringify(entry));
  fs.renameSync(path.join(outbox, `${id}.json.new`), path.join(outbox, `${id}.json`));
  git(['reset', '--hard', '--quiet', 'origin/master']);
  log(`handed over ${signal.key} as ${id} (${signal.trusted ? 'trusted' : 'untrusted'} evidence)`);
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
  if (state.pending) { log('dropping a pending push from before the outbox (the next run archives its commit)'); delete state.pending; }
  const signals = inbox ? collected(inbox) : await collect(state.lastScan);
  const now = Date.now();
  const queue = signals.filter(s => eligible(s, state.seen[s.key], now)).sort((a, b) => a.priority - b.priority);
  log(`screened ${signals.length} signals; ${queue.length} new or retryable`);
  state.lastScan = now;
  for (const [key, s] of Object.entries(state.seen)) if (now - s.lastAt > 90 * 86400000) delete state.seen[key];
  save(state);
  if (process.argv.includes('--scan') || !queue.length) return;
  const signal = queue[0];
  prepareCheckout(state, !!signal.trusted);
  if (!signal.trusted) state.tainted = true;
  save(state);
  const runDir = path.join(stateDir, 'runs', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  // Keep at most 30 private run transcripts. No trace or report is written inside the repository.
  const runs = fs.readdirSync(path.dirname(runDir)).sort();
  for (const old of runs.slice(0, -30)) fs.rmSync(path.join(path.dirname(runDir), old), { recursive: true, force: true });
  // a run on trusted evidence sees only trusted context: untrusted text could steer it as well
  const related = signals.filter(s => s.key !== signal.key && (!signal.trusted || s.trusted)).slice(0, 12);
  fs.writeFileSync(path.join(runDir, 'input.json'), JSON.stringify({ signal, related }, null, 2));
  fs.writeFileSync(path.join(runDir, 'schema.json'), JSON.stringify(resultSchema));
  const prompt = fs.readFileSync(path.join(root, 'scripts/maintenance-prompt.txt'), 'utf8') + `\nPrivate evidence: ${path.join(runDir, 'input.json')}\n`;
  // Record the attempt before starting, so a killed run does not produce an immediate retry storm.
  state.seen[signal.key] = finish(signal, state.seen[signal.key], 'retry', now); save(state);
  log(`investigating ${signal.kind} (${signal.key}, ${signal.trusted ? 'trusted' : 'untrusted'})`);
  try {
    // Commands Codex runs get no network: nothing it reads can be sent anywhere (the runner installs
    // dependencies itself, outside the sandbox).
    await loggedProcess('codex', ['exec', '--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=false', '-c', 'approval_policy="never"',
      '--json', '--output-schema', path.join(runDir, 'schema.json'), '--output-last-message', path.join(runDir, 'result.json'), '-'],
      path.join(runDir, 'agent.jsonl'), 15 * 60000, prompt);
    const result = JSON.parse(fs.readFileSync(path.join(runDir, 'result.json'), 'utf8'));
    if (!['fixed', 'no_fix', 'defer'].includes(result.outcome) || !Array.isArray(result.checks)) throw new Error('Invalid worker result');
    if (result.outcome === 'fixed' && git(['status', '--porcelain'])) {
      git(['add', '-A']); git(['diff', '--cached', '--check']);
      const leaked = secretReasons(git(['diff', '--cached', '--binary']));
      if (leaked.length) {
        log(`refusing ${signal.key}: the change ${leaked.join(', ')}`);
        git(['reset', '--hard', '--quiet', 'HEAD']);
        state.seen[signal.key].outcome = 'blocked'; save(state); return;
      }
      git(['commit', '--quiet', '-m', 'Fix production issue discovered by maintenance worker', ...(signal.issue ? ['-m', `Fixes #${signal.issue}`] : []),
        '-m', `Maintenance-signal: ${signal.key}\nDeploy: no-checks`]);
      handOver(signal, result);
      state.seen[signal.key].outcome = 'fixed'; save(state);
    } else {
      state.seen[signal.key].outcome = result.outcome === 'defer' ? 'retry' : 'no_fix'; save(state);
      log(`finished ${signal.key}: ${result.outcome}`);
    }
  } catch (e) { log(String(e)); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { log(String(e)); process.exitCode = 1; });
}
