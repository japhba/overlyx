/**
 * The Review pane beside a deck's, poster's or web page's canvas: its comment threads and suggested
 * changes (core html/review.ts keeps both in the page's text), those of the slide shown or of all
 * slides, in the order they are on the page — as Google Slides lists comments and Docs suggestions.
 * A suggestion is accepted or rejected here (or with the toolbar's Suggestion buttons when its object
 * is selected); a thread is answered, resolved, reopened, deleted. A click on a card selects what it
 * is on (and highlights the words it quotes).
 */
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { Path, DeliverableKind } from './protocol';
import { reviewHue, type Review, type ReviewChange, type ReviewThread } from '@overlyx/core/html/review.ts';
import { formatTimestamp } from '@overlyx/core';

export interface CommentDraft { path: Path | null; slide: number; quote?: string; what: string }

interface Props {
  review: Review;
  /** the slides' titles (decks and posters) */
  slideTitles: string[];
  current: number;
  kind: DeliverableKind;
  me: string;
  /** comments and accepting / rejecting allowed (not view only) */
  canEdit: boolean;
  focus: { path: Path; id: string } | null;
  draft: CommentDraft | null;
  submitDraft(text: string): void;
  cancelDraft(): void;
  select(path: Path, slide: number, threadId?: string): void;
  reply(t: ReviewThread, text: string): void;
  resolve(t: ReviewThread, done: boolean): void;
  remove(t: ReviewThread): void;
  accept(c: ReviewChange): void;
  reject(c: ReviewChange): void;
  acceptAll(): void;
  rejectAll(): void;
  close(): void;
}

/** "Jan Bauer" → "JB" */
export function initials(name: string): string {
  const w = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (!w.length) return '?';
  return (([...w[0]][0] ?? '') + (w.length > 1 ? [...w[w.length - 1]][0] ?? '' : '')).toUpperCase();
}

/** a stamp's time, short: today the time, else the day */
export function shortTime(at: string): string {
  if (!at) return '';
  const today = formatTimestamp().slice(0, 10);
  if (at.startsWith(today)) return at.slice(11);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(at);
  if (!m) return at;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(m[1] !== today.slice(0, 4) ? { year: 'numeric' } : {}) });
}

const Avatar = ({ name }: { name: string }) => (
  <span class="avatar dl-rv-avatar" style={{ background: `hsl(${reviewHue(name || '?')} 55% 45%)` }} data-initials={initials(name || '?').length}>{initials(name || '?')}</span>
);

const cmpPath = (a: Path, b: Path) => { for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i]; return a.length - b.length; };
const samePath = (a: Path | null | undefined, b: Path | null | undefined) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);

type Entry = { kind: 'change'; c: ReviewChange } | { kind: 'thread'; t: ReviewThread };

export function ReviewPane(p: Props) {
  const slideScoped = p.kind !== 'page';
  const [scope, setScope] = useState<'slide' | 'all'>(() => { try { return localStorage.getItem('ol.reviewScope') === 'all' ? 'all' : 'slide'; } catch { return 'slide'; } });
  const [showResolved, setShowResolved] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const setScopeSaved = (s: 'slide' | 'all') => { setScope(s); try { localStorage.setItem('ol.reviewScope', s); } catch { /* private window */ } };

  const onSlide = (slide: number) => !slideScoped || scope === 'all' || slide === p.current;
  const entries: Entry[] = [
    ...p.review.changes.filter(c => onSlide(c.slide)).map(c => ({ kind: 'change' as const, c })),
    ...p.review.threads.filter(t => onSlide(t.slide) && (showResolved || !t.thread.done || (p.focus && p.focus.id === t.thread.id))).map(t => ({ kind: 'thread' as const, t })),
  ];
  const where = (e: Entry) => (e.kind === 'change' ? e.c.path : e.t.path);
  entries.sort((a, b) => cmpPath(where(a), where(b)) || (a.kind === b.kind ? 0 : a.kind === 'change' ? -1 : 1));
  const resolvedHere = p.review.threads.filter(t => onSlide(t.slide) && t.thread.done).length;
  const changesAll = p.review.changes.length;

  // the thread looked at, in view
  useLayoutEffect(() => {
    if (!p.focus) return;
    const el = listRef.current?.querySelector(`[data-rv-thread="${CSS.escape(p.focus.id)}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [p.focus?.id]);

  // grouped by slide (all slides)
  let lastSlide = -2;
  const rows: JSX.Element[] = [];
  for (const e of entries) {
    const slide = e.kind === 'change' ? e.c.slide : e.t.slide;
    if (slideScoped && scope === 'all' && slide !== lastSlide) {
      lastSlide = slide;
      rows.push(<div class="dl-rv-slidehead" key={`s${slide}`}>{slide >= 0 ? `Slide ${slide + 1}${p.slideTitles[slide] ? ' · ' + p.slideTitles[slide] : ''}` : 'Page'}</div>);
    }
    rows.push(e.kind === 'change'
      ? <ChangeCard key={`c${e.c.path.join('.')}:${e.c.by}`} c={e.c} {...p} />
      : <ThreadCard key={`t${e.t.path.join('.')}:${e.t.thread.id}`} t={e.t} {...p} />);
  }

  return (
    <div class="dl-rv" data-dl-review>
      <div class="dl-anim-head">
        <span>Comments &amp; suggestions</span>
        <button class="dl-btn" onClick={p.close} title="Close">×</button>
      </div>
      <div class="dl-rv-bar">
        {slideScoped && (
          <span class="dl-rv-scope" role="radiogroup">
            <button class={'dl-btn' + (scope === 'slide' ? ' on' : '')} role="radio" aria-checked={scope === 'slide'} onClick={() => setScopeSaved('slide')} data-rv-scope="slide">This slide</button>
            <button class={'dl-btn' + (scope === 'all' ? ' on' : '')} role="radio" aria-checked={scope === 'all'} onClick={() => setScopeSaved('all')} data-rv-scope="all">All</button>
          </span>
        )}
        <label class="dl-anim-check dl-rv-resolved"><input type="checkbox" checked={showResolved} onChange={e => setShowResolved((e.target as HTMLInputElement).checked)} data-rv-resolved /> Resolved{resolvedHere ? ` (${resolvedHere})` : ''}</label>
      </div>
      {changesAll > 0 && p.canEdit && (
        <div class="dl-rv-all">
          <span>{changesAll} suggestion{changesAll > 1 ? 's' : ''}{slideScoped && scope === 'slide' ? ' in all' : ''}</span>
          <button class="dl-btn" onClick={p.acceptAll} data-rv-acceptall title="Accept every suggestion of the page">✓ Accept all</button>
          <button class="dl-btn" onClick={p.rejectAll} data-rv-rejectall title="Reject every suggestion of the page">✗ Reject all</button>
        </div>
      )}
      <div class="dl-rv-list" ref={listRef}>
        {p.draft && <DraftCard {...p} draft={p.draft} />}
        {rows}
        {!rows.length && !p.draft && (
          <div class="dl-anim-empty">
            {slideScoped && scope === 'slide' ? 'Nothing to review on this slide.' : 'Nothing to review.'}{' '}
            {p.canEdit && <>Select something and press <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>M</kbd> (or 💬 in the toolbar) to comment on it; switch to <b>Suggesting</b> to propose changes others accept or reject.</>}
          </div>
        )}
      </div>
    </div>
  );
}

function ChangeCard({ c, canEdit, accept, reject, select }: Props & { c: ReviewChange }) {
  return (
    <div class="dl-rv-card change" style={{ '--who': `hsl(${reviewHue(c.by)} 60% 45%)` }} data-rv-change={c.kinds.join(' ')} onClick={() => select(c.path, c.slide)}>
      <div class="dl-rv-who"><Avatar name={c.by} /><b>{c.by || 'Someone'}</b><span class="dl-rv-time">{shortTime(c.at)}</span></div>
      <div class="dl-rv-what">{c.what}</div>
      <div class="dl-rv-text">{c.summary}</div>
      {canEdit && (
        <div class="dl-rv-actions">
          <button class="dl-btn dl-rv-accept" title="Accept: keep this change" data-rv-accept onClick={e => { e.stopPropagation(); accept(c); }}>✓ Accept</button>
          <button class="dl-btn dl-rv-reject" title="Reject: back to how it was" data-rv-reject onClick={e => { e.stopPropagation(); reject(c); }}>✗ Reject</button>
        </div>
      )}
    </div>
  );
}

function ThreadCard({ t, canEdit, me, focus, select, reply, resolve, remove }: Props & { t: ReviewThread }) {
  const th = t.thread;
  const [answer, setAnswer] = useState('');
  const focused = !!focus && focus.id === th.id && samePath(focus.path, t.path);
  const send = () => { const v = answer.trim(); if (!v) return; reply(t, v); setAnswer(''); };
  return (
    <div class={'dl-rv-card thread' + (th.done ? ' done' : '') + (focused ? ' focus' : '')} data-rv-thread={th.id} onClick={() => select(t.path, t.slide, th.id)}>
      <div class="dl-rv-who">
        <Avatar name={th.by} /><b>{th.by || 'Comment'}</b><span class="dl-rv-time">{shortTime(th.at)}</span>
        {canEdit && (
          <span class="dl-rv-tools">
            <button class="dl-rv-icon" title={th.done ? 'Reopen' : 'Resolve: done, out of the way (kept under Resolved)'} data-rv-resolve onClick={e => { e.stopPropagation(); resolve(t, !th.done); }}>{th.done ? '↺' : '✓'}</button>
            {(th.by === me || !th.by) && <button class="dl-rv-icon" title="Delete the thread" data-rv-delete onClick={e => { e.stopPropagation(); remove(t); }}>🗑</button>}
          </span>
        )}
      </div>
      <div class="dl-rv-what">{t.what}</div>
      {th.quote && <div class="dl-rv-quote">{th.quote}</div>}
      <div class="dl-rv-text">{th.text}</div>
      {(th.re ?? []).map((r, i) => (
        <div class="dl-rv-reply" key={i}>
          <div class="dl-rv-who"><Avatar name={r.by} /><b>{r.by}</b><span class="dl-rv-time">{shortTime(r.at)}</span></div>
          <div class="dl-rv-text">{r.text}</div>
        </div>
      ))}
      {canEdit && !th.done && (focused || answer) && (
        <div class="dl-rv-answer" onClick={e => e.stopPropagation()}>
          <textarea rows={1} placeholder="Reply…" value={answer} data-rv-reply
            onInput={e => setAnswer((e.target as HTMLTextAreaElement).value)}
            onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || !e.shiftKey)) { e.preventDefault(); send(); } else if (e.key === 'Escape') { setAnswer(''); (e.target as HTMLElement).blur(); } }} />
          {answer.trim() && <button class="dl-btn on" onClick={send} data-rv-send>Reply</button>}
        </div>
      )}
    </div>
  );
}

function DraftCard({ draft, me, submitDraft, cancelDraft }: Props & { draft: CommentDraft }) {
  const [text, setText] = useState('');
  const ta = useRef<HTMLTextAreaElement>(null);
  // the keyboard here at once: what is typed after Ctrl+Alt+M is the comment, not more of the text
  useLayoutEffect(() => { ta.current?.focus(); }, [draft.path?.join('.'), draft.quote]);
  const send = () => { const v = text.trim(); if (v) submitDraft(v); };
  return (
    <div class="dl-rv-card thread draft" data-rv-draft>
      <div class="dl-rv-who"><Avatar name={me} /><b>{me}</b></div>
      <div class="dl-rv-what">On {draft.what}</div>
      {draft.quote && <div class="dl-rv-quote">{draft.quote}</div>}
      <textarea ref={ta} rows={3} placeholder="Comment…" value={text} data-rv-comment
        onInput={e => setText((e.target as HTMLTextAreaElement).value)}
        onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } else if (e.key === 'Escape') { e.preventDefault(); cancelDraft(); } }} />
      <div class="dl-rv-actions">
        <button class="dl-btn on" disabled={!text.trim()} onClick={send} data-rv-submit title="Comment (Ctrl+Enter)">Comment</button>
        <button class="dl-btn" onClick={cancelDraft}>Cancel</button>
      </div>
    </div>
  );
}
