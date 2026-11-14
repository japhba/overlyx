/**
 * My library in the citation dialog (Dialogs.tsx CiteDialog, the same in documents, markdown and
 * slides): the references of the library that match the search and that the project does not have
 * yet come first, marked. Choosing one adds its entry to the cited.bib beside the document (server
 * index.ts /bib/add `library`: under its library key when the project has none such, without its
 * abstract or note) and selects it — the document then compiles anywhere, as with any citation.
 * Where there is no library (the VS Code extension, a guest) nothing is shown.
 */
import { useMemo, useState } from 'preact/hooks';
import { api, type BibAddResult, type LitHit } from '../api';
import { useLibrary, matchRef, authorsShort, normTitle, libraryApi, putRef, type LibRef } from './store';

export function LibraryCiteRows({ q, project, docId, have, onTook, onError }: {
  q: string; project: string; docId?: string;
  /** the project's entries the dialog knows (by key and title): those are listed as the project's */
  have: { key: string; title: string }[];
  onTook: (r: BibAddResult) => void; onError: (message: string) => void;
}) {
  const lib = useLibrary();
  const [busy, setBusy] = useState<number | null>(null);
  const rows = useMemo(() => {
    if (!lib.available) return [];
    const keys = new Set(have.map(h => h.key)), titles = new Set(have.map(h => normTitle(h.title)));
    return lib.refs.filter(r => !keys.has(r.key) && !titles.has(normTitle(r.title)) && matchRef(r, q)).slice(0, q.trim() ? 30 : 8);
  }, [lib.refs, lib.available, q, have]);
  if (!rows.length) return null;
  const pick = async (r: LibRef) => {
    setBusy(r.id);
    try { onTook(await api.bibAdd(project, { library: r.id, doc: docId })); }
    catch (e) { onError((e as Error).message); }
    finally { setBusy(null); }
  };
  return <>
    {rows.map(r => (
      <div key={'lib-' + r.id} data-cite-library={r.key} title="From your library — choosing it adds it to this project’s cited.bib and selects it" onClick={() => { if (busy == null) void pick(r); }}>
        <span class="cite-lib-tag">My library</span><b>{authorsShort(r.authors) || r.key}</b> {r.year ?? ''} <span class="sub">— {r.title}</span> <span class="sub">[{busy === r.id ? 'adding…' : r.key}]</span>
      </div>
    ))}
  </>;
}

/** "+ Library" beside a paper found online: into My library as well (the dialog's Cite adds it to the project). */
export function AddHitToLibrary({ hit }: { hit: LitHit }) {
  const lib = useLibrary();
  const [state, setState] = useState<'' | 'busy' | 'done' | 'there'>('');
  const [error, setError] = useState('');
  if (!lib.available) return null;
  const add = async () => {
    setState('busy'); setError('');
    try { const o = await libraryApi.addHit(hit); for (const r of [...o.added, ...o.duplicates]) putRef(r); setState(o.added.length ? 'done' : 'there'); }
    catch (e) { setState(''); setError((e as Error).message); }
  };
  return <button class="small-btn" data-cite-to-library disabled={state !== ''} title={error || 'Keep this paper in My library too'} onClick={ev => { ev.stopPropagation(); void add(); }}>
    {state === 'busy' ? 'Adding…' : state === 'done' ? '✓ In library' : state === 'there' ? 'In library' : '+ Library'}
  </button>;
}
