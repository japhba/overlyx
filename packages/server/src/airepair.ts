/**
 * "Escalate to AI" document repair: for structural damage `repairTex` cannot mend mechanically
 * (a corrupted settings line, wrong \begin/\end{document} count, unbalanced braces — see
 * packages/core/src/tex/health.ts), send the broken file plus the OverLyX .tex format spec to an
 * OpenRouter model and propose a fix. The caller (index.ts) never applies it directly: the client
 * shows the proposal in a merge editor and the user approves it explicitly.
 */
import { config } from './config.ts';
import { MANAGED_BEGIN, MANAGED_END, SETTINGS_PREFIX, type HealthIssue } from '@overlyx/core/tex/index.ts';

export class AiRepairError extends Error {}

const TARGET_SPEC = `OverLyX ".tex format" — what a well-formed file looks like:

1. Ordinary LaTeX: `+ '`\\documentclass[...]{...}`' + ` then a preamble, then exactly one
   `+ '`\\begin{document} ... \\end{document}`' + ` pair. Anything a human LaTeX author would write is valid
   here — packages, macros, environments, comments.

2. Exactly one "managed block" inside the preamble (never inside \\begin{document}), delimited by
   these two literal marker lines:
   ${MANAGED_BEGIN}
   ${SETTINGS_PREFIX}{...json...}
   ${MANAGED_END}
   The settings line (prefix "${SETTINGS_PREFIX}") holds one JSON object with OverLyX's own state
   (document class, language, citation engine, change-tracking flags, etc.) — it must stay valid,
   parseable JSON on a single line. The block may also contain generated \\newcommand / macro lines
   above the settings line; preserve every one of them verbatim, in order.

3. Inside the body: OverLyX notes/comments look like
   %% @note
   %% first line of the note
   %% second line
   (a "%% " prefix on each line of the note text; "%% @comment" and "%% @greyedout" are the same
   shape for the other note kinds). Change tracking uses
   \\lyxadded{Author Name}{2026-08-29T12:00:00}{the inserted text}
   \\lyxdeleted{Author Name}{2026-08-29T12:00:00}{the deleted text}
   possibly followed by a bare \\lyxadded{...}{...}{¶} marking a tracked paragraph break.

Repair rules — follow these exactly:
- Fix ONLY the structural problems listed below. Never rewrite, rephrase, translate, or "improve"
  the user's prose, math, citations, or macros.
- Preserve every character of content you are not required to change, including whitespace inside
  paragraphs, comment text, and macro definitions.
- If the settings JSON is corrupted, reconstruct the smallest valid JSON object you can that keeps
  whatever keys/values are still legible in the damaged line; never invent settings that are not at
  least plausibly implied by the surrounding document (e.g. \\documentclass, language commands).
- If braces are unbalanced, find the specific spot that broke (an external edit is almost always a
  single dropped or duplicated character) rather than adding/removing braces elsewhere.
- If \\begin{document}/\\end{document} is missing or duplicated, restore exactly one of each in the
  position implied by the rest of the file.
- Output ONLY the complete, corrected file content — no markdown code fences, no explanation, no
  preamble like "Here is the fixed file". The very first character of your reply must be the first
  character of the file.`;

function stripFences(s: string): string {
  const t = s.trim();
  const m = /^```(?:[\w-]*)\n([\s\S]*?)\n```$/.exec(t);
  return m ? m[1] : t;
}

/** Extracts plain text from an OpenRouter/OpenAI-shaped chat completion message content. */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(p => (typeof p === 'object' && p && 'text' in p ? String((p as { text: unknown }).text ?? '') : '')).join('');
  return '';
}

/** Asks the configured OpenRouter model to repair `text`, given the issues the mechanical checker
 *  found. Returns the proposed full file content (never applies it). Throws AiRepairError on any
 *  failure (missing key, network error, empty/unusable response). */
export async function requestAiRepair(text: string, issues: HealthIssue[]): Promise<string> {
  if (!config.openrouter.apiKey) throw new AiRepairError('AI repair is not configured on this server (OPENROUTER_API_KEY is unset).');
  const issueList = issues.length
    ? issues.map(i => `- [${i.severity}] ${i.code}: ${i.message}`).join('\n')
    : '(the mechanical checker found nothing specific, but the user flagged this file as damaged — look for anything structurally wrong.)';
  const user = `Structural issues detected in this file:\n${issueList}\n\n` +
    `Here is the current file content verbatim, between the FILE markers (the markers themselves are ` +
    `not part of the file). Return only the corrected file content as instructed.\n\n<<<FILE\n${text}\nFILE>>>`;
  let res: Response;
  try {
    res = await fetch(`${config.openrouter.api}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.openrouter.apiKey}`,
        'HTTP-Referer': config.publicUrl || 'https://overlyx.app',
        'X-Title': 'OverLyX document repair',
      },
      body: JSON.stringify({
        model: config.openrouter.model,
        temperature: 0,
        messages: [
          { role: 'system', content: TARGET_SPEC },
          { role: 'user', content: user },
        ],
      }),
    });
  } catch (e) {
    throw new AiRepairError(`Could not reach OpenRouter: ${(e as Error).message}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new AiRepairError(`OpenRouter request failed (${res.status}): ${body.slice(0, 400)}`);
  }
  const json = await res.json().catch(() => null) as { choices?: { message?: { content?: unknown } }[] } | null;
  const content = messageText(json?.choices?.[0]?.message?.content).trim();
  if (!content) throw new AiRepairError('OpenRouter returned an empty response.');
  return stripFences(content);
}
