/**
 * My library (server library.ts): the account's own references and their PDFs, a Zotero of its own.
 * One view in two sizes — the Library page over the app (from the start screen, or the pane's ⤢),
 * and the pane at the editor's left (the activity bar's Library, beside Files).
 *
 * Adding: the box at the top takes a DOI, an arXiv id, an ISBN, a paper's link or words (candidates
 * are looked up as one types, Add takes one), BibTeX (one entry or many), and PDFs and .bib files
 * dropped anywhere on the view; Import .bib… and Import from Zotero bring whole libraries. A paper
 * the library has already is not added twice — its entry is shown highlighted instead.
 * Finding: search as you type (title, authors, venue, year, key, tags, DOI, note), tags, sort.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { LitHit } from '../api';
import { libraryApi, refreshLibrary, useLibrary, putRef, dropRef, matchRef, authorsLine, openLibrary, type LibRef, type AddOutcome } from './store';
import './library.css';

type Sort = 'added' | 'title' | 'year' | 'author';
const SORTS: [Sort, string][] = [['added', 'Recently added'], ['title', 'Title'], ['year', 'Year (newest first)'], ['author', 'First author']];
const lastName = (r: LibRef) => (r.authors[0] ?? '').trim().split(/\s+/).pop()?.toLowerCase() ?? '';

export function LibraryView({ mode, onClose }: { mode: 'page' | 'pane'; onClose?: () => void }) {
  const lib = useLibrary();
  const [q, setQ] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>('added');
  const [open, setOpen] = useState<number | null>(null);
  const [flash, setFlash] = useState<Set<number>>(new Set());
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const list = useMemo(() => {
    const out = lib.refs.filter(r => (!tag || r.tags.includes(tag)) && matchRef(r, q));
    const by: Record<Sort, (a: LibRef, b: LibRef) => number> = {
      added: (a, b) => b.added - a.added,
      title: (a, b) => a.title.localeCompare(b.title),
      year: (a, b) => (b.year ?? 0) - (a.year ?? 0) || a.title.localeCompare(b.title),
      author: (a, b) => lastName(a).localeCompare(lastName(b)) || (a.year ?? 0) - (b.year ?? 0),
    };
    return out.sort(by[sort]);
  }, [lib.refs, q, tag, sort]);

  /** what an add did, said in one line; new and existing entries flash in the list */
  const report = (o: AddOutcome) => {
    for (const r of [...o.added, ...o.duplicates]) putRef(r);
    const parts: string[] = [];
    if (o.added.length) parts.push(o.added.length === 1 ? `Added “${o.added[0].title}” as [${o.added[0].key}]` : `Added ${o.added.length} references`);
    if (o.duplicates.length) parts.push(o.duplicates.length === 1 ? `“${o.duplicates[0].title}” is in your library already [${o.duplicates[0].key}]` : `${o.duplicates.length} were in your library already`);
    if (o.failed.length) parts.push(`${o.failed.length} could not be read: ${o.failed.slice(0, 2).join('; ')}`);
    setStatus({ text: parts.join(' · ') || 'Nothing to add', error: !o.added.length && !o.duplicates.length });
    const ids = new Set([...o.added, ...o.duplicates].map(r => r.id));
    setFlash(ids);
    if (ids.size === 1) { setOpen([...ids][0]); setQ(''); setTag(null); }
    setTimeout(() => setFlash(new Set()), 2600);
  };
  const run = async (what: string, f: () => Promise<void>) => {
    setBusy(what); setStatus(null);
    try { await f(); } catch (e) { setStatus({ text: (e as Error).message, error: true }); } finally { setBusy(null); }
  };

  const addFiles = (files: File[]) => run('files', async () => {
    const total: AddOutcome = { added: [], duplicates: [], failed: [] };
    for (const f of files) {
      if (/\.pdf$/i.test(f.name) || f.type === 'application/pdf') {
        setStatus({ text: `Reading ${f.name}…` });
        try {
          const r = await libraryApi.addPdf(f);
          (r.duplicate ? total.duplicates : total.added).push(r.ref);
          if (!r.found && !r.duplicate) total.failed.push(`${f.name}: no DOI or arXiv id found in it — kept under its title, edit the entry`);
        } catch (e) { total.failed.push(`${f.name}: ${(e as Error).message}`); }
      } else if (/\.(bib|bibtex|txt)$/i.test(f.name)) {
        try { const o = await libraryApi.addText(await f.text(), 'file'); total.added.push(...o.added); total.duplicates.push(...o.duplicates); total.failed.push(...o.failed); }
        catch (e) { total.failed.push(`${f.name}: ${(e as Error).message}`); }
      } else total.failed.push(`${f.name}: not a PDF or a .bib file`);
    }
    report(total);
  });

  const page = mode === 'page';
  return (
    <div class={'library library-' + mode + (dragging ? ' dropping' : '')} data-library={mode}
      onDragOver={e => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={e => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={e => { if (!e.dataTransfer?.files.length) return; e.preventDefault(); setDragging(false); void addFiles([...e.dataTransfer.files]); }}>
      <div class="library-head">
        <h2>My library</h2>
        <span class="library-count">{lib.loaded ? `${lib.refs.length} reference${lib.refs.length === 1 ? '' : 's'}` : '…'}</span>
        <span class="library-grow" />
        {!page && <button class="small-btn" title="Open the Library page" onClick={() => openLibrary(true)} data-library-expand>⤢</button>}
        {onClose && <button class="small-btn" title={page ? 'Close the Library' : 'Hide the Library'} onClick={onClose} data-library-close>✕</button>}
      </div>
      {lib.loaded && !lib.available ? <div class="library-empty">{lib.error ?? 'Your library is not available here.'}</div> : <>
        <AddBox compact={!page} lookups={lib.lookups} busy={busy} onBusy={setBusy} onReport={report} onStatus={setStatus} />
        <div class="library-tools">
          <button class="small-btn" onClick={() => fileInput.current?.click()} title="Add PDFs or a .bib file from this computer (or drop them here)">Add files…</button>
          {lib.zotero && <button class="small-btn" disabled={!!busy} data-library-zotero onClick={() => void run('zotero', async () => { setStatus({ text: 'Bringing your Zotero library over…' }); report(await libraryApi.importZotero()); })}>{busy === 'zotero' ? 'Importing…' : 'Import from Zotero'}</button>}
          {lib.refs.length > 0 && <a class="small-btn" href={libraryApi.exportUrl()} title="All references as one .bib file">Export .bib</a>}
          <input ref={fileInput} type="file" multiple accept=".pdf,.bib,.bibtex,application/pdf" style="display:none" onChange={e => { const fs = [...(e.currentTarget.files ?? [])]; e.currentTarget.value = ''; if (fs.length) void addFiles(fs); }} />
        </div>
        {status && <div class={'library-status' + (status.error ? ' error' : '')} role="status" data-library-status>{status.text}</div>}
        <div class="library-find">
          <input type="search" value={q} placeholder="Search title, authors, year, tag…" aria-label="Search the library" onInput={e => setQ(e.currentTarget.value)} data-library-search />
          <select value={sort} aria-label="Sort" onChange={e => setSort(e.currentTarget.value as Sort)}>{SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </div>
        {lib.tags.length > 0 && <div class="library-tags">
          {lib.tags.map(t => <button key={t.name} class={'library-tag' + (tag === t.name ? ' on' : '')} aria-pressed={tag === t.name} onClick={() => setTag(tag === t.name ? null : t.name)}>{t.name} <span>{t.count}</span></button>)}
        </div>}
        <div class="library-body">
          <div class="library-list" role="list">
            {list.map(r => <div key={r.id} role="listitem">
              <RefRow r={r} open={open === r.id} flash={flash.has(r.id)} onToggle={() => setOpen(open === r.id ? null : r.id)} />
              {open === r.id && !page && <RefEditor id={r.id} onDone={() => setOpen(null)} />}
            </div>)}
            {lib.loaded && !lib.refs.length && <div class="library-empty">Your library is empty. Paste a DOI, an arXiv id, a paper’s link or BibTeX above — or drop PDFs and .bib files here.</div>}
            {lib.refs.length > 0 && !list.length && <div class="library-empty">Nothing matches.</div>}
          </div>
          {page && <div class="library-detail">{open != null && lib.refs.some(r => r.id === open) ? <RefEditor key={open} id={open} onDone={() => setOpen(null)} /> : <div class="library-empty">Choose a reference to see and edit it.</div>}</div>}
        </div>
      </>}
      {dragging && <div class="library-drop">Drop PDFs or .bib files to add them</div>}
    </div>
  );
}

function RefRow({ r, open, flash, onToggle }: { r: LibRef; open: boolean; flash: boolean; onToggle: () => void }) {
  return (
    <div class={'library-ref' + (open ? ' sel' : '') + (flash ? ' flash' : '')} data-ref-key={r.key} onClick={onToggle}>
      <div class="library-ref-title">{r.title}</div>
      <div class="library-ref-sub">{authorsLine(r.authors, 3)}{r.year ? ` · ${r.year}` : ''}{r.venue ? ` · ${r.venue}` : ''}</div>
      <div class="library-ref-meta">
        <code>{r.key}</code>
        {r.tags.map(t => <span key={t} class="library-chip">{t}</span>)}
        {r.pdf && <a class="library-pdf" href={libraryApi.pdfUrl(r.id)} target="_blank" rel="noopener" onClick={e => e.stopPropagation()} title="Open the PDF">PDF</a>}
      </div>
    </div>
  );
}

/** The add box: identifiers and words looked up as one types; BibTeX added as it is. */
function AddBox({ compact, lookups, busy, onBusy, onReport, onStatus }: { compact: boolean; lookups: boolean; busy: string | null; onBusy: (b: string | null) => void; onReport: (o: AddOutcome) => void; onStatus: (s: { text: string; error?: boolean } | null) => void }) {
  const [text, setText] = useState('');
  const [hits, setHits] = useState<LitHit[]>([]);
  const [warn, setWarn] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const isBib = /@[a-zA-Z]{2,24}\s*[{(]/.test(text);
  const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);
  useEffect(() => {
    setHits([]); setWarn(null);
    const t = text.trim();
    if (!lookups || isBib || lines.length > 1 || t.length < 3) return;
    setSearching(true);
    const h = setTimeout(() => {
      libraryApi.lookup(t).then(r => { setHits(r.hits); setWarn(r.warnings?.join(' · ') || null); }).catch(e => setWarn((e as Error).message)).finally(() => setSearching(false));
    }, 500);
    return () => { clearTimeout(h); setSearching(false); };
  }, [text, lookups]);
  const add = async (f: () => Promise<AddOutcome>, what: string) => {
    onBusy(what); onStatus(null);
    try { onReport(await f()); setText(''); setHits([]); } catch (e) { onStatus({ text: (e as Error).message, error: true }); } finally { onBusy(null); }
  };
  return (
    <div class="library-add">
      <textarea rows={isBib || lines.length > 1 ? 4 : 1} value={text} data-library-add
        placeholder={!lookups ? 'Add: paste BibTeX' : compact ? 'Add: DOI, arXiv id, link, BibTeX…' : 'Add: a DOI, arXiv id, ISBN, a paper’s link, a title — or paste BibTeX'}
        onInput={e => setText(e.currentTarget.value)}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !isBib && lines.length <= 1) { e.preventDefault(); if (hits[0]) void add(() => libraryApi.addHit(hits[0]), 'hit:' + hits[0].id); } }} />
      {(isBib || lines.length > 1) && <div class="library-add-row">
        <button class="btn primary small" disabled={!!busy} data-library-add-text onClick={() => void add(() => libraryApi.addText(text), 'text')}>{busy === 'text' ? 'Adding…' : isBib ? 'Add BibTeX' : `Look up and add ${lines.length}`}</button>
      </div>}
      {(hits.length > 0 || searching || warn) && !isBib && <div class="library-hits" data-library-hits>
        {searching && !hits.length && <div class="library-hint">Looking it up…</div>}
        {hits.map(h => <div key={h.id} class="library-hit">
          <div class="library-hit-main"><b>{h.title}</b><div class="library-ref-sub">{h.note ? `${h.note} · ` : ''}{authorsLine(h.authors, 3)}{h.year ? ` · ${h.year}` : ''}{h.venue ? ` · ${h.venue}` : ''}</div></div>
          <button class="small-btn" disabled={!!busy} onClick={() => void add(() => libraryApi.addHit(h), 'hit:' + h.id)}>{busy === 'hit:' + h.id ? 'Adding…' : 'Add'}</button>
        </div>)}
        {warn && !hits.length && !searching && <div class="library-hint error">{warn}</div>}
      </div>}
    </div>
  );
}

/** One reference: its fields to edit, its PDF, its BibTeX. */
export function RefEditor({ id, onDone }: { id: number; onDone: () => void }) {
  const [r, setR] = useState<LibRef | null>(null);
  const [f, setF] = useState<Record<string, string>>({});
  const [bib, setBib] = useState('');
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const pdfInput = useRef<HTMLInputElement>(null);
  const load = (x: LibRef) => {
    setR(x); setBib(x.bibtex ?? '');
    setF({ title: x.title, authors: x.authors.join('\n'), year: x.year ? String(x.year) : '', venue: x.venue, doi: x.doi ?? '', arxiv: x.arxiv ?? '', url: x.url ?? '', tags: x.tags.join(', '), note: x.note, key: x.key, abstract: x.abstract ?? '' });
  };
  useEffect(() => { libraryApi.get(id).then(load).catch(e => setMsg({ text: (e as Error).message, error: true })); }, [id]);
  if (!r) return <div class="library-editor">{msg ? <div class="library-hint error">{msg.text}</div> : <div class="library-hint">…</div>}</div>;
  const set = (k: string) => (e: { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => setF(v => ({ ...v, [k]: e.currentTarget.value }));
  const act = async (fn: () => Promise<LibRef | void>, ok: string) => {
    setBusy(true); setMsg(null);
    try { const x = await fn(); if (x) { load({ ...r, ...x }); putRef(x); } setMsg({ text: ok }); } catch (e) { setMsg({ text: (e as Error).message, error: true }); } finally { setBusy(false); }
  };
  const save = () => act(() => {
    const patch: Record<string, unknown> = {};
    const before: Record<string, string> = { title: r.title, authors: r.authors.join('\n'), year: r.year ? String(r.year) : '', venue: r.venue, doi: r.doi ?? '', arxiv: r.arxiv ?? '', url: r.url ?? '', tags: r.tags.join(', '), note: r.note, key: r.key, abstract: r.abstract ?? '' };
    for (const k of Object.keys(before)) if (f[k] !== before[k]) patch[k] = k === 'authors' ? f.authors.split(/\n|\s+and\s+/).map(s => s.trim()).filter(Boolean) : k === 'tags' ? f.tags.split(',').map(s => s.trim()).filter(Boolean) : f[k];
    return Object.keys(patch).length ? libraryApi.edit(r.id, patch) : Promise.resolve();
  }, 'Saved');
  const row = (k: string, label: string, multi = 0) => (
    <label class="library-field"><span>{label}</span>{multi ? <textarea rows={multi} value={f[k]} onInput={set(k)} /> : <input type="text" value={f[k]} onInput={set(k)} />}</label>
  );
  return (
    <div class="library-editor" data-library-editor={r.key} onClick={e => e.stopPropagation()}>
      {row('title', 'Title', 2)}
      {row('authors', 'Authors (one per line)', Math.min(5, Math.max(2, r.authors.length)))}
      <div class="library-field-pair">{row('year', 'Year')}{row('key', 'Citation key')}</div>
      {row('venue', 'Journal, conference or publisher')}
      <div class="library-field-pair">{row('doi', 'DOI')}{row('arxiv', 'arXiv id')}</div>
      {row('url', 'Link')}
      {row('tags', 'Tags (separated by commas)')}
      {row('note', 'Note (only you see it)', 2)}
      {row('abstract', 'Abstract', 3)}
      <div class="library-actions">
        <button class="btn primary small" disabled={busy} onClick={() => void save()} data-library-save>Save</button>
        {r.pdf ? <>
          <a class="btn small" href={libraryApi.pdfUrl(r.id)} target="_blank" rel="noopener" data-library-open-pdf>Open PDF</a>
          <button class="btn small" disabled={busy} onClick={() => void act(() => libraryApi.removePdf(r.id), 'PDF removed')}>Remove PDF</button>
        </> : <button class="btn small" disabled={busy} onClick={() => pdfInput.current?.click()}>Attach PDF…</button>}
        {r.url && <a class="btn small" href={r.url} target="_blank" rel="noopener">Open link ↗</a>}
        <span class="library-grow" />
        <button class="btn small danger" disabled={busy} onClick={() => void act(async () => { await libraryApi.remove(r.id); dropRef(r.id); onDone(); }, 'Removed')}>Remove</button>
        <input ref={pdfInput} type="file" accept=".pdf,application/pdf" style="display:none" onChange={e => { const file = e.currentTarget.files?.[0]; e.currentTarget.value = ''; if (file) void act(() => libraryApi.attachPdf(r.id, file), 'PDF attached'); }} />
      </div>
      {msg && <div class={'library-hint' + (msg.error ? ' error' : '')} role="status">{msg.text}</div>}
      <details class="library-bibtex">
        <summary>BibTeX</summary>
        <textarea rows={8} value={bib} onInput={e => setBib(e.currentTarget.value)} spellcheck={false} />
        <button class="btn small" disabled={busy || bib === (r.bibtex ?? '')} onClick={() => void act(() => libraryApi.edit(r.id, { bibtex: bib }), 'BibTeX saved')}>Save BibTeX</button>
      </details>
    </div>
  );
}

/** The Library page over the app (the start screen's My library, the pane's ⤢); Escape closes it. */
export function LibraryPage({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    void refreshLibrary();
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target as HTMLElement)?.closest?.('input,textarea,select')) onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  return <div class="library-overlay" role="dialog" aria-label="My library"><LibraryView mode="page" onClose={onClose} /></div>;
}
