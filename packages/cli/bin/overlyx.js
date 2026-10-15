#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const VERSION = '0.8.1';
const DEFAULT_HOST = 'https://overlyx.app';

const HELP = `OverLyX CLI ${VERSION}

Usage:
  overlyx auth login [--host URL] [--no-browser] [--no-git]   sign in through the browser (git, too)
  overlyx auth login [--host URL] --username NAME --with-token | --token TOKEN
  overlyx auth status [--host URL]
  overlyx auth setup-git [--host URL]                   git clone / pull / push to OverLyX use the sign-in
  overlyx auth logout [--host URL]
  overlyx repo list [--host URL]
  overlyx repo create [NAME] [--source PATH] [--push] [--remote NAME]
  overlyx repo push [PATH] [--name NAME] [--remote NAME]
  overlyx repo link [CLONE] [--files README.md,AGENTS.md]   a clone inside another repository: the files
                                                        live in the clone, that repository commits them
  overlyx repo unlink [CLONE]
  overlyx build OWNER/PROJECT/FILE.tex [--pdf FILE] [--log] [--wait SECONDS]
  overlyx restore OWNER/PROJECT COMMIT
  overlyx sync [DIR] [--watch]                          keep a clone in step with the server, both ways
  overlyx mcp install [--client claude,codex] [--yes]   let local AI agents use OverLyX (Claude Code: in every directory, no prompts)
  overlyx mcp status | uninstall
  overlyx mcp serve                                      (what the agents run: the MCP bridge)
  overlyx update                                         this CLI from the server

Examples:
  overlyx auth login                      # opens the browser: Authorize, and the CLI is signed in
  overlyx repo create my-paper --source . --push
  overlyx repo push . --name my-paper
  overlyx repo link paper                 # paper/ is a clone inside a code repository: its README.md and AGENTS.md are the repository's too
  overlyx build ada/my-paper/main.tex     # compile on the server: errors, exit code 1 if it fails
  overlyx restore ada/my-paper 3f2a91c    # the whole project as it was at that commit (a new commit)
  overlyx sync --watch                    # in a clone: saved files reach the server, its changes come here
  overlyx mcp install                     # Claude Code / Codex get OverLyX's tools (your login, your projects)

\`auth login\` signs in through the browser and gets a credential of its own (revocable in OverLyX under
File > Git repository). Scripts can pass your account access token instead (--with-token on stdin,
or OVERLYX_TOKEN). Credentials are stored with mode 0600; Git remotes contain your username, never a token.
`;

function fail(message, code = 1) {
  const e = new Error(message);
  e.exitCode = code;
  throw e;
}

function parse(argv) {
  const positional = [];
  const flags = {};
  const booleans = new Set(['push', 'with-token', 'help', 'version', 'log', 'yes', 'web', 'no-browser', 'no-git', 'ask-each-time', 'watch']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const eq = arg.indexOf('=');
    const key = arg.slice(2, eq < 0 ? undefined : eq);
    if (!key) fail('invalid empty option');
    if (booleans.has(key)) { flags[key] = eq < 0 ? true : arg.slice(eq + 1) !== 'false'; continue; }
    const value = eq < 0 ? argv[++i] : arg.slice(eq + 1);
    if (value == null || value.startsWith('--')) fail(`--${key} needs a value`);
    flags[key] = value;
  }
  return { positional, flags };
}

function configFile() {
  const root = process.env.OVERLYX_CONFIG_DIR
    ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'overlyx');
  return path.join(root, 'hosts.json');
}

function readConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.hosts && typeof parsed.hosts === 'object') return parsed;
  } catch { /* first use, or a damaged config that the next login can replace */ }
  return { defaultHost: null, hosts: {} };
}

function writeConfig(config) {
  const file = configFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function normalizeHost(value) {
  let url;
  try { url = new URL(value || DEFAULT_HOST); } catch { fail(`invalid host URL: ${value}`); }
  if (!/^https?:$/.test(url.protocol)) fail('host must use http or https');
  if (url.username || url.password || url.search || url.hash) fail('host must not contain credentials, a query or a fragment');
  return url.toString().replace(/\/$/, '');
}

function credentials(flags, required = true) {
  const config = readConfig();
  const host = normalizeHost(flags.host ?? process.env.OVERLYX_HOST ?? config.defaultHost ?? DEFAULT_HOST);
  const saved = config.hosts[host];
  const username = flags.username ?? process.env.OVERLYX_USERNAME ?? saved?.username;
  const token = flags.token ?? process.env.OVERLYX_TOKEN ?? saved?.token;
  if (required && (!username || !token)) fail(`not signed in to ${host}; run: overlyx auth login${host === DEFAULT_HOST ? '' : ` --host ${host}`}`);
  return { config, host, username, token };
}

function basic(username, token) {
  return 'Basic ' + Buffer.from(`${username}:${token}`, 'utf8').toString('base64');
}

async function api(creds, pathname, init = {}) {
  let response;
  try {
    response = await fetch(creds.host + pathname, {
      ...init,
      headers: {
        Accept: 'application/json',
        Authorization: basic(creds.username, creds.token),
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
  } catch (e) { fail(`cannot reach ${creds.host}: ${e.cause?.message ?? e.message}`); }
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!response.ok) fail(body?.error ?? text.trim() ?? `${response.status} ${response.statusText}`);
  return body;
}

async function tokenFromInput(flags) {
  if (flags.token) return String(flags.token).trim();
  if (process.env.OVERLYX_TOKEN) return process.env.OVERLYX_TOKEN.trim();
  if (!process.stdin.isTTY) return fs.readFileSync(0, 'utf8').trim();
  process.stderr.write('OverLyX access token: ');
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  return await new Promise((resolve, reject) => {
    let token = '';
    const done = (error) => {
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
      process.stderr.write('\n');
      error ? reject(error) : resolve(token.trim());
    };
    process.stdin.on('data', chunk => {
      for (const byte of chunk) {
        if (byte === 3) { done(new Error('cancelled')); return; }
        if (byte === 10 || byte === 13) { done(); return; }
        if (byte === 8 || byte === 127) token = token.slice(0, -1);
        else token += Buffer.from([byte]).toString();
      }
    });
    process.stdin.on('error', done);
  });
}

async function git(dir, args, auth) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (auth) {
    // Git's config environment keeps the header out of both .git/config and the process argv.
    const count = /^\d+$/.test(env.GIT_CONFIG_COUNT ?? '') ? Number(env.GIT_CONFIG_COUNT) : 0;
    env.GIT_CONFIG_COUNT = String(count + 1);
    env[`GIT_CONFIG_KEY_${count}`] = 'http.extraHeader';
    env[`GIT_CONFIG_VALUE_${count}`] = `Authorization: ${basic(auth.username, auth.token)}`;
  }
  try {
    return await execFileP('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env });
  } catch (e) {
    const detail = String(e.stderr || e.stdout || e.message).trim();
    fail(detail || `git ${args[0]} failed`);
  }
}

async function isRepo(dir) {
  try { await git(dir, ['rev-parse', '--git-dir']); return true; } catch { return false; }
}

async function hasHead(dir) {
  try { await git(dir, ['rev-parse', '--verify', 'HEAD']); return true; } catch { return false; }
}

async function prepareSource(source, project, creds) {
  const dir = path.resolve(source);
  let st;
  try { st = fs.statSync(dir); } catch { fail(`source does not exist: ${dir}`); }
  if (!st.isDirectory()) fail(`source is not a directory: ${dir}`);

  if (!await isRepo(dir)) {
    await git(dir, ['init', '-q', '-b', 'main']);
    await git(dir, ['add', '-A']);
    const status = (await git(dir, ['status', '--porcelain'])).stdout.trim();
    if (!status) fail(`source has no files to push: ${dir}`);
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? creds.username,
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? creds.username,
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? `${creds.username}@overlyx.local`,
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? `${creds.username}@overlyx.local`,
    };
    try {
      await execFileP('git', ['-C', dir, 'commit', '-q', '-m', `Import "${project}" into OverLyX`], { env, encoding: 'utf8' });
    } catch (e) { fail(String(e.stderr || e.message).trim()); }
    return dir;
  }

  const top = path.resolve((await git(dir, ['rev-parse', '--show-toplevel'])).stdout.trim());
  if (top !== dir) fail(`source is inside the repository at ${top}; pass that repository root explicitly`);

  if (!await hasHead(dir)) {
    await git(dir, ['add', '-A']);
    if (!(await git(dir, ['status', '--porcelain'])).stdout.trim()) fail(`repository has no commits or files: ${dir}`);
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? creds.username,
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? creds.username,
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? `${creds.username}@overlyx.local`,
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? `${creds.username}@overlyx.local`,
    };
    try { await execFileP('git', ['-C', dir, 'commit', '-q', '-m', `Import "${project}" into OverLyX`], { env, encoding: 'utf8' }); }
    catch (e) { fail(String(e.stderr || e.message).trim()); }
    return dir;
  }

  const dirty = (await git(dir, ['status', '--porcelain', '--untracked-files=all'])).stdout.trim();
  if (dirty) fail('the source repository has uncommitted files; commit them first so the import cannot silently omit work');
  return dir;
}

async function setRemote(dir, name, url) {
  const remotes = (await git(dir, ['remote'])).stdout.split('\n').filter(Boolean);
  if (remotes.includes(name)) {
    const current = (await git(dir, ['remote', 'get-url', name])).stdout.trim();
    if (current !== url) fail(`Git remote "${name}" already points to ${current}; choose another with --remote NAME`);
    return;
  }
  await git(dir, ['remote', 'add', name, url]);
}

/** Projects live in their owner's namespace: `<username>/<name>` is the key the server uses. */
const projectKey = (creds, name) => `${creds.username}/${name}`;
const gitUrl = (creds, key) => `${creds.host}/git/${key.split('/').map(encodeURIComponent).join('/')}.git`;

async function existingProject(creds, name) {
  const result = await api(creds, '/git/api/projects');
  return result.projects.find(project => project.name === projectKey(creds, name) && (project.role === 'owner' || project.role === 'edit')) ?? null;
}

async function createRemote(creds, name, title, allowExisting) {
  try {
    return await api(creds, '/git/api/projects', { method: 'POST', body: JSON.stringify({ name, ...(title ? { title } : {}) }) });
  } catch (e) {
    if (!allowExisting || !/already exists/i.test(e.message)) throw e;
    const found = await existingProject(creds, name);
    if (!found) fail(`a project named "${projectKey(creds, name)}" exists, but this account cannot push to it`);
    return { project: found, url: gitUrl(creds, found.name), username: creds.username, existing: true };
  }
}

async function pushSource(creds, dir, project, remoteName, remote) {
  // Keep the secret out of .git/config. Authentication is passed only to this child process.
  const url = new URL(remote.url);
  url.username = creds.username;
  await setRemote(dir, remoteName, url.toString());
  await git(dir, ['push', '-u', remoteName, 'HEAD:main'], creds);
  process.stdout.write(`Pushed ${dir} to ${creds.host}/${project}\n`);
  process.stdout.write(`Remote: ${remoteName} (${url.toString()})\n`);
}

/* ------------------------------------------------------------ signing in through the browser */

/** Does this computer have a browser the sign-in can come back from (not an SSH session, not a headless server)? */
function hasLocalBrowser() {
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY) return false;
  if (process.platform === 'linux') return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  return true;
}

/** Open a URL in the default browser (quietly; the URL is printed anyway). */
function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]];
  try { execFile(cmd, args, { timeout: 10000 }, () => undefined).unref?.(); } catch { /* no browser */ }
}

/**
 * Sign in as Claude Code does: a listener on 127.0.0.1 and a PKCE pair; the browser — signed in to
 * OverLyX — authorizes, and hands the one-time code back to the listener, or shows it to paste here
 * (a browser on another computer). The code and the verifier give this CLI a credential of its own.
 */
async function browserLogin(host, flags, ui = null) {
  // ui (the VS Code extension): open(url) instead of the system browser; manual: the page shows a code, askCode() asks for it
  const manual = ui ? !!ui.manual : !!flags['no-browser'] || !hasLocalBrowser();
  if (manual && !ui && !process.stdin.isTTY) fail('no browser on this computer and no terminal to paste a code into: run overlyx auth login in a terminal, or pass a token (--with-token)');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('base64url');
  let finish;
  const got = new Promise(resolve => { finish = resolve; });
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/callback' && u.searchParams.get('state') === state && u.searchParams.get('code')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(ui?.app === 'vscode'
        ? '<!doctype html><meta charset="utf-8"><title>OverLyX for VS Code</title><body style="font:15px/1.5 system-ui;max-width:28em;margin:12vh auto;padding:0 1em"><h2>OverLyX for VS Code is signed in</h2><p>You can close this tab and go back to VS Code.</p></body>'
        : '<!doctype html><meta charset="utf-8"><title>OverLyX CLI</title><body style="font:15px/1.5 system-ui;max-width:28em;margin:12vh auto;padding:0 1em"><h2>The OverLyX CLI is signed in</h2><p>You can close this tab and go back to the terminal.</p></body>');
      finish(u.searchParams.get('code'));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  // in a clone of one of the projects: the page suggests it, should the account narrow sign-ins (fine-grained access)
  const clone = ui ? (ui.project ? { project: ui.project } : null) : await cloneOf(host);
  const url = `${host}/cli/login?` + new URLSearchParams({ port: String(port), state, challenge, client: os.hostname(), ...(manual ? { mode: 'manual' } : {}), ...(clone ? { project: clone.project } : {}), ...(ui?.app ? { app: ui.app } : {}) }).toString();
  let rl = null;
  if (ui) {
    await ui.open(url);
    if (manual) void ui.askCode().then(code => finish(code?.trim() || null), () => finish(null));
  } else if (manual) {
    // a browser on another computer cannot come back here: its page shows the code to paste
    process.stderr.write(`Open this address in a browser where you are signed in to OverLyX, and authorize:\n  ${url}\n`);
    rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question('Paste the code it shows: ', answer => { finish(answer.trim() || null); });
  } else {
    process.stderr.write(`Opening your browser to sign in to ${host} … if it does not open, go to:\n  ${url}\n`);
    openBrowser(url);
    process.stderr.write('Waiting for you to authorize in the browser (browser on another computer? overlyx auth login --no-browser)\n');
  }
  const timer = setTimeout(() => finish(null), 10 * 60 * 1000);
  const code = await got;
  clearTimeout(timer);
  rl?.close();
  server.close();
  if (!code) fail('signing in timed out — run overlyx auth login again');
  process.stderr.write('\n');
  let res;
  try { res = await fetch(`${host}/cli/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, verifier }) }); }
  catch (e) { fail(`cannot reach ${host}: ${e.cause?.message ?? e.message}`); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.token) fail(body.error ?? `sign-in failed (${res.status})`);
  return { username: body.username, token: body.token, access: body.access ?? null };
}

/* ------------------------------------------------------------ git: a credential helper */

/*
 * After `auth login`, plain git (clone, pull, push in a project's folder) authenticates to OverLyX
 * with the CLI's sign-in: git asks `overlyx auth git-credential get` for the host's credentials. Set
 * up per host in the global git config — an empty helper first, so a token another helper kept from
 * before (osxkeychain, store) does not answer instead.
 */

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const gitHelperKey = (host) => `credential.${host}.helper`;

async function setupGit(host) {
  const key = gitHelperKey(host);
  await execFileP('git', ['config', '--global', '--unset-all', key]).catch(() => undefined);
  await execFileP('git', ['config', '--global', '--add', key, '']);
  await execFileP('git', ['config', '--global', '--add', key, `!${shq(selfPath())} auth git-credential`]);
}

async function removeGitSetup(host) {
  await execFileP('git', ['config', '--global', '--unset-all', gitHelperKey(host)]).catch(() => undefined);
}

/** git's credential protocol: key=value lines in, username / password out for a host the CLI is signed in to */
async function gitCredential(op) {
  const input = fs.readFileSync(0, 'utf8');
  if (op !== 'get') return;   // store / erase: the sign-in is the CLI's own
  const fields = Object.fromEntries(input.split('\n').map(l => l.split(/=(.*)/s)).filter(p => p[0]).map(p => [p[0], p[1] ?? '']));
  if (!fields.protocol || !fields.host) return;
  let host;
  try { host = normalizeHost(`${fields.protocol}://${fields.host}`); } catch { return; }
  const saved = readConfig().hosts[host];
  if (!saved?.token || !saved.username) return;
  process.stdout.write(`username=${saved.username}\npassword=${saved.token}\n`);
}

async function authCommand(action, flags) {
  if (action === 'login') {
    const config = readConfig();
    const host = normalizeHost(flags.host ?? process.env.OVERLYX_HOST ?? config.defaultHost ?? DEFAULT_HOST);
    // a token given (scripts, CI): as before; otherwise the browser
    const withToken = !flags.web && (flags['with-token'] || flags.token || process.env.OVERLYX_TOKEN || (!process.stdin.isTTY && !process.stderr.isTTY));
    let username, token, access = null;
    if (withToken) {
      username = String(flags.username ?? process.env.OVERLYX_USERNAME ?? '').trim();
      if (!username) fail('--username is required with a token (or run overlyx auth login without one to sign in through the browser)');
      token = await tokenFromInput(flags);
      if (!token) fail('no token received');
    } else {
      ({ username, token, access } = await browserLogin(host, flags));
    }
    const creds = { host, username, token };
    const result = await api(creds, '/git/api/user');
    config.hosts[host] = { username: result.user.username, token };
    config.defaultHost = host;
    writeConfig(config);
    process.stdout.write(`Logged in to ${host} as ${result.user.username}\n`);
    if (access) process.stdout.write(`Access: ${access}\n`);
    // git, too: clones, pulls and pushes to this server use the sign-in (signed in through the browser; scripts set it up with setup-git)
    if (!withToken && !flags['no-git']) {
      try { await setupGit(host); process.stdout.write(`Git: clone, pull and push to ${host} use this sign-in\n`); }
      catch (e) { process.stdout.write(`Git: not set up (${String(e.stderr || e.message).trim()}) — later: overlyx auth setup-git\n`); }
    }
    // local agents: offered once, when one is installed and none is registered yet
    if (process.stdin.isTTY && !codexRegistered() && (await claudeRegistered()) === null && ((await has('claude')) || (await has('codex')))) await mcpInstall({});
    return;
  }

  if (action === 'git-credential') { await gitCredential(flags._op); return; }
  const creds = credentials(flags, action !== 'logout');
  if (action === 'setup-git') {
    await setupGit(creds.host);
    process.stdout.write(`Git: clone, pull and push to ${creds.host} use the OverLyX CLI's sign-in\n`);
    return;
  }
  if (action === 'status') {
    const result = await api(creds, '/git/api/user');
    process.stdout.write(`${creds.host}: logged in as ${result.user.username}\n`);
    if (result.scope) process.stdout.write(`  access: ${result.scope.projects ? result.scope.projects.join(', ') || 'no projects' : 'all projects'}${result.scope.readonly ? ' (read only)' : ''}\n`);
    return;
  }
  if (action === 'logout') {
    if (!creds.config.hosts[creds.host]) fail(`not logged in to ${creds.host}`);
    delete creds.config.hosts[creds.host];
    if (creds.config.defaultHost === creds.host) creds.config.defaultHost = Object.keys(creds.config.hosts)[0] ?? null;
    writeConfig(creds.config);
    await removeGitSetup(creds.host);
    process.stdout.write(`Logged out of ${creds.host}\n`);
    return;
  }
  fail(`unknown auth command: ${action || '(missing)'}`);
}

async function repoCommand(action, args, flags) {
  if (action === 'link') return repoLink(args, flags);
  if (action === 'unlink') return repoUnlink(args);
  const creds = credentials(flags);
  if (action === 'list') {
    const result = await api(creds, '/git/api/projects');
    for (const project of result.projects) process.stdout.write(`${project.name}\t${project.role}\t${project.title ?? ''}\n`);
    return;
  }

  if (action !== 'create' && action !== 'push') fail(`unknown repo command: ${action || '(missing)'}`);
  const source = flags.source ?? (action === 'push' ? args[0] ?? '.' : flags.push ? '.' : null);
  const inferred = source ? path.basename(path.resolve(source)) : '';
  let name = String(flags.name ?? (action === 'create' ? args[0] : '') ?? inferred).trim() || inferred;
  // the project's key may be given as it reads elsewhere (`<username>/<name>`)
  if (name.startsWith(creds.username + '/')) name = name.slice(creds.username.length + 1);
  if (!name) fail('project name is required');
  if (!/^[A-Za-z0-9._ -]+$/.test(name) || name.startsWith('.') || name.trim() !== name) fail('invalid project name (use letters, numbers, spaces, dot, dash or underscore)');
  // Validate (and, for a plain directory, initialise) locally before creating anything remotely.
  // That way a typo, empty folder or dirty repository cannot leave an accidental empty project.
  let prepared = null;
  if (source && (flags.push || action === 'push')) prepared = await prepareSource(source, name, creds);
  else if (source) {
    const dir = path.resolve(source);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) fail(`source is not a directory: ${dir}`);
    if (!await isRepo(dir)) fail('source is not a Git repository; add --push to initialise and import it');
    prepared = dir;
  }
  const remote = await createRemote(creds, name, flags.title, action === 'push');
  const key = remote.project?.name ?? projectKey(creds, name);
  process.stdout.write(`${remote.existing ? 'Using' : 'Created'} project "${key}" on ${creds.host}\n`);
  if (source) {
    const dir = path.resolve(source);
    const remoteName = String(flags.remote ?? 'overlyx');
    if (!/^[A-Za-z0-9._-]+$/.test(remoteName)) fail('invalid Git remote name');
    const remoteUrl = remote.url ?? gitUrl(creds, key);
    if (flags.push || action === 'push') await pushSource(creds, prepared ?? dir, key, remoteName, { ...remote, url: remoteUrl });
    else {
      const url = new URL(remoteUrl); url.username = creds.username;
      await setRemote(dir, remoteName, url.toString());
      process.stdout.write(`Added remote ${remoteName} (${url.toString()})\n`);
    }
  } else process.stdout.write(`Clone: ${remote.url}\n`);
}

/* ------------------------------------------------------------ repo link: a clone inside another repository */

/**
 * `.overlyx/link.sh`, written into the enclosing repository by `overlyx repo link`: the installer, the hooks
 * and the merge driver that keep the linked files of the clone and the repository's commits in step.
 * This string is the file (the CLI is one file). Its first line names the version: bump it with every
 * change, so that `repo link` run again rewrites the copy a repository has.
 */
const LINK_SCRIPT = `#!/bin/sh
# overlyx-link script v1 — written by \`overlyx repo link\`; https://overlyx.app
#
# Files of an OverLyX project cloned inside this repository (its README.md, AGENTS.md, …) are shared
# with this repository: .overlyx/links names them ("<path here> <path in the clone>"). The clone is
# the source of truth. Here each one is a relative symlink into the clone, so an edit shows at once
# on both sides, and every commit of this repository carries the file's contents as an ordinary file
# (GitHub renders it): the pre-commit hook stages the clone's content as a blob. \`git status\` stays
# clean because the paths are skip-worktree entries of a sparse checkout that expects files outside
# its patterns (git neither compares nor rewrites them). A checkout, pull or merge updates the index
# entry only; where both sides of a merge changed a linked file, the merge driver takes the clone's.
#
#   sh .overlyx/link.sh install      set this clone of the repository up (idempotent): symlinks, index
#                                    bits, sparse checkout, merge driver, hooks (existing hooks are kept
#                                    as <hook>.before-overlyx-link and run after ours)
#   sh .overlyx/link.sh check        repair: symlinks, index bits, a conflict in a linked file
#   sh .overlyx/link.sh uninstall    back to ordinary files, hooks and configuration restored
#   sh .overlyx/link.sh hook NAME    what the installed hooks run
#   sh .overlyx/link.sh merge O A B P   the merge driver (merge.overlyx-link.driver)
set -eu

LINKS=.overlyx/links
HOOKS='pre-commit post-commit post-checkout post-merge post-rewrite'
MARK='overlyx-link'

note() { printf 'overlyx link: %s\\n' "$*" >&2; }
die() { note "$*"; exit 1; }

root=$(git rev-parse --show-toplevel) || exit 1
cd "$root"

git_path() { p=$(git rev-parse --git-path "$1"); case $p in /*) printf '%s' "$p";; *) printf '%s/%s' "$root" "$p";; esac; }

# \`each FN\`: FN <path here> <path in the clone>, for every link (the loop reads a here-document, so
# commands inside never consume a hook's stdin)
each() {
  fn=$1; shift
  while read -r outer inner rest; do
    case $outer in ''|'#'*) continue;; esac
    [ -n "$inner" ] && [ -z "$rest" ] || die "bad line in $LINKS: $outer $inner $rest"
    case $outer$inner in *' '*|*'	'*|/*|*'..'*) die "bad paths in $LINKS: $outer $inner";; esac
    "$fn" "$outer" "$inner" "$@"
  done <<EOF
$(cat "$LINKS")
EOF
}

# the symlink target for <path here> → <path in the clone>, both relative to the repository root
target_of() { d=$(dirname "$1"); t=$2; while [ "$d" != . ]; do t=../$t; d=$(dirname "$d"); done; printf '%s' "$t"; }
index_hash() { git ls-files -s -- "$1" | awk 'NR==1 {print $2}'; }
head_hash() { git rev-parse -q --verify "HEAD:$1" 2>/dev/null || true; }
in_index() { git ls-files --error-unmatch -- "$1" >/dev/null 2>&1; }
skip_bit() { git update-index --skip-worktree -- "$1"; }

# the index entry for <path here> := the clone's file, marked skip-worktree (a conflict is resolved by it)
stage() {
  [ -f "$2" ] || die "$2 is missing (is the clone checked out?), so $1 cannot be staged"
  mode=100644; [ -x "$2" ] && mode=100755
  git update-index --add --cacheinfo "$mode,$(git hash-object -w -- "$2"),$1"
  skip_bit "$1"
}

# after a commit: the index entry follows what was committed (a commit of chosen paths leaves it behind)
resync() {
  in_index "$1" || return 0
  entry=$(git ls-tree HEAD -- "$1"); [ -n "$entry" ] || return 0
  set -- "$1" "$2" $entry
  [ "$(index_hash "$1")" = "$5" ] || git update-index --add --cacheinfo "$3,$5,$1"
  skip_bit "$1"
}

# the symlink and the index bit of one link, repaired where git or someone replaced them
check() {
  outer=$1; inner=$2; target=$(target_of "$outer" "$inner")
  if [ -n "$(git ls-files -u -- "$outer")" ]; then
    note "$outer: both sides changed it; resolved with $inner, the source of truth"
    stage "$outer" "$inner"; [ -L "$outer" ] || rm -f "$outer"
  fi
  if ! in_index "$outer"; then [ -L "$outer" ] && note "$outer is not tracked on this branch; its symlink is untracked here"; return 0; fi
  case $(git ls-files -t -- "$outer") in S*) ;; *) skip_bit "$outer";; esac
  if [ -L "$outer" ]; then
    [ "$(readlink "$outer")" = "$target" ] || die "$outer is a symlink to $(readlink "$outer"), not to $target"
  elif [ -e "$outer" ]; then
    [ -f "$outer" ] || die "$outer is neither a symlink nor a regular file"
    blob=$(git hash-object -- "$outer")
    if [ "$blob" = "$(index_hash "$outer")" ] || [ "$blob" = "$(head_hash "$outer")" ] || { [ -f "$inner" ] && cmp -s "$outer" "$inner"; }; then
      rm -f "$outer"; ln -s "$target" "$outer"; note "$outer: symlink restored"
    else
      die "$outer is a regular file with content that is neither committed nor in $inner: move what is wanted into $inner, delete it, then run: sh .overlyx/link.sh check"
    fi
  else
    ln -s "$target" "$outer"
  fi
}

# after commits came in: a linked file they changed, differently from the clone, is worth a look
warn_changed() {
  outer=$1; inner=$2; prev=$3
  old=$(git rev-parse -q --verify "$prev:$outer" 2>/dev/null || true); new=$(head_hash "$outer")
  [ "$old" = "$new" ] && return 0
  [ -f "$inner" ] && [ "$new" = "$(git hash-object -- "$inner")" ] && return 0
  note "$outer changed in the commits just received, differently from $inner (the source of truth, which the next commit here takes): see  git diff $prev HEAD -- $outer  and port what is wanted into $inner"
}

ensure_config() {
  if [ "$(git config --get core.sparseCheckoutCone || true)" = true ] && [ "$(git config --get sparse.expectFilesOutsideOfPatterns || true)" != true ]; then
    die "this repository uses a cone-mode sparse checkout, which cannot exclude single files"
  fi
  git config core.sparseCheckout true
  git config core.sparseCheckoutCone false
  git config sparse.expectFilesOutsideOfPatterns true
  patterns=$(git_path info/sparse-checkout); mkdir -p "$(dirname "$patterns")"
  [ -s "$patterns" ] || printf '/*\\n' > "$patterns"
  attributes=$(git_path info/attributes); [ -f "$attributes" ] || : > "$attributes"
  each ensure_patterns "$patterns" "$attributes"
  git config merge.overlyx-link.name 'the clone of the OverLyX project is the source of truth'
  git config merge.overlyx-link.driver 'sh .overlyx/link.sh merge %O %A %B %P'
}
ensure_patterns() {
  grep -qxF -- "!/$1" "$3" || printf '!/%s\\n' "$1" >> "$3"
  grep -qxF -- "/$1 merge=$MARK" "$4" || printf '/%s merge=%s\\n' "$1" "$MARK" >> "$4"
}

install_hooks() {
  dir=$(git_path hooks); mkdir -p "$dir"
  for name in $HOOKS; do
    f=$dir/$name
    if [ -e "$f" ] && ! grep -q "$MARK" "$f"; then
      [ -e "$f.before-$MARK" ] && die "both $f and $f.before-$MARK exist; merge them into one hook by hand"
      mv "$f" "$f.before-$MARK"; note "the existing $name hook is kept as $name.before-$MARK and runs after ours"
    fi
    cat > "$f" <<EOF
#!/bin/sh
# $MARK hook: runs .overlyx/link.sh for this hook, then the hook it replaced ($name.before-$MARK)
dir=\\$(cd "\\$(dirname "\\$0")" && pwd); name=\\$(basename "\\$0")
root=\\$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
if [ -f "\\$root/.overlyx/link.sh" ]; then sh "\\$root/.overlyx/link.sh" hook "\\$name" "\\$@" </dev/null || exit \\$?; fi
if [ -x "\\$dir/\\$name.before-$MARK" ]; then exec "\\$dir/\\$name.before-$MARK" "\\$@"; fi
exit 0
EOF
    chmod +x "$f"
  done
}

# the clone's directory must be a checked-out repository of its own (not an empty submodule directory)
clone_checked_out() { top=$(git -C "$(dirname "$1")" rev-parse --show-toplevel 2>/dev/null) && [ "$top" != "$root" ]; }

# one link: the file lives in the clone (adopted from here when the clone lacks it), a symlink here, an index entry marked skip-worktree
install_link() {
  outer=$1; inner=$2; target=$(target_of "$outer" "$inner")
  clone_checked_out "$inner" || die "$(dirname "$inner") is not a checked-out repository: check the clone out first (a submodule: git submodule update --init $(dirname "$inner"))"
  if [ -L "$outer" ]; then
    [ "$(readlink "$outer")" = "$target" ] || die "$outer is already a symlink to $(readlink "$outer"); remove it first"
    [ -f "$inner" ] || die "$inner is missing: check the clone out first"
  elif [ -f "$outer" ]; then
    if [ ! -e "$inner" ]; then
      mkdir -p "$(dirname "$inner")"; mv "$outer" "$inner"; note "$outer moved into the clone as $inner"
    elif cmp -s "$outer" "$inner"; then
      rm "$outer"
    else
      blob=$(git hash-object -- "$outer")
      if [ "$blob" = "$(head_hash "$outer")" ] || [ "$blob" = "$(index_hash "$outer")" ]; then
        rm "$outer"; note "$outer differs from $inner, which wins (the committed version stays in the history: git show HEAD:$outer)"
      else
        die "$outer has uncommitted changes that differ from $inner: merge them into $inner by hand, delete $outer, then run this again"
      fi
    fi
    ln -s "$target" "$outer"
  elif [ -e "$outer" ]; then
    die "$outer exists and is neither a regular file nor a symlink"
  else
    [ -f "$inner" ] || die "neither $outer nor $inner exists"
    ln -s "$target" "$outer"
  fi
  if in_index "$outer"; then skip_bit "$outer"; else stage "$outer" "$inner"; note "$outer: added to the index"; fi
}

uninstall_link() {
  outer=$1; inner=$2
  if [ -L "$outer" ]; then rm "$outer"; [ -f "$inner" ] && cp "$inner" "$outer"; fi
  in_index "$outer" && git update-index --no-skip-worktree -- "$outer"
  patterns=$(git_path info/sparse-checkout); attributes=$(git_path info/attributes)
  for f in "$patterns" "$attributes"; do [ -f "$f" ] && { grep -vxF -e "!/$outer" -e "/$outer merge=$MARK" "$f" > "$f.tmp" || true; mv "$f.tmp" "$f"; }; done
  return 0
}

uninstall() {
  each uninstall_link
  patterns=$(git_path info/sparse-checkout)
  if [ -f "$patterns" ] && [ "$(cat "$patterns")" = '/*' ]; then
    rm "$patterns"; git config --unset core.sparseCheckout || true; git config --unset core.sparseCheckoutCone || true; git config --unset sparse.expectFilesOutsideOfPatterns || true
  fi
  attributes=$(git_path info/attributes); [ -f "$attributes" ] && [ ! -s "$attributes" ] && rm "$attributes"
  git config --remove-section merge.overlyx-link 2>/dev/null || true
  dir=$(git_path hooks)
  for name in $HOOKS; do
    f=$dir/$name
    [ -f "$f" ] && grep -q "$MARK" "$f" && rm "$f"
    [ -e "$f.before-$MARK" ] && mv "$f.before-$MARK" "$f"
  done
  note "unlinked: the files are ordinary files again"
}

hook() {
  [ -f "$LINKS" ] || exit 0
  case $1 in
    pre-commit) each stage;;
    post-commit) each resync;;
    post-checkout) each check; [ "\${4:-0}" = 1 ] && [ "$2" != "$3" ] && each warn_changed "$2";;
    post-merge) each check; git rev-parse -q --verify ORIG_HEAD >/dev/null 2>&1 && each warn_changed ORIG_HEAD;;
    post-rewrite) each check;;
  esac
  return 0
}

merge_driver() {
  base=$1; ours=$2; theirs=$3; pathname=$4
  inner=$(awk -v p="$pathname" '$1 == p { print $2 }' "$LINKS")
  if [ -z "$inner" ]; then git merge-file -L ours -L base -L theirs "$ours" "$base" "$theirs"; return $?; fi
  [ -f "$inner" ] || die "$inner is missing, so the merge of $pathname cannot take it"
  cat "$inner" > "$ours"
  note "$pathname: changed on both sides; resolved with $inner, the source of truth (both versions remain in the history)"
}

cmd=\${1:-}; [ $# -gt 0 ] && shift
case $cmd in
  install)
    [ -f "$LINKS" ] || die "$LINKS not found: run \\\`overlyx repo link\\\` first"
    ensure_config; each install_link; install_hooks
    note "installed in $root (hooks: $HOOKS)"
    ;;
  check) [ -f "$LINKS" ] || die "$LINKS not found"; ensure_config; each check;;
  uninstall) [ -f "$LINKS" ] || die "$LINKS not found"; uninstall;;
  hook) [ $# -ge 1 ] || die "usage: link.sh hook NAME [ARGS]"; hook "$@";;
  merge) [ $# -eq 4 ] || die "usage: link.sh merge BASE OURS THEIRS PATH"; merge_driver "$@";;
  *) sed -n '2,20p' "$0" | sed 's/^# \\{0,1\\}//' >&2; exit 2;;
esac
`;

/** `sh ARGS` in `cwd`, its output passed through; a failure fails the command. */
async function sh(cwd, args) {
  const { spawn } = await import('node:child_process');
  const code = await new Promise((resolve, reject) => {
    const child = spawn('sh', args, { cwd, stdio: 'inherit', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    child.on('error', reject);
    child.on('close', resolve);
  });
  if (code !== 0) fail(`sh ${args.join(' ')} failed (exit code ${code})`);
}

/** The clone named on the command line (its root) and the repository it lies in. */
async function nestedClone(arg) {
  if (process.platform === 'win32') fail('repo link needs symlinks and a POSIX shell (Linux or macOS)');
  const clone = path.resolve(arg ?? '.');
  let st;
  try { st = fs.statSync(clone); } catch { fail(`not a directory: ${clone}`); }
  if (!st.isDirectory()) fail(`not a directory: ${clone}`);
  if (!await isRepo(clone)) fail(`${clone} is not a git repository: name the clone of the OverLyX project`);
  const top = path.resolve((await git(clone, ['rev-parse', '--show-toplevel'])).stdout.trim());
  if (top !== clone) fail(`${clone} is inside the repository ${top}: name the clone itself`);
  let outer = null;
  try { outer = path.resolve((await git(path.dirname(clone), ['rev-parse', '--show-toplevel'])).stdout.trim()); } catch { /* not inside a repository */ }
  if (!outer || outer === clone) fail(`${clone} is not inside another git repository`);
  return { clone, outer, rel: path.relative(outer, clone).split(path.sep).join('/') };
}

/**
 * `overlyx repo link [CLONE] [--files README.md,AGENTS.md]`: files of the project (in the clone, the
 * source of truth) are those of the enclosing repository too — symlinks there, their contents in its
 * commits. Writes `.overlyx/links` and `.overlyx/link.sh` into that repository and runs the installer.
 */
async function repoLink(args, flags) {
  const { clone, outer, rel } = await nestedClone(args[0]);
  const names = String(flags.files ?? 'README.md,AGENTS.md').split(',').map(s => s.trim()).filter(Boolean);
  if (!names.length) fail('--files needs at least one file name');
  const lines = [], skipped = [];
  for (const name of names) {
    if (/\s/.test(name) || name.startsWith('/') || name.split('/').some(p => p === '' || p === '.' || p === '..')) fail(`invalid file name: ${name}`);
    const here = path.basename(name);
    if (!fs.existsSync(path.join(clone, name)) && !fs.existsSync(path.join(outer, here))) {
      if (flags.files) fail(`${name}: neither ${path.join(clone, name)} nor ${path.join(outer, here)} exists`);
      skipped.push(name);
      continue;
    }
    lines.push(`${here} ${rel}/${name}`);
  }
  if (!lines.length) fail(`nothing to link: none of ${names.join(', ')} exists in ${clone} or ${outer}`);
  const dir = path.join(outer, '.overlyx');
  fs.mkdirSync(dir, { recursive: true });
  const manifest = path.join(dir, 'links');
  const existing = fs.existsSync(manifest) ? fs.readFileSync(manifest, 'utf8').split('\n').map(l => l.trim()).filter(Boolean) : [];
  for (const line of lines) {
    if (existing.includes(line)) continue;
    const here = line.split(' ')[0];
    const clash = existing.find(l => !l.startsWith('#') && l.split(/\s+/)[0] === here);
    if (clash) fail(`${here} is already linked to ${clash.split(/\s+/)[1]} (.overlyx/links)`);
    existing.push(line);
  }
  fs.writeFileSync(manifest, existing.join('\n') + '\n');
  const script = path.join(dir, 'link.sh');
  if (!fs.existsSync(script) || fs.readFileSync(script, 'utf8') !== LINK_SCRIPT) fs.writeFileSync(script, LINK_SCRIPT);
  fs.chmodSync(script, 0o755);
  await sh(outer, ['.overlyx/link.sh', 'install']);
  const target = await syncTarget(clone);
  process.stdout.write(`Linked ${lines.map(l => l.split(' ')[0]).join(', ')} of ${target ? `${target.project} on ${target.host}` : rel} into ${outer}: symlinks here, their contents in every commit\n`);
  if (skipped.length) process.stdout.write(`Not linked (in neither place): ${skipped.join(', ')}\n`);
  process.stdout.write(`Commit .overlyx/ in ${outer}; another clone of it sets itself up with: sh .overlyx/link.sh install\n`);
}

/** `overlyx repo unlink [CLONE]`: ordinary files again; `.overlyx/links` and `.overlyx/link.sh` are deleted. */
async function repoUnlink(args) {
  const { outer } = await nestedClone(args[0]);
  const dir = path.join(outer, '.overlyx');
  if (!fs.existsSync(path.join(dir, 'links'))) fail(`${outer} has no linked files (.overlyx/links)`);
  await sh(outer, ['.overlyx/link.sh', 'uninstall']);
  for (const name of ['links', 'link.sh']) fs.rmSync(path.join(dir, name), { force: true });
  if (!fs.readdirSync(dir).length) fs.rmdirSync(dir);
  process.stdout.write(`Unlinked: ordinary files in ${outer} again; .overlyx/links and .overlyx/link.sh are deleted (commit that)\n`);
}

/* ------------------------------------------------------------ build / restore */

/** `<owner>/<project>/<path>` → the project key and the document path. */
function documentTarget(arg) {
  const parts = String(arg ?? '').replace(/^\/+/, '').split('/').filter(Boolean);
  if (parts.length < 3) fail('name the document as <owner>/<project>/<file>.tex');
  return { project: `${parts[0]}/${parts[1]}`, path: parts.slice(2).join('/') };
}

/** Compile a document on the server, as the PDF button does: the errors, exit code 1 if it fails. */
async function buildCommand(args, flags) {
  const creds = credentials(flags);
  const t = documentTarget(args[0]);
  const wait = Math.max(5, Math.min(600, Number(flags.wait) || 180));
  const r = await api(creds, '/git/api/build', { method: 'POST', body: JSON.stringify({ project: t.project, path: t.path, wait }) });
  const where = `${t.project}/${t.path}`;
  if (r.running) { process.stdout.write(`… ${where}: still building after ${wait}s — try again with a longer --wait\n`); process.exitCode = 2; return; }
  if (flags.log) process.stdout.write(r.log_tail + '\n');
  if (r.ok) {
    process.stdout.write(`✓ ${where} compiled${r.warnings?.length ? ` (${r.warnings.length} warning${r.warnings.length === 1 ? '' : 's'})` : ''}\n`);
    for (const w of (r.warnings ?? []).slice(0, 5)) process.stdout.write(`  warning: ${w}\n`);
  } else {
    process.stdout.write(`✗ ${where} does not compile:\n`);
    for (const e of r.errors ?? []) process.stdout.write(`  ${e}\n`);
    if (!r.errors?.length) process.stdout.write('  (no error message found — rerun with --log)\n');
    if (r.previous_build === 'ok') process.stdout.write('  The build before this one succeeded, so a recent change broke it: fix it, or step back with overlyx restore.\n');
    process.exitCode = 1;
  }
  if (flags.pdf && r.pdf) {
    const res = await fetch(`${creds.host}/git/api/pdf?project=${encodeURIComponent(t.project)}&path=${encodeURIComponent(t.path)}`, { headers: { Authorization: basic(creds.username, creds.token) } });
    if (!res.ok) fail(`cannot download the PDF: ${res.status} ${res.statusText}`);
    fs.writeFileSync(path.resolve(String(flags.pdf)), Buffer.from(await res.arrayBuffer()));
    process.stdout.write(`PDF: ${path.resolve(String(flags.pdf))}\n`);
  }
}

/** The whole project as it was at an earlier commit, as a new commit on top (nothing is rewritten). */
async function restoreCommand(args, flags) {
  const creds = credentials(flags);
  const [project, commit] = args;
  if (!project || !/^[^/]+\/[^/]+$/.test(project) || !commit || !/^[0-9a-f]{7,64}$/i.test(commit)) fail('usage: overlyx restore <owner>/<project> COMMIT (a commit hash from git log)');
  const r = await api(creds, '/git/api/restore', { method: 'POST', body: JSON.stringify({ project, commit: commit.toLowerCase() }) });
  if (!r.restored) { process.stdout.write(`${project} is already as it was at ${commit}\n`); return; }
  process.stdout.write(`${project}: restored to ${commit} as a new commit (${r.files.length} file${r.files.length === 1 ? '' : 's'}: ${r.files.slice(0, 5).join(', ')}${r.files.length > 5 ? ', …' : ''})\n`);
}

/* ------------------------------------------------------------ MCP: local agents */

/*
 * Local agents (Claude Code, Codex, any MCP client) are registered with a command, not with an
 * address and a token: `overlyx mcp serve`. Every agent session starts the bridge, which reads the
 * login as it is now (a new token after `overlyx auth login` counts at once), asks the server how
 * to connect (GET /cli/mcp.json: the endpoint and the authorization header), and relays the MCP
 * messages between the agent (stdio) and the server (Streamable HTTP) — the tools, their
 * descriptions and instructions are the server's, as they are today. The bridge itself keeps up
 * to date: it installs a newer CLI from the server (checksummed) for the next session.
 */

const MCP_NAME = 'overlyx';

/** this CLI's own file (what the agents run) */
const selfPath = () => fs.realpathSync(process.argv[1]);

/** How the server wants to be reached: its MCP endpoint and authorization header (with a fallback for older servers). */
async function mcpConnection(creds) {
  const fallback = { url: `${creds.host}/mcp`, headers: { Authorization: `Bearer ${creds.token}` } };
  try {
    const res = await fetch(`${creds.host}/cli/mcp.json`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return fallback;
    const info = await res.json();
    const url = new URL(String(info.url ?? '/mcp'), creds.host + '/').toString();
    const headers = {};
    for (const [k, v] of Object.entries(info.headers ?? { Authorization: 'Bearer {token}' })) headers[k] = String(v).replaceAll('{token}', creds.token).replaceAll('{username}', creds.username ?? '');
    return { url, headers };
  } catch { return fallback; }
}

/** the JSON-RPC messages of a text/event-stream body, as they arrive */
async function* sseMessages(res, onId) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buf.search(/\r?\n\r?\n/)) >= 0) {
      const event = buf.slice(0, cut);
      buf = buf.slice(cut).replace(/^\r?\n\r?\n/, '');
      let data = '';
      for (const line of event.split(/\r?\n/)) {
        if (line.startsWith('data:')) data += (data ? '\n' : '') + line.slice(5).replace(/^ /, '');
        else if (line.startsWith('id:')) onId?.(line.slice(3).trim());
      }
      if (!data) continue;
      try { yield JSON.parse(data); } catch { /* not a JSON-RPC message */ }
    }
  }
}

/**
 * The OverLyX project the agent's directory is a clone of (its git remote is `<host>/git/<owner>/<name>.git`),
 * or null. The agent hears it at initialize: the documents are edited here, in the clone — as tracked
 * changes through the VS Code extension's local tools ("overlyx-local") where it has them — and pushed with git.
 */
async function cloneOf(host) {
  let remotes;
  try { remotes = (await execFileP('git', ['remote', '-v'], { encoding: 'utf8', timeout: 5000 })).stdout; } catch { return null; }
  for (const line of remotes.split('\n')) {
    const url = line.split(/\s+/)[1];
    if (!url) continue;
    try {
      const u = new URL(url);
      u.username = ''; u.password = '';
      const m = /^\/git\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(u.pathname);
      if (m && `${u.protocol}//${u.host}` === host.replace(/\/$/, '')) return { project: `${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`, remote: line.split(/\s+/)[0], synced: await syncRunning('.') };
    } catch { /* an ssh or local remote */ }
  }
  return null;
}

function withCloneInstructions(msg, clone) {
  if (!msg || !msg.result) return msg;
  const note = `This directory is a git clone of the OverLyX project "${clone.project}" (git remote "${clone.remote}"). Edit its documents here, in these files: `
    + `with the tools of the "overlyx-local" server where you have them (edit_document, write_document, add_comment — your edits become tracked changes the user reviews in the OverLyX editor), otherwise directly. `
    + (clone.synced
      ? `OverLyX keeps this clone in step with the server (sync running): files saved here reach the server within seconds and changes made there arrive here — no pull or push needed. The tools below (project "${clone.project}") work on the server's copy, which is the same content; prefer the local files.`
      : `Commit and push with git when the user asks (pull first). The tools below (project "${clone.project}") work on the copy on the OverLyX server, which changes only with a push — use them only when the user asks about that copy.`);
  return { ...msg, result: { ...msg.result, instructions: msg.result.instructions ? `${note}\n\n${msg.result.instructions}` : note } };
}

async function mcpServe(flags) {
  const creds = credentials(flags, false);
  let session = null, protocol = null, closing = false, lastEventId = null;
  // to the agent: one message per line; the protocol version the server answered with goes on every later request
  const out = (m) => {
    if (m && m.result && typeof m.result.protocolVersion === 'string') protocol = m.result.protocolVersion;
    process.stdout.write(JSON.stringify(m) + '\n');
  };
  const log = (t) => process.stderr.write(`overlyx mcp: ${t}\n`);
  // a newer CLI for the next session (never on stdout: that is the agent's)
  void maybeSelfUpdate(creds.host).catch(() => undefined);
  const notLoggedIn = !creds.token;
  const clone = await cloneOf(creds.host);
  const conn = notLoggedIn ? null : await mcpConnection(creds);
  let initialized = null;   // the initialize round trip: everything else waits for it (the session id)

  const errorFor = (msg, text) => { if (msg && msg.id !== undefined && msg.method) out({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: text } }); };
  const headers = (extra = {}) => ({ ...conn.headers, ...(session ? { 'Mcp-Session-Id': session } : {}), ...(protocol ? { 'MCP-Protocol-Version': protocol } : {}), ...extra });

  async function post(msg, transform) {
    const emit = transform ? (m) => out(transform(m)) : out;
    let res;
    try {
      res = await fetch(conn.url, { method: 'POST', headers: headers({ 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }), body: JSON.stringify(msg) });
    } catch (e) { errorFor(msg, `cannot reach ${creds.host}: ${e.cause?.message ?? e.message}`); return; }
    const sid = res.headers.get('mcp-session-id');
    if (sid) session = sid;
    if (res.status === 202) return;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let detail = text;
      try { const j = JSON.parse(text); detail = j.error?.message ?? j.error ?? text; } catch { /* plain text */ }
      if (res.status === 401) detail = `the server refused the login (${detail}) — run: overlyx auth login --host ${creds.host}`;
      // an answer that is itself a JSON-RPC error goes to the agent as it is
      try { const j = JSON.parse(text); if (j && j.jsonrpc && msg.id !== undefined) { emit({ ...j, id: j.id ?? msg.id }); return; } } catch { /* not JSON-RPC */ }
      errorFor(msg, `OverLyX: ${detail || res.status}`);
      return;
    }
    const type = res.headers.get('content-type') ?? '';
    if (type.includes('text/event-stream')) { for await (const m of sseMessages(res)) emit(m); return; }
    const text = await res.text();
    if (!text.trim()) return;
    const body = JSON.parse(text);
    for (const m of Array.isArray(body) ? body : [body]) emit(m);
  }

  /** what the server sends on its own (Claude Code's session: messages written to the agent in OverLyX) */
  async function eventStream() {
    let delay = 1000;
    while (!closing && session) {
      try {
        const res = await fetch(conn.url, { method: 'GET', headers: headers({ Accept: 'text/event-stream', ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}) }) });
        if (res.status === 405 || res.status === 404) return;   // no stream for this client
        if (res.ok) { delay = 1000; for await (const m of sseMessages(res, id => { lastEventId = id; })) out(m); }
      } catch { /* the connection dropped: again in a moment */ }
      if (closing) return;
      await new Promise(r => setTimeout(r, delay));
      delay = Math.min(30000, delay * 2);
    }
  }

  async function handle(msg) {
    if (notLoggedIn) {
      const cli = path.basename(selfPath()) === 'overlyx' ? 'overlyx' : `node ${selfPath()}`;
      errorFor(msg, `not signed in to ${creds.host} — run once in a terminal: ${cli} auth login${creds.host === DEFAULT_HOST ? '' : ` --host ${creds.host}`} (it opens the browser to authorize)`);
      return;
    }
    if (msg.method === 'initialize') {
      initialized = post(msg, clone ? (m) => withCloneInstructions(m, clone) : undefined);
      await initialized;
      return;
    }
    if (initialized) await initialized;
    await post(msg);
    if (msg.method === 'notifications/initialized' && session) void eventStream();
  }

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const pending = new Set();
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { log('ignored a line that is not JSON'); return; }
    const p = Promise.all((Array.isArray(msg) ? msg : [msg]).map(m => handle(m).catch(e => errorFor(m, String(e.message ?? e)))));
    pending.add(p);
    void p.finally(() => pending.delete(p));
  });
  await new Promise(resolve => rl.on('close', resolve));
  await Promise.allSettled([...pending]);
  closing = true;
  if (session && conn) await fetch(conn.url, { method: 'DELETE', headers: headers(), signal: AbortSignal.timeout(3000) }).catch(() => undefined);
  process.exit(0);
}

/* ------------------------------------------------------------ keeping the CLI up to date */

const newer = (a, b) => {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0); }
  return false;
};

/**
 * Replace this CLI with the server's newer one (sha256-checked, as the installer does). Only an
 * installed copy (the file `overlyx` the installer writes) replaces itself — never a checkout.
 */
async function selfUpdate(host) {
  const self = selfPath();
  if (path.basename(self) !== 'overlyx') return { skipped: `${self} is not an installed copy (the installer's \`overlyx\`)` };
  const info = await (await fetch(`${host}/cli/version`, { signal: AbortSignal.timeout(8000) })).json();
  if (!newer(info.version, VERSION)) return { current: VERSION };
  const res = await fetch(`${host}/cli/v${info.version}/overlyx`, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) fail(`cannot download the CLI: ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  if (crypto.createHash('sha256').update(body).digest('hex') !== info.sha256) fail('checksum verification failed');
  const tmp = path.join(path.dirname(self), `.overlyx.${process.pid}`);
  fs.writeFileSync(tmp, body, { mode: 0o755 });
  fs.renameSync(tmp, self);
  return { updated: info.version };
}

/** At most once an hour, quietly (the MCP bridge: the next agent session runs the new one). */
async function maybeSelfUpdate(host) {
  const stamp = path.join(path.dirname(configFile()), 'update-check');
  try { if (Date.now() - fs.statSync(stamp).mtimeMs < 3600_000) return; } catch { /* never checked */ }
  try { fs.mkdirSync(path.dirname(stamp), { recursive: true, mode: 0o700 }); fs.writeFileSync(stamp, ''); } catch { return; }
  const r = await selfUpdate(host);
  if (r.updated) process.stderr.write(`overlyx: updated to ${r.updated} (from the next session on)\n`);
}

async function updateCommand(flags) {
  const host = credentials(flags, false).host;
  const r = await selfUpdate(host);
  process.stdout.write(r.updated ? `Updated the OverLyX CLI to ${r.updated}\n` : r.current ? `The OverLyX CLI is up to date (${VERSION})\n` : `Not updated: ${r.skipped}\n`);
}

/* ------------------------------------------------------------ registering with the agents */

const codexConfig = () => path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'config.toml');

async function has(command) {
  try { await execFileP(command, ['--version'], { timeout: 15000 }); return true; } catch { return false; }
}

/** The bridge command an agent runs (with --host when it is not the default login). */
function serveArgs(flags) {
  return ['mcp', 'serve', ...(flags.host ? ['--host', normalizeHost(flags.host)] : [])];
}

/** config.toml without its [mcp_servers.overlyx] table (and that table's sub-tables) */
function withoutCodexServer(text) {
  const lines = text.split('\n');
  const out = [];
  let skipping = false;
  for (const line of lines) {
    const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(line);
    if (header) skipping = header[1] === `mcp_servers.${MCP_NAME}` || header[1].startsWith(`mcp_servers.${MCP_NAME}.`);
    if (!skipping) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

const tomlString = (v) => JSON.stringify(v);   // a TOML basic string: JSON's escapes are TOML's

function codexServerTable(args) {
  return `[mcp_servers.${MCP_NAME}]\n# OverLyX (overlyx mcp install): the CLI relays to the server with your login — re-run nothing when either changes\ncommand = ${tomlString(selfPath())}\nargs = [${args.map(tomlString).join(', ')}]\n`;
}

function codexRegistered() {
  try { return new RegExp(`^\\s*\\[mcp_servers\\.${MCP_NAME}\\]`, 'm').test(fs.readFileSync(codexConfig(), 'utf8')); } catch { return false; }
}

async function claudeRegistered() {
  try { const r = await execFileP('claude', ['mcp', 'get', MCP_NAME], { encoding: 'utf8', timeout: 20000 }); return /mcp serve/.test(r.stdout) ? 'bridge' : 'other'; } catch { return null; }
}

/*
 * Claude Code asks before it uses each tool of a server the first time, and "don't ask again" holds
 * only in the directory it was started in. Launched from anywhere, that is a prompt per tool per
 * folder: `mcp install` allows OverLyX's tools once, in Claude Code's user settings (the rule
 * `mcp__overlyx`, merged into permissions.allow; `--ask-each-time` leaves it out). Their edits are
 * tracked changes and every state stays in the project's history.
 */
const CLAUDE_ALLOW = `mcp__${MCP_NAME}`;
const claudeSettingsFile = () => path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'settings.json');
function readClaudeSettings() {
  const file = claudeSettingsFile();
  if (!fs.existsSync(file)) return {};
  let v;
  try { v = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error(`${file} is not plain JSON — add "${CLAUDE_ALLOW}" to permissions.allow there yourself`); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${file} is not a settings object`);
  return v;
}
function claudeToolsAllowed() {
  try { const a = readClaudeSettings().permissions?.allow; return Array.isArray(a) && a.includes(CLAUDE_ALLOW); } catch { return false; }
}
/** Add (or take out) the rule; everything else in the file stays as it is. Returns whether the file changed. */
function allowClaudeTools(on) {
  const settings = readClaudeSettings();
  const perms = settings.permissions && typeof settings.permissions === 'object' && !Array.isArray(settings.permissions) ? settings.permissions : {};
  const allow = Array.isArray(perms.allow) ? perms.allow : [];
  if (allow.includes(CLAUDE_ALLOW) === on) return false;
  settings.permissions = { ...perms, allow: on ? [...allow, CLAUDE_ALLOW] : allow.filter(r => r !== CLAUDE_ALLOW) };
  const file = claudeSettingsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.overlyx-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', { mode: fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600 });
  fs.renameSync(tmp, file);
  return true;
}
async function registerClaude(args) {
  // replaced, whatever was there (an older URL + token registration included), in every scope it may be in
  for (const scope of ['user', 'local']) await execFileP('claude', ['mcp', 'remove', MCP_NAME, '-s', scope], { timeout: 20000 }).catch(() => undefined);
  await execFileP('claude', ['mcp', 'add', '-s', 'user', MCP_NAME, '--', selfPath(), ...args], { encoding: 'utf8', timeout: 20000 });
}

function registerCodex(args) {
  const file = codexConfig();
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* a new config */ }
  // `overlyx` defined some other way (inline table, dotted keys): left to the user, not duplicated
  if (new RegExp(`^\\s*(mcp_servers\\.)?${MCP_NAME}\\s*(=|\\.)`, 'm').test(text)) fail(`${file} defines "${MCP_NAME}" in another form — remove it there, then run overlyx mcp install again`);
  if (text && !fs.existsSync(file + '.bak')) fs.copyFileSync(file, file + '.bak');
  const rest = withoutCodexServer(text).replace(/\s*$/, '');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, (rest ? rest + '\n\n' : '') + codexServerTable(args));
}

function unregisterCodex() {
  const file = codexConfig();
  try { const t = fs.readFileSync(file, 'utf8'); const r = withoutCodexServer(t); if (r !== t) { fs.writeFileSync(file, r.replace(/\s*$/, '\n')); return true; } } catch { /* none */ }
  return false;
}

async function ask(question) {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise(resolve => rl.question(question, resolve));
  rl.close();
  return !/^\s*n/i.test(String(answer));
}

/** Which agents to register with: the ones named, or those found on this computer. */
async function agentsFor(flags) {
  const named = flags.client ? String(flags.client).split(',').map(s => s.trim().toLowerCase()).filter(Boolean) : null;
  const found = { claude: await has('claude'), codex: (await has('codex')) || fs.existsSync(path.dirname(codexConfig())) };
  return { claude: named ? named.includes('claude') : found.claude, codex: named ? named.includes('codex') : found.codex, found };
}

async function mcpInstall(flags) {
  const creds = credentials(flags, false);
  const args = serveArgs(flags);
  const agents = await agentsFor(flags);
  if (!agents.claude && !agents.codex) {
    process.stdout.write(`No Claude Code or Codex found. For any MCP client, add this command (stdio):\n  ${selfPath()} ${args.join(' ')}\n`);
    return;
  }
  const names = [agents.claude && 'Claude Code', agents.codex && 'Codex'].filter(Boolean).join(' and ');
  const quiet = agents.claude && !flags['ask-each-time'];
  if (!flags.yes && !(await ask(`Let ${names} use OverLyX (registers \`overlyx mcp serve\` with them${quiet ? '; Claude Code then uses its tools without asking each time' : ''})? [Y/n] `))) { process.stdout.write('Not registered. Later: overlyx mcp install\n'); return; }
  if (agents.claude) {
    try {
      await registerClaude(args);
      process.stdout.write('Claude Code: registered "overlyx" (all directories)\n');
      if (quiet) {
        try { allowClaudeTools(true); process.stdout.write(`Claude Code: OverLyX's tools run without asking, in every directory (${CLAUDE_ALLOW} in ${claudeSettingsFile()})\n`); }
        catch (e) { process.stdout.write(`Claude Code: it will ask before each OverLyX tool — ${e.message}\n`); }
      }
    } catch (e) { process.stdout.write(`Claude Code: not registered — ${String(e.stderr || e.message).trim()}\n`); }
  }
  if (agents.codex) {
    try { registerCodex(args); process.stdout.write(`Codex: registered "overlyx" in ${codexConfig()}\n`); }
    catch (e) { process.stdout.write(`Codex: not registered — ${e.message}\n`); }
  }
  if (!creds.token) process.stdout.write(`The agents connect once you are signed in: overlyx auth login${creds.host === DEFAULT_HOST ? '' : ` --host ${creds.host}`}\n`);
  else process.stdout.write(`They act as ${creds.username} on ${creds.host}; new tools and server changes reach them without registering again.\n`);
}

async function mcpUninstall() {
  let any = false;
  if (await has('claude')) for (const scope of ['user', 'local']) { try { await execFileP('claude', ['mcp', 'remove', MCP_NAME, '-s', scope], { timeout: 20000 }); any = true; process.stdout.write(`Claude Code: removed "overlyx" (${scope})\n`); } catch { /* not there */ } }
  try { if (allowClaudeTools(false)) process.stdout.write(`Claude Code: ${CLAUDE_ALLOW} taken out of ${claudeSettingsFile()}\n`); } catch { /* not plain JSON: left alone */ }
  if (unregisterCodex()) { any = true; process.stdout.write(`Codex: removed "overlyx" from ${codexConfig()}\n`); }
  if (!any) process.stdout.write('OverLyX was not registered with Claude Code or Codex\n');
}

/** Registrations, and a real round trip through the server: initialize + tools/list. */
async function mcpStatus(flags) {
  const claude = await has('claude') ? await claudeRegistered() : undefined;
  process.stdout.write(`Claude Code: ${claude === undefined ? 'not installed' : claude === 'bridge' ? `registered${claudeToolsAllowed() ? ', its tools run without asking' : ', asks before each tool (overlyx mcp install allows them)'}` : claude === 'other' ? 'registered another way (overlyx mcp install replaces it)' : 'not registered'}\n`);
  process.stdout.write(`Codex: ${codexRegistered() ? `registered (${codexConfig()})` : 'not registered'}\n`);
  const creds = credentials(flags, false);
  if (!creds.token) { process.stdout.write(`Server: not logged in to ${creds.host}\n`); return; }
  const conn = await mcpConnection(creds);
  const call = async (body, session) => {
    const res = await fetch(conn.url, { method: 'POST', headers: { ...conn.headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(session ? { 'Mcp-Session-Id': session } : {}) }, body: JSON.stringify(body) });
    if (!res.ok) fail(`${conn.url}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const type = res.headers.get('content-type') ?? '';
    const msgs = [];
    if (type.includes('text/event-stream')) { for await (const m of sseMessages(res)) msgs.push(m); } else msgs.push(JSON.parse(await res.text()));
    return { msg: msgs.find(m => m.id === body.id) ?? msgs[0], session: res.headers.get('mcp-session-id') ?? session };
  };
  const init = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'overlyx-cli', version: VERSION } } });
  const tools = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, init.session);
  process.stdout.write(`Server: ${conn.url} answers as ${creds.username}: ${tools.msg?.result?.tools?.length ?? 0} tools (${init.msg?.result?.serverInfo?.name ?? 'MCP'} ${init.msg?.result?.serverInfo?.version ?? ''})\n`);
}

async function mcpCommand(action, flags) {
  if (action === 'serve') return mcpServe(flags);
  if (action === 'install') return mcpInstall(flags);
  if (action === 'uninstall' || action === 'remove') return mcpUninstall();
  if (action === 'status' || !action) return mcpStatus(flags);
  fail(`unknown mcp command: ${action}`);
}

/* ------------------------------------------------------------ sync: a clone kept in step with the server */

/*
 * `overlyx sync [DIR] [--watch]`, and the VS Code extension (which bundles this file): a git clone of
 * an OverLyX project stays in step with the server both ways — what is saved here reaches the
 * project (and the people editing it in the browser) within seconds, and what they write arrives
 * here. File contents travel, not commits (server: sync.ts), so the project's history keeps
 * OverLyX's own schedule; the local branch follows the server's commits, and a commit made here
 * becomes one on the server with its message.
 *
 * State, in the clone's git directory (overlyx-sync/): for every file, the hash of the version both
 * sides last agreed on (the merge base of the next change), and those versions of the text files.
 * A file changed here is sent with its base: applied when the server still has that version, else
 * merged there (a document paragraph by paragraph, the clone's text as a tracked change where both
 * changed the same one; other text by lines). What cannot be merged keeps the server's version, and
 * this side's goes next to it as a conflict copy. Nothing is ever overwritten that changed here
 * since it was last in step, and a file open with unsaved changes in an editor (`isBusy`) waits.
 */

const SYNC_FILE_MAX = 20 * 1024 * 1024;      // larger files stay out of the sync (both sides)
const SYNC_TEXT_MAX = 4 * 1024 * 1024;       // text sent with its base for a merge
const SYNC_BATCH = 12 * 1024 * 1024;         // content per push request
const SYNC_BATCH_FILES = 200;                // files per push request (the server takes at most 1000)

export function blobHash(buf) {
  return crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}
const isTextBuf = (b) => b.length <= SYNC_TEXT_MAX && !b.includes(0) && Buffer.from(b.toString('utf8'), 'utf8').equals(b);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** a project-relative path the sync may touch: no way out of the clone, never into .git, not our temp files */
function syncablePath(rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || rel.includes('\\') || rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || rel.endsWith('.overlyx-tmp')) return false;
  return rel.split('/').every(p => p !== '' && p !== '.' && p !== '..' && p.toLowerCase() !== '.git' && p.toLowerCase() !== 'git~1');
}

async function gitOut(dir, args, opts = {}) {
  return (await execFileP('git', ['-C', dir, ...args], { encoding: opts.encoding ?? 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...opts.env }, timeout: opts.timeout ?? 120000 })).stdout;
}

/** An OverLyX remote URL → { host, project } (host may carry a path prefix in front of /git/). */
/**
 * A detached HEAD (a submodule after `git submodule update` sits on a commit, not a branch): put
 * `branch` on it so that the branch can follow the server's commits — only when that changes no file
 * and loses no commit: the branch does not exist yet (made at HEAD), is at HEAD, or is behind it (moved
 * forward to HEAD). HEAD keeps its commit, so the index and the files stay exactly as they are.
 * Resolves with null when it attached, else why not ('commits': the branch has commits HEAD lacks).
 */
export async function attachDetachedHead(dir, branch) {
  if ((await gitOut(dir, ['symbolic-ref', '-q', 'HEAD']).catch(() => '')).trim()) return 'attached already';
  const head = (await gitOut(dir, ['rev-parse', '-q', '--verify', 'HEAD']).catch(() => '')).trim();
  if (!head) return 'no commit';
  const ref = `refs/heads/${branch}`;
  const at = (await gitOut(dir, ['rev-parse', '-q', '--verify', ref]).catch(() => '')).trim();
  if (at && at !== head && !(await gitOut(dir, ['merge-base', '--is-ancestor', at, head]).then(() => true, () => false))) return 'commits';
  const why = 'overlyx sync: the detached HEAD onto its branch';
  // the expected old value guards against a branch moved meanwhile (40 zeros: it must not exist)
  if (at !== head) await gitOut(dir, ['update-ref', '-m', why, ref, head, at || '0'.repeat(head.length)]);
  await gitOut(dir, ['symbolic-ref', '-m', why, 'HEAD', ref]);
  return null;
}

export function parseSyncRemote(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const m = /^(.*?)\/git\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(u.pathname);
  if (!m) return null;
  return { host: `${u.protocol}//${u.host}${m[1]}`.replace(/\/$/, ''), project: `${decodeURIComponent(m[2])}/${decodeURIComponent(m[3])}` };
}

/** The OverLyX project the checkout at `dir` is a clone of (its remotes: origin first, then overlyx), or null. */
export async function syncTarget(dir) {
  let names;
  try { names = (await gitOut(dir, ['remote'], { timeout: 10000 })).split('\n').filter(Boolean); } catch { return null; }
  names.sort((a, b) => (a === 'origin' ? -2 : a === 'overlyx' ? -1 : 0) - (b === 'origin' ? -2 : b === 'overlyx' ? -1 : 0));
  for (const remote of names) {
    let url;
    try { url = (await gitOut(dir, ['remote', 'get-url', remote], { timeout: 10000 })).trim(); } catch { continue; }
    const t = parseSyncRemote(url);
    if (t) return { ...t, remote, url };
  }
  return null;
}

/** The sign-in for `host`: the CLI's own (overlyx auth login), else what git's credential helpers have for it. */
export async function syncCredentials(host, dir) {
  if (process.env.OVERLYX_TOKEN && process.env.OVERLYX_USERNAME) return { username: process.env.OVERLYX_USERNAME, token: process.env.OVERLYX_TOKEN };
  try {
    const saved = readConfig().hosts[host];
    if (saved?.username && saved?.token) return { username: saved.username, token: saved.token };
  } catch { /* no CLI config */ }
  const u = new URL(host);
  try {
    const out = await new Promise((resolve, reject) => {
      const child = execFile('git', ['-C', dir, 'credential', 'fill'], { encoding: 'utf8', timeout: 15000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' } }, (e, stdout) => e ? reject(e) : resolve(stdout));
      child.stdin.end(`protocol=${u.protocol.slice(0, -1)}\nhost=${u.host}\n\n`);
    });
    const f = Object.fromEntries(out.split('\n').map(l => l.split(/=(.*)/s)).filter(p => p[0]).map(p => [p[0], p[1] ?? '']));
    if (f.username && f.password) return { username: f.username, token: f.password };
  } catch { /* no helper has it */ }
  return null;
}

class SyncHttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/**
 * The sync of one clone. `opts`: dir, host, project, remote, auth {username, token}, client (a name
 * for this computer), app ('vscode' | 'cli': what runs it, told to the server), isBusy(rel) → true
 * while an editor holds unsaved changes of the file, onStatus(status), log(line).
 */
export class SyncEngine {
  constructor(opts) {
    this.o = opts;
    this.dir = path.resolve(opts.dir);
    this.hashes = new Map();       // rel → { size, mtime, ino, hash } of local files
    this.failed = new Map();       // rel → retry-after time, for files the server refused
    this.status = { state: 'idle', conflicts: [], waiting: [], notSent: [], lastSync: 0, message: '' };
    this.running = null;
    this.again = false;
    this.stopped = false;
    this.cursor = null;
    this.role = null;
  }

  log(line) { this.o.log?.(line); }
  setStatus(patch) { this.status = { ...this.status, ...patch }; this.o.onStatus?.(this.status); }

  /* ---- the server */

  async request(pathname, init = {}) {
    const url = `${this.o.host}/git/api/sync/${pathname}`;
    let res;
    try {
      // what this clone is and where (the web interface shows "in sync with VS Code / a clone on <host>")
      const who = { 'X-OverLyX-Sync-App': this.o.app ?? 'cli', 'X-OverLyX-Sync-Host': encodeURIComponent(this.o.client ?? os.hostname()) };
      res = await fetch(url, { ...init, headers: { Authorization: basic(this.o.auth.username, this.o.auth.token), ...who, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers }, signal: init.signal ?? AbortSignal.timeout(init.timeout ?? 120000) });
    } catch (e) { throw new SyncHttpError(0, `cannot reach ${this.o.host}: ${e.cause?.message ?? e.message}`); }
    if (init.raw && res.ok) return res;
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok) throw new SyncHttpError(res.status, body?.error ?? (text.trim() || `${res.status} ${res.statusText}`));
    return body;
  }

  q(extra = {}) { return new URLSearchParams({ project: this.o.project, ...extra }).toString(); }

  async remoteState() { return this.request(`state?${this.q()}`); }

  async download(rel, hash) {
    const res = await this.request(`file?${this.q({ path: rel })}`, { raw: true });
    const buf = Buffer.from(await res.arrayBuffer());
    if (blobHash(buf) !== hash) return null;   // changed again meanwhile: the next round
    return buf;
  }

  /* ---- local state (in the git directory) */

  async open() {
    this.gitDir = (await gitOut(this.dir, ['rev-parse', '--absolute-git-dir'])).trim();
    this.stateDir = path.join(this.gitDir, 'overlyx-sync');
    fs.mkdirSync(path.join(this.stateDir, 'objects'), { recursive: true });
    this.autocrlf = (await gitOut(this.dir, ['config', '--get', 'core.autocrlf']).catch(() => '')).trim();
    try { this.state = JSON.parse(fs.readFileSync(path.join(this.stateDir, 'state.json'), 'utf8')); } catch { this.state = null; }
    if (this.state && (this.state.project !== this.o.project || this.state.host !== this.o.host)) this.state = null;
  }

  saveState() {
    const file = path.join(this.stateDir, 'state.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify(this.state));
    fs.renameSync(file + '.tmp', file);
  }

  keepObject(hash, buf) {
    if (!isTextBuf(buf)) return;
    const f = path.join(this.stateDir, 'objects', hash);
    if (!fs.existsSync(f)) { fs.writeFileSync(f + '.tmp', buf); fs.renameSync(f + '.tmp', f); }
  }

  async baseText(hash) {
    try { return fs.readFileSync(path.join(this.stateDir, 'objects', hash), 'utf8'); } catch { /* not kept: git may have it */ }
    try { return await gitOut(this.dir, ['cat-file', 'blob', hash]); } catch { return null; }
  }

  /** Drop kept versions no file refers to any more. */
  collect() {
    const keep = new Set(Object.values(this.state.files));
    for (const n of fs.readdirSync(path.join(this.stateDir, 'objects'))) if (!keep.has(n)) fs.rmSync(path.join(this.stateDir, 'objects', n), { force: true });
  }

  /** One sync process per clone (the VS Code extension and a terminal's `overlyx sync --watch` would race). */
  lock() {
    const file = path.join(this.stateDir, 'lock');
    const me = { pid: process.pid, at: Date.now(), by: this.o.client ?? '' };
    try {
      const other = JSON.parse(fs.readFileSync(file, 'utf8'));
      let alive = other.pid !== process.pid && Date.now() - other.at < 120000;
      if (alive) { try { process.kill(other.pid, 0); } catch (e) { alive = e.code === 'EPERM'; } }
      if (alive) return other;
    } catch { /* free */ }
    fs.writeFileSync(file, JSON.stringify(me));
    return null;
  }

  unlock() {
    const file = path.join(this.stateDir ?? '', 'lock');
    try { if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) fs.rmSync(file, { force: true }); } catch { /* not ours */ }
  }

  /* ---- local files */

  /** The file's hash (CRLF counted as LF where git converts line endings), null when missing, undefined when not synced (a link, a directory, too large). */
  localHash(rel) {
    if (!syncablePath(rel) || this.belowLink(rel)) return undefined;
    let st;
    try { st = fs.lstatSync(path.join(this.dir, rel)); } catch { this.hashes.delete(rel); return null; }
    if (!st.isFile() || st.size > SYNC_FILE_MAX) return undefined;
    const c = this.hashes.get(rel);
    if (c && c.size === st.size && c.mtime === st.mtimeMs && c.ino === st.ino) return c.hash;
    const hash = blobHash(this.normalized(fs.readFileSync(path.join(this.dir, rel))));
    this.hashes.set(rel, { size: st.size, mtime: st.mtimeMs, ino: st.ino, hash });
    return hash;
  }

  /** a directory on the way to `rel` is a link (or not a directory): nothing is read or written through it */
  belowLink(rel) {
    const parts = rel.split('/');
    let p = this.dir;
    for (const part of parts.slice(0, -1)) {
      p = path.join(p, part);
      let st;
      try { st = fs.lstatSync(p); } catch { return false; }   // missing: made as a real directory when written
      if (!st.isDirectory()) return true;
    }
    return false;
  }

  normalized(buf) {
    if ((this.autocrlf === 'true' || this.autocrlf === 'input') && buf.includes(13) && isTextBuf(buf)) return Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
    return buf;
  }

  readLocal(rel) { return this.normalized(fs.readFileSync(path.join(this.dir, rel))); }

  /** Every local file the sync looks at: git's view (tracked + untracked, the project's .gitignore files) and the files of the last state. */
  async localPaths() {
    const out = await gitOut(this.dir, ['ls-files', '-z', '--cached', '--others', '--exclude-per-directory=.gitignore']);
    const paths = new Set(out.split('\0').filter(syncablePath));
    for (const rel of Object.keys(this.state.files)) paths.add(rel);
    return paths;
  }

  /** Write `buf` as the file, unless it changed since it had hash `expect` (null: it did not exist). */
  writeLocal(rel, buf, expect) {
    const abs = path.join(this.dir, rel);
    if (this.localHash(rel) !== expect) return false;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.overlyx-tmp`;
    fs.writeFileSync(tmp, buf);
    try { const mode = fs.statSync(abs).mode; fs.chmodSync(tmp, mode); } catch { /* new file */ }
    if (this.localHash(rel) !== expect) { fs.rmSync(tmp, { force: true }); return false; }
    fs.renameSync(tmp, abs);
    this.hashes.delete(rel);
    return true;
  }

  removeLocal(rel, expect) {
    if (this.localHash(rel) !== expect) return false;
    fs.rmSync(path.join(this.dir, rel), { force: true });
    this.hashes.delete(rel);
    return true;
  }

  /** `dir/name (conflict, <computer> <date>).ext` next to `rel`, holding this side's version. */
  conflictCopy(rel, buf) {
    const ext = path.extname(rel), stem = rel.slice(0, rel.length - ext.length);
    const d = new Date(), pad = (n) => String(n).padStart(2, '0');
    const when = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`;
    let name = `${stem} (conflict, ${this.o.client || os.hostname()} ${when})${ext}`;
    for (let i = 2; fs.existsSync(path.join(this.dir, name)); i++) name = `${stem} (conflict ${i}, ${this.o.client || os.hostname()} ${when})${ext}`;
    fs.writeFileSync(path.join(this.dir, name), buf);
    return name;
  }

  /* ---- git: the branch follows the server */

  async gitAuthEnv(extraHeaders) {
    const env = {};
    const headers = [`Authorization: ${basic(this.o.auth.username, this.o.auth.token)}`, ...extraHeaders];
    const count = /^\d+$/.test(process.env.GIT_CONFIG_COUNT ?? '') ? Number(process.env.GIT_CONFIG_COUNT) : 0;
    headers.forEach((h, i) => { env[`GIT_CONFIG_KEY_${count + i}`] = 'http.extraHeader'; env[`GIT_CONFIG_VALUE_${count + i}`] = h; });
    env.GIT_CONFIG_COUNT = String(count + headers.length);
    return env;
  }

  /** Fetch the server's branch without making the server commit (it has nothing new for a synced clone). */
  async fetchBranch(branch) {
    const env = await this.gitAuthEnv(['X-OverLyX-Sync: 1']);
    await gitOut(this.dir, ['fetch', '-q', this.o.remote, `+refs/heads/${branch}:refs/remotes/${this.o.remote}/${branch}`], { env, timeout: 300000 });
    return (await gitOut(this.dir, ['rev-parse', `refs/remotes/${this.o.remote}/${branch}`])).trim();
  }

  async localBranch() {
    return (await gitOut(this.dir, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')).trim() || null;
  }

  async busyGit() {
    for (const f of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG']) if (fs.existsSync(path.join(this.gitDir, f))) return f;
    return null;
  }

  /** The first sync of this clone: the merge base of every file is the server's last commit (fetched now), or what is checked out. */
  async initialState(remote) {
    let commit = null;
    if (remote.head && remote.branch) { try { commit = await this.fetchBranch(remote.branch); } catch (e) { this.log(`fetch: ${e.message.trim()}`); } }
    if (!commit) commit = (await gitOut(this.dir, ['rev-parse', '-q', '--verify', 'HEAD']).catch(() => '')).trim() || null;
    const files = {};
    if (commit) {
      for (const line of (await gitOut(this.dir, ['ls-tree', '-r', '-z', commit])).split('\0')) {
        const m = /^(\d+) blob ([0-9a-f]+)\t(.*)$/s.exec(line);
        if (m && m[1] !== '120000' && m[1] !== '160000') files[m[3]] = m[2];
      }
    }
    return { version: 1, host: this.o.host, project: this.o.project, files, head: null };
  }

  /** The local branch moves to the server's commits; commits made here are recorded there (their messages, on what both sides now hold). */
  async followBranch(remote, inStep) {
    if (!remote.head || !remote.branch) return;
    let branch = await this.localBranch();
    if (!branch) {
      // a detached HEAD (a submodule): onto the server's branch when no file and no commit is affected
      const why = await attachDetachedHead(this.dir, remote.branch);
      if (!why) { branch = remote.branch; this.log(`HEAD was detached (a submodule?): now on ${branch}, which follows the server's commits`); }
      else if (!this.detachedNoted) {
        this.detachedNoted = true;
        this.log(why === 'commits'
          ? `HEAD is detached and ${remote.branch} has commits it lacks: files stay in step, the branch does not follow the server — git switch ${remote.branch} attaches it`
          : `HEAD is detached (${why}): files stay in step, the branch does not follow the server`);
      }
    }
    if (branch !== remote.branch) return;
    const tracking = `refs/remotes/${this.o.remote}/${remote.branch}`;
    const head = (await gitOut(this.dir, ['rev-parse', '-q', '--verify', 'HEAD']).catch(() => '')).trim();
    let known = (await gitOut(this.dir, ['rev-parse', '-q', '--verify', tracking]).catch(() => '')).trim();
    if (known !== remote.head) known = await this.fetchBranch(remote.branch);
    if (!known || head === known) { this.state.head = known; return; }
    const ancestor = async (a, b) => { try { await gitOut(this.dir, ['merge-base', '--is-ancestor', a, b]); return true; } catch { return false; } };
    if (head && !(await ancestor(head, known))) {
      // commits made here: their changes are on the server already (the files are in step), their messages become a commit there
      if (!inStep || this.role === 'view') return;
      const ownLog = (await gitOut(this.dir, ['log', '--reverse', '--format=%B%x00', head, '--not', known]).catch(() => '')).split('\0').map(s => s.trim()).filter(Boolean);
      if (!ownLog.length) return;
      const r = await this.request('commit', { method: 'POST', body: JSON.stringify({ project: this.o.project, message: ownLog.join('\n\n') }) });
      known = await this.fetchBranch(remote.branch);
      if (!r?.head || known !== r.head) return;
      this.log(`commit recorded on ${this.o.host}: ${r.head.slice(0, 7)} ${ownLog[0].split('\n')[0]}`);
    }
    // the index follows the branch, the files stay as they are (they are in step already)
    await gitOut(this.dir, ['reset', '-q', '--mixed', known]);
    this.state.head = known;
  }

  /* ---- one round */

  /** Sync once; resolves with what changed. Concurrent calls run one after the other. */
  sync() {
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      let result;
      try {
        // again: a file changed while it was read, or sync() was called meanwhile — at most a few rounds in a row
        let n = 0;
        do { this.again = false; result = await this.round(); } while (this.again && !this.stopped && ++n < 4);
      } finally { this.running = null; }
      return result;
    })();
    return this.running;
  }

  async round() {
    const changes = { sent: [], received: [], conflicts: [], waiting: [], notSent: [], errors: [] };
    if (!this.gitDir) await this.open();
    const holder = this.lock();
    if (holder) { this.setStatus({ state: 'paused', message: `synced by another process (${holder.by || 'pid ' + holder.pid})` }); return changes; }
    const busy = await this.busyGit();
    if (busy) { this.setStatus({ state: 'paused', message: `git is in the middle of something (${busy}) — the sync waits` }); return changes; }
    this.setStatus({ state: 'syncing', message: '' });
    let remote = await this.remoteState();
    this.role = remote.role ?? this.role;
    const branch = await this.localBranch();
    if (remote.branch && branch && branch !== remote.branch) { this.setStatus({ state: 'paused', message: `on branch ${branch} — the sync runs on ${remote.branch}` }); return changes; }
    if (!this.state) { this.state = await this.initialState(remote); this.saveState(); }
    const base = this.state.files;
    const remoteHash = (r) => new Map(r.files.filter(f => syncablePath(f.path)).map(f => [f.path, f.hash]));
    let theirs = remoteHash(remote);
    const now = Date.now();

    // 1. what changed here goes to the server
    const send = [];
    for (const rel of await this.localPaths()) {
      const l = this.localHash(rel);
      if (l === undefined) continue;
      const b = base[rel] ?? null;
      if (l === b) continue;
      const r = theirs.get(rel) ?? null;
      if (l === r) { base[rel] = l; if (l) this.keepObject(l, this.readLocal(rel)); continue; }   // the same change on both sides
      if (l === null && b !== null && !theirs.has(rel)) { delete base[rel]; continue; }             // removed on both sides
      if (this.role === 'view') { changes.notSent.push(rel); continue; }
      if ((this.failed.get(rel) ?? 0) > now) continue;
      send.push(rel);
    }
    if (send.length) {
      await this.send(send, base, changes);
      remote = await this.remoteState();
      theirs = remoteHash(remote);
    }

    // 2. what changed on the server comes here
    for (const rel of new Set([...theirs.keys(), ...Object.keys(base)])) {
      const r = theirs.get(rel) ?? null, b = base[rel] ?? null;
      if (r === b) continue;
      const l = this.localHash(rel);
      if (l === undefined) continue;
      if (l === r) { base[rel] = r; if (r === null) delete base[rel]; else this.keepObject(r, this.readLocal(rel)); continue; }
      if (l !== b) { if (this.role === 'view') changes.notSent.push(rel); continue; }   // changed here too: sent next round (merged there)
      if (this.o.isBusy?.(rel)) { changes.waiting.push(rel); continue; }
      if (r === null) {
        if (this.removeLocal(rel, b)) { delete base[rel]; changes.received.push({ path: rel, deleted: true }); }
        continue;
      }
      const buf = await this.download(rel, r);
      if (!buf) { this.again = true; continue; }
      if (this.writeLocal(rel, buf, b)) { base[rel] = r; this.keepObject(r, buf); changes.received.push({ path: rel }); }
    }
    this.cursor = remote.cursor;
    this.saveState();
    this.collect();

    const inStep = !changes.waiting.length && !changes.notSent.length && !changes.errors.length && !this.again;
    try { await this.followBranch(remote, inStep); this.saveState(); }
    catch (e) { this.log(`branch: ${String(e.message ?? e).trim()}`); }
    const conflicts = [...this.status.conflicts.filter(c => now - c.at < 24 * 3600_000), ...changes.conflicts.map(c => ({ ...c, at: now }))].slice(-20);
    this.setStatus({ state: 'idle', lastSync: Date.now(), conflicts, waiting: changes.waiting, notSent: changes.notSent, message: changes.errors.length ? changes.errors.map(e => `${e.path}: ${e.error}`).join('; ') : '' });
    return changes;
  }

  async send(rels, base, changes) {
    const items = [];
    for (const rel of rels) {
      const b = base[rel] ?? null;
      const l = this.localHash(rel);
      if (l === null) { items.push({ rel, sent: null, file: { path: rel, base: b, deleted: true } }); continue; }
      const buf = this.readLocal(rel);
      if (blobHash(buf) !== l) { this.again = true; continue; }   // changing as we read: next round
      const text = isTextBuf(buf);
      const baseText = text && b ? await this.baseText(b) : null;
      items.push({ rel, sent: { hash: l, buf }, file: { path: rel, base: b, ...(baseText !== null ? { baseText } : {}), ...(text ? { text: buf.toString('utf8') } : { data: buf.toString('base64') }) } });
    }
    // in batches of about SYNC_BATCH bytes
    for (let i = 0; i < items.length;) {
      const batch = [];
      let size = 0;
      while (i < items.length && batch.length < SYNC_BATCH_FILES && (!batch.length || size + (items[i].sent?.buf.length ?? 0) * 2 < SYNC_BATCH)) { size += (items[i].sent?.buf.length ?? 0) * 2; batch.push(items[i++]); }
      const res = await this.request('push', { method: 'POST', body: JSON.stringify({ project: this.o.project, client: this.o.client ?? '', files: batch.map(x => x.file) }), timeout: 300000 });
      const byPath = new Map((res.results ?? []).map(r => [r.path, r]));
      for (const it of batch) this.settle(it, byPath.get(it.rel), base, changes);
    }
  }

  /** The server's answer for one file sent. */
  settle({ rel, sent }, r, base, changes) {
    if (!r || r.status === 'error') {
      changes.errors.push({ path: rel, error: r?.error ?? 'no answer' });
      this.failed.set(rel, Date.now() + 5 * 60_000);
      return;
    }
    this.failed.delete(rel);
    const content = typeof r.text === 'string' ? Buffer.from(r.text, 'utf8') : typeof r.data === 'string' ? Buffer.from(r.data, 'base64') : null;
    const setBase = (hash, buf) => { if (hash === null) delete base[rel]; else { base[rel] = hash; if (buf) this.keepObject(hash, buf); } };
    if (r.status !== 'conflict' || r.conflicts) changes.sent.push({ path: rel, deleted: !sent, status: r.status, conflicts: r.conflicts });
    if (!content || r.hash === (sent?.hash ?? null)) { setBase(r.hash, sent?.buf ?? null); return; }
    // the server's file differs from what was sent: merged with changes made there, or (a conflict) its own version kept
    const kept = r.status === 'conflict' && !r.conflicts;
    // a merge holds what was sent: that is the base of whatever comes next here (a kept conflict does not)
    if (!kept && sent) setBase(sent.hash, sent.buf);
    if (this.o.isBusy?.(rel)) { changes.waiting.push(rel); return; }   // the editor saves first; then it comes round again
    if (this.localHash(rel) !== (sent?.hash ?? null)) { this.again = true; return; }   // changed again meanwhile: sent next round
    if (kept && sent) changes.conflicts.push({ path: rel, copy: this.conflictCopy(rel, sent.buf), kind: 'copy' });
    else if (kept) changes.conflicts.push({ path: rel, kind: 'restored' });
    else if (r.conflicts) changes.conflicts.push({ path: rel, kind: 'tracked', count: r.conflicts });
    if (this.writeLocal(rel, content, sent?.hash ?? null)) setBase(r.hash, content);
    else this.again = true;
  }

  /* ---- watching */

  /**
   * Keep syncing until stop(): after local changes (poke(), or a file watcher when `watchFiles`), as
   * soon as the server reports a change (long poll), and every minute regardless.
   */
  async watch({ watchFiles = true } = {}) {
    this.stopped = false;
    let backoff = 2000;
    let timer = null, wake = null;
    // paused (another process holds the clone, another branch, git busy): look again in a while, or when poked
    const nap = (ms) => new Promise(resolve => { if (this.stopped) { resolve(); return; } const t = setTimeout(resolve, ms); wake = () => { clearTimeout(t); resolve(); }; });
    const kick = () => { clearTimeout(timer); timer = setTimeout(() => { wake?.(); void this.sync().catch(() => undefined); }, 800); };
    this.poke = kick;
    if (watchFiles) {
      try {
        this.watcher = fs.watch(this.dir, { recursive: true }, (_e, name) => {
          const n = String(name ?? '');
          if (n === '.git' || n.startsWith('.git' + path.sep) || n.startsWith('.git/') || n.endsWith('.overlyx-tmp')) return;
          kick();
        });
      } catch (e) { this.log(`not watching the files (${e.message}); syncing every minute`); }
    }
    const tick = setInterval(kick, 60_000);
    this.stopTimers = () => { clearInterval(tick); clearTimeout(timer); this.watcher?.close(); wake?.(); };
    while (!this.stopped) {
      try {
        await this.sync();
        if (this.status.state === 'paused') { await nap(30_000); continue; }
        backoff = 2000;
        // until the server reports a change (it holds the request ~25 s)
        while (!this.stopped) {
          this.abort = new AbortController();
          const signal = AbortSignal.any ? AbortSignal.any([this.abort.signal, AbortSignal.timeout(90_000)]) : this.abort.signal;
          const r = await this.request(`wait?${this.q({ cursor: this.cursor ?? '' })}`, { signal });
          if (r?.cursor !== this.cursor) break;
        }
      } catch (e) {
        if (this.stopped) break;
        const status = e.status ?? 0;
        if (status === 401 || status === 403 || status === 404) { this.setStatus({ state: status === 401 ? 'signin' : 'error', message: e.message }); await nap(60_000); continue; }
        this.setStatus({ state: status === 0 ? 'offline' : 'error', message: e.message });
        this.log(e.message);
        await nap(backoff);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  stop() {
    this.stopped = true;
    this.stopTimers?.();
    this.wake?.();
    this.abort?.abort();
    this.unlock();
  }
}

/** Whether a sync (VS Code, `overlyx sync --watch`) keeps the clone at `dir` in step right now. */
async function syncRunning(dir) {
  try {
    const gitDir = (await gitOut(dir, ['rev-parse', '--absolute-git-dir'], { timeout: 5000 })).trim();
    const lock = JSON.parse(fs.readFileSync(path.join(gitDir, 'overlyx-sync', 'lock'), 'utf8'));
    if (Date.now() - lock.at > 120000) return false;
    try { process.kill(lock.pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
  } catch { return false; }
}

/** The engine for the clone at `dir`, signed in — or why there is none. */
export async function syncEngineFor(dir, opts = {}) {
  const target = await syncTarget(dir);
  if (!target) return { error: 'not a clone of an OverLyX project (no remote …/git/<owner>/<project>.git)' };
  const auth = opts.auth ?? await syncCredentials(target.host, dir);
  if (!auth) return { error: `not signed in to ${target.host}: run overlyx auth login${target.host === DEFAULT_HOST ? '' : ` --host ${target.host}`}`, target, signin: true };
  return { engine: new SyncEngine({ dir, ...target, auth, client: opts.client ?? os.hostname(), ...opts }), target };
}

/**
 * Sign in through the browser and keep the credential as `overlyx auth login` does (the VS Code
 * extension's "Sign in" for its sync; git's credential helper is left as it is). `ui`: see browserLogin.
 */
export async function signInWithBrowser(host, ui) {
  host = normalizeHost(host);
  const { username, token } = await browserLogin(host, {}, ui);
  const result = await api({ host, username, token }, '/git/api/user');
  const config = readConfig();
  config.hosts[host] = { username: result.user.username, token };
  if (!config.defaultHost) config.defaultHost = host;
  writeConfig(config);
  return { username: result.user.username, token };
}

/** The servers this computer is signed in to (the CLI's sign-ins, shared with the VS Code extension). */
export function signedInHosts() {
  return Object.entries(readConfig().hosts ?? {}).filter(([, v]) => v?.username && v?.token).map(([host, v]) => ({ host, username: v.username }));
}

/** Forget the sign-in for `host` (the CLI's and the VS Code extension's: they share it). Git's configuration is left alone. */
export function signOutOf(host) {
  const config = readConfig();
  host = normalizeHost(host);
  if (!config.hosts[host]) return false;
  delete config.hosts[host];
  if (config.defaultHost === host) config.defaultHost = Object.keys(config.hosts)[0] ?? null;
  writeConfig(config);
  return true;
}

/** The projects the sign-in reaches on `host`: { name, title, role }. */
export async function remoteProjects(host, auth) {
  return (await api({ host, ...auth }, '/git/api/projects')).projects;
}

/**
 * `git clone` of the project into `parent`/`name` — the credential travels in an environment header,
 * never in .git/config or on the command line; the remote URL names the account, as `repo create` does.
 */
export async function cloneProject(host, auth, project, parent, name) {
  const url = new URL(gitUrl({ host }, project));
  url.username = auth.username;
  const dir = path.join(parent, name ?? project.split('/').pop());
  if (fs.existsSync(dir)) fail(`${dir} exists already`);
  await git(parent, ['clone', '-q', url.toString(), dir], auth);
  return dir;
}

/** The top level of the git repository `dir` is in, or null. */
export async function enclosingRepo(dir) {
  try { return (await gitOut(dir, ['rev-parse', '--show-toplevel'], { timeout: 10000 })).trim() || null; } catch { return null; }
}

/**
 * Clone `project` into `parent` as a submodule of the git repository `parent` is in (a paper next to
 * its code): the folder is named after the project unless `name` says otherwise, and .gitmodules gets
 * the project's address without an account in it (whoever clones the code's repository signs in as
 * themselves). `git submodule add` stages .gitmodules and the submodule; committing is the user's.
 */
export async function addProjectSubmodule(host, auth, project, parent, name) {
  const top = await enclosingRepo(parent);
  if (!top) fail(`${parent} is not in a git repository`);
  const dir = path.join(parent, name ?? project.split('/').pop());
  if (fs.existsSync(dir)) fail(`${dir} exists already`);
  await git(top, ['submodule', '--quiet', 'add', '--', gitUrl({ host }, project), path.relative(top, dir).split(path.sep).join('/')], auth);
  return dir;
}

/** A clone inside a repository that is not to track it: `/<its path>/` appended to the repository's
 *  .gitignore. False when the repository ignores it already. */
export async function ignoreInRepo(top, dir) {
  const rel = path.relative(top, dir).split(path.sep).join('/');
  if (await gitOut(top, ['check-ignore', '-q', '--', rel]).then(() => true, () => false)) return false;
  const file = path.join(top, '.gitignore');
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  fs.writeFileSync(file, `${before}${before && !before.endsWith('\n') ? '\n' : ''}/${rel}/\n`);
  return true;
}

/** The servers this computer is signed in to with the CLI, and overlyx.app: a clone of a project on one of them is synced. */
export function knownSyncHosts() {
  const hosts = new Set([DEFAULT_HOST]);
  try { for (const h of Object.keys(readConfig().hosts ?? {})) hosts.add(h); } catch { /* no CLI config */ }
  return [...hosts];
}

/** What a round changed, one line per file (the CLI's output, the VS Code extension's log). */
export function describeChanges(c) {
  const lines = [];
  for (const s of c.sent) lines.push(`↑ ${s.path}${s.deleted ? ' (removed)' : s.status === 'merged' ? ' (merged with changes on the server)' : s.status === 'conflict' ? ` (${s.conflicts} paragraph${s.conflicts > 1 ? 's' : ''} changed on both sides: yours are tracked changes there)` : ''}`);
  for (const r of c.received) lines.push(`↓ ${r.path}${r.deleted ? ' (removed)' : ''}`);
  for (const k of c.conflicts) {
    if (k.kind === 'copy') lines.push(`! ${k.path}: changed on both sides — the server's version is here now, yours is "${k.copy}"`);
    if (k.kind === 'restored') lines.push(`! ${k.path}: changed on the server, so it was not removed — it is back`);
  }
  for (const w of c.waiting) lines.push(`… ${w}: unsaved in an editor, waits`);
  for (const n of new Set(c.notSent)) lines.push(`· ${n}: changed here, not sent (you can only view this project)`);
  for (const e of c.errors) lines.push(`✗ ${e.path}: ${e.error}`);
  return lines;
}

async function syncCommand(args, flags) {
  const dir = path.resolve(args[0] ?? '.');
  const creds = flags.token || flags.username ? credentials(flags, false) : null;
  const { engine, error, target } = await syncEngineFor(dir, {
    ...(creds?.token && creds?.username ? { auth: { username: creds.username, token: creds.token } } : {}),
    log: (line) => process.stderr.write(`overlyx sync: ${line}\n`),
  });
  if (!engine) fail(error);
  const stamp = () => new Date().toLocaleTimeString();
  if (!flags.watch) {
    const c = await engine.sync();
    engine.unlock();
    if (engine.status.state === 'paused') fail(engine.status.message);
    const lines = describeChanges(c);
    process.stdout.write(lines.length ? lines.join('\n') + '\n' : `In step with ${target.host} (${target.project})\n`);
    if (c.errors.length) process.exitCode = 1;
    return;
  }
  process.stdout.write(`Keeping ${dir} in step with ${target.project} on ${target.host} — Ctrl+C stops\n`);
  let last = '';
  engine.o.onStatus = (s) => {
    const line = s.state === 'idle' ? '' : `${s.state}${s.message ? ': ' + s.message : ''}`;
    if (line && line !== last) process.stderr.write(`[${stamp()}] ${line}\n`);
    last = line;
  };
  const round = engine.round.bind(engine);
  engine.round = async () => {
    const c = await round();
    for (const l of describeChanges(c)) process.stdout.write(`[${stamp()}] ${l}\n`);
    return c;
  };
  const stop = () => { engine.stop(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await engine.watch();
}

async function main() {
  const { positional, flags } = parse(process.argv.slice(2));
  if (flags.version || positional[0] === 'version') { process.stdout.write(VERSION + '\n'); return; }
  if (flags.help || !positional.length || positional[0] === 'help') { process.stdout.write(HELP); return; }
  const [group, action, ...args] = positional;
  if (group === 'auth') await authCommand(action, action === 'git-credential' ? { ...flags, _op: args[0] } : flags);
  else if (group === 'repo' || group === 'project') await repoCommand(action, args, flags);
  else if (group === 'build') await buildCommand(positional.slice(1), flags);
  else if (group === 'restore') await restoreCommand(positional.slice(1), flags);
  else if (group === 'sync') await syncCommand(positional.slice(1), flags);
  else if (group === 'mcp') await mcpCommand(action, flags);
  else if (group === 'update') await updateCommand(flags);
  else fail(`unknown command: ${group}\n\n${HELP}`);
}

// the VS Code extension bundles this file for its sync (esbuild defines OVERLYX_CLI_LIBRARY): no command line there
if (process.env.OVERLYX_CLI_LIBRARY !== '1') {
  main().catch(error => {
    process.stderr.write(`overlyx: ${error.message ?? error}\n`);
    process.exitCode = error.exitCode ?? 1;
  });
}
