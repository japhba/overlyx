/**
 * Start page ▸ Import from Overleaf. Two ways in, because Overleaf has no API that lists a user's
 * projects: (1) paste the links of the projects to bring over and an Overleaf Git token — each
 * ticked project is cloned by the server (the Git integration of paid / institutional Overleaf
 * accounts; history and `origin` are kept); (2) upload the zip that Overleaf's Menu ▸ Download ▸
 * Source gives you (works for every account), or the bundle of zips the project list's download
 * produces — every project inside becomes a project. Every imported project gets a name you can
 * edit here.
 *
 * The landing page offers the same before sign-in (OverleafStart.tsx): what was chosen there
 * arrives as `initial` and, with `autostart`, runs the moment the dialog opens; `onDone` gets the
 * names of the projects that came in, so the start page can open a lone one straight away.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api } from '../api';
import { Dialog } from './Dialogs';

const ID_RE = /(?:overleaf\.com\/(?:project\/)?)?([0-9a-f]{24})(?![0-9a-f])/gi;
/** Overleaf project ids in a pasted text (links or bare ids), in order, unique */
export function parseOverleafRefs(text: string): string[] {
  const ids: string[] = [];
  for (const m of text.matchAll(ID_RE)) { const id = m[1].toLowerCase(); if (!ids.includes(id)) ids.push(id); }
  return ids;
}
/** a legal project name from a file or link name */
export function projectNameFrom(s: string): string {
  const base = s.replace(/\.zip$/i, '').replace(/[^A-Za-z0-9._ -]+/g, '-').replace(/^[-. ]+|[-. ]+$/g, '').slice(0, 60);
  return base || 'overleaf-project';
}
/** Overleaf's project-list download ("Overleaf Projects -2 items.zip") holds one zip per project */
export const isOverleafBundle = (fileName: string) => /^Overleaf Projects/i.test(fileName);

type Status = 'working' | 'ok' | 'error';
type Row = { id: string; name: string; on: boolean; status?: Status; message?: string };
export type ZipRow = { file: File; name: string; status?: Status; message?: string; imported?: string[] };

export interface ImportInitial { links?: string; token?: string; zips?: File[] }

export function OverleafImport({ existing, onClose, onImported, notify, initial, autostart, onDone }: {
  existing: string[]; onClose: () => void; onImported: () => void; notify: (text: string, kind?: 'info' | 'error') => void;
  /** what the visitor chose on the landing page before signing in */
  initial?: ImportInitial;
  /** start importing `initial` as soon as the dialog opens */
  autostart?: boolean;
  /** an auto-started import finished: the names of the projects that came in */
  onDone?: (names: string[]) => void;
}) {
  const [links, setLinks] = useState(initial?.links ?? '');
  const [token, setToken] = useState(initial?.token ?? '');
  const [names, setNames] = useState<Record<string, string>>({});
  const [off, setOff] = useState<Record<string, boolean>>({});
  const [results, setResults] = useState<Record<string, { status: Status; message?: string }>>({});
  const [busy, setBusy] = useState(false);
  const [zips, setZips] = useState<ZipRow[]>(() => (initial?.zips ?? []).map(f => ({ file: f, name: projectNameFrom(f.name) })));
  const ids = useMemo(() => parseOverleafRefs(links), [links]);
  const rows: Row[] = ids.map(id => ({ id, name: names[id] ?? `overleaf-${id.slice(-6)}`, on: !off[id] && results[id]?.status !== 'ok', ...results[id] }));
  const selected = rows.filter(r => r.on);
  const taken = (name: string) => existing.includes(name);

  /** clone the ticked Overleaf projects; returns the names that came in */
  const importGit = async (): Promise<string[]> => {
    if (!token.trim()) { notify('Paste your Overleaf Git token first (Overleaf ▸ Account settings ▸ Git integration ▸ Generate token).', 'error'); return []; }
    if (!selected.length) return [];
    setBusy(true);
    setResults(r => ({ ...r, ...Object.fromEntries(selected.map(s => [s.id, { status: 'working' as const }])) }));
    try {
      const { results: out } = await api.importOverleaf({ token: token.trim(), projects: selected.map(s => ({ id: s.id, name: s.name.trim() })) });
      setResults(r => ({ ...r, ...Object.fromEntries(out.map(o => [o.id, { status: o.ok ? 'ok' as const : 'error' as const, message: o.ok ? `imported as “${o.name}”` : o.error }])) }));
      const okNames = out.filter(o => o.ok).map(o => o.name);
      if (okNames.length) { onImported(); notify(`${okNames.length} project${okNames.length === 1 ? '' : 's'} imported from Overleaf`); }
      return okNames;
    } catch (e) {
      setResults(r => ({ ...r, ...Object.fromEntries(selected.map(s => [s.id, { status: 'error' as const, message: (e as Error).message }])) }));
      return [];
    } finally { setBusy(false); }
  };

  const addZips = (files: FileList | File[] | null) => {
    if (!files) return;
    setZips(z => [...z, ...Array.from(files).filter(f => !z.some(x => x.file === f)).map(f => ({ file: f, name: projectNameFrom(f.name) }))]);
  };
  /** unpack the zips that are not in yet; returns the names of the projects that came in */
  const importZips = async (): Promise<string[]> => {
    const todo = zips.filter(z => z.status !== 'ok');
    if (!todo.length) return [];
    setBusy(true);
    const okNames: string[] = [];
    for (const z of todo) {
      setZips(list => list.map(x => (x === z ? { ...x, status: 'working' } : x)));
      try {
        const r = await api.importZip(z.name.trim(), z.file);
        const made = r.projects?.length ? r.projects : [{ name: r.name, files: r.files, skipped: r.skipped }];
        okNames.push(...made.map(p => p.name));
        const failed = r.errors ?? [];
        const message = made.length === 1 && !failed.length
          ? `${made[0].name !== z.name.trim() ? `as “${made[0].name}”, ` : ''}${made[0].files} file${made[0].files === 1 ? '' : 's'}${made[0].skipped.length ? `, ${made[0].skipped.length} skipped` : ''}`
          : `${made.length} project${made.length === 1 ? '' : 's'}: ${made.map(p => `“${p.name}”`).join(', ')}${failed.length ? ` — not imported: ${failed.map(f => `“${f.name}” (${f.error})`).join(', ')}` : ''}`;
        setZips(list => list.map(x => (x === z ? { ...x, status: 'ok', message, imported: made.map(p => p.name) } : x)));
      } catch (e) { setZips(list => list.map(x => (x === z ? { ...x, status: 'error', message: (e as Error).message } : x))); }
    }
    setBusy(false);
    if (okNames.length) { onImported(); notify(`${okNames.length} project${okNames.length === 1 ? '' : 's'} imported`); }
    return okNames;
  };

  // the landing page's import: everything that was chosen runs at once
  const started = useRef(false);
  useEffect(() => {
    if (!autostart || started.current) return;
    started.current = true;
    void (async () => {
      const names = [...await importZips(), ...(selected.length && token.trim() ? await importGit() : [])];
      onDone?.(names);
    })();
  }, []);

  const status = (s?: string, m?: string) => s === 'working' ? <span class="status working">importing…</span> : s === 'ok' ? <span class="status ok">✓ {m}</span> : s === 'error' ? <span class="status error">{m}</span> : null;
  const pendingZips = zips.filter(z => z.status !== 'ok');

  return (
    <Dialog title="Import from Overleaf" onClose={onClose} wide>
      <div class="overleaf-import" data-overleaf-import>
        <section>
          <h3>From a downloaded zip</h3>
          <div class="hint">Works with every Overleaf account: in Overleaf open the project, Menu ▸ Download ▸ Source, then choose the zip here (several at once is fine — each becomes a project). The download of your whole project list (<i>Overleaf Projects -N items.zip</i>) works too: every project in it comes in on its own.</div>
          <div class="row">
            <input type="file" accept=".zip,application/zip" multiple data-overleaf-zip disabled={busy} onChange={e => { addZips((e.target as HTMLInputElement).files); (e.target as HTMLInputElement).value = ''; }} />
            <button class="btn primary" data-overleaf-import-zip disabled={busy || !pendingZips.length || pendingZips.some(z => taken(z.name.trim()) && !isOverleafBundle(z.file.name))} onClick={() => void importZips()}>Import {pendingZips.length || ''} zip{pendingZips.length === 1 ? '' : 's'}</button>
          </div>
          {zips.length > 0 && (
            <table class="import-rows">
              <thead><tr><th>File</th><th>Name here</th><th></th></tr></thead>
              <tbody>{zips.map((z, i) => (
                <tr key={i} class={z.status ?? ''} data-zip-row={z.file.name}>
                  <td title={z.file.name}>{z.file.name} <span class="size">({Math.max(1, Math.round(z.file.size / 1e6))} MB)</span></td>
                  <td>{isOverleafBundle(z.file.name)
                    ? <span class="size" title="A download of your project list: every project in it keeps its own name">one project per zip inside</span>
                    : <input type="text" value={z.name} disabled={busy || z.status === 'ok'} class={taken(z.name.trim()) ? 'taken' : ''} title={taken(z.name.trim()) ? 'A project with this name exists already' : ''} onInput={e => { const v = (e.target as HTMLInputElement).value; setZips(list => list.map(x => (x === z ? { ...x, name: v } : x))); }} />}</td>
                  <td>{status(z.status, z.message)}</td>
                </tr>))}</tbody>
            </table>
          )}
        </section>
        <section>
          <h3>From Overleaf's Git access</h3>
          <div class="hint">Paste the links of the projects to bring over — one per line, as copied from the browser's address bar (<code>https://www.overleaf.com/project/…</code>). Overleaf's Git access is part of its paid and institutional plans; the token comes from <a href="https://www.overleaf.com/user/settings" target="_blank" rel="noopener">Account settings ▸ Git integration</a>. It is used once for the import and not stored.</div>
          <textarea data-overleaf-links rows={3} placeholder={'https://www.overleaf.com/project/5f1a…\nhttps://www.overleaf.com/project/60b3…'} value={links} onInput={e => setLinks((e.target as HTMLTextAreaElement).value)} disabled={busy} />
          {rows.length > 0 && (
            <table class="import-rows">
              <thead><tr><th></th><th>Overleaf project</th><th>Name here</th><th></th></tr></thead>
              <tbody>{rows.map(r => (
                <tr key={r.id} data-import-row={r.id} class={r.status ?? ''}>
                  <td><input type="checkbox" checked={r.on} disabled={busy || r.status === 'ok'} onChange={e => setOff(o => ({ ...o, [r.id]: !(e.target as HTMLInputElement).checked }))} /></td>
                  <td><code title={r.id}>…{r.id.slice(-8)}</code></td>
                  <td><input type="text" value={r.name} disabled={busy || r.status === 'ok'} class={taken(r.name.trim()) ? 'taken' : ''} title={taken(r.name.trim()) ? 'A project with this name exists already' : ''} onInput={e => setNames(n => ({ ...n, [r.id]: (e.target as HTMLInputElement).value }))} /></td>
                  <td>{status(r.status, r.message)}</td>
                </tr>))}</tbody>
            </table>
          )}
          <div class="row">
            <input type="password" data-overleaf-token placeholder="Overleaf Git token (olp_…)" value={token} onInput={e => setToken((e.target as HTMLInputElement).value)} disabled={busy} autocomplete="off" />
            <button class="btn primary" data-overleaf-import-git disabled={busy || !selected.length || selected.some(s => taken(s.name.trim()))} onClick={() => void importGit()}>
              Import {selected.length ? `${selected.length} selected` : 'selected'}
            </button>
          </div>
        </section>
      </div>
    </Dialog>
  );
}
