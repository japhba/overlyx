/**
 * "Make an emoji…" in the emoji keyboard (client editor/emoji/make.ts): a description and a few emoji
 * of the chosen font drawn as pictures (PNG) go to an image model, which draws one new emoji in their
 * style on a transparent background. OpenAI's image edits endpoint (POST /v1/images/edits, multipart:
 * `model`, several `image[]`, `prompt`, `background=transparent`, `output_format=png`, `size`; the
 * answer `data[0].b64_json`) on the account's own OpenAI API key (agentkeys.ts) — never the server's,
 * which is there for spoken comments. The model is OVERLYX_AI_EMOJI_MODEL (default the one the owner
 * named, gpt-image-sunburst); when OpenAI does not know it, OVERLYX_AI_EMOJI_FALLBACK (gpt-image-1).
 * Built against the documented shape and tested with a stand-in (tests/emoji-make.test.ts): no real
 * request was made while writing it.
 */
import { keyOf, upstreamOf } from './agentkeys.ts';
import { AiError } from './ai.ts';

export const emojiModel = () => (process.env.OVERLYX_AI_EMOJI_MODEL ?? 'gpt-image-sunburst').trim() || 'gpt-image-sunburst';
export const emojiFallbackModel = () => (process.env.OVERLYX_AI_EMOJI_FALLBACK ?? 'gpt-image-1').trim() || 'gpt-image-1';

const MAX_EXAMPLES = 8;
const MAX_EXAMPLE_B64 = 400_000;
const PNG_B64 = /^iVBORw0KGgo[A-Za-z0-9+/]*=*$/;

export interface MakeEmojiRequest { description: string; font: string; examples: string[] }

export function emojiPrompt(description: string, font: string): string {
  return [
    `Draw one new emoji: ${description.trim()}.`,
    `The images given are emoji from the font "${font}". Draw the new emoji as if it belonged to that same font:`,
    'the same drawing style, outlines, shading, colour palette, proportions and level of detail.',
    'One single emoji, centred, filling the square with a little margin, on a fully transparent background —',
    'no text, no frame, no background colour, no drop shadow the examples do not have.',
  ].join(' ');
}

/** is this OpenAI error about the model (unknown, not allowed for images, not available to the key) */
function modelRefused(status: number, body: string): boolean {
  if (status === 404) return true;
  if (status !== 400 && status !== 403) return false;
  try {
    const e = (JSON.parse(body) as { error?: { param?: unknown; code?: unknown; message?: unknown } }).error;
    return e?.param === 'model' || e?.code === 'model_not_found' || /\bmodel\b/i.test(String(e?.message ?? ''));
  } catch { return /\bmodel\b/i.test(body); }
}

/** a new emoji as a PNG (base64), and the model that drew it */
export async function makeEmoji(req: MakeEmojiRequest, userId: number, signal?: AbortSignal): Promise<{ image: string; model: string }> {
  const description = String(req.description ?? '').trim().slice(0, 600);
  const font = String(req.font ?? '').replace(/[^A-Za-z0-9 ]/g, '').slice(0, 60) || 'Noto Color Emoji';
  if (!description) throw new AiError('Say what the emoji should show.', 400);
  const examples = (Array.isArray(req.examples) ? req.examples : []).map(String).slice(0, MAX_EXAMPLES).map(s => s.replace(/^data:image\/png;base64,/, ''));
  if (!examples.length || examples.some(s => s.length > MAX_EXAMPLE_B64 || !PNG_B64.test(s))) throw new AiError('The example emoji could not be read.', 400);
  const key = keyOf(userId, 'openai');
  if (!key) throw new AiError('Making an emoji needs your own OpenAI API key — add it from the model menu in Settings ▸ AI (OpenAI API).', 400);

  const ask = async (model: string): Promise<Response> => {
    const form = new FormData();
    form.append('model', model);
    examples.forEach((b64, i) => form.append('image[]', new Blob([new Uint8Array(Buffer.from(b64, 'base64'))], { type: 'image/png' }), `example-${i + 1}.png`));
    form.append('prompt', emojiPrompt(description, font));
    form.append('background', 'transparent');
    form.append('output_format', 'png');
    form.append('size', '1024x1024');
    form.append('quality', 'medium');
    form.append('n', '1');
    try {
      return await fetch(`${upstreamOf('openai')}/v1/images/edits`, { method: 'POST', signal: signal ?? AbortSignal.timeout(180_000), headers: { Authorization: `Bearer ${key}` }, body: form });
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw new AiError('cancelled', 499);
      throw new AiError(`Could not reach OpenAI: ${(e as Error).message}`);
    }
  };

  let model = emojiModel();
  let res = await ask(model);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (modelRefused(res.status, body) && emojiFallbackModel() !== model) {
      console.warn(`[ai] emoji: OpenAI does not take "${model}" (${res.status}), trying "${emojiFallbackModel()}"`);
      model = emojiFallbackModel();
      res = await ask(model);
    } else res = new Response(body, { status: res.status });
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let message = '';
    try { message = String((JSON.parse(body) as { error?: { message?: unknown } }).error?.message ?? ''); } catch { message = body.slice(0, 300); }
    if (res.status === 401) throw new AiError('OpenAI refused your key — replace it from the model menu (Settings ▸ AI).', 400);
    if (res.status === 429) throw new AiError(/quota|billing/i.test(body) ? 'Your OpenAI key has no credit left — see Billing at platform.openai.com.' : 'OpenAI is limiting requests on this key — try again in a minute.', 429);
    throw new AiError(`The image model could not draw the emoji (${res.status})${message ? `: ${message}` : ''}`, res.status === 400 ? 400 : 502);
  }
  const json = await res.json().catch(() => null) as { data?: { b64_json?: unknown }[] } | null;
  const image = json?.data?.[0]?.b64_json;
  if (typeof image !== 'string' || !PNG_B64.test(image)) throw new AiError('The image model sent no picture back.', 502);
  return { image, model };
}
