import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// as in the extension's bundle (esbuild defines it): the CLI that sync.ts imports does not run its command line
vi.hoisted(() => { process.env.OVERLYX_CLI_LIBRARY = '1'; });
vi.mock('vscode', () => ({}));
import { nestedClones } from '../packages/vscode/src/host/sync.ts';

let root: string;
const repo = (rel: string, gitFile = false) => {
  const dir = path.join(root, rel);
  fs.mkdirSync(dir, { recursive: true });
  if (gitFile) fs.writeFileSync(path.join(dir, '.git'), 'gitdir: ../../.git/modules/paper\n');
  else fs.mkdirSync(path.join(dir, '.git'));
};

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'overlyx-nested-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('clones inside a workspace folder (host/sync.ts nestedClones)', () => {
  it('finds clones up to three levels down, a submodule by its .git file, not the folder itself', async () => {
    repo('.');                               // the folder is a repository itself (the code's): not reported
    repo('writeup');                         // depth 1
    repo('code/papers/icml', true);          // depth 3, a submodule (.git is a file)
    repo('a/b/c/too-deep');                  // depth 4: left to the open-a-file path
    fs.mkdirSync(path.join(root, 'empty/dir'), { recursive: true });
    expect((await nestedClones(root)).map(d => path.relative(root, d)).sort()).toEqual(['code/papers/icml', 'writeup']);
  });

  it('does not search hidden, dependency or build directories, a clone\'s inside, or symlinks', async () => {
    repo('node_modules/pkg');
    repo('.cache/thing');
    repo('dist/x');
    repo('paper');
    repo('paper/vendor/inner');              // inside a clone: that clone's files
    fs.symlinkSync(root, path.join(root, 'loop'));
    fs.symlinkSync(path.join(root, 'paper'), path.join(root, 'paper-link'));
    expect((await nestedClones(root)).map(d => path.relative(root, d))).toEqual(['paper']);
  });

  it('passes over a directory it cannot read', async () => {
    repo('ok');
    fs.mkdirSync(path.join(root, 'locked/inside'), { recursive: true });
    repo('locked/inside/paper');
    fs.chmodSync(path.join(root, 'locked'), 0o000);
    try {
      const found = (await nestedClones(root)).map(d => path.relative(root, d));
      expect(found).toContain('ok');
      if (process.getuid?.() !== 0) expect(found).not.toContain('locked/inside/paper');
    } finally { fs.chmodSync(path.join(root, 'locked'), 0o755); }
  });
});
