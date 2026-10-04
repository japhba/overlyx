/**
 * The gh-like CLI against the real Basic-authenticated repository API and smart-HTTP backend:
 * login stores a Git token securely, repo push turns an ordinary directory into a repository,
 * creates an unborn OverLyX project, and pushes without writing the secret into .git/config.
 * `overlyx build` compiles on the server; `overlyx restore` puts a project back to an earlier commit.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, spawnSync } from 'node:child_process';
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
const { db } = await import('../packages/server/src/db.ts');
const { createMcpToken } = await import('../packages/server/src/mcpTokens.ts');
const { cliDownloadRoutes } = await import('../packages/server/src/cliDownload.ts');
const { addMember } = await import('../packages/server/src/access.ts');
const { createOwnedProject } = await import('../packages/server/src/projectCreate.ts');
const { toSessionUser } = await import('../packages/server/src/auth.ts');
const { mcpRouter } = await import('../packages/server/src/mcp.ts');
const { cliLoginRoutes } = await import('../packages/server/src/cliLogin.ts');
const { authMiddleware, signSession } = await import('../packages/server/src/auth.ts');
const { listMcpTokens } = await import('../packages/server/src/mcpTokens.ts');
const CLI = fileURLToPath(new URL('../packages/cli/bin/overlyx.js', import.meta.url));
const CLI_VERSION = JSON.parse(readFileSync(fileURLToPath(new URL('../packages/cli/package.json', import.meta.url)), 'utf8')).version as string;
const execFileP = promisify(execFile);

const user = createUser('ada', 'Ada Lovelace', 'password');
const token = gitmod.createToken(user.id, 'OverLyX CLI').token;
const app = express();
app.use(authMiddleware);
app.use(cliDownloadRoutes());
app.use(cliLoginRoutes());
app.use('/git', gitmod.gitRouter());
app.use('/mcp', mcpRouter());
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
const serverFile = (...p: string[]) => join(ROOT, 'projects', ...p);
const gitIn = async (dir: string, ...args: string[]) => (await execFileP('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, OVERLYX_CONFIG_DIR: join(ROOT, 'config'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();
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
    expect(installed.stdout).toContain(`Installed OverLyX CLI ${CLI_VERSION}`);
    expect(statSync(join(installDir, 'overlyx')).mode & 0o777).toBe(0o755);
    expect(existsSync(join(installDir, 'olx'))).toBe(true);
    expect((await execFileP(join(installDir, 'overlyx'), ['--version'], { encoding: 'utf8' })).stdout.trim()).toBe(CLI_VERSION);
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

describe('overlyx build / restore: the server compiles and steps back', () => {
  const bob = createUser('bob', 'Bob Builder', 'password');
  const THESIS = '\\documentclass{article}\n\\begin{document}\nFirst line of the thesis.\n\\end{document}\n';

  beforeAll(async () => {
    await cli('auth', 'login', '--host', host, '--username', 'ada', '--token', token);
    createOwnedProject('thesis', user.id);
    writeFileSync(serverFile('ada', 'thesis', 'main.tex'), THESIS);
    await gitmod.ensureRepo('ada/thesis');
    createOwnedProject('notes', bob.id);
    writeFileSync(serverFile('bob', 'notes', 'notes.tex'), 'Bob\'s notes.\n');
    await gitmod.ensureRepo('bob/notes');
    addMember('bob/notes', 'ada', 'view', toSessionUser(db.prepare('SELECT * FROM users WHERE id = ?').get(bob.id) as never));
  });

  it('restores a project to an earlier commit as a new commit; view-only projects are refused', async () => {
    const dir = serverFile('ada', 'thesis');
    const first = (await gitIn(dir, 'rev-parse', 'HEAD'));
    writeFileSync(join(dir, 'main.tex'), THESIS.replace('First line', 'A broken first line'));
    writeFileSync(join(dir, 'refs.bib'), '@misc{a, title={A}}\n');
    await gitmod.commitProject('ada/thesis', { message: 'An agent edit' });
    const r = await cli('restore', 'ada/thesis', first.slice(0, 10));
    expect(r.stdout).toMatch(/ada\/thesis: restored to [0-9a-f]+ as a new commit \(2 files/);
    expect(readFileSync(join(dir, 'main.tex'), 'utf8')).toBe(THESIS);
    expect(existsSync(join(dir, 'refs.bib'))).toBe(false);           // added later: removed
    expect(await gitIn(dir, 'log', '-1', '--format=%s')).toMatch(/^Restore the project to/);
    expect(await gitIn(dir, 'log', '--format=%s')).toContain('An agent edit');   // nothing rewritten
    await expect(cli('restore', 'bob/notes', first.slice(0, 10))).rejects.toMatchObject({ stderr: expect.stringContaining('only view') });
  });

  it('builds a document on the server and reports errors with exit code 1', { timeout: 120_000 }, async () => {
    if (spawnSync('which', ['latexmk']).status !== 0) return;
    writeFileSync(serverFile('ada', 'thesis', 'broken.tex'), '\\documentclass{article}\n\\begin{document}\nHello \\undefinedmacro{} world.\n\\end{document}\n');
    const bad = await cli('build', 'ada/thesis/broken.tex').catch(e => e as { stdout: string; code: number });
    expect(bad.stdout).toContain('✗ ada/thesis/broken.tex does not compile');
    expect(bad.stdout).toContain('Undefined control sequence');
    expect((bad as { code?: number }).code).toBe(1);
    writeFileSync(serverFile('ada', 'thesis', 'broken.tex'), '\\documentclass{article}\n\\begin{document}\nHello world.\n\\end{document}\n');
    const pdf = join(ROOT, 'out.pdf');
    const good = await cli('build', 'ada/thesis/broken.tex', '--pdf', pdf);
    expect(good.stdout).toContain('✓ ada/thesis/broken.tex compiled');
    expect(readFileSync(pdf).subarray(0, 5).toString()).toBe('%PDF-');
  });
});

describe("overlyx mcp: local agents through the CLI's bridge", () => {
  const FAKE = join(ROOT, 'fake-agents');
  const CODEX_HOME = join(ROOT, 'codex-home');
  /** stand-ins for `claude` and `codex` (the real ones on this computer must not be touched) */
  beforeAll(async () => {
    mkdirSync(FAKE, { recursive: true });
    mkdirSync(CODEX_HOME, { recursive: true });
    writeFileSync(join(FAKE, 'claude'), `#!/bin/sh\necho "$@" >> "${FAKE}/claude.log"\n[ "$1 $2" = "mcp get" ] && exit 1\nexit 0\n`, { mode: 0o755 });
    writeFileSync(join(FAKE, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await cli('auth', 'login', '--host', host, '--username', 'ada', '--token', token);
  });
  const agentEnv = (extra: Record<string, string> = {}) => ({ ...process.env, OVERLYX_CONFIG_DIR: join(ROOT, 'config'), CODEX_HOME, PATH: `${FAKE}:${process.env.PATH}`, ...extra });

  /** run the bridge as an agent does: messages on stdin, one per line; the answers by id */
  async function bridge(messages: object[], opts: { cwd?: string; configDir?: string } = {}): Promise<Record<string, any>> {
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, [CLI, 'mcp', 'serve'], { cwd: opts.cwd ?? ROOT, env: agentEnv(opts.configDir ? { OVERLYX_CONFIG_DIR: opts.configDir } : {}) });
    const answers: Record<string, any> = {};
    let buf = '';
    const want = messages.filter(m => 'id' in m).length;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no answer: ' + buf)), 20000);
      child.stdout.on('data', d => {
        buf += d;
        for (let i; (i = buf.indexOf('\n')) >= 0;) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          const m = JSON.parse(line);
          if (m.id !== undefined) answers[m.id] = m;
          if (Object.keys(answers).length === want) { clearTimeout(timer); resolve(); }
        }
      });
      child.on('error', reject);
      for (const m of messages) child.stdin.write(JSON.stringify(m) + '\n');
    });
    child.stdin.end();
    const code = await new Promise(r => child.on('exit', r));
    expect(code).toBe(0);
    return answers;
  }
  const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-agent', version: '1' } } };

  it('the server says how to connect', async () => {
    const r = await fetch(`${host}/cli/mcp.json`);
    expect(await r.json()).toEqual({ url: '/mcp', headers: { Authorization: 'Bearer {token}' } });
  });

  it('relays an agent to the server with the login: its tools, project creation included', async () => {
    const a = await bridge([INIT, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_projects', arguments: {} } }]);
    expect(a[1].result.serverInfo.name).toBeTruthy();
    const tools = a[2].result.tools.map((t: { name: string }) => t.name);
    expect(tools).toEqual(expect.arrayContaining(['list_projects', 'create_project', 'edit_document', 'write_document']));
    expect(JSON.stringify(a[3].result)).toContain('ada/Imported paper');
  });

  it('in a clone of an OverLyX project, the agent hears which project it is (edited on the server)', async () => {
    const clone = join(ROOT, 'a-clone');
    mkdirSync(clone, { recursive: true });
    await execFileP('git', ['init', '-q', clone]);
    await execFileP('git', ['-C', clone, 'remote', 'add', 'overlyx', `${host.replace('://', '://ada@')}/git/ada/Imported%20paper.git`]);
    const a = await bridge([INIT], { cwd: clone });
    expect(a[1].result.instructions).toMatch(/^This directory is a git clone of the OverLyX project "ada\/Imported paper"/);
    // elsewhere: the server's own instructions only
    const b = await bridge([INIT]);
    expect(b[1].result.instructions ?? '').not.toContain('git clone of the OverLyX project');
  });

  it("Claude Code's session (a session id, the server's event stream) works through the bridge too", async () => {
    const init = { ...INIT, params: { ...INIT.params, clientInfo: { name: 'claude-code', version: '2.0.0' } } };
    const a = await bridge([init, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_projects', arguments: {} } }]);
    expect(a[1].result.protocolVersion).toBeTruthy();
    expect(a[2].result.tools.length).toBeGreaterThan(10);
    expect(a[3].result.isError).toBeFalsy();
    expect(Array.isArray(a[3].result.content)).toBe(true);
    // the bridge ended the session on the way out
    const { db } = await import('../packages/server/src/db.ts');
    expect((db.prepare('SELECT COUNT(*) AS n FROM mcp_sessions').get() as { n: number }).n).toBe(0);
  });

  it('without a login it answers with what to do', async () => {
    const a = await bridge([INIT], { configDir: join(ROOT, 'no-config') });
    expect(a[1].error.message).toMatch(/not signed in to .* auth login/);
  });

  it('install registers the bridge with Claude Code and Codex (an old registration replaced, the rest of config.toml kept); uninstall removes it', async () => {
    const toml = join(CODEX_HOME, 'config.toml');
    writeFileSync(toml, 'model = "o4"\n\n[mcp_servers.overlyx]\nurl = "https://old.example/mcp"\n\n[mcp_servers.overlyx.env]\nX = "1"\n\n[mcp_servers.other]\ncommand = "other"\n');
    const r = await execFileP(process.execPath, [CLI, 'mcp', 'install', '--yes'], { encoding: 'utf8', env: agentEnv() });
    expect(r.stdout).toContain('Claude Code: registered');
    expect(r.stdout).toContain('Codex: registered');
    const log = readFileSync(join(FAKE, 'claude.log'), 'utf8');
    expect(log).toContain(`mcp add -s user overlyx -- ${CLI} mcp serve`);
    const text = readFileSync(toml, 'utf8');
    expect(text).toContain('model = "o4"');
    expect(text).toContain('[mcp_servers.other]\ncommand = "other"');
    expect(text).not.toContain('old.example');
    expect(text).not.toContain('[mcp_servers.overlyx.env]');
    expect(text).toContain(`[mcp_servers.overlyx]`);
    expect(text).toContain(`command = ${JSON.stringify(CLI)}\nargs = ["mcp", "serve"]`);
    expect(readFileSync(toml + '.bak', 'utf8')).toContain('old.example');
    const u = await execFileP(process.execPath, [CLI, 'mcp', 'uninstall'], { encoding: 'utf8', env: agentEnv() });
    expect(u.stdout).toContain('Codex: removed');
    expect(readFileSync(toml, 'utf8')).not.toContain('[mcp_servers.overlyx]');
    expect(readFileSync(join(FAKE, 'claude.log'), 'utf8')).toContain('mcp remove overlyx -s user');
  });

  it('the repository itself registers the bridge for agents working in a clone of it (.mcp.json, .codex/config.toml)', () => {
    const repo = fileURLToPath(new URL('..', import.meta.url));
    const mcp = JSON.parse(readFileSync(join(repo, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.overlyx.args.join(' ')).toContain('packages/cli/bin/overlyx.js" mcp serve');
    expect(readFileSync(join(repo, '.codex', 'config.toml'), 'utf8')).toContain('[mcp_servers.overlyx]');
  });

  it('an installed CLI updates itself from the server (checksummed)', async () => {
    const installed = join(ROOT, 'bin', 'overlyx');
    writeFileSync(installed, readFileSync(installed, 'utf8').replace(/const VERSION = '[^']+';/, "const VERSION = '0.0.1';"));
    expect((await execFileP(installed, ['--version'], { encoding: 'utf8' })).stdout.trim()).toBe('0.0.1');
    const r = await execFileP(installed, ['update', '--host', host], { encoding: 'utf8', env: agentEnv() });
    expect(r.stdout).toContain(`Updated the OverLyX CLI to ${CLI_VERSION}`);
    expect((await execFileP(installed, ['--version'], { encoding: 'utf8' })).stdout.trim()).toBe(CLI_VERSION);
    // the repository's own copy never replaces itself
    expect((await execFileP(process.execPath, [CLI, 'update', '--host', host], { encoding: 'utf8', env: agentEnv() })).stdout).toMatch(/up to date|not an installed copy/);
  });
});

describe('overlyx auth login through the browser', () => {
  const CONFIG = join(ROOT, 'config-web');
  const cookie = () => `ol_session=${signSession(toSessionUser(db.prepare("SELECT * FROM users WHERE username = 'ada'").get() as never))}`;

  /** the CLI waiting for the browser; the test is the browser */
  async function startLogin() {
    const { spawn } = await import('node:child_process');
    // (a desktop as far as the CLI knows: DISPLAY set, no SSH; xdg-open made harmless by an empty PATH entry)
    const env = { ...process.env, OVERLYX_CONFIG_DIR: CONFIG, DISPLAY: ':99', PATH: `${join(ROOT, 'no-browser')}:${process.env.PATH}` } as Record<string, string>;
    delete env.SSH_CONNECTION; delete env.SSH_TTY;
    mkdirSync(join(ROOT, 'no-browser'), { recursive: true });
    writeFileSync(join(ROOT, 'no-browser', 'xdg-open'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const child = spawn(process.execPath, [CLI, 'auth', 'login', '--web', '--host', host], { env });
    let err = '', out = '';
    child.stderr.on('data', d => { err += d; });
    child.stdout.on('data', d => { out += d; });
    const url = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no sign-in address: ' + err)), 10000);
      const poll = setInterval(() => { const m = /(http\S+\/cli\/login\?\S+)/.exec(err); if (m) { clearInterval(poll); clearTimeout(t); resolve(m[1]); } }, 50);
    });
    const done = new Promise<number>(r => child.on('exit', c => r(c ?? 1)));
    return { url: new URL(url), done, out: () => out, err: () => err };
  }

  it('the browser authorizes, the page hands the code back to the terminal: the CLI has a credential of its own, good for git and MCP', async () => {
    const login = await startLogin();
    const q = Object.fromEntries(login.url.searchParams);
    expect(q.client).toBeTruthy();
    // not signed in: the page says so
    expect(await (await fetch(login.url)).text()).toContain('Sign in to OverLyX first');
    // signed in: the consent page, then Authorize
    expect(await (await fetch(login.url, { headers: { cookie: cookie() } })).text()).toContain('Sign in the OverLyX CLI?');
    const consent = await fetch(login.url, { headers: { cookie: cookie() } });
    expect(consent.headers.get('content-security-policy')).toContain(`form-action 'self' http://127.0.0.1:${q.port}`);
    const approved = await fetch(`${host}/cli/login`, { method: 'POST', redirect: 'manual', headers: { cookie: cookie(), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...q, decision: 'approve' }).toString() });
    expect(approved.status).toBe(302);
    const location = approved.headers.get('location')!;
    expect(location.startsWith(`http://127.0.0.1:${q.port}/callback?state=${q.state}&code=olxcli_`)).toBe(true);
    const code = new URL(location).searchParams.get('code')!;
    // the browser follows the redirect back to the terminal
    const back = await fetch(location);
    expect(await back.text()).toContain('The OverLyX CLI is signed in');
    expect(await login.done).toBe(0);
    expect(login.out()).toContain(`Logged in to ${host} as ada`);
    const saved = JSON.parse(readFileSync(join(CONFIG, 'hosts.json'), 'utf8'));
    expect(saved.hosts[host].token).toMatch(/^olxmcp_/);
    expect(listMcpTokens(user.id).map(t => t.name)).toContain(`OverLyX CLI on ${q.client}`);
    // the credential works: the project list (git API) …
    const list = await execFileP(process.execPath, [CLI, 'repo', 'list'], { encoding: 'utf8', env: { ...process.env, OVERLYX_CONFIG_DIR: CONFIG } });
    expect(list.stdout).toContain('ada/');
    // … and a code works once
    expect((await fetch(`${host}/cli/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, verifier: 'x' }) })).status).toBe(400);
  });

  it('without a browser here (SSH), the page shows the code to paste instead of redirecting', async () => {
    const q = { port: '45678', state: 'abcdefghijkl', challenge: 'a'.repeat(43), client: 'remote-box', mode: 'manual' };
    const consent = await fetch(`${host}/cli/login?${new URLSearchParams(q)}`, { headers: { cookie: cookie() } });
    expect(await consent.text()).toContain('name="mode" value="manual"');
    const page = await fetch(`${host}/cli/login`, { method: 'POST', redirect: 'manual', headers: { cookie: cookie(), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...q, decision: 'approve' }).toString() });
    expect(page.status).toBe(200);
    expect(await page.text()).toMatch(/Paste this code into the terminal[\s\S]*olxcli_/);
  });

  it('a code is refused without the verifier of the CLI that asked for it', async () => {
    const login = await startLogin();
    const q = Object.fromEntries(login.url.searchParams);
    const location = (await fetch(`${host}/cli/login`, { method: 'POST', redirect: 'manual', headers: { cookie: cookie(), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...q, decision: 'approve' }).toString() })).headers.get('location')!;
    const code = new URL(location).searchParams.get('code')!;
    const stolen = await fetch(`${host}/cli/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, verifier: 'not-the-verifier-of-this-login-xxxxxxxxxxxxxx' }) });
    expect(stolen.status).toBe(400);
    // (the code is gone now: the waiting CLI fails when it is handed it)
    await fetch(`http://127.0.0.1:${q.port}/callback?state=${q.state}&code=${code}`);
    expect(await login.done).toBe(1);
    expect(login.err()).toContain('invalid or expired sign-in code');
  });
});
