import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Report only failure categories, never potentially sensitive log contents. */
export function assertServerHealthy(server, log) {
  if (!server || server.spawnError || server.exitCode !== null || server.signalCode !== null) throw new Error('Isolated release server is not running. Inspect the private server log.');
  const patterns = [
    ['server exception', /\[server\].*(?:unhandled rejection|uncaught exception)/i],
    ['document worker failure', /\[docs\].*document workers?.*(?:failed|exited|keep dying)/i],
    ['native move repair failure', /\[moves\].*(?:repair failed|could not place|nowhere to put|pruning failed)/i],
    ['Node process or thread failure', /\b(?:ERR_WORKER_[A-Z_]+|ERR_MEMORY_ALLOCATION_FAILED|EAGAIN|JavaScript heap out of memory|FATAL ERROR:)|Assertion.*uv_thread_create/i],
  ];
  const failures = patterns.filter(([, pattern]) => pattern.test(log)).map(([name]) => name);
  if (failures.length) throw new Error(`Isolated release server reported ${failures.join(', ')}. Inspect the private server log.`);
}

export function assertCleanCheckout(repo, expectedCommit) {
  let dirty, commit;
  try {
    dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (expectedCommit) commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch { throw new Error('Could not inspect the release checkout.'); }
  if (dirty) throw new Error('Commit all tracked and untracked source changes before deploying.');
  if (expectedCommit && commit !== expectedCommit) throw new Error('The release checkout changed after validation.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] !== 'clean' || !process.argv[3]) throw new Error('Usage: node scripts/release-guards.mjs clean <checkout> [expected-commit]');
    assertCleanCheckout(process.argv[3], process.argv[4]);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
