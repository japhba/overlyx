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
import { config } from './config.ts';
import type { OpenDoc } from './docs.ts';
import { readerFor, writeDocumentText, cachedParseFile } from './texdoc.ts';
import { parseTex, SETTINGS_PREFIX } from '@overlyx/core/tex/index.ts';
import { paragraphsToPm, pmBlocksToParagraphs, collectMacros, type PMJSON, type LyxDocument } from '@overlyx/core';
import { projectDir, findMaster } from './projects.ts';

export class AiError extends Error { constructor(msg: string, public status = 502) { super(msg); } }

export function aiAvailable(): boolean { return !!config.openrouter.apiKey; }

export interface ModelInfo { id: string; label: string; note: string }
/** Models offered in the preferences (any OpenRouter id may still be typed in); notes from the 2026-08-29 measurements. */
export const MODELS: ModelInfo[] = [
  { id: 'google/gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite', note: 'fastest (0.4–1 s); proposes full sentences' },
  { id: 'google/gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite', note: 'fast (0.6–1.2 s), sharper prose; occasionally silent' },
  { id: 'google/gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite', note: 'fast (0.5–0.8 s), terse' },
  { id: 'google/gemini-3.5-flash', label: 'Gemini 3.5 Flash', note: 'strong, ~1.5 s' },
  { id: 'google/gemini-3.7-flash', label: 'Gemini 3.7 Flash', note: 'best; thinks before answering (2–3 s) — suits ⌘K' },
  { id: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5', note: '~1 s, careful prose' },
  { id: 'openai/gpt-4.1-nano', label: 'GPT-4.1 nano', note: '~0.8 s' },
];
export function aiStatus(): { available: boolean; model: string; completionModel: string; models: ModelInfo[] } {
  return { available: aiAvailable(), model: config.ai.model, completionModel: config.ai.completionModel, models: MODELS };
}
/** A model id chosen in the client, if it looks like an OpenRouter id; else the server's default. */
export function pickModel(requested: unknown, fallback: string): string {
  if (typeof requested !== 'string') return fallback;
  const id = requested.trim();
  return /^[a-z0-9-]+\/[a-z0-9._:-]+$/i.test(id) && id.length <= 80 ? id : fallback;
}

/* ------------------------------------------------------------------ model access */

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface ChatOptions { model?: string; temperature?: number; maxTokens?: number; signal?: AbortSignal; title?: string }

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(p => (typeof p === 'object' && p && 'text' in p ? String((p as { text: unknown }).text ?? '') : '')).join('');
  return '';
}

/** One chat completion through OpenRouter; the assistant's text (may be empty). */
export async function chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  const t0 = Date.now();
  const what = `${opts.title ?? 'OverLyX'} ${opts.model ?? config.ai.model}`;
  try {
    const text = await chatRaw(messages, opts);
    console.log(`[ai] ${what}: ${Date.now() - t0} ms, ${messages.reduce((n, m) => n + m.content.length, 0)} chars in, ${text.length} out`);
    return text;
  } catch (e) {
    if (!(e instanceof AiError && e.status === 499)) console.warn(`[ai] ${what} failed after ${Date.now() - t0} ms: ${(e as Error).message}`);
    throw e;
  }
}

async function chatRaw(messages: ChatMessage[], opts: ChatOptions): Promise<string> {
  if (!config.openrouter.apiKey) throw new AiError('AI assistance is not configured on this server (OPENROUTER_API_KEY is unset).', 503);
  let res: Response;
  try {
    res = await fetch(`${config.openrouter.api}/chat/completions`, {
      method: 'POST',
      signal: opts.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.openrouter.apiKey}`,
        'HTTP-Referer': config.publicUrl || 'https://overlyx.app',
        'X-Title': opts.title ?? 'OverLyX',
      },
      body: JSON.stringify({
        model: opts.model ?? config.ai.model,
        temperature: opts.temperature ?? 0.2,
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
    if (masterRel) macros.push(...collectMacros(lyx, { include, readFile }));
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
function documentContext(text: string, snippet: string, maxChars: number, mark = true): string {
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
- Reply with the replacement LaTeX only. No explanations, no markdown fences, no quotation marks around it, no \\documentclass / \\begin{document}.
- Keep the document's conventions: its notation, its macros (a list is given), the citation keys and labels that exist in it, its language and tone. Inline math as $…$; keep display environments (equation, align, …) as in the original and preserve every \\label.
- Change only what the instruction asks for. Do not add remarks, headings, or content the instruction does not call for.
- If nothing is selected, the instruction asks for new text to insert at the cursor, marked ${CURSOR} in the document: write exactly that, fitting between what is before and after the marker.
- The document text is provided for context only; the passage to replace is delimited by ${SEL_OPEN} … ${SEL_CLOSE} (the markers are not part of the document).
- Comments in the source that start with "%%" and macros \\lyxadded / \\lyxdeleted are the editor's own bookkeeping (notes, tracked changes): never produce them.`;

export interface RewriteRequest {
  instruction: string; content: PMJSON[]; layout?: string;
  /** model chosen in the client's preferences (validated; the server default otherwise) */
  model?: string;
  /** text of the paragraph before / after the cursor (locates the cursor in the document when nothing is selected) */
  before?: string; after?: string;
  math?: { latex: string; display: boolean; selection?: string };
}
export interface RewriteResult { tex: string; nodes: PMJSON[]; original: string }

export async function rewrite(doc: OpenDoc, req: RewriteRequest, signal?: AbortSignal): Promise<RewriteResult> {
  const instruction = req.instruction.trim();
  if (!instruction) throw new AiError('Say what to do with the passage.', 400);
  const model = pickModel(req.model, config.ai.model);
  const docText = doc.toText();
  const macros = macroLines(doc);
  if (req.math) {
    const original = req.math.selection ?? req.math.latex;
    const context = documentContext(docText, req.math.latex, 60000);
    const user = `## Document (for context)\n${context}\n\n## Macros known to the document\n${macros.join('\n') || '(none)'}\n\n## The formula being edited (${req.math.display ? 'display' : 'inline'} math)\n${req.math.latex}\n\n## Part of it to replace\n${original}\n\n## Instruction\n${instruction}\n\nReply with LaTeX math only (no $ or \\[ delimiters, no environment unless the part to replace contains one), the replacement for the part.`;
    const reply = cleanReply(await chat([{ role: 'system', content: REWRITE_SYSTEM }, { role: 'user', content: user }], { model, signal, title: 'OverLyX rewrite' }));
    return { tex: reply.replace(/^\$+|\$+$/g, '').trim(), nodes: [], original };
  }
  const original = selectionToTex(doc, req.content, req.layout);
  let context = documentContext(docText, original, 160000);
  if (!original.trim() && req.before?.trim()) {
    // nothing selected: mark where the cursor is
    const loc = locate(docText, req.before.slice(-300));
    if (loc) context = documentContext(docText.slice(0, loc.end) + CURSOR + docText.slice(loc.end), CURSOR, 160000, false);
  }
  const user = `## Document (for context; the passage to replace is marked)\n${context}\n\n## Macros known to the document\n${macros.join('\n') || '(none)'}\n\n## Passage to replace\n${original || '(empty — insert new text at the cursor)'}\n\n## Instruction\n${instruction}\n\nReply with the replacement for the passage only.`;
  const reply = cleanReply(await chat([{ role: 'system', content: REWRITE_SYSTEM }, { role: 'user', content: user }], { model, signal, title: 'OverLyX rewrite' }));
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
function docContext(doc: OpenDoc): { text: string; macros: string[] } {
  const hit = contextCache.get(doc.id);
  if (hit && Date.now() - hit.at < 15000) return hit;
  const entry = { at: Date.now(), text: doc.toText(), macros: macroLines(doc) };
  if (contextCache.size > 100) contextCache.clear();
  contextCache.set(doc.id, entry);
  return entry;
}

export async function complete(doc: OpenDoc, req: CompleteRequest, signal?: AbortSignal): Promise<CompleteResult> {
  const { text: docText, macros: allMacros } = docContext(doc);
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

/* ------------------------------------------------------------------ rate limiting */

const buckets = new Map<string, number[]>();
/** true when `key` may make another request (`limit` per minute) */
export function allow(key: string, limit: number): boolean {
  const now = Date.now();
  const arr = (buckets.get(key) ?? []).filter(t => now - t < 60000);
  if (arr.length >= limit) { buckets.set(key, arr); return false; }
  arr.push(now);
  buckets.set(key, arr);
  return true;
}
