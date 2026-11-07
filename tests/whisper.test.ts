/**
 * Spoken comments through Whisper (server ai.ts transcribeWhisper, speechOptions, pickSpeech) against
 * a stand-in for OpenAI's transcription endpoint: the account's own OpenAI key before the server's,
 * the multipart request (the browser's recording as it is, verbose_json with word and segment times),
 * Whisper's segments cut into timed sentences, the errors in plain words; and the client's choice of
 * who hears a recording (deliverable/speechchoice.ts).
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import http from 'node:http';
import express from 'express';

const ROOT = vi.hoisted(() => {
  const { join } = require('node:path') as typeof import('node:path');
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const { rmSync, mkdirSync } = require('node:fs') as typeof import('node:fs');
  const root = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-whisper-test');
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, 'projects'), { recursive: true });
  process.env.OVERLYX_DATA_DIR = join(root, 'data');
  process.env.OVERLYX_PROJECTS_DIR = join(root, 'projects');
  process.env.OVERLYX_OPENAI_API_KEY = 'srv-key';
  process.env.OPENROUTER_API_KEY = '';
  return root;
});

let last: { auth?: string; body: string } | null = null;
let reply: { status: number; json: unknown } = { status: 200, json: {} };
const stub = express();
stub.get('/v1/models', (req, res) => { res.status(req.headers.authorization === 'Bearer own-key' ? 200 : 401).json({ data: [] }); });
stub.post('/v1/audio/transcriptions', express.raw({ type: '*/*', limit: '30mb' }), (req, res) => {
  last = { auth: req.headers.authorization, body: (req.body as Buffer).toString('latin1') };
  res.status(reply.status).json(reply.json);
});
const server = http.createServer(stub);
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
process.env.OVERLYX_LLM_UPSTREAM_OPENAI = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const { config } = await import('../packages/server/src/config.ts');
if (!config.dataDir.startsWith(ROOT)) throw new Error('the test would use the real data directory: ' + config.dataDir);
const ai = await import('../packages/server/src/ai.ts');
const { setKey, removeKey } = await import('../packages/server/src/agentkeys.ts');
const { chooseHearer, recordingReaders, speechChoices } = await import('../packages/client/src/deliverable/speechchoice.ts');

afterAll(async () => {
  server.close();
  (await import('node:fs')).rmSync(ROOT, { recursive: true, force: true });
});

/** the first bytes of a webm recording (EBML), as MediaRecorder writes in Chrome */
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(60, 7)]).toString('base64');
const VERBOSE = {
  text: 'Make the title shorter. Drop the logo here.',
  segments: [
    { start: 0.2, end: 3.9, text: ' Make the title shorter. Drop the logo here.', avg_logprob: -0.2, no_speech_prob: 0.01 },
    { start: 5, end: 7, text: ' Thank you.', avg_logprob: -1.4, no_speech_prob: 0.9 },
    { start: 8, end: 9.5, text: ' And the axis labels', avg_logprob: -0.3, no_speech_prob: 0.05 },
  ],
  words: [
    { word: 'Make', start: 0.24, end: 0.5 }, { word: 'the', start: 0.5, end: 0.6 }, { word: 'title', start: 0.6, end: 0.9 }, { word: 'shorter', start: 0.9, end: 1.4 },
    { word: 'Drop', start: 2.1, end: 2.3 }, { word: 'the', start: 2.3, end: 2.4 }, { word: 'logo', start: 2.4, end: 2.8 }, { word: 'here', start: 2.8, end: 3.1 },
    { word: 'Thank', start: 5.1, end: 5.3 }, { word: 'you', start: 5.3, end: 5.5 },
    { word: 'And', start: 8.1, end: 8.2 }, { word: 'the', start: 8.2, end: 8.3 }, { word: 'axis', start: 8.3, end: 8.7 }, { word: 'labels', start: 8.7, end: 9.2 },
  ],
};

describe('Whisper’s answer as a comment’s stretches', () => {
  it('cuts segments into sentences timed by their first words, and leaves out what Whisper calls silence', () => {
    expect(ai.whisperStretches(VERBOSE)).toEqual([
      { t: 0.24, text: 'Make the title shorter.' },
      { t: 2.1, text: 'Drop the logo here.' },
      { t: 8.1, text: 'And the axis labels' },
    ]);
  });
  it('without word times a sentence starts as far into its segment as into the text; a plain answer is one stretch', () => {
    const out = ai.whisperStretches({ segments: [{ start: 10, end: 20, text: 'One. Two three.' }] });
    expect(out[0]).toEqual({ t: 10, text: 'One.' });
    expect(out[1].text).toBe('Two three.');
    expect(out[1].t).toBeGreaterThan(12);
    expect(out[1].t).toBeLessThan(15);
    expect(ai.whisperStretches({ text: ' just words ' })).toEqual([{ t: 0, text: 'just words' }]);
    expect(ai.whisperStretches({ text: 'x', segments: [] })).toEqual([]);
    expect(ai.whisperStretches(null)).toEqual([]);
  });
  it('knows the browser’s recordings by their first bytes', () => {
    expect(ai.audioKind(Buffer.from(WEBM, 'base64'))?.ext).toBe('webm');
    expect(ai.audioKind(Buffer.concat([Buffer.from('RIFF\0\0\0\0WAVE'), Buffer.alloc(8)]))?.ext).toBe('wav');
    expect(ai.audioKind(Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A '), Buffer.alloc(8)]))?.mime).toBe('audio/mp4');
    expect(ai.audioKind(Buffer.concat([Buffer.from('OggS'), Buffer.alloc(12)]))?.ext).toBe('ogg');
    expect(ai.audioKind(Buffer.from('hello world, not audio'))).toBeNull();
  });
});

describe('which engine hears it', () => {
  it('Whisper on the account’s own key before the server’s; the one asked for when there', async () => {
    expect(ai.speechOptions(1)).toMatchObject({ whisper: 'server', gemini: false, whisperModel: 'whisper-1' });
    await setKey(1, 'openai', 'own-key');
    expect(ai.speechOptions(1).whisper).toBe('own');
    expect(ai.speechOptions(2).whisper).toBe('server');
    const both = { whisper: 'own' as const, gemini: true, whisperModel: 'whisper-1', geminiModel: 'g' };
    expect(ai.pickSpeech('gemini', both)).toBe('gemini');
    expect(ai.pickSpeech(undefined, both)).toBe('whisper');
    expect(ai.pickSpeech('whisper', { ...both, whisper: null })).toBe('gemini');
    expect(ai.pickSpeech('whisper', { ...both, whisper: null, gemini: false })).toBeNull();
  });
});

describe('transcribeWhisper', () => {
  it('sends the recording as it is with the account’s key, asking for word and segment times', async () => {
    reply = { status: 200, json: VERBOSE };
    const said = await ai.transcribeWhisper({ audio: WEBM, lang: 'en-GB' }, 1);
    expect(said.map(s => s.text)).toEqual(['Make the title shorter.', 'Drop the logo here.', 'And the axis labels']);
    expect(last!.auth).toBe('Bearer own-key');
    for (const part of ['name="model"', 'whisper-1', 'verbose_json', 'name="timestamp_granularities[]"', 'segment', 'word', 'filename="comment.webm"', 'name="language"']) expect(last!.body).toContain(part);
    expect(last!.body).toMatch(/name="language"\r\n\r\nen\r\n/);
  });
  it('another account uses the server’s key', async () => {
    reply = { status: 200, json: { text: 'Hi.', segments: [{ start: 0, end: 1, text: 'Hi.' }], words: [] } };
    expect(await ai.transcribeWhisper({ audio: WEBM }, 2)).toEqual([{ t: 0, text: 'Hi.' }]);
    expect(last!.auth).toBe('Bearer srv-key');
  });
  it('says plainly what went wrong', async () => {
    reply = { status: 401, json: { error: { message: 'Incorrect API key provided' } } };
    await expect(ai.transcribeWhisper({ audio: WEBM }, 1)).rejects.toMatchObject({ status: 400, message: expect.stringContaining('refused your key') });
    await expect(ai.transcribeWhisper({ audio: WEBM }, 2)).rejects.toMatchObject({ status: 502, message: expect.stringContaining('OVERLYX_OPENAI_API_KEY') });
    reply = { status: 429, json: { error: { message: 'You exceeded your current quota', code: 'insufficient_quota' } } };
    await expect(ai.transcribeWhisper({ audio: WEBM }, 1)).rejects.toMatchObject({ status: 429, message: expect.stringContaining('no credit') });
    reply = { status: 429, json: { error: { message: 'Rate limit reached' } } };
    await expect(ai.transcribeWhisper({ audio: WEBM }, 1)).rejects.toMatchObject({ status: 429, message: expect.stringContaining('try again') });
    await expect(ai.transcribeWhisper({ audio: Buffer.from('not audio at all, really').toString('base64') }, 1)).rejects.toMatchObject({ status: 400 });
    await expect(ai.transcribeWhisper({ audio: 'GkXf' + 'A'.repeat(ai.WHISPER_MAX_AUDIO) }, 1)).rejects.toMatchObject({ status: 413 });
  });
  it('without any OpenAI key it says where to add one', async () => {
    removeKey(1, 'openai');
    const saved = config.openai.apiKey;
    config.openai.apiKey = '';
    try {
      expect(ai.speechOptions(1).whisper).toBeNull();
      await expect(ai.transcribeWhisper({ audio: WEBM }, 1)).rejects.toMatchObject({ status: 503, message: expect.stringContaining('model menu') });
    } finally { config.openai.apiKey = saved; }
  });
});

describe('the client’s choice (speechchoice.ts)', () => {
  const whisper = { whisper: 'own' as const, gemini: true, whisperModel: 'whisper-1', geminiModel: 'google/x' };
  it('Automatic: Whisper, else the browser’s recognizer, else Gemini, else keeping the recording', () => {
    expect(chooseHearer('auto', whisper, true)).toBe('whisper');
    expect(chooseHearer('auto', { ...whisper, whisper: null }, true)).toBe('device');
    expect(chooseHearer('auto', { ...whisper, whisper: null }, false)).toBe('gemini');
    expect(chooseHearer('auto', null, false)).toBe('none');
  });
  it('a chosen engine wins where it is there, and falls back where not', () => {
    expect(chooseHearer('device', whisper, true)).toBe('device');
    expect(chooseHearer('gemini', whisper, true)).toBe('gemini');
    expect(chooseHearer('device', whisper, false)).toBe('whisper');
    expect(recordingReaders('auto', whisper)).toEqual(['whisper', 'gemini']);
    expect(recordingReaders('gemini', whisper)).toEqual(['gemini', 'whisper']);
    expect(recordingReaders('auto', { ...whisper, whisper: null })).toEqual(['gemini']);
    expect(speechChoices({ ...whisper, whisper: null }, false).filter(c => !c.available).map(c => c.value)).toEqual(['whisper', 'device']);
  });
});
