/**
 * Registering the local tool server (agents/server.ts) with the agents on this computer: Claude
 * Code (`claude mcp add-json`, user scope, plus a permission rule so its tools run without a
 * prompt in every folder) and Codex (a [mcp_servers.overlyx-local] table in config.toml, its tools
 * approved). Codex shows the model only the tools' descriptions, not a server's instructions: they
 * say themselves which files they are for.
 *
 * The agents run a launcher kept in the extension's global storage, which outlives extension
 * updates: it starts dist/agents.cjs of the version that registered it — or, once an update has
 * removed that one, of the newest version installed. The command is VS Code's own runtime in
 * Node mode, so no Node.js installation is needed.
 *
 * No VS Code API here (host/agents.ts asks the user and calls these); tests run it against
 * scratch config directories and fake `claude` / `codex` executables.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export const SERVER_NAME = 'overlyx-local';
/** Claude Code's permission rule for every tool of the server */
export const CLAUDE_ALLOW = `mcp__${SERVER_NAME}`;

export interface StdioCommand { command: string; args: string[]; env: Record<string, string> }

/** What the launcher reads: the tool server of the extension version that wrote it, and where to look for a newer one. */
export interface LauncherInfo { main: string; layoutDir: string; extensionsDir: string; extensionId: string }

/**
 * The launcher (CommonJS, run by VS Code's runtime): current.json next to it names the tool
 * server; an update removes the old extension directory, so the newest installed one stands in.
 */
const LAUNCHER = `// Written by the OverLyX VS Code extension: starts its local tool server for AI agents
// (Claude Code, Codex). Rewritten whenever the extension starts; delete the agents' "${SERVER_NAME}"
// entry instead of this file to disconnect them.
'use strict';
const fs = require('fs'), path = require('path');
const info = JSON.parse(fs.readFileSync(path.join(__dirname, 'current.json'), 'utf8'));
let main = info.main, layoutDir = info.layoutDir;
if (!fs.existsSync(main)) {
  // the extension was updated (its old directory is gone): the newest installed version
  const found = fs.readdirSync(info.extensionsDir)
    .filter(d => d.toLowerCase().startsWith(info.extensionId.toLowerCase() + '-'))
    .map(d => path.join(info.extensionsDir, d))
    .filter(d => fs.existsSync(path.join(d, 'dist', 'agents.cjs')))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!found.length) { process.stderr.write('OverLyX: the VS Code extension is no longer installed — remove "${SERVER_NAME}" from your agent\\'s MCP servers\\n'); process.exit(1); }
  main = path.join(found[0], 'dist', 'agents.cjs');
  layoutDir = path.join(found[0], 'dist', 'lyxlib', 'layouts');
}
if (!process.env.OVERLYX_LAYOUT_DIR && layoutDir) process.env.OVERLYX_LAYOUT_DIR = layoutDir;
// here, too: open/<pid>.json, the files open in OverLyX editors
if (!process.env.OVERLYX_AGENTS_DIR) process.env.OVERLYX_AGENTS_DIR = __dirname;
require(main);
`;

/** Write (or refresh) the launcher and its current.json in `dir`; returns the launcher's path. */
export function installLauncher(dir: string, info: LauncherInfo): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${SERVER_NAME}.cjs`);
  writeIfChanged(file, LAUNCHER);
  writeIfChanged(path.join(dir, 'current.json'), JSON.stringify(info, null, 2) + '\n');
  return file;
}

function writeIfChanged(file: string, text: string): void {
  try { if (fs.readFileSync(file, 'utf8') === text) return; } catch { /* new */ }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/**
 * The runtime the agents start the launcher with: VS Code's Electron in Node mode. A Snap's
 * versioned path goes through its `current` link; on macOS the app's main binary, whose Node mode
 * VS Code's own `code` command relies on (execPath is a helper there).
 */
export function launcherCommand(execPath: string, launcher: string, appRoot?: string): StdioCommand {
  let command = execPath.replace(/^\/snap\/([^/]+)\/\d+\//, '/snap/$1/current/');
  if (process.platform === 'darwin' && appRoot) {
    const electron = path.resolve(appRoot, '..', '..', 'MacOS', 'Electron');
    if (fs.existsSync(electron)) command = electron;
  }
  return { command, args: [launcher], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

const sameCommand = (a: Partial<StdioCommand> | undefined, b: StdioCommand): boolean =>
  !!a && a.command === b.command && JSON.stringify(a.args ?? []) === JSON.stringify(b.args) && JSON.stringify(a.env ?? {}) === JSON.stringify(b.env);

async function found(command: string): Promise<boolean> {
  try { await execFileP(command, ['--version'], { timeout: 15000, shell: process.platform === 'win32' }); return true; } catch { return false; }
}

/** Which agents this computer has. */
export async function detectAgents(): Promise<{ claude: boolean; codex: boolean }> {
  const [claude, codex] = await Promise.all([found('claude'), found('codex')]);
  return { claude, codex: codex || fs.existsSync(path.dirname(codexConfigFile())) };
}

/* ------------------------------------------------------------------ Claude Code */

const claudeDir = () => process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
/** Claude Code's settings (permissions) */
export const claudeSettingsFile = () => path.join(claudeDir(), 'settings.json');
/** Claude Code's own state, user-scope MCP servers included (inside CLAUDE_CONFIG_DIR when that is set) */
const claudeStateFile = () => process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(os.homedir(), '.claude.json');

/** The user-scope registration as Claude Code stores it, or undefined. */
function claudeEntry(): Partial<StdioCommand> | undefined {
  try { return JSON.parse(fs.readFileSync(claudeStateFile(), 'utf8'))?.mcpServers?.[SERVER_NAME]; } catch { return undefined; }
}

export function claudeRegistered(cmd?: StdioCommand): boolean {
  const e = claudeEntry();
  return cmd ? sameCommand(e, cmd) : !!e;
}

function readClaudeSettings(): Record<string, unknown> {
  const file = claudeSettingsFile();
  if (!fs.existsSync(file)) return {};
  let v: unknown;
  try { v = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error(`${file} is not plain JSON — add "${CLAUDE_ALLOW}" to permissions.allow there yourself`); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${file} is not a settings object`);
  return v as Record<string, unknown>;
}

/** Add (or take out) the permission rule; everything else in the file stays as it is. Returns whether the file changed. */
export function allowClaudeTools(on: boolean): boolean {
  const settings = readClaudeSettings();
  const p = settings.permissions;
  const perms = p && typeof p === 'object' && !Array.isArray(p) ? p as Record<string, unknown> : {};
  const allow = Array.isArray(perms.allow) ? perms.allow as unknown[] : [];
  if (allow.includes(CLAUDE_ALLOW) === on) return false;
  settings.permissions = { ...perms, allow: on ? [...allow, CLAUDE_ALLOW] : allow.filter(r => r !== CLAUDE_ALLOW) };
  const file = claudeSettingsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.overlyx-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', { mode: fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600 });
  fs.renameSync(tmp, file);
  return true;
}

const claude = (args: string[]) => execFileP('claude', args, { encoding: 'utf8', timeout: 30000, shell: process.platform === 'win32' });

/** Register with Claude Code for every folder (user scope), replacing whatever was registered under the name. */
export async function registerClaude(cmd: StdioCommand): Promise<void> {
  for (const scope of ['user', 'local']) await claude(['mcp', 'remove', SERVER_NAME, '-s', scope]).catch(() => undefined);
  await claude(['mcp', 'add-json', '-s', 'user', SERVER_NAME, JSON.stringify({ type: 'stdio', ...cmd })]);
}

export async function unregisterClaude(): Promise<boolean> {
  let any = false;
  for (const scope of ['user', 'local']) { try { await claude(['mcp', 'remove', SERVER_NAME, '-s', scope]); any = true; } catch { /* not there */ } }
  try { allowClaudeTools(false); } catch { /* not plain JSON: left alone */ }
  return any;
}

/* ------------------------------------------------------------------ Codex */

export const codexConfigFile = () => path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'config.toml');

/** config.toml without the server's table (and its sub-tables) */
function withoutCodexServer(text: string): string {
  const out: string[] = [];
  let skipping = false;
  for (const line of text.split('\n')) {
    const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(line);
    if (header) {
      const key = header[1].replace(/"/g, '');
      skipping = key === `mcp_servers.${SERVER_NAME}` || key.startsWith(`mcp_servers.${SERVER_NAME}.`);
    }
    if (!skipping) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

const tomlString = (v: string) => JSON.stringify(v);   // a TOML basic string: JSON's escapes are TOML's

function codexTable(cmd: StdioCommand): string {
  const env = Object.entries(cmd.env).map(([k, v]) => `${k} = ${tomlString(v)}`).join(', ');
  // approve: Codex asks before every MCP tool call otherwise (its counterpart of Claude Code's permission rule)
  return `[mcp_servers.${SERVER_NAME}]\n# OverLyX VS Code extension: tracked edits and comments in the documents on this computer\ncommand = ${tomlString(cmd.command)}\nargs = [${cmd.args.map(tomlString).join(', ')}]\nenv = { ${env} }\ndefault_tools_approval_mode = "approve"\n`;
}

export function codexRegistered(cmd?: StdioCommand): boolean {
  let text: string;
  try { text = fs.readFileSync(codexConfigFile(), 'utf8'); } catch { return false; }
  return cmd ? text.includes(codexTable(cmd)) : new RegExp(`^\\s*\\[mcp_servers\\.${SERVER_NAME}\\]`, 'm').test(text);
}

export function registerCodex(cmd: StdioCommand): void {
  const file = codexConfigFile();
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* a new config */ }
  // defined some other way (inline table, dotted keys): left to the user, not duplicated
  if (new RegExp(`^\\s*(mcp_servers\\.)?"?${SERVER_NAME}"?\\s*(=|\\.)`, 'm').test(text)) throw new Error(`${file} defines "${SERVER_NAME}" in another form — remove it there and connect again`);
  if (text.includes(codexTable(cmd))) return;
  if (text && !fs.existsSync(file + '.bak')) fs.copyFileSync(file, file + '.bak');
  const rest = withoutCodexServer(text).replace(/\s*$/, '');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, (rest ? rest + '\n\n' : '') + codexTable(cmd));
}

export function unregisterCodex(): boolean {
  const file = codexConfigFile();
  try { const t = fs.readFileSync(file, 'utf8'); const r = withoutCodexServer(t); if (r !== t) { fs.writeFileSync(file, r.replace(/\s*$/, '\n')); return true; } } catch { /* none */ }
  return false;
}
