/**
 * Who puts a spoken comment into words (voice.ts records; Settings ▸ AI ▸ Spoken comments chooses):
 *
 * - **Whisper** — OpenAI's speech-to-text, on the account's own OpenAI key or the server's
 *   (server ai.ts transcribeWhisper): the recording goes up as the browser made it when the
 *   microphone is let go; the best words and the times of each word, in every browser alike;
 * - **this browser's speech recognition** (Google's service in Chrome and Edge, Apple's in Safari):
 *   words as they are heard, nothing through the server;
 * - **Gemini** on the server's OpenRouter key (ai.ts transcribeSpeech): the recording as 16 kHz WAV.
 *
 * Automatic takes Whisper where the account has it, else the browser's, else Gemini; a choice that is
 * not available here falls back to that order. A recording nothing could hear is kept in the project.
 */
import type { AiSpeechOptions } from '../api';

export type SpeechChoice = 'auto' | 'whisper' | 'device' | 'gemini';
export type Hearer = 'whisper' | 'device' | 'gemini' | 'none';

const availableOf = (o: AiSpeechOptions | null, device: boolean): Record<Exclude<Hearer, 'none'>, boolean> =>
  ({ whisper: !!o?.whisper, device, gemini: !!o?.gemini });

/** who hears the next recording (`device`: this browser has speech recognition that has not refused) */
export function chooseHearer(choice: SpeechChoice, o: AiSpeechOptions | null, device: boolean): Hearer {
  const has = availableOf(o, device);
  if (choice !== 'auto' && has[choice]) return choice;
  return has.whisper ? 'whisper' : has.device ? 'device' : has.gemini ? 'gemini' : 'none';
}

/** the server's engines to try on a recording, in turn (the chosen one first; the browser heard nothing or refused) */
export function recordingReaders(choice: SpeechChoice, o: AiSpeechOptions | null): ('whisper' | 'gemini')[] {
  const order: ('whisper' | 'gemini')[] = choice === 'gemini' ? ['gemini', 'whisper'] : ['whisper', 'gemini'];
  return order.filter(e => (e === 'whisper' ? !!o?.whisper : !!o?.gemini));
}

/** the engine in a few words, for the microphone's tooltip and the settings */
export function hearerLabel(h: Hearer, o: AiSpeechOptions | null, ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''): string {
  if (h === 'whisper') return `OpenAI’s Whisper, on ${o?.whisper === 'own' ? 'your OpenAI key' : 'the OverLyX server’s OpenAI key'} (the recording is sent when you let go)`;
  if (h === 'device') return /Chrome|Edg\//.test(ua) ? 'this browser’s speech recognition (Google’s speech service)' : /Safari/.test(ua) ? 'this browser’s speech recognition (Apple’s)' : 'this browser’s speech recognition';
  if (h === 'gemini') return `Gemini on the OverLyX server (${o?.geminiModel ?? 'through OpenRouter'}; the recording is sent when you let go)`;
  return 'nothing here: the recording is kept in the project, not transcribed';
}

/** the settings' choices: what each is, whether it works here, why not */
export function speechChoices(o: AiSpeechOptions | null, device: boolean): { value: SpeechChoice; label: string; hint: string; available: boolean }[] {
  const has = availableOf(o, device);
  return [
    { value: 'auto', label: 'Automatic', available: true,
      hint: 'Whisper where there is an OpenAI key, else this browser’s speech recognition, else Gemini on the server.' },
    { value: 'whisper', label: o?.whisper === 'own' ? 'Whisper — your OpenAI key' : o?.whisper === 'server' ? 'Whisper — the server’s OpenAI key' : 'Whisper (OpenAI)', available: has.whisper,
      hint: has.whisper ? `The recording goes to OpenAI (${o?.whisperModel ?? 'whisper-1'}) when you let go: the best words, and when each was said — about $0.006 a minute${o?.whisper === 'own' ? ', on your key' : ''}.` : 'Add your OpenAI API key with “Use an OpenAI API key…” in the Rewrite model menu above, or the server’s administrator sets OVERLYX_OPENAI_API_KEY.' },
    { value: 'device', label: 'This browser’s speech recognition', available: has.device,
      hint: has.device ? 'Words as they are heard (Chrome and Edge: Google’s speech service; Safari: Apple’s). Nothing goes through the OverLyX server.' : 'This browser has none (Firefox).' },
    { value: 'gemini', label: 'Gemini on the server', available: has.gemini,
      hint: has.gemini ? `The recording goes through the OverLyX server to ${o?.geminiModel ?? 'Gemini'} (OpenRouter) when you let go.` : 'Not set up on this server (OPENROUTER_API_KEY).' },
  ];
}
