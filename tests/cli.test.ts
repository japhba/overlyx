/**
 * The gh-like CLI against the real Basic-authenticated repository API and smart-HTTP backend:
 * login stores a Git token securely, repo push turns an ordinary directory into a repository,
 * creates an unborn OverLyX project, and pushes without writing the secret into .git/config.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import express from 'express';

const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-cli-test');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'projects'), { recursive: true });
mkdirSync(join(ROOT, 'source'), { recursive: true });
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');

const gitmod = await import('../packages/server/src/git.ts');
const { createUser } = await import('../packages/server/src/auth.ts');
const { createMcpToken } = await import('../packages/server/src/mcpTokens.ts');
const { cliDownloadRoutes } = await import('../packages/server/src/cliDownload.ts');
const CLI = fileURLToPath(new URL('../packages/cli/bin/overlyx.js', import.meta.url));
const execFileP = promisify(execFile);

const user = createUser('ada', 'Ada Lovelace', 'password');
const token = gitmod.createToken(user.id, 'OverLyX CLI').token;
const app = express();
app.use(cliDownloadRoutes());
app.use('/git', gitmod.gitRouter());
const server = http.createServer(app);
let host = '';

const cli = async (...args: string[]) => execFileP(process.execPath, [CLI, ...args], {
  encoding: 'utf8',
  env: {
    ...process.env,
    OVERLYX_CONFIG_DIR: join(ROOT, 'config'),
    GIT_CONFIG_NOSYSTEM: '1',
  },
});
const localGit = async (...args: string[]) => (await execFileP('git', ['-C', join(ROOT, 'source'), ...args], { encoding: 'utf8' })).stdout.trim();

beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  host = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  writeFileSync(join(ROOT, 'source', 'main.tex'), '\\documentclass{article}\n\\begin{document}\nHello from an existing folder.\n\\end{document}\n');
  mkdirSync(join(ROOT, 'source', 'figures'));
  writeFileSync(join(ROOT, 'source', 'figures', 'result.txt'), '42\n');
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(ROOT, { recursive: true, force: true });
});

describe('OverLyX CLI', () => {
  it('installs from the public, checksummed curl endpoint', async () => {
    const installDir = join(ROOT, 'bin');
    const installed = await execFileP('sh', ['-c', 'curl -fsSL "$OVERLYX_ORIGIN/install-cli.sh" | sh'], {
      encoding: 'utf8',
      env: { ...process.env, OVERLYX_ORIGIN: host, OVERLYX_INSTALL_DIR: installDir },
    });
    expect(installed.stdout).toContain('Installed OverLyX CLI 0.1.0');
    expect(statSync(join(installDir, 'overlyx')).mode & 0o777).toBe(0o755);
    expect(existsSync(join(installDir, 'olx'))).toBe(true);
    expect((await execFileP(join(installDir, 'overlyx'), ['--version'], { encoding: 'utf8' })).stdout.trim()).toBe('0.1.0');
  });

  it('logs in, creates a project, and pushes an existing non-Git folder', async () => {
    const login = await cli('auth', 'login', '--host', host, '--username', 'ada', '--token', token);
    expect(login.stdout).toContain(`Logged in to ${host} as ada`);
    const config = join(ROOT, 'config', 'hosts.json');
    expect(statSync(config).mode & 0o777).toBe(0o600);
    expect(readFileSync(config, 'utf8')).toContain(token);

    const pushed = await cli('repo', 'push', join(ROOT, 'source'), '--name', 'Imported paper');
    expect(pushed.stdout).toContain('Created project "ada/Imported paper"');   // in the account's namespace
    expect(pushed.stdout).toContain('Pushed');
    expect(readFileSync(join(ROOT, 'projects', 'ada', 'Imported paper', 'main.tex'), 'utf8')).toContain('Hello from an existing folder.');
    expect(readFileSync(join(ROOT, 'projects', 'ada', 'Imported paper', 'figures', 'result.txt'), 'utf8')).toBe('42\n');
    expect(existsSync(join(ROOT, 'projects', 'ada', 'Imported paper', '.git'))).toBe(true);
    expect(await localGit('log', '-1', '--format=%s')).toBe('Import "Imported paper" into OverLyX');
    const remote = await localGit('remote', 'get-url', 'overlyx');
    expect(remote).toContain('ada@127.0.0.1');
    expect(remote).not.toContain(token);
  });

  it('lists projects and can safely retry a push to an existing editable project', async () => {
    const listed = await cli('repo', 'list');
    expect(listed.stdout).toContain('ada/Imported paper\towner');
    // the key form (`<username>/<name>`) names the same project
    const retried = await cli('repo', 'push', join(ROOT, 'source'), '--name', 'ada/Imported paper');
    expect(retried.stdout).toContain('Using project "ada/Imported paper"');
    expect(retried.stdout).toContain('Pushed');
  });

  it('preserves an existing Git history and rejects dirty work before remote creation', async () => {
    const source = join(ROOT, 'with-history');
    mkdirSync(source);
    writeFileSync(join(source, 'paper.tex'), 'First committed version.\n');
    await execFileP('git', ['-C', source, 'init', '-q', '-b', 'draft']);
    await execFileP('git', ['-C', source, 'add', '-A']);
    await execFileP('git', ['-C', source, '-c', 'user.name=Local Author', '-c', 'user.email=local@example.test', 'commit', '-q', '-m', 'The existing history']);

    await cli('repo', 'create', 'History import', '--source', source, '--push');
    const subject = (await execFileP('git', ['-C', join(ROOT, 'projects', 'ada', 'History import'), 'log', '-1', '--format=%s'], { encoding: 'utf8' })).stdout.trim();
    expect(subject).toBe('The existing history');

    writeFileSync(join(source, 'paper.tex'), 'Uncommitted work.\n');
    await expect(cli('repo', 'push', source, '--name', 'Should not exist'))
      .rejects.toMatchObject({ stderr: expect.stringContaining('uncommitted files') });
    expect(existsSync(join(ROOT, 'projects', 'ada', 'Should not exist'))).toBe(false);
  });

  it('validates credentials during login', async () => {
    await expect(cli('auth', 'login', '--host', host, '--username', 'ada', '--token', 'olx_bad'))
      .rejects.toMatchObject({ stderr: expect.stringContaining('Invalid username or token/password') });
  });

  it('keeps accepting a legacy agent credential, but not an expired OAuth credential', async () => {
    const agent = createMcpToken(user.id, 'CLI agent').token;
    const login = await cli('auth', 'login', '--host', host, '--username', 'ada', '--token', agent);
    expect(login.stdout).toContain('Logged in');
    expect((await cli('repo', 'list')).stdout).toContain('ada/Imported paper\towner');

    const expired = createMcpToken(user.id, 'expired', false, Date.now() - 1).token;
    await expect(cli('auth', 'login', '--host', host, '--username', 'ada', '--token', expired))
      .rejects.toMatchObject({ stderr: expect.stringContaining('Invalid username or token/password') });
  });
});
