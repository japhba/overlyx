/**
 * The Agent panel (right sidebar): OpenAI Codex embedded in OverLyX. Users sign in with their
 * own ChatGPT account (device code — the server keeps credentials per account, shared across
 * their projects, together with codex's memories). A thread runs in the project's directory on
 * the server; its transcript streams in over SSE (message/reasoning deltas, command output,
 * file-change diffs) and codex's approval requests are answered from here — with an optional
 * comment that steers the running turn. Model and reasoning effort come from codex's own list
 * and are sent per turn. Assistant text renders LaTeX through the math editor's KaTeX path with
 * the open document's macros. Completed diffs collapse to a summary and only unfold by
 * themselves when they look important (small, or touching the open document); the transcript
 * follows the stream while you are at the bottom. Threads belong to the project: every editor
 * sees them, the one who started a thread drives it.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { api, type AgentStatus, type AgentLogin, type AgentThreadInfo, type AgentItem, type AgentChange, type AgentEventMsg, type AgentTurnContext, type AgentModel } from '../api';
import { editorContext } from '../editor/context';
import { renderStaticHtml } from '../editor/lyxmath/field';

interface Approval { requestId: string; method: string; params: any }

const errText = (e: unknown) => (e as Error)?.message ?? String(e);
const stored = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const store = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

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

/* ------------------------------------------------------------------ LaTeX + markdown-lite rendering */

function MathBit({ latex, display }: { latex: string; display: boolean }) {
  const html = useMemo(() => {
    try { return renderStaticHtml(latex, display, (editorContext.meta?.macros ?? {}) as never); } catch { return null; }
  }, [latex, display]);
  if (!html) return <span>{display ? `\\[${latex}\\]` : `$${latex}$`}</span>;
  return <span class={'agent-math' + (display ? ' display' : '')} dangerouslySetInnerHTML={{ __html: html }} />;
}

function inlineBits(text: string): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  const re = /\$([^$\n]+?)\$|\\\((.+?)\\\)|`([^`\n]+)`|\*\*([^*\n]+?)\*\*/g;
  let last = 0, k = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined || m[2] !== undefined) out.push(<MathBit key={k++} latex={m[1] ?? m[2]} display={false} />);
    else if (m[3] !== undefined) out.push(<code key={k++}>{m[3]}</code>);
    else out.push(<b key={k++}>{m[4]}</b>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Assistant text: fenced code, $$…$$/\[…\] display math, $…$/\(…\) inline math, `code`, **bold**. */
function RichText({ text }: { text: string }) {
  const parts: ComponentChildren[] = [];
  const re = /```[\w-]*\n?([\s\S]*?)```|\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g;
  let last = 0, k = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) parts.push(...inlineBits(text.slice(last, m.index)));
    if (m[1] !== undefined) parts.push(<pre key={'c' + k++} class="agent-code">{m[1].replace(/\n$/, '')}</pre>);
    else parts.push(<div key={'m' + k++} class="agent-math-block"><MathBit latex={(m[2] ?? m[3]).trim()} display /></div>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(...inlineBits(text.slice(last)));
  return <>{parts}</>;
}

/* ------------------------------------------------------------------ diffs */

function diffStats(c: AgentChange): { add: number; del: number } {
  let add = 0, del = 0;
  for (const l of (c.diff || '').split('\n')) {
    if (l.startsWith('+') && !l.startsWith('+++')) add++;
    else if (l.startsWith('-') && !l.startsWith('---')) del++;
  }
  return { add, del };
}

function Diff({ changes }: { changes: AgentChange[] }) {
  return (
    <div class="agent-diff">
      {changes.map(c => (
        <div key={c.path}>
          <div class="path">{c.kind === 'delete' ? '− ' : c.kind === 'add' ? '+ ' : '± '}{c.path.split('/').slice(-2).join('/')}</div>
          {(c.diff || '').split('\n').slice(0, 400).map((l, i) => <div key={i} class={l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : ''}>{l || ' '}</div>)}
        </div>
      ))}
    </div>
  );
}

/** A file change: always folded to its one-line +/− summary — click for the diff. */
function FileChangeView({ it }: { it: AgentItem }) {
  const changes = it.changes ?? [];
  const [open, setOpen] = useState(false);
  return (
    <div class="agent-item" data-agent="filechange">
      <div class="agent-diff-summary" onClick={() => setOpen(o => !o)} title="Show / hide this diff">
        <span class="chev">{open ? '▾' : '▸'}</span>
        {changes.map(c => { const s = diffStats(c); return <span key={c.path} class="file">{c.path.split('/').pop()} <span class="add">+{s.add}</span> <span class="del">−{s.del}</span></span>; })}
        {it.status === 'declined' && <span class="declined">declined</span>}
        {it.status === 'failed' && <span class="declined">failed</span>}
      </div>
      {open && <Diff changes={changes} />}
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
      return <div class="agent-msg assistant" data-agent="assistant"><RichText text={it.text ?? ''} /></div>;
    case 'reasoning': {
      const t = (it.summary ?? it.content ?? []).join('\n').trim();
      if (!t) return <div class="agent-item reasoning">Thinking…</div>;
      return <div class="agent-item reasoning" onClick={() => setOpen(o => !o)} title="The agent's reasoning summary">{open ? t : t.split('\n')[0].slice(0, 90) + (t.length > 90 ? ' …' : '')}</div>;
    }
    case 'commandExecution':
      // folded to one line by default — click for the output
      return (
        <div class="agent-item tool" data-agent="cmd">
          <div class="line" onClick={() => setOpen(o => !o)}>
            <span class="chev">{open ? '▾' : '▸'}</span> $ {it.command}
            {it.status === 'inProgress' ? ' …' : it.exitCode != null && it.exitCode !== 0 ? <span class="err"> ✗ {it.exitCode}</span> : null}
          </div>
          {open && it.aggregatedOutput ? <div class="out">{it.aggregatedOutput.slice(-4000)}</div> : null}
        </div>
      );
    case 'mcpToolCall':
      return (
        <div class="agent-item tool" data-agent="mcptool">
          <div class="line" onClick={() => setOpen(o => !o)}>
            <span class="chev">{open ? '▾' : '▸'}</span> {it.server}: {it.tool}
            {it.status === 'inProgress' ? ' …' : it.status === 'failed' ? <span class="err"> ✗</span> : null}
          </div>
          {open && (it as any).arguments !== undefined ? <div class="out">{JSON.stringify((it as any).arguments, null, 1).slice(0, 2000)}</div> : null}
        </div>
      );
    case 'fileChange':
      return <FileChangeView key={it.id} it={it} />;
    case 'plan':
      return <div class="agent-msg assistant plan"><RichText text={it.text ?? ''} /></div>;
    default:
      return null;
  }
}

/** The diff + accept view of a pending approval, with an optional comment back to the agent. */
function ApprovalCard({ a, onDecide }: { a: Approval; onDecide: (d: string, feedback: string) => void }) {
  const [fb, setFb] = useState('');
  const p = a.params ?? {};
  const isCmd = /commandExecution|execCommand/.test(a.method);
  return (
    <div class="agent-approval" data-agent="approval">
      <div class="what">
        <b>{isCmd ? 'Run this command?' : 'Apply these changes?'}</b>
        {p.reason && <div class="reason">{p.reason}</div>}
        {!isCmd && (p.changes ?? []).some((c: { path?: string }) => c.path?.endsWith('.tex')) && (
          <div class="reason">⚠ A direct file write — it bypasses Track Changes. Deny (with a note) to make the agent propose it as a reviewable tracked edit instead.</div>
        )}
        {isCmd ? <div class="agent-item cmd"><div class="line">$ {p.command}</div></div> : <Diff changes={p.changes ?? []} />}
      </div>
      <input class="fb" placeholder="Optional: tell the agent what to do differently…" value={fb} onInput={e => setFb((e.target as HTMLInputElement).value)} />
      <div class="btns">
        <button class="small-btn" data-approve="accept" onClick={() => onDecide('accept', fb)}>Allow</button>
        <button class="small-btn" data-approve="acceptForSession" onClick={() => onDecide('acceptForSession', fb)} title="Allow this and similar actions for the rest of this session">Allow for session</button>
        <button class="small-btn" data-approve="decline" onClick={() => onDecide('decline', fb)}>Deny</button>
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
  const [models, setModels] = useState<AgentModel[]>([]);
  const [model, setModel] = useState(stored('ol.agent.model') ?? '');
  const [effort, setEffort] = useState(stored('ol.agent.effort') ?? '');
  const selRef = useRef(sel); selRef.current = sel;
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);   // follow the stream while the user is at the bottom

  const refreshStatus = () => api.agentStatus().then(setStatus).catch(e => { setStatus({ enabled: false, authenticated: false }); notify(errText(e), 'error'); });
  const refreshThreads = () => api.agentThreads(project).then(r => setThreads(r.threads)).catch(() => { /* no access yet */ });

  useEffect(() => { void refreshStatus(); }, []);
  useEffect(() => {
    setSel(null); setItems([]); setApprovals([]);
    if (!status?.authenticated) return;
    // reopen the thread that was open here last time (kept per project, survives reloads)
    void api.agentThreads(project).then(r => {
      setThreads(r.threads);
      const want = stored('ol.agent.sel:' + project);
      const row = want ? r.threads.find(t => t.id === want) : null;
      if (row) openThread(row);
    }).catch(() => { /* no access yet */ });
  }, [project, status?.authenticated]);

  /** codex's model catalogue, once signed in; keep stored choices when they still exist */
  useEffect(() => {
    if (!status?.authenticated) return;
    api.agentModels().then(r => {
      setModels(r.models);
      const cur = r.models.find(m => m.id === (stored('ol.agent.model') ?? '')) ?? r.models.find(m => m.isDefault) ?? r.models[0];
      if (cur) {
        setModel(cur.id);
        const ef = stored('ol.agent.effort');
        setEffort(ef && cur.efforts.includes(ef) ? ef : (cur.defaultEffort ?? ''));
      }
    }).catch(() => { /* selector stays hidden */ });
  }, [status?.authenticated]);

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
      // the stream echoes the user's message as a real item — it replaces the optimistic local one,
      // but ONLY when it carries visible text (codex may echo the hidden [context] input as its own
      // item holding the client id; that one must neither show nor swallow the local bubble)
      const mergeUser = (item: AgentItem) => {
        const txt = userText(item);
        if (!txt) return;
        setItems(list => {
          const cid = (item as { clientId?: string | null }).clientId;
          const rest = list.filter(x => !(x.id.startsWith('local-') && (x.id === cid || userText(x) === txt)));
          const i = rest.findIndex(x => x.id === item.id);
          return i >= 0 ? [...rest.slice(0, i), item, ...rest.slice(i + 1)] : [...rest, item];
        });
      };
      switch (msg.method) {
        case 'turn/started': setBusyTurn(p.turn?.id ?? null); break;
        case 'turn/completed': setBusyTurn(null); setApprovals([]); void refreshThreads(); break;
        case 'error': setBusyTurn(null); notify(p.error?.message ?? 'The agent reported an error', 'error'); break;
        case 'item/started': if (p.item?.type !== 'userMessage') upsert(p.item); break;   // user echoes only count once complete
        case 'item/completed': p.item?.type === 'userMessage' ? mergeUser(p.item) : upsert(p.item); setApprovals(a => a.filter(x => x.params?.itemId !== p.item?.id)); break;
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

  // auto-advance: keep the newest content in view unless the user scrolled up to read
  useEffect(() => { const el = scrollRef.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [items, approvals, busyTurn]);
  const onScroll = () => { const el = scrollRef.current; if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120; };

  const openThread = (t: AgentThreadInfo) => {
    setSel(t.id); setMine(t.mine); setItems([]); setApprovals([]); stick.current = true;
    store('ol.agent.sel:' + project, t.id);
    api.agentThread(project, t.id)
      .then(r => { setItems(r.thread.turns.flatMap(turn => turn.items)); setMine(r.mine); })
      .catch(e => notify(errText(e), 'error'));
  };

  const send = () => {
    const t = text.trim();
    if (!t) return;
    stick.current = true;
    const localItem: AgentItem = { type: 'userMessage', id: 'local-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6), content: [{ type: 'text', text: t }] };
    // while a turn runs, the composer steers it instead of queueing a new turn
    if (busyTurn && busyTurn !== 'pending' && selRef.current) {
      setText('');
      setItems(list => [...list, localItem]);
      void api.agentSteer(project, selRef.current, busyTurn, t, localItem.id).catch(e => notify(errText(e), 'error'));
      return;
    }
    if (busyTurn) return;
    const context = includeSel ? selectionContext() : undefined;
    setText('');
    void (async () => {
      try {
        let tid = selRef.current;
        if (!tid) { const r = await api.agentStartThread(project); tid = r.id; setSel(tid); setMine(true); setItems([]); store('ol.agent.sel:' + project, tid); void refreshThreads(); }
        setItems(list => [...list, localItem]);
        setBusyTurn('pending');
        await api.agentTurn(project, tid, { text: t, context, clientMessageId: localItem.id, ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
      } catch (e) { setBusyTurn(null); notify(errText(e), 'error'); }
    })();
  };

  const decide = (a: Approval, decision: string, feedback: string) => {
    setApprovals(list => list.filter(x => x.requestId !== a.requestId));
    void (async () => {
      try {
        if (!selRef.current) return;
        await api.agentApprove(project, selRef.current, a.requestId, decision);
        if (feedback.trim() && busyTurn && busyTurn !== 'pending') await api.agentSteer(project, selRef.current, busyTurn, feedback.trim());
      } catch (e) { notify(errText(e), 'error'); }
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

  const curModel = models.find(m => m.id === model);
  const efforts = curModel?.efforts?.length ? curModel.efforts : ['low', 'medium', 'high'];

  return (
    <div class="agent-panel" data-agent="panel">
      <div class="agent-head">
        {sel && <button class="small-btn" data-agent-back title="All threads of this project" onClick={() => { setSel(null); setItems([]); setApprovals([]); store('ol.agent.sel:' + project, ''); void refreshThreads(); }}>‹</button>}
        <span class="who" title={`Signed in as ${status.account?.email ?? 'ChatGPT'}${status.account?.plan ? ` (${status.account.plan})` : ''}`}>
          {sel ? (threads.find(t => t.id === sel)?.title ?? 'Thread') : (status.account?.email ?? 'ChatGPT')}
        </span>
        {!sel && <button class="small-btn" title="Sign this ChatGPT account out of the agent" onClick={() => api.agentLogout().then(() => refreshStatus()).catch(e => notify(errText(e), 'error'))}>Sign out</button>}
      </div>
      {!sel ? (
        <div class="agent-scroll agent-threads" ref={scrollRef} onScroll={onScroll}>
          {threads.map(t => (
            <div key={t.id} class="row" data-agent-thread onClick={() => openThread(t)}>
              <div class="title">{t.title ?? 'New thread'}</div>
              <div class="meta">{t.mine ? 'you' : t.user.name ?? 'someone'} · {new Date(t.updatedAt).toLocaleDateString()}</div>
            </div>
          ))}
          {!threads.length && <div class="empty">No agent threads in this project yet — ask below to start one.</div>}
        </div>
      ) : (
        <div class="agent-scroll" ref={scrollRef} onScroll={onScroll}>
          {items.map(it => <ItemView key={it.id} it={it} />)}
          {approvals.map(a => <ApprovalCard key={a.requestId} a={a} onDecide={(d, fb) => decide(a, d, fb)} />)}
          {busyTurn && !approvals.length && <div class="agent-item reasoning" data-agent="busy">Working…</div>}
        </div>
      )}
      {(!sel || mine) && (
        <div class="agent-compose">
          <textarea
            value={text}
            placeholder={busyTurn && busyTurn !== 'pending' ? 'Steer the running turn… (Enter to send)' : sel ? 'Reply… (Enter to send)' : 'Ask the agent… (Enter to send)'}
            onInput={e => setText((e.target as HTMLTextAreaElement).value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          />
          <div class="row">
            {models.length > 0 && (
              <select class="agent-select" data-agent-model title={curModel?.description || 'Model'} value={model}
                onChange={e => { const v = (e.target as HTMLSelectElement).value; setModel(v); store('ol.agent.model', v); const m = models.find(x => x.id === v); const ef = m?.defaultEffort ?? ''; setEffort(ef); store('ol.agent.effort', ef); }}>
                {models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            )}
            {models.length > 0 && (
              <select class="agent-select" data-agent-effort title="Reasoning effort" value={effort}
                onChange={e => { const v = (e.target as HTMLSelectElement).value; setEffort(v); store('ol.agent.effort', v); }}>
                {efforts.map(ef => <option key={ef} value={ef}>{ef}</option>)}
              </select>
            )}
            <label title="Send the current editor selection along as context"><input type="checkbox" checked={includeSel} onChange={e => setIncludeSel((e.target as HTMLInputElement).checked)} /> selection</label>
            <span class="spacer" />
            {busyTurn && busyTurn !== 'pending' && sel && <button class="small-btn" data-agent-stop onClick={() => void api.agentInterrupt(project, sel, busyTurn).catch(e => notify(errText(e), 'error'))}>Stop</button>}
            <button class="small-btn" data-agent-send disabled={!text.trim() || busyTurn === 'pending'} onClick={send}>{busyTurn && busyTurn !== 'pending' ? 'Steer' : 'Send'}</button>
          </div>
        </div>
      )}
      {sel && !mine && <div class="agent-readonly">Started by {threads.find(t => t.id === sel)?.user.name ?? 'another editor'} — you can read it, not drive it.</div>}
    </div>
  );
}
