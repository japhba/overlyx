/**
 * The account's own AI: suggestions that should run on something the person linked themselves, not
 * on the server's key (OpenRouter, ai.ts) — the Agent panel's ChatGPT sign-in (codex, agent.ts) or
 * an agent they connected over MCP that is listening for instructions (mcpAgents.ts; the question
 * then shows in their Agent panel conversation with it). Without either there is no suggestion.
 *
 * The offline-merge review asks it for one version of a paragraph made from two (client
 * editor/plugins/mergereview.ts, POST /api/docs/…/ai/merge).
 */
import type { SessionUser } from './auth.ts';
import { codexSignedIn, askCodex } from './agent.ts';
import { listAgents, sendInstruction, finalReply } from './mcpAgents.ts';
import { AiError } from './ai.ts';

export type LinkedAi = { kind: 'codex'; via: string } | { kind: 'agent'; id: number; via: string };

/** The AI linked to this account, ChatGPT first; null when there is none (link guests never have one). */
export function linkedAi(user: SessionUser): LinkedAi | null {
  if (user.guest) return null;
  if (codexSignedIn(user.id)) return { kind: 'codex', via: 'ChatGPT' };
  const agent = listAgents(user.id).find(a => a.status === 'listening');
  return agent ? { kind: 'agent', id: agent.id, via: agent.name } : null;
}

export interface CombineRequest { current: string; offline: string; name: string; before?: string; after?: string }
export interface Combined { merged: string; note: string }

const SHAPE = {
  type: 'object',
  properties: { merged: { type: 'string' }, note: { type: 'string' } },
  required: ['merged', 'note'],
  additionalProperties: false,
};

/** the question: two versions of a paragraph (LaTeX), one wanted */
export function combinePrompt(r: CombineRequest): string {
  const ctx = (label: string, t?: string) => (t?.trim() ? `${label} (context only, do not repeat it):\n${t.trim()}\n\n` : '');
  return `Two versions of one paragraph of a LaTeX document have to become one. Both started from the same earlier text. "Current" is what the document holds now (co-authors edited it); "Offline" is what ${r.name} wrote meanwhile without a connection. Write the paragraph once, keeping what each version adds or corrects; where they say different things, choose the wording that reads best in context and mention that choice in the note. Keep LaTeX commands, math and citations exactly as written, add nothing neither version has, and return only the paragraph itself.

${ctx('The paragraph before', r.before)}Current:
<<<
${r.current}
>>>

Offline (${r.name}):
<<<
${r.offline}
>>>

${ctx('The paragraph after', r.after)}Answer with JSON: {"merged": "<the paragraph in LaTeX>", "note": "<one short sentence on what you did, or an empty string>"}`;
}

/** The reply as {merged, note}: JSON, possibly in a code fence or with words around it. */
export function parseCombined(reply: string): Combined {
  const text = reply.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  try {
    const v = JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text) as Partial<Combined>;
    if (typeof v.merged === 'string' && v.merged.trim()) return { merged: v.merged.trim(), note: typeof v.note === 'string' ? v.note.trim() : '' };
  } catch { /* not JSON */ }
  throw new AiError('The reply was not a combined paragraph.');
}

/** One version of the paragraph made from both, by the account's own AI. */
export async function combineVersions(user: SessionUser, ai: LinkedAi, r: CombineRequest, signal?: AbortSignal): Promise<Combined> {
  const prompt = combinePrompt(r);
  if (ai.kind === 'codex') return parseCombined(await askCodex(user.id, prompt, SHAPE));
  const msg = await sendInstruction(user, ai.id, `${prompt}\n\nThis comes from OverLyX's offline-merge review: answer with the reply tool (done), with only that JSON.`, undefined);
  const reply = await finalReply(user.id, msg.id, 150_000, signal);
  if (reply === null) throw new AiError(signal?.aborted ? 'cancelled' : `${ai.via} did not answer in time.`, signal?.aborted ? 499 : 504);
  return parseCombined(reply);
}
