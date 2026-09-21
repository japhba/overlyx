/**
 * Landing page ▸ "Coming from Overleaf?" — the import for people who do not have an account yet.
 * Drop the zip(s) Overleaf gives you (Menu ▸ Download ▸ Source, or the project list's download
 * of several projects at once), or paste project links with a Git token; everything chosen is
 * parked in the browser (pendingImport.ts) and the one button leads to the sign-in — the start
 * page then imports it all and opens the document. Nothing is uploaded before the sign-in.
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { parseOverleafRefs, isOverleafBundle } from './OverleafImport';
import { stashPendingImport } from './pendingImport';

export function OverleafStart({ google, onSignIn, googleIcon, onChange }: {
  google: boolean;
  /** everything is parked: go and sign in (Google, or the password form) */
  onSignIn: () => void;
  googleIcon?: ComponentChildren;
  /** how many projects are waiting (0 = nothing chosen) */
  onChange?: (count: number) => void;
}) {
  const [zips, setZips] = useState<File[]>([]);
  const [links, setLinks] = useState('');
  const [token, setToken] = useState('');
  const [gitOpen, setGitOpen] = useState(false);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const ids = parseOverleafRefs(links);
  const count = zips.length + ids.length;
  const needToken = ids.length > 0 && !token.trim();

  // whatever is chosen is parked at once, so any of the page's sign-in buttons brings it along
  useEffect(() => {
    onChange?.(count);
    const t = setTimeout(() => { void stashPendingImport({ links, token, zips }).catch(() => {}); }, 150);
    return () => clearTimeout(t);
  }, [zips, links, token]);

  const add = (files: FileList | File[] | null) => {
    if (!files) return;
    const list = Array.from(files).filter(f => /\.zip$/i.test(f.name) || f.type === 'application/zip' || f.type === 'application/x-zip-compressed');
    setZips(z => [...z, ...list.filter(f => !z.some(x => x.name === f.name && x.size === f.size))]);
  };
  const go = async () => {
    if (!count || needToken || busy) return;
    setBusy(true);
    try { await stashPendingImport({ links, token, zips }); }
    catch { /* the sign-in page still works; the import has to be repeated from the start page */ }
    setBusy(false);
    onSignIn();
  };
  const label = count ? `Import ${count} project${count === 1 ? '' : 's'} & ${google ? 'continue with Google' : 'continue'}` : google ? 'Import & continue with Google' : 'Import & continue';

  return (
    <section class="overleaf-start" id="overleaf" aria-label="Coming from Overleaf?" data-overleaf-start>
      <div class="copy">
        <h2>Coming from Overleaf?</h2>
        <p>Bring your projects along — they stay plain LaTeX, and Overleaf, git and your other tools keep working on the same files.</p>
        <ol>
          <li>In Overleaf open the project and choose <b>Menu ▸ Download ▸ Source</b> — or tick several projects in your project list and click <b>Download</b> to get them all in one zip.</li>
          <li>Drop the zip here.</li>
          <li>Sign in — the import runs by itself and your document opens.</li>
        </ol>
        <button type="button" class="git-toggle" data-overleaf-start-git onClick={() => setGitOpen(o => !o)}>
          {gitOpen ? '▾' : '▸'} Have Overleaf's Git access (paid plans)? Paste project links and a Git token instead.
        </button>
        {gitOpen && (
          <div class="git">
            <textarea data-overleaf-start-links rows={3} placeholder={'https://www.overleaf.com/project/5f1a…\nhttps://www.overleaf.com/project/60b3…'} value={links} onInput={e => setLinks((e.target as HTMLTextAreaElement).value)} />
            <input type="password" data-overleaf-start-token placeholder="Overleaf Git token (olp_…) — used once for the import, never stored" value={token} onInput={e => setToken((e.target as HTMLInputElement).value)} autocomplete="off" />
            {ids.length > 0 && <div class="small">{ids.length} project{ids.length === 1 ? '' : 's'} recognised{needToken ? ' — the Git token is still missing' : ''}.</div>}
          </div>
        )}
      </div>
      <div class="pick">
        <div class={'dropzone' + (over ? ' over' : '')} data-overleaf-start-drop role="button" tabIndex={0}
          onClick={() => input.current?.click()} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.current?.click(); } }}
          onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
          onDrop={e => { e.preventDefault(); setOver(false); add(e.dataTransfer?.files ?? null); }}>
          <strong>Drop your Overleaf zip here</strong>
          <span>or click to choose it — several at once is fine</span>
          <input ref={input} type="file" accept=".zip,application/zip" multiple hidden data-overleaf-start-zip onChange={e => { add((e.target as HTMLInputElement).files); (e.target as HTMLInputElement).value = ''; }} />
        </div>
        {zips.length > 0 && (
          <ul class="files" data-overleaf-start-files>
            {zips.map(f => (
              <li key={f.name + f.size}>
                <span>🗜 {f.name}</span>
                <span class="size">{Math.max(1, Math.round(f.size / 1e6))} MB{isOverleafBundle(f.name) ? ' · one project per zip inside' : ''}</span>
                <button type="button" title="Remove" aria-label={'Remove ' + f.name} onClick={() => setZips(z => z.filter(x => x !== f))}>✕</button>
              </li>
            ))}
          </ul>
        )}
        <div class="go">
          <button type="button" class={'google' + (count && !needToken ? '' : ' idle')} data-overleaf-start-go disabled={!count || needToken || busy} onClick={() => void go()}>
            {google && googleIcon}<span>{label}</span>
          </button>
        </div>
        <div class="small">Nothing is uploaded before you sign in. The import lands in your own account; projects stay private until you share them.</div>
      </div>
    </section>
  );
}
