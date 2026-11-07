/**
 * Spoken comments with the comment pen (the user, 7 Nov 2026: "a comment pen that renders in high-vis
 * orange with a glow underneath … a push to talk (+lock option) button that records commentary given
 * alongside drawing. Process this into a format that makes it usable for agents to implement feedback").
 *
 * The comment pen's strokes are ordinary ink objects marked as review marks (`data-ol-comment-ink`,
 * html/review.ts COMMENT_INK_ATTR). A recording (a take) and the comment strokes drawn during it — or
 * in the half minute before it — become comment threads, one per slide they touch, holding the words
 * at their seconds from the start (`voice`), which strokes they are about, their box and the objects
 * under them (`ink`). Agents read them with the MCP's list_comments (agentComments below) and see the
 * strokes on render_page; resolving a thread takes its strokes away.
 *
 * Pure data work, tested without a browser (tests/voicecomment.test.ts).
 */
import { COMMENT_INK_ATTR, COMMENTS, parseThreads, threadsOp, reviewOf, type InkRef, type Thread, type Voice, type ReviewThread } from './html/review.ts';
import { parseSource, walk, attr, pathOf, elementAt, opSplices, applySplices, type Path } from './html/source.ts';

/** a comment pen's stroke as the editor noted it: its id, slide, box there (px), when it ended (epoch ms), what lies under it */
export interface CommentStroke { id: string; slide: number; rect: { x: number; y: number; w: number; h: number }; at: number; on?: string[] }

/**
 * One recording: its start and end (epoch ms), the words heard at their ms from the start, how they
 * became words, the recording's project path when it was kept, and the slide shown from each moment on
 * (ms from the start; the first at 0)
 */
export interface Take {
  start: number; end: number;
  said: { t: number; text: string }[];
  how: Voice['how'];
  audio?: string;
  slides: { t: number; slide: number }[];
}

/** a thread to make: on which slide, its words, what was said, the strokes */
export interface VoicePlan { slide: number; text: string; voice: Voice; ink?: InkRef }

/** strokes this long before a recording began still belong to it (drawn first, then explained) */
export const LEAD_MS = 30_000;
/** and this long after it ended (the last stroke finished as the button is let go) */
export const TRAIL_MS = 3_000;

const tidy = (s: string) => s.replace(/\s+/g, ' ').trim();

/** the words of a take's stretches, as one text */
export function spoken(said: readonly { text: string }[]): string {
  return tidy(said.map(s => s.text).join(' '));
}

/** "0:07", "1:02:03" — a time into a recording */
export function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m)) + ':' + String(r).padStart(2, '0');
}

/** the slide shown `t` ms into a take */
export function slideAt(take: Pick<Take, 'slides'>, t: number): number {
  let s = take.slides[0]?.slide ?? 0;
  for (const m of [...take.slides].sort((a, b) => a.t - b.t)) { if (m.t <= t) s = m.slide; else break; }
  return s;
}

/** the box round some boxes (x, y, w, h; rounded px) */
export function unionBox(rects: readonly { x: number; y: number; w: number; h: number }[]): [number, number, number, number] {
  if (!rects.length) return [0, 0, 0, 0];
  const x0 = Math.min(...rects.map(r => r.x)), y0 = Math.min(...rects.map(r => r.y));
  const x1 = Math.max(...rects.map(r => r.x + r.w)), y1 = Math.max(...rects.map(r => r.y + r.h));
  return [Math.round(x0), Math.round(y0), Math.round(x1 - x0), Math.round(y1 - y0)];
}

/**
 * The threads a take makes, in the order its slides came up: one per slide it spoke on or drew on.
 * `strokes`: the comment strokes noted (those of `claimed` — already in a thread — left out). A slide
 * drawn on without words of its own gets the whole take's words. Nothing said and nothing drawn: none.
 */
export function planVoiceComments(take: Take, strokes: readonly CommentStroke[], claimed: ReadonlySet<string> = new Set()): VoicePlan[] {
  const mine = strokes.filter(s => !claimed.has(s.id) && s.at >= take.start - LEAD_MS && s.at <= take.end + TRAIL_MS);
  const said = take.said.map(s => ({ t: Math.max(0, Math.round(s.t)), text: tidy(s.text) })).filter(s => s.text);
  const order: number[] = [];
  const seen = (slide: number) => { if (!order.includes(slide)) order.push(slide); };
  // (in time: words and strokes as they came)
  const events = [
    ...said.map(s => ({ t: s.t, slide: slideAt(take, s.t) })),
    ...mine.map(s => ({ t: s.at - take.start, slide: s.slide })),
  ].sort((a, b) => a.t - b.t);
  for (const e of events) seen(e.slide);
  const all = spoken(said);
  const secs = Math.max(0, Math.round((take.end - take.start) / 100) / 10);
  const plans: VoicePlan[] = [];
  for (const slide of order) {
    const own = said.filter(s => slideAt(take, s.t) === slide);
    const ink = mine.filter(s => s.slide === slide);
    const words = own.length ? spoken(own) : all;
    if (!words && !ink.length) continue;
    const text = words || (take.how === 'none' && take.audio ? 'Spoken comment (not transcribed: listen to the recording)' : 'Drawn comment');
    const voice: Voice = { start: new Date(take.start).toISOString(), secs, said: own.length ? own : said, how: take.how, ...(take.audio ? { audio: take.audio } : {}) };
    const on = [...new Set(ink.flatMap(s => s.on ?? []))].slice(0, 8);
    plans.push({
      slide, text, voice,
      ...(ink.length ? { ink: { ids: ink.map(s => s.id), box: unionBox(ink.map(s => s.rect)), ...(on.length ? { on } : {}) } } : {}),
    });
  }
  return plans;
}

/** a new comment stroke's id */
export function commentInkId(): string {
  return 'k' + Date.now().toString(36) + Math.floor(Math.random() * 46656).toString(36);
}

/** the paths of the comment strokes with these ids (document order) */
export function commentInkPaths(text: string, ids: readonly string[]): Path[] {
  if (!ids.length || !text.includes(COMMENT_INK_ATTR)) return [];
  const want = new Set(ids), out: Path[] = [];
  for (const el of walk(parseSource(text).doc)) { const v = attr(el, COMMENT_INK_ATTR); if (v !== null && want.has(v)) out.push(pathOf(el)); }
  return out;
}

/** the ids of the comment strokes in a text that no thread refers to (drawn without a word said) */
export function looseCommentInk(text: string): string[] {
  if (!text.includes(COMMENT_INK_ATTR)) return [];
  const ids: string[] = [];
  for (const el of walk(parseSource(text).doc)) { const v = attr(el, COMMENT_INK_ATTR); if (v) ids.push(v); }
  const held = new Set(reviewOf(text).threads.flatMap(t => t.thread.ink?.ids ?? []));
  return ids.filter(id => !held.has(id));
}

/**
 * A page's text with its `index`-th comment thread (reviewOf's order) resolved — or reopened — and, as
 * it is resolved, the comment pen's strokes it is about taken away (`keepInk`: left on the page). The
 * MCP's resolve_comment on a deck, poster or web page; the editor does the same through its operations.
 */
export function resolveThreadText(text: string, index: number, done = true, keepInk = false): { text: string; inkRemoved: number } {
  const threads = reviewOf(text).threads;
  const t = threads[index];
  if (!t) throw new Error(`No comment thread at index ${index} — this page has ${threads.length}.`);
  const src = parseSource(text);
  const el = elementAt(src.doc, t.path);
  if (!el) throw new Error('That comment is no longer there.');
  const next = parseThreads(attr(el, COMMENTS)).map(x => {
    if (x.id !== t.thread.id) return x;
    const { done: _was, ...rest } = x; void _was;
    return done ? { ...rest, done: true } : rest;
  });
  const gone = done && !keepInk ? commentInkPaths(text, t.thread.ink?.ids ?? []) : [];
  const splices = [...opSplices(src, threadsOp(t.path, next)), ...(gone.length ? opSplices(src, { t: 'remove', paths: gone }) : [])];
  return { text: applySplices(text, splices), inkRemoved: gone.length };
}

/* ------------------------------------------------------------------ what agents read */

export interface AgentComment {
  index: number;
  /** 1-based; null: a web page or poster without slides */
  slide: number | null;
  on: string;
  resolved: boolean;
  messages: { author: string; time: string; text: string }[];
  quote?: string;
  /** a spoken comment: its words at their time into the recording, how they were heard */
  spoken?: { said: { at: string; text: string }[]; seconds: number; transcribed_by: Voice['how']; recording?: string };
  /** drawn with the comment pen: the strokes' ids (the `data-ol-comment-ink` of `<svg class="ol-ink">`), their box on the slide (px of the page), what lies under them */
  drawn?: { strokes: string[]; box: { x: number; y: number; w: number; h: number }; over?: string[] };
}

/** a page's comment threads as list_comments gives them to agents (html/review.ts reviewOf's threads, in order) */
export function agentComments(threads: readonly ReviewThread[]): AgentComment[] {
  return threads.map((r, index) => {
    const t: Thread = r.thread;
    const c: AgentComment = {
      index, slide: r.slide >= 0 ? r.slide + 1 : null, on: r.what, resolved: !!t.done,
      messages: [{ author: t.by, time: t.at, text: t.text }, ...(t.re ?? []).map(x => ({ author: x.by, time: x.at, text: x.text }))],
    };
    if (t.quote) c.quote = t.quote;
    if (t.voice) c.spoken = { said: t.voice.said.map(s => ({ at: clock(s.t), text: s.text })), seconds: t.voice.secs, transcribed_by: t.voice.how, ...(t.voice.audio ? { recording: t.voice.audio } : {}) };
    if (t.ink) c.drawn = { strokes: t.ink.ids, box: { x: t.ink.box[0], y: t.ink.box[1], w: t.ink.box[2], h: t.ink.box[3] }, ...(t.ink.on?.length ? { over: t.ink.on } : {}) };
    return c;
  });
}
