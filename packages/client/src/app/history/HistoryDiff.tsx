/**
 * A version compared with the file as it is now, or with another version (the History pane,
 * HistoryPanel.tsx): the changed passages of the source side by side or in place, the changed
 * words marked; for a deck or poster first the slides that changed, came or went, each shown
 * before and after. From here the whole version — or, against now, one changed passage — is
 * restored as an ordinary edit (server history.ts), which the pane can undo.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { api, type VersionInfo } from '../../api';
import { projectOfDoc, docPathOf } from '@overlyx/core';
import { hunks, changeCount, type Hunk, type Piece } from './textdiff';
import { slidesOf, slideChanges, slidePage, type Slides } from './slidediff';
import { versionTitle, Authors, type Undo } from './HistoryPanel';

type Notify = (msg: string, kind?: 'info' | 'error') => void;
const isLyxText = (t: string) => /^\s*#LyX|^\\lyxformat/m.test(t.slice(0, 400));
const when = (t: number) => new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function Pieces({ list, side }: { list: Piece[]; side: 'old' | 'new' }) {
  return <>{list.map((p, i) => p.kind === 'same' ? <span key={i}>{p.text}</span> : side === 'old' ? <del key={i}>{p.text}</del> : <ins key={i}>{p.text}</ins>)}</>;
}

/** a comparison of two texts from elsewhere (a commit of the project's history and the one before it): no versions to pick, nothing to restore from here */
export interface CustomCompare { title: string; sub: string; load: () => Promise<{ a: string; b: string }> }

export default function HistoryDiff({ docId, versions, from, to, e2e, custom, onPick, onClose, onRestoreWhole, onRestoredPart, say }: {
  docId: string; versions: VersionInfo[]; from: number; to: number | null; e2e: boolean; custom?: CustomCompare;
  onPick: (from: number, to: number | null) => void; onClose: () => void;
  onRestoreWhole: (v: VersionInfo) => void | Promise<void>; onRestoredPart: (u: Undo) => void; say: Notify;
}) {
  const [texts, setTexts] = useState<{ a: string; b: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<'split' | 'inline'>(() => { try { return localStorage.getItem('ol.histMode') === 'inline' ? 'inline' : 'split'; } catch { return 'split'; } });
  const [seq, setSeq] = useState(0);
  const [base, setBase] = useState<string | null>(null);
  const fromV = versions.find(v => v.id === from);
  const isPage = /\.html?$/i.test(docId);
  const isBoard = docId.endsWith('.board');

  useEffect(() => {
    let live = true;
    setTexts(null); setErr(null);
    (custom ? custom.load() : Promise.all([api.getVersion(docId, from).then(v => v.lyx), to === null ? api.texText(docId) : api.getVersion(docId, to).then(v => v.lyx)]).then(([a, b]) => ({ a, b })))
      .then(t => { if (live) setTexts(t); })
      .catch(() => { if (live) setErr('The comparison could not be loaded. Try again when the server is available.'); });
    return () => { live = false; };
  }, [docId, from, to, seq, custom]);
  useEffect(() => {
    if (!isPage || e2e) return;
    let live = true;
    api.deliverableLink(projectOfDoc(docId), docPathOf(docId)).then(l => { if (live) setBase(l.base); }).catch(() => {});
    return () => { live = false; };
  }, [docId]);
  useEffect(() => {
    // (not while a dialog over it — a restore's question — has the key)
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.dialog-backdrop')) { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [onClose]);
  const setModeKept = (m: 'split' | 'inline') => { setMode(m); try { localStorage.setItem('ol.histMode', m); } catch { /* ignore */ } };

  const list = useMemo(() => (texts ? hunks(texts.a, texts.b) : []), [texts]);
  const slides = useMemo(() => {
    if (!texts || !isPage) return null;
    const a = slidesOf(texts.a), b = slidesOf(texts.b);
    if (!a.ranges.length && !b.ranges.length) return null;
    return { a, b, changes: slideChanges(a, b) };
  }, [texts, isPage]);
  const count = changeCount(list);
  const partsOk = !custom && to === null && !e2e && !isBoard && !!texts && !isLyxText(texts.a);

  const restorePart = async (h: Hunk) => {
    try {
      const r = await api.restorePart(docId, from, { at: h.bOffset, cur: h.newText, text: h.oldText });
      onRestoredPart({ label: `Restored a part from “${fromV ? versionTitle(fromV) : 'a version'}”.`, run: async () => { await api.restorePart(docId, from, { at: r.at, cur: h.oldText, text: h.newText }); } });
      say('Part restored');
      setSeq(s => s + 1);
    } catch (e) { say((e as Error).message || 'Could not restore that part', 'error'); setSeq(s => s + 1); }
  };

  const options = (selected: number | null, withNow: boolean) => <>
    {withNow && <option value="now" selected={selected === null}>Now</option>}
    {versions.map(v => <option key={v.id} value={String(v.id)} selected={selected === v.id}>{when(v.created_at)} — {versionTitle(v)}</option>)}
  </>;

  return createPortal(
    <div class="hist-diff-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="hist-diff" role="dialog" aria-label="Compare versions" data-history-diff>
        <div class="hist-diff-head">
          {custom ? <b class="hist-custom-title">{custom.title}</b> : <>
            <label>Compare <select aria-label="Older version" onChange={e => onPick(Number((e.target as HTMLSelectElement).value), to)}>{options(from, false)}</select></label>
            <label>with <select aria-label="Newer version" onChange={e => { const v = (e.target as HTMLSelectElement).value; onPick(from, v === 'now' ? null : Number(v)); }}>{options(to, true)}</select></label>
          </>}
          <span class="hist-seg" role="group" aria-label="Layout">
            <button type="button" class={mode === 'split' ? 'on' : ''} aria-pressed={mode === 'split'} onClick={() => setModeKept('split')}>Side by side</button>
            <button type="button" class={mode === 'inline' ? 'on' : ''} aria-pressed={mode === 'inline'} onClick={() => setModeKept('inline')}>In place</button>
          </span>
          <span class="hist-grow" />
          {!custom && fromV && to === null && <button type="button" class="small-btn primary" onClick={() => void onRestoreWhole(fromV)}>Restore this version</button>}
          <button type="button" class="hist-close" aria-label="Close" title="Close (Esc)" onClick={onClose}>×</button>
        </div>
        {(custom || fromV) && <div class="hist-diff-sub">{custom ? custom.sub : <>{versionTitle(fromV!)} · {when(fromV!.created_at)} <Authors names={fromV!.author} /></>} {texts && <span class="hist-count">{list.length ? <><ins>+{count.added}</ins> <del>−{count.removed}</del> lines in {list.length} {list.length === 1 ? 'place' : 'places'}</> : 'No differences'}</span>}</div>}
        <div class="hist-diff-body">
          {err && <div class="hist-note">{err} <button type="button" class="small-btn" onClick={() => setSeq(s => s + 1)}>Try again</button></div>}
          {!texts && !err && <div class="hist-note">Comparing…</div>}
          {texts && texts.a === texts.b && <div class="hist-note">The two are the same.</div>}
          {slides && slides.changes.length > 0 && <SlideCompare a={slides.a} b={slides.b} changes={slides.changes} base={base} rightLabel={custom ? 'After' : to === null ? 'Now' : 'Newer'} />}
          {texts && list.length > 0 && (
            <details class="hist-code" open={!slides || !slides.changes.length}>
              <summary>{slides ? 'Changes in the code' : 'Changes'}</summary>
              {list.map((h, k) => (
                <div key={k} class="hist-hunk">
                  <div class="hist-hunk-head">
                    <span>Line {h.bLine}</span>
                    {partsOk && <button type="button" class="small-btn" title="Put this passage back as it was in the older version (an ordinary edit everyone sees)" onClick={() => void restorePart(h)}>Restore this part</button>}
                  </div>
                  {mode === 'split' ? (
                    <div class="hist-split">
                      <pre class="old">{h.before.join('')}<span class="chg"><Pieces list={h.words.old} side="old" /></span>{h.after.join('')}</pre>
                      <pre class="new">{h.before.join('')}<span class="chg"><Pieces list={h.words.new} side="new" /></span>{h.after.join('')}</pre>
                    </div>
                  ) : (
                    <pre class="inline">{h.before.join('')}{h.oldText && <span class="chg old"><Pieces list={h.words.old} side="old" /></span>}{h.newText && <span class="chg new"><Pieces list={h.words.new} side="new" /></span>}{h.after.join('')}</pre>
                  )}
                </div>
              ))}
            </details>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** the slides that changed: a list to pick from, the picked ones before and after */
function SlideCompare({ a, b, changes, base, rightLabel }: { a: Slides; b: Slides; changes: ReturnType<typeof slideChanges>; base: string | null; rightLabel: string }) {
  const [shown, setShown] = useState(() => Math.min(changes.length, 6));
  const label = (c: (typeof changes)[number]) => c.kind === 'changed' ? (c.oldNo === c.newNo ? `Slide ${c.newNo} changed` : `Slide ${c.oldNo} → ${c.newNo} changed`) : c.kind === 'added' ? `Slide ${c.newNo} added` : `Slide ${c.oldNo} removed`;
  return (
    <section class="hist-slides">
      <div class="hist-slide-list">
        {changes.map((c, i) => <button type="button" key={i} class={'hist-chip ' + c.kind} onClick={() => { setShown(s => Math.max(s, i + 1)); requestAnimationFrame(() => document.querySelector(`[data-hist-slide="${i}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })); }}>{label(c)}</button>)}
      </div>
      {changes.slice(0, shown).map((c, i) => (
        <div key={i} class="hist-slide-row" data-hist-slide={i}>
          <div class="hist-slide-cap">{label(c)}</div>
          <div class="hist-slide-pair">
            <figure><figcaption>Older</figcaption>{c.oldNo ? <SlideFrame html={slidePage(a, c.oldNo - 1, base)} /> : <div class="hist-slide-none">Not there yet</div>}</figure>
            <figure><figcaption>{rightLabel}</figcaption>{c.newNo ? <SlideFrame html={slidePage(b, c.newNo - 1, base)} /> : <div class="hist-slide-none">Removed</div>}</figure>
          </div>
        </div>
      ))}
      {shown < changes.length && <button type="button" class="small-btn" onClick={() => setShown(changes.length)}>Show all {changes.length} changed slides</button>}
    </section>
  );
}

/** one slide drawn to the width of its column: no scripts run in it (sandboxed), its size read once it has loaded */
function SlideFrame({ html }: { html: string }) {
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const fit = () => {
    const f = frame.current, b = box.current;
    const doc = f?.contentDocument;
    // (before the page has loaded — the frame's first empty document — there is nothing to measure)
    if (!f || !b || !doc?.documentElement || !doc.body) return;
    const slide = doc.querySelector<HTMLElement>('.slide');
    const w = slide?.offsetWidth || doc.documentElement.scrollWidth || 1280, h = slide?.offsetHeight || doc.documentElement.scrollHeight || 720;
    const scale = b.clientWidth / w;
    f.style.width = w + 'px'; f.style.height = h + 'px';
    f.style.transform = `scale(${scale})`;
    b.style.height = Math.ceil(h * scale) + 'px';
  };
  useEffect(() => {
    const ro = new ResizeObserver(fit);
    if (box.current) ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  return <div class="hist-slide-frame" ref={box}><iframe ref={frame} title="Slide" sandbox="allow-same-origin" srcdoc={html} onLoad={fit} /></div>;
}
