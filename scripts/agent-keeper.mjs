#!/usr/bin/env node
/**
 * The agent keeper: owns one `codex app-server` child and bridges its JSON-lines stdio to a unix
 * socket, so the codex process — and any turn it is running — survives OverLyX server restarts,
 * deploys included (the systemd unit uses KillMode=process; the keeper is spawned detached).
 * The server (packages/server/src/agent.ts) connects and speaks the app-server protocol through
 * this bridge; after a restart it reconnects. While nobody is connected, codex's lines are
 * buffered and replayed on the next connect, and unanswered server→client requests (approvals)
 * are re-delivered so a pending approval reappears instead of silently starving the turn.
 * Lines starting with {"keeper": are the bridge's own control channel (hello on connect,
 * mark-initialized, shutdown, codex stderr/exit passthrough) and never reach codex.
 * The keeper exits when codex exits, on shutdown, when its socket file disappears (the
 * instance's data directory was removed — tests), or after KEEPER_IDLE_MS with no client.
 */
import net from 'node:net';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const SOCK = process.env.KEEPER_SOCKET;
const BIN = (process.env.KEEPER_BIN ?? 'codex').trim();
const HOME = process.env.KEEPER_HOME;
const IDLE_MS = Number(process.env.KEEPER_IDLE_MS ?? 2 * 60 * 60 * 1000);
if (!SOCK || !HOME) { console.error('agent-keeper: KEEPER_SOCKET and KEEPER_HOME are required'); process.exit(2); }

let initialized = false;   // the app-server initialize handshake happened (once per codex process)
let client = null;
let exiting = false;
const backlog = [];                 // codex → client lines while nobody is connected
const MAX_BACKLOG = 20000;
const outstanding = new Map();      // id → request line codex sent us and nobody answered yet

const child = spawn(BIN, ['app-server'], {
  cwd: HOME,
  env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME, CODEX_HOME: HOME, LANG: process.env.LANG ?? 'C.UTF-8', TERM: 'dumb', OVERLYX_MCP_TOKEN: process.env.OVERLYX_MCP_TOKEN ?? '' },
  stdio: ['pipe', 'pipe', 'pipe'],
});

function shutdown(code = 0, killChild = true) {
  if (exiting) return;
  exiting = true;
  if (killChild) {
    try { child.kill('SIGTERM'); } catch { /* gone */ }
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 2000).unref();
  }
  try { server.close(); } catch { /* not listening */ }
  try { client?.destroy(); } catch { /* closed */ }
  setTimeout(() => { try { fs.unlinkSync(SOCK); } catch { /* gone */ } process.exit(code); }, killChild ? 2300 : 300).unref();
  // with only unref'd timers left the process may exit sooner; make the unlink unconditional
  process.on('exit', () => { try { fs.unlinkSync(SOCK); } catch { /* gone */ } });
}

const toClient = (line) => {
  let msg = null;
  try { msg = JSON.parse(line); } catch { /* codex noise — forward as-is */ }
  if (msg && msg.id !== undefined && msg.method) {
    // a server→client request (approval …): tracked until answered, re-delivered on reconnect
    outstanding.set(String(msg.id), line);
    if (client) client.write(line + '\n');
    return;
  }
  if (client) { client.write(line + '\n'); return; }
  backlog.push(line);
  if (backlog.length > MAX_BACKLOG) backlog.shift();
};

let outBuf = '';
child.stdout.on('data', (d) => {
  outBuf += String(d);
  let i;
  while ((i = outBuf.indexOf('\n')) >= 0) {
    const l = outBuf.slice(0, i); outBuf = outBuf.slice(i + 1);
    if (l.trim()) toClient(l);
  }
});
child.stderr.on('data', (d) => { const s = String(d).trim(); if (s) toClient(JSON.stringify({ keeper: 'stderr', line: s.slice(0, 500) })); });
child.on('exit', (code) => { toClient(JSON.stringify({ keeper: 'exit', code })); shutdown(code ?? 0, false); });
child.on('error', (e) => { toClient(JSON.stringify({ keeper: 'stderr', line: 'spawn failed: ' + e.message })); shutdown(1, false); });

let lastClientAt = Date.now();
const server = net.createServer((c) => {
  if (client) client.destroy();   // one server at a time; the newest wins
  client = c;
  lastClientAt = Date.now();
  c.setEncoding('utf8');
  c.write(JSON.stringify({ keeper: 'hello', initialized, pid: child.pid }) + '\n');
  for (const line of outstanding.values()) c.write(line + '\n');
  for (const line of backlog.splice(0)) c.write(line + '\n');
  let buf = '';
  c.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      if (line.startsWith('{"keeper"')) {
        let m = null;
        try { m = JSON.parse(line); } catch { /* ignore */ }
        if (m?.keeper === 'shutdown') { shutdown(0); return; }
        if (m?.keeper === 'mark-initialized') initialized = true;
        continue;
      }
      try { const m = JSON.parse(line); if (m && m.id !== undefined && !m.method) outstanding.delete(String(m.id)); } catch { /* forward anyway */ }
      child.stdin.write(line + '\n');
    }
  });
  c.on('close', () => { if (client === c) { client = null; lastClientAt = Date.now(); } });
  c.on('error', () => { /* close follows */ });
});
try { fs.unlinkSync(SOCK); } catch { /* none */ }
server.listen(SOCK);
server.on('error', (e) => { console.error('agent-keeper:', e.message); shutdown(1); });

// housekeeping: exit when the socket file disappears or no server has connected for a long time
setInterval(() => {
  if (exiting) return;
  if (!fs.existsSync(SOCK)) shutdown(0);
  else if (!client && Date.now() - lastClientAt > IDLE_MS) shutdown(0);
}, 30000).unref();

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
