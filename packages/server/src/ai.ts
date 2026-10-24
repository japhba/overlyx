/**
 * AI assistance for the editor (opt-in per browser, see the client's Tools ▸ AI menu):
 *
 *  - **Rewrite** (⌘K / Ctrl+K): the selected passage of a document plus an instruction go to the
 *    model together with the document's LaTeX source for context; the reply is the replacement
 *    LaTeX, parsed back into editor nodes so the client can preview it in place. Nothing is
 *    applied on the server — the user accepts or rejects in the editor.
 *  - **Autocomplete**: a short continuation of the text (or of the formula) at the cursor, again
 *    returned as LaTeX *and* as parsed editor nodes so the ghost text renders like real content.
 *
 * Model access goes through OpenRouter (the key that also serves "Escalate to AI…"); the default
 * model is Gemini Flash (fast, a million tokens of context, cheap enough for autocomplete).
 */
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.ts';
import type { OpenDoc } from './docs.ts';
import { keyOf, isAgentProvider, upstreamOf, PROVIDER_NAMES, type AgentProvider } from './agentkeys.ts';
import { readerFor, writeDocumentText, cachedParseFile } from './texdoc.ts';
import { parseTex, SETTINGS_PREFIX } from '@overlyx/core/tex/index.ts';
import { paragraphsToPm, pmBlocksToParagraphs, collectMacros, type PMJSON, type LyxDocument } from '@overlyx/core';
import { projectDir, findMaster } from './projects.ts';

export class AiError extends Error { constructor(msg: string, public status = 502) { super(msg); } }

export function aiAvailable(): boolean { return !!config.openrouter.apiKey; }

export interface ModelInfo {
  id: string; label: string; note: string;
  /** Artificial Analysis Intelligence Index (artificialanalysis.ai, looked up 2026-09-02; top models score in the 60s) */
  aa?: number;
  /** response time on a ⌘K-sized rewrite (measured 2026-09-02, scratch/ai-rewrite-bench.mjs) */
  speed: string;
}
/** Models offered in the pickers (any OpenRouter id may still be typed in). */
export const MODELS: ModelInfo[] = [
  { id: 'google/gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite', aa: 26, speed: '~1 s', note: 'no thinking, follows the document’s notation (default)' },
  { id: 'google/gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite', aa: 7, speed: '0.6–0.7 s', note: 'fastest and cheapest; fine for simple edits' },
  { id: 'google/gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite', aa: 37, speed: '0.8–1 s', note: 'sharper prose' },
  { id: 'google/gemini-3.8-flash', label: 'Gemini 3.8 Flash', aa: 59, speed: '1.5–4 s', note: 'strongest of the fast ones (thinking kept low)' },
  { id: 'inception/mercury-2', label: 'Mercury 2', aa: 22, speed: '~1 s', note: 'diffusion model — instant drafts' },
  { id: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5', aa: 24, speed: '~1.5 s', note: 'careful prose' },
  { id: 'openai/gpt-5.4-nano', label: 'GPT-5.4 nano', aa: 38, speed: '~1.5 s', note: 'OpenAI’s fast one' },
  { id: 'google/gemini-3.7-flash', label: 'Gemini 3.7 Flash', aa: 56, speed: '7–15 s', note: 'thinks hard — only for difficult rewrites' },
];
export function aiStatus(): { available: boolean; model: string; completionModel: string; inkModel: string; models: ModelInfo[] } {
  return { available: aiAvailable(), model: config.ai.model, completionModel: config.ai.completionModel, inkModel: config.ai.inkModel, models: MODELS };
}
/** A model id chosen in the client, if it looks like an OpenRouter id; else the server's default. */
export function pickModel(requested: unknown, fallback: string): string {
  if (typeof requested !== 'string') return fallback;
  const id = requested.trim();
  return /^[a-z0-9-]+\/[a-z0-9._:-]+$/i.test(id) && id.length <= 80 ? id : fallback;
}

/**
 * Where an inline AI request runs — the ⌘J picker offers the same choice as the Agent panel's
 * (AgentModelPicker.tsx): the server's own OpenRouter key (`overlyx`, the models above), or one of
 * the account's own providers (agentkeys.ts: the ChatGPT sign-in, an OpenAI, OpenRouter or
 * Anthropic key). The client sends `provider:model`; a bare id is an OpenRouter id on the server's key.
 */
export type AiProvider = 'overlyx' | AgentProvider;
export interface AiRoute { provider: AiProvider; model: string; userId?: number }
export function pickRoute(requested: unknown, fallback: string, userId?: number): AiRoute {
  const s = typeof requested === 'string' ? requested.trim() : '';
  const i = s.indexOf(':');
  const provider = s.slice(0, i);
  if (i > 0 && (provider === 'overlyx' || isAgentProvider(provider))) {
    const model = s.slice(i + 1);
    if (provider === 'overlyx') return { provider, model: pickModel(model, fallback) };
    if (userId === undefined || !/^[\w.:/-]{1,120}$/.test(model)) throw new AiError('That model cannot be used here.', 400);
    if (provider !== 'chatgpt' && !keyOf(userId, provider)) throw new AiError(`There is no ${PROVIDER_NAMES[provider]} key on your account — add it from the model menu.`, 400);
    return { provider, model, userId };
  }
  return { provider: 'overlyx', model: pickModel(s || undefined, fallback) };
}
/** A route needs the server's OpenRouter key. */
export const usesServerKey = (r: AiRoute) => r.provider === 'overlyx';

/**
 * Request adjustments some models need (applied by `chat` to whatever model is chosen, from the
 * dropdown or typed in): OpenAI's gpt-5* reject `temperature` and reason unless told not to;
 * Gemini 3.8 Flash skips its reasoning once the effort is low (measured: 0 reasoning tokens,
 * 1.5–4 s instead of 7–15 s — it cannot be disabled outright, the endpoint rejects `enabled: false`).
 */
const TUNING: { match: RegExp; reasoning?: { effort: 'minimal' | 'low' }; noTemperature?: boolean }[] = [
  { match: /^openai\/gpt-5/, reasoning: { effort: 'minimal' }, noTemperature: true },
  { match: /^google\/gemini-3\.8-flash/, reasoning: { effort: 'low' } },
];
export function tuningFor(model: string): { reasoning?: { effort: 'minimal' | 'low' }; noTemperature?: boolean } | undefined {
  return TUNING.find(t => t.match.test(model));
}

/* ------------------------------------------------------------------ model access */

/** a part of a message: text, or an image (a data: URL — the handwriting of the math keyboard's pen) */
export type ChatPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string | ChatPart[] }
export interface ChatOptions { model?: string; temperature?: number; maxTokens?: number; signal?: AbortSignal; title?: string; /** the account's own provider instead of the server's key (pickRoute) */ route?: AiRoute }

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(p => (typeof p === 'object' && p && 'text' in p ? String((p as { text: unknown }).text ?? '') : '')).join('');
  return '';
}

/** One chat completion through OpenRouter; the assistant's text (may be empty). */
export async function chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  const t0 = Date.now();
  const what = `${opts.title ?? 'OverLyX'} ${opts.route && opts.route.provider !== 'overlyx' ? `${opts.route.provider}:${opts.route.model}` : opts.route?.model ?? opts.model ?? config.ai.model}`;
  try {
    const r = opts.route;
    const text = r && r.provider !== 'overlyx' ? await chatOwn(messages, r, opts) : await chatRaw(messages, r ? { ...opts, model: r.model } : opts);
    const chars = messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : m.content.reduce((k, p) => k + (p.type === 'text' ? p.text.length : 0), 0)), 0);
    const images = messages.reduce((n, m) => n + (typeof m.content === 'string' ? 0 : m.content.filter(p => p.type === 'image_url').length), 0);
    console.log(`[ai] ${what}: ${Date.now() - t0} ms, ${chars} chars${images ? ` + ${images} image${images > 1 ? 's' : ''}` : ''} in, ${text.length} out`);
    return text;
  } catch (e) {
    if (!(e instanceof AiError && e.status === 499)) console.warn(`[ai] ${what} failed after ${Date.now() - t0} ms: ${(e as Error).message}`);
    throw e;
  }
}

async function chatRaw(messages: ChatMessage[], opts: ChatOptions, key = config.openrouter.apiKey, api = config.openrouter.api): Promise<string> {
  if (!key) throw new AiError('AI assistance is not configured on this server (OPENROUTER_API_KEY is unset).', 503);
  const model = opts.model ?? config.ai.model;
  const tuning = tuningFor(model);
  let res: Response;
  try {
    res = await fetch(`${api}/chat/completions`, {
      method: 'POST',
      signal: opts.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        'HTTP-Referer': config.publicUrl || 'https://overlyx.app',
        'X-Title': opts.title ?? 'OverLyX',
      },
      body: JSON.stringify({
        model,
        ...(tuning?.noTemperature ? {} : { temperature: opts.temperature ?? 0.2 }),
        ...(tuning?.reasoning ? { reasoning: tuning.reasoning } : {}),
        max_tokens: opts.maxTokens ?? 2048,
        messages,
      }),
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new AiError('cancelled', 499);
    throw new AiError(`Could not reach OpenRouter: ${(e as Error).message}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new AiError(`The AI request failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const json = await res.json().catch(() => null) as { choices?: { message?: { content?: unknown } }[]; error?: { message?: string } } | null;
  if (json?.error?.message) throw new AiError(`The AI request failed: ${json.error.message}`);
  return messageText(json?.choices?.[0]?.message?.content);
}

/** One request on the account's own provider (pickRoute): their OpenRouter or OpenAI key, Anthropic key, or the ChatGPT sign-in. */
async function chatOwn(messages: ChatMessage[], r: AiRoute, opts: ChatOptions): Promise<string> {
  const userId = r.userId!;
  const system = messages.filter(m => m.role === 'system').map(m => messageText(m.content)).join('\n\n');
  const rest = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role as 'user' | 'assistant', content: messageText(m.content) }));
  const keyFor = (p: 'openrouter' | 'openai' | 'anthropic') => { const k = keyOf(userId, p); if (!k) throw new AiError(`There is no ${PROVIDER_NAMES[p]} key on your account any more.`, 400); return k; };
  const refused = (status: number | undefined, body: string) => (status === 401 || status === 403
    ? new AiError(`${PROVIDER_NAMES[r.provider as AgentProvider]} refused your key — replace it from the model menu.`, 400)
    : new AiError(`The AI request failed (${status ?? 'no answer'}): ${body.slice(0, 300)}`));
  if (r.provider === 'openrouter') return chatRaw(messages, { ...opts, model: r.model }, keyFor('openrouter'), upstreamOf('openrouter') + '/v1');
  if (r.provider === 'openai') {
    // the Responses API: every current OpenAI model (codex's among them) takes it
    let res: Response;
    try {
      res = await fetch(`${upstreamOf('openai')}/v1/responses`, {
        method: 'POST', signal: opts.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${keyFor('openai')}` },
        body: JSON.stringify({ model: r.model, instructions: system || undefined, input: rest, max_output_tokens: Math.max(opts.maxTokens ?? 2048, 1024) * 2, reasoning: { effort: 'low' }, store: false }),
      });
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw new AiError('cancelled', 499);
      throw new AiError(`Could not reach OpenAI: ${(e as Error).message}`);
    }
    if (!res.ok) throw refused(res.status, await res.text().catch(() => ''));
    const j = await res.json().catch(() => null) as { output?: { type?: string; content?: { type?: string; text?: string }[] }[] } | null;
    return (j?.output ?? []).filter(o => o.type === 'message').flatMap(o => o.content ?? []).filter(c => c.type === 'output_text').map(c => c.text ?? '').join('');
  }
  if (r.provider === 'anthropic') {
    const client = new Anthropic({ apiKey: keyFor('anthropic'), baseURL: upstreamOf('anthropic'), maxRetries: 1 });
    try {
      const msg = await client.messages.create({
        model: r.model, max_tokens: Math.max(opts.maxTokens ?? 2048, 1024) * 4, system: system || undefined,
        messages: rest.length ? rest : [{ role: 'user', content: '' }],
        // a quick answer: little thinking (it cannot be turned off on the current models)
        output_config: { effort: 'low' },
      }, { signal: opts.signal });
      if (msg.stop_reason === 'refusal') throw new AiError('The model declined this request.', 400);
      return msg.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('');
    } catch (e) {
      if (e instanceof AiError) throw e;
      if (e instanceof Anthropic.APIUserAbortError) throw new AiError('cancelled', 499);
      if (e instanceof Anthropic.APIError) throw refused(e.status, e.message);
      throw new AiError(`Could not reach Anthropic: ${(e as Error).message}`);
    }
  }
  // the ChatGPT sign-in: a one-shot question to the account's codex (slower: a few seconds)
  const { askCodex } = await import('./agent.ts');
  const prompt = `${system}\n\n${rest.map(m => (m.role === 'assistant' ? `(Your earlier answer)\n${m.content}` : m.content)).join('\n\n')}\n\nPut your whole answer, exactly as it should be used, in "reply".`;
  const out = await askCodex(userId, prompt, { type: 'object', properties: { reply: { type: 'string' } }, required: ['reply'], additionalProperties: false }, r.model);
  try { return String((JSON.parse(out) as { reply?: unknown }).reply ?? ''); } catch { return out; }
}

/** Strips a markdown fence and stray quoting a model may put around a LaTeX reply. */
export function cleanReply(s: string): string {
  let t = s.replace(/\r\n/g, '\n').trim();
  const m = /^```(?:[\w-]*)\n([\s\S]*?)\n?```$/.exec(t);
  if (m) t = m[1].trim();
  // a bare "$…$" around a whole math reply is not wanted (the field adds the delimiters)
  return t;
}

/* ------------------------------------------------------------------ document ↔ LaTeX */

/** The LaTeX of a selection (a ProseMirror slice's content: whole paragraphs or inline nodes). */
export function selectionToTex(doc: OpenDoc, content: PMJSON[], layout = 'Standard'): string {
  if (!content.length) return '';
  const blocks: PMJSON[] = content[0].type === 'paragraph' ? content : [{ type: 'paragraph', attrs: { layout, depth: 0 }, content }];
  const base = doc.toLyxDocument();
  const lyx: LyxDocument = { ...base, body: pmBlocksToParagraphs(blocks) };
  const text = writeDocumentText(lyx, doc.project, doc.relPath, true).text;
  return text.split('\n').filter(l => !l.startsWith(SETTINGS_PREFIX)).join('\n').trim();
}

/** LaTeX (a fragment: paragraphs, inline text with math) parsed into editor nodes, in the document's context. */
export function texToPm(doc: OpenDoc, tex: string): PMJSON[] {
  if (!tex.trim()) return [];
  const abs = path.join(projectDir(doc.project), doc.relPath);
  const header = doc.getMeta().headerLines;
  const r = parseTex(tex, { layoutDir: config.layoutDir, localDirs: [projectDir(doc.project), path.dirname(abs)], readFile: readerFor(doc.project, abs), masterHeader: header });
  return paragraphsToPm(r.doc.body).filter(p => p.content?.length);
}

/** `\name[n] = def` lines for the macros the document (and its master / macro files) defines. */
function macroLines(doc: OpenDoc): string[] {
  try {
    const proj = projectDir(doc.project);
    const masterRel = findMaster(doc.project, doc.relPath);
    const readDoc = (rel: string) => cachedParseFile(doc.project, rel).doc;
    const lyx = doc.toLyxDocument();
    const rootLyx = masterRel ? readDoc(masterRel) : lyx;
    const docDir = path.dirname(path.join(proj, masterRel ?? doc.relPath));
    const safe = (fn: string) => { const a = path.resolve(docDir, fn); return a.startsWith(proj) ? a : null; };
    const readFile = (fn: string) => { const a = safe(fn); try { return a ? fs.readFileSync(a, 'utf8') : undefined; } catch { return undefined; } };
    const include = (fn: string) => { const a = safe(fn.endsWith('.tex') || fn.includes('.') ? fn : fn + '.tex'); if (!a || !a.endsWith('.tex') || !fs.existsSync(a)) return undefined; try { return readDoc(path.relative(proj, a)); } catch { return undefined; } };
    const macros = collectMacros(rootLyx, { include, readFile });
    if (masterRel) macros.push(...collectMacros(lyx, { include, readFile }, { includePreamble: false }));
    const seen = new Set<string>();
    const out: string[] = [];
    for (const m of macros) { if (seen.has(m.name)) continue; seen.add(m.name); out.push(`\\${m.name}${m.args ? `[${m.args}]` : ''} = ${m.def}`); }
    return out.slice(0, 400);
  } catch { return []; }
}

/* ------------------------------------------------------------------ locating text */

/** whitespace-insensitive search: the index in `hay` where `needle` starts, or -1 */
export function locate(hay: string, needle: string): { start: number; end: number } | null {
  const collapse = (s: string) => { const map: number[] = []; let out = ''; let ws = false; for (let i = 0; i < s.length; i++) { const c = s[i]; if (/\s/.test(c)) { ws = true; continue; } if (ws && out) { out += ' '; map.push(i); ws = false; } out += c; map.push(i); } return { out, map }; };
  const h = collapse(hay), n = collapse(needle);
  if (!n.out) return null;
  const head = n.out.slice(0, 160);
  const i = h.out.indexOf(head);
  if (i < 0) return null;
  const tail = n.out.slice(-160);
  let j = h.out.indexOf(tail, i + head.length - Math.min(head.length, tail.length));
  if (j < 0) j = i + head.length - tail.length;
  const endC = j + tail.length - 1;
  return { start: h.map[i], end: (h.map[endC] ?? hay.length - 1) + 1 };
}

const SEL_OPEN = '⟦SELECTION⟧', SEL_CLOSE = '⟦/SELECTION⟧', CURSOR = '⟦CURSOR⟧';

/** The document's LaTeX with the passage marked (or just centred on it), cut to a window around it when the document is long. */
export function documentContext(text: string, snippet: string, maxChars: number, mark = true): string {
  const loc = snippet.trim() ? locate(text, snippet) : null;
  let marked = text;
  let centre = 0;
  if (loc) { if (mark) marked = text.slice(0, loc.start) + SEL_OPEN + text.slice(loc.start, loc.end) + SEL_CLOSE + text.slice(loc.end); centre = loc.start; }
  if (marked.length <= maxChars) return marked;
  const bd = marked.indexOf('\\begin{document}');
  const preamble = bd > 0 ? marked.slice(0, Math.min(bd, 12000)) : '';
  const room = maxChars - preamble.length;
  const from = Math.max(preamble.length, Math.min(centre - Math.floor(room * 0.6), marked.length - room));
  return preamble + (from > preamble.length ? '\n…\n' : '') + marked.slice(from, from + room) + (from + room < marked.length ? '\n…' : '');
}

/* ------------------------------------------------------------------ rewrite */

const REWRITE_SYSTEM = `You are a writing and LaTeX assistant built into OverLyX, a WYSIWYG editor for scientific papers written in LaTeX. The user has selected a passage of their document and gives an instruction. Produce the replacement for the passage.

Rules:
- Reply with the replacement LaTeX only. No explanations, no markdown fences, no quotation marks around it, no \\documentclass / \\begin{document}. Never write commentary about the passage or the task — the reply is pasted verbatim into the document.
- Keep the document's conventions: its notation, its macros (a list is given), the citation keys and labels that exist in it, its language and tone. Inline math as $…$; keep display environments (equation, align, …) as in the original and preserve every \\label.
- Change only what the instruction asks for. Do not add remarks, headings, or content the instruction does not call for.
- If nothing is selected, the instruction asks for new text to insert at the cursor, marked ${CURSOR} in the document: write exactly that, fitting between what is before and after the marker.
- The document text is provided for context only; the passage to replace is delimited by ${SEL_OPEN} … ${SEL_CLOSE} (the markers are not part of the document).
- Comments in the source that start with "%%" and macros \\lyxadded / \\lyxdeleted are the editor's own bookkeeping (notes, tracked changes): never produce them.`;

export interface RewriteRequest {
  instruction: string; content: PMJSON[]; layout?: string;
  /** model chosen in the client's picker: `provider:model` (pickRoute) or an OpenRouter id on the server's key (validated; the server default otherwise) */
  model?: string;
  /** the account asking: its own providers may be chosen */
  userId?: number;
  /** text of the paragraph before / after the cursor (locates the cursor in the document when nothing is selected) */
  before?: string; after?: string;
  math?: { latex: string; display: boolean; selection?: string };
  /** raw .tex source selected in the source view — the reply is raw LaTeX for the file, not parsed */
  source?: { text: string; before?: string; after?: string };
  /** follow-up: earlier proposals for the same passage, oldest first — the new instruction refines the last one */
  history?: { instruction: string; tex: string }[];
}
export interface RewriteResult { tex: string; nodes: PMJSON[]; original: string }

/** The follow-up section of the prompt: the proposals so far; the instruction refines the last one. */
function historySection(history: RewriteRequest['history']): string {
  const h = (history ?? []).filter(x => x && typeof x.tex === 'string').slice(-5);
  if (!h.length) return '';
  return h.map((x, i) => `\n\n## Your proposal ${i + 1} for this passage (instruction: ${String(x.instruction ?? '').slice(0, 400)})\n${x.tex.slice(0, 4000)}`).join('')
    + '\n\nThe user follows up: apply the new instruction to your LAST proposal above (the original passage still says where the replacement goes).';
}

export async function rewrite(doc: OpenDoc, req: RewriteRequest, signal?: AbortSignal): Promise<RewriteResult> {
  const instruction = req.instruction.trim();
  if (!instruction) throw new AiError('Say what to do with the passage.', 400);
  const route = pickRoute(req.model, config.ai.model, req.userId);
  const docText = await doc.textAsync();
  const macros = macroLines(doc);
  if (req.source) {
    // the source view: the selection is raw .tex text; the reply goes verbatim into the file
    const sel = req.source.text ?? '';
    let context = documentContext(docText, sel.trim() ? sel : '', 120000);
    if (!sel.trim() && req.source.before?.trim()) {
      const loc = locate(docText, req.source.before.slice(-300));
      if (loc) context = documentContext(docText.slice(0, loc.end) + CURSOR + docText.slice(loc.end), CURSOR, 120000, false);
    }
    const what = sel.trim() ? `## The selected source to replace\n\`\`\`latex\n${sel.slice(0, 12000)}\n\`\`\`` : `## Nothing is selected — write new source for the cursor, marked ${CURSOR}`;
    const user = `## Document (.tex source, for context; the selection is marked ${SEL_OPEN} … ${SEL_CLOSE} when present)\n${context}\n\n## Macros known to the document\n${macros.join('\n') || '(none)'}\n\n${what}${historySection(req.history)}\n\n## Instruction\n${instruction}\n\nReply with the raw LaTeX replacement only — it goes verbatim into the .tex file (no fences, no commentary, no \\documentclass unless the selection contained one).`;
    const reply = cleanReply(await chat([{ role: 'system', content: REWRITE_SYSTEM }, { role: 'user', content: user }], { route, signal, title: 'OverLyX rewrite' }));
    return { tex: reply, nodes: [], original: sel };
  }
  if (req.math) {
    const original = req.math.selection ?? req.math.latex;
    const context = documentContext(docText, req.math.latex, 60000);
    const user = `## Document (for context)\n${context}\n\n## Macros known to the document\n${macros.join('\n') || '(none)'}\n\n## The formula being edited (${req.math.display ? 'display' : 'inline'} math)\n${req.math.latex}\n\n## Part of it to replace\n${original}${historySection(req.history)}\n\n## Instruction\n${instruction}\n\nReply with LaTeX math only (no $ or \\[ delimiters, no environment unless the part to replace contains one), the replacement for the part.`;
    const reply = cleanReply(await chat([{ role: 'system', content: REWRITE_SYSTEM }, { role: 'user', content: user }], { route, signal, title: 'OverLyX rewrite' }));
    return { tex: reply.replace(/^\$+|\$+$/g, '').trim(), nodes: [], original };
  }
  const original = selectionToTex(doc, req.content, req.layout);
  let context = documentContext(docText, original, 160000);
  if (!original.trim() && req.before?.trim()) {
    // nothing selected: mark where the cursor is
    const loc = locate(docText, req.before.slice(-300));
    if (loc) context = documentContext(docText.slice(0, loc.end) + CURSOR + docText.slice(loc.end), CURSOR, 160000, false);
  }
  const user = `## Document (for context; the passage to replace is marked)\n${context}\n\n## Macros known to the document\n${macros.join('\n') || '(none)'}\n\n## Passage to replace\n${original || '(empty — insert new text at the cursor)'}${historySection(req.history)}\n\n## Instruction\n${instruction}\n\nReply with the replacement for the passage only.`;
  const reply = cleanReply(await chat([{ role: 'system', content: REWRITE_SYSTEM }, { role: 'user', content: user }], { route, signal, title: 'OverLyX rewrite' }));
  let nodes: PMJSON[] = [];
  try { nodes = texToPm(doc, reply); } catch (e) { throw new AiError(`The reply could not be parsed as LaTeX: ${(e as Error).message}`); }
  return { tex: reply, nodes, original };
}

/* ------------------------------------------------------------------ autocomplete */

const COMPLETE_TEXT_SYSTEM = `You are the autocomplete engine of OverLyX, a WYSIWYG editor for scientific papers written in LaTeX. The author is typing; the cursor is marked ${CURSOR}. Propose how the text goes on.

Rules:
- Reply with the current sentence: first repeat it exactly as it stands up to the cursor (the "sentence so far" is given — copy it verbatim, LaTeX included, do not correct it), then continue it to its end. If the sentence so far is already complete, write the next sentence after it. Always add new text — between 6 and about 30 new words. No explanations, no markdown fences, no quotation marks.
- Write LaTeX as the author would: inline math as $…$, the document's macros and notation, \\cite{key} only with keys that occur in the document, \\ref{label} only for labels that exist.
- Do not write anything that is already after the cursor.
- Match the language, register and style of the surrounding text; stay consistent with what the document says. Never invent numerical results.
- Only when the cursor sits inside a LaTeX command, a reference or a citation key, reply with just the sentence so far (nothing added).`;

const COMPLETE_MATH_SYSTEM = `You are the autocomplete engine of OverLyX, a WYSIWYG editor for scientific papers written in LaTeX. Continue the formula the author is typing at the cursor, marked ${CURSOR}.

Rules:
- Reply with LaTeX math only: no $ or \\[ delimiters, no environments, no explanations, no fences. At most 40 tokens — complete the current expression, term, or equation, then stop.
- Use the document's macros and notation (a macro list and the surrounding text are given). Never repeat what is before the cursor; do not write what is already after it.
- If the formula is complete or no sensible continuation exists, reply with nothing at all.`;

export interface CompleteRequest { kind: 'text' | 'math'; before: string; after: string; /** math: the formula so far with the cursor, and the paragraph text around it */ formula?: string; paragraph?: string; /** model chosen in the client's preferences */ model?: string }
export interface CompleteResult { text: string; nodes: PMJSON[] }

/** A cached document context per document: the LaTeX source, refreshed at most every few seconds (typing pauses come often). */
const contextCache = new Map<string, { at: number; text: string; macros: string[] }>();
async function docContext(doc: OpenDoc): Promise<{ text: string; macros: string[] }> {
  const hit = contextCache.get(doc.id);
  if (hit && Date.now() - hit.at < 15000) return hit;
  const entry = { at: Date.now(), text: await doc.textAsync(), macros: macroLines(doc) };
  if (contextCache.size > 100) contextCache.clear();
  contextCache.set(doc.id, entry);
  return entry;
}

export async function complete(doc: OpenDoc, req: CompleteRequest, signal?: AbortSignal): Promise<CompleteResult> {
  const { text: docText, macros: allMacros } = await docContext(doc);
  // latency matters more than breadth here: a few thousand characters around the cursor, the
  // start of the preamble (class, title, the first macros) and the first macro definitions
  const before = req.before.slice(-2000), after = req.after.slice(0, 500);
  const macros = allMacros.slice(0, 100);
  const bd = docText.indexOf('\\begin{document}');
  const preamble = bd > 0 ? docText.slice(0, Math.min(bd, 1500)) : '';
  const loc = before.trim() ? locate(docText, before.slice(-400)) : null;
  const earlier = loc ? docText.slice(Math.max(bd > 0 ? bd : 0, loc.start - 3000), loc.start) : docText.slice(bd > 0 ? bd : 0, (bd > 0 ? bd : 0) + 3000);
  const model = pickModel(req.model, config.ai.completionModel);
  if (req.kind === 'math') {
    const user = `## Document (for context)\n${preamble}\n…\n${earlier}\n\n## Macros known to the document\n${macros.join('\n') || '(none)'}\n\n## Text around the formula\n${(req.paragraph ?? before).slice(-2000)}\n\n## The formula so far\n${req.formula ?? before + CURSOR + after}\n\nReply with the continuation at ${CURSOR} only.`;
    const reply = cleanReply(await chat([{ role: 'system', content: COMPLETE_MATH_SYSTEM }, { role: 'user', content: user }], { model, temperature: 0.1, maxTokens: 80, signal, title: 'OverLyX autocomplete' }));
    const text = reply.replace(/^\$+|\$+$/g, '').replace(/^\\\[|\\\]$/g, '').replace(/\n/g, ' ').trim();
    return { text, nodes: [] };
  }
  const sentence = sentenceSoFar(before);
  const user = `## Document (for context)\n${preamble}\n…\n${earlier}\n\n## Macros known to the document\n${macros.join('\n') || '(none)'}\n\n## Text at the cursor\n${before}${CURSOR}${after}\n\n## Sentence so far (repeat it verbatim, then continue)\n${sentence}\n\nReply with the sentence so far followed by its continuation.`;
  const raw = await chat([{ role: 'system', content: COMPLETE_TEXT_SYSTEM }, { role: 'user', content: user }], { model, temperature: 0.2, maxTokens: 200, signal, title: 'OverLyX autocomplete' });
  if (process.env.OVERLYX_AI_DEBUG) console.log('[ai] debug: before=' + JSON.stringify(before.slice(-60)) + ' raw=' + JSON.stringify(raw.slice(0, 200)));
  // a leading space is meaningful here (the reply starts a new word): keep it, drop the rest of the trimming
  let text = raw.replace(/\r\n/g, '\n');
  const fence = /^\s*```(?:[\w-]*)\n([\s\S]*?)\n?```\s*$/.exec(text);
  if (fence) text = fence[1];
  text = text.replace(/\n+/g, ' ').replace(/\s+$/, '');
  // a reply that hit the token limit ends mid-word: end it at a sentence, or at least at a word boundary
  if (!/[.!?:;,)]$/.test(text) && text.length > 20) {
    const cut = text.slice(0, 240);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
    const ws = cut.lastIndexOf(' ');
    text = end > cut.length * 0.4 ? cut.slice(0, end + 1) : ws > 20 ? cut.slice(0, ws) : cut;
  }
  if (/^\s*$/.test(text)) return { text: '', nodes: [] };
  text = stripOverlap(before, text.replace(/⟦\/?[A-Z]+⟧/g, ''));   // the repeated sentence goes; a small model sometimes echoes the cursor marker
  const leading = /^\s/.test(text);
  let nodes: PMJSON[] = [];
  try { nodes = texToPm(doc, text.trim()); } catch { nodes = []; }
  const inline = nodes[0]?.content ?? [];
  if (leading && inline.length) inline.unshift({ type: 'text', text: ' ' });
  if (!inline.length) return { text: '', nodes: [] };
  return { text, nodes: inline };
}

/** The current sentence up to the cursor (what the model is asked to repeat): the text after the last sentence end, at most ~240 characters from a word boundary. */
export function sentenceSoFar(before: string): string {
  const tail = before.slice(-2000);
  const m = /[.!?][)"'”’]*\s+(?=[^\s])/g;
  let start = 0, r: RegExpExecArray | null;
  while ((r = m.exec(tail))) start = r.index + r[0].length;
  let sent = tail.slice(start);
  if (sent.length > 240) { const cut = sent.slice(-240); const ws = cut.indexOf(' '); sent = ws >= 0 ? cut.slice(ws + 1) : cut; }
  return sent;
}

/**
 * The reply repeats the sentence so far; the longest suffix of `before` that the reply begins
 * with (compared with whitespace runs collapsed) is dropped. That settles where the new text
 * starts — and whether a space belongs between the text and the continuation — without
 * guessing. A reply that repeated nothing: after a sentence end a space is supplied; after
 * letters it is taken as a continuation of the word (the model was told to repeat otherwise).
 */
export function stripOverlap(before: string, reply: string): string {
  const b = before.slice(-600);
  let rest = matchedRest(b, reply);
  if (rest !== null) {
    // a small model sometimes writes the sentence twice before going on
    const again = matchedRest(b, rest.replace(/^\s+/, ''));
    return again !== null ? again : rest;
  }
  // nothing repeated: only the space after a finished sentence / punctuation can be inferred
  if (/[.!?:;,)]$/.test(b) && /^[^\s]/.test(reply)) return ' ' + reply;
  return reply;
}

/** What follows the longest suffix of `b` (from a word boundary, whitespace runs collapsed) that `r` begins with; null when `r` repeats nothing. */
function matchedRest(b: string, r: string): string | null {
  const collapse = (str: string) => { const map: number[] = []; let out = ''; let ws = false; for (let i = 0; i < str.length; i++) { const c = str[i]; if (/\s/.test(c)) { ws = true; continue; } if (ws && out) { out += ' '; map.push(i); ws = false; } out += c; map.push(i); } return { out, map }; };
  const cb = collapse(b), cr = collapse(r);
  for (let i = 0; i < cb.out.length; i++) {
    if (i > 0 && cb.out[i - 1] !== ' ') continue;
    const suffix = cb.out.slice(i);
    if (suffix.length < 2) break;
    if (cr.out.startsWith(suffix)) {
      const endRaw = suffix.length < cr.map.length ? cr.map[suffix.length] : r.length;
      let rest = r.slice(endRaw);
      // whitespace between the repeated part and the continuation belongs to the continuation
      const wsBefore = /\s$/.test(r.slice(0, endRaw)) && !/^\s/.test(rest);
      if (wsBefore && !/\s$/.test(b)) rest = ' ' + rest.replace(/^\s+/, '');
      return rest;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ handwriting */

/**
 * The math keyboard's pen (client editor/mathkbd/inkpad.ts): what is written on its pad, drawn as
 * a PNG the way scripts/ink-bench.py draws Google's MathWriting inks (strokes scaled to a common
 * letter height), goes to a vision model with the formula around the cursor; up to three readings
 * come back, most likely first. The model is OVERLYX_AI_INK_MODEL (any OpenRouter vision model).
 */
export const INK_PROMPT = `You read handwritten mathematics. The image shows ink written with a pen or a finger on a tablet: one formula, or a piece of one that will be inserted at the cursor of a LaTeX formula editor.

Transcribe exactly what is written into LaTeX math (no $ delimiters, no \\[ \\], no equation environments, no explanations):
- Keep the writer's structure: fractions (\\frac), roots (\\sqrt, \\sqrt[n]), superscripts and subscripts (always braced: x^{2}, a_{ij}), integrals/sums with their limits, matrices (\\begin{pmatrix}…\\end{pmatrix} etc. matching the brackets drawn).
- Use standard commands: Greek letters (\\alpha …), \\cdot for a raised dot, \\times for a cross, \\leq \\geq \\neq \\approx \\to \\in \\infty \\partial \\nabla, \\sin \\cos \\log \\ln \\lim \\exp when such a function name is written, \\mathbb{R} for blackboard letters, \\vec{x} \\hat{x} \\bar{x} \\dot{x} \\tilde{x} for accents.
- Do not correct, complete or simplify the mathematics; an unbalanced bracket stays unbalanced. Do not add anything that is not written.
- Ambiguous shapes: decide from the mathematical context (x vs \\times, 1 vs l vs |, 0 vs o vs O, z vs 2, s vs 5, u vs \\mu, v vs \\nu, t vs +, a dot vs \\cdot vs a decimal point). Prefer the reading a mathematician would most likely have meant.

Reply with JSON only: {"latex": ["<most likely reading>", "<second reading>", "<third reading>"]} — up to three distinct readings, most likely first; give alternatives only where the handwriting is genuinely ambiguous (otherwise one entry).`;

export interface InkRequest {
  /** the ink drawn black on white: a data:image/png;base64 URL */
  image: string;
  /** the formula's LaTeX before and after the cursor (the cell it is in), for context */
  before?: string;
  after?: string;
  /** the cursor is in a \text{} part of the formula */
  text?: boolean;
  /** handwritten notes, not a formula (the lasso's Convert to text): plain text, its math as $…$ */
  notes?: boolean;
  model?: unknown;
}

/** at most this many characters of PNG data URL (about 1.5 MB of image) */
export const INK_MAX_IMAGE = 2_000_000;

/** The readings in a model's reply: JSON `{"latex": [...]}` (or bare LaTeX), delimiters stripped, distinct, at most three. */
export function parseInkReply(reply: string): string[] {
  const t = cleanReply(reply);
  let list: unknown[] = [];
  const m = /\{[\s\S]*\}/.exec(t);
  if (m) {
    try {
      const j = JSON.parse(m[0]) as { latex?: unknown; candidates?: unknown };
      const c = j.latex ?? j.candidates;
      list = Array.isArray(c) ? c : typeof c === 'string' ? [c] : [];
    } catch { /* not JSON: the reply itself */ }
  }
  if (!list.length && t && !t.startsWith('{')) list = [t];
  const out: string[] = [];
  for (const x of list) {
    if (typeof x !== 'string') continue;
    const s = x.trim()
      .replace(/^\$\$?([\s\S]*?)\$\$?$/, '$1')
      .replace(/^\\\[([\s\S]*)\\\]$/, '$1')
      .replace(/^\\\(([\s\S]*)\\\)$/, '$1')
      .replace(/^\\begin\{(equation|displaymath|math)\*?\}([\s\S]*)\\end\{\1\*?\}$/, '$2')
      .trim();
    if (!s || s.length > 600 || out.includes(s)) continue;
    out.push(s);
    if (out.length === 3) break;
  }
  return out;
}

export const NOTES_PROMPT = `You read handwritten notes. The image shows ink written with a pen or a finger on a tablet — words, a few lines of notes, perhaps with some mathematics — that will replace the handwriting with typed text.

Transcribe exactly what is written:
- Plain text, in the language it is written in; one line of text for each line of handwriting (keep the line breaks, join a word split across lines), bullets or numbers at the start of a line as "- " or "1. ".
- Mathematics written among the words as LaTeX between single dollar signs ($x^{2}+1$), a formula on a line of its own between $$ and $$. Use the conventions of LaTeX math (braced sub- and superscripts, \\frac, Greek letters as \\alpha …).
- Do not correct, complete or rephrase anything; keep the writer's spelling, abbreviations and punctuation. Do not add anything that is not written (no title, no explanation). Arrows written between words: → or ←.
- Ambiguous letters: decide from the words and the context, as a reader would.

Reply with JSON only: {"text": ["<most likely reading>", "<second reading>"]} — a second reading only where the handwriting is genuinely ambiguous (otherwise one entry).`;

/** The readings of handwritten notes in a model's reply: JSON `{"text": [...]}` (or the bare text), distinct, at most three. */
export function parseNotesReply(reply: string): string[] {
  const t = cleanReply(reply);
  let list: unknown[] = [];
  const m = /\{[\s\S]*\}/.exec(t);
  if (m) {
    try {
      const j = JSON.parse(m[0]) as { text?: unknown; candidates?: unknown };
      const c = j.text ?? j.candidates;
      list = Array.isArray(c) ? c : typeof c === 'string' ? [c] : [];
    } catch { /* not JSON: the reply itself */ }
  }
  if (!list.length && t && !t.startsWith('{')) list = [t];
  const out: string[] = [];
  for (const x of list) {
    if (typeof x !== 'string') continue;
    const s = x.replace(/\r\n/g, '\n').trim();
    if (!s || s.length > 4000 || out.includes(s)) continue;
    out.push(s);
    if (out.length === 3) break;
  }
  return out;
}

/** Up to three LaTeX readings of the handwriting, most likely first (empty: nothing legible). */
export async function recognizeInk(req: InkRequest, signal?: AbortSignal): Promise<string[]> {
  const image = String(req.image ?? '');
  if (!/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(image)) throw new AiError('The handwriting must be a PNG image.', 400);
  if (image.length > INK_MAX_IMAGE) throw new AiError('The handwriting image is too large.', 413);
  const before = String(req.before ?? '').slice(-400), after = String(req.after ?? '').slice(0, 200);
  const where = before || after
    ? `The formula around the cursor, ⟦INK⟧ marking where the handwriting goes: ${before}⟦INK⟧${after}`
    : 'The cursor is in an empty formula.';
  if (req.notes) {
    const reply = await chat([
      { role: 'system', content: NOTES_PROMPT },
      { role: 'user', content: [{ type: 'text', text: 'The handwritten notes:' }, { type: 'image_url', image_url: { url: image } }] },
    ], { model: pickModel(req.model, config.ai.inkModel), temperature: 0, maxTokens: 1200, signal, title: 'OverLyX ink notes' });
    return parseNotesReply(reply);
  }
  const mode = req.text ? ' The cursor is inside \\text{…}: transcribe what is written as plain text (no math commands).' : '';
  const reply = await chat([
    { role: 'system', content: INK_PROMPT },
    { role: 'user', content: [{ type: 'text', text: where + mode }, { type: 'image_url', image_url: { url: image } }] },
  ], { model: pickModel(req.model, config.ai.inkModel), temperature: 0, maxTokens: 400, signal, title: 'OverLyX ink' });
  return parseInkReply(reply);
}

/* ------------------------------------------------------------------ rate limiting */

const buckets = new Map<string, number[]>();
/** true when `key` may make another request (`limit` per minute, or per `windowMs`) */
export function allow(key: string, limit: number, windowMs = 60000): boolean {
  const now = Date.now();
  const arr = (buckets.get(key) ?? []).filter(t => now - t < windowMs);
  if (arr.length >= limit) { buckets.set(key, arr); return false; }
  arr.push(now);
  buckets.set(key, arr);
  return true;
}
