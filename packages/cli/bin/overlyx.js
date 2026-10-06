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
const VERSION = '0.6.3';
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
  overlyx build OWNER/PROJECT/FILE.tex [--pdf FILE] [--log] [--wait SECONDS]
  overlyx restore OWNER/PROJECT COMMIT
  overlyx mcp install [--client claude,codex] [--yes]   let local AI agents use OverLyX (Claude Code: in every directory, no prompts)
  overlyx mcp status | uninstall
  overlyx mcp serve                                      (what the agents run: the MCP bridge)
  overlyx update                                         this CLI from the server

Examples:
  overlyx auth login                      # opens the browser: Authorize, and the CLI is signed in
  overlyx repo create my-paper --source . --push
  overlyx repo push . --name my-paper
  overlyx build ada/my-paper/main.tex     # compile on the server: errors, exit code 1 if it fails
  overlyx restore ada/my-paper 3f2a91c    # the whole project as it was at that commit (a new commit)
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
  const booleans = new Set(['push', 'with-token', 'help', 'version', 'log', 'yes', 'web', 'no-browser', 'no-git', 'ask-each-time']);
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
async function browserLogin(host, flags) {
  const manual = !!flags['no-browser'] || !hasLocalBrowser();
  if (manual && !process.stdin.isTTY) fail('no browser on this computer and no terminal to paste a code into: run overlyx auth login in a terminal, or pass a token (--with-token)');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('base64url');
  let finish;
  const got = new Promise(resolve => { finish = resolve; });
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/callback' && u.searchParams.get('state') === state && u.searchParams.get('code')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('<!doctype html><meta charset="utf-8"><title>OverLyX CLI</title><body style="font:15px/1.5 system-ui;max-width:28em;margin:12vh auto;padding:0 1em"><h2>The OverLyX CLI is signed in</h2><p>You can close this tab and go back to the terminal.</p></body>');
      finish(u.searchParams.get('code'));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  // in a clone of one of the projects: the page suggests it, should the account narrow sign-ins (fine-grained access)
  const clone = await cloneOf(host);
  const url = `${host}/cli/login?` + new URLSearchParams({ port: String(port), state, challenge, client: os.hostname(), ...(manual ? { mode: 'manual' } : {}), ...(clone ? { project: clone.project } : {}) }).toString();
  let rl = null;
  if (manual) {
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
      if (m && `${u.protocol}//${u.host}` === host.replace(/\/$/, '')) return { project: `${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`, remote: line.split(/\s+/)[0] };
    } catch { /* an ssh or local remote */ }
  }
  return null;
}

function withCloneInstructions(msg, clone) {
  if (!msg || !msg.result) return msg;
  const note = `This directory is a git clone of the OverLyX project "${clone.project}" (git remote "${clone.remote}"). Edit its documents here, in these files: `
    + `with the tools of the "overlyx-local" server where you have them (edit_document, write_document, add_comment — your edits become tracked changes the user reviews in the OverLyX editor), otherwise directly. `
    + `Commit and push with git when the user asks (pull first). The tools below (project "${clone.project}") work on the copy on the OverLyX server, which changes only with a push — use them only when the user asks about that copy.`;
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

async function main() {
  const { positional, flags } = parse(process.argv.slice(2));
  if (flags.version || positional[0] === 'version') { process.stdout.write(VERSION + '\n'); return; }
  if (flags.help || !positional.length || positional[0] === 'help') { process.stdout.write(HELP); return; }
  const [group, action, ...args] = positional;
  if (group === 'auth') await authCommand(action, action === 'git-credential' ? { ...flags, _op: args[0] } : flags);
  else if (group === 'repo' || group === 'project') await repoCommand(action, args, flags);
  else if (group === 'build') await buildCommand(positional.slice(1), flags);
  else if (group === 'restore') await restoreCommand(positional.slice(1), flags);
  else if (group === 'mcp') await mcpCommand(action, flags);
  else if (group === 'update') await updateCommand(flags);
  else fail(`unknown command: ${group}\n\n${HELP}`);
}

main().catch(error => {
  process.stderr.write(`overlyx: ${error.message ?? error}\n`);
  process.exitCode = error.exitCode ?? 1;
});
