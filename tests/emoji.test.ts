import { describe, expect, it, vi } from 'vitest';

vi.mock('../packages/server/src/agentkeys.ts', () => ({
  keyOf: (id: number) => (id === 1 ? 'sk-test' : null),
  upstreamOf: () => 'http://openai.stand-in',
}));
vi.mock('../packages/server/src/ai.ts', () => ({
  AiError: class AiError extends Error { constructor(message: string, public status = 502) { super(message); } },
}));

import { emojiRanges, isEmoji, faceLatexOpen, faceSpan, parseFace, EMOJI_FONTS } from '../packages/core/src/index.ts';
import { EMOJI_DATA } from '../packages/client/src/editor/emoji/emojidata';
import { makeEmoji, emojiPrompt } from '../packages/server/src/emojimake.ts';

describe('emoji in text', () => {
  it('finds emoji with skin tones, flags, keycaps and joined sequences, but not plain symbols', () => {
    const text = 'Hi 😀 👍🏽 🇩🇪 © ↔ ❤️ 1️⃣ 👩‍💻 ok';
    expect(emojiRanges(text).map(([a, b]) => text.slice(a, b))).toEqual(['😀', '👍🏽', '🇩🇪', '❤️', '1️⃣', '👩‍💻']);
    expect(isEmoji('©')).toBe(false);
    expect(isEmoji('🏳️‍🌈')).toBe(true);
  });

  it('writes an emoji font the way any font by name is written', () => {
    expect(faceLatexOpen(parseFace('Noto Color Emoji')!)).toBe('\\olfont{Noto Color Emoji}{');
    expect(faceLatexOpen(parseFace('Noto Emoji|300')!)).toBe('\\olfont[300]{Noto Emoji}{');
    expect(faceSpan(parseFace('Noto Emoji|700')!)).toBe(`<span style="font-family: 'Noto Emoji'; font-weight: 700">`);
    expect(EMOJI_FONTS.every(f => f.face === null || parseFace(f.face))).toBe(true);
  });
});

describe('the emoji keyboard data', () => {
  const rows = EMOJI_DATA.flatMap(([, text]) => text.split('\n').map(l => l.split('\t')));
  it('puts skin tones and colours beside their emoji', () => {
    expect(rows.find(r => r[1] === 'thumbs up')?.[2]).toBe('👍🏻 👍🏼 👍🏽 👍🏾 👍🏿');
    expect(rows.find(r => r[1] === 'red heart')?.[2]?.split(' ')).toContain('💙');
    expect(rows.some(r => r[1] === 'blue heart')).toBe(false);
    expect(rows.length).toBeGreaterThan(1500);
  });
});

describe('Make an emoji (OpenAI image edits, a stand-in)', () => {
  const png = 'iVBORw0KGgoAAAANSUhEUg==';
  it('sends the examples and the description, falls back when the model is unknown', async () => {
    const calls: { url: string; model: string; images: number; background: string; prompt: string }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: { body: FormData }) => {
      const f = init.body;
      calls.push({ url, model: String(f.get('model')), images: f.getAll('image[]').length, background: String(f.get('background')), prompt: String(f.get('prompt')) });
      if (f.get('model') === 'gpt-image-sunburst') return new Response(JSON.stringify({ error: { message: 'The model `gpt-image-sunburst` does not exist', param: 'model', code: 'model_not_found' } }), { status: 404 });
      return new Response(JSON.stringify({ created: 1, data: [{ b64_json: png }] }), { status: 200 });
    });
    const out = await makeEmoji({ description: 'a cat reading a book', font: 'Noto Color Emoji', examples: [png, 'data:image/png;base64,' + png] }, 1);
    expect(out).toEqual({ image: png, model: 'gpt-image-1' });
    expect(calls.map(c => c.model)).toEqual(['gpt-image-sunburst', 'gpt-image-1']);
    expect(calls[0]).toMatchObject({ url: 'http://openai.stand-in/v1/images/edits', images: 2, background: 'transparent' });
    expect(calls[0].prompt).toBe(emojiPrompt('a cat reading a book', 'Noto Color Emoji'));
    vi.unstubAllGlobals();
  });

  it('says so when the account has no OpenAI key', async () => {
    await expect(makeEmoji({ description: 'a cat', font: 'Noto Emoji', examples: [png] }, 2)).rejects.toThrow(/own OpenAI API key/);
  });
});
