/**
 * The OverLyX CLI on the user's computer as a runner for the Agent panel (`overlyx agent run`, kept
 * running as a login service by `overlyx agent install`). It keeps one outgoing event stream open
 * here — the server cannot reach into the user's computer — and when the owner writes to it in the
 * panel, it runs Claude Code there (`claude -p`) with the model and effort chosen in the panel, the
 * user's own Claude login, and only OverLyX's MCP tools; what it does and its answer come back as
 * the conversation's messages.
 *
 * In mcpAgents.ts it is an agent like the others — a row per credential and computer (client
 * `overlyx-runner@<computer>`) — whose messages go to the runner, one turn at a time, instead of to
 * a poll. The Claude Code it starts reaches /mcp through the CLI's bridge under that same client
 * name, so its edits and its presence in documents are that agent's.
 *
 *   GET  /cli/agent/connect?host=<computer>&info=<JSON>   the event stream: {type:'turn'|'stop'}
 *   POST /cli/agent/turns/:id                             {progress} | {final} | {error}
 *
 * Both take the CLI's credential as a Bearer token; the account's role in each project and a
 * narrowed credential's scope apply to everything the agent then does through /mcp.
 */
import express, { type Request, type Response } from 'express';
import { db, type UserRow } from './db.ts';
import { toSessionUser, type SessionUser } from './auth.ts';
import { verifyAccessToken, type AccessTokenIdentity } from './tokenAuth.ts';
import { AgentMessageError, RUNNER_PREFIX, agentFor, registerRunner, runnerReport, unregisterRunner, type RunnerBackend, type RunnerLink } from './mcpAgents.ts';

function bearer(req: Request): { ident: AccessTokenIdentity; user: SessionUser } | null {
  const m = /^Bearer\s+(\S+)/i.exec(req.header('authorization') ?? '');
  const ident = m ? verifyAccessToken(m[1]) : null;
  if (!ident) return null;
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(ident.userId) as UserRow | undefined;
  if (!row || row.is_guest) return null;
  return { ident, user: { ...toSessionUser(row), ...(ident.scope ? { scope: ident.scope } : {}) } };
}

const str = (v: unknown, max: number, re?: RegExp): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.trim().slice(0, max);
  return s && (!re || re.test(s)) ? s : null;
};
const list = (v: unknown, n: number, max: number, re: RegExp): string[] =>
  Array.isArray(v) ? [...new Set(v.map(x => str(x, max, re)).filter((x): x is string => !!x))].slice(0, n) : [];

/** What the runner says it can run (sizes and characters checked: it ends up in the panel). */
function backendsOf(raw: unknown): RunnerBackend[] {
  if (!Array.isArray(raw)) return [];
  const out: RunnerBackend[] = [];
  for (const b of raw.slice(0, 4)) {
    if (!b || typeof b !== 'object') continue;
    const o = b as Record<string, unknown>;
    const id = str(o.id, 20, /^[a-z][a-z-]*$/), name = str(o.name, 40);
    if (!id || !name) continue;
    out.push({ id, name, version: str(o.version, 40), models: list(o.models, 20, 80, /^[\w.\-[\]:/@]+$/), efforts: list(o.efforts, 10, 20, /^[\w-]+$/) });
  }
  return out;
}

export function agentRunnerRoutes(): express.Router {
  const r = express.Router();

  r.get('/cli/agent/connect', (req: Request, res: Response) => {
    const who = bearer(req);
    if (!who) { res.status(401).json({ error: 'not signed in, or the sign-in was revoked — run: overlyx auth login' }); return; }
    let info: Record<string, unknown> = {};
    try { const v = JSON.parse(String(req.query.info ?? '{}')); if (v && typeof v === 'object') info = v; } catch { /* none */ }
    const backends = backendsOf(info.backends);
    if (!backends.length) { res.status(400).json({ error: 'no agent to run on this computer (Claude Code was not found)' }); return; }
    const host = (String(req.query.host ?? '').trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)) || 'computer';
    const row = agentFor(who.ident, { name: RUNNER_PREFIX + host, title: `${backends[0].name} on ${host}`, version: str(info.version, 40) ?? undefined });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    let open = true;
    const link: RunnerLink = {
      agentId: row.id, userId: row.user_id, host, backends,
      busy: Number.isInteger(info.busy) ? info.busy as number : null,
      send: (e) => { if (open) res.write(`data: ${JSON.stringify(e)}\n\n`); },
      close: () => { if (open) { open = false; res.end(); } },
    };
    link.send({ type: 'hello', agent: row.id, name: `${backends[0].name} on ${host}` });
    // (a data event, not a comment: the runner reconnects when it hears nothing for a while)
    const hb = setInterval(() => link.send({ type: 'ping' }), 20_000);
    req.on('close', () => { open = false; clearInterval(hb); unregisterRunner(link); });
    registerRunner(link);
  });

  r.post('/cli/agent/turns/:id', express.json({ limit: '256kb' }), (req: Request, res: Response) => {
    const who = bearer(req);
    if (!who) { res.status(401).json({ error: 'not signed in' }); return; }
    try { runnerReport(who.ident, Number(req.params.id), req.body ?? {}); res.json({ ok: true }); }
    catch (e) { res.status(e instanceof AgentMessageError ? e.status : 500).json({ error: (e as Error).message }); }
  });

  return r;
}
