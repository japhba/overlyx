/**
 * The Agent panel's model picker (AgentPanel.tsx): every model of every provider the account has
 * connected, grouped under the provider and who is signed in there (with Sign out / Remove key),
 * then — in italics — the providers not connected yet: Sign in with ChatGPT…, and the API keys
 * (OpenAI, Anthropic, OpenRouter) through KeyDialog. A conversation stays with the provider it
 * started on; picking a model of another provider starts a new thread (the panel says so).
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { api, type AgentModel, type AgentProvider, type AgentStatus } from '../api';
import { Dialog } from './Dialogs';

export type KeyProvider = Exclude<AgentProvider, 'chatgpt'>;

/** the picker's order: the sign-in first, then the keys */
export const PROVIDER_ORDER: AgentProvider[] = ['chatgpt', 'anthropic', 'openai', 'openrouter'];
export const PROVIDER_LABEL: Record<AgentProvider, string> = { chatgpt: 'ChatGPT', openai: 'OpenAI API', openrouter: 'OpenRouter', anthropic: 'Anthropic API' };
/** what the agent runs as on each provider (shown under the provider in the menu) */
const ENGINE: Record<AgentProvider, string> = { chatgpt: 'Codex', openai: 'Codex', openrouter: 'Codex', anthropic: 'Claude Code' };
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

export const providerOf = (m: Pick<AgentModel, 'provider'>): AgentProvider => m.provider ?? 'chatgpt';
/** a model as the panel stores the choice: `provider:id` (choices from before providers: a bare id, the ChatGPT sign-in's) */
export const modelKey = (m: Pick<AgentModel, 'id' | 'provider'>) => `${providerOf(m)}:${m.id}`;
export function parseModelKey(s: string | null): { provider: AgentProvider; id: string } | null {
  if (!s) return null;
  const i = s.indexOf(':');
  const p = s.slice(0, i) as AgentProvider;
  return i > 0 && PROVIDER_ORDER.includes(p) ? { provider: p, id: s.slice(i + 1) } : { provider: 'chatgpt', id: s };
}

export const connectedProviders = (status: AgentStatus | null): AgentProvider[] =>
  PROVIDER_ORDER.filter(p => status?.providers ? !!status.providers[p]?.connected : p === 'chatgpt' && !!status?.authenticated);
/** the providers this server offers that the account has not connected */
export const missingProviders = (status: AgentStatus | null): AgentProvider[] =>
  PROVIDER_ORDER.filter(p => !connectedProviders(status).includes(p) && (p === 'chatgpt' || (!!status?.providers && status.providers[p]?.available !== false)));

/** who is signed in at a provider, as the menu's group heading says it */
export function providerWho(p: AgentProvider, status: AgentStatus | null): string {
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

export function ModelPicker({ models, status, value, onChange, onConnect, onDisconnect }: {
  models: AgentModel[];
  status: AgentStatus | null;
  /** the chosen model's key (modelKey) */
  value: string;
  onChange: (m: AgentModel) => void;
  onConnect: (p: AgentProvider) => void;
  onDisconnect: (p: AgentProvider) => void;
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
  const connected = connectedProviders(status);
  const missing = missingProviders(status);
  const cur = models.find(m => modelKey(m) === value);
  const several = new Set(models.map(providerOf)).size > 1;
  const pick = (m: AgentModel) => { setOpen(false); onChange(m); };
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
        <div class="agent-mp-menu" role="menu" onKeyDown={onMenuKey}>
          {connected.map(p => {
            const list = models.filter(m => providerOf(m) === p);
            const who = providerWho(p, status);
            return (
              <div key={p} class="agent-mp-group" data-agent-provider={p}>
                <div class="agent-mp-head">
                  <span class="name">{PROVIDER_LABEL[p]}</span>
                  <span class="who" title={`${ENGINE[p]}${who ? ` · ${who}` : ''}`}>{ENGINE[p]}{who && ` · ${who}`}</span>
                  <button class="agent-mp-out" data-agent-disconnect={p} title={p === 'chatgpt' ? 'Sign this ChatGPT account out of the agent' : 'Forget this key (OverLyX deletes it)'}
                    onClick={() => act(() => onDisconnect(p))}>{p === 'chatgpt' ? 'Sign out' : 'Remove'}</button>
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
