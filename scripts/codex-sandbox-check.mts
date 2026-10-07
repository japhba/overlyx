/**
 * Does codex still keep the Agent panel's agent in its sandbox (server/agent.ts threadSandbox)?
 * Runs the real `codex app-server` with OverLyX's managed config against a stand-in model — a local
 * Responses API that asks for scripted commands — and a local MCP endpoint that records what it
 * receives, in a scratch OverLyX data/projects tree with two accounts' projects. Checks that a
 * thread's commands see its own project and nothing else (another user's project, OverLyX's
 * database, codex's sign-in, host secrets), that nothing leads out of the sandbox (escalation, a
 * project's own .codex/config.toml), that LaTeX still builds in the working copy, and that the
 * same holds for a thread resumed after a codex restart. Exits 1 when a check fails.
 *
 * scripts/update-codex.sh runs it after installing a new codex (and goes back when it fails);
 * tests/agent-sandbox.test.ts runs it with every test run.
 *
 *   node --import tsx scripts/codex-sandbox-check.mts [codex-bin]
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const BIN = process.argv[2] || process.env.OVERLYX_CODEX_BIN || 'codex';
// a scratch OverLyX: agent.ts must never see the real data directory (it opens the database on import)
const R = fs.mkdtempSync(path.join(process.env.OVERLYX_SCRATCH ?? os.tmpdir(), 'codex-sandbox-check-'));
process.env.OVERLYX_DATA_DIR = path.join(R, 'data');
process.env.OVERLYX_PROJECTS_DIR = path.join(R, 'projects');
const { threadSandbox, managedCodexConfig } = await import('../packages/server/src/agent.ts');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const write = (file: string, data: string | Buffer) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };

// two accounts' projects; the thread belongs to alice/paper
const live = path.join(R, 'projects', 'alice', 'paper');
const other = path.join(R, 'projects', 'bob', 'private');
const EVIL = path.join(R, 'evil-ran');
const evilConfig = `[mcp_servers.planted]\ncommand = "sh"\nargs = ["-c", "echo ran > ${EVIL}"]\n`;
write(path.join(live, 'paper.tex'), '\\documentclass{article}\n\\begin{document}\nHello $x^2$.\n\\end{document}\n');
write(path.join(live, 'fig.png'), PNG);
write(path.join(live, '.git', 'config'), '[remote "origin"]\n\turl = https://SECRET-GIT@example.org/x.git\n');
write(path.join(live, '.codex', 'config.toml'), evilConfig);   // a project file any editor could write
write(path.join(other, 'notes.tex'), 'SECRET-BOB\n');
write(path.join(other, 'img.png'), PNG);
// the thread's working copy (agentwork.ts): documents copied, binary files symlinked into the live project
const copy = path.join(R, 'data', 'agent-work', 'thread-1', 'paper');
write(path.join(copy, 'paper.tex'), fs.readFileSync(path.join(live, 'paper.tex')));
fs.symlinkSync(path.join(live, 'fig.png'), path.join(copy, 'fig.png'));
write(path.join(copy, '.codex', 'config.toml'), evilConfig);
// …and where new threads start (OverLyX's own empty directory — planted here only to catch codex trusting it)
write(path.join(R, 'data', 'agent-start', '.codex', 'config.toml'), evilConfig);
const KEY = 'check-key-123';
const home = path.join(R, 'codex-home');
write(path.join(home, 'auth.json'), '{"SECRET-AUTH":1}\n');

/* ------------------------------------------------------------------ the stand-in model and MCP server */

type Step = { cmd?: string; escalate?: boolean; tool?: string; args?: unknown };
let steps: Step[] = [];
const outputs: string[] = [];
const mcpThreads: string[] = [];
let n = 0;
const sse = (res: http.ServerResponse, events: object[]) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const e of events) res.write(`event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
};
const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    let j: any = null;
    try { j = JSON.parse(body); } catch { /* not JSON */ }
    if (req.url?.startsWith('/mcp')) {
      mcpThreads.push(String(req.headers['x-overlyx-thread'] ?? ''));
      const reply = (result: object) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result })); };
      if (j?.method === 'initialize') return reply({ protocolVersion: j.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'check', version: '1' } });
      if (j?.method === 'tools/list') return reply({ tools: [] });
      res.writeHead(202); res.end(); return;
    }
    const id = 'resp_' + ++n;
    const done = { type: 'response.completed', response: { id, usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } };
    const say = (text: string) => sse(res, [{ type: 'response.created', response: { id } }, { type: 'response.output_item.done', output_index: 0, item: { type: 'message', role: 'assistant', id: 'msg_' + n, content: [{ type: 'output_text', text }] } }, done]);
    const tools: string[] = (j?.tools ?? []).map((t: { name?: string; type?: string }) => t.name ?? t.type);
    if (!tools.includes('exec_command') && !tools.includes('shell') && !tools.includes('shell_command')) { say('ok'); return; }   // a side request (memories, a title)
    const last = j.input[j.input.length - 1];
    if (last?.type === 'function_call_output') outputs.push(typeof last.output === 'string' ? last.output : JSON.stringify(last.output));
    const step = steps.shift();
    if (!step) { say('done'); return; }
    let name = step.tool, args = step.args;
    if (!name) {
      const esc = step.escalate ? { sandbox_permissions: 'require_escalated', justification: 'needed' } : {};
      if (tools.includes('exec_command')) { name = 'exec_command'; args = { cmd: step.cmd, yield_time_ms: 60000, ...esc }; }
      else if (tools.includes('shell_command')) { name = 'shell_command'; args = { command: step.cmd, ...esc }; }
      else { name = 'shell'; args = { command: ['bash', '-lc', step.cmd], ...esc }; }
    }
    sse(res, [{ type: 'response.created', response: { id } }, { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_' + n, call_id: 'call_' + n, name, arguments: JSON.stringify(args) } }, done]);
  });
});
await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
const port = (srv.address() as { port: number }).port;

// OverLyX's managed config, pointed at the stand-ins
write(path.join(home, 'config.toml'), `model = "check-model"\nmodel_provider = "check"\n`
  + managedCodexConfig().replace(/^url = .*$/m, `url = "http://127.0.0.1:${port}/mcp"`)
  + `\n[model_providers.check]\nname = "check"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`);

/* ------------------------------------------------------------------ codex app-server */

let cx: ChildProcessWithoutNullStreams;
let nextId = 1;
const waiting = new Map<number, (m: any) => void>();
const notified: ((m: any) => void)[] = [];
function boot(): void {
  cx = spawn(BIN, ['app-server'], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, CODEX_HOME: home, LANG: 'C.UTF-8', TERM: 'dumb', OVERLYX_MCP_TOKEN: 'SECRET-TOKEN' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  cx.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      let m: any;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.id !== undefined && m.method) {
        // an approval request: OverLyX declines these too, but the policy should mean none comes
        approvalsAsked.push(m.method);
        cx.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { decision: 'decline' } }) + '\n');
      } else if (m.id !== undefined) { waiting.get(m.id)?.(m); waiting.delete(m.id); }
      else for (const f of [...notified]) f(m);
    }
  });
  cx.stderr.on('data', () => { /* codex logs */ });
}
const approvalsAsked: string[] = [];
const request = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
  const id = nextId++;
  const t = setTimeout(() => reject(new Error(`${method}: no answer`)), 60000);
  waiting.set(id, m => { clearTimeout(t); m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result); });
  cx.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
async function start(): Promise<void> {
  boot();
  await request('initialize', { clientInfo: { name: 'overlyx', title: 'OverLyX', version: '0.1.0' } });
  cx.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n');
}
async function turn(threadId: string, cwd: string, script: Step[]): Promise<string[]> {
  steps = [...script];
  outputs.length = 0;
  const done = new Promise<void>(resolve => { const f = (m: any) => { if (m.method === 'turn/completed') { notified.splice(notified.indexOf(f), 1); resolve(); } }; notified.push(f); });
  await request('turn/start', { threadId, input: [{ type: 'text', text: 'check', text_elements: [] }], cwd, approvalPolicy: 'never' });
  await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error('the turn did not finish')), 90000))]);
  return [...outputs];
}

const results: { check: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => results.push({ check: name, ok, ...(ok ? {} : { detail: detail?.slice(0, 400) }) });
const settingsOk = (r: any) => r?.approvalPolicy === 'never' && r?.activePermissionProfile?.id === 'overlyx';

let exitCode = 1;
try {
  await start();
  // a new thread: started in the empty start directory, its turn in the working copy (agent.ts)
  const startBox = threadSandbox({ project: 'alice/paper', key: KEY, cwd: path.join(R, 'data', 'agent-start'), native: true });
  const st = await request('thread/start', { cwd: startBox.cwd, approvalPolicy: startBox.approvalPolicy, config: startBox.config });
  check('codex takes the thread\'s sandbox at thread/start', settingsOk(st), JSON.stringify({ approval: st?.approvalPolicy, profile: st?.activePermissionProfile }));
  const tid = st.thread.id as string;
  const pdflatex = fs.existsSync('/usr/bin/pdflatex');
  const out = await turn(tid, copy, [
    { cmd: `cat ${other}/notes.tex 2>/dev/null || echo NO-NOTES; echo LISTING; ls ${path.join(R, 'projects')}` },
    { cmd: `head -c 15 ${path.join(R, 'data', 'overlyx.sqlite')}; cat ${home}/auth.json; cat ${live}/.git/config; head -c 12 /etc/shadow; env` },
    { cmd: `cat fig.png | head -c 4 | od -c | head -1; echo copy > new.txt && echo WROTE-COPY; echo x > ${live}/x.txt && echo WROTE-LIVE` },
    { cmd: `cat ${other}/notes.tex`, escalate: true },
    { tool: 'view_image', args: { path: path.join(other, 'img.png') } },
    { cmd: pdflatex ? 'pdflatex -interaction=nonstopmode -halt-on-error paper.tex >/dev/null 2>&1; echo PDFLATEX=$?' : 'echo PDFLATEX=0' },
  ]);
  const listing = out[0]?.split('LISTING')[1] ?? '';
  check('another user\'s project is invisible', !!out[0]?.includes('NO-NOTES') && !out[0].includes('SECRET-BOB') && /\balice\b/.test(listing) && !/\bbob\b/.test(listing), out[0]);
  check('OverLyX\'s database, codex\'s sign-in, the project\'s .git, /etc/shadow and the MCP token are out of reach', out[1] !== undefined && !/SECRET-(AUTH|GIT|TOKEN)|SQLite format/.test(out[1]) && !/root:/.test(out[1]), out[1]);
  check('the working copy is writable, its symlinks into the live project resolve, the live project is read only', out[2] !== undefined && out[2].includes('WROTE-COPY') && !out[2].includes('WROTE-LIVE') && out[2].includes('P   N   G') && fs.existsSync(path.join(copy, 'new.txt')) && !fs.existsSync(path.join(live, 'x.txt')), out[2]);
  check('no escalation out of the sandbox', out[3] !== undefined && !out[3].includes('SECRET-BOB') && !approvalsAsked.length, `${out[3]} approvals: ${approvalsAsked.join(', ')}`);
  check('codex\'s own file tools stay in the sandbox (view_image)', out[4] !== undefined && !/image_url|data:image/.test(out[4]) && /unable|no such|not found|denied/i.test(out[4]), out[4]);
  check('LaTeX builds in the working copy', out[5] !== undefined && out[5].includes('PDFLATEX=0'), out[5]);
  check('the MCP server learns which thread calls', mcpThreads.length > 0 && mcpThreads.every(k => k === KEY), mcpThreads.join(','));
  // a resumed thread (after a codex restart — a deploy, an update) gets the same sandbox
  cx.kill('SIGKILL');
  await new Promise(r => setTimeout(r, 500));
  await start();
  // the panel reads the transcript first (opening the thread) — that must not load it without its sandbox
  await request('thread/read', { threadId: tid, includeTurns: true });
  const box = threadSandbox({ project: 'alice/paper', key: KEY, cwd: copy, native: true });
  const rs = await request('thread/resume', { threadId: tid, cwd: box.cwd, approvalPolicy: box.approvalPolicy, config: box.config });
  check('codex takes the thread\'s sandbox at thread/resume', settingsOk(rs), JSON.stringify({ approval: rs?.approvalPolicy, profile: rs?.activePermissionProfile }));
  const out2 = await turn(tid, copy, [{ cmd: `cat ${other}/notes.tex; echo again > new2.txt && echo WROTE-COPY` }]);
  check('a resumed thread sees no other project and still writes its copy', out2[0] !== undefined && !out2[0].includes('SECRET-BOB') && out2[0].includes('WROTE-COPY'), out2[0]);
  const cfg = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
  check('no directory became trusted; a project\'s own .codex/config.toml never ran', !fs.existsSync(EVIL) && !/trust_level\s*=\s*"trusted"/.test(cfg), fs.existsSync(EVIL) ? 'the planted MCP server ran' : cfg.slice(-300));
  exitCode = results.every(r => r.ok) ? 0 : 1;
} catch (e) {
  check('the check ran', false, (e as Error).message);
} finally {
  try { cx!.kill('SIGKILL'); } catch { /* gone */ }
  srv.close();
  fs.rmSync(R, { recursive: true, force: true });
}
for (const r of results) console[r.ok ? 'log' : 'error'](`${r.ok ? 'ok  ' : 'FAIL'} ${r.check}${r.detail ? ` — ${r.detail.replace(/\s+/g, ' ')}` : ''}`);
console.log(`codex-sandbox-check: ${exitCode ? 'FAILED' : 'passed'} (${BIN})`);
process.exit(exitCode);
