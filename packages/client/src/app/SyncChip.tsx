/**
 * "⇄ In sync with VS Code": says while a document is kept in step with a copy elsewhere — a synced
 * clone of its project (the VS Code extension, `overlyx sync --watch`), its Google Doc (File ▸
 * Google Docs…) or its LessWrong draft (File ▸ LessWrong…). In the status bar. A click opens what
 * each connection is doing: when it last synced, whether that failed, whether the authorisation it
 * syncs with is still there, whether a sync is under way — with the way to its settings. The server
 * knows which clones are at work (syncPeers.ts); this asks it when the document opens, every
 * SYNC_POLL_MS while the tab is visible (every two seconds while a LessWrong sync runs), and when the
 * tab comes back.
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { api, type ExternalSync, type SyncClone } from '../api';
import { ago } from './ExternalAgents';
import './syncchip.css';

const SYNC_POLL_MS = 20_000;

/** what keeps `docId` in step from elsewhere (null: nothing, or not known yet) */
export function useExternalSync(docId: string | null): ExternalSync | null {
  const [ext, setExt] = useState<ExternalSync | null>(null);
  const busy = !!ext?.lesswrong?.syncing;
  useEffect(() => {
    if (!docId) { setExt(null); return; }
    let stop = false;
    const look = () => {
      if (document.visibilityState === 'hidden') return;
      api.externalSync(docId).then(r => { if (!stop) setExt(r.clones.length || r.google || r.googleUnlinked || r.lesswrong ? r : null); }).catch(() => { /* offline: keep what was said */ });
    };
    look();
    const iv = setInterval(look, busy ? 2000 : SYNC_POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') look(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { stop = true; clearInterval(iv); document.removeEventListener('visibilitychange', onVisible); };
  }, [docId, busy]);
  useEffect(() => { setExt(null); }, [docId]);
  return ext;
}

/** "VS Code" / "Ada's VS Code" — short, for the chip */
function shortName(c: SyncClone): string {
  if (c.mine) return c.app === 'vscode' ? 'VS Code' : 'your clone';
  const first = c.name.split(/\s+/)[0] || c.username;
  return `${first}’s ${c.app === 'vscode' ? 'VS Code' : 'clone'}`;
}

/** a clone, in full */
function longName(c: SyncClone): string {
  const what = c.app === 'vscode' ? 'VS Code' : c.app === 'cli' ? 'clone (overlyx sync --watch)' : 'synced clone';
  return `${c.mine ? 'Your' : `${c.name}’s`} ${what}${c.host ? ` on ${c.host}` : ''}`;
}

const DAY = 86_400_000;
const elapsed = (since: number) => { const s = Math.max(0, Math.round((Date.now() - since) / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

export interface SyncDescription { short: string; title: string; kind: 'live' | 'google' | 'error' | 'unlinked' | 'busy' }

/** a connection's trouble, if any: what keeps it from syncing (a failed sync, an authorisation gone) */
function troubles(ext: ExternalSync): string[] {
  const out: string[] = [];
  const g = ext.google, w = ext.lesswrong;
  if (g?.lastError) out.push(`Google Docs: ${g.lastError}`);
  else if (g && !g.account) out.push('Google Docs: the Google Drive authorisation is gone');
  if (w?.lastError && !w.syncing) out.push(`LessWrong: ${w.lastError}`);
  else if (w && !w.authUntil) out.push('LessWrong: the LessWrong authorisation is gone');
  return out;
}

export function describeSync(ext: ExternalSync): SyncDescription {
  // a document of a Google Doc's group that syncs with none of its tabs (its tab's document was deleted, say)
  if (ext.googleUnlinked && !ext.google && !ext.clones.length && !ext.lesswrong) {
    return { short: 'Not synced with Google Docs', kind: 'unlinked', title: 'The other documents of this folder are tabs of a Google Doc; this one syncs with none. Click for more.' };
  }
  const parts: string[] = [];
  if (ext.clones.length === 1) parts.push(shortName(ext.clones[0]));
  else if (ext.clones.length > 1) parts.push(`${ext.clones.length} clones`);
  const g = ext.google, w = ext.lesswrong;
  if (g) parts.push('Google Docs');
  if (w) parts.push('LessWrong');
  const trouble = troubles(ext);
  if (w?.syncing) return { short: 'Syncing with LessWrong…', kind: 'busy', title: `${w.syncing.phase} — click for more` };
  if (trouble.length && !ext.clones.length) {
    return { short: `${trouble[0].split(':')[0]} sync failed`, kind: 'error', title: trouble.join('\n') + '\nClick for more.' };
  }
  const linkedOnly = !ext.clones.length && (g || w) && !(g?.auto || w?.auto);
  return {
    short: (linkedOnly ? 'Linked to ' : 'In sync with ') + parts.join(' + '),
    kind: trouble.length ? 'error' : ext.clones.length ? 'live' : 'google',
    title: 'This document is kept in step with a copy elsewhere. Click for each connection’s state.',
  };
}

type Open = (what: 'gdocs' | 'lesswrong' | 'git') => void;

/** one line of a connection's state: fine, a problem, or under way */
const Line = ({ kind, children }: { kind: 'ok' | 'warn' | 'busy' | 'info'; children: ComponentChildren }) => (
  <div class={'sync-line ' + kind}><span class="sync-mark" aria-hidden="true">{kind === 'ok' ? '✓' : kind === 'warn' ? '⚠' : kind === 'busy' ? '⟳' : '·'}</span><span>{children}</span></div>
);

/** each connection: what it does, whether it works, its settings */
function SyncPanel({ ext, onOpen, close }: { ext: ExternalSync; onOpen?: Open; close: () => void }) {
  const g = ext.google, w = ext.lesswrong;
  const open = (what: 'gdocs' | 'lesswrong' | 'git') => { close(); onOpen?.(what); };
  const whose = (mine: boolean) => (mine ? 'your account' : 'the account that linked it');
  return (
    <div class="sync-panel" role="dialog" aria-label="Kept in step with" data-sync-panel>
      {g && (
        <section data-sync-google>
          <header><b>Google Docs</b><a href={g.url} target="_blank" rel="noopener">Open ↗</a></header>
          {g.lastError ? <Line kind="warn">Last sync failed: {g.lastError}</Line>
            : <Line kind="ok">{g.lastSync ? `Synced ${ago(g.lastSync)}` : 'Not synced yet'}{g.auto ? ' · automatically, every minute' : ' · only when you ask'}</Line>}
          {g.account ? <Line kind="ok">Google Drive authorisation of {whose(g.mine)}: works</Line>
            : <Line kind="warn">The Google Drive authorisation of {whose(g.mine)} is gone (Google expires or revokes it){g.mine ? ': connect again in the settings' : ': they have to connect again'}</Line>}
          <div class="sync-actions"><button onClick={() => open('gdocs')}>Google Docs settings…</button></div>
        </section>
      )}
      {!g && ext.googleUnlinked && (
        <section>
          <header><b>Google Docs</b></header>
          <Line kind="warn">The other documents of this folder are tabs of a Google Doc; this one syncs with none of them</Line>
          <div class="sync-actions"><button onClick={() => open('gdocs')}>Sync it with a tab…</button></div>
        </section>
      )}
      {w && (
        <section data-sync-lesswrong>
          <header><b>LessWrong{w.title ? ` · “${w.title}”` : ''}</b><a href={w.url} target="_blank" rel="noopener">Open ↗</a></header>
          {w.syncing ? <Line kind="busy">{w.syncing.phase}{w.syncing.edits ? ` · ${w.syncing.edits} edit${w.syncing.edits === 1 ? '' : 's'} sent` : ''} · {elapsed(w.syncing.since)}</Line>
            : w.lastError ? <Line kind="warn">Last sync failed: {w.lastError}</Line>
            : <Line kind="ok">{w.lastSync ? `Synced ${ago(w.lastSync)}` : 'Not synced yet'}{w.auto ? ' · automatically (a minute after an edit here; LessWrong checked every few minutes)' : ' · only when you ask'}</Line>}
          {!w.authUntil ? <Line kind="warn">The LessWrong authorisation of {whose(w.mine)} is gone or expired{w.mine ? ': connect again in the settings' : ': they have to connect again'}</Line>
            : w.authUntil - Date.now() < 14 * DAY ? <Line kind="warn">The LessWrong authorisation of {whose(w.mine)} expires in {Math.max(0, Math.round((w.authUntil - Date.now()) / DAY))} days — connect again in the settings</Line>
            : <Line kind="ok">LessWrong authorisation of {whose(w.mine)}: works until {new Date(w.authUntil).toLocaleDateString()}</Line>}
          <Line kind="info">{w.comments ? 'Comment threads sync both ways' : 'Comments written here go to LessWrong; theirs come back only with the draft’s link-sharing address (settings)'}</Line>
          <div class="sync-actions"><button onClick={() => open('lesswrong')}>LessWrong settings…</button></div>
        </section>
      )}
      {ext.clones.length > 0 && (
        <section data-sync-clones>
          <header><b>Synced clones</b></header>
          {ext.clones.map(c => <Line key={c.username + c.app + (c.host ?? '')} kind="ok">{longName(c)} — {Date.now() - c.lastSeen < 5000 ? 'connected now' : `seen ${ago(c.lastSeen)}`}: files saved there arrive here, edits here reach it within seconds</Line>)}
          <div class="sync-actions"><button onClick={() => open('git')}>Git repository…</button></div>
        </section>
      )}
    </div>
  );
}

/** the chip, and the panel it opens; `onOpen` opens File ▸ Google Docs… ('gdocs'), File ▸ LessWrong… ('lesswrong') or the Git repository dialog ('git') */
export function SyncChip({ ext, onOpen }: { ext: ExternalSync | null; onOpen?: Open }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', key, true); };
  }, [open]);
  if (!ext) return null;
  const d = describeSync(ext);
  return (
    <span class="sync-chip-box" ref={box}>
      <button type="button" class={'sync-chip ' + d.kind} data-sync-chip={d.kind} title={d.title} aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <span class="sync-glyph" aria-hidden="true">{d.kind === 'error' || d.kind === 'unlinked' ? '⚠' : d.kind === 'busy' ? '⟳' : '⇄'}</span>{d.short}
      </button>
      {open && <SyncPanel ext={ext} onOpen={onOpen} close={() => setOpen(false)} />}
    </span>
  );
}
