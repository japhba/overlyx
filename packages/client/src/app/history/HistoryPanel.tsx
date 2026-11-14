/**
 * History: one place for the versions of whatever is open — a LaTeX or markdown document, a deck,
 * a poster, a web page or article, a board (the owner, 14 Nov 2026: "an integrated version control
 * interface from which we can easily diff and restore"). Its timeline groups the versions the
 * server keeps (docs.ts `versions`: automatic ones every ten minutes of editing, named ones, the
 * state before a restore, offline edits) by day and by working session, with who was there in
 * their author colours; a version opens its comparison with now (HistoryDiff.tsx), from where the
 * whole version or one changed part is restored as an ordinary edit everyone sees, and undone
 * from here. The project's tab lists recent versions across the project's files and the files
 * deleted since, which can be brought back.
 *
 * End-to-end encrypted projects keep their versions encrypted (e2e/project.ts): this browser
 * decrypts them, so they can be compared and restored whole; what needs the server to read them
 * (naming, restoring a part, the project's list) is not offered there.
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import { lazy, Suspense } from 'preact/compat';
import { api, type VersionInfo } from '../../api';
import { isE2eDocId } from '../../e2e/known';
import { projectOfDoc, docPathOf } from '@overlyx/core';
import { uiPrompt, uiConfirm } from '../Dialogs';
import { authorColorOf } from '../shellutil';
import { useTheme } from '../theme';
import './history.css';

const HistoryDiff = lazy(() => import('./HistoryDiff'));

type Notify = (msg: string, kind?: 'info' | 'error') => void;

/** what can be undone of the last restore from here */
export interface Undo { label: string; run: () => Promise<void> }

/** consecutive automatic versions this close together are one working session */
const SESSION_GAP = 45 * 60 * 1000;

const KIND_LABEL: Record<string, string> = { manual: 'Named', offline: 'Offline edits', agent: 'Agent' };

function dayLabel(t: number): string {
  const d = new Date(t), now = new Date();
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(now) - start(d)) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: days < 7 ? 'long' : undefined, day: 'numeric', month: 'long', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}
const clock = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** a version's name as people read it */
export function versionTitle(v: Pick<VersionInfo, 'name' | 'kind'>): string {
  if (v.kind === 'auto' && (v.name === 'autosave' || !v.name)) return 'Automatic version';
  if (/^before restore of "/.test(v.name)) return 'Before restoring ' + v.name.slice('before restore of '.length);
  // (the server's own names are lower case: "before a change on disk"; people's names stay as written)
  return v.kind === 'auto' ? v.name.charAt(0).toUpperCase() + v.name.slice(1) : v.name;
}

export function Authors({ names }: { names: string }) {
  const { theme } = useTheme();
  const list = names.split(',').map(s => s.trim()).filter(s => s && s !== 'system');
  if (!list.length) return null;
  return (
    <span class="hist-authors">
      {list.map(n => <span key={n} class="hist-author" style={{ '--hist-c': authorColorOf(n, theme === 'dark') }}><i />{n}</span>)}
    </span>
  );
}

type Row = { kind: 'one'; v: VersionInfo } | { kind: 'session'; list: VersionInfo[]; key: string };

/** the timeline's rows of one day: named versions one by one, runs of automatic ones as sessions */
function rowsOf(list: VersionInfo[]): Row[] {
  const out: Row[] = [];
  // (only the plain automatic ones: "before restoring …", "before a change on disk" stand out on their own)
  const plain = (v: VersionInfo) => v.kind === 'auto' && v.name === 'autosave';
  for (const v of list) {
    const last = out[out.length - 1];
    if (plain(v) && last?.kind === 'session' && last.list[last.list.length - 1].created_at - v.created_at < SESSION_GAP) { last.list.push(v); continue; }
    if (plain(v) && last?.kind === 'one' && plain(last.v) && last.v.created_at - v.created_at < SESSION_GAP) { out[out.length - 1] = { kind: 'session', list: [last.v, v], key: 's' + last.v.id }; continue; }
    out.push({ kind: 'one', v });
  }
  return out;
}

export function HistoryPanel({ docId, refreshKey = 0, notify, onOpen, onClose }: { docId: string; refreshKey?: number; notify?: Notify; onOpen?: (id: string) => void; onClose?: () => void }) {
  const [versions, setVersions] = useState<VersionInfo[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState<'file' | 'project'>('file');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [compare, setCompare] = useState<{ from: number; to: number | null } | null>(null);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [tick, setTick] = useState(0);
  const e2e = isE2eDocId(docId);
  const say: Notify = notify ?? ((m) => console.info('[history]', m));
  const load = () => api.versions(docId).then(r => { setVersions(r.versions); setFailed(false); }).catch(() => setFailed(true));
  useEffect(() => { setVersions(null); setUndo(null); setCompare(null); void load(); }, [docId]);
  useEffect(() => { void load(); }, [refreshKey, tick]);

  const days = useMemo(() => {
    const out: { label: string; rows: Row[] }[] = [];
    let cur: VersionInfo[] = [], label = '';
    for (const v of versions ?? []) {
      const l = dayLabel(v.created_at);
      if (l !== label && cur.length) { out.push({ label, rows: rowsOf(cur) }); cur = []; }
      label = l; cur.push(v);
    }
    if (cur.length) out.push({ label, rows: rowsOf(cur) });
    return out;
  }, [versions]);

  const nameNow = async () => {
    const name = await uiPrompt('Name This Version', 'A name for the file as it is now (it is kept until you delete it):', '', { placeholder: 'e.g. Sent for review', okLabel: 'Save version' });
    if (name === null) return;
    try { await api.createVersion(docId, name.trim() || new Date().toLocaleString()); void load(); say('Version saved'); }
    catch (e) { say('Could not save the version: ' + (e as Error).message, 'error'); }
  };
  const rename = async (v: VersionInfo) => {
    const name = await uiPrompt('Name This Version', `A name for the version of ${new Date(v.created_at).toLocaleString()}:`, v.kind === 'auto' ? '' : v.name, { okLabel: 'Save name' });
    if (!name?.trim()) return;
    try { await api.nameVersion(docId, v.id, name); void load(); }
    catch (e) { say('Could not name the version: ' + (e as Error).message, 'error'); }
  };
  const del = async (v: VersionInfo) => {
    if (!(await uiConfirm('Delete Version', `Delete the version “${versionTitle(v)}” of ${new Date(v.created_at).toLocaleString()}?`, { danger: true, okLabel: 'Delete' }))) return;
    try { await api.deleteVersion(docId, v.id); void load(); } catch (e) { say('Could not delete: ' + (e as Error).message, 'error'); }
  };
  /** the whole file back to a version; the state before is kept as a version, which Undo restores */
  const restoreWhole = async (v: VersionInfo): Promise<boolean> => {
    if (!(await uiConfirm('Restore Version', `Make the file what it was at ${new Date(v.created_at).toLocaleString()} (“${versionTitle(v)}”)? Everyone working on it sees the change; the file as it is now is kept as a version, and Undo here brings it back.`, { okLabel: 'Restore' }))) return false;
    try {
      await api.restoreVersion(docId, v.id);
      const r = await api.versions(docId);
      setVersions(r.versions);
      const before = r.versions.find(x => /^before restore of "/.test(x.name));
      setUndo(before ? { label: `Restored “${versionTitle(v)}”.`, run: async () => { await api.restoreVersion(docId, before.id); setUndo(null); setTick(t => t + 1); say('The restore was undone'); } } : null);
      say('Version restored');
      return true;
    } catch (e) { say('Could not restore: ' + (e as Error).message, 'error'); return false; }
  };

  const item = (v: VersionInfo, inSession = false) => (
    <li key={v.id} class={'hist-item' + (inSession ? ' in-session' : '') + (compare?.from === v.id ? ' on' : '')} data-version={v.id}>
      <button type="button" class="hist-main" onClick={() => setCompare({ from: v.id, to: null })} title="Compare with the file as it is now">
        <span class="hist-time">{clock(v.created_at)}</span>
        <span class="hist-name">{versionTitle(v)}{KIND_LABEL[v.kind] && v.kind !== 'manual' && <span class={'hist-badge ' + v.kind}>{KIND_LABEL[v.kind]}</span>}</span>
        <Authors names={v.author} />
      </button>
      <span class="hist-actions">
        <button type="button" class="small-btn" onClick={() => setCompare({ from: v.id, to: null })}>Compare</button>
        <button type="button" class="small-btn" onClick={() => void restoreWhole(v)}>Restore</button>
        {!e2e && <button type="button" class="small-btn" title="Give this version a name (named versions are kept)" onClick={() => void rename(v)}>Name…</button>}
        {v.kind !== 'auto' && <button type="button" class="small-btn" onClick={() => void del(v)}>Delete</button>}
      </span>
    </li>
  );

  return (
    <div class="history-panel" data-history>
      <div class="hist-head">
        <b>History</b>
        <span class="hist-path" title={docPathOf(docId)}>{docPathOf(docId).split('/').pop()}</span>
        {onClose && <button type="button" class="hist-close" title="Close the history" aria-label="Close the history" onClick={onClose}>×</button>}
      </div>
      {!e2e && (
        <div class="hist-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'file'} class={tab === 'file' ? 'on' : ''} onClick={() => setTab('file')}>This file</button>
          <button type="button" role="tab" aria-selected={tab === 'project'} class={tab === 'project' ? 'on' : ''} onClick={() => setTab('project')}>Whole project</button>
        </div>
      )}
      {tab === 'file' ? <>
        <div class="hist-bar">
          <button type="button" class="small-btn" onClick={() => void nameNow()}>Name this version…</button>
          <button type="button" class="small-btn" title="Load the list again" onClick={() => void load()}>↻</button>
        </div>
        {undo && <div class="hist-undo">{undo.label} <button type="button" class="small-btn" onClick={() => void undo.run().catch(e => say('Could not undo: ' + (e as Error).message, 'error'))}>Undo</button></div>}
        {e2e && <div class="hist-note">This project is end-to-end encrypted: its versions are decrypted in this browser, so they can be compared and restored here, but not named or restored in parts.</div>}
        {failed && <div class="hist-note">The history could not be loaded. <button type="button" class="small-btn" onClick={() => void load()}>Try again</button></div>}
        {versions && !versions.length && <div class="hist-note">No versions yet. A version is kept automatically every ten minutes while someone edits, before every restore, and whenever you name one.</div>}
        <div class="hist-list">
          {days.map(d => (
            <section key={d.label} class="hist-day">
              <h4>{d.label}</h4>
              <ul>
                {d.rows.map(r => {
                  if (r.kind === 'one') return item(r.v);
                  const isOpen = open.has(r.key);
                  const first = r.list[r.list.length - 1], last = r.list[0];
                  const names = [...new Set(r.list.flatMap(v => v.author.split(',').map(s => s.trim())))].join(', ');
                  return (
                    <li key={r.key} class="hist-session">
                      <button type="button" class="hist-main" aria-expanded={isOpen} onClick={() => setOpen(s => { const n = new Set(s); if (n.has(r.key)) n.delete(r.key); else n.add(r.key); return n; })}>
                        <span class="hist-time">{clock(first.created_at)}–{clock(last.created_at)}</span>
                        <span class="hist-name"><span class="hist-caret">{isOpen ? '▾' : '▸'}</span> Editing session · {r.list.length} versions</span>
                        <Authors names={names} />
                      </button>
                      {isOpen && <ul>{r.list.map(v => item(v, true))}</ul>}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      </> : <ProjectHistory project={projectOfDoc(docId)} current={docId} onOpen={onOpen} say={say} />}
      {compare && versions && (
        <Suspense fallback={null}>
          <HistoryDiff docId={docId} versions={versions} from={compare.from} to={compare.to} e2e={e2e}
            onPick={(from, to) => setCompare({ from, to })}
            onClose={() => setCompare(null)}
            onRestoreWhole={async v => { if (await restoreWhole(v)) setCompare(null); }}
            onRestoredPart={(u) => { setUndo(u); setTick(t => t + 1); }}
            say={say} />
        </Suspense>
      )}
    </div>
  );
}

/** the project's tab: recent versions across its files, and files deleted since that can come back */
function ProjectHistory({ project, current, onOpen, say }: { project: string; current: string; onOpen?: (id: string) => void; say: Notify }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.projectHistory>> | null>(null);
  const [failed, setFailed] = useState(false);
  const load = () => api.projectHistory(project).then(d => { setData(d); setFailed(false); }).catch(() => setFailed(true));
  useEffect(() => { void load(); }, [project]);
  const deleted = data?.files.filter(f => !f.exists) ?? [];
  const exists = new Set(data?.files.filter(f => f.exists).map(f => f.doc));
  const bringBack = async (f: { doc: string; path: string }) => {
    try {
      const list = (await api.versions(f.doc)).versions;
      const v = list[0];
      if (!v) return;
      const { lyx } = await api.getVersion(f.doc, v.id);
      if (/^\s*#LyX|^\\lyxformat/m.test(lyx.slice(0, 400))) { say('This version is in an older format and cannot be restored as a file', 'error'); return; }
      if (!(await uiConfirm('Restore File', `Bring back ${f.path} as it was at ${new Date(v.created_at).toLocaleString()}?`, { okLabel: 'Restore file' }))) return;
      await api.writeText(project, f.path, lyx);
      say(`${f.path} is back`);
      void load();
      onOpen?.(f.doc);
    } catch (e) { say('Could not restore the file: ' + (e as Error).message, 'error'); }
  };
  if (failed) return <div class="hist-note">The project's history could not be loaded. <button type="button" class="small-btn" onClick={() => void load()}>Try again</button></div>;
  if (!data) return <div class="hist-note">Loading…</div>;
  return (
    <div class="hist-list hist-project">
      {deleted.length > 0 && (
        <section class="hist-day">
          <h4>Deleted files</h4>
          <ul>{deleted.map(f => (
            <li key={f.doc} class="hist-item">
              <span class="hist-main static"><span class="hist-name">{f.path}</span><span class="hist-time">last version {new Date(f.last).toLocaleString()}</span></span>
              <span class="hist-actions always"><button type="button" class="small-btn" onClick={() => void bringBack(f)}>Restore file</button></span>
            </li>
          ))}</ul>
        </section>
      )}
      <section class="hist-day">
        <h4>Recent versions in this project</h4>
        <ul>{data.recent.map(v => (
          <li key={v.id} class={'hist-item' + (v.doc === current ? ' current' : '')}>
            <button type="button" class="hist-main" disabled={!exists.has(v.doc) || !onOpen} title={exists.has(v.doc) ? 'Open this file' : 'This file was deleted'} onClick={() => onOpen?.(v.doc)}>
              <span class="hist-time">{dayLabel(v.created_at)} {clock(v.created_at)}</span>
              <span class="hist-name">{v.path}{!exists.has(v.doc) && <span class="hist-badge offline">deleted</span>}</span>
              <span class="hist-sub">{versionTitle(v)}</span>
              <Authors names={v.author} />
            </button>
          </li>
        ))}</ul>
        {!data.recent.length && <div class="hist-note">No versions in this project yet.</div>}
      </section>
    </div>
  );
}
