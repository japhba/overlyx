/**
 * The extension's sync (src/host/sync.ts) in a real VS Code against a running OverLyX server — an
 * isolated instance, never production: a project is created there, cloned into a scratch workspace,
 * and test/suite/sync.cjs checks inside the extension host that the clone is synced by itself, both
 * ways, that a file with unsaved changes in an editor waits until it is saved (then merges), that
 * clones INSIDE a workspace folder are synced without being added to the workspace (two levels down
 * by the folder scan, four levels down once a file of it is opened), and that *Clone Project from
 * OverLyX…* clones into a workspace folder and syncs that clone at once (its pickers answered by the
 * test). The window is a two-folder workspace: the clone, and a plain folder holding the nested clones.
 * The sign-in comes from a scratch CLI config (OVERLYX_CONFIG_DIR), which also makes the server known.
 *
 *   OVERLYX_E2E_SERVER=http://127.0.0.1:3003 OVERLYX_E2E_CREDENTIALS=$S/data/credentials.txt \
 *   OVERLYX_PROJECTS_DIR=$S/projects xvfb-run -a node test/runSyncTest.mjs
 */
import { runTests } from '@vscode/test-electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = (process.env.OVERLYX_E2E_SERVER ?? '').replace(/\/$/, '');
const projectsDir = process.env.OVERLYX_PROJECTS_DIR ?? '';
if (!server || !process.env.OVERLYX_E2E_CREDENTIALS || !projectsDir.startsWith('/tmp/')) throw new Error('needs OVERLYX_E2E_SERVER, OVERLYX_E2E_CREDENTIALS and an isolated OVERLYX_PROJECTS_DIR under /tmp');
const [username, password] = fs.readFileSync(process.env.OVERLYX_E2E_CREDENTIALS, 'utf8').split('\n').filter(l => l.startsWith('admin\t')).pop().split('\t');
const PROJECT = `${username}/vscode-sync`;
const NESTED = `${username}/vscode-sync-nested`, DEEP = `${username}/vscode-sync-deep`;

const login = await fetch(`${server}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
if (!login.ok) throw new Error(`login failed: ${login.status}`);
const cookie = login.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
const api = async (method, p, body) => {
  const r = await fetch(`${server}/api${p}`, { method, headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return r.ok ? r.json().catch(() => ({})) : null;
};
for (const p of [PROJECT, NESTED, DEEP]) {
  await api('DELETE', `/projects/${encodeURIComponent(p)}`);
  fs.rmSync(path.join(projectsDir, p), { recursive: true, force: true });
  if (!await api('POST', '/projects', { name: p })) throw new Error(`cannot create the project ${p}`);
  await api('POST', `/projects/${p}/new`, { path: 'main.tex', title: 'VS Code sync' });
}
const { token } = await api('POST', '/git/tokens');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overlyx-vscode-sync-'));
const ws = path.join(root, 'vscode-sync');
const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
const clone = (project, dir) => execFileSync('git', ['-c', `http.extraHeader=Authorization: Basic ${Buffer.from(`${username}:${token}`).toString('base64')}`, 'clone', '-q', `${server}/git/${project}.git`, dir], { env: gitEnv });
clone(PROJECT, ws);
// a plain folder (no repository) holding clones: one two levels down, one four (deeper than the scan)
const outer = path.join(root, 'outer');
const nested = path.join(outer, 'papers', 'nested'), deep = path.join(outer, 'a', 'b', 'c', 'deep');
fs.mkdirSync(path.dirname(nested), { recursive: true });
fs.mkdirSync(path.dirname(deep), { recursive: true });
clone(NESTED, nested);
clone(DEEP, deep);
const workspace = path.join(root, 'sync.code-workspace');
fs.writeFileSync(workspace, JSON.stringify({ folders: [{ path: ws }, { path: outer }] }));
const config = path.join(root, 'config');
fs.mkdirSync(config, { recursive: true });
fs.writeFileSync(path.join(config, 'hosts.json'), JSON.stringify({ defaultHost: server, hosts: { [server]: { username, token } } }), { mode: 0o600 });

try {
  await runTests({
    extensionDevelopmentPath: pkg,
    extensionTestsPath: path.join(pkg, 'test/suite/sync.cjs'),
    launchArgs: [workspace, '--disable-workspace-trust', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-extensions'],
    cachePath: path.join(pkg, '.vscode-test'),
    extensionTestsEnv: { OVERLYX_TEST_WS: ws, OVERLYX_TEST_SERVER_DIR: path.join(projectsDir, PROJECT), OVERLYX_TEST_SERVER: server, OVERLYX_TEST_PROJECT: PROJECT, OVERLYX_TEST_CLONES: path.join(outer, 'clones'),
      OVERLYX_TEST_NESTED: nested, OVERLYX_TEST_NESTED_SERVER_DIR: path.join(projectsDir, NESTED), OVERLYX_TEST_DEEP: deep, OVERLYX_CONFIG_DIR: config, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
  console.log('sync integration test PASSED');
} catch (e) {
  console.error('sync integration test FAILED', e);
  process.exitCode = 1;
} finally {
  for (const p of [PROJECT, NESTED, DEEP]) {
    await api('DELETE', `/projects/${encodeURIComponent(p)}`);
    fs.rmSync(path.join(projectsDir, p), { recursive: true, force: true });
  }
  fs.rmSync(root, { recursive: true, force: true });
}
