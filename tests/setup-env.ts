/**
 * What every test file starts with (vitest.config.ts setupFiles), so that `npm test` means the same
 * from every account on the box — root, `jan`, the autodeploy's checker — and none touches the others' files:
 *
 * - LyX's layouts: core's default is /root/lyx/lib/layouts, unreadable but to root (sections then parse
 *   as Standard, ~77 tests failed as `jan`). Unless LYX_LAYOUT_DIR is set: the repo's `lyx` submodule,
 *   else the LyX tree the repo sits in (~/lyx/overlyx → ~/lyx/lib), else ~/lyx/lib (a worktree elsewhere),
 *   else root's.
 * - Scratch space: tests keep fixed names under os.tmpdir() (overlyx-welcome-test, …); /tmp holds
 *   thousands of root's, which another account can neither reuse nor delete. Each account gets its own
 *   directory under the temporary one.
 * - No instance's configuration: a shell (or the autodeploy's unit) that carries an instance's OVERLYX_*
 *   settings handed them to every test — OVERLYX_GIT=off failed 40 git/sync/mirror tests, *_STATS=off the
 *   usage routes, and a test relying on config.ts's throw-away defaults would have used that instance's
 *   OVERLYX_DATA_DIR. Only the tests' own knobs pass; a test sets what it needs itself.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const TEST_KNOBS = /^OVERLYX_(?:SCRATCH|FUZZ_\w+|COLLAB_DIFF_STEPS|TEST_\w+)$/;
for (const k of Object.keys(process.env)) if (k.startsWith('OVERLYX_') && !TEST_KNOBS.test(k)) delete process.env[k];

if (!process.env.LYX_LAYOUT_DIR) {
  const dir = [path.join(repo, 'lyx/lib/layouts'), path.join(repo, '../lib/layouts'), path.join(os.homedir(), 'lyx/lib/layouts'), '/root/lyx/lib/layouts']
    .find(d => { try { return fs.existsSync(path.join(d, 'stdclass.inc')); } catch { return false; } });
  if (dir) process.env.LYX_LAYOUT_DIR = dir;
}

const base = os.tmpdir();
const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
if (!path.basename(base).startsWith('overlyx-tests-')) {
  const mine = path.join(base, `overlyx-tests-${uid}`);
  try { fs.mkdirSync(mine, { recursive: true, mode: 0o700 }); process.env.TMPDIR = mine; } catch { /* keep the one we have */ }
}
