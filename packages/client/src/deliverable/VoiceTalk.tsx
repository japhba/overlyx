/**
 * Push to talk beside the comment pen (voice.ts records, core/voicecomment.ts makes comments of it):
 *
 * - `TalkButtons`, in the Draw row while the comment pen is in hand: the microphone — held, it records
 *   until let go (draw with the other hand, or the Pencil); a short tap records hands-free —, and the
 *   lock, which keeps a recording going hands-free (or starts one);
 * - `VoicePill`, over the canvas while recording (the Draw row may fold away meanwhile): the time, the
 *   words heard last (or, while the recording goes to Whisper / Gemini afterwards, how loud it hears
 *   you), Stop; then "Making the comment…", and what went wrong, if anything.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { voiceView, subscribeVoice, startTalk, releaseTalk, stopTalk, setLocked, canTalk, hearer, primeVoice, type VoiceView } from './voice';
import { clock } from '@overlyx/core/voicecomment.ts';

function useVoice(): VoiceView {
  const [v, setV] = useState(voiceView);
  useEffect(() => subscribeVoice(setV), []);
  return v;
}

/** a press shorter than this is a tap: hands-free */
const TAP_MS = 350;

const MIC = '<svg viewBox="0 0 16 16" fill="none"><rect x="5.5" y="1.5" width="5" height="8.5" rx="2.5" stroke="currentColor" stroke-width="1.3"/><path d="M3 7.5a5 5 0 0 0 10 0M8 12.5V15M5.5 15h5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
const STOP = '<svg viewBox="0 0 16 16"><rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor"/></svg>';
const LOCK = '<svg viewBox="0 0 16 16" fill="none"><rect x="3.5" y="7" width="9" height="7" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" stroke="currentColor" stroke-width="1.3"/></svg>';
const UNLOCK = '<svg viewBox="0 0 16 16" fill="none"><rect x="3.5" y="7" width="9" height="7" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M5.5 7V5a2.5 2.5 0 0 1 4.9-.7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';

/** `owner`: the editor whose comments the recording makes; `slide`: the slide it shows now */
export function TalkButtons({ owner, slide }: { owner: object; slide: () => number }) {
  const v = useVoice();
  const down = useRef(0);
  // who will hear it (Whisper needs the server's word on the account's keys) — known before the first press
  useEffect(() => { primeVoice(); }, []);
  if (!canTalk()) return null;
  const recording = v.phase === 'recording' || v.phase === 'starting';
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    // recording hands-free: a tap stops it
    if (recording && v.locked) { void stopTalk(); return; }
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    down.current = performance.now();
    void startTalk(false, owner, slide());
  };
  const onUp = (e: PointerEvent) => {
    if (!down.current) return;
    e.preventDefault();
    const held = performance.now() - down.current;
    down.current = 0;
    if (held < TAP_MS) setLocked(true);
    else releaseTalk();
  };
  return (
    <span class="dl-talk" data-dl-talk>
      <button type="button" class={'tb-btn dl-talk-mic' + (recording ? ' on' : '')} data-tb="dk-ink-talk" aria-pressed={recording}
        title={recording ? (v.locked ? 'Recording — tap to stop' : 'Recording — let go to finish') : `Hold to talk: what you say while drawing with the comment pen becomes a comment on the slide (let go to finish; a tap records hands-free). Turned into words by ${hearer()}.`}
        onPointerDown={onDown as unknown as (e: Event) => void} onPointerUp={onUp as unknown as (e: Event) => void} onPointerCancel={onUp as unknown as (e: Event) => void}
        onContextMenu={e => e.preventDefault()}
        dangerouslySetInnerHTML={{ __html: recording && v.locked ? STOP : MIC }} />
      <button type="button" class={'tb-btn dl-talk-lock' + (v.locked ? ' active' : '')} data-tb="dk-ink-talklock" aria-pressed={v.locked}
        title={v.locked ? 'Hands-free: recording until the microphone is tapped (click to go back to holding)' : 'Record hands-free: keeps recording without holding the microphone'}
        onClick={() => { if (recording) setLocked(!v.locked); else void startTalk(true, owner, slide()); }}
        dangerouslySetInnerHTML={{ __html: v.locked ? LOCK : UNLOCK }} />
    </span>
  );
}

/**
 * Over the canvas while the comment pen is in hand (`armed`) or a recording goes on — the Draw row
 * folds away as one draws: the microphone and the lock; while recording the time and the words heard
 * last; then "Making the comment…", and for a moment what went wrong, if anything.
 */
export function VoicePill({ armed, owner, slide }: { armed: boolean; owner: object; slide: () => number }) {
  const v = useVoice();
  const [, tick] = useState(0);
  useEffect(() => {
    if (v.phase !== 'recording') return;
    const t = setInterval(() => tick(n => n + 1), 500);
    return () => clearInterval(t);
  }, [v.phase]);
  const [errShown, setErrShown] = useState<string | null>(null);
  useEffect(() => {
    if (!v.error) return;
    setErrShown(v.error);
    const t = setTimeout(() => setErrShown(null), 6000);
    return () => clearTimeout(t);
  }, [v.error]);
  const recording = v.phase === 'recording' || v.phase === 'starting';
  if (!armed && v.phase === 'idle' && !errShown) return null;
  if (!canTalk()) return null;
  return (
    <div class={'dl-voicepill' + (recording ? ' rec' : '') + (v.phase === 'working' ? ' working' : '')} role="status" aria-live="polite" data-dl-voicepill
      onPointerDown={e => e.stopPropagation()}>
      <TalkButtons owner={owner} slide={slide} />
      {recording && <>
        <span class="dl-voicepill-dot" aria-hidden="true" />
        <span class="dl-voicepill-time">{clock(Date.now() - v.since)}</span>
        {v.level !== null && <span class="dl-voicepill-level" aria-hidden="true" style={`--lv:${v.level}`} />}
        <span class="dl-voicepill-what">{v.caption || (v.locked ? 'Listening — tap the microphone to stop' : 'Listening — let go to finish')}</span>
      </>}
      {v.phase === 'working' && <span class="dl-voicepill-what">Making the comment…</span>}
      {v.phase === 'idle' && (errShown
        ? <span class="dl-voicepill-what error" role="alert">{errShown}</span>
        : <span class="dl-voicepill-what hint">Hold to talk</span>)}
    </div>
  );
}
