/**
 * Push to talk beside the comment pen (core/voicecomment.ts): hold the microphone to speak, let go to
 * finish; the lock (or a short tap) keeps it recording hands-free until it is tapped again. What is
 * said becomes words (speechchoice.ts: who, as Settings ▸ AI ▸ Spoken comments chooses) —
 *
 * - by Whisper where the account has an OpenAI key (its own or the server's): the browser's recording
 *   (webm / Safari's mp4) goes to POST /api/ai/transcribe when the microphone is let go, and the
 *   words come back with their times; meanwhile the pill shows how loud it hears you;
 * - on the device, where the browser has speech recognition (Chrome and Edge: Google's speech
 *   service; Safari, on the Mac and the iPad: Apple's) — words as they are heard, at their seconds;
 * - otherwise (Firefox, or the browser's service refusing) the recording goes to the server's Gemini
 *   (the OpenRouter model the ink reader uses) as 16 kHz WAV;
 * - and where none of them works the recording itself is kept (the editor puts it into the project),
 *   so nothing said is lost — the comment says it was not transcribed.
 *
 * One recording at a time, for the whole page (module state); the editor that shows the comment pen
 * takes each finished one (`onTake`) and makes its threads.
 */
import { api, type AiSpeechOptions } from '../api';
import { getPrefs } from '../prefs';
import { chooseHearer, recordingReaders, hearerLabel, type Hearer } from './speechchoice';

export type VoiceHow = 'device' | 'whisper' | 'server' | 'none';
/** a finished recording: start and end (epoch ms), the words at their ms from the start, how they were heard, the audio when nothing could hear it */
export interface VoiceTake { start: number; end: number; said: { t: number; text: string }[]; how: VoiceHow; audio?: Blob; slides: { t: number; slide: number }[]; owner: object | null }
/** what the buttons and the recording's pill show */
export interface VoiceView {
  phase: 'idle' | 'starting' | 'recording' | 'working';
  locked: boolean;
  /** epoch ms the recording began */
  since: number;
  /** the words heard last (what is being said, not yet final, after them) */
  caption: string;
  /** what made the words ('device' / 'whisper' / 'server'), shown once */
  how: VoiceHow | null;
  error: string | null;
  /** how loud the microphone hears it now (0–1) while a recording goes to the server; null: words are shown instead */
  level: number | null;
}

interface Rec {
  /** the editor recording (its comments; null: any) */
  owner: object | null;
  start: number;
  locked: boolean;
  said: { t: number; text: string }[];
  interim: string;
  slides: { t: number; slide: number }[];
  sr: SpeechRecognitionLike | null;
  /** the session of the recognizer (it is restarted after silences: its results count from 0 again) */
  session: number;
  heard: Map<string, number>;
  media: MediaRecorder | null;
  stream: MediaStream | null;
  chunks: Blob[];
  /** the microphone's loudness, measured while recording (stopped with it) */
  meter: { ctx: AudioContext; timer: ReturnType<typeof setInterval> } | null;
  stopping: boolean;
  /** told when the recognizer has ended (its last words in) */
  onEnd?: () => void;
}

interface SpeechRecognitionLike {
  continuous: boolean; interimResults: boolean; lang: string;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void; stop(): void; abort(): void;
}

let view: VoiceView = { phase: 'idle', locked: false, since: 0, caption: '', how: null, error: null, level: null };
let rec: Rec | null = null;
/** the browser's speech service refused this visit (network, service, language): recordings from now on */
let deviceRefused = false;
const subs = new Set<(v: VoiceView) => void>();
const takers = new Set<(t: VoiceTake) => void>();

function set(p: Partial<VoiceView>): void {
  view = { ...view, ...p };
  for (const fn of subs) fn(view);
}

export function voiceView(): VoiceView { return view; }
export function subscribeVoice(fn: (v: VoiceView) => void): () => void { subs.add(fn); return () => subs.delete(fn); }
/** the editors that make comments of recordings (each takes its own: VoiceTake.owner) */
export function onTake(fn: (t: VoiceTake) => void): () => void { takers.add(fn); return () => takers.delete(fn); }
/** another slide is shown in `owner`: what is said from now on is about it */
export function voiceSlide(slide: number, owner: object | null = null): void {
  if (!rec || rec.owner !== owner) return;
  const last = rec.slides[rec.slides.length - 1];
  if (last?.slide !== slide) rec.slides.push({ t: Date.now() - rec.start, slide });
}

function recognizer(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** what the server can transcribe with for this account (/api/ai/status), asked again after a minute (a key added meanwhile) */
let options: AiSpeechOptions | null = null;
let optionsAt = 0;
let asking: Promise<AiSpeechOptions | null> | null = null;
function askOptions(): Promise<AiSpeechOptions | null> {
  asking ??= api.aiStatus().then(s => { options = s.speech ?? null; optionsAt = Date.now(); set({}); return options; })
    .catch(() => options).finally(() => { asking = null; });
  return asking;
}
/** before the microphone is pressed (its button shows): learn who will hear it */
export function primeVoice(): void { if (!asking && (!optionsAt || Date.now() - optionsAt > 60_000)) void askOptions(); }

/** who hears the next recording, by the settings and what is here */
function nextHearer(): Hearer { return chooseHearer(getPrefs().speechEngine, options, !!recognizer() && !deviceRefused); }

/** whether this browser can record at all */
export function canTalk(): boolean {
  return !!recognizer() || (typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia);
}

/** who turns speech into words here, in a few words (the button's tooltip) */
export function hearer(): string { return hearerLabel(nextHearer(), options); }

/** start recording for `owner` (`locked`: hands-free until stopped; `slide`: the slide shown now) */
export async function startTalk(locked = false, owner: object | null = null, slide = 0): Promise<void> {
  if (rec || view.phase === 'starting' || view.phase === 'working') { if (rec && locked) setLocked(true); return; }
  set({ phase: 'starting', locked, caption: '', error: null, level: null });
  const r: Rec = { owner, start: Date.now(), locked, said: [], interim: '', slides: [{ t: 0, slide }], sr: null, session: 0, heard: new Map(), media: null, stream: null, chunks: [], meter: null, stopping: false };
  rec = r;
  try {
    // the browser hears it as it is said, or it is recorded for Whisper / Gemini / keeping
    const SR = nextHearer() === 'device' ? recognizer() : null;
    if (SR) startRecognizer(r, SR);
    else await startMedia(r);
  } catch (e) {
    rec = null;
    set({ phase: 'idle', locked: false, error: micError(e) });
    return;
  }
  if (rec !== r) return;   // stopped while starting
  set({ phase: 'recording', since: r.start, locked: r.locked, how: r.sr ? 'device' : view.how });
}

/** keep recording hands-free (or not: the next release ends it) */
export function setLocked(on: boolean): void {
  if (rec) rec.locked = on;
  set({ locked: on });
}

/** the button let go: ends a recording unless it is locked */
export function releaseTalk(): void { if (rec && !rec.locked) void stopTalk(); }

/** end the recording: its words (or audio) go to the editor */
export async function stopTalk(): Promise<void> {
  const r = rec;
  if (!r || r.stopping) return;
  r.stopping = true;
  const end = Date.now();
  set({ phase: 'working', locked: false });
  let audio: Blob | null = null;
  if (r.sr) await stopRecognizer(r);
  if (r.media) audio = await stopMedia(r);
  rec = null;
  // (words still being heard as it stopped count too)
  const said0 = r.interim.trim() ? [...r.said, { t: lastHeard(r), text: r.interim.trim() }] : r.said;
  let said = said0, how: VoiceHow = said.length ? 'device' : 'none';
  let failed = '';
  if (audio && !said.length) {
    // Whisper takes the recording as the browser made it; Gemini a 16 kHz WAV of it
    const recording = audio;
    for (const engine of recordingReaders(getPrefs().speechEngine, options ?? await askOptions())) {
      try {
        const out = await api.aiTranscribe({ audio: await base64(engine === 'whisper' ? recording : await toWav(recording)), lang: navigator.language, engine });
        said = (out.said ?? []).filter(s => s && typeof s.text === 'string' && s.text.trim()).map(s => ({ t: Math.max(0, Math.round(Number(s.t) * 1000) || 0), text: s.text.trim() }));
        how = (out.engine ?? engine) === 'whisper' ? 'whisper' : 'server';
        audio = null;
        failed = '';
        break;
      } catch (e) { failed = (e as Error)?.message || 'the transcription failed'; }
    }
  } else if (said.length) audio = null;
  set({ phase: 'idle', caption: '', level: null, how: how === 'none' ? view.how : how, ...(failed ? { error: `Not put into words — ${failed.replace(/\.$/, '')}. The recording is kept in the project.` } : {}) });
  const take: VoiceTake = { start: r.start, end, said, how: said.length ? how : 'none', ...(audio && audio.size ? { audio } : {}), slides: r.slides, owner: r.owner };
  for (const fn of takers) fn(take);
}

/** drop a recording without making anything of it (`owner` closing; null: whoever's) */
export function cancelTalk(owner: object | null = null): void {
  const r = rec;
  if (!r || (owner && r.owner !== owner)) return;
  rec = null;
  try { r.sr?.abort(); } catch { /* gone */ }
  try { if (r.media?.state !== 'inactive') r.media?.stop(); } catch { /* gone */ }
  stopMeter(r);
  r.stream?.getTracks().forEach(t => t.stop());
  set({ phase: 'idle', locked: false, caption: '', level: null });
}

const lastHeard = (r: Rec) => Math.max(0, Date.now() - r.start - 1000);

function micError(e: unknown): string {
  const n = (e as { name?: string; error?: string })?.name ?? (e as { error?: string })?.error ?? '';
  if (/NotAllowed|not-allowed|Security/.test(n)) return 'The microphone is not allowed for this page — allow it in the browser’s site settings.';
  if (/NotFound|audio-capture/.test(n)) return 'No microphone was found.';
  return 'Recording could not start: ' + ((e as Error)?.message || n || 'unknown error');
}

/* ------------------------------------------------------------------ the browser's speech recognition */

function startRecognizer(r: Rec, SR: new () => SpeechRecognitionLike): void {
  const sr = new SR();
  sr.continuous = true;
  sr.interimResults = true;
  sr.lang = navigator.language || 'en-US';
  const session = ++r.session;
  sr.onresult = e => {
    if (rec !== r && !r.stopping) return;
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i], key = `${session}:${i}`;
      if (!r.heard.has(key)) r.heard.set(key, Math.max(0, Date.now() - r.start - 600));
      const words = res[0]?.transcript ?? '';
      if (res.isFinal) { if (words.trim()) r.said.push({ t: r.heard.get(key)!, text: words.trim() }); }
      else interim += words;
    }
    r.interim = interim;
    set({ caption: captionOf(r) });
  };
  sr.onerror = e => {
    if (e.error === 'no-speech' || e.error === 'aborted') return;
    if (e.error === 'not-allowed' && !r.said.length) { cancelTalk(); set({ error: micError(e) }); return; }
    // the service refused (offline, not offered, not this language): a recording for the rest
    deviceRefused = true;
    r.sr = null;
    if (rec === r && !r.stopping) void startMedia(r).then(() => set({ how: null })).catch(err => set({ error: micError(err) }));
  };
  sr.onend = () => {
    // (it stops after a silence: started again while the recording goes on)
    if (rec === r && !r.stopping && r.sr === sr) startRecognizer(r, SR);
    else r.onEnd?.();
  };
  r.sr = sr;
  sr.start();
}

function stopRecognizer(r: Rec): Promise<void> {
  const sr = r.sr;
  if (!sr) return Promise.resolve();
  // the last words arrive as it ends (a moment after stop)
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); r.onEnd = undefined; resolve(); };
    const timer = setTimeout(done, 2000);
    r.onEnd = done;
    try { sr.stop(); } catch { done(); }
  });
}

function captionOf(r: Rec): string {
  const last = r.said.slice(-2).map(s => s.text).join(' ');
  // (the latest words: what fits the pill)
  const all = (last + ' ' + r.interim).replace(/\s+/g, ' ').trim();
  return all.length > 70 ? '…' + all.slice(-70) : all;
}

/* ------------------------------------------------------------------ a recording (no speech recognition here) */

async function startMedia(r: Rec): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  if (rec !== r) { stream.getTracks().forEach(t => t.stop()); return; }
  const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'].find(t => MediaRecorder.isTypeSupported?.(t));
  const media = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 32000 } : undefined);
  media.ondataavailable = e => { if (e.data.size) r.chunks.push(e.data); };
  media.start(1000);
  r.media = media;
  r.stream = stream;
  startMeter(r, stream);
  // (the pill says "Listening — let go to finish" beside the level)
  set({ caption: '' });
}

/** the microphone's loudness for the pill, ten times a second (it shows it is hearing you while nothing is put into words yet) */
function startMeter(r: Rec, stream: MediaStream): void {
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AC();
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    void ctx.resume?.().catch(() => {});
    const timer = setInterval(() => {
      if (rec !== r) return;
      // (a context the browser keeps suspended hears nothing: no bar then, rather than an empty one)
      if (ctx.state !== 'running') { if (view.level !== null) set({ level: null }); return; }
      an.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      // speech is around −30 dBFS: that fills most of the bar
      const db = 10 * Math.log10(sum / buf.length + 1e-10);
      set({ level: Math.round(Math.max(0, Math.min(1, (db + 60) / 45)) * 20) / 20 });
    }, 100);
    r.meter = { ctx, timer };
  } catch { /* no level, just the time */ }
}

function stopMeter(r: Rec): void {
  if (!r.meter) return;
  clearInterval(r.meter.timer);
  void r.meter.ctx.close().catch(() => {});
  r.meter = null;
}

function stopMedia(r: Rec): Promise<Blob> {
  const media = r.media!;
  return new Promise(resolve => {
    const done = () => { stopMeter(r); r.stream?.getTracks().forEach(t => t.stop()); resolve(new Blob(r.chunks, { type: media.mimeType || 'audio/webm' })); };
    if (media.state === 'inactive') { done(); return; }
    media.onstop = done;
    try { media.stop(); } catch { done(); }
  });
}

/** a recording as 16 kHz mono 16-bit WAV (what speech models take everywhere) */
async function toWav(blob: Blob): Promise<Blob> {
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AC();
  let buf: AudioBuffer;
  try { buf = await ctx.decodeAudioData(await blob.arrayBuffer()); } finally { void ctx.close(); }
  const rate = 16000, n = Math.max(1, Math.ceil(buf.duration * rate));
  const off = new OfflineAudioContext(1, n, rate);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  const pcm = (await off.startRendering()).getChannelData(0);
  const out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); out.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true); out.setUint32(24, rate, true);
  out.setUint32(28, rate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true); str(36, 'data'); out.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
  return new Blob([out.buffer], { type: 'audio/wav' });
}

function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).replace(/^data:[^,]*,/, ''));
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

/** the file name a kept recording gets (its type's ending) */
export function audioName(blob: Blob, at: number): string {
  const ext = /mp4|aac|m4a/.test(blob.type) ? 'm4a' : /ogg/.test(blob.type) ? 'ogg' : /wav/.test(blob.type) ? 'wav' : 'webm';
  const d = new Date(at), p = (n: number) => String(n).padStart(2, '0');
  return `voice-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
}
