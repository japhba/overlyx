/** Fetch and validate upstream before advancing a live checkout. Never stash or overwrite edits. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export const liveStatusPath = repo => git(repo, 'rev-parse', '--path-format=absolute', '--git-path', 'overlyx-live-status.json');
const clean = repo => git(repo, 'status', '--porcelain', '--untracked-files=all') === '';

export async function syncLiveCheckout(repo, { validate, beforeApply = () => {}, afterApply = () => {} }) {
  const statusPath = liveStatusPath(repo);
  const previous = fs.existsSync(statusPath) ? JSON.parse(fs.readFileSync(statusPath, 'utf8')) : {};
  let artifact = { vsixPath: previous.vsixPath, artifactHead: previous.artifactHead };
  let head, upstream;
  const report = (status, reason) => {
    const result = { status, reason, head, upstream, ...artifact, checkedAt: new Date().toISOString() };
    fs.writeFileSync(statusPath + '.tmp', JSON.stringify(result, null, 2) + '\n');
    fs.renameSync(statusPath + '.tmp', statusPath);
    return result;
  };
  try {
    head = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'fetch', 'origin', 'master');
    upstream = git(repo, 'rev-parse', 'origin/master');
    if (git(repo, 'rev-list', '--count', 'HEAD..origin/master') === '0') return report('up-to-date', 'This checkout contains all upstream commits.');
    if (!clean(repo)) return report('blocked', 'Uncommitted source edits prevent an automatic update. Commit or resolve them, then check again.');
    report('checking', 'Validating the upstream update in a separate checkout.');
    let tree;
    try { tree = git(repo, 'merge-tree', '--write-tree', head, upstream).split('\n')[0]; }
    catch (error) {
      if (error.status === 1) return report('blocked', 'Upstream conflicts with local commits. The live checkout has been left unchanged.');
      throw error;
    }
    const commit = git(repo, 'commit-tree', tree, '-p', head, '-p', upstream, '-m', `Update OverLyX Live from origin/master (${upstream.slice(0, 12)})`);
    await validate(commit);
    // The author can keep working while the candidate builds.
    if (git(repo, 'rev-parse', 'HEAD') !== head || !clean(repo)) return report('blocked', 'Source files changed during validation. The update was not applied; the next check will retry.');
    await beforeApply();
    try {
      git(repo, 'merge', '--ff-only', commit);
      head = commit;
    } finally { artifact = await afterApply() ?? artifact; }
    return report('updated', 'Upstream is integrated and rebuilt. Reload the VS Code window to load the extension host changes.');
  } catch (error) {
    report('error', String(error));
    throw error;
  }
}

async function main() {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  // Kernel-owned locking also releases correctly if a check crashes or the machine restarts.
  if (!process.argv.includes('--locked')) {
    try { execFileSync('flock', ['-n', '-E', '75', liveStatusPath(repo) + '.lock', process.execPath, fileURLToPath(import.meta.url), '--locked', ...process.argv.slice(2)], { stdio: 'inherit' }); }
    catch (error) { if (error.status !== 75) throw error; console.log(JSON.stringify({ status: 'busy', reason: 'An upstream check is already running.' })); }
    return;
  }
  const cache = path.resolve(process.env.OVERLYX_LIVE_CACHE || path.join(process.env.FAST_CACHE_DIR, 'overlyx-live'));
  fs.mkdirSync(cache, { recursive: true });
  let candidate;
  const run = (cwd, command, args, log) => execFileSync(command, args, { cwd, timeout: 600000, stdio: ['ignore', log, log] });
  const result = await syncLiveCheckout(repo, {
    validate(commit) {
      candidate = fs.mkdtempSync(path.join(cache, 'update-'));
      const checkout = path.join(candidate, 'source');
      git(repo, 'worktree', 'add', '--detach', checkout, commit);
      const log = fs.openSync(path.join(candidate, 'validation.log'), 'a');
      try {
        // Reuse the already installed LyX data only when its recorded revision matches.
        const lyx = path.join(repo, 'lyx');
        if (git(repo, 'rev-parse', `${commit}:lyx`) === git(lyx, 'rev-parse', 'HEAD')) {
          fs.rmdirSync(path.join(checkout, 'lyx'));
          fs.symlinkSync(lyx, path.join(checkout, 'lyx'));
        } else run(checkout, 'git', ['submodule', 'update', '--init', 'lyx'], log);
        run(checkout, 'npm', ['ci', '--no-audit', '--no-fund'], log);
        run(checkout, 'npm', ['run', 'build', '-w', 'packages/vscode'], log);
        run(checkout, 'node_modules/.bin/tsc', ['--noEmit', '-p', 'packages/vscode'], log);
        run(checkout, 'node_modules/.bin/tsc', ['--noEmit', '-p', 'packages/client'], log);
        run(checkout, 'node_modules/.bin/vitest', ['run', 'tests/parity.test.ts', 'tests/vscode-sync.test.ts', 'tests/bug-reports.test.ts', 'tests/vscode-host.test.ts', 'tests/editor-transactions.test.ts', 'tests/live-sync.test.ts', 'tests/vscode-live-update.test.ts'], log);
      } catch (error) { throw new Error(`Update validation failed; see ${path.join(candidate, 'validation.log')}`, { cause: error }); }
      finally { fs.closeSync(log); }
    },
    beforeApply() { if (process.argv.includes('--service')) execFileSync('systemctl', ['--user', 'stop', 'overlyx-live.service']); },
    afterApply() {
      const log = fs.openSync(path.join(candidate, 'activation.log'), 'a');
      try {
        run(repo, 'npm', ['ci', '--no-audit', '--no-fund'], log);
        run(repo, 'npm', ['run', 'build', '-w', 'packages/vscode'], log);
        const vsixPath = path.join(candidate, 'overlyx-live.vsix');
        run(repo, process.execPath, ['packages/vscode/scripts/package-live.mjs', vsixPath], log);
        return { vsixPath, artifactHead: git(repo, 'rev-parse', 'HEAD') };
      } finally {
        fs.closeSync(log);
        if (process.argv.includes('--service')) execFileSync('systemctl', ['--user', 'start', 'overlyx-live.service']);
      }
    },
  });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
