/**
 * "⇄ In sync with VS Code": says while a document is kept in step with a copy elsewhere — a synced
 * clone of its project (the VS Code extension, `overlyx sync --watch`) or its Google Doc (File ▸
 * Google Docs…). In the status bar, and beside the save state under the title in the Modern
 * interface. The server knows which clones are at work (syncPeers.ts); this asks it when the
 * document opens, every SYNC_POLL_MS while the tab is visible, and when the tab comes back.
 */
import { useEffect, useState } from 'preact/hooks';
import { api, type ExternalSync, type SyncClone } from '../api';
import { ago } from './ExternalAgents';

const SYNC_POLL_MS = 20_000;

/** what keeps `docId` in step from elsewhere (null: nothing, or not known yet) */
export function useExternalSync(docId: string | null): ExternalSync | null {
  const [ext, setExt] = useState<ExternalSync | null>(null);
  useEffect(() => {
    setExt(null);
    if (!docId) return;
    let stop = false;
    const look = () => {
      if (document.visibilityState === 'hidden') return;
      api.externalSync(docId).then(r => { if (!stop) setExt(r.clones.length || r.google || r.googleUnlinked ? r : null); }).catch(() => { /* offline: keep what was said */ });
    };
    look();
    const iv = setInterval(look, SYNC_POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') look(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { stop = true; clearInterval(iv); document.removeEventListener('visibilitychange', onVisible); };
  }, [docId]);
  return ext;
}

/** "VS Code" / "Ada's VS Code" — short, for the chip */
function shortName(c: SyncClone): string {
  if (c.mine) return c.app === 'vscode' ? 'VS Code' : 'your clone';
  const first = c.name.split(/\s+/)[0] || c.username;
  return `${first}’s ${c.app === 'vscode' ? 'VS Code' : 'clone'}`;
}

/** one line of the tooltip */
function longName(c: SyncClone): string {
  const what = c.app === 'vscode' ? 'VS Code' : c.app === 'cli' ? 'clone (overlyx sync --watch)' : 'synced clone';
  return `${c.mine ? 'Your' : `${c.name}’s`} ${what}${c.host ? ` on ${c.host}` : ''}`;
}

export interface SyncDescription { short: string; title: string; kind: 'live' | 'google' | 'error' | 'unlinked' }

export function describeSync(ext: ExternalSync): SyncDescription {
  // a document of a Google Doc's group that syncs with none of its tabs (its tab's document was deleted, say)
  if (ext.googleUnlinked && !ext.google && !ext.clones.length) {
    return { short: 'Not synced with Google Docs', kind: 'unlinked', title: 'The other documents of this folder are tabs of a Google Doc; this one syncs with none. Click to sync it with one of its tabs (File ▸ Google Docs…).' };
  }
  const parts: string[] = [];
  const lines: string[] = [];
  if (ext.clones.length === 1) parts.push(shortName(ext.clones[0]));
  else if (ext.clones.length > 1) parts.push(`${ext.clones.length} clones`);
  for (const c of ext.clones) lines.push(`• ${longName(c)} — files saved there arrive here, and edits here reach it within seconds.`);
  const g = ext.google;
  if (g) {
    parts.push('Google Docs');
    lines.push(g.lastError
      ? `• Google Docs — the last sync failed: ${g.lastError}`
      : `• Google Docs — ${g.auto ? 'synced every minute' : 'synced when you ask (File ▸ Google Docs…)'}${g.lastSync ? `, last ${ago(g.lastSync)}` : ''}.`);
  }
  const short = (g && !g.auto && !ext.clones.length ? 'Linked to ' : 'In sync with ') + parts.join(' + ');
  const kind = g?.lastError ? 'error' : ext.clones.length ? 'live' : 'google';
  return {
    short: kind === 'error' && !ext.clones.length ? 'Google Docs sync failed' : short,
    kind,
    title: `This document is kept in step with a copy elsewhere:\n${lines.join('\n')}\n${g ? 'Click for the Google Docs link.' : 'Click for the clone address and history (Git repository).'}`,
  };
}

/** the chip; `onOpen(google)` opens File ▸ Google Docs… (google) or the Git repository dialog */
export function SyncChip({ ext, onOpen }: { ext: ExternalSync | null; onOpen?: (google: boolean) => void }) {
  if (!ext) return null;
  const d = describeSync(ext);
  return (
    <button type="button" class={'sync-chip ' + d.kind} data-sync-chip={d.kind} title={d.title} onClick={() => onOpen?.(!!ext.google || !!ext.googleUnlinked)}>
      <span class="sync-glyph" aria-hidden="true">{d.kind === 'error' || d.kind === 'unlinked' ? '⚠' : '⇄'}</span>{d.short}
    </button>
  );
}
