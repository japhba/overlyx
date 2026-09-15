#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const VERSION = '0.1.0';
const DEFAULT_HOST = 'https://overlyx.app';

const HELP = `OverLyX CLI ${VERSION}

Usage:
  overlyx auth login [--host URL] --username NAME [--with-token | --token TOKEN]
  overlyx auth status [--host URL]
  overlyx auth logout [--host URL]
  overlyx repo list [--host URL]
  overlyx repo create [NAME] [--source PATH] [--push] [--remote NAME]
  overlyx repo push [PATH] [--name NAME] [--remote NAME]

Examples:
  overlyx auth login --host https://overlyx.app --username ada --with-token
  overlyx repo create my-paper --source . --push
  overlyx repo push . --name my-paper

Create your account access token in OverLyX under File > Git repository. The token is stored
with mode 0600. Git remotes contain your username, but never the token.
`;

function fail(message, code = 1) {
  const e = new Error(message);
  e.exitCode = code;
  throw e;
}

function parse(argv) {
  const positional = [];
  const flags = {};
  const booleans = new Set(['push', 'with-token', 'help', 'version']);
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
  if (required && (!username || !token)) fail(`not logged in to ${host}; run: overlyx auth login --host ${host} --username NAME --with-token`);
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

async function existingProject(creds, name) {
  const result = await api(creds, '/git/api/projects');
  return result.projects.find(project => project.name === name && (project.role === 'owner' || project.role === 'edit')) ?? null;
}

async function createRemote(creds, name, title, allowExisting) {
  try {
    return await api(creds, '/git/api/projects', { method: 'POST', body: JSON.stringify({ name, ...(title ? { title } : {}) }) });
  } catch (e) {
    if (!allowExisting || !/already exists/i.test(e.message)) throw e;
    const found = await existingProject(creds, name);
    if (!found) fail(`a project named "${name}" exists, but this account cannot push to it`);
    return { project: found, url: `${creds.host}/git/${encodeURIComponent(name)}.git`, username: creds.username, existing: true };
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

async function authCommand(action, flags) {
  if (action === 'login') {
    const config = readConfig();
    const host = normalizeHost(flags.host ?? process.env.OVERLYX_HOST ?? config.defaultHost ?? DEFAULT_HOST);
    const username = String(flags.username ?? process.env.OVERLYX_USERNAME ?? '').trim();
    if (!username) fail('--username is required');
    const token = await tokenFromInput(flags);
    if (!token) fail('no token received');
    const creds = { host, username, token };
    const result = await api(creds, '/git/api/user');
    config.hosts[host] = { username: result.user.username, token };
    config.defaultHost = host;
    writeConfig(config);
    process.stdout.write(`Logged in to ${host} as ${result.user.username}\n`);
    return;
  }

  const creds = credentials(flags, action !== 'logout');
  if (action === 'status') {
    const result = await api(creds, '/git/api/user');
    process.stdout.write(`${creds.host}: logged in as ${result.user.username}\n`);
    return;
  }
  if (action === 'logout') {
    if (!creds.config.hosts[creds.host]) fail(`not logged in to ${creds.host}`);
    delete creds.config.hosts[creds.host];
    if (creds.config.defaultHost === creds.host) creds.config.defaultHost = Object.keys(creds.config.hosts)[0] ?? null;
    writeConfig(creds.config);
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
  const name = String(flags.name ?? (action === 'create' ? args[0] : '') ?? inferred).trim() || inferred;
  if (!name) fail('project name is required');
  if (!/^[A-Za-z0-9._ -]+$/.test(name)) fail('invalid project name (use letters, numbers, spaces, dot, dash or underscore)');
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
  process.stdout.write(`${remote.existing ? 'Using' : 'Created'} project "${name}" on ${creds.host}\n`);
  if (source) {
    const dir = path.resolve(source);
    const remoteName = String(flags.remote ?? 'overlyx');
    if (!/^[A-Za-z0-9._-]+$/.test(remoteName)) fail('invalid Git remote name');
    const remoteUrl = remote.url ?? `${creds.host}/git/${encodeURIComponent(name)}.git`;
    if (flags.push || action === 'push') await pushSource(creds, prepared ?? dir, name, remoteName, { ...remote, url: remoteUrl });
    else {
      const url = new URL(remoteUrl); url.username = creds.username;
      await setRemote(dir, remoteName, url.toString());
      process.stdout.write(`Added remote ${remoteName} (${url.toString()})\n`);
    }
  } else process.stdout.write(`Clone: ${remote.url}\n`);
}

async function main() {
  const { positional, flags } = parse(process.argv.slice(2));
  if (flags.version || positional[0] === 'version') { process.stdout.write(VERSION + '\n'); return; }
  if (flags.help || !positional.length || positional[0] === 'help') { process.stdout.write(HELP); return; }
  const [group, action, ...args] = positional;
  if (group === 'auth') await authCommand(action, flags);
  else if (group === 'repo' || group === 'project') await repoCommand(action, args, flags);
  else fail(`unknown command: ${group}\n\n${HELP}`);
}

main().catch(error => {
  process.stderr.write(`overlyx: ${error.message ?? error}\n`);
  process.exitCode = error.exitCode ?? 1;
});
