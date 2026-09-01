#!/usr/bin/env node
// A stand-in for the `codex` CLI's app-server mode (agent.ts) for unit and e2e tests: speaks
// just enough of the JSON-RPC/JSONL protocol — device-code login (completes by itself after a
// moment), threads, turns that echo the input as streamed deltas, and a file-change approval
// round-trip for prompts containing "write hello". No network, state under $CODEX_HOME.
import fs from 'node:fs';
import path from 'node:path';

if (process.argv[2] !== 'app-server') { console.error('codex-stub: only app-server is stubbed'); process.exit(2); }
const HOME = process.env.CODEX_HOME ?? '/tmp/codex-stub-home';
fs.mkdirSync(HOME, { recursive: true });
const authFile = path.join(HOME, 'auth.json');
const authed = () => fs.existsSync(authFile);

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const result = (id, r) => out({ id, result: r });
const notify = (method, params) => out({ method, params, emittedAtMs: Date.now() });

let nThread = 0, nTurn = 0, nItem = 0, nReq = 900;
const threads = new Map();          // id -> { id, cwd, turns: [] }
const pendingApprovals = new Map(); // rpc id -> resolve(decision)

const thread = (t) => ({ id: t.id, preview: '', ephemeral: false, status: { type: 'idle' }, cwd: t.cwd, turns: t.turns, createdAt: 1, updatedAt: 1, name: null });

function runTurn(id, p) {
  const t = threads.get(p.threadId);
  const turnId = 'turn-' + ++nTurn;
  // several input items arrive when the server prepends editor context; the user's message is last
  const all = (p.input ?? []).map(i => i.text ?? '');
  const text = all[all.length - 1] ?? '';
  const turn = (status) => ({ id: turnId, items: [], itemsView: 'full', status, error: null, startedAt: 1, completedAt: null, durationMs: null });
  notify('turn/started', { threadId: t.id, turn: turn('inProgress') });
  const finish = () => {
    const itemId = 'item-' + ++nItem;
    const reply = `Stub reply to: ${text.split('\n').pop().slice(0, 120)}`;
    notify('item/started', { threadId: t.id, turnId, item: { type: 'agentMessage', id: itemId, text: '', phase: null }, startedAtMs: Date.now() });
    for (const piece of [reply.slice(0, 12), reply.slice(12)]) notify('item/agentMessage/delta', { threadId: t.id, turnId, itemId, delta: piece });
    notify('item/completed', { threadId: t.id, turnId, item: { type: 'agentMessage', id: itemId, text: reply, phase: null }, completedAtMs: Date.now() });
    t.turns.push({ ...turn('completed'), items: [{ type: 'userMessage', id: 'u' + nItem, content: p.input }, { type: 'agentMessage', id: itemId, text: reply, phase: null }] });
    notify('turn/completed', { threadId: t.id, turn: turn('completed') });
    result(id, { turn: turn('completed') });
  };
  if (/write hello/i.test(text)) {
    const itemId = 'item-' + ++nItem, reqId = ++nReq;
    const change = { path: path.join(t.cwd, 'hello.txt'), kind: 'add', diff: '+hello from the stub agent\n' };
    notify('item/started', { threadId: t.id, turnId, item: { type: 'fileChange', id: itemId, changes: [change], status: 'inProgress' }, startedAtMs: Date.now() });
    pendingApprovals.set(reqId, (decision) => {
      const ok = decision === 'accept' || decision === 'acceptForSession';
      if (ok) fs.writeFileSync(change.path, 'hello from the stub agent\n');
      notify('item/completed', { threadId: t.id, turnId, item: { type: 'fileChange', id: itemId, changes: [change], status: ok ? 'completed' : 'declined' }, completedAtMs: Date.now() });
      finish();
    });
    out({ id: reqId, method: 'item/fileChange/requestApproval', params: { threadId: t.id, turnId, itemId, startedAtMs: Date.now(), reason: null, changes: [change] } });
  } else setTimeout(finish, Number(process.env.STUB_DELAY ?? 150));
}

let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    const { id, method, params: p = {} } = m;
    if (id !== undefined && !method) {   // a response to one of our approval requests
      const cb = pendingApprovals.get(id);
      if (cb) { pendingApprovals.delete(id); cb(m.result?.decision ?? 'decline'); }
      continue;
    }
    switch (method) {
      case 'initialize': result(id, { userAgent: 'codex-stub/0', codexHome: HOME, platformFamily: 'unix', platformOs: 'linux' }); break;
      case 'initialized': break;
      case 'getAuthStatus': result(id, authed() ? { authMethod: 'chatgpt', authToken: null, requiresOpenaiAuth: false } : { authMethod: null, authToken: null, requiresOpenaiAuth: true }); break;
      case 'account/read': result(id, { account: authed() ? { type: 'chatgpt', email: 'stub@example.com', planType: 'plus' } : null, requiresOpenaiAuth: !authed() }); break;
      case 'account/login/start':
        result(id, { type: 'chatgptDeviceCode', loginId: 'login-1', verificationUrl: 'https://auth.example/device', userCode: 'STUB-CODE' });
        setTimeout(() => { fs.writeFileSync(authFile, '{"stub":true}'); notify('account/login/completed', { loginId: 'login-1', success: true, error: null }); }, Number(process.env.STUB_LOGIN_DELAY ?? 300));
        break;
      case 'account/login/cancel': result(id, {}); break;
      case 'account/logout': try { fs.unlinkSync(authFile); } catch { /* gone */ } result(id, {}); break;
      case 'thread/start': {
        const t = { id: 'thread-' + ++nThread, cwd: p.cwd ?? HOME, turns: [] };
        threads.set(t.id, t);
        result(id, { thread: thread(t), model: 'stub-model', modelProvider: 'openai', serviceTier: null, cwd: t.cwd });
        notify('thread/started', { thread: thread(t) });
        break;
      }
      case 'thread/resume': {
        const t = threads.get(p.threadId) ?? { id: p.threadId, cwd: p.cwd ?? HOME, turns: [] };
        threads.set(t.id, t);
        result(id, { thread: thread(t) });
        break;
      }
      case 'thread/read': { const t = threads.get(p.threadId); t ? result(id, { thread: thread(t) }) : out({ id, error: { code: -32600, message: 'no such thread' } }); break; }
      case 'thread/list': result(id, { data: [...threads.values()].map(thread), nextCursor: null }); break;
      case 'turn/start': runTurn(id, p); break;
      case 'turn/interrupt': result(id, {}); notify('turn/completed', { threadId: p.threadId, turn: { id: p.turnId, items: [], itemsView: 'full', status: 'interrupted', error: null, startedAt: 1, completedAt: 2, durationMs: 1 } }); break;
      default: out({ id, error: { code: -32601, message: 'stub: unknown method ' + method } });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
