/**
 * The model picker of the Agent panel (AgentPanel.tsx) and of the inline AI (⌘J rewrite,
 * editor/ai/rewrite.ts, and Settings ▸ AI: InlineModelPicker): every model of every provider the
 * account has connected, grouped under the provider and who is signed in there (with Sign out /
 * Remove key) — for the inline AI the server's own models first (OverLyX, included) — then, in
 * italics, the providers not connected yet: Sign in with ChatGPT…, and the API keys (OpenAI,
 * Anthropic, OpenRouter) through KeyDialog. A conversation stays with the provider it started on;
 * picking a model of another provider starts a new thread (the panel says so).
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { api, type AgentLogin, type AgentModel, type AgentProvider, type AgentStatus } from '../api';
import { Dialog, uiConfirm } from './Dialogs';

export type KeyProvider = Exclude<AgentProvider, 'chatgpt'>;
/** a picker's providers: the account's — and for the inline AI the server's own key (`overlyx`) */
export type PickerProvider = AgentProvider | 'overlyx';
export type PickerModel = Omit<AgentModel, 'provider'> & { provider?: PickerProvider };

/** the picker's order: the sign-in first, then the keys */
export const PROVIDER_ORDER: AgentProvider[] = ['chatgpt', 'anthropic', 'openai', 'openrouter'];
export const PROVIDER_LABEL: Record<PickerProvider, string> = { overlyx: 'OverLyX', chatgpt: 'ChatGPT', openai: 'OpenAI API', openrouter: 'OpenRouter', anthropic: 'Anthropic API' };
/** what the agent runs as on each provider (shown under the provider in the menu) */
const ENGINE: Record<PickerProvider, string> = { overlyx: 'included', chatgpt: 'Codex', openai: 'Codex', openrouter: 'Codex', anthropic: 'Claude Code' };
const CONNECT_LABEL: Record<AgentProvider, string> = {
  chatgpt: 'Sign in with ChatGPT…',
  anthropic: 'Use an Anthropic API key…',
  openai: 'Use an OpenAI API key…',
  openrouter: 'Use an OpenRouter key…',
};
const CONNECT_NOTE: Partial<Record<AgentProvider, string>> = {
  anthropic: 'Claude — Max and Team plans include monthly API credits',
  openrouter: 'Claude, Gemini, GPT, DeepSeek and more, on one key',
};

export const providerOf = (m: Pick<PickerModel, 'provider'>): PickerProvider => m.provider ?? 'chatgpt';
/** a model as the choice is stored: `provider:id` (choices from before providers: a bare id — the panel's ChatGPT model, the inline AI's OpenRouter id on the server's key) */
export const modelKey = (m: Pick<PickerModel, 'id' | 'provider'>) => `${providerOf(m)}:${m.id}`;
export function parseModelKey(s: string | null, bare: PickerProvider = 'chatgpt'): { provider: PickerProvider; id: string } | null {
  if (!s) return null;
  const i = s.indexOf(':');
  const p = s.slice(0, i) as PickerProvider;
  return i > 0 && (PROVIDER_ORDER as string[]).concat('overlyx').includes(p) ? { provider: p, id: s.slice(i + 1) } : { provider: bare, id: s };
}

export const connectedProviders = (status: AgentStatus | null): AgentProvider[] =>
  PROVIDER_ORDER.filter(p => status?.providers ? !!status.providers[p]?.connected : p === 'chatgpt' && !!status?.authenticated);
/** the providers this server offers that the account has not connected */
export const missingProviders = (status: AgentStatus | null): AgentProvider[] =>
  PROVIDER_ORDER.filter(p => !connectedProviders(status).includes(p) && (p === 'chatgpt' || (!!status?.providers && status.providers[p]?.available !== false)));

/** who is signed in at a provider, as the menu's group heading says it */
export function providerWho(p: PickerProvider, status: AgentStatus | null): string {
  if (p === 'overlyx') return '';
  const s = status?.providers?.[p];
  if (p === 'chatgpt') { const a = s?.account ?? status?.account; return a?.email ? `${a.email}${a.plan ? ` (${a.plan})` : ''}` : ''; }
  return s?.hint ? `key ${s.hint}` : '';
}

/** The connect buttons of the providers not connected yet: in the menu (italic rows) and on the panel's first screen. */
export function ConnectRows({ providers, onConnect, buttons }: { providers: AgentProvider[]; onConnect: (p: AgentProvider) => void; buttons?: boolean }) {
  return (
    <>
      {providers.map(p => buttons ? (
        <button key={p} class="small-btn agent-connect" data-agent-connect={p} {...(p === 'chatgpt' ? { 'data-agent-login': '' } : {})} onClick={() => onConnect(p)}>
          {CONNECT_LABEL[p]}{CONNECT_NOTE[p] && <span class="note">{CONNECT_NOTE[p]}</span>}
        </button>
      ) : (
        <button key={p} role="menuitem" class="agent-mp-item connect" data-agent-connect={p} onClick={() => onConnect(p)}>
          <span class="label">{CONNECT_LABEL[p]}</span>
          {CONNECT_NOTE[p] && <span class="note">{CONNECT_NOTE[p]}</span>}
        </button>
      ))}
    </>
  );
}

export function ModelPicker({ models, status, value, onChange, onConnect, onDisconnect, placement = 'up' }: {
  models: PickerModel[];
  status: AgentStatus | null;
  /** the chosen model's key (modelKey) */
  value: string;
  onChange: (m: PickerModel) => void;
  onConnect: (p: AgentProvider) => void;
  onDisconnect: (p: AgentProvider) => void;
  /** where the menu opens: above the button (the panel's composer) or below it (the ⌘J prompt) */
  placement?: 'up' | 'down';
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); wrap.current?.querySelector<HTMLButtonElement>('[data-agent-model]')?.focus(); } };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', esc, true);
    // the chosen model in view
    wrap.current?.querySelector('.agent-mp-item.on')?.scrollIntoView({ block: 'nearest' });
    return () => { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', esc, true); };
  }, [open]);
  const connected: PickerProvider[] = [...(models.some(m => providerOf(m) === 'overlyx') ? ['overlyx' as const] : []), ...connectedProviders(status)];
  const missing = status?.enabled ? missingProviders(status) : [];
  const cur = models.find(m => modelKey(m) === value);
  const several = new Set(models.map(providerOf)).size > 1;
  const pick = (m: PickerModel) => { setOpen(false); onChange(m); };
  const act = (f: () => void) => { setOpen(false); f(); };
  /** arrow keys walk the menu's items */
  const onMenuKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...(wrap.current?.querySelectorAll<HTMLButtonElement>('.agent-mp-menu button') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  };
  return (
    <span class="agent-mp" ref={wrap}>
      <button class="agent-mp-btn" data-agent-model aria-haspopup="menu" aria-expanded={open}
        title={cur ? `${cur.label} — ${PROVIDER_LABEL[providerOf(cur)]}${cur.description ? `\n${cur.description}` : ''}` : 'Choose a model'}
        onClick={() => setOpen(o => !o)}>
        <span class="label">{cur?.label ?? 'Choose a model'}</span>
        {cur && several && <span class="prov">{PROVIDER_LABEL[providerOf(cur)]}</span>}
        <span class="chev" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div class={`agent-mp-menu${placement === 'down' ? ' down' : ''}`} role="menu" onKeyDown={onMenuKey}>
          {connected.map(p => {
            const list = models.filter(m => providerOf(m) === p);
            const who = providerWho(p, status);
            return (
              <div key={p} class="agent-mp-group" data-agent-provider={p}>
                <div class="agent-mp-head">
                  <span class="name">{PROVIDER_LABEL[p]}</span>
                  <span class="who" title={`${ENGINE[p]}${who ? ` · ${who}` : ''}`}>{ENGINE[p]}{who && ` · ${who}`}</span>
                  {p !== 'overlyx' && <button class="agent-mp-out" data-agent-disconnect={p} title={p === 'chatgpt' ? 'Sign this ChatGPT account out of the agent' : 'Forget this key (OverLyX deletes it)'}
                    onClick={() => act(() => onDisconnect(p))}>{p === 'chatgpt' ? 'Sign out' : 'Remove'}</button>}
                </div>
                {list.map(m => (
                  <button key={modelKey(m)} role="menuitemradio" aria-checked={modelKey(m) === value} class={`agent-mp-item${modelKey(m) === value ? ' on' : ''}`}
                    data-agent-model-option={modelKey(m)} title={m.description || m.id} onClick={() => pick(m)}>
                    <span class="tick" aria-hidden="true">{modelKey(m) === value ? '✓' : ''}</span>
                    <span class="label">{m.label}</span>
                  </button>
                ))}
                {!list.length && <div class="agent-mp-none">No models listed right now</div>}
              </div>
            );
          })}
          {missing.length > 0 && (
            <div class="agent-mp-group connect">
              <ConnectRows providers={missing} onConnect={p => act(() => onConnect(p))} />
            </div>
          )}
        </div>
      )}
    </span>
  );
}

const KEY_HELP: Record<KeyProvider, { where: string; url: string; then: string }> = {
  anthropic: {
    where: 'platform.claude.com ▸ API keys', url: 'https://platform.claude.com/settings/keys',
    then: 'Threads on it run in Claude Code. With a Claude Max or Team plan, link a Console organization in claude.ai ▸ Settings ▸ Billing and make the key in that organization: the plan’s monthly API credits pay for it.',
  },
  openai: {
    where: 'platform.openai.com ▸ API keys', url: 'https://platform.openai.com/api-keys',
    then: 'Threads on it run in Codex, with the models of your OpenAI account, billed to it.',
  },
  openrouter: {
    where: 'openrouter.ai ▸ Keys', url: 'https://openrouter.ai/settings/keys',
    then: 'Threads on it run in Codex with the model you choose — Claude, Gemini, GPT, DeepSeek and more — billed by OpenRouter. (No web search on OpenRouter.)',
  },
};

/** Paste an API key: checked with the provider by the server, kept encrypted for the account. */
export function KeyDialog({ provider, onDone, onClose }: { provider: KeyProvider; onDone: () => void; onClose: () => void }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const help = KEY_HELP[provider];
  const save = () => {
    if (!key.trim() || busy) return;
    setBusy(true); setErr('');
    api.agentSetKey(provider, key.trim()).then(() => { setBusy(false); onDone(); }).catch(e => { setBusy(false); setErr((e as Error)?.message ?? String(e)); });
  };
  return (
    <Dialog title={`${PROVIDER_LABEL[provider]} key`} onClose={onClose}
      buttons={<>
        <button class="btn primary" data-agent-key-save disabled={!key.trim() || busy} onClick={save}>{busy ? 'Checking…' : 'Use this key'}</button>
      </>}>
      <div class="agent-key-dialog">
        <p>Paste an API key from <a href={help.url} target="_blank" rel="noopener noreferrer">{help.where}</a>. {help.then}</p>
        <input type="password" autocomplete="off" spellcheck={false} autofocus data-agent-key placeholder="API key" value={key}
          onInput={e => setKey((e.target as HTMLInputElement).value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); save(); } }} />
        {err && <p class="err" role="alert">{err}</p>}
        <p class="muted">OverLyX checks the key with {PROVIDER_LABEL[provider].replace(/ API$/, '')} and keeps it encrypted for your account (all your projects). The agent never sees it: its requests go through OverLyX, which adds the key. Remove it any time from this menu.</p>
      </div>
    </Dialog>
  );
}

/** Sign in with ChatGPT from outside the Agent panel (the inline AI's picker): the device code, until the sign-in is through. */
export function ChatGptLoginDialog({ onDone, onClose }: { onDone: () => void; onClose: () => void }) {
  const [login, setLogin] = useState<AgentLogin | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api.agentLogin().then(setLogin).catch(e => setErr((e as Error)?.message ?? String(e))); }, []);
  useEffect(() => {
    if (!login) return;
    const t = window.setInterval(() => { api.agentStatus().then(s => { if (s.providers?.chatgpt?.connected) { window.clearInterval(t); onDone(); } }).catch(() => { /* next time */ }); }, 2000);
    return () => window.clearInterval(t);
  }, [login]);
  const close = () => { if (login) void api.agentLoginCancel(login.loginId).catch(() => { /* gone */ }); onClose(); };
  return (
    <Dialog title="Sign in with ChatGPT" onClose={close}>
      <div class="agent-key-dialog">
        {err ? <p class="err" role="alert">{err}</p> : !login ? <p class="muted">Starting the sign-in…</p> : <>
          <p>Open <a href={login.verificationUrl} target="_blank" rel="noreferrer">{login.verificationUrl.replace(/^https?:\/\//, '')}</a> and enter:</p>
          <div class="agent-signin"><div class="code" data-agent-code>{login.userCode}</div></div>
          <p class="muted">Waiting for the sign-in to finish… It is kept for your account (all your projects), and the Agent panel uses it too.</p>
        </>}
      </div>
    </Dialog>
  );
}

/** the inline AI's server models (editorContext.ai, the server's /ai/status) */
export interface ServerModels { model: string; models: { id: string; label: string; note: string; aa?: number; speed: string }[] }

let ownModels: { at: number; p: Promise<{ status: AgentStatus | null; models: PickerModel[] }> } | null = null;
/** the account's providers and their models (the Agent panel's), shared by the inline pickers for a minute */
function loadOwn(fresh = false): Promise<{ status: AgentStatus | null; models: PickerModel[] }> {
  if (!fresh && ownModels && Date.now() - ownModels.at < 60_000) return ownModels.p;
  const p = api.agentStatus().then(async status => ({ status, models: status.authenticated ? (await api.agentModels().catch(() => ({ models: [] }))).models as PickerModel[] : [] }))
    .catch(() => ({ status: null, models: [] as PickerModel[] }));
  ownModels = { at: Date.now(), p };
  return p;
}
/** Whether the account has a provider of its own for the inline AI (works without the server's key); loads it once when unknown. */
export async function ownInlineAi(): Promise<boolean> { return !!(await loadOwn()).status?.authenticated; }

let lastLabels = new Map<string, string>();
/** A model's name for a stored choice (`provider:id` or a bare OpenRouter id), as the last picker listed it. */
export const inlineModelLabel = (key: string): string | undefined => lastLabels.get(key) ?? lastLabels.get(`overlyx:${key}`);

/**
 * The inline AI's model picker (⌘J, Settings ▸ AI): the server's own models — OverLyX, included —
 * then the account's providers, as in the Agent panel. `value`: the stored choice ('' = the server's
 * default; a bare id = an OpenRouter id on the server's key); `onChange` gets `provider:id`.
 */
export function InlineModelPicker({ server, value, onChange, placement = 'down' }: { server: ServerModels | null; value: string; onChange: (key: string) => void; placement?: 'up' | 'down' }) {
  const [own, setOwn] = useState<{ status: AgentStatus | null; models: PickerModel[] }>({ status: null, models: [] });
  const [dialog, setDialog] = useState<AgentProvider | null>(null);
  const refresh = (fresh = false) => { void loadOwn(fresh).then(setOwn); };
  useEffect(() => refresh(), []);
  const serverList: PickerModel[] = (server?.models ?? []).map(m => ({
    id: m.id, label: m.label, description: `${m.note} — AA ${m.aa ?? '?'} · ${m.speed}`, efforts: [], defaultEffort: null, isDefault: m.id === server?.model, provider: 'overlyx',
  }));
  if (server?.model && !serverList.some(m => m.id === server.model)) serverList.unshift({ id: server.model, label: server.model, description: 'the server’s default', efforts: [], defaultEffort: null, isDefault: true, provider: 'overlyx' });
  const models = [...serverList, ...own.models];
  const parsed = parseModelKey(value || (server?.model ? `overlyx:${server.model}` : ''), 'overlyx');
  const key = parsed ? `${parsed.provider}:${parsed.id}` : '';
  // a choice that is no longer listed (a removed key, a typed-in OpenRouter id) stays visible as it is
  if (parsed && !models.some(m => modelKey(m) === key)) models.push({ id: parsed.id, label: parsed.id, description: '', efforts: [], defaultEffort: null, isDefault: false, provider: parsed.provider });
  lastLabels = new Map(models.map(m => [modelKey(m), m.label]));
  const disconnect = async (p: AgentProvider) => {
    if (!(await uiConfirm(p === 'chatgpt' ? 'Sign Out' : 'Remove Key', p === 'chatgpt' ? 'Sign this ChatGPT account out of OverLyX’s AI (the Agent panel too)?' : `Remove your ${PROVIDER_LABEL[p]} key from OverLyX?`, { okLabel: p === 'chatgpt' ? 'Sign out' : 'Remove', danger: p !== 'chatgpt' }))) return;
    await (p === 'chatgpt' ? api.agentLogout() : api.agentRemoveKey(p)).catch(() => undefined);
    refresh(true);
  };
  const done = () => { setDialog(null); refresh(true); };
  return (
    <>
      <ModelPicker models={models} status={own.status} value={key} placement={placement} onChange={m => onChange(modelKey(m))} onConnect={p => setDialog(p)} onDisconnect={p => void disconnect(p)} />
      {dialog && createPortal(dialog === 'chatgpt'
        ? <ChatGptLoginDialog onDone={done} onClose={() => setDialog(null)} />
        : <KeyDialog provider={dialog} onDone={done} onClose={() => setDialog(null)} />, document.body)}
    </>
  );
}
