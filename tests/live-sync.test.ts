import { beforeEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { syncLiveCheckout, liveStatusPath } from '../packages/vscode/scripts/live-sync.mjs';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let remote: string, local: string;
const commit = (repo: string, file: string, content: string) => { fs.writeFileSync(path.join(repo, file), content); git(repo, 'add', file); git(repo, 'commit', '-m', file); };
beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlyx-live-sync-'));
  remote = path.join(dir, 'upstream'); local = path.join(dir, 'live');
  fs.mkdirSync(remote); git(remote, 'init', '-b', 'master');
  git(remote, 'config', 'user.name', 'Live test'); git(remote, 'config', 'user.email', 'live@example.invalid');
  commit(remote, 'document.txt', 'Initial\n'); git(dir, 'clone', remote, local);
  git(local, 'config', 'user.name', 'Live test'); git(local, 'config', 'user.email', 'live@example.invalid');
});

it('fast-forwards a clean checkout to the exact upstream commit without creating local history', async () => {
  commit(remote, 'upstream.txt', 'New editor feature\n');
  const upstream = git(remote, 'rev-parse', 'HEAD');
  const result = await syncLiveCheckout(local, { validate(candidate: string) { expect(candidate).toBe(upstream); } });
  expect(result.status).toBe('updated');
  expect(git(local, 'rev-parse', 'HEAD')).toBe(upstream);
  expect(git(local, 'rev-list', '--count', 'origin/master..HEAD')).toBe('0');
});

it('integrates upstream while retaining local commits, after validating the exact candidate', async () => {
  commit(local, 'local.txt', 'Local live fixes\n'); commit(remote, 'upstream.txt', 'New editor feature\n');
  let checked: string;
  const result = await syncLiveCheckout(local, { validate(candidate: string) {
    checked = candidate;
    expect(git(local, 'show', `${candidate}:local.txt`)).toBe('Local live fixes');
    expect(git(local, 'show', `${candidate}:upstream.txt`)).toBe('New editor feature');
    expect(fs.existsSync(path.join(local, 'upstream.txt'))).toBe(false);
  }, afterApply() { return { vsixPath: '/cache/new-live.vsix', artifactHead: checked! }; } });
  expect(result.status).toBe('updated'); expect(git(local, 'rev-parse', 'HEAD')).toBe(checked!);
  expect(JSON.parse(fs.readFileSync(liveStatusPath(local), 'utf8')).upstream).toBe(git(remote, 'rev-parse', 'HEAD'));
  const next = await syncLiveCheckout(local, { validate() { throw new Error('Already current'); } });
  expect(next.status).toBe('up-to-date');
  expect(next.vsixPath).toBe('/cache/new-live.vsix');
  expect(next.artifactHead).toBe(checked!);
});

it('leaves dirty edits and untracked files untouched and reports that updates are blocked', async () => {
  commit(remote, 'upstream.txt', 'New\n');
  fs.writeFileSync(path.join(local, 'document.txt'), 'Unsaved source edit\n');
  fs.writeFileSync(path.join(local, 'draft.txt'), 'Untracked work\n');
  const head = git(local, 'rev-parse', 'HEAD');
  expect((await syncLiveCheckout(local, { validate() { throw new Error('Must not build dirty source'); } })).status).toBe('blocked');
  expect(git(local, 'rev-parse', 'HEAD')).toBe(head);
  expect(fs.readFileSync(path.join(local, 'document.txt'), 'utf8')).toBe('Unsaved source edit\n');
  expect(fs.readFileSync(path.join(local, 'draft.txt'), 'utf8')).toBe('Untracked work\n');
});

it('reports a merge conflict without leaving the running checkout in a merge', async () => {
  commit(local, 'document.txt', 'Local\n'); commit(remote, 'document.txt', 'Upstream\n');
  const result = await syncLiveCheckout(local, { validate() { throw new Error('Cannot validate conflict'); } });
  expect(result.status).toBe('blocked'); expect(result.reason).toContain('conflicts');
  expect(git(local, 'status', '--porcelain')).toBe('');
  expect(fs.readFileSync(path.join(local, 'document.txt'), 'utf8')).toBe('Local\n');
});

it('keeps the running version when validation fails', async () => {
  commit(remote, 'upstream.txt', 'Broken feature\n'); const head = git(local, 'rev-parse', 'HEAD');
  await expect(syncLiveCheckout(local, { validate() { throw new Error('Build failed'); } })).rejects.toThrow('Build failed');
  expect(git(local, 'rev-parse', 'HEAD')).toBe(head);
  expect(JSON.parse(fs.readFileSync(liveStatusPath(local), 'utf8')).status).toBe('error');
});

it('rechecks for edits made during validation before publishing the candidate', async () => {
  commit(remote, 'upstream.txt', 'New feature\n'); const head = git(local, 'rev-parse', 'HEAD');
  const result = await syncLiveCheckout(local, { validate() { fs.writeFileSync(path.join(local, 'document.txt'), 'Written during build\n'); } });
  expect(result.status).toBe('blocked'); expect(git(local, 'rev-parse', 'HEAD')).toBe(head);
  expect(fs.readFileSync(path.join(local, 'document.txt'), 'utf8')).toBe('Written during build\n');
});

it('retries activation failures instead of later claiming an unbuilt update is current', async () => {
  commit(remote, 'upstream.txt', 'New feature\n');
  await expect(syncLiveCheckout(local, { validate() {}, afterApply() { throw new Error('Dependency install interrupted'); } })).rejects.toThrow('Dependency install interrupted');
  const integrated = git(local, 'rev-parse', 'HEAD');
  expect(JSON.parse(fs.readFileSync(liveStatusPath(local), 'utf8')).activationPending).toBe(true);
  let activated = false;
  const result = await syncLiveCheckout(local, { validate(candidate: string) { expect(candidate).toBe(integrated); }, afterApply() { activated = true; } });
  expect(activated).toBe(true); expect(result.status).toBe('updated'); expect(result.activationPending).toBe(false);
  expect(git(local, 'rev-parse', 'HEAD')).toBe(integrated);
});
