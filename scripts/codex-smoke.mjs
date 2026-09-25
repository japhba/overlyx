#!/usr/bin/env node
/**
 * Does the installed codex still speak the app-server protocol the agent uses (server/agent.ts)?
 * Starts `codex app-server` with a throwaway CODEX_HOME (no account), sends `initialize` and
 * `model/list`, and exits 0 when both are answered. scripts/update-codex.sh runs it after
 * installing a new codex and reinstalls the previous one when it fails.
 *
 *   node scripts/codex-smoke.mjs [codex-bin]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BIN = process.argv[2] || process.env.OVERLYX_CODEX_BIN || 'codex';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-smoke-'));
const child = spawn(BIN, ['app-server'], { env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = '';
child.stderr.on('data', d => { stderr = (stderr + d).slice(-2000); });

const done = (code, msg) => {
  console[code ? 'error' : 'log'](`codex-smoke: ${msg}`);
  if (code && stderr.trim()) console.error(stderr.trim());
  try { child.kill('SIGKILL'); } catch { /* gone */ }
  fs.rmSync(home, { recursive: true, force: true });
  process.exit(code);
};
setTimeout(() => done(1, 'no answer within 30 s'), 30000).unref();
child.on('error', e => done(1, `could not start ${BIN}: ${e.message}`));
child.on('exit', code => done(1, `codex app-server exited (${code}) before answering`));

const waiting = new Map();
let buf = '';
child.stdout.on('data', d => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && !msg.method && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
  }
});
let nextId = 1;
const request = (method, params) => new Promise(resolve => {
  const id = nextId++;
  waiting.set(id, resolve);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});

const init = await request('initialize', { clientInfo: { name: 'overlyx', title: 'OverLyX', version: '0.1.0' } });
if (init.error) done(1, `initialize failed: ${init.error.message}`);
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n');
const list = await request('model/list', {});
if (list.error) done(1, `model/list failed: ${list.error.message}`);
if (!Array.isArray(list.result?.data)) done(1, `model/list answered without a model list: ${JSON.stringify(list.result).slice(0, 200)}`);
done(0, `${init.result?.userAgent ?? BIN} answers; ${list.result.data.length} models`);
