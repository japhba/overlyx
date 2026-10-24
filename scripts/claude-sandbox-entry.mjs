#!/usr/bin/env node
/**
 * The first process in a Claude Code sandbox (scripts/claude-app-server.mjs starts it under bwrap,
 * with the sandbox's settings from the server — agent.ts claudeTurnSandbox). The sandbox has no
 * network: here, 127.0.0.1:OL_PORT is forwarded to OverLyX's internal socket (OL_SOCK, its
 * directory bound in read only — agentnet.ts), which serves the provider proxy and the MCP tools
 * and nothing else. Then it runs the command it was given (Claude Code) and ends with it.
 *
 *   node claude-sandbox-entry.mjs <command> [args…]
 */
import net from 'node:net';
import { spawn } from 'node:child_process';

const SOCK = process.env.OL_SOCK;
const PORT = Number(process.env.OL_PORT ?? 8765);
const [cmd, ...args] = process.argv.slice(2);
if (!SOCK || !cmd) { console.error('claude-sandbox-entry: OL_SOCK and a command are required'); process.exit(2); }

const forwarder = net.createServer(c => {
  const u = net.connect(SOCK);
  c.pipe(u); u.pipe(c);
  c.on('error', () => u.destroy());
  u.on('error', () => c.destroy());
});
forwarder.on('error', e => { console.error('claude-sandbox-entry:', e.message); process.exit(1); });
forwarder.listen(PORT, '127.0.0.1', () => {
  const env = { ...process.env };
  delete env.OL_SOCK; delete env.OL_PORT;
  const child = spawn(cmd, args, { stdio: 'inherit', env });
  child.on('error', e => { console.error('claude-sandbox-entry:', e.message); process.exit(1); });
  child.on('exit', (code, sig) => { forwarder.close(); process.exit(code ?? (sig ? 1 : 0)); });
  for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(s, () => child.kill(s));
});
