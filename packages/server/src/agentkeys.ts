/**
 * The Agent panel's providers besides the ChatGPT sign-in (agent.ts): the account's own API keys
 * for OpenAI, OpenRouter and Anthropic. A key is checked with its provider when it is added, kept
 * sealed (sealed.ts) and never given to an agent: the panel's agents hold an internal credential
 * and reach the provider through agentnet.ts's proxy, which puts the key on each request on its
 * way out. Threads on the OpenAI and OpenRouter keys run in codex (its model providers point at the
 * proxy), threads on the Anthropic key in Claude Code (scripts/claude-app-server.mjs) — an
 * Anthropic key from a Console organization linked to a Claude Max or Team plan draws on that
 * plan's monthly API credits.
 *
 * Also the model lists of those providers for the panel's picker: OpenRouter's catalogue (public)
 * thinned to the newest few models per maker that can call tools, Anthropic's from its models API.
 */
import Anthropic from '@anthropic-ai/sdk';
import { db } from './db.ts';
import { sealer } from './sealed.ts';

export type KeyProvider = 'openai' | 'openrouter' | 'anthropic';
/** where an Agent panel thread runs: the ChatGPT sign-in (codex) or one of the account's keys */
export type AgentProvider = 'chatgpt' | KeyProvider;
export const KEY_PROVIDERS: readonly KeyProvider[] = ['openai', 'openrouter', 'anthropic'];
export const isKeyProvider = (v: unknown): v is KeyProvider => typeof v === 'string' && (KEY_PROVIDERS as readonly string[]).includes(v);
export const isAgentProvider = (v: unknown): v is AgentProvider => v === 'chatgpt' || isKeyProvider(v);

export const PROVIDER_NAMES: Record<AgentProvider, string> = { chatgpt: 'ChatGPT', openai: 'OpenAI API', openrouter: 'OpenRouter', anthropic: 'Anthropic API' };

/** The providers' API roots (OVERLYX_LLM_UPSTREAM_<PROVIDER> points one at a stand-in for tests). */
export function upstreamOf(provider: KeyProvider): string {
  const override = process.env[`OVERLYX_LLM_UPSTREAM_${provider.toUpperCase()}`];
  if (override) return override.replace(/\/$/, '');
  return provider === 'openai' ? 'https://api.openai.com' : provider === 'openrouter' ? 'https://openrouter.ai/api' : 'https://api.anthropic.com';
}

db.exec(`
CREATE TABLE IF NOT EXISTS agent_keys (
  user_id INTEGER NOT NULL,
  provider TEXT NOT NULL,
  sealed TEXT NOT NULL,
  hint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, provider)
);
`);

const { seal, unseal } = sealer('agent-keys');

export class KeyError extends Error { constructor(message: string, public status = 400) { super(message); } }

const TIMEOUT_MS = 15_000;

/** Ask the provider whether `key` works; throws KeyError with what to tell the user. */
async function checkKey(provider: KeyProvider, key: string): Promise<void> {
  const unreachable = (e: unknown) => new KeyError(`${PROVIDER_NAMES[provider]} could not be reached to check the key (${(e as Error)?.message ?? e}) — try again in a moment`, 502);
  if (provider === 'anthropic') {
    try { await new Anthropic({ apiKey: key, baseURL: upstreamOf('anthropic'), maxRetries: 1, timeout: TIMEOUT_MS }).models.list({ limit: 1 }); }
    catch (e) {
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw new KeyError('Anthropic did not accept this key — copy an API key from platform.claude.com ▸ API keys');
      if (e instanceof Anthropic.APIError && e.status !== undefined) throw new KeyError(`Anthropic answered ${e.status} when the key was checked: ${e.message}`, 502);
      throw unreachable(e);
    }
    return;
  }
  const url = upstreamOf(provider) + (provider === 'openai' ? '/v1/models' : '/v1/key');
  let res: Response;
  try { res = await fetch(url, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(TIMEOUT_MS) }); }
  catch (e) { throw unreachable(e); }
  if (res.status === 401 || res.status === 403) throw new KeyError(provider === 'openai' ? 'OpenAI did not accept this key — copy an API key from platform.openai.com ▸ API keys' : 'OpenRouter did not accept this key — copy one from openrouter.ai ▸ Keys');
  if (!res.ok) throw new KeyError(`${PROVIDER_NAMES[provider]} answered ${res.status} when the key was checked`, 502);
}

/** Check `key` with its provider and keep it for the account (replacing an earlier one). */
export async function setKey(userId: number, provider: KeyProvider, raw: string): Promise<{ hint: string }> {
  const key = raw.trim();
  if (!key || key.length > 400 || /\s/.test(key)) throw new KeyError('That does not look like an API key');
  await checkKey(provider, key);
  const hint = '…' + key.slice(-4);
  db.prepare('INSERT OR REPLACE INTO agent_keys (user_id, provider, sealed, hint, created_at) VALUES (?,?,?,?,?)').run(userId, provider, seal(key), hint, Date.now());
  modelCache.delete(`${userId}:${provider}`);
  return { hint };
}

export function removeKey(userId: number, provider: KeyProvider): boolean {
  modelCache.delete(`${userId}:${provider}`);
  return db.prepare('DELETE FROM agent_keys WHERE user_id = ? AND provider = ?').run(userId, provider).changes > 0;
}

/** The account's key for `provider` (for the proxy's outgoing request only), or null. */
export function keyOf(userId: number, provider: KeyProvider): string | null {
  const row = db.prepare('SELECT sealed FROM agent_keys WHERE user_id = ? AND provider = ?').get(userId, provider) as { sealed: string } | undefined;
  if (!row) return null;
  try { return unseal(row.sealed); } catch { return null; }
}

/** Which keys the account has: provider → the last characters of the key and when it was added. */
export function keyHints(userId: number): Partial<Record<KeyProvider, { hint: string; addedAt: number }>> {
  const rows = db.prepare('SELECT provider, hint, created_at FROM agent_keys WHERE user_id = ?').all(userId) as { provider: string; hint: string; created_at: number }[];
  return Object.fromEntries(rows.filter(r => isKeyProvider(r.provider)).map(r => [r.provider, { hint: r.hint, addedAt: r.created_at }]));
}

/** The account was deleted. */
export function forgetKeys(userId: number): void {
  db.prepare('DELETE FROM agent_keys WHERE user_id = ?').run(userId);
  for (const k of [...modelCache.keys()]) if (k.startsWith(`${userId}:`)) modelCache.delete(k);
}

/* ------------------------------------------------------------------ the providers' models */

/** One entry of the panel's model picker (the client's AgentModel, plus where it runs). */
export interface ProviderModel { id: string; label: string; description: string; efforts: string[]; defaultEffort: string | null; isDefault: boolean; provider: AgentProvider }

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
/** Anthropic's models API unreachable: the current models (the list is refreshed from it otherwise) */
const CLAUDE_FALLBACK: [string, string][] = [['claude-opus-5-5', 'Claude Opus 5.5'], ['claude-sonnet-5-5', 'Claude Sonnet 5.5'], ['claude-haiku-5-5', 'Claude Haiku 5.5'], ['claude-fable-5-1', 'Claude Fable 5.1']];
const CLAUDE_DEFAULT = 'claude-opus-5-5';

const claudeModel = (id: string, label: string, isDefault: boolean): ProviderModel => ({
  id, label, description: id.includes('fable') ? 'Anthropic’s most capable model, at a higher price' : id.includes('haiku') ? 'Fast and inexpensive' : '',
  efforts: CLAUDE_EFFORTS, defaultEffort: 'high', isDefault, provider: 'anthropic',
});

const modelCache = new Map<string, { at: number; models: ProviderModel[] }>();
const MODEL_TTL_MS = 60 * 60 * 1000;

async function anthropicModels(key: string): Promise<ProviderModel[]> {
  let listed: { id: string; display_name: string; created_at: string }[] = [];
  try {
    const page = await new Anthropic({ apiKey: key, baseURL: upstreamOf('anthropic'), maxRetries: 1, timeout: TIMEOUT_MS }).models.list({ limit: 50 });
    listed = page.data.map(m => ({ id: m.id, display_name: m.display_name, created_at: m.created_at }));
  } catch { /* the fallback below */ }
  // the newest models first; older generations stay out of the picker (they are still there via the API)
  const current = listed.filter(m => m.id.startsWith('claude-') && !/claude-(3|2|instant)/.test(m.id)).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 6);
  const pairs: [string, string][] = current.length ? current.map(m => [m.id, m.display_name]) : CLAUDE_FALLBACK;
  const def = pairs.some(([id]) => id === CLAUDE_DEFAULT) ? CLAUDE_DEFAULT : pairs[0][0];
  return pairs.map(([id, label]) => claudeModel(id, label, id === def));
}

/** OpenRouter's makers whose newest models the picker offers, and how many of each */
const OPENROUTER_MAKERS: [string, number][] = [['anthropic/', 3], ['openai/', 3], ['google/', 2], ['x-ai/', 1], ['deepseek/', 2], ['moonshotai/', 1], ['qwen/', 2], ['z-ai/', 1], ['mistralai/', 1]];
const OPENROUTER_DEFAULT = /^anthropic\/claude-sonnet/;
let openrouterCatalogue: { at: number; models: ProviderModel[] } | null = null;

async function openrouterModels(): Promise<ProviderModel[]> {
  if (openrouterCatalogue && Date.now() - openrouterCatalogue.at < MODEL_TTL_MS) return openrouterCatalogue.models;
  let data: { id: string; name: string; created: number; context_length?: number; supported_parameters?: string[]; architecture?: { output_modalities?: string[] } }[] = [];
  try {
    const res = await fetch(upstreamOf('openrouter') + '/v1/models', { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.ok) data = ((await res.json()) as { data?: typeof data }).data ?? [];
  } catch { /* none this time */ }
  if (!data.length) return openrouterCatalogue?.models ?? [];
  // an agent needs tool calls and reasoning; variants (:free, :batch …) and image / audio models stay out
  const fit = data.filter(m => !m.id.includes(':') && (m.supported_parameters ?? []).includes('tools') && (m.supported_parameters ?? []).includes('reasoning')
    && !/image|audio|vision|omni|banana|embed|guard/i.test(m.id) && (m.architecture?.output_modalities ?? ['text']).every(x => x === 'text'))
    .sort((a, b) => b.created - a.created);
  const models: ProviderModel[] = [];
  for (const [maker, n] of OPENROUTER_MAKERS) {
    for (const m of fit.filter(x => x.id.startsWith(maker)).slice(0, n)) {
      models.push({ id: m.id, label: m.name.replace(/^[^:]+:\s*/, ''), description: m.name, efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', isDefault: false, provider: 'openrouter' });
    }
  }
  const def = models.find(m => OPENROUTER_DEFAULT.test(m.id)) ?? models[0];
  if (def) def.isDefault = true;
  openrouterCatalogue = { at: Date.now(), models };
  return models;
}

/** The picker's models of a key provider for this account (OpenAI's come from codex: agent.ts). */
export async function keyProviderModels(userId: number, provider: 'openrouter' | 'anthropic'): Promise<ProviderModel[]> {
  const key = keyOf(userId, provider);
  if (!key) return [];
  if (provider === 'openrouter') return openrouterModels();
  const cacheKey = `${userId}:${provider}`;
  const hit = modelCache.get(cacheKey);
  if (hit && Date.now() - hit.at < MODEL_TTL_MS) return hit.models;
  const models = await anthropicModels(key);
  modelCache.set(cacheKey, { at: Date.now(), models });
  return models;
}
