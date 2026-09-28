/**
 * Hardening against a project's own contents turning a server-side operation into code execution or
 * a host-file read (packages/server: projects.ts, git.ts, sandbox.ts, export.ts). The project files
 * are user-editable, so:
 *  - no write route may create or reach a repository's `.git` (a `.git/config` or hook would run as
 *    the server user on the next git operation) — assertWritableRelPath;
 *  - even if a `.git/config` existed, gitEnv's command-level config disables hooks and fsmonitor;
 *  - a LaTeX build cannot read /etc/shadow or the host's SSH keys (they are not in the sandbox), yet
 *    the TeX distribution's own config under /etc still is.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertWritableRelPath } from '../packages/server/src/projects.ts';
import { gitEnv } from '../packages/server/src/git.ts';
import { sandboxed } from '../packages/server/src/sandbox.ts';

const haveBwrap = ['/usr/bin/bwrap', '/usr/local/bin/bwrap'].some(existsSync);
const haveGit = spawnSync('git', ['--version']).status === 0;

describe('writable path guard', () => {
  it('rejects any path that reaches into .git or escapes the project', () => {
    for (const bad of [
      '.git', '.git/config', '.git/hooks/pre-commit', 'sub/.git/config',
      '.GIT/config', '.Git/hooks/x', 'git~1/config',        // case- and 8.3-short-name variants
      '..', '../x', 'a/../../b', '', 'a//../.git',
    ]) expect(() => assertWritableRelPath(bad), bad).toThrow();
  });
  it('allows ordinary files, including git-adjacent tracked ones', () => {
    for (const ok of [
      'main.tex', 'figures/plot.png', 'sub/dir/paper.tex',
      '.gitignore', '.gitattributes', '.gitmodules',        // real tracked files, not the .git dir
      'notes.git.tex',
    ]) expect(() => assertWritableRelPath(ok), ok).not.toThrow();
  });
});

describe.skipIf(!haveGit)('gitEnv neutralises a hostile repository config', () => {
  it('does not run core.fsmonitor or hooks set in .git/config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ol-gitenv-'));
    try {
      const repo = join(dir, 'repo');
      const home = join(dir, 'home');
      mkdirSync(repo, { recursive: true });
      mkdirSync(home, { recursive: true });
      const id = ['-c', 'user.email=a@b', '-c', 'user.name=a'];
      const g = (...args: string[]) => spawnSync('git', ['-C', repo, ...id, ...args], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
      g('init', '-q');
      writeFileSync(join(repo, 'a.tex'), 'x\n');
      g('add', '-A'); g('commit', '-qm', 'init');
      // a hostile repository config: fsmonitor is a program git would launch on add
      const marker = join(dir, 'MARKER');
      appendFileSync(join(repo, '.git', 'config'), `[core]\n\tfsmonitor = "touch ${marker}; false"\n`);
      writeFileSync(join(repo, 'a.tex'), 'x\ny\n');
      // add through gitEnv: command-level core.fsmonitor=false overrides the repo config
      const r = spawnSync('git', ['-C', repo, ...id, 'add', '-A'], { env: gitEnv(), encoding: 'utf8', timeout: 30000 });
      expect(r.status).toBe(0);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!haveBwrap)('the build sandbox hides host secrets but keeps the TeX distribution', () => {
  it('cannot read /etc/shadow or /etc/ssh, can read /etc/texmf and /etc/fonts', () => {
    const rwDir = mkdtempSync(join(tmpdir(), 'ol-etc-'));
    try {
      const script = [
        'cat /etc/shadow >/dev/null 2>&1 && echo SHADOW-LEAK || echo shadow-blocked',
        'ls /etc/ssh >/dev/null 2>&1 && echo SSH-LEAK || echo ssh-blocked',
        'test -f /etc/texmf/web2c/texmf.cnf && echo texmf-ok || echo TEXMF-MISSING',
        'test -d /etc/fonts && echo fonts-ok || echo FONTS-MISSING',
      ].join('; ');
      const s = sandboxed('sh', ['-c', script], { rw: [rwDir], cwd: rwDir, env: {} });
      const r = spawnSync(s.cmd, s.args, { env: s.env, encoding: 'utf8' });
      expect(r.stdout).toContain('shadow-blocked');
      expect(r.stdout).toContain('ssh-blocked');
      expect(r.stdout).toContain('texmf-ok');
      expect(r.stdout).toContain('fonts-ok');
      expect(r.stdout).not.toContain('LEAK');
    } finally {
      rmSync(rwDir, { recursive: true, force: true });
    }
  });
});
