/**
 * Search in the project (Ctrl+Shift+F; the 🔍 of the files panel), VS Code's "Search" view: what is
 * typed is looked for in all the project's text files (server projectsearch.ts) — as typed, or with
 * Match case (Aa), Whole word (ab) or as a regular expression (.*) — and the matches are listed by
 * file, each in its line. A click opens the file there: a document at that line of its LaTeX (the
 * matched words marked), a text file at the line, slides at the slide.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, fileTabId, fileUrl, type Project, type ProjectSearchMatch, type ProjectSearchOptions, type ProjectSearchResult } from '../api';
import { hashOfId, placeQuery } from '../editor/permalink';
import { KIND_ICONS, iconSvg } from './modernicons';

const OPTS_KEY = 'ol.search.opts';
const loadOpts = (): ProjectSearchOptions => { try { return JSON.parse(localStorage.getItem(OPTS_KEY) ?? '{}') ?? {}; } catch { return {}; } };

/** Where a match of `path` opens: the hash to go to (a tab), else a file to open in a browser tab. */
export function searchTarget(project: Project, path: string, m: ProjectSearchMatch): { hash: string } | { url: string } {
  const f = project.files.find(x => x.path === path);
  const id = f ? fileTabId(project.name, f) : null;
  if (!f || !id) return { url: fileUrl(project.name, path) };
  const words = m.preview.slice(m.from, m.to).replace(/…/g, '').trim();
  const place = f.kind === 'html' && f.deliverable ? (m.slide ? { slide: m.slide } : {})
    : id.startsWith('text:') ? { line: [m.line, m.line] as [number, number] }
    : f.kind === 'doc' ? { line: [m.line, m.line] as [number, number], ...(words ? { text: words } : {}) }
    : {};
  const q = placeQuery(place);
  return { hash: '#/' + hashOfId(id) + (q ? '?' + q : '') };
}

export function ProjectSearch({ project, hidden, focusKey, initial }: {
  project: Project | null; hidden: boolean;
  /** changed: focus the box (Ctrl+Shift+F), with `initial` as the query when given */
  focusKey: number; initial?: string;
}) {
  const [q, setQ] = useState('');
  const [opts, setOpts] = useState<ProjectSearchOptions>(loadOpts);
  const [result, setResult] = useState<ProjectSearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { try { localStorage.setItem(OPTS_KEY, JSON.stringify(opts)); } catch { /* private window */ } }, [opts]);
  useEffect(() => {
    if (!focusKey) return;
    if (initial) setQ(initial);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); });
  }, [focusKey]);
  // search as one types (a moment after the last key); an older answer never replaces a newer one
  useEffect(() => {
    setError(null);
    if (!project || !q) { setResult(null); setBusy(false); return; }
    const ctl = new AbortController();
    setBusy(true);
    const t = setTimeout(() => {
      api.projectSearch(project.name, q, opts, ctl.signal)
        .then(r => { setResult(r); setFolded(new Set()); })
        .catch(e => { if (!ctl.signal.aborted) { setResult(null); setError((e as Error).message); } })
        .finally(() => { if (!ctl.signal.aborted) setBusy(false); });
    }, 280);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [project?.name, q, opts.matchCase, opts.wholeWord, opts.regex]);

  const go = (path: string, m: ProjectSearchMatch) => {
    if (!project) return;
    const t = searchTarget(project, path, m);
    if ('url' in t) { window.open(t.url, '_blank', 'noopener'); return; }
    if (location.hash === t.hash) window.dispatchEvent(new HashChangeEvent('hashchange'));   // the same match again: go there again
    else location.hash = t.hash;
  };
  const toggle = (k: keyof ProjectSearchOptions, label: string, title: string) => (
    <button type="button" class={'ps-opt' + (opts[k] ? ' on' : '')} aria-pressed={!!opts[k]} title={title} onClick={() => setOpts(o => ({ ...o, [k]: !o[k] }))}>{label}</button>
  );
  const shown = useMemo(() => result?.files.reduce((n, f) => n + f.matches.length, 0) ?? 0, [result]);

  return (
    <div class="project-search" hidden={hidden} data-project-search>
      <div class="ps-box">
        <input ref={input} value={q} placeholder="Search in the project" aria-label="Search in the project" spellcheck={false} autocomplete="off"
          onInput={e => setQ((e.target as HTMLInputElement).value)}
          onKeyDown={e => { if (e.key === 'Escape' && q) { e.preventDefault(); e.stopPropagation(); setQ(''); } }} />
        <span class="ps-opts">
          {toggle('matchCase', 'Aa', 'Match case')}
          {toggle('wholeWord', 'ab', 'Whole word')}
          {toggle('regex', '.*', 'Regular expression')}
        </span>
      </div>
      <div class="ps-summary" aria-live="polite">
        {!project ? 'No project open.'
          : error ? <span class="ps-error">{error}</span>
          : !q ? 'Finds words in every text file of the project — LaTeX, Markdown, .bib, slides, code.'
          : busy && !result ? 'Searching…'
          : result ? <>
            {result.total ? `${result.total} result${result.total === 1 ? '' : 's'} in ${result.files.length} file${result.files.length === 1 ? '' : 's'}` : 'No results.'}
            {shown < result.total && ` — the first ${shown} shown`}
            {result.truncated && ' — stopped early: narrow the search'}
            {result.skipped > 0 && ` · ${result.skipped} large or binary file${result.skipped === 1 ? '' : 's'} not searched`}
          </> : null}
      </div>
      {result && project && <div class="ps-results">
        {result.files.map(f => {
          const p = project.files.find(x => x.path === f.path);
          const kind = p?.kind === 'html' && p.deliverable ? p.deliverable : /\.md$/i.test(f.path) ? 'md' : p?.kind ?? 'other';
          const cut = f.path.lastIndexOf('/');
          const closed = folded.has(f.path);
          return (
            <div key={f.path} class="ps-file" data-search-file={f.path}>
              <div class="ps-file-row" role="button" aria-expanded={!closed} title={f.path}
                onClick={() => setFolded(s => { const n = new Set(s); if (n.has(f.path)) n.delete(f.path); else n.add(f.path); return n; })}>
                <span class="twisty">{closed ? '▸' : '▾'}</span>
                <span class="ficon icon" dangerouslySetInnerHTML={{ __html: iconSvg(KIND_ICONS[kind] ?? KIND_ICONS.other, 14) }} />
                <span class="ps-fname">{cut < 0 ? f.path : f.path.slice(cut + 1)}</span>
                {cut >= 0 && <span class="ps-dir">{f.path.slice(0, cut)}</span>}
                <span class="group-count">{f.count}</span>
              </div>
              {!closed && f.matches.map((m, i) => (
                <div key={i} class="ps-match" role="button" tabIndex={0} title={`Line ${m.line}${m.slide ? ` · slide ${m.slide}` : ''}`} data-search-line={m.line}
                  onClick={() => go(f.path, m)} onKeyDown={e => { if (e.key === 'Enter') go(f.path, m); }}>
                  {m.slide ? <span class="ps-where">{m.slide}</span> : null}
                  <span class="ps-text">{m.preview.slice(0, m.from)}<mark>{m.preview.slice(m.from, m.to)}</mark>{m.preview.slice(m.to)}</span>
                </div>
              ))}
              {!closed && f.matches.length < f.count && <div class="ps-more">{f.count - f.matches.length} more in this file</div>}
            </div>
          );
        })}
      </div>}
    </div>
  );
}
