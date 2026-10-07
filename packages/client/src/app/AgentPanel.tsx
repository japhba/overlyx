/**
 * The Agent panel (right sidebar): OpenAI Codex embedded in OverLyX. Users sign in with their
 * own ChatGPT account (device code — the server keeps credentials per account, shared across
 * their projects, together with codex's memories). A thread runs in the project's directory on
 * the server; its transcript streams in over SSE (message/reasoning deltas, command output,
 * file-change diffs) and codex's approval requests are answered from here — with an optional
 * comment that steers the running turn. Model and reasoning effort come from codex's own list
 * and are sent per turn. Assistant text renders LaTeX through the math editor's MathJax path with
 * the open document's macros. Completed diffs collapse to a summary and only unfold by
 * themselves when they look important (small, or touching the open document); the transcript
 * follows the stream while you are at the bottom. Threads belong to the project: every editor
 * sees them, the one who started a thread drives it. A turn that changed files ends with a
 * checkpoint card (the server's agentwork.ts): what it changed, whether the PDF still builds,
 * and Undo — the turn's changes taken back exactly, edits made since kept. Agents connected from
 * elsewhere over MCP (Claude Code, Codex on the user's machine …) get tabs of their own at the top
 * (ExternalAgents.tsx): the owner writes to them here and reads their replies.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { api, type AgentStatus, type AgentLogin, type AgentThreadInfo, type AgentItem, type AgentChange, type AgentEventMsg, type AgentTurnContext, type AgentModel, type LitHit, type AgentCheckpoint, type AgentScope } from '../api';
import { editorContext } from '../editor/context';
import { bibRefs, type BibRef } from './bibrefs';
import { RichText, transcriptCopy } from './agentText';
import { uiConfirm } from './Dialogs';
import { useExternalAgents, ExternalAgentView, AgentChip, NoExternalAgents, ago } from './ExternalAgents';

interface Approval { requestId: string; method: string; params: any }

const errText = (e: unknown) => (e as Error)?.message ?? String(e);

const stored = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const store = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

/** The editor context sent with every message: the open documents and the current selection
 *  (the server turns it into LaTeX and marks it in an excerpt of the file). */
function selectionContext(): AgentTurnContext | undefined {
  const view = editorContext.activeView;
  const docId = (view?.dom.dataset.docId ?? editorContext.docId)?.replace(/^(text|pdf):/, '');
  if (!docId) return undefined;
  const ctx: AgentTurnContext = { docId };
  const open = editorContext.openDocs?.() ?? [];
  if (open.length) ctx.openDocs = open.slice(0, 8);
  const sel = view?.state.selection;
  if (sel && !sel.empty) {
    ctx.content = (sel.content().toJSON() as { content?: any[] } | null)?.content ?? [];
    ctx.layout = String(sel.$from.parent.attrs?.layout ?? 'Standard');
  } else {
    // a selection inside a formula is the math field's own, not ProseMirror's
    const f = editorContext.mathField;
    const msel = f?.cursor?.selection ? f.cursor.grabSelection() : '';
    if (msel) ctx.mathLatex = msel;
  }
  return ctx;
}

/** codex concatenates the turn's input items into ONE string when echoing/storing the user
 *  message, so the hidden editor-context block cannot be filtered as a separate part: strip the
 *  [context]…[/context] span from the joined text instead (and, for threads from before the
 *  terminator existed, the exact legacy header + optional selection fence). */
const CONTEXT_RE = /\[context\][\s\S]*?\[\/context\]\s*/g;
const LEGACY_CONTEXT_RE = /\[context\] The user is editing [^\n]*? in OverLyX\.(?:\nTheir current selection in that document:\n```latex\n[\s\S]*?\n?```)?\s*/g;
const userText = (it: AgentItem): string =>
  (it.content ?? []).map(c => c.text ?? '').join('\n').replace(CONTEXT_RE, '').replace(LEGACY_CONTEXT_RE, '').trim();

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

type Notify = (msg: string, kind?: 'info' | 'error') => void;

/** Author–year labels for bare DOI / arXiv references, resolved once per id. */
const hitCache = new Map<string, Promise<LitHit | null>>();
function resolveRef(doi: string): Promise<LitHit | null> {
  let p = hitCache.get(doi);
  if (!p) { p = api.literatureSearch(doi).then(r => r.hits[0] ?? null).catch(() => null); hitCache.set(doi, p); }
  return p;
}
/** "Vaswani et al. 2017" from a hit (surname of the first author). */
function hitLabel(h: LitHit): string | null {
  const first = h.authors[0];
  if (!first) return null;
  const surname = (first.includes(',') ? first.split(',')[0] : first.split(/\s+/).pop() ?? first).trim();
  if (!surname) return null;
  return surname + (h.authors.length > 1 ? ' et al.' : '') + (h.year ? ` ${h.year}` : '');
}

/** One reference spotted in an agent reply: a click adds it to the project's cited.bib.
 *  Shown as "Author et al. year" where known — bare ids are resolved through the literature
 *  search (which answers DOI / arXiv queries from doi.org) — with the raw id as a small chip. */
function AddBibButton({ r, project, notify }: { r: BibRef; project: string; notify: Notify }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [hit, setHit] = useState<LitHit | null>(null);
  useEffect(() => {
    let on = true;
    if (!r.bibtex && !r.nice && r.doi) void resolveRef(r.doi).then(h => { if (on) setHit(h); });
    return () => { on = false; };
  }, [r.doi, r.bibtex, r.nice]);
  const add = () => {
    if (state !== 'idle') return;
    setState('busy');
    const data = r.bibtex ? { bibtex: r.bibtex }
      : { hit: hit ?? { id: r.doi!, title: '', authors: [], year: null, venue: '', type: '', doi: r.doi!, arxiv: null, url: null, citations: null, sources: [] } };
    api.bibAdd(project, data)
      .then(res => { setState('done'); notify(res.existed ? `${res.key} was already in ${res.file}` : `Added ${res.key} to ${res.file}`); })
      .catch(e => { setState('idle'); notify(errText(e), 'error'); });
  };
  const nice = r.nice ?? (hit && hitLabel(hit)) ?? null;
  const chip = nice ? (r.kind === 'doi' ? 'doi' : r.label) : null;   // the raw identifier, small, after the name
  return (
    <button class="small-btn agent-bib-add" data-agent-bib={r.label} disabled={state !== 'idle'} onClick={add}
      title={(r.bibtex ? 'Add this BibTeX entry to the project’s cited.bib' : 'Fetch the BibTeX for this reference and add it to cited.bib') + (r.doi ? `\n${r.doi}` : '')}>
      {state === 'done' ? '✓ ' : '+ '}{nice ?? r.label}{chip && <span class="bib-kind">{chip}</span>}
    </button>
  );
}

/** The transcript entry for a turn that failed — nothing else shows why the agent did not answer. */
export const turnErrorItems = (turn: { id?: string; status?: string; error?: { message?: string } | null }): AgentItem[] =>
  turn.status === 'failed' && turn.error?.message ? [{ type: 'error', id: `error-${turn.id}`, text: turn.error.message }] : [];

function ItemView({ it, project, notify }: { it: AgentItem; project?: string; notify?: Notify }) {
  const [open, setOpen] = useState(false);
  switch (it.type) {
    case 'userMessage': {
      const t = userText(it);
      return t ? <div class="agent-msg user" data-agent="user"><RichText text={t} /></div> : null;
    }
    case 'agentMessage': {
      // references in the reply (BibTeX, DOIs, arXiv ids) get one-click buttons into cited.bib
      const refs = project && notify ? bibRefs(it.text ?? '') : [];
      return (
        <div class="agent-msg assistant" data-agent="assistant">
          <RichText text={it.text ?? ''} />
          {refs.length > 0 && <div class="agent-bib-row">{refs.map(r => <AddBibButton key={r.label} r={r} project={project!} notify={notify!} />)}</div>}
        </div>
      );
    }
    case 'reasoning': {
      const t = (it.summary ?? it.content ?? []).join('\n').trim();
      if (!t) return <div class="agent-item reasoning">Thinking…</div>;
      const toggle = () => { if (window.getSelection()?.isCollapsed !== false) setOpen(o => !o); };
      return <div class="agent-item reasoning" onClick={toggle} title="The agent's reasoning summary">{open ? <RichText text={t} /> : t.split('\n')[0].slice(0, 90) + (t.length > 90 ? ' …' : '')}</div>;
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
    case 'error':
      // a turn that failed (usage limit, expired sign-in…): codex's message, its links clickable
      return (
        <div class="agent-item error" data-agent="error" role="alert">
          {(it.text ?? '').split(/(https?:\/\/[^\s)]+[^\s).,])/).map((part, i) => i % 2 ? <a key={i} href={part} target="_blank" rel="noopener">{part}</a> : part)}
        </div>
      );
    default:
      return null;
  }
}

const cpItem = (cp: AgentCheckpoint): AgentItem => ({ type: 'overlyxCheckpoint', id: 'cp-' + cp.n, checkpoint: cp });
const baseName = (p: string) => p.split('/').slice(-2).join('/');

/** The message "Ask the agent to fix it" sends. */
export function fixRequest(cp: AgentCheckpoint): string {
  const broken = cp.builds.filter(b => b.broke);
  const errs = (b: AgentCheckpoint['builds'][number]) => (b.errors.length ? b.errors : ['(no error message in the log)']).map(e => '  ' + e).join('\n');
  return `The PDF no longer builds after your changes:\n${broken.map(b => `${b.doc}:\n${errs(b)}`).join('\n')}\nPlease fix it — or take your changes back with undo_turn if you cannot.`;
}

/**
 * The end of a turn that changed files: what it changed, whether the documents still build, and
 * the way back. `actions`: the viewer drives the thread and no turn is running.
 */
function CheckpointCard({ cp, actions, onUndo, onFix }: { cp: AgentCheckpoint; actions: boolean; onUndo: () => void; onFix: () => void }) {
  const broke = cp.builds.some(b => b.broke);
  return (
    <div class={`agent-checkpoint${broke && !cp.undone ? ' broke' : ''}${cp.undone ? ' undone' : ''}`} data-agent="checkpoint" data-n={cp.n}>
      <div class="files">
        {cp.undone ? 'Took back' : cp.finished ? 'Changed' : 'Changing'}{' '}
        {cp.files.map((f, i) => (
          <span key={f.path} class="file">
            {i > 0 && ', '}
            <b title={f.path}>{baseName(f.path)}</b>
            {f.created && ' (new)'}
            {!!(f.inserted || f.deleted) && <span class="stats"> <span class="add">+{f.inserted}</span> <span class="del">−{f.deleted}</span></span>}
          </span>
        ))}
      </div>
      {!cp.undone && cp.builds.map(b => (
        <div key={b.doc} class={`build ${b.status}${b.broke ? ' broke' : ''}`} data-agent-build={b.status} data-broke={b.broke ? '1' : '0'}>
          {b.status === 'building' ? `Checking that ${baseName(b.doc)} still builds…`
            : b.status === 'ok' ? `✓ ${baseName(b.doc)} builds${b.before === 'error' ? ' again' : ''}`
            : b.broke ? `⚠ ${baseName(b.doc)} no longer builds`
            : `${baseName(b.doc)} did not build before this turn either`}
          {b.status === 'error' && b.errors.length > 0 && <div class="errors">{b.errors.slice(0, 3).map(e => <div key={e}>{e}</div>)}</div>}
        </div>
      ))}
      {cp.undone?.kept.map(k => <div key={k.path} class="kept">{baseName(k.path)}: {k.why}</div>)}
      {actions && cp.finished && !cp.undone && (
        <div class="row">
          <button class="small-btn" data-agent-undo title="Take this turn's changes back: the files as they were before it, with everything edited since kept" onClick={onUndo}>Undo</button>
          {broke && <button class="small-btn" data-agent-fix onClick={onFix}>Ask the agent to fix it</button>}
        </div>
      )}
    </div>
  );
}

/** The tool arguments of an MCP elicitation (codex gating an MCP tool call), compactly. */
function ElicitParams({ meta }: { meta: any }) {
  const rows: { name?: string; display_name?: string; value?: unknown }[] | null = Array.isArray(meta?.tool_params_display) ? meta.tool_params_display : null;
  const obj = !rows && meta?.tool_params && typeof meta.tool_params === 'object' ? meta.tool_params as Record<string, unknown> : null;
  const entries: [string, unknown][] = rows ? rows.map(r => [String(r.display_name ?? r.name ?? ''), r.value] as [string, unknown]) : obj ? Object.entries(obj) : [];
  if (!entries.length) return null;
  const show = (v: unknown) => { const t = typeof v === 'string' ? v : JSON.stringify(v); return t.length > 400 ? t.slice(0, 400) + '…' : t; };
  return <div class="agent-item cmd">{entries.map(([k, v]) => <div class="line" key={k}>{k}: {show(v)}</div>)}</div>;
}

/** The diff + accept view of a pending approval, with an optional comment back to the agent. */
function ApprovalCard({ a, onDecide }: { a: Approval; onDecide: (d: string, feedback: string) => void }) {
  const [fb, setFb] = useState('');
  const p = a.params ?? {};
  const isCmd = /commandExecution|execCommand/.test(a.method);
  const isElicit = /elicitation/.test(a.method);
  return (
    <div class="agent-approval" data-agent="approval">
      <div class="what">
        <b>{isCmd ? 'Run this command?' : isElicit ? (p.message || 'Allow this tool call?') : 'Apply these changes?'}</b>
        {p.reason && <div class="reason">{p.reason}</div>}
        {!isCmd && !isElicit && (p.changes ?? []).some((c: { path?: string }) => c.path?.endsWith('.tex')) && (
          <div class="reason">⚠ A direct file write — it bypasses Track Changes. Deny (with a note) to make the agent propose it as a reviewable tracked edit instead.</div>
        )}
        {isCmd ? <div class="agent-item cmd"><div class="line">$ {p.command}</div></div> : isElicit ? <ElicitParams meta={p._meta} /> : <Diff changes={p.changes ?? []} />}
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

function CodexPanel({ project, notify, pinned, onUnpin }: { project: string; notify: (msg: string, kind?: 'info' | 'error') => void; pinned: AgentTurnContext | null; onUnpin: () => void }) {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [login, setLogin] = useState<AgentLogin | null>(null);
  const [threads, setThreads] = useState<AgentThreadInfo[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [mine, setMine] = useState(true);
  const [items, setItems] = useState<AgentItem[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [busyTurn, setBusyTurn] = useState<string | null>(null);
  /** the running turn's checkpoint (shown below the transcript until the turn is over) */
  const [liveCp, setLiveCpState] = useState<AgentCheckpoint | null>(null);
  const liveCpRef = useRef<AgentCheckpoint | null>(null);
  const setLiveCp = (cp: AgentCheckpoint | null) => { liveCpRef.current = cp; setLiveCpState(cp); };
  const [text, setText] = useState('');
  const [models, setModels] = useState<AgentModel[]>([]);
  const [model, setModel] = useState(stored('ol.agent.model') ?? '');
  const [effort, setEffort] = useState(stored('ol.agent.effort') ?? '');
  /** the agent's document edits as tracked changes (the default) or straight into the text */
  const [tracked, setTracked] = useState(stored('ol.agent.tracked') !== '0');
  /** what the agent may read: all the user's projects (the default) or only this one — a new
   *  thread takes the last choice, an open thread shows (and changes) its own */
  const [scope, setScope] = useState<AgentScope>(stored('ol.agent.scope') === 'project' ? 'project' : 'all');
  const selRef = useRef(sel); selRef.current = sel;
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (pinned) inputRef.current?.focus(); }, [pinned]);
  const stick = useRef(true);   // follow the stream while the user is at the bottom

  const refreshStatus = () => api.agentStatus().then(setStatus).catch(e => { setStatus({ enabled: false, authenticated: false }); notify(errText(e), 'error'); });
  const refreshThreads = () => api.agentThreads(project).then(r => setThreads(r.threads)).catch(() => { /* no access yet */ });

  useEffect(() => { void refreshStatus(); }, []);
  useEffect(() => {
    setSel(null); setItems([]); setApprovals([]); setLiveCp(null);
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
    // after a dropped stream (laptop sleep, a server restart mid-deploy) events were missed:
    // when the browser reconnects, reload the open thread instead of showing a frozen transcript
    let lost = false;
    es.onerror = () => { lost = true; };
    es.onopen = () => {
      if (!lost) return;
      lost = false;
      void refreshStatus(); void refreshThreads();
      if (selRef.current) syncThread(selRef.current).catch(() => { /* the next events tell more */ });
    };
    es.onmessage = (e) => {
      let msg: AgentEventMsg;
      try { msg = JSON.parse(e.data); } catch { return; }
      const p = msg.params ?? {};
      if (msg.kind === 'checkpoint') {
        if (p.threadId === selRef.current && p.checkpoint) showCheckpoint(p.checkpoint as AgentCheckpoint);
        return;
      }
      if (msg.kind === 'request') {
        // re-delivered after a reconnect (the keeper replays unanswered approvals): count once
        if (p.threadId === selRef.current && msg.requestId) setApprovals(a => a.some(x => x.requestId === msg.requestId) ? a : [...a, { requestId: msg.requestId!, method: msg.method ?? '', params: p }]);
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
        case 'turn/completed': setBusyTurn(null); setApprovals([]); turnErrorItems(p.turn ?? {}).forEach(upsert); void refreshThreads(); break;
        case 'error':
          // codex reports its retries ("Reconnecting... 2/5") as errors too — the turn goes on
          if (p.willRetry) break;
          setBusyTurn(null);
          if (p.turnId && p.error?.message) upsert({ type: 'error', id: `error-${p.turnId}`, text: p.error.message });
          else notify(p.error?.message ?? 'The agent reported an error', 'error');
          break;
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

  /** A checkpoint arrived: the running turn's shows below the transcript; a finished one takes its
   *  place in it (after its turn's items — the turn just ended), or is updated where it is. */
  const showCheckpoint = (cp: AgentCheckpoint) => {
    const put = (c: AgentCheckpoint) => setItems(list => {
      const i = list.findIndex(x => x.id === 'cp-' + c.n);
      return i >= 0 ? [...list.slice(0, i), cpItem(c), ...list.slice(i + 1)] : [...list, cpItem(c)];
    });
    const live = liveCpRef.current;
    if (!cp.finished) {
      if (live && live.n !== cp.n) put(live);   // (taken back mid-turn: the turn goes on in a new checkpoint)
      setLiveCp(cp);
      return;
    }
    if (live && live.n === cp.n) setLiveCp(null);
    put(cp);
  };

  /** (Re)load a thread from the server: items, whether a turn is running, pending approvals —
   *  used on open and to resync after the events stream reconnected (laptop sleep, a deploy). */
  const syncThread = (tid: string) => api.agentThread(project, tid).then(r => {
    const cps = r.checkpoints ?? [];
    const done = cps.filter(c => c.finished || c.undone);
    const list = r.thread.turns.flatMap(turn => [...turn.items, ...turnErrorItems(turn), ...done.filter(c => c.turnId === turn.id).map(cpItem)]);
    const placed = new Set(list.map(x => x.id));
    setItems([...list, ...done.filter(c => !placed.has('cp-' + c.n)).map(cpItem)]);
    setLiveCp(cps.find(c => !c.finished && !c.undone) ?? null);
    setMine(r.mine);
    if (r.scope) setScope(r.scope);
    setApprovals((r.approvals ?? []).map(a => ({ requestId: a.requestId, method: a.method, params: a.params })));
    const last = r.thread.turns[r.thread.turns.length - 1] as { id?: string; status?: string } | undefined;
    setBusyTurn(last?.status === 'inProgress' ? last.id ?? null : null);
  });

  const openThread = (t: AgentThreadInfo) => {
    setSel(t.id); setMine(t.mine); setItems([]); setApprovals([]); setLiveCp(null); stick.current = true;
    store('ol.agent.sel:' + project, t.id);
    syncThread(t.id).catch(e => notify(errText(e), 'error'));
  };

  const undo = async (cp: AgentCheckpoint) => {
    const tid = selRef.current;
    if (!tid || !(await uiConfirm('Undo Turn', `Take back the changes of this turn (${cp.files.map(f => baseName(f.path)).join(', ')})? Whatever was edited since stays.`, { okLabel: 'Undo' }))) return;
    api.agentUndo(project, tid, cp.n)
      .then(r => { showCheckpoint(r.checkpoint); if (r.kept.length) notify(`Taken back, except: ${r.kept.map(k => `${baseName(k.path)} — ${k.why}`).join('; ')}`); })
      .catch(e => notify(errText(e), 'error'));
  };

  const send = (fixed?: string) => {
    const t = (fixed ?? text).trim();
    if (!t) return;
    stick.current = true;
    const localItem: AgentItem = { type: 'userMessage', id: 'local-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6), content: [{ type: 'text', text: t }] };
    // while a turn runs, the composer steers it instead of queueing a new turn
    if (busyTurn && busyTurn !== 'pending' && selRef.current) {
      if (fixed === undefined) setText('');
      setItems(list => [...list, localItem]);
      void api.agentSteer(project, selRef.current, busyTurn, t, localItem.id, pinned ?? selectionContext()).catch(e => notify(errText(e), 'error'));
      onUnpin();
      return;
    }
    if (busyTurn) return;
    const context = pinned ?? selectionContext();
    onUnpin();
    if (fixed === undefined) setText('');
    void (async () => {
      try {
        let tid = selRef.current;
        if (!tid) { const r = await api.agentStartThread(project, scope); tid = r.id; setSel(tid); setMine(true); setItems([]); store('ol.agent.sel:' + project, tid); void refreshThreads(); }
        setItems(list => [...list, localItem]);
        setBusyTurn('pending');
        await api.agentTurn(project, tid, { text: t, context, clientMessageId: localItem.id, tracked, scope, ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
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
        <div class="agent-scroll" ref={scrollRef} onScroll={onScroll} onCopy={transcriptCopy}>
          {items.map(it => it.type === 'overlyxCheckpoint' && it.checkpoint
            ? <CheckpointCard key={it.id} cp={it.checkpoint} actions={mine && !busyTurn} onUndo={() => undo(it.checkpoint!)} onFix={() => send(fixRequest(it.checkpoint!))} />
            : <ItemView key={it.id} it={it} project={project} notify={notify} />)}
          {liveCp && <CheckpointCard cp={liveCp} actions={false} onUndo={() => undefined} onFix={() => undefined} />}
          {approvals.map(a => <ApprovalCard key={a.requestId} a={a} onDecide={(d, fb) => decide(a, d, fb)} />)}
          {busyTurn && !approvals.length && <div class="agent-item reasoning" data-agent="busy">Working…</div>}
        </div>
      )}
      {(!sel || mine) && (
        <div class="agent-compose">
          {pinned && <div class="ext-pin" data-ext-pin>About the passage you pinned <button class="mini" title="Do not send it" onClick={onUnpin}>×</button></div>}
          <textarea
            ref={inputRef}
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
            <label data-agent-scope-label title={scope === 'project'
                ? 'The agent reads only this project: its overlyx tools refuse every other one, and its commands only ever see this project’s files'
                : 'The agent may read all your projects, and those shared with you, through its overlyx tools (to look something up in another paper, say); its commands only ever see this project’s files. Projects you cannot open are never within its reach'}>
              Reads
              <select class="agent-select" data-agent-scope value={scope}
                onChange={e => {
                  const v = (e.target as HTMLSelectElement).value === 'project' ? 'project' : 'all';
                  setScope(v); store('ol.agent.scope', v);
                  // an open thread changes at once: the agent's next tool call already keeps to it
                  if (sel && mine) void api.agentSetScope(project, sel, v).catch(err => notify(errText(err), 'error'));
                }}>
                <option value="all">All my projects</option>
                <option value="project">This project only</option>
              </select>
            </label>
            <label data-agent-tracked title={tracked ? 'The agent’s edits to documents arrive as tracked changes you accept or reject — untick to let it edit the text directly (a turn can still be taken back)' : 'The agent edits the documents directly, without tracked changes (a turn can still be taken back) — tick to review its edits as tracked changes'}>
              <input type="checkbox" checked={tracked} onChange={e => { const v = (e.target as HTMLInputElement).checked; setTracked(v); store('ol.agent.tracked', v ? '1' : '0'); }} />
              Track changes
            </label>
            <span class="spacer" />
            {busyTurn && busyTurn !== 'pending' && sel && <button class="small-btn" data-agent-stop onClick={() => void api.agentInterrupt(project, sel, busyTurn).catch(e => notify(errText(e), 'error'))}>Stop</button>}
            <button class="small-btn" data-agent-send disabled={!text.trim() || busyTurn === 'pending'} onClick={() => send()}>{busyTurn && busyTurn !== 'pending' ? 'Steer' : 'Send'}</button>
          </div>
        </div>
      )}
      {sel && !mine && <div class="agent-readonly">Started by {threads.find(t => t.id === sel)?.user.name ?? 'another editor'} — you can read it, not drive it.</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ the panel: the embedded agent and the agents from elsewhere */

/** a passage pinned with "Ask agent about this" before the panel was showing (taken by the panel when it mounts) */
let pendingPin: AgentTurnContext | null = null;
const PIN_EVENT = 'ol:ask-agent';

/**
 * "Ask agent about this" (the editor's right-click menu; App.tsx sets editorContext.askAgent): the
 * current selection is pinned as the context of the next message to whichever agent the panel
 * shows, and its composer takes the keyboard.
 */
export function askAgentAbout(): void {
  pendingPin = selectionContext() ?? null;
  window.dispatchEvent(new CustomEvent(PIN_EVENT));
}

/**
 * The Agent panel: the embedded agent (Codex on the server — when AI assistance is on, `codex`) and
 * the account's agents connected from elsewhere (ExternalAgents.tsx), one at a time, chosen in a
 * row of tabs at the top (kept per browser).
 */
export function AgentPanel({ project, notify, codex }: { project: string; notify: (msg: string, kind?: 'info' | 'error') => void; codex: boolean }) {
  const ext = useExternalAgents();
  const [which, setWhich] = useState<string>(() => stored('ol.agent.which') ?? '');
  const [pinned, setPinned] = useState<AgentTurnContext | null>(null);
  const [focusKey, setFocusKey] = useState(0);
  useEffect(() => {
    const take = () => { if (pendingPin) { setPinned(pendingPin); pendingPin = null; } setFocusKey(k => k + 1); };
    if (pendingPin) take();
    window.addEventListener(PIN_EVENT, take);
    return () => window.removeEventListener(PIN_EVENT, take);
  }, []);
  const choose = (w: string) => { setWhich(w); store('ol.agent.which', w); };
  const current = which.startsWith('ext:') ? ext.agents.find(a => `ext:${a.id}` === which) ?? null : null;
  // nothing chosen (or the choice is gone): the embedded agent, else the agent from elsewhere seen last
  const shown = current ? which : codex ? 'codex' : ext.agents[0] ? `ext:${ext.agents[0].id}` : '';
  const agent = shown.startsWith('ext:') ? ext.agents.find(a => `ext:${a.id}` === shown) ?? null : null;
  return (
    <div class="agent-wrap">
      {ext.agents.length > 0 && (
        <div class="agent-switch" role="tablist">
          {codex && <button role="tab" class={shown === 'codex' ? 'active' : ''} data-agent-tab="codex" title="OpenAI Codex, running on this server with your ChatGPT account" onClick={() => choose('codex')}>Codex (built in)</button>}
          {ext.agents.map(a => (
            <button key={a.id} role="tab" class={shown === `ext:${a.id}` ? 'active' : ''} data-agent-tab={`ext:${a.id}`} title={`${a.label} — ${a.status === 'offline' ? 'last seen ' + ago(a.lastSeen) : a.status}`} onClick={() => choose(`ext:${a.id}`)}>
              <AgentChip a={a} />
            </button>
          ))}
        </div>
      )}
      {shown === 'codex' ? <CodexPanel project={project} notify={notify} pinned={pinned} onUnpin={() => setPinned(null)} />
        : agent ? <ExternalAgentView agent={agent} notify={notify} onMessage={ext.onMessage} resync={ext.resync} pinned={pinned} onUnpin={() => setPinned(null)} contextOf={selectionContext} focusKey={focusKey} />
        : <div class="agent-panel"><NoExternalAgents /></div>}
    </div>
  );
}
