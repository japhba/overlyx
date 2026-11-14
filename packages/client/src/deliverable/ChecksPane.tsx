/**
 * Check: what people get of the report agents get from render_page (runtime/report.ts) — a pane
 * beside the canvas that lists, slide by slide, text that does not fit its box or runs off the slide,
 * objects off the slide, text too small to read (a poster's by its printed size), low contrast,
 * things lying on each other, a poster's pictures with too few pixels for print. A click on an
 * entry goes to the slide and selects the object; the slides with entries get a dot in the rail.
 *
 * It measures in a frame of its own (`useChecks`: the slide rail's page once more, out of sight,
 * every slide laid out at its size) that exists only while the pane is open, and again whenever the
 * text has rested (the editor's settled text: a second after the last change, never while the pen
 * writes) — the frame people type and draw in is not asked anything.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { DeliverableHost } from './host';
import { isFromRuntime, type DeliverableKind, type FromRuntime, type PageReport, type Path, type ToRuntime } from './protocol';
import { checkGroups, checkCount, actLabel, CHECK_LABEL, type CheckEntry, type CheckGroup, type Lint } from './checks';
import './checks.css';

export interface Checks {
  /** 'off': the pane is closed; 'failed': the frame did not answer */
  state: 'off' | 'checking' | 'done' | 'failed';
  groups: CheckGroup[];
  count: number;
  /** the list is of the text as it is now (not of a moment ago, while the next check runs) */
  fresh: boolean;
  /** the frame that measures (rendered by the editor, out of sight) */
  frame: ComponentChildren;
  again(): void;
}

interface Opts {
  open: boolean;
  kind: DeliverableKind;
  host: DeliverableHost;
  link: { base: string; entry: string } | null;
  /** the address of the page in a mode (the editor's `src`) */
  src(mode: string): string;
  /** the text once it has rested */
  text: string;
  /** the slides' size (CSS px) */
  size: { w: number; h: number };
  /** to the slide rail: the slides with entries */
  mark(slides: number[]): void;
  /** what the frame is told before it is asked (the citations' entries the editor knows, as the rail is told) */
  init?(): ToRuntime[];
}

export function useChecks({ open, kind, host, link, src, text, size, mark, init }: Opts): Checks {
  const frame = useRef<HTMLIFrameElement>(null);
  /** the frame's page: null while it is being made ready; `html`: made here (offline, an encrypted project), else the server's */
  const [doc, setDoc] = useState<{ html: string | null; n: number } | null>(null);
  const [result, setResult] = useState<{ pages: PageReport[]; kind: DeliverableKind; text: string } | null>(null);
  const [failed, setFailed] = useState(false);
  const ready = useRef(false);
  const asked = useRef<{ id: number; text: string } | null>(null);
  const ids = useRef(0);
  const version = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textRef = useRef(text); textRef.current = text;
  const docRef = useRef(doc); docRef.current = doc;
  const on = open && kind !== 'page' && !!link;
  const marksRef = useRef(''), markRef = useRef(mark), initRef = useRef(init);
  initRef.current = init;

  const to = (msg: ToRuntime) => { try { frame.current?.contentWindow?.postMessage(msg, '*'); } catch { /* gone */ } };
  const ask = () => {
    if (!ready.current) return;
    const html = textRef.current, id = ++ids.current;
    asked.current = { id, text: html };
    to({ ol: 'source', version: ++version.current, html });
    to({ ol: 'check', id });
    if (timer.current) clearTimeout(timer.current);
    setFailed(false);
    timer.current = setTimeout(() => { if (asked.current?.id === id) setFailed(true); }, 30000);
  };
  const askRef = useRef(ask); askRef.current = ask;

  // the frame's page, while the pane is open
  useEffect(() => {
    if (!on || !link) return;
    let gone = false;
    const made = host.offlineFrame ? host.offlineFrame('thumb', link).catch(() => null) : Promise.resolve(null);
    void made.then(html => { if (!gone) setDoc(d => ({ html: html ?? null, n: (d?.n ?? 0) + 1 })); });
    return () => {
      gone = true; ready.current = false; asked.current = null;
      if (timer.current) clearTimeout(timer.current);
      setDoc(null); setResult(null); setFailed(false);
    };
  }, [on, link?.base, link?.entry]);

  useEffect(() => {
    if (!on) return;
    const onMessage = (e: MessageEvent) => {
      const f = frame.current;
      if (!isFromRuntime(e.data)) return;
      // (the slide rail opened, or loaded again: its dots once more)
      if (!f || e.source !== f.contentWindow) { if ((e.data as FromRuntime).ol === 'ready') setTimeout(() => markRef.current(marksRef.current ? marksRef.current.split(',').map(Number) : []), 200); return; }
      const m = e.data as FromRuntime;
      if (m.ol === 'offlineBoot') {
        const html = docRef.current?.html;
        if (m.opaque === true && html) { f.setAttribute('sandbox', 'allow-scripts'); f.contentWindow?.postMessage({ ol: 'offlineDocument', html }, '*'); }
      } else if (m.ol === 'ready') {
        ready.current = true;
        if (link) {
          let base = host.folderBase;
          try { base ??= new URL('.', new URL(link.entry.split('/').map(encodeURIComponent).join('/'), new URL(link.base, location.href))).href; } catch { /* as served */ }
          if (base) to({ ol: 'folder', base });
        }
        void host.offlineResources?.().then(urls => { if (frame.current === f && f.isConnected) to({ ol: 'assets', urls }); }).catch(() => {});
        for (const msg of initRef.current?.() ?? []) to(msg);
        askRef.current();
      } else if (m.ol === 'needSource') {
        askRef.current();
      } else if (m.ol === 'checked') {
        const a = asked.current;
        if (!a || a.id !== m.id) return;
        if (timer.current) clearTimeout(timer.current);
        if (m.error) { setFailed(true); return; }
        setResult({ pages: m.pages, kind: m.kind, text: a.text });
      }
    };
    addEventListener('message', onMessage);
    return () => removeEventListener('message', onMessage);
  }, [on, link?.base, link?.entry]);

  // the text has rested at something new: measured again
  useEffect(() => { if (on && ready.current && asked.current?.text !== text) ask(); }, [text, on]);

  const groups = useMemo(() => (result ? checkGroups(result.pages, result.kind) : []), [result]);
  // the rail's dots: there while the pane is open
  const marks = on ? groups.map(g => g.slide).join(',') : '';
  marksRef.current = marks; markRef.current = mark;
  useEffect(() => { mark(marks ? marks.split(',').map(Number) : []); }, [marks]);

  const el = on && doc ? (
    <iframe ref={frame} key={doc.n} class="dl-checkframe" title="" aria-hidden="true" tabIndex={-1} data-dl-checkframe
      sandbox={doc.html ? undefined : 'allow-scripts'} src={doc.html ? `/_ol/offline-frame.html?ol=thumb&revision=check${doc.n}` : src('thumb')}
      style={{ width: `${Math.max(400, Math.round(size.w) + 200)}px`, height: `${Math.max(300, Math.round(size.h) + 200)}px` }} />
  ) : null;
  return {
    state: !on ? 'off' : failed ? 'failed' : result ? 'done' : 'checking',
    groups, count: checkCount(groups), fresh: !!result && result.text === text, frame: el,
    again: () => { setFailed(false); ready.current = false; asked.current = null; setResult(null); setDoc(d => (d ? { html: d.html, n: d.n + 1 } : d)); },
  };
}

interface Props {
  checks: Checks;
  kind: DeliverableKind;
  current: number;
  readOnly: boolean;
  /** to the slide, the object selected */
  show(slide: number, path?: Path): void;
  /** it is so on purpose: the object gets the word in data-ol-lint and is not reported for it again */
  meant(path: Path, word: Lint): void;
  /** the one-click fix: to the slide, the object selected, then fixed */
  fix(slide: number, path: Path, how: 'fit' | 'onto'): void;
  close(): void;
}

export function ChecksPane({ checks, kind, current, readOnly, show, meant, fix, close }: Props) {
  const poster = kind === 'poster';
  const n = checks.count;
  const pick = (e: CheckEntry) => show(e.slide, e.path);
  return (
    <div class="dl-anim dl-checks" data-dl-checks>
      <div class="dl-anim-head">
        <span>Check</span>
        <button class="dl-btn" onClick={close} title="Close">×</button>
      </div>
      <div class="dl-chk-sum" role="status" data-dl-checks-state={checks.state}>
        {checks.state === 'failed' ? <>The check did not finish. <button type="button" class="dl-btn" onClick={checks.again}>Try again</button></>
          : checks.state !== 'done' ? `Looking at the ${poster ? 'poster' : 'slides'}…`
          : n === 0 ? `Nothing found: the text fits, is big enough to read and stands out from what is behind it${poster ? ', and the pictures have enough pixels for print' : ''}.`
          : `${n} thing${n === 1 ? '' : 's'} to look at${poster ? '' : ` on ${checks.groups.length} slide${checks.groups.length === 1 ? '' : 's'}`}. Click one to go to it.`}
      </div>
      <div class="dl-anim-list">
        {checks.groups.map(g => (
          <div class="dl-chk-group" key={g.slide} data-chk-slide={g.slide}>
            {!poster && (
              <button type="button" class={'dl-chk-slide' + (g.slide === current ? ' on' : '')} onClick={() => show(g.slide)} title="Go to this slide">
                Slide {g.slide + 1}{g.title ? <span> · {g.title}</span> : null}
              </button>
            )}
            {g.entries.map((e, i) => (
              <div class="dl-chk-row" key={i} data-chk={e.kind} role="button" tabIndex={0} title={e.path ? 'Go to it' : 'Go to the slide'}
                onClick={() => pick(e)} onKeyDown={ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(e); } }}>
                <span class="dl-chk-kind">{CHECK_LABEL[e.kind]}</span>
                <span class="dl-chk-say">{e.say}</span>
                {e.fix && <span class="dl-chk-fix">{e.fix}</span>}
                {(e.lint || e.act) && e.path && !readOnly && (
                  <span class="dl-chk-acts">
                    {e.act && (
                      <button type="button" class="dl-btn" data-chk-fix={e.act} disabled={!checks.fresh}
                        title={e.act === 'fit' ? 'Makes the text of this box smaller until it fits (Ctrl+Z takes it back)' : 'Moves it the least that brings it back inside (Ctrl+Z takes it back)'}
                        onClick={ev => { ev.stopPropagation(); if (e.path && e.act) fix(e.slide, e.path, e.act); }}>{actLabel(e.act, kind)}</button>
                    )}
                    {e.lint && <button type="button" class="dl-btn" data-chk-meant disabled={!checks.fresh}
                      title={e.lint === 'no-edge' ? 'It runs off the edge on purpose: Check leaves this object alone from now on' : 'They lie on each other on purpose: Check leaves this object alone from now on'}
                      onClick={ev => { ev.stopPropagation(); if (e.path && e.lint) meant(e.path, e.lint); }}>It is meant</button>}
                  </span>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
      <div class="dl-chk-foot">
        {poster
          ? 'Checked as you work, while this pane is open: text that does not fit, runs off the poster or is too small for its printed size, low contrast, things lying on each other, pictures with too few pixels for print.'
          : 'Checked as you work, while this pane is open: text that does not fit, runs off the slide or is too small to read from the back of a room, low contrast, things lying on each other or outside the slide.'}
      </div>
    </div>
  );
}
