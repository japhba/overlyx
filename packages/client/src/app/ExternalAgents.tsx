/**
 * Agents connected from elsewhere, in the Agent panel: Claude Code, Codex, ChatGPT … that work on
 * the account's projects over the MCP connector (the server's mcpAgents.ts). The panel lists them
 * (useExternalAgents: the list and every message arrive over one SSE stream for the account) and
 * holds the conversation with one: the owner writes, the message goes to the agent with where the
 * owner is (the document, the selection — or a passage pinned with "Ask agent about this"), the
 * agent picks it up (wait_for_instructions, or pushed into a Claude Code session) and answers with
 * its reply tool. Only the account the agent's token belongs to sees and drives it.
 *
 * One kind runs on the owner's computer: the OverLyX CLI there (`overlyx agent install`) starts
 * Claude Code for each message, with the model and reasoning effort picked here (agent.runner);
 * its tool calls arrive as progress, its last message as the answer, and Stop ends the turn.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { api, type AgentTurnContext, type ExternalAgent, type ExternalAgentEvent, type ExternalAgentMessage, type RunnerTurnOptions } from '../api';
import { RichText, transcriptCopy } from './agentText';
import { uiConfirm } from './Dialogs';

type Notify = (msg: string, kind?: 'info' | 'error') => void;
const errText = (e: unknown) => (e as Error)?.message ?? String(e);

/** "3 min ago" */
export function ago(t: number): string {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}

type MessageListener = (agentId: number, m: ExternalAgentMessage) => void;

/**
 * The account's agents from elsewhere, live: the list (status, last seen) and a way to hear about
 * messages as they are added or change. After the stream dropped (sleep, a deploy) it reloads;
 * `resync` counts those reconnects so a conversation view can reload too.
 */
export function useExternalAgents(): { agents: ExternalAgent[]; onMessage: (fn: MessageListener) => () => void; resync: number } {
  const [agents, setAgents] = useState<ExternalAgent[]>([]);
  const [resync, setResync] = useState(0);
  const listeners = useRef(new Set<MessageListener>());
  useEffect(() => {
    let closed = false;
    void api.externalAgents().then(r => { if (!closed) setAgents(r.agents); }).catch(() => { /* none */ });
    const es = new EventSource('/api/mcp-agents/events');
    let lost = false;
    es.onerror = () => { lost = true; };
    es.onopen = () => { if (lost) { lost = false; setResync(n => n + 1); } };
    es.onmessage = (e) => {
      let ev: ExternalAgentEvent;
      try { ev = JSON.parse(e.data); } catch { return; }
      if (ev.kind === 'agents') setAgents(ev.agents);
      else if (ev.kind === 'message') for (const fn of listeners.current) fn(ev.agentId, ev.message);
    };
    return () => { closed = true; es.close(); };
  }, []);
  return { agents, resync, onMessage: (fn) => { listeners.current.add(fn); return () => { listeners.current.delete(fn); }; } };
}

const STATUS_TEXT: Record<ExternalAgent['status'], string> = { listening: 'Listening', working: 'Working…', online: 'Connected', offline: 'Offline' };

const stored = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const store = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

function statusLine(a: ExternalAgent): string {
  if (a.runner) return a.status === 'offline' ? `Offline · the OverLyX agent on ${a.runner.host} is not running` : a.status === 'working' ? `Working on ${a.runner.host}…` : `Ready on ${a.runner.host}`;
  const where = a.project ? ` · ${a.project}${a.path ? ' › ' + a.path : ''}` : '';
  return a.status === 'offline' ? `Offline · last seen ${ago(a.lastSeen)}${where}` : `${STATUS_TEXT[a.status]}${where}`;
}

/** The small dot + name of an agent, for the panel's switcher. */
export function AgentChip({ a }: { a: ExternalAgent }) {
  return <><span class={'ext-dot ' + a.status} style={{ background: a.status === 'offline' ? undefined : a.color }} />{a.name}</>;
}

function stateText(m: ExternalAgentMessage, a: ExternalAgent): string {
  if (a.runner) {
    if (m.state === 'queued') return a.runner.online ? 'Waiting for the turn before it' : `Waiting for ${a.runner.host} to come online`;
    if (m.state === 'delivered') return `Running on ${a.runner.host}`;
  }
  switch (m.state) {
    case 'queued': return m.pushedAt ? 'Sent to its session — waiting for it to answer' : 'Waiting for the agent to pick it up';
    case 'delivered': return m.via === 'push' ? 'Pushed to the agent' : 'The agent has it';
    case 'answered': return 'Answered';
    case 'cancelled': return 'Taken back';
    default: return m.state;
  }
}

/** How to make the agent listen — shown while it is not. */
function ListenHint({ a }: { a: ExternalAgent }) {
  if (a.runner) return (
    <div class="ext-hint" data-ext-hint>
      <p>The OverLyX agent on <b>{a.runner.host}</b> is not running, so it cannot start Claude Code there right now. Messages wait until it is back.</p>
      <p>On that computer, once: <code class="ext-cmd">overlyx agent install</code> — it then starts with the login. Or keep <code>overlyx agent run</code> open in a terminal.</p>
    </div>
  );
  const isClaude = a.client.name === 'claude-code';
  return (
    <div class="ext-hint" data-ext-hint>
      {a.status === 'offline' ? <p><b>{a.name}</b> is not connected right now.</p> : <p><b>{a.name}</b> is connected but not listening for messages.</p>}
      <p>In its terminal, ask it to <b>listen to OverLyX</b> — it then waits for what you write here (its <code>wait_for_instructions</code> tool) and answers here.</p>
      {isClaude && <p>Claude Code can also receive your messages by itself, without polling: start it with<br /><code class="ext-cmd">claude --dangerously-load-development-channels server:overlyx</code><br />(<code>overlyx</code> is the name you gave the server in <code>claude mcp add</code>).</p>}
    </div>
  );
}

/** The conversation with one agent from elsewhere: messages, their delivery, the composer. */
export function ExternalAgentView({ agent, notify, onMessage, resync, pinned, onUnpin, contextOf, focusKey }: {
  agent: ExternalAgent; notify: Notify;
  onMessage: (fn: MessageListener) => () => void; resync: number;
  /** a passage pinned with "Ask agent about this": sent as the context of the next message */
  pinned: AgentTurnContext | null; onUnpin: () => void;
  /** where the user is now (document, selection) */
  contextOf: () => AgentTurnContext | undefined;
  /** changes when the composer should take the keyboard */
  focusKey: number;
}) {
  const [messages, setMessages] = useState<ExternalAgentMessage[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [withSelection, setWithSelection] = useState(true);
  // a runner's turn: model and effort (kept per agent in this browser), and whether the next message starts a new conversation
  const key = `ol.runner.${agent.id}`;
  const [model, setModel] = useState(() => stored(key + '.model') ?? '');
  const [effort, setEffort] = useState(() => stored(key + '.effort') ?? '');
  const [fresh, setFresh] = useState(false);
  const backend = agent.runner?.backends[0] ?? null;
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    let on = true;
    setMessages([]); stick.current = true;
    void api.externalAgentMessages(agent.id).then(r => { if (on) setMessages(r.messages); }).catch(e => notify(errText(e), 'error'));
    const off = onMessage((id, m) => {
      if (id !== agent.id) return;
      setMessages(list => { const i = list.findIndex(x => x.id === m.id); return i >= 0 ? [...list.slice(0, i), m, ...list.slice(i + 1)] : [...list, m].sort((a, b) => a.id - b.id); });
    });
    return () => { on = false; off(); };
  }, [agent.id, resync]);
  useEffect(() => { if (focusKey) inputRef.current?.focus(); }, [focusKey]);
  useEffect(() => { const el = scrollRef.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [messages]);
  const onScroll = () => { const el = scrollRef.current; if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120; };

  const send = () => {
    const t = text.trim();
    if (!t || busy) return;
    const context = pinned ?? (withSelection ? contextOf() : undefined);
    const options: RunnerTurnOptions | undefined = agent.runner ? { ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(fresh ? { fresh } : {}) } : undefined;
    setBusy(true); stick.current = true;
    api.externalAgentSend(agent.id, t, context, options)
      .then(r => { setText(''); setFresh(false); onUnpin(); setMessages(list => list.some(x => x.id === r.message.id) ? list : [...list, r.message]); })
      .catch(e => notify(errText(e), 'error'))
      .finally(() => setBusy(false));
  };
  const cancel = (m: ExternalAgentMessage) => { api.externalAgentCancel(agent.id, m.id).catch(e => notify(errText(e), 'error')); };

  const stop = (m: ExternalAgentMessage) => { api.externalAgentStop(agent.id, m.id).catch(e => notify(errText(e), 'error')); };
  const listening = agent.runner ? agent.status !== 'offline' : agent.status === 'listening' || agent.status === 'working' || agent.push === 'confirmed';
  const optionText = (o: RunnerTurnOptions | null | undefined) => o ? [o.model, o.effort && `effort ${o.effort}`, o.fresh && 'new conversation'].filter(Boolean).join(' · ') : '';
  const pinText = pinned?.content?.length ? 'the selected passage' : pinned?.mathLatex ? 'the selected formula part' : null;
  return (
    <div class="agent-panel ext-agent" data-ext-agent={agent.id}>
      <div class="agent-head ext-head">
        <span class={'ext-dot ' + agent.status} style={{ background: agent.status === 'offline' ? undefined : agent.color }} />
        <span class="who" data-ext-status={agent.status} title={`${agent.label} — ${agent.client.name || 'MCP client'}${agent.client.version ? ' ' + agent.client.version : ''}, with your ${agent.token}${agent.lastTool ? `\nLast tool: ${agent.lastTool} (${ago(agent.lastSeen)})` : ''}${agent.push === 'confirmed' ? '\nMessages are pushed into its session' : ''}`}>
          {statusLine(agent)}
        </span>
        <button class="small-btn" title="Remove this agent and its conversation from the list (it comes back when it connects again)"
          onClick={() => void uiConfirm('Forget Agent', `Remove ${agent.label} and your conversation with it from this list? It appears again the next time it connects.`, { okLabel: 'Forget' }).then(ok => { if (ok) api.externalAgentForget(agent.id).catch(e => notify(errText(e), 'error')); })}>Forget</button>
      </div>
      <div class="agent-scroll" ref={scrollRef} onScroll={onScroll} onCopy={transcriptCopy}>
        {!messages.length && <div class="empty">{agent.runner ? `Write below: Claude Code starts on ${agent.runner.host} with the model and effort you pick, works on your projects through OverLyX's tools, and answers here.` : `Write to ${agent.name} below — it gets your message with where you are in the document and answers here.`}</div>}
        {messages.map(m => m.role === 'user' ? (
          <div key={m.id} class="agent-msg user ext-user" data-ext-msg={m.id} data-ext-state={m.state}>
            <RichText text={m.text} />
            {m.context && <div class="ext-context" title={m.context.text}>with {m.context.docId.split('/').slice(2).join('/') || m.context.docId}{/selection/i.test(m.context.text) ? ' · your selection' : ''}</div>}
            {optionText(m.options) && <div class="ext-context" data-ext-options>{optionText(m.options)}</div>}
            <div class="ext-state">{stateText(m, agent)}{m.state === 'queued' && <> · <a href="#" onClick={e => { e.preventDefault(); cancel(m); }}>take back</a></>}{agent.runner?.busy === m.id && m.state === 'delivered' && <> · <a href="#" data-ext-stop onClick={e => { e.preventDefault(); stop(m); }}>stop</a></>}</div>
          </div>
        ) : (
          <div key={m.id} class={'agent-msg assistant ext-reply' + (m.state === 'progress' ? ' progress' : '')} data-ext-reply={m.id}>
            <RichText text={m.text} />
          </div>
        ))}
        {!listening && <ListenHint a={agent} />}
      </div>
      <div class="agent-compose">
        {pinText && <div class="ext-pin" data-ext-pin>About {pinText} <button class="mini" title="Do not send it" onClick={onUnpin}>×</button></div>}
        <textarea ref={inputRef} value={text} data-ext-input
          placeholder={`Message ${agent.name}… (Enter to send)`}
          onInput={e => setText((e.target as HTMLTextAreaElement).value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
        {backend && (
          <div class="row" data-runner-options>
            <select class="agent-select" data-runner-model title={`Model (Claude Code ${backend.version ?? ''} on ${agent.runner!.host})`} value={model} onChange={e => { const v = (e.target as HTMLSelectElement).value; setModel(v); store(key + '.model', v); }}>
              <option value="">Default model</option>
              {[...backend.models, ...(model && !backend.models.includes(model) ? [model] : [])].map(m => <option key={m} value={m}>{m}</option>)}
            </select>
            {backend.efforts.length > 0 && (
              <select class="agent-select" data-runner-effort title="Reasoning effort" value={effort} onChange={e => { const v = (e.target as HTMLSelectElement).value; setEffort(v); store(key + '.effort', v); }}>
                <option value="">Default effort</option>
                {backend.efforts.map(ef => <option key={ef} value={ef}>{ef}</option>)}
              </select>
            )}
            <span class="spacer" />
            <button class={'small-btn' + (fresh ? ' active' : '')} data-runner-fresh aria-pressed={fresh} title="The next message starts a new Claude Code conversation (otherwise it continues the last one)" onClick={() => setFresh(f => !f)}>New conversation</button>
          </div>
        )}
        <div class="row">
          {!pinText && (
            <label title="Send where you are along with the message: the document, and your selection quoted as LaTeX">
              <input type="checkbox" checked={withSelection} onChange={e => setWithSelection((e.target as HTMLInputElement).checked)} />
              With my selection
            </label>
          )}
          <span class="spacer" />
          <button class="small-btn" data-ext-send disabled={!text.trim() || busy} onClick={send}>Send</button>
        </div>
      </div>
    </div>
  );
}

/** No agent from elsewhere yet: how to connect one. */
export function NoExternalAgents() {
  return (
    <div class="ext-hint ext-none">
      <p>Agents on your own computer — Claude Code, Codex — can work on your projects here through the MCP connector, and you can write to them from this panel.</p>
      <p>Connect one with your account token (File ▸ Git repository…, <i>Local agents</i>), then ask it to <b>listen to OverLyX</b>.</p>
      <p>Or let this panel start Claude Code on your computer, with the model and effort you pick here: run <code class="ext-cmd">overlyx agent install</code> there once.</p>
    </div>
  );
}
