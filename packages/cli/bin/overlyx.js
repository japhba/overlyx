#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const VERSION = '0.2.0';
const DEFAULT_HOST = 'https://overlyx.app';

const HELP = `OverLyX CLI ${VERSION}

Usage:
  overlyx auth login [--host URL] --username NAME [--with-token | --token TOKEN]
  overlyx auth status [--host URL]
  overlyx auth logout [--host URL]
  overlyx repo list [--host URL]
  overlyx repo create [NAME] [--source PATH] [--push] [--remote NAME]
  overlyx repo push [PATH] [--name NAME] [--remote NAME]
  overlyx sync [DIR] [--watch] [--interval SECONDS] [--only KEYS]
  overlyx status [DIR]
  overlyx build [DOCUMENT] [--pdf FILE] [--log] [--wait SECONDS] [--no-sync]
  overlyx restore [PROJECT] COMMIT

Examples:
  overlyx auth login --host https://overlyx.app --username ada --with-token
  overlyx repo create my-paper --source . --push
  overlyx repo push . --name my-paper

  # every project you can access as ordinary files (a git clone each), kept in sync both ways —
  # for you, your editor, or a local agent (Claude Code, Codex, …; AGENTS.md there explains the rules)
  overlyx sync ~/OverLyX --watch
  overlyx build ada/my-paper/main.tex     # compile on the server: errors, exit code 1 if it fails
  overlyx restore ada/my-paper 3f2a91c    # the whole project as it was at that commit (a new commit)

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
  const booleans = new Set(['push', 'with-token', 'help', 'version', 'watch', 'log', 'no-sync', 'quiet']);
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
    config.hosts[host] = { ...config.hosts[host], username: result.user.username, token };
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

/**
 * `overlyx auth git-credential get` — git's credential-helper protocol (git-credential(1)), set up
 * in every repository `overlyx sync` clones, so plain `git pull` / `git push` there authenticate
 * with the saved login while the token stays out of .git/config.
 */
async function gitCredential(op) {
  if (op !== 'get') return;   // store / erase: the login is managed by `overlyx auth`
  const input = fs.readFileSync(0, 'utf8');
  const fields = Object.fromEntries(input.split('\n').filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  if (!fields.protocol || !fields.host) return;
  const config = readConfig();
  for (const [host, saved] of Object.entries(config.hosts)) {
    const url = new URL(host);
    if (url.protocol !== fields.protocol + ':' || url.host !== fields.host) continue;
    if (fields.username && fields.username !== saved.username) continue;
    process.stdout.write(`username=${saved.username}\npassword=${saved.token}\n`);
    return;
  }
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

/* ------------------------------------------------------------------ workspace
 *
 * `overlyx sync` keeps a folder with every project the account can access, one git clone each
 * at <workspace>/<owner>/<name>, in step with the server both ways: what changed locally is
 * committed, rebased onto what was edited in OverLyX meanwhile and pushed; what was edited in
 * OverLyX is pulled. That gives an editor, a script or a local agent (Claude Code, Codex, …)
 * ordinary files to work on — with the account's roles and nothing more (no shell on the server),
 * and with the history as the way back (`git revert`, `overlyx restore`). A folder created under
 * <workspace>/<username>/ becomes a new project.
 */

const WS_DIR = '.overlyx';
const AGENTS_MARK = '<!-- overlyx: generated by `overlyx sync`; edit freely — delete this line to keep your version -->';
const SETTLE_MS = 10_000;   // edits in the editor are fetched once they have rested this long

function defaultWorkspace() {
  return path.resolve(process.env.OVERLYX_WORKSPACE ?? path.join(os.homedir(), 'OverLyX'));
}

/** The workspace `start` is in (a folder with .overlyx/workspace.json), or null. */
function findWorkspace(start) {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, WS_DIR, 'workspace.json'))) return dir;
    if (path.dirname(dir) === dir) return null;
  }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** git in `dir` that reports instead of throwing: { ok, out, err }. */
async function tryGit(dir, args, auth) {
  try { const r = await git(dir, args, auth); return { ok: true, out: r.stdout, err: r.stderr }; }
  catch (e) { return { ok: false, out: '', err: e.message }; }
}

const stamp = () => new Date().toTimeString().slice(0, 8);
function say(ws, line) { if (!ws.quiet) process.stdout.write(`${ws.watch ? stamp() + ' ' : ''}${line}\n`); }

const canPush = role => role === 'owner' || role === 'edit';
const projectPath = (ws, key) => path.join(ws.root, ...key.split('/'));

/** The CLI itself as git's credential helper (an absolute path: git runs it through the shell). */
function credentialHelper() {
  const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
  return `!${q(process.execPath)} ${q(fileURLToPath(import.meta.url))} auth git-credential`;
}

async function openWorkspace(dirArg, flags) {
  const creds = credentials(flags);
  const root = path.resolve(dirArg ?? findWorkspace(process.cwd()) ?? defaultWorkspace());
  const file = path.join(root, WS_DIR, 'workspace.json');
  const saved = readJson(file, null);
  if (saved && (saved.host !== creds.host || saved.username !== creds.username)) {
    fail(`${root} is the workspace of ${saved.username} on ${saved.host}; you are logged in as ${creds.username} on ${creds.host}`);
  }
  if (!saved && fs.existsSync(root)) {
    // a folder of one's own is never taken over: only an empty one, or one of owner/project clones
    const isClone = d => fs.existsSync(path.join(d, '.git'));
    const stray = fs.readdirSync(root).filter(n => !n.startsWith('.')).filter(n => {
      const d = path.join(root, n);
      return !fs.statSync(d).isDirectory() || !fs.readdirSync(d).filter(m => !m.startsWith('.')).every(m => isClone(path.join(d, m)));
    });
    if (stray.length) fail(`${root} is not empty and not an OverLyX workspace (it has ${stray.slice(0, 3).join(', ')}); choose an empty or new folder`);
  }
  let only = saved?.only ?? null;
  if (flags.only !== undefined) only = flags.only === 'all' ? null : String(flags.only).split(',').map(s => s.trim()).filter(Boolean);
  const user = (await api(creds, '/git/api/user')).user;
  // remembered, so `overlyx build <owner>/<project>/…` from elsewhere syncs the right folder first
  if (creds.config.hosts[creds.host] && creds.config.hosts[creds.host].workspace !== root) {
    creds.config.hosts[creds.host].workspace = root;
    writeConfig(creds.config);
  }
  fs.mkdirSync(path.join(root, WS_DIR), { recursive: true });
  writeJson(file, { host: creds.host, username: creds.username, ...(only ? { only } : {}), version: 1 });
  const ws = { root, creds, user, only, quiet: !!flags.quiet, watch: false, state: readJson(path.join(root, WS_DIR, 'state.json'), { projects: {} }) };
  writeAgentNotes(ws);
  return ws;
}

function saveState(ws) { writeJson(path.join(ws.root, WS_DIR, 'state.json'), ws.state); }

function selected(ws, key) {
  if (!ws.only) return true;
  return ws.only.some(p => (p.endsWith('*') ? key.startsWith(p.slice(0, -1)) : key === p || key.startsWith(p + '/')));
}

/**
 * AGENTS.md (Codex and most agents) and CLAUDE.md (Claude Code, which imports it) at the top of
 * the workspace: how to work on the projects so that collaborators, the build and the history stay
 * sound. Rewritten while it still carries the generated mark; a version of one's own is kept.
 */
function writeAgentNotes(ws) {
  const host = ws.creds.host, me = ws.creds.username;
  const text = `${AGENTS_MARK}
# OverLyX workspace

This folder holds the OverLyX projects of **${me}** on ${host}: \`<owner>/<project>/\`, each a git
clone of the live project. People may be editing the same projects in the browser right now, so
work in small, self-contained steps and keep every document compiling.

## How changes travel
- \`overlyx sync\` (or \`overlyx sync --watch\`, which may already be running) commits what changed
  here, rebases it onto what was edited in OverLyX meanwhile, and pushes it: open documents in the
  browser take the change over within seconds. Run \`overlyx sync\` after finishing a change and
  before reading a file you have not looked at for a while.
- Commit each logical change yourself with a message that says what and why
  (\`git -C <owner>/<project> commit -am "…"\`); sync commits whatever is left with a generic message.
- Plain \`git pull\` / \`git push\` also work in every project (the CLI is git's credential helper).
- Projects you can only view are pulled but never pushed; local changes there stay local.
- A folder you create in \`${me}/\` becomes a new project of yours at the next sync.

## Documents
- Documents are LaTeX \`.tex\` files; OverLyX shows them as LyX-style documents. Edit them as plain
  LaTeX. When a document is open in OverLyX, it may rewrite your change into its own canonical form
  (spacing, line breaks, how an environment is written) — sync pulls that back; re-read before the
  next edit.
- Leave the block between \`%% OverLyX ----\` and \`%% end OverLyX ----\` alone: OverLyX regenerates
  it on every save. Put preamble additions above it.
- Do not write tracked-change markup (\`\\lyxadded\`, \`\\lyxdeleted\`) yourself; if a file already has
  some (a collaborator's tracked changes), keep it intact.
- Do not commit build products; \`.gitignore\` covers them.

## Check the build
\`overlyx build <owner>/<project>/<file>.tex\` syncs the project, compiles it on the server exactly as
the PDF button in OverLyX does, prints the errors (file:line) and exits with 1 if it fails;
\`--pdf out.pdf\` downloads the result, \`--log\` shows the log. Build after every change to a
document, and never leave one that does not compile — fix it, or step back.

## Step back
Every sync is a commit, so nothing is lost:
- \`git log --oneline\` in the project shows the history (OverLyX's own commits name who edited);
- \`git revert <commit>\` takes one change back; then \`overlyx sync\`;
- \`overlyx restore <owner>/<project> <commit>\` puts the whole project back to how it was at that
  commit (as a new commit, so it can be undone the same way) and pulls it here.
Anyone who can edit the project can do the same in OverLyX: *File ▸ Git repository… ▸ History ▸ Restore*.
`;
  const claude = `${AGENTS_MARK}
@AGENTS.md
`;
  for (const [name, body] of [['AGENTS.md', text], ['CLAUDE.md', claude]]) {
    const file = path.join(ws.root, name);
    let current = null;
    try { current = fs.readFileSync(file, 'utf8'); } catch { /* not there yet */ }
    if (current !== null && !current.startsWith(AGENTS_MARK)) continue;
    if (current !== body) fs.writeFileSync(file, body);
  }
}

/** The upstream ref of the checked-out branch (null: unborn, or nothing fetched yet). */
async function upstream(dir) {
  const branch = (await tryGit(dir, ['symbolic-ref', '--short', 'HEAD'])).out.trim() || 'main';
  const ref = `refs/remotes/origin/${branch}`;
  return { branch, ref: (await tryGit(dir, ['rev-parse', '--verify', '-q', ref])).ok ? ref : null };
}
async function count(dir, range) {
  const r = await tryGit(dir, ['rev-list', '--count', range]);
  return r.ok ? Number(r.out.trim()) || 0 : 0;
}
const headOf = async (dir, ref = 'HEAD') => (await tryGit(dir, ['rev-parse', '--verify', '-q', ref])).out.trim() || null;

async function cloneProject(ws, p, dir) {
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) {
    say(ws, `! ${p.name}: ${dir} exists but is not a clone of the project — skipped`);
    return 'skipped';
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const url = new URL(gitUrl(ws.creds, p.name));
  url.username = ws.creds.username;
  const r = await tryGit(path.dirname(dir), ['clone', '--quiet', url.toString(), path.basename(dir)], ws.creds);
  if (!r.ok) { say(ws, `✗ ${p.name}: clone failed: ${r.err.split('\n')[0]}`); return 'error'; }
  // the account's identity for commits made here, and the CLI as the credential helper
  await git(dir, ['config', 'user.name', ws.user.name || ws.creds.username]);
  await git(dir, ['config', 'user.email', ws.user.email || `${ws.creds.username}@${new URL(ws.creds.host).host}`]);
  await git(dir, ['config', 'credential.helper', '']);
  await git(dir, ['config', '--add', 'credential.helper', credentialHelper()]);
  say(ws, `↓ ${p.name}: cloned`);
  return 'cloned';
}

/** Commit what changed in the working tree (a message naming the files). Returns the files. */
async function commitLocal(ws, dir) {
  const status = (await git(dir, ['status', '--porcelain', '-z', '--untracked-files=all'])).stdout.split('\0').filter(Boolean);
  if (!status.length) return [];
  const files = status.map(l => l.slice(3));
  await git(dir, ['add', '-A']);
  const names = files.slice(0, 3).map(f => path.basename(f)).join(', ') + (files.length > 3 ? ` and ${files.length - 3} more` : '');
  await git(dir, ['commit', '-q', '--no-verify', '-m', `Edit ${names}\n\nCommitted by overlyx sync on ${os.hostname()}\n\nFiles:\n${files.map(f => '  ' + f).join('\n')}\n`]);
  return files;
}

/**
 * Bring one project in step. `remoteMoved`: the server's state differs from the last sync (or is
 * unknown). Never loses work: a rebase that conflicts is undone and reported, the local commits stay.
 */
async function syncProject(ws, p, remoteMoved) {
  const dir = projectPath(ws, p.name);
  const st = ws.state.projects[p.name] ?? {};
  if (!fs.existsSync(path.join(dir, '.git'))) {
    const r = await cloneProject(ws, p, dir);
    if (r === 'cloned') ws.state.projects[p.name] = { head: p.head, changed: p.changed ?? null };
    return r;
  }
  const push = canPush(p.role);
  let committed = [];
  if (push) committed = await commitLocal(ws, dir);
  else if ((await git(dir, ['status', '--porcelain'])).stdout.trim() && !st.warnedReadOnly) {
    say(ws, `! ${p.name}: you can only view this project — local changes stay here`);
    st.warnedReadOnly = true;
  }
  let { branch, ref } = await upstream(dir);
  const localHead = await headOf(dir);
  const aheadBefore = ref ? await count(dir, `${ref}..HEAD`) : localHead ? 1 : 0;
  if (st.conflict && st.conflict.local === localHead && st.conflict.remote === p.head) return 'conflict';
  if (!remoteMoved && !committed.length && !(push && aheadBefore)) return 'unchanged';

  for (let attempt = 0; attempt < 4; attempt++) {
    const f = await tryGit(dir, ['fetch', '--quiet', 'origin'], ws.creds);
    if (!f.ok) { say(ws, `✗ ${p.name}: fetch failed: ${f.err.split('\n')[0]}`); return 'error'; }
    ({ ref } = await upstream(dir));
    const behind = ref ? await count(dir, `HEAD..${ref}`) : 0;
    const ahead = ref ? await count(dir, `${ref}..HEAD`) : (await headOf(dir)) ? 1 : 0;
    if (behind) {
      const before = await headOf(dir);
      const r = ahead ? await tryGit(dir, ['rebase', '--quiet', ref]) : await tryGit(dir, ['merge', '--quiet', '--ff-only', ref]);
      if (!r.ok) {
        await tryGit(dir, ['rebase', '--abort']);
        const clash = (await tryGit(dir, ['diff', '--name-only', `HEAD...${ref}`])).out.split('\n').filter(Boolean);
        ws.state.projects[p.name] = { ...st, conflict: { local: await headOf(dir), remote: p.head } };
        say(ws, `✗ ${p.name}: your changes and changes made in OverLyX overlap (${clash.slice(0, 3).join(', ') || 'see git status'}). Nothing was lost; resolve with: cd ${dir} && git pull --rebase (fix, git add, git rebase --continue), then overlyx sync`);
        return 'conflict';
      }
      const files = (await tryGit(dir, ['diff', '--name-only', before ?? ref, ref])).out.split('\n').filter(Boolean);
      say(ws, `↓ ${p.name}: ${behind} change${behind === 1 ? '' : 's'} from OverLyX (${files.slice(0, 3).join(', ')}${files.length > 3 ? ', …' : ''})`);
    }
    if (!ahead || !push) break;
    const r = await tryGit(dir, ['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`], ws.creds);
    if (r.ok) {
      say(ws, `↑ ${p.name}: ${ahead} commit${ahead === 1 ? '' : 's'} pushed${committed.length ? ` (${committed.slice(0, 3).join(', ')}${committed.length > 3 ? ', …' : ''})` : ''}`);
      await tryGit(dir, ['fetch', '--quiet', 'origin'], ws.creds);
      // OverLyX may rewrite what arrived into its canonical form (an open document): look again soon
      ws.recheck?.(p.name);
      break;
    }
    if (!/rejected|non-fast-forward|fetch first|stale info/i.test(r.err) || attempt === 3) {
      say(ws, `✗ ${p.name}: push failed: ${r.err.split('\n').filter(Boolean).slice(-1)[0] ?? r.err}`);
      return 'error';
    }
    // somebody (OverLyX's own commit of an edit) got there first: fetch, rebase, again
  }
  ({ ref } = await upstream(dir));
  ws.state.projects[p.name] = { head: ref ? await headOf(dir, ref) : p.head, changed: null };
  return 'synced';
}

/** A folder made in <workspace>/<username>/ that is no clone yet: create the project and push it. */
async function adoptNewFolders(ws, known) {
  const mine = path.join(ws.root, ws.creds.username);
  if (!fs.existsSync(mine)) return;
  for (const e of fs.readdirSync(mine, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const key = `${ws.creds.username}/${e.name}`;
    const dir = path.join(mine, e.name);
    if (known.has(key) || fs.existsSync(path.join(dir, '.git')) || !selected(ws, key)) continue;
    if (!fs.readdirSync(dir).some(n => !n.startsWith('.'))) continue;
    if (!/^[A-Za-z0-9._ -]+$/.test(e.name)) { say(ws, `! ${key}: not a valid project name — skipped`); continue; }
    try {
      const prepared = await prepareSource(dir, e.name, ws.creds);
      const remote = await createRemote(ws.creds, e.name, null, true);
      const url = new URL(remote.url ?? gitUrl(ws.creds, key)); url.username = ws.creds.username;
      await setRemote(prepared, 'origin', url.toString());
      await git(prepared, ['push', '--quiet', '-u', 'origin', 'HEAD:main'], ws.creds);
      await git(prepared, ['config', 'credential.helper', '']);
      await git(prepared, ['config', '--add', 'credential.helper', credentialHelper()]);
      say(ws, `+ ${key}: new project created from the folder and pushed`);
    } catch (err) { say(ws, `✗ ${key}: could not create the project: ${err.message}`); }
  }
}

function remoteMoved(ws, p) {
  const st = ws.state.projects[p.name];
  if (!st) return true;
  if (st.head !== p.head) return true;
  // edits in the editor that OverLyX has not committed yet: fetched once they have settled
  return p.changed != null && p.changed !== st.changed && (p.idle ?? SETTLE_MS) >= SETTLE_MS;
}

/** One pass over the projects: `force` fetches every project, `only` limits it to some keys. */
async function syncOnce(ws, { force = false, keys = null } = {}) {
  const { projects } = await api(ws.creds, '/git/api/projects');
  const list = projects.filter(p => selected(ws, p.name) && (!keys || keys.has(p.name)));
  const results = {};
  let i = 0;
  const worker = async () => {
    while (i < list.length) {
      const p = list[i++];
      try { results[p.name] = await syncProject(ws, p, force || remoteMoved(ws, p)); }
      catch (err) { results[p.name] = 'error'; say(ws, `✗ ${p.name}: ${err.message}`); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, list.length || 1) }, worker));
  if (!keys) {
    await adoptNewFolders(ws, new Set(projects.map(p => p.name)));
    // projects the account can no longer reach: their folders stay, untouched
    for (const key of Object.keys(ws.state.projects)) {
      if (!projects.some(p => p.name === key)) { say(ws, `! ${key}: no longer accessible — its folder is left as it is`); delete ws.state.projects[key]; }
    }
  }
  saveState(ws);
  return { projects, results };
}

async function syncCommand(args, flags) {
  const ws = await openWorkspace(args[0], flags);
  if (!flags.watch) {
    const { results } = await syncOnce(ws, { force: true });
    const n = v => Object.values(results).filter(r => r === v).length;
    say(ws, `${ws.root}: ${Object.keys(results).length} projects — ${n('cloned')} cloned, ${n('synced')} synced, ${n('unchanged')} unchanged${n('conflict') ? `, ${n('conflict')} with conflicts` : ''}${n('error') ? `, ${n('error')} failed` : ''}`);
    if (n('conflict') || n('error')) process.exitCode = 1;
    return;
  }
  ws.watch = true;
  const interval = Math.max(2, Number(flags.interval) || 10) * 1000;
  let busy = false, stop = false;
  const dirty = new Set();
  const recheck = new Map();   // project → when to look again after a push
  ws.recheck = key => recheck.set(key, Date.now() + 4000);
  let debounce = null, again = false;
  /** local changes the watcher saw, pushes to look at again, and (`full`) every project's server state */
  const run = async (full = false) => {
    if (busy) { again = again || full; return; }
    busy = true;
    try {
      const now = Date.now();
      const due = [...recheck].filter(([, t]) => t <= now).map(([k]) => k);
      for (const k of due) recheck.delete(k);
      const local = new Set(dirty); dirty.clear();
      if (local.size) await syncOnce(ws, { keys: local });
      if (due.length) await syncOnce(ws, { keys: new Set(due), force: true });
      if (full) await syncOnce(ws);
    } catch (err) { say(ws, `✗ ${err.message}`); }
    finally { busy = false; }
    if (again || dirty.size) { const f = again; again = false; setTimeout(() => void run(f), 200); }
  };
  say(ws, `watching ${ws.root} (every ${interval / 1000}s; Ctrl+C stops)`);
  busy = true;
  try { await syncOnce(ws, { force: true }); } catch (err) { say(ws, `✗ ${err.message}`); }
  busy = false;
  let watcher = null;
  try {
    watcher = fs.watch(ws.root, { recursive: true }, (_event, name) => {
      if (!name) return;
      const parts = String(name).split(path.sep);
      if (parts.length < 3 || parts[0].startsWith('.') || parts.includes('.git')) return;
      dirty.add(`${parts[0]}/${parts[1]}`);
      clearTimeout(debounce);
      debounce = setTimeout(() => void run(), 1500);
    });
    watcher.on('error', () => { say(ws, '! watching the folder failed: local changes are picked up every interval'); watcher?.close(); watcher = null; });
  } catch { say(ws, '! this system cannot watch folders recursively: local changes are picked up every interval'); }
  let ticks = 0;
  const timer = setInterval(() => {
    // without a watcher (or as a safety net every sixth tick), look at every clone's working tree
    if (!watcher || ++ticks % 6 === 0) for (const key of Object.keys(ws.state.projects)) dirty.add(key);
    void run(true);
  }, interval);
  await new Promise(resolve => {
    const quit = () => { if (stop) return; stop = true; clearInterval(timer); watcher?.close(); const wait = () => (busy ? setTimeout(wait, 100) : resolve()); wait(); };
    process.on('SIGINT', quit);
    process.on('SIGTERM', quit);
  });
}

async function statusCommand(args, flags) {
  const root = path.resolve(args[0] ?? findWorkspace(process.cwd()) ?? defaultWorkspace());
  const state = readJson(path.join(root, WS_DIR, 'state.json'), null);
  if (!state) fail(`${root} is not an OverLyX workspace; create one with: overlyx sync ${args[0] ?? ''}`.trim());
  for (const key of Object.keys(state.projects).sort()) {
    const dir = path.join(root, ...key.split('/'));
    const changes = (await tryGit(dir, ['status', '--porcelain'])).out.split('\n').filter(Boolean).length;
    const { ref } = await upstream(dir);
    const ahead = ref ? await count(dir, `${ref}..HEAD`) : 0;
    const bits = [changes && `${changes} changed file${changes === 1 ? '' : 's'}`, ahead && `${ahead} commit${ahead === 1 ? '' : 's'} not pushed`, state.projects[key].conflict && 'conflict'].filter(Boolean);
    process.stdout.write(`${key}\t${bits.join(', ') || 'in sync (as of the last sync)'}\n`);
  }
}

/**
 * The project and document a command names: a path in a workspace (`paper.tex` inside a project
 * folder, `ada/thesis/main.tex` from the top), or a project key plus path when no workspace is
 * involved. With no document inside a project folder: the project's only top-level document.
 */
function resolveTarget(arg, needPath) {
  const abs = path.resolve(arg ?? '.');
  const remembered = () => {
    const { host, config } = credentials({}, false);
    const dir = config.hosts[host]?.workspace;
    return dir && fs.existsSync(path.join(dir, WS_DIR, 'workspace.json')) ? dir : null;
  };
  const root = findWorkspace(fs.existsSync(abs) ? abs : process.cwd()) ?? (arg ? remembered() : null);
  let parts = null;
  if (root && (fs.existsSync(abs) || arg == null)) {
    const rel = path.relative(root, abs);
    if (!rel.startsWith('..')) parts = rel.split(path.sep).filter(Boolean);
  }
  if (!parts && arg) parts = arg.replace(/^\/+/, '').split('/').filter(Boolean);
  if (!parts || parts.length < 2) fail(arg ? `cannot tell which project “${arg}” is — give <owner>/<project>/<file>.tex or a path inside a workspace` : 'run this inside a project folder of a workspace, or name the document');
  const project = `${parts[0]}/${parts[1]}`;
  let doc = parts.slice(2).join('/');
  if (needPath && !doc) {
    const dir = root ? path.join(root, parts[0], parts[1]) : null;
    const docs = dir && fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.endsWith('.tex') && /\\documentclass/.test(fs.readFileSync(path.join(dir, n), 'utf8').slice(0, 20000))) : [];
    if (docs.length !== 1) fail(docs.length ? `${project} has several documents (${docs.join(', ')}); name one` : `name the document, e.g. ${project}/main.tex`);
    doc = docs[0];
  }
  return { root, project, path: doc };
}

async function syncOneProject(root, project, flags) {
  const ws = await openWorkspace(root, flags);
  ws.quiet = !!flags.quiet;
  const { results } = await syncOnce(ws, { keys: new Set([project]), force: true });
  const r = results[project];
  if (r === 'conflict') fail(`${project} could not be synced (see above); resolve it first or pass --no-sync to build what the server has`);
  if (r === 'error') fail(`${project} could not be synced`);
  return ws;
}

async function buildCommand(args, flags) {
  const creds = credentials(flags);
  const t = resolveTarget(args[0], true);
  if (t.root && !flags['no-sync']) await syncOneProject(t.root, t.project, flags);
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
    if (!r.errors?.length) process.stdout.write(`  (no error message found — rerun with --log)\n`);
    if (r.previous_build === 'ok') process.stdout.write('  The build before this one succeeded, so a recent change broke it: fix it, or step back (git revert <commit>, or overlyx restore).\n');
    process.exitCode = 1;
  }
  if (flags.pdf && r.pdf) {
    const res = await fetch(`${creds.host}/git/api/pdf?project=${encodeURIComponent(t.project)}&path=${encodeURIComponent(t.path)}`, { headers: { Authorization: basic(creds.username, creds.token) } });
    if (!res.ok) fail(`cannot download the PDF: ${res.status} ${res.statusText}`);
    fs.writeFileSync(path.resolve(String(flags.pdf)), Buffer.from(await res.arrayBuffer()));
    process.stdout.write(`PDF: ${path.resolve(String(flags.pdf))}\n`);
  }
}

async function restoreCommand(args, flags) {
  const creds = credentials(flags);
  const commit = args[args.length - 1];
  if (!commit || !/^[0-9a-f]{7,64}$/i.test(commit)) fail('usage: overlyx restore [PROJECT] COMMIT (a commit hash from git log)');
  const t = resolveTarget(args.length > 1 ? args[0] : undefined, false);
  // local commits not pushed yet would be rebased onto the restore: push them first, so they are in the history too
  if (t.root && !flags['no-sync']) await syncOneProject(t.root, t.project, flags);
  const r = await api(creds, '/git/api/restore', { method: 'POST', body: JSON.stringify({ project: t.project, commit: commit.toLowerCase() }) });
  if (!r.restored) { process.stdout.write(`${t.project} is already as it was at ${commit}\n`); return; }
  process.stdout.write(`${t.project}: restored to ${commit} as a new commit (${r.files.length} file${r.files.length === 1 ? '' : 's'}: ${r.files.slice(0, 5).join(', ')}${r.files.length > 5 ? ', …' : ''})\n`);
  if (t.root && !flags['no-sync']) await syncOneProject(t.root, t.project, flags);
}

async function main() {
  const { positional, flags } = parse(process.argv.slice(2));
  if (flags.version || positional[0] === 'version') { process.stdout.write(VERSION + '\n'); return; }
  if (flags.help || !positional.length || positional[0] === 'help') { process.stdout.write(HELP); return; }
  const [group, action, ...args] = positional;
  if (group === 'auth' && action === 'git-credential') await gitCredential(args[0]);
  else if (group === 'auth') await authCommand(action, flags);
  else if (group === 'repo' || group === 'project') await repoCommand(action, args, flags);
  else if (group === 'sync') await syncCommand(positional.slice(1), flags);
  else if (group === 'status') await statusCommand(positional.slice(1), flags);
  else if (group === 'build') await buildCommand(positional.slice(1), flags);
  else if (group === 'restore') await restoreCommand(positional.slice(1), flags);
  else fail(`unknown command: ${group}\n\n${HELP}`);
}

main().catch(error => {
  process.stderr.write(`overlyx: ${error.message ?? error}\n`);
  process.exitCode = error.exitCode ?? 1;
});
