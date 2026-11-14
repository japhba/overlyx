/**
 * The start page's search: a box over the projects that filters them as one types (app/homesearch.ts:
 * names, owners, file names), with the keyboard — `/` puts the cursor in it, ↑ ↓ choose a project,
 * Enter opens it, Escape empties the box. "Inside files" switches it to the text of all one's
 * projects at once (server projectsearch.ts searchAllProjects, the project search's engine): the
 * matches by project and file, opened with a click or Enter. End-to-end encrypted projects cannot be
 * searched inside by the server; the results say so.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, fileTabId, fileUrl, type AllProjectsSearchResult, type Project, type ProjectSearchMatch, type ProjectSearchOptions } from '../api';
import { searchTarget } from './ProjectSearch';
import { KIND_ICONS, iconSvg } from './modernicons';
import { markTerms } from './homesearch';
import './homesearch.css';

export type HomeSearchMode = 'projects' | 'files';
/** App's Search in the project (Ctrl+Shift+F) on the start page: the box in "Inside files" */
export const HOME_SEARCH_EVENT = 'ol-home-search';

/** a file of a project opened from the start page: in its tab, else (a picture) in a browser tab */
export function openProjectFile(p: Project, path: string, onOpen: (id: string) => void) {
  const f = p.files.find(x => x.path === path);
  const id = f ? fileTabId(p.name, f) : null;
  if (id) onOpen(id);
  else window.open(fileUrl(p.name, path), '_blank', 'noopener');
}

/** text with the typed words marked */
export function Marked({ text, terms }: { text: string; terms: string[] }) {
  const parts = markTerms(text, terms);
  // (one element: a flex line with gaps, as the Modern start page's, keeps the word whole)
  return <span class="hs-marked">{parts.map((s, i) => (i % 2 ? <mark key={i} class="hs-mark">{s}</mark> : s))}</span>;
}

export function HomeSearchBox({ q, onQ, mode, onMode, count, onMove, onEnter }: {
  q: string; onQ: (q: string) => void; mode: HomeSearchMode; onMode: (m: HomeSearchMode) => void;
  /** projects shown (the projects mode) */
  count: number | null;
  /** ↑ / ↓ in the projects mode (the files mode moves through its own results) */
  onMove: (delta: number) => void; onEnter: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') || document.querySelector('.dialog-backdrop, [role="dialog"]'))) return;
      e.preventDefault();
      input.current?.focus(); input.current?.select();
    };
    const onSearch = () => { onMode('files'); requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); }); };
    window.addEventListener('keydown', onKey);
    window.addEventListener(HOME_SEARCH_EVENT, onSearch);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener(HOME_SEARCH_EVENT, onSearch); };
  }, []);
  const placeholder = mode === 'files' ? 'Search inside all your projects' : 'Search projects and files';
  return (
    <div class="hs-bar" data-home-search>
      <div class="hs-box">
        <svg class="hs-icon" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="6.8" cy="6.8" r="4.6" /><path d="M10.2 10.2 14 14" /></svg>
        <input ref={input} type="search" value={q} placeholder={placeholder} aria-label={placeholder} spellcheck={false} autocomplete="off" data-home-search-input
          onInput={e => onQ((e.target as HTMLInputElement).value)}
          onKeyDown={e => {
            if (e.key === 'Escape') { if (q) { e.preventDefault(); onQ(''); } else input.current?.blur(); return; }
            if (mode !== 'projects') return;
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); onMove(e.key === 'ArrowDown' ? 1 : -1); }
            else if (e.key === 'Enter') { e.preventDefault(); onEnter(); }
          }} />
        {!q && <kbd class="hs-key" title="Press / to search">/</kbd>}
      </div>
      <div class="hs-modes" role="radiogroup" aria-label="What to search">
        <button type="button" role="radio" aria-checked={mode === 'projects'} class={'hs-mode' + (mode === 'projects' ? ' on' : '')} data-home-search-mode="projects"
          title="Find projects by their name, their owner or the names of their files" onClick={() => { onMode('projects'); input.current?.focus(); }}>Names</button>
        <button type="button" role="radio" aria-checked={mode === 'files'} class={'hs-mode' + (mode === 'files' ? ' on' : '')} data-home-search-mode="files"
          title="Find words in the text of all your projects (Ctrl+Shift+F)" onClick={() => { onMode('files'); input.current?.focus(); }}>Inside files</button>
      </div>
      {mode === 'projects' && q && count !== null && <span class="hs-count" aria-live="polite">{count ? `${count} project${count === 1 ? '' : 's'}` : 'No projects match'}</span>}
    </div>
  );
}

const OPTS_KEY = 'ol.homeSearch.opts';
const loadOpts = (): ProjectSearchOptions => { try { return JSON.parse(localStorage.getItem(OPTS_KEY) ?? '{}') ?? {}; } catch { return {}; } };

/** the "Inside files" results: every project's matches, by file */
export function HomeFileResults({ q, projects, onOpen }: { q: string; projects: Project[]; onOpen: (id: string) => void }) {
  const [opts, setOpts] = useState<ProjectSearchOptions>(loadOpts);
  const [result, setResult] = useState<AllProjectsSearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { try { localStorage.setItem(OPTS_KEY, JSON.stringify(opts)); } catch { /* private window */ } }, [opts]);
  useEffect(() => {
    setError(null);
    if (!q.trim()) { setResult(null); setBusy(false); return; }
    const ctl = new AbortController();
    setBusy(true);
    const t = setTimeout(() => {
      api.searchAll(q, opts, ctl.signal)
        .then(r => { setResult(r); setActive(0); })
        .catch(e => { if (!ctl.signal.aborted) { setResult(null); setError((e as Error).message); } })
        .finally(() => { if (!ctl.signal.aborted) setBusy(false); });
    }, 320);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [q, opts.matchCase, opts.wholeWord, opts.regex]);

  const byName = useMemo(() => new Map(projects.map(p => [p.name, p])), [projects]);
  /** the matches in the order shown, for ↑ ↓ Enter */
  const flat = useMemo(() => {
    const out: { p: Project; path: string; m: ProjectSearchMatch }[] = [];
    for (const r of result?.projects ?? []) {
      const p = byName.get(r.project);
      if (p) for (const f of r.files) for (const m of f.matches) out.push({ p, path: f.path, m });
    }
    return out;
  }, [result, byName]);
  const go = (p: Project, path: string, m: ProjectSearchMatch) => {
    const t = searchTarget(p, path, m);
    if ('url' in t) { window.open(t.url, '_blank', 'noopener'); return; }
    location.hash = t.hash;
  };
  // the box's ↑ ↓ Enter move through the matches (the input sits outside this list)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t?.matches?.('[data-home-search-input]') || !flat.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActive(a => Math.max(0, Math.min(flat.length - 1, a + (e.key === 'ArrowDown' ? 1 : -1))));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const hit = flat[Math.min(active, flat.length - 1)];
        if (hit) go(hit.p, hit.path, hit.m);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flat, active]);
  useEffect(() => { box.current?.querySelector('.hs-match.active')?.scrollIntoView({ block: 'nearest' }); }, [active]);

  const toggle = (k: keyof ProjectSearchOptions, label: string, title: string) => (
    <button type="button" class={'ps-opt' + (opts[k] ? ' on' : '')} aria-pressed={!!opts[k]} title={title} onClick={() => setOpts(o => ({ ...o, [k]: !o[k] }))}>{label}</button>
  );
  let n = -1;
  const encrypted = result?.encrypted ?? [];
  return (
    <div class="hs-files" ref={box} data-home-file-results>
      <div class="hs-files-head">
        <span class="hs-summary" aria-live="polite">
          {error ? <span class="ps-error">{error}</span>
            : !q.trim() ? 'Finds words in the text of every project you can open — documents, slides, Markdown, .bib, code.'
            : busy && !result ? 'Searching…'
            : result ? <>
              {result.total ? `${result.total} result${result.total === 1 ? '' : 's'} in ${result.projects.length} project${result.projects.length === 1 ? '' : 's'}` : 'No results.'}
              {result.truncated && ' — stopped early: narrow the search'}
              {result.skipped > 0 && ` · ${result.skipped} large file${result.skipped === 1 ? '' : 's'} not searched`}
            </> : null}
        </span>
        <span class="ps-opts hs-opts">
          {toggle('matchCase', 'Aa', 'Match case')}
          {toggle('wholeWord', 'ab', 'Whole word')}
          {toggle('regex', '.*', 'Regular expression')}
        </span>
      </div>
      {result && encrypted.length > 0 && (
        <div class="hs-note" data-home-search-encrypted>
          🔒 Not searched: {encrypted.length === 1 ? 'one end-to-end encrypted project' : `${encrypted.length} end-to-end encrypted projects`} ({encrypted.map(k => byName.get(k)?.title ?? k.split('/').pop()).join(', ')}) — the server cannot read them. Open one and use its own search.
        </div>
      )}
      {result?.projects.map(r => {
        const p = byName.get(r.project);
        if (!p) return null;
        return (
          <div class="hs-project" key={r.project} data-home-search-project={r.project}>
            <div class="hs-project-name">{p.title ?? r.project.split('/').pop()}<span class="group-count">{r.count}</span></div>
            {r.files.map(f => {
              const file = p.files.find(x => x.path === f.path);
              const kind = file?.kind === 'html' && file.deliverable ? file.deliverable : /\.md$/i.test(f.path) ? 'md' : file?.kind ?? 'other';
              return (
                <div class="hs-file" key={f.path}>
                  <div class="hs-file-name" role="button" tabIndex={-1} title={`Open ${f.path}`} onClick={() => openProjectFile(p, f.path, onOpen)}>
                    <span class="ficon icon" dangerouslySetInnerHTML={{ __html: iconSvg(KIND_ICONS[kind] ?? KIND_ICONS.other, 14) }} />
                    <span>{f.path}</span>
                    {f.count > f.matches.length && <span class="hs-more">{f.count} matches</span>}
                  </div>
                  {f.matches.map((m, i) => {
                    const idx = ++n;
                    return (
                      <div key={i} class={'hs-match' + (idx === active ? ' active' : '')} role="button" tabIndex={-1} data-home-search-line={m.line}
                        title={`Line ${m.line}${m.slide ? ` · slide ${m.slide}` : ''}`} onClick={() => go(p, f.path, m)} onMouseEnter={() => setActive(idx)}>
                        <span class="hs-where">{m.slide ? `slide ${m.slide}` : m.line}</span>
                        <span class="ps-text">{m.preview.slice(0, m.from)}<mark>{m.preview.slice(m.from, m.to)}</mark>{m.preview.slice(m.to)}</span>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
