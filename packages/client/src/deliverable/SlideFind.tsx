/**
 * Find and replace on slides: a bar over the canvas (Ctrl+F; Ctrl+H with the replace row). It
 * finds the words on all slides and in their speaker notes (slidefind.ts — not inside formulas),
 * shows how many, steps through them (Enter / Shift+Enter, ↑ ↓) — going to each one's slide and
 * marking it there (runtime/findmarks.ts) — and replaces one or all as edits of the deck's source
 * (undo, Suggesting mode and co-editing as for typing).
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { HtmlOp } from './protocol';
import { findInDeck, replaceOps, type SlideMatch } from './slidefind';
import './slidefind.css';

export interface SlideFindProps {
  /** the deck's source now, and a call after every change of it */
  source(): string;
  onChange(cb: () => void): () => void;
  /** the slide shown (a new search starts at its first match) */
  current: number;
  /** a match's slide shown (and its speaker notes, when the match is there) */
  go(m: SlideMatch): void;
  /** the marks on the canvas (null: none) */
  mark(find: { query: string; matchCase: boolean; words: boolean; marks: { path: number[]; nth: number }[]; current: number } | null): void;
  apply(ops: HtmlOp[]): boolean;
  readOnly: boolean;
  /** opened (again) with Ctrl+F (false) or Ctrl+H (true): the counter makes the bar take the keyboard */
  replace: boolean;
  focusTick: number;
  notify(text: string): void;
  close(): void;
}

const MAX_MARKS = 400;

export function SlideFind(p: SlideFindProps) {
  const [query, setQuery] = useState('');
  const [by, setBy] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [words, setWords] = useState(false);
  const [showReplace, setShowReplace] = useState(p.replace);
  const [rev, setRev] = useState(0);
  const [at, setAt] = useState(0);
  const findIn = useRef<HTMLInputElement>(null);
  const byIn = useRef<HTMLInputElement>(null);
  /** after a replacement: the next match from here on (the source offset after the new words) */
  const after = useRef<number | null>(null);
  /** a new search: its first match on or after the slide shown */
  const fresh = useRef(true);
  const pp = useRef(p); pp.current = p;

  useEffect(() => { let t: ReturnType<typeof setTimeout> | null = null; const off = p.onChange(() => { if (t) clearTimeout(t); t = setTimeout(() => setRev(r => r + 1), 150); }); return () => { off(); if (t) clearTimeout(t); }; }, []);
  useEffect(() => {
    if (p.replace) setShowReplace(true);
    const el = p.replace && query ? byIn.current : findIn.current;
    setTimeout(() => { el?.focus(); el?.select(); }, 0);
  }, [p.focusTick]);

  const opts = { query, matchCase, words };
  const matches = useMemo(() => { try { return findInDeck(p.source(), opts); } catch { return []; } }, [query, matchCase, words, rev]);

  // which match is current when the matches change
  useEffect(() => {
    if (!matches.length) { setAt(0); return; }
    if (after.current !== null) {
      const from = after.current; after.current = null;
      const k = matches.findIndex(m => m.from >= from);
      setAt(k < 0 ? 0 : k);
      return;
    }
    if (fresh.current) {
      fresh.current = false;
      const k = matches.findIndex(m => m.slide >= pp.current.current);
      setAt(k < 0 ? 0 : k);
      return;
    }
    setAt(a => Math.min(a, matches.length - 1));
  }, [matches]);
  useEffect(() => { fresh.current = true; }, [query, matchCase, words]);

  const now = matches[at];
  // the marks, and the current one's slide
  useEffect(() => {
    if (!query.trim() || !matches.length) { pp.current.mark(null); return; }
    const lo = Math.max(0, Math.min(at - MAX_MARKS / 2, matches.length - MAX_MARKS));
    const shown = matches.slice(lo, lo + MAX_MARKS);
    pp.current.mark({ ...opts, marks: shown.map(m => ({ path: m.path, nth: m.nth })), current: at - lo });
  }, [matches, at]);
  useEffect(() => { if (now) pp.current.go(now); }, [now?.from, now?.slide, at]);
  useEffect(() => () => pp.current.mark(null), []);

  const step = (d: 1 | -1) => { if (matches.length) setAt(a => (a + d + matches.length) % matches.length); };
  const replaceOne = () => {
    if (p.readOnly || !now) return;
    const ops = replaceOps(p.source(), [now], by);
    if (!ops.length) return;
    after.current = now.from + by.length;
    if (!p.apply(ops)) after.current = null;
  };
  const replaceAll = () => {
    if (p.readOnly || !matches.length) return;
    const n = matches.length;
    const ops = replaceOps(p.source(), matches, by);
    if (ops.length && p.apply(ops)) p.notify(`${n} replaced${n > 1 ? ' — Ctrl+Z brings them all back' : ''}.`);
  };
  const keys = (e: KeyboardEvent, inReplace: boolean) => {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') { e.preventDefault(); p.close(); return; }
    if (e.key === 'Enter') { e.preventDefault(); if (inReplace && !e.shiftKey) { if (mod || e.altKey) replaceAll(); else replaceOne(); } else step(e.shiftKey ? -1 : 1); return; }
    if (!inReplace && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); step(e.key === 'ArrowDown' ? 1 : -1); return; }
    if (mod && !e.altKey && (e.key.toLowerCase() === 'f' || e.key.toLowerCase() === 'h')) {
      e.preventDefault();
      if (e.key.toLowerCase() === 'h' && !p.readOnly) { setShowReplace(true); setTimeout(() => byIn.current?.focus(), 0); } else { findIn.current?.focus(); findIn.current?.select(); }
      return;
    }
    if (mod && !e.altKey && e.key.toLowerCase() === 'g') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
    e.stopPropagation();
  };
  const where = now ? `slide ${now.slide + 1}${now.notes ? ', speaker notes' : ''}` : '';

  return (
    <div class="dl-find" role="search" aria-label="Find on slides" data-dl-find>
      <div class="dl-find-row">
        {!p.readOnly && <button type="button" class="dl-btn dl-find-toggle" aria-expanded={showReplace} title={showReplace ? 'Hide Replace' : 'Replace (Ctrl+H)'} onClick={() => setShowReplace(!showReplace)}>{showReplace ? '▾' : '▸'}</button>}
        <input ref={findIn} type="text" class="dl-find-input" placeholder="Find on slides" aria-label="Find on slides and in the speaker notes"
          title="Finds the words on every slide and in the speaker notes (not inside formulas). Enter: next, Shift+Enter: previous"
          value={query} onInput={e => setQuery((e.target as HTMLInputElement).value)} onKeyDown={e => keys(e, false)} data-dl-find-input />
        <span class={'dl-find-count' + (query.trim() && !matches.length ? ' none' : '')} aria-live="polite" data-dl-find-count title={now ? now.context : undefined}>
          {!query.trim() ? '' : matches.length ? `${at + 1} of ${matches.length}` : 'No matches'}
          {where && <span class="dl-find-where">{where}</span>}
        </span>
        <button type="button" class="dl-btn" title="Previous (Shift+Enter)" aria-label="Previous match" disabled={!matches.length} onClick={() => step(-1)}>↑</button>
        <button type="button" class="dl-btn" title="Next (Enter)" aria-label="Next match" disabled={!matches.length} onClick={() => step(1)}>↓</button>
        <button type="button" class={'dl-btn dl-find-opt' + (matchCase ? ' on' : '')} aria-pressed={matchCase} title="Match case" onClick={() => setMatchCase(!matchCase)}>Aa</button>
        <button type="button" class={'dl-btn dl-find-opt' + (words ? ' on' : '')} aria-pressed={words} title="Whole words only" onClick={() => setWords(!words)}>W</button>
        <button type="button" class="dl-btn dl-find-close" title="Close (Esc)" aria-label="Close find" onClick={p.close}>×</button>
      </div>
      {showReplace && !p.readOnly && (
        <div class="dl-find-row">
          <span class="dl-find-toggle-space" />
          <input ref={byIn} type="text" class="dl-find-input" placeholder="Replace with" aria-label="Replace with" value={by}
            title="Enter: replace this one and go to the next; Ctrl+Enter: replace all"
            onInput={e => setBy((e.target as HTMLInputElement).value)} onKeyDown={e => keys(e, true)} data-dl-replace-input />
          <button type="button" class="dl-btn" disabled={!now} onClick={replaceOne} data-dl-replace-one>Replace</button>
          <button type="button" class="dl-btn" disabled={!matches.length} onClick={replaceAll} data-dl-replace-all>Replace all</button>
        </div>
      )}
    </div>
  );
}
