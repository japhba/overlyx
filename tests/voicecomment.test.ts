/**
 * The comment pen's spoken comments (core/voicecomment.ts): a recording and the comment strokes drawn
 * with it become threads per slide, kept in the page's HTML (html/review.ts), read by agents
 * (list_comments), resolved with their strokes; the pen's presets (deliverable/deckink.ts).
 */
import { describe, it, expect } from 'vitest';
import { planVoiceComments, agentComments, resolveThreadText, commentInkPaths, looseCommentInk, slideAt, clock, unionBox, LEAD_MS, type CommentStroke, type Take } from '../packages/core/src/voicecomment.ts';
import { parseThreads, threadsValue, reviewOf, publishedText, cleanFragment, COMMENT_INK_ATTR, type Thread } from '../packages/core/src/html/review.ts';
import { COMMENT_INK } from '../packages/core/src/inkpresets.ts';
import { defaultDeckInk, deckInkStyle, patchDeckInk } from '../packages/client/src/deliverable/deckink';

const T0 = Date.UTC(2026, 10, 7, 12, 0, 0);
const stroke = (id: string, slide: number, at: number, x = 100, on?: string[]): CommentStroke => ({ id, slide, at: T0 + at, rect: { x, y: 50, w: 40, h: 20 }, ...(on ? { on } : {}) });
const take = (p: Partial<Take>): Take => ({ start: T0, end: T0 + 10_000, said: [], how: 'device', slides: [{ t: 0, slide: 2 }], ...p });

describe('a recording and its strokes become threads', () => {
  it('one slide: the words, the strokes drawn during it and shortly before, their box and what lies under them', () => {
    const plans = planVoiceComments(take({ said: [{ t: 400, text: ' Make this  shorter ' }, { t: 3000, text: 'and drop the logo' }] }),
      [stroke('k1', 2, -5000, 100, ['“Results”']), stroke('k2', 2, 2000, 300, ['Picture']), stroke('old', 2, -LEAD_MS - 1000), stroke('after', 2, 60_000)]);
    expect(plans).toHaveLength(1);
    expect(plans[0].slide).toBe(2);
    expect(plans[0].text).toBe('Make this shorter and drop the logo');
    expect(plans[0].voice).toMatchObject({ secs: 10, how: 'device', said: [{ t: 400, text: 'Make this shorter' }, { t: 3000, text: 'and drop the logo' }] });
    expect(plans[0].voice.start).toBe(new Date(T0).toISOString());
    expect(plans[0].ink).toEqual({ ids: ['k1', 'k2'], box: [100, 50, 240, 20], on: ['“Results”', 'Picture'] });
  });
  it('strokes already in a thread are not taken again', () => {
    const plans = planVoiceComments(take({ said: [{ t: 0, text: 'again' }] }), [stroke('k1', 2, 1000)], new Set(['k1']));
    expect(plans[0].ink).toBeUndefined();
  });
  it('turning the slide while talking: a thread per slide, the words said on each; a slide only drawn on gets all the words', () => {
    const t = take({ said: [{ t: 500, text: 'This title' }, { t: 6000, text: 'and this chart' }], slides: [{ t: 0, slide: 1 }, { t: 5000, slide: 4 }] });
    expect(slideAt(t, 4999)).toBe(1);
    expect(slideAt(t, 5000)).toBe(4);
    const plans = planVoiceComments(t, [stroke('a', 1, 1000), stroke('b', 4, 7000), stroke('c', 7, 8000)]);
    expect(plans.map(p => [p.slide, p.text, p.ink?.ids])).toEqual([[1, 'This title', ['a']], [4, 'and this chart', ['b']], [7, 'This title and this chart', ['c']]]);
  });
  it('words without strokes are a comment on the slide shown; nothing said or drawn is none', () => {
    expect(planVoiceComments(take({ said: [{ t: 0, text: 'Too much text here' }] }), [])).toEqual([expect.objectContaining({ slide: 2, text: 'Too much text here' })]);
    expect(planVoiceComments(take({}), [])).toEqual([]);
  });
  it('a recording nothing could hear: kept, the comment says so', () => {
    const plans = planVoiceComments(take({ how: 'none', audio: 'talk/comments/voice-1.webm' }), [stroke('k', 2, 100)]);
    expect(plans[0].text).toMatch(/not transcribed/);
    expect(plans[0].voice).toMatchObject({ how: 'none', audio: 'talk/comments/voice-1.webm' });
  });
  it('clock and boxes', () => {
    expect(clock(7_400)).toBe('0:07');
    expect(clock(62_000)).toBe('1:02');
    expect(clock(3_723_000)).toBe('1:02:03');
    expect(unionBox([])).toEqual([0, 0, 0, 0]);
  });
});

const voiceThread: Thread = {
  id: 'c1', by: 'Kim Lee', at: '2026-11-07 12:00', text: 'Make this shorter',
  voice: { start: new Date(T0).toISOString(), secs: 4.2, said: [{ t: 400, text: 'Make this shorter' }], how: 'device' },
  ink: { ids: ['k1', 'k2'], box: [100, 50, 240, 20], on: ['“Hello world”'] },
};
const PAGE = (threads: string) => `<!doctype html>
<html>
<head>
<meta name="overlyx" content="deck">
</head>
<body>

<section class="slide" data-ol-comments='${threads}'>
  <h1 style="position: absolute; left: 100px; top: 80px">Hello world</h1>
  <svg class="ol-ink" ${COMMENT_INK_ATTR}="k1" style="position: absolute; left: 100px; top: 50px; width: 40px; height: 20px" viewBox="0 0 40 20"><g fill="none" stroke="${COMMENT_INK}"><path d="M0 0L40 20"/></g></svg>
  <svg class="ol-ink" ${COMMENT_INK_ATTR}="k2" style="position: absolute; left: 300px; top: 50px; width: 40px; height: 20px" viewBox="0 0 40 20"><g fill="none" stroke="${COMMENT_INK}"><path d="M0 0L40 20"/></g></svg>
  <svg class="ol-ink" ${COMMENT_INK_ATTR}="k3" style="position: absolute; left: 500px; top: 50px; width: 40px; height: 20px" viewBox="0 0 40 20"><g fill="none" stroke="${COMMENT_INK}"><path d="M0 0L40 20"/></g></svg>
  <svg class="ol-ink" style="position: absolute; left: 10px; top: 10px; width: 4px; height: 4px" viewBox="0 0 4 4"><g fill="none" stroke="#202124"><path d="M0 0L4 4"/></g></svg>
</section>

</body>
</html>
`;

describe('kept in the page, read by agents, resolved with the strokes', () => {
  const page = PAGE(threadsValue([voiceThread])!);
  it('the thread keeps what was said and the strokes through the HTML', () => {
    expect(parseThreads(threadsValue([voiceThread]))).toEqual([voiceThread]);
    expect(reviewOf(page).threads[0].thread).toEqual(voiceThread);
  });
  it('agents read slide, words at their time, strokes and what is under them', () => {
    expect(agentComments(reviewOf(page).threads)).toEqual([{
      index: 0, slide: 1, on: 'Slide 1', resolved: false,
      messages: [{ author: 'Kim Lee', time: '2026-11-07 12:00', text: 'Make this shorter' }],
      spoken: { said: [{ at: '0:00', text: 'Make this shorter' }], seconds: 4.2, transcribed_by: 'device' },
      drawn: { strokes: ['k1', 'k2'], box: { x: 100, y: 50, w: 240, h: 20 }, over: ['“Hello world”'] },
    }]);
  });
  it('resolving takes its strokes away, not the others; the content ink stays', () => {
    const r = resolveThreadText(page, 0);
    expect(r.inkRemoved).toBe(2);
    expect(r.text).not.toContain(`${COMMENT_INK_ATTR}="k1"`);
    expect(r.text).not.toContain(`${COMMENT_INK_ATTR}="k2"`);
    expect(r.text).toContain(`${COMMENT_INK_ATTR}="k3"`);
    expect(r.text).toContain('stroke="#202124"');
    expect(reviewOf(r.text).threads[0].thread.done).toBe(true);
    expect(looseCommentInk(r.text)).toEqual(['k3']);
    expect(commentInkPaths(page, ['k2', 'k3'])).toHaveLength(2);
    expect(() => resolveThreadText(page, 3)).toThrow(/No comment thread at index 3/);
  });
  it('the comment pen\'s strokes are review marks: not published (a stroke drawn — an insert — keeps its mark)', () => {
    const out = publishedText(page);
    expect(out).not.toContain(COMMENT_INK_ATTR);
    expect(out).not.toContain('data-ol-comments');
    expect(out).toContain('stroke="#202124"');
    const drawn = `<svg class="ol-ink" ${COMMENT_INK_ATTR}="k9"><path d="M0 0"/></svg>`;
    expect(cleanFragment(drawn)).toBe(drawn);
  });
});

describe('the comment pen\'s presets', () => {
  it('draws in its own orange, marked as a comment, whatever colour is asked of it', () => {
    let ink = patchDeckInk(defaultDeckInk(), { pen: 'comment' });
    ink = patchDeckInk(ink, { color: '#123456', slotColor: { idx: 0, color: '#654321' } });
    const st = deckInkStyle(ink);
    expect(st).toMatchObject({ color: COMMENT_INK, opacity: 1, comment: true });
    expect(ink.pens.comment.colors).toEqual([COMMENT_INK]);
    expect(deckInkStyle(patchDeckInk(ink, { pen: 'pen' })).comment).toBeUndefined();
  });
});
