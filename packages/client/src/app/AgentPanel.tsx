/**
 * The Agent panel (right sidebar): OpenAI Codex embedded in OverLyX. Users sign in with their
 * own ChatGPT account (device code — the server keeps credentials per account, shared across
 * their projects, together with codex's memories). A thread runs in the project's directory on
 * the server; its transcript streams in over SSE (message/reasoning deltas, command output,
 * file-change diffs) and codex's approval requests are answered from here. Threads belong to
 * the project: every editor sees them, the one who started a thread drives it.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { api, type AgentStatus, type AgentLogin, type AgentThreadInfo, type AgentItem, type AgentChange, type AgentEventMsg, type AgentTurnContext } from '../api';
import { editorContext } from '../editor/context';

interface Approval { requestId: string; method: string; params: any }

const errText = (e: unknown) => (e as Error)?.message ?? String(e);

/** The current editor selection as the context the server turns into LaTeX. */
function selectionContext(): AgentTurnContext | undefined {
  const view = editorContext.activeView;
  const docId = editorContext.docId;
  if (!view || !docId) return docId ? { docId } : undefined;
  const sel = view.state.selection;
  const ctx: AgentTurnContext = { docId: view.dom.dataset.docId ?? docId };
  if (!sel.empty) {
    ctx.content = (sel.content().toJSON() as { content?: any[] } | null)?.content ?? [];
    ctx.layout = String(sel.$from.parent.attrs?.layout ?? 'Standard');
  }
  return ctx;
}

const userText = (it: AgentItem): string =>
  (it.content ?? []).map(c => c.text ?? '').filter(t => t && !t.startsWith('[context]')).join('\n').trim();

function Diff({ changes }: { changes: AgentChange[] }) {
  return (
    <div class="agent-diff">
      {changes.map(c => (
        <div key={c.path}>
          <div class="path">{c.kind === 'delete' ? '− ' : c.kind === 'add' ? '+ ' : '± '}{c.path.split('/').slice(-2).join('/')}</div>
          {(c.diff || '').split('\n').slice(0, 200).map((l, i) => <div key={i} class={l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : ''}>{l || ' '}</div>)}
        </div>
      ))}
    </div>
  );
}

function ItemView({ it }: { it: AgentItem }) {
  const [open, setOpen] = useState(false);
  switch (it.type) {
    case 'userMessage': {
      const t = userText(it);
      return t ? <div class="agent-msg user" data-agent="user">{t}</div> : null;
    }
    case 'agentMessage':
      return <div class="agent-msg assistant" data-agent="assistant">{it.text ?? ''}</div>;
    case 'reasoning': {
      const t = (it.summary ?? it.content ?? []).join('\n').trim();
      if (!t) return <div class="agent-item reasoning">Thinking…</div>;
      return <div class="agent-item reasoning" onClick={() => setOpen(o => !o)} title="The agent's reasoning summary">{open ? t : t.split('\n')[0].slice(0, 90) + (t.length > 90 ? ' …' : '')}</div>;
    }
    case 'commandExecution':
      return (
        <div class="agent-item cmd" data-agent="cmd">
          <div class="line" onClick={() => setOpen(o => !o)}>$ {it.command}{it.exitCode != null && it.exitCode !== 0 ? <span class="err"> ✗ {it.exitCode}</span> : it.status === 'inProgress' ? <span class="run"> …</span> : null}</div>
          {(open || it.status === 'inProgress') && it.aggregatedOutput ? <div class="out">{it.aggregatedOutput.slice(-4000)}</div> : null}
        </div>
      );
    case 'fileChange':
      return (
        <div class="agent-item" data-agent="filechange">
          <Diff changes={it.changes ?? []} />
          {it.status === 'declined' && <div class="declined">declined</div>}
        </div>
      );
    case 'mcpToolCall':
      return <div class="agent-item reasoning">{it.server}: {it.tool}{it.status === 'inProgress' ? ' …' : ''}</div>;
    case 'plan':
      return <div class="agent-msg assistant plan">{it.text ?? ''}</div>;
    default:
      return null;
  }
}

function ApprovalCard({ a, onDecide }: { a: Approval; onDecide: (d: string) => void }) {
  const p = a.params ?? {};
  const isCmd = /commandExecution|execCommand/.test(a.method);
  return (
    <div class="agent-approval" data-agent="approval">
      <div class="what">
        <b>{isCmd ? 'Run this command?' : 'Apply these changes?'}</b>
        {p.reason && <div class="reason">{p.reason}</div>}
        {isCmd ? <div class="agent-item cmd"><div class="line">$ {p.command}</div></div> : <Diff changes={p.changes ?? []} />}
      </div>
      <div class="btns">
        <button class="small-btn" data-approve="accept" onClick={() => onDecide('accept')}>Allow</button>
        <button class="small-btn" data-approve="acceptForSession" onClick={() => onDecide('acceptForSession')} title="Allow this and similar actions for the rest of this session">Allow for session</button>
        <button class="small-btn" data-approve="decline" onClick={() => onDecide('decline')}>Deny</button>
      </div>
    </div>
  );
}

export function AgentPanel({ project, notify }: { project: string; notify: (msg: string, kind?: 'info' | 'error') => void }) {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [login, setLogin] = useState<AgentLogin | null>(null);
  const [threads, setThreads] = useState<AgentThreadInfo[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [mine, setMine] = useState(true);
  const [items, setItems] = useState<AgentItem[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [busyTurn, setBusyTurn] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [includeSel, setIncludeSel] = useState(true);
  const selRef = useRef(sel); selRef.current = sel;
  const scrollRef = useRef<HTMLDivElement>(null);

  const refreshStatus = () => api.agentStatus().then(setStatus).catch(e => { setStatus({ enabled: false, authenticated: false }); notify(errText(e), 'error'); });
  const refreshThreads = () => api.agentThreads(project).then(r => setThreads(r.threads)).catch(() => { /* no access yet */ });

  useEffect(() => { void refreshStatus(); }, []);
  useEffect(() => { setSel(null); setItems([]); setApprovals([]); if (status?.authenticated) void refreshThreads(); }, [project, status?.authenticated]);

  /** codex's live events for this user + project */
  useEffect(() => {
    const es = new EventSource(`/api/projects/${encodeURIComponent(project)}/agent/events`);
    es.onmessage = (e) => {
      let msg: AgentEventMsg;
      try { msg = JSON.parse(e.data); } catch { return; }
      const p = msg.params ?? {};
      if (msg.kind === 'request') {
        if (p.threadId === selRef.current && msg.requestId) setApprovals(a => [...a, { requestId: msg.requestId!, method: msg.method ?? '', params: p }]);
        return;
      }
      if (msg.kind !== 'notification') return;
      if (msg.method === 'account/login/completed') {
        setLogin(null);
        p.success ? void refreshStatus() : notify(p.error || 'Sign-in failed', 'error');
        return;
      }
      if (p.threadId !== selRef.current) {
        if (msg.method === 'turn/completed') void refreshThreads();
        return;
      }
      const upsert = (item: AgentItem) => setItems(list => {
        const i = list.findIndex(x => x.id === item.id);
        return i >= 0 ? [...list.slice(0, i), item, ...list.slice(i + 1)] : [...list, item];
      });
      const append = (itemId: string, patch: (it: AgentItem) => AgentItem, fallback: AgentItem) => setItems(list => {
        const i = list.findIndex(x => x.id === itemId);
        return i >= 0 ? [...list.slice(0, i), patch(list[i]), ...list.slice(i + 1)] : [...list, patch(fallback)];
      });
      switch (msg.method) {
        case 'turn/started': setBusyTurn(p.turn?.id ?? null); break;
        case 'turn/completed': setBusyTurn(null); setApprovals([]); void refreshThreads(); break;
        case 'error': setBusyTurn(null); notify(p.error?.message ?? 'The agent reported an error', 'error'); break;
        case 'item/started': upsert(p.item); break;
        case 'item/completed': upsert(p.item); setApprovals(a => a.filter(x => x.params?.itemId !== p.item?.id)); break;
        case 'item/agentMessage/delta':
          append(p.itemId, it => ({ ...it, text: (it.text ?? '') + (p.delta ?? '') }), { type: 'agentMessage', id: p.itemId, text: '' });
          break;
        case 'item/reasoning/textDelta':
        case 'item/reasoning/summaryTextDelta':
          append(p.itemId, it => ({ ...it, summary: [((it.summary ?? [''])[0] ?? '') + (p.delta ?? '')] }), { type: 'reasoning', id: p.itemId, summary: [''] });
          break;
        case 'item/commandExecution/outputDelta':
          append(p.itemId, it => ({ ...it, aggregatedOutput: ((it.aggregatedOutput ?? '') + (typeof p.chunk === 'string' ? p.chunk : p.delta ?? '')) }), { type: 'commandExecution', id: p.itemId, command: '', status: 'inProgress' });
          break;
      }
    };
    return () => es.close();
  }, [project]);

  useEffect(() => { const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight; }, [items.length, approvals.length]);

  const openThread = (t: AgentThreadInfo) => {
    setSel(t.id); setMine(t.mine); setItems([]); setApprovals([]);
    api.agentThread(project, t.id)
      .then(r => { setItems(r.thread.turns.flatMap(turn => turn.items)); setMine(r.mine); })
      .catch(e => notify(errText(e), 'error'));
  };

  const send = () => {
    const t = text.trim();
    if (!t || busyTurn) return;
    const context = includeSel ? selectionContext() : undefined;
    setText('');
    const localItem: AgentItem = { type: 'userMessage', id: 'local-' + Date.now(), content: [{ type: 'text', text: t }] };
    void (async () => {
      try {
        let tid = selRef.current;
        if (!tid) { const r = await api.agentStartThread(project); tid = r.id; setSel(tid); setMine(true); setItems([]); void refreshThreads(); }
        setItems(list => [...list, localItem]);
        setBusyTurn('pending');
        await api.agentTurn(project, tid, { text: t, context });
      } catch (e) { setBusyTurn(null); notify(errText(e), 'error'); }
    })();
  };

  if (!status) return <div class="agent-panel"><div class="empty">Connecting…</div></div>;
  if (!status.enabled) return <div class="agent-panel"><div class="empty">The agent is not enabled on this server.</div></div>;

  if (!status.authenticated) {
    return (
      <div class="agent-panel" data-agent="signin">
        <div class="agent-signin">
          <p>The agent is <b>OpenAI Codex</b> running on this project's files, with your own ChatGPT account — sign in once, it is kept for your account (all your projects).</p>
          {!login ? (
            <button class="small-btn" data-agent-login onClick={() => api.agentLogin().then(setLogin).catch(e => notify(errText(e), 'error'))}>Sign in with ChatGPT…</button>
          ) : (
            <div class="code-box">
              <p>Open <a href={login.verificationUrl} target="_blank" rel="noreferrer">{login.verificationUrl.replace(/^https?:\/\//, '')}</a> and enter:</p>
              <div class="code" data-agent-code>{login.userCode}</div>
              <p class="wait">Waiting for the sign-in to finish…</p>
              <button class="small-btn" onClick={() => { void api.agentLoginCancel(login.loginId).catch(() => { /* gone */ }); setLogin(null); }}>Cancel</button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div class="agent-panel" data-agent="panel">
      <div class="agent-head">
        {sel && <button class="small-btn" data-agent-back title="All threads of this project" onClick={() => { setSel(null); setItems([]); setApprovals([]); void refreshThreads(); }}>‹</button>}
        <span class="who" title={`Signed in as ${status.account?.email ?? 'ChatGPT'}${status.account?.plan ? ` (${status.account.plan})` : ''}`}>
          {sel ? (threads.find(t => t.id === sel)?.title ?? 'Thread') : (status.account?.email ?? 'ChatGPT')}
        </span>
        {!sel && <button class="small-btn" title="Sign this ChatGPT account out of the agent" onClick={() => api.agentLogout().then(() => refreshStatus()).catch(e => notify(errText(e), 'error'))}>Sign out</button>}
      </div>
      {!sel ? (
        <div class="agent-scroll agent-threads" ref={scrollRef}>
          <button class="small-btn new" data-agent-new onClick={() => { setSel(null); setItems([]); setMine(true); const ta = document.querySelector<HTMLTextAreaElement>('.agent-compose textarea'); ta?.focus(); }}>Ask below to start a new thread ↓</button>
          {threads.map(t => (
            <div key={t.id} class="row" data-agent-thread onClick={() => openThread(t)}>
              <div class="title">{t.title ?? 'New thread'}</div>
              <div class="meta">{t.mine ? 'you' : t.user.name ?? 'someone'} · {new Date(t.updatedAt).toLocaleDateString()}</div>
            </div>
          ))}
          {!threads.length && <div class="empty">No agent threads in this project yet.</div>}
        </div>
      ) : (
        <div class="agent-scroll" ref={scrollRef}>
          {items.map(it => <ItemView key={it.id} it={it} />)}
          {approvals.map(a => (
            <ApprovalCard key={a.requestId} a={a} onDecide={(d) => {
              setApprovals(list => list.filter(x => x.requestId !== a.requestId));
              void api.agentApprove(project, sel, a.requestId, d).catch(e => notify(errText(e), 'error'));
            }} />
          ))}
          {busyTurn && !approvals.length && <div class="agent-item reasoning" data-agent="busy">Working…</div>}
        </div>
      )}
      {(!sel || mine) && (
        <div class="agent-compose">
          <textarea
            value={text}
            placeholder={sel ? 'Reply… (Enter to send)' : 'Ask the agent… (Enter to send)'}
            onInput={e => setText((e.target as HTMLTextAreaElement).value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          />
          <div class="row">
            <label title="Send the current editor selection along as context"><input type="checkbox" checked={includeSel} onChange={e => setIncludeSel((e.target as HTMLInputElement).checked)} /> selection</label>
            <span class="spacer" />
            {busyTurn && busyTurn !== 'pending' && sel && <button class="small-btn" data-agent-stop onClick={() => void api.agentInterrupt(project, sel, busyTurn).catch(e => notify(errText(e), 'error'))}>Stop</button>}
            <button class="small-btn" data-agent-send disabled={!text.trim() || !!busyTurn} onClick={send}>Send</button>
          </div>
        </div>
      )}
      {sel && !mine && <div class="agent-readonly">Started by {threads.find(t => t.id === sel)?.user.name ?? 'another editor'} — you can read it, not drive it.</div>}
    </div>
  );
}
