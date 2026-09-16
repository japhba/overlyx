/**
 * Start page ▸ Import from Overleaf. Two ways in, because Overleaf has no API that lists a user's
 * projects: (1) paste the links of the projects to bring over and an Overleaf Git token — each
 * ticked project is cloned by the server (the Git integration of paid / institutional Overleaf
 * accounts; history and `origin` are kept); (2) upload the zip that Overleaf's Menu ▸ Download ▸
 * Source gives you (works for every account). Every imported project gets a name you can edit here.
 */
import { useMemo, useState } from 'preact/hooks';
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

type Row = { id: string; name: string; on: boolean; status?: 'working' | 'ok' | 'error'; message?: string };
type ZipRow = { file: File; name: string; status?: 'working' | 'ok' | 'error'; message?: string };

export function OverleafImport({ existing, onClose, onImported, notify }: { existing: string[]; onClose: () => void; onImported: () => void; notify: (text: string, kind?: 'info' | 'error') => void }) {
  const [links, setLinks] = useState('');
  const [token, setToken] = useState('');
  const [names, setNames] = useState<Record<string, string>>({});
  const [off, setOff] = useState<Record<string, boolean>>({});
  const [results, setResults] = useState<Record<string, { status: 'working' | 'ok' | 'error'; message?: string }>>({});
  const [busy, setBusy] = useState(false);
  const [zips, setZips] = useState<ZipRow[]>([]);
  const ids = useMemo(() => parseOverleafRefs(links), [links]);
  const rows: Row[] = ids.map(id => ({ id, name: names[id] ?? `overleaf-${id.slice(-6)}`, on: !off[id] && results[id]?.status !== 'ok', ...results[id] }));
  const selected = rows.filter(r => r.on);
  const taken = (name: string) => existing.includes(name);

  const importGit = async () => {
    if (!token.trim()) { notify('Paste your Overleaf Git token first (Overleaf ▸ Account settings ▸ Git integration ▸ Generate token).', 'error'); return; }
    if (!selected.length) return;
    setBusy(true);
    setResults(r => ({ ...r, ...Object.fromEntries(selected.map(s => [s.id, { status: 'working' as const }])) }));
    try {
      const { results: out } = await api.importOverleaf({ token: token.trim(), projects: selected.map(s => ({ id: s.id, name: s.name.trim() })) });
      setResults(r => ({ ...r, ...Object.fromEntries(out.map(o => [o.id, { status: o.ok ? 'ok' as const : 'error' as const, message: o.ok ? `imported as “${o.name}”` : o.error }])) }));
      const okCount = out.filter(o => o.ok).length;
      if (okCount) { onImported(); notify(`${okCount} project${okCount === 1 ? '' : 's'} imported from Overleaf`); }
    } catch (e) {
      setResults(r => ({ ...r, ...Object.fromEntries(selected.map(s => [s.id, { status: 'error' as const, message: (e as Error).message }])) }));
    } finally { setBusy(false); }
  };

  const addZips = (files: FileList | null) => {
    if (!files) return;
    setZips(z => [...z, ...Array.from(files).filter(f => !z.some(x => x.file === f)).map(f => ({ file: f, name: projectNameFrom(f.name) }))]);
  };
  const importZips = async () => {
    const todo = zips.filter(z => z.status !== 'ok');
    if (!todo.length) return;
    setBusy(true);
    let okCount = 0;
    for (const z of todo) {
      setZips(list => list.map(x => (x === z ? { ...x, status: 'working' } : x)));
      try {
        const r = await api.importZip(z.name.trim(), z.file);
        okCount++;
        setZips(list => list.map(x => (x === z ? { ...x, status: 'ok', message: `${r.files} file${r.files === 1 ? '' : 's'}${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}` } : x)));
      } catch (e) { setZips(list => list.map(x => (x === z ? { ...x, status: 'error', message: (e as Error).message } : x))); }
    }
    setBusy(false);
    if (okCount) { onImported(); notify(`${okCount} project${okCount === 1 ? '' : 's'} imported`); }
  };

  const status = (s?: string, m?: string) => s === 'working' ? <span class="status working">importing…</span> : s === 'ok' ? <span class="status ok">✓ {m}</span> : s === 'error' ? <span class="status error">{m}</span> : null;

  return (
    <Dialog title="Import from Overleaf" onClose={onClose} wide>
      <div class="overleaf-import" data-overleaf-import>
        <section>
          <h3>From Overleaf's Git access</h3>
          <div class="hint">Paste the links of the projects to bring over — one per line, as copied from the browser's address bar (<code>https://www.overleaf.com/project/…</code>). Overleaf's Git access is part of its paid and institutional plans; the token comes from <a href="https://www.overleaf.com/user/settings" target="_blank" rel="noopener">Account settings ▸ Git integration</a>. It is used once for the import and not stored.</div>
          <textarea data-overleaf-links rows={4} placeholder={'https://www.overleaf.com/project/5f1a…\nhttps://www.overleaf.com/project/60b3…'} value={links} onInput={e => setLinks((e.target as HTMLTextAreaElement).value)} disabled={busy} />
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
        <section>
          <h3>From a downloaded zip</h3>
          <div class="hint">Works with every Overleaf account: in Overleaf open the project, Menu ▸ Download ▸ Source, then choose the zip here (several at once is fine — each becomes a project).</div>
          <div class="row">
            <input type="file" accept=".zip,application/zip" multiple data-overleaf-zip disabled={busy} onChange={e => { addZips((e.target as HTMLInputElement).files); (e.target as HTMLInputElement).value = ''; }} />
            <button class="btn primary" data-overleaf-import-zip disabled={busy || !zips.some(z => z.status !== 'ok') || zips.some(z => z.status !== 'ok' && taken(z.name.trim()))} onClick={() => void importZips()}>Import {zips.filter(z => z.status !== 'ok').length || ''} zip{zips.filter(z => z.status !== 'ok').length === 1 ? '' : 's'}</button>
          </div>
          {zips.length > 0 && (
            <table class="import-rows">
              <thead><tr><th>File</th><th>Name here</th><th></th></tr></thead>
              <tbody>{zips.map((z, i) => (
                <tr key={i} class={z.status ?? ''}>
                  <td title={z.file.name}>{z.file.name} <span class="size">({Math.max(1, Math.round(z.file.size / 1e6))} MB)</span></td>
                  <td><input type="text" value={z.name} disabled={busy || z.status === 'ok'} class={taken(z.name.trim()) ? 'taken' : ''} onInput={e => { const v = (e.target as HTMLInputElement).value; setZips(list => list.map(x => (x === z ? { ...x, name: v } : x))); }} /></td>
                  <td>{status(z.status, z.message)}</td>
                </tr>))}</tbody>
            </table>
          )}
        </section>
      </div>
    </Dialog>
  );
}
